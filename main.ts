import {
	App,
	Component,
	SuggestModal,
	addIcon,
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Scope,
	Setting,
	type SettingDefinitionItem,
	setIcon,
	TFile,
	WorkspaceLeaf,
	debounce,
	moment,
} from "obsidian";

export const VIEW_TYPE_SECTION_CARDS = "section-cards-view";

/** Bodies rendered synchronously on open — roughly two screenfuls. The rest render in
 * idle-time batches so a year-long note paints its first cards immediately. */
const INITIAL_RENDER_COUNT = 24;
const DEFERRED_RENDER_BATCH = 12;

export const DECK_ICON = "section-cards-deck";

/**
 * A deck of cards: three offset card layers. Drawn on Lucide's 24px grid (2px round
 * strokes) and scaled into the 100x100 box Obsidian's addIcon expects. The back layers
 * are drawn as top+right edges only, so no strokes overlap and it stays legible at 16px.
 */
const DECK_SVG = `<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
	<rect x="2.5" y="9" width="12" height="12.5" rx="2"/>
	<path d="M5.5 6h10a2 2 0 0 1 2 2v10"/>
	<path d="M8.5 3h10a2 2 0 0 1 2 2v10"/>
</g>`;

export type SortOrder = "doc" | "asc" | "desc";

/** Where a newly created section is inserted into the file. */
export type Placement = "top" | "logical" | "bottom";

/**
 * How cards are arranged.
 * - grid: masonry columns
 * - aligned: uniform grid — every row starts at the same height
 * - tight: denser masonry columns
 * - horizontal: one card per row, full width
 * - vertical: full-height cards in a row, scrolling sideways
 */
export type Layout = "grid" | "aligned" | "tight" | "horizontal" | "vertical" | "custom";

const SORT_LABELS: Record<SortOrder, string> = { asc: "A → Z", desc: "Z → A", doc: "Document order" };

/** [value, toolbar label, tooltip] */
const LAYOUT_OPTIONS: [Layout, string, string][] = [
	["grid", "Grid", "Masonry columns"],
	["aligned", "Grid Aligned", "Uniform grid: every row starts at the same height"],
	["tight", "Tight", "Denser, narrower masonry columns"],
	["horizontal", "Horizontal", "One card per row, full width"],
	["vertical", "Vertical", "Full-height cards side by side, scrolling sideways"],
	["custom", "Custom Grid", "Freeform canvas: drag cards on from the tray, place and resize them"],
];

/** What clicking a card's title bar does. */
export type TitleBarClick = "maximize" | "edit";

/** Whether this note's headings are dates (so "today" can be highlighted) or plain text. */
export type HeadingType = "dates" | "text";

interface SectionCardsSettings {
	filePath: string;
	headingLevel: number;
	sortOrder: SortOrder;
	cardMaxHeight: number;
	newCardFormat: string;
	newCardPlacement: Placement;
	headingType: HeadingType;
	taskDoneDate: boolean;
	/** Whether ticking a task also strikes through the items nested beneath it. */
	strikeNestedUnderDone: boolean;
	titleBarClick: TitleBarClick;
	layout: Layout;
	/** Remembered view per note, keyed by vault path. Lives here, never in the note. */
	perFile: Record<string, PerFileView>;
}

/** A note's remembered view plus, for the Custom Grid, its card placements by heading. */
export interface PerFileView extends ViewSettings {
	customGrid?: Record<string, CardRect>;
	customZoom?: number;
}

/** The bit of view state that is remembered per note. */
export interface ViewSettings {
	layout: Layout;
	headingLevel: number;
	sortOrder: SortOrder;
}

const DEFAULT_SETTINGS: SectionCardsSettings = {
	filePath: "Daily Notes 2026.md",
	headingLevel: 3,
	sortOrder: "asc",
	cardMaxHeight: 320,
	newCardFormat: "YYYY-MM-DD, dddd",
	newCardPlacement: "logical",
	headingType: "dates",
	taskDoneDate: true,
	strikeNestedUnderDone: true,
	titleBarClick: "maximize",
	layout: "grid",
	perFile: {},
};

/** One heading and everything beneath it, down to the next heading of the same or higher rank. */
interface Section {
	/** Ordinal position in the document, 0-based. */
	index: number;
	/** Heading text with the leading #'s and whitespace stripped. */
	title: string;
	/** The heading line exactly as it appears in the file. */
	headingRaw: string;
	/** 0-based line number of the heading. */
	headingLine: number;
	/** Body lines (everything after the heading), joined with "\n". */
	body: string;
	/** Heading line + body, joined with "\n" — the whole card as text. */
	raw: string;
	/** [startLine, endLine) covering heading + body. */
	startLine: number;
	endLine: number;
}

/** obsidian's `moment` re-export is typed as a namespace; this is the callable form. */
const mo = moment as unknown as (input?: string, format?: string) => { format: (format: string) => string };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;

export function parseSections(lines: string[], level: number): Section[] {
	const sections: Section[] = [];
	let inFence = false;
	let inFrontmatter = false;

	// A heading of rank <= level closes the current section.
	const starts: { line: number; title: string; headingRaw: string }[] = [];
	const closers: number[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (i === 0 && line.trim() === "---") {
			inFrontmatter = true;
			continue;
		}
		if (inFrontmatter) {
			if (line.trim() === "---") inFrontmatter = false;
			continue;
		}
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		const match = HEADING_RE.exec(line);
		if (!match) continue;

		const rank = match[1].length;
		if (rank === level) {
			starts.push({ line: i, title: match[2].trim(), headingRaw: line });
		} else if (rank < level) {
			closers.push(i);
		}
	}

	// Starts are in ascending line order, so a single pointer replaces a scan per start.
	let closerIndex = 0;
	for (let s = 0; s < starts.length; s++) {
		const start = starts[s];
		const nextStart = s + 1 < starts.length ? starts[s + 1].line : lines.length;
		while (closerIndex < closers.length && closers[closerIndex] <= start.line) closerIndex++;
		const nextCloser = closerIndex < closers.length ? closers[closerIndex] : undefined;
		const end = Math.min(nextStart, nextCloser ?? lines.length);
		const bodyLines = lines.slice(start.line + 1, end);

		// Trim trailing blank lines so cards don't carry dead space.
		while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();

		sections.push({
			index: s,
			title: start.title,
			headingRaw: start.headingRaw,
			headingLine: start.line,
			body: bodyLines.join("\n"),
			raw: [start.headingRaw, ...bodyLines].join("\n"),
			startLine: start.line,
			endLine: start.line + 1 + bodyLines.length,
		});
	}

	return sections;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortSections(sections: Section[], order: SortOrder): Section[] {
	const sorted = sections.slice();
	if (order === "asc") sorted.sort((a, b) => collator.compare(a.title, b.title));
	else if (order === "desc") sorted.sort((a, b) => collator.compare(b.title, a.title));
	return sorted;
}

/** First line after any frontmatter block — the top of the note's real content. */
function firstContentLine(lines: string[]): number {
	if (lines[0]?.trim() !== "---") return 0;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") return i + 1;
	}
	return 0;
}

/**
 * Which way the file's existing sections already run. Daily-note files are usually
 * newest-first (descending), so "logical order" has to follow the file, not assume A→Z.
 */
export function detectDirection(titles: string[]): "asc" | "desc" {
	let asc = 0;
	let desc = 0;
	for (let i = 1; i < titles.length; i++) {
		const cmp = collator.compare(titles[i - 1], titles[i]);
		if (cmp < 0) asc++;
		else if (cmp > 0) desc++;
	}
	return desc > asc ? "desc" : "asc";
}

/** Line at which a new section titled `title` should be inserted. */
export function insertionLine(lines: string[], level: number, title: string, placement: Placement): number {
	const sections = parseSections(lines, level);

	if (!sections.length) return placement === "top" ? firstContentLine(lines) : lines.length;

	if (placement === "top") return sections[0].startLine;
	if (placement === "bottom") return sections[sections.length - 1].endLine;

	const direction = detectDirection(sections.map((s) => s.title));
	for (const section of sections) {
		const cmp = collator.compare(title, section.title);
		if (direction === "asc" ? cmp < 0 : cmp > 0) return section.startLine;
	}
	return sections[sections.length - 1].endLine;
}

/**
 * Does a date heading refer to today? Matches an ISO date anywhere in the heading
 * (`### 2026-08-06, Thursday`) or the heading format configured for new cards
 * (so `### Thursday, August 6` works if that's how the note is written).
 */
export function isTodayTitle(title: string, todayISO: string, todayFormatted: string): boolean {
	if (title.includes(todayISO)) return true;
	const formatted = todayFormatted.trim().toLowerCase();
	return formatted.length > 3 && title.toLowerCase().includes(formatted);
}

/** Normalize a typed heading: keep the user's #'s if present, otherwise apply the view's level. */
export function normalizeHeading(text: string, fallbackLevel: number): string {
	const trimmed = text.trim();
	if (/^#{1,6}\s+\S/.test(trimmed)) return trimmed;
	const bare = trimmed.replace(/^#+\s*/, "");
	return `${"#".repeat(fallbackLevel)} ${bare}`;
}

/**
 * Find a section again in freshly-read lines. Prefers an exact content match, then the
 * closest of several identical blocks, then a unique heading — so a write can't land on
 * the wrong section if the file changed since the card was rendered.
 */
function locateSection(sections: Section[], original: Section): Section | undefined {
	const byContent = sections.filter((s) => s.raw === original.raw);
	if (byContent.length === 1) return byContent[0];
	if (byContent.length > 1) {
		return byContent.reduce((best, s) =>
			Math.abs(s.index - original.index) < Math.abs(best.index - original.index) ? s : best,
		);
	}
	const byHeading = sections.filter((s) => s.headingRaw === original.headingRaw);
	return byHeading.length === 1 ? byHeading[0] : undefined;
}

/** One draggable unit of a section body: a top-level list item (with its children) or a paragraph. */
export interface BodyBlock {
	kind: "item" | "paragraph" | "other";
	/** [start, end) offsets into the section's body lines. */
	start: number;
	end: number;
}

const LIST_START_RE = /^(?:[-*+]|\d+[.)])\s+/;

/**
 * Split a section body into blocks, mirroring what MarkdownRenderer turns into top-level
 * elements: "item" = a column-0 list line plus its indented children (rendered <li>),
 * "paragraph" = consecutive prose lines (rendered <p>), and "other" = everything that
 * renders as neither — fences, headings, blockquotes, tables, raw HTML — which is not
 * draggable and keeps the DOM↔source mapping honest.
 */
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
		} else if (LIST_START_RE.test(line)) {
			i++;
			// children: every following non-blank line that is indented deeper
			while (i < body.length && !isBlank(body[i]) && /^[\t ]/.test(body[i])) i++;
			blocks.push({ kind: "item", start, end: i });
		} else if (/^[\t ]/.test(line)) {
			// stray indented run (indent-style code, continuation) — not draggable
			while (i < body.length && !isBlank(body[i]) && /^[\t ]/.test(body[i])) i++;
			blocks.push({ kind: "other", start, end: i });
		} else {
			i++;
			while (
				i < body.length &&
				!isBlank(body[i]) &&
				!LIST_START_RE.test(body[i]) &&
				!FENCE_RE.test(body[i]) &&
				!HEADING_RE.test(body[i]) &&
				!/^\s*>/.test(body[i]) &&
				!/^\s*\|/.test(body[i])
			) {
				i++;
			}
			blocks.push({ kind: "paragraph", start, end: i });
		}
	}
	return blocks;
}

/** The blocks a user can drag, in the same order the eligible DOM elements render. */
export function movableBlocks(body: string[]): BodyBlock[] {
	return sectionBlocks(body).filter((b) => b.kind !== "other");
}

/**
 * Move one movable block from a section to a position in another (or the same) section:
 * before that section's movable block `beforeBlockIndex`, or to its end when null.
 * The block's lines move byte-for-byte; paragraphs gain blank separators at the seams,
 * and a doubled blank left at the removal point is collapsed. Null = no-op/invalid.
 */
export function moveBlock(
	lines: string[],
	level: number,
	fromSectionIndex: number,
	blockIndex: number,
	toSectionIndex: number,
	beforeBlockIndex: number | null,
): string[] | null {
	const sections = parseSections(lines, level);
	const from = sections[fromSectionIndex];
	const to = sections[toSectionIndex];
	if (!from || !to) return null;

	const fromBody = lines.slice(from.startLine + 1, from.endLine);
	const block = movableBlocks(fromBody)[blockIndex];
	if (!block) return null;
	const absStart = from.startLine + 1 + block.start;
	const absEnd = from.startLine + 1 + block.end;
	const blockLines = lines.slice(absStart, absEnd);

	let insertAbs: number;
	if (beforeBlockIndex === null) {
		insertAbs = to.endLine;
	} else {
		const toBody = lines.slice(to.startLine + 1, to.endLine);
		const anchor = movableBlocks(toBody)[beforeBlockIndex];
		insertAbs = anchor ? to.startLine + 1 + anchor.start : to.endLine;
	}
	// Dropping a block onto its own position is a no-op.
	if (fromSectionIndex === toSectionIndex && insertAbs >= absStart && insertAbs <= absEnd) return null;

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

/** Move a block at write time, re-locating both sections and verifying the block's text. */
async function moveBlockInFile(
	app: App,
	file: TFile,
	level: number,
	moved: Section,
	blockIndex: number,
	expectedBlockText: string,
	targetSection: Section,
	beforeBlockIndex: number | null,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const sections = parseSections(lines, level);
		const from = locateSection(sections, moved);
		const to = locateSection(sections, targetSection);
		if (!from || !to) {
			ok = false;
			return data;
		}
		const body = lines.slice(from.startLine + 1, from.endLine);
		const block = movableBlocks(body)[blockIndex];
		if (!block || body.slice(block.start, block.end).join("\n") !== expectedBlockText) {
			ok = false; // the block moved or changed since the drag started — refuse
			return data;
		}
		const result = moveBlock(lines, level, from.index, blockIndex, to.index, beforeBlockIndex);
		return result ? result.join(eol) : data;
	});

	return ok;
}

/** `- [ ] text`, `* [x] text`, `1. [ ] text` — prefix, mark, closing bracket, text. */
const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])(.*)$/;
const DONE_DATE_RE = /\s*✅\s*\d{4}-\d{2}-\d{2}/g;

/**
 * Indexes of the task lines in `lines`, in document order and skipping fenced code —
 * the same order and set that MarkdownRenderer turns into checkboxes.
 */
export function taskLineIndexes(lines: string[]): number[] {
	const out: number[] = [];
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		if (FENCE_RE.test(lines[i])) {
			inFence = !inFence;
			continue;
		}
		if (!inFence && TASK_RE.test(lines[i])) out.push(i);
	}
	return out;
}

