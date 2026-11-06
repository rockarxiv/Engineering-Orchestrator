import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import { DEFAULT_MODULE_TIMEOUT_MS, MAX_ATTACHMENT_ADD_PATHS, MAX_MODULE_CREATIONS_PER_RUN, MODULE_CREATION_WAITS, describeDuration, moduleInputProblems } from "@eo/core";
import type { CustomModule, Item, ModuleCreation, ModuleCreationAnswer, ModuleCreationWait, WatchNews } from "@eo/core";
import type { StepAnswer } from "../roles/answers.js";
import { killTree } from "../process/killTree.js";
import { searchPath } from "../process/searchPath.js";

/**
 * Running one module, from the outside (KAN-105).
 *
 * The host is what stops a module reaching EO; this is what stops it
 * running forever, and what stops what it printed becoming a permanent
 * copy of a secret.
 */

/**
 * How long a module may take before the whole tree is killed.
 *
 * Re-exported rather than defined here since EO-162: the number is a
 * step's setting now (`pipeline_steps.timeout_ms`), so the renderer has
 * to be able to say what "blank" means and the validator has to know what
 * an unconfigured step is bounded against. One definition, in
 * `@eo/core`'s `limits.ts`, where all three can reach it.
 */
export { DEFAULT_MODULE_TIMEOUT_MS };

/**
 * Long enough for a killed tree to actually die.
 *
 * The same reasoning as `runCommand`'s: killing is a request, not a
 * completion, and resolving early would let the caller act on a worktree
 * a dying process still holds open.
 */
const KILL_GRACE_MS = 5000;

/**
 * Caps on what the parent will hold from one run.
 *
 * `runCommand` bounds its own buffer for the same reason: a module can
 * print gigabytes, and an unbounded buffer in the *main* process is an
 * OOM of the whole app rather than a failed step.
 */
const MAX_RESULT_CHARS = 1_000_000;
const MAX_PARTIAL_LINE_CHARS = 1_000_000;

/**
 * What one run may say in the thread (EO-75).
 *
 * The transcript is buffered and bounded, so a chatty module costs
 * batched writes to `run_events` and nothing else. A comment is not:
 * each one is a row, a Jira push, a notification to every open window,
 * and a line in a thread a person reads. A loop that comments per file
 * would turn an item into a log.
 *
 * Stated rather than implicit — the numbers appear in the refusal, so a
 * module author hitting one is told what the limit is instead of
 * guessing. Sent to the host on the request so both halves apply the
 * same number, and applied here as well as there because fd 3 is an
 * inherited descriptor a module can write to directly and this side is
 * the one that owns the write (invariant #5).
 */
export const MAX_COMMENTS_PER_RUN = 10;
export const MAX_COMMENT_CHARS = 4000;

/**
 * How many files one `ctx.attach()` may name (EO-414).
 *
 * The eight a comment may carry, and the eight the agent's
 * `attachment_add` takes — one number, not a second one that agrees
 * with it. Sent to the host and applied here again, like the two above
 * and for the reason given there.
 *
 * There is no separate count of attaches per run: an attach is a
 * comment with files on it and spends one of `MAX_COMMENTS_PER_RUN`.
 */
export const MAX_ATTACH_PATHS = MAX_ATTACHMENT_ADD_PATHS;

/**
 * How many work items one run may create (EO-433).
 *
 * The number is `@eo/core`'s, because two processes hold it: this one,
 * and the record that performs the write on a managed project.
 *
 * Counted on items actually created. A call answered with an item that
 * already existed spends nothing, and neither does a refusal — and that
 * is why the count is not applied *before* the writer is asked. Whether
 * a creation is a repeat is a fact only the writer's stored lookup
 * knows, and a run that has made its ten must still be told "that one
 * already exists" for a key an earlier run used. So the writer is told
 * whether the run is at its cap and refuses only what would be new.
 */
export const MAX_CREATIONS_PER_RUN = MAX_MODULE_CREATIONS_PER_RUN;

/** What a creation past the cap is refused with. One sentence, said by whichever side refuses. */
export function creationCapRefusal(): string {
  return `a module may create ${MAX_CREATIONS_PER_RUN} items in one run, and this run has created them all.`;
}

export type { ModuleCreation, ModuleCreationAnswer };

/** The names a creation may carry. Shared with nothing: the host holds its own copy, and this side is the one that decides. */
const CREATION_FIELDS = new Set(["idempotencyKey", "type", "title", "body", "spec", "pipeline", "parent", "repository", "existingBranch", "wait", "dependsOn"]);

/** What a `wait` that is none of the three is refused with. Names them, so the refusal is also the fix. */
export function creationWaitRefusal(): string {
  return `wait is one of ${MODULE_CREATION_WAITS.map((value) => JSON.stringify(value)).join(", ")}.`;
}

/**
 * A creation event held to its shape, or the sentence saying what is
 * wrong with it.
 *
 * The host checked this before it sent the event. It is checked again
 * because the event can come from a module that never asked the host —
 * fd 3 is a descriptor it holds — and what arrives here is about to
 * become an item.
 */
