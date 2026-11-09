/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 統合のモーダルの「使用量」の領域（AI コスト · スペース別 · GitHub API · rtk · 作業実績 · 表示と取得元）。
//
// もとは ccusage · GitHub API · rtk が別々のタブ (EditorPane) で、次に左ナビで切り替える 1 枚のダイアログにまとめた。
// いまはその左ナビと本文を、統合のモーダルの器（paradisHub）の 1 つの領域として描く。
// 各パネルの中身は各ダッシュボードのセクション (ParadisCcusageSection / ParadisGithubMetricsSection /
// ParadisRtkSection ほか) をそのまま使う。

import './media/paradisUsageDashboard.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ParadisSpaceUsageSection } from '../../agentActivity/electron-browser/paradisSpaceUsageSection.js';
import { ParadisWorkStatsSection } from '../../agentActivity/electron-browser/paradisWorkStatsSection.js';
import { ParadisCcusageSection } from '../../ccusage/electron-browser/paradisCcusageSection.js';
import { ParadisGithubMetricsSection } from '../../githubMetrics/electron-browser/paradisGithubMetricsSection.js';
import { ParadisRtkSection } from '../../rtk/electron-browser/paradisRtkSection.js';
import { ParadisSelect } from '../../../browser/paradisSelect.js';
import { ParadisSwitch } from '../../../browser/paradisSwitch.js';
import { IParadisHubAreaContainers, IParadisHubAreaView, IParadisHubHost, ParadisHubAreaId } from '../../paradisHub/electron-browser/paradisHub.js';
import { PARADIS_SETTINGS_TITLEBAR_SECTION_ID } from '../../paradisSettings/electron-browser/paradisSettingsDialog.js';
import { IParadisHubNavItem, paradisHubNavCaption, paradisHubNavItem } from '../../paradisHub/electron-browser/paradisHubNav.js';
import { IParadisUsageSection } from './paradisUsageSection.js';

const $ = dom.$;

/** 開いた直後に見せるタブ。コマンド引数で指定できる。 */
export type ParadisUsageDashboardTab = 'ccusage' | 'spaces' | 'github' | 'rtk' | 'workStats' | 'settings';

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
const STR_NAV_SPACES = localize('paradis.usage.navSpaces', "スペース別");
// allow-any-unicode-next-line
const STR_NAV_WORK_STATS = localize('paradis.usage.navWorkStats', "作業実績");
// allow-any-unicode-next-line
const STR_NAV_SETTINGS = localize('paradis.usage.navSettings', "表示と取得元");
// allow-any-unicode-next-line
const STR_SETTINGS_HEAD = localize('paradis.usage.settingsHead', "表示と取得元");
// allow-any-unicode-next-line
const STR_SETTINGS_DESC = localize('paradis.usage.settingsDesc', "使用量の各画面が読む場所と取り方の設定です。タイトルバーとステータスバーに出すかどうかは、設定の「タイトルバーとステータスバー」にあります。");
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
	{ id: 'spaces', navLabel: STR_NAV_SPACES, icon: Codicon.repo, caption: undefined },
	{ id: 'github', navLabel: STR_NAV_GITHUB, icon: Codicon.github, caption: undefined },
	{ id: 'rtk', navLabel: STR_NAV_RTK, icon: Codicon.zap, caption: undefined },
	{ id: 'workStats', navLabel: STR_NAV_WORK_STATS, icon: Codicon.graph, caption: undefined },
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
	/** 文字列の配列の設定。カンマ区切りの 1 行で見せて書く。 */
	readonly list?: boolean;
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
		key: 'paradis.ccusage.archiveDirs',
		// allow-any-unicode-next-line
		label: localize('paradis.usage.ccusageArchiveDirs', "古い会話の記録の置き場"),
		// allow-any-unicode-next-line
		description: localize('paradis.usage.ccusageArchiveDirsDesc', "外付けやネットワークのディスクへ移した記録も AI コストに含めます。中の claude と codex を読みます。複数あるときはカンマで区切ります。つながっていない場所や、2 秒以内に確かめられない場所は飛ばします。応答しない場所が 2 つあると、ほかの場所も読めないことがあります。ccusage 20.0.14 以上が必要です。"),
		placeholder: '/Volumes/External/agent-archive',
		list: true,
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
		key: 'paradis.rtk.executablePath',
		// allow-any-unicode-next-line
		label: localize('paradis.usage.rtkPath', "rtk のパス"),
		// allow-any-unicode-next-line
		description: localize('paradis.usage.rtkPathDesc', "空欄なら自動で探します。SSH 中は接続先の rtk を使うので、リモート側の設定に書いてください。"),
		placeholder: STR_RTK_PATH_PLACEHOLDER,
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
	{
		key: 'paradis.limitsMonitor.codexHomes',
		// allow-any-unicode-next-line
		label: localize('paradis.usage.codexHomes', "追加で見る Codex のフォルダ"),
		// allow-any-unicode-next-line
		description: localize('paradis.usage.codexHomesDesc', "利用上限の残りを読む Codex のフォルダです。既定では ~/.codex とその派生を自動で探します。別の場所にもあるときだけ指定します。複数あるときはカンマで区切ります。"),
		list: true,
	},
	{
		key: 'paradis.codexAccounts.shareConversations',
		// allow-any-unicode-next-line
		label: localize('paradis.usage.codexShareConversations', "Codex のアカウントを切り替えたとき会話を共有する"),
		// allow-any-unicode-next-line
		description: localize('paradis.usage.codexShareConversationsDesc', "切り替えた2つのアカウントの間だけで会話の履歴を共有し、どちらのアカウントでも過去の会話を再開できるようにします。仕事用と個人用など、会話の中身を別のアカウントに見せたくないときはオフにします。"),
	},
];

