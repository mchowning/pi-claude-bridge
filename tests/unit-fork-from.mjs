/**
 * A process started with CLAUDE_BRIDGE_FORK_FROM (a plannotator review thread) starts
 * from the saved state of the pi session that owns that Claude Code session, so its first
 * turn forks main's CC session at the last cut and reads main's history from the prompt
 * cache. Every process publishes its sessions on a global so the thread runner can decide
 * whether a fork can start from main's session.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "cc-session-io";
import { stateFor } from "./lib/session-state.mjs";
import { saveSessionState } from "../src/session-store.js";

const { __test } = await import("../src/index.js");
const SESSION_KEY = Symbol.for("pi-claude-bridge.session");
const MAIN = "pi-main";
const FORK = "pi-thread";
const user = (content) => ({ role: "user", content, timestamp: 1 });
const say = (text) => ({ role: "assistant", content: [{ type: "text", text }], provider: "claude-bridge", timestamp: 1 });
const history = [user("Read the plan."), say("Friday ship date.")];

let cwd;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "fork-from-"));
	__test.resetSharedSession();
});
afterEach(() => {
	__test.resetSharedSession();
	rmSync(cwd, { recursive: true, force: true });
});

/** Main's CC session on disk and its saved state, as after a finished main turn. */
function seedMain() {
	const session = createSession({ projectPath: cwd, model: "sonnet" });
	const state = stateFor(session, history, "sonnet");
	session.save();
	saveSessionState(MAIN, state);
	return { session, state };
}

describe("published session", () => {
	it("reports a pi session's Claude Code session id and how many pi messages it covers, or null", () => {
		assert.equal(globalThis[SESSION_KEY](MAIN), null);
		const { state } = seedMain();
		__test.setSharedSession(MAIN, state);
		assert.deepEqual(globalThis[SESSION_KEY](MAIN), { sessionId: state.ccSessionId, cursor: 2 });
		assert.equal(globalThis[SESSION_KEY]("pi-other"), null, "another pi session has none");
	});

	it("reads a restarted main's saved state", () => {
		const { state } = seedMain();
		assert.deepEqual(globalThis[SESSION_KEY](MAIN), { sessionId: state.ccSessionId, cursor: 2 });
	});
});

describe("fork from another session", () => {
	it("forks main's CC session at its last cut on the first turn and leaves main's file alone", () => {
		const { session } = seedMain();
		const mainBytes = readFileSync(session.jsonlPath, "utf8");

		assert.equal(__test.adoptForkFrom(session.sessionId, FORK), true);
		const result = __test.syncSharedSession([...history, user("You are answering a review comment.")], cwd, undefined, "sonnet", FORK);

		assert.equal(result.sessionId, session.sessionId, "resumes main's session");
		assert.ok(result.forkAt, "as a fork at a cut, not a plain resume that would append to main's file");
		assert.notEqual(result.targetSessionId, session.sessionId);
		assert.equal(readFileSync(session.jsonlPath, "utf8"), mainBytes);
		assert.equal(__test.getSharedSession(MAIN).ccSessionId, session.sessionId, "main keeps its own session");
	});

	it("does nothing when the fork already has state (a reopened thread)", () => {
		const { session, state } = seedMain();
		__test.setSharedSession(FORK, { ...state, ccSessionId: "thread-own" });
		assert.equal(__test.adoptForkFrom(session.sessionId, FORK), false);
		assert.equal(__test.getSharedSession(FORK).ccSessionId, "thread-own");
	});

	it("does nothing when no saved state names the source session", () => {
		seedMain();
		assert.equal(__test.adoptForkFrom("no-such-session", FORK), false);
		assert.equal(__test.getSharedSession(FORK), null);
	});
});
