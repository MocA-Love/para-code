/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルのファイルの一覧（fs の `list`）に付ける「無視されている」の印（`fs.ignored.v1`）。
 *
 * `git check-ignore` は runGit の許可リストに無いので、許可済みの `git status` を `--ignored` 付きで
 * そのフォルダだけに絞って走らせ、`!!` の行から直下の名前を拾う。既定（traditional）では、まるごと
 * 無視されたフォルダは `!! node_modules/` の 1 行になり、中までは降りない。
 *
 * パスは porcelain の決まりどおりリポジトリの根からの相対。スペースの根がリポジトリの中のフォルダなら、その位置
 * （{@link PARADIS_MOBILE_SHOW_PREFIX_ARGS}）を前に付けて読む（{@link paradisMobileIgnoredRepoDir}）。
 */

/**
 * そのフォルダ（スペースの根からの相対。根は ''）の無視を調べる git の引数。git はスペースの根（`-C`）で走るので、
 * pathspec はスペースの根からの相対でよい。パスは pathspec の魔法を効かせない（`:(literal)`）。
 * サブモジュールの中までは見ない（`--ignore-submodules=all`。大きなサブモジュールで遅くならないように）。
 */
export function paradisMobileIgnoredStatusArgs(relativeDir: string): string[] {
	const dir = relativeDir.replace(/^\/+|\/+$/g, '');
	return ['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=normal', '--ignore-submodules=all', '--', dir.length > 0 ? `:(literal)${dir}` : '.'];
}

/** スペースの根がリポジトリの中のフォルダのとき、その位置（`git rev-parse --show-prefix`。根なら ''）を調べる引数。 */
export const PARADIS_MOBILE_SHOW_PREFIX_ARGS: readonly string[] = ['rev-parse', '--show-prefix'];

/**
 * porcelain のパスはリポジトリの根からの相対なので、スペースの根の位置（`--show-prefix` の出力。末尾に `/`）を
 * 前に付けたフォルダで {@link paradisParseMobileIgnoredNames} を呼ぶ。
 */
export function paradisMobileIgnoredRepoDir(showPrefixStdout: string, relativeDir: string): string {
	const prefix = showPrefixStdout.trim().replace(/^\/+|\/+$/g, '');
	const dir = relativeDir.replace(/^\/+|\/+$/g, '');
	return prefix.length === 0 ? dir : dir.length === 0 ? prefix : `${prefix}/${dir}`;
}

/**
 * `git status --porcelain=v1 -z --ignored` の出力から、`relativeDir` の直下で無視されている名前を返す。
 * そのフォルダ自身（または祖先）がまるごと無視されているなら、直下はすべて無視なので `'all'` を返す。
 * 名前の変更（`R`）は 2 つ目の欄（元の名前）を読み飛ばす。
 */
export function paradisParseMobileIgnoredNames(stdout: string, relativeDir: string): ReadonlySet<string> | 'all' {
	const dir = relativeDir.replace(/^\/+|\/+$/g, '');
	const prefix = dir.length > 0 ? `${dir}/` : '';
	const names = new Set<string>();
	const fields = stdout.split('\0');
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		if (field.length < 4) {
			continue;
		}
		const code = field.slice(0, 2);
		if (code.startsWith('R') || code.startsWith('C')) {
			index++; // 次の欄は元の名前
			continue;
		}
		if (code !== '!!') {
			continue;
		}
		const path = field.slice(3).replace(/\/+$/, '');
		if (path.length === 0) {
			continue;
		}
		if (dir.length > 0 && (path === dir || dir.startsWith(`${path}/`))) {
			return 'all';
		}
		if (!path.startsWith(prefix)) {
			continue;
		}
		const rest = path.slice(prefix.length);
		if (rest.length > 0 && !rest.includes('/')) {
			names.add(rest);
		}
	}
	return names;
}

/** 一覧の各項目に印を付ける（無視でなければ項目をそのまま返す。古いアプリは知らない項目として読み飛ばす）。 */
export function paradisMarkMobileIgnoredEntries<T extends { readonly name: string }>(entries: readonly T[], ignored: ReadonlySet<string> | 'all' | undefined): (T | T & { readonly ignored: true })[] {
	if (ignored === undefined || (ignored !== 'all' && ignored.size === 0)) {
		return [...entries];
	}
	return entries.map(entry => ignored === 'all' || ignored.has(entry.name) ? { ...entry, ignored: true as const } : entry);
}

/**
 * 無視の印を調べる git を、スペースごとに 1 本に絞る（一覧を待たせないための時間切れの後も git は走り続けるので、
 * フォルダを次々に開くと並行で溜まる）。
 * - 同じスペースで走っている間は新しく起こさない（同じフォルダなら同じ結果を待ち、別のフォルダなら印なし）
 * - 結果は `ttlMs` の間だけ覚え、同じフォルダの読み直しでは git を走らせない
 */
export class ParadisMobileIgnoredRuns<V> {
	private readonly running = new Map<string, { readonly path: string; readonly promise: Promise<V | undefined> }>();
	private readonly cache = new Map<string, { readonly at: number; readonly value: V }>();

	constructor(
		private readonly ttlMs = 10_000,
		private readonly maxCached = 64,
		private readonly now: () => number = () => Date.now(),
	) { }

	lookup(ws: string, path: string, start: () => Promise<V | undefined>): Promise<V | undefined> {
		const key = `${ws}\0${path}`;
		const cached = this.cache.get(key);
		if (cached !== undefined && this.now() - cached.at < this.ttlMs) {
			return Promise.resolve(cached.value);
		}
		const current = this.running.get(ws);
		if (current !== undefined) {
			return current.path === path ? current.promise : Promise.resolve(undefined);
		}
		const promise: Promise<V | undefined> = start().then(value => {
			if (value !== undefined) {
				this.cache.delete(key);
				this.cache.set(key, { at: this.now(), value });
				if (this.cache.size > this.maxCached) {
					const oldest = this.cache.keys().next().value;
					if (oldest !== undefined) {
						this.cache.delete(oldest);
					}
				}
			}
			return value;
		}, () => undefined).finally(() => {
			if (this.running.get(ws)?.promise === promise) {
				this.running.delete(ws);
			}
		});
		this.running.set(ws, { path, promise });
		return promise;
	}
}
