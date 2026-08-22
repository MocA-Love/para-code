/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DefaultURITransformer } from '../../../base/common/uriIpc.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { Server as ChildProcessServer } from '../../../base/parts/ipc/node/ipc.cp.js';
import { Server as UtilityProcessServer } from '../../../base/parts/ipc/node/ipc.mp.js';
import { localize } from '../../../nls.js';
import { OPTIONS, parseArgs } from '../../environment/node/argv.js';
import { NativeEnvironmentService } from '../../environment/node/environmentService.js';
import { getLogLevel, isDevConsoleLogForwardingEnabled, registerDevConsoleLogForwarder } from '../../log/common/log.js';
import { LoggerChannel } from '../../log/common/logIpc.js';
import { LogService } from '../../log/common/logService.js';
import { LoggerService } from '../../log/node/loggerService.js';
import product from '../../product/common/product.js';
import { IProductService } from '../../product/common/productService.js';
import { IReconnectConstants, TerminalIpcChannels } from '../common/terminal.js';
import { HeartbeatService } from './heartbeatService.js';
import { PtyService } from './ptyService.js';
import { isUtilityProcess } from '../../../base/parts/sandbox/node/electronTypes.js';
import { timeout } from '../../../base/common/async.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
// PARA-PATCH: this same process also runs as the pty daemon that outlives the app (see below)
import { Server as SocketServer } from '../../../base/parts/ipc/node/ipc.net.js';
import { paradisPtyDaemonPathsMatch, paradisReadPtyDaemonEnv } from '../../../paradis/contrib/ptyDaemon/common/paradisPtyDaemonEnv.js';
import { paradisServePtyDaemon } from '../../../paradis/contrib/ptyDaemon/node/paradisPtyDaemonServer.js';
import { paradisRunPtyDaemonLifecycle } from '../../../paradis/contrib/ptyDaemon/node/paradisPtyDaemonLifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { paradisBootstrapPtyHost } from '../../../paradis/contrib/ptyDaemon/node/paradisPtyHostBootstrap.js';
import { paradisAwaitAdoption, paradisAwaitPtyDaemon, paradisPtyDaemonConnection } from '../../../paradis/contrib/ptyDaemon/node/paradisTerminalProcessFactory.js';
import { paradisAdoptIntoPtyService } from '../../../paradis/contrib/ptyDaemon/node/paradisAdoptIntoPtyService.js';

startPtyHost();

