/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process のリミットモニターチャネルを呼ぶ薄いクライアント。
// 設定値(追加Codexホーム)の解決もここで行い、ウィジェット/パネル/ダイアログは
// このクライアント経由でのみバックエンドへアクセスする。
//
// Claude の分は Codex の分と1つのスナップショットに合わせて返す。どこに聞くかはウィンドウで決まる:
//  - 手元のウィンドウ: 手元の shared process の PARADIS_CLAUDE_ACCOUNTS_CHANNEL（登録したアカウントの
//    一覧・切り替え・登録）
//  - SSH のウィンドウ: 接続先（REH）の PARADIS_CLAUDE_ACCOUNTS_CHANNEL。接続先のログインについて、手元と
//    同じ一覧・切り替え・登録をする（Claude Code は接続先で接続先のログインを使って動くため。登録した
//    アカウントも接続先ごと）。接続先が切り替えに対応していない（`unsupportedOnHost`）ときと、スマホが
//    接続先のログインだけを見るとき（`hostLoginOnly`）は、PARADIS_LIMITS_MONITOR_CHANNEL の
//    PARADIS_CLAUDE_HOST_STATE_COMMAND で、いまのログインだけを読み取り専用で出す

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { paradisResolveMobileWindowHost } from '../../mobileRelay/common/paradisMobileHost.js';
import {
	IParadisLimitsCodexRemovalTarget,
	IParadisLimitsFetchOptions,
	IParadisLimitsSetupHandle,
	IParadisLimitsSetupState,
	IParadisLimitsSnapshot,
	PARADIS_LIMITS_MONITOR_CHANNEL,
	ParadisLimitsDuplicateDecision
} from '../common/paradisLimitsMonitor.js';
import {
	IParadisClaudeAccountsState,
	IParadisClaudeRegisterResult,
	IParadisClaudeStateRequest,
	IParadisClaudeSwitchResult,
	PARADIS_CLAUDE_ACCOUNTS_CHANNEL,
	PARADIS_CLAUDE_HOST_STATE_COMMAND,
	paradisClaudeHostAccountsState
} from '../common/paradisClaudeAccounts.js';

export const PARADIS_LIMITS_SETTING_ENABLED = 'paradis.limitsMonitor.enabled';
export const PARADIS_LIMITS_SETTING_CODEX_HOMES = 'paradis.limitsMonitor.codexHomes';

