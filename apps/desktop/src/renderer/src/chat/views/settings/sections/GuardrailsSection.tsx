import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RUN_MEMORY_MAX_MB, RUN_MEMORY_MIN_MB, type GuardConfigView } from "@eo/core";
import { ipcQuery } from "../../../../query/client";
import { guardsKey } from "../../../../query/hooks";
import { withArticle } from "../../../parts";
import { CardSection, Checkbox, ErrorLine, Field, Loading } from "../../../kit";
import { DraftInput } from "../core/draftInput";
import { FieldGrid, NotedField } from "../core/fields";
import { enqueueSave } from "../core/serialSaves";
import { useItemWords } from "../core/words";

/**
 * Settings → Guardrails: this installation's own limits — concurrency,
 * attempts, the run timeout, the budgets, how long agents may mention
 * each other unwatched — applied on the next dispatch.
 *
 * Not fenced by a published policy: the policy publishes the per-person
 * ceiling and leaves these where they are (EO-328).
 */
export function GuardrailsSection() {
  const queryClient = useQueryClient();
  const words = useItemWords();
  const guards = useQuery({ queryKey: guardsKey, queryFn: () => ipcQuery("guards:get", undefined) });

  // `guards:set` takes the whole configuration, so a change is a patch laid
  // over what is stored (EO-563). Saves go one after another on a queue that
  // belongs to the query client, not to this mount, and each one reads the
  // stored value only when its turn comes — after the one before it has
  // written its reply into the cache — so two quick edits to different
  // fields both land, even with a trip to another section in between.
  const save = (patch: Partial<GuardConfigView>) =>
    enqueueSave(
      queryClient,
      "guards:set",
      async () => {
        const stored = queryClient.getQueryData<GuardConfigView>(guardsKey);
        if (!stored) throw new Error("EO has not read its guardrails yet.");
        const result = await ipcQuery("guards:set", { ...stored, ...patch });
        // A refetch that left before this write would land after it, with
        // the configuration as it was.
        await queryClient.cancelQueries({ queryKey: guardsKey });
        queryClient.setQueryData(guardsKey, result.guards);
        return result;
      },
      // The reply is already drawn; reading back is the backstop, once
      // nothing else is queued behind it.
      () => void queryClient.invalidateQueries({ queryKey: guardsKey }),
    );

  // Why a save did not take, per field (EO-162, EO-563). A field whose save
  // was refused or failed keeps what was typed, so without this it would
  // look saved when it is not; and it stays said until that field's own
  // next save answers, whatever other fields save meanwhile. A refusal names
  // the step that depends on the limit, so the fix is one screen away.
  const [failures, setFailures] = useState<Record<string, string[]>>({});
  /** Save one field's patch; `true` once it is stored, so the field can go back to drawing what is. */
  const commit = async (patch: Partial<GuardConfigView>): Promise<boolean> => {
    const key = Object.keys(patch).join(",");
    const problems = await save(patch).then(
      (result) => (result.saved ? [] : result.problems),
      (error: unknown) => [error instanceof Error ? error.message : String(error)],
    );
    setFailures((current) => {
      const next = { ...current };
      if (problems.length > 0) next[key] = problems;
      else delete next[key];
      return next;
    });
    return problems.length === 0;
  };

  const value = guards.data;
  const set = (patch: Partial<GuardConfigView>) => {
    if (value) void commit(patch);
  };
  /** A number box: what is stored, drawn as text, and how what was typed becomes a patch. */
  const field = (stored: number | null, toPatch: (raw: string) => Partial<GuardConfigView>) => ({
    value: stored === null ? "" : String(stored),
    onCommit: (raw: string) => commit(toPatch(raw)),
  });
  const atLeastOne = (raw: string) => Math.max(1, Number(raw));
  const orNone = (raw: string): number | null => (raw.trim() === "" ? null : Math.max(0, Number(raw)));
  const problems = [...new Set(Object.values(failures).flat())];

  return (
    <CardSection title="Guardrails" description="Applied on the next dispatch — no restart needed. Of the limits on a run, only the attempt limit applies to the system agent.">
      {!value ? (
        guards.isError ? (
          <ErrorLine>EO could not read its guardrails.</ErrorLine>
        ) : (
          <Loading />
        )
      ) : (
        <>
          {problems.length > 0 ? (
            <div role="alert" className="flex flex-col gap-1 rounded-[12px] bg-danger/12 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink">
              <p className="font-medium text-danger">Not saved — what you typed is still in its box.</p>
              <ul className="list-disc pl-4">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <FieldGrid>
            <Field label="Global concurrency">
              <DraftInput type="number" min={1} {...field(value.globalConcurrency, (raw) => ({ globalConcurrency: atLeastOne(raw) }))} />
            </Field>
            <Field label="Per-repository concurrency">
              <DraftInput
                type="number"
                min={1}
                {...field(value.perRepositoryConcurrency, (raw) => ({ perRepositoryConcurrency: atLeastOne(raw) }))}
              />
            </Field>
            <Field label="Per-agent concurrency">
              <DraftInput type="number" min={1} {...field(value.perAgentConcurrency, (raw) => ({ perAgentConcurrency: atLeastOne(raw) }))} />
            </Field>
            <Field label="Attempt limit per initiation">
              <DraftInput type="number" min={1} {...field(value.perItemAttemptLimit, (raw) => ({ perItemAttemptLimit: atLeastOne(raw) }))} />
            </Field>
            {/* Also the ceiling on a module step's own time limit (EO-162):
                said here because this is where somebody raises it. */}
            <NotedField note="Also the most a module step may be given as its own time limit.">
              <Field label="Run timeout (minutes)">
                <DraftInput
                  type="number"
                  min={1}
                  {...field(Math.round(value.wallClockTimeoutMs / 60_000), (raw) => ({ wallClockTimeoutMs: atLeastOne(raw) * 60_000 }))}
                />
              </Field>
            </NotedField>
            <NotedField note="No word from an agent's backend for this long, while no tool is running, ends the run and says so. Time the computer spends asleep is not counted. 0 turns it off.">
              <Field label="Silence before a run is ended (minutes)">
                <DraftInput
                  type="number"
                  min={0}
                  {...field(Math.round(value.inactivityTimeoutMs / 60_000), (raw) => ({ inactivityTimeoutMs: Math.max(0, Math.floor(Number(raw) || 0)) * 60_000 }))}
                />
              </Field>
            </NotedField>
            <Field label={`Per-${words.one} budget (cents, blank = none)`}>
              <DraftInput type="number" min={0} {...field(value.perItemBudgetCents, (raw) => ({ perItemBudgetCents: orNone(raw) }))} />
            </Field>
            {/* The one budget that ships switched on (EO-211): the number
                may be EO's default, and an empty box is a decision. */}
            <NotedField
              note={`Spent across every ${words.one}, and enforced by stopping the run that would pass it. EO applies a default here unless you say otherwise; clearing the field removes the ceiling, and nothing then limits what a day costs.`}
            >
              <Field label="Daily budget (cents, blank = none)">
                <DraftInput type="number" min={0} {...field(value.dailyBudgetCents, (raw) => ({ dailyBudgetCents: orNone(raw) }))} />
              </Field>
            </NotedField>
          </FieldGrid>

          {/* EO-738: a run that runs out of memory stops alone — where this
              machine can give it a scope of its own, and only there. */}
          <RunMemoryField
            stored={value.runMemoryMaxMb}
            globalConcurrency={value.globalConcurrency}
            onCommit={async (raw) => {
              const typed = raw.trim() === "" ? null : Number(raw);
              if (typed !== null && (!Number.isInteger(typed) || typed < RUN_MEMORY_MIN_MB || typed > RUN_MEMORY_MAX_MB)) {
                setFailures((current) => ({
                  ...current,
                  runMemoryMaxMb: [`The run memory limit (runMemoryMaxMb) must be a whole number of megabytes from ${RUN_MEMORY_MIN_MB} to ${RUN_MEMORY_MAX_MB.toLocaleString("en-US")}, or blank for EO's default.`],
                }));
                return false;
              }
              return commit({ runMemoryMaxMb: typed });
            }}
          />

          {/* EO-212: what it caps is how long agents may go on without
              anybody watching, which the number alone does not say. */}
          <div className="max-w-[28rem]">
            <NotedField
              note={`Counted since the last comment of yours on ${withArticle(words.one)}. Past it, the mention is not answered and the ${words.one} asks you — and your next comment lets them carry on.`}
            >
              <Field label="Agent-to-agent mentions before a person is asked">
                <DraftInput type="number" min={1} {...field(value.agentMentionDepth, (raw) => ({ agentMentionDepth: atLeastOne(raw) }))} />
              </Field>
            </NotedField>
          </div>

          {/* EO-456: how many times a watch may send an item round with nobody saying anything. */}
          <div className="max-w-[28rem]">
            <NotedField
              note={`How many times steps that keep checking may send ${withArticle(words.one)} to another step since your last comment on it. Past it, the ${words.one} waits for you — and your next comment lets it carry on.`}
            >
              <Field label={`Watch round trips per ${words.one}`}>
                <DraftInput type="number" min={1} {...field(value.watchRoundTripsPerItem, (raw) => ({ watchRoundTripsPerItem: atLeastOne(raw) }))} />
              </Field>
            </NotedField>
          </div>

          {/* EO-478: how much memory a run is given whole before a small model picks what bears on its task. */}
          <div className="max-w-[28rem]">
            <NotedField note="Up to this many characters of a project's and workspace's memory, a run is given all of it. Past it, a small model picks the entries that bear on the task, and the rest stay a tool call away.">
              <Field label="Memory given whole, in characters">
                <DraftInput type="number" min={1} {...field(value.memoryDeliveryChars, (raw) => ({ memoryDeliveryChars: atLeastOne(raw) }))} />
              </Field>
            </NotedField>
          </div>

          {/* EO-480: each scope's caps, past which EO consolidates it to about half on its own. */}
          <NotedField note="The most memory the project, and each workspace, holds. Whichever is reached first, EO folds that scope's agent-written entries into about half as many, without asking. Entries a person wrote are never rewritten, and a consolidation can be undone.">
            <div className="grid max-w-[28rem] grid-cols-2 gap-3">
              <Field label="Memory entries per scope">
                <DraftInput type="number" min={1} {...field(value.memoryScopeMaxEntries, (raw) => ({ memoryScopeMaxEntries: atLeastOne(raw) }))} />
              </Field>
              <Field label="Memory characters per scope">
                <DraftInput type="number" min={1} {...field(value.memoryScopeMaxChars, (raw) => ({ memoryScopeMaxChars: atLeastOne(raw) }))} />
              </Field>
            </div>
          </NotedField>

          {/* EO-720: counted in runs, not days, so an idle project ages nothing. */}
          <NotedField note="An agent-written skill that is given to this many runs in a row without one of them loading it is marked stale, and then archived — delivered to nobody, and its version history says why. A load starts the count again. Skills a person wrote, and locked skills, are never archived by EO.">
            <div className="grid max-w-[28rem] grid-cols-2 gap-3">
              <Field label="Runs without a load before a skill is stale">
                <DraftInput type="number" min={1} {...field(value.skillStaleAfterRuns, (raw) => ({ skillStaleAfterRuns: atLeastOne(raw) }))} />
              </Field>
              <Field label="Runs without a load before a skill is archived">
                <DraftInput type="number" min={1} {...field(value.skillArchiveAfterRuns, (raw) => ({ skillArchiveAfterRuns: atLeastOne(raw) }))} />
              </Field>
            </div>
          </NotedField>

          {/* EO-184: on by default, and the note says what turning it off costs. */}
          <NotedField note="Only when somebody answers in their own words instead of choosing one of the answers on offer. Off, the step simply runs again and asks again.">
            <Checkbox
              checked={value.interpretReplies}
              onChange={(interpretReplies) => set({ interpretReplies })}
              label="Let the system agent read replies to a step that stopped and asked"
            />
          </NotedField>

          {/* EO-582: one setting, because it was the call least settled. */}
          <NotedField note="While the assistant is testing a pipeline draft with real runs, its test items go ahead of other work waiting for a turn. Nothing running is stopped, and only one thing runs at a time as before. Off, test items wait their turn like everything else.">
            <Checkbox
              checked={value.trialsFirst}
              onChange={(trialsFirst) => set({ trialsFirst })}
              label="Run a pipeline draft's test items ahead of other waiting work"
            />
          </NotedField>

          {/* EO-586: what stops a draft's test-fix loop and asks you. */}
          <NotedField note="While the assistant tests a pipeline draft with real runs, it stops and asks you — keep going, publish anyway, or discard — after this many rounds, or once testing the draft has cost its budget. Keep going counts both again from your answer. The daily budget applies either way.">
            <div className="grid max-w-[28rem] grid-cols-2 gap-3">
              <Field label="Test rounds per draft">
                <DraftInput type="number" min={1} {...field(value.trialRoundsPerDraft, (raw) => ({ trialRoundsPerDraft: atLeastOne(raw) }))} />
              </Field>
              <Field label="Budget per draft (cents, blank = none)">
                <DraftInput type="number" min={0} {...field(value.trialBudgetCentsPerDraft, (raw) => ({ trialBudgetCentsPerDraft: orNone(raw) }))} />
              </Field>
            </div>
          </NotedField>
          <NotedField note="When a step fails with the same result in two test rounds in a row, the change between them did not reach it. On, testing stops there and asks you.">
            <Checkbox
              checked={value.trialStopOnRepeatedFailure}
              onChange={(trialStopOnRepeatedFailure) => set({ trialStopOnRepeatedFailure })}
              label="Stop testing a draft when the same step fails the same way twice running"
            />
          </NotedField>
        </>
      )}
    </CardSection>
  );
}

/**
 * The run memory limit (EO-738). Where this machine gives every run a
 * systemd scope of its own, a box — blank for EO's default, which is said
 * beside it. Where it cannot (macOS, Windows, Linux without a reachable
 * systemd user manager), no box at all: a control that does nothing there
 * would read as a limit in force. What this machine is, and what its
 * default comes to, is asked of the machine (`guards:runMemory`).
 */
function RunMemoryField({ stored, globalConcurrency, onCommit }: { stored: number | null; globalConcurrency: number; onCommit: (raw: string) => Promise<boolean> }) {
  const facts = useQuery({
    // Under the guardrails' own key, so reading them back reads this too;
    // and keyed by what the default is made of, so it follows an edit.
    queryKey: [...guardsKey, "runMemory", stored, globalConcurrency],
    queryFn: () => ipcQuery("guards:runMemory", undefined),
    // The last answer stays drawn while the next is read, so the box a
    // person is typing in is not taken away by the save it just made.
    placeholderData: (previous) => previous,
  });
  const mb = (value: number) => `${value.toLocaleString("en-US")} MB`;
  if (!facts.data) return facts.isError ? <ErrorLine>EO could not tell whether the run memory limit applies on this computer.</ErrorLine> : null;
  if (!facts.data.applies) {
    return (
      <div className="max-w-[28rem]">
        <NotedField
          note={`Applies on Linux only, where each run starts in a systemd scope of its own so a run that runs out of memory stops by itself. It does not apply on this computer — ${facts.data.reason ?? "no systemd user manager is reachable"} — so runs here start without one.`}
        >
          <Field label="Memory per run">
            <p className="text-[13px] text-ink-muted">Does not apply on this computer</p>
          </Field>
        </NotedField>
      </div>
    );
  }
  return (
    <div className="max-w-[28rem]">
      <NotedField
        note={`What one run's processes — the agent and everything it starts, or a module — may use together. A run that reaches it, or that the system picks when this computer runs out, is stopped on its own and waits for you; EO and other runs carry on. Blank is EO's default for this computer: three quarters of its ${mb(facts.data.totalMb)}, shared across a global concurrency of ${globalConcurrency} — ${mb(facts.data.defaultMb)}.`}
      >
        <Field label="Memory per run (MB, blank = EO's default)">
          <DraftInput type="number" min={RUN_MEMORY_MIN_MB} placeholder={String(facts.data.defaultMb)} value={stored === null ? "" : String(stored)} onCommit={onCommit} />
        </Field>
      </NotedField>
    </div>
  );
}
