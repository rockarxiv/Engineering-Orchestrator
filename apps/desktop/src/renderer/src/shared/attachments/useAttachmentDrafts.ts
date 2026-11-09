import { useEffect, useRef, useState } from "react";
import type { AttachmentDraft } from "@eo/core";
import { ipcQuery } from "../../query/client";

const MAX_COUNT = 8;
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * What a composer says when more files arrived than a message may carry.
 *
 * The cap is not new and neither is the truncation; the sentence is
 * (EO-194). Pasting nine files used to attach eight and say nothing,
 * which reads as nine attached — the one failure mode a person cannot
 * catch by looking, because what is on screen is exactly what a
 * successful attach of eight looks like.
 *
 * It names the cap rather than only the casualty count, so somebody who
 * has already staged six and drops four is told why only two landed.
 */
function overCapacity(count: number): string {
  return `A message can carry at most ${MAX_COUNT} files, so ${count === 1 ? "one was" : `${count} were`} left out.`;
}

function discard(id: string): void {
  void ipcQuery("attachments:discard", { attachmentId: id }).catch(() => undefined);
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/**
 * The files a composer has staged but not yet sent.
 *
 * **Capacity is counted in a ref, not in state**, and that is the whole
 * of what makes the eight-file cap true rather than approximately true.
 * Staging is asynchronous — a `FileReader` and then an IPC round trip
 * per file — and paste and drop stay live throughout, so two batches
 * routinely overlap. Deciding how many files fit from the rendered
 * `attachments` array meant both batches read the same pre-batch count:
 * drop four and paste five before either resolves and all nine were
 * staged, eight were shown, and the ninth became a file on disk that no
 * draft, no comment and no cleanup ever mentioned again.
 *
 * So a batch *claims* its slots synchronously, in `reserved`, in the
 * same tick it is asked to stage — the body of an async function up to
 * its first `await` cannot be interleaved — and releases them once the
 * drafts have been committed. The second batch of the pair above sees
 * four slots left rather than eight, takes four of its five, and says
 * the fifth was left out.
 *
 * `drafts` is the same idea for the list itself: `keep` reads and writes
 * it synchronously, so what a batch commits is visible to the next one
 * without waiting for a render. The state array is what React draws, and
 * `commit` is the only thing that writes either.
 */
export function useAttachmentDrafts() {
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * How many batches are still staging — a count, not a flag.
   *
   * A boolean was wrong for the same reason the capacity was: batches
   * overlap. The first to finish cleared it while the second was still
   * reading files, and `busy` is what keeps a composer from being sent
   * mid-stage — so the message went with half of what had been offered,
   * `clearCommitted` emptied the composer, and the batch still in flight
   * committed its drafts into an empty box for whatever got sent next.
   * The person watched four files become two, and two files appear on a
   * message they had not written yet.
   *
   * Every increment and decrement is a functional update, so two batches
   * starting in one tick cannot lose each other's.
   */
  const [staging, setStaging] = useState(0);
  const drafts = useRef<AttachmentDraft[]>([]);
  /** Slots claimed by a batch that is still staging. */
  const reserved = useRef(0);
  /**
   * False once the composer is gone.
   *
   * A batch outlives its component — nothing cancels a staging loop —
   * and drafts committed to a hook nobody is rendering are drafts the
   * unmount cleanup has already run past. They are discarded instead.
   */
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const attachment of drafts.current) discard(attachment.id);
    };
  }, []);

  function commit(next: AttachmentDraft[]): void {
    drafts.current = next;
    setAttachments(next);
  }

  /** How many more this message can carry, counting batches still in flight. */
  function freeSlots(): number {
    return Math.max(0, MAX_COUNT - drafts.current.length - reserved.current);
  }

  /**
   * Adds what fits and hands back what does not, in one synchronous step.
   *
   * The caller discards the remainder. With slots reserved up front there
   * should never be one, and that is exactly why it is returned rather
   * than sliced away: the truncation this replaces was silent, and a
   * silent truncation is how a staged file stops being anybody's.
   */
  function keep(incoming: AttachmentDraft[]): AttachmentDraft[] {
    const current = drafts.current;
    const fresh = incoming.filter((item) => !current.some((existing) => existing.id === item.id));
    const room = Math.max(0, MAX_COUNT - current.length);
    commit([...current, ...fresh.slice(0, room)]);
    return fresh.slice(room);
  }

  async function pick(): Promise<void> {
    setProblem(null);
    setStaging((count) => count + 1);
    try {
      const result = await ipcQuery("attachments:pick", undefined);
      // No reservation around the dialog: it is modal, so nothing else
      // can stage while it is open, and the count is only knowable once
      // it answers. Reading the slots and committing happen in the one
      // tick below, which is what makes that safe.
      const rejected = mounted.current ? keep(result.attachments) : result.attachments;
      for (const attachment of rejected) discard(attachment.id);
      // Both counts: the drafts discarded for want of a free slot, and
      // the ones main never staged at all because the dialog handed it
      // more than eight. Neither is visible to the other side, so the
      // person is told the sum.
      const left = rejected.length + result.omitted;
      if (left > 0) setProblem(overCapacity(left));
      // A chosen file main could not stage — over 20 MB, not a file — in
      // main's own sentence (EO-702). It staged none of them.
      if (result.problem) setProblem(result.problem);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setStaging((count) => count - 1);
    }
  }

  /**
   * Everything a paste or a drop produced — the cap is applied here
   * rather than by the caller.
   *
   * It used to be applied twice: `Composer` sliced to the free slots and
   * then this sliced again, so by the time anything could have counted
   * the surplus it had already been subtracted. One place owns the
   * number, and it is the place that can say something about it.
   */
  async function stageFiles(files: File[] | FileList): Promise<void> {
    const chosen = Array.from(files);
    const selected = chosen.slice(0, freeSlots());
    // Claimed in the same tick the slots were counted, before the first
    // `await` below — this is what a batch starting while this one is
    // still reading files subtracts from.
    reserved.current += selected.length;
    // Said before anything is staged and left standing if the rest
    // succeeds: attaching eight of nine is not eight successes, and the
    // sentence is the only difference between the two on screen. A
    // genuine staging failure below overwrites it — a file that could not
    // be read at all is the more urgent thing to say.
    const overflow = chosen.length - selected.length;
    setProblem(overflow > 0 ? overCapacity(overflow) : null);
    if (selected.length === 0) return;

    setStaging((count) => count + 1);
    const staged: AttachmentDraft[] = [];
    try {
      for (const file of selected) {
        if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than the 20 MB attachment limit.`);
        const result = await ipcQuery("attachments:stage", { name: file.name, dataBase64: await fileBase64(file) });
        staged.push(result.attachment);
      }
      const rejected = mounted.current ? keep(staged) : staged;
      for (const attachment of rejected) discard(attachment.id);
      if (rejected.length > 0) setProblem(overCapacity(overflow + rejected.length));
    } catch (error) {
      for (const attachment of staged) discard(attachment.id);
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      // After `keep`, never before: releasing while the drafts are still
      // uncommitted would show the next batch slots that are already
      // spoken for.
      reserved.current -= selected.length;
      setStaging((count) => count - 1);
    }
  }

  function remove(id: string): void {
    commit(drafts.current.filter((attachment) => attachment.id !== id));
    discard(id);
  }

  function clearCommitted(): void {
    commit([]);
    setProblem(null);
  }

  function discardAll(): void {
    for (const attachment of drafts.current) discard(attachment.id);
    clearCommitted();
  }

  // `busy` is what a composer disables Send on, so it has to mean "no
  // batch is still in flight" rather than "the last one to finish has
  // finished".
  return { attachments, problem, busy: staging > 0, pick, stageFiles, remove, clearCommitted, discardAll };
}
