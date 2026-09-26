/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量パネル（limitsMonitor）の Codex アカウントカードへ差し込む部品。
//
// パネル本体は別の作業で作り替えが進んでいるので、ここは独立した部品として作り、パネル側からは
// `renderAccountCard(カードの要素, アカウント)` を1回呼ぶだけで済むようにしてある。
// パネルは30秒ごとにDOMを作り直すので、この部品は「手元のキャッシュから同期で描く → 古ければ
// 裏で読み直して、まだ画面にあれば描き直す」を繰り返す。
//
// 表示するもの:
//  - リセットクレジット（残数と期限、「使う…」ボタン。押すと確認ダイアログ）
//  - 切替（「このアカウントを使う」ボタン、または「使用中」バッジ。q.html Q05 案A）。
//    選んだアカウントは新しく開くターミナルから使われる（全ウィンドウ共通、Q07）

import './media/paradisCodexAccountCard.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { language } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisLimitsAccount } from '../../limitsMonitor/common/paradisLimitsMonitor.js';
import { IParadisCodexAccountsState, IParadisCodexResetConsumeResult, IParadisCodexResetCreditOffer, paradisSelectedCodexHome, ParadisCodexResetOutcome } from '../common/paradisCodexAccounts.js';
import { ParadisCodexAccountsClient } from './paradisCodexAccountsClient.js';

const $ = dom.$;

/** renderer 側で読み直す間隔。shared process 側にも同じ長さのキャッシュがある。 */
const OFFER_REFRESH_MS = 3 * 60_000;

export const IParadisCodexAccountCardService = createDecorator<IParadisCodexAccountCardService>('paradisCodexAccountCardService');

export interface IParadisCodexAccountCardService {
	readonly _serviceBrand: undefined;

	/**
	 * Codex アカウントのカード（`container`）の末尾に部品を足す。Codex 以外・SSH 接続中の
	 * ウィンドウでは何もしない。返り値はカードを描き直すときに dispose する。
	 */
	renderAccountCard(container: HTMLElement, account: IParadisLimitsAccount): IDisposable;
}

export class ParadisCodexAccountCardService extends Disposable implements IParadisCodexAccountCardService {
	declare readonly _serviceBrand: undefined;

	private readonly client: ParadisCodexAccountsClient;
	private readonly offers = new Map<string, IParadisCodexResetCreditOffer>();
	private readonly loading = new Set<string>();
	private readonly consuming = new Set<string>();
	/** ホームの表示内容が変わった（描き直してほしい）。 */
	private readonly _onDidChangeHome = this._register(new Emitter<string>());
	/** 切替の状態（全ウィンドウ共通の選択）。初めてカードを描くときに読む。 */
	private accountsState: IParadisCodexAccountsState | undefined;
	private accountsStateRequested = false;
	private switching = false;
	private readonly _onDidChangeAccountsState = this._register(new Emitter<void>());

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

	private ensureAccountsState(): void {
		if (this.accountsStateRequested) {
			return;
		}
		this.accountsStateRequested = true;
		this._register(this.client.onDidChangeState(state => this.setAccountsState(state)));
		this.client.getState().then(state => this.setAccountsState(state), error => {
			this.accountsStateRequested = false;
			this.logService.warn('[ParadisCodexAccounts] failed to read the Codex account selection', error);
		});
	}

	private setAccountsState(state: IParadisCodexAccountsState): void {
		if (this.accountsState && state.selection.revision < this.accountsState.selection.revision) {
			return;
		}
		this.accountsState = state;
		this._onDidChangeAccountsState.fire();
	}

	renderAccountCard(container: HTMLElement, account: IParadisLimitsAccount): IDisposable {
		// SSH 中のパネルは接続先のホームを並べている。台帳と選択はこの PC のものなので混ぜない。
		if (account.provider !== 'codex' || this.remoteAgentService.getConnection()) {
			return Disposable.None;
		}
		const homePath = account.id;
		const store = new DisposableStore();
		const root = dom.append(container, $('.paradis-codex-card'));
		store.add({ dispose: () => root.remove() });

		const resetRow = dom.append(root, $('.pcc-row.pcc-reset'));
		const switchRow = dom.append(root, $('.pcc-row.pcc-switch'));
		// 行ごとにリスナーを持ち直す（描き直すたびに古いボタンのリスナーを捨てる）。
		const resetListeners = store.add(new DisposableStore());
		const switchListeners = store.add(new DisposableStore());
		const renderReset = () => {
			resetListeners.clear();
			if (account.status === 'ok') {
				this.renderResetRow(resetRow, resetListeners, account);
			} else {
				// 認証が切れたアカウントは読み取れないので行ごと出さない（再ログインが先）。
				resetRow.style.display = 'none';
			}
		};
		const renderSwitch = () => {
			switchListeners.clear();
			this.renderSwitchRow(switchRow, switchListeners, account);
		};
		renderReset();
		renderSwitch();
		store.add(this._onDidChangeHome.event(changed => {
			if (changed === homePath && root.isConnected) {
				renderReset();
			}
		}));
		store.add(this._onDidChangeAccountsState.event(() => {
			if (root.isConnected) {
				renderSwitch();
			}
		}));
		this.ensureAccountsState();
		if (account.status === 'ok') {
			this.ensureOffer(homePath, false);
		}
		return store;
	}

