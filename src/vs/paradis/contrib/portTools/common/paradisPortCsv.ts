/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポートの転送の CSV の書き出しと取り込み（設計 B、q.html の Q590-3 案 1）。ここは文字列と台帳だけを扱う純粋な部分で、
// ファイルの読み書き・確認のダイアログ・転送は paradisPortPanelActions.contribution.ts が行う。
//
// - 形式: UTF-8（書き出しは BOM 付き。Excel で文字化けしない）、区切りはカンマ、1 行目は見出し、改行は CRLF
// - 取り込みで使う列: remote_host（空なら localhost。localhost・127.0.0.1 だけ）・remote_port（必須）・local_port（空なら remote_port）・
//   label・protocol（http / https、空なら http）。書き出しの source・local_address・listening・process は読み飛ばすので、
//   書き出したファイルをそのまま取り込める
// - 行ごとの判定: 済み・番号が違う・追加・手元で使用中・形式の誤り・重複（先の行を使う）

import { isLocalhost } from '../../../../platform/tunnel/common/tunnel.js';
import { Tunnel, TunnelSource } from '../../../../workbench/services/remote/common/tunnelModel.js';
import { PARADIS_PORT_TOOLS_LABEL_MAX_LENGTH, paradisIsValidPort } from './paradisPortTools.js';

/** 書き出す列。先頭の 5 列が取り込みで使う列。 */
export const PARADIS_PORT_CSV_COLUMNS: readonly string[] = ['remote_host', 'remote_port', 'local_port', 'label', 'protocol', 'source', 'local_address', 'listening', 'process'];
/** 失敗した行の CSV に足す列。 */
export const PARADIS_PORT_CSV_REASON_COLUMN = 'reason';
/** 取り込む行の上限（大きすぎるファイルで画面と転送が詰まらないように）。 */
export const PARADIS_PORT_CSV_MAX_ROWS = 1_000;

const BOM = '﻿';

/** 1 つの値を CSV のセルにする（カンマ・引用符・改行を含むものだけ囲む。先頭が = + - @ の値は表計算の式にならないよう ' を付ける）。 */
function cell(value: string): string {
	const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** 行の並びを CSV の文字列にする（BOM 付き、CRLF）。 */
export function paradisPortCsvSerialize(header: readonly string[], rows: readonly (readonly string[])[]): string {
	return BOM + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

function sourceName(source: TunnelSource): string {
	switch (source) {
		case TunnelSource.Auto: return 'auto';
		case TunnelSource.Extension: return 'extension';
		default: return 'user';
	}
}

/** 転送の台帳を書き出しの行にする。`detectionKnown` が偽なら listening は空にする。 */
export function paradisPortCsvExportRows(forwarded: readonly Tunnel[], detectionKnown: boolean): string[][] {
	return [...forwarded].sort((a, b) => a.remotePort - b.remotePort).map(tunnel => [
		tunnel.remoteHost,
		String(tunnel.remotePort),
		tunnel.localPort !== undefined ? String(tunnel.localPort) : '',
		tunnel.name ?? '',
		tunnel.protocol,
		sourceName(tunnel.source.source),
		tunnel.localAddress,
		detectionKnown ? String(tunnel.hasRunningProcess === true) : '',
		tunnel.runningProcess ?? '',
	]);
}

/** CSV の 1 行。`line` はその行が始まるファイルの行番号（1 から）。 */
export interface IParadisCsvLine {
	readonly line: number;
	readonly cells: string[];
}

/** CSV の文字列を行とセルに分ける（RFC 4180。引用符の中のカンマ・改行・二重の引用符を扱う）。空の行は捨てる。 */
export function paradisParseCsv(text: string): IParadisCsvLine[] {
	const source = text.startsWith(BOM) ? text.slice(1) : text;
	const rows: IParadisCsvLine[] = [];
	let row: string[] = [];
	let value = '';
	let quoted = false;
	let physicalLine = 1;
	let rowLine = 1;
	const endRow = () => {
		row.push(value);
		if (row.some(item => item.trim().length > 0)) {
			rows.push({ line: rowLine, cells: row });
		}
		row = [];
		value = '';
	};
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === '\n' || (char === '\r' && source[i + 1] !== '\n')) {
			physicalLine++;
		}
		if (quoted) {
			if (char === '"') {
				if (source[i + 1] === '"') {
					value += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				value += char;
			}
			continue;
		}
		if (char === '"' && value.length === 0) {
			quoted = true;
		} else if (char === ',') {
			row.push(value);
			value = '';
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && source[i + 1] === '\n') {
				i++;
				physicalLine++;
			}
			endRow();
			rowLine = physicalLine;
		} else {
			value += char;
		}
	}
	if (value.length > 0 || row.length > 0) {
		endRow();
	}
	return rows;
}

export type ParadisPortCsvRowError = 'remotePortInvalid' | 'localPortInvalid' | 'remoteHostNotLocal' | 'protocolInvalid' | 'labelTooLong';

/** CSV の 1 行（見出しの次の行から。`line` はファイルの行番号で、見出しが 1）。 */
export type ParadisPortCsvRow =
	| { readonly line: number; readonly cells: readonly string[]; readonly kind: 'entry'; readonly remotePort: number; readonly localPort: number; readonly label?: string; readonly protocol?: 'http' | 'https' }
	| { readonly line: number; readonly cells: readonly string[]; readonly kind: 'error'; readonly error: ParadisPortCsvRowError; readonly remoteText: string; readonly localText: string };

