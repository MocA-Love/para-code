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
import { raceCancellation, raceTimeout, Sequencer } from '../../../../base/common/async.js';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { BrowserViewStorageScope, IBrowserViewService, ipcBrowserViewChannelName } from '../../../../platform/browserView/common/browserView.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { FocusMode, INativeHostService } from '../../../../platform/native/common/native.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { EditorsOrder } from '../../../../workbench/common/editor.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { BrowserViewSharingState, IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
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
import { ParadisNativeWindowFocus } from './paradisNativeWindowFocus.js';

/** 共有相手を加えた後、モデルが共有済みになるのを待つ上限。 */
const SHARE_STATE_TIMEOUT_MS = 3_000;
/** 新しいタブのスペースが決まるのを待つ上限。決まらないまま共有すると、所属不明として断られる。 */
const SCOPE_SETTLE_TIMEOUT_MS = 3_000;
/** 開いたタブで URL を読み込むのを待つ上限。超えてもタブは開いたまま返す。 */
const NAVIGATION_TIMEOUT_MS = 20_000;
/** 承認ダイアログに出すペイン名の最大文字数。 */
const PANE_TITLE_MAX_LENGTH = 60;

/**
 * 締め切りのトークン → その締め切り。承認が取り消されたとき、時間切れ（放置された）なのか、呼び出し元の
 * 取り消し（エージェント側で Esc を押したなど）なのかを見分けるために使う。
 */
const approvalDeadlines = new WeakMap<CancellationToken, ParadisApprovalDeadline>();

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
		approvalDeadlines.set(this._source.token, this);
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
	/**
	 * 拒否の後の自動の断りを数える単位。無ければペイン単位（ページ共有・プロファイル）。
	 * 付けると「そのペインの、この単位の求め」だけを止め、ペイン単位の断りにも数えられない
	 * （モバイル端末の要求は端末ごとに数え、ページ共有は止めない）。
	 */
	readonly cooldownKey?: string;
}

export type ParadisAgentApprovalChoice = 'approve' | 'alternative';

/**
 * 承認の結果。承認以外は次のとおり:
 *  - denied: ユーザーが拒否した（拒否・Esc・閉じる）。しばらくは同じペインからの求めを自動で断る
 *  - cancelled: 呼び出し側が取り消した（締め切り・MCP の取り消し）
 *  - unanswered: 表示直後やショートカットでの承認が続き、確かな答えが得られなかった
 *  （表示したのに cancelled / unanswered で終わったのが続いたときも、拒否と同じくしばらく自動で断る）
 *  - busy: 同じペインの別の求めがまだ答えを待っている
 *  - recentlyDenied: 同じペインの求めを少し前にユーザーが断った
 */
export type ParadisAgentApprovalOutcome = ParadisAgentApprovalChoice | 'denied' | 'cancelled' | 'unanswered' | 'busy' | 'recentlyDenied';

/** 拒否の後、同じペインからの求めを自動で断る時間。承認疲れを誘う繰り返しを止める。 */
const DENIAL_COOLDOWN_MS = 3 * 60_000;
/**
 * 画面に出したダイアログが答えの無いまま終わった（締め切りまで放置された・速押しの打ち切り）のがこの回数
 * 続いたら、拒否と同じだけ自動で断る。放置されたダイアログを締め切りごとに出し直させないため。
 * 呼び出し元の取り消し（エージェント側で中断した）は数えない。
 */
