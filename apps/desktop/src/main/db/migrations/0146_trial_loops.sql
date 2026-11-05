-- A draft's test-fix loop (EO-586, ARCHITECTURE.md, "Trial pipelines").
--
-- The rounds a loop has started, where each trial item got to each time
-- EO woke the assistant about it, and the guardrail stops with what the
-- person answered. Each is gone with its trial: discarding one deletes
-- its pipeline, and the cascade takes these rows with it.
CREATE TABLE `trial_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`trial_pipeline_id` text NOT NULL,
	`number` integer NOT NULL,
	`started_at` integer NOT NULL,
	`started_by` text NOT NULL,
	FOREIGN KEY (`trial_pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_trial_rounds_trial` ON `trial_rounds` (`trial_pipeline_id`,`number`);
--> statement-breakpoint
CREATE TABLE `trial_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`trial_pipeline_id` text NOT NULL,
	`round_id` text,
	`item_id` text NOT NULL,
	`event` text NOT NULL,
	`step_id` text NOT NULL,
	`result` text NOT NULL,
	`failed` integer NOT NULL,
	`run_id` text,
	`comment_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`trial_pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_trial_outcomes_trial` ON `trial_outcomes` (`trial_pipeline_id`,`item_id`);
--> statement-breakpoint
CREATE TABLE `trial_stops` (
	`id` text PRIMARY KEY NOT NULL,
	`trial_pipeline_id` text NOT NULL,
	`guard` text NOT NULL,
	`comment_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`choice` text,
	`answered_at` integer,
	`answered_after_round` integer,
	FOREIGN KEY (`trial_pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_trial_stops_trial` ON `trial_stops` (`trial_pipeline_id`);
--> statement-breakpoint
CREATE INDEX `idx_trial_stops_comment` ON `trial_stops` (`comment_id`);
