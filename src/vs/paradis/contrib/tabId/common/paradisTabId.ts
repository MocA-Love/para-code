/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタのタブの「タブ ID をコピー」で書く 1 行（`paraTabId: <種類>:<値>`）の組み立てと読み取り。
// エージェントは貼られた行を見て、種類に応じた para-browser MCP の道具へ値を渡す（読み方は
// read_para_code_guide の案内に書く。paradisAgentIdeGuide.ts）。値はどれも既存の道具が受け取る ID そのもの:
//  - terminal: list_terminals の id（ペイントークンのハッシュ。トークンそのものは載せない）
//  - browser: list_browser_tabs の tabId（ブラウザビューの ID）
//  - simulator: mobile_list_devices の id（`ios:core-simulator:<udid>`・`android:serial:<serial>`）
//  - file: スペースのフォルダから見た相対パス（フォルダの外なら絶対パス）

import { Schemas } from '../../../../base/common/network.js';
import { isEqualOrParent, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

/** 行の頭。 */
export const PARADIS_TAB_ID_PREFIX = 'paraTabId:';

export type ParadisTabIdKind = 'terminal' | 'browser' | 'simulator' | 'file';

export interface IParadisTabId {
	readonly kind: ParadisTabIdKind;
	readonly value: string;
}

const KINDS: ReadonlySet<string> = new Set<ParadisTabIdKind>(['terminal', 'browser', 'simulator', 'file']);
const LINE = /^paraTabId:\s*(?<kind>[a-z]+):(?<value>.+)$/;

/** コピーする 1 行。値に改行や制御文字が混ざっていれば作らない（1 行で貼れることを守る）。 */
export function paradisFormatTabId(id: IParadisTabId): string | undefined {
	if (!id.value || /[\u0000-\u001f\u007f]/.test(id.value)) {
		return undefined;
	}
	return `${PARADIS_TAB_ID_PREFIX} ${id.kind}:${id.value}`;
}

/** 貼られた 1 行を読む。形が違えば undefined。 */
export function paradisParseTabId(text: string): IParadisTabId | undefined {
	const match = LINE.exec(text.trim());
	const kind = match?.groups?.kind;
	const value = match?.groups?.value.trim();
	if (!kind || !value || !KINDS.has(kind)) {
		return undefined;
	}
	return { kind: kind as ParadisTabIdKind, value };
}

/**
 * ファイルのタブの値。ディスク上のファイル（手元の `file`、SSH の窓の接続先の `vscode-remote`）だけを指せる。
 * スペースのフォルダの中なら相対パス、外なら絶対パス。untitled などパスで指せないものは undefined。
 */
export function paradisTabIdFilePath(resource: URI, folder: URI | undefined): string | undefined {
	if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote) {
		return undefined;
	}
	if (folder && folder.scheme === resource.scheme && folder.authority === resource.authority && isEqualOrParent(resource, folder)) {
		const relative = relativePath(folder, resource);
		if (relative) {
			return relative;
		}
	}
	return resource.scheme === Schemas.file ? resource.fsPath : resource.path;
}
