import { execFileSync, spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isMissingCodexSession } from "./codex.js";
import { CodexClient, type ThreadEvent } from "./codexClient.js";
import { prepareCodexHome, removeCodexHome, type CodexHomeFs } from "./codexHome.js";

/**
 * What a redirected `CODEX_HOME` does to authentication and to
 * cross-run thread resume (EO-110).
 *
 * This is the evidence the design rests on, kept as something
 * that runs rather than something that was once observed. Codex reads
 * skills from `$CODEX_HOME/skills` and from nowhere else, so shipping
 * skills for this backend means redirecting the home — and a redirect
 * costs the credential at `~/.codex/auth.json` and the rollouts at
 * `~/.codex/sessions` that EO resumes across runs. The note concludes
 * that both are answerable with a symlink. These are the four facts
 * that conclusion stands on:
 *
 * 1. a redirected home with no credential is signed out;
 * 2. a symlinked `auth.json` signs it back in, and a credential *write*
 *    follows the link rather than replacing it — which is what keeps a
 *    token refresh in a per-agent home from stranding the person's real
 *    credential;
 * 3. a thread does not resume under a different home, and fails with
 *    exactly the string `providers/codex.ts` already matches;
 * 4. a symlinked `sessions` directory carries the resume across homes,
 *    which is why EO needs no session store and no migration.
 *
 * If a later Codex version breaks any of them, the follow-up story
 * proposed in the note needs revisiting, and this is where that shows
 * up.
 *
 * **Opt-in, because it spends real API credit on a real account** — two
 * trivial turns — and because it reads the person's own
 * `~/.codex/auth.json`. Skipped otherwise, so `pnpm test` and CI never
 * reach it:
 *
 *     EO_LIVE_CODEX=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/codexHome.live.test.ts
 *
 * Driven through `CodexClient` rather than through `createCodexProvider`,
 * because a probe for a decision cannot depend on the decision having
 * been implemented. EO-378 has since implemented it — the provider runs a
 * locked-down agent in a home of its own (`codexHome.ts`) — and the last
 * block in this file asserts the home *that* code builds. The client is
 * the transport EO runs Codex on (`codex app-server`, EO-372) and takes
 * the environment the home is named in; this probe used `codex exec`
 * until EO stopped running it. `login status` and `login --with-api-key`
 * are still the CLI's own subcommands, because they are not turns.
 */

const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";

/** The pinned binary if the caller names one, otherwise whatever is on PATH. */
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";

const REAL_AUTH = join(homedir(), ".codex", "auth.json");

let scratch: string | null = null;

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

interface CodexRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI under a named home and capture both streams whether it
 * succeeded or not.
 *
 * **`stdio` is explicit, and that is load-bearing.** `execFileSync`
 * inherits the child's stderr unless told otherwise, which leaves
 * `error.stderr` null — and two of the four facts here *are* failures,
 * read off stderr. Codex also answers `login status` on stderr rather
 * than stdout, so both streams are returned and the caller searches
 * whichever it means. This was found by running it, which is the whole
 * argument for the file existing.
 *
 * `input` is how `login --with-api-key` is handed its key; for `login
 * status` it is empty, which closes stdin.
 */
