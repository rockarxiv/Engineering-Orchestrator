ALTER TABLE `projects` ADD `jira_base_url` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `jira_flavour` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `jira_project_key` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `jira_email` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `jira_feature_issue_type` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `jira_story_issue_type` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `jira_fields` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `jira_status_map` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `jira_create_by_default` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `tickets` ADD `jira_key` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `jira_id` text;