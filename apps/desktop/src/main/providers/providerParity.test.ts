import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ADMIN_MCP_SERVER_NAME,
  actionDefinitionOutputSchema,
  ATTACHMENT_ADD_TOOL_NAME,
  developerRegistry,
  eoToolName,
  isThreadNotFound,
  isTurnNotEnded,
  MEMORY_NOTE_REPLACES,
  MEMORY_NOTE_TOOL_NAME,
  MEMORY_READ_TOOL_NAME,
  outputSchemaFor,
  REPOSITORY_CHECKOUT_TOOL_NAME,
  validateActionResult,
  type AgentEvent,
  type AgentProvider,
  type AgentWriteAnswer,
  type AgentWriteRequest,
  type DebugSent,
  McpServerDraftSchema,
  type McpServer,
  type Registry,
  type Skill,
  type SkillScope,
  type ThreadNotFoundError,
} from "@eo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleSeedContext, type ContextRepositoryInput } from "@eo/engine";
import { readToolDirectoryServers, writeToolDirectory } from "../agentAttachments/pluginDirectory.js";
import { attachmentEnvironment } from "../agentAttachments/serverEnvironment.js";
import { attachmentsForRun } from "../db/repos/agentAttachmentsRepo.js";
import { listAgents, saveMcpServer, setAgentAttachment } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { codexServerSecretReader } from "../engine.js";
import { storeMcpServerSecret } from "../mcp/serverSecrets.js";
import { startAgentWriteBridge } from "../mcp/writeBridge.js";
import { windowsTreeKill } from "../process/processTree.js";
import { agentRunVariables, storeVariable } from "../modules/secrets.js";
import { readOrganisationSecretEntry, storeOrganisationSecret } from "../policy/organisationSecrets.js";
import type { SecretStore } from "../secrets/store.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import { createEoMcpService, parseMemoryScopes } from "../mcp/eoServer.mjs";
import { renderMemorySection } from "../memory/selection.js";
import { renderMemoryWritingSection } from "../memory/writing.js";
import { TOOLS } from "../mcpHost/catalog.js";
import { adminToolOf } from "../roles/pipelineRead.js";
import { answerActions, ASSIST_ANSWER_WITH_MAPS, ASSIST_ANSWER_WITH_TRIAL, ASSIST_ANSWERS_WITH_CARDS, claudeViolations, openAiStrictViolations } from "../testing/answerSchemas.js";
import { allGone, descendantPids, DESCENDANTS_SNIPPET, owed, sweepUp } from "../testing/escapingDescendants.js";
import { fakeAppServer, note, type FakeAppServerScenario } from "../testing/fakeCodexAppServer.js";
import { nodeScript } from "../testing/nodeScript.js";
import { createClaudeProvider } from "./claude.js";
import { claudeProcesses } from "./claudeProcess.js";
import { codexClientOptions, codexSideCallClientOptions, createCodexProvider } from "./codex.js";
import { CodexClient, dropWarmCodexThread } from "./codexClient.js";
import type { SearchNudge } from "./searchNudge.js";
import { capturingProvider } from "./sentCapture.js";
import { createUsageTally, type ThreadUsage } from "../supervisor/usageTally.js";

// A warm Codex process is kept across clients by design; no case inherits another's.
afterEach(() => dropWarmCodexThread());

/**
 * One list of capabilities, and both adapters held to it (EO-380).
 *
 * `transcriptParity.test.ts` holds the two adapters to one transcript.
 * Nothing held them to one set of *capabilities*, and that is how ten
 * gaps built up (ASK-21) while `claude.test.ts` and `codex.test.ts` each
 * passed: every one of those files asks whether its own adapter does
 * what its own adapter was written to do, and a capability one backend
 * never got is, in that backend's file, simply a test nobody wrote.
 *
 * So the list is the thing here, and it is one list. `CAPABILITIES`
 * names each capability once, with the single observation both backends
 * must produce for it. Each adapter then has to say how it is driven to
 * that observation against a stub of its own backend — the Claude SDK's
 * `query`, and a `codex app-server` child process speaking the protocol
 * (`testing/fakeCodexAppServer.ts`) under the real `CodexClient`. The
 * expectation is written once and is not the adapter's to adjust.
 *
 * **To add a capability, add an entry to `CAPABILITIES`.** The suite
 * then fails twice — once for each backend, by name — until both have a
 * proof that produces the entry's observation. That is the whole
 * mechanism, and "the suite refuses a capability only one backend can
 * prove" at the foot of this file is the test that it is not a
 * tautology. `PROOFS` is also typed against the list, so the same
 * omission is a compile error; the runtime failure is the one that
 * counts, because Vitest does not typecheck.
 *
 * **What is compared.** The events a person, a budget or the supervisor
 * reads — which events, in what order, ending in what — or, where the
 * capability is not an event, what crossed to the backend. Fields only
 * one backend can fill in are left out of the observation where they are
 * allowed to differ, and each such place says so beside the proof: the
 * name of a plan window (`five_hour`, `5_hour`), the prefix a
 * plugin-delivered server is registered under, the words of an
 * interruption.
 *
 * **What is not here.** Whether either backend itself behaves. That is
 * the `*.live.test.ts` files' question; this one is about the two
 * adapters agreeing, which a stub can settle and a live run cannot keep
 * settled.
 */

/** What the supervisor makes of a turn — the reading in `processStream` (`runSupervisor.ts`), restated. */
type Outcome = { kind: "result"; data: unknown } | { kind: "error"; message: string } | { kind: "none" };

/**
 * A run ends on the first `result`, or on the first error that is not
 * marked non-fatal (EO-369), whichever the stream says first.
 */
function outcomeOf(events: readonly AgentEvent[]): Outcome {
  for (const event of events) {
    if (event.type === "result") return { kind: "result", data: event.data };
    if (event.type === "error" && event.fatal !== false) return { kind: "error", message: event.message };
  }
  return { kind: "none" };
}

const RESETS_AT = 1_791_472_136;

/**
 * A run's environment variables (EO-487), each of the reserved names set
 * to a value EO must not end up with. `REGION` is the one a run is meant
 * to see; every other one is a name EO sets for the run itself.
 */
const RUN_VARIABLES = (region: string) => ({
  REGION: region,
  // A computed key, so this is an own property named `__proto__` — a
  // name a variable may have, and one a plain object swallows on
  // assignment — and not this object's prototype.
  ["__proto__"]: "a-variable-called-proto",
  PATH: "/from/a/variable/bin",
  HOME: "/from/a/variable/home",
  ANTHROPIC_API_KEY: "key-from-a-variable",
  CODEX_HOME: "/from/a/variable/codex-home",
  EO_ADMIN_TOKEN: "bearer-from-a-variable",
  EO_SEARCH_HOOK_URL: "http://from-a-variable/",
  GITHUB_TOKEN: "token-from-a-variable",
});

/** What the launch environment says about EO's own names, given `RUN_VARIABLES` — one shape for both backends. */
function keepsItsOwn(env: Record<string, string | undefined> | undefined, backendCredentialOrHome: boolean) {
  return {
    PATH: env?.["PATH"] === process.env["PATH"],
    HOME: env?.["HOME"] === process.env["HOME"],
    backendCredentialOrHome,
    adminBearer: env?.["EO_ADMIN_TOKEN"]?.startsWith("turn-bearer-") === true,
    attachedServerValue: env?.["GITHUB_TOKEN"] === SECRET,
    // No hook on these turns, so EO sets nothing under the name — and a
    // variable must not set it either.
    searchHook: env?.["EO_SEARCH_HOOK_URL"] === process.env["EO_SEARCH_HOOK_URL"],
  };
}
const SECRET = "ghp_parity_secret_value";
const VERDICT_SCHEMA = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
/** `note` is the field an agent may leave out. */
const OPTIONAL_NOTE_SCHEMA = { type: "object", properties: { verdict: { type: "string" }, note: { type: "string" } }, required: ["verdict"] };

/**
 * The capabilities, and what each must look like from above the adapter.
 *
 * `same` is the observation. It is compared whole, with `toEqual`, to
 * what each backend's proof returns — so two backends that both pass
 * have, by construction, produced the same thing.
 */
/** A file posted with a message, and the one sentence both backends must say about it (EO-395). */
const SCREENSHOT = { id: "attachment-1", kind: "image", name: "screen.png", mimeType: "image/png", size: 8, origin: "eo", synchronizationState: "local" } as const;
const FILE_NOTE =
  "Attachments (metadata only; use attachment_read for content):\n- ID: attachment-1; name: screen.png; MIME type: image/png; size: 8 bytes; origin: eo; synchronization state: local";

/**
 * The three tools that write (EO-543), each with a call an agent makes and
 * what EO answers it with — in words simple enough to read back out of a
 * JSON rendering, since that is what an agent on Claude is shown.
 */
const AGENT_WRITES: { tool: AgentWriteRequest["tool"]; args: Record<string, unknown>; answer: AgentWriteAnswer }[] = [
  { tool: "comment", args: { body: "Taking the token-bucket approach." }, answer: { ok: true, text: "Comment posted. Continue with your work.", data: { commentId: "c-1" } } },
  { tool: "attachment_add", args: { paths: ["shot.png"], caption: "The screen." }, answer: { ok: true, text: "EO attached shot.png to the ticket in comment c-2.", data: { commentId: "c-2" } } },
  // With the entry it replaces (EO-594), which EO is handed as the agent wrote it.
  { tool: "memory_note", args: { scope: "project", text: "Run pnpm install before the tests.", replaces: ["m-0"] }, answer: { ok: true, text: "EO noted this in the memory of Project: Payments. These active entries in that scope are close to it, closest first:\n- `m-9`: Run pnpm install before running the tests.", data: { entryId: "m-1" } } },
  // Through the same bridge, though what it makes is a checkout rather than a row (EO-633).
  { tool: "repository_checkout", args: { repository: "web", branch: "release/2.4" }, answer: { ok: true, text: "EO checked out `release/2.4` of web at /repos/web/.git/eo-references/EO-1/release%2F2.4, detached at 0a1b2c3.", data: { commit: "0a1b2c3" } } },
];

/** What every one of them comes to, in either mode, on either backend. */
const AGENT_WRITES_HOLD = Object.fromEntries(
  AGENT_WRITES.map(({ tool, args }) => [tool, { reachedEo: { itemId: "item-1", request: { tool, args } }, recorded: { name: tool, args }, answered: { joinedToTheCall: true, toldWhatEoSaid: true } }]),
);

/**
 * Drives one backend through the three writes, in one mode (EO-543).
 *
 * `launch` runs a turn with the given options and hands back the
 * environment the backend was told to start the `eo` server with;
 * `report` runs a turn in which the backend reports each call and the
 * answer it got, in the mode's shape, and hands back the events. Between
 * them, each call is made against the real service built from that
 * environment — so it reaches EO only if the adapter delivered the
 * bridge — and the service's real answer is what the backend reports.
 */
async function agentWritesIn(
  mode: "text" | "structured",
  launch: (turn: Record<string, unknown>) => Promise<Record<string, string> | undefined>,
  report: (calls: { id: string; tool: string; args: unknown; result: EoToolResult }[], mode: "text" | "structured") => Promise<AgentEvent[]>,
): Promise<unknown> {
  const asked: { itemId: string; request: AgentWriteRequest }[] = [];
  const bridge = await startAgentWriteBridge(async (itemId, request) => {
    asked.push({ itemId, request });
    return AGENT_WRITES.find((write) => write.tool === request.tool)!.answer;
  });
  try {
    const env = (await launch({ attachFrom: ATTACH_FROM, memoryScopes: [...MEMORY_SCOPES], writeBridge: bridge.tokenFor("item-1") })) ?? {};
    const eo = (createEoMcpService as (options: Record<string, unknown>) => { handle(request: unknown): Promise<{ result: EoToolResult }>; close(): void })({
      dbPath: undefined,
      enableCommentTool: env["EO_MCP_COMMENT_ENABLED"] === "1",
      runId: env["EO_MCP_RUN_ID"] ?? null,
      runDirectory: env["EO_MCP_RUN_DIRECTORY"] ?? null,
      memoryScopes: (parseMemoryScopes as (raw: unknown) => unknown[])(env["EO_MCP_MEMORY_SCOPES"]),
      enableMemoryNote: env["EO_MCP_MEMORY_NOTE_ENABLED"] === "1",
      writeBridge: env["EO_MCP_WRITE_BRIDGE"] === undefined ? null : JSON.parse(env["EO_MCP_WRITE_BRIDGE"]),
    });
    const calls: { id: string; tool: string; args: unknown; result: EoToolResult }[] = [];
    try {
      for (const [index, { tool, args }] of AGENT_WRITES.entries()) {
        const { result } = await eo.handle({ jsonrpc: "2.0", id: index, method: "tools/call", params: { name: tool, arguments: args } });
        calls.push({ id: `call-${String(index)}`, tool, args, result });
      }
    } finally {
      eo.close();
    }
    const events = await report(calls, mode);
    return Object.fromEntries(
      AGENT_WRITES.map(({ tool, answer }, index) => {
        const call = events.find((event): event is Extract<AgentEvent, { type: "tool_call" }> => event.type === "tool_call" && event.name === tool);
        const result = events.find((event): event is Extract<AgentEvent, { type: "tool_result" }> => event.type === "tool_result" && event.callId === call?.callId);
        return [
          tool,
          {
            reachedEo: asked[index] ?? null,
            recorded: call ? { name: call.name, args: call.args } : null,
            // A `structured` answer is its JSON, where the lines of a longer text are escaped.
            answered: { joinedToTheCall: result !== undefined && call?.callId !== undefined, toldWhatEoSaid: result !== undefined && answer.ok && (result.output.includes(answer.text) || result.output.includes(JSON.stringify(answer.text).slice(1, -1))) },
          },
        ];
      }),
    );
  } finally {
    await bridge.close();
  }
}

/** A tool's answer as the `eo` service returns it. */
type EoToolResult = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };

