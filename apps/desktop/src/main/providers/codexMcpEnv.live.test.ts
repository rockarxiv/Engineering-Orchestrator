import { execFileSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@eo/core";
import { afterAll, describe, expect, it } from "vitest";
import { buildCodexOptions, createCodexProvider } from "./codex.js";

/**
 * What an attached MCP server actually receives from a Codex dispatch
 * (EO-377, which reversed EO-108).
 *
 * The unit tests beside this file assert what EO *hands the CLI*: the
 * server's entry names its declared variables under `env_vars`, and the
 * values sit in the environment the app-server is spawned with. This
 * asserts what the spawned server ends up holding, which is a different
 * question and the one that decides whether the channel is real: Codex
 * passes a stdio child only its own fixed environment plus the names
 * that server's `env_vars` lists, copied from the CLI's environment. So
 * the value arriving here is observed, not argued.
 *
 * EO-108 shipped this file as the opposite guarantee — the value stopping
 * at the CLI — and said it was the statement of the decision to edit if
 * the decision was revisited. EO-377 revisited it.
 *
 * **Opt-in, because it spends real API credit on a real account.** One
 * trivial turn, cents rather than dollars, and it needs `codex login`.
 * Skipped otherwise, so `pnpm test` and CI never reach it:
 *
 *     EO_LIVE_CODEX=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/codexMcpEnv.live.test.ts
 *
 * Driven through `createCodexProvider` rather than the client beneath
 * it, because the lazy read of a secret at spawn is part of what is
 * being exercised. Since EO-372 the CLI is `codex app-server`, launched
 * by EO's own client with the config flattened into `-c` overrides.
 */

const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";

/** The pinned binary if the caller names one, otherwise whatever is on PATH. */
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";
const SECRET = `eo377-${process.pid}-supersecret`;

const workspaces: string[] = [];

afterAll(() => {
  for (const directory of workspaces) rmSync(directory, { recursive: true, force: true });
});

/** A throwaway repository to run the turn in — Codex refuses to run outside one unless told to skip the check. */
function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "eo-codex-mcp-env-"));
  workspaces.push(directory);
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "pipe" });
  writeFileSync(join(directory, "README.md"), "# env check\n");
  return directory;
}

/** One trivial turn, run to its end. */
async function runOneTurn(provider: ReturnType<typeof createCodexProvider>, cwd: string): Promise<void> {
  for await (const _event of provider.start({
    instructions: "You are a test fixture.",
    context: "Reply with the single word ok.",
    cwd,
    signal: new AbortController().signal,
  })) {
    void _event;
  }
}

/**
 * The "MCP server": it never speaks MCP. It records the environment it
 * was given and the command line of the process that spawned it, then
 * lingers long enough to be counted as starting.
 *
 * Codex reports a server that fails to handshake and carries on with
 * the turn, which is all this needs — the evidence is on disk before
 * that matters.
 */
function recorderServer(directory: string, envPath: string, cmdlinePath: string): string {
  const script = join(directory, "record-env.mjs");
  writeFileSync(
    script,
    `import { writeFileSync, readFileSync } from "node:fs";
writeFileSync(${JSON.stringify(envPath)}, JSON.stringify(process.env));
try {
  writeFileSync(${JSON.stringify(cmdlinePath)}, readFileSync("/proc/" + process.ppid + "/cmdline", "utf8"));
} catch {
  writeFileSync(${JSON.stringify(cmdlinePath)}, "");
}
setTimeout(() => {}, 4000);
`,
  );
  return script;
}

function attachedServer(command: string, script: string): McpServer {
  return {
    id: "srv-envcheck",
    name: "envcheck",
    description: "",
    config: { transport: "stdio", command, args: [script] },
    envNames: ["EO_CHECK_TOKEN"],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    connector: null,
  };
}

