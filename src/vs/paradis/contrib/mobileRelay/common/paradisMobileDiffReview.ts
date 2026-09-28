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
	/**
	 * 未追跡のファイルの大きさ（バイト）と最終更新時刻（epoch ms）。未追跡のファイルは行数を数えられないので、
	 * 書き換えられたことをこれで見分ける。フォルダ（`dir/`）と、数えきれなかったものには付けない。
	 */
	readonly size?: number;
	readonly mtime?: number;
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

/** 未追跡のファイルの大きさと時刻を調べる数の上限（多すぎる一覧で status の応答を遅くしない）。 */
export const PARADIS_MOBILE_UNTRACKED_STAT_LIMIT = 100;

/** 大きさと時刻を調べる未追跡のファイルか（フォルダ `dir/` は除く）。 */
export function paradisIsUntrackedFile(file: IParadisMobileStatusFile): boolean {
	return file.x === '?' && file.y === '?' && !file.path.endsWith('/');
}

/**
 * 未追跡のファイルに大きさと時刻を足す（先頭から {@link PARADIS_MOBILE_UNTRACKED_STAT_LIMIT} 件まで）。
 * `stats` はパスの一覧をまとめて調べる（ルートの realpath を1回にまとめるため）。結果に無いもの（読めない・消えた）
 * と上限より後ろのものには付けない（大きさの無い未追跡のファイルは、確認済みのステージの対象にしない）。
 */
export async function paradisWithUntrackedFileStats(files: readonly IParadisMobileStatusFile[], stats: (paths: readonly string[]) => Promise<ReadonlyMap<string, { readonly size: number; readonly mtime: number }>>): Promise<IParadisMobileStatusFile[]> {
	const paths = files.filter(paradisIsUntrackedFile).slice(0, PARADIS_MOBILE_UNTRACKED_STAT_LIMIT).map(file => file.path);
	if (paths.length === 0) {
		return [...files];
	}
	const found = await stats(paths).catch(() => new Map<string, { readonly size: number; readonly mtime: number }>());
	return files.map(file => {
		const stat = paradisIsUntrackedFile(file) ? found.get(file.path) : undefined;
		return stat !== undefined ? { ...file, size: stat.size, mtime: stat.mtime } : file;
	});
}

/**
 * `git add` の前後で、足した中身がスマホの見たものと同じだと言えるか（印をステージ後の識別へ付け替えてよいか）。
 * - 作業ツリー側だけの変更だったもの: ステージ後の行数が、前の作業ツリー側の行数と同じ
 * - 未追跡だったもの: 新しく足された（`A `）うえで、足した後に調べ直した大きさと時刻（`afterStat`。追跡中になった
 *   ファイルの status には大きさが載らないので、呼び出し側が別に調べて渡す）が前と同じ
 * - 両側に変更があったもの（`MM` など）: 行数を足し合わせて比べられないので、付け替えない
 * どれも、足した後に作業ツリー側へ変更が残っていれば（その間に書き換えられた）付け替えない。
 */
