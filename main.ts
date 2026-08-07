import {
	App,
	Component,
	FuzzySuggestModal,
	addIcon,
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	debounce,
	moment,
} from "obsidian";

export const VIEW_TYPE_SECTION_CARDS = "section-cards-view";

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
export type Layout = "grid" | "aligned" | "tight" | "horizontal" | "vertical";

/** [value, toolbar label, tooltip] */
const LAYOUT_OPTIONS: [Layout, string, string][] = [
	["grid", "Grid", "Masonry columns"],
	["aligned", "Grid Aligned", "Uniform grid: every row starts at the same height"],
	["tight", "Tight", "Denser, narrower masonry columns"],
	["horizontal", "Horizontal", "One card per row, full width"],
	["vertical", "Vertical", "Full-height cards side by side, scrolling sideways"],
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
	titleBarClick: TitleBarClick;
	layout: Layout;
	/** Remembered view per note, keyed by vault path. Lives here, never in the note. */
	perFile: Record<string, ViewSettings>;
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

	for (let s = 0; s < starts.length; s++) {
		const start = starts[s];
		const nextStart = s + 1 < starts.length ? starts[s + 1].line : lines.length;
		const nextCloser = closers.find((c) => c > start.line);
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
	if (parseSections(lines, preferred).length > 0) return preferred;

	let best = preferred;
	let bestCount = 0;
	for (let level = 1; level <= 6; level++) {
		const count = parseSections(lines, level).length;
		if (count > bestCount) {
			best = level;
			bestCount = count;
		}
	}
	return bestCount > 0 ? best : preferred;
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
	private renderScope: Component | null = null;
	/** Heading raw text of the card currently open in an editor, so refreshes don't nuke it. */
	private editingKey: string | null = null;
	/** Watches cards for height changes (async markdown, images, embeds) to re-pack them. */
	private cardObserver: ResizeObserver | null = null;
	private repack = debounce(() => {
		this.layoutMasonry();
		this.insertRowRules();
	}, 60, true);
	/** The card currently blown up over the others, if any. */
	private maximized: {
		card: HTMLElement;
		body: HTMLElement;
		button: HTMLElement;
		overlay: HTMLElement;
		marker: Comment;
		bodyMaxHeight: string;
	} | null = null;
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
		this.gridEl = this.contentEl.createDiv({ cls: "section-cards-grid" });
		this.registerWheelPan();
		this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Escape" || !this.maximized) return;
			// A card editor's own Escape handling wins.
			if ((evt.target as HTMLElement | null)?.tagName === "TEXTAREA") return;
			evt.preventDefault();
			this.closeMaximized();
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
		for (const name of ["grid", "aligned", "tight", "horizontal", "vertical"]) {
			this.contentEl.toggleClass(`is-layout-${name}`, this.layout === name);
		}
	}

	async onClose(): Promise<void> {
		this.clearRenderScope();
		this.cardObserver?.disconnect();
		this.cardObserver = null;
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
		if (this.layout === "vertical" || this.layout === "aligned") {
			for (const card of Array.from(grid.children) as HTMLElement[]) card.style.gridRowEnd = "";
			return;
		}

		const style = window.getComputedStyle(grid);
		const rowHeight = parseFloat(style.gridAutoRows) || 4;
		const gap = parseFloat(style.rowGap) || 0;
		const cardGap = parseFloat(style.getPropertyValue("--sc-card-gap")) || 12;

		for (const card of Array.from(grid.children) as HTMLElement[]) {
			if (!card.hasClass("section-card")) continue;
			// Cards are `align-items: start` grid items, so their box height is their
			// content height regardless of the span currently assigned.
			const height = card.getBoundingClientRect().height;
			const span = Math.max(1, Math.ceil((height + cardGap) / (rowHeight + gap)));
			card.style.gridRowEnd = `span ${span}`;
		}
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
			const rule = document.createElement("div");
			rule.className = "section-cards-row-rule";
			grid.insertBefore(rule, cards[i]);
		}
	}

	private observeCards(): void {
		this.cardObserver?.disconnect();
		if (!this.gridEl) return;

		if (typeof ResizeObserver === "undefined") return;
		this.cardObserver = new ResizeObserver(() => this.repack());
		for (const card of Array.from(this.gridEl.children)) {
			if ((card as HTMLElement).hasClass("section-card")) this.cardObserver.observe(card);
		}
		// The grid itself changes width when the pane resizes, which changes column count.
		this.cardObserver.observe(this.gridEl);
	}

	private clearRenderScope() {
		if (this.renderScope) {
			this.removeChild(this.renderScope);
			this.renderScope = null;
		}
	}

	private buildToolbar() {
		const bar = this.toolbarEl;
		if (!bar) return;
		bar.empty();

		const fileBtn = bar.createEl("button", { cls: "section-cards-file-btn" });
		fileBtn.setAttr("aria-label", "Pick a different note");
		fileBtn.createSpan({ text: this.filePath || "(no file)" });
		fileBtn.addEventListener("click", () => {
			new FileSuggestModal(this.app, async (file) => {
				this.filePath = file.path;
				this.applyStoredView();
				await this.syncView();
				this.app.workspace.requestSaveLayout();
			}).open();
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
		levelSelect.addEventListener("change", async () => {
			this.headingLevel = Number(levelSelect.value);
			this.rememberView();
			await this.refresh();
			this.app.workspace.requestSaveLayout();
		});

		const layoutWrap = bar.createDiv({ cls: "section-cards-control" });
		layoutWrap.createSpan({ text: "Layout", cls: "section-cards-label" });
		const layoutSelect = layoutWrap.createEl("select", { cls: "dropdown" });
		for (const [value, label, hint] of LAYOUT_OPTIONS) {
			const option = layoutSelect.createEl("option", { text: label, value });
			option.title = hint;
		}
		layoutSelect.value = this.layout;
		layoutSelect.addEventListener("change", async () => {
			this.layout = layoutSelect.value as Layout;
			this.rememberView();
			this.applyLayoutClass();
			await this.refresh();
			this.app.workspace.requestSaveLayout();
		});

		const sortWrap = bar.createDiv({ cls: "section-cards-control" });
		sortWrap.createSpan({ text: "Sort", cls: "section-cards-label" });
		const sortSelect = sortWrap.createEl("select", { cls: "dropdown" });
		sortSelect.createEl("option", { text: "A → Z", value: "asc" });
		sortSelect.createEl("option", { text: "Z → A", value: "desc" });
		sortSelect.createEl("option", { text: "Document order", value: "doc" });
		sortSelect.value = this.sortOrder;
		sortSelect.addEventListener("change", async () => {
			this.sortOrder = sortSelect.value as SortOrder;
			this.rememberView();
			await this.refresh();
			this.app.workspace.requestSaveLayout();
		});

		const newBtn = bar.createEl("button", { cls: "section-cards-new-btn mod-cta", text: "+ New card" });
		newBtn.setAttr("aria-label", "Create a new section in this note");
		newBtn.addEventListener("click", () => this.promptNewCard());

		const refreshBtn = bar.createEl("button", { cls: "section-cards-icon-btn", text: "↻" });
		refreshBtn.setAttr("aria-label", "Reload from file");
		refreshBtn.addEventListener("click", () => this.refresh());
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
			async (typed, placement) => {
				const headingRaw = normalizeHeading(typed, this.headingLevel);
				const { level, duplicate } = await insertSection(this.app, file, headingRaw, placement);

				if (duplicate) {
					new Notice(`Heading already existed in ${file.basename} — added a second one.`);
				}
				if (level !== this.headingLevel) {
					new Notice(`Created an H${level} section; this view is showing H${this.headingLevel}.`);
				}

				// Open the new card's editor once it has been re-rendered.
				this.pendingEditHeading = headingRaw;
				await this.refresh();
			},
		).open();
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
		const file = this.getFile();
		this.gridEl.empty();
		this.clearRenderScope();
		this.cardObserver?.disconnect();
		this.editingKey = null;

		if (!file) {
			this.countEl?.setText("");
			const empty = this.gridEl.createDiv({ cls: "section-cards-empty" });
			empty.createEl("p", { text: `Can't find "${this.filePath}".` });
			empty.createEl("p", { text: "Pick a note from the toolbar, or set a default in the plugin settings." });
			return;
		}

		this.filePath = file.path;
		const content = await this.app.vault.cachedRead(file);
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
			const empty = this.gridEl.createDiv({ cls: "section-cards-empty" });
			empty.createEl("p", { text: `No level-${this.headingLevel} headings in ${file.basename}.` });
			empty.createEl("p", { text: "Try a different heading level in the toolbar." });
			return;
		}

		const scope = new Component();
		this.addChild(scope);
		this.renderScope = scope;

		const renders: Promise<void>[] = [];
		this.cardsByHeading.clear();
		for (const section of ordered) {
			this.renderCard(this.gridEl, file, section, scope, renders);
		}

		// Pack once with what's laid out, again once the async markdown has landed.
		this.layoutMasonry();
		await Promise.all(renders);

		// Rendered task checkboxes can come back disabled, and disabled inputs never fire
		// click events — enable them so they can be ticked straight from the card.
		for (const box of Array.from(
			this.gridEl.querySelectorAll<HTMLInputElement>(".section-card-body input[type=checkbox]"),
		)) {
			box.removeAttribute("disabled");
			box.removeAttribute("readonly");
		}

		this.layoutMasonry();
		this.insertRowRules();
		this.observeCards();

		if (this.pendingEditHeading) {
			const target = this.cardsByHeading.get(this.pendingEditHeading);
			this.pendingEditHeading = null;
			if (target) {
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

	private renderCard(
		parent: HTMLElement,
		file: TFile,
		section: Section,
		scope: Component,
		renders: Promise<void>[],
	) {
		const card = parent.createDiv({ cls: "section-card" });
		this.cardsByHeading.set(section.headingRaw, { el: card, section });

		if (this.plugin.settings.headingType === "dates") {
			const today = mo();
			if (isTodayTitle(section.title, today.format("YYYY-MM-DD"), today.format(this.plugin.settings.newCardFormat))) {
				card.addClass("is-today");
			}
		}

		const header = card.createDiv({ cls: "section-card-header" });
		const titleClick = this.plugin.settings.titleBarClick;
		header.addClass(titleClick === "maximize" ? "is-click-big" : "is-click-edit");
		header.createDiv({ cls: "section-card-title", text: section.title || "(untitled)" });

		// The title bar's own action. "edit" falls through to the card handler below.
		if (titleClick === "maximize") {
			header.addEventListener("click", (evt) => {
				if ((evt.target as HTMLElement | null)?.closest("button")) return;
				evt.stopPropagation();
				this.toggleMaximized(card);
			});
		}

		const bigBtn = header.createEl("button", { cls: "section-card-big", text: "⤢" });
		bigBtn.setAttr("aria-label", "Make this card big");
		bigBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.toggleMaximized(card);
		});

		const openBtn = header.createEl("button", { cls: "section-card-open", text: "↗" });
		openBtn.setAttr("aria-label", "Open this section in the note");
		openBtn.addEventListener("click", async (evt) => {
			evt.stopPropagation();
			await this.plugin.revealSection(file, section.headingLine);
		});

		// markdown-rendered lets Obsidian's own reading-view CSS style lists, tasks, tags, etc.
		const bodyEl = card.createDiv({ cls: "section-card-body markdown-rendered" });
		// Vertical cards fill their column, so the cap would fight the layout.
		if (this.layout !== "vertical") {
			const cap = this.plugin.settings.cardMaxHeight;
			bodyEl.style.maxHeight = `${this.layout === "tight" ? Math.min(cap, 190) : cap}px`;
		}

		if (section.body.trim()) {
			renders.push(MarkdownRenderer.render(this.app, section.body, bodyEl, file.path, scope));
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
			void this.plugin.openCardsView(target.path, subpath);
		});

		// Checkbox clicks toggle the task in the file instead of opening the editor.
		bodyEl.addEventListener("click", (evt) => {
			const box = (evt.target as HTMLElement).closest<HTMLInputElement>("input[type=checkbox]");
			if (!box || card.hasClass("is-editing")) return;
			evt.stopPropagation();
			evt.preventDefault();
			void this.toggleTask(card, file, section, bodyEl, box);
		});

		card.addEventListener("click", (evt) => {
			const target = evt.target as HTMLElement;
			// Let links and internal-link clicks behave normally.
			if (target.closest("a")) return;
			if (target.closest("input[type=checkbox]")) return;
			if (card.hasClass("is-editing")) return;
			this.startEditing(card, file, section);
		});
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
		overlay.addEventListener("click", (evt) => {
			if (evt.target === overlay) this.closeMaximized();
		});

		this.maximized = { card, body, button, overlay, marker, bodyMaxHeight: body.style.maxHeight };

		// Scrolling is locked while blown up, so the overlay's inset covers the visible tab.
		this.contentEl.addClass("has-maximized-card");
		const caret = captureCaret(card);
		overlay.appendChild(card);
		card.addClass("is-maximized");
		body.style.maxHeight = "";
		button.setText("⤡");
		button.setAttr("aria-label", "Shrink this card");
		restoreCaret(caret);
	}

	private closeMaximized(): void {
		const open = this.maximized;
		if (!open) return;
		this.maximized = null;

		open.card.removeClass("is-maximized");
		open.body.style.maxHeight = open.bodyMaxHeight;
		open.button.setText("⤢");
		open.button.setAttr("aria-label", "Make this card big");

		const caret = captureCaret(open.card);
		open.marker.parentElement?.insertBefore(open.card, open.marker);
		open.marker.remove();
		open.overlay.remove();
		this.contentEl.removeClass("has-maximized-card");
		restoreCaret(caret);

		this.layoutMasonry();
		this.insertRowRules();
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
		this.editingKey = section.headingRaw;

		const bodyEl = card.querySelector(".section-card-body") as HTMLElement | null;
		if (!bodyEl) return;
		bodyEl.empty();
		bodyEl.style.maxHeight = "";

		const textarea = bodyEl.createEl("textarea", { cls: "section-card-editor" });
		textarea.value = section.raw;
		textarea.rows = Math.min(Math.max(section.raw.split("\n").length + 1, 4), 30);

		const footer = bodyEl.createDiv({ cls: "section-card-footer" });
		footer.createSpan({ cls: "section-card-hint", text: "Ctrl/⌘+Enter to save · Esc to cancel" });
		const cancelBtn = footer.createEl("button", { text: "Cancel" });
		const saveBtn = footer.createEl("button", { cls: "mod-cta", text: "Save" });

		let settled = false;
		const finish = async (save: boolean) => {
			if (settled) return;
			settled = true;
			// Saving re-renders the card, so remember to blow it back up afterwards.
			if (this.maximized?.card === card) {
				const firstLine = textarea.value.split("\n")[0]?.trim();
				this.pendingMaximizeHeading = save && firstLine ? firstLine : section.headingRaw;
			}
			if (save && textarea.value !== section.raw) {
				const written = await writeSection(this.app, file, this.headingLevel, section, textarea.value);
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
			}
		});
		textarea.addEventListener("click", (e) => e.stopPropagation());

		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		this.layoutMasonry();
	}

	/** True when a card editor is open — used to avoid yanking the file out from under a typist. */
	isEditing(): boolean {
		return this.editingKey !== null;
	}
}

