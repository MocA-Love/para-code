// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { copyAction, type ContextMenuAction, type ContextMenuOps, type ContextMenuSpec } from '../../components/contextMenuModel.js';
import { baseName } from './fileTree.js';

/**
 * ファイル一覧・ソース管理・コミット・差分の行の長押しのメニュー（Q548 案 A。資料 6 章・7 章）。
 * 見出しは相対パス。パスはスペースのフォルダの根からの相対（`/` 区切り）。
 */

/**
 * 「絶対パスをコピー」の項目の状態（`useAbsolutePath.ts` が決める）。絶対パスは押したときに PC へ 1 回問い合わせ、
 * メニューにも端末にも残さない（補足には「PC 上のパス」などの説明だけを出す）。
 */
export type AbsolutePathOption =
	| { readonly kind: 'available'; readonly hint: string; readonly load: () => Promise<string> }
	/** PC が `fs.absolute-path.v1` を広告していない（古い Para Code）。 */
	| { readonly kind: 'unsupported' }
	/** PC につながっていない・スペースの画面が準備中。 */
	| { readonly kind: 'offline' };

/** 古い PC のときの補足。 */
export const ABSOLUTE_PATH_UNSUPPORTED_HINT = 'PC の Para Code を更新すると使えます';
const ABSOLUTE_PATH_OFFLINE_HINT = 'PC につながると使えます';

/**
 * フォルダの「このフォルダを検索」の状態。PC が `fs.find-dir.v1` を広告していなければ `supported: false`（薄くして
 * 「PC の Para Code を更新すると使えます」と添える）。
 */
export interface FolderSearchOption {
	readonly supported: boolean;
	readonly run: () => void;
}

/** ファイル・フォルダの行（ファイル一覧のツリー・名前の検索の結果）。`searchIn` はフォルダのときだけ使う。 */
export function buildFileMenu(input: { readonly path: string; readonly dir: boolean; readonly absolute?: AbsolutePathOption; readonly searchIn?: FolderSearchOption }, ops: ContextMenuOps & { readonly open?: () => void }): ContextMenuSpec {
	const actions: ContextMenuAction[] = [...pathCopyActions(input.path, ops, input.absolute)];
	if (ops.open !== undefined) {
		actions.push({ id: 'open', title: input.dir ? '開く' : 'ファイルを開く', icon: 'open', startsSection: true, onSelect: ops.open });
	}
	const searchIn = input.dir ? input.searchIn : undefined;
	if (searchIn !== undefined) {
		actions.push(searchIn.supported
			? { id: 'search-dir', title: 'このフォルダを検索', icon: 'search', startsSection: ops.open === undefined, onSelect: searchIn.run }
			: { id: 'search-dir', title: 'このフォルダを検索', icon: 'search', startsSection: ops.open === undefined, disabled: true, subtitle: ABSOLUTE_PATH_UNSUPPORTED_HINT });
	}
	actions.push({ id: 'share', title: '共有…', icon: 'share', startsSection: ops.open === undefined && searchIn === undefined, onSelect: () => ops.share(input.path) });
	return { title: input.path, actions };
}

/** 内容の検索の結果の行（パス:行番号）。 */
export function buildGrepMatchMenu(input: { readonly path: string; readonly line: number; readonly text: string; readonly absolute?: AbsolutePathOption }, ops: ContextMenuOps & { readonly open: () => void }): ContextMenuSpec {
	const location = `${input.path}:${input.line}`;
	return {
		title: location,
		actions: [
			...pathCopyActions(input.path, ops, input.absolute),
			copyAction(ops, { id: 'copy-location', title: 'パス:行番号をコピー', subtitle: location, icon: 'line', text: location, toast: 'パスと行番号をコピーしました' }),
			copyAction(ops, { id: 'copy-line', title: 'この行をコピー', icon: 'copy', text: input.text, toast: '行をコピーしました' }),
			{ id: 'open', title: 'ファイルを開く', icon: 'open', startsSection: true, onSelect: ops.open },
		],
	};
}

