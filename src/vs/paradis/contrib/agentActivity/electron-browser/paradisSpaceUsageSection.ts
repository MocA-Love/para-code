/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量ダイアログの「スペース別」タブ。
//
// 会話ログを shared process の worker で読み、作業ディレクトリでスペース（リポジトリ・worktree）へ
// 振り分けたトークン数を出す。金額は ccusage の日別・モデル別の金額を、そのトークン比率で分けた目安で、
// スペース別の合計と「スペース外」「未割り当て」の和は ccusage の合計に一致する。

import '../../ccusage/electron-browser/media/paradisCcusage.css';
import './media/paradisAgentActivity.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { ParadisCcusageClient } from '../../ccusage/electron-browser/paradisCcusageClient.js';
import { paradisFormatTokens, paradisFormatUsd } from '../../ccusage/common/paradisCcusageFormat.js';
import { IParadisUsageSection } from '../../usageDashboard/electron-browser/paradisUsageSection.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorkspaceColorHex, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisCostDay,
	IParadisSpaceCostAllocation,
	IParadisSpaceUsageResult,
	IParadisSpaceUsageSpace,
	PARADIS_SPACE_USAGE_OTHER_KEY,
	paradisAllocateSpaceCosts,
} from '../common/paradisAgentActivity.js';
import { ParadisAgentActivityClient } from './paradisAgentActivityClient.js';
import { IParadisActivityRange, ParadisActivityRangeDays, paradisActivityRange, paradisAppendRangeSegment } from './paradisActivityRange.js';

const $ = dom.$;

/** 未割り当て（ccusage には金額があるが、会話ログに対応する記録が無い分）の行のキー。 */
const UNALLOCATED_KEY = '__paradis_unallocated__';

interface ISpaceDescriptor extends IParadisSpaceUsageSpace {
	readonly color?: string;
}

interface ILoaded {
	readonly range: IParadisActivityRange;
	readonly spaces: readonly ISpaceDescriptor[];
	readonly usage: IParadisSpaceUsageResult;
	readonly allocation: IParadisSpaceCostAllocation;
	/** ccusage が使えず金額を出せなかったとき true。 */
	readonly costUnavailable: boolean;
}

export class ParadisSpaceUsageSection extends Disposable implements IParadisUsageSection {

