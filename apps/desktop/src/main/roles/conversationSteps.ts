/**
 * Which off-board steps hold a conversation, and what each one runs.
 *
 * A leaf module: it imports nothing, and nothing may make it. That is the
 * entire point of it existing rather than these living beside the code
 * that uses them.
 *
 * `findPendingResponses` decides a conversation's action from the step
 * its item sits on, so it needs the step ids, and the dispatcher is
 * imported by the rooms themselves. Reading the ids back out of a room
 * would close a cycle, and the value it closes over is read at
 * module-evaluation time to build a lookup table. Under a bundler that
 * resolves the cycle the other way round, that table would be built with
 * an `undefined` key: every conversation would silently dispatch as
 * `respond`, come back in the wrong shape, and re-dispatch until the
 * attempt limit stopped it.
 *
 * Tests happened to pass either way, which is exactly what makes this
 * worth removing rather than reasoning about.
 *
 * Discussions (`discussion`, `discuss`) and the Architecture panel
 * (`architecture`, `configure`) were rooms here until EO-526. Their
 * conversations are deleted at startup (`retireConversationRooms`), and
 * nothing dispatches either action any more.
 */

/**
 * Where the assistant's conversation lives (migration 0064).
 *
 * Its own step rather than a flag on another, because the step is what
 * the code keys on: `findPendingResponses` picks the action from it, so
 * a shared step would dispatch an assist turn with the wrong output
 * schema.
 */
export const ASSIST_STEP = "assist";

/** What a turn of an assist conversation asks for. */
export const ASSIST_ACTION = "assist";

/**
 * Where a module's scenario chat lives (migration 0108, EO-356).
 *
 * Its own step for the reason `ASSIST_STEP` is one: the step is what
 * `findPendingResponses` picks the action from, and a scenario turn is
 * answered in its own shape — the test case it reports on, the evidence
 * for a failure, a proposed fix.
 */
export const SCENARIO_STEP = "scenario";

/** What a turn of a scenario chat asks for. */
export const SCENARIO_ACTION = "scenario";

/**
 * Where the assistant's room keeps its per-conversation model and
 * reasoning effort in `items.spec`.
 *
 * `roles/assist.ts` keeps the rest of what the room knows about a
 * conversation under this key too: one object per room in `items.spec`.
 * Two keys would be two things to merge on every write, and the settings
 * write already merges what it finds.
 */
export const ASSIST_SETTINGS_KEY = "assist";

/**
 * The same, for a module's scenario chat — and, as with the assistant's,
 * the room's own state lives beside the settings: `roles/scenario.ts`
 * keeps the module a thread is about under this key.
 */
export const SCENARIO_SETTINGS_KEY = "scenario";

/**
 * Where each room keeps those settings, by the step it lives on.
 *
 * `conversationView.settingsFor` is generic over this key — it takes it
 * from the room's `ConversationKind` — and the supervisor reads it here,
 * so a setting read back correctly in the chat is the one every run is
 * given. A hardcoded step comparison in the supervisor once let one
 * room's choice be applied and another's be quietly ignored.
 *
 * Built from the constants above, and the `ConversationKind`s import
 * the same ones, so the writer and the reader cannot drift.
 */
export const CONVERSATION_SETTINGS_KEY: Readonly<Record<string, string>> = {
  [ASSIST_STEP]: ASSIST_SETTINGS_KEY,
  [SCENARIO_STEP]: SCENARIO_SETTINGS_KEY,
};

/** What a conversation turn overrides on the provider, if anything. */
export interface ConversationTurnOptions {
  model?: string;
  reasoningEffort?: string;
  /**
   * Whether the turn summarises its reasoning for the chat to show. On
   * for every conversation unless somebody turned it off: these are the
   * turns a person watches, and Claude Desktop shows its thinking folded.
   */
  showReasoning?: boolean;
  /** Always on for a conversation: these are the turns a person watches (`AgentTurnOverrides.streamDeltas`). */
  streamDeltas?: boolean;
  /** And the answer with them, which in a conversation is the reply being read (`AgentTurnOverrides.streamAnswer`). */
  streamAnswer?: boolean;
}

/**
 * The model and reasoning effort a conversation turn runs with.
 *
 * Lives here rather than inside the supervisor's closure so it can be
 * tested at all: it is a pure function of the item, and the thing worth
 * asserting about it — that *every* room is read, not just the first one
 * that had settings — needs no database, provider or run.
 *
 * Everything unrecognised returns `{}` and the run takes the agent's own
 * model. A conversation off every room's step, a `spec` holding a string where
 * an object belongs, an empty model name: none of those are worth failing
 * a dispatch over, and none should silently become a provider argument.
 */
export function conversationTurnOptions(item: { stepId: string | null; spec?: Record<string, unknown> | null }): ConversationTurnOptions {
  const settingsKey = item.stepId === null ? undefined : CONVERSATION_SETTINGS_KEY[item.stepId];
  if (settingsKey === undefined) return {};
  const settings = item.spec?.[settingsKey];
  // `typeof null === "object"`, and an array is one too — neither has the
  // fields below, and reading them off would hand the provider undefined.
  // Either is read as no settings at all.
  // Every conversation is drawn as Claude Desktop draws a chat — words as
  // they are written, thinking folded under each turn — so its turns
  // stream and show their reasoning unless the conversation turned that
  // off. (Reaching here means the item is in one: the key lookup above
  // answered.)
  const value = settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
  return {
    ...(typeof value["model"] === "string" && value["model"] !== "" ? { model: value["model"] } : {}),
    ...(typeof value["reasoningEffort"] === "string" && value["reasoningEffort"] !== "" ? { reasoningEffort: value["reasoningEffort"] } : {}),
    showReasoning: value["showReasoning"] !== false,
    streamDeltas: true,
    streamAnswer: true,
  };
}
