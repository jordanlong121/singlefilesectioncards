import {
	App,
	Component,
	FuzzySuggestModal,
	SuggestModal,
	addIcon,
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Scope,
	Setting,
	type SettingDefinition,
	type SettingDefinitionItem,
	setIcon,
	TFile,
	WorkspaceLeaf,
	debounce,
	moment,
	normalizePath,
	prepareFuzzySearch,
	requestUrl,
	type SearchResult,
} from "obsidian";
import { createEmbeddedEditor, type EmbeddedEditor } from "./editor-embed";

export const VIEW_TYPE_SECTION_CARDS = "section-cards-view";

/** Bodies rendered synchronously on open — roughly two screenfuls. The rest render in
 * idle-time batches so a year-long note paints its first cards immediately. A phone
 * shows a single column, so two screenfuls is far fewer cards there. */
const INITIAL_RENDER_COUNT = Platform.isPhone ? 8 : 24;
const DEFERRED_RENDER_BATCH = Platform.isPhone ? 6 : 12;

/** Modifier-key name used in tooltip shortcut hints, matching the platform. */
const MOD_LABEL = Platform.isMacOS ? "⌘" : "Ctrl";

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
 *
 * Hierarchy is not a layout but a toolbar toggle (ViewSettings.hierarchy): drill-down
 * heading columns on the left, with the selected branch's cards rendered in whichever
 * of these layouts is active.
 */
export type Layout = "grid" | "aligned" | "tight" | "horizontal" | "vertical" | "custom" | "calendar";

const SORT_LABELS: Record<SortOrder, string> = { asc: "A → Z", desc: "Z → A", doc: "Document order" };

/** [value, toolbar label, tooltip] */
const LAYOUT_OPTIONS: [Layout, string, string][] = [
	["grid", "Grid", "Masonry columns"],
	["aligned", "Grid Aligned", "Uniform grid: every row starts at the same height"],
	["tight", "Tight", "Denser, narrower masonry columns"],
	["horizontal", "Horizontal", "One card per row, full width"],
	["vertical", "Vertical", "Full-height cards side by side, scrolling sideways"],
	["custom", "Custom Grid", "Freeform canvas: drag cards on from the tray, place and resize them"],
	["calendar", "Calendar", "Date cards on a monthly calendar grid — needs the Dates checkbox"],
];

/** What clicking a card's title bar does. */
export type TitleBarClick = "maximize" | "edit";

/** "live" renders markdown while editing, "source" shows it highlighted — both via
 * Obsidian's editor, falling back to "plain" (a bare textarea) if it's unavailable. */
export type EditorMode = "live" | "source" | "plain";

/** The slice of the Tasks community plugin's public API this plugin uses. */
interface TasksApiV1 {
	/** Opens the Tasks "create task" dialog; resolves to the task line ("" on cancel). */
	createTaskLineModal(): Promise<string>;
	/** Toggles a task line with Tasks semantics (recurrence, done dates); may return
	 * several lines, or the input unchanged when it declines. */
	executeToggleTaskDoneCommand(line: string, path: string): string;
}

interface SectionCardsSettings {
	filePath: string;
	/** A note with a remembered cards view reopens in the cards view, not the editor. */
	autoOpenCards: boolean;
	headingLevel: number;
	/** Heading dropdown lists only the levels the open note contains (else always H1–H6). */
	dynamicLevelOptions: boolean;
	sortOrder: SortOrder;
	cardMaxHeight: number;
	/** Card text size as a percentage of the theme's sizes (100 = theme default). */
	fontScale: number;
	/** Divider-bar text size, percent — independent of the card text scale. */
	dividerFontScale: number;
	newCardFormat: string;
	newCardPlacement: Placement;
	/** Show text above the file's first heading as its own card. */
	unfiledEnabled: boolean;
	/** Display-only title for that card; never written into the note. */
	unfiledTitle: string;
	/** Scroll today's card into view when a note first renders in the view. */
	jumpToToday: boolean;
	/** Keep the pinned band on screen while the rest of the cards scroll. */
	stickyPinned: boolean;
	taskDoneDate: boolean;
	/** Route task toggles through the Tasks plugin when it's installed, so recurring
	 * tasks spawn their next occurrence and done dates follow its settings. */
	tasksToggle: boolean;
	/** Whether ticking a task also strikes through the items nested beneath it. */
	strikeNestedUnderDone: boolean;
	/** Emoji written at the start of a line by right-click → "Add star"; the starred-only
	 * toggle and the block tagging match against it. Stored in the note as literal text. */
	starEmoji: string;
	titleBarClick: TitleBarClick;
	/** Full toolbar with text labels, or the compact one-line version for narrow panes. */
	toolbarStyle: "full" | "compact";
	/** First day of the Calendar layout's weeks; "locale" follows the language default. */
	weekStart: "locale" | "sunday" | "monday";
	/** Extra date-detection pattern: a moment format, optionally wrapped in `*`
	 * wildcards standing for text before/after the date. Empty = built-ins only. */
	dateDetectFormat: string;
	/** Card editor flavour: Obsidian's live-preview editor, or the plain textarea. */
	editorMode: EditorMode;
	/** Periodically write an open card editor's content back to the note. */
	autosaveEnabled: boolean;
	/** Minutes between autosaves while a card editor is open. */
	autosaveMinutes: number;
	layout: Layout;
	/** Hierarchy layout: show a second badge per column row counting its unfinished tasks. */
	hierTaskCounts: boolean;
	/** The nine card colors as configured (label + hex per slot); see CARD_COLORS. */
	palette: PaletteColor[];
	/** Remembered view per note, keyed by vault path. Lives here, never in the note. */
	perFile: Record<string, PerFileView>;
}

/** A note's remembered view plus, for the Custom Grid, its card placements by heading. */
export interface PerFileView extends ViewSettings {
	customGrid?: Record<string, CardRect>;
	customZoom?: number;
	/** Headings pinned to the top of the card wall, in the order they were pinned. */
	pinned?: string[];
	/** Whether this note's headings name dates (today highlight, jump-to-date). Unset
	 * means "decide from the note": on when any heading looks like a date. */
	containsDates?: boolean;
	/** Per-card colors by heading line; values are CARD_COLORS names. */
	colors?: Record<string, string>;
	/** Note whose contents pre-fill the body of every new card made for this note. */
	templatePath?: string;
	/** Vault path of the image shown behind this note's card wall (menu → Background). */
	backgroundImage?: string;
	/** How faded the background image is, 0 (fully visible) to 100 (invisible). */
	backgroundDim?: number;
	/** Background image brightness in percent, 0–200; unset = 100 (untouched). */
	backgroundBrightness?: number;
	/** Background image saturation in percent, 0–100; unset = 100 (untouched). */
	backgroundSaturation?: number;
	/** This note's heading-name format for new cards, overriding the global default. */
	newCardFormat?: string;
}

/** The bit of view state that is remembered per note. */
export interface ViewSettings {
	layout: Layout;
	headingLevel: number;
	sortOrder: SortOrder;
	/** Hierarchy columns toggled on: drill-down heading columns beside the card pane. */
	hierarchy?: boolean;
	/** Section dividers toggled on: a collapsible bar per heading above the card level. */
	sections?: boolean;
	/** Starred-only toggled on: only starred lines (and the cards holding them) show. */
	starredOnly?: boolean;
}

/**
 * The card color palette's nine slots. Slot names key the stored per-card choice and the
 * CSS swatch rules, so they never change — the settings can restyle a slot's label and
 * color, and every card already wearing it follows along.
 */
const CARD_COLORS: [name: string, label: string, hex: string][] = [
	["red", "Red", "#e05252"],
	["orange", "Orange", "#eb8c34"],
	["yellow", "Yellow", "#d4aa14"],
	["green", "Green", "#4ca85a"],
	["cyan", "Cyan", "#2ca0c6"],
	["blue", "Blue", "#4c82eb"],
	["purple", "Purple", "#9b6ee6"],
	["pink", "Pink", "#e26eaa"],
	["gray", "Grey", "#848c94"],
];

/** One palette slot as the user configured it. */
export interface PaletteColor {
	label: string;
	hex: string;
}

/** Ready-made palettes for the settings' preset dropdown, nine colors each. */
export const PALETTE_PRESETS: { name: string; colors: PaletteColor[] }[] = [
	{ name: "Default", colors: CARD_COLORS.map(([, label, hex]) => ({ label, hex })) },
	{
		name: "Catppuccin Mocha",
		colors: [
			{ label: "Red", hex: "#f38ba8" },
			{ label: "Peach", hex: "#fab387" },
			{ label: "Yellow", hex: "#f9e2af" },
			{ label: "Green", hex: "#a6e3a1" },
			{ label: "Sky", hex: "#89dceb" },
			{ label: "Blue", hex: "#89b4fa" },
			{ label: "Mauve", hex: "#cba6f7" },
			{ label: "Pink", hex: "#f5c2e7" },
			{ label: "Overlay", hex: "#7f849c" },
		],
	},
	{
		name: "Nord",
		colors: [
			{ label: "Aurora red", hex: "#bf616a" },
			{ label: "Aurora orange", hex: "#d08770" },
			{ label: "Aurora yellow", hex: "#ebcb8b" },
			{ label: "Aurora green", hex: "#a3be8c" },
			{ label: "Frost teal", hex: "#8fbcbb" },
			{ label: "Frost blue", hex: "#5e81ac" },
			{ label: "Aurora purple", hex: "#b48ead" },
			{ label: "Frost light", hex: "#88c0d0" },
			{ label: "Polar night", hex: "#4c566a" },
		],
	},
	{
		name: "Solarized",
		colors: [
			{ label: "Red", hex: "#dc322f" },
			{ label: "Orange", hex: "#cb4b16" },
			{ label: "Yellow", hex: "#b58900" },
			{ label: "Green", hex: "#859900" },
			{ label: "Cyan", hex: "#2aa198" },
			{ label: "Blue", hex: "#268bd2" },
			{ label: "Violet", hex: "#6c71c4" },
			{ label: "Magenta", hex: "#d33682" },
			{ label: "Base", hex: "#839496" },
		],
	},
	{
		name: "Gruvbox",
		colors: [
			{ label: "Red", hex: "#cc241d" },
			{ label: "Orange", hex: "#d65d0e" },
			{ label: "Yellow", hex: "#d79921" },
			{ label: "Green", hex: "#98971a" },
			{ label: "Aqua", hex: "#689d6a" },
			{ label: "Blue", hex: "#458588" },
			{ label: "Purple", hex: "#b16286" },
			{ label: "Bright purple", hex: "#d3869b" },
			{ label: "Gray", hex: "#928374" },
		],
	},
	{
		name: "Dracula",
		colors: [
			{ label: "Red", hex: "#ff5555" },
			{ label: "Orange", hex: "#ffb86c" },
			{ label: "Yellow", hex: "#f1fa8c" },
			{ label: "Green", hex: "#50fa7b" },
			{ label: "Cyan", hex: "#8be9fd" },
			{ label: "Comment", hex: "#6272a4" },
			{ label: "Purple", hex: "#bd93f9" },
			{ label: "Pink", hex: "#ff79c6" },
			{ label: "Current line", hex: "#44475a" },
		],
	},
	{
		name: "Pastel",
		colors: [
			{ label: "Rose", hex: "#eaa1a6" },
			{ label: "Peach", hex: "#f5c39a" },
			{ label: "Lemon", hex: "#efe1a0" },
			{ label: "Mint", hex: "#a8d8b9" },
			{ label: "Sky", hex: "#a3d5e8" },
			{ label: "Periwinkle", hex: "#aab8e8" },
			{ label: "Lilac", hex: "#c9aee5" },
			{ label: "Blush", hex: "#f0bcd5" },
			{ label: "Stone", hex: "#b8bcc2" },
		],
	},
];

/** "#rgb"/"#rrggbb" → "r, g, b" for the rgba(var(--sfsc-c), α) rules; null when invalid. */
export function hexToTriplet(hex: string): string | null {
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	let digits = m[1];
	if (digits.length === 3) digits = digits.replace(/./g, (c) => c + c);
	const n = parseInt(digits, 16);
	return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/**
 * Black or white, whichever reads better on the given color (YIQ perceived brightness).
 * Biased strongly toward white: mid-tone colors read as dark bars inside a dark theme,
 * so only genuinely pale colors (pastels, near-whites) flip the foreground to black.
 */
export function contrastForeground(hex: string): string {
	const triplet = hexToTriplet(hex);
	if (!triplet) return "#ffffff";
	const [r, g, b] = triplet.split(", ").map(Number);
	return (r * 299 + g * 587 + b * 114) / 1000 >= 200 ? "#000000" : "#ffffff";
}

/**
 * The light-theme counterpart: dark text like the theme's own bars, unless the color
 * is genuinely dark. Colored bars sit on a light page there, so the bias reverses —
 * the threshold sits near the point where black and white text read equally well.
 */
export function contrastForegroundLight(hex: string): string {
	const triplet = hexToTriplet(hex);
	if (!triplet) return "#000000";
	const [r, g, b] = triplet.split(", ").map(Number);
	return (r * 299 + g * 587 + b * 114) / 1000 >= 110 ? "#000000" : "#ffffff";
}

/**
 * The palette as configured: saved entries over the slot defaults, always nine slots.
 * Blank labels and unparseable colors fall back per field, so old or hand-edited data
 * can't blank out a slot.
 */
export function normalizePalette(saved: Partial<PaletteColor>[] | undefined): PaletteColor[] {
	return CARD_COLORS.map(([, label, hex], i) => {
		const entry = saved?.[i];
		return {
			label: entry?.label?.trim() || label,
			hex: entry?.hex && hexToTriplet(entry.hex) ? entry.hex : hex,
		};
	});
}

const DEFAULT_SETTINGS: SectionCardsSettings = {
	filePath: "Daily Notes 2026.md",
	autoOpenCards: false,
	headingLevel: 3,
	dynamicLevelOptions: true,
	sortOrder: "asc",
	cardMaxHeight: 320,
	fontScale: 100,
	dividerFontScale: 100,
	newCardFormat: "YYYY-MM-DD, dddd",
	newCardPlacement: "logical",
	unfiledEnabled: false,
	unfiledTitle: "_Unfiled_",
	jumpToToday: true,
	stickyPinned: true,
	taskDoneDate: true,
	tasksToggle: true,
	strikeNestedUnderDone: true,
	starEmoji: "⭐",
	titleBarClick: "maximize",
	toolbarStyle: "compact",
	weekStart: "locale",
	dateDetectFormat: "",
	editorMode: "live",
	autosaveEnabled: true,
	autosaveMinutes: 5,
	layout: "grid",
	hierTaskCounts: true,
	palette: CARD_COLORS.map(([, label, hex]) => ({ label, hex })),
	perFile: {},
};

/** One heading and everything beneath it, down to the next heading of the same or higher rank. */
interface Section {
	/** Ordinal position in the document, 0-based (-1 for the synthetic unfiled card). */
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
	/** True for the synthetic card holding text above the file's first heading. Its
	 * title is display-only, its raw has no heading line, and writes re-locate it by
	 * position (the preamble is unique) rather than by content. */
	unfiled?: boolean;
}

/** obsidian's `moment` re-export is typed as a namespace; this is the callable form. */
const mo = moment as unknown as (input?: string, format?: string) => { format: (format: string) => string };

/** The strict-parsing form, for asking whether a title *is* a date in a given format. */
const moParse = moment as unknown as (
	input: string,
	format: string,
	strict: boolean,
) => { isValid: () => boolean; format: (format: string) => string };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;

/** An ISO date anywhere in a title — the one spelling every date feature recognizes. */
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}/;

