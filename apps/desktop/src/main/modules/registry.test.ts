import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODULE_TIMEOUT_MS } from "@eo/core";
import type { ModuleManifest, Item, Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  approveModule,
  archiveModule,
  createPipelineVersion,
  createRun,
  createRunEventBuffer,
  createStep,
  getItem,
  getStep,
  listCommentsForItem,
  listRunEvents,
  postComment,
  listRoutesForPipeline,
  listStepsForPipeline,
  replacePipelineGraph,
  saveModule,
  updateStep,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { followApprovedModule } from "./followApproved.js";
import { createModuleRunnerLookup } from "./registry.js";
import { clearVariable, storeReference, storeSecret, storeVariable, type ModuleSecretsOptions } from "./secrets.js";
import { preparingAt } from "../supervisor/testWorkspaceKinds.js";

/**
 * The registry: a module id in, something the supervisor can run out
 * (KAN-105).
 *
 * A real host and a real keychain stand-in, because the three things
 * worth proving here all cross that boundary — that an unapproved module
 * is refused, that a declared secret arrives, and that what the module
 * printed reaches `run_events` with the secret taken back out.
 */

/** `safeStorage`, minus the OS. The same seam `credentials.test.ts` uses. */
const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
};

const hostPath = join(dirname(fileURLToPath(import.meta.url)), "moduleHost.mjs");
const launcher = { execPath: process.execPath, hostPath, hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };

const manifest: ModuleManifest = {
  name: "Probe",
  description: "Says something and stops.",
  inputs: {},
  needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["ok"],
};

let handle: DbHandle;
let scratch: string;
let secrets: ModuleSecretsOptions;
let item: Item;

function register(code: string, overrides: Partial<ModuleManifest> = {}, approve = true) {
  const saved = saveModule(handle.db, {
    slug: "probe",
    name: "Probe",
    description: "Says something and stops.",
    code,
    manifest: { ...manifest, ...overrides },
    approve,
  });
  if (!saved.ok) throw new Error(saved.reason);
  return saved.module;
}

function lookup() {
  return createModuleRunnerLookup({ db: handle.db, launcher, secrets });
}

/**
 * The run a transcript is filed against, and the context a runner is handed.
 *
 * The item is an argument because what a step configures is read from
 * the step the item is *on* (EO-78) — so proving two steps can differ
 * means dispatching two items, one on each.
 *
 * `report` writes straight through rather than batching. The supervisor
 * owns the buffer in the real thing (EO-77), and one buffer per run is
 * the point of that — a second one here would allocate `seq` from zero
 * again. What these tests are about is what reaches `run_events`, which
 * is the same either way.
 */
function context(runId: Uuid, on: Item = item) {
  const buffer = createRunEventBuffer(handle.db);
  return {
    db: handle.db,
    item: on,
    prepareWorkspace: preparingAt(scratch),
    report: (text: string) => {
      buffer.append(runId, "output", { type: "output", text });
      buffer.flush();
    },
    runId,
  };
}

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo modules "));
  secrets = { directory: join(scratch, "secrets"), store };
  item = createTestItem(handle.db, { type: "story", title: "Ship it", stepId: "todo" });
});

afterEach(() => {
  handle.close();
  // A module's child process can hold the directory open for a moment
  // after it exits, and Windows answers EBUSY until it lets go (EO-508's
  // CI); retried as the other module suites do.
  rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
});

describe("resolving a runner", () => {
  it("returns one for an approved module", () => {
    const module = register(`export default async function run() { return { ok: true, result: "ok", detail: "" }; }`);
    expect(lookup()(module.id)).toBeTypeOf("function");
  });

  it("returns nothing for an id that names no module", () => {
    expect(lookup()("019fb8c6-0000-7000-8000-00000000beef")).toBeUndefined();
  });

  // The gate has to hold at the moment of running, not only at the moment
  // of saving: a pipeline can be published and its module unapproved
  // afterwards.
  it("returns nothing for a module nobody approved", () => {
    const module = register(`export default async function run() { return { ok: true, result: "ok", detail: "" }; }`, {}, false);
    expect(lookup()(module.id)).toBeUndefined();
  });

  it("returns nothing for a module that has been deleted", () => {
    const module = register(`export default async function run() { return { ok: true, result: "ok", detail: "" }; }`);
    archiveModule(handle.db, module.id);
    expect(lookup()(module.id)).toBeUndefined();
  });
});

