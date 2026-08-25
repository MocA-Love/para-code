/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ccusage ダッシュボードの登録入り口。paradis.electron-browser.contribution.ts から import される。
// - ダッシュボード EditorPane / EditorInput シリアライザの登録
// - コマンド `paradis.ccusage.showDashboard`(コマンドパレット対応)
// - ステータスバー右端(通知ベルの左)の ccusage ボタン(今日のコストを定期表示、クリックでダッシュボード)
// - 設定 `paradis.ccusage.*` のスキーマ登録
// ccusage CLI 実行本体は shared process 側(node/paradisCcusageChannel.ts)にある。

import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
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
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { PARADIS_CCUSAGE_SETTING_EXEC_TIMEOUT_SECONDS } from '../common/paradisCcusage.js';
import { ParadisCcusageClient, PARADIS_CCUSAGE_SETTING_EXECUTABLE_PATH } from './paradisCcusageClient.js';
import { ParadisCcusageEditor } from './paradisCcusageEditor.js';
import { ParadisCcusageInput, ParadisCcusageInputSerializer, PARADIS_CCUSAGE_EDITOR_ID, PARADIS_CCUSAGE_INPUT_TYPE_ID } from './paradisCcusageInput.js';
import { paradisOpenUsageDashboard } from '../../usageDashboard/electron-browser/paradisUsageDashboard.contribution.js';

const SETTING_STATUS_BAR_ENABLED = 'paradis.ccusage.statusBar.enabled';
const SHOW_DASHBOARD_COMMAND_ID = 'paradis.ccusage.showDashboard';

/** ステータスバーのコスト表示の更新間隔。ccusage は毎回 JSONL を走査するので控えめにする。 */
const STATUS_POLL_INTERVAL_MS = 10 * 60 * 1000;
/** 起動直後の負荷を避けるための初回取得ディレイ。 */
const STATUS_INITIAL_DELAY_MS = 15 * 1000;

// ---------- editor pane / serializer ----------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ParadisCcusageEditor,
		PARADIS_CCUSAGE_EDITOR_ID,
		localize('paradis.ccusage.editorName', "ccusage Dashboard")
	),
	[
		new SyncDescriptor(ParadisCcusageInput)
	]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_CCUSAGE_INPUT_TYPE_ID,
	ParadisCcusageInputSerializer
);

// ---------- command ----------

registerAction2(class ShowCcusageDashboardAction extends Action2 {
	constructor() {
		super({
			id: SHOW_DASHBOARD_COMMAND_ID,
			title: localize2('paradis.ccusage.showDashboard', "Show ccusage Dashboard"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		// 3ダッシュボードは統合ダイアログの1タブになったので、こちらの入口からも
		// 同じダイアログを ccusage タブで開く（エディタタブとしての実装も残っているが、
		// 既定の導線はダイアログ側に一本化する）
		paradisOpenUsageDashboard(accessor, 'ccusage');
	}
});

// ---------- settings ----------

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradisCcusage',
	title: localize('paradis.ccusage.configTitle', "ccusage (Para Code)"),
	type: 'object',
	properties: {
		[PARADIS_CCUSAGE_SETTING_EXECUTABLE_PATH]: {
			type: 'string',
			default: '',
			// SSH/WSL 接続中は接続先の ccusage を実行するため、パスも接続先ごとに決まる必要がある。
			// マシンスコープにすると、接続中は手元の値が使われず接続先のマシン設定だけが効く
			// (手元の絶対パスを接続先へ送りつける事故が起きない)。この設定が明示されていると
			// サーバー側は自動探索も npx フォールバックも行わないため、手元のパスが渡ると接続中は
			// 常に ENOENT になり、しかもアプリケーションスコープでは接続先から上書きもできない。
			// rtk 側と同じ扱いに揃えてある。逆に、既定プロファイル以外を使っていて以前この設定を
			// 入れていた場合は、そのプロファイルの設定へ入れ直しになる(値そのものは消えない)。
			scope: ConfigurationScope.MACHINE,
			markdownDescription: localize('paradis.ccusage.executablePath', "Absolute path to the `ccusage` executable. When empty, Para Code looks for `ccusage` on PATH and common install locations, and falls back to `npx` with a pinned `ccusage` version for supply-chain safety. Set this path explicitly if you want to use a different (e.g. newer) version. While you are connected over SSH, the `ccusage` on the machine you are connected to is used, so set this in the remote settings if its path differs there."),
		},
		[SETTING_STATUS_BAR_ENABLED]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.ccusage.statusBarEnabled', "Show today's coding agent cost (via ccusage) in the status bar."),
		},
		[PARADIS_CCUSAGE_SETTING_EXEC_TIMEOUT_SECONDS]: {
			type: 'number',
			// 自由入力の数値ではなく候補からの選択にしてあるのは、Para Code 設定ダイアログの
			// _buildControl (paradisSettingsDialog.ts) が enum の無い number 型には専用の入力欄を
			// 持たず、標準の設定エディタへのリンクにフォールバックするため
			// (paradis.githubMetrics.refreshIntervalSeconds と同じ理由・同じ形)。
			// 上限を 10 分までにしてあるのは、warm(定期先取り更新)がこの4種のレポートを直列に
			// 実行するため(runWarmPass)。1本ごとの上限を長くすると「対象数 × タイムアウト」で
			// 1周が伸び、CACHE_TTL_MS を前提にした温め直しの不変条件が崩れてしまう。
			enum: [60, 120, 180, 300, 600],
			default: 180,
			// SSH 接続中は接続先で実行されるため、接続先ごとにログ量が違いうる executablePath と
			// 同じ理由でマシンスコープにする。既定プロファイル以外でも shared process から読める
			// よう APPLICATION_MACHINE にしてある(素の MACHINE だと既定プロファイル以外の
			// settings.json に書かれた値を shared process 側の ConfigurationService が見に行けない)。
			scope: ConfigurationScope.APPLICATION_MACHINE,
			enumDescriptions: [
				localize('paradis.ccusage.execTimeoutSeconds.60', "60 seconds."),
				localize('paradis.ccusage.execTimeoutSeconds.120', "2 minutes."),
				localize('paradis.ccusage.execTimeoutSeconds.180', "3 minutes (default)."),
				localize('paradis.ccusage.execTimeoutSeconds.300', "5 minutes."),
				localize('paradis.ccusage.execTimeoutSeconds.600', "10 minutes."),
			],
			markdownDescription: localize('paradis.ccusage.execTimeoutSeconds', "Timeout for a single `ccusage` invocation. `ccusage` scans the full session log history on every run, so this may need to be increased if you have a large amount of history (Claude Code / Codex / etc. logs)."),
		},
	},
});

