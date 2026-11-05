import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readApiKey, storeApiKey } from "../runtimes/apiKey.js";
import { createServerSecretStore } from "../secrets/serverStore.js";
import { rotateSecretsCommand, ROTATE_FLAG } from "./rotateCommand.js";

/**
 * The rotation command as an admin actually runs it (EO-320).
 *
 * `rotateServerSecrets.test.ts` covers what rotation does to a volume.
 * This covers the part between that and a person: which variables are
 * read, which flags are taken, and what is printed — including the
 * sentence that says the job is not finished until they swap the key in
 * their own deployment, because EO cannot do that for them.
 */
const OLD_KEY = Buffer.alloc(32, 1);
const NEW_KEY = Buffer.alloc(32, 2);

let directory = "";
const created: string[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo-rotate-cmd-"));
  created.push(directory);
});
afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function credentials(key: Buffer): { directory: string; store: ReturnType<typeof createServerSecretStore> } {
  return { directory: join(directory, "credentials"), store: createServerSecretStore(key) };
}

function keyFile(key: Buffer): string {
  const holder = mkdtempSync(join(tmpdir(), "eo-rotate-key-"));
  created.push(holder);
  const path = join(holder, "key");
  writeFileSync(path, `${key.toString("base64")}\n`, { mode: 0o600 });
  return path;
}

describe("the --rotate-secrets command", () => {
  it("rotates a real data directory from the environment", () => {
    storeApiKey(credentials(OLD_KEY), "claude", "sk-ant-the-billable-one");

    const outcome = rotateSecretsCommand(
      {
        EO_SERVER_DATA: directory,
        EO_SERVER_SECRET_KEY: OLD_KEY.toString("base64"),
        EO_SERVER_NEW_SECRET_KEY: NEW_KEY.toString("base64"),
      },
      [ROTATE_FLAG],
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.lines[0]).toContain("Re-encrypted 1");
    // The half EO cannot do: the operator's own deployment still points
    // at the old key, and a command that did not say so would leave a
    // server that no longer starts.
    expect(outcome.lines.join("\n")).toContain("EO_SERVER_SECRET_KEY");
    expect(readApiKey(credentials(NEW_KEY), "claude")).toBe("sk-ant-the-billable-one");
    expect(readApiKey(credentials(OLD_KEY), "claude")).toBeNull();
  });

  it("takes both keys as mounted files, which is how a secret arrives in a container", () => {
    storeApiKey(credentials(OLD_KEY), "claude", "sk-ant-the-billable-one");

    const outcome = rotateSecretsCommand({ EO_SERVER_DATA: directory }, [
      ROTATE_FLAG,
      `--secret-key-file=${keyFile(OLD_KEY)}`,
      "--new-secret-key-file",
      keyFile(NEW_KEY),
    ]);

    expect(outcome.ok).toBe(true);
    expect(readApiKey(credentials(NEW_KEY), "claude")).toBe("sk-ant-the-billable-one");
  });

  it("names the variable it is missing, one at a time", () => {
    expect(rotateSecretsCommand({}, [ROTATE_FLAG]).lines[0]).toContain("EO_SERVER_DATA");
    expect(rotateSecretsCommand({ EO_SERVER_DATA: directory }, [ROTATE_FLAG]).lines[0]).toContain("EO_SERVER_SECRET_KEY");
    // The new key is the one people forget, having set the old one
    // months ago and never thought about it since.
    expect(rotateSecretsCommand({ EO_SERVER_DATA: directory, EO_SERVER_SECRET_KEY: OLD_KEY.toString("base64") }, [ROTATE_FLAG]).lines[0]).toContain(
      "EO_SERVER_NEW_SECRET_KEY",
    );
  });

  it("refuses a flag it does not take, rather than ignoring it", () => {
    // `--token` is a *server* flag, and taking it silently here would
    // let somebody believe rotation had read something it had not.
    const outcome = rotateSecretsCommand({ EO_SERVER_DATA: directory }, [ROTATE_FLAG, "--token", "t"]);

    expect(outcome.ok).toBe(false);
    expect(outcome.lines[0]).toContain("--token");
  });

  it("names every value it could not read, and reports failure", () => {
    storeApiKey(credentials(Buffer.alloc(32, 9)), "claude", "written under a third key");

    const outcome = rotateSecretsCommand(
      { EO_SERVER_DATA: directory, EO_SERVER_SECRET_KEY: OLD_KEY.toString("base64"), EO_SERVER_NEW_SECRET_KEY: NEW_KEY.toString("base64") },
      [ROTATE_FLAG],
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join("\n")).toContain("runtime-claude-api-key.bin");
  });

  it("says when it found nothing, because that is usually the wrong directory", () => {
    const outcome = rotateSecretsCommand(
      { EO_SERVER_DATA: directory, EO_SERVER_SECRET_KEY: OLD_KEY.toString("base64"), EO_SERVER_NEW_SECRET_KEY: NEW_KEY.toString("base64") },
      [ROTATE_FLAG],
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.lines.join("\n")).toContain("No stored values were found");
  });
});
