/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントのタブ操作（q.html Q70 案A）と、ページ共有の「要求 → 承認」（Q88 案A）の受け口（renderer 側）。
//
// shared process の ParadisAgentBrowserService が「呼び出し元ペインを所有するウィンドウ」だけへ
// ルーティングして呼ぶ。1つのウィンドウには複数のスペースがあるので、ペイン → スペース → そのスペースが
// 見えているエディタ領域、の順に解く（paradisAgentPreview.contribution.ts / paradisBrowserProfileMcp と同じ判断）。
//
// 1ペインとページの共有は 1 対 1 のまま（CDP ゲートウェイが見せるのは共有中の1枚だけ）。複数のタブは
// 「共有するタブを切り替える」ことで扱う:
//  - open_browser_tab: 新しいタブを Agent スコープで開き、そのままこのペインへ共有する（承認済み扱い）
//  - select_browser_tab: 自分が開いたタブか、ユーザーが一度共有・承認したタブへ共有を移す
//  - close_browser_tab: 自分が開いたタブだけ閉じられる
//  - request_browser_page: ユーザーのタブを使いたいときに頼む。承認ダイアログで選ばれたら共有する
//
// 台帳（誰がどのタブを開いたか・どのタブを承認済みか）はこのウィンドウのメモリにだけ持つ。ウィンドウを
// 再読み込みすると忘れ、それまでエージェントが開いていたタブは普通のタブとして残る（エージェントは
// もう閉じられない）。安全側に倒れるだけなので、永続化はしていない。

import { raceTimeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { EditorsOrder } from '../../../../workbench/common/editor.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import {
	IParadisAuxiliaryWindowScopeService,
	IParadisBrowserScopeService,
	IParadisTerminalScopeService,
	IParadisWorkspaceSwitchService,
	IParadisWorktreeService,
	paradisListSpaces,
} from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisAgentPageRequestResult,
	IParadisAgentTabInfo,
	IParadisCloseAgentTabResult,
	IParadisListAgentTabsResult,
	IParadisOpenAgentTabResult,
	IParadisSelectAgentTabResult,
	PARADIS_AGENT_BROWSER_TABS_CHANNEL,
	PARADIS_AGENT_PAGE_REQUEST_TIMEOUT_MS,
	ParadisAgentTabLedger,
	ParadisAgentTabMethod,
	ParadisAgentTabTargetFailure,
	paradisIsAllowedAgentTabUrl,
	paradisSanitizeAgentPageRequestReason,
} from '../common/paradisAgentBrowserTabs.js';
import { IParadisAgentBrowserBindingModel } from './paradisAgentBrowserBindingModel.js';

/** 新しいタブのスペースが決まるのを待つ上限。決まらないまま共有すると、所属不明として断られる。 */
const SCOPE_SETTLE_TIMEOUT_MS = 3_000;
/** 開いたタブで URL を読み込むのを待つ上限。超えてもタブは開いたまま返す。 */
const NAVIGATION_TIMEOUT_MS = 20_000;
/** renderer 側で承認を待つ上限。shared process の待ち時間より少し短くして、先にダイアログを閉じる。 */
const PAGE_REQUEST_DIALOG_TIMEOUT_MS = PARADIS_AGENT_PAGE_REQUEST_TIMEOUT_MS - 10_000;

export const IParadisAgentBrowserTabsService = createDecorator<IParadisAgentBrowserTabsService>('paradisAgentBrowserTabsService');

/** ペインから解いた、タブを開く先。 */
export type IParadisAgentTabTarget =
	| { readonly ok: true; readonly group: IEditorGroup }
	| { readonly ok: false; readonly reason: ParadisAgentTabTargetFailure };

/**
 * エージェントが開いたタブの台帳。プロファイルの MCP（paradisBrowserProfileMcp.contribution.ts）も
 * ここへ登録し、上限と「閉じられるのは自分が開いたものだけ」を同じ規則で扱う。
 */
