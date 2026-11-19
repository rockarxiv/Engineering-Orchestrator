-- The repository a job files its items on (EO-856).
--
-- One of the job's project's workspaces, by id, so renaming the
-- repository in EO does not detach the job. Null is EO-855's rule: the
-- project's only repository, otherwise none. No foreign key, as with a
-- step's pick (`pipeline_steps.workspace_id`): a repository removed from
-- the project leaves the id behind, and the next firing refuses with a
-- failed occurrence rather than quietly filing somewhere else.
ALTER TABLE `jobs` ADD `workspace_id` text;
