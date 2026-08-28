/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisOfficeRenderCoverage } from '../../common/paradisOfficeProtocol.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export interface ParadisWordObjectBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export type ParadisWordPlaceholderCoverage = Extract<ParadisOfficeRenderCoverage, 'placeholder' | 'blockedByPolicy' | 'noAnchor'>;

export interface ParadisWordPlaceholderOptions {
	readonly nodeId: string;
	readonly feature: string;
	readonly coverage: ParadisWordPlaceholderCoverage;
	readonly bounds?: ParadisWordObjectBounds;
	readonly ordinal?: number;
}

/** Formats one finite numeric SVG coordinate without preserving negative zero. */
export function formatWordSvgNumber(value: number): string {
	const rounded = Math.round(value * 1_000_000_000) / 1_000_000_000;
	return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** 属性値の長さ上限。診断用の識別子なので、これを超える分は捨ててよい。 */
const MAX_PLACEHOLDER_ATTRIBUTE_LENGTH = 4_096;

function boundedAttributeValue(value: string): string {
	return value.length <= MAX_PLACEHOLDER_ATTRIBUTE_LENGTH ? value : value.slice(0, MAX_PLACEHOLDER_ATTRIBUTE_LENGTH);
}

/** Appends a script-free, fixed-structure placeholder for one Word object. */
export function appendWordObjectPlaceholder(root: SVGSVGElement, options: ParadisWordPlaceholderOptions): SVGGElement {
	const document = root.ownerDocument;
	const group = document.createElementNS(SVG_NAMESPACE, 'g');
	group.setAttribute('class', 'paradis-word-object-placeholder');
	// 文書由来の値がそのまま属性に入る唯一の場所。長さを縛らないと、巨大な id を並べた
	// ファイルだけで数十 MB の SVG を作らされる(テキスト側の safeText と同じ扱いにする)。
	group.setAttribute('data-node-id', boundedAttributeValue(options.nodeId));
	group.setAttribute('data-feature', boundedAttributeValue(options.feature));
	group.setAttribute('data-coverage', boundedAttributeValue(options.coverage));

	const fallback = { x: 0, y: (options.ordinal ?? 0) * 18, width: 120, height: 16 };
	const bounds = options.bounds ?? fallback;
	const rectangle = document.createElementNS(SVG_NAMESPACE, 'rect');
	rectangle.setAttribute('x', formatWordSvgNumber(bounds.x));
	rectangle.setAttribute('y', formatWordSvgNumber(bounds.y));
	rectangle.setAttribute('width', formatWordSvgNumber(Math.max(1, bounds.width)));
	rectangle.setAttribute('height', formatWordSvgNumber(Math.max(1, bounds.height)));
	rectangle.setAttribute('fill', 'none');
	rectangle.setAttribute('stroke', 'currentColor');
	rectangle.setAttribute('stroke-dasharray', '4,3');
	group.appendChild(rectangle);
	root.appendChild(group);
	return group;
}
