/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	IParadisExactBrowserViewDescriptor,
	paradisExactViewKey as exactViewKey,
	paradisParseExactBrowserViewDescriptor,
} from './paradisAgentBrowser.js';

/**
 * どれくらいの間隔で「一度だけ描かせる」かを決める既定値。
 *
 * viz は未描画フレームが3枚を超えた時点で BeginFrame を打ち切る。溜まる速さはページが damage を
 * 出す速さ次第なので、落ちるまでの時間は予測できない（実測では2分半のことも1時間のこともあった）。
 * 短くすれば復帰は速いがページに resize が飛ぶ回数が増えるため、その折衷。
 */
export const PARADIS_EXACT_VIEW_FRAME_KEEPALIVE_INTERVAL_MS = 5_000;

/** 追跡できるビュー数の上限。バインド上限と同じ考え方の防御。 */
export const PARADIS_EXACT_VIEW_FRAME_KEEPALIVE_MAX_VIEWS = 4096;

/**
 * 「今どのビューに定期的な描画のきっかけが要るか」だけを持つ台帳。
 *
 * Electron には一切触れない純粋な記帳役で、実際にビューを小突くのは所有者（electron-main 側）の
 * 仕事。タイマーもここでは持たない。同じビューが複数ペインに共有されていても実体はひとつなので、
 * 4つ組（windowId / viewId / targetId / viewLease）で正規化して重複を畳む。
 */
export class ParadisExactViewFrameKeepaliveRegistry {

	private readonly views = new Map<string, IParadisExactBrowserViewDescriptor>();

	constructor(private readonly maximumViews: number = PARADIS_EXACT_VIEW_FRAME_KEEPALIVE_MAX_VIEWS) { }

	get size(): number {
		return this.views.size;
	}

	/** 追跡を始める。既知のビューや不正な descriptor は何もしない。 */
	add(descriptorValue: unknown): boolean {
		const descriptor = paradisParseExactBrowserViewDescriptor(descriptorValue);
		if (descriptor === undefined) {
			return false;
		}
		const key = exactViewKey(descriptor);
		if (this.views.has(key)) {
			return false;
		}
		if (this.views.size >= this.maximumViews) {
			return false;
		}
		this.views.set(key, descriptor);
		return true;
	}

	/** 追跡をやめる。未知のビューに対しては何もしない。 */
	remove(descriptorValue: unknown): boolean {
		const descriptor = paradisParseExactBrowserViewDescriptor(descriptorValue);
		if (descriptor === undefined) {
			return false;
		}
		return this.views.delete(exactViewKey(descriptor));
	}

	/**
	 * 現時点の追跡対象。反復中に台帳が変わっても安全なようにコピーを返す
	 * （小突く途中で消えたビューをその場で取り除けるようにするため）。
	 */
	snapshot(): readonly IParadisExactBrowserViewDescriptor[] {
		return [...this.views.values()];
	}

	clear(): void {
		this.views.clear();
	}
}
