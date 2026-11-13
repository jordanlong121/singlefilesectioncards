// The Dashboard layout's numbers: one pass over a note for its outline, tasks, tags,
// links, and dates. Pure — the view draws what this returns.

import { Section, HEADING_RE, stepFence } from "./sections";
import { TASK_RE, taskDone, taskLineIndexes, DUE_DATE_RE, DONE_DATE_RE } from "./tasks";
import { bodyTextStats, titleToIso, heatmapStreaks } from "./dates";
import { sectionHasStar } from "./blocks";
import { imageLinksIn, urlLinksIn } from "./canvas";

/** A task line the Dashboard lists, with where it lives. */
export interface DashTask {
	/** The task's text without its checkbox, due date, or done date. */
	text: string;
	/** 0-based line in the note — what a click reveals. */
	line: number;
	due: string | null;
	/** The card it sits under (null above the first card heading). */
	section: string | null;
}

/** One card's line in the Dashboard's rankings. */
export interface DashSection {
	title: string;
	headingLine: number;
	words: number;
	open: number;
	done: number;
}

export interface NoteSummary {
	lines: number;
	words: number;
	/** Headings per level, index 1–6 (0 unused). */
	headings: number[];
	/** Cards at the card level. */
	sections: number;
	/** Cards with nothing written under their heading. */
	emptySections: number;
	open: number;
	done: number;
	overdue: DashTask[];
	dueToday: DashTask[];
	/** Open tasks due in the next seven days, after today. */
	upcoming: DashTask[];
	/** #tag → uses, most used first. */
	tags: [string, number][];
	starredSections: number;
	images: number;
	links: number;
	/** Distinct [[wikilinks]] to other notes. */
	wikilinks: number;
	/** Cards ranked by open tasks, then by words — the busiest first. */
	busiest: DashSection[];
	longest: DashSection[];
	/** Dated cards: first and last day, how many, and the streak through today. */
	dates: { first: string; last: string; count: number; current: number; longest: number; todayLine: number | null } | null;
}

const WIKILINK_RE = /(?<!!)\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** The words a task line says, without its marker and Tasks-style date fields. */
export function taskText(line: string): string {
	const m = TASK_RE.exec(line);
	const rest = m ? m[4] : line;
	return rest
		.replace(DONE_DATE_RE, "")
		.replace(/[[(]due::\s*\d{4}-\d{2}-\d{2}\s*[\])]/g, "")
		.replace(/📅\s*\d{4}-\d{2}-\d{2}/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Summarise a note for the Dashboard. `sections` are its cards at the view's level;
 * `lines` the whole note. Dates read from the card titles through `format`/`detect`
 * (pass dated = false for a note whose headings don't name days).
 */
export function summarizeNote(
	lines: string[],
	sections: Section[],
	opts: { todayIso: string; format: string; detect: string; dated: boolean; starEmoji: string },
): NoteSummary {
	const headings = [0, 0, 0, 0, 0, 0, 0];
	let fence: string | null = null;
	let inFrontmatter = lines[0]?.trim() === "---";
	for (let i = inFrontmatter ? 1 : 0; i < lines.length; i++) {
		const line = lines[i];
		if (inFrontmatter) {
			if (line.trim() === "---") inFrontmatter = false;
			continue;
		}
		const step = stepFence(line, fence);
		fence = step.open;
		if (step.marker || fence) continue;
		const h = HEADING_RE.exec(line);
		if (h) headings[h[1].length]++;
	}

	// Which card each line belongs to, for the task lists' "in …" captions.
	const owner = (line: number): string | null => {
		for (const s of sections) if (line >= s.startLine && line < s.endLine) return s.title;
		return null;
	};

	const soon = new Date(`${opts.todayIso}T00:00:00Z`);
	soon.setUTCDate(soon.getUTCDate() + 7);
	const soonIso = soon.toISOString().slice(0, 10);
	let open = 0;
	let done = 0;
	const overdue: DashTask[] = [];
	const dueToday: DashTask[] = [];
	const upcoming: DashTask[] = [];
	for (const i of taskLineIndexes(lines)) {
		const m = TASK_RE.exec(lines[i]);
		if (!m) continue;
		if (taskDone(m[2])) {
			done++;
			continue;
		}
		open++;
		const due = DUE_DATE_RE.exec(m[4])?.[1] ?? null;
		if (!due) continue;
		const task = { text: taskText(lines[i]), line: i, due, section: owner(i) };
		if (due < opts.todayIso) overdue.push(task);
		else if (due === opts.todayIso) dueToday.push(task);
		else if (due <= soonIso) upcoming.push(task);
	}
	const byDue = (a: DashTask, b: DashTask) => (a.due ?? "").localeCompare(b.due ?? "") || a.line - b.line;
	overdue.sort(byDue);
	upcoming.sort(byDue);

	const { words, tags } = bodyTextStats(lines);
	const content = lines.join("\n");
	const wikis = new Set<string>();
	for (const m of content.matchAll(WIKILINK_RE)) wikis.add(m[1].trim().toLowerCase());

	const ranked: DashSection[] = sections
		.filter((s) => !s.properties)
		.map((s) => {
			const body = s.body.split("\n");
			let o = 0;
			let d = 0;
			for (const i of taskLineIndexes(body)) {
				if (taskDone(TASK_RE.exec(body[i])?.[2])) d++;
				else o++;
			}
			return { title: s.title, headingLine: s.headingLine, words: bodyTextStats(body).words, open: o, done: d };
		});

	let dates: NoteSummary["dates"] = null;
	if (opts.dated) {
		const isoLine = new Map<string, number>();
		for (const s of sections) {
			const iso = titleToIso(s.title, opts.format, opts.detect);
			if (iso && !isoLine.has(iso)) isoLine.set(iso, s.headingLine);
		}
		if (isoLine.size) {
			const isos = [...isoLine.keys()].sort();
			const streaks = heatmapStreaks(isos, opts.todayIso);
			dates = {
				first: isos[0],
				last: isos[isos.length - 1],
				count: isos.length,
				current: streaks.current,
				longest: streaks.longest,
				todayLine: isoLine.get(opts.todayIso) ?? null,
			};
		}
	}

	return {
		lines: lines.length,
		words,
		headings,
		sections: sections.filter((s) => !s.properties).length,
		emptySections: sections.filter((s) => !s.unfiled && s.body.trim() === "").length,
		open,
		done,
		overdue,
		dueToday,
		upcoming,
		tags: Object.entries(tags).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
		starredSections: sections.filter((s) => sectionHasStar(s.body.split("\n"), opts.starEmoji)).length,
		images: imageLinksIn(content).length,
		links: urlLinksIn(content).length,
		wikilinks: wikis.size,
		busiest: ranked
			.filter((s) => s.open > 0)
			.sort((a, b) => b.open - a.open || b.words - a.words)
			.slice(0, 6),
		longest: ranked
			.filter((s) => s.words > 0)
			.sort((a, b) => b.words - a.words)
			.slice(0, 6),
		dates,
	};
}
