import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AGENT_WRITE_TOOLS, AgentWriteRequestSchema, SKILL_WRITE_TOOLS, skillToolNotServed, type AgentWriteAnswer, type AgentWriteBridgeAddress, type AgentWriteRequest, type AgentWriteTool } from "@eo/core";

/**
 * Where the `eo` server hands every write an agent asks for (EO-543,
 * ARCHITECTURE.md §13.1). Generalised from the memory-note bridge EO-482
 * opened for notes to a record-held project.
 *
 * The `eo` server is a child process with a read-only database and no
 * other way back into EO — which is right for everything it reads, and
 * was wrong for the three tools that write: `comment`, `attachment_add`
 * and `memory_note`. They used to answer from what the server could see
 * and leave the write to the supervisor, which inferred it from the
 * agent's event stream; on Claude, whose results arrive as the tool's
 * `structuredContent`, that inference matched nothing, and every one of
 * those writes was told "done" and never made. So now the server asks
 * here, the main process applies the rules and writes, and the tool
 * answers with the write's own result.
 *
 * **One credential per item, minted from a secret this process holds and
 * never writes down.** The supervisor puts it in the turn's options, which
 * both adapters hand the `eo` server as one environment variable, so
 * there is no second delivery to keep in step (invariant 12). What it
 * opens is a write by the turn this process is driving on that item, held
 * to that turn's rules. A credential from a process that has since
 * stopped opens nothing, because the secret went with it.
 *
 * Loopback only, on a port the system chooses.
 */

/**
 * The main process's half: apply the rules for this tool and write, for
 * the turn it is driving on this item. `writes` is the list the
 * credential was minted for (EO-717) — the request's tool is already one
 * of them — or null for a credential that carries none, whose turn the
 * agent's grant decides.
 */
export type AgentWriteHandler = (itemId: string, request: AgentWriteRequest, writes?: readonly AgentWriteTool[] | null) => Promise<AgentWriteAnswer>;

export interface AgentWriteBridge {
  /**
   * Where a turn on this item hands a write, and the bearer it presents.
   * With `writes`, a credential for those writes alone (EO-717): the list
   * is part of what is signed, so a turn cannot widen it, and the address
   * carries it for the `eo` server to list only those tools.
   */
  tokenFor: (itemId: string, writes?: readonly AgentWriteTool[]) => AgentWriteBridgeAddress;
  close: () => Promise<void>;
}

/**
 * The most a request may carry. A note is a thousand characters and a
 * comment is rarely more than a few; this is generous for both, and far
 * short of what would let a caller hold this process's memory.
 */
const MAX_BODY_BYTES = 1024 * 1024;
const PATH = "/agent-write";
/** Between a credential's item and the writes it was minted for. In neither a UUID nor a tool name. */
const WRITES_SEPARATOR = "~";

