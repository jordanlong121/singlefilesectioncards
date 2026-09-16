// A section body as movable blocks: paragraphs, list items, fences; stars; card faces.

import { Section, HEADING_RE, FENCE_RE, parseSections, bodyStartLine } from "./sections";

/** One draggable unit of a section body: a top-level list item (with its children) or a paragraph. */
export interface BodyBlock {
	kind: "item" | "paragraph" | "other";
	/** [start, end) offsets into the section's body lines. */
	start: number;
	end: number;
}

export const LIST_START_RE = /^(?:[-*+]|\d+[.)])\s+/;

/** A list item as CommonMark allows it at the top level: up to three leading spaces. */
export const TOP_ITEM_RE = /^ {0,3}(?:[-*+]|\d+[.)])\s+/;

/** Any indented list item, with its indentation captured. */
export const INDENTED_ITEM_RE = /^([ \t]+)(?:[-*+]|\d+[.)])\s+/;

/** Column width of leading whitespace, tabs as four. */
export function indentWidth(ws: string): number {
	let w = 0;
	for (const c of ws) w += c === "\t" ? 4 : 1;
	return w;
}

/** The column an item's content starts at — a nested item must indent at least this far;
 * a list item indented less is the NEXT item of the same list, as the renderer shows it. */
export function itemContentColumn(line: string): number {
	const m = /^([ \t]*)((?:[-*+]|\d+[.)])\s+)/.exec(line);
	return m ? indentWidth(m[1]) + m[2].length : 0;
}

/** A thematic break: 3+ of the same marker, optionally space-separated — rendered <hr>. */
export const HR_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/** A setext underline: with a paragraph line directly above, the pair renders <h1>/<h2>. */
export const SETEXT_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;

/**
 * Split a section body into blocks, mirroring what MarkdownRenderer turns into top-level
 * elements: "item" = a column-0 list line plus its indented children (rendered <li>),
 * "paragraph" = consecutive prose lines (rendered <p>), and "other" = everything that
 * renders as neither — fences, headings, blockquotes, tables, raw HTML — which is not
 * draggable and keeps the DOM↔source mapping honest.
 */
/** A line that is nothing but an Obsidian `%% … %%` or HTML `<!-- … -->` comment: invisible
 * in reading view, so it's its own (non-draggable) block and ends any paragraph above it —
 * the Card Flip marker sits on such a line, and must never be swept into a paragraph. */
export const COMMENT_LINE_RE = /^\s*(?:%%.*%%|<!--.*-->)\s*$/;

export function sectionBlocks(body: string[]): BodyBlock[] {
	const blocks: BodyBlock[] = [];
	let i = 0;
	const isBlank = (line: string) => line.trim() === "";

	while (i < body.length) {
		const line = body[i];
		if (isBlank(line)) {
			i++;
			continue;
		}
		const start = i;

		if (FENCE_RE.test(line)) {
			i++;
			while (i < body.length && !FENCE_RE.test(body[i])) i++;
			if (i < body.length) i++;
			blocks.push({ kind: "other", start, end: i });
		} else if (COMMENT_LINE_RE.test(line)) {
			blocks.push({ kind: "other", start, end: ++i });
		} else if (HEADING_RE.test(line)) {
			blocks.push({ kind: "other", start, end: ++i });
		} else if (/^\s*>/.test(line)) {
			while (i < body.length && /^\s*>/.test(body[i])) i++;
			blocks.push({ kind: "other", start, end: i });
		} else if (/^\s*\|/.test(line)) {
			while (i < body.length && /^\s*\|/.test(body[i])) i++;
			blocks.push({ kind: "other", start, end: i });
		} else if (line.startsWith("<")) {
			i++;
			while (
				i < body.length &&
				!isBlank(body[i]) &&
				!LIST_START_RE.test(body[i]) &&
				!FENCE_RE.test(body[i]) &&
				!HEADING_RE.test(body[i])
			) {
				i++;
			}
			blocks.push({ kind: "other", start, end: i });
		} else if (HR_RE.test(line)) {
			// A thematic break renders <hr> — and outranks a list reading ("- - -").
			blocks.push({ kind: "other", start, end: ++i });
		} else if (TOP_ITEM_RE.test(line)) {
			i++;
			// Children: following non-blank indented lines — except a list item whose
			// indent falls short of this item's content column, which Markdown renders
			// as the next item of the same list (" - [ ] x" under "- [ ] y", say).
			const contentCol = itemContentColumn(line);
			while (i < body.length && !isBlank(body[i]) && /^[\t ]/.test(body[i])) {
				const nested = INDENTED_ITEM_RE.exec(body[i]);
				if (nested && indentWidth(nested[1]) < contentCol) break;
				i++;
			}
			blocks.push({ kind: "item", start, end: i });
		} else if (/^[\t ]/.test(line)) {
			// stray indented run (indent-style code, continuation) — not draggable
			while (i < body.length && !isBlank(body[i]) && /^[\t ]/.test(body[i])) i++;
			blocks.push({ kind: "other", start, end: i });
		} else {
			i++;
			let kind: BodyBlock["kind"] = "paragraph";
			while (
				i < body.length &&
				!isBlank(body[i]) &&
				!TOP_ITEM_RE.test(body[i]) &&
				!FENCE_RE.test(body[i]) &&
				!HEADING_RE.test(body[i]) &&
				!/^\s*>/.test(body[i]) &&
				!/^\s*\|/.test(body[i])
			) {
				// Directly under a paragraph line, "---"/"===" makes a setext heading —
				// the pair renders <h1>/<h2>, so the whole run stops being a paragraph.
				if (SETEXT_RE.test(body[i])) {
					i++;
					kind = "other";
					break;
				}
				// A "***"/"___" rule below the paragraph is its own <hr>, not part of it.
				if (HR_RE.test(body[i])) break;
				// A comment-only line (the flip marker, say) isn't paragraph text either.
				if (COMMENT_LINE_RE.test(body[i])) break;
				i++;
			}
			blocks.push({ kind, start, end: i });
		}
	}
	return blocks;
}

