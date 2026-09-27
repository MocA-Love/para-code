/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT): src/main/codex/codex-session-backfill.ts

// Codex の会話ログ（`<ホーム>/sessions/YYYY/MM/DD/rollout-*.jsonl`）を、切り替えた2つのホームの間で
// ハードリンクし合う。切り替えた先のアカウントでも `codex resume` で過去の会話を開けるようにするため。
//
// 決まりごと（壊さないための約束）:
//  - 既にあるファイルは決して上書きしない（`link` は既存なら EEXIST で失敗するので、それを「済み」とみなす）
//  - 何も消さない・動かさない
//  - 一度そのホームにあった会話が消えていたら（ユーザーが削除・アーカイブした）、二度と足し戻さない。
//    これまでにそのホームで見た会話を台帳（ledgerPath）に積み上げて見分ける（上書きせず和集合にする）
//  - リンクするのは、出どころ（その会話を Codex が最初に書いたホーム）が対象の2ホームのどちらかの
//    会話だけ。A→B→C と切り替えても、A の会話が C へ届かないようにする。出どころは初めて見たときに
//    「その会話を持っているホームが1つだけならそこ」と決め、分からないもの（初めて見た時点で複数の
//    ホームにあった）はどこへもリンクしない
//  - 台帳が読めない・壊れているときはリンクせず、壊れた台帳を退避してから「今あるものは全部見た」という
//    台帳を作り直す（どれを消したのか分からないので、既存の会話は以後リンクしない）
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
	 * これまでにどのホームで何を見たか・会話の出どころの台帳。指定しないと削除した会話も足し戻し、
	 * 出どころも見ないので、本番では必ず渡す。
	 */
	readonly ledgerPath?: string;
	/**
	 * 出どころを決めるために見るホーム（ログイン済みのアカウント用ホーム全部）。リンクする2ホームは
	 * 含めなくてよい。新しい会話が1つのホームにしか無いことを確かめるのに使う。
	 */
	readonly observeHomes?: readonly string[];
}

interface IMutableSummary {
	linked: number;
	skippedExisting: number;
	skippedRemoved: number;
	skippedOtherOrigin: number;
	skippedUnsupported: number;
	failed: number;
	ledgerUnavailable?: boolean;
}

interface ILinkLedgerFile {
	readonly version: 2;
	/** ホーム → これまでにそのホームで見た会話の相対パス（消えても残す）。 */
	readonly homes: { readonly [home: string]: readonly string[] };
	/** 会話の相対パス → 出どころのホーム。分からないものは null。 */
	readonly origins: { readonly [relative: string]: string | null };
}

interface ILinkLedger {
	readonly seen: Map<string, Set<string>>;
	readonly origins: Map<string, string | null>;
}

type LedgerRead = { readonly kind: 'ok'; readonly ledger: ILinkLedger } | { readonly kind: 'unavailable' };

function emptyLedger(): ILinkLedger {
	return { seen: new Map(), origins: new Map() };
}

async function readLedger(ledgerPath: string): Promise<LedgerRead> {
	let text: string;
	try {
		text = await fs.promises.readFile(ledgerPath, 'utf8');
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'ok', ledger: emptyLedger() } : { kind: 'unavailable' };
	}
	try {
		const parsed = JSON.parse(text) as Partial<ILinkLedgerFile>;
		if (parsed.version !== 2 || !parsed.homes || typeof parsed.homes !== 'object' || !parsed.origins || typeof parsed.origins !== 'object') {
			return { kind: 'unavailable' };
		}
		const ledger = emptyLedger();
		for (const [home, paths] of Object.entries(parsed.homes)) {
			if (!Array.isArray(paths)) {
				return { kind: 'unavailable' };
			}
			ledger.seen.set(home, new Set(paths.filter((entry): entry is string => typeof entry === 'string')));
		}
		for (const [relative, origin] of Object.entries(parsed.origins)) {
			ledger.origins.set(relative, typeof origin === 'string' ? origin : null);
		}
		return { kind: 'ok', ledger };
	} catch {
		return { kind: 'unavailable' };
	}
}

