-- Trial grants and draft copies of modules (EO-583, ARCHITECTURE.md,
-- "Modules: a step that is a script").
--
-- A module nobody has approved runs nowhere. A trial grant lets one run
-- on the items of one trial pipeline, within the needs it declared when
-- the person granted it: `needs` is what it may need and still run, and
-- a save that widens the module past it sets `withdrawn_at`. Withdrawn
-- rather than deleted, so a refusal can say the grant was there.
CREATE TABLE `module_trial_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`trial_pipeline_id` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	`needs` text NOT NULL,
	`withdrawn_at` integer,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trial_pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_module_trial_grants_module` ON `module_trial_grants` (`module_id`,`trial_pipeline_id`);
--> statement-breakpoint
-- The module a trial's draft copy was made from. A module a published
-- pipeline uses is never edited by a trial; the trial is given a copy,
-- and this is what links the copy to the original.
ALTER TABLE `modules` ADD `forked_from_module_id` text;
