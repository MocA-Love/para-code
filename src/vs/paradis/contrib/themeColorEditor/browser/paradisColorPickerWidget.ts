/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// テーマの色エディタのカラーピッカー（彩度・明度の四角、色相、不透明度、16 進と % の入力欄）。
// エディタのカラーピッカー部品（editor/contrib/colorPicker）はエディタの hover に組み込む前提の作りなので、
// ここでは同じ HSVA の考え方で小さく作る。ドラッグ中の変更は約 100ms に 1 回（最後の値は必ず届く）にまとめて
// 知らせ、ポインタを離したときとフォーカスが外れたときに確定する（受け手は設定のメモリ層へ書くので、
// マウスの動きごとに書くとテーマの作り直しが詰まる）。

import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Color, HSVA } from '../../../../base/common/color.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';

const $ = dom.$;

export class ParadisColorPickerWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly _onDidChange = this._register(new Emitter<Color>());
	/** ユーザーが色を変えたとき（ドラッグ中は約 100ms に 1 回、離したときに最後の値）。 */
	readonly onDidChange: Event<Color> = this._onDidChange.event;

	private hsva = new HSVA(0, 0, 0, 1);
	private readonly saturation: HTMLElement;
	private readonly saturationHandle: HTMLElement;
	private readonly hue: HTMLElement;
	private readonly hueHandle: HTMLElement;
	private readonly alpha: HTMLElement;
	private readonly alphaFill: HTMLElement;
	private readonly alphaHandle: HTMLElement;
	private readonly hexInput: HTMLInputElement;
	private readonly opacityInput: HTMLInputElement;
	private readonly throttle = this._register(new RunOnceScheduler(() => this._onDidChange.fire(new Color(this.hsva)), 100));

	constructor(container: HTMLElement) {
		super();
		this.element = dom.append(container, $('.paradis-tce-picker'));

		this.saturation = dom.append(this.element, $('.paradis-tce-picker-sv', { role: 'slider', tabindex: '0', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': localize('paradis.themeColors.picker.sv', "彩度と明るさ") }));
		dom.append(this.saturation, $('.paradis-tce-picker-sv-white'));
		dom.append(this.saturation, $('.paradis-tce-picker-sv-black'));
		this.saturationHandle = dom.append(this.saturation, $('.paradis-tce-picker-sv-handle'));

		this.hue = dom.append(this.element, $('.paradis-tce-picker-strip.paradis-tce-picker-hue', { role: 'slider', tabindex: '0', 'aria-valuemin': '0', 'aria-valuemax': '360', 'aria-label': localize('paradis.themeColors.picker.hue', "色相") }));
		this.hueHandle = dom.append(this.hue, $('.paradis-tce-picker-strip-handle'));

		this.alpha = dom.append(this.element, $('.paradis-tce-picker-strip.paradis-tce-picker-alpha', { role: 'slider', tabindex: '0', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': localize('paradis.themeColors.picker.alpha', "不透明度") }));
		this.alphaFill = dom.append(this.alpha, $('.paradis-tce-picker-alpha-fill'));
		this.alphaHandle = dom.append(this.alpha, $('.paradis-tce-picker-strip-handle'));

		const fields = dom.append(this.element, $('.paradis-tce-picker-fields'));
		const hexRow = dom.append(fields, $('label.paradis-tce-picker-field'));
		dom.append(hexRow, $('span', undefined, 'HEX'));
		this.hexInput = dom.append(hexRow, $<HTMLInputElement>('input.paradis-tce-input', { type: 'text', spellcheck: 'false', 'aria-label': 'HEX' }));
		const opacityRow = dom.append(fields, $('label.paradis-tce-picker-field'));
		dom.append(opacityRow, $('span', undefined, localize('paradis.themeColors.picker.opacity', "不透明度")));
		this.opacityInput = dom.append(opacityRow, $<HTMLInputElement>('input.paradis-tce-input', { type: 'number', min: '0', max: '100', step: '1' }));
		dom.append(opacityRow, $('span', undefined, '%'));

		this.registerDrag(this.saturation, (x, y) => this.update(new HSVA(this.hsva.h, x, 1 - y, this.hsva.a)));
		this.registerDrag(this.hue, (_x, y) => this.update(new HSVA(y * 360, this.hsva.s, this.hsva.v, this.hsva.a)));
		this.registerDrag(this.alpha, (_x, y) => this.update(new HSVA(this.hsva.h, this.hsva.s, this.hsva.v, 1 - y)));
		this.registerKeys(this.saturation, (dx, dy) => this.update(new HSVA(this.hsva.h, this.hsva.s + dx * 0.01, this.hsva.v - dy * 0.01, this.hsva.a)));
		this.registerKeys(this.hue, (_dx, dy) => this.update(new HSVA(this.hsva.h + dy, this.hsva.s, this.hsva.v, this.hsva.a)));
		this.registerKeys(this.alpha, (_dx, dy) => this.update(new HSVA(this.hsva.h, this.hsva.s, this.hsva.v, this.hsva.a - dy * 0.01)));

		this._register(dom.addDisposableListener(this.hexInput, dom.EventType.INPUT, () => {
			const value = this.hexInput.value.trim();
			const color = Color.Format.CSS.parseHex(value.startsWith('#') ? value : `#${value}`);
			if (color) {
				this.update(color.hsva, { keepHexInput: true });
			}
		}));
		this._register(dom.addDisposableListener(this.hexInput, dom.EventType.BLUR, () => {
			this.flush();
			this.render();
		}));
		this._register(dom.addDisposableListener(this.opacityInput, dom.EventType.INPUT, () => {
			const value = Number(this.opacityInput.value);
			if (Number.isFinite(value)) {
				this.update(new HSVA(this.hsva.h, this.hsva.s, this.hsva.v, Math.min(100, Math.max(0, value)) / 100), { keepOpacityInput: true });
			}
		}));
		this._register(dom.addDisposableListener(this.opacityInput, dom.EventType.BLUR, () => {
			this.flush();
			this.render();
		}));
		for (const slider of [this.saturation, this.hue, this.alpha]) {
			this._register(dom.addDisposableListener(slider, dom.EventType.BLUR, () => this.flush()));
		}
		this.render();
	}

	/** 表示する色を差し替える（知らせは出さない）。色相は彩度 0 のときも保つ。 */
	setColor(color: Color | undefined): void {
		// 間引き中の古い値が、差し替えた色（別の色を選んだ後など）に向けて届かないようにする。
		this.throttle.cancel();
		const next = (color ?? Color.transparent).hsva;
		this.hsva = next.s === 0 || next.v === 0 ? new HSVA(this.hsva.h, next.s, next.v, next.a) : next;
		this.render();
	}

	focus(): void {
		this.saturation.focus();
	}

	/** 今の色（`#RRGGBB`、不透明でなければ `#RRGGBBAA`）。 */
	get hex(): string {
		return Color.Format.CSS.formatHexA(new Color(this.hsva), true).toUpperCase();
	}

	private update(hsva: HSVA, options?: { keepHexInput?: boolean; keepOpacityInput?: boolean }): void {
		this.hsva = hsva;
		this.render(options);
		// 間引き（debounce ではなく throttle）: 予約済みなら次の発火で最新の値が届く。
		if (!this.throttle.isScheduled()) {
			this.throttle.schedule();
		}
	}

	/** 予約中の知らせがあれば今すぐ出す（ポインタを離したとき・フォーカスが外れたとき）。 */
	flush(): void {
		if (this.throttle.isScheduled()) {
			this.throttle.cancel();
			this._onDidChange.fire(new Color(this.hsva));
		}
	}

	private render(options?: { keepHexInput?: boolean; keepOpacityInput?: boolean }): void {
		const { h, s, v, a } = this.hsva;
		const pureHue = new Color(new HSVA(h, 1, 1, 1));
		const opaque = new Color(new HSVA(h, s, v, 1));
		this.saturation.style.backgroundColor = Color.Format.CSS.formatHex(pureHue);
		this.saturationHandle.style.left = `${s * 100}%`;
		this.saturationHandle.style.top = `${(1 - v) * 100}%`;
		this.hueHandle.style.top = `${(h / 360) * 100}%`;
		this.alphaFill.style.background = `linear-gradient(to bottom, ${Color.Format.CSS.formatHex(opaque)}, transparent)`;
		this.alphaHandle.style.top = `${(1 - a) * 100}%`;
		this.saturation.setAttribute('aria-valuenow', String(Math.round(s * 100)));
		this.saturation.setAttribute('aria-valuetext', this.hex);
		this.hue.setAttribute('aria-valuenow', String(h));
		this.alpha.setAttribute('aria-valuenow', String(Math.round(a * 100)));
		if (!options?.keepHexInput) {
			this.hexInput.value = this.hex;
		}
		if (!options?.keepOpacityInput) {
			this.opacityInput.value = String(Math.round(a * 100));
		}
	}

	/** 要素の中でのポインタの位置（0〜1）を渡し続ける。 */
	private registerDrag(target: HTMLElement, onMove: (x: number, y: number) => void): void {
		const move = (e: PointerEvent) => {
			const rect = target.getBoundingClientRect();
			const x = rect.width ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
			const y = rect.height ? Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) : 0;
			onMove(x, y);
		};
		this._register(dom.addDisposableListener(target, dom.EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0) {
				return;
			}
			e.preventDefault();
			target.focus();
			target.setPointerCapture(e.pointerId);
			move(e);
		}));
		this._register(dom.addDisposableListener(target, dom.EventType.POINTER_MOVE, (e: PointerEvent) => {
			if (target.hasPointerCapture(e.pointerId)) {
				move(e);
			}
		}));
		this._register(dom.addDisposableListener(target, dom.EventType.POINTER_UP, () => this.flush()));
		this._register(dom.addDisposableListener(target, 'lostpointercapture', () => this.flush()));
	}

	private registerKeys(target: HTMLElement, onStep: (dx: number, dy: number) => void): void {
		this._register(dom.addDisposableListener(target, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const step = e.shiftKey ? 10 : 1;
			const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
			const d = delta[e.key];
			if (d) {
				e.preventDefault();
				e.stopPropagation();
				onStep(d[0], d[1]);
			}
		}));
	}
}
