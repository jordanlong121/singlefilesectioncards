// Per-note backgrounds: layers, gradients, and the pick/download/gradient dialogs.

import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile, requestUrl } from "obsidian";

/** Image files the vault offers as card-wall backgrounds. */
export const BACKGROUND_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);

/** The veil strength a background image starts with (styles.css falls back to it too). */
export const BACKGROUND_DIM_DEFAULT = 45;

/**
 * The brightness layer's color for a percentage: below 100 an increasingly solid
 * black overlay dims the image, above 100 a white one lifts it. 100 = "" so the
 * stylesheet's transparent fallback applies. (CSS can't filter one background
 * layer, so brightness and saturation are approximated with blended layers.)
 */
export function backgroundLightLayer(brightness: number): string {
	if (brightness === 100) return "";
	return brightness < 100
		? `rgba(0, 0, 0, ${(100 - brightness) / 100})`
		: `rgba(255, 255, 255, ${(brightness - 100) / 100})`;
}

/** The desaturation layer's color: a gray blended with `saturation` mode drains the
 * image's color by its alpha. 100 = "" so the transparent fallback applies. */
export function backgroundDesatLayer(saturation: number): string {
	return saturation >= 100 ? "" : `rgba(128, 128, 128, ${(100 - saturation) / 100})`;
}

/** Evenly spaced gradient stops (0..1) for 2–3 colors — shared by the CSS preview and
 * the canvas render so the saved image matches what the dialog showed. */
export function gradientStops(colors: string[]): { color: string; at: number }[] {
	return colors.map((color, i) => ({ color, at: colors.length < 2 ? 0 : i / (colors.length - 1) }));
}

/** The CSS background for a gradient — what the dialog's live preview paints with. */
export function gradientCss(kind: "linear" | "radial", angle: number, colors: string[]): string {
	const stops = gradientStops(colors)
		.map((s) => `${s.color} ${Math.round(s.at * 100)}%`)
		.join(", ");
	return kind === "radial" ? `radial-gradient(circle, ${stops})` : `linear-gradient(${angle}deg, ${stops})`;
}

/**
 * A CSS linear-gradient's endpoints on a w×h canvas: the gradient line runs through the
 * center at `angle` (0° = up, clockwise, like CSS), long enough that the first and last
 * stops land exactly in the corners the CSS renderer puts them in.
 */
export function gradientEndpoints(
	angle: number,
	w: number,
	h: number,
): { x0: number; y0: number; x1: number; y1: number } {
	const rad = (angle * Math.PI) / 180;
	const dx = Math.sin(rad);
	const dy = -Math.cos(rad);
	const half = Math.abs((w / 2) * dx) + Math.abs((h / 2) * dy);
	return { x0: w / 2 - dx * half, y0: h / 2 - dy * half, x1: w / 2 + dx * half, y1: h / 2 + dy * half };
}

/** The four places a background image can come from, offered as one dialog. */
export interface BackgroundSources {
	fromVault: () => void;
	fromLocal: () => void;
	fromInternet: () => void;
	fromGradient: () => void;
}

export class SelectBackgroundModal extends Modal {
	private readonly sources: BackgroundSources;

