import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, File, FolderOpen } from "lucide-react";
import type { DiscussionAttachment } from "@eo/core";
import { machineAvailable } from "../../ipc/bridge";
import { ipcQuery } from "../../query/client";
import { IconButton } from "../kit";
import { ReferenceText } from "./references";

/**
 * One attachment on a message, as the chat layout's conversation draws it.
 *
 * What it offers is the classic `attachments/AttachmentCard`'s, which is
 * what a person has learnt an attachment is: an image previews inline and
 * opens on a click, and every file offers **Open** and **Save as…**.
 * Neither is offered on a server, whose disk is a datacentre's (EO-319) —
 * an image still previews there, from the record, just not as a button.
 * A file that cannot be opened says so with the main process's own
 * sentence. Delete is deliberately absent, as it is on the classic card:
 * removing bytes is a decision for the item the comment lives on.
 *
 * The preview is asked for images only and cached forever: the bytes
 * cannot change, and a live turn re-renders on every streamed chunk.
 */
export function AttachmentCard({ attachment }: { attachment: DiscussionAttachment }) {
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

  const machine = machineAvailable();
  const image = attachment.kind === "image" ? (preview.data?.dataUrl ?? null) : null;

  return (
    <div className="flex max-w-full min-w-0 flex-col overflow-hidden rounded-[10px] bg-canvas-raised">
      {image !== null ? (
        machine ? (
          <button type="button" aria-label={`Preview ${attachment.name}`} title="Open" onClick={() => open.mutate()} className="block max-w-full bg-canvas-subtle">
            <img src={image} alt={attachment.name} className="max-h-48 max-w-full object-contain" />
          </button>
        ) : (
          <img src={image} alt={attachment.name} className="block max-h-48 max-w-full bg-canvas-subtle object-contain" />
        )
      ) : null}
      <div className="flex h-8 max-w-full min-w-0 items-center gap-1.5 pl-2.5 pr-1 text-[12px] text-ink-muted">
        <File aria-hidden size={13} className="shrink-0 text-ink-subtle" />
        <span className="min-w-0 flex-1 truncate" title={attachment.name}>
          {attachment.name}
        </span>
        {machine ? (
          <>
            <IconButton label={`Open ${attachment.name}`} title="Open" icon={<FolderOpen size={13} />} onClick={() => open.mutate()} className="h-6 w-6 rounded-[7px]" />
            <IconButton label={`Save ${attachment.name}`} title="Save as…" icon={<Download size={13} />} onClick={() => save.mutate()} className="h-6 w-6 rounded-[7px]" />
          </>
        ) : null}
      </div>
      {problem ? (
        <p role="alert" className="px-2.5 pb-1.5 text-[11.5px] leading-snug text-danger">
          <ReferenceText>{problem}</ReferenceText>
        </p>
      ) : null}
    </div>
  );
}
