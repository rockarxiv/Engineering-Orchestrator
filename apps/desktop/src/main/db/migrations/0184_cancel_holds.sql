-- The holds a cancelled run set (EO-891).
--
-- Cancelling a run used to record a hidden stop in the
-- `engine.stopped-by-hand` setting: the item looked ready, the scheduler
-- would not touch it, and it showed no Resume. A cancel now holds the
-- item where it is (`items.held_at`), and this row names the run whose
-- cancellation set the hold, so a move ends that hold (as it ended the
-- stop) while a hold a person set stays. Empty to begin with: every hold
-- so far is a person's. The stops already recorded become holds when EO
-- next starts (`adoptStoppedByHand`), since that writes a comment.
CREATE TABLE `cancel_holds` (
	`item_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
