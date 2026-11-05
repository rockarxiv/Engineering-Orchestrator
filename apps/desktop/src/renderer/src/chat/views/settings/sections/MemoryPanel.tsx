import { useState } from "react";
import { Link } from "react-router-dom";
import type { MemoryConsolidationView, MemoryEntryView, MemoryListEntry, MemoryScope } from "@eo/core";
import { MAX_MEMORY_ENTRY_CHARS } from "@eo/core";
import { Button, Chip, ErrorLine, GroupLabel, RowList, TextArea } from "../../../kit";
import {
  CONTRADICTS_DESCRIPTION,
  CONTRADICTS_LABEL,
  EXTRACTED_DESCRIPTION,
  EXTRACTED_LABEL,
  consolidationLine,
  memoryCount,
  memoryIntro,
  memoryUsageLine,
  memoryWhen,
  retiredReasonLabel,
  useMemoryPanel,
  useMemorySource,
  type MemoryPanelState,
} from "../../../../memory/memoryPanel";

/**
 * Under a project or a workspace in the chat layout's settings, and on a
 * container item's page (EO-596): its memory (EO-481). What is listed and every write are the app's
 * (`memory/memoryPanel`), shared with the classic layout; only the
 * drawing is here, from this layout's own kit.
 *
 * Closed until asked for, so a project's row stays a row.
 */
