import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { getSocketPath } from "./config.ts";
import { handleIpcRequest, openRpcStream } from "./handler.ts";
import { startIpcServer } from "./ipc/server.ts";
import { getRadiusOrchestratorBaseUrl, isRadiusEnabled, radiusPresence } from "./radius.ts";
import { type RemoteServerOptions, type RunningRemoteServer, startRemoteServer } from "./remote/server.ts";
import { supervisor } from "./supervisor.ts";

export interface ServeOptions {
	remote?: RemoteServerOptions;
}

export async function serve(options: ServeOptions = {}): Promise<void> {
	const socketPath = getSocketPath();
	mkdirSync(dirname(socketPath), { recursive: true });
	const handler = Object.assign(handleIpcRequest, { openRpcStream });
	const server = await startIpcServer(handler);
	let remoteServer: RunningRemoteServer | undefined;

	try {
		await supervisor.recoverAfterRestart();
		if (isRadiusEnabled()) {
			const machine = await radiusPresence.start();
			console.log(`radius integration enabled: ${socketPath} -> ${getRadiusOrchestratorBaseUrl()}`);
			if (machine) {
				console.log(`radius machine id: ${machine.id}`);
			}
		} else {
			console.log("radius integration disabled: login radius in ~/.pi/agent/auth.json or set RADIUS_API_KEY");
		}
		if (options.remote) {
			remoteServer = await startRemoteServer(options.remote, handler);
			console.log(`remote gateway listening on http://${remoteServer.host}:${remoteServer.port}`);
		}
	} catch (error) {
		await remoteServer?.close();
		server.close();
		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}
		throw error;
	}

	console.log(`orchestrator listening on ${socketPath}`);

	let shutdownPromise: Promise<void> | undefined;
	const shutdown = async (exitCode: number) => {
		if (shutdownPromise) {
			await shutdownPromise;
			process.exit(exitCode);
		}

		shutdownPromise = (async () => {
			await remoteServer?.close();
			server.close();
			await supervisor.shutdown();
			await radiusPresence.stop();
			if (existsSync(socketPath)) {
				unlinkSync(socketPath);
			}
		})();

		await shutdownPromise;
		process.exit(exitCode);
	};

	process.on("SIGINT", () => {
		void shutdown(0);
	});
	process.on("SIGTERM", () => {
		void shutdown(0);
	});
	process.on("uncaughtException", (error) => {
		console.error(error);
		void shutdown(1);
	});
	process.on("unhandledRejection", (reason) => {
		console.error(reason);
		void shutdown(1);
	});

	await new Promise<void>(() => {
		// Keep the process alive until a signal or fatal error triggers shutdown.
	});
}
