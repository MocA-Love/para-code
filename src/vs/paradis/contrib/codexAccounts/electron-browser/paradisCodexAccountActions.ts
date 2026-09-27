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
//    shared process の台帳が防ぐ（ここでの押下中フラグは見た目のためだけ）
//  - 切替: 「このアカウントを使う」ボタン、または「使用中」バッジ。使用率を見比べてから選べるよう
//    カードの上に置く。選んだアカウントは、すべてのウィンドウで新しく開くターミナルから使われる
//
// 部品はパネルを開くたびに作られ、閉じると破棄される。残数と選択は shared process 側が
// キャッシュしている。残りの読み取りは HTTP で、app-server を起こすのは「使う…」を押したときだけ。
// SSH の接続先を開いているウィンドウでは何も出さない（台帳と選択はこの PC のもの）。

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { language } from '../../../../base/common/platform.js';
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
	paradisSelectedCodexHome,
	ParadisCodexResetOutcome
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
	private readonly consuming = new Set<string>();
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
		// SSH 中のパネルは接続先のホームを並べている。台帳と選択はこの PC のものなので混ぜない。
		if (this.remoteAgentService.getConnection()) {
			return undefined;
		}
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
		button.title = localize('paradis.codexAccounts.useThisAccountHint', "すべてのウィンドウで、これから新しく開くターミナルの Codex がこのアカウントを使います。動いている Codex はそのままです");
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

	private readOffer(homePath: string, bypassCache: boolean): void {
		this.client.readResetCredits(homePath, bypassCache).then(offer => {
			this.offers.set(homePath, offer);
			this.redraw();
		}, error => {
			this.logService.warn('[ParadisCodexAccounts] failed to read reset credits', error);
		});
	}

	private renderReset(container: HTMLElement, store: DisposableStore, account: IParadisLimitsAccount): void {
		const offer = this.offers.get(account.id);
		const credits = offer?.credits;
		if (!offer || (!credits && !offer.pendingUnknown)) {
			// 未取得・読めない・リセットクレジットの仕組みが無いアカウントでは何も出さない。
			return;
		}
		const count = credits?.availableCount ?? 0;
		const note = dom.append(container, $('span.plm-card-action-note'));
		if (offer.pendingUnknown) {
			note.textContent = localize('paradis.codexAccounts.resetPending', "前回のリセットの結果を確認できていません");
		} else if (count === 0) {
			note.textContent = localize('paradis.codexAccounts.resetNone', "枠のリセット: 残りなし");
			return;
		} else if (credits?.nextExpiresAt !== undefined) {
			note.textContent = localize('paradis.codexAccounts.resetAvailableWithExpiry', "枠のリセット: 残り {0} 回（{1} まで）", count, formatDateTime(credits.nextExpiresAt));
		} else {
			note.textContent = localize('paradis.codexAccounts.resetAvailable', "枠のリセット: 残り {0} 回", count);
		}
		const button = dom.append(container, $('button.plm-card-action-btn')) as HTMLButtonElement;
		button.type = 'button';
		const busy = this.consuming.has(account.id);
		button.disabled = busy;
		button.textContent = busy
			? localize('paradis.codexAccounts.resetBusy', "リセット中…")
			: offer.pendingUnknown
				? localize('paradis.codexAccounts.resetRetry', "結果を確認…")
				: localize('paradis.codexAccounts.resetUse', "使う…");
		store.add(dom.addDisposableListener(button, 'click', () => void this.consume(account)));
	}

	private async consume(account: IParadisLimitsAccount): Promise<void> {
		const homePath = account.id;
		const offer = this.offers.get(homePath);
		if (!offer || this.consuming.has(homePath) || (!offer.offerRevision && !offer.pendingUnknown)) {
			return;
		}
		const name = account.email ?? account.homeLabel ?? homePath;
		const { confirmed } = await this.dialogService.confirm({
			type: Severity.Warning,
			message: offer.pendingUnknown
				? localize('paradis.codexAccounts.resetConfirmRetry', "前回のリセットの結果を確認しますか？")
				: localize('paradis.codexAccounts.resetConfirm', "Codex の枠のリセットを1回使いますか？"),
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
			result = await this.client.consumeResetCredit({ homePath, offerRevision: offer.offerRevision ?? '', idempotencyKey: generateUuid() });
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
		this.readOffer(homePath, true);
		if (!this._store.isDisposed) {
			this.context?.requestRefresh(true);
		}
	}

	private notifyResult(result: IParadisCodexResetConsumeResult, name: string): void {
		if (result.kind === 'consumed') {
			this.notificationService.notify({ severity: result.outcome === 'reset' || result.outcome === 'alreadyRedeemed' ? Severity.Info : Severity.Warning, message: outcomeMessage(result.outcome, name) });
			return;
		}
		switch (result.reason) {
			case 'offerChanged':
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

function formatDateTime(epochMs: number): string {
	try {
		return new Date(epochMs).toLocaleString(language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	} catch {
		return new Date(epochMs).toLocaleString();
	}
}

ParadisLimitsPanelContributions.register(ParadisCodexAccountActions);
