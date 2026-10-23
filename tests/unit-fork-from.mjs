/**
 * A process started with CLAUDE_BRIDGE_FORK_FROM begins from a forkSession copy of
 * another process's Claude Code session, and every process publishes its own session
 * on a global so a parent can decide whether a fork can reuse it.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, deleteSession, openSession } from "cc-session-io";

const { __test } = await import("../src/index.js");
const SESSION_KEY = Symbol.for("pi-claude-bridge.session");
const PI = "pi-main";

describe("published session", () => {
	afterEach(() => __test.resetSharedSession());

	it("reports a pi session's Claude Code session id and cursor, or null before its first turn", () => {
		assert.equal(globalThis[SESSION_KEY](PI), null);
		__test.setSharedSession(PI, { sessionId: "abc", cursor: 4, cwd: "/tmp" });
		assert.deepEqual(globalThis[SESSION_KEY](PI), { sessionId: "abc", cursor: 4 });
		assert.equal(globalThis[SESSION_KEY]("pi-other"), null, "another pi session has none");
	});

	it("reports null while the session is due for a rebuild, since its file no longer matches pi", () => {
		__test.setSharedSession(PI, { sessionId: "abc", cursor: 4, cwd: "/tmp", needsRebuild: true });
		assert.equal(globalThis[SESSION_KEY](PI), null);
	});
});

describe("fork from another session", () => {
	afterEach(() => __test.resetSharedSession());

	it("resumes a copy of the source session on the first turn and leaves the source alone", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "fork-from-"));
		const source = createSession({ projectPath: cwd });
		source.importMessages([
			{ role: "user", content: "Read the plan." },
			{ role: "assistant", content: [{ type: "text", text: "Friday ship date." }] },
		]);
		source.save();
		const sourceBytes = readFileSync(source.jsonlPath, "utf8");
		let forkedId;
		try {
			forkedId = await __test.prepareForkFrom(source.sessionId, cwd, PI);
			assert.notEqual(forkedId, source.sessionId);

			const result = __test.syncSharedSession([
				{ role: "user", content: "Read the plan.", timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Friday ship date." }], timestamp: Date.now() },
				{ role: "user", content: "You are answering a review comment.", timestamp: Date.now() },
			], cwd, undefined, undefined, PI);

			assert.equal(result.sessionId, forkedId, "the first turn resumes the copy, not a rebuild");
			assert.deepEqual(__test.getSharedSession(PI), { sessionId: forkedId, cursor: 2, cwd, piSessionId: PI });
			assert.equal(readFileSync(source.jsonlPath, "utf8"), sourceBytes, "the source session is untouched");
			const copy = openSession({ sessionId: forkedId, projectPath: cwd });
			assert.deepEqual(
				copy.messages.map((m) => m.type),
				["user", "assistant"],
				"the copy carries the source's history",
			);
		} finally {
			deleteSession(source.sessionId, cwd);
			if (forkedId) deleteSession(forkedId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("leaves the copy for the pi session that prepared it; another session in the process does not take it", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "fork-from-owner-"));
		const source = createSession({ projectPath: cwd });
		source.importMessages([
			{ role: "user", content: "Hi" },
			{ role: "assistant", content: [{ type: "text", text: "Hello." }] },
		]);
		source.save();
		let forkedId;
		const history = [
			{ role: "user", content: "Hi", timestamp: Date.now() },
			{ role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: Date.now() },
			{ role: "user", content: "Next", timestamp: Date.now() },
		];
		try {
			forkedId = await __test.prepareForkFrom(source.sessionId, cwd, PI);
			const child = __test.syncSharedSession(history, cwd, undefined, undefined, "pi-subagent");
			assert.notEqual(child.sessionId, forkedId, "a subagent's first turn does not take the fork copy");
			const owner = __test.syncSharedSession(history, cwd, undefined, undefined, PI);
			assert.equal(owner.sessionId, forkedId, "the preparing session still gets it");
		} finally {
			deleteSession(source.sessionId, cwd);
			if (forkedId) deleteSession(forkedId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("adopts the copy only once; later turns follow the normal sync rules", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "fork-from-once-"));
		const source = createSession({ projectPath: cwd });
		source.importMessages([
			{ role: "user", content: "Hi" },
			{ role: "assistant", content: [{ type: "text", text: "Hello." }] },
		]);
		source.save();
		let forkedId;
		try {
			forkedId = await __test.prepareForkFrom(source.sessionId, cwd, PI);
			__test.syncSharedSession([
				{ role: "user", content: "Hi", timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: Date.now() },
				{ role: "user", content: "Next", timestamp: Date.now() },
			], cwd, undefined, undefined, PI);
			__test.resetSharedSession(PI);
			const second = __test.syncSharedSession([
				{ role: "user", content: "Only one", timestamp: Date.now() },
			], cwd, undefined, undefined, PI);
			assert.equal(second.sessionId, null, "no pending fork is left to adopt");
		} finally {
			deleteSession(source.sessionId, cwd);
			if (forkedId) deleteSession(forkedId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
