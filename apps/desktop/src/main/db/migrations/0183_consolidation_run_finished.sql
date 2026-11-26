-- EO-913: a scheduled consolidation sends only the entries written or
-- changed since the scope's last finished run, so a run's being finished
-- has to be recorded rather than inferred from no row of it having failed:
-- EO quitting between two batches leaves no failed row, and the entries
-- the later batches were to be given would never be new again. 1 on the
-- last row of a run that finished, 0 on every other row written since,
-- and null on rows from before, which are read as before.
ALTER TABLE `memory_consolidations` ADD `ends_run` integer;
