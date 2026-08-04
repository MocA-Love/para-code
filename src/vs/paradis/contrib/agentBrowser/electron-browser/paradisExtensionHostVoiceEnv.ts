/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 拡張機能ホストの環境へ、音声取込（aivis→Para Code→スマホ）の宛先を注入するヘルパー。
// localProcessExtensionHost.ts の PARA-PATCH 1行から呼ばれる。
//
// 背景: ターミナルのペインで動くエージェントCLIには paradisPaneTokenService がペイントークンと
// ポートファイルパスを注入しているが、拡張機能から起動されるエージェント（ChatGPT拡張のCodex等）は
// 拡張機能ホストの子プロセスなので、その環境を一切受け取れなかった。結果として、そこから起動された
// aivis MCP は宛先のPara Codeを特定できず、生成した音声をPCへ渡せない（PCでは鳴るがスマホへ届かない）。
//
// ペイントークンはペインの所有権を持つため拡張機能ホストへは渡さない。代わりに音声取込だけに使える
// インスタンススコープのトークンを shared process から受け取って渡す。

import { join } from '../../../../base/common/path.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { PARADIS_AGENT_BROWSER_CHANNEL, PARADIS_MCP_PORT_FILE_ENV_VAR, PARADIS_MCP_PORT_FILE_NAME, PARADIS_VOICE_TOKEN_ENV_VAR } from '../common/paradisAgentBrowser.js';

/**
 * 拡張機能ホストへ渡す環境変数へ、ポートファイルのパスと音声取込トークンを足す。
 * 取得に失敗しても拡張機能ホストの起動は止めない（音声がスマホへ届かないだけ）。
 */
export async function paradisApplyExtensionHostVoiceEnv(
	env: Record<string, unknown>,
	userDataPath: string,
	sharedProcessService: ISharedProcessService,
): Promise<void> {
	if (userDataPath.length === 0) {
		return;
	}
	try {
		const token = await sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call<string>('getVoiceIngressToken');
		if (typeof token !== 'string' || token.length === 0) {
			return;
		}
		env[PARADIS_MCP_PORT_FILE_ENV_VAR] = join(userDataPath, PARADIS_MCP_PORT_FILE_NAME);
		env[PARADIS_VOICE_TOKEN_ENV_VAR] = token;
	} catch {
		// shared processが未起動・切断中でも拡張機能ホストは通常どおり起動させる。
	}
}
