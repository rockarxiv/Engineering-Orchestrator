import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepositoryMcpServer } from "@eo/core";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_EVERY_TOOL_MATCHER, CODEX_SEARCH_TOOL_MATCHER, SEARCH_HOOK_REFUSES_ENV, SEARCH_HOOK_TOKEN_ENV, SEARCH_HOOK_URL_ENV, hookCommandLine, openCodexSearchHook, probeHookTrust, type CodexSearchHook } from "./codexSearchHook.js";
import { fakeAppServer } from "../testing/fakeCodexAppServer.js";
import type { SearchNudge, SearchNudgeRequest } from "./searchNudge.js";

/**
 * The delivery, with a judgement that is not the pack's (EO-379).
 *
 * What the adapter does with *any* nudge and with none. Which commands
 * the shipped classifier fires on, and the sentence it says, is the
 * pack's to assert — `repositoryIntelligence/codexInterception.test.ts`
 * drives the real one through this — and nothing here may import it
 * (`liftedFromPack.test.ts`).
 */
const HOOK_COMMAND = join(dirname(fileURLToPath(import.meta.url)), "codexSearchHookCommand.mjs");

const server = {
  name: "repo",
  command: "/opt/eo/index-tool",
  args: [],
  env: {},
  answers: { symbol: "idx_symbol", area: "idx_area", reach: ["idx_callers"], files: "idx_files" },
  knows: async () => [],
} as unknown as RepositoryMcpServer;

/** A nudge that speaks about one command and no other, and remembers what it was asked. */
function scripted(): { nudge: SearchNudge; asked: SearchNudgeRequest[] } {
  const asked: SearchNudgeRequest[] = [];
  const nudge: SearchNudge = async (request) => {
    asked.push(request);
    const command = (request.input as { command?: string } | null)?.command;
    if (command === "explode") throw new Error("the judgement threw");
    return command === "broad" ? { kind: "symbol", needle: "x", nudge: `try ${request.qualify(request.answers.symbol)}` } : null;
  };
  return { nudge, asked };
}

const payload = (command: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_use_id: "call_1",
  ...extra,
});

let open: CodexSearchHook | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

async function opened(nudge: SearchNudge): Promise<CodexSearchHook> {
  open = await openCodexSearchHook({ nudge, server, cwd: "/tmp/wt", commandPath: HOOK_COMMAND });
  expect(open).not.toBeNull();
  return open as CodexSearchHook;
}

function post(hook: CodexSearchHook, body: string, headers: Record<string, string> = { authorization: `Bearer ${hook.env[SEARCH_HOOK_TOKEN_ENV]}` }, method = "POST") {
  return fetch(hook.env[SEARCH_HOOK_URL_ENV] as string, { method, headers, ...(method === "POST" ? { body } : {}) });
}

/** The shipped command, run as Codex runs it: the command line through a shell, payload on stdin. */
function runCommand(command: string, env: Record<string, string>, stdin: string): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, { shell: true, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ stdout, code }));
    child.stdin.end(stdin);
  });
}

describe("whether a Codex turn gets a hook", () => {
  it("gets none without a judgement, a command, an index, a vocabulary or a way to ask", async () => {
    const { nudge } = scripted();
    const all = { nudge, server, cwd: "/tmp/wt", commandPath: HOOK_COMMAND };

    expect(await openCodexSearchHook({ ...all, nudge: undefined })).toBeNull();
    expect(await openCodexSearchHook({ ...all, commandPath: undefined })).toBeNull();
    expect(await openCodexSearchHook({ ...all, server: undefined })).toBeNull();
    expect(await openCodexSearchHook({ ...all, server: { ...server, answers: undefined } as never })).toBeNull();
    expect(await openCodexSearchHook({ ...all, server: { ...server, knows: undefined } as never })).toBeNull();
  });

  it("is offered the shell and nothing else, because the shell is the only door this backend searches through", () => {
    expect(CODEX_SEARCH_TOOL_MATCHER).toBe("Bash");
  });
});

