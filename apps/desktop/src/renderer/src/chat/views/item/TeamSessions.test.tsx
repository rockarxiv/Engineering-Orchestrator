import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { TeamAttemptView, TeamSessionView } from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { createQueryClient } from "../../../query/client";
import { TeamSessions } from "./TeamSessions";

/** An item's team sessions (EO-849): one session, its participants underneath, and safe controls. */

function attempt(overrides: Partial<TeamAttemptView> = {}): TeamAttemptView {
  return {
    id: "a1",
    assignmentKey: "security",
    leader: false,
    role: "reviewer",
    agentId: "ag1",
    agentName: "Rita",
    provider: "claude",
    instructions: "Look for ways in.",
    round: 1,
    attempt: 1,
    state: "running",
    status: "running",
    outcome: null,
    outcomeLabel: null,
    error: null,
    enforcementUnavailable: false,
    baseline: { kind: "git", ref: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", capturedAt: 1 },
    baselineCurrent: true,
    reportCommentId: null,
    acceptedAt: null,
    runId: "run-a1",
    startedAt: 1_000,
    endedAt: null,
    costCents: 30,
    tokensIn: 100,
    tokensOut: 10,
    supersedes: null,
    supersededBy: null,
    questions: [],
    ...overrides,
  };
}

function session(overrides: Partial<TeamSessionView> = {}): TeamSessionView {
  return {
    id: "s1",
    itemId: "t1",
    stepId: "review",
    stepName: "Review",
    coordination: "independent",
    members: "report_only",
    status: "open",
    state: "running",
    current: true,
    result: null,
    final: null,
    teamRunIds: ["team-run"],
    createdAt: 1,
    endedAt: null,
    totals: { runs: 3, costCents: 42, tokensIn: 200, tokensOut: 20, teamRunCents: 0 },
    waiting: [],
    endReason: null,
    assignments: [],
    cancel: { allowed: true, reason: null },
    retry: { allowed: false, reason: "The team is still at work; EO retries a participant whose turn fails itself, within the team's retries.", keys: [] },
    ...overrides,
  };
}

function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

function renderTeam(sessions: () => TeamSessionView[] | Error, answers: Record<string, unknown> = {}, onSelectRun?: (runId: string) => void) {
  const calls: { channel: string; payload: unknown }[] = [];
  const itemsChanged: ((push: unknown) => void)[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload?: unknown) => {
    calls.push({ channel, payload });
    if (channel === "items:teamSessions") {
      const served = sessions();
      return served instanceof Error ? { ok: false, error: { code: "internal", message: served.message } } : { ok: true, data: { sessions: served } };
    }
    if (channel in answers) return { ok: true, data: answers[channel] };
    return { ok: true, data: {} };
  }) as never;
  window.eo.ipc.subscribe = vi.fn((channel: string, callback: (push: unknown) => void) => {
    if (channel === "items:changed") itemsChanged.push(callback);
    return () => {};
  }) as never;
  render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/items/t1"]}>
          <TeamSessions itemId="t1" {...(onSelectRun === undefined ? {} : { onSelectRun })} />
          <Where />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { calls, pushItemsChanged: (push: unknown) => itemsChanged.forEach((listener) => listener(push)) };
}

