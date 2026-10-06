/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// AIリミットモニターのクリックで開くアカウントカードパネル(パネル案1)。
// paradisResourceMonitorPanel.ts と同じ自前DOM(絶対配置)方式で、ポーリングは行わず
// ウィジェットから updateSnapshot() を受け取るだけの受け身のビュー。
// アカウントごとに 5時間/7日/モデル別枠のバーとリセット残り時間を表示し、失効アカウントには
// 再ログインボタン、プロバイダーヘッダーにはアカウント追加ボタンを出す。
//
// SSH のウィンドウの Claude は、ふだんは接続先（REH）のアカウントの一覧で、手元と同じ操作を出す。接続先が
// 切り替えに対応していないとき（スナップショットの `remoteHost` が付いている）は、接続先の Claude Code が
// いまログインしているアカウントだけを読み取り専用で出す。見出しに接続先の名前を出し、
// アカウントの追加・切り替え・登録・claude-swap の案内（差し込み部品を含む）は出さない。直し方の案内も
// 接続先のターミナルでの /login に変える。
//
// 幅は 800px で、左に Claude、右に Codex の2列にする（列の高さは揃えない）。ウィンドウが狭いときは
// 幅を縮めるか1列にし、ウィンドウの端からはみ出さないようにする（paradisLimitsPanelLayout.ts）。
// 使用状況を取得できていない（'unavailable'）カードは1行に縮め、押したときだけ理由とボタンを出す。

import './media/paradisLimitsMonitor.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import {
	IParadisLimitsAccount,
	IParadisLimitsProviderSnapshot,
	IParadisLimitsSnapshot,
	IParadisLimitsAge,
	IParadisLimitsPreviousValue,
	IParadisLimitsWindow,
	paradisLimitsNeedsRelogin,
	paradisLimitsNotFetchedCause,
	paradisLimitsPreviousValue,
	paradisLimitsSeverity,
	paradisLimitsWindowView,
	ParadisLimitsAccountStatus,
	ParadisLimitsProvider
} from '../common/paradisLimitsMonitor.js';
import { paradisLimitsPanelLayout } from '../common/paradisLimitsPanelLayout.js';
import { appendParadisLimitsLogo } from './paradisLimitsLogos.js';
import { ParadisLimitsMonitorClient } from './paradisLimitsMonitorClient.js';
import { IParadisLimitsPanelContext, IParadisLimitsPanelContribution, ParadisLimitsPanelContributions } from './paradisLimitsPanelContributions.js';

const $ = dom.$;

/** この分数より古い Claude の値には、カードに古さを書き添える。 */
const STALE_CARD_MINUTES = 5;

export interface IParadisLimitsMonitorPanelOptions {
	readonly initialSnapshot: IParadisLimitsSnapshot | undefined;
	/** 差し込み部品（{@link ParadisLimitsPanelContributions}）へ渡すクライアント。 */
	readonly client: ParadisLimitsMonitorClient;
	/** 取り直す。`force` を省略すると手動更新（true）として扱う。 */
	readonly onManualRefresh: (force?: boolean) => void;
	readonly onClose: () => void;
	readonly onAddAccount: (provider: ParadisLimitsProvider) => void;
	readonly onRelogin: (account: IParadisLimitsAccount) => void;
	readonly onRemoveAccount: (account: IParadisLimitsAccount) => void;
	/** 非表示状態の真の保持者はウィジェット側(永続化する主体)。パネルは都度これを聞くだけ。 */
	readonly isAccountHidden: (account: IParadisLimitsAccount) => boolean;
	readonly onToggleHiddenAccount: (account: IParadisLimitsAccount) => void;
}

export class ParadisLimitsMonitorPanel extends Disposable {

	private readonly element: HTMLElement;
	private readonly bodyElement: HTMLElement;
	private readonly refreshButton: HTMLElement;
	private readonly updatedElement: HTMLElement;

