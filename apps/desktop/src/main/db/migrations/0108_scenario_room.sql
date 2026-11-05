-- A module's scenario chat (EO-356): "+ Add scenario" on a module's page
-- opens a conversation with the system agent about that module, which
-- writes a test case from what the person describes, runs it and
-- reports.
--
-- The fourth conversation room, and built exactly as 0064 built the
-- third: its own step because the step is what the code keys on.
-- `findPendingResponses` reads the action off the step, so this step is
-- what selects `scenario` and its output schema; and a scenario thread
-- is about one module, so it cannot stand in for a help thread or a
-- Discussions chat any more than they can stand in for each other.
--
-- `owner_role` NULL and `type = 'user'` keep the scheduler away from it,
-- `entry_action` NULL because nothing arrives here by transition, and
-- `off_board` keeps it from ever rendering as a column — a scenario
-- thread is never a card on any board. Position -5 beside `job-thread`'s
-- -4; the number only has to not collide. It joins `discussions` for
-- 0036's reason: that pipeline stays hidden and unassignable because
-- every step on it is off-board, with no code change for either.
INSERT INTO `pipeline_steps`
	(`id`, `pipeline_id`, `position`, `name`, `type`, `owner_role`, `entry_action`, `instructions_summary`, `is_terminal`, `plan_mode`, `off_board`)
VALUES
	('scenario', 'discussions', -5, 'Scenario', 'user', NULL, NULL, NULL, 0, 0, 1);
--> statement-breakpoint
-- `SCN-1`, for the reason `DISC`, `ARCH`, `ASK` and `JOB` have sequences
-- of their own: a conversation is an item so that it can host runs, and
-- burning work numbers on it would put holes in the sequence people read.
INSERT INTO `key_counters` (`prefix`, `next_value`) VALUES ('SCN', 1);
