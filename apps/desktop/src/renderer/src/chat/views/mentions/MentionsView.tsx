import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AtSign } from "lucide-react";
import { waitingOnLabel, type OpenMentionView } from "@eo/core";
import { openMentionsKey } from "../../../shared/admin/openMentions";
import { ipcQuery } from "../../../query/client";
import { useChromeVocabulary } from "../../../query/hooks";
import { useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { Card, Chip, EmptyState, ErrorLine, Loading, SearchInput, ViewHeader, VirtualRows } from "../../kit";
import { ItemKeyLink, ItemText, age } from "../inbox/references";

/**
 * `/mentions`: every unaddressed mention on the record, and who each
 * waits on (EO-326, `ARCHITECTURE.md`, "Identity").
 *
 * A survey rather than a queue — none of it is the reader's to answer,
 * and the useful act is to go and ask somebody — so the rows gather
 * under the person they wait on, in the words the inbox uses for the
 * same fact (`waitingOnLabel`). Scoped by the record (`mentions:open`
 * answers with every project for an admin and the caller's own for
 * anybody else), never filtered here.
 */
export function MentionsView() {
  const navigate = useNavigate();
  const vocabulary = useChromeVocabulary();
  const mentions = useQuery({ queryKey: openMentionsKey, queryFn: () => ipcQuery("mentions:open", undefined) });
  // A comment posted anywhere adds or clears a row; a run parking on a
  // question is what makes one blocking.
  useInvalidateOnPush("items:changed", openMentionsKey);
  useInvalidateOnPush("runs:changed", openMentionsKey);

  const [search, setSearch] = useState("");
  const rows = useMemo(() => mentions.data?.mentions ?? [], [mentions.data]);
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === "") return rows;
    return rows.filter((row) =>
      `${row.itemKey} ${row.itemTitle} ${row.body} ${row.projectName ?? ""} ${waitingOnLabel(row.waitingOn)}`.toLowerCase().includes(needle),
    );
  }, [rows, search]);

  // Grouped by the person, in the order the rows arrive — newest first,
  // so nobody is at the top by accident of their name.
  const groups = useMemo(() => {
    const byPerson = new Map<string, { label: string; rows: OpenMentionView[] }>();
    for (const row of visible) {
      const label = waitingOnLabel(row.waitingOn);
      const group = byPerson.get(label) ?? { label, rows: [] };
      group.rows.push(row);
      byPerson.set(label, group);
    }
    return [...byPerson.values()];
  }, [visible]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ViewHeader
        icon={<AtSign size={15} />}
        title="All open mentions"
        meta="Everything nobody has answered yet, across every project you can see."
        actions={<Chip>{rows.length}</Chip>}
      >
        <SearchInput label="Filter open mentions" placeholder="Filter by person, project or text" value={search} onChange={setSearch} className="w-full max-w-[26rem]" />
      </ViewHeader>

      {mentions.isLoading ? <Loading /> : null}
      {mentions.error ? (
        <ErrorLine>
          <ItemText>{mentions.error.message}</ItemText>
        </ErrorLine>
      ) : null}

      {!mentions.isLoading && rows.length === 0 ? (
        <EmptyState title="Nothing is waiting on anybody.">
          Every question an agent has asked has an answer. This is where they collect when they do not.
        </EmptyState>
      ) : null}

      {rows.length > 0 && visible.length === 0 ? <p className="text-[12.5px] text-ink-subtle">Nothing matches that.</p> : null}

      {groups.map((group) => (
        <Card key={group.label} label={group.label} className="gap-1 px-2 py-3">
          {/* The person is the heading: the useful act is to go and ask one. */}
          <h2 className="px-3 pb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-subtle">
            {group.label} · {group.rows.length}
          </h2>
          {/* A screenful at a time (EO-565): one person can be waited on thousands of times. */}
          <VirtualRows label={group.label} data={group.rows} rowKey={(row) => row.commentId}>
            {(row) => (
              <div className="relative rounded-[10px] px-3 py-2.5 hover:bg-canvas-raised">
                <button
                  type="button"
                  aria-label={`Open ${row.itemKey}: ${row.itemTitle}`}
                  onClick={() => void navigate(`/items/${row.itemId}`)}
                  className="absolute inset-0 rounded-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                />
                <div className="pointer-events-none relative flex min-w-0 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">{row.itemTitle}</span>
                    {row.blocking ? <Chip tone="paused">Blocking</Chip> : null}
                    <span className="ml-auto shrink-0 text-[11px] text-ink-subtle">{age(row.createdAt)}</span>
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11.5px] text-ink-subtle">
                    <ItemKeyLink itemKey={row.itemKey} itemId={row.itemId} />
                    {/* The project, which this reader is on none of the boards of. */}
                    <span aria-hidden>·</span>
                    <span className="truncate">{row.projectName ?? "No project"}</span>
                    {vocabulary.mixed ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="truncate">{row.itemTypeLabel}</span>
                      </>
                    ) : null}
                    <span aria-hidden>·</span>
                    <span className="truncate">{row.authorName}</span>
                  </div>
                  <span className="line-clamp-2 text-[12.5px] text-ink-muted">{row.body}</span>
                </div>
              </div>
            )}
          </VirtualRows>
        </Card>
      ))}
    </div>
  );
}
