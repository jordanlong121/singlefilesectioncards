// Minimal stand-ins so main.ts can be bundled and its pure helpers tested under node.
export class ItemView {}
export class Plugin {}
export class PluginSettingTab {}
export class FuzzySuggestModal {}
export class Component {}
export class Notice {}
export class MarkdownView {}
export class Setting {}
export class TFile {}
export class WorkspaceLeaf {}
export const MarkdownRenderer = {};
export const App = {};
export const debounce = (fn) => fn;
export class Modal {}
// Only .format() and .isValid() are exercised by the code under test. An ISO input
// echoes back for the ISO format so date placeholders are testable; strict parsing
// is pessimistic (always invalid), so only the ISO paths are covered here.
export const moment = (input) => ({
	format: (f) => (f === "YYYY-MM-DD" && /^\d{4}-\d{2}-\d{2}$/.test(input ?? "") ? input : "STUB-" + f),
	isValid: () => false,
});
export class Menu {}
export const addIcon = () => {};
export const normalizePath = (p) => p;
export const setIcon = () => {};
export class SuggestModal { setPlaceholder() {} }
export class Scope { register() {} }
export const Platform = { isMobile: false, isPhone: false, isTablet: false };
export const prepareFuzzySearch = (query) => {
	const q = query.toLowerCase();
	return (text) => {
		const t = text.toLowerCase();
		let i = 0;
		for (const ch of q) {
			i = t.indexOf(ch, i);
			if (i < 0) return null;
			i++;
		}
		return { score: -t.length, matches: [] };
	};
};
