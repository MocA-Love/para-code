/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントのタブ操作と、ページ共有の「エージェントが要求 → ユーザーが承認」の受け口（renderer 側）。
//
// shared process の ParadisAgentBrowserService が「呼び出し元ペインを所有するウィンドウ」だけへ
// ルーティングして呼ぶ。1つのウィンドウには複数のスペースがあるので、ペイン → スペース → そのスペースが
// 見えているエディタ領域、の順に解く（paradisAgentPreview.contribution.ts / paradisBrowserProfileMcp と同じ判断）。
//
// 1ペインとページの共有は 1 対 1 のまま（CDP ゲートウェイが見せるのは共有中の1枚だけ）。複数のタブは
// 「共有するタブを切り替える」ことで扱う:
//  - open_browser_tab: 新しいタブを Agent スコープで開き、そのままこのペインへ共有する（承認済み扱い）
//  - select_browser_tab: 自分が開いたタブへ共有を移す。ユーザーのタブは、共有されている間しか使えない
//    （自分のタブへ移ったら、ユーザーのタブへ戻るにはもう一度頼む。見えないまま使い続けさせない）
//  - close_browser_tab: 自分が開いたタブだけ閉じられる
//  - request_browser_page: ユーザーのタブを使いたいときに頼む。承認ダイアログで選ばれたら共有する
//
// 承認ダイアログは「拒否」を先頭（既定のフォーカス）にし、表示直後の承認は打ちかけの Enter とみなして
// 聞き直す。ユーザーがエージェントのペインに文字を打っている最中に出ても、Enter 1回で共有されないように。
//
// 台帳（誰がどのタブを開いたか）はこのウィンドウのメモリにだけ持つ。ウィンドウを
// 再読み込みすると忘れ、それまでエージェントが開いていたタブは普通のタブとして残る（エージェントは
// もう閉じられない）。安全側に倒れるだけなので、永続化はしていない。

import './media/paradisAgentApproval.css';
import { raceCancellation, raceTimeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
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
	PARADIS_AGENT_APPROVAL_DEADLINE_MS,
	PARADIS_AGENT_APPROVAL_GUARD_MS,
	ParadisAgentTabLedger,
	ParadisAgentTabTargetFailure,
	paradisIsAllowedAgentTabUrl,
	paradisSanitizeAgentPageRequestReason,
	paradisSanitizeDisplayText,
	paradisUrlOrigin,
} from '../common/paradisAgentBrowserTabs.js';
import { IParadisAgentBrowserBindingModel } from './paradisAgentBrowserBindingModel.js';

/** 新しいタブのスペースが決まるのを待つ上限。決まらないまま共有すると、所属不明として断られる。 */
const SCOPE_SETTLE_TIMEOUT_MS = 3_000;
/** 開いたタブで URL を読み込むのを待つ上限。超えてもタブは開いたまま返す。 */
const NAVIGATION_TIMEOUT_MS = 20_000;
/** 承認ダイアログに出すペイン名の最大文字数。 */
const PANE_TITLE_MAX_LENGTH = 60;

/**
 * 承認の締め切り。呼び出し元（shared process）の取り消しと、{@link PARADIS_AGENT_APPROVAL_DEADLINE_MS}
 * の時間切れのどちらでも取り消される。`timedOut` は時間切れで取り消されたかどうか。
 */
export class ParadisApprovalDeadline extends Disposable {
	private readonly _source: CancellationTokenSource;
	private _timedOut = false;

	constructor(parent: CancellationToken | undefined, durationMs: number = PARADIS_AGENT_APPROVAL_DEADLINE_MS) {
		super();
		this._source = this._register(new CancellationTokenSource(parent));
		const timer = setTimeout(() => {
			this._timedOut = true;
			this._source.cancel();
		}, durationMs);
		this._register(toDisposable(() => clearTimeout(timer)));
	}

	get token(): CancellationToken {
		return this._source.token;
	}

	get timedOut(): boolean {
		return this._timedOut;
	}
}

/** {@link IParadisAgentBrowserTabsService.askApproval} に渡す中身。文言は呼び出し側で翻訳済みのもの。 */
export interface IParadisAgentApprovalRequest {
	/** ペインを示す語句を {0} に入れる見出し。 */
	readonly messageTemplate: (paneLabel: string) => string;
	readonly detail: readonly string[];
	readonly approveLabel: string;
	/** 2つ目の承認の選択肢（「別のページを選ぶ」など）。 */
	readonly alternativeLabel?: string;
}

