-- An allowlist is exhaustive, so a tool that is registered and not named in
-- one is a tool the agent is offered and then refused -- the gap 0112 closed
-- for `attachment_add`.
--
-- The module-change tools (EO-813) stage and freeze a change to an existing
-- module for a card in the assistant's chat or a module's scenario chat.
-- Both rooms are answered by the system agent, so they are added to the
-- `system` role's allowlist and nobody else's: EO refuses them on any other
-- turn regardless. An agent with no allowlist is not narrowed and needs
-- nothing.
--
-- Once per tool: the NOT EXISTS is what makes running this over a list that
-- already names it a no-op. `json_valid` guards the batch as 0112 does.
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__module_change_prepare')
WHERE `role` = 'system'
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value = 'mcp__eo__module_change_prepare'
  );
--> statement-breakpoint
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__module_change_edit')
WHERE `role` = 'system'
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value = 'mcp__eo__module_change_edit'
  );
--> statement-breakpoint
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__module_change_freeze')
WHERE `role` = 'system'
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value = 'mcp__eo__module_change_freeze'
  );
