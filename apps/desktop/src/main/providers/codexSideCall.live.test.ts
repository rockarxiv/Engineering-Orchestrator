import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexSideCallClientOptions, createCodexProvider } from "./codex.js";
import { CodexClient } from "./codexClient.js";
import { personCodexHome } from "./codexHome.js";

/**
 * What a Codex side call actually offers the model (EO-477), read off the
 * request the real app-server sends — `codexSideCallLockdown.ts` is the
 * account of how each surface was switched off, and this is the test to
 * run again when the CLI is bumped.
 *
 * No credit is spent: Codex's model provider is pointed at a server on
 * 127.0.0.1 that keeps the request body and refuses it, so the turn fails
 * after the request has been written. The catalogue entry is copied from
 * the person's own `models_cache.json`, which any earlier Codex run on
 * this machine leaves.
 *
 * Opt in with `EO_LIVE_CODEX=1`, and `EO_CODEX_BIN` naming the binary.
 */
const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";

let server: Server | null = null;
const cleanup: string[] = [];

afterEach(() => {
  server?.close();
  server = null;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A model provider that keeps every request body and answers each with a refusal. */
async function captureServer(): Promise<{ port: number; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    request.on("end", () => {
      if (raw) bodies.push(JSON.parse(raw) as unknown);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "capture only", type: "invalid_request_error" } }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : 0, bodies };
}

/** Every tool name offered, namespaces flattened, and the nested tools a code-mode `exec` would carry. */
function toolsOf(body: unknown): string[] {
  const names: string[] = [];
  const walk = (tools: unknown, prefix: string) => {
    for (const tool of (tools as { type?: string; name?: string; tools?: unknown; description?: string }[] | undefined) ?? []) {
      if (tool.type === "namespace") walk(tool.tools, `${prefix}${tool.name}.`);
      else {
        names.push(`${prefix}${tool.name ?? tool.type}`);
        for (const nested of (tool.description ?? "").matchAll(/^### `([^`]+)`/gm)) names.push(`${prefix}${tool.name}>${nested[1]}`);
      }
    }
  };
  const request = body as { tools?: unknown; input?: { type?: string; tools?: unknown }[] };
  walk(request.tools, "");
  for (const item of request.input ?? []) if (item.type === "additional_tools") walk(item.tools, "");
  return names;
}

describe.skipIf(!OPTED_IN)("a Codex side call, against the real app-server (live, no credit)", () => {
  it("is offered no tool that reaches the disk, the shell or another agent, and no skills catalogue", async () => {
    const capture = await captureServer();
    const home = mkdtempSync(join(homedir(), ".eo-side-call-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "eo-side-call-"));
    cleanup.push(home, cwd);
    mkdirSync(join(home, "sessions"), { recursive: true });
    const options = {
      executablePath: CODEX,
      codexHome: () => home,
      sideCallModelCaches: () => [join(personCodexHome(), "models_cache.json")],
      createSideCallCodex: (catalogPath: string) => {
        const built = codexSideCallClientOptions({ executablePath: CODEX, codexHome: () => home }, catalogPath);
        return new CodexClient({
          ...built,
          config: {
            ...built.config,
            model_provider: "capture",
            model_providers: { capture: { name: "capture", base_url: `http://127.0.0.1:${capture.port}/v1`, wire_api: "responses", request_max_retries: 0, stream_max_retries: 0 } },
          },
        });
      },
    };
    const provider = createCodexProvider(options);

    for await (const event of provider.sideCall!({
      model: "gpt-6-luna",
      system: "Answer with the entries that matter.",
      input: "Which of these matter?",
      outputSchema: { type: "object", properties: { picked: { type: "array", items: { type: "string" } } }, required: ["picked"] },
      cwd,
      signal: AbortSignal.timeout(60_000),
    })) {
      void event;
    }

    expect(capture.bodies.length).toBeGreaterThan(0);
    const offered = toolsOf(capture.bodies[0]);
    // Exactly this, measured at 0.163.0 and again at 0.165.0 (EO-599) and 0.166.0 (EO-644).
    // `request_user_input` says of
    // itself that it is only available in plan mode, which a side call
    // never is, and EO's client refuses every request the app-server
    // makes of it (`refuseServerRequest`), so a call to it is answered
    // with an error and reaches nothing. Anything else appearing here —
    // after a bump — is a surface `codexSideCallLockdown.ts` has to turn off.
    expect(offered).toEqual(["functions.request_user_input"]);
    const prompt = JSON.stringify(capture.bodies[0]);
    expect(prompt).not.toContain("### Available skills");
    expect(prompt).not.toContain(".agents/skills");
    // And the system prompt is the question's own.
    expect(prompt).toContain("Answer with the entries that matter.");
  }, 90_000);
});

/**
 * The person's own Codex configuration cannot reach a side call (EO-477).
 *
 * The reviewer's probe, kept: a `CODEX_HOME` in this process's
 * environment whose `config.toml` declares an MCP server that writes a
 * marker when it is started. A side call must not start it — whether it
 * is handed no home of its own (what an agent's home answers for a
 * keyring sign-in) or one of its own while that `CODEX_HOME` is inherited.
 * The control runs the same call *in* that home, to show the marker is
 * written when the server does start.
 */
describe.skipIf(!OPTED_IN)("the person's Codex configuration and a side call (live, no credit)", () => {
  const priorHome = process.env["CODEX_HOME"];

  afterEach(() => {
    if (priorHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = priorHome;
  });

  /** A person's home with an MCP server of their own in it, and the file that server writes when started. */
  function personsHome(): { home: string; marker: string } {
    const home = mkdtempSync(join(homedir(), ".eo-side-call-person-"));
    cleanup.push(home);
    const marker = join(home, "their-server-started");
    const server = join(home, "their-server.mjs");
    writeFileSync(server, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "yes"); process.stdin.resume();`);
    writeFileSync(join(home, "config.toml"), `[mcp_servers.theirs]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(server)}]\nstartup_timeout_sec = 5\n`);
    mkdirSync(join(home, "sessions"), { recursive: true });
    copyFileSync(join(personCodexHome(), "models_cache.json"), join(home, "models_cache.json"));
    return { home, marker };
  }

  async function sideCallIn(codexHome: () => string | null): Promise<{ launched: boolean; errors: string[] }> {
    const capture = await captureServer();
    const cwd = mkdtempSync(join(tmpdir(), "eo-side-call-"));
    cleanup.push(cwd);
    let launched = false;
    const provider = createCodexProvider({
      executablePath: CODEX,
      codexHome,
      sideCallModelCaches: () => [join(personCodexHome(), "models_cache.json")],
      createSideCallCodex: (catalogPath: string) => {
        launched = true;
        const built = codexSideCallClientOptions({ executablePath: CODEX, codexHome }, catalogPath);
        return new CodexClient({
          ...built,
          config: {
            ...built.config,
            model_provider: "capture",
            model_providers: { capture: { name: "capture", base_url: `http://127.0.0.1:${capture.port}/v1`, wire_api: "responses", request_max_retries: 0, stream_max_retries: 0 } },
          },
        });
      },
    });
    const errors: string[] = [];
    for await (const event of provider.sideCall!({
      model: "gpt-6-luna",
      system: "Answer the question.",
      input: "Return an empty list.",
      outputSchema: { type: "object", properties: { picked: { type: "array", items: { type: "string" } } }, required: ["picked"] },
      cwd,
      signal: AbortSignal.timeout(60_000),
    })) {
      if (event.type === "error") errors.push(event.message);
    }
    // Long enough for a server Codex had started to have written its file.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return { launched, errors };
  }

  it("control: run in that home, the person's server does start", async () => {
    const person = personsHome();
    process.env["CODEX_HOME"] = person.home;
    await sideCallIn(() => person.home);
    expect(existsSync(person.marker)).toBe(true);
  }, 90_000);

  it("handed no home of its own — the keyring answer — launches nothing, and the person's server never starts", async () => {
    const person = personsHome();
    process.env["CODEX_HOME"] = person.home;

    const outcome = await sideCallIn(() => null);

    expect(outcome.launched).toBe(false);
    expect(outcome.errors).toEqual([expect.stringContaining("Codex home of its own")]);
    expect(existsSync(person.marker)).toBe(false);
  }, 90_000);

  it("in a home of its own, with the person's CODEX_HOME inherited, the person's server never starts", async () => {
    const person = personsHome();
    process.env["CODEX_HOME"] = person.home;
    const own = mkdtempSync(join(homedir(), ".eo-side-call-home-"));
    cleanup.push(own);
    mkdirSync(join(own, "sessions"), { recursive: true });

    const outcome = await sideCallIn(() => own);

    expect(outcome.launched).toBe(true);
    expect(existsSync(person.marker)).toBe(false);
  }, 90_000);
});
