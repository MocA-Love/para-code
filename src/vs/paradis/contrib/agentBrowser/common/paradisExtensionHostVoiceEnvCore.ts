/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { raceTimeout } from '../../../../base/common/async.js';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PARADIS_MCP_PORT_FILE_ENV_VAR, PARADIS_MCP_PORT_FILE_NAME, PARADIS_VOICE_TOKEN_ENV_VAR } from './paradisAgentBrowser.js';

/**
 * 音声取込トークンを待つ上限。拡張機能ホストの起動はこの値を待つので、shared process の準備が
 * 失敗して返事が来ないときに拡張機能が 1 つも起動しなくならないよう、短く打ち切る。
 */
export const PARADIS_EXTENSION_HOST_VOICE_TOKEN_TIMEOUT_MS = 2_000;

/**
 * 拡張機能ホストへ渡す環境変数へ、ポートファイルのパスと音声取込トークンを足す。
 * 取得に失敗した・期限までに返らなかったときは何も足さずに戻る（音声がスマホへ届かないだけ）。
 * 期限で打ち切ったときはログに 1 行残す（Sentry には送らない）。
 */
export async function paradisApplyVoiceEnv(
	env: Record<string, unknown>,
	userDataPath: string,
	getVoiceIngressToken: () => Promise<unknown>,
	logService: ILogService,
	timeoutMs: number = PARADIS_EXTENSION_HOST_VOICE_TOKEN_TIMEOUT_MS,
): Promise<void> {
	if (userDataPath.length === 0) {
		return;
	}
	try {
		const token = await raceTimeout(getVoiceIngressToken(), timeoutMs, () => logService.warn(`[paradisVoiceEnv] the shared process did not return the voice ingress token in ${timeoutMs}ms; starting the extension host without it`));
		if (typeof token !== 'string' || token.length === 0) {
			return;
		}
		env[PARADIS_MCP_PORT_FILE_ENV_VAR] = join(userDataPath, PARADIS_MCP_PORT_FILE_NAME);
		env[PARADIS_VOICE_TOKEN_ENV_VAR] = token;
	} catch {
		// shared processが未起動・切断中でも拡張機能ホストは通常どおり起動させる。
	}
}
