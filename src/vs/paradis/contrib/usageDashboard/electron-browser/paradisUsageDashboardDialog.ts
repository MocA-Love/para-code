/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量ダッシュボード (ccusage · GitHub API · rtk) を1つにまとめたダイアログ。
//
// もともと3つは別々のタブ (EditorPane) で、ステータスバーの各項目から個別に開いていた。
// 「今どれだけ使ったか」は3つを見比べて初めて分かることが多いのに、タブが3枚に散ると
// 並べて見るのにレイアウトを組み替える必要があった。ここでは左ナビで切り替える1枚に
// まとめ、どこから開いても同じ場所に出るようにする。
//
// 各パネルの中身は元のタブと同じコード (ParadisCcusageSection / ParadisGithubMetricsSection /
// ParadisRtkSection) をそのまま使う。タブ実装も同じセクションを内包しているので、
// 入口が2つあっても描画は1か所にある。

import './media/paradisUsageDashboard.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ParadisCcusageSection } from '../../ccusage/electron-browser/paradisCcusageSection.js';
import { ParadisGithubMetricsSection } from '../../githubMetrics/electron-browser/paradisGithubMetricsSection.js';
import { ParadisRtkSection } from '../../rtk/electron-browser/paradisRtkSection.js';
import { IParadisUsageSection } from './paradisUsageSection.js';

const $ = dom.$;

/** 開いた直後に見せるタブ。コマンド引数で指定できる。 */
export type ParadisUsageDashboardTab = 'ccusage' | 'github' | 'rtk' | 'settings';

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.usage.title', "使用量・コスト");
// allow-any-unicode-next-line
const STR_CLOSE_ARIA = localize('paradis.usage.closeAria', "閉じる");
// allow-any-unicode-next-line
const STR_REFRESH = localize('paradis.usage.refresh', "更新");
// allow-any-unicode-next-line
const STR_NAV_CAPTION_USAGE = localize('paradis.usage.navCaptionUsage', "使用量");
// allow-any-unicode-next-line
const STR_NAV_CAPTION_SETTINGS = localize('paradis.usage.navCaptionSettings', "設定");
// allow-any-unicode-next-line
const STR_NAV_CCUSAGE = localize('paradis.usage.navCcusage', "AI コスト");
// allow-any-unicode-next-line
const STR_NAV_GITHUB = localize('paradis.usage.navGithub', "GitHub API");
// allow-any-unicode-next-line
const STR_NAV_RTK = localize('paradis.usage.navRtk', "rtk 節約");
// allow-any-unicode-next-line
const STR_NAV_SETTINGS = localize('paradis.usage.navSettings', "表示と取得元");
// allow-any-unicode-next-line
const STR_SETTINGS_HEAD = localize('paradis.usage.settingsHead', "表示と取得元");
// allow-any-unicode-next-line
const STR_SETTINGS_DESC = localize('paradis.usage.settingsDesc', "このダイアログで扱う3つのダッシュボードに共通する設定です。");
// allow-any-unicode-next-line
const STR_UNSET = localize('paradis.usage.unset', "(未設定)");
// allow-any-unicode-next-line
const STR_RTK_PATH_PLACEHOLDER = localize('paradis.usage.rtkPathPlaceholder', "(自動で探す)");

interface IParadisUsageTabSpec {
	readonly id: ParadisUsageDashboardTab;
	readonly navLabel: string;
	readonly icon: ThemeIcon;
	readonly caption?: string;
}

const TABS: readonly IParadisUsageTabSpec[] = [
	{ id: 'ccusage', navLabel: STR_NAV_CCUSAGE, icon: Codicon.creditCard, caption: STR_NAV_CAPTION_USAGE },
	{ id: 'github', navLabel: STR_NAV_GITHUB, icon: Codicon.github, caption: undefined },
	{ id: 'rtk', navLabel: STR_NAV_RTK, icon: Codicon.zap, caption: undefined },
	{ id: 'settings', navLabel: STR_NAV_SETTINGS, icon: Codicon.gear, caption: STR_NAV_CAPTION_SETTINGS },
];

