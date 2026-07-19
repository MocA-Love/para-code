/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process のリミットモニターチャネルを呼ぶ薄いクライアント。
// 設定値(cswapパス・追加Codexホーム)の解決もここで行い、ウィジェット/パネル/ダイアログは
// このクライアント経由でのみバックエンドへアクセスする。

import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import {
	IParadisLimitsCodexRemovalTarget,
	IParadisLimitsFetchOptions,
	IParadisLimitsSetupHandle,
	IParadisLimitsSetupState,
	IParadisLimitsSnapshot,
	PARADIS_LIMITS_MONITOR_CHANNEL,
	ParadisLimitsDuplicateDecision
} from '../common/paradisLimitsMonitor.js';

export const PARADIS_LIMITS_SETTING_ENABLED = 'paradis.limitsMonitor.enabled';
export const PARADIS_LIMITS_SETTING_CSWAP_PATH = 'paradis.limitsMonitor.cswapPath';
export const PARADIS_LIMITS_SETTING_CODEX_HOMES = 'paradis.limitsMonitor.codexHomes';

export class ParadisLimitsMonitorClient {

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
	) { }

	private get channel() {
		return this.sharedProcessService.getChannel(PARADIS_LIMITS_MONITOR_CHANNEL);
	}

	private fetchOptions(bypassCache: boolean): IParadisLimitsFetchOptions {
		const options: { bypassCache?: boolean; cswapPath?: string; codexHomes?: string[] } = {};
		const cswapPath = this.configurationService.getValue<string>(PARADIS_LIMITS_SETTING_CSWAP_PATH);
		if (typeof cswapPath === 'string' && cswapPath.trim().length > 0) {
			options.cswapPath = cswapPath.trim();
		}
		const codexHomes = this.configurationService.getValue<string[]>(PARADIS_LIMITS_SETTING_CODEX_HOMES);
		if (Array.isArray(codexHomes) && codexHomes.length > 0) {
			options.codexHomes = codexHomes.filter(entry => typeof entry === 'string' && entry.trim().length > 0);
		}
		if (bypassCache) {
			options.bypassCache = true;
		}
		return options;
	}

	getSnapshot(bypassCache = false): Promise<IParadisLimitsSnapshot> {
		return this.channel.call<IParadisLimitsSnapshot>('getSnapshot', [this.fetchOptions(bypassCache)]);
	}

	/** Codexアカウント追加(existingHome指定時は既存ホームの再ログイン)を開始する。 */
	startCodexLogin(existingHome?: string): Promise<IParadisLimitsSetupHandle> {
		return this.channel.call<IParadisLimitsSetupHandle>('startCodexLogin', [existingHome, this.fetchOptions(false).codexHomes]);
	}

	async moveCodexHomeToTrash(homePath: string): Promise<void> {
		const target = await this.channel.call<IParadisLimitsCodexRemovalTarget>('validateCodexHomeRemoval', [homePath]);
		await this.fileService.del(URI.file(target.homePath), { recursive: true, useTrash: true });
	}

	resolveCodexDuplicate(sessionId: string, decision: ParadisLimitsDuplicateDecision): Promise<void> {
		return this.channel.call<void>('resolveCodexDuplicate', [sessionId, decision]);
	}

	/** Claudeアカウント追加(slot指定時は既存スロットの再ログイン)を開始する。 */
	startClaudeSetup(slot?: number): Promise<IParadisLimitsSetupHandle> {
		return this.channel.call<IParadisLimitsSetupHandle>('startClaudeSetup', [slot]);
	}

	getSetupState(sessionId: string): Promise<IParadisLimitsSetupState> {
		return this.channel.call<IParadisLimitsSetupState>('getSetupState', [sessionId]);
	}

	submitClaudeSetupCode(sessionId: string, code: string): Promise<void> {
		return this.channel.call<void>('submitClaudeSetupCode', [sessionId, code]);
	}

	cancelSetup(sessionId: string): Promise<void> {
		return this.channel.call<void>('cancelSetup', [sessionId]);
	}
}
