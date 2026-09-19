// The dialogs: confirmations, text input, note picker, new card, quick add, edit block, and more.

import {
	App,
	SuggestModal,
	Modal,
	Notice,
	Platform,
	Setting,
	setIcon,
	TFile,
		normalizePath,
	prepareFuzzySearch,
	type SearchResult,
} from "obsidian";
import { createEmbeddedEditor, type EmbeddedEditor } from "../editor-embed";
import { MOD_LABEL, Placement } from "./settings";
import { parseAncestorHeadings } from "./sections";
import { noteFolderOf, QuickAddPlacement } from "./writes";
import { LevelRole, LevelSetup, DocumentLevels, LEVEL_ROLE_LABELS, PERIOD_FORMATS, formatPeriod } from "./periods";
import type SectionCardsPlugin from "../main";

/** One row in the note picker: an existing note, or an offer to create the typed one. */
export interface FileSuggestion {
	path: string;
	create: boolean;
}

export class FileSuggestModal extends SuggestModal<FileSuggestion> {
	private readonly plugin: SectionCardsPlugin;
	private readonly onChoose: (path: string) => void;
	private readonly allowCreate: boolean;

	/**
	 * @param allowCreate  Offer to create a note when the typed title doesn't match one.
	 *   On for picking the note to show; off where a fresh empty note makes no sense
	 *   (choosing a template).
	 */
	constructor(app: App, plugin: SectionCardsPlugin, onChoose: (path: string) => void, allowCreate = false) {
		super(app);
		this.plugin = plugin;
		this.onChoose = onChoose;
		this.allowCreate = allowCreate;
		this.setPlaceholder(allowCreate ? "Recent note, search the vault, or type a new title…" : "Recent note, or search the vault…");
		this.emptyStateText = "No matching note in the vault.";
		this.limit = 100;
		if (allowCreate) {
			this.setInstructions([
				{ command: "↵", purpose: "open" },
				{ command: "shift ↵", purpose: "create the typed note" },
			]);
			// A "Create new note…" button at the end of that footer, for anyone who
			// doesn't discover the shortcut: creates whatever is typed, or asks for a title.
			const instructions = this.modalEl.querySelector(".prompt-instructions");
			if (instructions instanceof HTMLElement) {
				const btn = instructions.createEl("button", {
					cls: "section-cards-suggest-create-btn",
					text: "Create new note…",
				});
				btn.addEventListener("click", (evt) => {
					evt.preventDefault();
					this.close();
					this.createFromTitle(this.inputEl.value);
				});
			}
			// Shift+Enter creates whatever was typed, even while an existing note is highlighted.
			this.scope.register(["Shift"], "Enter", (evt) => {
				const path = this.createPathFor(this.inputEl.value);
				if (!path) return true;
				evt.preventDefault();
				this.close();
				void this.createAndChoose(path);
				return false;
			});
		}
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
	 * Where a note typed as `title` would be created, or null if the title is
	 * empty or already names a note. A title with a slash is taken as a vault
	 * path; a bare title lands in Obsidian's configured new-note folder.
	 */
	private createPathFor(title: string): string | null {
		if (!this.allowCreate) return null;
		const q = normalizePath(title.trim().replace(/\.md$/i, ""));
		if (!q || q === "/" || q === ".") return null;
		if (this.app.metadataCache.getFirstLinkpathDest(q, "")) return null;
		let path: string;
		if (q.includes("/")) {
			path = `${q}.md`;
		} else {
			const parent = this.app.fileManager.getNewFileParent(this.plugin.settings.filePath ?? "");
			path = normalizePath(`${parent.path}/${q}.md`);
		}
		if (this.app.vault.getAbstractFileByPath(path)) return null;
		return path;
	}

	/**
	 * The footer button's path: create the typed title straight away; with nothing
	 * typed, ask for one. A title that already names a note simply opens it.
	 */
	private createFromTitle(typed: string): void {
		const typedPath = this.createPathFor(typed);
		if (typedPath) {
			void this.createAndChoose(typedPath);
			return;
		}
		new TextInputModal(this.app, "New note", typed.trim(), "Create", (title) => {
			const path = this.createPathFor(title);
			if (path) {
				void this.createAndChoose(path);
				return;
			}
			const q = normalizePath(title.trim().replace(/\.md$/i, ""));
			const existing = q && q !== "/" && q !== "." ? this.app.metadataCache.getFirstLinkpathDest(q, "") : null;
			if (existing) this.onChoose(existing.path);
		}).open();
	}

	private async createAndChoose(path: string): Promise<void> {
		try {
			const folder = path.slice(0, path.lastIndexOf("/"));
			if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
				await this.app.vault.createFolder(folder);
			}
			const file = await this.app.vault.create(path, "");
			this.onChoose(file.path);
		} catch (err) {
			new Notice(`Couldn't create "${path}": ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * With no query, suggests only notes the plugin already knows about — the
	 * configured default, notes with a remembered cards view, recently opened
	 * notes. Once the user types, their query is resolved the way a wikilink
	 * would be, then fuzzy-matched against the vault's markdown files. When
	 * creating is allowed and the typed title isn't a note yet, a "create" row
	 * follows the matches — it's the only row (so Enter creates) when nothing matches.
	 *
	 * Vault enumeration happens only here, only while the user is actively
	 * searching this picker, and only to fuzzy-match the query they typed;
	 * the file list is discarded as soon as the suggestions are computed.
	 */
	getSuggestions(query: string): FileSuggestion[] {
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

		const existing = (path: string): FileSuggestion => ({ path, create: false });
		const needle = q.toLowerCase();
		if (!needle) return typed.concat(known).map(existing);

		const fuzzy = prepareFuzzySearch(q);
		const rest = this.app.vault
			.getMarkdownFiles()
			.map((file) => ({ path: file.path, match: seen.has(file.path) ? null : fuzzy(file.path) }))
			.filter((entry): entry is { path: string; match: SearchResult } => entry.match !== null)
			.sort((a, b) => b.match.score - a.match.score || a.path.localeCompare(b.path))
			.map((entry) => entry.path);

		const out = typed
			.concat(known.filter((path) => path.toLowerCase().includes(needle)))
			.concat(rest)
			.map(existing);
		const createPath = this.createPathFor(q);
		if (createPath) out.push({ path: createPath, create: true });
		return out;
	}

	renderSuggestion(item: FileSuggestion, el: HTMLElement): void {
		if (!item.create) {
			el.setText(item.path);
			return;
		}
		el.addClass("section-cards-suggest-create");
		el.createSpan({ text: "Create note " });
		el.createSpan({ cls: "section-cards-suggest-create-path", text: item.path });
	}

	onChooseSuggestion(item: FileSuggestion): void {
		if (item.create) {
			void this.createAndChoose(item.path);
			return;
		}
		this.onChoose(item.path);
	}
}

export class ConfirmDeleteModal extends Modal {
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

export class SwitchToDocumentOrderModal extends Modal {
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
export class MergeCardsModal extends Modal {
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

/** A one-line text prompt: Enter (or the CTA) submits, Escape cancels. */
export class TextInputModal extends Modal {
	private readonly title: string;
	private readonly initial: string;
	private readonly cta: string;
	private readonly onSubmit: (value: string) => void;
	/** Select the initial text (typing replaces it), or leave the caret after it. */
	private readonly selectInitial: boolean;

	constructor(app: App, title: string, initial: string, cta: string, onSubmit: (value: string) => void, selectInitial = true) {
		super(app);
		this.title = title;
		this.initial = initial;
		this.cta = cta;
		this.onSubmit = onSubmit;
		this.selectInitial = selectInitial;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });
		const input = contentEl.createEl("input", {
			cls: "sfsc-text-input",
			attr: { type: "text", spellcheck: "false" },
		});
		input.value = this.initial;
		const submit = () => {
			this.close();
			this.onSubmit(input.value);
		};
		input.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter") return;
			evt.preventDefault();
			submit();
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.cta).setCta().onClick(submit));
		input.focus();
		if (this.selectInitial) input.select();
		else input.setSelectionRange(input.value.length, input.value.length);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Escape on a card editor with unsaved typing: Save, Discard, or Keep editing.
 * Closing the modal any other way (its own Escape, clicking outside) keeps editing.
 */
export class UnsavedChangesModal extends Modal {
	private readonly cardTitle: string;
	private readonly onChoice: (choice: "save" | "discard" | "keep") => void;
	private decided = false;

	constructor(app: App, cardTitle: string, onChoice: (choice: "save" | "discard" | "keep") => void) {
		super(app);
		this.cardTitle = cardTitle;
		this.onChoice = onChoice;
	}

	private choose(choice: "save" | "discard" | "keep"): void {
		if (this.decided) return;
		this.decided = true;
		this.close();
		this.onChoice(choice);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Unsaved changes" });
		contentEl.createEl("p", { text: `Save your changes to “${this.cardTitle}”?` });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Keep editing").onClick(() => this.choose("keep")))
			.addButton((b) => b.setButtonText("Discard").setDestructive().onClick(() => this.choose("discard")))
			.addButton((b) => {
				// Enter saves, Esc (the modal's own handling) keeps editing.
				b.setButtonText("Save").setCta().onClick(() => this.choose("save"));
				b.buttonEl.focus();
			});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.decided) {
			this.decided = true;
			this.onChoice("keep");
		}
	}
}

/** A generic confirmation: heading, one paragraph, Cancel + one action button. */
export class ConfirmActionModal extends Modal {
	private readonly title: string;
	private readonly body: string;
	private readonly cta: string;
	private readonly destructive: boolean;
	private readonly onConfirm: () => void;

	constructor(app: App, title: string, body: string, cta: string, destructive: boolean, onConfirm: () => void) {
		super(app);
		this.title = title;
		this.body = body;
		this.cta = cta;
		this.destructive = destructive;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.body });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText(this.cta)
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					});
				if (this.destructive) b.setDestructive();
				b.buttonEl.focus();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * The Note Library: every note the plugin remembers a cards view for, searchable,
 * with basic note management — open, pin to the quick switch, rename, duplicate
 * (view settings included), forget the remembered view, or trash the note.
 */
export class NoteLibraryModal extends Modal {
	private readonly plugin: SectionCardsPlugin;
	private readonly openNote: (path: string) => void;
	private query = "";
	private listEl!: HTMLElement;

	constructor(plugin: SectionCardsPlugin, openNote: (path: string) => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.openNote = openNote;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("sfsc-library-modal");
		contentEl.createEl("h3", { text: "Manage notes" });
		contentEl.createEl("p", {
			cls: "sfsc-library-hint",
			text: "Every note with a remembered cards view. Click one to open it.",
		});
		const search = contentEl.createEl("input", {
			cls: "sfsc-library-search",
			attr: { type: "text", placeholder: "Filter notes…", spellcheck: "false" },
		});
		search.addEventListener("input", () => {
			this.query = search.value;
			this.renderList();
		});
		this.listEl = contentEl.createDiv({ cls: "sfsc-library-list" });
		this.renderList();
		if (!Platform.isMobile) search.focus();
	}

	private renderList(): void {
		this.listEl.empty();
		const entries = this.plugin.libraryEntries(this.query);
		if (!entries.length) {
			this.listEl.createDiv({
				cls: "sfsc-library-empty",
				text: this.query ? "No remembered notes match." : "No notes have a remembered cards view yet.",
			});
			return;
		}
		for (const entry of entries) {
			const row = this.listEl.createDiv({ cls: "sfsc-library-row" });
			row.toggleClass("is-pinned", entry.pinned);
			const main = row.createDiv({ cls: "sfsc-library-main" });
			main.createDiv({ cls: "sfsc-library-name", text: entry.name });
			if (entry.path !== `${entry.name}.md`) main.createDiv({ cls: "sfsc-library-path", text: entry.path });
			row.createDiv({ cls: "sfsc-library-badge", text: `H${entry.headingLevel} · ${entry.layoutLabel}` });

			const button = (icon: string, label: string, action: () => void) => {
				const btn = row.createEl("button", { cls: "sfsc-library-btn" });
				setIcon(btn, icon);
				btn.setAttr("aria-label", label);
				btn.addEventListener("click", (evt) => {
					evt.stopPropagation();
					action();
				});
				return btn;
			};
			button(
				entry.pinned ? "pin-off" : "pin",
				entry.pinned ? "Unpin from the quick switch" : "Pin to the quick switch",
				() => {
					void this.plugin.toggleRecentPin(entry.path).then(() => this.renderList());
				},
			).toggleClass("is-active", entry.pinned);
			button("pencil", "Rename note (links update)", () => this.renameNote(entry.path));
			button("copy-plus", "Duplicate note, view settings included", () => this.duplicateNote(entry.path));
			button("eraser", "Forget the remembered view (the note is untouched)", () => this.forgetNote(entry.path));
			button("trash-2", "Delete the note", () => this.deleteNote(entry.path));

			row.addEventListener("click", () => {
				this.close();
				this.openNote(entry.path);
			});
		}
	}

	/** The note's folder prefix, for building sibling paths in duplicate. */
	private folderOf(file: TFile): string {
		return noteFolderOf(file);
	}

	private renameNote(path: string): void {
		this.plugin.promptRenameNote(path, () => this.renderList());
	}

	private duplicateNote(path: string): void {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		new TextInputModal(this.app, "Duplicate note", `${file.basename} copy`, "Duplicate", (value) => {
			const name = value.trim();
			if (!name) return;
			void (async () => {
				const dest = normalizePath(`${this.folderOf(file)}${name}.md`);
				try {
					await this.app.vault.copy(file, dest);
					await this.plugin.copyNoteState(path, dest);
					new Notice(`Duplicated to “${dest}”.`);
				} catch {
					new Notice("Couldn't duplicate — is the name free?");
				}
				this.renderList();
			})();
		}).open();
	}

	private forgetNote(path: string): void {
		new ConfirmActionModal(
			this.app,
			"Forget this note's cards view?",
			`“${path}” keeps its file — only the plugin's remembered layout, placements, colors, and pins are dropped.`,
			"Forget",
			false,
			() => {
				void this.plugin.forgetNote(path).then(() => this.renderList());
			},
		).open();
	}

	private deleteNote(path: string): void {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		new ConfirmActionModal(
			this.app,
			"Delete note?",
			`“${path}” is moved to the trash, and the plugin forgets its cards view.`,
			"Delete",
			true,
			() => {
				void (async () => {
					await this.app.fileManager.trashFile(file);
					await this.plugin.forgetNote(path);
					this.renderList();
				})();
			},
		).open();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Images canvas: confirm removing a tile's link(s), optionally trashing the file. */
export class DeleteImageModal extends Modal {
	private readonly label: string;
	private readonly kind: "image" | "video";
	/** Whether the tile is a vault file that could also be trashed. */
	private readonly hasFile: boolean;
	private readonly onConfirm: (deleteFile: boolean) => void;

	constructor(app: App, label: string, kind: "image" | "video", hasFile: boolean, onConfirm: (deleteFile: boolean) => void) {
		super(app);
		this.label = label;
		this.kind = kind;
		this.hasFile = hasFile;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `Delete ${this.kind}?` });
		contentEl.createEl("p", {
			text:
				`This removes every link to “${this.label}” from the note.` +
				(this.hasFile ? ` The ${this.kind} file itself can stay in the vault, or go to the trash with it.` : ""),
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText("Remove link")
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm(false);
					});
				b.buttonEl.focus();
			})
			.addButton((b) => {
				if (!this.hasFile) {
					b.buttonEl.remove();
					return;
				}
				b.setButtonText("Remove link and trash file")
					.setDestructive()
					.onClick(() => {
						this.close();
						this.onConfirm(true);
					});
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Images canvas: where in the note the pasted image's embed should land. */
export class PasteImageModal extends Modal {
	private readonly onPick: (where: "start" | "end") => void;

	constructor(app: App, onPick: (where: "start" | "end") => void) {
		super(app);
		this.onPick = onPick;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Paste image" });
		contentEl.createEl("p", {
			text: "The clipboard image is saved to your attachment folder and embedded in this note. Where should the link go?",
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b.setButtonText("Start of note").onClick(() => {
					this.close();
					this.onPick("start");
				}),
			)
			.addButton((b) => {
				b.setButtonText("End of note")
					.setCta()
					.onClick(() => {
						this.close();
						this.onPick("end");
					});
				b.buttonEl.focus();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ConfirmClearModal extends Modal {
	private readonly count: number;
	/** What the canvas holds: "section" on the Custom Grid, "image" on Images. */
	private readonly noun: string;
	private readonly onConfirm: () => void;

	constructor(app: App, count: number, noun: string, onConfirm: () => void) {
		super(app);
		this.count = count;
		this.noun = noun;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Clear the layout?" });
		contentEl.createEl("p", {
			text: `Are you sure? This removes ${this.count === 1 ? `the 1 placed ${this.noun}` : `all ${this.count} placed ${this.noun}s`} from the canvas and returns ${this.count === 1 ? "it" : "them"} to the list. Your notes are not changed.`,
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
export class ShortcutsModal extends Modal {
	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Keyboard shortcuts" });
		const groups: [string, [string, string][]][] = [
			[
				"Cards",
				[
					["N", "New card"],
					["Click a title bar", "Select that card; Shift+click selects the run from it; click empty space to clear"],
					[`${MOD_LABEL}+A`, "Select every visible card"],
					["↑ ↓ ← →", "Move the keyboard focus between cards (Shift extends the selection)"],
					["Enter / Space", "Edit the focused card / select or deselect it"],
					[`${MOD_LABEL}+click`, "Make the card big"],
					["F", "Flip the card under the pointer over / back"],
					["Shift+F", "Flip every card back to the front"],
				],
			],
			[
				"Editing a card",
				[
					[`${MOD_LABEL}+Enter`, "Save the card being edited"],
					[`${MOD_LABEL}+T`, "Edit the task on the cursor line, or create one there (Tasks plugin)"],
					["Esc", "Cancel the edit; elsewhere, clear the filter or close a big card"],
				],
			],
			[
				"Layout and view",
				[
					["1–6", "Show that heading level as cards"],
					["L / Shift+L", "Cycle the layouts forwards / backwards"],
					["V", "Cycle the view modes: default / hierarchy / dividers"],
					[", / .", "Previous / next heading in the Hierarchy and Dividers view modes, or card in the Rolodex and Day Planner"],
					["S", "Show only starred lines / show everything"],
					[`${MOD_LABEL}+F`, "Jump to the filter box"],
				],
			],
			[
				"Notes",
				[
					["O", "Open a different note"],
					["D", "Show or hide the Deck of notes"],
					["M", "Open the ☰ menu"],
				],
			],
		];
		const grid = contentEl.createDiv({ cls: "sfsc-shortcuts" });
		for (const [title, rows] of groups) {
			grid.createDiv({ cls: "sfsc-shortcuts-group", text: title });
			for (const [key, desc] of rows) {
				grid.createEl("kbd", { cls: "sfsc-shortcuts-key", text: key });
				grid.createDiv({ cls: "sfsc-shortcuts-desc", text: desc });
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Jump-to-date found no card for the picked date: offer to create one (Yes / No). */
export class CreateDateCardModal extends Modal {
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

/** Day Planner: the arrow reached a day with no card — create it, or skip to the
 * nearest day that has one. */
export class PlannerMissingDayModal extends Modal {
	private readonly unit: string;
	private readonly title: string;
	private readonly skipTitle: string | null;
	private readonly onCreate: () => void | Promise<void>;
	private readonly onSkip: () => void;

	constructor(
		app: App,
		unit: string,
		title: string,
		skipTitle: string | null,
		onCreate: () => void | Promise<void>,
		onSkip: () => void,
	) {
		super(app);
		this.unit = unit;
		this.title = title;
		this.skipTitle = skipTitle;
		this.onCreate = onCreate;
		this.onSkip = onSkip;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `No card for that ${this.unit}` });
		contentEl.createEl("p", { text: `This note has no “${this.title}” card.` });
		const row = new Setting(contentEl);
		row.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
		if (this.skipTitle) {
			const skip = this.skipTitle.length > 32 ? `${this.skipTitle.slice(0, 31)}…` : this.skipTitle;
			row.addButton((b) =>
				b.setButtonText(`Skip to ${skip}`).onClick(() => {
					this.close();
					this.onSkip();
				}),
			);
		}
		row.addButton((b) => {
			b.setButtonText("Create it")
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

/**
 * Document setup: what each heading level of the note holds. One row per level with
 * how many headings it has and a sample title, a role dropdown, and — for years,
 * months, and weeks — the spelling. Detection fills the defaults; Save stores the rows
 * per note, Reset to detected forgets them.
 */
export class DocumentSetupModal extends Modal {
	private readonly plugin: SectionCardsPlugin;
	private readonly noteName: string;
	private readonly lines: string[];
	private readonly detected: DocumentLevels;
	private readonly dated: boolean;
	private readonly cardFormat: string;
	private readonly onSave: (levels: DocumentLevels | null) => void;
	private levels: DocumentLevels;

	constructor(
		plugin: SectionCardsPlugin,
		noteName: string,
		lines: string[],
		saved: DocumentLevels | null,
		detected: DocumentLevels,
		dated: boolean,
		cardFormat: string,
		onSave: (levels: DocumentLevels | null) => void,
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.noteName = noteName;
		this.lines = lines;
		this.detected = detected;
		this.dated = dated;
		this.cardFormat = cardFormat;
		this.onSave = onSave;
		this.levels = { ...detected, ...(saved ?? {}) };
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("sfsc-docsetup");
		contentEl.createEl("h3", { text: "Document setup" });
		contentEl.createEl("p", {
			cls: "sfsc-docsetup-intro",
			text: `What each heading level of “${this.noteName}” holds. ${
				this.dated
					? "Dates is on for this note, so levels whose titles read as years, months, weeks, or days are detected as such; the Day Planner's arrows then step by that unit and offer to create a missing one."
					: "Dates is off for this note (toolbar checkbox), so every level defaults to text; turn it on to map levels to years, months, weeks, or days."
			}`,
		});

		const titles: string[][] = [[], [], [], [], [], [], []];
		for (const h of parseAncestorHeadings(this.lines, 7)) titles[h.level].push(h.title);

		for (let level = 1; level <= 6; level++) {
			const key = String(level);
			const setup = this.levels[key] ?? { role: "none" };
			const count = titles[level].length;
			const sample = titles[level][0];
			const row = new Setting(contentEl)
				.setName(`H${level}`)
				.setDesc(count ? `${count} heading${count === 1 ? "" : "s"} — e.g. “${sample.length > 40 ? `${sample.slice(0, 39)}…` : sample}”` : "No headings at this level");
			row.addDropdown((drop) => {
				for (const [value, label] of LEVEL_ROLE_LABELS) drop.addOption(value, label);
				drop.setValue(setup.role).onChange((value) => {
					const role = value as LevelRole;
					const next: LevelSetup = { role };
					if (role === "year" || role === "month" || role === "week") {
						next.format = this.detected[key]?.role === role && this.detected[key]?.format ? this.detected[key].format : PERIOD_FORMATS[role][0];
					}
					this.levels[key] = next;
					this.render();
				});
			});
			if (setup.role === "year" || setup.role === "month" || setup.role === "week") {
				const role = setup.role;
				row.addDropdown((drop) => {
					for (const format of PERIOD_FORMATS[role]) {
						drop.addOption(format, formatPeriod(role === "year" ? "2026" : role === "month" ? "2026-09" : format.includes("YYYY-MM-DD") ? "D:2026-09-14" : "2026-W38", role, format));
					}
					drop.setValue(setup.format ?? PERIOD_FORMATS[role][0]).onChange((value) => {
						this.levels[key] = { role, format: value };
					});
				});
			} else if (setup.role === "day") {
				row.descEl.createDiv({ cls: "sfsc-docsetup-note", text: `Days use the note's new-card format: ${this.cardFormat}` });
			}
		}

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Reset to detected").onClick(() => {
					this.levels = { ...this.detected };
					this.close();
					this.onSave(null);
				}),
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => {
						this.close();
						this.onSave({ ...this.levels });
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class DuplicateCardModal extends Modal {
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

export class NewCardModal extends Modal {
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
export class HeadingFormatModal extends Modal {
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

export class QuickAddModal extends Modal {
	private readonly plugin: SectionCardsPlugin;
	private readonly title: string;
	private readonly hasBack: boolean;
	private readonly onSubmit: (text: string, where: QuickAddPlacement) => void | Promise<void>;
	private editor: EmbeddedEditor | null = null;
	private box: HTMLTextAreaElement | null = null;

	/** @param hasBack  The card has a back (Card Flip): offer front and back placements. */
	constructor(
		plugin: SectionCardsPlugin,
		title: string,
		hasBack: boolean,
		onSubmit: (text: string, where: QuickAddPlacement) => void | Promise<void>,
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.title = title;
		this.hasBack = hasBack;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("section-cards-quickadd-modal");
		// On phones the software keyboard covers a centered modal's lower half — the
		// dialog rides at the top instead so the text box stays visible while typing
		// (portrait is where the squeeze happens; styles.css scopes it there).
		this.containerEl.addClass("sfsc-raise-for-keyboard");
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

		if (this.hasBack) {
			// A two-faced card: a labelled row of placements per face. The front's bottom
			// stays the default (Ctrl/⌘+Enter), as on any other card.
			new Setting(contentEl)
				.setName("Card front")
				.setClass("section-cards-quickadd-face")
				.addButton((b) => b.setButtonText("Add to top").onClick(() => this.submit("top")))
				.addButton((b) => b.setButtonText("Add to bottom").setCta().onClick(() => this.submit("bottom")));
			new Setting(contentEl)
				.setName("Card back")
				.setClass("section-cards-quickadd-face")
				.addButton((b) => b.setButtonText("Add to top").onClick(() => this.submit("back-top")))
				.addButton((b) => b.setButtonText("Add to bottom").onClick(() => this.submit("back-bottom")));
			new Setting(contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
		} else {
			new Setting(contentEl)
				.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
				.addButton((b) => b.setButtonText("Add to top").onClick(() => this.submit("top")))
				.addButton((b) => b.setButtonText("Add to bottom").setCta().onClick(() => this.submit("bottom")));
		}

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

/**
 * Edit one block — a task with its sub-items, or a paragraph — in the card editor's own
 * flavour: the live-preview embed (or source) per the editor-mode setting, falling back
 * to a plain textarea. Ctrl/⌘+Enter saves; Escape cancels.
 */
export class EditBlockModal extends Modal {
	private readonly plugin: SectionCardsPlugin;
	private readonly initial: string;
	private readonly onSubmit: (text: string) => void | Promise<void>;
	private editor: EmbeddedEditor | null = null;
	private box: HTMLTextAreaElement | null = null;

	constructor(plugin: SectionCardsPlugin, initial: string, onSubmit: (text: string) => void | Promise<void>) {
		super(plugin.app);
		this.plugin = plugin;
		this.initial = initial;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("section-cards-quickadd-modal");
		contentEl.createEl("h3", { text: "Edit line" });

		const mode = this.plugin.settings.editorMode;
		if (mode !== "plain") {
			const host = contentEl.createDiv({ cls: "section-card-editor-embed section-cards-quickadd-editor" });
			this.editor = createEmbeddedEditor(this.plugin.app, host, {
				value: this.initial,
				mode: mode === "source" ? "source" : "live",
				onSave: () => this.submit(),
				onCancel: () => this.close(),
				onChange: () => {},
			});
			if (!this.editor) host.remove();
		}
		if (!this.editor) {
			this.box = contentEl.createEl("textarea", { cls: "section-cards-quickadd-input" });
			this.box.value = this.initial;
			this.box.rows = Math.min(10, this.initial.split("\n").length + 1);
			// Enter makes a new line; Ctrl/⌘+Enter saves.
			this.box.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
					e.preventDefault();
					this.submit();
				}
			});
		}

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Save").setCta().onClick(() => this.submit()));

		if (this.editor) this.editor.focusEnd();
		else this.box?.focus();
	}

	private submit(): void {
		const text = (this.editor ? this.editor.value : (this.box?.value ?? "")).replace(/\s+$/, "");
		if (!text.trim()) {
			new Notice("The line can't be empty — cancel and delete it instead.");
			return;
		}
		this.close();
		void this.onSubmit(text);
	}

	onClose(): void {
		this.editor?.destroy();
		this.editor = null;
		this.contentEl.empty();
	}
}

/** A saved layout has changed since it was saved, and the canvas is about to be
 * cleared, switched, or left: save it first, go on without saving, or stay. */
export class SavedLayoutChangesModal extends Modal {
	private readonly name: string;
	private readonly onChoice: (choice: "save" | "discard" | "cancel") => void;

	constructor(app: App, name: string, onChoice: (choice: "save" | "discard" | "cancel") => void) {
		super(app);
		this.name = name;
		this.onChoice = onChoice;
	}

	private choose(choice: "save" | "discard" | "cancel"): void {
		this.close();
		this.onChoice(choice);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Save layout changes?" });
		contentEl.createEl("p", {
			text: `The layout “${this.name}” has changed since it was saved. Save the current arrangement and background to it first?`,
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.choose("cancel")))
			.addButton((b) => b.setButtonText("Don't save").setDestructive().onClick(() => this.choose("discard")))
			.addButton((b) => b.setButtonText("Save").setCta().onClick(() => this.choose("save")));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
