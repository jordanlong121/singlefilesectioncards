import { addIcon, MarkdownView, Notice, Platform, Plugin, WorkspaceLeaf, TFile, TFolder, debounce, normalizePath, requestUrl } from "obsidian";
import {
	VIEW_TYPE_SECTION_CARDS,
	DECK_ICON,
	DECK_SVG,
	FLIP_ICON,
	FLIP_SVG,
	ROLODEX_ICON,
	ROLODEX_SVG,
	Layout,
	LAYOUT_OPTIONS,
	SectionCardsSettings,
	PerFileView,
	ViewSettings,
	CARD_COLORS,
	PaletteColor,
	hexToTriplet,
	contrastForeground,
	contrastForegroundLight,
	normalizePalette,
	DEFAULT_SETTINGS,
	BackgroundStore,
	DECK_BACKGROUND_KEY,
} from "./src/settings";
import { mo, parseSections, applyTemplatePlaceholders } from "./src/sections";
import { isTodayTitle, dateHeadingCounts, bestDateLevel } from "./src/dates";
import { TasksApiV1 } from "./src/tasks";
import { noteFolderOf, insertSection } from "./src/writes";
import { PlannerSlot } from "./src/planner";
import { DocumentLevels } from "./src/periods";
import { CardRect, SavedCanvasLayout, snapshotCanvasLayout, applyCanvasLayout } from "./src/canvas";
import { BACKGROUND_DIM_DEFAULT } from "./src/background";
import { TextInputModal, NoteLibraryModal } from "./src/modals";
import { SectionCardsSettingTab } from "./src/settings-tab";
import { StructuredNoteModal, StructuredSpec, specFormat, structuredNoteContent, structuredPlacements, structuredNotePath } from "./src/structured";
import { SectionCardsView } from "./src/view";

export * from "./src/settings";
export * from "./src/sections";
export * from "./src/grouping";
export * from "./src/dates";
export * from "./src/blocks";
export * from "./src/tasks";
export * from "./src/writes";
export * from "./src/planner";
export * from "./src/periods";
export * from "./src/canvas";
export * from "./src/icalfeed";
export * from "./src/editing";
export * from "./src/background";
export * from "./src/modals";
export * from "./src/settings-tab";
export * from "./src/structured";
export * from "./src/view";

export default class SectionCardsPlugin extends Plugin {
	settings: SectionCardsSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		addIcon(DECK_ICON, DECK_SVG);
		addIcon(FLIP_ICON, FLIP_SVG);
		addIcon(ROLODEX_ICON, ROLODEX_SVG);

		this.registerView(VIEW_TYPE_SECTION_CARDS, (leaf) => new SectionCardsView(leaf, this));

		this.addRibbonIcon(DECK_ICON, "Open section cards in a new tab", () => {
			// Every click opens its own tab, even when one already shows the note.
			void this.openCardsView(undefined, undefined, "new");
		});

		this.addRibbonIcon("calendar-check", "Open default card", () => void this.openTodaySection());

		this.addCommand({
			id: "open-section-cards",
			name: "Open section cards (default note)",
			callback: () => this.openCardsView(),
		});

		this.addCommand({
			id: "open-today-section",
			name: "Open today's section",
			callback: () => this.openTodaySection(),
		});

		this.addCommand({
			id: "open-section-cards-new-tab",
			name: "Open section cards in a new tab",
			callback: () => this.openCardsView(undefined, undefined, "new"),
		});

		this.addCommand({
			id: "manage-notes",
			name: "Manage notes",
			callback: () => new NoteLibraryModal(this, (path) => void this.openCardsView(path)).open(),
		});