/** The answers the "memory used in an answer" row reads (EO-597): an implement and a review, as either backend's agent writes them less `memoryUsed`. */
const IMPLEMENT_ANSWER = { branch: "eo/EO-1", summary: "Did the work.", files_changed: [], tests_run: true, handoff: "Nothing to flag." };
const REVIEW_ANSWER = { verdict: "approve", feedback: "Looks right." };
const MEMORY_USED_SCHEMAS = { implement: outputSchemaFor(developerRegistry(), "implement")!, review: outputSchemaFor(developerRegistry(), "review")! };
/** How many times a schema that crossed to a backend declares `memoryUsed`. */
const memoryUsedDeclared = (schema: unknown): number => JSON.stringify(schema ?? null).match(/"memoryUsed":\{/g)?.length ?? 0;

/** The answer as a backend hands it back in each mode: its text, or its structured part rendered as JSON. */
const textOfResult = (result: EoToolResult): string => result.content.map((block) => block.text ?? "").join("\n");
const structuredOfResult = (result: EoToolResult): string => JSON.stringify(result.structuredContent ?? {});

const CAPABILITIES = [
  {
    name: "start",
    what: "a fresh turn names its thread, says what the agent said, accounts for itself and ends on the schema-shaped answer",
    same: { events: ["thread_started", "output", "usage", "result"], threadNamed: true, outcome: { kind: "result", data: { verdict: "approve" } } },
  },
  {
    name: "resume",
    what: "a resumed turn asks the backend for that thread, in that worktree, with the new message",
    same: { asked: { threadId: "thr-persisted", cwd: "/tmp/wt", message: "the human replied" }, outcome: { kind: "result", data: "continued" } },
  },
  {
    name: "lost thread",
    what: "a thread the backend no longer has is the one error the supervisor restarts on, and no other failure is",
    same: { threadNotFound: true, threadId: "thr-gone", namesItsBackend: true, anotherFailureIsLost: false },
  },
  {
    name: "non-fatal warning",
    what: "a notice the backend raises without ending its turn does not end the run",
    same: { outcome: { kind: "result", data: "All done." } },
  },
  {
    name: "interrupt with usage on escalation",
    what: "an interrupted turn is actually cut short, and reports what it spent before the error that ends it",
    same: { interruptReachedTheTurn: true, windDown: ["usage", "error"], tokensCounted: true, retryable: true },
  },
  {
    name: "steering",
    what: "a message said into a running turn reaches that turn, and one said after it is refused",
    same: { accepted: true, delivered: "The word is pineapple.", outcome: { kind: "result", data: "pineapple" }, acceptedAfterTheTurn: false },
  },
  {
    name: "steering with files",
    what: "a steered message names each file posted with it and the tool that reads it, and a file with no words is still a message",
    same: {
      accepted: true,
      delivered: `The word is in the screenshot.\n\n${FILE_NOTE}`,
      filesOnlyAccepted: true,
      filesOnlyDelivered: FILE_NOTE,
    },
  },
  {
    name: "quota reading",
    what: "the plan's own readings are recorded as quota events, a refusal included",
    same: {
      readings: [
        { ownBackend: true, windowNamed: true, utilization: 23, status: "allowed", resetsAt: RESETS_AT },
        { ownBackend: true, windowNamed: true, utilization: 100, status: "rejected", resetsAt: RESETS_AT },
      ],
    },
  },
  {
    name: "MCP startup status",
    what: "which servers came up is said once, before the agent's first word, a failed one included",
    same: {
      reports: [
        [
          { name: "eo", status: "connected" },
          { name: "github", status: "failed" },
        ],
      ],
      beforeTheAgentSpoke: true,
    },
  },
  {
    name: "search interception",
    what: "a broad search the one classifier flags is recorded between the call it fired on and that call's result",
    same: {
      around: ["tool_call", "search_interception", "tool_result"],
      joinedToTheCall: true,
      interception: { tool: "Bash", kind: "symbol", needle: "x", suggestion: "use the index" },
      outcome: { kind: "result", data: "done" },
    },
  },
  {
    name: "secrets reaching servers",
    what: "an attached server is handed to the backend told to read its declared secret from the environment, the value is there under that name, and it is nowhere the arguments can be read",
    same: { server: "github", serverHandedToTheBackend: true, serverReads: ["GITHUB_TOKEN"], whatItFindsThere: [true], keepsWhatItInherits: true, inTheArguments: false, inTheServerConfiguration: false },
  },
  {
    name: "optional answer fields",
    what: "an agent that leaves an optional field out of its answer hands EO an answer without it",
    same: { outcome: { kind: "result", data: { verdict: "approve" } } },
  },
  {
    name: "answer schemas sendable",
    what: "every action's answer schema reaches the backend in a form that backend takes, and an answer that sets a map is read as that map",
    same: {
      refused: [],
      answer: {
        valid: true,
        stepInputs: { ciWaitSeconds: 2400, branch: "main", squash: true },
        moduleInputs: { ciWaitSeconds: { type: "number", description: "How long to wait for the checks.", default: 1800 }, branch: { type: "string", default: "main" } },
        stepSettings: [{ timeoutMs: 3_480_000, watch: "off", workspaceId: "none", workspaceMode: "read" }, { timeoutMs: "default" }],
        requiresComment: true,
        pipeline: {
          name: "Release",
          icon: "workflow",
          restoredFrom: 3,
          // A draft is how the assistant sets a pipeline's entry rules (EO-610).
          entryRules: [{ kind: "field", field: "customer", types: ["developer:story"], message: "the customer's name" }, { kind: "description" }],
        },
      },
    },
  },
  {
    name: "assistant cards",
    what:
      "an `assist` answer offering something only a person may do — export, import or delete a pipeline, discard this machine's edits to one, " +
      "let its webhook items through unread, set or clear a step's own secret or variable, add, change or remove an item type, " +
      "keep a pipeline as it is and skip its held template update, or publish a draft as it was tested (EO-588) — " +
      "reads back as that card and nothing beside it",
    same: {
      read: [
        { valid: true, card: { kind: "pipelineExport", pipelineId: "release" }, besideIt: [] },
        { valid: true, card: { kind: "pipelineImport", attachmentId: "019a0000-0000-7000-8000-000000000521" }, besideIt: [] },
        { valid: true, card: { kind: "pipelineDelete", pipelineId: "release" }, besideIt: [] },
        { valid: true, card: { kind: "pipelineDiscardEdits", pipelineId: "release" }, besideIt: [] },
        // The settings that are a person's (EO-522): no value travels in either backend's card.
        { valid: true, card: { kind: "pipelineWebhookUnattended", pipelineId: "release", unattended: true }, besideIt: [] },
        { valid: true, card: { kind: "stepSecret", stepId: "release-deploy", name: "DEPLOY_TOKEN", action: "set" }, besideIt: [] },
        { valid: true, card: { kind: "stepVariable", stepId: "release-deploy", name: "REGION", action: "clear" }, besideIt: [] },
        // A project's item types (EO-523): what a change leaves alone is null on both backends.
        {
          valid: true,
          card: { kind: "itemTypeCreate", projectId: "payments", label: "Case", plural: "Cases", container: false, fields: [{ name: "customer", kind: "string", required: true }] },
          besideIt: [],
        },
        { valid: true, card: { kind: "itemTypeUpdate", itemTypeId: "case", label: "Request", plural: "Requests", container: null, fields: null }, besideIt: [] },
        { valid: true, card: { kind: "itemTypeDelete", itemTypeId: "case" }, besideIt: [] },
        // Keeping one's own pipeline, skipping a held template update (EO-534).
        { valid: true, card: { kind: "pipelineKeepMine", pipelineId: "release" }, besideIt: [] },
        // The publish card after a draft's trials (EO-588).
        { valid: true, card: { kind: "trialPublish" }, besideIt: [] },
      ],
    },
  },
  {
    name: "a trial plan beside a draft",
    what:
      "an `assist` answer planning a test with real runs (EO-587) — test items, where each must end, and each step's mode with its reason — " +
      "reads back as the same plan beside the same draft, with what the agent left unsaid filled in alike",
    same: {
      read: {
        valid: true,
        steps: ["merge", "done"],
        trial: {
          items: [
            { key: "green", title: "Merge a green branch", body: null, type: null, workspaceId: null, expected: { stepId: "done", criteria: "the branch is on main" } },
            { key: "red", title: "Merge a red branch", body: "Its checks fail.", type: "story", workspaceId: null, expected: { stepId: "done", criteria: null } },
          ],
          steps: [
            {
              stepId: "merge",
              mode: "mocked",
              reason: "It merges into main, which reaches outside EO.",
              mocks: [
                { item: "green", resultKey: "merged", output: "Merged." },
                { item: "red", resultKey: "merged", output: "Merged anyway." },
              ],
            },
          ],
        },
      },
    },
  },
  {
    name: "reading a held template update",
    what:
      "a system agent's call to pipeline_update_conflict on EO's administrative server (EO-534) — `mcp__eo_admin__pipeline_update_conflict` on Claude, " +
      "`eo_admin/pipeline_update_conflict` on Codex — is read by EO as that one read-only tool, with the pipeline it asked about, and its answer is recorded joined to the call",
    same: {
      offered: { kind: "read", readOnly: true },
      readAs: "pipeline_update_conflict",
      args: { pipelineId: "default" },
      answers: [{ joinedToTheCall: true, toldWhatEoSaid: true }],
      outcome: { kind: "result", data: "done" },
    },
  },
  {
    name: "cost reported",
    what: "a turn's usage carries what it cost in cents, which is what the budgets are denominated in",
    same: { priced: true, unpriced: false },
  },
  {
    name: "instructions outside the user turn",
    what: "the agent's instructions are handed to the backend as the thread's system prompt, the first user turn is the dispatch context without them, and a resumed turn is sent none",
    same: { asTheSystemPrompt: "You are the implementer.", firstUserTurn: "EO-1: do the thing", sentAgainOnResume: false, resumedUserTurn: "the human replied" },
  },
  {
    name: "debug capture",
    what: "what EO hands the adapter is recorded from above it: the instructions and the prompt are the bytes the backend then received, the prompt naming the skill the backend's Skills section names and no attached skill the backend could not deliver (EO-602), a resumed turn records none sent, the session is described by name without one secret value, and an agent with no model named has the backend's own choice reported on the thread",
    same: {
      instructions: "You are the implementer.",
      instructionsAreWhatTheBackendGot: true,
      prompt: "EO-1: do the thing",
      promptIsWhatTheBackendGot: true,
      skillsNamedInThePrompt: ["house-style"],
      startedThread: { mode: "new", threadId: null },
      resumedThread: { mode: "resumed", threadId: "thr-persisted" },
      instructionsSentOnResume: false,
      resumedPrompt: "the human replied",
      resumedPromptIsWhatTheBackendGot: true,
      describesItsSession: true,
      namesItsInstructionsSlot: true,
      model: "model-under-test",
      modelIsWhatTheBackendGot: true,
      namesItsSandboxOrApprovalPolicy: true,
      servers: ["github", "repo"],
      serversAreTheOnesHandedOver: true,
      secretRecorded: false,
      whenNoModelIsNamed: { recordedAsNamed: null, reportedByTheBackend: "the-backends-default", reportedOnResumeToo: "the-backends-default" },
    },
  },
  {
    name: "attaching files",
    what: "on a turn of a run with a workspace directory the `eo` server the backend is told to start lists attachment_add, on a start and on a resume alike, and on a turn without one it does not; a call is recorded under the tool's bare name with its arguments, and the tool's answer is recorded joined to it by the call's id",
    same: {
      listedWithADirectory: true,
      listedOnResume: true,
      listedWithout: false,
      call: { name: "attachment_add", args: { paths: ["shot.png"], caption: "The screen." } },
      answers: [{ joinedToTheCall: true }, { joinedToTheCall: true }],
      outcome: { kind: "result", data: "done" },
    },
  },
  {
    name: "role-defined action schema",
    what: "the schema EO generates from a role's own definition of an action is one the backend accepts, asks for result as exactly the declared keys and requires summary, and an answer in one of those keys comes back holding to the definition with a field the agent left out left out",
    same: {
      refused: [],
      resultKeys: ["aligned", "gaps_found"],
      requiresSummary: true,
      answer: { ok: true, value: { result: "gaps_found", summary: "The export button is missing." } },
    },
  },
  {
    name: "streaming words",
    what: "a message is passed on as it is generated, in pieces on the text stream that join to the finished message, which follows them and is the one stored",
    same: { deltas: [{ stream: "text", text: "All " }, { stream: "text", text: "done." }], finished: { type: "output", text: "All done." }, order: ["output_delta", "output_delta", "output"] },
  },
  {
    name: "reasoning on request",
    what: "only a turn told to show its reasoning asks the backend for a summary, and a summary arrives as reasoning and never as output",
    same: { shownAsked: true, hiddenAsked: false, defaultAsks: false, reasoning: ["Checking the board first."], deltas: [{ stream: "reasoning", text: "Checking the board first." }], outputs: ["Done."] },
  },
  {
    name: "warm start",
    what: "a backend started ahead of its turn is adopted by the turn it was started for, is not started twice for the same turn, and is let go — never adopted — by a turn it does not match",
    same: { startedAhead: 1, keptOne: 1, adopted: true, toldThePrompt: true, outcome: { kind: "result", data: "Hi." }, mismatchStartsAgain: 3, warmLetGo: true },
  },
  {
    name: "admin bearer per turn",
    what: "EO's administrative server's bearer is minted for each turn, fresh or resumed, reaches that turn's CLI under its name, and is let go of exactly once when the turn is over and not before — the CLI closes no session of its own on exit, so this is what keeps finished turns from filling the host's cap (EO-444)",
    same: { bearers: ["turn-bearer-1", "turn-bearer-2"], releasedBeforeTheTurnWasOver: [false, false], releasedOnceItWas: [1, 1] },
  },
  {
    name: "uploading files from the turn's directory",
    what:
      "a system agent's comment_post, work_submit_item, work_submit_plan and item_update may name files by path only inside the directory its turn runs in (EO-700, EO-704), so the bearer for EO's administrative server that each turn's CLI is launched with — fresh or resumed — is leased for that turn's own directory",
    same: { launchedWithBearerLeasedFor: ["/tmp/wt-start", "/tmp/wt-resume"] },
  },
  {
    name: "warm start under the admin bearer",
    what: "a system agent's turn adopts the process started ahead of it although the bearer minted for the turn is not the one that process was spawned with, runs under that process's bearer until it is over, and every bearer minted on the way — the warm-up's, a repeated warm-up's, the turn's own, a warm-up dropped unused — is let go of exactly once (EO-444)",
    same: { launches: 2, turnRanOnTheWarmOne: true, eachSpawnedWithAToken: true, warmBearerLetGoBeforeTheTurnWasOver: false, bearersLetGo: "each exactly once" },
  },
  {
    name: "warm start on a process that died",
    what: "a turn whose warm process stopped while it waited is opened afresh rather than failing, is told its prompt there, and lets go of both its own bearer and the dead process's",
    same: { launches: 2, toldThePrompt: true, outcome: { kind: "result", data: "Hi." }, bearersLetGo: "each exactly once" },
  },
  {
    name: "work in progress",
    what: "a tool that is still running is reported as the backend being at work — a heartbeat, never stored and never shown — so a long command is not taken for a hang, and the turn ends as it would have",
    same: { heartbeat: true, outcome: { kind: "result", data: "done" } },
  },
  {
    name: "a tool known to be running",
    what: "a tool call is known to be running from the moment it starts until it ends — before its outcome is reported, on the backend that reports one only when the call is over — so a quiet command is never taken for a silent backend, and nothing is left open after it",
    same: { openWhileRunning: true, closedAfter: true },
  },
  {
    name: "compaction reported",
    what: "the backend compacting the conversation mid-turn is reported as a compaction, once, and the turn goes on to end as it would have",
    same: { compactions: 1, outcome: { kind: "result", data: "done" } },
  },
  {
    name: "a turn held to its budget",
    what: "a turn given a budget is held to it while it runs — the cap handed to the backend, or the running spend watched — and, reaching it, ends as a budget stop with what it spent recorded rather than as a failure",
    same: { heldWhileRunning: true, budgetStop: true, spendRecorded: true, failedOtherwise: false },
  },
  {
    name: "a retry announced",
    what: "a request to the model that the backend is trying again is reported as a retry, saying what went wrong, and does not end the turn",
    same: { retrying: true, saysWhy: true, failed: false, outcome: { kind: "result", data: "done" } },
  },
  {
    name: "unread turn",
    what: "a turn cancelled before anything has read it holds no bearer afterwards, whether or not one was minted for it",
    same: { bearersHeld: 0 },
  },
  {
    name: "backend memory off",
    what: "every turn is launched with the backend's own memory switched off by a setting EO passes, not left to the CLI's default — locked down or on the person's own setup, starting or resuming",
    same: { started: true, resumed: true, onTheirOwnSetup: true },
  },
  {
    name: "scoped skills",
    what: "a run on project P whose step works in workspace W is given the agent's global skills, P's and W's, and no skill scoped to another project or workspace — offered to the model, named in the prompt of the turn that opens the thread (EO-602), written where the backend reads them, and again on a resumed turn",
    same: {
      offered: ["build-in-w", "e2e-for-p", "house-style"],
      named: ["build-in-w", "e2e-for-p", "house-style"],
      written: ["build-in-w", "e2e-for-p", "house-style"],
      resumed: ["build-in-w", "e2e-for-p", "house-style"],
    },
  },
  {
    name: "a side call returns structured output",
    what: "a side call (EO-477) answers its one question in the schema's shape, with no tools, no MCP servers and no thread kept to resume, in the empty directory it was given and under EO's lockdown — however much the provider it runs on was given as an agent",
    same: {
      outcome: { kind: "result", data: { picked: ["e1"] } },
      toolsOff: true,
      noServers: true,
      keepsNoThread: true,
      inTheDirectoryGiven: true,
      lockedDown: true,
    },
  },
  {
    name: "a side call streams its answer's words",
    what: "a side call (EO-577) passes on the words of its answer as they are written, in pieces on the text stream that join to the answer it then returns — what EO counts against the call's output-token cap to cut off an answer running away, so the cap holds on either backend",
    same: { deltas: [{ stream: "text", text: '{"picked":' }, { stream: "text", text: '["e1"]}' }], outcome: { kind: "result", data: { picked: ["e1"] } } },
  },
  {
    name: "a side call wound down reports what it spent",
    what: "a side call asked to wind down mid-answer (EO-577), as EO asks one that ran past its output-token cap, interrupts the backend rather than killing it, and passes on the usage the end of its turn reports before its stream ends — so the tokens of an answer cut off are recorded, not lost with the process",
    same: { interrupted: true, killed: false, spent: { tokensOut: 2_100 }, answered: false },
  },
  {
    name: "a side call on a chosen model and reasoning effort",
    what: "a side call handed a model and a reasoning effort (EO-578) — consolidation's, from the system agent — runs on that model and asks for that effort in the backend's own option, and one handed no effort asks for none, whatever effort the provider was configured with as an agent",
    same: {
      outcome: { kind: "result", data: { picked: ["e1"] } },
      model: "the-big-one",
      reasoningEffort: "high",
      withoutEffort: null,
    },
  },
  {
    name: "memory delivery and memory_read",
    what: "a turn EO delivered memory to (EO-478) carries the memory section in its first user turn word for word, and the `eo` server it is told to start lists memory_read for exactly the scopes it was given, on a start and on a resume alike; a turn given no scopes is not offered the tool",
    same: {
      sectionSent: true,
      listedOnStart: true,
      listedOnResume: true,
      scopesGiven: ["project-p", "workspace-w"],
      listedWithout: false,
    },
  },
  {
    name: "memory_note",
    what: "for an agent granted memory_note (EO-479), the `eo` server the backend is told to start lists it on a turn given memory scopes, on a start and on a resume alike, and not for an agent without the grant, and lists it taking `replaces`, the entries a note supersedes (EO-594), and the agent is told the active entries closest to its note in EO's answer (EO-611); the turn carries EO's memory-writing block (EO-593) in its first user turn word for word, though no scope holds an entry, naming the tool as the memory section names memory_read and saying when a note names what it replaces; a call is recorded under the tool's bare name with its arguments, `replaces` included, and the tool's answer is recorded joined to it by the call's id",
    same: {
      blockSent: true,
      blockNamesTheTool: true,
      blockExplainsReplaces: true,
      listedWhenGranted: true,
      listedOnResume: true,
      listedWithoutTheGrant: false,
      takesReplaces: true,
      call: { name: "memory_note", args: { scope: "project", text: "Run pnpm install before the tests.", replaces: ["m-0"] } },
      answers: [{ joinedToTheCall: true }, { joinedToTheCall: true }],
      toldTheClosest: true,
      outcome: { kind: "result", data: "done" },
    },
  },
  {
    name: "memory used in an answer",
    what: "the implement and review answer schemas a backend is sent carry the optional memoryUsed list (EO-597) — once on implement, and on each of review's three verdicts — and an answer listing the entries it relied on hands EO the list as the agent wrote it, while one that leaves it out (as null, where the backend's strict schema needs every key) hands EO an answer without it",
    same: {
      sentWith: { implement: 1, review: 3 },
      implement: { kind: "result", data: { outcome: { ...IMPLEMENT_ANSWER, memoryUsed: ["m-1"] } } },
      review: { kind: "result", data: { outcome: { ...REVIEW_ANSWER, memoryUsed: ["m-1", "m-2"] } } },
      leftOut: { kind: "result", data: { outcome: IMPLEMENT_ANSWER } },
      reviewLeftOut: { kind: "result", data: { outcome: REVIEW_ANSWER } },
    },
  },
  {
    name: "agent writes through EO",
    what: "a comment, an attachment_add, a memory_note and a repository_checkout an agent makes reach EO over the agent write bridge from the `eo` server the backend is told to start — the arguments as the agent wrote them, under the turn's credential — and the agent is told what EO answered, whether the backend hands a tool's result back as its text (as Codex does) or as its structuredContent (as Claude Code does) (EO-543)",
    same: {
      text: AGENT_WRITES_HOLD,
      structured: AGENT_WRITES_HOLD,
    },
  },
  {
    name: "repository_checkout",
    what: "a working agent's prompt names repository_checkout in the spelling every eo tool in it has, under one repository and under several (EO-633); the `eo` server the backend is told to start lists it on a turn with a write bridge, on a start and on a resume alike, and not on a turn without one; a call reaches EO over the bridge with the agent's arguments, a refusal is the tool's error in EO's sentence, and the transcript records each call under the tool's bare name with the answer the agent was told joined to it",
    same: {
      promptNamesTheTool: { one: true, several: true },
      listedWithABridge: true,
      listedOnResume: true,
      listedWithout: false,
      reachedEo: [
        { tool: "repository_checkout", args: { repository: "web", branch: "release/2.4" } },
        { tool: "repository_checkout", args: { repository: "web", branch: "nowhere" } },
      ],
      refusedAsTheToolsError: true,
      recorded: [
        { name: "repository_checkout", args: { repository: "web", branch: "release/2.4" } },
        { name: "repository_checkout", args: { repository: "web", branch: "nowhere" } },
      ],
      toldWhatEoSaid: [true, true],
      outcome: { kind: "result", data: "done" },
    },
  },
  {
    name: "environment variables",
    what: "a run's environment variables are in the CLI's environment, an edited value reaches the next spawn of the same provider, and none displaces a name EO sets for the run",
    same: {
      regions: ["eu-west-1", "us-east-2", null],
      resumedSees: "us-east-2",
      protoNamedArrives: true,
      overWhatItInherits: true,
      eoKeepsItsOwn: { PATH: true, HOME: true, backendCredentialOrHome: true, adminBearer: true, attachedServerValue: true, searchHook: true },
      // A redirected step on a trial (EO-584): a name withheld from the
      // turn is in neither layer the CLI would read it from, inherited or
      // given, while the rest of what it inherits is still there.
      withheld: { inheritedGone: true, givenGone: true, restInherited: true },
    },
  },
  {
    name: "a resumed run's own usage",
    what: "a thread's second run, resumed, is recorded with only the tokens and cost it spent itself, whatever the backend's readings carry over from the first run",
    same: {
      firstRun: { tokensIn: 1_000_000, tokensOut: 100_000 },
      secondRun: { tokensIn: 300_000, tokensOut: 20_000 },
      secondChargedOnlyItsOwn: true,
    },
  },
  {
    name: "environment variables filling server names",
    what: "a delivered server's declared name with no secret behind it is filled from the run's environment variables, the step's over the shared; a server's own secret beats a variable and an organisation secret beats both; an organisation value that cannot be read is stood in for by nothing",
    same: {
      serverReads: ["REGION", "ZONE", "OWN", "ORG", "LOCKED"],
      onTheStep: { REGION: "eu-west-1", ZONE: "zone-of-the-step", OWN: "the-servers-own", ORG: "the-organisations", LOCKED: null },
      onAnotherStep: { REGION: "eu-west-1", ZONE: "zone-shared", OWN: "the-servers-own", ORG: "the-organisations", LOCKED: null },
    },
  },
  {
    name: "a turn EO stops reading is ended",
    what: "once EO stops reading a turn — its result read, or the turn abandoned mid-way for a correction — the turn's process is terminated, SIGKILL after a grace if SIGTERM is not enough, and has exited by the time EO's return() settles, so the next turn on the thread is never spawned beside it; and one still there after all of that is reported as a turn that did not end, never as one that did (EO-493)",
    same: { outcome: { kind: "result", data: "done" }, goneOnceReadPastItsResult: true, goneOnceAbandonedMidTurn: true, aSurvivorIsReported: true },
  },
  {
    name: "a turn's whole process tree is ended",
    what: "once a turn ends — its result read, or the run cancelled mid-way — everything the agent's process started is gone with it, not only that one process: a `setsid sleep 600` backgrounded from a shell that has since exited, which belongs to pid 1 by then; a `setsid sleep 600` started with an environment of its own, as Codex starts an MCP server; and, where agents are contained in a cgroup of their own, an `env -i … setsid sleep 600` backgrounded from a shell that has exited, which nothing but the cgroup says is the agent's (EO-494)",
    same: { outcome: { kind: "result", data: "done" }, goneOnceReadPastItsResult: true, goneOnceCancelled: true },
  },
] as const;

type CapabilityName = (typeof CAPABILITIES)[number]["name"];
type Backend = "claude" | "codex";
/** Drives one adapter, against its stub, to the observation the list asks for. */
type Proof = () => Promise<unknown>;

// ───────────────────────────── shared ─────────────────────────────

const startOpts = { instructions: "You are the implementer.", context: "EO-1: do the thing", cwd: "/tmp/wt", signal: new AbortController().signal };
/** One side call's question (EO-477), the same for both backends. */
const sideCallOpts = {
  model: "the-small-one",
  system: "Pick the entries that bear on the task.",
  input: "Which of these matter?",
  outputSchema: { type: "object", properties: { picked: { type: "array", items: { type: "string" } } }, required: ["picked"] },
  cwd: "/tmp/eo-side-call-parity",
  signal: new AbortController().signal,
};

/**
 * One agent's attached skills, five scopes deep, and the run they are
 * narrowed for (EO-470): on project P, its step working in workspace W.
 */
const SCOPED_RUN = { projectId: "project-p", workspaceId: "workspace-w" };
function scopedSkill(slug: string, scope: SkillScope): Skill {
  return {
    id: `skill-${slug}`,
    slug,
    name: slug,
    description: `How to ${slug}.`,
    body: `# ${slug}\n`,
    files: [],
    disableModelInvocation: false,
    enabled: true,
    scope,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };
}
const SCOPED_SKILLS: Skill[] = [
  scopedSkill("house-style", { kind: "global" }),
  scopedSkill("e2e-for-p", { kind: "project", projectId: "project-p" }),
  scopedSkill("e2e-for-q", { kind: "project", projectId: "project-q" }),
  scopedSkill("build-in-w", { kind: "workspace", workspaceId: "workspace-w" }),
  scopedSkill("build-in-v", { kind: "workspace", workspaceId: "workspace-v" }),
];
/** The skill folders under a directory, by slug — the files a backend finds. */
const skillFolders = (directory: string): string[] =>
  existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];

/** Lets a fire-and-forget warm-up get as far as it gets in a few turns of the loop. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Polls until `ready` holds, for a warm-up that has to reach a child process. */
async function until(ready: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Whether a process is gone. */
const gone = (pid: number | undefined) => {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

/**
 * Reads a turn as the supervisor does — up to the event it stops on —
 * then stops reading, and settles once the adapter has let go of it.
 */
async function readUntil(stream: AsyncIterable<AgentEvent>, stop: (event: AgentEvent) => boolean): Promise<Outcome> {
  const iterator = stream[Symbol.asyncIterator]();
  let outcome: Outcome = { kind: "none" };
  for (;;) {
    const step = await iterator.next();
    if (step.done) break;
    if (step.value.type === "result") outcome = { kind: "result", data: step.value.data };
    if (stop(step.value)) break;
  }
  await iterator.return?.(undefined);
  return outcome;
}

/**
 * Reads a turn up to its first `output`, stops reading, and says whether
 * the adapter reported the turn as not ended — then ends whatever it
 * could not, so nothing outlives the case.
 */
async function survivorReported(stream: AsyncIterable<AgentEvent>, pids: () => (number | undefined)[]): Promise<boolean> {
  // A process nothing EO sends reaches is staged by taking its handle's
  // `kill` away; on Windows, taskkill reaches it whatever its handle
  // does, so that is taken away too.
  const taskkill = vi.spyOn(windowsTreeKill, "run").mockResolvedValue(false);
  try {
    const failed = await readUntil(stream, (event) => event.type === "output").then(
      () => null,
      (error: unknown) => error,
    );
    return isTurnNotEnded(failed) && failed.pids.length > 0 && failed.pids.every((pid) => pids().includes(pid));
  } finally {
    taskkill.mockRestore();
    for (const pid of pids()) if (pid !== undefined && !gone(pid)) process.kill(pid, "SIGKILL");
  }
}

/**
 * Reads a turn up to its first `output`, then cancels it as the
 * supervisor does a run: the signal aborted, a moment for the backend to
 * end the stream on its own, and then no more reading.
 */
async function cancelAfterOutput(stream: AsyncIterable<AgentEvent>, controller: AbortController): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done) return;
      if (step.value.type === "output") break;
    }
    controller.abort();
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) {
      const step = await Promise.race([iterator.next(), new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())))]);
      if (step === null || step.done) break;
    }
  } catch {
    // A cancelled turn may end in an error; what is asked is what is left running.
  } finally {
    await iterator.return?.(undefined).catch(() => undefined);
  }
}

/** A file for a stand-in agent to write its descendants' pids to (`escapingDescendants.ts`). */
const pidFile = () => join(scratchDirectory(), "descendants");

/**
 * Whether the agent and its descendants are gone, once given a moment —
 * every one of them where agents are contained, which is Linux here and
 * in CI (`owed`); ends them either way.
 */
async function treeGone(agentPids: readonly (number | undefined)[], file: string): Promise<boolean> {
  const descendants = await descendantPids(file);
  const agents = agentPids.filter((pid): pid is number => pid !== undefined);
  try {
    return await allGone([...agents, ...owed(descendants)], 1_000);
  } finally {
    sweepUp([...agents, ...descendants.values()]);
  }
}

/**
 * A side call wound down as soon as its answer starts (EO-577): whether
 * the backend was interrupted, whether EO had to kill it, what the end of
 * its turn said it spent, and whether it answered anyway.
 */
async function windingDown(provider: AgentProvider, interrupted: () => boolean) {
  const windDown = new AbortController();
  const signal = new AbortController();
  const events: AgentEvent[] = [];
  for await (const event of provider.sideCall!({ ...sideCallOpts, signal: signal.signal, windDown: windDown.signal })) {
    events.push(event);
    if (event.type === "output_delta") windDown.abort();
  }
  const usage = events.filter((event) => event.type === "usage").at(-1);
  return {
    interrupted: interrupted(),
    killed: signal.signal.aborted,
    spent: usage?.type === "usage" ? { tokensOut: usage.tokensOut } : null,
    answered: events.some((event) => event.type === "result"),
  };
}

/** What a person watching a streamed message sees, and what is stored after it. */
function streamed(events: readonly AgentEvent[]) {
  const written = events.filter((event) => event.type === "output_delta" || event.type === "output");
  const finished = written.find((event) => event.type === "output");
  return {
    deltas: written.flatMap((event) => (event.type === "output_delta" ? [{ stream: event.stream, text: event.text }] : [])),
    finished: finished?.type === "output" ? { type: finished.type, text: finished.text } : null,
    order: written.map((event) => event.type),
  };
}

/** The reasoning a turn reported, streamed and stored, and what it said as output. */
function reasoned(events: readonly AgentEvent[]) {
  return {
    reasoning: events.flatMap((event) => (event.type === "reasoning" ? [event.text] : [])),
    deltas: events.flatMap((event) => (event.type === "output_delta" ? [{ stream: event.stream, text: event.text }] : [])),
    outputs: events.flatMap((event) => (event.type === "output" ? [event.text] : [])),
  };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

async function thrownBy(stream: AsyncIterable<AgentEvent>): Promise<unknown> {
  try {
    await collect(stream);
  } catch (error) {
    return error;
  }
  throw new Error("expected the stream to throw");
}

const types = (events: readonly AgentEvent[]): string[] => events.map((event) => event.type);

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "eo-provider-parity-"));
  scratch.push(directory);
  return directory;
}

function lostThread(backend: Backend, lost: unknown, other: unknown): unknown {
  return {
    threadNotFound: isThreadNotFound(lost),
    threadId: (lost as ThreadNotFoundError).threadId,
    namesItsBackend: (lost as ThreadNotFoundError).provider === backend,
    anotherFailureIsLost: isThreadNotFound(other),
  };
}

/** Everything from the event after `from` through the first error: how an interrupted turn winds down. */
function windDown(events: readonly AgentEvent[], from: AgentEvent["type"]): unknown {
  const tail = events.slice(events.findIndex((event) => event.type === from) + 1);
  const through = tail.slice(0, tail.findIndex((event) => event.type === "error") + 1);
  const usage = through.find((event) => event.type === "usage");
  const error = through.find((event) => event.type === "error");
  return {
    windDown: types(through),
    tokensCounted: usage?.type === "usage" && usage.tokensIn > 0 && usage.tokensOut > 0,
    retryable: error?.type === "error" && error.retryable,
  };
}

function quotaReadings(backend: Backend, events: readonly AgentEvent[]): unknown {
  return {
    readings: events.flatMap((event) =>
      event.type !== "quota"
        ? []
        : [
            {
              ownBackend: event.provider === backend,
              // The windows are named by each backend's own scheme —
              // `five_hour` and `5_hour` — and a reading is kept per
              // provider, so the name is the backend's to choose. That it
              // is named at all is what the two share.
              windowNamed: event.window !== "" && event.window !== "unknown",
              utilization: event.utilization,
              status: event.status,
              resetsAt: event.resetsAt,
            },
          ],
    ),
  };
}

function serverReports(events: readonly AgentEvent[]): unknown {
  return {
    reports: events.flatMap((event) =>
      event.type !== "server_status"
        ? []
        : // Claude registers a plugin-delivered server as
          // `plugin:<plugin>:<server>`; the last segment is the name a
          // person attached it under, which is the name Codex uses.
          [event.servers.map((server) => ({ name: server.name.split(":").at(-1), status: server.status }))],
    ),
    beforeTheAgentSpoke: events.findIndex((event) => event.type === "server_status") < events.findIndex((event) => event.type === "output"),
  };
}

function interception(events: readonly AgentEvent[]): unknown {
  const at = events.findIndex((event) => event.type === "search_interception");
  const around = events.slice(Math.max(at - 1, 0), at + 2);
  const fired = events[at];
  const ids = around.map((event) => ("callId" in event ? event.callId : undefined));
  return {
    around: types(around),
    joinedToTheCall: ids.every((id) => typeof id === "string" && id === ids[0]),
    interception: fired?.type === "search_interception" ? { tool: fired.tool, kind: fired.kind, needle: fired.needle, suggestion: fired.suggestion } : null,
    outcome: outcomeOf(events),
  };
}

const ATTACH_FROM = { runId: "018f0000-0000-7000-8000-000000000412", directory: "/tmp/wt" };
const ATTACH_ARGS = { paths: ["shot.png"], caption: "The screen." };
const ATTACH_ACCEPTED = "EO attached this file to the ticket in one comment (c-1):\n- shot.png — attachment a-1";
const ATTACH_REFUSED = 'ATTACHMENT_REFUSED: Nothing was attached. "gone.png" does not exist.';

/**
 * Whether the `eo` server lists `attachment_add`, given the environment
 * a backend was told to start it with.
 *
 * The real service, built from that environment and asked for its list —
 * so this is the tool an agent would be shown, rather than a reading of
 * two variable names that the service might or might not agree with.
 */
function listsAttachmentAdd(env: Record<string, string> | undefined): boolean {
  const started = (createEoMcpService as (options: Record<string, unknown>) => { tools: { name: string }[]; close(): void })({
    dbPath: undefined,
    runId: env?.["EO_MCP_RUN_ID"] ?? null,
    runDirectory: env?.["EO_MCP_RUN_DIRECTORY"] ?? null,
  });
  try {
    return started.tools.some((tool) => tool.name === ATTACHMENT_ADD_TOOL_NAME);
  } finally {
    started.close();
  }
}

/** One turn's memory (EO-478): the section, rendered by the one renderer both backends' turns are given, and the scopes `memory_read` is told. */
const MEMORY_SCOPES = [
  { kind: "project", id: "project-p", name: "Payments" },
  { kind: "workspace", id: "workspace-w", name: "api" },
] as const;
const MEMORY_SECTION = renderMemorySection({
  scopes: MEMORY_SCOPES.map(({ kind, id, name }) => ({ scope: { kind, id }, name })),
  candidates: [
    { id: "m1", scope: { kind: "project", id: "project-p" }, body: "Settlements are in UTC.", source: { type: "person", personId: null }, createdAt: 0, updatedAt: 0, retiredAt: null, retiredReason: null, consolidationId: null, contradictsRepositoryFile: false },
  ],
  choice: { delivered: [], mode: "all", selectionRan: false, reason: null },
  now: 12 * 24 * 60 * 60 * 1000,
})!;
const MEMORY_CONTEXT = `${startOpts.context}\n\n${MEMORY_SECTION}`;
/**
 * The memory-writing block (EO-593), as the supervisor appends it to a
 * turn served `memory_note`: rendered by the one renderer, for the same
 * scopes, with no entry in either — so the turn has no memory section,
 * and the block still goes.
 */
