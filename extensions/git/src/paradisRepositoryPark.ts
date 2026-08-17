/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isDescendant, pathEquals } from './util';

/**
 * スペース切り替えで「今は見えないが、すぐ戻ってくる」リポジトリの待避所。
 *
 * upstream の `Model.onDidChangeWorkspaceFolders` は、ワークスペースフォルダから外れた
 * リポジトリを即 `dispose()` する。Para Code はスペース切り替えのたびにフォルダを1つ入れ替える
 * ので、A→B→A と往復するだけで毎回リポジトリを作り直していた。作り直しには
 * `git rev-parse --show-toplevel` / `--git-dir` などの **git プロセス起動が6〜12本**と、
 * リポジトリルートへの再帰ファイル監視の再構築が伴う（Windows では git 1本あたり数百ms〜1.7秒の
 * 実測がある。`paradisScmRepoScope.contribution.ts` のコメント参照）。
 *
 * ここでは dispose せずに待避し、戻ってきたら同じインスタンスを使い回す。
 *
 * **待避中のリポジトリは `Model.openRepositories` から外す**のが設計の要。あの配列は
 * `pickRepository`（コマンドパレットのリポジトリ選択）・`git.mergeChanges` コンテキスト・
 * `operationInProgress` コンテキスト・`getRepository` の全てが舐めているので、配列から外して
 * おけば「別スペースのリポジトリが選択候補に出る」「別スペースのマージ状態が今のスペースの UI を
 * 変える」「別スペースの長い操作が今のスペースの git コマンドを無効化する」といった漏れが
 * **個別の絞り込みを書かなくても全部同時に塞がる**。
 *
 * 併せて `Repository.setScopeActive(false)` でファイル監視と自動 fetch も止める。待避中に
 * 裏で `git status` が走り続けては、CPU/RAM の乏しい環境ではむしろ悪化するため。監視を止めている
 * 間の変更は取りこぼすので、復帰時に `status()` を1回だけ流して追いつく（git プロセス1本。
 * 作り直しの6〜12本より遥かに安い）。
 *
 * 待避と復帰では `onDidCloseRepository` / `onDidOpenRepository` を今までどおり発火させる。
 * GitLens 等の外部拡張から見た「切り替えで閉じ、戻ると開く」という観測結果は変えずに、
 * その裏側の git 作業だけを省く。
 */
export interface IParadisParkedRepository {
	/** リポジトリのルート（`Repository.root`）。 */
	readonly root: string;
	/**
	 * symlink を解決したルート（`Repository.rootRealPath`）。
	 *
	 * upstream の `Model.getRepositoryExact` が root 一致に失敗したら realpath で比較し直すのと
	 * 同じ理由で必要。`git rev-parse --show-toplevel` が返すルートと、ワークスペースフォルダの
	 * パスは symlink 越しだと食い違う（macOS の `/tmp` → `/private/tmp` など）。ここで持って
	 * いないと照合が黙って外れ、待避中のまま新しいリポジトリが作られてしまう。
	 */
	readonly rootRealPath?: string;
	/** 待避所から取り出して再びアクティブにする。 */
	unpark(): void;
	/** 本当に破棄する（待避上限を超えた場合と、信頼設定などで無効になった場合）。 */
	dispose(): void;
}

/** テスト用に `LogOutputChannel` 全体ではなく必要な最小面だけを要求する。 */
export interface IParadisParkLogger {
	trace(message: string): void;
}

/**
 * 待避しておくリポジトリの上限。
 *
 * 待避中も `SourceControl` とリソースグループはメモリに残るので、大きなリポジトリでは無視できない。
 * 「直前に見ていたスペースへ戻る」が最も多い操作なので、少数で十分に効く。
 */
const PARK_LIMIT = 4;

/** 挿入順（= 最後に待避した順）を保つ LRU。上限を超えたら最も古いものから本当に破棄する。 */
export class ParadisRepositoryParkingLot {

	private readonly parked = new Map<string, IParadisParkedRepository>();

	constructor(private readonly logger: IParadisParkLogger, private readonly limit: number = PARK_LIMIT) { }

	/** そのルートが待避中か。`root` と `rootRealPath` の双方で照合する。 */
	private findByRoot(root: string): IParadisParkedRepository | undefined {
		for (const entry of this.parked.values()) {
			if (pathEquals(entry.root, root) || (entry.rootRealPath !== undefined && pathEquals(entry.rootRealPath, root))) {
				return entry;
			}
		}
		return undefined;
	}

