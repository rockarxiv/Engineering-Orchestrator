-- Trial pipelines and trial items (EO-582, ARCHITECTURE.md, "Trial
-- pipelines").
--
-- A draft cannot carry items: an item stands on a live
-- `pipeline_steps` row and binds to a published version. So a draft
-- under test is materialised as a pipeline of its own — steps, routes
-- and a version written the ordinary way — and marked as a trial, so
-- that nothing a person browses shows it.
--
-- `trial_at` is the mark, a timestamp for the reason every mark on these
-- tables is one. `trial_conversation_id` is the assistant conversation
-- the trial came from, and `trial_target_pipeline_id` the pipeline the
-- draft would replace, or null for a draft that creates one. Neither
-- carries a foreign key: a trial is deleted with its conversation's
-- loop, and a constraint would only turn deleting a chat into a failure.
ALTER TABLE `pipelines` ADD `trial_at` integer;
--> statement-breakpoint
ALTER TABLE `pipelines` ADD `trial_conversation_id` text;
--> statement-breakpoint
ALTER TABLE `pipelines` ADD `trial_target_pipeline_id` text;
--> statement-breakpoint
-- The item's own mark. Not `preview_at`: a preview runs on the fake
-- backend with no disk and pretends its side effects, while a trial item
-- runs on real backends, real workspaces and real modules. What the two
-- share is what a person browses — a trial item is left out of the
-- board, the inbox, the `!` marker and the archive — and what they do
-- not share is cost: a trial's runs count against the budgets.
ALTER TABLE `items` ADD `trial_at` integer;
