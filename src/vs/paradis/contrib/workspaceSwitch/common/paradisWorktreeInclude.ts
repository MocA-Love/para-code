/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 新しいワークツリーへ持ち込むもの（Orca の `.worktreeinclude` と orca.yaml の `worktree.sharedDirectories` に当たる、
// Orca W3 の G-06）の宣言の読み書き。宣言はリポジトリの .paracode.json の `worktree` に置く:
//
//   "worktree": {
//     "include": [".env", "config/secrets.json"],   // 写す（作成の直後に元のリポジトリから複製する）
//     "sharedDirectories": [".cache/models"]       // リンクする（元のフォルダを共有する）
//   }
//
// リポジトリ直下の `.worktreeinclude`（1 行に 1 つのパス。Claude Code などと共通の書き方）も「写す」に足す。
// どちらも git が無視しているものだけを持ち込む（追跡しているものは git が作業ツリーに出すため、持ち込むと差分になる）。

import { parse as parseJsonc } from '../../../../base/common/jsonc.js';
import { localize } from '../../../../nls.js';

/** リポジトリ直下の、写すパスを並べたファイル（Orca・Claude Code と同じ名前）。 */
export const PARADIS_WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/** 1 つの宣言に並べられるパスの数の上限（Orca と同じ）。 */
export const PARADIS_WORKTREE_INCLUDE_MAX_ENTRIES = 1000;

/** `.worktreeinclude` を読む大きさの上限（Orca と同じ）。 */
export const PARADIS_WORKTREE_INCLUDE_MAX_FILE_BYTES = 256 * 1024;

/** 1 回の作成で写す量の上限（Orca と同じ 2 GiB・5 万件）。超えるものは写さずに知らせる。 */
export const PARADIS_WORKTREE_INCLUDE_MAX_COPY_BYTES = 2 * 1024 * 1024 * 1024;
export const PARADIS_WORKTREE_INCLUDE_MAX_COPY_ENTRIES = 50_000;

/** .paracode.json の `worktree` の中身。 */
export interface IParadisWorktreeIncludeConfig {
	/** 写すパス（リポジトリのルートからの相対パス、`/` 区切り）。 */
	readonly include: readonly string[];
	/** リンクするフォルダ（同上）。 */
	readonly sharedDirectories: readonly string[];
}

/** 持ち込まなかった理由。元のリポジトリに無いもの・新しいワークツリーに既にあるものは、知らせずに飛ばす。 */
export type ParadisWorktreeIncludeSkipReason =
	/** git が無視していない（追跡しているか、無視の設定に無い）。 */
	| 'notIgnored'
	/** リンクはフォルダだけ。 */
	| 'notDirectory'
	/** 写す量の上限を超える。 */
	| 'tooLarge'
	/** 書き込み先か元が、ワークツリー・リポジトリの外を指している（途中のフォルダがシンボリックリンク）。 */
	| 'outside'
	/** この組み合わせではリンクを作れない（Windows から WSL のリポジトリ）。 */
	| 'unsupported'
	/** 写す・リンクの途中で失敗した。 */
	| 'failed';

export interface IParadisWorktreeIncludeSkipped {
	readonly path: string;
	readonly reason: ParadisWorktreeIncludeSkipReason;
}

/** 持ち込みの結果。 */
export interface IParadisWorktreeIncludeResult {
	readonly copied: readonly string[];
	readonly linked: readonly string[];
	readonly skipped: readonly IParadisWorktreeIncludeSkipped[];
}

/** shared process / REH の `copyWorktreeIncludes` に渡す依頼。宣言は受け側がリポジトリから自分で読む。 */
export interface IParadisCopyWorktreeIncludesRequest<TPath extends string = string> {
	readonly repoPath: TPath;
	readonly worktreePath: TPath;
}

/**
 * 1 つのパスを宣言として受けられる形にする。前後の空白・`./`・末尾の `/` を落とし、`\` を `/` にする。
 * 絶対パス・`..`・空のセグメント・`.git` で始まるもの・`*` `?` `!` を含むもの（パターンは使えない。Orca と同じ）は
 * undefined を返す。
 */
export function paradisNormalizeWorktreeIncludePath(raw: unknown): string | undefined {
	if (typeof raw !== 'string') {
		return undefined;
	}
	const normalized = raw.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
	if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || /[*?!]/.test(normalized)) {
		return undefined;
	}
	const segments = normalized.split('/');
	if (segments.some(segment => segment === '' || segment === '.' || segment === '..') || segments[0] === '.git') {
		return undefined;
	}
	return normalized;
}

function normalizeList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of value) {
		const path = paradisNormalizeWorktreeIncludePath(item);
		if (path !== undefined && !seen.has(path) && result.length < PARADIS_WORKTREE_INCLUDE_MAX_ENTRIES) {
			seen.add(path);
			result.push(path);
		}
	}
	return result;
}

function parseObject(content: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = parseJsonc<unknown>(content);
	} catch {
		parsed = undefined;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		// allow-any-unicode-next-line
		throw new Error(localize('paradis.worktreeInclude.invalidConfig', ".paracode.json の内容が不正です（JSONC として解析できません）。"));
	}
	return parsed as Record<string, unknown>;
}