export class ParadisUsageArea extends Disposable implements IParadisHubAreaView {

	private readonly _contentEl: HTMLElement;
	private readonly _navItems = new Map<ParadisUsageDashboardTab, IParadisHubNavItem>();
	private readonly _panes = new Map<ParadisUsageDashboardTab, HTMLElement>();
	private readonly _sections = new Map<ParadisUsageDashboardTab, IParadisUsageSection>();
	private readonly _settingRefreshers: (() => void)[] = [];
	private _activeTab: ParadisUsageDashboardTab = 'ccusage';
	private _visible = false;

	constructor(
		containers: IParadisHubAreaContainers,
		private readonly host: IParadisHubHost,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();

		// ---------- 見出しの行の「更新」 ----------
		const refreshBtn = dom.append(containers.header, $('button.pud-refresh')) as HTMLButtonElement;
		refreshBtn.type = 'button';
		refreshBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		dom.append(refreshBtn, $('span')).textContent = STR_REFRESH;
		this._register(dom.addDisposableListener(refreshBtn, 'click', () => this._refreshActive()));

		// ---------- 左のナビと本文 ----------
		this._contentEl = containers.content;
		this._contentEl.classList.add('paradis-usage-area');
		for (const spec of TABS) {
			if (spec.caption) {
				paradisHubNavCaption(containers.nav, spec.caption);
			}
			const item = paradisHubNavItem(containers.nav, spec.navLabel, { icon: spec.icon });
			this._navItems.set(spec.id, item);
			this._register(dom.addDisposableListener(item.element, 'click', () => this._selectTab(spec.id)));

			const pane = dom.append(this._contentEl, $('.pud-pane'));
			pane.classList.add('hidden');
			this._panes.set(spec.id, pane);
		}

		// パネル本体は各ダッシュボードのセクションクラスをそのまま使う
		this._addSection('ccusage', this._register(instantiationService.createInstance(ParadisCcusageSection)));
		this._addSection('github', this._register(instantiationService.createInstance(ParadisGithubMetricsSection)));
		this._addSection('rtk', this._register(instantiationService.createInstance(ParadisRtkSection)));
		this._addSection('spaces', this._register(instantiationService.createInstance(ParadisSpaceUsageSection)));
		this._addSection('workStats', this._register(instantiationService.createInstance(ParadisWorkStatsSection)));
		this._buildSettingsPane(this._panes.get('settings')!);
	}

