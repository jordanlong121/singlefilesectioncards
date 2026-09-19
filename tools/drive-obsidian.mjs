// Drive a running Obsidian over the Chrome DevTools Protocol — no dependencies (Node's
// WebSocket). Start Obsidian with --remote-debugging-port=9222, then:
//   node tools/drive-obsidian.mjs eval "<js expression, may await>"   → prints the value
//   node tools/drive-obsidian.mjs shot <file.png>                       → screenshot
//   node tools/drive-obsidian.mjs hover <css selector>                  → real mouse move
//   node tools/drive-obsidian.mjs click <css selector> [ctrl]           → real mouse click
//   node tools/drive-obsidian.mjs key <key> [ctrl]                      → key press
// PORT overrides 9222; the first "page" target whose title mentions Obsidian is used.
import fs from "fs";

const port = process.env.PORT ?? "9222";
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && /Obsidian/.test(t.title ?? "")) ?? targets.find((t) => t.type === "page");
if (!page) throw new Error("no Obsidian page target on port " + port);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.bad(new Error(JSON.stringify(d.error))) : p.ok(d.result); } };
const send = (method, params = {}) => new Promise((ok, bad) => { const n = ++id; pending.set(n, { ok, bad }); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression) => {
	const r = await send("Runtime.evaluate", { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
	return r.result.value;
};
const rectOf = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
const mouse = async (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, ...extra });

const [cmd, ...args] = process.argv.slice(2);
try {
	if (cmd === "eval") console.log(JSON.stringify(await evaluate(args.join(" ")), null, 1));
	else if (cmd === "shot") { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(args[0], Buffer.from(r.data, "base64")); console.log("wrote", args[0]); }
	else if (cmd === "hover") { const r = await rectOf(args[0]); if (!r) throw new Error("no element: " + args[0]); await mouse("mouseMoved", r.x, r.y); console.log("hovered", args[0], Math.round(r.x), Math.round(r.y)); }
	else if (cmd === "click") { const r = await rectOf(args[0]); if (!r) throw new Error("no element: " + args[0]); const mods = args[1] === "ctrl" ? 2 : 0; await mouse("mouseMoved", r.x, r.y); await mouse("mousePressed", r.x, r.y, { button: "left", clickCount: 1, modifiers: mods }); await mouse("mouseReleased", r.x, r.y, { button: "left", clickCount: 1, modifiers: mods }); console.log("clicked", args[0]); }
	else if (cmd === "key") { const mods = args[1] === "ctrl" ? 2 : 0; await send("Input.dispatchKeyEvent", { type: "keyDown", key: args[0], modifiers: mods, text: args[0].length === 1 ? args[0] : undefined }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: args[0], modifiers: mods }); console.log("pressed", args[0]); }
	else throw new Error("usage: eval|shot|hover|click|key");
} finally { ws.close(); }