describe("running through the registry", () => {
  it("runs the module in the prepared worktree and returns its result", async () => {
    const module = register(`export default async function run(ctx) { return { ok: true, result: "ok", detail: ctx.cwd }; }`);
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" });

    const outcome = await lookup()(module.id)!(context(run.id));
    expect(outcome).toMatchObject({ ok: true, result: "ok", detail: scratch });
  });

  // The workspace's refusal says what it would have been running, and on
  // this path that is told to it rather than read off the run (EO-619).
  it("names the module, not its id, to a workspace that refuses it", async () => {
    const module = register(`export default async function run() { return { ok: true, result: "ok", detail: "" }; }`);
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" });

    const outcome = await lookup()(module.id)!({
      ...context(run.id),
      prepareWorkspace: async (_item, action) => ({ ok: false, reason: `Assign a repository before running ${action}.` }),
    });

    expect(outcome).toMatchObject({ ok: false, reason: `Assign a repository before running "Probe".` });
  });

  /**
   * A missing secret is a refusal, not a crash halfway through.
   *
   * It parks the item and names what to set, which matters because the
   * fix is one field in Settings — and because a deploy module that ran
   * with no token would fail somewhere further in, for a reason nobody
   * could read.
   */
  it("refuses before running when a declared secret is not set", async () => {
    const module = register(`export default async function run() { return { ok: true, result: "ok", detail: "" }; }`, {
      needs: { bin: [], env: ["FLY_API_TOKEN"], network: false, item: false, comment: false, attach: false, create: false },
    });
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" });

    const outcome = await lookup()(module.id)!(context(run.id));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("FLY_API_TOKEN");
  });

  // Compared rather than echoed: `detail` reaches `runs.result` and a
  // comment, so it is redacted like everything else — a test that echoed
  // the token would assert the leak rather than the delivery.
  it("passes a secret that is set", async () => {
    storeSecret(secrets, "FLY_API_TOKEN", "tok-123");
    const module = register(`export default async function run() { return { ok: true, result: "ok", detail: String(process.env.FLY_API_TOKEN === "tok-123") }; }`, {
      needs: { bin: [], env: ["FLY_API_TOKEN"], network: false, item: false, comment: false, attach: false, create: false },
    });
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" });

    expect(await lookup()(module.id)!(context(run.id))).toMatchObject({ ok: true, detail: "true" });
  });

  /**
   * The value belongs to the step the item is sitting on.
   *
   * One pipeline can deploy to staging and then to production — the same
   * module twice, two tokens — so the step is the only scope that can
   * tell those apart. The item is on `todo` here, which is what the
   * step-scoped value is filed against.
   */
  it("prefers the step's own value over the shared one", async () => {
    storeSecret(secrets, "FLY_API_TOKEN", "shared");
    storeSecret(secrets, "FLY_API_TOKEN", "for-this-step", "todo");
    const module = register(`export default async function run() { return { ok: true, result: "ok", detail: String(process.env.FLY_API_TOKEN === "for-this-step") }; }`, {
      needs: { bin: [], env: ["FLY_API_TOKEN"], network: false, item: false, comment: false, attach: false, create: false },
    });
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" });

    expect(await lookup()(module.id)!(context(run.id))).toMatchObject({ ok: true, detail: "true" });
  });

  // A step that overrides nothing still runs — the shared value is the
  // fallback, not a thing each step has to opt into.
  it("falls back to the shared value for a step that overrides nothing", async () => {
    storeSecret(secrets, "FLY_API_TOKEN", "shared");
    storeSecret(secrets, "FLY_API_TOKEN", "somewhere-else", "another-step");
    const module = register(`export default async function run() { return { ok: true, result: "ok", detail: String(process.env.FLY_API_TOKEN === "shared") }; }`, {
      needs: { bin: [], env: ["FLY_API_TOKEN"], network: false, item: false, comment: false, attach: false, create: false },
    });
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" });

    expect(await lookup()(module.id)!(context(run.id))).toMatchObject({ ok: true, detail: "true" });
  });

  /**
   * A wrong credential is worse than no credential.
   *
   * The step's override is on disk and no longer decrypts — restored onto
   * another machine, or after a keychain reset. Falling back to the
   * shared value would hand a production step the staging token and let
   * it deploy, so this stops instead, and says which fix it needs.
   */
  it("refuses rather than falling back to the shared value it cannot replace", async () => {
    // A keychain that can tell its own ciphertext from somebody else's,
    // which the plain fake above cannot.
    const strict = {
      ...store,
      decryptString: (buffer: Buffer) => {
        const raw = buffer.toString();
        if (!raw.startsWith("enc:")) throw new Error("not written by this keychain");
        return raw.slice("enc:".length);
      },
    };
    const readable = { ...secrets, store: strict };
    storeSecret(readable, "FLY_API_TOKEN", "shared");
    // Written as another machine would have: unmarked, so unreadable here.
    storeSecret({ ...readable, store: { ...strict, encryptString: (text: string) => Buffer.from(text) } }, "FLY_API_TOKEN", "production", "todo");

    const module = register(`export default async function run() { return { ok: true, result: "ok", detail: "" }; }`, {
      needs: { bin: [], env: ["FLY_API_TOKEN"], network: false, item: false, comment: false, attach: false, create: false },
    });
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" });

    const outcome = await createModuleRunnerLookup({ db: handle.db, launcher, secrets: readable })(module.id)!(context(run.id));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("cannot read FLY_API_TOKEN");
  });

  // Set only on the step, never shared: the refusal must not fire.
  it("runs on a step's value alone", async () => {
    storeSecret(secrets, "FLY_API_TOKEN", "only-here", "todo");
    const module = register(`export default async function run() { return { ok: true, result: "ok", detail: String(process.env.FLY_API_TOKEN === "only-here") }; }`, {
      needs: { bin: [], env: ["FLY_API_TOKEN"], network: false, item: false, comment: false, attach: false, create: false },
    });
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" });

    expect(await lookup()(module.id)!(context(run.id))).toMatchObject({ ok: true, detail: "true" });
  });

  it("files what the module printed into run_events", async () => {
    const module = register(`export default async function run(ctx) { ctx.log("halfway"); return { ok: true, result: "ok", detail: "" }; }`);
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" });

    await lookup()(module.id)!(context(run.id));

    const events = listRunEvents(handle.db, run.id);
    expect(events.map((event) => JSON.stringify(event.payload)).join("")).toContain("halfway");
  });

  /**
   * `run_events` is append-only (invariant #3), so a secret that reaches
   * the transcript has reached it permanently — there is no later pass
   * that can take it back out. This is the only moment at which it can be
   * stopped, which is why it is enforced here rather than at display.
   */
  it("never writes a secret's value into the transcript", async () => {
    storeSecret(secrets, "FLY_API_TOKEN", "tok-abcdef");
    const module = register(`export default async function run(ctx) { ctx.log("using " + process.env.FLY_API_TOKEN); return { ok: true, result: "ok", detail: "" }; }`, {
      needs: { bin: [], env: ["FLY_API_TOKEN"], network: false, item: false, comment: false, attach: false, create: false },
    });
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" });

    await lookup()(module.id)!(context(run.id));

    const written = listRunEvents(handle.db, run.id).map((event) => JSON.stringify(event.payload)).join("");
    expect(written).not.toContain("tok-abcdef");
    expect(written).toContain("«FLY_API_TOKEN»");
  });

  /**
   * The step path itself posts what the module asked for (EO-75).
   *
   * `runModule.test.ts` covers the channel and the rules; this covers
   * the wiring — that the runner the supervisor actually calls hands
   * `onComment` through, files the comment against this run, and signs
   * it with the module's name.
   */
  it("posts a comment the module asked for, against the run that asked", async () => {
    const module = register(`export default async function run(ctx) { ctx.comment("Deployed to staging."); return { ok: true, result: "ok", detail: "" }; }`, {
      needs: { bin: [], env: [], network: false, item: false, comment: true, attach: false, create: false },
    });
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" });

    await lookup()(module.id)!(context(run.id));

    const thread = listCommentsForItem(handle.db, item.id);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ authorType: "module", runId: run.id });
    expect(thread[0]?.body).toContain("Probe");
    expect(thread[0]?.body).toContain("Deployed to staging.");
  });
});

