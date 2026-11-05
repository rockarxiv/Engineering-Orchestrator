-- The shipped pipeline watches the pull request it opened (EO-461).
--
-- Until now an item whose pull request was opened went straight to Done,
-- and anything that happened on the forge afterwards — a failed check, a
-- request for changes, a conflict, the merge itself — reached EO only
-- when a person came and said so. `watch_pull_request` (EO-460) is the
-- check that notices, and a step in keep-checking mode (EO-456) is what
-- asks it on an interval rather than holding a process open for the
-- days a review takes.
--
-- So a step goes between Merge Request and Done, checking every five
-- minutes and giving up after a week (168 hours, the default), and
-- Merge Request's success route is re-pointed through it rather than a
-- second edge added beside it — two edges out of one result is the
-- ambiguity 0057 records. Where each of the watch's results goes is
-- rows, not TypeScript (invariant #7):
--
-- * `merged` goes to Done. A person did the merging; EO only noticed.
-- * `checks_failed`, `changes_requested` and `conflict` go back to the
--   implementer, who fixes the branch. The item then passes through
--   Review and Merge Request again, which pushes to the pull request
--   already open (0114, EO-429), and comes back here. The check posts
--   what it noticed before the result routes, so that comment is on the
--   item when the implementer is dispatched to read it.
-- * `closed` and `failed` ask a person: a pull request closed without
--   merging is somebody's decision, and a watch that cannot read the
--   pull request at all is not something the implementer can fix.
--
-- `ready` asks a person too. The check answers it only when the step's
-- `reportReady` input asks, and this step does not set it, so the route
-- is not taken here. It is routed anyway because a result nothing routes
-- is a warning on every installation's configuration screen, and because
-- someone who does turn it on is asking to be told the pull request can
-- be merged — which is a person's job, not EO's.
--
-- Guarded the way 0114 is, and narrower. Only where Merge Request, Done
-- and To Do all exist and none is retired (`0098`), and only where
-- Merge Request's success route still targets Done. An installation
-- whose owner sent `opened` somewhere of their own — EO's own Delivery
-- routes it into a Merge pipeline — is left exactly as it is.
--
-- The order is what makes it safe to run twice. The last statement
-- re-points `opened`, which is the condition every earlier one checks,
-- so once it has run nothing here matches again.

-- Room after Merge Request. Spelled as a shift rather than 0057's table
-- of positions, because an installation this guard admits can have
-- steps of its own anywhere in the pipeline.
UPDATE `pipeline_steps` SET `position` = `position` + 1
WHERE `pipeline_id` = 'default'
  AND `position` > (SELECT `position` FROM `pipeline_steps` WHERE `id` = 'merge_request')
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'merge_request' AND `pipeline_id` = 'default' AND `retired_version` IS NULL)
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'ready_to_merge' AND `pipeline_id` = 'default' AND `retired_version` IS NULL)
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'todo' AND `pipeline_id` = 'default' AND `retired_version` IS NULL)
  AND EXISTS (SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'merge_request' AND `result_key` = 'opened' AND `target` = 'ready_to_merge')
  AND NOT EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'pull_request_watch');
--> statement-breakpoint
INSERT INTO `pipeline_steps` (`id`, `pipeline_id`, `position`, `name`, `type`, `owner_role`, `entry_action`, `instructions_summary`, `is_terminal`, `off_board`, `watch_every_minutes`, `watch_give_up_hours`)
SELECT 'pull_request_watch', 'default', `position` + 1, 'Watching pull request', 'builtin', NULL, 'watch_pull_request',
       'Checks the pull request until it is merged, closed or needs work', 0, 0, 5, 168
FROM `pipeline_steps`
WHERE `id` = 'merge_request' AND `pipeline_id` = 'default' AND `retired_version` IS NULL
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'ready_to_merge' AND `pipeline_id` = 'default' AND `retired_version` IS NULL)
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'todo' AND `pipeline_id` = 'default' AND `retired_version` IS NULL)
  AND EXISTS (SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'merge_request' AND `result_key` = 'opened' AND `target` = 'ready_to_merge')
  AND NOT EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'pull_request_watch');
--> statement-breakpoint
-- The watch's routes. Each is written only while the step above exists
-- and `opened` has not yet been re-pointed — which is to say, only by
-- this migration, on a pipeline the guard above admitted.
INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT `id`, 'default', 'pull_request_watch', `result_key`, `label`, `tone`, `target`, `position`
FROM (
  SELECT 'r_watch_merged' AS `id`, 'merged' AS `result_key`, 'Merged' AS `label`, 'success' AS `tone`, 'ready_to_merge' AS `target`, 0 AS `position`
  UNION ALL SELECT 'r_watch_checks_failed', 'checks_failed', 'Checks failed', 'warning', 'todo', 1
  UNION ALL SELECT 'r_watch_changes_requested', 'changes_requested', 'Changes requested', 'warning', 'todo', 2
  UNION ALL SELECT 'r_watch_conflict', 'conflict', 'Conflicts with the base branch', 'warning', 'todo', 3
  UNION ALL SELECT 'r_watch_closed', 'closed', 'Closed without merging', 'warning', 'user_attention', 4
  UNION ALL SELECT 'r_watch_ready', 'ready', 'Ready to merge', 'info', 'user_attention', 5
  UNION ALL SELECT 'r_watch_failed', 'failed', 'Could not watch the pull request', 'danger', 'user_attention', 6
) AS `seeded`
WHERE EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'pull_request_watch' AND `pipeline_id` = 'default' AND `entry_action` = 'watch_pull_request' AND `retired_version` IS NULL)
  AND EXISTS (SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'merge_request' AND `result_key` = 'opened' AND `target` = 'ready_to_merge')
  AND NOT EXISTS (SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'pull_request_watch' AND `result_key` = `seeded`.`result_key`);
--> statement-breakpoint
-- And last, the success route through it.
UPDATE `step_routes` SET `target` = 'pull_request_watch'
WHERE `pipeline_id` = 'default' AND `from_step_id` = 'merge_request' AND `result_key` = 'opened' AND `target` = 'ready_to_merge'
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'pull_request_watch' AND `pipeline_id` = 'default' AND `entry_action` = 'watch_pull_request' AND `retired_version` IS NULL);
