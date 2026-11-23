import { SuggestionAnswerSchema, type SuggestionFilterRule } from "@eo/core";

/**
 * A suggested next message, made by EO itself where the backend makes
 * none (EO-808): the prompt sent on a copy of the turn just finished, and
 * the JSON (EO-894), clean-up and filters its answer goes through before
 * anybody sees it.
 *
 * Kept together and apart from any adapter so both can be read, and
 * tested, in one place. Only the Codex adapter uses them today: Claude's
 * backend makes its own suggestion (`promptSuggestions`, EO-807).
 *
 * The wording is EO's own. Claude Code's prompt follows the same rules
 * but is Anthropic's, all rights reserved, and EO is Apache-2.0.
 */

/**
 * What the copy is sent: predict the person's next message, or say
 * nothing, answered as `SuggestionAnswerSchema`'s JSON with null for
 * nothing (EO-894). Kept under 4,000 bytes: the 0.167.1 CLI refuses a
 * longer `thread/sample` prompt.
 */
export const PROMPT_SUGGESTION_PROMPT = `[EO: suggest the person's next message]

This is not a message from the person, and nothing you write here is shown to them as yours. Do not call any tool: every call on this turn is refused.

Read the conversation so far and predict the very next message the person would type into this chat themselves. Not what you think they ought to do next: what they would most likely send.

- When your last answer offered choices, give the one the person would most likely pick.
- When your last answer asked whether to go on, answer as they would: "yes" or "go ahead".
- When your last answer reported an error, or you and the person misunderstood each other, give nothing.
- When the next step is not obvious, or the subject is sensitive (credentials, a security incident, somebody's private data), give nothing.

Write it the way the person writes, in 2 to 12 words and one sentence at most. Never thank or praise, never ask a question, never speak as the assistant ("Let me…", "I'll…"), and never bring up anything the person has not raised.

Answers that fit: "file it on Delivery", "publish the draft", "approve the proposal", "run the tests", "yes".

Return only JSON matching this schema, with nothing before or after it:

{ "suggestion": string | null }

Put the message in "suggestion" as the person would type it: no quotes around it, no label, no explanation. When there is nothing to suggest, "suggestion" is null.`;

/**
 * How many tokens the turn's last request may have spent uncached, input
 * and output together, for a suggestion to be made after it: Claude
 * Code's threshold. Past it, and with less of the request read from the
 * cache than not, the thread is not in the prompt cache and the fork
 * would pay for all of it again (`lastRequestMostlyUncached`).
 */
export const SUGGESTION_MAX_UNCACHED_TOKENS = 10_000;

/**
 * Whether the turn's last request was mostly uncached (EO-808, EO-810):
 * more than `SUGGESTION_MAX_UNCACHED_TOKENS` spent outside the cache,
 * and more than it read from the cache.
 *
 * Both, not the count alone. A turn whose tools answer at length sends
 * the answers on its next request, uncached because nothing has sent
 * them before, however warm the thread is: ASK-78's "give me your
 * recommendation" turn read two skills over `eo_admin`, and its last
 * request was 10,786 tokens uncached beside 103,040 read from the cache.
 * A count alone took that for a cold cache and made no suggestion.
 */
export function lastRequestMostlyUncached(request: { uncachedTokens: number; cachedTokens: number }): boolean {
  return request.uncachedTokens > SUGGESTION_MAX_UNCACHED_TOKENS && request.uncachedTokens > request.cachedTokens;
}

/**
 * How many completed turns the thread must hold, the one just finished
 * included, for a suggestion to be made after it: none after the first
 * answer, as Claude Code makes none. Counted from the thread itself
 * (`thread/turns/list`), so a turn that failed or was interrupted is not
 * one, and a thread opened before EO last started counts all the same.
 */
export const SUGGESTION_MIN_COMPLETED_TURNS = 2;

/**
 * How long a suggestion may take before it is given up (EO-808): the
 * 30 seconds Claude's CLI gives an in-flight suggestion once its turn is
 * over. A caller reading past the turn's result waits no longer than
 * this for one, however the fork is getting on.
 */
export const SUGGESTION_TIMEOUT_MS = 30_000;

/**
 * The share of a usage window, 0–100, at which the account counts as near
 * its limit and no suggestion is made. Codex reports how much of each
 * window is used and never warns, so "near" is EO's line, drawn here; a
 * window at 100 is refused outright.
 */
export const SUGGESTION_NEAR_LIMIT_PERCENT = 90;

/** The one-word answers a person sends that are suggestions all the same. */
const ONE_WORD_ANSWERS = new Set(["yes", "yeah", "yep", "sure", "ok", "okay", "continue", "push", "commit", "deploy", "stop", "no"]);

/** Said about having nothing to say, rather than a message. */
const META_REPLIES = [/nothing to suggest/i, /no suggestion/i, /^(stay(ing)? )?silen(ce|t)\b/i, /^none\b/i, /^nothing\b/i, /^n\/a\b/i];

