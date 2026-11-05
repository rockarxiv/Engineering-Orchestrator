-- KAN-33: the board tidies up after itself.
--
-- A timestamp rather than a boolean, because "when" is a question the UI
-- asks anyway — an archived list is worth ordering by it — and NULL is a
-- cleaner "not archived" than a 0/1 column with a default.
--
-- Nothing is deleted. That is the whole distinction from KAN-30: delete
-- is a person removing something that should not exist, archive is work
-- that finished and no longer needs looking at. Comments, runs,
-- run_events, cost and the Jira link all stay exactly where they are,
-- which is what makes unarchiving a restore rather than a rebuild.
ALTER TABLE tickets ADD COLUMN archived_at INTEGER;
--> statement-breakpoint
-- The board, the inbox and the scheduler all ask "which tickets are
-- live?", and they ask it on every tick.
CREATE INDEX idx_tickets_archived ON tickets (archived_at);
