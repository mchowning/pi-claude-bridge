/**
 * The bridge writes a pointer to its Claude Code session into pi's session file after a good
 * run (agent_end), and a restarted pi adopts it (session_start) so main's first turn resumes
 * and a thread fork started before that turn has a session to fork from.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, deleteSession } from "cc-session-io";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { POINTER_TYPE } from "../src/session-pointer.js";

const { default: activate, __test } = await import("../src/index.js");
const LOOKUP = Symbol.for("pi-claude-bridge.session");
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text) => ({ role: "user", content: text, timestamp: Date.now() });
const reply = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], api: "claude-bridge", provider: "claude-bridge", model: "claude-haiku-4-5", usage, stopReason: "stop", timestamp: Date.now(), ...extra });

/** Activates the bridge against a mock pi that appends entries to `sm` like pi.appendEntry does. */
function bridge(sm) {
	const handlers = new Map();
	const appended = [];
	activate({
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerProvider: () => {},
		registerTool: () => {},
		appendEntry: (customType, data) => {
			appended.push({ customType, data });
			sm.appendCustomEntry(customType, data);
		},
	});
	const ctx = { sessionManager: sm, ui: undefined, mode: "rpc", modelRegistry: { getProvider: () => true }, cwd: process.cwd(), getSystemPrompt: () => "" };
	const emit = async (event, payload) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	return { emit, pointers: () => appended.filter((a) => a.customType === POINTER_TYPE).map((a) => a.data) };
}

