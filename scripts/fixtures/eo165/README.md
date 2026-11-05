# EO-165 — the two arms, kept

Runs of `scripts/index-adoption-trial.mjs` against one navigation task,
same model, same harness. The arms differ in one field: the interception
ships only when the query server carries the provider's vocabulary
(`answers`), so `baseline` is the same code with no `hooks` option
reaching the SDK at all.

Kept because the result is not a clean win, and a result that cannot be
re-censused is an assertion. Two commands read these, and both should be
run before quoting anything from here:

    node scripts/index-adoption.mjs --trial scripts/fixtures/eo165/trial-*.json
    pnpm dlx tsx scripts/interception-audit.mts --trial scripts/fixtures/eo165/trial-*.json

The first censuses the recorded calls. The second checks each run's
recorded firings against an independent replay of the shipping
classifier and **exits non-zero** if a run that was given the hook
recorded nothing. It currently exits 0.

## What they say

| | opening repo-searches | broad searches | interceptions recorded | total calls | index calls |
|---|---|---|---|---|---|
| baseline-1 `0298f4ee` | 5 | 3 | — | 22 | 1 — `context` #1 |
| baseline-2 `881a342f` | 5 | 3 | — | 27 | 1 — `context` #1 |
| baseline-3 `4dd7f240` | 3 | 3 | — | 20 | 1 — `context` #1 |
| **baseline mean** | **4.33** | **3.00** | — | **23.0** | 1.0 |
| hook-1 `67b8efab` | 3 | 1 | **1** | 23 | 1 — `context` #1 |
| hook-2 `d82e2d15` | 3 | 2 | **2** | 17 | 2 — `context` #1, **`impact` #10** |
| hook-3 `46176919` | 4 | 3 | **3** | 26 | 1 — `context` #1 |
| **hook mean** | **3.33** | **2.00** | 2.0 | **22.0** | 1.3 |

"Opening repo-searches" is `index-adoption.mjs`'s own count, the one
EO-159, EO-162 and EO-164 were measured with. "Broad searches" is what
EO-165's classifier would intercept, replayed over the recorded calls.
"Interceptions recorded" is what the harness observed EO's hook actually
saying, by wrapping the callback. The last two columns are produced by
different mechanisms and agree run for run, which is the point of having
both.

## What this does and does not show

**On AC6 — "a comparable ticket shows a shorter opening exploration
sequence" — the honest answer is: it moved the right way, and this
cannot prove it.** 4.33 opening repo-searches against 3.33, and 3.00
broad searches against 2.00, three runs each. Both differences point the
same way and both sit inside a spread that runs 3 to 5 at n=3. That is a
weaker claim than the retracted round's flat "no reduction", and it is
nowhere near a result. Do not quote either mean without the spread, and
do not read this as the criterion being met.

Note also what the harness can and cannot stand in for. A change to the
hook does not reach a dispatched agent until it is merged and the app
reloads, which is why EO-164 built this harness at all — and its task is
much smaller than a real ticket, so 3-5 opening searches here is not
comparable to EO-162's 17. Only the two arms are comparable to each
other.

**It does show the mechanism works exactly as designed.** Six firings
across three runs, every one on a genuine repository-wide search, and
the independently-replayed count matches the recorded count on all
three. Nothing fired on the check suite, on git, on a build, or on a
file the agent had already found.

**The clearest difference is one the story says is not the measure.**
`codewiki_impact` at #10 of hook-2 lands on the call immediately after
an interception, and across every run in EO's database before this
story, `impact` had never been invoked once. Counting index calls is
explicitly not how EO-165 is scored — the nudge turns a grep into "grep,
then sometimes one index call", not into "index call instead of grep" —
but it is the one thing here that is not inside the noise.

## An earlier hook arm, and the claim retracted with it

**Retracted:** the commit "Keep both arms, because the result is a
negative one" — `ddf92ce`, and `02583be` after the branch was rebased,
the same commit under two hashes — and the version of this file it added
both stated that "the interception fired three times in every hook run"
and that it "fired exactly where it was meant to". Neither was shown by
the data they shipped with: that transcript's `interceptions` field was
empty for all three runs, and its 3/3/3 broad-search column has been
replaced above by the real 1/2/3.

This is a retraction rather than a quiet supersession. Those commit
messages are in the history and cannot be edited, so the correction has
to live somewhere a reader of them will land.

What actually happened: the callback-wrapping counter was written to
disk while that trial process was already running, so all three runs
went on counting the SDK's `hook_response` messages — which describe a
*command* hook and carry nothing for an in-process callback. The firing
claim came from replaying the classifier over the recorded calls. That
is a sound inference and it is not what the prose said, and at the time
nothing in the repository could contradict it, because the census reads
`calls` and never looked at `interceptions`. `interception-audit.mts
--trial` exists so that it can.

The census half of those runs was never in doubt — the instrumentation
bug touched only the `interceptions` field — so their numbers are
recorded here rather than lost:
`65f6e968` 3 opening / 3 broad / 22 calls / `context` #1 and `impact`
#7; `9be70791` 5 / 3 / 21 / `context` #2 and `search` #8; `9b8e99b5` 4 /
3 / 20 / `context` #1. Pooling those with the three above gives six hook
runs at 3.67 opening repo-searches against the baseline's 4.33 — which
does not change the conclusion above.

The transcript itself is not kept, because its `interceptions` field is
a false zero and `interception-audit.mts --trial` refuses it by design.
An evidence directory should not contain a file that the evidence check
rejects.

## A note on the baseline fixture

It predates the `hookDelivered` field, so the audit derives delivery
from the arm name and says `(inferred from the arm)` in its output. The
derivation is exact rather than a guess: `hook` is the only arm that
gives the query server a vocabulary, and a vocabulary is the only thing
that produces a hook. It was not re-run, because its data is
uncontested and re-running costs three real model sessions to add a
field whose value is already known.
