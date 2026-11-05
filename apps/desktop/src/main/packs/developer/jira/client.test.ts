import { describe, expect, it } from "vitest";
import { authHeader, normaliseBaseUrl, type FetchLike, type JiraConnection } from "./client.js";
import { fromAdf, toAdf } from "./cloud.js";
import { createJiraClient } from "./index.js";

/**
 * The client against recorded Jira payloads (J-01).
 *
 * `fetch` is a parameter for exactly this reason — the same seam
 * `fetchClaudeModels(runQuery)` uses. No test here touches the network.
 */
const CLOUD: JiraConnection = { baseUrl: "https://acme.atlassian.net", flavour: "cloud", email: "dev@acme.com", token: "tok" };
const DC: JiraConnection = { baseUrl: "https://jira.acme.internal", flavour: "datacenter", email: null, token: "pat" };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Records what was sent and replies with what the test says Jira replies. */
function recorder(replies: Record<string, unknown> | ((url: string) => unknown)) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ url, method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    const reply = typeof replies === "function" ? replies(url) : (replies[Object.keys(replies).find((key) => url.includes(key)) ?? ""] ?? {});
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

describe("authentication", () => {
  it("uses Basic with the email for Cloud and Bearer for Data Center", () => {
    // Cloud's API tokens are only valid as the password half of Basic
    // with the account email; a PAT is a Bearer and has no email.
    expect(authHeader(CLOUD)).toBe(`Basic ${Buffer.from("dev@acme.com:tok").toString("base64")}`);
    expect(authHeader(DC)).toBe("Bearer pat");
  });

  it("does not care how many slashes the user typed", () => {
    // `${base}//rest/api/3/...` is a 404 nobody can explain.
    expect(normaliseBaseUrl("https://acme.atlassian.net/")).toBe("https://acme.atlassian.net");
    expect(normaliseBaseUrl("  https://acme.atlassian.net///  ")).toBe("https://acme.atlassian.net");
  });
});

describe("Atlassian Document Format", () => {
  it("wraps plain text into paragraphs, because v3 refuses a string", () => {
    const doc = toAdf("First line.\n\nSecond one.") as { content: { content: { text: string }[] }[] };

    expect(doc.content).toHaveLength(2);
    expect(doc.content[0]?.content[0]?.text).toBe("First line.");
  });

  it("produces a valid empty document rather than an empty content array", () => {
    // ADF rejects a paragraph-less doc, and an empty description is a
    // perfectly ordinary thing to have.
    const doc = toAdf("   ") as { content: unknown[] };
    expect(doc.content).toHaveLength(1);
  });

  it("reads a description back well enough to show", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Throttle the API." }] },
        { type: "paragraph", content: [{ type: "text", text: "Return 429." }] },
      ],
    };

    expect(fromAdf(doc).trim()).toBe("Throttle the API.\n\nReturn 429.");
  });

  it("keeps a bullet list looking like a list", () => {
    // A real Jira description turned four bullet points into four
    // sentences that read as if they followed on from each other. The
    // product owner reads this text; the shape is part of the meaning.
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Before you start:" }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "A cloud instance." }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Admin rights." }] }] },
          ],
        },
      ],
    };

    expect(fromAdf(doc).trim()).toBe("Before you start:\n\n- A cloud instance.\n- Admin rights.");
  });

  it("survives a node type it has never seen", () => {
    // Panels, tables, media — a faithful renderer is a repository of its
    // own, and losing the text would be worse than losing the layout.
    const doc = { type: "doc", content: [{ type: "panel", content: [{ type: "paragraph", content: [{ type: "text", text: "Careful." }] }] }] };

    expect(fromAdf(doc)).toContain("Careful.");
  });
});

