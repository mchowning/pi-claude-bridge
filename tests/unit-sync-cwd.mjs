/**
 * A Claude Code session lives under the project dir of the cwd it was written in, and CC
 * resolves `resume` under the current cwd. So a pi session's mirror, or a prepared fork copy,
 * from another cwd must never be resumed or preserved: the sync rebuilds instead.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, deleteSession, getSessionPath } from "cc-session-io";

const { __test } = await import("../src/index.js");
const PI = "pi-main";
const now = Date.now();
const history = [
	{ role: "user", content: "Hi", timestamp: now },
	{ role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: now },
];

function seeded(cwd) {
	const sessionId = randomUUID();
	const session = createSession({ sessionId, projectPath: cwd });
	session.importMessages([
		{ role: "user", content: "Hi" },
		{ role: "assistant", content: [{ type: "text", text: "Hello." }] },
	]);
	session.save();
	return sessionId;
}

describe("syncSharedSession across a cwd change", () => {
	const dirs = [];
	const sessions = [];
	const dir = () => {
		const d = mkdtempSync(join(tmpdir(), "sync-cwd-"));
		dirs.push(d);
		return d;
	};
	afterEach(() => {
		__test.resetSharedSession();
		for (const [id, cwd] of sessions.splice(0)) deleteSession(id, cwd);
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("does not resume a mirror written in another cwd", () => {
		const [a, b] = [dir(), dir()];
		const sessionId = seeded(a);
		sessions.push([sessionId, a]);
		__test.setSharedSession(PI, { sessionId, cursor: 2, cwd: a });

		const result = __test.syncSharedSession([...history, { role: "user", content: "Next", timestamp: now }], b, undefined, undefined, PI);
		if (result.sessionId) sessions.push([result.sessionId, b]);

		// REBUILD may keep the id; what REUSE never does is write the session under the new cwd.
		assert.ok(result.sessionId, "the turn runs on a rebuilt session");
		assert.ok(existsSync(getSessionPath(result.sessionId, b)), "the history was rebuilt under the new cwd, not resumed from the old one");
	});

	it("does not preserve a mirror from another cwd when the history is shorter", () => {
		const [a, b] = [dir(), dir()];
		__test.setSharedSession(PI, { sessionId: randomUUID(), cursor: 6, cwd: a });

		const result = __test.syncSharedSession([...history, { role: "user", content: "Next", timestamp: now }], b, undefined, undefined, PI);
		if (result.sessionId) sessions.push([result.sessionId, b]);

		assert.notEqual(result.preserveSharedSession, true, "a mirror from another cwd is not worth preserving");
	});

	it("does not adopt a fork copy prepared under another cwd", async () => {
		const [a, b] = [dir(), dir()];
		const source = seeded(a);
		sessions.push([source, a]);
		const forkedId = await __test.prepareForkFrom(source, a, PI);
		sessions.push([forkedId, a]);

		const result = __test.syncSharedSession([...history, { role: "user", content: "Next", timestamp: now }], b, undefined, undefined, PI);
		if (result.sessionId) sessions.push([result.sessionId, b]);

		assert.notEqual(result.sessionId, forkedId, "a copy under another cwd must not be adopted");
	});
});
