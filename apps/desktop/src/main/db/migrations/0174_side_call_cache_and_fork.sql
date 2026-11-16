-- What a side call read from and wrote to the prompt cache, and how a
-- fork-based one copied its thread (EO-811).
--
-- Runs have recorded cache figures all along; side calls dropped them,
-- so whether a learning review's or a suggested reply's fork read the
-- cache could only be worked backwards from its cost. All four are
-- nullable and no row is rewritten: an older call said nothing about
-- either, which is not the same as a cold cache.
ALTER TABLE `side_calls` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `side_calls` ADD `cache_write_tokens` integer;--> statement-breakpoint
ALTER TABLE `side_calls` ADD `fork_mode` text;--> statement-breakpoint
ALTER TABLE `side_calls` ADD `fork_fallback_reason` text;
