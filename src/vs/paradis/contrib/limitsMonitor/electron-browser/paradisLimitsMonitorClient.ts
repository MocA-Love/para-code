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
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
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
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
	) { }

	private get channel() {
		// 上限は、そのエージェントが使っている認証情報の側で数えられている。SSH で繋いでいる
		// 間はエージェントが接続先で動くので、接続先へ聞く（同じチャネルを REH 側にも生やしてある）。
		const remoteConnection = this.remoteAgentService.getConnection();
		return remoteConnection
			? remoteConnection.getChannel(PARADIS_LIMITS_MONITOR_CHANNEL)
			: this.sharedProcessService.getChannel(PARADIS_LIMITS_MONITOR_CHANNEL);
	}

	/** 接続先(REH)経由で動作しているか。アカウント削除の確認文言と削除経路の提示に使う。 */
	get connectedToRemote(): boolean {
		return this.remoteAgentService.getConnection() !== undefined;
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

	/**
	 * Codex ホームを検証した上で、そのホームが存在するマシン側から取り除く。
	 *
	 * 検証と削除は必ず同じマシンで行う。検証はこのチャネル（SSH 中はリモート）経由なのに
	 * 対して `URI.file()` + `fileService.del` は常にローカルを指すため、両者を混線させると
	 * 絶対パスが一致した別マシンのディレクトリを手元のゴミ箱へ移動してしまう（データ消失）。
	 *
	 * - ローカル: 検証もゴミ箱への移動も手元で完結する（復元可能）。
	 * - リモート: 検証も削除も REH 側で完結する。REH にゴミ箱の仕組みはないため完全削除
	 *   になる（UI 側はその旨を案内する）。
	 *
	 * @param expectedViaRemote 呼び出し元がユーザーに提示した経路（ダイアログ表示時点での
	 * 接続状態）。実行時の接続状態と不一致なら続行しない（fail-closed）。続行すると承認内容と
	 * 異なるマシンへの削除が走りうる。接続状態はここで一度だけ評価し、以後再評価しない。
	 */
	async removeCodexHome(homePath: string, expectedViaRemote: boolean): Promise<void> {
		const remoteConnection = this.remoteAgentService.getConnection();
		if ((remoteConnection !== undefined) !== expectedViaRemote) {
			throw new Error('Codex home removal aborted: the remote connection state changed');
		}
		if (remoteConnection) {
			await remoteConnection.getChannel(PARADIS_LIMITS_MONITOR_CHANNEL).call<void>('removeCodexHome', [homePath]);
			return;
		}
		// this.channel は接続状態を再評価するため、ローカル経路では使わず明示的に
		// shared process へ出す（1回目の評価と2回目の評価の間で接続が始まると、検証だけ
		// リモート・削除だけローカルという混線になりうる）。
		const target = await this.sharedProcessService.getChannel(PARADIS_LIMITS_MONITOR_CHANNEL).call<IParadisLimitsCodexRemovalTarget>('validateCodexHomeRemoval', [homePath]);
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
