-- An item's type becomes a row (KAN-129, ARCHITECTURE.md, "An item type is data").
--
-- `items.type` was a free string holding `feature`, `story` or `bug`.
-- Three words, and a support pack that wants a fourth had to edit core
-- to get it. A type is data now: labels, a container flag, a spec shape
-- and per-action overrides, on a row scoped to a project and namespaced
-- by the pack that shipped it.
--
-- Nothing about what an item *is* changes here. Every row keeps the word
-- it had; the word simply stops being stored on it and starts being
-- pointed at. The branches that compare it — fourteen container ones, six
-- spec-shape ones — are untouched and are switched over by the three
-- stories after this one.
--
-- **Two scopes.** `project_id` is NULL for the installation scope: the
-- set the developer pack seeds, and the set every project's own rows are
-- stamped from when it is created. It is not a placeholder — `items`
-- has a nullable `project_id` too, and an item written before any
-- repository was attached (`adoptProjectlessItems`) has to resolve its
-- type somewhere.
--
-- **The seed is duplicated from `DEVELOPER_ITEM_TYPES` on purpose.**
-- Applied SQL is a snapshot of what the pack shipped the day this ran,
-- the way 0028 froze the routes `roles/wiring.ts` had in code. The live
-- authority is `syncItemTypes`, which runs at every startup and adds
-- whatever a pack has gained since — the same division `syncRolePrompts`
-- and the prompt files have.

CREATE TABLE `item_types` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text REFERENCES `projects`(`id`) ON DELETE cascade,
	`pack_slug` text NOT NULL,
	`slug` text NOT NULL,
	`label` text NOT NULL,
	`plural` text NOT NULL,
	`container` integer DEFAULT 0 NOT NULL,
	`spec_shape` text DEFAULT '[]' NOT NULL,
	`action_overrides` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint

-- `ifnull(project_id, '')` rather than the bare column, because SQLite
-- counts two NULLs as distinct in a unique index. Left bare, the
-- installation scope would not be a scope at all: the startup seed's
-- "insert if absent" would find nothing each launch and write three more
-- rows every time EO opened.
CREATE UNIQUE INDEX `idx_item_types_slug` ON `item_types` (ifnull(`project_id`, ''), `pack_slug`, `slug`);
--> statement-breakpoint

-- The three developer types, once for the installation and once per
-- existing project.
--
-- Per project rather than only installation-wide because the design lets a
-- person rename a type or add one, scoped to the project they are
-- working on, without it turning up on somebody else's board.
--
-- The id is uuidv7-shaped, built the way 0024 built one: the millisecond
-- clock in the leading 48 bits, the version nibble, then randomness.
-- `randomblob` is evaluated per row, so the cross join below mints a
-- distinct id for every (scope, type) pair.
--
-- `action_overrides` carries refine's two shapes (ARCHITECTURE.md, "An item type is data"):
-- on a container it decomposes — the refine schema, the `decomposed`
-- route, a plan a person approves — and on a leaf it clarifies work that
-- arrived already written. Five branches say that today; the rows say it
-- here. Written on every type rather than only on the container,
-- including the leaf answer that a hand-made type inherits by default
-- (ARCHITECTURE.md, "An item type is data"), because a default nobody can see on the row it applies
-- to is
-- one the type editor would have to re-derive.
INSERT INTO `item_types` (`id`, `project_id`, `pack_slug`, `slug`, `label`, `plural`, `container`, `spec_shape`, `action_overrides`, `created_at`)
SELECT
	substr(printf('%012x', CAST(strftime('%s', 'now') AS INTEGER) * 1000), 1, 8) || '-' ||
		substr(printf('%012x', CAST(strftime('%s', 'now') AS INTEGER) * 1000), 9, 4) || '-7' ||
		substr(lower(hex(randomblob(2))), 2) || '-a' ||
		substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	`scope`.`project_id`,
	'developer',
	`seed`.`slug`,
	`seed`.`label`,
	`seed`.`plural`,
	`seed`.`container`,
	`seed`.`spec_shape`,
	`seed`.`action_overrides`,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM (
	SELECT NULL AS `project_id`
	UNION ALL SELECT `id` FROM `projects`
) AS `scope`
CROSS JOIN (
	SELECT 'feature' AS `slug`, 'Feature' AS `label`, 'Features' AS `plural`, 1 AS `container`, '[]' AS `spec_shape`,
		'{"refine":{"schema":"refine","resultKey":"decomposed","poster":"refine_proposal"}}' AS `action_overrides`
	UNION ALL SELECT 'story', 'Story', 'Stories', 0, '[{"name":"acceptance_criteria","required":true}]',
		'{"refine":{"schema":"clarify","resultKey":"clarified","poster":"clarification_note"}}'
	UNION ALL SELECT 'bug', 'Bug', 'Bugs', 0,
		'[{"name":"steps_to_reproduce","required":true},{"name":"expected","required":true},{"name":"actual","required":true},{"name":"environment","required":true},{"name":"acceptance_criteria","required":false}]',
		'{"refine":{"schema":"clarify","resultKey":"clarified","poster":"clarification_note"}}'
) AS `seed`;
--> statement-breakpoint

