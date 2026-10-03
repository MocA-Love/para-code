/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 再起動（自動アップデートの適用を含む）で外れたブラウザページの共有を、同じペイン・同じページの組だけ
// 張り直す。手順は common/paradisBindingRestoreController.ts、台帳は common/paradisBindingRestoreLedger.ts。
// ここはワークベンチのサービスへつなぐだけ。
//
// 張り直す前に Para Code の通知で「どのページをどのペインへ戻すか」をまとめて尋ねる（upstream の
// 「Share this browser page with the agent?」だけでは何への同意か分からないため）。尋ねるのは、ユーザーが
// 今見ているスペースのページだけ。承認したものはユーザーが共有するときと同じ経路（bindPageToPane）を通すので、
// upstream の確認を「今後確認しない」にしていなければ、その確認も続けて出る。
// 直接共有できないページ（エージェント用の新しいタブを開いて共有する種類）は、勝手にタブを増やさないよう張り直さない。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { PersistentConnectionEventType } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { BrowserViewSharingState, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import {
	IParadisBindingRestoreDescription,
	ParadisBindingRestoreAnswer,
	ParadisBindingRestoreController,
	ParadisBindingRestoreOutcome,
	ParadisBindingRestoreReadiness,
	paradisBindingRestoreDisplayName,
} from '../common/paradisBindingRestoreController.js';
import { IParadisBrowserScopeService, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, paradisEvaluateBindingScopeEligibility } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisAgentBrowserBindingModel } from './paradisAgentBrowserBindingModel.js';

const LEDGER_STORAGE_KEY = 'paradis.agentBrowser.restoreBindings';

/** 通知に名前を並べる上限。超えた分は件数だけ書く。 */
const MAX_LISTED = 5;

export class ParadisAgentBrowserBindingRestoreContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisAgentBrowserBindingRestore';

	private readonly _controller: ParadisBindingRestoreController;
	private readonly _connectionListener = this._register(new MutableDisposable());

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IParadisAgentBrowserBindingModel private readonly bindingModel: IParadisAgentBrowserBindingModel,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisBrowserScopeService private readonly browserScopeService: IParadisBrowserScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@INotificationService private readonly notificationService: INotificationService,
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._controller = this._register(new ParadisBindingRestoreController({
			readStorage: () => this.storageService.get(LEDGER_STORAGE_KEY, StorageScope.WORKSPACE),
			writeStorage: value => value === undefined
				? this.storageService.remove(LEDGER_STORAGE_KEY, StorageScope.WORKSPACE)
				: this.storageService.store(LEDGER_STORAGE_KEY, value, StorageScope.WORKSPACE, StorageTarget.MACHINE),
			listPaneTokens: () => this.paneTokenService.listPaneTokens().map(pane => pane.token),
			boundPageForToken: token => this.bindingModel.getBindingForToken(token)?.pageId,
			knownPageIds: () => new Set(this.browserViewWorkbenchService.getKnownBrowserViews().keys()),
			readiness: (pageId, token) => this._readiness(pageId, token),
			describe: (pageId, token) => this._describe(pageId, token),
			confirm: (items, token) => this._confirm(items, token),
			restore: (pageId, token) => this._restore(pageId, token),
			log: (message, error) => this.logService.warn(`[ParadisAgentBrowserBindingRestore] ${message}`, error),
		}));

		const schedule = () => this._controller.schedule();
		this._register(this.bindingModel.onDidChange(schedule));
		this._register(this.paneTokenService.onDidChange(schedule));
		this._register(this.browserViewWorkbenchService.onDidChangeBrowserViews(schedule));
		// スペースを切り替えると、そのスペースのページを尋ねられるようになる。試す期間を数え直す
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this._controller.spaceSwitched()));
		// リモートのペインは接続が済むまで戻ってこない。接続が済んだ（繋ぎ直した）ら数え直す
		const connection = remoteAgentService.getConnection();
		if (connection) {
			this._connectionListener.value = connection.onDidStateChange(event => {
				if (event.type === PersistentConnectionEventType.ConnectionGain) {
					this._controller.restartWindow();
				}
			});
			void remoteAgentService.getEnvironment().then(() => this._controller.restartWindow(), () => undefined);
		}
		// 終了の途中ではペインとページが順に片付き、紐づけが消えていく。終了が決まりかけた時点の状態を
		// 同期で 1 回書いてから、以後は書かない（取り消されたら再開する）
		this._register(lifecycleService.onBeforeShutdown(() => this._controller.beginShutdown()));
		this._register(lifecycleService.onShutdownVeto(() => this._controller.cancelShutdown()));
		schedule();
	}

	/** ページを開かずに判定する。今見ていないスペースのものは尋ねない（見えないページへの同意にしない）。 */
	private _readiness(pageId: string, token: string): ParadisBindingRestoreReadiness {
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		if (instanceId === undefined) {
			return 'wait';
		}
		const terminalScope = this.terminalScopeService.resolveScope(instanceId);
		const eligibility = paradisEvaluateBindingScopeEligibility(terminalScope, this.browserScopeService.resolveScope(pageId));
		if (!eligibility.eligible) {
			return eligibility.reason === 'pending' ? 'wait' : 'never';
		}
		if (terminalScope.kind === 'managed' && terminalScope.stateKey !== this.workspaceSwitchService.activeStateKey) {
			return 'wait';
		}
		return 'ready';
	}

	private _describe(pageId: string, token: string): IParadisBindingRestoreDescription {
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		const pane = instanceId === undefined ? undefined : this.terminalService.getInstanceFromId(instanceId)?.title;
		const page = this.browserViewWorkbenchService.getKnownBrowserViews().get(pageId)?.getName();
		// 名前はページとターミナル（エージェント）が決められる。通知のリンクの書式として読まれないようにする
		return {
			page: paradisBindingRestoreDisplayName(page, localize('paradis.restoreBindings.untitledPage', "名前の無いページ")),
			pane: paradisBindingRestoreDisplayName(pane, localize('paradis.restoreBindings.untitledPane', "ターミナル")),
		};
	}

	private _confirm(items: readonly IParadisBindingRestoreDescription[], token: CancellationToken): Promise<ParadisBindingRestoreAnswer> {
		const listed = items.slice(0, MAX_LISTED).map(item => localize('paradis.restoreBindings.item', "「{0}」→「{1}」", item.page, item.pane)).join(localize('paradis.restoreBindings.separator', "、"));
		const rest = items.length > MAX_LISTED ? localize('paradis.restoreBindings.more', "ほか {0} 件", items.length - MAX_LISTED) : '';
		const message = localize('paradis.restoreBindings.message', "再起動の前にエージェントへ共有していたブラウザのページが {0} 件あります。同じターミナルへの共有を戻しますか? {1}{2}", items.length, listed, rest);
		return new Promise<ParadisBindingRestoreAnswer>(resolve => {
			let settled = false;
			const settle = (answer: ParadisBindingRestoreAnswer) => {
				if (!settled) {
					settled = true;
					resolve(answer);
				}
			};
			const handle = this.notificationService.prompt(Severity.Info, message, [
				{ label: localize('paradis.restoreBindings.restore', "戻す"), run: () => settle('restore') },
				{ label: localize('paradis.restoreBindings.discard', "戻さない"), run: () => settle('discard') },
			], { sticky: true, onCancel: () => settle('later') });
			// 答える前にスペースが切り替わったら、前のスペースのページについての通知は閉じる
			const listener = token.onCancellationRequested(() => {
				listener.dispose();
				handle.close();
				settle('later');
			});
			Event.once(handle.onDidClose)(() => listener.dispose());
		});
	}

	private async _restore(pageId: string, token: string): Promise<ParadisBindingRestoreOutcome> {
		const input = this.browserViewWorkbenchService.getKnownBrowserViews().get(pageId);
		if (input === undefined) {
			return 'skipped';
		}
		try {
			const model = input.model ?? await input.resolve();
			// 開いている間にスペースが切り替わっていれば、見えなくなったページは後回しにする
			if (this._readiness(pageId, token) !== 'ready') {
				return 'retry';
			}
			if (model.sharingState === BrowserViewSharingState.Unavailable) {
				// 共有の機能がまだ使えない（起動の途中）
				return 'retry';
			}
			if (!model.isDirectlyShareable || model.sharingState === BrowserViewSharingState.BlockedByNetworkPolicy) {
				this.logService.info('[ParadisAgentBrowserBindingRestore] not restoring a browser share after restart: the page cannot be shared directly');
				return 'skipped';
			}
			const eligibility = this.bindingModel.getBindEligibility(model, token);
			if (!eligibility.eligible) {
				return eligibility.reason === 'pending' ? 'retry' : 'skipped';
			}
			const bound = await this.bindingModel.bindPageToPane(model, token);
			this.logService.info(`[ParadisAgentBrowserBindingRestore] ${bound ? 'restored' : 'did not restore (declined)'} a browser share after restart`);
			return bound ? 'restored' : 'declined';
		} catch (error) {
			// 状態が動いている最中の失敗（PARA_BROWSER_RETRYABLE）はもう一度試す
			if (error instanceof Error && error.message.startsWith('PARA_BROWSER_RETRYABLE')) {
				return 'retry';
			}
			this.logService.warn('[ParadisAgentBrowserBindingRestore] failed to restore a browser share after restart', error);
			return 'skipped';
		}
	}
}

registerWorkbenchContribution2(ParadisAgentBrowserBindingRestoreContribution.ID, ParadisAgentBrowserBindingRestoreContribution, WorkbenchPhase.AfterRestored);