/**
 * A declared name read from EO's own environment (EO-416).
 *
 * Through the registry and a real host, because every claim here is
 * about what crosses into the module's process: that the value arrives
 * under the declared name, that a binary the module starts sees it too,
 * that nothing else of EO's environment comes with it, and that what the
 * module then prints has the value taken back out.
 *
 * `environment` is what EO was launched with. It is the store's own
 * seam, so the host below is still spawned with the test runner's real
 * environment — which is the point of the "nothing undeclared" case.
 */
describe("a name that references EO's environment", () => {
  const needs = (env: string[], more: Partial<ModuleManifest["needs"]> = {}) => ({
    needs: { bin: [], env, network: false, item: false, comment: false, attach: false, create: false, ...more },
  });

  function launchedWith(environment: Record<string, string>) {
    return createModuleRunnerLookup({ db: handle.db, launcher, secrets: { ...secrets, environment } });
  }

  function started(moduleId: string) {
    return createRun(handle.db, { itemId: item.id, agentId: null, action: moduleId, status: "running", provider: "module" });
  }

  // Compared inside the module rather than echoed, as "passes a secret
  // that is set" does: `detail` is redacted like everything else.
  it("hands the module the variable's value under the declared name, and a binary it starts sees the same", async () => {
    storeReference(secrets, "JAVA_HOME", "JDK21_HOME");
    const module = register(
      `export default async function run(ctx) {
        const child = await ctx.exec("sh", ["-c", 'test "$JAVA_HOME" = /opt/jdk21 && echo child-saw-it']);
        return { ok: true, result: "ok", detail: String(process.env.JAVA_HOME === "/opt/jdk21") + " " + child.stdout.trim() };
      }`,
      needs(["JAVA_HOME"], { bin: ["sh"] }),
    );

    const outcome = await launchedWith({ JDK21_HOME: "/opt/jdk21" })(module.id)!(context(started(module.id).id));

    expect(outcome).toMatchObject({ ok: true, detail: "true child-saw-it" });
  });

  it("reads the variable of the declared name when the reference names none", async () => {
    storeReference(secrets, "JAVA_HOME");
    const module = register(
      `export default async function run() { return { ok: true, result: "ok", detail: String(process.env.JAVA_HOME === "/opt/jdk21") }; }`,
      needs(["JAVA_HOME"]),
    );

    expect(await launchedWith({ JAVA_HOME: "/opt/jdk21" })(module.id)!(context(started(module.id).id))).toMatchObject({ ok: true, detail: "true" });
  });

  /**
   * A reference fills a declared name; it does not open the environment.
   *
   * `OTHER` is in the environment references resolve against *and* in
   * the real environment the host is spawned from, so neither route may
   * carry it.
   */
  it("still gives the module nothing it did not declare", async () => {
    storeReference(secrets, "JAVA_HOME");
    const module = register(
      `export default async function run() { return { ok: true, result: "ok", detail: String(process.env.OTHER === undefined) + " " + String(process.env.JAVA_HOME === "/opt/jdk21") }; }`,
      needs(["JAVA_HOME"]),
    );

    process.env["OTHER"] = "x";
    try {
      const outcome = await launchedWith({ JAVA_HOME: "/opt/jdk21", OTHER: "x" })(module.id)!(context(started(module.id).id));
      expect(outcome).toMatchObject({ ok: true, detail: "true true" });
    } finally {
      delete process.env["OTHER"];
    }
  });

  it("uses a step's reference rather than the shared stored value", async () => {
    storeSecret(secrets, "JAVA_HOME", "/stored");
    storeReference(secrets, "JAVA_HOME", "JDK21_HOME", "todo");
    const module = register(
      `export default async function run() { return { ok: true, result: "ok", detail: String(process.env.JAVA_HOME === "/opt/jdk21") }; }`,
      needs(["JAVA_HOME"]),
    );

    expect(await launchedWith({ JDK21_HOME: "/opt/jdk21" })(module.id)!(context(started(module.id).id))).toMatchObject({ ok: true, detail: "true" });
  });

  /**
   * The step stops before the module runs, and the sentence is its own.
   *
   * Not "is not set" — the name is configured, and that sentence sends
   * the person to a field that is already filled in. Not a module
   * failure either: the module never started, which the marker file
   * proves. It names the three things needed to fix it and the one fact
   * nobody guesses: exporting the variable now changes nothing until EO
   * is started again.
   */
  it.each([
    ["absent", {}],
    ["empty", { JDK21_HOME: "" }],
  ])("refuses before running when the variable is %s, and says what to do about it", async (_label, environment: Record<string, string>) => {
    storeReference(secrets, "JAVA_HOME", "JDK21_HOME");
    const marker = join(scratch, "the module ran");
    const module = register(
      `import { writeFileSync } from "node:fs";
       export default async function run() { writeFileSync(${JSON.stringify(marker)}, ""); return { ok: true, result: "ok", detail: "" }; }`,
      needs(["JAVA_HOME"]),
    );

    const outcome = await launchedWith(environment)(module.id)!(context(started(module.id).id));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('"Probe"');
    expect(outcome.reason).toContain("JAVA_HOME");
    expect(outcome.reason).toContain("JDK21_HOME");
    expect(outcome.reason).toContain("EO reads its environment when it starts");
    // Told apart from the two sentences beside it.
    expect(outcome.reason).not.toContain("not set");
    expect(outcome.reason).not.toContain("cannot read");
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ["a stored value", () => storeSecret(secrets, "JAVA_HOME", "/stored")],
    ["a reference that resolves", () => storeReference(secrets, "JAVA_HOME", "SHARED_HOME")],
  ])("does not fall back from a step's dangling reference to the shared entry when that is %s", async (_label, shared) => {
    shared();
    storeReference(secrets, "JAVA_HOME", "JDK21_HOME", "todo");
    const module = register(`export default async function run() { return { ok: true, result: "ok", detail: "" }; }`, needs(["JAVA_HOME"]));

    const outcome = await launchedWith({ SHARED_HOME: "/shared" })(module.id)!(context(started(module.id).id));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("JDK21_HOME");
  });

  // No keyring running: `storeSecret` can only refuse, and a reference
  // never asks.
  it("runs on a reference where the machine has no keychain", async () => {
    const here = { ...secrets, store: { ...store, isEncryptionAvailable: () => false }, environment: { JDK21_HOME: "/opt/jdk21" } };
    storeReference(here, "JAVA_HOME", "JDK21_HOME");
    const module = register(
      `export default async function run() { return { ok: true, result: "ok", detail: String(process.env.JAVA_HOME === "/opt/jdk21") }; }`,
      needs(["JAVA_HOME"]),
    );

    const outcome = await createModuleRunnerLookup({ db: handle.db, launcher, secrets: here })(module.id)!(context(started(module.id).id));

    expect(outcome).toMatchObject({ ok: true, detail: "true" });
  });

  /**
   * Redacted exactly as a stored value is — that was decided with the
   * story, and nothing here chooses otherwise. Once resolved it is an
   * ordinary entry in the run's environment, so `createRedactor`
   * never learns where it came from.
   */
  it("replaces the referenced value with the declared name in the transcript and in a comment", async () => {
    storeReference(secrets, "JAVA_HOME", "JDK21_HOME");
    const module = register(
      `export default async function run(ctx) {
        ctx.log("using " + process.env.JAVA_HOME);
        ctx.comment("Built with " + process.env.JAVA_HOME);
        return { ok: true, result: "ok", detail: "" };
      }`,
      needs(["JAVA_HOME"], { comment: true }),
    );
    const run = started(module.id);

    await launchedWith({ JDK21_HOME: "/opt/jdk21-referenced" })(module.id)!(context(run.id));

    const written = listRunEvents(handle.db, run.id).map((event) => JSON.stringify(event.payload)).join("");
    expect(written).not.toContain("/opt/jdk21-referenced");
    expect(written).toContain("«JAVA_HOME»");
    const comment = listCommentsForItem(handle.db, item.id)[0];
    expect(comment?.body).not.toContain("/opt/jdk21-referenced");
    expect(comment?.body).toContain("«JAVA_HOME»");
  });
});

