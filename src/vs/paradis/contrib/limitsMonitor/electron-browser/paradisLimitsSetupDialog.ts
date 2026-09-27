/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// アカウント追加/再ログインのモーダルダイアログ(フェーズ2)。
//   - Codex: shared processが `CODEX_HOME=<新ホーム> codex login` を起動し、ユーザーは
//     自動で開くブラウザでログインするだけ。完了はバックエンドの状態ポーリングで検知する
//   - Claude: shared processが一時ディレクトリに向けて `claude auth login` を動かす。ユーザーは
//     ブラウザでログインするだけで、終わると認証情報を Para Code の保存場所へ登録する
//     （node/paradisClaudeAccountService.ts）。いまの Claude のログインは変えない
// バックエンドのセッション状態(IParadisLimitsSetupState)を1秒間隔でポーリングして
// ステップ表示を更新するだけの薄いビューで、子プロセスの寿命管理はすべてshared process側。

import './media/paradisLimitsMonitor.css';
import * as dom from '../../../../base/browser/dom.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ParadisClaudeSetupErrorCode } from '../common/paradisClaudeAccounts.js';
import { IParadisLimitsAccount, IParadisLimitsSetupState, ParadisLimitsProvider } from '../common/paradisLimitsMonitor.js';
import { appendParadisLimitsLogo } from './paradisLimitsLogos.js';
import { ParadisLimitsMonitorClient } from './paradisLimitsMonitorClient.js';

const $ = dom.$;

const POLL_INTERVAL_MS = 1000;

export interface IParadisLimitsSetupDialogOptions {
	readonly provider: ParadisLimitsProvider;
	/** 指定時は新規追加ではなく、このアカウントの再ログイン。 */
	readonly reloginAccount: IParadisLimitsAccount | undefined;
	readonly onClose: (completed: boolean) => void;
}

export class ParadisLimitsSetupDialog extends Disposable {

	private readonly overlay: HTMLElement;
	private readonly stepsElement: HTMLElement;
	private readonly duplicateElement: HTMLElement;
	private readonly submitButton: HTMLButtonElement;
	private readonly keepDuplicateButton: HTMLButtonElement;
	private readonly errorElement: HTMLElement;
	private readonly cancelButton: HTMLButtonElement;

	private readonly pollTimer = this._register(new IntervalTimer());
	/** renderSteps() は毎ポーリングでDOMを作り直すため、リンクのリスナーはここへ登録し再描画のたびにclearする。 */
	private readonly stepListeners = this._register(new DisposableStore());
	private sessionId: string | undefined;
	private latestState: IParadisLimitsSetupState = { phase: 'starting' };
	private resolvingDuplicate = false;
	private duplicateHomeRemoved = false;
	/** 重複ホーム削除ボタンを描画した時点の接続経路。実行時にこれと不一致なら削除は中断される。 */
	private duplicateViaRemote = false;
	private closed = false;

