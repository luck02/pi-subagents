import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { acquireActiveAsyncCapacity, getActiveAsyncCapacitySnapshot, inspectActiveAsyncCapacityOwner } from "../../src/runs/background/active-async-capacity.ts";
import { probeRunnerContainer, removeRunnerContainer, resetRunnerContainerProbeCache } from "../../src/runs/background/container-runner.ts";
import { finalizeProcessTerminal, initializeProcessTerminal } from "../../src/runs/background/process-terminal.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import { bindRunnerLauncherToRun, lookupRunnerLauncher } from "../../src/runs/shared/runner-launcher.ts";
import type { RunnerLauncherContainer } from "../../src/shared/types.ts";

const gone = ["sh", "-c", "exit 1"];
const present = ["true"];

function tempRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value));
}

function container(name: string, probe: string[]): RunnerLauncherContainer {
	return { name, stop: ["true"], probe };
}

/** A container runner reports pid 1 in its own namespace, which the observer does not share. */
function runningContainerStatus(runId: string, probe: string[], extra: Record<string, unknown> = {}) {
	return {
		lifecycleArtifactVersion: 3,
		runId,
		sessionId: "session-c",
		mode: "single",
		state: "running",
		pid: 1,
		pidNamespaceScope: "pid:[container]",
		startedAt: 1000,
		lastUpdate: 1000,
		currentStep: 0,
		launcher: { name: "podman", argv: ["podman", "run", "--name", `pi-${runId}`], container: container(`pi-${runId}`, probe) },
		processTerminal: { version: 1, state: "pending", runId, runnerProcessInstanceId: `runner-${runId}` },
		steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
		...extra,
	};
}

afterEach(() => resetRunnerContainerProbeCache());

