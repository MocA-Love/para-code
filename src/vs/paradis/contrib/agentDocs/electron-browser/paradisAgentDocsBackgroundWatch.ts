/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 表示していないスペースに足す、資料（html・md）の見張りの出し入れ。作業中のエージェントがいる間だけ張り、居なくなって
// しばらくしたら外す。どのフォルダを見張るかは ParadisDocBackgroundWatchPlan（common）が決め、ここは張る・外すだけ。

import { Disposable, DisposableMap, IDisposable } from '../../../../base/common/lifecycle.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ParadisDocBackgroundWatchPlan } from '../common/paradisAgentDocs.js';

/** 見張りの出し入れが使う、ウィンドウの部分（テストでは差し替える）。 */
export interface IParadisDocBackgroundWatchHost {
	/** ウィンドウが開いているフォルダ（本体が既に見張っている）。 */
	openedFolders(): readonly URI[];
	/** ペインが属するスペースのフォルダ。分からなければ undefined。 */
	paneFolder(token: string): URI | undefined;
	/** このウィンドウの機械のフォルダか（別の機械のフォルダは見張らない）。 */
	onWindowHost(folder: URI): boolean;
	/** そのフォルダの html・md の見張りを張る。 */
	watch(folder: URI): IDisposable;
}

export class ParadisDocBackgroundWatchers extends Disposable {

	private readonly _plan = new ParadisDocBackgroundWatchPlan();
	private readonly _watchers = this._register(new DisposableMap<string>());

	constructor(private readonly _host: IParadisDocBackgroundWatchHost) {
		super();
	}

	/** いま見張っているフォルダ。 */
	get watched(): string[] {
		return [...this._watchers.keys()];
	}

	/**
	 * 見張りを、作業中のエージェントのいるスペースに合わせる。
	 * @param workingTokens ターンの途中（動作中・許可待ち・質問待ち）のペイン
	 */
	update(workingTokens: readonly string[], now: number): void {
		const opened = this._host.openedFolders();
		const isOpened = (folder: URI) => opened.some(root => isEqualOrParent(folder, root));
		const working = new Set<string>();
		for (const token of workingTokens) {
			const folder = this._host.paneFolder(token);
			if (folder !== undefined && !isOpened(folder) && this._host.onWindowHost(folder)) {
				working.add(folder.toString());
			}
		}
		const wanted = new Set(this._plan.update([...working], now, folder => isOpened(URI.parse(folder))));
		for (const folder of [...this._watchers.keys()]) {
			if (!wanted.has(folder)) {
				this._watchers.deleteAndDispose(folder);
			}
		}
		for (const folder of wanted) {
			if (!this._watchers.has(folder)) {
				this._watchers.set(folder, this._host.watch(URI.parse(folder)));
			}
		}
	}
}
