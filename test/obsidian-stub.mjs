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
// Only .format() is exercised by the code under test.
export const moment = () => ({ format: (f) => "STUB-" + f });
export const addIcon = () => {};
export const setIcon = () => {};
export class SuggestModal { setPlaceholder() {} }
export class Scope { register() {} }
export const Platform = { isMobile: false, isPhone: false, isTablet: false };
