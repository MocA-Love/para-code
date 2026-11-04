/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { OperatingSystem } from '../../../../base/common/platform.js';
import type { URI } from '../../../../base/common/uri.js';

/**
 * 接続先の URI を、接続先のOSで通用する絶対パスへ直す。
 *
 * `URI.fsPath` は「このPCのOS」で区切りを決めるので、Windows のPCから Linux へ繋いでいると
 * `/home/u/x` が `\home\u\x` になり、接続先のエージェントが開けないパスになる。
 * （モバイルの添付の置き場 `paradisMobileWorkspaceProvider.ts` と、絶対パスの口 `paradisMobileAbsolutePathRequests.ts` が使う）
 */
export function paradisRemoteAbsolutePath(uri: URI, os: OperatingSystem): string {
	if (os !== OperatingSystem.Windows) {
		return uri.path;
	}
	// Windows のパスは URI 上では `/c:/Users/...` の形で載っている
	const path = /^\/[A-Za-z]:/.test(uri.path) ? uri.path.slice(1) : uri.path;
	return path.replace(/\//g, '\\');
}
