import { spawn, spawnSync } from "node:child_process";
import type { RunnerLauncherContainer } from "../../shared/types.ts";

/** Exit status of one container lifecycle command, kept in launcher-close.json as evidence. */
export interface ContainerCommandResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	stderrTail?: string;
}

export interface ContainerRemoval {
	removed: boolean;
	stop: ContainerCommandResult;
	probe?: ContainerCommandResult;
}

export type ContainerPresence = "present" | "gone" | "unknown";

const COMMAND_TIMEOUT_MS = 30_000;
const PROBE_SYNC_TIMEOUT_MS = 5_000;
const PROBE_MIN_INTERVAL_MS = 30_000;
const STDERR_TAIL_BYTES = 2_000;

function runCommand(argv: string[], timeoutMs: number): Promise<ContainerCommandResult> {
	return new Promise((resolve) => {
		let stderr = "";
		let timedOut = false;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
		} catch (error) {
			resolve({ exitCode: null, signal: null, timedOut: false, stderrTail: error instanceof Error ? error.message : String(error) });
			return;
		}
		child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES); });
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
		child.once("error", (error) => { stderr = (stderr + error.message).slice(-STDERR_TAIL_BYTES); });
		child.once("close", (exitCode, signal) => {
			clearTimeout(timer);
			resolve({ exitCode, signal, timedOut, ...(stderr.trim() ? { stderrTail: stderr.trim() } : {}) });
		});
	});
}

function presence(result: Pick<ContainerCommandResult, "exitCode" | "timedOut">): ContainerPresence {
	if (result.timedOut) return "unknown";
	return result.exitCode === 0 ? "present" : result.exitCode === 1 ? "gone" : "unknown";
}

/**
 * Removes a run's container after its launcher exited. A killed `podman run` client leaves the
 * container running under its monitor, so the launcher's exit alone does not end the runner;
 * the runner counts as gone only when the probe confirms the container no longer exists.
 */
export async function removeRunnerContainer(container: RunnerLauncherContainer): Promise<ContainerRemoval> {
	const stop = await runCommand(container.stop, COMMAND_TIMEOUT_MS);
	const probe = await runCommand(container.probe, COMMAND_TIMEOUT_MS);
	return { removed: presence(probe) === "gone", stop, probe };
}

const probeCache = new Map<string, { at: number; presence: ContainerPresence }>();

/**
 * Whether a run's container still exists, for observers that did not see its launcher exit
 * (a parent restarted after the container died). Runs on the status poll, so each container
 * is probed at most once per 30 seconds; a container found gone stays gone.
 */
export function probeRunnerContainer(container: RunnerLauncherContainer, now = Date.now()): ContainerPresence {
	const cached = probeCache.get(container.name);
	if (cached && (cached.presence === "gone" || now - cached.at < PROBE_MIN_INTERVAL_MS)) return cached.presence;
	const result = spawnSync(container.probe[0]!, container.probe.slice(1), { stdio: "ignore", timeout: PROBE_SYNC_TIMEOUT_MS });
	const found = result.error ? "unknown" : presence({ exitCode: result.status, timedOut: result.signal === "SIGTERM" && result.status === null });
	probeCache.set(container.name, { at: now, presence: found });
	return found;
}

/** Test seam: forget cached probe results. */
export function resetRunnerContainerProbeCache(): void {
	probeCache.clear();
}
