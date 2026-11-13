// Dates in headings: today matching, detection, ISO conversion, heatmap days and streaks.

import { moment } from "obsidian";
import { Section, moParse, ISO_DATE_RE, validIsoDate, parseAncestorHeadings, stepFence } from "./sections";
import { TASK_RE, taskDone, taskLineIndexes } from "./tasks";
import type { CalendarRange, HeatMetric, HeatRange } from "./settings";

/**
 * Does a date heading refer to today? Matches an ISO date anywhere in the heading
 * (`### 2026-08-06, Thursday`) or the heading format configured for new cards
 * (so `### Thursday, August 6` works if that's how the note is written).
 */
export function isTodayTitle(title: string, todayISO: string, todayFormatted: string): boolean {
	if (title.includes(todayISO)) return true;
	const formatted = todayFormatted.trim().toLowerCase();
	if (formatted.length <= 3) return false;
	// Whole words only: "6 August 2026" is the end of "16 August 2026" and "26 August
	// 2026", and "October 1" the start of "October 10" — a substring test would mark
	// those days today too.
	const lower = title.toLowerCase();
	const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
	for (let at = lower.indexOf(formatted); at >= 0; at = lower.indexOf(formatted, at + 1)) {
		if (!isWordChar(lower[at - 1]) && !isWordChar(lower[at + formatted.length])) return true;
	}
	return false;
}

/** A parsed date plus the [start, end) span of the title's characters that spelled it,
 * so a retitle can swap just those characters and keep the rest of the title. */
export interface TitleDateMatch {
	parsed: { format: (f: string) => string };
	start: number;
	end: number;
	/** The moment format the span was parsed with — how a new date should be written back. */
	core: string;
}

/** The [start, end) offsets of each of a title's first `max` words (whitespace-delimited). */
export function wordSpans(title: string, max: number): { start: number; end: number }[] {
	const spans: { start: number; end: number }[] = [];
	const re = /\S+/g;
	let m: RegExpExecArray | null;
	while (spans.length < max && (m = re.exec(title)) !== null) {
		spans.push({ start: m.index, end: m.index + m[0].length });
	}
	return spans;
}

/** How words are trimmed when a window leaves punctuation at a candidate's edge. */
export const EDGE_PUNCT_RE = /^[\s,;:–—-]+|[\s,;:–—-]+$/gu;

/**
 * Strict-parse a title against the heading format: the whole title, or a prefix
 * ending at a word boundary — a heading that STARTS with a date is a date heading,
 * so "August 26, 2026 — review" (format "MMMM D, YYYY") still reads as its date.
 * Longest prefix wins; trailing punctuation on a prefix is forgiven.
 */
export function titleFormatDate(title: string, format: string): TitleDateMatch | null {
	const trimmed = format.trim();
	if (!trimmed) return null;
	const words = wordSpans(title, 8);
	for (let n = words.length - 1; n >= 0; n--) {
		const lead = words[0].start;
		const raw = title.slice(lead, words[n].end).replace(/[\s,;:–—-]+$/u, "");
		const parsed = moParse(raw.replace(/\s+/g, " "), trimmed, true);
		if (parsed.isValid()) return { parsed, start: lead, end: lead + raw.length, core: trimmed };
	}
	return null;
}

/**
 * Parse a title against the user's date-detection pattern (settings → "Date
 * detection format"): a moment format optionally wrapped in `*` wildcards that
 * stand for arbitrary text before and/or after the date. `*MMMM D, YYYY*` finds
 * the date anywhere; without a `*`, that side of the title must end with it.
 */
export function titleDetectSpan(title: string, pattern: string): TitleDateMatch | null {
	const trimmed = pattern.trim();
	if (!trimmed) return null;
	const leading = trimmed.startsWith("*");
	const trailing = trimmed.endsWith("*");
	const core = trimmed.replace(/^\*+/, "").replace(/\*+$/, "").trim();
	if (!core) return null;
	const words = wordSpans(title, Number.MAX_SAFE_INTEGER);
	const maxStart = leading ? Math.min(words.length - 1, 11) : 0;
	for (let start = 0; start <= maxStart; start++) {
		// Candidate word-windows: any length up to 8 with a trailing wildcard,
		// otherwise the window must reach the title's end.
		const windowEnds: number[] = [];
		if (trailing) {
			for (let end = Math.min(words.length, start + 8); end > start; end--) windowEnds.push(end);
		} else if (words.length - start <= 8) {
			windowEnds.push(words.length);
		}
		for (const end of windowEnds) {
			const raw = title.slice(words[start].start, words[end - 1].end);
			// Edge punctuation a wildcard left behind sits outside the date's span.
			const lead = /^[\s,;:–—-]*/u.exec(raw)![0].length;
			const candidate = raw.replace(EDGE_PUNCT_RE, "");
			if (!candidate) continue;
			const parsed = moParse(candidate.replace(/\s+/g, " "), core, true);
			if (parsed.isValid()) {
				const from = words[start].start + lead;
				return { parsed, start: from, end: from + candidate.length, core };
			}
		}
	}
	return null;
}

