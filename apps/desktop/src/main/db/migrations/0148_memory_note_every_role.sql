-- The memory_note grant, on every agent rather than three roles (EO-593).
--
-- 0126 granted it to the implementer, the reviewer and the system agent,
-- because their prompts were where an agent was told how to write memory.
-- That is EO's own block now, appended to every turn served the tool, so
-- an agent a person made with their own instructions gets the tool and
-- the instructions alike.
--
-- Not the three roles 0126 granted: an agent of one of those without the
-- grant now is one a person took it away from, and that stands. Not a
-- deleted agent, which nothing dispatches, nor a preview agent
-- (`eoPreviewAgent`), which runs a template on `fake` and has no business
-- writing a project's memory.
--
-- An agent with an allowlist gets the tool appended once — the NOT
-- EXISTS makes a second run of this, or a hand edit made first, a no-op.
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__memory_note')
WHERE `role` NOT IN ('implementer', 'reviewer', 'system')
  AND `deleted_at` IS NULL
  AND json_valid(`config`)
  AND json_extract(`config`, '$.eoPreviewAgent') IS NOT 1
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value IN ('mcp__eo__memory_note', 'memory_note')
  );
--> statement-breakpoint
-- An agent with no allowlist at all is given one naming only this tool,
-- which narrows nothing, for the reason 0126 gives. An `allowedTools`
-- somebody wrote as something other than a list is theirs to fix and is
-- left.
UPDATE `agents`
SET `config` = json_set(`config`, '$.allowedTools', json_array('mcp__eo__memory_note'))
WHERE `role` NOT IN ('implementer', 'reviewer', 'system')
  AND `deleted_at` IS NULL
  AND json_valid(`config`)
  AND json_extract(`config`, '$.eoPreviewAgent') IS NOT 1
  AND json_type(`config`, '$.allowedTools') IS NULL;