// ---------- status bar item ----------

export class ParadisCcusageStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.contrib.ccusageStatusBar';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly warmLease = this._register(new MutableDisposable<IDisposable>());
	private readonly pollTimer = this._register(new IntervalTimer());
	private readonly initialFetch = this._register(new RunOnceScheduler(() => this.update(), STATUS_INITIAL_DELAY_MS));
	private readonly client: ParadisCcusageClient;
	private fetching = false;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.client = instantiationService.createInstance(ParadisCcusageClient);

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
			this.warmLease.clear();
			this.pollTimer.cancel();
			this.initialFetch.cancel();
			this.entry.clear();
			return;
		}
		this.warmLease.value ??= this.client.createStatusWarmLease();
		this.showEntry(undefined);
		// 起動直後は避けて初回取得し、以降は定期更新する
		this.initialFetch.schedule();
		this.pollTimer.cancelAndSet(() => this.update(), STATUS_POLL_INTERVAL_MS);
	}

	private showEntry(todayCost: number | undefined): void {
		const text = todayCost !== undefined ? `$(graph) $${todayCost.toFixed(2)}` : '$(graph) ccusage';
		const properties: IStatusbarEntry = {
			name: localize('paradis.ccusage.statusName', "ccusage"),
			text,
			ariaLabel: localize('paradis.ccusage.statusAria', "Coding agent usage (ccusage)"),
			tooltip: todayCost !== undefined
				? localize('paradis.ccusage.statusTooltip', "Today's coding agent cost: ${0} — click to open the ccusage dashboard", todayCost.toFixed(2))
				: localize('paradis.ccusage.statusTooltipNoData', "Open the ccusage usage dashboard"),
			command: SHOW_DASHBOARD_COMMAND_ID,
		};
		if (this.entry.value) {
			this.entry.value.update(properties);
		} else {
			// 通知ベル(priority -Infinity で右端固定)のすぐ左に置く
			this.entry.value = this.statusbarService.addEntry(properties, 'paradis.ccusage', StatusbarAlignment.RIGHT, -9990);
		}
	}

	private async update(): Promise<void> {
		if (this.fetching || !this.enabled) {
			return;
		}
		this.fetching = true;
		try {
			const todayCost = await this.client.fetchTodayCost();
			if (this.enabled) {
				this.showEntry(todayCost);
			}
		} catch {
			// ccusage 未インストール等。ボタン自体は開ける状態のまま維持する。
		} finally {
			this.fetching = false;
		}
	}
}

registerWorkbenchContribution2(ParadisCcusageStatusBarContribution.ID, ParadisCcusageStatusBarContribution, WorkbenchPhase.AfterRestored);
