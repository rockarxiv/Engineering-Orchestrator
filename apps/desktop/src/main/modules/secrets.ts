import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretStore } from "../secrets/store.js";

/**
 * The named secrets a module can be given (KAN-105).
 *
 * A deploy module wants `FLY_API_TOKEN`, and until this exists there is
 * nowhere for that value to be. It could not come from the machine's own
 * environment: EO is a desktop app launched from a dock, so `process.env`
 * holds whatever the login session had, which is both unpredictable and
 * far more than a module should see. It could not go in the database
 * either — the design is explicit that secrets live in the OS
 * keychain and never in SQLite.
 *
 * So: the same arrangement the Jira token already uses. The key is the OS
 * keychain's, the ciphertext is a file under `userData`, and a module
 * receives only the names its manifest declared.
 *
 * A value is never in the database, and no listing here returns one.
 * The one way a stored value leaves this module for a screen is
 * `readEntry`, called by `moduleSecrets:reveal` when the person presses
 * Reveal on the desktop (EO-489, ARCHITECTURE.md §14.2): the machine half
 * of the contract, so never on a server, never through an eo_admin tool,
 * and never for the organisation's store or for a reference.
 */

export interface ModuleSecretsOptions {
  /** `app.getPath("userData")/module-secrets` in production. */
  directory: string;
  store: SecretStore;
  /**
   * The environment a reference is resolved against (EO-416).
   *
   * Absent in production, which means the main process's own
   * `process.env`, read at the moment of asking — whatever EO was
   * launched with. No shell is run to ask for the login shell's. A seam
   * so a test can say what EO "was started with" without writing to the
   * test runner's own environment.
   */
  environment?: Readonly<Record<string, string | undefined>>;
}

const PREFIX = "secret-";
const SUFFIX = ".bin";
const STEPS = "steps";
/**
 * A reference's own file, beside the value's and deliberately not one.
 *
 * A reference is not a secret at rest: it is the *name* of a variable,
 * which is allowed to cross IPC and to be shown on a screen. So it is
 * written in the clear and never touches the keychain — which is what
 * lets one be set on a machine where `storeSecret` refuses for want of
 * a keyring. It lives in the scope's directory all the same, so that
 * removing a step's directory (`clearStepSecrets`) removes its
 * references with its values and nothing else has to remember to.
 */
const REFERENCE_PREFIX = "reference-";
const REFERENCE_SUFFIX = ".json";
/**
 * An environment variable's own file (EO-485, ARCHITECTURE.md §14.2).
 *
 * A third kind of entry in the same scope directory, for the reason a
 * reference is kept there: a variable is not a secret, so it is written
 * in the clear and never touches the keychain — saving one works on a
 * machine with no keyring — and removing a step's directory
 * (`clearStepSecrets`) removes its variables with everything else the
 * step set. It is not a kind of secret all the same: none of the
 * secret listings below read these files, and only `environmentFor`
 * and the variable functions do.
 */
const VARIABLE_PREFIX = "variable-";
const VARIABLE_SUFFIX = ".json";
/** The shape `ModuleNeedsSchema` holds `needs.env` to, and `fileFor` a name. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Which step's value this is, or null for the one every step shares.
 *
 * A secret is per *step*, not per pipeline: one pipeline can deploy to
 * staging and then to production, and those are two `deploy` steps
 * running the same module with two different tokens. Scoping to the
 * pipeline would have made that the one arrangement it could not express.
 *
 * Null is the ordinary case and the fallback — a name set globally is
 * what every step gets unless that step says otherwise.
 */
export type SecretScope = string | null;

/**
 * Where a redirected step's trial-only values are kept (EO-584,
 * ARCHITECTURE.md, "Step modes on a trial"): a scope of their own beside
 * the step's, so the same step reads its own on live work and these on a
 * trial item. A scope is any string — `directoryFor` hashes it — and the
 * prefix keeps it from ever being a step id.
 */
export function trialScopeOf(stepId: string): string {
  return `trial:${stepId}`;
}

