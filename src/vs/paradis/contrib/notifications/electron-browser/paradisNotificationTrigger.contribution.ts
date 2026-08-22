/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ペイン単位のエージェント実行状態 (review=完了 / permission=要対応) への遷移を検知し、
// 通知サウンド + OS通知 + Aivis読み上げをトリガーする。workspaceSwitch の状態表示と同じ
// renderer-local snapshot producerを購読し、同じ取得済みsnapshotからペイン単位の遷移を検知する。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { paradisResolveExternalPath } from '../../../common/paradisPathUri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { IParadisAivisPlaceholders, IParadisNotifyAudioRequest, PARADIS_NOTIFICATIONS_CHANNEL, renderParadisAivisTemplate } from '../common/paradisNotifications.js';
import { paradisIsWorkbenchWindowFocused } from '../../workspaceSwitch/browser/paradisWindowFocus.js';
import { ParadisAgentStatusNotificationConsumer, ParadisAgentStatusNotificationTracker, ParadisAgentNotifyStatus } from './paradisAgentStatusNotificationTracker.js';

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
 * ペイン単位の 'review' / 'permission' 遷移を検知して通知をトリガーする workbench contribution。
 */
export class ParadisNotificationTrigger extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisNotificationTrigger';

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

		const tracker = this._register(new ParadisAgentStatusNotificationTracker((token, status) => {
			void this._handleTransition(token, status).catch(error => {
				this.logService.warn('[ParadisNotifications] failed to handle status transition', error);
			});
		}));
		this._register(new ParadisAgentStatusNotificationConsumer(snapshotService, tracker, error => {
			this.logService.trace('[ParadisNotifications] poll failed', String(error));
		}));
	}

	private async _handleTransition(token: string, status: ParadisAgentNotifyStatus): Promise<void> {
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		if (instanceId === undefined) {
			return; // ペインが別ウィンドウ or 終了済み
		}

		// 設定「Para Code を見ている間も通知する」が有効なら、フォーカス由来の抑制を行わない
		const notifyWhileFocused = this.settingsService.getNotifyWhileFocused();
		const isVisibleAndFocused = paradisIsWorkbenchWindowFocused();
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
	private async _notify(stateKey: string | undefined, status: ParadisAgentNotifyStatus, placeholders: IParadisAivisPlaceholders): Promise<void> {
		// おやすみモード中は音・OS通知・Aivis発話を一括抑制する。
		if (this.settingsService.getDoNotDisturb().enabled) {
			return;
		}

		// question は「人間の対応が必要」= permission と同じ扱い ({{event}} だけ区別)。
		const needsAction = status === 'permission' || status === 'question';

		// OS通知は従来どおり即時。通知音と Aivis は shared process の AudioScheduler で調停する
		// （通知音 → 完了後に Aivis の順。重複通知音は捨て、Aivis は FIFO。ただし待機キューには
		// 上限があり、超過した発話は捨てられる）。
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

	private _showOsNotification(stateKey: string | undefined, status: ParadisAgentNotifyStatus, placeholders: IParadisAivisPlaceholders): void {
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
