import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Copy, Download, Pencil } from "lucide-react";
import { Markdown } from "@eo/ui";
import type { ItemDetail } from "@eo/core";
import { machineAvailable } from "../../../ipc/bridge";
import { ipcQuery } from "../../../query/client";
import { useChromeVocabulary } from "../../../query/hooks";
import { Button, CardSection, TextArea } from "../../kit";
import { RefText } from "../items/ItemReference";
import { ItemAttachment } from "./ItemAttachment";
import { EditorActions, StatusLine, when } from "./parts";

/**
 * What the item has produced, above the thread (EO-311, ARCHITECTURE.md, "The output is a comment",
 * "The item").
 *
 * The current output comment lifted to where a person reads it first —
 * still in the thread below with every output before it. Editing posts
 * rather than overwrites: `items:setOutput` chains a new output onto the
 * one it replaces, so the next step sends the correction and "what it
 * said before I changed it" stays answerable.
 *
 * Only text is edited. A diff is changed by changing the code, and a file
 * output is the document rather than the sentence naming it. Copy is the
 * window's clipboard; Export is the machine's dialog — text through
 * `items:exportOutput`, a single file through `attachments:save` — and
 * not offered where there is no machine (EO-319) or no single thing it
 * could mean.
 */
export function OutputSection({
  output,
  itemId,
  busy,
  problem,
  onSave,
  onCancel,
}: {
  output: ItemDetail["currentOutput"] | undefined;
  itemId: string;
  busy: boolean;
  problem: string | null;
  onSave: (body: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const vocabulary = useChromeVocabulary();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [report, setReport] = useState<string | null>(null);

  const exportText = useMutation({
    mutationFn: () => ipcQuery("items:exportOutput", { itemId }),
    onSuccess: (result) => setReport(result.problem ?? (result.saved ? `Saved to ${result.path}.` : null)),
    onError: (error: Error) => setReport(error.message),
  });
  const exportFile = useMutation({
    mutationFn: (attachmentId: string) => ipcQuery("attachments:save", { attachmentId }),
    onSuccess: (result) => setReport(result.problem),
    onError: (error: Error) => setReport(error.message),
  });

  if (!output) return null;
  const only = output.attachments.length === 1 ? output.attachments[0] : undefined;

  const copy = async (): Promise<void> => {
    setReport(null);
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setReport("This window has no clipboard to copy to.");
      return;
    }
    try {
      await clipboard.writeText(output.body);
      setReport("Copied.");
    } catch (error) {
      setReport(error instanceof Error ? error.message : String(error));
    }
  };

  const save = async (): Promise<void> => {
    if (busy) return;
    if (await onSave(draft)) setEditing(false);
  };

  return (
    <CardSection
      title="Output"
      description={`${output.authorName} · ${when(output.createdAt)}`}
      actions={
        <>
          {output.body !== "" ? (
            <Button size="sm" variant="ghost" icon={<Copy size={12} />} title="Copy the output's text" onClick={() => void copy()}>
              Copy
            </Button>
          ) : null}
          {!machineAvailable() ? null : only ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Download size={12} />}
              title="Save the file this produced"
              disabled={exportFile.isPending}
              onClick={() => {
                setReport(null);
                exportFile.mutate(only.id);
              }}
            >
              Export
            </Button>
          ) : output.attachments.length === 0 ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Download size={12} />}
              title="Save as…"
              disabled={exportText.isPending}
              onClick={() => {
                setReport(null);
                exportText.mutate();
              }}
            >
              Export
            </Button>
          ) : null}
          {!editing && output.format === "text" ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Pencil size={12} />}
              disabled={busy}
              onClick={() => {
                // Seeded on opening, so a run posting mid-edit never
                // rewrites what somebody is typing.
                setDraft(output.body);
                setEditing(true);
              }}
            >
              Edit
            </Button>
          ) : null}
        </>
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <TextArea
            aria-label="Output"
            value={draft}
            rows={Math.max(6, Math.min(24, draft.split("\n").length + 1))}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <EditorActions
            note={`Saving posts your version as this ${vocabulary.item.toLowerCase()}'s output. The one it replaces stays in the thread, and the next step works from yours.`}
          >
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
              Save output
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                onCancel();
              }}
            >
              Cancel
            </Button>
          </EditorActions>
        </div>
      ) : (
        <div className="min-w-0 text-ink">
          <Markdown>{output.body}</Markdown>
        </div>
      )}

      {output.attachments.length > 0 ? (
        <div aria-label="Output files" className="flex flex-wrap gap-2">
          {output.attachments.map((attachment) => (
            <ItemAttachment key={attachment.id} attachment={attachment} />
          ))}
        </div>
      ) : null}

      {output.supersedesCommentId !== null && !editing ? (
        <p className="text-[11.5px] text-ink-subtle">This replaced an earlier version, which is still in the thread below.</p>
      ) : null}
      {report ? (
        <StatusLine>
          <RefText>{report}</RefText>
        </StatusLine>
      ) : null}
      {problem ? (
        <StatusLine tone="danger">
          <RefText>{problem}</RefText>
        </StatusLine>
      ) : null}
    </CardSection>
  );
}