export interface IParadisAgentBrowserTabsService {
	readonly _serviceBrand: undefined;

	/** 呼び出し元ペインのスペースが見えているエディタ領域のグループ。 */
	resolveTarget(token: string | undefined): IParadisAgentTabTarget;

	/** そのペインのエージェントが開いていて、まだ開いているタブの数。 */
	openedCount(token: string): number;

	/** エージェントが開いたタブとして登録する。タブが閉じられると自動で外れる。 */
	registerAgentTab(token: string, input: BrowserEditorInput): void;

	/** そのペインのエージェントが開いたタブか。 */
	isOpenedBy(token: string, viewId: string): boolean;

	/** 上限の確認とタブを開く処理の間に、同じペインの別の呼び出しが割り込まないよう枠を取る。 */
	reserveSlot(token: string): IDisposable | undefined;

	openTab(token: string | undefined, url: string | undefined, background: boolean): Promise<IParadisOpenAgentTabResult>;
	listTabs(token: string | undefined): IParadisListAgentTabsResult;
	selectTab(token: string | undefined, tabId: string): Promise<IParadisSelectAgentTabResult>;
	closeTab(token: string | undefined, tabId: string): Promise<IParadisCloseAgentTabResult>;
	requestPage(token: string | undefined, reason: string | undefined, urlHint: string | undefined): Promise<IParadisAgentPageRequestResult>;
}

export class ParadisAgentBrowserTabsService extends Disposable implements IParadisAgentBrowserTabsService {
	declare readonly _serviceBrand: undefined;

	/** 誰がどのタブを開いたか・どのタブを承認済みか。 */
	private readonly _ledger = new ParadisAgentTabLedger();
	/** viewId → エージェントが開いたタブ（閉じるときと一覧に使う）。 */
	private readonly _agentInputs = new Map<string, BrowserEditorInput>();
	private readonly _agentTabListeners = this._register(new DisposableMap<string, IDisposable>());
	/** 承認ダイアログが出ているペイン。 */
	private readonly _pendingRequests = new Set<string>();

