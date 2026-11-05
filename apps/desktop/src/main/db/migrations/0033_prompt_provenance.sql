-- What EO last wrote into an agent's instructions (R-01, U-06).
--
-- The two rules here have always been in tension. Prompts are versioned
-- files so they can be improved (R-01), and a prompt someone edited is
-- theirs and must never be silently reverted (U-06). `syncRolePrompts`
-- resolved that by only ever filling in the seed placeholder — which
-- honoured U-06 completely and gave up on R-01 entirely: every install
-- past its first launch kept whatever prompt it started with, forever.
--
-- The missing fact was provenance. "Has a human touched this?" is not
-- answerable from the text alone, but it is trivially answerable if EO
-- records the hash of what it wrote: instructions that still hash to it
-- are EO's own words, and anything else is somebody's edit.
--
-- NULL means unknown, which is every row that predates this column and
-- every prompt a human has saved. `syncRolePrompts` treats those two the
-- same way — it recognises the small closed set of prompts EO shipped
-- before it started recording, and leaves everything else alone.

ALTER TABLE `agents` ADD COLUMN `prompt_hash` TEXT;
