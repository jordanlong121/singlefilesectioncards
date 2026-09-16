// Document setup: what each heading level holds, and year/month/week/day period math.

import { validIsoDate, parseAncestorHeadings } from "./sections";
import { titleHasDate } from "./dates";

/* ---------- Document setup: what each heading level means in a note ---------- */

/** What a heading level holds: nothing, plain text (in document or alphanumeric order),
 * or a span of time — a year, a month, a week, or a day. */
export type LevelRole = "none" | "text" | "alpha" | "year" | "month" | "week" | "day";

export interface LevelSetup {
	role: LevelRole;
	/** Year/month/week: which of PERIOD_FORMATS[role] the titles are written in. Days use
	 * the note's new-card format. */
	format?: string;
}

/** Per heading level ("1"–"6"), as saved per note; missing levels fall back to detection. */
export type DocumentLevels = Record<string, LevelSetup>;

export const LEVEL_ROLE_LABELS: [LevelRole, string][] = [
	["none", "Not used"],
	["text", "Text — document order"],
	["alpha", "Text — alphanumeric sort"],
	["year", "Year"],
	["month", "Month"],
	["week", "Week"],
	["day", "Day"],
];

/** The title spellings the year/month/week roles understand (moment-style, for the
 * dialog's benefit; the parsing here is the plugin's own, so tests need no moment). */
export const PERIOD_FORMATS: Record<"year" | "month" | "week", string[]> = {
	year: ["YYYY"],
	month: ["MMMM YYYY", "MMM YYYY", "YYYY-MM"],
	week: ["[Week] W, YYYY", "[Week] W YYYY", "YYYY-[W]WW", "[Week of] YYYY-MM-DD"],
};

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** ISO weeks in a year: 53 when Jan 1 is a Thursday, or a Wednesday in a leap year. */
export function isoWeeksInYear(year: number): number {
	const jan1 = new Date(year, 0, 1).getDay();
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	return jan1 === 4 || (leap && jan1 === 3) ? 53 : 52;
}

/**
 * A title read as a period of the given role and format, as a canonical key that
 * sorts chronologically within the role: "YYYY", "YYYY-MM", "YYYY-Www", or — for the
 * "[Week of] YYYY-MM-DD" spelling — "D:YYYY-MM-DD". Null when it doesn't fit.
 */
export function parsePeriod(title: string, role: LevelRole, format: string): string | null {
	const t = title.trim();
	let m: RegExpExecArray | null;
	switch (role) {
		case "year":
			return /^\d{4}$/.test(t) ? t : null;
		case "month": {
			if (format === "YYYY-MM") {
				m = /^(\d{4})-(\d{2})$/.exec(t);
				return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2]}` : null;
			}
			m = /^([A-Za-z]+)\.? (\d{4})$/.exec(t);
			if (!m) return null;
			const word = m[1].toLowerCase();
			const index = MONTH_NAMES.findIndex((name) =>
				format === "MMM YYYY" ? name.slice(0, 3).toLowerCase() === word : name.toLowerCase() === word,
			);
			return index >= 0 ? `${m[2]}-${pad2(index + 1)}` : null;
		}
		case "week": {
			if (format === "[Week of] YYYY-MM-DD") {
				m = /^Week of (\d{4}-\d{2}-\d{2})$/i.exec(t);
				return m && validIsoDate(m[1]) ? `D:${m[1]}` : null;
			}
			m = format === "YYYY-[W]WW" ? /^(\d{4})-W(\d{1,2})$/i.exec(t) : /^Week (\d{1,2}),? (\d{4})$/i.exec(t);
			if (!m) return null;
			const [year, week] = format === "YYYY-[W]WW" ? [Number(m[1]), Number(m[2])] : [Number(m[2]), Number(m[1])];
			return week >= 1 && week <= isoWeeksInYear(year) ? `${year}-W${pad2(week)}` : null;
		}
		default:
			return null;
	}
}

/** The key `delta` periods on from `key` (same role). */
export function shiftPeriod(key: string, role: LevelRole, delta: number): string {
	switch (role) {
		case "year":
			return String(Number(key) + delta);
		case "month": {
			const total = Number(key.slice(0, 4)) * 12 + (Number(key.slice(5, 7)) - 1) + delta;
			return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
		}
		case "week": {
			if (key.startsWith("D:")) {
				const iso = key.slice(2);
				const dt = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + 7 * delta);
				return `D:${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
			}
			let year = Number(key.slice(0, 4));
			let week = Number(key.slice(6)) + delta;
			while (week < 1) week += isoWeeksInYear(--year);
			while (week > isoWeeksInYear(year)) week -= isoWeeksInYear(year++);
			return `${year}-W${pad2(week)}`;
		}
		default:
			return key;
	}
}

