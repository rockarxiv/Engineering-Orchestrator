import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentRunVariables,
  clearSecret,
  clearStepSecrets,
  clearVariable,
  environmentFor,
  hasVariable,
  listAvailableNames,
  listReferences,
  listSecretNames,
  listStoredNames,
  listVariables,
  readEntry,
  readVariableEntry,
  readSecret,
  readSecretEntry,
  storeReference,
  storeSecret,
  storeVariable,
  type ModuleSecretsOptions,
} from "./secrets.js";

/**
 * The named secrets a module can be given (KAN-105).
 *
 * The same arrangement the Jira token has, and tested the same way: a
 * `safeStorage` stand-in, so none of this needs Electron.
 */

/**
 * `safeStorage`, minus the OS.
 *
 * Reversing rather than prefixing, so "the plaintext is not in the file"
 * is a claim about the code under test rather than about the fake — a
 * prefix leaves the plaintext right there in the ciphertext, and the
 * assertion would pass for the wrong reason.
 */
const reverse = (text: string) => [...text].reverse().join("");
const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(reverse(text)),
  decryptString: (buffer: Buffer) => reverse(buffer.toString()),
};

let directory: string;
let options: ModuleSecretsOptions;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo module secrets "));
  options = { directory, store };
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("module secrets", () => {
  it("round-trips a value", () => {
    expect(storeSecret(options, "FLY_API_TOKEN", "tok-1").ok).toBe(true);
    expect(readSecret(options, "FLY_API_TOKEN")).toBe("tok-1");
  });

  it("never writes the value in the clear", () => {
    storeSecret(options, "FLY_API_TOKEN", "tok-1");
    expect(readFileSync(join(directory, "secret-FLY_API_TOKEN.bin"), "utf8")).not.toContain("tok-1");
  });

  it("answers null for a secret that was never set", () => {
    expect(readSecret(options, "NOTHING_HERE")).toBeNull();
  });

  // Writing in the clear would quietly break the one promise this exists
  // to keep, so it refuses and says why — as `storeToken` does.
  it("refuses to store anything when the machine has no keychain", () => {
    const result = storeSecret({ directory, store: { ...store, isEncryptionAvailable: () => false } }, "TOKEN", "x");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("keychain");
  });

  it("lists names and never values", () => {
    storeSecret(options, "B_TOKEN", "b");
    storeSecret(options, "A_TOKEN", "a");
    expect(listSecretNames(options)).toEqual(["A_TOKEN", "B_TOKEN"]);
  });

  it("lists nothing before anything has been stored", () => {
    expect(listSecretNames({ directory: join(directory, "not-yet"), store })).toEqual([]);
  });

  it("forgets a secret", () => {
    storeSecret(options, "TOKEN", "x");
    clearSecret(options, "TOKEN");
    expect(readSecret(options, "TOKEN")).toBeNull();
    expect(listSecretNames(options)).toEqual([]);
  });

  // A name is part of a path, so it is checked rather than escaped.
  it("refuses a name that is not an environment variable name", () => {
    expect(() => readSecret(options, "../../etc/passwd")).toThrow(/refusing/);
  });

  describe("environmentFor", () => {
    it("gives a module exactly what it declared", () => {
      storeSecret(options, "WANTED", "yes");
      storeSecret(options, "UNRELATED", "no");
      expect(environmentFor(options, ["WANTED"]).env).toEqual({ WANTED: "yes" });
    });

    // Absent rather than empty: a module checking `if (!TOKEN)` should
    // see the truth, where "" lets it get as far as an API call that
    // fails for a reason nobody can read.
    it("omits a declared name with no stored value", () => {
      expect(environmentFor(options, ["MISSING"])).toEqual({ env: {}, unreadable: [], dangling: [], variables: [] });
    });
  });

  /**
   * A file that is there and no longer decrypts — written by another
   * machine, or before this one's keychain was reset.
   *
   * Distinct from absent, because folding the two together is what let a
   * step's unreadable override fall through to the *shared* value: a
   * production step running on the staging token, deploying, with the
   * screen still calling the override set.
   */
  describe("a value that cannot be read", () => {
    const STEP = "019fb8c6-0000-7000-8000-0000000000aa";

    /**
     * A keychain that can tell its own ciphertext from somebody else's,
     * which the plain reversing fake cannot — it "decrypts" any bytes at
     * all, so nothing written by another machine would ever fail.
     */
    const MARK = "eo:";
    const mine = {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(MARK + reverse(text)),
      decryptString: (buffer: Buffer) => {
        const raw = buffer.toString();
        if (!raw.startsWith(MARK)) throw new Error("not written by this keychain");
        return reverse(raw.slice(MARK.length));
      },
    };

    let here: ModuleSecretsOptions;
    /** The same directory, written as another machine would have written it. */
    let elsewhere: ModuleSecretsOptions;

    beforeEach(() => {
      here = { directory: join(directory, "keychain"), store: mine };
      elsewhere = { ...here, store: { ...mine, encryptString: (text: string) => Buffer.from(reverse(text)) } };
    });

    it("is not the same as unset", () => {
      storeSecret(elsewhere, "FLY_API_TOKEN", "tok");

      expect(readSecretEntry(here, "FLY_API_TOKEN")).toEqual({ state: "unreadable" });
      expect(readSecretEntry(here, "NOTHING_HERE")).toEqual({ state: "absent" });
    });

    it("is refused rather than passed", () => {
      storeSecret(elsewhere, "FLY_API_TOKEN", "tok");

      expect(environmentFor(here, ["FLY_API_TOKEN"])).toEqual({ env: {}, unreadable: ["FLY_API_TOKEN"], dangling: [], variables: [] });
    });

    /**
     * The case worth the extra state: the shared value is staging's and
     * the step's own is production's. If the step's cannot be read, the
     * run has to stop — handing it the shared token would deploy the
     * wrong thing to the wrong place, and a wrong credential is worse
     * than no credential.
     */
    it("stops the fallback to the shared value", () => {
      storeSecret(here, "FLY_API_TOKEN", "staging");
      storeSecret(elsewhere, "FLY_API_TOKEN", "production", STEP);

      expect(environmentFor(here, ["FLY_API_TOKEN"], STEP)).toEqual({ env: {}, unreadable: ["FLY_API_TOKEN"], dangling: [], variables: [] });
      // And the shared value is untouched for every other step.
      expect(environmentFor(here, ["FLY_API_TOKEN"], "another-step").env).toEqual({ FLY_API_TOKEN: "staging" });
    });

    // "Set" on the screen means "a run would get a value". Listing a name
    // a run will refuse would have the two disagree in the one direction
    // that reads as reassuring.
    it("is not listed as set", () => {
      storeSecret(here, "READABLE", "yes");
      storeSecret(elsewhere, "FOREIGN", "no");

      expect(listSecretNames(here)).toEqual(["READABLE"]);
    });
  });

  /**
   * A step's own values.
   *
   * On the step rather than on the pipeline, because one pipeline can
   * deploy to staging and then to production — the same module twice,
   * with two different tokens. A pipeline-wide value could hold only one
   * of the two.
   */
  describe("per-step overrides", () => {
    const STEP = "019fb8c6-0000-7000-8000-0000000000aa";
    const OTHER = "019fb8c6-0000-7000-8000-0000000000bb";

    it("prefers the step's value over the shared one", () => {
      storeSecret(options, "FLY_API_TOKEN", "shared");
      storeSecret(options, "FLY_API_TOKEN", "production", STEP);

      expect(environmentFor(options, ["FLY_API_TOKEN"], STEP).env).toEqual({ FLY_API_TOKEN: "production" });
      expect(environmentFor(options, ["FLY_API_TOKEN"], OTHER).env).toEqual({ FLY_API_TOKEN: "shared" });
      expect(environmentFor(options, ["FLY_API_TOKEN"]).env).toEqual({ FLY_API_TOKEN: "shared" });
    });

    // Overriding one name is not opting out of the rest.
    it("falls back name by name", () => {
      storeSecret(options, "FLY_API_TOKEN", "shared");
      storeSecret(options, "SLACK_WEBHOOK", "hook");
      storeSecret(options, "FLY_API_TOKEN", "production", STEP);

      expect(environmentFor(options, ["FLY_API_TOKEN", "SLACK_WEBHOOK"], STEP).env).toEqual({ FLY_API_TOKEN: "production", SLACK_WEBHOOK: "hook" });
    });

    it("stands in for a shared value that was never set", () => {
      storeSecret(options, "FLY_API_TOKEN", "production", STEP);
      expect(environmentFor(options, ["FLY_API_TOKEN"], STEP).env).toEqual({ FLY_API_TOKEN: "production" });
      expect(environmentFor(options, ["FLY_API_TOKEN"]).env).toEqual({});
    });

    it("lists a step's overrides apart from the shared names", () => {
      storeSecret(options, "SHARED_ONE", "a");
      storeSecret(options, "FLY_API_TOKEN", "b", STEP);

      expect(listSecretNames(options)).toEqual(["SHARED_ONE"]);
      expect(listSecretNames(options, STEP)).toEqual(["FLY_API_TOKEN"]);
      expect(listSecretNames(options, OTHER)).toEqual([]);
    });

    // Clearing an override falls back to the shared value rather than
    // unsetting the name — that is what "use the shared one" means.
    it("clearing an override leaves the shared value alone", () => {
      storeSecret(options, "FLY_API_TOKEN", "shared");
      storeSecret(options, "FLY_API_TOKEN", "production", STEP);
      clearSecret(options, "FLY_API_TOKEN", STEP);

      expect(environmentFor(options, ["FLY_API_TOKEN"], STEP).env).toEqual({ FLY_API_TOKEN: "shared" });
    });

    /**
     * A step's overrides are reachable only through its id, so a removed
     * step must take them with it — otherwise they are ciphertext nothing
     * can ever read, list or remove again, and a later step that reused
     * the id would inherit them.
     */
    it("forgets everything a removed step overrode", () => {
      storeSecret(options, "FLY_API_TOKEN", "shared");
      storeSecret(options, "FLY_API_TOKEN", "production", STEP);
      storeSecret(options, "OTHER_TOKEN", "x", STEP);

      clearStepSecrets(options, STEP);

      expect(listSecretNames(options, STEP)).toEqual([]);
      expect(environmentFor(options, ["FLY_API_TOKEN"], STEP).env).toEqual({ FLY_API_TOKEN: "shared" });
    });

    it("is a no-op for a step that never had any", () => {
      expect(() => clearStepSecrets(options, OTHER)).not.toThrow();
    });

    /**
     * A step id is part of a path too — but hashed rather than checked.
     *
     * Nothing in EO constrains what a step id looks like: the editor
     * mints one and the architect invents them in a draft, so a rule
     * enforced only here would make `deploy.production` a step that threw
     * at dispatch and parked its item with a complaint about path
     * building. Every id has to be usable, and none may escape.
     */
    it("takes any step id, and lets none of them escape the directory", () => {
      storeSecret(options, "TOKEN", "a", "deploy.production");
      storeSecret(options, "TOKEN", "b", "../../../etc");
      storeSecret(options, "TOKEN", "c", "a step named by a person, at some length".repeat(4));

      expect(readSecret(options, "TOKEN", "deploy.production")).toBe("a");
      expect(readSecret(options, "TOKEN", "../../../etc")).toBe("b");
      expect(readSecret(options, "TOKEN", "a step named by a person, at some length".repeat(4))).toBe("c");
      // Distinct from each other, and none of them the shared value.
      expect(readSecret(options, "TOKEN")).toBeNull();
      // Everything landed under `steps/`, nothing beside it.
      expect(readdirSync(directory)).toEqual(["steps"]);
    });

    // The step directory sits inside the shared one, and must not be
    // mistaken for a secret named `steps`.
    it("does not list the step directory as a shared secret", () => {
      storeSecret(options, "TOKEN", "x", STEP);
      expect(listSecretNames(options)).toEqual([]);
    });
  });
});

