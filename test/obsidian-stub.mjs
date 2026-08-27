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
// Real strict parsing for two simple formats (titleToIso and the prefix-date
// detection lean on it); every other format stays a stub that never validates.
const MOMENT_PATTERNS = {
	"YYYY-MM-DD": /^(\d{4})-(\d{2})-(\d{2})$/,
	"YYYY.MM.DD": /^(\d{4})\.(\d{2})\.(\d{2})$/,
	// The weekday word is accepted, not validated — the format branch writes the true one.
	"YYYY-MM-DD, dddd": /^(\d{4})-(\d{2})-(\d{2}), [A-Za-z]+$/,
};
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const moment = (input, format) => {
	const m = MOMENT_PATTERNS[format]?.exec(input ?? "") ?? null;
	const ok =
		!!m &&
		(() => {
			const [y, mon, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
			const dt = new Date(y, mon - 1, d);
			return dt.getFullYear() === y && dt.getMonth() === mon - 1 && dt.getDate() === d;
		})();
	return {
		format: (f) => {
			if (ok && f === "YYYY-MM-DD, dddd")
				return `${m[1]}-${m[2]}-${m[3]}, ${DOW[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()]}`;
			if (ok && f === "YYYY.MM.DD") return `${m[1]}.${m[2]}.${m[3]}`;
			if (ok && f === "dddd") return DOW[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()];
			if (f !== "YYYY-MM-DD") return "STUB-" + f;
			if (ok) return `${m[1]}-${m[2]}-${m[3]}`;
			return /^\d{4}-\d{2}-\d{2}$/.test(input ?? "") ? input : "STUB-" + f;
		},
		isValid: () => ok,
	};
};
export class Menu {}
export const addIcon = () => {};
export const normalizePath = (p) => p;
export const requestUrl = async () => {
	throw new Error("network is stubbed out in tests");
};
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