/** A key written back as a title in the given format. */
export function formatPeriod(key: string, role: LevelRole, format: string): string {
	switch (role) {
		case "year":
			return key;
		case "month": {
			const name = MONTH_NAMES[Number(key.slice(5, 7)) - 1] ?? "";
			if (format === "YYYY-MM") return key;
			if (format === "MMM YYYY") return `${name.slice(0, 3)} ${key.slice(0, 4)}`;
			return `${name} ${key.slice(0, 4)}`;
		}
		case "week": {
			if (key.startsWith("D:")) return `Week of ${key.slice(2)}`;
			const year = key.slice(0, 4);
			const week = Number(key.slice(6));
			if (format === "YYYY-[W]WW") return `${year}-W${pad2(week)}`;
			if (format === "[Week] W YYYY") return `Week ${week} ${year}`;
			return `Week ${week}, ${year}`;
		}
		default:
			return key;
	}
}

/** A title that is nothing but a month name ("August", "Aug"): its month, 1–12, else 0. */
export function bareMonthIndex(title: string): number {
	const word = title.trim().replace(/\.$/, "").toLowerCase();
	if (!word) return 0;
	const index = MONTH_NAMES.findIndex((name) => name.toLowerCase() === word || name.slice(0, 3).toLowerCase() === word);
	return index + 1;
}

/** The unit word for prompts: "day", "week", "month", "year". */
export function periodUnit(role: LevelRole): string {
	return role === "year" || role === "month" || role === "week" || role === "day" ? role : "card";
}

/**
 * What each heading level of a note looks like it holds, for the Document setup
 * dialog's defaults and for notes that never opened it. A level with headings is
 * "text" (document order) — unless the note deals in dates, when at least half its
 * titles reading as days (the note's new-card format), years, months, or weeks (any
 * spelling in PERIOD_FORMATS) makes it that role. Levels with no headings are "none".
 */
export function detectLevelSetup(lines: string[], cardFormat: string, detect: string, dated: boolean): DocumentLevels {
	const titles: string[][] = [[], [], [], [], [], [], []];
	for (const h of parseAncestorHeadings(lines, 7)) titles[h.level].push(h.title);
	const out: DocumentLevels = {};
	for (let level = 1; level <= 6; level++) {
		const sample = titles[level].slice(0, 40);
		if (!sample.length) {
			out[String(level)] = { role: "none" };
			continue;
		}
		let setup: LevelSetup = { role: "text" };
		if (dated) {
			const need = Math.ceil(sample.length / 2);
			if (sample.filter((t) => titleHasDate(t, cardFormat, detect)).length >= need) {
				setup = { role: "day" };
			} else {
				outer: for (const role of ["year", "month", "week"] as const) {
					for (const format of PERIOD_FORMATS[role]) {
						if (sample.filter((t) => parsePeriod(t, role, format) !== null).length >= need) {
							setup = { role, format };
							break outer;
						}
					}
				}
			}
		}
		out[String(level)] = setup;
	}
	return out;
}
