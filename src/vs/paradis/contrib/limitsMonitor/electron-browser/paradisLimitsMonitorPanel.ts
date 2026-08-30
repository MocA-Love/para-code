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

import './media/paradisLimitsMonitor.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import {
	IParadisLimitsAccount,
	IParadisLimitsProviderSnapshot,
	IParadisLimitsSnapshot,
	IParadisLimitsWindow,
	paradisLimitsFormatCountdown,
	paradisLimitsNeedsRelogin,
	paradisLimitsSeverity,
	ParadisLimitsAccountStatus,
	ParadisLimitsProvider
} from '../common/paradisLimitsMonitor.js';
import { appendParadisLimitsLogo } from './paradisLimitsLogos.js';

const $ = dom.$;

const PANEL_WIDTH = 400;

export interface IParadisLimitsMonitorPanelOptions {
	readonly initialSnapshot: IParadisLimitsSnapshot | undefined;
	readonly onManualRefresh: () => void;
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

	constructor(
		private readonly anchor: HTMLElement,
		private readonly options: IParadisLimitsMonitorPanelOptions,
		@ILayoutService layoutService: ILayoutService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();

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
		this.renderBody(snapshot);
		const secondsAgo = Math.max(0, Math.round((Date.now() - snapshot.fetchedAt) / 1000));
		this.updatedElement.textContent = localize('paradis.limitsMonitor.updated', "{0}秒前に更新", secondsAgo);
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
		const left = Math.max(8, Math.min(rect.left, win.innerWidth - PANEL_WIDTH - 8));
		const maxTop = win.innerHeight - 40;
		this.element.style.top = `${Math.min(rect.bottom + 6, maxTop)}px`;
		this.element.style.left = `${left}px`;
	}

	private renderEmpty(message: string): void {
		dom.clearNode(this.bodyElement);
		dom.append(this.bodyElement, $('.plm-empty')).textContent = message;
	}

	private renderBody(snapshot: IParadisLimitsSnapshot | undefined): void {
		if (!snapshot) {
			return;
		}
		this._bodyListeners.clear();
		dom.clearNode(this.bodyElement);

		this.renderProviderSection('claude', localize('paradis.limitsMonitor.claude', "Claude"), snapshot.claude);
		this.renderProviderSection('codex', localize('paradis.limitsMonitor.codex', "Codex"), snapshot.codex);
	}

	private renderProviderSection(provider: ParadisLimitsProvider, title: string, providerSnapshot: IParadisLimitsProviderSnapshot): void {
		const header = dom.append(this.bodyElement, $('.plm-provider-header'));
		appendParadisLimitsLogo(header, provider);
		dom.append(header, $('span')).textContent = title;
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

		if (providerSnapshot.cswapMissing) {
			this.renderCswapGuide();
			return;
		}
		if (providerSnapshot.sourceError) {
			dom.append(this.bodyElement, $('.plm-source-error')).textContent = providerSnapshot.sourceError;
			return;
		}
		if (providerSnapshot.accounts.length === 0) {
			dom.append(this.bodyElement, $('.plm-empty')).textContent = localize('paradis.limitsMonitor.noAccounts', "アカウントが見つかりません");
			return;
		}
		const hiddenAccounts: IParadisLimitsAccount[] = [];
		for (const account of providerSnapshot.accounts) {
			if (this.options.isAccountHidden(account)) {
				hiddenAccounts.push(account);
			} else {
				this.renderAccount(account);
			}
		}
		if (hiddenAccounts.length > 0) {
			this.renderHiddenDisclosure(provider, hiddenAccounts);
		}
	}

