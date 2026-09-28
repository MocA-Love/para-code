/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 会話の古い発言を、記録ファイル（Claude の transcript / Codex の rollout）を後ろから読んで取り出す（Orca W2-30 の 2 段目）。
 *
 * PC がメモリに持っている発言（ペインごとに 400 件）より前は、ここで読む。tailer と違い監視も状態の更新もしない
 * 読み取りだけの処理で、1 回に読むのは {@link PARADIS_HISTORY_MAX_BYTES} まで。位置はファイルのバイト位置で、
 * モバイルへは不透明な文字列（{@link paradisEncodeHistoryCursor}）として渡す。
 *
 * 位置は「行の頭のバイト位置」と「その行から出た発言のうち先頭何件を含めるか（keep）」の組。1 行から発言が
 * 複数できる（Claude の assistant 行の本文とツール呼び出しなど）ので、ページの境目が行の途中に来ても
 * 取りこぼしも重複もしないようにしてある。
 */

import type * as fs from 'fs/promises';
import type { IParadisAgentChatMessage, ParadisAgentKind } from '../../agentChat/common/paradisAgentChat.js';
import { IRawMessage, newParseSignals, parseClaudeLine, parseClaudeProgress, parseCodexLine, rec } from '../../agentChat/common/paradisAgentTranscriptParser.js';

/** 1 回の読み取りで後ろから読むバイト数の上限。 */
export const PARADIS_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
/** 1 回に返す発言の数の上限。 */
export const PARADIS_HISTORY_PAGE_LIMIT = 100;
/** ファイルから読める発言の数の上限（1 ペインあたり。Q122）。これより前は PC で見てもらう。 */
export const PARADIS_HISTORY_FILE_CAP = 2000;
/** 1 行の上限（tailer の MAX_TRANSCRIPT_LINE_BYTES と同じ）。これより長い行（大きな画像など）は飛ばす。 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** 後ろから読む 1 回ぶん。 */
const CHUNK_BYTES = 64 * 1024;
/** まとめて解釈する行の数（Codex の view_image のように、続く行と組になる行があるため前から解釈する）。 */
const PARSE_BATCH_LINES = 64;

/** ファイルの中の位置。`offset` の行より前の発言と、`offset` の行の先頭 `keep` 件の発言が「それより前」。 */
export interface IParadisHistoryCursor {
	readonly offset: number;
	readonly keep: number;
}

/** 位置をモバイルへ渡す文字列にする。 */
export function paradisEncodeHistoryCursor(cursor: IParadisHistoryCursor): string {
	return `f:${cursor.offset}:${cursor.keep}`;
}

/** モバイルから返ってきた位置を読む。形が違えば undefined。 */
export function paradisDecodeHistoryCursor(value: string): IParadisHistoryCursor | undefined {
	const match = /^f:(?<offset>\d{1,15}):(?<keep>\d{1,4})$/.exec(value);
	if (match?.groups === undefined) {
		return undefined;
	}
	const offset = Number(match.groups.offset);
	const keep = Number(match.groups.keep);
	return Number.isSafeInteger(offset) && Number.isSafeInteger(keep) ? { offset, keep } : undefined;
}

/** 位置より前にまだ何かがありうるか。 */
export function paradisHistoryCursorHasMore(cursor: IParadisHistoryCursor): boolean {
	return cursor.offset > 0 || cursor.keep > 0;
}

/** 1 行を発言にする（tailer と同じ解釈。進み具合の行は飛ばす）。 */
function parseLine(agent: ParadisAgentKind, text: string, signals: ReturnType<typeof newParseSignals>): IRawMessage[] {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return [];
	}
	let obj: Record<string, unknown> | undefined;
	try {
		obj = rec(JSON.parse(trimmed));
	} catch {
		return [];
	}
	if (obj === undefined) {
		return [];
	}
	if (agent === 'claude') {
		if (parseClaudeProgress(obj) !== undefined) {
			return [];
		}
		return parseClaudeLine(obj, signals);
	}
	return parseCodexLine(obj, signals);
}