function readCreation(raw: unknown): { ok: true; creation: ModuleCreation } | { ok: false; problem: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problem: "a creation is one object: { idempotencyKey, type, title, … }." };
  const given = raw as Record<string, unknown>;
  const unknown = Object.keys(given).filter((name) => !CREATION_FIELDS.has(name));
  if (unknown.length > 0) return { ok: false, problem: `a creation does not take ${unknown.map((name) => JSON.stringify(name)).join(", ")}.` };

  const text = (name: string): string | null => (typeof given[name] === "string" && (given[name] as string).trim() !== "" ? (given[name] as string).trim() : null);
  const idempotencyKey = text("idempotencyKey");
  if (idempotencyKey === null) return { ok: false, problem: "a creation needs an idempotencyKey, so that running this step twice does not create the item twice." };
  const type = text("type");
  if (type === null) return { ok: false, problem: "a creation names the type of item to create." };
  const title = text("title");
  if (title === null) return { ok: false, problem: "a creation needs a title." };

  if (given.body !== undefined && given.body !== null && typeof given.body !== "string") return { ok: false, problem: "a body is text." };
  const spec = given.spec ?? {};
  if (typeof spec !== "object" || Array.isArray(spec)) return { ok: false, problem: "spec is an object of the fields the type declares." };

  const optional: { pipeline?: string; parent?: string; repository?: string } = {};
  for (const name of ["pipeline", "parent", "repository"] as const) {
    const value = given[name];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.trim() === "") return { ok: false, problem: `${name} is a name, as text.` };
    optional[name] = value.trim();
  }
  // Absent means "cut a branch"; anything present has to be a name
  // (EO-648). Whether it is one git takes is the door's to answer.
  const branch: { existingBranch?: string } = {};
  if (given.existingBranch !== undefined) {
    const value = given.existingBranch;
    if (typeof value !== "string" || value.trim() === "") return { ok: false, problem: "existingBranch is the name of a branch that already exists, as text." };
    branch.existingBranch = value.trim();
  }

  // Who waits for whom (EO-434). Left out, both mean nothing waits; and
  // a `wait` this does not know is refused rather than read as `none`,
  // because a module that asked to be held and was not is one that runs
  // ahead of the work it filed.
  const waiting: { wait?: ModuleCreationWait; dependsOn?: string[] } = {};
  // Only an absent `wait` defaults: `null` was supplied, and is not one.
  if (given.wait !== undefined) {
    if (!(MODULE_CREATION_WAITS as readonly unknown[]).includes(given.wait)) return { ok: false, problem: creationWaitRefusal() };
    waiting.wait = given.wait as ModuleCreationWait;
  }
  if (given.dependsOn !== undefined && given.dependsOn !== null) {
    const keys = given.dependsOn;
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || key.trim() === "")) {
      return { ok: false, problem: 'dependsOn is a list of item keys, like ["EO-40"].' };
    }
    // Each key once: an edge is a fact, and saying it twice is not two.
    waiting.dependsOn = [...new Set((keys as string[]).map((key) => key.trim()))];
  }
  return {
    ok: true,
    creation: { idempotencyKey, type, title, body: (given.body as string | null | undefined) ?? "", spec: spec as Record<string, unknown>, ...optional, ...branch, ...waiting },
  };
}

/** Every string inside a value, redacted. Keys are left: they are a type's field names, which a module does not choose. */
function redactDeep(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === "string") return redactSecrets(value, env);
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, env));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactDeep(entry, env)]));
  }
  return value;
}

/**
 * How many answers a refusing module may name (EO-76).
 *
 * Five, the number `DiscussionQuestionSchema` already settled on for the
 * same reason: past five it stops being a choice and becomes a form.
 * They are rendered as buttons on the escalation comment, and a person
 * scanning a row of them is the thing the number is drawn around.
 *
 * Enforced in the host, which is the only thing that can see what the
 * module actually returned. Not re-applied below: redaction rewrites a
 * label, it cannot invent another one, so the count that arrives is the
 * count the host allowed.
 */
export const MAX_OPTIONS = 5;

/**
 * How long one of those answers may be.
 *
 * An option is a button's label and, on the way back, the text a reply
 * is matched against — so it has to be something a person can read at a
 * glance and retype. Two hundred characters is a full sentence with room
 * to spare and nowhere near a paragraph; a module with more to say has
 * `reason`, which is prose and is not capped here.
 *
 * Well under `MAX_COMMENT_CHARS`, deliberately: five of these plus the
 * reason all land in one escalation comment, and the cap on that comment
 * is not something a module should be able to spend on labels.
 *
 * Applied on both sides of the boundary, and this side is not a
 * formality. `redactSecrets` replaces a value with its *name*, and a
 * declared name has no maximum length — `ModuleNeedsSchema` checks its
 * characters and nothing else. So a one-character secret with a
 * two-hundred-character name turns an option the host passed into one
 * longer than this, after the host had finished looking. The cap has to
 * hold on the string that actually reaches the comment.
 */
export const MAX_OPTION_CHARS = 200;

/**
 * `BuiltinOutcome`, restated here so this module needs nothing from the
 * supervisor.
 *
 * `options` are the answers a refusing module named (EO-76) — the same
 * field the worktree builtin already fills with its candidate keys, and
 * the reason it is here is that it goes on to become the buttons of the
 * escalation comment `runBuiltin` posts. What counts as one is decided
 * in `offeredAnswers` in `moduleHost.mjs`, which is the only place that
 * can see what the module really returned; the length is checked again
 * here, on the redacted label, because redaction is this side's doing
 * and it can lengthen what it rewrites.
 */
export type ModuleOutcome =
  /**
   * `news` is on a check that is still waiting (EO-458): `result` is
   * `WAITING_RESULT`, which only a manifest declaring `watch: true` may
   * say — the host refuses it from any other — and each entry is
   * something that changed since EO last looked. Absent on every other
   * result.
   */
  | { ok: true; result: string; detail: string; news?: WatchNews[] }
  | { ok: false; reason: string; options?: string[] };