const UNANSWERED_COOLDOWN_STREAK = 2;
/** 承認ダイアログが実際に画面に出たかを確かめる間隔。 */
const DIALOG_SHOWN_POLL_MS = 50;

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

	/**
	 * エージェントが開いたタブとして登録する。タブが閉じられると自動で外れる。`approvedProfile`
	 * （承認を得て開いたユーザーのプロファイルのタブ）は、ユーザーが共有を止めた時点でも外れる。
	 */
	registerAgentTab(token: string, input: BrowserEditorInput, options?: { readonly approvedProfile?: boolean }): void;

	/** そのペインのエージェントが開いたタブか。 */
	isOpenedBy(token: string, viewId: string): boolean;

	/**
	 * ユーザーがそのページの共有を止めた（「ブラウザページの共有を解除」・共有ダイアログのスイッチ）。
	 * 承認を得て開いたユーザーのプロファイルのタブなら、エージェントの台帳から外す（次に使うときは承認し直し）。
	 */
	revokeApprovedProfileTab(pageId: string): void;

	/**
	 * そのタブへペインの共有を移す。タブのスペースが決まるのを少し待ってから共有する。
	 * 失敗しても例外は投げず false を返す。
	 */
	bindTab(token: string, input: BrowserEditorInput): Promise<boolean>;

	/**
	 * エージェントの求めをユーザーに承認してもらう（ページの共有、ユーザーのプロファイルを使うなど）。
	 * 「拒否」が先頭で既定のフォーカス。表示直後の承認は聞き直す。拒否・閉じる・取り消しは undefined。
	 */
	askApproval(token: string, request: IParadisAgentApprovalRequest, cancellation: CancellationToken): Promise<ParadisAgentApprovalOutcome>;

	/**
	 * {@link askApproval} を今呼んだら、ダイアログを出す前に断るか（自動の断りの間・同じペインの求めが答え待ち）。
	 * 承認の前に重い下ごしらえ（インストールするものを写すなど）をする呼び出し側が、先に確かめるためのもの。
	 * 判定は askApproval でもう一度行う。
	 */
	approvalBlock(token: string, cooldownKey?: string): 'recentlyDenied' | 'busy' | undefined;

	/**
	 * {@link bindTab} を締め切り付きで行う。締め切りまでに終われば結果、過ぎたら undefined を返し、
	 * 後から共有が成立しても外す（時間切れと答えたエージェントのペインの共有先が黙って移らないように）。
	 */
	bindTabWithin(token: string, input: BrowserEditorInput, cancellation: CancellationToken): Promise<boolean | undefined>;

	/** 上限の確認とタブを開く処理の間に、同じペインの別の呼び出しが割り込まないよう枠を取る。 */
	reserveSlot(token: string): IDisposable | undefined;

	/**
	 * `privateAffinity` があれば、そのペイン専用の保存領域（その affinity のエージェントの保存領域）で開く。
	 * shared process がペインのトークンから作って渡す（ヘッダ・HTTP 認証・リクエストのルールを掛けられるのは
	 * この保存領域のタブだけ）。
	 */
	openTab(token: string | undefined, url: string | undefined, background: boolean, privateAffinity?: string): Promise<IParadisOpenAgentTabResult>;
	listTabs(token: string | undefined): IParadisListAgentTabsResult;
	selectTab(token: string | undefined, tabId: string): Promise<IParadisSelectAgentTabResult>;
	closeTab(token: string | undefined, tabId: string): Promise<IParadisCloseAgentTabResult>;
	requestPage(token: string | undefined, reason: string | undefined, urlHint: string | undefined, cancellation?: CancellationToken): Promise<IParadisAgentPageRequestResult>;
}

export class ParadisAgentBrowserTabsService extends Disposable implements IParadisAgentBrowserTabsService {
	declare readonly _serviceBrand: undefined;

