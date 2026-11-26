# Should a developer use EO alongside the desktop apps? Two simulated debates

*November 2026. Written down as input for later improvements, not as a decision.*

This is the record of an experiment, not user research. Three agents were each given a persona and read access to this repository. A **skeptic** argued that a software developer is better off using the Claude Code and Codex desktop apps directly. An **advocate** argued for using EO alongside them. An **undecided developer** recorded a starting position before hearing either side, checked the claims that mattered to them against the code, and scored their leaning from −5 (desktop apps only) to +5 (adopt EO alongside). A moderator passed the arguments between them over two rounds.

The experiment was run twice. In the first, nobody was an EO expert. In the second, the skeptic and the advocate had read all of [`ARCHITECTURE.md`](../ARCHITECTURE.md) and the code behind the developer pack, and had to label every claim as **a default**, **configurable** (and how), or **a hard limit** of the code today. The undecided developer stayed a newcomer both times.

Everything below is what the agents argued and checked. File references were cited by them and cross-checked by the undecided developer. Where the moderator checked a reference independently, it says so.

- [Results](#results)
- [Debate 1: non-experts](#debate-1-non-experts)
- [Debate 2: experts](#debate-2-experts)
- [What the debates found about EO](#what-the-debates-found-about-eo)
- [Improvements the undecided developer asked for](#improvements-the-undecided-developer-asked-for)
- [Caveats](#caveats)

## Results

| | Starting point | After round 1 | Final | Who won |
|---|---|---|---|---|
| Debate 1, non-experts | −1 | 0 | **+1**, a bounded two-week trial | Neither outright; the advocate on framing |
| Debate 2, experts | −1 | −2 | **−3**, desktop apps only | The skeptic, clearly |

The result reversed because the experts argued about different things. The first debate was mostly about the shipped template's defaults: dependent items waiting for a merge, a person merging, concurrency at 1. Configuration answers all of those. The experts conceded every one of them in their opening statements and argued instead about what stays true **after EO is configured well**. The one thing that survives is that agents run without a sandbox, and that is what decided the second debate.

## Debate 1: non-experts

**Skeptic.** EO is built for people who are not programmers (`ARCHITECTURE.md` §1). It is large (`supervisor/runSupervisor.ts` alone is over 12,000 lines), it strips your own Claude and Codex setup from its agents, and it runs one thing at a time. The skeptic also argued that its verification is a pre-push hook plus CI, and that its pipeline is heavy for small changes.

**Advocate.** Use the desktop apps when you don't yet know what "done" looks like, and EO when a command can check it. EO checks an agent's claim instead of trusting it, sends a rejected review back to the implementer as a comment, ends a run that needs a person instead of holding it open, and survives a crash. A desktop session can hand a plan to EO through `work_submit_plan`.

**What the undecided developer caught.**
- The skeptic presented as limits things that are only defaults or are spun. Stripping your setup applies only to EO's agents, and there is an opt-out per agent. A comment on the pull request from your own account goes straight back to the implementer (`author_commented`), not through a plan-and-approve loop.
- The advocate overclaimed. Verify does not check that "the tests really ran". It checks that a configured command exited 0, and a command that isn't configured counts as passing.
- The advocate's example week was invented, and the repository holds no numbers for speed or cost.

**Decisive point.** For items that don't depend on each other, EO sends a failed check or a red CI run back to the agent and retries, with nobody involved. The skeptic conceded that nothing in their setup does that.

**The error that shaped the result.** The skeptic's strongest argument was that a chain of dependent items stops at a human merge. That is true of the default, which the dependency gate in `packages/engine/src/scheduler.ts` and the shipped template set up. But `wait: "reached"` edges release a dependent item once its dependency reaches a named step. A module step that a person approves can also run `gh pr merge`, because a module's manifest can grant it binaries and network (§4.6). Nobody in the first debate caught this, and it is why the second debate required every claim to be labelled.

## Debate 2: experts

**Expert skeptic.** It conceded `reached` edges, automatic restacking, auto-merge through a module, and concurrency being a setting. It then argued:
- **Every agent runs unsandboxed, and nothing changes that** (a hard limit). Claude runs with `permissionMode: "bypassPermissions"` and Codex with `sandboxMode: "danger-full-access"` and `approvalPolicy: "never"`. Both are deliberately hard-coded, and no config key overrides them (EO-178).
- **The CLIs are pinned.** They move only with an EO release.
- **There is no pipeline editor.** Every change is a draft from the assistant, so even auto-merge means reviewing a JavaScript module the assistant wrote.
- **A flaky test costs a full implement-and-review lap.** Each check also has a 10-minute limit.
- **Protection against running out of memory exists only on Linux with systemd.**

**Expert advocate.** It described a concrete setup:
- Plan in the desktop app, then hand off with `work_submit_plan`.
- Use the shipped template, with the test, lint and build commands configured. The advocate warned that verification is hollow without them.
- Use `reached` edges so story 2 runs while story 1's pull request waits for review. Watch checks hold no run slot, so this works even at concurrency 1.
- Optionally, add an auto-merge module gated on the forge's own "mergeable" verdict.

It disclosed the same sandboxing facts unprompted.

**The undecided developer's key observation.** In the desktop app, bypass mode is a risk you take while you're watching. EO is built to run while you're away. In the template, the only limits on what an agent may push are instructions in the implementer's prompt ("Never a bare `--force`", "Never any branch but this ticket's own"). Unattended running is the feature being bought, and it is exactly where the bypass matters.

**The crux question, and the answer.** The undecided developer asked what *code* stops an unattended implementer from running `git push --force` to `main`, or `rm -rf` outside the worktree. The advocate answered: **nothing in EO's code.** The only things that stop it:
- branch protection on the forge, which sits outside EO
- a hook committed to the repository, which guards against accidents and works on Claude only
- the operating system: a separate account and a token scoped to one repository

Even with all three in place, the advocate said, the risk left over equals a bypass-mode desktop session you walked away from.

**What else counted against EO.**
- **Overnight needs the laptop awake.** No check runs while EO is offline, or for 60 seconds after a wake (`ARCHITECTURE.md` §4.2). Work runs on the person's machine, even in organisation mode.
- **The restack that matters still comes back to you.** EO restacks automatically, but a conflict escalates to the person.

**Final verdict, −3.** "Doing all of that setup to recover a roughly 10-minute morning chore fails my 'under an hour, no takeover' test by a wide margin." The undecided developer rated the advocate narrowly the more honest of the two, because its concessions kept weakening its own case.

## What the debates found about EO

Ordered by how much each finding bears on adoption. Each finding gives what it rests on; the moderator checked the first four against the code.

### 1. EO has a deny hook that holds under bypass, but only the learning review uses it

`providers/claude.ts` builds a `PreToolUse` hook from `refuseCallsExcept`. A hook's `deny` holds even under `bypassPermissions` (see the comment at `claude.ts:1224`). The option has one caller, the learning-review fork at `supervisor/runSupervisor.ts:3451` (EO-732). Implementer and reviewer turns, the ones that write code and push, get no refusal hook.

The mechanism to fence a work step, for example "push only this item's branch, never `--force`, no writes outside the worktree", already exists. Applying it to work steps is mostly policy, not new infrastructure. It is still a pattern match on commands, which the code itself calls evadable (`claude.ts:1439-1447`), so it guards against accidents, not against a determined agent.

### 2. The sandbox bypass is hard-coded on both backends

`providers/claude.ts:1448` and `providers/codex.ts:815-816`. The comments state the trade plainly. A sandboxed agent couldn't run git and the check commands, and confining the process "was considered and rejected". EO checks the result instead: verify, the borrowed-file check, the guards, and no merge without review. The debate didn't dispute that reasoning for attended work. It disputed it for the unattended work EO exists to do.

### 3. Agents inherit the person's whole environment

`claude.ts:1663-1670` spreads `process.env`, as the SDK requires, so an agent gets HOME and with it the person's git and `gh` credentials. Together with findings 1 and 2, this means an implementer can push anywhere the person can.

### 4. A check that isn't configured passes, and nothing warns about it

`packs/developer/workspace/verify.ts:179-184` reports a missing test, lint or build command as `ok: true` with "skipped" in the detail. Both sides agreed this makes verification hollow on a repository nobody configured. Per-check time is fixed at 10 minutes (`DEFAULT_CHECK_TIMEOUT_MS`, `verify.ts:7`).

### 5. A repository hook reaches Claude agents but apparently not Codex agents

Claude agents load project settings (`claude.ts:1055`, `settingSources: ["project"]`), so a hook committed in `.claude/settings.json` applies. The Codex home is held to an allowlist (`providers/codexHome.ts:396-405`). The expert advocate found no path that carries a repository hook to a locked-down Codex agent. The moderator did not independently confirm that no such path exists.

If it holds, this is a capability that reaches one backend without EO naming the gap, which invariant 12 asks EO to do.

### 6. A flaky test costs a full lap

In the shipped template, `checks_failed` goes to To Do and To Do's `done` goes to Review. So one flaky test costs an implementer run plus a reviewer run, up to the watch's five round trips. There is no builtin that only re-runs CI. The advocate described a data-only workaround: a triage agent role and two routes, drafted through the assistant. The call between a flake and a real failure is then still the model's.

### 7. Documentation drift, already fixed

Both first-round debaters found that invariant 12 in `CLAUDE.md` still said Codex could not be steered mid-turn, which stopped being true in EO-373. That was corrected in #226.

## Improvements the undecided developer asked for

These are what the final verdict said would have to change before they would adopt EO. They are inputs for the tracker, not decided scope.

1. **Fence work steps by default.** Apply the existing refusal hook (finding 1) to implementer and reviewer turns: push only the item's own branch, no `--force`, no writes outside the worktree. This is the cheapest, because the mechanism is built.
2. **Give Codex the same fence**, or name the gap where the person choosing the backend will see it (invariant 12).
3. **An option to run agents sandboxed**, instead of only the hard-coded bypass.
4. **A route that re-runs CI on a flake** without a full implement-and-review lap.
5. **A check timeout that can be raised** above 10 minutes.
6. **Work that can run on an always-on host**, not only the person's laptop.

Two smaller ones came out of the first debate:
- Warn when a repository has no test command configured, rather than letting verify pass silently (finding 4).
- Say in the template, or in `work_submit_plan`'s description, that dependent items wait for a merge unless an edge is `reached`. The first-round skeptic built its main argument on that default, and the first-round advocate's "four tickets overnight" didn't work under it.

## Caveats

- **Simulated people.** The personas are agents playing developers. Their scores measure how persuasive each argument was to one simulated persona, not what real developers would decide.
- **No measurements.** Neither debate had figures for speed, cost or setup time, because the repository holds none. The undecided developer in debate 1 proposed collecting them: run five items each way and count the person's own minutes per merged change.
- **One kind of developer.** Both undecided developers were solo developers. The case for EO may weigh differently for a team, or on an always-on machine.
- **Line numbers drift.** References are to the code as of 2026-11-26, right after #226 merged.
