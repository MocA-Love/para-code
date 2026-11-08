/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタのターミナル右上のコンテキストの使用率（paradisContextUsageBadge.ts）へ値を渡し、押されたら内訳の
// ポップオーバーを IHoverService の固定ホバーで開く。
//
// - 使用率: shared process のモバイル中継がペインごとに読んでいる値（insight の `context`）。Claude は Claude Mod の
//   `session.measure`、無ければ transcript。Codex は rollout の `token_count`。応答の途中でも進む
// - Claude の内訳: 同梱の mod が応答の終わりごとに送り、shared process が保存した最後の 1 件（ペイン単位で引く）。
//   取った時刻を添える（使用率より古いことがある）
// - Codex は内訳を記録しないので、全体の量とキャッシュの hit 率だけ

import * as dom from '../../../../base/browser/dom.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { fromNow } from '../../../../base/common/date.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { paradisRegisterEditorTerminalOverlay } from '../../agentBrowser/browser/paradisPaneIndicator.js';
import { PARADIS_CCUSAGE_OTHER_COLOR, PARADIS_CCUSAGE_SERIES_DARK, PARADIS_CCUSAGE_SERIES_LIGHT, paradisFormatTokens } from '../../ccusage/common/paradisCcusageFormat.js';
import { paradisRenderContextCategories, paradisRenderContextRowGroups } from '../../ccusage/electron-browser/paradisCcusageContextView.js';
import { IParadisClaudeContextBreakdown } from '../../claudeMod/common/paradisClaudeContextBreakdown.js';
import { ParadisClaudeContextClient } from '../../claudeMod/electron-browser/paradisClaudeContextClient.js';
import { createParadisContextUsageBadge, IParadisContextUsageBadgeHost, IParadisContextUsageReading, paradisContextUsagePopoverSize } from '../browser/paradisContextUsageBadge.js';
import { IParadisAgentInsightsService, IParadisAgentPaneInsight } from '../common/paradisAgentInsights.js';

const $ = dom.$;

/** 「AI コスト」の画面を開くコマンド（paradisCcusage.contribution.ts）。 */
const SHOW_COST_DASHBOARD_COMMAND_ID = 'paradis.ccusage.showDashboard';

/**
 * 固定で開く fork のポップオーバーに付ける印（paradisFocusRing.css）。本家の固定ホバーの外枠の外に重なる
 * outline を消し、キーボードのフォーカスは外枠の色で 1 本に出す。
 */
const POPOVER_HOVER_CLASS = 'paradis-popover-hover';

/**
 * 輪は右端にあるので、ホバーの右端を輪の右端にそろえて左向きに開く（既定の中央寄せだと右隣のエディタのグループへ
 * はみ出す）。1 行のホバーと内訳のポップオーバーで共通。
 */
const HOVER_POSITION = { hoverPosition: HoverPosition.BELOW, anchorAlignment: AnchorAlignment.RIGHT };

/** 使用率を出すペイン（Claude・Codex で、リクエストが 1 回以上ある）の様子。 */
type ParadisContextPaneInsight = IParadisAgentPaneInsight & { readonly agent: 'claude' | 'codex'; readonly context: NonNullable<IParadisAgentPaneInsight['context']> };

function contextPane(insight: IParadisAgentPaneInsight | undefined): ParadisContextPaneInsight | undefined {
	return insight !== undefined && (insight.agent === 'claude' || insight.agent === 'codex') && insight.context !== undefined
		? insight as ParadisContextPaneInsight
		: undefined;
}

/** `238.7K / 1M`（使用量が分からなければ窓だけ）。 */
function usageText(context: ParadisContextPaneInsight['context']): string {
	return context.tokens !== undefined
		? localize('paradis.contextUsage.tokens', "{0} / {1}", paradisFormatTokens(context.tokens), paradisFormatTokens(context.window))
		: localize('paradis.contextUsage.window', "窓 {0}", paradisFormatTokens(context.window));
}

class ParadisContextUsageContribution extends Disposable implements IWorkbenchContribution, IParadisContextUsageBadgeHost {