/**
 * What a step sets for the inputs its module declares (EO-78).
 *
 * Through the registry and a real host, not against `resolveInputs`: the
 * thing that was missing was the wiring — `registry.ts` built its request
 * without `inputs` at all, so a unit test of the resolver passed
 * throughout and every module still ran on its defaults. What is asserted
 * here is what the module actually received in `ctx.inputs`.
 */
describe("the inputs a step configured", () => {
  /** Hands back whatever it was given, so the assertion is on `ctx.inputs` itself. */
  const echo = `export default async function run(ctx) { ctx.log(JSON.stringify(ctx.inputs)); return { ok: true, result: "ok", detail: JSON.stringify(ctx.inputs) }; }`;

  const waits = { wait_seconds: { type: "number" as const, default: 900 } };

  /** A module step with values on it, and an item sitting there. */
  function itemOn(stepId: string, moduleId: string, inputs: Record<string, string | number | boolean>): Item {
    createStep(handle.db, {
      id: stepId,
      pipelineId: "default" as Uuid,
      position: 50 + stepId.length,
      name: stepId,
      type: "module",
      entryAction: moduleId,
      inputs,
    });
    return createTestItem(handle.db, { type: "story", title: `Work on ${stepId}`, stepId });
  }

  const dispatch = (moduleId: string, on: Item) => {
    const run = createRun(handle.db, { itemId: on.id, agentId: null, action: moduleId, status: "running", provider: "module" });
    return lookup()(moduleId)!(context(run.id, on));
  };

  it("hands the module what the step set", async () => {
    const module = register(echo, { inputs: waits });

    expect(await dispatch(module.id, itemOn("deploy_staging", module.id, { wait_seconds: 90 }))).toMatchObject({
      ok: true,
      detail: JSON.stringify({ wait_seconds: 90 }),
    });
  });

  // The manifest is still what decides the value of an input nobody set —
  // that is what makes leaving one alone different from setting it to the
  // same number.
  it("falls back to the manifest's default for an input the step leaves unset", async () => {
    const module = register(echo, { inputs: waits });

    expect(await dispatch(module.id, itemOn("deploy_untouched", module.id, {}))).toMatchObject({ ok: true, detail: JSON.stringify({ wait_seconds: 900 }) });
  });

  /**
   * The whole reason the values are on the step.
   *
   * The merge module waits for CI, and ninety seconds on one repository
   * is eight minutes on another — so one module has to be able to mean
   * two things. Proven by dispatching both, because two rows in a table
   * prove only that two rows can be written.
   */
  it("lets two steps running the same module hold different values", async () => {
    const module = register(echo, { inputs: waits });

    const fast = await dispatch(module.id, itemOn("merge_fast", module.id, { wait_seconds: 90 }));
    const slow = await dispatch(module.id, itemOn("merge_slow", module.id, { wait_seconds: 480 }));

    expect(fast).toMatchObject({ ok: true, detail: JSON.stringify({ wait_seconds: 90 }) });
    expect(slow).toMatchObject({ ok: true, detail: JSON.stringify({ wait_seconds: 480 }) });
  });

  /**
   * And the values the item's *own version* set (EO-327, ARCHITECTURE.md, "Publish, lock and
   * versions").
   *
   * `inputs` and `timeoutMs` are executable configuration, so an item
   * that entered on v1 and is dispatched after v2 retuned its step would
   * be run against numbers nobody agreed to for it. The step row is
   * edited in place — that is what makes this different from a removal —
   * so the only thing standing between the old item and the new numbers
   * is where the dispatch reads them from.
   */
  it("hands an older version's item the values that version set, not the ones the step holds now", async () => {
    const module = register(echo, { inputs: waits });

    // The step, then a version of the graph that has it — which is what
    // the item about to enter binds to.
    createStep(handle.db, {
      id: "deploy_retuned",
      pipelineId: "default" as Uuid,
      position: 60,
      name: "deploy_retuned",
      type: "module",
      entryAction: module.id,
      inputs: { wait_seconds: 90 },
    });
    const ninetySeconds = createPipelineVersion(handle.db, "default", null);
    const on = createTestItem(handle.db, { type: "story", title: "Entered on the old one", stepId: "deploy_retuned" });
    expect(getItem(handle.db, on.id)?.pipelineVersionId).toBe(ninetySeconds.id);

    // Then the step is retuned in place and a new version filed. The
    // live row now says eight minutes.
    updateStep(handle.db, "deploy_retuned", { inputs: { wait_seconds: 480 } });
    // Filed by hand because `updateStep` writes one field rather than
    // publishing a graph — a publish files its own version now.
    createPipelineVersion(handle.db, "default", null);
    expect(getStep(handle.db, "deploy_retuned")?.inputs).toEqual({ wait_seconds: 480 });

    expect(await dispatch(module.id, getItem(handle.db, on.id)!)).toMatchObject({ ok: true, detail: JSON.stringify({ wait_seconds: 90 }) });

    // And an item entering now takes the retuned value, which is the
    // other half of the promise.
    const entering = createTestItem(handle.db, { type: "story", title: "Entering now", stepId: "deploy_retuned" });
    expect(await dispatch(module.id, entering)).toMatchObject({ ok: true, detail: JSON.stringify({ wait_seconds: 480 }) });
  });

  /**
   * Invariant #5, applied to what a person typed.
   *
   * The step was published before the manifest declared this input a
   * number — or something else wrote the row — and a module handed
   * `"ninety"` where it expected a number does arithmetic on a string.
   * Refused by name, and the module is never started: the transcript is
   * empty, so there is nothing it could have read the value from.
   */
  it("refuses a value that is not what the manifest declares, and never runs the module", async () => {
    const module = register(echo, { inputs: waits });
    const on = itemOn("deploy_mistyped", module.id, { wait_seconds: "ninety" });
    const run = createRun(handle.db, { itemId: on.id, agentId: null, action: module.id, status: "running", provider: "module" });

    const outcome = await lookup()(module.id)!(context(run.id, on));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("wait_seconds");
    expect(outcome.ok === false && outcome.reason).toContain("number");
    // The module logs `ctx.inputs` on its first line, so an empty
    // transcript is the evidence that it never saw one.
    expect(listRunEvents(handle.db, run.id)).toHaveLength(0);
  });

  /**
   * A manifest that dropped an input leaves the step's value behind. The
   * manifest decides what exists: the value goes nowhere and the step
   * runs exactly as it did.
   */
  it("leaves a value inert when the manifest no longer declares its input", async () => {
    const module = register(echo, { inputs: waits });

    expect(await dispatch(module.id, itemOn("deploy_stale", module.id, { wait_seconds: 90, retired: "left behind" }))).toMatchObject({
      ok: true,
      detail: JSON.stringify({ wait_seconds: 90 }),
    });
  });
});

