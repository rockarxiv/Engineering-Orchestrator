import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moduleReadinessRefusal, type ModuleManifest } from "@eo/core";
import { launchable, moduleReadiness, resolveModuleRun } from "./readiness.js";
import { storeReference, storeSecret, storeVariable, trialScopeOf, type ModuleSecretsOptions } from "./secrets.js";

/**
 * The shared readiness check (EO-816): every declared binary and
 * environment name, by name and status, resolved the way the run itself
 * is — and never a value.
 */

const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => {
    const text = buffer.toString();
    if (!text.startsWith("enc:")) throw new Error("not this keychain");
    return text.slice(4);
  },
};

let scratch: string;
let secrets: ModuleSecretsOptions;
let bin: string;

/** A file `ctx.exec` would start, in `bin`: an executable file on POSIX, a `.exe` on Windows. */
function install(name: string): void {
  const file = join(bin, process.platform === "win32" ? `${name}.exe` : name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
}

function needs(binaries: string[], env: string[]): Pick<ModuleManifest, "needs"> {
  return { needs: { bin: binaries, env, network: false, item: false, comment: false, attach: false, create: false } };
}

const SECRET = "4e1f-only-in-the-store";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo-readiness-"));
  bin = join(scratch, "bin");
  mkdirSync(bin);
  secrets = { directory: join(scratch, "secrets"), store, environment: {} };
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("a module missing several things", () => {
  it("names every missing binary and environment name together, each with its own status", () => {
    install("gh");
    storeSecret(secrets, "FLY_API_TOKEN", SECRET);
    storeReference(secrets, "JAVA_HOME", "JDK21_HOME");
    // Written by a keychain this machine no longer has.
    storeSecret({ ...secrets, store: { ...store, encryptString: (text: string) => Buffer.from(`other:${text}`) } }, "DEPLOY_KEY", "x");

    const readiness = moduleReadiness(needs(["gh", "eo-816-absent", "jq-816"], ["FLY_API_TOKEN", "SLACK_WEBHOOK", "JAVA_HOME", "DEPLOY_KEY"]), {
      secrets,
      binaries: { directories: [bin] },
    });

    expect(readiness).toEqual({
      ready: false,
      bin: [
        { name: "gh", status: "found" },
        { name: "eo-816-absent", status: "missing" },
        { name: "jq-816", status: "missing" },
      ],
      env: [
        { name: "FLY_API_TOKEN", status: "set" },
        { name: "SLACK_WEBHOOK", status: "unset" },
        { name: "JAVA_HOME", status: "dangling", variable: "JDK21_HOME" },
        { name: "DEPLOY_KEY", status: "unreadable" },
      ],
    });

    const refusal = moduleReadinessRefusal("Deploy", readiness)!;
    for (const name of ["eo-816-absent", "jq-816", "SLACK_WEBHOOK", "JAVA_HOME", "JDK21_HOME", "DEPLOY_KEY"]) expect(refusal).toContain(name);
    expect(refusal).not.toContain(SECRET);
  });

  it("never carries a value, though the run's own environment does", () => {
    storeSecret(secrets, "FLY_API_TOKEN", SECRET);
    storeVariable(secrets, "REGION", "eu-west-1");
    const resolved = resolveModuleRun(needs([], ["FLY_API_TOKEN", "REGION"]), { secrets, binaries: { directories: [] } });

    expect(resolved.env).toEqual({ FLY_API_TOKEN: SECRET, REGION: "eu-west-1" });
    expect(resolved.readiness.ready).toBe(true);
    const shown = JSON.stringify(resolved.readiness);
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain("eu-west-1");
  });
});

describe("a module with everything it needs", () => {
  it("is ready, and has nothing to refuse", () => {
    install("gh");
    storeSecret(secrets, "FLY_API_TOKEN", SECRET);
    const readiness = moduleReadiness(needs(["gh"], ["FLY_API_TOKEN"]), { secrets, binaries: { directories: [bin] } });
    expect(readiness.ready).toBe(true);
    expect(moduleReadinessRefusal("Deploy", readiness)).toBeNull();
  });

  it("is ready when it declares nothing", () => {
    expect(moduleReadiness(needs([], []), { secrets, binaries: { directories: [] } })).toEqual({ ready: true, bin: [], env: [] });
  });

  it("reads what it is asked about afresh: something installed or set since the last check is found", () => {
    const manifest = needs(["eo-816-later"], ["FLY_API_TOKEN"]);
    const scope = { secrets, binaries: { directories: [bin] } };
    expect(moduleReadiness(manifest, scope).ready).toBe(false);
    install("eo-816-later");
    storeSecret(secrets, "FLY_API_TOKEN", SECRET);
    expect(moduleReadiness(manifest, scope).ready).toBe(true);
  });
});

describe("the scope a run reads", () => {
  it("counts a step's own value on that step and not on another", () => {
    storeSecret(secrets, "FLY_API_TOKEN", SECRET, "production");
    const manifest = needs([], ["FLY_API_TOKEN"]);
    expect(moduleReadiness(manifest, { secrets, step: "production", binaries: { directories: [] } }).env).toEqual([{ name: "FLY_API_TOKEN", status: "set" }]);
    expect(moduleReadiness(manifest, { secrets, step: "staging", binaries: { directories: [] } }).env).toEqual([{ name: "FLY_API_TOKEN", status: "unset" }]);
    expect(moduleReadiness(manifest, { secrets, step: null, binaries: { directories: [] } }).env).toEqual([{ name: "FLY_API_TOKEN", status: "unset" }]);
  });

  it("does not fall back from a step's unreadable value to the shared one", () => {
    storeSecret(secrets, "FLY_API_TOKEN", SECRET);
    storeSecret({ ...secrets, store: { ...store, encryptString: (text: string) => Buffer.from(`other:${text}`) } }, "FLY_API_TOKEN", "x", "production");
    expect(moduleReadiness(needs([], ["FLY_API_TOKEN"]), { secrets, step: "production", binaries: { directories: [] } }).env).toEqual([{ name: "FLY_API_TOKEN", status: "unreadable" }]);
  });

  it("counts the organisation's value, and an unreadable one as unreadable", () => {
    const manifest = needs([], ["ORG_TOKEN", "BROKEN"]);
    const readiness = moduleReadiness(manifest, {
      secrets,
      organisation: (name) => (name === "ORG_TOKEN" ? { state: "value", value: SECRET } : name === "BROKEN" ? { state: "unreadable" } : { state: "absent" }),
      binaries: { directories: [] },
    });
    expect(readiness.env).toEqual([
      { name: "ORG_TOKEN", status: "set" },
      { name: "BROKEN", status: "unreadable" },
    ]);
    expect(JSON.stringify(readiness)).not.toContain(SECRET);
  });

  it("withholds from a redirected trial step what only the live step sets, and counts what the trial sets", () => {
    storeSecret(secrets, "FLY_API_TOKEN", SECRET, "deploy");
    storeSecret(secrets, "SLACK_WEBHOOK", "live-hook", "deploy");
    storeSecret(secrets, "SLACK_WEBHOOK", "trial-hook", trialScopeOf("deploy"));
    // The shared value the step was set up to replace is not given either.
    storeSecret(secrets, "FLY_API_TOKEN", "shared-token");

    const readiness = moduleReadiness(needs([], ["FLY_API_TOKEN", "SLACK_WEBHOOK"]), {
      secrets,
      step: { stepId: "deploy", trialScope: trialScopeOf("deploy") },
      binaries: { directories: [] },
    });

    expect(readiness.env).toEqual([
      { name: "FLY_API_TOKEN", status: "withheld" },
      { name: "SLACK_WEBHOOK", status: "set" },
    ]);
    expect(moduleReadinessRefusal("Deploy", readiness)).toContain("set on the step but not for its trial");
  });
});

/**
 * The lookup `ctx.exec`'s `spawn` does, which has no shell — on each OS
 * EO ships to, whichever this test runs on.
 */
describe("finding a binary as ctx.exec would", () => {
  const files =
    (...paths: string[]) =>
    (candidate: string) =>
      paths.includes(candidate);

  it("on Windows, looks in the directory it runs in before PATH, and appends .com and .exe", () => {
    expect(launchable("gh", { directories: ["C:\\tools"], platform: "win32", cwd: "C:\\work", runnable: files("C:\\work\\gh.exe") })).toBe(true);
    expect(launchable("gh", { directories: ["C:\\tools"], platform: "win32", cwd: "C:\\work", runnable: files("C:\\tools\\gh.com") })).toBe(true);
    expect(launchable("gh", { directories: ["C:\\tools"], platform: "win32", cwd: "C:\\work", runnable: files("C:\\tools\\gh.cmd") })).toBe(false);
  });

  it("takes a relative name from the directory the module runs in", () => {
    expect(launchable("./scripts/release", { directories: ["/usr/bin"], platform: "linux", cwd: "/work/repo", runnable: files("/work/repo/scripts/release") })).toBe(true);
    expect(launchable("scripts\\release.exe", { directories: [], platform: "win32", cwd: "C:\\work", runnable: files("C:\\work\\scripts\\release.exe") })).toBe(true);
    // On POSIX a bare name is never looked for in the working directory.
    expect(launchable("release", { directories: ["/usr/bin"], platform: "linux", cwd: "/work/repo", runnable: files("/work/repo/release") })).toBe(false);
  });

  it.skipIf(process.platform === "win32")("does not count a file without its execute bit", () => {
    const file = join(bin, "not-executable");
    writeFileSync(file, "");
    chmodSync(file, 0o644);
    expect(launchable("not-executable", { directories: [bin] })).toBe(false);
  });
});