export type ParadisAgentApprovalChoice = 'approve' | 'alternative';

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

	/**
	 * そのタブへペインの共有を移す。タブのスペースが決まるのを少し待ってから共有する。
	 * 失敗しても例外は投げず false を返す。
	 */
	bindTab(token: string, input: BrowserEditorInput): Promise<boolean>;

	/**
	 * エージェントの求めをユーザーに承認してもらう（ページの共有、ユーザーのプロファイルを使うなど）。
	 * 「拒否」が先頭で既定のフォーカス。表示直後の承認は聞き直す。拒否・閉じる・取り消しは undefined。
	 */
	askApproval(token: string, request: IParadisAgentApprovalRequest, cancellation: CancellationToken): Promise<ParadisAgentApprovalChoice | undefined>;

	/** 上限の確認とタブを開く処理の間に、同じペインの別の呼び出しが割り込まないよう枠を取る。 */
	reserveSlot(token: string): IDisposable | undefined;

	openTab(token: string | undefined, url: string | undefined, background: boolean): Promise<IParadisOpenAgentTabResult>;
	listTabs(token: string | undefined): IParadisListAgentTabsResult;
	selectTab(token: string | undefined, tabId: string): Promise<IParadisSelectAgentTabResult>;
	closeTab(token: string | undefined, tabId: string): Promise<IParadisCloseAgentTabResult>;
	requestPage(token: string | undefined, reason: string | undefined, urlHint: string | undefined, cancellation?: CancellationToken): Promise<IParadisAgentPageRequestResult>;
}

export class ParadisAgentBrowserTabsService extends Disposable implements IParadisAgentBrowserTabsService {
	declare readonly _serviceBrand: undefined;

	/** 誰がどのタブを開いたか。 */
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

