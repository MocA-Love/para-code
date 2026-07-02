/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CPU/RAMモニタのクリックで開く内訳パネル(Superset apps/desktop の TopBar
// ResourceConsumption ポップオーバー移植)。upstreamの Dialog/ContextView には依存せず、
// paradisBindingDialog.ts と同様に自前のDOM(絶対配置)をworkbenchコンテナへ重ねる方式。
// 色は --vscode-* テーマトークンを使い、重大度アクセント(amber/red)のみ固定値
// (paradisWorkspaceSwitch.css のエージェント状態色と同じ配色)。
//
// ポーリングはこのパネル自身では行わない(paradisResourceMonitorWidget.ts が唯一のポーリング主体で、
// 表示中はパネル生成時に開いてもらったスケジュールで updateSnapshot()/setFetching() を呼んでもらう
// だけの受け身のビュー)。これによりトリガーの数値とパネルの内訳が常に同じデータソースを共有し、
// 二重ポーリングを避ける。

import './media/paradisResourceMonitor.css';
import * as dom from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IParadisResourceMonitorScopeMetrics, IParadisResourceMonitorSessionMetrics, IParadisResourceMonitorSnapshot, IParadisResourceUsage } from '../common/paradisResourceMonitor.js';
import { ParadisUsageSeverity, paradisFormatCpu, paradisFormatMemory, paradisFormatPercent, paradisGetTrackedHostMemorySeverity, paradisGetUsageSeverity } from '../common/paradisResourceMonitorFormat.js';
import { PARADIS_RESOURCE_MONITOR_OTHER_TERMINALS_STATE_KEY } from './paradisResourceMonitorClient.js';

const $ = dom.$;

type ParadisResourceMonitorSortOption = 'memory' | 'cpu' | 'name';

const PANEL_WIDTH = 420;

export interface IParadisResourceMonitorPanelOptions {
	/** 生成時点でウィジェットが既に持っている最新のスナップショット(あれば "Loading…" を出さずに即描画)。 */
	readonly initialSnapshot: IParadisResourceMonitorSnapshot | undefined;
	readonly onManualRefresh: () => void;
	readonly onClose: () => void;
	readonly switchToScope: (stateKey: string) => void;
}

/**
 * トリガーボタン(paradisResourceMonitorWidget.ts)クリックで生成される内訳パネル。
 * データはウィジェットから updateSnapshot() 経由で渡されるだけで、自分ではポーリングしない。
 */
export class ParadisResourceMonitorPanel extends Disposable {

	private readonly element: HTMLElement;
	private readonly cpuValueElement: HTMLElement;
	private readonly memoryValueElement: HTMLElement;
	private readonly shareValueElement: HTMLElement;
	private readonly shareBarFill: HTMLElement;
	private readonly refreshButton: HTMLElement;
	private readonly sortSelect: HTMLSelectElement;
	private readonly bodyElement: HTMLElement;

	private readonly hoverDelegate = getDefaultHoverDelegate('mouse');

	private sortOption: ParadisResourceMonitorSortOption = 'memory';
	private readonly collapsedScopes = new Set<string>();
	private latestSnapshot: IParadisResourceMonitorSnapshot | undefined;