class FileSuggestModal extends FuzzySuggestModal<TFile> {
	onChoose: (file: TFile) => void;

	constructor(app: App, onChoose: (file: TFile) => void) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder("Show sections of which note?");
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

class NewCardModal extends Modal {
	private text: string;
	private placement: Placement;
	private readonly onSubmit: (heading: string, placement: Placement) => void;

	constructor(
		app: App,
		defaultText: string,
		defaultPlacement: Placement,
		onSubmit: (heading: string, placement: Placement) => void,
	) {
		super(app);
		this.text = defaultText;
		this.placement = defaultPlacement;
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
		this.onSubmit(heading, this.placement);
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

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Default note")
			.setDesc("Vault-relative path opened by the ribbon icon and command.")
			.addText((text) =>
				text
					.setPlaceholder("Daily Notes 2026.md")
					.setValue(this.plugin.settings.filePath)
					.onChange(async (value) => {
						this.plugin.settings.filePath = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Heading level")
			.setDesc("Which heading rank becomes a card.")
			.addDropdown((dd) => {
				for (let l = 1; l <= 6; l++) dd.addOption(String(l), `Heading ${l}`);
				dd.setValue(String(this.plugin.settings.headingLevel)).onChange(async (value) => {
					this.plugin.settings.headingLevel = Number(value);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Headings contain")
			.setDesc("With Dates, the card for today is highlighted in the theme's highlight colour.")
			.addDropdown((dd) =>
				dd
					.addOption("dates", "Dates")
					.addOption("text", "Non-dates (plain text)")
					.setValue(this.plugin.settings.headingType)
					.onChange(async (value) => {
						this.plugin.settings.headingType = value as HeadingType;
						await this.plugin.saveSettings();
						this.plugin.refreshAllViews();
					}),
			);

		new Setting(containerEl)
			.setName("Default layout")
			.setDesc("Grid and Tight are masonry columns; Horizontal is full-width rows; Vertical is full-height cards that scroll sideways.")
			.addDropdown((dd) => {
				for (const [value, label] of LAYOUT_OPTIONS) dd.addOption(value, label);
				dd.setValue(this.plugin.settings.layout).onChange(async (value) => {
					this.plugin.settings.layout = value as Layout;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Default sort")
			.addDropdown((dd) =>
				dd
					.addOption("asc", "Alphanumeric A → Z")
					.addOption("desc", "Alphanumeric Z → A")
					.addOption("doc", "Document order")
					.setValue(this.plugin.settings.sortOrder)
					.onChange(async (value) => {
						this.plugin.settings.sortOrder = value as SortOrder;
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("h4", { text: "New cards" });

		new Setting(containerEl)
			.setName("Default heading name")
			.setDesc('Moment.js date format used to pre-fill "New card". Default: YYYY-MM-DD, dddd')
			.addText((text) =>
				text
					.setPlaceholder("YYYY-MM-DD, dddd")
					.setValue(this.plugin.settings.newCardFormat)
					.onChange(async (value) => {
						this.plugin.settings.newCardFormat = value.trim() || DEFAULT_SETTINGS.newCardFormat;
						await this.plugin.saveSettings();
					}),
			)
			.addExtraButton((b) =>
				b.setIcon("clock").setTooltip("Preview").onClick(() => {
					new Notice(mo().format(this.plugin.settings.newCardFormat));
				}),
			);

		new Setting(containerEl)
			.setName("Default placement")
			.setDesc("Logical order follows the direction the file's sections already run.")
			.addDropdown((dd) =>
				dd
					.addOption("top", "Append to top")
					.addOption("logical", "Add to logical order")
					.addOption("bottom", "Add to bottom")
					.setValue(this.plugin.settings.newCardPlacement)
					.onChange(async (value) => {
						this.plugin.settings.newCardPlacement = value as Placement;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Clicking a card's title bar")
			.setDesc("The card body always opens the raw-markdown editor; this is just the title bar.")
			.addDropdown((dd) =>
				dd
					.addOption("maximize", "Makes the card big")
					.addOption("edit", "Edits the raw markdown")
					.setValue(this.plugin.settings.titleBarClick)
					.onChange(async (value) => {
						this.plugin.settings.titleBarClick = value as TitleBarClick;
						await this.plugin.saveSettings();
						this.plugin.refreshAllViews();
					}),
			);

		new Setting(containerEl)
			.setName("Completion date on tasks")
			.setDesc(
				"When a task checkbox is ticked in a card, append an Obsidian Tasks style done date (✅ 2026-08-06). Unticking removes it.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.taskDoneDate).onChange(async (value) => {
					this.plugin.settings.taskDoneDate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Card height")
			.setDesc("Maximum card height in pixels before the card body scrolls.")
			.addSlider((slider) =>
				slider
					.setLimits(160, 800, 20)
					.setValue(this.plugin.settings.cardMaxHeight)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.cardMaxHeight = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}

export default class SectionCardsPlugin extends Plugin {
	settings: SectionCardsSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		addIcon(DECK_ICON, DECK_SVG);

		this.registerView(VIEW_TYPE_SECTION_CARDS, (leaf) => new SectionCardsView(leaf, this));

		this.addRibbonIcon(DECK_ICON, "Single File Section Cards", () => this.openCardsView());

		this.addCommand({
			id: "open-section-cards",
			name: "Open section cards (default note)",
			callback: () => this.openCardsView(),
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
	}

	async openCardsView(filePath?: string, revealHeading?: string): Promise<void> {
		const path = filePath ?? this.settings.filePath;

		const existing = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)
			.find((leaf) => (leaf.view as SectionCardsView).filePath === path);

		if (existing) {
			this.app.workspace.revealLeaf(existing);
			const view = existing.view as SectionCardsView;
			await view.refresh();
			if (revealHeading) view.revealCard(revealHeading);
			return;
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
		this.app.workspace.revealLeaf(leaf);

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
		this.settings.perFile[path] = view;
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
