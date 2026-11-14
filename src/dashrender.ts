// Draws the Dashboard: the note at a glance. Shared by the Dashboard layout (a wide
// board of panels) and the dashboard sidebar (the same panels stacked in one column).
// The numbers come from summarizeNote; every action goes back through `ctx`, so the
// caller decides what a click on a row, a tag, or a heading level does.

import { moment, type TFile } from "obsidian";
import { summarizeNote, type DashTask, type DashSection } from "./dashboard";
import { fastIcon } from "./icons";
import { mo, bodyStartLine, type Section } from "./sections";
import { taskLineIndexes } from "./tasks";
import type { Layout } from "./settings";

export interface DashContext {
	file: TFile;
	lines: string[];
	/** The note's cards at the view's heading level. */
	sections: Section[];
	/** The new-card date format and the detect format, for dated titles. */
	format: string;
	detect: string;
	/** Whether the note's headings name days (the Dates checkbox). */
	dated: boolean;
	starEmoji: string;
	/** The card level the view shows; the Outline panel marks it. */
	headingLevel: number;
	/** Stack everything in one column, for a narrow pane. */
	vertical: boolean;
	/** Open the note at a 0-based line. */
	reveal: (line: number) => void;
	showLayout: (layout: Layout) => void;
	showLevel: (level: number) => void;
	filterTag: (tag: string) => void;
	createDateCard: (iso: string) => void;
	/** Tick or untick a card's nth task; `box` and `row` get the immediate feedback. */
	toggleTask: (section: Section, nth: number, box: HTMLInputElement, row: HTMLElement) => void;
}

