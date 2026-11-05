-- Attempts are bounded per initiation rather than over a ticket's entire
-- history. A workflow-state entry, direct mention, or explicit human
-- authorization supplies the stable id; retries reuse it.
ALTER TABLE `runs` ADD COLUMN `initiation_id` TEXT;
