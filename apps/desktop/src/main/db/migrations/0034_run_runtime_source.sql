-- An agent's executable-path setting can change while its subprocess is
-- still running. Record which selection actually launched each run so a
-- later settings edit cannot make the runtime lifecycle guard misidentify
-- that already-running process.

ALTER TABLE `runs` ADD COLUMN `runtime_source` TEXT;
