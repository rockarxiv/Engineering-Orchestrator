import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { isJiraPullPending, linkJiraKey, projectForWorkspace, saveJiraBinding, updateItem } from "../../../db/repos/index.js";
import { createJiraConnection } from "../../../db/repos/jiraConnectionsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import type { FetchLike } from "./client.js";
import type { JiraContext } from "./connection.js";
import { storeToken } from "./credentials.js";
import type { SecretStore } from "../../../secrets/store.js";
import { jiraPullMinutes, requestJiraPullDrain, setJiraPullMinutes, startJiraPull } from "./pullSchedule.js";

/**
 * The timer that keeps EO current with Jira.
 *
 * Modelled on the outbox drain and the archive sweep: at launch as well
 * as on the timer, non-overlapping, and disposable.
 */
let handle: DbHandle;
let directory: string;
/** Every test's timer, stopped in afterEach — a stray tick after the DB closes is a confusing crash, not a failure. */
let stopPull: (() => void) | null = null;

const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain),
  decryptString: (encrypted) => encrypted.toString(),
};

function context(fetchImpl: FetchLike): JiraContext {
  return { credentials: { directory, store }, fetchImpl };
}

/** Starts the sweep and remembers how to stop it. */
function start(fetchImpl: FetchLike, intervalMs?: number): void {
  stopPull = startJiraPull(handle.db, context(fetchImpl), intervalMs === undefined ? {} : { intervalMs });
}

/**
 * A connected project, so the sweep has something to ask about.
 *
 * Returns the workspace, because that is what a test hangs items off —
 * the Jira binding it configures belongs to the project the workspace
 * came with (KAN-130), and `pullEverything` sweeps one project per
 * binding.
 */
function connect(): Uuid {
  const workspace = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
  const project = projectForWorkspace(handle.db, workspace.id)!;
  const site = createJiraConnection(handle.db, { baseUrl: "https://jira.acme.internal", flavour: "datacenter" });
  saveJiraBinding(handle.db, project.id, { connectionId: site.id, projectKey: "ACME" });
  // The token too: without it `jiraFor` refuses before any request, and
  // the sweep would look correct while asking Jira nothing.
  storeToken({ directory, store }, site.id, "pat");
  // And something mirrored to ask about: a project with no Jira-linked
  // item is deliberately skipped without a request.
  const item = createTestItem(handle.db, { type: "story", title: "Count requests", stepId: "todo", workspaceId: workspace.id, projectId: project.id });
  // `updateItem` rather than `linkJiraKey`: this is the item the
  // *sweep* is about, and attaching through the front door would mark it
  // pull-pending and give the drain something to do as well (EO-127).
  updateItem(handle.db, item.id, { jiraKey: "ACME-8" });
  return workspace.id;
}

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo pull sched "));
});

afterEach(() => {
  stopPull?.();
  stopPull = null;
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the setting", () => {
  it("defaults to five minutes", () => {
    expect(jiraPullMinutes(handle.db)).toBe(5);
  });

  it("can be turned off, which is not the same as never configured", () => {
    // `null` is a value meaning never; an absent row means unset, which
    // is what gives the default. A falsy check would merge them.
    setJiraPullMinutes(handle.db, null);
    expect(jiraPullMinutes(handle.db)).toBeNull();

    setJiraPullMinutes(handle.db, 15);
    expect(jiraPullMinutes(handle.db)).toBe(15);
  });
});

