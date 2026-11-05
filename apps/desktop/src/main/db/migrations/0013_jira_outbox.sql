-- J-04: what still has to reach Jira.
--
-- A push must never block a dispatch or a comment box on a network
-- call, and must survive being offline or being quit. So the cause and
-- the intent to push are written in one transaction, and the sending
-- happens later, from here.
--
-- Not append-only: this is a queue, not a ledger. `run_events` is the
-- durability substrate (invariant #3); rows here are deleted once they
-- land, because a table of everything EO ever told Jira is a second
-- copy of the transitions table nobody would read.
CREATE TABLE jira_outbox (
	id TEXT PRIMARY KEY,
	ticket_id TEXT NOT NULL REFERENCES tickets(id),
	-- Denormalised so a drain does not need the ticket to find the
	-- connection, and so an entry survives its ticket being reassigned.
	project_id TEXT NOT NULL REFERENCES projects(id),
	-- status | comment | branch
	kind TEXT NOT NULL,
	payload TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	-- Backoff. A Jira that is down stays down for a while, and retrying
	-- every five seconds helps nobody.
	next_attempt_at INTEGER NOT NULL,
	last_error TEXT,
	created_at INTEGER NOT NULL
);
--> statement-breakpoint

-- The drain's only query: what is due, oldest first.
CREATE INDEX idx_jira_outbox_due ON jira_outbox (next_attempt_at, id);
--> statement-breakpoint
-- Order within a ticket is the point of `id` being UUIDv7 here: two
-- comments must reach Jira in the order they were written.
CREATE INDEX idx_jira_outbox_ticket ON jira_outbox (ticket_id, id);
