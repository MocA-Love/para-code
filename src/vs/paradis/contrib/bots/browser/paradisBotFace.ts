/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の顔（ParaDot 風のドットの顔）。帯の行・Bot のページの見出し・吹き出し・作成の画面の見本で同じ部品を使う。見た目と動きは
// media/paradisBotsBand.css。

import * as DOM from '../../../../base/browser/dom.js';
import { ParadisBotFaceColor, ParadisBotFaceShape } from '../common/paradisBots.js';
import { ParadisBotFaceState, ParadisBotFaceTransitionLedger, paradisBotFacePhaseSeconds } from '../common/paradisBotsBandModel.js';

const $ = DOM.$;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 顔の体の形（100×100 の枠）。ParaDot のドットの顔に寄せた形。 */
const FACE_BODIES: Record<ParadisBotFaceShape, { readonly tag: string; readonly attributes: Record<string, string> }> = {
	circle: { tag: 'circle', attributes: { cx: '50', cy: '52', r: '42' } },
	squircle: { tag: 'rect', attributes: { x: '9', y: '11', width: '82', height: '82', rx: '30' } },
	hex: { tag: 'polygon', attributes: { points: '50,12 86,31 86,69 50,88 14,69 14,31', 'stroke-width': '14' } },
	blob: { tag: 'path', attributes: { d: 'M50 8C78 6 94 30 92 56C90 82 66 94 44 92C20 90 8 70 10 46C12 22 30 10 50 8Z' } },
	drop: { tag: 'path', attributes: { d: 'M46 6C70 4 90 28 90 56C90 80 72 94 50 94C28 94 10 80 10 58C10 30 24 8 46 6Z' } },
	penta: { tag: 'polygon', attributes: { points: '50,14 88,41 74,86 26,86 12,41', 'stroke-width': '14' } },
};

function svg(tag: string, attributes: Record<string, string>, parent?: Element): SVGElement {
	const element = document.createElementNS(SVG_NS, tag);
	for (const [name, value] of Object.entries(attributes)) {
		element.setAttribute(name, value);
	}
	parent?.appendChild(element);
	return element;
}

/**
 * 様子の変わり目。描いた場所（帯・見出し・吹き出し）をまたいで Bot ごとに 1 つ持つので、描き直しても・同じ Bot を 2 か所で
 * 描いても、つなぎは 1 回だけで、同じ時刻に揃う。
 */
const transitions = new ParadisBotFaceTransitionLedger();

/**
 * 小道具の出し方。`none` は出さない（作成の画面の見本）、`attention` は注意の要る 2 つ（「?」と汗）だけ（帯の 18px・
 * グループの 14px）、`all` は全部（見出しの 22px・吹き出し）。
 */
export type ParadisBotFaceProps = 'none' | 'attention' | 'all';

export interface IParadisBotFaceRender {
	readonly shape: ParadisBotFaceShape;
	readonly color: ParadisBotFaceColor;
	readonly state?: ParadisBotFaceState;
	/** Bot の id（位相とつなぎ）。無ければ位相をずらさず、つなぎも出さない。 */
	readonly id?: string;
	/** 既定は `attention`。 */
	readonly props?: ParadisBotFaceProps;
	/** 動かさない（色と形の見本のように、たくさん並べるもの）。 */
	readonly still?: boolean;
}

/**
 * Bot の顔（ドットの体と 2 つの目と小道具）。形と色は台帳の名前で、色の値は CSS がテーマの色から決める（data-color）。
 * 様子（data-state）ごとの目の形・印・動きは media/paradisBotsBand.css。動きを止めた表示では、目の形と印だけが残る。
 * 作成の画面の見本でも使うので、様子を持たない顔（`state` 無し）も描ける。
 */
