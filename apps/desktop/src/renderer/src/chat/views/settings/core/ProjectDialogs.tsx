import type { ReactNode } from "react";
import type { IpcResponse } from "@eo/core";
import { Button, Dialog } from "../../../kit";
import { withArticleCapital } from "../../../parts";
import { ItemText } from "./references";
import { plural, useItemWords } from "./words";

/**
 * The two confirmations in front of losing a project from view: archiving
 * it (EO-347) and deleting it (EO-346).
 *
 * What each says comes from the main process's unconfirmed call, not from
 * anything the window has cached: which items have an agent on them and
 * which worktrees hold uncommitted work are facts about this moment and
 * this disk. One question rather than two — the first answer already
 * names everything a second would be about.
 */

/** A list the person has to read before confirming: the items an agent is on, the worktrees with work only they hold. */
function Warning({ label, lead, children }: { label: string; lead: ReactNode; children: ReactNode }) {
  return (
    <div role="alert" aria-label={label} className="flex flex-col gap-1 rounded-[12px] bg-paused/15 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink">
      <p className="text-paused">{lead}</p>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

function Problem({ children }: { children: string }) {
  return (
    <p role="alert" className="text-[12.5px] text-danger">
      {children}
    </p>
  );
}

export function ConfirmArchiveProject({
  name,
  preview,
  busy,
  problem,
  onConfirm,
  onCancel,
}: {
  name: string;
  /** The unconfirmed answer. Null while it is being asked for. */
  preview: IpcResponse<"projects:archive"> | null;
  busy: boolean;
  problem: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const words = useItemWords();
  // Refused outright — on the record, mid-move, already archived. Nothing
  // to confirm, so nothing is offered but the way out.
  const refused = preview !== null && preview.problem !== null;

  return (
    <Dialog
      open
      onClose={onCancel}
      busy={busy}
      title={`Archive ${name}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {refused ? "Close" : "Keep it"}
          </Button>
          {refused ? null : (
            <Button variant="primary" disabled={busy || preview === null} onClick={onConfirm}>
              Archive the project
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-ink-muted">
        {preview === null ? (
          <p>Counting what is on it…</p>
        ) : refused ? null : (
          <>
            <p>
              <span className="text-ink">{plural(preview.unfinishedCount, `unfinished ${words.one}`, `unfinished ${words.many}`)}</span>{" "}
              {preview.unfinishedCount === 1 ? "pauses" : "pause"}: nothing is dispatched on the project while it is archived, and it leaves the project
              switcher, the board and the Inbox. Nothing is deleted.
            </p>
            <p>
              Restoring it from Settings carries every paused {words.one} on from the step it was on. {withArticleCapital(words.one)} you put on hold stays on hold.
            </p>
            {preview.running.length > 0 ? (
              <Warning label="Agents running" lead="An agent is running on these. Archiving stops it:">
                {preview.running.map((entry) => (
                  <li key={entry.itemKey}>
                    <ItemText>{entry.itemKey}</ItemText> {entry.title}
                  </li>
                ))}
              </Warning>
            ) : null}
          </>
        )}
        {problem !== null ? <Problem>{problem}</Problem> : null}
      </div>
    </Dialog>
  );
}

export function ConfirmDeleteProject({
  name,
  preview,
  busy,
  problem,
  leftover,
  onConfirm,
  onCancel,
}: {
  name: string;
  preview: IpcResponse<"projects:delete"> | null;
  busy: boolean;
  problem: string | null;
  /** Checkouts a confirmed delete could not remove (issue #131). */
  leftover: IpcResponse<"projects:delete">["leftoverWorktrees"];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const words = useItemWords();

  // The delete went through and left directories nothing names any more.
  // The last moment to connect the two, so the dialog stays to say where.
  if (leftover.length > 0) {
    return (
      <Dialog
        open
        onClose={onCancel}
        title={`${name} was deleted`}
        description="Deleted, but some checkouts are still on disk."
        footer={<Button onClick={onCancel}>Close</Button>}
      >
        <div className="flex flex-col gap-2 text-[13px] text-ink-muted">
          <p>
            <span className="text-ink">{name}</span> is gone. EO could not remove these worktrees:
          </p>
          <ul role="alert" className="flex flex-col gap-2">
            {leftover.map((entry) => (
              <li key={entry.path} className="text-[12.5px] text-paused">
                <span className="block break-all font-mono text-[12px] text-ink">{entry.path}</span>
                {entry.problem}
              </li>
            ))}
          </ul>
        </div>
      </Dialog>
    );
  }

  const refused = preview !== null && preview.problem !== null;

  return (
    <Dialog
      open
      onClose={onCancel}
      busy={busy}
      title={`Delete ${name}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {refused ? "Close" : "Keep it"}
          </Button>
          {refused ? null : (
            <Button variant="danger" disabled={busy || preview === null} onClick={onConfirm}>
              Delete the project and its {words.many}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-ink-muted">
        {preview === null ? (
          <p>Counting what is on it…</p>
        ) : refused ? null : (
          <>
            <p>
              It has <span className="text-ink">{plural(preview.unfinishedCount, `unfinished ${words.one}`, `unfinished ${words.many}`)}</span>
              {preview.itemCount !== preview.unfinishedCount ? ` (${words.count(preview.itemCount)} in all)` : ""}. Every {words.one} on it will be deleted
              with its history — comments, runs and attachments — along with its pipelines, item types and jobs. This cannot be undone.
            </p>
            <p>Its repositories stay in EO, attached to no project. Nothing in Jira is touched.</p>
            {preview.running.length > 0 ? (
              <Warning label="Agents running" lead="An agent is running on these. Deleting stops it:">
                {preview.running.map((entry) => (
                  <li key={entry.itemKey}>
                    <ItemText>{entry.itemKey}</ItemText> {entry.title}
                  </li>
                ))}
              </Warning>
            ) : null}
            {preview.uncommitted.length > 0 ? (
              <Warning
                label="Uncommitted changes"
                lead="These worktrees hold uncommitted changes that exist nowhere else. Deleting removes the worktree and keeps the branch:"
              >
                {preview.uncommitted.map((entry) => (
                  <li key={entry.itemKey}>
                    <ItemText>{entry.itemKey}</ItemText> {entry.title} ({plural(entry.changes, "uncommitted change")})
                  </li>
                ))}
              </Warning>
            ) : null}
          </>
        )}
        {problem !== null ? <Problem>{problem}</Problem> : null}
      </div>
    </Dialog>
  );
}

