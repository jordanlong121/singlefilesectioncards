// Renders the plugin's real DOM structure into standalone HTML files — one per layout —
// so they can be screenshotted in headless Chrome with Obsidian's app.css loaded.
//
// Usage:
//   node test/run.mjs                      # builds test/.tmp/main.js (the parse bundle)
//   node tools/asar-extract.mjs <obsidian.asar> app.css   # run inside the out dir
//   node tools/preview-harness.mjs <outdir>
//   chrome --headless=new --screenshot=grid.png --window-size=1280,760 <outdir>/grid.html
//
// The HTML mirrors the classes and nesting main.ts builds (toolbar with the filter box,
// pinned band, grid/tray/zoom for the Custom Grid) plus an inline script that replays
// layoutMasonry/insertRowRules, so styles.css lays the cards out exactly like the app.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseCards, sortSections } from "../test/.tmp/main.js";

const OUT_DIR = process.argv[2] ?? "harness-out";
const here = path.dirname(fileURLToPath(import.meta.url));
const notePath = process.env.NOTE ?? path.join(here, "..", "sample-vault", "Daily Notes 2026.md");
const LEVEL = Number(process.env.LEVEL ?? 3);
const SORT = process.env.SORT ?? "desc";
/** The card highlighted as "today" — the newest date in the sample vault. */
const TODAY = process.env.TODAY ?? "2026-08-06";

