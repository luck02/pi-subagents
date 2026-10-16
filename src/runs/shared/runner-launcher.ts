import type { AgentConfig } from "../../agents/agents.ts";
import type { RunnerLauncher, RunnerLauncherConfig } from "../../shared/types.ts";

/** Own-property lookup, so an inherited object key can never select a command. */
export function lookupRunnerLauncher(runnerLaunchers: Record<string, RunnerLauncherConfig> | undefined, name: string): RunnerLauncher | undefined {
	const entry = runnerLaunchers && Object.hasOwn(runnerLaunchers, name) ? runnerLaunchers[name] : undefined;
	if (!entry) return undefined;
	if (Array.isArray(entry)) return { name, argv: [...entry] };
	const container = entry.container;
	return { name, argv: [...entry.argv], ...(container ? { container: { name: container.name, stop: [...container.stop], probe: [...container.probe] } } : {}) };
}

/** Binds a container launcher's `{runId}` and `{name}` placeholders to one run; a plain launcher is returned as is. */
export function bindRunnerLauncherToRun(launcher: RunnerLauncher, runId: string): RunnerLauncher {
	if (!launcher.container) return launcher;
	const name = launcher.container.name.replaceAll("{runId}", runId);
	const bind = (arg: string) => arg.replaceAll("{runId}", runId).replaceAll("{name}", name);
	return { name: launcher.name, argv: launcher.argv.map(bind), container: { name, stop: launcher.container.stop.map(bind), probe: launcher.container.probe.map(bind) } };
}

/** A launcher wraps the local Pi background runner, so it cannot combine with machine placement or an external runner. */
export function runnerLauncherPlacementError(agent: Pick<AgentConfig, "name" | "launcher" | "runner">, machine: string | undefined): string | undefined {
	if (agent.launcher === undefined) return undefined;
	const runnerType = agent.runner?.type === "external-cli" || agent.runner?.type === "external-job" ? agent.runner.type : undefined;
	if (!machine && !runnerType) return undefined;
	return `Agent '${agent.name}' uses launcher '${agent.launcher}', which wraps the local Pi background runner, so it cannot run ${machine ? `on machine '${machine}'` : `with runner.type='${runnerType}'`}.`;
}

/** The launcher an agent launch runs under, or the reason it cannot launch. */
export function resolveAgentRunnerLauncher(agent: Pick<AgentConfig, "name" | "launcher" | "runner">, runnerLaunchers: Record<string, RunnerLauncherConfig> | undefined, machine: string | undefined): { launcher?: RunnerLauncher; error?: string } {
	if (agent.launcher === undefined) return {};
	const placementError = runnerLauncherPlacementError(agent, machine);
	if (placementError) return { error: placementError };
	const launcher = lookupRunnerLauncher(runnerLaunchers, agent.launcher);
	return launcher ? { launcher } : { error: `Agent '${agent.name}' uses launcher '${agent.launcher}', which is not defined in runnerLaunchers in the user subagent config.` };
}
