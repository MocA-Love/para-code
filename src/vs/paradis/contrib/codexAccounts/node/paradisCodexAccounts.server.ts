/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先（REH）へ Codex のアカウント切替のチャネルを足す。`paradis.server.contribution.ts` から
// 副作用 import で読み込まれる。
//
// 接続先の Codex は接続先のホーム（~/.codex、~/.codex-2 …）で動くので、選び先も接続先のホームになる。
// 選択・リセットクレジットの台帳・会話ログの共有の記録は接続先のユーザーデータに置き、同じ接続先へ
// 繋いだ全ウィンドウで共通にする（この PC の選択とは別）。認証情報（各ホームの auth.json）は
// 接続先から動かさない。
//
// 利用者の設定（APPLICATION）は REH からは読めないので、会話ログを共有するかはウィンドウが問い合わせの
// たびに添える値を使う。まだ届いていない間（接続直後の起動時のリンク）は既定どおり共有する。

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { ParadisServerContributions } from '../../../common/paradisProcessContributions.js';
import { paradisEnableCodexAccountHomes } from '../../agentBrowser/node/paradisAgentHome.js';
import { PARADIS_CODEX_ACCOUNTS_CHANNEL } from '../common/paradisCodexAccounts.js';
import { ParadisCodexAccountsChannel } from './paradisCodexAccountsChannel.js';
import { ParadisCodexAccountsService } from './paradisCodexAccountsService.js';

ParadisServerContributions.register('codexAccounts', ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const environmentService = accessor.get(INativeEnvironmentService);
	// 接続先でもアカウント用ホーム（~/.codex-2 等）を扱う。会話の再開一覧・タブ名・AI コストなど、
	// 接続先で paradisCodexHomes() を見るものも手元と同じ範囲を見るようになる。設定で足したホーム
	// （paradis.limitsMonitor.codexHomes）は手元のパスなので、接続先では使わない。
	paradisEnableCodexAccountHomes();
	let shareConversations = true;
	const store = new DisposableStore();
	const service = store.add(new ParadisCodexAccountsService({
		logService,
		stateDirectory: join(environmentService.userDataPath, 'paradis', 'codexAccounts'),
		resolveEnv: async () => ({ ...process.env }),
		shareConversations: () => shareConversations,
	}));
	server.registerChannel(PARADIS_CODEX_ACCOUNTS_CHANNEL, new ParadisCodexAccountsChannel<RemoteAgentConnectionContext>(service, undefined, preferences => {
		shareConversations = preferences.shareConversations;
	}));
	return store;
});
