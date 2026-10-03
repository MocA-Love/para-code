/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// システム使用率の 6 項目のグラフ（素の SVG の折れ線と面）。タイトルバーのパネル（小さく 2 列）と
// エディタのタブ（大きく 3 列）で同じ部品を使う。PC 側に共通のグラフ部品は無いので、ここで作る。
//
// 軽くするために:
//  - 点は描く幅に合わせて間引く（`maxPoints`）
//  - 5 秒ごとの更新で、点が変わっていなければ何も触らない。変わっていても DOM は作り直さず、
//    path の `d` と文字だけを書き換える
//  - SVG は viewBox を固定して伸縮させ、線の太さだけ `vector-effect: non-scaling-stroke` で保つ（幅が変わっても描き直さない）

import './media/paradisSystemUsageChart.css';
import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IParadisSystemUsageSample, ParadisSystemUsageField, ParadisSystemUsageMetric, paradisDownsampleSamples } from '../common/paradisSystemUsage.js';
import {
	IParadisSystemUsageMetricSpec,
	paradisFormatSystemUsageValue,
	paradisSystemUsageAxisMax,
	paradisSystemUsageMax,
	paradisSystemUsageMetricSpecs,
} from '../common/paradisSystemUsageFormat.js';

const $ = dom.$;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** viewBox の幅と高さ。実際の大きさは CSS が決める。 */
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 100;

/** グラフに渡す 1 台・1 つの時間の幅ぶんの値（`IParadisSystemUsageView` の一部）。 */
export interface IParadisSystemUsageChartData {
	readonly samples: readonly IParadisSystemUsageSample[];
	readonly latest: IParadisSystemUsageSample | undefined;
	readonly windowStart: number;
	readonly windowEnd: number;
	readonly windowMs: number;
	readonly stepMs: number;
	readonly unsupported: readonly ParadisSystemUsageMetric[];
	/** 接続先が古く、今の値しか無い。 */
	readonly legacy: boolean;
	readonly swapTotal: number | undefined;
}

export interface IParadisSystemUsageGridOptions {
	/** パネル用の小さい見た目。 */
	readonly compact: boolean;
	/** 1 本の線に描く点の上限。 */
	readonly maxPoints: number;
}

/**
 * 点の列から、折れ線と面の path を作る。値が無い点や、刻みより大きく空いた所（スリープ等）では線を切る。
 * 純関数（テストする）。
 */
export function paradisSystemUsagePaths(samples: readonly IParadisSystemUsageSample[], field: ParadisSystemUsageField, start: number, end: number, axisMax: number, gapMs: number): { readonly line: string; readonly area: string } {
	const span = Math.max(1, end - start);
	const x = (t: number) => Math.round(((t - start) / span) * VIEW_WIDTH * 10) / 10;
	const y = (value: number) => Math.round((VIEW_HEIGHT - Math.min(1, Math.max(0, value / Math.max(axisMax, Number.EPSILON))) * VIEW_HEIGHT) * 10) / 10;
	const line: string[] = [];
	const area: string[] = [];
	let run: { x: number; y: number }[] = [];
	let previousT: number | undefined;
	const flush = () => {
		if (run.length === 0) {
			return;
		}
		line.push(`M${run.map(point => `${point.x},${point.y}`).join('L')}`);
		const first = run[0];
		const last = run[run.length - 1];
		area.push(`M${first.x},${VIEW_HEIGHT}L${run.map(point => `${point.x},${point.y}`).join('L')}L${last.x},${VIEW_HEIGHT}Z`);
		run = [];
	};
	for (const sample of samples) {
		const value = sample[field];
		if (typeof value !== 'number' || !Number.isFinite(value) || (previousT !== undefined && sample.t - previousT > gapMs)) {
			flush();
		}
		if (typeof value === 'number' && Number.isFinite(value)) {
			run.push({ x: x(sample.t), y: y(value) });
		}
		previousT = sample.t;
	}
	flush();
	return { line: line.join(''), area: area.join('') };
}

class ParadisSystemUsageCard {

	readonly element: HTMLElement;
	private readonly valueElement: HTMLElement;
	private readonly subElement: HTMLElement;
	private readonly svg: SVGSVGElement;
	private readonly areaPath: SVGPathElement;
	private readonly linePaths: SVGPathElement[] = [];
	private readonly noteElement: HTMLElement;
	private renderedKey: string | undefined;

