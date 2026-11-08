import type { AssistTrialCard, PipelineStepView } from "@eo/core";
import { Chip, StepKindChip, type Tone } from "../kit";

const MODE: Record<AssistTrialCard["steps"][number]["mode"], { label: string; tone: Tone }> = {
  real: { label: "Runs for real", tone: "success" },
  redirected: { label: "Redirected", tone: "running" },
  mocked: { label: "Mocked", tone: "paused" },
};

const REACHES: Record<"sends" | "creates", string> = {
  sends: "Sends outside EO",
  creates: "Creates outside EO",
};

/**
 * What a design card says about its test (EO-587), under the graph and
 * the module rows: the test items with where each must end, and every
 * step's mode with the assistant's reason for it.
 *
 * Where each item must end is said as the step's name, because that is
 * what EO checks — a test item ending anywhere else has failed, whatever
 * the assistant concludes — and the person's own words beside it, which
 * the assistant reports against. Each step says whether EO classes it as
 * reaching outside EO, since that is what the mode was chosen from.
 *
 * Each step carries the kind chip the draft graph above it draws
 * (EO-680, EO-681), read from that same draft, so the two cannot say
 * different things about one step. A terminal step is given none.
 */
export function DesignPlan({
  trial,
  steps,
}: {
  trial: AssistTrialCard;
  /** The draft's steps, as the graph above draws them. */
  steps: readonly Pick<PipelineStepView, "id" | "type" | "ownerRole" | "entryAction" | "isTerminal">[];
}) {
  const stepOf = (stepId: string) => steps.find((step) => step.id === stepId);
  return (
    <div className="flex flex-col gap-2.5">
      {trial.changes.length > 0 ? (
        <section aria-label="What this design changes" className="flex flex-col gap-1 rounded-[10px] bg-paused/10 px-3 py-2.5 text-[12.5px] text-ink">
          <p className="font-semibold">This changes the design you approved, so testing waits for you:</p>
          <ul className="list-disc pl-5">
            {trial.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label="Test items" className="flex flex-col gap-1.5">
        <h4 className="text-[12px] font-semibold text-ink-muted">Test items</h4>
        <ul className="flex flex-col gap-2">
          {trial.items.map((item) => (
            <li key={item.key} className="rounded-[10px] bg-canvas px-3 py-2.5 text-[12.5px]">
              <b className="text-[13px] font-semibold text-ink">{item.title}</b>
              {item.body ? <p className="mt-0.5 whitespace-pre-line text-ink-muted">{item.body}</p> : null}
              <p className="mt-1 text-ink">
                Must end on <b className="font-semibold">{item.expectedStepName}</b>
                {item.criteria ? <span className="text-ink-muted"> — {item.criteria}</span> : null}
              </p>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="How each step runs" className="flex flex-col gap-1.5">
        <h4 className="text-[12px] font-semibold text-ink-muted">How each step runs on the test items</h4>
        <ul className="flex flex-col gap-1.5">
          {trial.steps.map((step) => {
            const drawn = stepOf(step.stepId);
            return (
              <li key={step.stepId} className="flex flex-col gap-0.5 text-[12.5px]">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <b className="font-semibold text-ink">{step.name}</b>
                  {drawn === undefined || drawn.isTerminal ? null : <StepKindChip step={drawn} />}
                  <Chip tone={MODE[step.mode].tone}>{MODE[step.mode].label}</Chip>
                  {step.reaches ? <Chip>{REACHES[step.reaches]}</Chip> : null}
                </div>
                {step.reason ? <p className="text-ink-muted">{step.reason}</p> : null}
                {step.mocks.length > 0 ? (
                  <ul className="pl-4 text-ink-muted">
                    {step.mocks.map((mock) => (
                      <li key={mock.item}>
                        For “{mock.item}” it reports <code className="font-mono text-[12px]">{mock.resultKey}</code>
                        {mock.output.trim() !== "" ? `: ${mock.output}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
