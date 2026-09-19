// Settings, layouts, palettes, and the constants the views share.

import { Platform } from "obsidian";
import { PlannerSlot } from "./planner";
import { DocumentLevels } from "./periods";
import { CardRect, SavedCanvasLayout } from "./canvas";

export const VIEW_TYPE_SECTION_CARDS = "section-cards-view";

export const GITHUB_REPO_URL = "https://github.com/jordanlong121/singlefilesectioncards";

/** Bodies rendered synchronously on open — roughly two screenfuls. The rest render in
 * idle-time batches so a year-long note paints its first cards immediately. A phone
 * shows a single column, so two screenfuls is far fewer cards there. */
export const INITIAL_RENDER_COUNT = Platform.isPhone ? 8 : 24;

export const DEFERRED_RENDER_BATCH = Platform.isPhone ? 6 : 12;

/** Modifier-key name used in tooltip shortcut hints, matching the platform. */
export const MOD_LABEL = Platform.isMacOS ? "⌘" : "Ctrl";

export const DECK_ICON = "section-cards-deck";

/**
 * A deck of cards: three offset card layers. Drawn on Lucide's 24px grid (2px round
 * strokes) and scaled into the 100x100 box Obsidian's addIcon expects. The back layers
 * are drawn as top+right edges only, so no strokes overlap and it stays legible at 16px.
 */
export const DECK_SVG = `<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
	<rect x="2.5" y="9" width="12" height="12.5" rx="2"/>
	<path d="M5.5 6h10a2 2 0 0 1 2 2v10"/>
	<path d="M8.5 3h10a2 2 0 0 1 2 2v10"/>
</g>`;

/** The card-flip button: a circle seen edge-on — a horizontal ellipse arrow running
 * around a vertical axis, the way the card itself turns. Lucide has no such glyph. */
export const FLIP_ICON = "sfsc-flip";

export const FLIP_SVG = `<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
	<path d="M16.75 8.54A9.5 4 0 1 1 7.25 8.54"/>
	<path d="M4.7 11.6 7.25 8.54 3.6 7"/>
</g>`;

export type SortOrder = "doc" | "asc" | "desc" | "count-asc" | "count-desc";

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
export type Layout =
	| "grid"
	| "aligned"
	| "tight"
	| "horizontal"
	| "vertical"
	| "tasks"
	| "custom"
	| "images"
	| "links"
	| "calendar"
	| "heatmap"
	| "rolodex"
	| "planner";

export const SORT_LABELS: Record<SortOrder, string> = {
	asc: "A → Z",
	desc: "Z → A",
	doc: "Document order",
	"count-asc": "Task count ascending",
	"count-desc": "Task count descending",
};

/** [value, toolbar label, tooltip] */
export const LAYOUT_OPTIONS: [Layout, string, string][] = [
	["grid", "Grid", "Masonry columns"],
	["aligned", "Grid Aligned", "Uniform grid: every row starts at the same height"],
	["tight", "Tight", "Denser, narrower masonry columns"],
	["horizontal", "Horizontal", "One card per row, full width"],
	["tasks", "Tasks Only", "Just the tasks: each card shows only its task lines, ordered by date and tag"],
	["vertical", "Vertical", "Full-height cards side by side, scrolling sideways"],
	["rolodex", "Rolodex", "One card at a time, filling the pane; every card's title is a tab across the top"],
	[
		"planner",
		"Day Planner",
		"One card at a time: its title up top, arrows to its neighbours, and its lines as cards in two columns to arrange and resize",
	],
	["custom", "Custom Grid", "Freeform canvas: drag cards on from the tray, place and resize them"],
	["images", "Images", "Freeform canvas of the note's images: drag previews on from the tray, place and resize them"],
	["links", "Links", "Freeform canvas of the note's web links: drag page previews on from the tray, place and resize them"],
	["calendar", "Calendar", "Date cards on a monthly calendar grid — needs the Dates checkbox"],
	["heatmap", "Heatmap", "A year-at-a-glance activity graph of the dated cards — needs the Dates checkbox"],
];

/** How the Deck orders its note thumbnails. "recent" is the working-set order:
 * pinned notes first, then most recently opened. */
/** The fields a background is made of, as stored on a note's entry or on the Deck. */
export interface BackgroundStore {
	backgroundImage?: string;
	backgroundDim?: number;
	backgroundBrightness?: number;
	backgroundSaturation?: number;
}

/** The pseudo-path the Deck's background is read and written under (never a vault path). */
export const DECK_BACKGROUND_KEY = "\u0000deck";