	constructor(container: HTMLElement, private readonly spec: IParadisSystemUsageMetricSpec, private readonly options: IParadisSystemUsageGridOptions) {
		this.element = dom.append(container, $('.paradis-sysusage-card'));
		const head = dom.append(this.element, $('.paradis-sysusage-card-head'));
		dom.append(head, $('.paradis-sysusage-card-label')).textContent = spec.label;
		this.valueElement = dom.append(head, $('.paradis-sysusage-card-value'));
		this.valueElement.textContent = '--';
		this.subElement = dom.append(this.element, $('.paradis-sysusage-card-sub'));

		const doc = container.ownerDocument;
		this.svg = doc.createElementNS(SVG_NS, 'svg');
		this.svg.classList.add('paradis-sysusage-chart');
		this.svg.setAttribute('viewBox', `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`);
		this.svg.setAttribute('preserveAspectRatio', 'none');
		this.svg.setAttribute('role', 'img');
		for (const fraction of [0.25, 0.5, 0.75]) {
			const grid = doc.createElementNS(SVG_NS, 'line');
			grid.classList.add('paradis-sysusage-gridline');
			grid.setAttribute('x1', '0');
			grid.setAttribute('x2', String(VIEW_WIDTH));
			grid.setAttribute('y1', String(VIEW_HEIGHT * fraction));
			grid.setAttribute('y2', String(VIEW_HEIGHT * fraction));
			this.svg.appendChild(grid);
		}
		this.areaPath = doc.createElementNS(SVG_NS, 'path');
		this.areaPath.classList.add('paradis-sysusage-area');
		this.svg.appendChild(this.areaPath);
		spec.series.forEach((_series, index) => {
			const path = doc.createElementNS(SVG_NS, 'path');
			path.classList.add('paradis-sysusage-line', `series-${index}`);
			this.svg.appendChild(path);
			this.linePaths.push(path);
		});
		this.element.appendChild(this.svg);
		this.noteElement = dom.append(this.element, $('.paradis-sysusage-card-note'));
		this.noteElement.style.display = 'none';
	}

	update(data: IParadisSystemUsageChartData): void {
		const unsupported = data.unsupported.includes(this.spec.id);
		const fields = this.spec.series.map(series => series.field);
		const latest = data.latest;
		const last = data.samples.at(-1);
		const key = [unsupported, data.legacy, data.samples.length, data.samples[0]?.t, last?.t, latest?.t, data.windowMs, data.swapTotal].join('|');
		if (key === this.renderedKey) {
			return;
		}
		this.renderedKey = key;

		if (unsupported) {
			this.valueElement.textContent = '--';
			dom.clearNode(this.subElement);
			this.setPaths('', []);
			this.showNote(localize('paradis.systemUsage.unsupported', "このマシンでは取得できません"));
			this.svg.setAttribute('aria-label', `${this.spec.label}: ${localize('paradis.systemUsage.unsupportedShort', "取得できません")}`);
			return;
		}

		// 今の値。2 本線の項目は「読み 1.2 MB/s · 書き 300 KB/s」のように並べる。
		const current = this.spec.series.map(series => paradisFormatSystemUsageValue(latest?.[series.field], this.spec.unit));
		this.valueElement.textContent = this.spec.series.length === 1 ? current[0] : '';
		dom.clearNode(this.subElement);
		if (this.spec.series.length > 1) {
			this.spec.series.forEach((series, index) => {
				const item = dom.append(this.subElement, $('span.paradis-sysusage-legend'));
				dom.append(item, $(`span.paradis-sysusage-dot.series-${index}`));
				dom.append(item, $('span')).textContent = `${series.label} ${current[index]}`;
			});
		}
		const max = paradisSystemUsageMax(data.samples, fields);
		// パネルの小さいカードでは、2 本線の項目は凡例で幅が埋まるので最大を省く
		if (max !== undefined && (!this.options.compact || this.spec.series.length === 1)) {
			dom.append(this.subElement, $('span.paradis-sysusage-max')).textContent = localize('paradis.systemUsage.max', "最大 {0}", paradisFormatSystemUsageValue(max, this.spec.unit));
		}
		this.svg.setAttribute('aria-label', `${this.spec.label}: ${current.join(', ')}`);

		if (data.legacy) {
			this.setPaths('', []);
			this.showNote(localize('paradis.systemUsage.legacy', "接続先の Para Code を更新すると推移が出ます"));
			return;
		}
		if (data.samples.length < 2) {
			this.setPaths('', []);
			this.showNote(localize('paradis.systemUsage.collecting', "記録しています…"));
			return;
		}
		this.showNote(undefined);
		const points = paradisDownsampleSamples(data.samples, this.options.maxPoints);
		const axisMax = paradisSystemUsageAxisMax(this.spec.unit, max, this.spec.id === 'swap' ? data.swapTotal : undefined);
		// 間引いた後の 1 点の幅の 3 倍より空いていたら、測っていなかった（スリープ等）とみなして線を切る
		const bucketMs = Math.max(data.stepMs, data.windowMs / Math.max(1, this.options.maxPoints));
		const gapMs = bucketMs * 3;
		const start = data.windowStart;
		const end = data.windowEnd;
		const paths = fields.map(field => paradisSystemUsagePaths(points, field, start, end, axisMax, gapMs));
		this.setPaths(paths[0]?.area ?? '', paths.map(path => path.line));
	}

