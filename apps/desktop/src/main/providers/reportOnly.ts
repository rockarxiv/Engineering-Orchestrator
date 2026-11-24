import { isTeamEvidenceTool, type Agent, type AgentWriteBridgeAddress } from "@eo/core";
import { RUNTIMES } from "../runtimes/catalog.js";
import { CLAUDE_SDK } from "../runtimes/packages.js";
import type { ResolvedRuntime } from "../runtimes/resolve.js";
import { inheritsAmbientConfig } from "./codexHome.js";

/**
 * What both adapters hold a report-only team participant's turn to before
 * they start anything (EO-845, ARCHITECTURE.md, "A team on an agent
 * step"): the parts that are the same on either backend.
 *
 * A participant is held report-only three ways at once, and each is
 * checked rather than assumed:
 *
 * - **What it is offered.** No built-in tool that edits, runs, delegates
 *   or reads the disk, no attached server, no skill, no repository index,
 *   no administrative server, and an `eo` server listing the four
 *   evidence tools alone.
 * - **What it may call.** Each backend's `PreToolUse` hook refuses every
 *   call but those four and the backend's own answer tool
 *   (`reportOnlyCallRule`), on its first turn, a resume and a recovery.
 * - **What EO answers.** The `eo` server refuses every other call on a
 *   report-only address, and EO's bridge answers the four from the
 *   participant's own captured evidence and refuses anything else its
 *   credential does not name.
 *
 * A turn any of that cannot be established for is refused before its
 * process is started, saying why — never run with less.
 */

/** Why this address will not do for a report-only participant's `eo` server, or null where it will. */
export function reportOnlyBridgeProblem(address: AgentWriteBridgeAddress | undefined): string | null {
  if (address === undefined) return "it was given no credential to read its evidence with";
  if (address.reportOnly !== true) return "its credential is not a report-only participant's";
  const writes = address.writes ?? [];
  if (writes.length === 0) return "its credential names none of the evidence tools";
  const other = writes.filter((tool) => !isTeamEvidenceTool(tool));
  if (other.length > 0) return `its credential would also serve ${other.join(", ")}`;
  return null;
}

/** The sentence a report-only turn that cannot be held to its rules is refused with. */
export function reportOnlyStartRefusal(backend: string, why: string): string {
  return `EO did not start this report-only team participant on ${backend}, because ${why}; it runs only where EO can hold it to reading its evidence and reporting, and nothing was run.`;
}

/**
 * Why EO could not hold this agent to report-only as a team participant,
 * from its configuration alone, or null where its configuration allows it
 * (EO-848).
 *
 * The part of `reportOnlyProviderForAgent`'s refusals (engine.ts) that
 * does not depend on this machine, asked when a team is drafted, validated
 * or published, so a team that would be refused at its first participant
 * is refused before anybody presses Publish: a backend that is neither
 * Claude nor Codex, an agent on the person's own setup, an agent naming
 * its own executable (EO-850, `reportOnlyRuntimeProblem`), and a Codex
 * agent that names no model to take the model's own tools out of. What can only
 * be known where it runs — a Codex sign-in in the keyring, no hook command
 * — is still refused when it starts.
 */
export function reportOnlyAgentProblem(agent: Pick<Agent, "name" | "provider" | "model" | "config">): string | null {
  if (agent.provider !== "claude" && agent.provider !== "codex") {
    return `${agent.name} runs on ${agent.provider}, which EO cannot hold to reading its evidence and reporting; only Claude and Codex agents can be team members.`;
  }
  if (inheritsAmbientConfig(agent.config)) {
    return `${agent.name} uses the person's own setup, whose tools, servers and settings EO does not control; untick that on the agent to make it a team member.`;
  }
  const executable = agent.config["executablePath"];
  if (typeof executable === "string" && executable.trim() !== "") {
    return `${agent.name} runs its own ${agent.provider === "codex" ? "Codex" : "Claude"} executable, whose version EO cannot vouch for; clear its executable path to make it a team member, so it runs on EO's own copy.`;
  }
  const model = agent.model ?? (typeof agent.config["model"] === "string" ? agent.config["model"] : undefined);
  if (agent.provider === "codex" && (model === undefined || model === "")) {
    return `${agent.name} names no model, so EO cannot take that model's own tools — code execution, patching and subagents — out of what it is offered; give it a model to make it a team member.`;
  }
  return null;
}

/**
 * The runtime versions a report-only participant may run on (EO-850): the
 * ones the opt-in live probes, `reportOnlyClaude.live.test.ts` and
 * `reportOnlyCodex.live.test.ts`, were last run against and passed — every
 * forbidden call refused by the real CLI, nested ones included.
 *
 * What holds a participant to report-only is partly the CLI's own doing:
 * Claude honouring `tools: []` and asking EO's hook before every call,
 * Codex honouring its feature switches, its sandbox and EO's hook. A
 * version that stopped doing one of those would pass every mocked test,
 * so moving a pin in `runtimes/catalog.ts` or `runtimes/packages.ts` fails
 * `reportOnly.test.ts` until the probes are run on the new version and
 * this is moved with it; and a participant is refused, not run, on any
 * runtime but EO's own copy of the version named here.
 */
export const REPORT_ONLY_QUALIFIED_RUNTIMES: Readonly<Record<"claude" | "codex", string>> = { claude: "0.3.329", codex: "0.171.0" };

/** The Claude Agent SDK version the Claude probe passed with: it carries EO's hook to the CLI. */
export const REPORT_ONLY_QUALIFIED_CLAUDE_SDK = "0.3.329";

/**
 * Why EO cannot vouch for this runtime holding a participant to
 * report-only, or null where it can (EO-850): only EO's own managed copy,
 * at the version the live probes passed on. An executable an agent names
 * is refused whatever it is, since EO cannot know its version; so is a
 * machine where EO's copy is not installed, switched off, or not made for
 * the platform at all.
 */
export function reportOnlyRuntimeProblem(provider: "claude" | "codex", runtime: Pick<ResolvedRuntime, "source" | "path">): string | null {
  const spec = RUNTIMES[provider];
  const qualified = REPORT_ONLY_QUALIFIED_RUNTIMES[provider];
  if (runtime.source === "configured") {
    return `its agent names its own ${spec.label} executable (${runtime.path ?? "a path"}), whose version EO cannot vouch for; a participant runs only on EO's own copy of ${spec.label} ${qualified}, the version EO has proved refuses its other calls — clear the executable path on the agent to use it`;
  }
  if (runtime.source !== "cache" || runtime.path === null) {
    return `EO's own copy of ${spec.label} ${qualified} is not installed on this machine, is switched off, or is not made for this platform, and a participant runs on no other — install it on the Runtimes card`;
  }
  if (spec.version !== qualified) return `${spec.label} ${spec.version} is not a version EO has proved holds a participant to report-only (${qualified} is)`;
  if (provider === "claude" && CLAUDE_SDK.version !== REPORT_ONLY_QUALIFIED_CLAUDE_SDK) {
    return `the ${CLAUDE_SDK.label} ${CLAUDE_SDK.version} is not a version EO has proved carries its refusals to the CLI (${REPORT_ONLY_QUALIFIED_CLAUDE_SDK} is)`;
  }
  return null;
}