describe("the listener behind the hook", () => {
  it("asks the nudge it was given, in this backend's spelling of a tool id, and records what it said against the call", async () => {
    const { nudge, asked } = scripted();
    const hook = await opened(nudge);

    const response = await post(hook, JSON.stringify(payload("broad")));

    expect(response.status).toBe(200);
    // `additionalContext` and nothing that could decide the call.
    expect(await response.json()).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "try repo/idx_symbol" } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tool: "Bash", input: { command: "broad" }, root: "/tmp/wt", answers: server.answers });
    expect(asked[0]?.knows).toBe(server.knows);
    expect(hook.drain()).toEqual([{ type: "search_interception", tool: "Bash", callId: "call_1", kind: "symbol", needle: "x", suggestion: "try repo/idx_symbol" }]);
    // Drained means gone: a firing is recorded once.
    expect(hook.drain()).toEqual([]);
  });

  it("says nothing and records nothing when the nudge has nothing to say", async () => {
    const { nudge } = scripted();
    const hook = await opened(nudge);

    const response = await post(hook, JSON.stringify(payload("pnpm test")));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(hook.drain()).toEqual([]);
  });

  it("records a call with no id as one the backend did not name, never as an invented id", async () => {
    const { nudge } = scripted();
    const hook = await opened(nudge);

    for (const id of [undefined, "", 7]) await post(hook, JSON.stringify(payload("broad", { tool_use_id: id })));

    expect(hook.drain().map((event) => event.callId)).toEqual([null, null, null]);
  });

  it("stays quiet about anything that is not a tool call it can read, without asking the nudge", async () => {
    const { nudge, asked } = scripted();
    const hook = await opened(nudge);

    for (const body of ["not json", "[]", "null", JSON.stringify({ hook_event_name: "SessionStart" }), JSON.stringify(payload("broad", { tool_name: 4 }))]) {
      expect((await post(hook, body)).status, body).toBe(204);
    }
    expect(asked).toEqual([]);
    expect(hook.drain()).toEqual([]);
  });

  it("answers a nudge that throws as nothing to say, because a tool call is waiting on it", async () => {
    const { nudge } = scripted();
    const hook = await opened(nudge);

    expect((await post(hook, JSON.stringify(payload("explode")))).status).toBe(204);
    expect(hook.drain()).toEqual([]);
  });

  it("answers nobody who was not given this turn's bearer", async () => {
    const { nudge, asked } = scripted();
    const hook = await opened(nudge);
    const body = JSON.stringify(payload("broad"));

    expect((await post(hook, body, {})).status).toBe(401);
    expect((await post(hook, body, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post(hook, body, { authorization: `Bearer ${"0".repeat(64)}` })).status).toBe(401);
    expect((await post(hook, "", undefined, "GET")).status).toBe(401);
    // Nothing a stranger sends is counted as an interception.
    expect(asked).toEqual([]);
    expect(hook.drain()).toEqual([]);
  });

  it("listens on the loopback interface only, with a bearer of its own per turn", async () => {
    const { nudge } = scripted();
    const first = await opened(nudge);
    const second = await openCodexSearchHook({ nudge, server, cwd: "/tmp/wt", commandPath: HOOK_COMMAND });
    try {
      expect(first.env[SEARCH_HOOK_URL_ENV]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(Object.keys(first.env).sort()).toEqual([SEARCH_HOOK_TOKEN_ENV, SEARCH_HOOK_URL_ENV]);
      expect(second?.env[SEARCH_HOOK_TOKEN_ENV]).not.toBe(first.env[SEARCH_HOOK_TOKEN_ENV]);
      // One turn's bearer is not another's.
      expect((await post(first, JSON.stringify(payload("broad")), { authorization: `Bearer ${second?.env[SEARCH_HOOK_TOKEN_ENV]}` })).status).toBe(401);
    } finally {
      await second?.close();
    }
  });

  it("stops answering once the turn is over", async () => {
    const { nudge } = scripted();
    const hook = await opened(nudge);
    await hook.close();

    await expect(post(hook, JSON.stringify(payload("broad")))).rejects.toThrow();
  });
});

