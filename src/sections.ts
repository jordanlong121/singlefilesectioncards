// Parsing a note into sections: headings, the unfiled and properties cards, YAML, hierarchy.

import { moment } from "obsidian";
import { SortOrder, Placement } from "./settings";
import { taskLineIndexes } from "./tasks";

/** One heading and everything beneath it, down to the next heading of the same or higher rank. */
export interface Section {
	/** Ordinal position in the document, 0-based (-1 for the synthetic unfiled card). */
	index: number;
	/** Heading text with the leading #'s and whitespace stripped. */
	title: string;
	/** The heading line exactly as it appears in the file. */
	headingRaw: string;
	/** 0-based line number of the heading. */
	headingLine: number;
	/** Body lines (everything after the heading), joined with "\n". */
	body: string;
	/** Heading line + body, joined with "\n" — the whole card as text. */
	raw: string;
	/** [startLine, endLine) covering heading + body. */
	startLine: number;
	endLine: number;
	/** True for the synthetic card holding text above the file's first heading. Its
	 * title is display-only, its raw has no heading line, and writes re-locate it by
	 * position (the preamble is unique) rather than by content. */
	unfiled?: boolean;
	/** True for the synthetic card showing the note's properties (frontmatter). It is
	 * also `unfiled` — no heading line, found by position — but renders as a table and
	 * takes no block drags, quick adds, or deletes. */
	properties?: boolean;
	/** True for the synthetic card spanning the whole note below its properties — the
	 * Day Planner's stand-in when the card level has no headings. Also `unfiled`. */
	whole?: boolean;
}

/** obsidian's `moment` re-export is typed as a namespace; this is the callable form. */
export const mo = moment as unknown as (input?: string, format?: string) => { format: (format: string) => string };

/** The strict-parsing form, for asking whether a title *is* a date in a given format. */
export const moParse = moment as unknown as (
	input: string,
	format: string,
	strict: boolean,
) => { isValid: () => boolean; format: (format: string) => string };

