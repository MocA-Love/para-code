/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// GitHub API 利用状況ビューの登録入り口。paradis.electron-browser.contribution.ts から import される。
// - ステータスバー右側（ccusage の右・通知ベルの左）の GitHub 項目。表示は残量%（主要資源のうち最小）
// - ホバーは短いテキストだけ。ポップオーバー（案A）はクリックでのみ開き、開いたら固定表示にする
// - ポップオーバーの「詳細を開く」でダッシュボード EditorPane（案B）
// - 設定 `paradis.githubMetrics.*` のスキーマ登録
// レート枠取得と計測本体は shared process 側(node/paradisGithubMetricsChannel.ts)にある。

import { $, getWindow } from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment, StatusbarEntryKind } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import {
	IParadisGithubMetricsSnapshot,
	paradisGithubSeverity,
	paradisGithubWorstRemainingRatio,
} from '../common/paradisGithubMetrics.js';
import { ParadisGithubMetricsClient, PARADIS_GITHUB_METRICS_SETTING_REFRESH_INTERVAL, PARADIS_GITHUB_METRICS_SETTING_STATUS_BAR_ENABLED } from './paradisGithubMetricsClient.js';
import { ParadisGithubMetricsEditor } from './paradisGithubMetricsEditor.js';
import { paradisGithubRoundedPercent } from './paradisGithubMetricsFormat.js';
import { ParadisGithubMetricsInput, ParadisGithubMetricsInputSerializer, PARADIS_GITHUB_METRICS_EDITOR_ID, PARADIS_GITHUB_METRICS_INPUT_TYPE_ID } from './paradisGithubMetricsInput.js';
import { paradisOpenUsageDashboard } from '../../usageDashboard/electron-browser/paradisUsageDashboard.contribution.js';
import { ParadisGithubMetricsPopover } from './paradisGithubMetricsPopover.js';

const SHOW_DASHBOARD_COMMAND_ID = 'paradis.githubMetrics.showDashboard';
/** ステータスバー項目のクリックでポップオーバーを開く内部コマンド（コマンドパレットには出さない）。 */
const SHOW_POPOVER_COMMAND_ID = 'paradis.githubMetrics.showPopover';

/** ステータスバー表示の更新間隔。gh を1回起動するだけだが、常駐表示なので控えめにする。 */
const STATUS_POLL_INTERVAL_MS = 2 * 60 * 1000;
/** 起動直後の負荷を避けるための初回取得ディレイ。 */
const STATUS_INITIAL_DELAY_MS = 20 * 1000;
/** ccusage(-9990) の右・通知ベル(-Infinity) の左。 */
const STATUS_BAR_PRIORITY = -9991;

/** ポップオーバーとウィンドウ右端の間に空ける余白。 */
const POPOVER_WINDOW_EDGE_MARGIN = 12;
/** ホバーの枠線（左右 1px ずつ）。ポップオーバーの外形に足すと実際の占有幅になる。 */
const HOVER_BORDER_WIDTH = 2;

// ---------- editor pane / serializer ----------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ParadisGithubMetricsEditor,
		PARADIS_GITHUB_METRICS_EDITOR_ID,
		localize('paradis.githubMetrics.editorName', "GitHub API 利用状況")
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
			title: localize2('paradis.githubMetrics.showDashboard', "GitHub API 利用状況を表示"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		// 3ダッシュボードは統合ダイアログの1タブになったので、こちらの入口からも
		// 同じダイアログを GitHub タブで開く（ステータスバーのクリックは引き続き軽量な
		// ポップオーバーで、その「詳細を開く」からここへ来る）
		paradisOpenUsageDashboard(accessor, 'github');
	}
});

