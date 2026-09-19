// New note: a wizard that creates a note pre-shaped as a Kanban board, a SWOT analysis, an
// Eisenhower matrix, or a GTD system — one card per section, at the chosen heading level —
// or on the headings of any note in the vault (its text stays behind), with the card
// templates' placeholders filled in and optional Introduction and Additional notes sections.

import { App, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import type SectionCardsPlugin from "../main";
import { Layout } from "./settings";
import { CardRect, CUSTOM_SNAP } from "./canvas";
import { LAYOUT_OPTIONS } from "./settings";
import { applyTemplatePlaceholders, headingLevelsIn, parseSections } from "./sections";
import { FileSuggestModal } from "./modals";

export type StructuredFormat = "kanban" | "swot" | "eisenhower" | "gtd";

export interface StructuredSection {
	title: string;
	/** One line under the heading saying what belongs there (optional in the wizard). */
	hint: string;
	/** A preset note's further content under the heading (example tasks, say), kept as is. */
	body?: string;
}

export interface StructuredFormatDef {
	/** A built-in format's id, or "preset:<path>" for a preset note. */
	id: string;
	label: string;
	/** Shown in the wizard under the format picker. */
	description: string;
	/** The default note name. */
	noteName: string;
	sections: StructuredSection[];
	/** The layout the note opens in: columns side by side for a board, a 2×2 canvas for a
	 * matrix, the wall for a system of lists. */
	layout: Layout;
	/** A 2×2 matrix: the four sections are placed as quadrants on the Custom Grid. */
	matrix?: boolean;
	/** A preset note: its vault path, and the heading level its sections sit at. */
	path?: string;
	level?: number;
}

/** The frontmatter keys that make a note a preset in the wizard. */
export const PRESET_KEYS = {
	preset: "cards-preset",
	description: "cards-description",
	layout: "cards-layout",
	matrix: "cards-matrix",
} as const;

const HINT_LINE_RE = /^(\*|_)(.+)\1$/;

/**
 * A preset from a note: its sections are the headings at its shallowest level; an italic
 * first line under a heading is that section's hint, and anything further is kept as
 * the section's body. The frontmatter can name a description, the layout the new note
 * opens in (cards-layout), and whether the sections are a 2×2 matrix (cards-matrix).
 * Null when the note has no headings.
 */
export function presetFromNote(name: string, path: string, body: string, frontmatter: Record<string, unknown> | undefined): StructuredFormatDef | null {
	const lines = body.split(/\r?\n/);
	const level = headingLevelsIn(lines)[0];
	if (!level) return null;
	const sections: StructuredSection[] = parseSections(lines, level).map((s) => {
		const rows = s.body.split("\n");
		let i = 0;
		while (i < rows.length && rows[i].trim() === "") i++;
		const m = i < rows.length ? HINT_LINE_RE.exec(rows[i].trim()) : null;
		const rest = rows.slice(m ? i + 1 : i);
		while (rest.length && rest[0].trim() === "") rest.shift();
		while (rest.length && rest[rest.length - 1].trim() === "") rest.pop();
		const section: StructuredSection = { title: s.title, hint: m ? m[2].trim() : "" };
		if (rest.length) section.body = rest.join("\n");
		return section;
	});
	if (!sections.length) return null;
	const fm = frontmatter ?? {};
	// Frontmatter values arrive as whatever YAML made of them; only scalars count.
	const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
	const layoutValue = text(fm[PRESET_KEYS.layout]);
	const layout = LAYOUT_OPTIONS.find(([value]) => value === layoutValue)?.[0];
	const matrixValue = fm[PRESET_KEYS.matrix];
	const description = text(fm[PRESET_KEYS.description]).trim();
	return {
		id: `preset:${path}`,
		label: name,
		description: description || `${sections.length} section${sections.length === 1 ? "" : "s"}, from “${name}”.`,
		noteName: name,
		layout: layout ?? "grid",
		matrix: matrixValue === true || matrixValue === "true",
		sections,
		path,
		level,
	};
}

/** Every preset note in the vault (frontmatter cards-preset: true), read once per wizard. */
export async function listPresets(app: App): Promise<StructuredFormatDef[]> {
	const out: StructuredFormatDef[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const fm: Record<string, unknown> | undefined = app.metadataCache.getFileCache(file)?.frontmatter;
		const flag = fm?.[PRESET_KEYS.preset];
		if (flag !== true && flag !== "true") continue;
		const def = presetFromNote(file.basename, file.path, await app.vault.cachedRead(file), fm);
		if (def) out.push(def);
	}
	return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }));
}