export const HEADING_RE = /^(#{1,6})\s+(.*)$/;

export const FENCE_RE = /^\s*(```|~~~)/;

/** An ISO date anywhere in a title — the one spelling every date feature recognizes. */
export const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}/;

/** Whether an ISO-shaped string names a real day (rejects 2026-13-99 without moment). */
export function validIsoDate(iso: string): boolean {
	const y = Number(iso.slice(0, 4));
	const m = Number(iso.slice(5, 7));
	const d = Number(iso.slice(8, 10));
	const dt = new Date(y, m - 1, d);
	return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function parseSections(lines: string[], level: number): Section[] {
	const sections: Section[] = [];
	let inFence = false;
	let inFrontmatter = false;
	// Only blanks seen so far: a properties block still counts after stray leading
	// blank lines, so its `---` fences never read as content (see firstContentLine).
	let beforeContent = true;

	// A heading of rank <= level closes the current section.
	const starts: { line: number; title: string; headingRaw: string }[] = [];
	const closers: number[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (beforeContent) {
			if (line.trim() === "") continue;
			beforeContent = false;
			if (line.trim() === "---") {
				inFrontmatter = true;
				continue;
			}
		}
		if (inFrontmatter) {
			if (line.trim() === "---") inFrontmatter = false;
			continue;
		}
		// First-character gate: fences start with a backtick/tilde or indentation, and
		// headings with '#'. Most lines are neither, and skipping both regexes for them
		// makes this parse — which runs on every refresh — mostly a charCode scan.
		const c0 = line.charCodeAt(0);
		if ((c0 === 96 || c0 === 126 || c0 === 32 || c0 === 9) && FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || c0 !== 35) continue;

		const match = HEADING_RE.exec(line);
		if (!match) continue;

		const rank = match[1].length;
		if (rank === level) {
			starts.push({ line: i, title: match[2].trim(), headingRaw: line });
		} else if (rank < level) {
			closers.push(i);
		}
	}

	// Starts are in ascending line order, so a single pointer replaces a scan per start.
	let closerIndex = 0;
	for (let s = 0; s < starts.length; s++) {
		const start = starts[s];
		const nextStart = s + 1 < starts.length ? starts[s + 1].line : lines.length;
		while (closerIndex < closers.length && closers[closerIndex] <= start.line) closerIndex++;
		const nextCloser = closerIndex < closers.length ? closers[closerIndex] : undefined;
		const end = Math.min(nextStart, nextCloser ?? lines.length);
		const bodyLines = lines.slice(start.line + 1, end);

		// Trim trailing blank lines so cards don't carry dead space.
		while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();

		sections.push({
			index: s,
			title: start.title,
			headingRaw: start.headingRaw,
			headingLine: start.line,
			body: bodyLines.join("\n"),
			raw: [start.headingRaw, ...bodyLines].join("\n"),
			startLine: start.line,
			endLine: start.line + 1 + bodyLines.length,
		});
	}

	return sections;
}

export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** How many task lines (any state) a section body holds — the count sorts' key. */
export function sectionTaskCount(body: string): number {
	return taskLineIndexes(body.split("\n")).length;
}

export function sortSections(sections: Section[], order: SortOrder): Section[] {
	const sorted = sections.slice();
	if (order === "asc") sorted.sort((a, b) => collator.compare(a.title, b.title));
	else if (order === "desc") sorted.sort((a, b) => collator.compare(b.title, a.title));
	else if (order === "count-asc" || order === "count-desc") {
		// Stable sort: equal counts keep the note's own order.
		const counts = new Map(sections.map((s) => [s, sectionTaskCount(s.body)]));
		const dir = order === "count-asc" ? 1 : -1;
		sorted.sort((a, b) => dir * ((counts.get(a) ?? 0) - (counts.get(b) ?? 0)));
	}
	// The properties and unfiled cards are the top of the file, not alphabetical peers —
	// keep them first, in file order.
	const front = sorted.filter((s) => s.properties).concat(sorted.filter((s) => s.unfiled && !s.properties));
	return front.length ? front.concat(sorted.filter((s) => !s.unfiled)) : sorted;
}

/**
 * Pull pinned sections to the front, keeping the incoming sort order within both the
 * pinned group and the rest — pinning overrides *where* a card sits, not how it sorts.
 */
export function applyPinned(sections: Section[], pinned: string[]): Section[] {
	if (!pinned.length) return sections;
	const keys = new Set(pinned);
	const pin = sections.filter((s) => keys.has(s.headingRaw));
	if (!pin.length || pin.length === sections.length) return sections;
	return [...pin, ...sections.filter((s) => !keys.has(s.headingRaw))];
}

/**
 * First line after any frontmatter block — the top of the note's real content. The
 * properties block is honored even when stray blank lines precede it (sync tools and
 * hand edits leave them), so nothing computed from here ever writes above or into the
 * `---` fences.
 */
export function firstContentLine(lines: string[]): number {
	let first = 0;
	while (first < lines.length && lines[first].trim() === "") first++;
	if (lines[first]?.trim() !== "---") return 0;
	for (let i = first + 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") return i + 1;
	}
	return 0;
}

/** The unfiled card's key in per-note state (pins, placements). Real sections are keyed
 * by their heading line, which always starts with #, so this can never collide. */
export const UNFILED_KEY = "::unfiled::";

/**
 * The synthetic section for text sitting above the file's first heading (of any rank),
 * below any frontmatter — text that otherwise never appears in a card. Null when there
 * is no such text. Its raw is body-only: the title is display-only and never written.
 */
export function unfiledSection(lines: string[], title: string): Section | null {
	let start = firstContentLine(lines);
	while (start < lines.length && lines[start].trim() === "") start++;

	let end = lines.length;
	let inFence = false;
	for (let i = start; i < lines.length; i++) {
		if (FENCE_RE.test(lines[i])) {
			inFence = !inFence;
			continue;
		}
		if (!inFence && HEADING_RE.test(lines[i])) {
			end = i;
			break;
		}
	}

	const bodyLines = lines.slice(start, end);
	while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
	if (!bodyLines.length) return null;

	const body = bodyLines.join("\n");
	return {
		index: -1,
		title,
		headingRaw: UNFILED_KEY,
		headingLine: start,
		body,
		raw: body,
		startLine: start,
		endLine: start + bodyLines.length,
		unfiled: true,
	};
}

/** The properties card's key in per-note state (pins, placements, colors). */
export const WHOLE_KEY = "::whole::";

/** The whole note below its properties as one headless section: the Day Planner's card
 * when the chosen level has no headings, so every section beneath can still show. */
export function wholeNoteSection(lines: string[]): Section {
	let start = firstContentLine(lines);
	while (start < lines.length && lines[start].trim() === "") start++;
	const body = lines.slice(start).join("\n");
	return {
		index: -1,
		title: "",
		headingRaw: WHOLE_KEY,
		headingLine: -1,
		body,
		raw: body,
		startLine: start,
		endLine: lines.length,
		unfiled: true,
		whole: true,
	};
}

export const PROPERTIES_KEY = "::properties::";

/**
 * The synthetic section for the note's properties: the lines between the frontmatter
 * fences (stray blank lines above the opening `---` tolerated, as everywhere else).
 * Null when the note has no properties block or it is empty. Body-only, like the
 * unfiled card: the title is display-only and the fences are never card content.
 */
export function propertiesSection(lines: string[], title: string): Section | null {
	let open = 0;
	while (open < lines.length && lines[open].trim() === "") open++;
	if (lines[open]?.trim() !== "---") return null;
	let close = -1;
	for (let i = open + 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			close = i;
			break;
		}
	}
	if (close === -1) return null;
	const bodyLines = lines.slice(open + 1, close);
	if (!bodyLines.some((line) => line.trim() !== "")) return null;
	const body = bodyLines.join("\n");
	return {
		index: -1,
		title,
		headingRaw: PROPERTIES_KEY,
		headingLine: open + 1,
		body,
		raw: body,
		startLine: open + 1,
		endLine: close,
		unfiled: true,
		properties: true,
	};
}

/** A YAML scalar as card text: quotes shed, so `"[[Note]]"` renders as a link. */
export function yamlScalarText(value: string): string {
	const v = value.trim();
	if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
		return v.slice(1, -1);
	}
	return v;
}

/** The quote a YAML scalar was written with, if any. */
export function yamlQuoteOf(value: string): '"' | "'" | "" {
	const v = value.trim();
	if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return '"';
	if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return "'";
	return "";
}

/**
 * A plain value as a YAML scalar. Kept bare when YAML reads it back unchanged; quoted
 * when it starts with an indicator, holds `: ` or ` #`, or would otherwise turn into
 * a list or a comment. A value that was quoted in the file stays quoted, so `"[[Note]]"`
 * round-trips the way Obsidian writes it.
 */
export function yamlScalar(text: string, quote: '"' | "'" | "" = "", inList = false): string {
	if (text === "") return quote ? `${quote}${quote}` : "";
	const risky =
		/^[[\]{}&*!|>'"%@`#,]|^-(?:\s|$)|^[?:](?:\s|$)|:\s|:$|\s#|^\s|\s$/.test(text) || (inList && /[,[\]]/.test(text));
	if (!quote && !risky) return text;
	if (quote === "'" && !text.includes("'")) return `'${text}'`;
	return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One top-level property as it sits in the frontmatter text. */
export interface YamlProperty {
	key: string;
	/** Scalar text (quotes shed), or the items of a list. */
	text: string;
	items: string[] | null;
	/** How the file spells it, so an edit writes it back the same way. */
	shape: "scalar" | "inline" | "block" | "folded";
	quote: '"' | "'" | "";
	/** [start, end) line offsets into the frontmatter body. */
	start: number;
	end: number;
	/** Indent of a block list's items (default two spaces). */
	indent: string;
}

/**
 * The frontmatter's top-level properties, best effort over the raw text — no YAML
 * library, so odd blocks still yield something rather than nothing. Nested maps read
 * as folded text; anything that isn't `key: …` is skipped and left untouched by edits.
 */
export function parseYamlProperties(yaml: string): YamlProperty[] {
	const props: YamlProperty[] = [];
	const lines = yaml.split("\n");
	let i = 0;
	while (i < lines.length) {
		const m = /^([^\s:#][^:]*?):(?:\s+(.*))?$/.exec(lines[i]);
		if (!m) {
			i++;
			continue;
		}
		const key = m[1].trim();
		const rawValue = (m[2] ?? "").trim();
		const start = i;
		i++;
		let prop: YamlProperty;
		if (rawValue === "" || /^[|>][-+]?$/.test(rawValue)) {
			// Block list or block scalar: the indented lines that follow.
			const items: string[] = [];
			const folded: string[] = [];
			let indent = "  ";
			let end = i;
			while (i < lines.length && (/^\s+\S/.test(lines[i]) || lines[i].trim() === "")) {
				const item = /^(\s*)-\s*(.*)$/.exec(lines[i]);
				if (item) {
					if (!items.length) indent = item[1];
					items.push(yamlScalarText(item[2]));
				} else if (lines[i].trim()) folded.push(lines[i].trim());
				i++;
				if (lines[i - 1].trim() !== "") end = i; // trailing blanks stay outside
			}
			i = end;
			prop = items.length
				? { key, text: "", items, shape: "block", quote: "", start, end, indent }
				: {
						key,
						text: folded.join(rawValue.startsWith(">") ? " " : "\n"),
						items: null,
						shape: rawValue === "" ? "scalar" : "folded",
						quote: "",
						start,
						end,
						indent,
					};
		} else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
			const items: string[] = [];
			for (const part of rawValue.slice(1, -1).split(",")) {
				const text = yamlScalarText(part);
				if (text) items.push(text);
			}
			prop = { key, text: "", items, shape: "inline", quote: "", start, end: i, indent: "  " };
		} else {
			prop = { key, text: yamlScalarText(rawValue), items: null, shape: "scalar", quote: yamlQuoteOf(rawValue), start, end: i, indent: "  " };
		}
		props.push(prop);
	}
	return props;
}

/** A property's value as card text: lists join with commas, `tags` entries become tags. */
export function propertyDisplay(prop: YamlProperty): string {
	if (!prop.items) return prop.text;
	const isTags = /^tags?$/i.test(prop.key);
	return prop.items.map((item) => (isTags && !item.startsWith("#") ? `#${item}` : item)).join(", ");
}

/** A property's value as the text offered for editing: list items comma-separated. */
export function propertyEditText(prop: YamlProperty): string {
	return prop.items ? prop.items.join(", ") : prop.text;
}

/**
 * The frontmatter with one property's value replaced, spelled the way the file had it:
 * a scalar stays a scalar (quotes kept), an inline list stays `[a, b]`, a block list
 * stays `- item` lines, a block scalar stays `|`. Every other line is untouched.
 */
export function setYamlProperty(yaml: string, key: string, edited: string): string {
	const prop = parseYamlProperties(yaml).find((p) => p.key === key);
	if (!prop) return yaml;
	const lines = yaml.split("\n");
	let replacement: string[];
	if (prop.shape === "inline" || prop.shape === "block") {
		const items = edited
			.split(",")
			.map((item) => item.trim())
			.map((item) => (/^tags?$/i.test(key) ? item.replace(/^#/, "") : item))
			.filter(Boolean);
		if (prop.shape === "inline") replacement = [`${key}: [${items.map((item) => yamlScalar(item, "", true)).join(", ")}]`];
		else replacement = [`${key}:`, ...items.map((item) => `${prop.indent}- ${yamlScalar(item)}`)];
	} else if (prop.shape === "folded" || edited.includes("\n")) {
		const body = edited.split("\n");
		replacement = body.some((line) => line.trim()) ? [`${key}: |`, ...body.map((line) => `  ${line}`)] : [`${key}:`];
	} else {
		const scalar = yamlScalar(edited, prop.quote);
		replacement = [scalar ? `${key}: ${scalar}` : `${key}:`];
	}
	lines.splice(prop.start, prop.end - prop.start, ...replacement);
	return lines.join("\n");
}

/** The properties card's body as a markdown table (the static fallback rendering). */
export function propertiesMarkdown(yaml: string): string {
	const props = parseYamlProperties(yaml);
	if (!props.length) return "```yaml\n" + yaml + "\n```";
	const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
	return ["| Property | Value |", "| --- | --- |", ...props.map((p) => `| ${cell(p.key)} | ${cell(propertyDisplay(p))} |`)].join("\n");
}

/** Every card the view shows: parsed sections plus, when enabled, the properties card
 * and the unfiled card, in that (file) order. */
export function parseCards(
	lines: string[],
	level: number,
	unfiledTitle: string | null,
	propertiesTitle: string | null = null,
): Section[] {
	const sections = parseSections(lines, level);
	const front: Section[] = [];
	const props = propertiesTitle ? propertiesSection(lines, propertiesTitle) : null;
	if (props) front.push(props);
	const pre = unfiledTitle ? unfiledSection(lines, unfiledTitle) : null;
	if (pre) front.push(pre);
	return front.length ? [...front, ...sections] : sections;
}

/** A heading shallower than the card level — the Hierarchy layout's drill-down data. */
export interface AncestorHeading {
	level: number;
	title: string;
	/** The heading line exactly as it appears in the file. */
	raw: string;
	/** 0-based line number. */
	line: number;
}

/**
 * Every heading of rank < cardLevel, skipping frontmatter and code fences the same way
 * parseSections does, so a card's ancestors agree with the card boundaries.
 */
export function parseAncestorHeadings(lines: string[], cardLevel: number): AncestorHeading[] {
	const found: AncestorHeading[] = [];
	let inFence = false;
	let inFrontmatter = false;
	let beforeContent = true; // as in parseSections: properties survive leading blanks
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (beforeContent) {
			if (line.trim() === "") continue;
			beforeContent = false;
			if (line.trim() === "---") {
				inFrontmatter = true;
				continue;
			}
		}
		if (inFrontmatter) {
			if (line.trim() === "---") inFrontmatter = false;
			continue;
		}
		// Same first-character gate as parseSections; this too runs per refresh.
		const c0 = line.charCodeAt(0);
		if ((c0 === 96 || c0 === 126 || c0 === 32 || c0 === 9) && FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || c0 !== 35) continue;
		const match = HEADING_RE.exec(line);
		if (!match) continue;
		const rank = match[1].length;
		if (rank < cardLevel) found.push({ level: rank, title: match[2].trim(), raw: line, line: i });
	}
	return found;
}

/** Which heading levels (1–6) actually occur in the note, ascending — the toolbar's
 * Heading dropdown offers only these. (Rank < 7 collects every heading.) */
export function headingLevelsIn(lines: string[]): number[] {
	const found = new Set<number>();
	for (const h of parseAncestorHeadings(lines, 7)) found.add(h.level);
	return [...found].sort((a, b) => a - b);
}

/** The Hierarchy layout's synthetic "no heading at this level" item key. Real items are
 * keyed by their heading line, which always starts with #, so this can never collide. */
export const HIER_GAP_KEY = "::hier-gap::";

/** One clickable row in a Hierarchy column, with the [start, end) line range it owns. */
export interface HierarchyItem {
	/** The heading line as written, or HIER_GAP_KEY for the synthetic gap item. */
	key: string;
	label: string;
	start: number;
	end: number;
}

/**
 * The items one Hierarchy column shows: the level-`level` headings inside the selected
 * parent's [start, end) range, each owning the lines up to its next sibling. Cards that
 * sit in the range before the first such heading (or in a range with none at all) get a
 * synthetic "(no H`level`)" item, so every card stays reachable.
 */
export function hierarchyColumnItems(
	headings: AncestorHeading[],
	level: number,
	start: number,
	end: number,
	cardLines: number[],
): HierarchyItem[] {
	const children = headings.filter((h) => h.level === level && h.line >= start && h.line < end);
	const items: HierarchyItem[] = children.map((h, i) => ({
		key: h.raw,
		label: h.title || "(untitled)",
		start: h.line,
		end: i + 1 < children.length ? children[i + 1].line : end,
	}));
	const gapEnd = children.length ? children[0].line : end;
	if (cardLines.some((l) => l >= start && l < gapEnd)) {
		items.unshift({ key: HIER_GAP_KEY, label: `(no H${level})`, start, end: gapEnd });
	}
	return items;
}

/** One Sections-layout group: the cards under the same nearest ancestor heading. */
export interface SectionGroup {
	/** The ancestor heading's raw line, or "" for cards with no ancestor. */
	key: string;
	title: string;
	sections: Section[];
}

/**
 * Sections layout: split an ordered card list into groups by nearest ancestor
 * heading (any level above the cards', so skipped levels still divide). Groups keep
 * the order of their first card, so the active sort decides which group leads;
 * within a group the given order is unchanged. Duplicate ancestor text stays two
 * groups (grouping is by line) but shares one collapse key (the raw line).
 */
export function groupByAncestor(sections: Section[], ancestors: AncestorHeading[]): SectionGroup[] {
	const groups = new Map<number, SectionGroup>();
	for (const section of sections) {
		let parent: AncestorHeading | undefined;
		for (const a of ancestors) {
			if (a.line > section.headingLine) break;
			parent = a;
		}
		let group = groups.get(parent?.line ?? -1);
		if (!group) {
			group = {
				key: parent?.raw ?? "",
				title: parent ? parent.title || "(untitled)" : "(no parent heading)",
				sections: [],
			};
			groups.set(parent?.line ?? -1, group);
		}
		group.sections.push(section);
	}
	return [...groups.values()];
}

/** First line of a section's body: the unfiled card has no heading line to skip. */
export function bodyStartLine(section: Section): number {
	return section.unfiled ? section.startLine : section.startLine + 1;
}

/**
 * Which way the file's existing sections already run. Daily-note files are usually
 * newest-first (descending), so "logical order" has to follow the file, not assume A→Z.
 */
export function detectDirection(titles: string[]): "asc" | "desc" {
	let asc = 0;
	let desc = 0;
	for (let i = 1; i < titles.length; i++) {
		const cmp = collator.compare(titles[i - 1], titles[i]);
		if (cmp < 0) asc++;
		else if (cmp > 0) desc++;
	}
	return desc > asc ? "desc" : "asc";
}

/** Line at which a new section titled `title` should be inserted. */
export function insertionLine(lines: string[], level: number, title: string, placement: Placement): number {
	const sections = parseSections(lines, level);

	if (!sections.length) return placement === "top" ? firstContentLine(lines) : lines.length;

	if (placement === "top") return sections[0].startLine;
	if (placement === "bottom") return sections[sections.length - 1].endLine;

	const direction = detectDirection(sections.map((s) => s.title));
	for (const section of sections) {
		const cmp = collator.compare(title, section.title);
		if (direction === "asc" ? cmp < 0 : cmp > 0) return section.startLine;
	}
	return sections[sections.length - 1].endLine;
}

/** Date-looking headings per level (index 1–6), in one pass over the file. */
/**
 * A note's first few content lines as a Deck thumbnail excerpt: frontmatter dropped,
 * heading/list/task/quote markers stripped, capped by lines and characters.
 */
export function deckExcerpt(content: string, maxLines = 8, maxChars = 260): string {
	let lines = content.split(/\r?\n/);
	if (lines[0]?.trim() === "---") {
		const close = lines.indexOf("---", 1);
		if (close > 0) lines = lines.slice(close + 1);
	}
	const kept: string[] = [];
	for (const line of lines) {
		const text = line
			.replace(/^\s{0,3}>+\s*/, "")
			.replace(/^\s{0,3}#{1,6}\s+/, "")
			.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, "")
			.trim();
		if (!text) continue;
		kept.push(text);
		if (kept.length >= maxLines || kept.join("\n").length >= maxChars) break;
	}
	const out = kept.join("\n");
	return out.length > maxChars ? `${out.slice(0, maxChars - 1).trimEnd()}…` : out;
}

/**
 * Fill a template's `{{title}}`, `{{date}}` and `{{time}}` placeholders (with optional
 * `{{date:FORMAT}}` variants, like Obsidian's core Templates). `{{date}}` uses the date
 * named in the card's heading when there is one, so a template dropped into a card for
 * 2026-08-20 writes that day rather than today; `{{time}}` is always now.
 */
export function applyTemplatePlaceholders(raw: string, title: string, headingFormat: string): string {
	const iso = ISO_DATE_RE.exec(title)?.[0];
	let cardDate: { format: (f: string) => string };
	if (iso) {
		cardDate = mo(iso, "YYYY-MM-DD");
	} else {
		const strict = headingFormat.trim() ? moParse(title.trim(), headingFormat.trim(), true) : null;
		cardDate = strict?.isValid() ? strict : mo();
	}
	return raw
		.replace(/\{\{\s*title\s*\}\}/gi, title)
		.replace(/\{\{\s*date\s*(?::([^}]*))?\}\}/gi, (_, f: string | undefined) =>
			cardDate.format(f?.trim() || "YYYY-MM-DD"),
		)
		.replace(/\{\{\s*time\s*(?::([^}]*))?\}\}/gi, (_, f: string | undefined) =>
			mo().format(f?.trim() || "HH:mm"),
		);
}

/** Normalize a typed heading: keep the user's #'s if present, otherwise apply the view's level. */
export function normalizeHeading(text: string, fallbackLevel: number): string {
	const trimmed = text.trim();
	if (/^#{1,6}\s+\S/.test(trimmed)) return trimmed;
	const bare = trimmed.replace(/^#+\s*/, "");
	return `${"#".repeat(fallbackLevel)} ${bare}`;
}

/**
 * Find a section again in freshly-read lines. Prefers an exact content match, then the
 * closest of several identical blocks, then a unique heading — so a write can't land on
 * the wrong section if the file changed since the card was rendered.
 */
export function locateSection(sections: Section[], original: Section): Section | undefined {
	const byContent = sections.filter((s) => s.raw === original.raw);
	if (byContent.length === 1) return byContent[0];
	if (byContent.length > 1) {
		return byContent.reduce((best, s) =>
			Math.abs(s.index - original.index) < Math.abs(best.index - original.index) ? s : best,
		);
	}
	const byHeading = sections.filter((s) => s.headingRaw === original.headingRaw);
	return byHeading.length === 1 ? byHeading[0] : undefined;
}

/**
 * Re-locate any card at write time. The unfiled card is found by position — the
 * preamble is unique, so re-deriving it is more robust than content matching.
 * Everything else goes through locateSection's content matching as before.
 */
export function locateCard(lines: string[], level: number, original: Section): Section | undefined {
	if (original.properties) return propertiesSection(lines, original.title) ?? undefined;
	if (original.whole) return wholeNoteSection(lines);
	if (original.unfiled) return unfiledSection(lines, original.title) ?? undefined;
	return locateSection(parseSections(lines, level), original);
}

/**
 * The section as it stands on disk right after `edited` has been written over it.
 * Autosave re-describes the open editor's Section with this so the next write — and
 * the final save's changed-content check — still find the block, even if the heading
 * line itself was edited.
 */
export function sectionFromEdited(original: Section, edited: string): Section {
	const lines = edited.split("\n");
	// The unfiled card has no heading line: the whole editor content is its body.
	if (original.unfiled) {
		return { ...original, body: edited, raw: edited, endLine: original.startLine + lines.length };
	}
	const headingRaw = lines[0] ?? original.headingRaw;
	return {
		...original,
		headingRaw,
		title: headingRaw.replace(/^#+\s*/, "").trim(),
		body: lines.slice(1).join("\n"),
		raw: edited,
		endLine: original.startLine + lines.length,
	};
}

/**
 * Heading level to show a note at. Honours `preferred` whenever that level exists in the
 * note; otherwise falls back to the level with the most sections (ties go to the shallower
 * one), so a note that has no H3s doesn't open as an empty card wall.
 */
export function pickHeadingLevel(lines: string[], preferred: number): number {
	// One scan tallies every level at once; parseSections per level cost up to 7 passes.
	const counts = [0, 0, 0, 0, 0, 0, 0];
	let inFence = false;
	let inFrontmatter = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (i === 0 && line.trim() === "---") {
			inFrontmatter = true;
			continue;
		}
		if (inFrontmatter) {
			if (line.trim() === "---") inFrontmatter = false;
			continue;
		}
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const match = HEADING_RE.exec(line);
		if (match) counts[match[1].length]++;
	}

	if (counts[preferred] > 0) return preferred;

	let best = preferred;
	let bestCount = 0;
	for (let level = 1; level <= 6; level++) {
		if (counts[level] > bestCount) {
			best = level;
			bestCount = counts[level];
		}
	}
	return bestCount > 0 ? best : preferred;
}

export function planCardReuse(prevRaws: string[], nextRaws: string[]): number[] {
	const pool = new Map<string, number[]>();
	prevRaws.forEach((raw, i) => {
		const list = pool.get(raw);
		if (list) list.push(i);
		else pool.set(raw, [i]);
	});
	return nextRaws.map((raw) => pool.get(raw)?.shift() ?? -1);
}

/** What a card level leaves out of the wall (see levelCoverage). */
export interface LevelCoverage {
	/** Cards at this level. */
	sections: number;
	/** Non-blank, non-heading lines that sit under a heading but inside no card at this
	 * level — text the wall doesn't show. Lines above the first heading (the unfiled
	 * card's) and heading lines themselves aren't counted. */
	hiddenLines: number;
	/** The heading levels those lines sit under, shallowest first. */
	hiddenLevels: number[];
	/** The level most of that text sits directly under (shallower on a tie) — the card
	 * level that would show it; null when nothing is hidden. */
	bestLevel: number | null;
}

/**
 * Text a card level hides: H4 picked in a note of H1 months, H2 weeks, and H3 days shows
 * only the few H4 sections, and everything written under the other headings is off the
 * wall with nothing to say so. Counts that text, notes which levels it sits under, and
 * names the level most of it sits under.
 */
export function levelCoverage(lines: string[], level: number): LevelCoverage {
	const headings = parseAncestorHeadings(lines, 7);
	if (!headings.length) return { sections: 0, hiddenLines: 0, hiddenLevels: [], bestLevel: null };
	const coveredBy = (l: number): Uint8Array => {
		const covered = new Uint8Array(lines.length);
		for (const s of parseSections(lines, l)) for (let i = s.startLine; i < s.endLine; i++) covered[i] = 1;
		return covered;
	};
	const sections = parseSections(lines, level);
	const covered = coveredBy(level);
	// Walk from the first heading: text lines outside every card, and the heading they sit under.
	const headingAt = new Map<number, number>(headings.map((h) => [h.line, h.level]));
	let hiddenLines = 0;
	const under = new Map<number, number>();
	let current = headings[0].level;
	let inFence = false;
	for (let i = headings[0].line; i < lines.length; i++) {
		const line = lines[i];
		if (FENCE_RE.test(line)) inFence = !inFence;
		const h = !inFence ? headingAt.get(i) : undefined;
		if (h !== undefined) {
			current = h;
			continue;
		}
		if (covered[i] || !line.trim()) continue;
		hiddenLines++;
		under.set(current, (under.get(current) ?? 0) + 1);
	}
	const hiddenLevels = [...under.keys()].sort((a, b) => a - b);
	let best: number | null = null;
	for (const l of hiddenLevels) if (best === null || (under.get(l) ?? 0) > (under.get(best) ?? 0)) best = l;
	return { sections: sections.length, hiddenLines, hiddenLevels, bestLevel: best };
}