	readonly element: HTMLElement;
	private readonly body: HTMLElement;
	private readonly updatedLabel: HTMLElement;
	private readonly syncRange: () => void;
	private readonly client: ParadisAgentActivityClient;
	private readonly ccusageClient: ParadisCcusageClient;
	private rangeDays: ParadisActivityRangeDays = 30;
	private visible = false;
	private loadedOnce = false;
	private loading = false;
	private sequence = 0;
	private data: ILoaded | undefined;
	private error: string | undefined;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
	) {
		super();
		this.client = instantiationService.createInstance(ParadisAgentActivityClient);
		this.ccusageClient = instantiationService.createInstance(ParadisCcusageClient);

		this.element = $('.paradis-ccusage.paradis-activity-panel');
		const toolbar = dom.append(this.element, $('.paradis-ccusage-toolbar'));
		const store = this._register(new DisposableStore());
		this.syncRange = paradisAppendRangeSegment(toolbar, store, () => this.rangeDays, days => {
			this.rangeDays = days;
			this.syncRange();
			void this.refresh(false);
		});
		dom.append(toolbar, $('.paradis-ccusage-toolbar-spacer'));
		this.updatedLabel = dom.append(toolbar, $('span.paradis-ccusage-updated'));
		this.body = dom.append(this.element, $('.paradis-ccusage-body'));
		this.render();
	}

	layout(_width: number): void {
		// 表だけなので、幅は CSS に任せる。
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible && !this.loadedOnce) {
			void this.refresh(false);
		}
	}

	async refresh(bypassCache = false): Promise<void> {
		this.loadedOnce = true;
		const sequence = ++this.sequence;
		this.loading = true;
		this.error = undefined;
		this.render();
		try {
			if (this.remoteAgentService.getConnection()) {
				throw new Error(localize('paradis.spaceUsage.remote', "SSH で接続しているウィンドウでは、スペース別の使用量は出せません。手元のフォルダを開いたウィンドウで確認してください。"));
			}
			await this.worktreeService.initializationBarrier;
			const range = paradisActivityRange(this.rangeDays);
			const spaces = this.collectSpaces();
			const [usage, dashboard] = await Promise.all([
				this.client.spaceUsage({ since: range.since, until: range.until, spaces, bypassCache }),
				this.ccusageClient.fetchDashboard(bypassCache).then(value => value, () => undefined),
			]);
			if (sequence !== this.sequence || this._store.isDisposed) {
				return;
			}
			const costDays: IParadisCostDay[] = (dashboard?.days ?? []).map(day => ({
				date: day.date,
				models: day.models.map(model => ({ model: model.model, agent: model.agent, cost: model.cost })),
			}));
			this.data = { range, spaces, usage, allocation: paradisAllocateSpaceCosts(costDays, usage.buckets, range.since, range.until), costUnavailable: dashboard === undefined };
		} catch (error) {
			if (sequence === this.sequence) {
				this.error = error instanceof Error ? error.message : String(error);
			}
		} finally {
			if (sequence === this.sequence && !this._store.isDisposed) {
				this.loading = false;
				this.render();
			}
		}
	}

	/** Workspaces ビューに登録されたリポジトリと worktree（手元のフォルダのもの）。 */
	private collectSpaces(): ISpaceDescriptor[] {
		const spaces: ISpaceDescriptor[] = [];
		for (const repository of this.workspaceSwitchService.repositories) {
			if (repository.uri.scheme !== Schemas.file) {
				continue;
			}
			const color = paradisWorkspaceColorHex(repository.color);
			spaces.push({ key: repository.id, name: repository.name, roots: [repository.uri.fsPath], color });
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (worktree.missing || worktree.isMainCheckout || worktree.uri.scheme !== Schemas.file) {
					continue;
				}
				spaces.push({ key: paradisWorktreeStateKey(worktree.uri), name: `${repository.name} / ${worktree.name}`, roots: [worktree.uri.fsPath], color });
			}
		}
		return spaces;
	}

	private render(): void {
		dom.clearNode(this.body);
		this.body.classList.toggle('stale', this.loading && this.data !== undefined);
		this.updatedLabel.textContent = this.data
			? localize('paradis.spaceUsage.updated', "更新: {0}", new Date(this.data.usage.computedAt).toLocaleTimeString())
			: '';
		if (this.error) {
			this.message(Codicon.warning, this.error);
			return;
		}
		if (!this.data) {
			if (this.loading || !this.visible) {
				this.message(Codicon.loading, localize('paradis.spaceUsage.loading', "会話ログを集計しています…"), true);
			}
			return;
		}
		const { allocation, spaces, costUnavailable, usage } = this.data;
		dom.append(this.body, $('.paradis-ccusage-note')).textContent = costUnavailable
			? localize('paradis.spaceUsage.noteNoCost', "会話ログのトークン数を作業フォルダでスペースに振り分けています。ccusage を実行できなかったため、金額は出していません。")
			: localize('paradis.spaceUsage.note', "会話ログのトークン数を作業フォルダでスペースに振り分け、ccusage の金額をその比率で分けた目安です。スペースの合計と「スペース外」「未割り当て」を足すと ccusage の合計になります。");

		const names = new Map(spaces.map(space => [space.key, space]));
		const rows = allocation.spaces
			.filter(space => space.tokens > 0 || space.cost > 0)
			.map(space => ({
				key: space.key,
				name: space.key === PARADIS_SPACE_USAGE_OTHER_KEY ? localize('paradis.spaceUsage.other', "スペース外") : (names.get(space.key)?.name ?? space.key),
				tooltip: space.key === PARADIS_SPACE_USAGE_OTHER_KEY ? localize('paradis.spaceUsage.otherTooltip', "Workspaces に登録していないフォルダでの会話") : names.get(space.key)?.roots[0] ?? '',
				color: names.get(space.key)?.color,
				sessions: space.sessions as number | undefined,
				tokens: space.tokens as number | undefined,
				cost: space.cost,
			}));
		if (!costUnavailable && allocation.unallocatedCost > 0.005) {
			rows.push({
				key: UNALLOCATED_KEY,
				name: localize('paradis.spaceUsage.unallocated', "未割り当て"),
				tooltip: localize('paradis.spaceUsage.unallocatedTooltip', "ccusage には金額があるものの、この PC の会話ログに対応する記録が見つからなかった分"),
				color: undefined, sessions: undefined, tokens: undefined, cost: allocation.unallocatedCost,
			});
		}
		// 金額が出せるときは金額順、出せないときはトークン順。スペース外・未割り当ては末尾に置く。
		const special = (key: string) => key === PARADIS_SPACE_USAGE_OTHER_KEY || key === UNALLOCATED_KEY ? 1 : 0;
		rows.sort((a, b) => special(a.key) - special(b.key) || (costUnavailable ? (b.tokens ?? 0) - (a.tokens ?? 0) : b.cost - a.cost) || (b.tokens ?? 0) - (a.tokens ?? 0));

		const kpis = dom.append(this.body, $('.paradis-ccusage-kpis.paradis-activity-kpis'));
		const assigned = allocation.spaces.filter(space => space.key !== PARADIS_SPACE_USAGE_OTHER_KEY);
		const totalTokens = allocation.spaces.reduce((sum, space) => sum + space.tokens, 0);
		const assignedTokens = assigned.reduce((sum, space) => sum + space.tokens, 0);
		this.kpi(kpis, localize('paradis.spaceUsage.kpiTotal', "合計（ccusage）"), costUnavailable ? '—' : paradisFormatUsd(allocation.totalCost));
		this.kpi(kpis, localize('paradis.spaceUsage.kpiTokens', "会話ログのトークン"), paradisFormatTokens(totalTokens));
		this.kpi(kpis, localize('paradis.spaceUsage.kpiAssigned', "スペースに振り分けた割合"), totalTokens > 0 ? `${Math.round(assignedTokens / totalTokens * 100)}%` : '—');
		this.kpi(kpis, localize('paradis.spaceUsage.kpiSpaces', "使ったスペース"), String(assigned.filter(space => space.tokens > 0).length));

		const card = dom.append(this.body, $('.paradis-ccusage-card'));
		dom.append(card, $('h3')).textContent = localize('paradis.spaceUsage.tableTitle', "スペース別（{0} – {1}）", this.data.range.since, this.data.range.until);
		if (rows.length === 0) {
			dom.append(card, $('.paradis-ccusage-message')).textContent = localize('paradis.spaceUsage.empty', "この期間の会話ログが見つかりません。");
			return;
		}
		const table = dom.append(card, $('table.paradis-space-usage-table'));
		const head = dom.append(dom.append(table, $('thead')), $('tr'));
		dom.append(head, $('th')).textContent = localize('paradis.spaceUsage.colSpace', "スペース");
		dom.append(head, $('th.num')).textContent = localize('paradis.spaceUsage.colSessions', "会話");
		dom.append(head, $('th.num')).textContent = localize('paradis.spaceUsage.colTokens', "トークン");
		dom.append(head, $('th.bar-col')).textContent = costUnavailable ? localize('paradis.spaceUsage.colShareTokens', "割合（トークン）") : localize('paradis.spaceUsage.colShare', "割合（金額）");
		dom.append(head, $('th.num')).textContent = localize('paradis.spaceUsage.colCost', "金額（目安）");
		const tbody = dom.append(table, $('tbody'));
		const max = Math.max(...rows.map(row => costUnavailable ? row.tokens ?? 0 : row.cost), 0);
		const total = costUnavailable ? totalTokens : allocation.totalCost;
		for (const row of rows) {
			const tr = dom.append(tbody, $('tr'));
			tr.classList.toggle('special', special(row.key) === 1);
			const nameCell = dom.append(tr, $('td.space-name'));
			const swatch = dom.append(nameCell, $('span.space-swatch'));
			if (row.color) {
				swatch.style.backgroundColor = row.color;
			} else {
				swatch.classList.add('none');
			}
			dom.append(nameCell, $('span')).textContent = row.name;
			nameCell.title = row.tooltip;
			dom.append(tr, $('td.num')).textContent = row.sessions === undefined ? '—' : String(row.sessions);
			dom.append(tr, $('td.num')).textContent = row.tokens === undefined ? '—' : paradisFormatTokens(row.tokens);
			const value = costUnavailable ? row.tokens ?? 0 : row.cost;
			// td そのものを flex にすると table-cell でなくなり、行の高さや下線がずれる。中に1枚挟む。
			const barCell = dom.append(dom.append(tr, $('td.bar-col')), $('.bar-cell'));
			const track = dom.append(barCell, $('.paradis-space-usage-track'));
			const bar = dom.append(track, $('.paradis-space-usage-bar'));
			bar.style.width = `${max > 0 ? Math.max(1, value / max * 100).toFixed(1) : 0}%`;
			dom.append(barCell, $('span.share')).textContent = total > 0 ? `${(value / total * 100).toFixed(1)}%` : '';
			dom.append(tr, $('td.num')).textContent = costUnavailable ? '—' : paradisFormatUsd(row.cost);
		}
		const idle = spaces.length - allocation.spaces.filter(space => space.key !== PARADIS_SPACE_USAGE_OTHER_KEY && space.tokens > 0).length;
		const footer = dom.append(card, $('.paradis-activity-footnote'));
		footer.textContent = localize('paradis.spaceUsage.footnote', "読んだ会話ログ {0} 件（読めなかったもの {1} 件）。記録の無いスペース {2} 件は省略しています。", usage.scannedFiles, usage.failedFiles, Math.max(0, idle));
	}

	private kpi(parent: HTMLElement, label: string, value: string): void {
		const card = dom.append(parent, $('.paradis-ccusage-card'));
		dom.append(card, $('.paradis-ccusage-stat-label')).textContent = label;
		dom.append(card, $('.paradis-ccusage-stat-value')).textContent = value;
	}

	private message(icon: ThemeIcon, text: string, spin = false): void {
		const message = dom.append(this.body, $('.paradis-ccusage-message'));
		const iconEl = dom.append(message, $(`span${ThemeIcon.asCSSSelector(icon)}`));
		if (spin) {
			iconEl.classList.add('codicon-modifier-spin');
		}
		dom.append(message, $('span')).textContent = text;
	}
}
