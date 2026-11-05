-- The session total each run ended on (EO-504).
--
-- A resumed Claude session reports the whole conversation's running
-- total, and a run records only its own share of it (EO-490) by taking
-- off where the session stood when the run began. That starting point
-- used to be the sum of what the thread's earlier runs recorded, which
-- is only the session's total while every one of those rows is a share.
-- A row written before EO-490 holds the whole conversation's total, so
-- the sum overshot the session, the next reading looked like a restart
-- and was recorded whole, and every run after it on the thread did the
-- same.
--
-- So each run now records the session's running total as it last read
-- it — not its share — and the next run on the thread starts from that.
-- Null where the run never read a session total: every row written
-- before this column, and every run whose backend reports turn by turn.
ALTER TABLE `runs` ADD `session_tokens_in` integer;
--> statement-breakpoint
ALTER TABLE `runs` ADD `session_tokens_out` integer;
--> statement-breakpoint
ALTER TABLE `runs` ADD `session_cache_read_tokens` integer;
--> statement-breakpoint
ALTER TABLE `runs` ADD `session_cache_write_tokens` integer;
--> statement-breakpoint
ALTER TABLE `runs` ADD `session_cost_cents` integer;
