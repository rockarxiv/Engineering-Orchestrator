-- `repositories` was four things, and this is the story that stops
-- pretending it was one (KAN-130, ARCHITECTURE.md, "A workspace is a kind, attached to the
-- project").
--
-- The four: the **item key prefix**, which went to the project in
-- KAN-128 and is already gone from here; the **test, lint and build
-- commands** and the five **forge** columns, which describe the disk
-- work happens on; the eight **jira** columns, which describe a project
-- mirrored into a tracker and were copied per repository with nothing
-- keeping the copies in step; and the row's own identity, which is what
-- every item, every outbox entry and every index note points at.
--
-- So: `workspaces(id, project_id, kind, config, position)` — which is
-- `project_repositories` with the member folded in and its one
-- hard-coded kind spelled out — and `connector_bindings(id, project_id,
-- connector, config)` for the tracker.
--
-- **The ids do not change.** A workspace takes the id of the repository
-- it replaces, so every `items.repository_id`, `outbox.repository_id`
-- and `repository_indexes.repository_id` already holds the right value
-- and the columns are renamed rather than remapped. That is worth more
-- than a tidy new id: a run in flight, a worktree on disk named after a
-- key, and every historical row keep meaning what they meant.
--
-- The one exception is a repository *two* projects spanned, which cannot
-- stay one row: see the split below. Only the second project's items
-- move, and they move onto a row describing the same checkout.
--
-- **Four tables are rebuilt rather than altered**, because each has a
-- `REFERENCES repositories` clause and SQLite's `ALTER TABLE RENAME`
-- only rewrites those when foreign keys are *enabled* — which they
-- cannot be here, since `runMigrations` turns them off for exactly this
-- kind of work and `PRAGMA` is a no-op inside a transaction. A renamed
-- column pointing at a dropped table is a `foreign_key_check` failure on
-- the next launch, so the twelve-step rebuild it is (0028's recipe).
-- `projects` is rebuilt for the same reason in reverse: `DROP COLUMN`
-- refuses a column named in a foreign key.
--
-- The drops come last, after every rename, so that no `ALTER TABLE`
-- reparses a schema with a missing table in it.

CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	-- Nullable, and SET NULL rather than CASCADE: deleting a project must
	-- not take the disk its items were worked on with it. A repository
	-- outlived its project before this story too — the membership row
	-- cascaded, the repository did not — and an item resolves its run's
	-- cwd through this row, so detaching is the honest answer where
	-- deleting would strand every item that named it.
	`project_id` text REFERENCES `projects`(`id`) ON DELETE SET NULL,
	-- `git-worktree` today, and nothing else until the kind interface
	-- lands. Not a CHECK constraint: which kinds exist is a property of
	-- which packs are installed, and SQLite can only express the value
	-- set — the half that never goes wrong.
	`kind` text NOT NULL,
	-- The kind's own configuration. JSON rather than columns precisely so
	-- that a second kind costs a registry entry rather than a migration,
	-- and so that a `folder` workspace never carries a base branch column
	-- it has no answer for.
	`config` text NOT NULL,
	-- Orders the picker. This is the membership row's position, carried
	-- across unchanged.
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint

CREATE TABLE `connector_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
	-- `jira` today. Keyed by connector rather than by the pack that ships
	-- one, so a support pack mirroring to a helpdesk adds a row here
	-- rather than eight columns to a table every project shares.
	`connector` text NOT NULL,
	-- The site, the project key, the two issue types, the extra fields,
	-- the status map, the transition fields and the create-by-default
	-- flag. The token is not here and never will be: the design puts
	-- secrets in the OS keychain, keyed by `jira_connections.id`.
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint

-- One binding per (project, connector) is the whole point of the shape:
-- two `jira` rows on one project would be the per-repository copies
-- back again, disagreeing about which issue type a feature is.
CREATE UNIQUE INDEX `idx_connector_bindings_project` ON `connector_bindings` (`project_id`, `connector`);
--> statement-breakpoint

-- One `git-worktree` workspace per repository, keeping its id.
--
-- The project is the one whose membership came first — lowest position,
-- then project id, which is the order `projectRepositoryList` already
-- resolved ties in. A workspace belongs to *a* project (ARCHITECTURE.md, "A workspace is a kind,
-- attached to the project"), so a
-- repository two projects spanned keeps its id on the first of them and
-- the statement below gives every other project its own row on the same
-- checkout. That way every item keeps a workspace its own project
-- actually holds, which is what the two Jira paths disagree about
-- otherwise.
--
-- `json(...)` around the two flags, because `json_object('forgeOpenPr',
-- 0)` stores the integer and the config schema reads a boolean — the
-- call 0071 made for the same reason.
INSERT INTO `workspaces` (`id`, `project_id`, `kind`, `config`, `position`, `created_at`, `updated_at`)
SELECT
	`r`.`id`,
	(
		SELECT `pr`.`project_id` FROM `project_repositories` `pr`
		WHERE `pr`.`repository_id` = `r`.`id`
		ORDER BY `pr`.`position`, `pr`.`project_id` LIMIT 1
	),
	'git-worktree',
	json_object(
		'name', `r`.`name`,
		'description', `r`.`description`,
		'repoPath', `r`.`repo_path`,
		'baseBranch', `r`.`base_branch`,
		'testCommand', `r`.`test_command`,
		'lintCommand', `r`.`lint_command`,
		'buildCommand', `r`.`build_command`,
		'forgeOpenPr', json(CASE WHEN `r`.`forge_open_pr` THEN 'true' ELSE 'false' END),
		'forgeKind', `r`.`forge_kind`,
		'forgeRemote', `r`.`forge_remote`,
		'forgeDraft', json(CASE WHEN `r`.`forge_draft` THEN 'true' ELSE 'false' END),
		'forgeTemplatePath', `r`.`forge_template_path`
	),
	COALESCE((
		SELECT `pr`.`position` FROM `project_repositories` `pr`
		WHERE `pr`.`repository_id` = `r`.`id`
		ORDER BY `pr`.`position`, `pr`.`project_id` LIMIT 1
	), 0),
	`r`.`created_at`,
	`r`.`updated_at`
FROM `repositories` `r`;
--> statement-breakpoint

-- A repository two projects spanned becomes one workspace *each*.
--
-- `project_repositories` was a join table, so a checkout shared by two
-- projects was expressible, and both projects have their own items on
-- it under their own key prefixes. A workspace belongs to one project
-- (ARCHITECTURE.md, "A workspace is a kind, attached to the project"), so the row above can only be
-- the first project's — and
-- leaving it there would strand the other project's items on a
-- workspace their project does not hold.
--
-- That is not cosmetic. Jira *pull* resolves a binding from
-- `items.project_id`; the outbox *sender* resolves one from the
-- workspace's project. An item whose two answers differ pulls its
-- comments from one Jira account and pushes its status to another, and
-- nothing anywhere reports it.
--
-- The repairs that do not work: moving the items to the first project
-- changes their keys, which are the project's prefix and its counter;
-- refusing the migration strands the person on an old version. So the
-- checkout is described twice instead. Both rows carry the same
-- `repoPath`, which is what a `git-worktree` workspace is — the
-- worktrees it cuts are per item, and two projects cutting from one
-- checkout is what was already happening.
--
-- Kept in a scratch table rather than matched back by `repoPath` later,
-- because two repositories may legitimately point at the same path and
-- the id has to be the one this row actually got.
CREATE TABLE `_workspace_split` (
	`repository_id` text NOT NULL,
	`project_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`position` integer NOT NULL
);
--> statement-breakpoint

INSERT INTO `_workspace_split` (`repository_id`, `project_id`, `workspace_id`, `position`)
SELECT
	`pr`.`repository_id`,
	`pr`.`project_id`,
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' ||
		substr(lower(hex(randomblob(2))), 2) || '-a' ||
		substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	`pr`.`position`
FROM `project_repositories` `pr`
-- Every membership except the one that kept the repository's own id,
-- resolved by the same tie-break the insert above used.
WHERE `pr`.`project_id` <> (
	SELECT `first`.`project_id` FROM `project_repositories` `first`
	WHERE `first`.`repository_id` = `pr`.`repository_id`
	ORDER BY `first`.`position`, `first`.`project_id` LIMIT 1
);
--> statement-breakpoint

INSERT INTO `workspaces` (`id`, `project_id`, `kind`, `config`, `position`, `created_at`, `updated_at`)
SELECT
	`s`.`workspace_id`,
	`s`.`project_id`,
	'git-worktree',
	json_object(
		'name', `r`.`name`,
		'description', `r`.`description`,
		'repoPath', `r`.`repo_path`,
		'baseBranch', `r`.`base_branch`,
		'testCommand', `r`.`test_command`,
		'lintCommand', `r`.`lint_command`,
		'buildCommand', `r`.`build_command`,
		'forgeOpenPr', json(CASE WHEN `r`.`forge_open_pr` THEN 'true' ELSE 'false' END),
		'forgeKind', `r`.`forge_kind`,
		'forgeRemote', `r`.`forge_remote`,
		'forgeDraft', json(CASE WHEN `r`.`forge_draft` THEN 'true' ELSE 'false' END),
		'forgeTemplatePath', `r`.`forge_template_path`
	),
	`s`.`position`,
	`r`.`created_at`,
	`r`.`updated_at`
FROM `_workspace_split` `s`
JOIN `repositories` `r` ON `r`.`id` = `s`.`repository_id`;
--> statement-breakpoint

-- One `jira` binding per project that had a connected member.
--
-- Which member: the one the project nominated as its features' Jira
-- home (`projects.jira_project_key`'s pointer, dropped below), and
-- failing that the first connected one by membership order. A project
-- whose repositories each named a *different* Jira project keeps the
-- nominated one — there is one binding now, and picking the home the
-- person already chose beats picking by accident of insertion order.
--
-- Only where a member is genuinely connected: a site *and* a project key
-- (KAN-22), which is what `isJiraConnected` has always meant. A project
-- that mirrors nowhere gets no row at all rather than one asserting
-- silence, so "never connected" has a single spelling.
--
-- The timestamps are the repository's own. It is the closest true thing
-- — the columns moved with the row — and a migration timestamp would
-- date every project's Jira binding to the launch that upgraded it.
INSERT INTO `connector_bindings` (`id`, `project_id`, `connector`, `config`, `created_at`, `updated_at`)
SELECT
	-- A UUIDv7-shaped id, minted per row. `randomblob` is evaluated per
	-- row, which is what makes this a distinct id rather than one
	-- repeated — the shape 0069 and 0024 use.
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' ||
		substr(lower(hex(randomblob(2))), 2) || '-a' ||
		substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	`p`.`id`,
	'jira',
	json_object(
		'connectionId', `r`.`jira_connection_id`,
		'projectKey', `r`.`jira_project_key`,
		'featureIssueType', `r`.`jira_feature_issue_type`,
		'storyIssueType', `r`.`jira_story_issue_type`,
		'fields', json(`r`.`jira_fields`),
		'statusMap', json(`r`.`jira_status_map`),
		'transitionFields', json(`r`.`jira_transition_fields`),
		'createByDefault', json(CASE WHEN `r`.`jira_create_by_default` THEN 'true' ELSE 'false' END)
	),
	`r`.`created_at`,
	`r`.`updated_at`
FROM `projects` `p`
JOIN `repositories` `r` ON `r`.`id` = (
	SELECT `pr`.`repository_id` FROM `project_repositories` `pr`
	JOIN `repositories` `rr` ON `rr`.`id` = `pr`.`repository_id`
	WHERE `pr`.`project_id` = `p`.`id`
		AND `rr`.`jira_connection_id` IS NOT NULL
		AND `rr`.`jira_project_key` IS NOT NULL
	ORDER BY CASE WHEN `pr`.`repository_id` = `p`.`jira_project_id` THEN 0 ELSE 1 END,
		`pr`.`position`, `pr`.`repository_id`
	LIMIT 1
);
--> statement-breakpoint

-- Which connection each repository's Jira token actually belonged to.
--
-- KAN-22 moved tokens from the repositories that held them to the
-- connections that now do, but tokens are files under `userData` rather
-- than rows, so no migration can move them: `rekeyJiraTokens` does it at
-- startup, and the file is still named after the repository.
--
-- Until this story the startup could *infer* which connection a given
-- repository's token belonged to, because every repository carried its
-- own `jira_connection_id` and it was still there to read. It cannot
-- now. A project keeps one binding, and the `jira_connection_id` of
-- every repository that was not the selected one is dropped with the
-- table below.
--
-- Inferring it from what survives is not harmless. Offering every
-- workspace in the project against the surviving binding's connection
-- writes the *first* repository's token onto that connection and then
-- deletes the right one — `rekeyJiraTokens` keeps what is already there
-- — so a project whose repositories used two different Jira accounts
-- comes out of the upgrade authenticating every request as the wrong
-- one. So the true pairing is written down here, while `repositories`
-- still exists to be asked, and the startup reads it rather than
-- guessing.
--
-- Only the connected ones: a repository that named no connection never
-- had a token keyed to one. `HAVING count(*) > 0` because
-- `json_group_array` over no rows still returns a row — `[]` — and a
-- setting that says nothing is worse than the absence the reader
-- already treats as "there was never anything to move".
INSERT INTO `app_settings` (`key`, `value`, `updated_at`)
SELECT
	'jira.legacyTokenOwners',
	json_group_array(json_object('repositoryId', `id`, 'connectionId', `jira_connection_id`)),
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `repositories`
WHERE `jira_connection_id` IS NOT NULL
HAVING count(*) > 0;
--> statement-breakpoint

-- `items.repository_id` becomes `items.workspace_id`, same values.
CREATE TABLE `items_new` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL UNIQUE,
	`type_id` text NOT NULL REFERENCES `item_types`(`id`),
	`parent_id` text REFERENCES `items`(`id`),
	`workspace_id` text REFERENCES `workspaces`(`id`),
	`project_id` text REFERENCES `projects`(`id`),
	`title` text NOT NULL,
	`body` text,
	`spec` text,
	`pipeline_id` text REFERENCES `pipelines`(`id`),
	`step_id` text REFERENCES `pipeline_steps`(`id`),
	`priority` integer DEFAULT 0 NOT NULL,
	`branch` text,
	`pr_url` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`held_at` integer
);
--> statement-breakpoint

INSERT INTO `items_new` (`id`, `key`, `type_id`, `parent_id`, `workspace_id`, `project_id`, `title`, `body`, `spec`, `pipeline_id`, `step_id`, `priority`, `branch`, `pr_url`, `archived_at`, `created_at`, `updated_at`, `held_at`)
SELECT `id`, `key`, `type_id`, `parent_id`, `repository_id`, `project_id`, `title`, `body`, `spec`, `pipeline_id`, `step_id`, `priority`, `branch`, `pr_url`, `archived_at`, `created_at`, `updated_at`, `held_at`
FROM `items`;
--> statement-breakpoint

DROP TABLE `items`;
--> statement-breakpoint
ALTER TABLE `items_new` RENAME TO `items`;
--> statement-breakpoint
CREATE INDEX `idx_items_held` ON `items` (`held_at`);
--> statement-breakpoint

-- The outbox is denormalised on purpose — a drain finds the connection
-- without reading the item — so it carries the same rename.
CREATE TABLE `outbox_new` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL REFERENCES `items`(`id`),
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`),
	`channel` text DEFAULT 'jira' NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint

INSERT INTO `outbox_new` (`id`, `item_id`, `workspace_id`, `channel`, `kind`, `payload`, `attempts`, `next_attempt_at`, `last_error`, `created_at`)
SELECT `id`, `item_id`, `repository_id`, `channel`, `kind`, `payload`, `attempts`, `next_attempt_at`, `last_error`, `created_at`
FROM `outbox`;
--> statement-breakpoint

DROP TABLE `outbox`;
--> statement-breakpoint
ALTER TABLE `outbox_new` RENAME TO `outbox`;
--> statement-breakpoint
CREATE INDEX `idx_outbox_due` ON `outbox` (`channel`, `next_attempt_at`, `id`);
--> statement-breakpoint
CREATE INDEX `idx_outbox_item` ON `outbox` (`channel`, `item_id`, `id`);
--> statement-breakpoint

-- The items on a shared checkout that belong to the *other* project,
-- moved onto that project's own workspace.
--
-- Both columns still hold the old repository id at this point — the
-- rebuilds above renamed them without remapping — so the pair
-- (workspace_id, project_id) is exactly the membership that was split.
-- Every other item matches nothing here and is left alone, which is the
-- whole population on any database where no repository was shared.
UPDATE `items`
SET `workspace_id` = (
	SELECT `s`.`workspace_id` FROM `_workspace_split` `s`
	WHERE `s`.`repository_id` = `items`.`workspace_id` AND `s`.`project_id` = `items`.`project_id`
)
WHERE EXISTS (
	SELECT 1 FROM `_workspace_split` `s`
	WHERE `s`.`repository_id` = `items`.`workspace_id` AND `s`.`project_id` = `items`.`project_id`
);
--> statement-breakpoint

-- And the queued pushes with them. The outbox carries its own copy of
-- the id so a drain need not read the item, which means a comment
-- queued before the upgrade would otherwise resolve the binding the
-- item no longer uses — the exact split this is here to close.
UPDATE `outbox`
SET `workspace_id` = (
	SELECT `i`.`workspace_id` FROM `items` `i` WHERE `i`.`id` = `outbox`.`item_id`
)
WHERE EXISTS (
	SELECT 1 FROM `items` `i` WHERE `i`.`id` = `outbox`.`item_id` AND `i`.`workspace_id` <> `outbox`.`workspace_id`
);
--> statement-breakpoint

-- An index note is still about a git checkout — the table keeps its name,
-- because that is what it describes. What it is keyed on is the
-- workspace that holds the checkout.
CREATE TABLE `repository_indexes_new` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`item_id` text REFERENCES `items`(`id`) ON DELETE CASCADE,
	`provider` text NOT NULL,
	`index_path` text NOT NULL,
	`status` text NOT NULL,
	`indexed_commit_sha` text,
	`indexed_at` integer,
	`updated_at` integer,
	`provider_version` text,
	`error_message` text,
	`last_sync_duration_ms` integer,
	`last_sync_changed_files` integer,
	`last_index_duration_ms` integer,
	`index_size_bytes` integer
);
--> statement-breakpoint

INSERT INTO `repository_indexes_new` (`id`, `workspace_id`, `item_id`, `provider`, `index_path`, `status`, `indexed_commit_sha`, `indexed_at`, `updated_at`, `provider_version`, `error_message`, `last_sync_duration_ms`, `last_sync_changed_files`, `last_index_duration_ms`, `index_size_bytes`)
SELECT `id`, `repository_id`, `item_id`, `provider`, `index_path`, `status`, `indexed_commit_sha`, `indexed_at`, `updated_at`, `provider_version`, `error_message`, `last_sync_duration_ms`, `last_sync_changed_files`, `last_index_duration_ms`, `index_size_bytes`
FROM `repository_indexes`;
--> statement-breakpoint

DROP TABLE `repository_indexes`;
--> statement-breakpoint
ALTER TABLE `repository_indexes_new` RENAME TO `repository_indexes`;
--> statement-breakpoint

-- `projects.jira_project_id` goes with the columns it pointed at.
--
-- It named which member repository's Jira received the project's
-- features, which was only a question while every repository carried its
-- own Jira configuration. The project has one binding now and everything
-- on it mirrors through that — so the column is not moved, it stops
-- being a question. `project_update` loses the argument rather than
-- keeping one that would do nothing (invariant 12).
CREATE TABLE `projects_new` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_prefix` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint

INSERT INTO `projects_new` (`id`, `name`, `key_prefix`, `created_at`, `updated_at`)
SELECT `id`, `name`, `key_prefix`, `created_at`, `updated_at` FROM `projects`;
--> statement-breakpoint

DROP TABLE `projects`;
--> statement-breakpoint
ALTER TABLE `projects_new` RENAME TO `projects`;
--> statement-breakpoint

DROP TABLE `_workspace_split`;
--> statement-breakpoint
DROP TABLE `project_repositories`;
--> statement-breakpoint
DROP TABLE `repositories`;
