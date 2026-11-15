/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量パネルの Codex のアカウントカードに出す操作（limitsMonitor の
// paradisLimitsPanelContributions.ts の部品）。
//
//  - リセットクレジット（カード下端の左）: 残数と次の期限のリンク1つ。押すと期限ごとの一覧が開く。
//    見せるだけで、使う操作は持たない（Codex 本体・ChatGPT から使う）
//  - 切替（カード下端の右）: 「切り替える」ボタンと「新しいターミナルから」の添え書き。使っているアカウントは
//    ボタンの代わりに右上へ「使用中」バッジを出す。選んだアカウントは、すべてのウィンドウで新しく開くターミナルから使われる
//
// 部品はパネルを開くたびに作られ、閉じると破棄される。残数と選択は shared process 側が
// キャッシュしている。残りの読み取りは HTTP で、app-server は起こさない。
// SSH の接続先を開いているウィンドウでは、パネルが並べる接続先のホームについて、接続先（REH）の
// 選択と読み取りを使う（クライアントが接続先のチャネルを呼ぶ）。選んだアカウントは、同じ接続先を開いた
// すべてのウィンドウで、接続先に新しく開くターミナルから使われる。

import * as dom from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { paradisFormatLimitsDateTime, paradisLimitsCalendarDayOffset, paradisLimitsExpiryWhen, paradisLimitsRelativeDayLabel } from '../../limitsMonitor/common/paradisLimitsDates.js';
import { IParadisLimitsAccount } from '../../limitsMonitor/common/paradisLimitsMonitor.js';
import { IParadisLimitsPanelContext, IParadisLimitsPanelContribution, ParadisLimitsPanelContributions } from '../../limitsMonitor/electron-browser/paradisLimitsPanelContributions.js';
import {
	IParadisCodexAccountsState,
	IParadisCodexResetCreditOffer,
	IParadisCodexResetSummary,
	paradisCodexResetCreditRows,
	ParadisCodexResetCreditRow,
	paradisCodexResetSummary,
	paradisSelectedCodexHome
} from '../common/paradisCodexAccounts.js';
import { ParadisCodexAccountsClient } from './paradisCodexAccountsClient.js';

const $ = dom.$;

class ParadisCodexAccountActions extends Disposable implements IParadisLimitsPanelContribution {

	readonly provider = 'codex';

