import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import shadowRunsExtension from "./shadow-runs/index.ts";
import workspaceOverlayExtension from "./workspace-overlay/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "shadow-runs", factory: shadowRunsExtension, hidden: true },
	{ name: "workspace-overlay", factory: workspaceOverlayExtension, hidden: true },
];
