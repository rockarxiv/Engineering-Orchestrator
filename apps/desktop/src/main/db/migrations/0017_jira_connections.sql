-- KAN-22: a Jira connection stops being part of a project.
--
-- The site, the flavour, the account and the token described one Jira
-- *site*, but lived on each project that used it. Two projects on one
-- site meant two encrypted copies of the same token, entered twice and
-- rotated twice — and a project forgotten during a rotation kept failing
-- quietly until its outbox gave up. Multi-project boards (KAN-17) turned
-- that from rare into routine.
--
-- What stays on the project is what genuinely belongs to *its* Jira
-- project: the key, the issue types, the required field values, the
-- status map, the transition fields. J-05 exists because two Jira
-- projects on one site can demand different fields, so those cannot move.
CREATE TABLE jira_connections (
	id TEXT PRIMARY KEY NOT NULL,
	-- What to call it in front of a person. Defaults to the host, which
	-- is what someone with one connection would have called it anyway.
	name TEXT NOT NULL,
	base_url TEXT NOT NULL,
	flavour TEXT NOT NULL, -- cloud | datacenter
	-- Cloud only: Basic auth is email:token. Null on datacenter, where
	-- the token stands alone.
	email TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
--> statement-breakpoint

-- SET NULL rather than cascade: deleting a connection must not delete
-- the projects that used it. They keep their Jira project key and their
-- field settings, and simply stop mirroring until another connection is
-- chosen — the same shape as a project that was never connected.
ALTER TABLE projects ADD COLUMN jira_connection_id TEXT REFERENCES jira_connections(id) ON DELETE SET NULL;
--> statement-breakpoint

-- One connection per distinct site, account and flavour among the
-- projects that actually have one. GROUP BY is what collapses several
-- projects sharing a site into the single connection this exists to
-- create. `ifnull` on email because two rows differing only by NULL
-- would otherwise never group, SQL's NULL not being equal to itself.
--
-- The id is a random blob, not a project's: reusing one would work on
-- every migrated database and fail on every fresh one, which is the
-- worst way for a mistake to behave (the same reasoning as 0016).
INSERT INTO jira_connections (id, name, base_url, flavour, email, created_at, updated_at)
SELECT
	lower(hex(randomblob(16))),
	-- The host, which is how a person refers to the site anyway.
	replace(replace(rtrim(base_url, '/'), 'https://', ''), 'http://', ''),
	base_url,
	flavour,
	email,
	created_at,
	updated_at
FROM (
	SELECT
		jira_base_url AS base_url,
		jira_flavour AS flavour,
		jira_email AS email,
		min(created_at) AS created_at,
		max(updated_at) AS updated_at
	FROM projects
	WHERE jira_base_url IS NOT NULL AND jira_base_url != '' AND jira_flavour IS NOT NULL
	GROUP BY jira_base_url, jira_flavour, ifnull(jira_email, '')
);
--> statement-breakpoint

UPDATE projects SET jira_connection_id = (
	SELECT jira_connections.id FROM jira_connections
	WHERE jira_connections.base_url = projects.jira_base_url
		AND jira_connections.flavour = projects.jira_flavour
		AND ifnull(jira_connections.email, '') = ifnull(projects.jira_email, '')
) WHERE jira_base_url IS NOT NULL AND jira_base_url != '' AND jira_flavour IS NOT NULL;
--> statement-breakpoint

-- Dropped, not left behind. Two places holding a base URL is precisely
-- the bug class this migration removes, and a column nothing reads is a
-- column somebody will read by accident.
--
-- The tokens are not here to move: they are files under userData keyed
-- by project id. `rekeyJiraTokens` in main/jira/credentials.ts copies
-- each to its connection's name on first launch, so nobody re-enters a
-- token they already gave us.
ALTER TABLE projects DROP COLUMN jira_base_url;
--> statement-breakpoint

ALTER TABLE projects DROP COLUMN jira_flavour;
--> statement-breakpoint

ALTER TABLE projects DROP COLUMN jira_email;
