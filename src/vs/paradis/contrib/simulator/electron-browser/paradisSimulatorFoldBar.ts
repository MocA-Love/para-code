/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// iPhone Duo の開閉のバー（q.html Q582 の画面案 3。折りたたみの端末のときだけ出す）。
//
//  - 3 つの姿勢（閉じる 0°・本 130°・開く 180°。serve-sim 0.1.49 の DUO_POSES）のボタン。Option（Alt）を押している
//    間と「角度」のボタンで、角度のスライダーに替える
//  - 開閉は Device Hub が起動していないと効かない（Mac で実測）。起動していなければその旨と「Device Hub を起動」の
//    ボタンを出す（押したときだけ裏で起動する）
//  - iOS 27.2 などでは、角度が変わっても外と内の画面が切り替わらず内のまま映る（Mac で実測）。そのときはその旨を出す
// 状態の読み取りと開閉の送り先はエディタのペイン（paradisSimulatorEditor.ts）が持ち、ここは表示とボタンだけ。

import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { PARADIS_SIMULATOR_POSES, ParadisSimulatorPose } from '../common/paradisSimulator.js';

const $ = dom.$;

/** バーに出す様子。 */
export interface IParadisSimulatorFoldState {
	readonly hingeDegrees: number;
	readonly activeDisplay: 'cover' | 'inner';
	/** Device Hub が起動しているか（分からなければ undefined）。 */
	readonly deviceHubRunning: boolean | undefined;
	/** 開閉を送っている最中か。 */
	readonly busy: boolean;
	/** 直前の開閉が断られた・失敗したときの理由。 */
	readonly error?: string;
}

/** 開き具合から見込まれる画面と、実際に映っている画面が食い違うか（閉じたのに内のまま、など）。 */
export function paradisSimulatorPanelMismatch(state: Pick<IParadisSimulatorFoldState, 'hingeDegrees' | 'activeDisplay'>): boolean {
	const expected = state.hingeDegrees < 90 ? 'cover' : 'inner';
	return expected !== state.activeDisplay;
}

/** 開閉の求め。 */
export type ParadisSimulatorFoldRequest = { readonly kind: 'pose'; readonly pose: ParadisSimulatorPose } | { readonly kind: 'hinge'; readonly hinge: number };

export class ParadisSimulatorFoldBar extends Disposable {

	readonly element: HTMLElement;
	private readonly _poseButtons = new Map<ParadisSimulatorPose, Button>();
	private readonly _angleButton: Button;
	private readonly _poses: HTMLElement;
	private readonly _slider: HTMLInputElement;
	private readonly _sliderLabel: HTMLElement;
	private readonly _status: HTMLElement;
	private readonly _note: HTMLElement;
	private readonly _deviceHub: HTMLElement;
	private readonly _deviceHubText: HTMLElement;
	private _sliderPinned = false;
	private _optionHeld = false;
	private _state: IParadisSimulatorFoldState | undefined;

	private readonly _onDidRequestFold = this._register(new Emitter<ParadisSimulatorFoldRequest>());
	readonly onDidRequestFold = this._onDidRequestFold.event;

	private readonly _onDidRequestDeviceHub = this._register(new Emitter<void>());
	/** 「Device Hub を起動」を押した。 */
	readonly onDidRequestDeviceHub = this._onDidRequestDeviceHub.event;

