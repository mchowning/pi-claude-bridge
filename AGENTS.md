# Agent Guidelines

## Restricted Actions

Do **not** interact with the public without explicit permission. For example, do not open PRs or comment on github issues unless I say so.

## Claims about how Claude Code behaves

`~/.claude/projects/**` is **not** evidence of what CC does -- the bridge writes there too, and CC re-serializes imported records under synthetic ids. Split by provenance (CC-live: real `requestId`/`promptId`; ours: `msg_syn_*`/`req_syn_*`) and regroup by `message.id` (`diag/audit-transcripts.mjs` does both).

Better: prove it with a live probe. `tests/int-cc-contracts.mjs` pins undocumented behavior against the installed CC/SDK; `diag/capture-proxy.mjs` captures request bodies. `claude-code-rip/` is mechanism only, never current behavior. Before reverse-engineering an SDK option, grep `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` first.

Validate any *rate* from the debug log on a case whose answer you know. Bin by era before comparing groups -- a window straddling the onset credits whatever else changed.

Five wrong conclusions across two sessions came from skipping the above.

## Cache-flow matrix

Any change to session sync (`syncSharedSession`, the completion capture, rebuild marks),
fork-from, the `/reload` handoff or the session pointer (`src/session-pointer.ts`): run the
cache-flow matrix in `tests/CACHE-FLOWS.md` — layers 1 and 2 before calling the change done,
layer 3 (live) before pushing it — and add a row for any new flow that keeps or drops a CC
session. Run the live layer on Haiku only.

## Changelog

Maintain an entry in the `## UNRELEASED` section at the top of `CHANGELOG.md` for every significant change, using the existing format:

```
- **Tag: summary** — detail
```

Do not add changelog entries for docs-only changes. Combine multiple UNRELEASED entries about the same feature into one.

Tags: `Add`, `Fix`, `Refactor`, `Tests`, `Bump`, `Deprecate`, `Remove`.

**This is a fork:** write entries for this fork's changes in `CHANGELOG.fork.md`, not `CHANGELOG.md`. `CHANGELOG.md` mirrors upstream (`origin`) so merges don't conflict on it; never edit it here.

## Release

No build step — the package ships `src` TypeScript as-is (see `files` in `package.json`). To cut version `X.Y.Z`:

1. **Changelog** — rename the `## UNRELEASED` section to `## X.Y.Z — YYYY-MM-DD`.
2. **Bump** — set `version` to `X.Y.Z` in `package.json`.
3. **Commit** — `git commit -m "Release X.Y.Z"` (changelog + package.json only).
4. **Tag** — `git tag vX.Y.Z` (note the `v` prefix).
5. **Push commit and tag together** — `git push --follow-tags`.
6. **Publish** — `npm login` and `npm publish`.

## Tests

Smoke tests typically need to run outside a sandbox because they access local pi/Claude settings and auth state.
