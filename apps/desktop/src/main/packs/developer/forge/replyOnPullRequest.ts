import { ImplementOutputSchema, parsedResultOf, REPLY_ON_PULL_REQUEST_ACTION, type Run, type Uuid } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { listRunsForItem } from "../../../db/repos/index.js";
import { CLI_FOR, type CliResult, type CliRunner } from "./cli.js";
import { answerOf, decidedPlan, watchAnswers } from "./commentPlans.js";
import {
  changesRequestedNewsId,
  forgeCommentId,
  GITHUB_WATCH_COMMANDS,
  GITLAB_WATCH_COMMANDS,
  markedReplyTo,
  pageOf,
  PAGE_SIZE,
  MAX_PAGES,
  replyMark,
  type PullRequestAddress,
} from "./watchPullRequest.js";

/**
 * Replying on the pull request to each comment EO handled (EO-761).
 *
 * Two halves, as the watch has. `repliesOwed` reads, off the item's runs,
 * what each round the watch answered handed on and what became of it:
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

/**
 * What a reply run has done so far, as it keeps it on its run while it
 * posts: the comments it posted, those they answered, and the answers of
 * the reply it is posting now, or was when the forge refused it — which the
 * forge may hold all the same.
 */
export interface ReplyProgress {
  postedCommentIds: string[];
  repliedTo: string[];
  pending: string[];
}

const objectOf = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

const stringsIn = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

const replyRuns = (runs: readonly Run[]): Run[] => runs.filter((run) => run.action === REPLY_ON_PULL_REQUEST_ACTION);

/**
 * Every comment an earlier reply answered, on any of its runs, whatever
 * became of it — a failed one's, and one EO stopped in the middle of, whose
 * progress is on its run: it posted what it posted.
 */
function alreadyReplied(runs: readonly Run[]): Set<string> {
  return new Set(replyRuns(runs).flatMap((run) => stringsIn(objectOf(run.result?.["raw"])?.["repliedTo"])));
}

/**
 * The comments a reply was being posted to when its run stopped or the
 * forge refused it, and that no reply has answered since. The forge may
 * hold that reply all the same, so before posting again EO looks for it.
 */
export function unsettledReplies(db: Db, itemId: Uuid): string[] {
  const runs = listRunsForItem(db, itemId);
  const done = alreadyReplied(runs);
  return [...new Set(replyRuns(runs).flatMap((run) => stringsIn(objectOf(run.result?.["raw"])?.["pending"])))].filter((id) => !done.has(id));
}

interface Implemented {
  summary: string;
  replies: Map<string, string>;
}

/** The newest implementation after `after` and before `before` (the round's end, or null while it is open), read as the implementer's answer. */
function implementedIn(runs: readonly Run[], after: Uuid, before: Uuid | null): Implemented | undefined {
  for (const run of [...runs].reverse()) {
    if (before !== null && run.id >= before) continue;
    if (run.id <= after) break;
    if (run.action !== "implement" || run.status !== "succeeded") continue;
    const parsed = ImplementOutputSchema.safeParse(parsedResultOf(run.result));
    if (!parsed.success) continue;
    return { summary: parsed.data.summary, replies: new Map((parsed.data.replies ?? []).map((entry) => [entry.comment_id, entry.reply])) };
  }
  return undefined;
}

/** What a reply says for a comment `implemented` acted on, by its id or by its twin's — the request for changes made by the same review. */
const changed =
  (implemented: Implemented) =>
  (id: string) =>
  (twin: string | null): ReplyText => ({ kind: "changed", reply: implemented.replies.get(id) ?? (twin === null ? undefined : implemented.replies.get(twin)) ?? null, summary: implemented.summary });

/**
 * The replies owed on the item's pull request: one for each comment a
 * round the watch answered handed on, that no reply has answered yet.
 *
 * Every round, not only the newest: a round whose replies were not posted —
 * the forge refused, or EO stopped — is owed them still once the watch has
 * answered again, each with what that round's own implementation or
 * rejection said. A round runs from a watch answer other than `waiting` to
 * the next one.
 *
 * A round the person's own comments began (`author_commented`) owes its
 * replies once an implementation follows it within the round. A round
 * handed to planning owes them once the person decided the plan: carried
 * out, for an approved one, or straight away for a rejected one, to every
 * comment the plan covered. Anything else — a first pass with no watch
 * answer at all, an answer that handed nothing on, a round still being
 * planned or implemented, or one that ended without either — owes nothing.
 *
 * A request for changes made by a review that also left a body is one
 * reply, posted to the review's body, rather than two to the same review.
 */