	/** renderBody() は毎ポーリングでDOMを作り直すため、行リスナーはここへ登録し再描画のたびにclearする。 */
	private readonly _bodyListeners = this._register(new DisposableStore());
	private readonly hoverDelegate = getDefaultHoverDelegate('mouse');
	/**
	 * 「非表示中のアカウント」折りたたみのopen状態(プロバイダー単位)。<details>のopen属性は
	 * renderBody()のdom.clearNodeで毎ポーリング(パネル表示中は30秒間隔)消えるため、ここに
	 * 保持して再描画のたびに復元する。持たないと、開いて眺めている最中に勝手に閉じてしまう。
	 */
	private readonly _hiddenDisclosureOpen = new Set<ParadisLimitsProvider>();
	/** 1行に縮めたカードのうち、開いているもの（`provider:id`）。描き直しをまたいで覚えておく。 */
	private readonly _expandedCompactCards = new Set<string>();
	/** 描き直しをまたいでフォーカスを保つ要素（描くたびに作り直す）。 */
	private readonly focusTargets = new Map<string, HTMLElement>();
	/** 最後に描いた値（開閉の切り替えで、取り直さずに描き直すため）。 */
	private lastSnapshot: IParadisLimitsSnapshot | undefined;
	/** プロバイダごとの差し込み部品（パネルを開いている間だけ生きる）。 */
	private readonly contributions: readonly IParadisLimitsPanelContribution[];
	private readonly contributionContext: IParadisLimitsPanelContext;

