import { LOCAL_PERSON_ID, type Agent, type InboxItem, type Item, type Message } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChangeAnnouncers } from "./changeAnnouncers.js";
import type { DbHandle } from "./db/client.js";
import { createRun, listAgents, postComment, setSetting, updateRun } from "./db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "./db/testHelpers.js";
import { DND_KEY } from "./ipc/domainCommands.js";
import { listInbox } from "./ipc/domainQueries.js";
import { createInboxNotifier, notificationFor, notificationForJobGuard, notificationForMessage, shouldInterrupt } from "./notifications.js";
import { dismissMessageCommand, sendMessage } from "./messages/messages.js";

let handle: DbHandle;
let item: Item;
let implementer: Agent;

function makeNotifier() {
  const notify = vi.fn<(item: InboxItem) => void>();
  const notifyMessage = vi.fn<(message: Message) => void>();
  const setBadge = vi.fn<(count: number) => void>();
  return { notifier: createInboxNotifier(handle.db, { notify, notifyMessage, setBadge }), notify, notifyMessage, setBadge };
}

/** An agent asking the human something, optionally with its run parked. */
function askHuman(body: string, options: { blocking?: boolean; itemId?: string } = {}) {
  const targetId = (options.itemId ?? item.id) as Item["id"];
  if (options.blocking) {
    const run = createRun(handle.db, { itemId: targetId, agentId: implementer.id, action: "implement", threadId: "t" });
    updateRun(handle.db, run.id, { status: "awaiting_input" });
  }
  return postComment(handle.db, {
    itemId: targetId,
    author: { type: "agent", agentId: implementer.id },
    body,
    mentions: [{ type: "human" }],
    kind: "escalation",
  });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "todo" });
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
});

afterEach(() => {
  handle.close();
});

