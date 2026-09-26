// The cards view: one note's sections as cards, in every layout.

import {
	App,
	Component,
	ItemView,
	MarkdownRenderer,
	Menu,
	MenuItem,
	Notice,
	Platform,
	Scope,
		type Modifier,
	TFile,
	WorkspaceLeaf,
	debounce,
	moment,
	normalizePath,
	requestUrl,
	type ViewStateResult,
} from "obsidian";
import { createEmbeddedEditor, type EmbeddedEditor } from "../editor-embed";
import { fastIcon } from "./icons";
import { GROUP_BY_ICONS, DECK_SORT_ICONS, LAYOUT_ICONS, DECK_BACKGROUND_KEY,
	VIEW_TYPE_SECTION_CARDS,
	INITIAL_RENDER_COUNT,
	DEFERRED_RENDER_BATCH,
	MOD_LABEL,
	DECK_ICON,
	FLIP_ICON,
	SortOrder,
	Layout,
	SORT_LABELS,
	LAYOUT_OPTIONS,
	DeckSort,
	DECK_SORT_LABELS,
	ViewSettings,
	TaskFilter,
	GroupBy,
	GROUP_BY_LABELS,
	CalendarRange,
	CALENDAR_RANGE_OPTIONS,
	CALENDAR_RANGE_ICONS,
	CARD_COLORS,
	DEFAULT_SETTINGS,
	resolveViewSettings,
} from "./settings";
import { levelCoverage,
	Section,
	mo,
	HEADING_RE,
	parseSections,
	sortSections,
	applyPinned,
	firstContentLine,
	wholeNoteSection,
	YamlProperty,
	parseYamlProperties,
	propertyDisplay,
	propertyEditText,
	setYamlProperty,
	propertiesMarkdown,
	parseCards,
	AncestorHeading,
	parseAncestorHeadings,
	headingLevelsIn,
	HIER_GAP_KEY,
	HierarchyItem,
	hierarchyColumnItems,
	groupByAncestor,
	bodyStartLine,
	deckExcerpt,
	normalizeHeading,
	locateCard,
	sectionFromEdited,
	pickHeadingLevel,
	planCardReuse,
} from "./sections";
import { groupCards } from "./grouping";
import {
	isTodayTitle,
	titleToIso,
	retitledDateTitle,
	heatmapDays,
	shiftIso,
	calendarRangeDays,
	calendarRangeStep,
	isoDow,
	isWeekendIso,
	clampIso,
	heatmapStreaks,
	dateHeadingCounts,
	bestDateLevel,
} from "./dates";
import {
	movableBlocks,
	blockStarred,
	sectionHasStar,
	bodyForRender,
	CardFaces,
	splitCardFaces,
	trimTrailingBlankLines,
	starInfo,
} from "./blocks";
import {
	TasksApiV1,
	sortTasksLayout,
	TASK_RE,
	dueTaskSummary,
	firstDueTaskIndex,
	taskLineIndexes,
	openTaskCount,
	toggleTaskInFile,
	toggleTaskWithTasksApi,
} from "./tasks";
import {
	deleteBlockInFile,
	moveBlockInFile,
	toggleStarInFile,
	moveSectionInFile,
	mergeSectionsInFile,
	retitleSectionInFile,
	quickAddToSection,
	pasteAtSectionEnd,
	pasteAboveSubheadings,
	replaceBlockInFile,
	moveRangeInFile,
	replaceRangeInFile,
	insertAfterBlockInFile,
	deleteSection,
	deleteSectionsInFile,
	deleteRangeInFile,
	moveSectionsInFile,
	insertSection,
	writeSection,
	syncFeedIntoSection,
} from "./writes";
import { feedDayEvents, feedEventLine } from "./icalfeed";
import {
	PlannerSlot,
	plannerBlockKey,
	PlannerCard,
	plannerCards,
	plannerColumnSplit,
	plannerCardWeight,
	alphanumericCompare,
} from "./planner";
import {
	LevelSetup,
	DocumentLevels,
	PERIOD_FORMATS,
	parsePeriod,
	shiftPeriod,
	formatPeriod,
	bareMonthIndex,
	periodUnit,
	detectLevelSetup,
} from "./periods";
import { snapshotCanvasLayout, canvasLayoutEquals,
	pickNearViewport,
	CardRect,
	CUSTOM_SNAP,
	CUSTOM_GAP,
	CUSTOM_MIN_W,
	CUSTOM_MIN_H,
	CUSTOM_DEFAULT_W,
	CUSTOM_DEFAULT_H,
	IMAGE_MIN_W,
	IMAGE_MIN_H,
	IMAGE_DEFAULT_W,
	IMAGE_DEFAULT_MAX_H,
	IMAGE_EXT,
	VIDEO_EXT,
	imageLinkSpans,
	imageLinksIn,
	LINK_DEFAULT_W,
	LINK_DEFAULT_H,
	UrlLink,
	urlLinksIn,
	shortHash,
	NoteImage,
	snapRect,
	rectsCollide,
	findFreeSpot,
} from "./canvas";
import {
	computeTabEdit,
	EditorSnapshot,
	EditorHistory,
	captureCaret,
	restoreCaret,
	splitLinktext,
	wheelDeltaToPixels,
	canScrollVertically,
} from "./editing";
import {
	backgroundLightLayer,
	backgroundDesatLayer,
	SelectBackgroundModal,
	BackgroundSuggestModal,
	DownloadBackgroundModal,
	GradientBackgroundModal,
	BACKGROUND_EXTENSIONS,
} from "./background";
import { SavedLayoutChangesModal, ConfirmActionModal,
	FileSuggestModal,
	ConfirmDeleteModal,
	SwitchToDocumentOrderModal,
	MergeCardsModal,
	TextInputModal,
	UnsavedChangesModal,
	NoteLibraryModal,
	DeleteImageModal,
	PasteImageModal,
	ConfirmClearModal,
	ShortcutsModal,
	CreateDateCardModal,
	CalendarFeedModal,
	PlannerMissingDayModal,
	DocumentSetupModal,
	DuplicateCardModal,
	NewCardModal,
	HeadingFormatModal,
	QuickAddModal,
	EditBlockModal,
} from "./modals";
import type SectionCardsPlugin from "../main";

/** What "hide past / future dates" is comparing against while it's on. */
export interface DateGate {
	past: boolean;
	future: boolean;
	today: string;
	format: string;
	detect: string;
}

/** A rendered card. `holder.section` is swapped on reuse so closures never go stale. */
export interface CardEntry {
	el: HTMLElement;
	/** The card's body container, cached so refreshes don't re-query it per card. */
	bodyEl: HTMLElement;
	/** The card's back face (text below the back-side marker), null when it has none. */
	backEl: HTMLElement | null;
	scope: Component;
	holder: { section: Section };
	raw: string;
	/** Set while the body's markdown render is still owed; null once started. */
	renderBody: (() => Promise<void>) | null;
	/** Build the hover strip's buttons if they aren't yet (they're made on first hover). */
	ensureActions: () => void;
}

/** A period a planner card names, per the level's Document setup role. */
export interface PlannerPeriod {
	role: "year" | "month" | "week" | "day";
	/** Canonical key (see parsePeriod); an ISO date for days. */
	key: string;
	format: string;
}

/** A card as built on the Day Planner: its element, source range, and remembered slot. */
export interface PlannerItem {
	el: HTMLElement;
	card: PlannerCard;
	/** The card's full source lines (a subcard's include its trailing blanks), for verification. */
	text: string;
	/** What the edit window shows: a subcard's text without trailing blank lines. */
	editText: string;
	/** The body line the editable text ends at. */
	editEnd: number;
	key: string;
	col: 0 | 1;
	/** Task lines of the section above this card, so its nth checkbox maps to a task line. */
	tasksBefore: number;
	/** The saved slot, if any (an explicit column pin and/or a resized height). */
	slot?: PlannerSlot;
}

/** One choice in a toolbar picker (layout, sort, group). */
interface PickerOption {
	value: string;
	label: string;
	hint?: string;
	icon: string;
	fallback?: string;
	disabled?: boolean;
}

interface PickerSpec {
	/** A class for the button, so each picker can be styled or found. */
	cls: string;
	ariaLabel: string;
	/** A fixed icon for the button (sort, group); unset, the current option's icon shows (layout). */
	buttonIcon?: string;
	/** The current choice, or a getter read when the button is built and when it opens. */
	value: string | (() => string);
	columns?: number;
	/** Small text-only tiles in one row (the heading levels): the label says it all. */
	compact?: boolean;
	/** The choices, or a getter read each time the picker opens (levels change with the note). */
	options: PickerOption[] | (() => PickerOption[]);
	onPick: (value: string) => void;
}