const MEMORY_WRITING = renderMemoryWritingSection(MEMORY_SCOPES.map(({ kind, id, name }) => ({ scope: { kind, id }, name })))!;
const MEMORY_WRITING_CONTEXT = `${startOpts.context}\n\n${MEMORY_WRITING}`;

/** Whether the `eo` server lists `memory_read`, and for which scopes, given the environment a backend was told to start it with — asked of the real service. */
function memoryReadOffered(env: Record<string, string> | undefined): { listed: boolean; scopes: string[] } {
  const scopes = (parseMemoryScopes as (raw: unknown) => { id: string }[])(env?.["EO_MCP_MEMORY_SCOPES"]);
  const started = (createEoMcpService as (options: Record<string, unknown>) => { tools: { name: string }[]; close(): void })({ dbPath: undefined, memoryScopes: scopes });
  try {
    return { listed: started.tools.some((tool) => tool.name === MEMORY_READ_TOOL_NAME), scopes: scopes.map((scope) => scope.id) };
  } finally {
    started.close();
  }
}

const NOTE_ARGS = { scope: "project", text: "Run pnpm install before the tests.", replaces: ["m-0"] };
const NOTE_CLOSEST = "- `m-9`: Run pnpm install before running the tests.";
const NOTE_ACCEPTED = `EO noted this in the memory of Project: Payments (scope project-p). Later runs on other items are given it from now on. These active entries in that scope are close to it, closest first:\n${NOTE_CLOSEST}\nWhere one says the same as your note, or your note corrects it, write the note again with \`replaces\` naming that id and \`m-1\`, this note's own, so the fact is kept once.`;
const NOTE_REFUSED = 'MEMORY_NOTE_REFUSED: "workspace-v" is not a scope this run works in, so nothing was written. Use "project" or "workspace-w" (api).';

/** Whether the `eo` server lists `memory_note`, given the environment a backend was told to start it with — asked of the real service. */
function memoryNoteOffered(env: Record<string, string> | undefined): boolean {
  const scopes = (parseMemoryScopes as (raw: unknown) => unknown[])(env?.["EO_MCP_MEMORY_SCOPES"]);
  const started = (createEoMcpService as (options: Record<string, unknown>) => { tools: { name: string }[]; close(): void })({
    dbPath: undefined,
    memoryScopes: scopes,
    enableMemoryNote: env?.["EO_MCP_MEMORY_NOTE_ENABLED"] === "1",
  });
  try {
    return started.tools.some((tool) => tool.name === MEMORY_NOTE_TOOL_NAME);
  } finally {
    started.close();
  }
}

/**
 * Whether the `memory_note` the `eo` server lists takes `replaces` (EO-594),
 * given the environment a backend was told to start it with — asked of
 * the real service, so an argument one backend's server would not offer
 * is caught on that backend.
 */
function memoryNoteTakesReplaces(env: Record<string, string> | undefined): boolean {
  const scopes = (parseMemoryScopes as (raw: unknown) => unknown[])(env?.["EO_MCP_MEMORY_SCOPES"]);
  const started = (createEoMcpService as (options: Record<string, unknown>) => { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[]; close(): void })({
    dbPath: undefined,
    memoryScopes: scopes,
    enableMemoryNote: env?.["EO_MCP_MEMORY_NOTE_ENABLED"] === "1",
  });
  try {
    return started.tools.find((tool) => tool.name === MEMORY_NOTE_TOOL_NAME)?.inputSchema.properties?.[MEMORY_NOTE_REPLACES] !== undefined;
  } finally {
    started.close();
  }
}

/** Whether a turn's first user message says when a note names the entries it replaces (EO-594), in the block's own words. */
function explainsReplaces(said: string | null | undefined): boolean {
  return said?.includes(`names that entry's id in \`${MEMORY_NOTE_REPLACES}\``) === true && MEMORY_WRITING.includes(`\`${MEMORY_NOTE_REPLACES}\``);
}

/**
 * `memory_note` calls and their answers as the transcript records them:
 * the call under the tool's bare name, the answer joined to it by id.
 * Recorded and nothing more — the write reached EO over the bridge as the
 * call was made (EO-543), which "agent writes through EO" proves.
 */
function memoryNoteCalls(events: readonly AgentEvent[]): unknown {
  const calls = events.filter((event): event is Extract<AgentEvent, { type: "tool_call" }> => event.type === "tool_call" && event.name === MEMORY_NOTE_TOOL_NAME);
  const ids = new Set(calls.map((call) => call.callId));
  const answers = events.filter((event): event is Extract<AgentEvent, { type: "tool_result" }> => event.type === "tool_result");
  return {
    call: calls[0] ? { name: calls[0].name, args: calls[0].args } : null,
    answers: answers.map((answer) => ({ joinedToTheCall: answer.callId !== undefined && ids.has(answer.callId) })),
    toldTheClosest: answers.some((answer) => answer.output.includes(NOTE_CLOSEST)),
    outcome: outcomeOf(events),
  };
}

/** `attachment_add` calls and their answers as the transcript records them — `memoryNoteCalls`'s reading. */
function attachmentCalls(events: readonly AgentEvent[]): unknown {
  const calls = events.filter((event): event is Extract<AgentEvent, { type: "tool_call" }> => event.type === "tool_call" && event.name === ATTACHMENT_ADD_TOOL_NAME);
  const ids = new Set(calls.map((call) => call.callId));
  const answers = events.filter((event): event is Extract<AgentEvent, { type: "tool_result" }> => event.type === "tool_result");
  return {
    call: calls[0] ? { name: calls[0].name, args: calls[0].args } : null,
    answers: answers.map((answer) => ({ joinedToTheCall: answer.callId !== undefined && ids.has(answer.callId) })),
    outcome: outcomeOf(events),
  };
}

/** `repository_checkout` (EO-633): one call EO answers with a checkout, one it refuses, and the two sentences. */
const CHECKOUT_ARGS = { repository: "web", branch: "release/2.4" };
const CHECKOUT_REFUSED_ARGS = { repository: "web", branch: "nowhere" };
const CHECKOUT_MADE =
  "EO checked out `release/2.4` of web at /repos/web/.git/eo-references/EO-1/release%2F2.4, detached at 0a1b2c3: the commit `release/2.4` points to on web's remote, fetched just now.";
const CHECKOUT_REFUSAL = "web has no branch `nowhere`, on its remote `origin` or locally. Nothing was checked out.";

/** A working agent's prompt, by the one renderer both backends' turns are given, for a project of these repositories. */
function seedPrompt(repositories: ContextRepositoryInput[], repositoryName: string): string {
  return assembleSeedContext({
    action: "implement",
    item: { key: "EO-1", title: "A story", body: "Do the thing.", acceptanceCriteria: [], actionOverrides: new Map(), workspaceKind: "git" },
    sectionRenderers: [],
    dependencyKeys: [],
    stepComments: [],
    humanComments: [],
    omitted: { total: 0, byAuthorAndKind: [], attachments: [] },
    repositories,
    repositoryName,
  }).fullText;
}
const CHECKOUT_PROMPTS = {
  one: seedPrompt([{ name: "web", description: "The client" }], "web"),
  several: seedPrompt([{ name: "api", description: "The service" }, { name: "web", description: "The client" }], "api"),
};

/** Whether the `eo` server lists `repository_checkout`, given the environment a backend was told to start it with — asked of the real service. */
function listsRepositoryCheckout(env: Record<string, string> | undefined): boolean {
  const started = (createEoMcpService as (options: Record<string, unknown>) => { tools: { name: string }[]; close(): void })({
    dbPath: undefined,
    writeBridge: env?.["EO_MCP_WRITE_BRIDGE"] === undefined ? null : JSON.parse(env["EO_MCP_WRITE_BRIDGE"]),
  });
  try {
    return started.tools.some((tool) => tool.name === REPOSITORY_CHECKOUT_TOOL_NAME);
  } finally {
    started.close();
  }
}

/**
 * Drives one backend through `repository_checkout` (EO-633).
 *
 * `launch` starts a turn with the given options and hands back the
 * environment the backend was told to start the `eo` server with and the
 * first user turn it sent; `resume` does the same for a resumed turn;
 * `report` runs a turn in which the backend reports each call and the
 * answer it got. Between them the calls are made against the real
 * service built from the launched environment, so they reach EO only if
 * the adapter delivered the bridge, and what the backend reports is the
 * service's real answer.
 */
async function repositoryCheckoutIn(
  launch: (turn: Record<string, unknown>) => Promise<{ env: Record<string, string> | undefined; said: string | null }>,
  resume: (turn: Record<string, unknown>) => Promise<Record<string, string> | undefined>,
  report: (calls: { id: string; tool: string; args: unknown; result: EoToolResult }[]) => Promise<AgentEvent[]>,
): Promise<unknown> {
  const asked: AgentWriteRequest[] = [];
  const bridge = await startAgentWriteBridge(async (_itemId, request): Promise<AgentWriteAnswer> => {
    asked.push(request);
    return (request.args as { branch?: unknown }).branch === CHECKOUT_ARGS.branch
      ? { ok: true, text: CHECKOUT_MADE, data: { commit: "0a1b2c3" } }
      : { ok: false, code: "REPOSITORY_CHECKOUT_REFUSED", problem: CHECKOUT_REFUSAL };
  });
  try {
    const several = await launch({ context: CHECKOUT_PROMPTS.several, writeBridge: bridge.tokenFor("item-1") });
    const one = await launch({ context: CHECKOUT_PROMPTS.one, writeBridge: bridge.tokenFor("item-1") });
    const resumed = await resume({ writeBridge: bridge.tokenFor("item-1") });
    const without = await launch({});

    const eo = (createEoMcpService as (options: Record<string, unknown>) => { handle(request: unknown): Promise<{ result: EoToolResult }>; close(): void })({
      dbPath: undefined,
      writeBridge: several.env?.["EO_MCP_WRITE_BRIDGE"] === undefined ? null : JSON.parse(several.env["EO_MCP_WRITE_BRIDGE"]),
    });
    const calls: { id: string; tool: string; args: unknown; result: EoToolResult }[] = [];
    try {
      for (const [index, args] of [CHECKOUT_ARGS, CHECKOUT_REFUSED_ARGS].entries()) {
        const { result } = await eo.handle({ jsonrpc: "2.0", id: index, method: "tools/call", params: { name: REPOSITORY_CHECKOUT_TOOL_NAME, arguments: args } });
        calls.push({ id: `call-${String(index)}`, tool: REPOSITORY_CHECKOUT_TOOL_NAME, args, result });
      }
    } finally {
      eo.close();
    }
    const events = await report(calls);
    const recorded = events.filter((event): event is Extract<AgentEvent, { type: "tool_call" }> => event.type === "tool_call" && event.name === REPOSITORY_CHECKOUT_TOOL_NAME);
    const results = events.filter((event): event is Extract<AgentEvent, { type: "tool_result" }> => event.type === "tool_result");
    const named = `\`${eoToolName(REPOSITORY_CHECKOUT_TOOL_NAME)}\``;
    return {
      promptNamesTheTool: { one: one.said?.includes(named) === true, several: several.said?.includes(named) === true },
      listedWithABridge: listsRepositoryCheckout(several.env),
      listedOnResume: listsRepositoryCheckout(resumed),
      listedWithout: listsRepositoryCheckout(without.env),
      reachedEo: asked,
      refusedAsTheToolsError: calls[1]?.result.isError === true && textOfResult(calls[1].result) === `REPOSITORY_CHECKOUT_REFUSED: ${CHECKOUT_REFUSAL}`,
      recorded: recorded.map((call) => ({ name: call.name, args: call.args })),
      toldWhatEoSaid: [CHECKOUT_MADE, CHECKOUT_REFUSAL].map((sentence, index) => {
        const result = results.find((candidate) => candidate.callId !== undefined && candidate.callId === recorded[index]?.callId);
        return result?.output.includes(sentence) === true;
      }),
      outcome: outcomeOf(events),
    };
  } finally {
    await bridge.close();
  }
}

/** The pipeline a system agent asks about, and the start of what EO answers it (EO-534). */
const UPDATE_CONFLICT_ARGS = { pipelineId: "default" };
const UPDATE_CONFLICT_ANSWER = '"Delivery" (id: default) holds the EO\'s Delivery template\'s update (delivery) from 1.0, its base, to 1.1.';

/**
 * A call to `pipeline_update_conflict` as EO reads it out of a turn
 * (EO-534): which administrative tool the backend's spelling names, by
 * `adminToolOf` — the one reader of both spellings — what it was asked,
 * and whether the answer came back joined to it. Beside it, how the
 * catalog offers the tool: a read, and nothing else.
 */
function updateConflictCalls(events: readonly AgentEvent[]): unknown {
  const calls = events.filter((event): event is Extract<AgentEvent, { type: "tool_call" }> => event.type === "tool_call" && adminToolOf(event.name) !== null);
  const ids = new Set(calls.map((call) => call.callId));
  const answers = events.filter((event): event is Extract<AgentEvent, { type: "tool_result" }> => event.type === "tool_result");
  const tool = TOOLS.find((entry) => entry.name === "pipeline_update_conflict");
  return {
    offered: tool === undefined ? null : { kind: tool.kind, readOnly: tool.annotations?.readOnlyHint === true },
    readAs: calls[0] ? adminToolOf(calls[0].name) : null,
    args: calls[0]?.args ?? null,
    answers: answers.map((answer) => ({ joinedToTheCall: answer.callId !== undefined && ids.has(answer.callId), toldWhatEoSaid: answer.output.includes(UPDATE_CONFLICT_ANSWER) })),
    outcome: outcomeOf(events),
  };
}

function cost(events: readonly AgentEvent[]): unknown {
  const usage = events.find((event) => event.type === "usage");
  if (usage?.type !== "usage") return { priced: false, unpriced: false };
  return { priced: Number.isInteger(usage.costCents) && (usage.costCents ?? 0) > 0, unpriced: "unpriced" in usage && usage.unpriced !== undefined };
}

/**
 * What two runs on one thread are recorded as (EO-490): each run's usage
 * events through the tally the supervisor records with, the second told
 * what the first recorded, as `driveToCompletion` tells a resumed run.
 * The second run's cost is its own when it is below the first's — it
 * spent less than a third of the first run's tokens, and a figure that
 * carried the first run over would be above it.
 */
function recordedOnThread(first: readonly AgentEvent[], second: readonly AgentEvent[]) {
  const recorded = (events: readonly AgentEvent[], earlierOnThread: ThreadUsage | null) => {
    const tally = createUsageTally({ earlierOnThread });
    for (const event of events) if (event.type === "usage") tally.record(event);
    return tally.totals();
  };
  const one = recorded(first, null);
  const two = recorded(second, one);
  return {
    firstRun: { tokensIn: one.tokensIn, tokensOut: one.tokensOut },
    secondRun: { tokensIn: two.tokensIn, tokensOut: two.tokensOut },
    secondChargedOnlyItsOwn: two.costCents > 0 && two.costCents < one.costCents,
  };
}

/**
 * Every action the registry has an answer for, each with what one
 * backend said was wrong with the schema it was sent (EO-387).
 *
 * `sent` runs a turn asking for that action's answer and hands back the
 * schema that crossed to the backend. One that never crossed is a
 * refusal too: a turn dispatched without its schema is not a turn whose
 * schema was sendable.
 */
async function refusedSchemas(sent: (outputSchema: Record<string, unknown>) => Promise<unknown>, violations: (schema: unknown) => string[]): Promise<string[]> {
  const registry = developerRegistry();
  const refused: string[] = [];
  for (const action of answerActions(registry)) {
    const crossed = await sent(outputSchemaFor(registry, action)!);
    if (crossed === undefined) refused.push(`${action}: no schema reached the backend`);
    else refused.push(...violations(crossed).map((violation) => `${action} ${violation}`));
  }
  return refused;
}

const ASSIST_SCHEMA = outputSchemaFor(developerRegistry(), "assist")!;

/**
 * A role's own definition of an action, in the registry the way
 * `registryForProject` puts it there (EO-421): `qa` defines `alignment`
 * with two results and one field an answer may leave out.
 */
const QA_ALIGNMENT = {
  id: "018f0000-0000-7000-8000-000000000421",
  role: "qa",
  action: "alignment",
  description: "Check the work against what was asked for.",
  results: [
    { key: "aligned", label: "Aligned", meaning: "Everything asked for is there." },
    { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." },
  ],
  fields: { type: "object", properties: { gaps: { type: "array", items: { type: "string" } } } },
  createdAt: 1,
  updatedAt: 1,
};
const QA_REGISTRY: Registry = {
  ...developerRegistry(),
  actionDefinitions: new Map([["qa", new Map([["alignment", { definition: QA_ALIGNMENT, schema: actionDefinitionOutputSchema(QA_ALIGNMENT) }]])]]),
};
/** What a `qa` run on `alignment` is dispatched with — resolved by role, as the supervisor resolves it. */
const QA_ALIGNMENT_SCHEMA = outputSchemaFor(QA_REGISTRY, "alignment", undefined, "qa")!;
const QA_ALIGNMENT_ANSWER = { result: "gaps_found", summary: "The export button is missing." };

/**
 * What a backend was asked for and what EO made of its answer, for the
 * role-defined action.
 *
 * `crossed` is the schema as it left EO for that backend, which is not
 * the same document twice: OpenAI's strict subset requires every key and
 * spells an optional one as nullable. What has to be the same is what is
 * read off it here — the keys `result` may take and that `summary` must
 * be there — and that the answer, once back through the adapter, is one
 * the definition accepts.
 */
function definedAnswer(crossed: unknown, violations: (schema: unknown) => string[], events: readonly AgentEvent[]): unknown {
  const branches = ((crossed as { properties?: { outcome?: { anyOf?: Record<string, unknown>[] } } } | undefined)?.properties?.outcome?.anyOf ?? []) as {
    properties?: { result?: { enum?: string[] } };
    required?: string[];
  }[];
  const branch = branches.find((candidate) => candidate.properties?.result?.enum !== undefined);
  const outcome = outcomeOf(events);
  return {
    refused: crossed === undefined ? ["no schema reached the backend"] : violations(crossed),
    resultKeys: branch?.properties?.result?.enum ?? null,
    requiresSummary: branch?.required?.includes("summary") ?? false,
    answer: outcome.kind === "result" ? validateActionResult(QA_REGISTRY, "alignment", outcome.data, undefined, "qa") : outcome,
  };
}

/**
 * What EO makes of an `assist` answer that set a step's inputs and a
 * proposed module's — and the step settings, route flag and pipeline
 * fields a draft may carry (EO-520), with every key the agent left out
 * still absent rather than null.
 */
function mapsRead(events: readonly AgentEvent[]): unknown {
  const outcome = outcomeOf(events);
  const validated = validateActionResult(developerRegistry(), "assist", outcome.kind === "result" ? outcome.data : undefined);
  if (!validated.ok) return { valid: false, why: validated.error };
  const value = validated.value as {
    draft?: { steps: Record<string, unknown>[]; routes: Record<string, unknown>[]; name?: unknown; icon?: unknown; restoredFrom?: unknown; entryRules?: unknown };
    modules?: { manifest: { inputs: unknown } }[];
  };
  const settings = (step: Record<string, unknown> | undefined) =>
    Object.fromEntries(["timeoutMs", "watch", "workspaceId", "workspaceMode"].filter((key) => step !== undefined && key in step).map((key) => [key, step![key]]));
  return {
    valid: true,
    stepInputs: value.draft?.steps[0]?.["inputs"],
    moduleInputs: value.modules?.[0]?.manifest.inputs,
    stepSettings: value.draft?.steps.map(settings),
    requiresComment: value.draft?.routes[0]?.["requiresComment"],
    pipeline: { name: value.draft?.name, icon: value.draft?.icon, restoredFrom: value.draft?.restoredFrom, entryRules: value.draft?.entryRules },
  };
}

/** What EO makes of an `assist` answer planning a test (EO-587): the draft's steps, and the trial plan as validated. */
function trialRead(events: readonly AgentEvent[]): unknown {
  const outcome = outcomeOf(events);
  const validated = validateActionResult(developerRegistry(), "assist", outcome.kind === "result" ? outcome.data : undefined);
  if (!validated.ok) return { valid: false, why: validated.error };
  const value = validated.value as { draft?: { steps: { id: string }[] }; trial?: unknown };
  return { valid: true, steps: value.draft?.steps.map((step) => step.id), trial: value.trial };
}

/**
 * What EO makes of an `assist` answer offering a card (EO-521): the card
 * as validated, and which of the other cards a reply can carry came
 * with it — none, since a card comes on its own.
 */
function cardRead(events: readonly AgentEvent[]): unknown {
  const outcome = outcomeOf(events);
  const validated = validateActionResult(developerRegistry(), "assist", outcome.kind === "result" ? outcome.data : undefined);
  if (!validated.ok) return { valid: false, why: validated.error };
  const value = validated.value as Record<string, unknown>;
  const besideIt = ["draft", "modules", "actions", "change"].filter((key) => value[key] !== undefined && value[key] !== null);
  if ((value["proposals"] as unknown[] | undefined)?.length) besideIt.push("proposals");
  if ((value["questions"] as unknown[] | undefined)?.length) besideIt.push("questions");
  return { valid: true, card: value["card"], besideIt };
}

/**
 * Debug mode's capture, wrapped round an adapter the way the supervisor
 * wraps it (EO-392): one function for both backends, which is the point.
 */
function capturing(provider: AgentProvider, backend: Backend) {
  const sent: DebugSent[] = [];
  return {
    sent,
    provider: capturingProvider(provider, { backend, purpose: "dispatch", refusal: null, threadInstructions: null, outputSchemaName: "implement" }, (record) => sent.push(record)),
  };
}

/**
 * The observation for "debug capture": what was recorded, held against
 * what the backend's stub was actually handed.
 *
 * `got` is the adapter's half — read off the SDK's `query` on one
 * backend and off the app-server's launch and requests on the other.
 * Everything else is the same for both, because the capture is.
 */
function debugCapture(
  started: DebugSent | undefined,
  resumed: DebugSent | undefined,
  got: { instructions: unknown; prompt: unknown; resumedPrompt: unknown; model: unknown; servers: string[]; instructionsSlot: string },
  unnamed: { sent: DebugSent | undefined; started: readonly AgentEvent[]; resumed: readonly AgentEvent[] },
): unknown {
  /** The model the backend said the thread runs on — `thread_started`'s. */
  const reported = (events: readonly AgentEvent[]) => events.flatMap((event) => (event.type === "thread_started" ? [event.model] : []))[0];
  return {
    instructions: started?.instructions.text,
    instructionsAreWhatTheBackendGot: started?.instructions.sent === true && started.instructions.text === got.instructions,
    // The context, before the Skills section each backend words its own way.
    prompt: started?.prompt.split("\n\n")[0],
    promptIsWhatTheBackendGot: started?.prompt === got.prompt,
    // Under the name each backend's section calls a skill; the slug is what is compared.
    skillsNamedInThePrompt: [...(started?.prompt ?? "").matchAll(/^- `(?:eo-attachments:)?([a-z0-9-]+)` — /gm)].map((match) => match[1]),
    startedThread: { mode: started?.thread.mode, threadId: started?.thread.threadId },
    resumedThread: { mode: resumed?.thread.mode, threadId: resumed?.thread.threadId },
    instructionsSentOnResume: resumed?.instructions.sent,
    resumedPrompt: resumed?.prompt,
    resumedPromptIsWhatTheBackendGot: resumed?.prompt === got.resumedPrompt,
    describesItsSession: started?.session.described === true && resumed?.session.described === true,
    namesItsInstructionsSlot: started?.session.instructionsSlot === got.instructionsSlot,
    model: started?.session.model,
    modelIsWhatTheBackendGot: started?.session.model === got.model,
    namesItsSandboxOrApprovalPolicy: (started?.session.policy.length ?? 0) > 0 && started?.session.policy.every((entry) => entry.value !== ""),
    // Sorted: the order servers are registered in is each backend's own.
    servers: [...(started?.session.mcpServers ?? [])].sort(),
    serversAreTheOnesHandedOver: JSON.stringify([...(started?.session.mcpServers ?? [])].sort()) === JSON.stringify([...got.servers].sort()),
    secretRecorded: JSON.stringify([started, resumed]).includes(SECRET),
    // The case "the model actually used" turns on (EO-392): EO names
    // none, so the record of the send has none to give, and the only
    // statement of which model answered is the backend's own.
    whenNoModelIsNamed: { recordedAsNamed: unnamed.sent?.session.model, reportedByTheBackend: reported(unnamed.started), reportedOnResumeToo: reported(unnamed.resumed) },
  };
}

/** One judgement for both backends, as there is one classifier: every call it is asked about is a broad search for `x`. */
const alwaysNudge: SearchNudge = async () => ({ kind: "symbol", needle: "x", nudge: "use the index" });

/** An index that names its tools and can be asked what it holds — what makes a nudge worth giving (EO-173). */
const repositoryMcp = {
  name: "repo",
  command: "/opt/eo/index-tool",
  args: ["serve", "--mcp"],
  env: {},
  answers: { symbol: "idx_symbol", area: "idx_area", reach: ["idx_callers"], files: "idx_files" },
  knows: async () => [],
};

const SEARCH = { command: "grep -rn x ." };

/** The index server again, this time carrying a value in its environment that must not be written down. */
const repositoryMcpWithSecret = { ...repositoryMcp, env: { INDEX_TOKEN: SECRET } };

/**
 * EO's administrative server as a host that mints a bearer per turn
 * (EO-444), and the record of what was minted and let go of.
 */
/**
 * Bearers leased for a directory (EO-700): each minted bearer remembers
 * the directory it was asked for, so a launch can be read back as the
 * directory its bearer was leased for.
 */
function directoryLeases() {
  const leasedFor = new Map<string, string | undefined>();
  const admin = (directory?: string) => {
    const token = `turn-bearer-${leasedFor.size + 1}`;
    leasedFor.set(token, directory);
    return { server: { url: "http://127.0.0.1:9/mcp", envName: "EO_ADMIN_TOKEN" }, environment: { EO_ADMIN_TOKEN: token }, release: () => {} };
  };
  const observation = (bearers: (string | undefined)[]) => ({ launchedWithBearerLeasedFor: bearers.map((bearer) => (bearer === undefined ? null : (leasedFor.get(bearer) ?? null))) });
  return { admin, observation };
}

function adminLeases() {
  let minted = 0;
  let released = 0;
  const admin = () => {
    minted += 1;
    return { server: { url: "http://127.0.0.1:9/mcp", envName: "EO_ADMIN_TOKEN" }, environment: { EO_ADMIN_TOKEN: `turn-bearer-${minted}` }, release: () => (released += 1) };
  };
  /**
   * One turn, drained, with whether its bearer was let go while the CLI
   * was still at work and how many times it was let go in all.
   *
   * "At work" is every event but the result. Codex's result is the
   * adapter's own, named after the app-server has gone — by when its
   * bearer has rightly been let go — where Claude's arrives from the CLI.
   * Every event before it, on both, is the CLI still talking.
   */
  async function turn(stream: AsyncIterable<AgentEvent>): Promise<{ early: boolean; after: number }> {
    const before = released;
    let early = false;
    for await (const event of stream) {
      if (event.type !== "result" && released !== before) early = true;
    }
    return { early, after: released - before };
  }
  function observation(bearers: unknown[], turns: { early: boolean; after: number }[]) {
    return { bearers, releasedBeforeTheTurnWasOver: turns.map((one) => one.early), releasedOnceItWas: turns.map((one) => one.after) };
  }
  return { admin, turn, observation };
}

/**
 * The admin bearers minted for a warm start, each counted as it is let go.
 *
 * Its own ledger rather than `adminLeases`: here several bearers are in
 * play at once and what matters is which of them went when.
 */
function bearerLedger() {
  const minted: string[] = [];
  const released = new Map<string, number>();
  const admin = () => {
    const token = `turn-bearer-${minted.length + 1}`;
    minted.push(token);
    return { server: { url: "http://127.0.0.1:9/mcp", envName: "EO_ADMIN_TOKEN" }, environment: { EO_ADMIN_TOKEN: token }, release: () => released.set(token, (released.get(token) ?? 0) + 1) };
  };
  /** Drains a turn, saying whether `token` was let go while the CLI was still at work (see `adminLeases.turn`). */
  async function turn(stream: AsyncIterable<AgentEvent>, token: () => string | undefined): Promise<boolean> {
    let early = false;
    for await (const event of stream) {
      const held = token();
      if (event.type !== "result" && held !== undefined && released.has(held)) early = true;
    }
    return early;
  }
  /** Whether every bearer minted so far has been let go exactly once, said so a failure shows which. */
  function lettingGo(): string {
    const counts = minted.map((token) => released.get(token) ?? 0);
    return counts.every((count) => count === 1) ? "each exactly once" : `minted ${minted.join(", ")}; let go ${counts.join(", ")} times`;
  }
  function observation(launchTokens: (string | undefined)[], turnRanOnTheWarmOne: boolean, early: boolean) {
    return {
      launches: launchTokens.length,
      turnRanOnTheWarmOne,
      eachSpawnedWithAToken: launchTokens.every((token) => token !== undefined && minted.includes(token)),
      warmBearerLetGoBeforeTheTurnWasOver: early,
      bearersLetGo: lettingGo(),
    };
  }
  const held = () => minted.filter((token) => !released.has(token)).length;
  return { admin, turn, observation, lettingGo, held, released, minted };
}


/**
 * Whether a call was known to be open while the tool was at work — at the
 * progress it reported mid-call, a heartbeat that names no call — and
 * closed once the turn was over, read the way the inactivity guard reads
 * the events (`noteActivity`).
 */
function runningToolSeen(events: AgentEvent[]): { openWhileRunning: boolean; closedAfter: boolean } {
  const along = callsOpenAlong(events);
  const midCall = events.findIndex((event) => event.type === "heartbeat" && event.callStarted === undefined);
  return { openWhileRunning: midCall >= 0 && along[midCall] === true, closedAfter: along.at(-1) === false };
}

function callsOpenAlong(events: AgentEvent[]): boolean[] {
  const open = new Set<string>();
  return events.map((event) => {
    if (event.type === "heartbeat" && event.callStarted) open.add(event.callStarted);
    else if (event.type === "tool_call" && event.callId) open.add(event.callId);
    else if (event.type === "tool_result" && event.callId) open.delete(event.callId);
    return open.size > 0;
  });
}

// ───────────────────────────── Claude ─────────────────────────────
//
// The stub is the SDK's `query`: a function handed the prompt stream and
// the options, answering with the messages a CLI would send.

type SdkCall = { prompt: unknown; options: Record<string, unknown> };
type ClaudeHooks = { PreToolUse?: { hooks: ((input: unknown) => Promise<unknown>)[] }[] };

const sdk = {
  init: (extra: Record<string, unknown> = {}) => ({ type: "system", subtype: "init", session_id: "sess-1", ...extra }) as unknown as SDKMessage,
  says: (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] }, session_id: "sess-1" }) as unknown as SDKMessage,
  calls: (id: string, name: string, input: unknown) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] }, session_id: "sess-1" }) as unknown as SDKMessage,
  answers: (id: string, content: string) =>
    ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content }] }, parent_tool_use_id: null, session_id: "sess-1" }) as unknown as SDKMessage,
  result: (overrides: Record<string, unknown> = {}) =>
    ({ type: "result", subtype: "success", result: "done", total_cost_usd: 0.0234, usage: { input_tokens: 1_200, output_tokens: 340 }, session_id: "sess-1", ...overrides }) as unknown as SDKMessage,
  rateLimit: (info: Record<string, unknown>) => ({ type: "rate_limit_event", rate_limit_info: info, uuid: "u-1", session_id: "sess-1" }) as unknown as SDKMessage,
  /** One Messages API streaming event, as `includePartialMessages` delivers it. */
  stream: (event: Record<string, unknown>) => ({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u-s", session_id: "sess-1" }) as unknown as SDKMessage,
};

function textOf(message: SDKUserMessage): string {
  const content = message.message.content;
  return typeof content === "string" ? content : content.map((block) => ("text" in block ? block.text : "")).join("");
}

/** A `query` that plays `messages`, keeping what it was called with. */
function scripted(messages: SDKMessage[]) {
  const calls: SdkCall[] = [];
  const runQuery = ((params: { prompt: unknown; options?: Record<string, unknown> }) => {
    calls.push({ prompt: params.prompt, options: params.options ?? {} });
    return (async function* () {
      yield* messages;
    })();
  }) as never;
  return { runQuery, calls };
}

/** A `query` that fails the way a real one does: on the first `next()`. */
function refusing(error: Error) {
  return (() => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }) })) as never;
}