		const bound = await this.bindTab(token, input);
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
		return { ok: true, tabs, openedCount: this.openedCount(token) };
	}

	async selectTab(token: string | undefined, tabId: string): Promise<IParadisSelectAgentTabResult> {
		if (token === undefined) {
			return { ok: false, reason: 'paneUnresolved' };
		}
		// 選べるのは自分が開いたタブと、今このペインに共有されているタブ（選び直しても何も変わらない）だけ。
		const input = this._browserViewWorkbenchService.getKnownBrowserViews().get(tabId);
		const isCurrent = this._bindingModel.getBindingForToken(token)?.pageId === tabId;
		if (!input || !(this.isOpenedBy(token, tabId) || isCurrent)) {
			return { ok: false, reason: 'unknownTab' };
		}
		if (isCurrent) {
			return { ok: true, tab: this._describe(token, input), bound: true };
		}
		const bound = await this.bindTab(token, input);
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
		// 切替の最中や、別のスペースへ退避中のタブ（エディタから外れている）は閉じない。退避中のタブを
		// エディタを通さずに捨てると、スペースを戻したときの復元が壊れる。
		if (this._workspaceSwitchService.isSwitching) {
			return { ok: false, reason: 'switching' };
		}
		const groups = this._editorGroupsService.groups.filter(group => group.contains(input));
		if (groups.length === 0) {
			return { ok: false, reason: 'tabNotVisible' };
		}
		for (const group of groups) {
			await group.closeEditor(input, { preserveFocus: true });
		}
		return { ok: true, openedCount: this.openedCount(token) };
	}

	async requestPage(token: string | undefined, reason: string | undefined, urlHint: string | undefined, cancellation?: CancellationToken): Promise<IParadisAgentPageRequestResult> {
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
		// 締め切りは1本: ダイアログ・ページ選び・共有の完了までをまとめて打ち切る。
		const deadline = new ParadisApprovalDeadline(cancellation);
		try {
			const chosen = await this._askForPage(token, paradisSanitizeAgentPageRequestReason(reason), primary, candidates, deadline.token);
			if (!chosen || deadline.token.isCancellationRequested) {
				return { ok: true, approved: false, timedOut: deadline.timedOut };
			}
			const binding = this.bindTab(token, chosen);
			const bound = await raceCancellation(binding, deadline.token);
			if (bound === undefined) {
				// 締め切りを過ぎた。エージェントには時間切れと返したので、後から共有が成立しても外す
				// （断られたと思っているエージェントのペインの共有先が、黙ってユーザーのタブへ移らないように）。
				void binding.then(ok => ok ? this._unbindIfCurrent(token, chosen) : undefined);
				return { ok: true, approved: false, timedOut: deadline.timedOut };
			}
			if (!bound) {
				return { ok: false, reason: 'shareFailed' };
			}
			// upstream が共有用に別タブを開き直した場合は、実際に共有されたタブを返す。
			const boundPage = this._bindingModel.getBindingForToken(token)?.pageId;
			const shared = (boundPage && this._browserViewWorkbenchService.getKnownBrowserViews().get(boundPage)) || chosen;
			return { ok: true, approved: true, tab: this._describe(token, shared) };
		} finally {
			deadline.dispose();
			this._pendingRequests.delete(token);
		}
	}

	/** 締め切り後に成立した共有を外す。その間にほかのタブへ移っていたら触らない。 */
	private async _unbindIfCurrent(token: string, input: BrowserEditorInput): Promise<void> {
		const pageId = this._bindingModel.getBindingForToken(token)?.pageId;
		if (pageId === undefined || (pageId !== input.id && this._ledger.isAgentTab(pageId))) {
			return;
		}
		try {
			await this._bindingModel.unbindToken(token);
		} catch (error) {
			this._logService.warn('[ParadisAgentBrowserTabs] could not withdraw a share that completed after the deadline', error);
		}
	}

	// #endregion

	// #region 承認ダイアログ

	/**
	 * 承認ダイアログ。ワークベンチ内のダイアログ（custom）にしているのは、締め切りで閉じられるように
	 * するため（ネイティブのシートは取り消せない）と、内蔵ブラウザの上に確実に出すため
	 * （`monaco-dialog-modal-block` は overlayManager に登録済み）。fork の自前ダイアログ（z-index 2600〜2800）
	 * が開いていてもその裏に隠れないよう、このダイアログの層だけ上げてある（media/paradisAgentApproval.css）。
	 */
	async askApproval(token: string, request: IParadisAgentApprovalRequest, cancellation: CancellationToken): Promise<ParadisAgentApprovalChoice | undefined> {
		type Choice = ParadisAgentApprovalChoice | 'deny';
		const buttons: { label: string; run: () => Choice }[] = [
			// 先頭のボタンに既定のフォーカスが当たる。打ちかけの Enter が「拒否」に当たるよう、拒否を先頭にする。
			{ label: localize({ key: 'paradis.agentTabs.approval.deny', comment: ['&& denotes a mnemonic'] }, "拒否(&&D)"), run: () => 'deny' },
			{ label: request.approveLabel, run: () => 'approve' },
		];
		if (request.alternativeLabel) {
			buttons.push({ label: request.alternativeLabel, run: () => 'alternative' });
		}
		const message = request.messageTemplate(this._describePane(token));
		let detail = request.detail;
		for (let attempt = 0; attempt < 3; attempt++) {
			const shownAt = Date.now();
			// cancelButton を付けないので、Esc と閉じるボタンは結果なし（＝拒否）になる。
			const { result } = await this._dialogService.prompt<Choice>({
				type: 'warning',
				message,
				detail: detail.join('\n\n'),
				buttons,
				custom: { classes: ['paradis-agent-approval-dialog'] },
				token: cancellation,
			});
			if (cancellation.isCancellationRequested || result === undefined || result === 'deny') {
				return undefined;
			}
			if (Date.now() - shownAt >= PARADIS_AGENT_APPROVAL_GUARD_MS) {
				return result;
			}
			// 表示直後の承認は、ほかの場所へ打っていた Enter が当たった可能性が高い。もう一度聞く。
			detail = [
				localize('paradis.agentTabs.approval.tooFast', "表示された直後に押されたため、もう一度確認しています。"),
				...request.detail,
			];
		}
		return undefined;
	}

	private async _askForPage(token: string, reason: string | undefined, primary: BrowserEditorInput, candidates: readonly BrowserEditorInput[], cancellation: CancellationToken): Promise<BrowserEditorInput | undefined> {
		const detail = [
			reason ? localize('paradis.agentTabs.request.reason', "エージェントが書いた理由: {0}", reason) : undefined,
			localize('paradis.agentTabs.request.page', "共有するページ: {0}", this._pageLabel(primary)),
			localize('paradis.agentTabs.request.effect', "共有すると、このターミナルのエージェントはページを読んだり操作したりできます。共有はブラウザの共有ボタンからいつでも止められ、エージェントが別のタブへ移った時点でも終わります。"),
		].filter((line): line is string => line !== undefined);
		const choice = await this.askApproval(token, {
			messageTemplate: pane => localize('paradis.agentTabs.request.message', "{0} のエージェントが、ブラウザのページを使いたいと求めています", pane),
			detail,
			approveLabel: localize({ key: 'paradis.agentTabs.request.share', comment: ['&& denotes a mnemonic'] }, "このページを共有(&&S)"),
			alternativeLabel: candidates.length > 1 ? localize({ key: 'paradis.agentTabs.request.pick', comment: ['&& denotes a mnemonic'] }, "別のページを選ぶ(&&P)…") : undefined,
		}, cancellation);
		if (choice === undefined) {
			return undefined;
		}
		if (choice === 'approve') {
			return primary;
		}

		type Item = IQuickPickItem & { readonly input: BrowserEditorInput };
		const items: Item[] = candidates.map(input => ({ label: this._displayTitle(input), description: input.url, input }));
		const picked = await this._quickInputService.pick(items, {
			title: localize('paradis.agentTabs.request.pickTitle', "エージェントに共有するページ"),
			placeHolder: localize('paradis.agentTabs.request.pickPlaceholder', "共有するページを選んでください（Esc で拒否）"),
			ignoreFocusLost: true,
		}, cancellation);
		return picked?.input;
	}

	/**
	 * ダイアログに出すペインの呼び名。ターミナルのタイトルはエージェントが OSC で書き換えられるので、
	 * 危ない文字を落としたうえで、書き換えられないターミナル番号とスペース名を並べる。
	 */
	private _describePane(token: string): string {
		const title = paradisSanitizeDisplayText(this._bindingModel.getPanes().find(pane => pane.token === token)?.title, PANE_TITLE_MAX_LENGTH);
		const instanceId = this._paneTokenService.getInstanceForToken(token);
		const stateKey = instanceId !== undefined ? this._terminalScopeService.getStateKeyForInstance(instanceId) : undefined;
		const spaceName = stateKey !== undefined
			? paradisSanitizeDisplayText(paradisListSpaces(this._workspaceSwitchService.repositories, this._worktreeService).find(entry => entry.space === stateKey)?.name, PANE_TITLE_MAX_LENGTH)
			: undefined;
		const where = instanceId === undefined
			? undefined
			: spaceName
				? localize('paradis.agentTabs.pane.whereWithSpace', "ターミナル {0}・スペース「{1}」", instanceId, spaceName)
				: localize('paradis.agentTabs.pane.where', "ターミナル {0}", instanceId);
		if (title && where) {
			return localize('paradis.agentTabs.pane.titleAndWhere', "「{0}」（{1}）", title, where);
		}
		return title ? localize('paradis.agentTabs.pane.title', "「{0}」", title) : where ?? localize('paradis.agentTabs.pane.unknown', "ターミナル");
	}

	private _displayTitle(input: BrowserEditorInput): string {
		return paradisSanitizeDisplayText(input.title || input.getName(), 120) ?? input.getName();
	}

	private _pageLabel(input: BrowserEditorInput): string {
		const title = this._displayTitle(input);
		const url = paradisSanitizeDisplayText(input.url, 200);
		return url && url !== title ? `${title} (${url})` : title;
	}

	// #endregion

	async bindTab(token: string, input: BrowserEditorInput): Promise<boolean> {
		try {
			const model = await input.resolve();
			await this._waitForStableScope(input.id);
			return await this._bindingModel.bindPageToPane(model, token);
		} catch (error) {
			this._logService.warn('[ParadisAgentBrowserTabs] could not share the tab with the calling pane', error);
			return false;
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
		const openedByAgent = this.isOpenedBy(token, input.id);
		const active = this._bindingModel.getBindingForToken(token)?.pageId === input.id;
		return {
			tabId: input.id,
			// 共有していないユーザーのタブは、どこのサイトかだけを見せる（パスやクエリに個人の情報が載りうる）。
			url: openedByAgent || active ? input.url ?? '' : paradisUrlOrigin(input.url),
			title: openedByAgent || active ? input.title || input.getName() : '',
			openedByAgent,
			active,
		};
	}
}

registerSingleton(IParadisAgentBrowserTabsService, ParadisAgentBrowserTabsService, InstantiationType.Delayed);

