import {
  ADMIN_MCP_SERVER_NAME,
  developerType,
  mcpToolId,
  parsedResultOf,
  ScenarioOutputSchema,
  uuidv7,
  type Comment,
  type CustomModule,
  type Item,
  type ModuleTestCaseResult,
  type Run,
  type RunEvent,
  type ScenarioDiagnosis,
  type ScenarioModuleChange,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import {
  createItem,
  getItem,
  getModule,
  getModuleTest,
  getModuleTestResult,
  getRun,
  listCommentsForItem,
  listActiveRuns,
  listItemsIncludingArchived,
  listModuleTests,
  listRunEvents,
  moduleTestFingerprint,
  postComment,
  setItemArchived,
  updateItem,
} from "../db/repos/index.js";
import { SCENARIO_ACTION, SCENARIO_SETTINGS_KEY, SCENARIO_STEP } from "./conversationSteps.js";
import { postDiscussionQuestions } from "./discussion.js";
import { applyModuleChange, drawModuleChange, type AppliedModuleChange } from "./moduleChange.js";
import { PROPOSAL_KIND } from "./proposal.js";

/**
 * A module's scenario chat: "+ Add scenario" on a module's page (EO-356).
 *
 * The fourth conversation room, and the shape is the other three's on
 * purpose — a conversation is an item on an off-board step, a turn is a
 * run driven by an @-mention, and what the agent says comes back as
 * comments. `ipc/conversationView.ts` renders it and
 * `ipc/conversationTurns.ts` answers its question cards, so nothing about
 * what a card is or which question is still live is decided twice.
 *
 * What is this room's own:
 *
 *   * **Which conversation.** One live thread per *module*, kept under
 *     `spec.scenario.moduleId`, resumed whenever that module's page opens
 *     the chat. Clear archives it and leaves an empty one. No expiry: a
 *     thread about one module's tests is the record of how they were
 *     written, and it is put away by a person, not by a clock.
 *   * **What a turn is handed.** The module itself — its manifest and its
 *     code, numbered by line — in the task line every turn
 *     (`scenarioTaskAppendix`). No tool answers with a module's code, and
 *     a case written against a module the agent has not read is a guess.
 *   * **What EO adds to a reply.** The result of the case the turn names,
 *     read from the stored run rather than from the agent's account of it
 *     (invariant #5); and, when that case failed, the evidence card —
 *     the failing assertion and the module's output out of the same run,
 *     the `ctx.exec` calls compared, and the module's lines quoted out of
 *     its own code.
 *   * **What a case it wrote did to the module's approval.** Writing,
 *     fixing or deleting a case of an approved module withdraws its
 *     approval (EO-498), and this room writes cases directly — that is
 *     its job. When one of the turn's `eo_admin` case writes is answered
 *     with the withdrawal, EO records it against the turn as the call is
 *     answered (`recordScenarioApprovalWithdrawal`), from the answer's
 *     data rather than its prose; under the reply it says so, names the
 *     module, and the panel offers Approve there (EO-501). Nothing the
 *     agent said has a part in it (invariant #5).
 *   * **A change to the module is a card, never a save.** The agent may
 *     propose one when the person asks for the module to be fixed; it is
 *     shown as a diff of the code and of the manifest, and nothing is
 *     written until the person presses Apply — which is
 *     `applyScenarioChange`, an ordinary module save that withdraws
 *     approval exactly as an edit in Settings does. The card and the
 *     save are `roles/moduleChange.ts`, shared with the help chat
 *     (EO-418), so the two cannot come to differ about either.
 *
 * And what it holds a turn to, rather than asks of it:
 *
 *   * **It never changes the module on its own initiative.** While a
 *     scenario turn is running, `eo_admin` refuses `module_save`,
 *     `module_approve` and `module_archive` on that module before
 *     anything is written (`scenarioModuleWriteRefusal`, consulted by the
 *     admin host). The prompt says so too, and the turn's own log is read
 *     afterwards as well (`moduleWritesIn`), so a write that got past the
 *     boundary by some other road is never silent.
 *   * **A failure comes with its evidence and a question.** A turn that
 *     reports on a case whose stored result is a failure is not accepted
 *     until it carries the diagnosis — the calls compared and the lines
 *     involved — and asks the person how to resolve it, or proposes the
 *     fix they asked for (`scenarioResultProblem`, consulted where the
 *     supervisor validates every result, so the turn is sent back to the
 *     agent with what is missing).
 */

export { SCENARIO_ACTION, SCENARIO_STEP } from "./conversationSteps.js";

/** Who answers here: the same resolver every other room uses (EO-181). */
export { architectAgent as scenarioAgent } from "./architect.js";

/** `SCN-3`, a sequence of its own for the reason `DISC`, `ARCH` and `ASK` have theirs. */
export const SCENARIO_KEY_PREFIX = "SCN";

const SPEC_KEY = SCENARIO_SETTINGS_KEY;

/**
 * Where what a change card was drawn against is kept, by card id: the
 * hashes of the module's code and manifest at that moment (EO-418).
 * A card posted before the manifest travelled holds the code's hash
 * alone, as a string, and still applies — `applyModuleChange` reads both.
 */
const CHANGES_FIELD = "changes";

/**
 * Where a turn's withdrawn approval is recorded, by run id (EO-501):
 * the module, how the case write that withdrew it changed the cases, and
 * — once the reply is posted — the id of EO's record of it, which is the
 * comment the view marks for Approve.
 */
const WITHDRAWN_FIELD = "withdrawnBy";

interface WithdrawnBy {
  moduleId: string;
  change: CaseChange;
  recordId?: string;
}

/** The room's own object in `items.spec`, or an empty one. */
function scopeOf(conversation: Item): Record<string, unknown> {
  const stored = conversation.spec?.[SPEC_KEY];
  return stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
}

/** The module a scenario conversation is about, or null when the row says nothing usable. */
export function scenarioModuleIdOf(conversation: Item): string | null {
  const moduleId = scopeOf(conversation)["moduleId"];
  return typeof moduleId === "string" && moduleId !== "" ? moduleId : null;
}

// ── The conversation ──────────────────────────────────────────

/**
 * The module a room may be opened about: one that exists and has not
 * been archived. A thread about a module nobody can run any more would
 * write cases nothing will ever approve.
 */
export function scenarioModule(db: Db, moduleId: string): { ok: true; module: CustomModule } | { ok: false; reason: string } {
  const module = getModule(db, moduleId);
  if (!module) return { ok: false, reason: "That module no longer exists." };
  if (module.archivedAt !== null) return { ok: false, reason: "That module has been deleted, so there is nothing to write scenarios for." };
  return { ok: true, module };
}

/**
 * Starts a module's thread.
 *
 * A feature, for the reason `openAssistConversation` gives:
 * `dispatchWorkspace` hands feature-type items the repository itself
 * rather than cutting a worktree, which is the read-only shape a
 * conversation needs.
 */
export function openScenarioConversation(db: Db, module: CustomModule, projectId: Uuid | null): Item {
  const created = createItem(db, {
    type: developerType("feature"),
    title: `Scenarios: ${module.name}`,
    stepId: SCENARIO_STEP,
    projectId,
    keyPrefix: SCENARIO_KEY_PREFIX,
    spec: { [SPEC_KEY]: { moduleId: module.id } },
  });
  // No thread to post a guard into — the thread is what is being created.
  if (!created.ok) throw new Error(created.problem);
  return created.item;
}

/** The module's live thread, newest first should an older build have left two. */
export function liveScenarioConversation(db: Db, moduleId: string): Item | undefined {
  return listItemsIncludingArchived(db)
    .filter((item) => item.stepId === SCENARIO_STEP && item.archivedAt === null && scenarioModuleIdOf(item) === moduleId)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))[0];
}

