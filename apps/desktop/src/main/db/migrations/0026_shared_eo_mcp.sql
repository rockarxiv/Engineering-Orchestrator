-- Claude's allowlist is opt-in. Existing product-owner rows already allow
-- ticket_detail; add the other read from the same shared EO service without
-- replacing any user-customized tools.
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__attachment_read')
WHERE json_type(`config`, '$.allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value = 'mcp__eo__attachment_read'
  );
