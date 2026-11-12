-- Where each watch job's checks stand (EO-753, ARCHITECTURE.md §9.1).
--
-- A watch job runs its module as an intake check every `everyMinutes`
-- while EO is open, and files what it finds. What it has to remember
-- between checks is state, not history -- when it last looked, what it
-- answered, when it looks next, how many checks in a row have failed and
-- why, and which item a `waitWhileOpen` job is holding for -- so it is one
-- row per job, updated in place. What each finding did is history, and
-- that is `job_events`, append-only as before.
--
-- No row until the job's first check: a job with none is due at once.
CREATE TABLE `job_watch_states` (
	`job_id` text PRIMARY KEY NOT NULL,
	`last_checked_at` integer,
	`last_answer` text,
	`next_check_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`waiting_for_item_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
