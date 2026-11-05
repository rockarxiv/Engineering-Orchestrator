-- Indexes for the reads every handler and every tick makes (EO-555).
--
-- None of these columns had one, so each of the reads below walked its
-- whole table, and on a long-lived database (hundreds of MB, hundreds of
-- thousands of rows beside them) that is what made the main process slow
-- to answer the UI:
--
--   runs(item_id)             listRunsForItem, latestRunForItem and
--                             costs:getForItem, one item's runs
--   runs(status)              listActiveRuns — queued and running, which
--                             many handlers and every tick ask for
--   transitions(item_id)      listTransitionsForItem
--   items(project_id)         a project's items
--   items(parent_id)          an item's children
--   item_deps(depends_on_id)  what waits on an item; the primary key
--                             (item_id, depends_on_id) already answers the
--                             other direction
--
-- Indexes only: no row of any table is written, and run_events is not
-- touched at all (invariant 3). `IF NOT EXISTS`, so a database somebody
-- indexed by hand migrates rather than fails.
CREATE INDEX IF NOT EXISTS `idx_runs_item` ON `runs` (`item_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_status` ON `runs` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_transitions_item` ON `transitions` (`item_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_items_project` ON `items` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_items_parent` ON `items` (`parent_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_item_deps_depends_on` ON `item_deps` (`depends_on_id`);
