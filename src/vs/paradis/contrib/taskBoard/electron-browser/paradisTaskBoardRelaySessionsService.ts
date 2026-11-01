/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の窓の中継のセッション（common/paradisTaskBoardRelaySessions.ts）を、窓のサービスにつないで 1 つだけ置く。
// 入口のボタン（セッションを作る）と、接続口からの振り分け（依頼を受ける）の両方から使う。中継はコマンドに登録しない
// （拡張機能の executeCommand から呼べないように）。

import { isEqual } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { PARADIS_TASK_BOARD_BRIDGE_CHANNEL } from '../common/paradisTaskBoardBridge.js';
import { PARADIS_TASK_BOARD_REMOTE_CHANNEL } from '../common/paradisTaskBoardRemote.js';
import { IParadisTaskBoardRelayRecord, ParadisTaskBoardRelaySessions } from '../common/paradisTaskBoardRelaySessions.js';

export const IParadisTaskBoardRelaySessionsService = createDecorator<IParadisTaskBoardRelaySessionsService>('paradisTaskBoardRelaySessionsService');

export interface IParadisTaskBoardRelaySessionsService extends Pick<ParadisTaskBoardRelaySessions, 'prepare' | 'bind' | 'close' | 'handle' | 'launchTarget'> {
	readonly _serviceBrand: undefined;
}

/** リポジトリ（uri.toString()）ごとの記録。 */
const RECORD_STORAGE_KEY = 'paradis.taskBoard.relayRecords';
/** 覚えておくリポジトリの数（古いものから落とす）。 */
const MAX_REPOSITORIES = 50;

class ParadisTaskBoardRelaySessionsService extends ParadisTaskBoardRelaySessions implements IParadisTaskBoardRelaySessionsService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IParadisWorkspaceSwitchService switchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService worktreeService: IParadisWorktreeService,
		@IStorageService storageService: IStorageService,
		@ILogService logService: ILogService,
	) {
		const readAll = (): Record<string, IParadisTaskBoardRelayRecord> => {
			try {
				const value: unknown = JSON.parse(storageService.get(RECORD_STORAGE_KEY, StorageScope.APPLICATION, '{}'));
				return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, IParadisTaskBoardRelayRecord> : {};
			} catch {
				return {};
			}
		};
		const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
		super({
			remoteAuthority: environmentService.remoteAuthority,
			remoteChannel: () => remoteAgentService.getConnection()?.getChannel(PARADIS_TASK_BOARD_REMOTE_CHANNEL),
			bridge: sharedProcessService.getChannel(PARADIS_TASK_BOARD_BRIDGE_CHANNEL),
			isWindowFolder: uri => switchService.repositories.some(repository => isEqual(repository.uri, uri))
				|| paradisListSpaces(switchService.repositories, worktreeService).some(space => isEqual(space.uri, uri)),
			newSessionId: () => generateUuid().replace(/-/g, ''),
			readRecord: repository => {
				const record = readAll()[repository];
				const worktrees = Array.isArray(record?.worktrees) ? record.worktrees.filter((item): item is { dir: string; branch: string } => !!item && typeof item === 'object' && typeof item.dir === 'string' && typeof item.branch === 'string') : [];
				return { worktrees, branches: strings(record?.branches) };
			},
			writeRecord: (repository, record) => {
				const all = readAll();
				delete all[repository];
				all[repository] = record;
				const kept = Object.entries(all).slice(-MAX_REPOSITORIES);
				storageService.store(RECORD_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)), StorageScope.APPLICATION, StorageTarget.MACHINE);
			},
			warn: (message, error) => logService.warn(message, error),
		});
	}
}

registerSingleton(IParadisTaskBoardRelaySessionsService, ParadisTaskBoardRelaySessionsService, InstantiationType.Delayed);
