/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// おやすみモードの状態変化を aivis-mcp 側のミュートへ反映する。
// Para Code 内の抑制は paradisNotificationTrigger.contribution.ts が担うが、別のターミナルや
// 別のMCPクライアントから直接叩かれる aivis の発話はそちらでは止められないため、ここで橋渡しする。
//
// 同期するのは onDidChange('dnd') が飛んだときだけにする。ステータスバーは残り時間の表示のために
// 1分ごとに状態を読み直しているが、その周期で CLI を起動する必要は無い（時限ミュートの解除時刻は
// 最初の1回で aivis 側へ渡してある）。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { ParadisAivisMuteBridgeClient } from './paradisAivisMuteBridgeClient.js';

class ParadisAivisMuteSyncContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.contrib.aivisMuteSync';

	private readonly client: ParadisAivisMuteBridgeClient;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
	) {
		super();

		this.client = instantiationService.createInstance(ParadisAivisMuteBridgeClient);

		this._register(this.settingsService.onDidChange(scope => {
			if (scope === 'dnd') {
				this.sync();
			}
		}));
	}

	private sync(): void {
		const state = this.settingsService.getDoNotDisturb();
		const remainingMs = state.until !== undefined ? Math.max(0, state.until - Date.now()) : undefined;
		// 外部ツールの同期のために UI 操作を待たせない（失敗は shared process 側でログに落ちる）。
		this.client.sync(state.enabled, remainingMs).catch(() => { });
	}
}

registerWorkbenchContribution2(ParadisAivisMuteSyncContribution.ID, ParadisAivisMuteSyncContribution, WorkbenchPhase.AfterRestored);
