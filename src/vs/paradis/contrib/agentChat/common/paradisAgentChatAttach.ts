/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// チャット表示の入力欄の ＋ で、エージェントに添えるファイルを選ぶ画面の決まり。

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IOpenDialogOptions } from '../../../../platform/dialogs/common/dialogs.js';

/** エージェントが動く場所のファイルの仕組み。SSH などの接続先の窓では接続先、それ以外は手元。 */
function agentFileScheme(remoteAuthority: string | undefined): string {
	return remoteAuthority !== undefined ? Schemas.vscodeRemote : Schemas.file;
}

/**
 * ファイルを選ぶ画面の指定。選べるのはエージェントが動く場所のファイルだけにする（接続先の窓で手元のファイルを
 * 選ぶと、接続先のエージェントが読めない手元のパスが入るため）。Windows と Linux はファイルとフォルダを同じ画面で
 * 選べない（両方を許すとフォルダだけの画面になる）ので、ファイルだけにする。
 */
export function paradisAgentChatAttachDialogOptions(remoteAuthority: string | undefined, title: string): IOpenDialogOptions {
	return {
		title,
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: true,
		availableFileSystems: [agentFileScheme(remoteAuthority)],
	};
}

/** 選んだファイルを、エージェントの入力欄へ入れるパスにする。エージェントが動く場所のもの以外は捨てる。 */
export function paradisAgentChatAttachPaths(uris: readonly URI[], remoteAuthority: string | undefined): string[] {
	const scheme = agentFileScheme(remoteAuthority);
	return uris.filter(uri => uri.scheme === scheme).map(uri => scheme === Schemas.file ? uri.fsPath : uri.path);
}
