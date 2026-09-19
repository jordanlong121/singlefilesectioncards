// New note from template: a wizard that creates a note pre-shaped as a Kanban board, a
// SWOT analysis, an Eisenhower matrix, or a GTD system — one card per section, at the
// chosen heading level — or as a copy of any note in the vault, with the card templates'
// placeholders filled in and optional Introduction and Additional notes sections.

import { App, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import type SectionCardsPlugin from "../main";
import { Layout } from "./settings";
import { CardRect, CUSTOM_SNAP } from "./canvas";
import { applyTemplatePlaceholders, headingLevelsIn } from "./sections";
import { FileSuggestModal } from "./modals";

export type StructuredFormat = "kanban" | "swot" | "eisenhower" | "gtd";

export interface StructuredSection {
	title: string;
	/** One line under the heading saying what belongs there (optional in the wizard). */
	hint: string;
}

export interface StructuredFormatDef {
	id: StructuredFormat;
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

/** A built-in format by id; null for "note" (a vault note as the template). */
export function structuredFormat(id: StructuredFormat | "note"): StructuredFormatDef | null {
	return STRUCTURED_FORMATS.find((f) => f.id === id) ?? null;
}

/** What the wizard collected. `sections` are the titles as edited, in order; with the
 * "note" format the body comes from `templatePath` instead. */
export interface StructuredSpec {
	format: StructuredFormat | "note";
	templatePath?: string;
	level: number;
	sections: string[];
	intro: boolean;
	notes: boolean;
	hints: boolean;
}

export const INTRO_TITLE = "Introduction";
export const NOTES_TITLE = "Additional notes";

/** The section titles the note will hold, in order: Introduction, the format's, Additional notes. */
export function structuredTitles(spec: StructuredSpec): string[] {
	const titles = spec.sections.map((s) => s.trim()).filter(Boolean);
	return [...(spec.intro ? [INTRO_TITLE] : []), ...titles, ...(spec.notes ? [NOTES_TITLE] : [])];
}

/**
 * The note's markdown. A built-in format: one heading per section at the chosen level,
 * a blank line between sections, and — with hints on — one italic line under each
 * heading saying what belongs there (the format's own for its sections, a generic one
 * for the two optional ones; a renamed section keeps its position's hint). The hint
 * sits between blank lines, so it stays a paragraph of its own: a task added above it
 * (Quick Add at the top, a drop) doesn't swallow it as a continuation, and it moves and
 * deletes alone. The "note" format: the template note's body as it is, the optional
 * sections around it.
 */
export function structuredNoteMarkdown(spec: StructuredSpec, templateBody = ""): string {
	const def = structuredFormat(spec.format);
	const hashes = "#".repeat(Math.min(6, Math.max(1, spec.level)));
	const hintFor = (title: string, index: number): string | null => {
		if (!spec.hints) return null;
		if (title === INTRO_TITLE) return "What this note is for, and how to use it.";
		if (title === NOTES_TITLE) return "Anything that doesn't fit the sections above.";
		return def?.sections[index]?.hint ?? null;
	};
	const blocks: string[] = [];
	const push = (title: string, hint: string | null) => blocks.push(hint ? `${hashes} ${title}\n\n*${hint}*\n` : `${hashes} ${title}\n`);
	if (spec.intro) push(INTRO_TITLE, hintFor(INTRO_TITLE, -1));
	if (spec.format === "note") {
		const body = templateBody.replace(/^\s*\n/, "").trimEnd();
		if (body) blocks.push(`${body}\n`);
	} else {
		spec.sections
			.map((s) => s.trim())
			.filter(Boolean)
			.forEach((title, i) => push(title, hintFor(title, i)));
	}
	if (spec.notes) push(NOTES_TITLE, hintFor(NOTES_TITLE, -1));
	return blocks.join("\n");
}

/** The note as written: the markdown with the card templates' placeholders filled —
 * {{title}} is the note's name, {{date}} and {{time}} now. */
export function structuredNoteContent(spec: StructuredSpec, noteName: string, headingFormat: string, templateBody = ""): string {
	return applyTemplatePlaceholders(structuredNoteMarkdown(spec, templateBody), noteName, headingFormat);
}

/** The heading level a template note's cards live at: its shallowest heading, else `fallback`. */
export function templateNoteLevel(body: string, fallback: number): number {
	return headingLevelsIn(body.split(/\r?\n/))[0] ?? fallback;
}

/**
 * Custom Grid placements for a matrix note: the format's four sections as quadrants,
 * the Introduction as a band above them and Additional notes as one below, so nothing
 * lands in the tray. Null for formats that open on the wall or in columns.
 */
export function structuredPlacements(spec: StructuredSpec): Record<string, CardRect> | null {
	const def = structuredFormat(spec.format);
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
		contentEl.createEl("h3", { text: "New note from template" });

		let def: StructuredFormatDef | null = STRUCTURED_FORMATS[0];
		const spec: StructuredSpec = {
			format: def.id,
			level: 2,
			sections: def.sections.map((s) => s.title),
			intro: true,
			notes: true,
			hints: true,
		};
		let name = def.noteName;
		let nameTouched = false;
		const NOTE_DESC = "A copy of a note in the vault, its {{title}}, {{date}}, and {{time}} placeholders filled in.";

		let description!: HTMLElement;
		let nameInput!: HTMLInputElement;
		let sectionsInput!: HTMLInputElement;
		let levelDropdown!: { setValue: (v: string) => unknown };
		let templateRow!: Setting;
		let sectionsRow!: Setting;
		let hintsRow!: Setting;

		// The rows that only make sense for one kind of template.
		const syncRows = () => {
			const fromNote = spec.format === "note";
			templateRow.settingEl.toggleClass("is-hidden", !fromNote);
			sectionsRow.settingEl.toggleClass("is-hidden", fromNote);
			hintsRow.settingEl.toggleClass("is-hidden", fromNote);
		};

		new Setting(contentEl).setName("Template").addDropdown((dd) => {
			for (const f of STRUCTURED_FORMATS) dd.addOption(f.id, f.label);
			dd.addOption("note", "A note from the vault…");
			dd.setValue(def?.id ?? "note").onChange((value) => {
				def = structuredFormat(value as StructuredFormat | "note");
				spec.format = def?.id ?? "note";
				if (def) {
					spec.sections = def.sections.map((s) => s.title);
					sectionsInput.value = spec.sections.join(", ");
				}
				description.setText(def?.description ?? NOTE_DESC);
				if (!nameTouched && def) {
					name = def.noteName;
					nameInput.value = name;
				}
				syncRows();
			});
		});
		description = contentEl.createEl("p", { cls: "sfsc-structured-desc", text: def.description });

		templateRow = new Setting(contentEl)
			.setName("Template note")
			.setDesc("No note chosen yet.")
			.addButton((b) =>
				b.setButtonText("Choose…").onClick(() => {
					new FileSuggestModal(this.plugin.app, this.plugin, (path) => {
						spec.templatePath = path;
						templateRow.setDesc(path);
						const file = this.plugin.app.vault.getAbstractFileByPath(path);
						if (file instanceof TFile) {
							if (!nameTouched) {
								name = file.basename;
								nameInput.value = name;
							}
							// The copy's cards live where the template's headings do.
							void this.plugin.app.vault.cachedRead(file).then((body) => {
								spec.level = templateNoteLevel(body, spec.level);
								levelDropdown.setValue(String(spec.level));
							});
						}
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

		sectionsRow = new Setting(contentEl)
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
		hintsRow = new Setting(contentEl)
			.setName("Hints")
			.setDesc("One italic line under each heading saying what belongs there.")
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
							new Notice("Choose the note to copy.");
							return;
						}
						if (spec.format !== "note" && !structuredTitles(spec).length) {
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