/**
 * Whose values a run on a step reads (EO-584).
 *
 * `stepId` is the scope of the step's own values. For a step of a trial
 * copied from a live pipeline that is the live step's scope (read, never
 * written), so a real step on a trial reads exactly what the published
 * step reads.
 *
 * `trialScope` is set for a step a trial plan redirects, on a trial item:
 * the trial-only scope that takes the place of the step's own. A name the
 * step's own scope sets and the trial scope does not is given nothing
 * rather than the shared value — the step was set up to replace the
 * shared value, and a redirect that fell through to it could point the
 * real code at whatever the shared value names.
 */
export interface StepScope {
  stepId: string | null;
  trialScope?: string;
}

/**
 * Where one scope's secrets live.
 *
 * A directory per step rather than a decorated filename, so removing a
 * step is removing a directory and listing one stays a readdir.
 *
 * The id is hashed rather than checked. A step id is whatever created the
 * step — the editor mints one, and the architect invents them in a draft
 * — and nothing in EO constrains its shape, so a rule invented here would
 * be a rule enforced nowhere else. Checking it made `deploy.production` a
 * step that threw at dispatch, which reached the person as a parked
 * item and an internal complaint about path building. Hashing makes
 * every id a legal directory name, keeps the path un-escapable, and
 * cannot refuse anything.
 */
function directoryFor(options: ModuleSecretsOptions, scope: SecretScope): string {
  if (scope === null) return options.directory;
  return join(options.directory, STEPS, createHash("sha256").update(scope).digest("hex"));
}

/**
 * A secret's name is part of a path, so it is checked rather than escaped.
 *
 * The same rule `fileFor` applies to an owner id, and stricter than it
 * needs to be on purpose: environment variable names are conventionally
 * this shape anyway, so nothing legitimate is refused.
 */
function fileFor(directory: string, name: string): string {
  if (!NAME_PATTERN.test(name)) throw new Error(`refusing to build a secret path from ${JSON.stringify(name)}`);
  return join(directory, `${PREFIX}${name}${SUFFIX}`);
}

/** Where a name's reference is kept. The same check, for the same reason. */
function referenceFileFor(directory: string, name: string): string {
  if (!NAME_PATTERN.test(name)) throw new Error(`refusing to build a reference path from ${JSON.stringify(name)}`);
  return join(directory, `${REFERENCE_PREFIX}${name}${REFERENCE_SUFFIX}`);
}

/** Where a name's environment variable is kept (EO-485). The same check, for the same reason. */
function variableFileFor(directory: string, name: string): string {
  if (!NAME_PATTERN.test(name)) throw new Error(`refusing to build a variable path from ${JSON.stringify(name)}`);
  return join(directory, `${VARIABLE_PREFIX}${name}${VARIABLE_SUFFIX}`);
}

/**
 * Whether a failed read means "no such entry" (EO-485 review).
 *
 * Only a file that is not there is absent. Anything else — a file this
 * process may not read, an I/O error — means something *is* there and
 * could not be read, which is `unreadable`: folding it into absent let a
 * step's entry that had been made unreadable fall back to the shared
 * one, and let a second entry of the other kind be saved beside it.
 */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

export type StoreSecretResult = { ok: true } | { ok: false; reason: string };

export function storeSecret(options: ModuleSecretsOptions, name: string, value: string, scope: SecretScope = null): StoreSecretResult {
  // Writing in the clear would quietly break the one promise this module
  // exists to keep, so it refuses and says why — as `storeToken` does.
  if (!options.store.isEncryptionAvailable()) {
    return {
      ok: false,
      reason:
        "This machine has no OS keychain available, so EO cannot store a module secret safely. " +
        "On Linux that usually means no keyring is running (gnome-keyring or kwallet).",
    };
  }
  const directory = directoryFor(options, scope);
  mkdirSync(directory, { recursive: true });
  writeFileSync(fileFor(directory, name), options.store.encryptString(value), { mode: 0o600 });
  // In one scope a name holds a value or a reference, never both
  // (EO-416). After the write rather than before it: a refusal above
  // must leave the reference that was working exactly where it was.
  rmSync(referenceFileFor(directory, name), { force: true });
  return { ok: true };
}

