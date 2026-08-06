import {
	type CodeGraphQueryOptions,
	type ExtensionAPI,
	evaluateArchitectureFitness,
	loadArchitectureFitnessPlan,
	loadImpactVerificationCatalog,
	planImpactVerification,
	registerImpactGraphProvider,
	verifyImpactPlan,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type CodeGraphResolvedQueryResult,
	type CodeGraphSymbolMatch,
	openTypeScriptCodeGraph,
	type TypeScriptCodeGraph,
} from "./service.ts";

const ACTIONS = Type.Union([
	Type.Literal("status"),
	Type.Literal("sync"),
	Type.Literal("reindex"),
	Type.Literal("search"),
	Type.Literal("dependencies"),
	Type.Literal("dependents"),
	Type.Literal("impact"),
	Type.Literal("fitness"),
	Type.Literal("plan_verification"),
	Type.Literal("verify"),
]);

const CODE_GRAPH_PARAMETERS = Type.Object({
	action: ACTIONS,
	query: Type.Optional(Type.String({ description: "Symbol search query. Used when nodeId is omitted." })),
	nodeId: Type.Optional(Type.String({ description: "Exact graph node id returned by search." })),
	path: Type.Optional(Type.String({ description: "Workspace-relative file path for impact analysis." })),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 1,
			maxItems: 100,
			description: "Workspace-relative PatchSet paths for impact-aware verification.",
		}),
	),
	objective: Type.Optional(Type.String({ description: "Verification objective recorded in the completion report." })),
	kinds: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
	edgeKinds: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
	maxPaths: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

interface CompactNode {
	id: string;
	kind?: string;
	name?: string;
	location?: string;
	unresolved?: true;
}

interface CompactEdge {
	kind: string;
	from: string;
	to: string;
	location: string;
	confidence?: string | number | boolean | null;
}

interface CompactPath {
	nodes: CompactNode[];
	edges: CompactEdge[];
}

function nodeLocation(node: { filePath: string; range?: { start: { line: number; column: number } } }): string {
	return node.range ? `${node.filePath}:${node.range.start.line}:${node.range.start.column + 1}` : node.filePath;
}

function compactMatches(matches: CodeGraphSymbolMatch[]): CompactNode[] {
	return matches.map(({ node }) => ({
		id: node.id,
		kind: node.kind,
		name: node.name,
		location: nodeLocation(node),
	}));
}

function compactPaths(result: CodeGraphResolvedQueryResult): { paths: CompactPath[]; truncated: boolean } {
	return {
		paths: result.paths.map((path) => ({
			nodes: path.nodes.map((node) =>
				"unresolved" in node
					? { id: node.id, unresolved: true }
					: { id: node.id, kind: node.kind, name: node.name, location: nodeLocation(node) },
			),
			edges: path.edges.map((edge) => ({
				kind: edge.kind,
				from: edge.from,
				to: edge.to,
				location: nodeLocation(edge),
				confidence: edge.attributes?.confidence,
			})),
		})),
		truncated: result.truncated,
	};
}

function queryOptions(params: { maxDepth?: number; maxPaths?: number; edgeKinds?: string[] }): CodeGraphQueryOptions {
	return {
		maxDepth: params.maxDepth ?? 2,
		maxPaths: params.maxPaths ?? 50,
		edgeKinds: params.edgeKinds,
	};
}

function selectNodeId(
	service: TypeScriptCodeGraph,
	params: { nodeId?: string; query?: string },
): { nodeId: string; selectedBy?: string } {
	if (params.nodeId) {
		if (!service.getNode(params.nodeId)) throw new Error(`Code graph node does not exist: ${params.nodeId}`);
		return { nodeId: params.nodeId };
	}
	if (!params.query) throw new Error("nodeId or query is required");
	const matches = service.search(params.query, { limit: 5 });
	if (matches.length === 0) throw new Error(`No code graph symbol matches: ${params.query}`);
	const equallyRanked = matches.filter((match) => match.score === matches[0].score);
	if (equallyRanked.length > 1) {
		const candidates = equallyRanked.map((match) => `${match.node.id} (${match.location})`).join(", ");
		throw new Error(`Code graph symbol query is ambiguous: ${params.query}. Candidates: ${candidates}`);
	}
	return { nodeId: matches[0].node.id, selectedBy: params.query };
}

function textResult(value: unknown): {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
} {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}

