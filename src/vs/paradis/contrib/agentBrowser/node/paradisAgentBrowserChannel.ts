/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// workbench ⇔ shared process 間のバインディング操作用IPCチャネル。
// ctx（`window:<windowId>`）は接続ごとにIPC層が付与するため、workbench側から
// ウィンドウ識別子を明示的に送る必要はない（PlaywrightChannelと同じctx空間を共有する）。

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';
import { IParadisPlaywrightInvoker, ParadisAgentBrowserService } from './paradisAgentBrowserService.js';

export class ParadisAgentBrowserChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisAgentBrowserService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'bind':
				return this.service.bind(ctx, String(args[0]), String(args[1]), args[2] as { url: string; title: string }) as Promise<T>;
			case 'unbind':
				return this.service.unbind(String(args[0])) as Promise<T>;
			case 'listBindings':
				return this.service.listBindings(ctx) as Promise<T>;
			case 'listSeenTokens':
				return this.service.listSeenTokens() as Promise<T>;
			case 'listPaneStatuses':
				return this.service.listPaneStatuses() as Promise<T>;
			case 'acknowledgePaneStatus':
				return this.service.acknowledgePaneStatus(String(args[0])) as Promise<T>;
			case 'syncPaneShells':
				return this.service.syncPaneShells(ctx, Array.isArray(args[0]) ? args[0] as { token: string; shellPid: number }[] : []) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 * サービス生成・チャネル登録・ウィンドウ切断時のバインディング破棄の配線をまとめて行う。
 */
export function registerParadisAgentBrowser(
	server: IPCServer<string>,
	playwrightInvoker: IParadisPlaywrightInvoker,
	userDataPath: string,
	mainProcessService: IMainProcessService,
	logService: ILogService,
): IDisposable {
	const service = new ParadisAgentBrowserService(userDataPath, playwrightInvoker, server, mainProcessService, logService);
	server.registerChannel(PARADIS_AGENT_BROWSER_CHANNEL, new ParadisAgentBrowserChannel(service));
	return service;
}