-- Anything else an item calls itself.
--
-- The column was free text and `items:update` has always been able to
-- write it, so this database may hold a word EO never shipped. Inventing
-- a row for it is the only honest migration: the alternative is a NOT
-- NULL column this row cannot fill, and an app that will not open
-- because of a type somebody typed in a dropdown two years ago.
--
-- A leaf with an empty spec shape and the leaf overrides, which is what
-- an unknown type already behaved as everywhere that read one: refine
-- clarified it rather than decomposing it, because that branch asked
-- whether the word was "feature" and this word is not.
INSERT INTO `item_types` (`id`, `project_id`, `pack_slug`, `slug`, `label`, `plural`, `container`, `spec_shape`, `action_overrides`, `created_at`)
SELECT
	substr(printf('%012x', CAST(strftime('%s', 'now') AS INTEGER) * 1000), 1, 8) || '-' ||
		substr(printf('%012x', CAST(strftime('%s', 'now') AS INTEGER) * 1000), 9, 4) || '-7' ||
		substr(lower(hex(randomblob(2))), 2) || '-a' ||
		substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	`found`.`project_id`,
	'developer',
	`found`.`type`,
	upper(substr(`found`.`type`, 1, 1)) || substr(`found`.`type`, 2),
	upper(substr(`found`.`type`, 1, 1)) || substr(`found`.`type`, 2) || 's',
	0,
	'[]',
	'{"refine":{"schema":"clarify","resultKey":"clarified","poster":"clarification_note"}}',
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM (SELECT DISTINCT `project_id`, `type` FROM `items`) AS `found`
WHERE NOT EXISTS (
	SELECT 1 FROM `item_types`
	WHERE ifnull(`item_types`.`project_id`, '') = ifnull(`found`.`project_id`, '')
	  AND `item_types`.`pack_slug` = 'developer'
	  AND `item_types`.`slug` = `found`.`type`
);
--> statement-breakpoint

-- Every item points at the row for the word it was holding, in its own
-- scope. Added nullable and filled here, because SQLite cannot add a NOT
-- NULL column whose default is a subquery.
ALTER TABLE `items` ADD COLUMN `type_id` text REFERENCES `item_types`(`id`);
--> statement-breakpoint

UPDATE `items` SET `type_id` = (
	SELECT `id` FROM `item_types`
	WHERE ifnull(`item_types`.`project_id`, '') = ifnull(`items`.`project_id`, '')
	  AND `item_types`.`pack_slug` = 'developer'
	  AND `item_types`.`slug` = `items`.`type`
);
--> statement-breakpoint

-- The rebuild, for the two things ALTER cannot do: make `type_id` NOT
-- NULL and drop `type`.
--
-- `runs`, `comments`, `transitions`, `item_deps`, `attachments`,
-- `comment_mentions`, `outbox` and `repository_indexes` all reference
-- `items`, so dropping it mid-rebuild trips every one of them.
-- `runMigrations` turns foreign keys off around the whole batch for
-- exactly this — SQLite's own recipe — and runs `foreign_key_check`
-- afterwards, so an item this migration failed to match to a type row
-- still fails loudly rather than being waved through.
CREATE TABLE `items_new` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL UNIQUE,
	`type_id` text NOT NULL REFERENCES `item_types`(`id`),
	`parent_id` text REFERENCES `items`(`id`),
	`repository_id` text REFERENCES `repositories`(`id`),
	`project_id` text REFERENCES `projects`(`id`),
	`title` text NOT NULL,
	`body` text,
	`spec` text,
	`pipeline_id` text REFERENCES `pipelines`(`id`),
	`step_id` text REFERENCES `pipeline_steps`(`id`),
	`priority` integer DEFAULT 0 NOT NULL,
	`branch` text,
	`pr_url` text,
	`jira_key` text,
	`jira_id` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`held_at` integer,
	`jira_sync` integer DEFAULT 1 NOT NULL,
	`jira_pull_pending` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `items_new`
SELECT `id`, `key`, `type_id`, `parent_id`, `repository_id`, `project_id`, `title`, `body`, `spec`,
       `pipeline_id`, `step_id`, `priority`, `branch`, `pr_url`, `jira_key`, `jira_id`,
       `archived_at`, `created_at`, `updated_at`, `held_at`, `jira_sync`, `jira_pull_pending`
FROM `items`;
--> statement-breakpoint
DROP TABLE `items`;
--> statement-breakpoint
ALTER TABLE `items_new` RENAME TO `items`;
--> statement-breakpoint

-- Dropping the table dropped its index with it. `idx_items_held` is the
-- scheduler's — 0035 added it, and the two earlier rebuilds predate it.
CREATE INDEX `idx_items_held` ON `items` (`held_at`);
