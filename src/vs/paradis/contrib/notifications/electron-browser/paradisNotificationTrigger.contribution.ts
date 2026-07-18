/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ペイン単位のエージェント実行状態 (review=完了 / permission=要対応) への遷移を検知し、
// 通知サウンド + OS通知 + Aivis読み上げをトリガーする。購読元は workspaceSwitch の
// ParadisAgentStatusPoller (paradisAgentStatus.contribution.ts) と同じ shared process の
// listPaneStatuses だが、あちらはスコープ単位に集約するのに対しこちらはペイン単位の遷移検知が
// 必要なため、別クラスとして実装している（互いに独立してポーリングする）。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { disposableTimeout, IntervalTimer } from '../../../../base/common/async.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentPaneStatus, PARADIS_AGENT_BROWSER_CHANNEL, ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { IParadisAivisPlaceholders, IParadisNotifyAudioRequest, PARADIS_NOTIFICATIONS_CHANNEL, renderParadisAivisTemplate } from '../common/paradisNotifications.js';

const POLL_INTERVAL = 2000;

// permission / question は Codex の AutoMode や Claude の hook 自動応答で「要求→即自動解決」される
// ことがあり、遷移した瞬間に鳴らすと人間の対応が不要なケースでも通知してしまう。遷移後この時間
// 待って、まだ同じステータスに留まっている場合のみ発火する (自動処理は数秒以内に working へ戻る)。
// 代償として正当な許可要求・質問の通知はこの時間だけ遅れる。review (作業完了) は即時のまま。
const ACTION_CONFIRM_DELAY = 5000;

type NotifyStatus = 'review' | 'permission' | 'question';