export type DeckSort = "recent" | "name-asc" | "name-desc" | "modified" | "created";

export const DECK_SORT_LABELS: [DeckSort, string][] = [
	["recent", "Recent"],
	["name-asc", "File name A → Z"],
	["name-desc", "File name Z → A"],
	["modified", "Modified"],
	["created", "Created"],
];

/** "live" renders markdown while editing, "source" shows it highlighted — both via
 * Obsidian's editor, falling back to "plain" (a bare textarea) if it's unavailable. */
export type EditorMode = "live" | "source" | "plain";

export interface SectionCardsSettings {
	filePath: string;
	/** A note with a remembered cards view reopens in the cards view, not the editor. */
	autoOpenCards: boolean;
	/** An "Open as cards" button in every note's top-right, swapping that tab to the cards view. */
	noteCardsButton: boolean;
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
	/** "Open today's section" in a note that doesn't use dates opens (creating if
	 * needed) the card with this title instead. Empty: just open the note. */
	undatedSection: string;
	/** Show text above the file's first heading as its own card. */
	unfiledEnabled: boolean;
	/** Show the note's properties (frontmatter) as a card of their own, first on the wall. */
	propertiesEnabled: boolean;
	/** That card's display-only title. */
	propertiesTitle: string;
	/** Display-only title for that card; never written into the note. */
	unfiledTitle: string;
	/** Scroll today's card into view when a note first renders in the view. */
	jumpToToday: boolean;
	/** Keep the pinned band on screen while the rest of the cards scroll. */
	stickyPinned: boolean;
	/** Mark cards holding open tasks due today (amber) or overdue (red): a badge and an edge. */
	dueTaskMarks: boolean;
	/** Cards with a back-side marker in their body get a flip button; the text below
	 * the marker is hidden from the front and shown on the back. */
	flipEnabled: boolean;
	/** The line that, on its own, starts a card's back (trimmed, exact match). */
	flipMarker: string;
	taskDoneDate: boolean;
	/** Route task toggles through the Tasks plugin when it's installed, so recurring
	 * tasks spawn their next occurrence and done dates follow its settings. */
	tasksToggle: boolean;
	/** Whether ticking a task also strikes through the items nested beneath it. */
	strikeNestedUnderDone: boolean;
	/** Emoji written at the start of a line by right-click → "Add star"; the starred-only
	 * toggle and the block tagging match against it. Stored in the note as literal text. */
	starEmoji: string;
	/** Full toolbar with text labels, or the compact one-line version for narrow panes. */
	toolbarStyle: "full" | "compact";
	/** First day of the Calendar layout's weeks; "locale" follows the language default. */
	weekStart: "locale" | "sunday" | "monday";
	/** Extra date-detection pattern: a moment format, optionally wrapped in `*`
	 * wildcards standing for text before/after the date. Empty = built-ins only. */
	dateDetectFormat: string;
	/** Card editor flavour: Obsidian's live-preview editor, or the plain textarea. */
	editorMode: EditorMode;
	/** Commit an open card editor whenever the wall re-renders out from under it
	 * (switching notes or layouts, opening the Deck, an external change) instead of
	 * discarding the typing. Escape on an edited card asks before discarding. */
	saveOnLeave: boolean;
	/** Periodically write an open card editor's content back to the note. */
	autosaveEnabled: boolean;
	/** Minutes between autosaves while a card editor is open. */
	autosaveMinutes: number;
	layout: Layout;
	/** Hierarchy layout: show a second badge per column row counting its unfinished tasks. */
	hierTaskCounts: boolean;
	/** The nine card colors as configured (label + hex per slot); see CARD_COLORS. */
	palette: PaletteColor[];
	/** How many note thumbnails the Deck shows (pinned first, then most recent). */
	deckCount: number;
	/** How the Deck's thumbnails are ordered. */
	deckSort: DeckSort;
	/** The Deck's own background (image, veil, brightness, saturation) — a look of its
	 * own, apart from whichever note the toolbar's picker holds. */
	deckBackground?: BackgroundStore;
	/** Notes recently opened in the cards view, newest first — the right-click menu's
	 * quick-switch section shows the top of this list. */
	recentFiles: string[];
	/** Quick-switch entries pinned in place; only unpinned slots rotate with history. */
	pinnedRecentFiles: string[];
	/** Remembered view per note, keyed by vault path. Lives here, never in the note. */
	perFile: Record<string, PerFileView>;
}

/** A note's remembered view plus, for the canvas layouts, its placements: Custom Grid
 * cards by heading line, Images previews by image path (or URL, for external images). */
