/**
 * Live-preview card editing via Obsidian's internal embeddable markdown editor — the
 * same widget Canvas cards use. That class is not part of the public plugin API, so it
 * is resolved at runtime through the embed registry's prototype chain, the technique
 * shared by Kanban, Meta Bind, and other community plugins (credit to mgmeyers and
 * Fevol). Everything here is defensive: if any step fails on a future Obsidian
 * version, createEmbeddedEditor returns null and the caller falls back to the plain
 * textarea editor, which depends on nothing internal.
 */

import { App } from "obsidian";
import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";

export interface EmbeddedEditorOptions {
	value: string;
	/** Mod+Enter inside the editor. */
	onSave: () => void;
	/** Escape inside the editor. */
	onCancel: () => void;
	/** The document changed — the caller re-measures card layout. */
	onChange: () => void;
}

/** The slice of the editor the card code is allowed to touch. */
export interface EmbeddedEditor {
	readonly value: string;
	focusEnd(): void;
	destroy(): void;
}

/** The runtime shape this file relies on. Undocumented, hence the fallback paths. */
interface InternalEditor {
	editor: { cm: EditorView };
	owner: { editMode: unknown; editor: unknown };
	set(value: string, clear?: boolean): void;
	unload(): void;
	destroy(): void;
	_loaded?: boolean;
	buildLocalExtensions(): Extension[];
}

type InternalEditorCtor = new (app: App, container: HTMLElement, owner: unknown) => InternalEditor;

interface MarkdownEmbedWidget {
	editable: boolean;
	showEditor(): void;
	editMode?: unknown;
	unload(): void;
}

type EmbedFactory = (
	info: { app: App; containerEl: HTMLElement },
	file: null,
	subpath: string,
) => MarkdownEmbedWidget;

/** undefined = not yet attempted; null = attempted and unavailable this session. */
let resolvedCtor: InternalEditorCtor | null | undefined;

/**
 * Digs Obsidian's MarkdownEditor class out of a throwaway markdown embed: the embed's
 * edit mode is an instance of a subclass, so the class sits two prototypes up.
 */
function resolveEditorClass(app: App): InternalEditorCtor | null {
	if (resolvedCtor !== undefined) return resolvedCtor;
	resolvedCtor = null;
	try {
		const registry = (app as unknown as { embedRegistry?: { embedByExtension?: Record<string, unknown> } })
			.embedRegistry;
		const factory = registry?.embedByExtension?.["md"] as EmbedFactory | undefined;
		if (typeof factory !== "function") return null;
		const widget = factory({ app, containerEl: createDiv() }, null, "");
		widget.editable = true;
		widget.showEditor();
		const editMode = widget.editMode;
		if (!editMode) {
			widget.unload();
			return null;
		}
		const proto = Object.getPrototypeOf(Object.getPrototypeOf(editMode)) as { constructor?: unknown } | null;
		widget.unload();
		if (typeof proto?.constructor === "function") resolvedCtor = proto.constructor as InternalEditorCtor;
	} catch (error) {
		console.error("Single File Section Cards: live-preview editor unavailable, using plain markdown", error);
	}
	return resolvedCtor;
}

/**
 * Builds a live-preview editor inside `container`, pre-filled with `value`.
 * Returns null when the internal editor can't be resolved or constructed — the
 * caller must then fall back to the textarea editor.
 */
export function createEmbeddedEditor(
	app: App,
	container: HTMLElement,
	options: EmbeddedEditorOptions,
): EmbeddedEditor | null {
	const Base = resolveEditorClass(app);
	if (!Base) return null;
	try {
		class CardMarkdownEditor extends Base {
			buildLocalExtensions(): Extension[] {
				const extensions = super.buildLocalExtensions();
				// Highest precedence: these must beat the editor's own Enter/Escape
				// bindings. Mod+Enter is also caught by the view's keymap scope and a
				// document-level fallback, but only this binding works when a future
				// Obsidian routes key events straight into CodeMirror.
				extensions.push(
					Prec.highest(
						keymap.of([
							{
								key: "Mod-Enter",
								run: () => {
									options.onSave();
									return true;
								},
							},
							{
								key: "Escape",
								run: () => {
									options.onCancel();
									return true;
								},
								preventDefault: true,
							},
						]),
					),
				);
				extensions.push(
					EditorView.updateListener.of((update: ViewUpdate) => {
						if (update.docChanged) options.onChange();
					}),
				);
				return extensions;
			}
		}

		// The owner mocks the MarkdownView the editor believes it lives in; getMode
		// keeps it in editing mode and onMarkdownScroll satisfies its scroll syncing.
		const owner: Record<string, unknown> = {
			app,
			onMarkdownScroll: () => {},
			getMode: () => "source",
		};
		const editor = new CardMarkdownEditor(app, container, owner);
		// Editor commands (bold, toggle checkbox, …) find their target through
		// workspace.activeEditor.editMode/.editor — point the mock at this instance.
		editor.owner.editMode = editor;
		editor.owner.editor = editor.editor;
		editor.set(options.value, true);

		// While the editor has focus, Obsidian's editor commands should act on it.
		const workspace = app.workspace as unknown as { activeEditor: unknown };
		const onFocusIn = () => {
			workspace.activeEditor = editor.owner;
		};
		editor.editor.cm.contentDOM.addEventListener("focusin", onFocusIn);

		let destroyed = false;
		return {
			get value(): string {
				return editor.editor.cm.state.doc.toString();
			},
			focusEnd(): void {
				const cm = editor.editor.cm;
				cm.focus();
				cm.dispatch({
					selection: EditorSelection.cursor(cm.state.doc.length),
					scrollIntoView: true,
				});
			},
			destroy(): void {
				if (destroyed) return;
				destroyed = true;
				editor.editor.cm.contentDOM.removeEventListener("focusin", onFocusIn);
				if (workspace.activeEditor === editor.owner) workspace.activeEditor = null;
				try {
					if (editor._loaded) editor.unload();
					editor.destroy();
				} catch (error) {
					console.error("Single File Section Cards: embedded editor teardown failed", error);
				}
				container.empty();
			},
		};
	} catch (error) {
		console.error("Single File Section Cards: live-preview editor failed, using plain markdown", error);
		return null;
	}
}
