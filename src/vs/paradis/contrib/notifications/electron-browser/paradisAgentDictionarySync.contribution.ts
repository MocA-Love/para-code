/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の読み上げに選んだ辞書（Aivis のユーザー辞書・ElevenLabs の発音辞書）を、エージェントの読み上げ
// （aivis-mcp）にも使わせる。起動時と、辞書か「通知と同じ辞書をエージェントの読み上げにも使う」が変わったときに、
// 手元の aivis-mcp（shared process）へ、SSH で接続中なら接続先の aivis-mcp（REH サーバー）へも今の設定を渡す。
//
// 何を書く・消すか（同じ値なら呼ばない、Para Code が書いた値のときだけ消す、2.5.3 未満なら何もしない）は
// 実行する側（node/paradisAgentDictionarySync.ts）が決める。ここは設定を渡すだけで、続けて変わったときは
// 少し待ってからまとめて 1 回渡す。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { IParadisAgentDictionarySyncResult, PARADIS_AGENT_DICTIONARY_CHANNEL, paradisAgentDictionaryRequestFromSettings } from '../common/paradisAgentDictionary.js';

/** 辞書を選び直す操作が続くあいだは待つ。 */
const DEBOUNCE_MS = 1_500;

class ParadisAgentDictionarySyncContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.contrib.agentDictionarySync';

	private readonly scheduler = this._register(new RunOnceScheduler(() => this.sync(), DEBOUNCE_MS));
	/** 最後に渡した設定（同じなら渡し直さない）。 */
	private lastSent: string | undefined;

	constructor(
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.settingsService.onDidChange(scope => {
			if (scope === 'aivis' && this.key() !== this.lastSent) {
				this.scheduler.schedule();
			}
		}));
		// 起動時も渡す（Para Code が動いていない間に設定や aivis-mcp が変わっていることがある）
		this.scheduler.schedule();
	}

	private key(): string {
		return JSON.stringify(paradisAgentDictionaryRequestFromSettings(this.settingsService.getAivisSettings()));
	}

	private sync(): void {
		const request = paradisAgentDictionaryRequestFromSettings(this.settingsService.getAivisSettings());
		const key = JSON.stringify(request);
		if (key === this.lastSent) {
			return;
		}
		this.lastSent = key;
		// 外部ツールの設定のために UI を待たせない（結果はそれぞれの側のログに出る）
		void this.sharedProcessService.getChannel(PARADIS_AGENT_DICTIONARY_CHANNEL).call<IParadisAgentDictionarySyncResult>('apply', request)
			.catch(error => this.logService.warn(`[ParadisAgentDictionary] could not reach the shared process: ${error instanceof Error ? error.message : String(error)}`));
		const connection = this.remoteAgentService.getConnection();
		if (connection) {
			// 接続先が古い（このチャネルを持たない）ときは何もしない
			void connection.getChannel(PARADIS_AGENT_DICTIONARY_CHANNEL).call<IParadisAgentDictionarySyncResult>('apply', request)
				.catch(error => this.logService.info(`[ParadisAgentDictionary] the remote server did not take the dictionary: ${error instanceof Error ? error.message : String(error)}`));
		}
	}
}

registerWorkbenchContribution2(ParadisAgentDictionarySyncContribution.ID, ParadisAgentDictionarySyncContribution, WorkbenchPhase.AfterRestored);
