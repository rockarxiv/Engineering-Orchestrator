-- Where a line stands in the order it reached this database (EO-618,
-- ARCHITECTURE.md, "`run_events` is the durability substrate").
--
-- The record's transcript feed paged on `ts`, which is the writing device's
-- clock and says when a line was written. A line that reached the record
-- after a replica's cursor had passed that moment was never sent to it.
--
-- Null on every row that exists: nothing here writes one, and the feed reads
-- those by `ts` as it always has, so the cursors devices hold stay good.
-- Set once, on the insert of a line that came from another machine.
ALTER TABLE `run_events` ADD `arrival` integer;--> statement-breakpoint
CREATE INDEX `idx_run_events_feed` ON `run_events` (coalesce(`arrival`, `ts`), `run_id`, `seq`);
