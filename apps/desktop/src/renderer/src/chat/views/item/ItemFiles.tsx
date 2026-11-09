import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { File, Paperclip, Trash2 } from "lucide-react";
import type { AttachmentView } from "@eo/core";
import { cn } from "@eo/ui";
import { machineAvailable } from "../../../ipc/bridge";
import { ipcQuery } from "../../../query/client";
import { useAttachmentDrafts } from "../../../shared/attachments/useAttachmentDrafts";
import { Button, Dialog, GroupLabel } from "../../kit";
import { RefText } from "../items/ItemReference";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SMALL = "grid h-6 w-6 shrink-0 place-items-center rounded-[7px] text-ink-subtle hover:bg-canvas-hover hover:text-ink disabled:opacity-50";

/**
 * The item's own files, under its description (EO-702, ARCHITECTURE.md,
 * "Attachments").
 *
 * Part of what the item is — a mock it is built against, a spec PDF, a
 * screenshot of the bug — so they sit with the description rather than
 * in the thread, and nothing here is anything anybody said. A comment's
 * files stay on their comments, and cannot be removed from here.
 *
 * Added the way a comment's are — picked, pasted or dropped — through
 * the same staging and the same limits, so a ninth file or one over
 * 20 MB is refused in the sentence a comment uses. What is staged goes
 * straight onto the item; there is no message to send it with.
 */
