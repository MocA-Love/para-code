/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先（REH）へ Claude のアカウントのチャネルを足す。`paradis.server.contribution.ts` から副作用
// import で読み込まれる。
//
// 接続先の Claude Code は接続先のログイン（`~/.claude/.credentials.json` と `~/.claude.json`）で動くので、
// 切り替えるのも接続先のログイン。手元（shared process）と同じ ParadisClaudeAccountService を動かし、
// 登録したアカウントは接続先のユーザーデータに置く（接続先ごとに独立。同じ接続先へ繋いだ全ウィンドウで共通）。
//
//  - 認証情報は本人だけが読めるファイルに平文で置く（ParadisPlainFileClaudeSecretStore。REH には
//    safeStorage も鍵の保管サービスも無い。Claude Code 自身の `.credentials.json` と同じ保護）
//  - 認証情報は接続先から出さない（手元へ返すのは使用率・メールアドレスなど、手元と同じ表示の値だけ）
//  - 更新の前後の REH が同じユーザーデータを読み書きする間があるので、書き換えはプロセスをまたいだ
//    ロックの中で行う（crossProcessLockPath）
//  - 使用量は、接続先のいまのログインの分もこのサービスが取る。読み取り専用の ParadisClaudeHostUsage
//    （スマホが接続先のログインを見るときの口）は、このサービスの結果を使う
//
// 切り替えに対応しないとき（ログインがキーチェーンにある macOS の接続先、`CLAUDE_CONFIG_DIR` で既定と
// 違う設定フォルダを使っている接続先）は、`unsupportedOnHost` だけを返す。ウィンドウは従来どおり
// 接続先のいまのログインを読み取り専用で出す。

import * as os from 'os';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import * as path from '../../../../base/common/path.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { ParadisServerContributions } from '../../../common/paradisProcessContributions.js';
import { IParadisClaudeAccountsState, PARADIS_CLAUDE_ACCOUNTS_CHANNEL } from '../common/paradisClaudeAccounts.js';
import { ParadisClaudeAccountRegistry, ParadisPlainFileClaudeSecretStore } from './paradisClaudeAccountStore.js';
import { ParadisClaudeAccountService, ParadisClaudeAccountsChannel } from './paradisClaudeAccountService.js';
import { paradisSetClaudeHostStateSource } from './paradisClaudeHostUsage.js';
import { ParadisClaudeLiveAuth } from './paradisClaudeLiveAuth.js';
import { ParadisClaudeCliLoginRunner } from './paradisClaudeLogin.js';
import { ParadisClaudeOAuthClient } from './paradisClaudeOAuthClient.js';

/**
 * 接続先で切り替えに対応するか。ログインが `~/.claude/.credentials.json` にある（macOS 以外）ことと、
 * Claude Code が既定の設定フォルダを使うこと（REH の環境の `CLAUDE_CONFIG_DIR` が無いか既定と同じ）。
 */
export function paradisClaudeHostSwitchingSupported(platform: NodeJS.Platform, homedir: string, configDir: string | undefined): boolean {
	if (platform === 'darwin') {
		return false;
	}
	return configDir === undefined || configDir.length === 0 || path.resolve(configDir) === path.join(homedir, '.claude');
}

/** 切り替えに対応しない接続先の答え（ウィンドウは読み取り専用の表示に戻る）。 */
class ParadisUnsupportedClaudeAccountsChannel implements IServerChannel<RemoteAgentConnectionContext> {

	listen<T>(_ctx: RemoteAgentConnectionContext, event: string): Event<T> {
		if (event === 'onDidChangeState') {
			return Event.None;
		}
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: RemoteAgentConnectionContext, command: string): Promise<T> {
		if (command === 'getState') {
			const state: IParadisClaudeAccountsState = { claude: { accounts: [] }, switching: false, unsupportedOnHost: true };
			return Promise.resolve(state as T);
		}
		return Promise.reject(new Error('Claude account switching is not supported on this host'));
	}
}

/** claude-swap のデータのフォルダの候補（手元と同じ規則。移行の案内のために読むだけ）。 */
function legacyCswapDirs(homedir: string): string[] {
	const legacy = path.join(homedir, '.claude-swap-backup');
	const xdg = process.env['XDG_DATA_HOME'];
	const xdgDir = xdg && path.isAbsolute(xdg) ? path.join(xdg, 'claude-swap') : path.join(homedir, '.local', 'share', 'claude-swap');
	return [xdgDir, legacy];
}

ParadisServerContributions.register('claudeAccounts', ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const environmentService = accessor.get(INativeEnvironmentService);
	const homedir = os.homedir();
	if (!paradisClaudeHostSwitchingSupported(process.platform, homedir, process.env['CLAUDE_CONFIG_DIR'])) {
		server.registerChannel(PARADIS_CLAUDE_ACCOUNTS_CHANNEL, new ParadisUnsupportedClaudeAccountsChannel());
		return undefined;
	}
	const store = new DisposableStore();
	const storageDir = path.join(environmentService.userDataPath, 'paradis-claude-accounts');
	const service = store.add(new ParadisClaudeAccountService({
		liveAuth: new ParadisClaudeLiveAuth({ homedir, platform: process.platform, keychain: undefined, userName: undefined }),
		registry: new ParadisClaudeAccountRegistry(path.join(storageDir, 'accounts.json')),
		secrets: new ParadisPlainFileClaudeSecretStore(path.join(storageDir, 'secrets')),
		oauth: new ParadisClaudeOAuthClient(),
		logService,
		loginRunner: new ParadisClaudeCliLoginRunner(async () => ({ ...process.env }), homedir, message => logService.trace(`[ParadisClaudeAccounts] ${message}`)),
		legacyCswapDirs: legacyCswapDirs(homedir),
		crossProcessLockPath: path.join(storageDir, '.mutation.lock'),
	}));
	store.add(paradisSetClaudeHostStateSource(request => service.getState(request)));
	server.registerChannel(PARADIS_CLAUDE_ACCOUNTS_CHANNEL, new ParadisClaudeAccountsChannel<RemoteAgentConnectionContext>(service));
	return store;
});