export interface OpenedScenarioRoom {
  conversation: Item;
  resumed: boolean;
  /** The thread Clear put away, as it stands now that it is archived. */
  cleared?: Item;
}

/**
 * The module's thread: the live one, or a new one.
 *
 * Creating on read, as `openAssistRoom` does and for its reason: this is
 * opened by a person pressing "+ Add scenario", which is somebody
 * deciding to talk, never by a screen rendering.
 */
export function openScenarioRoom(db: Db, module: CustomModule, projectId: Uuid | null): OpenedScenarioRoom {
  const live = liveScenarioConversation(db, module.id);
  if (live) return { conversation: live, resumed: true };
  return { conversation: openScenarioConversation(db, module, projectId), resumed: false };
}

/**
 * Clear: archives the module's thread and leaves an empty one.
 *
 * `clearAssistRoom`'s rule, for one module: archived rather than deleted
 * (invariant #3), so nothing is lost and there is nothing to confirm; and
 * an empty thread is cleared by doing nothing, so no `SCN-` key is burnt
 * on a conversation nobody had. A live turn is stopped by the caller,
 * which holds the engine.
 */
export function clearScenarioRoom(db: Db, module: CustomModule, projectId: Uuid | null): OpenedScenarioRoom {
  const live = liveScenarioConversation(db, module.id);
  if (!live) return { conversation: openScenarioConversation(db, module, projectId), resumed: false };
  if (listCommentsForItem(db, live.id).length === 0) return { conversation: live, resumed: true };

  return db.transaction(() => {
    setItemArchived(db, live.id, Date.now());
    return { conversation: openScenarioConversation(db, module, projectId), resumed: false, cleared: getItem(db, live.id) ?? live };
  });
}