export function renderParadisBotFace(parent: HTMLElement, face: IParadisBotFaceRender): HTMLElement {
	const element = DOM.append(parent, $('span.paradis-bot-face'));
	const state = face.state ?? 'idle';
	element.dataset.state = state;
	element.dataset.color = face.color;
	element.dataset.props = face.props ?? 'attention';
	element.setAttribute('aria-hidden', 'true');
	if (face.still === true) {
		element.dataset.still = 'true';
	} else {
		// 動きは時計に合わせる（描き直しても途中から続く）。Bot ごとに位相をずらし、帯で一斉にまばたきさせない
		const now = performance.now();
		const phase = face.id !== undefined ? paradisBotFacePhaseSeconds(face.id) : 0;
		element.style.setProperty('--paradis-bot-face-loop', `${-(now / 1000 + phase).toFixed(2)}s`);
		const transition = face.id !== undefined ? transitions.observe(face.id, state, now) : undefined;
		if (transition !== undefined) {
			element.dataset.transition = transition.kind;
			element.style.setProperty('--paradis-bot-face-since', `${-(transition.elapsedMs / 1000).toFixed(2)}s`);
		}
	}

	const root = svg('svg', { viewBox: '0 0 100 100' });
	// つなぎの動き（起きる・弾む・震える・跳ねる）と、様子ごとの繰り返しの動き（息・うなずき・跳ね）は別の層に掛ける
	const motion = svg('g', { class: 'paradis-bot-face-motion' }, root);
	const body = svg('g', { class: 'paradis-bot-face-body' }, motion);
	const shape = FACE_BODIES[face.shape];
	svg(shape.tag, { ...shape.attributes, class: 'paradis-bot-face-shape' }, body);
	const eyesEvent = svg('g', { class: 'paradis-bot-face-eyes-event' }, body);
	const eyes = svg('g', { class: 'paradis-bot-face-eyes' }, eyesEvent);
	const open = svg('g', { class: 'paradis-bot-face-eyes-open' }, eyes);
	svg('ellipse', { class: 'paradis-bot-face-eye', cx: '38', cy: '47', rx: '5.5', ry: '10' }, open);
	svg('ellipse', { class: 'paradis-bot-face-eye', cx: '62', cy: '45', rx: '5.5', ry: '10' }, open);
	// 眠っている: 下向きの弧。起動していない: 横の線。できた: 上向きの弧（閉じた目の笑顔）
	const closed = svg('g', { class: 'paradis-bot-face-eyes-closed paradis-bot-face-eye-line' }, eyes);
	svg('path', { d: 'M32 46Q38 53 44 46' }, closed);
	svg('path', { d: 'M56 44Q62 51 68 44' }, closed);
	const flat = svg('g', { class: 'paradis-bot-face-eyes-flat paradis-bot-face-eye-line' }, eyes);
	svg('path', { d: 'M32 48H44' }, flat);
	svg('path', { d: 'M56 46H68' }, flat);
	const happy = svg('g', { class: 'paradis-bot-face-eyes-happy paradis-bot-face-eye-line' }, eyes);
	svg('path', { d: 'M32 50Q38 42 44 50' }, happy);
	svg('path', { d: 'M56 48Q62 40 68 48' }, happy);

	// 小道具（体の動きに付いて行かないよう、体の外に置く）
	const dots = svg('g', { class: 'paradis-bot-face-prop paradis-bot-face-dots' }, root);
	for (const [index, cx] of ['36', '50', '64'].entries()) {
		svg('circle', { cx, cy: '-6', r: '4.5', style: `--paradis-bot-face-dot: ${index}` }, dots);
	}
	const lens = svg('g', { class: 'paradis-bot-face-prop paradis-bot-face-lens' }, root);
	svg('circle', { cx: '80', cy: '16', r: '9' }, lens);
	svg('path', { d: 'M86.5 22.5L95 31' }, lens);
	const sleep = svg('g', { class: 'paradis-bot-face-prop paradis-bot-face-zz' }, root);
	svg('path', { d: 'M74 8H84L74 18H84' }, sleep);
	svg('path', { d: 'M88 -6H95L88 1H95' }, sleep);
	const pause = svg('g', { class: 'paradis-bot-face-prop paradis-bot-face-pause' }, root);
	svg('rect', { x: '78', y: '2', width: '6', height: '18', rx: '2' }, pause);
	svg('rect', { x: '89', y: '2', width: '6', height: '18', rx: '2' }, pause);
	const ask = svg('g', { class: 'paradis-bot-face-prop paradis-bot-face-ask' }, root);
	svg('circle', { cx: '86', cy: '16', r: '16' }, ask);
	svg('path', { d: 'M80 11Q80 4 86 4Q92 4 92 10Q92 14 86 17V20' }, ask);
	svg('circle', { class: 'paradis-bot-face-ask-dot', cx: '86', cy: '27', r: '2.6' }, ask);
	const sweat = svg('g', { class: 'paradis-bot-face-prop paradis-bot-face-sweat' }, root);
	svg('path', { d: 'M86 14C91 22 94 27 94 31A8 8 0 0 1 78 31C78 27 81 22 86 14Z' }, sweat);
	const check = svg('g', { class: 'paradis-bot-face-prop paradis-bot-face-check' }, root);
	svg('path', { d: 'M74 14L81 21L95 5' }, check);

	element.appendChild(root);
	return element;
}
