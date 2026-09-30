// Links to a card's heading — `[[Note#Heading]]`, `![[Note#Heading]]`, `[text](Note.md#Heading)` —
// found across the vault and rewritten when the card is renamed, so they keep landing on it.

import { App, TFile, parseLinktext, resolveSubpath } from "obsidian";
import { processNote } from "./history";

/** One link to rewrite: its span in the source file, the text expected there, and the new text. */
export interface LinkEdit {
	start: number;
	end: number;
	from: string;
	to: string;
}

/** Characters a heading link can't carry; Obsidian writes a space in their place. */
const LINK_UNSAFE_RE = /[#|^:[\]\\]/g;

/** A heading's text as it reads in a link. */
function linkHeading(title: string): string {
	return title.replace(LINK_UNSAFE_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * Every link in the vault that points at the heading on `line` of `target`, grouped by
 * the source file's path, each with its rewritten text for the heading `newTitle`. Read
 * from the metadata cache, so a heading the cache doesn't yet know at that line (the
 * note just changed) yields nothing rather than a wrong match. Only the link's last
 * heading segment changes; its note path and any alias stay as written.
 */
export function headingLinkEdits(app: App, target: TFile, line: number, oldTitle: string, newTitle: string): Map<string, LinkEdit[]> {
	const out = new Map<string, LinkEdit[]>();
	const targetCache = app.metadataCache.getFileCache(target);
	const heading = targetCache?.headings?.find((h) => h.position.start.line === line);
	if (!targetCache || !heading || heading.heading.trim() !== oldTitle.trim()) return out;
	const newSegment = linkHeading(newTitle);
	if (!newSegment) return out;

	for (const [source, dests] of Object.entries(app.metadataCache.resolvedLinks)) {
		if (!dests[target.path]) continue;
		const sourceCache = app.metadataCache.getCache(source);
		const refs = [...(sourceCache?.links ?? []), ...(sourceCache?.embeds ?? [])];
		for (const ref of refs) {
			const { path, subpath } = parseLinktext(ref.link);
			if (!subpath || subpath.startsWith("#^")) continue;
			const dest = path ? app.metadataCache.getFirstLinkpathDest(path, source) : app.vault.getFileByPath(source);
			if (dest?.path !== target.path) continue;
			const resolved = resolveSubpath(targetCache, subpath);
			if (resolved?.type !== "heading" || resolved.current.position.start.line !== line) continue;

			// Swap the last `#segment`; a `#Parent#Child` chain keeps its parents.
			const segments = subpath.split("#");
			segments[segments.length - 1] = newSegment;
			const newLink = path + segments.join("#");
			// Wikilinks carry the link text as typed. A Markdown link may carry the old text
			// encoded or not, but the new text must have its spaces encoded to stay a link.
			const encodings: ((s: string) => string)[] = [(s) => s, (s) => s.replace(/ /g, "%20"), encodeURI];
			const found = encodings.find((enc) => ref.original.includes(enc(ref.link)));
			if (!found) continue;
			const wiki = /^!?\[\[/.test(ref.original);
			const to = ref.original.replace(found(ref.link), wiki ? newLink : newLink.replace(/ /g, "%20"));
			if (to === ref.original) continue;
			const edits = out.get(source) ?? [];
			edits.push({ start: ref.position.start.offset, end: ref.position.end.offset, from: ref.original, to });
			out.set(source, edits);
		}
	}
	return out;
}

/** Apply link edits to a file's text, last first so earlier offsets hold; an edit whose
 * span no longer holds the expected text (the file moved on) is skipped. */
export function applyLinkEdits(data: string, edits: LinkEdit[]): { text: string; applied: number } {
	let text = data;
	let applied = 0;
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
		if (text.slice(edit.start, edit.end) !== edit.from) continue;
		text = text.slice(0, edit.start) + edit.to + text.slice(edit.end);
		applied++;
	}
	return { text, applied };
}

/** Rewrite the links in every file but `skip` (the renamed note, which writes its own
 * along with the heading). Returns how many links changed, and in how many notes. */
export async function applyLinkEditsElsewhere(app: App, edits: Map<string, LinkEdit[]>, skip: string): Promise<{ links: number; notes: number }> {
	let links = 0;
	let notes = 0;
	for (const [path, list] of edits) {
		if (path === skip) continue;
		const file = app.vault.getFileByPath(path);
		if (!file) continue;
		let applied = 0;
		await processNote(app, file, "Update heading links", (data) => {
			const result = applyLinkEdits(data, list);
			applied = result.applied;
			return result.text;
		});
		if (applied) {
			links += applied;
			notes++;
		}
	}
	return { links, notes };
}
