// README screenshots taken from the running Obsidian (not the preview harness): the
// Table, Tree, Binder and Dashboard layouts, whose DOM the harness doesn't mirror. Start Obsidian
// on the sample vault with --remote-debugging-port=9222 (see tools/drive-obsidian.mjs),
// then:
//   node tools/live-screenshots.mjs            → writes screenshots/{table,tree,binder,dashboard}.png
//   ONLY=dashboard node tools/live-screenshots.mjs   → just the named shot(s), comma-separated
// The window is put in the dark theme at 1280×760 with the sidebars and status bar out
// of the way for the shots, and put back afterwards.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const port = process.env.PORT ?? "9222";
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "screenshots");
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && /Obsidian/.test(t.title ?? "")) ?? targets.find((t) => t.type === "page");
if (!page) throw new Error("no Obsidian page target on port " + port);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.bad(new Error(JSON.stringify(d.error))) : p.ok(d.result); } };
const send = (method, params = {}) => new Promise((ok, bad) => { const n = ++id; pending.set(n, { ok, bad }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => {
	const r = await send("Runtime.evaluate", { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
	return r.result.value;
};
const sleep = (ms) => new Promise((k) => setTimeout(k, ms));
const shot = async (name, clip) => {
	const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { x: 0, y: 0, scale: 1, ...clip } } : {}) });
	fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(r.data, "base64"));
	console.log("wrote screenshots/" + name + ".png");
};

/** An expression (run with `v` the view) that sets the card color of each named
 * heading, null clearing it, and refreshes. */
const colorHeadings = (byTitle) => `(async () => {
	const p = app.plugins.plugins["single-file-section-cards"];
	const wanted = ${JSON.stringify(byTitle)};
	for (const [title, color] of Object.entries(wanted)) {
		const raw = v.noteLines.find((l) => /^#+\\s/.test(l) && l.replace(/^#+\\s*/, "") === title);
		if (raw) await p.setCardColor(v.filePath, raw, color, v.viewSettings());
	}
	await v.refresh();
	await new Promise((r) => setTimeout(r, 500));
})()`;

// The shots: which note, which layout, and what to do to it first.
const SHOTS = [
	// Colored headings for the Table and Tree shots (a colored row, colored nodes);
	// cleared again after each.
	{
		name: "table",
		note: "Handbook.md",
		layout: "table",
		prep: colorHeadings({ "First Month": "blue", "Documentation": "yellow" }),
		after: colorHeadings({ "First Month": null, "Documentation": null }),
	},
	{
		name: "tree",
		note: "Handbook.md",
		layout: "tree",
		// One branch folded, so the chevron's count shows.
		prep: `(async () => {
			await (${colorHeadings({ "Getting Started": "blue", "Ways Of Working": "green", "Reference": "orange", "Documentation": "purple" })});
			const item = [...v.contentEl.querySelectorAll(".sc-tree-item")].find((i) => i.querySelector(":scope > .sc-tree-node .sc-tree-title")?.textContent === "Reference");
			item?.querySelector(":scope > .sc-tree-node .sc-tree-toggle")?.click();
		})()`,
		after: colorHeadings({ "Getting Started": null, "Ways Of Working": null, "Reference": null, "Documentation": null }),
	},
	{
		name: "binder",
		note: "Daily Notes 2026.md",
		layout: "binder",
		// Two cards colored for the shot (their tabs wear it); cleared again after.
		prep: `(async () => {
			const p = app.plugins.plugins["single-file-section-cards"];
			const key = (prefix) => v.cardEntries.find((e) => e.holder.section.title.startsWith(prefix))?.holder.section.headingRaw;
			if (key("2026-08-05")) await p.setCardColor(v.filePath, key("2026-08-05"), "blue", v.viewSettings());
			if (key("2026-07-31")) await p.setCardColor(v.filePath, key("2026-07-31"), "green", v.viewSettings());
			await v.refresh();
			await new Promise((r) => setTimeout(r, 600));
			const entry = v.cardEntries.find((e) => e.holder.section.title.startsWith("2026-08-06"));
			if (entry) v.setRoloActive(entry);
		})()`,
		after: `(async () => {
			const p = app.plugins.plugins["single-file-section-cards"];
			const key = (prefix) => v.cardEntries.find((e) => e.holder.section.title.startsWith(prefix))?.holder.section.headingRaw;
			for (const k of [key("2026-08-05"), key("2026-07-31")]) if (k) await p.setCardColor(v.filePath, k, null, v.viewSettings());
		})()`,
	},
	{
		name: "dashboard",
		note: "Daily Notes 2026.md",
		layout: "dashboard",
		// The sample's tasks carry no due dates, so give a few dates around today for
		// the Needs attention panel (overdue, today, this week); the note is put back after.
		prep: `(async () => {
			const file = app.vault.getAbstractFileByPath(v.filePath);
			window.__sfscDashOriginal = await app.vault.read(file);
			const day = (n) => window.moment().add(n, "days").format("YYYY-MM-DD");
			const dues = [day(-3), day(-1), day(0), day(2), day(5)];
			await app.vault.process(file, (text) => {
				let k = 0;
				return text.split("\\n").map((l) => (k < dues.length && /^\\s*- \\[ \\] /.test(l) ? l + " 📅 " + dues[k++] : l)).join("\\n");
			});
			await new Promise((r) => setTimeout(r, 800));
			await v.refresh();
			await new Promise((r) => setTimeout(r, 500));
		})()`,
		after: `(async () => {
			const file = app.vault.getAbstractFileByPath(v.filePath);
			if (window.__sfscDashOriginal != null) await app.vault.modify(file, window.__sfscDashOriginal);
			delete window.__sfscDashOriginal;
		})()`,
	},
];

