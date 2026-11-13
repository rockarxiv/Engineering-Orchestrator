import { describe, expect, it } from "vitest";
import { ipcContract } from "../ipc.js";
import {
  ASSIST_PAGE_ROUTES,
  CHAT_HOME_ROUTE,
  PROPOSED_ITEM_ROUTE,
  PIPELINE_CHANGES_ROUTE,
  PageDescriptorSchema,
  assistPageRouteOf,
  changesComparedOf,
  changesShown,
  assistPageSubjectOf,
  isChatHomeRoute,
  pageDescriptorFor,
  proposedItemPath,
  pipelineChangesPath,
} from "./pageDescriptor.js";

/**
 * The one input an assist turn carries, and the reason it is a descriptor
 * rather than a sentence (EO-189).
 *
 * The property that carries the design is asserted here rather than left
 * to the main process: an unrecognised page must still be a page you can
 * talk on. What is *not* here any more is the conversation key — there
 * is one thread now (EO-193), and this module stopped naming rooms with
 * it.
 */
describe("resolving a path to a descriptor", () => {
  it("matches an item page and captures its id", () => {
    expect(pageDescriptorFor("/items/019fb8c6-de92-7a41-9c33-4471f0c2b1de")).toEqual({
      route: "/items/:itemId",
      params: { itemId: "019fb8c6-de92-7a41-9c33-4471f0c2b1de" },
    });
  });

  it("tells an item's runs page apart from the item's own", () => {
    expect(pageDescriptorFor("/items/019f/runs").route).toBe("/items/:itemId/runs");
    expect(pageDescriptorFor("/items/019f").route).toBe("/items/:itemId");
    // An item not filed yet (EO-408): the card's message and the item's place in it, and nothing looked up.
    expect(pageDescriptorFor(proposedItemPath("019f", 2))).toEqual({ route: PROPOSED_ITEM_ROUTE, params: { messageId: "019f", index: "2" } });
    expect(assistPageRouteOf(pageDescriptorFor("/proposals/019f/2"))?.key).toBe("proposal");
  });

  it("does not read the item list as an item", () => {
    expect(pageDescriptorFor("/items")).toEqual({ route: "/items", params: {} });
  });

  it("matches a pipeline page", () => {
    expect(pageDescriptorFor("/pipelines/default")).toEqual({ route: "/pipelines/:pipelineId", params: { pipelineId: "default" } });
  });

  /**
   * A pipeline's Changes view (EO-524): its own screen, about the
   * pipeline it names — so a draft raised from it has that pipeline to be
   * published against.
   */
  it("matches a pipeline's Changes view, and names the pipeline", () => {
    const page = pageDescriptorFor(pipelineChangesPath("p1").split("?")[0]!);
    expect(page).toEqual({ route: PIPELINE_CHANGES_ROUTE, params: { pipelineId: "p1" } });
    expect(assistPageRouteOf(page)?.key).toBe("pipelineChanges");
    expect(assistPageSubjectOf(page)).toBe("p1");
  });

  /**
   * The screen the app launches on, and the one it was silently blind to
   * (EO-191). It draws a board with no pipeline in its address, so what
   * makes it resolvable is the asking side naming the pipeline the screen
   * falls back to: the active project's first (EO-766), never `default`.
   */
  it("matches the project board the app opens on", () => {
    expect(pageDescriptorFor("/project")).toEqual({ route: "/project", params: {} });
    expect(assistPageSubjectOf(pageDescriptorFor("/project"), { pipelineId: "p1" })).toBe("p1");
    expect(assistPageSubjectOf(pageDescriptorFor("/project"))).toBeNull();
    expect(assistPageSubjectOf(pageDescriptorFor("/project"), { pipelineId: null })).toBeNull();
  });

  it("takes an implied id only for the route whose path carries none", () => {
    expect(assistPageSubjectOf(pageDescriptorFor("/pipelines/p2"), { pipelineId: "p1" })).toBe("p2");
  });

  /**
   * The descriptor carries what the *router* matched and nothing more —
   * `/project` has no parameters in its path and claims none. The id is
   * supplied by the table, on whichever side asks, so the renderer never
   * asserts which board it is showing.
   */
  it("does not put the implied pipeline in the parameters the renderer sends", () => {
    expect(pageDescriptorFor("/project").params).toEqual({});
  });

  it("names no row for a screen that is about none", () => {
    expect(assistPageSubjectOf(pageDescriptorFor("/settings"))).toBeNull();
    expect(assistPageSubjectOf(pageDescriptorFor("/nowhere"))).toBeNull();
    expect(assistPageSubjectOf({ route: "/items/:itemId", params: {} })).toBeNull();
  });

  it("matches every screen the list names", () => {
    for (const route of ASSIST_PAGE_ROUTES.filter((candidate) => candidate.param === null)) {
      expect(pageDescriptorFor(route.route).route).toBe(route.route);
    }
  });

  it("ignores a trailing slash, so one screen is one page", () => {
    expect(pageDescriptorFor("/agents/")).toEqual(pageDescriptorFor("/agents"));
  });

  it("decodes a parameter the router escaped", () => {
    expect(pageDescriptorFor("/pipelines/two%20words").params["pipelineId"]).toBe("two words");
  });

  /**
   * Discussions is deliberately absent — it is gone (EO-526) — and a
   * path nobody listed may not be guessed at.
   */
  it("hands back an unlisted path as its own route, with nothing invented", () => {
    expect(pageDescriptorFor("/discussions/c1")).toEqual({ route: "/discussions/c1", params: {} });
    expect(pageDescriptorFor("/somewhere-new")).toEqual({ route: "/somewhere-new", params: {} });
  });
});