	private readonly client: ParadisCodexAccountsClient;
	private readonly offers = new Map<string, IParadisCodexResetCreditOffer>();
	private readonly requestedOffers = new Set<string>();
	private accountsState: IParadisCodexAccountsState | undefined;
	private accountsStateRequested = false;
	private accountsStateListening = false;
	/** 期限の一覧を開いているホーム（描き直しをまたいで持つ）。 */
	private readonly expiriesOpen = new Set<string>();
	private switching = false;
	/** 裏で読んだ結果が届いたら、パネルに描き直してもらうための口（最後に描いたときのもの）。 */
	private context: IParadisLimitsPanelContext | undefined;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this.client = instantiationService.createInstance(ParadisCodexAccountsClient);
	}

	renderAccountActions(container: HTMLElement, account: IParadisLimitsAccount, context: IParadisLimitsPanelContext): IDisposable | undefined {
		this.context = context;
		this.ensureAccountsState();
		const store = new DisposableStore();
		if (account.status === 'ok') {
			// 認証が切れたアカウントは読み取れないので出さない（カードの「再ログイン…」が先）。
			this.ensureOffer(account.id);
			this.renderReset(container, store, account);
		}
		this.renderSwitch(container, store, account);
		return store;
	}

	renderAccountBadges(container: HTMLElement, account: IParadisLimitsAccount, context: IParadisLimitsPanelContext): IDisposable | undefined {
		this.context = context;
		this.ensureAccountsState();
		const state = this.accountsState;
		if (state && this.isSelected(state, account)) {
			const badge = dom.append(container, $('span.plm-badge.active'));
			badge.textContent = localize('paradis.codexAccounts.selectedBadge', "使用中");
			// 説明は本家のホバーで出す（title 属性は OS が描き、テーマの色にも本家のホバーの待ち時間にもならない）
			return this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), badge, localize('paradis.codexAccounts.selectedHint', "新しく開くターミナルの Codex はこのアカウントを使います"));
		}
		return undefined;
	}

	isAccountSelected(account: IParadisLimitsAccount): boolean {
		this.ensureAccountsState();
		return this.accountsState !== undefined && this.isSelected(this.accountsState, account);
	}

	/**
	 * 新しく開くターミナルで使うホームが、このカードのホームか。同じアカウントの別のホームが選ばれていても
	 * 「使用中」にはしない（そのホームが壊れていても正常に見えてしまうため。まとめたカードはパネルが
	 * 選ばれているホームを代表にする）。
	 */
	private isSelected(state: IParadisCodexAccountsState, account: IParadisLimitsAccount): boolean {
		return paradisSelectedCodexHome(state)?.homePath === account.id;
	}

	/** 裏の読み取りが終わったら描き直してもらう（取り直しはしない）。 */
	private redraw(): void {
		if (!this._store.isDisposed) {
			this.context?.requestRefresh(false);
		}
	}

	// ---------- 切替 ----------

	private ensureAccountsState(): void {
		if (this.accountsStateRequested) {
			return;
		}
		this.accountsStateRequested = true;
		if (!this.accountsStateListening) {
			this.accountsStateListening = true;
			this._register(this.client.onDidChangeState(state => this.setAccountsState(state)));
		}
		this.client.getState().then(state => this.setAccountsState(state), error => {
			this.logService.warn('[ParadisCodexAccounts] failed to read the Codex account selection', error);
			// 共有プロセスの起動直後や SSH のつなぎ直しで 1 回落ちても、次にパネルを描くときに読み直す
			this.accountsStateRequested = false;
		});
	}

	private setAccountsState(state: IParadisCodexAccountsState): void {
		if (this.accountsState && state.selection.revision < this.accountsState.selection.revision) {
			return;
		}
		this.accountsState = state;
		this.redraw();
	}

	private renderSwitch(container: HTMLElement, store: DisposableStore, account: IParadisLimitsAccount): void {
		const state = this.accountsState;
		const home = state?.homes.find(candidate => candidate.homePath === account.id);
		if (!state || !home) {
			// 選択をまだ読めていない・切替の対象にならない（ログインしていない）ホーム。
			return;
		}
		if (this.isSelected(state, account)) {
			// 使っているアカウントは右上の「使用中」で示す（renderAccountBadges）。
			return;
		}
		// 「新しいターミナルから」の注記は常には出さず、ボタンのホバーの説明に任せる。
		const button = dom.append(container, $('button.plm-card-action-btn')) as HTMLButtonElement;
		button.type = 'button';
		button.disabled = this.switching;
		button.textContent = this.switching
			? localize('paradis.codexAccounts.switching', "切り替え中…")
			: localize('paradis.codexAccounts.switchAccount', "切り替える");
		// SSH のウィンドウの選択は接続先のもので、同じ接続先を開いたウィンドウにだけ効く。
		store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), button, this.remoteAgentService.getConnection()
			? localize('paradis.codexAccounts.useThisAccountHintRemote', "この接続先を開いているすべてのウィンドウで、接続先にこれから新しく開くターミナルの Codex がこのアカウントを使います。動いている Codex はそのままです")
			: localize('paradis.codexAccounts.useThisAccountHint', "すべてのウィンドウで、これから新しく開くターミナルの Codex がこのアカウントを使います。動いている Codex はそのままです")));
		store.add(dom.addDisposableListener(button, 'click', () => void this.switchTo(home.isDefault ? undefined : home.homePath)));
	}

	private async switchTo(homePath: string | undefined): Promise<void> {
		if (this.switching) {
			return;
		}
		this.switching = true;
		this.redraw();
		try {
			this.setAccountsState(await this.client.selectHome(homePath));
		} catch (error) {
			this.logService.warn('[ParadisCodexAccounts] failed to switch the Codex account', error);
			this.notificationService.error(localize('paradis.codexAccounts.switchFailed', "Codex のアカウントを切り替えられませんでした。ログインし直してから、もう一度お試しください。"));
		} finally {
			this.switching = false;
			this.redraw();
		}
	}

	// ---------- リセットクレジット ----------

	private ensureOffer(homePath: string): void {
		if (this.requestedOffers.has(homePath)) {
			return;
		}
		this.requestedOffers.add(homePath);
		this.client.readResetCredits(homePath, false).then(offer => {
			this.offers.set(homePath, offer);
			this.redraw();
		}, error => {
			this.logService.warn('[ParadisCodexAccounts] failed to read reset credits', error);
		});
	}

	private renderReset(container: HTMLElement, store: DisposableStore, account: IParadisLimitsAccount): void {
		const credits = this.offers.get(account.id)?.credits;
		if (!credits) {
			// 未取得・読めない・リセットクレジットの仕組みが無いアカウントでは何も出さない。
			return;
		}
		// 1行の決まりはモバイルの「リセット 残り N 回 · 次は○○に期限」と同じ（paradisCodexResetSummary）。
		const now = Date.now();
		const summary = paradisCodexResetSummary(credits, now);
		if (summary.count === 0) {
			dom.append(container, $('span.plm-card-action-note.plm-card-actions-start')).textContent = localize('paradis.codexAccounts.resetNone', "枠のリセット: 残りなし");
			return;
		}
		if (!summary.listable) {
			// 1回だけ・期限の明細が無いときは、開く一覧が無いので1行の文だけ。
			const note = dom.append(container, $('span.plm-card-action-note.plm-card-actions-start'));
			note.classList.toggle('soon', summary.nextDayOffset !== undefined && summary.nextDayOffset <= 1);
			note.textContent = resetSummaryText(summary, now);
			return;
		}
		// 残数と次の期限を1つのリンクにし、押すと期限ごとの一覧を開く。
		const open = this.expiriesOpen.has(account.id);
		const toggle = dom.append(container, $('button.plm-card-action-link.plm-card-actions-start.paradis-focus-ring-inset')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.classList.toggle('soon', summary.nextDayOffset !== undefined && summary.nextDayOffset <= 1);
		this.context?.trackFocus(toggle, `codex-expiries:${account.id}`);
		toggle.setAttribute('aria-expanded', String(open));
		dom.append(toggle, $('span')).textContent = resetSummaryText(summary, now);
		toggle.appendChild($(`span${ThemeIcon.asCSSSelector(open ? Codicon.chevronDown : Codicon.chevronRight)}`));
		store.add(dom.addDisposableListener(toggle, 'click', () => {
			if (this.expiriesOpen.has(account.id)) {
				this.expiriesOpen.delete(account.id);
			} else {
				this.expiriesOpen.add(account.id);
			}
			this.context?.redraw();
		}));
		if (open) {
			this.renderExpiries(container, paradisCodexResetCreditRows(credits), now);
		}
	}

	/** 1件ごとの期限の一覧（期限の早い順）。今日・明日に切れるものは目立たせる。見せるだけで、使うボタンは置かない。 */
	private renderExpiries(container: HTMLElement, rows: readonly ParadisCodexResetCreditRow[], now: number): void {
		const list = dom.append(container, $('ol.plm-reset-expiries'));
		for (const row of rows) {
			const item = dom.append(list, $('li.plm-reset-expiry'));
			const label = dom.append(item, $('span.plm-reset-expiry-label'));
			const when = dom.append(item, $('span.plm-reset-expiry-when'));
			switch (row.kind) {
				case 'dated': {
					label.textContent = localize('paradis.codexAccounts.resetExpiryUntil', "{0} まで", paradisFormatLimitsDateTime(row.expiresAt, now));
					const days = paradisLimitsCalendarDayOffset(row.expiresAt, now);
					when.textContent = paradisLimitsRelativeDayLabel(days);
					item.classList.toggle('soon', days <= 1);
					break;
				}
				case 'noExpiry':
					label.textContent = localize('paradis.codexAccounts.resetExpiryNone', "期限なし");
					break;
				case 'unknown':
					// 一覧は期限の分かる行があるときだけ開けるので、この行はいつも「ほか」になる。
					label.textContent = localize('paradis.codexAccounts.resetExpiryUnknownRest', "ほか {0} 回（期限は不明）", row.count);
					break;
			}
		}
	}
}

/**
 * メーターの下のリセットの1行（モバイルの `resetCreditsSummary` と同じ決まり）。
 * 「残り 4 回 · 次は今日 11:12 に期限」「残り 1 回 · 10/20 21:45 に期限」「残り 1 回 · 期限なし」「残り 3 回」。
 */
function resetSummaryText(summary: IParadisCodexResetSummary, now: number): string {
	if (summary.nextExpiresAt !== undefined) {
		const when = paradisLimitsExpiryWhen(summary.nextExpiresAt, now);
		return summary.count === 1
			? localize('paradis.codexAccounts.resetOneWithExpiry', "枠のリセット: 残り 1 回 · {0} に期限", when)
			: localize('paradis.codexAccounts.resetNextExpiry', "枠のリセット: 残り {0} 回 · 次は{1} に期限", summary.count, when);
	}
	if (summary.count === 1 && summary.hasNoExpiry) {
		return localize('paradis.codexAccounts.resetOneNoExpiry', "枠のリセット: 残り 1 回 · 期限なし");
	}
	return localize('paradis.codexAccounts.resetAvailable', "枠のリセット: 残り {0} 回", summary.count);
}

ParadisLimitsPanelContributions.register(ParadisCodexAccountActions);
