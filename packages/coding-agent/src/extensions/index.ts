import type { InlineExtension } from "../core/extensions/types.ts";
import goalModeExtension from "./goal-mode/index.ts";
import llamaExtension from "./llama/index.ts";
import managedJobsExtension from "./managed-jobs/index.ts";
import recoveryExtension from "./recovery/index.ts";
import shadowRunsExtension from "./shadow-runs/index.ts";
import workspaceOverlayExtension from "./workspace-overlay/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "goal-mode", factory: goalModeExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "managed-jobs", factory: managedJobsExtension, hidden: true },
	{ name: "recovery", factory: recoveryExtension, hidden: true },
	{ name: "shadow-runs", factory: shadowRunsExtension, hidden: true },
	{ name: "workspace-overlay", factory: workspaceOverlayExtension, hidden: true },
];
