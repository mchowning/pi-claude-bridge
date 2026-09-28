# Cache-flow matrix

Flows where the bridge must keep a pi session on the same Claude Code session (so the prompt
cache hits) and flows where it must rebuild (so the model never sees a history that differs
from pi's). Run it on any change to session sync, fork-from, reload/restart handoff or the
session pointer, and add a row for any new flow of that kind.

A hit row that starts missing is a cost regression. A rebuild row that starts resuming is a
correctness bug, which matters more. A rebuild row may still read tools and CC's system
prompt from cache; only the path and the CC session are asserted there.

## Rows

"Path" is the first `syncResult: path=` after the event in the bridge debug log. "Unit" names
the tests that pin the row's decision without a model.

| # | Flow | Path | CC session | Cache | Unit |
|---|---|---|---|---|---|
| 1 | Restart (same session file), then a main turn | reuse | main's, same id | hit | `unit-session-pointer-wiring` (adopts on startup/resume), `unit-session-pointer` |
| 2 | Restart, then a review thread before any main turn | fork-from | new id, copy of main's | hit; no runner warning | `unit-session-pointer-wiring` (adoption publishes the lookup), `unit-fork-from` |
| 3 | Fork process reopened without `CLAUDE_BRIDGE_FORK_FROM` (retry, second review) | reuse | the fork's own | hit | `unit-session-pointer-wiring` (adopts on startup) |
| 4 | Multi-turn with tool calls | reuse | same | hit | `unit-sync-shared-session` |
| 5 | `/reload`, then a main turn | reuse | same | hit | `unit-reload-handoff` |
| 6 | `/reload`, then a thread | fork-from | new id | hit | `unit-reload-handoff`, `unit-fork-from` |
| 7 | Thread after a main turn | fork-from | new id | hit | `unit-fork-from` |
| 8 | Second turn in a fork; two threads at once | reuse (fork); fork-from ×2 | each fork its own | hit | `unit-fork-from` (the copy stays with the session that prepared it) |
| 9 | Tool-set change (a second `system` entry), then restart | reuse | same | measured: the tools block changes, so a partial read is expected | `unit-sync-shared-session` (system messages and the cursor), `unit-session-pointer` (a system entry is harmless) |
| 10 | `/compact`, restart | rebuild | — | not asserted | `unit-session-pointer` (compaction rejects) |
| 11 | Abort mid-turn, restart | rebuild | — | not asserted | `unit-session-pointer-wiring` (no pointer after an abort), `unit-session-pointer` |
| 12 | `/tree` rewind (no summary) + label, restart | rebuild | — | not asserted | `unit-session-pointer` (abandoned branch; turn on another branch) |
| 13 | Turns on another provider, back to the bridge, restart | rebuild | — | not asserted | `unit-session-pointer-wiring` (another provider answered), `unit-session-pointer` |
| 14 | pi `/fork` of main, first turn | rebuild or clean-start | never main's id; main's CC file byte-identical | not asserted | `unit-session-pointer` (another pi session's pointer), `unit-fork-from` |
| 15 | Restart in another cwd | rebuild | — | not asserted | `unit-sync-cwd`, `unit-session-pointer` (cwd) |
| 16 | `context_edit` during a run, restart, then a good run and restart | rebuild, then reuse | —, then same | hit on the last | `unit-session-pointer-wiring` (context_edit tests) |
| 17 | Restart after the CC session file is deleted | rebuild | — | not asserted | `unit-session-pointer` (CC file gone) |

## Layers

| Layer | What runs | Model | Cache means | Time |
|---|---|---|---|---|
| 1 Unit | `npm run -s test:unit` | none | — (paths only) | seconds |
| 2 Fake API | real pi + bridge + CC against `tests/lib/fake-anthropic.mjs` | none | the next request matches the previous one block for block through the previous request's last `cache_control` breakpoint (`tests/lib/cache-compare.mjs`); says a hit is possible, not that one happened | ~3 min bridge rows, ~5 min thread rows |
| 3 Live | the same flows against the real API | **Haiku 4.5** | `cacheRead` ≥ 90% of the previous request's `cacheRead + cacheWrite` | ~5 min bridge rows, ~8 min thread rows |

Run layers 1 and 2 on every change in scope. Run layer 3 before pushing such a change: only the
server can show a real hit, and account-level changes (anthropics/claude-code#77306, TTL) show
up only there.

**Always Haiku.** The matrix compares cache ratios, not answers, and Haiku is the fastest and
cheapest model that exercises the same bridge paths. Both drivers pin
`claude-bridge/claude-haiku-4-5`; forks inherit main's model.

## Running

Bridge rows (1, 4, 5, 9–17):

```sh
node --import tsx tests/cache-flows.mjs --api fake            # layer 2
node --import tsx tests/cache-flows.mjs --api live            # layer 3
node --import tsx tests/cache-flows.mjs --api fake --rows 1,16 --record   # a subset; --record never fails
```

Results: `.test-output/cache-flows-<api>/results.json`; each row's bridge debug log is
`.test-output/cache-flows-<api>-row<N>-…-debug.log`, fake request bodies under
`.test-output/cache-flows-fake/row<N>-…/requests/`.

Thread rows (2, 3, 6, 7, 8) need the plannotator runner and review UI, so they live in dotfiles:

```sh
~/dotfiles/bin/plannotator-thread-cache-flows fake /tmp/ptcf-fake   # runs a b c
~/dotfiles/bin/plannotator-thread-cache-flows live /tmp/ptcf-live
```

Results: `<outdir>/results.jsonl` (one line per fork turn: path, CC session, runner warning,
cache).

## What the drivers depend on

- `tests/fixtures/cache-flows-ext.ts` gives RPC the operations it has no command for: reload,
  rewind + label, a tool-set change, a `context_edit` at the next `turn_end`, and a second
  provider (`flows-other`, pi-ai's faux core) that needs no API.
- Each bridge flow runs with a private `PI_CODING_AGENT_DIR` whose settings set
  `compaction.keepRecentTokens: 50`, so `/compact` works on a short session and the user's pi
  settings stay out.
- Every flow's first prompt carries ~6k tokens of filler (thread runs have main read a filler
  file). Tools and CC's system prompt are ~12k tokens of every request and survive a rebuild;
  without a history of real size a rebuild still reads ~90% from cache and looks like a hit.
- The fake server replies from the request: a `tool_use` when the last user text says
  `USE_TOOL`, a reply that pauses 10 s mid-stream for `SLOW` (so an abort lands in the turn),
  text otherwise. With a non-first-party `ANTHROPIC_BASE_URL`, CC disables optimistic
  ToolSearch, so layer 2's `tools` may differ from production's; layer 3 covers that.
- Fake runs point proxies at a dead port so nothing but localhost is reachable (CC's OTEL
  metrics export is the only other traffic, and fails).

## Known noise

- Fake runs report `cacheRead: 0` on every request, so the plannotator runner's "first turn read
  0 of main's … tokens" warning fires there; the thread script ignores it in fake mode. The
  "started without main's Claude Code session" warning counts in both modes, and in live mode
  any runner warning is a finding.
- Claude Code can stall at startup reading the macOS Keychain (`[keychain] read failed;
  serving stale cache` after the stall), which times a row out. Rerun the row; a repeat is a
  finding.
- Row 11's live cache is 0%: the aborted turn leaves no usable baseline. Its path is what counts.
