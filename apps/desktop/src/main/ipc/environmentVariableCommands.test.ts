import { ipcContract } from "@eo/core";
import { sql } from "drizzle-orm";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { createPipeline, createStep } from "../db/repos/index.js";
import { environmentFor, type ModuleSecretsOptions } from "../modules/secrets.js";
import { clearEnvironmentVariable, listEnvironmentVariables, setEnvironmentVariable } from "./environmentVariableCommands.js";
import { listModuleSecrets, setModuleSecret } from "./moduleSecretCommands.js";

/**
 * Setting environment variables, shared or per step (EO-485,
 * ARCHITECTURE.md §14.2).
 *
 * `safeStorage`, minus the OS, for the secrets the refusals are about —
 * and one with no keychain at all, for the claim that a variable needs
 * none.
 */
const reverse = (text: string) => [...text].reverse().join("");
const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(reverse(text)),
  decryptString: (buffer: Buffer) => reverse(buffer.toString()),
};
const noKeychain = {
  isEncryptionAvailable: () => false,
  encryptString: (): Buffer => {
    throw new Error("no keychain");
  },
  decryptString: (): string => {
    throw new Error("no keychain");
  },
};

let handle: DbHandle;
let directory: string;
let secrets: ModuleSecretsOptions;
let stepId: string;

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo environment variable commands "));
  secrets = { directory, store };

  const pipeline = createPipeline(handle.db, { name: "Ship" });
  stepId = createStep(handle.db, { pipelineId: pipeline.id, position: 0, name: "Deploy", type: "module", entryAction: "deploy" }).id;
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("environment variable commands", () => {
  it("lists each variable's name, value and scope", () => {
    expect(setEnvironmentVariable(handle.db, secrets, { name: "REGION", value: "eu-west-1" })).toEqual({ saved: true, problem: null });
    expect(setEnvironmentVariable(handle.db, secrets, { name: "REGION", value: "us-east-1", stepId })).toEqual({ saved: true, problem: null });
    expect(setEnvironmentVariable(handle.db, secrets, { name: "TIER", value: "gold" })).toEqual({ saved: true, problem: null });

    expect(listEnvironmentVariables(handle.db, secrets, { stepId })).toEqual({
      variables: [
        { name: "REGION", value: "eu-west-1", scope: "shared" },
        { name: "TIER", value: "gold", scope: "shared" },
        { name: "REGION", value: "us-east-1", scope: "step" },
      ],
    });
    // Without a step, the shared ones alone.
    expect(listEnvironmentVariables(handle.db, secrets, {}).variables.map((variable) => variable.scope)).toEqual(["shared", "shared"]);
    // And the answer is the channel's own shape.
    expect(ipcContract["environmentVariables:list"].response.safeParse(listEnvironmentVariables(handle.db, secrets, { stepId })).success).toBe(true);
  });

  it("saves on a machine with no keychain, and keeps nothing in SQLite", () => {
    const here = { directory, store: noKeychain };

    expect(setEnvironmentVariable(handle.db, here, { name: "REGION", value: "eu-west-1" })).toEqual({ saved: true, problem: null });
    expect(listEnvironmentVariables(handle.db, here, {}).variables).toEqual([{ name: "REGION", value: "eu-west-1", scope: "shared" }]);
    expect(readdirSync(directory)).toContain("variable-REGION.json");

    // No table holds the value: every text column of every table, swept.
    const tables = handle.db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`);
    expect(tables.length).toBeGreaterThan(0);
    for (const { name } of tables) {
      const rows = handle.db.all(sql.raw(`SELECT * FROM "${name}"`));
      expect(JSON.stringify(rows)).not.toContain("eu-west-1");
    }
  });

  it("refuses a variable whose name is already a secret or a reference in that scope, naming the Secrets list", () => {
    setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "tok" });
    setModuleSecret(handle.db, secrets, { name: "JAVA_HOME", reference: {}, stepId });

    const overSecret = setEnvironmentVariable(handle.db, secrets, { name: "FLY_API_TOKEN", value: "plain" });
    const overReference = setEnvironmentVariable(handle.db, secrets, { name: "JAVA_HOME", value: "/opt/jdk", stepId });

    expect(overSecret.saved).toBe(false);
    expect(overSecret.problem).toContain("already in the Secrets list");
    expect(overReference.saved).toBe(false);
    expect(overReference.problem).toContain("already in the Secrets list for this step");
    // Nothing was written, and the secret is still the secret.
    expect(listEnvironmentVariables(handle.db, secrets, { stepId }).variables).toEqual([]);
    expect(environmentFor(secrets, ["FLY_API_TOKEN"]).env).toEqual({ FLY_API_TOKEN: "tok" });
  });

  it("is a different scope's business: a shared secret does not stop a step's variable", () => {
    setModuleSecret(handle.db, secrets, { name: "REGION", value: "ap-south-1" });

    expect(setEnvironmentVariable(handle.db, secrets, { name: "REGION", value: "us-east-1", stepId })).toEqual({ saved: true, problem: null });
    expect(environmentFor(secrets, ["REGION"], stepId).env).toEqual({ REGION: "us-east-1" });
  });

  it("refuses a secret or a reference whose name is already a variable in that scope, naming the Environment variables list", () => {
    setEnvironmentVariable(handle.db, secrets, { name: "REGION", value: "eu-west-1" });
    setEnvironmentVariable(handle.db, secrets, { name: "TIER", value: "gold", stepId });

    const value = setModuleSecret(handle.db, secrets, { name: "REGION", value: "secret" });
    const reference = setModuleSecret(handle.db, secrets, { name: "TIER", reference: {}, stepId });

    expect(value).toMatchObject({ saved: false, replaced: null });
    expect(value.problem).toContain("already in the Environment variables list");
    expect(reference).toMatchObject({ saved: false, replaced: null });
    expect(reference.problem).toContain("already in the Environment variables list for this step");
    expect(listModuleSecrets(handle.db, secrets, { stepId })).toMatchObject({ names: [], overrides: [], references: [] });
    expect(environmentFor(secrets, ["REGION"]).env).toEqual({ REGION: "eu-west-1" });
  });

  it.each(["PATH", "HOME", "Path", "EO_RUN_ID", "eo_anything", "ANTHROPIC_API_KEY", "CODEX_HOME", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "codex_home"])("refuses %s, which EO sets itself", (name) => {
    const answer = setEnvironmentVariable(handle.db, secrets, { name, value: "x" });

    expect(answer.saved).toBe(false);
    expect(answer.problem).toMatch(/EO sets .* itself/);
    expect(listEnvironmentVariables(handle.db, secrets, {}).variables).toEqual([]);
  });

  it("refuses a name that is not an environment-variable name, at the channel", () => {
    const request = ipcContract["environmentVariables:set"].request;

    for (const name of ["FLY-API-TOKEN", "1REGION", "../etc", "", "REGION NAME"]) {
      expect(request.safeParse({ name, value: "x" }).success).toBe(false);
    }
    expect(request.safeParse({ name: "REGION", value: "x" }).success).toBe(true);
  });

  it("refuses an empty value rather than storing what a run would read as unset", () => {
    const answer = setEnvironmentVariable(handle.db, secrets, { name: "REGION", value: "" });

    expect(answer.saved).toBe(false);
    expect(answer.problem).toContain("REGION");
  });

  it("refuses a step that does not exist", () => {
    const answer = setEnvironmentVariable(handle.db, secrets, { name: "REGION", value: "x", stepId: "019d0000-0000-7000-8000-00000000dead" });

    expect(answer.saved).toBe(false);
    expect(answer.problem).toContain("Publish the pipeline first");
  });

  it("clears one scope's variable and leaves the other", () => {
    setEnvironmentVariable(handle.db, secrets, { name: "REGION", value: "eu-west-1" });
    setEnvironmentVariable(handle.db, secrets, { name: "REGION", value: "us-east-1", stepId });

    expect(clearEnvironmentVariable(handle.db, secrets, { name: "REGION", stepId })).toEqual({ cleared: true });

    expect(listEnvironmentVariables(handle.db, secrets, { stepId }).variables).toEqual([{ name: "REGION", value: "eu-west-1", scope: "shared" }]);
    expect(environmentFor(secrets, ["REGION"], stepId).env).toEqual({ REGION: "eu-west-1" });
    // A name that is not one names no file, and is said so rather than thrown.
    expect(clearEnvironmentVariable(handle.db, secrets, { name: "../etc" })).toEqual({ cleared: false });
  });

  /**
   * One name, one list, when the entry already there cannot be read
   * (EO-485 review): it is still there, so the other kind is still
   * refused. Root reads everything, so this cannot be staged as root.
   */
  describe.skipIf(process.getuid?.() === 0)("with an entry this process may not read", () => {
    const stepFile = (file: string) => join(directory, "steps", readdirSync(join(directory, "steps"))[0]!, file);

    it("refuses a secret or a reference over an unreadable variable", () => {
      setEnvironmentVariable(handle.db, secrets, { name: "REGION", value: "us-east-1", stepId });
      chmodSync(stepFile("variable-REGION.json"), 0o000);

      const value = setModuleSecret(handle.db, secrets, { name: "REGION", value: "secret", stepId });
      const reference = setModuleSecret(handle.db, secrets, { name: "REGION", reference: {}, stepId });

      expect(value.saved).toBe(false);
      expect(value.problem).toContain("already in the Environment variables list for this step");
      expect(reference.saved).toBe(false);
      expect(reference.problem).toContain("already in the Environment variables list for this step");
      expect(readdirSync(join(directory, "steps", readdirSync(join(directory, "steps"))[0]!))).toEqual(["variable-REGION.json"]);
    });

    it("refuses a variable over an unreadable secret or reference", () => {
      setModuleSecret(handle.db, secrets, { name: "REGION", value: "secret", stepId });
      setModuleSecret(handle.db, secrets, { name: "TIER", reference: {}, stepId });
      chmodSync(stepFile("secret-REGION.bin"), 0o000);
      chmodSync(stepFile("reference-TIER.json"), 0o000);

      for (const name of ["REGION", "TIER"]) {
        const answer = setEnvironmentVariable(handle.db, secrets, { name, value: "plain", stepId });
        expect(answer.saved).toBe(false);
        expect(answer.problem).toContain("already in the Secrets list for this step");
      }
      expect(listEnvironmentVariables(handle.db, secrets, { stepId }).variables).toEqual([]);
    });
  });
});
