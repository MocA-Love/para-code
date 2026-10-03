/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// システム使用率のエディタのタブ。上部でマシン（このコンピューター / 接続先）と時間の幅（5 分 / 1 時間 / 24 時間）を
// 選び、6 項目の大きなグラフを並べる。見えている間だけ 5 秒ごとに差分を取る（履歴そのものは測る側が常に持っている）。

import './media/paradisSystemUsageEditor.css';
import * as dom from '../../../../base/browser/dom.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ParadisSystemUsageGrid, ParadisSystemUsageSegment } from '../browser/paradisSystemUsageChart.js';
import { PARADIS_SYSTEM_USAGE_FINE_STEP_MS, ParadisSystemUsageRange } from '../common/paradisSystemUsage.js';
import { paradisSystemUsageRangeLabel } from '../common/paradisSystemUsageFormat.js';
import { paradisFormatMemory } from '../common/paradisResourceMonitorFormat.js';
import { IParadisSystemUsageModel, IParadisSystemUsageView, ParadisSystemUsageMachineId } from './paradisSystemUsageModel.js';
import { PARADIS_SYSTEM_USAGE_EDITOR_ID, ParadisSystemUsageEditorInput } from './paradisSystemUsageEditorInput.js';

const $ = dom.$;

/** 大きなグラフ 1 本に描く点の上限（1 時間 720 点・24 時間 1440 点を、画面の幅で見分けられる程度に間引く）。 */
const EDITOR_CHART_MAX_POINTS = 360;
const RANGES: readonly ParadisSystemUsageRange[] = ['5m', '1h', '24h'];

export class ParadisSystemUsageEditor extends EditorPane {

	static readonly ID = PARADIS_SYSTEM_USAGE_EDITOR_ID;

	private root: HTMLElement | undefined;
	private machineSegment: ParadisSystemUsageSegment<ParadisSystemUsageMachineId> | undefined;
	private rangeSegment: ParadisSystemUsageSegment<ParadisSystemUsageRange> | undefined;
	private infoElement: HTMLElement | undefined;
	private statusElement: HTMLElement | undefined;
	private grid: ParadisSystemUsageGrid | undefined;

	private readonly pollTimer = this._register(new IntervalTimer());
	private readonly inputListener = this._register(new MutableDisposable());

