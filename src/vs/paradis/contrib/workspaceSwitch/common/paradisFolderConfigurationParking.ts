/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { isParadisManagedWorkspaceWindow } from './paradisWorkspaceSwitch.js';

/** 待避できるフォルダ設定。upstream の `FolderConfiguration` が満たす最小の形。 */
export interface IParadisParkableFolderConfiguration extends IDisposable {
	readonly onDidChange: Event<void>;
}

let enabledOverrideForTest: boolean | undefined;

/**
 * テスト専用。upstream の設定サービスのテストから待避を有効・無効にする（`undefined` で戻す）。
 * 本番の判定 (`isParadisManagedWorkspaceWindow`) は一度立てると下ろせないので、テストで汚さないため。
 */
export function paradisOverrideFolderConfigurationParkingForTest(enabled: boolean | undefined): void {
	enabledOverrideForTest = enabled;
}

function isParkingEnabled(): boolean {
	return enabledOverrideForTest ?? isParadisManagedWorkspaceWindow();
}

interface IParkedFolderConfiguration<T> {
	readonly value: T;
	/** 待避した時点のワークベンチの状態。設定の読み分け (`FOLDER_SCOPES` か否か) がこれで決まる。 */
	readonly workbenchState: number;
	/** 待避中に `.vscode/` の中身が変わったか。変わっていれば使い回さない。 */
	stale: boolean;
	readonly listener: IDisposable;
}

/**
 * スペースの切り替えで外したフォルダの設定 (`.vscode/{settings,tasks,launch,mcp}.json` の読み込み
 * 結果と監視) を、直近の数件だけ捨てずに残しておく台帳。upstream の `WorkspaceService` は
 * フォルダを外すたびに `FolderConfiguration` を破棄し、戻すたびに 4 ファイルを読み直す。
 * 行き来するスペースではこれが毎回の切り替えに乗る (遅いディスクで目立つ)。
 *
 * **設定の取り違えを起こさないための決まり**:
 * - 待避中も監視は生かしておき、変化を受けたら `stale` にする。戻すときに `stale` なら使い回さず
 *   破棄して、upstream の通常の読み込みに任せる (待避中の外部の変更を確実に拾う)。
 *   upstream 側の変更通知 (`onWorkspaceFolderConfigurationChanged`) は、待避中のフォルダには
 *   効かないよう upstream 側の PARA-PATCH で止めている (止めないと、外したフォルダの設定が
 *   今のワークスペースへ足し戻される)。
 * - 待避した時点とワークベンチの状態 (単一フォルダ / マルチルート) が違えば使い回さない。
 *   信頼の状態と設定の登録の変化は、戻すときに upstream の `updateWorkspaceTrust` で読み分け
 *   直してもらう (ファイルは読まない)。
 * - Para Code のスペース切り替えを使っているウィンドウだけで待避する。それ以外のウィンドウは
 *   upstream と同じく即座に破棄する。
 *
 * キーはフォルダの URI。同じフォルダは同じ `.vscode/` を読むので、URI が同じなら中身も同じになる。
 */
export class ParadisFolderConfigurationParking<T extends IParadisParkableFolderConfiguration> implements IDisposable {

	/** 残す件数の既定。往復するスペースの数としては足り、監視の数は増やしすぎない。 */
	static readonly DEFAULT_CAPACITY = 4;

	// `ResourceMap` は追加順に並ぶので、先頭がいちばん古い。
	private readonly entries = new ResourceMap<IParkedFolderConfiguration<T>>();

	constructor(
		private readonly capacity: number = ParadisFolderConfigurationParking.DEFAULT_CAPACITY,
		private readonly isEnabled: () => boolean = isParkingEnabled,
	) { }

	/** 外したフォルダの設定を預かる。預からない場合は破棄する (所有権は常にこちらへ移る)。 */
	park(uri: URI, value: T | undefined, workbenchState: number): void {
		if (value === undefined) {
			return;
		}
		if (this.capacity <= 0 || !this.isEnabled()) {
			value.dispose();
			return;
		}
		this.evict(uri);
		const entry: IParkedFolderConfiguration<T> = {
			value,
			workbenchState,
			stale: false,
			listener: value.onDidChange(() => { entry.stale = true; }),
		};
		this.entries.set(uri, entry);
		while (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next();
			if (oldest.done) {
				break;
			}
			this.evict(oldest.value);
		}
	}

	/**
	 * 戻ってきたフォルダの設定を返す。使い回せない (無い・変わった・状態が違う) ときは
	 * `undefined` を返し、預かっていたものは破棄する。返したものの所有権は呼び出し側へ移る。
	 */
	take(uri: URI, workbenchState: number): T | undefined {
		const entry = this.entries.get(uri);
		if (entry === undefined) {
			return undefined;
		}
		this.entries.delete(uri);
		entry.listener.dispose();
		if (entry.stale || entry.workbenchState !== workbenchState) {
			entry.value.dispose();
			return undefined;
		}
		return entry.value;
	}

	has(uri: URI): boolean {
		return this.entries.has(uri);
	}

	get size(): number {
		return this.entries.size;
	}

	clear(): void {
		for (const uri of [...this.entries.keys()]) {
			this.evict(uri);
		}
	}

	dispose(): void {
		this.clear();
	}

	private evict(uri: URI): void {
		const entry = this.entries.get(uri);
		if (entry === undefined) {
			return;
		}
		this.entries.delete(uri);
		entry.listener.dispose();
		entry.value.dispose();
	}
}
