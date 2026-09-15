// Invariant check for real notes: `node tools/check-note.mjs <note.md> [...]` after
// `npm test` (which builds test/.tmp/main.js). Prints one line per finding; exits 1 on any.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(path.join(here, "..", "test", ".tmp", "main.js"));
const { parseCards, plannerCards, titleToIso, detectLevelSetup, plannerColumnSplit, plannerCardWeight, wholeNoteSection, dueTaskSummary } = lib;

const FMT = process.env.FMT ?? "YYYY-MM-DD, dddd";
let findings = 0;
const flag = (note, msg) => { findings++; console.log(`${path.basename(note)}: ${msg}`); };

for (const note of process.argv.slice(2)) {
	const text = fs.readFileSync(note, "utf8");
	const lines = text.split(/\r?\n/);
	const setup = detectLevelSetup(lines, FMT, "", true);
	console.log(`${path.basename(note)}: levels ${Object.entries(setup).filter(([, v]) => v.role !== "none").map(([k, v]) => `H${k}=${v.role}`).join(" ")}`);
	for (let level = 1; level <= 6; level++) {
		let secs;
		try {
			secs = parseCards(lines, level, "_Unfiled_", "Properties");
		} catch (e) {
			flag(note, `H${level}: parseCards threw: ${e.message}`);
			continue;
		}
		const real = secs.filter((s) => !s.unfiled);
		if (!real.length) continue;
		// Every card's raw text is its heading plus body, in place.
		for (const s of real) {
			const expected = lines.slice(s.startLine, s.endLine).join("\n").replace(/\n+$/, "");
			if (s.raw.replace(/\n+$/, "") !== expected) flag(note, `H${level} “${s.title}”: raw text doesn't match its lines`);
		}
		const raws = real.map((s) => s.headingRaw);
		const dups = [...new Set(raws.filter((r, i) => raws.indexOf(r) !== i))];
		if (dups.length) console.log(`${path.basename(note)}: H${level}: ${dups.length} duplicated heading(s), e.g. ${dups[0]} (distinct cards; planner slots shared)`);
		// Dated levels: every title should resolve.
		if (setup[String(level)]?.role === "day") {
			const bad = real.filter((s) => !titleToIso(s.title, FMT, ""));
			if (bad.length) flag(note, `H${level}: ${bad.length} day title(s) don't read as dates: ${bad.slice(0, 3).map((s) => s.title).join(" | ")}`);
		}
		// Planner: the cards tile the body, and the columns cover every card.
		for (const s of real) {
			const body = s.body.split("\n");
			const cs = plannerCards(body);
			// With subcards the cards tile the body from the first heading to the end.
			// Line cards (no headings) are only the movable blocks: blank lines, fences,
			// quotes, and tables between them are legitimate gaps.
			if (cs.some((c) => c.kind === "sub")) {
				for (let i = 1; i < cs.length; i++) if (cs[i].start !== cs[i - 1].end) flag(note, `H${level} “${s.title}”: planner cards leave a gap`);
				if (cs[cs.length - 1].end !== body.length) flag(note, `H${level} “${s.title}”: planner cards stop short of the body's end`);
			}
			const cols = plannerColumnSplit(cs.map((c) => ({ weight: plannerCardWeight(body, c) })));
			if (cols.length !== cs.length) flag(note, `H${level} “${s.title}”: column split lost cards`);
			try {
				dueTaskSummary(s.body, "2026-09-14");
			} catch (e) {
				flag(note, `H${level} “${s.title}”: dueTaskSummary threw: ${e.message}`);
			}
		}
	}
	const whole = wholeNoteSection(lines);
	if (!whole.body.trim()) flag(note, "whole-note section is empty");
}
console.log(findings ? `\n${findings} finding(s)` : "\nno findings");
process.exit(findings ? 1 : 0);