/**
 * Points a name at one of EO's own environment variables (EO-416).
 *
 * "Read this from EO's variable X", resolved at dispatch. X defaults to
 * the declared name and may differ — `JAVA_HOME` read from
 * `JDK21_HOME`. It is held to the name pattern, by throwing, as a
 * secret's name is: both IPC and the manifest refuse anything else long
 * before this.
 *
 * Any stored value in the same scope is removed, and removed *first*:
 * should the two ever be on disk together it is because a write was
 * interrupted, and `readEntry` reads that as the value — so the order
 * here is the one in which an interruption leaves nothing rather than a
 * value the person had just asked to be rid of. That value is gone for
 * good, which is why the caller is told one was there.
 *
 * No keychain is asked for anything. A variable's name is not a secret.
 */
export function storeReference(options: ModuleSecretsOptions, name: string, variable: string = name, scope: SecretScope = null): void {
  if (!NAME_PATTERN.test(variable)) throw new Error(`refusing to reference ${JSON.stringify(variable)}, which is not a variable name`);
  const directory = directoryFor(options, scope);
  const path = referenceFileFor(directory, name);
  mkdirSync(directory, { recursive: true });
  rmSync(fileFor(directory, name), { force: true });
  writeFileSync(path, JSON.stringify({ variable }), { mode: 0o600 });
}

/**
 * What is behind a name in one scope.
 *
 * "Unreadable" is a third answer rather than a kind of absent: the file
 * is there, and it was written by another machine or before a keychain
 * reset. Folding it into absent is what let a step's unreadable override
 * fall back to the *shared* value — a production step quietly running on
 * the staging token, with the screen still saying the override was in
 * effect. It has to be distinguishable to be refused.
 */
export type SecretRead = { state: "value"; value: string } | { state: "absent" } | { state: "unreadable" };

export function readSecretEntry(options: ModuleSecretsOptions, name: string, scope: SecretScope = null): SecretRead {
  // Outside the try, deliberately. The catch below means "no such file",
  // which is an ordinary answer; a name that is not a name is a
  // programmer error, and swallowing it would report a refused path as an
  // unset secret — the one answer guaranteed to send someone looking in
  // the wrong place.
  const path = fileFor(directoryFor(options, scope), name);

  let encrypted: Buffer;
  try {
    encrypted = readFileSync(path);
  } catch (error) {
    return isMissing(error) ? { state: "absent" } : { state: "unreadable" };
  }
  try {
    return { state: "value", value: options.store.decryptString(encrypted) };
  } catch {
    return { state: "unreadable" };
  }
}

/** The value, or null for either kind of nothing. */
export function readSecret(options: ModuleSecretsOptions, name: string, scope: SecretScope = null): string | null {
  const read = readSecretEntry(options, name, scope);
  return read.state === "value" ? read.value : null;
}

/** Removes whatever the name holds in this scope — a stored value or a reference (EO-416). */
export function clearSecret(options: ModuleSecretsOptions, name: string, scope: SecretScope = null): void {
  const directory = directoryFor(options, scope);
  rmSync(fileFor(directory, name), { force: true });
  rmSync(referenceFileFor(directory, name), { force: true });
}

/**
 * What a name holds in one scope, of either kind (EO-416).
 *
 * A stored value is read first, so the keychain-backed file wins should
 * both ever be present — see `storeReference` for why that is the safe
 * way round.
 *
 * A reference file that does not say which variable — truncated, edited
 * by hand — is `unreadable` rather than absent, for the reason an
 * undecryptable value is: something is there, the person believes it is
 * in effect, and reading it as nothing would let a step fall back to the
 * shared entry behind their back.
 */
export type ScopeEntry = SecretRead | { state: "reference"; variable: string };