export function ItemFiles({ itemId, attachments, readOnly }: { itemId: string; attachments: readonly AttachmentView[]; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const drafts = useAttachmentDrafts();
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AttachmentView | null>(null);
  /** Ids already on their way to the item, so a render mid-request does not send them twice. */
  const sending = useRef(new Set<string>());

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["item", itemId] });

  // Staged drafts go onto the item as soon as no batch is still staging.
  useEffect(() => {
    if (drafts.busy) return;
    const ids = drafts.attachments.map((draft) => draft.id).filter((id) => !sending.current.has(id));
    if (ids.length === 0) return;
    for (const id of ids) sending.current.add(id);
    ipcQuery("items:addAttachments", { itemId, attachmentIds: ids })
      .then((result) => setProblem(result.problem))
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        // Dropped from the drafts either way: on the item now, or refused
        // — and a refused draft is discarded rather than left staged.
        for (const id of ids) {
          drafts.remove(id);
          sending.current.delete(id);
        }
        refresh();
      });
    // `drafts.remove` is a fresh function each render; the list and the
    // busy count are what decide whether there is anything to send.
  }, [drafts.attachments, drafts.busy, itemId]);

  const remove = useMutation({
    mutationFn: (attachmentId: string) => ipcQuery("items:removeAttachment", { attachmentId }),
    onSuccess: (result) => {
      setProblem(result.problem);
      setRemoving(null);
      refresh();
    },
    onError: (error: Error) => {
      setProblem(error.message);
      setRemoving(null);
    },
  });

  function onPaste(event: ClipboardEvent<HTMLElement>): void {
    if (readOnly) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    setProblem(null);
    void drafts.stageFiles(files);
  }

  function onDrop(event: DragEvent<HTMLElement>): void {
    if (event.dataTransfer.files.length === 0) return;
    // Prevented either way: left to the browser, a dropped file replaces the window.
    event.preventDefault();
    if (readOnly) return;
    setProblem(null);
    void drafts.stageFiles(event.dataTransfer.files);
  }

  if (attachments.length === 0 && readOnly) return null;
  const busy = drafts.busy || drafts.attachments.length > 0;
  const said = problem ?? drafts.problem;

  return (
    <section
      aria-label="Attachments"
      // Focusable so a paste lands here: click the section, then paste.
      tabIndex={readOnly ? undefined : 0}
      onPaste={onPaste}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      className="flex min-w-0 flex-col gap-2 border-t border-line/60 pt-3 outline-none focus-visible:shadow-[0_0_0_1px_var(--color-line-strong)]"
    >
      <GroupLabel
        trailing={
          readOnly ? undefined : (
            <Button
              variant="ghost"
              size="sm"
              icon={<Paperclip size={12} />}
              disabled={busy}
              onClick={() => {
                setProblem(null);
                void drafts.pick();
              }}
            >
              {busy ? "Adding…" : "Add files"}
            </Button>
          )
        }
      >
        Attachments
      </GroupLabel>
      {attachments.length === 0 ? (
        <p className="text-[12.5px] text-ink-subtle">No files on this item. Pick some, or paste or drop them here.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="min-w-0 max-w-full">
              <ItemFile attachment={attachment} readOnly={readOnly} onRemove={() => setRemoving(attachment)} onProblem={setProblem} />
            </li>
          ))}
        </ul>
      )}
      {said ? (
        <p role="alert" className="text-[12px] text-danger">
          <RefText>{said}</RefText>
        </p>
      ) : null}
      {removing ? (
        <Dialog
          open
          busy={remove.isPending}
          onClose={() => setRemoving(null)}
          title="Remove this file?"
          footer={
            <>
              <Button variant="ghost" disabled={remove.isPending} onClick={() => setRemoving(null)}>
                Keep it
              </Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(removing.id)}>
                {remove.isPending ? "Removing…" : "Remove"}
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-relaxed text-ink-muted">
            <span className="text-ink">{removing.name}</span> will be taken off this item and deleted, including from what later agents are given. This cannot be undone.
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}

/** One of the item's files: a thumbnail for an image, a row for anything else; either opens with the system viewer. */
function ItemFile({
  attachment,
  readOnly,
  onRemove,
  onProblem,
}: {
  attachment: AttachmentView;
  readOnly: boolean;
  onRemove: () => void;
  onProblem: (problem: string | null) => void;
}) {
  const machine = machineAvailable();
  const preview = useQuery({
    queryKey: ["attachment", attachment.id, "preview"],
    queryFn: () => ipcQuery("attachments:preview", { attachmentId: attachment.id }),
    enabled: attachment.kind === "image",
    staleTime: Infinity,
  });
  const open = useMutation({
    mutationFn: () => ipcQuery("attachments:open", { attachmentId: attachment.id }),
    onSuccess: (result) => onProblem(result.problem),
    onError: (error: Error) => onProblem(error.message),
  });
  const thumbnail = attachment.kind === "image" ? preview.data?.dataUrl ?? null : null;

  return (
    <div className="group relative flex min-w-0 max-w-full flex-col overflow-hidden rounded-[10px] bg-canvas-raised">
      {thumbnail ? (
        <button
          type="button"
          aria-label={`Open ${attachment.name}`}
          title={attachment.name}
          disabled={!machine}
          onClick={() => open.mutate()}
          className="block"
        >
          <img src={thumbnail} alt={attachment.name} className="h-28 w-40 object-cover" />
        </button>
      ) : null}
      <div className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-[11.5px] text-ink-muted">
        <File size={12} className="shrink-0" />
        {thumbnail ? (
          <span className="min-w-0 max-w-32 flex-1 truncate" title={attachment.name}>
            {attachment.name}
          </span>
        ) : (
          <button
            type="button"
            aria-label={`Open ${attachment.name}`}
            title={machine ? "Open" : attachment.name}
            disabled={!machine}
            onClick={() => open.mutate()}
            className="min-w-0 max-w-64 flex-1 truncate text-left hover:text-ink hover:underline disabled:no-underline"
          >
            {attachment.name}
          </button>
        )}
        <span className="shrink-0 tabular-nums text-ink-subtle">{formatSize(attachment.size)}</span>
        {readOnly ? null : (
          <button type="button" aria-label={`Remove ${attachment.name}`} title="Remove file" onClick={onRemove} className={cn(SMALL, "hover:bg-danger/15 hover:text-danger")}>
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
