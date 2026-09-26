// Calendar feeds: a day's events from an iCal (.ics) feed, written as lines under a
// heading in that day's card. One way only — the feed is read, never written.

import ICAL from "ical.js";
import { HEADING_RE } from "./sections";
import { flipMarkerLine } from "./blocks";

/** One event's appearance on the day asked for. */
export interface FeedEvent {
	/** Identifies this occurrence across refreshes: the event's UID, and for a repeating
	 * event which occurrence it is. Hashed into the line's block id. */
	key: string;
	title: string;
	allDay: boolean;
	/** Timed events: the instants, local to this machine. All-day: unset. */
	start?: Date;
	end?: Date;
	/** A timed event that began on an earlier day, or runs on past midnight. */
	startsBefore: boolean;
	endsAfter: boolean;
}

/** The tag a feed line carries at its end, so a refresh knows which lines are the
 * feed's to replace. An Obsidian block id: hidden in reading view, harmless in source. */
export const FEED_TAG_RE = /\s\^ical-([a-z0-9]+)\s*$/;

/** Iterations allowed per repeating event, so a pathological rule (every minute since
 * 1990) can't hang the view; far past anything a real calendar needs. */
const MAX_OCCURRENCES = 50_000;

/**
 * The events a feed has on one day, in the order they should be listed: all-day
 * events first, then by start time, then by title. Handles repeating events (their
 * rules, skipped dates, and occurrences moved or cancelled one at a time), multi-day
 * and overnight events, and the feed's own time zones. Cancelled events are left out.
 * Throws when the text isn't iCalendar at all.
 */
