import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSearchPathForTests, resolveSearchPath, type ShellRunner } from "../../../process/searchPath.js";
import { createCliRunner } from "./cli.js";
import { missingCli } from "./errors.js";

/**
 * Where `gh` and `glab` are looked for (EO-655, GitHub #15).
 *
 * An app opened from Finder inherits launchd's PATH; the person's
 * terminal, and the agent shell, have Homebrew. These run on POSIX only:
 * the PATHs are colon-separated and the fixture is a shebang script.
 */

const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const shellReporting =
  (path: string): ShellRunner =>
  async () => ({ code: 0, stdout: `__EO_LOGIN_SHELL_PATH_START__\n${path}\n__EO_LOGIN_SHELL_PATH_END__\n`, timedOut: false });

afterEach(() => {
  resetSearchPathForTests();
  vi.unstubAllEnvs();
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe.skipIf(process.platform === "win32")("finding the forge CLI", () => {
  /**
   * `/opt/homebrew/bin` cannot be written to by a test, so the operating
   * system's lookup is played by a stand-in for `execFile` that resolves
   * the name against the PATH it was handed and a filesystem holding
   * only `/opt/homebrew/bin/glab`.
   */
  it("finds glab in /opt/homebrew/bin when the login shell has it and the inherited PATH does not", async () => {
    vi.stubEnv("PATH", FINDER_PATH);
    const files = new Set(["/opt/homebrew/bin/glab"]);
    const searched: string[] = [];
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        execFile: (cli: string, _args: string[], options: { env: NodeJS.ProcessEnv }, callback: (error: unknown, result?: { stdout: string; stderr: string }) => void) => {
          const path = options.env["PATH"] ?? "";
          searched.push(path);
          const found = path.split(":").find((dir) => files.has(`${dir}/${cli}`));
          if (found) callback(null, { stdout: `${found}/${cli}\n`, stderr: "" });
          else callback(Object.assign(new Error(`spawn ${cli} ENOENT`), { code: "ENOENT", stdout: "", stderr: "" }));
        },
      };
    });
    vi.resetModules();
    const { createCliRunner: createMockedRunner } = await import("./cli.js");
    const { resolveSearchPath: resolveMocked } = await import("../../../process/searchPath.js");

    // Made before the shell has answered, as every caller's is at startup.
    const run = createMockedRunner();

    await resolveMocked({ platform: "darwin", shell: "/bin/zsh", run: shellReporting("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin") });
    const after = await run("glab", ["mr", "list"], "/");

    expect(after).toMatchObject({ ok: true, stdout: "/opt/homebrew/bin/glab" });
    // The login shell's answer, ahead of what Finder handed EO.
    expect(searched).toHaveLength(1);
    expect(searched[0]?.split(":").slice(0, 5)).toEqual(["/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  });

  it("really runs a CLI from a directory only the login shell knows about", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eo-login-bin-"));
    try {
      writeFileSync(join(dir, "eo-fake-glab"), "#!/bin/sh\necho found\n");
      chmodSync(join(dir, "eo-fake-glab"), 0o755);
      vi.stubEnv("PATH", FINDER_PATH);
      const run = createCliRunner(10_000);

      expect(await run("eo-fake-glab", [], dir)).toMatchObject({ ok: false, notFound: true });

      await resolveSearchPath({ platform: "darwin", shell: "/bin/zsh", run: shellReporting(`${dir}:${FINDER_PATH}`) });

      expect(await run("eo-fake-glab", [], dir)).toMatchObject({ ok: true, stdout: "found" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says where it looked when the CLI is not there, and still points at Settings → Forge", async () => {
    vi.stubEnv("PATH", FINDER_PATH);
    await resolveSearchPath({ platform: "darwin", shell: "/bin/zsh", run: shellReporting("/opt/homebrew/bin:/usr/bin") });

    const { message } = missingCli("glab");

    expect(message).toContain("Settings → Forge");
    expect(message).toContain("EO looked in: /opt/homebrew/bin, /usr/bin, /bin, /usr/sbin, /sbin");
  });
});
