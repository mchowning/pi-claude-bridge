/**
 * Whether request `next` can read the prompt cache that request `prev` wrote.
 *
 * Anthropic caches the prompt in order tools → system → messages, up to a cache_control
 * breakpoint. `next` can read `prev`'s cache only if it matches `prev` block for block
 * through `prev`'s last breakpoint. Blocks are compared with cache_control stripped (CC moves
 * the markers between turns) and without system[0], CC's per-request billing header — the
 * same exclusions tests/int-cc-contracts.mjs makes.
 *
 * This says a hit is possible, not that the server served one; the live run decides that.
 */

const stripCacheControl = (v) =>
	JSON.parse(JSON.stringify(v, (_k, x) =>
		x && typeof x === "object" && !Array.isArray(x)
			? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "cache_control"))
			: x));

/** The request as an ordered list of cacheable blocks. */
export function cacheBlocks(body) {
	const blocks = [];
	for (const [i, tool] of (body.tools ?? []).entries()) blocks.push({ where: `tools[${i}]`, value: tool });
	for (const [i, block] of (body.system ?? []).entries()) if (i > 0) blocks.push({ where: `system[${i}]`, value: block });
	for (const [i, message] of (body.messages ?? []).entries()) {
		const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		for (const [j, block] of content.entries()) blocks.push({ where: `messages[${i}].content[${j}]`, role: message.role, value: block });
	}
	return blocks.map((b) => ({ ...b, breakpoint: Boolean(b.value?.cache_control), key: JSON.stringify(stripCacheControl(b.value)) }));
}

/**
 * { eligible, breakpoint, divergence } where `breakpoint` is the location of prev's last
 * cache_control block and `divergence` the first block that differs (null when none does
 * before prev runs out).
 */
export function comparePrefix(prev, next) {
	const a = cacheBlocks(prev);
	const b = cacheBlocks(next);
	const last = a.findLastIndex((x) => x.breakpoint);
	const firstDiff = a.findIndex((x, i) => b[i]?.key !== x.key);
	const divergence = firstDiff === -1 ? null : { where: a[firstDiff].where, prev: a[firstDiff].key.slice(0, 120), next: b[firstDiff]?.key.slice(0, 120) ?? null };
	return {
		eligible: last >= 0 && (firstDiff === -1 || firstDiff > last),
		breakpoint: last >= 0 ? a[last].where : null,
		divergence,
	};
}
