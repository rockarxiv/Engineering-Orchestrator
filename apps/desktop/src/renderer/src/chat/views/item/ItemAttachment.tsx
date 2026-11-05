import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, File, FolderOpen, Trash2 } from "lucide-react";
import type { AttachmentView } from "@eo/core";
import { cn } from "@eo/ui";
import { machineAvailable } from "../../../ipc/bridge";
import { ipcQuery } from "../../../query/client";
import { RefText } from "../items/ItemReference";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SMALL = "grid h-6 w-6 shrink-0 place-items-center rounded-[7px] text-ink-subtle hover:bg-canvas-hover hover:text-ink disabled:opacity-50";

/**
 * A file on an item's comment, with everything the item page offers for
 * one: an image previewed inline, its size, where it stands with Jira,
 * Open and Save (the machine's — a server has neither, EO-319) and
 * Delete (the record's, and so offered everywhere).
 *
 * The item's own card rather than the conversation's: that one is a chat
 * message's attachment, which deliberately has no Delete and no Jira
 * state, and the item is where both decisions belong.
 */
export function ItemAttachment({ attachment }: { attachment: AttachmentView }) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: ["attachment", attachment.id, "preview"],
    queryFn: () => ipcQuery("attachments:preview", { attachmentId: attachment.id }),
    enabled: attachment.kind === "image",
    staleTime: Infinity,
  });
  const open = useMutation({
    mutationFn: () => ipcQuery("attachments:open", { attachmentId: attachment.id }),
    onSuccess: (result) => setProblem(result.problem),
    onError: (error: Error) => setProblem(error.message),
  });
  const save = useMutation({
    mutationFn: () => ipcQuery("attachments:save", { attachmentId: attachment.id }),
    onSuccess: (result) => setProblem(result.problem),
    onError: (error: Error) => setProblem(error.message),
  });
  const remove = useMutation({
    mutationFn: () => ipcQuery("attachments:delete", { attachmentId: attachment.id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["item", attachment.itemId] }),
    onError: (error: Error) => setProblem(error.message),
  });

  const sync = attachment.syncStatus && attachment.syncStatus !== "local" ? attachment.syncStatus : null;
  const machine = machineAvailable();

  return (
    <div className="flex max-w-full min-w-0 flex-col overflow-hidden rounded-[10px] bg-canvas-raised">
      {attachment.kind === "image" && preview.data?.dataUrl ? (
        machine ? (
          <button type="button" aria-label={`Preview ${attachment.name}`} title="Open" onClick={() => open.mutate()} className="block max-w-full">
            <img src={preview.data.dataUrl} alt={attachment.name} className="max-h-56 max-w-full object-contain" />
          </button>
        ) : (
          <img src={preview.data.dataUrl} alt={attachment.name} className="block max-h-56 max-w-full object-contain" />
        )
      ) : null}
      <div className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-[11.5px] text-ink-muted">
        <File size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="shrink-0 tabular-nums text-ink-subtle">{formatSize(attachment.size)}</span>
        {sync ? (
          <span
            title={sync === "error" ? "Jira synchronization failed" : sync === "synchronized" ? "Synchronized with Jira" : "Waiting to synchronize with Jira"}
            aria-label={
              sync === "error"
                ? `Jira synchronization failed for ${attachment.name}`
                : sync === "synchronized"
                  ? `${attachment.name} synchronized with Jira`
                  : `${attachment.name} pending Jira synchronization`
            }
            className={cn("shrink-0", sync === "error" ? "text-danger" : "text-ink-subtle")}
          >
            {sync === "error" ? "sync error" : sync === "synchronized" ? "synced" : "pending"}
          </span>
        ) : null}
        {machine ? (
          <>
            <button type="button" aria-label={`Open ${attachment.name}`} title="Open" onClick={() => open.mutate()} className={SMALL}>
              <FolderOpen size={12} />
            </button>
            <button type="button" aria-label={`Save ${attachment.name}`} title="Save as…" onClick={() => save.mutate()} className={SMALL}>
              <Download size={12} />
            </button>
          </>
        ) : null}
        <button
          type="button"
          aria-label={`Delete ${attachment.name}`}
          title="Delete attachment"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
          className={cn(SMALL, "hover:bg-danger/15 hover:text-danger")}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {attachment.syncError ? (
        <p className="px-2 pb-1.5 text-[11.5px] text-danger">
          <RefText>{attachment.syncError}</RefText>
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="px-2 pb-1.5 text-[11.5px] text-danger">
          <RefText>{problem}</RefText>
        </p>
      ) : null}
    </div>
  );
}
