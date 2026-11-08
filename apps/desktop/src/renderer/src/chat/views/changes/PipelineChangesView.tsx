import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { changesComparedOf, changesShown, templateUpdateOfAuthor, templateVersionLabel, versionLabel, type PipelineVersion } from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { pipelineVersionsKey } from "../../../shared/pipeline/history";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { CardSection, Chip, ErrorLine, Loading, ViewHeader } from "../../kit";
import { PipelineViews, usePipelineName } from "../shared";
import { AskAssistantButton } from "../board/header";
import { VersionDiff } from "./VersionDiff";

/**
 * What changed between two versions of a pipeline, read-only (EO-327,
 * `ARCHITECTURE.md`, "Publish, lock and versions") — a view of its own at
 * `/pipelines/:id/changes` (EO-524).
 *
 * The address says what is compared (`changesComparedOf`): `?from=&to=`
 * for two published versions, `?local` for this machine's own edits to
 * an organisation pipeline (EO-331, "Divergence and suggestions"), and
 * nothing for the newest two with those edits above them. The board's
 * banner, the diverged chip and the Graph view's history each open it on
 * the comparison they are about.
 *
 * Nothing here writes, and nothing here picks: no publish, no restore, no
 * discard, and no input. A pipeline is changed through the assistant, so
 * the one button is the way to it.
 */
export function PipelineChangesView({ pipelineId }: { pipelineId: string }) {
  const name = usePipelineName(pipelineId);
  const [searchParams] = useSearchParams();
  const compared = changesComparedOf((param) => searchParams.get(param));
  const shown = changesShown(compared);
  const from = compared.kind === "versions" ? compared.from : null;
  const to = compared.kind === "versions" ? compared.to : null;

  // What is compared, as the address names it, for the assistant
  // (`view:current`): identifiers only, resolved again in the main process.
  useViewParameters({
    filter: {
      text: "",
      facets: compared.kind === "local" ? { local: "true" } : { ...(from === null ? {} : { from: String(from) }), ...(to === null ? {} : { to: String(to) }) },
    },
  });

  const answer = useQuery({
    queryKey: [...pipelineVersionsKey(pipelineId), from, to],
    queryFn: () => ipcQuery("pipeline:versions", { pipelineId, ...(from === null ? {} : { from }), ...(to === null ? {} : { to }) }),
  });
  // Open beside the assistant, so what its cards apply lands while this is drawn: a
  // publish files a newer version, and discarding local edits leaves none to show.
  useInvalidateOnPush("config:changed", pipelineVersionsKey(pipelineId));

  const versions = answer.data?.versions ?? [];
  const diff = shown.versions ? (answer.data?.diff ?? null) : null;
  const local = shown.local ? (answer.data?.local ?? null) : null;
  const versionOf = (number: number) => versions.find((version) => version.number === number);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ViewHeader
        title={`${name} — changes`}
        stackActions
        meta="A version is what work entering the pipeline takes. Anything already on it finishes on the version it entered on, so this is read-only: history is not something to edit. To change the pipeline, ask the assistant."
        actions={
          <>
            <PipelineViews pipelineId={pipelineId} current="changes" />
            <AskAssistantButton />
          </>
        }
      />

      {answer.isLoading ? <Loading>Reading the versions…</Loading> : null}
      {answer.error ? <ErrorLine>{answer.error.message}</ErrorLine> : null}

      {local === null ? null : (
        <section aria-label="Your edits" data-testid="local-changes" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 px-1">
            <h2 className="text-[14px] font-medium text-ink">Your edits</h2>
            <p className="text-[12.5px] leading-relaxed text-ink-subtle">
              What this machine has changed since {versionLabel(local.basedOn)}, which is the version it was based on. Nobody else has this: it is
              published nowhere until you suggest it and an administrator approves it. To throw it away, ask the assistant to discard your edits.
            </p>
          </div>
          <VersionDiff diff={local.diff} kinds />
        </section>
      )}

      {!answer.isLoading && compared.kind === "local" && local === null ? (
        <p className="px-1 text-[12.5px] text-ink-subtle">This machine has no edits of its own to this pipeline, so there is nothing of yours to compare.</p>
      ) : null}

      {!answer.isLoading && shown.versions && diff === null ? (
        <p className="px-1 text-[12.5px] text-ink-subtle">
          {local === null
            ? "This pipeline has one version, so there is nothing to compare it with."
            : "There is one published version, so there is no history to compare beside your edits."}
        </p>
      ) : null}

      {diff === null ? null : (
        <section aria-label="Published versions" className="flex flex-col gap-3">
          {local === null ? null : <h2 className="px-1 text-[14px] font-medium text-ink">What your organisation published</h2>}
          <CardSection title="Comparing">
            <p data-testid="compared" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-muted">
              <Version number={diff.from} version={versionOf(diff.from)} />
              <span>with</span>
              <Version number={diff.to} version={versionOf(diff.to)} />
            </p>
          </CardSection>
          <VersionDiff diff={diff} kinds />
        </section>
      )}
    </div>
  );
}

/** One side of the comparison: its number, and who filed it when — a template update named as one (EO-536). */
function Version({ number, version }: { number: number; version: PipelineVersion | undefined }) {
  const update = version === undefined ? null : templateUpdateOfAuthor(version.createdBy);
  const by =
    version === undefined
      ? null
      : update !== null
        ? update.version === null
          ? update.slug
          : `${update.slug} ${templateVersionLabel(update.version)}`
        : version.createdBy === null
          ? "EO"
          : (version.createdByName ?? "someone no longer listed");
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <span className="font-mono text-ink">{versionLabel(number)}</span>
      {update === null ? null : <TemplateUpdateChip />}
      {version === undefined ? null : (
        <span className="text-ink-subtle">
          · {by} · {new Date(version.createdAt).toLocaleString()}
        </span>
      )}
    </span>
  );
}

/** The mark on a version a template update wrote rather than a person (EO-536). */
export function TemplateUpdateChip() {
  return <Chip title="EO wrote this version itself, applying an update to the template this pipeline came from.">Template update</Chip>;
}
