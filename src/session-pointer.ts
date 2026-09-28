// A pi session's link to the Claude Code session its turns run on, written into pi's session
// file after each good bridge run so a restarted pi can resume that CC session instead of
// rebuilding it (a full prompt-cache rewrite), and a review-thread fork started before main's
// first turn has a session to fork from.
//
// Adoption relies on pi's session file being an append-only log whose loaded leaf is its last
// entry: whatever happened after the pointer is an entry after it. Every bridge query first
// appends pi's user message, and every other change to the model's context is an entry too, so
// the pointer is safe to adopt only while nothing after it, on any branch, touches context.

export const POINTER_TYPE = "claude-bridge-session";

export type SessionPointer = {
	/** pi's session id when written; a fork or clone of the session file gets a new one. */
	piSessionId: string;
	ccSessionId: string;
	/** The bridge's cursor: non-system pi messages the CC session holds before the final reply. */
	cursor: number;
	cwd: string;
};

/** A pi session entry, typed loosely on purpose: an entry type pi adds later must still reject. */
type Entry = { type: string; id: string; customType?: string; data?: unknown; message?: { role?: string } };

/** Entry types that never change what the model sees. Anything else, known or not, rejects. */
const HARMLESS = new Set(["label", "session_info", "usage", "model_change", "thinking_level_change", "custom"]);

function harmless(entry: Entry): boolean {
	if (entry.type === "message") return entry.message?.role === "system";
	return HARMLESS.has(entry.type);
}

const isPointer = (entry: Entry): entry is Entry & { data: SessionPointer } =>
	entry.type === "custom" && entry.customType === POINTER_TYPE && typeof entry.data === "object" && entry.data !== null;

export type Adoption = { pointer: SessionPointer; reason?: undefined } | { pointer?: undefined; reason: string };

/**
 * The pointer to adopt, or why there is none. `entries` is the whole file in append order,
 * `branch` the loaded branch root → leaf, `contextRoles` the roles of pi's projected context
 * without system messages.
 */
export function adoptablePointer(
	session: { entries: readonly Entry[]; branch: readonly Entry[]; contextRoles: readonly string[] },
	here: { piSessionId: string; cwd: string; ccFileExists(ccSessionId: string): boolean },
): Adoption {
	const at = session.entries.reduce((last, e, i) => (isPointer(e) ? i : last), -1);
	if (at < 0) return { reason: "no pointer in the session" };
	const entry = session.entries[at] as Entry & { data: SessionPointer };
	const pointer = entry.data;
	if (!session.branch.some((e) => e.id === entry.id)) return { reason: "the latest pointer is not on the loaded branch" };
	const after = session.entries.slice(at + 1).find((e) => !harmless(e));
	if (after) return { reason: `a ${after.type}${after.message?.role ? ` (${after.message.role})` : ""} entry follows the pointer` };
	if (pointer.piSessionId !== here.piSessionId) return { reason: "the pointer belongs to another pi session" };
	if (pointer.cwd !== here.cwd) return { reason: `the pointer was written in another cwd (${pointer.cwd})` };
	if (!here.ccFileExists(pointer.ccSessionId)) return { reason: `Claude Code session ${pointer.ccSessionId.slice(0, 8)} is gone` };
	const beyond = session.contextRoles.length - pointer.cursor;
	const covered = beyond === 0 || (beyond === 1 && session.contextRoles.at(-1) === "assistant");
	if (!covered) return { reason: `cursor ${pointer.cursor} does not match pi's ${session.contextRoles.length} messages` };
	return { pointer: { piSessionId: pointer.piSessionId, ccSessionId: pointer.ccSessionId, cursor: pointer.cursor, cwd: pointer.cwd } };
}