export interface CardsViewState {
	filePath?: string;
	headingLevel?: number;
	sortOrder?: SortOrder;
	layout?: Layout;
	hierarchy?: boolean;
	sections?: boolean;
	starredOnly?: boolean;
	taskFilter?: TaskFilter;
	groupBy?: GroupBy;
	calendarRange?: CalendarRange;
	deck?: boolean;
	/** Stickies: the heading line of the one card this view shows. */
	sticky?: string;
	/** Stickies: keep the sticky's window above other windows (re-applied on restore). */
	stickyOnTop?: boolean;
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
	/** The Deck: a wall of note thumbnails replacing the cards until a note is picked. */
	deckMode = false;
	/** Group-by: divider bars over buckets of cards (per note, like the sort). */
	groupBy: GroupBy = "none";
	/** Tasks layout: which task states its cards show. */
	taskFilter: TaskFilter = "all";
	/** Calendar layout: how much of the calendar one screen holds — whole months
	 * (the scrolling wall), one week, or one day. */
	calendarRange: CalendarRange = "month";
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
	/** Multi-select: the selected cards' heading lines, and the card with keyboard focus. */
	private selected = new Set<string>();
	private focusedKey: string | null = null;
	/** The selection action bar (bottom of the view); built once, shown while anything is selected. */
	private selectionBar: HTMLElement | null = null;
	/** The status bar along the pane's bottom while Hide past / future dates is on. */
	private dateBarEl: HTMLElement | null = null;
	/** The bar saying the card level leaves text out (levelCoverage), above the date bar. */
	private levelBarEl: HTMLElement | null = null;
	/** "path:level" the user dismissed the level bar for. */
	private levelBarDismissed: string | null = null;
	/** A card drag that carries the whole selection along (document order only). */
	private draggingMany: Section[] | null = null;
	/** Rolodex: the title-tab strip above the one showing card, and the wrapper that
	 * carries its edge indicators. */
	private roloTabsEl: HTMLElement | null = null;
	private roloWrapEl: HTMLElement | null = null;
	/** Rolodex: the strip width the rows were last computed for. */
	private roloWidth = 0;
	/** Rolodex: the tab being dragged to a new place in the note, and the cell marked as its drop slot. */
	private roloDragging: CardEntry | null = null;
	private roloDropCell: HTMLElement | null = null;
	/** Rolodex: each card's tab cell as last built, so a tab switch can restyle in place. */
	private roloCells = new Map<CardEntry, HTMLElement>();
	/** Rolodex: rows chosen with the zoom buttons; null = as few as needed, up to four. */
	private roloRows: number | null = null;
	/** Rolodex: the row count the strip last showed, and the zoom buttons to sync. */
	private roloRowsShown = 1;
	private roloZoomBtns: { fewer: HTMLButtonElement; more: HTMLButtonElement } | null = null;
	/** Rolodex: which card each note was showing (heading line), for the view's lifetime. */
	private roloActive = new Map<string, string>();
	/** Stickies: the heading line of the one card this view shows — a sidebar tab or a
	 * popout window opened from a card's menu; null for a full cards view. */
	sticky: string | null = null;
	/** The strip above a sticky's card (note name, ways out). */
	private stickyHeadEl: HTMLElement | null = null;
	/** Stickies: the window is kept above other windows (Electron's always-on-top). */
	private stickyOnTop = false;
	/** Day Planner: the pane below the toolbar (title, arrows, two columns of lines). */
	private plannerEl: HTMLElement | null = null;
	/** Owns the planner's rendered markdown; replaced on every rebuild. */
	private plannerScope: Component | null = null;
	/** Watches the planner's line cards for the native vertical resize. */
	private plannerObserver: ResizeObserver | null = null;
	/** The card being dragged between or within the planner's columns. */
	private plannerDrag: PlannerItem | null = null;
	/** The planner's cards as built, in document order; items carry their index. */
	private plannerItems: PlannerItem[] = [];
	/** The element wearing the planner's drop mark (a line card or a column). */
	private plannerDropEl: HTMLElement | null = null;
	/** The heading the planner is showing, for the height observer's bookkeeping. */
	private plannerHeading: string | null = null;
	/** The note's lines as of the last refresh (the planner's whole-note fallback reads them). */
	private noteLines: string[] = [];
	/** The starred-only toolbar toggle, so refresh can hide it in notes with no stars. */
	private starBtn: HTMLElement | null = null;
	/** Whether the last render found a starred line, so the star toggle is offered. */
	private hasStars = false;
	/** The per-note "Dates" checkbox, kept current by refresh. */
	private datesToggle: HTMLInputElement | null = null;
	/** The toolbar's template button, so the hamburger menu can reuse its state styling. */
	private templateBtn: HTMLElement | null = null;
	/** The toolbar's ☰ button: the `M` shortcut opens the menu beneath it. */
	private menuBtn: HTMLElement | null = null;
	/** Opens the jump-to-date picker — stored so the hamburger menu can trigger it too. */
	private openJumpPicker: (() => void) | null = null;
	/** The Layout dropdown, so refresh can grey out Calendar in date-less notes. */
	/** The open picker (layout, sort, group), its button, and its listener teardown. */
	private pickerPopover: HTMLElement | null = null;
	private pickerAnchor: HTMLElement | null = null;
	private pickerCleanup: (() => void) | null = null;
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
		/** Ctrl/⌘+T: a new task line via the Tasks plugin's dialog, at the cursor. */
		insertTask: () => void;
	} | null = null;
	/** Interval handle for the open editor's periodic autosave; null when not editing. */
	private autosaveTimer: number | null = null;
	/** Watches cards for height changes (async markdown, images, embeds) to re-pack them. */
	private cardObserver: ResizeObserver | null = null;
	private repack = debounce(() => {
		if (!this.gridEl || this.viewIsHidden()) return; // zero sizes while backgrounded
		this.layoutMasonry();
		this.insertRowRules();
		if (this.isCanvasLayout()) this.validateCanvasSizes();
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
	/** Images canvas: placements for the current note, keyed by image path/URL. */
	private imagePlacements: Record<string, CardRect> = {};
	/** The zoom bar's tray button: hides the tray column, or brings it back. */
	private trayToggleBtn: HTMLElement | null = null;
	/** The saved-layouts switcher in the Custom Grid tray, for the "changed" mark. */
	private savedLayoutSelect: HTMLSelectElement | null = null;
	/** Which note's image placements are loaded (like placementsLoadedFor for cards). */
	private imagesLoadedFor: string | null = null;
	/** The Images canvas's preview tiles, in document order. Rebuilt every render. */
	private imageEntries: { key: string; el: HTMLElement; label: string }[] = [];
	/** The current note's images by placement key, for tray tiles and collision checks. */
	private imagesByKey = new Map<string, NoteImage>();
	/** Links canvas: placements for the current note, keyed by URL. */
	private linkPlacements: Record<string, CardRect> = {};
	/** Which note's link placements are loaded (like placementsLoadedFor for cards). */
	private linksLoadedFor: string | null = null;
	/** The Links canvas's preview tiles, in document order. Rebuilt every render. */
	private linkEntries: { key: string; el: HTMLElement; label: string }[] = [];
	/** The current note's links by URL, for tray tiles and collision checks. */
	private linksByKey = new Map<string, UrlLink>();
	private trayEl!: HTMLElement;
	/** Invisible marker that gives the canvas its scrollable size in every direction. */
	private canvasExtentEl!: HTMLElement;
	/** Custom Grid zoom factor (0.4–1.6), persisted per note. */
	private customZoom = 1;
	/** Images canvas zoom factor, persisted per note separately from the card canvas. */
	private imagesZoom = 1;
	/** Links canvas zoom factor, persisted per note like the other canvases'. */
	private linksZoom = 1;
	private zoomLabelEl: HTMLElement | null = null;
	/** Which note's placements are loaded; reloading on every refresh caused revert races. */
	private placementsLoadedFor: string | null = null;
	/** Which note has already had its today-card jump, so later refreshes don't re-scroll. */
	private todayJumpedFor: string | null = null;
	/** Which note the Calendar has landed on today for, this visit to the layout. */
	private calendarJumpedFor: string | null = null;
	/** The day the Week and Day ranges are showing — the week holding it, or itself.
	 * Unset until the first render picks one (today, pulled into the note's span).
	 * Session state: where you were looking isn't part of the note's remembered view. */
	private calendarAnchor: string | null = null;
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
	/** Whether the press behind the current click began inside the open editor's card. A
	 * text selection dragged out past the card's edge ends with a click on the common
	 * ancestor — the grid, the tray — which must not count as a click-away. */
	private pressInOpenEditor = false;
	/** Placement writes are immediate: a debounced save raced the next refresh's re-read.
	 * Saves whichever canvas is active: the card placements or the image placements. */
	private persistCanvas = (): void => {
		const file = this.getFile();
		if (!file) return;
		if (this.layout === "images") {
			void this.plugin.saveImagesGrid(
				file.path,
				{ ...this.imagePlacements },
				this.viewSettings(),
				this.imagesZoom,
			);
		} else if (this.layout === "links") {
			void this.plugin.saveLinksGrid(file.path, { ...this.linkPlacements }, this.viewSettings(), this.linksZoom);
		} else {
			void this.plugin
				.saveCustomGrid(file.path, { ...this.customPlacements }, this.viewSettings(), this.customZoom)
				.then(() => this.syncSavedLayoutDirty());
		}
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
	/** Cards whose action strip the user sent to the bottom edge, by heading. A nudge to
	 * reach the line the strip covers, not a preference: it lasts as long as the note is
	 * in view. */
	private actionsBottom = new Set<string>();
	private actionsBottomFile: string | null = null;
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
	/** The Card level picker's wrapper; populateLevelOptions rebuilds the picker in it. */
	private levelHost: HTMLElement | null = null;
	/** The levels the picker was last built with, so a refresh rebuilds it only on change. */
	private levelOptionsShown = "";
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
		if (this.sticky) return `Sticky: ${this.sticky.replace(/^#+\s*/, "") || "(untitled)"}`;
		const base = this.filePath.split("/").pop() ?? this.filePath;
		return `Cards: ${base.replace(/\.md$/, "")}`;
	}

	getIcon(): string {
		return this.sticky ? "sticky-note" : DECK_ICON;
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
			taskFilter: this.taskFilter,
			groupBy: this.groupBy,
			calendarRange: this.calendarRange,
			deck: this.deckMode,
			sticky: this.sticky ?? undefined,
			stickyOnTop: this.stickyOnTop || undefined,
		};
	}

	async setState(state: CardsViewState, result: ViewStateResult): Promise<void> {
		if (state?.filePath) this.filePath = state.filePath;
		this.deckMode = !!state?.deck;
		this.sticky = typeof state?.sticky === "string" && state.sticky ? state.sticky : null;
		this.stickyOnTop = !!this.sticky && !!state?.stickyOnTop;
		await super.setState(state, result);
		this.applyStoredView({
			layout: state?.layout,
			headingLevel: state?.headingLevel,
			sortOrder: state?.sortOrder,
			hierarchy: state?.hierarchy,
			sections: state?.sections,
			starredOnly: state?.starredOnly,
			taskFilter: state?.taskFilter,
			groupBy: state?.groupBy,
			calendarRange: state?.calendarRange,
		});
		this.applyStickyMode();
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
		this.taskFilter = resolved.taskFilter ?? "all";
		this.groupBy = resolved.groupBy ?? "none";
		this.calendarRange = resolved.calendarRange ?? "month";
		this.calendarAnchor = null; // another note, another span: the anchor is re-picked
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
			taskFilter: this.taskFilter,
			groupBy: this.groupBy,
			calendarRange: this.calendarRange,
		};
	}

	/** Custom Grid, Images, and Calendar place everything themselves, so the grouped
	 * view modes (hierarchy columns, section dividers) don't apply on them. One
	 * predicate, so the next self-placing layout changes exactly one line. */
	private layoutOwnsPlacement(): boolean {
		return this.isCanvasLayout() || this.isDateLayout() || this.isSingleCardLayout();
	}

	/** The Rolodex and the Day Planner show one card at a time, and share which one. */
	private isSingleCardLayout(): boolean {
		return this.layout === "rolodex" || this.layout === "planner";
	}

	/** M, 2, W and D pick the Calendar's range while it's showing — and only then, so
	 * everywhere else M still opens the menu, D the Deck, and 2 the heading level. */
	private calendarRangeKeysOn(): boolean {
		return this.layout === "calendar" && !this.deckMode && !this.sticky;
	}

	/** Whether a click on a calendar card opens it big instead of editing it in place:
	 * a month or week cell is too small to write in. The Day range's one card already
	 * fills the pane, so it edits on click like a card anywhere else. */
	private calendarZoomsToEdit(): boolean {
		return this.layout === "calendar" && this.calendarRange !== "day";
	}

	/** Calendar and Heatmap both place by date headings: they borrow the note's date
	 * level, need the Dates checkbox, and grey out in notes with no date headings. */
	private isDateLayout(): boolean {
		return this.layout === "calendar" || this.layout === "heatmap";
	}

	/** Where Hide future / past dates applies: the wall layouts. Not the Calendar and
	 * Heatmap, whose grids place every day, and not the Day Planner, which shows one
	 * day at a time and walks to the next with its arrows — hiding the days ahead
	 * would leave the arrows nowhere to go. */
	private dateHideApplies(): boolean {
		return !this.isDateLayout() && this.layout !== "planner" && !this.sticky;
	}

	/** The freeform canvases — Custom Grid (section cards) and Images (previews) —
	 * share the tray, zoom, pointer-drag, and snap machinery. These helpers pick the
	 * active canvas's state so that machinery never has to know which one it serves. */
	private isCanvasLayout(): boolean {
		return this.layout === "custom" || this.layout === "images" || this.layout === "links";
	}

	private activePlacements(): Record<string, CardRect> {
		if (this.layout === "images") return this.imagePlacements;
		if (this.layout === "links") return this.linkPlacements;
		return this.customPlacements;
	}

	private canvasZoom(): number {
		if (this.layout === "images") return this.imagesZoom;
		if (this.layout === "links") return this.linksZoom;
		return this.customZoom;
	}

	private canvasMins(): { w: number; h: number } {
		// The preview canvases share the small minimum; only cards need reading room.
		return this.layout === "images" || this.layout === "links"
			? { w: IMAGE_MIN_W, h: IMAGE_MIN_H }
			: { w: CUSTOM_MIN_W, h: CUSTOM_MIN_H };
	}

	/** The active canvas's placeable elements and their placement keys. */
	private canvasItems(): { key: string; el: HTMLElement }[] {
		if (this.layout === "images") return this.imageEntries;
		if (this.layout === "links") return this.linkEntries;
		return this.cardEntries.map((entry) => ({ key: entry.holder.section.headingRaw, el: entry.el }));
	}

	/** Re-place the active canvas after a placement change (drop, untray, clear, zoom). */
	private applyCanvasLayout(): void {
		if (this.layout === "images") this.applyImagesLayout();
		else if (this.layout === "links") this.applyLinksLayout();
		else this.applyCustomLayout();
	}

	/** The Calendar option is offered while any heading level names dates (and the
	 * active layout always stays selectable). Shared by the dropdown and the L cycle. */
	/** Switch layouts — the dropdown, the L cycle, and the wall's right-click menu. */
	private setLayout(next: Layout): void {
		if (this.sticky) return;
		// Leaving the Custom Grid with a saved layout changed: offer to save it first.
		if (this.layout === "custom" && next !== "custom") {
			this.confirmSavedLayoutChanges(() => this.switchLayout(next));
			return;
		}
		this.switchLayout(next);
	}

	private switchLayout(next: Layout): void {
		if (next !== "calendar") {
			this.calendarJumpedFor = null; // the next visit lands on today again
			this.calendarAnchor = null; // …and the week/day ranges re-pick theirs
		}
		this.layout = next;
		this.rememberView();
		this.applyLayoutClass();
		this.buildToolbar(); // the layout dropdown, sort options, and toggles follow along
		void this.refresh().then(() => this.app.workspace.requestSaveLayout());
	}

	private calendarSelectable(): boolean {
		return this.hasAnyDates || this.isDateLayout();
	}

	/** Whether a layout is offered in this note: not switched off for it (the one
	 * showing always is, so the dropdown never names a value it doesn't list). */
	private layoutEnabled(value: Layout): boolean {
		return value === this.layout || !this.plugin.getHiddenLayouts(this.filePath).includes(value);
	}

	/** Switch a layout on or off for this note, and redraw the toolbar's dropdown. */
	private async toggleLayoutEnabled(value: Layout): Promise<void> {
		await this.plugin.setLayoutEnabled(this.filePath, value, !this.layoutEnabled(value), this.viewSettings());
		this.buildToolbar();
		this.updateToolbarOffset();
	}

	/** The layout picker's date tiles follow the note's headings; an open picker closes
	 * rather than go stale (the toolbar rebuild redraws it on the next click). */
	private syncCalendarOption(): void {
		this.closePicker();
	}

	/**
	 * A picker control: a button showing the current choice (its own icon, or a fixed one
	 * for the control) and a chevron, dropping a grid of tiles — icon and name each, the
	 * current one ringed — under it. One picker is open at a time; Escape or a click
	 * elsewhere closes it. Layout, sort, and group all wear this.
	 */
	private buildPicker(host: HTMLElement, spec: PickerSpec): HTMLElement {
		const btn = host.createEl("button", { cls: `sfsc-picker-btn ${spec.cls}` });
		const options = typeof spec.options === "function" ? spec.options() : spec.options;
		const value = typeof spec.value === "function" ? spec.value() : spec.value;
		const current = options.find((o) => o.value === value);
		const icon = spec.buttonIcon ?? current?.icon ?? options[0]?.icon ?? "chevron-down";
		const fallback = spec.buttonIcon ? spec.buttonIcon : (current?.fallback ?? icon);
		SectionCardsView.setIconOr(btn.createSpan({ cls: "sfsc-picker-btn-icon" }), icon, fallback);
		btn.createSpan({ cls: "sfsc-picker-btn-label", text: current?.label ?? value });
		fastIcon(btn.createSpan({ cls: "sfsc-picker-btn-chevron" }), "chevron-down");
		btn.setAttr("aria-label", current ? `${spec.ariaLabel}: ${current.label}` : spec.ariaLabel);
		btn.setAttr("aria-haspopup", "true");
		btn.addEventListener("click", () => {
			if (this.pickerAnchor === btn) this.closePicker();
			else this.openPicker(btn, spec);
		});
		return btn;
	}

	private openPicker(anchor: HTMLElement, spec: PickerSpec): void {
		this.closePicker();
		const pop = this.contentEl.createDiv({ cls: "sfsc-picker-pop" });
		pop.setAttr("role", "menu");
		pop.toggleClass("is-compact", !!spec.compact);
		// Read now, not when the button was built: the note's levels may have changed since.
		const options = typeof spec.options === "function" ? spec.options() : spec.options;
		const value = typeof spec.value === "function" ? spec.value() : spec.value;
		const columns = spec.compact ? Math.max(1, options.length) : (spec.columns ?? 3);
		pop.setCssProps({ "--sfsc-picker-cols": String(columns) });
		for (const option of options) {
			const tile = pop.createEl("button", { cls: "sfsc-picker-tile" });
			tile.setAttr("role", "menuitemradio");
			tile.setAttr("aria-checked", String(option.value === value));
			if (option.hint) tile.setAttr("title", option.hint);
			tile.toggleClass("is-active", option.value === value);
			if (!spec.compact) SectionCardsView.setIconOr(tile.createSpan({ cls: "sfsc-picker-tile-icon" }), option.icon, option.fallback ?? option.icon);
			tile.createSpan({ cls: "sfsc-picker-tile-label", text: option.label });
			if (option.disabled) tile.toggleAttribute("disabled", true);
			tile.addEventListener("click", () => {
				this.closePicker();
				if (option.value !== value) spec.onPick(option.value);
			});
		}
		// Under the button, within the pane (pulled left if it would run past the edge).
		const host = this.contentEl.getBoundingClientRect();
		const at = anchor.getBoundingClientRect();
		const tileW = spec.compact ? 40 : 84;
		const width = columns * tileW + (columns - 1) * 6 + 18;
		const left = Math.max(8, Math.min(at.left - host.left, host.width - width - 8));
		pop.setCssStyles({ top: `${at.bottom - host.top + 4}px`, left: `${left}px` });
		this.pickerPopover = pop;
		this.pickerAnchor = anchor;
		anchor.addClass("is-open");
		const onDown = (evt: PointerEvent) => {
			const target = evt.target as Node | null;
			if (pop.contains(target) || anchor.contains(target)) return;
			this.closePicker();
		};
		const onKey = (evt: KeyboardEvent) => {
			if (evt.key !== "Escape") return;
			evt.preventDefault();
			this.closePicker();
			anchor.focus();
		};
		const doc = this.contentEl.doc;
		doc.addEventListener("pointerdown", onDown, true);
		doc.addEventListener("keydown", onKey, true);
		this.pickerCleanup = () => {
			doc.removeEventListener("pointerdown", onDown, true);
			doc.removeEventListener("keydown", onKey, true);
		};
		(pop.querySelector<HTMLElement>(".sfsc-picker-tile.is-active") ?? pop.querySelector<HTMLElement>(".sfsc-picker-tile"))?.focus();
	}

	private closePicker(): void {
		this.pickerCleanup?.();
		this.pickerCleanup = null;
		this.pickerPopover?.remove();
		this.pickerPopover = null;
		this.pickerAnchor?.removeClass("is-open");
		this.pickerAnchor = null;
	}


	/** The Calendar layout implies Dates, so the toggle hides once it's on there — but
	 * not while it's off, or the gate message's "turn on the Dates checkbox" advice
	 * would point at nothing. The Images canvas hides it too (dates mean nothing to
	 * pictures); the note's saved Dates choice is untouched either way. */
	private syncDatesLabel(): void {
		this.datesLabelEl?.toggleClass(
			"is-hidden",
			(this.isDateLayout() && this.containsDates) || this.layout === "images" || this.layout === "links",
		);
	}

	/** Whether the hierarchy columns actually show: toggled on, and the layout groups. */
	private hierarchyActive(): boolean {
		return this.hierarchyOn && !this.layoutOwnsPlacement();
	}

	/** Whether the section divider bars actually show: toggled on, the layout groups,
	 * and never alongside the hierarchy columns — both group by the ancestor headings,
	 * so the columns win a both-on state. */
	private sectionsActive(): boolean {
		if (this.layoutOwnsPlacement()) return false;
		// Ancestor dividers and the hierarchy columns both group by ancestor heading, so
		// the columns win that pair — but group-by buckets are a different cut, and the
		// bars can sit inside the columns' branch just as well.
		return this.groupBy !== "none" || (this.sectionsOn && !this.hierarchyActive());
	}

	/** Remember the current view for the current note (in the plugin's data, not the note). */
	private rememberView(): void {
		if (this.sticky) return; // a sticky's shape is its own, not the note's remembered view
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
		// A narrow pane clips the toolbar's right end (the compact bar pans rather than
		// wrapping): the wheel over it scrolls it sideways, so every button stays reachable.
		this.registerDomEvent(
			this.toolbarEl,
			"wheel",
			(evt: WheelEvent) => {
				const bar = this.toolbarEl;
				if (!bar || evt.ctrlKey || evt.metaKey) return;
				if (bar.scrollWidth - bar.clientWidth <= 1) return; // nothing clipped: leave the wheel alone
				const step = wheelDeltaToPixels(evt, bar.clientWidth);
				if (!step) return;
				evt.preventDefault();
				bar.scrollLeft += step;
			},
			{ passive: false },
		);
		// Clicking anywhere in the toolbar returns an editing card to its preview.
		this.registerDomEvent(this.toolbarEl, "click", () => {
			const open = this.activeEditor;
			if (open) void open.finish(true);
		});
		// Sticky pinned band, between the toolbar and the grid — refresh parents pinned
		// cards here when the setting is on, and CSS hides it while it's empty.
		this.pinnedEl = this.contentEl.createDiv({ cls: "section-cards-pinned" });
		this.hierEl = this.contentEl.createDiv({ cls: "section-cards-hier" });
		// Rolodex: the tab strip sits between the toolbar and the (single) card. The
		// wheel over it scrolls the strip sideways; over the card, the body scrolls
		// up and down on its own.
		this.roloWrapEl = this.contentEl.createDiv({ cls: "sfsc-rolo-wrap" });
		// Zoom: more or fewer tab rows, at the strip's left edge.
		const zoom = this.roloWrapEl.createDiv({ cls: "sfsc-rolo-zoom" });
		const zoomBtn = (icon: string, label: string, delta: number) => {
			const btn = zoom.createEl("button", { cls: "sfsc-rolo-zoom-btn" });
			fastIcon(btn, icon);
			btn.setAttr("aria-label", label);
			btn.addEventListener("click", () => {
				this.roloRows = Math.max(1, this.roloRowsShown + delta);
				this.layoutRolodex();
			});
			return btn;
		};
		this.roloZoomBtns = { more: zoomBtn("plus", "More tab rows", 1), fewer: zoomBtn("minus", "Fewer tab rows", -1) };
		const scroll = this.roloWrapEl.createDiv({ cls: "sfsc-rolo-scroll" });
		this.roloTabsEl = scroll.createDiv({ cls: "sfsc-rolo-tabs" });
		this.registerDomEvent(
			this.roloTabsEl,
			"wheel",
			(evt: WheelEvent) => {
				const strip = this.roloTabsEl;
				if (!strip || evt.ctrlKey || evt.metaKey) return;
				const step = wheelDeltaToPixels(evt, strip.clientWidth);
				if (!step) return;
				evt.preventDefault();
				strip.scrollLeft += step;
			},
			{ passive: false },
		);
		this.registerDomEvent(this.roloTabsEl, "scroll", () => this.syncRoloMore());
		// A tab drag near either edge nudges the strip along, so hidden tabs can be reached.
		this.registerDomEvent(this.roloTabsEl, "dragover", (evt: DragEvent) => {
			const strip = this.roloTabsEl;
			if (!strip || (!this.roloDragging && !this.draggingBlock)) return;
			const rect = strip.getBoundingClientRect();
			if (evt.clientX < rect.left + 40) strip.scrollLeft -= 10;
			else if (evt.clientX > rect.right - 40) strip.scrollLeft += 10;
		});
		// Edge indicators: tabs are cut off on that side; a click pages the strip.
		for (const side of ["left", "right"] as const) {
			const more = scroll.createEl("button", { cls: `sfsc-rolo-more is-${side}` });
			fastIcon(more, side === "left" ? "chevron-left" : "chevron-right");
			more.setAttr("aria-label", side === "left" ? "More tabs to the left" : "More tabs to the right");
			more.addEventListener("click", () => {
				const strip = this.roloTabsEl;
				if (!strip) return;
				strip.scrollBy({ left: (side === "left" ? -1 : 1) * strip.clientWidth * 0.8, behavior: "smooth" });
			});
		}
		// Day Planner pane: filled by layoutPlanner, shown by the layout class only.
		this.plannerEl = this.contentEl.createDiv({ cls: "sfsc-planner" });
		this.gridEl = this.contentEl.createDiv({ cls: "section-cards-grid" });
		this.selectionBar = this.contentEl.createDiv({ cls: "sfsc-selection-bar is-hidden" });
		// The hide-dates status bar lives on the leaf container, not in the scrolling
		// pane, so the cards scroll underneath it.
		this.dateBarEl = this.containerEl.createDiv({ cls: "sfsc-datebar is-hidden" });
		this.levelBarEl = this.containerEl.createDiv({ cls: "sfsc-datebar sfsc-levelbar is-hidden" });
		// Right-click on the wall itself — not a card or a control, which have their
		// own menus — offers the background options where the background actually is.
		// Registered on the hierarchy columns pane too: it covers the wall's left side
		// in the Hierarchy view mode.
		const backgroundMenu = (evt: MouseEvent) => {
			const target = evt.target as HTMLElement | null;
			// Cards, tiles, and controls have their own menus (the toolbar's right-click
			// switches its style); the pane's tab strip, tray, and bars are controls too.
			if (
				target?.closest(
					".section-card, .sc-image-card, .sfsc-deck-card, button, input, select, .section-cards-toolbar, .sfsc-rolo-wrap, .sfsc-selection-bar, .section-cards-tray, .section-cards-zoom, .section-cards-section-bar",
				)
			) {
				return;
			}
			evt.preventDefault();
			const menu = new Menu();
			// Greyed out in the Deck: no note is showing, so it's unclear which one
			// the card would land in.
			menu.addItem((item) =>
				item
					.setTitle("New card…")
					.setIcon("plus")
					.setDisabled(this.deckMode)
					.onClick(() => this.promptNewCard()),
			);
			// On the Images canvas, empty space also takes a clipboard image.
			if (this.layout === "images") {
				menu.addItem((item) =>
					item
						.setTitle("Paste image…")
						.setIcon("clipboard-paste")
						.onClick(() => void this.pasteImageFromClipboard()),
				);
			}
			this.addCommonMenuItems(menu);
			menu.showAtMouseEvent(evt);
		};
		// On the whole pane, not just the card grid: with most cards hidden (a filter,
		// Hide past dates) the grid ends well above the bottom, and the blank pane below
		// it should still offer the menu.
		this.registerDomEvent(this.contentEl, "contextmenu", backgroundMenu);
		// A plain click on empty pane clears the selection, as in a file manager. The
		// same controls are exempt, so pressing a selection-bar button doesn't undo it.
		this.registerDomEvent(this.contentEl, "click", (evt: MouseEvent) => {
			if (!this.selected.size && !this.focusedKey) return;
			const target = evt.target as HTMLElement | null;
			if (
				target?.closest(
					".section-card, .sc-image-card, .sfsc-deck-card, button, input, select, a, .section-cards-toolbar, .sfsc-rolo-wrap, .sfsc-selection-bar, .section-cards-tray, .section-cards-zoom, .section-cards-section-bar, .section-cards-hier-col, .section-cards-overlay",
				)
			) {
				return;
			}
			this.clearSelection(true);
		});
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
		zoomOut.addEventListener("click", () => this.setCanvasZoom(this.canvasZoom() - 0.1));
		this.zoomLabelEl = zoomBar.createEl("button", { cls: "section-cards-zoom-label", text: "100%" });
		this.zoomLabelEl.setAttr("aria-label", "Reset zoom");
		this.zoomLabelEl.addEventListener("click", () => this.setCanvasZoom(1));
		const zoomIn = zoomBar.createEl("button", { text: "+" });
		zoomIn.setAttr("aria-label", "Zoom in");
		zoomIn.addEventListener("click", () => this.setCanvasZoom(this.canvasZoom() + 0.1));
		// The tray column folds away entirely; this is the way back (the tray's own
		// chevron only hides it).
		this.trayToggleBtn = zoomBar.createEl("button", { cls: "section-cards-tray-fold" });
		this.trayToggleBtn.addEventListener("click", () => void this.setTrayCollapsed(!this.plugin.getTrayCollapsed(this.filePath)));
		this.syncTrayToggle();
		this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Escape") return;
			// An open card editor's own Escape handling wins (textarea or live preview).
			if (this.activeEditor) return;
			if (this.maximized) {
				evt.preventDefault();
				this.closeMaximized();
				return;
			}
			// Then the selection and keyboard focus, when this view is the active one.
			if ((this.selected.size || this.focusedKey) && this.app.workspace.getActiveViewOfType(SectionCardsView) === this) {
				evt.preventDefault();
				this.clearSelection(true);
			}
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
		// Ctrl/⌘+T while a card editor is open: the Tasks plugin's create dialog, its
		// line inserted at the cursor. Same reasoning as Mod+Enter for living here too.
		this.scope.register(["Mod"], "T", (evt) => {
			const open = this.activeEditor;
			if (!open) return true;
			evt.preventDefault();
			open.insertTask();
			return false;
		});

		// View shortcuts, none of which run while a card editor is open. The plain keys
		// additionally never fire while typing in a field (the filter box, a rename).
		// 1–6: switch to that heading level (only levels the dropdown offers).
		for (let level = 1; level <= 6; level++) {
			this.scope.register([], String(level), (evt) => {
				if (!this.plainShortcutOk(evt)) return true;
				// 2 on the Calendar picks its 2-weeks range (calendarRangeKeysOn).
				if (level === 2 && this.calendarRangeKeysOn()) {
					this.setCalendarRange("2weeks");
					return false;
				}
				// The Calendar follows the note's date-heading level; a manual level
				// would only be forced back (and churn the stored view) on refresh.
				if (this.isDateLayout()) return true;
				if (this.sticky) return true;
				if (!this.levelOptionValues().includes(level)) return true;
				if (this.headingLevel !== level) void this.changeHeadingLevel(level);
				return false;
			});
		}
		// L: cycle through the layouts, in the dropdown's order; Shift+L goes backwards.
		const cycleLayout = (evt: KeyboardEvent, delta: 1 | -1): boolean => {
			if (!this.plainShortcutOk(evt)) return true;
			if (this.sticky) return true;
			const values = LAYOUT_OPTIONS.map(([value]) => value);
			const step = (from: Layout) => values[(values.indexOf(from) + delta + values.length) % values.length];
			let next = step(this.layout);
			// The cycle skips the greyed-out date layouts, like the dropdown refuses them,
			// and the layouts switched off for this note.
			while (
				next !== this.layout &&
				(((next === "calendar" || next === "heatmap") && !this.calendarSelectable()) || !this.layoutEnabled(next))
			) {
				next = step(next);
			}
			this.setLayout(next);
			return false;
		};
		this.scope.register([], "L", (evt) => cycleLayout(evt, 1));
		this.scope.register(["Shift"], "L", (evt) => cycleLayout(evt, -1));
		// V: cycle the View mode — one flat wall, hierarchy columns, divider bars —
		// mirroring the toolbar's three-way toggle. Not on the layouts that place
		// everything themselves, where the modes don't apply.
		this.scope.register([], "V", (evt) => {
			if (!this.plainShortcutOk(evt)) return true;
			if (this.sticky) return true; // a sticky is one card: nothing to switch
			if (this.layoutOwnsPlacement()) return true;
			if (this.hierarchyOn) {
				this.hierarchyOn = false;
				this.sectionsOn = true;
			} else if (this.sectionsOn) {
				this.sectionsOn = false;
			} else {
				this.hierarchyOn = true;
			}
			this.rememberView();
			this.applyLayoutClass();
			this.buildToolbar(); // the three-way toggle reflects the state
			void this.refresh().then(() => this.app.workspace.requestSaveLayout());
			return false;
		});
		// D: show/hide the Deck of note thumbnails — allowed from inside the Deck,
		// or the key that opened it couldn't close it. On the Calendar, the Day range.
		this.scope.register([], "D", (evt) => {
			if (!this.plainShortcutOk(evt, true)) return true;
			if (this.sticky) return true; // a sticky is one card: nothing to switch
			if (this.calendarRangeKeysOn()) {
				this.setCalendarRange("day");
				return false;
			}
			void this.toggleDeck();
			return false;
		});
		// M: the ☰ menu, dropped beneath its toolbar button (in the Deck too). On the
		// Calendar, the Month range.
		this.scope.register([], "M", (evt) => {
			if (!this.plainShortcutOk(evt, true)) return true;
			if (this.sticky) return true; // a sticky is one card: nothing to switch
			if (this.calendarRangeKeysOn()) {
				this.setCalendarRange("month");
				return false;
			}
			if (!this.menuBtn) return true;
			evt.preventDefault();
			this.openMainMenu(this.menuBtn);
			return false;
		});
		// W: the Calendar's Week range (only on the Calendar, like M, 2 and D there).
		this.scope.register([], "W", (evt) => {
			if (!this.plainShortcutOk(evt) || !this.calendarRangeKeysOn()) return true;
			this.setCalendarRange("week");
			return false;
		});
		// C: the Calendar layout, from any other. Where it can't show — no date headings,
		// or hidden for this note — say why rather than doing nothing.
		this.scope.register([], "C", (evt) => {
			if (!this.plainShortcutOk(evt)) return true;
			if (this.sticky || this.deckMode) return true;
			if (this.layout === "calendar") return false;
			if (!this.layoutEnabled("calendar")) {
				new Notice("This note hides the calendar layout — unhide it from the layout menu.");
				return false;
			}
			if (!this.calendarSelectable()) {
				new Notice("The calendar layout needs date headings in this note.");
				return false;
			}
			this.setLayout("calendar");
			return false;
		});
		// , and .: with the hierarchy columns showing, step the deepest column's
		// selection; with the dividers showing, jump to the previous/next bar; on the
		// Calendar's Week and Day ranges, walk back and forward through the calendar.
		const stepGrouping = (evt: KeyboardEvent, delta: number): boolean => {
			if (!this.plainShortcutOk(evt)) return true;
			if (this.layout === "rolodex") {
				this.stepRolodex(delta);
				return false;
			}
			if (this.layout === "planner") {
				this.stepPlanner(delta);
				return false;
			}
			// The Calendar's Week and Day ranges walk a week (or a day) at a time.
			if (this.layout === "calendar" && this.calendarRange !== "month") {
				this.stepCalendar(delta);
				return false;
			}
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
			if (this.sticky) return true; // a sticky is one card: nothing to switch
			this.promptNewCard();
			return false;
		});
		// O: pick a different note, same as clicking the toolbar's file button.
		// Allowed in the Deck too — it's another way of picking a note.
		this.scope.register([], "O", (evt) => {
			if (!this.plainShortcutOk(evt, true)) return true;
			if (this.sticky) return true; // a sticky is one card: nothing to switch
			new FileSuggestModal(this.app, this.plugin, (path) => void this.navigateTo(path), true).open();
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
		// F: flip the card under the pointer over (or back). A big card shows both
		// faces already, so there's nothing to flip there.
		this.scope.register([], "F", (evt) => {
			if (!this.plainShortcutOk(evt)) return true;
			const card = this.contentEl.querySelector<HTMLElement>(".section-card:hover");
			if (!card || card.hasClass("is-maximized")) return true;
			void this.flipCard(card);
			return false;
		});
		// Shift+F: every card back to its front.
		this.scope.register(["Shift"], "F", (evt) => {
			if (!this.plainShortcutOk(evt)) return true;
			this.flipAll(false);
			return false;
		});
		// Arrow keys walk the cards by position (nearest card in that direction); a
		// focused card takes Enter to edit and Space to select; Shift+arrow extends the
		// selection as it moves. The Rolodex maps left/right to its tabs.
		for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const) {
			const dir = key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right" : key === "ArrowUp" ? "up" : "down";
			for (const mods of [[], ["Shift"]] as Modifier[][]) {
				this.scope.register(mods, key, (evt) => {
					if (!this.plainShortcutOk(evt) || this.isMaximized()) return true;
					if (this.isSingleCardLayout()) {
						if (dir === "left" || dir === "right") {
							const delta = dir === "left" ? -1 : 1;
							if (this.layout === "rolodex") this.stepRolodex(delta);
							else this.stepPlanner(delta);
							return false;
						}
						return true;
					}
					if (!this.moveFocus(dir, mods.length > 0)) return true;
					return false;
				});
			}
		}
		this.scope.register([], "Enter", (evt) => {
			if (!this.plainShortcutOk(evt) || !this.focusedKey) return true;
			const hit = this.cardsByHeading.get(this.focusedKey);
			const file = this.getFile();
			if (!hit || !file) return true;
			evt.preventDefault();
			this.startEditing(hit.el, file, hit.section);
			return false;
		});
		this.scope.register([], " ", (evt) => {
			if (!this.plainShortcutOk(evt) || !this.focusedKey) return true;
			evt.preventDefault();
			this.toggleSelected(this.focusedKey);
			return false;
		});
		this.scope.register(["Mod"], "A", (evt) => {
			if (!this.plainShortcutOk(evt)) return true;
			evt.preventDefault();
			for (const entry of this.visibleEntries()) this.selected.add(entry.holder.section.headingRaw);
			this.applySelectionClasses();
			return false;
		});
		// Ctrl/⌘+F: jump to the filter box (from anywhere in the view, fields included).
		this.scope.register(["Mod"], "F", (evt) => {
			if (this.activeEditor || this.deckMode) return true; // no filter box to jump to
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

		// Middle-click drag pans the canvas layouts (Custom Grid and Images).
		this.registerDomEvent(this.gridEl, "pointerdown", (evt: PointerEvent) => {
			if (!this.isCanvasLayout() || evt.button !== 1) return;
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

		// Where the press started decides whether the click that follows is a click-away:
		// selecting text in the editor and letting go outside the card is not.
		this.registerDomEvent(
			this.contentEl,
			"pointerdown",
			(evt: PointerEvent) => {
				const open = this.activeEditor;
				this.pressInOpenEditor = !!open && (evt.target as HTMLElement | null)?.closest(".section-card") === open.card;
			},
			{ capture: true },
		);
		// Clicking empty grid/canvas space (any layout) or the tray settles the open
		// editor, the same as clicking another card or the toolbar.
		this.registerDomEvent(this.gridEl, "click", (evt: MouseEvent) => {
			const open = this.activeEditor;
			if (!open || this.pressInOpenEditor) return;
			const insideCard = (evt.target as HTMLElement | null)?.closest(".section-card");
			if (insideCard === open.card) return; // clicks inside the editor stay there
			if (!insideCard) void open.finish(true); // another card's handler commits itself
		});
		this.registerDomEvent(this.trayEl, "click", () => {
			const open = this.activeEditor;
			if (open && !this.pressInOpenEditor) void open.finish(true);
		});
		// Clicking anywhere in the hierarchy columns also settles an open editor —
		// including column items, whose own handler may then hide the card.
		this.registerDomEvent(this.hierEl, "click", () => {
			const open = this.activeEditor;
			if (open && !this.pressInOpenEditor) void open.finish(true);
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
		// A maximized card owns the wheel: its body scrolls natively (or nothing
		// does), and the row hiding behind the overlay must not pan sideways.
		if (this.isMaximized()) return;

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
		const want = this.layout === "vertical" && !this.deckMode;
		if (want === this.wheelPanBound) return;
		this.wheelPanBound = want;
		if (want) this.contentEl.addEventListener("wheel", this.wheelPanHandler, { passive: false });
		else this.contentEl.removeEventListener("wheel", this.wheelPanHandler);
	}

	/** The layout lives as a class on the view root so CSS can restyle grid *and* scrolling. */
	private applyLayoutClass(): void {
		this.contentEl.toggleClass("is-tray-collapsed", this.plugin.getTrayCollapsed(this.filePath));
		this.syncTrayToggle();
		for (const name of [
			"grid",
			"aligned",
			"tight",
			"tasks",
			"horizontal",
			"vertical",
			"custom",
			"images",
			"links",
			"calendar",
			"heatmap",
			"rolodex",
			"planner",
		]) {
			// The Deck replaces the layout wholesale; its class drops the layout chrome.
			this.contentEl.toggleClass(`is-layout-${name}`, this.layout === name && !this.deckMode);
		}
		// The Calendar's range: month is the scrolling wall of months, week and day show
		// one range at a time (the CSS resizes the cells and stands the sort control down).
		for (const range of ["month", "2weeks", "week", "day"] as const) {
			this.contentEl.toggleClass(
				`is-cal-${range}`,
				this.layout === "calendar" && !this.deckMode && this.calendarRange === range,
			);
		}
		this.contentEl.toggleClass("is-deck", this.deckMode);
		this.contentEl.toggleClass("is-hier-on", this.hierarchyActive() && !this.deckMode);
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
		this.imageLightboxClose?.(); // its Escape listener lives on the document
		if (this.autosaveTimer !== null) {
			window.clearInterval(this.autosaveTimer);
			this.autosaveTimer = null;
		}
		// A view closed with an editor still open writes that editor's content out
		// instead of dropping it — covered by either the save-on-leave default or
		// the periodic-autosave opt-in.
		if ((this.plugin.settings.saveOnLeave || this.plugin.settings.autosaveEnabled) && this.activeEditor) {
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
	/** Hang a card's action strip under its title bar or along its bottom edge, and set
	 * the button that swaps the two to point the other way. */
	private applyActionsBottom(card: HTMLElement, atBottom: boolean): void {
		card.toggleClass("is-actions-bottom", atBottom);
		const btn = card.querySelector<HTMLElement>(".section-card-movestrip");
		if (!btn) return; // the strip builds on first hover; it reads the state then
		btn.empty();
		fastIcon(btn, atBottom ? "arrow-up-to-line" : "arrow-down-to-line");
		if (!btn.querySelector("svg")) fastIcon(btn, atBottom ? "arrow-up" : "arrow-down");
		btn.setAttr("aria-label", atBottom ? "Move these buttons back to the top" : "Move these buttons to the bottom");
	}

	private applyPinState(card: HTMLElement, pinned: boolean): void {
		card.toggleClass("is-pinned", pinned);
		const btn = card.querySelector<HTMLElement>(".section-card-pin");
		if (!btn) return;
		// Always the same glyph; the states differ by strength (CSS), not icon.
		fastIcon(btn, "pin");
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

	/** Due-task marks (settings): classes for the edge tint and a badge with the counts.
	 * Recomputed for reused cards too — the date rolls over under a long-open view. */
	private applyDueMarks(card: HTMLElement, section: Section, today: { iso: string } | null): void {
		const badge = card.querySelector<HTMLElement>(".sfsc-due-badge");
		const iso = today?.iso ?? mo().format("YYYY-MM-DD");
		const { overdue, dueToday } = this.plugin.settings.dueTaskMarks
			? dueTaskSummary(section.body, iso)
			: { overdue: 0, dueToday: 0 };
		card.toggleClass("has-overdue", overdue > 0);
		card.toggleClass("has-due", overdue === 0 && dueToday > 0);
		if (!badge) return;
		const text = overdue > 0 ? `${overdue} overdue` : dueToday > 0 ? `${dueToday} due today` : "";
		if (badge.textContent !== text) badge.setText(text);
		badge.toggleClass("is-hidden", !text);
	}

	/** The due badge was clicked: bring the card's first overdue task (else its first
	 * task due today) into view and flash it. A collapsed card opens; an owed body
	 * render runs first. */
	private async revealDueTask(card: HTMLElement, section: Section): Promise<void> {
		const entry = this.cardEntries.find((e) => e.el === card);
		if (entry?.renderBody) {
			await this.runBodyRender(entry);
			this.prepareBodies([entry]);
		}
		if (card.hasClass("is-collapsed")) this.setCollapsed(card, section.headingRaw, false);
		const iso = this.todayKeys()?.iso ?? mo().format("YYYY-MM-DD");
		const nth = firstDueTaskIndex(this.cardFaces(section.body).front, iso);
		const bodyEl = card.querySelector<HTMLElement>(".section-card-body");
		if (nth === null || !bodyEl) return;
		const box = Array.from(bodyEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))[nth];
		const line = box?.closest<HTMLElement>("li") ?? box;
		if (!line) return;
		line.scrollIntoView({ block: "center", inline: "nearest" });
		line.addClass("sfsc-task-flash");
		window.setTimeout(() => line.removeClass("sfsc-task-flash"), 1600);
	}

	/** The bottom status bar: which dated cards are hidden (Hide past / future dates), with
	 * a button to show each again. Only where the hide applies — dated notes, not the
	 * Calendar/Heatmap, not the Deck. The pane pads its bottom so the last row can scroll
	 * clear of the bar. */
	private syncDateBar(): void {
		const bar = this.dateBarEl;
		if (!bar) return;
		const hide = this.plugin.getDateHide(this.filePath);
		const show = (hide.future || hide.past) && this.containsDates && this.dateHideApplies() && !this.deckMode;
		bar.toggleClass("is-hidden", !show);
		this.contentEl.toggleClass("has-datebar", show);
		this.positionLevelBar();
		if (!show) return;
		bar.empty();
		fastIcon(bar.createSpan({ cls: "sfsc-datebar-icon" }), "eye-off");
		const what = hide.past && hide.future ? "past and future" : hide.past ? "past" : "future";
		bar.createSpan({ cls: "sfsc-datebar-text", text: `Hiding ${what} dates` });
		const base = this.viewSettings();
		if (hide.past) {
			const btn = bar.createEl("button", { text: "Show past" });
			btn.addEventListener("click", () => void this.plugin.setDateHide(this.filePath, { past: false }, base));
		}
		if (hide.future) {
			const btn = bar.createEl("button", { text: "Show future" });
			btn.addEventListener("click", () => void this.plugin.setDateHide(this.filePath, { future: false }, base));
		}
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
		// Hide future / past dates (menu): a gate on the heading's date, relative to today.
		const hide = this.plugin.getDateHide(this.filePath);
		const dateGate = this.dateGate(hide);
		const revealed: string[] = [];
		for (const entry of this.cardEntries) {
			const section = entry.holder.section;
			const dateOk = !this.dateHiddenAs(section, dateGate);
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
			const hidden = !((!q || text.includes(q)) && starOk && dateOk);
			if (!hidden && entry.el.hasClass("is-filtered-out")) revealed.push(section.headingRaw);
			entry.el.toggleClass("is-filtered-out", hidden);
		}
		this.resolveRevealedOverlaps(revealed);
		// The sticky pinned band collapses when the filter hides everything in it.
		// (Stamped here rather than with a CSS :has(), which lints as a perf hazard.)
		if (this.pinnedEl) {
			const bandCards = Array.from(this.pinnedEl.children).filter((c) =>
				(c as HTMLElement).hasClass("section-card"),
			) as HTMLElement[];
			const anyShown = bandCards.some((c) => !c.hasClass("is-filtered-out"));
			this.pinnedEl.toggleClass("is-all-filtered", bandCards.length > 0 && !anyShown);
		}
		if (this.layout === "rolodex") this.layoutRolodex(); // a hidden active card hands over
		if (this.layout === "planner") this.layoutPlanner();
		this.repack(); // masonry and row rules re-pack around the hidden cards
	}

	/** The hide-future / hide-past gate, or null when nothing is hidden by date here. */
	private dateGate(hide = this.plugin.getDateHide(this.filePath)): DateGate | null {
		return (hide.future || hide.past) && this.containsDates && this.dateHideApplies()
			? {
					past: hide.past,
					future: hide.future,
					today: mo().format("YYYY-MM-DD"),
					format: this.cardFormat(),
					detect: this.plugin.settings.dateDetectFormat,
				}
			: null;
	}

	/** Whether the gate hides this section, and as which kind of date. */
	private dateHiddenAs(section: Section, gate: DateGate | null): "past" | "future" | null {
		if (!gate) return null;
		const iso = titleToIso(section.title, gate.format, gate.detect);
		if (!iso) return null;
		if (gate.future && iso > gate.today) return "future";
		if (gate.past && iso < gate.today) return "past";
		return null;
	}

	/** A body's front and back, per the flip setting (one face, no back, when it's off). */
	private cardFaces(body: string): CardFaces {
		return splitCardFaces(body, this.flipMarker());
	}

	/** The back-side marker in force — empty while Card Flip is off, so nothing splits. */
	private flipMarker(): string {
		const { flipEnabled, flipMarker } = this.plugin.settings;
		return flipEnabled ? flipMarker : "";
	}

	/** In flight while a card's faces are mid-turn, so a double-click can't tangle them. */
	private flipping = new WeakSet<HTMLElement>();

	/** Render a card's back face once (its first showing), whichever path needs it. */
	private async renderBack(backEl: HTMLElement, holder: { section: Section }, file: TFile, scope: Component): Promise<void> {
		if (backEl.dataset.rendered) return;
		backEl.dataset.rendered = "1";
		const back = this.cardFaces(holder.section.body).back ?? "";
		if (back.trim()) {
			await MarkdownRenderer.render(this.app, bodyForRender(back), backEl, file.path, scope);
		} else {
			backEl.createDiv({ cls: "section-card-placeholder", text: "Nothing on the back." });
		}
	}

	/**
	 * Turn a card over (or back): the showing face slides out, the other slides in
	 * from the far side. `to` forces a face (true = back) and is a no-op when the
	 * card already shows it; without it the card toggles. Reduced-motion users get
	 * the swap without the slide.
	 */
	private async flipCard(card: HTMLElement, to?: boolean): Promise<void> {
		const entry = this.cardEntries.find((e) => e.el === card);
		const file = this.getFile();
		if (!entry?.backEl || !file || this.flipping.has(card) || card.hasClass("is-editing")) return;
		const { bodyEl, backEl, holder, scope } = entry;
		const toBack = !card.hasClass("is-flipped");
		if (to !== undefined && to !== toBack) return;
		this.flipping.add(card);
		try {
			// The wall is hidden behind the Day Planner (Flip all cards over from the menu):
			// nothing to slide, and the front measures 0 — a back pinned to that height
			// would come up blank when the next layout reuses the card. Turn it outright.
			if (!card.isShown()) {
				if (toBack) await this.renderBack(backEl, holder, file, scope);
				this.setFlipped(card, holder.section.headingRaw, toBack);
				backEl.setCssStyles({ height: "" });
				return;
			}
			// The card keeps its size through the turn: the back takes the front's exact
			// height (scrolling if it's longer), measured now while the front still shows.
			// It holds that height until it's hidden again (below), so the turn back
			// doesn't reflow the card mid-animation.
			if (toBack) backEl.setCssStyles({ height: `${bodyEl.offsetHeight}px` });
			const animate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			// A slide, not a 3D turn: the showing face slides out one way and the other
			// slides in behind it from the opposite side — leftward to reach the back,
			// rightward to come home. Reads the same on a square Grid card and a
			// pane-wide Horizontal row, where a perspective turn distorted badly. The
			// card clips (overflow hidden), so the faces travel their own full width.
			const slide = (el: HTMLElement, from: string, to: string, fade: [number, number], easing: string) =>
				el.animate(
					[
						{ transform: `translateX(${from})`, opacity: fade[0] },
						{ transform: `translateX(${to})`, opacity: fade[1] },
					],
					{ duration: 140, easing },
				).finished;
			const out = toBack ? "-100%" : "100%";
			const inFrom = toBack ? "100%" : "-100%";
			if (animate) await slide(toBack ? bodyEl : backEl, "0", out, [1, 0.4], "ease-in").catch(() => {});
			if (toBack) await this.renderBack(backEl, holder, file, scope);
			this.setFlipped(card, holder.section.headingRaw, toBack);
			if (!toBack) backEl.setCssStyles({ height: "" });
			if (animate) await slide(toBack ? backEl : bodyEl, inFrom, "0", [0.4, 1], "ease-out").catch(() => {});
		} finally {
			this.flipping.delete(card);
		}
	}

	/** Stamp a card's face: the class the CSS keys on, the button's label, and the
	 * remembered state (in the plugin's data, per note, so it survives closing the note
	 * and switching layouts). */
	private setFlipped(card: HTMLElement, headingRaw: string, flipped: boolean): void {
		card.toggleClass("is-flipped", flipped);
		card.querySelector<HTMLElement>(".section-card-flip")?.setAttr(
			"aria-label",
			flipped ? "Flip back to the front" : "Flip the card over",
		);
		void this.plugin.setCardFlipped(this.filePath, headingRaw, flipped, this.viewSettings());
	}

	/** Fold a card to its title bar (or open it), remember it per note, and re-pack. */
	private setCollapsed(card: HTMLElement, headingRaw: string, collapsed: boolean): void {
		if (card.hasClass("is-editing")) return;
		this.syncCollapseButton(card, collapsed);
		void this.plugin.setCardCollapsed(this.filePath, headingRaw, collapsed, this.viewSettings());
		this.repack();
	}

	/** The collapsed class plus the chevron button's direction and label. */
	private syncCollapseButton(card: HTMLElement, collapsed: boolean): void {
		card.toggleClass("is-collapsed", collapsed);
		const btn = card.querySelector<HTMLElement>(".section-card-collapse");
		if (!btn) return;
		fastIcon(btn, collapsed ? "chevron-down" : "chevron-up");
		btn.setAttr("aria-label", collapsed ? "Expand this card" : "Collapse this card");
	}

	// ---------- multi-select and keyboard focus ----------

	/** Cards that can take focus or a drop: rendered and not hidden by filter, branch, or Rolodex. */
	private visibleEntries(): CardEntry[] {
		return this.cardEntries.filter((e) => {
			if (e.el.hasClass("is-filtered-out") || e.el.hasClass("is-hier-hidden") || e.el.hasClass("is-section-hidden")) return false;
			const r = e.el.getBoundingClientRect();
			return r.width > 0 && r.height > 0;
		});
	}

	private toggleSelected(key: string): void {
		if (this.selected.has(key)) this.selected.delete(key);
		else this.selected.add(key);
		this.applySelectionClasses();
	}

	/** After a re-order (sort, group-by): scroll the focused card — else the first
	 * selected one — back into view, so the card you were working with doesn't vanish. */
	private revealSelection(): void {
		const key = this.focusedKey && this.selected.has(this.focusedKey) ? this.focusedKey : [...this.selected][0] ?? this.focusedKey;
		if (!key) return;
		const hit = this.cardsByHeading.get(key);
		if (!hit) return;
		if (this.isSingleCardLayout()) {
			const entry = this.cardEntries.find((e) => e.el === hit.el);
			if (entry) this.setSingleCardActive(entry);
			return;
		}
		hit.el.scrollIntoView({ block: "center", inline: "center" });
	}

	/** A plain title-bar click: this card alone is selected, and becomes the anchor
	 * (focus) that a later Shift-click ranges from — Explorer-style. */
	private selectOnly(key: string): void {
		this.selected.clear();
		this.selected.add(key);
		this.focusedKey = key;
		this.applySelectionClasses();
	}

	/** Shift-click: select the run of visible cards from the anchor (the focused card)
	 * to this one, replacing the selection; with no anchor, this card starts one. */
	private selectRange(key: string): void {
		const visible = this.visibleEntries().map((e) => e.holder.section.headingRaw);
		const from = this.focusedKey ? visible.indexOf(this.focusedKey) : -1;
		const to = visible.indexOf(key);
		this.selected.clear();
		if (from < 0 || to < 0) {
			this.selected.add(key);
			this.focusedKey = key;
		} else {
			for (let i = Math.min(from, to); i <= Math.max(from, to); i++) this.selected.add(visible[i]);
		}
		this.applySelectionClasses();
	}

	private clearSelection(alsoFocus: boolean): void {
		this.selected.clear();
		if (alsoFocus) this.focusedKey = null;
		this.applySelectionClasses();
	}

	/** Stamp the classes and refresh the action bar; prunes keys whose cards are gone. */
	private applySelectionClasses(): void {
		const present = new Set(this.cardEntries.map((e) => e.holder.section.headingRaw));
		for (const key of [...this.selected]) if (!present.has(key)) this.selected.delete(key);
		if (this.focusedKey && !present.has(this.focusedKey)) this.focusedKey = null;
		for (const entry of this.cardEntries) {
			const key = entry.holder.section.headingRaw;
			entry.el.toggleClass("is-selected", this.selected.has(key));
			entry.el.toggleClass("is-focused", key === this.focusedKey);
		}
		this.renderSelectionBar();
	}

	private setFocus(key: string | null, scroll: boolean): void {
		this.focusedKey = key;
		this.applySelectionClasses();
		if (!key || !scroll) return;
		this.cardsByHeading.get(key)?.el.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	/**
	 * Arrow-key navigation: the nearest visible card in that direction, judged from the
	 * focused card's box (the first visible card when nothing is focused). With `extend`
	 * (Shift) the landing card joins the selection. Returns false when there's nowhere to go.
	 */
	private moveFocus(dir: "left" | "right" | "up" | "down", extend: boolean): boolean {
		const visible = this.visibleEntries();
		if (!visible.length) return false;
		const current = this.focusedKey ? visible.find((e) => e.holder.section.headingRaw === this.focusedKey) : undefined;
		let next: CardEntry | undefined;
		if (!current) {
			next = visible[0];
		} else {
			const a = current.el.getBoundingClientRect();
			const ax = (a.left + a.right) / 2;
			const ay = (a.top + a.bottom) / 2;
			let best = Infinity;
			for (const cand of visible) {
				if (cand === current) continue;
				const b = cand.el.getBoundingClientRect();
				const bx = (b.left + b.right) / 2;
				const by = (b.top + b.bottom) / 2;
				let primary: number;
				let secondary: number;
				if (dir === "left" || dir === "right") {
					primary = dir === "right" ? b.left - a.right : a.left - b.right;
					secondary = Math.abs(by - ay);
					if (primary < -a.width / 2) continue; // not in that direction
				} else {
					primary = dir === "down" ? b.top - a.bottom : a.top - b.bottom;
					secondary = Math.abs(bx - ax);
					if (primary < -a.height / 2) continue;
				}
				const score = Math.max(primary, 0) + secondary * 2.5;
				if (score < best) {
					best = score;
					next = cand;
				}
			}
		}
		if (!next) return false;
		const key = next.holder.section.headingRaw;
		if (extend) {
			if (current) this.selected.add(current.holder.section.headingRaw);
			this.selected.add(key);
		}
		this.setFocus(key, true);
		return true;
	}

	/** The selected sections, in document order. */
	private selectedSections(): Section[] {
		return this.cardEntries
			.filter((e) => this.selected.has(e.holder.section.headingRaw))
			.map((e) => e.holder.section)
			.sort((a, b) => a.startLine - b.startLine);
	}

	/** The bar along the bottom while cards are selected: the count and the bulk actions. */
	private renderSelectionBar(): void {
		const bar = this.selectionBar;
		if (!bar) return;
		const n = this.selected.size;
		bar.toggleClass("is-hidden", n === 0 || this.deckMode);
		if (n === 0) return;
		bar.empty();
		bar.createSpan({ cls: "sfsc-selection-count", text: `${n} selected` });
		const action = (label: string, icon: string, onClick: (evt: MouseEvent) => void) => {
			const btn = bar.createEl("button", { text: label });
			fastIcon(btn.createSpan({ cls: "sfsc-selection-icon" }), icon);
			btn.addEventListener("click", (evt) => onClick(evt));
		};
		const base = this.viewSettings();
		const keys = () => [...this.selected];
		action("Pin", "pin", () => void this.plugin.setPinnedMany(this.filePath, keys(), true, base));
		action("Unpin", "pin-off", () => void this.plugin.setPinnedMany(this.filePath, keys(), false, base));
		action("Color…", "palette", (evt) => this.openColorMenuMany(evt, keys()));
		if (this.selectedSections().some((s) => this.cardsByHeading.get(s.headingRaw) && this.cardEntries.find((e) => e.holder.section === s)?.backEl)) {
			action("Flip", FLIP_ICON, () => this.flipSelected(true));
			action("Unflip", FLIP_ICON, () => this.flipSelected(false));
		}
		action("Delete…", "trash-2", () => this.deleteSelected());
		action("Clear", "x", () => this.clearSelection(true));
	}

	/** The title-bar menu's selection block: act on every selected card, or move the run here. */
	private addSelectionMenuItems(menu: Menu, here: Section): void {
		const n = this.selected.size;
		if (!n) return;
		const base = this.viewSettings();
		const keys = () => [...this.selected];
		menu.addSeparator();
		SectionCardsView.addMenuHeading(menu, `${n} selected`);
		menu.addItem((item) => item.setTitle("Pin selected").setIcon("pin").onClick(() => void this.plugin.setPinnedMany(this.filePath, keys(), true, base)));
		menu.addItem((item) => item.setTitle("Unpin selected").setIcon("pin-off").onClick(() => void this.plugin.setPinnedMany(this.filePath, keys(), false, base)));
		menu.addItem((item) => item.setTitle("Color selected…").setIcon("palette").onClick((evt) => this.openColorMenuMany(evt as MouseEvent, keys())));
		menu.addItem((item) => item.setTitle("Flip selected over").setIcon(FLIP_ICON).onClick(() => this.flipSelected(true)));
		menu.addItem((item) => item.setTitle("Flip selected back").setIcon(FLIP_ICON).onClick(() => this.flipSelected(false)));
		if (!this.selected.has(here.headingRaw) && !here.unfiled) {
			menu.addItem((item) => item.setTitle("Move selected before this card").setIcon("arrow-up-to-line").onClick(() => this.moveSelected(here, true)));
			menu.addItem((item) => item.setTitle("Move selected after this card").setIcon("arrow-down-to-line").onClick(() => this.moveSelected(here, false)));
		}
		menu.addItem((item) => item.setTitle("Delete selected…").setIcon("trash-2").onClick(() => this.deleteSelected()));
		menu.addItem((item) => item.setTitle("Clear selection").setIcon("x").onClick(() => this.clearSelection(true)));
	}

	private openColorMenuMany(evt: MouseEvent, keys: string[]): void {
		const base = this.viewSettings();
		const palette = this.plugin.palette();
		const menu = new Menu();
		CARD_COLORS.forEach(([name], i) => {
			menu.addItem((item) => {
				const title = createFragment();
				title.createSpan({ cls: `sfsc-swatch sfsc-swatch-${name}` });
				title.appendText(palette[i].label);
				item.setTitle(title).onClick(() => void this.plugin.setCardColorMany(this.filePath, keys, name, base));
			});
		});
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("No color").onClick(() => void this.plugin.setCardColorMany(this.filePath, keys, null, base)));
		if (evt.instanceOf(MouseEvent) && evt.clientX) menu.showAtMouseEvent(evt);
		else menu.showAtPosition({ x: window.innerWidth / 2, y: window.innerHeight - 80 });
	}

	private flipSelected(toBack: boolean): void {
		for (const entry of this.cardEntries) {
			if (entry.backEl && this.selected.has(entry.holder.section.headingRaw)) void this.flipCard(entry.el, toBack);
		}
	}

	private deleteSelected(): void {
		const file = this.getFile();
		const targets = this.selectedSections().filter((s) => !s.unfiled);
		if (!file || !targets.length) return;
		new ConfirmDeleteModal(this.app, `${targets.length} selected cards`, async () => {
			const removed = await deleteSectionsInFile(this.app, file, this.headingLevel, targets);
			new Notice(`Deleted ${removed} of ${targets.length} cards from ${file.basename}.`);
			this.clearSelection(true);
			await this.refresh();
		}).open();
	}

	private moveSelected(target: Section, before: boolean): void {
		const file = this.getFile();
		const moved = this.selectedSections().filter((s) => !s.unfiled && s.headingRaw !== target.headingRaw);
		if (!file || !moved.length) return;
		if (this.sortOrder !== "doc") {
			new SwitchToDocumentOrderModal(this.app, SORT_LABELS[this.sortOrder], async () => {
				this.sortOrder = "doc";
				this.rememberView();
				await this.syncView();
				this.app.workspace.requestSaveLayout();
			}).open();
			return;
		}
		void this.completeDragMany(file, moved, target, before);
	}

	private async completeDragMany(file: TFile, moved: Section[], target: Section, before: boolean): Promise<void> {
		const ok = await moveSectionsInFile(this.app, file, this.headingLevel, moved, target, before);
		if (!ok) new Notice("Couldn't reorder — the file changed on disk.");
		await this.refresh();
	}

	/** Turn every two-faced card to its back (true) or front (false). */
	private flipAll(toBack: boolean): void {
		for (const entry of this.cardEntries) {
			if (entry.backEl) void this.flipCard(entry.el, toBack);
		}
	}

	/** Whether any card on the wall has a back to flip to. */
	private anyFlippable(): boolean {
		return this.cardEntries.some((entry) => entry.backEl !== null);
	}

	/** Forget every card's identity so the next refresh rebuilds them all — for
	 * settings that change how a body renders, which card reuse would otherwise keep. */
	invalidateCards(): void {
		for (const entry of this.cardEntries) entry.raw = "\0stale";
	}

	/** Rolodex: the cards a tab can reach — everything the filter hasn't hidden. */
	private roloVisible(): CardEntry[] {
		return this.cardEntries.filter((e) => !e.el.hasClass("is-filtered-out") && !e.el.hasClass("is-hier-hidden"));
	}

	/** Rolodex tab geometry: a tab's minimum width and the strip's gap (both in CSS too). */
	private static readonly ROLO_TAB_MIN = 120;
	private static readonly ROLO_GAP = 4;
	private static readonly ROLO_MAX_ROWS = 4;

	/**
	 * Rolodex layout: one card fills the pane, and every card's title is a tab in the
	 * strip above. The tabs share the width — a lone title spans the strip, two take
	 * half each — and once a row can't hold them at their minimum width the strip
	 * grows to a second row, up to four; past that it scrolls sideways, with edge
	 * indicators for the tabs cut off. Rebuilt on every refresh, filter pass, and
	 * tab pick; a resize recomputes the rows.
	 */
	private layoutRolodex(): void {
		const strip = this.roloTabsEl;
		if (!strip) return;
		const visible = this.roloVisible();
		const remembered = this.roloActive.get(this.filePath);
		const active =
			visible.find((e) => e.holder.section.headingRaw === remembered) ??
			visible.find((e) => e.el.hasClass("is-today")) ??
			visible[0] ??
			null;
		for (const entry of this.cardEntries) entry.el.toggleClass("is-rolo-active", entry === active);
		strip.empty();
		this.roloCells.clear();
		if (!active) {
			this.syncRoloMore();
			return;
		}
		this.roloActive.set(this.filePath, active.holder.section.headingRaw);

		// Rows: as few as hold every tab at its minimum width, capped; columns follow.
		const { ROLO_TAB_MIN: min, ROLO_GAP: gap, ROLO_MAX_ROWS: maxRows } = SectionCardsView;
		const width = strip.clientWidth || this.contentEl.clientWidth;
		this.roloWidth = width;
		const perRow = Math.max(1, Math.floor((width + gap) / (min + gap)));
		const slots = visible.length;
		// The zoom buttons override the automatic row count; either way, no more rows
		// than there are cells to fill them.
		const needed = Math.max(1, Math.ceil(slots / perRow));
		const rows = Math.min(slots, Math.max(1, this.roloRows ?? Math.min(maxRows, needed)));
		this.roloRowsShown = rows;
		if (this.roloZoomBtns) {
			this.roloZoomBtns.fewer.toggleAttribute("disabled", rows <= 1);
			this.roloZoomBtns.more.toggleAttribute("disabled", rows >= slots);
		}
		const cols = Math.ceil(slots / rows);
		strip.setCssProps({ "--rolo-cols": String(cols) });
		const lastRowStart = (rows - 1) * cols;

		visible.forEach((entry, i) => {
			const isActive = entry === active;
			const title = entry.holder.section.title || "(untitled)";
			const cell = strip.createDiv({ cls: "sfsc-rolo-cell" });
			this.roloCells.set(entry, cell);
			cell.toggleClass("is-active", isActive);
			// Rows above the last are full tabs (closed at the bottom); only the last
			// row's tabs open onto the card.
			cell.toggleClass("is-upper", i < lastRowStart);
			const tab = cell.createEl("button", { cls: "sfsc-rolo-tab", text: title });
			tab.toggleClass("is-active", isActive);
			tab.toggleClass("is-today", entry.el.hasClass("is-today"));
			tab.setAttr("aria-label", title);
			// The card's color rides along as a top edge (the card resolves --sfsc-c from
			// its data attribute; the tab borrows the resolved value).
			// The palette lives in --sfsc-color-<name> variables on the body (applyPaletteCss),
			// so the tab can reference the variable directly — no computed-style read, which
			// would force a style flush per colored card while the strip is being built.
			const color = entry.el.getAttribute("data-sfsc-color");
			if (color) {
				tab.setAttr("data-sfsc-color", color);
				tab.setCssProps({ "--sfsc-c": `var(--sfsc-color-${color})` });
			}
			tab.addEventListener("click", () => this.setRoloActive(entry));
			this.wireRoloTabDrag(tab, cell, entry);
		});
		strip.querySelector(".sfsc-rolo-cell.is-active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
		this.syncRoloMore();

		// The showing card's markdown may still be owed from the deferred batches.
		if (active.renderBody) {
			void this.runBodyRender(active).then(() => this.prepareBodies([active]));
		}
	}

	/** Rolodex: show the edge indicators where tabs are cut off (the strip scrolls). */
	private syncRoloMore(): void {
		const strip = this.roloTabsEl;
		const wrap = this.roloWrapEl;
		if (!strip || !wrap) return;
		const overflow = strip.scrollWidth - strip.clientWidth > 2;
		wrap.toggleClass("has-more-left", overflow && strip.scrollLeft > 2);
		wrap.toggleClass("has-more-right", overflow && strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2);
	}

	/** Rolodex: a pane resize can change how many rows the tabs need. */
	private roloRelayout = debounce(
		() => {
			if (this.layout !== "rolodex" || this.deckMode) return;
			const width = this.roloTabsEl?.clientWidth ?? 0;
			if (width && width !== this.roloWidth) this.layoutRolodex();
			else this.syncRoloMore();
		},
		80,
		true,
	);

	/**
	 * Rolodex: drag a tab to move its section in the note — left, right, or into
	 * another row; it lands before or after the tab it's dropped on, by which half of
	 * that tab the pointer is over. Same rule as card drags: document order only.
	 */
	private wireRoloTabDrag(tab: HTMLElement, cell: HTMLElement, entry: CardEntry): void {
		tab.draggable = !entry.holder.section.unfiled;
		tab.addEventListener("dragstart", (evt) => {
			if (entry.holder.section.unfiled || this.activeEditor) {
				evt.preventDefault();
				return;
			}
			evt.stopPropagation();
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
			this.roloDragging = entry;
			cell.addClass("is-dragging");
			if (evt.dataTransfer) {
				evt.dataTransfer.effectAllowed = "move";
				evt.dataTransfer.setData("text/plain", entry.holder.section.headingRaw);
			}
		});
		tab.addEventListener("dragend", () => {
			cell.removeClass("is-dragging");
			this.setRoloDrop(null, false);
			this.roloDragging = null;
		});
		tab.addEventListener("dragover", (evt) => {
			// A paragraph or task dragged off the showing card: the tab stands in for
			// the card it names (the only way to reach another card here), taking the
			// block at that card's end.
			if (this.draggingBlock) {
				if (this.draggingBlock.holder === entry.holder) return;
				evt.preventDefault();
				if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
				this.clearBlockDropMarks();
				cell.addClass("sc-blockdrop-end");
				this.blockDropEndEl = cell;
				return;
			}
			const from = this.roloDragging;
			if (!from || from === entry || entry.holder.section.unfiled) return;
			evt.preventDefault();
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
			const rect = tab.getBoundingClientRect();
			this.setRoloDrop(cell, evt.clientX < rect.left + rect.width / 2);
		});
		tab.addEventListener("dragleave", () => {
			if (this.blockDropEndEl === cell) this.clearBlockDropMarks();
		});
		tab.addEventListener("drop", (evt) => {
			if (this.draggingBlock) {
				const block = this.draggingBlock;
				if (block.holder === entry.holder) return;
				evt.preventDefault();
				evt.stopPropagation();
				this.draggingBlock = null;
				this.clearBlockDropMarks();
				block.el.removeClass("is-dragging-block");
				const file = this.getFile();
				if (file) {
					void this.completeBlockDrag(
						file,
						{ section: block.holder.section, blockIndex: block.blockIndex, blockText: block.blockText },
						entry.holder.section,
						null,
					);
				}
				return;
			}
			const from = this.roloDragging;
			if (!from || from === entry || entry.holder.section.unfiled) return;
			evt.preventDefault();
			evt.stopPropagation();
			const rect = tab.getBoundingClientRect();
			const before = evt.clientX < rect.left + rect.width / 2;
			this.setRoloDrop(null, false);
			this.roloDragging = null;
			const file = this.getFile();
			if (file) void this.completeDrag(file, from.holder.section, entry.holder.section, before);
		});
	}

	private setRoloDrop(cell: HTMLElement | null, before: boolean): void {
		if (this.roloDropCell && this.roloDropCell !== cell) {
			this.roloDropCell.removeClass("sc-drop-before");
			this.roloDropCell.removeClass("sc-drop-after");
		}
		this.roloDropCell = cell;
		if (!cell) return;
		cell.toggleClass("sc-drop-before", before);
		cell.toggleClass("sc-drop-after", !before);
	}

	/** Rolodex: turn to a card (its tab, or `,`/`.`). With the strip already built for
	 * this set of cards, only the two cells and two cards change class — rebuilding a
	 * thousand tabs per click was the cost that made switching feel sticky on big notes. */
	private setRoloActive(entry: CardEntry): void {
		this.roloActive.set(this.filePath, entry.holder.section.headingRaw);
		const cell = this.roloCells.get(entry);
		const current = this.cardEntries.find((e) => e.el.hasClass("is-rolo-active"));
		if (!cell || !current || !this.roloCells.has(current)) {
			this.layoutRolodex();
			return;
		}
		if (current !== entry) {
			const was = this.roloCells.get(current);
			was?.removeClass("is-active");
			was?.querySelector(".sfsc-rolo-tab")?.removeClass("is-active");
			current.el.removeClass("is-rolo-active");
		}
		cell.addClass("is-active");
		cell.querySelector(".sfsc-rolo-tab")?.addClass("is-active");
		entry.el.addClass("is-rolo-active");
		cell.scrollIntoView({ inline: "nearest", block: "nearest" });
		this.syncRoloMore();
		if (entry.renderBody) void this.runBodyRender(entry).then(() => this.prepareBodies([entry]));
	}

	/** Rolodex: the previous/next card in the strip, wrapping around like a rolodex ring. */
	private stepRolodex(delta: number): void {
		const visible = this.roloVisible();
		if (!visible.length) return;
		const at = visible.findIndex((e) => e.el.hasClass("is-rolo-active"));
		const next = ((at < 0 ? 0 : at + delta) + visible.length) % visible.length;
		this.setRoloActive(visible[next]);
	}

	/** setIcon with a fallback name: Lucide renamed some icons (plus-square → square-plus),
	 * and which one Obsidian's bundled set knows depends on its version. */
	private static setIconOr(el: HTMLElement, icon: string, fallback: string): void {
		fastIcon(el, icon);
		if (!el.querySelector("svg")) fastIcon(el, fallback);
	}

	/**
	 * The Card level changed (dropdown or 1–6). The Day Planner then turns to the card
	 * at the new level holding today's date, else the one that contains what was
	 * showing (going up a level) or the first card inside it (going down) — rather than
	 * dropping to whatever happens to come first.
	 */
	private async changeHeadingLevel(level: number): Promise<void> {
		const wasPlanner = this.layout === "planner";
		const remembered = this.roloActive.get(this.filePath);
		const prev = wasPlanner ? this.cardEntries.find((e) => this.plannerKey(e) === remembered)?.holder.section ?? null : null;
		this.headingLevel = level;
		this.rememberView();
		this.populateLevelOptions();
		await this.refresh();
		if (wasPlanner && this.layout === "planner") this.plannerFollowLevelChange(prev);
		this.app.workspace.requestSaveLayout();
	}

	private plannerFollowLevelChange(prev: Section | null): void {
		const visible = this.roloVisible().filter((e) => !e.holder.section.unfiled);
		if (!visible.length) return;
		const contains = (s: Section, line: number) => line >= s.startLine && line < s.endLine;
		// Today's heading, at whatever level the note writes its days.
		const today = this.todayKeys();
		const todayLine = today
			? parseAncestorHeadings(this.noteLines, 7).find((h) => isTodayTitle(h.title, today.iso, today.formatted))?.line ?? -1
			: -1;
		let pick = todayLine >= 0 ? visible.find((e) => contains(e.holder.section, todayLine)) : undefined;
		if (!pick && prev) {
			pick =
				visible.find((e) => contains(e.holder.section, prev.headingLine)) ??
				visible.find((e) => contains(prev, e.holder.section.headingLine));
		}
		if (pick && this.plannerKey(pick) !== this.roloActive.get(this.filePath)) this.setPlannerActive(pick);
	}

	/** Rolodex or Day Planner: turn to a card, whichever of the two is showing. */
	private setSingleCardActive(entry: CardEntry): void {
		if (this.layout === "rolodex") this.setRoloActive(entry);
		else if (this.layout === "planner") this.setPlannerActive(entry);
	}

	// ---------- Day Planner: one card, its lines as cards in two columns ----------

	/** Day Planner: turn to a card (an arrow, ← / →, or `,` / `.`). A card the filter
	 * box hides stays put, with a word about why — the planner would otherwise fall
	 * back to today and look stuck. (Hide future / past dates doesn't apply here.) */
	private setPlannerActive(entry: CardEntry): void {
		if (entry.el.hasClass("is-filtered-out")) {
			new Notice(`“${entry.holder.section.title || "(untitled)"}” is hidden by the filter.`);
			return;
		}
		this.roloActive.set(this.filePath, this.plannerKey(entry));
		this.layoutPlanner();
	}

	/**
	 * How the planner remembers which card it's on. The heading line alone isn't
	 * enough: a week that straddles two months is written under both, so the same
	 * heading appears twice and stepping onto the second would resolve back to the
	 * first. Duplicates get their occurrence appended; the first keeps the bare
	 * heading, which the Rolodex (sharing the memory) still understands.
	 */
	private plannerKey(entry: CardEntry): string {
		const raw = entry.holder.section.headingRaw;
		let n = 0;
		for (const other of this.cardEntries) {
			if (other === entry) break;
			if (other.holder.section.headingRaw === raw) n++;
		}
		return n ? `${raw}\u0000${n}` : raw;
	}

	/** Day Planner: the previous/next card as the wall is sorted — no wrap-around,
	 * since a planner's days run in a line. */
	private stepPlanner(delta: number): void {
		const visible = this.roloVisible();
		if (!visible.length) return;
		const remembered = this.roloActive.get(this.filePath);
		const at = visible.findIndex((e) => this.plannerKey(e) === remembered);
		// A level of days, weeks, months, or years steps by that unit — → always forward
		// in time, ← back, whatever the sort — offering to create a missing one.
		const period = at >= 0 ? this.plannerPeriod(visible[at].holder.section) : null;
		if (period) {
			const target = { ...period, key: shiftPeriod(period.key, period.role, delta) };
			if (period.role === "day") target.key = this.plannerDayShift(period.key, delta);
			const entry = this.plannerPeriodEntry(target);
			if (entry) this.setPlannerActive(entry);
			else this.promptPlannerMissing(target, delta > 0 ? 1 : -1);
			return;
		}
		// Text levels step through the note's own order (or alphanumeric, when the level
		// is set up that way) — not the wall's sort.
		const order = this.plannerOrder(visible);
		const from = at < 0 ? -1 : order.indexOf(visible[at]);
		const next = Math.max(0, Math.min(order.length - 1, (from < 0 ? 0 : from) + delta));
		if (next !== from && order[next]) this.setPlannerActive(order[next]);
	}

	/** The planner's cards in document order, the properties card left out. */
	private plannerDocOrder(visible: CardEntry[]): CardEntry[] {
		return visible
			.filter((e) => !e.holder.section.properties)
			.sort((a, b) => a.holder.section.headingLine - b.holder.section.headingLine);
	}

	/**
	 * The body the planner works from, and its cards. A card with headings beneath it
	 * uses its whole body — a Card Flip marker inside one of its subcards belongs to
	 * that subcard (a month card would otherwise lose every day after the first flipped
	 * one). A card with no headings shows its front face only, like the wall does.
	 */
	private plannerLines(section: Section): { lines: string[]; cards: PlannerCard[] } {
		const full = section.body.split("\n");
		const cards = plannerCards(full);
		if (cards.some((c) => c.kind === "sub")) return { lines: full, cards };
		const front = this.cardFaces(section.body).front.split("\n");
		return { lines: front, cards: plannerCards(front) };
	}

	/** What the note's headings look like they hold, level by level (Document setup's defaults). */
	private detectedLevels(): DocumentLevels {
		return detectLevelSetup(this.noteLines, this.cardFormat(), this.plugin.settings.dateDetectFormat, this.containsDates);
	}

	/** The Document setup for a level: saved for this note, else as detected. */
	private levelSetup(level = this.headingLevel): LevelSetup {
		return this.plugin.getDocumentLevels(this.filePath)?.[String(level)] ?? this.detectedLevels()[String(level)] ?? { role: "text" };
	}

	/** Day Planner: the period a card's heading names at this level's role — a day
	 * (the note's date spelling), or a year/month/week in the setup's format — as a
	 * canonical key; null for text levels or a title that doesn't fit. */
	private plannerPeriod(section: Section): PlannerPeriod | null {
		const setup = this.levelSetup();
		if (setup.role === "day") {
			const iso = titleToIso(section.title, this.cardFormat(), this.plugin.settings.dateDetectFormat);
			return iso ? { role: "day", key: iso, format: this.cardFormat() } : null;
		}
		if (setup.role === "year" || setup.role === "month" || setup.role === "week") {
			const format = setup.format ?? PERIOD_FORMATS[setup.role][0];
			const key = parsePeriod(section.title, setup.role, format);
			return key ? { role: setup.role, key, format } : null;
		}
		return null;
	}

	/** The period's title as this note writes it. */
	private plannerPeriodTitle(period: PlannerPeriod): string {
		if (period.role === "day") return mo(period.key, "YYYY-MM-DD").format(this.cardFormat());
		return formatPeriod(period.key, period.role, period.format);
	}

	/** The card whose heading names this period, if the note has one (hidden or not — a
	 * filtered-out card must still be found, or it would be offered for creation twice). */
	private plannerPeriodEntry(period: PlannerPeriod): CardEntry | null {
		if (period.role === "day") return this.plannerDayEntry(period.key);
		const exact = this.cardEntries.find((e) => parsePeriod(e.holder.section.title, period.role, period.format) === period.key);
		if (exact || period.role !== "month") return exact ?? null;
		// A month heading written without its year ("# August" among "# September 2026"
		// and "# July 2026") still names the month: take it when the nearest month card
		// around it in the note carries the target year — or when it's the only one.
		const month = Number(period.key.slice(5, 7));
		const year = period.key.slice(0, 4);
		const bare = this.cardEntries.filter((e) => bareMonthIndex(e.holder.section.title) === month);
		if (!bare.length) return null;
		if (bare.length === 1) return bare[0];
		for (const candidate of bare) {
			const at = this.cardEntries.indexOf(candidate);
			for (const step of [-1, 1]) {
				for (let i = at + step; i >= 0 && i < this.cardEntries.length; i += step) {
					const key = parsePeriod(this.cardEntries[i].holder.section.title, "month", period.format);
					if (!key) continue;
					if (key.slice(0, 4) === year) return candidate;
					break;
				}
			}
		}
		return null;
	}

	/** The planner's cards in the order the arrows walk them for a text level: the
	 * note's own order, or alphanumeric when the level is set up that way. */
	private plannerOrder(visible: CardEntry[]): CardEntry[] {
		const order = this.plannerDocOrder(visible);
		if (this.levelSetup().role === "alpha") {
			order.sort((a, b) => alphanumericCompare(a.holder.section.title, b.holder.section.title));
		}
		return order;
	}

	private plannerDayShift(iso: string, days: number): string {
		const dt = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
	}

	/**
	 * The arrow landed on a period with no card: offer to create it, or to skip on to
	 * the nearest period that does have one in that direction (when there is one).
	 */
	private promptPlannerMissing(period: PlannerPeriod, direction: 1 | -1): void {
		const title = this.plannerPeriodTitle(period);
		// The cards of this role in that direction, nearest first (keys sort in time).
		const keyOf = (entry: CardEntry) => this.plannerPeriod(entry.holder.section)?.key ?? null;
		const ahead = this.roloVisible()
			.map((entry) => ({ entry, key: keyOf(entry) }))
			.filter((d): d is { entry: CardEntry; key: string } => !!d.key && (direction > 0 ? d.key > period.key : d.key < period.key))
			.sort((a, b) => (direction > 0 ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key)));
		const skipTo = ahead[0]?.entry ?? null;
		new PlannerMissingDayModal(
			this.app,
			periodUnit(period.role),
			title,
			skipTo ? skipTo.holder.section.title || "(untitled)" : null,
			() => (period.role === "day" ? this.createDateCard(period.key) : this.createTitledCard(title)),
			() => {
				if (skipTo) this.setPlannerActive(skipTo);
			},
		).open();
	}

	/**
	 * Rename a card: rewrite its heading line's text (the #'s stay, so the level does),
	 * body untouched. Pins, colors, canvas placements, and planner slots are keyed by
	 * the heading line and follow it; so does the Rolodex/planner's remembered card.
	 */
	private promptRenameCard(section: Section): void {
		if (section.unfiled) return;
		new TextInputModal(this.app, "Rename card", section.title, "Rename", (value) => {
			const title = value.trim();
			if (!title || title === section.title) return;
			void (async () => {
				const file = this.getFile();
				if (!file) return;
				const hashes = /^#+/.exec(section.headingRaw)?.[0] ?? "#".repeat(this.headingLevel);
				const newHeading = `${hashes} ${title}`;
				const ok = await retitleSectionInFile(this.app, file, this.headingLevel, section, newHeading);
				if (!ok) {
					new Notice("Couldn't find that card — the file changed on disk.");
					await this.refresh();
					return;
				}
				await this.plugin.renameCardKey(file.path, section.headingRaw, newHeading);
				const placed = this.customPlacements[section.headingRaw];
				if (placed) {
					this.customPlacements[newHeading] = placed;
					delete this.customPlacements[section.headingRaw];
				}
				if (this.roloActive.get(this.filePath) === section.headingRaw) this.roloActive.set(this.filePath, newHeading);
				await this.refresh();
			})();
		}).open();
	}

	/** Write a card with this title at the view's level (template applied, default
	 * placement) and turn the planner to it. */
	private async createTitledCard(title: string): Promise<void> {
		const file = this.getFile();
		if (!file) return;
		const headingRaw = `${"#".repeat(this.headingLevel)} ${title}`;
		const body = await this.plugin.loadTemplateBody(file.path, title);
		await insertSection(this.app, file, headingRaw, this.plugin.settings.newCardPlacement, body ?? undefined);
		this.roloActive.set(this.filePath, headingRaw);
		await this.refresh();
	}

	/** The card whose heading names this day, if the note has one (hidden or not — a
	 * filtered-out day must still be found, or it would be offered for creation twice). */
	private plannerDayEntry(iso: string): CardEntry | null {
		const formatted = mo(iso, "YYYY-MM-DD").format(this.cardFormat());
		const detect = this.plugin.settings.dateDetectFormat;
		return (
			this.cardEntries.find((e) => isTodayTitle(e.holder.section.title, iso, formatted)) ??
			(detect
				? this.cardEntries.find((e) => titleToIso(e.holder.section.title, this.cardFormat(), detect) === iso)
				: undefined) ??
			null
		);
	}

	/** Tear the planner down: its markdown scope, resize watcher, and DOM. */
	private clearPlanner(): void {
		if (this.plannerScope) {
			this.removeChild(this.plannerScope);
			this.plannerScope = null;
		}
		this.plannerObserver?.disconnect();
		this.plannerObserver = null;
		this.plannerDropEl = null;
		this.plannerDrag = null;
		this.plannerHeading = null;
		if (this.plannerEl?.childElementCount) this.plannerEl.empty();
	}

	/**
	 * Day Planner: the showing card's title in large type between arrows to its
	 * neighbours, and its contents as cards in two columns — left unless dragged right —
	 * in document order. Above the card's first sub-heading every task or paragraph is a
	 * line card; each sub-heading (H4 under an H3 card, say) with what's beneath it is a
	 * subcard, titled by the heading. Cards resize vertically (the browser's grip); the
	 * column and height are kept per note, keyed by the card's text. Rebuilt whole on
	 * every refresh, filter pass, and turn; the DOM is small, so nothing is reused.
	 */
	private layoutPlanner(): void {
		const root = this.plannerEl;
		if (!root || this.layout !== "planner") return;
		this.clearPlanner();
		const file = this.getFile();
		const visible = this.roloVisible();
		const remembered = this.roloActive.get(this.filePath);
		// Opening on the properties or unfiled card would show YAML or a preamble as
		// line cards: the first real card is the fallback.
		const active =
			visible.find((e) => this.plannerKey(e) === remembered) ??
			visible.find((e) => e.el.hasClass("is-today")) ??
			visible.find((e) => !e.holder.section.unfiled) ??
			visible[0] ??
			null;
		// No headings at this level (H2 picked in a note of H1 months and H3 days): say
		// so, and show every section the note does have as a card beneath.
		if (file && !this.cardEntries.some((e) => !e.holder.section.unfiled) && this.noteLines.some((l) => HEADING_RE.test(l))) {
			this.buildPlannerWholeNote(root, file);
			return;
		}
		if (!active || !file) {
			root.createDiv({
				cls: "section-cards-empty",
				text: this.cardEntries.length ? "Every card is hidden by the filter." : "No cards to plan — add a heading to the note.",
			});
			return;
		}
		const section = active.holder.section;
		this.roloActive.set(this.filePath, this.plannerKey(active));
		this.plannerHeading = section.headingRaw;
		this.buildPlannerCard(root, file, active, section);
	}

	/** The showing card's head (arrows, title, strip) and its columns. */
	private buildPlannerCard(root: HTMLElement, file: TFile, active: CardEntry, section: Section): void {
		const visible = this.roloVisible();
		// At a level of days, weeks, months, or years the arrows step by that unit — ←
		// back in time, → forward, whatever the sort: the neighbouring period's card, or
		// an offer to create it. At a text level, by card in the note's order (or the
		// alphanumeric order the Document setup asks for).
		const period = this.plannerPeriod(section);
		const neighbourOf = (dir: "prev" | "next"): { entry: CardEntry | null; create: PlannerPeriod | null } => {
			if (period) {
				const delta = dir === "next" ? 1 : -1;
				const target = { ...period, key: period.role === "day" ? this.plannerDayShift(period.key, delta) : shiftPeriod(period.key, period.role, delta) };
				const entry = this.plannerPeriodEntry(target);
				return { entry, create: entry ? null : target };
			}
			const order = this.plannerOrder(visible);
			const from = order.indexOf(active);
			const index = dir === "prev" ? from - 1 : from + 1;
			return { entry: (from >= 0 ? order[index] : null) ?? null, create: null };
		};

		// Cards: lines above the first sub-heading, then one subcard per sub-heading.
		const { lines: front, cards } = this.plannerLines(section);

		// Head: an arrow to each neighbour with the title between.
		const head = root.createDiv({ cls: "sfsc-planner-head" });
		const arrow = (dir: "prev" | "next") => {
			const { entry: neighbour, create } = neighbourOf(dir);
			const btn = head.createEl("button", { cls: `sfsc-planner-arrow is-${dir}` });
			fastIcon(btn, dir === "prev" ? "chevron-left" : "chevron-right");
			const word = dir === "prev" ? "Previous" : "Next";
			const key = dir === "prev" ? "←" : "→";
			const unit = period ? periodUnit(period.role) : "card";
			if (create) {
				btn.setAttr("aria-label", `${word} ${unit}: ${this.plannerPeriodTitle(create)} — no card yet, click to create it (${key})`);
				btn.addClass("is-create");
				btn.addEventListener("click", () => this.promptPlannerMissing(create, dir === "next" ? 1 : -1));
				return;
			}
			const title = neighbour?.holder.section.title || "(untitled)";
			btn.setAttr("aria-label", neighbour ? `${word} ${unit}: ${title} (${key})` : `No ${word.toLowerCase()} card`);
			btn.toggleAttribute("disabled", !neighbour);
			if (!neighbour) return;
			btn.addEventListener("click", () => this.setPlannerActive(neighbour));
			// A card dragged onto an arrow lands at that neighbour's end: the planner's
			// way of pushing something to tomorrow (or back to yesterday).
			btn.addEventListener("dragover", (evt) => {
				if (!this.plannerDrag) return;
				evt.preventDefault();
				if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
				btn.addClass("is-drop");
			});
			btn.addEventListener("dragleave", () => btn.removeClass("is-drop"));
			btn.addEventListener("drop", (evt) => {
				const drag = this.plannerDrag;
				btn.removeClass("is-drop");
				if (!drag) return;
				evt.preventDefault();
				evt.stopPropagation();
				this.plannerDrag = null;
				void this.sendPlannerCard(file, section, drag, neighbour.holder.section);
			});
		};
		arrow("prev");
		const titleWrap = head.createDiv({ cls: "sfsc-planner-title-wrap" });
		const titleEl = titleWrap.createDiv({ cls: "sfsc-planner-title", text: section.title || "(untitled)" });
		titleEl.toggleClass("is-today", active.el.hasClass("is-today"));
		if (!section.unfiled) {
			titleEl.addEventListener("contextmenu", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				const menu = new Menu();
				menu.addItem((item) => item.setTitle("Rename card…").setIcon("pencil").onClick(() => this.promptRenameCard(section)));
				this.addFeedItem(menu, section);
				this.addStickyItems(menu, file, section);
				menu.showAtMouseEvent(evt);
			});
		}
		// The card's color paints the title bar (the per-color CSS variables key off the
		// attribute, as on the cards).
		const color = active.el.getAttribute("data-sfsc-color");
		if (color) head.setAttr("data-sfsc-color", color);
		// The card's action strip, always showing beneath the title: add a subsection,
		// color, delete, and open in the note. (Big, pin, collapse, and flip have no meaning here.)
		const actions = titleWrap.createDiv({ cls: "sfsc-planner-actions" });
		const action = (cls: string, icon: string, label: string, onClick: (evt: MouseEvent) => void) => {
			const btn = actions.createEl("button", { cls });
			SectionCardsView.setIconOr(btn, icon, "plus-square");
			btn.setAttr("aria-label", label);
			btn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				onClick(evt);
			});
		};
		// Not the cards' quick add: this adds a subsection — a heading one level below the
		// card (or at the level its subcards already use), at the card's end — which shows
		// up as a new subcard.
		const subLevel = Math.min(6, cards.find((c) => c.kind === "sub")?.level ?? this.headingLevel + 1);
		// The box opens with the sub-heading's #'s in place: keep them and a subsection is
		// appended to the card's end; delete them and the text lands above the first
		// sub-heading, among the card's loose lines.
		action("sfsc-planner-addsub", "square-plus", `Add text or a subsection (H${subLevel}) to this card`, () => {
			const hashes = `${"#".repeat(subLevel)} `;
			new TextInputModal(
				this.app,
				`New text or subsection in “${section.title || "(untitled)"}”`,
				hashes,
				"Add",
				(value) => {
					const text = value.trim();
					if (!text || /^#+$/.test(text)) return;
					void (async () => {
						const ok = HEADING_RE.test(text)
							? await pasteAtSectionEnd(this.app, file, this.headingLevel, section, text)
							: await pasteAboveSubheadings(this.app, file, this.headingLevel, section, text);
						if (!ok) new Notice("Couldn't find that section — the file changed on disk.");
						await this.refresh();
					})();
				},
				false,
			).open();
		});
		action("section-card-color", "palette", "Set this card's color", (evt) => this.openColorMenu(evt, file, section.headingRaw));
		action("section-card-delete", "trash-2", "Delete this card", () => {
			new ConfirmDeleteModal(this.app, section.title || "(untitled)", async () => {
				const ok = await deleteSection(this.app, file, this.headingLevel, section);
				if (ok) new Notice(`Deleted “${section.title || "(untitled)"}” from ${file.basename}`);
				else new Notice("Couldn't find that section — the file changed on disk.");
				await this.refresh();
			}).open();
		});
		if (this.stickyOffered(section)) {
			action("sfsc-planner-sticky", "sticky-note", "Open in a sticky window", () => void this.plugin.openSticky(file.path, section.headingRaw));
		}
		action("section-card-open", "external-link", "Open this section in the note", () => {
			void this.plugin.revealSection(file, section.headingLine);
		});
		arrow("next");

		this.renderPlannerCards(root, file, section, front, cards);
	}

	/**
	 * The planner with no card at this level: a "No Hn headings" title between dead
	 * arrows, a button that adds the first Hn section, and every section the note has —
	 * at any level — as a card in the columns, working on the whole note as the card.
	 */
	private buildPlannerWholeNote(root: HTMLElement, file: TFile): void {
		const section = wholeNoteSection(this.noteLines);
		this.plannerHeading = section.headingRaw;
		const level = this.headingLevel;
		const head = root.createDiv({ cls: "sfsc-planner-head" });
		const dead = (dir: "prev" | "next") => {
			const btn = head.createEl("button", { cls: `sfsc-planner-arrow is-${dir}` });
			fastIcon(btn, dir === "prev" ? "chevron-left" : "chevron-right");
			btn.setAttr("aria-label", `No H${level} cards to step through`);
			btn.toggleAttribute("disabled", true);
		};
		dead("prev");
		const titleWrap = head.createDiv({ cls: "sfsc-planner-title-wrap" });
		titleWrap.createDiv({ cls: "sfsc-planner-title is-missing", text: `No H${level} headings in this note` });
		titleWrap.createDiv({ cls: "sfsc-planner-subtitle", text: "Every section the note does have, as cards" });
		const actions = titleWrap.createDiv({ cls: "sfsc-planner-actions" });
		const addBtn = actions.createEl("button", { cls: "sfsc-planner-addsub" });
		SectionCardsView.setIconOr(addBtn, "square-plus", "plus-square");
		addBtn.setAttr("aria-label", `Add an H${level} section at the note's end`);
		addBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			new TextInputModal(this.app, `New H${level} section`, "", "Add", (title) => {
				const text = title.trim();
				if (!text) return;
				void (async () => {
					const ok = await pasteAtSectionEnd(this.app, file, level, section, `${"#".repeat(level)} ${text}`);
					if (!ok) new Notice("Couldn't write to the note.");
					await this.refresh();
				})();
			}).open();
		});
		dead("next");
		const { lines: front, cards } = this.plannerLines(section);
		this.renderPlannerCards(root, file, section, front, cards);
	}

	/** The two columns of cards for `section`, whose body is `front` split into `cards`. */
	private renderPlannerCards(
		root: HTMLElement,
		file: TFile,
		section: Section,
		front: string[],
		cards: PlannerCard[],
	): void {
		const taskLines = taskLineIndexes(front);
		const today = this.todayKeys();
		const slots = this.plugin.getPlanner(this.filePath)[section.headingRaw] ?? {};
		const scope = new Component();
		this.addChild(scope);
		this.plannerScope = scope;
		const colsEl = root.createDiv({ cls: "sfsc-planner-cols" });
		const cols = ([0, 1] as const).map((col) => {
			const el = colsEl.createDiv({ cls: "sfsc-planner-col" });
			this.wirePlannerColumn(el, col, file, section);
			return el;
		});
		// Columns: placed cards keep theirs; the rest flow to balance the two columns.
		const texts = cards.map((card) => front.slice(card.start, card.end).join("\n"));
		const keys = texts.map((text) => plannerBlockKey(text));
		const columns = plannerColumnSplit(
			cards.map((card, i) => {
				const slot = slots[keys[i]];
				return { col: slot?.col, weight: plannerCardWeight(front, card, slot?.h) };
			}),
		);
		this.plannerItems = cards.map((card, index) => {
			// A subcard's editable text stops at its last non-blank line; the blank lines
			// that separate it from the next heading stay put when it's rewritten.
			let editEnd = card.end;
			while (editEnd > card.start + 1 && front[editEnd - 1].trim() === "") editEnd--;
			const text = texts[index];
			const key = keys[index];
			const slot = slots[key];
			const col = columns[index];
			const item = cols[col].createDiv({ cls: `sfsc-planner-item markdown-rendered is-${card.kind}` });
			item.dataset.index = String(index);
			item.dataset.key = key;
			if (slot?.h) item.setCssStyles({ height: `${slot.h}px` });
			const ctx: PlannerItem = {
				el: item,
				card,
				text,
				editText: card.kind === "line" ? text : front.slice(card.start, editEnd).join("\n"),
				editEnd,
				key,
				col,
				// Checkbox n of this card is task line (tasks before it + n) of the section.
				tasksBefore: taskLines.filter((line) => line < card.start).length,
				slot,
			};
			// Subcards are titled by their heading; the loose card by the unfiled card's name.
			if (card.kind === "loose") item.createDiv({ cls: "sfsc-planner-item-title", text: this.plannerLooseTitle() });
			if (card.kind === "sub") {
				item.createDiv({ cls: "sfsc-planner-item-title", text: card.title || "(untitled)" });
				// In a dated note, today's subcard (a day under a month card, say) is lit
				// the way today's card is on the wall — as is the week card holding today.
				const namesToday = (line: string) => !!today && isTodayTitle(line, today.iso, today.formatted);
				const holdsToday =
					namesToday(card.title ?? "") ||
					front.slice(card.start + 1, card.end).some((line) => {
						const m = HEADING_RE.exec(line);
						return !!m && namesToday(m[2].trim());
					});
				if (holdsToday) item.addClass("is-today");
			}
			const body = item.createDiv({ cls: "sfsc-planner-item-body" });
			const markdown =
				card.kind === "sub"
					? front.slice(card.start + 1, editEnd).join("\n")
					: card.kind === "loose"
						? front.slice(card.start, editEnd).join("\n")
						: text;
			if (markdown.trim()) {
				void MarkdownRenderer.render(this.app, bodyForRender(markdown), body, file.path, scope).then(() => {
					// Rendered task checkboxes come back disabled, and disabled inputs never fire clicks.
					for (const box of Array.from(body.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))) {
						box.removeAttribute("disabled");
						box.removeAttribute("readonly");
					}
				});
			}
			this.wireLinkClicks(body, file);
			this.wirePlannerItem(item, body, file, section, ctx);
			return ctx;
		});

		// The browser's resize grip writes an inline height; the observer saves it.
		if (typeof ResizeObserver !== "undefined") {
			const observer = new ResizeObserver(() => this.plannerHeightsChanged());
			for (const { el } of this.plannerItems) observer.observe(el);
			this.plannerObserver = observer;
		}
	}

	/** Drag, checkbox, double-click edit, and right-click menu for one planner card. */
	private wirePlannerItem(item: HTMLElement, body: HTMLElement, file: TFile, section: Section, ctx: PlannerItem): void {
		const { card, text, key, col, slot } = ctx;
		item.draggable = true;
		item.addEventListener("dragstart", (evt) => {
			const target = evt.target as HTMLElement | null;
			if (target?.closest("a")) return; // native link dragging stays native
			// The bottom-right corner is the resize grip: a press there resizes, never drags.
			const rect = item.getBoundingClientRect();
			if (evt.clientX > rect.right - 20 && evt.clientY > rect.bottom - 20) {
				evt.preventDefault();
				return;
			}
			evt.stopPropagation();
			this.plannerDrag = ctx;
			item.addClass("is-dragging-block");
			if (evt.dataTransfer) {
				evt.dataTransfer.effectAllowed = "move";
				evt.dataTransfer.setData("text/plain", text);
			}
		});
		item.addEventListener("dragend", () => {
			item.removeClass("is-dragging-block");
			this.plannerDrag = null;
			this.clearPlannerDropMarks();
		});
		const toggle = (box: HTMLInputElement) => {
			const boxes = Array.from(body.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
			const nth = boxes.indexOf(box);
			if (nth >= 0) void this.toggleNthTask(file, section, ctx.tasksBefore + nth, box, item);
		};
		item.addEventListener("click", (evt) => {
			const box = (evt.target as HTMLElement).closest<HTMLInputElement>("input[type=checkbox]");
			if (!box) return;
			evt.preventDefault();
			evt.stopPropagation();
			toggle(box);
		});
		const edit = () => {
			if (card.kind === "line") {
				this.openEditBlockModal(file, section, card.blockIndex ?? 0, text);
				return;
			}
			new EditBlockModal(this.plugin, ctx.editText, async (newText) => {
				const ok = await replaceRangeInFile(this.app, file, this.headingLevel, section, card.start, ctx.editEnd, ctx.editText, newText);
				if (!ok) new Notice("Couldn't find that text — the file changed on disk.");
				await this.refresh();
			}).open();
		};
		item.addEventListener("dblclick", (evt) => {
			if ((evt.target as HTMLElement).closest("a, input")) return;
			evt.preventDefault();
			evt.stopPropagation();
			edit();
		});
		// The menu leads with the planner's own items — column and height — then the
		// line menu for a line, or edit/copy for a subcard.
		const prepend = (menu: Menu) => {
			menu.addItem((mi) =>
				mi
					.setTitle(col === 0 ? "Move to right column" : "Move to left column")
					.setIcon(col === 0 ? "arrow-right" : "arrow-left")
					.onClick(() => void this.updatePlannerSlot(section.headingRaw, key, (slot) => ({ ...slot, col: col === 0 ? 1 : 0 }))),
			);
			if (item.style.height) {
				menu.addItem((mi) =>
					mi
						.setTitle("Reset height")
						.setIcon("unfold-vertical")
						.onClick(() => void this.updatePlannerSlot(section.headingRaw, key, ({ col: c }) => ({ col: c }))),
				);
			}
			if (slot?.col !== undefined) {
				menu.addItem((mi) =>
					mi
						.setTitle("Unpin from column")
						.setIcon("pin-off")
						.onClick(() => void this.updatePlannerSlot(section.headingRaw, key, ({ h }) => ({ h }))),
				);
			}
			menu.addSeparator();
		};
		item.addEventListener("contextmenu", (evt) => {
			if ((evt.target as HTMLElement).closest("a")) return;
			evt.preventDefault();
			evt.stopPropagation();
			if (card.kind === "line") {
				this.openBlockMenu(evt, file, section, card.blockIndex ?? 0, text, item, { prepend, toggle });
				return;
			}
			const menu = new Menu();
			prepend(menu);
			menu.addItem((mi) => mi.setTitle("Edit text…").setIcon("pencil-line").onClick(edit));
			menu.addItem((mi) =>
				mi
					.setTitle("Copy text")
					.setIcon("copy")
					.onClick(async () => {
						try {
							await navigator.clipboard.writeText(ctx.editText);
							new Notice("Text copied.");
						} catch {
							new Notice("Couldn't access the clipboard.");
						}
					}),
			);
			// Delete the subcard — its heading and everything beneath — or the loose
			// lines, after the same confirmation a card on the wall gets.
			menu.addSeparator();
			menu.addItem((mi) =>
				mi
					.setTitle("Delete card")
					.setIcon("trash-2")
					.setWarning(true)
					.onClick(() => {
						const name = card.kind === "sub" ? card.title || "(untitled)" : this.plannerLooseTitle();
						new ConfirmDeleteModal(this.app, name, async () => {
							const ok = await deleteRangeInFile(this.app, file, this.headingLevel, section, card.start, card.end, text);
							if (ok) new Notice(`Deleted “${name}” from ${section.title || file.basename}`);
							else new Notice("Couldn't find that text — the file changed on disk.");
							await this.refresh();
						}).open();
					}),
			);
			menu.showAtMouseEvent(evt);
		});
	}

	/** A planner column takes card drops: beside the hovered card, or — in the open space
	 * below them — after the column's last card of the same kind. */
	private wirePlannerColumn(colEl: HTMLElement, col: 0 | 1, file: TFile, section: Section): void {
		const itemAt = (el: HTMLElement | null) => (el ? this.plannerItems[Number(el.dataset.index)] ?? null : null);
		const aim = (evt: DragEvent): { anchor: HTMLElement | null; before: boolean } => {
			const hovered = (evt.target as HTMLElement | null)?.closest<HTMLElement>(".sfsc-planner-item");
			if (hovered && colEl.contains(hovered) && hovered !== this.plannerDrag?.el) {
				const rect = hovered.getBoundingClientRect();
				return { anchor: hovered, before: evt.clientY < rect.top + rect.height / 2 };
			}
			return { anchor: null, before: false };
		};
		colEl.addEventListener("dragover", (evt) => {
			if (!this.plannerDrag) return;
			evt.preventDefault();
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
			const { anchor, before } = aim(evt);
			this.clearPlannerDropMarks();
			if (anchor) {
				// A line over a subcard files under it: mark the whole subcard, not an edge.
				const intoSub = this.plannerDrag.card.kind === "line" && itemAt(anchor)?.card.kind === "sub" && !before;
				anchor.addClass(intoSub ? "is-drop-target" : before ? "sc-blockdrop-before" : "sc-blockdrop-after");
				this.plannerDropEl = anchor;
			} else {
				colEl.addClass("is-drop-target");
				this.plannerDropEl = colEl;
			}
		});
		colEl.addEventListener("dragleave", (evt) => {
			if (!colEl.contains(evt.relatedTarget as Node | null)) this.clearPlannerDropMarks();
		});
		colEl.addEventListener("drop", (evt) => {
			const drag = this.plannerDrag;
			if (!drag) return;
			evt.preventDefault();
			evt.stopPropagation();
			this.clearPlannerDropMarks();
			this.plannerDrag = null;
			drag.el.removeClass("is-dragging-block");
			const { anchor, before } = aim(evt);
			let target = itemAt(anchor);
			let side: "before" | "after" = before ? "before" : "after";
			if (!target) {
				const inColumn = Array.from(colEl.querySelectorAll<HTMLElement>(".sfsc-planner-item"))
					.map(itemAt)
					.filter((it): it is PlannerItem => !!it && it !== drag && it.card.kind === drag.card.kind);
				target = inColumn.pop() ?? null;
				side = "after";
			}
			void this.finishPlannerDrop(file, section, drag, col, target, side);
		});
	}

	private clearPlannerDropMarks(): void {
		this.plannerDropEl?.removeClass("sc-blockdrop-before");
		this.plannerDropEl?.removeClass("sc-blockdrop-after");
		this.plannerDropEl?.removeClass("is-drop-target");
		this.plannerDropEl = null;
	}

	/**
	 * A card dropped in a planner column: remember its column, then move it in the note
	 * to match what the columns now show. Lines reorder among the lines above the first
	 * sub-heading (or file under a subcard they're dropped on); subcards reorder among
	 * subcards. A subcard can't sit among the loose lines — it would swallow them — so
	 * dropped there only its column changes. Already beside the anchor: column only.
	 */
	private async finishPlannerDrop(
		file: TFile,
		section: Section,
		drag: PlannerItem,
		col: 0 | 1,
		anchor: PlannerItem | null,
		side: "before" | "after",
	): Promise<void> {
		if (drag.col !== col) await this.updatePlannerSlot(section.headingRaw, drag.key, (slot) => ({ ...slot, col }), false);
		const d = drag.card;
		const a = anchor?.card ?? null;
		const stay = () => this.layoutPlanner();
		if (!a || a === d) return stay();

		if (d.kind === "line" && a.kind === "line") {
			const from = d.blockIndex ?? 0;
			const to = a.blockIndex ?? 0;
			const adjacent = (side === "after" && to === from - 1) || (side === "before" && to === from + 1);
			if (adjacent) return stay();
			await this.completeBlockDrag(file, { section, blockIndex: from, blockText: drag.text }, section, to, side);
			return;
		}
		if (d.kind === "line" && a.kind === "sub") {
			const { lines: front } = this.plannerLines(section);
			if (side === "before") {
				// Above the heading: the end of whatever precedes it (the loose lines, or
				// the subcard before). Already there, bar blank lines: column only.
				if (d.end <= a.start && front.slice(d.end, a.start).every((l) => l.trim() === "")) return stay();
				await moveRangeInFile(this.app, file, this.headingLevel, section, d.start, d.end, drag.text, section, a.start);
			} else {
				// Onto the subcard: file the line under its heading, after its last block.
				const inner = movableBlocks(front)
					.map((b, i) => ({ b, i }))
					.filter(({ b }) => b.start > a.start && b.end <= a.end);
				const last = inner[inner.length - 1];
				if (last) {
					await this.completeBlockDrag(file, { section, blockIndex: d.blockIndex ?? 0, blockText: drag.text }, section, last.i, "after");
					return;
				}
				await moveRangeInFile(this.app, file, this.headingLevel, section, d.start, d.end, drag.text, section, a.start + 1);
			}
			await this.refresh();
			return;
		}
		if (d.kind === "sub" && a.kind === "sub") {
			const insertAt = side === "before" ? a.start : a.end;
			if (insertAt === d.start || insertAt === d.end) return stay();
			const ok = await moveRangeInFile(this.app, file, this.headingLevel, section, d.start, d.end, drag.text, section, insertAt);
			if (!ok) new Notice("Couldn't move that text — the file changed on disk.");
			await this.refresh();
			return;
		}
		stay();
	}

	/** The loose card's title: the unfiled card's name, its markdown emphasis stripped. */
	private plannerLooseTitle(): string {
		const raw = this.plugin.settings.unfiledTitle || DEFAULT_SETTINGS.unfiledTitle;
		return raw.replace(/[*_`]/g, "").trim() || "Unfiled";
	}

	/** A card dropped on an arrow moves to the neighbouring card, keeping its column. A
	 * subcard joins that card's end; a line or the loose card lands above the
	 * neighbour's first sub-heading (its own loose area), or at its end when it has none. */
	private async sendPlannerCard(file: TFile, section: Section, drag: PlannerItem, target: Section): Promise<void> {
		await this.updatePlannerSlot(target.headingRaw, drag.key, (slot) => ({ ...slot, col: drag.col }), false);
		const { lines: front, cards: targetCards } = this.plannerLines(target);
		const firstSub = drag.card.kind === "sub" ? undefined : targetCards.find((c) => c.kind === "sub");
		if (drag.card.kind === "line" && !firstSub) {
			await this.completeBlockDrag(file, { section, blockIndex: drag.card.blockIndex ?? 0, blockText: drag.text }, target, null);
			return;
		}
		let at = firstSub ? firstSub.start : target.endLine - bodyStartLine(target);
		while (firstSub && at > 0 && front[at - 1].trim() === "") at--;
		const ok = await moveRangeInFile(
			this.app,
			file,
			this.headingLevel,
			section,
			drag.card.start,
			drag.card.end,
			drag.text,
			target,
			at,
		);
		if (!ok) new Notice("Couldn't move that text — the file changed on disk.");
		await this.refresh();
	}

	/** Change one card's remembered column/height and save; a slot with neither left
	 * (unpinned, natural height) is dropped rather than stored. */
	private async updatePlannerSlot(
		headingRaw: string,
		key: string,
		change: (slot: PlannerSlot) => PlannerSlot,
		rebuild = true,
	): Promise<void> {
		const all = { ...this.plugin.getPlanner(this.filePath) };
		const slots = { ...(all[headingRaw] ?? {}) };
		const next = change(slots[key] ?? {});
		if (next.col === undefined && next.h === undefined) delete slots[key];
		else slots[key] = next;
		if (Object.keys(slots).length) all[headingRaw] = slots;
		else delete all[headingRaw];
		await this.plugin.savePlanner(this.filePath, all, this.viewSettings());
		if (rebuild) this.layoutPlanner();
	}

	/** The resize grip left new inline heights on some line cards: save them. Settled
	 * briefly, so a drag of the grip saves once, not per pixel. */
	private plannerHeightsChanged = debounce(
		() => {
			const root = this.plannerEl;
			const heading = this.plannerHeading;
			if (this.layout !== "planner" || !root || !heading || root.clientHeight === 0) return;
			const all = { ...this.plugin.getPlanner(this.filePath) };
			const slots = { ...(all[heading] ?? {}) };
			let changed = false;
			for (const item of Array.from(root.querySelectorAll<HTMLElement>(".sfsc-planner-item"))) {
				const key = item.dataset.key;
				if (!key || !item.style.height) continue; // never resized: natural height
				const h = Math.round(item.offsetHeight);
				if (!h || Math.abs(h - (slots[key]?.h ?? 0)) < 2) continue;
				slots[key] = { ...(slots[key] ?? {}), h };
				changed = true;
			}
			if (!changed) return;
			all[heading] = slots;
			void this.plugin.savePlanner(this.filePath, all, this.viewSettings());
		},
		200,
		true,
	);

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

	/** The movable block under `target`, verified against the parsed body — the same
	 * DOM↔source agreement every block action requires before touching the file. */
	private blockAt(
		bodyEl: HTMLElement,
		target: HTMLElement | null,
		section: Section,
	): { blockIndex: number; blockText: string; el: HTMLElement } | null {
		const el = target?.closest<HTMLElement>(".sc-block");
		if (!el || !bodyEl.contains(el)) return null;
		const domIndex = this.eligibleBlockEls(bodyEl).indexOf(el);
		const body = section.body.split("\n");
		const block = movableBlocks(body)[domIndex];
		if (domIndex < 0 || !block || !SectionCardsView.blockTextsAgree(el, body.slice(block.start, block.end))) {
			return null;
		}
		return { blockIndex: domIndex, blockText: body.slice(block.start, block.end).join("\n"), el };
	}

	/**
	 * Post-render pass over card bodies: live checkboxes + draggable blocks. Scoped to
	 * the entries whose markdown just landed — re-walking every card after each deferred
	 * batch was quadratic across a long note's ramp-up.
	 */
	private prepareBodies(entries: CardEntry[]): void {
		for (const entry of entries) {
			// The properties table's rows aren't body blocks: nothing to drag or star.
			if (entry.holder.section.properties) continue;
			const bodyEl = entry.bodyEl;
			// Rendered task checkboxes come back disabled, and disabled inputs never fire clicks.
			for (const box of Array.from(bodyEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))) {
				box.removeAttribute("disabled");
				box.removeAttribute("readonly");
			}
			// Tag plain list items that nest a task, so the Tasks layout can keep them
			// visible with a class instead of a :has() selector (Obsidian's CSS lint flags
			// :has for its invalidation cost).
			for (const task of Array.from(bodyEl.querySelectorAll<HTMLElement>("li.task-list-item"))) {
				let parent = task.parentElement?.closest<HTMLElement>("li") ?? null;
				while (parent && bodyEl.contains(parent)) {
					parent.addClass("sc-has-task");
					parent = parent.parentElement?.closest<HTMLElement>("li") ?? null;
				}
			}
			// Only the front is rendered here, so only its blocks can correspond to elements.
			const body = this.cardFaces(entry.holder.section.body).front.split("\n");
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
	 * The next deferred batch: cards in or within a viewport of the visible area first
	 * (wherever the user has scrolled — a jump to today lands mid-note), then document
	 * order. Rect reads only, after layout has settled, so no reflow is forced; hidden
	 * cards (filtered out, or off the Rolodex's showing tab) read as empty and wait.
	 */
	/**
	 * The next `n` bodies to render. The first batches are picked nearest the viewport,
	 * which means measuring every card still owed — O(N) rects per batch, O(N²) over a
	 * big note. Once a pick lands wholly outside the viewport the visible cards are
	 * done, and the rest go in document order without measuring (a scroll during the
	 * tail is caught by the next batch's cheap viewport check).
	 */
	private takeDeferredBatch(entries: CardEntry[], n: number): CardEntry[] {
		if (entries.length <= n) return entries.splice(0, n);
		const view = this.contentEl.getBoundingClientRect();
		if (!this.deferredMeasure) {
			// Peek at the first few owed cards: back in view (a scroll) means measure again.
			const peek = entries.slice(0, 8).some((e) => {
				const r = e.el.getBoundingClientRect();
				return r.bottom >= view.top - view.height && r.top <= view.bottom + view.height;
			});
			if (!peek) return entries.splice(0, n);
			this.deferredMeasure = true;
		}
		const rects = entries.map((e) => e.el.getBoundingClientRect());
		const picked = pickNearViewport(rects, view, n);
		// Nothing picked touches the viewport (or its margin): the visible wall is rendered.
		const nearby = picked.some((i) => rects[i].bottom >= view.top - view.height && rects[i].top <= view.bottom + view.height);
		if (!nearby) this.deferredMeasure = false;
		const batch = picked.map((i) => entries[i]);
		for (let k = picked.length - 1; k >= 0; k--) entries.splice(picked[k], 1);
		return batch;
	}

	/** Whether deferred batches are still being picked by viewport distance (see above). */
	private deferredMeasure = true;

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
		// Batches grow while they stay cheap and shrink when one runs long, so a note of
		// short cards finishes in a few idle slots and one of long cards never janks.
		let n = DEFERRED_RENDER_BATCH;
		this.deferredMeasure = true;
		const step = (): void => {
			if (gen !== this.renderGeneration) return;
			const batch = this.takeDeferredBatch(entries, n);
			if (!batch.length) return;
			const started = performance.now();
			void Promise.all(batch.map((entry) => this.runBodyRender(entry))).then(() => {
				if (gen !== this.renderGeneration) return;
				this.prepareBodies(batch);
				const took = performance.now() - started;
				if (took < 6) n = Math.min(n * 2, DEFERRED_RENDER_BATCH * 4);
				else if (took > 16) n = Math.max(Math.floor(n / 2), Math.max(4, Math.floor(DEFERRED_RENDER_BATCH / 2)));
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
					!(el.hasClass("is-task-empty") && !el.hasClass("is-task-peek")) &&
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
	 *
	 * The Week and Day ranges narrow that to one week or one day under a row of arrows;
	 * the cards for other days stay in the grid, hidden, so the reuse pass keeps them.
	 */
	private layoutCalendar(isoByHeading: Map<string, string>): void {
		const grid = this.gridEl;
		if (!grid) return;
		const firstDow = this.weekFirstDow();

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
		const todayIso = mo().format("YYYY-MM-DD");
		const blank = this.calendarBlankHandlers();

		// 2 weeks, Week and Day show one range at a time, with arrows above it. Cards for
		// other days stay in the grid — the reuse pass owns them — and are hidden by class.
		if (this.calendarRange !== "month") {
			const anchor = this.calendarAnchorIso(isos);
			const week = this.calendarRange !== "day";
			const days = calendarRangeDays(anchor, this.calendarRange, firstDow);
			const shown = new Set(days);
			for (const entry of this.cardEntries) {
				const iso = isoByHeading.get(entry.holder.section.headingRaw);
				entry.el.toggleClass("is-cal-outside", iso === undefined || !shown.has(iso));
			}
			this.buildCalendarNav(grid, days);
			// 2 weeks sets its second week off from the first: the first cell of that week in
			// each row (weekdays, weekend, and their names) carries the split.
			const second = new Set(this.calendarRange === "2weeks" ? days.slice(7) : []);
			const place = (iso: string, weekend: boolean, split: boolean) => {
				const label = week ? String(Number(iso.slice(8))) : "No card for this day yet — click to write one";
				const cell = this.placeCalendarDay(grid, iso, byIso.get(iso), blank, todayIso, label);
				cell.toggleClass("is-cal-wknd", weekend);
				cell.toggleClass("is-cal-split", split);
			};
			const run = (isos: string[]) => {
				const firstOfSecond = isos.find((iso) => second.has(iso));
				this.buildCalendarDayNames(grid, isos, firstOfSecond);
				for (const iso of isos) place(iso, isWeekendIso(iso), iso === firstOfSecond);
			};
			// A week takes the shape of a paper planner: the five weekdays across the top,
			// then the weekend lying along the bottom in a band of its own. Both runs keep
			// the week's own order, so the days still read first to last. 2 weeks is two
			// of those side by side: all ten weekdays across, each weekend under its week.
			// (A lone day is named in full by the nav label, so it gets no header row.)
			if (!week) {
				place(days[0], false, false);
				return;
			}
			run(days.filter((iso) => !isWeekendIso(iso)));
			run(days.filter(isWeekendIso));
			// 2 weeks: a rule down the spacer track, from the weekday names to the foot of
			// the weekend band, so the left and right weeks read as two. Placed by its own
			// column and rows, so it takes no part in the days' auto-placement.
			if (this.calendarRange === "2weeks") grid.createDiv({ cls: "sc-cal-divider", attr: { "aria-hidden": "true" } });
			return;
		}

		// Month: every card is placed, so nothing is out of range — and nothing wears
		// the weekend band's wide cell it may have picked up in the Week range.
		for (const entry of this.cardEntries) {
			entry.el.removeClass("is-cal-outside");
			entry.el.removeClass("is-cal-wknd");
		}
		this.buildCalendarWeekdays(grid, firstDow);

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
				this.placeCalendarDay(grid, iso, byIso.get(iso), blank, todayIso, String(day));
			}
		}
	}

	/** The weekday a week starts on (0 = Sunday): the plugin's setting, or the locale's. */
	private weekFirstDow(): number {
		const locale = moment as unknown as {
			weekdaysShort: (localeSorted: boolean) => string[];
			localeData: () => { firstDayOfWeek: () => number };
		};
		const weekStart = this.plugin.settings.weekStart;
		return weekStart === "sunday" ? 0 : weekStart === "monday" ? 1 : locale.localeData().firstDayOfWeek();
	}

	/** The locale's short weekday names, Sunday first — indexed by the ISO day's own
	 * weekday number, so either header below can name a day without counting columns. */
	private static weekdayShortNames(): string[] {
		return (moment as unknown as { weekdaysShort: (localeSorted: boolean) => string[] }).weekdaysShort(false);
	}

	/** The weekday name row above the Month range's day cells, pinned under the toolbar
	 * while the months scroll past. Rotated to whichever day starts the week. */
	private buildCalendarWeekdays(grid: HTMLElement, firstDow: number): void {
		const names = SectionCardsView.weekdayShortNames();
		for (const name of [...names.slice(firstDow), ...names.slice(0, firstDow)]) {
			grid.createDiv({ cls: "sc-cal-dow", text: name });
		}
	}

	/** Names for one run of the Week range's days — the weekdays across the top, or the
	 * weekend along the bottom, whose two cells are wide and say so. */
	private buildCalendarDayNames(grid: HTMLElement, isos: string[], split?: string): void {
		const names = SectionCardsView.weekdayShortNames();
		for (const iso of isos) {
			const cell = grid.createDiv({ cls: "sc-cal-dow", text: names[isoDow(iso)] });
			cell.toggleClass("is-wknd", isWeekendIso(iso));
			cell.toggleClass("is-cal-split", iso === split);
		}
	}

	/** Shared by every blank day cell: three handlers total, not three per day. */
	private calendarBlankHandlers(): {
		click: (evt: MouseEvent) => void;
		dragover: (evt: DragEvent) => void;
		drop: (evt: DragEvent) => void;
	} {
		const blankIso = (evt: Event) => (evt.currentTarget as HTMLElement).dataset.scIso;
		return {
			click: (evt) => {
				const iso = blankIso(evt);
				if (iso) this.promptCreateDateCard(iso);
			},
			// A card dragged onto an empty day moves there: its heading is rewritten.
			dragover: (evt) => {
				if (!this.dragging) return;
				evt.preventDefault();
				if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
				this.setCalDrop(evt.currentTarget as HTMLElement);
			},
			drop: (evt) => {
				if (!this.dragging) return;
				evt.preventDefault();
				const moved = this.dragging.section;
				const iso = blankIso(evt);
				this.setCalDrop(null);
				this.dragging = null;
				if (iso) void this.moveCardToDate(moved, iso);
			},
		};
	}

	/** One day of the calendar: the day's card moved into place (appendChild MOVES it,
	 * and the header and earlier days went in first, so date order builds the grid), or
	 * an empty square offering to start that day's card — the jump-to-date dialog.
	 * Returns whichever landed, so the caller can mark it (the weekend's wide cell). */
	private placeCalendarDay(
		grid: HTMLElement,
		iso: string,
		card: HTMLElement | undefined,
		on: { click: (evt: MouseEvent) => void; dragover: (evt: DragEvent) => void; drop: (evt: DragEvent) => void },
		todayIso: string,
		label: string,
	): HTMLElement {
		if (card) {
			grid.appendChild(card);
			return card;
		}
		const cell = grid.createDiv({ cls: "sc-cal-blank", text: label });
		if (iso === todayIso) cell.addClass("is-today"); // today with no card yet: the ring still marks it
		cell.setAttr("role", "button");
		cell.setAttr("aria-label", `Create a card for ${iso}`);
		cell.dataset.scIso = iso;
		cell.addEventListener("click", on.click);
		cell.addEventListener("dragover", on.dragover);
		cell.addEventListener("drop", on.drop);
		return cell;
	}

	/** The Week and Day ranges' header: an arrow each way, the range's name between
	 * them, and — once the range has walked off today — a way back to it. Like every
	 * other helper element built into the grid, its class belongs in refresh's stray
	 * sweep, or each walk to the next week leaves its nav row behind. */
	private buildCalendarNav(grid: HTMLElement, days: string[]): void {
		const nav = grid.createDiv({ cls: "sc-cal-nav" });
		// 2 weeks steps a week at a time too, so its arrows say so.
		const unit = this.calendarRange === "day" ? "day" : "week";
		const arrow = (dir: "prev" | "next") => {
			const btn = nav.createEl("button", { cls: `sc-cal-nav-arrow is-${dir}` });
			fastIcon(btn, dir === "prev" ? "chevron-left" : "chevron-right");
			btn.setAttr(
				"aria-label",
				`${dir === "prev" ? "Previous" : "Next"} ${unit} (${dir === "prev" ? "," : "."})`,
			);
			btn.addEventListener("click", () => this.stepCalendar(dir === "prev" ? -1 : 1));
		};
		arrow("prev");
		nav.createDiv({ cls: "sc-cal-nav-label", text: SectionCardsView.calendarRangeLabel(days) });
		arrow("next");
		const todayIso = mo().format("YYYY-MM-DD");
		if (!days.includes(todayIso)) {
			const back = nav.createEl("button", { cls: "sc-cal-nav-today", text: "Today" });
			back.setAttr("aria-label", this.calendarRange === "2weeks" ? "Back to the weeks holding today" : `Back to the ${unit} holding today`);
			back.addEventListener("click", () => this.setCalendarAnchor(todayIso));
		}
	}

	/** What the nav row calls the range: one day in full, or a week as its two ends.
	 * Both ends carry their month — shorter phrasings only read right in some locales. */
	private static calendarRangeLabel(days: string[]): string {
		const at = (iso: string) => {
			const [y, m, d] = iso.split("-").map(Number);
			return new Date(y, m - 1, d);
		};
		if (days.length === 1) {
			return at(days[0]).toLocaleDateString(undefined, {
				weekday: "long",
				year: "numeric",
				month: "long",
				day: "numeric",
			});
		}
		const from = at(days[0]).toLocaleDateString(undefined, { month: "short", day: "numeric" });
		const to = at(days[days.length - 1]).toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
		return `${from} – ${to}`;
	}

	/** The day the Week and Day ranges are showing. Until the user walks somewhere it's
	 * today — pulled into the note's dated span, so a note about last August opens on
	 * cards rather than on an empty week. A walk from there goes wherever it likes: an
	 * empty week is how a card gets made for a day the note has never mentioned. */
	private calendarAnchorIso(isos: string[]): string {
		if (!this.calendarAnchor) {
			this.calendarAnchor = clampIso(mo().format("YYYY-MM-DD"), isos[0], isos[isos.length - 1]);
		}
		return this.calendarAnchor;
	}

	/** Walk the 2 weeks, Week or Day range one step — a week, or for Day a day: the nav
	 * arrows, and the , and . keys. */
	private stepCalendar(delta: number): void {
		if (this.layout !== "calendar" || this.calendarRange === "month") return;
		const from = this.calendarAnchor ?? mo().format("YYYY-MM-DD");
		this.setCalendarAnchor(shiftIso(from, delta * calendarRangeStep(this.calendarRange)));
	}

	/** Before landing on a day's card in the 2 weeks, Week or Day range, turn the range to that
	 * day — outside it the card sits hidden, with nothing on screen to scroll to. A day
	 * already in the range showing is left alone (no refresh), as is every other layout
	 * and the Month range, whose grid holds every day. */
	private async turnCalendarTo(iso: string | null): Promise<void> {
		if (!iso || this.layout !== "calendar" || this.calendarRange === "month") return;
		const anchor = this.calendarAnchor;
		const showing = anchor ? calendarRangeDays(anchor, this.calendarRange, this.weekFirstDow()) : [];
		if (showing.includes(iso)) return;
		this.calendarAnchor = iso;
		await this.refresh();
	}

	/** Show the week (or the day) holding this ISO day. */
	private setCalendarAnchor(iso: string): void {
		this.calendarAnchor = iso;
		void this.refresh();
	}

	/** Switch the Calendar between whole months, one week, and one day. */
	private setCalendarRange(range: CalendarRange): void {
		if (this.calendarRange === range) return;
		this.calendarRange = range;
		this.rememberView();
		this.applyLayoutClass();
		this.buildToolbar(); // the picker shows the new range, and the sort control comes or goes
		void this.refresh().then(() => this.app.workspace.requestSaveLayout());
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
			fastIcon(chevron, "chevron-down");
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
			if (this.isCanvasLayout()) this.previewCanvasResize();
			if (this.layout === "rolodex") this.roloRelayout();
			this.repack();
			// A narrower pane wraps the toolbar taller; the sticky band rides below it.
			this.updateToolbarOffset();
		});
		for (const card of Array.from(this.gridEl.children)) {
			const el = card as HTMLElement;
			if (el.hasClass("section-card") || el.hasClass("sc-image-card")) this.cardObserver.observe(card);
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
		this.addCommonMenuItems(menu);
		menu.showAtMouseEvent(evt);
	}

	private buildToolbar() {
		const bar = this.toolbarEl;
		if (!bar) return;
		bar.empty();
		const compact = this.plugin.settings.toolbarStyle === "compact";
		bar.toggleClass("is-compact", compact);

		// Three clusters: the note controls, the date controls, the view controls. In
		// the full bar they're transparent (display: contents) and everything wraps as
		// one flow; the compact bar lays them out as a grid so the dates sit dead centre
		// while the note button and filter box grow into whatever room the left has.
		const left = bar.createDiv({ cls: "section-cards-cluster section-cards-cluster-left" });
		const mid = bar.createDiv({ cls: "section-cards-cluster section-cards-cluster-mid" });
		const right = bar.createDiv({ cls: "section-cards-cluster section-cards-cluster-right" });
		let cluster: HTMLElement = left;

		// The hamburger menu leads the bar: dates, new-card options, and the per-note
		// background live here as well as (for now) on their own toolbar controls.
		const menuBtn = cluster.createEl("button", { cls: "section-cards-icon-btn section-cards-menu-btn" });
		fastIcon(menuBtn, "menu");
		menuBtn.setAttr("aria-label", "Cards view menu (M)");
		menuBtn.addEventListener("click", (evt) => this.openMainMenu(evt));
		this.menuBtn = menuBtn;

		// The Deck toggle: a wall of note thumbnails instead of the cards. It sits before
		// the note button: pick a note from thumbnails, or from the list.
		const deckBtn = cluster.createEl("button", { cls: "section-cards-icon-btn section-cards-deck-btn" });
		fastIcon(deckBtn, DECK_ICON);
		deckBtn.toggleClass("is-active", this.deckMode);
		deckBtn.setAttr(
			"aria-label",
			this.deckMode ? "Back to this note's cards (D)" : "Deck: pick a note from thumbnails (D)",
		);
		deckBtn.addEventListener("click", () => void this.toggleDeck());

		const fileBtn = cluster.createEl("button", { cls: "section-cards-file-btn" });
		fileBtn.setAttr("aria-label", "Pick a different note (O)");
		// The Deck stands for no one note: the button reads as empty until one is picked.
		fileBtn.toggleClass("is-empty", this.deckMode);
		fileBtn.createSpan({ text: this.deckMode ? "Choose a note…" : this.filePath || "(no file)" });
		fileBtn.addEventListener("click", () => {
			new FileSuggestModal(this.app, this.plugin, (path) => void this.navigateTo(path), true).open();
		});

		// The layout, right of the note: the current one's icon and name, opening a grid
		// of every layout (L still cycles). The Deck has no layout to pick.
		this.closePicker();
		if (!this.deckMode) {
			const dated = this.calendarSelectable();
			// The note's saved Custom Grid layouts follow the layouts as tiles of their own:
			// picking one switches to the Custom Grid and applies it.
			const savedNames = Object.keys(this.plugin.getSavedLayouts(this.currentPath())).sort((a, b) =>
				a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
			);
			const state = this.savedLayoutState();
			const value = this.layout === "custom" && state && !state.dirty ? `saved:${state.name}` : this.layout;
			this.buildPicker(cluster, {
				cls: "section-cards-layout-btn",
				ariaLabel: "Card layout (L cycles)",
				value,
				columns: 4,
				options: [
					...LAYOUT_OPTIONS.filter(([value]) => this.layoutEnabled(value)).map((entry): PickerOption => {
						const [value, label, hint] = entry;
						const needsDates = (value === "calendar" || value === "heatmap") && !dated && value !== this.layout;
						return {
							value,
							label,
							hint: needsDates ? `${hint} — needs date headings` : hint,
							icon: LAYOUT_ICONS[value][0],
							fallback: LAYOUT_ICONS[value][1],
							disabled: needsDates,
						};
					}),
					...savedNames.map((name): PickerOption => ({
						value: `saved:${name}`,
						label: name,
						hint: "A saved Custom Grid layout: its arrangement, zoom, and background",
						icon: "bookmark",
						fallback: "star",
					})),
				],
				onPick: (picked) => {
					if (!picked.startsWith("saved:")) {
						this.setLayout(picked as Layout);
						return;
					}
					const name = picked.slice("saved:".length);
					const apply = () => void this.plugin.applySavedLayout(this.currentPath(), name);
					if (this.layout === "custom") this.confirmSavedLayoutChanges(apply);
					else {
						this.switchLayout("custom");
						apply();
					}
				},
			});
		}

		if (this.deckMode) {
			// The Deck's own sort — the rest of the toolbar is note-specific and
			// stands down, but ordering the thumbnails belongs here.
			const sortWrap = cluster.createDiv({ cls: "section-cards-control section-cards-sort-control" });
			sortWrap.setAttr("aria-label", "Order the deck's notes");
			this.buildPicker(sortWrap, {
				cls: "section-cards-sort-btn",
				ariaLabel: "Order the deck's notes",
				buttonIcon: "arrow-up-down",
				value: this.plugin.settings.deckSort,
				columns: 3,
				options: DECK_SORT_LABELS.map(([value, label]) => ({ value, label, icon: DECK_SORT_ICONS[value][0], fallback: DECK_SORT_ICONS[value][1] })),
				onPick: (value) => {
					this.plugin.settings.deckSort = value as DeckSort;
					this.buildToolbar(); // the picker shows the new order
					void this.plugin.saveSettings().then(() => this.refresh());
				},
			});
			this.addHelpButton(right);
			return;
		}

		// Heading level leads the controls, the filter box beside it: what becomes a
		// card sits on the left with the note name; the view options keep the right.
		const levelWrap = cluster.createDiv({ cls: "section-cards-control section-cards-level-control" });
		levelWrap.setAttr("aria-label", "Heading level shown as cards (keys 1–6)");
		this.levelHost = levelWrap;
		this.populateLevelOptions();

		// Filter box: typing narrows the wall to cards containing the text; X clears.
		const filterWrap = cluster.createDiv({ cls: "section-cards-control section-cards-filter" });
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
		fastIcon(clearBtn, "x");
		clearBtn.setAttr("aria-label", "Clear the filter and show all cards (Esc)");
		// Typing coalesces: every keystroke would otherwise re-filter and re-pack the
		// whole wall (a third of a second on a few thousand cards). Clearing is immediate.
		const applyTyped = debounce(() => this.applyFilter(), 90, true);
		const setQuery = (q: string, immediate = true) => {
			this.filterQuery = q;
			filterWrap.toggleClass("has-query", q.length > 0);
			if (immediate) {
				applyTyped.cancel();
				this.applyFilter();
			} else {
				applyTyped();
			}
		};
		filterInput.addEventListener("input", () => setQuery(filterInput.value, false));
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
		const starBtn = cluster.createEl("button", { cls: "section-cards-icon-btn section-cards-star-btn" });
		this.starBtn = starBtn;
		starBtn.toggleClass("is-hidden", !this.hasStars);
		fastIcon(starBtn, "star");
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

		cluster.createDiv({ cls: "section-cards-spacer" });
		cluster = mid;

		// The date controls sit mid-bar, between the note cluster on the left and the
		// view controls on the right: jump-to-date and the per-note Dates checkbox
		// that governs whether it's offered.
		const datesWrap = cluster.createDiv({ cls: "section-cards-control" });

		// Jump to date: only offered when headings are dates and the note actually has
		// some (refresh keeps the visibility current). The native date picker does the
		// asking; the button anchors it over an invisible input.
		const jumpWrap = datesWrap.createDiv({ cls: "section-cards-jump-date" });
		this.jumpDateWrap = jumpWrap;
		jumpWrap.toggleClass("is-hidden", !this.hasDateHeadings);
		const jumpBtn = jumpWrap.createEl("button", { cls: "section-cards-icon-btn section-cards-jump-btn" });
		fastIcon(jumpBtn, "calendar-days");
		jumpBtn.setAttr("aria-label", "Jump to a date's card");
		const jumpInput = jumpWrap.createEl("input", {
			cls: "section-cards-jump-input",
			attr: { type: "date", "aria-hidden": "true", tabindex: "-1" },
		});
		const openJumpPicker = () => {
			// Start empty every time: the picker then opens on the current month with
			// today marked, and any day picked — today included — differs from the
			// input's value, so `change` fires. A value left over from an earlier pick
			// (or from yesterday, in a view open overnight) would park the picker on
			// that day and swallow a re-pick of it, since an unchanged value fires nothing.
			jumpInput.value = "";
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
			if (jumpInput.value) void this.jumpToDate(jumpInput.value);
		});
		// Beside the calendar: hide dated cards after today / before today (also in the
		// menu). They share the calendar button's visibility — only where dates exist.
		const hide = this.plugin.getDateHide(this.filePath);
		const hideBtn = (icon: string, label: string, key: "future" | "past", on: boolean) => {
			const btn = jumpWrap.createEl("button", { cls: "section-cards-icon-btn section-cards-datehide-btn" });
			fastIcon(btn, icon);
			btn.setAttr("aria-label", `${label}${on ? " (on)" : ""}`);
			btn.toggleClass("is-active", on);
			btn.addEventListener("click", () => void this.plugin.setDateHide(this.filePath, { [key]: !on }, this.viewSettings()));
		};
		hideBtn("calendar-arrow-down", "Hide future dates", "future", hide.future);
		hideBtn("calendar-arrow-up", "Hide past dates", "past", hide.past);

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
		cluster = right;
		cluster.createDiv({ cls: "section-cards-spacer" });

		// The new-card button leads the right cluster, ahead of the view controls.
		const newBtn = cluster.createEl("button", { cls: "section-cards-new-btn mod-cta", text: compact ? "+" : "+ New card" });
		newBtn.setAttr("aria-label", "Create a new section in this note (N)");
		newBtn.addEventListener("click", () => this.promptNewCard());

		// View mode: a three-way toggle for how the wall is grouped by the headings
		// above the card level — one flat wall, drill-down hierarchy columns, or a
		// collapsible divider bar per heading. The grouped modes keep whatever layout
		// the dropdown says; neither is available on the Custom Grid canvas.
		// View mode: one flat wall, hierarchy columns, or divider bars — a picker like the
		// others. Not on the layouts that place everything themselves.
		const modeWrap = cluster.createDiv({ cls: "section-cards-control section-cards-mode-control" });
		const modesOff = this.layoutOwnsPlacement();
		const modeBtn = this.buildPicker(modeWrap, {
			cls: "section-cards-mode-btn",
			ariaLabel: "View mode (V cycles)",
			buttonIcon: "layout-panel-left",
			value: this.hierarchyActive() ? "hier" : this.sectionsActive() ? "sections" : "default",
			columns: 3,
			options: [
				{ value: "default", label: "Default view", hint: "One flat wall of cards, ungrouped", icon: "layout-grid", fallback: "grid" },
				{ value: "hier", label: "Hierarchy view", hint: "Hierarchy columns: drill into the headings above the card level (V cycles)", icon: "list-tree", fallback: "list" },
				{ value: "sections", label: "Divider view", hint: "Dividers: group the cards under the heading above the card level (V cycles)", icon: "rows-3", fallback: "rows" },
			],
			onPick: (value) => {
				if (this.layoutOwnsPlacement()) return;
				this.hierarchyOn = value === "hier";
				this.sectionsOn = value === "sections"; // never both groupers at once
				this.rememberView();
				this.applyLayoutClass();
				this.buildToolbar(); // the picker reflects the state
				void this.refresh().then(() => this.app.workspace.requestSaveLayout());
			},
		});
		if (modesOff) {
			modeBtn.toggleAttribute("disabled", true);
			modeBtn.setAttr("aria-label", "View modes aren't available on the canvas layouts, the Calendar, the Rolodex, or the Day Planner");
		}

		// The Calendar's range: the scrolling wall of months, one week, or one day.
		if (this.layout === "calendar") {
			const rangeWrap = cluster.createDiv({ cls: "section-cards-control section-cards-calrange-control" });
			rangeWrap.setAttr("aria-label", "How much of the calendar one screen shows");
			this.buildPicker(rangeWrap, {
				cls: "section-cards-calrange-btn",
				ariaLabel: "Calendar range",
				value: this.calendarRange,
				columns: 3,
				options: CALENDAR_RANGE_OPTIONS.map(([value, label, hint]) => ({
					value,
					label,
					hint,
					icon: CALENDAR_RANGE_ICONS[value][0],
					fallback: CALENDAR_RANGE_ICONS[value][1],
				})),
				onPick: (value) => this.setCalendarRange(value as CalendarRange),
			});
		}

		// Tooltips sit on the wrapper as well as the control, so hovering the text
		// label ("Sort", "Layout", …) shows them too, not just the dropdown.
		// On the Calendar the sort orders the months — so the Week and Day ranges, which
		// show one range at a time, have nothing for it to do and leave it out.
		if (!(this.layout === "calendar" && this.calendarRange !== "month")) {
			const sortWrap = cluster.createDiv({ cls: "section-cards-control section-cards-sort-control" });
			// On the Calendar the same control orders the months instead of the cards.
			const calendarSort = this.layout === "calendar";
			sortWrap.setAttr("aria-label", calendarSort ? "Order the months are shown in" : "Order the cards are shown in");
			const sortOptions: PickerOption[] = calendarSort
				? [
						{ value: "asc", label: "Ascending", icon: "calendar-arrow-down", fallback: "arrow-down" },
						{ value: "desc", label: "Descending", icon: "calendar-arrow-up", fallback: "arrow-up" },
					]
				: [
						{ value: "asc", label: "A → Z", icon: "arrow-down-a-z", fallback: "sort-asc" },
						{ value: "desc", label: "Z → A", icon: "arrow-up-z-a", fallback: "sort-desc" },
						{ value: "doc", label: "Document order", icon: "list-ordered", fallback: "list" },
					];
			// The count sorts belong to the Tasks layout — but a count order carried into
			// another layout still works, so the picker keeps offering it there.
			if (!calendarSort && (this.layout === "tasks" || this.sortOrder.startsWith("count"))) {
				sortOptions.push(
					{ value: "count-asc", label: SORT_LABELS["count-asc"], icon: "arrow-down-0-1", fallback: "list-checks" },
					{ value: "count-desc", label: SORT_LABELS["count-desc"], icon: "arrow-up-1-0", fallback: "list-checks" },
				);
			}
			this.buildPicker(sortWrap, {
				cls: "section-cards-sort-btn",
				ariaLabel: sortWrap.getAttr("aria-label") ?? "Sort",
				buttonIcon: "arrow-up-down",
				value: calendarSort ? (this.sortOrder === "desc" ? "desc" : "asc") : this.sortOrder,
				columns: 3,
				options: sortOptions,
				onPick: (value) => {
					this.sortOrder = value as SortOrder;
					this.rememberView();
					this.buildToolbar(); // the picker shows the new order
					void this.refresh().then(() => {
						this.revealSelection(); // a selected card follows the re-sort into view
						this.app.workspace.requestSaveLayout();
					});
				},
			});
		}

		// Group-by: divider bars over buckets, per note like the sort. Not on the layouts
		// that place everything themselves (no bars there).
		if (!this.layoutOwnsPlacement()) {
			const groupWrap = cluster.createDiv({ cls: "section-cards-control section-cards-group-control" });
			groupWrap.setAttr("aria-label", "Group the cards under divider bars");
			this.buildPicker(groupWrap, {
				cls: "section-cards-group-btn",
				ariaLabel: "Group the cards under divider bars",
				buttonIcon: "layers",
				value: this.groupBy,
				columns: 3,
				options: GROUP_BY_LABELS.map(([value, label]) => ({ value, label, icon: GROUP_BY_ICONS[value][0], fallback: GROUP_BY_ICONS[value][1] })),
				onPick: (value) => {
					this.groupBy = value as GroupBy;
					this.rememberView();
					this.applyLayoutClass();
					this.buildToolbar();
					void this.refresh().then(() => {
						this.revealSelection(); // the buckets move cards; keep the selected one on screen
						this.app.workspace.requestSaveLayout();
					});
				},
			});
		}

		// Tasks layout: the complete/incomplete filter, beside the sort it refines.
		if (this.layout === "tasks") {
			const taskWrap = cluster.createDiv({ cls: "section-cards-control section-cards-taskfilter-control" });
			taskWrap.setAttr("aria-label", "Which task states the cards show");
			taskWrap.createSpan({ text: "Tasks", cls: "section-cards-label" });
			const taskSelect = taskWrap.createEl("select", { cls: "dropdown" });
			taskSelect.setAttr("aria-label", "Which task states the cards show");
			taskSelect.createEl("option", { text: "All", value: "all" });
			taskSelect.createEl("option", { text: "Open", value: "open" });
			taskSelect.createEl("option", { text: "Done", value: "done" });
			taskSelect.value = this.taskFilter;
			taskSelect.addEventListener("change", () => {
				this.taskFilter = taskSelect.value as TaskFilter;
				this.rememberView();
				this.applyTaskFilter();
				this.layoutMasonry(); // task-empty cards just came or went
				this.app.workspace.requestSaveLayout();
			});
		}

		const templateBtn = cluster.createEl("button", { cls: "section-cards-icon-btn section-cards-template-btn" });
		this.templateBtn = templateBtn;
		fastIcon(templateBtn, "layout-template");
		templateBtn.setAttr("aria-label", "New-card options for this note: template and heading name");
		templateBtn.toggleClass("has-template", !!this.plugin.getTemplatePath(this.filePath));
		templateBtn.addEventListener("click", (evt) => this.openTemplateMenu(evt, templateBtn));

		this.addHelpButton(right);
	}

	/** The ? button ends every toolbar variant — full, compact, and the Deck's. */
	private addHelpButton(bar: HTMLElement): void {
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
		// Every level when the options aren't narrowed to the note's — or when the note
		// has no headings at all, since then there's nothing to narrow by and the first
		// card could go at any level.
		if (!this.plugin.settings.dynamicLevelOptions || !this.availableLevels.length) return [1, 2, 3, 4, 5, 6];
		return [...new Set([...this.availableLevels, this.headingLevel])].sort((a, b) => a - b);
	}

	/** (Re)build the Card level picker: the note's heading levels as H1–H6 tiles. The
	 * date layouts follow the note's date-heading level, so the picker still shows
	 * which level that is but greys out (the 1–6 keys are guarded the same way). */
	private populateLevelOptions(): void {
		const host = this.levelHost;
		if (!host) return;
		host.empty();
		this.levelOptionsShown = this.levelOptionValues().join(",");
		const btn = this.buildPicker(host, {
			cls: "section-cards-level-btn",
			ariaLabel: "Heading level shown as cards (keys 1–6)",
			buttonIcon: "heading",
			value: () => String(this.headingLevel),
			compact: true,
			options: () => this.levelOptionValues().map((l) => ({ value: String(l), label: `H${l}`, icon: `heading-${l}`, fallback: "heading" })),
			onPick: (value) => void this.changeHeadingLevel(Number(value)),
		});
		if (this.isDateLayout()) {
			const hint = "The Calendar and Heatmap follow the note's date-heading level";
			btn.toggleAttribute("disabled", true);
			btn.setAttr("aria-label", hint);
			host.setAttr("aria-label", hint);
		}
	}

	/** Whether a plain-key view shortcut may run: no card editor open, and the key
	 * wasn't typed into a field (input, textarea, select, or an editable region). */
	private plainShortcutOk(evt: KeyboardEvent, allowInDeck = false): boolean {
		if (this.activeEditor || (this.deckMode && !allowInDeck)) return false;
		const el = evt.target as HTMLElement | null;
		if (!el) return true;
		if (el.isContentEditable) return false;
		return !el.closest("input, textarea, select");
	}

	/**
	 * Tasks layout: the complete/incomplete filter is pure CSS (classes on the view
	 * root hide checked or unchecked task lines), so the rendered DOM — and with it
	 * checkbox toggling, block dragging, and editing — never changes shape. This
	 * pass only marks the cards left with nothing to show so they drop out.
	 */
	private applyTaskFilter(): void {
		const active = this.layout === "tasks" && !this.deckMode;
		this.contentEl.toggleClass("is-taskfilter-open", active && this.taskFilter === "open");
		this.contentEl.toggleClass("is-taskfilter-done", active && this.taskFilter === "done");
		for (const entry of this.cardEntries) {
			if (!active) {
				entry.el.removeClass("is-task-empty");
				continue;
			}
			const lines = entry.holder.section.body.split("\n");
			let open = 0;
			let done = 0;
			for (const i of taskLineIndexes(lines)) {
				if (TASK_RE.exec(lines[i])?.[2] === " ") open++;
				else done++;
			}
			const showing = this.taskFilter === "open" ? open : this.taskFilter === "done" ? done : open + done;
			// Today's card stays visible even with nothing to show — it's the wall's
			// anchor: the highlight, the jump-to-today scroll, and the place new
			// tasks get added all point at it.
			entry.el.toggleClass("is-task-empty", showing === 0 && !entry.el.hasClass("is-today"));
			// The top-right count: what this card is showing under the filter.
			const badge = entry.el.querySelector<HTMLElement>(".sfsc-task-count");
			if (badge) {
				badge.setText(String(showing));
				badge.setAttr("title", `${open} open, ${done} done`);
			}
		}
	}

	/** Tasks layout: a jump landed on a card with no tasks to show — reveal it (a
	 * non-today card would be hidden) and write a temporary "No tasks" note on it. */
	private peekNoTasks(card: HTMLElement): void {
		card.addClass("is-task-peek");
		const bodyEl = card.querySelector<HTMLElement>(".section-card-body");
		const note = bodyEl?.createDiv({ cls: "sfsc-no-tasks", text: "No tasks" });
		this.layoutMasonry(); // the revealed card needs a measured spot in the pack
		window.setTimeout(() => {
			note?.remove();
			card.removeClass("is-task-peek");
			this.layoutMasonry(); // and leaves it again
		}, 4000);
	}

	/** Show or hide the Deck of note thumbnails over this view's cards. */
	async toggleDeck(next = !this.deckMode): Promise<void> {
		if (next === this.deckMode) return;
		this.deckMode = next;
		this.filterQuery = "";
		this.applyLayoutClass();
		this.buildToolbar();
		this.updateToolbarOffset();
		await this.refresh();
		this.app.workspace.requestSaveLayout();
	}

	/** The Deck: one clickable thumbnail per remembered note — pinned first, then
	 * recents — with the note's first lines as an excerpt and its layout as a badge. */
	private renderDeck(): void {
		const gen = this.renderGeneration;
		this.clearAllCards();
		this.clearHierarchy();
		this.clearPreviewTiles("images");
		this.clearPreviewTiles("links");
		this.applyBackground();
		const entries = this.plugin.deckEntries(this.plugin.settings.deckCount);
		if (!entries.length) {
			this.showEmpty("No notes in the deck yet.", "Open a note as cards and it lands here.");
			return;
		}
		for (const entry of entries) {
			const tile = this.gridEl.createDiv({ cls: "sfsc-deck-card" });
			// The tile wears the note's own background, so the deck reads like the notes do.
			this.stampBackground(tile, entry.path);
			tile.setAttr("role", "button");
			tile.setAttr("tabindex", "0");
			tile.setAttr("aria-label", `Open ${entry.name} as cards`);
			const head = tile.createDiv({ cls: "sfsc-deck-head" });
			head.createDiv({ cls: "sfsc-deck-title", text: entry.name });
			if (entry.mtime) {
				// Top-right: when the note last changed — the year only once it isn't this one.
				const modified = new Date(entry.mtime);
				const date = head.createDiv({
					cls: "sfsc-deck-date",
					text: modified.toLocaleDateString(undefined, {
						month: "short",
						day: "numeric",
						...(modified.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
					}),
				});
				date.setAttr("title", `Last modified ${modified.toLocaleString()}`);
			}
			const excerpt = tile.createDiv({ cls: "sfsc-deck-excerpt" });
			if (entry.layoutLabel) tile.createDiv({ cls: "sfsc-deck-meta", text: entry.layoutLabel });
			const open = () => void this.navigateTo(entry.path);
			tile.addEventListener("click", open);
			tile.addEventListener("keydown", (evt) => {
				if (evt.key !== "Enter" && evt.key !== " ") return;
				evt.preventDefault();
				open();
			});
			tile.addEventListener("contextmenu", (evt) => {
				const file = this.app.vault.getFileByPath(entry.path);
				if (!file) return;
				evt.preventDefault();
				evt.stopPropagation();
				const menu = new Menu();
				// Obsidian's own file menu doesn't offer Rename to other plugins' menus:
				// the plugin's rename (links update; the remembered view follows) goes first.
				menu.addItem((item) =>
					item
						.setTitle("Rename note…")
						.setIcon("pencil")
						.onClick(() => this.plugin.promptRenameNote(entry.path, () => void this.refresh())),
				);
				menu.addSeparator();
				this.app.workspace.trigger("file-menu", menu, file, "file-explorer");
				menu.showAtMouseEvent(evt);
			});
			void this.fillDeckExcerpt(entry.path, excerpt, gen);
		}
	}

	/** Excerpts read lazily, per tile — a stale render or a removed tile writes nothing. */
	private async fillDeckExcerpt(path: string, el: HTMLElement, gen: number): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		const content = await this.app.vault.cachedRead(file);
		if (gen !== this.renderGeneration || !el.isConnected) return;
		el.setText(deckExcerpt(content));
	}

	/** Offer to create the card for a day that has none — jump-to-date landing on an
	 * empty day and a click on an empty Calendar cell share this dialog. */
	private promptCreateDateCard(iso: string): void {
		const formatted = mo(iso, "YYYY-MM-DD").format(this.cardFormat());
		new CreateDateCardModal(this.app, formatted, () => this.createDateCard(iso)).open();
	}

	/** The card whose heading names this ISO day. The quick textual match first; the
	 * detect pattern finds the rest — a card the calendar places must be findable here
	 * too, or jump-to-date would offer a duplicate and the feed would miss its day. */
	private dateEntry(iso: string): CardEntry | undefined {
		const formatted = mo(iso, "YYYY-MM-DD").format(this.cardFormat());
		const detect = this.plugin.settings.dateDetectFormat;
		return (
			this.cardEntries.find((e) => isTodayTitle(e.holder.section.title, iso, formatted)) ??
			(detect ? this.cardEntries.find((e) => titleToIso(e.holder.section.title, this.cardFormat(), detect) === iso) : undefined)
		);
	}

	// ---------- calendar feed ----------

	/** The day a card's calendar-feed update would fill: its ISO date, when this note has
	 * a feed and the card's title names a day. Null hides the menu items. */
	private feedDayOf(section: Section): string | null {
		if (section.unfiled || !this.plugin.getCalendarFeed(this.filePath)) return null;
		return titleToIso(section.title, this.cardFormat(), this.plugin.settings.dateDetectFormat);
	}

	/** "Update from calendar feed" on a menu, when the card can take it. Says whether it
	 * added the item, so a caller can follow it with a separator. */
	private addFeedItem(menu: Menu, section: Section, title = "Update from calendar feed"): boolean {
		if (!this.feedDayOf(section)) return false;
		menu.addItem((item) =>
			item
				.setTitle(title)
				.setIcon("refresh-cw")
				.onClick(() => void this.updateDayFromFeed(section)),
		);
		return true;
	}

	/**
	 * Fill a day's card from this note's calendar feed: that day's events become the
	 * lines under the feed heading (settings → Calendar feeds), replacing the feed's
	 * earlier lines and keeping anything else written there. `quiet` — the update when
	 * a note opens — reports only failures, and may use a feed fetched moments ago.
	 */
	async updateDayFromFeed(section: Section, quiet = false): Promise<void> {
		const file = this.getFile();
		const url = this.plugin.getCalendarFeed(this.filePath);
		if (!file || !url) {
			if (!quiet) this.promptCalendarFeed();
			return;
		}
		const title = section.title || "(untitled)";
		const iso = titleToIso(section.title, this.cardFormat(), this.plugin.settings.dateDetectFormat);
		if (!iso) {
			if (!quiet) new Notice(`“${title}” doesn't name a day, so the calendar has nothing to put there.`);
			return;
		}
		let lines: string[];
		try {
			const events = feedDayEvents(await this.plugin.fetchFeed(url, !quiet), iso);
			lines = events.map((event) => feedEventLine(event, this.plugin.settings.feedAsTasks));
		} catch (err) {
			new Notice(`Couldn't update from the calendar feed: ${err instanceof Error ? err.message : String(err)}.`);
			return;
		}
		const heading = this.plugin.settings.feedHeading.trim() || "Calendar";
		const result = await syncFeedIntoSection(this.app, file, this.headingLevel, section, heading, lines, this.flipMarker());
		if (result === "missing") {
			new Notice("Couldn't find that card — the file changed on disk.");
			return;
		}
		if (result === "changed") await this.refresh();
		if (quiet) return;
		const events = `${lines.length} event${lines.length === 1 ? "" : "s"}`;
		if (result === "changed") new Notice(lines.length ? `${events} from the calendar in “${title}”.` : `No events on “${title}” — cleared the calendar's lines.`);
		else new Notice(lines.length ? `“${title}” already has the calendar's ${events}.` : `No events on “${title}” in the calendar.`);
	}

	/** Today's card from the feed — made first when the note has none yet (not by the
	 * update when a note opens, which never writes a card of its own accord). */
	async updateTodayFromFeed(create = true, quiet = false): Promise<void> {
		const iso = mo().format("YYYY-MM-DD");
		if (!this.dateEntry(iso) && create) await this.createDateCard(iso);
		const entry = this.dateEntry(iso);
		if (entry) await this.updateDayFromFeed(entry.holder.section, quiet);
	}

	/** Set, test, or remove this note's calendar feed address. */
	private promptCalendarFeed(): void {
		const note = this.getFile()?.basename ?? this.filePath;
		const test = async (url: string): Promise<string> => {
			const text = await this.plugin.fetchFeed(url, true);
			const name = /^X-WR-CALNAME:(.*)$/im.exec(text)?.[1]?.trim();
			const today = feedDayEvents(text, mo().format("YYYY-MM-DD")).length;
			return `It works${name ? `: “${name}”` : ""} — ${today} event${today === 1 ? "" : "s"} today.`;
		};
		new CalendarFeedModal(this.app, note, this.plugin.getCalendarFeed(this.filePath), test, (url) => {
			void this.plugin.setCalendarFeed(this.filePath, url, this.viewSettings()).then(() => {
				new Notice(
					url
						? "Calendar feed saved. Right-click a day's card (or a line in it) and choose Update from calendar feed."
						: "Calendar feed removed from this note.",
				);
			});
		}).open();
	}

	/** Scroll the card whose heading is the picked ISO date into view, like the today jump. */
	private async jumpToDate(iso: string): Promise<void> {
		const find = () => this.dateEntry(iso);
		// The Calendar's Week and Day ranges show one range at a time: turn to the one
		// holding the day, so its card — or its empty cell — is on screen to land on.
		await this.turnCalendarTo(iso);
		let entry = find();
		if (!entry) {
			this.promptCreateDateCard(iso);
			return;
		}
		// Hidden by Hide future / past dates: asking for that day means the hide is in
		// the way — turn the relevant one off, show the cards again, then jump.
		const hide = this.plugin.getDateHide(this.filePath);
		const today = mo().format("YYYY-MM-DD");
		const unhideFuture = hide.future && iso > today;
		const unhidePast = hide.past && iso < today;
		if (unhideFuture || unhidePast) {
			await this.plugin.setDateHide(
				this.filePath,
				{ future: unhideFuture ? false : undefined, past: unhidePast ? false : undefined },
				this.viewSettings(),
				false,
			);
			await this.refresh();
			entry = find();
			if (!entry) return;
			new Notice(`Showing ${unhideFuture ? "future" : "past"} dates again.`);
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
		// The Tasks layout may have nothing to show on the target card (no tasks, or
		// none in the filtered state). Rather than refusing the jump, reveal the
		// card and say "No tasks" on it for a moment.
		if (this.layout === "tasks") {
			const lines = entry.holder.section.body.split("\n");
			let showing = 0;
			for (const i of taskLineIndexes(lines)) {
				const open = TASK_RE.exec(lines[i])?.[2] === " ";
				if (this.taskFilter === "all" || (this.taskFilter === "open") === open) showing++;
			}
			if (showing === 0) this.peekNoTasks(entry.el);
		}
		// The Rolodex and Day Planner show one card: turn to this one, or there'd be
		// nothing to scroll to.
		if (this.isSingleCardLayout()) this.setSingleCardActive(entry);
		entry.el.scrollIntoView({ block: "center", inline: "center" });
		entry.el.addClass("is-linked");
		window.setTimeout(() => entry.el.removeClass("is-linked"), 1600);
	}

	/** Jump-to-date landed on a date with no card: write one (template applied, default
	 * placement), then jump again so the new card scrolls into view and flashes. */
	private async createDateCard(iso: string): Promise<void> {
		const file = this.getFile();
		if (!file) {
			new Notice(`can't find "${this.filePath}".`);
			return;
		}
		// A level with no date headings (H2 in a note of H1 months and H3 days) mustn't
		// get a dated card: write at the level that holds the dates, and follow it there.
		const counts = dateHeadingCounts(this.noteLines, this.cardFormat(), this.plugin.settings.dateDetectFormat);
		const dateLevel = bestDateLevel(counts);
		if (dateLevel !== null && counts[this.headingLevel] === 0 && dateLevel !== this.headingLevel) {
			this.headingLevel = dateLevel;
			this.rememberView();
			this.buildToolbar();
		}
		const title = mo(iso, "YYYY-MM-DD").format(this.cardFormat());
		const headingRaw = `${"#".repeat(this.headingLevel)} ${title}`;
		const body = await this.plugin.loadTemplateBody(file.path, title);
		await insertSection(this.app, file, headingRaw, this.plugin.settings.newCardPlacement, body ?? undefined);
		await this.refresh();
		void this.jumpToDate(iso);
	}

	/** The new-card options menu: this note's template, and its own heading-name format. */
	/**
	 * The hamburger menu at the toolbar's left edge: the per-note dates controls and
	 * new-card options (still on the toolbar too, for now), plus the note's background
	 * image — picked from the vault, or downloaded once into it.
	 */
	private openMainMenu(evt: MouseEvent | HTMLElement): void {
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

		// Two groups: what acts on this note's cards, then what acts on the note (and the
		// notes) — templates for each side sit with their side.
		addHeading("Card");
		// Greyed out in the Deck: no note is showing, so it's unclear which one the
		// card would land in.
		menu.addItem((item) =>
			item
				.setTitle("New card…")
				.setIcon("plus")
				.setDisabled(this.deckMode)
				.onClick(() => this.promptNewCard()),
		);
		menu.addItem((item) =>
			item
				.setTitle("Card template for this note…")
				.setIcon("file-plus-2")
				.setDisabled(this.deckMode)
				.onClick(() => this.openTemplateMenu(evt, this.templateBtn ?? this.toolbarEl)),
		);
		if (this.anyFlippable()) {
			menu.addItem((item) =>
				item
					.setTitle("Flip all cards over")
					.setIcon(FLIP_ICON)
					.onClick(() => this.flipAll(true)),
			);
			menu.addItem((item) =>
				item
					.setTitle("Flip all cards back")
					.setIcon(FLIP_ICON)
					.onClick(() => this.flipAll(false)),
			);
		}
		// Per note: nothing to highlight in the Deck, which stands for no one note.
		if (!this.deckMode) {
			menu.addItem((item) =>
				item
					.setTitle("Highlight today's card")
					.setIcon("calendar-check")
					.setChecked(this.containsDates)
					.onClick(() => void this.plugin.setContainsDates(this.filePath, !this.containsDates, base)),
			);
		}
		this.addBackgroundItems(menu, base);

		menu.addSeparator();
		addHeading("Note");
		menu.addItem((item) =>
			item
				.setTitle("New note…")
				.setIcon("layout-template")
				.onClick(() => this.plugin.promptStructuredNote()),
		);
		menu.addItem((item) =>
			item
				.setTitle("Manage notes…")
				.setIcon("library")
				.onClick(() => new NoteLibraryModal(this.plugin, (path) => void this.navigateTo(path)).open()),
		);
		// What each heading level of this note holds — a year, month, week, day, or
		// text — which the Day Planner's arrows follow.
		menu.addItem((item) =>
			item
				.setTitle("Document setup…")
				.setIcon("sliders-horizontal")
				.setDisabled(this.deckMode)
				.onClick(() => {
					new DocumentSetupModal(
						this.plugin,
						this.getFile()?.basename ?? this.filePath,
						this.noteLines,
						this.plugin.getDocumentLevels(this.filePath),
						this.detectedLevels(),
						this.containsDates,
						this.cardFormat(),
						(levels) => void this.plugin.setDocumentLevels(this.filePath, levels, base),
					).open();
				}),
		);
		// Calendar feeds: this note's iCal address, whose events fill a day's card.
		menu.addItem((item) =>
			item
				.setTitle("Calendar feed…")
				.setIcon("rss")
				.setChecked(!!this.plugin.getCalendarFeed(this.filePath))
				.setDisabled(this.deckMode)
				.onClick(() => this.promptCalendarFeed()),
		);
		// Re-read the note and redraw — the file changed outside Obsidian, say.
		menu.addItem((item) =>
			item
				.setTitle("Reload from file")
				.setIcon("refresh-cw")
				.onClick(() => void this.refresh()),
		);

		// Layouts are the note's; the Deck has none to switch.
		if (!this.deckMode) {
			menu.addSeparator();
			this.addLayoutItems(menu);
			// The canvases' tray can be folded away; this is the way back that's always
			// in reach (the zoom bar's panel button is the other).
			if (this.isCanvasLayout()) {
				const hidden = this.trayHidden();
				menu.addItem((item) =>
					item
						.setTitle("Show the list beside the canvas")
						.setIcon("panel-right")
						.setChecked(!hidden)
						.onClick(() => void this.setTrayCollapsed(!hidden)),
				);
			}
		}

		// Dates: only when there's something to offer — a jump needs date headings, the
		// hides a dated note on a layout they apply to.
		const showHides = this.containsDates && this.dateHideApplies();
		if (this.hasDateHeadings || showHides) {
			menu.addSeparator();
			addHeading("Dates");
			if (this.hasDateHeadings) {
				menu.addItem((item) =>
					item
						.setTitle("Jump to a date's card…")
						.setIcon("calendar-days")
						.onClick(() => this.openJumpPicker?.()),
				);
				if (this.plugin.getCalendarFeed(this.filePath)) {
					menu.addItem((item) =>
						item
							.setTitle("Update today from calendar feed")
							.setIcon("refresh-cw")
							.onClick(() => void this.updateTodayFromFeed()),
					);
				}
			}
			if (showHides) {
				// Relative to today; today's own card always shows, undated cards too. Not on
				// the Calendar/Heatmap, whose grids place every day, nor the Day Planner.
				const hide = this.plugin.getDateHide(this.filePath);
				menu.addItem((item) =>
					item
						.setTitle("Hide future dates")
						.setIcon("calendar-arrow-down")
						.setChecked(hide.future)
						.onClick(() => void this.plugin.setDateHide(this.filePath, { future: !hide.future }, base)),
				);
				menu.addItem((item) =>
					item
						.setTitle("Hide past dates")
						.setIcon("calendar-arrow-up")
						.setChecked(hide.past)
						.onClick(() => void this.plugin.setDateHide(this.filePath, { past: !hide.past }, base)),
				);
			}

		}

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Settings…")
				.setIcon("settings")
				.onClick(() => this.plugin.openSettingsTab()),
		);

		SectionCardsView.showMenuAt(menu, evt);
	}

	/** Show a menu at the pointer, or — opened from the keyboard — beneath its button. */
	private static showMenuAt(menu: Menu, at: MouseEvent | HTMLElement): void {
		if (at instanceof MouseEvent) {
			menu.showAtMouseEvent(at);
			return;
		}
		const r = at.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
	}

	/** A disabled heading row, the flat-menu fallback's group label. */
	private static addMenuHeading(menu: Menu, text: string): void {
		menu.addItem((item) =>
			item
				.setTitle(createFragment((frag) => frag.createSpan({ cls: "sfsc-menu-heading", text })))
				.setDisabled(true),
		);
	}

	/** Hover-open submenus keep the menus short, but setSubmenu is an undocumented
	 * (stable, widely used) MenuItem API — where it's missing, groups render flat
	 * under a heading like they used to. */
	private static submenuSupported(): boolean {
		return typeof (MenuItem.prototype as unknown as { setSubmenu?: unknown }).setSubmenu === "function";
	}

	/**
	 * The Layout group — the layout views, mirroring the toolbar dropdown; shared by
	 * the hamburger menu and the wall's right-click menu. A single "Layouts" row whose
	 * submenu opens on hover (flat list under a heading where submenus don't exist).
	 * The current one is checked; Calendar greys out in notes with no date headings.
	 * The same list manages which layouts this note offers: Ctrl/⌘-click hides one
	 * (it stays listed, dimmed, and a click brings it back), remembered per note.
	 */
	private addLayoutItems(menu: Menu): void {
		const calendarRanges = this.layout === "calendar" || this.calendarSelectable();
		// A layout item's click: switch to it, or with Ctrl/⌘/Alt hide it from the note.
		// Each click acts once, however many handlers see it (the Calendar's item has two).
		const seen = new WeakSet<Event>();
		const choose = (evt: MouseEvent | KeyboardEvent, value: Layout = "calendar"): boolean => {
			if (seen.has(evt)) return false;
			seen.add(evt);
			const modified = evt instanceof MouseEvent && (evt.ctrlKey || evt.metaKey || evt.altKey);
			if (modified) {
				if (value !== this.layout) void this.toggleLayoutEnabled(value);
				return true;
			}
			if (this.layout !== value) this.setLayout(value);
			return true;
		};
		const addOptions = (target: Menu) => {
			for (const [value, label] of LAYOUT_OPTIONS) {
				const enabled = this.layoutEnabled(value);
				target.addItem((item) => {
					if (!enabled) {
						item
							.setTitle(`${label} (hidden)`)
							.setIcon("eye-off")
							.onClick(() => void this.toggleLayoutEnabled(value));
						(item as MenuItem & { dom?: HTMLElement }).dom?.addClass("sfsc-menu-hidden-layout");
						return;
					}
					// The layout's icon, as in the toolbar's picker (an older name as fallback).
					const [icon, fallback] = LAYOUT_ICONS[value];
					item.setIcon(icon);
					if (!(item as MenuItem & { iconEl?: HTMLElement }).iconEl?.querySelector("svg")) item.setIcon(fallback);
					item
						.setTitle(label)
						.setChecked(this.layout === value)
						.setDisabled(
							(value === "calendar" || value === "heatmap") && this.layout !== value && !this.calendarSelectable(),
						)
						.onClick((evt) => choose(evt, value));
					// The Calendar's ranges sit under it, in a submenu (only where it can show).
					// An item with a submenu gets no onClick — a click only opens the submenu —
					// so a listener of its own keeps a click switching to the Calendar and a
					// Ctrl/⌘-click hiding it, like every other layout.
					if (value === "calendar" && calendarRanges && SectionCardsView.submenuSupported()) {
						this.addCalendarRangeItems((item as MenuItem & { setSubmenu: () => Menu }).setSubmenu());
						(item as MenuItem & { dom?: HTMLElement }).dom?.addEventListener("click", (evt) => {
							if (choose(evt)) menu.hide();
						});
					}
				});
				// Where menus don't nest, the ranges follow the Calendar item instead.
				if (value === "calendar" && enabled && calendarRanges && !SectionCardsView.submenuSupported()) {
					this.addCalendarRangeItems(target, "Calendar: ");
				}
			}
			if (!Platform.isMobile) {
				target.addItem((item) =>
					item.setTitle(`${MOD_LABEL}-click a layout to hide it from this note`).setIcon("info").setDisabled(true),
				);
			}
		};
		if (!SectionCardsView.submenuSupported()) {
			SectionCardsView.addMenuHeading(menu, "Layout");
			addOptions(menu);
			return;
		}
		menu.addItem((item) => {
			item.setTitle("Layouts").setIcon("layout-grid");
			addOptions((item as MenuItem & { setSubmenu: () => Menu }).setSubmenu());
		});
	}

	/** The Calendar's ranges as menu items — Month, 2 weeks, Week, Day — the one it
	 * shows (or will show, from another layout) checked. Picking one from another layout
	 * switches to the Calendar in that range. */
	private addCalendarRangeItems(menu: Menu, prefix = ""): void {
		for (const [value, label, hint] of CALENDAR_RANGE_OPTIONS) {
			menu.addItem((item) => {
				const [icon, fallback] = CALENDAR_RANGE_ICONS[value];
				item.setIcon(icon);
				if (!(item as MenuItem & { iconEl?: HTMLElement }).iconEl?.querySelector("svg")) item.setIcon(fallback);
				item
					.setTitle(`${prefix}${label}`)
					.setChecked(this.calendarRange === value)
					.onClick(() => this.pickCalendarRange(value));
				(item as MenuItem & { dom?: HTMLElement }).dom?.setAttr("title", hint);
			});
		}
	}

	/** Show the Calendar in this range — switching to the Calendar first if need be. */
	private pickCalendarRange(range: CalendarRange): void {
		if (this.layout === "calendar") {
			this.setCalendarRange(range);
			return;
		}
		this.calendarRange = range;
		this.setLayout("calendar");
	}

	/** The shared tail every right-click menu carries beneath its context-specific
	 * commands: the layout and background groups, then the recent-notes switcher. */
	private addCommonMenuItems(menu: Menu): void {
		menu.addSeparator();
		this.addLayoutItems(menu);
		this.addBackgroundItems(menu, this.viewSettings());
		this.addRecentFileItems(menu);
	}

	/** The quick-switch section at the menu's bottom: the last opened card notes,
	 * pinned ones held in place so only the unpinned slots rotate with history.
	 * "Pin notes" (hover submenu; flat under a heading without submenu support)
	 * toggles which of them — the open note included — stay put. */
	private addRecentFileItems(menu: Menu): void {
		const entries = this.plugin.recentFileEntries(this.filePath);
		if (!entries.length) return;
		menu.addSeparator();
		SectionCardsView.addMenuHeading(menu, "Recent notes");
		for (const entry of entries) {
			menu.addItem((item) =>
				item
					.setTitle(entry.name)
					.setIcon(entry.pinned ? "pin" : "file-text")
					.setDisabled(entry.path === this.filePath)
					.onClick(() => void this.navigateTo(entry.path)),
			);
		}

		// Pin candidates: the open note leads (pinning what you're in is the common
		// wish), then every listed entry. Checked = pinned; a click toggles.
		const candidates: { path: string; name: string; pinned: boolean }[] = [];
		const file = this.getFile();
		if (file) candidates.push({ path: file.path, name: file.basename, pinned: this.plugin.isRecentPinned(file.path) });
		for (const entry of entries) {
			if (!candidates.some((c) => c.path === entry.path)) candidates.push(entry);
		}
		const addToggles = (target: Menu) => {
			for (const candidate of candidates) {
				target.addItem((item) =>
					item
						.setTitle(candidate.name)
						.setChecked(candidate.pinned)
						.onClick(() => void this.plugin.toggleRecentPin(candidate.path)),
				);
			}
		};
		if (SectionCardsView.submenuSupported()) {
			menu.addItem((item) => {
				item.setTitle("Pin notes").setIcon("pin");
				addToggles((item as MenuItem & { setSubmenu: () => Menu }).setSubmenu());
			});
		} else {
			SectionCardsView.addMenuHeading(menu, "Pin notes");
			addToggles(menu);
		}
	}

	/** The Background group — a hover-open "Background" submenu (flat under a heading
	 * where submenus don't exist); shared by the hamburger and right-click menus. */
	private addBackgroundItems(menu: Menu, base: ViewSettings): void {
		if (!SectionCardsView.submenuSupported()) {
			SectionCardsView.addMenuHeading(menu, "Background");
			this.addBackgroundOptions(menu, base);
			return;
		}
		menu.addItem((item) => {
			item.setTitle("Background").setIcon("image");
			this.addBackgroundOptions((item as MenuItem & { setSubmenu: () => Menu }).setSubmenu(), base);
		});
	}

	/** The Background actions themselves: picker, live sliders, remove. */
	private addBackgroundOptions(menu: Menu, base: ViewSettings): void {
		// The Deck's background is its own, not the picker's note's; a generated image
		// still lands in the attachment folder of a real note.
		const target = this.backgroundKey();
		const attachTo = this.deckMode ? this.plugin.settings.filePath : this.filePath;
		menu.addItem((item) =>
			item
				.setTitle("Select background…")
				.setIcon("image")
				.onClick(() => {
					new SelectBackgroundModal(this.app, {
						fromVault: () => {
							new BackgroundSuggestModal(this.app, (file) => {
								void this.plugin.setBackgroundImage(target, file.path, base);
							}).open();
						},
						fromLocal: () => this.pickLocalBackground(base),
						fromInternet: () => {
							new DownloadBackgroundModal(this.app, attachTo, (path) => {
								void this.plugin.setBackgroundImage(target, path, base);
							}).open();
						},
						fromGradient: () => {
							new GradientBackgroundModal(this.app, attachTo, (path) => {
								void this.plugin.setBackgroundImage(target, path, base);
							}).open();
						},
					}).open();
				}),
		);
		if (this.plugin.getBackgroundImage(target)) {
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
			const adjust = this.plugin.getBackgroundAdjust(target);
			sliderItem(
				"Transparency",
				"sun-dim",
				100,
				this.plugin.getBackgroundDim(target),
				(value) => this.contentEl.setCssProps({ "--sfsc-bg-veil": String(value / 100) }),
				(value) => void this.plugin.setBackgroundDim(target, value, base),
			);
			sliderItem(
				"Brightness",
				"sun",
				200,
				adjust.brightness,
				(value) => this.contentEl.setCssProps({ "--sfsc-bg-light": backgroundLightLayer(value) }),
				(value) => void this.plugin.setBackgroundAdjust(target, { brightness: value }, base),
			);
			sliderItem(
				"Saturation",
				"droplet",
				100,
				adjust.saturation,
				(value) => this.contentEl.setCssProps({ "--sfsc-bg-desat": backgroundDesatLayer(value) }),
				(value) => void this.plugin.setBackgroundAdjust(target, { saturation: value }, base),
			);
			menu.addItem((item) =>
				item
					.setTitle("Remove background")
					.setIcon("x")
					.onClick(() => void this.plugin.setBackgroundImage(target, null, base)),
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
	/** Whose background the pane shows and the Background menu edits: the note's, or —
	 * while the Deck is showing — the Deck's own. */
	private backgroundKey(): string {
		return this.deckMode ? DECK_BACKGROUND_KEY : this.filePath;
	}

	private applyBackground(): void {
		this.stampBackground(this.contentEl, this.backgroundKey());
	}

	/**
	 * Dress an element in a note's background — the image and its veil, brightness, and
	 * saturation as CSS variables, plus has-sfsc-bg, which styles.css layers into a
	 * background-image — or strip it when the note has none. The pane wears its own
	 * note's; a Deck tile wears the note it stands for.
	 */
	private stampBackground(el: HTMLElement, notePath: string): void {
		const path = this.plugin.getBackgroundImage(notePath);
		const file = path ? this.app.vault.getFileByPath(path) : null;
		if (file) {
			// The veil is only written inline when this note set its own strength;
			// otherwise styles.css's default (Style Settings can override it) applies.
			const dim = this.plugin.getBackgroundDimOverride(notePath);
			const adjust = this.plugin.getBackgroundAdjust(notePath);
			el.setCssProps({
				"--sfsc-bg-image": `url("${this.app.vault.getResourcePath(file)}")`,
				"--sfsc-bg-veil": dim === null ? "" : String(dim / 100),
				"--sfsc-bg-light": backgroundLightLayer(adjust.brightness),
				"--sfsc-bg-desat": backgroundDesatLayer(adjust.saturation),
			});
			el.addClass("has-sfsc-bg");
		} else {
			el.setCssProps({
				"--sfsc-bg-image": "",
				"--sfsc-bg-veil": "",
				"--sfsc-bg-light": "",
				"--sfsc-bg-desat": "",
			});
			el.removeClass("has-sfsc-bg");
		}
	}

	private openTemplateMenu(evt: MouseEvent | HTMLElement, btn: HTMLElement): void {
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
		SectionCardsView.showMenuAt(menu, evt);
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

	/** Ask for a heading and placement, write the new section, then open it for editing.
	 * Not from the Deck, where no note is showing to receive it. */
	promptNewCard(): void {
		if (this.deckMode) return;
		const file = this.getFile();
		if (!file) {
			new Notice(`can't find "${this.filePath}".`);
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

				// Open the new card's editor once it has been re-rendered (the Rolodex
				// turns to it first, or the editor would open on a hidden card).
				if (this.isSingleCardLayout()) this.roloActive.set(this.filePath, headingRaw);
				this.pendingEditHeading = headingRaw;
				await this.refresh();
			},
		).open();
	}

	/** Point this tab at another note, the way a link navigates a markdown tab. */
	async navigateTo(path: string, revealHeading?: string): Promise<void> {
		this.filePath = path;
		this.deckMode = false; // picking a note leaves the Deck
		this.applyStoredView();
		await this.syncView();
		if (revealHeading) await this.revealCard(revealHeading);
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

	// ---------- Stickies: one card in a sidebar tab or its own window ----------

	/** The section a sticky follows: its heading line, exact or equal bar spacing and case. (A rename
	 * through the plugin moves the sticky along — see renameSticky.) */
	private stickySection(sections: Section[]): Section | null {
		const raw = this.sticky;
		if (!raw) return null;
		const fold = (h: string) => h.trim().replace(/\s+/g, " ").toLowerCase();
		return sections.find((s) => s.headingRaw === raw) ?? sections.find((s) => fold(s.headingRaw) === fold(raw)) ?? null;
	}

	/** A card renamed through the plugin: a sticky on it follows the new heading. */
	renameSticky(oldRaw: string, newRaw: string): void {
		if (this.sticky !== oldRaw) return;
		this.sticky = newRaw;
		this.app.workspace.requestSaveLayout();
		this.syncLeafTitle();
	}

	/** Sticky mode: one card fills the pane (the Rolodex's shape, its tab strip hidden by
	 * CSS), the toolbar hidden, none of the view's other state in play — and none of it
	 * remembered for the note (rememberView). The card's level is read off its heading. */
	private applyStickyMode(): void {
		this.contentEl.toggleClass("is-sticky", !!this.sticky);
		if (!this.sticky) return;
		this.layout = "rolodex";
		this.headingLevel = /^#+/.exec(this.sticky)?.[0].length ?? this.headingLevel;
		this.preCalendarLevel = null;
		this.hierarchyOn = false;
		this.sectionsOn = false;
		this.starredOnly = false;
		this.taskFilter = "all";
		this.groupBy = "none";
		this.deckMode = false;
	}

	/** The strip above a sticky's card: the note it belongs to (or that the section is
	 * gone), and the ways out — the note's full cards view, the section in the editor,
	 * or closing the sticky. */
	private syncStickyHead(file: TFile, section: Section | null): void {
		if (!this.stickyHeadEl) {
			this.stickyHeadEl = createDiv({ cls: "sfsc-sticky-head" });
			this.toolbarEl.insertAdjacentElement("afterend", this.stickyHeadEl);
		}
		const head = this.stickyHeadEl;
		head.empty();
		head.toggleClass("is-missing", !section);
		fastIcon(head.createSpan({ cls: "sfsc-sticky-icon" }), "sticky-note");
		const title = (this.sticky ?? "").replace(/^#+\s*/, "") || "(untitled)";
		head.createSpan({
			cls: "sfsc-sticky-note",
			text: section ? file.basename : `“${title}” isn't in ${file.basename} any more.`,
			attr: { title: section ? file.path : "" },
		});
		const button = (label: string, icon: string, onClick: () => void) => {
			const btn = head.createEl("button", { cls: "sfsc-sticky-btn" });
			fastIcon(btn, icon);
			btn.setAttr("aria-label", label);
			btn.addEventListener("click", onClick);
		};
		button("Open the note's cards", DECK_ICON, () => void this.plugin.openCardsView(file.path, section?.headingRaw));
		if (section) button("Open this section in the note", "external-link", () => void this.plugin.revealSection(file, section.headingLine));
		if (this.stickyWindow()) {
			const onTop = head.createEl("button", { cls: "sfsc-sticky-btn sfsc-sticky-ontop" });
			SectionCardsView.setIconOr(onTop, "bring-to-front", "arrow-up-to-line");
			const label = () => {
				onTop.toggleClass("is-active", this.stickyOnTop);
				onTop.setAttr("aria-label", this.stickyOnTop ? "Stop keeping this window on top" : "Keep this window on top");
			};
			label();
			onTop.addEventListener("click", () => {
				this.stickyOnTop = !this.stickyOnTop;
				this.applyStickyOnTop();
				this.app.workspace.requestSaveLayout();
				label();
			});
		}
		button("Close this sticky", "x", () => this.leaf.detach());
	}

	/**
	 * The popout window's Electron handle, as Obsidian attaches it to every window it
	 * opens (its own "Toggle always on top" command reads the same property). Null in
	 * the main window, on mobile, or should the property ever go — then the on-top
	 * button simply doesn't appear.
	 */
	private stickyWindow(): { isAlwaysOnTop(): boolean; setAlwaysOnTop(flag: boolean): void } | null {
		if (!Platform.isDesktopApp) return null;
		const win = this.containerEl.win as Window & { electronWindow?: unknown };
		if (win === window) return null;
		const ew = win.electronWindow as { isAlwaysOnTop?: unknown; setAlwaysOnTop?: unknown } | undefined;
		if (!ew || typeof ew.isAlwaysOnTop !== "function" || typeof ew.setAlwaysOnTop !== "function") return null;
		return ew as { isAlwaysOnTop(): boolean; setAlwaysOnTop(flag: boolean): void };
	}

	/** Make the window match the remembered on-top flag (a restored popout starts off). */
	private applyStickyOnTop(): void {
		const w = this.stickyWindow();
		if (!w) return;
		try {
			if (w.isAlwaysOnTop() !== this.stickyOnTop) w.setAlwaysOnTop(this.stickyOnTop);
		} catch {
			/* a window mid-close; nothing to do */
		}
	}

	/** Whether this card can be opened as a sticky: a real section, from a full view, on desktop. */
	private stickyOffered(section: Section): boolean {
		return !this.sticky && !Platform.isMobile && !section.unfiled && !section.properties;
	}

	/** Stickies: open this card on its own in a new window. */
	private addStickyItems(menu: Menu, file: TFile, section: Section): void {
		if (!this.stickyOffered(section)) return;
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Open in a sticky window")
				.setIcon("sticky-note")
				.onClick(() => void this.plugin.openSticky(file.path, section.headingRaw)),
		);
	}

	// ---------- Level bar: the card level leaves text out ----------

	/**
	 * A bar along the pane's bottom — like the date-hide bar — when text sits under
	 * headings that aren't cards at this level: how many lines, under which levels, with
	 * a button to switch to the level that would show the most and one for the Hierarchy
	 * view, whose columns at least show the headings. Dismissable per note and level.
	 */
	private syncLevelBar(lines: string[]): void {
		const bar = this.levelBarEl;
		if (!bar) return;
		// Not in the Deck, a sticky, the date grids (which place every day), or a canvas
		// (which has its tray); the Rolodex and Day Planner do get it — one card at a time
		// hides the rest of the note even more quietly than a sparse wall.
		const applies = !this.deckMode && !this.sticky && !this.isDateLayout() && !this.isCanvasLayout();
		const coverage = applies ? levelCoverage(lines, this.headingLevel) : null;
		const key = `${this.filePath}:${this.headingLevel}`;
		const show = !!coverage && coverage.hiddenLines > 0 && this.levelBarDismissed !== key;
		bar.toggleClass("is-hidden", !show);
		this.contentEl.toggleClass("has-levelbar", show);
		this.positionLevelBar();
		if (!show || !coverage) return;
		bar.empty();
		fastIcon(bar.createSpan({ cls: "sfsc-datebar-icon" }), "eye-off");
		const levels = coverage.hiddenLevels.map((l) => `H${l}`).join(", ");
		const n = coverage.hiddenLines;
		bar.createSpan({
			cls: "sfsc-datebar-text",
			text: `${n} line${n === 1 ? "" : "s"} of text under ${levels} ${n === 1 ? "isn't" : "aren't"} on a card at H${this.headingLevel}`,
		});
		if (coverage.bestLevel !== null) {
			const best = coverage.bestLevel;
			const btn = bar.createEl("button", { text: `Show H${best}` });
			btn.setAttr("aria-label", `Switch the card level to H${best}, where most of that text sits`);
			btn.addEventListener("click", () => void this.changeHeadingLevel(best));
		}
		if (!this.hierarchyOn && !this.isSingleCardLayout()) {
			const btn = bar.createEl("button", { text: "Hierarchy view" });
			btn.setAttr("aria-label", "Show the headings above the cards as columns");
			btn.addEventListener("click", () => {
				this.hierarchyOn = true;
				this.sectionsOn = false;
				this.rememberView();
				this.applyLayoutClass();
				this.buildToolbar();
				void this.refresh().then(() => this.app.workspace.requestSaveLayout());
			});
		}
		const close = bar.createEl("button", { cls: "sfsc-datebar-close" });
		fastIcon(close, "x");
		close.setAttr("aria-label", "Hide this notice for this note and level");
		close.addEventListener("click", () => {
			this.levelBarDismissed = key;
			bar.addClass("is-hidden");
			this.contentEl.removeClass("has-levelbar");
		});
	}

	/** The level bar sits above the date bar when both show. */
	private positionLevelBar(): void {
		const bar = this.levelBarEl;
		if (!bar) return;
		const dateShown = !!this.dateBarEl && !this.dateBarEl.hasClass("is-hidden");
		bar.setCssStyles({ bottom: dateShown ? `${this.dateBarEl?.offsetHeight ?? 0}px` : "" });
		this.contentEl.toggleClass("has-two-bars", dateShown && !bar.hasClass("is-hidden"));
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

		// A refresh rebuilds mid-edit cards from disk, so typed-but-unsaved work
		// would silently vanish — every path that renders over an open editor lands
		// here (switching notes, layouts, the Deck, external file changes). With
		// the setting on (the default), the editor commits first; finish() ends in
		// its own refresh over the saved content, so this pass hands off to that
		// one. Escape cancels explicitly (asking first when there's unsaved typing),
		// before any refresh is involved.
		if (this.activeEditor && this.plugin.settings.saveOnLeave) {
			await this.activeEditor.finish(true);
			return;
		}

		this.closeMaximized();
		const gen = ++this.renderGeneration;

		const file = this.getFile();
		this.cardObserver?.disconnect();
		this.editingKey = null;
		this.activeEditor = null;

		// The Deck replaces the whole wall until a note is picked; a missing default
		// note must not block it, so this branch outranks the not-found message.
		if (this.deckMode) {
			this.renderDeck();
			this.syncDateBar();
			return;
		}

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
		this.plugin.recordRecentFile(file.path);
		const content = await this.app.vault.cachedRead(file);
		if (gen !== this.renderGeneration) return;
		const lines = content.split(/\r?\n/);

		// The Heading dropdown offers only the levels the note actually has (plus the
		// current one); an edit that introduces or removes a level updates it in place
		// on the post-save refresh.
		this.noteLines = lines;
		this.availableLevels = headingLevelsIn(lines);
		if (this.levelOptionValues().join(",") !== this.levelOptionsShown) this.populateLevelOptions();

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
		if (!this.isDateLayout() && this.preCalendarLevel !== null) {
			this.headingLevel = this.preCalendarLevel;
			this.preCalendarLevel = null;
			this.buildToolbar();
		}
		if (this.isDateLayout() && dateLevel && dateLevel !== this.headingLevel) {
			this.preCalendarLevel ??= this.headingLevel;
			this.headingLevel = dateLevel;
			this.buildToolbar();
		}
		// Measured before the card DOM churns below — reading offsetHeight after the
		// rebuild would force a synchronous reflow of the whole freshly-touched grid.
		if (this.layout === "calendar") this.updateToolbarOffset();

		// The Images and Links canvases render the note's links, not its sections —
		// the whole card pipeline below doesn't apply, so they take over here.
		if (this.layout === "images" || this.layout === "links") {
			this.clearPreviewTiles(this.layout === "images" ? "links" : "images");
			if (this.layout === "images") this.renderImagesLayout(file, content);
			else this.renderLinksLayout(file, content);
			return;
		}
		// Leaving a preview canvas: its tiles don't belong to any card layout.
		this.clearPreviewTiles("images");
		this.clearPreviewTiles("links");

		const parsed = parseCards(lines, this.headingLevel, this.plugin.unfiledTitle(), this.plugin.propertiesTitle());
		// A sticky shows one section — the card it was opened from — and says so above it.
		const stickySection = this.sticky ? this.stickySection(parsed) : null;
		if (this.sticky) {
			this.syncStickyHead(file, stickySection);
			this.applyStickyOnTop();
		}
		const sections = this.sticky ? (stickySection ? [stickySection] : []) : parsed;
		this.syncLevelBar(lines);

		// Does this note deal in dates? The checkbox rules when the user has set it;
		// until then the note decides for itself (the tally above already looked at
		// every heading). The jump-to-date button additionally needs a date to land on.
		const noteHasDates = dateCounts[this.headingLevel] > 0;
		this.containsDates = this.plugin.getContainsDates(file.path) ?? noteHasDates;
		this.hasDateHeadings = this.containsDates && noteHasDates;
		this.jumpDateWrap?.toggleClass("is-hidden", !this.hasDateHeadings);
		if (this.datesToggle) this.datesToggle.checked = this.containsDates;
		this.syncDatesLabel();
		this.syncDateBar();

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

		// The date layouts only mean something on a dated note: without the Dates
		// checkbox there is nothing to place, so say so instead of guessing.
		const calendar = this.layout === "calendar";
		if (this.isDateLayout() && !this.containsDates) {
			this.showEmpty(
				`The ${calendar ? "Calendar" : "Heatmap"} layout needs date headings.`,
				"Turn on the toolbar's Dates checkbox, or pick another layout.",
			);
			return;
		}

		// The Heatmap renders day cells straight from the sections — no cards.
		if (this.layout === "heatmap") {
			this.renderHeatmapLayout(file, sections, cardFormat, detect);
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
		} else if (this.layout === "tasks") {
			// The Tasks layout orders by date, then first tag, then title.
			ordered = applyPinned(sortTasksLayout(sections, cardFormat, detect, this.sortOrder), pinnedList);
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
			// Group-by buckets take the bars over from the ancestor headings.
			const grouped =
				this.groupBy !== "none"
					? groupCards(ordered.slice(pinnedCount), this.groupBy, {
							emoji: starEmoji,
							format: cardFormat,
							detect,
							todayIso: mo().format("YYYY-MM-DD"),
						})
					: groupByAncestor(ordered.slice(pinnedCount), parseAncestorHeadings(lines, this.headingLevel));
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
				".section-cards-row-rule, .section-cards-pin-rule, .section-cards-section-bar, .section-cards-empty, .sc-cal-nav, .sc-cal-divider, .sc-cal-dow, .sc-cal-month, .sc-cal-blank, .sc-heat-wrap, .sfsc-deck-card",
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
		const collapsedKeys = new Set(this.plugin.getCollapsed(file.path));
		const renders: Promise<void>[] = [];
		const immediate: CardEntry[] = [];
		const deferred: CardEntry[] = [];
		const queueBody = (entry: CardEntry) => {
			if (!entry.renderBody) return;
			// On the canvas, unplaced cards are display:none — rendering their markdown
			// would be pure waste. Placement back-fills the owed render (applyCustomLayout).
			if (this.layout === "custom" && !this.customPlacements[entry.holder.section.headingRaw]) return;
			// The Day Planner renders the showing card's lines itself; the cards stay hidden.
			if (this.layout === "planner") return;
			if (immediate.length < INITIAL_RENDER_COUNT) {
				immediate.push(entry);
				renders.push(this.runBodyRender(entry));
			} else {
				deferred.push(entry);
			}
		};

		// The strip's position is a nudge for the note in view; another note starts clean.
		if (this.actionsBottomFile !== file.path) {
			this.actionsBottomFile = file.path;
			this.actionsBottom.clear();
		}

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
				this.applyDueMarks(entry.el, section, today);
				this.syncCollapseButton(entry.el, collapsedKeys.has(section.headingRaw));
				this.applyBodyHeight(entry.bodyEl);
				this.applyBodyHeight(entry.backEl);
			} else {
				entry = this.renderCard(file, section, today);
			}
			// Reused cards keep their old pin state; a pin toggle re-renders with the same raw.
			const isPinned = pinnedKeys.has(section.headingRaw);
			if (entry.el.hasClass("is-pinned") !== isPinned) this.applyPinState(entry.el, isPinned);
			// A reused element may now hold a different card: match the strip to this one.
			const atBottom = this.actionsBottom.has(section.headingRaw);
			if (entry.el.hasClass("is-actions-bottom") !== atBottom) this.applyActionsBottom(entry.el, atBottom);
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
		this.applySelectionClasses();

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
		if (calendar) {
			this.layoutCalendar(isoByHeading);
			// Opening the Calendar on a dated note lands on today — the card, or the empty
			// cell — once per note per visit to the layout (switchLayout resets it).
			if (this.containsDates && this.calendarJumpedFor !== file.path) {
				this.calendarJumpedFor = file.path;
				const iso = mo().format("YYYY-MM-DD");
				this.gridEl
					.querySelector<HTMLElement>(`.section-card.is-today, .sc-cal-blank[data-sc-iso="${iso}"]`)
					?.scrollIntoView({ block: "center" });
				this.todayJumpedFor = file.path; // the first-render jump would aim at the same card
			}
		}
		if (this.layout === "rolodex") this.layoutRolodex();
		if (this.layout === "planner") this.layoutPlanner();
		else this.clearPlanner();

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
		// …and once more after a filter or date hide is switched OFF: the cards still
		// wear the hidden class from the last pass (the Rolodex's tabs never came back).
		const dateHide = this.plugin.getDateHide(file.path);
		if (
			this.filterQuery.trim() ||
			this.starredOnly ||
			this.contentEl.hasClass("is-starred-only") ||
			dateHide.future ||
			dateHide.past ||
			this.cardEntries.some((entry) => entry.el.hasClass("is-filtered-out"))
		) {
			this.applyFilter();
		}
		this.applyTaskFilter(); // marks task-empty cards before the pack measures
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
			if (normalised) this.persistCanvas();
		}
		this.applyCustomLayout();
		this.observeCards();
		if (deferred.length) this.scheduleDeferredRenders(deferred, gen);

		// Calendar feed, when asked to: the first render of a note with a feed brings
		// today's card up to date — once per note per session, since the write re-renders.
		// Only a card that exists: opening a note never makes one.
		if (
			this.plugin.settings.feedAutoUpdate &&
			!this.sticky &&
			!this.plugin.feedAutoUpdated.has(file.path) &&
			this.plugin.getCalendarFeed(file.path)
		) {
			this.plugin.feedAutoUpdated.add(file.path);
			void this.updateTodayFromFeed(false, true);
		}

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
					this.persistCanvas();
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

		this.syncLeafTitle();
	}

	/**
	 * Keep the leaf's titles in sync with the note being shown. updateHeader (undocumented
	 * but stable) redraws the tab; the view header's own title — the row Obsidian shows
	 * with "Show tab title bar" on — isn't redrawn by it, and kept naming the note the
	 * tab opened on after a switch through the note picker or the Deck.
	 */
	private syncLeafTitle(): void {
		(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
		this.containerEl.querySelector<HTMLElement>(".view-header-title")?.setText(this.getDisplayText());
	}

	/**
	 * Wikilinks inside markdown this plugin rendered: clicking one opens that note as
	 * cards, in its own remembered view. Every surface that renders a body needs this —
	 * Obsidian wires links for its own preview, embeds, and editor only, so a link on a
	 * planner card or a card's back face would otherwise do nothing at all.
	 */
	private wireLinkClicks(el: HTMLElement, file: TFile, skip?: () => boolean): void {
		el.addEventListener("click", (evt) => {
			const anchor = (evt.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a");
			if (!anchor || skip?.()) return;
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
	}

	private renderCard(file: TFile, section: Section, today: { iso: string; formatted: string } | null): CardEntry {
		const holder = { section };
		const scope = new Component();
		this.addChild(scope);

		// Built detached; refresh's ordering pass inserts it at the right position.
		const card = createDiv();
		card.className = "section-card";
		// The properties card: a table of the note's frontmatter. CSS drops the quick-add
		// and delete buttons, since neither makes sense on YAML.
		if (section.properties) card.addClass("is-properties");

		if (today && isTodayTitle(section.title, today.iso, today.formatted)) {
			card.addClass("is-today");
		}

		const header = card.createDiv({ cls: "section-card-header" });
		header.createDiv({ cls: "section-card-title", text: section.title || "(untitled)" });
		// Tasks layout only (CSS hides it elsewhere): how many tasks the card is
		// showing under the current filter — applyTaskFilter keeps it current.
		header.createDiv({ cls: "sfsc-task-count" });
		const dueBadge = header.createDiv({ cls: "sfsc-due-badge" });
		dueBadge.setAttr("aria-label", "Go to the first overdue task");
		dueBadge.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			void this.revealDueTask(card, holder.section);
		});
		this.applyDueMarks(card, section, today);

		// The delete confirmation, shared by the hover strip's trash button and the
		// title bar's right-click menu.
		const confirmDeleteCard = () => {
			const target = holder.section;
			new ConfirmDeleteModal(this.app, target.title || "(untitled)", async () => {
				const ok = await deleteSection(this.app, file, this.headingLevel, target);
				if (ok) {
					new Notice(`Deleted “${target.title || "(untitled)"}” from ${file.basename}`);
				} else {
					new Notice("Couldn't find that section — the file changed on disk.");
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
			if (!holder.section.unfiled) {
				menu.addItem((item) =>
					item
						.setTitle("Rename card…")
						.setIcon("pencil")
						.onClick(() => this.promptRenameCard(holder.section)),
				);
			}
			this.addFeedItem(menu, holder.section);
			menu.addItem((item) => item.setTitle("Delete card").setIcon("trash-2").onClick(confirmDeleteCard));
			this.addStickyItems(menu, file, holder.section);
			// The Rolodex card already fills the pane, so "big" has nothing to do there.
			if (this.layout !== "rolodex") {
				const big = card.hasClass("is-maximized");
				menu.addItem((item) =>
					item
						.setTitle(big ? "Put card back" : "Make card big")
						.setIcon(big ? "zoom-out" : "zoom-in")
						.onClick(() => this.toggleMaximized(card)),
				);
			}
			menu.addItem((item) =>
				item
					.setTitle(card.hasClass("is-collapsed") ? "Expand card" : "Collapse card")
					.setIcon(card.hasClass("is-collapsed") ? "chevron-down" : "chevron-up")
					.onClick(() => this.setCollapsed(card, holder.section.headingRaw, !card.hasClass("is-collapsed"))),
			);
			const flipBtn = card.querySelector<HTMLElement>(".section-card-flip");
			if (flipBtn) {
				menu.addItem((item) =>
					item
						.setTitle(card.hasClass("is-flipped") ? "Flip back to the front" : "Flip the card over")
						.setIcon(FLIP_ICON)
						.onClick(() => flipBtn.click()),
				);
			}
			this.addSelectionMenuItems(menu, holder.section);
			this.addCommonMenuItems(menu);
			menu.showAtMouseEvent(evt);
		});

		// The pin sits in the title bar's right corner, always visible as a bare glyph:
		// dim when unpinned, full-strength accent when pinned. (applyPinState below sets
		// the icon and label; the other actions stay in the hover strip.)
		// The collapse chevron sits beside the pin as a bare glyph: folding a card is a
		// state you glance at, like pinning, not a one-off action for the hover strip.
		const collapseBtn = header.createEl("button", { cls: "section-card-collapse" });
		collapseBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.setCollapsed(card, holder.section.headingRaw, !card.hasClass("is-collapsed"));
		});
		this.syncCollapseButton(card, this.plugin.getCollapsed(file.path).includes(section.headingRaw));
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

		// The title bar: a plain click selects the card, Shift-click extends the selection
		// to it, and Ctrl/⌘-click makes the card big. (The Rolodex card already fills the
		// pane, so "big" is a no-op there, matching its hidden big button.)
		header.addEventListener("click", (evt) => {
			if ((evt.target as HTMLElement | null)?.closest("button")) return;
			evt.stopPropagation();
			const key = holder.section.headingRaw;
			if (evt.ctrlKey || evt.metaKey) {
				if (this.layout !== "rolodex") this.toggleMaximized(card);
				return;
			}
			if (evt.shiftKey) {
				this.selectRange(key);
				return;
			}
			this.selectOnly(key);
		});

		const untrayBtn = header.createEl("button", { cls: "section-card-untray" });
		fastIcon(untrayBtn, "x");
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

		// The strip's buttons are built on the card's first hover or focus — at once on
		// touch, where they sit in the title row — rather than for every card up front: a
		// shell's icons were most of its cost on a big wall, and most cards are never
		// hovered. ensureActions also serves code that looks a strip button up.
		let actionsBuilt = false;
		let buildFlipButton: (() => void) | null = null;
		const ensureActions = () => {
			if (actionsBuilt) return;
			actionsBuilt = true;
			const quickAddBtn = actions.createEl("button", { cls: "section-card-quickadd" });
			fastIcon(quickAddBtn, "plus");
			quickAddBtn.setAttr("aria-label", "Quick add text to this card");
			quickAddBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				const target = holder.section;
				const hasBack = this.cardFaces(target.body).back !== null;
				new QuickAddModal(this.plugin, target.title || "(untitled)", hasBack, async (text, where) => {
					const ok = await quickAddToSection(this.app, file, this.headingLevel, target, text, where, this.flipMarker());
					if (!ok) {
						new Notice("Couldn't find that section — the file changed on disk.");
					}
					await this.refresh();
				}).open();
			});

			const colorBtn = actions.createEl("button", { cls: "section-card-color" });
			fastIcon(colorBtn, "palette");
			colorBtn.setAttr("aria-label", "Set this card's color");
			colorBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.openColorMenu(evt, file, holder.section.headingRaw);
			});

			const deleteBtn = actions.createEl("button", { cls: "section-card-delete" });
			fastIcon(deleteBtn, "trash-2");
			deleteBtn.setAttr("aria-label", "Delete this card");
			deleteBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				confirmDeleteCard();
			});

			const bigBtn = actions.createEl("button", { cls: "section-card-big" });
			// Magnifier for the click action (make the card big); the button doubles as the
			// grab point for drag-to-reorder, which the tooltip spells out.
			fastIcon(bigBtn, "zoom-in");
			bigBtn.setAttr("aria-label", "Make this card big · drag to reorder");
			bigBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.toggleMaximized(card);
			});

			if (this.stickyOffered(section)) {
				const stickyBtn = actions.createEl("button", { cls: "section-card-sticky" });
				fastIcon(stickyBtn, "sticky-note");
				stickyBtn.setAttr("aria-label", "Open in a sticky window");
				stickyBtn.addEventListener("click", (evt) => {
					evt.stopPropagation();
					void this.plugin.openSticky(file.path, section.headingRaw);
				});
			}

			const openBtn = actions.createEl("button", { cls: "section-card-open" });
			fastIcon(openBtn, "external-link");
			openBtn.setAttr("aria-label", "Open this section in the note");
			openBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				void this.plugin.revealSection(file, holder.section.headingLine);
			});
			buildFlipButton?.();

			// The strip hangs over the body's first line. This sends it to the card's
			// bottom edge and back, so either end of the card can be read and clicked.
			// On touch the strip sits in the title row and covers nothing.
			if (!Platform.isMobile) {
				const moveBtn = actions.createEl("button", { cls: "section-card-movestrip" });
				moveBtn.addEventListener("click", (evt) => {
					evt.stopPropagation();
					const key = holder.section.headingRaw;
					const atBottom = !this.actionsBottom.has(key);
					if (atBottom) this.actionsBottom.add(key);
					else this.actionsBottom.delete(key);
					this.applyActionsBottom(card, atBottom);
				});
				this.applyActionsBottom(card, this.actionsBottom.has(holder.section.headingRaw));
			}
		};
		card.addEventListener("pointerenter", ensureActions);
		card.addEventListener("focusin", ensureActions);

		this.applyPinState(card, this.plugin.getPinned(file.path).includes(section.headingRaw));

		// markdown-rendered lets Obsidian's own reading-view CSS style lists, tasks, tags, etc.
		const bodyEl = card.createDiv({ cls: "section-card-body markdown-rendered" });
		this.applyBodyHeight(bodyEl);

		// With the flip option on, a back-side marker splits the body: the front renders
		// here, the back into its own face, shown when the card is flipped over.
		const faces = this.cardFaces(section.body);
		let renderBody: (() => Promise<void>) | null = null;
		if (section.properties) {
			renderBody = () => this.renderProperties(bodyEl, card, holder, file, scope);
		} else if (faces.front.trim()) {
			renderBody = () =>
				MarkdownRenderer.render(this.app, bodyForRender(this.cardFaces(holder.section.body).front), bodyEl, file.path, scope);
		} else if (faces.back !== null) {
			bodyEl.createDiv({ cls: "section-card-placeholder", text: "Nothing on the front — flip the card over." });
		} else {
			bodyEl.createDiv({ cls: "section-card-placeholder", text: "Empty section — click to add content." });
		}

		let backEl: HTMLElement | null = null;
		if (faces.back !== null) {
			// It wears section-card-body too, so each layout's body styling carries over;
			// the front stays the card's first .section-card-body for every lookup.
			backEl = card.createDiv({ cls: "section-card-body section-card-back markdown-rendered" });
			this.wireLinkClicks(backEl, file, () => card.hasClass("is-editing"));
			this.applyBodyHeight(backEl);
			buildFlipButton = () => {
				const flipBtn = actions.createEl("button", { cls: "section-card-flip" });
				fastIcon(flipBtn, FLIP_ICON);
				flipBtn.setAttr("aria-label", card.hasClass("is-flipped") ? "Flip back to the front" : "Flip the card over");
				flipBtn.addEventListener("click", (evt) => {
					evt.stopPropagation();
					void this.flipCard(card);
				});
			};
			// A card remembered as showing its back comes back the same way — across
			// rebuilds, layout switches, and reopening the note.
			if (this.plugin.getFlipped(file.path).includes(section.headingRaw)) {
				card.addClass("is-flipped");
				void this.renderBack(backEl, holder, file, scope);
			}
		}

		// A wikilink to another note opens that note as cards, in its own remembered view.
		this.wireLinkClicks(bodyEl, file, () => card.hasClass("is-editing"));

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

		// A click on a block arms this before opening the card editor, so the second
		// click of a double can cancel it and open the Edit line window instead.
		let pendingEdit: number | null = null;

		card.addEventListener("click", (evt) => {
			const target = evt.target as HTMLElement;
			// Let links and internal-link clicks behave normally.
			if (target.closest("a")) return;
			if (target.closest("input[type=checkbox]")) return;
			if (card.hasClass("is-editing")) return;
			// Anywhere on the card: Ctrl/⌘-click makes it big, Shift-click toggles it in
			// the selection (and moves the keyboard focus here).
			if (!target.closest("button") && (evt.ctrlKey || evt.metaKey)) {
				evt.preventDefault();
				evt.stopPropagation();
				if (this.layout !== "rolodex") this.toggleMaximized(card);
				return;
			}
			if (!target.closest("button") && evt.shiftKey) {
				evt.preventDefault();
				evt.stopPropagation();
				this.selectRange(holder.section.headingRaw);
				return;
			}
			if (this.selected.size) this.clearSelection(false);
			// A calendar cell is too small to edit in place: any click makes the day
			// big first; the maximized card then edits on click as usual. Another
			// card's open editor still commits, exactly like the click-away below.
			// (A day shown on its own already fills the pane — it edits like any card.)
			if (this.calendarZoomsToEdit() && !card.hasClass("is-maximized")) {
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
			// On a block, the card editor waits a beat so a double-click can claim the
			// click pair for the Edit line window instead. Elsewhere it opens at once.
			if (this.blockAt(bodyEl, target, holder.section)) {
				if (evt.detail > 1) return; // second click of a double — dblclick handles it
				if (pendingEdit !== null) window.clearTimeout(pendingEdit);
				pendingEdit = window.setTimeout(() => {
					pendingEdit = null;
					if (!card.hasClass("is-editing")) this.startEditing(card, file, holder.section);
				}, 280);
				return;
			}
			this.startEditing(card, file, holder.section);
		});

		// Double-click a task or paragraph: open it in the Edit line window.
		bodyEl.addEventListener("dblclick", (evt) => {
			if (card.hasClass("is-editing")) return;
			const target = evt.target as HTMLElement | null;
			if (target?.closest("a") || target?.closest("input[type=checkbox]")) return;
			if (this.calendarZoomsToEdit() && !card.hasClass("is-maximized")) return;
			const found = this.blockAt(bodyEl, target, holder.section);
			if (!found) return;
			if (pendingEdit !== null) {
				window.clearTimeout(pendingEdit);
				pendingEdit = null;
			}
			evt.preventDefault();
			evt.stopPropagation();
			this.openEditBlockModal(file, holder.section, found.blockIndex, found.blockText);
		});

		// Right-click a task or paragraph: send it to a neighbouring card without dragging.
		bodyEl.addEventListener("contextmenu", (evt) => {
			if (card.hasClass("is-editing") || holder.section.properties) return;
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
									"Couldn't find that section — the file changed on disk.",
								);
							}
							await this.refresh();
						}),
				);
				this.addCommonMenuItems(menu);
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
			// Dragging one of several selected cards moves them all, in document order.
			if (this.selected.has(holder.section.headingRaw) && this.selected.size > 1) {
				this.draggingMany = this.cardEntries
					.filter((e) => this.selected.has(e.holder.section.headingRaw))
					.map((e) => e.holder.section);
				for (const e of this.cardEntries) {
					if (this.selected.has(e.holder.section.headingRaw)) e.el.addClass("is-dragging");
				}
			}
			if (evt.dataTransfer) {
				evt.dataTransfer.effectAllowed = "move";
				evt.dataTransfer.setData("text/plain", holder.section.headingRaw);
			}
		});
		card.addEventListener("dragend", () => {
			card.removeClass("is-dragging");
			if (this.draggingMany) {
				for (const e of this.cardEntries) e.el.removeClass("is-dragging");
				this.draggingMany = null;
			}
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
			if (this.draggingMany?.some((m) => m.headingRaw === holder.section.headingRaw)) return;
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
						new Notice("Couldn't merge — the file changed on disk.");
					}
					await this.refresh();
				}).open();
				return;
			}
			const many = this.draggingMany;
			this.draggingMany = null;
			if (many && many.length > 1) {
				// Dropping onto one of the dragged cards has nowhere sensible to land.
				if (many.some((m) => m.headingRaw === holder.section.headingRaw)) return;
				void this.completeDragMany(file, many, holder.section, this.isDropBefore(evt, card));
				return;
			}
			void this.completeDrag(file, moved, holder.section, this.isDropBefore(evt, card));
		});

		if (Platform.isMobile) ensureActions();
		return { el: card, bodyEl, backEl, scope, holder, raw: section.raw, renderBody, ensureActions };
	}

	/**
	 * Scroll a card into view and flash it — used when arriving from a `[[Note#Heading]]`
	 * link. Silently does nothing if that heading isn't a card at the current level.
	 */
	async revealCard(heading: string): Promise<void> {
		if (!heading) return;
		const wanted = heading.replace(/^#+\s*/, "").trim().toLowerCase();
		for (let { el, section } of this.cardsByHeading.values()) {
			if (section.title.trim().toLowerCase() !== wanted) continue;
			// Outside the Calendar's Week or Day range the card is hidden: turn to its day,
			// and land on the card the refresh put there.
			if (el.hasClass("is-cal-outside")) {
				await this.turnCalendarTo(titleToIso(section.title, this.cardFormat(), this.plugin.settings.dateDetectFormat));
				const hit = this.cardsByHeading.get(section.headingRaw);
				if (!hit) return;
				({ el, section } = hit);
			}
			if (this.isSingleCardLayout()) {
				const entry = this.cardEntries.find((e) => e.el === el);
				if (entry) this.setSingleCardActive(entry);
			}
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

		this.cardEntries.find((e) => e.el === card)?.ensureActions();
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
		// Only a press that starts on the backdrop closes the card. A text selection
		// dragged out of the card — past its edge, or out of the window — ends with a
		// click on the nearest common ancestor, which is the backdrop too.
		let pressedBackdrop = false;
		overlay.addEventListener("pointerdown", (evt) => {
			pressedBackdrop = evt.target === overlay;
		});
		overlay.addEventListener("click", (evt) => {
			if (evt.target === overlay && pressedBackdrop) this.closeMaximized();
			pressedBackdrop = false;
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
			// Big, a two-faced card shows both faces stacked (CSS), so the back is needed.
			const file = this.getFile();
			if (owed.backEl && file) void this.renderBack(owed.backEl, owed.holder, file, owed.scope);
		}

		// Scrolling is locked while blown up, so the overlay's inset covers the visible tab.
		this.contentEl.addClass("has-maximized-card");
		const caret = captureCaret(card);
		overlay.appendChild(card);
		card.addClass("is-maximized");
		body.setCssStyles({ maxHeight: "" });
		// Big, the back is free to grow like the front; the next flip re-measures it.
		card.querySelector<HTMLElement>(".section-card-back")?.setCssStyles({ maxHeight: "", height: "" });
		fastIcon(button, "zoom-out");
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
		this.applyBodyHeight(open.card.querySelector<HTMLElement>(".section-card-back"));
		fastIcon(open.button, "zoom-in");
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
		const first = (blockLines[0] ?? "").trim();
		// An image or media embed renders as pixels, not prose, so the text check
		// below could never pass — for those, the DOM agrees with the source when
		// the rendered embed names the same target file/URL.
		const media = /^!\[\[([^\][|#\n]+)/.exec(first) ?? /^!\[[^\]\n]*\]\(\s*<?([^)\s>]+)/.exec(first);
		if (media) {
			let target = media[1].split("#")[0].trim();
			try {
				target = decodeURIComponent(target);
			} catch {
				// a stray % — compare as written
			}
			const base = (target.split("/").pop() ?? target).toLowerCase();
			if (!base) return true;
			for (const node of Array.from(el.querySelectorAll<HTMLElement>(".internal-embed, img, video, audio"))) {
				let hay = `${node.getAttribute("src") ?? ""} ${node.getAttribute("alt") ?? ""}`;
				try {
					hay = decodeURIComponent(hay);
				} catch {
					// raw is fine for the comparison
				}
				if (hay.toLowerCase().includes(base)) return true;
			}
			return false;
		}
		const key = SectionCardsView.blockKey(first);
		if (!key) return true; // nothing distinctive to compare
		// The rendered text keeps characters the key drops — a literal ">" or "(…)", a
		// #tag's hash — so it's normalised the same way before the comparison.
		const dom = SectionCardsView.normalizeBlockText(el.textContent ?? "");
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

	/** Visible placed rects except the one being moved. Hidden-level keys don't collide,
	 * and neither do cards the canvas isn't showing (filter, hidden dates, hierarchy):
	 * they're display:none, so blocking a drop there would look like a dead zone.
	 * On the Images canvas "visible" means the image is still linked by the note. */
	private otherPlacements(except: string): CardRect[] {
		const present =
			this.layout === "images"
				? (key: string) => this.imagesByKey.size === 0 || this.imagesByKey.has(key)
				: this.layout === "links"
					? (key: string) => this.linksByKey.size === 0 || this.linksByKey.has(key)
					: (key: string) => this.cardsByHeading.size === 0 || this.canvasCardVisible(key);
		return Object.entries(this.activePlacements())
			.filter(([key]) => key !== except && present(key))
			.map(([, rect]) => rect);
	}

	/**
	 * The properties card's body: a table with one row per frontmatter property. Values
	 * render as markdown (links and tags stay live) and edit in place — click a value,
	 * type, Enter or click away saves, Esc cancels. The edit rewrites just that
	 * property's lines in the frontmatter, in the shape the file already used.
	 */
	private async renderProperties(
		bodyEl: HTMLElement,
		card: HTMLElement,
		holder: { section: Section },
		file: TFile,
		scope: Component,
	): Promise<void> {
		const props = parseYamlProperties(holder.section.body);
		if (!props.length) {
			await MarkdownRenderer.render(this.app, propertiesMarkdown(holder.section.body), bodyEl, file.path, scope);
			return;
		}
		const table = bodyEl.createEl("table", { cls: "sfsc-props" });
		const renders: Promise<void>[] = [];
		for (const prop of props) {
			const row = table.createEl("tr");
			row.createEl("td", { cls: "sfsc-prop-key", text: prop.key });
			const cell = row.createEl("td", { cls: "sfsc-prop-value" });
			cell.setAttr("aria-label", `Edit ${prop.key}`);
			const display = propertyDisplay(prop);
			if (display) renders.push(MarkdownRenderer.render(this.app, display, cell, file.path, scope));
			else cell.createSpan({ cls: "sfsc-prop-empty", text: "—" });
			cell.addEventListener("click", (evt) => {
				const target = evt.target as HTMLElement | null;
				if (target?.closest("a, input, textarea") || card.hasClass("is-editing")) return;
				evt.preventDefault();
				evt.stopPropagation();
				// Click-away commits another card's open editor, as any card click does.
				const open = this.activeEditor;
				if (open && open.card !== card) void open.finish(true);
				this.editPropertyValue(cell, prop, holder, file);
			});
		}
		await Promise.all(renders);
	}

	/** Swap a property's cell for a text field; commit rewrites the frontmatter. */
	private editPropertyValue(cell: HTMLElement, prop: YamlProperty, holder: { section: Section }, file: TFile): void {
		if (cell.querySelector("input, textarea")) return;
		const before = propertyEditText(prop);
		const multiline = prop.shape === "folded" || before.includes("\n");
		const shown = Array.from(cell.childNodes);
		for (const node of shown) node.remove();
		const field = multiline
			? cell.createEl("textarea", { cls: "sfsc-prop-input" })
			: cell.createEl("input", { cls: "sfsc-prop-input", attr: { type: "text" } });
		field.value = before;
		if (multiline) (field as HTMLTextAreaElement).rows = Math.min(8, before.split("\n").length + 1);
		cell.addClass("is-editing");
		let done = false;
		const restore = () => {
			field.remove();
			cell.removeClass("is-editing");
			for (const node of shown) cell.appendChild(node);
		};
		const finish = (save: boolean) => {
			if (done) return;
			done = true;
			const value = field.value.replace(/\s+$/, "");
			if (!save || value === before) {
				restore();
				return;
			}
			const next = setYamlProperty(holder.section.body, prop.key, value);
			if (next === holder.section.body) {
				restore();
				return;
			}
			void writeSection(this.app, file, this.headingLevel, holder.section, next).then((ok) => {
				if (ok) void this.refresh();
				else restore();
			});
		};
		field.addEventListener("keydown", (evt: Event) => {
			const key = evt as KeyboardEvent;
			if (key.key === "Escape") {
				evt.preventDefault();
				evt.stopPropagation();
				finish(false);
			} else if (key.key === "Enter" && (!multiline || key.ctrlKey || key.metaKey)) {
				evt.preventDefault();
				evt.stopPropagation();
				finish(true);
			}
		});
		field.addEventListener("blur", () => finish(true));
		// The card's own click-to-edit must not fire for clicks inside the field.
		field.addEventListener("click", (evt) => evt.stopPropagation());
		field.addEventListener("dblclick", (evt) => evt.stopPropagation());
		field.focus();
		if (!multiline) (field as HTMLInputElement).select();
	}

	/** Whether the canvas is showing this section's card (it exists and isn't hidden
	 * by the filter, the date gate, or the hierarchy columns). */
	private canvasCardVisible(key: string): boolean {
		const el = this.cardsByHeading.get(key)?.el;
		return !!el && !el.hasClass("is-filtered-out") && !el.hasClass("is-hier-hidden") && !el.hasClass("is-section-hidden");
	}

	/** A hidden card doesn't block drops, so another card may now sit on its spot.
	 * When it comes back, walk it down to the nearest free spot, as a drop would. */
	private resolveRevealedOverlaps(revealed: string[]): void {
		if (this.layout !== "custom" || !revealed.length) return;
		let moved = false;
		for (const key of revealed) {
			const rect = this.customPlacements[key];
			if (!rect || !this.canvasCardVisible(key)) continue;
			const others = this.otherPlacements(key);
			if (!others.some((other) => rectsCollide(rect, other, CUSTOM_GAP))) continue;
			this.customPlacements[key] = findFreeSpot(rect, others, CUSTOM_GAP, CUSTOM_SNAP);
			moved = true;
		}
		if (!moved) return;
		this.persistCanvas();
		this.applyCanvasLayout();
	}

	/** For a section tile being dragged from the tray: "past" / "future" when the date
	 * gate would hide it as soon as it landed, else null. Placed cards and the image
	 * and link canvases never refuse. */
	private dateHiddenDragReason(drag: { kind: "tile" | "card"; key: string }): "past" | "future" | null {
		if (drag.kind !== "tile" || this.layout !== "custom") return null;
		const section = this.cardsByHeading.get(drag.key)?.section;
		return section ? this.dateHiddenAs(section, this.dateGate()) : null;
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
		// Grab offsets in content px. A placed card keeps its exact grab point so it
		// starts moving from where it sits (it renders zoomed, so unscale). A tray tile
		// is a small label standing in for a full-size card, so its offset is clamped
		// to keep the ghost — and the drop — near the pointer.
		const zoom = kind === "card" ? this.canvasZoom() : 1;
		const rawX = (evt.clientX - grabbed.left) / zoom;
		const rawY = (evt.clientY - grabbed.top) / zoom;
		const drag = {
			kind,
			key,
			label,
			// Placements can't change mid-drag; computing this per mousemove was waste.
			obstacles: this.otherPlacements(key),
			w: size.w,
			h: size.h,
			offX: kind === "card" ? rawX : Math.min(rawX, size.w - 24, 140),
			offY: kind === "card" ? rawY : Math.min(rawY, size.h - 24, 20),
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
				// Screen-sized to match the zoomed card it stands in for.
				const zoom = this.canvasZoom();
				ghost.setCssStyles({ width: `${drag.w * zoom}px`, height: `${drag.h * zoom}px` });
			}
			drag.ghost = ghost;
		}
		// Offsets are content px; the ghost lives in screen px.
		const ghostZoom = drag.kind === "card" ? this.canvasZoom() : 1;
		drag.ghost?.setCssStyles({
			left: `${evt.clientX - drag.offX * ghostZoom}px`,
			top: `${evt.clientY - drag.offY * ghostZoom}px`,
		});
		const canvas = this.gridEl.getBoundingClientRect();
		const overCanvas =
			evt.clientX >= canvas.left && evt.clientX <= canvas.right && evt.clientY >= canvas.top && evt.clientY <= canvas.bottom;
		// A section the date gate hides can't land: it would vanish the moment it was
		// placed. No target highlight and no preview, so the refusal isn't a surprise.
		const refused = overCanvas && !!this.dateHiddenDragReason(drag);
		this.gridEl.toggleClass("is-drop-target", overCanvas && !refused);

		// Show exactly where the card will land — the same math the drop uses.
		if (overCanvas && !refused) {
			const px = (evt.clientX - canvas.left + this.gridEl.scrollLeft) / this.canvasZoom();
			const py = (evt.clientY - canvas.top + this.gridEl.scrollTop) / this.canvasZoom();
			const mins = this.canvasMins();
			const want = snapRect(
				{ x: px - drag.offX, y: py - drag.offY, w: drag.w, h: drag.h },
				CUSTOM_SNAP,
				mins.w,
				mins.h,
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
			const hiddenAs = this.dateHiddenDragReason(drag);
			if (hiddenAs) {
				new Notice(
					`“${drag.label}” is a ${hiddenAs} date and ${hiddenAs} dates are hidden — it wouldn't show on the canvas. Use Show on the dates bar first.`,
				);
				return;
			}
			const px = (evt.clientX - canvas.left + this.gridEl.scrollLeft) / this.canvasZoom();
			const py = (evt.clientY - canvas.top + this.gridEl.scrollTop) / this.canvasZoom();
			const mins = this.canvasMins();
			const want = snapRect(
				{ x: px - drag.offX, y: py - drag.offY, w: drag.w, h: drag.h },
				CUSTOM_SNAP,
				mins.w,
				mins.h,
			);
			this.activePlacements()[drag.key] = findFreeSpot(want, drag.obstacles, CUSTOM_GAP, CUSTOM_SNAP);
			this.persistCanvas();
			this.applyCanvasLayout();
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

	/** Remove everything from the canvas so the tray lists every item again. */
	private clearCanvas(): void {
		const placed = Object.keys(this.activePlacements()).length;
		if (!placed) return;
		if (this.layout === "images") this.imagePlacements = {};
		else if (this.layout === "links") this.linkPlacements = {};
		else this.customPlacements = {};
		this.persistCanvas();
		this.applyCanvasLayout();
		new Notice(`Canvas cleared — ${placed} ${placed === 1 ? "placement" : "placements"} returned to the list.`);
	}

	/** Return a placed card or image to the tray. */
	private untrayCard(key: string): void {
		delete this.activePlacements()[key];
		this.persistCanvas();
		this.applyCanvasLayout();
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

		this.applyCanvasZoom();
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
		const signature = `custom|${this.sortOrder}|${this.todayKeys()?.iso ?? ""}|${unplacedKeys.join("\u0000")}`;
		this.syncSavedLayoutDirty();
		if (signature === this.traySignature) return;
		this.traySignature = signature;
		this.rebuildTray(unplacedKeys);
	}

	/**
	 * Every image and video the note links, resolved and deduped: wiki/markdown/HTML
	 * embeds become vault resource paths (keyed by the file's vault path, so renames
	 * and different link styles converge), external URLs stay URLs, and data: URIs
	 * are keyed by a digest so the placement store never holds the pixels.
	 */
	private collectNoteImages(file: TFile, content: string): NoteImage[] {
		const images: NoteImage[] = [];
		const seen = new Set<string>();
		for (const { target, external } of imageLinksIn(content)) {
			if (external) {
				if (target.startsWith("data:")) {
					const key = `data:${shortHash(target)}`;
					if (seen.has(key)) continue;
					seen.add(key);
					const kind = /^data:video\//i.test(target) ? "video" : "image";
					images.push({ key, src: target, label: `(inline ${kind})`, kind });
					continue;
				}
				if (seen.has(target)) continue;
				seen.add(target);
				let label = target;
				let urlPath = target;
				try {
					urlPath = new URL(target).pathname;
					label = decodeURIComponent(urlPath.split("/").pop() || target);
				} catch {
					// not a parseable URL — the raw target is still a usable name
				}
				images.push({ key: target, src: target, label, kind: VIDEO_EXT.test(urlPath) ? "video" : "image" });
				continue;
			}
			let linkpath = target.split("#")[0];
			try {
				linkpath = decodeURIComponent(linkpath);
			} catch {
				// a stray % in a filename — use it as written
			}
			const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
			// Wiki embeds also match notes and PDFs; only image/video files stage previews.
			if (!dest || seen.has(dest.path)) continue;
			const kind = IMAGE_EXT.test(dest.path) ? "image" : VIDEO_EXT.test(dest.path) ? "video" : null;
			if (!kind) continue;
			seen.add(dest.path);
			images.push({ key: dest.path, src: this.app.vault.getResourcePath(dest), label: dest.name, kind });
		}
		return images;
	}

	/**
	 * The Images layout's whole render pass — the canvas shows the note's image
	 * previews instead of section cards, so refresh() hands over to this early.
	 * Placements load once per note and persist like the Custom Grid's.
	 */
	private renderImagesLayout(file: TFile, content: string): void {
		this.jumpDateWrap?.toggleClass("is-hidden", true);
		this.starBtn?.toggleClass("is-hidden", true);
		this.pendingEditHeading = null;
		this.pendingMaximizeHeading = null;

		this.imagesByKey.clear();
		const images = this.collectNoteImages(file, content);
		for (const image of images) this.imagesByKey.set(image.key, image);

		// Placements load once per note and are kept in memory from then on (see the
		// matching Custom Grid block in refresh for why). Keys for images no longer
		// linked are KEPT, so re-adding a link restores the image's old spot.
		if (this.imagesLoadedFor !== file.path) {
			this.imagesLoadedFor = file.path;
			this.imagesZoom = this.plugin.getImagesZoom(file.path);
			this.imagePlacements = {};
			const savedPlacements = Object.entries(this.plugin.getImagesGrid(file.path)).sort(
				([, a], [, b]) => a.y - b.y || a.x - b.x,
			);
			let normalised = false;
			for (const [key, rect] of savedPlacements) {
				const snapped = snapRect(rect, CUSTOM_SNAP, IMAGE_MIN_W, IMAGE_MIN_H);
				const spot = this.otherPlacements(key).some((other) => rectsCollide(snapped, other, CUSTOM_GAP))
					? findFreeSpot(snapped, this.otherPlacements(key), CUSTOM_GAP, CUSTOM_SNAP)
					: snapped;
				if (spot.x !== rect.x || spot.y !== rect.y || spot.w !== rect.w || spot.h !== rect.h) normalised = true;
				this.imagePlacements[key] = spot;
			}
			if (normalised) this.persistCanvas();
		}

		// An unchanged media set keeps its DOM: a note edit elsewhere must not make
		// every <img> re-decode (and, on the Links twin, every page reload). The src
		// carries the file's mtime, so an edited image still misses the signature.
		const signature = images.map((i) => [i.key, i.src, i.label, i.kind].join("\u0001")).join("\u0000");
		if (signature === this.previewRenderSig && this.imageEntries.length) {
			this.applyImagesLayout();
			this.observeCards(); // refresh() disconnected the observer up top
			return;
		}
		this.previewRenderSig = signature;

		// The card wall's leftovers don't apply here: cards, hierarchy columns,
		// dividers — and clearAllCards empties the grid wholesale, so the extent
		// marker goes back in after.
		this.clearAllCards();
		this.clearHierarchy();
		this.hideSnapPreview();
		this.imageLightboxClose?.(); // its media may be gone from the note
		this.gridEl.appendChild(this.canvasExtentEl);

		this.imageEntries = images.map((image) => this.renderImageCard(image));
		if (!images.length) {
			const empty = this.gridEl.createDiv({ cls: "section-cards-empty" });
			empty.createEl("p", { text: `No images found in ${file.basename}.` });
			empty.createEl("p", { text: "Embed images in the note — ![[shot.png]] or ![](url) — and they appear here." });
		}

		this.applyImagesLayout();
		this.observeCards(); // native-resize snapping rides the same observer as cards
		this.rememberView();
		this.syncLeafTitle();
	}

	/** One image or video preview on the canvas: the picture, a hover name bar, the
	 * remove ✕, and the pointer-drag/native-resize behaviour placed cards have.
	 * Videos stay muted with no native controls (they would fight the drag), showing
	 * their first frame and a play badge; double-click plays and pauses. */
	private renderImageCard(image: NoteImage): { key: string; el: HTMLElement; label: string } {
		const el = this.gridEl.createDiv({ cls: "sc-image-card" });
		if (image.kind === "video") {
			const video = el.createEl("video", {
				cls: "sc-image-card-img",
				attr: { src: image.src, preload: "metadata", playsinline: "" },
			});
			video.muted = true;
			video.loop = true;
			const badge = el.createDiv({ cls: "sc-image-play" });
			fastIcon(badge, "play");
			el.addEventListener("dblclick", () => {
				if (video.paused) void video.play();
				else video.pause();
				el.toggleClass("is-playing", !video.paused);
			});
		} else {
			el.createEl("img", {
				cls: "sc-image-card-img",
				attr: { src: image.src, alt: image.label, draggable: "false" },
			});
		}
		el.createDiv({ cls: "sc-image-card-name", text: image.label });
		el.addEventListener("contextmenu", (evt) => this.openImageMenu(evt, image));

		const untrayBtn = el.createEl("button", { cls: "sc-image-untray" });
		fastIcon(untrayBtn, "x");
		untrayBtn.setAttr("aria-label", "Remove from the canvas (back to the list)");
		untrayBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.untrayCard(image.key);
		});

		// Top-right on hover: the magnifier blows the preview up in place, and the ↗
		// beside it opens the ORIGINAL file — vault files in the system's default
		// app, external URLs in the browser. An inline data: URI has no original to
		// open, so the magnifier takes the corner alone (CSS keys off :last-child).
		const bigBtn = el.createEl("button", { cls: "sc-image-big" });
		fastIcon(bigBtn, "zoom-in");
		bigBtn.setAttr("aria-label", `Make this ${image.kind} big`);
		bigBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.openImageLightbox(image);
		});
		// Double-click magnifies images; videos keep double-click for play/pause.
		if (image.kind !== "video") {
			el.addEventListener("dblclick", () => this.openImageLightbox(image));
		}

		if (!image.key.startsWith("data:")) {
			const external = /^https?:\/\//i.test(image.key);
			const openBtn = el.createEl("button", { cls: "sc-image-open" });
			fastIcon(openBtn, "external-link");
			openBtn.setAttr("aria-label", external ? "Open the URL in your browser" : "Open the original file");
			openBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				if (external) window.open(image.key);
				// Undocumented but stable API, the same one Obsidian's own
				// "Open in default app" menu item uses.
				else (this.app as App & { openWithDefaultApp?: (path: string) => void }).openWithDefaultApp?.(image.key);
			});
		}

		el.addEventListener("pointerdown", (evt) => {
			if (!el.hasClass("is-placed")) return;
			if ((evt.target as HTMLElement | null)?.closest("button")) return;
			const rect = el.getBoundingClientRect();
			// The bottom-right corner belongs to the native resize grip; arm the same
			// click-swallow the cards use so ending a resize can't count as a click.
			if (evt.clientX >= rect.right - 28 && evt.clientY >= rect.bottom - 28) {
				window.addEventListener(
					"pointerup",
					() => {
						this.swallowNextClick = true;
						window.setTimeout(() => (this.swallowNextClick = false), 300);
					},
					{ once: true },
				);
				return;
			}
			const placement = this.imagePlacements[image.key];
			if (!placement) return;
			this.startPointerDrag(evt, "card", image.key, image.label, rect, { w: placement.w, h: placement.h });
		});

		return { key: image.key, el, label: image.label };
	}

	/** A vault image was renamed: carry its in-memory placement to the new key (the
	 * stored copy is remapped by the plugin's rename handler). */
	renameImageKey(oldPath: string, newPath: string): void {
		const rect = this.imagePlacements[oldPath];
		if (!rect) return;
		this.imagePlacements[newPath] = rect;
		delete this.imagePlacements[oldPath];
	}

	/** Closes the open image lightbox, if any. Null while none is showing. */
	private imageLightboxClose: (() => void) | null = null;

	/** The magnifier: the preview blown up over the whole view. Click away or
	 * Escape closes it; videos get their native controls here (nothing to drag). */
	private openImageLightbox(image: NoteImage): void {
		this.imageLightboxClose?.();
		const overlay = this.contentEl.createDiv({ cls: "sc-image-lightbox" });
		let media: HTMLElement;
		if (image.kind === "video") {
			const video = overlay.createEl("video", { attr: { src: image.src, controls: "", playsinline: "" } });
			video.muted = true;
			void video.play();
			media = video;
		} else {
			media = overlay.createEl("img", { attr: { src: image.src, alt: image.label, draggable: "false" } });
		}
		overlay.createDiv({ cls: "sc-image-lightbox-name", text: image.label });

		// Wheel zooms toward the pointer (0.25x–8x); dragging pans a zoomed view;
		// double-click resets. Transform-based, so the layout underneath never moves.
		let scale = 1;
		let tx = 0;
		let ty = 0;
		const applyTransform = () => {
			media.setCssStyles({ transform: `translate(${tx}px, ${ty}px) scale(${scale})` });
			media.toggleClass("is-zoomed", scale !== 1 || tx !== 0 || ty !== 0);
		};
		overlay.addEventListener(
			"wheel",
			(evt: WheelEvent) => {
				evt.preventDefault(); // the canvas behind must not scroll
				evt.stopPropagation();
				const next = Math.min(8, Math.max(0.25, scale * (evt.deltaY < 0 ? 1.15 : 1 / 1.15)));
				if (next === scale) return;
				// Keep the content under the cursor fixed while the scale changes.
				const rect = media.getBoundingClientRect();
				const cx = rect.left + rect.width / 2;
				const cy = rect.top + rect.height / 2;
				tx += (evt.clientX - cx) * (1 - next / scale);
				ty += (evt.clientY - cy) * (1 - next / scale);
				scale = next;
				applyTransform();
			},
			{ passive: false },
		);
		media.addEventListener("pointerdown", (evt: PointerEvent) => {
			if (evt.button !== 0) return;
			const startX = evt.clientX;
			const startY = evt.clientY;
			const baseX = tx;
			const baseY = ty;
			let moved = false;
			const move = (e: PointerEvent) => {
				const dx = e.clientX - startX;
				const dy = e.clientY - startY;
				// A still pointer stays a click, so video controls keep working.
				if (!moved && Math.hypot(dx, dy) < 4) return;
				moved = true;
				tx = baseX + dx;
				ty = baseY + dy;
				applyTransform();
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				window.removeEventListener("pointercancel", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			window.addEventListener("pointercancel", up);
		});
		media.addEventListener("dblclick", () => {
			scale = 1;
			tx = 0;
			ty = 0;
			applyTransform();
		});

		const onKey = (evt: KeyboardEvent) => {
			if (evt.key !== "Escape") return;
			evt.preventDefault();
			evt.stopPropagation();
			close();
		};
		const close = () => {
			overlay.remove();
			document.removeEventListener("keydown", onKey, true);
			this.imageLightboxClose = null;
		};
		this.imageLightboxClose = close;
		document.addEventListener("keydown", onKey, true);
		// Clicks on the media itself (video controls!) stay; the backdrop closes.
		overlay.addEventListener("click", (evt) => {
			if (evt.target !== media) close();
		});
	}

	/** Drop one preview canvas's tiles — switching layouts, or re-rendering the other
	 * canvas, must not leave the old tiles in the grid. */
	/** The last-rendered preview set's fingerprint, one per view — matching it lets a
	 * refresh keep the tile DOM (no image re-decodes, no page reloads). Only one
	 * preview canvas renders at a time, so images and links share the field. */
	private previewRenderSig: string | null = null;

	private clearPreviewTiles(kind: "images" | "links"): void {
		const entries = kind === "images" ? this.imageEntries : this.linkEntries;
		if (!entries.length) return;
		this.imageLightboxClose?.();
		this.previewRenderSig = null;
		for (const entry of entries) entry.el.remove();
		if (kind === "images") {
			this.imageEntries = [];
			this.imagesByKey.clear();
		} else {
			this.linkEntries = [];
			this.linksByKey.clear();
		}
	}

	/** The placement key a raw link target resolves to, or null when it isn't this
	 * layout's media — the removal pass matches spans against a tile with this. */
	private imageLinkKey(target: string, external: boolean, sourcePath: string): string | null {
		if (external) return target.startsWith("data:") ? `data:${shortHash(target)}` : target;
		let linkpath = target.split("#")[0];
		try {
			linkpath = decodeURIComponent(linkpath);
		} catch {
			// a stray % in a filename — use it as written
		}
		const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
		if (!dest || (!IMAGE_EXT.test(dest.path) && !VIDEO_EXT.test(dest.path))) return null;
		return dest.path;
	}

	/** Right-click on an image tile (canvas or tray): clipboard and delete commands. */
	private openImageMenu(evt: MouseEvent, image: NoteImage): void {
		evt.preventDefault();
		evt.stopPropagation();
		const menu = new Menu();
		if (image.kind === "image") {
			menu.addItem((item) =>
				item
					.setTitle("Copy image")
					.setIcon("copy")
					.onClick(() => void this.copyImageToClipboard(image)),
			);
			menu.addItem((item) =>
				item
					.setTitle("Cut image…")
					.setIcon("scissors")
					.onClick(async () => {
						// Copy first; a cut that couldn't copy must not delete anything.
						if (await this.copyImageToClipboard(image, true)) this.promptDeleteImage(image);
					}),
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("Paste image…")
				.setIcon("clipboard-paste")
				.onClick(() => void this.pasteImageFromClipboard()),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(`Delete ${image.kind}…`)
				.setIcon("trash-2")
				.onClick(() => this.promptDeleteImage(image)),
		);
		this.addCommonMenuItems(menu);
		menu.showAtMouseEvent(evt);
	}

	/** The tile's bytes: vault files read directly, URLs fetched through Obsidian
	 * (no CORS taint), data: URIs decoded in place. */
	private async imageBlob(image: NoteImage): Promise<Blob> {
		if (image.key.startsWith("data:")) {
			const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(image.src);
			if (!m) throw new Error("malformed data: URI");
			if (m[2]) {
				const binary = window.atob(m[3]);
				const bytes = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
				return new Blob([bytes], { type: m[1] || "image/png" });
			}
			return new Blob([decodeURIComponent(m[3])], { type: m[1] || "image/svg+xml" });
		}
		if (/^https?:\/\//i.test(image.key)) {
			const res = await requestUrl({ url: image.key });
			return new Blob([res.arrayBuffer], { type: res.headers["content-type"] ?? "" });
		}
		const tfile = this.app.vault.getFileByPath(image.key);
		if (!tfile) throw new Error(`missing file: ${image.key}`);
		const mime =
			{ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif", svg: "image/svg+xml" }[
				tfile.extension.toLowerCase()
			] ?? "application/octet-stream";
		return new Blob([await this.app.vault.readBinary(tfile)], { type: mime });
	}

	/** Copy the full image to the system clipboard. The clipboard only takes PNG, so
	 * every other format is redrawn losslessly-at-full-size through a canvas. */
	private async copyImageToClipboard(image: NoteImage, silent = false): Promise<boolean> {
		try {
			let blob = await this.imageBlob(image);
			if (blob.type !== "image/png") {
				const url = URL.createObjectURL(blob);
				try {
					const img = new window.Image();
					await new Promise<void>((resolve, reject) => {
						img.onload = () => resolve();
						img.onerror = () => reject(new Error("image failed to decode"));
						img.src = url;
					});
					const canvas = createEl("canvas");
					canvas.width = img.naturalWidth || 800;
					canvas.height = img.naturalHeight || 600;
					const ctx = canvas.getContext("2d");
					if (!ctx) throw new Error("no canvas context");
					ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
					blob = await new Promise<Blob>((resolve, reject) => {
						canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png");
					});
				} finally {
					URL.revokeObjectURL(url);
				}
			}
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
			if (!silent) new Notice("Image copied to the clipboard.");
			return true;
		} catch (err) {
			console.error("Single File Section Cards: copy image failed", err);
			new Notice("Couldn't copy the image to the clipboard.");
			return false;
		}
	}

	/** Paste the clipboard's image: saved as an attachment (Obsidian's attachment
	 * folder rules), embedded at the start or end of the note — the modal asks which. */
	private async pasteImageFromClipboard(): Promise<void> {
		const file = this.getFile();
		if (!file) return;
		let blob: Blob | null = null;
		try {
			for (const item of await navigator.clipboard.read()) {
				const type = item.types.find((t) => t.startsWith("image/"));
				if (type) {
					blob = await item.getType(type);
					break;
				}
			}
		} catch (err) {
			console.error("Single File Section Cards: clipboard read failed", err);
		}
		if (!blob) {
			new Notice("No image on the clipboard.");
			return;
		}
		const pasted = blob;
		new PasteImageModal(this.app, (where) => {
			void (async () => {
				const ext = pasted.type === "image/jpeg" ? "jpg" : (pasted.type.split("/")[1]?.split("+")[0] ?? "png");
				const path = await this.app.fileManager.getAvailablePathForAttachment(
					`Pasted image ${mo().format("YYYYMMDDHHmmss")}.${ext}`,
					file.path,
				);
				const created = await this.app.vault.createBinary(path, await pasted.arrayBuffer());
				const link = this.app.fileManager.generateMarkdownLink(created, file.path);
				const embed = link.startsWith("!") ? link : `!${link}`;
				await this.app.vault.process(file, (data) => {
					const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
					if (where === "end") return data.replace(/\s*$/, "") + eol + eol + embed + eol;
					const lines = data.split(/\r?\n/);
					lines.splice(firstContentLine(lines), 0, embed, "");
					return lines.join(eol);
				});
				new Notice(`Pasted image added to the ${where} of ${file.basename}.`);
				await this.refresh();
			})();
		}).open();
	}

	/** Excise every link markup in the note that resolves to this tile. */
	private async removeImageLinks(file: TFile, image: NoteImage): Promise<number> {
		let removed = 0;
		await this.app.vault.process(file, (data) => {
			const spans = imageLinkSpans(data).filter(
				(span) => this.imageLinkKey(span.target, span.external, file.path) === image.key,
			);
			if (!spans.length) return data;
			removed = spans.length;
			let out = data;
			for (const span of [...spans].reverse()) out = out.slice(0, span.start) + out.slice(span.end);
			return out;
		});
		return removed;
	}

	/** Delete: remove the tile's link(s) from the note, and — for a vault file —
	 * offer to trash the file itself too. */
	private promptDeleteImage(image: NoteImage): void {
		const file = this.getFile();
		if (!file) return;
		const isVaultFile = !image.key.startsWith("data:") && !/^https?:\/\//i.test(image.key);
		const tfile = isVaultFile ? this.app.vault.getFileByPath(image.key) : null;
		new DeleteImageModal(this.app, image.label, image.kind, !!tfile, (deleteFile) => {
			void (async () => {
				const removed = await this.removeImageLinks(file, image);
				if (!removed) {
					new Notice("Couldn't find that link — the note changed on disk.");
					await this.refresh();
					return;
				}
				if (deleteFile && tfile) await this.app.fileManager.trashFile(tfile);
				new Notice(
					`Removed ${removed === 1 ? "the link" : `${removed} links`} from ${file.basename}` +
						(deleteFile && tfile ? ` and moved “${image.label}” to the trash.` : "."),
				);
				await this.refresh();
			})();
		}).open();
	}

	/** Position placed images, hide trayed ones, and rebuild the tray when it changed —
	 * the Images canvas's applyCustomLayout. */
	private applyImagesLayout(): void {
		if (this.layout !== "images") return;
		this.applyCanvasZoom();
		let maxBottom = 0;
		let maxRight = 0;
		const unplaced: { key: string; label: string; index: number }[] = [];

		this.imageEntries.forEach((entry, index) => {
			const rect = this.imagePlacements[entry.key];
			if (rect) {
				entry.el.addClass("is-placed");
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
				unplaced.push({ key: entry.key, label: entry.label, index });
			}
		});

		this.updateCanvasExtent(maxRight, maxBottom);

		// The tray follows the active sort: A→Z/Z→A by file name, Doc by appearance.
		if (this.sortOrder !== "doc") {
			const dir = this.sortOrder === "asc" ? 1 : -1;
			unplaced.sort((a, b) => dir * a.label.localeCompare(b.label, undefined, { numeric: true }));
		}
		const unplacedKeys = unplaced.map((u) => u.key);

		const signature = `images|${this.sortOrder}|${unplacedKeys.join("\u0000")}`;
		if (signature === this.traySignature) return;
		this.traySignature = signature;
		this.rebuildImagesTray(unplacedKeys);
	}

	/**
	 * The Links layout's whole render pass — the canvas shows live page previews of
	 * the note's web links instead of section cards; refresh() hands over to this
	 * early. Placements load once per note and persist like the other canvases'.
	 */
	private renderLinksLayout(file: TFile, content: string): void {
		this.jumpDateWrap?.toggleClass("is-hidden", true);
		this.starBtn?.toggleClass("is-hidden", true);
		this.pendingEditHeading = null;
		this.pendingMaximizeHeading = null;

		this.linksByKey.clear();
		const links = urlLinksIn(content);
		for (const link of links) this.linksByKey.set(link.url, link);

		if (this.linksLoadedFor !== file.path) {
			this.linksLoadedFor = file.path;
			this.linksZoom = this.plugin.getLinksZoom(file.path);
			this.linkPlacements = {};
			const savedPlacements = Object.entries(this.plugin.getLinksGrid(file.path)).sort(
				([, a], [, b]) => a.y - b.y || a.x - b.x,
			);
			let normalised = false;
			for (const [key, rect] of savedPlacements) {
				const snapped = snapRect(rect, CUSTOM_SNAP, IMAGE_MIN_W, IMAGE_MIN_H);
				const spot = this.otherPlacements(key).some((other) => rectsCollide(snapped, other, CUSTOM_GAP))
					? findFreeSpot(snapped, this.otherPlacements(key), CUSTOM_GAP, CUSTOM_SNAP)
					: snapped;
				if (spot.x !== rect.x || spot.y !== rect.y || spot.w !== rect.w || spot.h !== rect.h) normalised = true;
				this.linkPlacements[key] = spot;
			}
			if (normalised) this.persistCanvas();
		}

		// An unchanged link set keeps its DOM — a rebuild here would reload every
		// page frame on each note edit, which is the single worst thing this
		// layout could do.
		const signature = links.map((l) => `${l.url} ${l.label}`).join(" ");
		if (signature === this.previewRenderSig && this.linkEntries.length) {
			this.applyLinksLayout();
			this.observeCards(); // refresh() disconnected the observer up top
			return;
		}
		this.previewRenderSig = signature;

		this.clearAllCards();
		this.clearHierarchy();
		this.hideSnapPreview();
		this.imageLightboxClose?.();
		// clearAllCards empties the grid wholesale — put the extent marker back.
		this.gridEl.appendChild(this.canvasExtentEl);

		this.linkEntries = links.map((link) => this.renderLinkCard(link));
		if (!links.length) {
			const empty = this.gridEl.createDiv({ cls: "section-cards-empty" });
			empty.createEl("p", { text: `No web links found in ${file.basename}.` });
			empty.createEl("p", { text: "Add links to the note — [name](URL) or a bare web address — and they appear here." });
		}

		this.applyLinksLayout();
		this.observeCards();
		this.rememberView();
		this.syncLeafTitle();
	}

	/** One page preview on the canvas: a title bar naming the page, the live iframe
	 * beneath it (inert, so the tile drags and resizes like an image), and the same
	 * hover buttons — magnify to an interactive lightbox, ↗ to the browser, ✕ away. */
	private renderLinkCard(link: UrlLink): { key: string; el: HTMLElement; label: string } {
		const el = this.gridEl.createDiv({ cls: "sc-image-card sc-link-card" });
		const bar = el.createDiv({ cls: "sc-link-card-bar" });
		fastIcon(bar.createSpan({ cls: "sc-link-card-icon" }), "globe");
		bar.createSpan({ cls: "sc-link-card-title", text: link.label });
		el.createEl("iframe", {
			cls: "sc-link-card-frame",
			attr: {
				src: link.url,
				sandbox: "allow-scripts allow-same-origin allow-forms allow-popups",
				loading: "lazy",
				tabindex: "-1",
				// The canvas copy is inert (pointer-events: none), so its scrollbars
				// would be dead weight; the lightbox copy scrolls instead.
				scrolling: "no",
			},
		});
		el.addEventListener("contextmenu", (evt) => this.openLinkMenu(evt, link));

		const untrayBtn = el.createEl("button", { cls: "sc-image-untray" });
		fastIcon(untrayBtn, "x");
		untrayBtn.setAttr("aria-label", "Remove from the canvas (back to the list)");
		untrayBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.untrayCard(link.url);
		});

		const bigBtn = el.createEl("button", { cls: "sc-image-big" });
		fastIcon(bigBtn, "zoom-in");
		bigBtn.setAttr("aria-label", "Make this page big (interactive)");
		bigBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.openLinkLightbox(link);
		});
		el.addEventListener("dblclick", () => this.openLinkLightbox(link));

		const openBtn = el.createEl("button", { cls: "sc-image-open" });
		fastIcon(openBtn, "external-link");
		openBtn.setAttr("aria-label", "Open the URL in your browser");
		openBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			window.open(link.url);
		});

		el.addEventListener("pointerdown", (evt) => {
			if (!el.hasClass("is-placed")) return;
			if ((evt.target as HTMLElement | null)?.closest("button")) return;
			const rect = el.getBoundingClientRect();
			if (evt.clientX >= rect.right - 28 && evt.clientY >= rect.bottom - 28) {
				window.addEventListener(
					"pointerup",
					() => {
						this.swallowNextClick = true;
						window.setTimeout(() => (this.swallowNextClick = false), 300);
					},
					{ once: true },
				);
				return;
			}
			const placement = this.linkPlacements[link.url];
			if (!placement) return;
			this.startPointerDrag(evt, "card", link.url, link.label, rect, { w: placement.w, h: placement.h });
		});

		return { key: link.url, el, label: link.label };
	}

	/** Right-click on a link tile: URL commands, then the shared menu tail. */
	private openLinkMenu(evt: MouseEvent, link: UrlLink): void {
		evt.preventDefault();
		evt.stopPropagation();
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Open in browser")
				.setIcon("external-link")
				.onClick(() => window.open(link.url)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Copy URL")
				.setIcon("copy")
				.onClick(() => {
					void navigator.clipboard.writeText(link.url).then(() => new Notice("URL copied to the clipboard."));
				}),
		);
		this.addCommonMenuItems(menu);
		menu.showAtMouseEvent(evt);
	}

	/** The magnifier for links: the page blown up over the view, fully interactive
	 * (the canvas tiles keep their iframes inert so dragging works). */
	private openLinkLightbox(link: UrlLink): void {
		this.imageLightboxClose?.();
		const overlay = this.contentEl.createDiv({ cls: "sc-image-lightbox sc-link-lightbox" });
		const frame = overlay.createEl("iframe", {
			cls: "sc-link-lightbox-frame",
			attr: { src: link.url, sandbox: "allow-scripts allow-same-origin allow-forms allow-popups" },
		});
		overlay.createDiv({ cls: "sc-image-lightbox-name", text: link.label });
		const onKey = (evt: KeyboardEvent) => {
			if (evt.key !== "Escape") return;
			evt.preventDefault();
			evt.stopPropagation();
			close();
		};
		const close = () => {
			overlay.remove();
			document.removeEventListener("keydown", onKey, true);
			this.imageLightboxClose = null;
		};
		this.imageLightboxClose = close;
		document.addEventListener("keydown", onKey, true);
		overlay.addEventListener("click", (evt) => {
			if (evt.target !== frame) close();
		});
	}

	/** Position placed link previews, hide trayed ones, and rebuild the tray when it
	 * changed — the Links canvas's applyCustomLayout. */
	private applyLinksLayout(): void {
		if (this.layout !== "links") return;
		this.applyCanvasZoom();
		let maxBottom = 0;
		let maxRight = 0;
		const unplaced: { key: string; label: string }[] = [];

		for (const entry of this.linkEntries) {
			const rect = this.linkPlacements[entry.key];
			if (rect) {
				entry.el.addClass("is-placed");
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
				unplaced.push({ key: entry.key, label: entry.label });
			}
		}

		this.updateCanvasExtent(maxRight, maxBottom);

		// The tray follows the active sort: A→Z/Z→A by label, Doc by appearance.
		if (this.sortOrder !== "doc") {
			const dir = this.sortOrder === "asc" ? 1 : -1;
			unplaced.sort((a, b) => dir * a.label.localeCompare(b.label, undefined, { numeric: true }));
		}
		const unplacedKeys = unplaced.map((u) => u.key);

		const signature = `links|${this.sortOrder}|${unplacedKeys.join("\u0000")}`;
		if (signature === this.traySignature) return;
		this.traySignature = signature;
		this.rebuildLinksTray(unplacedKeys);
	}

	/** The Links tray: a name-and-URL tile per unplaced link (no live iframes here —
	 * a tray full of loading pages would be pure weight). */
	private rebuildLinksTray(unplacedKeys: string[]): void {
		this.trayEl.empty();
		if (this.trayHidden()) {
			this.buildTrayBar("link");
			return;
		}
		this.buildTrayControls("link", "Drag a link onto the canvas");
		for (const key of unplacedKeys) {
			const link = this.linksByKey.get(key);
			if (!link) continue;
			const tile = this.trayEl.createDiv({ cls: "section-cards-tray-tile sc-link-tile" });
			const row = tile.createDiv({ cls: "sc-link-tile-row" });
			fastIcon(row.createSpan({ cls: "sc-link-card-icon" }), "globe");
			row.createSpan({ cls: "sc-link-tile-name", text: link.label });
			tile.createDiv({ cls: "sc-link-tile-url", text: link.url });
			tile.setAttr("aria-label", link.url);
			tile.addEventListener("contextmenu", (evt) => this.openLinkMenu(evt, link));
			tile.addEventListener("pointerdown", (evt) => {
				this.startPointerDrag(evt, "tile", key, link.label, tile.getBoundingClientRect(), {
					w: LINK_DEFAULT_W,
					h: LINK_DEFAULT_H,
				});
			});
		}
		if (!unplacedKeys.length) {
			this.trayEl.createDiv({ cls: "section-cards-tray-hint", text: "Every link is on the canvas." });
		}
	}

	/**
	 * The Heatmap layout's render pass: a year-at-a-glance activity graph of the
	 * dated cards — one cell per day in week columns, shaded by how many tasks the
	 * day finished — with streak stats above and a shade legend below. A filled cell
	 * opens its section in the note; an empty one offers to create the day's card.
	 */
	private renderHeatmapLayout(file: TFile, sections: Section[], format: string, detect: string): void {
		this.clearAllCards();
		this.clearHierarchy();
		this.jumpDateWrap?.toggleClass("is-hidden", true);
		this.starBtn?.toggleClass("is-hidden", true);
		this.pendingEditHeading = null;
		this.pendingMaximizeHeading = null;
		this.gridEl.appendChild(this.canvasExtentEl); // clearAllCards emptied the grid

		const days = heatmapDays(sections, format, detect);
		if (!days.size) {
			const empty = this.gridEl.createDiv({ cls: "section-cards-empty" });
			empty.createEl("p", { text: `No date headings found in ${file.basename}.` });
			empty.createEl("p", { text: "Days whose headings name a date, like 2026-08-26, each get a cell." });
			this.rememberView();
			return;
		}

		const todayIso = mo().format("YYYY-MM-DD");
		const isos = [...days.keys()].sort();
		const streaks = heatmapStreaks(isos, todayIso);
		let doneTotal = 0;
		let openTotal = 0;
		let maxDone = 1;
		for (const day of days.values()) {
			doneTotal += day.done;
			openTotal += day.open;
			if (day.done > maxDone) maxDone = day.done;
		}

		const wrap = this.gridEl.createDiv({ cls: "sc-heat-wrap" });
		const stats = wrap.createDiv({ cls: "sc-heat-stats" });
		const stat = (value: number, label: string) => {
			const box = stats.createDiv({ cls: "sc-heat-stat" });
			box.createDiv({ cls: "sc-heat-stat-value", text: String(value) });
			box.createDiv({ cls: "sc-heat-stat-label", text: label });
		};
		stat(streaks.current, "day streak");
		stat(streaks.longest, "longest streak");
		stat(days.size, days.size === 1 ? "day with a card" : "days with cards");
		stat(doneTotal, doneTotal === 1 ? "task done" : "tasks done");
		if (openTotal) stat(openTotal, "still open");

		// Week columns run from the first card's week through today's (or the last
		// card's, for notes that reach into the future). Same week-start rule as the
		// Calendar: the setting first, the locale otherwise.
		const locale = moment as unknown as {
			weekdaysShort: (localeSorted: boolean) => string[];
			localeData: () => { firstDayOfWeek: () => number };
		};
		const weekStartSetting = this.plugin.settings.weekStart;
		const firstDow =
			weekStartSetting === "sunday" ? 0 : weekStartSetting === "monday" ? 1 : locale.localeData().firstDayOfWeek();
		const names = locale.weekdaysShort(false);

		const first = isos[0];
		const last = isos[isos.length - 1] > todayIso ? isos[isos.length - 1] : todayIso;
		let cursor = first;
		while (new Date(`${cursor}T00:00:00Z`).getUTCDay() !== firstDow) cursor = shiftIso(cursor, -1);

		const scroll = wrap.createDiv({ cls: "sc-heat-scroll" });
		const graph = scroll.createDiv({ cls: "sc-heat-graph" });
		const dowCol = graph.createDiv({ cls: "sc-heat-week sc-heat-dows" });
		dowCol.createDiv({ cls: "sc-heat-mlabel" });
		for (let i = 0; i < 7; i++) {
			// Every other name keeps the column legible without crowding it.
			dowCol.createDiv({ cls: "sc-heat-dow", text: i % 2 === 1 ? names[(firstDow + i) % 7] : "" });
		}

		let lastMonth = "";
		while (cursor <= last) {
			const week = graph.createDiv({ cls: "sc-heat-week" });
			// The label reads from the week's first REAL day — lead-in pads would
			// otherwise stamp the previous month on the first column.
			const month = mo(cursor < first ? first : cursor, "YYYY-MM-DD").format("MMM");
			week.createDiv({ cls: "sc-heat-mlabel", text: month !== lastMonth ? month : "" });
			lastMonth = month;
			for (let i = 0; i < 7; i++) {
				const iso = cursor;
				cursor = shiftIso(cursor, 1);
				const cell = week.createDiv({ cls: "sc-heat-cell" });
				if (iso < first || iso > last) {
					cell.addClass("is-pad");
					continue;
				}
				const day = days.get(iso);
				const level = !day ? 0 : day.done === 0 ? 1 : 1 + Math.ceil((3 * day.done) / maxDone);
				cell.addClass(`lv${level}`);
				if (iso === todayIso) cell.addClass("is-today");
				const summary = day
					? `${iso} — ${day.done} done, ${day.open} open`
					: `${iso} — no card (click to create one)`;
				cell.setAttr("aria-label", summary);
				cell.setAttr("title", summary);
				cell.addEventListener("click", () => {
					if (day) void this.plugin.revealSection(file, day.headingLine);
					else this.promptCreateDateCard(iso);
				});
			}
		}

		const legend = wrap.createDiv({ cls: "sc-heat-legend" });
		legend.createSpan({ text: "Less" });
		for (let level = 0; level <= 4; level++) legend.createDiv({ cls: `sc-heat-cell lv${level}` });
		legend.createSpan({ text: "More" });

		// A graph wider than the pane (a phone, a long note) opens at its recent end —
		// today is what the streak-watcher came for, not last January.
		scroll.scrollLeft = scroll.scrollWidth;

		this.rememberView();
		this.syncLeafTitle();
	}

	/** Apply the zoom factor: cards, extent marker, preview and dots all ride the var. */
	private applyCanvasZoom(): void {
		this.gridEl.setCssProps({ "--sc-zoom": String(this.canvasZoom()) });
		this.zoomLabelEl?.setText(`${Math.round(this.canvasZoom() * 100)}%`);
	}

	private setCanvasZoom(zoom: number): void {
		const clamped = Math.round(Math.min(1.6, Math.max(0.4, zoom)) * 10) / 10;
		if (clamped === this.canvasZoom()) return;
		if (this.layout === "images") this.imagesZoom = clamped;
		else if (this.layout === "links") this.linksZoom = clamped;
		else this.customZoom = clamped;
		this.applyCanvasZoom();
		this.persistCanvas();
		this.applyCanvasLayout(); // recompute the scroll extent for the new scale
	}

	/**
	 * The canvas always scrolls: an invisible marker sits past the furthest card AND past
	 * the viewport, so there is room to pan in every direction the layout might grow.
	 * (Sizing the scroll container itself just grew the clipped element — content must
	 * be what defines the extent.)
	 */
	private updateCanvasExtent(maxRight: number, maxBottom: number): void {
		if (!this.isCanvasLayout()) return;
		const viewW = this.gridEl.clientWidth / this.canvasZoom();
		const viewH = this.gridEl.clientHeight / this.canvasZoom();
		const w = Math.max(maxRight, viewW) + 400;
		const h = Math.max(maxBottom, viewH) + 400;
		this.canvasExtentEl.setCssStyles({ left: `${w - 1}px`, top: `${h - 1}px` });
	}

	/** The tray is folded away for this note: its column is a slim bar (buildTrayBar). */
	private trayHidden(): boolean {
		return this.plugin.getTrayCollapsed(this.filePath);
	}

	/** The folded tray: a full-height bar where the column was; a click opens it again. */
	private buildTrayBar(noun: string): void {
		const bar = this.trayEl.createEl("button", { cls: "section-cards-tray-bar" });
		fastIcon(bar, "chevron-left");
		bar.setAttr("aria-label", `Show the ${noun} list`);
		bar.addEventListener("click", () => void this.setTrayCollapsed(false));
	}

	/** The zoom bar's panel button says what it does: hide the list, or show it. */
	private syncTrayToggle(): void {
		const btn = this.trayToggleBtn;
		if (!btn) return;
		const hidden = this.trayHidden();
		SectionCardsView.setIconOr(btn, hidden ? "panel-right-open" : "panel-right-close", hidden ? "chevron-left" : "chevron-right");
		btn.setAttr("aria-label", hidden ? "Show the list of what isn't on the canvas" : "Hide the list");
		btn.toggleClass("is-active", hidden);
	}

	/** A saved layout was applied to this note: drop the cached placements and redraw. */
	reloadPlacements(): void {
		this.placementsLoadedFor = null;
		this.traySignature = null;
		void this.refresh();
	}

	/**
	 * Custom Grid tray: the saved-layouts row — a switcher over the note's named
	 * arrangements (placements, zoom, background), a save button that names the current
	 * one, and a delete button for the one selected.
	 */
	private buildSavedLayoutsRow(): void {
		const row = this.trayEl.createDiv({ cls: "section-cards-tray-layouts" });
		const notePath = this.currentPath();
		const saved = this.plugin.getSavedLayouts(notePath);
		const names = Object.keys(saved).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
		const active = this.plugin.getActiveSavedLayout(notePath);
		const select = row.createEl("select", { cls: "dropdown section-cards-tray-layout-select" });
		select.createEl("option", { value: "", text: names.length ? "Saved layouts…" : "No saved layouts" });
		for (const name of names) select.createEl("option", { value: name, text: name });
		select.value = active && saved[active] ? active : "";
		select.setAttr("aria-label", "Switch to a saved layout");
		this.savedLayoutSelect = select;
		select.addEventListener("change", () => {
			const chosen = select.value;
			if (!chosen) return;
			this.confirmSavedLayoutChanges(
				() => void this.plugin.applySavedLayout(notePath, chosen),
				() => {
					select.value = active && saved[active] ? active : "";
					this.syncSavedLayoutDirty();
				},
			);
		});
		const iconBtn = (icon: string, label: string, onClick: () => void) => {
			const btn = row.createEl("button", { cls: "section-cards-tray-toggle section-cards-tray-layout-btn" });
			fastIcon(btn, icon);
			btn.setAttr("aria-label", label);
			btn.addEventListener("click", onClick);
			return btn;
		};
		const redraw = async () => {
			this.traySignature = null;
			await this.refresh();
		};
		iconBtn("save", "Save this arrangement and background as a layout…", () => {
			new TextInputModal(this.app, "Save layout", select.value || active || "", "Save", (value) => {
				const name = value.trim();
				if (!name) return;
				const write = () => void this.plugin.saveCanvasLayout(notePath, name, this.viewSettings()).then(redraw);
				if (saved[name] && name !== select.value) {
					new ConfirmActionModal(
						this.app,
						"Replace saved layout?",
						`“${name}” already exists. Replace it with the current arrangement and background?`,
						"Replace",
						false,
						write,
					).open();
				} else write();
			}).open();
		});
		const del = iconBtn("trash-2", "Delete the selected saved layout", () => {
			const name = select.value;
			if (!name) return;
			new ConfirmActionModal(
				this.app,
				"Delete saved layout?",
				`“${name}” is forgotten. The canvas stays as it is.`,
				"Delete",
				true,
				() => void this.plugin.deleteSavedLayout(notePath, name).then(redraw),
			).open();
		});
		const syncDelete = () => del.toggleAttribute("disabled", !select.value);
		syncDelete();
		select.addEventListener("change", syncDelete);
		this.syncSavedLayoutDirty();
	}

	/** The active saved layout and whether the canvas has drifted from it (placements,
	 * zoom, or background); null when no saved layout is active. */
	private savedLayoutState(): { name: string; dirty: boolean } | null {
		const notePath = this.currentPath();
		const name = this.plugin.getActiveSavedLayout(notePath);
		if (!name) return null;
		const saved = this.plugin.getSavedLayouts(notePath)[name];
		const entry = this.plugin.settings.perFile?.[notePath];
		if (!saved || !entry) return null;
		return { name, dirty: !canvasLayoutEquals(snapshotCanvasLayout(entry), saved) };
	}

	/** Mark the switcher's active entry with an asterisk while the canvas has unsaved changes. */
	private syncSavedLayoutDirty(): void {
		const select = this.savedLayoutSelect;
		if (!select?.isConnected) return;
		const state = this.savedLayoutState();
		for (const option of Array.from(select.options)) {
			if (!option.value) continue;
			option.text = state?.dirty && option.value === state.name ? `${option.value} *` : option.value;
		}
		select.toggleClass("is-dirty", !!state?.dirty);
		select.setAttr("title", state?.dirty ? `“${state.name}” has changed since it was saved` : "");
	}

	/**
	 * Before clearing the canvas, switching saved layouts, or leaving the Custom Grid:
	 * with the active saved layout changed, ask to save it (Save / Don't save / Cancel).
	 * `then` runs after a save or a discard; `cancelled` when the user stays.
	 */
	private confirmSavedLayoutChanges(then: () => void, cancelled?: () => void): void {
		const state = this.savedLayoutState();
		if (!state?.dirty) {
			then();
			return;
		}
		new SavedLayoutChangesModal(this.app, state.name, (choice) => {
			if (choice === "cancel") {
				cancelled?.();
				return;
			}
			if (choice === "save") {
				void this.plugin.saveCanvasLayout(this.currentPath(), state.name, this.viewSettings()).then(() => {
					this.syncSavedLayoutDirty();
					then();
				});
				return;
			}
			then();
		}).open();
	}

	/** Fold the tray away or bring it back, remembered per note; the tray redraws on the refresh. */
	private async setTrayCollapsed(collapsed: boolean): Promise<void> {
		await this.plugin.setTrayCollapsed(this.filePath, collapsed, this.viewSettings());
		this.contentEl.toggleClass("is-tray-collapsed", collapsed);
		this.syncTrayToggle();
		this.traySignature = null;
		await this.refresh();
	}

	/** Permanent tray controls, shared by both canvases: Clear, the sorts, the hint. */
	private buildTrayControls(noun: string, hint: string): void {
		const actions = this.trayEl.createDiv({ cls: "section-cards-tray-actions" });
		const clearBtn = actions.createEl("button", { cls: "section-cards-tray-clear", text: "Clear layout" });
		clearBtn.setAttr("aria-label", `Remove every ${noun} from the canvas, back into this list`);
		clearBtn.addEventListener("click", () => {
			const placed = Object.keys(this.activePlacements()).length;
			if (!placed) {
				new Notice("The canvas is already clear.");
				return;
			}
			this.confirmSavedLayoutChanges(() => new ConfirmClearModal(this.app, placed, noun, () => this.clearCanvas()).open());
		});
		const foldBtn = actions.createEl("button", { cls: "section-cards-tray-toggle" });
		fastIcon(foldBtn, "chevron-right");
		foldBtn.setAttr("aria-label", `Hide the ${noun} list`);
		foldBtn.addEventListener("click", () => void this.setTrayCollapsed(true));
		if (noun === "section") this.buildSavedLayoutsRow();
		const sortRow = this.trayEl.createDiv({ cls: "section-cards-tray-sorts" });
		const sorts: [SortOrder, string][] = [
			["asc", "A→Z"],
			["desc", "Z→A"],
			["doc", "Doc"],
		];
		for (const [order, label] of sorts) {
			const btn = sortRow.createEl("button", { cls: "section-cards-tray-sort", text: label });
			btn.setAttr("aria-label", `Sort ${noun}s ${SORT_LABELS[order]}`);
			btn.toggleClass("is-active", this.sortOrder === order);
			btn.addEventListener("click", () => {
				if (this.sortOrder === order) return;
				this.sortOrder = order;
				this.rememberView();
				void this.syncView().then(() => this.app.workspace.requestSaveLayout());
			});
		}
		this.trayEl.createDiv({ cls: "section-cards-tray-hint", text: hint });
	}

	private rebuildTray(unplacedKeys: string[]): void {
		this.trayEl.empty();
		if (this.trayHidden()) {
			this.buildTrayBar("section");
			return;
		}
		this.buildTrayControls("section", "Drag a section onto the canvas");
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

	/** The Images tray: a thumbnail-and-name tile per unplaced image. */
	private rebuildImagesTray(unplacedKeys: string[]): void {
		this.trayEl.empty();
		if (this.trayHidden()) {
			this.buildTrayBar("image");
			return;
		}
		this.buildTrayControls("image", "Drag an image onto the canvas");
		for (const key of unplacedKeys) {
			const image = this.imagesByKey.get(key);
			if (!image) continue;
			const tile = this.trayEl.createDiv({ cls: "section-cards-tray-tile sc-image-tile" });
			let thumbSize: () => { w: number; h: number };
			if (image.kind === "video") {
				const thumb = tile.createEl("video", {
					cls: "sc-image-thumb",
					attr: { src: image.src, preload: "metadata", playsinline: "" },
				});
				thumb.muted = true;
				thumbSize = () => ({ w: thumb.videoWidth, h: thumb.videoHeight });
			} else {
				const thumb = tile.createEl("img", {
					cls: "sc-image-thumb",
					attr: { src: image.src, alt: image.label, draggable: "false" },
				});
				thumbSize = () => ({ w: thumb.naturalWidth, h: thumb.naturalHeight });
			}
			tile.createDiv({ cls: "sc-image-tile-name", text: image.label });
			tile.setAttr("aria-label", image.label);
			tile.addEventListener("contextmenu", (evt) => this.openImageMenu(evt, image));
			tile.addEventListener("pointerdown", (evt) => {
				// A fresh drop takes the image's own aspect ratio (when the thumbnail
				// has loaded), snapped to the grid and capped for very tall images.
				const natural = thumbSize();
				const ratio =
					natural.w > 0 && natural.h > 0 ? natural.h / natural.w : CUSTOM_DEFAULT_H / CUSTOM_DEFAULT_W;
				const h = Math.min(
					IMAGE_DEFAULT_MAX_H,
					Math.max(IMAGE_MIN_H, Math.round((IMAGE_DEFAULT_W * ratio) / CUSTOM_SNAP) * CUSTOM_SNAP),
				);
				this.startPointerDrag(evt, "tile", key, image.label, tile.getBoundingClientRect(), {
					w: IMAGE_DEFAULT_W,
					h,
				});
			});
		}
		if (!unplacedKeys.length) {
			this.trayEl.createDiv({ cls: "section-cards-tray-hint", text: "Every image is on the canvas." });
		}
	}


	/** A backgrounded tab reports 0x0 for everything; size logic must ignore it. */
	private viewIsHidden(): boolean {
		return this.gridEl.clientWidth === 0 && this.gridEl.clientHeight === 0;
	}

	/** While a canvas card or image is being resized, preview the size it will snap to. */
	private previewCanvasResize(): void {
		if (this.viewIsHidden()) return;
		const mins = this.canvasMins();
		for (const { key, el } of this.canvasItems()) {
			const stored = this.activePlacements()[key];
			if (!stored || !el.hasClass("is-placed") || el === this.maximized?.card) continue;
			const w = el.offsetWidth;
			const h = el.offsetHeight;
			if (Math.abs(w - stored.w) < 2 && Math.abs(h - stored.h) < 2) continue;
			const proposed = snapRect({ ...stored, w, h }, CUSTOM_SNAP, mins.w, mins.h);
			const colliding = this.otherPlacements(key).some((other) => rectsCollide(proposed, other, CUSTOM_GAP));
			this.showSnapPreview(proposed, colliding);
			return; // only one item resizes at a time
		}
	}

	/** Canvas: snap an item's CSS resize to the grid, or revert it if it would collide. */
	private validateCanvasSizes(): void {
		this.hideSnapPreview();
		// Switching tabs hides the view: every card then measures 0x0, which used to be
		// read as a resize-to-minimum and saved, shrinking the whole layout.
		if (this.viewIsHidden()) return;
		const placements = this.activePlacements();
		const mins = this.canvasMins();
		let changed = false;
		for (const { key, el } of this.canvasItems()) {
			const stored = placements[key];
			if (!stored || !el.hasClass("is-placed")) continue;
			// A maximized card fills the overlay, not its placement: measuring it here
			// used to "restore" the stored size onto the big card, shrinking it in place.
			if (el === this.maximized?.card) continue;
			const w = el.offsetWidth;
			const h = el.offsetHeight;
			if (w === 0 && h === 0) continue; // individually hidden (e.g. mid-transition)
			if (Math.abs(w - stored.w) < 2 && Math.abs(h - stored.h) < 2) continue;
			const proposed = snapRect({ ...stored, w, h }, CUSTOM_SNAP, mins.w, mins.h);
			if (
				(proposed.w === stored.w && proposed.h === stored.h) ||
				this.otherPlacements(key).some((other) => rectsCollide(proposed, other, CUSTOM_GAP))
			) {
				// Snapped back to what it was, or the new size would collide: restore.
				el.setCssStyles({ width: `${stored.w}px`, height: `${stored.h}px` });
			} else {
				placements[key] = proposed;
				el.setCssStyles({ width: `${proposed.w}px`, height: `${proposed.h}px` });
				changed = true;
			}
		}
		if (changed) this.persistCanvas();
	}

	/** Normalise a source line / DOM text for the drag-start sanity check. */
	private static blockKey(text: string): string {
		return SectionCardsView.normalizeBlockText(text.replace(/^\s*(?:[-*+]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/, "")).slice(0, 24);
	}

	/** Text with markdown punctuation dropped and whitespace folded, lower-cased — applied
	 * to the source line and the rendered text alike, so the two can be compared. */
	private static normalizeBlockText(text: string): string {
		return text
			.replace(/[*_`~[\]()#|>]/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();
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
	/** The Edit line window — from the block menu or a double-click on the block. */
	private openEditBlockModal(file: TFile, section: Section, blockIndex: number, blockText: string): void {
		new EditBlockModal(this.plugin, blockText, async (text) => {
			const ok = await replaceBlockInFile(this.app, file, this.headingLevel, section, blockIndex, blockText, text);
			if (!ok) {
				new Notice("Couldn't find that line — the file changed on disk.");
			}
			await this.refresh();
		}).open();
	}

	private openBlockMenu(
		evt: MouseEvent,
		file: TFile,
		section: Section,
		blockIndex: number,
		blockText: string,
		blockEl: HTMLElement,
		/** Day Planner: its own items lead the menu, and its line cards toggle tasks themselves. */
		planner?: { prepend: (menu: Menu) => void; toggle: (box: HTMLInputElement) => void },
	): void {
		const at = this.cardEntries.findIndex((entry) => entry.holder.section.headingRaw === section.headingRaw);
		const prev = at > 0 ? this.cardEntries[at - 1].holder.section : null;
		const next = at >= 0 && at < this.cardEntries.length - 1 ? this.cardEntries[at + 1].holder.section : null;

		const label = (target: Section) => {
			const title = target.title || "(untitled)";
			return title.length > 28 ? `${title.slice(0, 27)}…` : title;
		};

		const menu = new Menu();
		planner?.prepend(menu);
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
		if (this.addFeedItem(menu, section, "Update this day from calendar feed")) menu.addSeparator();

		menu.addItem((item) =>
			item
				.setTitle("Edit line…")
				.setIcon("pencil-line")
				.onClick(() => this.openEditBlockModal(file, section, blockIndex, blockText)),
		);

		// Only the block's own checkbox counts — a plain item with task children isn't a task.
		const isTask = TASK_RE.test(blockText.split("\n")[0]);
		const box = isTask ? blockEl.querySelector<HTMLInputElement>("input[type=checkbox]") : null;
		const cardEl = blockEl.closest<HTMLElement>(".section-card");
		const bodyEl = blockEl.closest<HTMLElement>(".section-card-body");
		if (box && (planner || (cardEl && bodyEl))) {
			menu.addItem((item) =>
				item
					.setTitle(box.checked ? "Mark undone" : "Mark done")
					.setIcon(box.checked ? "undo-2" : "check")
					.onClick(() => {
						if (planner) planner.toggle(box);
						else if (cardEl && bodyEl) void this.toggleTask(cardEl, file, section, bodyEl, box);
					}),
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
						new Notice("Couldn't find that line — the file changed on disk.");
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
						new Notice("Couldn't find that line — the file changed on disk.");
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
						new Notice("Couldn't find that line — the file changed on disk.");
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
						new Notice("Couldn't find that line — the file changed on disk.");
					}
					await this.refresh();
				}),
		);

		this.addCommonMenuItems(menu);
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
				? await quickAddToSection(this.app, file, this.headingLevel, section, line, "bottom", this.flipMarker())
				: await insertAfterBlockInFile(this.app, file, this.headingLevel, section, blockIndex, blockText, line);
		if (!ok) {
			new Notice("Couldn't find that section — the file changed on disk.");
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
			new Notice("Couldn't find that line — the file changed on disk.");
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
		// "End of the card" on a two-faced card means the end of its front, not after
		// the back: anchor after the front's last movable block instead.
		if (anchorIndex === null) {
			const faces = this.cardFaces(target.body);
			if (faces.back !== null) {
				const frontBlocks = movableBlocks(faces.front.split("\n"));
				if (frontBlocks.length) {
					anchorIndex = frontBlocks.length - 1;
					anchorSide = "after";
				} else {
					anchorIndex = "start";
				}
			}
		}
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
			new Notice("Couldn't move that block — the file changed on disk.");
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
			new Notice("Couldn't move that card — the file changed on disk.");
		}
		await this.refresh();
	}

	private async completeDrag(file: TFile, moved: Section, target: Section, before: boolean): Promise<void> {
		const ok = await moveSectionInFile(this.app, file, this.headingLevel, moved, target, before);
		if (!ok) {
			new Notice("Couldn't reorder — the file changed on disk.");
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
		await this.toggleNthTask(file, section, nth, box, card);
	}

	/** Toggle a section's nth task line in the file and reflect it on its checkbox at
	 * once (the vault-modify refresh reconciles shortly after); `flash` gets the
	 * is-toggling pulse. Shared by the cards and the Day Planner's line cards. */
	private async toggleNthTask(
		file: TFile,
		section: Section,
		nth: number,
		box: HTMLInputElement,
		flash: HTMLElement,
	): Promise<void> {
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
			new Notice("Couldn't find that task in the file — reloading.");
			await this.refresh();
			return;
		}

		box.checked = checked;
		const item = box.closest<HTMLElement>("li");
		if (item) {
			item.toggleClass("is-checked", checked);
			item.setAttribute("data-task", checked ? "x" : " ");
		}
		flash.addClass("is-toggling");
		window.setTimeout(() => flash.removeClass("is-toggling"), 400);
	}

	/** Ctrl/⌘+T in a card editor: the Tasks plugin's create dialog; its line lands at the cursor. */
	private async insertTaskLine(insert: (line: string) => void, refocus: () => void): Promise<void> {
		const api = this.plugin.tasksApi();
		if (!api) {
			new Notice("Ctrl/⌘+T needs the Tasks plugin, which isn't enabled.");
			return;
		}
		let line = "";
		try {
			line = (await api.createTaskLineModal())?.trim() ?? "";
		} catch {
			new Notice("The Tasks plugin couldn't open its create dialog.");
			return;
		}
		if (line) insert(line);
		refocus();
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

		// The editor holds the body only — the heading stays in the title bar above it, as
		// it does when the card is rendered (the unfiled and properties cards have no
		// heading, so their whole text is the body). Padded with a newline so typing
		// starts on a fresh line under the existing content; trimmed back off on save.
		const seed = section.unfiled ? section.raw : section.body;
		const initial = seed.trim() ? seed + "\n" : "";
		/** The editor's text as the section's raw text: heading line back on top. */
		const toRaw = (value: string): string => {
			if (section.unfiled) return trimTrailingBlankLines(value);
			const body = trimTrailingBlankLines(value);
			return body ? `${section.headingRaw}\n${body}` : section.headingRaw;
		};
		const originalRaw = trimTrailingBlankLines(section.raw);

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
			if (this.maximized?.card === card) this.pendingMaximizeHeading = section.headingRaw;
			const edited = toRaw(value);
			if (save && edited !== originalRaw) {
				const written = await writeSection(this.app, file, this.headingLevel, section, edited);
				if (written) new Notice(`Saved “${section.title}” to ${file.basename}`);
			}
			this.editingKey = null;
			await this.refresh();
		};
		// Escape: an untouched editor just closes; one with unsaved typing asks first,
		// since Escape is too easy to hit to silently throw the work away. The footer's
		// Cancel button stays an explicit discard.
		const cancel = () => {
			if (settled) return;
			if (toRaw(readValue()) === originalRaw) {
				void finish(false);
				return;
			}
			new UnsavedChangesModal(this.app, section.title || "(untitled)", (choice) => {
				if (settled) return; // a refresh already committed it (save-on-leave)
				if (choice === "save") void finish(true);
				else if (choice === "discard") void finish(false);
				else refocus();
			}).open();
		};
		let refocus: () => void = () => {};
		// Ctrl/⌘+T: in the live-preview editor, Tasks' own "Create or edit task" command —
		// it reads the cursor line of the active editor (ours, while focused), so it edits
		// the task under the cursor in place, or creates one on a blank line. The plain
		// textarea has no editor for it to act on, so there the create dialog's line is
		// dropped in at the cursor instead.
		const editorApi: { insertLine?: (line: string) => void } = {};
		const insertTask = () => {
			if (embedded) {
				refocus();
				try {
					const commands = (this.app as unknown as { commands: { executeCommandById: (id: string) => boolean } }).commands;
					if (commands.executeCommandById("obsidian-tasks-plugin:edit-task")) return;
				} catch {
					// fall through to the dialog-and-insert path
				}
			}
			void this.insertTaskLine((line) => editorApi.insertLine?.(line), () => refocus());
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
				onCancel: cancel,
				onChange: () => remeasure(),
				onTask: insertTask,
			});
			if (embedded) {
				readValue = () => (embedded as EmbeddedEditor).value;
				refocus = () => (embedded as EmbeddedEditor).focus();
				editorApi.insertLine = (line) => (embedded as EmbeddedEditor).insertLine(line);
				// Clicks inside the editor stay there — same contract as the textarea.
				host.addEventListener("click", (e) => e.stopPropagation());
			} else {
				host.remove(); // internal editor unavailable: fall back to the textarea
			}
		}

		if (!embedded) {
			const textarea = this.buildPlainEditor(bodyEl, initial, finish, cancel, insertTask, editorApi);
			readValue = () => textarea.value;
			refocus = () => textarea.focus();
		}

		// Autosave: periodically write the editor's content to the note without closing
		// the editor, so a card left in edit mode can't lose more than one interval of
		// work. Refreshes are already suppressed while editing, so the write is invisible
		// to this view until the editor settles.
		const autosave = async () => {
			if (settled) return;
			const edited = toRaw(readValue());
			if (edited === trimTrailingBlankLines(section.raw)) return;
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
		footer.createSpan({
			cls: "section-card-hint",
			text: this.plugin.tasksApi() ? "Ctrl/⌘+Enter to save · Esc to cancel · Ctrl/⌘+T task" : "Ctrl/⌘+Enter to save · Esc to cancel",
		});
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

		this.activeEditor = { card, finish, autosave, insertTask };
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
		cancel: () => void,
		onTask?: () => void,
		api?: { insertLine?: (line: string) => void },
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
				cancel();
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
			} else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "t" && onTask) {
				e.preventDefault();
				onTask();
			}
		});
		// A line dropped in at the cursor (Ctrl/⌘+T's task): onto a blank line, else below
		// the current one. Recorded so it's undoable like typing.
		if (api) {
			api.insertLine = (text: string) => {
				const v = textarea.value;
				const pos = textarea.selectionEnd;
				const lineStart = v.lastIndexOf("\n", pos - 1) + 1;
				let lineEnd = v.indexOf("\n", pos);
				if (lineEnd < 0) lineEnd = v.length;
				if (v.slice(lineStart, lineEnd).trim() === "") textarea.setRangeText(text, lineStart, lineEnd, "end");
				else textarea.setRangeText("\n" + text, lineEnd, lineEnd, "end");
				history.record(snapshot());
			};
		}

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
