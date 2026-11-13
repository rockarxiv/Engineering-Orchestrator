-- A dependency edge carries a wait rule (EO-776, EO-775).
--
-- `wait` is what releases the item waiting on the edge: `finished` -- the
-- dependency stands on a terminal step, which is what every edge has meant
-- until now and stays the default -- `reached`, the first time the
-- dependency arrives at `wait_step_id` on its own pipeline, or `none`,
-- never held at all. Whether a `reached` edge's dependency has arrived is
-- read from `transitions` and never stored here.
--
-- Every existing row becomes `finished` with no step, so nothing that is
-- waiting today stops waiting.
ALTER TABLE `item_deps` ADD `wait` text DEFAULT 'finished' NOT NULL;
--> statement-breakpoint
ALTER TABLE `item_deps` ADD `wait_step_id` text;
