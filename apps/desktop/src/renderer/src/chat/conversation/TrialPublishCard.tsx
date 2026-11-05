import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitFork } from "lucide-react";
import { MODULE_COVERAGE_BAR, type AssistCardDetail, type DiscussionMessage, type TrialItemVerdict, type TrialStepOutcome } from "@eo/core";
import { Markdown } from "@eo/ui";
import { ipcQuery } from "../../query/client";
import { itemsKey, modulesKey } from "../../query/hooks";
import { useInvalidateOnPush } from "../../query/useInvalidateOnPush";
import { assistCardKey } from "../../shared/assist/useAssistRoom";
import { PipelineDrawing } from "../graph/PipelineDrawing";
import { DraftModuleRow } from "../modules/DraftModuleRow";
import { Button, Chip, type Tone } from "../kit";

type Detail = Extract<AssistCardDetail, { kind: "trialPublish" }>;
type Answer = Awaited<ReturnType<typeof publishTrial>>;

const STEP: Record<TrialStepOutcome, { label: string; tone: Tone }> = {
  tested: { label: "Tested", tone: "success" },
  redirected: { label: "Redirected", tone: "running" },
  mocked: { label: "Mocked — never ran", tone: "paused" },
  not_run: { label: "Reached, never ran", tone: "danger" },
  not_reached: { label: "Not reached", tone: "danger" },
};

const VERDICT: Record<TrialItemVerdict, { label: string; tone: Tone }> = {
  passed: { label: "Ended where expected", tone: "success" },
  failed: { label: "Did not end where expected", tone: "danger" },
  unfinished: { label: "Has not ended", tone: "paused" },
};

function publishTrial(conversationId: string, messageId: string, acknowledgeLowCoverage: readonly string[]) {
  return ipcQuery("assist:publishTrial", { conversationId, messageId, acknowledgeLowCoverage: [...acknowledgeLowCoverage] });
}

/**
 * The publish card after a draft's trials (EO-588): what was proven, and
 * the one button that publishes the pipeline and approves every module
 * it runs.
 *
 * Everything on it is read with `assist:card` from the trial itself, not
 * from anything the assistant said: the graph that would be published;
 * what changed since the design the person approved, with a mark on each
 * module whose code moved and a stronger one where its needs did; every
 * step as tested, redirected, mocked or not reached — a mocked step is
 * never called tested; where each test item of the newest round ended
 * against where it was expected to; and what the assistant did in the
 * person's place, which on the live pipeline will be theirs to do.
 *
 * Where a test item did not end where it was expected to — the person
 * chose Publish anyway at a guardrail stop — the card says which, plainly
 * and above the button, and the button says Publish anyway.
 *
 * Pressing it is `assist:publishTrial`: the modules' tests, then their
 * approvals and the publish in one transaction, or nothing — and then the
 * trial is deleted. Coverage under the bar is asked about here, before
 * anything is approved, as on a draft card.
 */