/** The text of the first user message a `query` was handed. */
async function firstSaid(call: SdkCall | undefined): Promise<string | null> {
  for await (const sent of (call?.prompt ?? []) as AsyncIterable<SDKUserMessage>) return textOf(sent);
  return null;
}

const claudeTurn = async (messages: SDKMessage[], start: Record<string, unknown> = {}) =>
  collect(createClaudeProvider({ runQuery: scripted(messages).runQuery, enableCommentTool: false }).start({ ...startOpts, ...start } as never));

const CLAUDE: Record<CapabilityName, Proof> = {
  "a resumed run's own usage": async () => {
    // The CLI restores a resumed session's cost state, so run 2's result
    // is the whole conversation's running total: run 1's, and its own.
    const totalSoFar = (inputTokens: number, outputTokens: number, usd: number) =>
      sdk.result({
        total_cost_usd: usd,
        modelUsage: { "claude-opus": { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      });
    const first = await claudeTurn([sdk.init(), sdk.says("done"), totalSoFar(1_000_000, 100_000, 10)]);
    const second = await collect(
      createClaudeProvider({ runQuery: scripted([sdk.says("done again"), totalSoFar(1_300_000, 120_000, 13)]).runQuery, enableCommentTool: false }).resume("sess-1", "carry on", { cwd: "/tmp/wt" }),
    );
    return recordedOnThread(first, second);
  },

  "admin bearer per turn": async () => {
    // Claude's delivery: the URL is in the generated `.mcp.json` and the
    // bearer in the CLI's environment, read off what the SDK was handed.
    const leases = adminLeases();
    const { runQuery, calls } = scripted([sdk.init(), sdk.says("done"), sdk.result()]);
    const provider = createClaudeProvider({ runQuery, enableCommentTool: false, admin: leases.admin });
    const started = await leases.turn(provider.start(startOpts));
    const resumed = await leases.turn(provider.resume("sess-1", "carry on", { cwd: "/tmp/wt" }));
    return leases.observation(
      calls.map((call) => (call.options["env"] as Record<string, string> | undefined)?.["EO_ADMIN_TOKEN"]),
      [started, resumed],
    );
  },

  "uploading files from the turn's directory": async () => {
    const leases = directoryLeases();
    const { runQuery, calls } = scripted([sdk.init(), sdk.says("done"), sdk.result()]);
    const provider = createClaudeProvider({ runQuery, enableCommentTool: false, admin: leases.admin });
    await collect(provider.start({ ...startOpts, cwd: "/tmp/wt-start" }));
    await collect(provider.resume("sess-1", "carry on", { cwd: "/tmp/wt-resume" }));
    return leases.observation(calls.map((call) => (call.options["env"] as Record<string, string> | undefined)?.["EO_ADMIN_TOKEN"]));
  },

  start: async () => {
    const events = await claudeTurn([sdk.init(), sdk.says('{"verdict":"approve"}'), sdk.result({ structured_output: { verdict: "approve" } })], { outputSchema: VERDICT_SCHEMA });
    const [first] = events;
    return { events: types(events), threadNamed: first?.type === "thread_started" && first.threadId === "sess-1", outcome: outcomeOf(events) };
  },

  resume: async () => {
    const { runQuery, calls } = scripted([sdk.says("continued"), sdk.result({ result: "continued" })]);
    const events = await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).resume("thr-persisted", "the human replied", { cwd: "/tmp/wt" }));
    let message = "";
    for await (const sent of calls[0]?.prompt as AsyncIterable<SDKUserMessage>) {
      message = textOf(sent);
      break;
    }
    return { asked: { threadId: calls[0]?.options["resume"], cwd: calls[0]?.options["cwd"], message }, outcome: outcomeOf(events) };
  },

  "lost thread": async () => {
    // How it really arrives: the CLI writes the line to stderr and exits
    // non-zero, and the SDK wraps that in a message of its own (EO-93).
    const resume = (error: Error) => createClaudeProvider({ runQuery: refusing(error), enableCommentTool: false }).resume("thr-gone", "carry on", { cwd: "/tmp/wt" });
    return lostThread(
      "claude",
      await thrownBy(resume(new Error("Claude Code process exited with code 1\nstderr: No conversation found with session ID: thr-gone"))),
      await thrownBy(resume(new Error("Claude Code process exited with code 1\nstderr: overloaded_error"))),
    );
  },

  "non-fatal warning": async () => {
    // The SDK's notices are `system` messages other than `init`, and its
    // sign-in status. The adapter recognises them and records nothing,
    // where Codex's warning is recorded as an `error` marked non-fatal:
    // the words differ in whether they are kept, and what the two share
    // — and what EO-369 was about — is that neither ends the run.
    const events = await claudeTurn([
      sdk.init(),
      { type: "system", subtype: "status", status: "compacting", session_id: "sess-1" } as unknown as SDKMessage,
      { type: "auth_status", isAuthenticating: false, output: ["Model metadata not found."], session_id: "sess-1" } as unknown as SDKMessage,
      sdk.says("All done."),
      sdk.result({ result: "All done." }),
    ]);
    return { outcome: outcomeOf(events) };
  },

  "interrupt with usage on escalation": async () => {
    // The SDK ends an interrupted turn with an `error_during_execution`
    // result, which carries the usage — but only once `interrupt()` has
    // been asked of the query, so a turn that is never reached never
    // winds down and this proof would hang rather than pass.
    let reached = false;
    let cut!: () => void;
    const held = new Promise<void>((resolve) => {
      cut = resolve;
    });
    const runQuery = (() =>
      Object.assign(
        (async function* () {
          yield sdk.init();
          yield sdk.says("I'll ask first.");
          await held;
          yield sdk.result({ subtype: "error_during_execution", is_error: true });
        })(),
        {
          interrupt: async () => {
            reached = true;
            cut();
          },
        },
      )) as never;
    const stream = createClaudeProvider({ runQuery, enableCommentTool: false }).start(startOpts);
    const seen: AgentEvent[] = [];
    for await (const event of stream) {
      seen.push(event);
      if (event.type === "output") await stream.interrupt?.();
    }
    return { interruptReachedTheTurn: reached, ...(windDown(seen, "output") as object) };
  },

  steering: async () => {
    // The real SDK reads the prompt stream on a track of its own while
    // yielding the CLI's messages back. This turn answers only once a
    // second message has been written into it — the steered one.
    const sent: SDKUserMessage[] = [];
    let heard!: () => void;
    const steered = new Promise<void>((resolve) => {
      heard = resolve;
    });
    const runQuery = ((params: { prompt: AsyncIterable<SDKUserMessage> }) => {
      void (async () => {
        for await (const message of params.prompt) if (sent.push(message) === 2) heard();
      })();
      return (async function* () {
        yield sdk.init();
        await steered;
        yield sdk.says("pineapple");
        yield sdk.result({ result: "pineapple" });
      })();
    }) as never;
    const stream = createClaudeProvider({ runQuery, enableCommentTool: false }).start(startOpts);
    const seen: AgentEvent[] = [];
    let steering: Promise<boolean> | undefined;
    for await (const event of stream) {
      seen.push(event);
      if (event.type === "thread_started") steering = stream.steer?.("The word is pineapple.");
    }
    return {
      accepted: await steering,
      delivered: sent[1] ? textOf(sent[1]) : null,
      outcome: outcomeOf(seen),
      acceptedAfterTheTurn: await stream.steer?.("Too late."),
    };
  },

  "steering with files": async () => {
    // As `steering` above, and held open until both steers have been
    // written into the turn.
    const sent: SDKUserMessage[] = [];
    let heard!: () => void;
    const steered = new Promise<void>((resolve) => {
      heard = resolve;
    });
    const runQuery = ((params: { prompt: AsyncIterable<SDKUserMessage> }) => {
      void (async () => {
        for await (const message of params.prompt) if (sent.push(message) === 3) heard();
      })();
      return (async function* () {
        yield sdk.init();
        await steered;
        yield sdk.result({ result: "seen" });
      })();
    }) as never;
    const stream = createClaudeProvider({ runQuery, enableCommentTool: false }).start(startOpts);
    let steering: Promise<[boolean | undefined, boolean | undefined]> | undefined;
    for await (const event of stream) {
      if (event.type === "thread_started") {
        steering = Promise.all([stream.steer?.("The word is in the screenshot.", [SCREENSHOT]), stream.steer?.("", [SCREENSHOT])]);
      }
    }
    const [accepted, filesOnlyAccepted] = (await steering) ?? [];
    return {
      accepted,
      delivered: sent[1] ? textOf(sent[1]) : null,
      filesOnlyAccepted,
      filesOnlyDelivered: sent[2] ? textOf(sent[2]) : null,
    };
  },

  "quota reading": async () =>
    quotaReadings(
      "claude",
      await claudeTurn([
        sdk.init(),
        sdk.rateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 23, resetsAt: RESETS_AT }),
        sdk.says("done"),
        sdk.rateLimit({ status: "rejected", rateLimitType: "five_hour", utilization: 100, resetsAt: RESETS_AT }),
        sdk.result(),
      ]),
    ),

  "MCP startup status": async () =>
    serverReports(
      await claudeTurn([
        sdk.init({
          mcp_servers: [
            { name: "eo", status: "connected" },
            { name: "plugin:eo-attachments:github", status: "failed" },
          ],
        }),
        sdk.says("done"),
        sdk.result(),
      ]),
    ),

  "search interception": async () => {
    // A CLI that announces a call, runs EO's hook before the tool, and
    // carries on — the order the real one uses (EO-168).
    const runQuery = ((params: { options?: Record<string, unknown> }) => {
      const hook = (params.options?.["hooks"] as ClaudeHooks | undefined)?.PreToolUse?.[0]?.hooks[0];
      return (async function* () {
        yield sdk.init();
        yield sdk.calls("call-1", "Bash", SEARCH);
        await hook?.({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: SEARCH, tool_use_id: "call-1", session_id: "sess-1", transcript_path: "/tmp/t.jsonl", cwd: "/tmp/wt" });
        yield sdk.answers("call-1", "");
        yield sdk.says("done");
        yield sdk.result();
      })();
    }) as never;
    return interception(await collect(createClaudeProvider({ runQuery, searchNudge: alwaysNudge }).start({ ...startOpts, repositoryMcp } as never)));
  },

  "secrets reaching servers": async () => {
    // Claude's delivery (EO-107): the attached server is written into a
    // generated directory, its `.mcp.json` binds each declared name to
    // `${NAME}`, the CLI is pointed at that file, and it expands the
    // reference out of its own environment when it starts the server.
    // Followed here link by link — the file EO wrote, the path the
    // adapter handed over, the names that file's server reads, and what
    // is under each of those names in the environment of the launch.
    const toolDirectory = join(scratchDirectory(), "plugin");
    writeToolDirectory(toolDirectory, { servers: [catalogueServer("github", ["GITHUB_TOKEN"])], skills: [] });
    const { runQuery, calls } = scripted([sdk.init(), sdk.result()]);
    await collect(createClaudeProvider({ runQuery, enableCommentTool: false, attachmentEnv: () => ({ env: { GITHUB_TOKEN: SECRET } }) }).start({ ...startOpts, toolDirectory }));

    const { env, ...argumentsOf } = (calls[0]?.options ?? {}) as { env?: Record<string, string>; extraArgs?: Record<string, string> };
    const configFile = join(toolDirectory, ".mcp.json");
    const server = readToolDirectoryServers(toolDirectory)["github"];
    // The names the server's own entry refers to, read back out of the
    // `${NAME}` references rather than assumed from what was declared.
    const reads = Object.values(server?.type === "stdio" ? (server.env ?? {}) : {}).flatMap((value) => [...value.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1] as string));
    return {
      server: server ? "github" : null,
      serverHandedToTheBackend: argumentsOf.extraArgs?.["mcp-config"] === configFile,
      serverReads: reads,
      whatItFindsThere: reads.map((name) => env?.[name] === SECRET),
      keepsWhatItInherits: env?.["PATH"] === process.env["PATH"],
      inTheArguments: JSON.stringify(argumentsOf, (_key, value: unknown) => (value instanceof AbortController ? undefined : value)).includes(SECRET),
      inTheServerConfiguration: readFileSync(configFile, "utf8").includes(SECRET),
    };
  },

  "optional answer fields": async () => {
    // The SDK's structured output follows the schema as written, so the
    // field is simply absent.
    const events = await claudeTurn([sdk.init(), sdk.result({ structured_output: { verdict: "approve" } })], { outputSchema: OPTIONAL_NOTE_SCHEMA });
    return { outcome: outcomeOf(events) };
  },

  "answer schemas sendable": async () => {
    // The SDK validates against the document as written, so the schema
    // goes as the shared one without its dialect, and a map is written
    // as a map.
    const refused = await refusedSchemas(async (outputSchema) => {
      const { runQuery, calls } = scripted([sdk.init(), sdk.result()]);
      await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({ ...startOpts, outputSchema }));
      return (calls[0]?.options["outputFormat"] as { schema?: unknown } | undefined)?.schema;
    }, claudeViolations);
    const events = await claudeTurn([sdk.init(), sdk.result({ structured_output: ASSIST_ANSWER_WITH_MAPS.claude })], { outputSchema: ASSIST_SCHEMA });
    return { refused, answer: mapsRead(events) };
  },

  "a trial plan beside a draft": async () => ({
    read: trialRead(await claudeTurn([sdk.init(), sdk.result({ structured_output: ASSIST_ANSWER_WITH_TRIAL.claude })], { outputSchema: ASSIST_SCHEMA })),
  }),

  "assistant cards": async () => {
    const read = [];
    for (const answer of ASSIST_ANSWERS_WITH_CARDS.claude) read.push(cardRead(await claudeTurn([sdk.init(), sdk.result({ structured_output: answer })], { outputSchema: ASSIST_SCHEMA })));
    return { read };
  },

  "cost reported": async () => cost(await claudeTurn([sdk.init(), sdk.says("done"), sdk.result({ total_cost_usd: 0.0234 })])),

  "instructions outside the user turn": async () => {
    // Claude's slot is the SDK's `systemPrompt`, where a string replaces
    // the preset. A resumed session keeps the one it was started with,
    // so `resume()` names none.
    const started = scripted([sdk.init(), sdk.says("done"), sdk.result()]);
    await collect(createClaudeProvider({ runQuery: started.runQuery, enableCommentTool: false }).start(startOpts));
    const resumed = scripted([sdk.says("continued"), sdk.result({ result: "continued" })]);
    await collect(createClaudeProvider({ runQuery: resumed.runQuery, enableCommentTool: false }).resume("thr-persisted", "the human replied", { cwd: "/tmp/wt" }));
    return {
      asTheSystemPrompt: started.calls[0]?.options["systemPrompt"],
      firstUserTurn: await firstSaid(started.calls[0]),
      sentAgainOnResume: resumed.calls[0]?.options["systemPrompt"] !== undefined,
      resumedUserTurn: await firstSaid(resumed.calls[0]),
    };
  },

  "debug capture": async () => {
    // An attached server with a declared secret, delivered Claude's way
    // (a generated directory), and the index server inline with a value
    // in its environment — the two places a secret travels on this
    // backend. The capture is wrapped round the adapter and the
    // recorded text is held against what `query` was then called with.
    const toolDirectory = join(scratchDirectory(), "plugin");
    writeToolDirectory(toolDirectory, { servers: [catalogueServer("github", ["GITHUB_TOKEN"])], skills: [scopedSkill("house-style", { kind: "global" })] });
    const adapter = (runQuery: never) =>
      createClaudeProvider({ runQuery, enableCommentTool: false, attachmentEnv: () => ({ env: { GITHUB_TOKEN: SECRET } }), apiKey: () => SECRET, config: { model: "model-under-test" } });

    const started = scripted([sdk.init(), sdk.says("done"), sdk.result()]);
    const first = capturing(adapter(started.runQuery), "claude");
    await collect(first.provider.start({ ...startOpts, toolDirectory, repositoryMcp: repositoryMcpWithSecret }));

    const resumed = scripted([sdk.says("continued"), sdk.result({ result: "continued" })]);
    const second = capturing(adapter(resumed.runQuery), "claude");
    await collect(second.provider.resume("thr-persisted", "the human replied", { cwd: "/tmp/wt", toolDirectory, repositoryMcp: repositoryMcpWithSecret }));

    // And an agent with no model configured: the CLI's `init` names the
    // one it chose, on a fresh session and on a resumed one.
    const says = [sdk.init({ model: "the-backends-default" }), sdk.says("done"), sdk.result()];
    const unnamed = capturing(createClaudeProvider({ runQuery: scripted(says).runQuery, enableCommentTool: false }), "claude");
    const unnamedStarted = await collect(unnamed.provider.start(startOpts));
    const unnamedResumed = await collect(createClaudeProvider({ runQuery: scripted(says).runQuery, enableCommentTool: false }).resume("thr-persisted", "carry on", { cwd: "/tmp/wt" }));

    const options = started.calls[0]?.options ?? {};
    return debugCapture(
      first.sent[0],
      second.sent[0],
      {
        instructions: options["systemPrompt"],
        prompt: await firstSaid(started.calls[0]),
        resumedPrompt: await firstSaid(resumed.calls[0]),
        model: options["model"],
        // Inline on the options, and in the file the CLI is pointed at.
        servers: [...Object.keys((options["mcpServers"] as Record<string, unknown> | undefined) ?? {}), ...Object.keys(readToolDirectoryServers(toolDirectory))],
        instructionsSlot: "systemPrompt",
      },
      { sent: unnamed.sent[0], started: unnamedStarted, resumed: unnamedResumed },
    );
  },

  "attaching files": async () => {
    // Claude's delivery: the `eo` server goes inline in `mcpServers`,
    // and its environment is where it learns which run it serves.
    const eoMcp = { serverPath: "/app/eoServer.mjs" };
    const eoEnvironment = (call: SdkCall | undefined) => (call?.options["mcpServers"] as Record<string, { env?: Record<string, string> }> | undefined)?.["eo"]?.env;
    // A call under the name Claude advertises, answered on the user
    // message after it — the second with the error flag a refused call
    // carries.
    const refuses = (id: string, content: string) =>
      ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content }] }, parent_tool_use_id: null, session_id: "sess-1" }) as unknown as SDKMessage;
    const turn = [
      sdk.init(),
      sdk.calls("call-1", eoToolName(ATTACHMENT_ADD_TOOL_NAME), ATTACH_ARGS),
      sdk.answers("call-1", ATTACH_ACCEPTED),
      sdk.calls("call-2", eoToolName(ATTACHMENT_ADD_TOOL_NAME), { paths: ["gone.png"] }),
      refuses("call-2", ATTACH_REFUSED),
      sdk.result(),
    ];

    const started = scripted(turn);
    const events = await collect(createClaudeProvider({ runQuery: started.runQuery, enableCommentTool: false, eoMcp }).start({ ...startOpts, attachFrom: ATTACH_FROM }));
    const resumed = scripted([sdk.result()]);
    await collect(createClaudeProvider({ runQuery: resumed.runQuery, enableCommentTool: false, eoMcp }).resume("thr-persisted", "carry on", { cwd: "/tmp/wt", attachFrom: ATTACH_FROM }));
    const without = scripted([sdk.init(), sdk.result()]);
    await collect(createClaudeProvider({ runQuery: without.runQuery, enableCommentTool: false, eoMcp }).start(startOpts));

    return {
      listedWithADirectory: listsAttachmentAdd(eoEnvironment(started.calls[0])),
      listedOnResume: listsAttachmentAdd(eoEnvironment(resumed.calls[0])),
      listedWithout: listsAttachmentAdd(eoEnvironment(without.calls[0])),
      ...(attachmentCalls(events) as object),
    };
  },

  "role-defined action schema": async () => {
    // The SDK validates against the document as written, so the
    // generated schema goes as it is and the field the agent had
    // nothing to say for is simply absent from its answer.
    const { runQuery, calls } = scripted([sdk.init(), sdk.result({ structured_output: { outcome: QA_ALIGNMENT_ANSWER } })]);
    const events = await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({ ...startOpts, outputSchema: QA_ALIGNMENT_SCHEMA }));
    const crossed = (calls[0]?.options["outputFormat"] as { schema?: unknown } | undefined)?.schema;
    return definedAnswer(crossed, claudeViolations, events);
  },

  "streaming words": async () => {
    const events = await claudeTurn([
      sdk.init(),
      sdk.stream({ type: "message_start", message: {} }),
      sdk.stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sdk.stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "All " } }),
      sdk.stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done." } }),
      sdk.stream({ type: "content_block_stop", index: 0 }),
      sdk.says("All done."),
      sdk.result({ result: "All done." }),
    ], { streamDeltas: true });
    return streamed(events);
  },

  "reasoning on request": async () => {
    // Asked through `thinking.display: "summarized"`. Hiding it leaves the
    // CLI's own thinking setting alone, whose display is already omitted.
    const asked = async (showReasoning: boolean | undefined) => {
      const { runQuery, calls } = scripted([sdk.init(), sdk.result()]);
      await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({ ...startOpts, ...(showReasoning === undefined ? {} : { showReasoning }) }));
      return (calls[0]?.options["thinking"] as { display?: unknown } | undefined)?.display === "summarized";
    };
    const events = await claudeTurn(
      [
        sdk.init(),
        sdk.stream({ type: "message_start", message: {} }),
        sdk.stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
        sdk.stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking the board first." } }),
        sdk.stream({ type: "content_block_stop", index: 0 }),
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "Checking the board first.", signature: "sig" }] }, session_id: "sess-1" } as unknown as SDKMessage,
        sdk.says("Done."),
        sdk.result({ result: "Done." }),
      ],
      { showReasoning: true, streamDeltas: true },
    );
    return { shownAsked: await asked(true), hiddenAsked: await asked(false), defaultAsks: await asked(undefined), ...reasoned(events) };
  },
  "warm start": async () => {
    const { runQuery, calls } = scripted([sdk.init(), sdk.says("Hi."), sdk.result({ result: "Hi." })]);
    const provider = createClaudeProvider({ runQuery, enableCommentTool: false });
    const turn = { cwd: "/tmp/wt", warmKey: "tools-v1" };
    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await settle();
    const startedAhead = calls.length;
    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await settle();
    const keptOne = calls.length;
    const events = await collect(provider.start({ ...startOpts, ...turn }));
    const adopted = calls.length === 1;
    const toldThePrompt = (await firstSaid(calls[0])) === startOpts.context;

    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await settle();
    await collect(provider.start({ ...startOpts, ...turn, warmKey: "tools-v2" }));
    const warmLetGo = (calls[1]?.options["abortController"] as AbortController | undefined)?.signal.aborted === true;
    return { startedAhead, keptOne, adopted, toldThePrompt, outcome: outcomeOf(events), mismatchStartsAgain: calls.length, warmLetGo };
  },

  "warm start under the admin bearer": async () => {
    const ledger = bearerLedger();
    const { runQuery, calls } = scripted([sdk.init(), sdk.says("Hi."), sdk.result({ result: "Hi." })]);
    const provider = createClaudeProvider({ runQuery, enableCommentTool: false, admin: ledger.admin });
    const turn = { cwd: "/tmp/wt", warmKey: "tools-v1" };
    const tokenOf = (call: SdkCall | undefined) => (call?.options["env"] as Record<string, string> | undefined)?.["EO_ADMIN_TOKEN"];
    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await settle();
    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await settle();
    const early = await ledger.turn(provider.start({ ...startOpts, ...turn }), () => tokenOf(calls[0]));
    const turnRanOnTheWarmOne = calls.length === 1;
    // And one more warm-up, which nobody sends: dropped, and its bearer with it.
    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await settle();
    provider.dropWarm!();
    await settle();
    return ledger.observation(calls.map(tokenOf), turnRanOnTheWarmOne, early);
  },

  "warm start on a process that died": async () => {
    // The SDK says nothing of a CLI that exits while nobody is reading
    // it: the first read of its query is where the turn finds out.
    const ledger = bearerLedger();
    const calls: SdkCall[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runQuery = ((params: { prompt: unknown; options?: Record<string, unknown> }) => {
      calls.push({ prompt: params.prompt, options: params.options ?? {} });
      if (calls.length === 1) {
        return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("Claude Code process exited with code 1")) }) };
      }
      return (async function* () {
        yield sdk.init();
        yield sdk.says("Hi.");
        yield sdk.result({ result: "Hi." });
      })();
    }) as never;
    const provider = createClaudeProvider({ runQuery, enableCommentTool: false, admin: ledger.admin });
    const turn = { cwd: "/tmp/wt", warmKey: "tools-v1" };
    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await settle();
    const events = await collect(provider.start({ ...startOpts, ...turn }));
    warn.mockRestore();
    return { launches: calls.length, toldThePrompt: (await firstSaid(calls[1])) === startOpts.context, outcome: outcomeOf(events), bearersLetGo: ledger.lettingGo() };
  },

  "work in progress": async () => {
    const events = await claudeTurn([
      sdk.init(),
      { type: "tool_progress", tool_use_id: "call-1", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 30, uuid: "u-1", session_id: "sess-1" } as unknown as SDKMessage,
      sdk.says("done"),
      sdk.result({ result: "done" }),
    ]);
    return { heartbeat: events.some((event) => event.type === "heartbeat"), outcome: outcomeOf(events) };
  },

  "a tool known to be running": async () => {
    return runningToolSeen(
      await claudeTurn([
        sdk.init(),
        sdk.calls("call-1", "Bash", { command: "pnpm test" }),
        { type: "tool_progress", tool_use_id: "call-1", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 30, uuid: "u-1", session_id: "sess-1" } as unknown as SDKMessage,
        sdk.answers("call-1", "ok"),
        sdk.says("done"),
        sdk.result({ result: "done" }),
      ]),
    );
  },

  "compaction reported": async () => {
    const events = await claudeTurn([
      sdk.init(),
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 180_000 }, uuid: "u-1", session_id: "sess-1" } as unknown as SDKMessage,
      sdk.says("done"),
      sdk.result({ result: "done" }),
    ]);
    return { compactions: events.filter((event) => event.type === "compacted").length, outcome: outcomeOf(events) };
  },

  "a turn held to its budget": async () => {
    const { runQuery, calls } = scripted([
      sdk.init(),
      sdk.says("Working on it."),
      sdk.result({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.61, usage: { input_tokens: 90_000, output_tokens: 4_000 } }),
    ]);
    const events = await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({ ...startOpts, budgetCents: 50 }));
    return {
      // The CLI holds the cap itself.
      heldWhileRunning: calls[0]?.options["maxBudgetUsd"] === 0.5,
      budgetStop: events.some((event) => event.type === "error" && event.budget === true),
      spendRecorded: events.some((event) => event.type === "usage" && event.tokensIn > 0),
      failedOtherwise: events.some((event) => event.type === "error" && event.budget !== true),
    };
  },

  "a retry announced": async () => {
    const events = await claudeTurn([
      sdk.init(),
      { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 2_000, error_status: 529, error: "overloaded", uuid: "u-1", session_id: "sess-1" } as unknown as SDKMessage,
      sdk.says("done"),
      sdk.result({ result: "done" }),
    ]);
    const retry = events.find((event) => event.type === "retrying");
    return {
      retrying: retry !== undefined,
      saysWhy: retry?.type === "retrying" && retry.reason.length > 0,
      failed: events.some((event) => event.type === "error"),
      outcome: outcomeOf(events),
    };
  },

  "unread turn": async () => {
    // A steer is what builds a Claude turn before it is read, and so what
    // mints its bearer; the cancel then comes before anybody reads it.
    const ledger = bearerLedger();
    const { runQuery } = scripted([sdk.init(), sdk.result()]);
    const controller = new AbortController();
    const stream = createClaudeProvider({ runQuery, enableCommentTool: false, admin: ledger.admin }).start({ ...startOpts, signal: controller.signal });
    await stream.steer?.("Before it began.");
    controller.abort();
    await settle();
    return { bearersHeld: ledger.held() };
  },

  "backend memory off": async () => {
    // Claude's switch is an environment variable (EO-468), and the one
    // read is what the SDK was handed — not the parent's environment an
    // unset `env` would fall back to. "1" and nothing else: a falsy
    // value is what the CLI reads as forcing auto-memory on.
    const off = (call: SdkCall | undefined) => (call?.options["env"] as Record<string, string> | undefined)?.["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] === "1";
    const locked = scripted([sdk.init(), sdk.result()]);
    await collect(createClaudeProvider({ runQuery: locked.runQuery, enableCommentTool: false }).start(startOpts));
    await collect(createClaudeProvider({ runQuery: locked.runQuery, enableCommentTool: false }).resume("sess-1", "carry on", { cwd: "/tmp/wt" }));
    const theirs = scripted([sdk.init(), sdk.result()]);
    await collect(createClaudeProvider({ runQuery: theirs.runQuery, enableCommentTool: false, config: { inheritAmbientConfig: true } }).start(startOpts));
    return { started: off(locked.calls[0]), resumed: off(locked.calls[1]), onTheirOwnSetup: off(theirs.calls[0]) };
  },

  "memory delivery and memory_read": async () => {
    // Claude's delivery: the section is part of the context, which is
    // the first user message; the scopes go in the inline `eo` server's
    // environment, on a start and on a resume.
    const eoMcp = { serverPath: "/app/eoServer.mjs" };
    const eoEnvironment = (call: SdkCall | undefined) => (call?.options["mcpServers"] as Record<string, { env?: Record<string, string> }> | undefined)?.["eo"]?.env;
    const started = scripted([sdk.init(), sdk.result()]);
    await collect(createClaudeProvider({ runQuery: started.runQuery, enableCommentTool: false, eoMcp }).start({ ...startOpts, context: MEMORY_CONTEXT, memoryScopes: [...MEMORY_SCOPES] }));
    const resumed = scripted([sdk.result()]);
    await collect(createClaudeProvider({ runQuery: resumed.runQuery, enableCommentTool: false, eoMcp }).resume("thr-persisted", "carry on", { cwd: "/tmp/wt", memoryScopes: [...MEMORY_SCOPES] }));
    const without = scripted([sdk.init(), sdk.result()]);
    await collect(createClaudeProvider({ runQuery: without.runQuery, enableCommentTool: false, eoMcp }).start(startOpts));

    const onStart = memoryReadOffered(eoEnvironment(started.calls[0]));
    return {
      sectionSent: (await firstSaid(started.calls[0]))?.includes(MEMORY_SECTION) === true,
      listedOnStart: onStart.listed,
      listedOnResume: memoryReadOffered(eoEnvironment(resumed.calls[0])).listed,
      scopesGiven: onStart.scopes,
      listedWithout: memoryReadOffered(eoEnvironment(without.calls[0])).listed,
    };
  },

  "environment variables": async () => {
    // Claude's delivery (EO-487): the SDK's `env`, which is the whole of
    // the CLI's environment. Three spawns of one cached provider, the
    // variables changing between them as an edit would change them, and a
    // resume, which spawns the CLI again.
    vi.stubEnv("TIER", "inherited");
    vi.stubEnv("REGION", undefined);
    try {
      const leases = adminLeases();
      const { runQuery, calls } = scripted([sdk.init(), sdk.result()]);
      const provider = createClaudeProvider({ runQuery, enableCommentTool: false, apiKey: () => "key-eo-signs-in-with", attachmentEnv: () => ({ env: { GITHUB_TOKEN: SECRET } }), admin: leases.admin });
      await collect(provider.start({ ...startOpts, environmentVariables: { ...RUN_VARIABLES("eu-west-1"), TIER: "from-a-variable" } }));
      await collect(provider.start({ ...startOpts, environmentVariables: RUN_VARIABLES("us-east-2") }));
      await collect(provider.start(startOpts));
      const resumed = scripted([sdk.says("continued"), sdk.result({ result: "continued" })]);
      await collect(createClaudeProvider({ runQuery: resumed.runQuery, enableCommentTool: false }).resume("thr-persisted", "carry on", { cwd: "/tmp/wt", environmentVariables: RUN_VARIABLES("us-east-2") }));

      const withholding = scripted([sdk.init(), sdk.result()]);
      vi.stubEnv("CHANNEL", "production");
      await collect(
        createClaudeProvider({ runQuery: withholding.runQuery, enableCommentTool: false }).start({
          ...startOpts,
          environmentVariables: { REGION: "eu-west-1", GIVEN: "from-the-step" },
          withheldEnvironmentVariables: ["CHANNEL", "GIVEN"],
        }),
      );
      const withheldEnv = withholding.calls[0]?.options["env"] as Record<string, string | undefined> | undefined;

      const envs = calls.map((call) => call.options["env"] as Record<string, string | undefined> | undefined);
      return {
        regions: envs.map((env) => env?.["REGION"] ?? null),
        resumedSees: (resumed.calls[0]?.options["env"] as Record<string, string> | undefined)?.["REGION"],
        protoNamedArrives: envs[0] !== undefined && Object.getOwnPropertyDescriptor(envs[0], "__proto__")?.value === "a-variable-called-proto",
        overWhatItInherits: envs[0]?.["TIER"] === "from-a-variable",
        eoKeepsItsOwn: keepsItsOwn(envs[0], envs[0]?.["ANTHROPIC_API_KEY"] === "key-eo-signs-in-with"),
        withheld: {
          inheritedGone: withheldEnv !== undefined && !("CHANNEL" in withheldEnv),
          givenGone: withheldEnv !== undefined && !("GIVEN" in withheldEnv),
          restInherited: withheldEnv?.["TIER"] === "inherited" && withheldEnv["REGION"] === "eu-west-1",
        },
      };
    } finally {
      vi.unstubAllEnvs();
    }
  },

  "environment variables filling server names": async () => {
    // Claude's delivery (EO-107, EO-488): the generated `.mcp.json` binds
    // each declared name to `${NAME}` and the CLI expands it out of its own
    // environment, which `attachmentEnv` fills — handed the turn's
    // variables by the adapter, as `engine.ts` wires it.
    vi.stubEnv("LOCKED", "from-the-shell");
    const layers = declaredNameLayers();
    try {
      const toolDirectory = join(scratchDirectory(), "plugin");
      writeToolDirectory(toolDirectory, { servers: [layers.server], skills: [] });
      const { runQuery, calls } = scripted([sdk.init(), sdk.result()]);
      const provider = createClaudeProvider({
        runQuery,
        enableCommentTool: false,
        attachmentEnv: (variables) =>
          attachmentEnvironment(layers.handle.db, layers.agentId, layers.serverSecrets, (name) => readOrganisationSecretEntry(layers.organisation, name), variables),
      });
      await collect(provider.start({ ...startOpts, toolDirectory, environmentVariables: layers.runOn("step-on") }));
      await collect(provider.start({ ...startOpts, toolDirectory, environmentVariables: layers.runOn("step-other") }));

      const server = readToolDirectoryServers(toolDirectory)["cloud"];
      const reads = Object.values(server?.type === "stdio" ? (server.env ?? {}) : {}).flatMap((value) => [...value.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1] as string));
      const envs = calls.map((call) => call.options["env"] as Record<string, string | undefined> | undefined);
      return { serverReads: reads, onTheStep: layers.found(envs[0], reads), onAnotherStep: layers.found(envs[1], reads) };
    } finally {
      layers.handle.close();
      vi.unstubAllEnvs();
    }
  },

  "reading a held template update": async () => {
    // Claude's spelling: the administrative server's tool under its
    // `mcp__eo_admin__` prefix, answered on the user message after it.
    const events = await claudeTurn([
      sdk.init(),
      sdk.calls("call-1", `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_update_conflict`, UPDATE_CONFLICT_ARGS),
      sdk.answers("call-1", UPDATE_CONFLICT_ANSWER),
      sdk.result(),
    ]);
    return updateConflictCalls(events);
  },

  "memory_note": async () => {
    // Claude's delivery: the grant and the scopes go in the inline `eo`
    // server's environment; the call is advertised under Claude's
    // spelling and answered on the user message after it.
    const granted = { serverPath: "/app/eoServer.mjs", enableMemoryNote: true };
    const eoEnvironment = (call: SdkCall | undefined) => (call?.options["mcpServers"] as Record<string, { env?: Record<string, string> }> | undefined)?.["eo"]?.env;
    const refuses = (id: string, content: string) =>
      ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content }] }, parent_tool_use_id: null, session_id: "sess-1" }) as unknown as SDKMessage;
    const turn = [
      sdk.init(),
      sdk.calls("call-1", eoToolName(MEMORY_NOTE_TOOL_NAME), NOTE_ARGS),
      sdk.answers("call-1", NOTE_ACCEPTED),
      sdk.calls("call-2", eoToolName(MEMORY_NOTE_TOOL_NAME), { scope: "workspace-v", text: "Elsewhere." }),
      refuses("call-2", NOTE_REFUSED),
      sdk.result(),
    ];
    const config = { allowedTools: [eoToolName(MEMORY_NOTE_TOOL_NAME)] };

    const started = scripted(turn);
    const events = await collect(createClaudeProvider({ runQuery: started.runQuery, enableCommentTool: false, eoMcp: granted, config }).start({ ...startOpts, context: MEMORY_WRITING_CONTEXT, memoryScopes: [...MEMORY_SCOPES] }));
    const resumed = scripted([sdk.result()]);
    await collect(createClaudeProvider({ runQuery: resumed.runQuery, enableCommentTool: false, eoMcp: granted, config }).resume("thr-persisted", "carry on", { cwd: "/tmp/wt", memoryScopes: [...MEMORY_SCOPES] }));
    const ungranted = scripted([sdk.init(), sdk.result()]);
    await collect(createClaudeProvider({ runQuery: ungranted.runQuery, enableCommentTool: false, eoMcp: { serverPath: "/app/eoServer.mjs" } }).start({ ...startOpts, memoryScopes: [...MEMORY_SCOPES] }));

    const said = await firstSaid(started.calls[0]);
    return {
      blockSent: said?.includes(MEMORY_WRITING) === true,
      blockNamesTheTool: said?.includes(`\`${eoToolName(MEMORY_NOTE_TOOL_NAME)}\``) === true,
      blockExplainsReplaces: explainsReplaces(said),
      listedWhenGranted: memoryNoteOffered(eoEnvironment(started.calls[0])),
      listedOnResume: memoryNoteOffered(eoEnvironment(resumed.calls[0])),
      listedWithoutTheGrant: memoryNoteOffered(eoEnvironment(ungranted.calls[0])),
      takesReplaces: memoryNoteTakesReplaces(eoEnvironment(started.calls[0])),
      ...(memoryNoteCalls(events) as object),
    };
  },

  "memory used in an answer": async () => {
    // The SDK takes the schema as written and follows it, so the list is
    // there when the agent writes it and absent when it does not.
    const sentWith: Record<string, number> = {};
    for (const [action, outputSchema] of Object.entries(MEMORY_USED_SCHEMAS)) {
      const { runQuery, calls } = scripted([sdk.init(), sdk.result()]);
      await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({ ...startOpts, outputSchema }));
      sentWith[action] = memoryUsedDeclared((calls[0]?.options["outputFormat"] as { schema?: unknown } | undefined)?.schema);
    }
    const answered = async (outputSchema: Record<string, unknown>, outcome: Record<string, unknown>) =>
      outcomeOf(await claudeTurn([sdk.init(), sdk.result({ structured_output: { outcome } })], { outputSchema }));
    return {
      sentWith,
      implement: await answered(MEMORY_USED_SCHEMAS.implement, { ...IMPLEMENT_ANSWER, memoryUsed: ["m-1"] }),
      review: await answered(MEMORY_USED_SCHEMAS.review, { ...REVIEW_ANSWER, memoryUsed: ["m-1", "m-2"] }),
      leftOut: await answered(MEMORY_USED_SCHEMAS.implement, IMPLEMENT_ANSWER),
      reviewLeftOut: await answered(MEMORY_USED_SCHEMAS.review, REVIEW_ANSWER),
    };
  },

  "agent writes through EO": async () => {
    // Claude's delivery: the bridge's address goes in the inline `eo`
    // server's environment with the rest of the turn's (EO-543). Each
    // call is reported under Claude's spelling and answered on the user
    // message after it — as the tool's text, or, as Claude Code does,
    // as its structuredContent.
    const eoMcp = { serverPath: "/app/eoServer.mjs", enableMemoryNote: true };
    const config = { allowedTools: [eoToolName(MEMORY_NOTE_TOOL_NAME)] };
    const over = (runQuery: never) => createClaudeProvider({ runQuery, enableCommentTool: true, eoMcp, config });
    const answered = (id: string, content: string, isError: boolean) =>
      ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] }, parent_tool_use_id: null, session_id: "sess-1" }) as unknown as SDKMessage;
    const launch = async (turn: Record<string, unknown>) => {
      const started = scripted([sdk.init(), sdk.result()]);
      await collect(over(started.runQuery).start({ ...startOpts, ...turn } as never));
      return (started.calls[0]?.options["mcpServers"] as Record<string, { env?: Record<string, string> }> | undefined)?.["eo"]?.env;
    };
    const report = async (calls: { id: string; tool: string; args: unknown; result: EoToolResult }[], mode: "text" | "structured") => {
      const turn = [
        sdk.init(),
        ...calls.flatMap((call) => [
          sdk.calls(call.id, eoToolName(call.tool), call.args),
          answered(call.id, mode === "text" ? textOfResult(call.result) : structuredOfResult(call.result), call.result.isError === true),
        ]),
        sdk.result(),
      ];
      return collect(over(scripted(turn).runQuery).start(startOpts));
    };
    return { text: await agentWritesIn("text", launch, report), structured: await agentWritesIn("structured", launch, report) };
  },

  "repository_checkout": async () => {
    // Claude's delivery: the bridge's address goes in the inline `eo`
    // server's environment (EO-543), which is what lists the tool; a call
    // is advertised under Claude's spelling and answered on the user
    // message after it, a refusal with the error flag.
    const eoMcp = { serverPath: "/app/eoServer.mjs" };
    const eoEnvironment = (call: SdkCall | undefined) => (call?.options["mcpServers"] as Record<string, { env?: Record<string, string> }> | undefined)?.["eo"]?.env;
    const over = (runQuery: never) => createClaudeProvider({ runQuery, enableCommentTool: false, eoMcp });
    const answered = (id: string, content: string, isError: boolean) =>
      ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] }, parent_tool_use_id: null, session_id: "sess-1" }) as unknown as SDKMessage;
    return repositoryCheckoutIn(
      async (turn) => {
        const started = scripted([sdk.init(), sdk.result()]);
        await collect(over(started.runQuery).start({ ...startOpts, ...turn } as never));
        return { env: eoEnvironment(started.calls[0]), said: await firstSaid(started.calls[0]) };
      },
      async (turn) => {
        const resumed = scripted([sdk.result()]);
        await collect(over(resumed.runQuery).resume("thr-persisted", "carry on", { cwd: "/tmp/wt", ...turn } as never));
        return eoEnvironment(resumed.calls[0]);
      },
      async (calls) => {
        const turn = [
          sdk.init(),
          ...calls.flatMap((call) => [sdk.calls(call.id, eoToolName(call.tool), call.args), answered(call.id, textOfResult(call.result), call.result.isError === true)]),
          sdk.result(),
        ];
        return collect(over(scripted(turn).runQuery).start(startOpts));
      },
    );
  },

  "scoped skills": async () => {
    // Claude's delivery is the directory EO generates for the run
    // (EO-107), narrowed to the run's scope before it is written — by
    // `attachmentsForRun`, the call `writeAgentToolDirectory` makes — and
    // offered through the SDK's `skills` allowlist read back out of it.
    // The allowlist names a skill under the plugin's prefix, which only
    // this backend has; the slug after it is what is compared.
    const toolDirectory = join(scratchDirectory(), "plugin");
    writeToolDirectory(toolDirectory, attachmentsForRun({ servers: [], skills: SCOPED_SKILLS }, SCOPED_RUN));
    const offeredBy = (call: SdkCall | undefined) => ((call?.options["skills"] as string[] | undefined) ?? []).map((name) => name.split(":").pop() ?? name).sort();
    const started = scripted([sdk.init(), sdk.result()]);
    await collect(createClaudeProvider({ runQuery: started.runQuery, enableCommentTool: false }).start({ ...startOpts, toolDirectory, skillScope: SCOPED_RUN }));
    const resumed = scripted([sdk.says("continued"), sdk.result({ result: "continued" })]);
    await collect(createClaudeProvider({ runQuery: resumed.runQuery, enableCommentTool: false }).resume("sess-1", "carry on", { cwd: "/tmp/wt", toolDirectory, skillScope: SCOPED_RUN }));
    // Named in the first turn's prompt by the Skill tool's name; the slug after the prefix is what is compared.
    const named = [...((await firstSaid(started.calls[0])) ?? "").matchAll(/^- `eo-attachments:([a-z0-9-]+)` — /gm)].map((match) => match[1] ?? "").sort();
    return { offered: offeredBy(started.calls[0]), named, written: skillFolders(join(toolDirectory, "skills")), resumed: offeredBy(resumed.calls[0]) };
  },

  "a side call returns structured output": async () => {
    // Read off the options the SDK is handed, from a provider handed
    // everything an agent could be: EO's server, an allowlist, the
    // person's own setup.
    const answered = scripted([sdk.init(), sdk.result({ structured_output: { picked: ["e1"] } })]);
    const provider = createClaudeProvider({
      runQuery: answered.runQuery,
      enableCommentTool: true,
      eoMcp: { serverPath: "/opt/eo/eoServer.mjs" },
      config: { allowedTools: ["Read"], inheritAmbientConfig: true },
    });
    const events = await collect(provider.sideCall!(sideCallOpts));
    const options = answered.calls[0]?.options ?? {};
    const env = (options["env"] as Record<string, string> | undefined) ?? {};
    return {
      outcome: outcomeOf(events),
      toolsOff: JSON.stringify(options["tools"]) === "[]" && JSON.stringify(options["skills"]) === "[]" && !("allowedTools" in options),
      noServers: !("mcpServers" in options) && !("plugins" in options) && !("extraArgs" in options) && options["strictMcpConfig"] === true,
      keepsNoThread: options["persistSession"] === false && !("resume" in options),
      inTheDirectoryGiven: options["cwd"] === sideCallOpts.cwd,
      lockedDown: JSON.stringify(options["settingSources"]) === "[]" && env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] === "1",
    };
  },

  "a side call on a chosen model and reasoning effort": async () => {
    // Claude's `effort`, read off the options the SDK is handed, from a
    // provider whose agent configuration names an effort of its own.
    const chosen = scripted([sdk.init(), sdk.result({ structured_output: { picked: ["e1"] } })]);
    const configured = { runQuery: chosen.runQuery, enableCommentTool: false, config: { effort: "low" as const } };
    const events = await collect(createClaudeProvider(configured).sideCall!({ ...sideCallOpts, model: "the-big-one", reasoningEffort: "high" }));
    const without = scripted([sdk.init(), sdk.result({ structured_output: { picked: ["e1"] } })]);
    await collect(createClaudeProvider({ ...configured, runQuery: without.runQuery }).sideCall!(sideCallOpts));
    const options = chosen.calls[0]?.options ?? {};
    return {
      outcome: outcomeOf(events),
      model: options["model"],
      reasoningEffort: options["effort"],
      withoutEffort: without.calls[0]?.options["effort"] ?? null,
    };
  },

  "a side call streams its answer's words": async () => {
    // Asked for with `includePartialMessages`; the answer is the
    // structured-output tool's arguments, streamed as JSON pieces.
    const answered = scripted([
      sdk.init(),
      sdk.stream({ type: "message_start", message: {} }),
      sdk.stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "so-1", name: "StructuredOutput", input: {} } }),
      sdk.stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"picked":' } }),
      sdk.stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '["e1"]}' } }),
      sdk.stream({ type: "content_block_stop", index: 0 }),
      sdk.result({ structured_output: { picked: ["e1"] } }),
    ]);
    const events = await collect(createClaudeProvider({ runQuery: answered.runQuery, enableCommentTool: false }).sideCall!(sideCallOpts));
    return { deltas: streamed(events).deltas, outcome: outcomeOf(events) };
  },

  "a side call wound down reports what it spent": async () => {
    // Interrupted through the query's `interrupt`, which the SDK honours
    // only on a streamed input; the CLI then closes the turn with a result
    // carrying what it spent.
    let interrupted = false;
    let release: () => void = () => {};
    const ended = new Promise<void>((resolve) => (release = resolve));
    const runQuery = (() =>
      Object.assign(
        (async function* () {
          yield sdk.init();
          yield sdk.stream({ type: "message_start", message: {} });
          yield sdk.stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "so-1", name: "StructuredOutput", input: {} } });
          yield sdk.stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"picked":["e1",' } });
          await ended;
          yield sdk.result({ subtype: "error_during_execution", usage: { input_tokens: 3_000, output_tokens: 2_100 }, total_cost_usd: 0.03 });
        })(),
        {
          interrupt: async () => {
            interrupted = true;
            release();
          },
        },
      )) as never;
    return windingDown(createClaudeProvider({ runQuery, enableCommentTool: false }), () => interrupted);
  },

  "a turn EO stops reading is ended": async () => {
    // EO spawns Claude's CLI itself, through the SDK's own hook
    // (`claudeProcess.ts`). The stub stands in for the SDK: it spawns,
    // through that hook, a process that ignores SIGTERM, and then goes on
    // talking past whatever EO reads — a CLI waiting on background tasks
    // after its `result` (EO-488), or one abandoned mid-turn for a
    // correction (EO-487).
    const stubborn = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("up\\n");';
    const lingering = (messages: SDKMessage[]) => {
      const pids: (number | undefined)[] = [];
      const runQuery = ((params: { options?: Record<string, unknown> }) =>
        (async function* () {
          const spawn = params.options?.["spawnClaudeCodeProcess"] as (options: unknown) => { pid?: number; stdout: NodeJS.ReadableStream };
          const spawned = spawn({ command: process.execPath, args: ["-e", stubborn], env: { ...process.env }, signal: new AbortController().signal });
          pids.push(spawned.pid);
          await new Promise((resolve) => spawned.stdout.once("data", resolve));
          yield* messages;
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            yield sdk.says("Still going.");
          }
        })()) as never;
      return { runQuery, pids };
    };
    const finished = lingering([sdk.init(), sdk.says("All done."), sdk.result()]);
    const outcome = await readUntil(
      createClaudeProvider({ runQuery: finished.runQuery, enableCommentTool: false, processGraceMs: 100 }).start(startOpts),
      (event) => event.type === "result",
    );
    const abandoned = lingering([sdk.init(), sdk.says("Working on it.")]);
    await readUntil(
      createClaudeProvider({ runQuery: abandoned.runQuery, enableCommentTool: false, processGraceMs: 100 }).resume("sess-1", "carry on", { cwd: "/tmp/wt" }),
      (event) => event.type === "output",
    );
    // No real process survives SIGKILL on demand, so the signals are
    // what is taken away: a CLI nothing EO sends reaches.
    const stuck = lingering([sdk.init(), sdk.says("Working on it.")]);
    const aSurvivorIsReported = await survivorReported(
      createClaudeProvider({
        runQuery: stuck.runQuery,
        enableCommentTool: false,
        processGraceMs: 50,
        turnProcesses: () => claudeProcesses({ onSpawn: (child) => (child.kill = () => true) }),
      }).resume("sess-1", "carry on", { cwd: "/tmp/wt" }),
      () => stuck.pids,
    );
    return { outcome, goneOnceReadPastItsResult: gone(finished.pids[0]), goneOnceAbandonedMidTurn: gone(abandoned.pids[0]), aSurvivorIsReported };
  },

  "a turn's whole process tree is ended": async () => {
    // The stub stands in for the SDK, and the process it spawns through
    // EO's hook for the CLI: it starts the two descendants a pid-kill
    // misses, and then talks past whatever EO reads.
    const agentOver = (messages: SDKMessage[]) => {
      const file = pidFile();
      const pids: (number | undefined)[] = [];
      const source = `const pidFile = ${JSON.stringify(file)}; ${DESCENDANTS_SNIPPET} setInterval(() => {}, 1000); process.stdout.write("up\\n");`;
      const runQuery = ((params: { options?: Record<string, unknown> }) =>
        (async function* () {
          const spawn = params.options?.["spawnClaudeCodeProcess"] as (options: unknown) => { pid?: number; stdout: NodeJS.ReadableStream };
          const spawned = spawn({ command: process.execPath, args: [nodeScript(source)], env: { ...process.env }, signal: new AbortController().signal });
          pids.push(spawned.pid);
          await new Promise((resolve) => spawned.stdout.once("data", resolve));
          yield* messages;
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            yield sdk.says("Still going.");
          }
        })()) as never;
      return { runQuery, pids, file };
    };
    const finished = agentOver([sdk.init(), sdk.says("All done."), sdk.result()]);
    const outcome = await readUntil(
      createClaudeProvider({ runQuery: finished.runQuery, enableCommentTool: false, processGraceMs: 500 }).start(startOpts),
      (event) => event.type === "result",
    );
    const cancelled = agentOver([sdk.init(), sdk.says("Working on it.")]);
    const controller = new AbortController();
    await cancelAfterOutput(createClaudeProvider({ runQuery: cancelled.runQuery, enableCommentTool: false, processGraceMs: 500 }).start({ ...startOpts, signal: controller.signal }), controller);
    return { outcome, goneOnceReadPastItsResult: await treeGone(finished.pids, finished.file), goneOnceCancelled: await treeGone(cancelled.pids, cancelled.file) };
  },
};

