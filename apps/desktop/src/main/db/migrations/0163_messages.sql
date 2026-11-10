-- What EO asks a person outside any item (EO-725, ARCHITECTURE.md §7.1).
--
-- A message is EO needing a person to answer or act on something that is
-- not an item's conversation: a template update it could not apply, a
-- job guard. It has a recipient, the project or job it concerns where it
-- concerns one, a body and the same buttons a comment offers. It is open
-- while `handled_at` is null; answering, dismissing or EO resolving it
-- sets `handled_at` and `handled_how` (`answered` | `dismissed` |
-- `resolved`), and `answer` holds the option an answer chose.
--
-- Not `run_events` and not a comment: a handled message is deleted 7 days
-- after it was handled, and no person keeps more than 100 handled ones
-- (`sweepHandledMessages`). An open one is never deleted by age.
--
-- No foreign key on the recipient: a person on an organisation's record
-- need not have a row in this database's `people`.
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient_id` text NOT NULL,
	`project_id` text REFERENCES `projects`(`id`) ON DELETE cascade,
	`job_id` text REFERENCES `jobs`(`id`) ON DELETE cascade,
	`source` text NOT NULL,
	`body` text NOT NULL,
	`options` text,
	`created_at` integer NOT NULL,
	`handled_at` integer,
	`handled_how` text,
	`answer` text
);
--> statement-breakpoint
CREATE INDEX `idx_messages_recipient_open` ON `messages` (`recipient_id`,`handled_at`);