export function TrialPublishCard({ message, conversationId, onDone }: { message: DiscussionMessage; conversationId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const outcome = message.card?.outcome ?? null;
  const open = message.canApprove && outcome === null;
  const read = useQuery({
    queryKey: assistCardKey(message.id),
    queryFn: () => ipcQuery("assist:card", { conversationId, messageId: message.id }),
    // Once pressed the trial is gone, and what came of it is the card.
    enabled: outcome === null,
  });
  useInvalidateOnPush("items:changed", assistCardKey(message.id));
  useInvalidateOnPush("config:changed", assistCardKey(message.id));
  const detail = read.data?.card?.kind === "trialPublish" ? read.data.card : null;

  const [problem, setProblem] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState<Answer["coverage"] | null>(null);
  const publish = useMutation({
    mutationFn: (acknowledged: readonly string[]) => publishTrial(conversationId, message.id, acknowledged),
    onSuccess: (result) => {
      const refused = result.modules.flatMap((module) => (module.outcome === "refused" && module.problem !== null ? [[module.slug, module.problem] as const] : []));
      setRefusals(Object.fromEntries(refused));
      void queryClient.invalidateQueries({ queryKey: modulesKey });
      if (result.coverage.length > 0) {
        setAsking(result.coverage);
        setProblem(null);
        return;
      }
      setAsking(null);
      setProblem(result.problem);
      if (result.saved) {
        void queryClient.invalidateQueries({ queryKey: ["pipelines"] });
        void queryClient.invalidateQueries({ queryKey: itemsKey });
      }
      onDone();
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  const notPassed = detail?.items.filter((item) => item.verdict !== "passed") ?? [];
  const anyway = notPassed.length > 0;
  const label = publish.isPending ? "Running the tests…" : outcome?.done ? "Published" : anyway ? "Publish anyway" : "Approve and publish";

  return (
    <section aria-label="Publish the tested pipeline" className="flex flex-col gap-2.5 rounded-[14px] bg-canvas-subtle px-4 py-3.5">
      <div className="flex items-center gap-2 text-[12.5px] text-ink-muted">
        <GitFork size={14} className="shrink-0" />
        <b className="text-[13px] font-semibold text-ink">{detail?.pipelineName ?? "Pipeline"}</b>
        {detail !== null ? <span>· {detail.steps.length} steps</span> : null}
        <span className="ml-auto text-[11.5px] text-ink-subtle">
          {outcome !== null ? (outcome.done ? "published" : "not published") : detail?.round != null ? `tested · round ${detail.round}` : "tested"}
        </span>
      </div>

      {outcome !== null ? (
        <div className={outcome.done ? "text-[13px] text-ink" : "text-[13px] text-danger"}>
          <Markdown>{outcome.said}</Markdown>
        </div>
      ) : null}
      {outcome === null && read.data?.problem ? <p className="text-xs text-danger">{read.data.problem}</p> : null}

      {detail !== null ? (
        <>
          <PipelineDrawing steps={detail.steps} routes={detail.routes} elsewhere={[]} entryStepId={detail.entryStepId} />
          <Changes detail={detail} />
          {detail.modules.length > 0 ? (
            <ul aria-label="Modules this pipeline runs" className="flex flex-col gap-2">
              {detail.modules.map((module) => (
                <li key={module.id} className="flex flex-col gap-1.5 rounded-[10px] bg-canvas px-3 py-2.5">
                  {module.needsChanged || module.codeChanged || module.replaces !== null ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {module.needsChanged ? <Chip tone="danger">Needs changed since you approved</Chip> : null}
                      {module.codeChanged ? <Chip tone="paused">Code changed since you approved</Chip> : null}
                      {module.replaces !== null ? <Chip>Takes the place of {module.replaces.name}</Chip> : null}
                    </div>
                  ) : null}
                  <DraftModuleRow slug={module.slug} refusal={refusals[module.slug] ?? null} />
                </li>
              ))}
            </ul>
          ) : null}
          <Steps detail={detail} />
          <Items detail={detail} />
          <OnBehalf detail={detail} />
        </>
      ) : null}

      {open && detail !== null && anyway ? (
        <section aria-label="Test items that failed" className="flex flex-col gap-1 rounded-[10px] bg-danger/10 px-3 py-2.5 text-[12.5px] text-ink">
          <p className="font-semibold">
            {notPassed.length === 1 ? "This test item did not end where it was expected to" : "These test items did not end where they were expected to"}. Publishing
            anyway publishes a pipeline that has not been shown to work for {notPassed.length === 1 ? "it" : "them"}:
          </p>
          <ul className="list-disc pl-5">
            {notPassed.map((item) => (
              <li key={item.itemKey}>
                {item.itemKey} “{item.title}” — expected to end on {item.expectedStepName}, {item.endedStepName === null ? "has not ended" : `ended on ${item.endedStepName}`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {asking !== null ? (
        <section aria-label="Coverage to confirm" className="flex flex-col gap-2 rounded-[10px] bg-paused/10 px-3 py-2.5 text-[12.5px] text-ink">
          {asking.map((module) => (
            <p key={module.id}>
              Every test case of <b className="font-semibold">{module.name}</b> passed, but they cover{" "}
              <strong className="font-semibold text-paused">{module.lineCoverage}%</strong> of its lines — under the {MODULE_COVERAGE_BAR}% bar.
            </p>
          ))}
          <p className="text-ink-muted">Nothing has been approved or published yet.</p>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" disabled={publish.isPending} onClick={() => publish.mutate(asking.map((module) => module.id))}>
              {publish.isPending ? "Running the tests…" : "Approve anyway and publish"}
            </Button>
            <Button size="sm" disabled={publish.isPending} onClick={() => setAsking(null)}>
              Cancel
            </Button>
          </div>
        </section>
      ) : null}

      {open ? (
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={publish.isPending || detail === null || detail.problem !== null || asking !== null}
            onClick={() => {
              setProblem(null);
              publish.mutate([]);
            }}
          >
            {label}
          </Button>
          <span className="ml-auto text-[11px] text-ink-subtle">Runs every module’s tests, approves them and publishes; then the trial is deleted</span>
        </div>
      ) : null}
      {open && detail?.problem ? <p className="text-xs text-danger">{detail.problem}</p> : null}
      {problem ? <p className="whitespace-pre-line text-xs text-danger">{problem}</p> : null}
    </section>
  );
}

function Changes({ detail }: { detail: Detail }) {
  return (
    <section aria-label="Changed since you approved" className="flex flex-col gap-1 text-[12.5px]">
      <h4 className="text-[12px] font-semibold text-ink-muted">Changed since you approved the design</h4>
      {detail.changes.length === 0 ? (
        <p className="text-ink-muted">Nothing in the graph: it is the design you approved.</p>
      ) : (
        <ul className="list-disc pl-5 text-ink">
          {detail.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Steps({ detail }: { detail: Detail }) {
  return (
    <section aria-label="How each step was tested" className="flex flex-col gap-1.5">
      <h4 className="text-[12px] font-semibold text-ink-muted">How each step was tested</h4>
      <ul className="flex flex-col gap-1.5">
        {detail.stepOutcomes.map((step) => (
          <li key={step.stepId} className="flex flex-col gap-0.5 text-[12.5px]">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <b className="font-semibold text-ink">{step.name}</b>
              <Chip tone={STEP[step.outcome].tone}>{STEP[step.outcome].label}</Chip>
            </div>
            {step.reason && step.outcome !== "tested" ? <p className="text-ink-muted">{step.reason}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Items({ detail }: { detail: Detail }) {
  return (
    <section aria-label="How each test item ended" className="flex flex-col gap-1.5">
      <h4 className="text-[12px] font-semibold text-ink-muted">How each test item ended{detail.round === null ? "" : ` in round ${detail.round}`}</h4>
      <ul className="flex flex-col gap-2">
        {detail.items.map((item) => (
          <li key={item.itemKey} className="rounded-[10px] bg-canvas px-3 py-2.5 text-[12.5px]">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <b className="text-[13px] font-semibold text-ink">
                {item.itemKey} {item.title}
              </b>
              <Chip tone={VERDICT[item.verdict].tone}>{VERDICT[item.verdict].label}</Chip>
            </div>
            <p className="mt-1 text-ink">
              Expected to end on <b className="font-semibold">{item.expectedStepName}</b>
              {item.criteria ? <span className="text-ink-muted"> — {item.criteria}</span> : null}
            </p>
            <p className="text-ink-muted">
              {item.endedStepName === null ? "Has not ended yet." : `Ended on ${item.endedStepName}${item.result === null ? "" : `, on ${item.result}`}.`}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function OnBehalf({ detail }: { detail: Detail }) {
  return (
    <section aria-label="Answered on your behalf" className="flex flex-col gap-1.5 text-[12.5px]">
      <h4 className="text-[12px] font-semibold text-ink-muted">Answered on your behalf — on the live pipeline these are yours</h4>
      {detail.onBehalf.length === 0 ? (
        <p className="text-ink-muted">The assistant answered nothing in your place.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {detail.onBehalf.map((act, index) => (
            <li key={index} className="text-ink">
              {act.kind === "pressed" ? (
                <>
                  On <b className="font-semibold">{act.stepName}</b> you will be asked to choose{act.choices.length > 0 ? ` ${act.choices.join(" / ")}` : ""}; for {act.itemKey} the assistant
                  pressed <b className="font-semibold">{act.answer}</b>.
                </>
              ) : (
                <>
                  <b className="font-semibold">{act.stepName}</b> will ask you: <span className="text-ink-muted">“{act.asked}”</span> — for {act.itemKey} the assistant answered “
                  {act.answer}”.
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
