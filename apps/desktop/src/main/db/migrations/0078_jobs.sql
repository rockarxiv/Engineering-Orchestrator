-- Jobs, their occurrences, and the off-board step a job's thread lives
-- on (EO-304, ARCHITECTURE.md, "Jobs", "Conversations").
--
-- A job is the recurring definition: a trigger, a pipeline, a template
-- for the item it stamps out, and an owner. Nothing here is a second
-- kind of work item -- what a job produces is an ordinary `items` row on
-- an ordinary step. Two trigger kinds arrive with this migration,
-- `manual` and `from-discussion`; `schedule` is the next story and
-- `webhook` waits for the server that has a public address.
--
-- `pipeline_id` and `template` are nullable and a `manual` job has both:
-- a `from-discussion` job has neither, because the conversation supplies
-- the item and the approval resolves the placement.
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text REFERENCES `projects`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`trigger` text NOT NULL,
	`pipeline_id` text REFERENCES `pipelines`(`id`),
	`template` text,
	`owner_id` text NOT NULL REFERENCES `people`(`id`),
	`thread_item_id` text NOT NULL REFERENCES `items`(`id`),
	`paused_at` integer,
	`budget_per_occurrence_cents` integer,
	`max_items_per_hour` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
-- Append-only, the way `transitions` is. Nothing updates or deletes a
-- row -- `db/architecturalInvariants.test.ts` checks that beside
-- `run_events` -- because an occurrence's whole value is that it says
-- what happened at a moment that has passed, and a `skipped` row that
-- can be tidied away is a job that quietly never ran.
--
-- `item_id` carries no foreign key on purpose. A person may delete the
-- item (KAN-30) and the record of the firing outlives it: a cascade
-- would erase the firing, and `ON DELETE SET NULL` would rewrite a row
-- that is supposed to be immutable.
CREATE TABLE `job_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL REFERENCES `jobs`(`id`) ON DELETE cascade,
	`due_at` integer NOT NULL,
	`fired_at` integer,
	`status` text NOT NULL,
	`reason` text,
	`item_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_job_occurrences_job` ON `job_occurrences` (`job_id`,`due_at`);
--> statement-breakpoint
CREATE INDEX `idx_job_occurrences_item` ON `job_occurrences` (`item_id`);
--> statement-breakpoint
-- Where a job's thread lives.
--
-- A fourth off-board step on the existing `discussions` pipeline, for
-- 0036's and 0064's reason, which is one reason: the step is what the
-- code keys on. `listConversations` scopes the Discussions picker with
-- `step_id = 'discussion'`, so a job thread sharing that step would put
-- every job in the conversation picker and let `activeConversation` pick
-- one as the room a person is typing into.
--
-- `owner_role` NULL and `type = 'user'` keep the scheduler away from it
-- entirely, and `entry_action` is NULL because nothing arrives here by
-- transition: a job thread is never dispatched against. It is a place to
-- post, which is exactly what invariant 8 needs when a guard fires and
-- no item exists to post on.
--
-- Position -4 beside `assist`'s -3, outside the pipeline rather than at
-- the front of it -- `off_board` keeps it from rendering as a column, so
-- the number only has to not collide. Joining `discussions` rather than
-- starting a pipeline keeps that pipeline hidden from the sidebar and
-- unassignable by `resolvePlacement` with no code change, both of which
-- are derived from the steps rather than from an id.
INSERT INTO `pipeline_steps`
	(`id`, `pipeline_id`, `position`, `name`, `type`, `owner_role`, `entry_action`, `instructions_summary`, `is_terminal`, `plan_mode`, `off_board`)
VALUES
	('job-thread', 'discussions', -4, 'Job thread', 'user', NULL, NULL, NULL, 0, 0, 1);
--> statement-breakpoint
-- `JOB-1`, for the reason `DISC`, `ARCH` and `ASK` have sequences of
-- their own: a thread is an item so that it can hold comments, and
-- burning work numbers on them would put holes in the sequence people
-- read and quote.
INSERT INTO `key_counters` (`prefix`, `next_value`) VALUES ('JOB', 1);
