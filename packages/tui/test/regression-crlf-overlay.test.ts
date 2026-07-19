import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { visibleWidth } from "../src/utils.ts";

/**
 * Regression coverage for https://github.com/earendil-works/pi/issues/6760.
 *
 * Fixed base: 216e672e7c9fc65682553394b74e483c0c9e47f7
 * Gold commit: ec30ae69141abd02463b4097538acbfe56757180
 */
describe("CRLF and CR component rendering", () => {
	it("renders mixed line endings as separate fixed-width rows without raw carriage returns", () => {
		const component = new Text("alpha\r\nbeta\rgamma", 1, 0);
		const rows = component.render(12);

		assert.deepStrictEqual(
			rows.map((row) => row.trim()),
			["alpha", "beta", "gamma"],
		);
		for (const row of rows) {
			assert.strictEqual(row.includes("\r"), false);
			assert.strictEqual(visibleWidth(row), 12);
		}
	});

	it("preserves empty logical rows created by consecutive and trailing carriage-return line endings", () => {
		const component = new Text("top\r\n\r\nmiddle\rbottom\r", 0, 0);
		const rows = component.render(10);

		assert.deepStrictEqual(
			rows.map((row) => row.trim()),
			["top", "", "middle", "bottom", ""],
		);
		assert.strictEqual(
			rows.some((row) => row.includes("\r")),
			false,
		);
	});
});