// ───────────────────────────── Codex ──────────────────────────────
//
// The stub is the app-server: a child process speaking the protocol,
// under the real `CodexClient` built the way the provider builds it,
// with only the spawn swapped.

const STUB_EXECUTABLE = "/opt/eo/runtimes/codex/bin/codex";

function codexOver(scenario: FakeAppServerScenario, options: Parameters<typeof createCodexProvider>[0] = {}) {
  const fake = fakeAppServer(scenario);
  const provider = createCodexProvider({
    executablePath: STUB_EXECUTABLE,
    ...options,
    createCodex: (repository, searchHook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheld, adminDirectory) =>
      new CodexClient({
        ...codexClientOptions({ executablePath: STUB_EXECUTABLE, ...options }, repository, searchHook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheld, adminDirectory),
        spawn: fake.spawn,
        shutdownGraceMs: 200,
        killGraceMs: 100,
      }),
  });
  return { fake, provider };
}

const codexTurn = async (notes: NonNullable<FakeAppServerScenario["after"]>[string], start: Record<string, unknown> = {}, options: Parameters<typeof createCodexProvider>[0] = {}) =>
  collect(codexOver({ after: { "turn/start": notes } }, options).provider.start({ ...startOpts, ...start } as never));

/** Stamped so a file it did not write fails to decrypt, as `safeStorage` fails on another keychain's. */
const SEALED: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`|eo|${text}`),
  decryptString: (buffer: Buffer) => {
    const text = buffer.toString();
    if (!text.startsWith("|eo|")) throw new Error("cannot decrypt");
    return text.slice("|eo|".length);
  },
};

