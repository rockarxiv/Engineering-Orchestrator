import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  REPOSITORY_INTELLIGENCE_PROVIDER_IDS,
  type RepositoryIndexStatus,
  type RepositoryIndexView,
  type RepositoryIntelligenceConfigPatch,
} from "@eo/core";
import { ipcQuery } from "../../../../query/client";
import { repositoryIntelligenceKey } from "../../../../shared/settings/repositoryIntelligence";
import { Button, Card, CardSection, Chip, EmptyState, ErrorLine, Facts, Field, GroupLabel, Loading, Select, Switch, type Tone } from "../../../kit";
import { withArticle } from "../../../parts";
import { Note } from "../core/fields";
import { useItemWords } from "../core/words";

/**
 * Settings → Repository Intelligence (EO-141, EO-148, EO-154): the
 * switch, what it produced, and how to put it right.
 *
 * Nothing on this screen names the implementation above the fold — the
 * heading, the status words, the buttons and every sentence are about
 * repository intelligence. Which implementation provides it is one
 * disclosure at the bottom, closed by default and rendered only when
 * opened, and it is the only place the implementation's own account of a
 * failure (`errorMessage`) is ever shown.
 */

const STATUS_WORDS: Record<RepositoryIndexStatus, string> = {
  not_indexed: "Not indexed",
  indexing: "Indexing repository…",
  ready: "Ready",
  updating: "Updating…",
  stale: "Out of date",
  failed: "Index failed",
};

const STATUS_TONES: Record<RepositoryIndexStatus, Tone> = {
  not_indexed: "neutral",
  indexing: "running",
  ready: "neutral",
  updating: "running",
  stale: "paused",
  failed: "danger",
};

/** Twelve characters of a commit, which is what the run transcript shows too. */
function revision(sha: string | null): string {
  return sha === null ? "—" : sha.slice(0, 12);
}

function when(at: number | null): string {
  return at === null ? "—" : new Date(at).toLocaleString();
}

/**
 * What has gone wrong, in EO's own words — composed from what EO knows,
 * never the implementation's sentence, which names itself.
 */
function failure(index: RepositoryIndexView, one: string): string | null {
  if (index.status === "stale") {
    return "This index no longer describes what is in the checkout — its files have gone, it was built by a version of the indexer that is not installed any more, or EO could not bring it up to date when the work moved on. Rebuild replaces it.";
  }
  if (index.status !== "failed") return null;
  if (index.indexedAt === null) {
    return `EO has not managed to build an index for this checkout, so agents working on this ${one} search the code instead of querying it.`;
  }
  return `EO could not bring this index up to date. It still answers, but it describes the checkout as it was on ${when(index.indexedAt)}.`;
}

/**
 * The upkeep this index can actually take, mirroring the transition
 * table: only `ready` can sync (Refresh), only `not_indexed` builds
 * (Index). `stale` and `failed` leave by Rebuild alone, and an index in
 * flight has no upkeep at all — a button whose only effect is a refusal
 * is the bug this section exists to stop.
 */
function availableUpkeep(index: RepositoryIndexView, actions: { onIndex: () => void; onRefresh: () => void }): { label: string; run: () => void } | null {
  if (index.status === "ready") return { label: "Refresh", run: actions.onRefresh };
  if (index.status === "not_indexed") return { label: "Index", run: actions.onIndex };
  return null;
}

function IndexCard({
  index,
  busy,
  onIndex,
  onRefresh,
  onRebuild,
}: {
  index: RepositoryIndexView;
  busy: boolean;
  onIndex: () => void;
  onRefresh: () => void;
  onRebuild: () => void;
}) {
  const words = useItemWords();
  const upkeep = availableUpkeep(index, { onIndex, onRefresh });
  const name = index.itemKey ?? "Repository baseline";
  const trouble = failure(index, words.one);

  return (
    <div role="group" aria-label={`Index for ${name}`} className="flex min-w-0 flex-col gap-2 rounded-[12px] bg-canvas-subtle px-3.5 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-[12.5px] text-ink">{name}</span>
        <Chip tone={STATUS_TONES[index.status]}>{STATUS_WORDS[index.status]}</Chip>
        <span className="ml-auto flex shrink-0 gap-1.5">
          {upkeep ? (
            <Button size="sm" disabled={busy || index.inUse} onClick={upkeep.run}>
              {upkeep.label}
            </Button>
          ) : null}
          {/* Never disabled for a busy checkout: Rebuild is the recovery
              path and stops whatever is holding the index first. */}
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRebuild}>
            Rebuild
          </Button>
        </span>
      </div>
      <Facts
        items={[
          { term: "Revision", value: <span className="font-mono">{revision(index.indexedCommitSha)}</span> },
          { term: "Last updated", value: when(index.indexedAt ?? index.updatedAt) },
        ]}
      />
      {trouble ? <Note tone="danger">{trouble}</Note> : null}
      {index.inUse ? <Note>A run is working in this checkout. Rebuilding stops it first; anything else waits for it to finish.</Note> : null}
    </div>
  );
}

