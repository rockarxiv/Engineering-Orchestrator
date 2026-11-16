/**
 * A suggested next message, made by EO itself where the backend makes
 * none (EO-808): the prompt sent on a fork of the turn just finished, and
 * the clean-up and filters its answer goes through before anybody sees it.
 *
 * Kept together and apart from any adapter so both can be read, and
 * tested, in one place. Only the Codex adapter uses them today: Claude's
 * backend makes its own suggestion (`promptSuggestions`, EO-807).
 *
 * The wording is EO's own. Claude Code's prompt follows the same rules
 * but is Anthropic's, all rights reserved, and EO is Apache-2.0.
 */

/** What the fork is sent: predict the person's next message, or say nothing. */
export const PROMPT_SUGGESTION_PROMPT = `[EO: suggest the person's next message]

This is not a message from the person, and nothing you write here is shown to them as yours. Do not call any tool: every call on this turn is refused.

Read the conversation so far and predict the very next message the person would type into this chat themselves. Not what you think they ought to do next: what they would most likely send.

- When your last answer offered choices, give the one the person would most likely pick.
- When your last answer asked whether to go on, answer as they would: "yes" or "go ahead".
- When your last answer reported an error, or you and the person misunderstood each other, give nothing.
- When the next step is not obvious, or the subject is sensitive (credentials, a security incident, somebody's private data), give nothing.

Write it the way the person writes, in 2 to 12 words and one sentence at most. Never thank or praise, never ask a question, never speak as the assistant ("Let me…", "I'll…"), and never bring up anything the person has not raised.

Answers that fit: "file it on Delivery", "publish the draft", "approve the proposal", "run the tests", "yes".

Reply with the message alone: no quotes, no label, no explanation. To give nothing, reply with nothing.`;

/**
 * How many tokens the turn's last request may have spent uncached, input
 * and output together, for a suggestion to be made after it: Claude
 * Code's threshold. Past it the thread is not in the prompt cache, and
 * the fork would pay for all of it again.
 */
export const SUGGESTION_MAX_UNCACHED_TOKENS = 10_000;

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
  let text = answer.trim();
  const tagged = WRAPPING_TAG.exec(text);
  if (tagged) text = (tagged[2] ?? "").trim();
  text = text.replace(LEADING_LABEL, "").trim();
  return rejected(text) ? null : text;
}

/** Whether a cleaned-up answer is one the decisions say to drop. */
function rejected(text: string): boolean {
  if (text === "") return true;
  const bare = text.toLowerCase().replace(/[.!]+$/, "");
  if (bare === "done") return true;
  if (META_REPLIES.some((reply) => reply.test(text))) return true;
  if (/^[([{][\s\S]*[)\]}]$/.test(text)) return true;
  if (API_ERROR.test(text)) return true;
  if (/^\w+: /.test(text)) return true;
  if (/[\n\r*]/.test(text)) return true;
  if (text.length >= 100) return true;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 && !text.startsWith("/") && !ONE_WORD_ANSWERS.has(bare)) return true;
  if (words.length > 12) return true;
  if (/[.!?]\s+\S/.test(text)) return true;
  if (PRAISE.test(text)) return true;
  if (AGENT_VOICE.test(text)) return true;
  return false;
}