	reveal(section: string | undefined): void {
		const tab = TABS.find(spec => spec.id === section)?.id ?? this._activeTab;
		this._selectTab(tab);
	}

	setVisible(visible: boolean): void {
		this._visible = visible;
		// 見えていないパネルはポーリング・warm lease を止める（見ていないもののために CLI を回し続けない）
		for (const [id, section] of this._sections) {
			section.setVisible(visible && id === this._activeTab);
		}
	}

	layout(width: number): void {
		// 幅は器でしか分からない（セクションは自分の親を測らない設計）ので、器が実測した値を流し込む
		for (const section of this._sections.values()) {
			section.layout(width);
		}
	}

	// ==========================================================================================

	private _addSection(tab: ParadisUsageDashboardTab, section: IParadisUsageSection): void {
		this._sections.set(tab, section);
		this._panes.get(tab)!.appendChild(section.element);
	}

	private _selectTab(tab: ParadisUsageDashboardTab): void {
		this._activeTab = tab;
		for (const [id, item] of this._navItems) {
			item.setActive(id === tab);
		}
		for (const [id, pane] of this._panes) {
			pane.classList.toggle('hidden', id !== tab);
		}
		this.setVisible(this._visible);
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
				const choices = spec.choices.map(choice => ({ value: String(choice.value), label: choice.label }));
				const select = store.add(new ParadisSelect(row, this.contextViewService, choices, undefined, { ariaLabel: spec.label, className: 'pud-select' }));
				// 用意した刻みに載らない値が既に入っていることがあるので、そのときは
				// 実際の値を選択肢へ足して選んでおく（開いただけで設定が変わったように見せない）
				const sync = () => {
					const current = String(this.configurationService.getValue(spec.key) ?? '');
					const known = choices.some(choice => choice.value === current);
					select.setOptions(known ? choices : [...choices, { value: current, label: current }], current);
				};
				sync();
				this._settingRefreshers.push(sync);
				store.add(select.onDidChange(value => {
					void this.configurationService.updateValue(spec.key, Number(value), ConfigurationTarget.USER);
				}));
			} else if (spec.list) {
				const input = dom.append(row, $('input.pud-input')) as HTMLInputElement;
				input.type = 'text';
				input.spellcheck = false;
				input.placeholder = spec.placeholder ?? STR_UNSET;
				const sync = () => {
					const current = this.configurationService.getValue<unknown>(spec.key);
					input.value = Array.isArray(current) ? current.join(', ') : '';
				};
				sync();
				this._settingRefreshers.push(sync);
				store.add(dom.addDisposableListener(input, 'change', () => {
					const items = input.value.split(',').map(item => item.trim()).filter(item => item.length > 0);
					void this.configurationService.updateValue(spec.key, items, ConfigurationTarget.USER);
				}));
			} else if (typeof this.configurationService.getValue(spec.key) === 'boolean') {
				const toggle = store.add(new ParadisSwitch(row, { checked: this.configurationService.getValue<boolean>(spec.key) === true, ariaLabel: spec.label }));
				const sync = () => { toggle.checked = this.configurationService.getValue<boolean>(spec.key) === true; };
				this._settingRefreshers.push(sync);
				store.add(toggle.onDidChange(checked => {
					void this.configurationService.updateValue(spec.key, checked, ConfigurationTarget.USER);
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
		const displayBtn = dom.append(footer, $('button.pud-btn')) as HTMLButtonElement;
		// allow-any-unicode-next-line
		displayBtn.textContent = localize('paradis.usage.openDisplaySettings', "タイトルバーとステータスバーの表示を開く");
		store.add(dom.addDisposableListener(displayBtn, 'click', () => this.host.open(ParadisHubAreaId.Settings, PARADIS_SETTINGS_TITLEBAR_SECTION_ID)));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('paradis')) {
				for (const refresh of this._settingRefreshers) {
					refresh();
				}
			}
		}));
	}
}
