import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

export interface DockedLayoutOptions {
	leftWidth: number;
	minMainWidth: number;
	viewportHeight: () => number;
	separator?: string;
}

/**
 * Renders a left dock beside a main component while keeping the dock pinned to
 * the terminal's current bottom viewport.
 */
export class DockedLayout implements Component {
	private readonly main: Component;
	private leftDock: Component | undefined;
	private leftWidth: number;
	private minMainWidth: number;
	private readonly viewportHeight: () => number;
	private readonly separator: string;

	constructor(main: Component, leftDock: Component | undefined, options: DockedLayoutOptions) {
		this.main = main;
		this.leftDock = leftDock;
		this.leftWidth = options.leftWidth;
		this.minMainWidth = options.minMainWidth;
		this.viewportHeight = options.viewportHeight;
		this.separator = options.separator ?? "│";
	}

	setLeftDock(component: Component | undefined): void {
		this.leftDock = component;
	}

	setLeftWidth(width: number): void {
		this.leftWidth = width;
	}

	setMinMainWidth(width: number): void {
		this.minMainWidth = width;
	}

	isDockVisible(width: number): boolean {
		if (!this.leftDock) return false;
		const dockWidth = Math.max(1, Math.floor(this.leftWidth));
		return width - dockWidth - visibleWidth(this.separator) >= Math.max(1, Math.floor(this.minMainWidth));
	}

	render(width: number): string[] {
		if (!this.isDockVisible(width) || !this.leftDock) return this.main.render(width);

		const dockWidth = Math.max(1, Math.floor(this.leftWidth));
		const separatorWidth = visibleWidth(this.separator);
		const mainWidth = width - dockWidth - separatorWidth;
		const mainLines = this.main.render(mainWidth);
		const dockLines = this.leftDock.render(dockWidth);
		const viewportHeight = Math.max(1, Math.floor(this.viewportHeight()));
		const totalLines = Math.max(mainLines.length, viewportHeight);
		const dockStart = Math.max(0, totalLines - viewportHeight);
		const lines: string[] = [];

		for (let index = 0; index < totalLines; index++) {
			const dockIndex = index - dockStart;
			const dockLine = dockIndex >= 0 ? (dockLines[dockIndex] ?? "") : "";
			const paddedDockLine = truncateToWidth(dockLine, dockWidth, "", true);
			lines.push(`${paddedDockLine}${this.separator}${mainLines[index] ?? ""}`);
		}
		return lines;
	}

	invalidate(): void {
		this.main.invalidate();
		this.leftDock?.invalidate();
	}
}
