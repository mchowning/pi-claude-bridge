/**
 * Test-only pi extension for tests/int-cache-flows.mjs. Gives an RPC client the session
 * operations RPC mode has no command for, and a second provider that needs no API:
 *
 *   /flows-reload              ctx.reload()
 *   /flows-rewind-label        navigate to the first assistant reply without a summary, then
 *                              label it (the label lands on the rewound branch)
 *   /flows-add-tool            activate `grep` (a real tool-set change)
 *   /flows-arm-edit            at the next turn_end, append a context_edit replacing the text
 *                              of the first assistant reply
 *   provider "flows-other"     model "other-1", answers "other provider reply"
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";

type Entry = { type: string; id: string; message?: { role?: string } };

export default function cacheFlowsExtension(pi: ExtensionAPI) {
	const firstReply = (entries: readonly Entry[]) =>
		entries.find((e) => e.type === "message" && e.message?.role === "assistant");

	pi.registerCommand("flows-reload", {
		description: "reload",
		handler: async (_args, ctx) => ctx.reload(),
	});

	pi.registerCommand("flows-rewind-label", {
		description: "rewind to the first reply and label it",
		handler: async (_args, ctx) => {
			const target = firstReply(ctx.sessionManager.getBranch() as Entry[]);
			if (!target) throw new Error("flows-rewind-label: no assistant reply to rewind to");
			await ctx.navigateTree(target.id, { summarize: false });
			pi.setLabel(target.id, "flows-rewound");
		},
	});

	pi.registerCommand("flows-add-tool", {
		description: "activate grep",
		handler: async () => pi.setActiveTools([...pi.getActiveTools(), "grep"]),
	});

	let armed = false;
	pi.registerCommand("flows-arm-edit", {
		description: "context_edit at the next turn_end",
		handler: async () => {
			armed = true;
		},
	});
	pi.on("turn_end", (_event, ctx) => {
		if (!armed) return undefined;
		const target = firstReply(ctx.sessionManager.getBranch() as Entry[]);
		if (!target) return undefined;
		armed = false;
		return {
			entries: [{ type: "context_edit", targetId: target.id, replacement: { content: [{ type: "text", text: "edited reply" }] } }],
		};
	});

	const other = createFauxCore({
		api: "flows-other",
		provider: "flows-other",
		models: [{ id: "other-1", name: "Other", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4_096 }],
	});
	pi.registerProvider("flows-other", {
		baseUrl: "http://localhost:0",
		apiKey: "unused",
		api: "flows-other",
		models: other.models.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({ id, name, reasoning, input, cost, contextWindow, maxTokens })),
		streamSimple: (model, context, options) => {
			other.appendResponses([fauxAssistantMessage("other provider reply")]);
			return other.streamSimple(model, context, options);
		},
	});
}
