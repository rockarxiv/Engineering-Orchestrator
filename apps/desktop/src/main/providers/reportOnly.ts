import { isTeamEvidenceTool, type Agent, type AgentWriteBridgeAddress } from "@eo/core";
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
 * Claude nor Codex, an agent on the person's own setup, and a Codex agent
 * that names no model to take the model's own tools out of. What can only
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
  const model = agent.model ?? (typeof agent.config["model"] === "string" ? agent.config["model"] : undefined);
  if (agent.provider === "codex" && (model === undefined || model === "")) {
    return `${agent.name} names no model, so EO cannot take that model's own tools — code execution, patching and subagents — out of what it is offered; give it a model to make it a team member.`;
  }
  return null;
}