/**
 * Flip one task line. Checking optionally appends an Obsidian Tasks style done date
 * (`✅ 2026-08-06`); unchecking always strips one so the line round-trips cleanly.
 */
export function toggleTaskLine(line: string, todayISO: string, addDoneDate: boolean): string {
	const m = TASK_RE.exec(line);
	if (!m) return line;

	const [, prefix, mark, close, rest] = m;
	const text = rest.replace(DONE_DATE_RE, "");

	if (mark.toLowerCase() === "x") return `${prefix} ${close}${text}`;
	return `${prefix}x${close}${addDoneDate ? `${text.trimEnd()} ✅ ${todayISO}` : text}`;
}

/**
 * Toggle the nth task of a section, matching the nth checkbox rendered in its card.
 * Returns the new checked state, or null if the section or task couldn't be located.
 */
async function toggleTaskInFile(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	nth: number,
	todayISO: string,
	addDoneDate: boolean,
): Promise<boolean | null> {
	let result: boolean | null = null;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateSection(parseSections(lines, level), original);
		if (!target) return data;

		const body = lines.slice(target.startLine + 1, target.endLine);
		const tasks = taskLineIndexes(body);
		if (nth >= tasks.length) return data;

		const at = target.startLine + 1 + tasks[nth];
		const updated = toggleTaskLine(lines[at], todayISO, addDoneDate);
		if (updated === lines[at]) return data;

		lines[at] = updated;
		result = /^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]/.test(updated);
		return lines.join(eol);
	});

	return result;
}

/**
 * Heading level to show a note at. Honours `preferred` whenever that level exists in the
 * note; otherwise falls back to the level with the most sections (ties go to the shallower
 * one), so a note that has no H3s doesn't open as an empty card wall.
 */
export function pickHeadingLevel(lines: string[], preferred: number): number {
	// One scan tallies every level at once; parseSections per level cost up to 7 passes.
	const counts = [0, 0, 0, 0, 0, 0, 0];
	let inFence = false;
	let inFrontmatter = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (i === 0 && line.trim() === "---") {
			inFrontmatter = true;
			continue;
		}
		if (inFrontmatter) {
			if (line.trim() === "---") inFrontmatter = false;
			continue;
		}
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const match = HEADING_RE.exec(line);
		if (match) counts[match[1].length]++;
	}

	if (counts[preferred] > 0) return preferred;

	let best = preferred;
	let bestCount = 0;
	for (let level = 1; level <= 6; level++) {
		if (counts[level] > bestCount) {
			best = level;
			bestCount = counts[level];
		}
	}
	return bestCount > 0 ? best : preferred;
}

/**
 * Which existing cards a re-render can keep. Cards are matched to sections by exact raw
 * text, FIFO for duplicates; the result maps each next-section index to the previous card
 * index it can reuse, or -1 when it must be built. Reuse means an edit to one section
 * re-renders one card instead of the whole wall.
 */
export function planCardReuse(prevRaws: string[], nextRaws: string[]): number[] {
	const pool = new Map<string, number[]>();
	prevRaws.forEach((raw, i) => {
		const list = pool.get(raw);
		if (list) list.push(i);
		else pool.set(raw, [i]);
	});
	return nextRaws.map((raw) => pool.get(raw)?.shift() ?? -1);
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

/** A single indentation edit for the card editor's textarea. */
export interface TabEdit {
	/** Replace [start, end) of the text with `insert`... */
	start: number;
	end: number;
	insert: string;
	/** ...then select this range. */
	selStart: number;
	selEnd: number;
}

/**
 * What pressing Tab (or Shift+Tab) in the editor should do to the text. A bare caret gets
 * a tab character; a selection (or any Shift+Tab) indents or outdents whole lines, one tab
 * — or up to four leading spaces — per line. Returns null when the edit would change nothing.
 */
export function computeTabEdit(text: string, selStart: number, selEnd: number, outdent: boolean): TabEdit | null {
	if (!outdent && selStart === selEnd) {
		return { start: selStart, end: selEnd, insert: "\t", selStart: selStart + 1, selEnd: selStart + 1 };
	}

	// Whole lines: from the start of the line containing selStart to the end of the line
	// containing selEnd — except a selection ending exactly at a line start leaves that
	// line out, which is how every code editor treats it.
	const lineStart = text.lastIndexOf("\n", selStart - 1) + 1;
	const effEnd = selEnd > selStart && text[selEnd - 1] === "\n" ? selEnd - 1 : selEnd;
	const lineEndIdx = text.indexOf("\n", effEnd);
	const regionEnd = lineEndIdx === -1 ? text.length : lineEndIdx;

	const lines = text.slice(lineStart, regionEnd).split("\n");
	const newLines = outdent
		? lines.map((line) => (line.startsWith("\t") ? line.slice(1) : line.replace(/^ {1,4}/, "")))
		: lines.map((line) => (line.length ? "\t" + line : line));
	const insert = newLines.join("\n");
	if (insert === text.slice(lineStart, regionEnd)) return null;

	if (selStart === selEnd) {
		// Caret-only outdent: keep the caret on the same spot in the line.
		const removed = lines[0].length - newLines[0].length;
		const caret = Math.max(lineStart, selStart - removed);
		return { start: lineStart, end: regionEnd, insert, selStart: caret, selEnd: caret };
	}
	return { start: lineStart, end: regionEnd, insert, selStart: lineStart, selEnd: lineStart + insert.length };
}

/** A card's placement on the Custom Grid canvas, in px. */
export interface CardRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Canvas geometry: snap step matches the dot pattern; sizes are multiples of it. */
const CUSTOM_SNAP = 24;
const CUSTOM_GAP = 12;
const CUSTOM_MIN_W = 192;
const CUSTOM_MIN_H = 120;
const CUSTOM_DEFAULT_W = 288;
const CUSTOM_DEFAULT_H = 192;

/** Round a rect onto the snap grid, clamped to the canvas and the minimum card size. */
export function snapRect(rect: CardRect, step: number, minW: number, minH: number): CardRect {
	const snap = (value: number) => Math.round(value / step) * step;
	return {
		x: Math.max(0, snap(rect.x)),
		y: Math.max(0, snap(rect.y)),
		w: Math.max(minW, snap(rect.w)),
		h: Math.max(minH, snap(rect.h)),
	};
}

/** Cards on the canvas may neither overlap nor touch: `gap` px of air is required. */
export function rectsCollide(a: CardRect, b: CardRect, gap: number): boolean {
	return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/**
 * The nearest legal spot at or below the requested position: the rect marches down in
 * gap-sized steps until it clears every other card, falling back to below the lowest one.
 */
export function findFreeSpot(want: CardRect, others: CardRect[], gap: number, step = gap): CardRect {
	const spot: CardRect = { ...want, x: Math.max(0, Math.round(want.x)), y: Math.max(0, Math.round(want.y)) };
	for (let i = 0; i < 4000; i++) {
		if (!others.some((other) => rectsCollide(spot, other, gap))) return spot;
		spot.y += step;
	}
	const bottom = others.reduce((max, other) => Math.max(max, other.y + other.h), 0);
	return { ...spot, y: bottom + step };
}

/** One editor state: full text plus selection. */
export interface EditorSnapshot {
	value: string;
	selStart: number;
	selEnd: number;
}

/**
 * Undo/redo for the card editor's textarea. The editor owns its history because the
 * only alternative for keeping programmatic edits (Tab indentation) undoable was a
 * deprecated document API. Every change — typed or programmatic — is recorded,
 * and the editor's keydown/beforeinput handlers route undo/redo here.
 */
export class EditorHistory {
	private past: EditorSnapshot[];
	private future: EditorSnapshot[] = [];

	constructor(initial: EditorSnapshot) {
		this.past = [initial];
	}

	/** Record the state after a change. Same-text records just refresh the selection. */
	record(snap: EditorSnapshot): void {
		const top = this.past[this.past.length - 1];
		if (top.value === snap.value) {
			top.selStart = snap.selStart;
			top.selEnd = snap.selEnd;
			return;
		}
		this.past.push(snap);
		if (this.past.length > 200) this.past.shift();
		this.future = [];
	}

	/** The state to restore, or null when at the beginning. */
	undo(): EditorSnapshot | null {
		if (this.past.length < 2) return null;
		this.future.push(this.past.pop() as EditorSnapshot);
		return this.past[this.past.length - 1];
	}

	/** The state to restore, or null when there is nothing to redo. */
	redo(): EditorSnapshot | null {
		const next = this.future.pop();
		if (!next) return null;
		this.past.push(next);
		return next;
	}
}

/**
 * Moving a node in the DOM drops focus, which would eject you from a card editor when the
 * card is blown up. These remember the focused textarea and its selection, and put them back.
 */
function captureCaret(within: HTMLElement): { el: HTMLTextAreaElement; start: number; end: number } | null {
	const active = within.ownerDocument.activeElement;
	if (!(active instanceof HTMLTextAreaElement) || !within.contains(active)) return null;
	return { el: active, start: active.selectionStart, end: active.selectionEnd };
}

function restoreCaret(caret: { el: HTMLTextAreaElement; start: number; end: number } | null): void {
	if (!caret) return;
	caret.el.focus();
	caret.el.setSelectionRange(caret.start, caret.end);
}

/** Split a wikilink target into its file path and its `#heading` subpath. */
export function splitLinktext(linktext: string): [string, string] {
	const hash = linktext.indexOf("#");
	if (hash < 0) return [linktext.trim(), ""];
	return [linktext.slice(0, hash).trim(), linktext.slice(hash + 1).trim()];
}

/**
 * Which view a note opens with: its remembered settings first, then whatever the
 * workspace restored for this tab, then the global defaults (layout "grid" out of the box).
 */
export function resolveViewSettings(
	saved: Partial<ViewSettings> | undefined,
	fromState: Partial<ViewSettings>,
	defaults: ViewSettings,
): ViewSettings {
	return {
		layout: saved?.layout ?? fromState.layout ?? defaults.layout,
		headingLevel: saved?.headingLevel ?? fromState.headingLevel ?? defaults.headingLevel,
		sortOrder: saved?.sortOrder ?? fromState.sortOrder ?? defaults.sortOrder,
	};
}

/**
 * A wheel event's dominant delta in pixels. Mice report lines and some report pages,
 * so deltaMode has to be normalised before the value can be used as a scroll offset.
 */
export function wheelDeltaToPixels(
	evt: { deltaX: number; deltaY: number; deltaMode: number },
	pageSize: number,
	lineHeight = 16,
): number {
	const raw = Math.abs(evt.deltaY) >= Math.abs(evt.deltaX) ? evt.deltaY : evt.deltaX;
	if (evt.deltaMode === 1) return raw * lineHeight;
	if (evt.deltaMode === 2) return raw * pageSize;
	return raw;
}

/** Whether an element can still scroll vertically in the direction of `delta`. */
export function canScrollVertically(
	el: { scrollTop: number; scrollHeight: number; clientHeight: number },
	delta: number,
): boolean {
	if (el.scrollHeight <= el.clientHeight + 1) return false;
	if (delta < 0) return el.scrollTop > 0;
	if (delta > 0) return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
	return false;
}

/**
 * [start, end) covering a section plus the blank separator lines that followed it, so
 * deleting a card doesn't leave doubled blank lines between its neighbours.
 */
export function sectionDeleteRange(lines: string[], target: Section): [number, number] {
	let end = target.endLine;
	while (end < lines.length && lines[end].trim() === "") end++;
	return [target.startLine, end];
}

/**
 * Move the section at fromIndex so it sits before the section at toBeforeIndex
 * (toBeforeIndex === sections.length means the end of the file). The moved chunk keeps
 * its own lines byte-for-byte; blank separators are added or dropped only at the seams.
 * Returns null for out-of-range indices or a move that changes nothing.
 */
export function moveSection(
	lines: string[],
	level: number,
	fromIndex: number,
	toBeforeIndex: number,
): string[] | null {
	const sections = parseSections(lines, level);
	if (fromIndex < 0 || fromIndex >= sections.length) return null;
	if (toBeforeIndex < 0 || toBeforeIndex > sections.length) return null;
	if (toBeforeIndex === fromIndex || toBeforeIndex === fromIndex + 1) return null;

	// Reordering must not change how the file ends (e.g. its trailing newline).
	let tailBlanks = 0;
	while (tailBlanks < lines.length && lines[lines.length - 1 - tailBlanks].trim() === "") tailBlanks++;

	const [start, end] = sectionDeleteRange(lines, sections[fromIndex]);
	const chunk = lines.slice(start, end);

	const insertLine = toBeforeIndex === sections.length ? lines.length : sections[toBeforeIndex].startLine;
	const rest = lines.slice(0, start).concat(lines.slice(end));
	const target = Math.min(insertLine > start ? insertLine - (end - start) : insertLine, rest.length);

	// Blank separators exist at both seams of the new position...
	if (chunk.length && chunk[chunk.length - 1].trim() !== "") chunk.push("");
	if (target > 0 && rest[target - 1].trim() !== "") chunk.unshift("");
	rest.splice(target, 0, ...chunk);

	// ...and the file's tail is normalised back to what it was.
	while (rest.length && rest[rest.length - 1].trim() === "") rest.pop();
	for (let i = 0; i < tailBlanks; i++) rest.push("");
	return rest;
}

/** Reorder at write time, re-locating both sections like every other write. */
async function moveSectionInFile(
	app: App,
	file: TFile,
	level: number,
	moved: Section,
	targetSection: Section,
	before: boolean,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const sections = parseSections(lines, level);
		const from = locateSection(sections, moved);
		const to = locateSection(sections, targetSection);
		if (!from || !to) {
			ok = false;
			return data;
		}
		const result = moveSection(lines, level, from.index, to.index + (before ? 0 : 1));
		return result ? result.join(eol) : data; // null = no-op move, not an error
	});

	return ok;
}

/** Remove a section from the file, re-locating it at write time like every other write. */
async function deleteSection(app: App, file: TFile, level: number, original: Section): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateSection(parseSections(lines, level), original);
		if (!target) {
			ok = false;
			return data;
		}
		const [start, end] = sectionDeleteRange(lines, target);
		lines.splice(start, end - start);
		return lines.join(eol);
	});

	return ok;
}

/** Insert a new, empty section and return the heading line as written. */
async function insertSection(
	app: App,
	file: TFile,
	headingRaw: string,
	placement: Placement,
): Promise<{ level: number; duplicate: boolean }> {
	const level = (/^#+/.exec(headingRaw)?.[0] ?? "###").length;
	const title = headingRaw.replace(/^#+\s*/, "").trim();
	let duplicate = false;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		duplicate = parseSections(lines, level).some((s) => s.title === title);
		const at = insertionLine(lines, level, title, placement);
		lines.splice(at, 0, headingRaw, "");
		return lines.join(eol);
	});

	return { level, duplicate };
}

