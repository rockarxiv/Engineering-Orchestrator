-- What the person did with a suggested reply shown in an assistant chat's
-- composer (EO-895): shown, accepted, sent (edited or not) or dismissed.
--
-- Keyed by the run the suggestion follows, which is what EO-810's
-- `prompt_suggestion` side call and `suggested_reply` run event name, so
-- the three read together. One row per action; the unique index holds
-- each action to once per suggestion. Never updated; a row goes only
-- with its run.
CREATE TABLE `suggested_reply_uses` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`action` text NOT NULL,
	`edited` integer,
	`dismissed_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_suggested_reply_uses_action` ON `suggested_reply_uses` (`run_id`,`action`);
