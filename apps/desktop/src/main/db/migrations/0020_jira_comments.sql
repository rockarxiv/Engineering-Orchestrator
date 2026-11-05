-- Which Jira comment a local comment is.
--
-- Set two ways, and it closes an echo loop in both directions:
--
--   * a comment pulled *from* Jira carries the id it came from, and the
--     outbound enqueue in commentsRepo skips anything that has one — so
--     EO never sends Jira its own comment back;
--   * a comment pushed *to* Jira has the id Jira assigned written onto
--     it when the push succeeds, so a later pull recognises its own echo
--     and skips it.
--
-- Without this there is nothing durable to recognise either by. The
-- outbox row is deleted on success ("a queue, not a ledger"), and
-- `addComment` discarded Jira's response, which is where the id was.
-- Content matching cannot stand in: the sender appends "— via EO" to
-- every pushed body, and Cloud's ADF conversion is deliberately lossy,
-- so nothing round-trips byte-for-byte.
ALTER TABLE comments ADD COLUMN jira_comment_id TEXT;
--> statement-breakpoint
-- Asked once per pulled comment, which is the hot path of a sync.
CREATE INDEX idx_comments_jira ON comments (jira_comment_id);
--> statement-breakpoint
-- `findByJiraKey` scans every ticket, archived included. Fine for
-- importing one issue by hand; not fine for a poller asking per issue.
CREATE INDEX idx_tickets_jira_key ON tickets (jira_key);