describe("Cloud and Data Center speak different dialects", () => {
  it("creates an issue with an ADF description on Cloud and plain text on Data Center", async () => {
    const cloud = recorder({ "/rest/api/3/issue": { id: "1", key: "ACME-1" } });
    await createJiraClient(CLOUD, cloud.fetchImpl).createIssue({
      projectKey: "ACME",
      issueType: "Epic",
      summary: "Rate limiting",
      description: "Throttle it.",
    });

    const dc = recorder({ "/rest/api/2/issue": { id: "1", key: "ACME-1" } });
    await createJiraClient(DC, dc.fetchImpl).createIssue({
      projectKey: "ACME",
      issueType: "Epic",
      summary: "Rate limiting",
      description: "Throttle it.",
    });

    const cloudBody = cloud.calls[0]?.body as { fields: { description: unknown } };
    const dcBody = dc.calls[0]?.body as { fields: { description: unknown } };
    expect(cloudBody.fields.description).toMatchObject({ type: "doc" });
    expect(dcBody.fields.description).toBe("Throttle it.");
    expect(cloud.calls[0]?.url).toContain("/rest/api/3/");
    expect(dc.calls[0]?.url).toContain("/rest/api/2/");
  });

  it("deletes an issue with its sub-tasks on both flavours (KAN-30)", async () => {
    // deleteSubtasks is not optional in practice: Jira refuses the
    // delete outright when an issue has children and it is false, so
    // defaulting it to true is what makes the call work at all.
    const cloud = recorder({});
    await createJiraClient(CLOUD, cloud.fetchImpl).deleteIssue("ACME-1");
    const dc = recorder({});
    await createJiraClient(DC, dc.fetchImpl).deleteIssue("ACME-1");

    expect(cloud.calls[0]?.method).toBe("DELETE");
    expect(cloud.calls[0]?.url).toBe("https://acme.atlassian.net/rest/api/3/issue/ACME-1?deleteSubtasks=true");
    expect(dc.calls[0]?.method).toBe("DELETE");
    expect(dc.calls[0]?.url).toBe("https://jira.acme.internal/rest/api/2/issue/ACME-1?deleteSubtasks=true");
  });

  it("deletes a comment by id on both flavours", async () => {
    const cloud = recorder({});
    await createJiraClient(CLOUD, cloud.fetchImpl).deleteComment("ACME-1", "10101");
    const dc = recorder({});
    await createJiraClient(DC, dc.fetchImpl).deleteComment("ACME-1", "10101");

    expect(cloud.calls[0]?.method).toBe("DELETE");
    expect(cloud.calls[0]?.url).toBe("https://acme.atlassian.net/rest/api/3/issue/ACME-1/comment/10101");
    expect(dc.calls[0]?.method).toBe("DELETE");
    expect(dc.calls[0]?.url).toBe("https://jira.acme.internal/rest/api/2/issue/ACME-1/comment/10101");
  });

  it("searches by POST on Cloud and by query string on Data Center", async () => {
    const cloud = recorder({ search: { issues: [] } });
    await createJiraClient(CLOUD, cloud.fetchImpl).search('project = "ACME"');
    expect(cloud.calls[0]?.method).toBe("POST");

    const dc = recorder({ search: { issues: [] } });
    await createJiraClient(DC, dc.fetchImpl).search('project = "ACME"');
    expect(dc.calls[0]?.method).toBe("GET");
    expect(dc.calls[0]?.url).toContain("jql=");
  });

  it("looks for children the way each flavour stores them", async () => {
    // Cloud dropped the epic-link field; Data Center still has it, and
    // sub-tasks hang off parent on both.
    const cloud = recorder({ search: { issues: [] } });
    await createJiraClient(CLOUD, cloud.fetchImpl).children("ACME-1");
    expect(JSON.stringify(cloud.calls[0]?.body)).toContain("parent = ");

    const dc = recorder({ search: { issues: [] } });
    await createJiraClient(DC, dc.fetchImpl).children("ACME-1");
    // URLSearchParams form-encodes spaces as "+", which decodeURIComponent
    // leaves alone — Jira's query-string parser turns them back.
    expect(decodeURIComponent((dc.calls[0]?.url ?? "").replace(/\+/g, " "))).toContain("Epic Link");
  });

  it("parses an issue the same way out of both dialects", async () => {
    const raw = {
      id: "10001",
      key: "ACME-7",
      fields: {
        summary: "Rate limiting",
        issuetype: { name: "Epic" },
        status: { name: "In Progress" },
        parent: { key: "ACME-1" },
      },
    };

    const cloud = recorder({ issue: { ...raw, fields: { ...raw.fields, description: toAdf("Throttle it.") } } });
    const dc = recorder({ issue: { ...raw, fields: { ...raw.fields, description: "Throttle it." } } });

    const fromCloud = await createJiraClient(CLOUD, cloud.fetchImpl).getIssue("ACME-7");
    const fromDc = await createJiraClient(DC, dc.fetchImpl).getIssue("ACME-7");

    expect(fromCloud).toEqual(fromDc);
    expect(fromCloud).toMatchObject({ key: "ACME-7", summary: "Rate limiting", description: "Throttle it.", parentKey: "ACME-1" });
  });

  it("reads createmeta out of an array on Cloud and an object on Data Center", async () => {
    const cloud = recorder((url) =>
      url.endsWith("/issuetypes")
        ? { issueTypes: [{ id: "10", name: "Epic" }] }
        : { fields: [{ fieldId: "customfield_1", name: "Team", required: true, schema: { type: "option" }, allowedValues: [{ id: "5", value: "Core" }] }] },
    );
    const dc = recorder({
      createmeta: {
        projects: [
          {
            issuetypes: [
              { name: "Epic", fields: { customfield_1: { name: "Team", required: true, schema: { type: "option" }, allowedValues: [{ id: "5", value: "Core" }] } } },
            ],
          },
        ],
      },
    });

    const fromCloud = await createJiraClient(CLOUD, cloud.fetchImpl).createMeta("ACME", "Epic");
    const fromDc = await createJiraClient(DC, dc.fetchImpl).createMeta("ACME", "Epic");

    expect(fromCloud).toEqual(fromDc);
    expect(fromCloud[0]).toMatchObject({ id: "customfield_1", name: "Team", required: true, allowedValues: [{ id: "5", value: "Core" }] });
  });
});