/** Whether an ISO-shaped string names a real day (rejects 2026-13-99 without moment). */
function validIsoDate(iso: string): boolean {
	const y = Number(iso.slice(0, 4));
	const m = Number(iso.slice(5, 7));
	const d = Number(iso.slice(8, 10));
	const dt = new Date(y, m - 1, d);
	return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function parseSections(lines: string[], level: number): Section[] {
	const sections: Section[] = [];
	let inFence = false;
	let inFrontmatter = false;
	// Only blanks seen so far: a properties block still counts after stray leading
	// blank lines, so its `---` fences never read as content (see firstContentLine).
	let beforeContent = true;

	// A heading of rank <= level closes the current section.
	const starts: { line: number; title: string; headingRaw: string }[] = [];
	const closers: number[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (beforeContent) {
			if (line.trim() === "") continue;
			beforeContent = false;
			if (line.trim() === "---") {
				inFrontmatter = true;
				continue;
			}
		}
		if (inFrontmatter) {
			if (line.trim() === "---") inFrontmatter = false;
			continue;
		}
		// First-character gate: fences start with a backtick/tilde or indentation, and
		// headings with '#'. Most lines are neither, and skipping both regexes for them
		// makes this parse — which runs on every refresh — mostly a charCode scan.
		const c0 = line.charCodeAt(0);
		if ((c0 === 96 || c0 === 126 || c0 === 32 || c0 === 9) && FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || c0 !== 35) continue;

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
	// The unfiled card is the top of the file, not an alphabetical peer — keep it first.
	const pre = sorted.findIndex((s) => s.unfiled);
	if (pre > 0) sorted.unshift(...sorted.splice(pre, 1));
	return sorted;
}

/**
 * Pull pinned sections to the front, keeping the incoming sort order within both the
 * pinned group and the rest — pinning overrides *where* a card sits, not how it sorts.
 */
export function applyPinned(sections: Section[], pinned: string[]): Section[] {
	if (!pinned.length) return sections;
	const keys = new Set(pinned);
	const pin = sections.filter((s) => keys.has(s.headingRaw));
	if (!pin.length || pin.length === sections.length) return sections;
	return [...pin, ...sections.filter((s) => !keys.has(s.headingRaw))];
}

/**
 * First line after any frontmatter block — the top of the note's real content. The
 * properties block is honored even when stray blank lines precede it (sync tools and
 * hand edits leave them), so nothing computed from here ever writes above or into the
 * `---` fences.
 */
function firstContentLine(lines: string[]): number {
	let first = 0;
	while (first < lines.length && lines[first].trim() === "") first++;
	if (lines[first]?.trim() !== "---") return 0;
	for (let i = first + 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") return i + 1;
	}
	return 0;
}

/** The unfiled card's key in per-note state (pins, placements). Real sections are keyed
 * by their heading line, which always starts with #, so this can never collide. */
export const UNFILED_KEY = "::unfiled::";

/**
 * The synthetic section for text sitting above the file's first heading (of any rank),
 * below any frontmatter — text that otherwise never appears in a card. Null when there
 * is no such text. Its raw is body-only: the title is display-only and never written.
 */
export function unfiledSection(lines: string[], title: string): Section | null {
	let start = firstContentLine(lines);
	while (start < lines.length && lines[start].trim() === "") start++;

	let end = lines.length;
	let inFence = false;
	for (let i = start; i < lines.length; i++) {
		if (FENCE_RE.test(lines[i])) {
			inFence = !inFence;
			continue;
		}
		if (!inFence && HEADING_RE.test(lines[i])) {
			end = i;
			break;
		}
	}

	const bodyLines = lines.slice(start, end);
	while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
	if (!bodyLines.length) return null;

	const body = bodyLines.join("\n");
	return {
		index: -1,
		title,
		headingRaw: UNFILED_KEY,
		headingLine: start,
		body,
		raw: body,
		startLine: start,
		endLine: start + bodyLines.length,
		unfiled: true,
	};
}

/** Every card the view shows: parsed sections plus, when enabled, the unfiled card. */
export function parseCards(lines: string[], level: number, unfiledTitle: string | null): Section[] {
	const sections = parseSections(lines, level);
	const pre = unfiledTitle ? unfiledSection(lines, unfiledTitle) : null;
	return pre ? [pre, ...sections] : sections;
}

/** A heading shallower than the card level — the Hierarchy layout's drill-down data. */
export interface AncestorHeading {
	level: number;
	title: string;
	/** The heading line exactly as it appears in the file. */
	raw: string;
	/** 0-based line number. */
	line: number;
}

/**
 * Every heading of rank < cardLevel, skipping frontmatter and code fences the same way
 * parseSections does, so a card's ancestors agree with the card boundaries.
 */
export function parseAncestorHeadings(lines: string[], cardLevel: number): AncestorHeading[] {
	const found: AncestorHeading[] = [];
	let inFence = false;
	let inFrontmatter = false;
	let beforeContent = true; // as in parseSections: properties survive leading blanks
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (beforeContent) {
			if (line.trim() === "") continue;
			beforeContent = false;
			if (line.trim() === "---") {
				inFrontmatter = true;
				continue;
			}
		}
		if (inFrontmatter) {
			if (line.trim() === "---") inFrontmatter = false;
			continue;
		}
		// Same first-character gate as parseSections; this too runs per refresh.
		const c0 = line.charCodeAt(0);
		if ((c0 === 96 || c0 === 126 || c0 === 32 || c0 === 9) && FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || c0 !== 35) continue;
		const match = HEADING_RE.exec(line);
		if (!match) continue;
		const rank = match[1].length;
		if (rank < cardLevel) found.push({ level: rank, title: match[2].trim(), raw: line, line: i });
	}
	return found;
}

/** Which heading levels (1–6) actually occur in the note, ascending — the toolbar's
 * Heading dropdown offers only these. (Rank < 7 collects every heading.) */
export function headingLevelsIn(lines: string[]): number[] {
	const found = new Set<number>();
	for (const h of parseAncestorHeadings(lines, 7)) found.add(h.level);
	return [...found].sort((a, b) => a - b);
}

/** The Hierarchy layout's synthetic "no heading at this level" item key. Real items are
 * keyed by their heading line, which always starts with #, so this can never collide. */
export const HIER_GAP_KEY = "::hier-gap::";

/** One clickable row in a Hierarchy column, with the [start, end) line range it owns. */
export interface HierarchyItem {
	/** The heading line as written, or HIER_GAP_KEY for the synthetic gap item. */
	key: string;
	label: string;
	start: number;
	end: number;
}

/**
 * The items one Hierarchy column shows: the level-`level` headings inside the selected
 * parent's [start, end) range, each owning the lines up to its next sibling. Cards that
 * sit in the range before the first such heading (or in a range with none at all) get a
 * synthetic "(no H`level`)" item, so every card stays reachable.
 */
export function hierarchyColumnItems(
	headings: AncestorHeading[],
	level: number,
	start: number,
	end: number,
	cardLines: number[],
): HierarchyItem[] {
	const children = headings.filter((h) => h.level === level && h.line >= start && h.line < end);
	const items: HierarchyItem[] = children.map((h, i) => ({
		key: h.raw,
		label: h.title || "(untitled)",
		start: h.line,
		end: i + 1 < children.length ? children[i + 1].line : end,
	}));
	const gapEnd = children.length ? children[0].line : end;
	if (cardLines.some((l) => l >= start && l < gapEnd)) {
		items.unshift({ key: HIER_GAP_KEY, label: `(no H${level})`, start, end: gapEnd });
	}
	return items;
}

/** One Sections-layout group: the cards under the same nearest ancestor heading. */
export interface SectionGroup {
	/** The ancestor heading's raw line, or "" for cards with no ancestor. */
	key: string;
	title: string;
	sections: Section[];
}

/**
 * Sections layout: split an ordered card list into groups by nearest ancestor
 * heading (any level above the cards', so skipped levels still divide). Groups keep
 * the order of their first card, so the active sort decides which group leads;
 * within a group the given order is unchanged. Duplicate ancestor text stays two
 * groups (grouping is by line) but shares one collapse key (the raw line).
 */
export function groupByAncestor(sections: Section[], ancestors: AncestorHeading[]): SectionGroup[] {
	const groups = new Map<number, SectionGroup>();
	for (const section of sections) {
		let parent: AncestorHeading | undefined;
		for (const a of ancestors) {
			if (a.line > section.headingLine) break;
			parent = a;
		}
		let group = groups.get(parent?.line ?? -1);
		if (!group) {
			group = {
				key: parent?.raw ?? "",
				title: parent ? parent.title || "(untitled)" : "(no parent heading)",
				sections: [],
			};
			groups.set(parent?.line ?? -1, group);
		}
		group.sections.push(section);
	}
	return [...groups.values()];
}

/** First line of a section's body: the unfiled card has no heading line to skip. */
function bodyStartLine(section: Section): number {
	return section.unfiled ? section.startLine : section.startLine + 1;
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

/** A parsed date plus the [start, end) span of the title's characters that spelled it,
 * so a retitle can swap just those characters and keep the rest of the title. */
interface TitleDateMatch {
	parsed: { format: (f: string) => string };
	start: number;
	end: number;
	/** The moment format the span was parsed with — how a new date should be written back. */
	core: string;
}

/** The [start, end) offsets of each of a title's first `max` words (whitespace-delimited). */
function wordSpans(title: string, max: number): { start: number; end: number }[] {
	const spans: { start: number; end: number }[] = [];
	const re = /\S+/g;
	let m: RegExpExecArray | null;
	while (spans.length < max && (m = re.exec(title)) !== null) {
		spans.push({ start: m.index, end: m.index + m[0].length });
	}
	return spans;
}

/** How words are trimmed when a window leaves punctuation at a candidate's edge. */
const EDGE_PUNCT_RE = /^[\s,;:–—-]+|[\s,;:–—-]+$/gu;

/**
 * Strict-parse a title against the heading format: the whole title, or a prefix
 * ending at a word boundary — a heading that STARTS with a date is a date heading,
 * so "August 26, 2026 — review" (format "MMMM D, YYYY") still reads as its date.
 * Longest prefix wins; trailing punctuation on a prefix is forgiven.
 */
function titleFormatDate(title: string, format: string): TitleDateMatch | null {
	const trimmed = format.trim();
	if (!trimmed) return null;
	const words = wordSpans(title, 8);
	for (let n = words.length - 1; n >= 0; n--) {
		const lead = words[0].start;
		const raw = title.slice(lead, words[n].end).replace(/[\s,;:–—-]+$/u, "");
		const parsed = moParse(raw.replace(/\s+/g, " "), trimmed, true);
		if (parsed.isValid()) return { parsed, start: lead, end: lead + raw.length, core: trimmed };
	}
	return null;
}

/**
 * Parse a title against the user's date-detection pattern (settings → "Date
 * detection format"): a moment format optionally wrapped in `*` wildcards that
 * stand for arbitrary text before and/or after the date. `*MMMM D, YYYY*` finds
 * the date anywhere; without a `*`, that side of the title must end with it.
 */
function titleDetectSpan(title: string, pattern: string): TitleDateMatch | null {
	const trimmed = pattern.trim();
	if (!trimmed) return null;
	const leading = trimmed.startsWith("*");
	const trailing = trimmed.endsWith("*");
	const core = trimmed.replace(/^\*+/, "").replace(/\*+$/, "").trim();
	if (!core) return null;
	const words = wordSpans(title, Number.MAX_SAFE_INTEGER);
	const maxStart = leading ? Math.min(words.length - 1, 11) : 0;
	for (let start = 0; start <= maxStart; start++) {
		// Candidate word-windows: any length up to 8 with a trailing wildcard,
		// otherwise the window must reach the title's end.
		const windowEnds: number[] = [];
		if (trailing) {
			for (let end = Math.min(words.length, start + 8); end > start; end--) windowEnds.push(end);
		} else if (words.length - start <= 8) {
			windowEnds.push(words.length);
		}
		for (const end of windowEnds) {
			const raw = title.slice(words[start].start, words[end - 1].end);
			// Edge punctuation a wildcard left behind sits outside the date's span.
			const lead = /^[\s,;:–—-]*/u.exec(raw)![0].length;
			const candidate = raw.replace(EDGE_PUNCT_RE, "");
			if (!candidate) continue;
			const parsed = moParse(candidate.replace(/\s+/g, " "), core, true);
			if (parsed.isValid()) {
				const from = words[start].start + lead;
				return { parsed, start: from, end: from + candidate.length, core };
			}
		}
	}
	return null;
}

/** The date the custom detection pattern finds in a title, if any (see titleDetectSpan). */
export function titleDetectDate(title: string, pattern: string): { format: (f: string) => string } | null {
	return titleDetectSpan(title, pattern)?.parsed ?? null;
}

/** Does a heading title look like a date: a real ISO date anywhere, the new-card format
 * as the whole title or its leading words, or the custom detection pattern? */
export function titleHasDate(title: string, format: string, detect = ""): boolean {
	return titleToIso(title, format, detect) !== null;
}

/** The date a heading names, as YYYY-MM-DD: a valid ISO date anywhere in the title wins,
 * then the heading format at the title's start, then the custom detection pattern. */
export function titleToIso(title: string, format: string, detect = ""): string | null {
	const iso = ISO_DATE_RE.exec(title)?.[0];
	if (iso && validIsoDate(iso)) return iso;
	return (titleFormatDate(title, format) ?? titleDetectSpan(title, detect))?.parsed.format("YYYY-MM-DD") ?? null;
}

/**
 * The title after a card is moved to another day (Calendar drag). Whichever spelling
 * placed the card on the calendar — the heading format at the title's start, a raw ISO
 * date anywhere, or the custom detection pattern — is swapped for the new day in that
 * same spelling; the rest of the title stays. A title whose date can't be located is
 * replaced with the new day in the heading format.
 */
export function retitledDateTitle(title: string, format: string, iso: string, detect = ""): string {
	const to = moParse(iso, "YYYY-MM-DD", true);
	const t = title.trim();
	const old = titleFormatDate(t, format);
	if (old) return to.format(format) + t.slice(old.end);
	const rawIso = ISO_DATE_RE.exec(t)?.[0];
	if (rawIso) {
		let out = t.replace(rawIso, iso);
		// A weekday word naming the old day follows the date to the new one.
		const from = moParse(rawIso, "YYYY-MM-DD", true);
		const oldDow = from.isValid() ? from.format("dddd") : "";
		if (/^[\p{L}]+$/u.test(oldDow)) {
			const dowRe = new RegExp(`(?<![\\p{L}])${oldDow}(?![\\p{L}])`, "u");
			if (dowRe.test(out)) out = out.replace(dowRe, to.format("dddd"));
		}
		return out;
	}
	const det = titleDetectSpan(t, detect);
	if (det) return t.slice(0, det.start) + to.format(det.core) + t.slice(det.end);
	return to.format(format);
}

/** Date-looking headings per level (index 1–6), in one pass over the file. */
export function dateHeadingCounts(lines: string[], format: string, detect = ""): number[] {
	const counts = [0, 0, 0, 0, 0, 0, 0];
	// Level 7 keeps nothing out: every real heading (1–6) comes back, each seen once.
	for (const h of parseAncestorHeadings(lines, 7)) {
		if (titleHasDate(h.title, format, detect)) counts[h.level]++;
	}
	return counts;
}

/** The heading level whose headings name days — where the Calendar layout finds its
 * cards. The level with the most date-looking headings wins; null when none has any. */
export function dateHeadingLevel(lines: string[], format: string, detect = ""): number | null {
	return bestDateLevel(dateHeadingCounts(lines, format, detect));
}

/** The level with the most date headings in a dateHeadingCounts tally (ties go shallower). */
export function bestDateLevel(counts: number[]): number | null {
	let best: number | null = null;
	let bestCount = 0;
	for (let level = 1; level <= 6; level++) {
		if (counts[level] > bestCount) {
			best = level;
			bestCount = counts[level];
		}
	}
	return best;
}

/**
 * Fill a template's `{{title}}`, `{{date}}` and `{{time}}` placeholders (with optional
 * `{{date:FORMAT}}` variants, like Obsidian's core Templates). `{{date}}` uses the date
 * named in the card's heading when there is one, so a template dropped into a card for
 * 2026-08-20 writes that day rather than today; `{{time}}` is always now.
 */
export function applyTemplatePlaceholders(raw: string, title: string, headingFormat: string): string {
	const iso = ISO_DATE_RE.exec(title)?.[0];
	let cardDate: { format: (f: string) => string };
	if (iso) {
		cardDate = mo(iso, "YYYY-MM-DD");
	} else {
		const strict = headingFormat.trim() ? moParse(title.trim(), headingFormat.trim(), true) : null;
		cardDate = strict?.isValid() ? strict : mo();
	}
	return raw
		.replace(/\{\{\s*title\s*\}\}/gi, title)
		.replace(/\{\{\s*date\s*(?::([^}]*))?\}\}/gi, (_, f: string | undefined) =>
			cardDate.format(f?.trim() || "YYYY-MM-DD"),
		)
		.replace(/\{\{\s*time\s*(?::([^}]*))?\}\}/gi, (_, f: string | undefined) =>
			mo().format(f?.trim() || "HH:mm"),
		);
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

/**
 * Re-locate any card at write time. The unfiled card is found by position — the
 * preamble is unique, so re-deriving it is more robust than content matching.
 * Everything else goes through locateSection's content matching as before.
 */
function locateCard(lines: string[], level: number, original: Section): Section | undefined {
	if (original.unfiled) return unfiledSection(lines, original.title) ?? undefined;
	return locateSection(parseSections(lines, level), original);
}

/**
 * The section as it stands on disk right after `edited` has been written over it.
 * Autosave re-describes the open editor's Section with this so the next write — and
 * the final save's changed-content check — still find the block, even if the heading
 * line itself was edited.
 */
export function sectionFromEdited(original: Section, edited: string): Section {
	const lines = edited.split("\n");
	// The unfiled card has no heading line: the whole editor content is its body.
	if (original.unfiled) {
		return { ...original, body: edited, raw: edited, endLine: original.startLine + lines.length };
	}
	const headingRaw = lines[0] ?? original.headingRaw;
	return {
		...original,
		headingRaw,
		title: headingRaw.replace(/^#+\s*/, "").trim(),
		body: lines.slice(1).join("\n"),
		raw: edited,
		endLine: original.startLine + lines.length,
	};
}

/** One draggable unit of a section body: a top-level list item (with its children) or a paragraph. */
export interface BodyBlock {
	kind: "item" | "paragraph" | "other";
	/** [start, end) offsets into the section's body lines. */
	start: number;
	end: number;
}

const LIST_START_RE = /^(?:[-*+]|\d+[.)])\s+/;
/** A thematic break: 3+ of the same marker, optionally space-separated — rendered <hr>. */
const HR_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** A setext underline: with a paragraph line directly above, the pair renders <h1>/<h2>. */
const SETEXT_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;

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
		} else if (HR_RE.test(line)) {
			// A thematic break renders <hr> — and outranks a list reading ("- - -").
			blocks.push({ kind: "other", start, end: ++i });
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
			let kind: BodyBlock["kind"] = "paragraph";
			while (
				i < body.length &&
				!isBlank(body[i]) &&
				!LIST_START_RE.test(body[i]) &&
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
const BLOCK_PREFIX_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s+)?/;

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

/** Delete a block at write time, re-locating the section and verifying the block's text. */
async function deleteBlockInFile(
	app: App,
	file: TFile,
	level: number,
	from: Section,
	blockIndex: number,
	expectedBlockText: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, from);
		if (!target) {
			ok = false;
			return data;
		}
		const body = lines.slice(bodyStartLine(target), target.endLine);
		const block = movableBlocks(body)[blockIndex];
		if (!block || body.slice(block.start, block.end).join("\n") !== expectedBlockText) {
			ok = false; // the block moved or changed since the menu opened — refuse
			return data;
		}
		const result = removeBlock(lines, target, blockIndex);
		return result ? result.join(eol) : data;
	});

	return ok;
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
	anchorIndex: number | "start" | null,
	anchorSide: "before" | "after" = "before",
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const from = locateCard(lines, level, moved);
		const to = locateCard(lines, level, targetSection);
		if (!from || !to) {
			ok = false;
			return data;
		}
		const body = lines.slice(bodyStartLine(from), from.endLine);
		const block = movableBlocks(body)[blockIndex];
		if (!block || body.slice(block.start, block.end).join("\n") !== expectedBlockText) {
			ok = false; // the block moved or changed since the drag started — refuse
			return data;
		}
		const result = moveBlockBetween(lines, from, blockIndex, to, anchorIndex, anchorSide);
		return result ? result.join(eol) : data;
	});

	return ok;
}

/** Star or unstar a block at write time, re-locating the section and verifying the
 * block's text the same way delete and move do. */
async function toggleStarInFile(
	app: App,
	file: TFile,
	level: number,
	from: Section,
	blockIndex: number,
	expectedBlockText: string,
	emoji: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, from);
		if (!target) {
			ok = false;
			return data;
		}
		const bodyStart = bodyStartLine(target);
		const body = lines.slice(bodyStart, target.endLine);
		const block = movableBlocks(body)[blockIndex];
		if (!block || body.slice(block.start, block.end).join("\n") !== expectedBlockText) {
			ok = false; // the block moved or changed since the menu opened — refuse
			return data;
		}
		lines[bodyStart + block.start] = toggleStarInLine(lines[bodyStart + block.start], emoji);
		return lines.join(eol);
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
		const line = lines[i];
		// First-character gate: fences open with a backtick/tilde or indentation, and
		// task lines with indentation, a list marker, or an ordinal. Body scans run per
		// card per render (and per hierarchy badge count), so cheap rejection matters.
		const c0 = line.charCodeAt(0);
		const indented = c0 === 32 || c0 === 9;
		if ((c0 === 96 || c0 === 126 || indented) && FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const listish = indented || c0 === 45 || c0 === 42 || c0 === 43 || (c0 >= 48 && c0 <= 57);
		if (listish && TASK_RE.test(line)) out.push(i);
	}
	return out;
}

/** How many of a section body's tasks are still unchecked, skipping fenced code. */
export function openTaskCount(body: string): number {
	const lines = body.split("\n");
	let open = 0;
	for (const i of taskLineIndexes(lines)) {
		if (TASK_RE.exec(lines[i])?.[2] === " ") open++;
	}
	return open;
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
		const target = locateCard(lines, level, original);
		if (!target) return data;

		const body = lines.slice(bodyStartLine(target), target.endLine);
		const tasks = taskLineIndexes(body);
		if (nth >= tasks.length) return data;

		const at = bodyStartLine(target) + tasks[nth];
		const updated = toggleTaskLine(lines[at], todayISO, addDoneDate);
		if (updated === lines[at]) return data;

		lines[at] = updated;
		result = /^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]/.test(updated);
		return lines.join(eol);
	});

	return result;
}

/**
 * Toggle the nth task of a section through the Tasks plugin, so its semantics apply —
 * a recurring task spawns its next occurrence, done dates follow its settings. Returns
 * the new checked state, or null when the task can't be located or Tasks declines.
 */
async function toggleTaskWithTasksApi(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	nth: number,
	api: TasksApiV1,
): Promise<boolean | null> {
	let result: boolean | null = null;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);
		if (!target) return data;

		const body = lines.slice(bodyStartLine(target), target.endLine);
		const tasks = taskLineIndexes(body);
		if (nth >= tasks.length) return data;

		const at = bodyStartLine(target) + tasks[nth];
		const before = lines[at];
		let replacement: string;
		try {
			replacement = api.executeToggleTaskDoneCommand(before, file.path);
		} catch {
			return data;
		}
		if (typeof replacement !== "string" || !replacement.trim() || replacement === before) return data;

		lines.splice(at, 1, ...replacement.split(/\r?\n/));
		result = TASK_RE.exec(before)?.[2].toLowerCase() !== "x";
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
	const resolved: ViewSettings = {
		layout: saved?.layout ?? fromState.layout ?? defaults.layout,
		headingLevel: saved?.headingLevel ?? fromState.headingLevel ?? defaults.headingLevel,
		sortOrder: saved?.sortOrder ?? fromState.sortOrder ?? defaults.sortOrder,
		hierarchy: saved?.hierarchy ?? fromState.hierarchy ?? defaults.hierarchy ?? false,
		sections: saved?.sections ?? fromState.sections ?? defaults.sections ?? false,
		starredOnly: saved?.starredOnly ?? fromState.starredOnly ?? defaults.starredOnly ?? false,
	};
	// Hierarchy briefly shipped as a layout; stored views from then become grid + columns.
	if ((resolved.layout as string) === "hierarchy") {
		resolved.layout = "grid";
		resolved.hierarchy = true;
	}
	// Sections did too; stored views from then become grid + divider bars.
	if ((resolved.layout as string) === "sections") {
		resolved.layout = "grid";
		resolved.sections = true;
	}
	// The divider bars and the hierarchy columns both group by the ancestor headings —
	// never both at once. The columns win a stale both-on state.
	if (resolved.hierarchy) resolved.sections = false;
	return resolved;
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

/**
 * Merge one section into another: `from`'s body lines land at the bottom of `into`'s
 * body (like a Quick Add), and `from`'s section — heading included — is removed.
 * Both sections must come from a fresh parse of `lines`.
 */
export function mergeSections(lines: string[], from: Section, into: Section): string[] {
	// Merging must not change how the file ends (e.g. its trailing newline).
	let tailBlanks = 0;
	while (tailBlanks < lines.length && lines[lines.length - 1 - tailBlanks].trim() === "") tailBlanks++;

	const body = lines.slice(bodyStartLine(from), from.endLine);
	while (body.length && body[body.length - 1].trim() === "") body.pop();
	const [delStart, delEnd] = sectionDeleteRange(lines, from);
	const out = lines.slice(0, delStart).concat(lines.slice(delEnd));
	// into.endLine excludes the blank separator; shift it when `from` sat above it.
	const at = delEnd <= into.endLine ? into.endLine - (delEnd - delStart) : into.endLine;
	out.splice(at, 0, ...body);

	while (out.length && out[out.length - 1].trim() === "") out.pop();
	for (let i = 0; i < tailBlanks; i++) out.push("");
	return out;
}

/** Calendar merge at write time, re-locating both sections like every other write. */
async function mergeSectionsInFile(
	app: App,
	file: TFile,
	level: number,
	fromOriginal: Section,
	intoOriginal: Section,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const from = locateCard(lines, level, fromOriginal);
		const into = locateCard(lines, level, intoOriginal);
		if (!from || !into || from.unfiled || into.unfiled || from.startLine === into.startLine) {
			ok = false;
			return data;
		}
		return mergeSections(lines, from, into).join(eol);
	});

	return ok;
}

/** Rewrite a card's heading line (Calendar day move); the body stays byte-for-byte. */
async function retitleSectionInFile(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	newHeading: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);
		if (!target || target.unfiled) {
			ok = false;
			return data;
		}
		const out = lines.slice();
		out[target.startLine] = newHeading;
		return out.join(eol);
	});

	return ok;
}

/** Where Quick Add drops its text within the section body. */
export type QuickAddPlacement = "top" | "bottom";

/**
 * Insert text lines into a section's body: "top" goes right under the heading, "bottom"
 * right after the last content line (before the blank separator, which endLine excludes).
 */
export function insertIntoSection(
	lines: string[],
	section: Section,
	text: string,
	where: QuickAddPlacement,
): string[] {
	const insert = text.replace(/\s+$/, "").split(/\r?\n/);
	const at = where === "top" ? bodyStartLine(section) : section.endLine;
	const out = lines.slice();
	out.splice(at, 0, ...insert);
	return out;
}

/** Quick Add's write: re-locates the section at write time like every other write. */
async function quickAddToSection(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	text: string,
	where: QuickAddPlacement,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);
		if (!target) {
			ok = false;
			return data;
		}
		return insertIntoSection(lines, target, text, where).join(eol);
	});

	return ok;
}

/**
 * Insert text right after a movable block. Paragraph content gets blank-line separation
 * from non-blank neighbours — the same padding a block move applies — so a pasted
 * paragraph doesn't merge into the block above or the paragraph below.
 */
export function insertAfterBlock(lines: string[], section: Section, blockIndex: number, text: string): string[] | null {
	const bodyStart = bodyStartLine(section);
	const body = lines.slice(bodyStart, section.endLine);
	const block = movableBlocks(body)[blockIndex];
	if (!block) return null;
	const ins = text.replace(/\s+$/, "").split(/\r?\n/);
	const kinds = sectionBlocks(ins);
	const at = bodyStart + block.end;
	const out = lines.slice();
	if (kinds[0]?.kind === "paragraph" && at > 0 && out[at - 1].trim() !== "") ins.unshift("");
	if (kinds[kinds.length - 1]?.kind === "paragraph" && at < out.length && out[at].trim() !== "") ins.push("");
	out.splice(at, 0, ...ins);
	return out;
}

/** Paste at a section's end: like Quick Add's bottom insert, but a pasted paragraph
 * gets a blank line above it so it doesn't merge into the last line of the body. */
async function pasteAtSectionEnd(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	text: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);
		if (!target) {
			ok = false;
			return data;
		}
		const ins = text.replace(/\s+$/, "").split(/\r?\n/);
		const at = target.endLine;
		if (sectionBlocks(ins)[0]?.kind === "paragraph" && at > 0 && lines[at - 1].trim() !== "") ins.unshift("");
		const out = lines.slice();
		out.splice(at, 0, ...ins);
		return out.join(eol);
	});

	return ok;
}

/** Insert text right after a given movable block, verifying the block's text first. */
async function insertAfterBlockInFile(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	blockIndex: number,
	expectedBlockText: string,
	text: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);
		if (!target) {
			ok = false;
			return data;
		}
		const body = lines.slice(bodyStartLine(target), target.endLine);
		const block = movableBlocks(body)[blockIndex];
		if (!block || body.slice(block.start, block.end).join("\n") !== expectedBlockText) {
			ok = false;
			return data;
		}
		const result = insertAfterBlock(lines, target, blockIndex, text);
		return result ? result.join(eol) : data;
	});

	return ok;
}

/** Remove a section from the file, re-locating it at write time like every other write. */
async function deleteSection(app: App, file: TFile, level: number, original: Section): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);
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

