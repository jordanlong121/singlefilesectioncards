// A synthetic daily-notes file for benchmarks: H2 months, H3 dated days, tasks (some
// nested, some done), tags, links, starred lines, and a Card Flip back on every third card.
//   node tools/bench-note.mjs 1000 > "/tmp/Daily Notes 2026.md"
const DOWS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function makeNote(n) {
	const out = ["# Daily Notes", ""];
	const start = Date.UTC(2020, 0, 1);
	let month = "";
	for (let i = 0; i < n; i++) {
		const d = new Date(start + i * 86400000);
		const iso = d.toISOString().slice(0, 10);
		const m = iso.slice(0, 7);
		if (m !== month) {
			month = m;
			out.push(`## ${m}`, "");
		}
		out.push(`### ${iso}, ${DOWS[d.getUTCDay()]}`);
		out.push(`Slow start — note ${i} with a [[Project ${i % 17}]] link and a #tag${i % 9}.`);
		out.push(`- [ ] task one for day ${i} #work`);
		out.push(`- [x] done task ✅ ${iso}`);
		out.push(`- [ ] parent task`);
		out.push(`\t- [ ] nested child ${i % 5}`);
		out.push(`\t- plain nested note`);
		if (i % 4 === 0) out.push(`⭐ starred line ${i}`);
		out.push(`Another paragraph, a little longer, so bodies have some weight to them and wrap on a card.`);
		if (i % 3 === 0) out.push("", "%% flip %%", `The back of card ${i}: an answer, or metadata.`);
		out.push("");
	}
	return out.join("\n");
}
if (process.argv[1]?.endsWith("bench-note.mjs")) process.stdout.write(makeNote(Number(process.argv[2] ?? 1000)));