/**
 * One server and every layer its declared names are filled from
 * (EO-488), each name standing for one rung of the order, in real stores
 * read by EO's own resolvers — `attachmentEnvironment` for Claude,
 * `codexServerSecretReader` for Codex — so what is compared is the
 * precedence, not two fakes agreeing.
 *
 * - `REGION`: a shared variable and nothing else.
 * - `ZONE`: a shared variable, and the step's own over it.
 * - `OWN`: a variable, and the server's own secret over it.
 * - `ORG`: a variable and the server's secret, and the organisation's over both.
 * - `LOCKED`: a variable, the person's shell and the server's secret,
 *   under an organisation value that cannot be read.
 */
function declaredNameLayers() {
  const root = scratchDirectory();
  const variables = { directory: join(root, "module-secrets"), store: SEALED };
  for (const name of ["REGION", "OWN", "ORG", "LOCKED"]) storeVariable(variables, name, name === "REGION" ? "eu-west-1" : "from-a-variable");
  storeVariable(variables, "ZONE", "zone-shared");
  storeVariable(variables, "ZONE", "zone-of-the-step", "step-on");
  const organisation = { directory: join(root, "organisation-secrets"), store: SEALED };
  storeOrganisationSecret(organisation, "ORG", "the-organisations");
  storeOrganisationSecret(organisation, "LOCKED", "the-organisations");
  writeFileSync(join(organisation.directory, "secret-LOCKED.bin"), Buffer.from([0]));

  const handle = openMigratedTestDb();
  const saved = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name: "cloud", transport: "stdio", command: "/usr/bin/cloud-mcp", envNames: ["REGION", "ZONE", "OWN", "ORG", "LOCKED"] }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  const agentId = listAgents(handle.db).find((agent) => agent.role === "implementer")!.id;
  setAgentAttachment(handle.db, { agentId, kind: "mcpServer", id: saved.server.id, attached: true });
  const serverSecrets = { directory: join(root, "mcp-server-secrets"), store: SEALED };
  for (const name of ["OWN", "ORG", "LOCKED"]) storeMcpServerSecret(serverSecrets, saved.server.id, name, "the-servers-own");

  return {
    handle,
    agentId,
    server: saved.server,
    serverSecrets,
    organisation,
    /** What a run on a step is given, as the supervisor reads it at each turn. */
    runOn: (stepId: string) => agentRunVariables(variables, stepId),
    /** What a server reading `names` finds in a launch environment. */
    found: (env: Record<string, string | undefined> | undefined, names: readonly string[]) => Object.fromEntries(names.map((name) => [name, env?.[name] ?? null])),
  };
}

function catalogueServer(name: string, envNames: string[] = []): McpServer {
  return {
    id: `srv-${name}`,
    name,
    description: "",
    config: { transport: "stdio", command: `/usr/bin/${name}-mcp`, args: ["stdio"] },
    envNames,
    enabled: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    archivedAt: null,
    connector: null,
  };
}

const shellCall = (id: string) =>
  note.item({ type: "commandExecution", id, command: SEARCH.command, cwd: "/", processId: null, source: "agent", commandActions: [], aggregatedOutput: "", exitCode: 0, status: "completed", durationMs: 1 });