/**
 * A name read from EO's own environment instead of from the store
 * (EO-416).
 *
 * `environment` stands in for what EO was launched with. Everything
 * here is about the resolution — which entry answers, and what happens
 * when the one that answers has nothing — so none of it needs a host.
 */
describe("a reference to EO's environment", () => {
  const STEP = "019fb8c6-0000-7000-8000-000000000001";
  const noKeychain = { ...store, isEncryptionAvailable: () => false };

  /** The same store, on a machine launched with these variables. */
  const launchedWith = (environment: Record<string, string>, base: ModuleSecretsOptions = options): ModuleSecretsOptions => ({ ...base, environment });

  it("reads the variable it names, under the declared name", () => {
    storeReference(options, "JAVA_HOME", "JDK21_HOME");

    const resolved = environmentFor(launchedWith({ JDK21_HOME: "/opt/jdk21", JAVA_HOME: "/wrong" }), ["JAVA_HOME"]);

    expect(resolved).toEqual({ env: { JAVA_HOME: "/opt/jdk21" }, unreadable: [], dangling: [], variables: [] });
  });

  it("reads the variable of the declared name when none is named", () => {
    storeReference(options, "JAVA_HOME");

    expect(readEntry(options, "JAVA_HOME")).toEqual({ state: "reference", variable: "JAVA_HOME" });
    expect(environmentFor(launchedWith({ JAVA_HOME: "/opt/jdk21" }), ["JAVA_HOME"]).env).toEqual({ JAVA_HOME: "/opt/jdk21" });
  });

  // The module still receives only what it declared: a reference is a
  // way to fill a declared name, not a way to widen the list.
  it("gives nothing that was not declared, whatever EO's environment holds", () => {
    storeReference(options, "JAVA_HOME");
    storeReference(options, "OTHER");

    expect(environmentFor(launchedWith({ JAVA_HOME: "/opt/jdk21", OTHER: "x" }), ["JAVA_HOME"]).env).toEqual({ JAVA_HOME: "/opt/jdk21" });
  });

  // Production has no `environment`: the source is the main process's
  // own `process.env`, read when asked.
  it("reads the process's own environment when no other is given", () => {
    const variable = "EO_416_REFERENCE_PROBE";
    storeReference(options, "JAVA_HOME", variable);
    process.env[variable] = "/opt/jdk21";
    try {
      expect(environmentFor(options, ["JAVA_HOME"]).env).toEqual({ JAVA_HOME: "/opt/jdk21" });
    } finally {
      delete process.env[variable];
    }
    expect(environmentFor(options, ["JAVA_HOME"]).dangling).toEqual([{ name: "JAVA_HOME", variable }]);
  });

  it.each([
    ["absent", {}],
    ["empty", { JDK21_HOME: "" }],
  ])("gives no value, and says which variable, when it is %s", (_label, environment: Record<string, string>) => {
    storeReference(options, "JAVA_HOME", "JDK21_HOME");

    expect(environmentFor(launchedWith(environment), ["JAVA_HOME"])).toEqual({
      env: {},
      unreadable: [],
      dangling: [{ name: "JAVA_HOME", variable: "JDK21_HOME" }],
      variables: [],
    });
  });

  describe("precedence", () => {
    it("lets an organisation value win over a reference in either scope", () => {
      storeReference(options, "JAVA_HOME", "SHARED_HOME");
      storeReference(options, "JAVA_HOME", "STEP_HOME", STEP);
      const here = launchedWith({ SHARED_HOME: "/shared", STEP_HOME: "/step" });

      expect(environmentFor(here, ["JAVA_HOME"], STEP, () => ({ state: "value", value: "/organisation" })).env).toEqual({ JAVA_HOME: "/organisation" });
      // …even over one that would have refused the run.
      expect(environmentFor(launchedWith({}), ["JAVA_HOME"], STEP, () => ({ state: "value", value: "/organisation" }))).toEqual({
        env: { JAVA_HOME: "/organisation" },
        unreadable: [],
        dangling: [],
        variables: [],
      });
    });

    it("lets a step's reference win over a shared stored value", () => {
      storeSecret(options, "JAVA_HOME", "/stored");
      storeReference(options, "JAVA_HOME", "JDK21_HOME", STEP);

      expect(environmentFor(launchedWith({ JDK21_HOME: "/opt/jdk21" }), ["JAVA_HOME"], STEP).env).toEqual({ JAVA_HOME: "/opt/jdk21" });
    });

    it("lets a step's stored value win over a shared reference", () => {
      storeReference(options, "JAVA_HOME", "JDK21_HOME");
      storeSecret(options, "JAVA_HOME", "/stored", STEP);

      expect(environmentFor(launchedWith({ JDK21_HOME: "/opt/jdk21" }), ["JAVA_HOME"], STEP).env).toEqual({ JAVA_HOME: "/stored" });
    });

    it("falls back to a shared reference for a step that says nothing", () => {
      storeReference(options, "JAVA_HOME", "JDK21_HOME");

      expect(environmentFor(launchedWith({ JDK21_HOME: "/opt/jdk21" }), ["JAVA_HOME"], STEP).env).toEqual({ JAVA_HOME: "/opt/jdk21" });
    });

    /**
     * The step says where this name comes from, and that place has
     * nothing. Running on the shared entry instead would be the step
     * using the one thing it was configured not to use — the argument
     * already made for an override that cannot be decrypted.
     */
    it("does not fall back from a step's dangling reference to a shared value", () => {
      storeSecret(options, "JAVA_HOME", "/stored");
      storeReference(options, "JAVA_HOME", "JDK21_HOME", STEP);

      expect(environmentFor(launchedWith({}), ["JAVA_HOME"], STEP)).toEqual({
        env: {},
        unreadable: [],
        dangling: [{ name: "JAVA_HOME", variable: "JDK21_HOME" }],
        variables: [],
      });
    });

    it("does not fall back from a step's dangling reference to a shared reference", () => {
      storeReference(options, "JAVA_HOME", "SHARED_HOME");
      storeReference(options, "JAVA_HOME", "JDK21_HOME", STEP);

      expect(environmentFor(launchedWith({ SHARED_HOME: "/shared" }), ["JAVA_HOME"], STEP)).toEqual({
        env: {},
        unreadable: [],
        dangling: [{ name: "JAVA_HOME", variable: "JDK21_HOME" }],
        variables: [],
      });
    });
  });

  describe("one entry per name in a scope", () => {
    it("removes the stored value when a reference is set", () => {
      storeSecret(options, "JAVA_HOME", "/stored");

      storeReference(options, "JAVA_HOME", "JDK21_HOME");

      expect(readSecretEntry(options, "JAVA_HOME")).toEqual({ state: "absent" });
      expect(readdirSync(directory)).toEqual(["reference-JAVA_HOME.json"]);
    });

    it("removes the reference when a value is stored", () => {
      storeReference(options, "JAVA_HOME", "JDK21_HOME");

      storeSecret(options, "JAVA_HOME", "/stored");

      expect(readEntry(options, "JAVA_HOME")).toEqual({ state: "value", value: "/stored" });
      expect(readdirSync(directory)).toEqual(["secret-JAVA_HOME.bin"]);
    });

    // A refusal must change nothing: the reference was working, and the
    // value that was to replace it was never written.
    it("keeps the reference when the value could not be stored", () => {
      storeReference(options, "JAVA_HOME", "JDK21_HOME");

      expect(storeSecret({ ...options, store: noKeychain }, "JAVA_HOME", "/stored").ok).toBe(false);

      expect(readEntry(options, "JAVA_HOME")).toEqual({ state: "reference", variable: "JDK21_HOME" });
    });

    it("leaves the other scope's entry alone", () => {
      storeSecret(options, "JAVA_HOME", "/stored");

      storeReference(options, "JAVA_HOME", "JDK21_HOME", STEP);

      expect(readSecret(options, "JAVA_HOME")).toBe("/stored");
    });

    it("clears a reference as it clears a value", () => {
      storeReference(options, "JAVA_HOME");

      clearSecret(options, "JAVA_HOME");

      expect(readEntry(options, "JAVA_HOME")).toEqual({ state: "absent" });
      expect(readdirSync(directory)).toEqual([]);
    });
  });

  /**
   * A variable's name is not a secret, so no keychain is asked for
   * anything — which is what makes this usable on the Linux machine
   * with no keyring running, where `storeSecret` can only refuse.
   */
  it("is set and used where there is no keychain", () => {
    const here = launchedWith({ JDK21_HOME: "/opt/jdk21" }, { directory, store: noKeychain });

    storeReference(here, "JAVA_HOME", "JDK21_HOME");

    expect(environmentFor(here, ["JAVA_HOME"]).env).toEqual({ JAVA_HOME: "/opt/jdk21" });
    expect(listSecretNames(here)).toEqual(["JAVA_HOME"]);
  });

  it("keeps the variable's name in the file and nothing of its value", () => {
    storeReference(options, "JAVA_HOME", "JDK21_HOME");
    environmentFor(launchedWith({ JDK21_HOME: "/opt/jdk21" }), ["JAVA_HOME"]);

    const written = readFileSync(join(directory, "reference-JAVA_HOME.json"), "utf8");
    expect(written).toContain("JDK21_HOME");
    expect(written).not.toContain("/opt/jdk21");
  });

  it("refuses a variable that is not a name", () => {
    expect(() => storeReference(options, "JAVA_HOME", "JDK21-HOME")).toThrow();
    expect(() => storeReference(options, "JAVA_HOME", "../../etc")).toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });

  // Something is there and it does not say what. Reading that as
  // nothing would let a step fall through to the shared entry.
  it("treats a reference file that names no variable as unreadable, not absent", () => {
    storeSecret(options, "JAVA_HOME", "/stored");
    storeReference(options, "JAVA_HOME", "JDK21_HOME", STEP);
    const file = readdirSync(join(directory, "steps")).map((hashed) => join(directory, "steps", hashed, "reference-JAVA_HOME.json"))[0]!;
    writeFileSync(file, "{ not json");

    expect(readEntry(options, "JAVA_HOME", STEP)).toEqual({ state: "unreadable" });
    expect(environmentFor(options, ["JAVA_HOME"], STEP)).toEqual({ env: {}, unreadable: ["JAVA_HOME"], dangling: [], variables: [] });
  });

  describe("what is listed", () => {
    // "Set" means a dispatch would get a value.
    it("counts a reference as set only when EO has the variable", () => {
      storeReference(options, "JAVA_HOME", "JDK21_HOME");
      storeSecret(options, "FLY_API_TOKEN", "tok");

      expect(listSecretNames(launchedWith({ JDK21_HOME: "/opt/jdk21" }))).toEqual(["FLY_API_TOKEN", "JAVA_HOME"]);
      expect(listSecretNames(launchedWith({}))).toEqual(["FLY_API_TOKEN"]);
      expect(listSecretNames(launchedWith({ JDK21_HOME: "" }))).toEqual(["FLY_API_TOKEN"]);
    });

    it("lists every reference in a scope, resolving or not, apart from stored values", () => {
      storeReference(options, "JAVA_HOME", "JDK21_HOME");
      storeReference(options, "GOROOT");
      storeSecret(options, "FLY_API_TOKEN", "tok");
      storeReference(options, "JAVA_HOME", "STEP_HOME", STEP);
      const here = launchedWith({ JDK21_HOME: "/opt/jdk21" });

      expect(listReferences(here)).toEqual([
        { name: "GOROOT", variable: "GOROOT", available: false },
        { name: "JAVA_HOME", variable: "JDK21_HOME", available: true },
      ]);
      expect(listReferences(here, STEP)).toEqual([{ name: "JAVA_HOME", variable: "STEP_HOME", available: false }]);
    });
  });

  // Reachable only through the step's id, exactly as its values are.
  it("goes when the step goes", () => {
    storeReference(options, "JAVA_HOME", "JDK21_HOME");
    storeReference(options, "JAVA_HOME", "STEP_HOME", STEP);
    storeReference(options, "GOROOT", "GOROOT", STEP);

    clearStepSecrets(options, STEP);

    expect(listReferences(options, STEP)).toEqual([]);
    expect(readEntry(options, "JAVA_HOME", STEP)).toEqual({ state: "absent" });
    expect(readdirSync(join(directory, "steps"))).toEqual([]);
    // The shared one is not the step's to take.
    expect(listReferences(options)).toHaveLength(1);
  });
});