	constructor(
		@IBrowserViewWorkbenchService private readonly _browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IParadisAgentBrowserBindingModel private readonly _bindingModel: IParadisAgentBrowserBindingModel,
		@IParadisPaneTokenService private readonly _paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService private readonly _terminalScopeService: IParadisTerminalScopeService,
		@IParadisBrowserScopeService private readonly _browserScopeService: IParadisBrowserScopeService,
		@IParadisWorkspaceSwitchService private readonly _workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly _worktreeService: IParadisWorktreeService,
		@IParadisAuxiliaryWindowScopeService private readonly _auxiliaryWindowScopeService: IParadisAuxiliaryWindowScopeService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._bindingModel.onDidChange(() => this._observeBindings()));
		this._observeBindings();
	}

	// #region 台帳

	openedCount(token: string): number {
		return this._ledger.openedCount(token);
	}

	reserveSlot(token: string): IDisposable | undefined {
		if (!this._ledger.tryReserveSlot(token)) {
			return undefined;
		}
		let released = false;
		return toDisposable(() => {
			if (!released) {
				released = true;
				this._ledger.releaseSlot(token);
			}
		});
	}

	registerAgentTab(token: string, input: BrowserEditorInput): void {
		if (!this._ledger.registerAgentTab(token, input.id)) {
			return;
		}
		this._agentInputs.set(input.id, input);
		this._agentTabListeners.set(input.id, input.onWillDispose(() => this._forgetView(input.id)));
	}

	isOpenedBy(token: string, viewId: string): boolean {
		return this._ledger.isOpenedBy(token, viewId);
	}

	private _forgetView(viewId: string): void {
		this._ledger.forget(viewId);
		this._agentInputs.delete(viewId);
		this._agentTabListeners.deleteAndDispose(viewId);
	}

	private _observeBindings(): void {
		this._ledger.observeBindings(this._bindingModel.bindings);
	}

	// #endregion

	// #region ペイン → 開く先

	resolveTarget(token: string | undefined): IParadisAgentTabTarget {
		if (this._workspaceSwitchService.isSwitching) {
			return { ok: false, reason: 'switching' };
		}
		let stateKey: string | undefined;
		if (token !== undefined) {
			const instanceId = this._paneTokenService.getInstanceForToken(token);
			if (instanceId === undefined) {
				return { ok: false, reason: 'paneUnresolved' };
			}
			const recorded = this._terminalScopeService.getStateKeyForInstance(instanceId);
			if (recorded !== undefined) {
				stateKey = recorded;
			} else {
				const scope = this._terminalScopeService.resolveScope(instanceId);
				if (scope.kind === 'managed') {
					stateKey = scope.stateKey;
				} else if (scope.kind === 'unscoped') {
					stateKey = this._workspaceSwitchService.activeStateKey;
				} else {
					return { ok: false, reason: 'paneUnresolved' };
				}
			}
		} else {
			stateKey = this._workspaceSwitchService.activeStateKey;
		}
		if (stateKey === undefined) {
			return { ok: true, group: this._editorGroupsService.mainPart.activeGroup };
		}
		const parts: readonly IEditorPart[] = this._workspaceSwitchService.activeStateKey === stateKey
			? [this._editorGroupsService.mainPart]
			: [...this._auxiliaryWindowScopeService.getPinnedParts(stateKey)];
		if (!parts.length) {
			const reachable = paradisListSpaces(this._workspaceSwitchService.repositories, this._worktreeService).some(entry => entry.space === stateKey);
			return { ok: false, reason: reachable ? 'spaceNotVisible' : 'unreachableSpace' };
		}
		const partSet = new Set(parts);
		const group = this._editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)
			.find(candidate => partSet.has(this._editorGroupsService.getPart(candidate)))
			?? parts[0].activeGroup;
		return { ok: true, group };
	}

	/** そのグループ群（＝ペインのスペースが見えている領域）に開いているブラウザのタブ。新しく使った順。 */
	private _browserTabsNear(group: IEditorGroup): BrowserEditorInput[] {
		const part = this._editorGroupsService.getPart(group);
		const tabs: BrowserEditorInput[] = [];
		for (const candidate of this._editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
			if (this._editorGroupsService.getPart(candidate) !== part) {
				continue;
			}
			for (const editor of candidate.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
				if (editor instanceof BrowserEditorInput && !tabs.includes(editor)) {
					tabs.push(editor);
				}
			}
		}
		return tabs;
	}

	// #endregion

	// #region ツールの実体

	async openTab(token: string | undefined, url: string | undefined, background: boolean): Promise<IParadisOpenAgentTabResult> {
		if (token === undefined) {
			return { ok: false, reason: 'paneUnresolved' };
		}
		const target = url ?? 'about:blank';
		if (!paradisIsAllowedAgentTabUrl(target)) {
			return { ok: false, reason: 'invalidUrl' };
		}
		const resolved = this.resolveTarget(token);
		if (!resolved.ok) {
			return resolved;
		}
		const slot = this.reserveSlot(token);
		if (!slot) {
			return { ok: false, reason: 'limitReached' };
		}

		let input: BrowserEditorInput | undefined;
		try {
			// Agent スコープ＝ユーザーのログイン情報を持たないエージェント専用の保存領域で、ネットワークの
			// 制限（chat.agent.networkFilter）も掛かる。共有相手を最初からエージェントにしておくので、
			// upstream の共有確認は出ない（upstream の open_browser ツールと同じ扱い）。
			input = await this._browserViewWorkbenchService.createBrowserView({
				owner: { type: 'user' },
				session: { scope: BrowserViewStorageScope.Agent },
				initialAudiences: [{ type: 'agent' }],
			});
			this.registerAgentTab(token, input);
			await this._editorService.openEditor(input, { pinned: true, preserveFocus: true, inactive: background }, resolved.group);
		} catch (error) {
			this._logService.warn('[ParadisAgentBrowserTabs] could not open a tab for the agent', error);
			if (input) {
				// エディタへ出せなかったビューを残すと、誰にも見えず閉じられないタブが main に居座る。
				this._forgetView(input.id);
				input.dispose();
			}
			return { ok: false, reason: 'openFailed' };
		} finally {
			slot.dispose();
		}

		const bound = await this._bind(token, input);
		if (target !== 'about:blank') {
			try {
				const model = await input.resolve();
				await raceTimeout(model.loadURL(target), NAVIGATION_TIMEOUT_MS);
			} catch (error) {
				// 読み込みの失敗はページ側の問題（DNS・証明書など）。タブは開いているので成功として返し、
				// エージェントには take_snapshot 等で確かめさせる。
				this._logService.debug('[ParadisAgentBrowserTabs] navigation in the agent tab did not finish', error);
			}
		}
		return { ok: true, tab: this._describe(token, input), bound, openedCount: this.openedCount(token) };
	}

	listTabs(token: string | undefined): IParadisListAgentTabsResult {
		if (token === undefined) {
			return { ok: false, reason: 'paneUnresolved' };
		}
		const tabs: IParadisAgentTabInfo[] = [];
		const seen = new Set<string>();
		const add = (input: BrowserEditorInput | undefined) => {
			if (input && !seen.has(input.id)) {
				seen.add(input.id);
				tabs.push(this._describe(token, input));
			}
		};
		const known = this._browserViewWorkbenchService.getKnownBrowserViews();
		const boundPage = this._bindingModel.getBindingForToken(token)?.pageId;
		add(boundPage ? known.get(boundPage) : undefined);
		for (const viewId of this._ledger.agentTabsOf(token)) {
			add(this._agentInputs.get(viewId));
		}
		for (const pageId of this._ledger.approvedOf(token)) {
			add(known.get(pageId));
		}
		return { ok: true, tabs, openedCount: this.openedCount(token) };
	}

	async selectTab(token: string | undefined, tabId: string): Promise<IParadisSelectAgentTabResult> {
		if (token === undefined) {
			return { ok: false, reason: 'paneUnresolved' };
		}
		const input = this._browserViewWorkbenchService.getKnownBrowserViews().get(tabId);
		if (!input || !(this.isOpenedBy(token, tabId) || this._ledger.isApproved(token, tabId))) {
			return { ok: false, reason: 'unknownTab' };
		}
		const bound = await this._bind(token, input);
		return { ok: true, tab: this._describe(token, input), bound };
	}

	async closeTab(token: string | undefined, tabId: string): Promise<IParadisCloseAgentTabResult> {
		if (token === undefined) {
			return { ok: false, reason: 'paneUnresolved' };
		}
		const input = this._agentInputs.get(tabId);
		if (!input) {
			return { ok: false, reason: this._browserViewWorkbenchService.getKnownBrowserViews().has(tabId) ? 'notOwned' : 'unknownTab' };
		}
		if (!this.isOpenedBy(token, tabId)) {
			return { ok: false, reason: 'notOwned' };
		}
		for (const group of this._editorGroupsService.groups) {
			if (group.contains(input)) {
				await group.closeEditor(input, { preserveFocus: true });
			}
		}
		// エディタに無いまま残っていた場合（開く途中で失敗した等）も、台帳からは必ず外す。
		if (this._agentInputs.has(tabId)) {
			this._forgetView(tabId);
			input.dispose();
		}
		return { ok: true, openedCount: this.openedCount(token) };
	}

	async requestPage(token: string | undefined, reason: string | undefined, urlHint: string | undefined): Promise<IParadisAgentPageRequestResult> {
		if (token === undefined) {
			return { ok: false, reason: 'paneUnresolved' };
		}
		if (this._pendingRequests.has(token)) {
			return { ok: false, reason: 'alreadyPending' };
		}
		const resolved = this.resolveTarget(token);
		if (!resolved.ok) {
			return resolved;
		}
		// 自分が開いたタブは承認不要なので、候補からは外す（select_browser_tab で移れる）。
		const candidates = this._browserTabsNear(resolved.group).filter(input => !this.isOpenedBy(token, input.id));
		if (candidates.length === 0) {
			return { ok: false, reason: 'noPages' };
		}
		const hint = urlHint?.trim();
		const primary = (hint ? candidates.find(input => (input.url ?? '').includes(hint)) : undefined) ?? candidates[0];

		this._pendingRequests.add(token);
		const cts = new CancellationTokenSource();
		try {
			const chosen = await raceTimeout(this._askForPage(token, paradisSanitizeAgentPageRequestReason(reason), primary, candidates, cts), PAGE_REQUEST_DIALOG_TIMEOUT_MS, () => cts.cancel());
			if (!chosen) {
				return { ok: true, approved: false };
			}
			this._ledger.approve(token, chosen.id);
			const bound = await this._bind(token, chosen);
			if (!bound) {
				return { ok: false, reason: 'shareFailed' };
			}
			// upstream が共有用に別タブを開き直した場合は、実際に共有されたタブを返す。
			const boundPage = this._bindingModel.getBindingForToken(token)?.pageId;
			const shared = (boundPage && this._browserViewWorkbenchService.getKnownBrowserViews().get(boundPage)) || chosen;
			this._ledger.approve(token, shared.id);
			return { ok: true, approved: true, tab: this._describe(token, shared) };
		} finally {
			cts.dispose();
			this._pendingRequests.delete(token);
		}
	}

	// #endregion

	// #region 承認ダイアログ

	/**
	 * 承認ダイアログ。ワークベンチ内のダイアログ（custom）にしているのは、時間切れで閉じられるように
	 * するため（ネイティブのシートは取り消せない）と、内蔵ブラウザの上に確実に出すため
	 * （`monaco-dialog-modal-block` は overlayManager に登録済み）。
	 */
	private async _askForPage(token: string, reason: string | undefined, primary: BrowserEditorInput, candidates: readonly BrowserEditorInput[], cts: CancellationTokenSource): Promise<BrowserEditorInput | undefined> {
		const paneTitle = this._bindingModel.getPanes().find(pane => pane.token === token)?.title;
		const pageLabel = this._pageLabel(primary);
		const detailLines = [
			reason ? localize('paradis.agentTabs.request.reason', "理由: {0}", reason) : undefined,
			localize('paradis.agentTabs.request.page', "共有するページ: {0}", pageLabel),
			localize('paradis.agentTabs.request.effect', "共有すると、このターミナルのエージェントはページを読んだり操作したりできます。共有はブラウザの共有ボタンからいつでも止められます。"),
		].filter((line): line is string => line !== undefined);

		type Choice = 'share' | 'pick' | 'deny';
		const buttons: { label: string; run: () => Choice }[] = [
			{ label: localize({ key: 'paradis.agentTabs.request.share', comment: ['&& denotes a mnemonic'] }, "このページを共有(&&S)"), run: () => 'share' },
		];
		if (candidates.length > 1) {
			buttons.push({ label: localize({ key: 'paradis.agentTabs.request.pick', comment: ['&& denotes a mnemonic'] }, "別のページを選ぶ(&&P)…"), run: () => 'pick' });
		}
		const { result } = await this._dialogService.prompt<Choice>({
			type: 'question',
			message: paneTitle
				? localize('paradis.agentTabs.request.messageWithPane', "ターミナル「{0}」のエージェントが、ブラウザのページを使いたいと求めています", paneTitle)
				: localize('paradis.agentTabs.request.message', "エージェントが、ブラウザのページを使いたいと求めています"),
			detail: detailLines.join('\n\n'),
			buttons,
			cancelButton: { label: localize('paradis.agentTabs.request.deny', "拒否"), run: () => 'deny' },
			custom: true,
			token: cts.token,
		});
		if (cts.token.isCancellationRequested || result === undefined || result === 'deny') {
			return undefined;
		}
		if (result === 'share') {
			return primary;
		}

		type Item = IQuickPickItem & { readonly input: BrowserEditorInput };
		const items: Item[] = candidates.map(input => ({ label: input.title || input.getName(), description: input.url, input }));
		const picked = await this._quickInputService.pick(items, {
			title: localize('paradis.agentTabs.request.pickTitle', "エージェントに共有するページ"),
			placeHolder: localize('paradis.agentTabs.request.pickPlaceholder', "共有するページを選んでください（Esc で拒否）"),
			ignoreFocusLost: true,
		}, cts.token);
		return picked?.input;
	}

	private _pageLabel(input: BrowserEditorInput): string {
		const title = input.title || input.getName();
		const url = input.url;
		return url && url !== title ? `${title} (${url})` : title;
	}

	// #endregion

	/** そのタブへこのペインの共有を移す。失敗してもタブ自体は残す。 */
	private async _bind(token: string, input: BrowserEditorInput): Promise<boolean> {
		this._ledger.beginSwitch(token, input.id);
		let bound = false;
		try {
			const model = await input.resolve();
			await this._waitForStableScope(input.id);
			bound = await this._bindingModel.bindPageToPane(model, token);
			return bound;
		} catch (error) {
			this._logService.warn('[ParadisAgentBrowserTabs] could not share the tab with the calling pane', error);
			return false;
		} finally {
			this._ledger.endSwitch(token, input.id, bound);
		}
	}

	private async _waitForStableScope(viewId: string): Promise<void> {
		if (this._browserScopeService.resolveScope(viewId).kind !== 'pending') {
			return;
		}
		const store = new DisposableStore();
		try {
			await raceTimeout(Event.toPromise(Event.filter(this._browserScopeService.onDidChangeStableScope, event => event.viewId === viewId), store), SCOPE_SETTLE_TIMEOUT_MS);
		} finally {
			store.dispose();
		}
	}

	private _describe(token: string, input: BrowserEditorInput): IParadisAgentTabInfo {
		return {
			tabId: input.id,
			url: input.url ?? '',
			title: input.title || input.getName(),
			openedByAgent: this.isOpenedBy(token, input.id),
			active: this._bindingModel.getBindingForToken(token)?.pageId === input.id,
		};
	}
}

