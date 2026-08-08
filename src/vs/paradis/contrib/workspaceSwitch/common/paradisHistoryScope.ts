/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { hash } from '../../../../base/common/hash.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceFolder, IWorkspaceFoldersChangeEvent } from '../../../../platform/workspace/common/workspace.js';

/**
 * エディタ履歴をスペース単位に分けるための判定。
 *
 * Para Code のスペース切り替えは単一の `.code-workspace` の folders を入れ替える方式で、
 * workspace の identity は configPath だけで決まる (workspaces.ts の "IDENTIFIERS HAVE TO
 * REMAIN STABLE")。そのため WORKSPACE スコープのストレージは全スペースで共有され、upstream の
 * `HistoryService` が単一キーへ書く履歴に全スペースのファイルが混ざる。Quick Open に別スペースの
 * ファイルが出るのも、履歴の上限 200 件を全スペースで食い合うのも、これが原因。
 *
 * ここではストレージキーの導出と切り替え時の後始末の判定だけを持つ。呼び出し側は
 * `historyService.ts` の PARA-PATCH。
 */

/** 履歴を保持するスペース数の上限。超えた分は最後に使われてから最も古いものを捨てる。 */
export const PARADIS_HISTORY_MAX_SPACES = 24;

/**
 * 現在の folders から履歴の保存先キーを導出する。
 *
 * スペースは常に単一フォルダで運用される。フォルダが 0 個や複数の場合はスペース運用外なので、
 * upstream と同じキーをそのまま使う。
 *
 * 大文字小文字と末尾スラッシュの違いで別バケットにならないよう、所属判定 ({@link paradisIsInSpace})
 * と同じ正規化を通してからハッシュする。
 */
export function paradisHistoryStorageKey(baseKey: string, folders: readonly IWorkspaceFolder[]): string {
	if (folders.length !== 1) {
		return baseKey;
	}

	const normalized = extUriBiasedIgnorePathCase.getComparisonKey(extUriBiasedIgnorePathCase.removeTrailingPathSeparator(folders[0].uri));

	return `${baseKey}.${(hash(normalized) >>> 0).toString(16)}`;
}

/** スペース別キーを最近使った順で保持するメタキー。 */
export function paradisHistorySpacesKey(baseKey: string): string {
	return `${baseKey}.spaces`;
}

/** リソースがそのスペース (folders) に属するか。 */
export function paradisIsInSpace(resource: URI, folders: readonly IWorkspaceFolder[]): boolean {
	return folders.some(folder => extUriBiasedIgnorePathCase.isEqualOrParent(resource, folder.uri));
}

export interface IParadisHistorySwitchPlan {

	/**
	 * 切り替え前のスペースの履歴として保存すべきでないリソースか。
	 *
	 * エディタの入れ替え (`applyWorkingSet`) は folders の更新より先に走るため、folders 変更を
	 * 受け取った時点の履歴には切り替え先のエディタが既に紛れ込んでいる。これを落とさずに書き戻すと、
	 * 元のスペースへ戻ったときに別スペースのファイルが履歴の先頭に並ぶ。
	 *
	 * 切り替え元にも属するリソースは残す (スペースが入れ子になっている場合の誤削除を避けるため)。
	 *
	 * 既知の制限: 切り替え先のスペースがフォルダ外のファイル (ユーザー設定など) を開いていた場合は
	 * 判定できず、切り替え元の履歴に残る。取り切るには切り替えの開始そのものを知る必要がある。
	 */
	isForeign(resource: URI): boolean;
}

/**
 * folders の入れ替えがスペースの切り替え (単一フォルダ → 別の単一フォルダ) なら、
 * 切り替え前の履歴から取り除くべきものの判定を返す。それ以外の遷移では `undefined`。
 */
export function paradisHistorySwitchPlan(event: IWorkspaceFoldersChangeEvent, currentFolders: readonly IWorkspaceFolder[]): IParadisHistorySwitchPlan | undefined {
	if (event.removed.length !== 1 || currentFolders.length !== 1) {
		return undefined;
	}

	const removed = event.removed;

	return {
		isForeign: resource => paradisIsInSpace(resource, currentFolders) && !paradisIsInSpace(resource, removed)
	};
}

/**
 * スペースを分ける前 (upstream と同じ単一キー) の履歴を引き継ぐときの絞り込み。
 * 全スペース分が混ざっているので、そのスペースに属するものだけを採用する。
 */
export function paradisMigratedHistoryEntries<T extends { readonly resource: URI }>(entries: readonly T[], folders: readonly IWorkspaceFolder[]): T[] {
	return entries.filter(entry => paradisIsInSpace(entry.resource, folders));
}

/**
 * 使ったスペースを最近使った順で追跡し、上限を超えた分を返す。
 * 返した `evicted` のキーは呼び出し側がストレージから消す (消さないとスペースを増やすたびに履歴が残り続ける)。
 *
 * 呼び出し側は「これから読むスペース」も必ず通すこと。保存したときだけ通すと、久しぶりに戻る
 * スペースほど末尾に溜まり、戻った瞬間にその履歴を捨ててしまう。
 */
export function paradisTrackHistorySpaces(known: readonly string[], key: string, max = PARADIS_HISTORY_MAX_SPACES): { readonly keys: string[]; readonly evicted: string[] } {
	const keys = [key, ...known.filter(knownKey => knownKey !== key)];
	const evicted = keys.splice(max);

	return { keys, evicted };
}
