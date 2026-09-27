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
//  - 一度そのホームにあった会話が消えていたら（ユーザーが削除・アーカイブした）、足し戻さない。
//    前回の実行でどのホームに何があったかを台帳（ledgerPath）に控えて見分ける
//  - 新しく作るディレクトリは 0700（会話ログを同じ PC の別ユーザーから読めなくする）
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
	/**
	 * 「前回どのホームに何があったか」の台帳。指定しないと削除した会話も足し戻すので、
	 * 本番では必ず渡す。
	 */
	readonly ledgerPath?: string;
}

interface IMutableSummary {
	linked: number;
	skippedExisting: number;
	skippedRemoved: number;
	skippedUnsupported: number;
	failed: number;
}

interface ILinkLedger {
	readonly version: 1;
	/** ホーム → 前回の実行の終わりにそのホームにあった会話の相対パス。 */
	readonly homes: { readonly [home: string]: readonly string[] };
}

async function readLedger(ledgerPath: string | undefined): Promise<Map<string, Set<string>>> {
	const result = new Map<string, Set<string>>();
	if (ledgerPath === undefined) {
		return result;
	}
	try {
		const parsed = JSON.parse(await fs.promises.readFile(ledgerPath, 'utf8')) as Partial<ILinkLedger>;
		if (parsed.version === 1 && parsed.homes && typeof parsed.homes === 'object') {
			for (const [home, paths] of Object.entries(parsed.homes)) {
				if (Array.isArray(paths)) {
					result.set(home, new Set(paths.filter((entry): entry is string => typeof entry === 'string')));
				}
			}
		}
	} catch {
		// 無い・壊れている → 初回と同じ（今あるものを控えるところから始める）
	}
	return result;
}

async function writeLedger(ledgerPath: string, ledger: Map<string, Set<string>>): Promise<void> {
	const payload: ILinkLedger = { version: 1, homes: Object.fromEntries([...ledger].map(([home, paths]) => [home, [...paths].sort()])) };
	await fs.promises.mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 });
	const temporaryPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
	await fs.promises.writeFile(temporaryPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
	await fs.promises.rename(temporaryPath, ledgerPath);
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
	const summary: IMutableSummary = { linked: 0, skippedExisting: 0, skippedRemoved: 0, skippedUnsupported: 0, failed: 0 };
	const homes = [...new Set(codexHomes)];
	if (homes.length < 2) {
		return summary;
	}
	const ledger = await readLedger(options.ledgerPath);
	// 相対パス → それを持っているホーム
	const owners = new Map<string, string[]>();
	const present = new Map<string, Set<string>>();
	for (const home of homes) {
		const rollouts = await listRollouts(home);
		present.set(home, new Set(rollouts));
		for (const relative of rollouts) {
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
			// 前回はこのホームにあったのに今は無い → ユーザーが消したかアーカイブした。戻さない。
			if (ledger.get(home)?.has(relative)) {
				summary.skippedRemoved++;
				continue;
			}
			const target = join(home, 'sessions', ...segments);
			try {
				const directory = dirname(target);
				if (!ensuredDirectories.has(directory)) {
					await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
					ensuredDirectories.add(directory);
				}
				await fs.promises.link(source, target);
				present.get(home)?.add(relative);
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
	if (options.ledgerPath !== undefined) {
		// 今あるものを控える。ほかのホームの控えは残す（切替のたびに対象の2ホームだけを見るため）。
		for (const [home, paths] of present) {
			ledger.set(home, paths);
		}
		await writeLedger(options.ledgerPath, ledger);
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
