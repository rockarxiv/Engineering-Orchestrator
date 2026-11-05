/**
 * The Jira REST surface EO uses, and nothing more (J-01).
 *
 * Two flavours sit behind this: Cloud speaks REST v3 with Atlassian
 * Document Format descriptions and Basic auth; Data Center speaks v2
 * with wiki markup and a Bearer token. That is a real difference in
 * request shape, not a version string, so it is two implementations of
 * one interface rather than a pile of conditionals.
 *
 * `fetch` is a parameter. Every other external client in this codebase
 * takes its entry point the same way — `fetchClaudeModels(runQuery)`,
 * `createCodexProvider({ createCodex })` — so no test has to reach the
 * network or mock a module.
 */

export type JiraFlavour = "cloud" | "datacenter";

export interface JiraConnection {
  baseUrl: string;
  flavour: JiraFlavour;
  /** Cloud only: Basic auth is `email:token`. Data Center sends the token as a Bearer. */
  email: string | null;
  token: string;
}

export interface JiraIssueRef {
  id: string;
  key: string;
}

export interface JiraIssue extends JiraIssueRef {
  summary: string;
  description: string;
  issueType: string;
  status: string;
  parentKey: string | null;
  /**
   * When Jira last changed it, ISO-8601. Empty when Jira did not say.
   *
   * The only cheap way to ask "is there anything to pull" — a sync uses
   * it in JQL to fetch the handful of issues that moved rather than
   * every issue it mirrors.
   */
  updated: string;
}

/** One comment on an issue, as much of it as EO has any use for. */
export interface JiraComment {
  id: string;
  /** Plain text: ADF on Cloud is flattened at this boundary, like a description. */
  body: string;
  /** Display name, because EO has no notion of a Jira account. */
  author: string;
  created: string;
}

/** Issue-level attachment metadata shared by Cloud and Data Center. */
export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Jira supplies an authenticated content URL; callers never persist it. */
  contentUrl: string;
  created: string;
}

export interface UploadAttachmentInput {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}

export interface JiraTransition {
  id: string;
  name: string;
  /** The status this transition leads to — what an EO state is actually mapped to. */
  toStatus: string;
  /**
   * What the transition's screen asks for (J-05).
   *
   * Empty for the ordinary case. A transition with "Resolution is
   * required when moving to Done" reports it here, and a POST without
   * it is rejected however many times you try.
   */
  fields: JiraField[];
}

export interface JiraField {
  id: string;
  name: string;
  required: boolean;
  /** `option`, `array`, `string`… — enough for the UI to know whether to offer a list. */
  schemaType: string;
  allowedValues: { id: string; value: string }[];
}

export interface CreateIssueInput {
  projectKey: string;
  issueType: string;
  summary: string;
  description: string;
  /** The feature's issue key, when creating one of its stories. */
  parentKey?: string | null;
  /** Per-repository extras from `createmeta` (J-01), sent as-is. */
  fields?: Record<string, unknown>;
}

/** Jira answered, and said no. `.message` is Jira's own text, which is more useful than a status code. */
export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

