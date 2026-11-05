# NOTICE

EO (Engineering Orchestrator)
Copyright 2026 Lyudvig Mkrtchyan

EO is licensed under the Apache License, Version 2.0 — see LICENSE.

This file is generated. Do not edit it by hand; edit
`scripts/notice-header.md` and run `node scripts/third-party-notice.mjs`
against a packed build.

## What EO does not ship

The coding-agent command-line tools EO drives, and the indexer EO
queries about a repository, are **not** included in this application. EO
downloads them from their publishers, on request, after showing you what
is about to be fetched and whose terms apply:

| Component | Publisher | Terms |
| --- | --- | --- |
| Claude Code CLI, and the Claude Agent SDK | Anthropic PBC | <https://code.claude.com/docs/en/legal-and-compliance> |
| Codex CLI | OpenAI | <https://github.com/openai/codex/blob/main/LICENSE> |
| CodeWiki, the repository indexer | 0xsyncroot | <https://github.com/0xsyncroot/codewiki/blob/main/LICENSE> |

Anthropic's components carry no redistribution grant — their licence
reads "© Anthropic PBC. All rights reserved" — so EO does not
redistribute them. Downloading puts your machine in direct contact with
Anthropic's own distribution, under Anthropic's own terms. EO is the
fetcher, never the redistributor, and charges nothing for them.

Codex is Apache-2.0 and could be redistributed. It takes the same path
anyway: one mechanism is easier to reason about than two.

CodeWiki is MIT and could be redistributed too. It takes the same path
for the same reason, pinned to the one version an EO release was tested
against. Fetching rather than redistributing lightens the obligation; it
does not remove the record, so what CodeWiki attributes — its own
copyright, the work it derives from, and the grammars it embeds — is
reproduced below rather than linked to and forgotten.

Every download is checked against a checksum its own publisher put
behind it before anything is unpacked or made executable: the npm
registry's `dist.integrity` for the agent CLIs, and the `.sha256` file
published beside each release asset for CodeWiki.

## CodeWiki, and the grammars it vendors

EO builds its repository index with CodeWiki v0.2.1, fetched from that
project's GitHub releases when repository intelligence is switched on,
and neither modified nor redistributed by EO. Everything in this section
is CodeWiki's own attribution, carried here verbatim.

### CodeWiki's licence

From `LICENSE` at tag v0.2.1
(<https://github.com/0xsyncroot/codewiki/blob/v0.2.1/LICENSE>):

```
MIT License

Copyright (c) 2026 0xsyncroot

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### CodeGraph, which CodeWiki is a derivative work of

CodeWiki carries a `NOTICE` of its own, attributing CodeGraph by Colby
McHenry and reproducing CodeGraph's MIT notice inside it. That file, in
full, from tag v0.2.1
(<https://github.com/0xsyncroot/codewiki/blob/v0.2.1/NOTICE>):

```
CodeWiki
Copyright (c) 2026 0xsyncroot

This product is licensed under the MIT License. See the LICENSE file for the
full license text.

================================================================================
Derivative-work attribution
================================================================================

CodeWiki is a Rust port and derivative work of CodeGraph by Colby McHenry
(https://github.com/colbymchenry/codegraph). It incorporates substantial
portions of CodeGraph's design, re-architected in Rust for speed and scale,
including:

  - the overall architecture and processing pipeline
  - the SQLite storage schema
  - the reference-resolution algorithms
  - the search and scoring logic
  - the MCP tool interface

As required by CodeGraph's MIT License, its original copyright notice and the
full MIT permission and warranty notice are reproduced verbatim below:

--------------------------------------------------------------------------------

    Copyright (c) 2026 Colby Mchenry

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

--------------------------------------------------------------------------------

================================================================================
Third-party attributions
================================================================================

Third-party tree-sitter grammar and dependency attributions are listed in
LICENSE-THIRD-PARTY.md.
```

### The tree-sitter grammars CodeWiki embeds

The CodeWiki binary embeds four compiled tree-sitter grammars as
WebAssembly. It lists them in `LICENSE-THIRD-PARTY.md`, which at tag
v0.2.1 reads in full
(<https://github.com/0xsyncroot/codewiki/blob/v0.2.1/LICENSE-THIRD-PARTY.md>):

```
# Third-Party License Attributions

This binary includes compiled WebAssembly grammar files from the following
open-source projects. Each is distributed under the MIT License.

---

## tree-sitter-lua
Source: https://github.com/MunifTanjim/tree-sitter-lua
SPDX: MIT
License file: vendor/licenses/tree-sitter-lua-LICENSE

---

## tree-sitter-luau
Source: https://github.com/polychromatist/tree-sitter-luau
SPDX: MIT
License file: vendor/licenses/tree-sitter-luau-LICENSE

---

## tree-sitter-pascal
Source: https://github.com/Isopod/tree-sitter-pascal
SPDX: MIT
License file: vendor/licenses/tree-sitter-pascal-LICENSE

---

## tree-sitter-scala
Source: https://github.com/tree-sitter/tree-sitter-scala
SPDX: MIT
License file: vendor/licenses/tree-sitter-scala-LICENSE

---

(Additional crate attributions generated by `cargo about generate` in CI.)
```

That file points at `vendor/licenses/tree-sitter-*-LICENSE`. At tag
v0.2.1 each of those four files is 12 bytes containing the single word
`placeholder`, so pointing a reader at them would attribute nothing. The
four licences are therefore reproduced below from each grammar's own
repository, at the version `vendor/licenses/wasm-grammars.md` records as
the one vendored. None of the four is dropped.

#### tree-sitter-lua

Vendored as `tree-sitter-lua.wasm` from
<https://github.com/tree-sitter-grammars/tree-sitter-lua> at v0.5.0
(`10fe0054734eec83049514ea2e718b2a56acd0c9`) — the canonical successor
to <https://github.com/MunifTanjim/tree-sitter-lua>, which
`LICENSE-THIRD-PARTY.md` names, and whose `LICENSE.md` is the same file
byte for byte:

```
The MIT License (MIT)

Copyright (c) 2021 Munif Tanjim

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### tree-sitter-luau

Vendored as `tree-sitter-luau.wasm`, built from
<https://github.com/polychromatist/tree-sitter-luau> at commit
`71b03e66`. From its `LICENSE`:

```
MIT License

Copyright (c) 2024 polychromatist

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### tree-sitter-pascal

Vendored as `tree-sitter-pascal.wasm`, built from
<https://github.com/Isopod/tree-sitter-pascal> at v0.10.2
(`042119eca2e18a60e56317fb06ee3ba5c32cb447`). From its `LICENSE`:

```
MIT License

Copyright (c) 2018 Benjamin Gray

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### tree-sitter-scala

Vendored as `tree-sitter-scala.wasm` from
<https://github.com/tree-sitter/tree-sitter-scala> at v0.26.0
(`2653eb5dcabaf655781bcd33890f076c724c7ed2`). From its `LICENSE`:

```
The MIT License (MIT)

Copyright (c) 2018 Max Brunsfeld and GitHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Electron, Chromium and Node.js

EO is built on Electron, which embeds Chromium and Node.js. Their
licences and full source availability are as published by those
projects:

- Electron — MIT, <https://github.com/electron/electron/blob/main/LICENSE>
- Chromium — BSD-3-Clause and others, <https://chromium.googlesource.com/chromium/src/+/main/LICENSE>
- Node.js — MIT, <https://github.com/nodejs/node/blob/main/LICENSE>

The Electron distribution carries its own `LICENSES.chromium.html`
alongside the application binary, which is the authoritative list for
the embedded browser.
