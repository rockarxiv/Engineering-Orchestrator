-- Two things the pull request step finds and sends back, and somewhere
-- for the shipped pipeline to send them (EO-429).
--
-- `open_pull_request` now looks at the ticket's worktree before it
-- pushes, and pushes on every pass rather than only the first. Both can
-- end in something the step will not resolve itself: files nobody
-- committed (`uncommitted_changes`), and a remote branch holding commits
-- the local one does not (`remote_diverged`), which EO never force-pushes
-- over. Each is a declared result, so where it goes is a row rather than
-- TypeScript (invariant #7).
--
-- Both are seeded to `todo` — the implementer — rather than to
-- `user_attention`, which is where `0049` sent `failed`. That one was
-- preserving what the step already did. These two are new, and neither
-- needs a person: the files are committed or removed by whoever wrote
-- them, and a diverged branch is the expected result of verification
-- rebasing a branch whose pull request is already open. The step posts
-- an engine note saying which it was before it returns either.
--
-- Guarded the way `0049` is: only where both steps exist — and are not
-- retired, which a row can be since `0098` — and only where no route for
-- that key exists already. An installation whose owner has
-- removed either step, or already routed either key, is left alone.
INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT 'r_merge_uncommitted', 'default', 'merge_request', 'uncommitted_changes', 'Uncommitted changes', 'warning', 'todo', 3
WHERE EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'merge_request' AND `pipeline_id` = 'default' AND `retired_version` IS NULL)
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'todo' AND `pipeline_id` = 'default' AND `retired_version` IS NULL)
  AND NOT EXISTS (SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'merge_request' AND `result_key` = 'uncommitted_changes');
--> statement-breakpoint
INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT 'r_merge_diverged', 'default', 'merge_request', 'remote_diverged', 'Remote branch diverged', 'warning', 'todo', 4
WHERE EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'merge_request' AND `pipeline_id` = 'default' AND `retired_version` IS NULL)
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'todo' AND `pipeline_id` = 'default' AND `retired_version` IS NULL)
  AND NOT EXISTS (SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'merge_request' AND `result_key` = 'remote_diverged');
