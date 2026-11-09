import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PUBLISHED_SECTIONS, SECTION_LABELS, versionLabel, type PublishedSection } from "@eo/core";
import { ipcQuery } from "../../../../query/client";
import { pipelinesKey, sectionsKey, useLockedSections, usePipelines } from "../../../../query/hooks";
import { Button, CardSection, Chip, ConfirmDialog, ErrorLine, Field, Select } from "../../../kit";

/**
 * Settings → Publishing: publishing a section to every signed-in desktop,
 * and rolling one back (EO-329, `ARCHITECTURE.md`, "Publish, lock and versions"), in the chat
 * layout's terms.
 *
 * Drawn only where an admin is — the browser they opened the
 * organisation's address in (`organisation: true` in the nav).
 *
 * A confirmation rather than a button: an item binds to the version it
 * entered on and finishes there (EO-327), so publishing over a busy
 * pipeline leaves two graphs live for as long as that work takes. The
 * preflight's "N items in flight across M desktops finish on v6" is what
 * turns pressing Publish into a decision, and it writes nothing.
 */

/** Four of the five: policy is published from its own screen (EO-328). */
const PUBLISHABLE_HERE = PUBLISHED_SECTIONS.filter((section) => section !== "policy");

interface Asking {
  section: PublishedSection;
  pipelineId: string | null;
  versionNumber: number | null;
  line: string;
}

export function PublishingSection() {
  const queryClient = useQueryClient();
  const sections = useLockedSections();
  const [pending, setPending] = useState<Asking | null>(null);

  const preflight = useMutation({
    mutationFn: (input: { section: PublishedSection; pipelineId: string | null; versionNumber: number | null }) =>
      ipcQuery("sections:publishPreflight", input).then((answer) => ({ input, answer })),
    onSuccess: ({ input, answer }) => {
      setPending({ ...input, line: answer.problem ?? answer.confirmation });
    },
  });

  const publish = useMutation({
    mutationFn: (input: { section: PublishedSection; pipelineId: string | null; versionNumber: number | null }) => ipcQuery("sections:publish", input),
    onSuccess: () => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: sectionsKey });
      // A rollback has just rewritten a graph; the pipelines are stale.
      void queryClient.invalidateQueries({ queryKey: pipelinesKey(null) });
    },
  });

  const busy = preflight.isPending || publish.isPending;

  return (
    <>
      <CardSection
        title="Publishing"
        description="What this organisation manages for every signed-in desktop. Each section you publish locks there — per section, never per field — and the people using it keep their own sign-ins, folders and secrets. Policy is published from the Policy screen."
      >
        <ul aria-label="Sections" className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
          {PUBLISHABLE_HERE.map((section) => {
            const rows = sections.published.filter((row) => row.section === section);
            const published = rows[0];
            return (
              <li key={section} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="text-[13px] text-ink">{SECTION_LABELS[section]}</span>
                    {published === undefined ? null : <Chip tone="tag">published</Chip>}
                  </span>
                  <span className="text-[11.5px] text-ink-subtle">
                    {published === undefined
                      ? "Not published — every desktop edits this for itself."
                      : `Published${published.publishedByName === null ? "" : ` by ${published.publishedByName}`}${
                          rows.length > 1 ? ` · ${String(rows.length)} pipelines` : ""
                        }${published.versionNumber === null ? "" : ` · ${versionLabel(published.versionNumber)}`}`}
                  </span>
                </div>
                <Button
                  size="sm"
                  aria-label={`${published === undefined ? "Publish" : "Publish again"} ${SECTION_LABELS[section]}`}
                  disabled={busy}
                  onClick={() => preflight.mutate({ section, pipelineId: null, versionNumber: null })}
                >
                  {published === undefined ? "Publish" : "Publish again"}
                </Button>
              </li>
            );
          })}
        </ul>
        {preflight.error ? <ErrorLine>{preflight.error.message}</ErrorLine> : null}
        {publish.data?.problem != null ? <ErrorLine>{publish.data.problem}</ErrorLine> : null}
        {publish.error ? <ErrorLine>{publish.error.message}</ErrorLine> : null}
        {publish.data?.problem === null ? (
          <p role="status" className="text-[12.5px] text-ink-muted">
            {publish.data.confirmation}
          </p>
        ) : null}
      </CardSection>

      <RollBack onAsk={(pipelineId, versionNumber) => preflight.mutate({ section: "pipelines", pipelineId, versionNumber })} busy={busy} />

      <ConfirmDialog
        open={pending !== null}
        title={
          pending === null
            ? ""
            : pending.versionNumber === null
              ? `Publish ${SECTION_LABELS[pending.section]} to every signed-in desktop?`
              : `Roll this pipeline back to ${versionLabel(pending.versionNumber)} and publish it?`
        }
        confirmLabel="Confirm"
        busy={publish.isPending}
        onConfirm={() => {
          if (pending !== null) publish.mutate({ section: pending.section, pipelineId: pending.pipelineId, versionNumber: pending.versionNumber });
        }}
        onCancel={() => setPending(null)}
      >
        <p>{pending?.line}</p>
      </ConfirmDialog>
    </>
  );
}

/**
 * Rolling one pipeline back to a version it had: its own card, because it
 * names one pipeline and one of its versions where the row above publishes
 * "the pipelines as they now stand". Rollback is publishing an older
 * version again (ARCHITECTURE.md, "Publish, lock and versions"), so it ends at the same channel and
 * confirmation.
 */
function RollBack({ onAsk, busy }: { onAsk: (pipelineId: string, versionNumber: number) => void; busy: boolean }) {
  const { pipelines } = usePipelines(null);
  const [pipelineId, setPipelineId] = useState<string>("");
  const [version, setVersion] = useState<string>("");
  const chosen = pipelineId === "" ? (pipelines[0]?.id ?? "") : pipelineId;

  const versions = useQuery({
    queryKey: ["pipelineVersions", chosen],
    queryFn: () => ipcQuery("pipeline:versions", { pipelineId: chosen }),
    enabled: chosen !== "",
  });
  const available = versions.data?.versions ?? [];

  if (pipelines.length === 0) return null;

  return (
    <CardSection title="Roll back" description="Publish a pipeline as one of its earlier versions.">
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <Field label="Pipeline" className="min-w-[10rem] flex-1">
          <Select
            value={chosen}
            onChange={(event) => {
              setPipelineId(event.target.value);
              setVersion("");
            }}
          >
            {pipelines.map((pipeline) => (
              <option key={pipeline.id} value={pipeline.id}>
                {pipeline.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="To" className="min-w-[10rem] flex-1">
          <Select aria-label="Version" value={version} onChange={(event) => setVersion(event.target.value)}>
            <option value="">Choose a version</option>
            {available.map((one) => (
              <option key={one.number} value={String(one.number)}>
                {versionLabel(one.number)}
              </option>
            ))}
          </Select>
        </Field>
        <Button disabled={busy || version === "" || chosen === ""} onClick={() => onAsk(chosen, Number(version))}>
          Roll back
        </Button>
      </div>
    </CardSection>
  );
}
