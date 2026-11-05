/**
 * What the Modules screen says around a test-case write that withdraws an
 * approved module's approval (EO-500), shared by both layouts' case
 * editors so the two cannot drift into saying different things about the
 * same rule.
 *
 * The rule is the data layer's (EO-498): any change to an approved
 * module's cases withdraws its approval in the same write. The screen
 * says so before the write, and offers Approve after it.
 */

/** The consequence, said in the confirmation before a case of an approved module is written. */
export function caseWriteWithdrawsApproval(moduleName: string): string {
  return `${moduleName} is approved. Changing its test cases withdraws its approval, so steps that run ${moduleName} stop until it is approved again.`;
}

/**
 * Said before the scenario chat opens on an approved module: the room
 * saves the cases the system agent writes or fixes as it goes, with no
 * further question, so this is the person's last word before the write.
 */
export function scenarioChatWritesDirectly(moduleName: string): string {
  return `The system agent saves each case it writes or fixes for ${moduleName} as soon as it is written, so the first one withdraws the approval.`;
}

/** Said after the write, beside Approve. */
export function caseWriteWithdrewApproval(moduleName: string): string {
  return `The approval of ${moduleName} is withdrawn. Steps that run it stop until it is approved again.`;
}

/**
 * Whether a case write on this module would withdraw an approval, as the
 * screen knows it right now.
 *
 * `withdrawnFrom` is the `approvedAt` a write on this screen has just
 * withdrawn. Until the module list is fetched again the module still
 * carries it, and it must not be read as approved — nor warn a second
 * time about an approval already gone. A later approval has a new
 * `approvedAt`, so it reads as approved again.
 */
export function isApprovedNow(approvedAt: number | null, withdrawnFrom: number | null): boolean {
  return approvedAt !== null && approvedAt !== withdrawnFrom;
}

/**
 * Something the scenario chat is about to do that can lead the system
 * agent to write a case: open the chat, or start a turn in it (a message,
 * or answers to its questions). The chat itself saves what the agent
 * writes with no further question, so these are the person's last words
 * before the write, and the Tests panel decides whether to ask first.
 */
export interface CaseWriteRequest {
  what: "open" | "turn";
  /** Goes ahead. */
  proceed: () => void;
  /** Called instead of `proceed` when the person keeps the approval. */
  cancel: () => void;
}

export type CaseWriteGuard = (request: CaseWriteRequest) => void;

/** Why a message or an answer was not sent, when the person kept the approval. It stays in the box. */
export function turnNotSent(moduleName: string): string {
  return `Not sent. ${moduleName} keeps its approval.`;
}

/**
 * Runs `start` once the guard lets it, or rejects with `turnNotSent` —
 * so the composer and the question card keep what was typed, as they do
 * for any refused send. No guard: runs at once.
 */
export function guardedTurn<T>(guard: CaseWriteGuard | undefined, moduleName: string, start: () => Promise<T>): Promise<T> {
  if (!guard) return start();
  return new Promise<T>((resolve, reject) => {
    guard({
      what: "turn",
      proceed: () => void start().then(resolve, reject),
      cancel: () => reject(new Error(turnNotSent(moduleName))),
    });
  });
}
