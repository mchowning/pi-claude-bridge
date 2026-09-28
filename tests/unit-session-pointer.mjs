/**
 * After a restart the bridge may resume the Claude Code session its last good run recorded in
 * pi's session file, but only when nothing since could have made that CC session differ from
 * pi's history. Branches here are built with pi's own SessionManager, so their shapes are pi's.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { POINTER_TYPE, adoptablePointer } from "../src/session-pointer.js";

const CWD = "/work";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text) => ({ role: "user", content: text, timestamp: Date.now() });
const reply = (text) => ({ role: "assistant", content: [{ type: "text", text }], api: "claude-bridge", provider: "claude-bridge", model: "claude-haiku-4-5", usage, stopReason: "stop", timestamp: Date.now() });

/** A pi session with `turns` user/reply pairs and a pointer after the last reply, as agent_end writes it. */
function session(turns = 2) {
	const sm = SessionManager.inMemory(CWD);
	const ids = [];
	for (let i = 1; i <= turns; i++) {
		ids.push(sm.appendMessage(user(`q${i}`)));
		ids.push(sm.appendMessage(reply(`a${i}`)));
	}
	const pointer = (cursor = turns * 2 - 1, extra = {}) =>
		sm.appendCustomEntry(POINTER_TYPE, { piSessionId: sm.getSessionId(), ccSessionId: "cc-1", cursor, cwd: CWD, ...extra });
	return { sm, ids, pointer };
}

const contextRoles = (sm) => sm.buildSessionProjection().messages.map((m) => m.role).filter((r) => r !== "system");
const decide = (sm, overrides = {}) =>
	adoptablePointer(
		{ entries: sm.getEntries(), branch: sm.getBranch(), contextRoles: contextRoles(sm), ...overrides.session },
		{ piSessionId: sm.getSessionId(), cwd: CWD, ccFileExists: () => true, ...overrides.here },
	);

describe("adoptablePointer", () => {
	it("adopts the pointer its last good run wrote, the final reply after the cursor", () => {
		const { sm, pointer } = session();
		pointer();
		assert.deepEqual(decide(sm).pointer, { piSessionId: sm.getSessionId(), ccSessionId: "cc-1", cursor: 3, cwd: CWD });
	});

	it("adopts a pointer whose cursor already covers the final reply", () => {
		const { sm, pointer } = session();
		pointer(4);
		assert.ok(decide(sm).pointer);
	});

	it("adopts when only harmless entries follow: label, name, model and thinking changes, other extensions' state, a system entry", () => {
		const { sm, ids, pointer } = session();
		pointer();
		sm.appendLabelChange(ids[1], "keep");
		sm.appendSessionInfo("renamed");
		sm.appendModelChange("claude-bridge", "claude-opus-5-5");
		sm.appendThinkingLevelChange("high");
		sm.appendCustomEntry("other-extension", { any: "state" });
		sm.appendMessage({ role: "system", content: "", sections: { tools: "<tools/>" }, timestamp: Date.now() });
		assert.ok(decide(sm).pointer, decide(sm).reason);
	});

	for (const [what, add] of [
		["a user message", (sm) => sm.appendMessage(user("q3"))],
		["an assistant message", (sm) => sm.appendMessage(reply("stray"))],
		["a custom_message", (sm) => sm.appendCustomMessageEntry("note", "context", false)],
		["a context_edit", (sm, ids) => sm.appendContextEdit(ids[1], { content: [{ type: "text", text: "edited" }] })],
		["a compaction", (sm, ids) => sm.appendCompaction("summary", ids[2], 100)],
	]) {
		it(`rejects the pointer when ${what} follows it`, () => {
			const { sm, ids, pointer } = session();
			pointer();
			add(sm, ids);
			assert.equal(decide(sm).pointer, undefined);
		});
	}

	it("rejects the pointer when a rewind with a summary follows it", () => {
		const { sm, ids, pointer } = session();
		pointer();
		sm.branchWithSummary(ids[1], "what the abandoned branch did");
		assert.equal(decide(sm).pointer, undefined);
	});

	it("rejects an entry type it does not know", () => {
		const { sm, pointer } = session();
		pointer();
		const entries = [...sm.getEntries(), { type: "future_kind", id: "x", parentId: null, timestamp: "t" }];
		assert.equal(decide(sm, { session: { entries } }).pointer, undefined);
	});

	it("rejects a pointer another pi session wrote, as in a fork's copy of main's branch", () => {
		const { sm, pointer } = session();
		pointer();
		assert.equal(decide(sm, { here: { piSessionId: "a-fork" } }).pointer, undefined);
	});

	it("rejects a pointer written in another cwd", () => {
		const { sm, pointer } = session();
		pointer();
		assert.equal(decide(sm, { here: { cwd: "/elsewhere" } }).pointer, undefined);
	});

	it("rejects a pointer whose Claude Code session file is gone", () => {
		const { sm, pointer } = session();
		pointer();
		assert.equal(decide(sm, { here: { ccFileExists: () => false } }).pointer, undefined);
	});

	it("rejects a cursor ahead of pi's history", () => {
		const { sm, pointer } = session();
		pointer(9);
		assert.equal(decide(sm).pointer, undefined);
	});

	it("rejects a cursor more than the final reply behind", () => {
		const { sm, pointer } = session();
		pointer(1);
		assert.equal(decide(sm).pointer, undefined);
	});

	it("takes the latest pointer in the file", () => {
		const { sm, pointer } = session();
		pointer(3, { ccSessionId: "cc-old" });
		sm.appendMessage(user("q3"));
		sm.appendMessage(reply("a3"));
		pointer(5, { ccSessionId: "cc-new" });
		assert.equal(decide(sm).pointer?.ccSessionId, "cc-new");
	});

	it("rejects when the latest pointer is on an abandoned branch", () => {
		const { sm, ids, pointer } = session();
		pointer();
		sm.branch(ids[1]);
		sm.appendLabelChange(ids[1], "back here");
		assert.equal(decide(sm).pointer, undefined);
	});

	it("rejects an older pointer on the branch when a later turn on another branch used the same CC session", () => {
		const { sm, ids, pointer } = session(1);
		pointer(1);
		sm.appendMessage(user("q2"));
		sm.appendMessage(reply("a2"));
		pointer(3);
		// Rewind to the first reply without a summary, then any append lands on that branch.
		sm.branch(ids[1]);
		sm.appendLabelChange(ids[1], "rewound");
		assert.equal(decide(sm).pointer, undefined);
	});

	it("rejects the latest pointer when a turn on another branch came after it, even back on the pointer's branch", () => {
		const { sm, ids, pointer } = session();
		const at = pointer();
		// Rewind, start a turn there that never finished (no newer pointer), return, label.
		sm.branch(ids[1]);
		sm.appendMessage(user("a different question"));
		sm.branch(at);
		sm.appendLabelChange(ids[3], "back");
		assert.equal(decide(sm).pointer, undefined);
	});

	it("says why it rejected", () => {
		const { sm, pointer } = session();
		pointer();
		assert.match(decide(sm, { here: { cwd: "/elsewhere" } }).reason, /cwd/);
		assert.match(decide(SessionManager.inMemory(CWD)).reason, /no pointer/);
	});
});
