/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 再起動（自動アップデートの適用を含む）やつなぎ直しで勝手に外れたブラウザページの共有を、同じペイン・同じページの
// 組だけ張り直す。手順は common/paradisBindingRestoreController.ts、台帳は common/paradisBindingRestoreLedger.ts。
// ここはワークベンチのサービスへつなぐだけ。
//
// 尋ねずに戻し、戻した件数を通知で知らせる（今見ていないスペースの分も、そのペインの端末がつなぎ直されたら戻す）。
// 戻すのはユーザーが共有するときと同じ経路（bindPageToPane）で、窓の一覧の同期と、別の窓のペイン・ページ
// （ownerConflict）・スペースの違い（scopeMismatch）の検査をそのまま通る。upstream の
// 「Share this browser page with the agent?」は出さない（先にページの共有の印を付ける。印が付かなければ進まない）。
// ページが別のサイトへ移っていたら戻さない。利用者が外した共有と、端末が終わったペインの共有は台帳から消す。
// 直接共有できないページ（エージェント用の新しいタブを開いて共有する種類）は、勝手にタブを増やさないよう張り直さない。

import { Disposable, DisposableMap, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { PersistentConnectionEventType } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { BrowserViewSharingState, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import {
	ParadisBindingRestoreController,
	ParadisBindingRestoreOutcome,
	ParadisBindingRestoreReadiness,
	paradisBindingRestoreDisplayName,
	paradisBindingRestoreFailureOutcome,
} from '../common/paradisBindingRestoreController.js';
import { paradisBindingRestoreOrigin } from '../common/paradisBindingRestoreLedger.js';
import { IParadisBrowserScopeService, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, paradisEvaluateBindingScopeEligibility } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisAgentBrowserBindingModel } from './paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService } from './paradisAgentBrowserTabsService.js';
import { IParadisBrowserExtensionsService } from '../../browserExtensions/electron-browser/paradisBrowserExtensionsService.js';

const LEDGER_STORAGE_KEY = 'paradis.agentBrowser.restoreBindings';

export class ParadisAgentBrowserBindingRestoreContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisAgentBrowserBindingRestore';

	private readonly _controller: ParadisBindingRestoreController;
	private readonly _connectionListener = this._register(new MutableDisposable());
	/** 共有しているページの遷移を見る（台帳のオリジンを、共有している間の最後のものに保つ）。 */
	private readonly _navigationListeners = this._register(new DisposableMap<string>());

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IParadisAgentBrowserBindingModel private readonly bindingModel: IParadisAgentBrowserBindingModel,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisBrowserScopeService private readonly browserScopeService: IParadisBrowserScopeService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
		@INotificationService private readonly notificationService: INotificationService,
		@IParadisAgentBrowserTabsService private readonly tabsService: IParadisAgentBrowserTabsService,
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
		@IParadisBrowserExtensionsService private readonly browserExtensionsService: IParadisBrowserExtensionsService,
	) {
		super();
		this._controller = this._register(new ParadisBindingRestoreController({
			readStorage: () => this.storageService.get(LEDGER_STORAGE_KEY, StorageScope.WORKSPACE),
			writeStorage: value => value === undefined
				? this.storageService.remove(LEDGER_STORAGE_KEY, StorageScope.WORKSPACE)
				: this.storageService.store(LEDGER_STORAGE_KEY, value, StorageScope.WORKSPACE, StorageTarget.MACHINE),
			listPaneTokens: () => this.paneTokenService.listPaneTokens().map(pane => pane.token),
			boundPageForToken: token => this.bindingModel.getBindingForToken(token)?.pageId,
			// current 以外の共有（2 枚目以降は新しい順で並ぶので、古い順へ直す）
			morePagesForToken: token => this.bindingModel.getBindingsForToken(token).filter(binding => binding.additional).map(binding => binding.pageId).reverse(),
			knownPageIds: () => new Set(this.browserViewWorkbenchService.getKnownBrowserViews().keys()),
			originOf: pageId => paradisBindingRestoreOrigin(this.browserViewWorkbenchService.getKnownBrowserViews().get(pageId)?.url),
			readiness: (pageId, token) => this._readiness(pageId, token),
			restore: (pageId, token, origin) => this._restore(pageId, token, origin),
			report: (restored, moved) => this._report(restored, moved),
			log: (message, error) => this.logService.warn(`[ParadisAgentBrowserBindingRestore] ${message}`, error),
		}));

		const schedule = () => this._controller.schedule();
		this._register(this.bindingModel.onDidChange(() => {
			this._watchNavigations();
			schedule();
		}));
		// 頼まれて外す共有は台帳から消す（勝手に外れたものだけを戻す）。外し終わるまでは書き戻さない
		this._register(this.bindingModel.onWillUnbindByRequest(event => {
			const hold = this._controller.userUnbind(event.token, event.pageId);
			void event.done.finally(() => hold.dispose());
		}));
		this._register(this.paneTokenService.onDidChange(schedule));
		this._register(this.paneTokenService.onDidEndPane(token => this._controller.paneEnded(token)));
		this._register(this.browserViewWorkbenchService.onDidChangeBrowserViews(schedule));
		// スペースを切り替えると、そのスペースのペインとページが戻ってくる。試す期間を数え直す
		this._register(workspaceSwitchService.onDidSwitchScope(() => this._controller.restartWindow()));
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
		this._watchNavigations();
		schedule();
	}

	/** 共有しているページが別のページへ移ったら台帳を書き直す（オリジンを共有している間の最後のものにする）。 */
	private _watchNavigations(): void {
		const bound = new Set(this.bindingModel.bindings.map(binding => binding.pageId));
		for (const pageId of [...this._navigationListeners.keys()]) {
			if (!bound.has(pageId)) {
				this._navigationListeners.deleteAndDispose(pageId);
			}
		}
		const views = this.browserViewWorkbenchService.getKnownBrowserViews();
		for (const pageId of bound) {
			const model = views.get(pageId)?.model;
			if (model && !this._navigationListeners.has(pageId)) {
				this._navigationListeners.set(pageId, model.onDidNavigate(() => this._controller.schedule()));
			}
		}
	}

	private _report(restored: number, moved: number): void {
		if (restored > 0) {
			this.notificationService.info(localize('paradis.restoreBindings.restored', "エージェントへ共有していたブラウザのページ {0} 件の共有を、同じターミナルへ戻しました。", restored));
		}
		if (moved > 0) {
			this.notificationService.info(localize('paradis.restoreBindings.moved', "別のサイトへ移っていたブラウザのページ {0} 件の共有は戻しませんでした。続けて使う場合は、もう一度共有してください。", moved));
		}
	}

	/** ページを開かずに判定する。今見ていないスペースのペインとページでも、同じスペースなら戻す。 */
	private _readiness(pageId: string, token: string): ParadisBindingRestoreReadiness {
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		if (instanceId === undefined) {
			return 'wait';
		}
		const eligibility = paradisEvaluateBindingScopeEligibility(this.terminalScopeService.resolveScope(instanceId), this.browserScopeService.resolveScope(pageId));
		if (!eligibility.eligible) {
			return eligibility.reason === 'pending' ? 'wait' : 'never';
		}
		return 'ready';
	}

	private async _restore(pageId: string, token: string, origin: string): Promise<ParadisBindingRestoreOutcome> {
		const input = this.browserViewWorkbenchService.getKnownBrowserViews().get(pageId);
		if (input === undefined) {
			return 'skipped';
		}
		try {
			const model = input.model ?? await input.resolve();
			// 開いている間にペインやページのスペースが変わっていれば、決まるまで待つ
			if (this._readiness(pageId, token) !== 'ready') {
				return 'retry';
			}
			// 開いた後のページ（読み込みで別のサイトへ送られた等）でもう一度照合する
			if (paradisBindingRestoreOrigin(model.url) !== origin) {
				this.logService.info('[ParadisAgentBrowserBindingRestore] not restoring a browser share: the page moved to another site');
				return 'moved';
			}
			if (model.sharingState === BrowserViewSharingState.Unavailable) {
				// 共有の機能がまだ使えない（起動の途中）
				return 'retry';
			}
			if (!model.isDirectlyShareable || model.sharingState === BrowserViewSharingState.BlockedByNetworkPolicy) {
				this.logService.info('[ParadisAgentBrowserBindingRestore] not restoring a browser share: the page cannot be shared directly');
				return 'skipped';
			}
			const eligibility = this.bindingModel.getBindEligibility(model, token);
			if (!eligibility.eligible) {
				return eligibility.reason === 'pending' ? 'retry' : 'skipped';
			}
			// 拡張機能が入ったタブ（確かめられないときを含む）は、知らせを見せずには戻さない（D4）。利用者が
			// もう一度共有すれば、共有の画面で知らせを見られる
			if (await this.browserExtensionsService.getShareWarning({ kind: 'view', viewId: model.id }) !== undefined) {
				const page = paradisBindingRestoreDisplayName(input.getName(), localize('paradis.restoreBindings.untitledPage', "名前の無いページ"));
				this.notificationService.info(localize('paradis.restoreBindings.extensions', "拡張機能が入ったタブ「{0}」の共有は戻しませんでした。拡張機能が入力した値はエージェントからも読めるため、続けて使う場合は、もう一度共有してください。", page));
				return 'skipped';
			}
			// upstream の確認（Share this browser page with the agent?）を出さないよう、先に共有の印を付ける。
			// 印が付かなければ進まない（進むと確認が出る）
			await this.tabsService.restoreShareMark(model);
			if (model.sharingState !== BrowserViewSharingState.Shared) {
				return 'retry';
			}
			const bound = await this.bindingModel.bindPageToPane(model, token);
			this.logService.info(`[ParadisAgentBrowserBindingRestore] ${bound ? 'restored' : 'did not restore'} a browser share`);
			return bound ? 'restored' : 'skipped';
		} catch (error) {
			const outcome = paradisBindingRestoreFailureOutcome(error);
			if (outcome === 'skipped') {
				this.logService.warn('[ParadisAgentBrowserBindingRestore] failed to restore a browser share', error);
			}
			return outcome;
		}
	}
}

registerWorkbenchContribution2(ParadisAgentBrowserBindingRestoreContribution.ID, ParadisAgentBrowserBindingRestoreContribution, WorkbenchPhase.AfterRestored);