// ── What a turn is handed ─────────────────────────────────────

/** The module's code with every line numbered, which is how a turn names the lines a failure involves. */
export function numberedCode(code: string): string {
  const lines = code.split("\n");
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width)} | ${line}`).join("\n");
}

/** A fence that the text inside it cannot close. */
function fence(text: string, info = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${info}\n${text}\n${ticks}`;
}

/** The latest stored run, in one line, and whether it is still about what is saved. */
function latestRunLine(db: Db, module: CustomModule): string {
  const stored = getModuleTestResult(db, module.id);
  if (!stored) return "Its tests have never been run.";
  const run = stored.run;
  const passed = run.cases.filter((each) => each.passed).length;
  const stale = stored.fingerprint !== moduleTestFingerprint(module, listModuleTests(db, module.id));
  return (
    `Latest run: ${passed} of ${run.cases.length} passed, line coverage ${run.coverage.lines.percent}%, branch coverage ${run.coverage.branches.percent}%` +
    (stale ? " — taken before the code or the cases last changed, so a re-run is due." : ".")
  );
}

/**
 * The task line of a `scenario` turn: what the conversation is, and the
 * module it is about, as it stands right now.
 *
 * Every turn, not only the first: a resumed thread carries what was said,
 * but the module can have been edited — by an applied change from this
 * very chat — and a case written against the code as it was is a case
 * against code that no longer exists. `taskAppendixFor` is shared with
 * the follow-up prompt for exactly this kind of framing.
 *
 * The code is numbered so the lines a failure involves can be named by
 * number, which is how `diagnosis.lines` names them and how EO quotes
 * them back.
 */
export function scenarioTaskAppendix(db: Db, conversation: Item): string {
  const intro =
    "What you are working on is not work — it is a conversation about one custom module, and the comment thread below is the chat. " +
    "Reply to the most recent thing the person said. Everything you need is in your `scenario` instructions.";

  const moduleId = scenarioModuleIdOf(conversation);
  const found = moduleId === null ? null : scenarioModule(db, moduleId);
  if (found === null || !found.ok) {
    return `${intro}\n\nThe module this conversation is about no longer exists, so there is nothing to test. Say so, and write and run nothing.`;
  }

  const module = found.module;
  const tests = listModuleTests(db, module.id);
  return [
    intro,
    "",
    "## The module",
    "",
    `**${module.name}** (slug: \`${module.slug}\`, id: \`${module.id}\`) — ${module.approvedAt === null ? "not approved" : "approved"}. ${module.description}`,
    "",
    `It has ${tests.length} test case${tests.length === 1 ? "" : "s"}; read them with \`module_tests_list\` before writing another. ${latestRunLine(db, module)}`,
    "",
    "Its manifest:",
    "",
    fence(JSON.stringify(module.manifest, null, 2), "json"),
    "",
    "Its code, as saved now, each line numbered as `diagnosis.lines` names them:",
    "",
    fence(numberedCode(module.code), "js"),
  ].join("\n");
}

// ── What the agent said ───────────────────────────────────────

/** Is this comment a change to the module that a scenario turn proposed? */
export function isScenarioChangeCard(db: Db, comment: Comment): boolean {
  if (comment.kind !== PROPOSAL_KIND || comment.runId === null) return false;
  return getRun(db, comment.runId)?.action === SCENARIO_ACTION;
}

/**
 * Is a scenario turn about this module under way?
 *
 * What `eo_admin` can know about who is calling: it answers one token,
 * held by the system agent, so a rule about one chat is stated about the
 * module that chat is about.
 *
 * `which` says what counts. `"active"` is a turn queued or running —
 * what the scenario chat's own refusal guards, since a queued turn is
 * about to run and refusing early costs nothing. `"running"` is a turn
 * actually running, and is what the help chat's rule
 * (`approvedModuleTestWriteRefusal`) asks before letting a test-case
 * write through: a queued turn has not started, so no call can be its,
 * and an exception granted to it would be a hole for anything else
 * (EO-499).
 */
export function scenarioTurnOn(db: Db, moduleId: string, which: "active" | "running"): boolean {
  return scenarioTurnsOn(db, moduleId, which).length > 0;
}

/** The scenario turns about this module under way, as `scenarioTurnOn` counts them. */
function scenarioTurnsOn(db: Db, moduleId: string, which: "active" | "running"): Run[] {
  return listActiveRuns(db).filter((run) => {
    if (run.action !== SCENARIO_ACTION) return false;
    if (which === "running" && run.status !== "running") return false;
    const conversation = getItem(db, run.itemId);
    return conversation !== undefined && scenarioModuleIdOf(conversation) === moduleId;
  });
}