/**
 * What EO-193 removed, asserted as removed.
 *
 * There was a `pageKeyFor` here, and a thread per page keyed on what it
 * returned. The reason was EO-189: the page was resolved into a section
 * and pasted into every turn, so a thread opened on an item carried
 * that item's section and could not be walked to another screen. EO-192
 * ended that — the agent reads the screen itself — and this module has
 * no business naming a room any more.
 *
 * Asserted against the module's own exports rather than by deleting the
 * cases quietly: "removed rather than left unused" is the acceptance
 * criterion, and a helper kept alive by one test is exactly the machinery
 * nothing uses.
 */
describe("keying a conversation on a page", () => {
  it("is not something this module does any more", async () => {
    const module: Record<string, unknown> = await import("./pageDescriptor.js");

    expect(Object.keys(module)).not.toContain("pageKeyFor");
    // Nothing else grew into its place, either.
    expect(Object.keys(module).filter((name) => /key/i.test(name))).toEqual([]);
  });

  /**
   * What survives is the row a page is *about*, which is a different
   * question and has a caller: `currentView.ts` resolves it, and the
   * assist room asks it for the board a draft would be published
   * against. The two addresses of one screen still answer alike — that
   * was never about conversations.
   */
  it("still resolves the two addresses of one screen to one row", () => {
    expect(assistPageSubjectOf(pageDescriptorFor("/items/019f"))).toBe(assistPageSubjectOf(pageDescriptorFor("/items/019f/runs")));
    expect(assistPageSubjectOf(pageDescriptorFor("/project"), { pipelineId: "p1" })).toBe(assistPageSubjectOf(pageDescriptorFor("/pipelines/p1")));
  });
});

describe("the descriptor at the IPC boundary", () => {
  it("accepts a route this build has never heard of", () => {
    // The whole reason `route` is a string and not an enum: refusing
    // here would throw away the message the person actually typed, when
    // the only thing that is missing is a paragraph of context.
    const parsed = PageDescriptorSchema.safeParse({ route: "/somewhere-new" });
    expect(parsed.success).toBe(true);
    expect(assistPageRouteOf(parsed.data!)).toBeUndefined();
  });

  it("defaults the parameters, so a screen needs to send none", () => {
    expect(PageDescriptorSchema.parse({ route: "/settings" }).params).toEqual({});
  });

  it("refuses a descriptor that is not one", () => {
    expect(PageDescriptorSchema.safeParse({ route: "" }).success).toBe(false);
    expect(PageDescriptorSchema.safeParse({ route: "/settings", params: { itemId: 7 } }).success).toBe(false);
    expect(PageDescriptorSchema.safeParse({ params: {} }).success).toBe(false);
  });

  it("is what the assist channel that carries a page validates it against", () => {
    expect(ipcContract["assist:send"].request.safeParse({ route: "/settings" }).success).toBe(false);
    expect(ipcContract["assist:send"].request.safeParse({ page: { route: 7 }, conversationId: null, body: "hi" }).success).toBe(false);
    expect(
      ipcContract["assist:send"].request.safeParse({ page: { route: "/settings" }, conversationId: null, body: "hi" }).success,
    ).toBe(true);
  });

  /**
   * Opening carries none, and that is the shape of EO-193: there is one
   * thread, so nothing about opening it depends on where the person is.
   */
  it("is not on the channel that opens the room, which decides nothing about where you are", () => {
    expect(ipcContract["assist:open"].request.safeParse(undefined).success).toBe(true);
  });
});

/**
 * The addresses that are no page an assist turn can be about.
 *
 * Each is somewhere a person can be without looking at anything but the
 * conversation, or somewhere nothing is drawn at all — so a descriptor
 * for it has to resolve to no section rather than to an invented one.
 */
