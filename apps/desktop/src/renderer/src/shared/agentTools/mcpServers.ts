import type { IpcRequest, McpAuthKind, McpServerView, McpTransport } from "@eo/core";

/**
 * The MCP server form's draft, and how it becomes a save and a summary
 * line, for both layouts' catalogues (EO-519). The classic one draws it
 * in `agentTools/McpServers.tsx`, the chat one in
 * `chat/views/agentTools/ServersPanel.tsx`.
 */

/**
 * The draft this form holds: every field a string, including the three
 * that are lists.
 *
 * A list typed as text, one entry per line, rather than a row of inputs
 * with add and remove buttons. An argument may contain a space, so
 * splitting on whitespace loses `--flag "two words"`, and a line does
 * not — one rule, learned once, for arguments, variable names and
 * headers alike.
 */
export interface ServerDraft {
  id?: string;
  name: string;
  /** What it does, in the person's own words (EO-314). */
  description: string;
  transport: McpTransport;
  command: string;
  /** One argument per line. */
  args: string;
  url: string;
  /** One `Name: value` per line. */
  headers: string;
  /**
   * How a remote server authenticates (EO-117). Meaningless on a stdio
   * one, where the control is not offered and the save does not mention
   * it — the stored union has no authentication on a stdio server.
   */
  authKind: McpAuthKind;
  /** The name of the variable holding the bearer token. Never its value. */
  bearerTokenEnvName: string;
  /** One variable name per line. */
  envNames: string;
}

export const BLANK: ServerDraft = {
  name: "",
  description: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  headers: "",
  // `header` for the reason the draft schema gives: it is what every
  // server saved before this field existed is, so the form and the
  // contract agree about what "not mentioned" means.
  authKind: "header",
  bearerTokenEnvName: "",
  envNames: "",
};

export function draftOf(server: McpServerView): ServerDraft {
  const shared = { id: server.id, name: server.name, description: server.description, envNames: server.envNames.join("\n") };
  if (server.config.transport === "stdio") {
    return { ...BLANK, ...shared, transport: "stdio", command: server.config.command, args: server.config.args.join("\n") };
  }
  const auth = server.config.auth;
  return {
    ...BLANK,
    ...shared,
    transport: server.config.transport,
    url: server.config.url,
    headers: Object.entries(server.config.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
    authKind: auth.kind,
    // The name comes back; there is no channel that hands back the
    // value, so there is nothing here to leak — see `ServerSecrets`.
    bearerTokenEnvName: auth.kind === "bearer" ? auth.tokenEnvName : "",
  };
}

/** Non-empty lines, trimmed. An empty box is an empty list, not a list with one empty entry in it. */
function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Something read off the form, or the sentence saying why it could not
 * be.
 *
 * A refusal rather than a throw, for the reason the conventions give:
 * throwing is for programmer error, and a header line somebody typed is
 * not one. It lands in the same place on screen as the problems the main
 * process sends.
 */
type Read<T> = { ok: true; value: T } | { ok: false; problem: string };

/**
 * `Name: value` per line, or a sentence saying which line is not that.
 *
 * Read here rather than sent as typed so the person hears about a line
 * with no colon in it as a line with no colon in it. The main process
 * checks header *names*, so an unsplit line would arrive as a name full
 * of spaces and come back described as one — technically a refusal, and
 * no help at all.
 */
function readHeaders(text: string): Read<Record<string, string>> {
  const headers: Record<string, string> = {};
  const raw = text.split("\n");
  for (const [index, entry] of raw.entries()) {
    const line = entry.trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) return { ok: false, problem: `Write a header as "Name: value" — line ${String(index + 1)} has no colon in it.` };
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { ok: true, value: headers };
}

export function toSave(draft: ServerDraft): Read<IpcRequest<"mcpServers:save">> {
  const remote = draft.transport !== "stdio";
  const headers = remote ? readHeaders(draft.headers) : ({ ok: true, value: {} } as const);
  if (!headers.ok) return headers;
  return {
    ok: true,
    value: {
      ...(draft.id === undefined ? {} : { id: draft.id }),
      name: draft.name.trim(),
      // Always sent from this form, unlike `enabled`: the form holds the
      // whole description, so an empty box is somebody clearing it
      // rather than a caller with nothing to say.
      description: draft.description.trim(),
      transport: draft.transport,
      command: remote ? null : draft.command,
      args: remote ? [] : lines(draft.args),
      url: remote ? draft.url : null,
      headers: headers.value,
      // Sent only for a remote server. Authentication is a remote idea —
      // a stdio server is handed its declared values in its environment
      // whatever kind it claims (EO-377) — so a stdio save says nothing
      // about it rather than sending an answer that would mean nothing.
      ...(remote ? { authKind: draft.authKind, bearerTokenEnvName: draft.authKind === "bearer" ? draft.bearerTokenEnvName.trim() : null } : {}),
      envNames: lines(draft.envNames),
      // `enabled` is deliberately absent. It travels on its own channel,
      // so a save that fixes a typo in a command cannot turn a server
      // somebody switched off back on — the schema's own note says why.
    },
  };
}

export function summarize(server: McpServerView): string {
  if (server.config.transport !== "stdio") return server.config.url;
  // A row with no command is one an imported pack *declared*: a document
  // carries what a server does and never a command to spawn (EO-314), so
  // the half only a person can supply is missing and the row says so
  // rather than rendering as a blank line.
  const command = [server.config.command, ...server.config.args].join(" ").trim();
  return command === "" ? "No command yet — Edit to say how this server runs." : command;
}

/**
 * How a remote server says it authenticates, on the row (EO-117).
 *
 * The bearer case names the variable, because the name is the whole
 * answer to "which token is this using" and it is the thing a person set
 * this kind in order to say. The *value* is not here and cannot be: no
 * channel hands one back. Whether it has been set at all is the "Set" /
 * "Not set" beside the same name in `ServerSecrets` below.
 *
 * Null for a stdio server, which has no authentication to describe.
 */
export function authLabel(server: McpServerView): string | null {
  if (server.config.transport === "stdio") return null;
  const auth = server.config.auth;
  if (auth.kind === "bearer") return `bearer ${auth.tokenEnvName === "" ? "— no variable named" : `\${${auth.tokenEnvName}}`}`;
  return auth.kind === "none" ? "no auth" : "header auth";
}