describe("the command Codex runs", () => {
  it("carries the payload to the listener and prints what it said", async () => {
    const { nudge } = scripted();
    const hook = await opened(nudge);

    const run = await runCommand(hook.command, hook.env, JSON.stringify(payload("broad")));

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "try repo/idx_symbol" } });
    expect(hook.drain()).toHaveLength(1);
  });

  it("prints nothing and exits cleanly whenever there is nothing to say, so it can never break the call it fired on", async () => {
    const { nudge } = scripted();
    const hook = await opened(nudge);
    const quiet = { stdout: "", code: 0 };

    // Not a broad search.
    expect(await runCommand(hook.command, hook.env, JSON.stringify(payload("pnpm test")))).toEqual(quiet);
    // The wrong bearer.
    expect(await runCommand(hook.command, { ...hook.env, [SEARCH_HOOK_TOKEN_ENV]: "wrong" }, JSON.stringify(payload("broad")))).toEqual(quiet);
    // Run by something that is not an EO turn at all.
    expect(await runCommand(hook.command, { [SEARCH_HOOK_URL_ENV]: "", [SEARCH_HOOK_TOKEN_ENV]: "" }, JSON.stringify(payload("broad")))).toEqual(quiet);
    // A listener that is gone.
    await hook.close();
    expect(await runCommand(hook.command, hook.env, JSON.stringify(payload("broad")))).toEqual(quiet);
  });

  it("is one quoted command line that turns EO's own executable into a Node for this command only", () => {
    expect(hookCommandLine("/Applications/EO Beta.app/Contents/MacOS/EO", "/Applications/EO Beta.app/Contents/Resources/app-resources/providers/codexSearchHookCommand.mjs", "darwin")).toBe(
      "ELECTRON_RUN_AS_NODE=1 '/Applications/EO Beta.app/Contents/MacOS/EO' '/Applications/EO Beta.app/Contents/Resources/app-resources/providers/codexSearchHookCommand.mjs'",
    );
    expect(hookCommandLine("/home/o'brien/eo", "/x/hook.mjs", "linux")).toBe(`ELECTRON_RUN_AS_NODE=1 '/home/o'\\''brien/eo' '/x/hook.mjs'`);
    expect(hookCommandLine("C:\\Program Files\\EO\\EO.exe", "C:\\Program Files\\EO\\resources\\hook.mjs", "win32")).toBe(
      'set "ELECTRON_RUN_AS_NODE=1" && "C:\\Program Files\\EO\\EO.exe" "C:\\Program Files\\EO\\resources\\hook.mjs"',
    );
  });
});

/**
 * A turn that refuses calls (EO-732): the learning review's fork. The same
 * listener and command carry EO's refusals, decided by the caller's
 * `refuse`, and the command fails closed there.
 */
describe("the hook on a turn that refuses calls", () => {
  const refuse = (tool: string): string | null => (tool === "mcp__eo__memory_note" ? null : `EO refused \`${tool}\` on a learning review.`);

  async function refusing(nudge: SearchNudge | undefined = undefined): Promise<CodexSearchHook> {
    open = await openCodexSearchHook({ nudge, server: undefined, cwd: "/tmp/wt", commandPath: HOOK_COMMAND, refuse });
    expect(open).not.toBeNull();
    return open as CodexSearchHook;
  }

  it("is opened without a judgement or an index, offered every call, and says so to its command", async () => {
    const hook = await refusing();
    expect(hook.matcher).toBe(CODEX_EVERY_TOOL_MATCHER);
    expect(hook.env[SEARCH_HOOK_REFUSES_ENV]).toBe("1");
    // And a turn that refuses nothing is offered the shell alone, as before.
    const { nudge } = scripted();
    const plain = await openCodexSearchHook({ nudge, server, cwd: "/tmp/wt", commandPath: HOOK_COMMAND });
    expect(plain?.matcher).toBe(CODEX_SEARCH_TOOL_MATCHER);
    expect(plain?.env[SEARCH_HOOK_REFUSES_ENV]).toBeUndefined();
    await plain?.close();
  });

  it("denies a call refuse answers for, with its reason, lets one it allows through, and denies a payload it cannot read", async () => {
    const hook = await refusing();
    const denied = await post(hook, JSON.stringify({ ...payload("echo hi > a.txt"), tool_name: "apply_patch" }));
    expect(denied.status).toBe(200);
    expect(await denied.json()).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "EO refused `apply_patch` on a learning review." } });
    expect((await post(hook, JSON.stringify({ ...payload(""), tool_name: "mcp__eo__memory_note" }))).status).toBe(204);
    for (const body of ["not json", JSON.stringify({ hook_event_name: "PreToolUse" })]) {
      const unreadable = await post(hook, body);
      expect(unreadable.status, body).toBe(200);
      expect(((await unreadable.json()) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, body).toBe("deny");
    }
    expect(hook.drain()).toEqual([]);
  });

  it("refuses before the nudge is asked, and nudges a call it allows as before", async () => {
    const { nudge, asked } = scripted();
    open = await openCodexSearchHook({ nudge, server, cwd: "/tmp/wt", commandPath: HOOK_COMMAND, refuse: (tool) => (tool === "Bash" ? null : "refused") });
    const hook = open as CodexSearchHook;
    expect((await post(hook, JSON.stringify({ ...payload("broad"), tool_name: "apply_patch" }))).status).toBe(200);
    expect(asked).toEqual([]);
    expect(await (await post(hook, JSON.stringify(payload("broad")))).json()).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "try repo/idx_symbol" } });
  });

  it("has its command refuse the call whenever it cannot ask, rather than let it through", async () => {
    const hook = await refusing();
    const refusal = (run: { stdout: string; code: number | null }) => ({ code: run.code, decision: (JSON.parse(run.stdout || "{}") as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision ?? null });
    const deny = { code: 0, decision: "deny" };

    // Asked: refused, and allowed.
    expect(refusal(await runCommand(hook.command, hook.env, JSON.stringify({ ...payload("x"), tool_name: "Bash" })))).toEqual(deny);
    expect(await runCommand(hook.command, hook.env, JSON.stringify({ ...payload("x"), tool_name: "mcp__eo__memory_note" }))).toEqual({ stdout: "", code: 0 });
    // Not asked: the wrong bearer, no listener named, a listener gone.
    expect(refusal(await runCommand(hook.command, { ...hook.env, [SEARCH_HOOK_TOKEN_ENV]: "wrong" }, JSON.stringify({ ...payload("x"), tool_name: "mcp__eo__memory_note" })))).toEqual(deny);
    expect(refusal(await runCommand(hook.command, { [SEARCH_HOOK_URL_ENV]: "", [SEARCH_HOOK_TOKEN_ENV]: "", [SEARCH_HOOK_REFUSES_ENV]: "1" }, JSON.stringify(payload("x"))))).toEqual(deny);
    await hook.close();
    open = null;
    expect(refusal(await runCommand(hook.command, hook.env, JSON.stringify({ ...payload("x"), tool_name: "mcp__eo__memory_note" })))).toEqual(deny);
  });
});