	constructor(
		private readonly anchor: HTMLElement,
		private readonly options: IParadisResourceMonitorPanelOptions,
		@ILayoutService layoutService: ILayoutService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();

		this.element = $('.paradis-resource-monitor-panel');
		this.element.tabIndex = -1;

		const header = dom.append(this.element, $('.prm-header'));
		const headerTop = dom.append(header, $('.prm-header-top'));
		dom.append(headerTop, $('.prm-title')).textContent = localize('paradis.resourceMonitor.title', "Resources");

		const actions = dom.append(headerTop, $('.prm-header-actions'));
		this.sortSelect = dom.append(actions, $('select.prm-sort-select')) as HTMLSelectElement;
		this.sortSelect.setAttribute('aria-label', localize('paradis.resourceMonitor.sortAria', "Sort by"));
		for (const [value, label] of [
			['memory', localize('paradis.resourceMonitor.sortMemory', "Memory")],
			['cpu', localize('paradis.resourceMonitor.sortCpu', "CPU")],
			['name', localize('paradis.resourceMonitor.sortName', "Name")],
		] as const) {
			const option = dom.append(this.sortSelect, $('option')) as HTMLOptionElement;
			option.value = value;
			option.textContent = label;
		}
		this._register(dom.addDisposableListener(this.sortSelect, 'change', () => {
			this.sortOption = this.sortSelect.value as ParadisResourceMonitorSortOption;
			this.renderBody(this.latestSnapshot);
		}));

		this.refreshButton = dom.append(actions, $('.prm-icon-btn'));
		this.refreshButton.setAttribute('role', 'button');
		this.refreshButton.setAttribute('aria-label', localize('paradis.resourceMonitor.refreshAria', "Refresh"));
		this.refreshButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		this._register(dom.addDisposableListener(this.refreshButton, 'click', () => this.options.onManualRefresh()));

		const metrics = dom.append(header, $('.prm-metrics'));
		this.cpuValueElement = this.createMetric(metrics, localize('paradis.resourceMonitor.metricCpu', "CPU"), localize('paradis.resourceMonitor.metricCpuTooltip', "Sum of CPU used by Para Code and monitored terminal process trees. Over 100% means multiple CPU cores are busy."));
		this.memoryValueElement = this.createMetric(metrics, localize('paradis.resourceMonitor.metricMemory', "Memory"), localize('paradis.resourceMonitor.metricMemoryTooltip', "Resident memory used by Para Code and monitored terminal process trees."));
		this.shareValueElement = this.createMetric(metrics, localize('paradis.resourceMonitor.metricShare', "RAM Share"), localize('paradis.resourceMonitor.metricShareTooltip', "Percent of total system RAM used by monitored Para Code resources only."));

		const shareBar = dom.append(header, $('.prm-share-bar'));
		this.shareBarFill = dom.append(shareBar, $('.prm-share-bar-fill'));

		this.bodyElement = dom.append(this.element, $('.prm-body'));

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
			this.renderEmpty(localize('paradis.resourceMonitor.loading', "Loading…"));
		}
		this.element.focus();
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}

	/** ウィジェットが新しいスナップショットを取得するたびに呼ばれる。 */
	updateSnapshot(snapshot: IParadisResourceMonitorSnapshot): void {
		this.latestSnapshot = snapshot;
		this.renderHeader(snapshot);
		this.renderBody(snapshot);
	}

	/** ウィジェットの手動/自動リフレッシュ実行中フラグを反映する(回転アイコン)。 */
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

	private createMetric(container: HTMLElement, label: string, tooltip: string): HTMLElement {
		const metric = dom.append(container, $('.prm-metric'));
		dom.append(metric, $('.prm-metric-label')).textContent = label;
		const value = dom.append(metric, $('.prm-metric-value'));
		value.textContent = '--';
		this._register(this.hoverService.setupManagedHover(this.hoverDelegate, metric, tooltip));
		return value;
	}

	private reposition(): void {
		const rect = this.anchor.getBoundingClientRect();
		const win = dom.getActiveWindow();
		const left = Math.max(8, Math.min(rect.left, win.innerWidth - PANEL_WIDTH - 8));
		const maxTop = win.innerHeight - 40;
		this.element.style.top = `${Math.min(rect.bottom + 6, maxTop)}px`;
		this.element.style.left = `${left}px`;
	}

	private renderHeader(snapshot: IParadisResourceMonitorSnapshot): void {
		this.cpuValueElement.textContent = paradisFormatCpu(snapshot.totalCpu);
		this.memoryValueElement.textContent = paradisFormatMemory(snapshot.totalMemory);

		const sharePercent = snapshot.hostTotalMemory > 0 ? (snapshot.totalMemory / snapshot.hostTotalMemory) * 100 : 0;
		this.shareValueElement.textContent = paradisFormatPercent(sharePercent);

		const severity = paradisGetTrackedHostMemorySeverity(sharePercent);
		this.shareBarFill.style.width = `${Math.min(100, Math.max(0, sharePercent))}%`;
		this.shareBarFill.classList.toggle('elevated', severity === 'elevated');
		this.shareBarFill.classList.toggle('high', severity === 'high');
	}

	private renderEmpty(message: string): void {
		dom.clearNode(this.bodyElement);
		const empty = dom.append(this.bodyElement, $('.prm-empty'));
		empty.textContent = message;
	}

	private renderBody(snapshot: IParadisResourceMonitorSnapshot | undefined): void {
		if (!snapshot) {
			return;
		}
		dom.clearNode(this.bodyElement);

		const totalUsage: IParadisResourceUsage = { cpu: snapshot.totalCpu, memory: snapshot.totalMemory };
		this.renderAppSection(snapshot, totalUsage);

		if (snapshot.scopes.length === 0) {
			this.renderEmpty(localize('paradis.resourceMonitor.noSessions', "No active terminal sessions"));
			return;
		}

		const sessionOnlyTotals: IParadisResourceUsage = { cpu: snapshot.totalCpu - snapshot.app.cpu, memory: snapshot.totalMemory - snapshot.app.memory };
		const namedScopes = snapshot.scopes.filter(scope => scope.stateKey !== PARADIS_RESOURCE_MONITOR_OTHER_TERMINALS_STATE_KEY);
		const otherScope = snapshot.scopes.find(scope => scope.stateKey === PARADIS_RESOURCE_MONITOR_OTHER_TERMINALS_STATE_KEY);
		const sortedScopes = this.sortScopes(namedScopes);
		if (otherScope) {
			sortedScopes.push(otherScope);
		}

		for (const scope of sortedScopes) {
			this.renderScopeSection(scope, sessionOnlyTotals);
		}
	}

	private sortScopes(scopes: readonly IParadisResourceMonitorScopeMetrics[]): IParadisResourceMonitorScopeMetrics[] {
		const sorted = [...scopes];
		switch (this.sortOption) {
			case 'memory':
				sorted.sort((a, b) => b.memory - a.memory);
				break;
			case 'cpu':
				sorted.sort((a, b) => b.cpu - a.cpu);
				break;
			case 'name':
				sorted.sort((a, b) => a.scopeName.localeCompare(b.scopeName));
				break;
		}
		return sorted;
	}

	private renderAppSection(snapshot: IParadisResourceMonitorSnapshot, totalUsage: IParadisResourceUsage): void {
		const appSeverity = paradisGetUsageSeverity(snapshot.app, totalUsage);
		this.appendRow(this.bodyElement, {
			classNames: ['app-row'],
			icon: undefined,
			name: localize('paradis.resourceMonitor.appName', "Para Code"),
			severity: appSeverity,
			cpu: snapshot.app.cpu,
			memory: snapshot.app.memory,
		});

		this.appendRow(this.bodyElement, {
			classNames: ['sub-row'],
			name: localize('paradis.resourceMonitor.appMain', "Main"),
			severity: paradisGetUsageSeverity(snapshot.app.main, snapshot.app),
			cpu: snapshot.app.main.cpu,
			memory: snapshot.app.main.memory,
		});
		this.appendRow(this.bodyElement, {
			classNames: ['sub-row'],
			name: localize('paradis.resourceMonitor.appRenderer', "Renderer"),
			severity: paradisGetUsageSeverity(snapshot.app.renderer, snapshot.app),
			cpu: snapshot.app.renderer.cpu,
			memory: snapshot.app.renderer.memory,
		});
		if (snapshot.app.other.cpu > 0 || snapshot.app.other.memory > 0) {
			this.appendRow(this.bodyElement, {
				classNames: ['sub-row'],
				name: localize('paradis.resourceMonitor.appOther', "Other"),
				severity: paradisGetUsageSeverity(snapshot.app.other, snapshot.app),
				cpu: snapshot.app.other.cpu,
				memory: snapshot.app.other.memory,
			});
		}

		dom.append(this.bodyElement, $('.prm-section-divider'));
	}

	private renderScopeSection(scope: IParadisResourceMonitorScopeMetrics, sessionOnlyTotals: IParadisResourceUsage): void {
		const isOther = scope.stateKey === PARADIS_RESOURCE_MONITOR_OTHER_TERMINALS_STATE_KEY;
		const isCollapsed = this.collapsedScopes.has(scope.stateKey);
		const hasSessions = scope.sessions.length > 0;

		const { row, iconElement } = this.appendRow(this.bodyElement, {
			classNames: ['scope-row', ...(isOther ? [] : ['clickable'])],
			icon: hasSessions ? (isCollapsed ? Codicon.chevronRight : Codicon.chevronDown) : undefined,
			name: scope.scopeName,
			severity: paradisGetUsageSeverity(scope, sessionOnlyTotals),
			cpu: scope.cpu,
			memory: scope.memory,
		});
		if (!isOther) {
			this._register(dom.addDisposableListener(row, 'click', () => this.options.switchToScope(scope.stateKey)));
		}
		if (iconElement) {
			this._register(dom.addDisposableListener(iconElement, 'click', e => {
				e.stopPropagation();
				if (this.collapsedScopes.has(scope.stateKey)) {
					this.collapsedScopes.delete(scope.stateKey);
				} else {
					this.collapsedScopes.add(scope.stateKey);
				}
				this.renderBody(this.latestSnapshot);
			}));
		}

		if (!isCollapsed) {
			for (const session of scope.sessions) {
				this.renderSessionRow(session, scope);
			}
		}
	}

	private renderSessionRow(session: IParadisResourceMonitorSessionMetrics, scope: IParadisResourceUsage): void {
		this.appendRow(this.bodyElement, {
			classNames: ['session-row'],
			bullet: true,
			name: session.name,
			severity: paradisGetUsageSeverity(session, scope),
			cpu: session.cpu,
			memory: session.memory,
		});
	}

	private appendRow(container: HTMLElement, spec: { classNames: string[]; icon?: ThemeIcon; bullet?: boolean; name: string; severity: ParadisUsageSeverity; cpu: number; memory: number }): { row: HTMLElement; iconElement: HTMLElement | undefined } {
		const row = dom.append(container, $(`.prm-row.${spec.classNames.join('.')}`));
		const label = dom.append(row, $('.prm-row-label'));
		let iconElement: HTMLElement | undefined;
		if (spec.icon) {
			iconElement = dom.append(label, $(`span${ThemeIcon.asCSSSelector(spec.icon)}`));
		}
		if (spec.bullet) {
			dom.append(label, $('.prm-session-bullet'));
		}
		dom.append(label, $('.prm-row-name')).textContent = spec.name;
		if (spec.severity !== 'normal') {
			label.appendChild($(`.prm-severity-dot.${spec.severity}`));
		}

		const values = dom.append(row, $('.prm-row-values'));
		dom.append(values, $('.prm-row-cpu')).textContent = paradisFormatCpu(spec.cpu);
		dom.append(values, $('.prm-row-mem')).textContent = paradisFormatMemory(spec.memory);

		return { row, iconElement };
	}
}