describe("an item's team sessions (EO-849)", () => {
  it("draws nothing for an item no team has worked", async () => {
    const { calls } = renderTeam(() => []);
    await waitFor(() => expect(calls.some((call) => call.channel === "items:teamSessions")).toBe(true));
    expect(screen.queryByRole("region", { name: "Team" })).not.toBeInTheDocument();
  });

  it("shows an empty session as one, before any participant has started", async () => {
    renderTeam(() => [session()]);
    expect(await screen.findByText("No participant has started yet.")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("names the team's mode as the session has it: report-only or isolated (EO-871)", async () => {
    renderTeam(() => [session({ id: "s-isolated", coordination: "leader", members: "isolated" }), session({ id: "s-report", stepName: "Check" })]);
    expect(await screen.findByText("Leader-led · isolated")).toBeInTheDocument();
    expect(screen.getByText("Independent · report-only")).toBeInTheDocument();
    expect(screen.queryByText("Leader-led · report-only")).not.toBeInTheDocument();
  });

  it("shows one session with its participants underneath, attributed across backends, and its spending once", async () => {
    const selected: string[] = [];
    renderTeam(
      () => [
        session({
          assignments: [
            { key: "security", role: "reviewer", leader: false, required: true, current: "a1", attempts: [attempt({ state: "completed", status: "completed", outcome: "clear", outcomeLabel: "Nothing found", reportCommentId: "c1", endedAt: 6_000 })] },
            { key: "clarity", role: "writer", leader: false, required: false, current: "a2", attempts: [attempt({ id: "a2", assignmentKey: "clarity", agentName: "Cody", provider: "codex", role: "writer", costCents: 12, runId: "run-a2" })] },
          ],
          waiting: [{ kind: "contribution", keys: ["clarity"], text: "Waiting on **clarity** to report." }],
        }),
      ],
      {},
      (runId) => selected.push(runId),
    );
    const security = await screen.findByRole("listitem", { name: "Participant security" });
    expect(within(security).getByText("Reported")).toBeInTheDocument();
    expect(within(security).getByText("Nothing found")).toBeInTheDocument();
    expect(within(security).getByText("Rita (claude)")).toBeInTheDocument();
    expect(within(security).getByText("round 1 · attempt 1")).toBeInTheDocument();
    expect(within(security).getByText("5s")).toBeInTheDocument();
    expect(within(security).getByText(/read git 4b825dc642/)).toBeInTheDocument();
    expect(within(security).getByRole("button", { name: "Report" })).toBeInTheDocument();
    const clarity = screen.getByRole("listitem", { name: "Participant clarity" });
    expect(within(clarity).getByText("Cody (codex)")).toBeInTheDocument();
    expect(within(clarity).getByText("writer · optional")).toBeInTheDocument();
    expect(within(clarity).getByText("Running")).toBeInTheDocument();
    // The session's total, each run once — not the sum of what is drawn plus the team's own run again.
    expect(screen.getByText("42¢ · 3 runs")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Why the team is waiting" })).getByText("Waiting on contributions:")).toBeInTheDocument();
    fireEvent.click(within(clarity).getByRole("button", { name: "Transcript" }));
    expect(selected).toEqual(["run-a2"]);
  });

  it("names each reason a team waits, and keeps a failed contribution apart from a negative finding", async () => {
    renderTeam(() => [
      session({
        state: "waiting",
        waiting: [
          { kind: "capacity", keys: ["tests"], text: "the team runs 2 participants at a time, and that many are working. It starts as one finishes." },
          { kind: "human", keys: ["clarity"], text: "**clarity** asked a question." },
          { kind: "enforcement", keys: ["docs"], text: "EO could not hold **docs** to report-only on this machine." },
          { kind: "limits", keys: ["security"], text: "The team could not decide." },
          { kind: "restricted", keys: [], text: "EO is paused." },
        ],
        assignments: [
          { key: "security", role: "reviewer", leader: false, required: true, current: "a1", attempts: [attempt({ state: "failed", status: "failed", error: "The backend crashed." })] },
          { key: "clarity", role: "writer", leader: false, required: true, current: "a2", attempts: [attempt({ id: "a2", assignmentKey: "clarity", state: "completed", status: "completed", outcome: "blocking", outcomeLabel: "Blocking issue" })] },
        ],
      }),
    ]);
    const reasons = within(await screen.findByRole("list", { name: "Why the team is waiting" }));
    for (const label of ["Waiting for room:", "Waiting for your answer:", "Report-only not available:", "Limits reached:", "Held back:"]) expect(reasons.getByText(label)).toBeInTheDocument();
    const security = screen.getByRole("listitem", { name: "Participant security" });
    expect(within(security).getByText("Could not contribute")).toBeInTheDocument();
    expect(within(security).getByText("The backend crashed.")).toBeInTheDocument();
    const clarity = screen.getByRole("listitem", { name: "Participant clarity" });
    expect(within(clarity).getByText("Reported")).toBeInTheDocument();
    expect(within(clarity).getByText("Blocking issue")).toBeInTheDocument();
  });

  it("retries what failed and cancels the whole session, saying why when either is refused", async () => {
    const { calls } = renderTeam(() => [session({ state: "waiting", retry: { allowed: true, reason: null, keys: ["security"] } })], {
      "teams:retry": { retried: false, keys: [], problem: "A team member's question is still open." },
      "teams:cancel": { cancelled: true, problem: null },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Retry security" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A team member's question is still open.");
    expect(calls.find((call) => call.channel === "teams:retry")?.payload).toEqual({ sessionId: "s1" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel session" }));
    await waitFor(() => expect(calls.find((call) => call.channel === "teams:cancel")?.payload).toEqual({ sessionId: "s1" }));
  });

  it("offers no control on a settled session, only why, and keeps superseded work as history", async () => {
    renderTeam(() => [
      session({ id: "s2" }),
      session({
        id: "s1",
        status: "superseded",
        state: "superseded",
        current: false,
        cancel: { allowed: false, reason: "This session was superseded by a newer one, so there is nothing to cancel." },
        retry: { allowed: false, reason: "This session was superseded by a newer one; a settled session never runs again.", keys: [] },
        assignments: [
          {
            key: "security",
            role: "reviewer",
            leader: false,
            required: true,
            current: "a2",
            attempts: [
              attempt({ id: "a1", state: "superseded", status: "completed", outcome: "blocking", outcomeLabel: "Blocking issue", supersededBy: "a2", baselineCurrent: false }),
              attempt({ id: "a2", state: "stopped", status: "running", supersedes: "a1" }),
            ],
          },
        ],
      }),
    ]);
    await screen.findByText("Earlier team sessions (1)");
    const [, historical] = screen.getAllByRole("region", { name: "Team session on Review" });
    const controls = within(within(historical!).getByLabelText("Session controls"));
    expect(controls.queryByRole("button")).not.toBeInTheDocument();
    expect(controls.getByText(/a settled session never runs again/)).toBeInTheDocument();
    const security = within(within(historical!).getByRole("listitem", { name: "Participant security" }));
    expect(security.getByText("Stopped")).toBeInTheDocument();
    expect(security.getByText("Superseded")).toBeInTheDocument();
    expect(security.getByText(/\(since changed\)/)).toBeInTheDocument();
  });

  it("links a leader's result to the reports it relied on and says what it could not establish", async () => {
    renderTeam(() => [
      session({
        coordination: "leader",
        status: "finalized",
        state: "finalized",
        result: "aligned",
        cancel: { allowed: false, reason: "This session has already ended (finalized), so there is nothing to cancel." },
        final: { by: "leader", attemptId: "l2", outputCommentId: "c9", contributions: ["a1"], disagreements: "none", limitations: "Did not test on Windows." },
        assignments: [
          { key: "leader", role: "lead", leader: true, required: true, current: "l2", attempts: [attempt({ id: "l2", assignmentKey: "leader", leader: true, agentName: "Lena", provider: "codex", state: "completed", status: "completed", reportCommentId: "c9" })] },
          { key: "auth", role: "reviewer", leader: false, required: true, current: "a1", attempts: [attempt({ id: "a1", assignmentKey: "auth", state: "completed", status: "completed", reportCommentId: "c1" })] },
        ],
      }),
    ]);
    const final = await screen.findByLabelText("What produced the result");
    expect(within(final).getByText(/the leader's answer, checked by EO/)).toBeInTheDocument();
    expect(within(final).getByRole("button", { name: "auth" })).toBeInTheDocument();
    expect(within(final).getByRole("button", { name: "Final output" })).toBeInTheDocument();
    expect(within(final).getByText("Limitations: Did not test on Windows.")).toBeInTheDocument();
    expect(screen.getByText("Leader")).toBeInTheDocument();
  });

  it("takes a report link to the comment itself, asking the item page to bring it in when it is not on screen", async () => {
    renderTeam(() => [
      session({
        status: "finalized",
        state: "finalized",
        result: "rejected",
        final: { by: "rule", rule: "If any report concludes Blocking issue → rejected", ruleIndex: 0, contributions: ["a1"], outputCommentId: "c-out" },
        assignments: [{ key: "security", role: "reviewer", leader: false, required: true, current: "a1", attempts: [attempt({ state: "completed", status: "completed", reportCommentId: "c-old" })] }],
      }),
    ]);
    const security = await screen.findByRole("listitem", { name: "Participant security" });
    fireEvent.click(within(security).getByRole("button", { name: "Report" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/items/t1?comment=c-old"));
    fireEvent.click(screen.getByRole("button", { name: "Final output" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/items/t1?comment=c-out"));
  });

  it("links an independent team's result to its completion rule", async () => {
    renderTeam(() => [
      session({
        status: "finalized",
        state: "finalized",
        result: "rejected",
        final: { by: "rule", rule: "If any report concludes Blocking issue → rejected", ruleIndex: 0, contributions: ["a1"], outputCommentId: null },
        assignments: [{ key: "security", role: "reviewer", leader: false, required: true, current: "a1", attempts: [attempt({ state: "completed", status: "completed", reportCommentId: "c1" })] }],
      }),
    ]);
    expect(await screen.findByText(/by the completion rule: If any report concludes Blocking issue → rejected/)).toBeInTheDocument();
  });

  it("answers a participant's question as a reply filed under it", async () => {
    const { calls } = renderTeam(() => [
      session({
        state: "waiting",
        assignments: [
          {
            key: "clarity",
            role: "writer",
            leader: false,
            required: true,
            current: "a2",
            attempts: [attempt({ id: "a2", assignmentKey: "clarity", state: "waiting", status: "cancelled", questions: [{ commentId: "q1", body: "Who is the reader?", answered: false }] })],
          },
        ],
      }),
    ], { "comments:post": { commentId: "c2", resumedRun: true, delivery: null, problem: null } });
    fireEvent.change(await screen.findByRole("textbox", { name: "Answer clarity's question" }), { target: { value: "A new hire." } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(calls.find((call) => call.channel === "comments:post")?.payload).toEqual({ itemId: "t1", body: "A new hire.", parentId: "q1", mentions: [], pinned: false }));
  });

  it("reads the session again on the item's push, so a report finished while it was closed is drawn", async () => {
    let served = 0;
    const { pushItemsChanged } = renderTeam(() => {
      served += 1;
      return [session({ assignments: [{ key: "security", role: "reviewer", leader: false, required: true, current: "a1", attempts: [attempt(served === 1 ? {} : { state: "completed", status: "completed", reportCommentId: "c1" })] }] })];
    });
    expect(await screen.findByText("Running")).toBeInTheDocument();
    act(() => pushItemsChanged({ itemId: "t1" }));
    expect(await screen.findByText("Reported")).toBeInTheDocument();
  });

  it("says why it cannot be read rather than drawing an empty team", async () => {
    renderTeam(() => new Error("The database is locked."));
    expect(await screen.findByText("The database is locked.")).toBeInTheDocument();
  });
});