/**
 * How long a step's module may run (EO-162).
 *
 * Through the registry and a real host for the reason the inputs above
 * are: the number being on the step proves nothing until it is the number
 * that arms the timer and the number `ctx.timeoutMs` reports. Those two
 * disagreeing is the exact shape of the bug — the merge module capped its
 * own wait against a ceiling it had guessed, and the guess was wrong.
 */
describe("the time limit a step configured", () => {
  /** Answers with the ceiling it was told about, so the assertion is on `ctx.timeoutMs`. */
  const reportsLimit = `export default async function run(ctx) { return { ok: true, result: "ok", detail: String(ctx.timeoutMs) }; }`;

  /**
   * Ignores it, so the assertion is on the timer actually firing.
   *
   * A real timer rather than a promise that never settles: the latter
   * lets Node's loop empty and the process exit cleanly, which is a
   * different failure with a different message.
   */
  const neverStops = `export default async function run() { await new Promise((resolve) => setTimeout(resolve, 60000)); return { ok: true, result: "ok", detail: "" }; }`;

  function itemOn(stepId: string, moduleId: string, timeoutMs: number | null): Item {
    createStep(handle.db, {
      id: stepId,
      pipelineId: "default" as Uuid,
      position: 60 + stepId.length,
      name: stepId,
      type: "module",
      entryAction: moduleId,
      timeoutMs,
    });
    return createTestItem(handle.db, { type: "story", title: `Work on ${stepId}`, stepId });
  }

  const dispatch = (moduleId: string, on: Item) => {
    const run = createRun(handle.db, { itemId: on.id, agentId: null, action: moduleId, status: "running", provider: "module" });
    return lookup()(moduleId)!(context(run.id, on));
  };

  it("tells a module EO's default when the step configured nothing", async () => {
    const module = register(reportsLimit);

    expect(await dispatch(module.id, itemOn("limit_default", module.id, null))).toMatchObject({
      ok: true,
      detail: String(DEFAULT_MODULE_TIMEOUT_MS),
    });
  });

  /**
   * The story's whole point, from the module's side. A merge module that
   * reads this can wait fourteen minutes on a repository configured for
   * fifteen, instead of capping itself under a ceiling it had to assume.
   */
  it("tells a module the raised limit the step actually set", async () => {
    const module = register(reportsLimit);

    expect(await dispatch(module.id, itemOn("limit_raised", module.id, 15 * 60_000))).toMatchObject({
      ok: true,
      detail: String(15 * 60_000),
    });
  });

  /** The same promise for the other executable number (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). */
  it("holds an older version's item to the limit that version set", async () => {
    const module = register(reportsLimit);

    createStep(handle.db, {
      id: "limit_retuned",
      pipelineId: "default" as Uuid,
      position: 70,
      name: "limit_retuned",
      type: "module",
      entryAction: module.id,
      timeoutMs: 15 * 60_000,
    });
    const patient = createPipelineVersion(handle.db, "default", null);
    const on = createTestItem(handle.db, { type: "story", title: "Entered while it was patient", stepId: "limit_retuned" });
    expect(getItem(handle.db, on.id)?.pipelineVersionId).toBe(patient.id);

    // Edited in place through the same call a publish makes, since that
    // is the path this is about: the row changes and the id does not.
    const retuned = listStepsForPipeline(handle.db, "default").map((step) =>
      step.id === "limit_retuned" ? { ...step, timeoutMs: 60_000 } : step,
    );
    expect(replacePipelineGraph(handle.db, "default", retuned, listRoutesForPipeline(handle.db, "default"))).toMatchObject({ replaced: true });

    expect(await dispatch(module.id, getItem(handle.db, on.id)!)).toMatchObject({ ok: true, detail: String(15 * 60_000) });
    const entering = createTestItem(handle.db, { type: "story", title: "Entering now", stepId: "limit_retuned" });
    expect(await dispatch(module.id, entering)).toMatchObject({ ok: true, detail: String(60_000) });
  });

  it("lets two steps running the same module be held to different limits", async () => {
    const module = register(reportsLimit);

    const quick = await dispatch(module.id, itemOn("limit_quick", module.id, 60_000));
    const patient = await dispatch(module.id, itemOn("limit_patient", module.id, 20 * 60_000));

    expect(quick).toMatchObject({ ok: true, detail: String(60_000) });
    expect(patient).toMatchObject({ ok: true, detail: String(20 * 60_000) });
  });

  /**
   * And the number is the one that stops it, not merely the one it was
   * told. A limit that a module could read but that nothing enforced
   * would be the same lie in the other direction.
   */
  it("stops a module that runs past the step's limit, and says which limit it was", async () => {
    const module = register(neverStops);

    const outcome = await dispatch(module.id, itemOn("limit_short", module.id, 600));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("600ms");
    // Points at where the number lives, because "it timed out" is not
    // something a person can act on and "raise it on the step" is.
    expect(outcome.ok === false && outcome.reason).toContain("ask the assistant to raise it on the step");
  }, 20_000);
});