const note = fs.readFileSync(notePath, "utf8");
const sections = sortSections(parseCards(note.split(/\r?\n/), LEVEL, null), SORT);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) =>
	esc(s)
		.replace(/\[\[([^\]]+)\]\]/g, (_, t) => `<a class="internal-link" data-href="${t}" href="${t}">${t}</a>`)
		.replace(/(^|\s)(#[\w/-]+)/g, (_, sp, tag) => `${sp}<a href="${tag}" class="tag" target="_blank" rel="noopener">${tag}</a>`)
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/\*([^*]+)\*/g, "<em>$1</em>");

const TASK = /^(\s*)- (?:\[([ x])\] )?(.*)$/;

/** Approximate Obsidian's reading-view DOM for the constructs in the sample vault:
 * paragraphs, task lists with one level of nesting, #tags, [[wikilinks]]. */
function renderBody(md) {
	const lines = md.split("\n");
	const out = [];
	let i = 0;
	const li = (mark, text, kidsHtml = "") => {
		const isTask = mark !== undefined;
		const checked = mark === "x";
		const box = isTask ? `<input type="checkbox" class="task-list-item-checkbox"${checked ? " checked" : ""}> ` : "";
		const cls = isTask ? ` class="task-list-item${checked ? " is-checked" : ""}" data-task="${checked ? "x" : " "}"` : "";
		return `<li${cls}>${box}${inline(text)}${kidsHtml}</li>`;
	};
	while (i < lines.length) {
		if (!lines[i].trim()) {
			i++;
			continue;
		}
		const m = TASK.exec(lines[i]);
		if (m && !m[1]) {
			out.push('<ul class="contains-task-list">');
			while (i < lines.length) {
				const t = TASK.exec(lines[i]);
				if (!t || t[1]) break;
				const kids = [];
				let j = i + 1;
				for (; j < lines.length; j++) {
					const k = TASK.exec(lines[j]);
					if (k && k[1]) kids.push(k);
					else break;
				}
				const kidsHtml = kids.length
					? '<ul class="contains-task-list">' + kids.map((k) => li(k[2], k[3])).join("") + "</ul>"
					: "";
				out.push(li(t[2], t[3], kidsHtml));
				i = j;
			}
			out.push("</ul>");
		} else {
			const para = [];
			while (i < lines.length && lines[i].trim() && !TASK.exec(lines[i])) para.push(lines[i++]);
			out.push(`<p dir="auto">${inline(para.join(" "))}</p>`);
		}
	}
	return out.join("\n");
}

/** Header buttons exist on every card (opacity 0 until hover), matching renderCard. */
const HEADER_BUTTONS = `<button class="section-card-untray"></button><button class="section-card-quickadd"></button><button class="section-card-pin"></button><button class="section-card-delete"></button><button class="section-card-big"></button><button class="section-card-open">↗</button>`;

function cardHtml(s, { maxHeight = null, placed = null } = {}) {
	const today = s.title.includes(TODAY) ? " is-today" : "";
	const placedCls = placed ? " is-placed" : "";
	const style = placed ? ` style="left:${placed.x}px;top:${placed.y}px;width:${placed.w}px;height:${placed.h}px"` : "";
	const bodyStyle = maxHeight ? ` style="max-height: ${maxHeight}px;"` : "";
	return `<div class="section-card${today}${placedCls}"${style} draggable="true">
	<div class="section-card-header is-click-big">
		<div class="section-card-title">${esc(s.title || "(untitled)")}</div>${HEADER_BUTTONS}
	</div>
	<div class="section-card-body markdown-rendered"${bodyStyle}>${renderBody(s.body) || '<div class="section-card-placeholder">Empty section — click to add content.</div>'}</div>
</div>`;
}

const DECK_ICON = `<svg viewBox="0 0 100 100" class="svg-icon" width="16" height="16"><g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="9" width="12" height="12.5" rx="2"/><path d="M5.5 6h10a2 2 0 0 1 2 2v10"/><path d="M8.5 3h10a2 2 0 0 1 2 2v10"/></g></svg>`;

const LAYOUT_LABELS = { grid: "Grid", aligned: "Grid Aligned", tight: "Tight", horizontal: "Horizontal", vertical: "Vertical", custom: "Custom Grid" };
const SORT_LABELS = { asc: "A → Z", desc: "Z → A", doc: "Document order" };

function toolbarHtml(layout) {
	return `<div class="section-cards-toolbar">
	<button class="section-cards-file-btn"><span>${path.basename(notePath)}</span></button>
	<div class="section-cards-spacer"><span class="section-cards-count">${sections.length} sections · H${LEVEL}</span></div>
	<div class="section-cards-control section-cards-filter"><input type="text" class="section-cards-filter-input" placeholder="Filter…" spellcheck="false"><button class="section-cards-filter-clear"></button></div>
	<div class="section-cards-control"><span class="section-cards-label">Heading</span><select class="dropdown"><option>H${LEVEL}</option></select></div>
	<div class="section-cards-control"><span class="section-cards-label">Layout</span><select class="dropdown"><option>${LAYOUT_LABELS[layout]}</option></select></div>
	<div class="section-cards-control"><span class="section-cards-label">Sort</span><select class="dropdown"><option>${SORT_LABELS[SORT]}</option></select></div>
	<button class="section-cards-new-btn mod-cta">+ New card</button>
	<button class="section-cards-icon-btn">↻</button>
</div>`;
}

/** Custom Grid: placed cards (snap 24, gap ≥12), the rest listed in the tray.
 * Override with PLACEMENTS='[{"x":48,"y":48,"w":312,"h":216},…]' to stage other scenes;
 * placements map onto the sorted sections in order. */
const PLACEMENTS = process.env.PLACEMENTS
	? JSON.parse(process.env.PLACEMENTS)
	: [
			{ x: 48, y: 48, w: 408, h: 480 },
			{ x: 480, y: 48, w: 312, h: 216 },
			{ x: 480, y: 288, w: 312, h: 240 },
		];

function gridHtml(layout) {
	if (layout === "custom") {
		const placedCards = sections.slice(0, PLACEMENTS.length).map((s, i) => cardHtml(s, { placed: PLACEMENTS[i] }));
		const hidden = sections.slice(PLACEMENTS.length).map((s) => cardHtml(s));
		const tiles = sections
			.slice(PLACEMENTS.length)
			.map((s) => `<div class="section-cards-tray-tile${s.title.includes(TODAY) ? " is-today" : ""}">${esc(s.title)}</div>`)
			.join("\n");
		return `<div class="section-cards-pinned"></div>
<div class="section-cards-grid" style="--sc-zoom: 1;">
<div class="section-cards-canvas-extent" style="left: 1447px; top: 1049px;"></div>
${placedCards.join("\n")}
${hidden.join("\n")}
</div>
<div class="section-cards-tray">
	<div class="section-cards-tray-actions"><button class="section-cards-tray-clear">Clear layout</button></div>
	<div class="section-cards-tray-sorts"><button class="section-cards-tray-sort${SORT === "asc" ? " is-active" : ""}">A→Z</button><button class="section-cards-tray-sort${SORT === "desc" ? " is-active" : ""}">Z→A</button><button class="section-cards-tray-sort${SORT === "doc" ? " is-active" : ""}">Doc</button></div>
	<div class="section-cards-tray-hint">Drag a section onto the canvas</div>
${tiles}
</div>
<div class="section-cards-zoom"><button>−</button><button class="section-cards-zoom-label">100%</button><button>+</button></div>`;
	}
	const maxHeight = layout === "vertical" ? null : layout === "tight" ? 190 : 320;
	return `<div class="section-cards-pinned"></div>
<div class="section-cards-grid">
${sections.map((s) => cardHtml(s, { maxHeight })).join("\n")}
</div>
<div class="section-cards-tray"></div>`;
}

/** Lucide path data for the icons openBlockMenu uses, so the staged menu matches the app. */
const LUCIDE = {
	"arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
	"arrow-down": '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
	check: '<path d="M20 6 9 17l-5-5"/>',
	pencil:
		'<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
	"list-plus": '<path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="M18 9v6"/><path d="M21 12h-6"/>',
	"trash-2":
		'<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
};

const menuItem = (icon, title, selected = false) =>
	`<div class="menu-item tappable${selected ? " selected" : ""}"><div class="menu-item-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-${icon}">${LUCIDE[icon]}</svg></div><div class="menu-item-title">${esc(title)}</div></div>`;

/** The block context menu exactly as openBlockMenu builds it for an unchecked task
 * on a middle card with the Tasks plugin installed. Anchored beside that task by
 * MENU_SCRIPT once the grid has packed. */
function menuHtml() {
	const label = (target) => {
		const title = target.title || "(untitled)";
		return title.length > 28 ? `${title.slice(0, 27)}…` : title;
	};
	return `<div class="menu" style="left: 0; top: 0;"><div class="menu-scroll">
${menuItem("arrow-up", `Move line to previous card (${label(sections[0])})`)}
${menuItem("arrow-down", `Move line to next card (${label(sections[2])})`)}
<div class="menu-separator"></div>
${menuItem("check", "Mark done")}
${menuItem("pencil", "Edit task (Tasks)…", true)}
${menuItem("list-plus", "New task below (Tasks)…")}
${menuItem("trash-2", "Delete line")}
</div></div>`;
}

/** Positions the staged menu as showAtMouseEvent would: at a right-click on the
 * second card's first unchecked task. Runs after PACK_SCRIPT has laid cards out. */
const MENU_SCRIPT = `<script>
(() => {
	const menu = document.querySelector(".menu");
	if (!menu) return;
	const cards = [...document.querySelectorAll(".section-cards-grid > .section-card")];
	const line = cards[1]?.querySelector("li.task-list-item:not(.is-checked)");
	if (!line) return;
	const r = line.getBoundingClientRect();
	menu.style.left = Math.round(r.left + r.width * 0.45) + "px";
	menu.style.top = Math.round(r.bottom + 4) + "px";
})();
</script>`;

/** Replays layoutMasonry + insertRowRules so styles.css packs cards like the app does. */
const PACK_SCRIPT = `<script>
(() => {
	const layout = document.currentScript.dataset.layout;
	const grid = document.querySelector(".section-cards-grid");
	if (layout === "vertical" || layout === "custom") return;
	const style = getComputedStyle(grid);
	const cards = [...grid.children].filter((c) => c.classList.contains("section-card"));
	const columns = style.gridTemplateColumns.split(" ").filter((t) => t.trim()).length;
	if (layout === "aligned") {
		for (let i = columns; i < cards.length; i += columns) {
			const rule = document.createElement("div");
			rule.className = "section-cards-row-rule";
			grid.insertBefore(rule, cards[i]);
		}
		return;
	}
	if (columns <= 1) { grid.classList.add("is-one-col"); return; }
	const rowH = parseFloat(style.gridAutoRows) || 4;
	const gap = parseFloat(style.rowGap) || 0;
	const cardGap = parseFloat(style.getPropertyValue("--sc-card-gap")) || 12;
	const heights = cards.map((c) => c.getBoundingClientRect().height);
	cards.forEach((c, i) => { c.style.gridRowEnd = "span " + Math.max(1, Math.ceil((heights[i] + cardGap) / (rowH + gap))); });
})();
</script>`;

function pageHtml(layout, { withMenu = false } = {}) {
	return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="app.css">
<link rel="stylesheet" href="theme.css">
<link rel="stylesheet" href="styles.css">
<style>
/* Harness-only: the real app sizes the workspace chain via JS we don't reproduce. */
html, body { height: 100%; margin: 0; }
.app-container, .horizontal-main-container, .workspace { height: 100%; display: flex; flex-direction: column; }
.workspace-split.mod-root { flex: 1 1 auto; min-height: 0; display: flex; }
.workspace-tabs { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.workspace-tab-container { flex: 1 1 auto; min-height: 0; display: flex; }
.workspace-leaf { flex: 1 1 auto; min-width: 0; display: flex; }
.workspace-leaf-content { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
</style>
</head>
<body class="theme-dark mod-windows is-focused preset-default bg-auto no-animation disable-splash-screen">
<div class="app-container"><div class="horizontal-main-container"><div class="workspace">
<div class="workspace-split mod-root mod-vertical"><div class="workspace-tabs mod-top mod-active">
<div class="workspace-tab-header-container">
	<div class="workspace-tab-header-container-inner">
		<div class="workspace-tab-header tappable is-active mod-active">
			<div class="workspace-tab-header-inner">
				<div class="workspace-tab-header-inner-icon">${DECK_ICON}</div>
				<div class="workspace-tab-header-inner-title">Cards: ${esc(path.basename(notePath, ".md"))}</div>
			</div>
		</div>
	</div>
	<div class="workspace-tab-header-spacer"></div>
</div>
<div class="workspace-tab-container">
<div class="workspace-leaf mod-active"><div class="workspace-leaf-content" data-type="section-cards-view">
<div class="view-content section-cards-view is-layout-${layout}">
${toolbarHtml(layout)}
${gridHtml(layout)}
</div>
</div></div></div></div></div></div></div></div>
${withMenu ? menuHtml() : ""}
${PACK_SCRIPT.replace("<script>", `<script data-layout="${layout}">`)}
${withMenu ? MENU_SCRIPT : ""}
</body></html>`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.copyFileSync(path.join(here, "..", "styles.css"), path.join(OUT_DIR, "styles.css"));
if (!fs.existsSync(path.join(OUT_DIR, "theme.css"))) fs.writeFileSync(path.join(OUT_DIR, "theme.css"), "");
for (const layout of Object.keys(LAYOUT_LABELS)) {
	fs.writeFileSync(path.join(OUT_DIR, `${layout}.html`), pageHtml(layout));
}
fs.writeFileSync(path.join(OUT_DIR, "context-menu.html"), pageHtml("grid", { withMenu: true }));
console.log("wrote", Object.keys(LAYOUT_LABELS).length + 1, "pages to", OUT_DIR, "with", sections.length, "cards");