/**
 * Environment variables (EO-485, ARCHITECTURE.md §14.2): values that
 * are not secret, kept beside the secrets' references and resolved in
 * the same order — the organisation's secret, then the step's entry of
 * any kind, then the shared entry of any kind.
 */
describe("environment variables", () => {
  const STEP = "019d0000-0000-7000-8000-000000000001";
  const OTHER = "019d0000-0000-7000-8000-000000000002";

  it("round-trips a value, in the clear, with no keychain at all", () => {
    // A keychain that refuses everything: a variable must not need one.
    const none: ModuleSecretsOptions = {
      directory,
      store: {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error("no keychain");
        },
        decryptString: () => {
          throw new Error("no keychain");
        },
      },
    };
    storeVariable(none, "REGION", "eu-west-1");

    expect(readVariableEntry(none, "REGION")).toEqual({ state: "value", value: "eu-west-1" });
    expect(listVariables(none)).toEqual([{ name: "REGION", value: "eu-west-1" }]);
    expect(environmentFor(none, ["REGION"])).toEqual({ env: { REGION: "eu-west-1" }, unreadable: [], dangling: [], variables: ["REGION"] });
    // Under userData's directory, readable as written.
    const file = readdirSync(directory).find((entry) => entry.includes("REGION"));
    expect(file).toBeDefined();
    expect(readFileSync(join(directory, file!), "utf8")).toContain("eu-west-1");
  });

  it("gives only the declared names", () => {
    storeVariable(options, "REGION", "eu-west-1");
    storeVariable(options, "UNRELATED", "no");

    expect(environmentFor(options, ["REGION"]).env).toEqual({ REGION: "eu-west-1" });
    expect(environmentFor(options, []).env).toEqual({});
  });

  it("lets a step's variable beat a shared variable or a shared secret, for that step only", () => {
    storeVariable(options, "REGION", "us-east-1", STEP);
    storeVariable(options, "REGION", "eu-west-1");
    expect(environmentFor(options, ["REGION"], STEP).env).toEqual({ REGION: "us-east-1" });
    expect(environmentFor(options, ["REGION"], OTHER).env).toEqual({ REGION: "eu-west-1" });

    clearVariable(options, "REGION");
    storeSecret(options, "REGION", "ap-south-1");
    expect(environmentFor(options, ["REGION"], STEP)).toMatchObject({ env: { REGION: "us-east-1" }, variables: ["REGION"] });
    // The shared entry is a secret now, and is not reported as a variable.
    expect(environmentFor(options, ["REGION"], OTHER)).toMatchObject({ env: { REGION: "ap-south-1" }, variables: [] });
  });

  it("lets a step's secret or reference beat a shared variable", () => {
    storeVariable(options, "REGION", "eu-west-1");
    storeSecret(options, "REGION", "from-a-secret", STEP);
    storeReference(options, "REGION", "LAUNCHED_REGION", OTHER);
    const here = { ...options, environment: { LAUNCHED_REGION: "from-a-reference" } };

    expect(environmentFor(here, ["REGION"], STEP).env).toEqual({ REGION: "from-a-secret" });
    expect(environmentFor(here, ["REGION"], OTHER).env).toEqual({ REGION: "from-a-reference" });
  });

  it("lets an organisation secret beat a variable in either scope", () => {
    storeVariable(options, "REGION", "eu-west-1");
    storeVariable(options, "REGION", "us-east-1", STEP);
    const organisation = (name: string) => (name === "REGION" ? { state: "value" as const, value: "org-region" } : { state: "absent" as const });

    expect(environmentFor(options, ["REGION"], STEP, organisation)).toEqual({ env: { REGION: "org-region" }, unreadable: [], dangling: [], variables: [] });
    expect(environmentFor(options, ["REGION"], null, organisation).env).toEqual({ REGION: "org-region" });
  });

  it("does not fall back from a step's unreadable variable to the shared entry", () => {
    storeVariable(options, "REGION", "eu-west-1");
    storeVariable(options, "REGION", "us-east-1", STEP);
    const stepDirectory = readdirSync(join(directory, "steps"))[0]!;
    writeFileSync(join(directory, "steps", stepDirectory, "variable-REGION.json"), "{ truncated");

    expect(readVariableEntry(options, "REGION", STEP)).toEqual({ state: "unreadable" });
    expect(environmentFor(options, ["REGION"], STEP)).toEqual({ env: {}, unreadable: ["REGION"], dangling: [], variables: [] });
    expect(listVariables(options, STEP)).toEqual([]);
  });

  // The same failure without needing permissions, so it holds when the
  // suite runs as root: a directory where the file should be is
  // something there that cannot be read as one.
  it("treats an entry that fails to read for any reason but absence as unreadable", () => {
    storeVariable(options, "REGION", "eu-west-1");
    storeVariable(options, "TIER", "gold", STEP);
    const stepDirectory = join(directory, "steps", readdirSync(join(directory, "steps"))[0]!);
    mkdirSync(join(stepDirectory, "variable-REGION.json"));

    expect(readVariableEntry(options, "REGION", STEP)).toEqual({ state: "unreadable" });
    expect(hasVariable(options, "REGION", STEP)).toBe(true);
    expect(environmentFor(options, ["REGION"], STEP)).toEqual({ env: {}, unreadable: ["REGION"], dangling: [], variables: [] });
  });

  /**
   * A file that is there and cannot be read is not a file that is not
   * there (EO-485 review). Permission denied is the case a person can
   * reach by hand; root reads everything, so it cannot be staged there.
   * Nor on Windows, where `chmod` only sets the read-only flag: the file
   * is still read, and a save cannot rename over it.
   */
  describe.skipIf(process.getuid?.() === 0 || process.platform === "win32")("an entry this process may not read", () => {
    const stepFile = (prefix: string) => {
      const stepDirectory = readdirSync(join(directory, "steps"))[0]!;
      return join(directory, "steps", stepDirectory, prefix);
    };

    it("stops the fallback from a step's variable to the shared one, and still counts as there", () => {
      storeVariable(options, "REGION", "eu-west-1");
      storeVariable(options, "REGION", "us-east-1", STEP);
      chmodSync(stepFile("variable-REGION.json"), 0o000);

      expect(readVariableEntry(options, "REGION", STEP)).toEqual({ state: "unreadable" });
      expect(hasVariable(options, "REGION", STEP)).toBe(true);
      expect(environmentFor(options, ["REGION"], STEP)).toEqual({ env: {}, unreadable: ["REGION"], dangling: [], variables: [] });
      // The other step is untouched by it.
      expect(environmentFor(options, ["REGION"], OTHER).env).toEqual({ REGION: "eu-west-1" });
    });

    it("can be replaced by saving the variable again", () => {
      storeVariable(options, "REGION", "us-east-1", STEP);
      chmodSync(stepFile("variable-REGION.json"), 0o000);

      storeVariable(options, "REGION", "us-west-2", STEP);

      expect(environmentFor(options, ["REGION"], STEP).env).toEqual({ REGION: "us-west-2" });
      expect(listVariables(options, STEP)).toEqual([{ name: "REGION", value: "us-west-2" }]);
    });

    it("is unreadable rather than absent for a step's secret or reference too", () => {
      storeVariable(options, "REGION", "eu-west-1");
      storeSecret(options, "REGION", "from-a-secret", STEP);
      storeReference(options, "TIER", "LAUNCHED_TIER", STEP);
      chmodSync(stepFile("secret-REGION.bin"), 0o000);
      chmodSync(stepFile("reference-TIER.json"), 0o000);

      expect(readEntry(options, "REGION", STEP)).toEqual({ state: "unreadable" });
      expect(readEntry(options, "TIER", STEP)).toEqual({ state: "unreadable" });
      expect(environmentFor({ ...options, environment: { LAUNCHED_TIER: "gold" } }, ["REGION", "TIER"], STEP)).toEqual({
        env: {},
        unreadable: ["REGION", "TIER"],
        dangling: [],
        variables: [],
      });
    });
  });

  it("is not a secret to any of the secrets' listings, and is a name a run would get", () => {
    storeVariable(options, "REGION", "eu-west-1");
    storeSecret(options, "FLY_API_TOKEN", "tok");

    expect(listSecretNames(options)).toEqual(["FLY_API_TOKEN"]);
    expect(listStoredNames(options)).toEqual(["FLY_API_TOKEN"]);
    expect(listReferences(options)).toEqual([]);
    expect(readEntry(options, "REGION")).toEqual({ state: "absent" });
    expect(listAvailableNames(options)).toEqual(["FLY_API_TOKEN", "REGION"]);
  });

  it("goes with its step, and leaves the shared one", () => {
    storeVariable(options, "REGION", "eu-west-1");
    storeVariable(options, "REGION", "us-east-1", STEP);
    storeVariable(options, "TIER", "gold", STEP);

    clearStepSecrets(options, STEP);

    expect(listVariables(options, STEP)).toEqual([]);
    expect(environmentFor(options, ["REGION", "TIER"], STEP).env).toEqual({ REGION: "eu-west-1" });
  });

  it("is cleared without touching a secret's files", () => {
    storeVariable(options, "REGION", "eu-west-1");
    clearVariable(options, "REGION");

    expect(readVariableEntry(options, "REGION")).toEqual({ state: "absent" });
    expect(() => clearVariable(options, "NEVER_SET")).not.toThrow();
  });
});

