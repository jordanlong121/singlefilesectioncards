// Micro-benchmarks for the pure (DOM-free) pipeline a refresh runs, at three note sizes.
//   node test/run.mjs >/dev/null   # builds test/.tmp/main.js
//   node tools/bench.mjs [sizes, e.g. 100,1000,5000]
import { performance } from "perf_hooks";
import {
	parseCards, parseSections, sortSections, sortTasksLayout, planCardReuse, headingLevelsIn,
	dateHeadingCounts, sectionHasStar, splitCardFaces, bodyForRender, movableBlocks, isTodayTitle,
	titleToIso, heatmapDays, parseAncestorHeadings, groupByAncestor, deckExcerpt, insertIntoSection,
	sectionTaskCount, starInfo,
} from "../test/.tmp/main.js";

const sizes = (process.argv[2] ?? "100,1000,5000").split(",").map(Number);
const FORMAT = "YYYY-MM-DD, dddd";
import { makeNote } from "./bench-note.mjs";

function time(label, fn, runs = 7) {
	const t = [];
	let result;
	for (let r = 0; r < runs; r++) {
		const a = performance.now();
		result = fn();
		t.push(performance.now() - a);
	}
	t.sort((x, y) => x - y);
	return { label, median: t[Math.floor(t.length / 2)], min: t[0], result };
}

for (const n of sizes) {
	const content = makeNote(n);
	const lines = content.split(/\r?\n/);
	const rows = [];
	const push = (r) => rows.push(r);

	push(time("split + parseCards", () => parseCards(content.split(/\r?\n/), 3, null)));
	const sections = parseCards(lines, 3, null);
	push(time("headingLevelsIn", () => headingLevelsIn(lines)));
	// Cold: a format string nobody has parsed yet busts the title→ISO cache, so every
	// heading goes through moment — what the FIRST render of a note pays.
	let cold = 0;
	push(time("dateHeadingCounts (cold)", () => dateHeadingCounts(lines, `${FORMAT} [${cold++}]`, ""), 3));
	push(time("dateHeadingCounts (warm)", () => dateHeadingCounts(lines, FORMAT, "")));
	push(time("sortSections asc", () => sortSections(sections, "asc")));
	push(time("sortSections doc", () => sortSections(sections, "doc")));
	push(time("sortTasksLayout", () => sortTasksLayout(sections, FORMAT, "", "desc")));
	push(time("hasStars (some+split)", () => sections.some((s) => sectionHasStar(s.body.split("\n"), "⭐"))));
	const raws = sections.map((s) => s.raw);
	push(time("planCardReuse identical", () => planCardReuse(raws, raws)));
	const shifted = [raws[0].replace("###", "### x"), ...raws.slice(1)];
	push(time("planCardReuse one edit", () => planCardReuse(raws, shifted)));
	push(time("splitCardFaces ×N", () => sections.map((s) => splitCardFaces(s.body, "%% flip %%"))));
	push(time("bodyForRender ×N", () => sections.map((s) => bodyForRender(s.body))));
	push(time("movableBlocks ×N", () => sections.map((s) => movableBlocks(s.body.split("\n")))));
	push(time("isTodayTitle ×N", () => sections.map((s) => isTodayTitle(s.title, "2021-06-01", "2021-06-01, Tuesday"))));
	push(time("titleToIso ×N (warm)", () => sections.map((s) => titleToIso(s.title, FORMAT, ""))));
	push(time("searchText ×N", () => sections.map((s) => (s.title + "\n" + s.raw).toLowerCase())));
	push(time("starInfo ×N", () => sections.map((s) => starInfo(s.body.split("\n"), "⭐"))));
	push(time("sectionTaskCount ×N", () => sections.map((s) => sectionTaskCount(s.body))));
	push(time("heatmapDays", () => heatmapDays(sections, FORMAT, "")));
	push(time("ancestors + groupByAncestor", () => groupByAncestor(sections, parseAncestorHeadings(lines, 3))));
	push(time("deckExcerpt", () => deckExcerpt(content)));
	push(time("write path: split+locate+splice+join", () => {
		const ls = content.split(/\r?\n/);
		const secs = parseSections(ls, 3);
		return insertIntoSection(ls, secs[Math.floor(secs.length / 2)], "- [ ] new", "bottom").join("\n");
	}));

	const total = rows.reduce((a, r) => a + r.median, 0);
	console.log(`\n=== ${n} sections, ${lines.length} lines, ${(content.length / 1024).toFixed(0)} KB ===`);
	for (const r of rows) console.log(`${r.label.padEnd(38)} ${r.median.toFixed(2).padStart(8)} ms  (min ${r.min.toFixed(2)})`);
	console.log(`${"sum of medians".padEnd(38)} ${total.toFixed(2).padStart(8)} ms`);
}
