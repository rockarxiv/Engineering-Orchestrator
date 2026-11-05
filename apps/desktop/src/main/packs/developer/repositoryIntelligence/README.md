# Repository Intelligence — and what measuring it found

EO builds a deterministic index of a ticket's checkout — symbols,
callers, callees, imports, inheritance — and gives the agent working
that ticket an MCP server to query it with, so navigating a codebase can
be a question rather than a search. It ships behind
`repositoryIntelligence.enabled`, which defaults off.

Everything outside `codewiki/` talks to `RepositoryIntelligenceProvider`
and never to an implementation. That is the point of the subsystem, and
`architecturalInvariants.test.ts` is what keeps it true.

**The feature exists on a claim: that a persistent index costs less than
making every agent rediscover the repository. This document is where
that claim is checked, and it is the reason no story in EO-141 states a
saving.**

## Running the report

```bash
pnpm report:index-benefit                                # every ticket that ran an agent
pnpm report:index-benefit EO-162 EO-170                  # some of them
pnpm --silent report:index-benefit --json > report.json  # for something else to read
```

It reads one SQLite file on this machine and prints. Nothing is
transmitted, nothing is written, and no source content is recorded or
printed — counts, durations, sizes, tool names and ticket keys only.

**Running it fetches nothing either.** That is not the same promise and
it took a second go to keep: this shipped as `pnpm dlx tsx
scripts/index-benefit.mts`, and `pnpm dlx` downloads its runner on a
machine that has not cached it — so the documented way to run a report
whose criterion is "nothing is transmitted anywhere" opened with a
request to registry.npmjs.org. It runs on Node's own type stripping now,
through `scripts/local-typescript.mjs`, which is Node builtins and
nothing else. `measurement.test.ts` runs that exact command with an
unroutable registry, npm and pnpm offline and `HOME` moved aside, and
fails if it needs a network.

The one prerequisite is a built workspace, because the report imports
`@eo/core`; any checkout that has run `pnpm typecheck`, `pnpm lint`,
`pnpm test` or `pnpm build` has one. Building it inside the report was
rejected: that means running `turbo`, which has telemetry of its own.

`measurement.test.ts` also pins the no-transmission and no-source-content
rules structurally rather than promising them.

Every figure is derived from rows EO was already writing — `run_events`
of type `tool_call`, `file_edit`, `usage`, `server_status` and
`search_interception`, and the token columns on `runs` — so the same
numbers are computable for tickets that ran long before the report
existed. No event type was introduced for it. The arithmetic lives in
`measurement.ts` with its tests beside it; the script is a query and a
printer.

### What counts as a search

Every comparison here turns on it, so it is written down rather than
left to be inferred from a regular expression. A **search** is a call
that asks the tree where something is: `Grep`, `Glob`, a shell command
leading with `grep`/`rg`/`find`/`fd`/`ls`/`tree`/`locate`, and — because
`git` is not a program that does one thing — `git grep` and
`git ls-files`. A **read** is a call that opens a file somebody has
already found. Everything else is `other`, including every other `git`
subcommand, `which`, a test run and an edit.

Two of those lines were wrong to begin with and are worth naming.
`git grep` was landing in `other`, so every search an agent spelled the
git way was missing from the comparison. `which` was landing in
`search`, though it asks `PATH` where an executable is, which no index
of this repository's declarations could ever answer.

## What it found — 2026-08-28, 143 tickets

Numbers move as EO works, which is the point of it being a command
rather than a table somebody typed. These are what it printed on the day
this was written; re-run it before quoting any of them.

The database held 15 tickets dispatched with the index attached and 128
without. **Nothing in it supports a claim that repository intelligence
reduced discovery cost.** The honest summary is: the mechanism works, the
index is barely used, and no reduction is detectable.

### The index was reached 30 times against 1,806 filesystem calls

Across the 15 tickets that had it, agents made **30 index calls**, **878
searches** and **928 file reads**. The index accounted for 1.7% of the
calls that ask the repository something.

Five of the nine tools have ever been reached: `context` 21 times,
`search` 3, `impact` 3, `callers` 2, `status` 1. `callees`, `node`,
`explore` and `files` have never been called by anybody. Whether the
other four are unused because they are not useful or because nothing
has ever pointed an agent at them is still open, and the same command
answers it once something does.

### No detectable reduction in the opening exploration

Comparing the fourteen tickets either side of the flag being switched on
— EO-142 to EO-156 without, EO-157 to EO-170 with, the same feature, the
same week, the same repository, which is the closest thing to a control
this data has:

| before the first source change | with the index | without |
|---|---|---|
| reads and searches, mean | 56.4 | 99.4 |
| reads and searches, **median** | **54.5** | **54.5** |
| searches, mean | 29.9 | 51.6 |
| searches, **median** | **29** | **25.5** |
| searches an index could have answered, median | 7 | 4.5 |