	private setPaths(area: string, lines: readonly string[]): void {
		this.areaPath.setAttribute('d', area);
		this.linePaths.forEach((path, index) => path.setAttribute('d', lines[index] ?? ''));
	}

	private showNote(text: string | undefined): void {
		this.noteElement.style.display = text === undefined ? 'none' : '';
		this.noteElement.textContent = text ?? '';
	}
}

/** マシン・時間の幅を選ぶセグメント（ボタンを横に並べたもの）。 */
export class ParadisSystemUsageSegment<T extends string> extends Disposable {

	readonly element: HTMLElement;
	/** ボタンの並びが変わったときだけ作り直す（選択の切り替えでは aria-checked とクラスだけを書き換える）。 */
	private readonly buttonListeners = this._register(new DisposableStore());
	private buttons: { readonly value: T; readonly element: HTMLButtonElement }[] = [];
	private selected: T | undefined;

	constructor(container: HTMLElement, ariaLabel: string, private readonly onSelect: (value: T) => void) {
		super();
		this.element = dom.append(container, $('.paradis-sysusage-segment'));
		this.element.setAttribute('role', 'radiogroup');
		this.element.setAttribute('aria-label', ariaLabel);
		this._register(dom.addDisposableListener(this.element, 'keydown', e => this.onKeyDown(e)));
	}

	/** 選択肢と選んでいる値を描く。値の並びが同じならボタンは作り直さず、文字と選択の印だけを直す。 */
	render(options: readonly { readonly value: T; readonly label: string }[], selected: T): void {
		const sameValues = options.length === this.buttons.length && options.every((option, index) => option.value === this.buttons[index].value);
		if (!sameValues) {
			this.buttonListeners.clear();
			dom.clearNode(this.element);
			this.buttons = options.map(option => {
				const button = dom.append(this.element, $('button.paradis-sysusage-segment-button')) as HTMLButtonElement;
				button.setAttribute('type', 'button');
				button.setAttribute('role', 'radio');
				this.buttonListeners.add(dom.addDisposableListener(button, 'click', () => this.onSelect(option.value)));
				return { value: option.value, element: button };
			});
		}
		options.forEach((option, index) => {
			const button = this.buttons[index].element;
			if (button.textContent !== option.label) {
				button.textContent = option.label;
			}
		});
		this.selected = selected;
		for (const { value, element } of this.buttons) {
			const checked = value === selected;
			element.setAttribute('aria-checked', String(checked));
			element.classList.toggle('selected', checked);
			// 矢印キーで動かせるよう、Tab で止まるのは選んでいるボタンだけにする（roving tabindex）
			element.tabIndex = checked ? 0 : -1;
		}
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (this.buttons.length === 0) {
			return;
		}
		const current = Math.max(0, this.buttons.findIndex(button => button.value === this.selected));
		let next: number | undefined;
		switch (e.key) {
			case 'ArrowRight':
			case 'ArrowDown':
				next = (current + 1) % this.buttons.length;
				break;
			case 'ArrowLeft':
			case 'ArrowUp':
				next = (current - 1 + this.buttons.length) % this.buttons.length;
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = this.buttons.length - 1;
				break;
		}
		if (next === undefined) {
			return;
		}
		e.preventDefault();
		const target = this.buttons[next];
		target.element.focus();
		if (target.value !== this.selected) {
			this.onSelect(target.value);
		}
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}
}

/** 6 項目のグラフを並べたもの。 */
export class ParadisSystemUsageGrid extends Disposable {

	readonly element: HTMLElement;
	private readonly cards: ParadisSystemUsageCard[];

	constructor(container: HTMLElement, options: IParadisSystemUsageGridOptions) {
		super();
		this.element = dom.append(container, $('.paradis-sysusage-grid'));
		this.element.classList.toggle('compact', options.compact);
		this.cards = paradisSystemUsageMetricSpecs().map(spec => new ParadisSystemUsageCard(this.element, spec, options));
	}

	update(data: IParadisSystemUsageChartData): void {
		for (const card of this.cards) {
			card.update(data);
		}
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}
}
