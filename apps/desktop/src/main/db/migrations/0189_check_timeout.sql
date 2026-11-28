-- A repository's check timeout, in whole minutes (EO-928): how long each
-- of its test, lint and build commands may run before verify kills it.
-- Ten on every repository attached before this, which is what each check
-- was given before a repository could say otherwise. A repository that
-- already names one keeps it.
UPDATE `workspaces`
SET `config` = json_set(`config`, '$.checkTimeoutMinutes', 10)
WHERE `kind` = 'git-worktree' AND json_type(`config`, '$.checkTimeoutMinutes') IS NULL;
