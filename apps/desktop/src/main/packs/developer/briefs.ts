import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { gitStateOf, REVIEW_PLAN_ACTION, WATCH_PULL_REQUEST_ACTION, type ItemBriefPart, type PlanCommentResponseOutput } from "@eo/core";
import type { Db } from "../../db/client.js";
import { getGitWorkspace, listRunsForItem } from "../../db/repos/index.js";
import type { DecisionBriefContext, DecisionBriefRenderer } from "../../ipc/packBriefs.js";
import { createCliRunner, type CliRunner } from "./forge/cli.js";
import { answerOf, commentsAwaitingPlan, currentPlan, latestWatchAnswer, type CommentAwaitingPlan } from "./forge/commentPlans.js";
import { parsePullRequestUrl, readCommentNews, readPullRequest, type PullRequestCheck } from "./forge/watchPullRequest.js";

/**
 * The decisions this pack briefs itself (EO-828, ARCHITECTURE.md, "The
 * decision's brief"): two `user` steps of the software template whose
 * question cannot be answered from the thread as it stands.
 *
 * Each recognises its step by the id the template gives it — on this
 * installation's own step, or through the step map an install records —
 * or by what the step before it runs, so a copy of the step under another
 * id is briefed the same. A step that declares its own brief is never put
 * to either: what a person chose for it wins.
 */

/** The pull request comments board's "Approve plan" step, by its id in the template. */
export const APPROVE_PLAN_STEP = "pr_comments_approve";
/** The Delivery board's "Done" step, by its id in the template. */
export const DONE_STEP = "ready_to_merge";

/** How long the Done brief waits on the forge before saying it could not ask. */
const FORGE_TIMEOUT_MS = 20_000;

const isStep = (context: DecisionBriefContext, id: string): boolean => context.step.id === id || context.templateStepId === id;

const part = (heading: string, body: string, author: string | null = null): ItemBriefPart => ({ show: "computed", heading, body, author, createdAt: null });

const quote = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

/**
 * One comment awaiting a plan, beside what the plan would do about it: who
 * left it, where, what it says, the change proposed and the reply to post.
 * Read off the news the watch posted for it, which is the only record EO
 * keeps of a comment's words.
 */
function commentPart(comment: CommentAwaitingPlan, plan: PlanCommentResponseOutput | null): ItemBriefPart {
  const read = comment.text === null ? null : readCommentNews(comment.text);
  const request = comment.text === null ? null : /^(?:@(\S+)|A reviewer) requested changes\.$/.exec(comment.text);
  const heading = read !== null ? (read.where === null ? "Comment on the pull request" : `Comment on ${read.where}`) : request !== null ? "Request for changes" : `Comment \`${comment.id}\``;
  const author = read !== null ? `@${read.author}` : request?.[1] !== undefined ? `@${request[1]}` : null;

  const said =
    read !== null
      ? [quote(read.body), ...(read.url === null ? [] : [`[Open it on the forge](${read.url})`])].join("\n\n")
      : request !== null
        ? "Changes were requested on the pull request."
        : comment.text === null
          ? "EO recorded no text for this one. Read it on the pull request, where its forge id says which it is."
          : quote(comment.text);

  const entry = plan?.comments.find((each) => each.comment_id === comment.id);
  const planned =
    plan === null
      ? ["**Planned reply:** No plan has been made yet."]
      : entry === undefined
        ? ["**Planned reply:** The plan has none for this comment."]
        : [`**Planned change:** ${entry.change ?? "None — no change is proposed."}`, `**Planned reply:** ${entry.reply}`];
  return part(heading, [said, ...planned].join("\n\n"), author);
}

/**
 * "Approve plan": every pull request comment awaiting a plan, each beside
 * the reply planned for it — what `commentPlans.ts` gives the planner and
 * the plan's reviewer, laid out for the person who approves it.
 *
 * Null, and the default shown, on an item with nothing to plan for and no
 * plan, which is not a decision about pull request comments at all.
 */