	constructor(app: App, sources: BackgroundSources) {
		super(app);
		this.sources = sources;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Select background" });
		contentEl.createEl("p", { text: "Where should this note's background image come from?" });

		const option = (name: string, desc: string, button: string, pick: () => void) => {
			new Setting(contentEl)
				.setName(name)
				.setDesc(desc)
				.addButton((b) =>
					b.setButtonText(button).onClick(() => {
						this.close();
						pick();
					}),
				);
		};
		option("From the vault", "Pick an image already in your vault.", "Choose…", this.sources.fromVault);
		option(
			"From this computer",
			"Pick any image on disk; a copy is saved into the vault's attachment folder.",
			"Browse…",
			this.sources.fromLocal,
		);
		option(
			"From the internet",
			"Download an image URL once into the vault's attachment folder.",
			"Download…",
			this.sources.fromInternet,
		);
		option(
			"Custom gradient",
			"Compose a two or three color gradient and save it as an image in the vault.",
			"Create…",
			this.sources.fromGradient,
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Fuzzy-pick an image from the vault for the note's background. */
export class BackgroundSuggestModal extends FuzzySuggestModal<TFile> {
	private readonly onChoose: (file: TFile) => void;

	constructor(app: App, onChoose: (file: TFile) => void) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder("Pick an image from the vault…");
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => BACKGROUND_EXTENSIONS.has(f.extension.toLowerCase()));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

/** The saved extension for each image content type a background download may return. */
export const IMAGE_TYPE_EXTENSIONS: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/avif": "avif",
	"image/bmp": "bmp",
};

/**
 * Background from the internet: the image at a user-given URL is downloaded ONCE
 * into the vault's attachment folder and used from there — the plugin's only
 * network use, and only ever at the user's explicit request.
 */
export class DownloadBackgroundModal extends Modal {
	private readonly notePath: string;
	private readonly onSaved: (vaultPath: string) => void;

	constructor(app: App, notePath: string, onSaved: (vaultPath: string) => void) {
		super(app);
		this.notePath = notePath;
		this.onSaved = onSaved;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Background from the internet" });
		contentEl.createEl("p", {
			text: "The image is downloaded once into your vault's attachment folder and shown from there — nothing loads from the network afterwards.",
		});

		let url = "";
		new Setting(contentEl).setName("Image URL").addText((text) => {
			text.setPlaceholder("https://…");
			text.onChange((value) => (url = value));
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText("Download")
					.setCta()
					.onClick(() => void this.download(url.trim(), b.buttonEl));
			});
	}

	private async download(url: string, button: HTMLButtonElement): Promise<void> {
		if (!url) {
			new Notice("Enter an image URL first.");
			return;
		}
		button.disabled = true;
		button.setText("Downloading…");
		try {
			const res = await requestUrl({ url });
			const type =
				Object.entries(res.headers)
					.find(([k]) => k.toLowerCase() === "content-type")?.[1]
					?.split(";")[0]
					.trim()
					.toLowerCase() ?? "";
			if (type && !type.startsWith("image/")) {
				new Notice("That URL didn't return an image.");
				return;
			}
			const ext =
				IMAGE_TYPE_EXTENSIONS[type] ??
				/\.(png|jpe?g|gif|webp|avif|bmp)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase().replace("jpeg", "jpg");
			if (!ext) {
				new Notice("That URL didn't return an image.");
				return;
			}
			// Name the file after the URL's last path segment, cleaned for the file system.
			const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
			const stem =
				last
					.replace(/\.[a-z0-9]+$/i, "")
					.replace(/[^\w-]+/g, "-")
					.replace(/^-+|-+$/g, "")
					.slice(0, 40) || "background";
			const dest = await this.app.fileManager.getAvailablePathForAttachment(`${stem}.${ext}`, this.notePath);
			const file = await this.app.vault.createBinary(dest, res.arrayBuffer);
			new Notice(`Background saved to "${file.path}".`);
			this.onSaved(file.path);
			this.close();
		} catch {
			new Notice("Couldn't download that image — check the URL and your connection.");
		} finally {
			button.disabled = false;
			button.setText("Download");
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** The pixel size of a saved gradient background. */
export const GRADIENT_WIDTH = 1920;

export const GRADIENT_HEIGHT = 1080;

/**
 * Compose a two or three color gradient with a live preview, then save it into the
 * vault's attachment folder as a 1920×1080 PNG — the same home a downloaded
 * background gets — and use it as this note's background.
 */
export class GradientBackgroundModal extends Modal {
	private readonly notePath: string;
	private readonly onSaved: (vaultPath: string) => void;

	private kind: "linear" | "radial" = "linear";
	private angle = 135;
	private colors = ["#264653", "#2a9d8f"];
	private third = "#e9c46a";
	private thirdOn = false;

	private previewEl!: HTMLElement;
	private angleSetting!: Setting;

	constructor(app: App, notePath: string, onSaved: (vaultPath: string) => void) {
		super(app);
		this.notePath = notePath;
		this.onSaved = onSaved;
	}

	private activeColors(): string[] {
		return this.thirdOn ? [...this.colors, this.third] : this.colors.slice();
	}

	private updatePreview(): void {
		this.previewEl.setCssProps({ "--sfsc-gradient": gradientCss(this.kind, this.angle, this.activeColors()) });
		this.angleSetting.settingEl.toggle(this.kind === "linear");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Custom gradient" });

		this.previewEl = contentEl.createDiv({ cls: "sfsc-gradient-preview" });

		new Setting(contentEl).setName("Style").addDropdown((drop) => {
			drop.addOption("linear", "Linear");
			drop.addOption("radial", "Radial");
			drop.setValue(this.kind).onChange((value) => {
				this.kind = value === "radial" ? "radial" : "linear";
				this.updatePreview();
			});
		});

		this.angleSetting = new Setting(contentEl).setName("Angle").addSlider((slider) => {
			slider
				.setLimits(0, 360, 5)
				.setValue(this.angle)
				.onChange((value) => {
					this.angle = value;
					this.updatePreview();
				});
		});

		const colorRow = (name: string, index: number) => {
			new Setting(contentEl).setName(name).addColorPicker((picker) => {
				picker.setValue(this.colors[index]).onChange((value) => {
					this.colors[index] = value;
					this.updatePreview();
				});
			});
		};
		colorRow("First color", 0);
		colorRow("Second color", 1);

		new Setting(contentEl)
			.setName("Third color")
			.setDesc("Adds a middle stop between the other two.")
			.addToggle((toggle) => {
				toggle.setValue(this.thirdOn).onChange((value) => {
					this.thirdOn = value;
					this.updatePreview();
				});
			})
			.addColorPicker((picker) => {
				picker.setValue(this.third).onChange((value) => {
					this.third = value;
					this.thirdOn = true;
					this.updatePreview();
				});
			});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText("Save and use")
					.setCta()
					.onClick(() => void this.save(b.buttonEl));
			});

		this.updatePreview();
	}

	/** Render the gradient to a canvas — the size the file is saved at. */
	private renderCanvas(): HTMLCanvasElement {
		const canvas = createEl("canvas");
		canvas.width = GRADIENT_WIDTH;
		canvas.height = GRADIENT_HEIGHT;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2d context");
		const cx = GRADIENT_WIDTH / 2;
		const cy = GRADIENT_HEIGHT / 2;
		let fill: CanvasGradient;
		if (this.kind === "radial") {
			fill = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(cx, cy));
		} else {
			const { x0, y0, x1, y1 } = gradientEndpoints(this.angle, GRADIENT_WIDTH, GRADIENT_HEIGHT);
			fill = ctx.createLinearGradient(x0, y0, x1, y1);
		}
		for (const stop of gradientStops(this.activeColors())) fill.addColorStop(stop.at, stop.color);
		ctx.fillStyle = fill;
		ctx.fillRect(0, 0, GRADIENT_WIDTH, GRADIENT_HEIGHT);
		return canvas;
	}

	private async save(button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		button.setText("Saving…");
		try {
			const canvas = this.renderCanvas();
			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
			if (!blob) throw new Error("toBlob failed");
			// Name the file after its colors so regenerating never shadows an older gradient.
			const stem = `gradient-${this.activeColors()
				.map((c) => c.replace("#", ""))
				.join("-")}`;
			const dest = await this.app.fileManager.getAvailablePathForAttachment(`${stem}.png`, this.notePath);
			const file = await this.app.vault.createBinary(dest, await blob.arrayBuffer());
			new Notice(`Background saved to "${file.path}".`);
			this.onSaved(file.path);
			this.close();
		} catch {
			new Notice("Couldn't save the gradient image.");
			button.disabled = false;
			button.setText("Save and use");
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
