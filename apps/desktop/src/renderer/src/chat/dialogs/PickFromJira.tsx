import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { IpcRequest, JiraIssueView } from "@eo/core";
import { ipcQuery } from "../../query/client";
import { itemsKey } from "../../query/hooks";
import { useConfiguredRepository, useFeatureJiraProject } from "../../query/useRepositories";
import { Button, Chip, Dialog, ErrorLine, Field, Row, RowList, Select, TextInput } from "../kit";

type ImportMode = IpcRequest<"jira:import">["mode"];

/**
 * The second way to start work (J-02), in the chat layout's own dialog:
 * search the project's Jira, pick an issue, and say whether it is the
 * work or a request for it.
 *
 * Absent entirely — no dialog, no empty state — while the project has no
 * Jira connected: an action that can only fail is worse than none.
 */
export function PickFromJira({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: (itemId: string) => void;
}) {
  // A feature on a project spanning several repositories belongs to none
  // of them, so the project says whose Jira receives it (KAN-17).
  const active = useFeatureJiraProject();
  if (!open || !active?.jira.credentialsConfigured || !active.jira.projectKey) return null;
  // Mounted only while open, so every opening starts from an empty search.
  return <Picker repositoryId={active.id} projectKey={active.jira.projectKey} onClose={() => onOpenChange(false)} onImported={onImported} />;
}

