import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * That the command the documentation gives actually starts the server
 * (EO-319).
 *
 * It did not. Both doc comments said `pnpm --filter @eo/desktop server`,
 * and the script was called `server` — but `pnpm server` is pnpm's own
 * store-server command, so pnpm took it, rejected `--filter` with
 * `Unknown option: 'recursive'`, and exited. The script was never
 * reached. Nothing caught it because every test here started the server
 * by calling `startServer` in-process, which is the right way to test
 * what the server *does* and says nothing about how anybody starts it.
 *
 * The script is `start:server` now. A colon cannot collide, because
 * every pnpm command is a single word.
 */
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function packageScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  return manifest.scripts;
}

/**
 * pnpm commands that do something of their own rather than running the
 * script of that name.
 *
 * Hand-kept, and it has to be: pnpm publishes no machine-readable list,
 * and the distinction is not one a name reveals. `test`, `start`,
 * `restart` and `stop` are deliberately absent — pnpm implements those
 * as script runners for npm compatibility, so a script may be called
 * any of them and still be what runs.
 */
const PNPM_OWN_COMMANDS = [
  "add", "audit", "bin", "config", "create", "dedupe", "deploy", "dlx", "doctor", "env", "exec", "fetch",
  "import", "init", "install", "licenses", "link", "list", "ls", "outdated", "pack", "patch", "prune",
  "publish", "rebuild", "remove", "root", "run", "server", "setup", "store", "unlink", "update", "why",
];

/**
 * The one name that breaks the rule and is not this story's to change.
 *
 * `pnpm --filter @eo/desktop pack` builds a tarball instead of running
 * electron-builder — the same defect, found while fixing the server's.
 * Nothing in the repository calls it, so it is a trap rather than a
 * breakage, and renaming a release script is a decision for whoever owns
 * the release. Named here so it is a known exception rather than a hole,
 * and so the next one added fails this test.
 */
const KNOWN_SHADOWED = ["pack"];

describe("the commands that start this app's binaries", () => {
  it("gives no script a name pnpm would answer itself", () => {
    const shadowed = Object.keys(packageScripts())
      .filter((name) => !name.startsWith("//"))
      .filter((name) => PNPM_OWN_COMMANDS.includes(name))
      .filter((name) => !KNOWN_SHADOWED.includes(name));

    expect(shadowed).toEqual([]);
  });

  it("keeps the known exception honest", () => {
    // An exception for a script that has been renamed or deleted is an
    // exception nobody needs, and a list nobody prunes is how the rule
    // above quietly stops applying.
    const scripts = packageScripts();

    for (const name of KNOWN_SHADOWED) expect(scripts, name).toHaveProperty(name);
  });

  it("documents a command that names a script this package has", () => {
    // The failure was a doc naming a command that did not do what it
    // said. Read the docs, take every `pnpm --filter @eo/desktop …` out
    // of them, and insist the script it names exists and is one pnpm
    // will actually run.
    const commands = documentedCommands();

    expect(commands.length).toBeGreaterThan(0);
    for (const argv of commands) {
      const script = argv.at(-1) ?? "";

      expect(packageScripts(), script).toHaveProperty(script);
      // Unless the invocation spells `run`, in which case any name works
      // because pnpm has been told which way to dispatch.
      if (!argv.includes("run")) expect(PNPM_OWN_COMMANDS, script).not.toContain(script);
    }
  });

  it("reaches EO's own entry point when run exactly as documented", () => {
    // The end of the story, run for real — and run *verbatim*. The
    // arguments come out of the doc comment rather than being written
    // here, because the bug was in the invocation and a test that
    // supplied its own `run` would have fixed the thing it was meant to
    // catch.
    //
    // With no token EO refuses to start and names the variable, and
    // reaching that sentence is the whole assertion: only the script can
    // print it. `Unknown option` is what pnpm printed instead.
    // `Cannot find module` is accepted on the same grounds — that is
    // Node failing to find `out/server/index.js` in a checkout where
    // `build:server` has not run, which still means pnpm dispatched to
    // the package and not to itself.
    const launches = documentedCommands().filter((command) => command.at(-1)?.includes("server") === true);
    // Asserted before the loop, because a loop over nothing passes, and
    // "the regex stopped matching" must not read as "the command works".
    expect(launches.map((argv) => argv.at(-1))).toContain("start:server");

    for (const argv of launches) {
      const command = `pnpm ${argv.join(" ")}`;
      // Through a shell, as the person reading the docs would type it —
      // and because Windows has no `pnpm`, only `pnpm.cmd`, which Node
      // will neither find nor run without one.
      const result = spawnSync(command, {
        shell: true,
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 120_000,
        // Emptied rather than removed: `chosen()` in config.ts reads an
        // empty variable as unset, so this is a launch given no token
        // whatever the developer's own shell has in it.
        env: { ...process.env, EO_SERVER_TOKEN: "", EO_SERVER_DATA: "" },
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(output, command).not.toContain("Unknown option");
      expect(output, command).toMatch(/EO_SERVER_TOKEN|Cannot find module|vite|Build/i);
    }
  }, 240_000);
});

const repoRoot = join(appRoot, "..", "..");

/**
 * Every `pnpm --filter @eo/desktop …` the server's documentation gives,
 * as the argument list it would be typed as.
 *
 * Read rather than restated, so the test is about the sentence somebody
 * will actually copy.
 */
function documentedCommands(): string[][] {
  const commands: string[][] = [];
  for (const file of [join("src", "main", "server", "index.ts"), "vite.server.config.ts"]) {
    const text = readFileSync(join(appRoot, file), "utf8")
      // Doc comments wrap, and a command can straddle the break with a
      // ` * ` in the middle of it.
      .replace(/\n\s*\*\s?/g, " ");
    for (const match of text.matchAll(/pnpm --filter @eo\/desktop\s+((?:run\s+)?[a-z][a-z:-]*)/g)) {
      commands.push(["--filter", "@eo/desktop", ...(match[1] ?? "").split(/\s+/)]);
    }
  }
  return commands;
}
