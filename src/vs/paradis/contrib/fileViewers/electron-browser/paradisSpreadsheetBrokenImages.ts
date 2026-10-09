/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IParadisRenderShape } from '../common/paradisSpreadsheet.js';

/**
 * 描いた後で読めなかった画像を覚え、知らせをまとめて 1 回にする。同じ壊れた画像を数千の図形が使うと
 * `error` がその数だけ届くので、1 件ごとに画面を作り直すと固まる。
 */
export class ParadisSpreadsheetBrokenImages extends Disposable {
	private readonly images = new Map<IParadisRenderShape, string>();
	private readonly scheduler: RunOnceScheduler;

	constructor(onChange: () => void, delay = 50) {
		super();
		this.scheduler = this._register(new RunOnceScheduler(onChange, delay));
	}

	/** 図形 → シート名。 */
	get entries(): ReadonlyMap<IParadisRenderShape, string> {
		return this.images;
	}

	add(shape: IParadisRenderShape, sheetName: string): void {
		if (this.images.has(shape)) {
			return;
		}
		this.images.set(shape, sheetName);
		if (!this.scheduler.isScheduled()) {
			this.scheduler.schedule();
		}
	}

	clear(): void {
		this.images.clear();
		this.scheduler.cancel();
	}
}