**The means say 43% fewer and the medians say no difference at all.** One
off-arm ticket made 548 calls before its first change and is carrying
the entire mean; the median search count moves the *wrong* way. The
report prints medians and ranges beside every mean and says in words
when the two disagree, because "43% fewer" is exactly the claim this
story exists to stop somebody making from these numbers.

Against all 128 off-arm tickets the direction reverses again — 56.3
against 51.0, 10% *more* with the index — which is what a comparison
across different tickets, different sizes and different eras is worth.

### Nudged twice, took it up once

Since EO-168 an interception is itself an event, so "was the agent
nudged, and did it then query the index" is answerable inside a single
run — the one comparison here that task difficulty cannot explain.
**2 of 9 interceptions were followed by an index call before the next
one.** At n=9 that is a shape, not a rate, and it is the number to watch
as it grows.

#### Why it was two, and what EO-173 changed

Reading what those searches were *for* explains the ratio and exonerates
the agent. On run `01a0491b-7689-732c-89c4-d62a0b6f5a92` the interception
fired eight times and the agent took it once. Seven of the eight named a
call that could not have helped: a message type that exists only as a
literal in a comparison, a field the agent was checking the absence of,
the same short word twice as a substring, a name whose only declaration
was an unrelated local in a renderer component, and two searches that
were not of this checkout at all. The eighth was a genuine declared
type, and that is the one the agent acted on.

So the agent was not being stubborn — it was correctly judging that a
declaration lookup does not answer a substring question, and after the
first few it had every reason to discount the rest. The same run's
reviewer made 22 index calls, because a reviewer starts from a diff and
therefore from real declared symbols while an implementer starts from a
hypothesis and a word.

EO-173 makes the decision ask before it speaks. The classifier still
decides from the command line alone, and then the index is asked whether
it holds the thing; a needle it has never heard of, a needle it answers
only loosely — `quota` matching `QuotaEvent` — and a single answer in a
part of the tree the agent did not name are all silence. Every way the
question can fail is silence too: no index, no answer, an answer EO
cannot read, an answer that takes longer than 1.5s. The lookup costs one
local database read, measured at 5ms warm for both shapes of question,
and only for commands the classifier already accepted.

**Eight suggestions and one taken is the number to beat**, and it is a
query: `interceptions` and `interceptionsTakenUp` on the report above.
Nothing here claims it has been beaten — the next run with an index is
what says.

### What the index costs

| | |
|---|---|
| build from nothing | **1.6s** for this repository (624 TypeScript files), pinned binary, timed by hand |
| sync at a handover | median **23ms**, range 19–126ms, over 15 recorded handovers |
| files a sync reported changing | 0 or 1, every time |
| on disk | **45.8 MB** |

The build duration and the size are recorded on `repository_indexes` as
each build finishes, from EO-155 onward; rows written before it hold
neither, and the report says "not recorded" rather than substituting a
zero. The build figure above is therefore a hand measurement of the
pinned binary on this repository rather than a row EO wrote — the first
index built after this story lands will put a real one there.

The costs are not the problem. 1.6s once per worktree and 23ms per
handover is nothing beside a run that spends minutes and millions of
tokens looking around.

## What this does not say

- **Tokens before the first change is usually a bound, not a figure.**
  Both backends report usage once, when a stream ends, so a run that
  edited in its eighth turn has no reading taken at the moment it did.
  Where readings straddle the edit the report says so and gives one
  number; otherwise it gives the least it can have been and the most.
  "Tokens in" also includes cache reads, so on a long run it tracks
  turns and context size as much as it tracks looking around.
- **The arms are different tickets.** Nothing holds difficulty still.
  The on-arm tickets are the ones that built this feature, which is an
  unusually navigation-heavy stretch of work.
- **A ticket whose agent edits through the shell records no `file_edit`
  event**, so it has no "first change" and its whole length counts as
  opening. Four of the fifteen on-arm tickets are in that state — EO-158, EO-160,
  EO-163 and EO-170.
- **n is small and the ranges overlap on every line.** Two confident
  claims made by hand from numbers like these during this feature turned
  out to be wrong, which is why the report refuses to print a difference
  without its spread.

## What would move it

Not more prose in a prompt — EO-164 measured that route and it was
inert. The two things this data points at are the interception
(`broadSearch.ts`, EO-165/168/173: fire at the moment the habit does,
only where the index can actually answer, and count what happened) and
the four tools nothing has ever pointed an agent at. Both are measurable
with the command above, and neither should be claimed before it is.

The route deliberately *not* taken is nudging less often through a
blunter classifier: dropping the symbol case would lose the one kind of
suggestion that works. Nor is there an instruction anywhere telling
agents to trust these suggestions. They have to earn it, which is why
the check is on the suggestion rather than on the agent.

## The claim audit

No token-saving claim appears in this codebase. The subsystem's prose
states a *question* — does a persistent index cost less than
rediscovering the repository — and capability statements that are true
as written: an index returns where a symbol is declared in one call, and
`impact` answers what a change would reach, which no search of the text
can. `measurement.test.ts` scans the feature's surface and fails on any
line that asserts a saving without pointing here.