export interface JiraClient {
  /** Who the credentials belong to. The cheapest call that proves auth works. */
  myself(): Promise<{ accountId: string; displayName: string }>;
  /** Does this project key exist, and can we see it? */
  repository(key: string): Promise<{ id: string; key: string; name: string }>;
  search(jql: string, limit?: number): Promise<JiraIssue[]>;
  getIssue(key: string): Promise<JiraIssue>;
  /** Children of an epic or parent issue, so J-02 can offer to import them. */
  children(key: string): Promise<JiraIssue[]>;
  /**
   * Every comment on an issue, oldest first, following pagination.
   *
   * The read half of `addComment`, and the reason an inbound sync is
   * possible at all — until this the client could only write comments.
   */
  comments(key: string): Promise<JiraComment[]>;
  /** Every attachment on an issue. Jira does not paginate this field. */
  listAttachments(key: string): Promise<JiraAttachment[]>;
  /** Authenticated content download, rejecting metadata lies and oversized streams. */
  downloadAttachment(attachment: JiraAttachment, maxBytes: number): Promise<Uint8Array>;
  /** Multipart upload with Jira's CSRF opt-out header. */
  uploadAttachment(key: string, input: UploadAttachmentInput): Promise<JiraAttachment>;
  deleteAttachment(attachmentId: string): Promise<void>;
  createIssue(input: CreateIssueInput): Promise<JiraIssueRef>;
  transitions(key: string): Promise<JiraTransition[]>;
  /** `fields` only when the transition asks for them (J-05); Jira rejects an empty block on some screens. */
  transition(key: string, transitionId: string, fields?: Record<string, unknown>): Promise<void>;
  /**
   * Posts a comment and returns the id Jira gave it.
   *
   * The id used to be discarded (`Promise<void>`, `call<void>`), which
   * left nothing anywhere to say that a local comment had been sent or
   * what it became — the outbox row that knew is deleted on success.
   * Recording it is what lets a later pull recognise EO's own words and
   * not import them back.
   */
  addComment(key: string, body: string): Promise<{ id: string }>;
  /**
   * Removes a comment from an issue.
   *
   * Jira lets you delete your own comments with Add Comments; deleting
   * somebody else's needs Delete All Comments, which a token that can do
   * everything else here may well not have. So a caller must expect this
   * one to fail on exactly the comments EO did not write.
   */
  deleteComment(key: string, commentId: string): Promise<void>;
  /**
   * Removes the issue (KAN-30). `deleteSubtasks` because Jira refuses
   * outright rather than orphaning them, and EO has already taken the
   * item's stories with it locally.
   *
   * Needs the Delete Issues permission, which a token that can do
   * everything else here may well not have — so a caller must expect
   * this one to fail where the others succeed.
   */
  deleteIssue(key: string, options?: { deleteSubtasks?: boolean }): Promise<void>;
  /** What Jira requires to create this issue type here (J-01). */
  createMeta(projectKey: string, issueType: string): Promise<JiraField[]>;
  /** Every status this repository's workflow has, so a state can be mapped to one by name (J-04). */
  statuses(projectKey: string): Promise<string[]>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Basic for Cloud (email + API token), Bearer for Data Center (PAT). */
export function authHeader(connection: JiraConnection): string {
  if (connection.flavour === "cloud") {
    const email = connection.email ?? "";
    return `Basic ${Buffer.from(`${email}:${connection.token}`).toString("base64")}`;
  }
  return `Bearer ${connection.token}`;
}

/** Trailing slashes in a configured URL are the user's, and `${base}//rest/...` is a 404 nobody can explain. */
export function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * Jira reports failures in several shapes: `errorMessages` for the whole
 * request, `errors` keyed by field for a create, and occasionally plain
 * text from a proxy that never reached Jira at all. All three end up as
 * one sentence a person can act on.
 */
export async function describeFailure(response: Response, url: string): Promise<JiraError> {
  const text = await response.text().catch(() => "");
  let detail = text.slice(0, 400);

  try {
    const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
    const messages = [...(body.errorMessages ?? []), ...Object.entries(body.errors ?? {}).map(([field, message]) => `${field}: ${message}`)];
    if (messages.length > 0) detail = messages.join("; ");
  } catch {
    // Not JSON — a proxy, a login page, or an outage. The raw text is
    // still the most useful thing we have.
  }

  const prefix =
    response.status === 401
      ? "Jira rejected the credentials"
      : response.status === 403
        ? "Jira accepted the credentials but refused the request"
        : response.status === 404
          ? "Jira has no such thing"
          : `Jira returned ${response.status}`;

  return new JiraError(detail ? `${prefix}: ${detail}` : prefix, response.status, url);
}

/** One request, with the auth and error handling every call shares. */
export async function request<T>(
  connection: JiraConnection,
  fetchImpl: FetchLike,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await requestResponse(connection, fetchImpl, path, init);

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    // A success that is not JSON is something standing in front of Jira
    // answering in its place — an SSO login page, a proxy, a base URL
    // pointing at a web root. `describeFailure` already expects exactly
    // that shape, but only on the error path, and these arrive as 200.
    // Parsed bare, they surfaced as `Unexpected token '<'`, which names
    // neither Jira nor the address that produced it.
    throw new JiraError(
      `Jira returned a ${response.status} that was not JSON. The address may point at something in front of Jira, such as a login page or a proxy: ${text.slice(0, 200)}`,
      response.status,
      response.url || normaliseBaseUrl(connection.baseUrl),
    );
  }
}

/** Authenticated request before choosing JSON or binary response handling. */
export async function requestResponse(
  connection: JiraConnection,
  fetchImpl: FetchLike,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = /^https?:\/\//i.test(path) ? path : `${normaliseBaseUrl(connection.baseUrl)}${path}`;

  let response: Response;
  try {
    const multipart = typeof FormData !== "undefined" && init.body instanceof FormData;
    response = await fetchImpl(url, {
      ...init,
      headers: {
        Authorization: authHeader(connection),
        Accept: "application/json",
        ...(init.body && !multipart ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    // DNS, TLS, refused, offline. Never reached Jira, so there is no
    // status to report — say what was attempted instead.
    throw new JiraError(`Could not reach ${normaliseBaseUrl(connection.baseUrl)}: ${error instanceof Error ? error.message : String(error)}`, 0, url);
  }

  if (!response.ok) throw await describeFailure(response, url);
  return response;
}

/** Reads a response without ever allowing more than maxBytes into memory. */
export async function readLimitedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Jira attachment exceeds the 20 MB attachment limit.");

  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maxBytes) throw new Error("Jira attachment exceeds the 20 MB attachment limit.");
    return data;
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Jira attachment exceeds the 20 MB attachment limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
