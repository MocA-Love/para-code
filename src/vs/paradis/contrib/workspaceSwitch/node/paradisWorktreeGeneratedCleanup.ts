/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ほかのワークツリーに残った、古い依存とビルド出力（node_modules・out・dist・build）を探して消す（Orca W3 の G-07、
// Orca #32331 の reclaim-worktree-generated-files.mjs と同じ規則）。リポジトリのあるマシンで動く。
// 探すのと消すのを分け、消す直前に同じフォルダか（dev・ino）・まだ古いか・追跡されていないか・入れ子のリポジトリが
// 無いかを測り直す。Orca の探す場所（PACKAGE_ROOTS）は Orca のリポジトリ専用なので、ここでは
// 「ワークツリーのルート」と「package.json のある 1 段下・packages/*・apps/* のフォルダ」にした。

import { promises as fs, Stats } from 'fs';
import { isAbsolute, join, relative, sep } from '../../../../base/common/path.js';
import { IParadisGeneratedOutputCandidate, PARADIS_GENERATED_OUTPUT_NAMES } from '../common/paradisWorktreeGeneratedCleanup.js';

/** 外の働き（git に聞く）。テストから差し替える。 */
export interface IParadisGeneratedCleanupHost {
	/** そのワークツリーで `rel`（`/` 区切り）が追跡されておらず、フォルダとして無視されているか。分からなければ false。 */
	isIgnoredAndUntracked(worktree: string, rel: string): Promise<boolean>;
}

async function info(path: string): Promise<Stats | undefined> {
	try {
		return await fs.lstat(path);
	} catch {
		return undefined;
	}
}

/** `parts` を 1 段ずつ辿る。途中がフォルダでない（シンボリックリンクを含む）か、入れ子のリポジトリ（`.git` がある）なら undefined。 */
async function descend(root: string, parts: readonly string[]): Promise<string | undefined> {
	let path = root;
	for (const part of parts) {
		path = join(path, part);
		if (!(await info(path))?.isDirectory()) {
			return undefined;
		}
		if (await info(join(path, '.git'))) {
			return undefined;
		}
	}
	return path;
}

/** 探す場所（package.json のあるフォルダ）。ワークツリーのルートは常に入れる。 */
async function packageRoots(worktree: string): Promise<string[][]> {
	const roots: string[][] = [[]];
	const childrenOf = async (parts: string[]) => {
		const parent = await descend(worktree, parts);
		if (!parent) {
			return [];
		}
		try {
			return (await fs.readdir(parent, { withFileTypes: true }))
				.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !PARADIS_GENERATED_OUTPUT_NAMES.includes(entry.name))
				.map(entry => [...parts, entry.name]);
		} catch {
			return [];
		}
	};
	for (const parts of [...await childrenOf([]), ...await childrenOf(['packages']), ...await childrenOf(['apps'])]) {
		const path = await descend(worktree, parts);
		if (path && (await info(join(path, 'package.json')))?.isFile() && !roots.some(root => root.join('/') === parts.join('/'))) {
			roots.push(parts);
		}
	}
	return roots;
}

/** 入れ子のリポジトリを探す深さの上限。`node_modules` の奥まで全部は見ない。 */
const NESTED_REPOSITORY_MAX_DEPTH = 32;

/**
 * 中に入れ子のリポジトリ（`.git`、または bare の形）があるか（Orca と同じ規則）。深さ {@link NESTED_REPOSITORY_MAX_DEPTH} で
 * 打ち切り、打ち切ったときは「あるかもしれない」として true を返す（消さない側に倒す）。
 */
async function containsNestedRepository(root: string): Promise<boolean> {
	const pending: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
	while (pending.length > 0) {
		const { path, depth } = pending.pop()!;
		if (!(await info(path))?.isDirectory()) {
			return true;
		}
		const entries = await fs.readdir(path, { withFileTypes: true });
		const names = new Set(entries.map(entry => entry.name));
		if (names.has('.git') || (names.has('HEAD') && names.has('objects') && (names.has('refs') || names.has('config')))) {
			return true;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (depth + 1 > NESTED_REPOSITORY_MAX_DEPTH) {
					return true;
				}
				pending.push({ path: join(path, entry.name), depth: depth + 1 });
			}
		}
	}
	return false;
}

function contains(root: string, path: string): boolean {
	const part = relative(root, path);
	return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/**
 * 消す候補を探す（消さない）。`worktrees` は git に登録された、消してよい側のワークツリー（元のリポジトリ・今のスペースは
 * 呼び出し側が外す）。`cutoffMs` より新しく変わったフォルダは候補にしない。
 */
export async function paradisFindGeneratedOutputs(worktrees: readonly string[], cutoffMs: number, host: IParadisGeneratedCleanupHost): Promise<IParadisGeneratedOutputCandidate[]> {
	const candidates: IParadisGeneratedOutputCandidate[] = [];
	for (const worktree of worktrees) {
		if (!(await info(worktree))?.isDirectory()) {
			continue;
		}
		for (const parts of await packageRoots(worktree)) {
			for (const name of PARADIS_GENERATED_OUTPUT_NAMES) {
				const rel = [...parts, name];
				const path = join(worktree, ...rel);
				const stat = await info(path);
				if (!stat?.isDirectory() || stat.mtimeMs > cutoffMs) {
					continue;
				}
				if (await descend(worktree, parts) && await host.isIgnoredAndUntracked(worktree, rel.join('/'))) {
					candidates.push({ worktree, rel: rel.join('/'), dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs });
				}
			}
		}
	}
	return candidates;
}

/**
 * 候補を消す。消す直前に、登録されたワークツリーの中の候補の名前のフォルダか・探したときと同じフォルダか・まだ古いか・
 * 追跡されていないか・入れ子のリポジトリが無いかを測り直し、どれかが違えば消さずに `changed` に数える。
 */
export async function paradisRemoveGeneratedOutputs(candidates: readonly IParadisGeneratedOutputCandidate[], worktrees: readonly string[], cutoffMs: number, host: IParadisGeneratedCleanupHost): Promise<{ removed: string[]; changed: string[]; failed: string[] }> {
	const removed: string[] = [];
	const changed: string[] = [];
	const failed: string[] = [];
	for (const candidate of candidates) {
		const label = join(candidate.worktree, candidate.rel);
		try {
			const parts = typeof candidate.rel === 'string' ? candidate.rel.split('/') : [];
			const valid = typeof candidate.worktree === 'string' && worktrees.includes(candidate.worktree)
				&& parts.length > 0 && parts.every(part => part.length > 0 && part !== '.' && part !== '..')
				&& PARADIS_GENERATED_OUTPUT_NAMES.includes(parts[parts.length - 1]);
			if (!valid) {
				changed.push(label);
				continue;
			}
			const path = await descend(candidate.worktree, parts);
			const current = path === undefined ? undefined : await info(path);
			if (path === undefined || !contains(candidate.worktree, path) || !current?.isDirectory() || current.dev !== candidate.dev || current.ino !== candidate.ino
				|| current.mtimeMs > cutoffMs || !await host.isIgnoredAndUntracked(candidate.worktree, candidate.rel) || await containsNestedRepository(path)) {
				changed.push(label);
				continue;
			}
			await fs.rm(path, { recursive: true, force: true, maxRetries: 3 });
			removed.push(label);
		} catch {
			failed.push(label);
		}
	}
	return { removed, changed, failed };
}
