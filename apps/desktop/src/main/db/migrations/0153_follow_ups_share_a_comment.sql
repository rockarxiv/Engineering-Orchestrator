-- A run's follow-ups share one comment (EO-608, ARCHITECTURE.md §7.5):
-- one Write it up, one Discard and one chat for all of them. So a comment
-- now names many rows, and `comment_id` stops being unique. A comment
-- posted before this holds one row, and is unchanged.
DROP INDEX `idx_follow_up_proposals_comment`;
--> statement-breakpoint
CREATE INDEX `idx_follow_up_proposals_comment` ON `follow_up_proposals` (`comment_id`);
