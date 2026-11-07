import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, Circle, FolderOpen, LayoutGrid, PlugZap } from "lucide-react";
import type { GalleryNeedView, GalleryTemplateView } from "@eo/core";
import { machineAvailable } from "../../../ipc/bridge";
import { ipcQuery } from "../../../query/client";
import { galleryKey } from "../../../query/hooks";
import { ManagedSection } from "../../managed/ManagedSection";
import { Button, CardSection, Chip, EmptyState, ErrorLine, Field, GroupLabel, Loading, Select, TextInput, ViewHeader } from "../../kit";
import { NeedsCheck } from "./NeedsCheck";

/**
 * `/gallery`: start with a template (EO-316, `ARCHITECTURE.md`,
 * "What a person sees first").
 *
 * Each card is a pack with a plain description and a "what this needs"
 * list, a Preview that costs nothing, and a Use this that asks the
 * template's own blanks. Three states and one gesture — the cards, the
 * short form, and the needs check the form lands on — so they are one
 * view, with no change of address in the middle of a sentence.
 *
 * Inside the "packs" managed section: installing a pack is how pipelines,
 * agents, types and connectors arrive at once, so a published packs
 * section fences it (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
 */
export function GalleryView() {
  return (
    <ManagedSection section="packs">
      <Gallery />
    </ManagedSection>
  );
}

/**
 * The gallery's three states, without the managed-section fence: what
 * `/gallery` draws inside it, and what first run draws on its own
 * (`chat/firstRun/FirstRun.tsx`), as it always has. `onFinished` is the
 * needs check's way out, which first run listens for to close behind it.
 *
 * `needsCodingAgent` is first run's, given while nothing on this machine
 * is signed in (EO-659): every Use this waits for a coding agent and says
 * so, with the way back to the step that connects one. Preview does not
 * wait — it runs on nothing real.
 */
