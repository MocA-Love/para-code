/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code のコンテキストの内訳の保存（paradisClaudeContextStore.ts）を shared process に置き、チャネルで答える。
// `paradis.sharedProcess.contribution.ts` から副作用 import で読み込まれる。REH には置かない（SSH 先のペインの mod も戻りトンネルで手元の shared process へ送ってくる）。
// モバイル（paradisMobileAgentChat.ts）は同じプロセスの保存を `paradisClaudeContextStore()` で直接読む。

import { promises as fs } from 'fs';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import * as path from '../../../../base/common/path.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_CLAUDE_CONTEXT_CHANNEL, paradisAggregateClaudeContextPeriod } from '../common/paradisClaudeContextBreakdown.js';
import { paradisClaudeModBridge } from './paradisClaudeModBridge.js';
import { IParadisClaudeContextFiles, ParadisClaudeContextStore, paradisClaudeContextStore, paradisSetClaudeContextStore } from './paradisClaudeContextStore.js';

class ParadisClaudeContextChannel<TContext> implements IServerChannel<TContext> {

	constructor(private readonly store: ParadisClaudeContextStore) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		if (event === 'onDidChange') {
			return this.store.onDidChange as Event<unknown> as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'period': {
				// 期間の内訳（「AI コスト」の画面）。集計はここで済ませ、会話ごとの内訳は送らない
				const from = Array.isArray(arg) && typeof arg[0] === 'number' && Number.isFinite(arg[0]) ? arg[0] : undefined;
				const to = Array.isArray(arg) && typeof arg[1] === 'number' && Number.isFinite(arg[1]) ? arg[1] : undefined;
				if (from === undefined || to === undefined) {
					return Promise.reject(new Error('period takes [from, to]'));
				}
				return this.store.peaksBetween(from, to).then(({ peaks, since }) => paradisAggregateClaudeContextPeriod(peaks, since)) as Promise<T>;
			}
			case 'session': {
				const sessionId = Array.isArray(arg) && typeof arg[0] === 'string' ? arg[0] : undefined;
				return (sessionId !== undefined && sessionId.length <= 200 ? this.store.breakdownOf(sessionId) : Promise.resolve(undefined)) as Promise<T>;
			}
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

function files(directory: string): IParadisClaudeContextFiles {
	const file = path.join(directory, 'breakdowns.json');
	return {
		read: async () => {
			try {
				return await fs.readFile(file, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					return undefined;
				}
				throw error;
			}
		},
		write: async text => {
			await fs.mkdir(directory, { recursive: true });
			const temporary = `${file}.${process.pid}.tmp`;
			await fs.writeFile(temporary, text, 'utf8');
			await fs.rename(temporary, file);
		},
	};
}

ParadisSharedProcessContributions.register(PARADIS_CLAUDE_CONTEXT_CHANNEL, ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const directory = path.join(accessor.get(INativeEnvironmentService).userDataPath, 'paradis', 'claudeContext');
	const disposables = new DisposableStore();
	const store = disposables.add(new ParadisClaudeContextStore(files(directory), error => logService.warn('[paradisClaudeContext] could not read or write the saved context breakdowns', error)));
	disposables.add(paradisClaudeModBridge.onEvent(event => store.observe(event)));
	paradisSetClaudeContextStore(store);
	disposables.add(toDisposable(() => {
		if (paradisClaudeContextStore() === store) {
			paradisSetClaudeContextStore(undefined);
		}
	}));
	server.registerChannel(PARADIS_CLAUDE_CONTEXT_CHANNEL, new ParadisClaudeContextChannel<string>(store));
	return disposables;
});
