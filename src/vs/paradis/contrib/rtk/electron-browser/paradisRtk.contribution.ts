/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// RTK 節約ダッシュボードの登録入り口。paradis.electron-browser.contribution.ts から import される。
// - ダッシュボード EditorPane / EditorInput シリアライザの登録
// - コマンド `paradis.rtk.showDashboard`(コマンドパレット対応)
// - ステータスバー右側(ccusage ボタンの左)の rtk ボタン(今日の節約量を定期表示、クリックでダッシュボード)
// - 設定 `paradis.rtk.*` のスキーマ登録
// rtk CLI 実行本体は shared process 側(node/paradisRtkChannel.ts)にある。

import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { isParadisRtkNotFoundError, paradisRtkFormatTokens } from '../common/paradisRtk.js';
import { ParadisRtkClient, PARADIS_RTK_SETTING_EXECUTABLE_PATH } from './paradisRtkClient.js';
import { ParadisRtkEditor } from './paradisRtkEditor.js';
import { ParadisRtkInput, ParadisRtkInputSerializer, PARADIS_RTK_EDITOR_ID, PARADIS_RTK_INPUT_TYPE_ID } from './paradisRtkInput.js';

const SETTING_STATUS_BAR_ENABLED = 'paradis.rtk.statusBar.enabled';
const SHOW_DASHBOARD_COMMAND_ID = 'paradis.rtk.showDashboard';

/** ステータスバーの節約量表示の更新間隔。 */
const STATUS_POLL_INTERVAL_MS = 10 * 60 * 1000;
/** 起動直後の負荷を避けるための初回取得ディレイ。 */
const STATUS_INITIAL_DELAY_MS = 15 * 1000;

// ---------- editor pane / serializer ----------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ParadisRtkEditor,
		PARADIS_RTK_EDITOR_ID,
		localize('paradis.rtk.editorName', "RTK 節約ダッシュボード")
	),
	[
		new SyncDescriptor(ParadisRtkInput)
	]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_RTK_INPUT_TYPE_ID,
	ParadisRtkInputSerializer
);

// ---------- command ----------

registerAction2(class ShowRtkDashboardAction extends Action2 {
	constructor() {
		super({
			id: SHOW_DASHBOARD_COMMAND_ID,
			title: localize2('paradis.rtk.showDashboard', "RTK 節約ダッシュボードを表示"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor(ParadisRtkInput.instance, { pinned: true });
	}
});

// ---------- settings ----------

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradisRtk',
	title: localize('paradis.rtk.configTitle', "RTK (Para Code)"),
	type: 'object',
	properties: {
		[PARADIS_RTK_SETTING_EXECUTABLE_PATH]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.rtk.executablePath', "`rtk` 実行ファイルの絶対パス。空の場合は PATH 上の `rtk` を使います。"),
		},
		[SETTING_STATUS_BAR_ENABLED]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.rtk.statusBarEnabled', "今日 rtk が削減したトークン数をステータスバーに表示します。"),
		},
	},
});

// ---------- status bar item ----------

class ParadisRtkStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.contrib.rtkStatusBar';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly pollTimer = this._register(new IntervalTimer());
	private readonly initialFetch = this._register(new RunOnceScheduler(() => this.update(), STATUS_INITIAL_DELAY_MS));
	private readonly client: ParadisRtkClient;
	private fetching = false;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.client = instantiationService.createInstance(ParadisRtkClient);

		this.applyEnabled();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SETTING_STATUS_BAR_ENABLED)) {
				this.applyEnabled();
			}
		}));
	}

	private get enabled(): boolean {
		return this.configurationService.getValue<boolean>(SETTING_STATUS_BAR_ENABLED) !== false;
	}

	private applyEnabled(): void {
		if (!this.enabled) {
			this.pollTimer.cancel();
			this.initialFetch.cancel();
			this.entry.clear();
			return;
		}
		this.showEntry(undefined, false);
		// 起動直後は避けて初回取得し、以降は定期更新する
		this.initialFetch.schedule();
		this.pollTimer.cancelAndSet(() => this.update(), STATUS_POLL_INTERVAL_MS);
	}

	private showEntry(todaySaved: number | undefined, notFound: boolean): void {
		const text = todaySaved !== undefined ? `$(zap) ${paradisRtkFormatTokens(todaySaved)} 節約` : '$(zap) rtk';
		let tooltip: string;
		if (notFound) {
			// 未検出でもボタンは残す(ダッシュボードにインストール手順を出しているため)。
			tooltip = localize('paradis.rtk.statusTooltipNotFound', "rtk が見つかりません — クリックすると案内を表示します");
		} else if (todaySaved !== undefined) {
			tooltip = localize('paradis.rtk.statusTooltip', "今日 rtk が削減したトークン数: {0} — クリックで RTK 節約ダッシュボードを開きます", paradisRtkFormatTokens(todaySaved));
		} else {
			tooltip = localize('paradis.rtk.statusTooltipNoData', "RTK 節約ダッシュボードを開きます");
		}
		const properties: IStatusbarEntry = {
			name: localize('paradis.rtk.statusName', "RTK"),
			text,
			ariaLabel: localize('paradis.rtk.statusAria', "rtk によるトークン節約量"),
			tooltip,
			command: SHOW_DASHBOARD_COMMAND_ID,
		};
		if (this.entry.value) {
			this.entry.value.update(properties);
		} else {
			// ccusage(-9990) のさらに左。githubMetrics が -9991 を使っているため、その左(-9993)に置く
			// (おやすみモードの -9992 とも衝突しない値を選んでいる)。
			this.entry.value = this.statusbarService.addEntry(properties, 'paradis.rtk', StatusbarAlignment.RIGHT, -9993);
		}
	}

	private async update(): Promise<void> {
		if (this.fetching || !this.enabled) {
			return;
		}
		this.fetching = true;
		try {
			const todaySaved = await this.client.fetchTodaySaved();
			if (this.enabled) {
				this.showEntry(todaySaved, false);
			}
		} catch (error) {
			// rtk 未インストール等。ボタン自体は開ける状態のまま維持する。
			if (this.enabled) {
				this.showEntry(undefined, isParadisRtkNotFoundError(error));
			}
		} finally {
			this.fetching = false;
		}
	}
}

registerWorkbenchContribution2(ParadisRtkStatusBarContribution.ID, ParadisRtkStatusBarContribution, WorkbenchPhase.AfterRestored);