registerSingleton(IParadisAgentBrowserTabsService, ParadisAgentBrowserTabsService, InstantiationType.Delayed);

/** shared process から届く呼び出しを {@link IParadisAgentBrowserTabsService} へ流すだけのチャネル。 */
export class ParadisAgentBrowserTabsChannel implements IServerChannel {

	constructor(private readonly _tabs: IParadisAgentBrowserTabsService) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const token = typeof args[0] === 'string' ? args[0] : undefined;
		const text = (index: number) => typeof args[index] === 'string' ? args[index] as string : undefined;
		switch (command) {
			case ParadisAgentTabMethod.Open:
				return this._tabs.openTab(token, text(1), args[2] === true) as Promise<T>;
			case ParadisAgentTabMethod.List:
				return this._tabs.listTabs(token) as T;
			case ParadisAgentTabMethod.Select:
				return this._tabs.selectTab(token, text(1) ?? '') as Promise<T>;
			case ParadisAgentTabMethod.Close:
				return this._tabs.closeTab(token, text(1) ?? '') as Promise<T>;
			case ParadisAgentTabMethod.RequestPage:
				return this._tabs.requestPage(token, text(1), text(2)) as Promise<T>;
		}
		throw new Error(`Method not found: ${command}`);
	}
}

class ParadisAgentBrowserTabsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisAgentBrowserTabs';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IParadisAgentBrowserTabsService tabs: IParadisAgentBrowserTabsService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_AGENT_BROWSER_TABS_CHANNEL, new ParadisAgentBrowserTabsChannel(tabs));
	}
}

registerWorkbenchContribution2(ParadisAgentBrowserTabsContribution.ID, ParadisAgentBrowserTabsContribution, WorkbenchPhase.AfterRestored);
