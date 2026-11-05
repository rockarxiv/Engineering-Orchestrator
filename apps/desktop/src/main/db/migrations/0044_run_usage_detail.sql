-- What a run actually consumed, in the units the backend charges in.
--
-- `tokens_in` was being written from the Claude SDK's `usage.input_tokens`,
-- which is net of both cache counters and covers the main agent loop only —
-- the SDK's own types say to prefer `modelUsage` for accounting. So an
-- implement run that spent an hour reading this repository recorded a couple
-- of hundred input tokens, and nothing looked wrong: the number was small,
-- not missing. Rows written before this migration keep that reading and are
-- not comparable with anything after it.
--
-- The cache pair is a split of `tokens_in` rather than an addition to it, and
-- it is the measurement this was all for: an agentic loop re-sends its whole
-- conversation every turn, so the only way to tell an expensive prompt from a
-- cheap one is how much of it came back out of the cache. `turns` is the
-- multiplier that goes with it.
--
-- No money column joins them. Both backends here run on subscriptions, so
-- what a run costs is a share of a plan window, counted per backend and
-- never converted between them.

ALTER TABLE `runs` ADD COLUMN `cache_read_tokens` INTEGER;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `cache_write_tokens` INTEGER;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `turns` INTEGER;
