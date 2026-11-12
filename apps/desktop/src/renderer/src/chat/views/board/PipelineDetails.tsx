import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { pipelineChangesPath, templateUpdateOfAuthor, versionLabel } from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { pipelineStepsKey, useDivergence, useLockedSections, useWebhookUnattended } from "../../../query/hooks";
import { useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { pipelineHistoryKey, pipelineVersionsKey } from "../../../shared/pipeline/history";
import { CardSection, Chip, ErrorLine, Facts, Loading } from "../../kit";
import { TemplateUpdateChip } from "../changes/PipelineChangesView";
import { WatchIntakeFact } from "./WatchIntake";

/**
 * What a pipeline is beyond its steps, read-only (EO-524): what work must
 * have to enter it (EO-736), every version
 * it has had and who filed each, whether what a webhook files on it is
 * sent on unread, and whether it is the organisation's and this
 * machine's copy has gone its own way.
 *
 * Each version opens the Changes view against the one before it, and a
 * diverged copy opens it on this machine's own edits. Nothing here
 * writes: restoring a version, discarding edits and the webhook setting
 * are each the assistant's card to offer and the person's to press.
 */
export function PipelineDetails({ pipelineId }: { pipelineId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Settings pipelineId={pipelineId} />
      <EntryRules pipelineId={pipelineId} />
      <History pipelineId={pipelineId} />
    </div>
  );
}

function Settings({ pipelineId }: { pipelineId: string }) {
  const { entry, unattended } = useWebhookUnattended(pipelineId);
  const sections = useLockedSections();
  const divergence = useDivergence(pipelineId);
  // Whose it is, from what was published — never from the lock. A lock says
  // what this machine may write, and the organisation's own record carries
  // none over the pipelines it publishes. A published row names this
  // pipeline (`subjectId`); `available` is the same row read by divergence;
  // and only a published pipeline has a copy to diverge.
  const published = sections.published.find((row) => row.section === "pipelines" && row.subjectId === pipelineId);
  const managed = published !== undefined || divergence.available !== null || divergence.diverged;
  const number = published?.versionNumber ?? divergence.available;
  const by = published?.publishedByName ?? null;
  const publication = number === null ? "" : ` (${versionLabel(number)}${by === null ? "" : `, by ${by}`})`;

  const webhook = !entry ? "No webhook job files onto this pipeline." : unattended ? "Sent on unread — a step that sends can act on them before anybody here reads them." : "Read by a person before any step that sends.";
  const organisation = !managed ? (
    "No — this machine's own pipeline."
  ) : divergence.diverged ? (
    <span className="flex flex-col gap-1">
      <span>Yes — your organisation publishes it{publication}, and this machine's copy has diverged: its updates no longer reach it.</span>
      {divergence.line === null ? null : <span className="text-ink-subtle">{divergence.line}</span>}
      <Link to={pipelineChangesPath(pipelineId, { kind: "local" })} className="text-ink underline-offset-2 hover:underline">
        See your edits
      </Link>
    </span>
  ) : (
    `Yes — your organisation publishes it${publication}, and this machine's copy follows what it publishes.`
  );

  return (
    <CardSection title="Pipeline settings" description="To change either, ask the assistant; it offers a card whose button does it.">
      <Facts
        label="Pipeline settings"
        items={[
          { term: "Webhook items", value: webhook },
          { term: "Watch intake", value: <WatchIntakeFact pipelineId={pipelineId} /> },
          { term: "Organisation pipeline", value: organisation },
        ]}
      />
    </CardSection>
  );
}

/**
 * What work must have to enter (EO-610, EO-736), read-only like the rest
 * of this page: each rule in the words a refusal would use, a module
 * rule's module by name with its time limit. Changing them is the
 * assistant's: it offers a draft, and a person publishes it.
 */
function EntryRules({ pipelineId }: { pipelineId: string }) {
  const answer = useQuery({ queryKey: pipelineStepsKey(pipelineId), queryFn: () => ipcQuery("pipelineSteps:list", { pipelineId }) });
  useInvalidateOnPush("config:changed", pipelineStepsKey(pipelineId));
  const lines = answer.data?.entryRuleLines ?? [];

  return (
    <CardSection title="Entry rules" description="What work must have before it may enter this pipeline. To change them, ask the assistant; it offers a draft to publish.">
      {answer.isLoading ? <Loading>Reading the rules…</Loading> : null}
      {answer.error ? <ErrorLine>{answer.error.message}</ErrorLine> : null}
      {!answer.isLoading && !answer.error && lines.length === 0 ? <p className="text-[12.5px] text-ink-subtle">None — work enters with nothing asked of it.</p> : null}
      {lines.length === 0 ? null : (
        <ul aria-label="Entry rules" className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] text-ink">
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </CardSection>
  );
}

function History({ pipelineId }: { pipelineId: string }) {
  const answer = useQuery({ queryKey: pipelineHistoryKey(pipelineId), queryFn: () => ipcQuery("pipeline:versions", { pipelineId }) });
  // A publish or a restore applied from the assistant while this is open files a version.
  useInvalidateOnPush("config:changed", pipelineVersionsKey(pipelineId));
  const versions = [...(answer.data?.versions ?? [])].sort((a, b) => b.number - a.number);
  const current = answer.data?.current ?? null;

  return (
    <CardSection title="History" description="Every version kept, newest first. Each opens what it changed from the one before.">
      {answer.isLoading ? <Loading>Reading the versions…</Loading> : null}
      {answer.error ? <ErrorLine>{answer.error.message}</ErrorLine> : null}
      {!answer.isLoading && versions.length === 0 ? <p className="text-[12.5px] text-ink-subtle">This pipeline has not been published yet.</p> : null}
      <ol aria-label="Versions" className="flex flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
        {versions.map((version, index) => {
          const before = versions[index + 1];
          return (
            <li key={version.id} aria-label={versionLabel(version.number)} className="flex items-start gap-2 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[12.5px] text-ink">{versionLabel(version.number)}</span>
                  {version.number === current ? <Chip>Current</Chip> : null}
                  {templateUpdateOfAuthor(version.createdBy) === null ? null : <TemplateUpdateChip />}
                </span>
                {/* A version EO filed itself has nobody to name. */}
                <span className="text-[11.5px] text-ink-subtle">
                  {version.createdBy === null ? "Saved by EO" : `Saved by ${version.createdByName ?? "someone no longer listed"}`} ·{" "}
                  {new Date(version.createdAt).toLocaleString()}
                </span>
                {/* What the template update that filed it said of itself (EO-728). */}
                {version.releaseNotes === null ? null : (
                  <div className="mt-1 flex flex-col gap-0.5">
                    <span className="text-[11.5px] font-medium text-ink-muted">Release notes</span>
                    <ul aria-label={`Release notes of ${versionLabel(version.number)}`} className="flex flex-col gap-0.5">
                      {version.releaseNotes.split("\n").map((line, at) => (
                        <li key={at} className="text-[11.5px] text-ink-muted">
                          {line}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              {before === undefined ? (
                <span className="shrink-0 text-[11.5px] text-ink-subtle">The first</span>
              ) : (
                <Link
                  to={pipelineChangesPath(pipelineId, { kind: "versions", from: before.number, to: version.number })}
                  aria-label={`What ${versionLabel(version.number)} changed`}
                  className="shrink-0 text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                >
                  Changes
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </CardSection>
  );
}
