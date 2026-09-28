#!/usr/bin/env node
/**
 * Cache-flow matrix, bridge-side rows (see tests/CACHE-FLOWS.md). Drives real pi + this
 * bridge + real Claude Code through each flow over RPC with a persistent session file, and
 * reports, for the first request after the flow's event: the sync path, the Claude Code
 * session it used, and the cache.
 *
 *   node --import tsx tests/cache-flows.mjs [--api fake|live] [--rows 1,4,5] [--record] [--out DIR]
 *
 * --api fake (default): a scripted local server (tests/lib/fake-anthropic.mjs), no model, no
 *   cost. Cache = whether the next request matches the previous one through its last
 *   breakpoint (tests/lib/cache-compare.mjs).
 * --api live: the real API on Haiku. Cache = next.cacheRead / (prev.cacheRead + prev.cacheWrite).
 * --record: report without failing on rows that miss their expectation (the "before" run).
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionPath } from "cc-session-io";
import { createRpcHarness } from "./lib/rpc-harness.mjs";
import { startFakeAnthropic } from "./lib/fake-anthropic.mjs";
import { comparePrefix } from "./lib/cache-compare.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, "fixtures/cache-flows-ext.ts");
const MODEL = "claude-bridge/claude-haiku-4-5";

const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const API = arg("api", "fake");
const RECORD = process.argv.includes("--record");
const ONLY = arg("rows", "")?.split(",").filter(Boolean);
const OUT = resolve(arg("out", join(HERE, "..", ".test-output", `cache-flows-${API}`)));
mkdirSync(OUT, { recursive: true });

const say = (...a) => console.log(...a); // eslint-disable-line no-console

// Prompts that make a live model do what the fake server does on its keywords.
// The first prompt of every flow carries ~6k tokens of filler. Tools and CC's system prompt
// are ~12k tokens of every request and survive a rebuild, so without a history of real size a
// rebuild still reads ~90% from cache and cannot be told from a resume.
const FILLER = `\n\nIgnore this filler, it only sets the history's size:\n${"the quick brown fox jumps over the lazy dog ".repeat(700)}`;
const P = {
	plain: (n) => `Reply with just: ok ${n}${n === 1 ? FILLER : ""}`,
	tool: "USE_TOOL: run `echo flows` with the bash tool, then reply with just: done",
	slow: "SLOW: count from 1 to 400, one number per line.",
};

/** One flow's environment: a cwd, a pi session file, a pi over RPC, and (fake) a server. */
async function flow(name, { cwd } = {}) {
	const root = mkdtempSync(join(tmpdir(), `cache-flows-${name}-`));
	const work = cwd ?? join(root, "work");
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, "a.txt"), "hello\n");
	const sessionFile = join(root, "session.jsonl");
	// A private pi agent dir: the user's settings stay out of the run, and a tiny
	// keepRecentTokens lets /compact work on a short session (as int-session-compact does).
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 50 } }));
	const api = API === "fake" ? await startFakeAnthropic({ out: join(OUT, name, "requests") }) : null;
	const env = { PI_CODING_AGENT_DIR: agentDir, ...(api
		? { ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "sk-ant-fake", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" }
		: {}) };
	let dir = work;
	const logs = [];
	const make = () => {
		const harness = createRpcHarness({ name: `cache-flows-${API}-${name}-${logs.length}`, sessionFile, cwd: dir, env, args: ["--model", MODEL, "-e", EXT], defaultTimeout: 120_000 });
		logs.push(harness.DEBUG_LOG);
		return harness;
	};
	let h = make();
	const ready = async () => {
		h.start();
		await h.send({ type: "get_state" }, 30_000);
	};
	await ready();
	const log = () => logs.flatMap((file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n") : []));
	const assistants = () =>
		existsSync(sessionFile)
			? readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
				.filter((e) => e.type === "message" && e.message.role === "assistant" && e.message.usage)
				.map((e) => ({ provider: e.message.provider, usage: e.message.usage }))
			: [];
	const f = {
		root, work, sessionFile, api,
		prompt: (text) => h.promptAndWait(text, 120_000),
		command: (text) => h.send({ type: "prompt", message: text }, 60_000),
		send: (cmd) => h.send(cmd, 120_000),
		harness: () => h,
		async restart({ cwd: nextCwd } = {}) {
			await h.stop();
			if (nextCwd) {
				dir = nextCwd;
				h = make();
			}
			await ready();
		},
		/** Remember where we are, so `observe` looks only at what follows. */
		mark() {
			return { log: log().length, requests: api?.requests.length ?? 0, assistants: assistants().length };
		},
		/** The last Claude Code session id main used before `mark`. */
		ccSessionBefore(mark) {
			const ids = log().slice(0, mark.log).flatMap((l) => [...l.matchAll(/syncResult: path=\S+ sessionId=([0-9a-f-]{36})/g)].map((m) => m[1]));
			return ids.at(-1) ?? null;
		},
		observe(mark) {
			const lines = log().slice(mark.log);
			const sync = lines.find((l) => l.includes("syncResult: path="));
			const adopted = lines.find((l) => /adopted (pointer|session)/.test(l)) ?? null;
			const result = {
				path: sync?.match(/path=(\S+)/)?.[1] ?? null,
				ccSession: sync?.match(/sessionId=([0-9a-f-]{36})/)?.[1] ?? null,
				adopted,
			};
			if (api) {
				const messages = api.requests.filter((r) => r.method === "POST" && r.path.startsWith("/v1/messages"));
				const before = api.requests.slice(0, mark.requests).filter((r) => r.method === "POST" && r.path.startsWith("/v1/messages")).at(-1);
				const after = messages.find((r) => api.requests.indexOf(r) >= mark.requests);
				result.cache = before && after ? comparePrefix(before.body, after.body) : null;
			} else {
				const all = assistants();
				const prev = all.slice(0, mark.assistants).filter((a) => a.provider === "claude-bridge").at(-1);
				const next = all.slice(mark.assistants).find((a) => a.provider === "claude-bridge");
				const cached = prev ? prev.usage.cacheRead + prev.usage.cacheWrite : 0;
				result.cache = prev && next
					? { prev: prev.usage, next: next.usage, ratio: cached ? next.usage.cacheRead / cached : 0 }
					: null;
			}
			return result;
		},
		async close() {
			await h.stop();
			await api?.close();
		},
	};
	return f;
}

const hit = (cache) => (API === "fake" ? cache?.eligible === true : (cache?.ratio ?? 0) >= 0.9);
const ccFile = (id, cwd) => getSessionPath(id, cwd, process.env.CLAUDE_CONFIG_DIR);

/** Each row: run the flow, return { observed, expect } where expect lists what must hold. */
const ROWS = {
	1: { name: "restart-then-main-turn", async run(f) {
		await f.prompt(P.plain(1)); await f.prompt(P.plain(2));
		const m = f.mark(); const before = f.ccSessionBefore(m);
		await f.restart(); await f.prompt(P.plain(3));
		const o = f.observe(m);
		return { o, checks: { "path reuse": o.path === "reuse", "same CC session": o.ccSession === before, "cache hit": hit(o.cache) } };
	} },
	4: { name: "multi-turn-with-tools", async run(f) {
		await f.prompt(P.plain(1)); await f.prompt(P.tool);
		const m = f.mark(); const before = f.ccSessionBefore(m);
		await f.prompt(P.plain(3));
		const o = f.observe(m);
		return { o, checks: { "path reuse": o.path === "reuse", "same CC session": o.ccSession === before, "cache hit": hit(o.cache) } };
	} },
	5: { name: "reload-then-main-turn", async run(f) {
		await f.prompt(P.plain(1)); await f.prompt(P.plain(2));
		const m = f.mark(); const before = f.ccSessionBefore(m);
		await f.command("/flows-reload"); await new Promise((r) => setTimeout(r, 3000));
		await f.prompt(P.plain(3));
		const o = f.observe(m);
		return { o, checks: { "path reuse": o.path === "reuse", "same CC session": o.ccSession === before, "cache hit": hit(o.cache) } };
	} },
	9: { name: "tool-change-then-restart", async run(f) {
		await f.prompt(P.plain(1)); await f.command("/flows-add-tool"); await f.prompt(P.plain(2));
		const m = f.mark(); const before = f.ccSessionBefore(m);
		await f.restart(); await f.prompt(P.plain(3));
		const o = f.observe(m);
		return { o, checks: { "path reuse": o.path === "reuse", "same CC session": o.ccSession === before }, measured: ["cache"] };
	} },
	10: { name: "compact-then-restart", async run(f) {
		// Fake replies are a few tokens; pad the prompts so older turns exceed keepRecentTokens.
		const padded = (n) => `${P.plain(n)}\n\nIgnore this filler: ${"the quick brown fox jumps over the lazy dog ".repeat(40)}`;
		await f.prompt(padded(1)); await f.prompt(padded(2)); await f.prompt(padded(3)); await f.send({ type: "compact" });
		const m = f.mark();
		await f.restart(); await f.prompt(P.plain(3));
		const o = f.observe(m);
		return { o, checks: { "path rebuild": o.path === "rebuild" || o.path === "clean-start", "no adoption": !o.adopted } };
	} },
	11: { name: "abort-then-restart", async run(f) {
		await f.prompt(P.plain(1));
		await f.send({ type: "prompt", message: P.slow });
		await new Promise((r) => setTimeout(r, 4000));
		await f.send({ type: "abort" });
		await new Promise((r) => setTimeout(r, 2000));
		const m = f.mark();
		await f.restart(); await f.prompt(P.plain(3));
		const o = f.observe(m);
		return { o, checks: { "path rebuild": o.path === "rebuild" || o.path === "clean-start", "no adoption": !o.adopted } };
	} },
	12: { name: "rewind-label-then-restart", async run(f) {
		await f.prompt(P.plain(1)); await f.prompt(P.plain(2));
		await f.command("/flows-rewind-label"); await new Promise((r) => setTimeout(r, 1000));
		const m = f.mark();
		await f.restart(); await f.prompt(P.plain(3));
		const o = f.observe(m);
		return { o, checks: { "path rebuild": o.path === "rebuild" || o.path === "clean-start", "no adoption": !o.adopted } };
	} },
	13: { name: "other-provider-then-restart", async run(f) {
		await f.prompt(P.plain(1));
		await f.send({ type: "set_model", provider: "flows-other", modelId: "other-1" });
		await f.prompt(P.plain(2));
		await f.send({ type: "set_model", provider: "claude-bridge", modelId: "claude-haiku-4-5" });
		const m = f.mark();
		await f.restart(); await f.prompt(P.plain(3));
		const o = f.observe(m);
		return { o, checks: { "path rebuild": o.path === "rebuild" || o.path === "clean-start", "no adoption": !o.adopted } };
	} },
	14: { name: "pi-fork-first-turn", async run(f) {
		await f.prompt(P.plain(1)); await f.prompt(P.plain(2));
		const m = f.mark(); const main = f.ccSessionBefore(m);
		const mainFile = main ? ccFile(main, f.work) : null;
		const mainBytes = mainFile && existsSync(mainFile) ? readFileSync(mainFile, "utf8") : null;
		const { messages } = await f.send({ type: "get_fork_messages" });
		await f.send({ type: "fork", entryId: messages.at(-1).entryId });
		await f.prompt(P.plain(3));
		const o = f.observe(m);
		const unchanged = mainBytes !== null && readFileSync(mainFile, "utf8") === mainBytes;
		return { o, checks: { "path rebuild or clean-start": o.path === "rebuild" || o.path === "clean-start", "not main's CC session": o.ccSession !== main, "main's CC file unchanged": unchanged } };
	} },
	15: { name: "restart-in-another-cwd", async run(f) {
		await f.prompt(P.plain(1)); await f.prompt(P.plain(2));
		const m = f.mark();
		const other = join(f.root, "elsewhere"); mkdirSync(other, { recursive: true });
		await f.restart({ cwd: other }); await f.prompt(P.plain(3));
		const o = f.observe(m);
		return { o, checks: { "path rebuild": o.path === "rebuild" || o.path === "clean-start", "no adoption": !o.adopted } };
	} },
	16: { name: "context-edit-then-recovery", async run(f) {
		await f.prompt(P.plain(1));
		await f.command("/flows-arm-edit"); await f.prompt(P.tool);
		const m1 = f.mark();
		await f.restart(); await f.prompt(P.plain(3));
		const o1 = f.observe(m1);
		await f.prompt(P.plain(4));
		const m2 = f.mark(); const before = f.ccSessionBefore(m2);
		await f.restart(); await f.prompt(P.plain(5));
		const o2 = f.observe(m2);
		return { o: { afterEdit: o1, afterRecovery: o2 }, checks: {
			"after the edit: rebuild": o1.path === "rebuild" || o1.path === "clean-start",
			"after recovery: reuse": o2.path === "reuse", "after recovery: same CC session": o2.ccSession === before, "after recovery: cache hit": hit(o2.cache),
		} };
	} },
	17: { name: "cc-file-deleted-then-restart", async run(f) {
		await f.prompt(P.plain(1)); await f.prompt(P.plain(2));
		const m = f.mark(); const main = f.ccSessionBefore(m);
		await f.harness().stop();
		if (main) rmSync(ccFile(main, f.work), { force: true });
		await f.restart(); await f.prompt(P.plain(3));
		const o = f.observe(m);
		return { o, checks: { "path rebuild": o.path === "rebuild" || o.path === "clean-start", "no adoption": !o.adopted } };
	} },
};

const results = [];
for (const [row, spec] of Object.entries(ROWS)) {
	if (ONLY?.length && !ONLY.includes(row)) continue;
	const name = `row${row}-${spec.name}`;
	say(`— row ${row}: ${spec.name}`);
	let f;
	try {
		f = await flow(name);
		const { o, checks, measured = [] } = await spec.run(f);
		const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
		results.push({ row: Number(row), name: spec.name, api: API, observed: o, checks, measured, pass: failed.length === 0 });
		say(`  ${failed.length ? "MISS " + failed.join("; ") : "ok"}  ${JSON.stringify(o).slice(0, 400)}`);
	} catch (error) {
		results.push({ row: Number(row), name: spec.name, api: API, error: String(error?.stack ?? error), pass: false });
		say(`  ERROR ${error?.message ?? error}`);
	} finally {
		await f?.close().catch(() => {});
		if (f) rmSync(f.root, { recursive: true, force: true });
	}
}
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
say(`\n${results.filter((r) => r.pass).length}/${results.length} rows as expected; results in ${join(OUT, "results.json")}`);
if (!RECORD && results.some((r) => !r.pass)) process.exit(1);
