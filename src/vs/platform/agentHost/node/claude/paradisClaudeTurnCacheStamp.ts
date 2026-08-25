/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { IParadisTurnCacheStamp } from '../paradisTurnCache.js';
import type { IClaudeAgentSdkService } from './claudeAgentSdkService.js';

/**
 * Cheap fingerprint of the SDK transcript backing `sdkSessionId`, used to
 * validate a {@link IParadisTurnCacheStamp}-keyed lookup without paying for a
 * full `getSessionMessages` read. `getSessionInfo` reads only the single
 * session file (never the whole project), so it stays far cheaper than the
 * read it lets a cache hit skip. Returns `undefined` — never throws — so a
 * lookup/enumeration failure just falls through to the full read.
 */
export async function paradisClaudeTurnCacheStamp(sdkService: Pick<IClaudeAgentSdkService, 'getSessionInfo'>, sdkSessionId: string): Promise<IParadisTurnCacheStamp | undefined> {
	try {
		const info = await sdkService.getSessionInfo(sdkSessionId);
		if (info?.fileSize === undefined) {
			return undefined;
		}
		return { size: info.fileSize, mtimeMs: info.lastModified };
	} catch {
		return undefined;
	}
}
