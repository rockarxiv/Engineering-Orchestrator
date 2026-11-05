import type { Db } from "./db/client.js";
import type { Item } from "@eo/core";
import { getSetting, listItems, listItemsForProject, postComment, setSetting } from "./db/repos/index.js";
import { DEFAULT_GUARD_CONFIG, dailyBudgetDefaultApplies } from "./ipc/configCommands.js";
import { activeProjectId } from "./ipc/repositoryCommands.js";
import { CONVERSATION_SETTINGS_KEY } from "./roles/conversationSteps.js";

/**
 * That the daily-budget notice is settled: said, or never owed.
 *
 * A settings row rather than a scan of every thread, because "has this
 * ever been posted anywhere" is a question about the installation and
 * not about any one item — and because a person deleting a notice they
 * have read must not summon it back.
 *
 * Two things write it. `announceDailyBudgetDefault` writes it once the
 * comment exists, and `settleDailyBudgetNotice` writes it at the birth
 * of a database that never had a day without a ceiling. The second is
 * why a missing row here does not mean "nothing has happened yet": on
 * every installation created by this build or later, something has.
 */
export const DAILY_BUDGET_NOTICE_KEY = "engine.guards.dailyBudgetDefaultAnnounced";

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * What the notice says: the figure, that it was EO's and not theirs, and
 * the one screen that changes it.
 *
 * Exported so the test asserts the words a person reads rather than a
 * paraphrase of them.
 */
export function dailyBudgetDefaultNotice(cents: number): string {
  return [
    `This installation now has a daily spend ceiling of ${cents}¢ (${money(cents)}), across every ticket.`,
    "",
    "It had none before. Nothing saved here said what a day may cost, so EO has applied its own figure rather than leave the day unbounded: once the day's spend reaches it, the run that would pass it stops and asks you to authorise more.",
    "",
    'Settings → Guardrails is where to change it. Clearing "Daily budget" there puts you back where you were — no ceiling at all.',
  ].join("\n");
}

/**
 * A database being created has nothing to be told (EO-211).
 *
 * Called at startup for a database that has never been migrated, which
 * `isNewDatabase` answers in the one moment it can. An installation born
 * under the ceiling has never spent a day without one, so the notice is
 * marked settled before there is anything to say it about — and
 * `announceDailyBudgetDefault` is silent on that installation forever
 * after, without having to ask a question the guards row cannot answer.
 *
 * Every other database reaches the first tick with this unwritten, which
 * is what makes it the upgrade: an installation that predates the
 * default, whether or not anybody ever opened the Guardrails screen.
 */
export function settleDailyBudgetNotice(db: Db): void {
  setSetting(db, DAILY_BUDGET_NOTICE_KEY, true);
}

/**
 * The item the notice hangs on.
 *
 * Nothing about this fact belongs to any one item, and EO has no
 * thread that is not one: comments are the only channel there is
 * (invariant #4), so the notice has to be filed somewhere. What actually
 * carries it to the person is the `@user` mention on it, which puts it
 * in the Inbox as an FYI — the cross-item surface that exists for
 * exactly this, "worth showing, not worth interrupting anyone over".
 *
 * So the choice below is only about which thread the Inbox row points
 * back into, and the newest live item on the active project is the one
 * most likely to be the thing on screen. Conversations are skipped —
 * a room is a chat, and the Inbox deliberately keeps out of them — as
 * are containers with no step, held items (the Inbox drops their rows)
 * and every archived item.
 *
 * Undefined when there is no such item at all. The caller waits rather
 * than posting into the void, and asks again next tick.
 */
function noticeItem(db: Db): Item | undefined {
  const eligible = (items: Item[]): Item[] =>
    items.filter(
      (item) => item.heldAt === null && item.stepId !== null && CONVERSATION_SETTINGS_KEY[item.stepId] === undefined,
    );

  const onProject = eligible(listItemsForProject(db, activeProjectId(db)));
  // Every project, when the active one is empty: an installation with
  // work on a project nobody has switched to yet is still an
  // installation running under a ceiling it never chose.
  const candidates = onProject.length > 0 ? onProject : eligible(listItems(db));

  return candidates.reduce<Item | undefined>(
    (newest, item) =>
      newest === undefined || item.createdAt > newest.createdAt || (item.createdAt === newest.createdAt && item.id > newest.id)
        ? item
        : newest,
    undefined,
  );
}

/**
 * Says, once, that EO gave this installation a daily budget it never
 * asked for (EO-211).
 *
 * Called from every tick and silent on almost all of them. A default
 * that changes what EO will do — this one stops a run — is not something
 * to discover from a run that stopped, which is the whole shape of
 * failure the design built the budgets to avoid; and invariant #8 is that
 * nothing is decided in silence.
 *
 * Once is enforced by the marker rather than by the condition, because
 * the condition stays true forever: `dailyBudgetDefaultApplies` reads a
 * saved config that nothing here rewrites, so it would answer yes on
 * every tick until somebody opened the Guardrails screen. Writing the
 * marker only after a comment exists is what makes "no item to post
 * on yet" a wait instead of a notice nobody ever got.
 *
 * The same marker is what keeps a *fresh* installation quiet, written at
 * the database's birth by `settleDailyBudgetNotice`. Asking the guards
 * row instead — treating "nothing saved" as "nothing to say" — was
 * wrong, and wrong in the direction that matters: an installation
 * somebody has used for a year without ever opening the Guardrails
 * screen has no row either, and it is precisely the one running
 * unbounded that the design wrote the guard for.
 */
export function announceDailyBudgetDefault(db: Db): void {
  if (getSetting<boolean>(db, DAILY_BUDGET_NOTICE_KEY, false)) return;
  if (!dailyBudgetDefaultApplies(db)) return;

  const cents = DEFAULT_GUARD_CONFIG.dailyBudgetCents;
  // Belt and braces: the guard is only interesting while there is a
  // figure to name, and a future default of null would otherwise post a
  // sentence about nothing.
  if (cents === null) return;

  const item = noticeItem(db);
  if (!item) return;

  postComment(db, {
    itemId: item.id,
    author: { type: "engine" },
    kind: "note",
    mentions: [{ type: "human" }],
    body: dailyBudgetDefaultNotice(cents),
  });
  setSetting(db, DAILY_BUDGET_NOTICE_KEY, true);
}
