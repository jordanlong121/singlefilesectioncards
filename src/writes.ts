// Every write to the note: sections, blocks, and ranges, re-located and verified at write time.

import { App, Notice, TFile } from "obsidian";
import { Placement } from "./settings";
import { Section, HEADING_RE, parseSections, bodyStartLine, insertionLine, locateSection, locateCard } from "./sections";
import {
	TOP_ITEM_RE,
	sectionBlocks,
	movableBlocks,
	toggleStarInLine,
	flipMarkerLine,
	moveBlockBetween,
	removeBlock,
} from "./blocks";
import { plannerCards } from "./planner";
import { mergeFeedLines } from "./icalfeed";

/** Delete a block at write time, re-locating the section and verifying the block's text. */
export async function deleteBlockInFile(
	app: App,
	file: TFile,
	level: number,
	from: Section,
	blockIndex: number,
	expectedBlockText: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, from);
		if (!target) {
			ok = false;
			return data;
		}
		const body = lines.slice(bodyStartLine(target), target.endLine);
		const block = movableBlocks(body)[blockIndex];
		if (!block || body.slice(block.start, block.end).join("\n") !== expectedBlockText) {
			ok = false; // the block moved or changed since the menu opened — refuse
			return data;
		}
		const result = removeBlock(lines, target, blockIndex);
		return result ? result.join(eol) : data;
	});

	return ok;
}

/** Move a block at write time, re-locating both sections and verifying the block's text. */
export async function moveBlockInFile(
	app: App,
	file: TFile,
	level: number,
	moved: Section,
	blockIndex: number,
	expectedBlockText: string,
	targetSection: Section,
	anchorIndex: number | "start" | null,
	anchorSide: "before" | "after" = "before",
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const from = locateCard(lines, level, moved);
		const to = locateCard(lines, level, targetSection);
		if (!from || !to) {
			ok = false;
			return data;
		}
		const body = lines.slice(bodyStartLine(from), from.endLine);
		const block = movableBlocks(body)[blockIndex];
		if (!block || body.slice(block.start, block.end).join("\n") !== expectedBlockText) {
			ok = false; // the block moved or changed since the drag started — refuse
			return data;
		}
		const result = moveBlockBetween(lines, from, blockIndex, to, anchorIndex, anchorSide);
		return result ? result.join(eol) : data;
	});

	return ok;
}

/** Star or unstar a block at write time, re-locating the section and verifying the
 * block's text the same way delete and move do. */
export async function toggleStarInFile(
	app: App,
	file: TFile,
	level: number,
	from: Section,
	blockIndex: number,
	expectedBlockText: string,
	emoji: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, from);
		if (!target) {
			ok = false;
			return data;
		}
		const bodyStart = bodyStartLine(target);
		const body = lines.slice(bodyStart, target.endLine);
		const block = movableBlocks(body)[blockIndex];
		if (!block || body.slice(block.start, block.end).join("\n") !== expectedBlockText) {
			ok = false; // the block moved or changed since the menu opened — refuse
			return data;
		}
		lines[bodyStart + block.start] = toggleStarInLine(lines[bodyStart + block.start], emoji);
		return lines.join(eol);
	});

	return ok;
}

/** A note's folder prefix ("Senstar/" or "" at the vault root), for sibling paths. */
export function noteFolderOf(file: TFile): string {
	return file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
}

/**
 * [start, end) covering a section plus the blank separator lines that followed it, so
 * deleting a card doesn't leave doubled blank lines between its neighbours.
 */
export function sectionDeleteRange(lines: string[], target: Section): [number, number] {
	let end = target.endLine;
	while (end < lines.length && lines[end].trim() === "") end++;
	return [target.startLine, end];
}

/**
 * Move the section at fromIndex so it sits before the section at toBeforeIndex
 * (toBeforeIndex === sections.length means the end of the file). The moved chunk keeps
 * its own lines byte-for-byte; blank separators are added or dropped only at the seams.
 * Returns null for out-of-range indices or a move that changes nothing.
 */
