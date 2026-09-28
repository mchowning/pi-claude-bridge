/**
 * A scripted stand-in for the Anthropic Messages API, for runs of real pi + the bridge +
 * real Claude Code with no model behind them (ANTHROPIC_BASE_URL=<url>). It records every
 * request (method, path, parsed body) and answers POST /v1/messages from the request itself:
 *
 *   - the last message is a tool_result      → a text reply
 *   - the last user text contains "USE_TOOL" → a tool_use of the first tool whose name ends
 *                                              in "bash", running `echo fake-tool`
 *   - the last user text contains "SLOW"     → a text reply that stops for 10 s mid-stream,
 *                                              so a client abort lands inside the turn
 *   - anything else                          → a text reply
 *
 * Text replies are "fake reply N". Usage is fixed (the server has no cache); callers
 * compare request bodies instead. Any other path gets a 404 and is recorded, so a run can
 * show every endpoint CC tried.
 *
 *   node tests/lib/fake-anthropic.mjs --port 0 --out DIR   (prints the URL, writes DIR/NNNN.json)
 */
import { createServer } from "node:http";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PAUSE = "\u0000pause\u0000";
const event = (name, obj) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;

function lastUserText(body) {
	const last = body.messages?.at(-1);
	if (!last || last.role !== "user") return "";
	return typeof last.content === "string" ? last.content : last.content.map((b) => b.text ?? "").join("\n");
}

const endsWithToolResult = (body) => {
	const last = body.messages?.at(-1);
	return Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result");
};

function reply(body, n) {
	const start = (content) => event("message_start", {
		type: "message_start",
		message: { id: `msg_fake_${n}`, type: "message", role: "assistant", content, model: body.model, stop_reason: null, stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
	});
	const tool = !endsWithToolResult(body) && lastUserText(body).includes("USE_TOOL")
		? (body.tools ?? []).find((t) => /bash$/i.test(t.name))
		: undefined;
	if (tool) {
		return start([])
			+ event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_fake_${n}`, name: tool.name, input: {} } })
			+ event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "echo fake-tool" }) } })
			+ event("content_block_stop", { type: "content_block_stop", index: 0 })
			+ event("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } })
			+ event("message_stop", { type: "message_stop" });
	}
	return start([])
		+ event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
		+ event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `fake reply ${n}` } })
		+ PAUSE
		+ event("content_block_stop", { type: "content_block_stop", index: 0 })
		+ event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
		+ event("message_stop", { type: "message_stop" });
}

/** Starts the server. `requests` receives { method, path, body } in arrival order. */
export function startFakeAnthropic({ port = 0, out } = {}) {
	const requests = [];
	if (out) mkdirSync(out, { recursive: true });
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body = null;
			try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
			const record = { method: req.method, path: req.url, body };
			requests.push(record);
			if (out) writeFileSync(join(out, `${String(requests.length).padStart(4, "0")}.json`), JSON.stringify(record, null, 2));
			if (req.method === "POST" && req.url.startsWith("/v1/messages") && !req.url.includes("count_tokens")) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				const [head, tail = ""] = reply(body, requests.length).split(PAUSE);
				if (!lastUserText(body).includes("SLOW")) res.end(head + tail);
				else {
					res.write(head);
					const timer = setTimeout(() => res.end(tail), 10_000);
					res.on("close", () => clearTimeout(timer));
				}
			} else {
				res.writeHead(404).end();
			}
		});
	});
	return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({
		url: `http://127.0.0.1:${server.address().port}`,
		requests,
		close: () => new Promise((r) => server.close(() => r())),
	})));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const flag = (name, fallback) => {
		const i = process.argv.indexOf(`--${name}`);
		return i === -1 ? fallback : process.argv[i + 1];
	};
	const api = await startFakeAnthropic({ port: Number(flag("port", 0)), out: flag("out") });
	console.log(api.url); // eslint-disable-line no-console
}