export const STRUCTURED_FORMATS: StructuredFormatDef[] = [
	{
		id: "kanban",
		label: "Kanban board",
		description: "Work as cards moving across columns, left to right, from waiting to done.",
		noteName: "Kanban board",
		layout: "vertical",
		sections: [
			{ title: "To do", hint: "Work that's agreed but not started." },
			{ title: "In progress", hint: "Work under way right now — keep this column short." },
			{ title: "Done", hint: "Finished work, kept for the record." },
		],
	},
	{
		id: "swot",
		label: "SWOT analysis",
		description: "Strengths and weaknesses inside, opportunities and threats outside — four quadrants.",
		noteName: "SWOT analysis",
		layout: "custom",
		matrix: true,
		sections: [
			{ title: "Strengths", hint: "What we do well; the advantages we hold." },
			{ title: "Weaknesses", hint: "What holds us back; where we fall short." },
			{ title: "Opportunities", hint: "Outside conditions we could turn to our favour." },
			{ title: "Threats", hint: "Outside conditions that could do us harm." },
		],
	},
	{
		id: "eisenhower",
		label: "Eisenhower matrix",
		description: "Tasks by urgency and importance: do, schedule, delegate, or drop.",
		noteName: "Eisenhower matrix",
		layout: "custom",
		matrix: true,
		sections: [
			{ title: "Do first", hint: "Urgent and important — today." },
			{ title: "Schedule", hint: "Important, not urgent — give it a date." },
			{ title: "Delegate", hint: "Urgent, not important — hand it on." },
			{ title: "Eliminate", hint: "Neither urgent nor important — let it go." },
		],
	},
	{
		id: "gtd",
		label: "Getting Things Done",
		description: "Capture everything, then sort it into next actions, projects, waiting, and someday.",
		noteName: "GTD",
		layout: "grid",
		sections: [
			{ title: "Inbox", hint: "Everything captured, unsorted — empty it regularly." },
			{ title: "Next actions", hint: "The single next physical step for each thing." },
			{ title: "Projects", hint: "Outcomes that take more than one action." },
			{ title: "Waiting for", hint: "Handed to someone else; check back." },
			{ title: "Someday, maybe", hint: "Not now — but not forgotten." },
			{ title: "Reference", hint: "Information to keep, no action needed." },
		],
	},
];

/** A built-in format by id; null for anything else ("none", "note", a preset id). */
export function structuredFormat(id: string): StructuredFormatDef | null {
	return STRUCTURED_FORMATS.find((f) => f.id === id) ?? null;
}

/** What the wizard collected. `sections` are the titles as edited, in order; with "preset"
 * or "note", `preset` holds the format read from that note (a vault note's headings only —
 * no hints, no bodies — so it serves as a template without carrying its text). */
export interface StructuredSpec {
	/** A built-in, a preset note, the headings of a vault note, or "none" — a blank note
	 * (plus whatever sections the wizard adds). */
	format: StructuredFormat | "none" | "note" | "preset";
	templatePath?: string;
	preset?: StructuredFormatDef;
	/** One of the template note's saved Custom Grid layouts to apply to the new note. */
	savedLayout?: string;
	/** The layout the new note opens in; unset, the template's own (or the default). */
	layout?: Layout;
	level: number;
	sections: string[];
	intro: boolean;
	notes: boolean;
	hints: boolean;
}

/** The format a spec draws sections and hints from: a built-in, or the format read from
 * the preset or vault note it carries. */
export function specFormat(spec: StructuredSpec): StructuredFormatDef | null {
	if (spec.format === "preset" || spec.format === "note") return spec.preset ?? null;
	if (spec.format === "none") return null;
	return structuredFormat(spec.format);
}

/** A vault note as a template: its headings only. The preset parse, with every section's
 * hint and body dropped, so the new note gets the structure and none of the text. */
export function headingsOnlyFormat(name: string, path: string, body: string): StructuredFormatDef | null {
	const def = presetFromNote(name, path, body, undefined);
	if (!def) return null;
	return { ...def, id: `note:${path}`, sections: def.sections.map((s) => ({ title: s.title, hint: "" })) };
}

export const INTRO_TITLE = "Introduction";
export const NOTES_TITLE = "Additional notes";

/** The section titles the note will hold, in order: Introduction, the format's, Additional notes. */
export function structuredTitles(spec: StructuredSpec): string[] {
	const titles = spec.sections.map((s) => s.trim()).filter(Boolean);
	return [...(spec.intro ? [INTRO_TITLE] : []), ...titles, ...(spec.notes ? [NOTES_TITLE] : [])];
}