/** Binds the bridge's socket and answers it once bound. Rejects where it cannot be bound. */
export function startAgentWriteBridge(handler: AgentWriteHandler): Promise<AgentWriteBridge> {
  const secret = randomBytes(32);
  const mac = (subject: string): string => createHmac("sha256", secret).update(subject).digest("hex");

  /**
   * What a bearer is for, or null where it is not one this process
   * minted: the item, and the writes it was minted for where it names
   * some (`<item>~<tool>,<tool>`), all of it under the MAC.
   */
  function grantOf(header: string | undefined): { itemId: string; writes: AgentWriteTool[] | null } | null {
    if (header === undefined || !header.startsWith("Bearer ")) return null;
    const bearer = header.slice("Bearer ".length).trim();
    const dot = bearer.lastIndexOf(".");
    if (dot <= 0) return null;
    const subject = bearer.slice(0, dot);
    const given = Buffer.from(bearer.slice(dot + 1), "utf8");
    const expected = Buffer.from(mac(subject), "utf8");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const tilde = subject.indexOf(WRITES_SEPARATOR);
    if (tilde === -1) return { itemId: subject, writes: null };
    const writes = subject
      .slice(tilde + 1)
      .split(",")
      .filter((tool): tool is AgentWriteTool => (AGENT_WRITE_TOOLS as readonly string[]).includes(tool));
    return { itemId: subject.slice(0, tilde), writes };
  }

  function answer(response: ServerResponse, status: number, body: AgentWriteAnswer): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  }

  const refused = (code: string, problem: string): AgentWriteAnswer => ({ ok: false, code, problem });

  async function onRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== PATH) return answer(response, 404, refused("NOT_FOUND", "EO has nothing here."));
    const grant = grantOf(request.headers.authorization);
    if (grant === null) return answer(response, 401, refused("UNRECOGNISED_CREDENTIAL", "EO did not recognise this run's credential, so nothing was written."));
    let raw = "";
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) return answer(response, 413, refused("TOO_LARGE", "That request is far larger than anything an agent writes, so nothing was written."));
      raw += (chunk as Buffer).toString("utf8");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return answer(response, 400, refused("UNREADABLE", "EO could not read that request, so nothing was written."));
    }
    const write = AgentWriteRequestSchema.safeParse(parsed);
    if (!write.success) return answer(response, 400, refused("UNREADABLE", "EO does not write anything for that tool, so nothing was written."));
    // A credential minted for some writes opens those alone (EO-717),
    // whatever the server it was handed to lists.
    if (grant.writes !== null && !grant.writes.includes(write.data.tool)) {
      // A skill tool's refusal says why (EO-732): only a learning review may write skills.
      const problem = (SKILL_WRITE_TOOLS as readonly string[]).includes(write.data.tool) ? skillToolNotServed(write.data.tool) : `This turn is not served ${write.data.tool}, so nothing was written.`;
      return answer(response, 403, refused("TOOL_NOT_SERVED", problem));
    }
    let outcome: AgentWriteAnswer;
    try {
      outcome = await handler(grant.itemId, write.data, grant.writes);
    } catch (error) {
      outcome = refused("WRITE_FAILED", `EO could not write it: ${error instanceof Error ? error.message : String(error)}`);
    }
    answer(response, 200, outcome);
  }

  return new Promise((resolve, reject) => {
    const server: Server = createServer((request, response) => {
      onRequest(request, response).catch(() => {
        if (!response.headersSent) answer(response, 500, refused("WRITE_FAILED", "EO could not write it."));
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const bound = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${String(bound.port)}${PATH}`;
      // Never what keeps a process alive.
      server.unref();
      resolve({
        tokenFor: (itemId, writes) => {
          if (writes === undefined) return { url, token: `${itemId}.${mac(itemId)}` };
          const subject = `${itemId}${WRITES_SEPARATOR}${writes.join(",")}`;
          return { url, token: `${subject}.${mac(subject)}`, writes: [...writes] };
        },
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // A bridge closing while an agent's process still holds a
            // keep-alive socket open must not wait for that process.
            server.closeAllConnections();
          }),
      });
    });
  });
}

/**
 * Hands one write to the bridge, as the `eo` server does (`handToEo` in
 * `eoServer.mjs`, which cannot import this). For an in-process backend —
 * the fake provider — that has no `eo` server of its own to do it, so the
 * request it makes is the request a real turn makes.
 */
export async function sendAgentWrite(address: AgentWriteBridgeAddress, request: AgentWriteRequest, signal?: AbortSignal): Promise<AgentWriteAnswer> {
  let response: Response;
  try {
    response = await fetch(address.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${address.token}` },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    return { ok: false, code: "EO_UNREACHABLE", problem: `EO did not answer, so nothing can be said to have been written (${error instanceof Error ? error.message : String(error)}).` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (typeof body === "object" && body !== null) {
    const answer = body as Record<string, unknown>;
    if (answer["ok"] === true && typeof answer["text"] === "string") {
      const data = answer["data"];
      return { ok: true, text: answer["text"], data: typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {} };
    }
    if (answer["ok"] === false && typeof answer["problem"] === "string") {
      return { ok: false, code: typeof answer["code"] === "string" ? answer["code"] : "WRITE_REFUSED", problem: answer["problem"] };
    }
  }
  return { ok: false, code: "EO_UNREACHABLE", problem: `EO answered in a way that does not say anything was written (HTTP ${String(response.status)}).` };
}

/** A tool's answer as the Model Context Protocol carries it: what `eoServer.mjs` returns for a write. */
export interface AgentWriteToolResult {
  isError?: true;
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
}

/**
 * The tool result the `eo` server makes of the main process's answer —
 * `writeThroughEo` and `withStructuredText` in `eoServer.mjs`, restated
 * because that file ships alone, and pinned to it by `writeBridge.test.ts`.
 * The structured part carries the text, because Claude shows an agent
 * nothing else.
 */
export function agentWriteToolResult(answer: AgentWriteAnswer): AgentWriteToolResult {
  if (answer.ok) return { content: [{ type: "text", text: answer.text }], structuredContent: { ...answer.data, text: answer.text } };
  const text = `${answer.code}: ${answer.problem}`;
  return { isError: true, content: [{ type: "text", text }], structuredContent: { error: { code: answer.code, message: answer.problem }, text } };
}