describe("asking the CLI how to trust EO's hook", () => {
  const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true", timeout: 15 }] }] };
  const sessionHook = { key: "/<session-flags>/config.toml:pre_tool_use:0:0", source: "sessionFlags", currentHash: "sha256:abc", trustStatus: "untrusted" };
  const listing = (found: unknown[]) => ({ replies: { "hooks/list": { result: { data: [{ cwd: "/x", hooks: found, warnings: [], errors: [] }] } } } });

  it("starts the app-server with the hook configured, in an empty home of its own, lists, and opens no thread", async () => {
    const fake = fakeAppServer(listing([sessionHook]));

    expect(await probeHookTrust({ executablePath: "/opt/eo/codex", hooks, spawn: fake.spawn })).toEqual({ key: sessionHook.key, hash: "sha256:abc" });

    const [launch] = fake.launches;
    expect(launch?.args).toEqual(["app-server", "--stdio", "-c", `hooks.PreToolUse=[{matcher = "Bash", hooks = [{type = "command", command = "true", timeout = 15}]}]`]);
    expect(fake.sent.map((message) => message.method).filter(Boolean)).toEqual(["initialize", "initialized", "hooks/list"]);
    // Not the person's Codex home, and not left behind.
    const home = launch?.options.env?.["CODEX_HOME"] as string;
    expect(home).toContain("eo-codex-hook-probe-");
    expect(home).not.toBe(process.env["CODEX_HOME"]);
    expect(existsSync(home)).toBe(false);
    // Over the inherited environment, so the CLI still has a PATH.
    expect(launch?.options.env?.["PATH"]).toBe(process.env["PATH"]);
  });

  it("answers null for anything that is not exactly one hook from the command line", async () => {
    const personal = { ...sessionHook, key: "/home/p/.codex/config.toml:pre_tool_use:0:0", source: "user" };
    for (const found of [[], [personal], [sessionHook, { ...sessionHook, key: "other" }], [{ ...sessionHook, currentHash: "" }], [{ ...sessionHook, key: 4 }]]) {
      const fake = fakeAppServer(listing(found));
      expect(await probeHookTrust({ executablePath: "/opt/eo/codex", hooks, spawn: fake.spawn }), JSON.stringify(found)).toBeNull();
    }
    // A personal hook beside EO's is not EO's, and is not what gets trusted.
    const fake = fakeAppServer(listing([personal, sessionHook]));
    expect(await probeHookTrust({ executablePath: "/opt/eo/codex", hooks, spawn: fake.spawn })).toEqual({ key: sessionHook.key, hash: "sha256:abc" });
  });

  it("answers null when the CLI refuses the request, dies, or never answers", async () => {
    const refusing = fakeAppServer({ replies: { "hooks/list": { error: { code: -32601, message: "method not found" } } } });
    expect(await probeHookTrust({ executablePath: "/opt/eo/codex", hooks, spawn: refusing.spawn })).toBeNull();

    const dying = fakeAppServer({ after: { initialize: [{ exit: 1, stderr: "boom" }] } });
    expect(await probeHookTrust({ executablePath: "/opt/eo/codex", hooks, spawn: dying.spawn })).toBeNull();

    const silent = fakeAppServer({ after: { initialize: [{ wait: 5_000 }] }, replies: {} });
    const wedged: typeof silent.spawn = (command, args, options) => silent.spawn(command, args, options);
    expect(await probeHookTrust({ executablePath: "/opt/eo/codex", hooks, spawn: wedged, timeoutMs: 1 })).toBeNull();
  });
});
