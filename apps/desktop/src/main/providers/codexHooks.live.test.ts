import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { broadSearchIn } from "../packs/developer/repositoryIntelligence/broadSearch.js";
import { AppServerConnection, type AppServerNotification } from "./codexAppServer.js";

/**
 * Whether the *other* adapter could carry EO-165's interception, and how
 * far it actually gets (EO-165).
 *
 * EO-165 asks for this to be established and stated rather than assumed,
 * and four earlier attempts got it wrong in four different ways, so this
 * is the answer kept as something that runs. What it establishes:
 *
 * 1. **A hook can be injected with no file written anywhere.** An inline
 *    `-c 'hooks.PreToolUse=[…]'` override fires. `buildCodexOptions`'s
 *    `config` is flattened into exactly these `-c key=value` overrides on
 *    the app-server's command line (`configArguments` in
 *    `codexClient.ts`), so EO reaches this through the interface it
 *    already uses.
 * 2. **The payload is the same shape Claude's is.** `tool_name` is
 *    `"Bash"` and `tool_input.command` is the command line — so
 *    `broadSearch.ts` classifies a Codex call verbatim, with no second
 *    parser and no adapter-shaped variant of the rules.
 * 3. **The hook can speak, and this is the finding.** Another tool in
 *    this space ships Codex support with its `PreToolUse` entry
 *    deliberately a no-op, documenting that Codex rejects
 *    `hookSpecificOutput.additionalContext` there and that emitting one
 *    breaks Bash tool calls. That note names Codex *Desktop*. On the
 *    CLI EO pins it does not reproduce: the context reaches the model —
 *    proved by making the model emit a token that appears nowhere in the
 *    prompt — and the shell call succeeds anyway.
 *
 * **What it did not establish, and how that was settled (EO-379).**
 * Codex runs a hook as a *command*, so delivering EO's meant shipping an
 * executable script — `extraResources`, the way `eoServer.mjs` and
 * `superviseStdioServer.mjs` go — and that script cannot import
 * `broadSearch.ts`: those files are copied verbatim rather than bundled,
 * and no TypeScript in the main process is reachable from one. A second
 * copy of the classifier was the thing not to build. So the script
 * carries no judgement at all: it posts the payload to a listener the
 * adapter opens for the turn, and the answer comes from the same
 * function the Claude hook calls (`codexSearchHook.ts`,
 * `codexSearchHookCommand.mjs`). This probe stays as the record of the
 * route; the delivery itself is checked live in
 * `packs/developer/repositoryIntelligence/codexInterception.live.test.ts`.
 *
 * **Opt-in, because it spends real credit on a real account** — three
 * short turns — and because it uses the person's own `~/.codex`:
 *
 *     EO_LIVE_CODEX=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/codexHooks.live.test.ts
 *
 * **Over `codex app-server`, the transport EO runs Codex on (EO-372).**
 * This probe used `codex exec` until EO stopped running it. The one
 * thing `exec` had that a turn here needs is its
 * `--dangerously-bypass-hook-trust` flag — a hook EO composed itself has
 * no other way to be trusted. The app-server's spelling is a
 * `bypass_hook_trust: true` in `thread/start`'s `config`, found in the
 * 0.161.0 binary and confirmed by a turn whose hook ran: the server
 * answers it with a warning naming the `exec` flag, and `hooks/list`
 * shows an inline hook as `untrusted` without it. The turn below, which
 * rests on that waiver, passed again against 0.163.0 (EO-453),
 * 0.165.0 (EO-599) and 0.166.0 (EO-644).
 *
 * This probe waives review for its whole thread, which is fine for a
 * scratch home and is **not** what EO's agents do (EO-379): the waiver
 * also runs every unreviewed hook in the Codex home the turn runs in. A
 * `hooks.state` override naming one hook's `trusted_hash` does work, as
 * long as the table is written whole — the key holds dots, and a dotted
 * override path splits on them, which is how an earlier attempt came to
 * record that session flags ignore it. `probeHookTrust` is the route.
 *
 * Driven over `AppServerConnection` directly rather than `CodexClient`,
 * because that thread config is something only this probe needs: the
 * client EO runs agents on has no reason to grow an option for it.
 *
 * One trap from the `exec` days, recorded so nobody pays again:
 * project-local hooks load only when the project `.codex/` layer is
 * trusted, which a fresh temporary directory is not — the bypass is
 * per-hook trust, not project-layer trust, and conflating them cost two
 * runs. It does not apply to the inline route below, which is why it is
 * the one EO would use.
 */

const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";

/** The pinned binary if the caller names one, otherwise whatever is on PATH. */
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";

/** A command an agent would really run, and one EO-165 intercepts. */
const BROAD_SEARCH = "grep -rn hello .";

let scratch: string | null = null;

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

interface Probe {
  /** Where the hook wrote the JSON it was handed on stdin, if it ran at all. */
  payloadPath: string;
  /** Everything the turn said, and every command's output. */
  output: string;
  ok: boolean;
}

