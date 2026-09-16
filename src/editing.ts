// In-card editing helpers: undo history, caret capture, tab edits, scrolling.



/** A single indentation edit for the card editor's textarea. */
export interface TabEdit {
	/** Replace [start, end) of the text with `insert`... */
	start: number;
	end: number;
	insert: string;
	/** ...then select this range. */
	selStart: number;
	selEnd: number;
}

/**
 * What pressing Tab (or Shift+Tab) in the editor should do to the text. A bare caret gets
 * a tab character; a selection (or any Shift+Tab) indents or outdents whole lines, one tab
 * — or up to four leading spaces — per line. Returns null when the edit would change nothing.
 */
export function computeTabEdit(text: string, selStart: number, selEnd: number, outdent: boolean): TabEdit | null {
	if (!outdent && selStart === selEnd) {
		return { start: selStart, end: selEnd, insert: "\t", selStart: selStart + 1, selEnd: selStart + 1 };
	}

	// Whole lines: from the start of the line containing selStart to the end of the line
	// containing selEnd — except a selection ending exactly at a line start leaves that
	// line out, which is how every code editor treats it.
	const lineStart = text.lastIndexOf("\n", selStart - 1) + 1;
	const effEnd = selEnd > selStart && text[selEnd - 1] === "\n" ? selEnd - 1 : selEnd;
	const lineEndIdx = text.indexOf("\n", effEnd);
	const regionEnd = lineEndIdx === -1 ? text.length : lineEndIdx;

	const lines = text.slice(lineStart, regionEnd).split("\n");
	const newLines = outdent
		? lines.map((line) => (line.startsWith("\t") ? line.slice(1) : line.replace(/^ {1,4}/, "")))
		: lines.map((line) => (line.length ? "\t" + line : line));
	const insert = newLines.join("\n");
	if (insert === text.slice(lineStart, regionEnd)) return null;

	if (selStart === selEnd) {
		// Caret-only outdent: keep the caret on the same spot in the line.
		const removed = lines[0].length - newLines[0].length;
		const caret = Math.max(lineStart, selStart - removed);
		return { start: lineStart, end: regionEnd, insert, selStart: caret, selEnd: caret };
	}
	return { start: lineStart, end: regionEnd, insert, selStart: lineStart, selEnd: lineStart + insert.length };
}

/** One editor state: full text plus selection. */
export interface EditorSnapshot {
	value: string;
	selStart: number;
	selEnd: number;
}

/**
 * Undo/redo for the card editor's textarea. The editor owns its history because the
 * only alternative for keeping programmatic edits (Tab indentation) undoable was a
 * deprecated document API. Every change — typed or programmatic — is recorded,
 * and the editor's keydown/beforeinput handlers route undo/redo here.
 */
export class EditorHistory {
	private past: EditorSnapshot[];
	private future: EditorSnapshot[] = [];

	constructor(initial: EditorSnapshot) {
		this.past = [initial];
	}

	/** Record the state after a change. Same-text records just refresh the selection. */
	record(snap: EditorSnapshot): void {
		const top = this.past[this.past.length - 1];
		if (top.value === snap.value) {
			top.selStart = snap.selStart;
			top.selEnd = snap.selEnd;
			return;
		}
		this.past.push(snap);
		if (this.past.length > 200) this.past.shift();
		this.future = [];
	}

	/** The state to restore, or null when at the beginning. */
	undo(): EditorSnapshot | null {
		if (this.past.length < 2) return null;
		this.future.push(this.past.pop() as EditorSnapshot);
		return this.past[this.past.length - 1];
	}

	/** The state to restore, or null when there is nothing to redo. */
	redo(): EditorSnapshot | null {
		const next = this.future.pop();
		if (!next) return null;
		this.past.push(next);
		return next;
	}
}

/**
 * Moving a node in the DOM drops focus, which would eject you from a card editor when the
 * card is blown up. These remember the focused textarea and its selection, and put them back.
 */
export function captureCaret(within: HTMLElement): { el: HTMLTextAreaElement; start: number; end: number } | null {
	const active = within.ownerDocument.activeElement;
	if (!(active instanceof HTMLTextAreaElement) || !within.contains(active)) return null;
	return { el: active, start: active.selectionStart, end: active.selectionEnd };
}

export function restoreCaret(caret: { el: HTMLTextAreaElement; start: number; end: number } | null): void {
	if (!caret) return;
	caret.el.focus();
	caret.el.setSelectionRange(caret.start, caret.end);
}

/** Split a wikilink target into its file path and its `#heading` subpath. */
export function splitLinktext(linktext: string): [string, string] {
	const hash = linktext.indexOf("#");
	if (hash < 0) return [linktext.trim(), ""];
	return [linktext.slice(0, hash).trim(), linktext.slice(hash + 1).trim()];
}

/**
 * A wheel event's dominant delta in pixels. Mice report lines and some report pages,
 * so deltaMode has to be normalised before the value can be used as a scroll offset.
 */
export function wheelDeltaToPixels(
	evt: { deltaX: number; deltaY: number; deltaMode: number },
	pageSize: number,
	lineHeight = 16,
): number {
	const raw = Math.abs(evt.deltaY) >= Math.abs(evt.deltaX) ? evt.deltaY : evt.deltaX;
	if (evt.deltaMode === 1) return raw * lineHeight;
	if (evt.deltaMode === 2) return raw * pageSize;
	return raw;
}

/** Whether an element can still scroll vertically in the direction of `delta`. */
export function canScrollVertically(
	el: { scrollTop: number; scrollHeight: number; clientHeight: number },
	delta: number,
): boolean {
	if (el.scrollHeight <= el.clientHeight + 1) return false;
	if (delta < 0) return el.scrollTop > 0;
	if (delta > 0) return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
	return false;
}