export function MemoryPanel({ scope, name }: { scope: MemoryScope; name: string }) {
  const [open, setOpen] = useState(false);
  const memory = useMemoryPanel(scope);
  const where = scope.kind;

  return (
    <section aria-label={`Memory of ${name}`} className="flex flex-col gap-2 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-medium text-ink">Memory</span>
        <span className="text-[11.5px] tabular-nums text-ink-subtle">{memory.isLoading ? "…" : memoryCount(memory.lists.active.length)}</span>
        <Button size="sm" variant="ghost" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} the memory of ${name}`} onClick={() => setOpen((shown) => !shown)}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open ? <MemoryBody memory={memory} intro={memoryIntro(scope)} where={where} /> : null}
      {!open && memory.problem ? <ErrorLine>{memory.problem}</ErrorLine> : null}
    </section>
  );
}

function MemoryBody({ memory, intro, where }: { memory: MemoryPanelState; intro: string; where: string }) {
  const [showRetired, setShowRetired] = useState(false);
  const { active, retired } = memory.lists;
  return (
    <div className="flex flex-col gap-3 rounded-[12px] bg-canvas-subtle px-3 py-2.5">
      <p className="text-[11.5px] leading-snug text-ink-subtle">{intro}</p>
      {/*
        Consolidate now, what the last ask said and the history, newest
        first, at the top (EO-591): below the entries they sat out of
        sight on a scope of a hundred and more.
      */}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <GroupLabel>Consolidations</GroupLabel>
          <ConsolidateNow memory={memory} />
        </div>
        {memory.consolidateNow.blocker ? <p className="text-[11.5px] text-ink-subtle">{memory.consolidateNow.blocker}</p> : null}
        {memory.consolidateNow.message ? (
          <p role="status" className="text-[11.5px] text-ink-muted">
            {memory.consolidateNow.message}
          </p>
        ) : null}
        {memory.consolidations.length > 0 ? (
          <RowList label="Consolidations">
            {memory.consolidations.map((consolidation) => (
              <ConsolidationRow key={consolidation.id} consolidation={consolidation} memory={memory} />
            ))}
          </RowList>
        ) : null}
      </div>
      <AddEntry memory={memory} where={where} />
      {memory.problem ? <ErrorLine>{memory.problem}</ErrorLine> : null}

      {active.length === 0 && !memory.isLoading ? (
        <p className="text-[12.5px] text-ink-muted">No active entries. Agents add them as they learn, and you can add one above.</p>
      ) : (
        <RowList label="Active memory">
          {active.map((entry) => (
            <ActiveEntry key={entry.id} entry={entry} memory={memory} />
          ))}
        </RowList>
      )}

      {retired.length > 0 ? (
        <div className="flex flex-col gap-1">
          <div>
            <Button size="sm" variant="ghost" aria-expanded={showRetired} onClick={() => setShowRetired((shown) => !shown)}>
              {showRetired ? "Hide retired" : `Show retired (${String(retired.length)})`}
            </Button>
          </div>
          {showRetired ? (
            <RowList label="Retired memory">
              {retired.map((entry) => (
                <li key={entry.id} aria-label={entry.body} className="flex flex-col gap-1 py-2">
                  <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-muted">{entry.body}</p>
                  <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-subtle">
                    <span>
                      {retiredReasonLabel(entry.retiredReason)} {entry.retiredAt === null ? "" : memoryWhen(entry.retiredAt)}
                    </span>
                    <SourceLine entry={entry} />
                    {/* Kept on a retired entry: beside Restore is where it matters most. */}
                    {entry.contradictsRepositoryFile ? (
                      <Chip tone="paused" title={CONTRADICTS_DESCRIPTION}>
                        {CONTRADICTS_LABEL}
                      </Chip>
                    ) : null}
                    <Button size="sm" variant="ghost" className="ml-auto" disabled={memory.busy} onClick={() => memory.restore(entry.id)}>
                      Restore
                    </Button>
                  </div>
                </li>
              ))}
            </RowList>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AddEntry({ memory, where }: { memory: MemoryPanelState; where: string }) {
  const [draft, setDraft] = useState("");
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim() !== "") memory.add(draft, () => setDraft(""));
      }}
    >
      <TextArea
        aria-label="New memory entry"
        placeholder={`Something every agent working on this ${where} should know`}
        value={draft}
        maxLength={MAX_MEMORY_ENTRY_CHARS}
        rows={2}
        onChange={(event) => setDraft(event.target.value)}
        className="min-h-14"
      />
      <div>
        <Button type="submit" size="sm" variant="primary" disabled={memory.busy || draft.trim() === ""}>
          Add entry
        </Button>
      </div>
    </form>
  );
}

function ActiveEntry({ entry, memory }: { entry: MemoryListEntry; memory: MemoryPanelState }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <li aria-label={entry.body} className="flex flex-col gap-1 py-2">
      {draft === null ? (
        <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{entry.body}</p>
      ) : (
        <TextArea aria-label="Edit memory entry" value={draft} maxLength={MAX_MEMORY_ENTRY_CHARS} rows={3} onChange={(event) => setDraft(event.target.value)} />
      )}
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-subtle">
        <SourceLine entry={entry} />
        <span>{memoryWhen(entry.createdAt)}</span>
        <span aria-label="Usage">{memoryUsageLine(entry)}</span>
        {entry.contradictsRepositoryFile ? (
          <Chip tone="paused" title={CONTRADICTS_DESCRIPTION}>
            {CONTRADICTS_LABEL}
          </Chip>
        ) : null}
        <span className="ml-auto flex gap-1">
          {draft === null ? (
            <>
              <Button size="sm" variant="ghost" disabled={memory.busy} onClick={() => setDraft(entry.body)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" disabled={memory.busy} onClick={() => memory.retire(entry.id)}>
                Retire
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={memory.busy || draft.trim() === "" || draft.trim() === entry.body}
                onClick={() => memory.edit(entry.id, draft, () => setDraft(null))}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </>
          )}
        </span>
      </div>
    </li>
  );
}

/** Who wrote an entry: a person, or a run on an item, linked. */
function SourceLine({ entry }: { entry: MemoryEntryView }) {
  const source = useMemorySource(entry);
  if (source.kind === "person") return <span aria-label="Source">Written by a person</span>;
  const extracted = source.extracted ? (
    <Chip title={EXTRACTED_DESCRIPTION} className="ml-1">
      {EXTRACTED_LABEL}
    </Chip>
  ) : null;
  if (source.kind === "run-gone") {
    return (
      <span aria-label="Source">
        Written by an agent&apos;s run on something since deleted{extracted}
      </span>
    );
  }
  return (
    <span aria-label="Source">
      Written by an agent on{" "}
      <Link to={source.itemPath} className="font-mono text-ink hover:underline">
        {source.itemLabel}
      </Link>{" "}
      (
      <Link to={source.runsPath} className="hover:text-ink hover:underline">
        its runs
      </Link>
      ){extracted}
    </span>
  );
}

/**
 * Asking for this scope to be consolidated now (EO-589), beside its
 * history, at the top of the section (EO-591). Disabled, with the reason under it, while one is queued or
 * running, while EO is paused, and where no agent wrote anything here.
 */
function ConsolidateNow({ memory }: { memory: MemoryPanelState }) {
  const { blocker, pending, ask } = memory.consolidateNow;
  return (
    <Button size="sm" variant="ghost" className="ml-auto" disabled={blocker !== null || pending} title={blocker ?? undefined} onClick={ask}>
      Consolidate now
    </Button>
  );
}

function ConsolidationRow({ consolidation, memory }: { consolidation: MemoryConsolidationView; memory: MemoryPanelState }) {
  const line = consolidationLine(consolidation);
  return (
    <li aria-label={`Consolidation of ${line.when}`} className="flex flex-col gap-0.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-ink">{line.when}</span>
        <span className="text-[11.5px] text-ink-subtle">{line.summary}</span>
        {line.canRestore ? (
          <Button size="sm" variant="ghost" className="ml-auto" disabled={memory.busy} onClick={() => memory.restoreConsolidation(consolidation.id)}>
            Restore
          </Button>
        ) : null}
      </div>
      {consolidation.note ? <p className="text-[11.5px] text-ink-subtle">{consolidation.note}</p> : null}
    </li>
  );
}
