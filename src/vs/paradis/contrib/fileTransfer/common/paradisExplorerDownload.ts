/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エクスプローラーの「ダウンロード...」で複数を選んだときの、まとめてダウンロードの決め方（純関数）。
// upstream は 1 件ごとに保存先を聞くので、SSH の窓で複数を選んだときだけ、保存先のフォルダーを 1 回だけ聞き、
// ファイル転送の待ち行列へまとめて積む。

import { Schemas } from '../../../../base/common/network.js';
import { extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { paradisNumberedName } from './paradisFileTransferListing.js';
import { IParadisTransferSource } from './paradisFileTransferQueueTypes.js';

/** 「名前を変える」で探す番号の上限。 */
const MAX_RENAME_ATTEMPTS = 9999;

/** エクスプローラーで選んだ 1 項目（ExplorerItem のうち使う分）。 */
export interface IParadisExplorerDownloadItem {
	readonly resource: URI;
	readonly name: string;
	readonly isDirectory: boolean;
}

/**
 * まとめてダウンロードにするか。2 件以上で、全部がこのウィンドウの接続先（`vscode-remote://`）のときだけ。
 * 1 件だけ、または手元など別のスキームが混じるときは upstream の動きのままにする。
 */
export function paradisUsesBatchDownload(items: readonly IParadisExplorerDownloadItem[]): boolean {
	return items.length >= 2 && items.every(item => item.resource.scheme === Schemas.vscodeRemote);
}

/**
 * 待ち行列に積む送り元を決める。
 * - 選んだフォルダーの中のものも重ねて選ばれていたら外す（フォルダーごと落とすので二重になる）。同じ項目の重複も外す
 * - 親の違う同じ名前（`a/x.txt` と `b/x.txt`、別のルート）は、同じ保存先へ並べて書かないよう番号つきの名前に変える。
 *   手元（macOS・Windows）は大文字と小文字を区別しないことが多いので、区別せずに比べる
 */
export function paradisPlanBatchDownload(items: readonly IParadisExplorerDownloadItem[]): IParadisTransferSource[] {
	const kept = items.filter((item, index) => !items.some((other, otherIndex) => {
		if (otherIndex === index) {
			return false;
		}
		if (extUri.isEqual(item.resource, other.resource)) {
			return otherIndex < index;
		}
		return extUri.isEqualOrParent(item.resource, other.resource);
	}));
	const taken = new Set<string>();
	return kept.map(item => {
		let name = item.name;
		if (taken.has(name.toLowerCase())) {
			name = paradisFirstFreeName(name, taken);
		}
		taken.add(name.toLowerCase());
		return { resource: item.resource, name, isDirectory: item.isDirectory };
	});
}

function paradisFirstFreeName(name: string, taken: ReadonlySet<string>): string {
	for (let index = 1; index <= MAX_RENAME_ATTEMPTS; index++) {
		const candidate = paradisNumberedName(name, index);
		if (!taken.has(candidate.toLowerCase())) {
			return candidate;
		}
	}
	return paradisNumberedName(name, Date.now());
}

/** 進み具合の通知に出す、まとめた状態。 */
export interface IParadisBatchDownloadProgress {
	/** 終わった（完了・失敗・取り消し）件数。 */
	readonly finished: number;
	readonly total: number;
	/** 0〜100。大きさの分からない項目は、終わるまで 0 として数える。 */
	readonly percent: number;
	readonly failed: number;
	readonly cancelled: number;
	/** 写さずに飛ばした項目（リンク・読めないファイルなど）の合計。 */
	readonly skipped: number;
}

/** {@link paradisSummarizeBatchDownload} が読む項目の状態（待ち行列の 1 行のうち使う分）。 */
export interface IParadisBatchDownloadItemState {
	readonly id: number;
	readonly state: 'waiting' | 'running' | 'done' | 'error' | 'cancelled';
	readonly totalBytes: number | undefined;
	readonly doneBytes: number;
	readonly skipped: number;
}

/**
 * 積んだ項目（`ids`）の進み具合をまとめる。待ち行列から消えた行（利用者が転送の画面で消した）は、終わったものとして数える。
 */
export function paradisSummarizeBatchDownload(ids: readonly number[], items: readonly IParadisBatchDownloadItemState[]): IParadisBatchDownloadProgress {
	const byId = new Map(items.map(item => [item.id, item]));
	let finished = 0;
	let fraction = 0;
	let failed = 0;
	let cancelled = 0;
	let skipped = 0;
	for (const id of ids) {
		const item = byId.get(id);
		if (!item || (item.state !== 'waiting' && item.state !== 'running')) {
			finished++;
			fraction += 1;
		} else if (item.totalBytes) {
			fraction += Math.min(1, item.doneBytes / item.totalBytes);
		}
		if (item?.state === 'error') {
			failed++;
		} else if (item?.state === 'cancelled') {
			cancelled++;
		}
		skipped += item?.skipped ?? 0;
	}
	const total = ids.length;
	return { finished, total, percent: total ? Math.floor(fraction / total * 100) : 100, failed, cancelled, skipped };
}
