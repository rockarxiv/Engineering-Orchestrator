import { ipcContract, machineContract } from "@eo/core";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { createPipeline, createStep } from "../db/repos/index.js";
import { environmentFor, storeVariable, type ModuleSecretsOptions } from "../modules/secrets.js";
import { clearModuleSecret, listModuleSecrets, revealModuleSecret, setModuleSecret } from "./moduleSecretCommands.js";

/**
 * Setting a module's secrets, shared or per step (KAN-105).
 *
 * `safeStorage`, minus the OS — reversing rather than prefixing, so
 * "the plaintext is not in the file" stays a claim about the code under
 * test rather than about the fake.
 */
const reverse = (text: string) => [...text].reverse().join("");
const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(reverse(text)),
  decryptString: (buffer: Buffer) => reverse(buffer.toString()),
};

let handle: DbHandle;
let directory: string;
let secrets: ModuleSecretsOptions;
let stepId: string;

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo module secret commands "));
  secrets = { directory, store };

  const pipeline = createPipeline(handle.db, { name: "Ship" });
  stepId = createStep(handle.db, { pipelineId: pipeline.id, position: 0, name: "Deploy", type: "module", entryAction: "deploy" }).id;
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("module secret commands", () => {
  it("sets and lists a shared value by name", () => {
    expect(setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "shared" })).toEqual({ saved: true, problem: null, replaced: null });

    // `organisation` is empty on an installation nobody published to,
    // which is every one of these (EO-328).
    expect(listModuleSecrets(handle.db, secrets, {})).toEqual({
      names: ["FLY_API_TOKEN"],
      overrides: [],
      organisation: [],
      references: [],
      stored: { shared: ["FLY_API_TOKEN"], step: [] },
    });
  });

  it("sets a step's own value and lists it apart from the shared ones", () => {
    setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "shared" });
    setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "production", stepId });

    expect(listModuleSecrets(handle.db, secrets, { stepId })).toEqual({
      names: ["FLY_API_TOKEN"],
      overrides: ["FLY_API_TOKEN"],
      organisation: [],
      references: [],
      stored: { shared: ["FLY_API_TOKEN"], step: ["FLY_API_TOKEN"] },
    });
    // What the step will actually run with.
    expect(environmentFor(secrets, ["FLY_API_TOKEN"], stepId).env).toEqual({ FLY_API_TOKEN: "production" });
    expect(environmentFor(secrets, ["FLY_API_TOKEN"]).env).toEqual({ FLY_API_TOKEN: "shared" });
  });

  /**
   * A step the editor has not published is not a step yet.
   *
   * A value filed against an id no row carries is a value nothing will
   * ever read: the publish may not happen at all, and there is nothing to
   * clean it up if it does not. The refusal lives here rather than only
   * in the screen's `disabled`, because a check that lives in an
   * attribute lives nowhere.
   */
  it("refuses a value for a step that does not exist", () => {
    const result = setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "x", stepId: "019fb8c6-0000-7000-8000-00000000beef" });

    expect(result.saved).toBe(false);
    expect(result.problem).toContain("Publish the pipeline first");
    // And nothing was written under the shared name instead, which would
    // have been the worst possible way to be helpful.
    expect(listModuleSecrets(handle.db, secrets, {}).names).toEqual([]);
  });

  it("reports no overrides for a step that does not exist", () => {
    expect(listModuleSecrets(handle.db, secrets, { stepId: "019fb8c6-0000-7000-8000-00000000beef" }).overrides).toEqual([]);
  });

  // Clearing an override falls back to the shared value rather than
  // unsetting the name — that is what "use the shared one" means.
  it("clears a step's value without touching the shared one", () => {
    setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "shared" });
    setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "production", stepId });

    expect(clearModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", stepId })).toEqual({ cleared: true });
    expect(environmentFor(secrets, ["FLY_API_TOKEN"], stepId).env).toEqual({ FLY_API_TOKEN: "shared" });
  });

  it("clears a shared value", () => {
    setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "shared" });

    clearModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN" });

    expect(listModuleSecrets(handle.db, secrets, {}).names).toEqual([]);
  });

  /**
   * A step that is already gone took its overrides with it. Clearing one
   * must not fall through to the shared value — that would delete
   * everything else's token on the way past.
   */
  it("does not clear the shared value when the step is gone", () => {
    setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "shared" });

    expect(clearModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", stepId: "019fb8c6-0000-7000-8000-00000000beef" })).toEqual({ cleared: true });
    expect(listModuleSecrets(handle.db, secrets, {}).names).toEqual(["FLY_API_TOKEN"]);
  });

  it("says why nothing could be stored when the machine has no keychain", () => {
    const result = setModuleSecret(handle.db, { directory, store: { ...store, isEncryptionAvailable: () => false } }, { name: "TOKEN", value: "x" });

    expect(result.saved).toBe(false);
    expect(result.problem).toContain("keychain");
  });

  /**
   * Pointing a name at one of EO's own variables (EO-416).
   *
   * `environment` is what EO was launched with. The value it holds is
   * swept for in every answer, because the whole arrangement rests on a
   * variable's *name* being allowed across this boundary and its value
   * never being.
   */
  describe("a reference to EO's environment", () => {
    const VALUE = "/opt/jdk21-nobody-may-read-this";
    const launchedWith = (environment: Record<string, string>): ModuleSecretsOptions => ({ ...secrets, environment });

    it("sets one, and reads the variable of the declared name when none is given", () => {
      const here = launchedWith({ JAVA_HOME: VALUE });

      expect(setModuleSecret(handle.db, here, { name: "JAVA_HOME", reference: {} })).toEqual({ saved: true, problem: null, replaced: null });

      expect(environmentFor(here, ["JAVA_HOME"]).env).toEqual({ JAVA_HOME: VALUE });
      expect(listModuleSecrets(handle.db, here, {}).references).toEqual([{ name: "JAVA_HOME", variable: "JAVA_HOME", scope: "shared", available: true }]);
    });

    it("reports each reference in the shared scope and in the step asked about", () => {
      const here = launchedWith({ JDK21_HOME: VALUE });
      setModuleSecret(handle.db, here, { name: "JAVA_HOME", reference: { variable: "JDK21_HOME" } });
      setModuleSecret(handle.db, here, { name: "GOROOT", reference: {} });
      setModuleSecret(handle.db, here, { name: "JAVA_HOME", reference: { variable: "STEP_HOME" }, stepId });
      setModuleSecret(handle.db, here, { name: "FLY_API_TOKEN", value: "tok" });

      const listed = listModuleSecrets(handle.db, here, { stepId });

      expect(listed).toEqual({
        // A referenced name is "set" only when a dispatch would get a value.
        names: ["FLY_API_TOKEN", "JAVA_HOME"],
        overrides: [],
        organisation: [],
        references: [
          { name: "GOROOT", variable: "GOROOT", scope: "shared", available: false },
          { name: "JAVA_HOME", variable: "JDK21_HOME", scope: "shared", available: true },
          { name: "JAVA_HOME", variable: "STEP_HOME", scope: "step", available: false },
        ],
        // Only the one that is a value: a reference is not stored.
        stored: { shared: ["FLY_API_TOKEN"], step: [] },
      });
      expect(JSON.stringify(listed)).not.toContain(VALUE);
      // Without a step, only the shared scope is anybody's business.
      expect(listModuleSecrets(handle.db, here, {}).references.map((reference) => reference.scope)).toEqual(["shared", "shared"]);
    });

    it("lists a step's reference among the overrides once EO has the variable", () => {
      setModuleSecret(handle.db, secrets, { name: "JAVA_HOME", reference: { variable: "STEP_HOME" }, stepId });

      expect(listModuleSecrets(handle.db, launchedWith({}), { stepId }).overrides).toEqual([]);
      expect(listModuleSecrets(handle.db, launchedWith({ STEP_HOME: VALUE }), { stepId }).overrides).toEqual(["JAVA_HOME"]);
    });

    // The direction that loses something: the value cannot be read back
    // by anybody, so it cannot be put back either.
    it("replaces a stored value in the same scope, and says so", () => {
      const here = launchedWith({ JDK21_HOME: VALUE });
      setModuleSecret(handle.db, here, { name: "JAVA_HOME", value: "/stored" });

      expect(setModuleSecret(handle.db, here, { name: "JAVA_HOME", reference: { variable: "JDK21_HOME" } })).toEqual({
        saved: true,
        problem: null,
        replaced: "value",
      });

      expect(environmentFor(here, ["JAVA_HOME"]).env).toEqual({ JAVA_HOME: VALUE });
      expect(readdirSync(directory)).toEqual(["reference-JAVA_HOME.json"]);
    });

    it("replaces a reference when a value is stored in the same scope", () => {
      const here = launchedWith({ JDK21_HOME: VALUE });
      setModuleSecret(handle.db, here, { name: "JAVA_HOME", reference: { variable: "JDK21_HOME" } });

      expect(setModuleSecret(handle.db, here, { name: "JAVA_HOME", value: "/stored" })).toEqual({ saved: true, problem: null, replaced: "reference" });

      expect(environmentFor(here, ["JAVA_HOME"]).env).toEqual({ JAVA_HOME: "/stored" });
      expect(listModuleSecrets(handle.db, here, {}).references).toEqual([]);
    });

    // What the warning in front of a reference is drawn from (EO-417):
    // `names` and `overrides` drop a value that no longer decrypts, and a
    // reference saved over it removes it all the same.
    it("lists a stored value that can no longer be read as stored, by name, though it is not set", () => {
      setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "shared" });
      setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "production", stepId });
      const locked: ModuleSecretsOptions = {
        directory,
        store: {
          ...store,
          decryptString: () => {
            throw new Error("the keychain no longer has the key");
          },
        },
      };

      const listed = listModuleSecrets(handle.db, locked, { stepId });
      expect(listed).toMatchObject({ names: [], overrides: [], stored: { shared: ["FLY_API_TOKEN"], step: ["FLY_API_TOKEN"] } });
      expect(listModuleSecrets(handle.db, locked, {}).stored).toEqual({ shared: ["FLY_API_TOKEN"], step: [] });
      expect(JSON.stringify(listed)).not.toContain("production");
      // And it is what the write then says it removed.
      expect(setModuleSecret(handle.db, locked, { name: "FLY_API_TOKEN", reference: {}, stepId }).replaced).toBe("value");
      expect(listModuleSecrets(handle.db, locked, { stepId }).stored).toEqual({ shared: ["FLY_API_TOKEN"], step: [] });
    });

    it("does not list a reference as stored", () => {
      setModuleSecret(handle.db, secrets, { name: "JAVA_HOME", reference: {} });

      expect(listModuleSecrets(handle.db, secrets, {}).stored).toEqual({ shared: [], step: [] });
    });

    it("does not call a step's reference a replacement of the shared value", () => {
      setModuleSecret(handle.db, secrets, { name: "JAVA_HOME", value: "/stored" });

      expect(setModuleSecret(handle.db, secrets, { name: "JAVA_HOME", reference: {}, stepId }).replaced).toBeNull();
      expect(environmentFor(secrets, ["JAVA_HOME"]).env).toEqual({ JAVA_HOME: "/stored" });
    });

    it("clears a reference", () => {
      const here = launchedWith({ JAVA_HOME: VALUE });
      setModuleSecret(handle.db, here, { name: "JAVA_HOME", reference: {} });

      expect(clearModuleSecret(handle.db, here, { name: "JAVA_HOME" })).toEqual({ cleared: true });

      expect(listModuleSecrets(handle.db, here, {})).toMatchObject({ names: [], references: [] });
    });

    // Where `storeSecret` can only refuse, for want of a keyring.
    it("is set and used on a machine with no keychain", () => {
      const here: ModuleSecretsOptions = { directory, store: { ...store, isEncryptionAvailable: () => false }, environment: { JDK21_HOME: VALUE } };

      expect(setModuleSecret(handle.db, here, { name: "JAVA_HOME", reference: { variable: "JDK21_HOME" } }).saved).toBe(true);

      expect(environmentFor(here, ["JAVA_HOME"]).env).toEqual({ JAVA_HOME: VALUE });
      expect(listModuleSecrets(handle.db, here, {}).names).toEqual(["JAVA_HOME"]);
    });

    it("refuses a reference for a step that does not exist", () => {
      const result = setModuleSecret(handle.db, secrets, { name: "JAVA_HOME", reference: {}, stepId: "019fb8c6-0000-7000-8000-00000000beef" });

      expect(result.saved).toBe(false);
      expect(listModuleSecrets(handle.db, secrets, {}).references).toEqual([]);
    });

    it.each([
      ["both", { name: "JAVA_HOME", value: "/stored", reference: {} }],
      ["neither", { name: "JAVA_HOME" }],
    ])("refuses %s a value and a reference, and changes nothing", (_label, input) => {
      setModuleSecret(handle.db, secrets, { name: "JAVA_HOME", value: "/before" });

      const result = setModuleSecret(handle.db, secrets, input);

      expect(result).toMatchObject({ saved: false, replaced: null });
      expect(result.problem).toContain("one of the two");
      expect(environmentFor(secrets, ["JAVA_HOME"]).env).toEqual({ JAVA_HOME: "/before" });
    });

    // The schema is the boundary: a variable that is not a name never
    // reaches the store, which would throw on it.
    it("holds the variable to the pattern a declared name is held to", () => {
      const request = ipcContract["moduleSecrets:set"].request;

      expect(request.safeParse({ name: "JAVA_HOME", reference: { variable: "JDK21_HOME" } }).success).toBe(true);
      expect(request.safeParse({ name: "JAVA_HOME", reference: { variable: "JDK21-HOME" } }).success).toBe(false);
      expect(request.safeParse({ name: "JAVA_HOME", reference: { variable: "$(whoami)" } }).success).toBe(false);
    });
  });
});