export function Gallery({
  onFinished,
  needsCodingAgent,
}: {
  onFinished?: () => void;
  needsCodingAgent?: { onConnect: () => void };
} = {}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const gallery = useQuery({ queryKey: galleryKey, queryFn: () => ipcQuery("gallery:list", undefined) });
  /**
   * The card somebody pressed "Use this" on, held whole: the list
   * refetches on focus, and a site republishing the same slug must not
   * swap the form's subject out from under them. Its token makes the main
   * process install that one.
   */
  const [chosen, setChosen] = useState<GalleryTemplateView | null>(null);
  /** Where "Use this" landed: the needs check, about a project that now exists. */
  const [landed, setLanded] = useState<{
    needs: GalleryNeedView[];
    template: GalleryTemplateView;
    projectId: string;
    pipelineId: string | null;
    jobId: string | null;
  } | null>(null);

  const templates = gallery.data?.templates ?? [];

  const preview = useMutation({
    mutationFn: (entry: GalleryTemplateView) => ipcQuery("gallery:preview", { slug: entry.slug, token: entry.token }),
    // Straight onto the item: watching it is the whole point (ARCHITECTURE.md, "Preview").
    onSuccess: (result) => {
      if (result.itemId !== null) void navigate(`/items/${result.itemId}`);
    },
  });

  if (landed !== null) {
    return (
      <NeedsCheck
        template={landed.template}
        projectId={landed.projectId}
        needs={landed.needs}
        jobId={landed.jobId}
        // The pipeline just installed, by id: `/project` would be the board EO ships.
        pipelineId={landed.pipelineId}
        onFinished={() => onFinished?.()}
      />
    );
  }

  if (chosen !== null) {
    return (
      <UseForm
        template={chosen}
        people={gallery.data?.people ?? []}
        onCancel={() => setChosen(null)}
        onCreated={(result) => {
          void queryClient.invalidateQueries();
          setLanded({ needs: result.needs, template: chosen, projectId: result.projectId, pipelineId: result.pipelineId, jobId: result.jobId });
        }}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ViewHeader
        icon={<LayoutGrid size={15} />}
        title="Start with a template"
        meta="Each of these sets up a whole pipeline: what gets filed, who does which step, and where it lands. Preview one first — nothing is sent and nothing costs money."
        actions={<Chip>{templates.length}</Chip>}
      />

      {gallery.isLoading ? <Loading>Looking…</Loading> : null}
      {/* No error state, deliberately (ARCHITECTURE.md, "The gallery"): an unreachable index is a
          supported state, and the bundled set is never hidden. */}
      {!gallery.isLoading && templates.length === 0 ? (
        <EmptyState title="This build ships no templates.">Describe what you want to the assistant instead.</EmptyState>
      ) : null}

      <div className="@container">
        <ul aria-label="Templates" className="grid grid-cols-1 items-stretch gap-3 @3xl:grid-cols-2">
          {templates.map((entry) => (
            <li key={entry.slug} className="flex min-w-0">
              <TemplateCard
                template={entry}
                busy={preview.isPending}
                onPreview={() => preview.mutate(entry)}
                onUse={() => setChosen(entry)}
                {...(needsCodingAgent ? { onConnect: needsCodingAgent.onConnect } : {})}
              />
            </li>
          ))}
        </ul>
      </div>
      {preview.data?.problem ? <ErrorLine>{preview.data.problem}</ErrorLine> : null}
    </div>
  );
}

/**
 * One card: what it does, what it needs, and the two things to do with it.
 * `onConnect` present means no coding agent is signed in yet, so Use this
 * waits and the card says why, with the button that fixes it.
 */
function TemplateCard({
  template,
  busy,
  onPreview,
  onUse,
  onConnect,
}: {
  template: GalleryTemplateView;
  busy: boolean;
  onPreview: () => void;
  onUse: () => void;
  onConnect?: () => void;
}) {
  return (
    <section aria-label={template.title} className="flex h-full w-full min-w-0 flex-col gap-3 rounded-[14px] bg-canvas px-[18px] py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="text-[14px] font-medium text-ink">{template.title}</h2>
        {/* Where it came from and what version it is at (ARCHITECTURE.md, "The gallery"). */}
        <span className="text-[11.5px] text-ink-subtle">
          {template.source} · {template.version}
        </span>
      </div>
      <p className="text-[13px] leading-relaxed text-ink-muted">{template.description}</p>

      {template.needs.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <GroupLabel>What this needs</GroupLabel>
          <ul className="flex flex-col gap-1">
            {template.needs.map((need) => (
              <li key={need.key} className="flex items-start gap-2 text-[12.5px] text-ink-muted">
                {need.met ? (
                  <Check size={13} aria-label="Ready" className="mt-[3px] shrink-0 text-running" />
                ) : (
                  <Circle size={13} aria-label="Not yet" className="mt-[3px] shrink-0 text-ink-subtle" />
                )}
                <span>{need.line}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* On the card's bottom edge, so a row of cards has its actions on one line. */}
      <div className="mt-auto flex flex-col gap-2 pt-1">
        {onConnect ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-ink-subtle">Using this needs a coding agent signed in.</span>
            <Button size="sm" icon={<PlugZap size={12} />} onClick={onConnect}>
              Connect a coding agent
            </Button>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={onConnect !== undefined} onClick={onUse}>
            Use this
          </Button>
          <Button disabled={busy || !template.previewable} onClick={onPreview}>
            Preview
          </Button>
        </div>
      </div>
    </section>
  );
}

/** What the days are called on the schedule blank, in `parseScheduleAnswer`'s spelling. */
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "daily"];

/**
 * The template's own blanks, one line each (ARCHITECTURE.md, "The gallery") — nothing invented by
 * the view: the fields are what `gallery:list` said the pack asks for.
 */
function UseForm({
  template,
  people,
  onCancel,
  onCreated,
}: {
  template: GalleryTemplateView;
  /** Who a role slot may be given to. Empty in solo mode, where no picker is drawn. */
  people: readonly { id: string; name: string }[];
  onCancel: () => void;
  onCreated: (result: { needs: GalleryNeedView[]; projectId: string; pipelineId: string | null; jobId: string | null }) => void;
}) {
  const initial = useMemo(() => Object.fromEntries(template.blanks.map((blank) => [blank.key, blank.default])), [template]);
  const [answers, setAnswers] = useState<Record<string, string>>(initial);
  const [roleSlots, setRoleSlots] = useState<Record<string, string>>({});
  const [name, setName] = useState(template.title);

  const set = (key: string, value: string) => setAnswers((current) => ({ ...current, [key]: value }));

  const pick = useMutation({
    mutationFn: (key: string) => ipcQuery("dialog:pickDirectory", { title: "Choose a folder" }).then((result) => ({ key, path: result.path })),
    onSuccess: ({ key, path }) => {
      if (path) set(key, path);
    },
  });

  const create = useMutation({
    // The token as well as the slug: install the pack whose form this is.
    mutationFn: () => ipcQuery("gallery:use", { slug: template.slug, token: template.token, answers, roleSlots, projectName: name }),
    onSuccess: (result) => {
      if (result.problem === null && result.projectId !== null) {
        onCreated({ needs: result.needs, projectId: result.projectId, pipelineId: result.pipelineId, jobId: result.jobId });
      }
    },
  });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ViewHeader icon={<LayoutGrid size={15} />} title={template.title} meta="A few things EO cannot guess." />

      <CardSection title="Set it up" className="max-w-[40rem]">
        <Field label="Project name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        {template.blanks.map((blank) => (
          <Field key={blank.key} label={blank.label} {...(blank.help === "" ? {} : { hint: blank.help })}>
            {blank.kind === "folder" ? (
              <span className="flex min-w-0 items-center gap-2">
                <TextInput aria-label={blank.label} value={answers[blank.key] ?? ""} onChange={(event) => set(blank.key, event.target.value)} placeholder="/Users/you/reports" />
                {/* A round trip to the main process — and none on a server (EO-319), where the path is typed. */}
                {machineAvailable() ? (
                  <Button icon={<FolderOpen size={12} />} disabled={pick.isPending} onClick={() => pick.mutate(blank.key)}>
                    Choose
                  </Button>
                ) : null}
              </span>
            ) : blank.kind === "schedule" ? (
              <ScheduleField value={answers[blank.key] ?? ""} label={blank.label} onChange={(value) => set(blank.key, value)} />
            ) : blank.kind === "connector" ? (
              // Authorised on the needs check, with the one button that does
              // it: never a credential before anything is agreed.
              <span className="text-[12.5px] text-ink-subtle">You authorise this after the project is made.</span>
            ) : blank.valueType === "boolean" ? (
              <Select aria-label={blank.label} value={answers[blank.key] ?? ""} onChange={(event) => set(blank.key, event.target.value)}>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            ) : (
              <TextInput
                aria-label={blank.label}
                {...(blank.valueType === "number" ? { type: "number" } : {})}
                value={answers[blank.key] ?? ""}
                onChange={(event) => set(blank.key, event.target.value)}
              />
            )}
          </Field>
        ))}

        {/* Solo mode: pre-filled with "you" by the main process and not
            drawn (ARCHITECTURE.md, "The gallery"). Otherwise a picker of the people EO knows, since
            what travels is an id nobody can type. */}
        {template.solo
          ? null
          : template.roleSlots.map((slot) => (
              <Field key={slot.stepId} label={slot.name} hint="Who decides at this step">
                <Select
                  aria-label={slot.name}
                  value={roleSlots[slot.stepId] ?? ""}
                  onChange={(event) => setRoleSlots((current) => ({ ...current, [slot.stepId]: event.target.value }))}
                >
                  {/* Empty is a real answer: the step waits for whoever is there. */}
                  <option value="">Anybody</option>
                  {people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}

        {create.data?.problem ? <ErrorLine>{create.data.problem}</ErrorLine> : null}
        {create.error ? <ErrorLine>{create.error.message}</ErrorLine> : null}

        <div className="flex items-center gap-2 pt-1">
          <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>
            Create
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Back
          </Button>
        </div>
      </CardSection>
    </div>
  );
}

/** A day and a time, which is what the design's blank asks — not a cron expression. */
function ScheduleField({ value, label, onChange }: { value: string; label: string; onChange: (value: string) => void }) {
  const [day = "monday", time = "08:00"] = value.split(" ");
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Select aria-label={`${label} — day`} value={day} onChange={(event) => onChange(`${event.target.value} ${time}`)}>
        {DAYS.map((candidate) => (
          <option key={candidate} value={candidate}>
            {candidate === "daily" ? "Every day" : candidate[0]!.toUpperCase() + candidate.slice(1)}
          </option>
        ))}
      </Select>
      <TextInput aria-label={`${label} — time`} type="time" value={time} onChange={(event) => onChange(`${day} ${event.target.value}`)} />
    </span>
  );
}
