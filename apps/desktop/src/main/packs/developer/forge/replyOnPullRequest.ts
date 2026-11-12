import { ImplementOutputSchema, parsedResultOf, REPLY_ON_PULL_REQUEST_ACTION, type Run, type Uuid } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { listRunsForItem } from "../../../db/repos/index.js";
import { CLI_FOR, type CliResult, type CliRunner } from "./cli.js";
import { answerOf, approvedPlan, latestWatchAnswer, rejectedPlan } from "./commentPlans.js";
import { changesRequestedNewsId, forgeCommentId, GITHUB_WATCH_COMMANDS, GITLAB_WATCH_COMMANDS, pageOf, PAGE_SIZE, MAX_PAGES, type PullRequestAddress } from "./watchPullRequest.js";

/**
 * Replying on the pull request to each comment EO handled (EO-761).
 *
 * Two halves, as the watch has. `repliesOwed` reads, off the item's runs,
 * what the round the watch last answered handed on and what became of it:
 * what the implementer said it changed, or the reason a person gave for
 * rejecting the plan. `postReplies` posts each on the forge, through the
 * same `gh` and `glab` the watch reads with, and says the forge id of every
 * comment it posted, so the watch never reads EO's own reply back as the
 * person's comment: it is posted under the very account the watch takes for
 * the person.
 */

/** What a reply says, before EO knows the commit it names. */
export type ReplyText =
  /** The implementer acted on it: its sentence for this comment, or null where it gave none, and its summary of the run. */
  | { kind: "changed"; reply: string | null; summary: string }
  /** A person rejected the plan for it: their reason, exactly as written, or null where they gave none. */
  | { kind: "rejected"; reason: string | null };

/** One reply owed: the comment it is posted in answer to, every handled id it answers, and what it says. */
export interface OwedReply {
  /** The id, in the watch's spelling, of the comment the reply goes to. */
  commentId: string;
  /** The handled ids it answers: the comment's, and a request for changes made by the same review. */
  answers: string[];
  text: ReplyText;
}

const objectOf = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

const stringsIn = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

/** Every comment an earlier reply answered, on any of its runs, a failed one's included: it posted what it posted. */
function alreadyReplied(runs: readonly Run[]): Set<string> {
  return new Set(runs.filter((run) => run.action === REPLY_ON_PULL_REQUEST_ACTION).flatMap((run) => stringsIn(objectOf(run.result?.["raw"])?.["repliedTo"])));
}

/** The newest implementation since `since`, read as the implementer's answer. */
function implementedSince(runs: readonly Run[], since: Uuid): { summary: string; replies: Map<string, string> } | undefined {
  for (const run of [...runs].reverse()) {
    if (run.id <= since) break;
    if (run.action !== "implement" || run.status !== "succeeded") continue;
    const parsed = ImplementOutputSchema.safeParse(parsedResultOf(run.result));
    if (!parsed.success) continue;
    return { summary: parsed.data.summary, replies: new Map((parsed.data.replies ?? []).map((entry) => [entry.comment_id, entry.reply])) };
  }
  return undefined;
}

/**
 * The replies owed on the item's pull request: one for each comment the
 * round the watch last answered handed on, that no earlier reply answered.
 *
 * A round the person's own comments began (`author_commented`) owes its
 * replies once an implementation follows it. A round handed to planning
 * owes them once the person decided the plan: carried out, for an approved
 * one, or straight away for a rejected one, to every comment the plan
 * covered. Anything else — a first pass with no watch answer at all, an
 * answer that handed nothing on, a round still being planned or implemented
 * — owes nothing.
 *
 * A request for changes made by a review that also left a body is one
 * reply, posted to the review's body, rather than two to the same review.
 */
export function repliesOwed(db: Db, itemId: Uuid): OwedReply[] {
  const runs = listRunsForItem(db, itemId);
  const round = latestWatchAnswer(runs);
  if (round === undefined) return [];
  const answer = answerOf(round);

  const changed =
    (implemented: { summary: string; replies: Map<string, string> }) =>
    (id: string, twin: string | null): ReplyText => ({ kind: "changed", reply: implemented.replies.get(id) ?? (twin === null ? undefined : implemented.replies.get(twin)) ?? null, summary: implemented.summary });
  let ids: string[];
  let textFor: (id: string, twin: string | null) => ReplyText;
  if (answer === "author_commented") {
    const implemented = implementedSince(runs, round.id);
    if (implemented === undefined) return [];
    ids = stringsIn(objectOf(round.result?.["raw"])?.["handled"]);
    textFor = changed(implemented);
  } else if (answer === "others_commented" || answer === "changes_requested") {
    const approved = approvedPlan(db, itemId);
    const rejected = approved === undefined ? rejectedPlan(db, itemId) : undefined;
    if (approved !== undefined) {
      const implemented = implementedSince(runs, approved.run.id);
      if (implemented === undefined) return [];
      ids = approved.plan.comments.map((entry) => entry.comment_id);
      textFor = changed(implemented);
    } else if (rejected !== undefined) {
      ids = rejected.plan.comments.map((entry) => entry.comment_id);
      textFor = () => ({ kind: "rejected", reason: rejected.reason });
    } else {
      return [];
    }
  } else {
    return [];
  }

  const done = alreadyReplied(runs);
  const waiting = [...new Set(ids)].filter((id) => !done.has(id));
  const owed: OwedReply[] = [];
  for (const id of waiting) {
    // GitHub's request for changes is its review: answered with the review's body when that is waiting too.
    const review = id.startsWith("changes-requested:") ? forgeCommentId.review(id.slice("changes-requested:".length)) : null;
    if (review !== null && waiting.includes(review)) continue;
    const twin = id.startsWith("review:") ? changesRequestedNewsId(id.slice("review:".length)) : null;
    const answers = twin !== null && waiting.includes(twin) ? [id, twin] : [id];
    owed.push({ commentId: id, answers, text: textFor(id, answers[1] ?? null) });
  }
  return owed;
}

