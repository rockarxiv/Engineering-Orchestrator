CREATE TABLE `attachments` (
  `id` text PRIMARY KEY NOT NULL,
  `ticket_id` text NOT NULL REFERENCES `tickets`(`id`),
  `comment_id` text NOT NULL REFERENCES `comments`(`id`),
  `storage_path` text NOT NULL,
  `name` text NOT NULL,
  `mime_type` text NOT NULL,
  `size` integer NOT NULL,
  `managed` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_attachments_ticket` ON `attachments` (`ticket_id`);
--> statement-breakpoint
CREATE INDEX `idx_attachments_comment` ON `attachments` (`comment_id`);
--> statement-breakpoint
-- EO 0.0.0 briefly persisted Consult files as JSON on comments. Promote
-- those rows without rewriting or deleting the only known file path.
INSERT INTO `attachments` (`id`, `ticket_id`, `comment_id`, `storage_path`, `name`, `mime_type`, `size`, `managed`, `created_at`)
SELECT
  substr(printf('%012x', comments.created_at), 1, 8) || '-' ||
    substr(printf('%012x', comments.created_at), 9, 4) || '-7' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  comments.ticket_id,
  comments.id,
  json_extract(legacy.value, '$.path'),
  coalesce(json_extract(legacy.value, '$.name'), 'attachment'),
  coalesce(json_extract(legacy.value, '$.mimeType'), 'application/octet-stream'),
  coalesce(json_extract(legacy.value, '$.size'), 0),
  0,
  comments.created_at
FROM comments, json_each(CASE WHEN json_valid(comments.attachments) THEN comments.attachments ELSE '[]' END) AS legacy
WHERE json_type(CASE WHEN legacy.type = 'object' THEN legacy.value ELSE '{}' END, '$.path') = 'text';
