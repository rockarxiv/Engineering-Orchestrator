Kept for `refine.test.ts`, not shipped to anyone.

`implementer-v4.md` is implementer.md as it stood at prompt-version 4 —
one of the defaults EO shipped before it recorded the hash of what it
wrote, and therefore one of the texts `SHIPPED_PROMPT_HASHES`
recognises. The test needs *a* historical prompt to stand in for a
pre-0033 install; it used to use whatever the current file happened to
be, which worked only while the current version was still in that closed
set. It no longer is, for any role, which is the steady state the set's
own docstring describes.

`product-owner-v8.md` is the same thing for the role EO-181 renamed.
That merge moved the product owner's row to `system`, and
`SHIPPED_PROMPT_HASHES` is keyed on the role — so an install old enough
to carry no provenance stops matching the list that describes its own
history unless those hashes travel with it. This is the text that proves
they did; the file it came from no longer exists.


`implementer-v14.md`, `reviewer-v14.md` and `system-agent-v36.md` are
the last texts of the three prompts that told an agent how to write
memory in a paragraph of their own (EO-593). That moved into the block
EO appends to every turn served `memory_note`, and these three hashes
joined `SHIPPED_PROMPT_HASHES` so a row holding one of them without
provenance is brought up to date rather than read as an edit.
`memoryPrompts.test.ts` proves it with these bytes.

Do not edit any of them: their bytes are the fixture.