/** The date the custom detection pattern finds in a title, if any (see titleDetectSpan). */
export function titleDetectDate(title: string, pattern: string): { format: (f: string) => string } | null {
	return titleDetectSpan(title, pattern)?.parsed ?? null;
}

/** Does a heading title look like a date: a real ISO date anywhere, the new-card format
 * as the whole title or its leading words, or the custom detection pattern? */
export function titleHasDate(title: string, format: string, detect = ""): boolean {
	return titleToIso(title, format, detect) !== null;
}

/** titleToIso results, memoized: dateHeadingCounts re-asks for every heading on every
 * refresh, and moment's strict parsing is what a big custom-format note actually pays
 * (~15ms per refresh at 500 headings). The answer is a pure function of the inputs
 * (plus moment's locale, which is part of the key), so the cache never goes stale;
 * it just resets wholesale if it ever fills. */
export const titleIsoCache = new Map<string, string | null>();

export const TITLE_ISO_CACHE_MAX = 8192;

/** The date a heading names, as YYYY-MM-DD: a valid ISO date anywhere in the title wins,
 * then the heading format at the title's start, then the custom detection pattern. */
/** The placement key for a note's titles: the ISO day a title names (by the note's
 * heading format, or the detect pattern), else the title itself. */
export function titleSortKey(format: string, detect = ""): (title: string) => string {
	return (title) => titleToIso(title, format, detect) ?? title;
}

export function titleToIso(title: string, format: string, detect = ""): string | null {
	const iso = ISO_DATE_RE.exec(title)?.[0];
	if (iso && validIsoDate(iso)) return iso;
	const locale = (moment as unknown as { locale?: () => string }).locale?.() ?? "";
	const key = `${locale}\u0000${format}\u0000${detect}\u0000${title}`;
	const hit = titleIsoCache.get(key);
	if (hit !== undefined || titleIsoCache.has(key)) return hit ?? null;
	const result = (titleFormatDate(title, format) ?? titleDetectSpan(title, detect))?.parsed.format("YYYY-MM-DD") ?? null;
	if (titleIsoCache.size >= TITLE_ISO_CACHE_MAX) titleIsoCache.clear();
	titleIsoCache.set(key, result);
	return result;
}

/**
 * The title after a card is moved to another day (Calendar drag). Whichever spelling
 * placed the card on the calendar — the heading format at the title's start, a raw ISO
 * date anywhere, or the custom detection pattern — is swapped for the new day in that
 * same spelling; the rest of the title stays. A title whose date can't be located is
 * replaced with the new day in the heading format.
 */
export function retitledDateTitle(title: string, format: string, iso: string, detect = ""): string {
	const to = moParse(iso, "YYYY-MM-DD", true);
	const t = title.trim();
	const old = titleFormatDate(t, format);
	if (old) return to.format(format) + t.slice(old.end);
	const rawIso = ISO_DATE_RE.exec(t)?.[0];
	if (rawIso) {
		let out = t.replace(rawIso, iso);
		// A weekday word naming the old day follows the date to the new one.
		const from = moParse(rawIso, "YYYY-MM-DD", true);
		const oldDow = from.isValid() ? from.format("dddd") : "";
		if (/^[\p{L}]+$/u.test(oldDow)) {
			const dowRe = new RegExp(`(?<![\\p{L}])${oldDow}(?![\\p{L}])`, "u");
			if (dowRe.test(out)) out = out.replace(dowRe, to.format("dddd"));
		}
		return out;
	}
	const det = titleDetectSpan(t, detect);
	if (det) return t.slice(0, det.start) + to.format(det.core) + t.slice(det.end);
	return to.format(format);
}

/** One day's activity on the Heatmap: task tallies, words, #tags, and where its
 * section lives (with its text, for the hover preview). */
export interface HeatDay {
	done: number;
	open: number;
	words: number;
	/** #tag (lowercased, without the #) → how many times the day's text uses it. */
	tags: Record<string, number>;
	headingLine: number;
	title: string;
	body: string;
}

/** A #tag the way Obsidian reads one: after a space, a bracket, or a line start, and
 * with at least one non-digit (#2026 is not a tag). */
const BODY_TAG_RE = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gu;
/** A word: any run without whitespace holding a letter or digit — list markers,
 * checkboxes, and lone punctuation don't count. */