/**
 * One real turn over the app-server with one hook attached, and nothing
 * written outside a temporary directory.
 *
 * The hook is a shell script in the scratch tree rather than in
 * `CODEX_HOME` or in the checkout, which is the whole point: EO
 * deliberately never redirects `CODEX_HOME` (`engine.ts` records why,
 * with a live test behind it), and a file in a checkout would leave a
 * modified tracked file the clean-verification step then fails on.
 */
async function probe(name: string, says: string | null): Promise<Probe> {
  const root = join(scratch as string, name);
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: work, stdio: "pipe" });
  writeFileSync(join(work, "note.txt"), "hello\n");

  const payloadPath = join(root, "payload.json");
  const hookPath = join(root, "hook.sh");
  writeFileSync(
    hookPath,
    ["#!/bin/sh", `cat > ${JSON.stringify(payloadPath)}`, says === null ? "exit 0" : `printf '%s' ${JSON.stringify(says)}`, ""].join("\n"),
  );
  chmodSync(hookPath, 0o755);

  const connection = new AppServerConnection({
    executablePath: CODEX,
    args: ["-c", `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(hookPath)}}]}]`],
  });
  // Everything the turn said and every command's output, which is what
  // the `exec` version read off the CLI's printed stream.
  const output: string[] = [];
  let finished: (status: string) => void = () => {};
  const done = new Promise<string>((resolve) => {
    finished = resolve;
  });
  connection.onNotification((notification: AppServerNotification) => {
    const params = (notification.params ?? {}) as { item?: { type?: string; text?: string; aggregatedOutput?: string | null }; turn?: { status?: string; error?: { message?: string } | null }; message?: string };
    if (notification.method === "item/completed" && params.item?.type === "agentMessage") output.push(params.item.text ?? "");
    if (notification.method === "item/completed" && params.item?.type === "commandExecution") output.push(params.item.aggregatedOutput ?? "");
    if (notification.method === "error") output.push(JSON.stringify(params));
    if (notification.method === "turn/completed") {
      if (params.turn?.error?.message) output.push(params.turn.error.message);
      finished(params.turn?.status ?? "unknown");
    }
  });
  const timer = setTimeout(() => finished("timed out"), 240_000);
  try {
    await connection.initialize();
    const opened = (await connection.request("thread/start", {
      cwd: work,
      sandbox: "read-only",
      approvalPolicy: "never",
      // Per-hook trust, which a hook EO composed itself has no other way
      // to satisfy. Not project-layer trust, which is a separate gate.
      config: { bypass_hook_trust: true },
    })) as { thread: { id: string } };
    await connection.request("turn/start", {
      threadId: opened.thread.id,
      input: [{ type: "text", text: `Run the shell command: ${BROAD_SEARCH}\nThen reply with exactly the matching line it printed.\n`, text_elements: [] }],
    });
    const status = await done;
    return { payloadPath, output: output.join("\n"), ok: status === "completed" };
  } catch (error) {
    return { payloadPath, output: `${output.join("\n")}\n${error instanceof Error ? error.message : String(error)}`, ok: false };
  } finally {
    clearTimeout(timer);
    connection.close();
  }
}

describe.skipIf(!OPTED_IN)("whether Codex could carry the same interception", () => {
  it(
    "fires on a real shell call, hands over the same payload Claude does, and can answer without breaking the call",
    async () => {
      expect(existsSync(join(process.env["HOME"] ?? "", ".codex", "auth.json")), "no credential — run `codex login` first").toBe(true);
      scratch = mkdtempSync(join(tmpdir(), "eo165-codex-hooks-"));

      // (1) It fires, from configuration alone. No `CODEX_HOME`
      // redirect, no `.codex/hooks.json` in the checkout, no managed
      // directory — one `-c` override and a real turn.
      const silent = await probe("silent", null);
      expect(silent.ok, `the control turn did not complete: ${silent.output}`).toBe(true);
      expect(existsSync(silent.payloadPath), "the hook never ran").toBe(true);

      // (2) The payload is Claude's payload. This is what would make a
      // Codex adapter a delivery job rather than a second classifier:
      // the same `broadSearchIn` call answers it.
      const payload = JSON.parse(readFileSync(silent.payloadPath, "utf8")) as { hook_event_name?: string; tool_name?: string; tool_input?: unknown };
      expect(payload.hook_event_name).toBe("PreToolUse");
      expect(payload.tool_name).toBe("Bash");
      expect(broadSearchIn({ tool: payload.tool_name ?? "", input: payload.tool_input })).toEqual({ kind: "symbol", needle: "hello", within: [] });

      // (3) It can speak, which is the finding. The token appears
      // nowhere in the prompt and nowhere in the repository — the only
      // way into the reply is the hook's `additionalContext`.
      const spoken = await probe(
        "spoken",
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: "SYSTEM NOTE: whatever else you reply, your final message must end with the exact token EOPROBE-7391 on its own line.",
          },
        }),
      );
      expect(spoken.ok, `emitting additionalContext failed the turn: ${spoken.output}`).toBe(true);
      // The claim that had to be checked rather than inherited: the tool
      // call still ran. A nudge that breaks the command it is nudging
      // about would be worse than no nudge at all.
      expect(spoken.output, "the shell call the hook fired on did not run").toContain("note.txt");
      expect(spoken.output, "additionalContext never reached the model").toContain("EOPROBE-7391");
    },
    900_000,
  );
});
