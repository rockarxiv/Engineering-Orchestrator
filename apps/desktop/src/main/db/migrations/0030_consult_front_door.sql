-- A pipeline holds only work, and Consult is where work comes from.
--
-- Two changes that are really one. `intake`, `backlog` and
-- `pending_approval` were columns where a ticket was still *becoming* a
-- ticket: being understood, being decomposed, waiting for someone to
-- approve the decomposition. That is a conversation, and it now happens in
-- Consult — the actions survive untouched (`intake`, `refine`, the
-- proposal, the human approval that turns it into stories); what changes
-- is that a conversation drives them rather than a ticket parked in a
-- column waiting to be dispatched.
--
-- With those gone, every remaining step is something done *to* a ticket
-- that already exists and is already understood — which is what makes
-- "who is responsible right now" a complete description of a column.
--
-- And a feature stops being on a pipeline at all. It was never work: it
-- carries no changes of its own, nothing dispatches against it, and its
-- state was already derived from its stories rather than earned. So its
-- pipeline and step become NULL, and "is this feature done" becomes a
-- question about its stories, asked when someone looks.

-- Stories still mid-approval land where work enters. Features are handled
-- by the NULL below; a conversation is off-board and is left alone.
UPDATE `tickets` SET `step_id` = COALESCE(
	(SELECT `entry_step_id` FROM `pipelines` WHERE `pipelines`.`id` = `tickets`.`pipeline_id`),
	`step_id`
)
WHERE `step_id` IN ('intake', 'backlog', 'pending_approval');
--> statement-breakpoint

DELETE FROM `step_routes` WHERE `from_step_id` IN ('intake', 'backlog', 'pending_approval')
	OR `target` IN ('intake', 'backlog', 'pending_approval');
--> statement-breakpoint
DELETE FROM `pipeline_steps` WHERE `id` IN ('intake', 'backlog', 'pending_approval');
--> statement-breakpoint
UPDATE `pipeline_steps` SET `position` = CASE `id`
	WHEN 'worktree'       THEN 0
	WHEN 'todo'           THEN 1
	WHEN 'review'         THEN 2
	WHEN 'merge_request'  THEN 3
	WHEN 'ready_to_merge' THEN 4
	ELSE `position`
END
WHERE `pipeline_id` = 'default';
--> statement-breakpoint

-- A feature belongs to no pipeline, so both columns have to admit it.
-- Rebuilt rather than altered: SQLite cannot drop NOT NULL in place.
--
-- `runs`, `comments`, `transitions`, `ticket_deps`, `attachments`,
-- `comment_mentions` and `outbox` all reference `tickets`.
-- `runMigrations` turns foreign keys off around the batch and runs
-- `foreign_key_check` afterwards, so an orphaned row still fails loudly.
CREATE TABLE `tickets_new` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL UNIQUE,
	`type` text NOT NULL,
	`parent_id` text REFERENCES `tickets`(`id`),
	`repository_id` text REFERENCES `repositories`(`id`),
	`project_id` text REFERENCES `projects`(`id`),
	`title` text NOT NULL,
	`body` text,
	`spec` text,
	`pipeline_id` text REFERENCES `pipelines`(`id`),
	`step_id` text REFERENCES `pipeline_steps`(`id`),
	`priority` integer DEFAULT 0 NOT NULL,
	`branch` text,
	`pr_url` text,
	`jira_key` text,
	`jira_id` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `tickets_new`
SELECT `id`, `key`, `type`, `parent_id`, `repository_id`, `project_id`, `title`, `body`, `spec`,
       `pipeline_id`, `step_id`, `priority`, `branch`, `pr_url`, `jira_key`, `jira_id`,
       `archived_at`, `created_at`, `updated_at`
FROM `tickets`;
--> statement-breakpoint
DROP TABLE `tickets`;
--> statement-breakpoint
ALTER TABLE `tickets_new` RENAME TO `tickets`;
--> statement-breakpoint

-- Features leave the pipeline. Not conversations: a Consult conversation
-- is a feature-typed ticket only so that it can host runs, and it lives on
-- an off-board step that is not a column either.
UPDATE `tickets` SET `pipeline_id` = NULL, `step_id` = NULL
WHERE `type` = 'feature'
  AND `step_id` NOT IN (SELECT `id` FROM `pipeline_steps` WHERE `off_board` = 1);
