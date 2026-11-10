import type { InboxItem, Message } from "@eo/core";
import { CHANGE_PUSH_WINDOW_MS } from "./changeAnnouncers.js";
import { coalescePerKey } from "./coalesce.js";
import type { Db } from "./db/client.js";
import { getSetting } from "./db/repos/index.js";
import { listInbox } from "./ipc/domainQueries.js";
import { DND_KEY } from "./ipc/domainCommands.js";

export interface NotifierDeps {
  /**
   * Where a notification is actually shown.
   *
   * Required since KAN-127: showing one is the machine's job, so it
   * arrives from the `Platform` the composition root built rather than
   * from a `new Notification` default here. `notificationFor` below is
   * what it should say — the wording stays in this file, which is the
   * file about what interrupts somebody and when.
   */
  notify: (item: InboxItem) => void;
  /**
   * Where a message EO sent the person is shown (EO-725). Its own
   * callback because a message has no item to open: clicking one opens
   * the Inbox, where it is answered.
   */
  notifyMessage: (message: Message) => void;
  /**
   * Where the count of what is waiting is shown — the dock or taskbar
   * badge under Electron.
   *
   * Required since EO-318, where it stopped being optional with an
   * `app.setBadgeCount` default behind it: this file was the last one
   * outside `platform/` to name Electron, and the badge is a fact about
   * the machine exactly as showing a notification is. A platform with
   * nothing to badge passes a no-op and says so there, rather than this
   * file deciding on its behalf.
   */
  setBadge: (count: number) => void;
  /** How long `scheduleRefresh` collapses a burst for. `CHANGE_PUSH_WINDOW_MS` unless a test says otherwise. */
  refreshWindowMs?: number;
}

/**
 * What a blocking mention says when it interrupts somebody.
 *
 * Exported because the delivery moved to the platform and the wording
 * did not: index.ts composes the two, and a second implementation of
 * `Platform` shows the same sentence rather than inventing its own.
 */
export function notificationFor(item: InboxItem): { title: string; body: string } {
  return {
    title: `${item.itemKey} needs you`,
    // The item is one click away for the rest of it.
    body: truncateForGlance(item.body),
  };
}

/**
 * What a message from EO says when it interrupts somebody (EO-725).
 * Truncated like a mention: the Inbox is one click away for the rest.
 */
export function notificationForMessage(message: Message): { title: string; body: string } {
  return { title: "EO needs you", body: truncateForGlance(message.body) };
}

/**
 * What a job's guard says when it interrupts somebody (EO-306,
 * `ARCHITECTURE.md`, "Schedules, and a machine that was off").
 *
 * **The same sentence the thread was told, whole.** The notification is
 * a second delivery of one message rather than a summary of it: a person
 * who reads "EO was not open within 3 hours of 08:00. Run it now?" on a
 * lock screen and then opens the thread should find the words they
 * already read.
 *
 * So this deliberately does *not* truncate, where `notificationFor`
 * above does, and the difference is not an oversight. An inbox
 * notification carries a comment somebody else wrote — arbitrary length,
 * with the item one click away for the rest of it. A guard carries a
 * sentence EO composed, whose last clause is the only actionable thing
 * in it: cut a guard about a job with a long name at 140 characters and
 * what falls off the end is the reason it was skipped and the offer to
 * run it, leaving a notification that says a thing happened and not what
 * or what to do. The OS elides what will not fit on its own, and it does
 * so knowing the width of the screen, which is not a fact available here.
 *
 * Here rather than in `jobs/catchUp.ts` because this is the file about
 * what interrupts somebody and how it reads; the delivery is the
 * platform's (KAN-127) and the wording has stayed here.
 */
export function notificationForJobGuard(guard: { title: string; body: string }): { title: string; body: string } {
  return { title: guard.title, body: guard.body };
}

/**
 * Whether a guard should interrupt at all.
 *
 * Do Not Disturb suppresses the notification and nothing else — the
 * comment is posted, the mention is open and the badge counts it,
 * exactly as `createInboxNotifier` has it. Silencing an alert must not
 * also hide the fact.
 */
export function shouldInterrupt(db: Db): boolean {
  return !getSetting(db, DND_KEY, false);
}

/** Truncated rather than wrapped: a notification is a glance. */
function truncateForGlance(body: string): string {
  return body.length > 140 ? `${body.slice(0, 139)}…` : body;
}

/**
 * Watches the inbox and tells the human when something needs them
 * (U-04).
 *
 * The rules that matter:
 *
 * - Only *blocking* mentions notify. An FYI is worth showing in the
 *   inbox and not worth interrupting anyone over; agents run for hours
 *   unattended, and an app that pings on every remark stops being read.
 * - Each mention notifies at most once, tracked by comment id. Polling
 *   would otherwise re-announce the same unanswered question forever,
 *   which is how people learn to ignore notifications.
 * - The badge shows *all* open mentions, blocking or not, because it is
 *   a count of what is waiting rather than an interruption.
 * - Do Not Disturb suppresses the notification only. The badge still
 *   updates — silencing an alert should not also hide the fact.
 * - Every open message EO sent the person notifies, once, by message id
 *   (EO-725): a message exists only because EO needs them to answer or
 *   act, so there is no FYI kind of one.
 */
export function createInboxNotifier(db: Db, deps: NotifierDeps) {
  const announced = new Set<string>();
  let primed = false;

  const { notify, notifyMessage, setBadge } = deps;

  function refresh(): void {
    const { items, messages, summary } = listInbox(db);
    setBadge(summary.openCount);

    const doNotDisturb = getSetting(db, DND_KEY, false);

    // Never a preview (EO-313, ARCHITECTURE.md, "Preview"). The badge above already leaves one
    // out — `openCount` counts the real rows — and a toast that fired
    // anyway would be the louder half of the same interruption, over an
    // item EO has just told this person is not real and cost nothing.
    // The row is still in the inbox and the card is still on the board,
    // which is where somebody watching a preview is already looking.
    for (const item of items.filter((entry) => entry.blocking && !entry.preview)) {
      if (announced.has(item.commentId)) continue;
      announced.add(item.commentId);
      // On the first pass we only record what already exists: relaunching
      // with three unanswered questions should not fire three
      // notifications for things you already knew about.
      if (primed && !doNotDisturb) notify(item);
    }

    for (const message of messages) {
      if (announced.has(message.id)) continue;
      announced.add(message.id);
      if (primed && !doNotDisturb) notifyMessage(message);
    }

    // Forget answered mentions and handled messages so a re-opened one
    // can notify again, and so the set doesn't grow without bound.
    const open = new Set([...items.map((item) => item.commentId), ...messages.map((message) => message.id)]);
    for (const id of announced) {
      if (!open.has(id)) announced.delete(id);
    }

    primed = true;
  }

  // `refresh` reads the whole inbox — every item twice, and per open
  // mention its item and its runs — synchronously, on the event loop
  // that also answers the window. Every change the engine announces
  // asks for it, and a run ending announces several (EO-557). So the
  // engine's path is coalesced: leading edge, so a question is
  // notified the moment it is asked; a trailing sweep, so the last
  // change of a burst is the one the badge ends up showing. One key for
  // all of it, because the inbox is one read whichever item changed.
  const scheduled = coalescePerKey(deps.refreshWindowMs ?? CHANGE_PUSH_WINDOW_MS, () => refresh());

  return {
    /** Reads the inbox now. The baseline at startup, which has to be in place before anything else is announced. */
    refresh,
    /** Reads the inbox at most once per window however often it is asked — what a change in the domain calls. */
    scheduleRefresh: (): void => scheduled("inbox"),
  };
}