	private machineId: ParadisSystemUsageMachineId | undefined;
	private range: ParadisSystemUsageRange = '5m';
	/** 進行中の取得の世代。マシン・時間の幅を変えたら上げ、前の応答は描かない。 */
	private generation = 0;
	private fetching = false;
	/** 取得中に選び直された。終わったらもう一度取る。 */
	private refreshPending = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IParadisSystemUsageModel private readonly systemUsageModel: IParadisSystemUsageModel,
	) {
		super(PARADIS_SYSTEM_USAGE_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, $('.paradis-sysusage-editor'));
		const header = dom.append(this.root, $('.paradis-sysusage-editor-header'));
		const titles = dom.append(header, $('.paradis-sysusage-editor-titles'));
		dom.append(titles, $('h2.paradis-sysusage-editor-title')).textContent = localize('paradis.systemUsage.title', "システムの使用率");
		this.infoElement = dom.append(titles, $('.paradis-sysusage-editor-info'));

		const controls = dom.append(header, $('.paradis-sysusage-editor-controls'));
		this.machineSegment = this._register(new ParadisSystemUsageSegment<ParadisSystemUsageMachineId>(controls, localize('paradis.systemUsage.machineAria', "表示するマシン"), machineId => this.select(machineId, this.range)));
		this.rangeSegment = this._register(new ParadisSystemUsageSegment<ParadisSystemUsageRange>(controls, localize('paradis.systemUsage.rangeAria', "時間の幅"), range => this.select(this.machineId, range)));

		this.grid = this._register(new ParadisSystemUsageGrid(this.root, { compact: false, maxPoints: EDITOR_CHART_MAX_POINTS }));
		this.statusElement = dom.append(this.root, $('.paradis-sysusage-editor-status'));
		this.renderControls();
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (input instanceof ParadisSystemUsageEditorInput) {
			this.inputListener.value = input.onDidRequestMachine(machineId => this.select(machineId, this.range));
			this.select(input.requestedMachineId ?? this.machineId ?? this.systemUsageModel.getDefaultMachineId(), this.range);
		}
	}

	override clearInput(): void {
		this.inputListener.clear();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible) {
			this.pollTimer.cancelAndSet(() => void this.refresh(), PARADIS_SYSTEM_USAGE_FINE_STEP_MS);
			void this.refresh();
		} else {
			this.pollTimer.cancel();
		}
	}

	override layout(_dimension: dom.Dimension): void {
		// 格子は CSS が幅に合わせて並べ替え、グラフは viewBox で伸びるので、ここで描き直すものは無い
	}

	override focus(): void {
		super.focus();
		this.root?.focus();
	}

	private select(machineId: ParadisSystemUsageMachineId | undefined, range: ParadisSystemUsageRange): void {
		const machines = this.systemUsageModel.getMachines();
		const next = machines.some(machine => machine.id === machineId) ? machineId : this.systemUsageModel.getDefaultMachineId();
		if (next === this.machineId && range === this.range) {
			return;
		}
		this.machineId = next;
		this.range = range;
		this.generation++;
		this.renderControls();
		void this.refresh();
	}

	private renderControls(): void {
		const machines = this.systemUsageModel.getMachines();
		if (this.machineSegment) {
			this.machineSegment.element.style.display = machines.length > 1 ? '' : 'none';
			this.machineSegment.render(machines.map(machine => ({ value: machine.id, label: machine.label })), this.machineId ?? this.systemUsageModel.getDefaultMachineId());
		}
		this.rangeSegment?.render(RANGES.map(range => ({ value: range, label: paradisSystemUsageRangeLabel(range) })), this.range);
	}

	private async refresh(): Promise<void> {
		const machineId = this.machineId;
		if (machineId === undefined || !this.isVisible()) {
			return;
		}
		if (this.fetching) {
			// 前の取得（前のマシン・時間の幅かもしれない）が終わってから取り直す
			this.refreshPending = true;
			return;
		}
		const generation = this.generation;
		this.fetching = true;
		try {
			const view = await this.systemUsageModel.refresh(machineId, this.range);
			if (generation !== this.generation) {
				return;
			}
			this.render(view);
		} catch (error) {
			if (generation === this.generation && this.statusElement) {
				this.statusElement.textContent = localize('paradis.systemUsage.failed', "取得できませんでした: {0}", error instanceof Error ? error.message : String(error));
			}
		} finally {
			this.fetching = false;
			if (this.refreshPending) {
				this.refreshPending = false;
				void this.refresh();
			}
		}
	}

	private render(view: IParadisSystemUsageView): void {
		// 接続先の名前は最初の応答でホスト名に置き換わるので、そのたびにセグメントの文字を直す
		this.renderControls();
		if (this.infoElement) {
			const machine = view.machine;
			const parts = [
				view.label,
				machine?.os === 'darwin' ? 'macOS' : machine?.os === 'linux' ? 'Linux' : machine?.os === 'win32' ? 'Windows' : undefined,
				machine !== undefined && machine.cores > 0 ? localize('paradis.systemUsage.cores', "{0} コア", machine.cores) : undefined,
				machine !== undefined && machine.memTotal > 0 ? paradisFormatMemory(machine.memTotal) : undefined,
				machine?.diskPath !== undefined ? localize('paradis.systemUsage.diskPath', "ディスク {0}", machine.diskPath) : undefined,
			].filter((part): part is string => part !== undefined && part.length > 0);
			this.infoElement.textContent = parts.join(' · ');
		}
		this.grid?.update({
			samples: view.samples,
			latest: view.latest,
			windowStart: view.windowStart,
			windowEnd: view.windowEnd,
			windowMs: view.windowMs,
			stepMs: view.stepMs,
			unsupported: view.unsupported,
			legacy: view.legacy,
			swapTotal: view.machine?.swapTotal,
		});
		if (this.statusElement) {
			this.statusElement.textContent = view.error !== undefined
				? localize('paradis.systemUsage.failed', "取得できませんでした: {0}", view.error)
				: view.legacy
					? localize('paradis.systemUsage.legacyStatus', "接続先の Para Code が古いため、今の値だけを出しています。接続先を更新すると、5 秒ごとの推移と 24 時間の履歴が出ます。")
					: view.range === '24h'
						? localize('paradis.systemUsage.coarseStatus', "24 時間は 1 分ごとの平均です。履歴は測っている側（このコンピューターは Para Code、接続先はサーバー）が動いている間だけ残ります。")
						: localize('paradis.systemUsage.fineStatus', "5 秒ごとに測っています。履歴は測っている側（このコンピューターは Para Code、接続先はサーバー）が動いている間だけ残ります。");
		}
	}
}
