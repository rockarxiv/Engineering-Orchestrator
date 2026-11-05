-- A provider thread keeps the instructions it was born with: Claude's
-- resume() never re-sends systemPrompt, and Codex only folds them into
-- the opening prompt. So deciding whether a thread may be resumed after
-- somebody edits an agent's instructions means knowing which ones that
-- thread was actually started with, and no row said.
--
-- Not `agents.prompt_hash`: that is provenance for syncRolePrompts — is
-- this text still verbatim what EO shipped — and it moves when the agent
-- is edited, which is exactly the question being asked here.
--
-- Null on every row written before this column existed, and on builtin
-- and module runs, which have no agent and so no instructions. Null is
-- the absence of an answer and must never be read as a match.

ALTER TABLE `runs` ADD COLUMN `instructions_hash` TEXT;