export function readEntry(options: ModuleSecretsOptions, name: string, scope: SecretScope = null): ScopeEntry {
  const stored = readSecretEntry(options, name, scope);
  if (stored.state !== "absent") return stored;

  let text: string;
  try {
    text = readFileSync(referenceFileFor(directoryFor(options, scope), name), "utf8");
  } catch (error) {
    return isMissing(error) ? { state: "absent" } : { state: "unreadable" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const variable = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["variable"] : undefined;
    if (typeof variable === "string" && NAME_PATTERN.test(variable)) return { state: "reference", variable };
  } catch {
    // Falls through to the one answer below.
  }
  return { state: "unreadable" };
}

/**
 * What EO's own environment holds for a variable, or null.
 *
 * Absent and empty are one answer. An empty variable is how a launcher
 * says "unset" as often as not, and handing a module `JAVA_HOME=""`
 * would let it get as far as a failure nobody can read — the argument
 * `environmentFor` makes for a name with no stored value.
 */
function fromEnvironment(options: ModuleSecretsOptions, variable: string): string | null {
  const value = (options.environment ?? process.env)[variable];
  return value === undefined || value === "" ? null : value;
}

/**
 * A scope's entry, with a reference followed (EO-416).
 *
 * `dangling` is the fourth answer and, like `unreadable`, it is kept
 * apart from absent so that it can be refused: the scope *does* say
 * where this name comes from, and the place it names has nothing.
 */
type Resolved = SecretRead | { state: "dangling"; variable: string };

function resolveEntry(options: ModuleSecretsOptions, name: string, scope: SecretScope): Resolved {
  const entry = readEntry(options, name, scope);
  if (entry.state !== "reference") return entry;
  const value = fromEnvironment(options, entry.variable);
  return value === null ? { state: "dangling", variable: entry.variable } : { state: "value", value };
}

/**
 * A scope's entry of any of the three kinds (EO-485): a secret, a
 * reference, or an environment variable.
 *
 * `plain` is a value that came from a variable, kept apart from `value`
 * so that what is not a secret is not treated as one — not counted as a
 * set secret, and not redacted from a transcript. A secret is read
 * first: in one scope a name is one or the other, and should both ever
 * be on disk the keychain-backed entry is the one the person set as a
 * secret.
 */
type ResolvedAny = Resolved | { state: "plain"; value: string };

function resolveAnyEntry(options: ModuleSecretsOptions, name: string, scope: SecretScope): ResolvedAny {
  const secret = resolveEntry(options, name, scope);
  if (secret.state !== "absent") return secret;
  const variable = readVariableEntry(options, name, scope);
  return variable.state === "value" ? { state: "plain", value: variable.value } : variable;
}

/**
 * What a scope's environment variable holds (EO-485).
 *
 * Three answers, as a secret has. A file that is there and does not say
 * what the value is — truncated, edited by hand — is `unreadable`, so
 * that a step's broken variable stops the fallback rather than quietly
 * handing the step the shared entry it was set up to replace.
 */
export type VariableRead = { state: "value"; value: string } | { state: "absent" } | { state: "unreadable" };

/**
 * Sets a name's environment variable in one scope (EO-485).
 *
 * Written in the clear, and no keychain is asked for anything: a
 * variable is not a secret. Whether the name is already a secret in
 * this scope is the caller's to refuse — `setEnvironmentVariable` does,
 * with a sentence — because this is the layer that stores, and a store
 * that silently removed a secret the person may have kept no copy of
 * would be the one way to lose one here.
 */
export function storeVariable(options: ModuleSecretsOptions, name: string, value: string, scope: SecretScope = null): void {
  const directory = directoryFor(options, scope);
  const path = variableFileFor(directory, name);
  mkdirSync(directory, { recursive: true });
  // Written beside and renamed over, so an interrupted write never leaves
  // a truncated variable, and a file already there that this process may
  // not read or write — an unreadable entry the person is replacing — is
  // replaced rather than refused with an error from the filesystem.
  const pending = `${path}.${process.pid}.tmp`;
  writeFileSync(pending, JSON.stringify({ value }), { mode: 0o600 });
  renameSync(pending, path);
}

export function readVariableEntry(options: ModuleSecretsOptions, name: string, scope: SecretScope = null): VariableRead {
  // Outside the try for `readSecretEntry`'s reason: a name that is not a
  // name is a programmer error, not an unset variable.
  const path = variableFileFor(directoryFor(options, scope), name);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return isMissing(error) ? { state: "absent" } : { state: "unreadable" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const value = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["value"] : undefined;
    // Empty is refused on the way in, for `fromEnvironment`'s reason, so
    // an empty one on disk is not something EO wrote.
    if (typeof value === "string" && value !== "") return { state: "value", value };
  } catch {
    // Falls through to the one answer below.
  }
  return { state: "unreadable" };
}

/** Removes a name's environment variable from one scope (EO-485). Nothing else the name holds is touched. */
export function clearVariable(options: ModuleSecretsOptions, name: string, scope: SecretScope = null): void {
  rmSync(variableFileFor(directoryFor(options, scope), name), { force: true });
}

/** Whether a name has an environment variable in this scope at all, readable or not (EO-485). */
export function hasVariable(options: ModuleSecretsOptions, name: string, scope: SecretScope = null): boolean {
  return readVariableEntry(options, name, scope).state !== "absent";
}

/** The names with an environment variable in one scope, whatever state it is in. */
function variableNames(options: ModuleSecretsOptions, scope: SecretScope): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directoryFor(options, scope));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith(VARIABLE_PREFIX) && entry.endsWith(VARIABLE_SUFFIX))
    .map((entry) => entry.slice(VARIABLE_PREFIX.length, entry.length - VARIABLE_SUFFIX.length))
    .filter((name) => NAME_PATTERN.test(name))
    .sort();
}