	/**
	 * リポジトリを待避させる。
	 *
	 * 同じルートが既に待避済みなら、古い方は本当に破棄してから入れ替える（同一ルートの
	 * リポジトリが二重にぶら下がると、復帰時にどちらを返すかが不定になるため）。
	 */
	park(entry: IParadisParkedRepository): void {
		const existing = this.parked.get(entry.root);
		if (existing && existing !== entry) {
			this.parked.delete(entry.root);
			existing.dispose();
		}

		this.parked.set(entry.root, entry);
		this.logger.trace(`[ParadisRepositoryParkingLot][park] Parked repository: ${entry.root} (${this.parked.size}/${this.limit})`);

		while (this.parked.size > this.limit) {
			const oldest = this.parked.keys().next();
			if (oldest.done) {
				break;
			}
			const evicted = this.parked.get(oldest.value)!;
			this.parked.delete(oldest.value);
			this.logger.trace(`[ParadisRepositoryParkingLot][park] Evicted parked repository: ${evicted.root}`);
			evicted.dispose();
		}
	}

	/**
	 * このワークスペースフォルダに関係する待避リポジトリを全て復帰させる。
	 *
	 * upstream の破棄判定（`isDescendant(folder, repositoryRoot)`）と対になるよう、フォルダが
	 * リポジトリの祖先である場合に加えて、リポジトリがフォルダの祖先である場合（リポジトリ内の
	 * サブフォルダだけをスペースとして開いている場合）も復帰させる。
	 *
	 * @returns 復帰させた件数。
	 */
	unparkForFolder(folderPath: string): number {
		const matches: IParadisParkedRepository[] = [];
		for (const entry of this.parked.values()) {
			const roots = entry.rootRealPath !== undefined ? [entry.root, entry.rootRealPath] : [entry.root];
			if (roots.some(root => pathEquals(root, folderPath) || isDescendant(folderPath, root) || isDescendant(root, folderPath))) {
				matches.push(entry);
			}
		}

		for (const entry of matches) {
			this.parked.delete(entry.root);
			this.logger.trace(`[ParadisRepositoryParkingLot][unparkForFolder] Unparked repository: ${entry.root}`);
			entry.unpark();
		}

		return matches.length;
	}

	/**
	 * ルートが完全一致する待避リポジトリだけを復帰させる。
	 *
	 * `Model.openRepository` が「作り直す前に待避所を見る」ために使う。**ここで
	 * `unparkForFolder` の双方向 `isDescendant` を流用してはいけない**。親フォルダのリポジトリを
	 * 扱う分岐より前に別のリポジトリを復帰させてしまう。
	 *
	 * @returns 復帰させたなら true。
	 */
	unparkForRoot(root: string): boolean {
		const entry = this.findByRoot(root);
		if (!entry) {
			return false;
		}

		this.parked.delete(entry.root);
		this.logger.trace(`[ParadisRepositoryParkingLot][unparkForRoot] Unparked repository: ${entry.root}`);
		entry.unpark();
		return true;
	}

	/** 待避所からエントリを取り除く（復帰も破棄もしない）。本当に破棄された側から呼ばれる。 */
	forget(root: string): void {
		this.parked.delete(root);
	}

	/**
	 * 条件に当てはまる待避リポジトリを本当に破棄する。
	 *
	 * `git.enabled` が切られたリポジトリのように「待避中でも保持してはいけない」ものを落とすため。
	 * 設定変更は `.code-workspace` の書き込みでも飛んでくるほど頻度が高いので、`clear()` で
	 * 全部捨てず、該当するものだけを落とす（全部捨てるとスペース切り替えの高速化が丸ごと無効になる）。
	 */
	disposeMatching(predicate: (root: string) => boolean): void {
		const matches = [...this.parked.values()].filter(entry => predicate(entry.root));
		for (const entry of matches) {
			this.parked.delete(entry.root);
			this.logger.trace(`[ParadisRepositoryParkingLot][disposeMatching] Disposed parked repository: ${entry.root}`);
			entry.dispose();
		}
	}

	/**
	 * 待避中のものを全て本当に破棄する。
	 *
	 * 信頼設定や `git.enabled` の変更のように「待避中かどうかに関わらず開いていてはいけない」
	 * 判定が走ったときは、個別に選り分けず全部捨てる。判定が漏れて古いリポジトリが復帰し続けるより、
	 * 次の切り替えで作り直す方が安全なため。
	 */
	clear(): void {
		const entries = [...this.parked.values()];
		this.parked.clear();
		for (const entry of entries) {
			entry.dispose();
		}
	}

	dispose(): void {
		this.clear();
	}
}