/** What a reply says on the forge, once the head commit is known. */
export function replyBody(text: ReplyText, headSha: string): string {
  if (text.kind === "rejected") return text.reason ?? "The person EO works for decided not to act on this comment, and gave no reason.";
  if (text.reply !== null) return `${text.reply}\n\nPushed in ${headSha}.`;
  return `Addressed in ${headSha}: ${text.summary}`;
}

/** Where a reply goes: a line comment's own thread, a GitLab note's discussion, or the conversation, linking to what it answers. */
export type ReplyTarget =
  | { kind: "thread"; lineCommentId: string }
  | { kind: "discussion"; noteId: string }
  | { kind: "conversation"; link: string | null };

/** The pull request's own address, without anything after it. */
const pageUrl = (url: string): string => url.trim().replace(/[?#].*$/, "");

export function replyTarget(address: PullRequestAddress, url: string, commentId: string): ReplyTarget {
  const [kind = "", ...rest] = commentId.split(":");
  const id = rest.join(":");
  const page = pageUrl(url);
  if (address.forge === "github") {
    if (kind === "review-comment") return { kind: "thread", lineCommentId: id };
    if (kind === "issue-comment") return { kind: "conversation", link: `${page}#issuecomment-${id}` };
    if (kind === "review" || (kind === "changes-requested" && /^\d+$/.test(id))) return { kind: "conversation", link: `${page}#pullrequestreview-${id}` };
    return { kind: "conversation", link: null };
  }
  if (kind === "note") return { kind: "discussion", noteId: id };
  const note = kind === "changes-requested" ? /^note-(\d+)$/.exec(id)?.[1] : undefined;
  return { kind: "conversation", link: note === undefined ? null : `${page}#note_${note}` };
}

/** A conversation comment says which comment it answers, and a request for changes with no comment of its own is named as one. */
function conversationBody(link: string | null, body: string): string {
  return `${link === null ? "In reply to the request for changes" : `In reply to ${link}`}:\n\n${body}`;
}

export interface PostRepliesInput {
  address: PullRequestAddress;
  url: string;
  owed: readonly OwedReply[];
  run: CliRunner;
  cwd: string;
  signal?: AbortSignal;
  report?: (text: string) => void;
}

export type PostRepliesOutcome =
  | { ok: true; headSha: string | null; posted: string[]; repliedTo: string[] }
  /** What was posted before the forge refused is kept, so it is neither posted again nor read back as the person's. */
  | { ok: false; refused: string; posted: string[]; repliedTo: string[] };

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const idIn = (value: unknown): string => {
  const id = objectOf(value)?.["id"];
  return typeof id === "number" || typeof id === "string" ? String(id) : "";
};

const said = (cli: string, result: CliResult): string =>
  result.notFound ? `\`${cli}\` is not installed, or is not on EO's PATH.` : `\`${cli}\` said: ${result.error.trim() || result.stdout.trim() || "nothing"}`;

/** The argv for each question and post `reply_on_pull_request` sends. */
export const REPLY_COMMANDS = {
  githubThreadReply: (address: Extract<PullRequestAddress, { forge: "github" }>, lineCommentId: string, body: string): string[] =>
    ["api", "--hostname", address.host, "--method", "POST", `repos/${address.owner}/${address.repo}/pulls/${address.number}/comments/${lineCommentId}/replies`, "-f", `body=${body}`],
  githubConversation: (address: Extract<PullRequestAddress, { forge: "github" }>, body: string): string[] =>
    ["api", "--hostname", address.host, "--method", "POST", `repos/${address.owner}/${address.repo}/issues/${address.number}/comments`, "-f", `body=${body}`],
  gitlabDiscussions: (address: Extract<PullRequestAddress, { forge: "gitlab" }>, page: number): string[] =>
    ["api", "--hostname", address.host, pageOf(`projects/${encodeURIComponent(address.project)}/merge_requests/${address.iid}/discussions`, page)],
  gitlabDiscussionReply: (address: Extract<PullRequestAddress, { forge: "gitlab" }>, discussionId: string, body: string): string[] =>
    ["api", "--hostname", address.host, "--method", "POST", `projects/${encodeURIComponent(address.project)}/merge_requests/${address.iid}/discussions/${discussionId}/notes`, "-f", `body=${body}`],
  gitlabNote: (address: Extract<PullRequestAddress, { forge: "gitlab" }>, body: string): string[] =>
    ["api", "--hostname", address.host, "--method", "POST", `projects/${encodeURIComponent(address.project)}/merge_requests/${address.iid}/notes`, "-f", `body=${body}`],
};

/**
 * Posts every owed reply, in order, and stops at the first the forge
 * refuses.
 *
 * The head commit is asked of the forge, since that is what was pushed, and
 * only when a reply names it. On GitLab the discussions are listed once, and
 * only when a note is answered, to find the one each note is in; a note
 * that is in none — deleted since — is answered in the conversation instead.
 */
export async function postReplies(input: PostRepliesInput): Promise<PostRepliesOutcome> {
  const { address, url, owed } = input;
  const cli = CLI_FOR[address.forge];
  const posted: string[] = [];
  const repliedTo: string[] = [];
  const call = (args: string[]): Promise<CliResult> => input.run(cli, args, input.cwd, input.signal ? { signal: input.signal } : {});
  const refuse = (refused: string): PostRepliesOutcome => ({ ok: false, refused, posted, repliedTo });

  let headSha: string | null = null;
  if (owed.some((reply) => reply.text.kind === "changed")) {
    const viewed = await call(address.forge === "github" ? GITHUB_WATCH_COMMANDS.view(url) : GITLAB_WATCH_COMMANDS.mergeRequest(address));
    if (!viewed.ok) return refuse(`EO could not read the head commit of ${url}, which the replies name. ${said(cli, viewed)}`);
    const value = objectOf(parseJson(viewed.stdout));
    const sha = value?.[address.forge === "github" ? "headRefOid" : "sha"];
    if (typeof sha !== "string" || sha === "") return refuse(`The forge did not say what the head commit of ${url} is, which the replies name.`);
    headSha = sha;
  }

  const discussionOf = new Map<string, string>();
  if (address.forge === "gitlab" && owed.some((reply) => replyTarget(address, url, reply.commentId).kind === "discussion")) {
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) return refuse(`${url} has more than ${MAX_PAGES * PAGE_SIZE} discussions, so EO stopped looking for the ones to reply in.`);
      const listed = await call(REPLY_COMMANDS.gitlabDiscussions(address, page));
      if (!listed.ok) return refuse(`EO could not list the discussions on ${url} to reply in. ${said(cli, listed)}`);
      const discussions = parseJson(listed.stdout);
      if (!Array.isArray(discussions)) return refuse(`\`${cli}\` did not list the discussions on ${url}, so EO could not find where to reply.`);
      for (const discussion of discussions) {
        const id = objectOf(discussion)?.["id"];
        const notes = objectOf(discussion)?.["notes"];
        if (typeof id !== "string" || !Array.isArray(notes)) continue;
        for (const note of notes) discussionOf.set(idIn(note), id);
      }
      if (discussions.length < PAGE_SIZE) break;
    }
  }

  for (const reply of owed) {
    const body = replyBody(reply.text, headSha ?? "");
    const target = replyTarget(address, url, reply.commentId);
    let args: string[];
    let spell: (id: string) => string;
    if (address.forge === "github") {
      if (target.kind === "thread") {
        args = REPLY_COMMANDS.githubThreadReply(address, target.lineCommentId, body);
        spell = forgeCommentId.lineComment;
      } else {
        args = REPLY_COMMANDS.githubConversation(address, conversationBody(target.kind === "conversation" ? target.link : null, body));
        spell = forgeCommentId.conversationComment;
      }
    } else {
      const discussion = target.kind === "discussion" ? discussionOf.get(target.noteId) : undefined;
      const link = target.kind === "discussion" ? `${pageUrl(url)}#note_${target.noteId}` : target.kind === "conversation" ? target.link : null;
      args = discussion !== undefined ? REPLY_COMMANDS.gitlabDiscussionReply(address, discussion, body) : REPLY_COMMANDS.gitlabNote(address, conversationBody(link, body));
      spell = forgeCommentId.note;
    }
    input.report?.(`Replying to ${reply.commentId}.`);
    const result = await call(args);
    if (!result.ok) return refuse(`The forge refused the reply to ${reply.commentId} on ${url}. ${said(cli, result)}`);
    const id = idIn(parseJson(result.stdout));
    // Posted, but under an id nobody knows: the watch would read it back
    // as the person's own comment. Said, so a person can delete it.
    if (id === "") return refuse(`The reply to ${reply.commentId} was posted on ${url}, but the forge did not say its id, so EO cannot tell it from the person's own comments. Delete it on the forge.`);
    posted.push(spell(id));
    repliedTo.push(...reply.answers);
  }
  return { ok: true, headSha, posted, repliedTo };
}
