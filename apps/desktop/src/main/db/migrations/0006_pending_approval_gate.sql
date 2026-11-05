-- R-01: a human approval gate between `backlog` and `todo`.
--
-- The refine transition is the one the engine cannot verify for itself
-- (ARCHITECTURE.md, "What it proposes, and what a person approves") — it cannot invent stories, so
-- it cannot judge
-- them either. Shipping the gate on by default is deliberate: it can be
-- removed by deleting this row once the decomposition is trusted, which
-- is a config change rather than a code change (invariant #7).
--
-- owner_role NULL means the engine hands off and stops dispatching, so
-- the scheduler's first skip condition already does the work.

-- Make room at position 2. Descending order so no two rows collide on
-- the way past each other.
UPDATE `workflow_states` SET `position` = 5 WHERE `id` = 'ready_to_merge';
--> statement-breakpoint
UPDATE `workflow_states` SET `position` = 4 WHERE `id` = 'review';
--> statement-breakpoint
UPDATE `workflow_states` SET `position` = 3 WHERE `id` = 'todo';
--> statement-breakpoint
INSERT INTO `workflow_states` (`id`, `position`, `owner_role`, `entry_action`, `is_terminal`) VALUES
	('pending_approval', 2, NULL, NULL, 0);
