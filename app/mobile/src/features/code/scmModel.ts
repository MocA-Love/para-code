// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisMobileDiffIdentity } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileDiffReview.js';
import { scmChangeKind, scmChangeMeta, type ScmChangeKind, type ScmChangeMeta } from '../../scmChangeKind.js';
import type { ScmStatusResult } from '../../store.js';

/**
 * ソース管理の画面（Orca の MobileSourceControlPanel）で使う判定。React に依存しない純関数で、
 * `scmModel.test.ts` で固定している。記号・色・呼び名は既存の `src/scmChangeKind.ts` を使い、
 * ここでは「どの区分に並べるか」「主ボタンをどうするか」だけを決める。
 */

/** 一覧の区分（Orca の「Changes / Untracked Files / Staged Changes」）。 */
export type ScmGroup = 'changes' | 'untracked' | 'staged';

export interface ScmEntry {
	readonly path: string;
	readonly group: ScmGroup;
	/** 差分をインデックス側（`git diff --staged`）で取るか。 */
	readonly staged: boolean;
	readonly kind: ScmChangeKind;
	readonly meta: ScmChangeMeta;
	/**
	 * 変更の中身の識別（状態・パス・行数から PC と同じ関数で作る）。差分レビューで確認した後に
	 * 書き換えられたかを、確認したときの値と比べて見分ける。
	 */
	readonly identity: string;
	/**
	 * 一部だけステージされている（`MM` など。インデックス側にも作業ツリー側にも変化がある）。一覧では「変更」に出すが、
	 * ステージ済みの数にも入れる（コミットはステージ済みだけを対象にし、未ステージの分まで入れない）。
	 */
	readonly partiallyStaged: boolean;
}

/** 区分の見出しと並び順（Orca と同じ: 変更 → 未追跡 → ステージ済み）。 */
export const SCM_GROUPS: readonly { readonly group: ScmGroup; readonly title: string }[] = [
	{ group: 'changes', title: '変更' },
	{ group: 'untracked', title: '未追跡のファイル' },
	{ group: 'staged', title: 'ステージ済みの変更' },
];

/**
 * `git status --porcelain` の1件を区分に振り分ける。
 *  - `??` は未追跡
 *  - インデックス側だけに変化がある（`M ` `A ` など）ものはステージ済み
 *  - それ以外（作業ツリー側に変化がある・競合）は変更
 * 両側に変化がある `MM` は「変更」に1回だけ出し、差分は作業ツリー側を見せる（旧画面と同じ）。
 */
export function scmEntry(file: ScmStatusResult['files'][number]): ScmEntry {
	const kind = scmChangeKind(file.x, file.y);
	const letter = (file.x !== ' ' && file.x !== '?' ? file.x : file.y) || '?';
	const meta = scmChangeMeta(kind, letter);
	const identity = paradisMobileDiffIdentity(file);
	if (kind === 'untracked') {
		return { path: file.path, group: 'untracked', staged: false, kind, meta, identity, partiallyStaged: false };
	}
	const indexChanged = file.x !== ' ' && file.x !== '' && kind !== 'conflict';
	const indexOnly = indexChanged && (file.y === ' ' || file.y === '');
	return { path: file.path, group: indexOnly ? 'staged' : 'changes', staged: indexOnly, kind, meta, identity, partiallyStaged: indexChanged && !indexOnly };
}

export function scmEntries(status: ScmStatusResult | undefined): ScmEntry[] {
	return (status?.files ?? []).map(scmEntry);
}

/** 区分ごとにまとめる（空の区分は出さない）。並びは {@link SCM_GROUPS} の順、区分の中は PC から届いた順。 */
export function groupScmEntries(entries: readonly ScmEntry[]): { readonly group: ScmGroup; readonly title: string; readonly entries: readonly ScmEntry[] }[] {
	return SCM_GROUPS
		.map(({ group, title }) => ({ group, title, entries: entries.filter(entry => entry.group === group) }))
		.filter(section => section.entries.length > 0);
}

/** 画面に出す順（区分の順）に並べ直した一覧。差分レビューの前後の移動もこの順で行う。 */
export function orderedScmEntries(entries: readonly ScmEntry[]): ScmEntry[] {
	return groupScmEntries(entries).flatMap(section => section.entries);
}

export interface ScmCounts {
	/** まだステージされていない変更があるもの（未追跡・一部だけステージされたものを含む）。 */
	readonly unstaged: number;
	/** ステージされた変更があるもの（一部だけステージされたものを含む）。 */
	readonly staged: number;
	readonly total: number;
}

export function scmCounts(entries: readonly ScmEntry[]): ScmCounts {
	const stagedOnly = entries.filter(entry => entry.group === 'staged').length;
	const partial = entries.filter(entry => entry.partiallyStaged).length;
	return { unstaged: entries.length - stagedOnly, staged: stagedOnly + partial, total: entries.length };
}