describe.skipIf(!OPTED_IN)("what an attached server receives from a Codex dispatch", () => {
  it(
    "is launched with its command, and with the value EO holds for it",
    async () => {
      const workspace = repository();

      const envPath = join(workspace, "child-env.json");
      const cmdlinePath = join(workspace, "child-cmdline.txt");
      const server = attachedServer(process.execPath, recorderServer(workspace, envPath, cmdlinePath));
      const options = {
        executablePath: CODEX,
        attachedServers: [server],
        serverSecret: (_serverId: string, name: string) => (name === "EO_CHECK_TOKEN" ? SECRET : null),
      };

      await runOneTurn(createCodexProvider(options), workspace);

      // Delivered: the attachment reached Codex and Codex ran it. Without
      // this the rest would pass for the wrong reason — a server that was
      // never launched holds no secret either.
      expect(existsSync(envPath), "Codex never launched the attached server").toBe(true);
      const childEnv = JSON.parse(readFileSync(envPath, "utf8")) as Record<string, string>;
      expect(childEnv["PATH"], "the server was launched with no environment at all").toBeTruthy();

      // The decision, observed at the only place it is real.
      expect(childEnv["EO_CHECK_TOKEN"]).toBe(SECRET);

      // And the exposure the pinned decision is about: the value got there
      // through the environment, and is not readable from the CLI's
      // command line by anything else running as this person.
      const spawnedWith = readFileSync(cmdlinePath, "utf8").split("\0").join(" ");
      if (spawnedWith !== "") expect(spawnedWith).not.toContain(SECRET);
      expect(JSON.stringify(buildCodexOptions(options)["config"])).not.toContain(SECRET);
    },
    180_000,
  );

  /**
   * A remote server's `${VAR}` header, received (EO-377).
   *
   * The unit tests stop at what the app-server is launched with: an
   * `env_http_headers` entry naming a variable EO made, and that variable
   * holding the expanded header. This is the far end of it — a local HTTP
   * server, attached as a catalogue row, records the headers Codex sends
   * it. It answers 401, which Codex reports and carries on past; the
   * headers are recorded on the first request.
   *
   * Two of the cases review found are run here rather than argued: a
   * header named `X.Probe` (valid, and broken while `-c` split it on its
   * dot), and a stdio server attached alongside that declares
   * `EO_MCP_HEADER_1` — the name EO's first generated variable would have
   * taken, so its own value would have been replaced by the header.
   */
  it(
    "sends a remote server its `${VAR}` headers expanded, and leaves a stdio server beside it its own values",
    async () => {
      const received: IncomingHttpHeaders[] = [];
      const http = createServer((request, response) => {
        received.push(request.headers);
        response.statusCode = 401;
        response.end();
      });
      await new Promise<void>((listening) => http.listen(0, "127.0.0.1", () => listening()));
      try {
        const workspace = repository();
        const envPath = join(workspace, "child-env.json");
        const cmdlinePath = join(workspace, "child-cmdline.txt");
        const stdio = { ...attachedServer(process.execPath, recorderServer(workspace, envPath, cmdlinePath)), envNames: ["EO_CHECK_TOKEN", "EO_MCP_HEADER_1"] };
        const remote: McpServer = {
          id: "srv-headercheck",
          name: "headercheck",
          description: "",
          config: {
            transport: "http",
            url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
            headers: { Authorization: "Bearer ${EO_PROBE_TOKEN}", "X.Probe": "${EO_PROBE_TOKEN:-unset}-dotted", "X-Plain": "typed" },
            auth: { kind: "header" },
          },
          envNames: ["EO_PROBE_TOKEN"],
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
          archivedAt: null,
          connector: null,
        };
        const values: Record<string, string> = { EO_CHECK_TOKEN: SECRET, EO_MCP_HEADER_1: `${SECRET}-collision`, EO_PROBE_TOKEN: `${SECRET}-header` };
        const options = { executablePath: CODEX, attachedServers: [stdio, remote], serverSecret: (_serverId: string, name: string) => values[name] ?? null };

        await runOneTurn(createCodexProvider(options), workspace);

        // Received, expanded, at the server — Node lower-cases header names.
        expect(received.length, "Codex never connected to the remote server").toBeGreaterThan(0);
        expect(received[0]?.["authorization"]).toBe(`Bearer ${SECRET}-header`);
        expect(received[0]?.["x.probe"]).toBe(`${SECRET}-header-dotted`);
        expect(received[0]?.["x-plain"]).toBe("typed");

        // And the stdio server beside it still holds what was declared for it.
        expect(existsSync(envPath), "Codex never launched the attached stdio server").toBe(true);
        const childEnv = JSON.parse(readFileSync(envPath, "utf8")) as Record<string, string>;
        expect(childEnv["EO_CHECK_TOKEN"]).toBe(SECRET);
        expect(childEnv["EO_MCP_HEADER_1"]).toBe(`${SECRET}-collision`);

        // Not one of the values reached the CLI's command line.
        const spawnedWith = readFileSync(cmdlinePath, "utf8").split("\0").join(" ");
        if (spawnedWith !== "") expect(spawnedWith).not.toContain(SECRET);
      } finally {
        http.close();
      }
    },
    180_000,
  );
});
