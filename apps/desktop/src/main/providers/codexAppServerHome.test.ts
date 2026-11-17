import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppServerConnection } from "./codexAppServer.js";
import { codexHomeInUse } from "./codexHome.js";

/**
 * The Codex home an app-server EO started runs in is held from its spawn
 * until it has exited (EO-829): preparing the home skips the scrub while
 * it is held, and the sweep leaves it alone. The "app-server" here is a
 * shell script that waits on its stdin, so it ends when EO closes it.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.runIf(process.platform !== "win32")("the Codex home an app-server runs in", () => {
  it("is in use from the spawn until the process has exited, and only that home", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eo-codex-held-"));
    directories.push(directory);
    const home = join(directory, "codex-homes", "agent", "ticket");
    const executable = join(directory, "codex");
    writeFileSync(executable, "#!/bin/sh\nexec cat >/dev/null\n");
    chmodSync(executable, 0o755);

    const connection = new AppServerConnection({ executablePath: executable, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", CODEX_HOME: home } });

    expect(codexHomeInUse(home)).toBe(true);
    // The agent's directory holds a home in use, so it is in use too.
    expect(codexHomeInUse(join(directory, "codex-homes", "agent"))).toBe(true);
    expect(codexHomeInUse(join(directory, "codex-homes", "agent", "other-ticket"))).toBe(false);

    await connection.terminate(200);
    await connection.exited();
    await Promise.resolve();

    expect(codexHomeInUse(home)).toBe(false);
  });
});
