// Group by: the divider-bar buckets (tag, date, tasks, stars, length).

import { GroupBy } from "./settings";
import { Section, validIsoDate, SectionGroup } from "./sections";
import { titleToIso } from "./dates";
import { starInfo } from "./blocks";
import { firstBodyTag, openTaskCount } from "./tasks";

/** What groupCards needs to bucket a card: the star emoji, the note's date format and
 * detect pattern, and today's ISO date. */
export interface GroupOptions {
	emoji: string;
	format: string;
	detect: string;
	todayIso: string;
}

export const ISO_ANYWHERE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;

/** The date a card is "about": its heading's date, else the latest ISO date in its body. */
export function cardDateIso(section: Section, format: string, detect: string): string | null {
	const fromTitle = titleToIso(section.title, format, detect);
	if (fromTitle) return fromTitle;
	let latest: string | null = null;
	// An exec loop rather than matchAll: the latter is ES2020, past this project's lib.
	ISO_ANYWHERE_RE.lastIndex = 0;
	for (let m = ISO_ANYWHERE_RE.exec(section.body); m; m = ISO_ANYWHERE_RE.exec(section.body)) {
		const found = m[1];
		if (validIsoDate(found) && (!latest || found > latest)) latest = found;
	}
	return latest;
}

export function dateBucket(iso: string | null, todayIso: string): string {
	if (!iso) return "No date";
	if (iso > todayIso) return "Upcoming";
	if (iso === todayIso) return "Today";
	const days = Math.round((Date.parse(todayIso) - Date.parse(iso)) / 86400000);
	if (days === 1) return "Yesterday";
	if (days < 7) return "This week";
	if (iso.slice(0, 7) === todayIso.slice(0, 7)) return "This month";
	return "Older";
}

export const DATE_BUCKETS = ["Upcoming", "Today", "Yesterday", "This week", "This month", "Older", "No date"];

export const TASK_BUCKETS = ["6+ open tasks", "3–5 open tasks", "1–2 open tasks", "No open tasks"];

export const LENGTH_BUCKETS = ["Long (20+ lines)", "Medium (6–19 lines)", "Short (≤5 lines)"];

/**
 * Group-by: split an ordered card list into buckets by first tag, date, open-task
 * count, stars, or length. Cards keep their order inside a bucket; the buckets come in
 * a fixed order (tags alphabetically, the tagless last). Empty buckets are omitted.
 */
export function groupCards(sections: Section[], by: GroupBy, opts: GroupOptions): SectionGroup[] {
	const groups = new Map<string, SectionGroup>();
	const add = (title: string, section: Section) => {
		let g = groups.get(title);
		if (!g) {
			g = { key: `group:${by}:${title}`, title, sections: [] };
			groups.set(title, g);
		}
		g.sections.push(section);
	};
	for (const s of sections) {
		switch (by) {
			case "tag": {
				const tag = firstBodyTag(s.body);
				add(tag ? `#${tag}` : "No tag", s);
				break;
			}
			case "date":
				add(dateBucket(cardDateIso(s, opts.format, opts.detect), opts.todayIso), s);
				break;
			case "tasks": {
				const n = openTaskCount(s.body);
				add(n === 0 ? TASK_BUCKETS[3] : n <= 2 ? TASK_BUCKETS[2] : n <= 5 ? TASK_BUCKETS[1] : TASK_BUCKETS[0], s);
				break;
			}
			case "stars":
				add(starInfo(s.body.split("\n"), opts.emoji).count > 0 ? "Starred" : "Not starred", s);
				break;
			case "length": {
				const n = s.body.split("\n").filter((l) => l.trim()).length;
				add(n >= 20 ? LENGTH_BUCKETS[0] : n >= 6 ? LENGTH_BUCKETS[1] : LENGTH_BUCKETS[2], s);
				break;
			}
			default:
				return [{ key: "", title: "", sections }];
		}
	}
	const order =
		by === "date" ? DATE_BUCKETS : by === "tasks" ? TASK_BUCKETS : by === "stars" ? ["Starred", "Not starred"] : by === "length" ? LENGTH_BUCKETS : null;
	const titles = [...groups.keys()];
	if (order) titles.sort((a, b) => order.indexOf(a) - order.indexOf(b));
	else titles.sort((a, b) => (a === "No tag" ? 1 : b === "No tag" ? -1 : a.localeCompare(b)));
	return titles.map((t) => groups.get(t) as SectionGroup);
}