/** The blocks a user can drag, in the same order the eligible DOM elements render. */
export function movableBlocks(body: string[]): BodyBlock[] {
	return sectionBlocks(body).filter((b) => b.kind !== "other");
}

/** A block's leading decoration: list marker plus optional task checkbox (any status
 * character, so Tasks-style `[/]`/`[-]` lines star the same way). Paragraphs match "". */
export const BLOCK_PREFIX_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s+)?/;

/** Whether a block's first line carries the star: the emoji directly after any list
 * marker/checkbox (or at the line start for a paragraph). The emoji IS the stored state. */
export function blockStarred(firstLine: string, emoji: string): boolean {
	if (!emoji) return false;
	const m = firstLine.match(BLOCK_PREFIX_RE);
	return firstLine.slice(m ? m[0].length : 0).startsWith(emoji);
}

/** Toggle the star on a block's first line, keeping any list marker/checkbox intact. */
export function toggleStarInLine(line: string, emoji: string): string {
	const m = line.match(BLOCK_PREFIX_RE);
	const prefix = m ? m[0] : "";
	const rest = line.slice(prefix.length);
	return rest.startsWith(emoji)
		? prefix + rest.slice(emoji.length).replace(/^[ \t]+/, "")
		: `${prefix}${emoji} ${rest}`;
}

/** What the starred-only view knows about a section body: whether it has a starred block
 * at all, and whether hiding everything else would actually hide something — the card
 * shows a trailing ellipsis only in that case. Stars inside code fences or blockquotes
 * don't count as starred (those blocks aren't movable), but the blocks themselves count
 * as hidden content, since the view hides them too. */
export function starInfo(body: string[], emoji: string): { has: boolean; hidden: boolean; count: number } {
	let count = 0;
	let hidden = false;
	for (const b of sectionBlocks(body)) {
		if (b.kind !== "other" && blockStarred(body[b.start], emoji)) count++;
		else hidden = true;
	}
	return { has: count > 0, hidden, count };
}

/** Whether any of a section body's movable blocks is starred — the card-level test the
 * starred-only filter uses (stars inside code fences or blockquotes don't count). */
export function sectionHasStar(body: string[], emoji: string): boolean {
	return starInfo(body, emoji).has;
}

/**
 * A card body is a mid-note excerpt, so a leading "---" is a rule, not frontmatter —
 * but MarkdownRenderer treats anything at the very start of its input as document
 * start and would hide the block as YAML. A blank first line keeps it visible, the
 * way the reading view shows those lines in the full note.
 */
export function bodyForRender(body: string): string {
	// A plain line straight under a list item is a markdown "lazy continuation":
	// the renderer would fold it into the item, while this plugin's own blocks —
	// and so the drag/hover mapping — treat it as its own paragraph. A blank line
	// makes the renderer agree, so the text renders as a normal paragraph.
	const lines = body.split("\n");
	const blocks = sectionBlocks(lines);
	for (let i = blocks.length - 1; i > 0; i--) {
		if (blocks[i].kind === "paragraph" && blocks[i - 1].kind === "item" && blocks[i - 1].end === blocks[i].start) {
			lines.splice(blocks[i].start, 0, "");
		}
	}
	const out = lines.join("\n");
	return out.startsWith("---") ? "\n" + out : out;
}

/** The two faces of a card whose body holds a back-side marker line. */
export interface CardFaces {
	/** Body lines above the marker (the whole body when there is no marker). */
	front: string;
	/** Body lines below the marker; null when the body has no marker. */
	back: string | null;
}

/**
 * Split a section body at its back-side marker: the first line that, trimmed, is
 * exactly the marker (itself trimmed; case-insensitive). Everything above is the
 * card's front, everything below its back. Fenced code is skipped, so a marker
 * quoted inside a code block doesn't split the card. An empty marker never splits.
 */
export function splitCardFaces(body: string, marker: string): CardFaces {
	const lines = body.split("\n");
	const i = flipMarkerLine(lines, marker);
	if (i < 0) return { front: body, back: null };
	return { front: trimTrailingBlankLines(lines.slice(0, i).join("\n")), back: lines.slice(i + 1).join("\n") };
}