/** ソース管理の変更の行。 */
export function buildScmFileMenu(input: { readonly path: string; readonly staged?: boolean; readonly absolute?: AbsolutePathOption }, ops: ContextMenuOps & { readonly openDiff: () => void; readonly toggleStage?: () => void }): ContextMenuSpec {
	const actions: ContextMenuAction[] = [
		...pathCopyActions(input.path, ops, input.absolute),
		{ id: 'diff', title: '差分を開く', icon: 'diff', startsSection: true, onSelect: ops.openDiff },
	];
	if (ops.toggleStage !== undefined) {
		actions.push(input.staged === true
			? { id: 'unstage', title: 'ステージを外す', icon: 'unstage', onSelect: ops.toggleStage }
			: { id: 'stage', title: 'ステージ', icon: 'stage', onSelect: ops.toggleStage });
	}
	actions.push({ id: 'share', title: '共有…', icon: 'share', onSelect: () => ops.share(input.path) });
	return { title: input.path, actions };
}

/** 短いハッシュの桁（履歴の行に出している桁と同じ）。 */
export const SHORT_HASH_LENGTH = 7;

/** コミットの履歴の行。 */
export function buildCommitMenu(input: { readonly hash: string; readonly subject: string }, ops: ContextMenuOps & { readonly openWeb?: () => void }): ContextMenuSpec {
	const short = input.hash.slice(0, SHORT_HASH_LENGTH);
	const actions: ContextMenuAction[] = [
		copyAction(ops, { id: 'copy-hash', title: 'ハッシュをコピー', subtitle: input.hash.length > 11 ? `${input.hash.slice(0, 11)}…` : input.hash, icon: 'hash', text: input.hash, toast: 'ハッシュをコピーしました' }),
		copyAction(ops, { id: 'copy-short-hash', title: '短いハッシュをコピー', subtitle: short, icon: 'hash', text: short, toast: '短いハッシュをコピーしました' }),
		copyAction(ops, { id: 'copy-subject', title: '件名をコピー', icon: 'subject', text: input.subject, toast: '件名をコピーしました' }),
	];
	if (ops.openWeb !== undefined) {
		actions.push({ id: 'browser', title: 'ブラウザで開く', icon: 'browser', startsSection: true, onSelect: ops.openWeb });
	}
	return { title: input.subject, actions };
}

/** コミットの中のファイルの行。 */
export function buildCommitFileMenu(input: { readonly path: string; readonly absolute?: AbsolutePathOption }, ops: ContextMenuOps): ContextMenuSpec {
	return { title: input.path, actions: pathCopyActions(input.path, ops, input.absolute) };
}

/**
 * 差分レビューの行。今の長押しの「この行にメモを書く」を先頭に置く（メニューを挟んで 1 手増える分、すぐ届く位置に）。
 * `line` は新しい側の行番号（消した行など、番号の無い行では `undefined`）。
 */
export function buildDiffLineMenu(input: { readonly path: string; readonly line: number | undefined; readonly text: string }, ops: ContextMenuOps & { readonly writeNote?: () => void }): ContextMenuSpec {
	const actions: ContextMenuAction[] = [];
	if (ops.writeNote !== undefined) {
		actions.push({ id: 'note', title: 'この行にメモを書く', icon: 'note', onSelect: ops.writeNote });
	}
	actions.push(copyAction(ops, { id: 'copy-line', title: 'この行をコピー', icon: 'copy', startsSection: ops.writeNote !== undefined, text: input.text, toast: '行をコピーしました' }));
	if (input.line !== undefined) {
		const location = `${input.path}:${input.line}`;
		actions.push(copyAction(ops, { id: 'copy-location', title: 'パス:行番号をコピー', subtitle: location, icon: 'line', text: location, toast: 'パスと行番号をコピーしました' }));
	}
	return { actions };
}

/**
 * 会話の中のツールのファイルのカード（Read・Edit の対象）。パスはエージェントが渡したまま（多くは PC 上の絶対パス）
 * なので、「相対パス」とは呼ばない。
 */