describe("a success that is not JSON", () => {
  it("names Jira and the address rather than the parser", async () => {
    // An SSO login page or a proxy answering in Jira's place returns 200
    // with HTML. Parsed bare that surfaced as "Unexpected token '<'",
    // which tells a person nothing about what to change.
    const fetchImpl: FetchLike = async () =>
      new Response("<!doctype html><html><body>Sign in</body></html>", { status: 200, headers: { "content-type": "text/html" } });

    await expect(createJiraClient(CLOUD, fetchImpl).repository("ACME")).rejects.toThrow(/not JSON.*login page or a proxy/s);
  });
});

describe("what a failure says", () => {
  async function failing(status: number, body: unknown) {
    const fetchImpl: FetchLike = async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    return createJiraClient(CLOUD, fetchImpl)
      .myself()
      .catch((error: Error) => error.message);
  }

  it("says the credentials were rejected", async () => {
    expect(await failing(401, { errorMessages: ["Client must be authenticated to access this resource."] })).toContain("rejected the credentials");
  });

  it("distinguishes rejected credentials from a refused request", async () => {
    // 403 means the token is fine and the account cannot do this —
    // sending someone to re-check their token would waste their time.
    expect(await failing(403, { errorMessages: ["You do not have permission to create issues in this repository."] })).toContain(
      "refused the request",
    );
  });

  it("names the field Jira objected to", async () => {
    // Create failures come back keyed by field, and "customfield_10037
    // is required" is the whole diagnosis.
    const message = await failing(400, { errors: { customfield_10037: "Team is required." } });
    expect(message).toContain("customfield_10037");
    expect(message).toContain("Team is required.");
  });

  it("survives a reply that is not JSON at all", async () => {
    // A proxy, a login page, an outage. The raw text is the only
    // evidence there is.
    expect(await failing(502, "<html>Bad Gateway</html>")).toContain("Bad Gateway");
  });

  it("says what it tried to reach when the request never arrived", async () => {
    // DNS, TLS, refused, offline: there is no status to report.
    const fetchImpl: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND acme.atlassian.net");
    };
    const message = await createJiraClient(CLOUD, fetchImpl)
      .myself()
      .catch((error: Error) => error.message);

    expect(message).toContain("Could not reach https://acme.atlassian.net");
    expect(message).toContain("ENOTFOUND");
  });
});

/**
 * Reading comments off an issue — the half the client never had.
 *
 * Until this it could only write them, which is why an inbound sync was
 * impossible: nothing could see what Jira held.
 */
