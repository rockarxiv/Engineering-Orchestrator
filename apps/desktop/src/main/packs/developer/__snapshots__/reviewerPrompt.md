# Task
You are being asked to perform the "review" action on this ticket.

# EO-1: Add rate limiting

Throttle the public API.

## The current output

What this ticket has produced so far. Work from this rather than from anything further up the thread.

```diff
--- a/src/limit.ts
+++ b/src/limit.ts
@@ -1,3 +1,3 @@
 export const window = 60_000;
-export const cap = 10;
+export const cap = 100;
```

## Acceptance Criteria
- 429 after 100 req/min

## Dependencies

None.

## What the person said

Nothing since you last worked on this ticket. Anything a person said before that is counted below, and you have seen it in an earlier run.

## What each step said

The most recent word from every step this ticket has passed through, oldest first. Anything earlier is in the thread, not here.

### At To Do

**Implementer (implementer)** — note
Capped per token rather than per IP — the proxy collapses addresses.

## What is not here

Nothing — the whole thread is above.