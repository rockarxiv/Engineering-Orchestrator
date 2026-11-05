import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IpcRequest } from "@eo/core";
import { ipcQuery } from "../../../../query/client";
import { worktreesKey } from "../../../../query/hooks";
import { useConfiguredRepository } from "../../../../query/useRepositories";
import { useInvalidateOnPush } from "../../../../query/useInvalidateOnPush";
import { Button, CardSection, Chip, EmptyState, Loading, RowList } from "../../../kit";
import { Note, RepositoryPicker } from "../core/fields";
import { ItemKeyLink, ItemText } from "../core/references";
import { formatSize, plural, useItemWords } from "../core/words";

/**
 * Settings → Git & worktrees: the checkouts EO is holding right now, one
 * repository at a time, what each costs on disk, and releasing them.
 *
 * Not configuration — what is on disk. Releasing one that holds
 * uncommitted work is a second, differently-worded click: discarding an
 * agent's only copy should not be one keystroke from an ordinary Release.
 */
export function WorktreesSection() {
  const queryClient = useQueryClient();
  const words = useItemWords();
  // A worktree belongs to a repository, so a project spanning several is
  // looked at one repository at a time (KAN-20).
  const { repository: active, members, choose } = useConfiguredRepository();
  const repositoryId = active?.id ?? null;
  const held = useQuery({
    queryKey: [...worktreesKey, repositoryId],
    queryFn: () => ipcQuery("worktrees:list", { repositoryId }),
  });
  // Pointing EO at a repository and the engine releasing one when an item
  // finishes both change this list without anything here being pressed.
  useInvalidateOnPush("config:changed", worktreesKey);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const release = useMutation({
    mutationFn: (input: IpcRequest<"worktrees:release">) => ipcQuery("worktrees:release", input),
    onSuccess: (result) => {
      setProblem(result.released ? null : result.reason);
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: worktreesKey });
    },
  });

  const worktrees = held.data?.worktrees ?? [];
  const total = worktrees.reduce((sum, entry) => sum + entry.sizeBytes, 0);

  return (
    <CardSection
      title="Worktrees"
      description={`One checkout per ${words.one}. Finished ${words.many} release theirs automatically; these are the ones still held.`}
    >
      <RepositoryPicker members={members} chosen={active} onChoose={choose} />
      {held.isLoading ? <Loading /> : null}
      {held.data?.problem ? (
        <p className="text-[12.5px] text-ink-muted">
          <ItemText>{held.data.problem}</ItemText>
        </p>
      ) : null}
      {held.data && !held.data.problem && worktrees.length === 0 ? <EmptyState title="Nothing is held right now." /> : null}

      {worktrees.length > 0 ? (
        <RowList label="Held worktrees">
          {worktrees.map((entry) => (
            <li key={entry.itemKey} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
              <ItemKeyLink itemKey={entry.itemKey} className="text-[12.5px] text-ink" />
              <Chip>{entry.itemState ?? `no ${words.one}`}</Chip>
              <span className="text-[11.5px] tabular-nums text-ink-subtle">{formatSize(entry.sizeBytes)}</span>
              {entry.uncommittedChanges > 0 ? (
                <span className="text-[11.5px] text-paused">{plural(entry.uncommittedChanges, "uncommitted change")}</span>
              ) : null}
              <span className="ml-auto flex shrink-0 gap-1.5">
                {entry.inUse ? (
                  <span className="text-[11.5px] text-ink-subtle">in use</span>
                ) : confirming === entry.itemKey ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={release.isPending}
                      onClick={() => release.mutate({ itemKey: entry.itemKey, repositoryId: entry.repositoryId, force: true })}
                    >
                      Discard changes and release
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    disabled={release.isPending}
                    onClick={() =>
                      entry.uncommittedChanges > 0
                        ? setConfirming(entry.itemKey)
                        : release.mutate({ itemKey: entry.itemKey, repositoryId: entry.repositoryId, force: false })
                    }
                  >
                    Release
                  </Button>
                )}
              </span>
            </li>
          ))}
        </RowList>
      ) : null}

      {problem ? (
        <p role="alert" className="text-[12.5px] text-danger">
          <ItemText>{problem}</ItemText>
        </p>
      ) : null}
      {worktrees.length > 0 ? (
        <Note>
          {formatSize(total)} across {plural(worktrees.length, "checkout")}. Releasing one keeps its branch — the commits are the deliverable.
        </Note>
      ) : null}
    </CardSection>
  );
}