/** An error the backend reported, answered as though it were the message. */
const API_ERROR = /^(api error|error\b|an error occurred|request (failed|timed out)|internal server error)/i;

/** Thanks and praise, wherever they are. */
const PRAISE = /\b(thanks|thank you|thx|looks good|lgtm|perfect|great|awesome|excellent|amazing|brilliant|well done|good job|nice work|nice job|love it)\b/i;

/** The assistant's own voice, at the start: a person does not write these. */
const AGENT_VOICE =
  /^(?:(?:let me|i'll|i will|i've|i have|i'm|i am|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|you might|of course|certainly|absolutely)\b|sure,)/i;

/** A whole answer wrapped in one tag, as `<suggestion>…</suggestion>`. */
const WRAPPING_TAG = /^<([A-Za-z][\w-]*)[^>]*>([\s\S]*)<\/\1\s*>$/;

/** A label in front of the answer, as `Suggestion:`. */
const LEADING_LABEL = /^(suggested (reply|message|next message)|suggestion|next message|reply|prediction)\s*:\s*/i;

/**
 * The suggestion a fork answered, cleaned up, or null where the answer
 * is to be dropped. Cleaned of a wrapping tag and a leading label, then
 * dropped where it is any of what the feature's decisions list.
 */
export function cleanSuggestion(answer: string): string | null {
  const verdict = judgeSuggestion(answer);
  return verdict.kept ? verdict.text : null;
}

/**
 * What the filters made of a fork's answer (EO-810): the cleaned-up
 * suggestion, kept, or the rule that dropped it — so a suggestion that
 * never reached the composer can be told apart from one never made.
 */
export type SuggestionVerdict = { kept: true; text: string } | { kept: false; rule: SuggestionFilterRule };

/**
 * What the filters made of an answer to `PROMPT_SUGGESTION_PROMPT`
 * (EO-894): its JSON's `suggestion`, kept or dropped as `judgeSuggestion`
 * judges it; an abstention, where `suggestion` is null or empty; or
 * dropped as `malformed_output` where the answer is not that JSON.
 * Never a throw.
 */
export type SuggestionAnswerVerdict = { kind: "kept"; text: string } | { kind: "abstained" } | { kind: "dropped"; rule: SuggestionFilterRule };

export function judgeSuggestionAnswer(answer: string): SuggestionAnswerVerdict {
  const parsed = suggestionAnswerOf(answer);
  if (parsed === null) return { kind: "dropped", rule: "malformed_output" };
  if (parsed.suggestion === null || parsed.suggestion.trim() === "") return { kind: "abstained" };
  const verdict = judgeSuggestion(parsed.suggestion);
  return verdict.kept ? { kind: "kept", text: verdict.text } : { kind: "dropped", rule: verdict.rule };
}

/** Whether an answer is the JSON `PROMPT_SUGGESTION_PROMPT` asks for (`SuggestionAnswerSchema`). */
export function isSuggestionAnswer(answer: string): boolean {
  return suggestionAnswerOf(answer) !== null;
}

function suggestionAnswerOf(answer: string): { suggestion: string | null } | null {
  let json: unknown;
  try {
    json = JSON.parse(answer);
  } catch {
    return null;
  }
  const parsed = SuggestionAnswerSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** `cleanSuggestion`, saying which rule dropped an answer rather than only that one did. */
export function judgeSuggestion(answer: string): SuggestionVerdict {
  let text = answer.trim();
  const tagged = WRAPPING_TAG.exec(text);
  if (tagged) text = (tagged[2] ?? "").trim();
  text = text.replace(LEADING_LABEL, "").trim();
  const rule = droppedBy(text);
  return rule === null ? { kept: true, text } : { kept: false, rule };
}

/** The rule of the decisions' that drops a cleaned-up answer, the first that does, or null for none. */
function droppedBy(text: string): SuggestionFilterRule | null {
  if (text === "") return "empty";
  const bare = text.toLowerCase().replace(/[.!]+$/, "");
  if (bare === "done") return "done";
  if (META_REPLIES.some((reply) => reply.test(text))) return "meta_reply";
  if (/^[([{][\s\S]*[)\]}]$/.test(text)) return "bracketed";
  if (API_ERROR.test(text)) return "api_error";
  if (/^\w+: /.test(text)) return "label";
  if (/[\n\r*]/.test(text)) return "formatting";
  if (text.length >= 100) return "too_long";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 && !text.startsWith("/") && !ONE_WORD_ANSWERS.has(bare)) return "too_few_words";
  if (words.length > 12) return "too_many_words";
  if (/[.!?]\s+\S/.test(text)) return "multiple_sentences";
  if (PRAISE.test(text)) return "praise";
  if (AGENT_VOICE.test(text)) return "agent_voice";
  return null;
}