describe("reading an issue's comments", () => {
  it("flattens ADF on Cloud and passes wiki markup through on Data Center", async () => {
    const cloudDoc = {
      comments: [
        {
          id: "10501",
          author: { displayName: "Dana" },
          created: "2026-08-09T10:00:00.000+0000",
          body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Per API key." }] }] },
        },
      ],
      total: 1,
    };
    const cloud = recorder({ comment: cloudDoc });
    const fromCloud = await createJiraClient(CLOUD, cloud.fetchImpl).comments("ACME-8");

    const dc = recorder({ comment: { comments: [{ id: "9001", author: { name: "dana" }, created: "x", body: "Per API key." }], total: 1 } });
    const fromDc = await createJiraClient(DC, dc.fetchImpl).comments("ACME-8");

    expect(fromCloud).toEqual([{ id: "10501", body: "Per API key.", author: "Dana", created: "2026-08-09T10:00:00.000+0000" }]);
    expect(cloud.calls[0]?.url).toContain("/rest/api/3/issue/ACME-8/comment");
    expect(fromDc[0]).toMatchObject({ id: "9001", body: "Per API key." });
    expect(dc.calls[0]?.url).toContain("/rest/api/2/issue/ACME-8/comment");
  });

  it("follows pagination rather than stopping at the first page", async () => {
    // An issue talked about for a year has more than one page, and the
    // comment worth reading is usually the last one.
    const pages = [
      { comments: [{ id: "1", body: "first", author: { name: "a" }, created: "x" }], total: 2 },
      { comments: [{ id: "2", body: "second", author: { name: "a" }, created: "y" }], total: 2 },
    ];
    let call = 0;
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify(pages[call++] ?? { comments: [], total: 2 }), { status: 200 });

    const all = await createJiraClient(DC, fetchImpl).comments("ACME-8");

    expect(all.map((entry) => entry.id)).toEqual(["1", "2"]);
  });

  it("stops on an empty page rather than looping forever", async () => {
    // A `total` that disagrees with what is returned must not spin.
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ comments: [], total: 99 }), { status: 200 });

    expect(await createJiraClient(DC, fetchImpl).comments("ACME-8")).toEqual([]);
  });

  it("names an author it cannot identify rather than showing nothing", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ comments: [{ id: "1", body: "hi" }], total: 1 }), { status: 200 });

    expect((await createJiraClient(DC, fetchImpl).comments("ACME-8"))[0]?.author).toBe("someone in Jira");
  });

  it("asks for `updated`, so a sync can tell what moved", async () => {
    const cloud = recorder({ issue: { id: "1", key: "ACME-8", fields: { summary: "s", updated: "2026-08-09T10:00:00.000+0000" } } });
    const issue = await createJiraClient(CLOUD, cloud.fetchImpl).getIssue("ACME-8");

    expect(cloud.calls[0]?.url).toContain("updated");
    expect(issue.updated).toBe("2026-08-09T10:00:00.000+0000");
  });
});

describe("issue attachments", () => {
  for (const [name, connection, api] of [["Cloud", CLOUD, "3"], ["Data Center", DC, "2"]] as const) {
    it(`${name} lists, downloads, uploads, and deletes attachment content`, async () => {
      const calls: { url: string; init?: RequestInit }[] = [];
      const fetchImpl: FetchLike = async (url, init) => {
        calls.push({ url, ...(init ? { init } : {}) });
        const path = new URL(url).pathname;
        if (path.endsWith("/attachments") && init?.method === "POST") {
          const form = init.body as FormData;
          const file = form.get("file") as File;
          expect(file.name).toBe("report.txt");
          expect(await file.text()).toBe("hello");
          return new Response(JSON.stringify([{ id: "501", filename: file.name, mimeType: file.type, size: file.size, content: "https://files/501" }]), { status: 200 });
        }
        if (path === "/content/500") return new Response(new TextEncoder().encode("bytes"));
        if (path.includes("/attachment/500") && init?.method === "DELETE") return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ fields: { attachment: [{ id: "500", filename: "old.txt", mimeType: "text/plain", size: 5, content: "https://jira.example/content/500" }] } }), { status: 200 });
      };
      const client = createJiraClient(connection, fetchImpl);

      const listed = await client.listAttachments("ACME-8");
      expect(new TextDecoder().decode(await client.downloadAttachment(listed[0]!, 20 * 1024 * 1024))).toBe("bytes");
      expect(await client.uploadAttachment("ACME-8", { filename: "report.txt", mimeType: "text/plain", data: new TextEncoder().encode("hello") })).toMatchObject({ id: "501" });
      await client.deleteAttachment("500");

      expect(calls[0]?.url).toContain(`/rest/api/${api}/issue/ACME-8?fields=attachment`);
      const upload = calls.find((call) => call.url.endsWith("/attachments"));
      expect(new Headers(upload?.init?.headers).get("X-Atlassian-Token")).toBe("no-check");
      expect(new Headers(upload?.init?.headers).get("Content-Type"), "fetch must add the multipart boundary").toBeNull();
      expect(calls.at(-1)?.url).toContain(`/rest/api/${api}/attachment/500`);
    });
  }

  it("stops an oversized content stream even when Jira metadata understated it", async () => {
    const fetchImpl: FetchLike = async () => new Response(new Uint8Array(6));
    const client = createJiraClient(CLOUD, fetchImpl);

    await expect(client.downloadAttachment({ id: "1", filename: "lie.bin", mimeType: "application/octet-stream", size: 1, contentUrl: "https://files/1", created: "" }, 5))
      .rejects.toThrow("20 MB");
  });
});