/**
 * The answer a step was given, handed to the module (EO-183).
 *
 * Through the registry and a real host for the reason the inputs are:
 * what was missing was never the reading — `recordedStackAnswer` has
 * done that correctly since KAN-42 — but the wiring, and a module had to
 * hand-write the rules because nothing carried the result across the
 * boundary. `roles/answers.test.ts` proves what the reader decides;
 * this proves that what it decided is what `ctx.answer()` answers with.
 *
 * The parent computes it: the host's handle is read-only and opened for
 * one item, and nothing below gives it another.
 */
describe("the answer a step was given", () => {
  /** Hands `ctx.answer()` straight back, so the assertion is on the value itself. */
  const echo = `export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify(ctx.answer()) }; }`;

  const dispatch = (moduleId: string) => {
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: moduleId, status: "running", provider: "module" });
    return lookup()(moduleId)!(context(run.id));
  };

  function ask(options: string[]): void {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "escalation",
      body: "CI failed on this branch. What should happen?",
      options,
      mentions: [{ type: "human" }],
    });
  }

  it("is null on the run that has asked nothing", async () => {
    const module = register(echo);

    expect(await dispatch(module.id)).toMatchObject({ ok: true, detail: "null" });
  });

  it("is null while the question is still unanswered", async () => {
    // The first run asks and parks; this is the state it parks in, and a
    // module that saw anything else here would act on its own question.
    const module = register(echo);
    ask(["Merge anyway", "Send it back"]);

    expect(await dispatch(module.id)).toMatchObject({ ok: true, detail: "null" });
  });

  /**
   * A clicked button arrives as the label plus whatever punctuation the
   * person finished typing — so `matched` is the module's own spelling of
   * the option, which is what it can compare against its own constant.
   */
  it("carries the reply, what was offered, and the option it matched", async () => {
    const module = register(echo);
    ask(["Merge anyway", "Send it back"]);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Send it back." });

    const outcome = await dispatch(module.id);
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(outcome.ok === true ? outcome.detail : "null")).toEqual({
      text: "Send it back.",
      offered: ["Merge anyway", "Send it back"],
      matched: "Send it back",
    });
  });

  /**
   * Somebody answering in their own words.
   *
   * `matched` is null and the sentence is handed over untouched: what
   * those words meant is not something EO can claim, and inventing a
   * match would route an item on a guess. The module decides what to do
   * about it — which, until EO-180's `interpret` lands, is asking again
   * with the reply quoted back.
   */
  it("hands over what a person actually wrote, matching nothing", async () => {
    const module = register(echo);
    ask(["Merge anyway", "Send it back"]);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "hold it until Priya is back" });

    const outcome = await dispatch(module.id);
    expect(JSON.parse(outcome.ok === true ? outcome.detail : "null")).toEqual({
      text: "hold it until Priya is back",
      offered: ["Merge anyway", "Send it back"],
      matched: null,
    });
  });

  it("does not read a comment written before anything was asked", async () => {
    const module = register(echo);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Merge anyway" });
    ask(["Merge anyway", "Send it back"]);

    expect(await dispatch(module.id)).toMatchObject({ ok: true, detail: "null" });
  });
});

