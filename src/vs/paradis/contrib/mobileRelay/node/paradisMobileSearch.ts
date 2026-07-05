/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルのファイル検索バックエンド (shared process)。VS Code本体の検索と同じ ripgrep
// (@vscode/ripgrep-universal、vs/base/node/ripgrep.ts の rgDiskPath) を使う:
//  - searchFiles: `rg --files` の一覧に対するファイル名 (相対パス) マッチ。.gitignore を尊重
//  - searchText:  `rg --json` によるテキスト全文検索 (スマートケース・リテラル一致)
// どちらも件数・走査量・時間に上限を設け、モバイルの1リクエストで返し切れる量に丸める。

import { spawn } from 'child_process';
import { rgDiskPath } from '../../../../base/node/ripgrep.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export interface IParadisFileSearchResult {
	/** ルート相対パス ('/'区切り)。ランク順。 */
	readonly files: string[];
	readonly truncated: boolean;
}

export interface IParadisTextSearchMatch {
	/** ルート相対パス ('/'区切り)。 */
	readonly path: string;
	/** 1始まりの行番号。 */
	readonly line: number;
	/** マッチ行のテキスト (トリム・長さ制限済み)。 */
	readonly text: string;
}

export interface IParadisTextSearchResult {
	readonly matches: IParadisTextSearchMatch[];
	readonly truncated: boolean;
}

const SEARCH_TIMEOUT_MS = 15_000;
/** searchFiles で走査するファイル一覧の上限 (巨大リポジトリの防波堤)。 */
const FILE_SCAN_LIMIT = 200_000;
const PREVIEW_TEXT_LIMIT = 240;

/** rg の共通引数: .git は常に除外（シンボリックリンクは rg の既定で辿らない）。 */
const COMMON_ARGS = ['--no-config', '-g', '!.git'] as const;

function spawnRg(rgPath: string, args: string[], cwd: string, onLine: (line: string) => boolean | void, logService: ILogService): Promise<void> {
	return new Promise<void>(resolve => {
		const child = spawn(rgPath, args, { cwd });
		let settled = false;
		const finish = () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve();
			}
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch { /* ignore */ }
			finish();
		}, SEARCH_TIMEOUT_MS);

		let remainder = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			const combined = remainder + chunk;
			const lines = combined.split('\n');
			remainder = lines.pop() ?? '';
			for (const line of lines) {
				// onLine が true を返したら打ち切り (上限到達)
				if (onLine(line) === true) {
					try {
						child.kill();
					} catch { /* ignore */ }
					finish();
					return;
				}
			}
		});
		child.on('error', err => {
			logService.warn('[paradisMobileSearch] ripgrep spawn failed', err);
			finish();
		});
		child.on('close', () => {
			if (remainder.length > 0) {
				onLine(remainder);
			}
			finish();
		});
	});
}

/**
 * ファイル名 (相対パス部分一致) 検索。ランク: ファイル名の前方一致 > ファイル名の部分一致 >
 * パスの部分一致、同ランクはパスが短い順 (VS CodeのQuick Openに近い体感を狙う)。
 */
export async function paradisSearchFiles(rootPath: string, query: string, maxResults: number, logService: ILogService): Promise<IParadisFileSearchResult> {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) {
		return { files: [], truncated: false };
	}
	const rgPath = await rgDiskPath();
	interface IRanked { path: string; rank: number }
	const ranked: IRanked[] = [];
	let scanned = 0;
	let scanTruncated = false;

	await spawnRg(rgPath, [...COMMON_ARGS, '--files'], rootPath, line => {
		const path = line.trim();
		if (path.length === 0) {
			return;
		}
		if (++scanned > FILE_SCAN_LIMIT) {
			scanTruncated = true;
			return true;
		}
		const lower = path.toLowerCase();
		const slash = lower.lastIndexOf('/');
		const base = slash >= 0 ? lower.slice(slash + 1) : lower;
		let rank: number;
		if (base.startsWith(needle)) {
			rank = 0;
		} else if (base.includes(needle)) {
			rank = 1;
		} else if (lower.includes(needle)) {
			rank = 2;
		} else {
			return;
		}
		ranked.push({ path, rank });
		return;
	}, logService);

	ranked.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
	const files = ranked.slice(0, maxResults).map(r => r.path);
	return { files, truncated: scanTruncated || ranked.length > files.length };
}

/**
 * テキスト全文検索 (リテラル一致・スマートケース)。`rg --json` のmatchイベントをパースする
 * (path:line:text の自前分割はパスにコロンを含むケースで壊れるため使わない)。
 */
export async function paradisSearchText(rootPath: string, query: string, maxResults: number, logService: ILogService): Promise<IParadisTextSearchResult> {
	if (query.trim().length === 0) {
		return { matches: [], truncated: false };
	}
	const rgPath = await rgDiskPath();
	const matches: IParadisTextSearchMatch[] = [];
	let truncated = false;

	const args = [
		...COMMON_ARGS,
		'--json',
		'--smart-case',
		'--fixed-strings',
		'--max-filesize', '1M',
		'--max-columns', String(PREVIEW_TEXT_LIMIT * 4),
		'--max-count', '20', // 1ファイルあたりの上限 (単一ファイルで結果が埋まるのを防ぐ)
		'-e', query,
		'--', '.',
	];

	await spawnRg(rgPath, args, rootPath, line => {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		const record = event !== null && typeof event === 'object' ? event as Record<string, unknown> : undefined;
		if (!record || record['type'] !== 'match') {
			return;
		}
		const data = record['data'] as Record<string, unknown> | undefined;
		const pathText = (data?.['path'] as Record<string, unknown> | undefined)?.['text'];
		const lineNumber = data?.['line_number'];
		const linesText = (data?.['lines'] as Record<string, unknown> | undefined)?.['text'];
		if (typeof pathText !== 'string' || typeof lineNumber !== 'number' || typeof linesText !== 'string') {
			return;
		}
		// rg は './' 始まりで返すことがあるため正規化する
		const path = pathText.startsWith('./') ? pathText.slice(2) : pathText;
		let text = linesText.replace(/\r?\n$/, '').trim();
		if (text.length > PREVIEW_TEXT_LIMIT) {
			// allow-any-unicode-next-line
			text = `${text.slice(0, PREVIEW_TEXT_LIMIT)}…`;
		}
		matches.push({ path, line: lineNumber, text });
		if (matches.length >= maxResults) {
			truncated = true;
			return true;
		}
		return;
	}, logService);

	return { matches, truncated };
}
