-- The Consult tab: an open-ended conversation with the product owner.
--
-- The conversation is a ticket, because `runs.ticket_id` is NOT NULL and
-- `run_events`, cost accounting and crash recovery are all keyed on
-- tickets. A separate conversations table would either need that column
-- made nullable — surgery on the durability substrate (invariant #3) —
-- or would have to run agents outside the run system and lose all three.
-- Being a ticket also means the messages are ordinary comments, so
-- invariant #4 holds literally rather than by exception.
--
-- `owner_role` is NULL, and that is the load-bearing part. The scheduler
-- skips human-owned states outright, so `tick()` never dispatches a
-- conversation and never spends a capacity slot on one. What drives it
-- instead is the mention path (`findPendingResponses`, the design's second entry point): sending a
-- chat message posts a human comment
-- mentioning the product owner, and that is what starts the run. That
-- path has always run outside `tick()`'s accounting, so a chat reply
-- does not queue behind an implementer — with no change to invariant #10,
-- which still governs every run that performs work.
--
-- `entry_action` is NULL for the same reason: nothing enters this state
-- by transition, so there is no entry action to run. The action is
-- resolved per dispatch instead.
--
-- Position -1 puts it outside the pipeline rather than at the front of
-- it. Nothing transitions into or out of `consult`, and `off_board`
-- keeps it from rendering as a column, so the number only has to not
-- collide.
ALTER TABLE `workflow_states` ADD COLUMN `off_board` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
INSERT INTO `workflow_states` (`id`, `position`, `owner_role`, `entry_action`, `is_terminal`, `opens_pull_request`, `off_board`) VALUES
	('consult', -1, NULL, NULL, 0, 0, 1);
--> statement-breakpoint
-- The product owner becomes read-only, which it always should have been.
--
-- It writes no code in any of its actions — intake, refine and consult
-- all produce structured results, and everything they put in a thread is
-- posted by the engine. But it runs under `permissionMode:
-- "bypassPermissions"` like every other agent, and a *feature* ticket's
-- dispatch gets `cwd = repoPath` rather than a worktree, so until now the
-- product owner could edit the user's actual working copy. Nothing had
-- ever been seen doing it; the exposure was real regardless, and the
-- Consult tab makes it routine by giving the PO a reason to be in the
-- repository on every turn.
--
-- `mcp__eo__ticket_detail` is EO's own read tool. An allowlist is
-- exhaustive, so naming it here is what permits it at all.
--
-- Only agents nobody has configured: a non-empty `config` is a choice
-- someone made in Settings, and silently narrowing it would be the same
-- mistake `syncRolePrompts` deliberately avoids with instructions.
UPDATE `agents`
SET `config` = '{"allowedTools":["Read","Grep","Glob","mcp__eo__ticket_detail"]}'
WHERE `role` = 'product_owner'
  AND (`config` IS NULL OR trim(`config`) = '' OR trim(`config`) = '{}');
