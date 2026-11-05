-- Follow-ups are gone (ARCHITECTURE.md, "A gap a run leaves is the reviewer's
-- to judge"). What a run leaves undone is judged in review, where it can send
-- the work back, and not proposed on the side as work for later.
--
-- The comments stay, as what was said: only what still asks for an answer
-- goes. Matched by EO's own wording rather than through the rows, because a
-- desktop holding a project as a replica holds the comment and never the row.
-- A follow-up's question stops asking, so it leaves no `!` on a finished item.
UPDATE `comment_mentions`
SET `status` = 'dismissed',
	`settled_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `status` = 'open'
	AND `comment_id` IN (
		SELECT `id` FROM `comments`
		WHERE `author_type` = 'engine'
			AND `kind` = 'question'
			AND (`body` LIKE '**A follow-up to file: %' OR `body` LIKE '**A follow-up to write up: %' OR `body` LIKE '**Follow-ups to write up**%')
	);
--> statement-breakpoint
-- And its buttons go with it: nothing is left to act on a press. So do the
-- ones on a Write it up chat's brief, which named a row about to be dropped.
UPDATE `comments`
SET `options` = NULL
WHERE `author_type` = 'engine'
	AND (
		(`kind` = 'question' AND (`body` LIKE '**A follow-up to file: %' OR `body` LIKE '**A follow-up to write up: %' OR `body` LIKE '**Follow-ups to write up**%'))
		OR `options` LIKE '%"followUpChat"%'
	);
--> statement-breakpoint
DROP TABLE `follow_up_filings`;
--> statement-breakpoint
DROP TABLE `follow_up_proposals`;