/** Draw the Dashboard into `parent` (appended; the caller empties it first). */
export function renderDashboard(parent: HTMLElement, ctx: DashContext): HTMLElement {
	const { file, sections, reveal } = ctx;
	const todayIso = mo().format("YYYY-MM-DD");
	const sum = summarizeNote(ctx.lines, sections, {
		todayIso,
		format: ctx.format,
		detect: ctx.detect,
		dated: ctx.dated,
		starEmoji: ctx.starEmoji,
	});
	const n = (value: number) => value.toLocaleString();
	const plural = (count: number, one: string, many: string) => `${n(count)} ${count === 1 ? one : many}`;
	const activate = (el: HTMLElement, run: () => void) => {
		el.addEventListener("click", run);
		el.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				run();
			}
		});
	};

	const wrap = parent.createDiv({ cls: "sc-dash" });
	wrap.toggleClass("is-vertical", ctx.vertical);
	const head = wrap.createDiv({ cls: "sc-dash-head" });
	head.createDiv({ cls: "sc-dash-title", text: file.basename });
	const edited = (moment as unknown as (t: number) => { fromNow: () => string })(file.stat.mtime).fromNow();
	head.createDiv({
		cls: "sc-dash-sub",
		text: [plural(sum.lines, "line", "lines"), plural(sum.words, "word", "words"), `edited ${edited}`].join(" · "),
	});

	// Tiles: the headline numbers. Ones that call for action wear an accent.
	const tiles = wrap.createDiv({ cls: "sc-dash-tiles" });
	const tile = (value: string, label: string, opts: { tone?: "warn" | "good"; hint?: string; onClick?: () => void } = {}) => {
		const box = tiles.createDiv({ cls: "sc-dash-tile" });
		if (opts.tone) box.addClass(`is-${opts.tone}`);
		box.createDiv({ cls: "sc-dash-tile-value", text: value });
		box.createDiv({ cls: "sc-dash-tile-label", text: label });
		if (opts.hint) box.setAttr("title", opts.hint);
		if (opts.onClick) {
			box.addClass("is-clickable");
			box.setAttr("role", "button");
			box.tabIndex = 0;
			activate(box, opts.onClick);
		}
	};
	tile(n(sum.sections), sum.sections === 1 ? "card" : "cards", {
		hint: sum.emptySections ? `${plural(sum.emptySections, "card is", "cards are")} empty` : undefined,
	});
	tile(n(sum.open), "open tasks", { onClick: sum.open ? () => ctx.showLayout("tasks") : undefined, hint: "Show the Tasks layout" });
	tile(n(sum.done), "done");
	tile(n(sum.overdue.length), "overdue", { tone: sum.overdue.length ? "warn" : undefined });
	tile(n(sum.dueToday.length), "due today", { tone: sum.dueToday.length ? "good" : undefined });
	if (sum.starredSections) tile(n(sum.starredSections), sum.starredSections === 1 ? "starred card" : "starred cards");
	tile(n(sum.tags.length), sum.tags.length === 1 ? "tag" : "tags");
	tile(n(sum.wikilinks + sum.links), "links", { hint: `${plural(sum.wikilinks, "note", "notes")} linked, ${plural(sum.links, "web link", "web links")}` });
	if (sum.images) tile(n(sum.images), sum.images === 1 ? "image" : "images", { onClick: () => ctx.showLayout("images"), hint: "Show the Images layout" });

	// Task progress across the whole note.
	const total = sum.open + sum.done;
	if (total) {
		const pct = Math.round((100 * sum.done) / total);
		const prog = wrap.createDiv({ cls: "sc-dash-progress" });
		const label = prog.createDiv({ cls: "sc-dash-progress-label" });
		label.createSpan({ text: "Tasks complete" });
		label.createSpan({ cls: "sc-dash-progress-pct", text: `${pct}% · ${n(sum.done)} of ${n(total)}` });
		const bar = prog.createDiv({ cls: "sc-dash-bar", attr: { role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100" } });
		bar.createDiv({ cls: "sc-dash-bar-fill" }).setCssStyles({ width: `${pct}%` });
	}

	const panels = wrap.createDiv({ cls: "sc-dash-panels" });
	const panel = (title: string, icon: string, cls = "") => {
		const box = panels.createDiv({ cls: `sc-dash-panel ${cls}`.trim() });
		const h = box.createDiv({ cls: "sc-dash-panel-head" });
		fastIcon(h.createSpan({ cls: "sc-dash-panel-icon" }), icon);
		h.createSpan({ text: title });
		return box.createDiv({ cls: "sc-dash-panel-body" });
	};
	const emptyNote = (el: HTMLElement, text: string) => el.createDiv({ cls: "sc-dash-empty", text });

	// Needs attention: overdue, today, and the week ahead — each tickable in place.
	const attention = panel("Needs attention", "alarm-clock", "is-wide");
	const taskGroup = (label: string, tasks: DashTask[], tone: string) => {
		if (!tasks.length) return;
		attention.createDiv({ cls: `sc-dash-group is-${tone}`, text: `${label} (${tasks.length})` });
		for (const task of tasks.slice(0, 12)) dashTaskRow(attention, ctx, task, todayIso);
		if (tasks.length > 12) attention.createDiv({ cls: "sc-dash-more", text: `and ${tasks.length - 12} more` });
	};
	taskGroup("Overdue", sum.overdue, "warn");
	taskGroup("Due today", sum.dueToday, "good");
	taskGroup("Next 7 days", sum.upcoming, "muted");
	if (!sum.overdue.length && !sum.dueToday.length && !sum.upcoming.length) {
		emptyNote(attention, sum.open ? "No open task has a due date in the coming week." : "No open tasks.");
	}

	// Ranked cards with a bar scaled to the leader.
	const ranking = (title: string, icon: string, rows: DashSection[], measure: (r: DashSection) => number, unit: (v: number) => string, none: string) => {
		const body = panel(title, icon);
		if (!rows.length) {
			emptyNote(body, none);
			return;
		}
		const max = Math.max(1, ...rows.map(measure));
		for (const row of rows) {
			const item = body.createDiv({ cls: "sc-dash-rank", attr: { role: "button", tabindex: "0" } });
			const top = item.createDiv({ cls: "sc-dash-rank-top" });
			top.createSpan({ cls: "sc-dash-rank-title", text: row.title });
			top.createSpan({ cls: "sc-dash-rank-value", text: unit(measure(row)) });
			item.createDiv({ cls: "sc-dash-bar is-thin" }).createDiv({ cls: "sc-dash-bar-fill" }).setCssStyles({ width: `${(100 * measure(row)) / max}%` });
			activate(item, () => reveal(row.headingLine));
		}
	};
	ranking("Most open tasks", "list-todo", sum.busiest, (r) => r.open, (v) => `${n(v)} open`, "No card has an open task.");
	ranking("Longest cards", "ruler", sum.longest, (r) => r.words, (v) => plural(v, "word", "words"), "Every card is empty.");

	// Outline: headings per level; a click shows that level as cards.
	const outline = panel("Outline", "list-tree");
	const maxH = Math.max(1, ...sum.headings);
	let anyHeading = false;
	for (let level = 1; level <= 6; level++) {
		const count = sum.headings[level];
		if (!count) continue;
		anyHeading = true;
		const row = outline.createDiv({ cls: "sc-dash-level", attr: { role: "button", tabindex: "0" } });
		row.setAttr("aria-label", `Show the H${level} headings as cards`);
		row.toggleClass("is-current", level === ctx.headingLevel);
		row.createSpan({ cls: "sc-dash-level-name", text: `H${level}` });
		row.createDiv({ cls: "sc-dash-bar is-thin" }).createDiv({ cls: "sc-dash-bar-fill" }).setCssStyles({ width: `${(100 * count) / maxH}%` });
		row.createSpan({ cls: "sc-dash-level-count", text: n(count) });
		activate(row, () => ctx.showLevel(level));
	}
	if (!anyHeading) emptyNote(outline, "No headings yet.");

	// Tags: a click shows the cards filtered to the tag.
	const tagBody = panel("Tags", "tag");
	if (!sum.tags.length) emptyNote(tagBody, "No #tags in this note.");
	const chips = tagBody.createDiv({ cls: "sc-dash-tags" });
	for (const [tag, count] of sum.tags.slice(0, 30)) {
		const chip = chips.createEl("button", { cls: "sc-dash-tag" });
		chip.createSpan({ text: `#${tag}` });
		chip.createSpan({ cls: "sc-dash-tag-count", text: n(count) });
		chip.setAttr("aria-label", `Show the cards with #${tag}`);
		chip.addEventListener("click", () => ctx.filterTag(tag));
	}
	if (sum.tags.length > 30) tagBody.createDiv({ cls: "sc-dash-more", text: `and ${sum.tags.length - 30} more` });

	// Dates: the span of dated cards, the streak, and today's card.
	if (sum.dates) {
		const d = sum.dates;
		const body = panel("Days", "calendar-days");
		const facts = body.createDiv({ cls: "sc-dash-facts" });
		const fact = (label: string, value: string) => {
			facts.createDiv({ cls: "sc-dash-fact-label", text: label });
			facts.createDiv({ cls: "sc-dash-fact-value", text: value });
		};
		fact("First day", d.first);
		fact("Last day", d.last);
		fact("Days with cards", n(d.count));
		fact("Current streak", plural(d.current, "day", "days"));
		fact("Longest streak", plural(d.longest, "day", "days"));
		const actions = body.createDiv({ cls: "sc-dash-actions" });
		const todayBtn = actions.createEl("button", { cls: "mod-cta", text: d.todayLine !== null ? "Open today's card" : "Create today's card" });
		todayBtn.addEventListener("click", () => {
			if (d.todayLine !== null) reveal(d.todayLine);
			else ctx.createDateCard(todayIso);
		});
		actions.createEl("button", { text: "Heatmap" }).addEventListener("click", () => ctx.showLayout("heatmap"));
		actions.createEl("button", { text: "Calendar" }).addEventListener("click", () => ctx.showLayout("calendar"));
	}
	return wrap;
}

/** One task row: a checkbox that ticks it in the note, its text (a click opens the
 * note at it), and its due date and card underneath. */
function dashTaskRow(parent: HTMLElement, ctx: DashContext, task: DashTask, todayIso: string): void {
	const row = parent.createDiv({ cls: "sc-dash-task" });
	const box = row.createEl("input", { type: "checkbox", cls: "task-list-item-checkbox" });
	box.setAttr("aria-label", `Mark “${task.text}” done`);
	const section = ctx.sections.find((s) => task.line >= s.startLine && task.line < s.endLine && !s.properties);
	const nth = section ? taskLineIndexes(section.body.split("\n")).indexOf(task.line - bodyStartLine(section)) : -1;
	if (!section || nth < 0) box.disabled = true;
	box.addEventListener("click", (evt) => {
		evt.stopPropagation();
		if (!section || nth < 0) return;
		ctx.toggleTask(section, nth, box, row);
	});
	const text = row.createDiv({ cls: "sc-dash-task-text", attr: { role: "button", tabindex: "0" } });
	text.createDiv({ cls: "sc-dash-task-title", text: task.text || "(empty task)" });
	const meta: string[] = [];
	if (task.due) meta.push(task.due === todayIso ? "today" : task.due);
	if (task.section) meta.push(`in ${task.section}`);
	text.createDiv({ cls: "sc-dash-task-meta", text: meta.join(" · ") });
	text.addEventListener("click", () => ctx.reveal(task.line));
	text.addEventListener("keydown", (evt) => {
		if (evt.key === "Enter") ctx.reveal(task.line);
	});
}