/**
 * Why `eo_admin` refuses this call, or null to let it through.
 *
 * The boundary half of "a scenario chat never changes the module on its
 * own initiative". The admin host cannot tell which run a call comes
 * from — it answers one token, held by the system agent — so the rule is
 * stated about the module instead: while a scenario turn about a module
 * is running, nothing reaching EO over `eo_admin` may save, approve or
 * archive *that* module. A person is untouched by it: Settings and the
 * chat's own Apply button reach EO over IPC, not through this server.
 *
 * Narrow on purpose. A save that creates a new module, or one about a
 * module no scenario turn is running on, goes through: the assistant may
 * be saving an unrelated module at the same moment, and refusing it would
 * be a guard firing on somebody else's work.
 */
export function scenarioModuleWriteRefusal(db: Db, tool: string, args: unknown): string | null {
  if (!MODULE_WRITES.has(tool)) return null;
  const target = typeof args === "object" && args !== null ? (args as Record<string, unknown>)["id"] : undefined;
  if (typeof target !== "string" || target === "") return null;

  if (!scenarioTurnOn(db, target, "active")) return null;

  return (
    `EO refused ${tool}: a scenario chat about this module is running, and a scenario chat never changes the module itself. ` +
    "Nothing has been written. To fix the module, return the whole fixed code as `change`, with its whole manifest when the fix " +
    "needs one — the person sees it as a diff and applies it themselves — and only when they asked for a fix."
  );
}

/**
 * Why a scenario turn's result is not yet an answer, or null when it is.
 *
 * The other half: a turn that names a test case is held to what the
 * stored run says about it, read here rather than taken from the turn
 * (invariant #5).
 *
 *   * The case has to be this module's, and has to have been run against
 *     what is saved now — a reply about a case nobody has run, or about
 *     a run older than the last save, is a reply about something else.
 *   * When it failed, the reply has to carry `diagnosis` — the calls the
 *     case scripted and the ones the module made, and the module's lines
 *     involved — and has to ask the person how to resolve it, or carry
 *     the fix they already asked for as `change`.
 *
 * Returned as a sentence to the agent: the supervisor re-prompts with it
 * exactly as it re-prompts a result that fails its schema, so the turn is
 * corrected rather than dropped, and one that still cannot be completed
 * ends with the reason in the thread (invariant #8).
 */
export function scenarioResultProblem(db: Db, conversation: Item, result: unknown): string | null {
  const parsed = ScenarioOutputSchema.safeParse(result);
  if (!parsed.success) return null;
  const output = parsed.data;
  const testId = output.testId;
  if (testId === null) return null;

  const moduleId = scenarioModuleIdOf(conversation);
  const module = moduleId === null ? undefined : getModule(db, moduleId);
  if (!module) return null; // the module is gone; `scenarioTaskAppendix` already told the turn so

  const test = getModuleTest(db, testId);
  if (!test || test.moduleId !== module.id) {
    return `\`testId\` is "${testId}", which is not one of ${module.name}'s test cases. Name the case this turn wrote or ran, as module_tests_list gives its id, or leave \`testId\` null.`;
  }

  const stored = getModuleTestResult(db, module.id);
  const found = stored?.run.cases.find((each) => each.testId === test.id);
  const stale = stored !== undefined && stored.fingerprint !== moduleTestFingerprint(module, listModuleTests(db, module.id));
  if (!stored || !found || stale) {
    return (
      `“${test.description}” has not been run against the module and cases as they are saved now, so there is no result to report. ` +
      "Run the module's tests with module_tests_run and report what that run says — or, if they cannot be run, leave `testId` null and say why."
    );
  }
  if (found.passed) return null;

  const missing: string[] = [];
  if (output.diagnosis === null) {
    missing.push(
      "`diagnosis`: the `ctx.exec` calls the case scripted (`scripted`) and the ones the module made (`made`), each as a command line, and the module's lines involved (`lines`, by the numbers in your task line)",
    );
  }
  if (output.questions.length === 0 && output.change === null) {
    missing.push(
      "a question asking the person how to resolve it — for example “The test is wrong — fix the case”, “The module is wrong — propose a fix”, “Leave it failing for now” — or, if they already asked for the module to be fixed, the fix as `change`",
    );
  }
  if (missing.length === 0) return null;
  return `“${test.description}” failed in the latest run, and a failure is reported with its evidence and put to the person to resolve. This reply is missing:\n\n${missing.map((entry) => `- ${entry}`).join("\n")}`;
}

/**
 * The `eo_admin` tools that change a module rather than its tests.
 *
 * A scenario turn may write, edit and run test cases — that is the whole
 * of its job — and must never call one of these: changing the module is
 * the person's to decide, by applying a card.
 */
const MODULE_WRITES: ReadonlySet<string> = new Set(["module_save", "module_approve", "module_archive"]);