export interface RunModuleRequest {
  module: CustomModule;
  item: Item;
  cwd: string;
  /** The step's configured values, before the manifest's defaults are applied. */
  inputs?: Record<string, unknown>;
  /** Resolved from the keychain by the caller — this module never reads one itself. */
  env: Record<string, string>;
  /**
   * The names in `env` whose value is an environment variable rather
   * than a secret (EO-485, ARCHITECTURE.md §14.2).
   *
   * A variable is not secret and is not hidden in a transcript: it is
   * shown in full on the settings screen, and replacing `eu-west-1` with
   * `REGION` everywhere a module printed it would make the output harder
   * to read and protect nothing. So these values are left out of what is
   * redacted. Absent means every value in `env` is a secret.
   */
  variables?: readonly string[];
  /**
   * How long this module may run before the tree is killed (EO-162).
   *
   * The step's own limit when it set one, otherwise absent and
   * `DEFAULT_MODULE_TIMEOUT_MS` applies. It is also handed to the host as
   * `ctx.timeoutMs`, so a module that waits for something slow can size
   * its wait against the real ceiling rather than a copy of it that was
   * true when the module was written.
   */
  timeoutMs?: number;
  /**
   * The newest answer to this step's last question, or null (EO-183).
   *
   * Computed by the caller, which is the half of this that holds a
   * database handle: the host's is read-only and opened for `ctx.ticket()`
   * alone, and giving it a second read of its own — of the agents table,
   * to know a system agent's reading of a reply when it sees one — would
   * be a second, drifting copy of a rule EO already applies in
   * `main/roles/answers.ts`. So it arrives here already decided, beside
   * `inputs` and the caps, and `ctx.answer()` hands it over.
   *
   * Absent where the caller has nothing to say about it, which reaches a
   * module as null — the same answer as "nothing has been asked".
   */
  answer?: StepAnswer | null;
  /** Aborted when a person cancels the run, or EO shuts down. Kills the tree. */
  signal?: AbortSignal;
  /** Where the module's output goes as it arrives. */
  onOutput?: (text: string) => void;
  /**
   * Posts what `ctx.comment()` and `ctx.commentOn()` asked for (EO-75).
   *
   * Returns null when the comment landed, or the sentence saying why it
   * did not — a key nothing matches, most likely, since the host checked
   * it against an item that can be gone by the time this runs. The
   * sentence goes to the transcript rather than being swallowed.
   *
   * The body arrives redacted. That happens here rather than in the
   * caller because a caller that forgets is a token mirrored to Jira,
   * and "the caller remembered" is not a property anything can check.
   *
   * Absent on a run with nowhere to post — `runModule` says so in the
   * transcript rather than dropping the comment quietly.
   */
  onComment?: (comment: { key: string; body: string }) => string | null;
  /**
   * Attaches what `ctx.attach()` asked for to the item this run is on
   * (EO-414): checks each path against `directory`, copies the bytes
   * into the attachment store and posts the one comment they hang on.
   *
   * Resolves to null when the comment landed with every file on it, or
   * to the sentence saying why nothing was attached. Asynchronous where
   * `onComment` is not, because it reads files.
   *
   * `directory` is this run's `cwd`, handed over rather than left for
   * the caller to supply so that the directory the paths are held to is
   * the one the module actually ran in. The caption arrives redacted,
   * as a comment's body does. The files do not: EO cannot rewrite bytes
   * it does not understand, and the person approving a module that
   * declares `needs.attach` is approving what it chooses to attach.
   *
   * Absent on a run with nowhere to post, which the transcript says.
   */
  onAttach?: (attach: { paths: string[]; caption: string; directory: string }) => Promise<string | null>;
  /**
   * Creates the work item `ctx.createItem()` asked for, in the project
   * of the item this run is on (EO-433).
   *
   * Answers what the module is told: the new item's key, the key of the
   * one an earlier call with the same `idempotencyKey` made, or the
   * sentence saying why nothing was created — which `runModule` also
   * writes to the transcript.
   *
   * Called only for a module whose manifest declares `needs.create`,
   * with a creation already held to its shape. The title, the body and
   * every string in `spec` arrive redacted, as a comment's body does,
   * and for the reason given there.
   *
   * `atCap` says this run has already created `MAX_CREATIONS_PER_RUN`
   * items. It is handed over rather than applied before the call
   * because the writer is the one that knows whether this is a repeat:
   * at the cap it must still answer a key that already made an item,
   * and refuse — with `creationCapRefusal()` — only what would be new.
   *
   * Absent on a run with nowhere to create one, which the transcript
   * says.
   */
  onCreate?: (creation: ModuleCreation, limits: { atCap: boolean }) => ModuleCreationAnswer | Promise<ModuleCreationAnswer>;
}

export interface ModuleHostLauncher {
  /** The Node-capable executable. `process.execPath` with ELECTRON_RUN_AS_NODE=1 in production. */
  execPath: string;
  /** The absolute path of `moduleHost.mjs`, from `resolveResourcePaths`. */
  hostPath: string;
  /** Extra environment for the *host* process (not the module). */
  hostEnv?: Record<string, string>;
  /**
   * Where `eo.db` is, so the host can open it read-only for `ctx.item()`
   * and `ctx.itemByKey()` — and for `ctx.ticket()` and `ctx.ticketByKey()`,
   * the deprecated names beside them (EO-74, KAN-162).
   *
   * On the launcher rather than on the request because it is a fact about
   * this installation, not about one run — the same place `hostPath`
   * sits. Optional for the same reason `hostPath` is optional upstream: a
   * caller driving the engine without one (the v1 gate does) gets a
   * module whose reads answer "unavailable" in a sentence, rather than a
   * host that cannot start.
   */
  dbPath?: string;
}

/**
 * What a module host needs from EO's environment on top of `hostEnv`
 * and PATH: `SystemRoot` on Windows, nothing elsewhere (EO-613).
 *
 * Said outright rather than left to libuv, which only tops a child's
 * environment up as an implementation detail of spawning on Windows.
 */
