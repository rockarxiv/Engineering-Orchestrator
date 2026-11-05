-- The key prefix moves from the repository to the project (KAN-128,
-- ARCHITECTURE.md, "A workspace is a kind, attached to the project").
--
-- `repositories.key_prefix` named the ticket key namespace and was unique
-- "across repositories" so that ~/.eo/worktrees/<KEY> could never
-- collide. But keys are per project in practice: every ticket carries a
-- `project_id`, `projects.key_prefix` already numbers features, and both
-- columns index the one `key_counters` table — which is exactly why a
-- default project could carry its repository's prefix and number
-- identically. Of the four things `repositories` holds, the prefix is the
-- only one that is neither workspace config nor a connector binding, so
-- it is the one that leaves. A per-project prefix is also what lets a
-- support pack's items read "SUP-31" rather than "KAN-31".
--
-- Nothing renumbers. Keys are stored on the ticket, not derived, so every
-- key already minted stays exactly as it is — including on a project
-- spanning two repositories of different prefixes, whose old keys keep
-- both prefixes while its new ones take the project's. The counters stay
-- too: `key_counters` is keyed by prefix, so a prefix that stops minting
-- keeps its row and its value rather than being reset by anything here.
--
-- Two things happen, in this order.

-- 1. A repository with no project at all would have nowhere for its
--    prefix to go, and its next ticket would fall through to the "EO"
--    default — a repository numbering ACME-14 would start minting EO-1.
--    Every repository gets a project when it is attached, but a
--    membership can be taken off again (`projects:removeProject`), so the
--    state exists. It gets a project here carrying its own name and
--    prefix, which is the same row `createDefaultProject` would have
--    written, and the same repair 0016 made when boards were introduced.
--
--    Held in a temp table so the membership below names the project this
--    created rather than re-deriving it: joining on the prefix afterwards
--    could not tell a project made here from one that already had the
--    prefix, and re-adding a membership somebody deliberately removed is
--    not this migration's business.
--
--    Skipped where another project already holds that prefix:
--    `projects.key_prefix` is unique, and one row refused would roll back
--    the batch. That repository keeps no project, which is the state it
--    was already in.
CREATE TEMP TABLE `adopted_repositories` AS
SELECT
	lower(hex(randomblob(16))) AS `project_id`,
	`repositories`.`id` AS `repository_id`,
	`repositories`.`name` AS `name`,
	`repositories`.`key_prefix` AS `key_prefix`,
	`repositories`.`created_at` AS `created_at`,
	`repositories`.`updated_at` AS `updated_at`
FROM `repositories`
WHERE NOT EXISTS (
		SELECT 1 FROM `project_repositories`
		WHERE `project_repositories`.`repository_id` = `repositories`.`id`
	)
	AND NOT EXISTS (
		SELECT 1 FROM `projects`
		WHERE `projects`.`key_prefix` = `repositories`.`key_prefix`
	);
--> statement-breakpoint

-- `jira_project_id` is the member repository whose Jira receives the
-- project's features, and for a project of one that is that repository —
-- what `createDefaultProject` sets.
INSERT INTO `projects` (`id`, `name`, `key_prefix`, `jira_project_id`, `created_at`, `updated_at`)
SELECT `project_id`, `name`, `key_prefix`, `repository_id`, `created_at`, `updated_at`
FROM `adopted_repositories`;
--> statement-breakpoint

INSERT INTO `project_repositories` (`project_id`, `repository_id`, `position`)
SELECT `project_id`, `repository_id`, 0 FROM `adopted_repositories`;
--> statement-breakpoint

DROP TABLE `adopted_repositories`;
--> statement-breakpoint

-- 2. The column goes, and its unique index with it — SQLite refuses to
--    drop an indexed column.
--
--    The index is called `projects_key_prefix_unique` and sits on
--    `repositories`: 0009 created it when this table was called
--    `projects`, and 0016 renamed the table without renaming the index.
--    `IF EXISTS` because a name that misleading is worth not depending
--    on; if it is somehow absent the DROP COLUMN below still says so.
DROP INDEX IF EXISTS `projects_key_prefix_unique`;
--> statement-breakpoint

ALTER TABLE `repositories` DROP COLUMN `key_prefix`;
