-- A side call's cost to the micro-cent (EO-510).
--
-- A side call costs a fraction of a cent — a memory selection on Haiku
-- about half of one — and `cost_cents` rounded each call to a whole
-- cent, so almost every one was recorded as nothing and side-call spend
-- never reached a budget or a spend screen. The column now holds
-- millionths of a cent, and the readers round only what they have
-- summed: two hundred calls at half a cent are a dollar.
--
-- Renamed rather than added beside, so there is one figure and not two
-- that could disagree. What is already there was whole cents, and is
-- carried over as what it was.
ALTER TABLE `side_calls` RENAME COLUMN `cost_cents` TO `cost_microcents`;
--> statement-breakpoint
UPDATE `side_calls` SET `cost_microcents` = `cost_microcents` * 1000000;
