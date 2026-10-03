/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量パネルの Codex のアカウントカードに出す操作（limitsMonitor の
// paradisLimitsPanelContributions.ts の部品）。カード下端の右寄せの列へ次を並べる。
//
//  - リセットクレジット: 残数と期限、「使う…」ボタン（押すと確認ダイアログ）。二重消費は
//    shared process の台帳が防ぐ（ここでの押下中フラグは見た目のためだけ）。残りが2回以上なら「期限」で
//    1件ごとの期限の一覧を開け、一覧の行の「使う…」でどのリセットを使うかを選べる（`credit_id` で送る）
//  - 切替: 「このアカウントを使う」ボタン、または「使用中」バッジ。使用率を見比べてから選べるよう
//    カードの上に置く。選んだアカウントは、すべてのウィンドウで新しく開くターミナルから使われる
//
// 部品はパネルを開くたびに作られ、閉じると破棄される。残数と選択は shared process 側が
// キャッシュしている。残りの読み取りは HTTP で、app-server を起こすのは「使う…」を押したときだけ。
// SSH の接続先を開いているウィンドウでは、パネルが並べる接続先のホームについて、接続先（REH）の
// 選択と台帳を使う（クライアントが接続先のチャネルを呼ぶ）。選んだアカウントは、同じ接続先を開いた
// すべてのウィンドウで、接続先に新しく開くターミナルから使われる。

import * as dom from '../../../../base/browser/dom.js';
import { timeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { language } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisLimitsAccount } from '../../limitsMonitor/common/paradisLimitsMonitor.js';
import { IParadisLimitsPanelContext, IParadisLimitsPanelContribution, ParadisLimitsPanelContributions } from '../../limitsMonitor/electron-browser/paradisLimitsPanelContributions.js';
import {
	IParadisCodexAccountsState,
	IParadisCodexResetConsumeResult,
	IParadisCodexResetCreditOffer,
	IParadisCodexResetSummary,
	paradisCalendarDayOffset,
	paradisCodexChosenCreditStillAvailable,
	paradisCodexResetCreditRows,
	ParadisCodexResetCreditRow,
	paradisCodexResetSummary,
	paradisSelectedCodexHome,
	ParadisCodexResetOutcome
} from '../common/paradisCodexAccounts.js';
import { ParadisCodexAccountsClient } from './paradisCodexAccountsClient.js';

const $ = dom.$;

/** 選んだリセットが本当に使われたかを確かめる2回目の読み取りまでの待ち（明細の反映の遅れを見込む）。 */
const CHOSEN_CREDIT_RECHECK_DELAY_MS = 20_000;

class ParadisCodexAccountActions extends Disposable implements IParadisLimitsPanelContribution {

	readonly provider = 'codex';

