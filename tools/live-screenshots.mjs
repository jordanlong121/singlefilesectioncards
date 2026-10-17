// README screenshots taken from the running Obsidian (not the preview harness): the
// Table, Tree and Binder layouts, whose DOM the harness doesn't mirror. Start Obsidian
// on the sample vault with --remote-debugging-port=9222 (see tools/drive-obsidian.mjs),
// then:
//   node tools/live-screenshots.mjs            → writes screenshots/{table,tree,binder}.png
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
const shot = async (name) => {
	const r = await send("Page.captureScreenshot", { format: "png" });
	fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(r.data, "base64"));
	console.log("wrote screenshots/" + name + ".png");
};

// The shots: which note, which layout, and what to do to it first.
const SHOTS = [
	{ name: "table", note: "Handbook.md", layout: "table" },
	{
		name: "tree",
		note: "Handbook.md",
		layout: "tree",
		// One branch folded, so the chevron's count shows.
		prep: `(() => { const item = [...v.contentEl.querySelectorAll(".sc-tree-item")].find((i) => i.querySelector(":scope > .sc-tree-node .sc-tree-title")?.textContent === "Reference"); item?.querySelector(":scope > .sc-tree-node .sc-tree-toggle")?.click(); })()`,
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
];

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
	for (const s of SHOTS) {
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
		await shot(s.name);
		await ev(`(async () => {
			const v = ${V};
			await (${s.after ?? "null"});
			for (const l of app.workspace.getLeavesOfType("section-cards-view")) l.detach();
			return 1;
		})()`);
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