/**
 * What an agent run is given (EO-487): every shared variable plus its
 * step's own, the step's winning — and nothing that is a secret.
 */
describe("an agent run's environment variables", () => {
  const STEP = "019d0000-0000-7000-8000-000000000011";
  const OTHER = "019d0000-0000-7000-8000-000000000012";

  it("gives every shared variable, with the step's own over them for that step only", () => {
    storeVariable(options, "REGION", "eu-west-1");
    storeVariable(options, "TIER", "standard");
    storeVariable(options, "REGION", "us-east-2", STEP);
    storeVariable(options, "BUCKET", "step-bucket", STEP);

    expect(agentRunVariables(options, STEP)).toEqual({ REGION: "us-east-2", TIER: "standard", BUCKET: "step-bucket" });
    // Another step, and a run on no step, get the shared values alone.
    expect(agentRunVariables(options, OTHER)).toEqual({ REGION: "eu-west-1", TIER: "standard" });
    expect(agentRunVariables(options, null)).toEqual({ REGION: "eu-west-1", TIER: "standard" });
  });

  it("gives no secret and no reference, shared or the step's", () => {
    storeSecret(options, "FLY_API_TOKEN", "fly-secret");
    storeReference(options, "JAVA_HOME", "JDK21_HOME", STEP);
    storeVariable(options, "REGION", "eu-west-1");

    expect(agentRunVariables({ ...options, environment: { JDK21_HOME: "/opt/jdk21" } }, STEP)).toEqual({ REGION: "eu-west-1" });
  });

  it("reads them again on every call, so an edit or a removal reaches the next run", () => {
    storeVariable(options, "REGION", "eu-west-1");
    expect(agentRunVariables(options, STEP)).toEqual({ REGION: "eu-west-1" });

    storeVariable(options, "REGION", "ap-south-1");
    expect(agentRunVariables(options, STEP)).toEqual({ REGION: "ap-south-1" });

    clearVariable(options, "REGION");
    expect(agentRunVariables(options, STEP)).toEqual({});
  });

  it("keeps a variable called __proto__ as an own value, shared or the step's", () => {
    storeVariable(options, "__proto__", "shared-value");
    storeVariable(options, "constructor", "shared-constructor");
    storeVariable(options, "__proto__", "step-value", STEP);

    const onStep = agentRunVariables(options, STEP);
    const elsewhere = agentRunVariables(options, OTHER);

    expect(Object.getOwnPropertyDescriptor(onStep, "__proto__")?.value).toBe("step-value");
    expect(Object.getOwnPropertyDescriptor(elsewhere, "__proto__")?.value).toBe("shared-value");
    expect(Object.getOwnPropertyDescriptor(elsewhere, "constructor")?.value).toBe("shared-constructor");
    expect(Object.keys(onStep).sort()).toEqual(["__proto__", "constructor"]);
    // And the object is an ordinary one: the name became data, not a prototype.
    expect(Object.getPrototypeOf(onStep)).toBe(Object.prototype);
  });

  it("does not hand the shared value in place of a step variable that cannot be read", () => {
    storeVariable(options, "REGION", "eu-west-1");
    storeVariable(options, "TIER", "standard");
    storeVariable(options, "REGION", "us-east-2", STEP);
    const stepDirectory = readdirSync(join(directory, "steps"))[0]!;
    writeFileSync(join(directory, "steps", stepDirectory, "variable-REGION.json"), "{ truncated");

    expect(agentRunVariables(options, STEP)).toEqual({ TIER: "standard" });
    expect(agentRunVariables(options, OTHER)).toEqual({ REGION: "eu-west-1", TIER: "standard" });
  });
});
