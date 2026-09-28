/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

/**
 * スマホの画面に合わせて PC のターミナルを縮めているか（W2-19）。
 *
 * 縮めるのはモバイル連携の provider（`paradisMobileWorkspaceProvider.ts`）、それを PC の画面に
 * 「スマホ表示に合わせて縮小中」と出して［PC の幅に戻す］を受けるのはターミナルの上の表示
 * （`paradisMobileViewportBanner.contribution.ts`）。両者はこのウィンドウの中の 1 つの台帳を介して
 * つながる（provider はウィンドウの contribution が組み立てるので、DI の外にある）。
 *
 * 台帳が持つのは状態だけで、戻す操作は provider が登録した口を直接呼ぶ。
 */

/** いま掛けている寸法（行は「桁だけ合わせる」設定なら無い）。 */
export interface IParadisMobileViewportOverride {
	readonly cols: number;
	readonly rows?: number;
}

/** 縮めている側（provider）が受ける操作。 */
export interface IParadisMobileViewportController {
	/** そのターミナルを PC の幅へ戻し、スマホから縮め直させない（スマホが開き直すか［再び合わせる］を押すまで）。 */
	takeBack(instanceId: number): void;
}

export class ParadisMobileTerminalViewportStatus extends Disposable {
	private readonly overrides = new Map<number, IParadisMobileViewportOverride>();
	private readonly _onDidChange = this._register(new Emitter<number>());
	/** 縮めている寸法が変わったターミナル（instanceId）。 */
	readonly onDidChange: Event<number> = this._onDidChange.event;
	private controller: IParadisMobileViewportController | undefined;

	/** そのターミナルに掛けている寸法（掛けていなければ `undefined`）。 */
	get(instanceId: number): IParadisMobileViewportOverride | undefined {
		return this.overrides.get(instanceId);
	}

	set(instanceId: number, override: IParadisMobileViewportOverride | undefined): void {
		const previous = this.overrides.get(instanceId);
		if (previous?.cols === override?.cols && previous?.rows === override?.rows) {
			return;
		}
		if (override === undefined) {
			this.overrides.delete(instanceId);
		} else {
			this.overrides.set(instanceId, { cols: override.cols, ...(override.rows !== undefined ? { rows: override.rows } : {}) });
		}
		this._onDidChange.fire(instanceId);
	}

	/** provider が戻す口を登録する。外すと、登録していた provider が掛けた表示も消す。 */
	setController(controller: IParadisMobileViewportController): IDisposable {
		this.controller = controller;
		return toDisposable(() => {
			if (this.controller !== controller) {
				return;
			}
			this.controller = undefined;
			for (const instanceId of [...this.overrides.keys()]) {
				this.set(instanceId, undefined);
			}
		});
	}

	/** ［PC の幅に戻す］。縮めている provider が居なければ何もしない。 */
	takeBack(instanceId: number): void {
		this.controller?.takeBack(instanceId);
	}
}

/** このウィンドウの台帳（ウィンドウと同じだけ生きるので破棄しない）。 */
export const paradisMobileTerminalViewportStatus = new ParadisMobileTerminalViewportStatus();
