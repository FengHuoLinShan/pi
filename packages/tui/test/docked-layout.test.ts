import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, DockedLayout } from "../src/index.ts";
import { visibleWidth } from "../src/utils.ts";

class RecordingComponent implements Component {
	requestedWidths: number[] = [];
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	render(width: number): string[] {
		this.requestedWidths.push(width);
		return this.lines;
	}

	invalidate(): void {}
}

describe("DockedLayout", () => {
	it("reserves the left dock width from the main component", () => {
		const main = new RecordingComponent(["main"]);
		const dock = new RecordingComponent(["dock"]);
		const layout = new DockedLayout(main, dock, {
			leftWidth: 8,
			minMainWidth: 10,
			viewportHeight: () => 2,
		});

		assert.deepStrictEqual(layout.render(30), ["dock    │main", "        │"]);
		assert.deepStrictEqual(main.requestedWidths, [21]);
		assert.deepStrictEqual(dock.requestedWidths, [8]);
	});

	it("renders only the main component when the terminal is too narrow", () => {
		const main = new RecordingComponent(["main"]);
		const dock = new RecordingComponent(["dock"]);
		const layout = new DockedLayout(main, dock, {
			leftWidth: 12,
			minMainWidth: 20,
			viewportHeight: () => 4,
		});

		assert.deepStrictEqual(layout.render(30), ["main"]);
		assert.deepStrictEqual(main.requestedWidths, [30]);
		assert.deepStrictEqual(dock.requestedWidths, []);
		assert.strictEqual(layout.isDockVisible(30), false);
	});

	it("pins dock content to the bottom viewport when main content is longer than the terminal", () => {
		const main = new RecordingComponent(["m0", "m1", "m2", "m3", "m4"]);
		const dock = new RecordingComponent(["d0", "d1", "d2"]);
		const layout = new DockedLayout(main, dock, {
			leftWidth: 3,
			minMainWidth: 4,
			viewportHeight: () => 3,
		});

		assert.deepStrictEqual(layout.render(12), ["   │m0", "   │m1", "d0 │m2", "d1 │m3", "d2 │m4"]);
	});

	it("truncates wide dock lines without exceeding the terminal width", () => {
		const main = new RecordingComponent(["main"]);
		const dock = new RecordingComponent(["中文中文"]);
		const layout = new DockedLayout(main, dock, {
			leftWidth: 5,
			minMainWidth: 4,
			viewportHeight: () => 1,
		});

		const lines = layout.render(12);
		assert.strictEqual(lines.length, 1);
		assert.strictEqual(visibleWidth(lines[0]), 10);
		assert.ok(visibleWidth(lines[0]) <= 12);
		assert.ok(lines[0].endsWith("main"));
	});

	it("invalidates both children", () => {
		let mainInvalidations = 0;
		let dockInvalidations = 0;
		const main: Component = {
			render: () => [],
			invalidate: () => mainInvalidations++,
		};
		const dock: Component = {
			render: () => [],
			invalidate: () => dockInvalidations++,
		};
		const layout = new DockedLayout(main, dock, {
			leftWidth: 8,
			minMainWidth: 10,
			viewportHeight: () => 2,
		});

		layout.invalidate();

		assert.strictEqual(mainInvalidations, 1);
		assert.strictEqual(dockInvalidations, 1);
	});
});
