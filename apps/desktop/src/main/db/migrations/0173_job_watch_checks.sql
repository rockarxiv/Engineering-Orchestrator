-- Every check a watch job ran (EO-800, ARCHITECTURE.md §9.1).
--
-- `job_watch_states` is where the checks stand, one row per job updated
-- in place, and `job_events` only gains a row when a finding is filed or
-- refused -- so a check that found nothing left no trace. This is the
-- history: one row per check, written when it ends, never updated or
-- deleted. A check held by `waitWhileOpen` did not run and writes none.
--
-- `answer` is `waiting`, the declared result, or `failed`. `detail` is
-- the module's detail, or why the check failed. `filed_item_ids` is a
-- JSON array of the items the check filed; not foreign keys, since a
-- person may delete one. `output` is the last 4,000 characters of the
-- module's transcript, already redacted. Rows go only with their job.
CREATE TABLE `job_watch_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`answer` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`finding_count` integer DEFAULT 0 NOT NULL,
	`filed_item_ids` text DEFAULT '[]' NOT NULL,
	`output` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_job_watch_checks_job` ON `job_watch_checks` (`job_id`,`started_at`);