/** The `eo_admin` tools that write a module's test cases — what a scenario turn is for. */
const CASE_WRITES: ReadonlySet<string> = new Set(["module_test_save", "module_test_delete"]);

/** How a case write changed the module's cases, in the words the record uses. */
export type CaseChange = "added" | "edited" | "deleted";

/** An object's fields, or none. */
function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** What this run's records of a withdrawn approval say, by run id. */
function withdrawnByOf(conversation: Item): Record<string, WithdrawnBy> {
  const recorded = fieldsOf(scopeOf(conversation)[WITHDRAWN_FIELD]);
  const entries: Record<string, WithdrawnBy> = {};
  for (const [runId, value] of Object.entries(recorded)) {
    const entry = fieldsOf(value);
    const { moduleId, change, recordId } = entry;
    if (typeof moduleId !== "string" || (change !== "added" && change !== "edited" && change !== "deleted")) continue;
    entries[runId] = { moduleId, change, ...(typeof recordId === "string" ? { recordId } : {}) };
  }
  return entries;
}

/** Writes this conversation's records of a withdrawn approval back, over what is stored now. */
function storeWithdrawnBy(db: Db, conversationId: Uuid, update: (entries: Record<string, WithdrawnBy>) => Record<string, WithdrawnBy>): void {
  const current = getItem(db, conversationId);
  if (!current) return;
  const scope = scopeOf(current);
  updateItem(db, current.id, { spec: { ...(current.spec ?? {}), [SPEC_KEY]: { ...scope, [WITHDRAWN_FIELD]: update(withdrawnByOf(current)) } } });
}

/**
 * Records that a scenario turn's case write withdrew its module's
 * approval (EO-501) — told of every call `eo_admin` answers, as it
 * answers it (`AdminMcpOptions.observeCall`).
 *
 * The evidence is EO's own: the data the call answered with, whose
 * `approvalWithdrawn` is the repo's word that this write took an approval
 * away (EO-498) — true only when the module was approved at that moment
 * and the write changed a case. Not the answer's prose, which a run's log
 * keeps bounded and which quotes the case's description back, and not
 * anything the agent said.
 *
 * Whose turn it was is the module's running scenario turn. Through
 * `eo_admin` a case of an approved module can only be written while one
 * is running (`approvedModuleTestWriteRefusal`), so a write that
 * withdrew an approval there is that turn's. The first such write a turn
 * makes is the one kept: a turn withdraws an approval once.
 */
export function recordScenarioApprovalWithdrawal(db: Db, tool: string, args: unknown, data: unknown): void {
  if (!CASE_WRITES.has(tool)) return;
  const answer = fieldsOf(data);
  if (answer["approvalWithdrawn"] !== true) return;

  const given = fieldsOf(args);
  // A save names its module; a delete names only the case, which is gone, so its answer says whose it was.
  const moduleId = tool === "module_test_delete" ? answer["moduleId"] : given["moduleId"];
  if (typeof moduleId !== "string" || moduleId === "") return;
  const caseId = given["id"];
  const change: CaseChange = tool === "module_test_delete" ? "deleted" : typeof caseId === "string" && caseId !== "" ? "edited" : "added";

  for (const run of scenarioTurnsOn(db, moduleId, "running")) {
    storeWithdrawnBy(db, run.itemId as Uuid, (entries) => (entries[run.id] ? entries : { ...entries, [run.id]: { moduleId, change } }));
  }
}

function payloadOf(event: RunEvent): Record<string, unknown> {
  const { payload } = event;
  if (typeof payload === "string") {
    try {
      const parsed: unknown = JSON.parse(payload);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
}

/**
 * Every module write this run made through `eo_admin`, by tool name.
 *
 * Read from the run's own log, both spellings — `mcp__eo_admin__module_save`
 * on Claude and `eo_admin/module_save` on Codex — through `mcpToolId`,
 * the one reader of either (invariant #12). A call its backend answered
 * with an error wrote nothing and is not counted; one with no answer at
 * all is, because "it may have" is the honest reading of a call nothing
 * reported back on.
 */
export function moduleWritesIn(events: readonly RunEvent[]): string[] {
  return adminCallsIn(events, MODULE_WRITES);
}

/** The calls this run made to these `eo_admin` tools, by tool name, read as `moduleWritesIn` reads them. */
function adminCallsIn(events: readonly RunEvent[], tools: ReadonlySet<string>): string[] {
  const failed = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool_result") continue;
    const payload = payloadOf(event);
    if (typeof payload["callId"] === "string" && payload["ok"] === false) failed.add(payload["callId"]);
  }

  const writes: string[] = [];
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const payload = payloadOf(event);
    const name = payload["name"];
    if (typeof name !== "string") continue;
    const id = mcpToolId(name, [ADMIN_MCP_SERVER_NAME]);
    if (id === null || id.server !== ADMIN_MCP_SERVER_NAME || id.tool === null || !tools.has(id.tool)) continue;
    const callId = payload["callId"];
    if (typeof callId === "string" && failed.has(callId)) continue;
    writes.push(id.tool);
  }
  return writes;
}