const CODEX: Record<CapabilityName, Proof> = {
  "a resumed run's own usage": async () => {
    // The app-server restates the thread's total when it is resumed, and
    // the client reports a turn's share of it; the tally adds those up.
    const first = await codexTurn([note.turnStarted(), note.agentMessage("done"), note.tokenUsage({ input: 1_000_000, output: 100_000 }), note.turnCompleted()]);
    const { provider } = codexOver({
      after: {
        "thread/resume": [note.tokenUsage({ input: 1_000_000, output: 100_000 }, "turn-0")],
        "turn/start": [note.turnStarted(), note.agentMessage("done again"), note.tokenUsage({ input: 1_300_000, output: 120_000 }), note.turnCompleted()],
      },
    });
    const second = await collect(provider.resume("thr-fake", "carry on", { cwd: "/tmp/wt" }));
    return recordedOnThread(first, second);
  },

  "admin bearer per turn": async () => {
    // Codex's delivery: `bearer_token_env_var` names the variable on the
    // command line and the bearer is in the app-server's environment,
    // read off each launch. Let go of by the client once the process is
    // over (`CodexClient.afterTurn`).
    const leases = adminLeases();
    const fresh = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("done"), note.turnCompleted()] } }, { admin: leases.admin });
    const started = await leases.turn(fresh.provider.start(startOpts));
    const again = codexOver(
      { after: { "turn/start": [note.turnStarted("turn-1", "thr-persisted"), note.agentMessage("continued", "m", "turn-1", "thr-persisted"), note.turnCompleted("completed", null, "turn-1", "thr-persisted")] } },
      { admin: leases.admin },
    );
    const resumed = await leases.turn(again.provider.resume("thr-persisted", "carry on", { cwd: "/tmp/wt" }));
    return leases.observation(
      [...fresh.fake.launches, ...again.fake.launches].map((launch) => (launch.options.env as Record<string, string> | undefined)?.["EO_ADMIN_TOKEN"]),
      [started, resumed],
    );
  },

  "uploading files from the turn's directory": async () => {
    const leases = directoryLeases();
    const fresh = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("done"), note.turnCompleted()] } }, { admin: leases.admin });
    await collect(fresh.provider.start({ ...startOpts, cwd: "/tmp/wt-start" }));
    const again = codexOver(
      { after: { "turn/start": [note.turnStarted("turn-1", "thr-persisted"), note.agentMessage("continued", "m", "turn-1", "thr-persisted"), note.turnCompleted("completed", null, "turn-1", "thr-persisted")] } },
      { admin: leases.admin },
    );
    await collect(again.provider.resume("thr-persisted", "carry on", { cwd: "/tmp/wt-resume" }));
    return leases.observation([...fresh.fake.launches, ...again.fake.launches].map((launch) => (launch.options.env as Record<string, string> | undefined)?.["EO_ADMIN_TOKEN"]));
  },

  start: async () => {
    const events = await codexTurn([note.turnStarted(), note.agentMessage('{"verdict":"approve"}'), note.tokenUsage({ input: 100, output: 9 }), note.turnCompleted()], { outputSchema: VERDICT_SCHEMA });
    const [first] = events;
    return { events: types(events), threadNamed: first?.type === "thread_started" && first.threadId === "thr-fake", outcome: outcomeOf(events) };
  },

  resume: async () => {
    const { fake, provider } = codexOver({
      after: { "turn/start": [note.turnStarted("turn-1", "thr-persisted"), note.agentMessage("continued", "m", "turn-1", "thr-persisted"), note.turnCompleted("completed", null, "turn-1", "thr-persisted")] },
    });
    const events = await collect(provider.resume("thr-persisted", "the human replied", { cwd: "/tmp/wt" }));
    const resumed = fake.paramsOf("thread/resume");
    const said = fake.paramsOf("turn/start")?.["input"] as { text: string }[] | undefined;
    return { asked: { threadId: resumed?.["threadId"], cwd: resumed?.["cwd"], message: said?.[0]?.text }, outcome: outcomeOf(events) };
  },

  "lost thread": async () => {
    const resume = (code: number, message: string) => codexOver({ replies: { "thread/resume": { error: { code, message } } } }).provider.resume("thr-gone", "carry on", { cwd: "/tmp/wt" });
    return lostThread("codex", await thrownBy(resume(-32600, "no rollout found for thread id thr-gone")), await thrownBy(resume(-32603, "database is locked")));
  },

  "non-fatal warning": async () => {
    // Both of the app-server's warnings (EO-369): one about the
    // configuration, said before there is a turn, and one during it.
    const { provider } = codexOver({
      after: {
        initialize: [note.configWarning("Your configuration includes requirements managed by your organization.")],
        "turn/start": [note.turnStarted(), note.warning("Model metadata not found."), note.agentMessage("All done."), note.turnCompleted()],
      },
    });
    return { outcome: outcomeOf(await collect(provider.start(startOpts))) };
  },

  "interrupt with usage on escalation": async () => {
    // The turn ends `interrupted` only in answer to `turn/interrupt`, so
    // as on Claude a turn that is never reached never winds down.
    const { fake, provider } = codexOver({
      after: {
        "turn/start": [note.turnStarted(), note.agentMessage("I'll ask first.", "m-1"), note.tokenUsage({ input: 13_656, cached: 11_776, output: 145 })],
        "turn/interrupt": [note.turnCompleted("interrupted")],
      },
    });
    const stream = provider.start(startOpts);
    const seen: AgentEvent[] = [];
    for await (const event of stream) {
      seen.push(event);
      if (event.type === "output") await stream.interrupt?.();
    }
    // Codex goes on to name the turn's last message as a result, after
    // the error, where Claude's interrupted turn has none. Past an
    // escalation the supervisor reads only the accounting, so the
    // wind-down is compared through the error and no further.
    return { interruptReachedTheTurn: fake.paramsOf("turn/interrupt") !== undefined, ...(windDown(seen, "output") as object) };
  },

  steering: async () => {
    const { fake, provider } = codexOver({
      after: {
        "turn/start": [note.turnStarted()],
        // What the real binary does with a steer (0.161.0, and again at
        // 0.163.0, 0.165.0 and 0.166.0 in `codexAppServer.live.test.ts`): the message joins the
        // running turn, which finishes on an answer to it.
        "turn/steer": [note.agentMessage("pineapple"), note.tokenUsage({ input: 27_452, output: 114 }), note.turnCompleted()],
      },
    });
    const stream = provider.start(startOpts);
    const seen: AgentEvent[] = [];
    let steering: Promise<boolean> | undefined;
    for await (const event of stream) {
      seen.push(event);
      if (event.type === "thread_started") steering = stream.steer?.("The word is pineapple.");
    }
    const said = fake.paramsOf("turn/steer")?.["input"] as { text: string }[] | undefined;
    return {
      accepted: await steering,
      delivered: said?.[0]?.text ?? null,
      outcome: outcomeOf(seen),
      acceptedAfterTheTurn: await stream.steer?.("Too late."),
    };
  },

  "steering with files": async () => {
    // One turn per message: the fake answers a steer by finishing the
    // turn, as the real binary does once it has answered.
    const steered = async (message: string) => {
      const { fake, provider } = codexOver({
        after: { "turn/start": [note.turnStarted()], "turn/steer": [note.agentMessage("seen"), note.turnCompleted()] },
      });
      const stream = provider.start(startOpts);
      let steering: Promise<boolean> | undefined;
      for await (const event of stream) {
        if (event.type === "thread_started") steering = stream.steer?.(message, [SCREENSHOT]);
      }
      const said = fake.paramsOf("turn/steer")?.["input"] as { text: string }[] | undefined;
      return { accepted: await steering, delivered: said?.[0]?.text ?? null };
    };
    const withWords = await steered("The word is in the screenshot.");
    const filesOnly = await steered("");
    return {
      accepted: withWords.accepted,
      delivered: withWords.delivered,
      filesOnlyAccepted: filesOnly.accepted,
      filesOnlyDelivered: filesOnly.delivered,
    };
  },

  "quota reading": async () =>
    quotaReadings(
      "codex",
      await codexTurn([
        note.turnStarted(),
        note.rateLimits({ usedPercent: 23, resetsAt: RESETS_AT }),
        note.agentMessage("done"),
        note.rateLimits({ usedPercent: 100, resetsAt: RESETS_AT }),
        note.tokenUsage({ input: 10, output: 2 }),
        note.turnCompleted(),
      ]),
    ),

  "MCP startup status": async () => {
    const { provider } = codexOver(
      {
        after: {
          "thread/start": [note.mcpStartup("eo", "starting"), note.mcpStartup("github", "starting"), note.mcpStartup("github", "failed", "No such file or directory (os error 2)"), note.mcpStartup("eo", "ready")],
          "turn/start": [note.turnStarted(), note.agentMessage("done"), note.turnCompleted()],
        },
      },
      { eoMcp: { serverPath: "/app/eoServer.mjs" }, attachedServers: [catalogueServer("github")] },
    );
    return serverReports(await collect(provider.start(startOpts)));
  },

  "search interception": async () => {
    // The stub runs EO's hook before the command completes, as the CLI
    // does: it posts the `PreToolUse` payload to the listener named in
    // the environment EO launched it with (EO-379).
    const events = await codexTurn(
      [
        note.turnStarted(),
        { fireHook: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: SEARCH, tool_use_id: "call-1" } },
        shellCall("call-1"),
        note.agentMessage("done"),
        note.turnCompleted(),
      ],
      { repositoryMcp },
      {
        searchNudge: alwaysNudge,
        searchHookCommandPath: "/opt/eo/hook.mjs",
        searchHookTrust: async () => ({ key: "/<session-flags>/config.toml:pre_tool_use:0:0", hash: "sha256:abc123" }),
      },
    );
    return interception(events);
  },

  "secrets reaching servers": async () => {
    const { fake, provider } = codexOver(
      { after: { "turn/start": [note.turnStarted(), note.agentMessage("ok"), note.turnCompleted()] } },
      { attachedServers: [catalogueServer("github", ["GITHUB_TOKEN"])], serverSecret: (_serverId, name) => (name === "GITHUB_TOKEN" ? SECRET : null) },
    );
    await collect(provider.start(startOpts));
    // Codex's delivery (EO-377): the server is configured inline on the
    // app-server's command line, where `env_vars` names the variables
    // the CLI forwards from its own environment to the server it starts.
    // The same links as Claude's, read off the launch itself.
    const [launch] = fake.launches;
    const env = launch?.options.env as Record<string, string> | undefined;
    const configured = (key: string): string | undefined => launch?.args.find((argument) => argument.startsWith(`mcp_servers.github.${key}=`))?.slice(`mcp_servers.github.${key}=`.length);
    const reads = JSON.parse(configured("env_vars") ?? "[]") as string[];
    const serverConfiguration = (launch?.args ?? []).filter((argument) => argument.startsWith("mcp_servers.github."));
    return {
      server: serverConfiguration.length > 0 ? "github" : null,
      serverHandedToTheBackend: configured("command") === JSON.stringify("/usr/bin/github-mcp"),
      serverReads: reads,
      whatItFindsThere: reads.map((name) => env?.[name] === SECRET),
      keepsWhatItInherits: env?.["PATH"] === process.env["PATH"],
      inTheArguments: [launch?.command, ...(launch?.args ?? [])].join("\0").includes(SECRET) || JSON.stringify(fake.sent).includes(SECRET),
      inTheServerConfiguration: serverConfiguration.join("\n").includes(SECRET),
    };
  },

  "optional answer fields": async () => {
    // OpenAI's strict schema requires every key, so the agent writes a
    // null where it has nothing to say and the adapter takes it back out
    // (EO-376).
    const events = await codexTurn([note.turnStarted(), note.agentMessage('{"verdict":"approve","note":null}'), note.turnCompleted()], { outputSchema: OPTIONAL_NOTE_SCHEMA });
    return { outcome: outcomeOf(events) };
  },

  "answer schemas sendable": async () => {
    // OpenAI's strict subset has no map, so the adapter sends one as a
    // list of `{ name, value }` entries and folds the answer's list back
    // into the map (EO-387). Read off `turn/start`, which is where the
    // schema leaves EO.
    const refused = await refusedSchemas(async (outputSchema) => {
      const { fake, provider } = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("{}"), note.turnCompleted()] } });
      await collect(provider.start({ ...startOpts, outputSchema }));
      return fake.paramsOf("turn/start")?.["outputSchema"];
    }, openAiStrictViolations);
    const events = await codexTurn([note.turnStarted(), note.agentMessage(JSON.stringify(ASSIST_ANSWER_WITH_MAPS.codex)), note.turnCompleted()], { outputSchema: ASSIST_SCHEMA });
    return { refused, answer: mapsRead(events) };
  },

  "a trial plan beside a draft": async () => ({
    read: trialRead(await codexTurn([note.turnStarted(), note.agentMessage(JSON.stringify(ASSIST_ANSWER_WITH_TRIAL.codex)), note.turnCompleted()], { outputSchema: ASSIST_SCHEMA })),
  }),

  "assistant cards": async () => {
    const read = [];
    for (const answer of ASSIST_ANSWERS_WITH_CARDS.codex) {
      read.push(cardRead(await codexTurn([note.turnStarted(), note.agentMessage(JSON.stringify(answer)), note.turnCompleted()], { outputSchema: ASSIST_SCHEMA })));
    }
    return { read };
  },

  // Priced from the table EO ships, at the stub's default model (EO-374).
  "cost reported": async () => cost(await codexTurn([note.turnStarted(), note.agentMessage("done"), note.tokenUsage({ input: 13_654, output: 69 }), note.turnCompleted()])),

  "instructions outside the user turn": async () => {
    // Codex's slot is `baseInstructions` on `thread/start`, which
    // replaces the CLI's built-in prompt (EO-385). The app-server keeps
    // them with the thread, so `thread/resume` is sent none — and none
    // under the other name it would take them by either.
    const started = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("done"), note.turnCompleted()] } });
    await collect(started.provider.start(startOpts));
    const resumed = codexOver({
      after: { "turn/start": [note.turnStarted("turn-1", "thr-persisted"), note.agentMessage("continued", "m", "turn-1", "thr-persisted"), note.turnCompleted("completed", null, "turn-1", "thr-persisted")] },
    });
    await collect(resumed.provider.resume("thr-persisted", "the human replied", { cwd: "/tmp/wt" }));
    const said = (fake: typeof started.fake) => (fake.paramsOf("turn/start")?.["input"] as { text: string }[] | undefined)?.map((part) => part.text).join("") ?? null;
    const reopened = resumed.fake.paramsOf("thread/resume");
    return {
      asTheSystemPrompt: started.fake.paramsOf("thread/start")?.["baseInstructions"],
      firstUserTurn: said(started.fake),
      sentAgainOnResume: reopened?.["baseInstructions"] !== undefined || reopened?.["developerInstructions"] !== undefined,
      resumedUserTurn: said(resumed.fake),
    };
  },

  "debug capture": async () => {
    // The same two servers, delivered Codex's way: both inline on the
    // app-server's command line, the attached one reading its secret
    // from the environment. The recorded text is held against the
    // `thread/start` and `turn/start` the app-server then received.
    const options = {
      attachedServers: [catalogueServer("github", ["GITHUB_TOKEN"])],
      serverSecret: (_serverId: string, name: string) => (name === "GITHUB_TOKEN" ? SECRET : null),
      config: { model: "model-under-test" },
      // And one the checkout already holds a folder for, which EO did not
      // write and so does not deliver (EO-207). Codex's skills go into the
      // checkout, so only this backend can collide; what is held is that
      // the record names what was sent, not what was attached (EO-602).
      attachedSkills: [scopedSkill("house-style", { kind: "global" }), scopedSkill("checked-in", { kind: "global" })],
    };
    const started = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("done"), note.turnCompleted()] } }, options);
    const first = capturing(started.provider, "codex");
    const cwd = scratchDirectory();
    mkdirSync(join(cwd, ".agent", "skills", "checked-in"), { recursive: true });
    writeFileSync(join(cwd, ".agent", "skills", "checked-in", "SKILL.md"), "the repository's own\n");
    await collect(first.provider.start({ ...startOpts, cwd, repositoryMcp: repositoryMcpWithSecret }));

    const resumed = codexOver(
      { after: { "turn/start": [note.turnStarted("turn-1", "thr-persisted"), note.agentMessage("continued", "m", "turn-1", "thr-persisted"), note.turnCompleted("completed", null, "turn-1", "thr-persisted")] } },
      options,
    );
    const second = capturing(resumed.provider, "codex");
    await collect(second.provider.resume("thr-persisted", "the human replied", { cwd: scratchDirectory(), repositoryMcp: repositoryMcpWithSecret }));

    const said = (fake: typeof started.fake) => (fake.paramsOf("turn/start")?.["input"] as { text: string }[] | undefined)?.map((part) => part.text).join("") ?? null;
    const [launch] = started.fake.launches;
    // Every server the launch configured, read off its own arguments.
    const servers = [...new Set((launch?.args ?? []).flatMap((argument) => /^mcp_servers\.([^.=]+)\./.exec(argument)?.[1] ?? []))];
    // And an agent with no model configured: `thread/start` and
    // `thread/resume` both answer with the model the CLI chose.
    const turn = (threadId?: string) => [note.turnStarted("turn-1", threadId), note.agentMessage("done", "m", "turn-1", threadId), note.turnCompleted("completed", null, "turn-1", threadId)];
    const unnamed = capturing(codexOver({ model: "the-backends-default", after: { "turn/start": turn() } }).provider, "codex");
    const unnamedStarted = await collect(unnamed.provider.start(startOpts));
    const unnamedResumed = await collect(
      codexOver({ model: "the-backends-default", after: { "turn/start": turn("thr-persisted") } }).provider.resume("thr-persisted", "carry on", { cwd: "/tmp/wt" }),
    );

    return debugCapture(
      first.sent[0],
      second.sent[0],
      {
        instructions: started.fake.paramsOf("thread/start")?.["baseInstructions"],
        prompt: said(started.fake),
        resumedPrompt: said(resumed.fake),
        model: started.fake.paramsOf("thread/start")?.["model"],
        servers,
        instructionsSlot: "baseInstructions",
      },
      { sent: unnamed.sent[0], started: unnamedStarted, resumed: unnamedResumed },
    );
  },

  "attaching files": async () => {
    // Codex's delivery: the `eo` server is configured inline on the
    // app-server's command line, one `mcp_servers.eo.env.<NAME>` per
    // variable. Read back off the launch itself.
    const eoMcp = { serverPath: "/app/eoServer.mjs" };
    const eoEnvironment = (args: readonly string[] | undefined): Record<string, string> =>
      Object.fromEntries(
        (args ?? [])
          .filter((argument) => argument.startsWith("mcp_servers.eo.env."))
          .map((argument) => argument.slice("mcp_servers.eo.env.".length))
          .map((pair) => [pair.slice(0, pair.indexOf("=")), JSON.parse(pair.slice(pair.indexOf("=") + 1)) as string]),
      );
    // One completed item carries the call and its answer together. The
    // refusal is scripted as the worst case — a tool that answered with
    // an error and an item the CLI still calls completed — because how
    // a backend words that is its own, and the supervisor must not act
    // on it either way.
    const attachmentCall = (id: string, args: unknown, text: string) =>
      note.item({ type: "mcpToolCall", id, server: "eo", tool: ATTACHMENT_ADD_TOOL_NAME, status: "completed", arguments: args, result: { content: [{ type: "text", text }], structuredContent: null }, error: null, durationMs: 1 });
    const turn = [
      note.turnStarted(),
      attachmentCall("call-1", ATTACH_ARGS, ATTACH_ACCEPTED),
      attachmentCall("call-2", { paths: ["gone.png"] }, ATTACH_REFUSED),
      note.agentMessage("done"),
      note.turnCompleted(),
    ];

    const started = codexOver({ after: { "turn/start": turn } }, { eoMcp });
    const events = await collect(started.provider.start({ ...startOpts, attachFrom: ATTACH_FROM }));
    const resumed = codexOver(
      { after: { "turn/start": [note.turnStarted("turn-1", "thr-persisted"), note.agentMessage("done", "m", "turn-1", "thr-persisted"), note.turnCompleted("completed", null, "turn-1", "thr-persisted")] } },
      { eoMcp },
    );
    await collect(resumed.provider.resume("thr-persisted", "carry on", { cwd: "/tmp/wt", attachFrom: ATTACH_FROM }));
    const without = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("done"), note.turnCompleted()] } }, { eoMcp });
    await collect(without.provider.start(startOpts));

    return {
      listedWithADirectory: listsAttachmentAdd(eoEnvironment(started.fake.launches[0]?.args)),
      listedOnResume: listsAttachmentAdd(eoEnvironment(resumed.fake.launches[0]?.args)),
      listedWithout: listsAttachmentAdd(eoEnvironment(without.fake.launches[0]?.args)),
      ...(attachmentCalls(events) as object),
    };
  },

  "role-defined action schema": async () => {
    // OpenAI's strict schema requires every key, so the field a
    // definition leaves optional is sent as nullable, the agent writes a
    // null for it and the adapter takes it back out (EO-376) — which is
    // what lets the answer hold to the definition as it was written.
    const answered = JSON.stringify({ outcome: { ...QA_ALIGNMENT_ANSWER, gaps: null } });
    const { fake, provider } = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage(answered), note.turnCompleted()] } });
    const events = await collect(provider.start({ ...startOpts, outputSchema: QA_ALIGNMENT_SCHEMA }));
    return definedAnswer(fake.paramsOf("turn/start")?.["outputSchema"], openAiStrictViolations, events);
  },

  "streaming words": async () =>
    streamed(await codexTurn([note.turnStarted(), note.agentMessageDelta("All "), note.agentMessageDelta("done."), note.agentMessage("All done."), note.turnCompleted()], { streamDeltas: true })),

  "reasoning on request": async () => {
    // Asked through `summary` on `turn/start`: `auto` to show it, `none`
    // to hide it — the CLI summarises unless told not to — and absent from
    // a turn that does not say.
    const asked = async (showReasoning: boolean | undefined) => {
      const { fake, provider } = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("ok"), note.turnCompleted()] } });
      await collect(provider.start({ ...startOpts, ...(showReasoning === undefined ? {} : { showReasoning }) }));
      const summary = fake.paramsOf("turn/start")?.["summary"];
      return summary !== undefined && summary !== "none";
    };
    const events = await codexTurn(
      [note.turnStarted(), note.reasoningDelta("Checking the board first."), note.reasoning(["Checking the board first."]), note.agentMessage("Done."), note.turnCompleted()],
      { showReasoning: true, streamDeltas: true },
    );
    return { shownAsked: await asked(true), hiddenAsked: await asked(false), defaultAsks: await asked(undefined), ...reasoned(events) };
  },
  "warm start": async () => {
    const { fake, provider } = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("Hi."), note.turnCompleted()] } });
    const turn = { cwd: "/tmp/wt", warmKey: "tools-v1" };
    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await until(() => fake.sent.some((message) => message.method === "thread/start"));
    const startedAhead = fake.launches.length;
    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await settle();
    const keptOne = fake.launches.length;
    const events = await collect(provider.start({ ...startOpts, ...turn }));
    const adopted = fake.launches.length === 1;
    const said = fake.paramsOf("turn/start")?.["input"] as { text: string }[] | undefined;
    const toldThePrompt = said?.[0]?.text.includes(startOpts.context) === true;

    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await until(() => fake.launches.length === 2);
    await collect(provider.start({ ...startOpts, ...turn, warmKey: "tools-v2" }));
    await until(() => gone(fake.launches[1]?.pid)).catch(() => undefined);
    return { startedAhead, keptOne, adopted, toldThePrompt, outcome: outcomeOf(events), mismatchStartsAgain: fake.launches.length, warmLetGo: gone(fake.launches[1]?.pid) };
  },

  "warm start under the admin bearer": async () => {
    const ledger = bearerLedger();
    const { fake, provider } = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("Hi."), note.turnCompleted()] } }, { admin: ledger.admin });
    const turn = { cwd: "/tmp/wt", warmKey: "tools-v1" };
    const tokenOf = (launch: (typeof fake.launches)[number] | undefined) => (launch?.options.env as Record<string, string> | undefined)?.["EO_ADMIN_TOKEN"];
    const threadsOpened = () => fake.sent.filter((message) => message.method === "thread/start").length;
    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await until(() => threadsOpened() === 1);
    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await settle();
    const early = await ledger.turn(provider.start({ ...startOpts, ...turn }), () => tokenOf(fake.launches[0]));
    const turnRanOnTheWarmOne = fake.launches.length === 1;
    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await until(() => threadsOpened() === 2);
    provider.dropWarm!();
    await until(() => ledger.minted.every((token) => ledger.released.has(token))).catch(() => undefined);
    return ledger.observation(fake.launches.map(tokenOf), turnRanOnTheWarmOne, early);
  },

  "warm start on a process that died": async () => {
    const ledger = bearerLedger();
    const { fake, provider } = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("Hi."), note.turnCompleted()] } }, { admin: ledger.admin });
    const turn = { cwd: "/tmp/wt", warmKey: "tools-v1" };
    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, ...turn });
    await until(() => fake.sent.some((message) => message.method === "thread/start"));
    process.kill(fake.launches[0]!.pid!, "SIGKILL");
    await until(() => gone(fake.launches[0]?.pid));
    await settle();
    const events = await collect(provider.start({ ...startOpts, ...turn }));
    await until(() => ledger.held() === 0).catch(() => undefined);
    const said = fake.paramsOf("turn/start")?.["input"] as { text: string }[] | undefined;
    return { launches: fake.launches.length, toldThePrompt: said?.[0]?.text.includes(startOpts.context) === true, outcome: outcomeOf(events), bearersLetGo: ledger.lettingGo() };
  },

  "work in progress": async () => {
    const events = await codexTurn([
      note.turnStarted(),
      { method: "item/commandExecution/outputDelta", params: { threadId: "thr-fake", turnId: "turn-1", itemId: "cmd-1", delta: "ok\n" } },
      note.agentMessage("done"),
      note.turnCompleted(),
    ]);
    return { heartbeat: events.some((event) => event.type === "heartbeat"), outcome: outcomeOf(events) };
  },

  "a tool known to be running": async () => {
    const running = { type: "commandExecution", id: "cmd-1", command: "pnpm test", cwd: "/", processId: null, source: "agent", commandActions: [], aggregatedOutput: null, exitCode: null, status: "inProgress", durationMs: null };
    return runningToolSeen(
      await codexTurn([
        note.turnStarted(),
        { method: "item/started", params: { item: running, threadId: "thr-fake", turnId: "turn-1" } },
        { method: "item/commandExecution/outputDelta", params: { threadId: "thr-fake", turnId: "turn-1", itemId: "cmd-1", delta: "running…\n" } },
        note.item({ ...running, aggregatedOutput: "ok", exitCode: 0, status: "completed", durationMs: 1 }),
        note.agentMessage("done"),
        note.turnCompleted(),
      ]),
    );
  },

  "compaction reported": async () => {
    // Said both ways the app-server says it, as it does: still one compaction.
    const events = await codexTurn([
      note.turnStarted(),
      { method: "thread/compacted", params: { threadId: "thr-fake", turnId: "turn-1" } },
      note.item({ type: "contextCompaction", id: "compaction-1" }),
      note.agentMessage("done"),
      note.turnCompleted(),
    ]);
    return { compactions: events.filter((event) => event.type === "compacted").length, outcome: outcomeOf(events) };
  },

  "a turn held to its budget": async () => {
    // A million tokens in on the stub's priced model is far past half a dollar.
    const { fake, provider } = codexOver({
      after: { "turn/start": [note.turnStarted(), note.tokenUsage({ input: 1_000_000, output: 100_000 }), note.agentMessage("done"), note.turnCompleted()] },
    });
    const events = await collect(provider.start({ ...startOpts, budgetCents: 50 }));
    return {
      // The adapter watches the running spend and interrupts the turn.
      heldWhileRunning: fake.sent.some((message) => message.method === "turn/interrupt"),
      budgetStop: events.some((event) => event.type === "error" && event.budget === true),
      spendRecorded: events.some((event) => event.type === "usage" && event.tokensIn > 0),
      failedOtherwise: events.some((event) => event.type === "error" && event.budget !== true),
    };
  },

  "a retry announced": async () => {
    const events = await codexTurn([note.turnStarted(), note.error("Reconnecting... 1/5", true), note.agentMessage("done"), note.turnCompleted()]);
    const retry = events.find((event) => event.type === "retrying");
    return {
      retrying: retry !== undefined,
      saysWhy: retry?.type === "retrying" && retry.reason.length > 0,
      failed: events.some((event) => event.type === "error"),
      outcome: outcomeOf(events),
    };
  },

  "unread turn": async () => {
    // A Codex turn builds its client — and mints its bearer — only once
    // it is read, so a turn cancelled first never held one; the client's
    // own unread turn is held to the same in codexClient.test.ts.
    const ledger = bearerLedger();
    const { provider } = codexOver({ after: { "turn/start": [note.turnStarted(), note.turnCompleted()] } }, { admin: ledger.admin });
    const controller = new AbortController();
    provider.start({ ...startOpts, signal: controller.signal });
    controller.abort();
    await settle();
    return { bearersHeld: ledger.held() };
  },

  "backend memory off": async () => {
    // Codex's switches are configuration overrides on the app-server's
    // command line (EO-468), read off the launch itself: the feature,
    // and the `[memories]` table's writing and reading under it.
    const MEMORY_OFF = ["features.memories=false", "memories.generate_memories=false", "memories.use_memories=false"];
    const off = (args: readonly string[] | undefined) => MEMORY_OFF.every((override) => (args ?? []).some((argument, index) => argument === override && args?.[index - 1] === "-c"));
    const turn = [note.turnStarted(), note.agentMessage("ok"), note.turnCompleted()];
    const started = codexOver({ after: { "turn/start": turn } });
    await collect(started.provider.start(startOpts));
    const resumed = codexOver({ after: { "turn/start": turn } });
    await collect(resumed.provider.resume("thr-persisted", "carry on", { cwd: "/tmp/wt" }));
    const theirs = codexOver({ after: { "turn/start": turn } }, { config: { inheritAmbientConfig: true } });
    await collect(theirs.provider.start(startOpts));
    return { started: off(started.fake.launches[0]?.args), resumed: off(resumed.fake.launches[0]?.args), onTheirOwnSetup: off(theirs.fake.launches[0]?.args) };
  },

  "memory delivery and memory_read": async () => {
    // Codex's delivery: the section is part of the `turn/start` input;
    // the scopes are one `mcp_servers.eo.env.<NAME>` override on the
    // app-server's command line, read back off the launch itself.
    const eoMcp = { serverPath: "/app/eoServer.mjs" };
    const eoEnvironment = (args: readonly string[] | undefined): Record<string, string> =>
      Object.fromEntries(
        (args ?? [])
          .filter((argument) => argument.startsWith("mcp_servers.eo.env."))
          .map((argument) => argument.slice("mcp_servers.eo.env.".length))
          .map((pair) => [pair.slice(0, pair.indexOf("=")), JSON.parse(pair.slice(pair.indexOf("=") + 1)) as string]),
      );
    const said = (fake: ReturnType<typeof codexOver>["fake"]) => (fake.paramsOf("turn/start")?.["input"] as { text: string }[] | undefined)?.map((part) => part.text).join("") ?? null;
    const started = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("done"), note.turnCompleted()] } }, { eoMcp });
    await collect(started.provider.start({ ...startOpts, context: MEMORY_CONTEXT, memoryScopes: [...MEMORY_SCOPES] }));
    const resumed = codexOver(
      { after: { "turn/start": [note.turnStarted("turn-1", "thr-persisted"), note.agentMessage("done", "m", "turn-1", "thr-persisted"), note.turnCompleted("completed", null, "turn-1", "thr-persisted")] } },
      { eoMcp },
    );
    await collect(resumed.provider.resume("thr-persisted", "carry on", { cwd: "/tmp/wt", memoryScopes: [...MEMORY_SCOPES] }));
    const without = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("done"), note.turnCompleted()] } }, { eoMcp });
    await collect(without.provider.start(startOpts));

    const onStart = memoryReadOffered(eoEnvironment(started.fake.launches[0]?.args));
    return {
      sectionSent: said(started.fake)?.includes(MEMORY_SECTION) === true,
      listedOnStart: onStart.listed,
      listedOnResume: memoryReadOffered(eoEnvironment(resumed.fake.launches[0]?.args)).listed,
      scopesGiven: onStart.scopes,
      listedWithout: memoryReadOffered(eoEnvironment(without.fake.launches[0]?.args)).listed,
    };
  },

  "environment variables": async () => {
    // Codex's delivery (EO-487): the app-server's spawn environment
    // (`codexSpawnEnvironment`), read off each launch. Three launches by
    // one cached provider, the variables changing between them, and a
    // resume, which launches the app-server again.
    vi.stubEnv("TIER", "inherited");
    vi.stubEnv("REGION", undefined);
    try {
      const leases = adminLeases();
      const options: Parameters<typeof createCodexProvider>[0] = {
        attachedServers: [catalogueServer("github", ["GITHUB_TOKEN"])],
        serverSecret: (_serverId, name) => (name === "GITHUB_TOKEN" ? SECRET : null),
        admin: leases.admin,
        codexHome: () => "/tmp/codex-homes/agent",
      };
      const { fake, provider } = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("ok"), note.turnCompleted()] } }, options);
      await collect(provider.start({ ...startOpts, environmentVariables: { ...RUN_VARIABLES("eu-west-1"), TIER: "from-a-variable" } }));
      await collect(provider.start({ ...startOpts, environmentVariables: RUN_VARIABLES("us-east-2") }));
      await collect(provider.start(startOpts));
      const again = codexOver(
        { after: { "turn/start": [note.turnStarted("turn-1", "thr-persisted"), note.agentMessage("continued", "m", "turn-1", "thr-persisted"), note.turnCompleted("completed", null, "turn-1", "thr-persisted")] } },
        options,
      );
      await collect(again.provider.resume("thr-persisted", "carry on", { cwd: "/tmp/wt", environmentVariables: RUN_VARIABLES("us-east-2") }));

      vi.stubEnv("CHANNEL", "production");
      const withholding = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("ok"), note.turnCompleted()] } }, options);
      await collect(
        withholding.provider.start({
          ...startOpts,
          environmentVariables: { REGION: "eu-west-1", GIVEN: "from-the-step" },
          withheldEnvironmentVariables: ["CHANNEL", "GIVEN"],
        }),
      );
      const withheldEnv = withholding.fake.launches[0]?.options.env as Record<string, string | undefined> | undefined;

      const envs = fake.launches.map((launch) => launch.options.env as Record<string, string | undefined> | undefined);
      return {
        regions: envs.map((env) => env?.["REGION"] ?? null),
        resumedSees: (again.fake.launches[0]?.options.env as Record<string, string> | undefined)?.["REGION"],
        protoNamedArrives: envs[0] !== undefined && Object.getOwnPropertyDescriptor(envs[0], "__proto__")?.value === "a-variable-called-proto",
        overWhatItInherits: envs[0]?.["TIER"] === "from-a-variable",
        eoKeepsItsOwn: keepsItsOwn(envs[0], envs[0]?.["CODEX_HOME"] === "/tmp/codex-homes/agent"),
        withheld: {
          inheritedGone: withheldEnv !== undefined && !("CHANNEL" in withheldEnv),
          givenGone: withheldEnv !== undefined && !("GIVEN" in withheldEnv),
          restInherited: withheldEnv?.["TIER"] === "inherited" && withheldEnv["REGION"] === "eu-west-1",
        },
      };
    } finally {
      vi.unstubAllEnvs();
    }
  },

  "environment variables filling server names": async () => {
    // Codex's delivery (EO-377, EO-488): the server is configured inline,
    // `env_vars` names what the CLI forwards from its own environment, and
    // `serverSecret` — EO's own reader — fills that environment, handed
    // the turn's variables as each client is built.
    vi.stubEnv("LOCKED", "from-the-shell");
    const layers = declaredNameLayers();
    try {
      const { fake, provider } = codexOver(
        { after: { "turn/start": [note.turnStarted(), note.agentMessage("ok"), note.turnCompleted()] } },
        { attachedServers: [layers.server], serverSecret: codexServerSecretReader(layers.serverSecrets, layers.organisation) },
      );
      await collect(provider.start({ ...startOpts, environmentVariables: layers.runOn("step-on") }));
      await collect(provider.start({ ...startOpts, environmentVariables: layers.runOn("step-other") }));

      const [first, second] = fake.launches;
      const reads = JSON.parse(first?.args.find((argument) => argument.startsWith("mcp_servers.cloud.env_vars="))?.slice("mcp_servers.cloud.env_vars=".length) ?? "[]") as string[];
      const env = (launch: typeof first) => launch?.options.env as Record<string, string | undefined> | undefined;
      return { serverReads: reads, onTheStep: layers.found(env(first), reads), onAnotherStep: layers.found(env(second), reads) };
    } finally {
      layers.handle.close();
      vi.unstubAllEnvs();
    }
  },

  "reading a held template update": async () => {
    // Codex's spelling: one completed `mcpToolCall` item under the
    // `eo_admin` server, which the adapter names `eo_admin/<tool>`.
    const call = note.item({
      type: "mcpToolCall",
      id: "call-1",
      server: ADMIN_MCP_SERVER_NAME,
      tool: "pipeline_update_conflict",
      status: "completed",
      arguments: UPDATE_CONFLICT_ARGS,
      result: { content: [{ type: "text", text: UPDATE_CONFLICT_ANSWER }], structuredContent: null },
      error: null,
      durationMs: 1,
    });
    const started = codexOver({ after: { "turn/start": [note.turnStarted(), call, note.agentMessage("done"), note.turnCompleted()] } });
    return updateConflictCalls(await collect(started.provider.start(startOpts)));
  },

  "memory_note": async () => {
    // Codex's delivery: the grant and the scopes are `mcp_servers.eo.env.<NAME>`
    // overrides on the app-server's command line, read back off the
    // launch; a call and its answer arrive together as one completed
    // `mcpToolCall` item under the `eo` server.
    const granted = { serverPath: "/app/eoServer.mjs", enableMemoryNote: true };
    const eoEnvironment = (args: readonly string[] | undefined): Record<string, string> =>
      Object.fromEntries(
        (args ?? [])
          .filter((argument) => argument.startsWith("mcp_servers.eo.env."))
          .map((argument) => argument.slice("mcp_servers.eo.env.".length))
          .map((pair) => [pair.slice(0, pair.indexOf("=")), JSON.parse(pair.slice(pair.indexOf("=") + 1)) as string]),
      );
    const noteCall = (id: string, args: unknown, text: string) =>
      note.item({ type: "mcpToolCall", id, server: "eo", tool: MEMORY_NOTE_TOOL_NAME, status: "completed", arguments: args, result: { content: [{ type: "text", text }], structuredContent: null }, error: null, durationMs: 1 });
    const turn = [note.turnStarted(), noteCall("call-1", NOTE_ARGS, NOTE_ACCEPTED), noteCall("call-2", { scope: "workspace-v", text: "Elsewhere." }, NOTE_REFUSED), note.agentMessage("done"), note.turnCompleted()];

    const started = codexOver({ after: { "turn/start": turn } }, { eoMcp: granted });
    const events = await collect(started.provider.start({ ...startOpts, context: MEMORY_WRITING_CONTEXT, memoryScopes: [...MEMORY_SCOPES] }));
    const resumed = codexOver(
      { after: { "turn/start": [note.turnStarted("turn-1", "thr-persisted"), note.agentMessage("done", "m", "turn-1", "thr-persisted"), note.turnCompleted("completed", null, "turn-1", "thr-persisted")] } },
      { eoMcp: granted },
    );
    await collect(resumed.provider.resume("thr-persisted", "carry on", { cwd: "/tmp/wt", memoryScopes: [...MEMORY_SCOPES] }));
    const ungranted = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("done"), note.turnCompleted()] } }, { eoMcp: { serverPath: "/app/eoServer.mjs" } });
    await collect(ungranted.provider.start({ ...startOpts, memoryScopes: [...MEMORY_SCOPES] }));

    const said = (started.fake.paramsOf("turn/start")?.["input"] as { text: string }[] | undefined)?.map((part) => part.text).join("") ?? null;
    return {
      blockSent: said?.includes(MEMORY_WRITING) === true,
      blockNamesTheTool: said?.includes(`\`${eoToolName(MEMORY_NOTE_TOOL_NAME)}\``) === true,
      blockExplainsReplaces: explainsReplaces(said),
      listedWhenGranted: memoryNoteOffered(eoEnvironment(started.fake.launches[0]?.args)),
      listedOnResume: memoryNoteOffered(eoEnvironment(resumed.fake.launches[0]?.args)),
      listedWithoutTheGrant: memoryNoteOffered(eoEnvironment(ungranted.fake.launches[0]?.args)),
      takesReplaces: memoryNoteTakesReplaces(eoEnvironment(started.fake.launches[0]?.args)),
      ...(memoryNoteCalls(events) as object),
    };
  },

  "memory used in an answer": async () => {
    // OpenAI's strict schema requires every key, so an answer with nothing
    // to say about memory writes null, and the adapter takes it back out
    // (EO-376) — inside review's nested union too.
    const sentWith: Record<string, number> = {};
    for (const [action, outputSchema] of Object.entries(MEMORY_USED_SCHEMAS)) {
      const { fake, provider } = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("{}"), note.turnCompleted()] } });
      await collect(provider.start({ ...startOpts, outputSchema }));
      sentWith[action] = memoryUsedDeclared(fake.paramsOf("turn/start")?.["outputSchema"]);
    }
    const answered = async (outputSchema: Record<string, unknown>, outcome: Record<string, unknown>) =>
      outcomeOf(await codexTurn([note.turnStarted(), note.agentMessage(JSON.stringify({ outcome })), note.turnCompleted()], { outputSchema }));
    return {
      sentWith,
      implement: await answered(MEMORY_USED_SCHEMAS.implement, { ...IMPLEMENT_ANSWER, memoryUsed: ["m-1"] }),
      review: await answered(MEMORY_USED_SCHEMAS.review, { ...REVIEW_ANSWER, memoryUsed: ["m-1", "m-2"] }),
      leftOut: await answered(MEMORY_USED_SCHEMAS.implement, { ...IMPLEMENT_ANSWER, memoryUsed: null }),
      // Review's verdicts are a union inside the outcome's, and its nulls
      // are taken out all the same.
      reviewLeftOut: await answered(MEMORY_USED_SCHEMAS.review, { ...REVIEW_ANSWER, pull_request_body: null, memoryUsed: null }),
    };
  },

  "agent writes through EO": async () => {
    // Codex's delivery: the bridge's address is one more
    // `mcp_servers.eo.env.<NAME>` override on the app-server's command
    // line (EO-543), read back off the launch. A call and its answer
    // arrive together as one completed `mcpToolCall` item — its result
    // as the tool's text, or as its structuredContent alone.
    const eoMcp = { serverPath: "/app/eoServer.mjs", enableCommentTool: true, enableMemoryNote: true };
    const eoEnvironment = (args: readonly string[] | undefined): Record<string, string> =>
      Object.fromEntries(
        (args ?? [])
          .filter((argument) => argument.startsWith("mcp_servers.eo.env."))
          .map((argument) => argument.slice("mcp_servers.eo.env.".length))
          .map((pair) => [pair.slice(0, pair.indexOf("=")), JSON.parse(pair.slice(pair.indexOf("=") + 1)) as string]),
      );
    const launch = async (turn: Record<string, unknown>) => {
      const started = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("ok"), note.turnCompleted()] } }, { eoMcp });
      await collect(started.provider.start({ ...startOpts, ...turn } as never));
      return eoEnvironment(started.fake.launches[0]?.args);
    };
    const report = async (calls: { id: string; tool: string; args: unknown; result: EoToolResult }[], mode: "text" | "structured") => {
      const turn = [
        note.turnStarted(),
        ...calls.map((call) =>
          note.item({
            type: "mcpToolCall",
            id: call.id,
            server: "eo",
            tool: call.tool,
            status: "completed",
            arguments: call.args,
            result: mode === "text" ? { content: call.result.content, structuredContent: null } : { content: [], structuredContent: call.result.structuredContent ?? null },
            error: null,
            durationMs: 1,
          }),
        ),
        note.agentMessage("done"),
        note.turnCompleted(),
      ];
      return collect(codexOver({ after: { "turn/start": turn } }, { eoMcp }).provider.start(startOpts));
    };
    return { text: await agentWritesIn("text", launch, report), structured: await agentWritesIn("structured", launch, report) };
  },

  "repository_checkout": async () => {
    // Codex's delivery: the bridge's address is one more
    // `mcp_servers.eo.env.<NAME>` override on the app-server's command
    // line (EO-543), read back off the launch. A call and its answer
    // arrive together as one completed `mcpToolCall` item under `eo`.
    const eoMcp = { serverPath: "/app/eoServer.mjs" };
    const eoEnvironment = (args: readonly string[] | undefined): Record<string, string> =>
      Object.fromEntries(
        (args ?? [])
          .filter((argument) => argument.startsWith("mcp_servers.eo.env."))
          .map((argument) => argument.slice("mcp_servers.eo.env.".length))
          .map((pair) => [pair.slice(0, pair.indexOf("=")), JSON.parse(pair.slice(pair.indexOf("=") + 1)) as string]),
      );
    const said = (fake: ReturnType<typeof codexOver>["fake"]) => (fake.paramsOf("turn/start")?.["input"] as { text: string }[] | undefined)?.map((part) => part.text).join("") ?? null;
    return repositoryCheckoutIn(
      async (turn) => {
        const started = codexOver({ after: { "turn/start": [note.turnStarted(), note.agentMessage("ok"), note.turnCompleted()] } }, { eoMcp });
        await collect(started.provider.start({ ...startOpts, ...turn } as never));
        return { env: eoEnvironment(started.fake.launches[0]?.args), said: said(started.fake) };
      },
      async (turn) => {
        const resumed = codexOver(
          { after: { "turn/start": [note.turnStarted("turn-1", "thr-persisted"), note.agentMessage("done", "m", "turn-1", "thr-persisted"), note.turnCompleted("completed", null, "turn-1", "thr-persisted")] } },
          { eoMcp },
        );
        await collect(resumed.provider.resume("thr-persisted", "carry on", { cwd: "/tmp/wt", ...turn } as never));
        return eoEnvironment(resumed.fake.launches[0]?.args);
      },
      async (calls) => {
        const turn = [
          note.turnStarted(),
          ...calls.map((call) =>
            note.item({ type: "mcpToolCall", id: call.id, server: "eo", tool: call.tool, status: "completed", arguments: call.args, result: { content: call.result.content, structuredContent: null }, error: null, durationMs: 1 }),
          ),
          note.agentMessage("done"),
          note.turnCompleted(),
        ];
        return collect(codexOver({ after: { "turn/start": turn } }, { eoMcp }).provider.start(startOpts));
      },
    );
  },

  "scoped skills": async () => {
    // Codex's delivery (EO-207): the adapter holds every attached skill
    // and narrows them by the turn's `skillScope`, writing the folders
    // into `<cwd>/.agent/skills` and naming each in the turn's prompt.
    // A resumed turn writes the files again — another agent's delivery
    // may have swept them — and that restoration is what is compared.
    const cwd = scratchDirectory();
    const turn = [note.turnStarted(), note.agentMessage("ok"), note.turnCompleted()];
    const started = codexOver({ after: { "turn/start": turn } }, { attachedSkills: SCOPED_SKILLS });
    await collect(started.provider.start({ ...startOpts, cwd, skillScope: SCOPED_RUN }));
    const said = (started.fake.paramsOf("turn/start")?.["input"] as { text: string }[] | undefined)?.[0]?.text ?? "";
    // The list in the prompt is both what Codex offers and what it names.
    const offered = [...said.matchAll(/^- `([a-z0-9-]+)` — /gm)].map((match) => match[1] ?? "").sort();
    const written = skillFolders(join(cwd, ".agent", "skills"));

    rmSync(join(cwd, ".agent"), { recursive: true, force: true });
    const resumed = codexOver({ after: { "turn/start": turn } }, { attachedSkills: SCOPED_SKILLS });
    await collect(resumed.provider.resume("thr-persisted", "carry on", { cwd, skillScope: SCOPED_RUN }));
    return { offered, named: offered, written, resumed: skillFolders(join(cwd, ".agent", "skills")) };
  },

  "a side call returns structured output": async () => {
    // Read off the launch, the thread it opens and the model catalogue it
    // is handed, from a provider handed everything an agent could be:
    // EO's server, an attached one, the person's own setup. What those
    // switches leave the model is measured in `codexSideCall.live.test.ts`.
    const caches = scratchDirectory();
    writeFileSync(join(caches, "models_cache.json"), JSON.stringify({ models: [{ slug: "the-small-one", tool_mode: "code_mode_only", multi_agent_version: "v2", apply_patch_tool_type: "freeform" }] }));
    const options: Parameters<typeof createCodexProvider>[0] = {
      executablePath: STUB_EXECUTABLE,
      codexHome: () => "/tmp/codex-homes/side-calls",
      eoMcp: { serverPath: "/opt/eo/eoServer.mjs" },
      attachedServers: [catalogueServer("github")],
      config: { inheritAmbientConfig: true },
      sideCallModelCaches: () => [join(caches, "models_cache.json")],
    };
    const fake = fakeAppServer({ after: { "turn/start": [note.turnStarted(), note.agentMessage('{"picked":["e1"]}'), note.turnCompleted()] } });
    let catalog: { models?: Record<string, unknown>[] } = {};
    const provider = createCodexProvider({
      ...options,
      createSideCallCodex: (catalogPath) => {
        catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as typeof catalog;
        return new CodexClient({ ...codexSideCallClientOptions(options, catalogPath), spawn: fake.spawn, shutdownGraceMs: 200 });
      },
    });
    const events = await collect(provider.sideCall!(sideCallOpts));
    const args = fake.launches[0]?.args ?? [];
    const opened = fake.paramsOf("thread/start") ?? {};
    const entry = catalog.models?.[0] ?? {};
    return {
      outcome: outcomeOf(events),
      // Codex has no `tools: []`: its shell is a feature, its code mode,
      // sub-agents and patch tool come from the model's catalogue entry,
      // and its skills from a table of their own. All of them off.
      toolsOff:
        ["features.shell_tool=false", "features.unified_exec=false", "features.multi_agent=false", "skills.include_instructions=false", "skills.bundled.enabled=false", 'web_search="disabled"'].every((override) => args.includes(override)) &&
        !("tool_mode" in entry) && !("multi_agent_version" in entry) && !("apply_patch_tool_type" in entry) &&
        opened["sandbox"] === "read-only",
      noServers: !args.some((argument) => argument.startsWith("mcp_servers")),
      keepsNoThread: opened["ephemeral"] === true && fake.paramsOf("thread/resume") === undefined,
      inTheDirectoryGiven: opened["cwd"] === sideCallOpts.cwd,
      lockedDown: fake.launches[0]?.options.env?.["CODEX_HOME"] === "/tmp/codex-homes/side-calls" && args.includes("features.memories=false"),
    };
  },

  "a side call on a chosen model and reasoning effort": async () => {
    // Codex's reasoning effort, `effort` on `turn/start`, and the model on
    // `thread/start` and in the one-model catalogue, from a provider whose
    // agent configuration names an effort of its own.
    const caches = scratchDirectory();
    writeFileSync(join(caches, "models_cache.json"), JSON.stringify({ models: [{ slug: "the-small-one" }, { slug: "the-big-one" }] }));
    const options: Parameters<typeof createCodexProvider>[0] = {
      executablePath: STUB_EXECUTABLE,
      codexHome: () => "/tmp/codex-homes/side-calls",
      config: { reasoningEffort: "low" },
      sideCallModelCaches: () => [join(caches, "models_cache.json")],
    };
    const ask = async (opts: typeof sideCallOpts & { reasoningEffort?: string }) => {
      const fake = fakeAppServer({ after: { "turn/start": [note.turnStarted(), note.agentMessage('{"picked":["e1"]}'), note.turnCompleted()] } });
      let catalog: { models?: { slug?: unknown }[] } = {};
      const provider = createCodexProvider({
        ...options,
        createSideCallCodex: (catalogPath) => {
          catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as typeof catalog;
          return new CodexClient({ ...codexSideCallClientOptions(options, catalogPath), spawn: fake.spawn, shutdownGraceMs: 200 });
        },
      });
      const events = await collect(provider.sideCall!(opts));
      return { events, fake, catalog };
    };
    const chosen = await ask({ ...sideCallOpts, model: "the-big-one", reasoningEffort: "high" });
    const without = await ask(sideCallOpts);
    const opened = chosen.fake.paramsOf("thread/start") ?? {};
    return {
      outcome: outcomeOf(chosen.events),
      model: opened["model"] === chosen.catalog.models?.[0]?.slug ? opened["model"] : `${String(opened["model"])} / catalogue ${String(chosen.catalog.models?.[0]?.slug)}`,
      reasoningEffort: (chosen.fake.paramsOf("turn/start") ?? {})["effort"],
      withoutEffort: (without.fake.paramsOf("turn/start") ?? {})["effort"] ?? null,
    };
  },

  "a side call streams its answer's words": async () => {
    // The app-server sends a message's deltas whether or not anyone
    // reads them; a side call passes them on, as a watched turn does.
    const caches = scratchDirectory();
    writeFileSync(join(caches, "models_cache.json"), JSON.stringify({ models: [{ slug: "the-small-one" }] }));
    const options: Parameters<typeof createCodexProvider>[0] = {
      executablePath: STUB_EXECUTABLE,
      codexHome: () => "/tmp/codex-homes/side-calls",
      sideCallModelCaches: () => [join(caches, "models_cache.json")],
    };
    const fake = fakeAppServer({
      after: { "turn/start": [note.turnStarted(), note.agentMessageDelta('{"picked":'), note.agentMessageDelta('["e1"]}'), note.agentMessage('{"picked":["e1"]}'), note.turnCompleted()] },
    });
    const provider = createCodexProvider({
      ...options,
      createSideCallCodex: (catalogPath) => new CodexClient({ ...codexSideCallClientOptions(options, catalogPath), spawn: fake.spawn, shutdownGraceMs: 200 }),
    });
    const events = await collect(provider.sideCall!(sideCallOpts));
    return { deltas: streamed(events).deltas, outcome: outcomeOf(events) };
  },

  "a side call wound down reports what it spent": async () => {
    // Interrupted with `turn/interrupt`, as a budget stop is; the turn then
    // ends, and its last usage reading is what it spent.
    const caches = scratchDirectory();
    writeFileSync(join(caches, "models_cache.json"), JSON.stringify({ models: [{ slug: "the-small-one" }] }));
    const options: Parameters<typeof createCodexProvider>[0] = {
      executablePath: STUB_EXECUTABLE,
      codexHome: () => "/tmp/codex-homes/side-calls",
      sideCallModelCaches: () => [join(caches, "models_cache.json")],
    };
    const fake = fakeAppServer({
      after: {
        "turn/start": [note.turnStarted(), note.agentMessageDelta('{"picked":["e1",')],
        "turn/interrupt": [note.tokenUsage({ input: 3_000, output: 2_100 }), note.turnCompleted("interrupted")],
      },
    });
    const provider = createCodexProvider({
      ...options,
      createSideCallCodex: (catalogPath) => new CodexClient({ ...codexSideCallClientOptions(options, catalogPath), spawn: fake.spawn, shutdownGraceMs: 200 }),
    });
    return windingDown(provider, () => fake.sent.some((message) => message.method === "turn/interrupt"));
  },

  "a turn EO stops reading is ended": async () => {
    // The app-server is a real child here, told to ignore EOF and SIGTERM
    // both, so only SIGKILL ends it. A finished Codex turn's result comes
    // after its process has been shut down (`CodexClient.runTurn`), so
    // reading past it holds that promise earlier than Claude does; the
    // turn abandoned mid-way — `turn/completed` never sent — is the
    // correction case, and the one whose ending was not waited for.
    const finished = codexOver({ ignoreEof: true, ignoreSigterm: true, after: { "turn/start": [note.turnStarted(), note.agentMessage("done"), note.turnCompleted()] } });
    const outcome = await readUntil(finished.provider.start(startOpts), (event) => event.type === "result");
    const abandoned = codexOver({ ignoreEof: true, ignoreSigterm: true, after: { "turn/start": [note.turnStarted(), note.agentMessage("Working on it.")] } });
    await readUntil(abandoned.provider.resume("thr-persisted", "carry on", { cwd: "/tmp/wt" }), (event) => event.type === "output");
    // As on Claude: the signals taken away, so the app-server cannot be
    // ended — and EOF ignored, or closing stdin would end it.
    const stuck = codexOver({ ignoreEof: true, after: { "turn/start": [note.turnStarted(), note.agentMessage("Working on it.")] } });
    const spawn = stuck.fake.spawn;
    stuck.fake.spawn = (command, args, spawnOptions) => {
      const child = spawn(command, args, spawnOptions);
      child.kill = () => true;
      return child;
    };
    const aSurvivorIsReported = await survivorReported(stuck.provider.resume("thr-persisted", "carry on", { cwd: "/tmp/wt" }), () => stuck.fake.launches.map((launch) => launch.pid));
    return { outcome, goneOnceReadPastItsResult: gone(finished.fake.launches[0]?.pid), goneOnceAbandonedMidTurn: gone(abandoned.fake.launches[0]?.pid), aSurvivorIsReported };
  },

  "a turn's whole process tree is ended": async () => {
    // The app-server is a real child that starts the two descendants a
    // pid-kill misses, as a real one starts shells and MCP servers. The
    // finished turn's app-server exits on EOF of its own accord — the
    // orderly shutdown — and leaves them to pid 1: whether Codex would
    // take them down with it is the CLI's business, and EO does not rely
    // on it.
    const finishedFile = pidFile();
    const finished = codexOver({ descendants: finishedFile, after: { "turn/start": [note.turnStarted(), note.agentMessage("done"), note.turnCompleted()] } });
    const outcome = await readUntil(finished.provider.start(startOpts), (event) => event.type === "result");
    const cancelledFile = pidFile();
    const cancelled = codexOver({ descendants: cancelledFile, after: { "turn/start": [note.turnStarted(), note.agentMessage("Working on it.")] } });
    const controller = new AbortController();
    await cancelAfterOutput(cancelled.provider.start({ ...startOpts, signal: controller.signal }), controller);
    return {
      outcome,
      goneOnceReadPastItsResult: await treeGone(finished.fake.launches.map((launch) => launch.pid), finishedFile),
      goneOnceCancelled: await treeGone(cancelled.fake.launches.map((launch) => launch.pid), cancelledFile),
    };
  },
};

