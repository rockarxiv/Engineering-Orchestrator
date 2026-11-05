-- Step kinds decide who acts, and a pipeline says where work enters.
--
-- `type` was `source | agent | merge_request | gate` — four names for what
-- a step was *for*, while dispatch branched on `owner_role` and pull
-- requests hung off an `opens_pull_request` boolean. Nothing read `type`,
-- so choosing one changed an icon. The three that replace it each pick a
-- different executor:
--
--   agent    a role is dispatched to a coding agent
--   user     a person acts; the engine hands off and waits
--   builtin  EO runs one of its own functions, named by `entry_action`
--
-- That is what makes Worktree and Merge Request real steps rather than
-- side effects: each gets a run, so it has an elapsed time, a transcript
-- and somewhere to route when it fails. `opens_pull_request` goes with
-- them — opening the PR is what the `open_pull_request` builtin *is*,
-- rather than a flag on arriving somewhere.

-- `source` scaffolded the worktree; `merge_request` opened the PR. Both
-- become builtins named for the function they always were.
UPDATE `pipeline_steps` SET `type` = 'builtin', `entry_action` = 'create_worktree' WHERE `type` = 'source';
--> statement-breakpoint
UPDATE `pipeline_steps` SET `type` = 'builtin', `entry_action` = 'open_pull_request' WHERE `type` = 'merge_request' OR `opens_pull_request` = 1;
--> statement-breakpoint
-- A gate is a person. So is anything else nobody's role owns: `owner_role
-- IS NULL` was the only thing the scheduler ever read to decide that.
UPDATE `pipeline_steps` SET `type` = 'user' WHERE `type` = 'gate' OR (`type` = 'agent' AND `owner_role` IS NULL);
--> statement-breakpoint
-- A person does not act on command, so there is nothing to ask them for.
UPDATE `pipeline_steps` SET `entry_action` = NULL WHERE `type` = 'user';
--> statement-breakpoint
-- A role belongs to the kind that dispatches one.
UPDATE `pipeline_steps` SET `owner_role` = NULL WHERE `type` <> 'agent';
--> statement-breakpoint

ALTER TABLE `pipeline_steps` DROP COLUMN `opens_pull_request`;
--> statement-breakpoint

-- The shipped pipeline gains the two steps it was performing invisibly.
--
-- Worktree first, because it is where work enters: a ticket whose branch
-- is being cut had no card of its own before, so it looked exactly like a
-- ticket nothing was happening to.
INSERT INTO `pipeline_steps` (`id`, `pipeline_id`, `position`, `name`, `type`, `owner_role`, `entry_action`, `instructions_summary`, `is_terminal`, `off_board`)
SELECT 'worktree', 'default', 0, 'Worktree', 'builtin', NULL, 'create_worktree', 'Prepares the branch and worktree for the work', 0, 0
WHERE EXISTS (SELECT 1 FROM `pipelines` WHERE `id` = 'default');
--> statement-breakpoint
INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT 'r_worktree_ready', 'default', 'worktree', 'ready', 'Ready', 'success', 'todo', 0
WHERE EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'worktree')
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'todo');
--> statement-breakpoint

-- `ready_to_merge` was terminal *and* opened the pull request, and the two
-- kinds cannot both be true: nothing acts on a terminal step (one that
-- both finished work and ran something would re-run it every tick), while
-- opening a PR is an action. So the action moves to a step of its own,
-- inserted in front, and `ready_to_merge` keeps being what its name always
-- described — the end of the line.
UPDATE `pipeline_steps` SET `type` = 'user', `entry_action` = NULL, `name` = 'Done' WHERE `id` = 'ready_to_merge';
--> statement-breakpoint
INSERT INTO `pipeline_steps` (`id`, `pipeline_id`, `position`, `name`, `type`, `owner_role`, `entry_action`, `instructions_summary`, `is_terminal`, `off_board`)
SELECT 'merge_request', 'default', 6, 'Merge Request', 'builtin', NULL, 'open_pull_request', 'Opens the pull request for review', 0, 0
WHERE EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'ready_to_merge');
--> statement-breakpoint
-- Everything that used to arrive at the terminal step now goes through the
-- one that opens the PR, which is where arriving used to trigger it.
UPDATE `step_routes` SET `target` = 'merge_request'
WHERE `pipeline_id` = 'default' AND `target` = 'ready_to_merge'
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'merge_request');
--> statement-breakpoint
INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT 'r_merge_opened', 'default', 'merge_request', 'opened', 'Pull request open', 'success', 'ready_to_merge', 0
WHERE EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'merge_request');
--> statement-breakpoint
-- Work still has to finish where no forge is configured, where the ticket
-- has no branch, or where it is a feature. The builtin says `skipped`
-- rather than failing, and saying so out loud is the improvement: before,
-- such a ticket simply never got a PR and nothing anywhere explained why.
INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT 'r_merge_skipped', 'default', 'merge_request', 'skipped', 'No pull request', 'info', 'ready_to_merge', 1
WHERE EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'merge_request');
--> statement-breakpoint
-- Two steps were added, so the shipped pipeline is renumbered end to end.
-- Spelled out rather than computed: a correlated count over the table it
-- is updating reads rows it has already rewritten, which is how the first
-- attempt at this produced two steps sharing a position — and duplicate
-- positions are what the validator rejects, because they make the column
-- order arbitrary.
UPDATE `pipeline_steps` SET `position` = CASE `id`
	WHEN 'worktree'         THEN 0
	WHEN 'intake'           THEN 1
	WHEN 'backlog'          THEN 2
	WHEN 'pending_approval' THEN 3
	WHEN 'todo'             THEN 4
	WHEN 'review'           THEN 5
	WHEN 'merge_request'    THEN 6
	WHEN 'ready_to_merge'   THEN 7
	ELSE `position`
END
WHERE `pipeline_id` = 'default';
--> statement-breakpoint

-- Where work enters. Explicit, because position orders the display and
-- nothing else (ARCHITECTURE.md, "A step") — deriving the entry point from it would make
-- reordering the columns silently re-route every new ticket.
--
-- Seeded to the lowest-position step that is on the dashboard at all: an
-- off-board step holds conversations, which is not where work starts.
ALTER TABLE `pipelines` ADD COLUMN `entry_step_id` text REFERENCES `pipeline_steps`(`id`);
--> statement-breakpoint
UPDATE `pipelines` SET `entry_step_id` = (
	SELECT `id` FROM `pipeline_steps`
	WHERE `pipeline_steps`.`pipeline_id` = `pipelines`.`id` AND `off_board` = 0
	ORDER BY `position` ASC LIMIT 1
);
--> statement-breakpoint

-- A builtin run has no agent. It is still a run — it takes time, it can
-- fail, and it writes run_events — so it keeps a row rather than becoming
-- an invisible side effect again.
--
-- `run_events`, `comments` and `run_initiations` reference `runs`;
-- `runMigrations` turns foreign keys off around the batch (SQLite's own
-- recipe for a table rebuild) and runs `foreign_key_check` afterwards, so
-- a genuinely orphaned row still fails loudly.
CREATE TABLE `runs_new` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL REFERENCES `tickets`(`id`),
	`agent_id` text REFERENCES `agents`(`id`),
	`action` text NOT NULL,
	`status` text NOT NULL,
	`thread_id` text,
	`provider` text,
	`worktree_path` text,
	`pid` integer,
	`initiation_id` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`result` text,
	`verification` text,
	`error` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cost_cents` integer,
	`started_at` integer,
	`ended_at` integer
);
--> statement-breakpoint
INSERT INTO `runs_new`
SELECT `id`, `ticket_id`, `agent_id`, `action`, `status`, `thread_id`, `provider`, `worktree_path`,
       `pid`, `initiation_id`, `attempt`, `result`, `verification`, `error`, `tokens_in`,
       `tokens_out`, `cost_cents`, `started_at`, `ended_at`
FROM `runs`;
--> statement-breakpoint
DROP TABLE `runs`;
--> statement-breakpoint
ALTER TABLE `runs_new` RENAME TO `runs`;
