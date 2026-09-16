// Task lines: counts, due dates, toggling (with the Tasks plugin's API when present).

import { App, TFile } from "obsidian";
import { SortOrder } from "./settings";
import { Section, FENCE_RE, sortSections, bodyStartLine, locateCard } from "./sections";
import { titleToIso } from "./dates";

/** The slice of the Tasks community plugin's public API this plugin uses. */
export interface TasksApiV1 {
	/** Opens the Tasks "create task" dialog; resolves to the task line ("" on cancel). */
	createTaskLineModal(): Promise<string>;
	/** Toggles a task line with Tasks semantics (recurrence, done dates); may return
	 * several lines, or the input unchanged when it declines. */
	executeToggleTaskDoneCommand(line: string, path: string): string;
}

/** The first #tag in a section's body, lowercased — the Tasks layout's second sort key. */
export function firstBodyTag(body: string): string | null {
	const m = /(^|[\s(])#([A-Za-z][\w/-]*)/.exec(body);
	return m ? m[2].toLowerCase() : null;
}

/**
 * Tasks layout order: by the heading's date first, then by the body's first #tag,
 * then by title — so dated cards run chronologically and undated ones cluster by
 * tag after them. desc flips the whole ordering; doc keeps the note's own.
 */
export function sortTasksLayout(sections: Section[], format: string, detect: string, order: SortOrder): Section[] {
	if (order === "doc") return sections;
	// The count sorts replace the date/tag ordering outright.
	if (order === "count-asc" || order === "count-desc") return sortSections(sections, order);
	// "~" outsorts dates and word characters, so missing keys go last (in asc).
	const keys = new Map(
		sections.map((s) => [
			s,
			`${titleToIso(s.title, format, detect) ?? "~~~~~"} | ${firstBodyTag(s.body) ?? "~~~~~"} | ${(s.title || "").toLowerCase()}`,
		]),
	);
	const dir = order === "asc" ? 1 : -1;
	return [...sections].sort((a, b) => {
		const ka = keys.get(a) ?? "";
		const kb = keys.get(b) ?? "";
		return ka === kb ? 0 : dir * (ka < kb ? -1 : 1);
	});
}

/** `- [ ] text`, `* [x] text`, `1. [ ] text` — prefix, mark, closing bracket, text. */
export const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])(.*)$/;

export const DONE_DATE_RE = /\s*✅\s*\d{4}-\d{2}-\d{2}/g;

/**
 * Indexes of the task lines in `lines`, in document order and skipping fenced code —
 * the same order and set that MarkdownRenderer turns into checkboxes.
 */
/** Due dates on task lines: Tasks' 📅 emoji, or a Dataview `[due:: …]` / `(due:: …)` field. */
export const DUE_DATE_RE = /(?:📅\s*|[[(]due::\s*)(\d{4}-\d{2}-\d{2})/u;

/** How many OPEN tasks in a body are overdue (due before today) or due today. */
export function dueTaskSummary(body: string, todayIso: string): { overdue: number; dueToday: number } {
	let overdue = 0;
	let dueToday = 0;
	if (!body.includes("📅") && !body.includes("due::")) return { overdue, dueToday };
	for (const line of body.split("\n")) {
		const m = TASK_RE.exec(line);
		if (!m || m[2] !== " ") continue;
		const due = DUE_DATE_RE.exec(m[4])?.[1];
		if (!due) continue;
		if (due < todayIso) overdue++;
		else if (due === todayIso) dueToday++;
	}
	return { overdue, dueToday };
}

/**
 * Which of a body's task lines (by position among taskLineIndexes, i.e. the nth
 * rendered checkbox) the due badge should lead to: the first open task overdue as of
 * `todayIso`, else the first due today. Null when none.
 */
export function firstDueTaskIndex(body: string, todayIso: string): number | null {
	const lines = body.split("\n");
	let dueToday: number | null = null;
	const indexes = taskLineIndexes(lines);
	for (let n = 0; n < indexes.length; n++) {
		const m = TASK_RE.exec(lines[indexes[n]]);
		if (!m || m[2] !== " ") continue;
		const due = DUE_DATE_RE.exec(m[4])?.[1];
		if (!due) continue;
		if (due < todayIso) return n;
		if (due === todayIso && dueToday === null) dueToday = n;
	}
	return dueToday;
}

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
export async function toggleTaskInFile(
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
export async function toggleTaskWithTasksApi(
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