describe("the inbox badge", () => {
  it("matches the open-mention count exactly", () => {
    const { notifier, setBadge } = makeNotifier();

    notifier.refresh();
    expect(setBadge).toHaveBeenLastCalledWith(0);

    askHuman("first?");
    askHuman("second?");
    notifier.refresh();
    expect(setBadge).toHaveBeenLastCalledWith(2);

    // Answering clears them — the badge follows the same query as the UI.
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "answered" });
    notifier.refresh();
    expect(setBadge).toHaveBeenLastCalledWith(0);
  });

  it("still updates while Do Not Disturb is on — silencing an alert is not hiding the fact", () => {
    setSetting(handle.db, DND_KEY, true);
    const { notifier, setBadge, notify } = makeNotifier();

    notifier.refresh();
    askHuman("urgent?", { blocking: true });
    notifier.refresh();

    expect(setBadge).toHaveBeenLastCalledWith(1);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("notifications", () => {
  it("fires on a blocking mention", () => {
    const { notifier, notify } = makeNotifier();
    notifier.refresh(); // baseline

    askHuman("Which limit?", { blocking: true });
    notifier.refresh();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]?.body).toBe("Which limit?");
  });

  it("does not fire on an FYI — agents run for hours, and an app that pings on every remark stops being read", () => {
    const { notifier, notify } = makeNotifier();
    notifier.refresh();

    askHuman("just so you know"); // no parked run, so not blocking
    notifier.refresh();

    expect(notify).not.toHaveBeenCalled();
  });

  it("announces a mention once, not on every refresh", () => {
    const { notifier, notify } = makeNotifier();
    notifier.refresh();

    askHuman("Which limit?", { blocking: true });
    notifier.refresh();
    notifier.refresh();
    notifier.refresh();

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not re-announce what was already waiting when the app started", () => {
    // Relaunching with three unanswered questions should not fire three
    // notifications for things you already knew about.
    askHuman("one", { blocking: true });
    askHuman("two", { blocking: true });

    const { notifier, notify, setBadge } = makeNotifier();
    notifier.refresh();

    expect(notify).not.toHaveBeenCalled();
    expect(setBadge).toHaveBeenLastCalledWith(2); // but they are still counted
  });

  it("notifies again if the same question is re-opened after being answered", () => {
    const { notifier, notify } = makeNotifier();
    notifier.refresh();

    askHuman("first ask", { blocking: true });
    notifier.refresh();
    expect(notify).toHaveBeenCalledTimes(1);

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "answered" });
    notifier.refresh();

    askHuman("asking again", { blocking: true });
    notifier.refresh();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe("messages from EO (EO-725)", () => {
  const message = () => sendMessage(handle.db, { recipientId: LOCAL_PERSON_ID, source: "test", body: "Pick one", options: ["Yes", "No"] });

  it("are counted on the badge beside the questions, and leave it once handled", () => {
    const { notifier, setBadge } = makeNotifier();
    askHuman("first?");
    const sent = message();
    notifier.refresh();
    expect(setBadge).toHaveBeenLastCalledWith(2);

    dismissMessageCommand(handle.db, { messageId: sent.id });
    notifier.refresh();
    expect(setBadge).toHaveBeenLastCalledWith(1);
  });

  it("notify once each, and not while Do Not Disturb is on", () => {
    const { notifier, notifyMessage } = makeNotifier();
    notifier.refresh();

    const sent = message();
    notifier.refresh();
    notifier.refresh();
    expect(notifyMessage).toHaveBeenCalledTimes(1);
    expect(notifyMessage.mock.calls[0]?.[0]?.id).toBe(sent.id);
    expect(notificationForMessage(sent)).toEqual({ title: "EO needs you", body: "Pick one" });

    setSetting(handle.db, DND_KEY, true);
    message();
    notifier.refresh();
    expect(notifyMessage).toHaveBeenCalledTimes(1);
  });

  it("do not re-announce what was already open when the app started", () => {
    message();
    const { notifier, notifyMessage, setBadge } = makeNotifier();
    notifier.refresh();
    expect(notifyMessage).not.toHaveBeenCalled();
    expect(setBadge).toHaveBeenLastCalledWith(1);
  });
});

/**
 * `refresh` reads the whole inbox synchronously in main, and every
 * change the engine announces asks for it (EO-557). A burst reads it
 * once a window: the first at once, the last swept up at the end.
 */
describe("a scheduled refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the inbox at most once per window however often it is asked", () => {
    const { notifier, setBadge } = makeNotifier();

    for (let i = 0; i < 10; i++) {
      notifier.scheduleRefresh();
      vi.advanceTimersByTime(10);
    }
    // Ten asks in 100 ms, all inside the first 150 ms window: the leading
    // read, and nothing else until the window closes.
    expect(setBadge).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(150);
    // The trailing sweep, once, for everything that arrived meanwhile.
    expect(setBadge).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1000);
    expect(setBadge).toHaveBeenCalledTimes(2);
  });

  it("reads at once, so a question is notified the moment it is asked", () => {
    const { notifier, notify } = makeNotifier();
    notifier.refresh(); // baseline

    askHuman("which retry policy?", { blocking: true });
    notifier.scheduleRefresh();

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("reads once per window when the engine's item and run pushes both ask for it", () => {
    // The composition startMain wires: every push either announcer sends
    // asks the notifier for a refresh. Each announcer's trailing sweep
    // lands on the same boundary as the notifier's own, so a notifier
    // that closed its window before sweeping read the inbox twice in the
    // same instant there (EO-557 review).
    const { notifier, setBadge } = makeNotifier();
    const readAt: number[] = [];
    setBadge.mockImplementation(() => void readAt.push(Date.now()));
    const { announceItem, announceRun } = createChangeAnnouncers(() => notifier.scheduleRefresh());
    const start = Date.now();

    for (let i = 0; i < 10; i++) {
      announceItem(item.id);
      announceRun("run-1", item.id, i < 9 ? "running" : "succeeded");
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(1000);

    const offsets = readAt.map((at) => at - start);
    expect(offsets.length).toBeGreaterThan(1); // the first at once, and the final state swept up
    expect(offsets[0]).toBe(0);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]! - offsets[i - 1]!, `inbox reads at ${offsets.join(", ")} ms`).toBeGreaterThanOrEqual(150);
    }
  });

  it("still sweeps up a request that arrives as its window closes", () => {
    const { notifier, setBadge } = makeNotifier();

    notifier.scheduleRefresh(); // leading read
    notifier.scheduleRefresh(); // swept at 150
    vi.advanceTimersByTime(150);
    expect(setBadge).toHaveBeenCalledTimes(2);

    askHuman("asked on the boundary?");
    notifier.scheduleRefresh(); // inside the window the sweep opened: waits for its end
    expect(setBadge).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(150);
    expect(setBadge).toHaveBeenCalledTimes(3);
    expect(setBadge).toHaveBeenLastCalledWith(1);
  });

  it("ends a burst on what is true at its end", () => {
    const { notifier, setBadge } = makeNotifier();

    notifier.scheduleRefresh();
    askHuman("first?");
    notifier.scheduleRefresh();
    askHuman("second?");
    notifier.scheduleRefresh();
    expect(setBadge).toHaveBeenLastCalledWith(0);

    vi.advanceTimersByTime(150);
    expect(setBadge).toHaveBeenLastCalledWith(2);
  });
});

