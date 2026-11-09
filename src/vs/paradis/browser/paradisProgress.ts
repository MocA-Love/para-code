/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの段 4（Q600）の進み具合。太さ 4、地は中立の塗り、帯はアクセント（要対応のときだけ警告・危険の色）。
//
// 包んでいる本家のファイル: 無し。本家の ProgressBar（src/vs/base/browser/ui/progressbar/progressbar.ts）は「処理中」を
// 示す 2px の帯で、done() で消え、色を 1 つ inline で書く作り。ここは「どこまで使ったか」をずっと見せる帯で、
// モデルごとの色も要るため別にした。読み上げは本家と同じ role="progressbar" と aria-valuemin・max・now。

import './media/paradisProgress.css';
import { $, append } from '../../base/browser/dom.js';

/** 帯の色の意味。`accent` が平常、`warning`・`danger` は人が見る必要があるとき。 */
export type ParadisProgressTone = 'accent' | 'warning' | 'danger';

export interface IParadisProgressOptions {
	readonly ariaLabel: string;
	/** 0 から 1。範囲の外は丸める。 */
	readonly value: number;
	readonly tone?: ParadisProgressTone;
	/** 帯の色を画面が決めるとき（グラフの系列の色など）。テーマの色の CSS 値。 */
	readonly color?: string;
}

export interface IParadisProgress {
	readonly element: HTMLElement;
	update(value: number, tone?: ParadisProgressTone): void;
}

/** 進み具合の帯を作る。 */
export function renderParadisProgress(parent: HTMLElement, options: IParadisProgressOptions): IParadisProgress {
	const element = append(parent, $('.paradis-progress'));
	element.setAttribute('role', 'progressbar');
	element.setAttribute('aria-label', options.ariaLabel);
	element.setAttribute('aria-valuemin', '0');
	element.setAttribute('aria-valuemax', '100');
	const fill = append(element, $('.paradis-progress-fill'));
	if (options.color) {
		fill.style.backgroundColor = options.color;
	}
	const update = (value: number, tone: ParadisProgressTone = 'accent') => {
		const percent = Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 1000) / 10;
		fill.style.width = `${percent}%`;
		element.setAttribute('aria-valuenow', String(Math.round(percent)));
		element.classList.toggle('warning', tone === 'warning');
		element.classList.toggle('danger', tone === 'danger');
	};
	update(options.value, options.tone);
	return { element, update };
}
