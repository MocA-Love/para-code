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
// systemd の `KillUserProcesses` が有効な機械では、SSH を切った瞬間にそのログインのプロセスが
// まとめて殺される（tmux が落ちるのと同じ現象）。常駐はサーバーの pty ホストから起こされ、
// サーバーと同じログインのスコープに入るので、**サーバーが SSH の切断を生き延びる機械なら常駐も
// 生き延び、サーバーが殺される機械なら常駐も殺される**。常駐が状況を悪くすることはない
// （そういう機械では upstream の SSH の再接続もそもそも成り立たない）。Ubuntu・Debian の既定は
// 無効。`loginctl enable-linger` を有効にした機械でも成り立つ。
//
// **Windows の接続先では使わない。** 手元と同じ理由（名前付きパイプの偽装をこちらで塞げない。
// `paradisPtyHostStarterFactory.ts`）に加えて、常駐の端末は ConPTY も Windows 専用の引数の形も
// 扱わない（`paradisDaemonTerminalProcess.ts`）。
//
// 同じ理由で `XDG_RUNTIME_DIR` は使わない（最後のセッションが終わると消える）。置き場所は
// サーバーのデータディレクトリの下（`paradisPtyHostPaths.ts`）。

import { IDisposable } from '../../../../base/common/lifecycle.js';
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
 *
 * **後から有効にされても拾う。** pty ホストは常駐を使うかを起きたときに1回だけ決めるので、
 * サーバーが起きた後で設定を入れると、今までは次にサーバーが起き直すまで（窓を全部閉じて
 * 終わるのを待つか、次の更新まで）効かなかった。設定が入った時点で環境変数を足しておけば、
 * 次に pty ホストが起きたとき（「ターミナル: PTY ホストの再起動」を含む）から常駐を使う。
 * 切るほうは追いかけない。切った瞬間に外すと、常駐に預けてある端末を次の pty ホストが
 * 引き取らなくなり、24 時間誰からも見えなくなる。切るのはサーバーが起き直したときに効く。
 */
export function paradisEnableRemotePtyHostDaemon(
	configurationService: IConfigurationService,
	stateDir: string,
	logService: ILogService,
	/** 動いている機械。テストで差し替える。 */
	platform: NodeJS.Platform = process.platform,
	/** 環境変数を置く先。テストで差し替える。 */
	env: { [key: string]: string | undefined } = process.env,
): IDisposable {
	const apply = () => {
		if (configurationService.getValue(PARADIS_PTY_HOST_DAEMON_ENABLED) !== true || env[PARADIS_PTY_HOST_STATE_DIR] === stateDir) {
			return;
		}
		if (platform === 'win32') {
			logService.info('[ParadisPtyHost] not keeping terminals in a daemon on this Windows host: the named pipe cannot tell us who it is talking to');
			return;
		}
		env[PARADIS_PTY_HOST_STATE_DIR] = stateDir;
		logService.info(`[ParadisPtyHost] terminals on this server may outlive it; state lives under ${stateDir}`);
	};
	apply();
	return configurationService.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(PARADIS_PTY_HOST_DAEMON_ENABLED)) {
			apply();
		}
	});
}
