-- Which runs said they relied on which memory entries (EO-597,
-- ARCHITECTURE.md §7.5). An answer's `memoryUsed`, held to what the run
-- was given, is recorded as a `memory_used` run event, and the Memory
-- section and `memories_search` count each entry's uses across every
-- run. Partial, like `idx_run_events_memory_delivered` (0127): one entry
-- per answer that listed any, and nothing for the rest of the table. The
-- query says `type = 'memory_used'` as a literal so SQLite uses it — see
-- `memoryUsageByEntry`. An index only: no row of `run_events` is
-- written, changed or removed (invariant 3).
CREATE INDEX `idx_run_events_memory_used` ON `run_events` (`ts`) WHERE `type` = 'memory_used';