/** One environment variable, with its value — which, unlike a secret's, is listed and shown in full (EO-485). */
export interface VariableListing {
  name: string;
  value: string;
}

/**
 * The environment variables in one scope that a run would be given (EO-485).
 *
 * A file that no longer parses is left out, for `listSecretNames`'
 * reason: there is no value to show, and listing the name would have the
 * screen promise something a run then refuses.
 */
export function listVariables(options: ModuleSecretsOptions, scope: SecretScope = null): VariableListing[] {
  const listed: VariableListing[] = [];
  for (const name of variableNames(options, scope)) {
    const read = readVariableEntry(options, name, scope);
    if (read.state === "value") listed.push({ name, value: read.value });
  }
  return listed;
}

/**
 * The environment variables an agent run on one step is given (EO-487,
 * ARCHITECTURE.md §14.2): every shared variable, with the step's own
 * over them name by name.
 *
 * Every one, not a declared few: an agent's shell and tools are what
 * read them, and nothing declares what those will want. Secrets are not
 * here — an agent run is given variables and nothing else.
 *
 * A step variable that is there and cannot be read stops the fallback
 * for its name, for the reason it does in `environmentFor`: the step was
 * set up to replace the shared value, and handing the run the value it
 * was set up to replace is worse than handing it none.
 *
 * Read from disk on every call and held by nothing, so an edit reaches
 * the next run without EO restarting. Null is a run on no step.
 */
export function agentRunVariables(options: ModuleSecretsOptions, stepId: SecretScope, trialScope?: string): Record<string, string> {
  // A Map, and own properties made from it, rather than assignment into
  // an object literal: `__proto__` is a valid variable name, and
  // assigning it on a plain object calls the inherited setter instead of
  // making a property — the variable would vanish without a word.
  const variables = new Map<string, string>();
  for (const { name, value } of listVariables(options)) variables.set(name, value);
  // A redirected step on a trial item (EO-584): the step's own names are
  // withheld — never the shared value in their place — and its trial-only
  // ones laid over what is left.
  if (trialScope !== undefined && stepId !== null) for (const name of variableNames(options, stepId)) variables.delete(name);
  const scope = trialScope ?? stepId;
  if (scope !== null) {
    for (const name of variableNames(options, scope)) {
      const read = readVariableEntry(options, name, scope);
      if (read.state === "value") variables.set(name, read.value);
      else variables.delete(name);
    }
  }
  return Object.fromEntries(variables);
}