function Picker({
  repositoryId,
  projectKey,
  onClose,
  onImported,
}: {
  repositoryId: string;
  projectKey: string;
  onClose: () => void;
  onImported: ((itemId: string) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<JiraIssueView | null>(null);

  // A search is a deliberate act, not a keystroke: each one is a round
  // trip to somebody else's server.
  const search = useMutation({
    mutationFn: () => ipcQuery("jira:search", { repositoryId, query }),
  });
  const preview = useMutation({
    mutationFn: (key: string) => ipcQuery("jira:preview", { repositoryId, key }),
  });

  // Which repository the work happens in (KAN-19) — not the same question
  // as whose Jira connection this is, on a project over several.
  const { repository: target, members, choose } = useConfiguredRepository();

  const importIssue = useMutation({
    mutationFn: (input: { key: string; mode: ImportMode }) =>
      ipcQuery("jira:import", {
        repositoryId,
        key: input.key,
        mode: input.mode,
        ...(target ? { targetProjectId: target.id } : {}),
      }),
    onSuccess: (result) => {
      if (!result.itemId) return;
      void queryClient.invalidateQueries({ queryKey: itemsKey });
      onClose();
      onImported?.(result.itemId);
    },
  });

  function pick(issue: JiraIssueView) {
    setPicked(issue);
    preview.mutate(issue.key);
  }

  // The preview of the issue picked now, never the one picked before it.
  const chosen = picked && preview.data && preview.variables === picked.key ? { ...preview.data, issue: picked } : null;
  const problem = chosen ? (chosen.problem ?? importIssue.data?.problem ?? null) : null;
  const busy = importIssue.isPending;
  const runImport = (mode: ImportMode) => {
    if (picked) importIssue.mutate({ key: picked.key, mode });
  };

  const back = (
    <Button variant="ghost" onClick={() => setPicked(null)}>
      Back
    </Button>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      title="Pick from Jira"
      description={`Searches ${projectKey} only. Leave it empty for the most recently updated.`}
      width="w-[34rem]"
      footer={
        chosen === null ? null : chosen.existingItemId ? (
          <>
            {back}
            <Button
              variant="primary"
              onClick={() => {
                onClose();
                onImported?.(chosen.existingItemId!);
              }}
            >
              Open it
            </Button>
          </>
        ) : chosen.children.length > 0 ? (
          <>
            {back}
            <Button disabled={busy} onClick={() => runImport("plan")}>
              Let EO plan it
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => runImport("children")}>
              Import {chosen.children.length === 1 ? "it as a story" : "them as stories"}
            </Button>
          </>
        ) : (
          <>
            {back}
            <Button disabled={busy} onClick={() => runImport("plan")}>
              Let EO plan it
            </Button>
            {/* The answer for an issue somebody sat down and wrote, which
                is most of them whatever Jira calls the type. */}
            <Button variant="primary" disabled={busy} onClick={() => runImport("asWritten")}>
              {busy ? "Importing…" : "Work it as written"}
            </Button>
          </>
        )
      }
    >
      {chosen ? (
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex min-w-0 items-start gap-2">
            <span className="shrink-0 pt-px font-mono text-[12px] text-ink-subtle">{chosen.issue.key}</span>
            <span className="min-w-0 flex-1 font-medium text-ink">{chosen.issue.summary}</span>
            <Chip>{chosen.issue.issueType}</Chip>
          </div>
          {chosen.issue.description.trim() !== "" ? (
            <p className="max-h-28 overflow-y-auto relative whitespace-pre-wrap rounded-[10px] bg-canvas px-3 py-2 text-[12.5px] leading-relaxed text-ink-muted">
              {chosen.issue.description}
            </p>
          ) : null}
          {problem ? <ErrorLine>{problem}</ErrorLine> : null}
          {chosen.existingItemId ? (
            <p className="text-ink-muted">EO already has this issue.</p>
          ) : chosen.children.length > 0 ? (
            <>
              <p className="text-ink-muted">
                {chosen.issue.key} has {chosen.children.length} {chosen.children.length === 1 ? "child" : "children"} in Jira.
              </p>
              <ul aria-label="Children in Jira" className="flex max-h-32 flex-col gap-1 overflow-y-auto relative">
                {chosen.children.map((child) => (
                  <li key={child.id} className="flex min-w-0 gap-2 text-[12.5px]">
                    <span className="shrink-0 font-mono text-ink-subtle">{child.key}</span>
                    <span className="min-w-0 truncate text-ink-muted">{child.summary}</span>
                  </li>
                ))}
              </ul>
              <p className="text-[11.5px] text-ink-subtle">Either way, nothing in Jira changes.</p>
            </>
          ) : (
            <>
              <p className="text-ink-muted">Is this the work, or a request for it?</p>
              {members.length >= 2 && target ? (
                <Field label="Repository">
                  <Select value={target.id} onChange={(event) => choose(event.target.value)}>
                    {members.map((repository) => (
                      <option key={repository.id} value={repository.id}>
                        {repository.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <p className="text-[11.5px] text-ink-subtle">Written work skips decomposition; nothing in Jira changes.</p>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <TextInput
              data-autofocus
              aria-label="Words to look for"
              value={query}
              placeholder={`Words to look for, ${projectKey}-123, or JQL`}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") search.mutate();
              }}
              className="flex-1"
            />
            <Button variant="primary" disabled={search.isPending} onClick={() => search.mutate()}>
              {search.isPending ? "Searching…" : "Search"}
            </Button>
          </div>
          {search.data?.problem ? <ErrorLine>{search.data.problem}</ErrorLine> : null}
          {preview.data?.problem ? <ErrorLine>{preview.data.problem}</ErrorLine> : null}
          {search.data && search.data.problem === null && search.data.issues.length === 0 ? (
            <p className="text-[12.5px] text-ink-subtle">Nothing in {projectKey} matched.</p>
          ) : null}
          {(search.data?.issues.length ?? 0) > 0 ? (
            <RowList label="Jira issues" className="max-h-72 overflow-y-auto relative">
              {(search.data?.issues ?? []).map((issue) => (
                <li key={issue.id}>
                  <Row
                    leading={<span className="font-mono text-[12px] text-ink-muted">{issue.key}</span>}
                    title={issue.summary}
                    trailing={<Chip>{issue.status}</Chip>}
                    onClick={() => pick(issue)}
                    className="min-h-9"
                  />
                </li>
              ))}
            </RowList>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
