// The settings tab (declarative settings).

import {
	App,
	Notice,
	Platform,
		PluginSettingTab,
	apiVersion,
	Setting,
	type SettingDefinition,
	type SettingDefinitionItem,
	TFile,
	} from "obsidian";
import { GITHUB_REPO_URL, LAYOUT_OPTIONS, CARD_COLORS, PALETTE_PRESETS, DEFAULT_SETTINGS } from "./settings";
import type SectionCardsPlugin from "../main";

export class SectionCardsSettingTab extends PluginSettingTab {
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
				name: "Cards button on notes",
				desc: "A deck icon in the top-right of every note. Clicking it opens that note as cards in the same tab.",
				control: { type: "toggle", key: "noteCardsButton" },
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
					{
						name: "Show properties as a card",
						desc: "The note's properties (the frontmatter block) become the first card, shown as a table of names and values. Editing the card edits the raw properties text.",
						control: { type: "toggle", key: "propertiesEnabled" },
					},
					{
						name: "Properties card title",
						desc: "Title shown on that card. Display-only: it is never written into the note.",
						control: { type: "text", key: "propertiesTitle", placeholder: "Properties" },
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
						name: "Deck thumbnails",
						desc: "How many notes the Deck shows (the toolbar's deck button, or D): pinned notes first, then the ones opened most recently.",
						control: {
							type: "slider",
							key: "deckCount",
							min: 3,
							max: 12,
							step: 1,
							displayFormat: (value: number) => `${value} notes`,
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
				heading: "Card Flip",
				items: [
					{
						name: "Flip-over button",
						desc: "A card whose section holds the back-side marker line gets a flip button in its title bar's action strip (and right-click menu). Text below the marker is kept off the card's front and shown on its back — a study question's answer, a definition, notes or metadata about the card.",
						control: { type: "toggle", key: "flipEnabled" },
					},
					{
						name: "Back-side marker",
						desc: "The line that, alone on its own line, starts a card's back. The default is an Obsidian comment, so it's invisible in the note's reading view; a plain --- or <!-- back --> works too. Leave a blank line above it.",
						control: { type: "text", key: "flipMarker", placeholder: "%% flip %%" },
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
						name: "Card editor",
						control: {
							type: "dropdown",
							key: "editorMode",
							options: { live: "Live preview", source: "Source mode", plain: "Plain text box" },
						},
					},
					{
						name: "Save edits when leaving a card",
						desc: "An open card editor commits its changes whenever the wall re-renders out from under it — switching notes or layouts, opening the Deck, an outside change to the file — instead of discarding them. Escape on a card with unsaved typing asks whether to save or discard.",
						control: { type: "toggle", key: "saveOnLeave" },
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
						name: "Mark cards with due tasks",
						desc: "A card holding an open task due today gets an amber badge and edge; one with an overdue task, red. Reads Tasks-style 📅 dates and Dataview [due:: ] fields.",
						control: { type: "toggle", key: "dueTaskMarks" },
					},
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
					{
						name: "Default card for undated notes",
						desc: "When the default note doesn't use date headings, the ribbon's Open default card and the Open today's section command open the card with this title instead, creating it if the note doesn't have one. Leave empty to only open the note.",
						control: { type: "text", key: "undatedSection", placeholder: "Inbox" },
					},
				],
			},
			{
				type: "group",
				heading: "Calendar feeds",
				items: [
					{
						name: "Heading for a day's events",
						desc: "A note with a calendar feed (☰ → Calendar feed…) writes a day's events as lines under this heading in the day's card, one level below the card. Updating replaces only the feed's lines; anything you add under the heading stays.",
						control: { type: "text", key: "feedHeading", placeholder: "Calendar" },
					},
					{
						name: "Where the heading goes",
						desc: "Where a day's card gets the heading the first time its events are added: under the card's title, or at the end of the card. After that it stays wherever it is — move it by hand if you like. At the top, the rest of the card follows the events, which in Markdown terms puts it under the heading too (the Day Planner shows it inside the heading's card) unless it has a heading of its own.",
						control: {
							type: "dropdown",
							key: "feedPlacement",
							options: { bottom: "Bottom of the card", top: "Top of the card" },
						},
					},
					{
						name: "Write events as tasks",
						desc: "Each event becomes an open task instead of a plain bullet. A task you tick stays ticked when the day is updated.",
						control: { type: "toggle", key: "feedAsTasks" },
					},
					{
						name: "Update today's card when the note opens",
						desc: "Fetch the note's feed and update today's card the first time the note opens as cards in a session. Off: update from a card's or a line's right-click menu, the ☰ menu, or the command.",
						control: { type: "toggle", key: "feedAutoUpdate" },
					},
				],
			},
			{
				type: "group",
				heading: "Feedback",
				items: [
					{
						name: "Report a bug or suggest a feature",
						desc: "Opens a new GitHub issue in your browser with the plugin version, Obsidian version, platform, and theme already filled in. Nothing is sent until you submit the issue.",
						render: (setting: Setting) => this.renderFeedbackRow(setting),
					},
				],
			},
		];
	}

	/** Two links to GitHub's new-issue page, prefilled with the environment block a bug
	 * report needs anyway, plus a copy button for people who'd rather write the issue by
	 * hand. Opening the browser is the only network action; nothing is sent from here. */
	private renderFeedbackRow(setting: Setting): void {
		setting.settingEl.addClass("sfsc-feedback-row");
		setting.addButton((button) =>
			button
				.setButtonText("Report a bug")
				.setCta()
				.onClick(() => window.open(this.issueUrl("bug"))),
		);
		setting.addButton((button) =>
			button.setButtonText("Suggest a feature").onClick(() => window.open(this.issueUrl("enhancement"))),
		);
		setting.addExtraButton((button) =>
			button
				.setIcon("copy")
				.setTooltip("Copy environment details")
				.onClick(async () => {
					await navigator.clipboard.writeText(this.environmentBlock());
					new Notice("Environment details copied.");
				}),
		);
	}

	private issueUrl(label: "bug" | "enhancement"): string {
		const bug = label === "bug";
		const body = bug
			? [
					"### What happened",
					"",
					"",
					"### Steps to reproduce",
					"",
					"1. ",
					"",
					"### Expected",
					"",
					"",
					this.environmentBlock(),
				]
			: ["### What are you trying to do", "", "", "### What would help", "", "", this.environmentBlock()];
		const params = new URLSearchParams({
			title: bug ? "Bug: " : "Feature: ",
			labels: label,
			body: body.join("\n"),
		});
		return `${GITHUB_REPO_URL}/issues/new?${params.toString()}`;
	}

	/** The facts every report needs and nobody remembers to include. No vault paths,
	 * note names, or settings that could identify content. */
	private environmentBlock(): string {
		const os = Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : "unknown";
		const form = Platform.isPhone ? "phone" : Platform.isTablet ? "tablet" : "desktop";
		const theme = (this.app as App & { customCss?: { theme?: string } }).customCss?.theme || "default";
		const mode = document.body.hasClass("theme-dark") ? "dark" : "light";
		return [
			"### Environment",
			"",
			`- Plugin: ${this.plugin.manifest.version}`,
			`- Obsidian: ${apiVersion}`,
			`- Platform: ${os} (${form})`,
			`- Theme: ${theme} (${mode})`,
		].join("\n");
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
		if (key === "unfiledTitle" || key === "propertiesTitle") {
			const text = typeof value === "string" ? value.trim() : "";
			await super.setControlValue(key, text || DEFAULT_SETTINGS[key]);
			this.plugin.refreshAllViews();
			return;
		}
		if (key === "flipMarker") {
			const text = typeof value === "string" ? value.trim() : "";
			await super.setControlValue(key, text || DEFAULT_SETTINGS.flipMarker);
			this.plugin.rebuildAllViews();
			return;
		}
		if (key === "flipEnabled") {
			await super.setControlValue(key, value);
			this.plugin.rebuildAllViews();
			return;
		}
		await super.setControlValue(key, value);
		if (key === "noteCardsButton") this.plugin.syncNoteActions();
		if (key === "strikeNestedUnderDone") this.plugin.applyBodyClasses();
		if (key === "toolbarStyle") this.plugin.applyToolbarStyle();
		if (key === "fontScale" || key === "dividerFontScale") this.plugin.applyFontScale();
		if (
			key === "stickyPinned" ||
			key === "unfiledEnabled" ||
			key === "propertiesEnabled" ||
			key === "hierTaskCounts" ||
			key === "dynamicLevelOptions" ||
			key === "starEmoji" ||
			key === "weekStart" ||
			key === "dueTaskMarks" ||
			key === "dateDetectFormat"
		) {
			this.plugin.refreshAllViews();
		}
	}
}