	constructor(
		private readonly anchor: HTMLElement,
		private readonly options: IParadisLimitsMonitorPanelOptions,
		@ILayoutService layoutService: ILayoutService,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this.contributionContext = {
			client: options.client,
			requestRefresh: force => options.onManualRefresh(force),
			redraw: () => this.redraw(),
			trackFocus: (element, key) => this.focusTargets.set(key, element),
			closePanel: () => options.onClose(),
		};
		this.contributions = ParadisLimitsPanelContributions.getAll().map(contribution => this._register(instantiationService.createInstance(contribution)));

		this.element = $('.paradis-limits-panel');
		this.element.tabIndex = -1;

		this.bodyElement = dom.append(this.element, $('.plm-body'));

		const footer = dom.append(this.element, $('.plm-footer'));
		this.refreshButton = dom.append(footer, $('.plm-icon-btn'));
		this.refreshButton.setAttribute('role', 'button');
		this.refreshButton.setAttribute('aria-label', localize('paradis.limitsMonitor.refreshAria', "更新"));
		this.refreshButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		this._register(dom.addDisposableListener(this.refreshButton, 'click', () => this.options.onManualRefresh()));
		this.updatedElement = dom.append(footer, $('.plm-updated'));

		layoutService.activeContainer.appendChild(this.element);
		this.reposition();

		this._register(dom.addDisposableListener(dom.getActiveWindow(), 'resize', () => this.reposition()));
		this._register(dom.addDisposableListener(dom.getActiveWindow(), 'mousedown', e => this.onWindowMouseDown(e), true));
		this._register(dom.addDisposableListener(this.element, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.options.onClose();
			}
		}));

		if (options.initialSnapshot) {
			this.updateSnapshot(options.initialSnapshot);
		} else {
			this.renderEmpty(localize('paradis.limitsMonitor.loading', "読み込み中…"));
		}
		this.element.focus();
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}

	updateSnapshot(snapshot: IParadisLimitsSnapshot): void {
		this.lastSnapshot = snapshot;
		this.renderBody(snapshot);
		const secondsAgo = Math.max(0, Math.round((Date.now() - snapshot.fetchedAt) / 1000));
		this.updatedElement.textContent = localize('paradis.limitsMonitor.updated', "{0}秒前に更新", secondsAgo);
	}

	/** 取り直さずに、最後の値で描き直す。 */
	private redraw(): void {
		if (!this._store.isDisposed && this.lastSnapshot) {
			this.renderBody(this.lastSnapshot);
		}
	}

	setFetching(isFetching: boolean): void {
		this.refreshButton.classList.toggle('spinning', isFetching);
	}

	private onWindowMouseDown(e: MouseEvent): void {
		const target = e.target as Node | null;
		if (!target) {
			return;
		}
		if (dom.isAncestor(target, this.element) || dom.isAncestor(target, this.anchor)) {
			return;
		}
		this.options.onClose();
	}

	private reposition(): void {
		const rect = this.anchor.getBoundingClientRect();
		const win = dom.getActiveWindow();
		const layout = paradisLimitsPanelLayout(rect.left, win.innerWidth);
		const maxTop = win.innerHeight - 40;
		this.element.style.top = `${Math.min(rect.bottom + 6, maxTop)}px`;
		this.element.style.left = `${layout.left}px`;
		this.element.style.width = `${layout.width}px`;
		this.bodyElement.classList.toggle('two-columns', layout.columns === 2);
	}

	private renderEmpty(message: string): void {
		dom.clearNode(this.bodyElement);
		dom.append(this.bodyElement, $('.plm-empty')).textContent = message;
	}

	private renderBody(snapshot: IParadisLimitsSnapshot | undefined): void {
		if (!snapshot) {
			return;
		}
		// 描き直すとボタンが作り直されてフォーカスが外れる（Esc で閉じられなくなる）。知らされた要素なら、
		// 描き直した後の同じ要素へフォーカスを戻す。
		const focused = dom.getActiveElement();
		const focusKey = [...this.focusTargets].find(([, element]) => element === focused)?.[0];
		this.focusTargets.clear();
		this._bodyListeners.clear();
		dom.clearNode(this.bodyElement);

		// 2列のときは左に Claude、右に Codex。1列のときは同じ2つの列が縦に並ぶ（.plm-body.two-columns の有無だけで切り替える）。
		this.renderProviderSection(dom.append(this.bodyElement, $('.plm-column')), 'claude', localize('paradis.limitsMonitor.claude', "Claude"), snapshot.claude);
		this.renderProviderSection(dom.append(this.bodyElement, $('.plm-column')), 'codex', localize('paradis.limitsMonitor.codex', "Codex"), snapshot.codex);
		if (focusKey !== undefined) {
			(this.focusTargets.get(focusKey) ?? this.element).focus();
		}
	}

	private renderProviderSection(parent: HTMLElement, provider: ParadisLimitsProvider, title: string, providerSnapshot: IParadisLimitsProviderSnapshot): void {
		const header = dom.append(parent, $('.plm-provider-header'));
		appendParadisLimitsLogo(header, provider);
		dom.append(header, $('span')).textContent = title;
		const remoteHost = provider === 'claude' ? providerSnapshot.remoteHost : undefined;
		if (remoteHost) {
			this.renderRemoteHostSection(parent, header, providerSnapshot, remoteHost.label);
			return;
		}
		// 非表示にしている分があると「3 アカウント」なのに行が2つしか無い、という食い違いが
		// 起きるため、隠れている分がある場合だけ「表示中 / 合計」の内訳を出す。
		const hiddenCount = providerSnapshot.accounts.filter(account => this.options.isAccountHidden(account)).length;
		const countLabel = hiddenCount > 0
			? localize('paradis.limitsMonitor.accountCountWithHidden', "{0} / {1} アカウント", providerSnapshot.accounts.length - hiddenCount, providerSnapshot.accounts.length)
			: localize('paradis.limitsMonitor.accountCount', "{0} アカウント", providerSnapshot.accounts.length);
		dom.append(header, $('.plm-provider-count')).textContent = countLabel;
		const addButton = dom.append(header, $('.plm-add-btn'));
		addButton.textContent = localize('paradis.limitsMonitor.addAccount', "＋ アカウントを追加");
		addButton.setAttribute('role', 'button');
		this._bodyListeners.add(dom.addDisposableListener(addButton, 'click', () => this.options.onAddAccount(provider)));

		this.renderProviderAccounts(parent, provider, providerSnapshot);
		for (const contribution of this.contributions) {
			if (contribution.provider !== provider || !contribution.renderProviderFooter) {
				continue;
			}
			const footer = dom.append(parent, $('.plm-provider-footer'));
			const disposable = contribution.renderProviderFooter(footer, providerSnapshot, this.contributionContext);
			if (disposable) {
				this._bodyListeners.add(disposable);
			}
			if (footer.childElementCount === 0) {
				footer.remove();
			}
		}
	}

	/**
	 * SSH の接続先の Claude のログイン（読み取り専用）。アカウントの数・追加ボタン・差し込み部品は出さず、
	 * 見出しに接続先の名前を出す。手元のアカウントは手元のウィンドウで見る。
	 */
	private renderRemoteHostSection(parent: HTMLElement, header: HTMLElement, providerSnapshot: IParadisLimitsProviderSnapshot, hostLabel: string | undefined): void {
		dom.append(header, $('.plm-provider-count')).textContent = hostLabel
			? localize('paradis.limitsMonitor.claudeRemoteHostHeading', "接続先 {0} のログイン", hostLabel)
			: localize('paradis.limitsMonitor.claudeRemoteHostHeadingUnknown', "接続先のログイン");
		this.renderProviderAccounts(parent, 'claude', providerSnapshot, true);
		dom.append(parent, $('.plm-provider-footer')).textContent = localize(
			'paradis.limitsMonitor.claudeRemoteHostNote',
			"接続先の Claude Code がいまログインしているアカウントです。手元の PC のアカウントの確認と切り替えは、手元のウィンドウで行います。",
		);
	}

	private renderProviderAccounts(parent: HTMLElement, provider: ParadisLimitsProvider, providerSnapshot: IParadisLimitsProviderSnapshot, remoteHost = false): void {
		if (providerSnapshot.sourceError) {
			dom.append(parent, $('.plm-source-error')).textContent = providerSnapshot.sourceError;
			return;
		}
		if (providerSnapshot.accounts.length === 0) {
			dom.append(parent, $('.plm-empty')).textContent = localize('paradis.limitsMonitor.noAccounts', "アカウントが見つかりません");
			return;
		}
		const hiddenAccounts: IParadisLimitsAccount[] = [];
		// 使用中のアカウントを列の先頭へ（ほかは届いた順のまま）。
		const ordered = [...providerSnapshot.accounts].sort((a, b) => Number(b.active === true) - Number(a.active === true));
		for (const account of ordered) {
			if (this.options.isAccountHidden(account)) {
				hiddenAccounts.push(account);
			} else {
				this.renderAccount(parent, account, remoteHost);
			}
		}
		if (hiddenAccounts.length > 0) {
			this.renderHiddenDisclosure(parent, provider, hiddenAccounts);
		}
	}

	/**
	 * ログイン用(~/.codex)と使用量確認用(~/.codex-2)のように重複しがちな行を削除せず個別に
	 * 隠せるようにする受け皿。隠したアカウントはここへ畳まれ、いつでも再表示できる。
	 */
	private renderHiddenDisclosure(parent: HTMLElement, provider: ParadisLimitsProvider, accounts: readonly IParadisLimitsAccount[]): void {
		const details = dom.append(parent, $('details.plm-hidden-disclosure')) as HTMLDetailsElement;
		details.open = this._hiddenDisclosureOpen.has(provider);
		this._bodyListeners.add(dom.addDisposableListener(details, 'toggle', () => {
			if (details.open) {
				this._hiddenDisclosureOpen.add(provider);
			} else {
				this._hiddenDisclosureOpen.delete(provider);
			}
		}));
		const summary = dom.append(details, $('summary'));
		summary.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
		dom.append(summary, $('span')).textContent = localize('paradis.limitsMonitor.hiddenAccounts', "非表示中のアカウント");
		dom.append(summary, $('.plm-hidden-count')).textContent = String(accounts.length);

		const list = dom.append(details, $('.plm-hidden-list'));
		for (const account of accounts) {
			const row = dom.append(list, $('.plm-hidden-row'));
			dom.append(row, $('.plm-hidden-mail')).textContent = account.email ?? account.homeLabel ?? account.id;
			if (account.provider === 'codex' && account.homeLabel) {
				dom.append(row, $('.plm-hidden-home')).textContent = account.homeLabel;
			}
			const unhideButton = dom.append(row, $('button.plm-hidden-unhide')) as HTMLButtonElement;
			unhideButton.type = 'button';
			unhideButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.eye)}`));
			dom.append(unhideButton, $('span')).textContent = localize('paradis.limitsMonitor.unhideAccount', "再表示");
			this._bodyListeners.add(dom.addDisposableListener(unhideButton, 'click', () => this.options.onToggleHiddenAccount(account)));
		}
	}

	/** @param remoteHost SSH の接続先の Claude のログイン（読み取り専用。手元の操作は出さない）。 */
	private renderAccount(parent: HTMLElement, account: IParadisLimitsAccount, remoteHost = false): void {
		const card = dom.append(parent, $('.plm-account'));
		const top = dom.append(card, $('.plm-account-top'));
		const name = account.email ?? account.homeLabel ?? account.id;
		// 取りに行くのを控えている間も、前に取れた値があれば薄く出す（そのカードは縮めない）。
		const previous = paradisLimitsPreviousValue(account, Date.now());
		// 取得できていないカードは1行に縮め、理由とボタンは開いたときだけ出す（同じ説明文が何枚も並ばないように）。
		const compact = account.status === 'unavailable' && !remoteHost && !previous;
		const compactKey = `${account.provider}:${account.id}`;
		const expanded = compact && this._expandedCompactCards.has(compactKey);
		if (compact) {
			card.classList.add('compact');
			card.classList.toggle('expanded', expanded);
			const toggle = dom.append(top, $('button.plm-account-toggle')) as HTMLButtonElement;
			toggle.type = 'button';
			this.focusTargets.set(`compact:${compactKey}`, toggle);
			toggle.setAttribute('aria-expanded', String(expanded));
			toggle.setAttribute('aria-label', expanded
				? localize('paradis.limitsMonitor.collapseAccount', "{0} の説明を閉じる", name)
				: localize('paradis.limitsMonitor.expandAccount', "{0} の説明を開く", name));
			toggle.appendChild($(`span${ThemeIcon.asCSSSelector(expanded ? Codicon.chevronDown : Codicon.chevronRight)}`));
			dom.append(toggle, $('span.plm-account-mail')).textContent = name;
			this._bodyListeners.add(dom.addDisposableListener(toggle, 'click', () => {
				if (this._expandedCompactCards.has(compactKey)) {
					this._expandedCompactCards.delete(compactKey);
				} else {
					this._expandedCompactCards.add(compactKey);
				}
				this.redraw();
			}));
		} else {
			dom.append(top, $('.plm-account-mail')).textContent = name;
		}

		// バッジとアイコンボタンを1つの列にまとめて右寄せする。全部をここに集めて高さを
		// 揃えることで、以前バッジと削除ボタンの縦位置が微妙にずれて見えていた問題を避ける。
		const badgeGroup = dom.append(top, $('.plm-badge-group'));

		if (account.provider === 'codex' && account.homeLabel) {
			dom.append(badgeGroup, $('.plm-badge')).textContent = account.homeLabel;
		}
		if (account.active) {
			dom.append(badgeGroup, $('.plm-badge.active')).textContent = localize('paradis.limitsMonitor.activeBadge', "使用中");
		}
		if (account.duplicateHomeLabels?.length) {
			const duplicateBadge = dom.append(badgeGroup, $('.plm-badge.duplicate'));
			duplicateBadge.textContent = localize('paradis.limitsMonitor.duplicateBadge', "重複");
			this._bodyListeners.add(this.hoverService.setupManagedHover(
				this.hoverDelegate,
				duplicateBadge,
				localize('paradis.limitsMonitor.duplicateHomes', "同じアカウント: {0}", account.duplicateHomeLabels.join(', ')),
			));
		}
		if (account.status !== 'ok') {
			// 'unavailable'（読めていないだけ）と 'refreshing'（Claude Codeが自動で更新する）は
			// 認証の問題ではないので、赤いエラーバッジも「再ログイン…」も出さない。
			const badgeClass = paradisLimitsNeedsRelogin(account.status) ? '.plm-badge.err' : '.plm-badge';
			dom.append(badgeGroup, $(badgeClass)).textContent = previous
				? localize('paradis.limitsMonitor.previousValueBadge', "前回の値")
				: this.statusBadgeLabel(account.status);
		}

		const actions = dom.append(badgeGroup, $('.plm-account-actions'));
		// 接続先のログインのカードは1枚だけなので隠せないようにする（隠すと Claude の欄が空になり、
		// 「非表示中」からしか戻せない）。
		if (!remoteHost) {
			const hideLabel = localize('paradis.limitsMonitor.hideAccount', "{0} を一覧から隠す", account.email ?? account.homeLabel ?? account.id);
			const hideButton = dom.append(actions, $('button.plm-account-icon-btn.plm-account-hide')) as HTMLButtonElement;
			hideButton.type = 'button';
			hideButton.setAttribute('aria-label', hideLabel);
			// 再表示ボタン(非表示中リスト側)と対にする: 「隠す」はeyeClosed、「再表示」はeye。
			hideButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.eyeClosed)}`));
			this._bodyListeners.add(dom.addDisposableListener(hideButton, 'click', () => this.options.onToggleHiddenAccount(account)));
			this._bodyListeners.add(this.hoverService.setupManagedHover(this.hoverDelegate, hideButton, hideLabel));
		}

		// Claude は Para Code に登録したものだけ登録を消せる（この PC のログインには触らない）。
		if ((account.provider === 'codex' && account.removable) || (account.provider === 'claude' && account.managed)) {
			const removeButton = dom.append(actions, $('button.plm-account-icon-btn.plm-account-delete')) as HTMLButtonElement;
			removeButton.type = 'button';
			const removeLabel = account.provider === 'claude'
				? localize('paradis.limitsMonitor.unregisterAccount', "{0} の登録を削除", account.email ?? account.id)
				: localize('paradis.limitsMonitor.removeAccount', "{0} を削除", account.homeLabel ?? account.email ?? account.id);
			removeButton.setAttribute('aria-label', removeLabel);
			removeButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.trash)}`));
			this._bodyListeners.add(dom.addDisposableListener(removeButton, 'click', e => {
				e.preventDefault();
				this.options.onRemoveAccount(account);
			}));
			this._bodyListeners.add(this.hoverService.setupManagedHover(this.hoverDelegate, removeButton, removeLabel));
		}

		if (compact && !expanded) {
			return;
		}
		if (previous) {
			this.renderMeters(card, account, true);
			dom.append(card, $('.plm-card-stale')).textContent = this.previousValueNote(previous);
		} else if (account.status !== 'ok') {
			const errorRow = dom.append(card, $('.plm-error-row'));
			// Claude の登録していないログインは Para Code からは直せない（ターミナルで claude に
			// ログインし直す）。再ログインのボタンは登録したアカウントと Codex にだけ出し、それ以外は
			// 直し方を文で案内する。
			const canRelogin = !remoteHost && (account.provider === 'codex' || account.managed === true);
			dom.append(errorRow, $('span')).textContent = remoteHost
				? this.remoteHostStatusMessage(account)
				: paradisLimitsNeedsRelogin(account.status) && !canRelogin
					? localize('paradis.limitsMonitor.claudeLiveRelogin', "ターミナルで claude を起動し、/login でログインし直してください")
					: this.statusMessage(account);
			if (paradisLimitsNeedsRelogin(account.status) && canRelogin) {
				const reloginButton = dom.append(errorRow, $('button.plm-relogin-btn'));
				reloginButton.setAttribute('type', 'button');
				reloginButton.textContent = localize('paradis.limitsMonitor.relogin', "再ログイン…");
				this._bodyListeners.add(dom.addDisposableListener(reloginButton, 'click', () => this.options.onRelogin(account)));
			}
		} else {
			this.renderMeters(card, account, false);
			if (!account.fiveHour && !account.sevenDay && (account.scoped ?? []).length === 0) {
				dom.append(card, $('.plm-error-row')).textContent = localize('paradis.limitsMonitor.noWindows', "使用状況データがありません");
			}
			// Claude はアカウントごとに数分〜十数分おきに取るので、古い値にはそのことを書き添える
			// （パネル下端の「N 秒前に更新」は最後に問い合わせた時刻で、カードの値の古さとは限らない）。
			if (account.provider === 'claude' && account.fetchedAt !== undefined) {
				const minutes = Math.floor((Date.now() - account.fetchedAt) / 60_000);
				if (minutes >= STALE_CARD_MINUTES) {
					dom.append(card, $('.plm-card-stale')).textContent = localize('paradis.limitsMonitor.staleCard', "{0}分前の値", minutes);
				}
			}
		}
		if (!remoteHost) {
			this.renderAccountActions(card, account);
		}
	}

	/** 5時間・7日・モデル別枠のメーター。`previous` は取りに行くのを控えている間の前の値（薄く出す）。 */
	private renderMeters(card: HTMLElement, account: IParadisLimitsAccount, previous: boolean): void {
		const meters = dom.append(card, $('.plm-meters'));
		meters.classList.toggle('previous', previous);
		if (account.fiveHour) {
			this.renderMeter(meters, localize('paradis.limitsMonitor.window5h', "5時間"), account.fiveHour);
		}
		if (account.sevenDay) {
			this.renderMeter(meters, localize('paradis.limitsMonitor.window7d', "7日"), account.sevenDay);
		}
		for (const scoped of account.scoped ?? []) {
			this.renderMeter(meters, scoped.label ?? localize('paradis.limitsMonitor.windowExtra', "追加枠"), scoped);
		}
	}

	/** 前の値に添える一文（「12分前の値・ログインの更新を控えています（claude-swap と共有のため）」）。 */
	private previousValueNote(previous: IParadisLimitsPreviousValue): string {
		const age = this.ageLabel(previous.age);
		switch (previous.cause) {
			case 'shared_with_claude_swap':
				return localize('paradis.limitsMonitor.previousValueSharedWithClaudeSwap', "{0}・ログインの更新を控えています（claude-swap と共有のため）", age);
			case 'same_lineage':
				return localize('paradis.limitsMonitor.previousValueSameLineage', "{0}・ログインの更新は Claude Code に任せています", age);
			case 'not_yet':
				return localize('paradis.limitsMonitor.previousValueNotYet', "{0}・取り直しています", age);
		}
	}

	private ageLabel(age: IParadisLimitsAge): string {
		switch (age.unit) {
			case 'minutes':
				return localize('paradis.limitsMonitor.previousValueMinutes', "{0}分前の値", age.amount);
			case 'hours':
				return localize('paradis.limitsMonitor.previousValueHours', "{0}時間前の値", age.amount);
			case 'days':
				return localize('paradis.limitsMonitor.previousValueDays', "{0}日前の値", age.amount);
		}
	}

	/** 差し込み部品のボタン列。何も足されなければ列ごと消す。 */
	private renderAccountActions(card: HTMLElement, account: IParadisLimitsAccount): void {
		const row = dom.append(card, $('.plm-card-actions'));
		for (const contribution of this.contributions) {
			if (contribution.provider !== account.provider || !contribution.renderAccountActions) {
				continue;
			}
			const disposable = contribution.renderAccountActions(row, account, this.contributionContext);
			if (disposable) {
				this._bodyListeners.add(disposable);
			}
		}
		if (row.childElementCount === 0) {
			row.remove();
		}
	}

	private statusBadgeLabel(status: ParadisLimitsAccountStatus): string {
		switch (status) {
			case 'refreshing':
				return localize('paradis.limitsMonitor.refreshing', "更新待ち");
			case 'relogin_required':
				return localize('paradis.limitsMonitor.reloginRequired', "要再ログイン");
			case 'no_credentials':
				return localize('paradis.limitsMonitor.noCredentials', "認証情報なし");
			case 'unavailable':
				return localize('paradis.limitsMonitor.usageUnavailableBadge', "取得できず");
			case 'error':
				return localize('paradis.limitsMonitor.accountError', "エラー");
			case 'ok':
				return '';
			default: {
				// 状態を増やしたらここがコンパイルエラーになる（無言の誤表示を防ぐ）。
				const exhaustive: never = status;
				return exhaustive;
			}
		}
	}

	/**
	 * SSH の接続先の Claude のログインの状態の説明文。直すのは接続先の Claude Code なので、手元の
	 * 「再ログイン…」ではなく接続先のターミナルでの操作を案内する。
	 */
	private remoteHostStatusMessage(account: IParadisLimitsAccount): string {
		switch (account.status) {
			case 'refreshing':
				// Claude Code は動いている間しかトークンを更新しない。「待てば直る」とは書かない。
				return localize('paradis.limitsMonitor.claudeHostRefreshing', "アクセストークンの期限が切れています。接続先で claude を起動すると Claude Code が更新し、表示が戻ります");
			case 'relogin_required':
			case 'no_credentials':
				return localize('paradis.limitsMonitor.claudeHostRelogin', "接続先のターミナルで claude を起動し、/login でログインし直してください");
			case 'unavailable':
				switch (account.unavailableReason) {
					case 'host_not_logged_in':
						return localize('paradis.limitsMonitor.claudeHostNotLoggedIn', "接続先に Claude のサブスクリプションのログインが見つかりません。接続先で使うときは、接続先のターミナルで claude を起動し /login でログインすると表示されます（API キーで使っている場合は表示できません）");
					case 'host_fetch_failed':
						return account.statusDetail
							? localize('paradis.limitsMonitor.claudeHostFetchFailedDetail', "接続先から使用量を取得できていません（{0}）。しばらくしてから取り直します", account.statusDetail)
							: localize('paradis.limitsMonitor.claudeHostFetchFailed', "接続先から使用量を取得できていません。しばらくしてから取り直します");
					case 'keychain_unavailable':
						return localize('paradis.limitsMonitor.claudeHostKeychain', "接続先では Claude のログインが macOS のキーチェーンに保存されているため、SSH 越しには読み取れません");
					default:
						// 取得回数の上限などによる一時的なもの。手元と同じ説明にする。
						return this.statusMessage(account);
				}
			case 'error':
				return this.statusMessage(account);
			case 'ok':
				return '';
			default: {
				const exhaustive: never = account.status;
				return exhaustive;
			}
		}
	}

	/**
	 * 状態の説明文。
	 *
	 * 以前は取得元の状態の生値（'unavailable' 等）をそのまま出していたため、
	 * 制限に到達しただけのアカウントが英語のエラーとして並んでいた。
	 */
	private statusMessage(account: IParadisLimitsAccount): string {
		switch (account.status) {
			case 'refreshing':
				return localize('paradis.limitsMonitor.refreshingDetail', "アクセストークンの期限が切れています。Claude Code が自動で更新するので、操作は要りません");
			case 'unavailable':
				switch (account.unavailableReason) {
					case 'api_key':
						return localize('paradis.limitsMonitor.apiKeyAccount', "APIキーで利用しているアカウントのため、サブスクリプションの使用状況はありません");
					case 'keychain_unavailable':
						return localize('paradis.limitsMonitor.keychainUnavailable', "キーチェーンを読み取れないため、使用状況を取得できません。しばらくしてからお試しください");
					case 'rate_limited':
						return localize('paradis.limitsMonitor.rateLimited', "使用状況の取得回数が上限に達したため、しばらく待ってから取り直します");
					default:
						// 'not_fetched' は statusDetail に本当の理由が入る（取りに行くのを控えている・まだ取れていない）。
						switch (paradisLimitsNotFetchedCause(account.statusDetail)) {
							case 'shared_with_claude_swap':
								return localize('paradis.limitsMonitor.notFetchedSharedWithClaudeSwap', "claude-swap と同じログインを共有している可能性があるため、ログインの更新を控えています（更新すると claude-swap 側のログインが使えなくなるため）。このアカウントを使うと表示されます");
							case 'same_lineage':
								return localize('paradis.limitsMonitor.notFetchedSameLineage', "いまのログインと同じトークンを使っているため、ログインの更新は Claude Code に任せています。更新されると表示されます");
							case 'not_yet':
								return localize('paradis.limitsMonitor.notFetchedYet', "使用状況をまだ取得していません。順に取りに行くので、しばらくすると表示されます");
						}
				}
			case 'no_credentials':
				return localize('paradis.limitsMonitor.noCredentialsDetail', "認証情報が見つかりません。再ログインしてください");
			case 'error':
				// Codex側は原因(HTTPエラー等)を statusDetail に入れるので、あればそれを見せる。
				return account.statusDetail ?? localize('paradis.limitsMonitor.fetchFailed', "使用状況を取得できませんでした");
			case 'relogin_required':
				return localize('paradis.limitsMonitor.reloginNeeded', "再ログインが必要です");
			case 'ok':
				return '';
			default: {
				// 状態を増やしたらここがコンパイルエラーになる。既定を「再ログインが必要」に
				// しておくと、操作不要な新状態を足したときに今回直した誤報がそのまま再発する。
				const exhaustive: never = account.status;
				return exhaustive;
			}
		}
	}

	/**
	 * 枠ごとに「使用率」と「リセットまで」を並べる。
	 *
	 * 以前は5時間枠・7日枠・モデル別枠を混ぜて「最も近い1つ」だけをカード右肩に枠名なしで
	 * 出していたため、表示された残り時間がどの制限のものか分からなかった（アカウントによって
	 * 5時間枠を指したり7日枠を指したりする）。使用率0%の枠は候補から外れるので、使っていない
	 * 枠のリセット時刻は永久に見えなかった。
	 */
	private renderMeter(container: HTMLElement, label: string, window: IParadisLimitsWindow): void {
		const meter = dom.append(container, $('.plm-meter'));
		dom.append(meter, $('.plm-meter-label')).textContent = label;
		const track = dom.append(meter, $('.plm-meter-track'));
		const fill = dom.append(track, $('.plm-meter-fill'));
		const view = paradisLimitsWindowView(window, Date.now());
		if (view.kind === 'reset') {
			// リセット時刻を過ぎた枠は、取り直すまで今の使用率が分からない。古い使用率は出さない。
			fill.style.clipPath = 'inset(0 100% 0 0)';
			dom.append(meter, $('.plm-meter-value'));
			dom.append(meter, $('.plm-meter-reset')).textContent = localize('paradis.limitsMonitor.windowResetUnknown', "リセット済み（今の値は不明）");
			return;
		}
		const percent = Math.min(100, Math.max(0, view.percent));
		// widthではなくclip-pathで切り取る(理由はCSSの.plm-meter-fillコメント参照:
		// グラデーションの描画自体をトラック全幅基準に保ち、塗り幅で色が変わるようにするため)。
		fill.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
		const severity = paradisLimitsSeverity(window.usedPercent);
		if (severity !== 'normal') {
			fill.classList.add(severity);
		}
		// 「使用」は隣のバーがある以上冗長で、リセット列の幅を圧迫するだけなので付けない。
		dom.append(meter, $('.plm-meter-value')).textContent = localize('paradis.limitsMonitor.percentValue', "{0}%", Math.round(window.usedPercent));
		// .plm-meterはdisplay:contentsで親.plm-metersの4列gridへ直接並ぶため、この4番目の
		// セルは常に作る。条件付きで省くとgridの自動配置はセルを飛ばさないので、以降の行が
		// 丸ごと1列ずれる(枠名の下にバー、バーの下に%が来る)。textContentだけ出し分ける。
		const resetCell = dom.append(meter, $('.plm-meter-reset'));
		// 絶対時刻(「9/1 03:00」のような表示)は相対のカウントダウンがあれば冗長なので出さない。
		if (view.countdown !== undefined) {
			resetCell.textContent = localize('paradis.limitsMonitor.resetIn', "{0}後", view.countdown);
		}
	}
}