export function repliesOwed(db: Db, itemId: Uuid): OwedReply[] {
  const runs = listRunsForItem(db, itemId);
  const rounds = watchAnswers(runs);
  const textOf = new Map<string, (twin: string | null) => ReplyText>();
  rounds.forEach((round, index) => {
    const before = rounds[index + 1]?.id ?? null;
    const answer = answerOf(round);
    if (answer === "author_commented") {
      const implemented = implementedIn(runs, round.id, before);
      if (implemented === undefined) return;
      for (const id of stringsIn(objectOf(round.result?.["raw"])?.["handled"])) textOf.set(id, changed(implemented)(id));
    } else if (answer === "others_commented" || answer === "changes_requested") {
      const decided = decidedPlan(db, itemId, round.id, before);
      if (decided === undefined) return;
      const ids = decided.plan.comments.map((entry) => entry.comment_id);
      if (decided.approved) {
        const implemented = implementedIn(runs, decided.decidedAt, before);
        if (implemented === undefined) return;
        for (const id of ids) textOf.set(id, changed(implemented)(id));
      } else {
        const rejected: ReplyText = { kind: "rejected", reason: decided.reason };
        for (const id of ids) textOf.set(id, () => rejected);
      }
    }
  });

  const done = alreadyReplied(runs);
  const waiting = [...textOf.keys()].filter((id) => !done.has(id));
  const owed: OwedReply[] = [];
  for (const id of waiting) {
    // GitHub's request for changes is its review: answered with the review's body when that is waiting too.
    const review = id.startsWith("changes-requested:") ? forgeCommentId.review(id.slice("changes-requested:".length)) : null;
    if (review !== null && waiting.includes(review)) continue;
    const twin = id.startsWith("review:") ? changesRequestedNewsId(id.slice("review:".length)) : null;
    const answers = twin !== null && waiting.includes(twin) ? [id, twin] : [id];
    owed.push({ commentId: id, answers, text: textOf.get(id)!(answers[1] ?? null) });
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

/** Every reply ends in its mark, so a reply posted but never recorded can be told for EO's. */
const marked = (body: string, answers: readonly string[]): string => `${body}\n\n${replyMark(answers)}`;

export interface PostRepliesInput {
  address: PullRequestAddress;
  url: string;
  owed: readonly OwedReply[];
  /**
   * Comments a reply was being posted to when an earlier run stopped or was
   * refused (`unsettledReplies`). When there are any, EO first looks on the
   * forge for replies it marked as its own and has no record of, and records
   * them rather than post them again.
   */
  unsettled: readonly string[];
  /** The forge ids of comments EO already recorded posting. */
  ownComments: ReadonlySet<string>;
  run: CliRunner;
  cwd: string;
  signal?: AbortSignal;
  report?: (text: string) => void;
  /**
   * Told the progress each time it changes: before each post, naming the
   * reply in flight as `pending`, and after it, with the comment it posted.
   * The runner keeps it on the run, so a reply posted in a run EO does not
   * live to finish is recorded all the same, or found again by its mark.
   */
  record?: (progress: ReplyProgress) => void;
}

export type PostRepliesOutcome =
  /** `found` counts the replies posted by an earlier run and found again on the forge, which `progress` includes. */
  | { ok: true; headSha: string | null; progress: ReplyProgress; found: number }
  /** What was posted before the forge refused is kept, so it is neither posted again nor read back as the person's. */
  | { ok: false; refused: string; progress: ReplyProgress };

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

const textIn = (value: unknown, field: string): string => {
  const found = objectOf(value)?.[field];
  return typeof found === "string" ? found : "";
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

/** A comment EO may have posted: its id in the watch's spelling, who wrote it, and what. */
interface ForgeComment {
  id: string;
  author: string;
  body: string;
}

/**
 * Posts every owed reply, in order, and stops at the first the forge
 * refuses.
 *
 * The head commit is asked of the forge, since that is what was pushed, and
 * only when a reply names it. A GitHub line comment is answered in its
 * thread, which GitHub only takes a reply to by the thread's first comment:
 * the line comments are listed, when one is answered, to find each one's
 * first — and one that is in none, deleted since, is answered in the
 * conversation instead. On GitLab the discussions are listed the same way,
 * to find the one each note is in.
 *
 * With replies unsettled, the comments where EO's replies go are listed,
 * with the account the CLI is signed in as, and every one by that account
 * carrying EO's mark and not yet recorded is recorded as posted, and what
 * it answered as answered.
 */
export async function postReplies(input: PostRepliesInput): Promise<PostRepliesOutcome> {
  const { address, url } = input;
  const cli = CLI_FOR[address.forge];
  const progress: ReplyProgress = { postedCommentIds: [], repliedTo: [], pending: [] };
  const record = (): void => input.record?.({ postedCommentIds: [...progress.postedCommentIds], repliedTo: [...progress.repliedTo], pending: [...progress.pending] });
  const call = (args: string[]): Promise<CliResult> => input.run(cli, args, input.cwd, input.signal ? { signal: input.signal } : {});
  const refuse = (refused: string): PostRepliesOutcome => ({ ok: false, refused, progress });
  const reconciling = input.unsettled.length > 0;

  let headSha: string | null = null;
  if (input.owed.some((reply) => reply.text.kind === "changed")) {
    const viewed = await call(address.forge === "github" ? GITHUB_WATCH_COMMANDS.view(url) : GITLAB_WATCH_COMMANDS.mergeRequest(address));
    if (!viewed.ok) return refuse(`EO could not read the head commit of ${url}, which the replies name. ${said(cli, viewed)}`);
    const value = objectOf(parseJson(viewed.stdout));
    const sha = value?.[address.forge === "github" ? "headRefOid" : "sha"];
    if (typeof sha !== "string" || sha === "") return refuse(`The forge did not say what the head commit of ${url} is, which the replies name.`);
    headSha = sha;
  }

  /** Every entry of a list, a page at a time, or why not. */
  const listAll = async (argsFor: (page: number) => string[], what: string): Promise<{ ok: true; entries: unknown[] } | { ok: false; refused: string }> => {
    const entries: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const listed = await call(argsFor(page));
      if (!listed.ok) return { ok: false, refused: `EO could not list the ${what} on ${url}. ${said(cli, listed)}` };
      const value = parseJson(listed.stdout);
      if (!Array.isArray(value)) return { ok: false, refused: `\`${cli}\` did not list the ${what} on ${url}.` };
      entries.push(...value);
      if (value.length < PAGE_SIZE) return { ok: true, entries };
    }
    return { ok: false, refused: `${url} has more than ${MAX_PAGES * PAGE_SIZE} ${what}, so EO stopped rather than reply on part of the list.` };
  };

  const targets = input.owed.map((reply) => replyTarget(address, url, reply.commentId));
  /** Where EO may have posted before: every comment of each list read below. */
  const comments: ForgeComment[] = [];
  /** A GitHub line comment's thread, by the id of its first comment; a GitLab note's discussion. */
  const threadOf = new Map<string, string>();

  if (address.forge === "github") {
    if (reconciling || targets.some((target) => target.kind === "thread")) {
      const lines = await listAll((page) => GITHUB_WATCH_COMMANDS.lineComments(address, page), "line comments");
      if (!lines.ok) return refuse(lines.refused);
      for (const line of lines.entries) {
        const id = idIn(line);
        if (id === "") continue;
        const root = objectOf(line)?.["in_reply_to_id"];
        threadOf.set(id, typeof root === "number" || typeof root === "string" ? String(root) : id);
        comments.push({ id: forgeCommentId.lineComment(id), author: textIn(objectOf(line)?.["user"], "login"), body: textIn(line, "body") });
      }
    }
    if (reconciling) {
      const conversation = await listAll((page) => GITHUB_WATCH_COMMANDS.conversationComments(address, page), "conversation comments");
      if (!conversation.ok) return refuse(conversation.refused);
      for (const entry of conversation.entries) {
        if (idIn(entry) !== "") comments.push({ id: forgeCommentId.conversationComment(idIn(entry)), author: textIn(objectOf(entry)?.["user"], "login"), body: textIn(entry, "body") });
      }
    }
  } else if (reconciling || targets.some((target) => target.kind === "discussion")) {
    const discussions = await listAll((page) => REPLY_COMMANDS.gitlabDiscussions(address, page), "discussions");
    if (!discussions.ok) return refuse(discussions.refused);
    for (const discussion of discussions.entries) {
      const id = objectOf(discussion)?.["id"];
      const notes = objectOf(discussion)?.["notes"];
      if (typeof id !== "string" || !Array.isArray(notes)) continue;
      for (const note of notes) {
        if (idIn(note) === "") continue;
        threadOf.set(idIn(note), id);
        comments.push({ id: forgeCommentId.note(idIn(note)), author: textIn(objectOf(note)?.["author"], "username"), body: textIn(note, "body") });
      }
    }
  }

  let found = 0;
  if (reconciling) {
    const viewed = await call(address.forge === "github" ? GITHUB_WATCH_COMMANDS.viewer(address) : GITLAB_WATCH_COMMANDS.viewer(address));
    const viewer = viewed.ok ? textIn(parseJson(viewed.stdout), address.forge === "github" ? "login" : "username") : "";
    if (viewer === "") return refuse(`EO could not read which account \`${cli}\` is signed in as, so it could not tell whether the reply it was posting when it last stopped is on ${url}. ${viewed.ok ? "" : said(cli, viewed)}`.trim());
    for (const comment of comments) {
      const answers = markedReplyTo(comment.body);
      if (answers === null || input.ownComments.has(comment.id) || comment.author.toLowerCase() !== viewer.toLowerCase()) continue;
      progress.postedCommentIds.push(comment.id);
      progress.repliedTo.push(...answers);
      found += 1;
    }
    if (found > 0) {
      input.report?.(`Found ${found} repl${found === 1 ? "y" : "ies"} EO posted before without recording ${found === 1 ? "it" : "them"}.`);
      record();
    }
  }

  for (const reply of input.owed) {
    const answers = reply.answers.filter((id) => !progress.repliedTo.includes(id));
    if (answers.length === 0) continue;
    const body = marked(replyBody(reply.text, headSha ?? ""), answers);
    const target = replyTarget(address, url, reply.commentId);
    let args: string[];
    let spell: (id: string) => string;
    if (address.forge === "github") {
      const root = target.kind === "thread" ? threadOf.get(target.lineCommentId) : undefined;
      if (root !== undefined) {
        args = REPLY_COMMANDS.githubThreadReply(address, root, body);
        spell = forgeCommentId.lineComment;
      } else {
        const link = target.kind === "thread" ? `${pageUrl(url)}#discussion_r${target.lineCommentId}` : target.kind === "conversation" ? target.link : null;
        args = REPLY_COMMANDS.githubConversation(address, conversationBody(link, body));
        spell = forgeCommentId.conversationComment;
      }
    } else {
      const discussion = target.kind === "discussion" ? threadOf.get(target.noteId) : undefined;
      const link = target.kind === "discussion" ? `${pageUrl(url)}#note_${target.noteId}` : target.kind === "conversation" ? target.link : null;
      args = discussion !== undefined ? REPLY_COMMANDS.gitlabDiscussionReply(address, discussion, body) : REPLY_COMMANDS.gitlabNote(address, conversationBody(link, body));
      spell = forgeCommentId.note;
    }
    input.report?.(`Replying to ${reply.commentId}.`);
    progress.pending = answers;
    record();
    const result = await call(args);
    // `pending` stays as it is on a refusal: a forge that answered with an
    // error may have taken the reply all the same, and the next run looks.
    if (!result.ok) return refuse(`The forge refused the reply to ${reply.commentId} on ${url}. ${said(cli, result)}`);
    const id = idIn(parseJson(result.stdout));
    if (id === "") return refuse(`The reply to ${reply.commentId} was posted on ${url}, but the forge did not say its id. The watch knows it for EO's by the mark it carries, and the next reply finds it the same way rather than post it again.`);
    progress.postedCommentIds.push(spell(id));
    progress.repliedTo.push(...answers);
    progress.pending = [];
    record();
  }
  return { ok: true, headSha, progress, found };
}
