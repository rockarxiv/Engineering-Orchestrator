import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NO_GIT_STATE, developerRegistry, toRegistryView, type CommentView, type ItemPage } from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { createQueryClient } from "../../../query/client";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { ItemView } from "./ItemView";

/**
 * How much of the item page a posted comment redraws (EO-565): the box it
 * was posted from and the thread it answers, and no other thread.
 *
 * Every comment draws its actions (`CommentActions`, by comment id) each
 * time its thread renders, so counting those per id counts each thread's
 * renders; the composer under the thread is counted directly.
 */

const counts = vi.hoisted(() => ({ comments: new Map<string, number>(), composer: 0 }));

vi.mock("../../CommentActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../CommentActions")>();
  return {
    ...actual,
    CommentActions: (props: Parameters<typeof actual.CommentActions>[0]) => {
      const id = props.commentId ?? "";
      counts.comments.set(id, (counts.comments.get(id) ?? 0) + 1);
      return actual.CommentActions(props);
    },
  };
});

vi.mock("./RunComposer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./RunComposer")>();
  return {
    ...actual,
    RunComposer: (props: Parameters<typeof actual.RunComposer>[0]) => {
      counts.composer += 1;
      return actual.RunComposer(props);
    },
  };
});

function comment(overrides: Partial<CommentView> = {}): CommentView {
  return {
    id: "c1",
    authorType: "agent",
    authorName: "Implementer",
    authorRole: "implementer",
    runId: null,
    parentId: null,
    canApprove: false,
    body: "Working on it.",
    kind: "note",
    options: null,
    pinned: false,
    createdAt: 100,
    awaitingHuman: false,
    mirroredInJira: false,
    ...overrides,
  };
}

function page(comments: CommentView[]): ItemPage {
  return {
    item: {
      id: "t1",
      key: "EO-1",
      type: "story",
      typeLabel: "Story",
      container: false,
      parentId: null,
      parentKey: null,
      parentTitle: null,
      repositoryId: "p1",
      repositoryName: "repo",
      projectId: "b1",
      title: "Rate limit the API",
      pipelineId: "default",
      stepId: "todo",
      pipelineVersion: null,
      stepName: "To Do",
      progress: null,
      priority: 0,
      git: NO_GIT_STATE,
      workspace: { kind: "git-worktree", mode: "isolated", label: null },
      jiraKey: null,
      jiraUrl: null,
      jiraSync: true,
      jiraConnected: false,
      reference: null,
      reviewers: null,
      updatedAt: 1,
      stepEnteredAt: 1,
      heldAt: null,
      needsAttention: false,
      atTerminalStep: false,
      openDependencyCount: 0,
      latestRunStatus: null,
      assigneeName: null,
      assigneePerson: null,
      claimable: false,
      preview: false,
      body: "Throttle the public API.",
      acceptanceCriteria: [],
      typeKey: "developer:story",
      spec: {},
      origin: null,
      createdAt: 1,
      attachments: [],
    },
    comments,
    transitions: [],
    runs: [],
    dependsOn: [],
    watch: null,
    decision: [],
    currentOutput: null,
    earlierComments: 0,
  };
}

/**
 * The item's record, answered afresh on every read the way IPC answers
 * it, with each post held until the test lets it land — at which point
 * the posted comment is on the record.
 */
function serve(record: { comments: CommentView[] }) {
  const posts: { body: string; land: () => void }[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    switch (channel) {
      case "items:get":
        return { ok: true, data: structuredClone(page(record.comments)) };
      case "comments:post": {
        const { body, parentId } = payload as { body: string; parentId: string | null };
        await new Promise<void>((resolve) => posts.push({ body, land: resolve }));
        record.comments = [...record.comments, comment({ id: `posted-${record.comments.length}`, authorType: "human", authorName: "You", authorRole: null, body, parentId, createdAt: 1_000 })];
        return { ok: true, data: { commentId: "posted", resumedRun: false, delivery: null } };
      }
      case "registry:get":
        return { ok: true, data: toRegistryView(developerRegistry()) };
      case "items:list":
        return { ok: true, data: { items: [] } };
      case "agents:list":
        return { ok: true, data: { agents: [] } };
      case "pipelineSteps:list":
        return { ok: true, data: { steps: [], routes: [] } };
      case "projects:list":
        return { ok: true, data: { projects: [], activeProjectId: null } };
      default:
        return { ok: true, data: {} };
    }
  }) as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  return {
    /** Lets the post with this body land — or, given none, the oldest still held. */
    land: (body?: string) => {
      const index = body === undefined ? 0 : posts.findIndex((held) => held.body === body);
      if (index < 0) throw new Error(`No post of "${body}" is being held`);
      posts.splice(index, 1)[0]?.land();
    },
    /** The bodies of every post sent so far, in order. */
    sent: () => (window.eo.ipc.invoke as unknown as Mock).mock.calls.filter((call: unknown[]) => call[0] === "comments:post").map((call: unknown[]) => (call[1] as { body: string }).body),
  };
}

