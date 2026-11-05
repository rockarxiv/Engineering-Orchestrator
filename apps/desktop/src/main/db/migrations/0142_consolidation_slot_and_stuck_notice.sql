-- How long a memory consolidation held the global slot, and the note that
-- said consolidation of its scope is stuck (EO-577).
--
-- `slot_held_ms` is the time its side calls held a global concurrency
-- slot, in total — a batch's one call, the cross-batch pass's two, and the
-- skill proposal call made after the run, which is posted under the run's
-- last consolidation. Zero for one that made no call (duplicates folded
-- without a model, a skip); NULL for one recorded before it was counted.
--
-- `stuck_noticed_at` is set on the failure that was the third in a row
-- for its scope, when EO said so: in a note on the project thread, or in
-- the row's own note where the scope is on no project. A scope's failures
-- since its last success are read for it, so the note is said once per
-- run of failures and again only after a success.
ALTER TABLE `memory_consolidations` ADD `slot_held_ms` integer;
--> statement-breakpoint
ALTER TABLE `memory_consolidations` ADD `stuck_noticed_at` integer;