async function startPtyHost() {
	// Parse environment variables
	const startupDelay = parseInt(process.env.VSCODE_STARTUP_DELAY ?? '0');
	const simulatedLatency = parseInt(process.env.VSCODE_LATENCY ?? '0');
	const reconnectConstants: IReconnectConstants = {
		graceTime: parseInt(process.env.VSCODE_RECONNECT_GRACE_TIME || '0'),
		shortGraceTime: parseInt(process.env.VSCODE_RECONNECT_SHORT_GRACE_TIME || '0'),
		scrollback: parseInt(process.env.VSCODE_RECONNECT_SCROLLBACK || '100')
	};

	// Sanitize environment
	delete process.env.VSCODE_RECONNECT_GRACE_TIME;
	delete process.env.VSCODE_RECONNECT_SHORT_GRACE_TIME;
	delete process.env.VSCODE_RECONNECT_SCROLLBACK;
	delete process.env.VSCODE_LATENCY;
	delete process.env.VSCODE_STARTUP_DELAY;

	// Delay startup if needed, this must occur before RPC is setup to avoid the channel from timing
	// out.
	if (startupDelay) {
		await timeout(startupDelay);
	}

	// Setup RPC
	const _isUtilityProcess = isUtilityProcess(process);
	// PARA-PATCH: Para Code also runs this file as a daemon that outlives the app, so terminals
	// survive quitting it. The daemon has no parent to hold a channel to, so it takes connections
	// over a socket instead. Everything after this point is deliberately shared with the in-app pty
	// host: the daemon must expose exactly what the pty host exposes, or a window that connects to
	// it silently loses whatever upstream adds below. See vs/paradis/contrib/ptyDaemon.
	const paradisDaemon = paradisReadPtyDaemonEnv(process.env);
	const paradisBind = paradisDaemon ? await paradisServePtyDaemon(paradisDaemon.socketPath) : undefined;
	if (paradisBind && paradisBind.outcome === 'taken') {
		// A live daemon already owns this socket. Standing down keeps a second one from holding
		// terminals nobody can find; whoever started us connects to the winner instead.
		process.exit(0);
	}
	const paradisDaemonServer = paradisBind && paradisBind.outcome === 'bound' ? paradisBind.server : undefined;
	let server: ChildProcessServer<string> | UtilityProcessServer | SocketServer;
	if (paradisDaemonServer) {
		server = paradisDaemonServer;
	} else if (_isUtilityProcess) {
		server = new UtilityProcessServer();
	} else {
		server = new ChildProcessServer(TerminalIpcChannels.PtyHost);
	}

	const disposables = new DisposableStore();

	// Services
	const productService: IProductService = { _serviceBrand: undefined, ...product };
	const environmentService = new NativeEnvironmentService(parseArgs(process.argv, OPTIONS), productService);
	const loggerService = new LoggerService(getLogLevel(environmentService), environmentService.logsHome);
	server.registerChannel(TerminalIpcChannels.Logger, new LoggerChannel(loggerService, () => DefaultURITransformer));
	const logger = loggerService.createLogger('ptyhost', { name: localize('ptyHost', "Pty Host") });
	const logService = new LogService(logger);
	if (!environmentService.isBuilt && isDevConsoleLogForwardingEnabled) {
		disposables.add(registerDevConsoleLogForwarder(logService));
	}
	// PARA-PATCH: taking the socket happens before logging exists, so replay what it recorded
	for (const note of paradisBind?.notes ?? []) {
		logService.info(note);
	}

	// PARA-PATCH: only run as a daemon at the place this build would put one. Whether we are a
	// daemon is decided by environment variables, which are not a secret only the launcher knows —
	// left unchecked, a forged environment picks where we listen and, more sharply, which file we
	// unlink on the way out. See vs/paradis/contrib/ptyDaemon.
	if (paradisDaemon && !paradisPtyDaemonPathsMatch(paradisDaemon, {
		userDataPath: environmentService.userDataPath,
		buildId: paradisDaemon.buildId,
		platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
		xdgRuntimeDir: process.env['XDG_RUNTIME_DIR'],
	})) {
		logService.error(`[ParadisPtyDaemon] refusing to run as a daemon: ${paradisDaemon.socketPath} is not where this build keeps one`);
		process.exit(1);
	}

	// Log developer config
	if (startupDelay) {
		logService.warn(`Pty Host startup is delayed ${startupDelay}ms`);
	}
	if (simulatedLatency) {
		logService.warn(`Pty host is simulating ${simulatedLatency}ms latency`);
	}

	// Heartbeat responsiveness tracking
	const heartbeatService = new HeartbeatService();
	server.registerChannel(TerminalIpcChannels.Heartbeat, ProxyChannel.fromService(heartbeatService, disposables));

	// PARA-PATCH: terminals may belong to a daemon that outlives this process. Start reaching for it
	// now but do not wait here: channels are not registered yet, and requests for an unregistered
	// channel fail after a second, while starting a daemon can take ten. Making a terminal waits for
	// this instead. See vs/paradis/contrib/ptyDaemon.
	const paradisJoiningDaemon = paradisBootstrapPtyHost({
		env: process.env,
		execPath: process.execPath,
		bootstrapPath: FileAccess.asFileUri('bootstrap-fork').fsPath,
		logService,
	});
	paradisAwaitPtyDaemon(paradisJoiningDaemon);

	// Init pty service
	const ptyService = new PtyService(logService, productService, reconnectConstants, simulatedLatency);


	const ptyServiceChannel = ProxyChannel.fromService(ptyService, disposables);
	server.registerChannel(TerminalIpcChannels.PtyHost, ptyServiceChannel);

	// Register a channel for direct communication via Message Port
	// PARA-PATCH: windows reach the daemon under this same channel name, through the bridge process
	// that pipes their message port to the socket (see vs/paradis/contrib/ptyDaemon)
	if (_isUtilityProcess || paradisDaemon) {
		server.registerChannel(TerminalIpcChannels.PtyHostWindow, ptyServiceChannel);
	}

	// PARA-PATCH: take back terminals the daemon kept running while no app was here. This runs after
	// the channels are registered, so a window that connects meanwhile is answered rather than timed
	// out; the terminals it does not see yet show up once this finishes.
	paradisAwaitAdoption(paradisJoiningDaemon.then(async joined => {
		const paradisConnection = joined ? paradisPtyDaemonConnection() : undefined;
		if (paradisConnection) {
			await paradisAdoptIntoPtyService(ptyService, paradisConnection.host, logService);
		}
	}, error => logService.error('[ParadisPtyHost] could not join the daemon', error)));

	// PARA-PATCH: nothing outlives the app to clean up after the in-app pty host, but the daemon has
	// to decide its own end: write itself into the ledger, and step down once no one needs it.
	if (paradisDaemon && paradisDaemonServer) {
		disposables.add(paradisRunPtyDaemonLifecycle({
			env: paradisDaemon,
			connections: paradisDaemonServer,
			// Count what is attached too; the upstream listing only returns orphans.
			heldTerminals: () => ptyService.paradisListHeldTerminals(),
			logService,
		}));
	}

	// Clean up
	process.once('exit', () => {
		logService.trace('Pty host exiting');
		logService.dispose();
		heartbeatService.dispose();
		ptyService.dispose();
	});
}
