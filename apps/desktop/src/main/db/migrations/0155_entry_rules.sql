-- What an item must have to enter a pipeline (EO-610, ARCHITECTURE.md,
-- "Entry rules").
--
-- Beside the graph on both tables, for the reason `entry_step_id` is: the
-- `pipelines` row is the current version as it stands, and the
-- `pipeline_versions` row is what one version froze, so a rollback can
-- restore the rules and "View changes" can show them.
--
-- JSON, because the list is ordered and read whole. '[]' on every row that
-- exists, so a pipeline and each of its versions asks for nothing until
-- somebody says otherwise.
ALTER TABLE `pipelines` ADD `entry_rules` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `pipeline_versions` ADD `entry_rules` text DEFAULT '[]' NOT NULL;
