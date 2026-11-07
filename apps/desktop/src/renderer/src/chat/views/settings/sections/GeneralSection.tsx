import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipcQuery } from "../../../../query/client";
import { settingsKey } from "../../../../query/hooks";
import { useViewParameters } from "../../../../shared/view/ViewPublisher";
import { unsavedEditsBetween } from "../../../../shared/settings/primitives";
import { withArticle } from "../../../parts";
import { Button, CardSection, ErrorLine, Facts, Field, Loading, TextInput } from "../../../kit";
import { useShowTour } from "../../../tour/Tour";
import { Note } from "../core/fields";
import { useItemWords } from "../core/words";

/**
 * Settings → General: how branches are named, what today has cost, and
 * how much history pipelines and modules keep.
 */
export function GeneralSection() {
  return (
    <>
      <BranchPrefixCard />
      <SpendCard />
      <CardSection title="Pipeline history" description="Every save of a pipeline files a version you can look back at and restore from.">
        <VersionsToKeepField setting="pipelineVersionsToKeep" label="Pipeline versions to keep">
          <PipelineHistoryNote />
        </VersionsToKeepField>
      </CardSection>
      <CardSection
        title="Module history"
        description="Every save that changes a module's code or manifest files a version, with its test cases and whether it was approved."
      >
        <VersionsToKeepField setting="moduleVersionsToKeep" label="Module versions to keep">
          For each module. Older versions are deleted the next time that module is saved — never the one it is on. A deleted version no longer
          counts when a restored module is checked for an earlier approval.
        </VersionsToKeepField>
      </CardSection>
      <TourCard />
    </>
  );
}

/** Replays the first-board tour (EO-667) from its first stop, on the board. Absent where no tour is drawn — the canvas's own window. */
function TourCard() {
  const showTour = useShowTour();
  if (showTour === null) return null;
  return (
    <CardSection
      title="Tour"
      description="A short walk through where things are: the board, the assistant, the rail, Agents, Agent tools and Settings."
      actions={<Button onClick={showTour}>Show the tour</Button>}
    />
  );
}

function PipelineHistoryNote() {
  const words = useItemWords();
  return (
    <>
      For each pipeline. Older versions are deleted the next time that pipeline is saved — never the one it is on, and never one {withArticle(words.one)} is still finishing on, archived {words.many} included.
    </>
  );
}

/**
 * The path segment before `/<KEY>` in a branch name (EO-14, EO-15).
 *
 * Held as a draft while it is typed, so a box cleared to retype does not
 * snap back. An empty prefix is never written — and a cleared box is
 * published as typed and not saved (EO-192), because it holds a value
 * nothing in EO has.
 */
function BranchPrefixCard() {
  const queryClient = useQueryClient();
  const words = useItemWords();
  const settings = useQuery({ queryKey: settingsKey, queryFn: () => ipcQuery("settings:get", undefined) });
  const save = useMutation({
    mutationFn: (branchPrefix: string) => ipcQuery("settings:set", { branchPrefix }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKey }),
  });
  const [draft, setDraft] = useState<string | null>(null);

  const stored = settings.data?.branchPrefix;
  const prefix = draft ?? stored;

  useViewParameters({
    unsavedEdits:
      draft === null || stored === undefined ? [] : unsavedEditsBetween({ branchPrefix: draft }, { branchPrefix: stored }, { branchPrefix: "Branch prefix" }),
  });

  return (
    <CardSection title="Workspace" description={`How EO names the branch it cuts for each ${words.one}.`}>
      {prefix === undefined ? (
        settings.isError ? (
          <ErrorLine>EO could not read its settings.</ErrorLine>
        ) : (
          <Loading />
        )
      ) : (
        <div className="flex max-w-[24rem] flex-col gap-1.5">
          <Field label="Branch prefix">
            <TextInput
              value={prefix}
              className="font-mono"
              onChange={(event) => {
                setDraft(event.target.value);
                // Allowed to be empty for a moment while it is retyped;
                // that moment is never saved.
                if (event.target.value.trim() !== "") save.mutate(event.target.value);
              }}
            />
          </Field>
          <Note>
            Branches are named <code className="font-mono text-ink-muted">{(prefix || "eo") + "/<KEY>"}</code>. Branches already created keep the prefix they
            were cut with.
          </Note>
        </div>
      )}
    </CardSection>
  );
}

function SpendCard() {
  const daily = useQuery({ queryKey: ["costs", "daily"], queryFn: () => ipcQuery("costs:getDaily", {}) });
  const usd = (cents: number) => <span className="font-mono">{(cents / 100).toFixed(2)} USD</span>;
  const total = daily.data?.costCents ?? 0;
  // EO's own short model calls are part of today's figure and listed as
  // their own lines beneath it (EO-477), so a person can see what is not
  // a run's.
  const sideCalls = daily.data?.sideCalls ?? [];
  const runs = total - sideCalls.reduce((sum, line) => sum + line.costCents, 0);
  return (
    <CardSection title="Spend" description="Summed from runs and EO's own short model calls — the same figures the budget guards check.">
      <Facts
        label="Spend"
        items={[
          { term: "Today", value: usd(total) },
          ...(sideCalls.length > 0 ? [{ term: "Agent runs", value: usd(runs) }, ...sideCalls.map((line) => ({ term: line.label, value: usd(line.costCents) }))] : []),
        ]}
      />
    </CardSection>
  );
}

/**
 * One "versions to keep" box (EO-359, EO-360).
 *
 * Held as text while it is typed, for the branch prefix's reason. Only a
 * whole number of one or more is ever written; anything else says so
 * under the box rather than being rounded into something nobody typed.
 */
function VersionsToKeepField({
  setting,
  label,
  children,
}: {
  setting: "pipelineVersionsToKeep" | "moduleVersionsToKeep";
  label: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: settingsKey, queryFn: () => ipcQuery("settings:get", undefined) });
  const save = useMutation({
    mutationFn: (count: number) => ipcQuery("settings:set", { [setting]: count }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKey }),
  });
  const [draft, setDraft] = useState<string | null>(null);

  const stored = settings.data?.[setting];
  if (stored === undefined) return settings.isError ? <ErrorLine>EO could not read its settings.</ErrorLine> : <Loading />;
  const text = draft ?? String(stored);
  const whole = (value: string) => /^\d+$/.test(value.trim()) && Number(value.trim()) >= 1;
  const valid = whole(text);

  return (
    <div className="flex max-w-[24rem] flex-col gap-1.5">
      <Field label={label}>
        <TextInput
          type="number"
          min={1}
          step={1}
          value={text}
          aria-invalid={!valid}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            if (whole(next)) save.mutate(Number(next.trim()));
          }}
          onBlur={() => {
            if (valid) setDraft(null);
          }}
        />
      </Field>
      {valid ? null : <ErrorLine>A whole number, 1 or more.</ErrorLine>}
      <Note>{children}</Note>
    </div>
  );
}