export default function codeGraphExtension(pi: ExtensionAPI): void {
	let service: TypeScriptCodeGraph | undefined;
	let workspaceRoot: string | undefined;
	let unregisterImpactProvider: (() => void) | undefined;

	const getService = async (cwd: string): Promise<TypeScriptCodeGraph> => {
		if (service && workspaceRoot === cwd) return service;
		const previousService = service;
		service = undefined;
		workspaceRoot = undefined;
		unregisterImpactProvider?.();
		unregisterImpactProvider = undefined;
		await previousService?.dispose();
		const nextService = await openTypeScriptCodeGraph({ workspaceRoot: cwd });
		service = nextService;
		workspaceRoot = cwd;
		unregisterImpactProvider = registerImpactGraphProvider(cwd, {
			sync: async (options) => {
				await nextService.sync(options);
			},
			impactMap: (paths, options) => nextService.impactMap(paths, options),
		});
		return nextService;
	};

	pi.registerTool({
		name: "code_graph",
		label: "Code Graph",
		description:
			"Index and query TypeScript, JavaScript, Python, Go, and Rust symbols and relationships. Also evaluates .pi/architecture.json fitness rules and plans or executes repository-aware checks from .pi/checks.json.",
		promptSnippet: "Search symbols, trace impact paths, evaluate architecture fitness, or verify a PatchSet",
		promptGuidelines: [
			"Use code_graph search before broad repository scans when locating symbols in supported languages.",
			"Treat Python, Go, and Rust hybrid relationships as conservative static evidence; confirm dynamic dispatch, interfaces, macros, and ambiguous calls from source.",
			"Use code_graph impact before modifying shared symbols, then confirm evidence by reading the returned file locations.",
			"Use code_graph fitness to enforce versioned dependency boundaries, acyclicity, and fan-in budgets from .pi/architecture.json.",
			"Use code_graph plan_verification or verify with the complete changed-path list when .pi/checks.json defines repository checks.",
		],
		parameters: CODE_GRAPH_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.workspace.execution.target !== "host") {
				throw new Error(
					"Code graph is unavailable for execution-boundary workspaces because extensions cannot read boundary paths",
				);
			}
			const graph = await getService(ctx.workspace.logicalRoot);
			if (params.action === "status") return textResult(graph.status());
			if (params.action === "sync" || params.action === "reindex") {
				return textResult(await graph.sync({ force: params.action === "reindex", signal }));
			}
			const status = graph.status();
			if (status.dirty || (status.state !== "ready" && status.state !== "degraded")) {
				await graph.sync({ signal });
			}
			if (params.action === "fitness") {
				if (!ctx.isProjectTrusted()) throw new Error("Architecture fitness requires a trusted project");
				const plan = await loadArchitectureFitnessPlan(ctx.workspace.sourceRoot);
				if (!plan) throw new Error("Architecture fitness requires .pi/architecture.json");
				return textResult(evaluateArchitectureFitness(plan, graph.snapshot()));
			}
			if (params.action === "search") {
				if (!params.query) throw new Error("query is required for search");
				return textResult({
					matches: compactMatches(graph.search(params.query, { limit: params.limit, kinds: params.kinds })),
				});
			}
			if (params.action === "plan_verification" || params.action === "verify") {
				if (!ctx.isProjectTrusted()) {
					throw new Error("Impact verification requires a trusted project");
				}
				if (!params.paths || params.paths.length === 0) {
					throw new Error("paths is required for impact verification");
				}
				const catalog = await loadImpactVerificationCatalog(ctx.workspace.sourceRoot);
				if (!catalog) throw new Error("Impact verification requires .pi/checks.json");
				const impact = graph.impactMap(params.paths, queryOptions(params));
				if (params.action === "plan_verification") {
					return textResult(planImpactVerification(catalog, impact));
				}
				return textResult(
					await verifyImpactPlan(
						params.objective ?? `Verify impact of ${params.paths.join(", ")}`,
						catalog,
						impact,
						ctx.workspace.logicalRoot,
						(command, args, options) => pi.exec(command, args, options),
						signal,
					),
				);
			}
			if (params.action === "impact" && params.path) {
				const nodeIds = graph.nodeIdsForFile(params.path);
				if (nodeIds.length === 0) throw new Error(`No indexed symbols found for file: ${params.path}`);
				return textResult({
					origin: { path: params.path, nodeCount: nodeIds.length },
					...compactPaths(graph.impact(nodeIds, queryOptions(params))),
				});
			}
			const selection = selectNodeId(graph, params);
			if (params.action === "dependencies") {
				return textResult({
					origin: selection,
					...compactPaths(graph.dependencies(selection.nodeId, queryOptions(params))),
				});
			}
			if (params.action === "dependents") {
				return textResult({
					origin: selection,
					...compactPaths(graph.dependents(selection.nodeId, queryOptions(params))),
				});
			}
			return textResult({
				origin: selection,
				...compactPaths(graph.impact([selection.nodeId], queryOptions(params))),
			});
		},
	});

	pi.on("tool_result", (event) => {
		if (!service) return;
		if (event.toolName === "bash") {
			service.markDirty();
			return;
		}
		if (event.toolName === "edit" || event.toolName === "write") {
			const path = event.input.path;
			service.markDirty(typeof path === "string" ? [path] : undefined);
		}
	});

	pi.on("session_shutdown", async () => {
		unregisterImpactProvider?.();
		unregisterImpactProvider = undefined;
		await service?.dispose();
		service = undefined;
		workspaceRoot = undefined;
	});
}
