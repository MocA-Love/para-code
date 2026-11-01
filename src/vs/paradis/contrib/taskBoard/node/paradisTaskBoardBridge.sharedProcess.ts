/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process でタスクボードの接続口を立ち上げる。`paradis.sharedProcess.contribution.ts` から副作用 import される。
//
//  - HTTP の受け口（設定 `paradis.taskBoard.bridge.enabled` がオンの間だけ）
//  - ウィンドウが呼ぶチャネル（状態の報告・自分のターミナルの一覧）
//  - ウィンドウへの振り分け（各ウィンドウが shared process の接続へ登録したチャネルを ctx で選んで呼ぶ）
//  - para-browser MCP のツール（board_complete_step / board_ask_human）と hook のツールの開始

import { promises as fs } from 'fs';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { onParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import {
	PARADIS_TASK_BOARD_BRIDGE_CHANNEL,
	PARADIS_TASK_BOARD_BRIDGE_DISCOVERY_FILE,
	PARADIS_TASK_BOARD_BRIDGE_ENABLED_SETTING,
	PARADIS_TASK_BOARD_WINDOW_CHANNEL,
	ParadisTaskBoardWindowMethod,
} from '../common/paradisTaskBoardBridge.js';
import { paradisPeerIsOneOf } from '../../agentBrowser/node/paradisCdpPeerResolver.js';
import { paradisParseTaskBoardBoardRegistration } from '../common/paradisTaskBoardRelay.js';
import { ParadisTaskBoardAuditLog } from './paradisTaskBoardAuditLog.js';
import { ParadisTaskBoardBoardAuth } from './paradisTaskBoardBoardAuth.js';
import { ParadisTaskBoardBridgeServer } from './paradisTaskBoardBridgeServer.js';
import { ParadisTaskBoardRelayRouter } from './paradisTaskBoardRelayRouter.js';
import { IParadisTaskBoardWindowRouter, ParadisTaskBoardBridgeService } from './paradisTaskBoardBridgeService.js';

/** ウィンドウが呼ぶチャネル。ctx（`window:N`）で受け持ちを確かめる。 */
class ParadisTaskBoardBridgeChannel implements IServerChannel<string> {

	constructor(
		private readonly service: ParadisTaskBoardBridgeService,
		private readonly auth: ParadisTaskBoardBoardAuth,
		private readonly relay: ParadisTaskBoardRelayRouter,
	) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(ctx: string, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'listWindowTerminals': return this.service.listWindowTerminals(ctx) as T;
			case 'reportStatus': return this.service.reportStatus(ctx, arg) as T;
			// main の open() が返したボードの pid と鍵（窓が登録する。設計書 G1）
			case 'registerBoard': {
				const board = paradisParseTaskBoardBoardRegistration(arg);
				if (board) {
					this.auth.register(board);
				}
				return (board !== undefined) as T;
			}
			case 'registerRelaySession': return this.relay.register(ctx, arg) as T;
			case 'closeRelaySession': return this.relay.close(ctx, arg) as T;
			case 'relayEvent': return this.relay.relayEvent(ctx, arg) as T;
		}
		throw new Error(`Call not found: ${command}`);
	}
}

/** IPCServer を包んで、ctx でウィンドウを選んで呼ぶ。 */
function createWindowRouter(server: IPCServer<string>): IParadisTaskBoardWindowRouter {
	const windows = () => server.connections.map(connection => connection.ctx).filter(ctx => ctx.startsWith('window:'));
	return {
		windows,
		async call<T>(ctx: string, method: ParadisTaskBoardWindowMethod, arg: unknown, timeoutMs: number): Promise<T> {
			// getChannel の ctx の絞り込みは「その接続が現れるまで待つ」ので、先に接続があるかを確かめる
			if (!windows().includes(ctx)) {
				throw new Error('window is not connected');
			}
			const cancellation = new CancellationTokenSource();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const channel = server.getChannel(PARADIS_TASK_BOARD_WINDOW_CHANNEL, client => client.ctx === ctx);
				return await Promise.race([
					channel.call<T>(method, arg, cancellation.token),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							cancellation.cancel();
							reject(new Error(`timed out after ${timeoutMs}ms`));
						}, timeoutMs);
					}),
				]);
			} finally {
				clearTimeout(timer);
				cancellation.dispose();
			}
		},
	};
}

async function directoryExists(path: string): Promise<boolean> {
	try {
		return (await fs.stat(path)).isDirectory();
	} catch {
		return false;
	}
}

ParadisSharedProcessContributions.register('taskBoard', ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const configurationService = accessor.get(IConfigurationService);
	const environmentService = accessor.get(INativeEnvironmentService);
	const store = new DisposableStore();

	const audit = new ParadisTaskBoardAuditLog(join(environmentService.userDataPath, 'paradis', 'taskBoardRelay'), logService);
	const relay = new ParadisTaskBoardRelayRouter(createWindowRouter(server), audit, logService, Date.now, (keyHash, event) => service.emitRelay(keyHash, event));
	const service = store.add(new ParadisTaskBoardBridgeService(createWindowRouter(server), {
		directoryExists,
		ignorePathCase: isMacintosh || isWindows,
		newId: generateUuid,
		relaySessionWindow: (sessionId, keyHash) => relay.windowOf(sessionId, keyHash),
		onRelayLaunch: (request, outcome, reason) => relay.auditLaunch(request.relaySessionId ?? '', request.agent, request.repoPath, outcome, reason),
	}, logService));
	// ボード用のツールは、設定がオンのときだけ para-browser に出す（使わない人のエージェントに説明を載せない）
	const toolProvider = store.add(new MutableDisposable());
	store.add(onParadisAgentHookEvent(event => service.onHookEvent(event)));
	store.add(server.onDidAddConnection(connection => service.onWindowConnected(connection.ctx)));
	store.add(server.onDidRemoveConnection(connection => service.onWindowDisconnected(connection.ctx)));
	const auth = new ParadisTaskBoardBoardAuth((clientPort, serverPort, pids) => paradisPeerIsOneOf(clientPort, serverPort, process.pid, pids));
	store.add(server.onDidRemoveConnection(connection => relay.onWindowDisconnected(connection.ctx)));
	server.registerChannel(PARADIS_TASK_BOARD_BRIDGE_CHANNEL, new ParadisTaskBoardBridgeChannel(service, auth, relay));

	const httpServer = store.add(new ParadisTaskBoardBridgeServer(service, join(environmentService.userDataPath, PARADIS_TASK_BOARD_BRIDGE_DISCOVERY_FILE), logService, auth, relay));
	// 設定のスキーマは画面側でしか登録されないので、生の値を読む。既定はオフ（使う人だけが有効にする）なので、true のときだけ立てる
	const enabled = () => configurationService.getValue(PARADIS_TASK_BOARD_BRIDGE_ENABLED_SETTING) === true;
	let applying = Promise.resolve();
	const apply = () => {
		const on = enabled();
		if (on && !toolProvider.value) {
			toolProvider.value = paradisRegisterMcpToolProvider(service);
		} else if (!on) {
			toolProvider.clear();
		}
		applying = applying.then(() => on ? httpServer.start() : httpServer.stop()).catch(err => logService.warn('[ParadisTaskBoardBridge] applying the setting failed', String(err)));
	};
	store.add(configurationService.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(PARADIS_TASK_BOARD_BRIDGE_ENABLED_SETTING)) {
			apply();
		}
	}));
	apply();
	return store;
});