export function moveSection(
	lines: string[],
	level: number,
	fromIndex: number,
	toBeforeIndex: number,
): string[] | null {
	const sections = parseSections(lines, level);
	if (fromIndex < 0 || fromIndex >= sections.length) return null;
	if (toBeforeIndex < 0 || toBeforeIndex > sections.length) return null;
	if (toBeforeIndex === fromIndex || toBeforeIndex === fromIndex + 1) return null;

	// Reordering must not change how the file ends (e.g. its trailing newline).
	let tailBlanks = 0;
	while (tailBlanks < lines.length && lines[lines.length - 1 - tailBlanks].trim() === "") tailBlanks++;

	const [start, end] = sectionDeleteRange(lines, sections[fromIndex]);
	const chunk = lines.slice(start, end);

	const insertLine = toBeforeIndex === sections.length ? lines.length : sections[toBeforeIndex].startLine;
	const rest = lines.slice(0, start).concat(lines.slice(end));
	const target = Math.min(insertLine > start ? insertLine - (end - start) : insertLine, rest.length);

	// Blank separators exist at both seams of the new position...
	if (chunk.length && chunk[chunk.length - 1].trim() !== "") chunk.push("");
	if (target > 0 && rest[target - 1].trim() !== "") chunk.unshift("");
	rest.splice(target, 0, ...chunk);

	// ...and the file's tail is normalised back to what it was.
	while (rest.length && rest[rest.length - 1].trim() === "") rest.pop();
	for (let i = 0; i < tailBlanks; i++) rest.push("");
	return rest;
}

/** Reorder at write time, re-locating both sections like every other write. */
export async function moveSectionInFile(
	app: App,
	file: TFile,
	level: number,
	moved: Section,
	targetSection: Section,
	before: boolean,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const sections = parseSections(lines, level);
		const from = locateSection(sections, moved);
		const to = locateSection(sections, targetSection);
		if (!from || !to) {
			ok = false;
			return data;
		}
		const result = moveSection(lines, level, from.index, to.index + (before ? 0 : 1));
		return result ? result.join(eol) : data; // null = no-op move, not an error
	});

	return ok;
}

/**
 * Merge one section into another: `from`'s body lines land at the bottom of `into`'s
 * body (like a Quick Add), and `from`'s section — heading included — is removed.
 * Both sections must come from a fresh parse of `lines`.
 */
export function mergeSections(lines: string[], from: Section, into: Section): string[] {
	// Merging must not change how the file ends (e.g. its trailing newline).
	let tailBlanks = 0;
	while (tailBlanks < lines.length && lines[lines.length - 1 - tailBlanks].trim() === "") tailBlanks++;

	const body = lines.slice(bodyStartLine(from), from.endLine);
	while (body.length && body[body.length - 1].trim() === "") body.pop();
	const [delStart, delEnd] = sectionDeleteRange(lines, from);
	const out = lines.slice(0, delStart).concat(lines.slice(delEnd));
	// into.endLine excludes the blank separator; shift it when `from` sat above it.
	const at = delEnd <= into.endLine ? into.endLine - (delEnd - delStart) : into.endLine;
	out.splice(at, 0, ...body);

	while (out.length && out[out.length - 1].trim() === "") out.pop();
	for (let i = 0; i < tailBlanks; i++) out.push("");
	return out;
}

/** Calendar merge at write time, re-locating both sections like every other write. */
export async function mergeSectionsInFile(
	app: App,
	file: TFile,
	level: number,
	fromOriginal: Section,
	intoOriginal: Section,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const from = locateCard(lines, level, fromOriginal);
		const into = locateCard(lines, level, intoOriginal);
		if (!from || !into || from.unfiled || into.unfiled || from.startLine === into.startLine) {
			ok = false;
			return data;
		}
		return mergeSections(lines, from, into).join(eol);
	});

	return ok;
}

/** Rewrite a card's heading line (Calendar day move); the body stays byte-for-byte. */
export async function retitleSectionInFile(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	newHeading: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);
		if (!target || target.unfiled) {
			ok = false;
			return data;
		}
		const out = lines.slice();
		out[target.startLine] = newHeading;
		return out.join(eol);
	});

	return ok;
}

/** Where Quick Add drops its text within the section body. The "back-" pair targets
 * the text below the card's back-side marker (Card Flip); without one they act on the
 * whole body like their front counterparts. */
export type QuickAddPlacement = "top" | "bottom" | "back-top" | "back-bottom";

/**
 * Insert text lines into a section's body: "top" goes right under the heading, "bottom"
 * right after the last content line (before the blank separator, which endLine excludes).
 * With a back-side `marker` present in the body, "bottom" stops above the marker (and
 * the blank gap before it), "back-top" lands right under the marker, and "back-bottom"
 * at the section's end.
 */
