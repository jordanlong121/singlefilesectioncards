// Renders the plugin's real DOM structure into a standalone HTML file so it can be
// screenshotted in Chrome with Obsidian's app.css + the user's theme loaded.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseSections, sortSections } from "./harness-bundle/main.js";

const OUT = process.argv[2] ?? "harness.html";
const stylesCss = process.argv[3] ?? fileURLToPath(new URL("../styles.css", import.meta.url));

const notePath = process.env.NOTE ?? fileURLToPath(new URL("../sample-vault/Daily Notes 2026.md", import.meta.url));
const note = fs.readFileSync(notePath, "utf8");
const sections = sortSections(parseSections(note.split(/\r?\n/), Number(process.env.LEVEL ?? 3)), process.env.SORT ?? "asc");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Approximate Obsidian's rendered-markdown DOM for the constructs in this note.
function renderBody(md) {
	const out = [];
	let list = null;
	for (const raw of md.split("\n")) {
		const m = /^(\s*)-\s+(\[[ x]\]\s+)?(.*)$/.exec(raw);
		if (m) {
			if (!list) { out.push('<ul class="contains-task-list has-list-bullet">'); list = true; }
			const task = m[2] ? `<input type="checkbox" class="task-list-item-checkbox"${/x/.test(m[2]) ? " checked" : ""}>` : "";
			const cls = m[2] ? ' class="task-list-item"' : "";
			out.push(`<li${cls}>${task}<span class="list-bullet"></span>${esc(m[3])}</li>`);
		} else {
			if (list) { out.push("</ul>"); list = null; }
			const h = /^(#{1,6})\s+(.*)$/.exec(raw);
			if (h) out.push(`<h${h[1].length}>${esc(h[2])}</h${h[1].length}>`);
			else if (raw.trim()) out.push(`<p dir="auto">${esc(raw)}</p>`);
		}
	}
	if (list) out.push("</ul>");
	return out.join("\n");
}

const cardHtml = (s) => `<div class="section-card">
	<div class="section-card-header">
		<div class="section-card-title">${esc(s.title || "(untitled)")}</div>
		<button class="section-card-open">⤢</button>
	</div>
	<div class="section-card-body markdown-rendered" style="max-height: 320px;">${renderBody(s.body) || '<div class="section-card-placeholder">Empty section — click to add content.</div>'}</div>
</div>`;

const editorCardHtml = (s) => `<div class="section-card is-editing">
	<div class="section-card-header">
		<div class="section-card-title">${esc(s.title)}</div>
		<button class="section-card-open">⤢</button>
	</div>
	<div class="section-card-body markdown-rendered">
		<textarea class="section-card-editor" rows="8">${esc(s.raw)}</textarea>
		<div class="section-card-footer">
			<span class="section-card-hint">Ctrl/⌘+Enter to save · Esc to cancel</span>
			<button>Cancel</button><button class="mod-cta">Save</button>
		</div>
	</div>
</div>`;

// EDIT=1 renders the first card in its inline-editing state.
const cards = (process.env.EDIT ? [editorCardHtml(sections[0]), ...sections.slice(1).map(cardHtml)] : sections.map(cardHtml)).join("\n");

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="app.css">
<link rel="stylesheet" href="theme.css">
<link rel="stylesheet" href="styles.css">
<style>
/* Harness-only: the real app sizes the workspace chain via classes/JS we don't reproduce. */
.workspace-split.mod-root, .workspace-tabs, .workspace-tab-container, .workspace-leaf, .workspace-leaf-content {
	width: 100% !important; height: 100% !important; flex: 1 1 auto !important;
}
</style>
</head>
<body class="theme-dark mod-windows is-focused preset-default bg-auto no-animation disable-splash-screen">
<div class="app-container"><div class="horizontal-main-container"><div class="workspace">
<div class="workspace-split mod-root mod-vertical"><div class="workspace-tabs mod-top mod-active"><div class="workspace-tab-container">
<div class="workspace-leaf mod-active"><div class="workspace-leaf-content" data-type="section-cards-view">
<div class="view-content section-cards-view">
	<div class="section-cards-toolbar">
		<button class="section-cards-file-btn"><span>${path.basename(notePath)}</span></button>
		<div class="section-cards-spacer"><span class="section-cards-count">${sections.length} sections · H${process.env.LEVEL ?? 3}</span></div>
		<div class="section-cards-control"><span class="section-cards-label">Heading</span><select class="dropdown"><option>H${process.env.LEVEL ?? 3}</option></select></div>
		<div class="section-cards-control"><span class="section-cards-label">Sort</span><select class="dropdown"><option>A → Z</option></select></div>
		<button class="section-cards-icon-btn">↻</button>
	</div>
	<div class="section-cards-grid">
${cards}
	</div>
</div>
</div></div></div></div></div></div></div></div>
</body></html>`;

fs.writeFileSync(OUT, html);
fs.copyFileSync(stylesCss, path.join(path.dirname(OUT), "styles.css"));
console.log("wrote", OUT, "with", sections.length, "cards", process.env.EDIT ? "(first card in edit mode)" : "");