	// ---------- 切替 ----------

	private renderSwitchRow(row: HTMLElement, store: DisposableStore, account: IParadisLimitsAccount): void {
		dom.clearNode(row);
		const state = this.accountsState;
		const home = state?.homes.find(candidate => candidate.homePath === account.id);
		if (!state || !home) {
			// 選択をまだ読めていない・切替の対象にならない（ログインしていない）ホーム。
			row.style.display = 'none';
			return;
		}
		row.style.display = '';
		if (paradisSelectedCodexHome(state)?.homePath === home.homePath) {
			dom.append(row, $('span.pcc-text')).textContent = localize('paradis.codexAccounts.selectedHint', "新しく開くターミナルで使います");
			dom.append(row, $('span.pcc-badge')).textContent = localize('paradis.codexAccounts.selectedBadge', "使用中");
			return;
		}
		const button = dom.append(row, $('button.pcc-btn')) as HTMLButtonElement;
		button.type = 'button';
		button.disabled = this.switching;
		button.textContent = localize('paradis.codexAccounts.useThisAccount', "このアカウントを使う");
		store.add(dom.addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.switchTo(home.isDefault ? undefined : home.homePath);
		}));
	}

	private async switchTo(homePath: string | undefined): Promise<void> {
		if (this.switching) {
			return;
		}
		this.switching = true;
		this._onDidChangeAccountsState.fire();
		try {
			this.setAccountsState(await this.client.selectHome(homePath));
		} catch (error) {
			this.logService.warn('[ParadisCodexAccounts] failed to switch the Codex account', error);
			this.notificationService.error(localize('paradis.codexAccounts.switchFailed', "Codex のアカウントを切り替えられませんでした。ログインし直してから、もう一度お試しください。"));
		} finally {
			this.switching = false;
			this._onDidChangeAccountsState.fire();
		}
	}

	// ---------- リセットクレジット ----------

	private ensureOffer(homePath: string, bypassCache: boolean): void {
		const cached = this.offers.get(homePath);
		if (!bypassCache && cached && Date.now() - cached.fetchedAt < OFFER_REFRESH_MS) {
			return;
		}
		if (this.loading.has(homePath)) {
			return;
		}
		this.loading.add(homePath);
		this.client.readResetCredits(homePath, bypassCache).then(offer => {
			this.offers.set(homePath, offer);
		}, error => {
			this.logService.warn('[ParadisCodexAccounts] failed to read reset credits', error);
		}).finally(() => {
			this.loading.delete(homePath);
			this._onDidChangeHome.fire(homePath);
		});
	}

	private renderResetRow(row: HTMLElement, store: DisposableStore, account: IParadisLimitsAccount): void {
		dom.clearNode(row);
		const offer = this.offers.get(account.id);
		const credits = offer?.credits;
		if (!offer || (!credits && !offer.pendingUnknown)) {
			// 未取得・読めない・リセットクレジットの仕組みが無いアカウントでは何も出さない。
			row.style.display = 'none';
			return;
		}
		row.style.display = '';
		row.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.history)}`));
		const text = dom.append(row, $('span.pcc-text'));
		const count = credits?.availableCount ?? 0;
		text.classList.toggle('available', count > 0);
		if (offer.pendingUnknown) {
			text.textContent = localize('paradis.codexAccounts.resetPending', "前回のリセットの結果を確認できていません");
		} else if (count === 0) {
			text.textContent = localize('paradis.codexAccounts.resetNone', "枠のリセット: 残りなし");
		} else if (credits?.nextExpiresAt !== undefined) {
			text.textContent = localize('paradis.codexAccounts.resetAvailableWithExpiry', "枠のリセット: 残り {0} 回（{1} まで）", count, formatDateTime(credits.nextExpiresAt));
		} else {
			text.textContent = localize('paradis.codexAccounts.resetAvailable', "枠のリセット: 残り {0} 回", count);
		}
		if (count === 0 && !offer.pendingUnknown) {
			return;
		}
		const button = dom.append(row, $('button.pcc-btn')) as HTMLButtonElement;
		button.type = 'button';
		const busy = this.consuming.has(account.id);
		button.disabled = busy;
		button.textContent = busy
			? localize('paradis.codexAccounts.resetBusy', "リセット中…")
			: offer.pendingUnknown
				? localize('paradis.codexAccounts.resetRetry', "結果を確認…")
				: localize('paradis.codexAccounts.resetUse', "使う…");
		store.add(dom.addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.consume(account);
		}));
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
		this._onDidChangeHome.fire(homePath);
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
		this.ensureOffer(homePath, true);
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

registerSingleton(IParadisCodexAccountCardService, ParadisCodexAccountCardService, InstantiationType.Delayed);
