-- Pipelines remember the template version they came from (EO-531).
--
-- A pipeline made from a gallery template had no record of where it came
-- from, so the only way a template's improvement reached an installed
-- pipeline was a guarded migration like 0114 or 0123, which changed a
-- pipeline nobody touched without saying so and skipped one somebody had
-- customised without saying so either. An origin is what lets a later
-- release compare the two instead: the template's slug, its version, and
-- a stored snapshot of that version — the base.
--
-- The snapshot is a row here rather than a path to the file the app
-- ships, so the base survives a release that drops an old file. Shared
-- by every pipeline made from the same document; `digest` tells two
-- documents apart that claim the same slug and version.
CREATE TABLE `template_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`version` text NOT NULL,
	`digest` text NOT NULL,
	`document` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_template_versions_digest` ON `template_versions` (`slug`,`version`,`digest`);
--> statement-breakpoint
-- The origin itself, all four null on a pipeline with none. Nothing is
-- backfilled here: which template version an existing pipeline came
-- from is decided by matching its step ids against the versions the app
-- ships, which are files this migration cannot read. The startup
-- backfill does that once (`backfillPipelineOrigins`).
ALTER TABLE `pipelines` ADD `template_slug` text;
--> statement-breakpoint
ALTER TABLE `pipelines` ADD `template_version` text;
--> statement-breakpoint
ALTER TABLE `pipelines` ADD `template_base_id` text;
--> statement-breakpoint
ALTER TABLE `pipelines` ADD `template_step_ids` text;
