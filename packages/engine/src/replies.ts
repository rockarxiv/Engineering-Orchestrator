/**
 * Reading what a person actually typed.
 *
 * One function so far, and it is here rather than beside either of its
 * callers because both of them are answering the same question about
 * the same sentence: does this reply name one of the things that were
 * offered? `roles/answers.ts` asks it of an ask's options, and the
 * developer pack asks it of the dependencies a stacking question listed.
 */

/**
 * Strips the wrapping a person types around a name: whitespace,
 * backticks, quotes, and the punctuation a sentence ends with.
 *
 * Shared since EO-183, because comparing a reply with what was offered
 * has to unwrap it the same way on both sides. Two copies of this
 * expression would be a clicked button that matches in one place and not
 * the other — which is the failure that makes an answered question look
 * unread.
 *
 * In the engine rather than in the pack that reads branch names
 * (KAN-161): there is nothing about git or about an item here. It is a
 * fact about how people type.
 */
export function unwrapAnswer(text: string): string {
  return text.trim().replace(/^[`'"]+/, "").replace(/[`'".,!]+$/, "").trim();
}