/**
 * The variables a redirected step's run must start without (EO-584): the
 * names its own scope sets that its trial-only scope gives no value for.
 * `agentRunVariables` already leaves them out of what it hands the run;
 * these are what the backend is told to take out of what the CLI would
 * otherwise inherit from EO's own environment, which no map of values can
 * do.
 */
export function redirectWithheldVariables(options: ModuleSecretsOptions, stepId: string, trialScope: string): string[] {
  const redirected = new Set(listVariables(options, trialScope).map((variable) => variable.name));
  return variableNames(options, stepId).filter((name) => !redirected.has(name));
}

/** The names with an entry of either kind in one scope, whatever state it is in. */
function entryNames(options: ModuleSecretsOptions, scope: SecretScope): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directoryFor(options, scope));
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith(PREFIX) && entry.endsWith(SUFFIX)) names.add(entry.slice(PREFIX.length, entry.length - SUFFIX.length));
    else if (entry.startsWith(REFERENCE_PREFIX) && entry.endsWith(REFERENCE_SUFFIX)) {
      names.add(entry.slice(REFERENCE_PREFIX.length, entry.length - REFERENCE_SUFFIX.length));
    }
  }
  // A file somebody dropped in the directory under a name that is not
  // one would throw in `fileFor`; it is not an entry, so it is not listed.
  return [...names].filter((name) => NAME_PATTERN.test(name)).sort();
}

/**
 * The names holding a stored value in one scope, readable or not (EO-417).
 *
 * `listSecretNames` leaves out a value that no longer decrypts, because
 * "set" means a dispatch would get one. This answers the other question —
 * is there something here a reference would replace — and an unreadable
 * value is replaced, and lost, exactly as a readable one is. Decided the
 * way `setModuleSecret` decides `replaced`, so the warning shown before a
 * write and the answer given after it cannot disagree. Names, never values.
 */
export function listStoredNames(options: ModuleSecretsOptions, scope: SecretScope = null): string[] {
  return entryNames(options, scope).filter((name) => {
    const state = readEntry(options, name, scope).state;
    return state === "value" || state === "unreadable";
  });
}

/**
 * One name that is a reference, as a screen may be told about it.
 *
 * The variable's *name* and whether EO has it — never what it holds.
 * Names may cross IPC; the variable's value never does, and Reveal does
 * not open a reference (EO-489).
 */
export interface ReferenceListing {
  name: string;
  /** Which of EO's variables it reads. */
  variable: string;
  /** Whether EO's environment has that variable, non-empty — whether a dispatch would get a value. */
  available: boolean;
}

/** The references in one scope, resolving or not (EO-416). */
export function listReferences(options: ModuleSecretsOptions, scope: SecretScope = null): ReferenceListing[] {
  const listed: ReferenceListing[] = [];
  for (const name of entryNames(options, scope)) {
    const entry = readEntry(options, name, scope);
    if (entry.state === "reference") listed.push({ name, variable: entry.variable, available: fromEnvironment(options, entry.variable) !== null });
  }
  return listed;
}

/**
 * Forgets everything one step overrode.
 *
 * Called when the step goes away. A step's overrides are reachable only
 * through its id, so leaving them behind would leave encrypted values on
 * disk that nothing can ever read, list, or remove again — and a later
 * step that happened to reuse the id would inherit them.
 *
 * The step's environment variables (EO-485) live in the same directory
 * and go with it.
 */
export function clearStepSecrets(options: ModuleSecretsOptions, stepId: string): void {
  rmSync(directoryFor(options, stepId), { force: true, recursive: true });
  // And its trial-only values (EO-584), which are reachable through the
  // same id and no other.
  rmSync(directoryFor(options, trialScopeOf(stepId)), { force: true, recursive: true });
}

