/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブラウザページ⇔ターミナルペインのバインディング状態をworkbench側でキャッシュ・監視する
// electron-browser専用サービス。shared processの PARADIS_AGENT_BROWSER_CHANNEL をポーリング
// （+ bind/unbind操作直後の即時再取得）して、バインディングダイアログ・ツールバーボタン・
// ステータスバー・ペインインジケータへ単一の状態ソースを提供する。
// バインド/解除の実処理もここに集約する（コマンドパレットとダイアログの二重実装を避ける）。

import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import { paradisCollectLivePaneInstances } from '../browser/paradisLivePaneInstances.js';
import { IParadisAbortBindResult, IParadisCommitBindResult, IParadisGatewayEndpoint, IParadisMcpSetupRequest, IParadisMcpSetupResult, IParadisPrepareBindRequest, IParadisPrepareBindResult, ParadisMcpCli, IParadisPaneBinding, PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';
import { ParadisRemovedBrowserBindingReconciler, ParadisSerializedReconciler } from '../common/paradisBrowserBindingLifecycle.js';
import { IParadisBindEligibility, IParadisBrowserScopeService, IParadisTerminalScopeService, ParadisStableBindingScope, paradisBindingScopesEqual, paradisEvaluateBindingScopeEligibility, paradisRequireBindingScopeEligibility } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisAgentBrowserAuthoritySyncService } from './paradisAgentBrowserAuthoritySyncService.js';

export const IParadisAgentBrowserBindingModel = createDecorator<IParadisAgentBrowserBindingModel>('paradisAgentBrowserBindingModel');

/** ペインで動いているエージェントCLIのベストエフォート判定結果。 */
export type ParadisPaneAgentKind = 'claude' | 'codex' | 'shell';

/** バインディングUIに表示する1ターミナルペイン分の情報。 */
export interface IParadisPaneDescriptor {
	readonly instanceId: number;
	readonly token: string;
	readonly title: string;
	readonly agentKind: ParadisPaneAgentKind;
	/** このペインのトークンでMCP/CDP接続実績があるか（shared process の listSeenTokens 由来）。 */
	readonly mcpConnected: boolean;
	/** このペインに現在バインドされているページ（あれば）。 */
	readonly binding: IParadisPaneBinding | undefined;
	/** Present when descriptors were resolved for a concrete browser page. */
	readonly bindEligibility?: IParadisBindEligibility;
}

/**
 * バインディング状態のキャッシュ + バインド/解除操作の集約サービス（electron-browser専用）。
 */
export interface IParadisAgentBrowserBindingModel {
	readonly _serviceBrand: undefined;

	/** キャッシュされたバインディング/接続実績/ペイン一覧が変化したときに発火する。 */
	readonly onDidChange: Event<void>;

	/** このウィンドウの現在のバインディング一覧（キャッシュ）。 */
	readonly bindings: readonly IParadisPaneBinding[];

	/** 現在のターミナルペイン一覧（トークンを持つもののみ）。 */
	getPanes(): IParadisPaneDescriptor[];

	/** All live panes for a page, including ineligible rows needed to manage existing bindings. */
	getPanesForPage(model: IBrowserViewModel): IParadisPaneDescriptor[];

	/** Shared scope gate used by dialogs, QuickPick, and the final bind operation. */
	getBindEligibility(model: IBrowserViewModel, token: string): IParadisBindEligibility;

	/** 指定ページにバインドされているバインディング一覧を返す。 */
	getBindingsForPage(pageId: string): IParadisPaneBinding[];

	/** 指定ペイントークンのバインディングを返す。 */
	getBindingForToken(token: string): IParadisPaneBinding | undefined;

	/** shared processから最新状態を再取得する。 */
	refresh(): Promise<void>;

	/**
	 * ページをペインへ共有（バインド）する。既存の共有フロー（確認ダイアログ +
	 * startTrackingPage）を通すため、ユーザーが確認を拒否した場合は false を返す。
	 */
	bindPageToPane(model: IBrowserViewModel, token: string): Promise<boolean>;

