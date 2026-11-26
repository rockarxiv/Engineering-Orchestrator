-- Who answered or dismissed a message (EO-918): the person, the assistant
-- (a system agent, by id) or an outside MCP client, as
-- `MessageHandledBy` JSON. Null on a message still open, one EO resolved,
-- and every message handled before this column existed, which reads as
-- the person: until now only the person could handle one. (A replica's
-- copy of the record's reads as not known instead, until it is pulled
-- again: see `handledByOf` in messagesRepo.)
ALTER TABLE `messages` ADD `handled_by` text;