export function insertIntoSection(
	lines: string[],
	section: Section,
	text: string,
	where: QuickAddPlacement,
	marker = "",
): string[] {
	const insert = text.replace(/\s+$/, "").split(/\r?\n/);
	const bodyStart = bodyStartLine(section);
	const body = lines.slice(bodyStart, section.endLine);
	const m = marker ? flipMarkerLine(body, marker) : -1;
	let at: number;
	if (m < 0) {
		at = where === "top" || where === "back-top" ? bodyStart : section.endLine;
	} else if (where === "top") {
		at = bodyStart;
	} else if (where === "bottom") {
		let end = m;
		while (end > 0 && body[end - 1].trim() === "") end--;
		at = bodyStart + end;
	} else if (where === "back-top") {
		at = bodyStart + m + 1;
	} else {
		at = section.endLine;
	}
	const out = lines.slice();
	out.splice(at, 0, ...insert);
	return out;
}

/** Quick Add's write: re-locates the section at write time like every other write. */
export async function quickAddToSection(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	text: string,
	where: QuickAddPlacement,
	marker = "",
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);
		if (!target) {
			ok = false;
			return data;
		}
		return insertIntoSection(lines, target, text, where, marker).join(eol);
	});

	return ok;
}

/**
 * Insert text right after a movable block. Paragraph content gets blank-line separation
 * from non-blank neighbours — the same padding a block move applies — so a pasted
 * paragraph doesn't merge into the block above or the paragraph below.
 */
export function insertAfterBlock(lines: string[], section: Section, blockIndex: number, text: string): string[] | null {
	const bodyStart = bodyStartLine(section);
	const body = lines.slice(bodyStart, section.endLine);
	const block = movableBlocks(body)[blockIndex];
	if (!block) return null;
	const ins = text.replace(/\s+$/, "").split(/\r?\n/);
	const kinds = sectionBlocks(ins);
	const at = bodyStart + block.end;
	const out = lines.slice();
	if (kinds[0]?.kind === "paragraph" && at > 0 && out[at - 1].trim() !== "") ins.unshift("");
	if (kinds[kinds.length - 1]?.kind === "paragraph" && at < out.length && out[at].trim() !== "") ins.push("");
	out.splice(at, 0, ...ins);
	return out;
}

/** Paste at a section's end: like Quick Add's bottom insert, but a pasted paragraph
 * gets a blank line above it so it doesn't merge into the last line of the body. */
export async function pasteAtSectionEnd(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	text: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);
		if (!target) {
			ok = false;
			return data;
		}
		const ins = text.replace(/\s+$/, "").split(/\r?\n/);
		const at = target.endLine;
		if (sectionBlocks(ins)[0]?.kind === "paragraph" && at > 0 && lines[at - 1].trim() !== "") ins.unshift("");
		const out = lines.slice();
		out.splice(at, 0, ...ins);
		return out.join(eol);
	});

	return ok;
}

/**
 * Paste above a section's first sub-heading — into the Day Planner's loose card — so
 * new body text doesn't fall under the last subcard; at the section's end when it has
 * no sub-headings. Paragraph content gets a blank line from a non-blank line above,
 * and the sub-heading keeps a blank line before it.
 */
export async function pasteAboveSubheadings(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	text: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);
		if (!target) {
			ok = false;
			return data;
		}
		const bodyStart = bodyStartLine(target);
		const body = lines.slice(bodyStart, target.endLine);
		const firstSub = plannerCards(body).find((c) => c.kind === "sub");
		const ins = text.replace(/\s+$/, "").split(/\r?\n/);
		let at: number;
		if (firstSub) {
			// Above the heading, closing up the blank lines that separate it from the loose
			// text, then restoring one below what's inserted.
			let end = firstSub.start;
			while (end > 0 && body[end - 1].trim() === "") end--;
			at = bodyStart + end;
			ins.push("");
		} else {
			at = target.endLine;
		}
		if (sectionBlocks(ins)[0]?.kind === "paragraph" && at > 0 && lines[at - 1].trim() !== "") ins.unshift("");
		const out = lines.slice();
		out.splice(at, 0, ...ins);
		return out.join(eol);
	});

	return ok;
}

/** Replace one movable block's lines at write time, re-locating the section and
 * verifying the block's text the same way delete and move do. */
export async function replaceBlockInFile(
	app: App,
	file: TFile,
	level: number,
	from: Section,
	blockIndex: number,
	expectedBlockText: string,
	newText: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, from);
		if (!target) {
			ok = false;
			return data;
		}
		const bodyStart = bodyStartLine(target);
		const body = lines.slice(bodyStart, target.endLine);
		const block = movableBlocks(body)[blockIndex];
		if (!block || body.slice(block.start, block.end).join("\n") !== expectedBlockText) {
			ok = false; // the block moved or changed since the menu opened — refuse
			return data;
		}
		lines.splice(bodyStart + block.start, block.end - block.start, ...newText.replace(/\s+$/, "").split(/\r?\n/));
		return lines.join(eol);
	});

	return ok;
}