/**
 * Posts what a `scenario` turn came back with.
 *
 * In this order, so the thread reads the way the turn went: what the
 * agent said; anything it did to the module that it must not have; EO's
 * own record of the case it reports on; the evidence when that case
 * failed; EO's record that a case the turn wrote withdrew the module's
 * approval, when one did; the questions; and last a proposed change, if the person asked
 * for one. Mentions nobody, for `postAssistReply`'s reason — the
 * person is looking at the panel.
 */
export function postScenarioReply(db: Db, conversation: Item, agentId: Uuid, runId: Uuid, parsedResult: unknown): void {
  const parsed = ScenarioOutputSchema.safeParse(parsedResult);
  if (!parsed.success) return; // validated upstream; nothing to post if it somehow was not
  const output = parsed.data;
  const initiationId = (getRun(db, runId)?.initiationId as Uuid | null) ?? null;
  const asAgent = { type: "agent" as const, agentId };

  postComment(db, {
    itemId: conversation.id,
    runId,
    author: asAgent,
    kind: "note",
    body: output.message,
    parseBodyMentions: false,
    // Resolves only the message this run saw; a follow-up sent while it
    // worked stays open and becomes the next turn.
    parentId: initiationId,
  });

  const moduleId = scenarioModuleIdOf(conversation);
  const module = moduleId === null ? undefined : getModule(db, moduleId);

  // Invariant #5: the turn's own log, not its account of itself.
  const events = listRunEvents(db, runId);
  const writes = moduleWritesIn(events);
  if (writes.length > 0) {
    postComment(db, {
      itemId: conversation.id,
      runId,
      author: { type: "engine" },
      kind: "rejection",
      body:
        `This turn called ${[...new Set(writes)].map((tool) => `\`${tool}\``).join(", ")} on \`${ADMIN_MCP_SERVER_NAME}\`. ` +
        "A scenario chat must never change a module on its own — a fix is proposed as a card and saved only when you apply it. " +
        "Check the module's code and approval in Settings before relying on it.",
      parseBodyMentions: false,
    });
  }

  if (output.testId !== null && module) {
    const record = caseRecord(db, module, output.testId);
    postComment(db, { itemId: conversation.id, runId, author: { type: "engine" }, kind: "note", body: record.body, parseBodyMentions: false });
    if (record.failed) {
      postComment(db, {
        itemId: conversation.id,
        runId,
        author: asAgent,
        kind: "note",
        body: renderEvidence(module, record.failed, output.diagnosis),
        parseBodyMentions: false,
      });
    }
  }

  if (module) postApprovalWithdrawn(db, conversation, module, runId, events);

  postDiscussionQuestions(db, conversation, agentId, runId, output.questions);

  if (output.change) postChangeCard(db, conversation, module, agentId, runId, initiationId, output.change);
}

/**
 * What the stored run says about one case, in EO's words.
 *
 * Read from the run the turn itself made with `module_tests_run`, and
 * from nowhere else: an agent saying "it passed" is a claim, and this is
 * the check (invariant #5). The coverage is the module's, across every
 * case, which is the figure the module page's badge shows.
 */
function caseRecord(db: Db, module: CustomModule, testId: string): { body: string; failed: ModuleTestCaseResult | null } {
  const test = getModuleTest(db, testId);
  if (!test || test.moduleId !== module.id) {
    return {
      body: `EO has no result to show: \`${testId}\` is not one of ${module.name}'s test cases.`,
      failed: null,
    };
  }

  const stored = getModuleTestResult(db, module.id);
  const result = stored?.run.cases.find((each) => each.testId === test.id);
  if (!stored || !result) {
    return { body: `“${test.description}” has not been run yet, so EO has no result for it. Its tests re-run in the background after every save.`, failed: null };
  }

  const stale = stored.fingerprint !== moduleTestFingerprint(module, listModuleTests(db, module.id));
  const { lines, branches } = stored.run.coverage;
  return {
    body: [
      `**${result.passed ? "Passed" : "Failed"}:** “${test.description}”, in the latest run of ${module.name}'s tests.`,
      `Coverage: ${lines.percent}% of lines (${lines.covered} of ${lines.total}), ${branches.percent}% of branches (${branches.covered} of ${branches.total}).`,
      ...(stale ? ["That run was taken before the module's code or cases last changed, so these figures may not hold any more."] : []),
    ].join(" "),
    failed: result.passed ? null : result,
  };
}

