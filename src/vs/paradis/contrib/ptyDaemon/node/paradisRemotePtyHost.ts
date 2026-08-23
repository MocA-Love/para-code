/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH 先で常駐を使うかどうかを決める。
//
// **ローカルとの違いはここだけ。** 常駐の中身も、繋ぎ方も、引き取りも、すべて同じコードが動く。
// リモートでは「アプリ側」が REH サーバーで、常駐と同じ機械の上に居るため、pid から題名や cwd を
// 引く処理もそのまま成立する。
//
// リモートでターミナルが消える理由は、pty をサーバーが持っていることにある。サーバーはコミット
// ごとに配られるので、アプリを更新すると**別のサーバー**が入り、ターミナルは古い方に取り残される。
// 常駐へ出しておけば、サーバーが入れ替わっても走り続ける。
//
// **必ず踏む落とし穴が1つある。** systemd の `KillUserProcesses` が既定で有効な配布物では、
// SSH を切った瞬間に切り離した常駐ごと殺される（tmux が落ちるのと同じ現象）。
// `loginctl enable-linger` か `systemd-run --user --unit=` でユーザー単位のスコープへ入れないと、
// この機能はその手の機械では**成立しない**。判定も対処もまだ入っていないので、
// リモートで有効にする前にここを埋めること。
//
// 同じ理由で `XDG_RUNTIME_DIR` は使わない（最後のセッションが終わると消える）。置き場所は
// サーバーのデータディレクトリの下（`paradisPtyHostPaths.ts`）。

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PARADIS_PTY_HOST_DAEMON_ENABLED } from '../common/paradisPtyDaemonSettingKey.js';
import { PARADIS_PTY_HOST_STATE_DIR } from '../common/paradisPtyHostPaths.js';

/**
 * 有効なら、pty ホストへ置き場所を渡す。
 *
 * 渡すのは環境変数1つだけ。pty ホストはこのプロセスの子として起き、`process.env` を引き継ぐ
 * (`ipc.cp` の `Client` が `{ ...process.env, ... }` で組み立てる)。**ローカルの Electron でも
 * 同じ性質**なので、渡し方を1つに揃えられる。
 */
export function paradisEnableRemotePtyHostDaemon(
	configurationService: IConfigurationService,
	stateDir: string,
	logService: ILogService,
): void {
	if (configurationService.getValue(PARADIS_PTY_HOST_DAEMON_ENABLED) !== true) {
		return;
	}
	process.env[PARADIS_PTY_HOST_STATE_DIR] = stateDir;
	logService.info(`[ParadisPtyHost] terminals on this server may outlive it; state lives under ${stateDir}`);
}
