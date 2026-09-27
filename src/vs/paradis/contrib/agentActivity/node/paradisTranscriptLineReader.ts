/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話ログ（JSONL）を指定のバイト位置から1行ずつ読む。worker の中で使う。
//
// 会話ログは追記だけで伸びていくので、全文索引は「前回どこまで読んだか」をバイト位置で覚えて続きから
// 読む。書きかけの最終行（改行で終わっていない行）は読まずに残し、次回に回す。

import { constants as fsConstants, promises as fs } from 'fs';

const CHUNK_BYTES = 256 * 1024;
/** これより長い1行は読み飛ばす（画像を貼った行など。索引にも集計にも使わない）。 */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

export interface IParadisLineReadResult {
	/** 最後まで読み切った完全な行の、直後のバイト位置。次回はここから読む。 */
	readonly endOffset: number;
	/** 開いたファイルの識別子（途中で差し替えられていないかの確認に使う）。 */
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
}

/**
 * `start` から改行で終わる行を順に `onLine` へ渡す。`onLine` が false を返したら止める。
 * シンボリックリンクは開かない（エージェントのホームの外を読まされないため）。
 */
export async function paradisReadTranscriptLines(path: string, start: number, onLine: (line: string, endOffset: number) => boolean | void | Promise<boolean | void>): Promise<IParadisLineReadResult> {
	const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) {
			throw new Error('Not a regular file.');
		}
		let position = Math.max(0, Math.min(start, stat.size));
		let lineStart = position;
		let pending: Buffer[] = [];
		let pendingBytes = 0;
		let skipping = false;
		const buffer = Buffer.alloc(CHUNK_BYTES);
		while (position < stat.size) {
			const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, stat.size - position), position);
			if (bytesRead <= 0) {
				break;
			}
			let cursor = 0;
			while (cursor < bytesRead) {
				const newline = buffer.indexOf(0x0a, cursor);
				if (newline === -1 || newline >= bytesRead) {
					const rest = bytesRead - cursor;
					if (!skipping) {
						pending.push(Buffer.from(buffer.subarray(cursor, bytesRead)));
						pendingBytes += rest;
						if (pendingBytes > MAX_LINE_BYTES) {
							pending = [];
							pendingBytes = 0;
							skipping = true;
						}
					}
					cursor = bytesRead;
					break;
				}
				const lineEnd = position + newline + 1;
				if (!skipping) {
					pending.push(buffer.subarray(cursor, newline));
					const line = Buffer.concat(pending).toString('utf8');
					pending = [];
					pendingBytes = 0;
					if (await onLine(line.endsWith('\r') ? line.slice(0, -1) : line, lineEnd) === false) {
						return { endOffset: lineEnd, dev: stat.dev, ino: stat.ino, size: stat.size };
					}
				} else {
					skipping = false;
				}
				lineStart = lineEnd;
				cursor = newline + 1;
			}
			position += bytesRead;
		}
		return { endOffset: lineStart, dev: stat.dev, ino: stat.ino, size: stat.size };
	} finally {
		await handle.close();
	}
}