/** The sentence's verb for each kind of case write. */
const CHANGED: Record<CaseChange, string> = { added: "added", edited: "changed", deleted: "deleted" };

/**
 * EO's record that a case this turn wrote withdrew the module's approval
 * (EO-501), when one did.
 *
 * The scenario chat saves cases directly — writing one and running it is
 * what the person asked for — so the withdrawal happens before anybody
 * could be warned of it, and this is where they learn of it: under the
 * reply, in EO's voice, whatever the reply itself said.
 *
 * Posted when both of EO's own records agree: the withdrawal recorded
 * against this run as the call was answered
 * (`recordScenarioApprovalWithdrawal`), for the module this chat is
 * about; and a case write in the run's own log that its backend did not
 * answer with an error. The record's id is kept beside the withdrawal,
 * so the view marks it and the panel offers Approve under it
 * (`scenarioApprovalWithdrawn`).
 */
function postApprovalWithdrawn(db: Db, conversation: Item, module: CustomModule, runId: Uuid, events: readonly RunEvent[]): void {
  const withdrawn = withdrawnByOf(getItem(db, conversation.id) ?? conversation)[runId];
  if (!withdrawn || withdrawn.moduleId !== module.id || withdrawn.recordId !== undefined) return;
  if (adminCallsIn(events, CASE_WRITES).length === 0) return;

  const id = uuidv7();
  storeWithdrawnBy(db, conversation.id, (entries) => ({ ...entries, [runId]: { ...withdrawn, recordId: id } }));
  postComment(db, {
    id,
    itemId: conversation.id,
    runId,
    author: { type: "engine" },
    kind: "note",
    body:
      `**${module.name} is no longer approved.** This turn ${CHANGED[withdrawn.change]} one of its test cases, and any change to an ` +
      "approved module's test cases withdraws its approval — the cases are no longer the ones that were approved. Steps that run it " +
      "stop, and no pipeline naming it publishes, until it is approved again. Approving runs every case and names any that fail.",
    parseBodyMentions: false,
  });
}

/**
 * The module whose approval this comment records as withdrawn by the
 * turn's case write, or null for every other comment (EO-501) — see
 * `DiscussionMessage.approvalWithdrawn`.
 */
export function scenarioApprovalWithdrawn(conversation: Item, comment: Comment): { moduleId: string } | null {
  if (comment.authorType !== "engine" || comment.runId === null) return null;
  const withdrawn = withdrawnByOf(conversation)[comment.runId];
  return withdrawn !== undefined && withdrawn.recordId === comment.id ? { moduleId: withdrawn.moduleId } : null;
}

/** How much of a case's output the evidence card quotes. The tail is where it explains itself. */
const EVIDENCE_OUTPUT_CHARS = 2000;

/** One cell of a markdown table, as code, with nothing in it able to break the row. */
function cell(text: string | undefined): string {
  if (text === undefined) return "—";
  return `\`${text.replace(/\|/g, "\\|").replace(/`/g, "'").replace(/\s+/g, " ")}\``;
}

/**
 * The module's own lines, quoted from its code as it is saved now.
 *
 * Numbers the turn got wrong show the wrong lines rather than lines that
 * do not exist — and a range past the end of the file says so instead of
 * being quietly dropped.
 */
