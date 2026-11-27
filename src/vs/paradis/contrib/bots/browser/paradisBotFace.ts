/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の顔（ParaDot 風のドットの顔）。Bot の帯の行と、作成の画面の見本で使う。見た目は media/paradisBotsBand.css。

import * as DOM from '../../../../base/browser/dom.js';
import { ParadisBotFaceColor, ParadisBotFaceShape } from '../common/paradisBots.js';

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

function svg(tag: string, attributes: Record<string, string>): SVGElement {
	const element = document.createElementNS(SVG_NS, tag);
	for (const [name, value] of Object.entries(attributes)) {
		element.setAttribute(name, value);
	}
	return element;
}

/**
 * Bot の顔（ドットの体と 2 つの目）。形と色は台帳の名前で、色の値は CSS がテーマの色から決める（data-color）。
 * 作成の画面の見本でも使うので、様子を持たない顔（`state` 無し）も描ける。
 */
export function renderParadisBotFace(parent: HTMLElement, face: { readonly shape: ParadisBotFaceShape; readonly color: ParadisBotFaceColor; readonly state?: string }): HTMLElement {
	const element = DOM.append(parent, $('span.paradis-bot-face'));
	element.dataset.state = face.state ?? 'idle';
	element.dataset.color = face.color;
	element.setAttribute('aria-hidden', 'true');
	const root = svg('svg', { viewBox: '0 0 100 100' });
	const body = svg('g', { class: 'paradis-bot-face-body' });
	const shape = FACE_BODIES[face.shape];
	body.appendChild(svg(shape.tag, shape.attributes));
	root.appendChild(body);
	root.appendChild(svg('ellipse', { class: 'paradis-bot-face-eye', cx: '38', cy: '47', rx: '5.5', ry: '10' }));
	root.appendChild(svg('ellipse', { class: 'paradis-bot-face-eye', cx: '62', cy: '45', rx: '5.5', ry: '10' }));
	element.appendChild(root);
	return element;
}