/** A temp cwd (the bridge keys CC sessions by process.cwd()) and cleanup for CC sessions made there. */
function workspace() {
	const previous = process.cwd();
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pointer-wiring-")));
	process.chdir(dir);
	const made = [];
	return {
		cwd: process.cwd(),
		seed(messages) {
			const session = createSession({ sessionId: randomUUID(), projectPath: process.cwd() });
			session.importMessages(messages);
			session.save();
			made.push(session.sessionId);
			return session.sessionId;
		},
		track: (id) => id && made.push(id),
		done() {
			for (const id of made) deleteSession(id, process.cwd());
			process.chdir(previous);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("pointer written at agent_end", () => {
	afterEach(() => __test.resetSharedSession());

	it("records the pi session's Claude Code session after a good bridge run", async () => {
		const sm = SessionManager.inMemory("/work");
		sm.appendMessage(user("q1"));
		sm.appendMessage(reply("a1"));
		__test.setSharedSession(sm.getSessionId(), { sessionId: "cc-1", cursor: 1, cwd: "/work" });
		const b = bridge(sm);
		await b.emit("agent_end", { messages: [reply("a1")] });
		assert.deepEqual(b.pointers(), [{ piSessionId: sm.getSessionId(), ccSessionId: "cc-1", cursor: 1, cwd: "/work" }]);
	});

	for (const [what, state, last] of [
		["the session is due for a rebuild", { needsRebuild: true }, reply("a1")],
		["an abort left a possible late writer", { needsRebuild: true, forceRotate: true }, reply("a1")],
		["the run ended in an error", {}, reply("a1", { stopReason: "error" })],
		["the run was aborted", {}, reply("a1", { stopReason: "aborted" })],
		["another provider answered", {}, reply("a1", { provider: "anthropic", api: "anthropic-messages" })],
	]) {
		it(`writes nothing when ${what}`, async () => {
			const sm = SessionManager.inMemory("/work");
			sm.appendMessage(user("q1"));
			sm.appendMessage(last);
			__test.setSharedSession(sm.getSessionId(), { sessionId: "cc-1", cursor: 1, cwd: "/work", ...state });
			const b = bridge(sm);
			await b.emit("agent_end", { messages: [last] });
			assert.deepEqual(b.pointers(), []);
		});
	}

	it("writes nothing before the pi session has a Claude Code session", async () => {
		const sm = SessionManager.inMemory("/work");
		sm.appendMessage(user("q1"));
		sm.appendMessage(reply("a1"));
		const b = bridge(sm);
		await b.emit("agent_end", { messages: [reply("a1")] });
		assert.deepEqual(b.pointers(), []);
	});

	it("writes nothing and forces a rebuild when a context_edit since the last pointer may not have reached Claude Code", async () => {
		const sm = SessionManager.inMemory("/work");
		sm.appendMessage(user("q1"));
		const a1 = sm.appendMessage(reply("a1"));
		const id = sm.getSessionId();
		sm.appendCustomEntry(POINTER_TYPE, { piSessionId: id, ccSessionId: "cc-1", cursor: 1, cwd: "/work" });
		sm.appendMessage(user("q2"));
		sm.appendContextEdit(a1, { content: [{ type: "text", text: "edited" }] });
		sm.appendMessage(reply("a2"));
		__test.setSharedSession(id, { sessionId: "cc-1", cursor: 3, cwd: "/work" });
		const b = bridge(sm);
		await b.emit("agent_end", { messages: [reply("a2")] });
		assert.deepEqual(b.pointers(), []);
		assert.equal(__test.getSharedSession(id)?.needsRebuild, true);
	});

	it("writes a pointer again once a rebuild has taken the edit into Claude Code", async () => {
		const ws = workspace();
		try {
			const sm = SessionManager.inMemory(ws.cwd);
			const id = sm.getSessionId();
			const u1 = user("q1"), a1 = reply("a1"), u2 = user("q2"), a2 = reply("a2"), u3 = user("q3");
			sm.appendMessage(u1);
			const a1Id = sm.appendMessage(a1);
			sm.appendMessage(u2);
			sm.appendContextEdit(a1Id, { content: [{ type: "text", text: "edited" }] });
			sm.appendMessage(a2);
			__test.setSharedSession(id, { sessionId: randomUUID(), cursor: 3, cwd: ws.cwd, needsRebuild: true });
			const b = bridge(sm);
			// The next turn rebuilds from pi's (edited) history.
			sm.appendMessage(u3);
			await b.emit("turn_start", {});
			const rebuilt = __test.syncSharedSession([u1, a1, u2, a2, u3], ws.cwd, undefined, undefined, id);
			ws.track(rebuilt.sessionId);
			sm.appendMessage(reply("a3"));
			await b.emit("agent_end", { messages: [reply("a3")] });
			assert.equal(b.pointers().length, 1, "the rebuilt session is certified");
			assert.equal(b.pointers()[0].ccSessionId, rebuilt.sessionId);
		} finally {
			ws.done();
		}
	});
});

describe("pointer adopted at session_start", () => {
	afterEach(() => {
		__test.resetSharedSession();
		delete process.env.CLAUDE_BRIDGE_FORK_FROM;
	});

	/** A restarted pi: a session file holding two turns and the pointer the last good run wrote. */
	function restarted(ws) {
		const sm = SessionManager.inMemory(ws.cwd);
		const u1 = user("q1"), a1 = reply("a1");
		sm.appendMessage(u1);
		sm.appendMessage(a1);
		const ccSessionId = ws.seed([{ role: "user", content: "q1" }, { role: "assistant", content: [{ type: "text", text: "a1" }] }]);
		sm.appendCustomEntry(POINTER_TYPE, { piSessionId: sm.getSessionId(), ccSessionId, cursor: 1, cwd: ws.cwd });
		return { sm, ccSessionId, history: [u1, a1] };
	}

	for (const reason of ["startup", "resume"]) {
		it(`adopts the pointer on ${reason}, publishes it, and the first turn resumes`, async () => {
			const ws = workspace();
			try {
				const { sm, ccSessionId, history } = restarted(ws);
				await bridge(sm).emit("session_start", { reason });
				assert.deepEqual(globalThis[LOOKUP](sm.getSessionId()), { sessionId: ccSessionId, cursor: 1 });
				const first = __test.syncSharedSession([...history, user("q2")], ws.cwd, undefined, undefined, sm.getSessionId());
				assert.equal(first.sessionId, ccSessionId, "REUSE, not a rebuild");
			} finally {
				ws.done();
			}
		});
	}

	it("adopts nothing in a fresh thread fork, which starts from CLAUDE_BRIDGE_FORK_FROM", async () => {
		const ws = workspace();
		try {
			const { sm } = restarted(ws);
			process.env.CLAUDE_BRIDGE_FORK_FROM = "cc-main";
			await bridge(sm).emit("session_start", { reason: "startup" });
			assert.equal(__test.getSharedSession(sm.getSessionId()), null);
		} finally {
			ws.done();
		}
	});
});