	constructor(
		private readonly client: ParadisLimitsMonitorClient,
		private readonly options: IParadisLimitsSetupDialogOptions,
		@ILayoutService layoutService: ILayoutService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();

		this.overlay = $('.paradis-limits-setup-overlay');
		const dialog = dom.append(this.overlay, $('.paradis-limits-setup'));
		dialog.tabIndex = -1;

		const body = dom.append(dialog, $('.pls-body'));
		const title = dom.append(body, $('.pls-title'));
		appendParadisLimitsLogo(title, options.provider);
		dom.append(title, $('span')).textContent = this.titleText();

		dom.append(body, $('.pls-desc')).textContent = this.descriptionText();
		this.stepsElement = dom.append(body, $('.pls-steps'));
		this.duplicateElement = dom.append(body, $('.pls-duplicate'));
		this.duplicateElement.style.display = 'none';

		this.errorElement = dom.append(body, $('.pls-error'));
		this.errorElement.style.display = 'none';

		const footer = dom.append(dialog, $('.pls-footer'));
		this.cancelButton = dom.append(footer, $('button.pls-btn')) as HTMLButtonElement;
		this.cancelButton.type = 'button';
		this.cancelButton.textContent = localize('paradis.limitsSetup.cancel', "キャンセル");
		this._register(dom.addDisposableListener(this.cancelButton, 'click', () => this.close(false)));

		this.keepDuplicateButton = dom.append(footer, $('button.pls-btn')) as HTMLButtonElement;
		this.keepDuplicateButton.type = 'button';
		this.keepDuplicateButton.textContent = localize('paradis.limitsSetup.keepDuplicate', "それでも追加");
		this.keepDuplicateButton.style.display = 'none';
		this._register(dom.addDisposableListener(this.keepDuplicateButton, 'click', () => void this.keepDuplicate()));

		// Codex の重複確認で「新規ホームを削除」に使う。
		this.submitButton = dom.append(footer, $('button.pls-btn.primary')) as HTMLButtonElement;
		this.submitButton.type = 'button';
		this.submitButton.style.display = 'none';
		this._register(dom.addDisposableListener(this.submitButton, 'click', () => {
			if (this.latestState.phase === 'waiting_duplicate') {
				void this.discardDuplicate();
			}
		}));

		this._register(dom.addDisposableListener(dialog, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.close(false);
			}
		}));

		layoutService.activeContainer.appendChild(this.overlay);
		dialog.focus();

		this.renderSteps();
		void this.start();
	}

	override dispose(): void {
		this.overlay.remove();
		super.dispose();
	}

	private titleText(): string {
		if (this.options.reloginAccount) {
			return this.options.provider === 'claude'
				? localize('paradis.limitsSetup.titleClaudeRelogin', "Claude アカウントに再ログイン")
				: localize('paradis.limitsSetup.titleCodexRelogin', "Codex アカウントに再ログイン");
		}
		return this.options.provider === 'claude'
			? localize('paradis.limitsSetup.titleClaude', "Claude アカウントを追加")
			: localize('paradis.limitsSetup.titleCodex', "Codex アカウントを追加");
	}

	private descriptionText(): string {
		if (this.options.provider === 'codex') {
			return localize('paradis.limitsSetup.descCodex', "ブラウザが開きます。追加したいアカウントでログインしてください。ログインが完了すると自動でこの画面も完了します。");
		}
		return localize('paradis.limitsSetup.descClaude', "ブラウザが開きます。追加したいアカウントでログインしてください。ログインが終わると自動で登録されます。いまこの PC で使っている Claude のログインは変わりません。ブラウザで別のアカウントにログインしている場合は、先にログアウトしてください。");
	}

	private async start(): Promise<void> {
		try {
			const handle = this.options.provider === 'codex'
				? await this.client.startCodexLogin(this.options.reloginAccount?.id)
				: await this.client.startClaudeLogin(this.options.reloginAccount?.id);
			this.sessionId = handle.sessionId;
			this.pollTimer.cancelAndSet(() => this.pollState(), POLL_INTERVAL_MS);
		} catch (error) {
			this.latestState = { phase: 'error', error: (error as Error).message };
			this.renderSteps();
		}
	}

	private async pollState(): Promise<void> {
		if (!this.sessionId || this.closed) {
			return;
		}
		try {
			this.latestState = this.options.provider === 'claude'
				? await this.client.getClaudeSetupState(this.sessionId)
				: await this.client.getSetupState(this.sessionId);
		} catch {
			return; // 一時的なIPC不通は次のポーリングで回復する
		}
		this.renderSteps();
		if (this.latestState.phase === 'done') {
			this.pollTimer.cancel();
			this.close(true);
		} else if (this.latestState.phase === 'error') {
			this.pollTimer.cancel();
		}
	}

	private async discardDuplicate(): Promise<void> {
		if (!this.sessionId || !this.latestState.homePath || this.resolvingDuplicate) {
			return;
		}
		this.setDuplicateResolving(true);
		try {
			if (!this.duplicateHomeRemoved) {
				await this.client.removeCodexHome(this.latestState.homePath, this.duplicateViaRemote);
				this.duplicateHomeRemoved = true;
			}
			await this.client.resolveCodexDuplicate(this.sessionId, 'discard');
			await this.pollState();
		} catch (error) {
			this.setDuplicateResolving(false);
			this.showError((error as Error).message);
		}
	}

	private async keepDuplicate(): Promise<void> {
		if (!this.sessionId || this.resolvingDuplicate) {
			return;
		}
		this.setDuplicateResolving(true);
		try {
			await this.client.resolveCodexDuplicate(this.sessionId, 'keep');
			await this.pollState();
		} catch (error) {
			this.setDuplicateResolving(false);
			this.showError((error as Error).message);
		}
	}

	private setDuplicateResolving(resolving: boolean): void {
		this.resolvingDuplicate = resolving;
		this.cancelButton.disabled = resolving;
		this.keepDuplicateButton.disabled = resolving;
		this.submitButton.disabled = resolving;
	}

	private close(completed: boolean): void {
		if (this.closed || (!completed && this.resolvingDuplicate)) {
			return;
		}
		this.closed = true;
		this.pollTimer.cancel();
		if (!completed && this.sessionId) {
			void (this.options.provider === 'claude' ? this.client.cancelClaudeSetup(this.sessionId) : this.client.cancelSetup(this.sessionId));
		}
		// 重複確認を閉じてもログイン済みホームは残るため、一覧を再取得してカードから判断できるようにする。
		this.options.onClose(completed || this.latestState.phase === 'waiting_duplicate');
	}

	private showError(message: string): void {
		this.errorElement.textContent = this.options.provider === 'claude' ? this.claudeErrorText(message) : message;
		this.errorElement.style.display = '';
	}

	/** Claude のログインの失敗の種類（ParadisClaudeSetupErrorCode）を説明文にする。知らないものはそのまま。 */
	private claudeErrorText(error: string): string {
		const code: ParadisClaudeSetupErrorCode | string = error;
		switch (code) {
			case 'busy':
				return localize('paradis.limitsSetup.claudeBusy', "ほかのアカウントの追加が進行中です。終わってからもう一度お試しください。");
			case 'cancelled':
				return localize('paradis.limitsSetup.claudeCancelled', "キャンセルしました。");
			case 'no_credentials':
				return localize('paradis.limitsSetup.claudeNoCredentials', "ログインは終わりましたが、認証情報を読み取れませんでした。もう一度お試しください。");
			case 'no_identity':
				return localize('paradis.limitsSetup.claudeNoIdentity', "ログインしたアカウントのメールアドレスを確認できませんでした。もう一度お試しください。");
			case 'different_account':
				return localize('paradis.limitsSetup.claudeDifferentAccount', "元のアカウントと違うアカウントでログインしました。別のアカウントを足す場合は「＋ アカウントを追加」から追加してください。");
			case 'not_found':
				return localize('paradis.limitsSetup.claudeNotFound', "対象のアカウントが見つかりません。一覧を更新してからもう一度お試しください。");
			case 'keychain_unavailable':
				return localize('paradis.limitsSetup.claudeKeychain', "キーチェーンを読み取れませんでした。Mac のロックを解除してからもう一度お試しください。");
			case 'unsupported':
				return localize('paradis.limitsSetup.claudeUnsupported', "この環境では Claude アカウントを追加できません。");
		}
		if (error.startsWith('claude not found')) {
			return localize('paradis.limitsSetup.claudeMissing', "Claude Code が見つかりません。Claude Code をインストールしてからもう一度お試しください。");
		}
		if (error === 'timed out') {
			return localize('paradis.limitsSetup.claudeTimedOut', "時間内にログインが終わりませんでした。もう一度お試しください。");
		}
		return error;
	}

	private renderSteps(): void {
		this.stepListeners.clear();
		dom.clearNode(this.stepsElement);
		const state = this.latestState;

		if (state.error) {
			this.showError(state.error);
		} else {
			this.errorElement.style.display = 'none';
		}

		if (this.options.provider === 'codex') {
			this.renderCodexSteps(state);
		} else {
			this.renderClaudeSteps(state);
		}
	}

	private renderCodexSteps(state: IParadisLimitsSetupState): void {
		const preparing = state.phase === 'starting';
		const waitingDuplicate = state.phase === 'waiting_duplicate';
		this.appendStep(
			preparing ? 'now' : 'done',
			this.options.reloginAccount
				? localize('paradis.limitsSetup.codexStepHomeRelogin', "既存の保存先を使用")
				: localize('paradis.limitsSetup.codexStepHome', "保存先ディレクトリを準備"),
			state.homeLabel ?? (this.options.reloginAccount?.homeLabel ?? ''),
			undefined,
		);
		this.appendStep(
			state.phase === 'waiting_browser' ? 'now' : (preparing ? 'pending' : 'done'),
			localize('paradis.limitsSetup.codexStepBrowser', "ブラウザでログイン"),
			state.url ? localize('paradis.limitsSetup.browserFallback', "ブラウザが開かない場合はこちら:") : localize('paradis.limitsSetup.browserOpening', "ブラウザでのログインを待っています…"),
			state.url,
		);
		this.appendStep(
			state.phase === 'done' ? 'done' : (waitingDuplicate ? 'now' : 'pending'),
			localize('paradis.limitsSetup.stepRegister', "モニターに登録"),
			waitingDuplicate ? localize('paradis.limitsSetup.duplicateNeedsDecision', "同じアカウントが既に登録されています") : (state.email ?? ''),
			undefined,
		);

		this.renderCodexDuplicate(state);
	}

	private renderCodexDuplicate(state: IParadisLimitsSetupState): void {
		const waitingDuplicate = state.phase === 'waiting_duplicate';
		this.duplicateElement.style.display = waitingDuplicate ? '' : 'none';
		this.keepDuplicateButton.style.display = waitingDuplicate ? '' : 'none';
		this.submitButton.style.display = waitingDuplicate ? '' : 'none';
		this.cancelButton.textContent = waitingDuplicate
			? localize('paradis.limitsSetup.closeDuplicate', "閉じる")
			: localize('paradis.limitsSetup.cancel', "キャンセル");
		if (!waitingDuplicate) {
			return;
		}

		dom.clearNode(this.duplicateElement);
		dom.append(this.duplicateElement, $('.pls-duplicate-title')).textContent = localize('paradis.limitsSetup.duplicateTitle', "同じCodexアカウントです");
		dom.append(this.duplicateElement, $('.pls-duplicate-message')).textContent = localize('paradis.limitsSetup.duplicateMessage', "通常は新しい保存先を残す必要はありません。必要な場合は重複したまま追加できます。");
		if (state.email) {
			this.appendDuplicateDetail(localize('paradis.limitsSetup.duplicateAccount', "アカウント"), state.email);
		}
		this.appendDuplicateDetail(localize('paradis.limitsSetup.duplicateExistingHomes', "登録済み"), (state.duplicateHomeLabels ?? []).join(', '));
		this.appendDuplicateDetail(localize('paradis.limitsSetup.duplicateNewHome', "新しい保存先"), state.homeLabel ?? '');

		this.keepDuplicateButton.textContent = localize('paradis.limitsSetup.keepDuplicate', "それでも追加");
		this.duplicateViaRemote = this.client.connectedToRemote;
		this.submitButton.textContent = this.duplicateHomeRemoved
			? localize('paradis.limitsSetup.finishDiscardDuplicate', "削除を完了")
			: this.duplicateViaRemote
				? localize('paradis.limitsSetup.discardDuplicatePermanent', "新規ホームを完全に削除")
				: localize('paradis.limitsSetup.discardDuplicate', "新規ホームをゴミ箱へ移動");
		this.setDuplicateResolving(this.resolvingDuplicate);
	}

	private appendDuplicateDetail(label: string, value: string): void {
		if (!value) {
			return;
		}
		const row = dom.append(this.duplicateElement, $('.pls-duplicate-detail'));
		dom.append(row, $('span.pls-duplicate-label')).textContent = label;
		dom.append(row, $('code')).textContent = value;
	}

	private renderClaudeSteps(state: IParadisLimitsSetupState): void {
		this.duplicateElement.style.display = 'none';
		this.keepDuplicateButton.style.display = 'none';
		this.submitButton.style.display = 'none';
		this.cancelButton.textContent = localize('paradis.limitsSetup.cancel', "キャンセル");
		const browserPhase = state.phase === 'starting' || state.phase === 'waiting_browser';
		this.appendStep(
			browserPhase ? 'now' : 'done',
			localize('paradis.limitsSetup.claudeStepBrowser', "ブラウザでログイン"),
			state.url ? localize('paradis.limitsSetup.browserFallback', "ブラウザが開かない場合はこちら:") : localize('paradis.limitsSetup.browserOpening', "ブラウザでのログインを待っています…"),
			state.url,
		);
		this.appendStep(
			state.phase === 'done' ? 'done' : (state.phase === 'registering' ? 'now' : 'pending'),
			this.options.reloginAccount
				? localize('paradis.limitsSetup.claudeStepUpdate', "Para Code に保存し直す")
				: localize('paradis.limitsSetup.claudeStepSave', "Para Code に保存"),
			state.email ?? '',
			undefined,
		);
	}

	private appendStep(status: 'pending' | 'now' | 'done', label: string, detail: string, url: string | undefined): void {
		const step = dom.append(this.stepsElement, $(`.pls-step${status === 'pending' ? '' : `.${status}`}`));
		const num = dom.append(step, $('.pls-step-num'));
		num.textContent = status === 'done' ? '✓' : String(this.stepsElement.childElementCount);
		const text = dom.append(step, $('.pls-step-text'));
		dom.append(text, $('span')).textContent = label;
		if (detail || url) {
			const detailElement = dom.append(text, $('.pls-step-detail'));
			if (detail) {
				dom.append(detailElement, $('span')).textContent = `${detail} `;
			}
			if (url) {
				const link = dom.append(detailElement, $('a')) as HTMLAnchorElement;
				link.textContent = url;
				link.setAttribute('role', 'link');
				this.stepListeners.add(dom.addDisposableListener(link, 'click', e => {
					e.preventDefault();
					void this.openerService.open(URI.parse(url));
				}));
			}
		}
	}
}
