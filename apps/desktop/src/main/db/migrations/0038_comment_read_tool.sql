-- An allowlist is exhaustive, so a tool that is registered and not named in
-- one is a tool the agent is offered and then refused — the same gap 0026
-- closed for `attachment_read`.
--
-- Added only where `mcp__eo__ticket_detail` already is. `comment_read`
-- returns one comment and the replies under it, which is a strict subset of
-- what that agent can already read whole; granting it anywhere else would be
-- reach the agent never had, which is exactly what this tool must not
-- create. The architect's allowlist has no ticket reads in it and keeps none.
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__comment_read')
WHERE json_type(`config`, '$.allowedTools') = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value = 'mcp__eo__ticket_detail'
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value = 'mcp__eo__comment_read'
  );