describe("the sweep", () => {
  it("runs at launch, not only after the first interval", async () => {
    // A desktop app closed every evening would otherwise never reach a
    // five-minute tick — the same reason the archive sweep runs at boot.
    connect();
    let asked = 0;
    const counting: FetchLike = async () => {
      asked += 1;
      return new Response(JSON.stringify({ issues: [] }), { status: 200 });
    };

    start(counting);

    await vi.waitFor(() => expect(asked).toBeGreaterThan(0));
  });

  it("does nothing at all when it is turned off", async () => {
    connect();
    setJiraPullMinutes(handle.db, null);
    let asked = 0;
    const counting: FetchLike = async () => {
      asked += 1;
      return new Response(JSON.stringify({ issues: [] }), { status: 200 });
    };

    start(counting, 5);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(asked).toBe(0);
  });

  it("does not pull again before the interval has passed", async () => {
    // The timer ticks often so a settings change is noticed quickly;
    // that must not turn into a request every tick.
    connect();
    let asked = 0;
    const counting: FetchLike = async () => {
      asked += 1;
      return new Response(JSON.stringify({ issues: [] }), { status: 200 });
    };

    start(counting, 5);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(asked, "one launch pull, and nothing more inside five minutes").toBe(1);
  });

  it("stops when it is disposed", async () => {
    connect();
    let asked = 0;
    const counting: FetchLike = async () => {
      asked += 1;
      return new Response(JSON.stringify({ issues: [] }), { status: 200 });
    };

    start(counting, 5);
    await vi.waitFor(() => expect(asked).toBe(1));
    stopPull?.();
    stopPull = null;
    setJiraPullMinutes(handle.db, 0.0001); // due again immediately, if anything were still running
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(asked).toBe(1);
  });

  it("survives a Jira that is not answering", async () => {
    // Reading Jira must never be the reason the app falls over.
    connect();
    const offline: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND jira.acme.internal");
    };
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});

    start(offline, 5);
    await new Promise((resolve) => setTimeout(resolve, 40));
    logged.mockRestore();

    expect(true).toBe(true); // reaching here without an unhandled rejection is the assertion
  });

  it("asks nothing when no project is connected", async () => {
    let asked = 0;
    const counting: FetchLike = async () => {
      asked += 1;
      return new Response(JSON.stringify({ issues: [] }), { status: 200 });
    };

    start(counting, 5);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(asked).toBe(0);
  });
});

/**
 * The items somebody just attached, drained ahead of the sweep (EO-127).
 *
 * A freshly attached issue is invisible to the ordinary sweep — that
 * asks Jira what *moved*, and an issue nobody has touched this week
 * never appears in the answer — so it has to be pulled by name. The
 * marker is what carries the request from the synchronous write path
 * that made it to the timer that can afford the network.
 */
