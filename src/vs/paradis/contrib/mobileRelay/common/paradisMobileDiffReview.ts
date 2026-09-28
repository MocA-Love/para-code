/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルの差分レビューで PC とアプリが同じ答えを出すべき判定（Orca W2-14 / W2-28）。
 *
 * **このファイルは import を持たない。** アプリ（`app/mobile`）が相対パスで直接 import する
 * （`paradisMobileCompat.ts` と同じ扱い。何かを import するとアプリのバンドルに VS Code 本体が入る）。
 * アプリの tsconfig は `noUncheckedIndexedAccess` が有効なので、配列の添字は undefined を考えて書く。
 */

/** PC が差分レビューの「確認済み」を保存でき、iPhone と iPad で揃えられる（`reviewGet` / `reviewSet`）。 */
export const PARADIS_MOBILE_REVIEW_STORE_CAPABILITY = 'review.store.v1';

/** git status の1件（モバイルの scm `status` 応答の `files[]`）。行数は任意項目（W2-14 より前の PC は送らない）。 */
export interface IParadisMobileStatusFile {
	readonly x: string;
	readonly y: string;
	readonly path: string;
	/** 名前を変えたファイルの元のパス。 */
	readonly oldPath?: string;
	/** 作業ツリーとインデックスの差（`git diff --numstat`）の追加行・削除行。バイナリは -1。 */
	readonly added?: number;
	readonly removed?: number;
	/** インデックスと HEAD の差（`git diff --cached --numstat`）の追加行・削除行。バイナリは -1。 */
	readonly stagedAdded?: number;
	readonly stagedRemoved?: number;
}

/**
 * `git status --porcelain=v1` を読む。リネームは `old -> new` なので、`path` に新しい側、`oldPath` に元の側を入れる。
 * パスの引用（特殊な文字を含むときの `"..."`）はそのまま残す（今までの応答と同じ）。
 */
export function paradisParseMobilePorcelainStatus(stdout: string): IParadisMobileStatusFile[] {
	return stdout.split('\n').filter(line => line.length > 3).map(line => {
		const rest = line.slice(3);
		const arrow = rest.indexOf(' -> ');
		return arrow >= 0
			? { x: line.charAt(0), y: line.charAt(1), path: rest.slice(arrow + 4), oldPath: rest.slice(0, arrow) }
			: { x: line.charAt(0), y: line.charAt(1), path: rest };
	});
}

interface ILineCount {
	readonly added: number;
	readonly removed: number;
}

function numstatCount(value: string): number {
	return value === '-' ? -1 : Number.parseInt(value, 10);
}

/**
 * `git diff --numstat -z` を、パス（リネームなら新しい側）ごとの行数にする。読めない行は飛ばす。
 * `-z` の形: 通常は `追加\t削除\tパス\0`、リネームは `追加\t削除\t\0元のパス\0新しいパス\0`。
 */
export function paradisParseNumstatZ(stdout: string): Map<string, ILineCount> {
	const counts = new Map<string, ILineCount>();
	const tokens = stdout.split('\0');
	for (let index = 0; index < tokens.length; index++) {
		const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(tokens[index] ?? '');
		if (match === null) {
			continue;
		}
		const added = numstatCount(match[1] ?? '');
		const removed = numstatCount(match[2] ?? '');
		let path = match[3] ?? '';
		if (path.length === 0) {
			// リネーム: 続く2つが元のパスと新しいパス
			path = tokens[index + 2] ?? '';
			index += 2;
		}
		if (path.length > 0 && Number.isFinite(added) && Number.isFinite(removed)) {
			counts.set(path, { added, removed });
		}
	}
	return counts;
}

/** status の各件に、作業ツリー側とインデックス側の行数を足す（数えられなかった側は付けない）。 */
export function paradisWithMobileLineCounts(files: readonly IParadisMobileStatusFile[], unstagedNumstatZ: string | undefined, stagedNumstatZ: string | undefined): IParadisMobileStatusFile[] {
	const unstaged = unstagedNumstatZ !== undefined ? paradisParseNumstatZ(unstagedNumstatZ) : undefined;
	const staged = stagedNumstatZ !== undefined ? paradisParseNumstatZ(stagedNumstatZ) : undefined;
	return files.map(file => {
		const worktree = unstaged?.get(file.path);
		const index = staged?.get(file.path);
		return {
			...file,
			...(worktree !== undefined ? { added: worktree.added, removed: worktree.removed } : {}),
			...(index !== undefined ? { stagedAdded: index.added, stagedRemoved: index.removed } : {}),
		};
	});
}

/** FNV-1a（32 ビット）。`seed` を変えて 2 回回し、64 ビットぶんの識別にする。 */
function fnv1a(text: string, seed: number): string {
	let hash = seed >>> 0;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/**
 * 変更1件の「中身」の識別（Orca の diffIdentity と同じ考え方）。状態・パス・元のパス・両側の行数から作るので、
 * 確認した後にエージェントが書き換えて行数が変われば別の値になる（同じ行数の書き換えは見分けられない）。
 * ステージすると状態と行数の側が変わるので別の値になる（PC が確認済みのステージを行ったときは印を付け替える）。
 */
export function paradisMobileDiffIdentity(file: IParadisMobileStatusFile): string {
	const key = JSON.stringify(['worktree', file.x, file.y, file.oldPath ?? '', file.path, file.added ?? '', file.removed ?? '', file.stagedAdded ?? '', file.stagedRemoved ?? '']);
	return fnv1a(key, 0x811c9dc5) + fnv1a(key, 0x2f5d8a3b);
}

/** 確認済みの印1件。`identity` は確認したときの {@link paradisMobileDiffIdentity}。 */
export interface IParadisMobileReviewMark {
	readonly identity: string;
	/** 確認した時刻（epoch ms）。 */
	readonly reviewedAt: number;
}

/** いまの変更に対する印の状態。`changed` は確認した後に中身が変わった（もう一度見てほしい）。 */
export type ParadisMobileReviewState = 'todo' | 'reviewed' | 'changed';

export function paradisMobileReviewState(identity: string, mark: IParadisMobileReviewMark | undefined): ParadisMobileReviewState {
	if (mark === undefined) {
		return 'todo';
	}
	return mark.identity === identity ? 'reviewed' : 'changed';
}