describe("everythingBlocked", () => {
  it("is true when every live item is waiting on the human", () => {
    askHuman("Which limit?", { blocking: true });

    expect(listInbox(handle.db).summary.everythingBlocked).toBe(true);
  });

  it("is false while some item could still be worked on", () => {
    createTestItem(handle.db, { type: "story", title: "Free to work on", stepId: "todo" });
    askHuman("Which limit?", { blocking: true });

    expect(listInbox(handle.db).summary.everythingBlocked).toBe(false);
  });

  it("ignores finished items — a project of completed work is not a stalled pipeline", () => {
    createTestItem(handle.db, { type: "story", title: "Done", stepId: "ready_to_merge" });
    askHuman("Which limit?", { blocking: true });

    expect(listInbox(handle.db).summary.everythingBlocked).toBe(true);
  });

  it("is false when nothing is blocked at all", () => {
    expect(listInbox(handle.db).summary.everythingBlocked).toBe(false);
  });
});

describe("inbox items", () => {
  it("marks an item blocking only when its run is parked", () => {
    const other = createTestItem(handle.db, { type: "story", title: "Other", stepId: "todo" });
    askHuman("blocking one", { blocking: true });
    askHuman("fyi one", { itemId: other.id });

    const byBody = new Map(listInbox(handle.db).items.map((item) => [item.body, item.blocking]));
    expect(byBody.get("blocking one")).toBe(true);
    expect(byBody.get("fyi one")).toBe(false);
  });
});

describe("what a job's guard says when it interrupts somebody (EO-306)", () => {
  /** A guard about a job whose name is long enough to push the sentence past any glance. */
  const longGuard = {
    title: "Weekly commercial performance and pipeline review was skipped",
    body: `"Weekly commercial performance and pipeline review for the northern region" was skipped: EO was not open within 3 hours of 08:00. Run it now?`,
  };

  it("delivers the thread's sentence whole, however long it is", () => {
    expect(longGuard.body.length).toBeGreaterThan(140);

    // The requirement is the same text, and this is the case where the
    // two could differ. Truncated at 140 characters what falls off the
    // end is "Run it now?" — the only actionable thing in it — and the
    // reason before it, leaving a notification that says a thing
    // happened and neither what nor what to do.
    expect(notificationForJobGuard(longGuard)).toEqual(longGuard);
    expect(notificationForJobGuard(longGuard).body).toContain("Run it now?");
    expect(notificationForJobGuard(longGuard).body).toContain("was not open within 3 hours");
  });

  it("still truncates an inbox mention, which is somebody else's arbitrary text", () => {
    // The difference is deliberate: an inbox notification carries a
    // comment an agent or a person wrote, of no bounded length, with the
    // item one click away for the rest of it.
    const long = notificationFor({ itemKey: "KAN-1", body: "x".repeat(300) } as InboxItem);

    expect(long.body.length).toBe(140);
    expect(long.body.endsWith("…")).toBe(true);
  });
});

describe("Do Not Disturb", () => {
  it("silences a guard without hiding it", () => {
    expect(shouldInterrupt(handle.db)).toBe(true);

    setSetting(handle.db, DND_KEY, true);

    // The comment is still posted and the mention still counts; only the
    // interruption is withheld. Silencing an alert must not also hide the
    // fact.
    expect(shouldInterrupt(handle.db)).toBe(false);
  });
});