/** 設定タブに出す行 (3ダッシュボードに共通して効くものだけ)。 */
interface IParadisUsageSettingSpec {
	readonly key: string;
	readonly label: string;
	readonly description?: string;
	readonly placeholder?: string;
	/** 数値 select の選択肢。指定するとテキスト欄ではなくプルダウンになる。 */
	readonly choices?: readonly { readonly value: number; readonly label: string }[];
}

const SETTINGS: readonly IParadisUsageSettingSpec[] = [
	{
		key: 'paradis.ccusage.executablePath',
		// allow-any-unicode-next-line
		label: localize('paradis.usage.ccusagePath', "ccusage のパス"),
		// allow-any-unicode-next-line
		description: localize('paradis.usage.ccusagePathDesc', "空欄なら自動で探します。見つからないときだけ指定してください。"),
		placeholder: '/usr/local/bin/ccusage',
	},
	{
		key: 'paradis.ccusage.statusBar.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.usage.ccusageStatusBar', "今日の AI コストをステータスバーに表示"),
	},
	{
		key: 'paradis.ccusage.execTimeoutSeconds',
		// allow-any-unicode-next-line
		label: localize('paradis.usage.ccusageExecTimeout', "ccusage の実行タイムアウト"),
		// allow-any-unicode-next-line
		description: localize('paradis.usage.ccusageExecTimeoutDesc', "ログの量が多いと集計に時間がかかります。取得できない場合は延ばしてください。"),
		choices: [
			// allow-any-unicode-next-line
			{ value: 60, label: localize('paradis.usage.ccusageExecTimeout60', "60秒") },
			// allow-any-unicode-next-line
			{ value: 120, label: localize('paradis.usage.ccusageExecTimeout120', "2分") },
			// allow-any-unicode-next-line
			{ value: 180, label: localize('paradis.usage.ccusageExecTimeout180', "3分（既定）") },
			// allow-any-unicode-next-line
			{ value: 300, label: localize('paradis.usage.ccusageExecTimeout300', "5分") },
			// allow-any-unicode-next-line
			{ value: 600, label: localize('paradis.usage.ccusageExecTimeout600', "10分") },
		],
	},
	{
		key: 'paradis.githubMetrics.statusBar.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.usage.ghStatusBar', "GitHub API の残量をステータスバーに表示"),
	},
	{
		key: 'paradis.rtk.executablePath',
		// allow-any-unicode-next-line
		label: localize('paradis.usage.rtkPath', "rtk のパス"),
		// allow-any-unicode-next-line
		description: localize('paradis.usage.rtkPathDesc', "空欄なら自動で探します。SSH 中は接続先の rtk を使うので、リモート側の設定に書いてください。"),
		placeholder: STR_RTK_PATH_PLACEHOLDER,
	},
	{
		key: 'paradis.rtk.statusBar.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.usage.rtkStatusBar', "今日 rtk が減らしたトークン数をステータスバーに表示"),
	},
	{
		key: 'paradis.githubMetrics.refreshIntervalSeconds',
		// allow-any-unicode-next-line
		label: localize('paradis.usage.refreshInterval', "自動更新の間隔"),
		// allow-any-unicode-next-line
		description: localize('paradis.usage.refreshIntervalDesc', "GitHub API のタブを開いている間に取り直す間隔です。AI コストと rtk は、開いたときと更新ボタンでのみ取り直します。"),
		choices: [
			// allow-any-unicode-next-line
			{ value: 0, label: localize('paradis.usage.refreshManual', "手動のみ") },
			// allow-any-unicode-next-line
			{ value: 60, label: localize('paradis.usage.refresh60', "1 分ごと") },
			// allow-any-unicode-next-line
			{ value: 300, label: localize('paradis.usage.refresh300', "5 分ごと") },
			// allow-any-unicode-next-line
			{ value: 900, label: localize('paradis.usage.refresh900', "15 分ごと") },
		],
	},
];

