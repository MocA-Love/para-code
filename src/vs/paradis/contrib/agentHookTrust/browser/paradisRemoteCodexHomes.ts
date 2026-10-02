/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { PARADIS_REMOTE_CODEX_HOOK_TRUST_CHANNEL } from '../common/paradisCodexHookTrust.js';

/**
 * 接続先の Codex のホーム（`~/.codex`・`$CODEX_HOME`・ログイン済みのアカウント用のホーム）を
 * 接続先の URI で返す。一覧は接続先（REH）が決める。古い REH で一覧を取れなければ `~/.codex` だけ。
 * 繋がっていなければ空。
 */
export async function paradisRemoteCodexHomes(remoteAgentService: IRemoteAgentService): Promise<URI[]> {
	const connection = remoteAgentService.getConnection();
	const environment = await remoteAgentService.getEnvironment();
	if (connection === null || environment === null) {
		return [];
	}
	const home = environment.userHome;
	const paths = await connection.getChannel(PARADIS_REMOTE_CODEX_HOOK_TRUST_CHANNEL).call<unknown>('listCodexHomes').catch(() => undefined);
	if (!Array.isArray(paths)) {
		return [joinPath(home, '.codex')];
	}
	return paths.filter((path): path is string => typeof path === 'string' && path.startsWith('/')).map(path => home.with({ path }));
}
