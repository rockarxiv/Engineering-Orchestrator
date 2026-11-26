-- Where a run was dispatched (EO-912): a JSON array holding the bucket
-- (`capacityKeyOf`) its item was in at the step it was dispatched from,
-- `[]` for a dispatch that worked on no shared disk, written once when
-- the run row is made and never changed. NULL on every run that is not
-- the dispatch of a step's own entry action (a reply to a mention, a
-- discussion, a guard's placeholder) and on rows from another machine,
-- which the overlap hold reads from the item's own definition of the
-- step instead.
--
-- On the run rather than worked out from the step afterwards: no run
-- records the version it went under, an item can be moved to another
-- version whose step works somewhere else, and a version nothing uses
-- any more can be pruned. The run is the one thing that keeps.
ALTER TABLE `runs` ADD `dispatched_in` text;--> statement-breakpoint
-- What `dispatched_in` rests on. 'stamped': written as the run was made,
-- the one certain answer, which both holds others there and lets the
-- item carry on there. 'inferred': read once, at the first start after
-- this migration, from the item's own definition of the step — the best
-- there is for a run that predates the stamp, kept so that a later move
-- or edit cannot read it again differently, but only ever a claim that
-- holds others, never proof that lets the item past. 'legacy': a row
-- from before this migration that has not been read yet; every row that
-- could be a dispatch is marked so here, since no SQL can run a
-- workspace kind's `capacityKeyOf`. NULL: no basis given.
ALTER TABLE `runs` ADD `dispatch_basis` text;--> statement-breakpoint
UPDATE `runs` SET `dispatch_basis` = 'legacy' WHERE `step_id` IS NOT NULL AND `dry_run` = 0;