/**
 * Environment variables reaching a module (EO-485, ARCHITECTURE.md §14.2).
 *
 * Through a real host, because what is being proved is what the
 * module's own `process.env` holds — the host empties it down to the
 * declared names before importing anything — and what reaches the
 * transcript afterwards.
 */
describe("environment variables", () => {
  const needing = (env: string[]) => ({ needs: { bin: [], env, network: false, item: false, comment: false, attach: false, create: false } });
  const reportsRegion = `export default async function run() { return { ok: true, result: "ok", detail: JSON.stringify({ region: process.env.REGION ?? null }) }; }`;

  /** `register`, under a slug of its own, so one test can hold two modules side by side. */
  function registerAs(slug: string, code: string, env: string[]) {
    const saved = saveModule(handle.db, { slug, name: slug, description: "Reports what it was given.", code, manifest: { ...manifest, ...needing(env) }, approve: true });
    if (!saved.ok) throw new Error(saved.reason);
    return saved.module;
  }

  async function regionSeenBy(on: Item = item): Promise<unknown> {
    const run = createRun(handle.db, { itemId: on.id, agentId: null, action: probe.id, status: "running", provider: "module" });
    const outcome = await lookup()(probe.id)!(context(run.id, on));
    if (!outcome.ok) throw new Error(outcome.reason);
    return (JSON.parse(outcome.detail) as { region: unknown }).region;
  }

  let probe: ReturnType<typeof registerAs>;

  it("gives a module a shared variable it declares, and not one it does not", async () => {
    storeVariable(secrets, "REGION", "eu-west-1");

    probe = registerAs("declares", reportsRegion, ["REGION"]);
    // Not redacted, either: a variable is not secret, so the value is in
    // the detail as the module wrote it rather than replaced by its name.
    expect(await regionSeenBy()).toBe("eu-west-1");

    probe = registerAs("does-not-declare", reportsRegion, []);
    expect(await regionSeenBy()).toBeNull();
  });

  it("is not refused for a missing value when a declared name is set only as a variable", async () => {
    storeVariable(secrets, "REGION", "eu-west-1");
    probe = registerAs("needs-region", `export default async function run() { return { ok: true, result: "ok", detail: "" }; }`, ["REGION"]);
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: probe.id, status: "running", provider: "module" });

    expect(await lookup()(probe.id)!(context(run.id))).toMatchObject({ ok: true });
  });

  it("gives a step's variable to that step only, over a shared variable or a shared secret", async () => {
    probe = registerAs("reports-region", reportsRegion, ["REGION"]);
    const elsewhere = createTestItem(handle.db, { type: "story", title: "Somewhere else", stepId: "review" });
    storeVariable(secrets, "REGION", "us-east-1", "todo");

    storeVariable(secrets, "REGION", "eu-west-1");
    expect(await regionSeenBy(item)).toBe("us-east-1");
    expect(await regionSeenBy(elsewhere)).toBe("eu-west-1");

    // The shared entry a secret instead: the step's variable still wins
    // for its step, and the other step still gets the shared entry.
    clearVariable(secrets, "REGION");
    storeSecret(secrets, "REGION", "ap-south-1");
    expect(await regionSeenBy(item)).toBe("us-east-1");
    const run = createRun(handle.db, { itemId: elsewhere.id, agentId: null, action: probe.id, status: "running", provider: "module" });
    // Compared rather than echoed: the shared entry is a secret now, so
    // the detail is redacted.
    probe = registerAs("compares-region", `export default async function run() { return { ok: true, result: "ok", detail: String(process.env.REGION === "ap-south-1") }; }`, ["REGION"]);
    expect(await lookup()(probe.id)!(context(run.id, elsewhere))).toMatchObject({ ok: true, detail: "true" });
  });
});

