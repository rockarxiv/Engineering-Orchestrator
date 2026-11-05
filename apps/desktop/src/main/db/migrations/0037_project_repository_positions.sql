-- Repairs `project_repositories.position` collisions left by the old
-- "position = number of rows already there" rule.
--
-- Removing a repository leaves a gap, so counting handed out a position
-- something already held: remove the first of two and the next one added
-- collides with the survivor. Nothing rejected it — the primary key is
-- (project, repository), not the position — so any database that has ever
-- had a repository removed and another added can be carrying duplicates
-- right now. Fixing the insert rule stops new ones; it does not touch the
-- rows already written, which is what this does.
--
-- The order is not cosmetic. `projectRepositoryList` reads it to decide
-- the repository a `discuss` dispatch starts in and the one a feature's
-- worktree is cut from.
--
-- Renumbered to a dense 0..n-1 per project, ordering by the position each
-- row already has and breaking ties on `repository_id` — the same total
-- order the query now uses, so this migration and the reader agree about
-- which of two colliding rows came first.
UPDATE `project_repositories`
SET `position` = (
	SELECT COUNT(*)
	FROM `project_repositories` AS `earlier`
	WHERE `earlier`.`project_id` = `project_repositories`.`project_id`
		AND (
			`earlier`.`position` < `project_repositories`.`position`
			OR (
				`earlier`.`position` = `project_repositories`.`position`
				AND `earlier`.`repository_id` < `project_repositories`.`repository_id`
			)
		)
);
