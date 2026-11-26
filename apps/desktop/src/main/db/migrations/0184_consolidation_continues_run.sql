-- EO-913: a consolidation run that stopped part-way is retried with the
-- trigger it ran under, and only such a run skips the day-and-five-runs
-- wait. A retry reads its entries at its own moment, so its rows start at
-- a later `started_at` than the run it goes on with; this names that
-- run's `started_at`, so a retry whose first batch fails again is still
-- part of the run that applied something. Null on a run's own rows.
ALTER TABLE `memory_consolidations` ADD `continues_run` integer;