/**
 * The module version a step pins (EO-770, ARCHITECTURE.md, "Modules: a
 * step that is a script").
 *
 * Through a real host, because what is asserted is which code ran: each
 * version answers with its own name. The gate is the pinned version's own
 * approval, so an edit to the module — which files a new, unapproved
 * version — leaves live work running the version it pins.
 */
describe("the module version a step pins", () => {
  const says = (word: string) => `export default async function run() { return { ok: true, result: "ok", detail: "${word}" }; }`;

  function edit(moduleId: string, code: string, approve: boolean): void {
    const saved = saveModule(handle.db, { id: moduleId, slug: "probe", name: "Probe", description: "Says something and stops.", code, manifest, approve });
    if (!saved.ok) throw new Error(saved.reason);
  }

  function stepOn(moduleId: string, moduleVersion?: number): void {
    createStep(handle.db, {
      id: "pinned",
      pipelineId: "default" as Uuid,
      position: 60,
      name: "pinned",
      type: "module",
      entryAction: moduleId,
      ...(moduleVersion === undefined ? {} : { moduleVersion }),
    });
  }

  const dispatch = (moduleId: string, on: Item) => {
    const run = createRun(handle.db, { itemId: on.id, agentId: null, action: moduleId, status: "running", provider: "module" });
    return lookup()(moduleId)!(context(run.id, on));
  };

  it("keeps running the approved version it pins after an edit files a newer, unapproved one", async () => {
    const module = register(says("v1"));
    edit(module.id, says("v2"), true);
    stepOn(module.id);
    // A step that names no version pins the newest approved one.
    expect(getStep(handle.db, "pinned")?.moduleVersion).toBe(2);
    const on = createTestItem(handle.db, { type: "story", title: "Pinned", stepId: "pinned" });

    // Saving an edit files v3 and withdraws the module's own approval.
    edit(module.id, says("v3"), false);

    expect(await dispatch(module.id, on)).toEqual({ ok: true, result: "ok", detail: "v2" });
  });

  it("runs the version an item's own pipeline version pins after the current version moves on", async () => {
    const module = register(says("v1"));
    stepOn(module.id, 1);
    const first = createPipelineVersion(handle.db, "default", null);
    const older = createTestItem(handle.db, { type: "story", title: "Entered on v1's pin", stepId: "pinned" });
    expect(getItem(handle.db, older.id)?.pipelineVersionId).toBe(first.id);

    // v2 is approved and the pipeline is published pinning it.
    edit(module.id, says("v2"), true);
    const moved = listStepsForPipeline(handle.db, "default").map((step) => (step.id === "pinned" ? { ...step, moduleVersion: 2 } : step));
    expect(replacePipelineGraph(handle.db, "default", moved, listRoutesForPipeline(handle.db, "default"))).toMatchObject({ replaced: true });

    expect(await dispatch(module.id, getItem(handle.db, older.id)!)).toEqual({ ok: true, result: "ok", detail: "v1" });
    const newer = createTestItem(handle.db, { type: "story", title: "Entered on v2's pin", stepId: "pinned" });
    expect(await dispatch(module.id, newer)).toEqual({ ok: true, result: "ok", detail: "v2" });
  });

  it("keeps an item in flight on the module version its pipeline version pins after approving a newer one moves the pipeline (EO-771)", async () => {
    const module = register(says("v1"));
    stepOn(module.id, 1);
    const older = createTestItem(handle.db, { type: "story", title: "Entered on v1's pin", stepId: "pinned" });

    // v2 is saved and approved: the pipeline follows it on its own.
    edit(module.id, says("v2"), false);
    approveModule(handle.db, module.id);
    expect(followApprovedModule(handle.db, module.id, { isTheRecord: false })).toEqual([expect.objectContaining({ pipelineId: "default", outcome: "moved", from: [1], to: 2 })]);
    expect(getStep(handle.db, "pinned")?.moduleVersion).toBe(2);

    expect(await dispatch(module.id, getItem(handle.db, older.id)!)).toEqual({ ok: true, result: "ok", detail: "v1" });
    const newer = createTestItem(handle.db, { type: "story", title: "Entered on v2's pin", stepId: "pinned" });
    expect(await dispatch(module.id, newer)).toEqual({ ok: true, result: "ok", detail: "v2" });
  });

  it("refuses to run a pinned version nobody approved, naming it", async () => {
    const module = register(says("v1"));
    edit(module.id, says("v2"), false);
    stepOn(module.id, 2);
    const on = createTestItem(handle.db, { type: "story", title: "Pinned to a draft", stepId: "pinned" });

    const outcome = await dispatch(module.id, on);
    expect(outcome).toMatchObject({ ok: false });
    expect(!outcome.ok && outcome.reason).toContain('v2 of "Probe" has not been approved');
  });

  it("refuses to run a pinned version the module does not keep, naming it", async () => {
    const module = register(says("v1"));
    stepOn(module.id, 9);
    const on = createTestItem(handle.db, { type: "story", title: "Pinned to nothing", stepId: "pinned" });

    const outcome = await dispatch(module.id, on);
    expect(outcome).toMatchObject({ ok: false });
    expect(!outcome.ok && outcome.reason).toContain('"Probe" v9 is not kept any more');
  });
});