/**
 * Gives one step everything another step set, as it is on disk (EO-766).
 *
 * For a pipeline copied onto another project: the copy's step is a new
 * id, and a step's secrets, references and variables are reachable
 * through its id and no other, so without this the copy's deploy step
 * would run on the shared value its original was set up to replace.
 *
 * The files are copied byte for byte rather than read and stored again.
 * A value is encrypted with the machine's key and nothing about the step,
 * so the copy decrypts exactly as the original does; and one that no
 * longer decrypts stays unreadable on the copy, still stopping the
 * fallback to the shared value as it does on the original. Its
 * trial-only values (EO-584) go with it, for the reason
 * `clearStepSecrets` removes them with it.
 *
 * Refuses, by throwing, to copy over a step that already has a scope of
 * its own: the copy's ids are fresh, so one is a caller's mistake.
 */
export function copyStepSecrets(options: ModuleSecretsOptions, fromStepId: string, toStepId: string): void {
  for (const [from, to] of [
    [fromStepId, toStepId],
    [trialScopeOf(fromStepId), trialScopeOf(toStepId)],
  ] as const) {
    const source = directoryFor(options, from);
    if (!existsSync(source)) continue;
    cpSync(source, directoryFor(options, to), { recursive: true, errorOnExist: true, force: false });
  }
}

/**
 * Which secrets are set, by name only.
 *
 * Names, never values: this is what the settings screen lists and what
 * an import preflight checks a pipeline against (KAN-108), and neither
 * has any business seeing the value. A value crosses IPC only on
 * `moduleSecrets:reveal`, when the person at the desktop asks (EO-489).
 *
 * A file that no longer decrypts is not listed. "Set" here means a run
 * would get a value, and a name that cannot be read is one a run will
 * refuse — listing it would have the screen promise something the engine
 * then declines to do, which is the disagreement worth not having.
 */
export function listSecretNames(options: ModuleSecretsOptions, scope: SecretScope = null): string[] {
  // A reference counts on the same terms (EO-416): only when EO's
  // environment has the variable, because only then would a dispatch get
  // a value. One that dangles is a name a run will refuse.
  return entryNames(options, scope).filter((name) => resolveEntry(options, name, scope).state === "value");
}

/**
 * The names a run would be given a value for from this scope, secret or
 * not (EO-485).
 *
 * `listSecretNames` plus the environment variables. What the gallery's
 * needs check and an import preflight ask is "would a module declaring
 * this name get one", and a variable answers that as squarely as a
 * secret does; the Secrets list is the one place that must not hear
 * about a variable, which is why the two are separate functions.
 */
export function listAvailableNames(options: ModuleSecretsOptions, scope: SecretScope = null): string[] {
  const names = new Set(listSecretNames(options, scope));
  for (const { name } of listVariables(options, scope)) names.add(name);
  return [...names].sort();
}

/**
 * The environment for one module run: exactly what it declared, and
 * nothing else.
 *
 * A name with no stored value is *absent* rather than empty. A module
 * checking `if (!ctx.env.TOKEN)` should see the truth, and an empty
 * string would let it get as far as an API call that fails for a reason
 * nobody can read.
 *
 * The step's own value wins over the shared one, name by name. A step
 * that overrides `FLY_API_TOKEN` still gets the global `SLACK_WEBHOOK`
 * beside it — overriding one name is not opting out of the rest.
 *
 * An override that is *there but unreadable* stops the fallback rather
 * than passing it. Falling through would hand a production step the
 * shared staging token and let it deploy — a wrong credential is worse
 * than no credential, and this is the one place that can tell.
 *
 * A name may hold a *reference* instead of a value, in either scope
 * (EO-416): "read this from EO's variable X". It takes the place a
 * stored value would have had and changes nothing about the order —
 * the organisation's value, then the step's entry, then the shared one,
 * whichever kind each is. A reference whose variable is absent or empty
 * yields no value and, exactly as an unreadable override does, stops
 * there: a step that says "read `JDK21_HOME`" on a machine without one
 * must not quietly run on the shared entry it was set up to replace.
 *
 * A name may also be an *environment variable* in either scope (EO-485,
 * ARCHITECTURE.md §14.2) — a value that is not secret. It too takes the
 * place a stored value would have had: the organisation's secret, then
 * the step's entry (secret, reference or variable), then the shared
 * one. So a step's variable beats a shared secret of the same name for
 * that step, and an organisation's secret beats any variable.
 */