		this.addCommand({
			id: "new-structured-note",
			name: "New note",
			callback: () => this.promptStructuredNote(),
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

		// Calendar feeds: update today's card in the cards view in front, from its note's feed.
		this.addCommand({
			id: "update-today-from-feed",
			name: "Update today's card from the calendar feed",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(SectionCardsView);
				if (!view || view.deckMode || !this.getCalendarFeed(view.filePath)) return false;
				if (!checking) void view.updateTodayFromFeed();
				return true;
			},
		});
		this.addCommand({
			id: "update-all-days-from-feed",
			name: "Update every day in this note from the calendar feed",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(SectionCardsView);
				if (!view || view.deckMode || !this.getCalendarFeed(view.filePath)) return false;
				if (!checking) void view.updateAllDaysFromFeed();
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

		// Right-clicking a note in the file explorer (or a tab header, or a link)
		// offers to open it as cards.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				menu.addItem((item) =>
					item
						.setTitle("Open as cards")
						.setIcon(DECK_ICON)
						.setSection("open")
						.onClick(() => void this.openCardsView(file.path)),
				);
			}),
		);

		// Keep a note's remembered view attached to it when it is renamed or moved —
		// and Images-canvas placements attached to a renamed image, on every note.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				let changed = false;
				for (const entry of Object.values(this.settings.perFile ?? {})) {
					const rect = entry.imagesGrid?.[oldPath];
					if (rect && entry.imagesGrid) {
						entry.imagesGrid[file.path] = rect;
						delete entry.imagesGrid[oldPath];
						changed = true;
					}
				}
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)) {
					if (leaf.view instanceof SectionCardsView) leaf.view.renameImageKey(oldPath, file.path);
				}
				for (const list of [this.settings.recentFiles, this.settings.pinnedRecentFiles]) {
					const at = list.indexOf(oldPath);
					if (at >= 0) {
						list[at] = file.path;
						changed = true;
					}
				}
				const saved = this.settings.perFile?.[oldPath];
				if (saved) {
					delete this.settings.perFile[oldPath];
					this.settings.perFile[file.path] = saved;
					changed = true;
					for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)) {
						const view = leaf.view;
						if (view instanceof SectionCardsView && view.filePath === oldPath) view.filePath = file.path;
					}
				}
				if (changed) void this.saveSettings();
			}),
		);

		// With the setting on, a note that has a remembered cards view opens as cards:
		// the markdown leaf that just opened it is swapped to this plugin's view. The
		// swap is deferred a tick — replacing the view from inside file-open re-enters
		// the workspace mid-open. revealSection sets skipAutoOpen so the link button's
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

		// The "Open as cards" button on notes: added to every markdown view now and as
		// tabs come and go; removed again when the setting turns off.
		this.app.workspace.onLayoutReady(() => this.syncNoteActions());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.syncNoteActions()));

		this.addSettingTab(new SectionCardsSettingTab(this.app, this));
		this.applyBodyClasses();
		this.applyPaletteCss();
		this.applyFontScale();
		this.armMidnightRefresh();
	}

	/** The note-header buttons this plugin added, per markdown view, so they can be removed. */
	private noteActions = new WeakMap<MarkdownView, HTMLElement>();

	/** Add the "Open as cards" action to every open note (setting on), or take it away (off). */
	syncNoteActions(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			const existing = this.noteActions.get(view);
			if (!this.settings.noteCardsButton) {
				existing?.remove();
				this.noteActions.delete(view);
				continue;
			}
			if (existing?.isConnected) continue;
			const el = view.addAction(DECK_ICON, "Open as cards", () => {
				const file = view.file;
				if (!file) return;
				// Same tab: the note's leaf becomes the cards view of that note.
				void view.leaf.setViewState({ type: VIEW_TYPE_SECTION_CARDS, active: true, state: { filePath: file.path } });
			});
			this.noteActions.set(view, el);
		}
	}

	/** Pending midnight-rollover timeout, cleared on unload. */
	private midnightTimer: number | null = null;

	/**
	 * Obsidian left open overnight goes stale at midnight: the today-card highlight,
	 * the Calendar's today square, the Heatmap's streaks, and the Deck's dates all
	 * still say yesterday. Refresh every open cards view just after the day rolls
	 * over, then re-arm. The deadline is recomputed each time — a fixed 24-hour
	 * interval drifts, and a laptop asleep at midnight fires this on wake, when the
	 * recompute sets the next true midnight.
	 */
	private armMidnightRefresh(): void {
		const now = new Date();
		// Five seconds past midnight, clear of clock-edge jitter.
		const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
		this.midnightTimer = window.setTimeout(() => {
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)) {
				const view = leaf.view;
				// A card mid-edit or blown up big keeps its state; it re-dates on its
				// own next refresh, same as the file-change refreshes behave.
				if (view instanceof SectionCardsView && !view.isEditing() && !view.isMaximized()) {
					void view.refresh();
				}
			}
			this.armMidnightRefresh();
		}, next.getTime() - now.getTime());
	}

	onunload(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView) this.noteActions.get(leaf.view)?.remove();
		}
		if (this.midnightTimer !== null) {
			window.clearTimeout(this.midnightTimer);
			this.midnightTimer = null;
		}
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
			// Solid-color title bars flip their text black or white to stay readable —
			// computed per theme (dark themes bias to white, light themes to dark); the
			// CSS picks whichever matches the active theme.
			document.body.setCssProps({
				[`--sfsc-color-${name}`]: triplet,
				[`--sfsc-color-${name}-fg`]: contrastForeground(hex),
				[`--sfsc-color-${name}-fg-light`]: contrastForegroundLight(hex),
			});
		});
	}

	/** Card and divider text sizes multiply by these body-level variables, so the
	 * sliders resize every open view — cards, editors, divider bars — without a refresh. */
	applyFontScale(): void {
		const toScale = (percent: number) => (Number.isFinite(percent) && percent > 0 ? percent / 100 : 1);
		document.body.setCssProps({
			"--sfsc-font-scale": String(toScale(this.settings.fontScale)),
			"--sfsc-divider-font-scale": String(toScale(this.settings.dividerFontScale)),
		});
	}

	/**
	 * "reuse" reveals an existing cards tab already showing the note; "new" always opens
	 * another tab, so any number of cards tabs — including several of the same note — can
	 * be open at once. (Obsidian's native "Duplicate tab" also works on cards tabs.)
	 */
	/** The New note wizard (blank, a built-in structure, a preset, or a copy); the note opens as cards. */
	promptStructuredNote(): void {
		new StructuredNoteModal(this, (name, spec) => void this.createStructuredNote(name, spec)).open();
	}

	/**
	 * Write a note from the wizard's choices and open it as cards. A built-in format: its
	 * layout and the chosen level remembered for the note, Dates off, and — for a matrix —
	 * the sections placed as quadrants on the Custom Grid. A vault note as the template:
	 * its body copied, placeholders filled, and its remembered view (layout, level,
	 * placements, colors, pins) copied along.
	 */
	async createStructuredNote(name: string, spec: StructuredSpec): Promise<void> {
		const path = structuredNotePath(this.app, this.settings.filePath, name);
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice(`“${path}” already exists.`);
			return;
		}
		if (spec.format === "note" && !(spec.templatePath && this.app.vault.getAbstractFileByPath(spec.templatePath) instanceof TFile)) {
			new Notice("The note whose headings to use wasn't found.");
			return;
		}
		const noteName = path.split("/").pop()?.replace(/\.md$/, "") ?? name;
		// Never a new folder: a name with a folder/ must name one that exists.
		const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (folder && !(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
			new Notice(`There's no folder “${folder}” — create it first, or leave the folder out of the name.`);
			return;
		}
		let file: TFile;
		try {
			file = await this.app.vault.create(path, structuredNoteContent(spec, noteName, this.getNewCardFormat(path)));
		} catch (err) {
			new Notice(`Couldn't create “${path}”: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (spec.format === "note" && spec.templatePath) {
			// The new note starts with the source note's remembered view (placements are keyed
			// by heading, so they fit); the level follows its headings.
			await this.copyNoteState(spec.templatePath, file.path);
			if (spec.savedLayout) await this.applySavedLayout(file.path, spec.savedLayout);
			const stored = this.getStoredView(spec.templatePath);
			await this.storeView(file.path, {
				layout: spec.layout ?? stored?.layout ?? this.settings.layout,
				headingLevel: spec.level,
				sortOrder: stored?.sortOrder ?? "doc",
				hierarchy: stored?.hierarchy ?? false,
				sections: stored?.sections ?? false,
				starredOnly: false,
				taskFilter: stored?.taskFilter ?? "all",
				groupBy: stored?.groupBy ?? "none",
			});
			await this.openCardsView(file.path, undefined, "new");
			return;
		}
		const def = specFormat(spec);
		// A preset note that was arranged itself lends the copy its remembered view first
		// (placements for headings kept as they were); the layout and level below win.
		if (def?.path) {
			await this.copyNoteState(def.path, file.path);
			if (spec.savedLayout) await this.applySavedLayout(file.path, spec.savedLayout);
		}
		const view: ViewSettings = {
			layout: spec.layout ?? def?.layout ?? this.settings.layout,
			headingLevel: spec.level,
			sortOrder: "doc",
			hierarchy: false,
			sections: false,
			starredOnly: false,
			taskFilter: "all",
			groupBy: "none",
		};
		await this.storeView(file.path, view);
		await this.setContainsDates(file.path, false, view);
		// A chosen saved layout already placed everything; the matrix layout is the default.
		const placements = spec.savedLayout ? null : structuredPlacements(spec);
		if (placements) await this.saveCustomGrid(file.path, placements, view, 1);
		await this.openCardsView(file.path, undefined, "new");
	}

	/**
	 * Stickies: one card on its own in a popout window, so it stays at hand while other
	 * notes are worked on. The view carries the card's heading in its state, so the
	 * workspace restores it. An open sticky on the same card is revealed rather than
	 * doubled. Desktop only — mobile has no windows to pop out.
	 */
	async openSticky(path: string, headingRaw: string): Promise<void> {
		const open = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)
			.find((leaf) => (leaf.view as SectionCardsView).filePath === path && (leaf.view as SectionCardsView).sticky === headingRaw);
		if (open) {
			await this.app.workspace.revealLeaf(open);
			return;
		}
		if (Platform.isMobile) {
			new Notice("Stickies open in their own window, which needs the desktop app.");
			return;
		}
		const leaf = this.app.workspace.openPopoutLeaf({ size: { width: 440, height: 600 } });
		await leaf.setViewState({
			type: VIEW_TYPE_SECTION_CARDS,
			active: true,
			state: {
				filePath: path,
				headingLevel: /^#+/.exec(headingRaw)?.[0].length ?? this.settings.headingLevel,
				sortOrder: "doc",
				layout: "rolodex",
				sticky: headingRaw,
			},
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	async openCardsView(filePath?: string, revealHeading?: string, mode: "reuse" | "new" = "reuse"): Promise<void> {
		const path = filePath ?? this.settings.filePath;

		if (mode === "reuse") {
			// A sticky on this note isn't the note's cards view; look past it.
			const existing = this.app.workspace
				.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)
				.find((leaf) => (leaf.view as SectionCardsView).filePath === path && !(leaf.view as SectionCardsView).sticky);

			if (existing) {
				await this.app.workspace.revealLeaf(existing);
				const view = existing.view as SectionCardsView;
				await view.refresh();
				if (revealHeading) await view.revealCard(revealHeading);
				return;
			}
		}

		const leaf = this.mainWindowTab();
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
		if (revealHeading) await (leaf.view as SectionCardsView).revealCard(revealHeading);
	}

	/**
	 * The single-file counterpart of the core Daily notes plugin's "Open today's daily
	 * note": the default note as cards, with today's card created first if the note
	 * doesn't have one — heading in the note's new-card format at the default placement,
	 * body from the template — and then brought into view.
	 */
	async openTodaySection(): Promise<void> {
		const path = normalizePath(this.settings.filePath ?? "");
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		if (!(file instanceof TFile)) {
			new Notice(`can't find "${path || "(no default note)"}" — set the default note in settings.`);
			return;
		}
		const content = await this.app.vault.cachedRead(file);
		const lines = content.split(/\r?\n/);
		const stored = this.getStoredView(file.path);
		let level = stored?.headingLevel ?? this.settings.headingLevel;
		// The view may be parked on a level with no date headings (H2 in a note of H1
		// months and H3 days): today's card belongs at the level that holds the dates,
		// and the view follows it there.
		const counts = dateHeadingCounts(lines, this.getNewCardFormat(file.path), this.settings.dateDetectFormat);
		const dateLevel = bestDateLevel(counts);
		if (dateLevel !== null && counts[level] === 0) {
			level = dateLevel;
			if (stored && stored.headingLevel !== level) {
				stored.headingLevel = level;
				await this.saveSettings();
			}
		}
		// Through the typed `mo` wrapper: obsidian's `moment` export types as `any`
		// wherever moment's own types aren't installed, and the linter flags every use.
		const now = mo();
		const title = now.format(this.getNewCardFormat(file.path));
		const headingRaw = `${"#".repeat(level)} ${title}`;

		// "Exists" the way the view decides which card is today's, so a heading written
		// in another spelling of today's date isn't shadowed by a second one.
		const iso = now.format("YYYY-MM-DD");
		const sections = parseSections(lines, level);
		const today = sections.find((section) => isTodayTitle(section.title, iso, title));
		if (!today) {
			// Only a note that deals in dates gets a dated card added: the toolbar's Dates
			// toggle rules when the user has set it, else the note's own headings decide.
			// A note with no cards at this level yet is a fresh daily note — create.
			const format = this.getNewCardFormat(file.path);
			const dated =
				this.getContainsDates(file.path) ??
				(sections.length === 0 || dateHeadingCounts(lines, format, this.settings.dateDetectFormat)[level] > 0);
			if (!dated) {
				// An undated note gets its named default card instead, when one is set.
				const fallback = this.settings.undatedSection.trim();
				if (!fallback) {
					new Notice(
						`${file.basename} has no dated sections — set "Default card for undated notes" in settings to open a card here, or turn on Dates in the toolbar.`,
					);
					await this.openCardsView(file.path);
					return;
				}
				const wanted = fallback.toLowerCase();
				const existing = sections.find((section) => section.title.trim().toLowerCase() === wanted);
				const fallbackHeading = `${"#".repeat(level)} ${fallback}`;
				if (!existing) {
					const body = await this.loadTemplateBody(file.path, fallback);
					await insertSection(this.app, file, fallbackHeading, this.settings.newCardPlacement, body ?? undefined);
				}
				await this.openCardsView(file.path, existing?.headingRaw ?? fallbackHeading);
				return;
			}
			const body = await this.loadTemplateBody(file.path, title);
			await insertSection(this.app, file, headingRaw, this.settings.newCardPlacement, body ?? undefined);
		}
		await this.openCardsView(file.path, today?.headingRaw ?? headingRaw);
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

	/** The properties card's title, or null when the feature is off. */
	propertiesTitle(): string | null {
		return this.settings.propertiesEnabled ? this.settings.propertiesTitle || DEFAULT_SETTINGS.propertiesTitle : null;
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
			(current.starredOnly ?? false) === (view.starredOnly ?? false) &&
			(current.taskFilter ?? "all") === (view.taskFilter ?? "all")
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

	/** Pin or unpin several cards at once (one save, one refresh). */
	async setPinnedMany(path: string, keys: string[], pinned: boolean, base: ViewSettings): Promise<void> {
		if (!path || !keys.length) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		const list = current.pinned ?? [];
		const next = pinned ? [...list, ...keys.filter((k) => !list.includes(k))] : list.filter((k) => !keys.includes(k));
		current.pinned = next;
		this.settings.perFile[path] = current;
		await this.saveSettings();
		this.refreshAllViews();
	}

	/** Color (or clear, null) several cards at once. */
	async setCardColorMany(path: string, keys: string[], color: string | null, base: ViewSettings): Promise<void> {
		if (!path || !keys.length) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		const colors = current.colors ?? {};
		for (const key of keys) {
			if (color) colors[key] = color;
			else delete colors[key];
		}
		if (Object.keys(colors).length) current.colors = colors;
		else delete current.colors;
		this.settings.perFile[path] = current;
		await this.saveSettings();
		this.refreshAllViews();
	}

	/**
	 * A card's heading line was rewritten (Calendar day move): pins, colors, and Custom
	 * Grid placements are keyed by the heading line, so carry them to the new key.
	 */
	async renameCardKey(path: string, oldRaw: string, newRaw: string): Promise<void> {
		if (oldRaw === newRaw) return;
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)) {
			const view = leaf.view;
			if (view instanceof SectionCardsView && view.filePath === path) view.renameSticky(oldRaw, newRaw);
		}
		const entry = this.settings.perFile?.[path];
		if (!entry) return;
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
		const flippedAt = entry.flipped?.indexOf(oldRaw) ?? -1;
		if (entry.flipped && flippedAt >= 0) {
			entry.flipped[flippedAt] = newRaw;
			changed = true;
		}
		const collapsedAt = entry.collapsed?.indexOf(oldRaw) ?? -1;
		if (entry.collapsed && collapsedAt >= 0) {
			entry.collapsed[collapsedAt] = newRaw;
			changed = true;
		}
		if (entry.customGrid?.[oldRaw]) {
			entry.customGrid[newRaw] = entry.customGrid[oldRaw];
			delete entry.customGrid[oldRaw];
			changed = true;
		}
		if (entry.planner?.[oldRaw]) {
			entry.planner[newRaw] = entry.planner[oldRaw];
			delete entry.planner[oldRaw];
			changed = true;
		}
		if (changed) await this.saveSettings();
	}

	/** The per-note "headings are dates" choice; undefined = the user hasn't set it. */
	getContainsDates(path: string): boolean | undefined {
		return this.settings.perFile?.[path]?.containsDates;
	}

	// ---------- Custom Grid: saved layouts ----------

	getSavedLayouts(path: string): Record<string, SavedCanvasLayout> {
		return this.settings.perFile?.[path]?.savedLayouts ?? {};
	}

	getActiveSavedLayout(path: string): string | null {
		return this.settings.perFile?.[path]?.activeSavedLayout ?? null;
	}

	/** Save the note's current arrangement and background under a name (replacing a
	 * layout of that name), and make it the active one. */
	async saveCanvasLayout(path: string, name: string, base: ViewSettings): Promise<void> {
		if (!path || !name.trim()) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		current.savedLayouts = { ...(current.savedLayouts ?? {}), [name.trim()]: snapshotCanvasLayout(current) };
		current.activeSavedLayout = name.trim();
		this.settings.perFile[path] = current;
		await this.saveSettings();
	}

	/** Switch the note's canvas to a saved layout: placements, zoom, and background. Open
	 * views of the note reload their placements (they're cached per note). */
	async applySavedLayout(path: string, name: string): Promise<void> {
		const current = this.settings.perFile?.[path];
		const saved = current?.savedLayouts?.[name];
		if (!current || !saved) return;
		applyCanvasLayout(current, saved);
		current.activeSavedLayout = name;
		await this.saveSettings();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)) {
			const view = leaf.view;
			if (view instanceof SectionCardsView && view.filePath === path) view.reloadPlacements();
		}
	}

	/** Forget a saved layout; the canvas stays as it is. */
	async deleteSavedLayout(path: string, name: string): Promise<void> {
		const current = this.settings.perFile?.[path];
		if (!current?.savedLayouts?.[name]) return;
		delete current.savedLayouts[name];
		if (!Object.keys(current.savedLayouts).length) delete current.savedLayouts;
		if (current.activeSavedLayout === name) delete current.activeSavedLayout;
		await this.saveSettings();
	}

	/** Whether the canvases' tray is folded to a slim strip for this note. */
	getTrayCollapsed(path: string): boolean {
		return !!this.settings.perFile?.[path]?.trayCollapsed;
	}

	async setTrayCollapsed(path: string, collapsed: boolean, base: ViewSettings): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		if (collapsed) current.trayCollapsed = true;
		else delete current.trayCollapsed;
		this.settings.perFile[path] = current;
		await this.saveSettings();
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
	/**
	 * Where a background lives: a note's per-file entry, or — under DECK_BACKGROUND_KEY —
	 * the Deck's own store, so the Deck keeps a look of its own apart from any note. With
	 * `base` the note's entry is created if missing (a write); without, null when absent.
	 */
	private backgroundStore(path: string, base?: ViewSettings): BackgroundStore | null {
		if (path === DECK_BACKGROUND_KEY) return (this.settings.deckBackground ??= {});
		if (!path) return null;
		if (!base) return this.settings.perFile?.[path] ?? null;
		this.settings.perFile = this.settings.perFile ?? {};
		return (this.settings.perFile[path] ??= { ...base });
	}

	getBackgroundImage(path: string): string | null {
		return this.backgroundStore(path)?.backgroundImage ?? null;
	}

	async setBackgroundImage(path: string, imagePath: string | null, base: ViewSettings): Promise<void> {
		const current = this.backgroundStore(path, base);
		if (!current) return;
		if (imagePath) current.backgroundImage = imagePath;
		else delete current.backgroundImage;
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
		return this.backgroundStore(path)?.backgroundDim ?? null;
	}

	async setBackgroundDim(path: string, value: number, base: ViewSettings): Promise<void> {
		const current = this.backgroundStore(path, base);
		if (!current) return;
		if (value === BACKGROUND_DIM_DEFAULT) delete current.backgroundDim;
		else current.backgroundDim = value;
		await this.saveSettings();
		this.refreshAllViews();
	}

	/** Background image brightness and saturation, in percent (100 = untouched). */
	getBackgroundAdjust(path: string): { brightness: number; saturation: number } {
		const entry = this.backgroundStore(path);
		return { brightness: entry?.backgroundBrightness ?? 100, saturation: entry?.backgroundSaturation ?? 100 };
	}

	async setBackgroundAdjust(
		path: string,
		patch: { brightness?: number; saturation?: number },
		base: ViewSettings,
	): Promise<void> {
		const current = this.backgroundStore(path, base);
		if (!current) return;
		if (patch.brightness !== undefined) {
			if (patch.brightness === 100) delete current.backgroundBrightness;
			else current.backgroundBrightness = patch.brightness;
		}
		if (patch.saturation !== undefined) {
			if (patch.saturation === 100) delete current.backgroundSaturation;
			else current.backgroundSaturation = patch.saturation;
		}
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

	/** The cards of a note showing their back (Card Flip), by heading line. */
	getFlipped(path: string): string[] {
		return this.settings.perFile?.[path]?.flipped ?? [];
	}

	/** Remember (or forget) that a card shows its back. Keyed to the heading line like
	 * pins and colors; the view has already turned the card, so no refresh here. */
	async setCardFlipped(path: string, headingRaw: string, flipped: boolean, base: ViewSettings): Promise<void> {
		if (!path) return;
		const list = this.getFlipped(path);
		if (flipped === list.includes(headingRaw)) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		const next = flipped ? [...list, headingRaw] : list.filter((h) => h !== headingRaw);
		if (next.length) current.flipped = next;
		else delete current.flipped;
		this.settings.perFile[path] = current;
		await this.saveSettings();
	}

	/** Which dated cards a note hides relative to today. */
	/** The layouts this note has switched off (Cards view menu → Layouts shown in this note). */
	getHiddenLayouts(path: string): Layout[] {
		return this.settings.perFile?.[path]?.hiddenLayouts ?? [];
	}

	async setLayoutEnabled(path: string, layout: Layout, enabled: boolean, base: ViewSettings): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		const hidden = new Set(current.hiddenLayouts ?? []);
		if (enabled) hidden.delete(layout);
		else hidden.add(layout);
		if (hidden.size) current.hiddenLayouts = LAYOUT_OPTIONS.map(([value]) => value).filter((value) => hidden.has(value));
		else delete current.hiddenLayouts;
		this.settings.perFile[path] = current;
		await this.saveSettings();
	}

	/** The note's Document setup, or null when it has never been saved (detection applies). */
	getDocumentLevels(path: string): DocumentLevels | null {
		return this.settings.perFile?.[path]?.levels ?? null;
	}

	async setDocumentLevels(path: string, levels: DocumentLevels | null, base: ViewSettings): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		if (levels) current.levels = levels;
		else delete current.levels;
		this.settings.perFile[path] = current;
		await this.saveSettings();
		this.refreshAllViews();
	}

	getDateHide(path: string): { future: boolean; past: boolean } {
		const entry = this.settings.perFile?.[path];
		return { future: !!entry?.hideFutureDates, past: !!entry?.hidePastDates };
	}

	async setDateHide(
		path: string,
		patch: { future?: boolean; past?: boolean },
		base: ViewSettings,
		refresh = true,
	): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		if (patch.future !== undefined) {
			if (patch.future) current.hideFutureDates = true;
			else delete current.hideFutureDates;
		}
		if (patch.past !== undefined) {
			if (patch.past) current.hidePastDates = true;
			else delete current.hidePastDates;
		}
		this.settings.perFile[path] = current;
		await this.saveSettings();
		if (refresh) this.refreshAllViews();
		// The toolbar's two toggle buttons show the state; refresh alone doesn't rebuild them.
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)) {
			if (leaf.view instanceof SectionCardsView) leaf.view.rebuildToolbar();
		}
	}

	/** The cards of a note collapsed to their title bars, by heading line. */
	getCollapsed(path: string): string[] {
		return this.settings.perFile?.[path]?.collapsed ?? [];
	}

	/** Remember (or forget) that a card is collapsed. The view has already folded it. */
	async setCardCollapsed(path: string, headingRaw: string, collapsed: boolean, base: ViewSettings): Promise<void> {
		if (!path) return;
		const list = this.getCollapsed(path);
		if (collapsed === list.includes(headingRaw)) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		const next = collapsed ? [...list, headingRaw] : list.filter((h) => h !== headingRaw);
		if (next.length) current.collapsed = next;
		else delete current.collapsed;
		this.settings.perFile[path] = current;
		await this.saveSettings();
	}

	/** A note's calendar feed address (an iCal .ics URL), or null when it has none. */
	getCalendarFeed(path: string): string | null {
		return this.settings.perFile?.[path]?.calendarFeed ?? null;
	}

	/** Set or clear (null) a note's calendar feed address. */
	async setCalendarFeed(path: string, url: string | null, base: ViewSettings): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		if (url?.trim()) current.calendarFeed = url.trim();
		else delete current.calendarFeed;
		this.settings.perFile[path] = current;
		await this.saveSettings();
	}

	/** Notes whose today card was updated from their feed on opening, this session. */
	feedAutoUpdated = new Set<string>();

	/** Recently fetched feeds, so updating several days (or the same one twice) in a
	 * few minutes asks the calendar once. In memory only: nothing about a feed is saved. */
	private feedCache = new Map<string, { at: number; text: string }>();

	/** A calendar feed's text. webcal:// is fetched as https://. Throws a readable
	 * message when the address can't be reached or doesn't answer with a calendar. */
	async fetchFeed(url: string, fresh = false): Promise<string> {
		const address = url.trim().replace(/^webcal:\/\//i, "https://");
		const cached = this.feedCache.get(address);
		if (!fresh && cached && Date.now() - cached.at < 5 * 60_000) return cached.text;
		let text: string;
		try {
			const res = await requestUrl({ url: address, throw: false });
			if (res.status < 200 || res.status >= 300) throw new Error(`the calendar answered HTTP ${res.status}`);
			text = res.text;
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw new Error(reason.startsWith("the calendar") ? reason : `couldn't reach it (${reason})`);
		}
		if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("that address didn't return a calendar (.ics)");
		this.feedCache.set(address, { at: Date.now(), text });
		return text;
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

	/** The Day Planner's column and height per line, by card (heading line) then line key. */
	getPlanner(path: string): Record<string, Record<string, PlannerSlot>> {
		return this.settings.perFile?.[path]?.planner ?? {};
	}

	async savePlanner(path: string, planner: Record<string, Record<string, PlannerSlot>>, base: ViewSettings): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		if (Object.keys(planner).length) current.planner = planner;
		else delete current.planner;
		this.settings.perFile[path] = current;
		await this.saveSettings();
	}

	/** The Images canvas's placements and zoom, stored beside the Custom Grid's. */
	getImagesGrid(path: string): Record<string, CardRect> {
		return this.settings.perFile?.[path]?.imagesGrid ?? {};
	}

	getImagesZoom(path: string): number {
		return this.settings.perFile?.[path]?.imagesZoom ?? 1;
	}

	async saveImagesGrid(
		path: string,
		placements: Record<string, CardRect>,
		base: ViewSettings,
		zoom?: number,
	): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		current.imagesGrid = placements;
		if (zoom !== undefined) current.imagesZoom = zoom;
		this.settings.perFile[path] = current;
		await this.saveSettings();
	}

	/** The Links canvas's placements and zoom, stored beside the other canvases'. */
	getLinksGrid(path: string): Record<string, CardRect> {
		return this.settings.perFile?.[path]?.linksGrid ?? {};
	}

	getLinksZoom(path: string): number {
		return this.settings.perFile?.[path]?.linksZoom ?? 1;
	}

	async saveLinksGrid(
		path: string,
		placements: Record<string, CardRect>,
		base: ViewSettings,
		zoom?: number,
	): Promise<void> {
		if (!path) return;
		this.settings.perFile = this.settings.perFile ?? {};
		const current = this.settings.perFile[path] ?? { ...base };
		current.linksGrid = placements;
		if (zoom !== undefined) current.linksZoom = zoom;
		this.settings.perFile[path] = current;
		await this.saveSettings();
	}

	/** The Note Library's rows: every existing note the plugin remembers a cards view
	 * for — pinned notes first (in pin order), then by recency, then by name. */
	libraryEntries(query = ""): { path: string; name: string; layoutLabel: string; headingLevel: number; pinned: boolean }[] {
		const q = query.trim().toLowerCase();
		const labels = new Map<string, string>(LAYOUT_OPTIONS.map(([value, label]) => [value, label]));
		const pins = this.settings.pinnedRecentFiles;
		const recents = this.settings.recentFiles;
		const entries = Object.entries(this.settings.perFile ?? {})
			.filter(([path]) => this.app.vault.getFileByPath(path) !== null)
			.map(([path, view]) => ({
				path,
				name: path.replace(/\.md$/, "").split("/").pop() ?? path,
				layoutLabel: labels.get(view.layout) ?? view.layout,
				headingLevel: view.headingLevel,
				pinned: pins.includes(path),
			}))
			.filter((entry) => !q || entry.path.toLowerCase().includes(q));
		const rank = (path: string): [number, number, string] => {
			const pin = pins.indexOf(path);
			if (pin >= 0) return [0, pin, ""];
			const recent = recents.indexOf(path);
			if (recent >= 0) return [1, recent, ""];
			return [2, 0, path.toLowerCase()];
		};
		return entries.sort((a, b) => {
			const [ag, an, as] = rank(a.path);
			const [bg, bn, bs] = rank(b.path);
			return ag - bg || an - bn || as.localeCompare(bs);
		});
	}

	/** Drop everything the plugin remembers about a note — the file is untouched. */
	async forgetNote(path: string): Promise<void> {
		delete this.settings.perFile?.[path];
		for (const list of [this.settings.recentFiles, this.settings.pinnedRecentFiles]) {
			const at = list.indexOf(path);
			if (at >= 0) list.splice(at, 1);
		}
		await this.saveSettings();
	}

	/** Ask for a new name and rename the note in its folder (Manage notes, the Deck's
	 * tile menu). Through fileManager, not vault, so links to the note update; the
	 * vault's rename event then carries the remembered view and deck entry along.
	 * `done` runs after the attempt, renamed or not, to redraw the caller's list. */
	promptRenameNote(path: string, done?: () => void): void {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		new TextInputModal(this.app, "Rename note", file.basename, "Rename", (value) => {
			const name = value.trim();
			if (!name || name === file.basename) return;
			void (async () => {
				try {
					await this.app.fileManager.renameFile(file, normalizePath(`${noteFolderOf(file)}${name}.${file.extension}`));
				} catch {
					new Notice("Couldn't rename — is the name free?");
				}
				done?.();
			})();
		}).open();
	}

	/** A duplicated note starts with a copy of the original's remembered view —
	 * same headings, so the placements, colors, and pins all still apply. */
	async copyNoteState(from: string, to: string): Promise<void> {
		const entry = this.settings.perFile?.[from];
		if (!entry) return;
		this.settings.perFile[to] = JSON.parse(JSON.stringify(entry)) as PerFileView;
		await this.saveSettings();
	}

	/** The Deck's thumbnails. The working set is always pinned notes plus the most
	 * recently opened, capped at the setting's count; the Deck's sort then orders
	 * that set — recency (the default), file name, or the file's modified/created
	 * time, newest first. Deleted notes are skipped. */
	deckEntries(count = 5): { path: string; name: string; layoutLabel: string; mtime: number }[] {
		const labels = new Map<string, string>(LAYOUT_OPTIONS.map(([value, label]) => [value, label]));
		const exists = (path: string) => this.app.vault.getFileByPath(path) !== null;
		const pinned = this.settings.pinnedRecentFiles.filter(exists);
		const recents = this.settings.recentFiles.filter((path) => !pinned.includes(path) && exists(path));
		const entries = [...pinned, ...recents].slice(0, Math.max(1, count)).map((path) => ({
			path,
			name: path.replace(/\.md$/, "").split("/").pop() ?? path,
			layoutLabel: labels.get(this.settings.perFile?.[path]?.layout ?? "") ?? "",
			mtime: this.app.vault.getFileByPath(path)?.stat.mtime ?? 0,
		}));
		const sort = this.settings.deckSort;
		if (sort === "name-asc" || sort === "name-desc") {
			const dir = sort === "name-asc" ? 1 : -1;
			entries.sort((a, b) => dir * a.name.localeCompare(b.name, undefined, { numeric: true }));
		} else if (sort === "modified" || sort === "created") {
			const time = (path: string) => {
				const stat = this.app.vault.getFileByPath(path)?.stat;
				return (sort === "modified" ? stat?.mtime : stat?.ctime) ?? 0;
			};
			entries.sort((a, b) => time(b.path) - time(a.path));
		}
		return entries;
	}

	/** A note rendered in the cards view moves to the front of the quick-switch
	 * history. No-ops when it's already there, so refreshes don't write to disk. */
	recordRecentFile(path: string): void {
		const list = this.settings.recentFiles;
		if (!path || list[0] === path) return;
		const at = list.indexOf(path);
		if (at >= 0) list.splice(at, 1);
		list.unshift(path);
		if (list.length > 15) list.length = 15;
		void this.saveSettings();
	}

	isRecentPinned(path: string): boolean {
		return this.settings.pinnedRecentFiles.includes(path);
	}

	async toggleRecentPin(path: string): Promise<void> {
		const pins = this.settings.pinnedRecentFiles;
		const at = pins.indexOf(path);
		if (at >= 0) pins.splice(at, 1);
		else pins.push(path);
		await this.saveSettings();
	}

	/** The quick-switch section's rows: pinned notes first (in pin order), then the
	 * newest unpinned history, five rows in all. Deleted notes are skipped; the open
	 * note claims no history slot (its pinned row still shows, disabled). */
	recentFileEntries(currentPath: string): { path: string; name: string; pinned: boolean }[] {
		const exists = (path: string) => this.app.vault.getFileByPath(path) !== null;
		const pinned = this.settings.pinnedRecentFiles.filter(exists);
		const slots = Math.max(0, 5 - pinned.length);
		const recents = this.settings.recentFiles
			.filter((path) => path !== currentPath && !pinned.includes(path) && exists(path))
			.slice(0, slots);
		return [...pinned, ...recents].map((path) => ({
			path,
			name: path.replace(/\.md$/, "").split("/").pop() ?? path,
			pinned: this.settings.pinnedRecentFiles.includes(path),
		}));
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

	/** Refresh every view with card reuse switched off, so bodies re-render from scratch. */
	rebuildAllViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)) {
			if (leaf.view instanceof SectionCardsView) {
				leaf.view.invalidateCards();
				void leaf.view.refresh();
			}
		}
	}

	/** The one note whose next markdown open must NOT be swapped back to cards (the link
	 * button's deliberate editor trip); time-boxed so a stale flag can't linger. */
	private skipAutoOpen: { path: string; until: number } | null = null;

	/** Open the note in an editor with the cursor parked on the given heading line. */
	/**
	 * A new tab in the main window. getLeaf("tab") opens beside the active leaf — from a
	 * sticky that's the popout, and the note would open inside the sticky's window.
	 * Activating the main window's most recent leaf first (without focusing it) steers
	 * the new tab there; in the main window itself this changes nothing.
	 */
	private mainWindowTab(): WorkspaceLeaf {
		const ws = this.app.workspace;
		const recent = ws.getMostRecentLeaf(ws.rootSplit);
		if (recent) ws.setActiveLeaf(recent, { focus: false });
		return ws.getLeaf("tab");
	}

	async revealSection(file: TFile, line: number): Promise<void> {
		this.skipAutoOpen = { path: file.path, until: Date.now() + 2000 };
		const leaf = this.mainWindowTab();
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