/**
 * モバイルへ送る形にする。全文・画像の実体は持たない（取り寄せの口は rev で引く tailer のものなので、
 * 古い発言には使えない）。切り詰めた本文は末尾の「…」のまま送り、全文の取り寄せの印は付けない。
 */
function toHistoryMessage(raw: IRawMessage & { readonly truncated?: boolean }, rev: number): IParadisAgentChatMessage {
	const { fullText: _fullText, imageData: _imageData, truncated: _truncated, ...rest } = raw;
	const message: IParadisAgentChatMessage = { ...rest, rev };
	return message;
}

interface ILineWithOffset {
	readonly offset: number;
	readonly text: string;
}

/**
 * `before` より前の行を、新しいものから順に読む。行の上限を超える行（読みながら捨てる）と空行は返さない。
 * 読んだバイト数が `maxBytes` に達したら止まる（その時点で途中の行は返さない）。
 */
async function* readLinesBackward(handle: fs.FileHandle, before: number, maxBytes: number, reader: { position: number }): AsyncGenerator<ILineWithOffset> {
	let position = before;
	let budget = maxBytes;
	// いま組み立て中の行（後ろ側の断片から順に前へ足していく）。
	let pieces: Buffer[] = [];
	let pieceBytes = 0;
	let oversize = false;
	while (position > 0 && budget > 0) {
		const start = Math.max(0, position - Math.min(CHUNK_BYTES, budget));
		const chunk = Buffer.alloc(position - start);
		const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
		if (bytesRead !== chunk.length) {
			return; // 読んでいる間にファイルが縮んだ（読み直しは呼び出し側に任せる）
		}
		budget -= chunk.length;
		let end = chunk.length;
		for (let index = chunk.length - 1; index >= 0; index--) {
			if (chunk[index] !== 0x0a) {
				continue;
			}
			const lineStart = start + index + 1;
			if (!oversize && (end > index + 1 || pieceBytes > 0)) {
				const text = Buffer.concat([chunk.subarray(index + 1, end), ...pieces]).toString('utf8');
				if (text.trim().length > 0) {
					yield { offset: lineStart, text };
				}
			}
			pieces = [];
			pieceBytes = 0;
			oversize = false;
			end = index;
		}
		if (end > 0 && !oversize) {
			pieces.unshift(chunk.subarray(0, end));
			pieceBytes += end;
			if (pieceBytes > MAX_LINE_BYTES) {
				pieces = [];
				pieceBytes = 0;
				oversize = true;
			}
		}
		position = start;
		// 読み終えたいちばん前の位置（行の途中のこともある。発言が 1 つも無いまま上限に達したときだけ、
		// 次はここから読む。そこをまたぐ 1 行は失うが、必ず前へ進む）。
		reader.position = start;
	}
	if (position === 0 && !oversize && pieceBytes > 0) {
		const text = Buffer.concat(pieces).toString('utf8');
		reader.position = 0;
		if (text.trim().length > 0) {
			yield { offset: 0, text };
		}
	}
}

/** {@link paradisReadTranscriptHistory} の結果。 */
export interface IParadisTranscriptHistoryPage {
	/** 古い順。いちばん新しいものの rev が `lastRev` で、古い方へ 1 ずつ小さくなる。 */
	readonly messages: readonly IParadisAgentChatMessage[];
	/** 次に読む位置。ファイルの先頭まで読み終えたら undefined。 */
	readonly next: IParadisHistoryCursor | undefined;
}

/**
 * `cursor` より前の発言を最大 `limit` 件、古い順に返す。`lastRev` は返す発言のうちいちばん新しいものに付ける rev で、
 * それより古いものに 1 ずつ小さい rev を振る。
 */