const WORD_RE = /[\p{L}\p{N}]/u;

/** Words and #tags in a body's text, skipping fenced code like every other tally. */
export function bodyTextStats(lines: string[]): { words: number; tags: Record<string, number> } {
	let words = 0;
	const tags: Record<string, number> = {};
	let fence: string | null = null;
	for (const line of lines) {
		const step = stepFence(line, fence);
		fence = step.open;
		if (step.marker || fence) continue;
		// A list marker and its checkbox (`- [x]`) are markup, not words.
		const text = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/, "");
		for (const token of text.split(/\s+/)) if (WORD_RE.test(token)) words++;
		if (!line.includes("#")) continue;
		BODY_TAG_RE.lastIndex = 0;
		for (let m = BODY_TAG_RE.exec(line); m; m = BODY_TAG_RE.exec(line)) {
			if (/^[\d/_-]+$/.test(m[2])) continue;
			const tag = m[2].toLowerCase();
			tags[tag] = (tags[tag] ?? 0) + 1;
		}
	}
	return { words, tags };
}

/** The Heatmap's data: every dated section's day, with its tallies. Two sections
 * naming the same day pool their counts (the first one keeps the click). */
export function heatmapDays(sections: Section[], format: string, detect = ""): Map<string, HeatDay> {
	const days = new Map<string, HeatDay>();
	for (const section of sections) {
		const iso = titleToIso(section.title, format, detect);
		if (!iso) continue;
		let done = 0;
		let open = 0;
		// taskLineIndexes is the fence-aware scanner every other tally uses — a
		// `- [ ]` sitting inside a code block is text, not a task.
		const lines = section.body.split("\n");
		for (const i of taskLineIndexes(lines)) {
			if (!taskDone(TASK_RE.exec(lines[i])?.[2])) open++;
			else done++;
		}
		const { words, tags } = bodyTextStats(lines);
		const day = days.get(iso);
		if (day) {
			day.done += done;
			day.open += open;
			day.words += words;
			for (const [tag, n] of Object.entries(tags)) day.tags[tag] = (day.tags[tag] ?? 0) + n;
			day.body = day.body ? `${day.body}\n\n${section.body}` : section.body;
		} else {
			days.set(iso, { done, open, words, tags, headingLine: section.headingLine, title: section.title, body: section.body });
		}
	}
	return days;
}

/** What a Heatmap cell counts for a day under the chosen metric. */
export function heatValue(day: HeatDay, metric: HeatMetric, tag = ""): number {
	if (metric === "tasks") return day.done + day.open;
	if (metric === "words") return day.words;
	if (metric === "tag") return day.tags[tag.toLowerCase()] ?? 0;
	return day.done;
}

/** Shade 0–4 for a cell: 0 no card, 1 a card that counts nothing, 2–4 by share of the max. */
export function heatLevel(day: HeatDay | undefined, value: number, max: number): number {
	if (!day) return 0;
	if (value <= 0) return 1;
	return Math.min(4, 1 + Math.ceil((3 * value) / Math.max(1, max)));
}

/** Every #tag the dated days use, most used first (ties A→Z). */
export function heatmapTags(days: Iterable<HeatDay>): string[] {
	const totals = new Map<string, number>();
	for (const day of days) for (const [tag, n] of Object.entries(day.tags)) totals.set(tag, (totals.get(tag) ?? 0) + n);
	return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
}

/** The first and last ISO day of the period holding `anchor`. "all" spans the note's
 * first dated day through its last or today, whichever is later. */
export function heatRangeSpan(range: HeatRange, anchor: string, first: string, last: string): { start: string; end: string } {
	if (range === "all") return { start: first, end: last };
	const [y, m] = anchor.split("-").map(Number);
	const iso = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
	if (range === "year") return { start: iso(y, 1, 1), end: iso(y, 12, 31) };
	if (range === "quarter") {
		const q = Math.floor((m - 1) / 3) * 3 + 1;
		return { start: iso(y, q, 1), end: iso(y, q + 3, 0) };
	}
	return { start: iso(y, m, 1), end: iso(y, m + 1, 0) };
}

/** The anchor moved one period back (-1) or forward (+1). Lands on the 1st, so a
 * 31st never spills into the month after next. */
export function shiftHeatAnchor(anchor: string, range: HeatRange, delta: number): string {
	if (range === "all") return anchor;
	const [y, m] = anchor.split("-").map(Number);
	const months = range === "year" ? 12 : range === "quarter" ? 3 : 1;
	return new Date(Date.UTC(y, m - 1 + delta * months, 1)).toISOString().slice(0, 10);
}

