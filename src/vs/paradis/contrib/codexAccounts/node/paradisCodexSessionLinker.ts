/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT): src/main/codex/codex-session-backfill.ts

// Codex の会話ログ（`<ホーム>/sessions/YYYY/MM/DD/rollout-*.jsonl`）を、アカウント用ホームどうしで
// ハードリンクし合う。どのアカウントに切り替えても、`codex resume` で過去の会話を開けるようにするため。
//
// 決まりごと（壊さないための約束）:
//  - 既にあるファイルは決して上書きしない（`link` は既存なら EEXIST で失敗するので、それを「済み」とみなす）
//  - 何も消さない・動かさない
//  - 実ファイルだけを元にする（シンボリックリンクは辿らない）
//  - 別ボリュームのホームへはリンクできないので飛ばす（コピーはしない。書き足され続けるファイルの
//    写しは古くなるだけなので）
//
// ハードリンクなので、Codex が同じファイルへ書き足した内容はどのホームから見ても同じになる。

import * as fs from 'fs';
import { dirname, join } from '../../../../base/common/path.js';
import { IParadisCodexSessionLinkSummary } from '../common/paradisCodexAccounts.js';

const YEAR_PATTERN = /^\d{4}$/;
const MONTH_OR_DAY_PATTERN = /^\d{2}$/;
const ROLLOUT_PATTERN = /^rollout-[^/\\]+\.jsonl$/;

export interface IParadisCodexSessionLinkOptions {
	/** true を返したら途中で止める（アプリ終了時など）。 */
	readonly shouldStop?: () => boolean;
}

interface IMutableSummary {
	linked: number;
	skippedExisting: number;
	skippedUnsupported: number;
	failed: number;
}

async function readDirectoryNames(directory: string, pattern: RegExp, kind: 'directory' | 'file'): Promise<string[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter(entry => pattern.test(entry.name) && (kind === 'directory' ? entry.isDirectory() : entry.isFile()))
		.map(entry => entry.name);
}

/** `<ホーム>/sessions` の下の会話ログを `YYYY/MM/DD/rollout-*.jsonl` の相対パスで列挙する。 */
async function listRollouts(codexHome: string): Promise<string[]> {
	const sessionsRoot = join(codexHome, 'sessions');
	const result: string[] = [];
	for (const year of await readDirectoryNames(sessionsRoot, YEAR_PATTERN, 'directory')) {
		for (const month of await readDirectoryNames(join(sessionsRoot, year), MONTH_OR_DAY_PATTERN, 'directory')) {
			for (const day of await readDirectoryNames(join(sessionsRoot, year, month), MONTH_OR_DAY_PATTERN, 'directory')) {
				for (const file of await readDirectoryNames(join(sessionsRoot, year, month, day), ROLLOUT_PATTERN, 'file')) {
					result.push(`${year}/${month}/${day}/${file}`);
				}
			}
		}
	}
	return result;
}

/**
 * 渡したホームどうしで会話ログをハードリンクし合う。各ホームに無い会話だけを足す。
 *
 * @param codexHomes アカウント用ホームの絶対パス。1つ以下なら何もしない。
 */
export async function paradisLinkCodexSessions(codexHomes: readonly string[], options: IParadisCodexSessionLinkOptions = {}): Promise<IParadisCodexSessionLinkSummary> {
	const summary: IMutableSummary = { linked: 0, skippedExisting: 0, skippedUnsupported: 0, failed: 0 };
	const homes = [...new Set(codexHomes)];
	if (homes.length < 2) {
		return summary;
	}
	// 相対パス → それを持っているホーム
	const owners = new Map<string, string[]>();
	for (const home of homes) {
		for (const relative of await listRollouts(home)) {
			const list = owners.get(relative);
			if (list) {
				list.push(home);
			} else {
				owners.set(relative, [home]);
			}
		}
	}
	const ensuredDirectories = new Set<string>();
	for (const [relative, owningHomes] of owners) {
		if (owningHomes.length === homes.length) {
			continue;
		}
		const segments = relative.split('/');
		const source = await pickSource(owningHomes, segments);
		if (source === undefined) {
			summary.failed++;
			continue;
		}
		for (const home of homes) {
			if (options.shouldStop?.()) {
				return summary;
			}
			if (owningHomes.includes(home)) {
				continue;
			}
			const target = join(home, 'sessions', ...segments);
			try {
				const directory = dirname(target);
				if (!ensuredDirectories.has(directory)) {
					await fs.promises.mkdir(directory, { recursive: true });
					ensuredDirectories.add(directory);
				}
				await fs.promises.link(source, target);
				summary.linked++;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === 'EEXIST') {
					summary.skippedExisting++;
				} else if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
					summary.skippedUnsupported++;
				} else {
					summary.failed++;
				}
			}
		}
	}
	return summary;
}

/** リンク元にする実ファイル（シンボリックリンクではないもの）を選ぶ。 */
async function pickSource(owningHomes: readonly string[], segments: readonly string[]): Promise<string | undefined> {
	for (const home of owningHomes) {
		const candidate = join(home, 'sessions', ...segments);
		try {
			const stat = await fs.promises.lstat(candidate);
			if (stat.isFile()) {
				return candidate;
			}
		} catch {
			// 次へ
		}
	}
	return undefined;
}
