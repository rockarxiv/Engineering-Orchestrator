ALTER TABLE `attachments` ADD `jira_attachment_id` text;
--> statement-breakpoint
ALTER TABLE `attachments` ADD `jira_sync_error` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_attachments_ticket_jira` ON `attachments` (`ticket_id`,`jira_attachment_id`);
