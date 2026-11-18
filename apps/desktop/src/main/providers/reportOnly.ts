import { isTeamEvidenceTool, type AgentWriteBridgeAddress } from "@eo/core";

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
