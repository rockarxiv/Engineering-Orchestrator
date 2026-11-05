import {
  request,
  requestResponse,
  readLimitedBytes,
  type CreateIssueInput,
  type FetchLike,
  type JiraClient,
  type JiraConnection,
  type JiraField,
  type JiraComment,
  type JiraAttachment,
  type JiraIssue,
  type JiraIssueRef,
  type JiraTransition,
} from "./client.js";

/**
 * Jira Cloud: REST v3, and descriptions in Atlassian Document Format
 * (J-01).
 *
 * ADF is the awkward part. v3 refuses a plain string where a document
 * is expected, and returns one where Data Center returns text — so the
 * conversion happens at this boundary and the rest of EO only ever sees
 * markdown-ish plain text.
 */

/** Plain text in, minimal ADF out. Paragraphs split on blank lines; ADF rejects an empty one. */
export function toAdf(text: string): unknown {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== "");

  return {
    type: "doc",
    version: 1,
    content:
      paragraphs.length > 0
        ? paragraphs.map((block) => ({ type: "paragraph", content: [{ type: "text", text: block }] }))
        : [{ type: "paragraph", content: [] }],
  };
}

/**
 * ADF back to text, well enough to read.
 *
 * Deliberately lossy: EO shows a Jira description as the opening comment
 * on an item (J-02), and a faithful ADF renderer is a repository of its
 * own. Anything with text in it contributes its text.
 */
export function fromAdf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  const node = value as { type?: string; text?: string; content?: unknown[] };
  if (typeof node.text === "string") return node.text;

  const children = Array.isArray(node.content) ? node.content.map(fromAdf) : [];
  const joined = children.join("");

  // A paragraph is a line. A list item keeps its bullet, because a real
  // Jira description turned five bullet points into five sentences that
  // read as if they followed one another — the product owner reads this
  // text, and "here are four prerequisites" is part of what it says.
  if (node.type === "paragraph") return `${joined}\n\n`;
  if (node.type === "listItem") return `- ${joined.trim()}\n`;
  if (node.type === "bulletList" || node.type === "orderedList") return `${joined}\n`;
  return joined;
}

interface RawComment {
  id?: string;
  body?: unknown;
  author?: { displayName?: string };
  created?: string;
}

interface RawIssue {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    description?: unknown;
    issuetype?: { name?: string };
    status?: { name?: string };
    parent?: { key?: string };
    updated?: string;
  };
}

interface RawAttachment {
  id?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  content?: string;
  created?: string;
}

function toAttachment(raw: RawAttachment): JiraAttachment {
  return {
    id: raw.id ?? "",
    filename: raw.filename ?? "attachment",
    mimeType: raw.mimeType ?? "application/octet-stream",
    size: raw.size ?? 0,
    contentUrl: raw.content ?? "",
    created: raw.created ?? "",
  };
}

function toIssue(raw: RawIssue): JiraIssue {
  return {
    id: raw.id,
    key: raw.key,
    summary: raw.fields?.summary ?? "",
    description: fromAdf(raw.fields?.description).trim(),
    issueType: raw.fields?.issuetype?.name ?? "",
    status: raw.fields?.status?.name ?? "",
    parentKey: raw.fields?.parent?.key ?? null,
    updated: raw.fields?.updated ?? "",
  };
}

// `updated` is what makes an incremental sync possible: without it a
// pull has no way to ask which issues moved.
const ISSUE_FIELDS = "summary,description,issuetype,status,parent,updated";

