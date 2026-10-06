/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先で動く Claude Code のバックグラウンドのシェルの出力を、モバイルへ届けるときの取り決め（agent.shells.v1）。
//
// 出力ファイルは接続先のディスクにあり、shared process には手が届かない。そこで:
//  1. shared process（ParadisMobileAgentChat）が、そのペインの transcript を写している担当ウィンドウ（写しの台帳の
//     owner。接続先に繋いでいて、その transcript が実在するウィンドウ）へ、イベントで読み取りを頼む
//  2. 担当ウィンドウは、接続先の REH サーバーのチャネル {@link PARADIS_REMOTE_SHELL_OUTPUT_CHANNEL} を呼ぶ。
//     REH は接続先の本人として、realpath・`claude-<uid>` の持ち主・ファイルの持ち主を確かめてから末尾を読む
//     （IFileService では持ち主を確かめられないため、読むのは REH のプロセスに任せる）
//  3. 担当ウィンドウが結果を shared process へ返す
// 読むパスは PC が transcript で覚えたものだけ。モバイルからはシェルの ID しか受け取らない。

/** 接続先の REH サーバーのチャネル。`readTails`（引数 `[items, sessionId, lines]`、結果 `unknown[]`）。 */
export const PARADIS_REMOTE_SHELL_OUTPUT_CHANNEL = 'paradisRemoteShellOutput';

/** 1 回に頼むシェルの数の上限（モバイルの 1 要求の上限と同じ）。 */
export const PARADIS_REMOTE_SHELL_OUTPUT_ITEMS_MAX = 20;

/** 担当ウィンドウの返事を待つ時間。過ぎたら繋いだウィンドウが無いものとして扱う（アプリは 15 秒で諦める）。 */
export const PARADIS_REMOTE_SHELL_OUTPUT_TIMEOUT_MS = 8_000;

/** 1 シェルぶんの頼み（`outputFile` は transcript に書かれた接続先のパス）。 */
export interface IParadisRemoteShellOutputItemRequest {
	readonly id: string;
	readonly outputFile: string;
}

/** shared process → 担当ウィンドウの頼み（ウィンドウは `ownerId` が自分のものだけに答える）。 */
export interface IParadisRemoteShellOutputRequest {
	readonly requestId: string;
	readonly ownerId: string;
	readonly sessionId: string;
	readonly lines: number;
	readonly items: readonly IParadisRemoteShellOutputItemRequest[];
}

/** REH・担当ウィンドウが返す 1 シェルぶん。形は shared process が {@link paradisDecodeRemoteShellOutputItems} で確かめる。 */
export interface IParadisRemoteShellOutputItem {
	readonly id: string;
	readonly lines?: readonly string[];
	readonly truncated?: boolean;
	readonly ended?: { readonly status: 'completed' | 'failed' | 'stopped'; readonly exitCode?: number };
	readonly error?: 'not-found' | 'unavailable';
}

const SHELL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const END_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped']);
/** 1 行の上限（手元の読み取りと同じ 1,000 文字と省略の印）。 */
const LINE_LENGTH = 1_001;
/** 1 シェルあたりの行の上限（手元の読み取りと同じ）。 */
const LINES_MAX = 50;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** 頼みの中身の検査（REH が受け取るときに使う。接続先にとって手元は信じてよい相手だが、形は確かめる）。 */
export function paradisIsValidRemoteShellOutputItems(value: unknown): value is readonly IParadisRemoteShellOutputItemRequest[] {
	return Array.isArray(value) && value.length > 0 && value.length <= PARADIS_REMOTE_SHELL_OUTPUT_ITEMS_MAX && value.every(item => {
		const entry = record(item);
		return entry !== undefined && typeof entry.id === 'string' && SHELL_ID.test(entry.id)
			&& typeof entry.outputFile === 'string' && entry.outputFile.length > 0 && entry.outputFile.length <= 4096;
	});
}

/**
 * 担当ウィンドウ（その先の接続先）が返した結果を、頼んだ ID の分だけ取り出す。接続先は乗っ取られうる相手なので、
 * 形の合わないもの・頼んでいない ID・上限を超える行は捨てる。
 */
export function paradisDecodeRemoteShellOutputItems(value: unknown, requested: readonly string[]): Map<string, IParadisRemoteShellOutputItem> {
	const wanted = new Set(requested);
	const result = new Map<string, IParadisRemoteShellOutputItem>();
	if (!Array.isArray(value)) {
		return result;
	}
	for (const candidate of value.slice(0, PARADIS_REMOTE_SHELL_OUTPUT_ITEMS_MAX)) {
		const item = record(candidate);
		const id = item?.id;
		if (item === undefined || typeof id !== 'string' || !wanted.has(id) || result.has(id)) {
			continue;
		}
		if (item.error === 'not-found' || item.error === 'unavailable') {
			result.set(id, { id, error: item.error });
			continue;
		}
		if (!Array.isArray(item.lines)) {
			continue;
		}
		const lines = item.lines.slice(-LINES_MAX).filter((line): line is string => typeof line === 'string').map(line => line.slice(0, LINE_LENGTH));
		const ended = record(item.ended);
		const status = ended?.status;
		const exitCode = ended?.exitCode;
		result.set(id, {
			id,
			lines,
			truncated: item.truncated === true,
			...(typeof status === 'string' && END_STATUSES.has(status) ? {
				ended: {
					status: status as 'completed' | 'failed' | 'stopped',
					...(typeof exitCode === 'number' && Number.isInteger(exitCode) ? { exitCode } : {}),
				},
			} : {}),
		});
	}
	return result;
}
