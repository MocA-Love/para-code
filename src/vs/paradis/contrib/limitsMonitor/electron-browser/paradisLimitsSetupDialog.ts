/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// アカウント追加/再ログインのモーダルダイアログ(フェーズ2)。
//   - Codex: shared processが `CODEX_HOME=<新ホーム> codex login` を起動し、ユーザーは
//     自動で開くブラウザでログインするだけ。完了はバックエンドの状態ポーリングで検知する
//   - Claude: shared processが `claude setup-token` をPTYで駆動。ブラウザログイン後に表示される
//     確認コードをこのダイアログで受け取り、出力トークンを cswap add-token へ登録する
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
	private readonly inputRow: HTMLElement;
	private readonly codeInput: HTMLInputElement;
	private readonly submitButton: HTMLButtonElement;
	private readonly errorElement: HTMLElement;
	private readonly cancelButton: HTMLButtonElement;

	private readonly pollTimer = this._register(new IntervalTimer());
	/** renderSteps() は毎ポーリングでDOMを作り直すため、リンクのリスナーはここへ登録し再描画のたびにclearする。 */
	private readonly stepListeners = this._register(new DisposableStore());
	private sessionId: string | undefined;
	private latestState: IParadisLimitsSetupState = { phase: 'starting' };
	private codeSubmitted = false;
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

		this.inputRow = dom.append(body, $('.pls-input-row'));
		this.inputRow.style.display = 'none';
		this.codeInput = dom.append(this.inputRow, $('input.pls-input')) as HTMLInputElement;
		this.codeInput.type = 'text';
		this.codeInput.placeholder = localize('paradis.limitsSetup.codePlaceholder', "確認コードをここに貼り付け");
		this.codeInput.setAttribute('aria-label', this.codeInput.placeholder);
		this._register(dom.addDisposableListener(this.codeInput, 'keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this.submitCode();
			}
		}));

		this.errorElement = dom.append(body, $('.pls-error'));
		this.errorElement.style.display = 'none';

		const footer = dom.append(dialog, $('.pls-footer'));
		this.cancelButton = dom.append(footer, $('button.pls-btn')) as HTMLButtonElement;
		this.cancelButton.type = 'button';
		this.cancelButton.textContent = localize('paradis.limitsSetup.cancel', "キャンセル");
		this._register(dom.addDisposableListener(this.cancelButton, 'click', () => this.close(false)));

		this.submitButton = dom.append(footer, $('button.pls-btn.primary')) as HTMLButtonElement;
		this.submitButton.type = 'button';
		this.submitButton.textContent = localize('paradis.limitsSetup.submitCode', "登録");
		this.submitButton.style.display = 'none';
		this._register(dom.addDisposableListener(this.submitButton, 'click', () => this.submitCode()));

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
		return localize('paradis.limitsSetup.descClaude', "ブラウザで追加したいアカウントにログインしてください。確認コードが表示されたら下に貼り付けてください。");
	}

	private async start(): Promise<void> {
		try {
			const handle = this.options.provider === 'codex'
				? await this.client.startCodexLogin(this.options.reloginAccount?.id)
				: await this.client.startClaudeSetup(this.options.reloginAccount?.slot);
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
			this.latestState = await this.client.getSetupState(this.sessionId);
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

	private async submitCode(): Promise<void> {
		const code = this.codeInput.value.trim();
		if (!this.sessionId || code.length === 0 || this.codeSubmitted) {
			return;
		}
		this.codeSubmitted = true;
		this.submitButton.disabled = true;
		this.codeInput.disabled = true;
		try {
			await this.client.submitClaudeSetupCode(this.sessionId, code);
		} catch (error) {
			this.codeSubmitted = false;
			this.submitButton.disabled = false;
			this.codeInput.disabled = false;
			this.showError((error as Error).message);
		}
	}

	private close(completed: boolean): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.pollTimer.cancel();
		if (!completed && this.sessionId) {
			void this.client.cancelSetup(this.sessionId);
		}
		this.options.onClose(completed);
	}

	private showError(message: string): void {
		this.errorElement.textContent = message;
		this.errorElement.style.display = '';
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
			state.phase === 'done' ? 'done' : 'pending',
			localize('paradis.limitsSetup.stepRegister', "モニターに登録"),
			state.email ?? '',
			undefined,
		);
	}

	private renderClaudeSteps(state: IParadisLimitsSetupState): void {
		const waitingLaunch = state.phase === 'starting';
		this.appendStep(
			waitingLaunch ? 'now' : 'done',
			localize('paradis.limitsSetup.claudeStepBrowser', "ブラウザでログイン"),
			state.url ? localize('paradis.limitsSetup.browserFallback', "ブラウザが開かない場合はこちら:") : localize('paradis.limitsSetup.claudeLaunching', "claude setup-token を起動中…"),
			state.url,
		);
		const codePhase = state.phase === 'waiting_code';
		this.appendStep(
			codePhase && !this.codeSubmitted ? 'now' : (waitingLaunch ? 'pending' : 'done'),
			localize('paradis.limitsSetup.claudeStepCode', "確認コードを貼り付け"),
			'',
			undefined,
		);
		this.appendStep(
			state.phase === 'done' ? 'done' : (state.phase === 'registering' ? 'now' : 'pending'),
			this.options.reloginAccount
				? localize('paradis.limitsSetup.claudeStepRegisterSlot', "claude-swap のスロット {0} を更新", this.options.reloginAccount.slot ?? '?')
				: localize('paradis.limitsSetup.claudeStepRegister', "claude-swap に新しいスロットを登録"),
			'',
			undefined,
		);

		const showInput = codePhase && !this.codeSubmitted;
		this.inputRow.style.display = showInput ? '' : 'none';
		this.submitButton.style.display = showInput ? '' : 'none';
		if (showInput && dom.getActiveElement() !== this.codeInput) {
			this.codeInput.focus();
		}
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