export function buildToolFileMenu(input: { readonly path: string }, ops: ContextMenuOps & { readonly open: () => void }): ContextMenuSpec {
	const name = baseName(input.path.replace(/\\/g, '/')) || input.path;
	return {
		title: input.path,
		actions: [
			copyAction(ops, { id: 'copy-name', title: '名前をコピー', subtitle: name, icon: 'name', text: name, toast: '名前をコピーしました' }),
			copyAction(ops, { id: 'copy-path', title: 'パスをコピー', subtitle: input.path, icon: 'path', text: input.path, toast: 'パスをコピーしました' }),
			{ id: 'open', title: 'ファイルを開く', icon: 'open', startsSection: true, onSelect: ops.open },
		],
	};
}

/**
 * ファイルビューアの Markdown・HTML の中に書かれたパス（`viewerPathLinks.ts`）。スペースの中のファイルへ解決できたら
 * ファイルの一覧の行と同じ「名前・相対パス・絶対パスをコピー」と「ファイルを開く」。解決できなければ、書いてあるままの
 * パス（行番号は除く）を写すだけにして、開けない理由を「ファイルを開く」の補足に出す。
 */
export function buildViewerPathLinkMenu(
	input: { readonly written: string; readonly path: string; readonly resolved?: string; readonly absolute?: AbsolutePathOption; readonly failure?: string },
	ops: ContextMenuOps & { readonly open: () => void },
): ContextMenuSpec {
	if (input.resolved !== undefined) {
		return {
			title: input.written,
			actions: [
				...pathCopyActions(input.resolved, ops, input.absolute),
				{ id: 'open', title: 'ファイルを開く', icon: 'open', startsSection: true, onSelect: ops.open },
			],
		};
	}
	const name = baseName(input.path.replace(/\\/g, '/')) || input.path;
	return {
		title: input.written,
		actions: [
			copyAction(ops, { id: 'copy-name', title: '名前をコピー', subtitle: name, icon: 'name', text: name, toast: '名前をコピーしました' }),
			copyAction(ops, { id: 'copy-path', title: 'パスをコピー', subtitle: input.path, icon: 'path', text: input.path, toast: 'パスをコピーしました' }),
			{ id: 'open', title: 'ファイルを開く', icon: 'open', startsSection: true, disabled: true, ...(input.failure !== undefined ? { subtitle: input.failure } : {}) },
		],
	};
}

/** 名前・相対パス（・絶対パス）のコピー（どの行でも先頭に並べる）。 */
function pathCopyActions(path: string, ops: ContextMenuOps, absolute: AbsolutePathOption | undefined): ContextMenuAction[] {
	const name = baseName(path) || path;
	const actions = [
		copyAction(ops, { id: 'copy-name', title: '名前をコピー', subtitle: name, icon: 'name', text: name, toast: '名前をコピーしました' }),
		copyAction(ops, { id: 'copy-relative', title: '相対パスをコピー', subtitle: path, icon: 'path', text: path, toast: '相対パスをコピーしました' }),
	];
	if (absolute !== undefined) {
		actions.push(absolutePathAction(absolute, ops));
	}
	return actions;
}

function absolutePathAction(absolute: AbsolutePathOption, ops: ContextMenuOps): ContextMenuAction {
	const base = { id: 'copy-absolute', title: '絶対パスをコピー', icon: 'absolutePath' as const };
	if (!ops.canCopy) {
		return copyAction(ops, { ...base, text: '', toast: '' });
	}
	switch (absolute.kind) {
		case 'available':
			return { ...base, subtitle: absolute.hint, onSelect: () => ops.copyLater(absolute.load, '絶対パスをコピーしました') };
		case 'unsupported':
			return { ...base, subtitle: ABSOLUTE_PATH_UNSUPPORTED_HINT, disabled: true };
		case 'offline':
			return { ...base, subtitle: ABSOLUTE_PATH_OFFLINE_HINT, disabled: true };
	}
}