export function approvePlanBrief(db: Db): DecisionBriefRenderer {
  return {
    id: "developer:approve-plan",
    render: (context) => {
      if (context.step.type !== "user") return null;
      if (!isStep(context, APPROVE_PLAN_STEP) && context.cameFrom?.action !== REVIEW_PLAN_ACTION) return null;
      const awaiting = commentsAwaitingPlan(db, context.item.id);
      const plan = currentPlan(db, context.item.id)?.plan ?? null;
      if (awaiting.length === 0 && plan === null) return null;
      return [
        part("The plan", plan === null ? "EO has no plan on record for these comments yet." : plan.summary),
        ...(awaiting.length === 0 ? [part("Comments awaiting a plan", "No pull request comment is awaiting a plan.")] : awaiting.map((comment) => commentPart(comment, plan))),
      ];
    },
  };
}

const STATE_WORDS = { open: "Open", merged: "Merged", closed: "Closed without being merged" } as const;

function checksLine(checks: readonly PullRequestCheck[]): string {
  if (checks.length === 0) return "**Checks:** none reported.";
  const count = (state: PullRequestCheck["state"]) => checks.filter((check) => check.state === state).length;
  const tally = [`${count("failed")} failed`, `${count("pending")} still running`, `${count("passed")} passed`].filter((each) => !each.startsWith("0 "));
  const summary = count("passed") === checks.length ? `all ${checks.length} passed` : tally.join(", ");
  const list = checks.map((check) => `- ${check.url === null ? check.name : `[${check.name}](${check.url})`}: ${check.state === "pending" ? "running" : check.state}`);
  return [`**Checks:** ${summary}.`, "", ...list].join("\n");
}

/**
 * "Done": the pull request the item's approval closes — its link, whether
 * it is merged or still open, and its checks — asked of the forge when
 * somebody opens the brief, through the same `gh` or `glab` the watch uses.
 *
 * Where the forge cannot be asked, the link is still shown, with what the
 * watch last saw of it and why the rest is missing. Null on an item with
 * no pull request, which is briefed by default.
 */
export function donePullRequestBrief(db: Db, run: CliRunner = createCliRunner(FORGE_TIMEOUT_MS)): DecisionBriefRenderer {
  return {
    id: "developer:done-pull-request",
    render: async (context) => {
      if (context.step.type !== "user") return null;
      if (!isStep(context, DONE_STEP) && context.cameFrom?.action !== WATCH_PULL_REQUEST_ACTION) return null;
      const { item } = context;
      const url = gitStateOf(item).pullRequest;
      if (!url) return null;

      const link = `[${url}](${url})`;
      const workspace = item.workspaceId === null ? undefined : getGitWorkspace(db, item.workspaceId);
      const address = parsePullRequestUrl(url, workspace?.config.forgeKind ?? null);
      const lastSeen = (): string => {
        const answer = latestWatchAnswer(listRunsForItem(db, item.id));
        const said = answer === undefined ? null : answerOf(answer);
        return said === "merged" ? "Merged, when EO last checked." : said === "closed" ? "Closed without being merged, when EO last checked." : "Not known: EO has not seen it merged.";
      };
      if (address === null) {
        return [part("Pull request", [link, `**State:** ${lastSeen()}`, "**Checks:** not known — EO cannot tell which forge this address is on."].join("\n\n"))];
      }

      const repoPath = workspace?.config.repoPath;
      const cwd = repoPath !== undefined && existsSync(repoPath) ? repoPath : tmpdir();
      const reading = await readPullRequest({ address, url, run, cwd, signal: AbortSignal.timeout(FORGE_TIMEOUT_MS) });
      if (!reading.ok) {
        return [part("Pull request", [link, `**State:** ${lastSeen()}`, `**Checks:** not known — EO could not ask the forge. ${reading.reason}`].join("\n\n"))];
      }
      const { snapshot } = reading;
      return [part("Pull request", [link, `**State:** ${STATE_WORDS[snapshot.state]}.`, checksLine(snapshot.checks)].join("\n\n"))];
    },
  };
}

/** Both, in the order they are asked. */
export function developerBriefRenderers(db: Db, run?: CliRunner): DecisionBriefRenderer[] {
  return [approvePlanBrief(db), donePullRequestBrief(db, run)];
}