export function createCloudClient(connection: JiraConnection, fetchImpl: FetchLike): JiraClient {
  const call = <T>(path: string, init?: RequestInit) => request<T>(connection, fetchImpl, path, init);

  return {
    async myself() {
      return call<{ accountId: string; displayName: string }>("/rest/api/3/myself");
    },

    async repository(key) {
      return call<{ id: string; key: string; name: string }>(`/rest/api/3/project/${encodeURIComponent(key)}`);
    },

    async search(jql, limit = 25) {
      const result = await call<{ issues?: RawIssue[] }>("/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({ jql, maxResults: limit, fields: ISSUE_FIELDS.split(",") }),
      });
      return (result.issues ?? []).map(toIssue);
    },

    async getIssue(key) {
      return toIssue(await call<RawIssue>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`));
    },

    async children(key) {
      // `parent = X` covers both a team-managed epic's children and
      // ordinary sub-tasks; Cloud dropped the old epic-link field.
      return this.search(`parent = "${key}" ORDER BY created ASC`, 100);
    },

    async comments(key) {
      // Paged, because an issue that has been talked about for a year
      // has more than the default page of comments and the interesting
      // ones are usually at the end.
      const collected: JiraComment[] = [];
      for (let startAt = 0; ; ) {
        const page = await call<{ comments?: RawComment[]; total?: number; maxResults?: number }>(
          `/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100&orderBy=created`,
        );
        const batch = page.comments ?? [];
        for (const raw of batch) {
          collected.push({
            id: raw.id ?? "",
            // ADF, flattened the same way a description is (fromAdf).
            body: fromAdf(raw.body).trim(),
            author: raw.author?.displayName ?? "someone in Jira",
            created: raw.created ?? "",
          });
        }
        startAt += batch.length;
        if (batch.length === 0 || startAt >= (page.total ?? startAt)) break;
      }
      return collected;
    },

    async listAttachments(key) {
      const raw = await call<{ fields?: { attachment?: RawAttachment[] } }>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=attachment`);
      return (raw.fields?.attachment ?? []).map(toAttachment).filter((attachment) => attachment.id !== "");
    },

    async downloadAttachment(attachment, maxBytes) {
      if (!attachment.contentUrl) throw new Error(`Jira attachment ${attachment.id} has no content URL.`);
      const response = await requestResponse(connection, fetchImpl, attachment.contentUrl, { headers: { Accept: "application/octet-stream" } });
      return readLimitedBytes(response, maxBytes);
    },

    async uploadAttachment(key, input) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(input.data)], { type: input.mimeType }), input.filename);
      const created = await call<RawAttachment[]>(`/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, {
        method: "POST",
        headers: { "X-Atlassian-Token": "no-check" },
        body: form,
      });
      if (!created[0]?.id) throw new Error("Jira accepted the upload but returned no attachment id.");
      return toAttachment(created[0]);
    },

    async deleteAttachment(attachmentId) {
      await call<void>(`/rest/api/3/attachment/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
    },

    async createIssue(input: CreateIssueInput) {
      const fields: Record<string, unknown> = {
        project: { key: input.projectKey },
        issuetype: { name: input.issueType },
        summary: input.summary,
        description: toAdf(input.description),
        ...(input.parentKey ? { parent: { key: input.parentKey } } : {}),
        ...(input.fields ?? {}),
      };
      return call<JiraIssueRef>("/rest/api/3/issue", { method: "POST", body: JSON.stringify({ fields }) });
    },

    async transitions(key) {
      const result = await call<{ transitions?: { id: string; name: string; to?: { name?: string }; fields?: Record<string, RawField> }[] }>(
        `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      );
      return (result.transitions ?? []).map(
        (entry): JiraTransition => ({
          id: entry.id,
          name: entry.name,
          toStatus: entry.to?.name ?? entry.name,
          // Keyed by field id in an object here, the same shape v2's
          // createmeta uses — hence the same `toField`.
          fields: Object.entries(entry.fields ?? {}).map(([id, raw]) => toField({ ...raw, fieldId: raw.fieldId ?? id })),
        }),
      );
    },

    async transition(key, transitionId, fields) {
      await call<void>(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: transitionId }, ...(fields ? { fields } : {}) }),
      });
    },

    async addComment(key, body) {
      const created = await call<{ id?: string }>(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
        method: "POST",
        body: JSON.stringify({ body: toAdf(body) }),
      });
      return { id: created?.id ?? "" };
    },

    async deleteComment(key, commentId) {
      await call<void>(`/rest/api/3/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`, { method: "DELETE" });
    },

    async deleteIssue(key, options) {
      const subtasks = options?.deleteSubtasks ?? true;
      await call<void>(`/rest/api/3/issue/${encodeURIComponent(key)}?deleteSubtasks=${subtasks}`, { method: "DELETE" });
    },

    async statuses(projectKey) {
      // Per issue type, and the same status usually appears under
      // several — deduplicated, because the map is a status name.
      const raw = await call<{ statuses?: { name?: string }[] }[]>(`/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`);
      const names = raw.flatMap((type) => (type.statuses ?? []).map((status) => status.name ?? "")).filter((name) => name !== "");
      return [...new Set(names)].sort();
    },

    async createMeta(projectKey, issueType) {
      // The v3 per-issue-type endpoint, rather than the old
      // everything-at-once one: it is a fraction of the payload and
      // does not need the issue type id up front.
      const types = await call<{ issueTypes?: { id: string; name: string }[] }>(
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
      );
      const match = (types.issueTypes ?? []).find((entry) => entry.name.toLowerCase() === issueType.toLowerCase());
      if (!match) return [];

      const result = await call<{ fields?: RawField[] }>(
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(match.id)}`,
      );
      return (result.fields ?? []).map(toField);
    },
  };
}

export interface RawField {
  fieldId?: string;
  key?: string;
  name?: string;
  required?: boolean;
  schema?: { type?: string };
  allowedValues?: { id?: string; value?: string; name?: string }[];
}

/** Shared with the Data Center client: the field shape is the same on both. */
export function toField(raw: RawField): JiraField {
  return {
    id: raw.fieldId ?? raw.key ?? "",
    name: raw.name ?? raw.fieldId ?? raw.key ?? "",
    required: raw.required ?? false,
    schemaType: raw.schema?.type ?? "string",
    allowedValues: (raw.allowedValues ?? []).map((entry) => ({
      id: entry.id ?? "",
      // Options use `value`, versions and components use `name`.
      value: entry.value ?? entry.name ?? entry.id ?? "",
    })),
  };
}