/**
 * The words in here belong to Atlassian, not to EO.
 *
 * EO renamed its own "project" to "repository" — the thing an item has a
 * checkout of. A blanket rename then walked straight through Jira's
 * vocabulary too, and every call that names a project went out wrong:
 * `/rest/api/3/repository/ACME`, a create body carrying `repository:
 * { key }`, `expand=repositories.issuetypes.fields`, and JQL reading
 * `repository = "ACME"`. Jira has no such endpoint, no such field and no
 * such JQL term; against a real server all of it 404s or 400s.
 *
 * Nothing failed, because the stub servers were renamed in the same
 * sweep. Fixture and code agreed with each other and were both wrong
 * about the third party — which is exactly the failure a fixture cannot
 * catch, and why these assertions name the literal strings Atlassian
 * publishes rather than reaching for a constant that could be renamed
 * along with everything else.
 */
describe("Jira's own vocabulary survives a rename of ours", () => {
  it("asks for a project at Atlassian's project endpoint", async () => {
    const cloud = recorder({});
    await createJiraClient(CLOUD, cloud.fetchImpl).repository("ACME");
    const dc = recorder({});
    await createJiraClient(DC, dc.fetchImpl).repository("ACME");

    expect(cloud.calls[0]?.url).toBe("https://acme.atlassian.net/rest/api/3/project/ACME");
    expect(dc.calls[0]?.url).toBe("https://jira.acme.internal/rest/api/2/project/ACME");
  });

  it("asks for a project's statuses at Atlassian's project endpoint", async () => {
    const cloud = recorder(() => []);
    await createJiraClient(CLOUD, cloud.fetchImpl).statuses("ACME");
    const dc = recorder(() => []);
    await createJiraClient(DC, dc.fetchImpl).statuses("ACME");

    expect(cloud.calls[0]?.url).toBe("https://acme.atlassian.net/rest/api/3/project/ACME/statuses");
    expect(dc.calls[0]?.url).toBe("https://jira.acme.internal/rest/api/2/project/ACME/statuses");
  });

  it("names the project field `project` when creating an issue", async () => {
    const cloud = recorder({ issue: { id: "1", key: "ACME-1" } });
    await createJiraClient(CLOUD, cloud.fetchImpl).createIssue({ projectKey: "ACME", issueType: "Epic", summary: "s", description: "d" });
    const dc = recorder({ issue: { id: "1", key: "ACME-1" } });
    await createJiraClient(DC, dc.fetchImpl).createIssue({ projectKey: "ACME", issueType: "Epic", summary: "s", description: "d" });

    expect(cloud.calls[0]?.body).toMatchObject({ fields: { project: { key: "ACME" } } });
    expect(dc.calls[0]?.body).toMatchObject({ fields: { project: { key: "ACME" } } });
  });

  it("expands createmeta by `projects` on Data Center", async () => {
    const dc = recorder({ createmeta: { projects: [{ issuetypes: [{ name: "Epic", fields: {} }] }] } });
    await createJiraClient(DC, dc.fetchImpl).createMeta("ACME", "Epic");

    expect(decodeURIComponent(dc.calls[0]?.url ?? "")).toContain("expand=projects.issuetypes.fields");
  });
});
