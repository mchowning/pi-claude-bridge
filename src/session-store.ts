import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { InvalidRecordingError, validateRecording, type SessionState } from "./session-sync.js";

const FORMAT_VERSION = 1;

function sessionsDir(): string {
	return join(getAgentDir(), "claude-bridge", "sessions");
}

function stateFileName(piSessionId: string): string {
	const hash = createHash("sha256").update(piSessionId, "utf16le").digest("hex");
	return `s-${hash}.json`;
}

function statePath(piSessionId: string): string {
	return join(sessionsDir(), stateFileName(piSessionId));
}

function reject(onReject: (message: string) => void, reason: string): null {
	onReject(`Rejected persisted Claude session state: ${reason}`);
	return null;
}

export function loadSessionState(piSessionId: string, onReject: (message: string) => void): SessionState | null {
	let text: string;
	try {
		text = readFileSync(statePath(piSessionId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	return parseSessionState(text, onReject);
}

/** The saved state of whichever pi session last ran on `ccSessionId`, for a fork
 *  process that knows only that Claude Code session (CLAUDE_BRIDGE_FORK_FROM). */
export function loadSessionStateByCcSession(ccSessionId: string, onReject: (message: string) => void): SessionState | null {
	let files: string[];
	try {
		files = readdirSync(sessionsDir()).filter((file) => file.startsWith("s-") && file.endsWith(".json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	for (const file of files) {
		const text = readFileSync(join(sessionsDir(), file), "utf8");
		// Cheap filter before parsing: most files name another session.
		if (!text.includes(ccSessionId)) continue;
		const state = parseSessionState(text, onReject);
		if (state?.ccSessionId === ccSessionId) return state;
	}
	return null;
}

function parseSessionState(text: string, onReject: (message: string) => void): SessionState | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return reject(onReject, "invalid JSON");
		throw error;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return reject(onReject, "expected an object");
	const stored = value as Record<string, unknown>;
	if (!("version" in stored)) return reject(onReject, "missing version");
	if (stored.version !== FORMAT_VERSION) return reject(onReject, `unsupported version; expected ${FORMAT_VERSION}`);
	for (const key of ["ccSessionId", "cwd", "model", "digests", "uuids", "cuttable"] as const) {
		if (!(key in stored)) return reject(onReject, `missing ${key}`);
	}
	for (const key of ["ccSessionId", "cwd", "model"] as const) {
		if (typeof stored[key] !== "string") return reject(onReject, `${key} must be a string`);
		if (stored[key] === "") return reject(onReject, `${key} must not be empty`);
	}
	if (!Array.isArray(stored.digests) || !Array.isArray(stored.uuids) || !Array.isArray(stored.cuttable)) {
		return reject(onReject, "digests, uuids, and cuttable must be arrays");
	}
	try {
		validateRecording({ digests: stored.digests as string[], uuids: stored.uuids as (string | null)[], cuttable: stored.cuttable as boolean[] });
	} catch (error) {
		if (error instanceof InvalidRecordingError) return reject(onReject, error.message);
		throw error;
	}
	return {
		ccSessionId: stored.ccSessionId as string,
		cwd: stored.cwd as string,
		model: stored.model as string,
		digests: stored.digests as string[],
		uuids: stored.uuids as (string | null)[],
		cuttable: stored.cuttable as boolean[],
		dirtyTail: true,
	};
}

export function saveSessionState(piSessionId: string, state: SessionState): void {
	for (const key of ["ccSessionId", "cwd", "model"] as const) {
		if (typeof state[key] !== "string" || state[key] === "") throw new Error(`${key} must be a non-empty string`);
	}
	validateRecording(state);
	const dir = sessionsDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const path = join(dir, stateFileName(piSessionId));
	const tempPath = join(dir, `.${randomUUID()}.tmp`);
	const contents = JSON.stringify({
		version: FORMAT_VERSION,
		ccSessionId: state.ccSessionId,
		cwd: state.cwd,
		model: state.model,
		digests: state.digests,
		uuids: state.uuids,
		cuttable: state.cuttable,
	});
	writeFileSync(tempPath, contents, { flag: "wx", mode: 0o600 });
	chmodSync(tempPath, 0o600);
	renameSync(tempPath, path);
}

export function deleteSessionState(piSessionId: string): void {
	rmSync(statePath(piSessionId), { force: true });
}
