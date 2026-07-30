import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	modelsAreEqual,
} from "@earendil-works/pi-ai";
import { type Component, type Focusable, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export interface SidebarModel {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

export interface ModelSidebarSelection {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
}

export interface ModelStatusSidebarOptions {
	models: SidebarModel[];
	currentModel: Model<Api> | undefined;
	currentThinkingLevel: ThinkingLevel;
	recentModelIds: string[];
	onConfirm: (selection: ModelSidebarSelection) => void | Promise<void>;
	onCancel: () => void;
	requestRender: () => void;
}

function modelId(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function sortModels(models: SidebarModel[], recentModelIds: string[]): SidebarModel[] {
	const recentRanks = new Map(recentModelIds.map((id, index) => [id, index]));
	return models
		.filter((entry, index) => models.findIndex((candidate) => modelsAreEqual(candidate.model, entry.model)) === index)
		.map((entry, index) => ({ entry, index, rank: recentRanks.get(modelId(entry.model)) ?? Number.MAX_SAFE_INTEGER }))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map(({ entry }) => entry);
}

/** Persistent model status display that becomes an interactive selector when focused. */
export class ModelStatusSidebar implements Component, Focusable {
	private models: SidebarModel[];
	private currentModel: Model<Api> | undefined;
	private currentThinkingLevel: ThinkingLevel;
	private recentModelIds: string[];
	private readonly onConfirm: (selection: ModelSidebarSelection) => void | Promise<void>;
	private readonly onCancel: () => void;
	private readonly requestRender: () => void;
	private selectedIndex = 0;
	private draftThinkingLevel: ThinkingLevel;
	private confirming = false;
	private error: string | undefined;
	private _focused = false;

	constructor(options: ModelStatusSidebarOptions) {
		this.models = sortModels(options.models, options.recentModelIds);
		this.currentModel = options.currentModel;
		this.currentThinkingLevel = options.currentThinkingLevel;
		this.recentModelIds = [...options.recentModelIds];
		this.onConfirm = options.onConfirm;
		this.onCancel = options.onCancel;
		this.requestRender = options.requestRender;
		this.selectedIndex = this.findCurrentModelIndex();
		this.draftThinkingLevel = this.getInitialThinkingLevel(this.models[this.selectedIndex]);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		if (this._focused === value) return;
		this._focused = value;
		if (value) {
			this.models = sortModels(this.models, this.recentModelIds);
			this.selectedIndex = this.findCurrentModelIndex();
			this.draftThinkingLevel = this.getInitialThinkingLevel(this.models[this.selectedIndex]);
			this.error = undefined;
		}
		this.requestRender();
	}

	update(options: {
		models?: SidebarModel[];
		currentModel: Model<Api> | undefined;
		currentThinkingLevel: ThinkingLevel;
		recentModelIds?: string[];
	}): void {
		this.currentModel = options.currentModel;
		this.currentThinkingLevel = options.currentThinkingLevel;
		if (options.recentModelIds) this.recentModelIds = [...options.recentModelIds];
		if (!this.focused) {
			this.models = sortModels(options.models ?? this.models, this.recentModelIds);
			this.selectedIndex = this.findCurrentModelIndex();
			this.draftThinkingLevel = this.getInitialThinkingLevel(this.models[this.selectedIndex]);
		}
		this.requestRender();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const selected = this.models[this.selectedIndex];
		const displayedThinkingLevel = this.focused ? this.draftThinkingLevel : this.currentThinkingLevel;
		const lines = [
			theme.fg(this.focused ? "accent" : "muted", theme.bold(" Models")),
			theme.fg("dim", " Reasoning effort"),
			this.focused
				? ` ${theme.fg("accent", `‹ ${displayedThinkingLevel} ›`)}`
				: ` ${theme.fg("text", displayedThinkingLevel)}`,
			"",
		];

		if (this.models.length === 0) {
			lines.push(theme.fg("muted", " No quick models"));
		} else {
			const maxVisible = 8;
			const start = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.models.length - maxVisible),
			);
			const end = Math.min(start + maxVisible, this.models.length);
			for (let index = start; index < end; index++) {
				const entry = this.models[index];
				const isSelected = this.focused && index === this.selectedIndex;
				const isCurrent = modelsAreEqual(this.currentModel, entry.model);
				const prefix = isSelected ? theme.fg("accent", "›") : isCurrent ? theme.fg("success", "✓") : " ";
				const label = isSelected ? theme.fg("accent", entry.model.id) : entry.model.id;
				lines.push(` ${prefix} ${label}`);
			}
			if (start > 0 || end < this.models.length) {
				lines.push(theme.fg("dim", ` ${this.selectedIndex + 1}/${this.models.length}`));
			}
		}

		if (this.error) lines.push("", theme.fg("error", ` ${this.error}`));
		if (this.focused && selected && !this.confirming) {
			lines.push("", theme.fg("dim", " ↑↓ model · ←→ effort"), theme.fg("dim", " Enter apply · Esc cancel"));
		} else if (this.confirming) {
			lines.push("", theme.fg("muted", " Switching…"));
		}

		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		if (!this.focused || this.confirming) return;
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (keybindings.matches(data, "tui.editor.cursorLeft")) {
			this.moveThinkingLevel(-1);
			return;
		}
		if (keybindings.matches(data, "tui.editor.cursorRight")) {
			this.moveThinkingLevel(1);
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			void this.confirm();
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.model.select")) {
			this.onCancel();
		}
	}

	invalidate(): void {}

	private findCurrentModelIndex(): number {
		const index = this.models.findIndex((entry) => modelsAreEqual(entry.model, this.currentModel));
		return index >= 0 ? index : 0;
	}

	private getInitialThinkingLevel(entry: SidebarModel | undefined): ThinkingLevel {
		if (!entry) return "off";
		if (entry.thinkingLevel !== undefined) {
			return clampThinkingLevel(entry.model, entry.thinkingLevel) as ThinkingLevel;
		}
		return clampThinkingLevel(entry.model, this.currentThinkingLevel) as ThinkingLevel;
	}

	private moveSelection(delta: number): void {
		if (this.models.length === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + this.models.length) % this.models.length;
		this.draftThinkingLevel = this.getInitialThinkingLevel(this.models[this.selectedIndex]);
		this.error = undefined;
		this.requestRender();
	}

	private moveThinkingLevel(delta: number): void {
		const selected = this.models[this.selectedIndex];
		if (!selected) return;
		const levels = getSupportedThinkingLevels(selected.model) as ThinkingLevel[];
		const currentIndex = Math.max(0, levels.indexOf(this.draftThinkingLevel));
		this.draftThinkingLevel = levels[(currentIndex + delta + levels.length) % levels.length];
		this.error = undefined;
		this.requestRender();
	}

	private async confirm(): Promise<void> {
		const selected = this.models[this.selectedIndex];
		if (!selected) return;
		this.confirming = true;
		this.error = undefined;
		this.requestRender();
		try {
			await this.onConfirm({ model: selected.model, thinkingLevel: this.draftThinkingLevel });
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.confirming = false;
			this.requestRender();
		}
	}
}
