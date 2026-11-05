-- The memory_note tool, and extraction after each run (EO-479).
--
-- A run's entry is either a note the agent wrote with `memory_note` or
-- one EO drew out of what the run produced after it ended. `extracted`
-- tells the two apart; every row written before this is a person's or
-- (none yet) an agent's own note, so it starts false.
ALTER TABLE `memories` ADD `extracted` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- The grant, on the three roles EO ships an agent for that should keep
-- memory: the implementer, the reviewer and the system agent. Held in
-- `allowedTools` the way `comment` is, so the `eo` server lists the tool
-- for these agents and for no other until a person names it.
--
-- An agent with an allowlist gets the tool appended once — the NOT
-- EXISTS makes a second run of this, or a hand edit made first, a no-op.
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__memory_note')
WHERE `role` IN ('implementer', 'reviewer', 'system')
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value IN ('mcp__eo__memory_note', 'memory_note')
  );
--> statement-breakpoint
-- An agent with no allowlist at all — the shipped implementer and
-- reviewer — is given one naming only this tool. That narrows nothing:
-- EO pins `bypassPermissions`, so on Claude an allowlist pre-approves
-- rather than restricts, Codex does not read the field, and every other
-- capability EO keys on a grant (`thread_read`, `comment`, the config
-- tools, `eo_admin`) is still not granted. An `allowedTools` somebody
-- wrote as something other than a list is theirs to fix and is left.
UPDATE `agents`
SET `config` = json_set(`config`, '$.allowedTools', json_array('mcp__eo__memory_note'))
WHERE `role` IN ('implementer', 'reviewer', 'system')
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') IS NULL;
