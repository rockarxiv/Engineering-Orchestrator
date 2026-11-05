// Pure text parsing — resolving a token to an actual agent/human target
// requires a DB lookup and lives in apps/desktop's commentsRepo instead.

const MENTION_PATTERN = /@([a-zA-Z0-9_-]+)/g;

/** Every `@token` occurring in a comment body, in order, duplicates included. */
export function extractMentionTokens(body: string): string[] {
  return [...body.matchAll(MENTION_PATTERN)].map((match) => match[1]!);
}

/** Case/punctuation-insensitive form used to match a token against agent name/role. */
export function normalizeMentionToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Whether a normalized token addresses this name or role.
 *
 * A pair rather than two `normalizeMentionToken` calls compared by `===`,
 * because that comparison has an edge nobody remembers at the call site:
 * normalizing keeps only `[a-z0-9]`, so anything without a letter or
 * digit in it comes out as the empty string. `@---` normalizes to "", an
 * agent named "•••" normalizes to "", and the two compare equal.
 *
 * Neither half is far-fetched. Agent names and roles are free text — the
 * schema is a bare `z.string()`, so an emoji or a box-drawing name is
 * accepted — and comment bodies contain punctuation runs all the time: a
 * horizontal rule, an em-dash, "@--" as an aside. The result was a run
 * dispatched off a comment that mentions nobody.
 *
 * The empty normalization identifies no one, so it matches no one.
 */
export function mentionMatches(normalizedToken: string, nameOrRole: string): boolean {
  return normalizedToken !== "" && normalizeMentionToken(nameOrRole) === normalizedToken;
}

/**
 * Words that carry no request of their own, and so are dropped before
 * the rest of a comment is read as one (EO-135).
 *
 * Two kinds, deliberately in one list: politeness ("please", "can you")
 * and the scaffolding a short instruction hangs on ("this", "the",
 * "it", "step"). Both are noise for the question being asked here —
 * whether what is left over is a request to run the step again — and
 * separating them would only invite the two lists to disagree.
 *
 * "again" is not here. It is the whole content of "run again", and
 * dropping it would leave a bare "run" that means something else.
 */
const RERUN_FILLER = new Set([
  "a", "and", "can", "could", "hello", "hey", "hi", "it", "just", "kindly",
  "now", "ok", "okay", "one", "please", "pls", "plz", "step", "thanks", "thank",
  "that", "the", "then", "this", "u", "will", "would", "you",
]);

/**
 * The requests EO reads as "run this step again", once filler is gone.
 *
 * An allow-list of exact phrasings rather than "does it contain the
 * word rerun", and the difference is the whole safety of this function.
 * Handing a step back to its agent starts a real run against a real
 * worktree, so a sentence that merely *mentions* rerunning — "@reviewer
 * why did the rerun fail?", "@reviewer rerun the tests and tell me what
 * broke" — must not trigger one. Those keep a content word this list
 * does not have, so they fall through to an ordinary reply, which is
 * the harmless direction to be wrong in.
 */
const RERUN_REQUESTS = new Set([
  "again",
  "go again",
  "redo",
  "rerun",
  "restart",
  "retry",
  "run again",
  "start over",
  "try again",
]);

/**
 * Whether a comment is asking for the current step to be run again.
 *
 * Pure text, like the rest of this file: *who* the request is addressed
 * to and whether that agent owns anything are questions for the caller,
 * which needs the database to answer them. This decides only whether
 * the words are a rerun request at all.
 *
 * Mentions are stripped first, so the agent's name never counts as
 * content — otherwise "@rerun-bot hello" would read as a request.
 */
export function asksToRerun(body: string): boolean {
  const content = body
    .replace(MENTION_PATTERN, " ")
    .toLowerCase()
    // "re-run" and "re run" are the same word typed two other ways, and
    // stripping punctuation on its own would turn the first into the
    // second rather than into "rerun".
    .replace(/\bre[\s-]+run\b/g, "rerun")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word !== "" && !RERUN_FILLER.has(word))
    .join(" ");

  return RERUN_REQUESTS.has(content);
}
