-- Workflows become per-pipeline, and routing becomes a graph (KAN-52).
--
-- `workflow_states` was DATA rather than code from the start, which was
-- right — but there was exactly one of it, globally, shared by every
-- group. That is the reason `plan_mode` had to be bolted onto the group
-- with the note "a per-project gate cannot be a state without making
-- workflows per-project", and the reason two teams could not run
-- different processes in one install.
--
-- Three tables replace it: a `pipelines` row per configurable route, a
-- `pipeline_steps` row per step of one, and a `step_routes` row per
-- declared result of a step saying where that result sends the ticket.
-- The last is the real change: "one position down the pipeline" plus the
-- hard-coded `ready_to_merge` / `todo` / `pending_approval` literals in
-- roles/wiring.ts become rows a person can edit.
--
-- The seeded steps keep the ids their states had. Renumbering them to
-- uuids would have rewritten every existing ticket's column to buy
-- nothing: what stopped routing hard-coding a literal is that routing now
-- reads `step_routes`, not that the value became unreadable. Steps a
-- person adds later get uuidv7 like everything else.

CREATE TABLE `pipelines` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text REFERENCES `projects`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`icon` text,
	`position` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pipeline_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`pipeline_id` text NOT NULL REFERENCES `pipelines`(`id`) ON DELETE cascade,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'agent' NOT NULL,
	`owner_role` text,
	`entry_action` text,
	`instructions_summary` text,
	`is_terminal` integer DEFAULT 0 NOT NULL,
	`opens_pull_request` integer DEFAULT 0 NOT NULL,
	`off_board` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_steps_pipeline` ON `pipeline_steps` (`pipeline_id`,`position`);
--> statement-breakpoint
CREATE TABLE `step_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`pipeline_id` text NOT NULL REFERENCES `pipelines`(`id`) ON DELETE cascade,
	`from_step_id` text NOT NULL REFERENCES `pipeline_steps`(`id`) ON DELETE cascade,
	`result_key` text NOT NULL,
	`label` text NOT NULL,
	`tone` text DEFAULT 'info' NOT NULL,
	`target` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_step_routes_key` ON `step_routes` (`from_step_id`,`result_key`);
--> statement-breakpoint

-- Two pipelines, both project-less at first. `project_id` is nullable for
-- the same reason `tickets.repository_id` is: EO is usable before anything
-- is configured, and the first project created adopts what is there.
--
-- `consult` gets its own pipeline rather than remaining a state flagged
-- off the board. It was never a stage of anything — nothing transitions
-- into or out of it — so a pipeline of one step says what it is far
-- better than a position of -1 did.
INSERT INTO `pipelines` (`id`, `project_id`, `name`, `icon`, `position`, `created_at`, `updated_at`)
VALUES ('default', NULL, 'Delivery', 'workflow', 0, 0, 0),
       ('consult', NULL, 'Consult', 'message-circle', 1, 0, 0);
--> statement-breakpoint

-- Carry every existing state over as a step of the default pipeline,
-- keeping its id, position and ownership exactly as they were.
INSERT INTO `pipeline_steps` (`id`, `pipeline_id`, `position`, `name`, `type`, `owner_role`, `entry_action`, `is_terminal`, `opens_pull_request`, `off_board`)
SELECT
	`id`,
	CASE WHEN `off_board` = 1 THEN 'consult' ELSE 'default' END,
	`position`,
	-- A display name, from the slug: "ready_to_merge" -> "Ready To Merge".
	-- Only the shipped states exist here, so an explicit CASE beats a
	-- string-manipulation expression nobody can read.
	CASE `id`
		WHEN 'intake' THEN 'Intake'
		WHEN 'backlog' THEN 'Backlog'
		WHEN 'pending_approval' THEN 'Pending Approval'
		WHEN 'todo' THEN 'To Do'
		WHEN 'review' THEN 'Review'
		WHEN 'ready_to_merge' THEN 'Merge Request'
		WHEN 'consult' THEN 'Consult'
		ELSE `id`
	END,
	CASE
		WHEN `opens_pull_request` = 1 THEN 'merge_request'
		WHEN `owner_role` IS NULL THEN 'gate'
		ELSE 'agent'
	END,
	`owner_role`,
	`entry_action`,
	`is_terminal`,
	`opens_pull_request`,
	`off_board`
FROM `workflow_states`;
--> statement-breakpoint

-- The routes, reproducing exactly what roles/wiring.ts decided in code.
--
-- `intake` walking to `backlog` and a non-feature classification skipping
-- to the gate (KAN-32, KAN-37/EO-5); a refined feature parking at the gate
-- and a clarified non-feature walking past it (KAN-19); review either
-- finishing the ticket or sending it back (R-03); and review's third way
-- out, which the code never had — a result that asks the human instead of
-- guessing (KAN-55).
INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT * FROM (
	SELECT 'r_intake_done'      AS a, 'default' AS b, 'intake'           AS c, 'done'              AS d, 'Understood'        AS e, 'success' AS f, 'backlog'          AS g, 0 AS h
	UNION ALL SELECT 'r_intake_story',      'default', 'intake',           'classified_non_feature', 'Already written',  'info',    'pending_approval', 1
	UNION ALL SELECT 'r_backlog_decomposed','default', 'backlog',          'decomposed',             'Decomposed',       'success', 'pending_approval', 0
	UNION ALL SELECT 'r_backlog_clarified', 'default', 'backlog',          'clarified',              'Clarified',        'info',    'todo',             1
	UNION ALL SELECT 'r_gate_approved',     'default', 'pending_approval', 'approved',               'Approved',         'success', 'todo',             0
	UNION ALL SELECT 'r_todo_done',         'default', 'todo',             'done',                   'Implemented',      'success', 'review',           0
	UNION ALL SELECT 'r_review_approved',   'default', 'review',           'approved',               'Approved',         'success', 'ready_to_merge',   0
	UNION ALL SELECT 'r_review_changes',    'default', 'review',           'changes_requested',      'Changes requested','warning', 'todo',             1
	UNION ALL SELECT 'r_review_asks',       'default', 'review',           'needs_user_input',       'Needs user input', 'info',    'user_attention',   2
) AS seed
WHERE seed.c IN (SELECT `id` FROM `pipeline_steps` WHERE `pipeline_id` = 'default')
  AND (seed.g IN (SELECT `id` FROM `pipeline_steps` WHERE `pipeline_id` = 'default') OR seed.g IN ('user_attention', 'terminal'));
--> statement-breakpoint

-- Tickets move onto (pipeline, step). `state` held a state id and step ids
-- are the same values, so the step is a straight copy; the pipeline is
-- whichever one the step ended up on.
ALTER TABLE `tickets` ADD COLUMN `pipeline_id` text REFERENCES `pipelines`(`id`);
--> statement-breakpoint
ALTER TABLE `tickets` ADD COLUMN `step_id` text REFERENCES `pipeline_steps`(`id`);
--> statement-breakpoint
UPDATE `tickets` SET
	`step_id` = `state`,
	`pipeline_id` = COALESCE((SELECT `pipeline_id` FROM `pipeline_steps` WHERE `pipeline_steps`.`id` = `tickets`.`state`), 'default');
--> statement-breakpoint

-- Drizzle cannot drop a NOT NULL column in place, and SQLite cannot add a
-- NOT NULL column with a subquery default, so the two new columns are
-- filled above and the table is rebuilt here to make them NOT NULL and to
-- drop `state`.
--
-- `runs`, `comments`, `transitions`, `ticket_deps`, `attachments`,
-- `comment_mentions` and `outbox` all reference `tickets`, so dropping it
-- mid-rebuild would trip every one of them. `runMigrations` turns foreign
-- keys off around the whole batch for exactly this — SQLite's own recipe —
-- and runs `foreign_key_check` afterwards, so an actually-orphaned row
-- still fails loudly.
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
	`pipeline_id` text NOT NULL REFERENCES `pipelines`(`id`),
	`step_id` text NOT NULL REFERENCES `pipeline_steps`(`id`),
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

-- The audit log records steps now. Same rows, same meaning, new column
-- names — nothing is deleted or rewritten (the table stays append-only in
-- spirit even though invariant #3 names `run_events` specifically).
ALTER TABLE `transitions` RENAME COLUMN `from_state` TO `from_step_id`;
--> statement-breakpoint
ALTER TABLE `transitions` RENAME COLUMN `to_state` TO `to_step_id`;
--> statement-breakpoint

DROP TABLE `workflow_states`;