/**
 * Replace one section in the file with new text, re-locating it at write time so a
 * card edit can't clobber changes made elsewhere in the file since it was rendered.
 */
async function writeSection(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	newRaw: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateSection(parseSections(lines, level), original);

		if (!target) {
			ok = false;
			return data;
		}

		const replacement = newRaw.split(/\r?\n/);
		lines.splice(target.startLine, target.endLine - target.startLine, ...replacement);
		return lines.join(eol);
	});

	if (!ok) {
		new Notice("Single File Section Cards: couldn't find that section — the file changed on disk. Edit not saved.");
	}
	return ok;
}

/** A rendered card. `holder.section` is swapped on reuse so closures never go stale. */
interface CardEntry {
	el: HTMLElement;
	scope: Component;
	holder: { section: Section };
	raw: string;
	/** Set while the body's markdown render is still owed; null once started. */
	renderBody: (() => Promise<void>) | null;
}

interface CardsViewState {
	filePath?: string;
	headingLevel?: number;
	sortOrder?: SortOrder;
	layout?: Layout;
}

export class SectionCardsView extends ItemView {
	plugin: SectionCardsPlugin;

	filePath: string;
	headingLevel: number;
	sortOrder: SortOrder;
	layout: Layout;

	private toolbarEl!: HTMLElement;
	private gridEl!: HTMLElement;
	private countEl!: HTMLElement;
	/** One entry per card in DOM order: element, its render scope, and its section. */
	private cardEntries: CardEntry[] = [];
	/** Bumped per render; in-flight async work from an older render aborts on mismatch. */
	private renderGeneration = 0;
	/** Heading raw text of the card currently open in an editor, so refreshes don't nuke it. */
	private editingKey: string | null = null;
	/** The open editor's card and its finish function, so clicks elsewhere can commit it. */
	private activeEditor: { card: HTMLElement; finish: (save: boolean) => Promise<void> } | null = null;
	/** Watches cards for height changes (async markdown, images, embeds) to re-pack them. */
	private cardObserver: ResizeObserver | null = null;
	private repack = debounce(() => {
		if (!this.gridEl || this.viewIsHidden()) return; // zero sizes while backgrounded
		this.layoutMasonry();
		this.insertRowRules();
		if (this.layout === "custom") this.validateCustomSizes();
	}, 60, true);
	/** The card currently blown up over the others, if any. */
	private maximized: {
		card: HTMLElement;
		body: HTMLElement;
		button: HTMLElement;
		overlay: HTMLElement;
		marker: Comment;
		bodyMaxHeight: string;
		inlineRect: { left: string; top: string; width: string; height: string };
	} | null = null;
	/** The card being dragged for reordering, if any. */
	private dragging: { section: Section } | null = null;
	/** Custom Grid: placements for the current note, keyed by heading line. */
	private customPlacements: Record<string, CardRect> = {};
	private trayEl!: HTMLElement;
	/** Invisible marker that gives the canvas its scrollable size in every direction. */
	private canvasExtentEl!: HTMLElement;
	/** Custom Grid zoom factor (0.4–1.6), persisted per note. */
	private customZoom = 1;
	private zoomLabelEl: HTMLElement | null = null;
	/** Which note's placements are loaded; reloading on every refresh caused revert races. */
	private placementsLoadedFor: string | null = null;
	/** Custom Grid: the in-flight pointer drag (tile onto canvas, or placed card). */
	private pointerDrag: {
		kind: "tile" | "card";
		key: string;
		label: string;
		obstacles: CardRect[];
		w: number;
		h: number;
		offX: number;
		offY: number;
		startX: number;
		startY: number;
		active: boolean;
		ghost: HTMLElement | null;
		onMove: (evt: PointerEvent) => void;
		onUp: (evt: PointerEvent) => void;
	} | null = null;
	private swallowNextClick = false;
	/** Placement writes are immediate: a debounced save raced the next refresh's re-read. */
	private persistCustom = (): void => {
		const file = this.getFile();
		if (!file) return;
		void this.plugin.saveCustomGrid(
			file.path,
			{ ...this.customPlacements },
			{ layout: this.layout, headingLevel: this.headingLevel, sortOrder: this.sortOrder },
			this.customZoom,
		);
	};
	/** The block (task/paragraph) being dragged between cards, if any. */
	private draggingBlock: {
		holder: { section: Section };
		blockIndex: number;
		blockText: string;
		el: HTMLElement;
	} | null = null;
	/** The card currently showing a drop indicator. */
	private dropMarker: HTMLElement | null = null;
	/** Heading of a just-created section, to be opened for editing after the next render. */
	private pendingEditHeading: string | null = null;
	/** Heading of a card that should still be blown up after the next render. */
	private pendingMaximizeHeading: string | null = null;
	private cardsByHeading = new Map<string, { el: HTMLElement; section: Section }>();

	constructor(leaf: WorkspaceLeaf, plugin: SectionCardsPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.filePath = plugin.settings.filePath;
		this.headingLevel = plugin.settings.headingLevel;
		this.sortOrder = plugin.settings.sortOrder;
		this.layout = plugin.settings.layout;
		this.navigation = false;
	}

	getViewType(): string {
		return VIEW_TYPE_SECTION_CARDS;
	}

	getDisplayText(): string {
		const base = this.filePath.split("/").pop() ?? this.filePath;
		return `Cards: ${base.replace(/\.md$/, "")}`;
	}

	getIcon(): string {
		return DECK_ICON;
	}

	getState(): Record<string, unknown> {
		return {
			filePath: this.filePath,
			headingLevel: this.headingLevel,
			sortOrder: this.sortOrder,
			layout: this.layout,
		};
	}

	async setState(state: CardsViewState, result: unknown): Promise<void> {
		if (state?.filePath) this.filePath = state.filePath;
		// @ts-ignore — base signature varies across API versions
		await super.setState(state, result);
		this.applyStoredView({
			layout: state?.layout,
			headingLevel: state?.headingLevel,
			sortOrder: state?.sortOrder,
		});
		await this.syncView();
	}

	/** Vault path this view's note is stored under — the key for its remembered view. */
	private currentPath(): string {
		return this.getFile()?.path ?? this.filePath;
	}

	/** Adopt the note's remembered view, falling back to restored tab state, then defaults. */
	private applyStoredView(fromState: Partial<ViewSettings> = {}): void {
		const resolved = resolveViewSettings(this.plugin.getStoredView(this.currentPath()), fromState, {
			layout: this.plugin.settings.layout,
			headingLevel: this.plugin.settings.headingLevel,
			sortOrder: this.plugin.settings.sortOrder,
		});
		this.layout = resolved.layout;
		this.headingLevel = resolved.headingLevel;
		this.sortOrder = resolved.sortOrder;
	}

	/** Remember the current view for the current note (in the plugin's data, not the note). */
	private rememberView(): void {
		void this.plugin.storeView(this.currentPath(), {
			layout: this.layout,
			headingLevel: this.headingLevel,
			sortOrder: this.sortOrder,
		});
	}