describe("the pending drain", () => {
  /** An item attached through the front door, which is what marks it. */
  function attached(workspaceId: Uuid, key: string): Uuid {
    const project = projectForWorkspace(handle.db, workspaceId)!;
    const item = createTestItem(handle.db, { type: "story", title: "Attached", stepId: "todo", workspaceId, projectId: project.id });
    expect(linkJiraKey(handle.db, item.id, key).ok).toBe(true);
    return item.id;
  }

  /** Answers anything, and remembers which issues were asked for by name. */
  function jira(): { fetchImpl: FetchLike; issuesRead: string[] } {
    const issuesRead: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      if (path.includes("/search")) return new Response(JSON.stringify({ issues: [] }), { status: 200 });
      if (path.endsWith("/comment")) return new Response(JSON.stringify({ comments: [], total: 0 }), { status: 200 });
      const key = /\/issue\/([^/?]+)/.exec(path)?.[1];
      if (key) issuesRead.push(decodeURIComponent(key));
      return new Response(JSON.stringify({ id: "1", key: key ?? "ACME-1", fields: { summary: "Attached", description: "", updated: "x" } }), { status: 200 });
    };
    return { fetchImpl, issuesRead };
  }

  it("pulls a newly attached item by name and clears its marker", async () => {
    const workspaceId = connect();
    const subject = attached(workspaceId, "ACME-42");
    const asked = jira();

    start(asked.fetchImpl, 5);

    await vi.waitFor(() => expect(isJiraPullPending(handle.db, subject)).toBe(false));
    expect(asked.issuesRead).toContain("ACME-42");
  });

  it("drains before the sweep, so the attach does not queue behind it", async () => {
    // Somebody is watching for this one. A sweep of every connected
    // project ahead of it is that many round trips of waiting.
    const workspaceId = connect();
    attached(workspaceId, "ACME-42");
    const order: string[] = [];
    const ordered: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      if (path.includes("/search")) {
        order.push("sweep");
        return new Response(JSON.stringify({ issues: [] }), { status: 200 });
      }
      if (path.endsWith("/comment")) return new Response(JSON.stringify({ comments: [], total: 0 }), { status: 200 });
      order.push("drain");
      return new Response(JSON.stringify({ id: "1", key: "ACME-42", fields: { summary: "Attached", description: "", updated: "x" } }), { status: 200 });
    };

    start(ordered, 5);

    await vi.waitFor(() => expect(order).toContain("sweep"));
    expect(order[0]).toBe("drain");
  });

  it("leaves the marker set when Jira is unreachable, and retries on the next tick", async () => {
    // The behaviour the whole marker exists for. Attaching while Jira is
    // down must cost nobody the backfill, and nothing else will ever
    // come back for an issue that has not moved.
    const workspaceId = connect();
    const subject = attached(workspaceId, "ACME-42");
    let offline = true;
    let attempts = 0;
    const flaky: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      if (path.includes("/search")) return new Response(JSON.stringify({ issues: [] }), { status: 200 });
      if (path.endsWith("/comment")) return new Response(JSON.stringify({ comments: [], total: 0 }), { status: 200 });
      attempts += 1;
      if (offline) throw new Error("getaddrinfo ENOTFOUND jira.acme.internal");
      return new Response(JSON.stringify({ id: "1", key: "ACME-42", fields: { summary: "Attached", description: "", updated: "x" } }), { status: 200 });
    };
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});

    start(flaky, 5);

    await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
    expect(isJiraPullPending(handle.db, subject)).toBe(true);

    offline = false;
    await vi.waitFor(() => expect(isJiraPullPending(handle.db, subject)).toBe(false));
    logged.mockRestore();
  });

  it("drains inside the interval, which the sweep is held to", async () => {
    // The two are gated differently on purpose: the interval is how
    // often somebody wants EO *polling*, and an attach is not polling.
    const workspaceId = connect();
    const asked = jira();
    start(asked.fetchImpl, 5);
    await vi.waitFor(() => expect(asked.fetchImpl).toBeDefined());

    // Well inside the five-minute interval the launch pull just used.
    const subject = attached(workspaceId, "ACME-42");

    await vi.waitFor(() => expect(isJiraPullPending(handle.db, subject)).toBe(false));
  });

  it("drains even with auto-sync switched off", async () => {
    // Off means "stop asking Jira what changed". It does not mean an
    // issue somebody has just said this item *is* goes unread — that
    // request was made explicitly, at a moment, by a person or an agent.
    const workspaceId = connect();
    setJiraPullMinutes(handle.db, null);
    const subject = attached(workspaceId, "ACME-42");
    const asked = jira();

    start(asked.fetchImpl, 5);

    await vi.waitFor(() => expect(isJiraPullPending(handle.db, subject)).toBe(false));
    // And it is still not a sweep: nothing asked Jira what moved.
    expect(asked.issuesRead).toEqual(["ACME-42"]);
  });

  it("asks nothing when nothing is waiting, however often it ticks", async () => {
    // The drain runs on every tick, so an idle project must cost no
    // requests at all.
    setJiraPullMinutes(handle.db, null);
    const asked = jira();

    start(asked.fetchImpl, 5);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(asked.issuesRead).toEqual([]);
  });

  it("can be kicked, so an attach does not wait out the tick", async () => {
    // What the handlers call after the write lands. Auto-sync off and a
    // minute between ticks, so the only thing that can pull inside this
    // test is the kick itself.
    const workspaceId = connect();
    setJiraPullMinutes(handle.db, null);
    const asked = jira();
    start(asked.fetchImpl, 60_000);

    const subject = attached(workspaceId, "ACME-42");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isJiraPullPending(handle.db, subject), "nothing has ticked yet").toBe(true);

    requestJiraPullDrain();

    await vi.waitFor(() => expect(isJiraPullPending(handle.db, subject)).toBe(false));
  });

  it("is a no-op when no schedule is running", () => {
    // Every test that never starts one, and the window between quitting
    // and the next launch. The marker survives either way.
    stopPull?.();
    stopPull = null;

    expect(() => requestJiraPullDrain()).not.toThrow();
  });
});
