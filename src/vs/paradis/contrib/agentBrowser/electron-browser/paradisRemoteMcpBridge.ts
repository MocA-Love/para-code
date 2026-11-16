/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先の Antigravity CLI に para-browser を使わせるための、接続先側の橋渡しの場所。
//
// agy は設定の `${VAR}` を展開しないので、接続先でも Claude Code・Codex のように HTTP の設定へペインのトークンを書けない。
// 手元と同じ stdio のシムを起動させるが、接続先には Para Code 本体が無いので、REH に同梱したシム（`build/next/index.ts` の
// serverEntryPoints）を REH の node で動かす。REH の更新でパスが変わっても、繋ぐたびの設置で書き直す
// （paradisRemoteAgentHooks.contribution.ts）。ここは接続先の環境から 2 つのパスを決めるだけ。

import { joinPath } from '../../../../base/common/resources.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IRemoteAgentEnvironment } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { IParadisRemoteMcpStdioBridgeLocation } from '../common/paradisMcpSetupEncoding.js';

/** REH の中のシムの場所（appRoot から。REH の `out` の下に同じ名前で出る）。 */
const REMOTE_SHIM_SEGMENTS = ['out', 'vs', 'paradis', 'contrib', 'agentBrowser', 'node', 'paradisBrowserMcpShim.js'] as const;

/** 接続先の URI のパスを、接続先の OS の書き方のパスにする（Windows の接続先は `/c:/x` → `c:\x`）。 */
export function paradisRemoteNativePath(uri: URI, os: OperatingSystem): string {
	if (os !== OperatingSystem.Windows) {
		return uri.path;
	}
	return uri.path.replace(/^\/(?=[A-Za-z]:)/, '').replace(/\//g, '\\');
}

/**
 * 接続先の Antigravity CLI に書く橋渡しの場所。
 *
 * @returns 接続先の環境が取れない、または REH にシムが無い（シムを同梱する前の古い REH）ときは undefined。呼び出し側は
 *   接続先の Antigravity CLI の設定を書かない（動かない起動行を残さない）
 */
export async function paradisResolveRemoteMcpBridge(
	environment: () => Promise<IRemoteAgentEnvironment | null | undefined>,
	fileService: IFileService,
): Promise<IParadisRemoteMcpStdioBridgeLocation | undefined> {
	const remote = await environment().catch(() => undefined);
	if (!remote || typeof remote.execPath !== 'string' || remote.execPath.length === 0) {
		return undefined;
	}
	const shim = joinPath(remote.appRoot, ...REMOTE_SHIM_SEGMENTS);
	if (!await fileService.exists(shim)) {
		return undefined;
	}
	return { node: remote.execPath, shimPath: paradisRemoteNativePath(shim, remote.os) };
}
