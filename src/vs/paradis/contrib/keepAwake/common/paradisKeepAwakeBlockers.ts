/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スリープ防止の blocker（Electron の powerSaveBlocker）を、掛けたウィンドウに紐付けて持つ台帳。
//
// upstream の `INativeHostService.startPowerSaveBlocker` は id を返すだけで、どのウィンドウが掛けたかを
// 覚えない。そのためウィンドウの renderer が落ちた・再読み込みした・stop が届く前に閉じたときに、
// その blocker は誰にも止められずアプリの終了まで残る（macOS ではウィンドウを全部閉じてもアプリは生きて
// いるので、PC が眠らなくなる）。main はウィンドウの読み込み直しと閉じるのを知っているので、ここで
// ウィンドウごとに id を持ち、そのときに止める（electron-main/paradisKeepAwakeMain.ts が配線する）。

/** 掛ける blocker の種類（Electron の powerSaveBlocker と同じ語）。 */
export type ParadisPowerSaveBlockerType = 'prevent-app-suspension' | 'prevent-display-sleep';

/** main が開けるチャネル。 */
export const PARADIS_KEEP_AWAKE_CHANNEL = 'paradisKeepAwake';

/** renderer から見たチャネルの形（ProxyChannel.toService で使う）。 */
export interface IParadisKeepAwakeBlockerService {
	/** blocker を掛け、その id を返す。掛けたウィンドウに紐付く。 */
	start(type: ParadisPowerSaveBlockerType): Promise<number>;
	/** 自分のウィンドウが掛けた blocker を止める。止めたら true。 */
	stop(id: number): Promise<boolean>;
}

/** 実際に blocker を掛け外しするもの（Electron の powerSaveBlocker。テストで差し替える）。 */
export interface IParadisPowerSaveBlocker {
	start(type: ParadisPowerSaveBlockerType): number;
	stop(id: number): boolean;
}

export function paradisIsPowerSaveBlockerType(value: unknown): value is ParadisPowerSaveBlockerType {
	return value === 'prevent-app-suspension' || value === 'prevent-display-sleep';
}

/** 持ち主（IPC の ctx。`window:<id>`）ごとの blocker の台帳。 */
export class ParadisKeepAwakeBlockerRegistry {

	private readonly idsByOwner = new Map<string, Set<number>>();

	constructor(private readonly blocker: IParadisPowerSaveBlocker) { }

	start(owner: string, type: ParadisPowerSaveBlockerType): number {
		const id = this.blocker.start(type);
		let ids = this.idsByOwner.get(owner);
		if (!ids) {
			ids = new Set();
			this.idsByOwner.set(owner, ids);
		}
		ids.add(id);
		return id;
	}

	/** 持ち主が掛けたものだけを止める（別のウィンドウの blocker は止めない）。 */
	stop(owner: string, id: number): boolean {
		const ids = this.idsByOwner.get(owner);
		if (!ids?.has(id)) {
			return false;
		}
		ids.delete(id);
		if (ids.size === 0) {
			this.idsByOwner.delete(owner);
		}
		return this.blocker.stop(id);
	}

	/** 持ち主（読み込み直した・閉じたウィンドウ）が掛けていたものを全部止める。止めた id を返す。 */
	release(owner: string): number[] {
		const ids = this.idsByOwner.get(owner);
		if (!ids) {
			return [];
		}
		this.idsByOwner.delete(owner);
		for (const id of ids) {
			this.blocker.stop(id);
		}
		return [...ids];
	}

	releaseAll(): void {
		for (const owner of [...this.idsByOwner.keys()]) {
			this.release(owner);
		}
	}
}