	/**
	 * 指定ペインのバインドを解除する。ページがどのペインにもバインドされなくなったら
	 * エージェント共有自体も解除する。
	 */
	unbindPane(model: IBrowserViewModel, token: string): Promise<void>;

	/** Unbind an existing row even when its page is outside the current scope. */
	unbindToken(token: string): Promise<void>;

	/**
	 * ページの全ペインバインドを解除し、エージェント共有も解除する。
	 * @returns 解除したバインディング数
	 */
	unbindPage(model: IBrowserViewModel): Promise<number>;

	/**
	 * 指定CLI（Claude Code / Codex）にpara-browser・chrome-devtools MCPをユーザーレベルで
	 * 自動登録する（shared process経由）。実行結果を返す。
	 */
	setupMcp(cli: ParadisMcpCli): Promise<IParadisMcpSetupResult>;

	/** shared processで起動済みのMCP+CDPゲートウェイ実ポートを取得する。 */
	getGatewayEndpoint(): Promise<IParadisGatewayEndpoint>;
}

/** shared processへのポーリング間隔（ms）。IPC1往復の軽い呼び出しのみ。 */
const POLL_INTERVAL = 3000;

interface IParadisBindScopeSnapshot {
	readonly scope: ParadisStableBindingScope;
	readonly terminalRevision: number;
	readonly browserRevision: number;
}

export class ParadisAgentBrowserBindingModel extends Disposable implements IParadisAgentBrowserBindingModel {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _bindings: readonly IParadisPaneBinding[] = [];
	private _seenTokens = new Set<string>();
	private _pollTimer: number | undefined;
	private _disposed = false;
	private readonly _browserViewReconcileScheduler: RunOnceScheduler;
	private readonly _browserViewReconciler: ParadisSerializedReconciler;
	private readonly _removedBrowserBindingReconciler: ParadisRemovedBrowserBindingReconciler;
	private _browserViewReconcileScheduledDelay: number | undefined;
	private readonly _tokenOperations = new Map<string, Promise<void>>();
	private readonly _pageOperations = new Map<string, Promise<void>>();
	private readonly _globalBindingOperations = new Map<string, Promise<void>>();
	private readonly _activePageBindTokens = new Map<string, Map<string, number>>();
	private readonly _unverifiedPageBindTokens = new Map<string, Map<string, number>>();
	private readonly _pendingUnsharePageIds = new Set<string>();
	private readonly _scheduledUnsharePageIds = new Set<string>();
	private _nextRefreshSerial = 0;
	private _appliedRefreshSerial = 0;

	/**
	 * onDidChange の発火を集約するコアレサ。onAnyInstanceTitleChange はエージェントCLIの
	 * OSCタイトル更新でターミナル数に比例して高頻度発火し、購読側（各ペインのインジケータ等）
	 * の再描画コストもペイン数に比例するため、素通しするとペイン数の二乗で再描画が走る。
	 * scheduleFire は「既に予約済みなら再予約しない」ことで、連続発火下でも一定間隔で
	 * 確実に発火する（trailing debounce の発火飢餓を避ける）。
	 */
	private readonly _fireScheduler = this._register(new RunOnceScheduler(() => this._onDidChange.fire(), 100));

