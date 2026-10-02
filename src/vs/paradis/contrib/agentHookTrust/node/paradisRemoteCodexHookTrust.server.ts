/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先（REH）へ、Codex の hook の信頼を付けるチャネルを足す。`paradis.server.contribution.ts`
// から副作用 import で読み込まれる。
//
// hook 自体はウィンドウ（paradisRemoteAgentHooks.contribution.ts）が接続先の `~/.codex/hooks.json` と
// アカウント用ホームへ置く。Codex は信頼の無い hook を実行しないので、置いた後にウィンドウがここを呼ぶ。
// 扱うホームは接続先が決める（ウィンドウの言い値のパスは受け取らない）。設定（自動で付けるか）は
// REH からは読めないので、呼ぶかどうかはウィンドウが決める。

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join, normalize } from '../../../../base/common/path.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { homedir } from 'os';
import { ILogService } from '../../../../platform/log/common/log.js';
import { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { ParadisServerContributions } from '../../../common/paradisProcessContributions.js';
import { paradisManagedAgentHookCommand } from '../../agentBrowser/common/paradisAgentHooks.js';
import { paradisCodexHomes } from '../../agentBrowser/node/paradisAgentHome.js';
import { IParadisCodexHookTrustGrantResult, IParadisCodexHookTrustStatus, PARADIS_REMOTE_CODEX_HOOK_TRUST_CHANNEL } from '../common/paradisCodexHookTrust.js';
import { paradisGrantCodexHookTrustFile, paradisInspectCodexHookTrustFile } from './paradisCodexHookTrustFile.js';

/** hook を置く先と同じホーム（既定の `~/.codex`・`$CODEX_HOME`・ログイン済みのアカウント用ホーム）。 */
function remoteCodexHomes(): string[] {
	const homes: string[] = [];
	for (const home of [join(homedir(), '.codex'), ...paradisCodexHomes()]) {
		const normalized = normalize(home);
		if (!homes.includes(normalized)) {
			homes.push(normalized);
		}
	}
	return homes;
}

class ParadisRemoteCodexHookTrustChannel extends Disposable implements IServerChannel<RemoteAgentConnectionContext> {

	/** 同じ config.toml を複数のウィンドウから同時に書かないよう、1 本ずつ流す。 */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly logService: ILogService) {
		super();
	}

	listen<T>(_ctx: RemoteAgentConnectionContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: RemoteAgentConnectionContext, command: string): Promise<T> {
		switch (command) {
			case 'getStatus': return this.enqueue(() => this.getStatus()) as Promise<T>;
			case 'grant': return this.enqueue(() => this.grant()) as Promise<T>;
			// ウィンドウが接続先の Codex の会話（rollout）を探す場所
			case 'listCodexHomes': return Promise.resolve(remoteCodexHomes()) as Promise<T>;
		}
		throw new Error(`Call not found: ${command}`);
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private getStatus(): Promise<IParadisCodexHookTrustStatus[]> {
		if (process.platform === 'win32') {
			return Promise.resolve([]);
		}
		const command = paradisManagedAgentHookCommand();
		return Promise.all(remoteCodexHomes().map(home => paradisInspectCodexHookTrustFile(home, command)));
	}

	private async grant(): Promise<IParadisCodexHookTrustGrantResult[]> {
		// 接続先へ置く hook は POSIX のコマンドだけ（paradisRemoteAgentHooks は SSH の接続先にしか置かない）
		if (process.platform === 'win32') {
			return [];
		}
		const command = paradisManagedAgentHookCommand();
		const results: IParadisCodexHookTrustGrantResult[] = [];
		for (const home of remoteCodexHomes()) {
			const result = await paradisGrantCodexHookTrustFile(home, command);
			if (result.outcome !== 'nothing-installed' && result.outcome !== 'already-trusted') {
				this.logService.info(`[ParadisRemoteCodexHookTrust] ${home}: ${result.outcome}${result.grantedEvents.length > 0 ? ` (${result.grantedEvents.join(', ')})` : ''}${result.detail ? ` - ${result.detail}` : ''}`);
			}
			results.push(result);
		}
		return results;
	}
}

ParadisServerContributions.register('remoteCodexHookTrust', ({ server, accessor }) => {
	const channel = new ParadisRemoteCodexHookTrustChannel(accessor.get(ILogService));
	server.registerChannel(PARADIS_REMOTE_CODEX_HOOK_TRUST_CHANNEL, channel);
	return channel;
});
