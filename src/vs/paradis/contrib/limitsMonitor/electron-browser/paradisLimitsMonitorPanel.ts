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
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import {
	IParadisLimitsAccount,
	IParadisLimitsProviderSnapshot,
	IParadisLimitsSnapshot,
	IParadisLimitsWindow,
	paradisLimitsFormatCountdown,
	paradisLimitsSeverity,
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
}

export class ParadisLimitsMonitorPanel extends Disposable {

	private readonly element: HTMLElement;
	private readonly bodyElement: HTMLElement;
	private readonly refreshButton: HTMLElement;
	private readonly updatedElement: HTMLElement;

	/** renderBody() は毎ポーリングでDOMを作り直すため、行リスナーはここへ登録し再描画のたびにclearする。 */
	private readonly _bodyListeners = this._register(new DisposableStore());

	constructor(
		private readonly anchor: HTMLElement,
		private readonly options: IParadisLimitsMonitorPanelOptions,
		@ILayoutService layoutService: ILayoutService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
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
		dom.append(header, $('.plm-provider-count')).textContent = localize('paradis.limitsMonitor.accountCount', "{0} アカウント", providerSnapshot.accounts.length);
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
		for (const account of providerSnapshot.accounts) {
			this.renderAccount(account);
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

		if (account.provider === 'codex' && account.homeLabel) {
			dom.append(top, $('.plm-badge')).textContent = account.homeLabel;
		}
		if (account.active) {
			dom.append(top, $('.plm-badge.active')).textContent = localize('paradis.limitsMonitor.activeBadge', "使用中");
		}

		if (account.status !== 'ok') {
			dom.append(top, $('.plm-badge.err')).textContent = account.status === 'token_expired'
				? localize('paradis.limitsMonitor.tokenExpired', "トークン失効")
				: localize('paradis.limitsMonitor.accountError', "エラー");
			const errorRow = dom.append(card, $('.plm-error-row'));
			dom.append(errorRow, $('span')).textContent = account.statusDetail ?? localize('paradis.limitsMonitor.reloginNeeded', "再ログインが必要です");
			const reloginButton = dom.append(errorRow, $('button.plm-relogin-btn'));
			reloginButton.setAttribute('type', 'button');
			reloginButton.textContent = localize('paradis.limitsMonitor.relogin', "再ログイン…");
			this._bodyListeners.add(dom.addDisposableListener(reloginButton, 'click', () => this.options.onRelogin(account)));
			return;
		}

		const nextReset = this.nextResetLabel(account);
		if (nextReset) {
			dom.append(top, $('.plm-account-reset')).textContent = nextReset;
		}

		if (account.fiveHour) {
			this.renderMeter(card, localize('paradis.limitsMonitor.window5h', "5時間"), account.fiveHour);
		}
		if (account.sevenDay) {
			this.renderMeter(card, localize('paradis.limitsMonitor.window7d', "7日"), account.sevenDay);
		}
		for (const scoped of account.scoped ?? []) {
			this.renderMeter(card, scoped.label ?? localize('paradis.limitsMonitor.windowExtra', "追加枠"), scoped);
		}
		if (!account.fiveHour && !account.sevenDay && (account.scoped ?? []).length === 0) {
			dom.append(card, $('.plm-error-row')).textContent = localize('paradis.limitsMonitor.noWindows', "使用状況データがありません");
		}
	}

	/** 直近に迫っているリセットを1つだけ右肩に出す(カード内の情報過多を避ける)。 */
	private nextResetLabel(account: IParadisLimitsAccount): string | undefined {
		const now = Date.now();
		const windows: IParadisLimitsWindow[] = [];
		if (account.fiveHour) {
			windows.push(account.fiveHour);
		}
		if (account.sevenDay) {
			windows.push(account.sevenDay);
		}
		windows.push(...(account.scoped ?? []));
		const upcoming = windows
			.filter(window => window.resetsAt !== undefined && window.resetsAt > now && window.usedPercent > 0)
			.sort((a, b) => a.resetsAt! - b.resetsAt!)[0];
		const countdown = paradisLimitsFormatCountdown(upcoming?.resetsAt, now);
		return countdown ? localize('paradis.limitsMonitor.resetIn', "リセットまで {0}", countdown) : undefined;
	}

	private renderMeter(card: HTMLElement, label: string, window: IParadisLimitsWindow): void {
		const meter = dom.append(card, $('.plm-meter'));
		dom.append(meter, $('.plm-meter-label')).textContent = label;
		const track = dom.append(meter, $('.plm-meter-track'));
		const fill = dom.append(track, $('.plm-meter-fill'));
		const percent = Math.min(100, Math.max(0, window.usedPercent));
		fill.style.width = `${percent}%`;
		const severity = paradisLimitsSeverity(window.usedPercent);
		if (severity !== 'normal') {
			fill.classList.add(severity);
		}
		dom.append(meter, $('.plm-meter-value')).textContent = localize('paradis.limitsMonitor.percentUsed', "{0}% 使用", Math.round(window.usedPercent));
	}
}