/**
 * Day Planner: move a run of a section's body lines — a sub-heading with what's under
 * it, or a lone line — to `insertAt` (a body line of `to`, which may be the same
 * section), verifying the run's text first. A drop back inside its own range is a
 * no-op. Blank lines are added at the seams where the join would otherwise merge
 * prose into a neighbour or butt a heading against the line above.
 */
export async function moveRangeInFile(
	app: App,
	file: TFile,
	level: number,
	from: Section,
	start: number,
	end: number,
	expectedText: string,
	to: Section,
	insertAt: number,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const fromT = locateCard(lines, level, from);
		const toT = from.startLine === to.startLine ? fromT : locateCard(lines, level, to);
		if (!fromT || !toT) {
			ok = false;
			return data;
		}
		const fromStart = bodyStartLine(fromT);
		if (lines.slice(fromStart + start, fromStart + end).join("\n") !== expectedText) {
			ok = false; // the run moved or changed since the drag started — refuse
			return data;
		}
		const absStart = fromStart + start;
		const absEnd = fromStart + end;
		const toStart = bodyStartLine(toT);
		const absAt = toStart + Math.max(0, Math.min(insertAt, toT.endLine - toStart));
		if (fromT === toT && absAt >= absStart && absAt <= absEnd) return data;

		const run = lines.slice(absStart, absEnd);
		const out = lines.slice(0, absStart).concat(lines.slice(absEnd));
		const at = absAt > absStart ? absAt - run.length : absAt;
		const prose = (line: string | undefined) =>
			line !== undefined && line.trim() !== "" && !TOP_ITEM_RE.test(line) && !HEADING_RE.test(line);
		const first = run[0];
		const last = run[run.length - 1];
		if (at > 0 && out[at - 1].trim() !== "" && (prose(first) || HEADING_RE.test(first) || prose(out[at - 1]))) run.unshift("");
		if (last !== undefined && last.trim() !== "" && at < out.length && out[at].trim() !== "") run.push("");
		out.splice(at, 0, ...run);
		return out.join(eol);
	});

	return ok;
}

/** Day Planner: rewrite a run of a section's body lines (a subcard's text), verifying
 * the run first the way the block writers do. */
export async function replaceRangeInFile(
	app: App,
	file: TFile,
	level: number,
	from: Section,
	start: number,
	end: number,
	expectedText: string,
	newText: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, from);
		if (!target) {
			ok = false;
			return data;
		}
		const bodyStart = bodyStartLine(target);
		if (lines.slice(bodyStart + start, bodyStart + end).join("\n") !== expectedText) {
			ok = false;
			return data;
		}
		lines.splice(bodyStart + start, end - start, ...newText.replace(/\s+$/, "").split(/\r?\n/));
		return lines.join(eol);
	});

	return ok;
}

/**
 * Delete a body-relative line range of a card — a Day Planner subcard, heading and all —
 * after checking the text there is still what the view showed. A blank line the range
 * leaves doubled (one above it, one below) is dropped so the neighbours don't drift apart.
 */
export async function deleteRangeInFile(
	app: App,
	file: TFile,
	level: number,
	from: Section,
	start: number,
	end: number,
	expectedText: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, from);
		if (!target) {
			ok = false;
			return data;
		}
		const at = bodyStartLine(target) + start;
		if (lines.slice(at, at + end - start).join("\n") !== expectedText) {
			ok = false;
			return data;
		}
		lines.splice(at, end - start);
		if (at > 0 && at < lines.length && lines[at - 1].trim() === "" && lines[at].trim() === "") lines.splice(at, 1);
		return lines.join(eol);
	});

	return ok;
}

/** Insert text right after a given movable block, verifying the block's text first. */
export async function insertAfterBlockInFile(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	blockIndex: number,
	expectedBlockText: string,
	text: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);
		if (!target) {
			ok = false;
			return data;
		}
		const body = lines.slice(bodyStartLine(target), target.endLine);
		const block = movableBlocks(body)[blockIndex];
		if (!block || body.slice(block.start, block.end).join("\n") !== expectedBlockText) {
			ok = false;
			return data;
		}
		const result = insertAfterBlock(lines, target, blockIndex, text);
		return result ? result.join(eol) : data;
	});

	return ok;
}

