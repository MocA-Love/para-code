/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// Word 文書に埋め込まれた「描ける対象」の形。node 層(抽出)と renderer 層(描画)の両方から使うため
// common に置く。docx-preview はグラフや SmartArt を描かないので、そこを自前で補うための入力になる。

import type { ParadisOfficeFingerprint, ParadisOfficeTextRun } from '../paradisOfficeProtocol.js';
import type { ParadisWordDrawingGeometry } from './paradisWordSemantic.js';

export interface ParadisWordRenderableObjectBase {
	readonly id: string;
	readonly geometry: ParadisWordDrawingGeometry;
	/**
	 * `wp:docPr@id`。docx-preview が描いた枠に付く目印と同じ値で、
	 * 差し込み先をこの値で突き合わせる(出現順に頼らないため)。
	 */
	readonly drawingId?: string;
}

export interface ParadisWordShapeObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'shape';
}

export interface ParadisWordTextboxObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'textbox';
	readonly runs: readonly ParadisOfficeTextRun[];
}

export interface ParadisWordWordArtObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'wordArt';
	readonly text: string;
}

export interface ParadisWordChartSeries {
	readonly name?: string;
	readonly values: readonly { readonly index: number; readonly value: string }[];
}

export interface ParadisWordChartObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'chart';
	readonly chartType: 'bar' | 'column' | string;
	readonly title?: string;
	readonly series: readonly ParadisWordChartSeries[];
}

export interface ParadisWordSmartArtNode {
	readonly id: string;
	readonly label: string;
	readonly parentId?: string;
}

export interface ParadisWordSmartArtObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'smartArt';
	readonly layout: 'flow' | 'hierarchy';
	readonly nodes: readonly ParadisWordSmartArtNode[];
}

export type ParadisWordRenderableImageContent =
	| { readonly assetId: string; readonly contentType: string; readonly fingerprint: ParadisOfficeFingerprint }
	| { readonly behavior: 'notFetched' };

export interface ParadisWordImageObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'image';
	readonly content: ParadisWordRenderableImageContent;
	readonly altText?: string;
}

export interface ParadisWordObjectPreviewReference {
	readonly id: string;
	readonly contentType: string;
	readonly fingerprint: ParadisOfficeFingerprint;
}

export interface ParadisWordOleObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'ole';
	readonly preview?: ParadisWordObjectPreviewReference;
}

export type ParadisWordRenderableObject =
	| ParadisWordShapeObject
	| ParadisWordTextboxObject
	| ParadisWordWordArtObject
	| ParadisWordChartObject
	| ParadisWordSmartArtObject
	| ParadisWordImageObject
	| ParadisWordOleObject;
