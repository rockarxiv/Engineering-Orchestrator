import type { RefObject } from "react";

export interface ComposerProps {
  /** Everything mentionable: "user" plus the configured agent names (A-03). */
  mentionables: string[];
  /**
   * Return a promise to have the composer wait for it: the text is kept
   * until it resolves, and a rejection is shown without losing what was
   * typed. Returning nothing clears immediately, as it always did.
   */
  onSubmit: (body: string, mentions: string[], attachmentIds: string[]) => void | Promise<unknown>;
  busy?: boolean;
  /**
   * The box is closed to this person, rather than mid-send (EO-326,
   * ARCHITECTURE.md, "Identity").
   *
   * Its own prop rather than a second meaning for `busy`, which is what
   * this was for one round: everything disabled is right, and the
   * spinner that comes with it is a lie — an admin reading another
   * team's item would have watched a permanent "Posting…" under a box
   * they had not typed in.
   */
  readOnly?: boolean;
  /** Overridden when the composer is answering a particular comment (D-05). */
  placeholder?: string;
  /** "Reply" when this composer answers a comment, so two open composers are tellable apart. */
  submitLabel?: string;
  /** Lets a containing surface manage focus without changing the default for other composers. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /**
   * The box's accessible name, where "Write a comment" would be wrong.
   *
   * The assist panel's is "Message the assistant" and not "Ask the
   * assistant", because that is already the name of the button that opens
   * it — two controls answering to one name is two ways to say the same
   * thing to a screen reader.
   */
  ariaLabel?: string;
  /** A roomier, rounded agent-chat treatment used by Discussions. */
  appearance?: "default" | "chat";
  /** Context shown in the chat composer's footer, for example queued follow-up behavior. */
  statusText?: string;
  /** Additional app-chat completions, such as repository files and slash commands. */
  completions?: ComposerCompletion[];
}

export interface ComposerCompletion {
  trigger: "@" | "/" | "$";
  value: string;
  label?: string;
  description?: string;
}

/** The `@token` currently being typed, if the caret sits inside one. */
export function activeMentionQuery(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const match = /@([\w-]*)$/.exec(before);
  return match ? (match[1] ?? "") : null;
}

export function activeCompletion(text: string, caret: number): { trigger: "@" | "/" | "$"; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)([@/$])([^\s]*)$/.exec(before);
  if (!match) return null;
  const trigger = match[2] as "@" | "/" | "$";
  return { trigger, query: match[3] ?? "", start: caret - (match[3]?.length ?? 0) - 1 };
}

/** Every `@token` in the body that names something mentionable — what actually gets sent. */
export function extractMentions(text: string, mentionables: string[]): string[] {
  const known = new Set(mentionables.map((name) => name.toLowerCase()));
  const found = new Set<string>();
  for (const match of text.matchAll(/@([\w-]+)/g)) {
    const token = match[1]!.toLowerCase();
    if (known.has(token)) found.add(token);
  }
  return [...found];
}