// ───────────────────────────── the suite ──────────────────────────

const PROOFS: Record<Backend, Record<CapabilityName, Proof>> = { claude: CLAUDE, codex: CODEX };
const BACKENDS = Object.keys(PROOFS) as Backend[];

/**
 * Holds one backend to one capability.
 *
 * Looked up by name at run time, in a table read as though any entry
 * might be missing — because the day somebody adds a capability, one is.
 */
async function hold(capability: { name: string; same: unknown }, backend: string, proofs: Partial<Record<string, Partial<Record<string, Proof>>>>): Promise<void> {
  const proof = proofs[backend]?.[capability.name];
  if (!proof) {
    throw new Error(
      `The ${backend} adapter has no proof of "${capability.name}". Every capability on the shared list must be shown on both backends ` +
        `(invariant 12): add one to providerParity.test.ts, or take the capability away from both.`,
    );
  }
  expect(await proof(), `${backend}: ${capability.name}`).toEqual(capability.same);
}

/**
 * Capabilities whose proof starts a backend once for each of many turns,
 * and the time they get on Windows instead of the suite's 60s.
 *
 * Every Codex proof starts a real child process and ends its tree, and on
 * Windows the ending reads the process table through a PowerShell start
 * (`processTree.ts`) — a single proof takes 4–15s on a hosted runner while
 * the other slices are busy. "answer schemas sendable" starts one for each
 * of the registry's eleven answer actions and one more for the maps, so it
 * sat at the 60s limit and failed whenever the runner was slow. A timeout
 * there says nothing about the code, only about the hardware; twelve of
 * the slowest single proof seen is the budget.
 *
 * "assistant cards" is the same shape: one turn for each kind of card in
 * `ASSIST_ANSWERS_WITH_CARDS`, ten since EO-523, and it timed out at 60s
 * on a busy Windows slice the same way. Its budget is the same rule —
 * the slowest single proof seen, once per card.
 */
const SLOWEST_WINDOWS_PROOF_MS = 15_000;
const WINDOWS_TIMEOUT_MS: Partial<Record<string, number>> = {
  "answer schemas sendable": 12 * SLOWEST_WINDOWS_PROOF_MS,
  "assistant cards": ASSIST_ANSWERS_WITH_CARDS.codex.length * SLOWEST_WINDOWS_PROOF_MS,
};

describe.each(CAPABILITIES)("$name: $what", (capability) => {
  it.each(BACKENDS)(
    "holds on %s",
    async (backend) => {
      await hold(capability, backend, PROOFS);
    },
    process.platform === "win32" ? WINDOWS_TIMEOUT_MS[capability.name] : undefined,
  );
});

describe("the shared list", () => {
  it("is the twelve capabilities EO-380 names and the ones EO-385, EO-387, EO-392, EO-395, EO-412, EO-421, EO-444, EO-468, EO-470, EO-477, EO-478, EO-479, EO-487, EO-488, EO-490, EO-493, EO-494, EO-534, EO-543, EO-578, EO-587, EO-597, EO-633, EO-700 and the streaming chat added, each once", () => {
    // Pinned so that taking one off the list is a decision somebody
    // made in this file rather than a line that went missing.
    expect(CAPABILITIES.map((capability) => capability.name)).toEqual([
      "start",
      "resume",
      "lost thread",
      "non-fatal warning",
      "interrupt with usage on escalation",
      "steering",
      "steering with files",
      "quota reading",
      "MCP startup status",
      "search interception",
      "secrets reaching servers",
      "optional answer fields",
      "answer schemas sendable",
      "assistant cards",
      "a trial plan beside a draft",
      "reading a held template update",
      "cost reported",
      "instructions outside the user turn",
      "debug capture",
      "attaching files",
      "role-defined action schema",
      "streaming words",
      "reasoning on request",
      "warm start",
      "admin bearer per turn",
      "uploading files from the turn's directory",
      "warm start under the admin bearer",
      "warm start on a process that died",
      "work in progress",
      "a tool known to be running",
      "compaction reported",
      "a turn held to its budget",
      "a retry announced",
      "unread turn",
      "backend memory off",
      "scoped skills",
      "a side call returns structured output",
      "a side call streams its answer's words",
      "a side call wound down reports what it spent",
      "a side call on a chosen model and reasoning effort",
      "memory delivery and memory_read",
      "memory_note",
      "memory used in an answer",
      "agent writes through EO",
      "repository_checkout",
      "environment variables",
      "a resumed run's own usage",
      "environment variables filling server names",
      "a turn EO stops reading is ended",
      "a turn's whole process tree is ended",
    ]);
  });

  it("is proved by exactly two backends, and by nothing that is not on it", () => {
    expect(BACKENDS).toEqual(["claude", "codex"]);
    const listed = CAPABILITIES.map((capability) => capability.name as string).sort();
    // A proof for a capability no longer on the list is a test that
    // stopped running without anybody deleting it.
    for (const backend of BACKENDS) expect(Object.keys(PROOFS[backend]).sort(), backend).toEqual(listed);
  });
});

describe("the suite refuses a capability only one backend can prove (proves it is not a tautology)", () => {
  const added = { name: "a capability added today", same: { works: true } };
  const works: Proof = async () => ({ works: true });

  it("fails for both backends when a capability is added to the list and nothing proves it", async () => {
    await expect(hold(added, "claude", PROOFS)).rejects.toThrow('The claude adapter has no proof of "a capability added today"');
    await expect(hold(added, "codex", PROOFS)).rejects.toThrow('The codex adapter has no proof of "a capability added today"');
  });

  it("goes on failing for the backend that was left behind", async () => {
    const onlyClaude = { claude: { [added.name]: works }, codex: {} };
    await expect(hold(added, "claude", onlyClaude)).resolves.toBeUndefined();
    await expect(hold(added, "codex", onlyClaude)).rejects.toThrow("no proof");
  });

  it("fails a backend whose proof runs and shows something else", async () => {
    const differs = { claude: { [added.name]: works }, codex: { [added.name]: async () => ({ works: false }) } };
    await expect(hold(added, "codex", differs)).rejects.toThrow();
  });

  it("passes once both show the same thing", async () => {
    const both = { claude: { [added.name]: works }, codex: { [added.name]: works } };
    await expect(Promise.all([hold(added, "claude", both), hold(added, "codex", both)])).resolves.toBeDefined();
  });
});