/**
 * The note's markdown: one heading per section at the chosen level, a blank line between
 * sections, and — with hints on — one italic line under each heading saying what belongs
 * there (the format's own for its sections, a generic one for the two optional ones; a
 * renamed section keeps its position's hint), then any body the section's format carries
 * (a preset's kept content). The hint sits between blank lines, so it stays a paragraph
 * of its own: a task added above it (Quick Add at the top, a drop) doesn't swallow it as
 * a continuation, and it moves and deletes alone.
 */
export function structuredNoteMarkdown(spec: StructuredSpec): string {
	const def = specFormat(spec);
	const hashes = "#".repeat(Math.min(6, Math.max(1, spec.level)));
	const hintFor = (title: string, index: number): string | null => {
		if (!spec.hints) return null;
		if (title === INTRO_TITLE) return "What this note is for, and how to use it.";
		if (title === NOTES_TITLE) return "Anything that doesn't fit the sections above.";
		return def?.sections[index]?.hint || null;
	};
	const blocks: string[] = [];
	const push = (title: string, hint: string | null, body?: string) => {
		let block = `${hashes} ${title}\n`;
		if (hint) block += `\n*${hint}*\n`;
		if (body) block += `\n${body}\n`;
		blocks.push(block);
	};
	if (spec.intro) push(INTRO_TITLE, hintFor(INTRO_TITLE, -1));
	spec.sections
		.map((s) => s.trim())
		.filter(Boolean)
		.forEach((title, i) => push(title, hintFor(title, i), def?.sections[i]?.body));
	if (spec.notes) push(NOTES_TITLE, hintFor(NOTES_TITLE, -1));
	return blocks.join("\n");
}

/** The note as written: the markdown with the card templates' placeholders filled —
 * {{title}} is the note's name, {{date}} and {{time}} now. */
export function structuredNoteContent(spec: StructuredSpec, noteName: string, headingFormat: string): string {
	return applyTemplatePlaceholders(structuredNoteMarkdown(spec), noteName, headingFormat);
}

/**
 * Custom Grid placements for a matrix note: the format's four sections as quadrants,
 * the Introduction as a band above them and Additional notes as one below, so nothing
 * lands in the tray. Null for formats that open on the wall or in columns.
 */
export function structuredPlacements(spec: StructuredSpec): Record<string, CardRect> | null {
	const def = specFormat(spec);
	if (!def?.matrix) return null;
	const hashes = "#".repeat(Math.min(6, Math.max(1, spec.level)));
	const unit = CUSTOM_SNAP;
	const quadW = unit * 14;
	const quadH = unit * 11;
	const bandH = unit * 6;
	const left = unit;
	let y = unit;
	const out: Record<string, CardRect> = {};
	if (spec.intro) {
		out[`${hashes} ${INTRO_TITLE}`] = { x: left, y, w: quadW * 2 + unit, h: bandH };
		y += bandH + unit;
	}
	const own = spec.sections.map((s) => s.trim()).filter(Boolean);
	own.forEach((title, i) => {
		const col = i % 2;
		const row = Math.floor(i / 2);
		out[`${hashes} ${title}`] = { x: left + col * (quadW + unit), y: y + row * (quadH + unit), w: quadW, h: quadH };
	});
	y += Math.ceil(own.length / 2) * (quadH + unit);
	if (spec.notes) out[`${hashes} ${NOTES_TITLE}`] = { x: left, y, w: quadW * 2 + unit, h: bandH };
	return out;
}

/** The wizard: pick a built-in format or a note from the vault, name the note, choose
 * the heading level, edit the sections, and switch the Introduction, Additional notes,
 * and hints on or off. */
export class StructuredNoteModal extends Modal {
	private readonly plugin: SectionCardsPlugin;
	private readonly onCreate: (name: string, spec: StructuredSpec) => void;

