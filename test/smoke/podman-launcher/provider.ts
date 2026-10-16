// Faux provider for the podman launcher smoke: the child's first request waits for
// <stage>/release, so the driver can act on a runner that is mid-request.
import fs from "node:fs";
import path from "node:path";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const stage = process.env.SMOKE_STAGE!;

function waitForRelease(signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const release = path.join(stage, "release");
		const timer = setInterval(() => { if (fs.existsSync(release)) finish(); }, 100);
		const finish = () => { clearInterval(timer); signal?.removeEventListener("abort", finish); resolve(); };
		signal?.addEventListener("abort", finish, { once: true });
		if (signal?.aborted || fs.existsSync(release)) finish();
	});
}

function packageVersion(dir: string | undefined): string | undefined {
	if (!dir) return undefined;
	try { return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version; } catch { return undefined; }
}

export default function registerPodmanSmokeProvider(pi: ExtensionAPI) {
	const faux = fauxProvider({ provider: "podman-smoke", models: [{ id: "local" }], tokensPerSecond: 100000 });
	faux.setResponses([
		async (_context, options) => {
			fs.appendFileSync(path.join(stage, "lifecycle.jsonl"), JSON.stringify({
				event: "request",
				pid: process.pid,
				pidNamespace: fs.readlinkSync("/proc/self/ns/pid"),
				piPackageDir: process.env.PI_PACKAGE_DIR,
				piPackageVersion: packageVersion(process.env.PI_PACKAGE_DIR),
				jitiAlias: process.env.JITI_ALIAS !== undefined,
			}) + "\n");
			await waitForRelease(options?.signal);
			return fauxAssistantMessage("podman smoke child finished");
		},
	]);
	pi.registerProvider(faux.provider);
}