describe("container runner launchers", () => {
	it("binds {runId} and {name} for container launchers and leaves plain launchers untouched", () => {
		const launchers = {
			plain: ["nono", "run", "{runId}"],
			box: { argv: ["podman", "run", "--name", "{name}", "img"], container: { name: "pi-{runId}", stop: ["podman", "rm", "-f", "{name}"], probe: ["podman", "container", "exists", "{name}"] } },
		};
		const plain = lookupRunnerLauncher(launchers, "plain")!;
		assert.deepEqual(bindRunnerLauncherToRun(plain, "r1"), { name: "plain", argv: ["nono", "run", "{runId}"] });
		const box = bindRunnerLauncherToRun(lookupRunnerLauncher(launchers, "box")!, "r1");
		assert.deepEqual(box, {
			name: "box",
			argv: ["podman", "run", "--name", "pi-r1", "img"],
			container: { name: "pi-r1", stop: ["podman", "rm", "-f", "pi-r1"], probe: ["podman", "container", "exists", "pi-r1"] },
		});
		assert.deepEqual(launchers.box.argv, ["podman", "run", "--name", "{name}", "img"], "binding must not mutate the configured entry");
	});

	it("reads container removal from the probe, not from the stop command's exit", async () => {
		assert.equal((await removeRunnerContainer(container("a", gone))).removed, true);
		assert.equal((await removeRunnerContainer({ name: "b", stop: ["sh", "-c", "exit 3"], probe: gone })).removed, true, "an already-removed container makes stop fail but the probe confirms it is gone");
		const stillThere = await removeRunnerContainer({ name: "c", stop: ["sh", "-c", "echo busy >&2; exit 125"], probe: present });
		assert.equal(stillThere.removed, false);
		assert.equal(stillThere.stop.exitCode, 125);
		assert.equal(stillThere.stop.stderrTail, "busy");
		assert.equal((await removeRunnerContainer({ name: "d", stop: ["true"], probe: ["sh", "-c", "exit 125"] })).removed, false, "a probe error is not proof of removal");
	});

	it("probes at most every 30 seconds and remembers a gone container", () => {
		const root = tempRoot("pi-container-probe-");
		try {
			const flag = path.join(root, "exists");
			fs.writeFileSync(flag, "");
			const probe = container("p", ["sh", "-c", `test -e ${JSON.stringify(flag)}`]);
			assert.equal(probeRunnerContainer(probe, 0), "present");
			fs.rmSync(flag);
			assert.equal(probeRunnerContainer(probe, 10_000), "present", "cached within the interval");
			assert.equal(probeRunnerContainer(probe, 40_000), "gone");
			fs.writeFileSync(flag, "");
			assert.equal(probeRunnerContainer(probe, 100_000), "gone", "a removed container does not come back");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes an observed proof when the runner's container was removed, even with unverified writers", () => {
		const root = tempRoot("pi-container-proof-");
		try {
			for (const [runId, removedContainer, expected] of [["kept", undefined, "unknown"], ["removed", "pi-removed", "observed"]] as const) {
				const asyncDir = path.join(root, runId);
				writeJson(path.join(asyncDir, "status.json"), runningContainerStatus(runId, gone));
				initializeProcessTerminal(asyncDir, runId, `runner-${runId}`);
				const proof = finalizeProcessTerminal(asyncDir, runId, { processInstanceId: `runner-${runId}`, closeObservedAt: 1500, exitCode: 137, signal: null }, removedContainer ? { removedContainer } : undefined);
				assert.equal(proof.state, expected, runId);
				if (proof.state === "observed") assert.equal(proof.removedContainer, "pi-removed");
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails a container run at once from a recorded runner exit, in any pid namespace", () => {
		const root = tempRoot("pi-container-exit-");
		try {
			const asyncDir = path.join(root, "run-exit");
			const resultsDir = path.join(root, "results");
			writeJson(path.join(asyncDir, "status.json"), runningContainerStatus("run-exit", present));
			initializeProcessTerminal(asyncDir, "run-exit", "runner-run-exit");
			finalizeProcessTerminal(asyncDir, "run-exit", { processInstanceId: "runner-run-exit", closeObservedAt: 1500, exitCode: 137, signal: null }, { removedContainer: "pi-run-exit" });
			const result = reconcileAsyncRun(asyncDir, { resultsDir, pidNamespaceScope: () => "pid:[host]", now: () => 2000 });
			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /Async runner in container pi-run-exit exited with code 137 before writing a result/);
			assert.equal(JSON.parse(fs.readFileSync(path.join(resultsDir, "run-exit.json"), "utf-8")).state, "failed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails a container run found gone by an observer that never saw its launcher exit", () => {
		const root = tempRoot("pi-container-gone-");
		try {
			const asyncDir = path.join(root, "run-gone");
			writeJson(path.join(asyncDir, "status.json"), runningContainerStatus("run-gone", gone));
			const result = reconcileAsyncRun(asyncDir, { resultsDir: path.join(root, "results"), pidNamespaceScope: () => "pid:[host]", now: () => 2000 });
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /Async runner container pi-run-gone is gone and its runner never wrote a result/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a container run whose container still exists until its status goes stale", () => {
		const root = tempRoot("pi-container-present-");
		try {
			const asyncDir = path.join(root, "run-present");
			writeJson(path.join(asyncDir, "status.json"), runningContainerStatus("run-present", present));
			const options = { resultsDir: path.join(root, "results"), pidNamespaceScope: () => "pid:[host]", kill: () => true, staleAlivePidMs: 5000 };
			assert.equal(reconcileAsyncRun(asyncDir, { ...options, now: () => 2000 }).repaired, false);
			const stale = reconcileAsyncRun(asyncDir, { ...options, now: () => 7000 });
			assert.equal(stale.status?.state, "failed");
			assert.match(stale.message ?? "", /status has not updated for 6000ms/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("releases an abandoned container run's slot only when the container is gone", () => {
		for (const [index, [presence, releases]] of ([["gone", true], ["present", false], ["unknown", false]] as const).entries()) {
			const rootDir = tempRoot("pi-container-capacity-");
			const runId = `run-${index}`;
			const asyncDir = path.join(rootDir, "runs", runId);
			try {
				const handle = acquireActiveAsyncCapacity({ sessionId: "session-c", limit: 1, runId, kind: "runner", asyncDir }, { rootDir });
				assert.ok(handle);
				handle.markStarted(`runner-${runId}`);
				writeJson(path.join(asyncDir, "status.json"), runningContainerStatus(runId, gone, {
					state: "failed",
					lastActivityAt: 0,
					processTerminal: { version: 1, state: "unknown", runId, runnerProcessInstanceId: `runner-${runId}`, reason: "stale-repair" },
				}));
				// The pid probe would say dead; only the container answer may decide.
				const options = { rootDir, now: () => 10_000, abandonedSlotReleaseAfterMs: 1_000, pidLiveness: () => "dead" as const, containerPresence: () => presence };
				const inspection = inspectActiveAsyncCapacityOwner({ runId, sessionId: "session-c", asyncDir }, options);
				assert.equal(inspection.release.state, releases ? "releasable" : "retained", presence);
				if (!releases) assert.match(inspection.release.reason, new RegExp(`container pi-${runId} is ${presence}`));
				assert.deepEqual(getActiveAsyncCapacitySnapshot("session-c", 1, options), { used: releases ? 0 : 1, limit: 1 });
			} finally {
				fs.rmSync(rootDir, { recursive: true, force: true });
			}
		}
	});
});
