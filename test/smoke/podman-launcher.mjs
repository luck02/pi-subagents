// Podman launcher smoke: a real pi parent launches one background child through a
// podman launcher, the driver kills part of it, and the run artifacts plus the parent's
// notifications show what the parent learned and when.
//
// Usage: node test/smoke/podman-launcher.mjs <image> <pi-subagents entry> <out dir> [variant ...]
//   <image>              runner image with a POSIX shell (node comes from the host mount)
//   <pi-subagents entry> index.ts of a checkout or index.js of an installed package
//   variants             any of: legacy, host-pid (default: both)
// Each case uses a faux provider, so no model is called.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [image, entryArg, outArg, ...variantArgs] = process.argv.slice(2);
assert.ok(image && entryArg && outArg, "usage: podman-launcher.mjs <image> <pi-subagents entry> <out dir> [variant ...]");
const entry = path.resolve(entryArg);
const out = path.resolve(outArg);
assert.ok(fs.existsSync(entry), `missing ${entry}`);
const variants = variantArgs.length ? variantArgs : ["legacy", "host-pid"];
const cases = (process.env.SMOKE_CASES ?? "finish,runner-kill,client-kill,container-kill").split(",");
const piCli = fs.realpathSync(spawnSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).stdout.trim());
const piRoot = piCli.slice(0, piCli.lastIndexOf("/dist/"));
const nodeRoot = path.dirname(path.dirname(process.execPath));
const subagentsRoot = path.dirname(entry);
const packagesRoot = path.dirname(subagentsRoot);
const providerSource = new URL("./podman-launcher/provider.ts", import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; } };
const readLines = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
async function waitFor(label, predicate, timeoutMs) {
	for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(200)) {
		const value = predicate();
		if (value) return value;
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const containerRunning = (name) => spawnSync("podman", ["ps", "--filter", `name=^${name}$`, "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.trim() === name;
function podmanClientPid(name) {
	for (const pid of fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
		try {
			const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
			if (path.basename(argv[0]) === "podman" && argv[1] === "run" && argv.includes(name)) return Number(pid);
		} catch {}
	}
	return undefined;
}

function launcherArgv(variant, name, stage) {
	const mount = (dir, mode) => ["-v", `${dir}:${dir}:${mode},z`];
	const common = ["podman", "run", "--rm", "--name", name, "--memory=2g", "--userns=keep-id", "-w", path.join(stage, "work"),
		...mount(stage, "rw"), ...mount(nodeRoot, "ro"), ...mount(piRoot, "ro"), ...mount(packagesRoot, "ro")];
	// legacy: the shape of the podman8g launcher on 2026-10-15 (own pid namespace, no env passthrough).
	if (variant === "legacy") return [...common, "-e", `HOME=${path.join(stage, "home")}`, "-e", `SMOKE_STAGE=${stage}`, "-e", `PI_CODING_AGENT_DIR=${path.join(stage, "agent")}`, "-e", `PI_SUBAGENTS_TEMP_ROOT=${path.join(stage, "tmproot")}`, image];
	// host-pid: share the host pid namespace and hostname, and pass the runner env through as docs/agents.md requires.
	if (variant === "host-pid") return [...common, "--pid=host", "--uts=host", "-e", "PI_*", "-e", "JITI_ALIAS", "-e", "HOME", "-e", "PATH", "-e", "TMPDIR", "-e", "SMOKE_STAGE", image];
	throw new Error(`unknown variant ${variant}`);
}

function writeStage(stage, variant, name) {
	for (const dir of ["agent/extensions/subagent", "home", "tmproot", "work/.pi/agents"]) fs.mkdirSync(path.join(stage, dir), { recursive: true });
	fs.copyFileSync(providerSource, path.join(stage, "provider.ts"));
	fs.writeFileSync(path.join(stage, "agent/settings.json"), JSON.stringify({ defaultProvider: "podman-smoke", defaultModel: "local", packages: [] }));
	fs.writeFileSync(path.join(stage, "agent/extensions/subagent/config.json"), JSON.stringify({ maxActiveAsyncRunsPerSession: 5, runnerLaunchers: { smoke: launcherArgv(variant, name, stage) } }, null, 2));
	fs.writeFileSync(path.join(stage, "work/.pi/agents/podman-smoke.md"), `---\nname: podman-smoke\ndescription: Podman launcher smoke child\nmodel: podman-smoke/local\nlauncher: smoke\ntools:\nextensions:\n  - ${path.join(stage, "provider.ts")}\n---\nReturn the scripted response.\n`);
	fs.writeFileSync(path.join(stage, "parent.ts"), `import fs from "node:fs";
import registerSubagents from ${JSON.stringify(entry)};
const stage = ${JSON.stringify(stage)};
const log = (event: object) => fs.appendFileSync(stage + "/parent.jsonl", JSON.stringify({ ts: Date.now(), ...event }) + "\\n");
export default function registerSmokeParent(pi: any) {
	let tool: any;
	const host = new Proxy(pi, { get(target, key) {
		if (key === "registerTool") return (definition: any) => { target.registerTool(definition); if (definition.name === "subagent") tool = definition; };
		if (key === "sendMessage") return (message: any, options: any) => {
			log({ event: "sendMessage", customType: message.customType, triggerTurn: options?.triggerTurn, content: typeof message.content === "string" ? message.content.slice(0, 2000) : message.content });
			target.sendMessage(message, { ...options, triggerTurn: false });
		};
		// Never let the parent take a model turn.
		if (key === "sendUserMessage") return (content: unknown) => log({ event: "sendUserMessage", content: String(content).slice(0, 2000) });
		return Reflect.get(target, key);
	} });
	registerSubagents(host);
	pi.on("session_start", async (_event: unknown, ctx: any) => {
		// Extension providers register after session_start handlers are queued; let them land first.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const launch = await tool.execute("podman-smoke", { agent: "podman-smoke", task: "Return the scripted response.", async: true, model: "podman-smoke/local", output: false, options: { context: "fresh", acceptance: false, timeoutMs: 180000 } }, new AbortController().signal, undefined, ctx);
		fs.writeFileSync(stage + "/launch.json", JSON.stringify({ isError: launch.isError, text: launch.content?.[0]?.text, details: { asyncId: launch.details?.asyncId, asyncDir: launch.details?.asyncDir } }, null, 2));
		const timer = setInterval(() => { if (fs.existsSync(stage + "/parent-exit")) { clearInterval(timer); process.exit(0); } }, 200);
	});
}
`);
}

function slotDirs(stage) {
	const root = path.join(stage, "tmproot/session-active-async-capacity");
	if (!fs.existsSync(root)) return [];
	return fs.readdirSync(root).flatMap((session) => fs.readdirSync(path.join(root, session)).filter((slot) => slot.startsWith("slot-")).map((slot) => `${session.slice(0, 8)}/${slot}`));
}

async function runCase(variant, kase) {
	const name = `pi-smoke-${variant}-${kase}`;
	const stage = path.join(out, `${variant}-${kase}`);
	fs.rmSync(stage, { recursive: true, force: true });
	spawnSync("podman", ["rm", "-f", "-t", "0", name], { stdio: "ignore" });
	writeStage(stage, variant, name);
	const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(stage, "agent"), PI_SUBAGENTS_TEMP_ROOT: path.join(stage, "tmproot"), PI_OFFLINE: "1", SMOKE_STAGE: stage };
	const parent = spawn(process.execPath, [piCli, "--mode", "rpc", "--no-session", "--no-skills", "--no-prompt-templates", "--no-extensions", "--extension", path.join(stage, "provider.ts"), "--extension", path.join(stage, "parent.ts")], { cwd: path.join(stage, "work"), env, stdio: ["pipe", fs.openSync(path.join(stage, "parent.out"), "w"), fs.openSync(path.join(stage, "parent.err"), "w")] });
	const t0 = Date.now();
	const at = () => Date.now() - t0;
	const timeline = [];
	const note = (event, extra = {}) => timeline.push({ atMs: at(), event, ...extra });
	const report = { variant, case: kase, timeline };
	try {
		const launch = await waitFor("launch.json", () => readJson(path.join(stage, "launch.json")), 30_000);
		note("launched", { isError: launch.isError ?? false });
		if (launch.isError) { report.launchError = launch.text; return report; }
		const asyncDir = launch.details.asyncDir;
		const statusPath = path.join(asyncDir, "status.json");
		const request = await waitFor("child request", () => readLines(path.join(stage, "lifecycle.jsonl")).find((line) => line.event === "request"), 30_000).catch((error) => { note("no-child-request", { error: error.message }); return undefined; });
		if (!request) {
			report.status = readJson(statusPath);
			report.stderrTail = fs.existsSync(path.join(asyncDir, "runner.stderr.log")) ? fs.readFileSync(path.join(asyncDir, "runner.stderr.log"), "utf8").split("\n").slice(-6) : [];
			return report;
		}
		const status0 = readJson(statusPath);
		report.child = { ...request, statusPid: status0?.pid, statusPidNamespaceScope: status0?.pidNamespaceScope, hostPidNamespace: fs.readlinkSync("/proc/self/ns/pid") };
		note("child-in-request", { slots: slotDirs(stage) });
		const clientPid = podmanClientPid(name);
		if (kase === "finish") fs.writeFileSync(path.join(stage, "release"), "go");
		if (kase === "runner-kill") {
			// The runner's own pid as the host sees it; in the legacy variant the recorded pid is 1 in the container namespace.
			const hostPid = report.child.statusPidNamespaceScope === report.child.hostPidNamespace ? status0.pid : undefined;
			if (hostPid) process.kill(hostPid, "SIGKILL");
			else spawnSync("podman", ["exec", name, "kill", "-9", "1"]);
			note("runner-killed", { via: hostPid ? `host pid ${hostPid}` : "podman exec kill -9 1" });
		}
		if (kase === "client-kill") { process.kill(clientPid, "SIGKILL"); note("client-killed", { clientPid }); }
		if (kase === "container-kill") { spawnSync("podman", ["kill", name]); note("container-killed"); }
		const deadline = Date.now() + 45_000;
		let released = false;
		let last = {};
		while (Date.now() < deadline) {
			const status = readJson(statusPath);
			const proof = readJson(path.join(asyncDir, "process-terminal.json"));
			const notices = readLines(path.join(stage, "parent.jsonl")).filter((line) => line.event === "sendMessage");
			const now = { state: status?.state, proof: proof?.state, notices: notices.length, slots: slotDirs(stage).length, container: containerRunning(name), runnerAlive: report.child.statusPidNamespaceScope === report.child.hostPidNamespace ? alive(status0.pid) : undefined };
			if (JSON.stringify(now) !== JSON.stringify(last)) { note("observed", now); last = now; }
			// After a client kill the runner should keep going; release it once that is established.
			if (kase === "client-kill" && !released && at() > 10_000) { fs.writeFileSync(path.join(stage, "release"), "go"); released = true; note("released"); }
			const settled = now.state && !["running", "queued"].includes(now.state) && now.notices > 0 && now.slots === 0 && !now.container;
			if (settled && (kase !== "client-kill" || released)) break;
			await sleep(250);
		}
		report.final = last;
		report.notices = readLines(path.join(stage, "parent.jsonl")).filter((line) => line.event === "sendMessage").map((line) => ({ atMs: line.ts - t0, customType: line.customType, triggerTurn: line.triggerTurn, head: String(line.content).split("\n").slice(0, 3).join(" | ").slice(0, 300) }));
		report.launcherClose = readJson(path.join(asyncDir, "launcher-close.json"));
		return report;
	} finally {
		fs.writeFileSync(path.join(stage, "parent-exit"), "1");
		await Promise.race([new Promise((resolve) => parent.once("exit", resolve)), sleep(5000)]);
		if (parent.exitCode === null) parent.kill("SIGKILL");
		spawnSync("podman", ["rm", "-f", "-t", "0", name], { stdio: "ignore" });
	}
}

const reports = [];
for (const variant of variants) for (const kase of cases) {
	const report = await runCase(variant, kase).catch((error) => ({ variant, case: kase, error: error.message }));
	reports.push(report);
	console.log(JSON.stringify({ variant: report.variant, case: report.case, final: report.final, notices: report.notices?.length, error: report.error ?? report.launchError }));
}
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(reports, null, 2));
console.log(`report: ${path.join(out, "report.json")}`);
