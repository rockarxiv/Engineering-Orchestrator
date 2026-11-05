-- Indexing the worktree becomes a column on the board (EO-149).
--
-- It could have been a few lines inside the worktree builtin, and that is
-- exactly the shape the design argues against for worktree setup itself:
-- a ticket whose checkout is being walked would look identical to one
-- where nothing is happening. As a step it has a card, an elapsed time, a
-- run row, a transcript and somewhere to fail — and, because a pipeline is
-- data, a person who does not want it deletes this row (invariant #7).
--
-- Between `worktree` and `todo`, because the index describes a checkout
-- and the implementer is the first thing that queries one. So the route
-- that used to carry a prepared worktree straight to the implementer is
-- re-pointed through here rather than a new edge being added beside it —
-- two edges out of one result is not a fork, it is an ambiguity the
-- validator would have to break arbitrarily.
--
-- Every result routes onward to `todo`, `failed` included. That is not
-- the usual seeding, and it is the point: repository intelligence
-- degrades and never blocks (EO-141). An agent without an index is an
-- agent with the filesystem and git tools it had before this feature
-- existed, so a machine upstream publishes no build for must not park
-- somebody's ticket. `0049` sent both other builtins' failures to
-- `user_attention` because that was what those steps already did when
-- they failed; this one has never had a failure that was worth stopping
-- for. The supervisor still comments on it (invariant #8) — the ticket
-- just does not wait for the answer.
--
-- Guarded with WHERE EXISTS / NOT EXISTS throughout, like every other
-- pipeline seed here: an installation whose owner has already rearranged
-- the default pipeline gets nothing done to it twice.

INSERT INTO `pipeline_steps` (`id`, `pipeline_id`, `position`, `name`, `type`, `owner_role`, `entry_action`, `instructions_summary`, `is_terminal`, `off_board`)
SELECT 'repository_index', 'default', 1, 'Index', 'builtin', NULL, 'index_repository', 'Describes the checkout so agents can query it instead of searching it', 0, 0
WHERE EXISTS (SELECT 1 FROM `pipelines` WHERE `id` = 'default')
  AND NOT EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'repository_index');
--> statement-breakpoint

-- Spelled out rather than computed, for the reason 0029 records: a
-- correlated count over the table being updated reads rows it has already
-- rewritten, and duplicate positions are what the validator rejects.
UPDATE `pipeline_steps` SET `position` = CASE `id`
	WHEN 'worktree'         THEN 0
	WHEN 'repository_index' THEN 1
	WHEN 'todo'             THEN 2
	WHEN 'review'           THEN 3
	WHEN 'merge_request'    THEN 4
	WHEN 'ready_to_merge'   THEN 5
	ELSE `position`
END
WHERE `pipeline_id` = 'default'
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'repository_index');
--> statement-breakpoint

-- A prepared worktree now arrives at the index rather than at the
-- implementer. Re-pointed only if it still says what 0029 seeded, so an
-- owner who has already sent `ready` somewhere of their own keeps it.
UPDATE `step_routes` SET `target` = 'repository_index'
WHERE `pipeline_id` = 'default' AND `from_step_id` = 'worktree' AND `result_key` = 'ready' AND `target` = 'todo'
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'repository_index');
--> statement-breakpoint

INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT 'r_index_indexed', 'default', 'repository_index', 'indexed', 'Indexed', 'success', 'todo', 0
WHERE EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'repository_index')
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'todo')
  AND NOT EXISTS (SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'repository_index' AND `result_key` = 'indexed');
--> statement-breakpoint

-- Switched off, or a ticket with no repository to describe. Nothing went
-- wrong, so it reads as information rather than as a warning.
INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT 'r_index_skipped', 'default', 'repository_index', 'skipped', 'Not indexed', 'info', 'todo', 1
WHERE EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'repository_index')
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'todo')
  AND NOT EXISTS (SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'repository_index' AND `result_key` = 'skipped');
--> statement-breakpoint

-- `danger`, because something did go wrong and a person should be able to
-- see which ticket it was — but pointed at the implementer, because the
-- work goes on without it.
INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT 'r_index_failed', 'default', 'repository_index', 'failed', 'Indexing failed', 'danger', 'todo', 2
WHERE EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'repository_index')
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'todo')
  AND NOT EXISTS (SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'repository_index' AND `result_key` = 'failed');