	static readonly ID = 'workbench.contrib.paradisContextUsage';

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly client: ParadisClaudeContextClient;
	/** 開いているポップオーバーの購読（開き直すと前のものを外す）。 */
	private readonly details = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IParadisAgentInsightsService private readonly insightsService: IParadisAgentInsightsService,
		@IHoverService private readonly hoverService: IHoverService,
		@IThemeService private readonly themeService: IThemeService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.client = instantiationService.createInstance(ParadisClaudeContextClient);
		this._register(this.insightsService.onDidChange(() => this._onDidChange.fire()));
		this._register(paradisRegisterEditorTerminalOverlay(container => createParadisContextUsageBadge(container, this)));
	}

	read(instanceId: number): IParadisContextUsageReading | undefined {
		const pane = contextPane(this.insightsService.getForInstance(instanceId));
		return pane !== undefined ? { percent: pane.context.percent } : undefined;
	}

	tooltip(instanceId: number): string {
		const pane = contextPane(this.insightsService.getForInstance(instanceId));
		return pane !== undefined
			? localize('paradis.contextUsage.tooltip', "コンテキスト {0}% 使用（{1}）。押すと内訳を開きます", pane.context.percent, usageText(pane.context))
			: '';
	}

	setupHover(element: HTMLElement, content: () => string): IDisposable {
		return this.hoverService.setupDelayedHover(element, () => ({
			content: content(),
			appearance: { showPointer: true, compact: true },
			position: HOVER_POSITION,
		}));
	}

	openDetails(element: HTMLElement, instanceId: number): void {
		const pane = contextPane(this.insightsService.getForInstance(instanceId));
		if (pane === undefined) {
			return;
		}
		const store = new DisposableStore();
		this.details.value = store;
		const root = $('.paradis-context-usage-details');
		const rendered = store.add(new MutableDisposable<DisposableStore>());
		// 開いていた一覧は、描き直しても開いたままにする（toggle は泳がないので捕まえる側で受ける）
		const openGroups = new Set<string>();
		store.add(dom.addDisposableListener(root, 'toggle', e => {
			const details = e.target;
			if (dom.isHTMLElement(details) && details.tagName === 'DETAILS' && details.dataset.group !== undefined) {
				if ((details as HTMLDetailsElement).open) {
					openGroups.add(details.dataset.group);
				} else {
					openGroups.delete(details.dataset.group);
				}
			}
		}, true));
		let breakdown: IParadisClaudeContextBreakdown | undefined;
		let fetching = 0;
		let closed = false;
		const close = () => {
			closed = true;
			if (this.details.value === store) {
				this.details.clear();
			}
		};
		const render = () => {
			if (closed) {
				return;
			}
			this.fitDetails(root, element);
			const current = contextPane(this.insightsService.getForInstance(instanceId)) ?? pane;
			// 描き直すたびに、前の描画のリスナーを外す
			const renderStore = new DisposableStore();
			rendered.value = renderStore;
			this.renderDetails(root, current, current.agent === 'claude' ? breakdown : undefined, openGroups, renderStore);
		};
		const fetch = async () => {
			if (pane.agent !== 'claude' || closed) {
				return;
			}
			const generation = ++fetching;
			const next = await this.client.pane(pane.token).catch(() => undefined);
			if (generation === fetching && !closed) {
				breakdown = next;
				render();
			}
		};
		render();
		void fetch();
		store.add(this.insightsService.onDidChange(render));
		if (pane.agent === 'claude') {
			store.add(this.client.onDidChange(() => void fetch()));
		}
		const widget = this.hoverService.showInstantHover({
			content: root,
			target: element,
			persistence: { hideOnHover: false, sticky: true },
			appearance: { showPointer: true, compact: true },
			position: HOVER_POSITION,
			additionalClasses: [POPOVER_HOVER_CLASS],
			trapFocus: true,
			// 閉じたら購読を外す
			onDidHide: close,
		}, true);
		if (widget === undefined) {
			close();
		}
	}

	/**
	 * 内訳をエディタのターミナルの中に収める。幅は輪の右端からターミナルの左端まで、高さはターミナルの下端までに抑え、
	 * 入りきらない分は中でスクロールする。描き直すたびに測り直す（開いたまま分割や幅の変更があっても追う）。
	 */
	private fitDetails(root: HTMLElement, anchor: HTMLElement): void {
		const frame = anchor.closest('.terminal-overflow-guard') ?? anchor.parentElement;
		if (!frame) {
			return;
		}
		const size = paradisContextUsagePopoverSize(anchor.getBoundingClientRect(), frame.getBoundingClientRect());
		root.style.width = `${size.width}px`;
		root.style.maxHeight = `${size.maxHeight}px`;
	}

	private renderDetails(root: HTMLElement, pane: ParadisContextPaneInsight, breakdown: IParadisClaudeContextBreakdown | undefined, openGroups: ReadonlySet<string>, disposables: DisposableStore): void {
		dom.clearNode(root);

		const header = dom.append(root, $('.paradis-context-usage-header'));
		dom.append(header, $('span.title')).textContent = localize('paradis.contextUsage.title', "コンテキスト");
		const model = breakdown?.model ?? pane.model;
		if (model !== undefined) {
			dom.append(header, $('span.model')).textContent = model;
		}
		const summary = dom.append(root, $('.paradis-context-usage-summary'));
		dom.append(summary, $('span.percent')).textContent = localize('paradis.contextUsage.used', "{0}% 使用", pane.context.percent);
		dom.append(summary, $('span.tokens')).textContent = usageText(pane.context);

		if (breakdown !== undefined) {
			const light = this.themeService.getColorTheme().type === ColorScheme.LIGHT || this.themeService.getColorTheme().type === ColorScheme.HIGH_CONTRAST_LIGHT;
			paradisRenderContextCategories(root, breakdown, { palette: light ? PARADIS_CCUSAGE_SERIES_LIGHT : PARADIS_CCUSAGE_SERIES_DARK, otherColor: PARADIS_CCUSAGE_OTHER_COLOR });
			paradisRenderContextRowGroups(root, breakdown, true, group => openGroups.has(group));
			const foot = dom.append(root, $('.paradis-context-usage-foot'));
			dom.append(foot, $('span')).textContent = localize('paradis.contextUsage.breakdownAt', "内訳の取得: {0}（その時点 {1}%）", fromNow(breakdown.at, true), breakdown.percent);
			const link = dom.append(foot, $<HTMLAnchorElement>('a.paradis-context-usage-link'));
			link.textContent = localize('paradis.contextUsage.openCost', "AI コストで開く");
			link.tabIndex = 0;
			link.setAttribute('role', 'button');
			const openCost = (e: Event) => {
				e.preventDefault();
				this.hoverService.hideHover(true);
				void this.commandService.executeCommand(SHOW_COST_DASHBOARD_COMMAND_ID);
			};
			disposables.add(dom.addDisposableListener(link, dom.EventType.CLICK, openCost));
			disposables.add(dom.addDisposableListener(link, dom.EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' || e.key === ' ') {
					openCost(e);
				}
			}));
			return;
		}

		const bar = dom.append(root, $('.paradis-context-usage-bar'));
		dom.append(bar, $('span')).style.width = `${Math.max(0, Math.min(100, pane.context.percent))}%`;
		if (pane.agent === 'codex' && pane.cacheSummary !== undefined) {
			const cache = pane.cacheSummary;
			if (cache.hitRatio !== undefined) {
				this.appendValue(root, localize('paradis.contextUsage.cacheHitRatio', "キャッシュの hit 率"), localize('paradis.contextUsage.percentValue', "{0}%", Math.round(cache.hitRatio * 100)));
			}
			this.appendValue(root, localize('paradis.contextUsage.requests', "リクエスト"), localize('paradis.contextUsage.requestsValue', "{0} 回（hit {1}・miss {2}）", cache.requests, cache.hits, cache.misses));
		}
		dom.append(root, $('.paradis-context-usage-hint')).textContent = pane.agent === 'codex'
			? localize('paradis.contextUsage.codexHint', "Codex は内訳（メモリファイル・MCP など）を記録しないため、全体の量だけを出します。")
			: localize('paradis.contextUsage.claudeHint', "内訳は、Claude Mod が有効なとき、応答が終わるたびに取れます。");
	}

	private appendValue(root: HTMLElement, name: string, value: string): void {
		const row = dom.append(root, $('.paradis-context-usage-value'));
		dom.append(row, $('span.name')).textContent = name;
		dom.append(row, $('span.value')).textContent = value;
	}
}

registerWorkbenchContribution2(ParadisContextUsageContribution.ID, ParadisContextUsageContribution, WorkbenchPhase.AfterRestored);
