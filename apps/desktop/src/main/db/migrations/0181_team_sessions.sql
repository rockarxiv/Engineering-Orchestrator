-- Team sessions and their participants' attempts (EO-844, ARCHITECTURE.md,
-- "A team on an agent step").
--
-- A session is one team's work on one item, on one step entry, under one
-- pinned pipeline version, with the team copied as it was configured. An
-- attempt is one participant's go at one assignment; its thread, timing and
-- spending are its run's, so a team's spending is summed from runs once.
-- An accepted report is a comment the attempt names (unique, written once);
-- a retry is a new attempt naming the one it supersedes. Rows go only with
-- their item, by deleteItem; archiving removes none.
CREATE TABLE `team_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`step_id` text NOT NULL,
	`entry_transition_id` text,
	`pipeline_version_id` text,
	`run_id` text,
	`team` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`final_comment_id` text,
	`superseded_by` text,
	`device_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`final_comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_team_sessions_item` ON `team_sessions` (`item_id`);
--> statement-breakpoint
CREATE INDEX `idx_team_sessions_updated` ON `team_sessions` (`updated_at`,`id`);
--> statement-breakpoint
CREATE TABLE `team_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`item_id` text NOT NULL,
	`assignment_key` text NOT NULL,
	`role` text NOT NULL,
	`agent_id` text,
	`agent_name` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`run_id` text,
	`status` text NOT NULL,
	`outcome` text,
	`error` text,
	`evidence_baseline` text,
	`report_comment_id` text,
	`accepted_at` integer,
	`superseded_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `team_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_team_attempts_session` ON `team_attempts` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_team_attempts_item` ON `team_attempts` (`item_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_attempts_number` ON `team_attempts` (`session_id`,`assignment_key`,`round`,`attempt`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_attempts_report` ON `team_attempts` (`report_comment_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_attempts_run` ON `team_attempts` (`run_id`);