export class ParadisUsageDashboardDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _contentEl: HTMLElement;
	private readonly _navItems = new Map<ParadisUsageDashboardTab, HTMLElement>();
	private readonly _panes = new Map<ParadisUsageDashboardTab, HTMLElement>();
	private readonly _sections = new Map<ParadisUsageDashboardTab, IParadisUsageSection>();
	private readonly _settingRefreshers: (() => void)[] = [];
	private _activeTab: ParadisUsageDashboardTab = 'ccusage';

	constructor(
		initialTab: ParadisUsageDashboardTab | undefined,
		@ILayoutService layoutService: ILayoutService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this._backdrop = $('.paradis-usage-dashboard-backdrop');
		const modal = $('.paradis-usage-dashboard');
		this._backdrop.appendChild(modal);

		// ---------- header ----------
		const header = dom.append(modal, $('.pud-header'));
		dom.append(header, $('h2')).textContent = STR_TITLE;

		const refreshBtn = dom.append(header, $('button.pud-refresh')) as HTMLButtonElement;
		refreshBtn.type = 'button';
		refreshBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		dom.append(refreshBtn, $('span')).textContent = STR_REFRESH;
		this._register(dom.addDisposableListener(refreshBtn, 'click', () => this._refreshActive()));

		const closeBtn = dom.append(header, $('.pud-close'));
		closeBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		closeBtn.setAttribute('role', 'button');
		closeBtn.setAttribute('aria-label', STR_CLOSE_ARIA);
		this._register(dom.addDisposableListener(closeBtn, 'click', () => this.dispose()));

		// ---------- body（左ナビ + 右コンテンツ） ----------
		const body = dom.append(modal, $('.pud-body'));
		const nav = dom.append(body, $('nav.pud-nav'));
		this._contentEl = dom.append(body, $('.pud-content'));

		for (const spec of TABS) {
			if (spec.caption) {
				dom.append(nav, $('.pud-nav-caption')).textContent = spec.caption;
			}
			const item = dom.append(nav, $('.pud-nav-item'));
			item.setAttribute('role', 'button');
			item.appendChild($(`span.pud-nav-icon${ThemeIcon.asCSSSelector(spec.icon)}`));
			dom.append(item, $('span.pud-nav-label')).textContent = spec.navLabel;
			this._navItems.set(spec.id, item);
			this._register(dom.addDisposableListener(item, 'click', () => this._selectTab(spec.id)));

			const pane = dom.append(this._contentEl, $('.pud-pane'));
			pane.classList.add('hidden');
			this._panes.set(spec.id, pane);
		}

		// パネル本体はタブ実装と同じセクションクラスをそのまま使う
		this._addSection('ccusage', this._register(instantiationService.createInstance(ParadisCcusageSection)));
		this._addSection('github', this._register(instantiationService.createInstance(ParadisGithubMetricsSection)));
		this._addSection('rtk', this._register(instantiationService.createInstance(ParadisRtkSection)));
		this._buildSettingsPane(this._panes.get('settings')!);

		modal.tabIndex = -1;
		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.dispose();
			}
		}));
		this._register(dom.addDisposableListener(this._backdrop, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Escape) {
				event.preventDefault();
				this.dispose();
			}
		}));

		// 幅はダイアログ側でしか分からない (セクションは自分の親を測らない設計) ので、
		// ここで実測して流し込む。ウィンドウリサイズにも追従させる。
		const observer = new ResizeObserver(entries => {
			const width = entries[0]?.contentRect.width;
			if (width && width > 0) {
				for (const section of this._sections.values()) {
					section.layout(width);
				}
			}
		});
		observer.observe(this._contentEl);
		this._register({ dispose: () => observer.disconnect() });

		layoutService.activeContainer.appendChild(this._backdrop);
		this._selectTab(initialTab ?? 'ccusage');
		modal.focus();
	}

	override dispose(): void {
		this._backdrop.remove();
		super.dispose();
	}

	// ==========================================================================================

	private _addSection(tab: ParadisUsageDashboardTab, section: IParadisUsageSection): void {
		this._sections.set(tab, section);
		this._panes.get(tab)!.appendChild(section.element);
	}

	private _selectTab(tab: ParadisUsageDashboardTab): void {
		this._activeTab = tab;
		for (const [id, item] of this._navItems) {
			item.classList.toggle('active', id === tab);
		}
		for (const [id, pane] of this._panes) {
			pane.classList.toggle('hidden', id !== tab);
		}
		// 見えていないパネルはポーリング・warm lease を止める（見ていないもののために
		// CLI を回し続けない）
		for (const [id, section] of this._sections) {
			section.setVisible(id === tab);
		}
		const active = this._sections.get(tab);
		if (active) {
			const width = this._contentEl.clientWidth;
			if (width > 0) {
				active.layout(width);
			}
		}
	}

	private _refreshActive(): void {
		void this._sections.get(this._activeTab)?.refresh(true);
	}

	private _buildSettingsPane(pane: HTMLElement): void {
		dom.append(pane, $('.pud-settings-head')).textContent = STR_SETTINGS_HEAD;
		dom.append(pane, $('.pud-settings-desc')).textContent = STR_SETTINGS_DESC;

		const store = this._register(new DisposableStore());
		for (const spec of SETTINGS) {
			const row = dom.append(pane, $('.pud-setting-row'));
			const main = dom.append(row, $('.pud-setting-main'));
			const label = dom.append(main, $('.pud-setting-label'));
			dom.append(label, $('span')).textContent = spec.label;
			// allow-any-unicode-next-line
			// 設定キー (paradis.*) は画面に出さない (paradisSettingsDialog.ts と同じ方針)。
			if (spec.description) {
				dom.append(main, $('.pud-setting-desc')).textContent = spec.description;
			}

			if (spec.choices) {
				const select = dom.append(row, $('select.pud-select')) as HTMLSelectElement;
				for (const choice of spec.choices) {
					const option = dom.append(select, $('option')) as HTMLOptionElement;
					option.value = String(choice.value);
					option.textContent = choice.label;
				}
				// 用意した刻みに載らない値が既に入っていることがあるので、そのときは
				// 実際の値を選択肢へ足して選んでおく（開いただけで設定が変わったように見せない）
				let extraOption: HTMLOptionElement | undefined;
				const sync = () => {
					const current = String(this.configurationService.getValue(spec.key) ?? '');
					extraOption?.remove();
					extraOption = undefined;
					if (!spec.choices?.some(choice => String(choice.value) === current)) {
						extraOption = dom.append(select, $('option')) as HTMLOptionElement;
						extraOption.value = current;
						extraOption.textContent = current;
					}
					select.value = current;
				};
				sync();
				this._settingRefreshers.push(sync);
				store.add(dom.addDisposableListener(select, 'change', () => {
					void this.configurationService.updateValue(spec.key, Number(select.value), ConfigurationTarget.USER);
				}));
			} else if (typeof this.configurationService.getValue(spec.key) === 'boolean') {
				const toggle = dom.append(row, $('input.pud-toggle')) as HTMLInputElement;
				toggle.type = 'checkbox';
				const sync = () => { toggle.checked = this.configurationService.getValue<boolean>(spec.key) === true; };
				sync();
				this._settingRefreshers.push(sync);
				store.add(dom.addDisposableListener(toggle, 'change', () => {
					void this.configurationService.updateValue(spec.key, toggle.checked, ConfigurationTarget.USER);
				}));
			} else {
				const input = dom.append(row, $('input.pud-input')) as HTMLInputElement;
				input.type = 'text';
				input.spellcheck = false;
				input.placeholder = spec.placeholder ?? STR_UNSET;
				const sync = () => { input.value = this.configurationService.getValue<string>(spec.key) ?? ''; };
				sync();
				this._settingRefreshers.push(sync);
				// 入力途中で毎回書かない（設定ファイルが1文字ごとに書き変わるのを避ける）
				store.add(dom.addDisposableListener(input, 'change', () => {
					void this.configurationService.updateValue(spec.key, input.value, ConfigurationTarget.USER);
				}));
			}
		}

		const footer = dom.append(pane, $('.pud-settings-footer'));
		const allSettingsBtn = dom.append(footer, $('button.pud-btn')) as HTMLButtonElement;
		// allow-any-unicode-next-line
		allSettingsBtn.textContent = localize('paradis.usage.openAllSettings', "Para Code の設定をすべて開く…");
		store.add(dom.addDisposableListener(allSettingsBtn, 'click', () => {
			this.dispose();
			void this.commandService.executeCommand('paradis.openSettingsDialog');
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('paradis')) {
				for (const refresh of this._settingRefreshers) {
					refresh();
				}
			}
		}));
	}
}