/** パスをファイル名と、それを含むフォルダに分ける（フォルダが無ければ空文字）。 */
export function splitPath(path: string): { readonly name: string; readonly dir: string } {
	const at = path.lastIndexOf('/');
	return at < 0 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

/**
 * 上の区分（Orca と同じ「変更 / プルリクエスト / コミット」）。プルリクエストは PC が PR の詳細を
 * 返せる（`pr.view.v1`、Orca W2-36）ときだけ出す。
 */
export type ScmSegment = 'changes' | 'pr' | 'history';

export const SCM_SEGMENTS: readonly { readonly key: ScmSegment; readonly label: string }[] = [
	{ key: 'changes', label: '変更' },
	{ key: 'history', label: 'コミット' },
];

const SCM_SEGMENTS_WITH_PR: readonly { readonly key: ScmSegment; readonly label: string }[] = [
	{ key: 'changes', label: '変更' },
	{ key: 'pr', label: 'プルリクエスト' },
	{ key: 'history', label: 'コミット' },
];

/** 並べる区分（PC が PR の詳細を返せなければ「プルリクエスト」を出さない）。 */
export function scmSegments(withPullRequest: boolean): readonly { readonly key: ScmSegment; readonly label: string }[] {
	return withPullRequest ? SCM_SEGMENTS_WITH_PR : SCM_SEGMENTS;
}

export interface CommitActionInput {
	/** PC へ要求を出せるか。 */
	readonly live: boolean;
	/** 変更の件数（一覧をまだ読めていなければ undefined）。 */
	readonly total: number | undefined;
	readonly message: string;
	readonly committing: boolean;
}

export interface CommitAction {
	readonly label: string;
	readonly disabled: boolean;
	/** 押せない理由（押したときにトーストで出す。押せるときは undefined）。 */
	readonly reason: string | undefined;
	/** メッセージの入力欄を出すか（コミットするものが無ければ点線の札に置き換える）。 */
	readonly showInput: boolean;
	/** コミットの実行中（入力欄を編集できなくする）。 */
	readonly busy: boolean;
}

/**
 * コミットバーの主ボタン（Orca の mobile-source-control-primary-action）。
 *
 * Orca は「すべてステージ → コミット → プッシュ」と状況で変わるが、PC 側にあるのは
 * 「すべての変更をまとめてコミット」（`git add -A` のあとコミット）だけなので、主ボタンは
 * コミット1つになる。押せないときの理由の優先順は 接続 → 変更の有無 → メッセージ。
 */
export function commitAction(input: CommitActionInput): CommitAction {
	if (input.committing) {
		return { label: 'コミット中…', disabled: true, reason: undefined, showInput: true, busy: true };
	}
	const showInput = input.total === undefined || input.total > 0;
	if (!input.live) {
		return { label: 'コミット', disabled: true, reason: 'PC に接続すると使えます', showInput, busy: false };
	}
	if (input.total === undefined) {
		return { label: 'コミット', disabled: true, reason: '変更を読み込んでいます', showInput, busy: false };
	}
	if (input.total === 0) {
		return { label: 'コミット', disabled: true, reason: 'コミットする変更はありません', showInput, busy: false };
	}
	if (input.message.trim().length === 0) {
		return { label: 'コミット', disabled: true, reason: 'コミットメッセージを入れてください', showInput, busy: false };
	}
	return { label: 'コミット', disabled: false, reason: undefined, showInput, busy: false };
}

/**
 * 一覧の本文に何を出すか。読み込めた一覧は、接続が切れても・再読み込みに失敗しても出し続ける
 * （切れたことはバナー、失敗は一覧の上の1行で出す）。
 */
export type ListBodyState =
	| { readonly kind: 'loading' }
	| { readonly kind: 'offline'; readonly reason: string }
	| { readonly kind: 'error'; readonly message: string }
	| { readonly kind: 'empty' }
	| { readonly kind: 'ready' };

export function listBodyState<T>(input: { readonly data: readonly T[] | undefined; readonly error: string | undefined; readonly unavailable: string | undefined }): ListBodyState {
	if (input.data !== undefined) {
		return input.data.length === 0 ? { kind: 'empty' } : { kind: 'ready' };
	}
	if (input.error !== undefined) {
		return { kind: 'error', message: input.error };
	}
	if (input.unavailable !== undefined) {
		return { kind: 'offline', reason: input.unavailable };
	}
	return { kind: 'loading' };
}

/** エラーを画面に出す文字列にする（機密は含まない。PC 側の文言をそのまま使う）。 */
export function errorMessage(error: unknown): string {
	return String(error instanceof Error ? error.message : error);
}
