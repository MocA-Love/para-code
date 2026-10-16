/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 履歴の一覧（Q372）に並べる行を作る純関数と、選択の動き。

import { IParadisCommandRecord } from './paradisTerminalCommandRecords.js';

/** 一覧の 1 行。同じコマンドは 1 行にまとめる。 */
export interface IParadisHistoryPanelItem {
	readonly command: string;
	/** Para Code が記録したうち最後の実行（記録の無い古い履歴では undefined）。 */
	readonly last: IParadisCommandRecord | undefined;
	/** 記録した実行の回数（記録の無い古い履歴では 0）。 */
	readonly count: number;
}

/** 一覧に載せる最大の行数。 */
export const PARADIS_HISTORY_PANEL_MAX_ITEMS = 500;

/**
 * 記録と履歴の一覧を、新しい順・重複なしの行に並べる。
 *
 * 記録（実行した時刻が分かるもの）を時刻の新しい順に先に置き、その後ろに、記録の無い履歴を
 * `lists` の順（それぞれ古い順に並んだ配列）に、新しいものから足す。シェルの履歴ファイルは
 * シェルを閉じるまで書かれないことがあるので、今のセッションのコマンドは記録の側で先頭に来る。
 */
export function paradisMergeHistory(records: readonly IParadisCommandRecord[], lists: readonly (readonly string[])[], limit = PARADIS_HISTORY_PANEL_MAX_ITEMS): IParadisHistoryPanelItem[] {
	const byCommand = new Map<string, { last: IParadisCommandRecord; count: number }>();
	for (const record of records) {
		const existing = byCommand.get(record.command);
		if (!existing) {
			byCommand.set(record.command, { last: record, count: 1 });
		} else {
			existing.count++;
			if (record.timestamp >= existing.last.timestamp) {
				existing.last = record;
			}
		}
	}
	const result: IParadisHistoryPanelItem[] = [...byCommand.entries()]
		.sort((a, b) => b[1].last.timestamp - a[1].last.timestamp)
		.map(([command, { last, count }]) => ({ command, last, count }));
	const seen = new Set(byCommand.keys());
	for (const list of lists) {
		for (let i = list.length - 1; i >= 0 && result.length < limit; i--) {
			const command = list[i];
			if (command.trim().length === 0 || seen.has(command)) {
				continue;
			}
			seen.add(command);
			result.push({ command, last: undefined, count: 0 });
		}
	}
	return result.length > limit ? result.slice(0, limit) : result;
}

/**
 * 打った文字で前方一致する行だけを残す（Warp と同じく大文字小文字は区別する）。行頭の空白は
 * 比べない。打った文字そのものと同じ履歴も残す（Enter でそのまま実行できる）。
 */
export function paradisFilterHistory(items: readonly IParadisHistoryPanelItem[], typed: string): IParadisHistoryPanelItem[] {
	const prefix = typed.trimStart();
	if (prefix.length === 0) {
		return [...items];
	}
	return items.filter(item => item.command.startsWith(prefix));
}

/** 選択を動かした結果。`close` は一覧を閉じて打っていた文字に戻す。 */
export type ParadisHistoryPanelMove = { readonly kind: 'select'; readonly index: number } | { readonly kind: 'close' };

/**
 * 選択を動かす。`index` は新しい順の位置（0 が最新）。
 *
 * ↓（older）で古い方へ進み、いちばん古い行で止まる（回り込まない）。↑（newer）で新しい方へ
 * 戻り、最新の行でさらに ↑ を押すと閉じる。
 */
export function paradisMoveHistorySelection(index: number, count: number, direction: 'older' | 'newer'): ParadisHistoryPanelMove {
	if (count === 0) {
		return direction === 'newer' ? { kind: 'close' } : { kind: 'select', index: 0 };
	}
	if (direction === 'older') {
		return { kind: 'select', index: Math.min(index + 1, count - 1) };
	}
	return index <= 0 ? { kind: 'close' } : { kind: 'select', index: Math.min(index - 1, count - 1) };
}

/** 一覧の置き場所と並び。新しいほどプロンプトに近い。 */
export interface IParadisHistoryPanelPlacement {
	readonly place: 'below' | 'above';
	/** 表示する行数。 */
	readonly rows: number;
	/** 上の端に最新を置くか（下に出すとき）。上に出すときは下の端に最新を置く。 */
	readonly newestOnTop: boolean;
}

/**
 * 一覧をプロンプトの下に出すか上に出すかを決める。下に `wantedRows` 行入ればその下、入らなければ
 * 上と下の広い方。どちらの場合も最新がプロンプトに接するように並べる。
 */
export function paradisPlaceHistoryPanel(rowsBelow: number, rowsAbove: number, wantedRows: number, minRows = 3): IParadisHistoryPanelPlacement {
	const wanted = Math.max(1, wantedRows);
	if (rowsBelow >= wanted || rowsBelow >= rowsAbove) {
		return { place: 'below', rows: Math.max(Math.min(wanted, rowsBelow), Math.min(minRows, wanted)), newestOnTop: true };
	}
	return { place: 'above', rows: Math.max(Math.min(wanted, rowsAbove), Math.min(minRows, wanted)), newestOnTop: false };
}

/** cwd を手短に（ホームの下なら `~` で始める）。 */
export function paradisShortenCwd(cwd: string | undefined, home: string | undefined): string | undefined {
	if (cwd === undefined || cwd.length === 0) {
		return undefined;
	}
	if (home && home.length > 1) {
		const normalizedHome = home.replace(/[\\/]+$/, '');
		if (cwd === normalizedHome) {
			return '~';
		}
		if (cwd.startsWith(normalizedHome + '/') || cwd.startsWith(normalizedHome + '\\')) {
			return '~' + cwd.substring(normalizedHome.length);
		}
	}
	return cwd;
}
