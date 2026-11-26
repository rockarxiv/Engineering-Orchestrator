-- EO-913: a scheduled consolidation is given what was written or changed
-- since the last run that finished read its entries, at `started_at`. An
-- entry stamped in that very millisecond was either read by it or written
-- just after the read, which the stamp alone cannot tell: this lists the
-- versions (`id@updated_at`) the read found stamped then. Empty on rows
-- from before it was recorded.
ALTER TABLE `memory_consolidations` ADD `read_tied` text DEFAULT '[]' NOT NULL;