export function RepositoryIntelligenceSection() {
  const queryClient = useQueryClient();
  const words = useItemWords();
  const [advanced, setAdvanced] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const state = useQuery({ queryKey: repositoryIntelligenceKey, queryFn: () => ipcQuery("repositoryIntelligence:getConfig", undefined) });

  const configure = useMutation({
    mutationFn: (patch: RepositoryIntelligenceConfigPatch) => ipcQuery("repositoryIntelligence:setConfig", patch),
    // The whole stored state comes back, statuses included: the screen
    // shows what was written rather than what it hoped for.
    onSuccess: (next) => queryClient.setQueryData(repositoryIntelligenceKey, next),
  });

  const operate = useMutation({
    // Each channel written out in full: `ipc/reachable.test.ts` reads
    // sources as text looking for a caller.
    mutationFn: ({ action, id }: { action: "index" | "refresh" | "rebuild"; id: string }) => {
      if (action === "index") return ipcQuery("repositoryIntelligence:initializeRepositoryIndex", { id });
      if (action === "refresh") return ipcQuery("repositoryIntelligence:syncRepositoryIndex", { id });
      return ipcQuery("repositoryIntelligence:rebuildRepositoryIndex", { id });
    },
    onSuccess: (result) => {
      setProblem(result.problem);
      void queryClient.invalidateQueries({ queryKey: repositoryIntelligenceKey });
    },
  });

  const title = "Repository Intelligence";
  const data = state.data;
  if (!data) {
    return (
      <CardSection title={title} description="Lets an agent look a symbol up instead of grepping for it.">
        {state.isError ? <ErrorLine>EO could not read the repository intelligence settings.</ErrorLine> : <Loading />}
      </CardSection>
    );
  }

  // A stored id nobody put in the list is still shown and still selected,
  // rather than silently rewritten by a select that could not show it.
  const providers = REPOSITORY_INTELLIGENCE_PROVIDER_IDS.includes(data.provider)
    ? REPOSITORY_INTELLIGENCE_PROVIDER_IDS
    : [...REPOSITORY_INTELLIGENCE_PROVIDER_IDS, data.provider];
  const allIndexes = data.repositories.flatMap((repository) => repository.indexes);

  return (
    <>
      <CardSection
        title={title}
        description="Builds an index of a checkout — its symbols, callers and imports — and lets an agent query it instead of searching for them. Off unless you turn it on."
      >
        <Switch label="Index repositories for agents" checked={data.enabled} disabled={configure.isPending} onChange={(enabled) => configure.mutate({ enabled })} />
        <Note>With this off, EO dispatches exactly as it does today: nothing is downloaded, nothing is indexed and no extra process runs beside an agent.</Note>
        <Note>
          With it on, EO indexes each {words.one}&rsquo;s own worktree and keeps the index there. Nothing is written into your repository, and the index is thrown
          away with the worktree.
        </Note>
      </CardSection>

      {!data.enabled ? (
        // Said where the statuses would be: an empty list while it is off
        // would read as "on and finding nothing".
        <Card label="Repository intelligence status">
          <p className="text-[13px] text-ink">Repository intelligence is disabled, so EO is not indexing anything and there is nothing to show here.</p>
          <div>
            <Button variant="primary" size="sm" disabled={configure.isPending} onClick={() => configure.mutate({ enabled: true })}>
              Turn on repository intelligence
            </Button>
          </div>
        </Card>
      ) : (
        <Card label="Repository intelligence status">
          {problem ? <ErrorLine>{problem}</ErrorLine> : null}
          {data.repositories.length === 0 ? <EmptyState title="No repository is configured yet, so there is nothing to index." /> : null}
          {data.repositories.map((repository) => (
            <div key={repository.repositoryId} className="flex min-w-0 flex-col gap-2">
              <GroupLabel>{repository.repositoryName}</GroupLabel>
              {repository.indexes.length === 0 ? (
                <Note>
                  Not indexed. EO indexes {withArticle(words.one)}&rsquo;s own checkout when its worktree is created, so this fills in as {words.many} are dispatched.
                </Note>
              ) : (
                repository.indexes.map((index) => (
                  <IndexCard
                    key={index.id}
                    index={index}
                    busy={operate.isPending}
                    onIndex={() => operate.mutate({ action: "index", id: index.id })}
                    onRefresh={() => operate.mutate({ action: "refresh", id: index.id })}
                    onRebuild={() => operate.mutate({ action: "rebuild", id: index.id })}
                  />
                ))
              )}
            </div>
          ))}
        </Card>
      )}

      <div className="flex flex-col gap-3">
        <div>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={advanced}
            icon={advanced ? <ChevronDown aria-hidden size={13} /> : <ChevronRight aria-hidden size={13} />}
            onClick={() => setAdvanced(!advanced)}
          >
            {advanced ? "Hide advanced" : "Advanced"}
          </Button>
        </div>
        {advanced ? (
          <Card label="Advanced">
            <div className="flex max-w-[20rem] flex-col gap-1.5">
              <Field label="Provider">
                <Select value={data.provider} disabled={configure.isPending} onChange={(event) => configure.mutate({ provider: event.target.value })}>
                  {providers.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Note>
              Which implementation builds and answers the index. Changing it takes effect on the next dispatch — an agent already running keeps what it started
              with.
            </Note>
            {allIndexes.length > 0 ? (
              // The implementation's own account of each index, verbatim —
              // quotable into a bug report against whatever is underneath.
              <ul aria-label="Indexes" className="flex flex-col gap-2">
                {allIndexes.map((index) => (
                  <li key={index.id} className="flex min-w-0 flex-col gap-0.5 text-[12px]">
                    <span className="font-mono text-ink-muted">{index.itemKey ?? "Baseline"}</span>
                    <span className="break-all font-mono text-ink-subtle">
                      {index.provider}
                      {index.providerVersion === null ? "" : ` ${index.providerVersion}`} — {index.indexPath}
                    </span>
                    {index.errorMessage ? <span className="text-danger">{index.errorMessage}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        ) : null}
      </div>
    </>
  );
}