	get bindings(): readonly IParadisPaneBinding[] { return this._bindings; }

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisBrowserScopeService private readonly browserScopeService: IParadisBrowserScopeService,
		@IParadisAgentBrowserAuthoritySyncService private readonly authoritySyncService: IParadisAgentBrowserAuthoritySyncService,
	) {
		super();
		this._removedBrowserBindingReconciler = new ParadisRemovedBrowserBindingReconciler(
			new Set(this.browserViewWorkbenchService.getKnownBrowserViews().keys()),
			{
				getLivePageIds: () => new Set(this.browserViewWorkbenchService.getKnownBrowserViews().keys()),
				listBindings: () => this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
					.call<IParadisPaneBinding[]>('listBindings'),
				unbindIfCurrent: (token, generation) => this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
					.call<boolean>('unbindIfCurrent', [token, generation]),
			},
		);
		this._browserViewReconciler = new ParadisSerializedReconciler(() => this._reconcileMissingBrowserViews());
		this._browserViewReconcileScheduler = this._register(new RunOnceScheduler(() => {
			this._browserViewReconcileScheduledDelay = undefined;
			void this._browserViewReconciler.request();
		}, 100));

		// ペイン集合・タイトル（エージェント種別判定に使用）の変化はUIの再描画に直結する。
		this._register(this.paneTokenService.onDidChange(() => this.scheduleFire()));
		this._register(this.terminalService.onDidChangeInstances(() => this.scheduleFire()));
		this._register(this.terminalService.onAnyInstanceTitleChange(() => this.scheduleFire()));
		this._register(this.browserViewWorkbenchService.onDidChangeBrowserViews(() => this.onBrowserViewsChanged()));
		this._register(this.terminalScopeService.onDidChangeStableScope(event => {
			this.scheduleFire();
			const token = this.paneTokenService.getTokenForInstance(event.instanceId);
			const binding = token ? this.getBindingForToken(token) : undefined;
			if (binding) {
				void this._runSerializedForPageAndTokens(binding.pageId, [binding.token], () => this._reconcileStableScopeChange(binding)).catch(() => undefined);
			}
		}));
		this._register(this.browserScopeService.onDidChangeStableScope(event => {
			this.scheduleFire();
			for (const binding of this.getBindingsForPage(event.viewId)) {
				void this._runSerializedForPageAndTokens(binding.pageId, [binding.token], () => this._reconcileStableScopeChange(binding)).catch(() => undefined);
			}
		}));

		this._pollTimer = mainWindow.setInterval(() => { void this.refresh(); }, POLL_INTERVAL);
		// 初期refreshの完了だけではreconcileしない。BrowserView復元中の空のknown台帳を
		// 「消滅」と誤判定しないよう、台帳のchange eventを起点にする。
		void this.refresh();
	}

	private scheduleFire(): void {
		if (!this._fireScheduler.isScheduled()) {
			this._fireScheduler.schedule();
		}
	}

	/** Binding mutations for one pane token must never overtake each other in this Renderer. */
	private _runSerializedForToken<T>(token: string, operation: () => Promise<T>): Promise<T> {
		return this._runSerializedForTokens([token], operation);
	}

	/** Atomically reserves every supplied token until the complete mutation (including cleanup) settles. */
	private _runSerializedForTokens<T>(tokens: readonly string[], operation: () => Promise<T>): Promise<T> {
		return this._runSerialized(
			[...new Set(tokens)].map(token => ({ operations: this._tokenOperations, key: token })),
			operation,
		);
	}

	/** Page sharing and every involved token are one transaction boundary. */
	private _runSerializedForPageAndTokens<T>(pageId: string, tokens: readonly string[], operation: () => Promise<T>): Promise<T> {
		return this._runSerialized([
			{ operations: this._pageOperations, key: pageId },
			...[...new Set(tokens)].map(token => ({ operations: this._tokenOperations, key: token })),
		], operation);
	}

	private _runSerialized<T>(
		reservations: readonly { operations: Map<string, Promise<void>>; key: string }[],
		operation: () => Promise<T>,
	): Promise<T> {
		// A token can move between pages while an operation waits. The global reservation is
		// the final ordering boundary for page-sharing mutations whose actual page therefore
		// cannot be locked reliably from a pre-operation cache snapshot.
		const allReservations = [
			{ operations: this._globalBindingOperations, key: 'binding' },
			...reservations,
		];
		const previous = allReservations.map(({ operations, key }) => operations.get(key) ?? Promise.resolve());
		const result = Promise.all(previous.map(operation => operation.catch(() => undefined))).then(operation);
		const tail = result.then(() => undefined, () => undefined);
		for (const { operations, key } of allReservations) {
			operations.set(key, tail);
		}
		void tail.then(() => {
			for (const { operations, key } of allReservations) {
				if (operations.get(key) === tail) {
					operations.delete(key);
				}
			}
		});
		return result;
	}

	private _addActivePageBind(pageId: string, token: string): void {
		let tokens = this._activePageBindTokens.get(pageId);
		if (!tokens) {
			tokens = new Map();
			this._activePageBindTokens.set(pageId, tokens);
		}
		tokens.set(token, (tokens.get(token) ?? 0) + 1);
	}

	private _removeActivePageBind(pageId: string, token: string): void {
		const tokens = this._activePageBindTokens.get(pageId);
		const count = tokens?.get(token);
		if (count === 1) {
			tokens?.delete(token);
		} else if (count !== undefined) {
			tokens?.set(token, count - 1);
		}
		if (tokens?.size === 0) {
			this._activePageBindTokens.delete(pageId);
		}
	}

	private _markPageBindUnverified(pageId: string, token: string): void {
		let tokens = this._unverifiedPageBindTokens.get(pageId);
		if (!tokens) {
			tokens = new Map();
			this._unverifiedPageBindTokens.set(pageId, tokens);
		}
		// Only a full snapshot started after commit dispatch can prove its outcome.
		tokens.set(token, this._nextRefreshSerial);
	}

	private _clearVerifiedPageBinds(refreshSerial: number): void {
		for (const [pageId, tokens] of this._unverifiedPageBindTokens) {
			for (const [token, minimumRefreshSerial] of tokens) {
				if (refreshSerial > minimumRefreshSerial) {
					tokens.delete(token);
				}
			}
			if (tokens.size === 0) {
				this._unverifiedPageBindTokens.delete(pageId);
			}
		}
	}

	private _findPendingPageForToken(token: string): string | undefined {
		for (const [pageId, tokens] of this._activePageBindTokens) {
			if (tokens.has(token)) {
				return pageId;
			}
		}
		for (const [pageId, tokens] of this._unverifiedPageBindTokens) {
			if (tokens.has(token)) {
				return pageId;
			}
		}
		return undefined;
	}

	private scheduleBrowserViewReconcile(delay: number): void {
		if (this._disposed) {
			return;
		}
		if (this._browserViewReconcileScheduler.isScheduled()) {
			if (this._browserViewReconcileScheduledDelay !== undefined && delay >= this._browserViewReconcileScheduledDelay) {
				return;
			}
			this._browserViewReconcileScheduler.cancel();
		}
		this._browserViewReconcileScheduledDelay = delay;
		this._browserViewReconcileScheduler.schedule(delay);
	}

	private onBrowserViewsChanged(): void {
		if (this._disposed) {
			return;
		}
		const nextIds = new Set(this.browserViewWorkbenchService.getKnownBrowserViews().keys());
		const removed = this._removedBrowserBindingReconciler.observeKnownPageIds(nextIds);
		if (!this._removedBrowserBindingReconciler.hasPendingRemovals) {
			this._browserViewReconcileScheduler.cancel();
			this._browserViewReconcileScheduledDelay = undefined;
		}
		if (removed) {
			this.scheduleBrowserViewReconcile(100);
		}
	}

	private async _reconcileMissingBrowserViews(): Promise<void> {
		if (this._disposed) {
			return;
		}
		await this._removedBrowserBindingReconciler.reconcile();
		if (this._disposed) {
			return;
		}
		// lifecycle判定はlistBindings単独で完結済み。ここではUI cacheだけを最後に更新する。
		await this.refresh();
		if (!this._disposed && this._removedBrowserBindingReconciler.hasPendingRemovals) {
			this.scheduleBrowserViewReconcile(POLL_INTERVAL);
		} else {
			// 実行中にqueueされた同じ削除eventが既に収束していれば、
			// 予約済みの不要な後続refresh/reconcileを取り消す。
			this._browserViewReconcileScheduler.cancel();
			this._browserViewReconcileScheduledDelay = undefined;
		}
	}

	getPanes(): IParadisPaneDescriptor[] {
		return this._getPanes();
	}

	getPanesForPage(model: IBrowserViewModel): IParadisPaneDescriptor[] {
		return this._getPanes(model);
	}

	private _getPanes(model?: IBrowserViewModel): IParadisPaneDescriptor[] {
		const result: IParadisPaneDescriptor[] = [];
		for (const { instance, token } of paradisCollectLivePaneInstances(this.terminalService, this.terminalGroupService, this.paneTokenService)) {
			result.push({
				instanceId: instance.instanceId,
				token,
				title: instance.title,
				agentKind: detectAgentKind(instance),
				mcpConnected: this._seenTokens.has(token),
				binding: this._bindings.find(b => b.token === token),
				bindEligibility: model ? this.getBindEligibility(model, token) : undefined,
			});
		}
		return result;
	}

	getBindEligibility(model: IBrowserViewModel, token: string): IParadisBindEligibility {
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		if (instanceId === undefined) {
			return { eligible: false, reason: 'pending' };
		}
		return paradisEvaluateBindingScopeEligibility(
			this.terminalScopeService.resolveScope(instanceId),
			this.browserScopeService.resolveScope(model.id),
		);
	}

	getBindingsForPage(pageId: string): IParadisPaneBinding[] {
		return this._bindings.filter(binding => binding.pageId === pageId);
	}

	getBindingForToken(token: string): IParadisPaneBinding | undefined {
		return this._bindings.find(binding => binding.token === token);
	}

	/** このウィンドウのターミナルペインにトークンが1本でも割り当てられているか（renderer内で同期判定）。 */
	private hasAnyPaneToken(): boolean {
		return this.paneTokenService.listPaneTokens().length > 0;
	}

	async refresh(): Promise<void> {
		await this._refreshFromBackend();
	}

	/** Returns the exact fresh binding snapshot, independent of concurrent cache refreshes. */
	private async _refreshFromBackend(force: boolean = false): Promise<readonly IParadisPaneBinding[] | undefined> {
		// トークンが1本も無ければ shared process のバインディング/接続実績はこのウィンドウに
		// 関係し得ず、listBindings/listSeenTokens の結果は必ず空へ収束する。ただし直前まで
		// 残っていたキャッシュを空へ落とし切る必要があるため、「トークン0 かつ 手元の
		// bindings/seenTokens も既に空」の両方を満たすときだけ IPC をスキップする。片方でも
		// 非空なら通常どおり取得して確実に空へ収束させ、トークンが1本でも生えれば次の tick で
		// 即座に取得を再開する（interval 自体は止めないのでイベント取りこぼしで固まらない）。
		if (!force && !this.hasAnyPaneToken() && this._bindings.length === 0 && this._seenTokens.size === 0) {
			return this._bindings;
		}
		const refreshSerial = ++this._nextRefreshSerial;
		try {
			const channel = this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL);
			const [bindings, seenTokens] = await Promise.all([
				channel.call<IParadisPaneBinding[]>('listBindings'),
				channel.call<string[]>('listSeenTokens'),
			]);
			if (this._store.isDisposed) {
				return undefined;
			}
			this._clearVerifiedPageBinds(refreshSerial);
			if (refreshSerial > this._appliedRefreshSerial) {
				this._appliedRefreshSerial = refreshSerial;
				const changed = JSON.stringify(bindings) !== JSON.stringify(this._bindings)
					|| seenTokens.length !== this._seenTokens.size
					|| seenTokens.some(token => !this._seenTokens.has(token));
				this._bindings = bindings;
				this._seenTokens = new Set(seenTokens);
				if (changed) {
					this.scheduleFire();
				}
			}
			this._schedulePendingPageUnshares(bindings);
			return bindings;
		} catch {
			// shared process 未起動等。次のポーリングで再試行される。
			return undefined;
		}
	}

	async bindPageToPane(model: IBrowserViewModel, token: string): Promise<boolean> {
		// Register synchronously so a page-wide unbind invoked before the cache refresh still
		// reserves this token and queues behind the complete bind transaction.
		this._addActivePageBind(model.id, token);
		try {
			return await this._runSerializedForPageAndTokens(model.id, [token], () => this._bindPageToPane(model, token));
		} finally {
			this._removeActivePageBind(model.id, token);
		}
	}

	private _captureBindScope(model: IBrowserViewModel, token: string): IParadisBindScopeSnapshot {
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		if (instanceId === undefined) {
			paradisRequireBindingScopeEligibility({ eligible: false, reason: 'pending' });
			throw new Error('unreachable');
		}
		const terminalScope = this.terminalScopeService.resolveScope(instanceId);
		const browserScope = this.browserScopeService.resolveScope(model.id);
		paradisRequireBindingScopeEligibility(paradisEvaluateBindingScopeEligibility(terminalScope, browserScope));
		if (terminalScope.kind === 'pending' || browserScope.kind === 'pending') {
			throw new Error('unreachable');
		}
		return {
			scope: terminalScope,
			terminalRevision: this.terminalScopeService.revision,
			browserRevision: this.browserScopeService.revision,
		};
	}

	private async _bindPageToPane(model: IBrowserViewModel, token: string): Promise<boolean> {
		// Fail before opening the existing share confirmation when the current scopes are already invalid.
		paradisRequireBindingScopeEligibility(this.getBindEligibility(model, token));

		// Keep the existing confirmation + startTrackingPage flow as the first mutation.
		const shared = await model.setSharedWithAgent(true);
		if (!shared) {
			return false;
		}

		let commitDispatched = false;
		try {
			const revision = await this.authoritySyncService.syncNow();
			const snapshot = this._captureBindScope(model, token);
			if (this.authoritySyncService.acceptedRevision !== revision) {
				throw new Error('PARA_BROWSER_RETRYABLE: binding authority changed before preparation');
			}

			const request: IParadisPrepareBindRequest = {
				revision,
				token,
				viewId: model.id,
				pageInfo: { url: model.url, title: model.title },
			};
			const channel = this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL);
			const prepared = await channel.call<IParadisPrepareBindResult>('prepareBind', [request]);

			let current: IParadisBindScopeSnapshot;
			try {
				current = this._captureBindScope(model, token);
			} catch (error) {
				await this._abortPreparedBind(prepared.ticketId);
				throw error;
			}
			const drifted = prepared.revision !== revision
				|| this.authoritySyncService.acceptedRevision !== revision
				|| current.terminalRevision !== snapshot.terminalRevision
				|| current.browserRevision !== snapshot.browserRevision
				|| !paradisBindingScopesEqual(prepared.scope, snapshot.scope)
				|| !paradisBindingScopesEqual(current.scope, snapshot.scope);
			if (drifted) {
				await this._abortPreparedBind(prepared.ticketId);
				throw new Error('PARA_BROWSER_RETRYABLE: pane or browser scope changed before commit');
			}

			let commit: Promise<IParadisCommitBindResult>;
			try {
				commit = channel.call<IParadisCommitBindResult>('commitBind', [{ ticketId: prepared.ticketId }]);
				commitDispatched = true;
				this._markPageBindUnverified(model.id, token);
			} catch (error) {
				// A synchronous throw means the request never left this Renderer.
				throw error;
			}
			await commit;
			await this._refreshFromBackend();
			return true;
		} catch (error) {
			// Once commit is dispatched a rejected/lost response is outcome-unknown. Disabling sharing
			// could then tear down a binding that the backend actually committed.
			if (commitDispatched) {
				try {
					// The backend may have committed before its response was lost. Converge the local cache
					// without changing sharing, while preserving the original outcome-unknown error.
					await this._refreshFromBackend();
				} catch {
					// Best-effort only; the polling loop will retry later.
				}
			} else {
				try {
					await this._rollbackSharingAfterDefinitePreCommitFailure(model);
				} catch {
					// Rollback is best-effort and must not replace the actionable transaction failure.
				}
			}
			throw error;
		}
	}

	private async _abortPreparedBind(ticketId: string): Promise<void> {
		try {
			await this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
				.call<IParadisAbortBindResult>('abortBind', [{ ticketId }]);
		} catch {
			// Failure to abort is not allowed to obscure the original, still pre-commit failure.
		}
	}

	private async _rollbackSharingAfterDefinitePreCommitFailure(model: IBrowserViewModel): Promise<void> {
		const bindings = await this._refreshFromBackend();
		if (bindings && !bindings.some(binding => binding.pageId === model.id)) {
			await model.setSharedWithAgent(false);
		}
	}

	private async _reconcileStableScopeChange(binding: IParadisPaneBinding): Promise<void> {
		if (this._disposed || this.authoritySyncService.isFrozen) {
			return;
		}
		const instanceId = this.paneTokenService.getInstanceForToken(binding.token);
		if (instanceId === undefined) {
			return;
		}
		const terminalScope = this.terminalScopeService.resolveScope(instanceId);
		const browserScope = this.browserScopeService.resolveScope(binding.pageId);
		if (terminalScope.kind === 'pending' || browserScope.kind === 'pending') {
			return;
		}
		if (paradisBindingScopesEqual(binding.scope, terminalScope)
			&& paradisBindingScopesEqual(binding.scope, browserScope)) {
			return;
		}

		await this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
			.call<boolean>('unbindIfCurrent', [binding.token, binding.generation]);
		// The authority manifest writer may have retired this exact generation first. Refresh even
		// when conditional unbind returns false so stale page sharing can still be released safely.
		const bindings = await this._refreshFromBackend();
		if (!bindings || bindings.some(candidate => candidate.pageId === binding.pageId)) {
			return;
		}
		const model = this.browserViewWorkbenchService.getKnownBrowserViews().get(binding.pageId)?.model;
		if (model) {
			await model.setSharedWithAgent(false);
		}
	}

	async unbindPane(_model: IBrowserViewModel, token: string): Promise<void> {
		await this.unbindToken(token);
	}

	async unbindToken(token: string): Promise<void> {
		const pageId = this.getBindingForToken(token)?.pageId ?? this._findPendingPageForToken(token);
		if (pageId) {
			await this._runSerializedForPageAndTokens(pageId, [token], () => this._unbindToken(token));
		} else {
			await this._runSerializedForToken(token, () => this._unbindToken(token));
		}
	}

	private async _unbindToken(token: string): Promise<void> {
		const candidatePageIds = new Set<string>();
		const binding = this.getBindingForToken(token);
		if (binding) {
			candidatePageIds.add(binding.pageId);
		}
		for (const [pageId, tokens] of this._activePageBindTokens) {
			if (tokens.has(token)) {
				candidatePageIds.add(pageId);
			}
		}
		for (const [pageId, tokens] of this._unverifiedPageBindTokens) {
			if (tokens.has(token)) {
				candidatePageIds.add(pageId);
			}
		}

		await this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call('unbind', [token]);
		const bindings = await this._refreshFromBackend(true);
		if (!bindings) {
			for (const pageId of candidatePageIds) {
				this._pendingUnsharePageIds.add(pageId);
			}
			return;
		}
		await this._unsharePagesWithoutBindings(candidatePageIds, bindings);
	}

	private async _unsharePagesWithoutBindings(
		pageIds: Iterable<string>,
		bindings: readonly IParadisPaneBinding[],
	): Promise<void> {
		for (const pageId of pageIds) {
			if (bindings.some(binding => binding.pageId === pageId)) {
				continue;
			}
			const model = this.browserViewWorkbenchService.getKnownBrowserViews().get(pageId)?.model;
			if (model) {
				await model.setSharedWithAgent(false);
			}
			this._pendingUnsharePageIds.delete(pageId);
		}
	}

	private _schedulePendingPageUnshares(bindings: readonly IParadisPaneBinding[]): void {
		if (this._disposed) {
			return;
		}
		for (const pageId of this._pendingUnsharePageIds) {
			if (this._scheduledUnsharePageIds.has(pageId)
				|| bindings.some(binding => binding.pageId === pageId)) {
				continue;
			}
			this._scheduledUnsharePageIds.add(pageId);
			void this._runSerializedForPageAndTokens(pageId, [], async () => {
				const exact = await this._refreshFromBackend(true);
				if (exact) {
					await this._unsharePagesWithoutBindings([pageId], exact);
				}
			}).catch(() => undefined).finally(() => this._scheduledUnsharePageIds.delete(pageId));
		}
	}

	async setupMcp(cli: ParadisMcpCli): Promise<IParadisMcpSetupResult> {
		const request: IParadisMcpSetupRequest = { cli };
		return this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
			.call<IParadisMcpSetupResult>('setupMcp', [request]);
	}

	getGatewayEndpoint(): Promise<IParadisGatewayEndpoint> {
		return this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
			.call<IParadisGatewayEndpoint>('getGatewayEndpoint');
	}

	async unbindPage(model: IBrowserViewModel): Promise<number> {
		const channel = this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL);
		const matching = this.getBindingsForPage(model.id);
		const savedBindings = new Map(matching.map(binding => [binding.token, binding]));
		const tokens = new Set(matching.map(binding => binding.token));
		for (const token of this._activePageBindTokens.get(model.id)?.keys() ?? []) {
			tokens.add(token);
		}
		for (const token of this._unverifiedPageBindTokens.get(model.id)?.keys() ?? []) {
			tokens.add(token);
		}
		return this._runSerializedForPageAndTokens(model.id, [...tokens], async () => {
			// A restored BrowserView can be actionable before terminal tokens are repopulated.
			// This transaction therefore needs a real authority read even on the zero-token fast path.
			const freshBindings = await this._refreshFromBackend(true);
			let removed = 0;
			if (!freshBindings) {
				// Known generations can still be retired safely, but without a complete snapshot we
				// cannot prove that an outcome-unknown commit or another pane does not still own this
				// page. In particular, unconditional token removal could delete a later rebind to a
				// different page. Keep sharing alive and require an authoritative retry.
				for (const token of tokens) {
					const cached = this.getBindingForToken(token);
					const expected = cached?.pageId === model.id ? cached : savedBindings.get(token);
					if (expected && await channel.call<boolean>('unbindIfCurrent', [token, expected.generation])) {
						removed++;
					}
				}
				throw new Error('PARA_BROWSER_RETRYABLE: binding state could not be verified before unsharing');
			}

			// The fresh snapshot may reveal rows absent from the cache used to reserve tokens.
			// The page reservation blocks same-page binds; generation checks protect concurrent
			// different-page rebinds for newly discovered tokens.
			for (const binding of freshBindings) {
				if (binding.pageId === model.id
					&& await channel.call<boolean>('unbindIfCurrent', [binding.token, binding.generation])) {
					removed++;
				}
			}
			// Hold every token reservation through sharing cleanup so a later bind cannot be stopped.
			await model.setSharedWithAgent(false);
			await this._refreshFromBackend(true);
			return removed;
		});
	}

	override dispose(): void {
		this._disposed = true;
		this._removedBrowserBindingReconciler.dispose();
		this._browserViewReconciler.dispose();
		this._browserViewReconcileScheduler.cancel();
		this._browserViewReconcileScheduledDelay = undefined;
		if (this._pollTimer !== undefined) {
			mainWindow.clearInterval(this._pollTimer);
			this._pollTimer = undefined;
		}
		super.dispose();
	}
}

/**
 * ターミナルのタイトル（通常はフォアグラウンドプロセス名を反映する）から、
 * ペインで動いているエージェントCLIをベストエフォートで判定する。
 */
export function detectAgentKind(instance: ITerminalInstance): ParadisPaneAgentKind {
	const title = instance.title.toLowerCase();
	if (title.includes('claude')) {
		return 'claude';
	}
	if (title.includes('codex')) {
		return 'codex';
	}
	return 'shell';
}

registerSingleton(IParadisAgentBrowserBindingModel, ParadisAgentBrowserBindingModel, InstantiationType.Delayed);
