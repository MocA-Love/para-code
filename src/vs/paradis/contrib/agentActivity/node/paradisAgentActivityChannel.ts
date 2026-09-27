/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペース別の使用量・作業実績・会話の全文索引のチャネル。shared process の登録口から登録する。
// 会話ログは手元のマシンのもの（`~/.claude`・`~/.codex`）だけを読む。

import { Event } from '../../../../base/common/event.js';
import { FileAccess } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { IParadisSpaceUsageRequest, IParadisWorkStatsRequest, PARADIS_AGENT_ACTIVITY_CHANNEL } from '../common/paradisAgentActivity.js';
import {
	PARADIS_SESSION_INDEX_RELATIVE_PATH,
	PARADIS_SESSION_INDEX_SETTING_ENABLED,
	PARADIS_SESSION_INDEX_SETTING_INCLUDE_TOOL_OUTPUT,
	PARADIS_SESSION_INDEX_SETTING_RETENTION_DAYS,
} from '../common/paradisSessionIndex.js';
import { ParadisAgentActivityService } from './paradisAgentActivityService.js';
import { ParadisAgentActivityWorkerHost } from './paradisAgentActivityWorkerHost.js';

export class ParadisAgentActivityChannel<TContext = string> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisAgentActivityService) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'spaceUsage': return this.service.spaceUsage(args[0] as IParadisSpaceUsageRequest) as Promise<T>;
			case 'workStats': return this.service.workStats(args[0] as IParadisWorkStatsRequest) as Promise<T>;
			case 'indexUpdate': return this.service.indexUpdate() as Promise<T>;
			case 'indexSearch': return this.service.indexSearch(typeof args[0] === 'string' ? args[0] : '', Array.isArray(args[1]) ? args[1] : []) as Promise<T>;
			case 'indexStatus': return this.service.indexStatus() as Promise<T>;
			case 'indexDelete': return this.service.indexDelete() as Promise<T>;
			default: throw new Error(`Method not found: ${command}`);
		}
	}
}

ParadisSharedProcessContributions.register(PARADIS_AGENT_ACTIVITY_CHANNEL, ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const configurationService = accessor.get(IConfigurationService);
	const userDataPath = accessor.get(INativeEnvironmentService).userDataPath;
	const workerPath = FileAccess.asFileUri('vs/paradis/contrib/agentActivity/node/paradisAgentActivityWorkerMain.js').fsPath;
	const service = new ParadisAgentActivityService({
		worker: new ParadisAgentActivityWorkerHost(ParadisAgentActivityWorkerHost.workerFactory(workerPath)),
		indexDbPath: join(userDataPath, ...PARADIS_SESSION_INDEX_RELATIVE_PATH),
		// 設定はアプリ全体（APPLICATION）なので、shared process が読む既定プロファイルの設定と一致する。
		// スキーマは画面側でしか登録されないので、既定値はサービス側で補う。
		indexSettings: () => ({
			enabled: configurationService.getValue(PARADIS_SESSION_INDEX_SETTING_ENABLED),
			retentionDays: configurationService.getValue(PARADIS_SESSION_INDEX_SETTING_RETENTION_DAYS),
			includeToolOutput: configurationService.getValue(PARADIS_SESSION_INDEX_SETTING_INCLUDE_TOOL_OUTPUT),
		}),
		onDidChangeIndexSettings: Event.map(Event.filter(configurationService.onDidChangeConfiguration, event => event.affectsConfiguration('paradis.sessionIndex')), () => undefined),
	}, logService);
	server.registerChannel(PARADIS_AGENT_ACTIVITY_CHANNEL, new ParadisAgentActivityChannel(service));
	return service;
});