describe("the addresses that are not a page", () => {
  it("does not resolve the chat layout's home, which is the conversation with nothing beside it", () => {
    // A home that resolved to a page section would tell the agent the
    // person is looking at something, when all they are looking at is
    // the conversation.
    expect(assistPageRouteOf(pageDescriptorFor(CHAT_HOME_ROUTE))).toBeUndefined();
    expect(isChatHomeRoute(CHAT_HOME_ROUTE)).toBe(true);
    expect(isChatHomeRoute("/chat/")).toBe(true);
    // And nowhere else: the main process reads the published view in
    // its place, so the predicate has to be exact.
    for (const path of ["/", "/project", "/chatter", "/chat/thread", "/settings"]) {
      expect({ path, home: isChatHomeRoute(path) }).toEqual({ path, home: false });
    }
  });

  it("does not resolve Discussions' old addresses, which come home (EO-526)", () => {
    expect(assistPageRouteOf(pageDescriptorFor("/discussions"))).toBeUndefined();
    expect(assistPageRouteOf(pageDescriptorFor("/discussions/019fb8c6-de92-7a41-9c33-4471f0c2b1de"))).toBeUndefined();
  });

  it("does not resolve a pipeline's configure address, which the chat layout replaces with the Graph view's (EO-525)", () => {
    expect(ASSIST_PAGE_ROUTES.map((candidate) => candidate.route)).not.toContain("/pipelines/:pipelineId/configure");
    expect(pageDescriptorFor("/pipelines/p1/configure")).toEqual({ route: "/pipelines/p1/configure", params: {} });
    // What the chat layout publishes instead is the board's route, which
    // names the pipeline — the query that makes it the Graph view is not
    // part of the path.
    expect(pageDescriptorFor("/pipelines/p1")).toEqual({ route: "/pipelines/:pipelineId", params: { pipelineId: "p1" } });
    expect(assistPageSubjectOf(pageDescriptorFor("/pipelines/p1"))).toBe("p1");
  });

  it("names none of them in the list of pages", () => {
    const routes = ASSIST_PAGE_ROUTES.map((candidate) => candidate.route);
    for (const route of ["/", CHAT_HOME_ROUTE, "/discussions", "/discussions/:conversationId"]) {
      expect(routes).not.toContain(route);
    }
  });
});

/**
 * What a Changes view compares, as its address says it (EO-524). One
 * writer and one reader, so the board's banner, the diverged chip, the
 * Graph view's history, the view itself and the view resolver agree.
 */
describe("the Changes view's address", () => {
  // The query as a router hands it over: a name with no value reads as "".
  const read = (path: string) => {
    const pairs = (path.split("?")[1] ?? "").split("&").filter((pair) => pair !== "");
    const search = new Map(pairs.map((pair) => [pair.split("=")[0]!, pair.split("=")[1] ?? ""] as const));
    return changesComparedOf((name) => search.get(name) ?? null);
  };

  it("writes and reads back two versions, either, or neither", () => {
    expect(pipelineChangesPath("p1", { kind: "versions", from: 2, to: 5 })).toBe("/pipelines/p1/changes?from=2&to=5");
    expect(pipelineChangesPath("p1", { kind: "versions", from: null, to: 5 })).toBe("/pipelines/p1/changes?to=5");
    expect(pipelineChangesPath("p1")).toBe("/pipelines/p1/changes");
    expect(read(pipelineChangesPath("p1", { kind: "versions", from: 2, to: 5 }))).toEqual({ kind: "versions", from: 2, to: 5 });
    expect(read(pipelineChangesPath("p1"))).toEqual({ kind: "versions", from: null, to: null });
  });

  it("writes and reads back this machine's edits", () => {
    expect(pipelineChangesPath("p1", { kind: "local" })).toBe("/pipelines/p1/changes?local");
    expect(read(pipelineChangesPath("p1", { kind: "local" }))).toEqual({ kind: "local" });
  });

  it("escapes the pipeline's id, and reads a version that is not a whole positive number as none", () => {
    expect(pipelineChangesPath("a b/c")).toBe("/pipelines/a%20b%2Fc/changes");
    expect(read("/pipelines/p1/changes?from=two&to=0")).toEqual({ kind: "versions", from: null, to: null });
    expect(read("/pipelines/p1/changes?from=1.5&to=-3")).toEqual({ kind: "versions", from: null, to: null });
  });

  it("draws this machine's edits on their own, the versions on their own, and both when nothing is named", () => {
    expect(changesShown({ kind: "local" })).toEqual({ local: true, versions: false });
    expect(changesShown({ kind: "versions", from: 1, to: null })).toEqual({ local: false, versions: true });
    expect(changesShown({ kind: "versions", from: null, to: null })).toEqual({ local: true, versions: true });
  });
});
