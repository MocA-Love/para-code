/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ペイン単位のエージェント実行状態 (review=完了 / permission=要対応) への遷移を検知し、
// 通知サウンド + OS通知 + Aivis読み上げをトリガーする。workspaceSwitch の状態表示と同じ
// renderer-local snapshot producerを購読し、同じ取得済みsnapshotからペイン単位の遷移を検知する。

import { raceTimeout, timeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { paradisResolveExternalPath } from '../../../common/paradisPathUri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { ILifecycleService, StartupKind } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisNotificationsSettingsService, paradisWaitForApiKeys } from '../browser/paradisNotificationsSettings.js';
import { IParadisAivisPlaceholders, IParadisNotifyAudioRequest, PARADIS_NOTIFICATIONS_CHANNEL, renderParadisAivisTemplate } from '../common/paradisNotifications.js';
import { paradisIsWorkbenchWindowFocused } from '../../workspaceSwitch/browser/paradisWindowFocus.js';
import { paradisRevealNotifiedPane } from './paradisNotificationReveal.js';
import { IParadisAgentPaneInsight, IParadisAgentPaneInsightSource } from '../../agentInsights/common/paradisAgentInsights.js';
import { PARADIS_MOBILE_RELAY_CHANNEL } from '../../mobileRelay/common/paradisMobileRelay.js';
// 台帳の窓口（registerSingleton）はここで確実に読み込む。受信箱の UI が無効でも記録は続ける。
import '../../notificationInbox/electron-browser/paradisNotificationInboxService.js';
import { IParadisNotificationInboxService, PARADIS_NOTIFICATION_INCLUDE_MESSAGE_SETTING, ParadisInboxDelivery, paradisInboxHasRecorded, paradisInboxPaneKey, paradisNotificationBody, paradisNotificationPreview, paradisPickNotificationMessage } from '../../notificationInbox/common/paradisNotificationInbox.js';
import { ParadisAgentStatusNotificationConsumer, ParadisAgentStatusNotificationTracker, ParadisAgentNotifyStatus } from './paradisAgentStatusNotificationTracker.js';

/** 読み上げの前に API キーの読み込みを待つ上限。 */
const API_KEY_WAIT_TIMEOUT_MS = 3000;

/** {{event}} の読み上げ用ラベル（日本語）。 */
const EVENT_LABELS: Readonly<Record<ParadisAgentNotifyStatus, string>> = Object.freeze({
	// allow-any-unicode-next-line
	review: '作業完了',
	// allow-any-unicode-next-line
	permission: '許可要求',
	// allow-any-unicode-next-line
	question: '質問',
});

// allow-any-unicode-next-line
const STR_UNKNOWN_SPACE = '不明なスペース';

// allow-any-unicode-next-line
const STR_TITLE_REVIEW = 'エージェントの作業が完了しました';
// allow-any-unicode-next-line
const STR_TITLE_PERMISSION = 'エージェントが対応を求めています';

/**
 * 完了の通知に載せる最後の発言が、完了の少し前のものか。これより古い発言しか取れないときは、
 * 会話ログの読み取りがまだ追いついていない見込みが高いので、少し待って取り直す。
 */
const FRESH_MESSAGE_WINDOW_MS = 60_000;
/** 発言の取得を待つ上限（取り直しを含む全体）。過ぎたら本文なしで通知する。 */
const MESSAGE_TIMEOUT_MS = 1_500;
const MESSAGE_RETRY_DELAY_MS = 700;
const MESSAGE_RETRY_COUNT = 2;
/** 遷移したペインを引けないとき、ターミナルの復元を待つ上限。 */
const TERMINAL_RESTORE_TIMEOUT_MS = 10_000;
/**
 * ブランチ名（`.git/HEAD`）の読み取りを待つ上限。音・通知は読み取りの後に出るので、WSL の UNC パスや
 * 切れかけの接続先で読み取りが詰まっても、通知ごと止めない。
 */
const BRANCH_READ_TIMEOUT_MS = 500;
/** 再読み込みの前から続いている状態を知らせ済みか、台帳で確かめるのを待つ上限。 */
const LEDGER_READ_TIMEOUT_MS = 1_000;

/**
 * ペイン単位の 'review' / 'permission' 遷移を検知して通知をトリガーする workbench contribution。
 */
export class ParadisNotificationTrigger extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisNotificationTrigger';

	/** 破棄されたら、発言の取り直しの待ちを打ち切る。 */
	private readonly _lifetime = new CancellationTokenSource();
	/** 最後の発言の読み取り口（モバイル中継のチャネル。agentInsights と同じ型で引く）。 */
	private readonly _insightSource: IParadisAgentPaneInsightSource;

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
		@IFileService private readonly fileService: IFileService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IHostService private readonly hostService: IHostService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IParadisAgentStatusSnapshotService snapshotService: IParadisAgentStatusSnapshotService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IParadisNotificationInboxService private readonly inboxService: IParadisNotificationInboxService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		this._register(toDisposable(() => this._lifetime.dispose(true)));
		this._insightSource = ProxyChannel.toService<IParadisAgentPaneInsightSource>(this.sharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL));

		// fatal エラーで Aivis が一時停止された時、shared process からのイベントを受けて可視通知を出す。
		this._register(this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL)
			.listen<string>('onAivisPaused')(reason => {
				this.notificationService.notify({ severity: Severity.Warning, message: reason });
			}));

		// Aivis設定（APIキー等）が変更・保存されたら一時停止を解除する。resume は冪等なので
		// Aivis関連の変更であれば毎回呼んで問題ない（通知サウンド関連の変更では発火しない）。
		this._register(this.settingsService.onDidChange(scope => {
			if (scope !== 'aivis') {
				return;
			}
			void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('resumeAivis').catch(() => { /* shared process 未起動時は無視 */ });
		}));

		// 再読み込みの前から続いている状態は、前のウィンドウが通知したかもしれない。読み込み直した時刻を渡し、
		// そういう状態は台帳で確かめてから鳴らす。
		const reloadedAt = lifecycleService.startupKind === StartupKind.ReloadedWindow ? Date.now() - performance.now() : undefined;
		const tracker = this._register(new ParadisAgentStatusNotificationTracker((token, status, since, carriedOverFrom) => {
			void this._handleTransition(token, status, since, carriedOverFrom).catch(error => {
				this.logService.warn('[ParadisNotifications] failed to handle status transition', error);
			});
		}, undefined, reloadedAt));
		this._register(new ParadisAgentStatusNotificationConsumer(snapshotService, tracker, error => {
			this.logService.trace('[ParadisNotifications] poll failed', String(error));
		}));
	}

	private async _handleTransition(token: string, status: ParadisAgentNotifyStatus, since: number | undefined, carriedOverFrom: number | undefined): Promise<void> {
		if (carriedOverFrom !== undefined) {
			// 再読み込みの前から続いている状態。前のウィンドウが台帳へ書き済みなら、もう知らせてある（鳴らさなかった
			// ものも台帳には書く）。書かれていなければ、確認の5秒や発言の取得を待つ間に再読み込みされたので、ここで知らせる。
			// shared process が詰まっても通知を止めない。時間内に台帳を取れなければ、書かれていないものとして知らせる。
			const snapshot = await raceTimeout(this.inboxService.getLatestSnapshot(), LEDGER_READ_TIMEOUT_MS);
			if (this._lifetime.token.isCancellationRequested || (snapshot !== undefined && paradisInboxHasRecorded(snapshot.entries, paradisInboxPaneKey(token), status, carriedOverFrom))) {
				return;
			}
		}
		let instanceId = this.paneTokenService.getInstanceForToken(token);
		if (instanceId === undefined) {
			// 起動・再読み込みの直後は、ターミナルの復元が済むまでペインを引けない。復元を待って引き直す。
			await raceTimeout(this.terminalService.whenConnected, TERMINAL_RESTORE_TIMEOUT_MS);
			if (this._lifetime.token.isCancellationRequested) {
				return;
			}
			instanceId = this.paneTokenService.getInstanceForToken(token);
		}
		if (instanceId === undefined) {
			return; // ペインが別ウィンドウ or 終了済み
		}
		const transitionAt = Date.now();

		// 設定「Para Code を見ている間も通知する」が有効なら、フォーカス由来の抑制を行わない
		const notifyWhileFocused = this.settingsService.getNotifyWhileFocused();
		const isVisibleAndFocused = this._isWindowFocused();
		const stateKey = this.terminalScopeService.getStateKeyForInstance(instanceId);

		// 抑制ルール: 対象スコープが見えていて (アクティブ) かつウィンドウがフォーカスされている場合は鳴らさない。
		// スコープ外のターミナル (Workspacesビュー未登録フォルダ / エディタ領域ターミナル) は
		// 「このウィンドウが可視かつフォーカス中」だけで判定する。
		// document.hidden (最小化・別スペース) の場合は常に鳴らす。
		const isActiveScope = stateKey === undefined || stateKey === this.workspaceSwitchService.activeStateKey;
		const suppressedByFocus = isActiveScope && isVisibleAndFocused && !notifyWhileFocused;
		// おやすみモード中は音・OS通知・Aivis発話を一括抑制する（台帳には残す。数えるが鳴らさない）。
		const doNotDisturb = !suppressedByFocus && this.settingsService.getDoNotDisturb().enabled;
		const audible = !suppressedByFocus && !doNotDisturb;

		// question は「人間の対応が必要」= permission と同じ扱い ({{event}} だけ区別)。
		const needsAction = status === 'permission' || status === 'question';
		const osEnabled = audible && this.settingsService.getOsNotificationsEnabled()
			&& (needsAction ? this.settingsService.getOsNotifyOnPermission() : this.settingsService.getOsNotifyOnReview());
		const includeMessage = this.configurationService.getValue<boolean>(PARADIS_NOTIFICATION_INCLUDE_MESSAGE_SETTING) !== false;

		// スコープ外のターミナルはアイコン変化の対象外（スコープ概念に紐づくため）だが、音 + OS通知 + Aivis は
		// ワークスペースフォルダ名をプレースホルダにして発火させる。
		const placeholders = stateKey === undefined
			? await this._resolveFallbackPlaceholders(status, instanceId)
			: await this._resolvePlaceholders(stateKey, status, instanceId);

		// 音と読み上げは発言を待たずにすぐ出す（発言は OS 通知の本文と受信箱にしか使わない）。
		if (audible) {
			void this._playAudio(status, placeholders);
		} else if (doNotDisturb) {
			// おやすみモード中は PC では鳴らさず、読み上げをモバイルへだけ流す（Q310 A。`aivis --mute` 中の Q209 B と同じ）。
			// 聞いているモバイルが無ければ shared process が合成しない
			void this._playAudio(status, placeholders, true);
		}

		// 発言は OS 通知に載せるときだけ取り直しまで待つ。それ以外は受信箱用に1回だけ引く。
		const message = await this._resolveMessage(token, status, since ?? transitionAt - FRESH_MESSAGE_WINDOW_MS, osEnabled && includeMessage);
		if (this._lifetime.token.isCancellationRequested) {
			return; // 待っている間にウィンドウが閉じた
		}

		const delivery: ParadisInboxDelivery = suppressedByFocus ? 'focused' : doNotDisturb ? 'doNotDisturb' : osEnabled ? 'notified' : 'silent';
		// 見ていたスペースで起きて鳴らさなかったものは既読で残す。
		this._record(token, instanceId, stateKey, status, placeholders, message, delivery);
		if (osEnabled) {
			this._showOsNotification(stateKey, instanceId, status, placeholders, includeMessage ? message : undefined);
		}
	}

	/** このウィンドウが見えていてフォーカスされているか（テストで差し替える）。 */
	protected _isWindowFocused(): boolean {
		return paradisIsWorkbenchWindowFocused();
	}

	/**
	 * 通知に載せる内容（伏せ字済み）。完了は最後の発言、許可待ち・質問は待っている内容。
	 * モバイル中継が会話ログから読んだものを引く（モバイル連携が無効でも読める。agentInsights 参照）。
	 * shared process が詰まっても通知を止めないよう、全体で {@link MESSAGE_TIMEOUT_MS} までしか待たない。
	 */
	private async _resolveMessage(token: string, status: ParadisAgentNotifyStatus, since: number, retry: boolean): Promise<string | undefined> {
		const deadline = Date.now() + MESSAGE_TIMEOUT_MS;
		let text: string | undefined;
		for (let attempt = 0; attempt <= (retry ? MESSAGE_RETRY_COUNT : 0); attempt++) {
			if (attempt > 0) {
				if (Date.now() + MESSAGE_RETRY_DELAY_MS >= deadline) {
					break;
				}
				try {
					await timeout(MESSAGE_RETRY_DELAY_MS, this._lifetime.token);
				} catch {
					return text; // 破棄された
				}
			}
			let insights: readonly IParadisAgentPaneInsight[] | undefined;
			try {
				insights = await raceTimeout(this._insightSource.getAgentPaneInsights([token]), Math.max(0, deadline - Date.now()));
			} catch (error) {
				this.logService.trace('[ParadisNotifications] failed to read the last agent message', String(error));
				return text;
			}
			if (insights === undefined) {
				return text; // 時間切れ
			}
			const picked = paradisPickNotificationMessage(insights[0], status, since);
			text = picked.text ?? text;
			if (picked.fresh) {
				break;
			}
		}
		return text;
	}

	/** 通知の台帳へ1件書く（鳴らさなかったものも書く）。 */
	private _record(token: string, instanceId: number, stateKey: string | undefined, status: ParadisAgentNotifyStatus, placeholders: IParadisAivisPlaceholders, message: string | undefined, delivery: ParadisInboxDelivery): void {
		const space = placeholders.space || STR_UNKNOWN_SPACE;
		void this.inboxService.record({
			kind: status,
			paneKey: paradisInboxPaneKey(token),
			instanceId,
			windowId: this.nativeHostService.windowId,
			...(stateKey !== undefined ? { stateKey } : {}),
			space,
			...(placeholders.worktree && placeholders.worktree !== space ? { worktree: placeholders.worktree } : {}),
			...(placeholders.tab ? { tab: placeholders.tab } : {}),
			...(message ? { message } : {}),
			delivery,
			read: delivery === 'focused',
		});
	}

	/** 通知音 + Aivis を鳴らす。 */
	private async _playAudio(status: ParadisAgentNotifyStatus, placeholders: IParadisAivisPlaceholders, mobileOnly = false): Promise<void> {
		const needsAction = status === 'permission' || status === 'question';
		// 通知音と Aivis は shared process の AudioScheduler で調停する
		// （通知音 → 完了後に Aivis の順。重複通知音は捨て、Aivis は FIFO。ただし待機キューには
		// 上限があり、超過した発話は捨てられる）。
		const muted = this.settingsService.getSoundsMuted();
		const request: { ringtone?: IParadisNotifyAudioRequest['ringtone']; aivis?: IParadisNotifyAudioRequest['aivis']; elevenLabs?: IParadisNotifyAudioRequest['elevenLabs']; priority: IParadisNotifyAudioRequest['priority']; mobileOnly?: true } = {
			priority: needsAction ? 'high' : 'normal',
			...(mobileOnly ? { mobileOnly: true } : {}),
		};
		// モバイルへだけ流すときは着信音を付けない（PC で鳴らさない）
		if (!muted && !mobileOnly) {
			request.ringtone = { id: this.settingsService.getSelectedRingtoneId(), volume: this.settingsService.getVolume() };
		}

		const channel = this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL);
		// 起動直後は API キーを secret storage から読み終えていないことがある。そのときは着信音だけ先に
		// 送り、読み上げはキーを待ってから送る（scheduler が着信音の後に並べる）。secret storage が
		// 応答しなくても着信音が鳴らなくならないよう、待つのは読み上げだけで、上限も付ける。
		if (!this.settingsService.areApiKeysLoaded()) {
			if (request.ringtone) {
				await this._sendAudio(channel, { ringtone: request.ringtone, priority: request.priority });
				request.ringtone = undefined;
			}
			if (!(await paradisWaitForApiKeys(this.settingsService, API_KEY_WAIT_TIMEOUT_MS))) {
				this.logService.warn('[ParadisNotifications] API keys were not loaded in time; skipping the voice announcement');
				return;
			}
		}
		const aivis = this.settingsService.getAivisSettings();
		if (aivis.enabled && aivis.engine === 'elevenlabs') {
			if (aivis.elevenLabsApiKey && aivis.elevenLabsVoiceId) {
				const template = needsAction ? aivis.formatPermission : aivis.format;
				const text = renderParadisAivisTemplate(template, placeholders).trim();
				if (text) {
					request.elevenLabs = {
						apiKey: aivis.elevenLabsApiKey,
						voiceId: aivis.elevenLabsVoiceId,
						modelId: aivis.elevenLabsModelId,
						text,
						speed: aivis.elevenLabsSpeed,
						dictionaryId: aivis.elevenLabsDictionaryId || undefined,
						volume: aivis.volume,
						...aivis.elevenLabsVoiceSettings[aivis.elevenLabsVoiceId],
						cache: aivis.elevenLabsVoiceCache,
					};
				}
			}
		} else if (aivis.enabled && aivis.apiKey && aivis.modelUuid) {
			const template = needsAction ? aivis.formatPermission : aivis.format;
			const text = renderParadisAivisTemplate(template, placeholders).trim();
			if (text) {
				request.aivis = {
					apiKey: aivis.apiKey,
					modelUuid: aivis.modelUuid,
					text,
					speakingRate: aivis.speakingRate,
					userDictionaryUuid: aivis.userDictionaryUuid || undefined,
					volume: aivis.volume,
				};
			}
		}

		if (!request.ringtone && !request.aivis && !request.elevenLabs) {
			return; // ミュート かつ Aivis 無効なら何もしない（モバイルへだけ流すときは、読み上げが無ければ何もしない）
		}
		await this._sendAudio(channel, request);
	}

	private async _sendAudio(channel: ReturnType<ISharedProcessService['getChannel']>, request: IParadisNotifyAudioRequest): Promise<void> {
		try {
			await channel.call('notifyAudio', [request]);
		} catch (error) {
			this.logService.warn('[ParadisNotifications] notifyAudio failed', error);
		}
	}

	/**
	 * stateKey (リポジトリID or worktreeキー) からAivisテンプレート用のプレースホルダを組み立てる。
	 * どのキーも空文字のまま読み上げに渡らないよう、解決できない値は段階的にフォールバックする
	 * (space → ワークスペースフォルダ名 → 既定語 / branch → space / worktree → branch)。
	 */
	private async _resolvePlaceholders(stateKey: string, status: ParadisAgentNotifyStatus, instanceId: number): Promise<IParadisAivisPlaceholders> {
		const event = EVENT_LABELS[status];
		const tab = this._resolveTabName(instanceId);

		for (const repository of this.workspaceSwitchService.repositories) {
			if (repository.id === stateKey) {
				const space = repository.name || this._workspaceFolderName() || STR_UNKNOWN_SPACE;
				const branch = (await this._resolveBranch(repository.uri)) || space;
				// メインcheckoutにworktree名は無いため、常に何かが読まれるようブランチ名で代替する
				return { space, branch, worktree: branch, tab, event };
			}
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (paradisWorktreeStateKey(worktree.uri) === stateKey) {
					const space = repository.name || this._workspaceFolderName() || STR_UNKNOWN_SPACE;
					const branch = worktree.branch || (await this._resolveBranch(worktree.uri)) || space;
					return { space, branch, worktree: worktree.name || branch, tab, event };
				}
			}
		}
		// stateKey がどのスペースにも一致しない (切り替え直後でリスト未更新・削除済み等)
		return this._resolveFallbackPlaceholders(status, instanceId);
	}

	/** スコープ外ターミナル用フォールバック: ワークスペースフォルダ名をスペース名として使う。 */
	private async _resolveFallbackPlaceholders(status: ParadisAgentNotifyStatus, instanceId: number): Promise<IParadisAivisPlaceholders> {
		const event = EVENT_LABELS[status];
		const tab = this._resolveTabName(instanceId);
		const folder = this.contextService.getWorkspace().folders[0];
		const space = folder?.name || STR_UNKNOWN_SPACE;
		const branch = (folder ? await this._resolveBranch(folder.uri) : undefined) || space;
		return { space, branch, worktree: branch, tab, event };
	}

	private _workspaceFolderName(): string | undefined {
		return this.contextService.getWorkspace().folders[0]?.name || undefined;
	}

	/** 遷移したペインのターミナルタブ名 (リネーム済みならその名前)。 */
	private _resolveTabName(instanceId: number): string | undefined {
		return this.terminalService.instances.find(instance => instance.instanceId === instanceId)?.title || undefined;
	}

	/**
	 * チェックアウト中のブランチ名を `.git/HEAD` から解決する (detached HEAD は短縮SHA)。
	 * worktree のように `.git` がファイル (`gitdir: <path>`) の場合は参照先を辿る。
	 * 解決できなければ undefined (呼び出し側でフォールバック)。
	 */
	private _resolveBranch(root: URI): Promise<string | undefined> {
		return raceTimeout(this._readBranch(root), BRANCH_READ_TIMEOUT_MS);
	}

	private async _readBranch(root: URI): Promise<string | undefined> {
		try {
			const dotGit = joinPath(root, '.git');
			let headUri = joinPath(dotGit, 'HEAD');
			if ((await this.fileService.stat(dotGit)).isFile) {
				// trim: Windows の .git ファイルは CRLF のことがあり、\r がパス末尾に残ると解決に失敗する
				const gitdirContent = (await this.fileService.readFile(dotGit)).value.toString().trim();
				const gitdir = gitdirContent.match(/^gitdir:\s*(?<path>.+?)\s*$/m)?.groups?.path;
				if (!gitdir) {
					return undefined;
				}
				// 絶対パスは作業ツリーと同じ名前空間へ写す (WSL を UNC で開いている場合やリモートでは
				// git が書いた生のパスをそのまま URI.file に渡すと別の場所を指してしまう)
				const gitdirUri = paradisResolveExternalPath(root, gitdir);
				if (!gitdirUri) {
					return undefined;
				}
				headUri = joinPath(gitdirUri, 'HEAD');
			}
			const head = (await this.fileService.readFile(headUri)).value.toString().trim();
			const ref = head.match(/^ref:\s*refs\/heads\/(?<branch>.+)$/)?.groups?.branch;
			if (ref) {
				return ref;
			}
			// 40桁=SHA-1 / 64桁=SHA-256 リポジトリの detached HEAD
			return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(head) ? head.slice(0, 7) : undefined;
		} catch {
			return undefined; // gitリポジトリでない・読み取り失敗
		}
	}

	private _showOsNotification(stateKey: string | undefined, instanceId: number, status: ParadisAgentNotifyStatus, placeholders: IParadisAivisPlaceholders, message: string | undefined): void {
		const title = status === 'review' ? STR_TITLE_REVIEW : STR_TITLE_PERMISSION;
		const location = placeholders.worktree && placeholders.worktree !== placeholders.space
			? `${placeholders.space ?? ''} (${placeholders.worktree})`
			: placeholders.space;
		// 最後の発言の冒頭を載せる（伏せ字済み）。ロック画面や画面共有で見えるのを避けたい人は設定で切る。
		const includeMessage = this.configurationService.getValue<boolean>(PARADIS_NOTIFICATION_INCLUDE_MESSAGE_SETTING) !== false;
		const body = paradisNotificationBody(location, includeMessage ? paradisNotificationPreview(message) : undefined);

		this.hostService.showToast({ title, body, silent: true }, CancellationToken.None).then(result => {
			// クリックでこのウィンドウを前面に出し、スペースを切り替えて該当ペインへフォーカスする
			// (スコープ外のペインはスペース切り替えを省く)
			if (result.clicked) {
				paradisRevealNotifiedPane({
					hostService: this.hostService,
					terminalService: this.terminalService,
					workspaceSwitchService: this.workspaceSwitchService,
				}, stateKey, instanceId).catch(error => {
					this.logService.warn('[ParadisNotifications] failed to reveal the notified pane', error);
				});
			}
		}, () => { /* 通知の権限が無い等は無視 */ });
	}
}

registerWorkbenchContribution2(ParadisNotificationTrigger.ID, ParadisNotificationTrigger, WorkbenchPhase.AfterRestored);
