/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude のアカウントと使用量のチャネルを shared process へ足す。
// `paradis.sharedProcess.contribution.ts` から副作用 import で読み込まれる。
// REH（SSH の接続先）には足さない: 切り替えるのはこの PC の Claude のログインだけで、
// 保存した認証情報もこの PC のキーチェーン（または safeStorage）にしか置かない。

import * as os from 'os';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import * as path from '../../../../base/common/path.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_CLAUDE_ACCOUNTS_CHANNEL } from '../common/paradisClaudeAccounts.js';
import { IParadisClaudeSecretStore, ParadisClaudeAccountRegistry, ParadisEncryptedFileClaudeSecretStore, ParadisKeychainClaudeSecretStore } from './paradisClaudeAccountStore.js';
import { ParadisClaudeAccountService, ParadisClaudeAccountsChannel } from './paradisClaudeAccountService.js';
import { ParadisSecurityCliKeychain } from './paradisClaudeKeychain.js';
import { ParadisClaudeLiveAuth } from './paradisClaudeLiveAuth.js';
import { ParadisClaudeCliLoginRunner } from './paradisClaudeLogin.js';
import { ParadisClaudeOAuthClient } from './paradisClaudeOAuthClient.js';

function currentUserName(): string | undefined {
	if (process.env['USER']) {
		return process.env['USER'];
	}
	try {
		return os.userInfo().username;
	} catch {
		return undefined;
	}
}

ParadisSharedProcessContributions.register('claudeAccounts', ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const environmentService = accessor.get(INativeEnvironmentService);
	const mainProcessService = accessor.get(IMainProcessService);
	// `claude` を探すのと動かすのに、ログインシェルの環境（PATH など）を使う。
	const shellEnv = new ParadisCachedShellEnv(
		logService,
		'ParadisClaudeAccounts',
		createParadisShellEnvResolver(logService, accessor.get(IConfigurationService), environmentService.args),
		Date.now,
		reportParadisShellEnvDiagnosticError,
	);

	const platform = process.platform;
	const keychain = platform === 'darwin' ? new ParadisSecurityCliKeychain() : undefined;
	const storageDir = path.join(environmentService.userDataPath, 'paradis-claude-accounts');
	const secrets: IParadisClaudeSecretStore = keychain
		? new ParadisKeychainClaudeSecretStore(keychain)
		: new ParadisEncryptedFileClaudeSecretStore(
			path.join(storageDir, 'secrets'),
			ProxyChannel.toService<IEncryptionService>(mainProcessService.getChannel('encryption')),
			platform,
		);

	const service = new ParadisClaudeAccountService({
		liveAuth: new ParadisClaudeLiveAuth({ homedir: os.homedir(), platform, keychain, userName: currentUserName() }),
		registry: new ParadisClaudeAccountRegistry(path.join(storageDir, 'accounts.json'), platform),
		secrets,
		oauth: new ParadisClaudeOAuthClient(),
		logService,
		loginRunner: new ParadisClaudeCliLoginRunner(() => shellEnv.getEnv(), os.homedir(), message => logService.trace(`[ParadisClaudeAccounts] ${message}`)),
	});
	server.registerChannel(PARADIS_CLAUDE_ACCOUNTS_CHANNEL, new ParadisClaudeAccountsChannel(service));
	return service;
});
