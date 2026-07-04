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
import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentPaneStatus, PARADIS_AGENT_BROWSER_CHANNEL, ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { IParadisAivisPlaceholders, IParadisNotifyAudioRequest, PARADIS_NOTIFICATIONS_CHANNEL, renderParadisAivisTemplate } from '../common/paradisNotifications.js';

const POLL_INTERVAL = 2000;

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

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
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

		// Aivis設定（APIキー等）が変更・保存されたら一時停止を解除する。onDidChange は音量等の変更でも
		// 発火するが、resume は冪等なので毎回呼んで問題ない。
		this._register(this.settingsService.onDidChange(() => {
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
			if (paneStatus.status !== 'review' && paneStatus.status !== 'permission') {
				continue; // working / working への遷移は通知対象外
			}
			void this._handleTransition(paneStatus.token, paneStatus.status).catch(error => {
				this.logService.warn('[ParadisNotifications] failed to handle status transition', error);
			});
		}

		// トークンが listPaneStatuses から消えた（idleに戻った/ペイン終了）場合は履歴を捨てる。
		// これにより次回 review/permission に入った際に再度遷移として検知される。
		for (const token of [...this._previousStatus.keys()]) {
			if (!seenTokens.has(token)) {
				this._previousStatus.delete(token);
			}
		}
	}

	private async _handleTransition(token: string, status: 'review' | 'permission'): Promise<void> {
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
			await this._notify(undefined, status, this._resolveFallbackPlaceholders(status));
			return;
		}

		// 抑制ルール: 対象スコープが見えていて (アクティブ) かつウィンドウがフォーカスされている場合は鳴らさない。
		// document.hidden (最小化・別スペース) の場合は常に鳴らす。
		const isActiveScope = stateKey === this.workspaceSwitchService.activeStateKey;
		if (isActiveScope && isVisibleAndFocused && !notifyWhileFocused) {
			return;
		}

		await this._notify(stateKey, status, this._resolvePlaceholders(stateKey, status));
	}

	/** 音 + OS通知 + Aivis を発火する (stateKey === undefined はスコープ外フォールバック)。 */
	private async _notify(stateKey: string | undefined, status: 'review' | 'permission', placeholders: IParadisAivisPlaceholders): Promise<void> {
		// OS通知は従来どおり即時。通知音と Aivis は shared process の AudioScheduler で調停する
		// （通知音 → 完了後に Aivis の順。重複通知音は捨て、Aivis は FIFO で失わない）。
		const osEnabled = this.settingsService.getOsNotificationsEnabled()
			&& (status === 'permission' ? this.settingsService.getOsNotifyOnPermission() : this.settingsService.getOsNotifyOnReview());
		if (osEnabled) {
			this._showOsNotification(stateKey, status, placeholders);
		}

		const muted = this.settingsService.getSoundsMuted();
		const request: { ringtone?: IParadisNotifyAudioRequest['ringtone']; aivis?: IParadisNotifyAudioRequest['aivis']; priority: IParadisNotifyAudioRequest['priority'] } = {
			priority: status === 'permission' ? 'high' : 'normal',
		};
		if (!muted) {
			request.ringtone = { id: this.settingsService.getSelectedRingtoneId(), volume: this.settingsService.getVolume() };
		}

		const aivis = this.settingsService.getAivisSettings();
		if (aivis.enabled && aivis.apiKey && aivis.modelUuid) {
			const template = status === 'permission' ? aivis.formatPermission : aivis.format;
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

	/** stateKey (リポジトリID or worktreeキー) からAivisテンプレート用のプレースホルダを組み立てる。 */
	private _resolvePlaceholders(stateKey: string, status: 'review' | 'permission'): IParadisAivisPlaceholders {
		const event = status === 'permission' ? 'PermissionRequest' : 'Stop';

		for (const repository of this.workspaceSwitchService.repositories) {
			if (repository.id === stateKey) {
				return { workspace: repository.name, project: repository.name, event };
			}
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (paradisWorktreeStateKey(worktree.uri) === stateKey) {
					return { workspace: repository.name, project: repository.name, worktree: worktree.name, branch: worktree.branch, event };
				}
			}
		}
		return { event };
	}

	/** スコープ外ターミナル用フォールバック: ワークスペースフォルダ名をプレースホルダにする。 */
	private _resolveFallbackPlaceholders(status: 'review' | 'permission'): IParadisAivisPlaceholders {
		const event = status === 'permission' ? 'PermissionRequest' : 'Stop';
		const folder = this.contextService.getWorkspace().folders[0];
		if (folder) {
			return { workspace: folder.name, project: folder.name, event };
		}
		return { event };
	}

	private _showOsNotification(stateKey: string | undefined, status: 'review' | 'permission', placeholders: IParadisAivisPlaceholders): void {
		const title = status === 'permission' ? STR_TITLE_PERMISSION : STR_TITLE_REVIEW;
		const body = placeholders.worktree ? `${placeholders.workspace ?? ''} (${placeholders.worktree})` : placeholders.workspace;

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