export function systemRootEnv(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Record<string, string> {
  return platform === "win32" && env.SystemRoot ? { SystemRoot: env.SystemRoot } : {};
}

/**
 * Replaces every secret value with its name, everywhere it appears.
 *
 * `run_events` is append-only (invariant #3), which is exactly why this
 * has to happen on the way in: a token that reaches the transcript has
 * reached it permanently, and there is no later pass that can take it
 * back out. A module that prints its own token — by running a command
 * with `-v`, most likely, rather than on purpose — should not be able to
 * turn EO's durability substrate into the place that token lives.
 *
 * Longest first, so a secret that contains another is not left half
 * rewritten. Empty values are skipped: replacing "" would rewrite the
 * gap between every character.
 */
export function redactSecrets(text: string, env: Record<string, string>): string {
  const entries = Object.entries(env)
    .filter(([, value]) => value !== "")
    .sort(([, a], [, b]) => b.length - a.length);
  let out = text;
  for (const [name, value] of entries) out = out.split(value).join(`«${name}»`);
  return out;
}

/**
 * Redacts a stream arriving in chunks, without letting a secret through
 * because it straddled a pipe boundary.
 *
 * `redactSecrets` on each chunk alone is not enough: 64KB of output
 * followed by the first four characters of a token, then the rest in the
 * next write, and neither chunk contains the secret while the stream
 * plainly does. `run_events` is append-only (invariant #3), so that is a
 * leak nothing can take back out afterwards.
 *
 * So the tail of each chunk — one character less than the longest secret,
 * which is the most that can be part of a split match — is held back and
 * prepended to the next. `flush()` releases it when the stream ends.
 */
export function createRedactor(env: Record<string, string>): { push: (chunk: string) => string; flush: () => string } {
  const values = Object.values(env).filter((value) => value !== "");
  let held = "";

  /**
   * How much of the tail could still turn into a secret.
   *
   * Only a suffix that is a genuine *prefix* of some secret is worth
   * holding — usually none, so ordinary output is emitted whole. Holding
   * a fixed window instead was correct about secrets and wrong about
   * everything else: it chopped every line at an arbitrary offset, which
   * split `«TOKEN»` itself across two transcript events.
   */
  const partialTail = (text: string): number => {
    let longest = 0;
    for (const value of values) {
      const max = Math.min(value.length - 1, text.length);
      for (let length = max; length > longest; length -= 1) {
        if (text.endsWith(value.slice(0, length))) {
          longest = length;
          break;
        }
      }
    }
    return longest;
  };

  return {
    push: (chunk: string) => {
      // Redact the whole buffer *first*, then hold back. The other order
      // splits a secret that arrived complete inside one chunk, so
      // neither half matches and both are emitted verbatim — the leak
      // this function exists to prevent, caused by preventing it.
      const redacted = redactSecrets(held + chunk, env);
      const keep = redacted.length - partialTail(redacted);
      held = redacted.slice(keep);
      return redacted.slice(0, keep);
    },
    flush: () => {
      const rest = redactSecrets(held, env);
      held = "";
      return rest;
    },
  };
}

/** The manifest's declared defaults, overlaid with whatever the step configured. */
export function resolveInputs(module: CustomModule, configured: Record<string, unknown> = {}): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const [name, declared] of Object.entries(module.manifest.inputs)) {
    if (declared.default !== undefined && declared.default !== null) inputs[name] = declared.default;
  }
  // Only declared names. An input the manifest does not mention is one
  // the module cannot have been written to read, and passing it would
  // make a typo in the step's configuration look like it worked.
  for (const [name, value] of Object.entries(configured)) {
    if (name in module.manifest.inputs) inputs[name] = value;
  }
  return inputs;
}

/**
 * Runs a module in a child process and resolves with what it returned.
 *
 * Always resolves. A module that throws, hangs, imports something it may
 * not, or returns nonsense is an ordinary outcome that gets reported and
 * routed — the supervisor turns `{ ok: false }` into a parked item and
 * an escalation comment, exactly as it already does for a builtin.
 */
/**
 * The part of a run's environment that is secret, and so redacted (EO-485).
 *
 * Everything in `env` but the names that came from an environment
 * variable. A value that is *also* a secret's stays in, so a variable
 * that happens to equal a token never un-hides the token.
 */
function secretEnv(request: RunModuleRequest): Record<string, string> {
  const plain = new Set(request.variables ?? []);
  if (plain.size === 0) return request.env;
  return Object.fromEntries(Object.entries(request.env).filter(([name]) => !plain.has(name)));
}

