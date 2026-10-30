# Fork changelog

Changes in this fork (mchowning/pi-claude-bridge) that are not upstream. Upstream's `CHANGELOG.md` is kept identical to theirs so merges never conflict on it.

## UNRELEASED

- **Add: review threads start from main's Claude Code session (`CLAUDE_BRIDGE_FORK_FROM`)** — a plannotator thread process adopts the saved session state of the pi session that owns the named CC session, so its first turn forks main's session at the last cut and reads main's history from the prompt cache; `Symbol.for("pi-claude-bridge.session")` publishes `{ sessionId, cursor }` for the thread runner. Covered by `tests/unit-fork-from.mjs`.
- **Tests: cache-flow matrix** — `tests/cache-flows.mjs` and `tests/CACHE-FLOWS.md` drive restart, reload, abort, rewind, compact and thread flows against a fake Anthropic server or live Haiku and check each flow's sync path and cache.
- **Remove: session pointer, `/reload` handoff and cwd guard** — superseded by upstream's persisted session state, shared session registry and `cwdChanged` check (#222).
