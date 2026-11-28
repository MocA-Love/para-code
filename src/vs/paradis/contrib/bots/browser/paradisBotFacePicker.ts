/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 新しい Bot の作成の画面で、名前の下に常に並べる顔の色（8 個）と形（6 個）の選ぶ欄（Q690 の案 B）。選ぶと名前の左の顔が
// すぐ変わる。手で選ばない方は名前から決まる顔のまま追従し、「名前から自動に戻す」で戻せる。色だけで見分けないよう、今の
// 選択を文字（例「山吹（名前から自動）」）で出し、ボタンにも日本語の名前を読み上げとホバーで付ける。
// 見た目は media/paradisBotsBand.css の作成の画面の節。

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { PARADIS_BOT_FACE_COLORS, PARADIS_BOT_FACE_SHAPES, ParadisBotFaceColor, ParadisBotFaceShape } from '../common/paradisBots.js';
import { paradisBotFaceColorLabel, paradisBotFaceShapeLabel } from '../common/paradisBotsBandModel.js';
import { renderParadisBotFace } from './paradisBotFace.js';

const $ = dom.$;

/** 選ぶ欄で起きたこと。`color`・`shape` は手で選んだ値、`undefined` は「名前から自動に戻す」。 */
export type ParadisBotFacePick = { readonly kind: 'color'; readonly value: ParadisBotFaceColor | undefined } | { readonly kind: 'shape'; readonly value: ParadisBotFaceShape | undefined };

interface IGroup<T extends string> {
	readonly value: HTMLElement;
	readonly reset: HTMLButtonElement;
	readonly buttons: ReadonlyMap<T, HTMLButtonElement>;
}

export class ParadisBotFacePicker extends Disposable {

	private readonly _onDidPick = this._register(new Emitter<ParadisBotFacePick>());
	readonly onDidPick: Event<ParadisBotFacePick> = this._onDidPick.event;

	readonly element: HTMLElement;
	private readonly colors: IGroup<ParadisBotFaceColor>;
	private readonly shapes: IGroup<ParadisBotFaceShape>;
	/** 形の見本の顔（今の色で描く。色を変えたら data-color だけ替える）。 */
	private readonly shapeFaces: HTMLElement[] = [];

	constructor(
		parent: HTMLElement,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this.element = dom.append(parent, $('.pbcd-picker'));
		this.colors = this.group('color', localize('paradis.bots.create.faceColor', "色"), PARADIS_BOT_FACE_COLORS, paradisBotFaceColorLabel, (button, color) => {
			renderParadisBotFace(button, { shape: 'circle', color, still: true });
		});
		this.shapes = this.group('shape', localize('paradis.bots.create.faceShape', "形"), PARADIS_BOT_FACE_SHAPES, paradisBotFaceShapeLabel, (button, shape) => {
			this.shapeFaces.push(renderParadisBotFace(button, { shape, color: PARADIS_BOT_FACE_COLORS[0], still: true }));
		});
	}

	/** 今の顔と、手で選んだか（選んでいない方は「名前から自動」と出し、戻すボタンを止める）。 */
	update(face: { readonly faceColor: ParadisBotFaceColor; readonly faceShape: ParadisBotFaceShape }, picked: { readonly color?: ParadisBotFaceColor; readonly shape?: ParadisBotFaceShape }): void {
		this.apply(this.colors, face.faceColor, paradisBotFaceColorLabel(face.faceColor), picked.color !== undefined);
		this.apply(this.shapes, face.faceShape, paradisBotFaceShapeLabel(face.faceShape), picked.shape !== undefined);
		for (const shapeFace of this.shapeFaces) {
			shapeFace.dataset.color = face.faceColor;
		}
	}

	private apply<T extends string>(group: IGroup<T>, current: T, label: string, picked: boolean): void {
		group.value.textContent = picked ? label : localize('paradis.bots.create.faceAuto', "{0}（名前から自動）", label);
		group.reset.disabled = !picked;
		for (const [value, button] of group.buttons) {
			button.setAttribute('aria-checked', String(value === current));
			// 矢印キーで動く 1 つの組。Tab で入るのは選ばれている 1 つだけ
			button.tabIndex = value === current ? 0 : -1;
		}
	}

	private group<T extends string>(kind: ParadisBotFacePick['kind'], title: string, values: readonly T[], labelOf: (value: T) => string, render: (button: HTMLButtonElement, value: T) => void): IGroup<T> {
		const head = dom.append(this.element, $('.pbcd-pick-head'));
		const titleElement = dom.append(head, $('span.pbcd-pick-title'));
		titleElement.textContent = title;
		const value = dom.append(head, $('span.pbcd-pick-value'));
		value.setAttribute('aria-live', 'polite');
		const reset = dom.append(head, $('button.pbcd-pick-reset.paradis-focus-ring')) as HTMLButtonElement;
		reset.type = 'button';
		reset.textContent = localize('paradis.bots.create.faceReset', "名前から自動に戻す");
		this._register(dom.addDisposableListener(reset, dom.EventType.CLICK, () => {
			this.fire(kind, undefined);
			// 戻した後は、選ばれている見本へフォーカスを移す（押したボタンは止まる）
			[...buttons.values()].find(button => button.getAttribute('aria-checked') === 'true')?.focus();
		}));

		const list = dom.append(this.element, $('.pbcd-swatches'));
		list.setAttribute('role', 'radiogroup');
		list.setAttribute('aria-label', title);
		const buttons = new Map<T, HTMLButtonElement>();
		for (const item of values) {
			const button = dom.append(list, $('button.pbcd-swatch.paradis-focus-ring')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'radio');
			button.setAttribute('aria-label', labelOf(item));
			this._register(this.hoverService.setupDelayedHover(button, { content: labelOf(item) }));
			render(button, item);
			buttons.set(item, button);
			this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.fire(kind, item)));
		}
		this._register(dom.addDisposableListener(list, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			const index = values.findIndex(item => buttons.get(item) === e.target);
			if (index < 0) {
				return;
			}
			let next: number | undefined;
			if (event.equals(KeyCode.RightArrow) || event.equals(KeyCode.DownArrow)) {
				next = (index + 1) % values.length;
			} else if (event.equals(KeyCode.LeftArrow) || event.equals(KeyCode.UpArrow)) {
				next = (index + values.length - 1) % values.length;
			} else if (event.equals(KeyCode.Home)) {
				next = 0;
			} else if (event.equals(KeyCode.End)) {
				next = values.length - 1;
			}
			if (next !== undefined) {
				dom.EventHelper.stop(e, true);
				this.fire(kind, values[next]);
				buttons.get(values[next])?.focus();
			}
		}));
		return { value, reset, buttons };
	}

	private fire(kind: ParadisBotFacePick['kind'], value: string | undefined): void {
		this._onDidPick.fire(kind === 'color' ? { kind, value: value as ParadisBotFaceColor | undefined } : { kind, value: value as ParadisBotFaceShape | undefined });
	}
}
