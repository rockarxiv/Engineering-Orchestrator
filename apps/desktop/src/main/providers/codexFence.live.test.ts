import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, CallRefusedEvent } from "@eo/core";
import { codexClientOptions, createCodexProvider } from "./codex.js";
import { CodexClient } from "./codexClient.js";
import { personCodexHome } from "./codexHome.js";

/**
 * EO's fence on a real Codex turn (EO-926): the hook trusted the way EO's
 * work turns trust it, and a refusal taking effect.
 *
 * `codexHooks.live.test.ts` established that an inline hook fires, but it
 * runs on `bypass_hook_trust`, which waives review for every hook the CLI
 * loaded. EO's agents never use it: `probeHookTrust` asks the CLI for the
 * key and hash it files EO's hook under, and the turn is launched with
 * `hooks.state.<key>.trusted_hash` naming that hook alone. Until this story
 * that route had unit tests only; once implementer and reviewer turns
 * depend on the hook, it needs to be seen working. So everything here is
 * the real thing — the pinned app-server, the real `probeHookTrust`, the
 * shipped `codexSearchHookCommand.mjs`, and the adapter's own listener and
 * `fencedCall` — except the model, a server on 127.0.0.1 that scripts the
 * calls (`threadFork.live.test.ts`'s technique). **No credit is spent and
 * no key is needed.**
 *
 * The scripted model, in a checkout whose branch `eo/EO-926` tracks a
 * bare remote it has diverged from:
 *
 * 1. pushes with `git push --force` and writes a file outside the
 *    worktree with `apply_patch` — both must be refused, the remote and
 *    the disk untouched, and the agent told why;
 * 2. pushes with `git push --force-with-lease` to its own branch — the
 *    control: the same route lets this one through, and the remote moves.
 *
 * Opted in, because it needs the managed runtime on disk:
 *
 *     EO_LIVE_CODEX=1 \
 *       EO_CODEX_BIN=$HOME/.config/EO/runtimes/codex@<pin>-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex \
 *       pnpm exec vitest run --root apps/desktop src/main/providers/codexFence.live.test.ts
 */
const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";
const HOOK_COMMAND = join(dirname(fileURLToPath(import.meta.url)), "codexSearchHookCommand.mjs");
const BRANCH = "eo/EO-926";

const cleanup: string[] = [];
let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
}

/** A worktree on `eo/EO-926`, pushed to a bare remote and then amended, so the remote holds a commit it does not. */
function divergedCheckout(): { work: string; remote: string; pushed: string; local: string; outside: string } {
  const scratch = mkdtempSync(join(tmpdir(), "eo-926-fence-"));
  cleanup.push(scratch);
  const remote = join(scratch, "remote.git");
  const work = join(scratch, "work");
  mkdirSync(work);
  git(scratch, "init", "--bare", "-b", "main", remote);
  git(work, "init", "-b", BRANCH);
  git(work, "config", "user.email", "eo@example.com");
  git(work, "config", "user.name", "EO Fence");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "remote", "add", "origin", remote);
  writeFileSync(join(work, "README.md"), "# fence\n");
  git(work, "add", "-A");
  git(work, "commit", "-m", "first");
  git(work, "push", "-u", "origin", BRANCH);
  const pushed = git(work, "rev-parse", "HEAD");
  git(work, "commit", "--amend", "-m", "first, reworded");
  return { work, remote, pushed, local: git(work, "rev-parse", "HEAD"), outside: join(scratch, "outside.txt") };
}

type InputItem = { type?: string; call_id?: string; output?: unknown; role?: string };

/**
 * The model: answers each request by what its input holds so far. The
 * first asks for the refused calls, the next for the leased push, the last
 * ends the turn; `remoteAt` records the remote branch when each request arrives.
 */
async function scriptedModel(checkout: { work: string; remote: string; outside: string }): Promise<{ port: number; bodies: string[]; remoteAt: string[] }> {
  const bodies: string[] = [];
  const remoteAt: string[] = [];
  const usage = { input_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 14 };
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url?.includes("/responses") !== true) {
        response.writeHead(404).end();
        return;
      }
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push(body);
      remoteAt.push(git(checkout.remote, "rev-parse", BRANCH));
      const input = ((JSON.parse(body) as { input?: InputItem[] }).input ?? []).filter((item) => typeof item === "object" && item !== null);
      const answered = (id: string) => input.some((item) => (item.type === "function_call_output" || item.type === "custom_tool_call_output") && item.call_id === id);
      const items = !answered("call_force")
        ? [
            { type: "function_call", id: "fc_force", call_id: "call_force", name: "exec_command", arguments: JSON.stringify({ cmd: `git push --force origin ${BRANCH}` }) },
            { type: "custom_tool_call", id: "ct_outside", call_id: "call_outside", name: "apply_patch", input: `*** Begin Patch\n*** Add File: ${checkout.outside}\n+written past the fence\n*** End Patch\n` },
          ]
        : !answered("call_lease")
          ? [{ type: "function_call", id: "fc_lease", call_id: "call_lease", name: "exec_command", arguments: JSON.stringify({ cmd: `git push --force-with-lease origin ${BRANCH}` }) }]
          : [{ type: "message", role: "assistant", id: "msg_done", content: [{ type: "output_text", text: "done", annotations: [] }] }];
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const id = `resp_${String(bodies.length)}`;
      response.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id } })}\n\n`);
      items.forEach((item, index) => response.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item })}\n\n`));
      response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id, usage } })}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : 0, bodies, remoteAt };
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** What the request after a call carried back as that call's output, as text. */
function outputOf(bodies: readonly string[], callId: string): string {
  for (const body of bodies) {
    const found = ((JSON.parse(body) as { input?: InputItem[] }).input ?? []).find((item) => (item.type === "function_call_output" || item.type === "custom_tool_call_output") && item.call_id === callId);
    if (found) return typeof found.output === "string" ? found.output : JSON.stringify(found.output);
  }
  return "";
}

