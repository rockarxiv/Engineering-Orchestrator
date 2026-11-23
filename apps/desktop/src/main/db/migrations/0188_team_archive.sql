-- A person may archive a single declared team (EO-897). One-way, as
-- archiving an agent is: the team's own agents are archived with it, it
-- leaves the Teams tab and no step may name it. NULL for every team that
-- is not archived, which is every team before this migration.
ALTER TABLE `teams` ADD `archived_at` integer;