/**
 * Reveal (EO-489, ARCHITECTURE.md §14.2): the stored value of one scope,
 * for the person at the desktop. The scope asked about and nothing
 * wider, and never a reference.
 */
describe("revealing a module secret", () => {
  it("answers the shared value, and a step's own override for that step", () => {
    setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "shared" });
    setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "production", stepId });

    expect(revealModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN" })).toEqual({ state: "value", value: "shared" });
    expect(revealModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", stepId })).toEqual({ state: "value", value: "production" });
  });

  it("does not answer a step with the shared value it falls back to", () => {
    // The Reveal is pressed on the row's own scope; a step with no
    // override of its own has nothing stored to show.
    setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "shared" });

    expect(revealModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", stepId })).toEqual({ state: "absent" });
  });

  it("never reveals a reference, which is not a stored value", () => {
    const withEnvironment = { ...secrets, environment: { JDK21_HOME: "/opt/jdk21" } };
    setModuleSecret(handle.db, withEnvironment, { name: "JAVA_HOME", reference: { variable: "JDK21_HOME" } });

    const answer = revealModuleSecret(handle.db, withEnvironment, { name: "JAVA_HOME" });

    expect(answer).toEqual({ state: "reference" });
    expect(JSON.stringify(answer)).not.toContain("/opt/jdk21");
  });

  it("says a value that no longer decrypts cannot be read, rather than answering an empty one", () => {
    setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "shared" });
    const anotherKeychain = {
      ...secrets,
      store: {
        ...store,
        decryptString: (): string => {
          throw new Error("not this keychain's");
        },
      },
    };

    expect(revealModuleSecret(handle.db, anotherKeychain, { name: "FLY_API_TOKEN" })).toEqual({ state: "unreadable" });
  });

  it("answers nothing for a name never set, and for a step that does not exist", () => {
    expect(revealModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN" })).toEqual({ state: "absent" });
    setModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", value: "shared" });
    // Not the shared value: a step id nobody has is not the shared scope.
    expect(revealModuleSecret(handle.db, secrets, { name: "FLY_API_TOKEN", stepId: "no-such-step" })).toEqual({ state: "absent" });
  });

  it("does not reveal an environment variable through the Secrets channel", () => {
    // A variable's value is already shown in full on its own list; this
    // channel answers for the secret store and nothing else.
    storeVariable(secrets, "REGION", "eu-west-1");

    expect(revealModuleSecret(handle.db, secrets, { name: "REGION" })).toEqual({ state: "absent" });
  });

  it("is in the machine half of the contract", () => {
    expect(Object.hasOwn(machineContract, "moduleSecrets:reveal")).toBe(true);
  });
});