describe.skipIf(!OPTED_IN)("EO's fence on a real Codex turn, its hook trusted by hash (live, no credit)", () => {
  it("refuses a forced push and a write outside the worktree, and lets a leased push to the item's branch through", { timeout: 240_000 }, async () => {
    const checkout = divergedCheckout();
    const model = await scriptedModel(checkout);
    // A home of its own, so nothing this writes is left among the person's.
    const home = mkdtempSync(join(homedir(), ".eo-926-fence-home-"));
    cleanup.push(home);
    mkdirSync(join(home, "sessions"), { recursive: true });
    const cache = join(personCodexHome(), "models_cache.json");
    if (existsSync(cache)) copyFileSync(cache, join(home, "models_cache.json"));

    // No `searchHookTrust`: the adapter asks the real CLI (`probeHookTrust`).
    const options = { executablePath: CODEX, codexHome: () => home, searchHookCommandPath: HOOK_COMMAND };
    const launchedConfigs: Record<string, unknown>[] = [];
    const provider = createCodexProvider({
      ...options,
      createCodex: (repository, searchHook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheld, adminDirectory, skillSlugs, itemId) => {
        const built = codexClientOptions(options, repository, searchHook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheld, adminDirectory, skillSlugs, itemId);
        const config = {
          ...built.config,
          model_provider: "capture",
          model_providers: { capture: { name: "capture", base_url: `http://127.0.0.1:${model.port}/v1`, wire_api: "responses", request_max_retries: 0, stream_max_retries: 0 } },
        };
        launchedConfigs.push(config);
        return new CodexClient({ ...built, config });
      },
    });

    const events = await drain(
      provider.start({ instructions: "You are a probe.", context: "Push the branch.", cwd: checkout.work, signal: new AbortController().signal, fence: { root: checkout.work, pushBranch: BRANCH } }),
    );

    // Trusted by hash, for EO's hook alone — never the thread-wide waiver.
    const hooks = launchedConfigs[0]?.["hooks"] as { PreToolUse?: { matcher?: string }[]; state?: Record<string, { trusted_hash?: string }> } | undefined;
    expect(hooks?.PreToolUse?.map((entry) => entry.matcher)).toEqual(["*"]);
    const states = Object.values(hooks?.state ?? {});
    expect(states).toHaveLength(1);
    expect(states[0]?.trusted_hash).toMatch(/^sha256:/);
    expect(JSON.stringify(launchedConfigs)).not.toContain("bypass_hook_trust");

    // The model really asked, three times, and the turn ended on its answer.
    expect(model.bodies.length, "the scripted model was never reached").toBeGreaterThanOrEqual(3);
    expect(events.find((event) => event.type === "result")).toEqual({ type: "result", data: "done" });

    // Refused: the remote still held what was pushed before when the
    // leased push was asked for, nothing was written outside, and the
    // agent was told it was EO's fence.
    expect(model.remoteAt[1]).toBe(checkout.pushed);
    expect(existsSync(checkout.outside)).toBe(false);
    expect(outputOf(model.bodies, "call_force")).toContain("EO's fence");
    expect(outputOf(model.bodies, "call_outside")).toContain("EO's fence");
    const refused = events.filter((event): event is CallRefusedEvent => event.type === "call_refused");
    expect(refused.map(({ tool, rule, call }) => ({ tool, rule, call }))).toEqual(
      expect.arrayContaining([
        { tool: "Bash", rule: "push_forced", call: `git push --force origin ${BRANCH}` },
        { tool: "apply_patch", rule: "write_outside_worktree", call: checkout.outside },
      ]),
    );
    expect(refused).toHaveLength(2);

    // The control: the same hook let the leased push to the item's own
    // branch through, and it moved the remote.
    expect(git(checkout.remote, "rev-parse", BRANCH)).toBe(checkout.local);
  });
});
