-- A thread for each project (EO-471, ARCHITECTURE.md, "One channel").
--
-- Comments are the only channel (invariant 4) and every comment sits on
-- an item, but nothing gave a project somewhere to say what belongs to
-- no single item. So each project gets one off-board item as its
-- thread, created the first time something needs to post there — the
-- way each job owns one (0078).
--
-- Its own step on `discussions`, for 0036's, 0064's and 0078's reason:
-- the step is what the code keys on. `owner_role` NULL and `type =
-- 'user'` keep the scheduler away from it, `entry_action` NULL because
-- nothing arrives here by transition, and `off_board` keeps it out of
-- every column, the board and the archive listing. Not terminal, so the
-- archive sweep never finds it finished. Position -6 beside
-- `scenario`'s -5; the number only has to not collide.
INSERT INTO `pipeline_steps`
	(`id`, `pipeline_id`, `position`, `name`, `type`, `owner_role`, `entry_action`, `instructions_summary`, `is_terminal`, `plan_mode`, `off_board`)
VALUES
	('project-thread', 'discussions', -6, 'Project notes', 'user', NULL, NULL, NULL, 0, 0, 1);
--
-- No `key_counters` row: a thread's key is its project's own prefix and
-- `NOTES` (`SHOP-NOTES`), not a number from a sequence. A counter is one
-- database's, and the thread is made by whichever record owns the
-- project and travels with it when the project moves — two counters
-- each starting at 1 would give two projects' threads one key in a
-- desktop's replica. See `projectThreadKey`.
--> statement-breakpoint
-- One per project, said by the database rather than hoped for by the
-- code. The accessor reads before it writes inside one transaction,
-- which is enough within a process; this is what makes it true across
-- two connections to one file as well. Partial, so it constrains
-- nothing but the threads.
CREATE UNIQUE INDEX `idx_items_project_thread` ON `items` (`project_id`) WHERE `step_id` = 'project-thread';
