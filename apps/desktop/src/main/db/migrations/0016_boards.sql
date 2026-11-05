-- KAN-17: a board stops being a project.
--
-- One application is often several repositories — a UI and a backend, or
-- interconnected services — and a feature in that world lands across more
-- than one. Until now a board *was* a project, so that work had to be
-- described twice and coordinated by hand.
--
-- A board becomes its own thing, joined to projects many-to-many. Every
-- story still targets exactly one project: that is what keeps one
-- worktree, one branch, one verification run and one pull request per
-- story, and none of the engine had to change because it already
-- resolves all four from the ticket's own project_id.
CREATE TABLE boards (
	id TEXT PRIMARY KEY NOT NULL,
	name TEXT NOT NULL,
	-- Features on this board draw their key from here. Unique in the same
	-- namespace as projects.key_prefix because both index the one
	-- key_counters table — which is exactly what makes a default board,
	-- carrying its project's prefix, number identically to before.
	key_prefix TEXT NOT NULL UNIQUE,
	-- Which member project's Jira receives features. Null means don't
	-- mirror them; stories always follow their own project's Jira.
	--
	-- SET NULL, not the default RESTRICT: a plain reference here made
	-- every default board nominate its own project and so made deleting
	-- any project fail outright. Losing the Jira home is the right
	-- consequence — the board survives, it just stops mirroring
	-- features until another project is nominated.
	jira_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
--> statement-breakpoint

CREATE TABLE board_projects (
	board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	position INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (board_id, project_id)
);
--> statement-breakpoint

-- Prose, not a label. This is the whole basis on which the product owner
-- decides which repository a story belongs in, so "the Go payments
-- service" earns its place and "backend" does not.
ALTER TABLE projects ADD COLUMN description TEXT;
--> statement-breakpoint

-- Which board a ticket appears on. Deliberately not derivable from
-- project_id: a project may sit on several boards, so the ticket has to
-- say. It is also what a cross-project feature has *instead* of a
-- project, since its work is spread across several.
ALTER TABLE tickets ADD COLUMN board_id TEXT REFERENCES boards(id);
--> statement-breakpoint

-- Every existing project gets a default board wearing its own name and
-- prefix. Sharing the prefix is the point: the board and the project
-- index the same key_counters row, so numbering continues unbroken
-- rather than restarting or skipping.
--
-- The id is a random blob rather than the project's own. Reusing it
-- would have made the two statements below trivial, and would have left
-- a trap: any code that later confused a board id for a project id
-- would work on every migrated database and fail only on a fresh one.
-- An obviously different shape fails the same way everywhere. It is
-- also the one place an id is not the client-side UUIDv7 the rest of
-- the codebase uses, because SQL has no way to mint one.
INSERT INTO boards (id, name, key_prefix, jira_project_id, created_at, updated_at)
SELECT lower(hex(randomblob(16))), name, key_prefix, id, created_at, updated_at FROM projects;
--> statement-breakpoint

-- Joined on key_prefix, which is unique in both tables and is the real
-- correspondence between a project and the board just made for it.
INSERT INTO board_projects (board_id, project_id, position)
SELECT boards.id, projects.id, 0 FROM boards JOIN projects ON projects.key_prefix = boards.key_prefix;
--> statement-breakpoint

-- Tickets follow their project onto its default board. Ones written
-- before any repo was attached have no project, so they get no board and
-- go on behaving exactly as they did (D-04).
UPDATE tickets SET board_id = (
	SELECT board_projects.board_id FROM board_projects WHERE board_projects.project_id = tickets.project_id
) WHERE project_id IS NOT NULL;
