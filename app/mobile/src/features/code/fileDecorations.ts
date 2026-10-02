// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisUnquoteGitPath } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileDiffReview.js';
import { scmChangeKind, type ScmChangeKind } from '../../scmChangeKind.js';
import type { ScmStatusResult } from '../../store.js';

/**
 * ファイルの一覧の Git の色（PC のエクスプローラーの git の装飾と同じ見え方）。React に依存しない純関数で、
 * `fileDecorations.test.ts` で固定している。
 *
 * - ファイル: 名前を状態の色にし、右端に文字（M・A・U・R・!）を出す
 * - フォルダ: 配下で最も強い状態の色で名前を塗り、右端に「•」を出す（PC の bubble と同じ）。
 *   強さは 競合 > 削除 > 変更 > 追加 > 名前の変更 > 未追跡
 * - 削除したファイルはディスクに無いので一覧に出てこない。フォルダの点だけで伝わる
 * - 無視（`fs.ignored.v1`）は名前だけを灰にし、文字は出さない
 * - 状態は scm の `status`（`--porcelain=v1`、`-uall` なし）。未追跡のフォルダは `docs/` の 1 行で届くので、
 *   その配下は全部未追跡として扱う
 *
 * 色は PC の git 拡張の dark の既定（`extensions/git/package.json` の colors）と同じ値。
 */

export type FileDecorationKind = 'conflict' | 'deleted' | 'modified' | 'added' | 'renamed' | 'untracked' | 'ignored';

export interface FileDecoration {
	readonly kind: FileDecorationKind;
	/** 名前の色。 */
	readonly color: string;
	/** 右端の文字（ファイルは状態の文字、フォルダは「•」）。無視は無し。 */
	readonly badge: string | undefined;
	/** 読み上げに使う呼び名。 */
	readonly label: string;
}

/** PC の git 拡張の dark の色（gitDecoration.*ResourceForeground）。 */
export const GIT_DECORATION_COLORS: Readonly<Record<FileDecorationKind, string>> = {
	conflict: '#e4676b',
	deleted: '#c74e39',
	modified: '#E2C08D',
	added: '#81b88b',
	renamed: '#73C991',
	untracked: '#73C991',
	ignored: '#8C8C8C',
};

const LETTERS: Readonly<Record<Exclude<FileDecorationKind, 'ignored'>, string>> = {
	conflict: '!',
	deleted: 'D',
	modified: 'M',
	added: 'A',
	renamed: 'R',
	untracked: 'U',
};

const LABELS: Readonly<Record<FileDecorationKind, string>> = {
	conflict: '競合',
	deleted: '削除',
	modified: '変更',
	added: '追加',
	renamed: '名前の変更',
	untracked: '未追跡',
	ignored: '無視',
};

/** フォルダへ集めるときの強さ（大きいほど強い）。 */
const STRENGTH: Readonly<Record<Exclude<FileDecorationKind, 'ignored'>, number>> = {
	conflict: 6,
	deleted: 5,
	modified: 4,
	added: 3,
	renamed: 2,
	untracked: 1,
};

type StatusKind = Exclude<FileDecorationKind, 'ignored'>;

function decorationKindOf(kind: ScmChangeKind): StatusKind | undefined {
	switch (kind) {
		case 'conflict': return 'conflict';
		case 'deleted': return 'deleted';
		case 'modified':
		case 'typeChanged': return 'modified';
		case 'added': return 'added';
		case 'renamed':
		case 'copied': return 'renamed';
		case 'untracked': return 'untracked';
		default: return undefined;
	}
}

export interface FileDecorationIndex {
	/** パス → 状態（ファイル）。 */
	readonly files: ReadonlyMap<string, StatusKind>;
	/** フォルダのパス → 配下で最も強い状態。 */
	readonly folders: ReadonlyMap<string, StatusKind>;
	/** 丸ごと未追跡のフォルダ（末尾の / を除いたパス）。 */
	readonly untrackedDirs: readonly string[];
}

export const EMPTY_DECORATIONS: FileDecorationIndex = { files: new Map(), folders: new Map(), untrackedDirs: [] };

function stronger(a: StatusKind | undefined, b: StatusKind): StatusKind {
	return a === undefined || STRENGTH[b] > STRENGTH[a] ? b : a;
}

/** scm の `status` の一覧から、パスで引ける表を作る（一覧が変わったときだけ作り直す）。 */
export function buildFileDecorationIndex(files: ScmStatusResult['files'] | undefined, pathsUnquoted = false): FileDecorationIndex {
	if (files === undefined || files.length === 0) {
		return EMPTY_DECORATIONS;
	}
	const byPath = new Map<string, StatusKind>();
	const folders = new Map<string, StatusKind>();
	const untrackedDirs: string[] = [];
	for (const file of files) {
		const kind = decorationKindOf(scmChangeKind(file.x, file.y));
		if (kind === undefined) {
			continue;
		}
		// 古い PC は git が引用したパス（`"a b.txt"`、`"\346\227\245.md"`）をそのまま送るので外す。外し済みの印
		// （`pathsUnquoted`）がある新しい PC のパスは外し直さない（`"` で始まり `"` で終わる本物の名前を壊さない）
		const raw = pathsUnquoted ? file.path : paradisUnquoteGitPath(file.path);
		const isDir = raw.endsWith('/');
		const path = raw.replace(/\/+$/, '');
		if (path.length === 0) {
			continue;
		}
		if (isDir && kind === 'untracked') {
			untrackedDirs.push(path);
		} else {
			byPath.set(path, stronger(byPath.get(path), kind));
		}
		// 自分より上のフォルダへ集める（未追跡のフォルダは自分も含める）
		const segments = path.split('/');
		for (let end = isDir ? segments.length : segments.length - 1; end > 0; end--) {
			const folder = segments.slice(0, end).join('/');
			folders.set(folder, stronger(folders.get(folder), kind));
		}
	}
	return { files: byPath, folders, untrackedDirs };
}

function underUntrackedDir(index: FileDecorationIndex, path: string): boolean {
	return index.untrackedDirs.some(dir => path === dir || path.startsWith(`${dir}/`));
}

function decoration(kind: FileDecorationKind, badge: string | undefined): FileDecoration {
	return { kind, color: GIT_DECORATION_COLORS[kind], badge, label: LABELS[kind] };
}

/**
 * 一覧の 1 行の装飾。状態が無く、無視でもなければ undefined（今までどおりの色）。
 * `ignored` は行の印（自分か祖先が無視されている。`fileTree.ts` の `flattenTree` が継ぐ）。
 */
export function fileDecorationOf(index: FileDecorationIndex, row: { readonly path: string; readonly dir: boolean; readonly ignored?: boolean }): FileDecoration | undefined {
	if (row.dir) {
		const kind = index.folders.get(row.path) ?? index.files.get(row.path) ?? (underUntrackedDir(index, row.path) ? 'untracked' : undefined);
		if (kind !== undefined) {
			return decoration(kind, '•');
		}
	} else {
		const kind = index.files.get(row.path) ?? (underUntrackedDir(index, row.path) ? 'untracked' : undefined);
		if (kind !== undefined) {
			return decoration(kind, LETTERS[kind]);
		}
	}
	return row.ignored === true ? decoration('ignored', undefined) : undefined;
}
