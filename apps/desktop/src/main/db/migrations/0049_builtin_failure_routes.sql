-- A failure with a name, and somewhere for the shipped pipeline to send it
-- (EO-77).
--
-- `create_worktree` declared one result, `ready`, and `open_pull_request`
-- declared `opened` and `skipped`. None of them was a failure, so a
-- failure had nowhere to go: every one ended the same way, parked with a
-- question, whatever the pipeline would have preferred. `failed` is
-- declared alongside the others now, which makes routing it a row rather
-- than a change to TypeScript (invariant #7).
--
-- Both are seeded to `user_attention` — ask a person — because that is
-- exactly what these steps did before, and an upgrade should not change
-- where anybody's work goes. What changes is that it is now visible in
-- the configuration screen and can be pointed somewhere else.
INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT 'r_worktree_failed', 'default', 'worktree', 'failed', 'Could not prepare the worktree', 'danger', 'user_attention', 1
WHERE EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'worktree')
  AND NOT EXISTS (SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'worktree' AND `result_key` = 'failed');
--> statement-breakpoint
INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT 'r_merge_failed', 'default', 'merge_request', 'failed', 'Could not open the pull request', 'danger', 'user_attention', 2
WHERE EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'merge_request')
  AND NOT EXISTS (SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'merge_request' AND `result_key` = 'failed');
