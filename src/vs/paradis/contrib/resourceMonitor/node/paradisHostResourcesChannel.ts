/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（REH）のマシン全体の使用量を答えるチャネル。
//
// なぜ要るか: SSH で繋いでいる間、ターミナルもエージェントも接続先で動く。忙しいのは接続先の
// マシンで、手元の数字を見ていても分からない（実際、接続先がロードアベレージ400で詰まって
// いる間も、表示は手元のままだった）。
//
// 「Para Code 自身がどれだけ食っているか」は別の問いで、そちらは今までどおり手元の
// electron-main が答える。Para Code は手元で動いているのだから、それが正しい。ここが答えるのは
// マシン全体の話だけ。

import { homedir } from 'os';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisHostResources, IParadisHostResourcesRequest, PARADIS_HOST_MACHINE_ID_HASH_COMMAND, PARADIS_HOST_RESOURCES_CHANNEL } from '../common/paradisResourceMonitor.js';
import { ParadisHostResourceSampler } from './paradisHostResources.js';
import { PARADIS_SYSTEM_USAGE_COMMAND } from '../common/paradisSystemUsage.js';
import { ParadisSystemUsageService } from './paradisSystemUsageService.js';
import { paradisGetMachineIdHash } from '../../../node/paradisMachineId.js';

/** 短時間に何度も聞かれたときに、同じ結果を返してよい長さ。 */
const SNAPSHOT_MAX_AGE_MS = 2000;

export class ParadisHostResourcesService {

	private readonly sampler = new ParadisHostResourceSampler();
	private cached: IParadisHostResources | undefined;
	private inflight: Promise<IParadisHostResources> | undefined;

	constructor(private readonly logService: ILogService) { }

	async getHostResources(request: IParadisHostResourcesRequest): Promise<IParadisHostResources> {
		if (request.force !== true && this.cached !== undefined && Date.now() - this.cached.collectedAt <= SNAPSHOT_MAX_AGE_MS) {
			return this.cached;
		}
		// force（モバイルの引っ張って更新）は進行中の収集に相乗りさせない。相乗りさせると
		// 「引っ張っても変わらない」ことがある（合流先はその要求より前に始まった収集のため）。
		if (this.inflight !== undefined && request.force !== true) {
			return this.inflight;
		}
		// ホームのボリュームは常に先頭。モバイル側が最初の1件を「主ボリューム」として大きく出す。
		const collection = this.sampler.read([homedir(), ...(request.diskPaths ?? [])])
			.then(resources => {
				this.cached = resources;
				return resources;
			})
			.catch(error => {
				this.logService.warn('[paradisHostResources] could not read this machine\'s resources', error);
				throw error;
			})
			.finally(() => {
				this.inflight = undefined;
			});
		this.inflight = collection;
		return collection;
	}
}

class ParadisHostResourcesChannel<TContext> implements IServerChannel<TContext> {

	constructor(
		private readonly service: ParadisHostResourcesService,
		private readonly systemUsage: ParadisSystemUsageService,
	) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'getHostResources':
				return this.service.getHostResources((arg ?? {}) as IParadisHostResourcesRequest) as Promise<T>;
			// このマシンの印（paradisMachineId.ts）。モバイルが SSH 先の使用量を、別にペアリングした PC と
			// 同じ機械として見分けるのに使う。読めなければ undefined。
			case PARADIS_HOST_MACHINE_ID_HASH_COMMAND:
				return paradisGetMachineIdHash() as Promise<T>;
			// 接続先のマシン全体の使用率の履歴（5 秒刻み 1 時間・1 分刻み 24 時間）。この版より古い REH は
			// Method not found で失敗し、画面は今の値（getHostResources）だけを出す。
			case PARADIS_SYSTEM_USAGE_COMMAND:
				return this.systemUsage.getSystemUsage(arg) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/** serverServices.ts の PARA-PATCH 点から1行で呼べるファクトリ。 */
export function registerParadisHostResourcesForServer<TContext>(server: IPCServer<TContext>, logService: ILogService): IDisposable {
	// 履歴はサーバーが居る間ずっと測る（誰も見ていなくても、開いた瞬間に過去が見えるように）。
	let warned = false;
	const systemUsage = new ParadisSystemUsageService({
		onError: error => {
			if (!warned) {
				warned = true;
				logService.warn('[paradisHostResources] could not read this machine\'s usage history', error);
			}
		},
	});
	systemUsage.start();
	server.registerChannel(PARADIS_HOST_RESOURCES_CHANNEL, new ParadisHostResourcesChannel<TContext>(new ParadisHostResourcesService(logService), systemUsage));
	return systemUsage;
}