async function writeLedger(ledgerPath: string, ledger: ILinkLedger): Promise<void> {
	const payload: ILinkLedgerFile = {
		version: 2,
		homes: Object.fromEntries([...ledger.seen].map(([home, paths]) => [home, [...paths].sort()])),
		origins: Object.fromEntries([...ledger.origins].sort(([a], [b]) => a.localeCompare(b))),
	};
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

function addSeen(ledger: ILinkLedger, home: string, relative: string): void {
	let seen = ledger.seen.get(home);
	if (!seen) {
		seen = new Set();
		ledger.seen.set(home, seen);
	}
	seen.add(relative);
}

/**
 * 渡したホームどうしで会話ログをハードリンクし合う。各ホームに無い会話だけを足す。
 *
 * @param codexHomes リンクし合うホーム（切り替えた2つ）の絶対パス。1つ以下なら何もしない。
 */
export async function paradisLinkCodexSessions(codexHomes: readonly string[], options: IParadisCodexSessionLinkOptions = {}): Promise<IParadisCodexSessionLinkSummary> {
	const summary: IMutableSummary = { linked: 0, skippedExisting: 0, skippedRemoved: 0, skippedOtherOrigin: 0, skippedUnsupported: 0, failed: 0 };
	const homes = [...new Set(codexHomes)];
	if (homes.length < 2) {
		return summary;
	}
	const observeHomes = [...new Set([...homes, ...(options.observeHomes ?? [])])];
	const present = new Map<string, Set<string>>();
	for (const home of observeHomes) {
		present.set(home, new Set(await listRollouts(home)));
	}

	let ledger: ILinkLedger | undefined;
	if (options.ledgerPath !== undefined) {
		const read = await readLedger(options.ledgerPath);
		if (read.kind === 'unavailable') {
			// どれを消したのか分からない。壊れた台帳を退避し、今あるものは全部「全ホームで見た・出どころ
			// 不明」として作り直す（既存の会話は以後リンクしない。新しい会話だけが対象になる）。
			summary.ledgerUnavailable = true;
			await fs.promises.rename(options.ledgerPath, `${options.ledgerPath}.unreadable-${Date.now()}`).catch(() => { });
			const baseline = emptyLedger();
			for (const paths of present.values()) {
				for (const relative of paths) {
					baseline.origins.set(relative, null);
					for (const home of observeHomes) {
						addSeen(baseline, home, relative);
					}
				}
			}
			await writeLedger(options.ledgerPath, baseline);
			return summary;
		}
		ledger = read.ledger;
		// 初めて見る会話の出どころを決める。持っているホームが1つだけならそこ、複数なら分からない。
		const owners = new Map<string, string[]>();
		for (const [home, paths] of present) {
			for (const relative of paths) {
				const list = owners.get(relative);
				if (list) {
					list.push(home);
				} else {
					owners.set(relative, [home]);
				}
			}
		}
		for (const [relative, owningHomes] of owners) {
			if (!ledger.origins.has(relative)) {
				ledger.origins.set(relative, owningHomes.length === 1 ? owningHomes[0] : null);
			}
		}
	}

	const ensuredDirectories = new Set<string>();
	const candidates = new Set<string>();
	for (const home of homes) {
		for (const relative of present.get(home) ?? []) {
			candidates.add(relative);
		}
	}
	for (const relative of candidates) {
		const owningHomes = homes.filter(home => present.get(home)?.has(relative));
		if (owningHomes.length === homes.length) {
			continue;
		}
		if (ledger) {
			const origin = ledger.origins.get(relative);
			if (origin === null || origin === undefined || !homes.includes(origin)) {
				summary.skippedOtherOrigin++;
				continue;
			}
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
			// 前にこのホームで見たのに今は無い → ユーザーが消したかアーカイブした。戻さない。
			if (ledger?.seen.get(home)?.has(relative)) {
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
	if (ledger && options.ledgerPath !== undefined) {
		// 今あるものを、これまでに見たものへ足す（置き換えない。消えた会話の控えを残すため）。
		for (const [home, paths] of present) {
			for (const relative of paths) {
				addSeen(ledger, home, relative);
			}
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