/** .paracode.json の内容から `worktree.include` / `worktree.sharedDirectories` を読む。使えないパスは黙って落とす。 */
export function paradisParseWorktreeIncludeConfig(content: string): IParadisWorktreeIncludeConfig {
	const worktree = parseObject(content).worktree;
	if (!worktree || typeof worktree !== 'object' || Array.isArray(worktree)) {
		return { include: [], sharedDirectories: [] };
	}
	const record = worktree as Record<string, unknown>;
	return { include: normalizeList(record.include), sharedDirectories: normalizeList(record.sharedDirectories) };
}

/**
 * `.worktreeinclude` の内容を読む（Orca の parseWorktreeIncludeFile と同じ）。`#` で始まる行と空行は飛ばし、
 * 使えないパスは落とす。
 */
export function paradisParseWorktreeIncludeFile(content: string): string[] {
	return normalizeList(content.split(/\r?\n/).filter(line => !line.trim().startsWith('#')));
}

/**
 * `worktree.include` / `worktree.sharedDirectories` を書き換えた .paracode.json の内容を返す。`worktree` のほかの項目と、
 * ファイルのほかのフィールドは残す。どちらも空なら `worktree` から消し、`worktree` が空になったら `worktree` ごと消す。
 */
export function paradisUpdateWorktreeIncludeConfig(content: string | undefined, config: IParadisWorktreeIncludeConfig): string {
	const parsed = content === undefined || content.trim().length === 0 ? {} : parseObject(content);
	const previous = parsed.worktree;
	const worktree: Record<string, unknown> = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous as Record<string, unknown> } : {};
	const include = normalizeList(config.include);
	const sharedDirectories = normalizeList(config.sharedDirectories);
	if (include.length > 0) { worktree.include = include; } else { delete worktree.include; }
	if (sharedDirectories.length > 0) { worktree.sharedDirectories = sharedDirectories; } else { delete worktree.sharedDirectories; }
	if (Object.keys(worktree).length > 0) { parsed.worktree = worktree; } else { delete parsed.worktree; }
	return `${JSON.stringify(parsed, undefined, '\t')}\n`;
}

function reasonLabel(reason: ParadisWorktreeIncludeSkipReason): string {
	switch (reason) {
		// allow-any-unicode-next-line
		case 'notIgnored': return localize('paradis.worktreeInclude.reason.notIgnored', "git が無視していない");
		// allow-any-unicode-next-line
		case 'notDirectory': return localize('paradis.worktreeInclude.reason.notDirectory', "リンクはフォルダだけ");
		// allow-any-unicode-next-line
		case 'tooLarge': return localize('paradis.worktreeInclude.reason.tooLarge', "大きすぎる");
		// allow-any-unicode-next-line
		case 'outside': return localize('paradis.worktreeInclude.reason.outside', "リポジトリの外を指している");
		// allow-any-unicode-next-line
		case 'unsupported': return localize('paradis.worktreeInclude.reason.unsupported', "この PC からはリンクを作れない");
		// allow-any-unicode-next-line
		case 'failed': return localize('paradis.worktreeInclude.reason.failed', "失敗");
	}
}

/** 持ち込めなかったものを 1 行で書く（作成の通知に出す）。持ち込めなかったものが無ければ undefined。 */
export function paradisSummarizeWorktreeIncludeSkips(result: IParadisWorktreeIncludeResult | undefined): string | undefined {
	if (!result || result.skipped.length === 0) {
		return undefined;
	}
	const items = result.skipped.map(item => localize('paradis.worktreeInclude.skippedItem', "{0}（{1}）", item.path, reasonLabel(item.reason)));
	// allow-any-unicode-next-line
	return localize('paradis.worktreeInclude.skipped', "新しいスペースへ持ち込めなかったもの: {0}", items.join(localize('paradis.worktreeInclude.separator', "、")));
}

/** 持ち込みそのものが失敗したとき（接続が切れた・古い接続先で口が無い等）の 1 行。 */
export function paradisSummarizeWorktreeIncludeFailure(message: string): string {
	// allow-any-unicode-next-line
	return localize('paradis.worktreeInclude.failed', "宣言したファイルを新しいスペースへ持ち込めませんでした: {0}", message);
}

/**
 * `git status --porcelain` の出力から、持ち込みで作ったリンク（`linkPaths`、作業ツリーのルートからの相対パス）の未追跡の行を外す。
 * `node_modules/` のようなフォルダとしての無視はリンクに当たらず、git がリンクを未追跡と見るため（タスクボードの返却、762-RES）。
 * 引用された名前（`"a b"`）の行は外さない（残すと「未コミットの変更がある」側に倒れるだけで、消しすぎない）。
 */
export function paradisPorcelainWithoutIncludeLinks(porcelain: string, linkPaths: readonly string[]): string {
	if (linkPaths.length === 0) {
		return porcelain;
	}
	const links = new Set(linkPaths);
	return porcelain.split('\n').filter(line => !(line.startsWith('?? ') && links.has(line.slice(3).replace(/\/$/, '')))).join('\n');
}