function runCodex(home: string, args: string[], timeout: number, input = ""): CodexRun {
  const result = spawnSync(CODEX, args, {
    env: { ...process.env, CODEX_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    input,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** What one turn under a named home came to. */
interface CodexTurn {
  ok: boolean;
  threadId: string | null;
  /** Everything the agent said, joined — the answer without depending on how many messages it took. */
  said: string;
  /** Why it failed, in the backend's words, when it did. */
  error: Error | null;
}

/**
 * One turn over the app-server under a named home: a new thread, or a
 * resume of `resumeId`.
 *
 * The environment is the whole of `process.env` with `CODEX_HOME` set,
 * as `runCodex` builds it for the CLI's own subcommands. Read-only and
 * in a real repository, as the `exec` version ran.
 */
async function codexTurn(home: string, cwd: string, prompt: string, resumeId?: string): Promise<CodexTurn> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env["CODEX_HOME"] = home;
  const client = new CodexClient({ executablePath: CODEX, env });
  const options = { workingDirectory: cwd, sandboxMode: "read-only" as const, approvalPolicy: "never" as const };
  const thread = resumeId === undefined ? client.startThread(options) : client.resumeThread(resumeId, options);
  const events: ThreadEvent[] = [];
  let error: Error | null = null;
  try {
    for await (const event of (await thread.runStreamed(prompt)).events) events.push(event);
  } catch (thrown) {
    error = thrown instanceof Error ? thrown : new Error(String(thrown));
  }
  const failure = events.find((event): event is Extract<ThreadEvent, { type: "turn.failed" }> => event.type === "turn.failed");
  if (!error && failure) error = new Error(failure.error.message);
  const started = events.find((event): event is Extract<ThreadEvent, { type: "thread.started" }> => event.type === "thread.started");
  const said = events.flatMap((event) => (event.type === "item.completed" && event.item.type === "agent_message" ? [event.item.text] : [])).join("\n");
  return { ok: error === null && events.some((event) => event.type === "turn.completed"), threadId: started?.thread_id ?? null, said, error };
}

function makeHome(name: string, links: Record<string, string>): string {
  const home = join(scratch as string, name);
  mkdirSync(home, { recursive: true });
  for (const [entry, target] of Object.entries(links)) symlinkSync(target, join(home, entry));
  return home;
}

describe.skipIf(!OPTED_IN)("what a redirected CODEX_HOME does to auth and to resume", () => {
  it(
    "is signed out bare, signed in by a symlinked credential, and resumes only where the rollouts are",
    async () => {
      expect(existsSync(REAL_AUTH), `no credential at ${REAL_AUTH} — run \`codex login\` first`).toBe(true);

      scratch = mkdtempSync(join(tmpdir(), "eo110-codex-home-"));
      const repo = join(scratch, "repo");
      mkdirSync(repo);
      // Codex wants a repository; a real one costs nothing and keeps the
      // question about the home rather than about a flag.
      execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
      writeFileSync(join(repo, "README.md"), "# codex home probe\n");

      // (1) A bare redirected home has no credential. Asked the cheap
      // way — `login status` rather than a turn — because a turn spends
      // eleven seconds on 401 retries to tell us the same thing.
      const bare = makeHome("bare", {});
      const status = runCodex(bare, ["login", "status"], 60_000);
      expect(status.ok, "a bare redirected home reported a credential it cannot have").toBe(false);
      expect(`${status.stdout}${status.stderr}`.toLowerCase()).toContain("not logged in");

      // (2) A symlinked credential signs it back in, and the thread this
      // starts is what the resume facts are measured against.
      const owner = makeHome("owner", { "auth.json": REAL_AUTH });
      const started = await codexTurn(owner, repo, "Reply with the single word ok, and nothing else.");
      expect(started.ok, `a symlinked credential did not authenticate: ${started.error?.message}`).toBe(true);
      const threadId = started.threadId;
      expect(threadId, "Codex started no thread").not.toBeNull();
      expect(started.said.toLowerCase()).toContain("ok");

      // (3) Another home cannot see that thread — and fails with the
      // string EO already recognises, which is what makes this a
      // degradation (a fresh thread and a comment) rather than a crash.
      const stranger = makeHome("stranger", { "auth.json": REAL_AUTH });
      const lost = await codexTurn(stranger, repo, "Reply with the single word two.", threadId as string);
      expect(lost.ok, "a thread resumed under a home that never held its rollout").toBe(false);
      expect(lost.error?.message).toContain("no rollout found for thread id");
      expect(isMissingCodexSession(lost.error), "EO would not recognise this failure as a lost session").toBe(true);

      // (4) Give a third home the rollouts by symlink and the same
      // thread resumes — with its contents, not merely its id. The
      // recalled word is the answer from the run under `owner`, so a
      // fresh thread wearing the same id could not produce it.
      const heir = makeHome("heir", { "auth.json": REAL_AUTH, sessions: join(owner, "sessions") });
      const resumed = await codexTurn(heir, repo, "What single word did you reply with a moment ago? Answer with that word alone.", threadId as string);
      expect(resumed.ok, `a symlinked sessions directory did not carry the resume: ${resumed.error?.message}`).toBe(true);
      expect(resumed.threadId).toBe(threadId);
      expect(resumed.said.toLowerCase(), "the thread resumed without its conversation").toContain("ok");
    },
    600_000,
  );

  it("writes a credential through a symlink rather than replacing it", () => {
    // The refresh hazard, tested without going near the real credential:
    // a ChatGPT token rotates, and if Codex replaced the link on write,
    // the refreshed credential would be stranded in a per-agent home
    // while the person's own copy went stale. `login --with-api-key`
    // goes through the same writer.
    scratch ??= mkdtempSync(join(tmpdir(), "eo110-codex-home-"));
    const target = join(scratch, "dummy-auth.json");
    writeFileSync(target, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-eo110-before", tokens: null, last_refresh: null }));
    const home = makeHome("writer", { "auth.json": target });

    const wrote = runCodex(home, ["login", "--with-api-key"], 60_000, "sk-eo110-after\n");
    expect(wrote.ok, `the credential write did not run: ${wrote.stderr}`).toBe(true);
    // 0.165.0's words for a stored key (EO-599); up to 0.163.0 it said
    // "Successfully logged in". Neither checks the key when storing it.
    expect(`${wrote.stdout}${wrote.stderr}`).toContain("API key saved");

    expect(lstatSync(join(home, "auth.json")).isSymbolicLink(), "the write replaced the symlink with a regular file").toBe(true);
    expect(readFileSync(target, "utf8"), "the write did not reach the link's target").toContain("sk-eo110-after");
  });
});

/**
 * The home EO itself builds for a locked-down agent (EO-378), rather than
 * one made by hand: signed in through it, and a credential write through
 * the hard link the Windows path uses. Free — `login status` and
 * `login --with-api-key` are not turns.
 */
describe.skipIf(!OPTED_IN)("the Codex home EO builds for an agent", () => {
  it("is signed in through the person's own credential", () => {
    expect(existsSync(REAL_AUTH), `no credential at ${REAL_AUTH} — run \`codex login\` first`).toBe(true);
    scratch ??= mkdtempSync(join(tmpdir(), "eo110-codex-home-"));
    const prepared = prepareCodexHome({ root: join(scratch, "codex-homes"), agentId: "eo378-live", personHome: join(homedir(), ".codex"), platform: "linux" });
    if (!prepared.ok) throw new Error(prepared.problem);
    try {
      const status = runCodex(prepared.path, ["login", "status"], 60_000);
      expect(`${status.stdout}${status.stderr}`.toLowerCase()).toContain("logged in using");
    } finally {
      removeCodexHome(prepared.path);
    }
    expect(existsSync(REAL_AUTH), "removing the home took the person's credential with it").toBe(true);
  });

  it("writes a credential through the hard link it makes on Windows", () => {
    // Under the home directory rather than the temp one, which may be a
    // different filesystem — and a hard link cannot cross one.
    const root = mkdtempSync(join(homedir(), ".eo378-hardlink-"));
    try {
      const person = join(root, "person");
      mkdirSync(person);
      writeFileSync(join(person, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-eo378-before", tokens: null, last_refresh: null }));
      const windowsFs: CodexHomeFs = {
        existsSync: nodeFs.existsSync,
        linkSync: nodeFs.linkSync,
        lstatSync: (path) => nodeFs.lstatSync(path),
        mkdirSync: nodeFs.mkdirSync,
        readdirSync: (path) => nodeFs.readdirSync(path),
        readlinkSync: (path) => nodeFs.readlinkSync(path),
        rmSync: nodeFs.rmSync,
        statSync: (path) => nodeFs.statSync(path, { bigint: true }),
        symlinkSync: (target, path, type) => {
          if (type !== "junction") throw new Error("EPERM: no symbolic links without Developer Mode");
          nodeFs.symlinkSync(target, path, "dir");
        },
        unlinkSync: nodeFs.unlinkSync,
      };
      const prepared = prepareCodexHome({ root: join(root, "homes"), agentId: "eo378-live", personHome: person, platform: "win32", fs: windowsFs });
      if (!prepared.ok) throw new Error(prepared.problem);

      const wrote = runCodex(prepared.path, ["login", "--with-api-key"], 60_000, "sk-eo378-after\n");
      expect(wrote.ok, `the credential write did not run: ${wrote.stderr}`).toBe(true);

      expect(statSync(join(prepared.path, "auth.json")).ino, "the write replaced the hard link with a new file").toBe(statSync(join(person, "auth.json")).ino);
      expect(readFileSync(join(person, "auth.json"), "utf8"), "the write did not reach the person's file").toContain("sk-eo378-after");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
