/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// GitHub API 利用状況ビューの登録入り口。paradis.electron-browser.contribution.ts から import される。
// - ステータスバー右側（ccusage の右・通知ベルの左）の GitHub 項目。表示は残量%（主要資源のうち最小）
// - クリックでポップオーバー（案A）。ShowTooltipCommand + tooltip(HTMLElement) で開く
// - ポップオーバーの「詳細を開く」でダッシュボード EditorPane（案B）
// - 設定 `paradis.githubMetrics.*` のスキーマ登録
// レート枠取得と計測本体は shared process 側(node/paradisGithubMetricsChannel.ts)にある。

import { disposableWindowInterval } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, ShowTooltipCommand, StatusbarAlignment, StatusbarEntryKind } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import {
	IParadisGithubMetricsSnapshot,
	paradisGithubSeverity,
	paradisGithubWorstRemainingRatio,
} from '../common/paradisGithubMetrics.js';
import { ParadisGithubMetricsClient, PARADIS_GITHUB_METRICS_SETTING_STATUS_BAR_ENABLED } from './paradisGithubMetricsClient.js';
import { ParadisGithubMetricsEditor } from './paradisGithubMetricsEditor.js';
import { paradisGithubRoundedPercent } from './paradisGithubMetricsFormat.js';
import { ParadisGithubMetricsInput, ParadisGithubMetricsInputSerializer, PARADIS_GITHUB_METRICS_EDITOR_ID, PARADIS_GITHUB_METRICS_INPUT_TYPE_ID } from './paradisGithubMetricsInput.js';
import { ParadisGithubMetricsPopover } from './paradisGithubMetricsPopover.js';

const SHOW_DASHBOARD_COMMAND_ID = 'paradis.githubMetrics.showDashboard';

/** ステータスバー表示の更新間隔。gh を1回起動するだけだが、常駐表示なので控えめにする。 */
const STATUS_POLL_INTERVAL_MS = 2 * 60 * 1000;
/** 起動直後の負荷を避けるための初回取得ディレイ。 */
const STATUS_INITIAL_DELAY_MS = 20 * 1000;
/** ポップオーバーが閉じられたことを検知して破棄するための確認間隔。 */
const POPOVER_DISCONNECT_CHECK_MS = 2000;
/** ccusage(-9990) の右・通知ベル(-Infinity) の左。 */
const STATUS_BAR_PRIORITY = -9991;

// ---------- editor pane / serializer ----------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ParadisGithubMetricsEditor,
		PARADIS_GITHUB_METRICS_EDITOR_ID,
		localize('paradis.githubMetrics.editorName', "GitHub API Usage")
	),
	[
		new SyncDescriptor(ParadisGithubMetricsInput)
	]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_GITHUB_METRICS_INPUT_TYPE_ID,
	ParadisGithubMetricsInputSerializer
);

// ---------- command ----------

registerAction2(class ShowGithubMetricsDashboardAction extends Action2 {
	constructor() {
		super({
			id: SHOW_DASHBOARD_COMMAND_ID,
			title: localize2('paradis.githubMetrics.showDashboard', "Show GitHub API Usage"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor(ParadisGithubMetricsInput.instance, { pinned: true });
	}
});

// ---------- settings ----------

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradisGithubMetrics',
	title: localize('paradis.githubMetrics.configTitle', "GitHub API Usage (Para Code)"),
	type: 'object',
	properties: {
		[PARADIS_GITHUB_METRICS_SETTING_STATUS_BAR_ENABLED]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.githubMetrics.statusBarEnabled', "Show the remaining GitHub API rate limit in the status bar."),
		},
	},
});

// ---------- status bar item ----------

class ParadisGithubMetricsStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.contrib.githubMetricsStatusBar';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly pollTimer = this._register(new IntervalTimer());
	private readonly initialFetch = this._register(new RunOnceScheduler(() => void this.update(), STATUS_INITIAL_DELAY_MS));
	private readonly client: ParadisGithubMetricsClient;
	/**
	 * tooltip は「同じオブジェクトかどうか」で更新要否が判定される（statusbarItem.ts の isEqualTooltip）。
	 * 毎回作り直すと残量%を更新するたびにホバーが作り直され、開いているポップオーバーが閉じてしまうため、
	 * 生成は1回だけにして以降は使い回す。
	 */
	private readonly popoverTooltip: IStatusbarEntry['tooltip'] = { element: (token: CancellationToken) => this.createPopover(token) };

	private snapshot: IParadisGithubMetricsSnapshot | undefined;
	private fetching = false;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this.client = this.instantiationService.createInstance(ParadisGithubMetricsClient);

		this.applyEnabled();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_GITHUB_METRICS_SETTING_STATUS_BAR_ENABLED)) {
				this.applyEnabled();
			}
		}));
	}

	private get enabled(): boolean {
		return this.configurationService.getValue<boolean>(PARADIS_GITHUB_METRICS_SETTING_STATUS_BAR_ENABLED) !== false;
	}

	private applyEnabled(): void {
		if (!this.enabled) {
			this.pollTimer.cancel();
			this.initialFetch.cancel();
			this.entry.clear();
			return;
		}
		this.showEntry();
		// 起動直後は避けて初回取得し、以降は定期更新する
		this.initialFetch.schedule();
		this.pollTimer.cancelAndSet(() => void this.update(), STATUS_POLL_INTERVAL_MS);
	}

	private showEntry(): void {
		const ratio = this.snapshot ? paradisGithubWorstRemainingRatio(this.snapshot.rateLimits) : undefined;
		const severity = paradisGithubSeverity(ratio);
		const kind: StatusbarEntryKind | undefined = severity === 'critical' ? 'error' : severity === 'warning' ? 'warning' : undefined;

		const properties: IStatusbarEntry = {
			name: localize('paradis.githubMetrics.statusName', "GitHub API Usage"),
			text: ratio !== undefined ? `$(github) ${paradisGithubRoundedPercent(ratio)}%` : '$(github)',
			ariaLabel: ratio !== undefined
				? localize('paradis.githubMetrics.statusAria', "GitHub API rate limit: {0}% left", paradisGithubRoundedPercent(ratio))
				: localize('paradis.githubMetrics.statusAriaNoData', "GitHub API usage"),
			tooltip: this.popoverTooltip,
			command: ShowTooltipCommand,
			kind,
		};

		if (this.entry.value) {
			this.entry.value.update(properties);
		} else {
			this.entry.value = this.statusbarService.addEntry(properties, 'paradis.githubMetrics', StatusbarAlignment.RIGHT, STATUS_BAR_PRIORITY);
		}
	}

	/**
	 * クリック時に開くポップオーバー本体を作る。tooltip の CancellationToken で破棄されるが、
	 * 閉じ方によっては token が発火しないことがある（upstream の Copilot ステータスも同じ回避策を持つ）
	 * ため、DOM から外れたことを検知して確実に破棄する。
	 */
	private createPopover(token: CancellationToken): HTMLElement {
		const store = new DisposableStore();
		store.add(token.onCancellationRequested(() => store.dispose()));

		const popover = store.add(new ParadisGithubMetricsPopover({
			fetch: async (force: boolean) => {
				const snapshot = await this.client.getSnapshot(force);
				// ポップオーバーで取り直した結果をステータスバーにも反映する
				this.snapshot = snapshot;
				if (this.enabled) {
					this.showEntry();
				}
				return snapshot;
			},
			openDashboard: () => {
				this.hoverService.hideHover();
				void this.commandService.executeCommand(SHOW_DASHBOARD_COMMAND_ID);
			},
		}));

		store.add(disposableWindowInterval(mainWindow, () => {
			if (!popover.element.isConnected) {
				store.dispose();
			}
		}, POPOVER_DISCONNECT_CHECK_MS));

		return popover.element;
	}

	private async update(): Promise<void> {
		if (this.fetching || !this.enabled) {
			return;
		}
		this.fetching = true;
		try {
			this.snapshot = await this.client.getSnapshot(false);
			if (this.enabled) {
				this.showEntry();
			}
		} catch {
			// gh 未インストール等。ボタン自体はポップオーバーを開ける状態のまま維持する。
		} finally {
			this.fetching = false;
		}
	}
}

registerWorkbenchContribution2(ParadisGithubMetricsStatusBarContribution.ID, ParadisGithubMetricsStatusBarContribution, WorkbenchPhase.AfterRestored);
