import { toField, type RawField } from "./cloud.js";
import {
  request,
  requestResponse,
  readLimitedBytes,
  type CreateIssueInput,
  type FetchLike,
  type JiraClient,
  type JiraConnection,
  type JiraComment,
  type JiraAttachment,
  type JiraIssue,
  type JiraIssueRef,
  type JiraTransition,
} from "./client.js";

/**
 * Jira Server / Data Center: REST v2 (J-01).
 *
 * Descriptions are plain text — wiki markup, which passes through
 * unharmed — so there is none of Cloud's ADF conversion. The other
 * differences are the search endpoint (GET with query parameters rather
 * than v3's POST), createmeta (one call with expansion rather than two),
 * and children (the epic-link custom field, which Cloud dropped).
 */

interface RawIssue {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    description?: string | null;
    issuetype?: { name?: string };
    status?: { name?: string };
    parent?: { key?: string };
    updated?: string;
  };
}

interface RawComment {
  id?: string;
  body?: string;
  author?: { displayName?: string; name?: string };
  created?: string;
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
    description: (raw.fields?.description ?? "").trim(),
    issueType: raw.fields?.issuetype?.name ?? "",
    status: raw.fields?.status?.name ?? "",
    parentKey: raw.fields?.parent?.key ?? null,
    updated: raw.fields?.updated ?? "",
  };
}

// `updated` is what makes an incremental sync possible: without it a
// pull has no way to ask which issues moved.
const ISSUE_FIELDS = "summary,description,issuetype,status,parent,updated";

export function createDataCenterClient(connection: JiraConnection, fetchImpl: FetchLike): JiraClient {
  const call = <T>(path: string, init?: RequestInit) => request<T>(connection, fetchImpl, path, init);

  return {
    async myself() {
      // Data Center has no accountId; `key` or `name` identifies a user.
      const raw = await call<{ key?: string; name?: string; displayName?: string }>("/rest/api/2/myself");
      return { accountId: raw.key ?? raw.name ?? "", displayName: raw.displayName ?? raw.name ?? "" };
    },

    async repository(key) {
      return call<{ id: string; key: string; name: string }>(`/rest/api/2/project/${encodeURIComponent(key)}`);
    },

    async search(jql, limit = 25) {
      const params = new URLSearchParams({ jql, maxResults: String(limit), fields: ISSUE_FIELDS });
      const result = await call<{ issues?: RawIssue[] }>(`/rest/api/2/search?${params.toString()}`);
      return (result.issues ?? []).map(toIssue);
    },

    async getIssue(key) {
      return toIssue(await call<RawIssue>(`/rest/api/2/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`));
    },

    async children(key) {
      // Data Center still has the classic epic link, and sub-tasks hang
      // off `parent`. Asking for both in one JQL covers either shape.
      return this.search(`("Epic Link" = "${key}" OR parent = "${key}") ORDER BY created ASC`, 100);
    },

    async comments(key) {
      // Paged, as on Cloud. The body is already plain text here — wiki
      // markup — so there is nothing to flatten.
      const collected: JiraComment[] = [];
      for (let startAt = 0; ; ) {
        const page = await call<{ comments?: RawComment[]; total?: number }>(
          `/rest/api/2/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100&orderBy=created`,
        );
        const batch = page.comments ?? [];
        for (const raw of batch) {
          collected.push({
            id: raw.id ?? "",
            body: (raw.body ?? "").trim(),
            author: raw.author?.displayName ?? raw.author?.name ?? "someone in Jira",
            created: raw.created ?? "",
          });
        }
        startAt += batch.length;
        if (batch.length === 0 || startAt >= (page.total ?? startAt)) break;
      }
      return collected;
    },

    async listAttachments(key) {
      const raw = await call<{ fields?: { attachment?: RawAttachment[] } }>(`/rest/api/2/issue/${encodeURIComponent(key)}?fields=attachment`);
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
      const created = await call<RawAttachment[]>(`/rest/api/2/issue/${encodeURIComponent(key)}/attachments`, {
        method: "POST",
        headers: { "X-Atlassian-Token": "no-check" },
        body: form,
      });
      if (!created[0]?.id) throw new Error("Jira accepted the upload but returned no attachment id.");
      return toAttachment(created[0]);
    },

    async deleteAttachment(attachmentId) {
      await call<void>(`/rest/api/2/attachment/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
    },

    async createIssue(input: CreateIssueInput) {
      const fields: Record<string, unknown> = {
        project: { key: input.projectKey },
        issuetype: { name: input.issueType },
        summary: input.summary,
        // Plain text: v2 takes wiki markup, so this is sent as written.
        description: input.description,
        ...(input.parentKey ? { parent: { key: input.parentKey } } : {}),
        ...(input.fields ?? {}),
      };
      return call<JiraIssueRef>("/rest/api/2/issue", { method: "POST", body: JSON.stringify({ fields }) });
    },

    async transitions(key) {
      const result = await call<{ transitions?: { id: string; name: string; to?: { name?: string }; fields?: Record<string, RawField> }[] }>(
        `/rest/api/2/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`,
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
      await call<void>(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: transitionId }, ...(fields ? { fields } : {}) }),
      });
    },

    async addComment(key, body) {
      const created = await call<{ id?: string }>(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      return { id: created?.id ?? "" };
    },

    async deleteComment(key, commentId) {
      await call<void>(`/rest/api/2/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`, { method: "DELETE" });
    },

    async deleteIssue(key, options) {
      const subtasks = options?.deleteSubtasks ?? true;
      await call<void>(`/rest/api/2/issue/${encodeURIComponent(key)}?deleteSubtasks=${subtasks}`, { method: "DELETE" });
    },

    async statuses(projectKey) {
      // Per issue type, and the same status usually appears under
      // several — deduplicated, because the map is a status name.
      const raw = await call<{ statuses?: { name?: string }[] }[]>(`/rest/api/2/project/${encodeURIComponent(projectKey)}/statuses`);
      const names = raw.flatMap((type) => (type.statuses ?? []).map((status) => status.name ?? "")).filter((name) => name !== "");
      return [...new Set(names)].sort();
    },

    async createMeta(projectKey, issueType) {
      const params = new URLSearchParams({
        projectKeys: projectKey,
        issuetypeNames: issueType,
        expand: "projects.issuetypes.fields",
      });
      const result = await call<{ projects?: { issuetypes?: { name?: string; fields?: Record<string, RawField> }[] }[] }>(
        `/rest/api/2/issue/createmeta?${params.toString()}`,
      );

      const type = result.projects?.[0]?.issuetypes?.find((entry) => (entry.name ?? "").toLowerCase() === issueType.toLowerCase());
      // v2 keys fields by id in an object, where v3 returns an array.
      return Object.entries(type?.fields ?? {}).map(([id, raw]) => toField({ ...raw, fieldId: raw.fieldId ?? id }));
    },
  };
}
