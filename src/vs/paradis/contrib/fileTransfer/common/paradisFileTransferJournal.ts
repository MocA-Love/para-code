/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 書いている途中の一時ファイル（`.paratransfer-<実行の印>`）の控え。ウィンドウを閉じた・切れた・落ちたときに
// 残った一時ファイルを、次の起動や再接続のときに片付けるために、APPLICATION の保存領域へ書く。
//
// 複数のウィンドウが同じ控えを読み書きする。別のウィンドウが今まさに書いている一時ファイルを消さないよう、
// 書いているウィンドウは控えの時刻を定期的に更新し（心拍）、片付けるのは「しばらく更新されていない」か
// 「閉じるときに片付けきれなかったと印を付けた（時刻 0）」ものだけにする（どれも純関数）。

import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { paradisIsTransferTempName } from './paradisFileTransferQueueTypes.js';

export const PARADIS_FILE_TRANSFER_JOURNAL_KEY = 'paradis.fileTransfer.tempJournal';
/** 心拍の間隔。 */
export const PARADIS_FILE_TRANSFER_JOURNAL_HEARTBEAT_MS = 60_000;
/** 片付けの候補を選んでから読み直すまで待つ時間（心拍の間隔より長く。スリープ明けの心拍の遅れを待つ）。 */
export const PARADIS_FILE_TRANSFER_JOURNAL_SETTLE_MS = PARADIS_FILE_TRANSFER_JOURNAL_HEARTBEAT_MS + 15_000;
/** これだけ心拍が途絶えた控えは、書いていたウィンドウがもう居ないとみなす。 */
export const PARADIS_FILE_TRANSFER_JOURNAL_STALE_MS = 5 * 60_000;

export interface IParadisTempJournalEntry {
	readonly uri: string;
	/** 最後に心拍があった時刻。0 は「閉じるときに片付けきれなかった」。 */
	readonly at: number;
}

export function paradisParseJournal(raw: string | undefined): IParadisTempJournalEntry[] {
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is IParadisTempJournalEntry => !!entry && typeof entry.uri === 'string' && typeof entry.at === 'number')
			: [];
	} catch {
		return [];
	}
}

/** 自分の控えを足す（同じものがあれば時刻だけ新しくする）。 */
export function paradisJournalAdd(entries: readonly IParadisTempJournalEntry[], uri: string, now: number): IParadisTempJournalEntry[] {
	return [...entries.filter(entry => entry.uri !== uri), { uri, at: now }];
}

export function paradisJournalRemove(entries: readonly IParadisTempJournalEntry[], uri: string): IParadisTempJournalEntry[] {
	return entries.filter(entry => entry.uri !== uri);
}

/** 自分が今書いているものの時刻を `at` にする（心拍は now、閉じるときの片付け残しは 0）。 */
export function paradisJournalStamp(entries: readonly IParadisTempJournalEntry[], own: ReadonlySet<string>, at: number): IParadisTempJournalEntry[] {
	return entries.map(entry => own.has(entry.uri) ? { uri: entry.uri, at } : entry);
}

/**
 * 片付けてよい一時ファイル。自分が書いているものは除き、心拍が途絶えたものか片付け残しの印が付いたもので、
 * 名前が一時名の形をしていて、このウィンドウから触れる場所（手元か、繋がっている接続先）のものだけ。
 */
export function paradisJournalCleanable(entries: readonly IParadisTempJournalEntry[], own: ReadonlySet<string>, now: number, canAccess: (uri: URI) => boolean): URI[] {
	const result: URI[] = [];
	for (const entry of entries) {
		if (own.has(entry.uri) || (entry.at !== 0 && now - entry.at <= PARADIS_FILE_TRANSFER_JOURNAL_STALE_MS)) {
			continue;
		}
		let uri: URI;
		try {
			uri = URI.parse(entry.uri);
		} catch {
			continue;
		}
		if (paradisIsTransferTempName(basename(uri)) && canAccess(uri)) {
			result.push(uri);
		}
	}
	return result;
}