	private readonly client: ParadisCodexAccountsClient;
	private readonly offers = new Map<string, IParadisCodexResetCreditOffer>();
	private readonly requestedOffers = new Set<string>();
	private accountsState: IParadisCodexAccountsState | undefined;
	private accountsStateRequested = false;
	private readonly consuming = new Set<string>();
	/** 期限の一覧を開いているホーム（描き直しをまたいで持つ）。 */
	private readonly expiriesOpen = new Set<string>();
	private switching = false;
	/** 裏で読んだ結果が届いたら、パネルに描き直してもらうための口（最後に描いたときのもの）。 */
	private context: IParadisLimitsPanelContext | undefined;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
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
		this._register(this.client.onDidChangeState(state => this.setAccountsState(state)));
		this.client.getState().then(state => this.setAccountsState(state), error => {
			this.logService.warn('[ParadisCodexAccounts] failed to read the Codex account selection', error);
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
		if (paradisSelectedCodexHome(state)?.homePath === home.homePath) {
			const badge = dom.append(container, $('span.plm-badge.active'));
			badge.textContent = localize('paradis.codexAccounts.selectedBadge', "使用中");
			badge.title = localize('paradis.codexAccounts.selectedHint', "新しく開くターミナルの Codex はこのアカウントを使います");
			return;
		}
		const button = dom.append(container, $('button.plm-card-action-btn')) as HTMLButtonElement;
		button.type = 'button';
		button.disabled = this.switching;
		button.textContent = this.switching
			? localize('paradis.codexAccounts.switching', "切り替え中…")
			: localize('paradis.codexAccounts.useThisAccount', "このアカウントを使う");
		// SSH のウィンドウの選択は接続先のもので、同じ接続先を開いたウィンドウにだけ効く。
		button.title = this.remoteAgentService.getConnection()
			? localize('paradis.codexAccounts.useThisAccountHintRemote', "この接続先を開いているすべてのウィンドウで、接続先にこれから新しく開くターミナルの Codex がこのアカウントを使います。動いている Codex はそのままです")
			: localize('paradis.codexAccounts.useThisAccountHint', "すべてのウィンドウで、これから新しく開くターミナルの Codex がこのアカウントを使います。動いている Codex はそのままです");
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
		this.readOffer(homePath, false);
	}

	/** 読んで描き直す。読めなければ undefined（ログだけ残す）。 */
	private readOffer(homePath: string, bypassCache: boolean): Promise<IParadisCodexResetCreditOffer | undefined> {
		return this.client.readResetCredits(homePath, bypassCache).then(offer => {
			this.offers.set(homePath, offer);
			this.redraw();
			return offer;
		}, error => {
			this.logService.warn('[ParadisCodexAccounts] failed to read reset credits', error);
			return undefined;
		});
	}

	private renderReset(container: HTMLElement, store: DisposableStore, account: IParadisLimitsAccount): void {
		const offer = this.offers.get(account.id);
		const credits = offer?.credits;
		if (!offer || (!credits && !offer.pendingUnknown)) {
			// 未取得・読めない・リセットクレジットの仕組みが無いアカウントでは何も出さない。
			return;
		}
		// 1行の決まりはモバイルの「リセット 残り N 回 · 次は○○に期限」と同じ（paradisCodexResetSummary）。
		const summary = credits ? paradisCodexResetSummary(credits, Date.now()) : undefined;
		const count = summary?.count ?? 0;
		const rows = credits ? paradisCodexResetCreditRows(credits) : [];
		const listable = summary?.listable === true;
		const note = dom.append(container, $('span.plm-card-action-note'));
		if (offer.pendingUnknown) {
			note.textContent = localize('paradis.codexAccounts.resetPending', "前回のリセットの結果を確認できていません");
		} else if (!summary || count === 0) {
			note.textContent = localize('paradis.codexAccounts.resetNone', "枠のリセット: 残りなし");
			return;
		} else {
			note.textContent = resetSummaryText(summary);
			note.classList.toggle('soon', summary.nextDayOffset !== undefined && summary.nextDayOffset <= 1);
		}
		const open = listable && this.expiriesOpen.has(account.id);
		if (listable) {
			const toggle = dom.append(container, $('button.plm-card-action-link')) as HTMLButtonElement;
			toggle.type = 'button';
			this.context?.trackFocus(toggle, `codex-expiries:${account.id}`);
			toggle.setAttribute('aria-expanded', String(open));
			dom.append(toggle, $('span')).textContent = localize('paradis.codexAccounts.resetExpiries', "期限");
			toggle.appendChild($(`span${ThemeIcon.asCSSSelector(open ? Codicon.chevronUp : Codicon.chevronDown)}`));
			store.add(dom.addDisposableListener(toggle, 'click', () => {
				if (this.expiriesOpen.has(account.id)) {
					this.expiriesOpen.delete(account.id);
				} else {
					this.expiriesOpen.add(account.id);
				}
				this.context?.redraw();
			}));
		}
		const busy = this.consuming.has(account.id);
		const button = dom.append(container, $('button.plm-card-action-btn')) as HTMLButtonElement;
		button.type = 'button';
		button.disabled = busy;
		button.textContent = busy
			? localize('paradis.codexAccounts.resetBusy', "リセット中…")
			: offer.pendingUnknown
				? localize('paradis.codexAccounts.resetRetry', "結果を確認…")
				: localize('paradis.codexAccounts.resetUse', "使う…");
		store.add(dom.addDisposableListener(button, 'click', () => void this.consume(account, undefined)));
		if (open) {
			this.renderExpiries(container, store, account, rows, busy || offer.pendingUnknown === true);
		}
	}

	/**
	 * 1件ごとの期限の一覧（期限の早い順）。今日・明日に切れるものは目立たせる。ID の分かる行には
	 * 「使う…」を置き、その1件を選んで使えるようにする。結果の分からない前回の要求があるときは置かない
	 * （次の操作はその要求の再送になるため）。
	 */
	private renderExpiries(container: HTMLElement, store: DisposableStore, account: IParadisLimitsAccount, rows: readonly ParadisCodexResetCreditRow[], disabled: boolean): void {
		const list = dom.append(container, $('ol.plm-reset-expiries'));
		const now = Date.now();
		for (const row of rows) {
			const item = dom.append(list, $('li.plm-reset-expiry'));
			const label = dom.append(item, $('span.plm-reset-expiry-label'));
			const when = dom.append(item, $('span.plm-reset-expiry-when'));
			switch (row.kind) {
				case 'dated': {
					label.textContent = localize('paradis.codexAccounts.resetExpiryUntil', "{0} まで", formatDateTime(row.expiresAt));
					const days = paradisCalendarDayOffset(row.expiresAt, now);
					when.textContent = relativeDayLabel(days);
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
			if (row.kind !== 'unknown' && row.id !== undefined && !disabled) {
				const creditId = row.id;
				const use = dom.append(item, $('button.plm-card-action-btn.plm-reset-expiry-use')) as HTMLButtonElement;
				use.type = 'button';
				this.context?.trackFocus(use, `codex-expiry-use:${account.id}:${creditId}`);
				use.textContent = localize('paradis.codexAccounts.resetUseThis', "使う…");
				use.setAttribute('aria-label', row.kind === 'dated'
					? localize('paradis.codexAccounts.resetUseThisDatedAria', "{0} までのリセットを使う", formatDateTime(row.expiresAt))
					: localize('paradis.codexAccounts.resetUseThisNoExpiryAria', "期限の無いリセットを使う"));
				store.add(dom.addDisposableListener(use, 'click', () => void this.consume(account, { id: creditId, expiresAt: row.kind === 'dated' ? row.expiresAt : undefined })));
			}
		}
	}

	/** @param credit 期限の一覧で選んだ1件。undefined ならどれを使うかを指定しない（今までどおり）。 */
	private async consume(account: IParadisLimitsAccount, credit: { readonly id: string; readonly expiresAt: number | undefined } | undefined): Promise<void> {
		const homePath = account.id;
		const offer = this.offers.get(homePath);
		if (!offer || this.consuming.has(homePath) || (!offer.offerRevision && !offer.pendingUnknown)) {
			return;
		}
		// 結果の分からない前回の要求があるときは、選んだものではなくその要求を送り直す（一覧の「使う…」は出していない）。
		const chosen = offer.pendingUnknown ? undefined : credit;
		const name = account.email ?? account.homeLabel ?? homePath;
		const { confirmed } = await this.dialogService.confirm({
			type: Severity.Warning,
			message: offer.pendingUnknown
				? localize('paradis.codexAccounts.resetConfirmRetry', "前回のリセットの結果を確認しますか？")
				: chosen === undefined
					? localize('paradis.codexAccounts.resetConfirm', "Codex の枠のリセットを1回使いますか？")
					: chosen.expiresAt !== undefined
						? localize('paradis.codexAccounts.resetConfirmChosen', "{0} までのリセットを使いますか？", formatDateTime(chosen.expiresAt))
						: localize('paradis.codexAccounts.resetConfirmChosenNoExpiry', "期限の無いリセットを使いますか？"),
			detail: offer.pendingUnknown
				? localize('paradis.codexAccounts.resetConfirmRetryDetail', "{0} で前回送ったリセットの要求を、同じ内容でもう一度送ります。前回すでに使われていた場合、2回目は使われません。", name)
				: localize('paradis.codexAccounts.resetConfirmDetail', "{0} のリセットを1回使い、使い切った Codex の使用枠をすぐに戻します。使い切った枠が無いときは使われません。取り消せません。", name),
			primaryButton: offer.pendingUnknown
				? localize({ key: 'paradis.codexAccounts.resetConfirmRetryButton', comment: ['&& denotes a mnemonic'] }, "送り直す(&&R)")
				: localize({ key: 'paradis.codexAccounts.resetConfirmButton', comment: ['&& denotes a mnemonic'] }, "使う(&&U)"),
		});
		if (!confirmed || this.consuming.has(homePath)) {
			return;
		}
		this.consuming.add(homePath);
		this.redraw();
		let result: IParadisCodexResetConsumeResult | undefined;
		try {
			result = await this.client.consumeResetCredit({ homePath, offerRevision: offer.offerRevision ?? '', idempotencyKey: generateUuid(), offerFetchedAt: offer.fetchedAt, ...(chosen !== undefined ? { creditId: chosen.id } : {}) });
		} catch (error) {
			this.logService.warn('[ParadisCodexAccounts] reset credit consume failed', error);
			this.notificationService.error(localize('paradis.codexAccounts.resetUnknown', "リセットの結果を確認できませんでした。もう一度押すと同じ要求を送り直します（2回使われることはありません）。"));
		} finally {
			this.consuming.delete(homePath);
		}
		if (result) {
			this.notifyResult(result, name);
		}
		// 残数を読み直し、使用枠のメーターも取り直してもらう。
		const reread = this.readOffer(homePath, true);
		if (!this._store.isDisposed) {
			this.context?.requestRefresh(true);
		}
		if (chosen !== undefined && result?.kind === 'consumed' && result.outcome === 'reset' && !result.resentPrevious) {
			// 選んだものがまだ残っているなら、別のリセットが使われた可能性がある（バックエンドが ID を見なかった等）。
			// 使った直後の明細はまだ古いことがあるので、少し待ってからもう一度読み、それでも残っていたときだけ知らせる。
			await reread;
			await timeout(CHOSEN_CREDIT_RECHECK_DELAY_MS);
			if (this._store.isDisposed) {
				// パネルを閉じた（部品が破棄された）。読み直しも描き直しもしない。
				return;
			}
			if (paradisCodexChosenCreditStillAvailable((await this.readOffer(homePath, true))?.credits, chosen.id)) {
				this.notificationService.warn(localize('paradis.codexAccounts.resetChosenStillThere', "{0} で、選んだリセットではなく別のものが使われた可能性があります。数分後に期限の一覧でもう一度確かめてください。", name));
			}
		}
	}

	private notifyResult(result: IParadisCodexResetConsumeResult, name: string): void {
		if (result.kind === 'consumed') {
			const message = result.resentPrevious
				? localize('paradis.codexAccounts.resetResentPrevious', "選んだリセットは使わず、結果を確認できていなかった前回の要求を送り直しました。{0}", outcomeMessage(result.outcome, name))
				: outcomeMessage(result.outcome, name);
			this.notificationService.notify({ severity: result.outcome === 'reset' || result.outcome === 'alreadyRedeemed' ? Severity.Info : Severity.Warning, message });
			return;
		}
		switch (result.reason) {
			case 'offerChanged':
				this.notificationService.info(localize('paradis.codexAccounts.resetOfferRenewed', "内容が新しくなりました。もう一度確かめてください。"));
				return;
			case 'alreadyAttempted':
				this.notificationService.info(localize('paradis.codexAccounts.resetOfferChanged', "リセットの残りが変わっていました（別の画面で使われた可能性があります）。最新の内容を読み直したので、もう一度確かめてください。"));
				return;
			case 'unknownHome':
				this.notificationService.error(localize('paradis.codexAccounts.resetUnknownHome', "このアカウントの Codex フォルダが見つかりません。"));
				return;
			case 'ledgerUnavailable':
				this.notificationService.error(localize('paradis.codexAccounts.resetLedgerUnavailable', "二重に使わないための記録を読めないため、リセットを止めました。"));
				return;
		}
	}
}

function outcomeMessage(outcome: ParadisCodexResetOutcome, name: string): string {
	switch (outcome) {
		case 'reset':
			return localize('paradis.codexAccounts.resetDone', "{0} の Codex の使用枠をリセットしました。", name);
		case 'alreadyRedeemed':
			return localize('paradis.codexAccounts.resetAlreadyDone', "{0} のリセットは既に使われていました（使用枠は戻っています）。", name);
		case 'nothingToReset':
			return localize('paradis.codexAccounts.resetNothing', "{0} には使い切った使用枠が無いため、リセットは使われませんでした。", name);
		case 'noCredit':
			return localize('paradis.codexAccounts.resetNoCredit', "{0} には使えるリセットが残っていませんでした。", name);
	}
}

/**
 * メーターの下のリセットの1行（モバイルの `resetCreditsSummary` と同じ決まり）。
 * 「残り 4 回 · 次は今日 11:12 に期限」「残り 1 回 · 10/20 21:45 に期限」「残り 1 回 · 期限なし」「残り 3 回」。
 */
function resetSummaryText(summary: IParadisCodexResetSummary): string {
	if (summary.nextExpiresAt !== undefined) {
		const when = expiryWhen(summary.nextExpiresAt, summary.nextDayOffset ?? 2);
		return summary.count === 1
			? localize('paradis.codexAccounts.resetOneWithExpiry', "枠のリセット: 残り 1 回 · {0} に期限", when)
			: localize('paradis.codexAccounts.resetNextExpiry', "枠のリセット: 残り {0} 回 · 次は{1} に期限", summary.count, when);
	}
	if (summary.count === 1 && summary.hasNoExpiry) {
		return localize('paradis.codexAccounts.resetOneNoExpiry', "枠のリセット: 残り 1 回 · 期限なし");
	}
	return localize('paradis.codexAccounts.resetAvailable', "枠のリセット: 残り {0} 回", summary.count);
}

/** 期限の「今日 11:12」「明日 08:00」「10/9 08:00」（今日・明日だけ言葉にする）。 */
function expiryWhen(epochMs: number, dayOffset: number): string {
	if (dayOffset === 0) {
		return localize('paradis.codexAccounts.resetWhenToday', "今日 {0}", formatTime(epochMs));
	}
	if (dayOffset === 1) {
		return localize('paradis.codexAccounts.resetWhenTomorrow', "明日 {0}", formatTime(epochMs));
	}
	return formatDateTime(epochMs);
}

function formatTime(epochMs: number): string {
	try {
		return new Date(epochMs).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
	} catch {
		return new Date(epochMs).toLocaleTimeString();
	}
}

/** 期限が暦の上で何日後か（「今日」「明日」「N 日後」。過ぎていれば「期限切れ」）。 */
function relativeDayLabel(days: number): string {
	if (days < 0) {
		return localize('paradis.codexAccounts.resetExpired', "期限切れ");
	}
	if (days === 0) {
		return localize('paradis.codexAccounts.resetToday', "今日");
	}
	if (days === 1) {
		return localize('paradis.codexAccounts.resetTomorrow', "明日");
	}
	return localize('paradis.codexAccounts.resetInDays', "{0}日後", days);
}

function formatDateTime(epochMs: number): string {
	try {
		return new Date(epochMs).toLocaleString(language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	} catch {
		return new Date(epochMs).toLocaleString();
	}
}

ParadisLimitsPanelContributions.register(ParadisCodexAccountActions);