/** {{event}} の読み上げ用ラベル（日本語）。 */
const EVENT_LABELS: Readonly<Record<NotifyStatus, string>> = Object.freeze({
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
 * ペイン単位の 'review' / 'permission' 遷移を検知して通知をトリガーする workbench contribution。
 */
class ParadisNotificationTrigger extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisNotificationTrigger';

	/** token → 直近確認したステータス（遷移検知用。エントリが消えた=idleに戻ったとみなす）。 */
	private readonly _previousStatus = new Map<string, ParadisAgentStatus>();

	/** token → permission/question 遷移の発火待ちタイマー (ACTION_CONFIRM_DELAY 参照)。 */
	private readonly _pendingActionTimers = this._register(new DisposableMap<string>());

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
	) {
		super();

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

		const timer = this._register(new IntervalTimer());
		timer.cancelAndSet(() => this._poll(), POLL_INTERVAL);
		this._poll();
	}

	private async _poll(): Promise<void> {
		let statuses: IParadisAgentPaneStatus[];
		try {
			statuses = await this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call<IParadisAgentPaneStatus[]>('listPaneStatuses');
		} catch (error) {
			this.logService.trace('[ParadisNotifications] poll failed', String(error));
			return; // shared process 未起動 (起動直後) は静かにスキップ
		}

		const seenTokens = new Set<string>();
		for (const paneStatus of statuses) {
			seenTokens.add(paneStatus.token);
			const previous = this._previousStatus.get(paneStatus.token);
			this._previousStatus.set(paneStatus.token, paneStatus.status);

			if (previous === paneStatus.status) {
				continue; // 遷移なし
			}
			// ステータスが変わったら、前回の permission/question 遷移の発火待ちは破棄する
			// (自動応答等で working へ戻った場合はここで通知がキャンセルされる)。
			this._pendingActionTimers.deleteAndDispose(paneStatus.token);
			if (paneStatus.status !== 'review' && paneStatus.status !== 'permission' && paneStatus.status !== 'question') {
				continue; // working への遷移は通知対象外
			}
			// 質問(AskUserQuestion)への遷移も「人間の対応が必要」= 許可要求と同じPC通知
			// (音 + OS通知 + Aivis) を出す。モバイルの質問通知は transcript ミラー
			// (paradisMobileAgentChat) が質問本文付きで別経路発火するため、ここはPC向けのみ。
			// status は {{event}} で区別できるよう question のまま渡し、テンプレート選択や
			// 優先度の分岐箇所で permission と同扱いにする。
			if (paneStatus.status === 'review') {
				void this._handleTransition(paneStatus.token, paneStatus.status).catch(error => {
					this.logService.warn('[ParadisNotifications] failed to handle status transition', error);
				});
				continue;
			}
			// permission / question は即発火せず ACTION_CONFIRM_DELAY 待ち、その間の
			// ポーリングでステータスが維持されている場合のみ発火する (自動処理の抑制)。
			const token = paneStatus.token;
			const status = paneStatus.status;
			this._pendingActionTimers.set(token, disposableTimeout(() => {
				this._pendingActionTimers.deleteAndDispose(token);
				if (this._previousStatus.get(token) !== status) {
					return; // 待機中に自動応答・終了等で解消済み
				}
				void this._handleTransition(token, status).catch(error => {
					this.logService.warn('[ParadisNotifications] failed to handle status transition', error);
				});
			}, ACTION_CONFIRM_DELAY));
		}

		// トークンが listPaneStatuses から消えた（idleに戻った/ペイン終了）場合は履歴を捨てる。
		// これにより次回 review/permission に入った際に再度遷移として検知される。
		for (const token of [...this._previousStatus.keys()]) {
			if (!seenTokens.has(token)) {
				this._previousStatus.delete(token);
				this._pendingActionTimers.deleteAndDispose(token);
			}
		}
	}

	private async _handleTransition(token: string, status: NotifyStatus): Promise<void> {
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		if (instanceId === undefined) {
			return; // ペインが別ウィンドウ or 終了済み
		}

		// 設定「Para Code を見ている間も通知する」が有効なら、フォーカス由来の抑制を行わない
		const notifyWhileFocused = this.settingsService.getNotifyWhileFocused();
		const isVisibleAndFocused = !document.hidden && this.hostService.hasFocus;
		const stateKey = this.terminalScopeService.getStateKeyForInstance(instanceId);

		if (stateKey === undefined) {
			// スコープ外のターミナル (Workspacesビュー未登録フォルダ / エディタ領域ターミナル)。
			// アイコン変化はスコープ概念に紐づくため対象外だが、音 + OS通知 + Aivis は
			// ワークスペースフォルダ名をプレースホルダにして発火させる。
			// 抑制条件は「このウィンドウが可視かつフォーカス中」のみ。
			if (isVisibleAndFocused && !notifyWhileFocused) {
				return;
			}
			await this._notify(undefined, status, await this._resolveFallbackPlaceholders(status, instanceId));
			return;
		}

		// 抑制ルール: 対象スコープが見えていて (アクティブ) かつウィンドウがフォーカスされている場合は鳴らさない。
		// document.hidden (最小化・別スペース) の場合は常に鳴らす。
		const isActiveScope = stateKey === this.workspaceSwitchService.activeStateKey;
		if (isActiveScope && isVisibleAndFocused && !notifyWhileFocused) {
			return;
		}

		await this._notify(stateKey, status, await this._resolvePlaceholders(stateKey, status, instanceId));
	}

	/** 音 + OS通知 + Aivis を発火する (stateKey === undefined はスコープ外フォールバック)。 */
	private async _notify(stateKey: string | undefined, status: NotifyStatus, placeholders: IParadisAivisPlaceholders): Promise<void> {
		// question は「人間の対応が必要」= permission と同じ扱い ({{event}} だけ区別)。
		const needsAction = status === 'permission' || status === 'question';

		// OS通知は従来どおり即時。通知音と Aivis は shared process の AudioScheduler で調停する
		// （通知音 → 完了後に Aivis の順。重複通知音は捨て、Aivis は FIFO で失わない）。
		const osEnabled = this.settingsService.getOsNotificationsEnabled()
			&& (needsAction ? this.settingsService.getOsNotifyOnPermission() : this.settingsService.getOsNotifyOnReview());
		if (osEnabled) {
			this._showOsNotification(stateKey, status, placeholders);
		}

		const muted = this.settingsService.getSoundsMuted();
		const request: { ringtone?: IParadisNotifyAudioRequest['ringtone']; aivis?: IParadisNotifyAudioRequest['aivis']; priority: IParadisNotifyAudioRequest['priority'] } = {
			priority: needsAction ? 'high' : 'normal',
		};
		if (!muted) {
			request.ringtone = { id: this.settingsService.getSelectedRingtoneId(), volume: this.settingsService.getVolume() };
		}

		const aivis = this.settingsService.getAivisSettings();
		if (aivis.enabled && aivis.apiKey && aivis.modelUuid) {
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

		if (!request.ringtone && !request.aivis) {
			return; // ミュート かつ Aivis 無効なら何もしない
		}

		try {
			await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('notifyAudio', [request]);
		} catch (error) {
			this.logService.warn('[ParadisNotifications] notifyAudio failed', error);
		}
	}

	/**
	 * stateKey (リポジトリID or worktreeキー) からAivisテンプレート用のプレースホルダを組み立てる。
	 * どのキーも空文字のまま読み上げに渡らないよう、解決できない値は段階的にフォールバックする
	 * (space → ワークスペースフォルダ名 → 既定語 / branch → space / worktree → branch)。
	 */
	private async _resolvePlaceholders(stateKey: string, status: NotifyStatus, instanceId: number): Promise<IParadisAivisPlaceholders> {
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
	private async _resolveFallbackPlaceholders(status: NotifyStatus, instanceId: number): Promise<IParadisAivisPlaceholders> {
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
	private async _resolveBranch(root: URI): Promise<string | undefined> {
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
				const gitdirUri = gitdir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(gitdir)
					? URI.file(gitdir)
					: joinPath(root, gitdir);
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

	private _showOsNotification(stateKey: string | undefined, status: NotifyStatus, placeholders: IParadisAivisPlaceholders): void {
		const title = status === 'review' ? STR_TITLE_REVIEW : STR_TITLE_PERMISSION;
		const body = placeholders.worktree && placeholders.worktree !== placeholders.space
			? `${placeholders.space ?? ''} (${placeholders.worktree})`
			: placeholders.space;

		this.hostService.showToast({ title, body, silent: true }, CancellationToken.None).then(result => {
			// スコープ外フォールバック (stateKey === undefined) はクリックでの切り替え先が無い
			if (result.clicked && stateKey !== undefined) {
				void this._switchToScope(stateKey);
			}
		}, () => { /* 通知の権限が無い等は無視 */ });
	}

	private async _switchToScope(stateKey: string): Promise<void> {
		for (const repository of this.workspaceSwitchService.repositories) {
			if (repository.id === stateKey) {
				await this.workspaceSwitchService.switchRepository(repository.id);
				return;
			}
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (paradisWorktreeStateKey(worktree.uri) === stateKey) {
					await this.workspaceSwitchService.switchToWorktree(worktree);
					return;
				}
			}
		}
	}
}

registerWorkbenchContribution2(ParadisNotificationTrigger.ID, ParadisNotificationTrigger, WorkbenchPhase.AfterRestored);
