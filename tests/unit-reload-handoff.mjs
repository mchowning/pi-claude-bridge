/**
 * /reload re-evaluates this module, and the new instance starts with no shared session.
 * The Claude Code session file still matches pi's history, so the reloading instance
 * hands its session to the next one: main's next turn resumes instead of rebuilding,
 * and the published session a thread fork starts from survives the reload.
 *
 * Only a reload of the same pi session adopts it. Isolated subagents re-evaluate the
 * module in the same process too, and must never pick up the parent's session.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

const { default: activate, __test } = await import("../src/index.js");
const SESSION_KEY = Symbol.for("pi-claude-bridge.session");

function activateWithMockPi(activateFn) {
	const handlers = new Map();
	activateFn({
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerProvider: () => {},
		registerTool: () => {},
	});
	return (event, payload, ctx) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
}

const ctxFor = (sessionFile) => ({
	sessionManager: { getSessionFile: () => sessionFile },
	modelRegistry: { getProvider: () => true },
	ui: undefined,
	mode: "rpc",
});
const SESSION = { sessionId: "cc-main", cursor: 12, cwd: "/work" };

describe("reload handoff", () => {
	afterEach(() => __test.resetSharedSession());

	it("the reloaded instance resumes the same Claude Code session and publishes it", async () => {
		const emitOld = activateWithMockPi(activate);
		__test.setSharedSession(SESSION);
		emitOld("session_shutdown", { reason: "reload" }, ctxFor("/sessions/main.jsonl"));

		const fresh = await import("../src/index.js?reloaded");
		const emitNew = activateWithMockPi(fresh.default);
		emitNew("session_start", { reason: "reload" }, ctxFor("/sessions/main.jsonl"));

		assert.deepEqual(fresh.__test.getSharedSession(), SESSION);
		assert.deepEqual(globalThis[SESSION_KEY], { sessionId: "cc-main", cursor: 12 });
	});

	it("an instance that starts for any other reason does not adopt it", async () => {
		const emitOld = activateWithMockPi(activate);
		__test.setSharedSession(SESSION);
		emitOld("session_shutdown", { reason: "reload" }, ctxFor("/sessions/main.jsonl"));

		const child = await import("../src/index.js?isolated-subagent");
		activateWithMockPi(child.default)("session_start", { reason: "startup" }, ctxFor("/sessions/main.jsonl"));

		assert.equal(child.__test.getSharedSession(), null);
	});

	it("a reload of a different pi session does not adopt it", async () => {
		const emitOld = activateWithMockPi(activate);
		__test.setSharedSession(SESSION);
		emitOld("session_shutdown", { reason: "reload" }, ctxFor("/sessions/main.jsonl"));

		const other = await import("../src/index.js?other-session");
		activateWithMockPi(other.default)("session_start", { reason: "reload" }, ctxFor("/sessions/other.jsonl"));

		assert.equal(other.__test.getSharedSession(), null);
	});

	it("quitting hands nothing on", async () => {
		const emitOld = activateWithMockPi(activate);
		__test.setSharedSession(SESSION);
		emitOld("session_shutdown", { reason: "quit" }, ctxFor("/sessions/main.jsonl"));

		const next = await import("../src/index.js?after-quit");
		activateWithMockPi(next.default)("session_start", { reason: "reload" }, ctxFor("/sessions/main.jsonl"));

		assert.equal(next.__test.getSharedSession(), null);
	});
});