export interface PerFileView extends ViewSettings {
	customGrid?: Record<string, CardRect>;
	customZoom?: number;
	imagesGrid?: Record<string, CardRect>;
	imagesZoom?: number;
	linksGrid?: Record<string, CardRect>;
	linksZoom?: number;
	/** Day Planner: per card (heading line), each line's column and height by line key. */
	planner?: Record<string, Record<string, PlannerSlot>>;
	/** Layouts switched off for this note: left out of the dropdown, the menus, and the L cycle. */
	hiddenLayouts?: Layout[];
	/** The canvases' tray (the list of what isn't on the canvas) folded to a slim strip. */
	trayCollapsed?: boolean;
	/** Custom Grid arrangements saved under a name (tray → save), with their backgrounds. */
	savedLayouts?: Record<string, SavedCanvasLayout>;
	/** The saved layout last applied or saved, shown in the tray's switcher. */
	activeSavedLayout?: string;
	/** Document setup: what each heading level holds (☰ → Document setup…). */
	levels?: DocumentLevels;
	/** Headings pinned to the top of the card wall, in the order they were pinned. */
	pinned?: string[];
	/** Whether this note's headings name dates (today highlight, jump-to-date). Unset
	 * means "decide from the note": on when any heading looks like a date. */
	containsDates?: boolean;
	/** Per-card colors by heading line; values are CARD_COLORS names. */
	colors?: Record<string, string>;
	/** Cards showing their back (Card Flip), by heading line. */
	flipped?: string[];
	/** Cards collapsed to their title bar, by heading line. */
	collapsed?: string[];
	/** Dated cards hidden relative to today (menu → Hide future / past dates). */
	hideFutureDates?: boolean;
	hidePastDates?: boolean;
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
	/** Tasks layout: which task states show — everything, open only, or done only. */
	taskFilter?: TaskFilter;
	/** Divider bars over buckets: first tag, date, open-task count, stars, or length. */
	groupBy?: GroupBy;
}

/** The Tasks layout's complete/incomplete filter. */
export type TaskFilter = "all" | "open" | "done";

/** Group-by: divider bars over buckets of cards, instead of (or as well as) ancestor headings. */
export type GroupBy = "none" | "tag" | "date" | "tasks" | "stars" | "length";

export const GROUP_BY_LABELS: [GroupBy, string][] = [
	["none", "None"],
	["tag", "Tag"],
	["date", "Date"],
	["tasks", "Open tasks"],
	["stars", "Stars"],
	["length", "Length"],
];

/**
 * The card color palette's nine slots. Slot names key the stored per-card choice and the
 * CSS swatch rules, so they never change — the settings can restyle a slot's label and
 * color, and every card already wearing it follows along.
 */
export const CARD_COLORS: [name: string, label: string, hex: string][] = [
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

export const DEFAULT_SETTINGS: SectionCardsSettings = {
	filePath: "Daily Notes 2026.md",
	autoOpenCards: false,
	noteCardsButton: true,
	headingLevel: 3,
	dynamicLevelOptions: true,
	sortOrder: "asc",
	cardMaxHeight: 320,
	fontScale: 100,
	dividerFontScale: 100,
	newCardFormat: "YYYY-MM-DD, dddd",
	newCardPlacement: "logical",
	undatedSection: "",
	unfiledEnabled: false,
	propertiesEnabled: false,
	propertiesTitle: "Properties",
	unfiledTitle: "_Unfiled_",
	jumpToToday: true,
	stickyPinned: true,
	dueTaskMarks: true,
	flipEnabled: true,
	flipMarker: "%% flip %%",
	taskDoneDate: true,
	tasksToggle: true,
	strikeNestedUnderDone: true,
	starEmoji: "⭐",
	toolbarStyle: "compact",
	weekStart: "locale",
	dateDetectFormat: "",
	editorMode: "live",
	saveOnLeave: true,
	autosaveEnabled: true,
	autosaveMinutes: 5,
	layout: "grid",
	hierTaskCounts: true,
	palette: CARD_COLORS.map(([, label, hex]) => ({ label, hex })),
	deckCount: 5,
	deckSort: "recent",
	recentFiles: [],
	pinnedRecentFiles: [],
	perFile: {},
};

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
		taskFilter: saved?.taskFilter ?? fromState.taskFilter ?? defaults.taskFilter ?? "all",
		groupBy: saved?.groupBy ?? fromState.groupBy ?? defaults.groupBy ?? "none",
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
