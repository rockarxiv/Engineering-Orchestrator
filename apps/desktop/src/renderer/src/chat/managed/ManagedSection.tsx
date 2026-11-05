import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { SECTION_LOCK_TEXT, type PublishedSection, type SectionLock } from "@eo/core";
import { useLockedSections } from "../../query/hooks";
import { ReadOnlyFence } from "../admin/ReadOnlyFence";

/**
 * A section the organisation has published, in the chat layout's terms
 * (EO-329, `ARCHITECTURE.md`, "Publish, lock and versions").
 *
 * The same two halves as the classic screen's and for its reasons: the
 * **fence** stops the editing (a `<fieldset disabled>`, so a control added
 * later is dead without anybody remembering the rule), and the **line**
 * stops the confusion — a disabled screen with no sentence on it is a
 * person looking for the setting they think they have broken.
 *
 * The words come down the wire from `sections:list`, so the sentence on
 * screen and the one the main process refuses on cannot drift apart. And
 * it is a report of a lock, never the lock itself: the refusal lives in
 * the command layer.
 *
 * Nothing is drawn for a section that is not published.
 */
export function ManagedSection({ section, children }: { section: PublishedSection; children: ReactNode }) {
  const sections = useLockedSections();
  if (!sections.isLocked(section)) return <>{children}</>;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ManagedLockLine section={section} />
      <ReadOnlyFence readOnly>{children}</ReadOnlyFence>
    </div>
  );
}

/**
 * The line on its own, for a screen whose controls are fenced by
 * something else — or deliberately not fenced, as Connectors is: what a
 * published connectors section locks is the catalogue, and signing in to
 * what is in it stays the person's.
 */
export function ManagedLockLine({ section }: { section: PublishedSection }) {
  const sections = useLockedSections();
  if (!sections.isLocked(section)) return null;

  const row = sections.published.find((published) => published.section === section);
  const by = row?.publishedByName ?? row?.publishedBy ?? null;

  return <ManagedLockNotice lock={{ locked: true, section, publishedBy: by }} text={sections.lockText} />;
}

/**
 * The lock as a thing to draw, from a value rather than from a query: for
 * a screen that found out by being refused and has only the refusal in
 * its hand. One wording, so nobody meets two accounts of one lock.
 *
 * `children` is what a person may do about it, where there is anything —
 * *Suggest a change* on a published pipelines section — drawn inside the
 * notice so the sentence and the offer read as one thing.
 */
export function ManagedLockNotice({
  lock,
  text = SECTION_LOCK_TEXT,
  children,
}: {
  lock: SectionLock;
  text?: string;
  children?: ReactNode;
}) {
  return (
    <div
      // Named so a test can ask for the lock on one section without
      // matching the sentence, which is identical on all five.
      data-testid={`managed-lock-${lock.section}`}
      aria-label={`${lock.section} is managed by your organisation`}
      className="flex min-w-0 items-start gap-2.5 rounded-[12px] bg-canvas-raised px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-muted"
    >
      <Lock aria-hidden size={14} className="mt-[3px] shrink-0 text-ink-subtle" />
      <span className="min-w-0">
        {text}
        {lock.publishedBy === null ? null : <span className="text-ink-subtle"> Published by {lock.publishedBy}.</span>}
        {children}
      </span>
    </div>
  );
}