export interface ResolvedEnvironment {
  env: Record<string, string>;
  /** Declared names whose stored value could not be decrypted, or whose environment variable could not be read. */
  unreadable: string[];
  /** Declared names that reference a variable EO's environment does not have, or has empty (EO-416). */
  dangling: { name: string; variable: string }[];
  /**
   * The names in `env` whose value is an environment variable rather
   * than a secret (EO-485). A variable is not secret, so a caller
   * redacting a run's output leaves these values in it.
   */
  variables: string[];
  /**
   * Declared names a redirected step's own scope sets and its trial-only
   * scope does not (EO-584), given nothing: see `StepScope`. Present only
   * where there is one, so a step that is not redirected resolves to the
   * same answer it always did.
   */
  notRedirected?: string[];
}

/**
 * How an organisation's value for a name is read, where this
 * installation has one (EO-328, ARCHITECTURE.md, "Secrets").
 *
 * A function rather than the store itself, so this module keeps knowing
 * nothing about where an organisation's secrets live — it is the same
 * `SecretRead` answer either way, and the three-state shape is exactly
 * what the resolution below needs.
 */
export type OrganisationSecretReader = (name: string) => SecretRead;

/**
 * **The organisation's value wins, and a personal one of the same name
 * shadows nothing** (EO-328, ARCHITECTURE.md, "Secrets").
 *
 * That is the story's own sentence and it settles what would otherwise
 * be an arbitrary precedence. The two namespaces are distinct: setting
 * `FLY_API_TOKEN` here neither overwrites nor hides the organisation's
 * `FLY_API_TOKEN`, both remain listed, and the personal one goes on
 * being what a run is given for every name the organisation has *not*
 * published. What it may not do is displace a credential the
 * organisation put there — a device that could override an
 * organisation's token by typing one into a settings field would make
 * the policy advisory.
 *
 * An organisation value that is *there but unreadable* stops the
 * fallback rather than passing it, for the same reason a step override
 * does: a wrong credential is worse than no credential, and this is the
 * one place that can tell.
 */
export function environmentFor(
  options: ModuleSecretsOptions,
  declared: string[],
  step: SecretScope | StepScope = null,
  organisation?: OrganisationSecretReader,
): ResolvedEnvironment {
  const env: Record<string, string> = {};
  const unreadable: string[] = [];
  const dangling: { name: string; variable: string }[] = [];
  const variables: string[] = [];
  const notRedirected: string[] = [];
  // A redirected step reads its trial-only scope where it would have read
  // its own (EO-584); everything else about the order is unchanged.
  const { stepId, trialScope } = typeof step === "object" && step !== null ? step : { stepId: step, trialScope: undefined };
  const scope = trialScope ?? stepId;

  for (const name of declared) {
    const theirs = organisation?.(name) ?? { state: "absent" as const };
    if (theirs.state === "unreadable") {
      unreadable.push(name);
      continue;
    }
    if (theirs.state === "value") {
      env[name] = theirs.value;
      continue;
    }

    // Only a scope that says *nothing* about the name passes it on. An
    // entry that is there and yields no value — unreadable, or a
    // reference that dangles — is the answer for this name.
    const own: ResolvedAny = scope === null ? { state: "absent" } : resolveAnyEntry(options, name, scope);
    // The step's own entry, which a redirect replaces: neither it nor
    // the shared value it was set up to replace is given (EO-584).
    if (own.state === "absent" && trialScope !== undefined && stepId !== null && resolveAnyEntry(options, name, stepId).state !== "absent") {
      notRedirected.push(name);
      continue;
    }
    const read = own.state === "absent" ? resolveAnyEntry(options, name, null) : own;
    if (read.state === "value") env[name] = read.value;
    else if (read.state === "plain") {
      env[name] = read.value;
      variables.push(name);
    } else if (read.state === "unreadable") unreadable.push(name);
    else if (read.state === "dangling") dangling.push({ name, variable: read.variable });
  }

  return { env, unreadable, dangling, variables, ...(notRedirected.length > 0 ? { notRedirected } : {}) };
}