export function runModule(launcher: ModuleHostLauncher, request: RunModuleRequest): Promise<ModuleOutcome> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_MODULE_TIMEOUT_MS;
  const secrets = secretEnv(request);

  // A configured value that is not what the manifest declared (EO-78).
  //
  // Here rather than only in `validatePipeline`, and for the reason the
  // approval check is repeated in `registry.ts`: what was true when the
  // pipeline was published is not what is true now. A manifest edited
  // afterwards can turn a perfectly good string into the wrong type, and
  // `pipeline_steps` is a table other things write. Invariant #5 — this
  // side owns the write to `ctx.inputs`, so this side is where the check
  // has to hold.
  //
  // Refused rather than dropped. Silently falling back to the default
  // would run the module with a number nobody asked for, which is a
  // deploy against the wrong environment waiting to happen — and
  // invariant #8: nothing is dropped on the floor without saying so.
  // This becomes the step's failure, so it parks the item and puts the
  // sentence in the escalation comment, which is where somebody can act
  // on it.
  const wrongTypes = moduleInputProblems(request.module.manifest, request.inputs ?? {});
  if (wrongTypes.length > 0) {
    return Promise.resolve({ ok: false, reason: `"${request.module.name}" was not run: ${wrongTypes.join(" ")} Ask the assistant to fix it on this step.` });
  }

  // What the parent will accept a result under. Sent on stdin, which the
  // host consumes before importing anything — deliberately not in the
  // environment or in argv, where `/proc/self/environ` would disclose it.
  const nonce = randomUUID();
  // What a reply to `ctx.createItem()` is signed with (EO-433). A
  // second secret rather than the nonce, and never itself written to
  // any descriptor after stdin: the replies travel on fd 5, which the
  // module can read, and a frame carrying the nonce would hand it the
  // one thing the result channel is believed on.
  const replyKey = randomBytes(32).toString("hex");

  return new Promise((resolve) => {
    const child = spawn(launcher.execPath, [launcher.hostPath], {
      cwd: request.cwd,
      windowsHide: true,
      // A new process group, so `killTree` reaches whatever the module
      // started through `ctx.exec` and not merely the host.
      detached: process.platform !== "win32",
      // fd 3 is the transcript, fd 4 is the result. Stdout belongs to the
      // module: it *will* `console.log`, and a module that could print
      // something result-shaped and have it believed is a module that can
      // make a failed deploy look like a successful one.
      //
      // fd 5 is the one channel that runs the other way after stdin has
      // closed (EO-433): the answer to each `ctx.createItem()`, which
      // has to carry the new item's key back. Stdin could not be it —
      // the host reads the request to its end before importing
      // anything, and that end is what tells it the request is whole.
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
      env: {
        // The host's own environment, not the module's: the module's is
        // in the request, and the host empties `process.env` down to it
        // before importing anything.
        ...launcher.hostEnv,
        ...systemRootEnv(process.platform, process.env),
        // The login shell's PATH as well as the inherited one (EO-655): the
        // host hands it to every `ctx.exec` child, and the import
        // preflight's `needs.bin` check searches the same directories.
        PATH: searchPath(),
      },
    });

    let result = "";
    let transcript = "";
    /** How many comments this run has actually had written (EO-75). */
    let commentsPosted = 0;
    /** How many items this run has actually created (EO-433). An answer of `existing: true` is not one. */
    let itemsCreated = 0;
    /**
     * Attaches still being written, and the chain they are written on
     * (EO-414).
     *
     * A comment is posted the moment its event is read. An attach cannot
     * be — it reads files — so it is queued, and three things follow
     * from that. While one is in flight a comment queues behind it, so
     * the thread keeps the order the module spoke in and the count each
     * is checked against is the count as of its turn. The run does not
     * resolve until the chain is empty, or an attach the module made in
     * its last line would be written after the step had already been
     * routed — or lost to a shutdown. And the chain never rejects.
     *
     * A creation (EO-433) is queued on the same chain and counted in
     * `attaching` with them, for all three reasons: the comment EO
     * posts about it has to land before whatever the module says next,
     * the cap it is checked against is the count as of its turn, and a
     * run that resolved with one pending would route the item before
     * the work it asked for existed.
     */
    let attaching = 0;
    let writes: Promise<void> = Promise.resolve();
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    /** Why handing the module to the host failed, if it did (EO-80). */
    let handoffFailure: string | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    // Redaction across chunk boundaries, not per chunk: a secret split
    // across two pipe writes appears in neither and in the stream, and
    // `run_events` is append-only.
    const redactor = createRedactor(secrets);
    const emit = (text: string): void => {
      const safe = redactor.push(text);
      if (safe !== "") request.onOutput?.(safe);
    };
    const emitRest = (): void => {
      const rest = redactor.flush();
      if (rest !== "") request.onOutput?.(rest);
    };

    /**
     * The answers the escalation will actually carry (EO-76).
     *
     * The host already decided what counts as an option — trimmed,
     * non-empty, at most `MAX_OPTIONS` of them, each within
     * `MAX_OPTION_CHARS`. This is not that check repeated for its own
     * sake. Redaction happens *here*, after the host has finished
     * looking, and `redactSecrets` does not preserve length: it swaps a
     * value for its name, and a declared name is bounded only by its
     * characters (`ModuleNeedsSchema`), never by its length. A module
     * declaring a two-hundred-character variable whose value is one
     * character turns the option `"x"` — which the host passed, because
     * it was one character — into a two-hundred-and-one character label
     * on a comment. So the cap is re-applied to the string that is
     * really going to be rendered.
     *
     * Dropped rather than truncated, for the reason the host drops:
     * half a label is an answer nobody named, and matches nothing when
     * the reply comes back. What is lost here is a button whose text
     * was mostly a secret's name anyway; the reason survives untouched,
     * and a refusal with nothing left to offer escalates on that alone.
     *
     * The count is not re-applied. Redaction rewrites labels, it cannot
     * add one — so `MAX_OPTIONS` is the host's to keep, and dropping
     * here only ever makes the row shorter.
     */
    const redactedOptions = (options: string[] | undefined): { options?: string[] } => {
      const offered = (options ?? []).map((option) => redactSecrets(option, secrets)).filter((option) => option.length <= MAX_OPTION_CHARS);
      // Omitted rather than empty, matching the host: a refusal that
      // offered nothing and a refusal whose offers did not survive
      // should reach `runBuiltin` as the same thing — a reason, and no
      // question in it.
      return offered.length > 0 ? { options: offered } : {};
    };

    const finish = (outcome: ModuleOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      // A supervisor signal outlives one run; leaving the listener on it
      // would accumulate one per module the step ever ran.
      request.signal?.removeEventListener("abort", onAbort);
      // Behind whatever is still being written (EO-414). Through the
      // chain rather than on a count of what is in flight, so a comment
      // queued behind an attach is waited for too.
      void writes.then(() => conclude(outcome));
    };

    const conclude = (outcome: ModuleOutcome): void => {
      emitRest();
      // The outcome reaches `runs.error`, `runs.result` and an escalation
      // comment, so it is redacted like everything else. A module has no
      // need to put a token in its own `reason` — but the ordinary way it
      // happens is `return { ok: false, reason: result.tail }` after a
      // command printed one, which is a mistake rather than a choice.
      //
      // `options` get the same pass, and they need it more than `reason`
      // does: the escalation comment is mirrored to Jira, so a secret
      // spread across a row of buttons would leave the machine.
      //
      // News too (EO-458), the id as well as the text: the text becomes a
      // comment, and the id is kept on the watch row for as long as the
      // watch lasts.
      resolve(
        outcome.ok
          ? {
              ok: true,
              result: outcome.result,
              detail: redactSecrets(outcome.detail, secrets),
              ...(Array.isArray(outcome.news)
                ? { news: outcome.news.map((entry) => ({ id: redactSecrets(entry.id, secrets), text: redactSecrets(entry.text, secrets) })) }
                : {}),
            }
          : { ok: false, reason: redactSecrets(outcome.reason, secrets), ...redactedOptions(outcome.options) },
      );
    };

    // The module's own stdout and stderr — a `console.log`, or a crash in
    // the host. Transcript, not result: worth showing, because the
    // alternative is a module that failed for reasons nothing recorded.
    child.stdout?.on("data", (chunk: Buffer) => emit(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => emit(chunk.toString()));

    const resultPipe = child.stdio[4];
    if (resultPipe && "on" in resultPipe) {
      resultPipe.on("data", (chunk: Buffer) => {
        // Bounded: this descriptor is writable from inside the host, so a
        // module can write to it. Only a nonce-carrying line is believed
        // (see below), but the buffer must not grow without limit before
        // anything gets to check that.
        result = (result + chunk.toString()).slice(-MAX_RESULT_CHARS);
      });
    }

    /**
     * A comment the module asked for, written by whoever wired
     * `onComment` (EO-75).
     *
     * The caps are re-applied here rather than trusted from the host.
     * The host counts too, and that is what lets it hand a module an
     * immediate answer — but fd 3 is an inherited descriptor inside the
     * host process, so a module can put a `comment` event on it without
     * going through `ctx` at all. This side owns the write, so this side
     * is where the number has to hold (invariant #5).
     *
     * Measured on the body the module wrote, before redaction: replacing
     * a token with «NAME» can lengthen it, and a comment refused for
     * being long because EO redacted it would be a limit nobody could
     * predict.
     *
     * Every refusal reaches the transcript. Nothing silently drops work
     * on the floor (invariant #8), and the module's own return value is
     * a thing it is free to ignore.
     */
    const postComment = (rawKey: string | undefined, rawBody: string): void => {
      const key = typeof rawKey === "string" && rawKey.trim() !== "" ? rawKey.trim() : request.item.key;
      const refuse = (problem: string): void => emit(`EO did not post a comment on ${key}: ${problem}\n`);

      if (rawBody.length > MAX_COMMENT_CHARS) {
        refuse(`a comment may be at most ${MAX_COMMENT_CHARS} characters and this one is ${rawBody.length}.`);
        return;
      }
      if (commentsPosted >= MAX_COMMENTS_PER_RUN) {
        refuse(`a module may post ${MAX_COMMENTS_PER_RUN} comments in one run, and this run has posted them all.`);
        return;
      }
      if (!request.onComment) {
        refuse("this run has nowhere to post one.");
        return;
      }

      // Redacted here, so no caller can forget. A secret in the
      // transcript is permanent (invariant #3); a secret in a comment
      // leaves the machine, because the comment is mirrored to Jira.
      //
      // Caught rather than allowed to propagate, and not out of caution
      // about the caller: this runs inside the fd 3 reader, whose own
      // catch treats an unparseable line as text and emits it. A throw
      // from here would take that path and print the raw event — the
      // module's body included, before this function has redacted it.
      let problem: string | null;
      try {
        problem = request.onComment({ key, body: redactSecrets(rawBody, secrets) });
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      if (problem !== null) {
        refuse(problem);
        return;
      }
      commentsPosted += 1;
    };

    /**
     * Files the module asked to attach, written by whoever wired
     * `onAttach` (EO-414).
     *
     * Everything the host checked is checked again, for the reason the
     * comment caps are: an `attach` event can be put on fd 3 by a module
     * that never called `ctx.attach`, naming any path it likes. The
     * shape, the number of paths, the caption's length and the run's
     * count are held here; where each path lies and what it is are held
     * by `onAttach`, against `request.cwd`, because that is the half
     * with a filesystem and a store in its hands.
     *
     * All or nothing. The host answered the module for the call as a
     * whole, so a comment carrying some of its files would be a comment
     * the module never asked for. Whatever is refused is said in the
     * transcript (invariant #8).
     */
    const postAttachment = async (rawPaths: unknown, rawCaption: unknown): Promise<void> => {
      const refuse = (problem: string): void => emit(`EO did not attach files to ${request.item.key}: ${problem}\n`);

      if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.some((path) => typeof path !== "string" || path === "")) {
        refuse("an attach names one or more file paths.");
        return;
      }
      const paths = rawPaths as string[];
      if (paths.length > MAX_ATTACH_PATHS) {
        refuse(`one call may attach at most ${MAX_ATTACH_PATHS} files and this one names ${paths.length}.`);
        return;
      }
      if (rawCaption !== undefined && rawCaption !== null && typeof rawCaption !== "string") {
        refuse("a caption is text.");
        return;
      }
      const caption = rawCaption ?? "";
      // Measured before redaction, as a comment's body is.
      if (caption.length > MAX_COMMENT_CHARS) {
        refuse(`a caption may be at most ${MAX_COMMENT_CHARS} characters and this one is ${caption.length}.`);
        return;
      }
      if (commentsPosted >= MAX_COMMENTS_PER_RUN) {
        refuse(`a module may post ${MAX_COMMENTS_PER_RUN} comments in one run, attachments included, and this run has posted them all.`);
        return;
      }
      if (!request.onAttach) {
        refuse("this run has nowhere to attach them.");
        return;
      }

      let problem: string | null;
      try {
        problem = await request.onAttach({ paths, caption: redactSecrets(caption, secrets), directory: request.cwd });
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      if (problem !== null) {
        refuse(problem);
        return;
      }
      commentsPosted += 1;
    };

    /**
     * Answers the host for one `ctx.createItem()` (EO-433).
     *
     * One line: an HMAC, a space, and the JSON it was computed over —
     * `{ id, payload }`. The key went to the host on stdin and is in no
     * frame, so a module that reads this descriptor learns an answer
     * and nothing it could sign another with; and it is not the nonce,
     * so nothing here helps it forge a result on fd 4. `id` is the
     * host's own name for the call and is inside what is signed, so one
     * call's answer cannot be replayed as another's. An event that
     * named none — one a module wrote to fd 3 itself — has nobody
     * waiting and is not answered.
     */
    // Indexed past what `spawn`'s type knows: it describes five
    // descriptors, and this is the sixth asked for above.
    const sixth: unknown = (child.stdio as readonly unknown[])[5];
    const replyPipe = sixth instanceof Duplex ? sixth : null;
    if (replyPipe) {
      // A host that is gone leaves this a pipe with no reader, exactly
      // as stdin can be (EO-80), and an unhandled EPIPE here would take
      // the main process with it.
      replyPipe.on("error", () => undefined);
      // Nothing is read from it. Flowing so that its end is seen when
      // the host exits and `close` is not held up waiting on it.
      replyPipe.resume();
    }
    const reply = (id: unknown, answer: ModuleCreationAnswer): void => {
      if (typeof id !== "string" || id === "") return;
      if (!replyPipe || replyPipe.destroyed || !replyPipe.writable) return;
      try {
        // ASCII only, everything else escaped. The host reads this
        // descriptor in chunks and decodes each one byte for byte, so a
        // character must never be more than one of them — a `«NAME»` in
        // a reason split across two reads would otherwise fail its own
        // signature.
        const signed = JSON.stringify({ id, payload: answer }).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
        replyPipe.write(`${createHmac("sha256", replyKey).update(signed).digest("hex")} ${signed}\n`);
      } catch {
        // The host went between the check and the write. The transcript
        // already has whatever was worth saying.
      }
    };

    /**
     * A work item the module asked for, created by whoever wired
     * `onCreate` (EO-433).
     *
     * Everything the host refused is refused here again, and `needs.create`
     * first: this is the one need of its kind that is enforced, and an
     * enforcement the module's own process could step round — by writing
     * the event to fd 3 without asking `ctx` — would not be one. This
     * side owns the write, so this side is where the manifest, the shape
     * and the count have to hold (invariant #5). The count is kept here
     * and enforced by the writer, which is the only thing that can tell
     * an eleventh item from a repeat of one already made.
     *
     * Every refusal reaches the transcript as well as the module
     * (invariant #8): a module is free to ignore what it was answered.
     */
    const postCreation = async (id: unknown, raw: unknown): Promise<void> => {
      const refuse = (problem: string): void => {
        emit(`EO did not create an item from ${request.item.key}: ${problem}\n`);
        reply(id, { created: false, reason: problem });
      };

      if (request.module.manifest.needs.create !== true) {
        refuse(`"${request.module.name}" does not declare needs.create in its manifest, so it may not create items.`);
        return;
      }
      const read = readCreation(raw);
      if (!read.ok) {
        refuse(read.problem);
        return;
      }
      if (!request.onCreate) {
        refuse("this run has nowhere to create one.");
        return;
      }

      // Redacted here, so no caller can forget — as a comment's body is,
      // and with more at stake: an item's title is on a board, in a
      // prompt, and in Jira where the item is mirrored. The idempotency
      // key is stored too, so it gets the same pass; the same key is
      // rewritten the same way on a repeat, so it still matches.
      const creation: ModuleCreation = {
        ...read.creation,
        idempotencyKey: redactSecrets(read.creation.idempotencyKey, secrets),
        title: redactSecrets(read.creation.title, secrets),
        body: redactSecrets(read.creation.body, secrets),
        spec: redactDeep(read.creation.spec, secrets) as Record<string, unknown>,
      };

      let answer: ModuleCreationAnswer;
      try {
        // The cap as of this creation's turn — the chain runs one at a
        // time — and the writer's to apply, after it has looked for an
        // item this key already made. See `MAX_CREATIONS_PER_RUN`.
        answer = await request.onCreate(creation, { atCap: itemsCreated >= MAX_CREATIONS_PER_RUN });
      } catch (error) {
        answer = { created: false, reason: error instanceof Error ? error.message : String(error) };
      }
      if (!answer.created) {
        refuse(answer.reason);
        return;
      }
      if (!answer.existing) itemsCreated += 1;
      reply(id, answer);
    };

    const queueCreation = (id: unknown, creation: unknown): void => {
      attaching += 1;
      writes = writes
        .then(() => postCreation(id, creation))
        .catch(() => undefined)
        .finally(() => {
          attaching -= 1;
        });
    };

    /** Runs one write in the order its event arrived. See `writes`. */
    const queueAttachment = (paths: unknown, caption: unknown): void => {
      attaching += 1;
      writes = writes
        .then(() => postAttachment(paths, caption))
        // `postAttachment` catches what it calls; this is for `emit`
        // itself failing, and keeps one bad write from ending the chain.
        .catch(() => undefined)
        .finally(() => {
          attaching -= 1;
        });
    };
    const queueOrPostComment = (key: string | undefined, body: string): void => {
      if (attaching === 0) {
        postComment(key, body);
        return;
      }
      writes = writes.then(() => postComment(key, body)).catch(() => undefined);
    };

    const transcriptPipe = child.stdio[3];
    if (transcriptPipe && "on" in transcriptPipe) {
      transcriptPipe.on("data", (chunk: Buffer) => {
        transcript += chunk.toString();
        // Newline-delimited JSON: whole lines only, since a chunk can
        // split one. A partial line is held — so it is bounded too, or a
        // module writing megabytes with no newline grows this until the
        // main process runs out of memory.
        const lines = transcript.split("\n");
        transcript = (lines.pop() ?? "").slice(-MAX_PARTIAL_LINE_CHARS);
        for (const line of lines) {
          if (line.trim() === "") continue;
          try {
            const event = JSON.parse(line) as {
              type?: string;
              text?: string;
              bin?: string;
              args?: string[];
              key?: string;
              body?: string;
              paths?: unknown;
              caption?: unknown;
              id?: unknown;
              creation?: unknown;
            };
            if (event.type === "output" && typeof event.text === "string") emit(event.text);
            // Every shell-out is logged. `needs.bin` is a promise EO
            // keeps, and the transcript is where it is kept visibly.
            else if (event.type === "exec") emit(`$ ${event.bin} ${(event.args ?? []).join(" ")}\n`);
            else if (event.type === "comment" && typeof event.body === "string") queueOrPostComment(event.key, event.body);
            else if (event.type === "attach") queueAttachment(event.paths, event.caption);
            else if (event.type === "create") queueCreation(event.id, event.creation);
          } catch {
            emit(line);
          }
        }
      });
    }

    /**
     * The outcome the host signed, or null.
     *
     * Only a line carrying the nonce sent on stdin is believed. The
     * result descriptor is an inherited fd inside the host process, so a
     * module can write to it — an unsigned line is therefore something
     * that turned up on the channel rather than an answer, and is
     * ignored rather than parsed.
     */
    const signedOutcome = (): ModuleOutcome | null => {
      for (const line of result.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const framed = JSON.parse(line) as { nonce?: unknown; payload?: unknown };
          if (framed.nonce === nonce && framed.payload !== undefined) return framed.payload as ModuleOutcome;
          // eslint-disable-next-line no-empty
        } catch {}
      }
      return null;
    };

    const settle = (): void => {
      const outcome = signedOutcome();
      // Preferred over the timeout, deliberately. The host writes its
      // answer the moment the module returns, but `close` cannot fire
      // while the event loop is non-empty — so a module that succeeded
      // and left an interval running is killed at the timeout with a
      // valid result already in hand. Reporting that as a timeout parks
      // the item for work that finished.
      if (outcome !== null) {
        finish(outcome);
        return;
      }
      if (cancelled) {
        finish({ ok: false, reason: "This module was cancelled." });
        return;
      }
      if (timedOut) {
        finish({
          ok: false,
          // Says which limit, because it is a setting now and the whole
          // point of raising it is knowing that you can (EO-162). The
          // sentence reaches the escalation comment `runBuiltin` posts,
          // which is where somebody decides whether their CI simply needs
          // longer.
          reason:
            `This module ran for longer than ${describeDuration(timeoutMs)} and was stopped. ` +
            `That is this step's time limit — ask the assistant to raise it on the step if the work genuinely takes longer.`,
        });
        return;
      }
      // The host was never given the module (EO-80). Checked before the
      // sentence below, because that sentence is about a module that
      // ran, and this is a host that exited before one could — so
      // whatever else went wrong, saying "a promise it awaited" would
      // send somebody looking at a module that never started.
      if (handoffFailure !== null) {
        finish({ ok: false, reason: `EO could not hand this module to its host, which exited before reading it: ${handoffFailure}` });
        return;
      }
      if (result.trim() === "") {
        // The host ended without answering. The likeliest cause is a
        // module that awaited something that never settles — Node's loop
        // empties and the process exits cleanly, which looks like success
        // and is not.
        finish({ ok: false, reason: "This module ended without returning a result. A promise it awaited may never have settled." });
        return;
      }
      finish({ ok: false, reason: "This module produced no result EO could trust. Anything written to the result channel by the module itself is ignored." });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
      // Not resolved here: the kill is a request, and on Windows it is an
      // async `taskkill`. Waiting for 'close' means the OS has reaped it;
      // the grace timer means a genuinely unkillable process cannot hang
      // EO either, which is the thing this timeout exists to prevent.
      graceTimer = setTimeout(settle, KILL_GRACE_MS);
      graceTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => finish({ ok: false, reason: `The module host could not be started: ${error.message}` }));

    child.on("close", settle);

    // Cancellation kills the tree, exactly as the timeout does. The
    // difference is only who asked: a person moving the item, pausing
    // with cancellation, or closing EO. Without this the subprocess
    // outlived the run row that represented it.
    const onAbort = (): void => {
      cancelled = true;
      if (child.pid !== undefined) killTree(child.pid);
      graceTimer = setTimeout(() => finish({ ok: false, reason: "This module was cancelled." }), KILL_GRACE_MS);
      graceTimer.unref?.();
    };
    if (request.signal) {
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    }

    // A write with nobody at the other end (EO-80).
    //
    // The request goes to the host over stdin, and a host that is gone
    // before it reads leaves this write against a pipe with no reader:
    // EPIPE, on a stream with no `error` listener, which Node raises as
    // an uncaught exception in the main process. A module that could not
    // be started would have taken EO down with it. Electron's own binary
    // exits that way on a machine missing the shared libraries it links
    // against, which is how this was found.
    //
    // Recorded rather than settled here. `close` is still coming, and
    // the host's own stderr arrives before it — so the transcript keeps
    // whatever the runtime said about why it could not start, and the
    // reason `settle` builds says which half of the handshake failed.
    child.stdin?.on("error", (error: Error) => {
      handoffFailure ??= error.message;
    });

    child.stdin?.end(
      JSON.stringify({
        nonce,
        code: request.module.code,
        needs: request.module.manifest.needs,
        // Whether this module may answer `waiting` (EO-458). The host is
        // where a return value is read, so it is where one from a module
        // that never declared it can wait is refused.
        watch: request.module.manifest.watch === true,
        inputs: resolveInputs(request.module, request.inputs),
        // The key, not the row (EO-74). The host reads the item itself,
        // through its own read-only handle, so that `ctx.item()` and
        // `ctx.itemByKey()` answer with one shape built in one place —
        // a copy sent from here would be a second, staler version of it.
        itemKey: request.item.key,
        // One source for the caps (EO-75). The host applies them so a
        // module gets an immediate, accurate refusal; this side applies
        // them again because it is what writes.
        comments: { maxPerRun: MAX_COMMENTS_PER_RUN, maxChars: MAX_COMMENT_CHARS },
        // And how many files one attach may name (EO-414), likewise.
        attachments: { maxPaths: MAX_ATTACH_PATHS },
        // And how many items one run may create (EO-433), likewise.
        creations: { maxPerRun: MAX_CREATIONS_PER_RUN },
        // What the host verifies each answer to a creation with. Sent
        // here because stdin is the one channel a module never sees.
        replyKey,
        // And for the answers a refusal may name (EO-76), sent for the
        // same reason: the host checks what the module returned, this
        // side checks what redaction left, and a cap that lived in two
        // files would be a promise the escalation comment broke the day
        // one of them was edited.
        options: { max: MAX_OPTIONS, maxChars: MAX_OPTION_CHARS },
        // The ceiling this run is actually held to (EO-162), so a module
        // can size its own waiting against a real number. Sent for the
        // reason the comment caps are: the parent is what enforces it, and
        // a module reading a second copy of the figure would be reading
        // one that can disagree with the timer that will stop it.
        timeoutMs,
        // What `ctx.answer()` answers with (EO-183). Sent rather than
        // read over there for the reason the item key is sent rather
        // than the row: one shape, built in one place, by the side that
        // owns the rules about who counts as having answered.
        answer: request.answer ?? null,
        dbPath: launcher.dbPath ?? null,
        cwd: request.cwd,
        env: request.env,
      }),
    );
  });
}