export function feedDayEvents(ics: string, dayIso: string): FeedEvent[] {
	// ICAL.parse is typed `any`; one VCALENDAR parses to one jCal component array.
	const root = new ICAL.Component(ICAL.parse(ics) as unknown[]);
	// The feed's zones first, so every TZID it uses resolves (Google's carry their own).
	for (const zone of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(zone);

	const [y, m, d] = dayIso.split("-").map(Number);
	const dayStart = new Date(y, m - 1, d);
	const dayEnd = new Date(y, m - 1, d + 1);
	const nextIso = isoOf(dayEnd);

	// Occurrences moved or cancelled one at a time arrive as their own VEVENTs, sharing
	// the series' UID with a RECURRENCE-ID. They're related to their series (so it skips
	// them) and then judged on their own dates, wherever they were moved to.
	const series = new Map<string, ICAL.Event>();
	const singles: ICAL.Event[] = [];
	const exceptions: ICAL.Event[] = [];
	for (const component of root.getAllSubcomponents("vevent")) {
		const event = new ICAL.Event(component);
		if (event.isRecurrenceException()) exceptions.push(event);
		else if (event.isRecurring()) series.set(event.uid, event);
		else singles.push(event);
	}
	for (const exception of exceptions) series.get(exception.uid)?.relateException(exception);

	const out: FeedEvent[] = [];
	const consider = (event: ICAL.Event, start: ICAL.Time, end: ICAL.Time, recurrence: ICAL.Time | null) => {
		if (cancelled(event)) return;
		const key = `${event.uid}|${recurrence ? recurrence.toString() : ""}`;
		const title = (event.summary || "").trim() || "(no title)";
		if (start.isDate) {
			// All-day: dates, end exclusive; a missing or empty span means the one day.
			const from = start.toString();
			const to = end && end.compare(start) > 0 ? end.toString() : isoOf(dayAfter(from));
			if (from <= dayIso && dayIso < to) out.push({ key, title, allDay: true, startsBefore: false, endsAfter: false });
			return;
		}
		const s = start.toJSDate();
		const e = end && end.compare(start) > 0 ? end.toJSDate() : s;
		// A zero-length event belongs to the day it starts on; anything else to every
		// day it overlaps.
		const overlaps = e > s ? s < dayEnd && e > dayStart : s >= dayStart && s < dayEnd;
		if (!overlaps) return;
		out.push({ key, title, allDay: false, start: s, end: e, startsBefore: s < dayStart, endsAfter: e > dayEnd });
	};

	for (const event of singles) consider(event, event.startDate, event.endDate, null);
	for (const event of exceptions) consider(event, event.startDate, event.endDate, event.recurrenceId);
	for (const event of series.values()) {
		const expand = event.iterator();
		// Occurrences are walked from the series' start until one begins after the day
		// ends; a long event that began earlier still overlaps, so the stop is on the
		// start alone. The day after is compared as a date for all-day series.
		for (let n = 0, next = expand.next(); next && n < MAX_OCCURRENCES; n++, next = expand.next()) {
			if (next.isDate ? next.toString() >= nextIso : next.toJSDate() >= dayEnd) break;
			const details = event.getOccurrenceDetails(next);
			// A moved occurrence is its exception's to report, on its own dates.
			if (details.item !== event) continue;
			consider(event, details.startDate, details.endDate, details.recurrenceId);
		}
	}

	return out.sort(
		(a, b) =>
			Number(b.allDay) - Number(a.allDay) ||
			(a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0) ||
			a.title.localeCompare(b.title),
	);
}

function cancelled(event: ICAL.Event): boolean {
	return String(event.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";
}

function isoOf(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayAfter(iso: string): Date {
	const [y, m, d] = iso.split("-").map(Number);
	return new Date(y, m - 1, d + 1);
}

/** A 24-hour "HH:MM", the leading-time spelling the Day Planner and Tasks users write. */
function hhmm(date: Date): string {
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The block id a feed event's line carries: a short, stable hash of its key. */
export function feedEventTag(key: string): string {
	// FNV-1a, 32-bit: collisions within one day's handful of events are not a concern.
	let hash = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `ical-${(hash >>> 0).toString(36).padStart(7, "0")}`;
}

/**
 * An event as a line: its time span and title, as a bullet or an open task, tagged
 * with its block id. "09:00–09:30 Stand-up"; "All day: Holiday"; an event that began
 * the day before reads "…–10:00", one that runs on past midnight "22:00–…".
 */
export function feedEventLine(event: FeedEvent, asTask: boolean): string {
	let when: string;
	if (event.allDay || !event.start || !event.end) when = "All day:";
	else if (event.end.getTime() === event.start.getTime()) when = hhmm(event.start);
	else when = `${event.startsBefore ? "…" : hhmm(event.start)}–${event.endsAfter ? "…" : hhmm(event.end)}`;
	return `${asTask ? "- [ ] " : "- "}${when} ${event.title} ^${feedEventTag(event.key)}`;
}

/**
 * A card's body with its feed heading's lines replaced: `lines` (from feedEventLine)
 * become the heading's feed lines. Lines under the heading without a feed tag are the
 * user's and stay, after the feed's. A task line keeps its tick when its event is
 * still there. The heading is found at any level below the card's, case-insensitively;
 * missing, it's added at the end of the card's front (before a Card Flip marker) —
 * but only when there's something to put under it. Returns null when nothing changes.
 */
export function mergeFeedLines(
	body: string[],
	cardLevel: number,
	heading: string,
	lines: string[],
	flipMarker: string,
): string[] | null {
	const want = heading.trim().toLowerCase();
	if (!want) return null;
	const markerAt = flipMarkerLine(body, flipMarker);
	const frontEnd = markerAt < 0 ? body.length : markerAt;

	// Find the heading on the front, skipping fenced code.
	let at = -1;
	let level = 0;
	let fence: string | null = null;
	for (let i = 0; i < frontEnd; i++) {
		const open = /^\s*(`{3,}|~{3,})/.exec(body[i]);
		if (fence) {
			if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
			continue;
		}
		if (open) {
			fence = open[1];
			continue;
		}
		const h = HEADING_RE.exec(body[i]);
		if (h && h[1].length > cardLevel && h[2].trim().toLowerCase() === want) {
			at = i;
			level = h[1].length;
			break;
		}
	}

	if (at < 0) {
		if (!lines.length) return null;
		const subLevel = Math.min(6, cardLevel + 1);
		let end = frontEnd;
		while (end > 0 && body[end - 1].trim() === "") end--;
		const block = [...(end > 0 ? [""] : []), `${"#".repeat(subLevel)} ${heading.trim()}`, ...lines];
		// The blank lines the front ended with — the gap before the next card's heading,
		// or before the flip marker — stay after the new block; a marker gets one anyway.
		const trailing = body.slice(end, frontEnd);
		const rest = body.slice(frontEnd);
		return [...body.slice(0, end), ...block, ...(rest.length && !trailing.length ? [""] : trailing), ...rest];
	}

	// The heading's extent: up to the next heading at its level or above, the flip
	// marker, or the body's end.
	let stop = frontEnd;
	fence = null;
	for (let i = at + 1; i < frontEnd; i++) {
		const open = /^\s*(`{3,}|~{3,})/.exec(body[i]);
		if (fence) {
			if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
			continue;
		}
		if (open) {
			fence = open[1];
			continue;
		}
		const h = HEADING_RE.exec(body[i]);
		if (h && h[1].length <= level) {
			stop = i;
			break;
		}
	}
	const inside = body.slice(at + 1, stop);
	// Keep the blank lines that separated the section from what follows.
	let tail = inside.length;
	while (tail > 0 && inside[tail - 1].trim() === "") tail--;
	const trailingBlanks = inside.slice(tail);
	const content = inside.slice(0, tail);

	// Ticks the user gave feed tasks, by tag, carried onto the same events' new lines.
	const ticks = new Map<string, string>();
	const own: string[] = [];
	for (const line of content) {
		const tag = FEED_TAG_RE.exec(line);
		if (!tag) {
			own.push(line);
			continue;
		}
		const box = /^\s*[-*+]\s+\[(.)\]/.exec(line);
		if (box && box[1] !== " ") ticks.set(tag[1], box[1]);
	}
	while (own.length && own[0].trim() === "") own.shift();
	const fresh = lines.map((line) => {
		const tag = FEED_TAG_RE.exec(line);
		const tick = tag ? ticks.get(tag[1]) : undefined;
		return tick ? line.replace(/^(\s*[-*+]\s+)\[ \]/, `$1[${tick}]`) : line;
	});
	const next = [...fresh, ...own, ...trailingBlanks];
	if (next.length === inside.length && next.every((line, i) => line === inside[i])) return null;
	return [...body.slice(0, at + 1), ...next, ...body.slice(stop)];
}