/** The period's name in the Heatmap's header: "2026", "Q3 2026", "August 2026". */
export function heatRangeLabel(range: HeatRange, anchor: string): string {
	const [y, m] = anchor.split("-").map(Number);
	if (range === "year") return String(y);
	if (range === "quarter") return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
	if (range === "month") return moParse(anchor, "YYYY-MM-DD", true).format("MMMM YYYY");
	return "All days";
}

/** The ISO day before/after, in UTC so DST can never skip or double a day. */
export function shiftIso(iso: string, delta: number): string {
	const date = new Date(`${iso}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + delta);
	return date.toISOString().slice(0, 10);
}

/** The weekday an ISO day falls on, 0 = Sunday … 6 = Saturday. Built locally: a
 * calendar date's weekday, not an instant, so no UTC skew can shift it a day. */
export function isoDow(iso: string): number {
	const [y, m, d] = iso.split("-").map(Number);
	return new Date(y, m - 1, d).getDay();
}

/** Saturday or Sunday — the pair the Calendar's Week range lays along the bottom. */
export function isWeekendIso(iso: string): boolean {
	const dow = isoDow(iso);
	return dow === 0 || dow === 6;
}

/** The ISO day the week holding `iso` starts on, where `firstDow` is the weekday the
 * week starts on (0 = Sunday, 1 = Monday, …) — the Calendar's Week range anchors here. */
export function weekStartIso(iso: string, firstDow: number): string {
	const back = (((isoDow(iso) - firstDow) % 7) + 7) % 7;
	return shiftIso(iso, -back);
}

/** The seven ISO days of the week holding `iso`, in order from the week's first day. */
export function weekDays(iso: string, firstDow: number): string[] {
	const start = weekStartIso(iso, firstDow);
	return Array.from({ length: 7 }, (_, i) => shiftIso(start, i));
}

/** The ISO days a Calendar range shows around its anchor: the anchor's week and the
 * one after it (2 weeks), the anchor's week, or the anchor alone. Month has no single
 * range — its grid holds every month — so it has no days here. */
export function calendarRangeDays(anchor: string, range: CalendarRange, firstDow: number): string[] {
	if (range === "day") return [anchor];
	if (range === "week") return weekDays(anchor, firstDow);
	if (range === "2weeks") return [...weekDays(anchor, firstDow), ...weekDays(shiftIso(anchor, 7), firstDow)];
	return [];
}

/** How many days one step of a range's arrows (or , and .) moves: a day for Day, and
 * a week for Week — and for 2 weeks too, so each step keeps a week in view. */
export function calendarRangeStep(range: CalendarRange): number {
	return range === "day" ? 1 : 7;
}

/** An ISO day held inside a span (both ends inclusive); either end may be missing. */
export function clampIso(iso: string, min?: string, max?: string): string {
	if (min && iso < min) return min;
	if (max && iso > max) return max;
	return iso;
}

/** Current and longest runs of consecutive days with cards. The current streak
 * forgives a today that hasn't been written yet (it counts through yesterday). */
export function heatmapStreaks(isoDays: Iterable<string>, todayIso: string): { current: number; longest: number } {
	const days = new Set(isoDays);
	let longest = 0;
	let run = 0;
	let prev: string | null = null;
	for (const iso of [...days].sort()) {
		run = prev !== null && shiftIso(prev, 1) === iso ? run + 1 : 1;
		if (run > longest) longest = run;
		prev = iso;
	}
	let cursor: string | null = days.has(todayIso) ? todayIso : days.has(shiftIso(todayIso, -1)) ? shiftIso(todayIso, -1) : null;
	let current = 0;
	while (cursor && days.has(cursor)) {
		current++;
		cursor = shiftIso(cursor, -1);
	}
	return { current, longest };
}

export function dateHeadingCounts(lines: string[], format: string, detect = ""): number[] {
	const counts = [0, 0, 0, 0, 0, 0, 0];
	// Level 7 keeps nothing out: every real heading (1–6) comes back, each seen once.
	for (const h of parseAncestorHeadings(lines, 7)) {
		if (titleHasDate(h.title, format, detect)) counts[h.level]++;
	}
	return counts;
}

/** The heading level whose headings name days — where the Calendar layout finds its
 * cards. The level with the most date-looking headings wins; null when none has any. */
export function dateHeadingLevel(lines: string[], format: string, detect = ""): number | null {
	return bestDateLevel(dateHeadingCounts(lines, format, detect));
}

/** The level with the most date headings in a dateHeadingCounts tally (ties go shallower). */
export function bestDateLevel(counts: number[]): number | null {
	let best: number | null = null;
	let bestCount = 0;
	for (let level = 1; level <= 6; level++) {
		if (counts[level] > bestCount) {
			best = level;
			bestCount = counts[level];
		}
	}
	return best;
}
