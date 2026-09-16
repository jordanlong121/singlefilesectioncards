// Day Planner: a card split into subcards and lines, their keys, weights, and column split.

import { HEADING_RE } from "./sections";
import { sectionBlocks, BLOCK_PREFIX_RE } from "./blocks";

/** A line's place on the Day Planner: which column, and a height when it was resized. */
export interface PlannerSlot {
	/** The column the user put the card in — left included, so a card dragged left
	 * stays left rather than re-flowing. Unset: the card flows to balance the columns. */
	col?: 0 | 1;
	h?: number;
}

/**
 * The Day Planner remembers a line's column and height by this key: its first line with
 * the list marker, checkbox, Tasks emoji fields (done/due/scheduled dates, priorities,
 * recurrence) and block id stripped, whitespace collapsed, lowercased — so ticking a task
 * off, or Tasks stamping its done date, keeps it where it was put.
 */
export function plannerBlockKey(blockText: string): string {
	const first = blockText.split("\n")[0] ?? "";
	return first
		.replace(/^\s*#{1,6}\s+/, "")
		.replace(BLOCK_PREFIX_RE, "")
		.replace(/\s*(?:✅|❌|📅|⏳|🛫|➕)\s*\d{4}-\d{2}-\d{2}/gu, "")
		.replace(/\s*(?:🔺|⏫|🔼|🔽|⏬)/gu, "")
		.replace(/\s*🔁[^✅❌📅⏳🛫➕🔺⏫🔼🔽⏬#^]*/u, "")
		.replace(/\s*\^[A-Za-z0-9-]+\s*$/, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** One card on the Day Planner, as a body-relative line range: a line (one movable
 * block) above the card's first sub-heading, or a subcard — a sub-heading with
 * everything beneath it. */
export interface PlannerCard {
	/** "line": one movable block (a card with no sub-headings is all lines); "loose": the
	 * lines above a card's first sub-heading, as one card named after the unfiled card;
	 * "sub": a sub-heading with what's beneath it. */
	kind: "line" | "sub" | "loose";
	start: number;
	end: number;
	/** Lines: the index among the section's movable blocks, which the block writers key on. */
	blockIndex?: number;
	/** Subcards: the heading's text without its #'s, and its level (1–6). */
	title?: string;
	level?: number;
}

/**
 * Split a card's body for the Day Planner. A heading beneath the card starts a subcard
 * that runs to the next subcard's heading — unless it sits under an open subcard with a
 * shallower heading, in which case it stays inside: a month card (H1) shows each week
 * (H2) as a card with its days (H3) inside, while a day written above the first week
 * heading is a card of its own. What sits above the first heading is one "loose" card;
 * with no headings at all, every movable block is a line card of its own. Fenced code is
 * never a heading.
 */
export function plannerCards(body: string[]): PlannerCard[] {
	const blocks = sectionBlocks(body);
	const subs: { line: number; level: number; title: string }[] = [];
	let openLevel: number | null = null;
	for (const b of blocks) {
		if (b.kind !== "other" || b.end - b.start !== 1) continue;
		const m = HEADING_RE.exec(body[b.start]);
		if (!m) continue;
		const level = m[1].length;
		if (openLevel !== null && level > openLevel) continue; // nested: part of the open subcard
		subs.push({ line: b.start, level, title: m[2].trim() });
		openLevel = level;
	}
	const cards: PlannerCard[] = [];
	if (!subs.length) {
		blocks
			.filter((b) => b.kind !== "other")
			.forEach((b, blockIndex) => cards.push({ kind: "line", start: b.start, end: b.end, blockIndex }));
		return cards;
	}
	const firstSub = subs[0].line;
	let looseStart = 0;
	while (looseStart < firstSub && body[looseStart].trim() === "") looseStart++;
	if (looseStart < firstSub) cards.push({ kind: "loose", start: looseStart, end: firstSub });
	subs.forEach((h, i) => {
		cards.push({
			kind: "sub",
			start: h.line,
			end: i + 1 < subs.length ? subs[i + 1].line : body.length,
			title: h.title,
			level: h.level,
		});
	});
	return cards;
}

/**
 * Day Planner: which column each card goes in. Cards the user has placed (a saved
 * column) stay put; the rest flow in order, newspaper-style — the left column takes
 * cards until it holds about half the total height, the right column the remainder —
 * so the two columns come out as even as document order allows. `weight` is a rough
 * height (lines); a card with a saved column still counts toward that column.
 */
export function plannerColumnSplit(items: { col?: 0 | 1; weight: number }[]): (0 | 1)[] {
	const total = items.reduce((sum, item) => sum + item.weight, 0);
	const half = total / 2;
	let left = items.filter((item) => item.col === 0).reduce((sum, item) => sum + item.weight, 0);
	const out: (0 | 1)[] = [];
	let wentRight = false;
	for (const item of items) {
		if (item.col !== undefined) {
			out.push(item.col);
			continue;
		}
		// Left while it lands closer to the halfway mark than stopping would; once a
		// card goes right, the rest follow (order stays readable top-down, then across).
		if (!wentRight && Math.abs(left + item.weight - half) <= Math.abs(left - half)) {
			left += item.weight;
			out.push(0);
		} else {
			wentRight = true;
			out.push(1);
		}
	}
	return out;
}

/** A rough height for a planner card, in lines: its non-blank lines, long ones
 * counted as wrapped, plus one for a subcard's title. Resized cards use their height. */
export function plannerCardWeight(lines: string[], card: PlannerCard, savedHeight?: number): number {
	if (savedHeight) return Math.max(1, Math.round(savedHeight / 26));
	let weight = card.kind === "line" ? 0 : 1;
	const start = card.kind === "sub" ? card.start + 1 : card.start;
	for (let i = start; i < card.end; i++) {
		const line = lines[i].trim();
		if (line) weight += Math.max(1, Math.ceil(line.length / 80));
	}
	return Math.max(1, weight);
}

/** Natural ordering for the alphanumeric-sort role: "Week 2" before "Week 10". */
export function alphanumericCompare(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}