/** Insert a new section — empty, or with a template body — and return the heading level written. */
async function insertSection(
	app: App,
	file: TFile,
	headingRaw: string,
	placement: Placement,
	body?: string,
): Promise<{ level: number; duplicate: boolean }> {
	const level = (/^#+/.exec(headingRaw)?.[0] ?? "###").length;
	const title = headingRaw.replace(/^#+\s*/, "").trim();
	// Shed blank lines at either end (but not first-line indentation) before splicing.
	const bodyLines = body?.trim() ? body.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "").split(/\r?\n/) : [];
	let duplicate = false;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		duplicate = parseSections(lines, level).some((s) => s.title === title);
		const at = insertionLine(lines, level, title, placement);
		lines.splice(at, 0, headingRaw, ...bodyLines, "");
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
		const target = locateCard(lines, level, original);

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
	/** The card's body container, cached so refreshes don't re-query it per card. */
	bodyEl: HTMLElement;
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
	hierarchy?: boolean;
	sections?: boolean;
	starredOnly?: boolean;
}

export class SectionCardsView extends ItemView {
	plugin: SectionCardsPlugin;

	filePath: string;
	headingLevel: number;
	sortOrder: SortOrder;
	layout: Layout;
	/** Hierarchy columns toggled on (toolbar button); the cards keep the chosen layout. */
	hierarchyOn = false;
	/** Section dividers toggled on (toolbar button); mutually exclusive with the columns. */
	sectionsOn = false;
	/** Starred-only toggled on (toolbar star): only starred lines and their cards show. */
	starredOnly = false;

	private toolbarEl!: HTMLElement;
	private gridEl!: HTMLElement;
	/** One entry per card in DOM order: element, its render scope, and its section. */
	private cardEntries: CardEntry[] = [];
	/** Bumped per render; in-flight async work from an older render aborts on mismatch. */
	private renderGeneration = 0;
	/** Heading raw text of the card currently open in an editor, so refreshes don't nuke it. */
	private editingKey: string | null = null;
	/** Toolbar filter text: only cards containing it (title or body) are shown. */
	private filterQuery = "";
	/** This note's effective "headings are dates" state: the per-note checkbox if the
	 * user has set it, otherwise whether the note actually has date-like headings. */
	private containsDates = false;
	/** Whether the last render found date-like headings, so jump-to-date is offered. */
	private hasDateHeadings = false;
	/** The jump-to-date toolbar control, so refresh can show/hide it without a rebuild. */
	private jumpDateWrap: HTMLElement | null = null;
	/** The starred-only toolbar toggle, so refresh can hide it in notes with no stars. */
	private starBtn: HTMLElement | null = null;
	/** Whether the last render found a starred line, so the star toggle is offered. */
	private hasStars = false;
	/** The per-note "Dates" checkbox, kept current by refresh. */
	private datesToggle: HTMLInputElement | null = null;
	/** The toolbar's template button, so the hamburger menu can reuse its state styling. */
	private templateBtn: HTMLElement | null = null;
	/** Opens the jump-to-date picker — stored so the hamburger menu can trigger it too. */
	private openJumpPicker: (() => void) | null = null;
	/** The Layout dropdown, so refresh can grey out Calendar in date-less notes. */
	private layoutSelect: HTMLSelectElement | null = null;
	/** Whether ANY heading level of the note has date headings (Calendar picks its
	 * own level, so this is broader than the current level's noteHasDates). */
	private hasAnyDates = false;
	/** The user's own heading level, parked while the Calendar follows the note's
	 * date-heading level — restored (and re-persisted) when the layout changes back. */
	private preCalendarLevel: number | null = null;
	/** Its label wrap, so the Calendar layout can hide the toggle once Dates is on
	 * (the layout implies it) — but not while it's off, or the gate message's own
	 * "turn on the Dates checkbox" advice would point at nothing. */
	private datesLabelEl: HTMLElement | null = null;
	/** The open editor's card and its finish function, so clicks elsewhere can commit it. */
	private activeEditor: {
		card: HTMLElement;
		finish: (save: boolean) => Promise<void>;
		autosave: () => Promise<void>;
	} | null = null;
	/** Interval handle for the open editor's periodic autosave; null when not editing. */
	private autosaveTimer: number | null = null;
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
	/** Which note has already had its today-card jump, so later refreshes don't re-scroll. */
	private todayJumpedFor: string | null = null;
	/** Set while the today-card jump may still need re-aiming after deferred bodies land. */
	private todayJumpPending = false;
	/** How many pinned cards lead the grid itself (0 when they're in the sticky band). */
	private pinnedShown = 0;
	/** The sticky band between toolbar and grid; empty unless "Keep pinned cards on screen" is on. */
	private pinnedEl!: HTMLElement;
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
			this.viewSettings(),
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
	/** Calendar: the day cell (card or blank) highlighted as the drag's landing day. */
	private calDropEl: HTMLElement | null = null;
	/** Heading of a just-created section, to be opened for editing after the next render. */
	private pendingEditHeading: string | null = null;
	/** Heading of a card that should still be blown up after the next render. */
	private pendingMaximizeHeading: string | null = null;
	private cardsByHeading = new Map<string, { el: HTMLElement; section: Section }>();
	/** Hierarchy layout: the drill-down columns pane, between the toolbar and the grid. */
	private hierEl!: HTMLElement;
	/** Hierarchy: the selected item key per ancestor column (heading raw, or the gap key). */
	private hierSelection: string[] = [];
	/** Which note's hierarchy selection is loaded; a different note starts fresh. */
	private hierFile: string | null = null;
	/** The current note's ancestor headings (levels above headingLevel), refreshed per render. */
	private hierHeadings: AncestorHeading[] = [];
	/** The current note's line count — the last column item's range runs to here. */
	private hierLineCount = 0;
	/** Sections layout: the card groups in render order, one divider bar each. `key` is
	 * the ancestor heading's raw line ("" for cards with no ancestor), `keys` the group's
	 * card headingRaws. Rebuilt every refresh. */
	private sectionGroups: { key: string; title: string; keys: string[] }[] = [];
	/** The bars currently in the grid, with their group's card keys — so filter and
	 * hierarchy passes can hide a bar whose cards are all hidden. */
	private sectionBars: { el: HTMLElement; keys: string[] }[] = [];
	/** Collapsed Sections groups, keyed by ancestor heading raw. In-memory, per note. */
	private collapsedSections = new Set<string>();
	/** Which note's collapsed set is loaded; a different note starts expanded. */
	private collapsedFile: string | null = null;
	/** Open-task counts per parsed section. Sections are fresh objects every refresh,
	 * so this invalidates itself; hierarchy column clicks between refreshes hit it. */
	private taskCountCache = new WeakMap<Section, number>();
	/** Lowercased searchable text per section, so filter keystrokes don't re-lowercase
	 * every card's full body on each character typed. Invalidates like the above. */
	private searchTextCache = new WeakMap<Section, string>();
	/** A section's star facts (starred-block count, would starred-only hide anything?),
	 * cached per parse — keyed by the emoji too, so changing it in settings can't
	 * serve stale answers. */
	private starCache = new WeakMap<Section, { emoji: string; has: boolean; hidden: boolean; count: number }>();

	/** The cached star facts for a section, computed once per parse (and per emoji). */
	private starFacts(section: Section, emoji: string): { has: boolean; hidden: boolean; count: number } {
		let star = this.starCache.get(section);
		if (star === undefined || star.emoji !== emoji) {
			star = { emoji, ...starInfo(section.body.split("\n"), emoji) };
			this.starCache.set(section, star);
		}
		return star;
	}
	/** Heading levels the current note actually contains; the Heading dropdown offers
	 * only these (plus the current level). All six until the first scan. */
	private availableLevels: number[] = [1, 2, 3, 4, 5, 6];
	/** The toolbar's Heading dropdown, so refresh can repopulate it in place when an
	 * edit introduces or removes a heading level. */
	private levelSelect: HTMLSelectElement | null = null;
	/** The toolbar's filter box, so the Ctrl/⌘+F shortcut can focus it. */
	private filterInput: HTMLInputElement | null = null;

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
			hierarchy: this.hierarchyOn,
			sections: this.sectionsOn,
			starredOnly: this.starredOnly,
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
			hierarchy: state?.hierarchy,
			sections: state?.sections,
			starredOnly: state?.starredOnly,
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
		this.preCalendarLevel = null; // a fresh level; the next calendar refresh re-parks it
		this.sortOrder = resolved.sortOrder;
		this.hierarchyOn = resolved.hierarchy ?? false;
		this.sectionsOn = resolved.sections ?? false;
		this.starredOnly = resolved.starredOnly ?? false;
	}

	/** The current view as one ViewSettings value — the shape everything persists.
	 * While the Calendar borrows the date-heading level, the USER'S level is what
	 * persists, so trying the Calendar never clobbers the remembered card level. */
	private viewSettings(): ViewSettings {
		return {
			layout: this.layout,
			headingLevel: this.preCalendarLevel ?? this.headingLevel,
			sortOrder: this.sortOrder,
			hierarchy: this.hierarchyOn,
			sections: this.sectionsOn,
			starredOnly: this.starredOnly,
		};
	}

	/** Custom Grid and Calendar place every card themselves, so the grouped view
	 * modes (hierarchy columns, section dividers) don't apply on them. One predicate,
	 * so the next self-placing layout changes exactly one line. */
	private layoutOwnsPlacement(): boolean {
		return this.layout === "custom" || this.layout === "calendar";
	}

	/** The Calendar option is offered while any heading level names dates (and the
	 * active layout always stays selectable). Shared by the dropdown and the L cycle. */
	/** Switch layouts — the dropdown, the L cycle, and the wall's right-click menu. */
	private setLayout(next: Layout): void {
		this.layout = next;
		this.rememberView();
		this.applyLayoutClass();
		this.buildToolbar(); // the layout dropdown, sort options, and toggles follow along
		void this.refresh().then(() => this.app.workspace.requestSaveLayout());
	}

	private calendarSelectable(): boolean {
		return this.hasAnyDates || this.layout === "calendar";
	}

	/** Grey the layout dropdown's Calendar option in/out as the note's headings change. */
	private syncCalendarOption(): void {
		const option = this.layoutSelect?.querySelector<HTMLOptionElement>('option[value="calendar"]');
		if (option) option.disabled = !this.calendarSelectable();
	}

	/** The Calendar layout implies Dates, so the toggle hides once it's on there — but
	 * not while it's off, or the gate message's "turn on the Dates checkbox" advice
	 * would point at nothing. */
	private syncDatesLabel(): void {
		this.datesLabelEl?.toggleClass("is-hidden", this.layout === "calendar" && this.containsDates);
	}

	/** Whether the hierarchy columns actually show: toggled on, and the layout groups. */
	private hierarchyActive(): boolean {
		return this.hierarchyOn && !this.layoutOwnsPlacement();
	}

	/** Whether the section divider bars actually show: toggled on, the layout groups,
	 * and never alongside the hierarchy columns — both group by the ancestor headings,
	 * so the columns win a both-on state. */
	private sectionsActive(): boolean {
		return this.sectionsOn && !this.layoutOwnsPlacement() && !this.hierarchyActive();
	}

	/** Remember the current view for the current note (in the plugin's data, not the note). */
	private rememberView(): void {
		void this.plugin.storeView(this.currentPath(), this.viewSettings());
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
		// Attached once here, not in buildToolbar — the bar element survives rebuilds.
		this.toolbarEl.addEventListener("contextmenu", (evt) => this.openToolbarMenu(evt));
		// Clicking anywhere in the toolbar returns an editing card to its preview.
		this.registerDomEvent(this.toolbarEl, "click", () => {
			const open = this.activeEditor;
			if (open) void open.finish(true);
		});
		// Sticky pinned band, between the toolbar and the grid — refresh parents pinned
		// cards here when the setting is on, and CSS hides it while it's empty.
		this.pinnedEl = this.contentEl.createDiv({ cls: "section-cards-pinned" });
		this.hierEl = this.contentEl.createDiv({ cls: "section-cards-hier" });
		this.gridEl = this.contentEl.createDiv({ cls: "section-cards-grid" });
		// Right-click on the wall itself — not a card or a control, which have their
		// own menus — offers the background options where the background actually is.
		// Registered on the hierarchy columns pane too: it covers the wall's left side
		// in the Hierarchy view mode.
		const backgroundMenu = (evt: MouseEvent) => {
			const target = evt.target as HTMLElement | null;
			if (target?.closest(".section-card, button")) return;
			evt.preventDefault();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("New card…")
					.setIcon("plus")
					.onClick(() => this.promptNewCard()),
			);
			menu.addSeparator();
			// The layout picker, mirroring the toolbar dropdown — the current one is
			// checked, and Calendar greys out in notes with no date headings.
			for (const [value, label] of LAYOUT_OPTIONS) {
				menu.addItem((item) =>
					item
						.setTitle(label)
						.setChecked(this.layout === value)
						.setDisabled(value === "calendar" && this.layout !== "calendar" && !this.calendarSelectable())
						.onClick(() => {
							if (this.layout !== value) this.setLayout(value);
						}),
				);
			}
			menu.addSeparator();
			this.addBackgroundItems(menu, this.viewSettings());
			menu.showAtMouseEvent(evt);
		};
		this.registerDomEvent(this.gridEl, "contextmenu", backgroundMenu);
		this.registerDomEvent(this.hierEl, "contextmenu", backgroundMenu);
		// A user scroll or click cancels the pending today-card re-aim, so it can't
		// yank the view away from wherever they have already navigated to.
		this.registerDomEvent(this.contentEl, "wheel", () => (this.todayJumpPending = false), { passive: true });
		this.registerDomEvent(this.contentEl, "pointerdown", () => (this.todayJumpPending = false));
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
		this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Escape" || !this.maximized) return;
			// An open card editor's own Escape handling wins (textarea or live preview).
			if (this.activeEditor) return;
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

		// View shortcuts, none of which run while a card editor is open. The plain keys
		// additionally never fire while typing in a field (the filter box, a rename).
		// 1–6: switch to that heading level (only levels the dropdown offers).
		for (let level = 1; level <= 6; level++) {
			this.scope.register([], String(level), (evt) => {
				if (!this.plainShortcutOk(evt)) return true;
				// The Calendar follows the note's date-heading level; a manual level
				// would only be forced back (and churn the stored view) on refresh.
				if (this.layout === "calendar") return true;
				if (!this.levelOptionValues().includes(level)) return true;
				if (this.headingLevel !== level) {
					this.headingLevel = level;
					this.rememberView();
					this.populateLevelOptions();
					void this.refresh().then(() => this.app.workspace.requestSaveLayout());
				}
				return false;
			});
		}
		// L: cycle through the layouts, in the dropdown's order.
		this.scope.register([], "L", (evt) => {
			if (!this.plainShortcutOk(evt)) return true;
			const values = LAYOUT_OPTIONS.map(([value]) => value);
			let next = values[(values.indexOf(this.layout) + 1) % values.length];
			// The cycle skips a greyed-out Calendar, like the dropdown refuses it.
			if (next === "calendar" && !this.calendarSelectable()) {
				next = values[(values.indexOf(next) + 1) % values.length];
			}
			this.setLayout(next);
			return false;
		});
		// H: show/hide the hierarchy columns (not available on the Custom Grid canvas).
		// Turning them on turns the section dividers off — never both at once.
		this.scope.register([], "H", (evt) => {
			if (!this.plainShortcutOk(evt)) return true;
			if (this.layoutOwnsPlacement()) return true;
			this.hierarchyOn = !this.hierarchyOn;
			if (this.hierarchyOn) this.sectionsOn = false;
			this.rememberView();
			this.applyLayoutClass();
			this.buildToolbar(); // both toggles reflect the state
			void this.refresh().then(() => this.app.workspace.requestSaveLayout());
			return false;
		});
		// D: show/hide the dividers (not on the canvas); turns the columns off.
		this.scope.register([], "D", (evt) => {
			if (!this.plainShortcutOk(evt)) return true;
			if (this.layoutOwnsPlacement()) return true;
			this.sectionsOn = !this.sectionsOn;
			if (this.sectionsOn) this.hierarchyOn = false;
			this.rememberView();
			this.applyLayoutClass();
			this.buildToolbar(); // both toggles reflect the state
			void this.refresh().then(() => this.app.workspace.requestSaveLayout());
			return false;
		});
		// , and .: with the hierarchy columns showing, step the deepest column's
		// selection; with the dividers showing, jump to the previous/next bar.
		const stepGrouping = (evt: KeyboardEvent, delta: number): boolean => {
			if (!this.plainShortcutOk(evt)) return true;
			if (this.hierarchyActive()) {
				this.stepHierSelection(delta);
				return false;
			}
			if (this.sectionsActive()) {
				this.stepSectionDivider(delta);
				return false;
			}
			return true;
		};
		this.scope.register([], ",", (evt) => stepGrouping(evt, -1));
		this.scope.register([], ".", (evt) => stepGrouping(evt, 1));
		// N: create a new card, same as the "+ New card" button.
		this.scope.register([], "N", (evt) => {
			if (!this.plainShortcutOk(evt)) return true;
			this.promptNewCard();
			return false;
		});
		// S: show only starred lines / show everything, same as the toolbar star.
		this.scope.register([], "S", (evt) => {
			if (!this.plainShortcutOk(evt)) return true;
			if (!this.hasStars) return true; // no stars in the note — the toggle is hidden
			this.starredOnly = !this.starredOnly;
			this.rememberView();
			this.buildToolbar(); // the star button reflects the state
			this.applyFilter();
			this.app.workspace.requestSaveLayout();
			return false;
		});
		// Ctrl/⌘+F: jump to the filter box (from anywhere in the view, fields included).
		this.scope.register(["Mod"], "F", (evt) => {
			if (this.activeEditor) return true; // edit mode keeps its own Ctrl+F
			evt.preventDefault();
			this.filterInput?.focus();
			this.filterInput?.select();
			return false;
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
		// Clicking anywhere in the hierarchy columns also settles an open editor —
		// including column items, whose own handler may then hide the card.
		this.registerDomEvent(this.hierEl, "click", () => {
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
	 *
	 * The listener is non-passive (it must preventDefault), which makes every wheel event
	 * wait on the main thread — so it is attached only while the Vertical layout is
	 * active, keeping the other layouts' scrolling on the compositor's fast path.
	 */
	private wheelPanBound = false;
	private readonly wheelPanHandler = (evt: WheelEvent): void => {
		if (this.layout !== "vertical" || !this.gridEl) return;
		if (evt.ctrlKey || evt.metaKey) return; // zoom gestures

		const step = wheelDeltaToPixels(evt, this.gridEl.clientWidth);
		if (!step) return;

		const target = evt.target as HTMLElement | null;
		const body = target?.closest<HTMLElement>(".section-card-body");
		if (body && canScrollVertically(body, step)) return;
		// With the hierarchy columns beside the row, a wheel over a column scrolls it.
		const hierCol = target?.closest<HTMLElement>(".section-cards-hier-col");
		if (hierCol && canScrollVertically(hierCol, step)) return;

		evt.preventDefault();
		this.gridEl.scrollLeft += step;
	};

	private updateWheelPan(): void {
		const want = this.layout === "vertical";
		if (want === this.wheelPanBound) return;
		this.wheelPanBound = want;
		if (want) this.contentEl.addEventListener("wheel", this.wheelPanHandler, { passive: false });
		else this.contentEl.removeEventListener("wheel", this.wheelPanHandler);
	}

	/** The layout lives as a class on the view root so CSS can restyle grid *and* scrolling. */
	private applyLayoutClass(): void {
		for (const name of ["grid", "aligned", "tight", "horizontal", "vertical", "custom", "calendar"]) {
			this.contentEl.toggleClass(`is-layout-${name}`, this.layout === name);
		}
		this.contentEl.toggleClass("is-hier-on", this.hierarchyActive());
		// Only the masonry layouts pack with inline `grid-row-end` spans. Leaving a
		// previous layout's spans in place would let the other layouts paint overlapping
		// cards for a frame before the masonry pass clears them, so shed them here,
		// synchronously with the class change (this used to lean on a CSS !important).
		if (this.layout !== "grid" && this.layout !== "tight" && this.gridEl) {
			for (const card of Array.from(this.gridEl.children) as HTMLElement[]) {
				if (card.style?.gridRowEnd) card.setCssStyles({ gridRowEnd: "" });
			}
		}
		this.updateWheelPan();
	}

	async onClose(): Promise<void> {
		if (this.autosaveTimer !== null) {
			window.clearInterval(this.autosaveTimer);
			this.autosaveTimer = null;
		}
		// A view closed with an editor still open writes that editor's content out
		// instead of dropping it — same opt-in as the periodic autosave.
		if (this.plugin.settings.autosaveEnabled && this.activeEditor) {
			await this.activeEditor.autosave().catch(() => {});
			this.activeEditor = null;
			this.editingKey = null;
		}
		for (const entry of this.cardEntries) this.removeChild(entry.scope);
		this.cardEntries = [];
		this.cardObserver?.disconnect();
		this.cardObserver = null;
		if (this.wheelPanBound) {
			this.contentEl.removeEventListener("wheel", this.wheelPanHandler);
			this.wheelPanBound = false;
		}
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
		this.pinnedEl?.empty();
	}

	/** The sticky pinned band and the Calendar's weekday header sit just below the
	 * toolbar, whose height varies as it wraps or switches style — so the offset is
	 * refreshed unconditionally (a resize, a toolbar rebuild, a calendar render). */
	private updateToolbarOffset(): void {
		if (!this.toolbarEl) return;
		this.contentEl.setCssProps({ "--sc-toolbar-h": `${this.toolbarEl.offsetHeight}px` });
	}

	/** Sync a card's pinned look: the class plus the pin button's icon and label. */
	private applyPinState(card: HTMLElement, pinned: boolean): void {
		card.toggleClass("is-pinned", pinned);
		const btn = card.querySelector<HTMLElement>(".section-card-pin");
		if (!btn) return;
		// Always the same glyph; the states differ by strength (CSS), not icon.
		setIcon(btn, "pin");
		btn.setAttr("aria-label", pinned ? "Unpin this card" : "Pin this card to the top");
	}

	/** Sync a card's (or tray tile's) color attribute; CSS keys off data-sfsc-color. */
	private applyCardColor(el: HTMLElement, color: string | undefined): void {
		if (color && CARD_COLORS.some(([name]) => name === color)) el.setAttr("data-sfsc-color", color);
		else el.removeAttribute("data-sfsc-color");
	}

	/** This note's heading-name format for new cards (its own override, else the default). */
	private cardFormat(): string {
		return this.plugin.getNewCardFormat(this.filePath);
	}

	/** Today's date keys, computed once per render instead of once per card. */
	private todayKeys(): { iso: string; formatted: string } | null {
		if (!this.containsDates) return null;
		const now = mo();
		return { iso: now.format("YYYY-MM-DD"), formatted: now.format(this.cardFormat()) };
	}

	/**
	 * Hide cards that don't contain the filter text (case-insensitive, title + body);
	 * an empty box shows everything. Hidden cards keep their DOM and rendered markdown,
	 * so clearing the filter is instant.
	 */
	private applyFilter(): void {
		// Starred-only also hides the non-starred lines inside the surviving cards (CSS).
		this.contentEl.toggleClass("is-starred-only", this.starredOnly);
		if (!this.cardEntries.length) return;
		const q = this.filterQuery.trim().toLowerCase();
		const emoji = this.plugin.starEmoji();
		for (const entry of this.cardEntries) {
			const section = entry.holder.section;
			// Title + raw, lowercased once per section (the title is display-only on
			// the unfiled card, so raw alone wouldn't cover it).
			let text = this.searchTextCache.get(section);
			if (text === undefined) {
				text = (section.title + "\n" + section.raw).toLowerCase();
				this.searchTextCache.set(section, text);
			}
			let starOk = true;
			if (this.starredOnly) {
				const star = this.starFacts(section, emoji);
				starOk = star.has;
				// A trailing "…" on cards where starred-only actually hid something.
				entry.el.toggleClass("sc-starred-more", star.has && star.hidden);
			} else {
				entry.el.removeClass("sc-starred-more");
			}
			entry.el.toggleClass("is-filtered-out", !((!q || text.includes(q)) && starOk));
		}
		// The sticky pinned band collapses when the filter hides everything in it.
		// (Stamped here rather than with a CSS :has(), which lints as a perf hazard.)
		if (this.pinnedEl) {
			const bandCards = Array.from(this.pinnedEl.children).filter((c) =>
				(c as HTMLElement).hasClass("section-card"),
			) as HTMLElement[];
			const anyShown = bandCards.some((c) => !c.hasClass("is-filtered-out"));
			this.pinnedEl.toggleClass("is-all-filtered", bandCards.length > 0 && !anyShown);
		}
		this.repack(); // masonry and row rules re-pack around the hidden cards
	}

	/** The card-body height cap for the current layout; also re-applied to reused cards. */
	private applyBodyHeight(bodyEl: HTMLElement | null): void {
		if (!bodyEl) return;
		const cap = this.plugin.settings.cardMaxHeight;
		const target =
			this.layout === "vertical" || this.layoutOwnsPlacement()
				? "" // calendar cells cap the whole card in CSS instead
				: `${this.layout === "tight" ? Math.min(cap, 190) : cap}px`;
		// Refresh re-applies this to every reused card; identical values skip the write.
		if (bodyEl.style.maxHeight !== target) bodyEl.setCssStyles({ maxHeight: target });
	}

	/** The rendered elements that correspond 1:1 with a section's movable blocks. */
	private eligibleBlockEls(bodyEl: HTMLElement): HTMLElement[] {
		return Array.from(
			bodyEl.querySelectorAll<HTMLElement>(":scope > p, :scope > ul > li, :scope > ol > li"),
		);
	}

	/**
	 * Post-render pass over card bodies: live checkboxes + draggable blocks. Scoped to
	 * the entries whose markdown just landed — re-walking every card after each deferred
	 * batch was quadratic across a long note's ramp-up.
	 */
	private prepareBodies(entries: CardEntry[]): void {
		for (const entry of entries) {
			const bodyEl = entry.bodyEl;
			// Rendered task checkboxes come back disabled, and disabled inputs never fire clicks.
			for (const box of Array.from(bodyEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))) {
				box.removeAttribute("disabled");
				box.removeAttribute("readonly");
			}
			const body = entry.holder.section.body.split("\n");
			const blocks = movableBlocks(body);
			const emoji = this.plugin.starEmoji();
			const els = this.eligibleBlockEls(bodyEl);
			for (let i = 0; i < els.length; i++) {
				els[i].draggable = true;
				els[i].addClass("sc-block");
				// Tag starred blocks so the starred-only CSS can single them out. The DOM
				// and parsed blocks correspond 1:1; on a rare mismatch nothing gets tagged.
				const block = els.length === blocks.length ? blocks[i] : undefined;
				els[i].toggleClass("is-starred", !!block && blockStarred(body[block.start], emoji));
			}
			// Keep offscreen image decode off the phone's main thread and memory.
			if (Platform.isMobile) {
				for (const img of Array.from(bodyEl.querySelectorAll<HTMLImageElement>("img"))) {
					img.loading = "lazy";
					img.decoding = "async";
				}
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
		// The setTimeout fallback only runs where requestIdleCallback is missing — older
		// iOS WebKit — so it waits longer between batches to keep touch handling smooth.
		const idle: (cb: () => void) => void =
			typeof window.requestIdleCallback === "function"
				? (cb) => window.requestIdleCallback(cb, { timeout: 200 })
				: (cb) => window.setTimeout(cb, 50);
		const step = (): void => {
			if (gen !== this.renderGeneration) return;
			const batch = entries.splice(0, DEFERRED_RENDER_BATCH);
			if (!batch.length) return;
			void Promise.all(batch.map((entry) => this.runBodyRender(entry))).then(() => {
				if (gen !== this.renderGeneration) return;
				this.prepareBodies(batch);
				this.repack();
				if (entries.length) {
					idle(step);
				} else if (this.todayJumpPending) {
					this.todayJumpPending = false;
					this.gridEl
						.querySelector(".section-card.is-today")
						?.scrollIntoView({ block: "center", inline: "center" });
				}
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

		// Every path that hides or reveals cards (filter, hierarchy, collapse) ends
		// here, so the Sections divider bars sync their visibility in the same pass.
		this.updateSectionBars();

		// Masonry spans only apply to the packed column layouts. The aligned grid wants
		// real auto rows, and the sideways layout is a flex row, so clear any leftovers.
		if (this.layout === "vertical" || this.layout === "aligned" || this.layoutOwnsPlacement()) {
			grid.removeClass("is-one-col");
			for (const card of Array.from(grid.children) as HTMLElement[]) {
				// Reading inline style is free; rewriting an already-empty one is not.
				if (card.style.gridRowEnd) card.setCssStyles({ gridRowEnd: "" });
			}
			return;
		}

		const style = window.getComputedStyle(grid);

		// One column (a phone, a narrow pane, or the Horizontal layout) needs no packing:
		// cards simply stack. CSS switches the grid to auto rows + row-gap — visually
		// identical — and the per-card measure/span work below is skipped entirely.
		// Horizontal is one column by definition, not by measurement: a computed style
		// read while the pane is hidden or mid-toggle (e.g. the hierarchy columns
		// appearing) can misreport the track count and leave overlapping spans behind.
		const columns =
			this.layout === "horizontal"
				? 1
				: style.gridTemplateColumns.split(" ").filter((t) => t.trim().length).length;
		if (columns <= 1) {
			grid.addClass("is-one-col");
			for (const card of Array.from(grid.children) as HTMLElement[]) {
				if (card.style.gridRowEnd) card.setCssStyles({ gridRowEnd: "" });
			}
			return;
		}
		grid.removeClass("is-one-col");

		const rowHeight = parseFloat(style.gridAutoRows) || 4;
		const gap = parseFloat(style.rowGap) || 0;
		const cardGap = parseFloat(style.getPropertyValue("--sc-card-gap")) || 12;

		// Read every height first, then write every span. Interleaving the two forces a
		// full reflow per card — ~150 reflows per pack on a year of daily notes.
		// (Cards are `align-items: start` grid items, so their box height is their content
		// height regardless of the span currently assigned.)
		// The Sections divider bars are grid items too: without a measured span their
		// content would overflow the 4px auto-row and paint under the cards below.
		const cards = (Array.from(grid.children) as HTMLElement[]).filter(
			(el) =>
				(el.hasClass("section-card") &&
					!el.hasClass("is-filtered-out") &&
					!el.hasClass("is-hier-hidden") &&
					!el.hasClass("is-section-hidden")) ||
				(el.hasClass("section-cards-section-bar") && !el.hasClass("is-hidden")),
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
	/**
	 * Calendar layout: rebuild the grid as a weekday header row plus one block per
	 * month — a full-width label, leading pads to the first day's weekday column,
	 * then one cell per day: the day's card, or a blank square. The cards are already
	 * in date order, so plain 7-column auto-placement makes the calendar. Every month
	 * between the first and last dated card renders, so scrolling walks the months.
	 */
	private layoutCalendar(isoByHeading: Map<string, string>): void {
		const grid = this.gridEl;
		if (!grid) return;
		const locale = moment as unknown as {
			weekdaysShort: (localeSorted: boolean) => string[];
			localeData: () => { firstDayOfWeek: () => number };
		};
		const weekStart = this.plugin.settings.weekStart;
		const firstDow =
			weekStart === "sunday" ? 0 : weekStart === "monday" ? 1 : locale.localeData().firstDayOfWeek();
		// Sunday-first names, rotated to whichever day starts the week.
		const names = locale.weekdaysShort(false);
		for (const name of [...names.slice(firstDow), ...names.slice(0, firstDow)]) {
			grid.createDiv({ cls: "sc-cal-dow", text: name });
		}

		// One card per day; a second section naming the same date has no square and hides.
		// (refresh parsed every title once into isoByHeading — nothing re-parses here.)
		const byIso = new Map<string, HTMLElement>();
		for (const entry of this.cardEntries) {
			const iso = isoByHeading.get(entry.holder.section.headingRaw);
			const primary = iso !== undefined && !byIso.has(iso);
			if (primary) byIso.set(iso, entry.el);
			entry.el.toggleClass("is-cal-extra", !primary);
		}
		if (!byIso.size) return;

		const isos = [...byIso.keys()].sort();
		const [y0, m0] = isos[0].split("-").map(Number);
		const [y1, m1] = isos[isos.length - 1].split("-").map(Number);
		// The toolbar's sort control orders the months (days inside stay calendar
		// order — a month grid reads one way): ascending walks first → last.
		let months: [number, number][] = [];
		{
			let year = y0;
			let month = m0;
			while (year < y1 || (year === y1 && month <= m1)) {
				months.push([year, month]);
				month++;
				if (month > 12) {
					month = 1;
					year++;
				}
			}
		}
		// Scrolling walks the months — but one stray date (a typo year, an archived
		// reference) must not explode the walk into thousands of day cells. Past five
		// years of span, only months that actually hold a card render.
		if (months.length > 60) {
			const withCards = new Set(isos.map((iso) => iso.slice(0, 7)));
			months = months.filter(([year, month]) => withCards.has(`${year}-${String(month).padStart(2, "0")}`));
		}
		if (this.sortOrder === "desc") months.reverse();

		// Shared by every blank day cell: three handlers total, not three per day.
		const blankIso = (evt: Event) => (evt.currentTarget as HTMLElement).dataset.scIso;
		const onBlankClick = (evt: MouseEvent) => {
			const iso = blankIso(evt);
			if (iso) this.promptCreateDateCard(iso);
		};
		// A card dragged onto an empty day moves there: its heading is rewritten.
		const onBlankDragover = (evt: DragEvent) => {
			if (!this.dragging) return;
			evt.preventDefault();
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
			this.setCalDrop(evt.currentTarget as HTMLElement);
		};
		const onBlankDrop = (evt: DragEvent) => {
			if (!this.dragging) return;
			evt.preventDefault();
			const moved = this.dragging.section;
			const iso = blankIso(evt);
			this.setCalDrop(null);
			this.dragging = null;
			if (iso) void this.moveCardToDate(moved, iso);
		};
		for (const [year, month] of months) {
			grid.createDiv({
				cls: "sc-cal-month",
				text: new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
			});
			const lead = (new Date(year, month - 1, 1).getDay() - firstDow + 7) % 7;
			for (let i = 0; i < lead; i++) grid.createDiv({ cls: "sc-cal-blank sc-cal-pad" });
			const days = new Date(year, month, 0).getDate();
			for (let day = 1; day <= days; day++) {
				const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
				const el = byIso.get(iso);
				// appendChild MOVES an existing card into place; the dow header and any
				// earlier days were appended before it, so date order builds the grid.
				if (el) {
					grid.appendChild(el);
				} else {
					// An empty day offers to start its card — same dialog as jump-to-date.
					const blank = grid.createDiv({ cls: "sc-cal-blank", text: String(day) });
					blank.setAttr("role", "button");
					blank.setAttr("aria-label", `Create a card for ${iso}`);
					blank.dataset.scIso = iso;
					blank.addEventListener("click", onBlankClick);
					blank.addEventListener("dragover", onBlankDragover);
					blank.addEventListener("drop", onBlankDrop);
				}
			}
		}
	}

	private insertRowRules(): void {
		const grid = this.gridEl;
		if (!grid || !grid.isConnected) return;

		for (const old of Array.from(grid.querySelectorAll(".section-cards-row-rule"))) old.remove();
		// With the divider bars on, they do the separating — and every-Nth-card row
		// math is wrong anyway once bars restart the rows per group.
		if (this.layout !== "aligned" || this.sectionsActive()) return;

		const all = (Array.from(grid.children) as HTMLElement[]).filter((c) => c.hasClass("section-card"));
		// Filter- and hierarchy-hidden cards occupy no grid cell, so they don't count toward rows.
		const cards = all.filter((c) => !c.hasClass("is-filtered-out") && !c.hasClass("is-hier-hidden"));
		if (cards.length < 2) return;

		const columns = window
			.getComputedStyle(grid)
			.gridTemplateColumns.split(" ")
			.filter((t) => t.trim().length).length;
		if (columns < 1 || columns >= cards.length) return;

		// The pinned band ends at the pin rule and may not fill its last row, so the
		// row count restarts beneath it instead of running straight through. Pinned
		// cards lead the grid in DOM order, so the visible split is a filtered count.
		const pinnedVisible =
			this.pinnedShown > 0
				? all.slice(0, this.pinnedShown).filter((c) => !c.hasClass("is-filtered-out")).length
				: 0;
		const bands =
			pinnedVisible > 0 && pinnedVisible < cards.length
				? [cards.slice(0, pinnedVisible), cards.slice(pinnedVisible)]
				: [cards];
		for (const band of bands) {
			for (let i = columns; i < band.length; i += columns) {
				const rule = createDiv();
				rule.className = "section-cards-row-rule";
				grid.insertBefore(rule, band[i]);
			}
		}
	}

	/**
	 * Sections layout: a full-width, clickable divider bar above each group of cards,
	 * labeled with the group's ancestor heading. Spanning every column is also what
	 * keeps the group's cards below their bar (as with the pinned rule). Clicking a
	 * bar collapses or expands its group; collapsed state is in-memory, per note.
	 */
	private insertSectionBars(): void {
		const grid = this.gridEl;
		if (!grid) return;
		for (const old of Array.from(grid.querySelectorAll(".section-cards-section-bar"))) old.remove();
		this.sectionBars = [];
		for (const entry of this.cardEntries) entry.el.removeClass("is-section-hidden");
		if (!this.sectionsActive()) return;

		for (const group of this.sectionGroups) {
			const first = this.cardsByHeading.get(group.keys[0]);
			if (!first) continue;
			const bar = createDiv({ cls: "section-cards-section-bar" });
			const chevron = bar.createSpan({ cls: "section-cards-section-chevron" });
			setIcon(chevron, "chevron-down");
			bar.createSpan({ cls: "section-cards-section-title", text: group.title });
			bar.createSpan({ cls: "section-cards-section-count", text: String(group.keys.length) });
			const sync = () => {
				const collapsed = this.collapsedSections.has(group.key);
				bar.toggleClass("is-collapsed", collapsed);
				bar.setAttr(
					"aria-label",
					collapsed ? "Expand this section's cards" : "Collapse this section's cards",
				);
				for (const key of group.keys) {
					this.cardsByHeading.get(key)?.el.toggleClass("is-section-hidden", collapsed);
				}
			};
			sync();
			bar.addEventListener("click", () => {
				if (this.collapsedSections.has(group.key)) this.collapsedSections.delete(group.key);
				else this.collapsedSections.add(group.key);
				sync();
				this.layoutMasonry();
			});
			grid.insertBefore(bar, first.el);
			this.sectionBars.push({ el: bar, keys: group.keys });
		}
	}

	/** A bar whose cards are all hidden (filtered out, or off the hierarchy branch)
	 * hides with them, instead of stacking up as a run of empty dividers. */
	private updateSectionBars(): void {
		for (const { el, keys } of this.sectionBars) {
			const anyVisible = keys.some((key) => {
				const card = this.cardsByHeading.get(key)?.el;
				return !!card && !card.hasClass("is-filtered-out") && !card.hasClass("is-hier-hidden");
			});
			el.toggleClass("is-hidden", !anyVisible);
		}
	}

	/** Hierarchy: adopt the note's current headings, then rebuild the columns. */
	private renderHierarchy(lines: string[]): void {
		if (this.hierFile !== this.filePath) {
			this.hierFile = this.filePath;
			this.hierSelection = [];
		}
		this.hierHeadings = parseAncestorHeadings(lines, this.headingLevel);
		this.hierLineCount = lines.length;
		this.rebuildHierarchy();
	}

	/** Leaving the Hierarchy layout: drop the columns and unhide every card. */
	private clearHierarchy(): void {
		if (!this.hierEl) return;
		this.hierEl.empty();
		for (const entry of this.cardEntries) {
			if (entry.el.hasClass("is-hier-hidden")) entry.el.removeClass("is-hier-hidden");
		}
	}

	/**
	 * Build the ancestor columns (H1 … one level above the cards) from the current
	 * selection — each unselected column defaults to its first item — then show only
	 * the cards on the selected branch. Runs on every refresh and on every column click.
	 */
	private rebuildHierarchy(): void {
		this.hierEl.empty();
		const showTasks = this.plugin.settings.hierTaskCounts;
		// Star tallies only exist while the note has starred lines at all, mirroring
		// the toolbar's star toggle: no stars, no badge column.
		const showStars = this.hasStars;
		const emoji = this.plugin.starEmoji();
		const cards = this.cardEntries.map((e) => {
			const section = e.holder.section;
			let open = 0;
			if (showTasks) {
				const cached = this.taskCountCache.get(section);
				open = cached ?? openTaskCount(section.body);
				if (cached === undefined) this.taskCountCache.set(section, open);
			}
			const stars = showStars ? this.starFacts(section, emoji).count : 0;
			return { line: section.headingLine, open, stars };
		});
		const cardLines = cards.map((c) => c.line);
		let start = 0;
		let end = this.hierLineCount;
		for (let level = 1; level < this.headingLevel; level++) {
			const idx = level - 1;
			const items = hierarchyColumnItems(this.hierHeadings, level, start, end, cardLines);
			// Nothing at this level under the selected branch: deeper levels are empty
			// too, and the branch's whole range falls through to the cards pane.
			if (!items.length) break;
			// A level with no real headings here would be a lone "(no H2)" row — zero
			// information, so skip the column; the gap spans the whole range anyway.
			if (items.length === 1 && items[0].key === HIER_GAP_KEY) {
				this.hierSelection[idx] = HIER_GAP_KEY;
				continue;
			}
			const selected = items.find((it) => it.key === this.hierSelection[idx]) ?? items[0];
			this.hierSelection[idx] = selected.key;
			this.renderHierColumn(level, items, selected, idx, cards);
			start = selected.start;
			end = selected.end;
		}
		// Cards off the selected branch keep their DOM and rendered markdown; they only
		// lose their grid cell, so clicking around the columns is instant. Cards in the
		// sticky pinned band are exempt: pins stay visible whatever branch is selected.
		const constrain = this.headingLevel > 1;
		for (const entry of this.cardEntries) {
			const line = entry.holder.section.headingLine;
			const inBand = entry.el.parentElement === this.pinnedEl;
			entry.el.toggleClass("is-hier-hidden", constrain && !inBand && (line < start || line >= end));
		}
	}

	private renderHierColumn(
		level: number,
		items: HierarchyItem[],
		selected: HierarchyItem,
		idx: number,
		cards: { line: number; open: number; stars: number }[],
	): void {
		const col = this.hierEl.createDiv({ cls: "section-cards-hier-col" });
		col.createDiv({ cls: "section-cards-hier-col-label", text: `H${level}` });
		// One bucketing pass instead of a per-item scan over every card: the items'
		// ranges are disjoint and sorted by start, so each card binary-searches its row.
		const tallies = items.map(() => ({ count: 0, open: 0, stars: 0 }));
		for (const c of cards) {
			let lo = 0;
			let hi = items.length - 1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (c.line < items[mid].start) hi = mid - 1;
				else if (c.line >= items[mid].end) lo = mid + 1;
				else {
					tallies[mid].count++;
					tallies[mid].open += c.open;
					tallies[mid].stars += c.stars;
					break;
				}
			}
		}
		// The badges right of the label — a circle of cards, a square of open tasks, a
		// star of starred lines, in that order — align into columns: once any row in
		// the column needs a badge, every row reserves its slot (invisible at zero).
		const anyTasks = this.plugin.settings.hierTaskCounts && tallies.some((t) => t.open > 0);
		const anyStars = tallies.some((t) => t.stars > 0);
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const btn = col.createEl("button", { cls: "section-cards-hier-item" });
			btn.toggleClass("is-selected", item.key === selected.key);
			btn.toggleClass("is-gap", item.key === HIER_GAP_KEY);
			btn.createSpan({ cls: "section-cards-hier-item-label", text: item.label });
			const count = tallies[i].count;
			btn.createSpan({ cls: "section-cards-hier-count", text: String(count) });
			const open = this.plugin.settings.hierTaskCounts ? tallies[i].open : 0;
			if (anyTasks) {
				const box = btn.createSpan({ cls: "section-cards-hier-tasks", text: open > 0 ? String(open) : "" });
				box.toggleClass("is-empty", open === 0);
			}
			const stars = tallies[i].stars;
			if (anyStars) {
				const star = btn.createSpan({ cls: "section-cards-hier-stars", text: stars > 0 ? String(stars) : "" });
				star.toggleClass("is-empty", stars === 0);
			}
			const starLabel = stars > 0 ? `, ${stars} starred ${stars === 1 ? "line" : "lines"}` : "";
			const openLabel = open > 0 ? `, ${open} unfinished ${open === 1 ? "task" : "tasks"}` : "";
			btn.setAttr(
				"aria-label",
				item.key === HIER_GAP_KEY
					? `Sections here with no H${level} heading (${count}${starLabel}${openLabel})`
					: `${item.label} (${count} ${count === 1 ? "section" : "sections"}${starLabel}${openLabel})`,
			);
			btn.addEventListener("click", () => {
				if (this.hierSelection[idx] === item.key) return;
				// Deeper selections are kept, not cleared: rebuild re-validates them
				// against the new branch and falls back to each column's first item.
				this.hierSelection[idx] = item.key;
				this.rebuildHierarchy();
				this.layoutMasonry();
			});
		}
	}

	/** , and . keys: step the deepest hierarchy column's selection to the previous or
	 * next heading, wrapping at the ends. Walks the columns the way rebuildHierarchy
	 * does (skipped gap-only columns and all), so it steps the column the user sees. */
	private stepHierSelection(delta: number): void {
		const cardLines = this.cardEntries.map((e) => e.holder.section.headingLine);
		let start = 0;
		let end = this.hierLineCount;
		let deepest: { idx: number; items: HierarchyItem[]; selected: number } | null = null;
		for (let level = 1; level < this.headingLevel; level++) {
			const idx = level - 1;
			const items = hierarchyColumnItems(this.hierHeadings, level, start, end, cardLines);
			if (!items.length) break;
			if (items.length === 1 && items[0].key === HIER_GAP_KEY) continue;
			const selected = Math.max(0, items.findIndex((it) => it.key === this.hierSelection[idx]));
			deepest = { idx, items, selected };
			start = items[selected].start;
			end = items[selected].end;
		}
		if (!deepest || deepest.items.length < 2) return;
		const next = (deepest.selected + delta + deepest.items.length) % deepest.items.length;
		this.hierSelection[deepest.idx] = deepest.items[next].key;
		this.rebuildHierarchy();
		this.layoutMasonry();
	}

	/** , and . keys: scroll the previous/next divider bar to the top of the view —
	 * just below the sticky toolbar and pinned band (the left edge in the sideways
	 * Vertical layout). "Current" is the last bar at or above that landing line, so
	 * repeated presses walk the bars one by one. */
	private stepSectionDivider(delta: number): void {
		const bars = this.sectionBars.map((b) => b.el).filter((el) => !el.hasClass("is-hidden"));
		if (!bars.length) return;
		const sideways = this.layout === "vertical";
		let reference: number;
		if (sideways) {
			reference = this.gridEl.getBoundingClientRect().left;
		} else {
			const toolbar = this.toolbarEl?.getBoundingClientRect().bottom ?? this.contentEl.getBoundingClientRect().top;
			const band = this.pinnedEl?.hasChildNodes() ? this.pinnedEl.getBoundingClientRect().bottom : 0;
			reference = Math.max(toolbar, band);
		}
		const pos = (el: HTMLElement) => {
			const r = el.getBoundingClientRect();
			return sideways ? r.left : r.top;
		};
		let current = -1;
		for (let i = 0; i < bars.length; i++) if (pos(bars[i]) <= reference + 8) current = i;
		const target = Math.max(0, Math.min(bars.length - 1, current + delta));
		if (target === current) return;
		const offset = pos(bars[target]) - reference;
		if (sideways) this.gridEl.scrollLeft += offset;
		else this.contentEl.scrollTop += offset;
	}

	/** Hierarchy: select the ancestor path containing this line, so its card is visible. */
	private hierRevealLine(line: number): void {
		const cardLines = this.cardEntries.map((e) => e.holder.section.headingLine);
		let start = 0;
		let end = this.hierLineCount;
		for (let level = 1; level < this.headingLevel; level++) {
			const items = hierarchyColumnItems(this.hierHeadings, level, start, end, cardLines);
			const hit = items.find((it) => line >= it.start && line < it.end);
			if (!hit) break;
			this.hierSelection[level - 1] = hit.key;
			start = hit.start;
			end = hit.end;
		}
		this.rebuildHierarchy();
		this.layoutMasonry();
	}

	private observeCards(): void {
		this.cardObserver?.disconnect();
		if (!this.gridEl) return;

		if (typeof ResizeObserver === "undefined") return;
		this.cardObserver = new ResizeObserver(() => {
			// Resize feedback must be immediate; the debounced repack settles it after.
			if (this.layout === "custom") this.previewCustomResize();
			this.repack();
			// A narrower pane wraps the toolbar taller; the sticky band rides below it.
			this.updateToolbarOffset();
		});
		for (const card of Array.from(this.gridEl.children)) {
			if ((card as HTMLElement).hasClass("section-card")) this.cardObserver.observe(card);
		}
		// The grid itself changes width when the pane resizes, which changes column count.
		this.cardObserver.observe(this.gridEl);
	}

	/** Re-render the toolbar in the current style (full/compact); no data refresh. */
	rebuildToolbar(): void {
		this.buildToolbar();
		// The pinned band and the Calendar's weekday header hang off the toolbar's
		// height, which just changed.
		this.updateToolbarOffset();
	}

	/** Right-click anywhere on the toolbar (fields excluded): switch its style. */
	private openToolbarMenu(evt: MouseEvent): void {
		const target = evt.target as HTMLElement | null;
		if (target?.closest("input, select, textarea")) return; // fields keep their native menu
		evt.preventDefault();
		const menu = new Menu();
		const styles: ["full" | "compact", string][] = [
			["full", "Full toolbar"],
			["compact", "Compact toolbar"],
		];
		for (const [value, label] of styles) {
			menu.addItem((item) =>
				item
					.setTitle(label)
					.setChecked(this.plugin.settings.toolbarStyle === value)
					.onClick(async () => {
						if (this.plugin.settings.toolbarStyle === value) return;
						this.plugin.settings.toolbarStyle = value;
						await this.plugin.saveSettings();
						this.plugin.applyToolbarStyle();
					}),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	private buildToolbar() {
		const bar = this.toolbarEl;
		if (!bar) return;
		bar.empty();
		const compact = this.plugin.settings.toolbarStyle === "compact";
		bar.toggleClass("is-compact", compact);

		// The hamburger menu leads the bar: dates, new-card options, and the per-note
		// background live here as well as (for now) on their own toolbar controls.
		const menuBtn = bar.createEl("button", { cls: "section-cards-icon-btn section-cards-menu-btn" });
		setIcon(menuBtn, "menu");
		menuBtn.setAttr("aria-label", "Cards view menu");
		menuBtn.addEventListener("click", (evt) => this.openMainMenu(evt));

		const fileBtn = bar.createEl("button", { cls: "section-cards-file-btn" });
		fileBtn.setAttr("aria-label", "Pick a different note");
		fileBtn.createSpan({ text: this.filePath || "(no file)" });
		fileBtn.addEventListener("click", () => {
			new FileSuggestModal(this.app, this.plugin, (path) => void this.navigateTo(path)).open();
		});

		// Heading level leads the controls, the filter box beside it: what becomes a
		// card sits on the left with the note name; the view options keep the right.
		const levelWrap = bar.createDiv({ cls: "section-cards-control section-cards-level-control" });
		levelWrap.setAttr("aria-label", "Heading level shown as cards (keys 1–6)");
		levelWrap.createSpan({ text: "Card level", cls: "section-cards-label" });
		const levelSelect = levelWrap.createEl("select", { cls: "dropdown" });
		levelSelect.setAttr("aria-label", "Heading level shown as cards (keys 1–6)");
		this.levelSelect = levelSelect;
		this.populateLevelOptions();
		levelSelect.addEventListener("change", () => {
			this.headingLevel = Number(levelSelect.value);
			this.rememberView();
			void this.refresh().then(() => this.app.workspace.requestSaveLayout());
		});

		// Filter box: typing narrows the wall to cards containing the text; X clears.
		const filterWrap = bar.createDiv({ cls: "section-cards-control section-cards-filter" });
		const filterInput = filterWrap.createEl("input", {
			cls: "section-cards-filter-input",
			attr: {
				type: "text",
				placeholder: "Filter…",
				"aria-label": `Show only cards containing this text (${MOD_LABEL}+F)`,
				spellcheck: "false",
			},
		});
		this.filterInput = filterInput;
		filterInput.value = this.filterQuery;
		filterWrap.toggleClass("has-query", this.filterQuery.length > 0);
		const clearBtn = filterWrap.createEl("button", { cls: "section-cards-filter-clear" });
		setIcon(clearBtn, "x");
		clearBtn.setAttr("aria-label", "Clear the filter and show all cards (Esc)");
		const setQuery = (q: string) => {
			this.filterQuery = q;
			filterWrap.toggleClass("has-query", q.length > 0);
			this.applyFilter();
		};
		filterInput.addEventListener("input", () => setQuery(filterInput.value));
		filterInput.addEventListener("keydown", (evt) => {
			if (evt.key !== "Escape") return;
			evt.preventDefault();
			evt.stopPropagation(); // don't also close a maximized card
			if (filterInput.value) {
				filterInput.value = "";
				setQuery("");
			} else {
				filterInput.blur();
			}
		});
		clearBtn.addEventListener("click", () => {
			filterInput.value = "";
			setQuery("");
			filterInput.focus();
		});

		// Starred-only: show just the starred lines, and only the cards that hold one.
		// Hidden while the note has no starred lines (refresh keeps that current).
		const starBtn = bar.createEl("button", { cls: "section-cards-icon-btn section-cards-star-btn" });
		this.starBtn = starBtn;
		starBtn.toggleClass("is-hidden", !this.hasStars);
		setIcon(starBtn, "star");
		const syncStarBtn = () => {
			starBtn.toggleClass("is-active", this.starredOnly);
			starBtn.setAttr(
				"aria-label",
				this.starredOnly
					? "Show all lines again (S)"
					: `Show only starred lines — ${this.plugin.starEmoji()} (S)`,
			);
		};
		syncStarBtn();
		starBtn.addEventListener("click", () => {
			this.starredOnly = !this.starredOnly;
			this.rememberView();
			syncStarBtn();
			this.applyFilter();
			this.app.workspace.requestSaveLayout();
		});

		bar.createDiv({ cls: "section-cards-spacer" });

		// The date controls sit mid-bar, between the note cluster on the left and the
		// view controls on the right: jump-to-date and the per-note Dates checkbox
		// that governs whether it's offered.
		const datesWrap = bar.createDiv({ cls: "section-cards-control" });

		// Jump to date: only offered when headings are dates and the note actually has
		// some (refresh keeps the visibility current). The native date picker does the
		// asking; the button anchors it over an invisible input.
		const jumpWrap = datesWrap.createDiv({ cls: "section-cards-jump-date" });
		this.jumpDateWrap = jumpWrap;
		jumpWrap.toggleClass("is-hidden", !this.hasDateHeadings);
		const jumpBtn = jumpWrap.createEl("button", { cls: "section-cards-icon-btn section-cards-jump-btn" });
		setIcon(jumpBtn, "calendar-days");
		jumpBtn.setAttr("aria-label", "Jump to a date's card");
		const jumpInput = jumpWrap.createEl("input", {
			cls: "section-cards-jump-input",
			attr: { type: "date", "aria-hidden": "true", tabindex: "-1" },
		});
		const openJumpPicker = () => {
			if (!jumpInput.value) jumpInput.value = mo().format("YYYY-MM-DD");
			const picker = jumpInput as HTMLInputElement & { showPicker?: () => void };
			try {
				if (picker.showPicker) picker.showPicker();
				else jumpInput.focus();
			} catch {
				jumpInput.focus();
			}
		};
		this.openJumpPicker = openJumpPicker;
		jumpBtn.addEventListener("click", openJumpPicker);
		jumpInput.addEventListener("change", () => {
			if (jumpInput.value) this.jumpToDate(jumpInput.value);
		});

		// Per-note: do this note's headings name dates? Governs the today highlight, the
		// jump-to-today scroll, and the calendar button. Until first clicked it mirrors
		// what the note's headings look like (refresh keeps it current).
		const datesLabel = datesWrap.createEl("label", { cls: "section-cards-dates-label" });
		this.datesLabelEl = datesLabel;
		this.syncDatesLabel();
		datesLabel.setAttr(
			"aria-label",
			"This note's headings contain dates — highlight today's card and offer jump-to-date",
		);
		// The text is a .section-cards-label span so phones drop it like the other labels
		// (the checkbox itself stays); the checkbox sits to the label's right.
		// Compact keeps this one label (as "Dates?") — a bare checkbox says nothing.
		datesLabel.createSpan({
			cls: "section-cards-label section-cards-dates-text",
			text: compact ? "Dates?" : "Dates",
		});
		const datesToggle = datesLabel.createEl("input", {
			cls: "section-cards-dates-toggle",
			attr: { type: "checkbox" },
		});
		datesToggle.setAttr(
			"aria-label",
			"This note's headings contain dates — highlight today's card and offer jump-to-date",
		);
		datesToggle.checked = this.containsDates;
		this.datesToggle = datesToggle;
		datesToggle.addEventListener("change", () => {
			void this.plugin.setContainsDates(this.filePath, datesToggle.checked, this.viewSettings());
		});

		// The second stretch of space: with one on each side, the date controls sit
		// centered between the left and right clusters.
		bar.createDiv({ cls: "section-cards-spacer" });

		// The new-card button leads the right cluster, ahead of the view controls.
		const newBtn = bar.createEl("button", { cls: "section-cards-new-btn mod-cta", text: compact ? "+" : "+ New card" });
		newBtn.setAttr("aria-label", "Create a new section in this note (N)");
		newBtn.addEventListener("click", () => this.promptNewCard());

		// View mode: a three-way toggle for how the wall is grouped by the headings
		// above the card level — one flat wall, drill-down hierarchy columns, or a
		// collapsible divider bar per heading. The grouped modes keep whatever layout
		// the dropdown says; neither is available on the Custom Grid canvas.
		const modeWrap = bar.createDiv({ cls: "section-cards-control section-cards-mode-control" });
		modeWrap.createSpan({ text: "View mode", cls: "section-cards-label" });
		const modeSeg = modeWrap.createDiv({ cls: "section-cards-segmented" });
		const modeButtons: [HTMLButtonElement, () => boolean][] = [];
		const syncModeButtons = () => {
			const modesOff = this.layoutOwnsPlacement();
			for (const [btn, isOn] of modeButtons) {
				btn.toggleClass("is-active", isOn());
				btn.toggleAttribute("disabled", modesOff);
				if (modesOff) {
					btn.setAttr("aria-label", "View modes aren't available on the Custom Grid canvas or the Calendar");
				}
			}
		};
		// Compact swaps the three text buttons for icons; the hints still name them.
		const addModeBtn = (label: string, icon: string, hint: string, isOn: () => boolean, apply: () => void) => {
			const btn = modeSeg.createEl("button", { text: compact ? "" : label });
			if (compact) setIcon(btn, icon);
			btn.setAttr("aria-label", hint);
			modeButtons.push([btn, isOn]);
			btn.addEventListener("click", () => {
				if (this.layoutOwnsPlacement() || isOn()) return;
				apply();
				this.rememberView();
				this.applyLayoutClass();
				this.buildToolbar(); // the toggle reflects the state
				void this.refresh().then(() => this.app.workspace.requestSaveLayout());
			});
		};
		addModeBtn(
			"Default",
			"layout-grid",
			"One flat wall of cards, ungrouped",
			() => !this.hierarchyActive() && !this.sectionsActive(),
			() => {
				this.hierarchyOn = false;
				this.sectionsOn = false;
			},
		);
		addModeBtn(
			"Hierarchy",
			"list-tree",
			"Hierarchy columns: drill into the headings above the card level (H)",
			() => this.hierarchyActive(),
			() => {
				this.hierarchyOn = true;
				this.sectionsOn = false; // never both groupers at once
			},
		);
		addModeBtn(
			"Dividers",
			"rows-3",
			"Dividers: group the cards under the heading above the card level (D)",
			() => this.sectionsActive(),
			() => {
				this.sectionsOn = true;
				this.hierarchyOn = false; // never both groupers at once
			},
		);
		syncModeButtons();

		// Tooltips sit on the wrapper as well as the control, so hovering the text
		// label ("Sort", "Layout", …) shows them too, not just the dropdown.
		const sortWrap = bar.createDiv({ cls: "section-cards-control section-cards-sort-control" });
		sortWrap.setAttr("aria-label", "Order the cards are shown in");
		sortWrap.createSpan({ text: "Sort", cls: "section-cards-label" });
		const sortSelect = sortWrap.createEl("select", { cls: "dropdown" });
		sortSelect.setAttr("aria-label", "Order the cards are shown in");
		// On the Calendar the same control orders the months instead of the cards.
		if (this.layout === "calendar") {
			sortWrap.setAttr("aria-label", "Order the months are shown in");
			sortSelect.setAttr("aria-label", "Order the months are shown in");
			sortSelect.createEl("option", { text: "Ascending", value: "asc" });
			sortSelect.createEl("option", { text: "Descending", value: "desc" });
			sortSelect.value = this.sortOrder === "desc" ? "desc" : "asc";
		} else {
			sortSelect.createEl("option", { text: "A → Z", value: "asc" });
			sortSelect.createEl("option", { text: "Z → A", value: "desc" });
			sortSelect.createEl("option", { text: "Document order", value: "doc" });
			sortSelect.value = this.sortOrder;
		}
		sortSelect.addEventListener("change", () => {
			this.sortOrder = sortSelect.value as SortOrder;
			this.rememberView();
			void this.refresh().then(() => this.app.workspace.requestSaveLayout());
		});

		// Layout sits rightmost of the dropdowns: everything between it and the pane
		// edge is fixed-width, so it stays put when the Sort options change widths
		// (the Calendar's do) or a mid-bar control comes and goes.
		const layoutWrap = bar.createDiv({ cls: "section-cards-control" });
		layoutWrap.setAttr("aria-label", "Card layout (L cycles)");
		layoutWrap.createSpan({ text: "Layout", cls: "section-cards-label" });
		const layoutSelect = layoutWrap.createEl("select", { cls: "dropdown" });
		this.layoutSelect = layoutSelect;
		layoutSelect.setAttr("aria-label", "Card layout (L cycles)");
		for (const [value, label, hint] of LAYOUT_OPTIONS) {
			const option = layoutSelect.createEl("option", { text: label, value });
			option.title = hint;
			// Calendar is greyed out in notes with no date headings at any level
			// (refresh keeps this current; the current layout stays selectable).
			if (value === "calendar") option.disabled = !this.calendarSelectable();
		}
		layoutSelect.value = this.layout;
		layoutSelect.addEventListener("change", () => this.setLayout(layoutSelect.value as Layout));

		const templateBtn = bar.createEl("button", { cls: "section-cards-icon-btn section-cards-template-btn" });
		this.templateBtn = templateBtn;
		setIcon(templateBtn, "layout-template");
		templateBtn.setAttr("aria-label", "New-card options for this note: template and heading name");
		templateBtn.toggleClass("has-template", !!this.plugin.getTemplatePath(this.filePath));
		templateBtn.addEventListener("click", (evt) => this.openTemplateMenu(evt, templateBtn));

		const refreshBtn = bar.createEl("button", { cls: "section-cards-icon-btn", text: "↻" });
		refreshBtn.setAttr("aria-label", "Reload from file");
		refreshBtn.addEventListener("click", () => void this.refresh());

		const helpBtn = bar.createEl("button", { cls: "section-cards-help-btn", text: "?" });
		helpBtn.setAttr("aria-label", "Keyboard shortcuts");
		helpBtn.addEventListener("click", () => new ShortcutsModal(this.app).open());
	}

	/**
	 * What the Heading dropdown should offer: the levels the note actually contains,
	 * plus the current level — which always stays listed, even when the note (no
	 * longer) has headings at it, so the select never shows a value it doesn't offer.
	 * With the setting off, all six levels as before.
	 */
	private levelOptionValues(): number[] {
		if (!this.plugin.settings.dynamicLevelOptions) return [1, 2, 3, 4, 5, 6];
		return [...new Set([...this.availableLevels, this.headingLevel])].sort((a, b) => a - b);
	}

	private populateLevelOptions(): void {
		const select = this.levelSelect;
		if (!select) return;
		select.empty();
		for (const l of this.levelOptionValues()) {
			select.createEl("option", { text: `H${l}`, value: String(l) });
		}
		select.value = String(this.headingLevel);
	}

	/** Whether a plain-key view shortcut may run: no card editor open, and the key
	 * wasn't typed into a field (input, textarea, select, or an editable region). */
	private plainShortcutOk(evt: KeyboardEvent): boolean {
		if (this.activeEditor) return false;
		const el = evt.target as HTMLElement | null;
		if (!el) return true;
		if (el.isContentEditable) return false;
		return !el.closest("input, textarea, select");
	}

	/** Offer to create the card for a day that has none — jump-to-date landing on an
	 * empty day and a click on an empty Calendar cell share this dialog. */
	private promptCreateDateCard(iso: string): void {
		const formatted = mo(iso, "YYYY-MM-DD").format(this.cardFormat());
		new CreateDateCardModal(this.app, formatted, () => this.createDateCard(iso)).open();
	}

	/** Scroll the card whose heading is the picked ISO date into view, like the today jump. */
	private jumpToDate(iso: string): void {
		const formatted = mo(iso, "YYYY-MM-DD").format(this.cardFormat());
		const detect = this.plugin.settings.dateDetectFormat;
		// The quick textual match first; the detect pattern finds the rest — a card the
		// calendar places must be findable here too, or this would offer a duplicate.
		const entry =
			this.cardEntries.find((e) => isTodayTitle(e.holder.section.title, iso, formatted)) ??
			(detect
				? this.cardEntries.find((e) => titleToIso(e.holder.section.title, this.cardFormat(), detect) === iso)
				: undefined);
		if (!entry) {
			this.promptCreateDateCard(iso);
			return;
		}
		const title = entry.holder.section.title || "(untitled)";
		if (this.layout === "custom" && !this.customPlacements[entry.holder.section.headingRaw]) {
			new Notice(`“${title}” isn't on the canvas — it's in the list on the right.`);
			return;
		}
		// Off the selected branch: drill the columns down to it first.
		if (this.hierarchyActive() && entry.el.hasClass("is-hier-hidden")) {
			this.hierRevealLine(entry.holder.section.headingLine);
		}
		if (entry.el.hasClass("is-filtered-out")) {
			new Notice(`“${title}” is hidden by the filter.`);
			return;
		}
		entry.el.scrollIntoView({ block: "center", inline: "center" });
		entry.el.addClass("is-linked");
		window.setTimeout(() => entry.el.removeClass("is-linked"), 1600);
	}

	/** Jump-to-date landed on a date with no card: write one (template applied, default
	 * placement), then jump again so the new card scrolls into view and flashes. */
	private async createDateCard(iso: string): Promise<void> {
		const file = this.getFile();
		if (!file) {
			new Notice(`Single File Section Cards: can't find "${this.filePath}".`);
			return;
		}
		const title = mo(iso, "YYYY-MM-DD").format(this.cardFormat());
		const headingRaw = `${"#".repeat(this.headingLevel)} ${title}`;
		const body = await this.plugin.loadTemplateBody(file.path, title);
		await insertSection(this.app, file, headingRaw, this.plugin.settings.newCardPlacement, body ?? undefined);
		await this.refresh();
		this.jumpToDate(iso);
	}

	/** The new-card options menu: this note's template, and its own heading-name format. */
	/**
	 * The hamburger menu at the toolbar's left edge: the per-note dates controls and
	 * new-card options (still on the toolbar too, for now), plus the note's background
	 * image — picked from the vault, or downloaded once into it.
	 */
	private openMainMenu(evt: MouseEvent): void {
		const base: ViewSettings = this.viewSettings();
		const menu = new Menu();

		// Group labels: all-caps via CSS (the source text stays sentence case), and
		// disabled so they read as headings rather than actions.
		const addHeading = (text: string) => {
			menu.addItem((item) =>
				item
					.setTitle(createFragment((frag) => frag.createSpan({ cls: "sfsc-menu-heading", text })))
					.setDisabled(true),
			);
		};

		addHeading("Cards");
		menu.addItem((item) =>
			item
				.setTitle("New card…")
				.setIcon("plus")
				.onClick(() => this.promptNewCard()),
		);
		menu.addItem((item) =>
			item
				.setTitle("Use template…")
				.setIcon("layout-template")
				.onClick(() => this.openTemplateMenu(evt, this.templateBtn ?? this.toolbarEl)),
		);

		menu.addSeparator();
		addHeading("Dates");
		menu.addItem((item) =>
			item
				.setTitle("Highlight today's card")
				.setIcon("calendar-check")
				.setChecked(this.containsDates)
				.onClick(() => void this.plugin.setContainsDates(this.filePath, !this.containsDates, base)),
		);
		if (this.hasDateHeadings) {
			menu.addItem((item) =>
				item
					.setTitle("Jump to a date's card…")
					.setIcon("calendar-days")
					.onClick(() => this.openJumpPicker?.()),
			);
		}

		menu.addSeparator();
		addHeading("Background");
		this.addBackgroundItems(menu, base);

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Settings…")
				.setIcon("settings")
				.onClick(() => this.plugin.openSettingsTab()),
		);

		menu.showAtMouseEvent(evt);
	}

	/** The Background items — shared by the hamburger menu and the wall's right-click menu. */
	private addBackgroundItems(menu: Menu, base: ViewSettings): void {
		menu.addItem((item) =>
			item
				.setTitle("Select background…")
				.setIcon("image")
				.onClick(() => {
					new SelectBackgroundModal(this.app, {
						fromVault: () => {
							new BackgroundSuggestModal(this.app, (file) => {
								void this.plugin.setBackgroundImage(this.filePath, file.path, base);
							}).open();
						},
						fromLocal: () => this.pickLocalBackground(base),
						fromInternet: () => {
							new DownloadBackgroundModal(this.app, this.filePath, (path) => {
								void this.plugin.setBackgroundImage(this.filePath, path, base);
							}).open();
						},
					}).open();
				}),
		);
		if (this.plugin.getBackgroundImage(this.filePath)) {
			// The adjustment sliders live right in the menu: each previews live while
			// dragging and saves on release. Events stop at the row so the menu stays
			// open while they're being used.
			const sliderItem = (
				label: string,
				icon: string,
				max: number,
				value: number,
				preview: (value: number) => void,
				save: (value: number) => void,
			) => {
				menu.addItem((item) => {
					item.setIcon(icon);
					item.setTitle(
						createFragment((frag) => {
							const wrap = frag.createDiv({ cls: "sfsc-menu-slider" });
							wrap.createSpan({ text: label });
							const slider = wrap.createEl("input", {
								attr: {
									type: "range",
									min: "0",
									max: String(max),
									step: "5",
									"aria-label": `Background ${label.toLowerCase()}`,
								},
							});
							slider.value = String(value);
							for (const type of ["click", "mousedown", "pointerdown", "touchstart"]) {
								wrap.addEventListener(type, (e) => e.stopPropagation());
							}
							slider.addEventListener("input", () => preview(Number(slider.value)));
							slider.addEventListener("change", () => save(Number(slider.value)));
						}),
					);
				});
			};
			const adjust = this.plugin.getBackgroundAdjust(this.filePath);
			sliderItem(
				"Transparency",
				"sun-dim",
				100,
				this.plugin.getBackgroundDim(this.filePath),
				(value) => this.contentEl.setCssProps({ "--sfsc-bg-veil": String(value / 100) }),
				(value) => void this.plugin.setBackgroundDim(this.filePath, value, base),
			);
			sliderItem(
				"Brightness",
				"sun",
				200,
				adjust.brightness,
				(value) => this.contentEl.setCssProps({ "--sfsc-bg-light": backgroundLightLayer(value) }),
				(value) => void this.plugin.setBackgroundAdjust(this.filePath, { brightness: value }, base),
			);
			sliderItem(
				"Saturation",
				"droplet",
				100,
				adjust.saturation,
				(value) => this.contentEl.setCssProps({ "--sfsc-bg-desat": backgroundDesatLayer(value) }),
				(value) => void this.plugin.setBackgroundAdjust(this.filePath, { saturation: value }, base),
			);
			menu.addItem((item) =>
				item
					.setTitle("Remove background")
					.setIcon("x")
					.onClick(() => void this.plugin.setBackgroundImage(this.filePath, null, base)),
			);
		}
	}

	/**
	 * Background from anywhere on disk: the OS picker chooses the file, and a copy
	 * lands in the vault's attachment folder so the image travels with the vault
	 * (and keeps working if the original moves).
	 */
	private pickLocalBackground(base: ViewSettings): void {
		const input = createEl("input", { attr: { type: "file", accept: "image/*" } });
		input.addEventListener("change", () => {
			const picked = input.files?.[0];
			if (!picked) return;
			void (async () => {
				try {
					const dot = picked.name.lastIndexOf(".");
					const ext = dot > 0 ? picked.name.slice(dot + 1).toLowerCase() : "";
					if (!BACKGROUND_EXTENSIONS.has(ext)) {
						new Notice("Pick an image file (PNG, JPG, GIF, WebP, AVIF, or BMP).");
						return;
					}
					const stem =
						picked.name
							.slice(0, dot)
							.replace(/[^\w-]+/g, "-")
							.replace(/^-+|-+$/g, "")
							.slice(0, 40) || "background";
					const buffer = await picked.arrayBuffer();
					const dest = await this.app.fileManager.getAvailablePathForAttachment(`${stem}.${ext}`, this.filePath);
					const file = await this.app.vault.createBinary(dest, buffer);
					await this.plugin.setBackgroundImage(this.filePath, file.path, base);
					new Notice(`Background copied into the vault: "${file.path}".`);
				} catch {
					new Notice("Couldn't read that file.");
				}
			})();
		});
		input.click();
	}

	/** Show or clear the note's background image behind the card wall. */
	private applyBackground(): void {
		const path = this.plugin.getBackgroundImage(this.filePath);
		const file = path ? this.app.vault.getFileByPath(path) : null;
		if (file) {
			// The veil is only written inline when this note set its own strength;
			// otherwise styles.css's default (Style Settings can override it) applies.
			const dim = this.plugin.getBackgroundDimOverride(this.filePath);
			const adjust = this.plugin.getBackgroundAdjust(this.filePath);
			this.contentEl.setCssProps({
				"--sfsc-bg-image": `url("${this.app.vault.getResourcePath(file)}")`,
				"--sfsc-bg-veil": dim === null ? "" : String(dim / 100),
				"--sfsc-bg-light": backgroundLightLayer(adjust.brightness),
				"--sfsc-bg-desat": backgroundDesatLayer(adjust.saturation),
			});
			this.contentEl.addClass("has-sfsc-bg");
		} else {
			this.contentEl.setCssProps({
				"--sfsc-bg-image": "",
				"--sfsc-bg-veil": "",
				"--sfsc-bg-light": "",
				"--sfsc-bg-desat": "",
			});
			this.contentEl.removeClass("has-sfsc-bg");
		}
	}

	private openTemplateMenu(evt: MouseEvent, btn: HTMLElement): void {
		const base: ViewSettings = this.viewSettings();
		const current = this.plugin.getTemplatePath(this.filePath);
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle(current ? `Template: ${current}` : "No template for this note").setDisabled(true),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Choose template note…")
				.setIcon("file-search")
				.onClick(() => {
					new FileSuggestModal(this.app, this.plugin, (path) => {
						if (path === this.filePath) {
							new Notice("A note can't be its own template.");
							return;
						}
						void this.plugin.setTemplatePath(this.filePath, path, base);
						btn.addClass("has-template");
					}).open();
				}),
		);
		if (current) {
			menu.addItem((item) =>
				item
					.setTitle("Remove template")
					.setIcon("x")
					.onClick(() => {
						void this.plugin.setTemplatePath(this.filePath, null, base);
						btn.removeClass("has-template");
					}),
			);
		}

		const override = this.plugin.getNewCardFormatOverride(this.filePath);
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle(`Heading name: ${this.cardFormat()}${override ? "" : " (default)"}`).setDisabled(true),
		);
		menu.addItem((item) =>
			item
				.setTitle("Set heading name for this note…")
				.setIcon("pencil")
				.onClick(() => {
					new HeadingFormatModal(this.app, override ?? "", this.plugin.settings.newCardFormat, (value) => {
						void this.plugin.setNewCardFormat(this.filePath, value, base);
					}).open();
				}),
		);
		if (override) {
			menu.addItem((item) =>
				item
					.setTitle("Use the default heading name")
					.setIcon("rotate-ccw")
					.onClick(() => void this.plugin.setNewCardFormat(this.filePath, null, base)),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/** The color button's menu: one swatch per palette color, plus "No color". */
	private openColorMenu(evt: MouseEvent, file: TFile, headingRaw: string): void {
		const base: ViewSettings = this.viewSettings();
		const current = this.plugin.getCardColors(file.path)[headingRaw];
		const palette = this.plugin.palette();
		const menu = new Menu();
		CARD_COLORS.forEach(([name], i) => {
			menu.addItem((item) => {
				const title = createFragment();
				title.createSpan({ cls: `sfsc-swatch sfsc-swatch-${name}` });
				title.appendText(palette[i].label);
				item
					.setTitle(title)
					.setChecked(current === name)
					.onClick(() => void this.plugin.setCardColor(file.path, headingRaw, name, base));
			});
		});
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("No color")
				.setChecked(!current)
				.onClick(() => void this.plugin.setCardColor(file.path, headingRaw, null, base)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Configure colors…")
				.setIcon("settings")
				.onClick(() => this.plugin.openSettingsTab()),
		);
		menu.showAtMouseEvent(evt);
	}

	/** Ask for a heading and placement, write the new section, then open it for editing. */
	promptNewCard(): void {
		const file = this.getFile();
		if (!file) {
			new Notice(`Single File Section Cards: can't find "${this.filePath}".`);
			return;
		}

		const defaultText = `${"#".repeat(this.headingLevel)} ${mo().format(this.cardFormat())}`;

		new NewCardModal(
			this.app,
			defaultText,
			this.plugin.settings.newCardPlacement,
			mo().format("YYYY-MM-DD"),
			(isoDate) =>
				`${"#".repeat(this.headingLevel)} ${mo(isoDate, "YYYY-MM-DD").format(this.cardFormat())}`,
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

				const body = await this.plugin.loadTemplateBody(file.path, title);
				const { level: written, duplicate } = await insertSection(
					this.app,
					file,
					headingRaw,
					placement,
					body ?? undefined,
				);

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
		// The path may be user-typed (settings, the note picker), so normalize it first.
		const path = normalizePath(this.filePath);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) return file;
		// Fall back to a fuzzy resolve so a bare filename works from anywhere in the vault.
		const resolved = this.app.metadataCache.getFirstLinkpathDest(path.replace(/\.md$/, ""), "");
		return resolved ?? null;
	}

	/** Clear the wall (cards and hierarchy columns) and show a two-line message instead. */
	private showEmpty(line1: string, line2: string): void {
		this.clearAllCards();
		this.clearHierarchy();
		const empty = this.gridEl.createDiv({ cls: "section-cards-empty" });
		empty.createEl("p", { text: line1 });
		empty.createEl("p", { text: line2 });
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
			this.containsDates = false;
			this.hasDateHeadings = false;
			this.jumpDateWrap?.toggleClass("is-hidden", true);
			this.hasStars = false;
			this.starBtn?.toggleClass("is-hidden", true);
			this.hasAnyDates = false;
			this.syncCalendarOption();
			this.applyBackground();
			this.showEmpty(
				`Can't find "${this.filePath}".`,
				"Pick a note from the toolbar, or set a default in the plugin settings.",
			);
			return;
		}

		this.filePath = file.path;
		this.applyBackground();
		const content = await this.app.vault.cachedRead(file);
		if (gen !== this.renderGeneration) return;
		const lines = content.split(/\r?\n/);

		// The Heading dropdown offers only the levels the note actually has (plus the
		// current one); an edit that introduces or removes a level updates it in place
		// on the post-save refresh.
		this.availableLevels = headingLevelsIn(lines);
		if (this.levelSelect) {
			const want = this.levelOptionValues().join(",");
			const have = Array.from(this.levelSelect.options)
				.map((o) => o.value)
				.join(",");
			if (want !== have) this.populateLevelOptions();
		}

		// A note the user hasn't set a view for opens at a level that actually has headings.
		if (!this.plugin.getStoredView(file.path)) {
			const level = pickHeadingLevel(lines, this.headingLevel);
			if (level !== this.headingLevel) {
				this.headingLevel = level;
				this.buildToolbar();
			}
		}

		// Any level with date headings makes the Calendar layout available — the
		// dropdown greys it out otherwise. In the Calendar itself, the view follows
		// that level, regardless of the level dropdown's last setting; the user's own
		// level is parked in preCalendarLevel and comes back when the layout does.
		const cardFormat = this.plugin.getNewCardFormat(file.path);
		const detect = this.plugin.settings.dateDetectFormat;
		const dateCounts = dateHeadingCounts(lines, cardFormat, detect);
		const dateLevel = bestDateLevel(dateCounts);
		this.hasAnyDates = dateLevel !== null;
		this.syncCalendarOption();
		if (this.layout !== "calendar" && this.preCalendarLevel !== null) {
			this.headingLevel = this.preCalendarLevel;
			this.preCalendarLevel = null;
			this.buildToolbar();
		}
		if (this.layout === "calendar" && dateLevel && dateLevel !== this.headingLevel) {
			this.preCalendarLevel ??= this.headingLevel;
			this.headingLevel = dateLevel;
			this.buildToolbar();
		}
		// Measured before the card DOM churns below — reading offsetHeight after the
		// rebuild would force a synchronous reflow of the whole freshly-touched grid.
		if (this.layout === "calendar") this.updateToolbarOffset();

		const sections = parseCards(lines, this.headingLevel, this.plugin.unfiledTitle());

		// Does this note deal in dates? The checkbox rules when the user has set it;
		// until then the note decides for itself (the tally above already looked at
		// every heading). The jump-to-date button additionally needs a date to land on.
		const noteHasDates = dateCounts[this.headingLevel] > 0;
		this.containsDates = this.plugin.getContainsDates(file.path) ?? noteHasDates;
		this.hasDateHeadings = this.containsDates && noteHasDates;
		this.jumpDateWrap?.toggleClass("is-hidden", !this.hasDateHeadings);
		if (this.datesToggle) this.datesToggle.checked = this.containsDates;
		this.syncDatesLabel();

		// The starred-only toggle is only offered while the note has a starred line.
		// When the last star goes, the mode turns itself off so nothing stays hidden
		// behind a control that is no longer on screen.
		const starEmoji = this.plugin.starEmoji();
		this.hasStars = sections.some((s) => sectionHasStar(s.body.split("\n"), starEmoji));
		if (!this.hasStars && this.starredOnly) {
			this.starredOnly = false;
			this.rememberView();
		}
		this.starBtn?.toggleClass("is-hidden", !this.hasStars);
		this.starBtn?.toggleClass("is-active", this.starredOnly);

		// The Calendar only means something on a dated note: without the Dates checkbox
		// there is nothing to place on a month, so say so instead of guessing.
		const calendar = this.layout === "calendar";
		if (calendar && !this.containsDates) {
			this.showEmpty(
				"The Calendar layout needs date headings.",
				"Turn on the toolbar's Dates checkbox, or pick another layout.",
			);
			return;
		}

		const pinnedList = this.plugin.getPinned(file.path);
		const pinnedKeys = new Set(pinnedList);
		const cardColors = this.plugin.getCardColors(file.path);
		// The Calendar shows dated cards in date order — sort and pins don't apply,
		// and sections whose headings name no date have no square to sit on. Each
		// title is parsed once here; layoutCalendar reuses the map instead of re-parsing.
		const isoByHeading = new Map<string, string>();
		let ordered: Section[];
		if (calendar) {
			const dated: { s: Section; iso: string }[] = [];
			for (const s of sections) {
				const iso = titleToIso(s.title, cardFormat, detect);
				if (iso === null) continue;
				dated.push({ s, iso });
				isoByHeading.set(s.headingRaw, iso);
			}
			ordered = dated.sort((a, b) => a.iso.localeCompare(b.iso)).map((x) => x.s);
		} else {
			ordered = applyPinned(sortSections(sections, this.sortOrder), pinnedList);
		}
		const pinnedCount =
			!calendar && pinnedKeys.size ? ordered.filter((s) => pinnedKeys.has(s.headingRaw)).length : 0;
		// Sticky pins render in their own band between toolbar and grid. pinnedShown
		// tracks only pins leading the grid itself — the divider and Grid Aligned's
		// row math key off it, and neither applies to the band. With hierarchy on,
		// the band sits above the columns+cards row, so pins survive branch changes.
		const stickyPinned =
			this.plugin.settings.stickyPinned &&
			pinnedCount > 0 &&
			pinnedCount < ordered.length &&
			!this.layoutOwnsPlacement();
		this.pinnedShown = stickyPinned ? 0 : pinnedCount;

		// Section dividers: after the pinned prefix, regroup the cards under their nearest
		// ancestor heading — the divider bar each group renders beneath. Groups keep the
		// order the active sort gave their first card, so a newest-first note leads with
		// its newest section; within a group the sort applies unchanged.
		this.sectionGroups = [];
		if (this.sectionsActive()) {
			if (this.collapsedFile !== file.path) {
				this.collapsedFile = file.path;
				this.collapsedSections.clear();
			}
			const grouped = groupByAncestor(
				ordered.slice(pinnedCount),
				parseAncestorHeadings(lines, this.headingLevel),
			);
			ordered = [...ordered.slice(0, pinnedCount), ...grouped.flatMap((g) => g.sections)];
			this.sectionGroups = grouped.map((g) => ({
				key: g.key,
				title: g.title,
				keys: g.sections.map((s) => s.headingRaw),
			}));
			// Ancestor-less cards leading the wall read as a preamble — no divider.
			if (this.sectionGroups[0]?.key === "") this.sectionGroups.shift();
		}

		if (!ordered.length) {
			this.clearAllCards();
			// The columns still show the note's structure (with zero counts), which is
			// more useful next to the "no headings at this level" message than staleness.
			if (this.hierarchyActive()) this.renderHierarchy(lines);
			else this.clearHierarchy();
			const empty = this.gridEl.createDiv({ cls: "section-cards-empty" });
			if (calendar) {
				empty.createEl("p", { text: `No date headings found in ${file.basename}.` });
				empty.createEl("p", { text: "The Calendar places headings that name a day, like 2026-08-26." });
			} else {
				empty.createEl("p", { text: `No level-${this.headingLevel} headings in ${file.basename}.` });
				empty.createEl("p", { text: "Try a different heading level in the toolbar." });
			}
			return;
		}

		// A note that actually rendered cards is remembered (storeView dedupes), so
		// "Reopen remembered notes as cards" knows this note belongs to this view.
		this.rememberView();

		// Helper elements go; the cards themselves are reconciled below, so an edit to one
		// section rebuilds one card and every other card's rendered markdown is kept.
		for (const stray of Array.from(
			this.gridEl.querySelectorAll(
				".section-cards-row-rule, .section-cards-pin-rule, .section-cards-section-bar, .section-cards-empty, .sc-cal-dow, .sc-cal-month, .sc-cal-blank",
			),
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
		const immediate: CardEntry[] = [];
		const deferred: CardEntry[] = [];
		const queueBody = (entry: CardEntry) => {
			if (!entry.renderBody) return;
			// On the canvas, unplaced cards are display:none — rendering their markdown
			// would be pure waste. Placement back-fills the owed render (applyCustomLayout).
			if (this.layout === "custom" && !this.customPlacements[entry.holder.section.headingRaw]) return;
			if (immediate.length < INITIAL_RENDER_COUNT) {
				immediate.push(entry);
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
				this.applyBodyHeight(entry.bodyEl);
			} else {
				entry = this.renderCard(file, section, today);
			}
			// Reused cards keep their old pin state; a pin toggle re-renders with the same raw.
			const isPinned = pinnedKeys.has(section.headingRaw);
			if (entry.el.hasClass("is-pinned") !== isPinned) this.applyPinState(entry.el, isPinned);
			this.applyCardColor(entry.el, cardColors[section.headingRaw]);
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
		// With the sticky setting on, pinned cards parent into the band above the grid —
		// insertBefore moves them back into the grid when it turns off or pins change.
		const bands: [HTMLElement, CardEntry[]][] = stickyPinned
			? [
					[this.pinnedEl, nextEntries.slice(0, pinnedCount)],
					[this.gridEl, nextEntries.slice(pinnedCount)],
				]
			: [[this.gridEl, nextEntries]];
		for (const [container, entries] of bands) {
			let cursor: ChildNode | null = container.firstChild;
			for (const entry of entries) {
				// Masonry spans belong to the main grid; a card that moves into the band
				// brings its inline span along, so shed it here. (layoutMasonry only
				// walks gridEl's children, so it can't clean the band itself.)
				if (container === this.pinnedEl && entry.el.style.gridRowEnd) {
					entry.el.setCssStyles({ gridRowEnd: "" });
				}
				if (entry.el === cursor) {
					cursor = cursor.nextSibling;
					continue;
				}
				container.insertBefore(entry.el, cursor);
			}
		}
		if (stickyPinned) this.updateToolbarOffset();

		// A full-width rule closes the pinned band; auto-placement can't put anything
		// beside or above it, so the band holds even in the packed masonry layouts.
		// (The canvas places cards absolutely, and the hierarchy pane hides cards off
		// the selected branch, so a band divider makes no sense in either.)
		if (
			this.pinnedShown > 0 &&
			this.pinnedShown < nextEntries.length &&
			this.layout !== "custom" &&
			!this.hierarchyActive()
		) {
			const rule = createDiv({ cls: "section-cards-pin-rule" });
			this.gridEl.insertBefore(rule, nextEntries[this.pinnedShown].el);
		}

		this.insertSectionBars();

		// Calendar: interleave the date-ordered cards with month labels and blank day
		// cells, so grid auto-placement puts every day in its weekday column.
		if (calendar) this.layoutCalendar(isoByHeading);

		// Hierarchy: rebuild the drill-down columns and hide off-branch cards before the
		// masonry pass below measures anything.
		if (this.hierarchyActive()) this.renderHierarchy(lines);
		else this.clearHierarchy();

		// Pack once with what's laid out, again once the first markdown batch has landed.
		this.layoutMasonry();
		await Promise.all(renders);
		if (gen !== this.renderGeneration) return;

		this.prepareBodies(immediate);
		// Re-apply an active filter to the fresh entries before anything is measured —
		// starred-only counts, and so does clearing its leftover class after it turned
		// itself off above.
		if (this.filterQuery.trim() || this.starredOnly || this.contentEl.hasClass("is-starred-only")) {
			this.applyFilter();
		}
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

		// A note's first render in this view brings today's card into view. A pending
		// edit or maximize means the user just made a card — that scroll wins instead.
		this.todayJumpPending = false;
		if (this.todayJumpedFor !== file.path) {
			this.todayJumpedFor = file.path;
			if (this.plugin.settings.jumpToToday && today && !this.pendingEditHeading && !this.pendingMaximizeHeading) {
				// The hierarchy columns may be sitting on a different branch than today's.
				if (this.hierarchyActive()) {
					const todayEntry = this.cardEntries.find((e) => e.el.hasClass("is-today"));
					if (todayEntry && todayEntry.el.hasClass("is-hier-hidden")) {
						this.hierRevealLine(todayEntry.holder.section.headingLine);
					}
				}
				const todayCard = this.gridEl.querySelector(".section-card.is-today");
				if (todayCard) {
					todayCard.scrollIntoView({ block: "center", inline: "center" });
					// Deferred bodies grow the cards above and push today's card around,
					// so the jump is re-aimed once they've all landed.
					this.todayJumpPending = deferred.length > 0;
				}
			}
		}

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
				// A card created on another branch: drill the columns down to it first.
				if (this.hierarchyActive() && target.el.hasClass("is-hier-hidden")) {
					this.hierRevealLine(target.section.headingLine);
				}
				target.el.scrollIntoView({ block: "center" });
				this.startEditing(target.el, file, target.section);
			}
		}

		if (this.pendingMaximizeHeading) {
			const target = this.cardsByHeading.get(this.pendingMaximizeHeading);
			this.pendingMaximizeHeading = null;
			if (target) {
				if (this.hierarchyActive() && target.el.hasClass("is-hier-hidden")) {
					this.hierRevealLine(target.section.headingLine);
				}
				this.toggleMaximized(target.el);
			}
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

		// The delete confirmation, shared by the hover strip's trash button and the
		// title bar's right-click menu.
		const confirmDeleteCard = () => {
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
		};

		// Right-click on the title bar: copy the card's contents, or delete the card.
		header.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Copy card contents")
					.setIcon("copy")
					.onClick(async () => {
						try {
							await navigator.clipboard.writeText(holder.section.body);
							new Notice("Card contents copied.");
						} catch {
							new Notice("Couldn't access the clipboard.");
						}
					}),
			);
			menu.addItem((item) => item.setTitle("Delete card").setIcon("trash-2").onClick(confirmDeleteCard));
			menu.showAtMouseEvent(evt);
		});

		// The pin sits in the title bar's right corner, always visible as a bare glyph:
		// dim when unpinned, full-strength accent when pinned. (applyPinState below sets
		// the icon and label; the other actions stay in the hover strip.)
		const pinBtn = header.createEl("button", { cls: "section-card-pin" });
		pinBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			void this.plugin.togglePin(file.path, holder.section.headingRaw, this.viewSettings());
		});

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

		// The action buttons live in an overlay anchored to the header's right edge, so
		// the title keeps the full width until a hover reveals them over it.
		const actions = header.createDiv({ cls: "section-card-actions" });
		// A clicked strip button keeps focus, and the strip's :focus-within reveal then
		// holds it open — over the body's first line, opaquely on colored cards — until
		// something else is clicked. Acting closes the strip: drop the button's focus.
		// Capture phase, because the buttons' own handlers stop propagation (keyboard
		// users tab back in to reopen).
		actions.addEventListener(
			"click",
			(evt) => {
				(evt.target as HTMLElement | null)?.closest("button")?.blur();
			},
			{ capture: true },
		);

		const quickAddBtn = actions.createEl("button", { cls: "section-card-quickadd" });
		setIcon(quickAddBtn, "plus");
		quickAddBtn.setAttr("aria-label", "Quick add text to this card");
		quickAddBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			const target = holder.section;
			new QuickAddModal(this.plugin, target.title || "(untitled)", async (text, where) => {
				const ok = await quickAddToSection(this.app, file, this.headingLevel, target, text, where);
				if (!ok) {
					new Notice("Single File Section Cards: couldn't find that section — the file changed on disk.");
				}
				await this.refresh();
			}).open();
		});

		const colorBtn = actions.createEl("button", { cls: "section-card-color" });
		setIcon(colorBtn, "palette");
		colorBtn.setAttr("aria-label", "Set this card's color");
		colorBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.openColorMenu(evt, file, holder.section.headingRaw);
		});

		const deleteBtn = actions.createEl("button", { cls: "section-card-delete" });
		setIcon(deleteBtn, "trash-2");
		deleteBtn.setAttr("aria-label", "Delete this card");
		deleteBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			confirmDeleteCard();
		});

		const bigBtn = actions.createEl("button", { cls: "section-card-big" });
		// Magnifier for the click action (make the card big); the button doubles as the
		// grab point for drag-to-reorder, which the tooltip spells out.
		setIcon(bigBtn, "zoom-in");
		bigBtn.setAttr("aria-label", "Make this card big · drag to reorder");
		bigBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.toggleMaximized(card);
		});

		const openBtn = actions.createEl("button", { cls: "section-card-open" });
		setIcon(openBtn, "arrow-up-right");
		openBtn.setAttr("aria-label", "Open this section in the note");
		openBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			void this.plugin.revealSection(file, holder.section.headingLine);
		});

		this.applyPinState(card, this.plugin.getPinned(file.path).includes(section.headingRaw));

		// markdown-rendered lets Obsidian's own reading-view CSS style lists, tasks, tags, etc.
		const bodyEl = card.createDiv({ cls: "section-card-body markdown-rendered" });
		this.applyBodyHeight(bodyEl);

		let renderBody: (() => Promise<void>) | null = null;
		if (section.body.trim()) {
			renderBody = () =>
				MarkdownRenderer.render(this.app, bodyForRender(holder.section.body), bodyEl, file.path, scope);
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
			// A calendar cell is too small to edit in place: any click makes the day
			// big first; the maximized card then edits on click as usual. Another
			// card's open editor still commits, exactly like the click-away below.
			if (this.layout === "calendar" && !card.hasClass("is-maximized")) {
				evt.stopPropagation();
				const editing = this.activeEditor;
				if (editing && editing.card !== card) void editing.finish(true);
				this.toggleMaximized(card);
				return;
			}
			const open = this.activeEditor;
			if (open && open.card !== card) {
				// Click-away commits the other card's edit; the reconciler reuses this
				// card's element across that refresh, so it can then open as usual.
				void open.finish(true).then(() => this.startEditing(card, file, holder.section));
				return;
			}
			this.startEditing(card, file, holder.section);
		});

		// Right-click a task or paragraph: send it to a neighbouring card without dragging.
		bodyEl.addEventListener("contextmenu", (evt) => {
			if (card.hasClass("is-editing")) return;
			const target = evt.target as HTMLElement | null;
			if (target?.closest("a")) return; // links keep their native menu
			const el = target?.closest<HTMLElement>(".sc-block");
			if (!el || !bodyEl.contains(el)) {
				// Off any block, the menu can still offer the Tasks create dialog and paste.
				evt.preventDefault();
				evt.stopPropagation();
				const menu = new Menu();
				const api = this.plugin.tasksApi();
				if (api) {
					menu.addItem((item) =>
						item
							.setTitle("New task (Tasks)…")
							.setIcon("list-plus")
							.onClick(() => void this.newTaskWithTasks(api, file, holder.section, null, null)),
					);
				}
				menu.addItem((item) =>
					item
						.setTitle("Paste at end")
						.setIcon("clipboard-paste")
						.onClick(async () => {
							let text = "";
							try {
								text = (await navigator.clipboard.readText()).replace(/\s+$/, "");
							} catch {
								new Notice("Couldn't access the clipboard.");
								return;
							}
							if (!text) {
								new Notice("The clipboard is empty.");
								return;
							}
							const ok = await pasteAtSectionEnd(this.app, file, this.headingLevel, holder.section, text);
							if (!ok) {
								new Notice(
									"Single File Section Cards: couldn't find that section — the file changed on disk.",
								);
							}
							await this.refresh();
						}),
				);
				menu.showAtMouseEvent(evt);
				return;
			}
			const els = this.eligibleBlockEls(bodyEl);
			const domIndex = els.indexOf(el);
			const body = holder.section.body.split("\n");
			const block = movableBlocks(body)[domIndex];
			// The DOM element and the parsed block must agree before anything can move.
			if (domIndex < 0 || !block || !SectionCardsView.blockTextsAgree(el, body.slice(block.start, block.end))) {
				return;
			}
			evt.preventDefault();
			evt.stopPropagation();
			this.openBlockMenu(evt, file, holder.section, domIndex, body.slice(block.start, block.end).join("\n"), el);
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
			// The unfiled card is the text above the first heading — it can't be reordered.
			if (holder.section.unfiled) {
				evt.preventDefault();
				return;
			}
			evt.stopPropagation(); // keep the app's global drag handling out of card drags
			// On the Calendar a drag moves the card to another day (or merges it into
			// one) instead of reordering, so the document-order rule doesn't apply.
			if (this.layout === "calendar") {
				this.dragging = holder;
				card.addClass("is-dragging");
				if (evt.dataTransfer) {
					evt.dataTransfer.effectAllowed = "move";
					evt.dataTransfer.setData("text/plain", holder.section.headingRaw);
				}
				return;
			}
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
			this.setCalDrop(null);
			this.dragging = null;
		});
		card.addEventListener("dragover", (evt) => {
			if (this.draggingBlock) {
				evt.preventDefault();
				if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
				this.clearBlockDropMarks();
				const at = this.blockDropAt(evt, bodyEl);
				if (at.el) {
					at.el.addClass(at.before ? "sc-blockdrop-before" : "sc-blockdrop-after");
					this.blockDropMarkEl = at.el;
				} else {
					card.addClass("sc-blockdrop-end");
					this.blockDropEndEl = card;
				}
				return;
			}
			// Dropping beside the unfiled card would land a section above the preamble,
			// where its text stops being a section — drop before the first real card instead.
			if (!this.dragging || this.dragging === holder || holder.section.unfiled) return;
			evt.preventDefault();
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
			// Calendar: the whole day is the target (a merge), not a before/after slot.
			if (this.layout === "calendar") this.setCalDrop(card);
			else this.setDropMarker(card, this.isDropBefore(evt, card));
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
					at.anchorIndex,
					at.anchorSide,
				);
				return;
			}
			if (!this.dragging || this.dragging === holder || holder.section.unfiled) return;
			evt.preventDefault();
			evt.stopPropagation();
			const moved = this.dragging.section;
			this.setDropMarker(null, false);
			this.setCalDrop(null);
			this.dragging = null;
			// Calendar: the day already has a card — offer to merge into it, or cancel.
			if (this.layout === "calendar") {
				new MergeCardsModal(this.app, moved.title, holder.section.title, async () => {
					const ok = await mergeSectionsInFile(this.app, file, this.headingLevel, moved, holder.section);
					if (!ok) {
						new Notice("Single File Section Cards: couldn't merge — the file changed on disk.");
					}
					await this.refresh();
				}).open();
				return;
			}
			void this.completeDrag(file, moved, holder.section, this.isDropBefore(evt, card));
		});

		return { el: card, bodyEl, scope, holder, raw: section.raw, renderBody };
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
				this.prepareBodies([owed]);
				this.repack();
			});
		}

		// Scrolling is locked while blown up, so the overlay's inset covers the visible tab.
		this.contentEl.addClass("has-maximized-card");
		const caret = captureCaret(card);
		overlay.appendChild(card);
		card.addClass("is-maximized");
		body.setCssStyles({ maxHeight: "" });
		setIcon(button, "zoom-out");
		button.setAttr("aria-label", "Shrink this card (Esc)");
		restoreCaret(caret);
	}

	private closeMaximized(): void {
		const open = this.maximized;
		if (!open) return;
		this.maximized = null;

		open.card.removeClass("is-maximized");
		open.card.setCssStyles(open.inlineRect);
		open.body.setCssStyles({ maxHeight: open.bodyMaxHeight });
		setIcon(open.button, "zoom-in");
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
			// Leaving the canvas restores native drag for card reordering and strips
			// the placement geometry — inline left/top/width/height (set by placement
			// and by the native resizer) would otherwise override the fixed layouts.
			for (const entry of this.cardEntries) {
				if (!entry.el.draggable) entry.el.draggable = true;
				if (entry.el.hasClass("is-placed")) entry.el.removeClass("is-placed");
				if (entry.el.style.length) {
					entry.el.setCssStyles({ left: "", top: "", width: "", height: "" });
				}
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
				this.prepareBodies(owedRenders);
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
		const clearBtn = actions.createEl("button", { cls: "section-cards-tray-clear", text: "Clear layout" });
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
		const trayColors = this.plugin.getCardColors(this.filePath);
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
			this.applyCardColor(tile, trayColors[key]);
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
			.replace(/[*_`~[\]()#|>]/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.toLowerCase()
			.slice(0, 24);
	}

	/** The elements currently wearing block-drop marks — tracked so clearing them
	 * (which runs on every dragover) needn't sweep the whole view with querySelectorAll. */
	private blockDropMarkEl: HTMLElement | null = null;
	private blockDropEndEl: HTMLElement | null = null;

	private clearBlockDropMarks(): void {
		this.blockDropMarkEl?.removeClass("sc-blockdrop-before");
		this.blockDropMarkEl?.removeClass("sc-blockdrop-after");
		this.blockDropMarkEl = null;
		this.blockDropEndEl?.removeClass("sc-blockdrop-end");
		this.blockDropEndEl = null;
	}

	/** Where in the hovered card a dragged block would land. */
	private blockDropAt(
		evt: DragEvent,
		bodyEl: HTMLElement,
	): { anchorIndex: number | "start" | null; anchorSide: "before" | "after"; el: HTMLElement | null; before: boolean } {
		const target = evt.target as HTMLElement | null;
		const hovered = target?.closest<HTMLElement>(".sc-block");
		if (hovered && bodyEl.contains(hovered)) {
			const els = this.eligibleBlockEls(bodyEl);
			const index = els.indexOf(hovered);
			if (index >= 0) {
				const rect = hovered.getBoundingClientRect();
				const before = evt.clientY < rect.top + rect.height / 2;
				return { anchorIndex: index, anchorSide: before ? "before" : "after", el: hovered, before };
			}
		}
		// Hovering a non-draggable block (a subheading, quote, fence, table…): the
		// text lands on the hovered side of it, anchored to the nearest draggable
		// neighbour — or the body's start/end when there is none on that side.
		let other = target && bodyEl.contains(target) && target !== bodyEl ? target : null;
		while (other && other.parentElement !== bodyEl) other = other.parentElement;
		if (other && !other.hasClass("sc-block")) {
			const els = this.eligibleBlockEls(bodyEl);
			// A sibling may itself be draggable only through its list items.
			const blockIn = (el: Element | null, last: boolean): number => {
				if (!el) return -1;
				const own = els.indexOf(el as HTMLElement);
				if (own >= 0) return own;
				const items = Array.from(el.querySelectorAll<HTMLElement>(":scope > li"));
				for (const li of last ? items.reverse() : items) {
					const i = els.indexOf(li);
					if (i >= 0) return i;
				}
				return -1;
			};
			const rect = other.getBoundingClientRect();
			const before = evt.clientY < rect.top + rect.height / 2;
			if (before) {
				for (let sib = other.previousElementSibling; sib; sib = sib.previousElementSibling) {
					const i = blockIn(sib, true);
					if (i >= 0) return { anchorIndex: i, anchorSide: "after", el: other, before };
				}
				return { anchorIndex: "start", anchorSide: "before", el: other, before };
			}
			for (let sib = other.nextElementSibling; sib; sib = sib.nextElementSibling) {
				const i = blockIn(sib, false);
				if (i >= 0) return { anchorIndex: i, anchorSide: "before", el: other, before };
			}
			return { anchorIndex: null, anchorSide: "before", el: other, before };
		}
		return { anchorIndex: null, anchorSide: "before", el: null, before: false };
	}

	/**
	 * The right-click menu for a movable block: send it to a neighbouring card (as the
	 * wall is displayed — pins and the current sort included, always at the view's
	 * heading level), toggle it done when it's a task, or delete it.
	 */
	private openBlockMenu(
		evt: MouseEvent,
		file: TFile,
		section: Section,
		blockIndex: number,
		blockText: string,
		blockEl: HTMLElement,
	): void {
		const at = this.cardEntries.findIndex((entry) => entry.holder.section.headingRaw === section.headingRaw);
		const prev = at > 0 ? this.cardEntries[at - 1].holder.section : null;
		const next = at >= 0 && at < this.cardEntries.length - 1 ? this.cardEntries[at + 1].holder.section : null;

		const label = (target: Section) => {
			const title = target.title || "(untitled)";
			return title.length > 28 ? `${title.slice(0, 27)}…` : title;
		};

		const menu = new Menu();
		if (prev) {
			// Arrives at the previous card's end, the spot adjacent to where it left.
			menu.addItem((item) =>
				item
					.setTitle(`Move line to previous card (${label(prev)})`)
					.setIcon("arrow-up")
					.onClick(() => void this.completeBlockDrag(file, { section, blockIndex, blockText }, prev, null)),
			);
		}
		if (next) {
			menu.addItem((item) =>
				item
					.setTitle(`Move line to next card (${label(next)})`)
					.setIcon("arrow-down")
					.onClick(() => void this.completeBlockDrag(file, { section, blockIndex, blockText }, next, 0)),
			);
		}
		// Dated notes: send the block to today's card — the natural "do this today
		// instead" move. Lands at the end, like a drop on the card. A missing today card
		// (weekends in a workday note) is created first, template and placement applied.
		const today = this.todayKeys();
		const todaySection =
			(today &&
				this.cardEntries.find((e) => isTodayTitle(e.holder.section.title, today.iso, today.formatted))
					?.holder.section) ||
			null;
		const showToday = !!today && todaySection?.headingRaw !== section.headingRaw;
		if (today && showToday) {
			const title = todaySection?.title || today.formatted;
			menu.addItem((item) =>
				item
					.setTitle(`Move line to today (${title.length > 28 ? `${title.slice(0, 27)}…` : title})`)
					.setIcon("calendar-check")
					.onClick(async () => {
						let target = todaySection;
						if (!target) {
							await this.createDateCard(today.iso);
							target =
								this.cardEntries.find((e) =>
									isTodayTitle(e.holder.section.title, today.iso, today.formatted),
								)?.holder.section ?? null;
						}
						if (!target) return;
						await this.completeBlockDrag(file, { section, blockIndex, blockText }, target, null);
					}),
			);
		}
		if (prev || next || showToday) menu.addSeparator();

		// Only the block's own checkbox counts — a plain item with task children isn't a task.
		const isTask = TASK_RE.test(blockText.split("\n")[0]);
		const box = isTask ? blockEl.querySelector<HTMLInputElement>("input[type=checkbox]") : null;
		const cardEl = blockEl.closest<HTMLElement>(".section-card");
		const bodyEl = blockEl.closest<HTMLElement>(".section-card-body");
		if (box && cardEl && bodyEl) {
			menu.addItem((item) =>
				item
					.setTitle(box.checked ? "Mark undone" : "Mark done")
					.setIcon(box.checked ? "undo-2" : "check")
					.onClick(() => void this.toggleTask(cardEl, file, section, bodyEl, box)),
			);
		}

		const tasksApi = this.plugin.tasksApi();
		if (tasksApi) {
			if (isTask) {
				menu.addItem((item) =>
					item
						.setTitle("Edit task (Tasks)…")
						.setIcon("pencil")
						.onClick(() => void this.editTaskWithTasks(file, section, blockIndex, blockText)),
				);
			}
			menu.addItem((item) =>
				item
					.setTitle("New task below (Tasks)…")
					.setIcon("list-plus")
					.onClick(() => void this.newTaskWithTasks(tasksApi, file, section, blockIndex, blockText)),
			);
		}

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Copy line")
				.setIcon("copy")
				.onClick(async () => {
					try {
						await navigator.clipboard.writeText(blockText);
						new Notice("Line copied.");
					} catch {
						new Notice("Couldn't access the clipboard.");
					}
				}),
		);
		menu.addItem((item) =>
			item
				.setTitle("Cut line")
				.setIcon("scissors")
				.onClick(async () => {
					try {
						await navigator.clipboard.writeText(blockText);
					} catch {
						// The line must be on the clipboard before it can be deleted.
						new Notice("Couldn't access the clipboard.");
						return;
					}
					const ok = await deleteBlockInFile(
						this.app,
						file,
						this.headingLevel,
						section,
						blockIndex,
						blockText,
					);
					if (!ok) {
						new Notice("Single File Section Cards: couldn't find that line — the file changed on disk.");
					}
					await this.refresh();
				}),
		);
		menu.addItem((item) =>
			item
				.setTitle("Paste below")
				.setIcon("clipboard-paste")
				.onClick(async () => {
					let text = "";
					try {
						text = (await navigator.clipboard.readText()).replace(/\s+$/, "");
					} catch {
						new Notice("Couldn't access the clipboard.");
						return;
					}
					if (!text) {
						new Notice("The clipboard is empty.");
						return;
					}
					const ok = await insertAfterBlockInFile(
						this.app,
						file,
						this.headingLevel,
						section,
						blockIndex,
						blockText,
						text,
					);
					if (!ok) {
						new Notice("Single File Section Cards: couldn't find that line — the file changed on disk.");
					}
					await this.refresh();
				}),
		);
		menu.addSeparator();

		// Star/unstar the block: the configured emoji is written into (or stripped from)
		// the line itself, so the mark survives edits, drags, and sync.
		const emoji = this.plugin.starEmoji();
		const starred = blockStarred(blockText.split("\n")[0], emoji);
		menu.addItem((item) =>
			item
				.setTitle(starred ? "Remove star" : `Add star (${emoji})`)
				.setIcon(starred ? "star-off" : "star")
				.onClick(async () => {
					const ok = await toggleStarInFile(
						this.app,
						file,
						this.headingLevel,
						section,
						blockIndex,
						blockText,
						emoji,
					);
					if (!ok) {
						new Notice("Single File Section Cards: couldn't find that line — the file changed on disk.");
					}
					await this.refresh();
				}),
		);

		menu.addItem((item) =>
			item
				.setTitle("Delete line")
				.setIcon("trash-2")
				.onClick(async () => {
					const ok = await deleteBlockInFile(this.app, file, this.headingLevel, section, blockIndex, blockText);
					if (!ok) {
						new Notice("Single File Section Cards: couldn't find that line — the file changed on disk.");
					}
					await this.refresh();
				}),
		);

		menu.showAtMouseEvent(evt);
	}

	/**
	 * Open the Tasks plugin's create dialog and put the finished line into this section —
	 * right after the clicked block, or at the section's end when none was clicked.
	 */
	private async newTaskWithTasks(
		api: TasksApiV1,
		file: TFile,
		section: Section,
		blockIndex: number | null,
		blockText: string | null,
	): Promise<void> {
		let line: string;
		try {
			line = (await api.createTaskLineModal())?.trim() ?? "";
		} catch {
			new Notice("The Tasks plugin couldn't open its create dialog.");
			return;
		}
		if (!line) return; // cancelled

		const ok =
			blockIndex === null || blockText === null
				? await quickAddToSection(this.app, file, this.headingLevel, section, line, "bottom")
				: await insertAfterBlockInFile(this.app, file, this.headingLevel, section, blockIndex, blockText, line);
		if (!ok) {
			new Notice("Single File Section Cards: couldn't find that section — the file changed on disk.");
		}
		await this.refresh();
	}

	/**
	 * Tasks only exposes editing as an editor command on the cursor line, so this jumps
	 * to the task in a normal editor and opens the Tasks edit dialog there.
	 */
	private async editTaskWithTasks(
		file: TFile,
		section: Section,
		blockIndex: number,
		blockText: string,
	): Promise<void> {
		// Find the task's current line by content, the way every write re-locates its target.
		const content = await this.app.vault.cachedRead(file);
		const lines = content.split(/\r?\n/);
		const target = locateCard(lines, this.headingLevel, section);
		const body = target ? lines.slice(bodyStartLine(target), target.endLine) : null;
		const block = body ? movableBlocks(body)[blockIndex] : null;
		if (!target || !body || !block || body.slice(block.start, block.end).join("\n") !== blockText) {
			new Notice("Single File Section Cards: couldn't find that line — the file changed on disk.");
			await this.refresh();
			return;
		}
		await this.plugin.revealSection(file, bodyStartLine(target) + block.start);
		// The command reads the cursor line in the now-active editor.
		const commands = (this.app as unknown as { commands: { executeCommandById: (id: string) => boolean } }).commands;
		commands.executeCommandById("obsidian-tasks-plugin:edit-task");
	}

	private async completeBlockDrag(
		file: TFile,
		from: { section: Section; blockIndex: number; blockText: string },
		target: Section,
		anchorIndex: number | "start" | null,
		anchorSide: "before" | "after" = "before",
	): Promise<void> {
		const ok = await moveBlockInFile(
			this.app,
			file,
			this.headingLevel,
			from.section,
			from.blockIndex,
			from.blockText,
			target,
			anchorIndex,
			anchorSide,
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

	/** Highlight the calendar day (card or blank cell) a drag would land on. */
	private setCalDrop(el: HTMLElement | null): void {
		if (this.calDropEl && this.calDropEl !== el) this.calDropEl.removeClass("is-cal-drop");
		this.calDropEl = el;
		el?.addClass("is-cal-drop");
	}

	/** Calendar: a card was dropped on an empty day — rewrite its heading to that day. */
	private async moveCardToDate(moved: Section, iso: string): Promise<void> {
		const file = this.getFile();
		if (!file) return;
		const newTitle = retitledDateTitle(moved.title, this.cardFormat(), iso, this.plugin.settings.dateDetectFormat);
		// Keep the card's own hash prefix so the heading stays at its level.
		const hashes = /^#+/.exec(moved.headingRaw)?.[0] ?? "#".repeat(this.headingLevel);
		const newHeading = `${hashes} ${newTitle}`;
		const ok = await retitleSectionInFile(this.app, file, this.headingLevel, moved, newHeading);
		if (ok) {
			// The pin, color, and canvas placement are keyed by the heading line — follow it.
			await this.plugin.renameCardKey(file.path, moved.headingRaw, newHeading);
			const placed = this.customPlacements[moved.headingRaw];
			if (placed) {
				this.customPlacements[newHeading] = placed;
				delete this.customPlacements[moved.headingRaw];
			}
		} else {
			new Notice("Single File Section Cards: couldn't move that card — the file changed on disk.");
		}
		await this.refresh();
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

		// Tasks' own toggle knows recurrence and its done-date settings; ours is the fallback.
		const api = this.plugin.settings.tasksToggle ? this.plugin.tasksApi() : null;
		const checked = api
			? await toggleTaskWithTasksApi(this.app, file, this.headingLevel, section, nth, api)
			: await toggleTaskInFile(
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

		// Pad with a newline so typing starts on a fresh line under the existing content
		// (for a brand-new card, directly under its title). Trimmed back off on save.
		const initial = section.raw + "\n";

		let embedded: EmbeddedEditor | null = null;
		let readValue: () => string = () => initial;

		let settled = false;
		let autosaveRun: Promise<void> | null = null;
		const finish = async (save: boolean) => {
			if (settled) return;
			settled = true;
			if (this.autosaveTimer !== null) {
				window.clearInterval(this.autosaveTimer);
				this.autosaveTimer = null;
			}
			// An in-flight autosave finishes re-describing `section` first, so the
			// changed-content check and write below run against the on-disk state.
			if (autosaveRun) await autosaveRun.catch(() => {});
			this.activeEditor = null;
			const value = readValue();
			embedded?.destroy();
			// Saving re-renders the card, so remember to blow it back up afterwards.
			// (The unfiled card's first line is body text, not a heading — its key is fixed.)
			if (this.maximized?.card === card) {
				const firstLine = value.split("\n")[0]?.trim();
				this.pendingMaximizeHeading =
					save && firstLine && !section.unfiled ? firstLine : section.headingRaw;
			}
			const edited = trimTrailingBlankLines(value);
			if (save && edited !== section.raw) {
				const written = await writeSection(this.app, file, this.headingLevel, section, edited);
				if (written) new Notice(`Saved “${section.title}” to ${file.basename}`);
			}
			this.editingKey = null;
			await this.refresh();
		};

		if (this.plugin.settings.editorMode !== "plain") {
			const host = bodyEl.createDiv({ cls: "section-card-editor-embed" });
			// Masonry sizes cards by measured height and a live editor grows as you type,
			// so re-measure shortly after each burst of changes.
			const remeasure = debounce(() => this.layoutMasonry(), 150, true);
			embedded = createEmbeddedEditor(this.app, host, {
				value: initial,
				mode: this.plugin.settings.editorMode === "source" ? "source" : "live",
				onSave: () => void finish(true),
				onCancel: () => void finish(false),
				onChange: () => remeasure(),
			});
			if (embedded) {
				readValue = () => (embedded as EmbeddedEditor).value;
				// Clicks inside the editor stay there — same contract as the textarea.
				host.addEventListener("click", (e) => e.stopPropagation());
			} else {
				host.remove(); // internal editor unavailable: fall back to the textarea
			}
		}

		if (!embedded) {
			const textarea = this.buildPlainEditor(bodyEl, initial, finish);
			readValue = () => textarea.value;
		}

		// Autosave: periodically write the editor's content to the note without closing
		// the editor, so a card left in edit mode can't lose more than one interval of
		// work. Refreshes are already suppressed while editing, so the write is invisible
		// to this view until the editor settles.
		const autosave = async () => {
			if (settled) return;
			const edited = trimTrailingBlankLines(readValue());
			if (edited === section.raw) return;
			if (!(await writeSection(this.app, file, this.headingLevel, section, edited))) return;
			section = sectionFromEdited(section, edited);
			if (!settled) this.editingKey = section.headingRaw;
		};
		if (this.plugin.settings.autosaveEnabled) {
			const minutes = Math.max(1, this.plugin.settings.autosaveMinutes);
			this.autosaveTimer = window.setInterval(() => {
				autosaveRun = autosave().catch(() => {});
			}, minutes * 60_000);
		}

		const footer = bodyEl.createDiv({ cls: "section-card-footer" });
		footer.createSpan({ cls: "section-card-hint", text: "Ctrl/⌘+Enter to save · Esc to cancel" });
		const cancelBtn = footer.createEl("button", { text: "Cancel" });
		const saveBtn = footer.createEl("button", { cls: "mod-cta", text: "Save" });
		saveBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void finish(true);
		});
		cancelBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void finish(false);
		});

		this.activeEditor = { card, finish, autosave };
		if (embedded) {
			embedded.focusEnd();
		} else {
			const textarea = bodyEl.querySelector<HTMLTextAreaElement>(".section-card-editor");
			textarea?.focus();
			textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
		}
		this.layoutMasonry();
	}

	/** The dependable editor: a plain textarea with its own history and Tab handling. */
	private buildPlainEditor(
		bodyEl: HTMLElement,
		initial: string,
		finish: (save: boolean) => Promise<void>,
	): HTMLTextAreaElement {
		const textarea = bodyEl.createEl("textarea", { cls: "section-card-editor" });
		textarea.value = initial;
		textarea.rows = Math.min(Math.max(initial.split("\n").length + 1, 4), 30);

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
		return textarea;
	}

	/** True when a card editor is open — used to avoid yanking the file out from under a typist. */
	isEditing(): boolean {
		return this.editingKey !== null;
	}
}

/** Image files the vault offers as card-wall backgrounds. */
const BACKGROUND_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);

/** The veil strength a background image starts with (styles.css falls back to it too). */
const BACKGROUND_DIM_DEFAULT = 45;

/**
 * The brightness layer's color for a percentage: below 100 an increasingly solid
 * black overlay dims the image, above 100 a white one lifts it. 100 = "" so the
 * stylesheet's transparent fallback applies. (CSS can't filter one background
 * layer, so brightness and saturation are approximated with blended layers.)
 */
export function backgroundLightLayer(brightness: number): string {
	if (brightness === 100) return "";
	return brightness < 100
		? `rgba(0, 0, 0, ${(100 - brightness) / 100})`
		: `rgba(255, 255, 255, ${(brightness - 100) / 100})`;
}

/** The desaturation layer's color: a gray blended with `saturation` mode drains the
 * image's color by its alpha. 100 = "" so the transparent fallback applies. */
export function backgroundDesatLayer(saturation: number): string {
	return saturation >= 100 ? "" : `rgba(128, 128, 128, ${(100 - saturation) / 100})`;
}

/** The three places a background image can come from, offered as one dialog. */
class SelectBackgroundModal extends Modal {
	private readonly sources: { fromVault: () => void; fromLocal: () => void; fromInternet: () => void };

	constructor(app: App, sources: { fromVault: () => void; fromLocal: () => void; fromInternet: () => void }) {
		super(app);
		this.sources = sources;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Select background" });
		contentEl.createEl("p", { text: "Where should this note's background image come from?" });

		const option = (name: string, desc: string, button: string, pick: () => void) => {
			new Setting(contentEl)
				.setName(name)
				.setDesc(desc)
				.addButton((b) =>
					b.setButtonText(button).onClick(() => {
						this.close();
						pick();
					}),
				);
		};
		option("From the vault", "Pick an image already in your vault.", "Choose…", this.sources.fromVault);
		option(
			"From this computer",
			"Pick any image on disk; a copy is saved into the vault's attachment folder.",
			"Browse…",
			this.sources.fromLocal,
		);
		option(
			"From the internet",
			"Download an image URL once into the vault's attachment folder.",
			"Download…",
			this.sources.fromInternet,
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Fuzzy-pick an image from the vault for the note's background. */
class BackgroundSuggestModal extends FuzzySuggestModal<TFile> {
	private readonly onChoose: (file: TFile) => void;

	constructor(app: App, onChoose: (file: TFile) => void) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder("Pick an image from the vault…");
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => BACKGROUND_EXTENSIONS.has(f.extension.toLowerCase()));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

/** The saved extension for each image content type a background download may return. */
const IMAGE_TYPE_EXTENSIONS: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/avif": "avif",
	"image/bmp": "bmp",
};

/**
 * Background from the internet: the image at a user-given URL is downloaded ONCE
 * into the vault's attachment folder and used from there — the plugin's only
 * network use, and only ever at the user's explicit request.
 */
class DownloadBackgroundModal extends Modal {
	private readonly notePath: string;
	private readonly onSaved: (vaultPath: string) => void;

	constructor(app: App, notePath: string, onSaved: (vaultPath: string) => void) {
		super(app);
		this.notePath = notePath;
		this.onSaved = onSaved;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Background from the internet" });
		contentEl.createEl("p", {
			text: "The image is downloaded once into your vault's attachment folder and shown from there — nothing loads from the network afterwards.",
		});

		let url = "";
		new Setting(contentEl).setName("Image URL").addText((text) => {
			text.setPlaceholder("https://…");
			text.onChange((value) => (url = value));
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText("Download")
					.setCta()
					.onClick(() => void this.download(url.trim(), b.buttonEl));
			});
	}

	private async download(url: string, button: HTMLButtonElement): Promise<void> {
		if (!url) {
			new Notice("Enter an image URL first.");
			return;
		}
		button.disabled = true;
		button.setText("Downloading…");
		try {
			const res = await requestUrl({ url });
			const type =
				Object.entries(res.headers)
					.find(([k]) => k.toLowerCase() === "content-type")?.[1]
					?.split(";")[0]
					.trim()
					.toLowerCase() ?? "";
			if (type && !type.startsWith("image/")) {
				new Notice("That URL didn't return an image.");
				return;
			}
			const ext =
				IMAGE_TYPE_EXTENSIONS[type] ??
				/\.(png|jpe?g|gif|webp|avif|bmp)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase().replace("jpeg", "jpg");
			if (!ext) {
				new Notice("That URL didn't return an image.");
				return;
			}
			// Name the file after the URL's last path segment, cleaned for the file system.
			const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
			const stem =
				last
					.replace(/\.[a-z0-9]+$/i, "")
					.replace(/[^\w-]+/g, "-")
					.replace(/^-+|-+$/g, "")
					.slice(0, 40) || "background";
			const dest = await this.app.fileManager.getAvailablePathForAttachment(`${stem}.${ext}`, this.notePath);
			const file = await this.app.vault.createBinary(dest, res.arrayBuffer);
			new Notice(`Background saved to "${file.path}".`);
			this.onSaved(file.path);
			this.close();
		} catch {
			new Notice("Couldn't download that image — check the URL and your connection.");
		} finally {
			button.disabled = false;
			button.setText("Download");
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class FileSuggestModal extends SuggestModal<string> {
	private readonly plugin: SectionCardsPlugin;
	private readonly onChoose: (path: string) => void;

	constructor(app: App, plugin: SectionCardsPlugin, onChoose: (path: string) => void) {
		super(app);
		this.plugin = plugin;
		this.onChoose = onChoose;
		this.setPlaceholder("Recent note, or search the vault…");
		this.emptyStateText = "No matching note in the vault.";
		this.limit = 100;
	}

	/** Adds a path if it names a real markdown file that isn't already listed. */
	private addCandidate(out: string[], seen: Set<string>, path: string | null | undefined): void {
		if (!path) return;
		path = normalizePath(path);
		const normalized = path.endsWith(".md") ? path : `${path}.md`;
		if (seen.has(normalized)) return;
		if (!(this.app.vault.getAbstractFileByPath(normalized) instanceof TFile)) return;
		seen.add(normalized);
		out.push(normalized);
	}

	/**
	 * With no query, suggests only notes the plugin already knows about — the
	 * configured default, notes with a remembered cards view, recently opened
	 * notes. Once the user types, their query is resolved the way a wikilink
	 * would be, then fuzzy-matched against the vault's markdown files.
	 *
	 * Vault enumeration happens only here, only while the user is actively
	 * searching this picker, and only to fuzzy-match the query they typed;
	 * the file list is discarded as soon as the suggestions are computed.
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
		if (!needle) return typed.concat(known);

		const fuzzy = prepareFuzzySearch(q);
		const rest = this.app.vault
			.getMarkdownFiles()
			.map((file) => ({ path: file.path, match: seen.has(file.path) ? null : fuzzy(file.path) }))
			.filter((entry): entry is { path: string; match: SearchResult } => entry.match !== null)
			.sort((a, b) => b.match.score - a.match.score || a.path.localeCompare(b.path))
			.map((entry) => entry.path);

		return typed.concat(known.filter((path) => path.toLowerCase().includes(needle))).concat(rest);
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
				b.setButtonText("Switch to document order")
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

/** Calendar: a card was dropped on a day that already has one — merge them, or cancel. */
class MergeCardsModal extends Modal {
	private readonly fromTitle: string;
	private readonly intoTitle: string;
	private readonly onMerge: () => void | Promise<void>;

	constructor(app: App, fromTitle: string, intoTitle: string, onMerge: () => void | Promise<void>) {
		super(app);
		this.fromTitle = fromTitle;
		this.intoTitle = intoTitle;
		this.onMerge = onMerge;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Merge cards?" });
		contentEl.createEl("p", {
			text: `That day already has a card. Merge "${this.fromTitle || "(untitled)"}" into "${this.intoTitle || "(untitled)"}"? Its lines are added to the bottom, and its own card is removed.`,
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText("Merge cards")
					.setCta()
					.onClick(() => {
						this.close();
						void this.onMerge();
					});
				// Enter merges, Esc cancels.
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

/** The toolbar's ? button: every keyboard shortcut in one place. */
class ShortcutsModal extends Modal {
	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Keyboard shortcuts" });
		const rows: [string, string][] = [
			["1–6", "Show that heading level as cards"],
			["L", "Cycle the layouts"],
			["H", "Show or hide the hierarchy columns"],
			["D", "Show or hide the dividers"],
			[", / .", "Previous / next heading in the Hierarchy and Dividers view modes"],
			["S", "Show only starred lines / show everything"],
			["N", "New card"],
			[`${MOD_LABEL}+F`, "Jump to the filter box"],
			["Esc", "Clear the filter, or close a maximized card"],
			[`${MOD_LABEL}+Enter`, "Save the card being edited"],
		];
		const grid = contentEl.createDiv({ cls: "sfsc-shortcuts" });
		for (const [key, desc] of rows) {
			grid.createEl("kbd", { cls: "sfsc-shortcuts-key", text: key });
			grid.createDiv({ cls: "sfsc-shortcuts-desc", text: desc });
		}
		contentEl.createEl("p", {
			cls: "sfsc-shortcuts-note",
			text: "The plain keys work while a cards view is focused and no card editor is open.",
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Jump-to-date found no card for the picked date: offer to create one (Yes / No). */
class CreateDateCardModal extends Modal {
	private readonly title: string;
	private readonly onCreate: () => void | Promise<void>;

	constructor(app: App, title: string, onCreate: () => void | Promise<void>) {
		super(app);
		this.title = title;
		this.onCreate = onCreate;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "No card for that date" });
		contentEl.createEl("p", { text: `This note has no “${this.title}” card. Create it?` });

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("No").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText("Yes")
					.setCta()
					.onClick(() => {
						this.close();
						void this.onCreate();
					});
				// Enter creates the card, Esc cancels.
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

/** A one-line prompt for a note's own new-card heading-name format. */
class HeadingFormatModal extends Modal {
	private readonly initial: string;
	private readonly fallback: string;
	private readonly onSubmit: (value: string | null) => void;
	private input!: HTMLInputElement;

	constructor(app: App, initial: string, fallback: string, onSubmit: (value: string | null) => void) {
		super(app);
		this.initial = initial;
		this.fallback = fallback;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Heading name for new cards in this note" });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: `A moment date format, like YYYY-MM-DD, dddd. Leave it empty to use the default (${this.fallback}).`,
		});

		this.input = contentEl.createEl("input", {
			cls: "section-cards-format-input",
			attr: { type: "text", placeholder: this.fallback, spellcheck: "false" },
		});
		this.input.value = this.initial;
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submit();
			}
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Save").setCta().onClick(() => this.submit()));

		this.input.focus();
		this.input.select();
	}

	private submit(): void {
		const value = this.input.value.trim();
		this.close();
		this.onSubmit(value || null);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class QuickAddModal extends Modal {
	private readonly plugin: SectionCardsPlugin;
	private readonly title: string;
	private readonly onSubmit: (text: string, where: QuickAddPlacement) => void | Promise<void>;
	private editor: EmbeddedEditor | null = null;
	private box: HTMLTextAreaElement | null = null;

	constructor(
		plugin: SectionCardsPlugin,
		title: string,
		onSubmit: (text: string, where: QuickAddPlacement) => void | Promise<void>,
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.title = title;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("section-cards-quickadd-modal");
		contentEl.createEl("h3", { text: `Quick add to “${this.title}”` });

		// The same editor flavour cards edit with: the live-preview embed (or source),
		// falling back to the plain textarea when the setting says so or the internal
		// editor is unavailable. Ctrl/⌘+Enter submits with the default placement either
		// way; in the embed, Escape closes the modal like it cancels a card editor.
		const mode = this.plugin.settings.editorMode;
		if (mode !== "plain") {
			const host = contentEl.createDiv({ cls: "section-card-editor-embed section-cards-quickadd-editor" });
			this.editor = createEmbeddedEditor(this.plugin.app, host, {
				value: "",
				mode: mode === "source" ? "source" : "live",
				onSave: () => this.submit("bottom"),
				onCancel: () => this.close(),
				onChange: () => {},
			});
			if (!this.editor) host.remove();
		}
		if (!this.editor) {
			this.box = contentEl.createEl("textarea", { cls: "section-cards-quickadd-input" });
			this.box.setAttr("placeholder", "- [ ] A task, a note, any markdown…");
			this.box.rows = 4;
			// Enter makes a new line; Ctrl/⌘+Enter submits with the default placement.
			this.box.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
					e.preventDefault();
					this.submit("bottom");
				}
			});
		}

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Add to top").onClick(() => this.submit("top")))
			.addButton((b) => b.setButtonText("Add to bottom").setCta().onClick(() => this.submit("bottom")));

		if (this.editor) this.editor.focusEnd();
		else this.box?.focus();
	}

	private submit(where: QuickAddPlacement): void {
		const text = (this.editor ? this.editor.value : (this.box?.value ?? "")).replace(/\s+$/, "");
		if (!text.trim()) {
			new Notice("Type something to add.");
			return;
		}
		this.close();
		void this.onSubmit(text, where);
	}

	onClose(): void {
		this.editor?.destroy();
		this.editor = null;
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
				control: {
					type: "file",
					key: "filePath",
					placeholder: "Daily Notes 2026.md",
					filter: (file: TFile) => file.extension === "md",
				},
			},
			{
				name: "Reopen remembered notes as cards",
				control: { type: "toggle", key: "autoOpenCards" },
			},
			{
				type: "group",
				heading: "What becomes a card",
				items: [
					{
						name: "Heading level",
						control: {
							type: "dropdown",
							key: "headingLevel",
							options: { "1": "Heading 1", "2": "Heading 2", "3": "Heading 3", "4": "Heading 4", "5": "Heading 5", "6": "Heading 6" },
						},
					},
					{
						name: "Only list heading levels the note contains",
						control: { type: "toggle", key: "dynamicLevelOptions" },
					},
					{
						name: "Show unfiled text as a card",
						desc: "Text at the top of the note — above the first heading, below any properties — becomes its own card, so it can be read, edited, and ticked like any section.",
						control: { type: "toggle", key: "unfiledEnabled" },
					},
					{
						name: "Unfiled card title",
						desc: "Title shown on that card. Display-only: it is never written into the note.",
						control: { type: "text", key: "unfiledTitle", placeholder: "_Unfiled_" },
					},
				],
			},
			{
				type: "group",
				heading: "View",
				items: [
					{
						name: "Default layout",
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
						name: "Card text size",
						desc: "Scale the text on cards — titles, bodies, and card editors — relative to your theme's sizes.",
						control: {
							type: "slider",
							key: "fontScale",
							min: 70,
							max: 150,
							step: 5,
							displayFormat: (value: number) => `${value}%`,
						},
					},
					{
						name: "Divider text size",
						desc: "Scale only the text on the divider bars (View mode → Dividers), independent of the card text size.",
						control: {
							type: "slider",
							key: "dividerFontScale",
							min: 70,
							max: 200,
							step: 5,
							displayFormat: (value: number) => `${value}%`,
						},
					},
					{
						name: "Date detection format",
						desc: 'Extra pattern that marks a heading as a date: a moment format, with optional * wildcards standing for text before/after the date — "*MMMM D, YYYY*" finds one anywhere in a title. Empty uses only the built-in detection (an ISO date anywhere; the heading-name format at the title\'s start).',
						control: { type: "text", key: "dateDetectFormat", placeholder: "*MMMM D, YYYY*" },
					},
					{
						name: "Start the week on",
						desc: "First day of the Calendar layout's weeks.",
						control: {
							type: "dropdown",
							key: "weekStart",
							options: { locale: "Language default", sunday: "Sunday", monday: "Monday" },
						},
					},
					{
						name: "Toolbar",
						desc: "Compact fits one line: icons for the view modes, no control labels, a shorter note button. Also switchable by right-clicking the toolbar.",
						control: {
							type: "dropdown",
							key: "toolbarStyle",
							options: { full: "Full", compact: "Compact" },
						},
					},
					{
						name: "Jump to today's card",
						desc: "When a note opens in the cards view, scroll to the card whose heading is today's date. Needs the note's Dates checkbox (in the toolbar) to be on.",
						control: { type: "toggle", key: "jumpToToday" },
					},
					{
						name: "Keep pinned cards on screen",
						desc: "Pinned cards stick just below the toolbar — or beside the cards in the Vertical layout — while the rest scroll. Doesn't apply to the Custom Grid canvas.",
						control: { type: "toggle", key: "stickyPinned" },
					},
				],
			},
			{
				type: "group",
				heading: "Card colors",
				items: [
					{
						name: "Palette preset",
						render: (setting: Setting) => this.renderPresetRow(setting),
					},
					...CARD_COLORS.map(
						(_, i): SettingDefinition => ({
							name: `Color ${i + 1}`,
							render: (setting: Setting) => this.renderColorRow(setting, i),
						}),
					),
				],
			},
			{
				type: "group",
				heading: "Editing",
				items: [
					{
						name: "Clicking a card's title bar",
						control: {
							type: "dropdown",
							key: "titleBarClick",
							options: { maximize: "Makes the card big", edit: "Edits the card" },
						},
					},
					{
						name: "Card editor",
						control: {
							type: "dropdown",
							key: "editorMode",
							options: { live: "Live preview", source: "Source mode", plain: "Plain text box" },
						},
					},
					{
						name: "Autosave open card editors",
						desc: "While a card is being edited, write its content to the note every few minutes — and when the view closes — so an edit left open isn't lost.",
						control: { type: "toggle", key: "autosaveEnabled" },
					},
					{
						name: "Autosave interval",
						desc: "Minutes between autosaves while a card editor is open. Applies to editors opened after the change.",
						control: {
							type: "slider",
							key: "autosaveMinutes",
							min: 1,
							max: 30,
							step: 1,
							displayFormat: (value: number) => `${value} min`,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Tasks",
				items: [
					{
						name: "Toggle tasks with the Tasks plugin",
						desc: "When the Tasks community plugin is enabled, ticking a checkbox uses its toggle, so recurring tasks spawn their next occurrence and done dates follow its settings. When off (or Tasks is absent), this plugin's own toggle and the settings below apply.",
						control: { type: "toggle", key: "tasksToggle" },
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
						name: "Show open-task counts in Hierarchy columns",
						control: { type: "toggle", key: "hierTaskCounts" },
					},
				],
			},
			{
				type: "group",
				heading: "Starred lines",
				items: [
					{
						name: "Star emoji",
						desc: "Right-click a line on a card → Add star writes this at its start; the toolbar's star button then shows only starred lines. Stored in the note as plain text, so changing it here doesn't re-mark lines starred with the old emoji.",
						control: { type: "text", key: "starEmoji", placeholder: "⭐" },
					},
				],
			},
			{
				type: "group",
				heading: "New cards",
				items: [
					{
						name: "Default heading name",
						desc: 'Moment.js date format used to pre-fill "New card". Default: YYYY-MM-DD, dddd. Any note can set its own from the toolbar\'s new-card options menu.',
						control: { type: "text", key: "newCardFormat", placeholder: "YYYY-MM-DD, dddd" },
					},
					{
						name: "Default placement",
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

	/** The preset dropdown is an action, not a stored value: picking one rewrites the
	 * whole palette, then the tab re-renders so the nine rows show the new colors. */
	private renderPresetRow(setting: Setting): void {
		// A render callback is the tab being built (the declarative API bypasses
		// display()), so tag the tab for the tighter-row CSS here.
		this.containerEl.addClass("sfsc-settings");
		setting.addDropdown((dropdown) => {
			dropdown.addOption("", "Choose a preset…");
			for (const preset of PALETTE_PRESETS) dropdown.addOption(preset.name, preset.name);
			dropdown.setValue("");
			dropdown.onChange(async (name) => {
				const preset = PALETTE_PRESETS.find((p) => p.name === name);
				if (!preset) return;
				await this.plugin.applyPalettePreset(preset.colors);
				this.update();
			});
		});
	}

	private renderColorRow(setting: Setting, index: number): void {
		// The nine rows read as one block; CSS tightens their vertical padding.
		setting.settingEl.addClass("sfsc-color-row");
		const entry = this.plugin.palette()[index];
		setting.addColorPicker((picker) =>
			picker.setValue(entry.hex).onChange((hex) => void this.plugin.setPaletteColor(index, { hex })),
		);
		setting.addText((text) =>
			text
				.setPlaceholder(CARD_COLORS[index][1])
				.setValue(entry.label)
				.onChange((label) => void this.plugin.setPaletteColor(index, { label })),
		);
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
		if (key === "unfiledTitle") {
			const text = typeof value === "string" ? value.trim() : "";
			await super.setControlValue(key, text || DEFAULT_SETTINGS.unfiledTitle);
			this.plugin.refreshAllViews();
			return;
		}
		await super.setControlValue(key, value);
		if (key === "strikeNestedUnderDone") this.plugin.applyBodyClasses();
		if (key === "toolbarStyle") this.plugin.applyToolbarStyle();
		if (key === "fontScale" || key === "dividerFontScale") this.plugin.applyFontScale();
		if (
			key === "titleBarClick" ||
			key === "stickyPinned" ||
			key === "unfiledEnabled" ||
			key === "hierTaskCounts" ||
			key === "dynamicLevelOptions" ||
			key === "starEmoji" ||
			key === "weekStart" ||
			key === "dateDetectFormat"
		) {
			this.plugin.refreshAllViews();
		}
	}
}

export default class SectionCardsPlugin extends Plugin {
	settings: SectionCardsSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		addIcon(DECK_ICON, DECK_SVG);

		this.registerView(VIEW_TYPE_SECTION_CARDS, (leaf) => new SectionCardsView(leaf, this));

		this.addRibbonIcon(DECK_ICON, "Single File Section Cards (new tab)", () => {
			// Every click opens its own tab, even when one already shows the note.
			void this.openCardsView(undefined, undefined, "new");
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
					const view = leaf.view;
					if (!(view instanceof SectionCardsView)) continue; // deferred placeholder
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
					const view = leaf.view;
					if (view instanceof SectionCardsView && view.filePath === oldPath) view.filePath = file.path;
				}
			}),
		);

		// With the setting on, a note that has a remembered cards view opens as cards:
		// the markdown leaf that just opened it is swapped to this plugin's view. The
		// swap is deferred a tick — replacing the view from inside file-open re-enters
		// the workspace mid-open. revealSection sets skipAutoOpen so the ↗ button's
		// deliberate trip to the editor isn't hijacked straight back.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!file || file.extension !== "md" || !this.settings.autoOpenCards) return;
				const skip = this.skipAutoOpen;
				if (skip && skip.path === file.path && Date.now() < skip.until) {
					this.skipAutoOpen = null;
					return;
				}
				if (!this.getStoredView(file.path)) return;
				// The markdown leaf that just opened the file. Focus may still sit in the
				// file explorer or quick switcher, so the active view can't be relied on:
				// prefer it, else fall back to the one markdown leaf showing this file.
				// (Several showing it is ambiguous — a deliberate split stays untouched.)
				const active = this.app.workspace.getActiveViewOfType(MarkdownView);
				let leaf = active?.file?.path === file.path ? active.leaf : null;
				if (!leaf) {
					const showing = this.app.workspace
						.getLeavesOfType("markdown")
						.filter((l) => l.view instanceof MarkdownView && l.view.file?.path === file.path);
					if (showing.length === 1) leaf = showing[0];
				}
				if (!leaf) return;
				const target = leaf;
				window.setTimeout(() => {
					const v = target.view;
					if (!(v instanceof MarkdownView) || v.file?.path !== file.path) return;
					void target.setViewState({
						type: VIEW_TYPE_SECTION_CARDS,
						active: true,
						state: { filePath: file.path },
					});
				}, 0);
			}),
		);

		this.addSettingTab(new SectionCardsSettingTab(this.app, this));
		this.applyBodyClasses();
		this.applyPaletteCss();
		this.applyFontScale();
	}

	onunload(): void {
		document.body.removeClass("sfsc-no-nested-strike");
		for (const [name] of CARD_COLORS) {
			document.body.style.removeProperty(`--sfsc-color-${name}`);
			document.body.style.removeProperty(`--sfsc-color-${name}-fg`);
			document.body.style.removeProperty(`--sfsc-color-${name}-fg-light`);
		}
		document.body.style.removeProperty("--sfsc-font-scale");
		document.body.style.removeProperty("--sfsc-divider-font-scale");
	}

	/** Global styling switches live as body classes so every cards view picks them up. */
	applyBodyClasses(): void {
		document.body.toggleClass("sfsc-no-nested-strike", !this.settings.strikeNestedUnderDone);
	}

	/** The nine palette slots as configured, saved entries over the defaults. */
	palette(): PaletteColor[] {
		return normalizePalette(this.settings.palette);
	}

	/** Jump to this plugin's settings tab (app.setting isn't in the public typings). */
	openSettingsTab(): void {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		if (!setting) return;
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	/** Update one slot's label and/or color, then restyle every colored card via CSS. */
	async setPaletteColor(index: number, patch: Partial<PaletteColor>): Promise<void> {
		const palette = this.palette();
		if (!palette[index]) return;
		palette[index] = { ...palette[index], ...patch };
		this.settings.palette = palette;
		await this.saveSettings();
		this.applyPaletteCss();
	}

	async applyPalettePreset(colors: PaletteColor[]): Promise<void> {
		this.settings.palette = normalizePalette(colors);
		await this.saveSettings();
		this.applyPaletteCss();
	}

	/**
	 * Colors reach the cards as body-level CSS variables the swatch rules read, so a
	 * settings change restyles every card, tray tile, and menu swatch without a refresh.
	 */
	applyPaletteCss(): void {
		const palette = this.palette();
		CARD_COLORS.forEach(([name, , fallbackHex], i) => {
			const hex = hexToTriplet(palette[i].hex) ? palette[i].hex : fallbackHex;
			const triplet = hexToTriplet(hex);
			if (!triplet) return;
			document.body.style.setProperty(`--sfsc-color-${name}`, triplet);
			// Solid-color title bars flip their text black or white to stay readable —
			// computed per theme (dark themes bias to white, light themes to dark); the
			// CSS picks whichever matches the active theme.
			document.body.style.setProperty(`--sfsc-color-${name}-fg`, contrastForeground(hex));
			document.body.style.setProperty(`--sfsc-color-${name}-fg-light`, contrastForegroundLight(hex));
		});
	}

	/** Card and divider text sizes multiply by these body-level variables, so the
	 * sliders resize every open view — cards, editors, divider bars — without a refresh. */
	applyFontScale(): void {
		const toScale = (percent: number) => (Number.isFinite(percent) && percent > 0 ? percent / 100 : 1);
		document.body.style.setProperty("--sfsc-font-scale", String(toScale(this.settings.fontScale)));
		document.body.style.setProperty(
			"--sfsc-divider-font-scale",
			String(toScale(this.settings.dividerFontScale)),
		);
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

	/** The Tasks community plugin's public API, when that plugin is installed and enabled. */
	tasksApi(): TasksApiV1 | null {
		const withPlugins = this.app as unknown as {
			plugins?: { plugins?: Record<string, { apiV1?: TasksApiV1 }> };
		};
		return withPlugins.plugins?.plugins?.["obsidian-tasks-plugin"]?.apiV1 ?? null;
	}

	/** The unfiled card's title, or null when the feature is off. */
	unfiledTitle(): string | null {
		return this.settings.unfiledEnabled ? this.settings.unfiledTitle || DEFAULT_SETTINGS.unfiledTitle : null;
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
			current.sortOrder === view.sortOrder &&
			(current.hierarchy ?? false) === (view.hierarchy ?? false) &&
			(current.sections ?? false) === (view.sections ?? false) &&
			(current.starredOnly ?? false) === (view.starredOnly ?? false)
		) {
			return;
		}
		// Everything else stored per note (placements, zoom, pins) rides along; changing
		// the view must not drop it.
		this.settings.perFile[path] = { ...current, ...view };
		await this.saveSettings();
	}

	getPinned(path: string): string[] {
		return this.settings.perFile?.[path]?.pinned ?? [];
	}

	/** Pin or unpin a heading for a note; every open view re-renders with the new order. */
	async togglePin(path: string, headingRaw: string, base: ViewSettings): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		const pinned = current.pinned ?? [];
		const at = pinned.indexOf(headingRaw);
		if (at >= 0) pinned.splice(at, 1);
		else pinned.push(headingRaw);
		current.pinned = pinned;
		this.settings.perFile[path] = current;
		await this.saveSettings();
		this.refreshAllViews();
	}

	/**
	 * A card's heading line was rewritten (Calendar day move): pins, colors, and Custom
	 * Grid placements are keyed by the heading line, so carry them to the new key.
	 */
	async renameCardKey(path: string, oldRaw: string, newRaw: string): Promise<void> {
		const entry = this.settings.perFile?.[path];
		if (!entry || oldRaw === newRaw) return;
		let changed = false;
		const at = entry.pinned?.indexOf(oldRaw) ?? -1;
		if (entry.pinned && at >= 0) {
			entry.pinned[at] = newRaw;
			changed = true;
		}
		if (entry.colors?.[oldRaw]) {
			entry.colors[newRaw] = entry.colors[oldRaw];
			delete entry.colors[oldRaw];
			changed = true;
		}
		if (entry.customGrid?.[oldRaw]) {
			entry.customGrid[newRaw] = entry.customGrid[oldRaw];
			delete entry.customGrid[oldRaw];
			changed = true;
		}
		if (changed) await this.saveSettings();
	}

	/** The per-note "headings are dates" choice; undefined = the user hasn't set it. */
	getContainsDates(path: string): boolean | undefined {
		return this.settings.perFile?.[path]?.containsDates;
	}

	async setContainsDates(path: string, value: boolean, base: ViewSettings): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		current.containsDates = value;
		this.settings.perFile[path] = current;
		await this.saveSettings();
		this.refreshAllViews();
	}

	/** Vault path of a note's background image, or null when it has none. */
	getBackgroundImage(path: string): string | null {
		return this.settings.perFile?.[path]?.backgroundImage ?? null;
	}

	async setBackgroundImage(path: string, imagePath: string | null, base: ViewSettings): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		if (imagePath) current.backgroundImage = imagePath;
		else delete current.backgroundImage;
		this.settings.perFile[path] = current;
		await this.saveSettings();
		this.refreshAllViews();
	}

	/** How faded a note's background image is, 0 (fully visible) to 100 (invisible). */
	getBackgroundDim(path: string): number {
		return this.getBackgroundDimOverride(path) ?? BACKGROUND_DIM_DEFAULT;
	}

	/** The note's own stored veil strength, or null when it follows the default —
	 * which styles.css owns, so a Style Settings override can supply it. */
	getBackgroundDimOverride(path: string): number | null {
		return this.settings.perFile?.[path]?.backgroundDim ?? null;
	}

	async setBackgroundDim(path: string, value: number, base: ViewSettings): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		if (value === BACKGROUND_DIM_DEFAULT) delete current.backgroundDim;
		else current.backgroundDim = value;
		this.settings.perFile[path] = current;
		await this.saveSettings();
		this.refreshAllViews();
	}

	/** Background image brightness and saturation, in percent (100 = untouched). */
	getBackgroundAdjust(path: string): { brightness: number; saturation: number } {
		const entry = this.settings.perFile?.[path];
		return { brightness: entry?.backgroundBrightness ?? 100, saturation: entry?.backgroundSaturation ?? 100 };
	}

	async setBackgroundAdjust(
		path: string,
		patch: { brightness?: number; saturation?: number },
		base: ViewSettings,
	): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		if (patch.brightness !== undefined) {
			if (patch.brightness === 100) delete current.backgroundBrightness;
			else current.backgroundBrightness = patch.brightness;
		}
		if (patch.saturation !== undefined) {
			if (patch.saturation === 100) delete current.backgroundSaturation;
			else current.backgroundSaturation = patch.saturation;
		}
		this.settings.perFile[path] = current;
		await this.saveSettings();
		this.refreshAllViews();
	}

	getCardColors(path: string): Record<string, string> {
		return this.settings.perFile?.[path]?.colors ?? {};
	}

	/** Set or clear (null) a card's color. Like pins, colors are keyed to the heading line. */
	async setCardColor(path: string, headingRaw: string, color: string | null, base: ViewSettings): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		const colors = current.colors ?? {};
		if (color) colors[headingRaw] = color;
		else delete colors[headingRaw];
		if (Object.keys(colors).length) current.colors = colors;
		else delete current.colors;
		this.settings.perFile[path] = current;
		await this.saveSettings();
		this.refreshAllViews();
	}

	/** A note's own heading-name format, or null when it uses the global default. */
	getNewCardFormatOverride(path: string): string | null {
		return this.settings.perFile?.[path]?.newCardFormat ?? null;
	}

	/** The heading-name format for new cards in a note: its own, or the global default. */
	getNewCardFormat(path: string): string {
		return this.getNewCardFormatOverride(path) || this.settings.newCardFormat;
	}

	/** Set or clear (null) a note's own heading-name format for new cards. */
	async setNewCardFormat(path: string, format: string | null, base: ViewSettings): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		if (format?.trim()) current.newCardFormat = format.trim();
		else delete current.newCardFormat;
		this.settings.perFile[path] = current;
		await this.saveSettings();
		// Today's highlight and date detection key off the format, so re-render.
		this.refreshAllViews();
	}

	getTemplatePath(path: string): string | null {
		return this.settings.perFile?.[path]?.templatePath ?? null;
	}

	/** Set or clear (null) the note whose contents pre-fill new cards made for this note. */
	async setTemplatePath(path: string, templatePath: string | null, base: ViewSettings): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		if (templatePath) current.templatePath = templatePath;
		else delete current.templatePath;
		this.settings.perFile[path] = current;
		await this.saveSettings();
	}

	/** The note's new-card template, read with {{placeholders}} filled in. Null = none set. */
	async loadTemplateBody(notePath: string, title: string): Promise<string | null> {
		const templatePath = this.getTemplatePath(notePath);
		if (!templatePath) return null;
		let template = this.app.vault.getAbstractFileByPath(templatePath);
		if (!(template instanceof TFile)) {
			template = this.app.metadataCache.getFirstLinkpathDest(templatePath.replace(/\.md$/, ""), "");
		}
		if (!(template instanceof TFile)) {
			new Notice(`Template "${templatePath}" not found — created the card empty.`);
			return null;
		}
		const raw = await this.app.vault.cachedRead(template);
		return applyTemplatePlaceholders(raw, title, this.getNewCardFormat(notePath));
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
	/** Rebuild every open view's toolbar after a style change — no data refresh needed. */
	applyToolbarStyle(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)) {
			if (leaf.view instanceof SectionCardsView) leaf.view.rebuildToolbar();
		}
	}

	refreshAllViews(): void {
		// A background tab can hold a deferred placeholder, not the real view (Obsidian
		// 1.7+). Calling into it throws — which used to abort this loop before the
		// remaining views (the active one included) got their refresh, so a pin click
		// looked dead until something else rebuilt the view. A deferred tab needs no
		// refresh anyway: it renders fresh from settings when it loads.
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)) {
			if (leaf.view instanceof SectionCardsView) void leaf.view.refresh();
		}
	}

	/** The one note whose next markdown open must NOT be swapped back to cards (the ↗
	 * button's deliberate editor trip); time-boxed so a stale flag can't linger. */
	private skipAutoOpen: { path: string; until: number } | null = null;

	/** Open the note in an editor with the cursor parked on the given heading line. */
	async revealSection(file: TFile, line: number): Promise<void> {
		this.skipAutoOpen = { path: file.path, until: Date.now() + 2000 };
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

	/** The configured star emoji, falling back to the default when the setting is blank. */
	starEmoji(): string {
		return this.settings.starEmoji?.trim() || DEFAULT_SETTINGS.starEmoji;
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<SectionCardsSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
		// "Headings contain" used to be a global setting; it's the per-note Dates checkbox now.
		delete (this.settings as unknown as Record<string, unknown>)["headingType"];
		// Hierarchy briefly shipped as a layout; it's the toolbar columns toggle now.
		if ((this.settings.layout as string) === "hierarchy") this.settings.layout = "grid";
		// Sections did too; it's the toolbar dividers toggle now.
		if ((this.settings.layout as string) === "sections") this.settings.layout = "grid";
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