	/**
	 * Single path that puts the layout class, the toolbar controls and the rendered cards
	 * on the same state. Obsidian restores a tab by constructing the view (settings
	 * defaults), then calling setState with the persisted state — so both entry points
	 * must re-apply everything, or the dropdowns end up describing a different layout
	 * than the one on screen. The class is applied *before* rendering because the masonry
	 * pass measures card heights under the layout's CSS.
	 */
	private async syncView(): Promise<void> {
		if (!this.toolbarEl || !this.gridEl) return;
		this.applyLayoutClass();
		this.buildToolbar();
		await this.refresh();
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("section-cards-view");
		this.toolbarEl = this.contentEl.createDiv({ cls: "section-cards-toolbar" });
		// Clicking anywhere in the toolbar returns an editing card to its preview.
		this.registerDomEvent(this.toolbarEl, "click", () => {
			const open = this.activeEditor;
			if (open) void open.finish(true);
		});
		this.gridEl = this.contentEl.createDiv({ cls: "section-cards-grid" });
		this.canvasExtentEl = this.gridEl.createDiv({ cls: "section-cards-canvas-extent" });
		this.trayEl = this.contentEl.createDiv({ cls: "section-cards-tray" });

		// Zoom controls, pinned to the canvas pane's bottom-left (Custom Grid only).
		const zoomBar = this.contentEl.createDiv({ cls: "section-cards-zoom" });
		const zoomOut = zoomBar.createEl("button", { text: "−" });
		zoomOut.setAttr("aria-label", "Zoom out");
		zoomOut.addEventListener("click", () => this.setCustomZoom(this.customZoom - 0.1));
		this.zoomLabelEl = zoomBar.createEl("button", { cls: "section-cards-zoom-label", text: "100%" });
		this.zoomLabelEl.setAttr("aria-label", "Reset zoom");
		this.zoomLabelEl.addEventListener("click", () => this.setCustomZoom(1));
		const zoomIn = zoomBar.createEl("button", { text: "+" });
		zoomIn.setAttr("aria-label", "Zoom in");
		zoomIn.addEventListener("click", () => this.setCustomZoom(this.customZoom + 0.1));
		this.registerWheelPan();
		this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Escape" || !this.maximized) return;
			// A card editor's own Escape handling wins.
			if ((evt.target as HTMLElement | null)?.tagName === "TEXTAREA") return;
			evt.preventDefault();
			this.closeMaximized();
		});
		// Ctrl/⌘+Enter must survive Obsidian's own hotkey dispatch, which runs before any
		// DOM handler and consumes matching combos — so the shortcut is also registered in
		// the view's keymap scope, which outranks global hotkeys while this view is active.
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "Enter", (evt) => {
			const open = this.activeEditor;
			if (!open) return true; // not editing: let the combo pass through
			evt.preventDefault();
			void open.finish(true);
			return false; // consumed
		});

		// Ctrl/⌘+Enter saves the open editor from anywhere: clicking the card's padding or
		// a button moves focus off the textarea, and the textarea-level handler then never
		// hears the shortcut. finish() is settled-guarded, so both firing is harmless.
		this.registerDomEvent(
			document,
			"keydown",
			(evt: KeyboardEvent) => {
				const open = this.activeEditor;
				if (!open) return;
				if (evt.key === "Enter" && (evt.ctrlKey || evt.metaKey)) {
					evt.preventDefault();
					void open.finish(true);
				}
			},
			{ capture: true },
		);

		// A click right after a completed pointer drag is that drag's release, not a
		// click — swallow it so dropping a card can't maximize it or open an editor.
		this.registerDomEvent(
			this.contentEl,
			"click",
			(evt: MouseEvent) => {
				if (!this.swallowNextClick) return;
				this.swallowNextClick = false;
				evt.preventDefault();
				evt.stopImmediatePropagation();
			},
			{ capture: true },
		);

		// Middle-click drag pans the Custom Grid canvas.
		this.registerDomEvent(this.gridEl, "pointerdown", (evt: PointerEvent) => {
			if (this.layout !== "custom" || evt.button !== 1) return;
			evt.preventDefault(); // no autoscroll widget, no card handlers
			const startX = evt.clientX;
			const startY = evt.clientY;
			const startLeft = this.gridEl.scrollLeft;
			const startTop = this.gridEl.scrollTop;
			this.gridEl.addClass("is-panning");
			const move = (e: PointerEvent) => {
				this.gridEl.scrollLeft = startLeft - (e.clientX - startX);
				this.gridEl.scrollTop = startTop - (e.clientY - startY);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				window.removeEventListener("pointercancel", up);
				this.gridEl.removeClass("is-panning");
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			window.addEventListener("pointercancel", up);
		});

		// Clicking empty grid/canvas space (any layout) or the tray settles the open
		// editor, the same as clicking another card or the toolbar.
		this.registerDomEvent(this.gridEl, "click", (evt: MouseEvent) => {
			const open = this.activeEditor;
			if (!open) return;
			const insideCard = (evt.target as HTMLElement | null)?.closest(".section-card");
			if (insideCard === open.card) return; // clicks inside the editor stay there
			if (!insideCard) void open.finish(true); // another card's handler commits itself
		});
		this.registerDomEvent(this.trayEl, "click", () => {
			const open = this.activeEditor;
			if (open) void open.finish(true);
		});

		this.applyStoredView();
		await this.syncView();
	}

	/**
	 * Vertical layout only: the wheel pans the row sideways, since there is nothing to
	 * scroll vertically. Bound to the whole view rather than just the card row, so it also
	 * works with the pointer over the toolbar (file picker and view dropdowns). A card body
	 * that can still scroll keeps the wheel first, so a long day's tasks stay readable;
	 * once it hits its end the row takes over.
	 */
	private registerWheelPan(): void {
		this.registerDomEvent(
			this.contentEl,
			"wheel",
			(evt: WheelEvent) => {
				if (this.layout !== "vertical" || !this.gridEl) return;
				if (evt.ctrlKey || evt.metaKey) return; // zoom gestures

				const step = wheelDeltaToPixels(evt, this.gridEl.clientWidth);
				if (!step) return;

				const body = (evt.target as HTMLElement | null)?.closest<HTMLElement>(".section-card-body");
				if (body && canScrollVertically(body, step)) return;

				evt.preventDefault();
				this.gridEl.scrollLeft += step;
			},
			{ passive: false },
		);
	}

	/** The layout lives as a class on the view root so CSS can restyle grid *and* scrolling. */
	private applyLayoutClass(): void {
		for (const name of ["grid", "aligned", "tight", "horizontal", "vertical", "custom"]) {
			this.contentEl.toggleClass(`is-layout-${name}`, this.layout === name);
		}
	}

	async onClose(): Promise<void> {
		for (const entry of this.cardEntries) this.removeChild(entry.scope);
		this.cardEntries = [];
		this.cardObserver?.disconnect();
		this.cardObserver = null;
	}

	private discardCard(entry: CardEntry): void {
		this.removeChild(entry.scope);
		entry.el.remove();
	}

	private clearAllCards(): void {
		for (const entry of this.cardEntries) this.removeChild(entry.scope);
		this.cardEntries = [];
		this.cardsByHeading.clear();
		this.gridEl.empty();
	}

	/** Today's date keys, computed once per render instead of once per card. */
	private todayKeys(): { iso: string; formatted: string } | null {
		if (this.plugin.settings.headingType !== "dates") return null;
		const now = mo();
		return { iso: now.format("YYYY-MM-DD"), formatted: now.format(this.plugin.settings.newCardFormat) };
	}

	/** The card-body height cap for the current layout; also re-applied to reused cards. */
	private applyBodyHeight(bodyEl: HTMLElement | null): void {
		if (!bodyEl) return;
		const cap = this.plugin.settings.cardMaxHeight;
		const target =
			this.layout === "vertical" || this.layout === "custom"
				? ""
				: `${this.layout === "tight" ? Math.min(cap, 190) : cap}px`;
		// Refresh re-applies this to every reused card; identical values skip the write.
		if (bodyEl.style.maxHeight !== target) bodyEl.setCssStyles({ maxHeight: target });
	}

	/** Rendered task checkboxes come back disabled, and disabled inputs never fire clicks. */
	private enableCheckboxes(): void {
		for (const box of Array.from(
			this.gridEl.querySelectorAll<HTMLInputElement>(".section-card-body input[type=checkbox]"),
		)) {
			box.removeAttribute("disabled");
			box.removeAttribute("readonly");
		}
	}

	/** The rendered elements that correspond 1:1 with a section's movable blocks. */
	private eligibleBlockEls(bodyEl: HTMLElement): HTMLElement[] {
		return Array.from(
			bodyEl.querySelectorAll<HTMLElement>(":scope > p, :scope > ul > li, :scope > ol > li"),
		);
	}

	/** Post-render pass over every card body: live checkboxes + draggable blocks. */
	private prepareBodies(): void {
		this.enableCheckboxes();
		for (const bodyEl of Array.from(this.gridEl.querySelectorAll<HTMLElement>(".section-card-body"))) {
			for (const el of this.eligibleBlockEls(bodyEl)) {
				el.draggable = true;
				el.addClass("sc-block");
			}
		}
	}

	/** Run a card's owed body render, exactly once, unless the card became an editor. */
	private async runBodyRender(entry: CardEntry): Promise<void> {
		const run = entry.renderBody;
		if (!run) return;
		// An editing card's body is a textarea; the card is rebuilt after the edit anyway.
		if (entry.el.hasClass("is-editing")) return;
		entry.renderBody = null;
		await run();
	}

	/**
	 * Render the bodies that didn't make the synchronous budget, a batch per idle slot.
	 * The ResizeObserver already re-packs as their heights land. Aborts (leaving each
	 * card's renderBody owed for the next render) if a newer render supersedes this one.
	 */
	private scheduleDeferredRenders(entries: CardEntry[], gen: number): void {
		const idle: (cb: () => void) => void =
			typeof window.requestIdleCallback === "function"
				? (cb) => window.requestIdleCallback(cb, { timeout: 200 })
				: (cb) => window.setTimeout(cb, 16);
		const step = (): void => {
			if (gen !== this.renderGeneration) return;
			const batch = entries.splice(0, DEFERRED_RENDER_BATCH);
			if (!batch.length) return;
			void Promise.all(batch.map((entry) => this.runBodyRender(entry))).then(() => {
				if (gen !== this.renderGeneration) return;
				this.prepareBodies();
				this.repack();
				if (entries.length) idle(step);
			});
		};
		idle(step);
	}

	/**
	 * Masonry packing. The grid uses many short implicit rows; each card is given a
	 * `grid-row-end: span N` covering its own height plus one gap, so a card only ever
	 * occupies the vertical space it needs and the next card in that column starts
	 * directly beneath it instead of at a shared row boundary.
	 */
	private layoutMasonry(): void {
		const grid = this.gridEl;
		if (!grid || !grid.isConnected) return;

		// Masonry spans only apply to the packed column layouts. The aligned grid wants
		// real auto rows, and the sideways layout is a flex row, so clear any leftovers.
		if (this.layout === "vertical" || this.layout === "aligned" || this.layout === "custom") {
			for (const card of Array.from(grid.children) as HTMLElement[]) {
				// Reading inline style is free; rewriting an already-empty one is not.
				if (card.style.gridRowEnd) card.setCssStyles({ gridRowEnd: "" });
			}
			return;
		}

		const style = window.getComputedStyle(grid);
		const rowHeight = parseFloat(style.gridAutoRows) || 4;
		const gap = parseFloat(style.rowGap) || 0;
		const cardGap = parseFloat(style.getPropertyValue("--sc-card-gap")) || 12;

		// Read every height first, then write every span. Interleaving the two forces a
		// full reflow per card — ~150 reflows per pack on a year of daily notes.
		// (Cards are `align-items: start` grid items, so their box height is their content
		// height regardless of the span currently assigned.)
		const cards = (Array.from(grid.children) as HTMLElement[]).filter((card) =>
			card.hasClass("section-card"),
		);
		const heights = cards.map((card) => card.getBoundingClientRect().height);
		cards.forEach((card, i) => {
			const span = Math.max(1, Math.ceil((heights[i] + cardGap) / (rowHeight + gap)));
			card.setCssStyles({ gridRowEnd: `span ${span}` });
		});
	}

	/**
	 * Grid Aligned only: put a full-width divider between rows. CSS can't target row
	 * boundaries, so a rule element is inserted after every Nth card, where N is the
	 * grid's current track count. Because the rule spans all columns it also *enforces*
	 * rows of N, and it is rebuilt whenever the column count changes.
	 */
	private insertRowRules(): void {
		const grid = this.gridEl;
		if (!grid || !grid.isConnected) return;

		for (const old of Array.from(grid.querySelectorAll(".section-cards-row-rule"))) old.remove();
		if (this.layout !== "aligned") return;

		const cards = (Array.from(grid.children) as HTMLElement[]).filter((c) => c.hasClass("section-card"));
		if (cards.length < 2) return;

		const columns = window
			.getComputedStyle(grid)
			.gridTemplateColumns.split(" ")
			.filter((t) => t.trim().length).length;
		if (columns < 1 || columns >= cards.length) return;

		for (let i = columns; i < cards.length; i += columns) {
			const rule = createDiv();
			rule.className = "section-cards-row-rule";
			grid.insertBefore(rule, cards[i]);
		}
	}

	private observeCards(): void {
		this.cardObserver?.disconnect();
		if (!this.gridEl) return;

		if (typeof ResizeObserver === "undefined") return;
		this.cardObserver = new ResizeObserver(() => {
			// Resize feedback must be immediate; the debounced repack settles it after.
			if (this.layout === "custom") this.previewCustomResize();
			this.repack();
		});
		for (const card of Array.from(this.gridEl.children)) {
			if ((card as HTMLElement).hasClass("section-card")) this.cardObserver.observe(card);
		}
		// The grid itself changes width when the pane resizes, which changes column count.
		this.cardObserver.observe(this.gridEl);
	}

	private buildToolbar() {
		const bar = this.toolbarEl;
		if (!bar) return;
		bar.empty();

		const fileBtn = bar.createEl("button", { cls: "section-cards-file-btn" });
		fileBtn.setAttr("aria-label", "Pick a different note");
		fileBtn.createSpan({ text: this.filePath || "(no file)" });
		fileBtn.addEventListener("click", () => {
			new FileSuggestModal(this.app, this.plugin, (path) => void this.navigateTo(path)).open();
		});

		const spacer = bar.createDiv({ cls: "section-cards-spacer" });
		this.countEl = spacer.createSpan({ cls: "section-cards-count" });

		const levelWrap = bar.createDiv({ cls: "section-cards-control" });
		levelWrap.createSpan({ text: "Heading", cls: "section-cards-label" });
		const levelSelect = levelWrap.createEl("select", { cls: "dropdown" });
		for (let l = 1; l <= 6; l++) {
			levelSelect.createEl("option", { text: `H${l}`, value: String(l) });
		}
		levelSelect.value = String(this.headingLevel);
		levelSelect.addEventListener("change", () => {
			this.headingLevel = Number(levelSelect.value);
			this.rememberView();
			void this.refresh().then(() => this.app.workspace.requestSaveLayout());
		});

		const layoutWrap = bar.createDiv({ cls: "section-cards-control" });
		layoutWrap.createSpan({ text: "Layout", cls: "section-cards-label" });
		const layoutSelect = layoutWrap.createEl("select", { cls: "dropdown" });
		for (const [value, label, hint] of LAYOUT_OPTIONS) {
			const option = layoutSelect.createEl("option", { text: label, value });
			option.title = hint;
		}
		layoutSelect.value = this.layout;
		layoutSelect.addEventListener("change", () => {
			this.layout = layoutSelect.value as Layout;
			this.rememberView();
			this.applyLayoutClass();
			void this.refresh().then(() => this.app.workspace.requestSaveLayout());
		});

		const sortWrap = bar.createDiv({ cls: "section-cards-control" });
		sortWrap.createSpan({ text: "Sort", cls: "section-cards-label" });
		const sortSelect = sortWrap.createEl("select", { cls: "dropdown" });
		sortSelect.createEl("option", { text: "A → Z", value: "asc" });
		sortSelect.createEl("option", { text: "Z → A", value: "desc" });
		sortSelect.createEl("option", { text: "Document order", value: "doc" });
		sortSelect.value = this.sortOrder;
		sortSelect.addEventListener("change", () => {
			this.sortOrder = sortSelect.value as SortOrder;
			this.rememberView();
			void this.refresh().then(() => this.app.workspace.requestSaveLayout());
		});

		const newBtn = bar.createEl("button", { cls: "section-cards-new-btn mod-cta", text: "+ New card" });
		newBtn.setAttr("aria-label", "Create a new section in this note");
		newBtn.addEventListener("click", () => this.promptNewCard());

		const refreshBtn = bar.createEl("button", { cls: "section-cards-icon-btn", text: "↻" });
		refreshBtn.setAttr("aria-label", "Reload from file");
		refreshBtn.addEventListener("click", () => void this.refresh());
	}

	/** Ask for a heading and placement, write the new section, then open it for editing. */
	promptNewCard(): void {
		const file = this.getFile();
		if (!file) {
			new Notice(`Single File Section Cards: can't find "${this.filePath}".`);
			return;
		}

		const defaultText = `${"#".repeat(this.headingLevel)} ${mo().format(this.plugin.settings.newCardFormat)}`;

		new NewCardModal(
			this.app,
			defaultText,
			this.plugin.settings.newCardPlacement,
			mo().format("YYYY-MM-DD"),
			(isoDate) =>
				`${"#".repeat(this.headingLevel)} ${mo(isoDate, "YYYY-MM-DD").format(this.plugin.settings.newCardFormat)}`,
			async (typed, placement) => {
				const headingRaw = normalizeHeading(typed, this.headingLevel);
				const level = (/^#+/.exec(headingRaw)?.[0] ?? "###").length;
				const title = headingRaw.replace(/^#+\s*/, "").trim();

				// A section with this heading may already exist — creating a second one is
				// almost never what was meant, so offer to edit the existing card instead.
				const content = await this.app.vault.cachedRead(file);
				const existing = parseSections(content.split(/\r?\n/), level).find(
					(section) => section.title === title,
				);
				if (existing) {
					new DuplicateCardModal(this.app, title, async () => {
						if (level === this.headingLevel) {
							this.pendingEditHeading = existing.headingRaw;
							await this.refresh();
						} else {
							// The existing section isn't a card at this view's level;
							// edit it in the note instead.
							await this.plugin.revealSection(file, existing.headingLine);
						}
					}).open();
					return;
				}

				const { level: written, duplicate } = await insertSection(this.app, file, headingRaw, placement);

				// Backstop: the file can change between the check above and the write.
				if (duplicate) {
					new Notice(`Heading already existed in ${file.basename} — added a second one.`);
				}
				if (written !== this.headingLevel) {
					new Notice(`Created an H${written} section; this view is showing H${this.headingLevel}.`);
				}

				// Open the new card's editor once it has been re-rendered.
				this.pendingEditHeading = headingRaw;
				await this.refresh();
			},
		).open();
	}

	/** Point this tab at another note, the way a link navigates a markdown tab. */
	async navigateTo(path: string, revealHeading?: string): Promise<void> {
		this.filePath = path;
		this.applyStoredView();
		await this.syncView();
		if (revealHeading) this.revealCard(revealHeading);
		this.app.workspace.requestSaveLayout();
	}

	getFile(): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(this.filePath);
		if (file instanceof TFile) return file;
		// Fall back to a fuzzy resolve so a bare filename works from anywhere in the vault.
		const resolved = this.app.metadataCache.getFirstLinkpathDest(this.filePath.replace(/\.md$/, ""), "");
		return resolved ?? null;
	}

	async refresh(): Promise<void> {
		if (!this.gridEl) return;

		this.closeMaximized();
		const gen = ++this.renderGeneration;

		const file = this.getFile();
		this.cardObserver?.disconnect();
		this.editingKey = null;
		this.activeEditor = null;

		if (!file) {
			this.countEl?.setText("");
			this.clearAllCards();
			const empty = this.gridEl.createDiv({ cls: "section-cards-empty" });
			empty.createEl("p", { text: `Can't find "${this.filePath}".` });
			empty.createEl("p", { text: "Pick a note from the toolbar, or set a default in the plugin settings." });
			return;
		}

		this.filePath = file.path;
		const content = await this.app.vault.cachedRead(file);
		if (gen !== this.renderGeneration) return;
		const lines = content.split(/\r?\n/);

		// A note the user hasn't set a view for opens at a level that actually has headings.
		if (!this.plugin.getStoredView(file.path)) {
			const level = pickHeadingLevel(lines, this.headingLevel);
			if (level !== this.headingLevel) {
				this.headingLevel = level;
				this.buildToolbar();
			}
		}

		const sections = parseSections(lines, this.headingLevel);
		const ordered = sortSections(sections, this.sortOrder);

		this.countEl?.setText(
			`${ordered.length} ${ordered.length === 1 ? "section" : "sections"} · H${this.headingLevel}`,
		);

		if (!ordered.length) {
			this.clearAllCards();
			const empty = this.gridEl.createDiv({ cls: "section-cards-empty" });
			empty.createEl("p", { text: `No level-${this.headingLevel} headings in ${file.basename}.` });
			empty.createEl("p", { text: "Try a different heading level in the toolbar." });
			return;
		}

		// Helper elements go; the cards themselves are reconciled below, so an edit to one
		// section rebuilds one card and every other card's rendered markdown is kept.
		for (const stray of Array.from(
			this.gridEl.querySelectorAll(".section-cards-row-rule, .section-cards-empty"),
		)) {
			stray.remove();
		}

		// Cards mid-edit are always rebuilt, so a cancelled editor resets to rendered markdown.
		const reusable: CardEntry[] = [];
		const discards: CardEntry[] = [];
		for (const entry of this.cardEntries) {
			(entry.el.hasClass("is-editing") ? discards : reusable).push(entry);
		}

		const plan = planCardReuse(
			reusable.map((entry) => entry.raw),
			ordered.map((section) => section.raw),
		);

		const today = this.todayKeys();
		const renders: Promise<void>[] = [];
		const deferred: CardEntry[] = [];
		let immediateBudget = INITIAL_RENDER_COUNT;
		const queueBody = (entry: CardEntry) => {
			if (!entry.renderBody) return;
			// On the canvas, unplaced cards are display:none — rendering their markdown
			// would be pure waste. Placement back-fills the owed render (applyCustomLayout).
			if (this.layout === "custom" && !this.customPlacements[entry.holder.section.headingRaw]) return;
			if (immediateBudget > 0) {
				immediateBudget--;
				renders.push(this.runBodyRender(entry));
			} else {
				deferred.push(entry);
			}
		};

		this.cardsByHeading.clear();
		const claimed = new Set<number>();
		const nextEntries: CardEntry[] = [];

		ordered.forEach((section, i) => {
			const prevIndex = plan[i];
			let entry: CardEntry;
			if (prevIndex >= 0) {
				claimed.add(prevIndex);
				entry = reusable[prevIndex];
				entry.holder.section = section;
				entry.el.toggleClass("is-today", !!today && isTodayTitle(section.title, today.iso, today.formatted));
				this.applyBodyHeight(entry.el.querySelector<HTMLElement>(".section-card-body"));
			} else {
				entry = this.renderCard(file, section, today);
			}
			queueBody(entry);
			nextEntries.push(entry);
			this.cardsByHeading.set(section.headingRaw, { el: entry.el, section });
		});

		for (let i = 0; i < reusable.length; i++) {
			if (!claimed.has(i)) discards.push(reusable[i]);
		}
		for (const entry of discards) this.discardCard(entry);
		this.cardEntries = nextEntries;

		// Put the DOM in section order; an unchanged run of cards doesn't move at all.
		let cursor: ChildNode | null = this.gridEl.firstChild;
		for (const entry of nextEntries) {
			if (entry.el === cursor) {
				cursor = cursor.nextSibling;
				continue;
			}
			this.gridEl.insertBefore(entry.el, cursor);
		}

		// Pack once with what's laid out, again once the first markdown batch has landed.
		this.layoutMasonry();
		await Promise.all(renders);
		if (gen !== this.renderGeneration) return;

		this.prepareBodies();
		this.layoutMasonry();
		this.insertRowRules();

		// Custom Grid: placements load once per note and are kept in memory from then on —
		// re-adopting on every refresh raced the save and reverted fresh drops. Keys for
		// headings not currently shown (other levels, renamed sections) are KEPT: pruning
		// them here used to destroy arrangements when the heading level was switched.
		if (this.placementsLoadedFor !== file.path) {
			this.placementsLoadedFor = file.path;
			this.customZoom = this.plugin.getCustomZoom(file.path);
			this.customPlacements = {};
			const savedPlacements = Object.entries(this.plugin.getCustomGrid(file.path)).sort(
				([, a], [, b]) => a.y - b.y || a.x - b.x,
			);
			let normalised = false;
			for (const [key, rect] of savedPlacements) {
				const snapped = snapRect(rect, CUSTOM_SNAP, CUSTOM_MIN_W, CUSTOM_MIN_H);
				const spot = this.otherPlacements(key).some((other) => rectsCollide(snapped, other, CUSTOM_GAP))
					? findFreeSpot(snapped, this.otherPlacements(key), CUSTOM_GAP, CUSTOM_SNAP)
					: snapped;
				if (spot.x !== rect.x || spot.y !== rect.y || spot.w !== rect.w || spot.h !== rect.h) normalised = true;
				this.customPlacements[key] = spot;
			}
			if (normalised) this.persistCustom();
		}
		this.applyCustomLayout();
		this.observeCards();
		if (deferred.length) this.scheduleDeferredRenders(deferred, gen);

		if (this.pendingEditHeading) {
			const target = this.cardsByHeading.get(this.pendingEditHeading);
			this.pendingEditHeading = null;
			if (target) {
				// On the canvas an unplaced card is invisible; give a new one a spot first.
				if (this.layout === "custom" && !this.customPlacements[target.section.headingRaw]) {
					this.customPlacements[target.section.headingRaw] = findFreeSpot(
						{ x: CUSTOM_SNAP, y: CUSTOM_SNAP, w: CUSTOM_DEFAULT_W, h: CUSTOM_DEFAULT_H },
						this.otherPlacements(target.section.headingRaw),
						CUSTOM_GAP,
						CUSTOM_SNAP,
					);
					this.persistCustom();
					this.applyCustomLayout();
				}
				target.el.scrollIntoView({ block: "center" });
				this.startEditing(target.el, file, target.section);
			}
		}

		if (this.pendingMaximizeHeading) {
			const target = this.cardsByHeading.get(this.pendingMaximizeHeading);
			this.pendingMaximizeHeading = null;
			if (target) this.toggleMaximized(target.el);
		}

		// Keep the tab title in sync with the note being shown (undocumented but stable API).
		(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
	}

	private renderCard(file: TFile, section: Section, today: { iso: string; formatted: string } | null): CardEntry {
		const holder = { section };
		const scope = new Component();
		this.addChild(scope);

		// Built detached; refresh's ordering pass inserts it at the right position.
		const card = createDiv();
		card.className = "section-card";

		if (today && isTodayTitle(section.title, today.iso, today.formatted)) {
			card.addClass("is-today");
		}

		const header = card.createDiv({ cls: "section-card-header" });
		const titleClick = this.plugin.settings.titleBarClick;
		header.addClass(titleClick === "maximize" ? "is-click-big" : "is-click-edit");
		header.createDiv({ cls: "section-card-title", text: section.title || "(untitled)" });

		// On the canvas, dragging the title bar repositions the card (buttons excluded).
		header.addEventListener("pointerdown", (evt) => {
			if (this.layout !== "custom" || !card.hasClass("is-placed")) return;
			if (card.hasClass("is-editing") || this.isMaximized()) return;
			if ((evt.target as HTMLElement | null)?.closest("button")) return;
			const placement = this.customPlacements[holder.section.headingRaw];
			if (!placement) return;
			this.startPointerDrag(
				evt,
				"card",
				holder.section.headingRaw,
				holder.section.title || "(untitled)",
				card.getBoundingClientRect(),
				{ w: placement.w, h: placement.h },
			);
		});

		// The title bar's own action. "edit" falls through to the card handler below.
		if (titleClick === "maximize") {
			header.addEventListener("click", (evt) => {
				if ((evt.target as HTMLElement | null)?.closest("button")) return;
				evt.stopPropagation();
				this.toggleMaximized(card);
			});
		}

		const untrayBtn = header.createEl("button", { cls: "section-card-untray" });
		setIcon(untrayBtn, "x");
		untrayBtn.setAttr("aria-label", "Remove from the canvas (back to the list)");
		untrayBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.untrayCard(holder.section.headingRaw);
		});

		const deleteBtn = header.createEl("button", { cls: "section-card-delete" });
		setIcon(deleteBtn, "trash-2");
		deleteBtn.setAttr("aria-label", "Delete this card");
		deleteBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			const target = holder.section;
			new ConfirmDeleteModal(this.app, target.title || "(untitled)", async () => {
				const ok = await deleteSection(this.app, file, this.headingLevel, target);
				if (ok) {
					new Notice(`Deleted “${target.title || "(untitled)"}” from ${file.basename}`);
				} else {
					new Notice("Single File Section Cards: couldn't find that section — the file changed on disk.");
				}
				await this.refresh();
			}).open();
		});

		const bigBtn = header.createEl("button", { cls: "section-card-big" });
		// The four-way move icon covers both of this button's jobs: click to make the card
		// big, or use it as the natural grab point for drag-to-reorder.
		setIcon(bigBtn, "move");
		bigBtn.setAttr("aria-label", "Make this card big · drag to reorder");
		bigBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.toggleMaximized(card);
		});

		const openBtn = header.createEl("button", { cls: "section-card-open", text: "↗" });
		openBtn.setAttr("aria-label", "Open this section in the note");
		openBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			void this.plugin.revealSection(file, holder.section.headingLine);
		});

		// markdown-rendered lets Obsidian's own reading-view CSS style lists, tasks, tags, etc.
		const bodyEl = card.createDiv({ cls: "section-card-body markdown-rendered" });
		this.applyBodyHeight(bodyEl);

		let renderBody: (() => Promise<void>) | null = null;
		if (section.body.trim()) {
			renderBody = () => MarkdownRenderer.render(this.app, holder.section.body, bodyEl, file.path, scope);
		} else {
			bodyEl.createDiv({ cls: "section-card-placeholder", text: "Empty section — click to add content." });
		}

		// A wikilink to another note opens that note as cards, in its own remembered view.
		bodyEl.addEventListener("click", (evt) => {
			const anchor = (evt.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a");
			if (!anchor || card.hasClass("is-editing")) return;
			// Modifier-clicks keep Obsidian's own behaviour (new tab / new pane / editor).
			if (evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey) return;
			// External links belong to the browser.
			if (anchor.hasClass("external-link") || /^[a-z]+:\/\//i.test(anchor.getAttribute("href") ?? "")) return;

			const linktext = anchor.dataset.href ?? anchor.getAttribute("href");
			if (!linktext) return;

			const [linkpath, subpath] = splitLinktext(linktext);
			const target = linkpath
				? this.app.metadataCache.getFirstLinkpathDest(linkpath, this.filePath)
				: file;
			// Unresolved links, or links to anything that isn't a note, fall through to Obsidian.
			if (!target || target.extension !== "md") return;

			evt.preventDefault();
			evt.stopPropagation();
			void this.navigateTo(target.path, subpath);
		});

		// Checkbox clicks toggle the task in the file instead of opening the editor.
		bodyEl.addEventListener("click", (evt) => {
			const box = (evt.target as HTMLElement).closest<HTMLInputElement>("input[type=checkbox]");
			if (!box || card.hasClass("is-editing")) return;
			evt.stopPropagation();
			evt.preventDefault();
			void this.toggleTask(card, file, holder.section, bodyEl, box);
		});

		// A native resize drag starts in the grip corner and ends with a click on the
		// card, which used to open the editor. Presses in the grip zone arm the same
		// click-swallow the pointer drags use — at pointerup, so drag length can't matter.
		card.addEventListener("pointerdown", (evt) => {
			if (this.layout !== "custom" || !card.hasClass("is-placed")) return;
			const rect = card.getBoundingClientRect();
			if (evt.clientX < rect.right - 28 || evt.clientY < rect.bottom - 28) return;
			const arm = () => {
				this.swallowNextClick = true;
				window.setTimeout(() => (this.swallowNextClick = false), 300);
			};
			window.addEventListener("pointerup", arm, { once: true });
		});

		card.addEventListener("click", (evt) => {
			const target = evt.target as HTMLElement;
			// Let links and internal-link clicks behave normally.
			if (target.closest("a")) return;
			if (target.closest("input[type=checkbox]")) return;
			if (card.hasClass("is-editing")) return;
			const open = this.activeEditor;
			if (open && open.card !== card) {
				// Click-away commits the other card's edit; the reconciler reuses this
				// card's element across that refresh, so it can then open as usual.
				void open.finish(true).then(() => this.startEditing(card, file, holder.section));
				return;
			}
			this.startEditing(card, file, holder.section);
		});

		// Drag a task or paragraph out of this card's body into another card. Works in
		// every sort order: both sections are re-located by content at write time.
		bodyEl.addEventListener("dragstart", (evt) => {
			const target = evt.target as HTMLElement | null;
			if (target?.closest("a")) return; // native link dragging stays native
			const el = target?.closest<HTMLElement>(".sc-block");
			if (!el || !bodyEl.contains(el)) return;
			evt.stopPropagation(); // this is a block drag, not a card reorder
			if (card.hasClass("is-editing") || this.isMaximized()) {
				evt.preventDefault();
				return;
			}
			const els = this.eligibleBlockEls(bodyEl);
			const domIndex = els.indexOf(el);
			const body = holder.section.body.split("\n");
			const block = movableBlocks(body)[domIndex];
			// The DOM element and the parsed block must agree before anything can move.
			if (domIndex < 0 || !block || !SectionCardsView.blockTextsAgree(el, body.slice(block.start, block.end))) {
				evt.preventDefault();
				return;
			}
			this.draggingBlock = {
				holder,
				blockIndex: domIndex,
				blockText: body.slice(block.start, block.end).join("\n"),
				el,
			};
			el.addClass("is-dragging-block");
			if (evt.dataTransfer) {
				evt.dataTransfer.effectAllowed = "move";
				evt.dataTransfer.setData("text/plain", this.draggingBlock.blockText);
			}
		});
		bodyEl.addEventListener("dragend", () => {
			this.draggingBlock?.el.removeClass("is-dragging-block");
			this.draggingBlock = null;
			this.clearBlockDropMarks();
		});

		// Drag a card onto another to reorder the sections in the file. Only meaningful
		// when the display mirrors the file, i.e. Document order — other sorts recompute
		// the position immediately, so a drag there offers to switch first.
		card.draggable = true;
		card.addEventListener("dragstart", (evt) => {
			if (card.hasClass("is-editing") || this.isMaximized()) {
				evt.preventDefault();
				return;
			}
			evt.stopPropagation(); // keep the app's global drag handling out of card drags
			if (this.sortOrder !== "doc") {
				evt.preventDefault();
				new SwitchToDocumentOrderModal(this.app, SORT_LABELS[this.sortOrder], async () => {
					this.sortOrder = "doc";
					this.rememberView();
					await this.syncView();
					this.app.workspace.requestSaveLayout();
				}).open();
				return;
			}
			this.dragging = holder;
			card.addClass("is-dragging");
			if (evt.dataTransfer) {
				evt.dataTransfer.effectAllowed = "move";
				evt.dataTransfer.setData("text/plain", holder.section.headingRaw);
			}
		});
		card.addEventListener("dragend", () => {
			card.removeClass("is-dragging");
			this.setDropMarker(null, false);
			this.dragging = null;
		});
		card.addEventListener("dragover", (evt) => {
			if (this.draggingBlock) {
				evt.preventDefault();
				if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
				this.clearBlockDropMarks();
				const at = this.blockDropAt(evt, bodyEl);
				if (at.el) at.el.addClass(at.before ? "sc-blockdrop-before" : "sc-blockdrop-after");
				else card.addClass("sc-blockdrop-end");
				return;
			}
			if (!this.dragging || this.dragging === holder) return;
			evt.preventDefault();
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
			this.setDropMarker(card, this.isDropBefore(evt, card));
		});
		card.addEventListener("drop", (evt) => {
			if (this.draggingBlock) {
				evt.preventDefault();
				evt.stopPropagation();
				const from = this.draggingBlock;
				const at = this.blockDropAt(evt, bodyEl);
				this.draggingBlock = null;
				this.clearBlockDropMarks();
				from.el.removeClass("is-dragging-block");
				void this.completeBlockDrag(
					file,
					{ section: from.holder.section, blockIndex: from.blockIndex, blockText: from.blockText },
					holder.section,
					at.beforeIndex,
				);
				return;
			}
			if (!this.dragging || this.dragging === holder) return;
			evt.preventDefault();
			evt.stopPropagation();
			const moved = this.dragging.section;
			const before = this.isDropBefore(evt, card);
			this.setDropMarker(null, false);
			this.dragging = null;
			void this.completeDrag(file, moved, holder.section, before);
		});

		return { el: card, scope, holder, raw: section.raw, renderBody };
	}

	/**
	 * Scroll a card into view and flash it — used when arriving from a `[[Note#Heading]]`
	 * link. Silently does nothing if that heading isn't a card at the current level.
	 */
	revealCard(heading: string): void {
		if (!heading) return;
		const wanted = heading.replace(/^#+\s*/, "").trim().toLowerCase();
		for (const { el, section } of this.cardsByHeading.values()) {
			if (section.title.trim().toLowerCase() !== wanted) continue;
			el.scrollIntoView({ block: "center", inline: "center" });
			el.addClass("is-linked");
			window.setTimeout(() => el.removeClass("is-linked"), 1600);
			return;
		}
	}

	isMaximized(): boolean {
		return this.maximized !== null;
	}

	/**
	 * Blow a card up over the others, or put it back. Whatever mode the card is in —
	 * reading or editing raw markdown — is carried across untouched: the card element is
	 * moved rather than re-rendered, and an in-progress edit keeps its text, caret and focus.
	 */
	private toggleMaximized(card: HTMLElement): void {
		if (this.maximized?.card === card) {
			this.closeMaximized();
			return;
		}
		this.closeMaximized();

		const body = card.querySelector<HTMLElement>(".section-card-body");
		const button = card.querySelector<HTMLElement>(".section-card-big");
		if (!body || !button) return;

		// A comment node holds the card's place in the grid so it goes back where it was.
		const marker = document.createComment("section-card");
		card.parentElement?.insertBefore(marker, card);

		const overlay = this.contentEl.createDiv({ cls: "section-cards-overlay" });
		// The locked view keeps its scroll offset, and an absolutely-positioned overlay
		// lives in content coordinates — pin it to the visible box, or it opens above the
		// viewport whenever the wall is scrolled (a certainty in the Horizontal layout).
		overlay.setCssStyles({ top: `${this.contentEl.scrollTop}px`, height: `${this.contentEl.clientHeight}px` });
		overlay.addEventListener("click", (evt) => {
			if (evt.target === overlay) this.closeMaximized();
		});

		this.maximized = {
			card,
			body,
			button,
			overlay,
			marker,
			bodyMaxHeight: body.style.maxHeight,
			inlineRect: { left: card.style.left, top: card.style.top, width: card.style.width, height: card.style.height },
		};
		// Canvas placement is inline geometry, which would misplace the card in the overlay.
		card.setCssStyles({ left: "", top: "", width: "", height: "" });

		// If this card's body render was deferred past the initial batch, do it now.
		const owed = this.cardEntries.find((entry) => entry.el === card);
		if (owed) {
			void this.runBodyRender(owed).then(() => {
				this.prepareBodies();
				this.repack();
			});
		}

		// Scrolling is locked while blown up, so the overlay's inset covers the visible tab.
		this.contentEl.addClass("has-maximized-card");
		const caret = captureCaret(card);
		overlay.appendChild(card);
		card.addClass("is-maximized");
		body.setCssStyles({ maxHeight: "" });
		setIcon(button, "shrink");
		button.setAttr("aria-label", "Shrink this card");
		restoreCaret(caret);
	}

	private closeMaximized(): void {
		const open = this.maximized;
		if (!open) return;
		this.maximized = null;

		open.card.removeClass("is-maximized");
		open.card.setCssStyles(open.inlineRect);
		open.body.setCssStyles({ maxHeight: open.bodyMaxHeight });
		setIcon(open.button, "move");
		open.button.setAttr("aria-label", "Make this card big · drag to reorder");

		const caret = captureCaret(open.card);
		open.marker.parentElement?.insertBefore(open.card, open.marker);
		open.marker.remove();
		open.overlay.remove();
		this.contentEl.removeClass("has-maximized-card");
		restoreCaret(caret);

		this.layoutMasonry();
		this.insertRowRules();
	}

	/** True when a rendered element plausibly shows the given source lines. */
	private static blockTextsAgree(el: HTMLElement, blockLines: string[]): boolean {
		const key = SectionCardsView.blockKey(blockLines[0] ?? "");
		if (!key) return true; // nothing distinctive to compare
		const dom = (el.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
		return dom.includes(key);
	}

	/** Dashed rectangle showing where a drag or resize will snap to. */
	private snapPreviewEl: HTMLElement | null = null;

	private showSnapPreview(rect: CardRect, nudged: boolean): void {
		if (!this.snapPreviewEl) {
			this.snapPreviewEl = this.gridEl.createDiv({ cls: "sc-snap-preview" });
		}
		this.snapPreviewEl.toggleClass("is-nudged", nudged);
		this.snapPreviewEl.setCssStyles({
			left: `${rect.x}px`,
			top: `${rect.y}px`,
			width: `${rect.w}px`,
			height: `${rect.h}px`,
		});
	}

	private hideSnapPreview(): void {
		this.snapPreviewEl?.remove();
		this.snapPreviewEl = null;
	}

	/** Visible placed rects except the one being moved (hidden-level keys don't collide). */
	private otherPlacements(except: string): CardRect[] {
		return Object.entries(this.customPlacements)
			.filter(([key]) => key !== except && (this.cardsByHeading.size === 0 || this.cardsByHeading.has(key)))
			.map(([, rect]) => rect);
	}

	/** Begin a pointer-driven drag of a tray tile or a placed card. */
	private startPointerDrag(
		evt: PointerEvent,
		kind: "tile" | "card",
		key: string,
		label: string,
		grabbed: DOMRect,
		size: { w: number; h: number },
	): void {
		if (evt.button !== 0 || this.pointerDrag) return;
		evt.preventDefault();
		const drag = {
			kind,
			key,
			label,
			// Placements can't change mid-drag; computing this per mousemove was waste.
			obstacles: this.otherPlacements(key),
			w: size.w,
			h: size.h,
			// Grab offsets in content px: placed cards render zoomed, tray tiles don't.
			offX: Math.min((evt.clientX - grabbed.left) / (kind === "card" ? this.customZoom : 1), size.w - 24),
			offY: Math.min((evt.clientY - grabbed.top) / (kind === "card" ? this.customZoom : 1), size.h - 24),
			startX: evt.clientX,
			startY: evt.clientY,
			active: false,
			ghost: null as HTMLElement | null,
			onMove: (e: PointerEvent) => this.pointerDragMove(e),
			onUp: (e: PointerEvent) => this.pointerDragEnd(e),
		};
		this.pointerDrag = drag;
		window.addEventListener("pointermove", drag.onMove);
		window.addEventListener("pointerup", drag.onUp);
		window.addEventListener("pointercancel", drag.onUp);
	}

	private pointerDragMove(evt: PointerEvent): void {
		const drag = this.pointerDrag;
		if (!drag) return;
		if (!drag.active) {
			// A real drag needs intent; tiny movements stay clicks.
			if (Math.hypot(evt.clientX - drag.startX, evt.clientY - drag.startY) < 5) return;
			drag.active = true;
			const ghost = document.body.createDiv({ cls: "sc-pointer-ghost" });
			ghost.setText(drag.label);
			if (drag.kind === "card") {
				ghost.setCssStyles({ width: `${drag.w}px`, height: `${drag.h}px` });
			}
			drag.ghost = ghost;
		}
		drag.ghost?.setCssStyles({
			left: `${evt.clientX - Math.min(drag.offX, 140)}px`,
			top: `${evt.clientY - Math.min(drag.offY, 20)}px`,
		});
		const canvas = this.gridEl.getBoundingClientRect();
		const overCanvas =
			evt.clientX >= canvas.left && evt.clientX <= canvas.right && evt.clientY >= canvas.top && evt.clientY <= canvas.bottom;
		this.gridEl.toggleClass("is-drop-target", overCanvas);

		// Show exactly where the card will land — the same math the drop uses.
		if (overCanvas) {
			const px = (evt.clientX - canvas.left + this.gridEl.scrollLeft) / this.customZoom;
			const py = (evt.clientY - canvas.top + this.gridEl.scrollTop) / this.customZoom;
			const want = snapRect(
				{ x: px - Math.min(drag.offX, 140), y: py - Math.min(drag.offY, 20), w: drag.w, h: drag.h },
				CUSTOM_SNAP,
				CUSTOM_MIN_W,
				CUSTOM_MIN_H,
			);
			const spot = findFreeSpot(want, drag.obstacles, CUSTOM_GAP, CUSTOM_SNAP);
			this.showSnapPreview(spot, spot.x !== want.x || spot.y !== want.y);
		} else {
			this.hideSnapPreview();
		}
	}

	private pointerDragEnd(evt: PointerEvent): void {
		const drag = this.pointerDrag;
		if (!drag) return;
		this.pointerDrag = null;
		window.removeEventListener("pointermove", drag.onMove);
		window.removeEventListener("pointerup", drag.onUp);
		window.removeEventListener("pointercancel", drag.onUp);
		drag.ghost?.remove();
		this.gridEl.removeClass("is-drop-target");
		this.hideSnapPreview();
		if (!drag.active) return; // it was just a click — let it be one

		this.swallowNextClick = true;
		window.setTimeout(() => (this.swallowNextClick = false), 300);

		const canvas = this.gridEl.getBoundingClientRect();
		const overCanvas =
			evt.clientX >= canvas.left && evt.clientX <= canvas.right && evt.clientY >= canvas.top && evt.clientY <= canvas.bottom;

		if (overCanvas) {
			const px = (evt.clientX - canvas.left + this.gridEl.scrollLeft) / this.customZoom;
			const py = (evt.clientY - canvas.top + this.gridEl.scrollTop) / this.customZoom;
			const want = snapRect(
				{ x: px - Math.min(drag.offX, 140), y: py - Math.min(drag.offY, 20), w: drag.w, h: drag.h },
				CUSTOM_SNAP,
				CUSTOM_MIN_W,
				CUSTOM_MIN_H,
			);
			this.customPlacements[drag.key] = findFreeSpot(want, drag.obstacles, CUSTOM_GAP, CUSTOM_SNAP);
			this.persistCustom();
			this.applyCustomLayout();
			return;
		}

		// A placed card released over the tray goes back to it.
		if (drag.kind === "card") {
			const tray = this.trayEl.getBoundingClientRect();
			const overTray =
				evt.clientX >= tray.left && evt.clientX <= tray.right && evt.clientY >= tray.top && evt.clientY <= tray.bottom;
			if (overTray) this.untrayCard(drag.key);
		}
	}

	/** Remove every card from the canvas so the tray lists every section again. */
	private clearCanvas(): void {
		const placed = Object.keys(this.customPlacements).length;
		if (!placed) return;
		this.customPlacements = {};
		this.persistCustom();
		this.applyCustomLayout();
		new Notice(`Canvas cleared — ${placed} ${placed === 1 ? "placement" : "placements"} returned to the list.`);
	}

	/** Return a placed card to the tray. */
	private untrayCard(headingRaw: string): void {
		delete this.customPlacements[headingRaw];
		this.persistCustom();
		this.applyCustomLayout();
	}

	/** Signature of the tray's last build, so unchanged refreshes skip the DOM churn. */
	private traySignature: string | null = null;

	/** Position placed cards, hide trayed ones, and rebuild the tray when it changed. */
	private applyCustomLayout(): void {
		if (this.layout !== "custom") {
			if (this.traySignature !== null) {
				this.trayEl.empty();
				this.traySignature = null;
			}
			// Leaving the canvas restores native drag for card reordering.
			for (const entry of this.cardEntries) {
				if (!entry.el.draggable) entry.el.draggable = true;
			}
			return;
		}

		this.applyCustomZoom();
		let maxBottom = 0;
		let maxRight = 0;
		const owedRenders: CardEntry[] = [];
		const unplacedKeys: string[] = [];

		for (const entry of this.cardEntries) {
			const key = entry.holder.section.headingRaw;
			const rect = this.customPlacements[key];
			if (rect) {
				entry.el.addClass("is-placed");
				entry.el.draggable = false; // pointer drag owns the canvas; native drag is off
				if (entry.renderBody) owedRenders.push(entry);
				entry.el.setCssStyles({
					left: `${rect.x}px`,
					top: `${rect.y}px`,
					width: `${rect.w}px`,
					height: `${rect.h}px`,
				});
				maxBottom = Math.max(maxBottom, rect.y + rect.h);
				maxRight = Math.max(maxRight, rect.x + rect.w);
			} else {
				entry.el.removeClass("is-placed");
				entry.el.draggable = false;
				unplacedKeys.push(key);
			}
		}

		// Cards placed while their markdown render was still owed get it now, batched.
		if (owedRenders.length) {
			void Promise.all(owedRenders.map((entry) => this.runBodyRender(entry))).then(() => {
				this.prepareBodies();
				this.repack();
			});
		}

		this.updateCanvasExtent(maxRight, maxBottom);

		// The tray only rebuilds when its contents or order actually changed.
		// Today's date is part of the signature so the highlight rolls over at midnight.
		const signature = `${this.sortOrder}|${this.todayKeys()?.iso ?? ""}|${unplacedKeys.join("\u0000")}`;
		if (signature === this.traySignature) return;
		this.traySignature = signature;
		this.rebuildTray(unplacedKeys);
	}

	/** Apply the zoom factor: cards, extent marker, preview and dots all ride the var. */
	private applyCustomZoom(): void {
		this.gridEl.setCssProps({ "--sc-zoom": String(this.customZoom) });
		this.zoomLabelEl?.setText(`${Math.round(this.customZoom * 100)}%`);
	}

	private setCustomZoom(zoom: number): void {
		const clamped = Math.round(Math.min(1.6, Math.max(0.4, zoom)) * 10) / 10;
		if (clamped === this.customZoom) return;
		this.customZoom = clamped;
		this.applyCustomZoom();
		this.persistCustom();
		this.applyCustomLayout(); // recompute the scroll extent for the new scale
	}

	/**
	 * The canvas always scrolls: an invisible marker sits past the furthest card AND past
	 * the viewport, so there is room to pan in every direction the layout might grow.
	 * (Sizing the scroll container itself just grew the clipped element — content must
	 * be what defines the extent.)
	 */
	private updateCanvasExtent(maxRight: number, maxBottom: number): void {
		if (this.layout !== "custom") return;
		const viewW = this.gridEl.clientWidth / this.customZoom;
		const viewH = this.gridEl.clientHeight / this.customZoom;
		const w = Math.max(maxRight, viewW) + 400;
		const h = Math.max(maxBottom, viewH) + 400;
		this.canvasExtentEl.setCssStyles({ left: `${w - 1}px`, top: `${h - 1}px` });
	}

	private rebuildTray(unplacedKeys: string[]): void {
		this.trayEl.empty();

		// Permanent tray controls: Clear (everything back to this list) and the sorts.
		const actions = this.trayEl.createDiv({ cls: "section-cards-tray-actions" });
		const clearBtn = actions.createEl("button", { cls: "section-cards-tray-clear", text: "Clear Layout" });
		clearBtn.setAttr("aria-label", "Remove every card from the canvas, back into this list");
		clearBtn.addEventListener("click", () => {
			const placed = Object.keys(this.customPlacements).length;
			if (!placed) {
				new Notice("The canvas is already clear.");
				return;
			}
			new ConfirmClearModal(this.app, placed, () => this.clearCanvas()).open();
		});
		const sortRow = this.trayEl.createDiv({ cls: "section-cards-tray-sorts" });
		const sorts: [SortOrder, string][] = [
			["asc", "A→Z"],
			["desc", "Z→A"],
			["doc", "Doc"],
		];
		for (const [order, label] of sorts) {
			const btn = sortRow.createEl("button", { cls: "section-cards-tray-sort", text: label });
			btn.setAttr("aria-label", `Sort sections ${SORT_LABELS[order]}`);
			btn.toggleClass("is-active", this.sortOrder === order);
			btn.addEventListener("click", () => {
				if (this.sortOrder === order) return;
				this.sortOrder = order;
				this.rememberView();
				void this.syncView().then(() => this.app.workspace.requestSaveLayout());
			});
		}

		this.trayEl.createDiv({ cls: "section-cards-tray-hint", text: "Drag a section onto the canvas" });
		const today = this.todayKeys();
		for (const key of unplacedKeys) {
			const entry = this.cardsByHeading.get(key);
			if (!entry) continue;
			const tile = this.trayEl.createDiv({
				cls: "section-cards-tray-tile",
				text: entry.section.title || "(untitled)",
			});
			if (today && isTodayTitle(entry.section.title, today.iso, today.formatted)) {
				tile.addClass("is-today");
			}
			tile.addEventListener("pointerdown", (evt) => {
				this.startPointerDrag(
					evt,
					"tile",
					key,
					entry.section.title || "(untitled)",
					tile.getBoundingClientRect(),
					{ w: CUSTOM_DEFAULT_W, h: CUSTOM_DEFAULT_H },
				);
			});
		}
		if (!unplacedKeys.length) {
			this.trayEl.createDiv({ cls: "section-cards-tray-hint", text: "Every section is on the canvas." });
		}
	}


	/** A backgrounded tab reports 0x0 for everything; size logic must ignore it. */
	private viewIsHidden(): boolean {
		return this.gridEl.clientWidth === 0 && this.gridEl.clientHeight === 0;
	}

	/** While a canvas card is being resized, preview the size it will snap to. */
	private previewCustomResize(): void {
		if (this.viewIsHidden()) return;
		for (const entry of this.cardEntries) {
			const key = entry.holder.section.headingRaw;
			const stored = this.customPlacements[key];
			if (!stored || !entry.el.hasClass("is-placed")) continue;
			const w = entry.el.offsetWidth;
			const h = entry.el.offsetHeight;
			if (Math.abs(w - stored.w) < 2 && Math.abs(h - stored.h) < 2) continue;
			const proposed = snapRect({ ...stored, w, h }, CUSTOM_SNAP, CUSTOM_MIN_W, CUSTOM_MIN_H);
			const colliding = this.otherPlacements(key).some((other) => rectsCollide(proposed, other, CUSTOM_GAP));
			this.showSnapPreview(proposed, colliding);
			return; // only one card resizes at a time
		}
	}

	/** Custom Grid: snap a card's CSS resize to the grid, or revert it if it would collide. */
	private validateCustomSizes(): void {
		this.hideSnapPreview();
		// Switching tabs hides the view: every card then measures 0x0, which used to be
		// read as a resize-to-minimum and saved, shrinking the whole layout.
		if (this.viewIsHidden()) return;
		let changed = false;
		for (const entry of this.cardEntries) {
			const key = entry.holder.section.headingRaw;
			const stored = this.customPlacements[key];
			if (!stored || !entry.el.hasClass("is-placed")) continue;
			const w = entry.el.offsetWidth;
			const h = entry.el.offsetHeight;
			if (w === 0 && h === 0) continue; // individually hidden (e.g. mid-transition)
			if (Math.abs(w - stored.w) < 2 && Math.abs(h - stored.h) < 2) continue;
			const proposed = snapRect({ ...stored, w, h }, CUSTOM_SNAP, CUSTOM_MIN_W, CUSTOM_MIN_H);
			if (
				(proposed.w === stored.w && proposed.h === stored.h) ||
				this.otherPlacements(key).some((other) => rectsCollide(proposed, other, CUSTOM_GAP))
			) {
				// Snapped back to what it was, or the new size would collide: restore.
				entry.el.setCssStyles({ width: `${stored.w}px`, height: `${stored.h}px` });
			} else {
				this.customPlacements[key] = proposed;
				entry.el.setCssStyles({ width: `${proposed.w}px`, height: `${proposed.h}px` });
				changed = true;
			}
		}
		if (changed) this.persistCustom();
	}

	/** Normalise a source line / DOM text for the drag-start sanity check. */
	private static blockKey(text: string): string {
		return text
			.replace(/^\s*(?:[-*+]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/, "")
			.replace(/[*_\`~\[\]()#|>]/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.toLowerCase()
			.slice(0, 24);
	}

	private clearBlockDropMarks(): void {
		for (const el of Array.from(this.gridEl.querySelectorAll(".sc-blockdrop-before, .sc-blockdrop-after"))) {
			el.removeClass("sc-blockdrop-before");
			el.removeClass("sc-blockdrop-after");
		}
		for (const el of Array.from(this.gridEl.querySelectorAll(".sc-blockdrop-end"))) {
			el.removeClass("sc-blockdrop-end");
		}
	}

	/** Where in the hovered card a dragged block would land. */
	private blockDropAt(evt: DragEvent, bodyEl: HTMLElement): { beforeIndex: number | null; el: HTMLElement | null; before: boolean } {
		const hovered = (evt.target as HTMLElement | null)?.closest<HTMLElement>(".sc-block");
		if (hovered && bodyEl.contains(hovered)) {
			const els = this.eligibleBlockEls(bodyEl);
			const index = els.indexOf(hovered);
			if (index >= 0) {
				const rect = hovered.getBoundingClientRect();
				const before = evt.clientY < rect.top + rect.height / 2;
				return { beforeIndex: before ? index : index + 1, el: hovered, before };
			}
		}
		return { beforeIndex: null, el: null, before: false };
	}

	private async completeBlockDrag(
		file: TFile,
		from: { section: Section; blockIndex: number; blockText: string },
		target: Section,
		beforeIndex: number | null,
	): Promise<void> {
		const ok = await moveBlockInFile(
			this.app,
			file,
			this.headingLevel,
			from.section,
			from.blockIndex,
			from.blockText,
			target,
			beforeIndex,
		);
		if (!ok) {
			new Notice("Single File Section Cards: couldn't move that block — the file changed on disk.");
		}
		await this.refresh();
	}

	/** Which side of a card the pointer is on, along the layout's flow axis. */
	private isDropBefore(evt: DragEvent, card: HTMLElement): boolean {
		const rect = card.getBoundingClientRect();
		// Horizontal flows top-to-bottom (one card per row); everything else row-major.
		return this.layout === "horizontal"
			? evt.clientY < rect.top + rect.height / 2
			: evt.clientX < rect.left + rect.width / 2;
	}

	private setDropMarker(card: HTMLElement | null, before: boolean): void {
		if (this.dropMarker && this.dropMarker !== card) {
			this.dropMarker.removeClass("sc-drop-before");
			this.dropMarker.removeClass("sc-drop-after");
		}
		this.dropMarker = card;
		if (!card) return;
		card.toggleClass("sc-drop-before", before);
		card.toggleClass("sc-drop-after", !before);
	}

	private async completeDrag(file: TFile, moved: Section, target: Section, before: boolean): Promise<void> {
		const ok = await moveSectionInFile(this.app, file, this.headingLevel, moved, target, before);
		if (!ok) {
			new Notice("Single File Section Cards: couldn't reorder — the file changed on disk.");
		}
		await this.refresh();
	}

	/** Toggle the clicked task's line in the file, matching checkbox position to task order. */
	private async toggleTask(
		card: HTMLElement,
		file: TFile,
		section: Section,
		bodyEl: HTMLElement,
		box: HTMLInputElement,
	): Promise<void> {
		const boxes = Array.from(bodyEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
		const nth = boxes.indexOf(box);
		if (nth < 0) return;

		const checked = await toggleTaskInFile(
			this.app,
			file,
			this.headingLevel,
			section,
			nth,
			mo().format("YYYY-MM-DD"),
			this.plugin.settings.taskDoneDate,
		);

		if (checked === null) {
			new Notice("Single File Section Cards: couldn't find that task in the file — reloading.");
			await this.refresh();
			return;
		}

		// Reflect it immediately; the vault-modify refresh will reconcile shortly after.
		box.checked = checked;
		const item = box.closest<HTMLElement>("li");
		if (item) {
			item.toggleClass("is-checked", checked);
			item.setAttribute("data-task", checked ? "x" : " ");
		}
		card.addClass("is-toggling");
		window.setTimeout(() => card.removeClass("is-toggling"), 400);
	}

	private startEditing(card: HTMLElement, file: TFile, section: Section) {
		card.addClass("is-editing");
		// A draggable ancestor turns textarea text-selection into drags; disable while editing.
		card.draggable = false;
		this.editingKey = section.headingRaw;

		const bodyEl = card.querySelector<HTMLElement>(".section-card-body");
		if (!bodyEl) return;
		bodyEl.empty();
		bodyEl.setCssStyles({ maxHeight: "" });

		const textarea = bodyEl.createEl("textarea", { cls: "section-card-editor" });
		// Pad with a newline so typing starts on a fresh line under the existing content
		// (for a brand-new card, directly under its title). Trimmed back off on save.
		textarea.value = section.raw + "\n";
		textarea.rows = Math.min(Math.max(section.raw.split("\n").length + 2, 4), 30);

		// The editor owns its undo history so programmatic edits (Tab) stay undoable
		// without deprecated document APIs, at the cost of superseding native undo.
		const snapshot = (): EditorSnapshot => ({
			value: textarea.value,
			selStart: textarea.selectionStart,
			selEnd: textarea.selectionEnd,
		});
		const restore = (snap: EditorSnapshot | null): void => {
			if (!snap) return;
			textarea.value = snap.value;
			textarea.setSelectionRange(snap.selStart, snap.selEnd);
		};
		const history = new EditorHistory(snapshot());

		const footer = bodyEl.createDiv({ cls: "section-card-footer" });
		footer.createSpan({ cls: "section-card-hint", text: "Ctrl/⌘+Enter to save · Esc to cancel" });
		const cancelBtn = footer.createEl("button", { text: "Cancel" });
		const saveBtn = footer.createEl("button", { cls: "mod-cta", text: "Save" });

		let settled = false;
		const finish = async (save: boolean) => {
			if (settled) return;
			settled = true;
			this.activeEditor = null;
			// Saving re-renders the card, so remember to blow it back up afterwards.
			if (this.maximized?.card === card) {
				const firstLine = textarea.value.split("\n")[0]?.trim();
				this.pendingMaximizeHeading = save && firstLine ? firstLine : section.headingRaw;
			}
			const edited = trimTrailingBlankLines(textarea.value);
			if (save && edited !== section.raw) {
				const written = await writeSection(this.app, file, this.headingLevel, section, edited);
				if (written) new Notice(`Saved “${section.title}” to ${file.basename}`);
			}
			this.editingKey = null;
			await this.refresh();
		};

		saveBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void finish(true);
		});
		cancelBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void finish(false);
		});
		textarea.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				void finish(true);
			} else if (e.key === "Escape") {
				e.preventDefault();
				void finish(false);
			} else if (e.key === "Tab") {
				// Tab indents instead of leaving the field — nested tasks need it.
				e.preventDefault();
				const edit = computeTabEdit(textarea.value, textarea.selectionStart, textarea.selectionEnd, e.shiftKey);
				if (!edit) return;
				textarea.setRangeText(edit.insert, edit.start, edit.end, "end");
				textarea.setSelectionRange(edit.selStart, edit.selEnd);
				history.record(snapshot());
			} else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z") {
				e.preventDefault();
				restore(e.shiftKey ? history.redo() : history.undo());
			} else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "y") {
				e.preventDefault();
				restore(history.redo());
			}
		});

		// Menu- and gesture-driven undo (mobile, Edit menu) arrives as beforeinput.
		textarea.addEventListener("beforeinput", (e) => {
			if (e.inputType === "historyUndo") {
				e.preventDefault();
				restore(history.undo());
			} else if (e.inputType === "historyRedo") {
				e.preventDefault();
				restore(history.redo());
			}
		});
		textarea.addEventListener("input", () => history.record(snapshot()));
		textarea.addEventListener("click", (e) => e.stopPropagation());

		this.activeEditor = { card, finish };
		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		this.layoutMasonry();
	}

	/** True when a card editor is open — used to avoid yanking the file out from under a typist. */
	isEditing(): boolean {
		return this.editingKey !== null;
	}
}

class FileSuggestModal extends SuggestModal<string> {
	private readonly plugin: SectionCardsPlugin;
	private readonly onChoose: (path: string) => void;

	constructor(app: App, plugin: SectionCardsPlugin, onChoose: (path: string) => void) {
		super(app);
		this.plugin = plugin;
		this.onChoose = onChoose;
		this.setPlaceholder("Recent note, or type a name or path…");
		this.emptyStateText = "No match — type the note's name or vault path.";
	}

	/** Adds a path if it names a real markdown file that isn't already listed. */
	private addCandidate(out: string[], seen: Set<string>, path: string | null | undefined): void {
		if (!path) return;
		const normalized = path.endsWith(".md") ? path : `${path}.md`;
		if (seen.has(normalized)) return;
		if (!(this.app.vault.getAbstractFileByPath(normalized) instanceof TFile)) return;
		seen.add(normalized);
		out.push(normalized);
	}

	/**
	 * Suggestions come only from notes the user has already touched — the configured
	 * default, notes with a remembered cards view, recently opened notes — plus whatever
	 * the query itself names. The vault is deliberately never enumerated.
	 */
	getSuggestions(query: string): string[] {
		const typed: string[] = [];
		const known: string[] = [];
		const seen = new Set<string>();

		const q = query.trim();
		if (q) {
			this.addCandidate(typed, seen, q);
			const resolved = this.app.metadataCache.getFirstLinkpathDest(q.replace(/\.md$/, ""), "");
			this.addCandidate(typed, seen, resolved?.path);
		}

		this.addCandidate(known, seen, this.plugin.settings.filePath);
		for (const path of Object.keys(this.plugin.settings.perFile ?? {})) this.addCandidate(known, seen, path);
		for (const path of this.app.workspace.getLastOpenFiles()) this.addCandidate(known, seen, path);

		const needle = q.toLowerCase();
		return typed.concat(needle ? known.filter((path) => path.toLowerCase().includes(needle)) : known);
	}

	renderSuggestion(path: string, el: HTMLElement): void {
		el.setText(path);
	}

	onChooseSuggestion(path: string): void {
		this.onChoose(path);
	}
}

class ConfirmDeleteModal extends Modal {
	private readonly title: string;
	private readonly onConfirm: () => void | Promise<void>;

	constructor(app: App, title: string, onConfirm: () => void | Promise<void>) {
		super(app);
		this.title = title;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Delete card" });
		contentEl.createEl("p", {
			text: `Delete “${this.title}” and everything in it? This removes the section from the note.`,
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText("Delete")
					.setDestructive()
					.setCta()
					.onClick(() => {
						this.close();
						void this.onConfirm();
					});
				// Enter confirms, Esc (the modal's own handling) cancels.
				b.buttonEl.focus();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class SwitchToDocumentOrderModal extends Modal {
	private readonly currentLabel: string;
	private readonly onSwitch: () => void | Promise<void>;

	constructor(app: App, currentLabel: string, onSwitch: () => void | Promise<void>) {
		super(app);
		this.currentLabel = currentLabel;
		this.onSwitch = onSwitch;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Reorder cards" });
		contentEl.createEl("p", {
			text: `Dragging reorders the sections in the note itself, so the cards must be shown in Document order — this view is sorted ${this.currentLabel}.`,
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText("Switch to Document order")
					.setCta()
					.onClick(() => {
						this.close();
						void this.onSwitch();
					});
				// Enter switches, Esc cancels.
				b.buttonEl.focus();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ConfirmClearModal extends Modal {
	private readonly count: number;
	private readonly onConfirm: () => void;

	constructor(app: App, count: number, onConfirm: () => void) {
		super(app);
		this.count = count;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Clear the layout?" });
		contentEl.createEl("p", {
			text: `Are you sure? This removes ${this.count === 1 ? "the 1 placed card" : `all ${this.count} placed cards`} from the canvas and returns ${this.count === 1 ? "it" : "them"} to the section list. Your notes are not changed.`,
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText("Clear layout")
					.setDestructive()
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					});
				// Enter confirms, Esc cancels.
				b.buttonEl.focus();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class DuplicateCardModal extends Modal {
	private readonly title: string;
	private readonly onEdit: () => void | Promise<void>;

	constructor(app: App, title: string, onEdit: () => void | Promise<void>) {
		super(app);
		this.title = title;
		this.onEdit = onEdit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Card already exists" });
		contentEl.createEl("p", {
			text: `“${this.title}” is already a section in this note. Nothing was created.`,
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText("Edit existing")
					.setCta()
					.onClick(() => {
						this.close();
						void this.onEdit();
					});
				// Enter edits the existing card, Esc cancels.
				b.buttonEl.focus();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class NewCardModal extends Modal {
	private text: string;
	private placement: Placement;
	private readonly defaultIso: string;
	private readonly makeHeading: (isoDate: string) => string;
	private readonly onSubmit: (heading: string, placement: Placement) => void | Promise<void>;

	constructor(
		app: App,
		defaultText: string,
		defaultPlacement: Placement,
		defaultIso: string,
		makeHeading: (isoDate: string) => string,
		onSubmit: (heading: string, placement: Placement) => void | Promise<void>,
	) {
		super(app);
		this.text = defaultText;
		this.placement = defaultPlacement;
		this.defaultIso = defaultIso;
		this.makeHeading = makeHeading;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("section-cards-new-modal");
		contentEl.createEl("h3", { text: "New card" });

		let input!: HTMLInputElement;
		const headingSetting = new Setting(contentEl)
			.setName("Heading")
			.setDesc("The #'s set the heading level — edit them to file the card at a different level.")
			.addText((t) => {
				input = t.inputEl;
				t.setValue(this.text).onChange((v) => (this.text = v));
				t.inputEl.addClass("section-cards-new-input");
			});
		// Stack this one so the heading gets the modal's full width to type in.
		headingSetting.settingEl.addClass("section-cards-heading-setting");

		// Picking a date rewrites the heading (still editable) in the configured format,
		// prefixed with the view's #'s.
		const datePick = headingSetting.controlEl.createEl("input", {
			type: "date",
			cls: "section-cards-date-pick",
		});
		datePick.value = this.defaultIso;
		datePick.setAttr("aria-label", "Use a date as the heading");
		datePick.addEventListener("change", () => {
			if (!datePick.value) return;
			this.text = this.makeHeading(datePick.value);
			input.value = this.text;
			input.focus();
			const titleStart = /^#+\s+/.exec(this.text)?.[0].length ?? 0;
			input.setSelectionRange(titleStart, this.text.length);
		});

		new Setting(contentEl).setName("Placement").addDropdown((dd) =>
			dd
				.addOption("top", "Append to top")
				.addOption("logical", "Add to logical order")
				.addOption("bottom", "Add to bottom")
				.setValue(this.placement)
				.onChange((v) => (this.placement = v as Placement)),
		);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Create").setCta().onClick(() => this.submit()));

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submit();
			}
		});

		// Select just the title so the default date can be replaced without deleting the #'s.
		input.focus();
		const titleStart = /^#+\s+/.exec(this.text)?.[0].length ?? 0;
		input.setSelectionRange(titleStart, this.text.length);
	}

	private submit(): void {
		const heading = this.text.trim();
		if (!heading.replace(/^#+\s*/, "")) {
			new Notice("Give the card a name.");
			return;
		}
		this.close();
		void this.onSubmit(heading, this.placement);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class SectionCardsSettingTab extends PluginSettingTab {
	plugin: SectionCardsPlugin;

	constructor(app: App, plugin: SectionCardsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Declarative settings (Obsidian 1.13+), so every setting is findable in settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Default note",
				desc: "Note opened by the ribbon icon and command.",
				control: {
					type: "file",
					key: "filePath",
					placeholder: "Daily Notes 2026.md",
					filter: (file: TFile) => file.extension === "md",
				},
			},
			{
				name: "Heading level",
				desc: "Which heading rank becomes a card.",
				control: {
					type: "dropdown",
					key: "headingLevel",
					options: { "1": "Heading 1", "2": "Heading 2", "3": "Heading 3", "4": "Heading 4", "5": "Heading 5", "6": "Heading 6" },
				},
			},
			{
				name: "Headings contain",
				desc: "With dates, the card for today is highlighted in the theme's highlight colour.",
				control: {
					type: "dropdown",
					key: "headingType",
					options: { dates: "Dates", text: "Non-dates (plain text)" },
				},
			},
			{
				name: "Default layout",
				desc: "Grid and Tight are masonry columns; Horizontal is full-width rows; Vertical is full-height cards that scroll sideways.",
				control: {
					type: "dropdown",
					key: "layout",
					options: Object.fromEntries(LAYOUT_OPTIONS.map(([value, label]) => [value, label])),
				},
			},
			{
				name: "Default sort",
				control: {
					type: "dropdown",
					key: "sortOrder",
					options: { asc: "Alphanumeric A → Z", desc: "Alphanumeric Z → A", doc: "Document order" },
				},
			},
			{
				name: "Clicking a card's title bar",
				desc: "The card body always opens the raw-markdown editor; this is just the title bar.",
				control: {
					type: "dropdown",
					key: "titleBarClick",
					options: { maximize: "Makes the card big", edit: "Edits the raw markdown" },
				},
			},
			{
				name: "Completion date on tasks",
				desc: "When a task checkbox is ticked in a card, append an Obsidian Tasks style done date (✅ 2026-08-06). Unticking removes it.",
				control: { type: "toggle", key: "taskDoneDate" },
			},
			{
				name: "Cross out items nested under a done task",
				desc: "When off, ticking a task strikes through only its own line — sub-tasks and notes nested beneath it keep their normal styling until ticked themselves.",
				control: { type: "toggle", key: "strikeNestedUnderDone" },
			},
			{
				name: "Card height",
				desc: "Maximum card height in pixels before the card body scrolls.",
				control: {
					type: "slider",
					key: "cardMaxHeight",
					min: 160,
					max: 800,
					step: 20,
					displayFormat: (value: number) => `${value}px`,
				},
			},
			{
				type: "group",
				heading: "New cards",
				items: [
					{
						name: "Default heading name",
						desc: 'Moment.js date format used to pre-fill "New card". Default: YYYY-MM-DD, dddd',
						control: { type: "text", key: "newCardFormat", placeholder: "YYYY-MM-DD, dddd" },
					},
					{
						name: "Default placement",
						desc: "Logical order follows the direction the file's sections already run.",
						control: {
							type: "dropdown",
							key: "newCardPlacement",
							options: { top: "Append to top", logical: "Add to logical order", bottom: "Add to bottom" },
						},
					},
				],
			},
		];
	}

	/** headingLevel is stored as a number, but dropdown controls speak strings. */
	getControlValue(key: string): unknown {
		if (key === "headingLevel") return String(this.plugin.settings.headingLevel);
		return super.getControlValue(key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "headingLevel") {
			await super.setControlValue(key, Number(value));
			return;
		}
		if (key === "newCardFormat") {
			const text = typeof value === "string" ? value.trim() : "";
			await super.setControlValue(key, text || DEFAULT_SETTINGS.newCardFormat);
			return;
		}
		await super.setControlValue(key, value);
		if (key === "strikeNestedUnderDone") this.plugin.applyBodyClasses();
		if (key === "titleBarClick") this.plugin.refreshAllViews();
	}
}

export default class SectionCardsPlugin extends Plugin {
	settings: SectionCardsSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		addIcon(DECK_ICON, DECK_SVG);

		this.registerView(VIEW_TYPE_SECTION_CARDS, (leaf) => new SectionCardsView(leaf, this));

		this.addRibbonIcon(DECK_ICON, "Single File Section Cards", (evt) => {
			// Ctrl/⌘-click opens an additional tab even when one already shows the note.
			void this.openCardsView(undefined, undefined, evt.ctrlKey || evt.metaKey ? "new" : "reuse");
		});

		this.addCommand({
			id: "open-section-cards",
			name: "Open section cards (default note)",
			callback: () => this.openCardsView(),
		});

		this.addCommand({
			id: "open-section-cards-new-tab",
			name: "Open section cards in a new tab",
			callback: () => this.openCardsView(undefined, undefined, "new"),
		});

		this.addCommand({
			id: "new-section-card",
			name: "Create new card",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(SectionCardsView);
				if (!view) return false;
				if (!checking) view.promptNewCard();
				return true;
			},
		});

		this.addCommand({
			id: "open-section-cards-current",
			name: "Open section cards for the active note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.openCardsView(file.path);
				return true;
			},
		});

		const onFileChange = debounce(
			(file: TFile) => {
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)) {
					const view = leaf.view as SectionCardsView;
					if (view.filePath === file.path && !view.isEditing() && !view.isMaximized()) void view.refresh();
				}
			},
			400,
			true,
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile) onFileChange(file);
			}),
		);

		// Keep a note's remembered view attached to it when it is renamed or moved.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const saved = this.settings.perFile?.[oldPath];
				if (!saved) return;
				delete this.settings.perFile[oldPath];
				this.settings.perFile[file.path] = saved;
				void this.saveSettings();
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)) {
					const view = leaf.view as SectionCardsView;
					if (view.filePath === oldPath) view.filePath = file.path;
				}
			}),
		);

		this.addSettingTab(new SectionCardsSettingTab(this.app, this));
		this.applyBodyClasses();
	}

	onunload(): void {
		document.body.removeClass("sfsc-no-nested-strike");
	}

	/** Global styling switches live as body classes so every cards view picks them up. */
	applyBodyClasses(): void {
		document.body.toggleClass("sfsc-no-nested-strike", !this.settings.strikeNestedUnderDone);
	}

	/**
	 * "reuse" reveals an existing cards tab already showing the note; "new" always opens
	 * another tab, so any number of cards tabs — including several of the same note — can
	 * be open at once. (Obsidian's native "Duplicate tab" also works on cards tabs.)
	 */
	async openCardsView(filePath?: string, revealHeading?: string, mode: "reuse" | "new" = "reuse"): Promise<void> {
		const path = filePath ?? this.settings.filePath;

		if (mode === "reuse") {
			const existing = this.app.workspace
				.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)
				.find((leaf) => (leaf.view as SectionCardsView).filePath === path);

			if (existing) {
				await this.app.workspace.revealLeaf(existing);
				const view = existing.view as SectionCardsView;
				await view.refresh();
				if (revealHeading) view.revealCard(revealHeading);
				return;
			}
		}

		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_SECTION_CARDS,
			active: true,
			state: {
				filePath: path,
				headingLevel: this.settings.headingLevel,
				sortOrder: this.settings.sortOrder,
				layout: this.settings.layout,
			},
		});
		await this.app.workspace.revealLeaf(leaf);

		// setViewState has already rendered via setState -> syncView.
		if (revealHeading) (leaf.view as SectionCardsView).revealCard(revealHeading);
	}

	getStoredView(path: string): ViewSettings | undefined {
		return this.settings.perFile?.[path];
	}

	async storeView(path: string, view: ViewSettings): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path];
		if (
			current &&
			current.layout === view.layout &&
			current.headingLevel === view.headingLevel &&
			current.sortOrder === view.sortOrder
		) {
			return;
		}
		// The Custom Grid placements ride along; changing the view must not drop them.
		this.settings.perFile[path] = { ...view, customGrid: current?.customGrid };
		await this.saveSettings();
	}

	getCustomGrid(path: string): Record<string, CardRect> {
		return this.settings.perFile?.[path]?.customGrid ?? {};
	}

	getCustomZoom(path: string): number {
		return this.settings.perFile?.[path]?.customZoom ?? 1;
	}

	async saveCustomGrid(
		path: string,
		placements: Record<string, CardRect>,
		base: ViewSettings,
		zoom?: number,
	): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		current.customGrid = placements;
		if (zoom !== undefined) current.customZoom = zoom;
		this.settings.perFile[path] = current;
		await this.saveSettings();
	}

	/** Re-render every open cards view, e.g. after a setting changes what they draw. */
	refreshAllViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)) {
			void (leaf.view as SectionCardsView).refresh();
		}
	}

	/** Open the note in an editor with the cursor parked on the given heading line. */
	async revealSection(file: TFile, line: number): Promise<void> {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file, { active: true, state: { mode: "source" } });
		const view = leaf.view;
		if (view instanceof MarkdownView) {
			const editor = view.editor;
			editor.setCursor({ line, ch: 0 });
			editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
			editor.focus();
		}
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<SectionCardsSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