export type ParadisPortCsvReadResult =
	| { readonly ok: true; readonly header: readonly string[]; readonly rows: readonly ParadisPortCsvRow[]; readonly truncated: boolean }
	| { readonly ok: false; readonly error: 'empty' | 'noRemotePortColumn' };

/** CSV を読み、行ごとに形式を確かめる。 */
export function paradisPortCsvRead(text: string): ParadisPortCsvReadResult {
	const table = paradisParseCsv(text);
	if (table.length === 0) {
		return { ok: false, error: 'empty' };
	}
	const header = table[0].cells.map(name => name.trim());
	const index = (name: string) => header.findIndex(item => item.toLowerCase() === name);
	const remotePortAt = index('remote_port');
	if (remotePortAt < 0) {
		return { ok: false, error: 'noRemotePortColumn' };
	}
	const remoteHostAt = index('remote_host');
	const localPortAt = index('local_port');
	const labelAt = index('label');
	const protocolAt = index('protocol');
	const body = table.slice(1, 1 + PARADIS_PORT_CSV_MAX_ROWS);
	const rows = body.map(({ line, cells }): ParadisPortCsvRow => {
		const read = (at: number) => at >= 0 ? (cells[at] ?? '').trim() : '';
		const remoteText = read(remotePortAt);
		const localText = read(localPortAt);
		const fail = (error: ParadisPortCsvRowError): ParadisPortCsvRow => ({ line, cells, kind: 'error', error, remoteText, localText });
		const remotePort = /^\d+$/.test(remoteText) ? Number(remoteText) : NaN;
		if (!paradisIsValidPort(remotePort)) {
			return fail('remotePortInvalid');
		}
		const localPort = localText === '' ? remotePort : /^\d+$/.test(localText) ? Number(localText) : NaN;
		if (!paradisIsValidPort(localPort)) {
			return fail('localPortInvalid');
		}
		const host = read(remoteHostAt);
		if (host !== '' && !isLocalhost(host.toLowerCase())) {
			return fail('remoteHostNotLocal');
		}
		const protocol = read(protocolAt).toLowerCase();
		if (protocol !== '' && protocol !== 'http' && protocol !== 'https') {
			return fail('protocolInvalid');
		}
		const label = read(labelAt);
		if (label.length > PARADIS_PORT_TOOLS_LABEL_MAX_LENGTH) {
			return fail('labelTooLong');
		}
		return {
			line,
			cells,
			kind: 'entry',
			remotePort,
			localPort,
			...(label ? { label } : {}),
			...(protocol === 'http' || protocol === 'https' ? { protocol } : {}),
		};
	});
	return { ok: true, header, rows, truncated: table.length - 1 > PARADIS_PORT_CSV_MAX_ROWS };
}

/** 取り込む前の、行ごとの判定。 */
export type ParadisPortCsvVerdict =
	| { readonly kind: 'done' }
	| { readonly kind: 'mismatch'; readonly currentLocalPort: number | undefined; readonly localInUse: boolean }
	| { readonly kind: 'add' }
	| { readonly kind: 'localInUse' }
	| { readonly kind: 'error'; readonly error: ParadisPortCsvRowError }
	| { readonly kind: 'duplicate'; readonly firstLine: number };

export interface IParadisPortCsvPlanRow {
	readonly row: ParadisPortCsvRow;
	readonly verdict: ParadisPortCsvVerdict;
}

/** 手元で使用中かを確かめる番号（追加と、番号を揃える行の手元の番号）。 */
export function paradisPortCsvLocalPortsToCheck(rows: readonly ParadisPortCsvRow[], forwarded: readonly Tunnel[]): number[] {
	const ports = new Set<number>();
	for (const row of rows) {
		if (row.kind !== 'entry') {
			continue;
		}
		const existing = findForward(forwarded, row.remotePort);
		if (!existing || existing.localPort !== row.localPort) {
			ports.add(row.localPort);
		}
	}
	return [...ports];
}

function findForward(forwarded: readonly Tunnel[], remotePort: number): Tunnel | undefined {
	return forwarded.find(tunnel => tunnel.remotePort === remotePort && isLocalhost(tunnel.remoteHost));
}

/**
 * 行ごとの判定を決める。同じリモートのポートが 2 行あれば先の行を使う。手元の番号は、使用中のもの（`localInUse`）と、
 * 先の行が追加で使うものを「手元で使用中」にする（黙って別の番号にしない）。
 */
export function paradisPortCsvPlan(rows: readonly ParadisPortCsvRow[], forwarded: readonly Tunnel[], localInUse: ReadonlySet<number>): IParadisPortCsvPlanRow[] {
	const firstLineByRemote = new Map<number, number>();
	const claimed = new Set<number>();
	return rows.map(row => {
		if (row.kind === 'error') {
			return { row, verdict: { kind: 'error', error: row.error } };
		}
		const first = firstLineByRemote.get(row.remotePort);
		if (first !== undefined) {
			return { row, verdict: { kind: 'duplicate', firstLine: first } };
		}
		firstLineByRemote.set(row.remotePort, row.line);
		const existing = findForward(forwarded, row.remotePort);
		if (existing) {
			if (existing.localPort === row.localPort) {
				return { row, verdict: { kind: 'done' } };
			}
			const blocked = localInUse.has(row.localPort) || claimed.has(row.localPort);
			if (!blocked) {
				claimed.add(row.localPort);
			}
			return { row, verdict: { kind: 'mismatch', currentLocalPort: existing.localPort, localInUse: blocked } };
		}
		if (localInUse.has(row.localPort) || claimed.has(row.localPort)) {
			return { row, verdict: { kind: 'localInUse' } };
		}
		claimed.add(row.localPort);
		return { row, verdict: { kind: 'add' } };
	});
}