export class ParadisLimitsMonitorClient {

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@ILabelService private readonly labelService: ILabelService,
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
		// getConnection() は繋いでいなければ null を返す（undefined と比べると手元でも true になり、
		// ゴミ箱へ移すのに「完全に削除」と確認していた）。
		return this.remoteAgentService.getConnection() !== null;
	}

	private fetchOptions(bypassCache: boolean): IParadisLimitsFetchOptions {
		const options: { bypassCache?: boolean; codexHomes?: string[] } = {};
		const codexHomes = this.configurationService.getValue<string[]>(PARADIS_LIMITS_SETTING_CODEX_HOMES);
		if (Array.isArray(codexHomes) && codexHomes.length > 0) {
			options.codexHomes = codexHomes.filter(entry => typeof entry === 'string' && entry.trim().length > 0);
		}
		if (bypassCache) {
			options.bypassCache = true;
		}
		return options;
	}

	/** アカウントの一覧・切り替え・登録を持つところ（手元のウィンドウは shared process、SSH のウィンドウは接続先）。 */
	private get claudeChannel() {
		const remoteConnection = this.remoteAgentService.getConnection();
		return remoteConnection
			? remoteConnection.getChannel(PARADIS_CLAUDE_ACCOUNTS_CHANNEL)
			: this.sharedProcessService.getChannel(PARADIS_CLAUDE_ACCOUNTS_CHANNEL);
	}

	/**
	 * Claude の取得結果・登録・切り替えで状態が変わったとき（同じところに聞いているどのウィンドウの操作でも）に
	 * 発火する。切り替えに対応しない接続先は発火しない（聞かれたときにだけ取るため）。
	 */
	get onDidChangeClaudeState(): Event<void> {
		return this.claudeChannel.listen<void>('onDidChangeState');
	}

	/**
	 * Claude の状態。`refresh` は手動の更新で、180 秒より古い結果だけ取り直す。取り直した結果は
	 * {@link onDidChangeClaudeState} の後にもう一度聞くと届く。
	 *
	 * @param localOnly SSH のウィンドウでも手元の shared process に聞く
	 * @param hostLoginOnly SSH のウィンドウで、接続先のいまのログインだけを読み取り専用で返す（スマホ用）
	 */
	async getClaudeState(refresh = false, passive = false, localOnly = false, hostLoginOnly = false): Promise<IParadisClaudeAccountsState> {
		const remoteConnection = localOnly ? null : this.remoteAgentService.getConnection();
		if (remoteConnection && hostLoginOnly) {
			return this.getClaudeHostState(remoteConnection, { refresh, passive });
		}
		const channel = localOnly ? this.sharedProcessService.getChannel(PARADIS_CLAUDE_ACCOUNTS_CHANNEL) : this.claudeChannel;
		let state: IParadisClaudeAccountsState;
		try {
			state = await channel.call<IParadisClaudeAccountsState>('getState', [{ refresh, passive }]);
		} catch (error) {
			return { claude: { accounts: [], sourceError: (error as Error).message }, switching: false };
		}
		if (remoteConnection && state.unsupportedOnHost) {
			// 接続先が切り替えに対応していない。いまのログインだけを読み取り専用で出す
			return this.getClaudeHostState(remoteConnection, { refresh, passive });
		}
		return state;
	}

	/** SSH の接続先の Claude のログインの状態（読み取り専用）。 */
	private async getClaudeHostState(remoteConnection: IRemoteAgentConnection, request: IParadisClaudeStateRequest): Promise<IParadisClaudeAccountsState> {
		// 拡張機能のラベルの整形が届く前は authority のままなので、そのときは読みやすく整えたものを使う。
		const rawLabel = this.labelService.getHostLabel(Schemas.vscodeRemote, remoteConnection.remoteAuthority);
		const host = paradisResolveMobileWindowHost(remoteConnection.remoteAuthority, rawLabel === remoteConnection.remoteAuthority ? undefined : rawLabel);
		const remoteHost = { label: host.label };
		try {
			const state = await remoteConnection.getChannel(PARADIS_LIMITS_MONITOR_CHANNEL).call<IParadisClaudeAccountsState>(PARADIS_CLAUDE_HOST_STATE_COMMAND, [request]);
			return paradisClaudeHostAccountsState(state, remoteHost);
		} catch (error) {
			const message = (error as Error | undefined)?.message ?? '';
			const sourceError = message.includes(PARADIS_CLAUDE_HOST_STATE_COMMAND)
				? localize('paradis.limitsMonitor.claudeHostUnsupported', "接続先のサーバーがこの表示に対応していないため、接続先の Claude の使用量を表示できません。")
				: localize('paradis.limitsMonitor.claudeHostFailed', "接続先の Claude の使用量を取得できませんでした（{0}）", message);
			return paradisClaudeHostAccountsState(undefined, remoteHost, sourceError);
		}
	}

	/** Codex 側のスナップショットに Claude の状態を差し込む。 */
	static mergeClaudeState(snapshot: IParadisLimitsSnapshot, claudeState: IParadisClaudeAccountsState): IParadisLimitsSnapshot {
		// 「N 秒前に更新」は最後に問い合わせた時刻（Codex の取得時刻）のままにする。Claude は
		// アカウントごとに数分〜十数分おきに取るので、古さはカードごとの fetchedAt で見せる
		// （最も古い値に合わせると、手動で更新しても「25 分前」のまま動かなかった）。
		return { ...snapshot, claude: claudeState.claude };
	}

	/**
	 * @param claudeFromLocal Claude を、SSH のウィンドウでも手元の shared process から取る。スマホの
	 * ホームやウィジェットのように、ウィンドウ（接続先）を選ばずに届いた問い合わせに使う（どのウィンドウが
	 * 答えるかで Claude のアカウントが入れ替わらないように）。Codex の分は従来どおりこのウィンドウの接続先。
	 * @param claudeHostLoginOnly SSH のウィンドウの Claude を、接続先のいまのログインだけにする（スマホは
	 * 接続先のログインを表示するだけで、登録したほかのアカウントや切り替えは扱わない）。
	 */
	async getSnapshot(bypassCache = false, claudeFromLocal = false, claudeHostLoginOnly = false): Promise<IParadisLimitsSnapshot> {
		const [snapshot, claudeState] = await Promise.all([
			this.channel.call<IParadisLimitsSnapshot>('getSnapshot', [this.fetchOptions(bypassCache)]),
			this.getClaudeState(bypassCache, false, claudeFromLocal, claudeHostLoginOnly),
		]);
		return ParadisLimitsMonitorClient.mergeClaudeState(snapshot, claudeState);
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
		if ((remoteConnection !== null) !== expectedViaRemote) {
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

	/** Claude アカウントの追加（`managedId` を渡すとそのアカウントの再ログイン）を始める。 */
	startClaudeLogin(managedId?: string): Promise<IParadisLimitsSetupHandle> {
		return this.claudeChannel.call<IParadisLimitsSetupHandle>('startLogin', [managedId]);
	}

	getClaudeSetupState(sessionId: string): Promise<IParadisLimitsSetupState> {
		return this.claudeChannel.call<IParadisLimitsSetupState>('getSetupState', [sessionId]);
	}

	cancelClaudeSetup(sessionId: string): Promise<void> {
		return this.claudeChannel.call<void>('cancelSetup', [sessionId]);
	}

	/** いまの Claude のログインを Para Code に登録する。 */
	registerLiveClaudeAccount(): Promise<IParadisClaudeRegisterResult> {
		return this.claudeChannel.call<IParadisClaudeRegisterResult>('registerLiveAccount', []);
	}

	/** Claude のログイン（SSH のウィンドウでは接続先のもの）を、登録したアカウントに切り替える（全ウィンドウ共通）。 */
	switchClaudeAccount(managedId: string): Promise<IParadisClaudeSwitchResult> {
		return this.claudeChannel.call<IParadisClaudeSwitchResult>('switchAccount', [managedId]);
	}

	/** Claude アカウントの登録を消す（いまのログインはそのまま）。 */
	removeClaudeAccount(managedId: string): Promise<boolean> {
		return this.claudeChannel.call<boolean>('removeAccount', [managedId]);
	}

	getSetupState(sessionId: string): Promise<IParadisLimitsSetupState> {
		return this.channel.call<IParadisLimitsSetupState>('getSetupState', [sessionId]);
	}

	cancelSetup(sessionId: string): Promise<void> {
		return this.channel.call<void>('cancelSetup', [sessionId]);
	}
}
