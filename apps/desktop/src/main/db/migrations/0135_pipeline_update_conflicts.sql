-- An update a pipeline could not take (EO-532).
--
-- When a release ships a newer version of the template a pipeline came
-- from, EO compares three graphs: the base the pipeline came from, the
-- pipeline as the person has it, and the new version. Where both the
-- person and the template changed one key differently, nothing from
-- that version is applied — and this row is what says so: which
-- template version, the base it was compared with, and each conflicting
-- key with its base, current and template values. The pipeline keeps
-- working exactly as it is.
--
-- Open while `resolved_at` is null. Resolving one — publishing a merge
-- from the assistant, or keeping one's own version — is a later
-- story's; this one closes an open row only when a still newer version
-- supersedes it.
--
-- No graph is edited here. As of this release, template changes reach
-- pipelines only as template versions (ARCHITECTURE.md, "Template
-- versions and origins"); a migration never rewrites a pipeline graph
-- again.
CREATE TABLE `pipeline_update_conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`pipeline_id` text NOT NULL REFERENCES `pipelines`(`id`) ON DELETE cascade,
	`template_slug` text NOT NULL,
	`from_version` text NOT NULL,
	`to_version` text NOT NULL,
	`base_id` text NOT NULL,
	`template_id` text NOT NULL,
	`notes` text NOT NULL,
	`conflicts` text NOT NULL,
	`problems` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolution` text
);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_update_conflicts_pipeline` ON `pipeline_update_conflicts` (`pipeline_id`,`resolved_at`);