/** Remove a section from the file, re-locating it at write time like every other write. */
export async function deleteSection(app: App, file: TFile, level: number, original: Section): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);
		if (!target) {
			ok = false;
			return data;
		}
		const [start, end] = sectionDeleteRange(lines, target);
		lines.splice(start, end - start);
		return lines.join(eol);
	});

	return ok;
}

/** Delete several sections in one write; each is re-located by content before its splice. */
export async function deleteSectionsInFile(app: App, file: TFile, level: number, targets: Section[]): Promise<number> {
	let removed = 0;
	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		for (const original of targets) {
			const target = locateCard(lines, level, original);
			if (!target) continue;
			const [start, end] = sectionDeleteRange(lines, target);
			lines.splice(start, end - start);
			removed++;
		}
		return lines.join(eol);
	});
	return removed;
}

/**
 * Move several sections to sit, in their document order, before or after `target` —
 * one write. Placing before: each in order lands right before the target; after: each
 * in reverse order lands right after it, so the run keeps its order either way.
 */
export async function moveSectionsInFile(
	app: App,
	file: TFile,
	level: number,
	moved: Section[],
	target: Section,
	before: boolean,
): Promise<boolean> {
	let ok = true;
	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		let lines = data.split(/\r?\n/);
		const order = [...moved].sort((a, b) => a.startLine - b.startLine);
		for (const m of before ? order : order.reverse()) {
			const sections = parseSections(lines, level);
			const from = locateSection(sections, m);
			const to = locateSection(sections, target);
			if (!from || !to || from === to) {
				ok = false;
				return data;
			}
			const next = moveSection(lines, level, sections.indexOf(from), sections.indexOf(to) + (before ? 0 : 1));
			if (!next) {
				ok = false;
				return data;
			}
			lines = next;
		}
		return lines.join(eol);
	});
	return ok;
}

/** Insert a new section — empty, or with a template body — and return the heading level written. */
export async function insertSection(
	app: App,
	file: TFile,
	headingRaw: string,
	placement: Placement,
	body?: string,
): Promise<{ level: number; duplicate: boolean }> {
	const level = (/^#+/.exec(headingRaw)?.[0] ?? "###").length;
	const title = headingRaw.replace(/^#+\s*/, "").trim();
	// Shed blank lines at either end (but not first-line indentation) before splicing.
	const bodyLines = body?.trim() ? body.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "").split(/\r?\n/) : [];
	let duplicate = false;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		duplicate = parseSections(lines, level).some((s) => s.title === title);
		const at = insertionLine(lines, level, title, placement);
		lines.splice(at, 0, headingRaw, ...bodyLines, "");
		return lines.join(eol);
	});

	return { level, duplicate };
}

/**
 * Replace one section in the file with new text, re-locating it at write time so a
 * card edit can't clobber changes made elsewhere in the file since it was rendered.
 */
export async function writeSection(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	newRaw: string,
): Promise<boolean> {
	let ok = true;

	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);

		if (!target) {
			ok = false;
			return data;
		}

		const replacement = newRaw.split(/\r?\n/);
		lines.splice(target.startLine, target.endLine - target.startLine, ...replacement);
		return lines.join(eol);
	});

	if (!ok) {
		new Notice("Couldn't find that section — the file changed on disk. Edit not saved.");
	}
	return ok;
}

/**
 * Put a day's calendar-feed lines under the feed heading in its card (mergeFeedLines),
 * re-locating the card on disk like every other write. "unchanged" when the note
 * already says exactly that, so a refresh with nothing new writes nothing.
 */
export async function syncFeedIntoSection(
	app: App,
	file: TFile,
	level: number,
	original: Section,
	heading: string,
	feedLines: string[],
	flipMarker: string,
): Promise<"changed" | "unchanged" | "missing"> {
	let result: "changed" | "unchanged" | "missing" = "unchanged";
	await app.vault.process(file, (data) => {
		const eol = data.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
		const lines = data.split(/\r?\n/);
		const target = locateCard(lines, level, original);
		if (!target) {
			result = "missing";
			return data;
		}
		const start = bodyStartLine(target);
		const body = lines.slice(start, target.endLine);
		const merged = mergeFeedLines(body, level, heading, feedLines, flipMarker);
		if (!merged) return data;
		result = "changed";
		return [...lines.slice(0, start), ...merged, ...lines.slice(target.endLine)].join(eol);
	});
	return result;
}