	/** main のブラウザビュー（共有相手の設定に使う）。 */
	private readonly _browserViews: IBrowserViewService;
	/** 誰がどのタブを開いたか。 */
	private readonly _ledger = new ParadisAgentTabLedger();
	/** viewId → エージェントが開いたタブ（閉じるときと一覧に使う）。 */
	private readonly _agentInputs = new Map<string, BrowserEditorInput>();
	private readonly _agentTabListeners = this._register(new DisposableMap<string, IDisposable>());
	/** ペイン → エージェント自身の求め（タブを開く・選ぶ・時間切れの共有を外す）で共有先を動かしている数。 */
	private readonly _agentMoves = new Map<string, number>();
	/** request_browser_page の処理中（締め切り後に遅れて成立する共有が片付くまでを含む）のペイン。 */
	private readonly _pendingRequests = new Set<string>();
	/** 承認を待っているペイン（ページでもプロファイルでも、1ペインにつき1つ）。 */
	private readonly _pendingApprovals = new Set<string>();
	/** ペイン（cooldownKey があれば「ペイン + その単位」）→ この時刻までは求めを自動で断る。 */
	private readonly _deniedUntil = new Map<string, number>();
	/** {@link _deniedUntil} と同じ単位 → 表示したのに答えが得られなかった回数（続いている分だけ）。 */
	private readonly _unansweredStreak = new Map<string, number>();
	/** 承認ダイアログは1つずつ出す（重なると、1件目へのダブルクリックが2件目の承認に当たる）。 */
	private readonly _approvalQueue = new Sequencer();
	private readonly _windowFocus: ParadisNativeWindowFocus;
	private _approvalSerial = 0;

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
		@IMainProcessService mainProcessService: IMainProcessService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
	) {
		super();
		this._windowFocus = this._register(new ParadisNativeWindowFocus(_nativeHostService.onDidFocusMainOrAuxiliaryWindow, _nativeHostService.onDidBlurMainOrAuxiliaryWindow));
		this._browserViews = ProxyChannel.toService<IBrowserViewService>(mainProcessService.getChannel(ipcBrowserViewChannelName));
		this._register(this._bindingModel.onDidChange(() => this._reconcileApprovedProfileTabs()));
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

	registerAgentTab(token: string, input: BrowserEditorInput, options?: { readonly approvedProfile?: boolean }): void {
		if (!this._ledger.registerAgentTab(token, input.id, options)) {
			return;
		}
		this._agentInputs.set(input.id, input);
		const listeners = new DisposableStore();
		listeners.add(input.onWillDispose(() => this._forgetView(input.id)));
		if (options?.approvedProfile) {
			// ブラウザの共有ボタン（upstream の切り替え）で止められたときも外す。エージェント自身が共有先を
			// 動かしている最中の変化は数えない。モデルが作り直されても（onDidResolveModel）見張り続ける
			const modelListener = listeners.add(new MutableDisposable());
			const watch = (model: IBrowserViewModel) => {
				modelListener.value = model.onDidChangeSharingState(state => {
					const owner = this._ledger.ownerOf(input.id);
					if (state !== BrowserViewSharingState.Shared && owner !== undefined && !this._agentMoves.has(owner)) {
						this.revokeApprovedProfileTab(input.id);
					}
				});
			};
			listeners.add(input.onDidResolveModel(model => watch(model)));
			void input.resolve().then(model => {
				if (!listeners.isDisposed && modelListener.value === undefined) {
					watch(model);
				}
			}, error => this._logService.debug('[ParadisAgentBrowserTabs] could not watch the sharing state of an approved profile tab', error));
		}
		this._agentTabListeners.set(input.id, listeners);
	}

	revokeApprovedProfileTab(pageId: string): void {
		if (this._ledger.revokeApprovedProfileTab(pageId)) {
			this._agentInputs.delete(pageId);
			this._agentTabListeners.deleteAndDispose(pageId);
		}
	}

	isOpenedBy(token: string, viewId: string): boolean {
		return this._ledger.isOpenedBy(token, viewId);
	}

	private _forgetView(viewId: string): void {
		this._ledger.forget(viewId);
		this._agentInputs.delete(viewId);
		this._agentTabListeners.deleteAndDispose(viewId);
	}

	/**
	 * ユーザーが共有を止めた承認済みプロファイルのタブを台帳から外す（タブ自体は閉じない。ユーザーのタブに戻る）。
	 * 以後エージェントが select_browser_tab で選ぶと unknownTab になり、使うには open_browser_profile で
	 * 承認を取り直す。
	 */
	private _reconcileApprovedProfileTabs(): void {
		const dropped = this._ledger.reconcileApprovedProfileTabs(
			token => this._bindingModel.getBindingForToken(token)?.pageId,
			token => this._agentMoves.has(token),
		);
		for (const viewId of dropped) {
			this._agentInputs.delete(viewId);
			this._agentTabListeners.deleteAndDispose(viewId);
		}
	}

	/**
	 * エージェント自身の求めで共有先を動かす間の印。その間に承認済みプロファイルのタブから共有が外れても、
	 * ユーザーが止めたとはみなさない。終わる前に今の共有先を記録し直す（共有先の変化の通知は遅れて届く）。
	 */
	private async _asAgentMove<T>(token: string, run: () => Promise<T>): Promise<T> {
		this._agentMoves.set(token, (this._agentMoves.get(token) ?? 0) + 1);
		try {
			return await run();
		} finally {
			this._reconcileApprovedProfileTabs();
			const remaining = (this._agentMoves.get(token) ?? 1) - 1;
			if (remaining > 0) {
				this._agentMoves.set(token, remaining);
			} else {
				this._agentMoves.delete(token);
			}
		}
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

	async openTab(token: string | undefined, url: string | undefined, background: boolean, privateAffinity?: string): Promise<IParadisOpenAgentTabResult> {
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
				session: privateAffinity !== undefined
					? { scope: BrowserViewStorageScope.Agent, affinity: privateAffinity }
					: { scope: BrowserViewStorageScope.Agent },
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
		// 読み込みの通知はモデルへ遅れて届くので、まだ空のページに見えるときは開くよう頼んだ URL を返す。
		const tab = this._describe(token, input);
		return { ok: true, tab: !tab.url || tab.url === 'about:blank' ? { ...tab, url: target } : tab, bound, openedCount: this.openedCount(token) };
	}

	listTabs(token: string | undefined): IParadisListAgentTabsResult {
		if (token === undefined) {
			return { ok: false, reason: 'paneUnresolved' };
		}
		// 共有先の変化の通知は遅れて届く（binding model の 100ms のまとめ）。その間に止められた承認済みの
		// タブを載せない・選ばせないよう、今の共有先で突き合わせてから答える
		this._reconcileApprovedProfileTabs();
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
		this._reconcileApprovedProfileTabs();
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
		let lateBinding: Promise<unknown> | undefined;
		try {
			const answer = await this._askForPage(token, paradisSanitizeAgentPageRequestReason(reason), primary, candidates, deadline.token);
			if (answer === 'busy') {
				return { ok: false, reason: 'alreadyPending' };
			}
			if (answer === 'recentlyDenied') {
				return { ok: false, reason: 'recentlyDenied' };
			}
			if (typeof answer === 'string' || deadline.token.isCancellationRequested) {
				// 断られた（denied）のか、答えが得られなかった（締め切り・速押しの打ち切り）のかを分けて返す。
				return { ok: true, approved: false, timedOut: answer !== 'denied' };
			}
			const chosen = answer;
			const binding = this.bindTab(token, chosen);
			const bound = await raceCancellation(binding, deadline.token);
			if (bound === undefined) {
				// 締め切りを過ぎた。エージェントには時間切れと返したので、後から共有が成立しても外す。
				// 外し終えるまでこのペインの次の求めを受け付けない（新しい求めの共有を、古い共有が
				// 上書きしてから外してしまうのを防ぐ）。
				lateBinding = binding.then(ok => ok ? this._unbindIfCurrent(token, chosen) : undefined);
				return { ok: true, approved: false, timedOut: true };
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
			if (lateBinding) {
				void lateBinding.finally(() => this._pendingRequests.delete(token));
			} else {
				this._pendingRequests.delete(token);
			}
		}
	}

	async bindTabWithin(token: string, input: BrowserEditorInput, cancellation: CancellationToken): Promise<boolean | undefined> {
		const binding = this.bindTab(token, input);
		const bound = await raceCancellation(binding, cancellation);
		if (bound === undefined) {
			void binding.then(ok => ok ? this._unbindIfCurrent(token, input) : undefined);
		}
		return bound;
	}

	/** 締め切り後に成立した共有を外す。その間にほかのタブへ移っていたら触らない。 */
	private async _unbindIfCurrent(token: string, input: BrowserEditorInput): Promise<void> {
		const pageId = this._bindingModel.getBindingForToken(token)?.pageId;
		if (pageId === undefined || (pageId !== input.id && this._ledger.isAgentTab(pageId))) {
			return;
		}
		try {
			await this._asAgentMove(token, () => this._bindingModel.unbindToken(token));
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
	approvalBlock(token: string, cooldownKey?: string): 'recentlyDenied' | 'busy' | undefined {
		const deniedUntil = this._deniedUntil.get(cooldownKey !== undefined ? `${token}\n${cooldownKey}` : token);
		if (deniedUntil !== undefined && Date.now() < deniedUntil) {
			return 'recentlyDenied';
		}
		return this._pendingApprovals.has(token) ? 'busy' : undefined;
	}

	async askApproval(token: string, request: IParadisAgentApprovalRequest, cancellation: CancellationToken): Promise<ParadisAgentApprovalOutcome> {
		const cooldownKey = request.cooldownKey !== undefined ? `${token}\n${request.cooldownKey}` : token;
		const deniedUntil = this._deniedUntil.get(cooldownKey);
		if (deniedUntil !== undefined) {
			if (Date.now() < deniedUntil) {
				return 'recentlyDenied';
			}
			this._deniedUntil.delete(cooldownKey);
		}
		if (this._pendingApprovals.has(token)) {
			return 'busy';
		}
		this._pendingApprovals.add(token);
		try {
			// ほかのペインの承認が出ている間は順番を待つ（待っている間も締め切りは進む）。
			const { outcome, shown } = await this._approvalQueue.queue(() => cancellation.isCancellationRequested
				? Promise.resolve({ outcome: 'cancelled' as const, shown: false })
				: this._showApproval(token, request, cancellation));
			// 放置された: 締め切りまで答えが無かった、または速押しの打ち切り。呼び出し元の取り消し（エージェント側で
			// 中断した）は放置ではないので、数えも打ち消しもしない。
			const ignored = outcome === 'unanswered' || (outcome === 'cancelled' && approvalDeadlines.get(cancellation)?.timedOut === true);
			if (outcome === 'denied') {
				this._unansweredStreak.delete(cooldownKey);
				this._deniedUntil.set(cooldownKey, Date.now() + DENIAL_COOLDOWN_MS);
			} else if (ignored) {
				// 画面に出る前に終わったもの（順番待ちのまま締め切られたなど）は数えない。
				if (shown) {
					const streak = (this._unansweredStreak.get(cooldownKey) ?? 0) + 1;
					if (streak >= UNANSWERED_COOLDOWN_STREAK) {
						this._unansweredStreak.delete(cooldownKey);
						this._deniedUntil.set(cooldownKey, Date.now() + DENIAL_COOLDOWN_MS);
					} else {
						this._unansweredStreak.set(cooldownKey, streak);
					}
				}
			} else if (outcome !== 'cancelled') {
				this._unansweredStreak.delete(cooldownKey);
			}
			return outcome;
		} finally {
			this._pendingApprovals.delete(token);
		}
	}

	/** 結果と、ダイアログが一度でも実際に画面に出たか。 */
	private async _showApproval(token: string, request: IParadisAgentApprovalRequest, cancellation: CancellationToken): Promise<{ readonly outcome: ParadisAgentApprovalOutcome; readonly shown: boolean }> {
		let shown = false;
		const outcome = await this._promptApproval(token, request, cancellation, () => { shown = true; });
		return { outcome, shown };
	}

	private async _promptApproval(token: string, request: IParadisAgentApprovalRequest, cancellation: CancellationToken, onShown: () => void): Promise<ParadisAgentApprovalOutcome> {
		type Choice = ParadisAgentApprovalChoice | 'deny';
		// ボタンの並びは意味を持つ:
		//  - 先頭（index 0）に既定のフォーカスが当たる。打ちかけの Enter が当たるよう「拒否」を置く
		//  - macOS の ⌘D は index 1 を押す。2つ目の選択肢（ページを選び直す）があればそれを置く
		//    （選び直しは続けて一覧から選ぶ必要がある）。無ければ承認が index 1 になるので、⌘D で
		//    決まった承認は下で聞き直す
		// ニーモニック（&&）は付けない。Alt との組み合わせで意図せず押されないようにするため。
		const buttons: { label: string; run: () => Choice }[] = [
			{ label: localize('paradis.agentTabs.approval.deny', "拒否"), run: () => 'deny' },
		];
		if (request.alternativeLabel) {
			buttons.push({ label: request.alternativeLabel, run: () => 'alternative' });
		}
		buttons.push({ label: request.approveLabel, run: () => 'approve' });

		const message = request.messageTemplate(this._describePane(token));
		let detail = request.detail;
		this._requestAttention();
		for (let attempt = 0; attempt < 3; attempt++) {
			const marker = `paradis-agent-approval-${++this._approvalSerial}`;
			const calledAt = Date.now();
			const watch = new DisposableStore();
			let shownAt: number | undefined;
			let shortcutUsed = false;
			try {
				// 1秒の猶予は、ダイアログが実際に画面に出た時刻から数える（upstream はダイアログを1つずつ
				// 出すので、前のダイアログの後ろで待っていた間を数えない）。
				const poll = mainWindow.setInterval(() => {
					if (shownAt === undefined && this._isDialogShown(marker)) {
						shownAt = Date.now();
						onShown();
					}
				}, DIALOG_SHOWN_POLL_MS);
				watch.add(toDisposable(() => mainWindow.clearInterval(poll)));
				if (isMacintosh) {
					for (const { window } of dom.getWindows()) {
						watch.add(dom.addDisposableListener(window, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
							if (event.metaKey && event.key.toLowerCase() === 'd') {
								shortcutUsed = true;
							}
						}, true));
					}
				}
				// cancelButton を付けないので、Esc と閉じるボタンは結果なし（＝拒否）になる。
				const { result } = await this._dialogService.prompt<Choice>({
					type: 'warning',
					message,
					detail: detail.join('\n\n'),
					buttons,
					custom: { classes: ['paradis-agent-approval-dialog', marker] },
					token: cancellation,
				});
				if (cancellation.isCancellationRequested) {
					return 'cancelled';
				}
				if (result === undefined || result === 'deny') {
					return 'denied';
				}
				const elapsed = Date.now() - (shownAt ?? calledAt);
				if (!shortcutUsed && elapsed >= PARADIS_AGENT_APPROVAL_GUARD_MS) {
					return result;
				}
			} finally {
				watch.dispose();
			}
			// 表示直後の承認や ⌘D での承認は、ほかの場所へ打っていたキーが当たった可能性が高い。もう一度聞く。
			detail = [
				localize('paradis.agentTabs.approval.tooFast', "表示された直後、またはキーボードのショートカットで押されたため、もう一度確認しています。ボタンをクリックして答えてください。"),
				...request.detail,
			];
		}
		return 'unanswered';
	}

	/**
	 * Para Code のウィンドウがどれも前面に無いときに承認ダイアログを出すなら、知らせる。知らせないと、
	 * 利用者は気付かないまま締め切りを迎える。macOS は Dock のアイコンが1回弾み、Dock のアイコンに点が
	 * 付く。Windows/Linux はタスクバーのボタンが点滅し続ける。点と点滅は、知らせたウィンドウに
	 * フォーカスが移るまで消えない（main の `showNotifyFocus` / `clearNotifyFocus`）。
	 * 前面に出すことはしない（ほかのアプリへ打っているキーを、このダイアログが受け取らないように）。
	 * 前面かどうかはネイティブのウィンドウで判定する（{@link ParadisNativeWindowFocus} を参照）。
	 */
	private _requestAttention(): void {
		if (!this._windowFocus.isAwayFrom(Array.from(dom.getWindows(), ({ window }) => window.vscodeWindowId))) {
			return;
		}
		// ダイアログはワークベンチのアクティブなウィンドウに出る
		this._nativeHostService.focusWindow({ targetWindowId: dom.getActiveWindow().vscodeWindowId, mode: FocusMode.Notify }).catch(error => {
			this._logService.trace('[ParadisAgentBrowserTabs] could not ask for attention for an approval dialog', error);
		});
	}

	/** その印の付いた承認ダイアログが、どれかのウィンドウに出ているか。 */
	private _isDialogShown(marker: string): boolean {
		for (const { window } of dom.getWindows()) {
			// 生きた一覧を1回引くだけで、要素の中身は触らない。
			// eslint-disable-next-line no-restricted-syntax
			if (window.document.getElementsByClassName(marker).length > 0) {
				return true;
			}
		}
		return false;
	}

	/** 選ばれたタブ、または承認されなかった理由を返す。 */
	private async _askForPage(token: string, reason: string | undefined, primary: BrowserEditorInput, candidates: readonly BrowserEditorInput[], cancellation: CancellationToken): Promise<BrowserEditorInput | Exclude<ParadisAgentApprovalOutcome, ParadisAgentApprovalChoice>> {
		const detail = [
			reason ? localize('paradis.agentTabs.request.reason', "エージェントが書いた理由: {0}", reason) : undefined,
			localize('paradis.agentTabs.request.page', "共有するページ: {0}", this._pageLabel(primary)),
			localize('paradis.agentTabs.request.effect', "共有すると、このターミナルのエージェントはページを読んだり操作したりできます。共有はブラウザの共有ボタンからいつでも止められ、エージェントが別のタブへ移った時点でも終わります。"),
		].filter((line): line is string => line !== undefined);
		const choice = await this.askApproval(token, {
			messageTemplate: pane => localize('paradis.agentTabs.request.message', "{0} のエージェントが、ブラウザのページを使いたいと求めています", pane),
			detail,
			approveLabel: localize('paradis.agentTabs.request.share', "このページを共有"),
			alternativeLabel: candidates.length > 1 ? localize('paradis.agentTabs.request.pick', "別のページを選ぶ…") : undefined,
		}, cancellation);
		if (choice === 'approve') {
			return primary;
		}
		if (choice !== 'alternative') {
			return choice;
		}

		type Item = IQuickPickItem & { readonly input: BrowserEditorInput };
		const items: Item[] = candidates.map(input => ({ label: this._displayTitle(input), description: input.url, input }));
		const picked = await this._quickInputService.pick(items, {
			title: localize('paradis.agentTabs.request.pickTitle', "エージェントに共有するページ"),
			placeHolder: localize('paradis.agentTabs.request.pickPlaceholder', "共有するページを選んでください（Esc で拒否）"),
			ignoreFocusLost: true,
		}, cancellation);
		if (cancellation.isCancellationRequested) {
			return 'cancelled';
		}
		return picked?.input ?? 'denied';
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
			return await this._asAgentMove(token, async () => {
				const model = await input.resolve();
				await this._waitForStableScope(input.id);
				await this._shareApproved(model);
				return await this._bindingModel.bindPageToPane(model, token);
			});
		} catch (error) {
			this._logService.warn('[ParadisAgentBrowserTabs] could not share the tab with the calling pane', error);
			return false;
		}
	}

	/**
	 * ここへ来る共有は、どれも Para Code 側で承認済み（エージェント自身のタブ、ユーザーが承認ダイアログで
	 * 許可したタブやプロファイル、そのペインが作ったプロファイル）。そのまま共有に進むと upstream の
	 * 「Share this browser page with the agent?」確認（既定のフォーカスが Allow）がもう1枚出て二重の
	 * 確認になるので、先にページの共有相手へエージェントを加えておく。upstream の確認は、共有済みの
	 * ページには出ない（`setSharedWithAgent` が最初に共有済みかを見る）。
	 *
	 * ネットワークの制限でそのまま共有できないタブ（`isDirectlyShareable` が false）には何もしない。
	 * その場合は upstream の流れ（共有用のタブを開き直す確認）に任せる。
	 */
	private async _shareApproved(model: IBrowserViewModel): Promise<void> {
		if (model.sharingState !== BrowserViewSharingState.Available || !model.isDirectlyShareable) {
			return;
		}
		const store = new DisposableStore();
		try {
			const shared = Event.toPromise(Event.filter(model.onDidChangeSharingState, state => state === BrowserViewSharingState.Shared), store);
			await this._browserViews.setAudience(model.id, { type: 'agent' }, true);
			// モデルが共有済みになったのを見てから進む（見る前に進むと upstream の確認が出る）。
			await raceTimeout(shared, SHARE_STATE_TIMEOUT_MS);
		} catch (error) {
			this._logService.warn('[ParadisAgentBrowserTabs] could not mark the approved page as shared', error);
		} finally {
			store.dispose();
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

