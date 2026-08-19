/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルの find/grep 用 ripgrep チャネル。shared process 版は常に手元のマシンで動くため、
// SSH 接続先のワークスペースを検索しようとしても ripgrep が接続先のファイルへ到達できない。
// 実行そのもの (paradisMobileSearch.ts) はどちらのマシンでも同じなので、同じサービス実装を
// shared process / REH サーバーの両方に登録するだけで済む。

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisFileSearchResult, IParadisTextSearchResult, PARADIS_REMOTE_SEARCH_CHANNEL } from '../common/paradisRemoteSearch.js';
import { paradisSearchFiles, paradisSearchText } from './paradisMobileSearch.js';

export class ParadisRemoteSearchService {
	constructor(private readonly logService: ILogService) { }

	searchFiles(rootPath: string, query: string, maxResults: number): Promise<IParadisFileSearchResult> {
		return paradisSearchFiles(rootPath, query, Math.min(Math.max(1, maxResults), 500), this.logService);
	}

	searchText(rootPath: string, query: string, maxResults: number): Promise<IParadisTextSearchResult> {
		return paradisSearchText(rootPath, query, Math.min(Math.max(1, maxResults), 500), this.logService);
	}
}

export class ParadisRemoteSearchChannel<TContext = string> implements IServerChannel<TContext> {
	constructor(private readonly service: ParadisRemoteSearchService) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const rootPath = typeof args[0] === 'string' ? args[0] : '';
		const query = typeof args[1] === 'string' ? args[1] : '';
		const maxResults = typeof args[2] === 'number' ? args[2] : 0;
		switch (command) {
			case 'searchFiles': return this.service.searchFiles(rootPath, query, maxResults) as Promise<T>;
			case 'searchText': return this.service.searchText(rootPath, query, maxResults) as Promise<T>;
			default: throw new Error(`Method not found: ${command}`);
		}
	}
}

/** sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。 */
export function registerParadisRemoteSearch(server: IPCServer<string>, logService: ILogService): IDisposable {
	server.registerChannel(PARADIS_REMOTE_SEARCH_CHANNEL, new ParadisRemoteSearchChannel(new ParadisRemoteSearchService(logService)));
	return { dispose: () => { } };
}

/**
 * serverServices.ts（REH）の登録点から1行で呼べるファクトリ。
 *
 * SSH 接続先のワークスペースは接続先のファイルシステム上にしか実体が無い。shared process 版は
 * 常に手元のマシンで動くため、同じチャネルを接続先にも生やす。
 */
export function registerParadisRemoteSearchForServer<TContext>(server: IPCServer<TContext>, logService: ILogService): IDisposable {
	server.registerChannel(PARADIS_REMOTE_SEARCH_CHANNEL, new ParadisRemoteSearchChannel<TContext>(new ParadisRemoteSearchService(logService)));
	return { dispose: () => { } };
}