	constructor(container: HTMLElement) {
		super();
		this.element = dom.append(container, $('.paradis-simulator-fold'));
		const row = dom.append(this.element, $('.paradis-simulator-fold-row'));
		dom.append(row, $('span.paradis-simulator-fold-label')).textContent = localize('paradis.simulator.fold.label', "姿勢");
		this._poses = dom.append(row, $('.paradis-simulator-fold-poses'));
		const labels: { readonly [pose in ParadisSimulatorPose]: string } = {
			closed: localize('paradis.simulator.fold.closed', "閉じる 0°"),
			book: localize('paradis.simulator.fold.book', "本 130°"),
			open: localize('paradis.simulator.fold.open', "開く 180°"),
		};
		for (const { id } of PARADIS_SIMULATOR_POSES) {
			const button = this._register(new Button(this._poses, { ...defaultButtonStyles, secondary: true, small: true, title: labels[id] }));
			button.label = labels[id];
			this._register(button.onDidClick(() => this._onDidRequestFold.fire({ kind: 'pose', pose: id })));
			this._poseButtons.set(id, button);
		}
		this._slider = dom.append(row, $<HTMLInputElement>('input.paradis-simulator-fold-slider'));
		this._slider.type = 'range';
		this._slider.min = '0';
		this._slider.max = '180';
		this._slider.step = '1';
		this._slider.setAttribute('aria-label', localize('paradis.simulator.fold.angleAria', "開き具合（度）"));
		this._sliderLabel = dom.append(row, $('span.paradis-simulator-fold-angle'));
		this._register(dom.addDisposableListener(this._slider, 'input', () => this._sliderLabel.textContent = `${this._slider.value}°`));
		this._register(dom.addDisposableListener(this._slider, 'change', () => this._onDidRequestFold.fire({ kind: 'hinge', hinge: Number(this._slider.value) })));
		this._angleButton = this._register(new Button(row, { ...defaultButtonStyles, secondary: true, small: true, title: localize('paradis.simulator.fold.angleTitle', "角度で開閉する（Option を押している間も出ます）") }));
		this._angleButton.label = localize('paradis.simulator.fold.angle', "角度");
		this._register(this._angleButton.onDidClick(() => {
			this._sliderPinned = !this._sliderPinned;
			this._render();
		}));
		this._status = dom.append(row, $('span.paradis-simulator-fold-status'));

		this._note = dom.append(this.element, $('.paradis-simulator-fold-note'));
		this._deviceHub = dom.append(this.element, $('.paradis-simulator-fold-note'));
		this._deviceHubText = dom.append(this._deviceHub, $('span'));
		this._deviceHubText.textContent = localize('paradis.simulator.fold.deviceHub', "開閉には Xcode の Device Hub が起動している必要があります。");
		const start = this._register(new Button(this._deviceHub, { ...defaultButtonStyles, small: true }));
		start.label = localize('paradis.simulator.fold.startDeviceHub', "Device Hub を起動");
		this._register(start.onDidClick(() => this._onDidRequestDeviceHub.fire()));

		// Option（Alt）を押している間は角度のスライダーに替える
		const targetWindow = dom.getWindow(container);
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => this._setOptionHeld(event.altKey)));
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.KEY_UP, (event: KeyboardEvent) => this._setOptionHeld(event.altKey)));
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.BLUR, () => this._setOptionHeld(false)));
		this.update(undefined);
	}

	/** 折りたたみの端末でなければ undefined（バーを隠す）。 */
	update(state: IParadisSimulatorFoldState | undefined): void {
		this._state = state;
		this._render();
	}

	private _setOptionHeld(held: boolean): void {
		if (held !== this._optionHeld) {
			this._optionHeld = held;
			this._render();
		}
	}

	private _render(): void {
		const state = this._state;
		this.element.style.display = state ? '' : 'none';
		if (!state) {
			return;
		}
		const showSlider = this._sliderPinned || this._optionHeld;
		this._poses.style.display = showSlider ? 'none' : '';
		this._slider.style.display = showSlider ? '' : 'none';
		this._sliderLabel.style.display = showSlider ? '' : 'none';
		if (dom.getActiveElement() !== this._slider) {
			this._slider.value = String(Math.round(state.hingeDegrees));
			this._sliderLabel.textContent = `${Math.round(state.hingeDegrees)}°`;
		}
		for (const [pose, button] of this._poseButtons) {
			const hinge = PARADIS_SIMULATOR_POSES.find(candidate => candidate.id === pose)!.hingeDegrees;
			button.enabled = !state.busy;
			button.element.classList.toggle('checked', Math.abs(state.hingeDegrees - hinge) < 1);
		}
		this._slider.disabled = state.busy;
		this._status.textContent = state.busy
			? localize('paradis.simulator.fold.busy', "開閉しています…")
			: state.activeDisplay === 'cover'
				? localize('paradis.simulator.fold.coverShown', "{0}° · 外の画面", Math.round(state.hingeDegrees))
				: localize('paradis.simulator.fold.innerShown', "{0}° · 内の画面", Math.round(state.hingeDegrees));

		const note = state.error
			?? (paradisSimulatorPanelMismatch(state)
				? localize('paradis.simulator.fold.noSwitch', "開き具合は変わりましたが、このシミュレータは{0}のまま映っています（iOS 27.2 では外と内が切り替わりません）。タップの位置は映っている画面に合わせます。", state.activeDisplay === 'inner' ? localize('paradis.simulator.fold.inner', "内の画面") : localize('paradis.simulator.fold.cover', "外の画面"))
				: undefined);
		this._note.style.display = note ? '' : 'none';
		this._note.textContent = note ?? '';
		this._deviceHub.style.display = state.deviceHubRunning === false ? '' : 'none';
	}
}
