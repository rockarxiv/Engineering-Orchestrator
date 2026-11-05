import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentProvider, AgentProviderResumeOptions, AgentProviderStartOptions } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { agentRunVariables, clearVariable, storeVariable, type ModuleSecretsOptions } from "../modules/secrets.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/**
 * An agent run's environment variables (EO-487): read for the item's
 * step as each turn opens, handed to that turn, and never to the
 * provider — the wiring `createEngine` gives the supervisor, over a real
 * store in a temporary directory.
 */
describe("an agent run's environment variables", () => {
  let handle: DbHandle;
  let directory: string;
  let secrets: ModuleSecretsOptions;

  beforeEach(() => {
    handle = openMigratedTestDb();
    directory = mkdtempSync(join(tmpdir(), "eo run environment "));
    // No keychain: a variable needs none.
    secrets = { directory, store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" } };
  });

  afterEach(() => {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** A supervisor whose one provider records what each turn was handed. */
  function recording() {
    const turns: AgentProviderStartOptions[] = [];
    const fake = createFakeProvider({ result: validImplementResult });
    const provider: AgentProvider = {
      ...fake,
      start: (opts) => {
        turns.push(opts);
        return fake.start(opts);
      },
    };
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, runEnvironment: (stepId) => agentRunVariables(secrets, stepId) });
    /** Ticks until one more turn has opened — an earlier item's next step can be what a tick dispatches. */
    const nextTurn = async () => {
      const before = turns.length;
      for (let tick = 0; tick < 5 && turns.length === before; tick += 1) await supervisor.runOnce();
      expect(turns).toHaveLength(before + 1);
    };
    return { nextTurn, turns };
  }

  it("hands a turn every shared variable with its step's own over them, and not another step's", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    storeVariable(secrets, "REGION", "eu-west-1");
    storeVariable(secrets, "TIER", "standard");
    storeVariable(secrets, "REGION", "us-east-2", item.stepId);
    storeVariable(secrets, "TIER", "another-steps-tier", "review");

    const { nextTurn, turns } = recording();
    await nextTurn();

    expect(turns[0]?.environmentVariables).toEqual({ REGION: "us-east-2", TIER: "standard" });
  });

  /**
   * `__proto__` is a name a variable may have, and one a plain object
   * swallows on assignment. It reaches the turn as an own property, from
   * either scope.
   */
  it("hands a turn a variable called __proto__, shared or the step's", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    storeVariable(secrets, "__proto__", "shared-value");
    storeVariable(secrets, "constructor", "shared-constructor");
    storeVariable(secrets, "constructor", "step-constructor", item.stepId);

    const { nextTurn, turns } = recording();
    await nextTurn();

    const given = turns[0]?.environmentVariables;
    expect(given && Object.getOwnPropertyDescriptor(given, "__proto__")?.value).toBe("shared-value");
    expect(given && Object.getOwnPropertyDescriptor(given, "constructor")?.value).toBe("step-constructor");
  });

  it("hands a turn the step's own __proto__ over the shared one", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    storeVariable(secrets, "__proto__", "shared-value");
    storeVariable(secrets, "__proto__", "step-value", item.stepId);

    const { nextTurn, turns } = recording();
    await nextTurn();

    const given = turns[0]?.environmentVariables;
    expect(given && Object.getOwnPropertyDescriptor(given, "__proto__")?.value).toBe("step-value");
  });

  /**
   * A corrective turn spawns a CLI process of its own, after an initial
   * stream that may have run for an hour. What it is given is read when
   * it opens, not when the run did — an edit or a removal made while the
   * first stream ran reaches it, and a removal leaves nothing behind.
   */
  describe("a corrective turn", () => {
    /** A provider whose first turn answers off-schema after `during` has run, and whose correction answers well. */
    function correcting(during: () => void) {
      const resumes: (AgentProviderResumeOptions | undefined)[] = [];
      const provider: AgentProvider = {
        start: () =>
          (async function* () {
            yield { type: "thread_started", threadId: "thread-1" } satisfies AgentEvent;
            during();
            yield { type: "result", data: { summary: "missing the branch" } } satisfies AgentEvent;
          })(),
        resume: (_threadId, _message, opts) => {
          resumes.push(opts);
          return (async function* () {
            yield { type: "result", data: validImplementResult } satisfies AgentEvent;
          })();
        },
      };
      const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, runEnvironment: (stepId) => agentRunVariables(secrets, stepId) });
      return { supervisor, resumes };
    }

    it("sees a variable edited while the first stream ran", async () => {
      const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
      storeVariable(secrets, "REGION", "eu-west-1");
      storeVariable(secrets, "TIER", "standard", item.stepId);
      const { supervisor, resumes } = correcting(() => {
        storeVariable(secrets, "REGION", "ap-south-1");
        storeVariable(secrets, "TIER", "premium", item.stepId);
      });

      await supervisor.runOnce();

      expect(resumes).toHaveLength(1);
      expect(resumes[0]?.environmentVariables).toEqual({ REGION: "ap-south-1", TIER: "premium" });
      expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    });

    it("is given none of a variable removed while the first stream ran", async () => {
      const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
      storeVariable(secrets, "REGION", "eu-west-1");
      const { supervisor, resumes } = correcting(() => clearVariable(secrets, "REGION"));

      await supervisor.runOnce();

      expect(resumes).toHaveLength(1);
      expect(resumes[0]).not.toHaveProperty("environmentVariables");
      expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    });
  });

  it("reads them again for the next run, so an edit or a removal takes effect without a restart", async () => {
    storeVariable(secrets, "REGION", "eu-west-1");
    createTestItem(handle.db, { type: "story", title: "First", stepId: "todo" });
    const { nextTurn, turns } = recording();
    await nextTurn();

    storeVariable(secrets, "REGION", "ap-south-1");
    storeVariable(secrets, "BUCKET", "artefacts");
    createTestItem(handle.db, { type: "story", title: "Second", stepId: "todo" });
    await nextTurn();

    clearVariable(secrets, "REGION");
    clearVariable(secrets, "BUCKET");
    createTestItem(handle.db, { type: "story", title: "Third", stepId: "todo" });
    await nextTurn();

    expect(turns.map((turn) => turn.environmentVariables)).toEqual([{ REGION: "eu-west-1" }, { REGION: "ap-south-1", BUCKET: "artefacts" }, undefined]);
  });
});