// ---------- settings ----------

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradisGithubMetrics',
	title: localize('paradis.githubMetrics.configTitle', "GitHub API 利用状況（Para Code）"),
	type: 'object',
	properties: {
		[PARADIS_GITHUB_METRICS_SETTING_STATUS_BAR_ENABLED]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.githubMetrics.statusBarEnabled', "ステータスバーにGitHub APIのレート制限の残量を表示します。"),
		},
		[PARADIS_GITHUB_METRICS_SETTING_REFRESH_INTERVAL]: {
			type: 'number',
			enum: [0, 60, 300, 900],
			default: 60,
			scope: ConfigurationScope.APPLICATION,
			enumDescriptions: [
				localize('paradis.githubMetrics.refreshInterval.manual', "手動で更新したときだけ取得します。"),
				localize('paradis.githubMetrics.refreshInterval.60', "1分ごと。"),
				localize('paradis.githubMetrics.refreshInterval.300', "5分ごと。"),
				localize('paradis.githubMetrics.refreshInterval.900', "15分ごと。"),
			],
			description: localize('paradis.githubMetrics.refreshInterval', "GitHub APIダッシュボードを開いている間の自動更新間隔（秒）。0にすると手動更新のみになります。"),
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
	 * ポップオーバーを重ねる位置の基準。ステータスバー項目の中に空の span として置かれるので
	 * （statusbarItem.ts が `content` をそのまま項目の器へ追加する）、項目そのものを掴まなくても
	 * 位置が決められる。
	 */
	private readonly entryAnchor = $('span.paradis-ghm-anchor');
	/** 開いているポップオーバー（クリックのたびに開閉する）。 */
	private readonly popover = this._register(new MutableDisposable<IDisposable>());

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
		this._register(CommandsRegistry.registerCommand(SHOW_POPOVER_COMMAND_ID, () => this.togglePopover()));

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
			this.popover.clear();
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
			name: localize('paradis.githubMetrics.statusName', "GitHub API 利用状況"),
			text: ratio !== undefined ? `$(github) ${paradisGithubRoundedPercent(ratio)}%` : '$(github)',
			ariaLabel: ratio !== undefined
				? localize('paradis.githubMetrics.statusAria', "GitHub APIレート制限：残り{0}%", paradisGithubRoundedPercent(ratio))
				: localize('paradis.githubMetrics.statusAriaNoData', "GitHub API 利用状況"),
			// ホバーは短いテキストだけにする。ここに詳細（HTMLElement）を載せると、ステータスバーを
			// 通り過ぎるだけで 500ms 後に開き（statusbarPart の dynamicDelay）、離れて閉じ、
			// 直後は instantHover の猶予で遅延ゼロになって即また開く、を繰り返す。
			tooltip: this.statusTooltip(ratio),
			command: SHOW_POPOVER_COMMAND_ID,
			content: this.entryAnchor,
			kind,
		};

		if (this.entry.value) {
			this.entry.value.update(properties);
		} else {
			this.entry.value = this.statusbarService.addEntry(properties, 'paradis.githubMetrics', StatusbarAlignment.RIGHT, STATUS_BAR_PRIORITY);
		}
	}

	/**
	 * 接続中は接続先の枠と接続先で走った呼び出しを見ているので、どのマシンの数字かが分かるようにする
	 * （手元のウィンドウと数字が違って見えるのは、集計しているマシンが違うため）。
	 */
	private statusTooltip(ratio: number | undefined): string {
		const remoteHost = this.client.remoteHostLabel;
		if (ratio === undefined) {
			return remoteHost
				? localize('paradis.githubMetrics.statusTooltipNoDataRemote', "{0} のGitHub API利用状況 — クリックで詳細表示", remoteHost)
				: localize('paradis.githubMetrics.statusTooltipNoData', "GitHub API利用状況 — クリックで詳細表示");
		}
		return remoteHost
			? localize('paradis.githubMetrics.statusTooltipRemote', "{0} のGitHub APIレート制限：残り{1}% — クリックで詳細表示", remoteHost, paradisGithubRoundedPercent(ratio))
			: localize('paradis.githubMetrics.statusTooltip', "GitHub APIレート制限：残り{0}% — クリックで詳細表示", paradisGithubRoundedPercent(ratio));
	}

	/**
	 * ステータスバー項目のクリックでポップオーバーを開閉する。
	 *
	 * 固定表示（sticky）なのでマウスが離れても閉じない。ホバーで開いていた頃は、通りすがりに開いては
	 * 閉じ、閉じた直後は遅延ゼロで即また開く、を繰り返していた。取得のたびに表示が `$(github)` →
	 * `$(github) NN%` と変わって項目の幅が動くのも重なり、点滅しているように見えていた。
	 */
	private togglePopover(): void {
		// コマンドはキーバインドやコマンドパレットからも呼べるが、項目を出していないときに開くと
		// 基準にする要素が DOM に無く、画面の隅に貼り付いてしまう。
		if (!this.enabled || !this.entry.value) {
			return;
		}
		if (this.popover.value) {
			this.popover.clear();
			return;
		}
		this.popover.value = this.createPopover();
	}

	/**
	 * ホバーが自分の外側のクリックやウィンドウのフォーカス喪失で閉じたときに、こちらの参照も畳む。
	 * 残したままだと次のクリックが「閉じる」と解釈されて一度空振りする。
	 */
	private onPopoverHidden(store: IDisposable): void {
		// `MutableDisposable` は「旧値を dispose してから `_value` を更新する」ので、自分で畳んだ
		// ときもここへ再入し、その時点ではまだ自分が入って見える。今保持しているのが自分のときだけ触る
		// （`DisposableStore.dispose` は冪等なので、再入しても2周目で止まる）。
		if (this.popover.value === store) {
			this.popover.clear();
		}
	}

	/** ポップオーバー本体を作って固定表示のホバーとして重ねる。表示できなかった場合は undefined。 */
	private createPopover(): IDisposable | undefined {
		const store = new DisposableStore();

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
				this.popover.clear();
				void this.commandService.executeCommand(SHOW_DASHBOARD_COMMAND_ID);
			},
		}));

		// 空の span 自体には大きさが無いので、器（ステータスバー項目）に沿わせる。
		const anchor = this.entryAnchor.parentElement ?? this.entryAnchor;

		const hover = this.hoverService.showInstantHover({
			content: popover.element,
			target: {
				targetElements: [anchor],
				// 項目はステータスバーの右端付近にあるので、既定の「項目の中心へ左右中央揃え」だと必ず
				// 右へあふれ、hoverWidget 側がウィンドウ右端から 2px の位置へクランプしてしまう。
				// x を渡すとそのクランプ経路に入らないので、自前で余白を確保した位置を指定する。
				// 幅はホバーが DOM に入ってからでないと測れないため、測れない間は undefined を返して
				// 既定の位置決めに委ねる（三角のポインタは項目の中心へ寄せ直される）。
				get x(): number | undefined {
					const popoverWidth = popover.element.offsetWidth;
					if (popoverWidth === 0) {
						return undefined;
					}
					const availableWidth = getWindow(anchor).document.documentElement.clientWidth;
					// ウィンドウが狭くて収まらないときは左端に寄せる（負の x を返すと hoverWidget 側が
					// 「左へはみ出した」と見なして項目の位置まで押し戻し、逆に右へあふれてしまう）。
					return Math.max(0, availableWidth - popoverWidth - HOVER_BORDER_WIDTH - POPOVER_WINDOW_EDGE_MARGIN);
				},
			},
			position: { hoverPosition: HoverPosition.ABOVE },
			appearance: { showPointer: true, skipFadeInAnimation: true },
			// sticky なホバーでは hoverService 側の keydown 監視が付かないので、Escape で閉じられるのは
			// フォーカスがホバー内にある場合だけ。focus と trapFocus はそのための組み合わせでもある
			// （trapFocus を省くと、閉じたときに元の要素へフォーカスが戻らない）。
			persistence: { sticky: true },
			trapFocus: true,
			onDidHide: () => this.onPopoverHidden(store),
		}, true /* focus */);
		if (!hover) {
			// 他に固定表示のホバーが出ている等で表示されなかった。参照を残すとトグルが
			// 「閉じる」側に倒れたまま二度と開かなくなる。
			store.dispose();
			return undefined;
		}
		store.add(toDisposable(() => hover.dispose()));

		return store;
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
