/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ファイル・フォルダの右クリックの共通の項目（Q599 案 A）が、場所ごとに違う形で渡ってくる引数を URI の並びに直す（純関数）。
//
// upstream のファイル系のコマンド（`explorer.download` など）は渡った引数ではなくエクスプローラーの選択を読むので、
// ソース管理・検索などのメニューに足すと別のものに対して動く。fork のコマンドはここで引数を URI に直してから動く。
//
// 場所ごとの引数の形:
// - ソース管理のファイル: 選んだ ISCMResource（`sourceUri`）を並べて渡す（scmViewPane の RepositoryPaneActionRunner）
// - ソース管理のフォルダー: 同じ runner がフォルダーを中のファイルに崩して渡すので、フォルダーの URI は引数に残らない。
//   右クリックで一覧に focus が付く（listWidget の onContextMenu）ので、一覧の focus と選択からフォルダーを取り戻す
// - 検索: 選択があるときは「右クリックした要素」と「選択の配列」、無いときは要素だけ（searchView の onContextMenu）。
//   要素は FileMatch・FolderMatch（`resource`）、行（Match）は `parent()` の FileMatch
// - ブランチの変更点（git 拡張のビュー）: 拡張の側のコマンドが URI の配列にして渡す

import { IResourceNode, ResourceTree } from '../../../../base/common/resourceTree.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

export const enum ParadisFileMenuCommandId {
	OpenToSide = 'paradis.files.openToSide',
	RevealInExplorer = 'paradis.files.revealInExplorer',
	RevealInOS = 'paradis.files.revealInOS',
	OpenInTerminal = 'paradis.files.openInEditorTerminal',
	CopyPath = 'paradis.files.copyPath',
	CopyRelativePath = 'paradis.files.copyRelativePath',
	Download = 'paradis.files.download',
	SendToAgent = 'paradis.files.sendToAgent',
}

/** 右クリックしたときの一覧の focus と選択（`IListService.lastFocusedList` から読んだもの）。 */
export interface IParadisFileMenuList {
	readonly focus: readonly unknown[];
	readonly selection: readonly unknown[];
}

interface IParadisFileMenuElement {
	readonly sourceUri?: unknown;
	readonly resource?: unknown;
	readonly parent?: unknown;
}

/**
 * 1 つの要素の URI。URI そのもの、ソース管理のツリーのフォルダー（ResourceTree の節）、ISCMResource（`sourceUri`）、
 * 検索の FileMatch・FolderMatch・エクスプローラーの項目（`resource`）、検索の行（`parent()` の FileMatch）。
 * 読めないものは undefined。
 */
export function paradisFileMenuElementUri(element: unknown): URI | undefined {
	if (URI.isUri(element)) {
		return element;
	}
	if (ResourceTree.isResourceNode(element)) {
		return element.uri;
	}
	if (typeof element !== 'object' || element === null) {
		return undefined;
	}
	const candidate = element as IParadisFileMenuElement;
	if (URI.isUri(candidate.sourceUri)) {
		return candidate.sourceUri;
	}
	if (URI.isUri(candidate.resource)) {
		return candidate.resource;
	}
	if (typeof candidate.parent === 'function') {
		const parent: unknown = (candidate.parent as () => unknown).call(element);
		const resource = typeof parent === 'object' && parent !== null ? (parent as IParadisFileMenuElement).resource : undefined;
		return URI.isUri(resource) ? resource : undefined;
	}
	return undefined;
}

function distinctUris(uris: readonly URI[]): URI[] {
	const result: URI[] = [];
	for (const uri of uris) {
		if (!result.some(existing => extUri.isEqual(existing, uri))) {
			result.push(uri);
		}
	}
	return result;
}

function urisOf(elements: readonly unknown[]): URI[] {
	const uris: URI[] = [];
	for (const element of elements) {
		const uri = paradisFileMenuElementUri(element);
		if (uri) {
			uris.push(uri);
		}
	}
	return distinctUris(uris);
}

/** ソース管理のツリーのフォルダーの節（中のファイルを持たない節）。 */
function isResourceFolderNode(element: unknown): element is IResourceNode<unknown, unknown> {
	return ResourceTree.isResourceNode<unknown, unknown>(element) && element.element === undefined;
}

/**
 * メニューのコマンドに渡った引数（`args`）と、右クリックした一覧（`list`）から、対象の URI の並びを決める。
 * 重なりは外し、右クリックした順（選択の順）を保つ。
 */
export function paradisResolveFileMenuTargets(args: readonly unknown[], list: IParadisFileMenuList | undefined): URI[] {
	const arrays = args.filter((arg): arg is readonly unknown[] => Array.isArray(arg));
	const singles = args.filter(arg => arg !== undefined && arg !== null && !Array.isArray(arg));

	// 検索: 右クリックした要素が選択の中に無いときは、その要素だけ（選択は別のものを指している）
	let elements: unknown[];
	if (arrays.length > 0 && singles.length > 0 && !arrays.some(array => array.includes(singles[0]))) {
		elements = singles;
	} else {
		elements = [...singles, ...arrays.flat()];
	}
	const argUris = urisOf(elements);

	// ソース管理のフォルダー: 引数はフォルダーの中のファイルに崩れているので、一覧の focus（右クリックした節）から取り戻す
	const focused = list?.focus[0];
	if (list && isResourceFolderNode(focused) && argUris.length > 0) {
		const chosen = list.selection.includes(focused) ? list.selection : [focused];
		const chosenUris = urisOf(chosen);
		if (argUris.every(uri => chosenUris.some(parent => extUri.isEqualOrParent(uri, parent)))) {
			return chosenUris;
		}
	}
	return argUris;
}

/**
 * SSH などの接続先のウィンドウで、git 拡張から `file:` のまま渡ってきた URI を接続先の URI に直す。
 * 手元のウィンドウ（`remoteAuthority` 無し）と、もともと別のスキームの URI はそのまま。
 */
export function paradisToWindowUri(uri: URI, remoteAuthority: string | undefined): URI {
	if (!remoteAuthority || uri.scheme !== Schemas.file) {
		return uri;
	}
	return URI.from({ scheme: Schemas.vscodeRemote, authority: remoteAuthority, path: uri.path });
}

/** ターミナルを開くフォルダー: フォルダーはそのまま、ファイルは親のフォルダー。同じフォルダーは 1 つにまとめる。 */
export function paradisTerminalFolders(targets: readonly { readonly resource: URI; readonly isDirectory: boolean }[]): URI[] {
	return distinctUris(targets.map(target => target.isDirectory ? target.resource : dirname(target.resource)));
}

/** エージェントへ送る文: パスを 1 行に 1 つ。 */
export function paradisFilePathsPrompt(paths: readonly string[]): string {
	return paths.join('\n');
}

/**
 * エージェントへ送る前に「今のスペースの中か」を確かめるための、全部のファイルを含むフォルダー（共通の祖先）。
 * 接続先やスキームが混じるときは undefined（確かめられないので送らない側に倒す）。
 */
export function paradisCommonFolder(uris: readonly URI[]): URI | undefined {
	if (uris.length === 0) {
		return undefined;
	}
	let common = uris.length === 1 ? uris[0] : dirname(uris[0]);
	for (const uri of uris.slice(1)) {
		if (uri.scheme !== common.scheme || uri.authority !== common.authority) {
			return undefined;
		}
		while (!extUri.isEqualOrParent(uri, common)) {
			const parent = dirname(common);
			if (extUri.isEqual(parent, common)) {
				return undefined;
			}
			common = parent;
		}
	}
	return common;
}
