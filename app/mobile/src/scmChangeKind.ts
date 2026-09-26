// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { colors, type ThemeColor } from './theme.js';

/**
 * ソース管理の変更1件が「何が起きたファイルか」の判定と、その記号・呼び名・色。
 *
 * 以前は未追跡（git の `??`）を「A」と出していて、`git add` 済みの追加と見分けが付かなかった。
 * 未追跡は VS Code と同じ「U」にし、色も分ける。そのため git がマージの競合に使う `U`
 * （`UU` `AU` など）は「!」で出す（VS Code と同じ。同じ「U」が2つの意味を持たないように）。
 */
export type ScmChangeKind = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed' | 'copied' | 'typeChanged' | 'conflict' | 'other';

export interface ScmChangeMeta {
	/** 行の先頭に出す1文字。 */
	readonly symbol: string;
	/** 記号の説明・読み上げに使う呼び名。 */
	readonly label: string;
	readonly color: ThemeColor;
}

const META: Record<Exclude<ScmChangeKind, 'other'>, ScmChangeMeta> = {
	modified: { symbol: 'M', label: '変更', color: colors.mod },
	added: { symbol: 'A', label: '追加', color: colors.add },
	untracked: { symbol: 'U', label: '未追跡', color: colors.purple },
	deleted: { symbol: 'D', label: '削除', color: colors.del },
	renamed: { symbol: 'R', label: '名前の変更', color: colors.textDim },
	copied: { symbol: 'C', label: 'コピー', color: colors.textDim },
	typeChanged: { symbol: 'T', label: '種類の変更', color: colors.textDim },
	conflict: { symbol: '!', label: '競合', color: colors.red },
};

/** 記号の説明に並べる順（よく出るものから）。 */
export const SCM_CHANGE_LEGEND: readonly ScmChangeMeta[] = [
	META.modified, META.added, META.untracked, META.deleted, META.renamed, META.conflict,
];

const BY_LETTER: Record<string, Exclude<ScmChangeKind, 'other' | 'untracked' | 'conflict'>> = {
	M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typeChanged',
};

/**
 * `git status --porcelain` の2文字（x: インデックス側、y: 作業ツリー側）から種類を決める。
 * 両側に文字があるときはインデックス側を優先する（`AM` は追加、以前の表示と同じ）。
 */
export function scmChangeKind(x: string, y: string): ScmChangeKind {
	if (x === '?' || y === '?') {
		return 'untracked';
	}
	if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
		return 'conflict';
	}
	const letter = x !== ' ' && x !== '' ? x : y;
	return BY_LETTER[letter] ?? 'other';
}

/** コミットに含まれるファイルの状態（`git show --name-status` の `M` `A` `D` `R100` など）の種類。 */
export function commitFileKind(status: string): ScmChangeKind {
	return BY_LETTER[status.charAt(0)] ?? 'other';
}

/** 種類の記号・呼び名・色。`other` は元の文字をそのまま出す。 */
export function scmChangeMeta(kind: ScmChangeKind, raw: string): ScmChangeMeta {
	if (kind === 'other') {
		return { symbol: raw.trim().charAt(0) || '?', label: '不明な変更', color: colors.textDim };
	}
	return META[kind];
}
