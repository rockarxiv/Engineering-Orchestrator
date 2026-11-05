-- Renaming the two things EO groups work by, so the words mean what the
-- product means (KAN-51).
--
-- `boards` was already the group that owns a pipeline: its own comment
-- said "One application is often several repositories… A board is what
-- those repositories share". `projects` was a single git repository plus
-- how to verify and mirror it. The UI now calls the group a *project* and
-- the repository a *repository*, and carrying a permanent translation
-- between the two vocabularies is how the next dozen stories would each
-- acquire a small bug.
--
-- Done as one rename rather than a data-preserving multi-step dance
-- because this is a greenfield reset (the app is v0.0.0) — nothing here
-- has to survive an upgrade in the field.
--
-- Order is load-bearing. `projects` must vacate the name before `boards`
-- can take it, and each column rename has to happen after the table it
-- lives on has settled. SQLite rewrites the foreign keys that point at a
-- renamed table for us, which is why no constraint is dropped below.

ALTER TABLE `projects` RENAME TO `repositories`;
--> statement-breakpoint
ALTER TABLE `boards` RENAME TO `projects`;
--> statement-breakpoint
ALTER TABLE `board_projects` RENAME TO `project_repositories`;
--> statement-breakpoint

-- `tickets` carries both, and they swap meaning, so the old `project_id`
-- has to move out of the way before `board_id` moves in.
ALTER TABLE `tickets` RENAME COLUMN `project_id` TO `repository_id`;
--> statement-breakpoint
ALTER TABLE `tickets` RENAME COLUMN `board_id` TO `project_id`;
--> statement-breakpoint

-- Same swap on the join table: it pairs a group with a repository.
ALTER TABLE `project_repositories` RENAME COLUMN `project_id` TO `repository_id`;
--> statement-breakpoint
ALTER TABLE `project_repositories` RENAME COLUMN `board_id` TO `project_id`;
--> statement-breakpoint

-- The outbox is addressed to a repository — it pushes to that repo's Jira
-- project and opens pull requests against that repo's forge.
ALTER TABLE `outbox` RENAME COLUMN `project_id` TO `repository_id`;