/** A made-up journal from 1 January to today for the Heatmap shot: most weekdays
 * written, weekends often skipped, a few tasks and words a day, the odd #tag.
 * Deterministic, so reruns give the same picture for the same day. */
function journalNote() {
	let seed = 7;
	const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
	const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
	const things = ["review the roadmap", "call the dentist", "water the plants", "write up meeting notes", "book train tickets", "fix the gate latch", "send the invoice", "plan the weekend", "read two chapters", "update the budget", "clean the inbox", "go for a run"];
	const tags = ["#writing", "#admin", "#health", "#travel", "#home"];
	const today = new Date();
	const out = ["# Journal 2026", ""];
	let month = -1;
	for (const d = new Date(Date.UTC(today.getFullYear(), 0, 1)); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
		const dow = d.getUTCDay();
		if (rand() < (dow === 0 || dow === 6 ? 0.6 : 0.12)) continue;
		if (d.getUTCMonth() !== month) {
			month = d.getUTCMonth();
			out.push("## " + d.toLocaleString("en", { month: "long", timeZone: "UTC" }), "");
		}
		out.push("### " + d.toISOString().slice(0, 10) + ", " + days[dow], "");
		const n = 1 + Math.floor(rand() * 6);
		const isToday = d.toDateString() === today.toDateString();
		for (let i = 0; i < n; i++) {
			const done = !isToday && rand() < 0.8;
			const tag = rand() < 0.2 ? " " + tags[Math.floor(rand() * tags.length)] : "";
			out.push("- [" + (done ? "x" : " ") + "] " + things[Math.floor(rand() * things.length)] + tag);
		}
		if (rand() < 0.5) out.push("", "A few lines about the day: what went well, what to pick up tomorrow.");
		out.push("");
	}
	return out.join("\n");
}
const vaultDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sample-vault");
SHOTS.push({
	name: "heatmap",
	note: "Journal 2026.md",
	layout: "heatmap",
	// The graph only fills the top of the pane; leave the empty rest out.
	clip: { width: 1280, height: 425 },
	before: () => fs.writeFileSync(path.join(vaultDir, "Journal 2026.md"), journalNote()),
	cleanup: () => fs.rmSync(path.join(vaultDir, "Journal 2026.md"), { force: true }),
	prep: `(async () => { v.heatAnchor = null; v.refresh(); await new Promise((r) => setTimeout(r, 600)); })()`,
});

const only = process.env.ONLY?.split(",").map((n) => n.trim());
const shots = only ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;

const V = `app.workspace.getLeavesOfType("section-cards-view")[0].view`;
const saved = JSON.parse(
	await ev(`(() => { const w = require("electron").remote.getCurrentWindow(); return JSON.stringify({ theme: app.vault.getConfig("theme"), size: w.getContentSize(), left: app.workspace.leftSplit.collapsed, right: app.workspace.rightSplit.collapsed }); })()`),
);
try {
	await ev(`(async () => {
		app.changeTheme("obsidian");
		app.workspace.leftSplit.collapse();
		app.workspace.rightSplit.collapse();
		const style = document.createElement("style");
		style.id = "sfsc-live-shot";
		style.textContent = ".status-bar { display: none; }";
		document.head.appendChild(style);
		require("electron").remote.getCurrentWindow().setContentSize(1280, 760);
		for (const l of app.workspace.getLeavesOfType("section-cards-view")) l.detach();
		for (const l of app.workspace.getLeavesOfType("markdown")) l.detach();
		return 1;
	})()`);
	await sleep(600);
	for (const s of shots) {
		if (s.before) {
			s.before();
			await sleep(1500);
		}
		await ev(`(async () => {
			const leaf = app.workspace.getLeaf("tab") ?? app.workspace.createLeafInParent(app.workspace.rootSplit, 0);
			await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(s.note)}));
			await app.plugins.plugins["single-file-section-cards"].openCardsView(${JSON.stringify(s.note)});
			await new Promise((r) => setTimeout(r, 900));
			for (const l of app.workspace.getLeavesOfType("markdown")) l.detach();
			const v = ${V};
			v.deckMode = false;
			v.switchLayout(${JSON.stringify(s.layout)});
			await new Promise((r) => setTimeout(r, 1200));
			await (${s.prep ?? "null"});
			await new Promise((r) => setTimeout(r, 500));
			return v.layout;
		})()`);
		await shot(s.name, s.clip);
		await ev(`(async () => {
			const v = ${V};
			await (${s.after ?? "null"});
			for (const l of app.workspace.getLeavesOfType("section-cards-view")) l.detach();
			return 1;
		})()`);
		s.cleanup?.();
	}
} finally {
	await ev(`(() => {
		document.getElementById("sfsc-live-shot")?.remove();
		app.changeTheme(${JSON.stringify(saved.theme)});
		if (!${saved.left}) app.workspace.leftSplit.expand();
		if (!${saved.right}) app.workspace.rightSplit.expand();
		require("electron").remote.getCurrentWindow().setContentSize(${saved.size[0]}, ${saved.size[1]});
		return 1;
	})()`);
	ws.close();
}
