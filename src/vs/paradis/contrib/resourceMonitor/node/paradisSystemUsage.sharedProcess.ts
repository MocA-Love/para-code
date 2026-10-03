/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 手元のマシンのシステム使用率の履歴を shared process で持ち、チャネルで答える。
// shared process はアプリが動いている間ずっと居るので、画面を開いていなくても履歴が貯まる。
// 接続先（REH）は `paradisHostResourcesChannel.ts` が同じサービスを持つ。

import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_SYSTEM_USAGE_CHANNEL, PARADIS_SYSTEM_USAGE_COMMAND } from '../common/paradisSystemUsage.js';
import { ParadisSystemUsageService } from './paradisSystemUsageService.js';

class ParadisSystemUsageChannel<TContext> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisSystemUsageService) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case PARADIS_SYSTEM_USAGE_COMMAND:
				return this.service.getSystemUsage(arg) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

ParadisSharedProcessContributions.register(PARADIS_SYSTEM_USAGE_CHANNEL, ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	let warned = false;
	const service = new ParadisSystemUsageService({
		onError: error => {
			// 5 秒ごとに同じ失敗を出し続けない
			if (!warned) {
				warned = true;
				logService.warn('[paradisSystemUsage] could not read this machine\'s usage', error);
			}
		},
	});
	service.start();
	server.registerChannel(PARADIS_SYSTEM_USAGE_CHANNEL, new ParadisSystemUsageChannel<string>(service));
	return service;
});
