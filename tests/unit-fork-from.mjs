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

describe("published session", () => {
	afterEach(() => __test.resetSharedSession());

	it("reports the shared session id and cursor, or null before the first turn", () => {
		assert.equal(globalThis[SESSION_KEY], null);
		__test.setSharedSession({ sessionId: "abc", cursor: 4, cwd: "/tmp" });
		assert.deepEqual(globalThis[SESSION_KEY], { sessionId: "abc", cursor: 4 });
	});

	it("reports null while the session is due for a rebuild, since its file no longer matches pi", () => {
		__test.setSharedSession({ sessionId: "abc", cursor: 4, cwd: "/tmp", needsRebuild: true });
		assert.equal(globalThis[SESSION_KEY], null);
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
			forkedId = await __test.prepareForkFrom(source.sessionId, cwd);
			assert.notEqual(forkedId, source.sessionId);

			const result = __test.syncSharedSession([
				{ role: "user", content: "Read the plan.", timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Friday ship date." }], timestamp: Date.now() },
				{ role: "user", content: "You are answering a review comment.", timestamp: Date.now() },
			], cwd);

			assert.equal(result.sessionId, forkedId, "the first turn resumes the copy, not a rebuild");
			assert.deepEqual(__test.getSharedSession(), { sessionId: forkedId, cursor: 2, cwd });
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
			forkedId = await __test.prepareForkFrom(source.sessionId, cwd);
			__test.syncSharedSession([
				{ role: "user", content: "Hi", timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: Date.now() },
				{ role: "user", content: "Next", timestamp: Date.now() },
			], cwd);
			__test.resetSharedSession();
			const second = __test.syncSharedSession([
				{ role: "user", content: "Only one", timestamp: Date.now() },
			], cwd);
			assert.equal(second.sessionId, null, "no pending fork is left to adopt");
		} finally {
			deleteSession(source.sessionId, cwd);
			if (forkedId) deleteSession(forkedId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