function renderItem() {
  render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/items/t1"]}>
          <ItemReferenceProvider>
            <ItemView itemId="t1" />
          </ItemReferenceProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

/** Let every pending read and render settle. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

const THREADS = [
  comment({ id: "q", body: "Which limit should I use?", kind: "question", awaitingHuman: true, createdAt: 100 }),
  comment({ id: "n1", body: "Started on the middleware.", createdAt: 200 }),
  comment({ id: "n2", body: "Tests are next.", createdAt: 300 }),
];

beforeEach(() => {
  counts.comments.clear();
  counts.composer = 0;
});

describe("posting on an item's thread (EO-565)", () => {
  it("redraws the thread being replied to and the composer, and no other thread", async () => {
    const { land } = serve({ comments: THREADS });
    renderItem();
    const box = await screen.findByPlaceholderText("Reply…");
    await settle();
    const before = new Map(counts.comments);
    const composerBefore = counts.composer;

    fireEvent.change(box, { target: { value: "100 a minute" } });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    // While it is on its way: the answered thread's box is busy, and the
    // page's composer is too; the other threads are left as they were.
    await waitFor(() => expect(counts.comments.get("q")).toBeGreaterThan(before.get("q") ?? 0));
    await settle();
    expect(counts.composer).toBeGreaterThan(composerBefore);
    expect(counts.comments.get("n1")).toBe(before.get("n1"));
    expect(counts.comments.get("n2")).toBe(before.get("n2"));

    // Once it lands and the thread is read again, the reply is drawn
    // under its question — and still no other thread has been redrawn.
    await act(async () => land());
    expect(await screen.findByText("100 a minute")).toBeInTheDocument();
    await settle();
    expect(counts.comments.get("n1")).toBe(before.get("n1"));
    expect(counts.comments.get("n2")).toBe(before.get("n2"));
  });

  it("redraws no thread at all for a comment posted from the page's own box", async () => {
    // Nothing awaiting a reply, so the page's box is the only one open.
    const { land } = serve({ comments: THREADS.map((thread) => ({ ...thread, awaitingHuman: false })) });
    renderItem();
    const box = await screen.findByLabelText("Write a comment");
    await settle();
    const before = new Map(counts.comments);
    const composerBefore = counts.composer;

    fireEvent.change(box, { target: { value: "Looks good so far" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(counts.composer).toBeGreaterThan(composerBefore));
    await act(async () => land());
    expect(await screen.findByText("Looks good so far")).toBeInTheDocument();
    await settle();

    for (const id of ["q", "n1", "n2"]) expect(counts.comments.get(id)).toBe(before.get(id));
  });
});

describe("replies on their way to two threads at once (EO-565)", () => {
  const QUESTIONS = [
    comment({ id: "qa", body: "Which database?", kind: "question", options: ["Postgres", "SQLite"], awaitingHuman: true, createdAt: 100 }),
    comment({ id: "qb", body: "Ship it today?", kind: "question", options: ["Yes", "No"], awaitingHuman: true, createdAt: 200 }),
  ];
  /** The page's own box: the last one named so, under every thread's. */
  const pageBox = () => screen.getAllByLabelText("Write a comment").at(-1)!;

  it("keeps each thread busy until its own reply settles, whichever lands first, and posts no answer twice", async () => {
    const { land, sent } = serve({ comments: QUESTIONS });
    renderItem();
    const postgres = await screen.findByRole("button", { name: "Postgres" });
    const yes = screen.getByRole("button", { name: "Yes" });

    // Answer the first question, then — before it lands — the second,
    // pressing that one twice in one go, before anything has redrawn.
    fireEvent.click(postgres);
    act(() => {
      yes.click();
      yes.click();
    });
    await waitFor(() => expect(sent()).toEqual(["Postgres", "Yes"]));
    expect(screen.getByRole("button", { name: "Postgres" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "SQLite" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Yes" })).toBeDisabled();
    expect(pageBox()).toBeDisabled();

    // The second lands first. Its question is answered and its box goes;
    // the first is still on its way, so its answers stay closed, and so
    // does the page's box.
    await act(async () => land("Yes"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Yes" })).toBeNull());
    await settle();
    expect(screen.getByRole("button", { name: "Postgres" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "SQLite" })).toBeDisabled();
    expect(pageBox()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "SQLite" }));

    // Then the first lands, and only now is anything open again.
    await act(async () => land("Postgres"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Postgres" })).toBeNull());
    await settle();
    expect(pageBox()).toBeEnabled();
    expect(sent()).toEqual(["Postgres", "Yes"]);
  });

  it("sends one reply for a second press on a thread already sending, and answers both presses when it lands", async () => {
    const { land, sent } = serve({ comments: QUESTIONS.slice(0, 1) });
    renderItem();
    const postgres = await screen.findByRole("button", { name: "Postgres" });
    const sqlite = screen.getByRole("button", { name: "SQLite" });

    // Two answers to one question, a render apart from being disabled.
    act(() => {
      postgres.click();
      sqlite.click();
    });
    await waitFor(() => expect(sent()).toEqual(["Postgres"]));
    await settle();
    expect(screen.getByRole("button", { name: "SQLite" })).toBeDisabled();

    await act(async () => land("Postgres"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Postgres" })).toBeNull());
    await settle();
    expect(sent()).toEqual(["Postgres"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