function quotedLines(code: string, ranges: ScenarioDiagnosis["lines"]): string {
  const lines = code.split("\n");
  const width = String(lines.length).length;
  return ranges
    .map(({ from, to }) => {
      const start = Math.min(from, to);
      const end = Math.min(Math.max(from, to), lines.length);
      if (start > lines.length) return `_Lines ${from}–${to} are past the end of the module, which has ${lines.length}._`;
      const quoted = lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(width)} | ${line}`);
      return fence(quoted.join("\n"), "js");
    })
    .join("\n\n");
}

/**
 * The evidence for a failing case, put in front of the person.
 *
 * The failing assertion and the module's output come from the stored
 * run; the lines are quoted from the module's code. Only the `ctx.exec`
 * comparison is the agent's reading, because the case's script lives in
 * its source — and it is said to be the agent's.
 */
function renderEvidence(module: CustomModule, failed: ModuleTestCaseResult, diagnosis: ScenarioDiagnosis | null): string {
  const parts = [`**Why “${failed.description}” failed**`, "", "The failing assertion:", "", fence(failed.failure ?? "(no message)")];

  if (diagnosis) {
    const rows = Math.max(diagnosis.scripted.length, diagnosis.made.length);
    parts.push("", "The `ctx.exec` calls the case scripted, against the ones the module made:", "");
    if (rows === 0) {
      parts.push("_The case scripted none, and the module made none._");
    } else {
      parts.push("| # | Scripted by the case | Made by the module | |", "| --- | --- | --- | --- |");
      for (let index = 0; index < rows; index++) {
        const scripted = diagnosis.scripted[index];
        const made = diagnosis.made[index];
        parts.push(`| ${index + 1} | ${cell(scripted)} | ${cell(made)} | ${scripted === made ? "" : "≠"} |`);
      }
    }
  } else {
    parts.push("", "_This turn did not say which `ctx.exec` calls or which lines of the module are involved._");
  }

  const output = failed.output.trim();
  parts.push("", "What the module printed during the case:", "", output === "" ? "_Nothing._" : fence(output.slice(-EVIDENCE_OUTPUT_CHARS)));

  if (diagnosis) parts.push("", `The lines of ${module.name} involved:`, "", quotedLines(module.code, diagnosis.lines));
  return parts.join("\n");
}

// ── A proposed change ─────────────────────────────────────────

/** The diff a change card draws. It lives with the card (`roles/moduleChange.ts`) and is named here for the callers that knew it here. */
export { renderCodeDiff } from "./moduleChange.js";

/**
 * The card a person reads before applying a change to the module.
 *
 * Drawn by `drawModuleChange` against the code and manifest as they are
 * saved at this moment, whose hashes are kept under the card's id:
 * applying it later checks the module still has both, so a change drawn
 * against one version is never written over another. A change that
 * cannot be shown — the module is gone, the manifest is not one, or the
 * "change" is the module as it already is — is posted as a rejection
 * carrying the reason (invariant #8), with nothing to apply.
 */
function postChangeCard(
  db: Db,
  conversation: Item,
  module: CustomModule | undefined,
  agentId: Uuid,
  runId: Uuid,
  initiationId: Uuid | null,
  change: ScenarioModuleChange,
): void {
  const drawn = drawModuleChange(db, module, change);
  if (!drawn.ok) {
    postComment(db, {
      itemId: conversation.id,
      runId,
      author: { type: "agent", agentId },
      kind: "rejection",
      body: drawn.reason,
      parentId: initiationId,
      parseBodyMentions: false,
    });
    return;
  }

  const id = uuidv7();
  const current = getItem(db, conversation.id) ?? conversation;
  const scope = scopeOf(current);
  const recorded = scope[CHANGES_FIELD];
  const changes = recorded && typeof recorded === "object" && !Array.isArray(recorded) ? (recorded as Record<string, unknown>) : {};
  updateItem(db, current.id, {
    spec: { ...(current.spec ?? {}), [SPEC_KEY]: { ...scope, [CHANGES_FIELD]: { ...changes, [id]: drawn.base } } },
  });

  postComment(db, {
    id,
    itemId: conversation.id,
    runId,
    author: { type: "agent", agentId },
    kind: PROPOSAL_KIND,
    body: drawn.body,
    parentId: initiationId,
    parseBodyMentions: false,
  });
}

export type AppliedScenarioChange = AppliedModuleChange;

/**
 * Saves what a change card proposed — the person having pressed Apply.
 *
 * Re-read from the run rather than from anything a panel kept, so what is
 * saved is what the card showed; and refused when the module's code or
 * manifest is no longer what the card was drawn against, because writing
 * a change over somebody else's edit would discard that edit without
 * anybody having seen the two side by side.
 *
 * `applyModuleChange`, which is `saveModule`, the save Settings makes:
 * the code changes, and the manifest too when the change carries one —
 * a null manifest leaves it exactly as it is — and either withdraws
 * approval there exactly as it does here. This room writes test cases
 * directly, so a change here carries none. Whether this card may still
 * be applied at all — newest wins, not yet applied — is the caller's,
 * through `approvableIds`, which every room shares.
 */
export function applyScenarioChange(db: Db, conversation: Item, commentId: Uuid): AppliedScenarioChange {
  const comment = listCommentsForItem(db, conversation.id).find((entry) => entry.id === commentId);
  if (!comment || !isScenarioChangeCard(db, comment)) return { ok: false, reason: "That card is not a change to the module." };

  const run = comment.runId ? getRun(db, comment.runId) : undefined;
  const parsed = ScenarioOutputSchema.safeParse(parsedResultOf(run?.result ?? null));
  if (!parsed.success || !parsed.data.change) return { ok: false, reason: "The run behind this card no longer has a readable change." };

  const moduleId = scenarioModuleIdOf(conversation);
  const found = moduleId === null ? null : scenarioModule(db, moduleId);
  if (found === null || !found.ok) return { ok: false, reason: found?.reason ?? "This conversation is not about a module." };

  const recorded = scopeOf(conversation)[CHANGES_FIELD];
  const base = recorded && typeof recorded === "object" && !Array.isArray(recorded) ? (recorded as Record<string, unknown>)[commentId] : undefined;
  return applyModuleChange(db, found.module, parsed.data.change, base);
}
