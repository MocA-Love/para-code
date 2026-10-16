/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code で実行したコマンドの記録（Q372）。履歴の一覧に時刻・場所・終了コード・回数を出すため、
// シェル統合（OSC 633）が知らせたコマンドの終わりを、スペースの履歴フォルダの隣
// （`<履歴フォルダ>/commands.jsonl`）に 1 行 1 件の JSON で書く。シェルの履歴ファイルには
// 時刻しか無い（zsh の EXTENDED_HISTORY のときだけ）ので、別に持つ。ここはその形と上限の純関数。

/** 記録 1 件。 */
export interface IParadisCommandRecord {
	readonly command: string;
	/** 実行した場所（シェルから見たパス）。シェル統合が知らせなければ undefined。 */
	readonly cwd: string | undefined;
	/** 終了コード。分からなければ undefined。 */
	readonly exitCode: number | undefined;
	/** 実行を始めた時刻（エポックからのミリ秒）。 */
	readonly timestamp: number;
	/** かかった時間（ミリ秒）。 */
	readonly duration: number | undefined;
}

/** 記録を書くファイルの名前（スペースの履歴フォルダの中）。 */
export const PARADIS_COMMAND_RECORDS_FILE = 'commands.jsonl';

/** 1 つのファイルに残す記録の数。 */
export const PARADIS_COMMAND_RECORDS_MAX = 2_000;

/** この数を超えたら、古いものを間引いて {@link PARADIS_COMMAND_RECORDS_MAX} 件に縮める。 */
export const PARADIS_COMMAND_RECORDS_COMPACT_AT = 2_500;

/** 記録するコマンドの最大の長さ（文字数）。長い貼り付けで記録が膨らまないようにする。 */
export const PARADIS_COMMAND_RECORD_MAX_LENGTH = 4_096;

/**
 * このコマンドを記録するか。空のもの、長すぎるもの、空白で始まるもの（zsh の
 * HIST_IGNORE_SPACE・bash の HISTCONTROL=ignorespace と同じく「履歴に残さない」印）は記録しない。
 */
export function paradisShouldRecordCommand(command: string): boolean {
	return command.trim().length > 0
		&& command.length <= PARADIS_COMMAND_RECORD_MAX_LENGTH
		&& !/^\s/.test(command);
}

/** 記録 1 件を 1 行にする。 */
export function paradisSerializeCommandRecord(record: IParadisCommandRecord): string {
	const line: { c: string; t: number; d?: string; e?: number; u?: number } = { c: record.command, t: record.timestamp };
	if (record.cwd !== undefined) {
		line.d = record.cwd;
	}
	if (record.exitCode !== undefined) {
		line.e = record.exitCode;
	}
	if (record.duration !== undefined) {
		line.u = Math.round(record.duration);
	}
	return JSON.stringify(line);
}

/** ファイルの中身を記録の並び（書いた順）にする。壊れた行・形の違う行は捨てる。 */
export function paradisParseCommandRecords(content: string): IParadisCommandRecord[] {
	const records: IParadisCommandRecord[] = [];
	for (const line of content.split('\n')) {
		if (line.length === 0) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed !== 'object' || parsed === null) {
			continue;
		}
		const value = parsed as { c?: unknown; t?: unknown; d?: unknown; e?: unknown; u?: unknown };
		if (typeof value.c !== 'string' || value.c.length === 0 || typeof value.t !== 'number' || !Number.isFinite(value.t)) {
			continue;
		}
		records.push({
			command: value.c,
			timestamp: value.t,
			cwd: typeof value.d === 'string' && value.d.length > 0 ? value.d : undefined,
			exitCode: typeof value.e === 'number' && Number.isInteger(value.e) ? value.e : undefined,
			duration: typeof value.u === 'number' && Number.isFinite(value.u) && value.u >= 0 ? value.u : undefined,
		});
	}
	return records;
}

/**
 * 書き足した後の記録の並び。{@link PARADIS_COMMAND_RECORDS_COMPACT_AT} 件を超えたら、新しい
 * {@link PARADIS_COMMAND_RECORDS_MAX} 件だけを残す（毎回縮めると書き直しが増えるので、余裕を持たせる）。
 */
export function paradisAppendCommandRecords(existing: readonly IParadisCommandRecord[], added: readonly IParadisCommandRecord[]): readonly IParadisCommandRecord[] {
	const all = existing.concat(added);
	return all.length > PARADIS_COMMAND_RECORDS_COMPACT_AT ? all.slice(all.length - PARADIS_COMMAND_RECORDS_MAX) : all;
}