export function paradisStagedConsistently(before: IParadisMobileStatusFile, after: IParadisMobileStatusFile, afterStat?: { readonly size: number; readonly mtime: number }): boolean {
	if (after.y !== ' ') {
		return false;
	}
	if (before.x === '?' && before.y === '?') {
		return after.x === 'A' && before.size !== undefined && before.mtime !== undefined && afterStat !== undefined && afterStat.size === before.size && afterStat.mtime === before.mtime;
	}
	if (before.x === ' ') {
		return before.added !== undefined && before.removed !== undefined && after.stagedAdded === before.added && after.stagedRemoved === before.removed;
	}
	return false;
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
 * 変更1件の「中身」の識別（Orca の diffIdentity と同じ考え方）。状態・パス・元のパス・両側の行数（未追跡の
 * ファイルは大きさと時刻）から作るので、確認した後にエージェントが書き換えて行数が変われば別の値になる
 * （追跡中のファイルで行数が同じ書き換えは見分けられない）。
 * ステージすると状態と行数の側が変わるので別の値になる（PC が確認済みのステージを行ったときは印を付け替える）。
 */
export function paradisMobileDiffIdentity(file: IParadisMobileStatusFile): string {
	const key = JSON.stringify(['worktree', file.x, file.y, file.oldPath ?? '', file.path, file.added ?? '', file.removed ?? '', file.stagedAdded ?? '', file.stagedRemoved ?? '', file.size ?? '', file.mtime ?? '']);
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

// --- 差分の行へのメモ（Orca W2-28） ------------------------------------------------

/** PC が差分の行へのメモを保存し、エージェントへ送れる（`reviewNoteAdd` など）。 */
export const PARADIS_MOBILE_REVIEW_NOTES_CAPABILITY = 'review.notes.v1';
/** PC が確認済みのファイルだけをステージできる（`reviewStage`）。 */
export const PARADIS_MOBILE_REVIEW_STAGE_CAPABILITY = 'review.stage.v1';

/** 差分の行へのメモ1件。PC に保存し、iPhone と iPad で同じものを見る。 */
export interface IParadisMobileReviewNote {
	readonly id: string;
	readonly path: string;
	/** 書いたときの新しい側の行番号（1 から）。 */
	readonly line: number;
	/** 書いたときのその行の中身。行が上下に動いても、中身で追いかける。 */
	readonly lineText: string;
	readonly body: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** エージェントへ送った時刻。送った後も「送信済み」として残す（Q120 A）。 */
	readonly sentAt?: number;
}

/** 行を探す範囲（書いたときの行番号の前後）。これより遠くへ動いた行は「古いメモ」にする。 */
export const PARADIS_MOBILE_REVIEW_NOTE_SEARCH_RADIUS = 50;

/**
 * メモの行がいまどこにあるか。書いたときの行番号の中身が同じならそこ、違えば前後
 * {@link PARADIS_MOBILE_REVIEW_NOTE_SEARCH_RADIUS} 行から中身が同じ行（近い方）を探す。
 * 見つからなければ undefined（「古いメモ」。直されて行が変わった）。
 *
 * `textAt` は行番号（1 から）からその行の中身を返す。アプリは差分の行から、PC は作業ツリーのファイルから引く。
 */
export function paradisLocateReviewNoteLine(textAt: (line: number) => string | undefined, line: number, lineText: string): number | undefined {
	if (textAt(line) === lineText) {
		return line;
	}
	for (let distance = 1; distance <= PARADIS_MOBILE_REVIEW_NOTE_SEARCH_RADIUS; distance++) {
		if (line - distance >= 1 && textAt(line - distance) === lineText) {
			return line - distance;
		}
		if (textAt(line + distance) === lineText) {
			return line + distance;
		}
	}
	return undefined;
}

/** 送るメモ1件と、いまの行（見つからなければ undefined）。 */
export interface IParadisMobileReviewNoteToSend {
	readonly note: IParadisMobileReviewNote;
	readonly currentLine: number | undefined;
}

/** 依頼文に入れる行の中身の長さの上限。 */
const PROMPT_LINE_TEXT_MAX = 200;

function indentContinuation(text: string, indent: string): string {
	return text.split('\n').map((line, index) => index === 0 ? line : `${indent}${line}`).join('\n');
}

/**
 * エージェントへ送る依頼文。PC が保存済みのメモから組み立てる（スマホから届いた文章をそのまま打ち込まない）。
 * 行が見つからなくなったメモは、書いたときの行番号を添えて送る。
 */
export function paradisBuildReviewNotesPrompt(notes: readonly IParadisMobileReviewNoteToSend[]): string {
	const items = notes.map(({ note, currentLine }, index) => {
		const where = currentLine !== undefined
			? `${note.path}:${currentLine}`
			: `${note.path}（メモを書いた後に行が変わっています。書いたときは ${note.line} 行目）`;
		const lineText = note.lineText.trim();
		const shown = lineText.length > PROMPT_LINE_TEXT_MAX ? `${lineText.slice(0, PROMPT_LINE_TEXT_MAX)}…` : lineText;
		return [
			`${index + 1}. ${where}`,
			`   対象の行: ${shown}`,
			`   メモ: ${indentContinuation(note.body.trim(), '         ')}`,
		].join('\n');
	});
	return ['差分レビューのメモです。それぞれの場所を確かめて、メモに沿って直してください。', '', ...items].join('\n');
}