export async function paradisReadTranscriptHistory(
	handle: fs.FileHandle,
	agent: ParadisAgentKind,
	cursor: IParadisHistoryCursor,
	limit: number,
	lastRev: number,
	maxBytes: number = PARADIS_HISTORY_MAX_BYTES,
): Promise<IParadisTranscriptHistoryPage> {
	// 新しい順に貯める（1 件 = 発言とその行の頭と、行の中での順番）。
	const collected: { readonly raw: IRawMessage; readonly offset: number; readonly indexInLine: number }[] = [];
	// 位置の行そのもの（先頭 keep 件だけを含める）。
	if (cursor.keep > 0) {
		const boundary = await readLineAt(handle, cursor.offset);
		if (boundary !== undefined) {
			const raws = parseLine(agent, boundary, newParseSignals()).slice(0, cursor.keep);
			for (let index = raws.length - 1; index >= 0; index--) {
				collected.push({ raw: raws[index]!, offset: cursor.offset, indexInLine: index });
			}
		}
	}
	const reader = { position: cursor.offset };
	let batch: ILineWithOffset[] = [];
	const flush = () => {
		// batch は新しい順。前から（古い順に）解釈して、続く行と組になる行の関係を保つ。
		const signals = newParseSignals();
		const parsed: { readonly raw: IRawMessage; readonly offset: number; readonly indexInLine: number }[] = [];
		for (let index = batch.length - 1; index >= 0; index--) {
			const line = batch[index]!;
			parseLine(agent, line.text, signals).forEach((raw, indexInLine) => parsed.push({ raw, offset: line.offset, indexInLine }));
		}
		for (let index = parsed.length - 1; index >= 0; index--) {
			collected.push(parsed[index]!);
		}
		batch = [];
	};
	let stoppedEarly = false;
	for await (const line of readLinesBackward(handle, cursor.offset, maxBytes, reader)) {
		batch.push(line);
		if (batch.length >= PARSE_BATCH_LINES) {
			flush();
			if (collected.length >= limit) {
				stoppedEarly = true;
				break;
			}
		}
	}
	if (batch.length > 0) {
		flush();
	}
	const reachedStart = !stoppedEarly && reader.position === 0;
	const page = collected.slice(0, limit);
	const oldest = page.at(-1);
	let next: IParadisHistoryCursor | undefined;
	if (collected.length > limit || (!reachedStart && oldest !== undefined)) {
		// 返さなかった発言か、まだ読んでいない行が残る。いちばん古く返した発言の手前から続ける。
		next = { offset: oldest!.offset, keep: oldest!.indexInLine };
	} else if (!reachedStart) {
		// 上限のバイト数まで読んでも発言が無かった（大きな行が続いた）。読んだところから続ける。
		next = { offset: reader.position, keep: 0 };
	}
	const messages = page.reverse().map((item, index, all) => toHistoryMessage(item.raw, lastRev - (all.length - 1 - index)));
	return { messages, next: next !== undefined && paradisHistoryCursorHasMore(next) ? next : undefined };
}

/** `offset` から始まる 1 行を読む（上限を超える行は undefined）。 */
async function readLineAt(handle: fs.FileHandle, offset: number): Promise<string | undefined> {
	const pieces: Buffer[] = [];
	let position = offset;
	let total = 0;
	while (total <= MAX_LINE_BYTES) {
		const chunk = Buffer.alloc(CHUNK_BYTES);
		const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
		if (bytesRead === 0) {
			break;
		}
		const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
		if (newline >= 0) {
			pieces.push(chunk.subarray(0, newline));
			return Buffer.concat(pieces).toString('utf8');
		}
		pieces.push(chunk.subarray(0, bytesRead));
		total += bytesRead;
		position += bytesRead;
	}
	return total <= MAX_LINE_BYTES && pieces.length > 0 ? Buffer.concat(pieces).toString('utf8') : undefined;
}