	/**
	 * ログイン用(~/.codex)と使用量確認用(~/.codex-2)のように重複しがちな行を削除せず個別に
	 * 隠せるようにする受け皿。隠したアカウントはここへ畳まれ、いつでも再表示できる。
	 */
	private renderHiddenDisclosure(provider: ParadisLimitsProvider, accounts: readonly IParadisLimitsAccount[]): void {
		const details = dom.append(this.bodyElement, $('details.plm-hidden-disclosure')) as HTMLDetailsElement;
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

	/** cswap未検出時のセットアップ案内(OS別のインストールコマンドとコピー導線)。 */
	private renderCswapGuide(): void {
		const guide = dom.append(this.bodyElement, $('.plm-install'));
		dom.append(guide, $('.plm-install-message')).textContent = localize('paradis.limitsMonitor.cswapMissing', "Claude アカウントの表示には claude-swap (cswap) が必要です。ターミナルで以下を実行してください:");

		this.renderCommandRow(guide, 'uv tool install claude-swap');

		// uv自体が未導入のユーザー向けのOS別の導入コマンド
		dom.append(guide, $('.plm-install-hint')).textContent = localize('paradis.limitsMonitor.uvMissing', "uv が未導入の場合:");
		if (isWindows) {
			this.renderCommandRow(guide, 'winget install astral-sh.uv');
		} else if (isMacintosh) {
			this.renderCommandRow(guide, 'brew install uv');
		} else {
			this.renderCommandRow(guide, 'curl -LsSf https://astral.sh/uv/install.sh | sh');
		}

		const settingsHint = dom.append(guide, $('.plm-install-hint'));
		dom.append(settingsHint, $('span')).textContent = localize('paradis.limitsMonitor.cswapInstalled', "インストール済みの場合は、実行ファイルの場所を");
		const settingsLink = dom.append(settingsHint, $('a.plm-install-link'));
		settingsLink.textContent = localize('paradis.limitsMonitor.cswapPathSetting', "設定 (cswapPath)");
		settingsLink.setAttribute('role', 'button');
		this._bodyListeners.add(dom.addDisposableListener(settingsLink, 'click', () => {
			void this.commandService.executeCommand('workbench.action.openSettings', 'paradis.limitsMonitor');
		}));
		dom.append(settingsHint, $('span')).textContent = localize('paradis.limitsMonitor.cswapInstalledSuffix', "で指定できます。");
	}

	/** コピー・ボタン付きのコマンド表示行。 */
	private renderCommandRow(container: HTMLElement, command: string): void {
		const row = dom.append(container, $('.plm-install-command'));
		dom.append(row, $('code')).textContent = command;
		const copyButton = dom.append(row, $('.plm-icon-btn'));
		copyButton.setAttribute('role', 'button');
		copyButton.setAttribute('aria-label', localize('paradis.limitsMonitor.copyCommand', "コマンドをコピー"));
		const icon = copyButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.copy)}`));
		this._bodyListeners.add(dom.addDisposableListener(copyButton, 'click', async () => {
			await this.clipboardService.writeText(command);
			// コピーできたことをアイコンで短時間フィードバックする
			icon.className = ThemeIcon.asClassName(Codicon.check);
			setTimeout(() => { icon.className = ThemeIcon.asClassName(Codicon.copy); }, 1200);
		}));
	}

	private renderAccount(account: IParadisLimitsAccount): void {
		const card = dom.append(this.bodyElement, $('.plm-account'));
		const top = dom.append(card, $('.plm-account-top'));
		dom.append(top, $('.plm-account-mail')).textContent = account.email ?? account.homeLabel ?? account.id;

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
			dom.append(badgeGroup, $(badgeClass)).textContent = this.statusBadgeLabel(account.status);
		}

		const actions = dom.append(badgeGroup, $('.plm-account-actions'));
		const hideLabel = localize('paradis.limitsMonitor.hideAccount', "{0} を一覧から隠す", account.email ?? account.homeLabel ?? account.id);
		const hideButton = dom.append(actions, $('button.plm-account-icon-btn.plm-account-hide')) as HTMLButtonElement;
		hideButton.type = 'button';
		hideButton.setAttribute('aria-label', hideLabel);
		// 再表示ボタン(非表示中リスト側)と対にする: 「隠す」はeyeClosed、「再表示」はeye。
		hideButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.eyeClosed)}`));
		this._bodyListeners.add(dom.addDisposableListener(hideButton, 'click', () => this.options.onToggleHiddenAccount(account)));
		this._bodyListeners.add(this.hoverService.setupManagedHover(this.hoverDelegate, hideButton, hideLabel));

		if (account.provider === 'codex' && account.removable) {
			const removeButton = dom.append(actions, $('button.plm-account-icon-btn.plm-account-delete')) as HTMLButtonElement;
			removeButton.type = 'button';
			const removeLabel = localize('paradis.limitsMonitor.removeAccount', "{0} を削除", account.homeLabel ?? account.email ?? account.id);
			removeButton.setAttribute('aria-label', removeLabel);
			removeButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.trash)}`));
			this._bodyListeners.add(dom.addDisposableListener(removeButton, 'click', e => {
				e.preventDefault();
				this.options.onRemoveAccount(account);
			}));
			this._bodyListeners.add(this.hoverService.setupManagedHover(this.hoverDelegate, removeButton, removeLabel));
		}

		if (account.status !== 'ok') {
			const errorRow = dom.append(card, $('.plm-error-row'));
			dom.append(errorRow, $('span')).textContent = this.statusMessage(account);
			if (paradisLimitsNeedsRelogin(account.status)) {
				const reloginButton = dom.append(errorRow, $('button.plm-relogin-btn'));
				reloginButton.setAttribute('type', 'button');
				reloginButton.textContent = localize('paradis.limitsMonitor.relogin', "再ログイン…");
				this._bodyListeners.add(dom.addDisposableListener(reloginButton, 'click', () => this.options.onRelogin(account)));
			}
			return;
		}

		const meters = dom.append(card, $('.plm-meters'));
		if (account.fiveHour) {
			this.renderMeter(meters, localize('paradis.limitsMonitor.window5h', "5時間"), account.fiveHour);
		}
		if (account.sevenDay) {
			this.renderMeter(meters, localize('paradis.limitsMonitor.window7d', "7日"), account.sevenDay);
		}
		for (const scoped of account.scoped ?? []) {
			this.renderMeter(meters, scoped.label ?? localize('paradis.limitsMonitor.windowExtra', "追加枠"), scoped);
		}
		if (!account.fiveHour && !account.sevenDay && (account.scoped ?? []).length === 0) {
			dom.append(card, $('.plm-error-row')).textContent = localize('paradis.limitsMonitor.noWindows', "使用状況データがありません");
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
	 * 状態の説明文。
	 *
	 * 以前は cswap の usageStatus 生値（'unavailable' 等）をそのまま出していたため、
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
					default:
						// 制限到達で取得が止まっている場合が多いが、通信断や取得失敗でも同じ状態になる。
						return localize('paradis.limitsMonitor.usageUnavailable', "使用状況を一時的に取得できていません（制限に達したアカウントは、枠がリセットされるまで取得を止めるため、この表示になることがあります）");
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
		const percent = Math.min(100, Math.max(0, window.usedPercent));
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
		const countdown = paradisLimitsFormatCountdown(window.resetsAt, Date.now());
		if (countdown !== undefined) {
			resetCell.textContent = localize('paradis.limitsMonitor.resetIn', "{0}後", countdown);
		}
	}
}