	constructor(plugin: SectionCardsPlugin, onCreate: (name: string, spec: StructuredSpec) => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.onCreate = onCreate;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("sfsc-structured-modal");
		contentEl.createEl("h3", { text: "New note" });

		// The default is no template: a blank note, plus whatever the rows below add.
		let def: StructuredFormatDef | null = null;
		const spec: StructuredSpec = {
			format: "none",
			level: 2,
			sections: [],
			intro: false,
			notes: false,
			hints: true,
		};
		let name = "New note";
		let nameTouched = false;
		const NONE_DESC = "A blank note — or type section names below and switch on an introduction or notes.";
		const NOTE_DESC = "The headings of a note in the vault become the sections. Its text isn't copied — only the structure, so any note can serve as a template.";
		const describe = () => (spec.format === "none" ? NONE_DESC : spec.format === "note" ? NOTE_DESC : (def?.description ?? ""));

		let description!: HTMLElement;
		let nameInput!: HTMLInputElement;
		let sectionsInput!: HTMLInputElement;
		let levelDropdown!: { setValue: (v: string) => unknown };
		let templateRow!: Setting;
		let savedRow!: Setting;
		let savedDropdown!: { selectEl: HTMLSelectElement; addOption: (v: string, l: string) => unknown; setValue: (v: string) => unknown };
		let layoutDropdown!: { setValue: (v: string) => unknown };
		let layoutTouched = false;
		let presets: StructuredFormatDef[] = [];

		// The layout the new note opens in: the template's own until the user picks one.
		const templateLayout = (): Layout => {
			if (spec.format === "note" && spec.templatePath) return this.plugin.getStoredView(spec.templatePath)?.layout ?? this.plugin.settings.layout;
			return specFormat(spec)?.layout ?? this.plugin.settings.layout;
		};
		const syncLayoutDefault = () => {
			if (layoutTouched) return;
			spec.layout = templateLayout();
			layoutDropdown.setValue(spec.layout);
		};

		// The template note's saved Custom Grid layouts, offered for the new note.
		const syncSavedLayouts = () => {
			const templateNote = spec.format === "preset" ? spec.preset?.path : spec.format === "note" ? spec.templatePath : undefined;
			const saved = templateNote ? this.plugin.getSavedLayouts(templateNote) : {};
			const names = Object.keys(saved).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
			spec.savedLayout = undefined;
			savedDropdown.selectEl.empty();
			savedDropdown.addOption("", "As arranged now");
			for (const n of names) savedDropdown.addOption(n, n);
			savedDropdown.setValue("");
			savedRow.settingEl.toggleClass("is-hidden", names.length === 0);
			syncLayoutDefault();
		};

		// The rows that only make sense for one kind of template.
		// Only the vault-note kind needs the note row; sections are always editable.
		const syncRows = () => {
			templateRow.settingEl.toggleClass("is-hidden", spec.format !== "note");
			syncSavedLayouts();
		};

		new Setting(contentEl)
			.setName("Template")
			.setDesc("Built-in structures, your preset notes (frontmatter cards-preset: true), or any note.")
			.addDropdown((dd) => {
				dd.addOption("none", "None");
				for (const f of STRUCTURED_FORMATS) dd.addOption(f.id, f.label);
				dd.addOption("note", "Existing note (headings only)");
				// Preset notes join the list once read — after the built-ins, before "any note".
				void listPresets(this.plugin.app).then((found) => {
					presets = found;
					const noteOption = dd.selectEl.querySelector('option[value="note"]');
					for (const p of found) {
						const option = createEl("option", { value: p.id, text: p.label });
						if (noteOption) dd.selectEl.insertBefore(option, noteOption);
						else dd.selectEl.appendChild(option);
					}
				});
				dd.setValue("none").onChange((value) => {
					const preset = presets.find((p) => p.id === value);
					def = preset ?? structuredFormat(value);
					spec.format = preset ? "preset" : def ? (def.id as StructuredFormat) : value === "note" ? "note" : "none";
					spec.preset = preset;
					spec.sections = def ? def.sections.map((s) => s.title) : [];
					sectionsInput.value = spec.sections.join(", ");
					if (def?.level) {
						spec.level = def.level;
						levelDropdown.setValue(String(spec.level));
					}
					description.setText(describe());
					if (!nameTouched) {
						name = def?.noteName ?? "New note";
						nameInput.value = name;
					}
					syncRows();
				});
			});
		description = contentEl.createEl("p", { cls: "sfsc-structured-desc", text: describe() });

		templateRow = new Setting(contentEl)
			.setName("Note")
			.setDesc("No note chosen yet. Its headings will fill the sections below; its text stays where it is.")
			.addButton((b) =>
				b.setButtonText("Choose…").onClick(() => {
					new FileSuggestModal(this.plugin.app, this.plugin, (path) => {
						spec.templatePath = path;
						const file = this.plugin.app.vault.getAbstractFileByPath(path);
						if (!(file instanceof TFile)) return;
						if (!nameTouched) {
							name = file.basename;
							nameInput.value = name;
						}
						// The note's headings become the sections (editable), at the level they sit at.
						void this.plugin.app.vault.cachedRead(file).then((body) => {
							const format = headingsOnlyFormat(file.basename, path, body);
							spec.preset = format ?? undefined;
							spec.sections = format ? format.sections.map((s) => s.title) : [];
							sectionsInput.value = spec.sections.join(", ");
							if (format?.level) {
								spec.level = format.level;
								levelDropdown.setValue(String(spec.level));
							}
							templateRow.setDesc(
								format
									? `${path} — ${format.sections.length} heading${format.sections.length === 1 ? "" : "s"} as sections; the text under them isn't copied.`
									: `${path} has no headings to take.`,
							);
							syncSavedLayouts();
						});
					}).open();
				}),
			);

		new Setting(contentEl)
			.setName("Note name")
			.setDesc("Created in the default new-note folder; include an existing folder/ to place it there.")
			.addText((t) => {
				nameInput = t.inputEl;
				t.setValue(name).onChange((value) => {
					name = value;
					nameTouched = true;
				});
			});

		new Setting(contentEl)
			.setName("Heading level")
			.setDesc("Each section is a heading at this level — and a card.")
			.addDropdown((dd) => {
				for (const level of [1, 2, 3, 4, 5, 6]) dd.addOption(String(level), `Heading ${level}`);
				dd.setValue(String(spec.level)).onChange((value) => (spec.level = Number(value)));
				levelDropdown = dd;
			});

		new Setting(contentEl)
			.setName("Sections")
			.setDesc("Comma-separated, in order. Rename or add; a matrix reads best with four.")
			.addText((t) => {
				sectionsInput = t.inputEl;
				t.setValue(spec.sections.join(", ")).onChange((value) => {
					spec.sections = value.split(",").map((s) => s.trim()).filter(Boolean);
				});
			});

		new Setting(contentEl)
			.setName("Introduction")
			.setDesc("A first section for what the note is for.")
			.addToggle((t) => t.setValue(spec.intro).onChange((v) => (spec.intro = v)));
		new Setting(contentEl)
			.setName("Additional notes")
			.setDesc("A last section for whatever doesn't fit.")
			.addToggle((t) => t.setValue(spec.notes).onChange((v) => (spec.notes = v)));
		savedRow = new Setting(contentEl)
			.setName("Saved layout")
			.setDesc("Open the new note on one of the template's saved layouts.")
			.addDropdown((dd) => {
				savedDropdown = dd;
				dd.addOption("", "As arranged now");
				dd.onChange((value) => {
					spec.savedLayout = value || undefined;
					// A saved layout is a Custom Grid arrangement: open there to see it.
					if (value) {
						spec.layout = "custom";
						layoutDropdown.setValue("custom");
					}
				});
			});

		new Setting(contentEl)
			.setName("Layout")
			.setDesc("The layout the note opens in — the template's own unless you choose another.")
			.addDropdown((dd) => {
				for (const [value, label] of LAYOUT_OPTIONS) dd.addOption(value, label);
				layoutDropdown = dd;
				dd.setValue(templateLayout()).onChange((value) => {
					spec.layout = value as Layout;
					layoutTouched = true;
				});
			});

		new Setting(contentEl)
			.setName("Hints")
			.setDesc("One italic line under each heading saying what belongs there (the built-ins' and presets' own; a generic one for the introduction and notes).")
			.addToggle((t) => t.setValue(spec.hints).onChange((v) => (spec.hints = v)));
		syncRows();

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Create")
					.setCta()
					.onClick(() => {
						const trimmed = name.trim();
						if (!trimmed) {
							new Notice("Give the note a name.");
							return;
						}
						if (spec.format === "note" && !spec.templatePath) {
							new Notice("Choose the note whose headings to use.");
							return;
						}
						// A blank note is fine; a structure with every section deleted isn't.
						if (spec.format !== "none" && !structuredTitles(spec).length) {
							new Notice("The note needs at least one section.");
							return;
						}
						this.close();
						this.onCreate(trimmed, spec);
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Where a new structured note goes: a name with a folder/ is a path; a bare name lands
 * in Obsidian's default new-note folder (relative to the default note). */
export function structuredNotePath(app: App, defaultNote: string, name: string): string {
	const q = normalizePath(name.trim().replace(/\.md$/i, ""));
	if (q.includes("/")) return `${q}.md`;
	const parent = app.fileManager.getNewFileParent(defaultNote ?? "");
	return normalizePath(`${parent.path}/${q}.md`);
}