/** Index of the back-side marker line among body lines (-1 if none): the first line
 * that, trimmed, is the marker (trimmed, case-insensitive), skipping fenced code. */
export function flipMarkerLine(lines: string[], marker: string): number {
	const want = marker.trim().toLowerCase();
	if (!want) return -1;
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const open = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
		if (fence) {
			if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
			continue;
		}
		if (open) {
			fence = open[1];
			continue;
		}
		if (lines[i].trim().toLowerCase() === want) return i;
	}
	return -1;
}

/**
 * Move one movable block from a section to a position in another (or the same) section:
 * beside that section's movable block `anchorIndex` — above it ("before") or directly
 * below it ("after") — to the top of the body ("start"), or to the section's end (null).
 * The block's lines move byte-for-byte; paragraphs gain blank separators at the seams,
 * and a doubled blank left at the removal point is collapsed. Null = no-op/invalid.
 */
export function moveBlock(
	lines: string[],
	level: number,
	fromSectionIndex: number,
	blockIndex: number,
	toSectionIndex: number,
	anchorIndex: number | "start" | null,
	anchorSide: "before" | "after" = "before",
): string[] | null {
	const sections = parseSections(lines, level);
	const from = sections[fromSectionIndex];
	const to = sections[toSectionIndex];
	if (!from || !to) return null;
	return moveBlockBetween(lines, from, blockIndex, to, anchorIndex, anchorSide);
}

/** moveBlock's core, taking already-located sections so the unfiled card works too. */
export function moveBlockBetween(
	lines: string[],
	from: Section,
	blockIndex: number,
	to: Section,
	anchorIndex: number | "start" | null,
	anchorSide: "before" | "after" = "before",
): string[] | null {
	const fromBody = lines.slice(bodyStartLine(from), from.endLine);
	const block = movableBlocks(fromBody)[blockIndex];
	if (!block) return null;
	const absStart = bodyStartLine(from) + block.start;
	const absEnd = bodyStartLine(from) + block.end;
	const blockLines = lines.slice(absStart, absEnd);

	let insertAbs: number;
	if (anchorIndex === null) {
		insertAbs = to.endLine;
	} else if (anchorIndex === "start") {
		// Top of the body — above a leading subheading, which no movable anchor sits above.
		insertAbs = bodyStartLine(to);
	} else {
		const toBody = lines.slice(bodyStartLine(to), to.endLine);
		const anchor = movableBlocks(toBody)[anchorIndex];
		// "after" anchors at the hovered block's own end — NOT the next movable
		// block's start — so the dropped text stays on this side of any subheading
		// (or other non-draggable block) sitting between the two.
		insertAbs = anchor ? bodyStartLine(to) + (anchorSide === "after" ? anchor.end : anchor.start) : to.endLine;
	}
	// Dropping a block onto its own position is a no-op — including across a gap of
	// nothing but blank separator lines.
	if (from.startLine === to.startLine) {
		if (insertAbs >= absStart && insertAbs <= absEnd) return null;
		const [lo, hi] = insertAbs < absStart ? [insertAbs, absStart] : [absEnd, insertAbs];
		if (lines.slice(lo, hi).every((l) => l.trim() === "")) return null;
	}

	const out = lines.slice(0, absStart).concat(lines.slice(absEnd));
	const target = insertAbs > absStart ? insertAbs - (absEnd - absStart) : insertAbs;

	const ins = blockLines.slice();
	if (block.kind === "paragraph") {
		if (target > 0 && out[target - 1].trim() !== "") ins.unshift("");
		if (target < out.length && out[target].trim() !== "") ins.push("");
	}
	out.splice(target, 0, ...ins);

	// Collapse a doubled blank line left where the block was removed.
	const junction = insertAbs > absStart ? absStart : absStart + ins.length;
	if (junction > 0 && junction < out.length && out[junction - 1].trim() === "" && out[junction].trim() === "") {
		out.splice(junction, 1);
	}
	return out;
}

/**
 * Remove one movable block from a section — a task brings its sub-items along, the
 * same unit a drag moves. A doubled blank left at the removal point is collapsed.
 */
export function removeBlock(lines: string[], from: Section, blockIndex: number): string[] | null {
	const fromBody = lines.slice(bodyStartLine(from), from.endLine);
	const block = movableBlocks(fromBody)[blockIndex];
	if (!block) return null;
	const absStart = bodyStartLine(from) + block.start;
	const absEnd = bodyStartLine(from) + block.end;
	const out = lines.slice(0, absStart).concat(lines.slice(absEnd));
	if (absStart > 0 && absStart < out.length && out[absStart - 1].trim() === "" && out[absStart].trim() === "") {
		out.splice(absStart, 1);
	}
	return out;
}

/**
 * The editor pads the section with a trailing newline so typing starts on a fresh line;
 * this strips that padding (and any other trailing blank lines) back off before saving,
 * matching how parseSections trims sections. An untouched editor therefore saves nothing.
 */
export function trimTrailingBlankLines(text: string): string {
	const lines = text.split(/\r?\n/);
	while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
	return lines.join("\n");
}
