/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルのプロセスを「アプリの中で飼う」か「外に常駐させる」かを決めるところ。
//
// `app.ts` からはこの関数を1回呼ぶだけにしてある。分岐をあちらに書くと、常駐が使えない条件が
// 増えるたびに upstream のファイルへ手が入ることになる。
//
// **使えないと分かったら黙って今までどおりに倒す**。常駐は「あると便利」なものであって、
// 無いと動かないものではない。ここで例外を投げると、ターミナルが1本も開けないアプリになる。

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IReconnectConstants } from '../../../../platform/terminal/common/terminal.js';
import { ElectronPtyHostStarter } from '../../../../platform/terminal/electron-main/electronPtyHostStarter.js';
import { validatedIpcMain } from '../../../../base/parts/ipc/electron-main/ipcMain.js';
import { IPtyHostStarter } from '../../../../platform/terminal/node/ptyHost.js';
import { PARADIS_PTY_HOST_STATE_DIR, paradisPtyHostPaths } from '../common/paradisPtyHostPaths.js';
import { paradisDeletePtyDaemonEnv } from '../common/paradisPtyEnvHygiene.js';
import { PARADIS_PTY_PROTOCOL_VERSION } from '../common/paradisPtyProtocol.js';
import { ParadisPtyHostIpc } from './paradisDaemonPtyHostStarter.js';
import { ParadisScopedEnvPtyHostStarter } from './paradisScopedEnvPtyHostStarter.js';
import { IParadisPtyDaemonPaths, ParadisDaemonPlatform, paradisPtyDaemonPaths } from '../common/paradisPtyDaemonPaths.js';
import { PARADIS_PTY_DAEMON_LEGACY_ENABLED, PARADIS_PTY_HOST_DAEMON_ENABLED, paradisLocalPtyHostDaemonEnabled } from '../common/paradisPtyDaemonSettingKey.js';
import { ParadisPtyHostingFallback, ParadisPtyHostingMode, paradisPtyModeAttributes, recordParadisPtyMode } from '../common/paradisPtyModeDiagnostics.js';

/**
 * 常駐の身元。ビルドが変われば別の常駐になる。
 *
 * `commit` は開発ビルドでは空なので、そのときは1つの常駐を使い回す。開発中に作り直した
 * コードと繋がることになるが、開発ビルドで版を区切る手立てが無い以上、区切れるふりをしない
 * (中途半端に区切ると、変更のたびに常駐が増えて掃除されないほうが害が大きい)。
 */
export function paradisPtyDaemonBuildId(productService: IProductService): string {
	return `${productService.version}-${productService.commit ?? 'dev'}`;
}

function currentPlatform(): ParadisDaemonPlatform {
	return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
}

/** 常駐の置き場所。UI 側もここを通して同じ場所を見る。 */
export function paradisPtyDaemonPathsFor(
	environmentMainService: IEnvironmentMainService,
	productService: IProductService,
): IParadisPtyDaemonPaths {
	return paradisPtyDaemonPaths({
		userDataPath: environmentMainService.userDataPath,
		buildId: paradisPtyDaemonBuildId(productService),
		platform: currentPlatform(),
		xdgRuntimeDir: process.env['XDG_RUNTIME_DIR'],
	});
}

/**
 * 見るべき台帳のすべて。
 *
 * **両方見る。** 前の方式の常駐（設定 `paradis.terminal.daemon.enabled`。2026-11-22 に選べなくした）が
 * 端末を抱えたまま走っていることがある。片方しか見ていないと、それは状態パネルにも出ず、
 * **止める手立ても無くなる**。掃除の導線を残すために、いま使う方に加えてもう片方も読む。
 */
export function paradisAllDaemonLedgers(
	configurationService: IConfigurationService,
	environmentMainService: IEnvironmentMainService,
	productService: IProductService,
): readonly string[] {
	const active = paradisActiveDaemonLedger(configurationService, environmentMainService, productService);
	const other = paradisLocalPtyHostDaemonEnabled(configurationService)
		? paradisPtyDaemonPathsFor(environmentMainService, productService).ledgerDir
		: paradisPtyHostPaths({ stateDir: environmentMainService.userDataPath, platform: currentPlatform() }).ledgerDir;
	return active.ledgerDir === other ? [active.ledgerDir] : [active.ledgerDir, other];
}

export function paradisActiveDaemonLedger(
	configurationService: IConfigurationService,
	environmentMainService: IEnvironmentMainService,
	productService: IProductService,
): { readonly ledgerDir: string; readonly buildKey: string } {
	if (paradisLocalPtyHostDaemonEnabled(configurationService)) {
		const paths = paradisPtyHostPaths({ stateDir: environmentMainService.userDataPath, platform: currentPlatform() });
		return { ledgerDir: paths.ledgerDir, buildKey: `v${PARADIS_PTY_PROTOCOL_VERSION}` };
	}
	const paths = paradisPtyDaemonPathsFor(environmentMainService, productService);
	return { ledgerDir: paths.ledgerDir, buildKey: paths.buildKey };
}

/** 常駐が使われる設定になっているか（前の鍵を書いたままの人も含む）。 */
export function paradisAnyDaemonEnabled(configurationService: IConfigurationService): boolean {
	return paradisLocalPtyHostDaemonEnabled(configurationService);
}

/**
 * ターミナルのプロセスを持つ相手を決める。
 *
 * `ElectronPtyHostStarter` と同じ引数で呼べるようにしてあるので、`app.ts` 側は式を1つ
 * 差し替えるだけで済む。
 */
export function paradisCreatePtyHostStarter(
	reconnectConstants: IReconnectConstants,
	configurationService: IConfigurationService,
	environmentMainService: IEnvironmentMainService,
	lifecycleMainService: ILifecycleMainService,
	logService: ILogService,
	productService: IProductService,
	/** テスト用。起こす側が受ける IPC（既定は main の本物）。 */
	ipc: Pick<typeof validatedIpcMain, 'on' | 'removeListener'> = validatedIpcMain,
): IPtyHostStarter {
	// 親から受け継いだ常駐の内部用の変数は、どの分岐に進むにしても最初に消す。Para Code の
	// ターミナルから起動された別の Para Code が、親の常駐の置き場所を持ったまま起きると、
	// ここで起こす pty ホストや拡張ホストがそれを継いで親の常駐へ繋ぎに行く。
	const inherited = paradisDeletePtyDaemonEnv(process.env);
	if (inherited.length > 0) {
		logService.info(`[ParadisPtyHost] ignoring inherited pty daemon variables: ${inherited.join(', ')}`);
	}

	const inApp = (via: ParadisPtyHostIpc = ipc) => new ElectronPtyHostStarter(reconnectConstants, configurationService, environmentMainService, lifecycleMainService, logService, via);
	// 選んだ飼い方を Sentry へ 1 件送る（paradisPtyModeDiagnostics.ts）
	// `daemonEnabled` は前の鍵を書いたままの人の数を数えるために残す（その人も下で `handover` になる）
	const settings = {
		daemonEnabled: configurationService.getValue(PARADIS_PTY_DAEMON_LEGACY_ENABLED) === true,
		reattachAcrossUpdates: configurationService.getValue(PARADIS_PTY_HOST_DAEMON_ENABLED) === true,
	};
	const chose = <T>(mode: ParadisPtyHostingMode, fallback: ParadisPtyHostingFallback, starter: T): T => {
		recordParadisPtyMode(paradisPtyModeAttributes(mode, fallback, settings));
		return starter;
	};

	// 更新をまたいで繋ぎ直せる薄い常駐。**pty ホストはアプリの中のまま**で、その中から常駐へ
	// 繋ぐので、ここは今までどおりの起こし方でよい。渡すのは置き場所だけ
	// (`paradisPtyHostBootstrap.ts` が受け取る)。
	//
	// 前の方式（pty ホスト一式を常駐にする `ParadisDaemonPtyHostStarter`）は 2026-11-22（q.html Q681）から
	// ここでは選ばない。前の鍵 `paradis.terminal.daemon.enabled` を書いたままの人も、この薄い常駐になる。
	if (paradisLocalPtyHostDaemonEnabled(configurationService)) {
		// **Windows では止める。名前付きパイプを使う限り、こちらでは塞げない穴が残るため。**
		//
		// 名前付きパイプの名前空間はマシン全体で共有で、名前は userDataPath から他のユーザーにも計算できる。
		// 作るのに特権は要らず、先に作った側が持ち主になる。unix は置き場所が 0700 なので、他のユーザーは
		// そもそもファイルを作れない。盗聴の方（偽物に繋いで全打鍵と環境変数を渡す）は名乗り合い
		// (`paradisPtyDaemonAuth`) で塞いであるが、**接続した時点で成立してしまう方**が残る。libuv の
		// `open_named_pipe()` の `CreateFileW` は `SECURITY_SQOS_PRESENT` を付けず、Microsoft の
		// "Impersonating a Named Pipe Client" いわく未指定は SecurityImpersonation（危険な側の既定）。
		// `ImpersonateNamedPipeClient` が通るのは偽サーバーが `SeImpersonatePrivilege` を持つ場合か同じユーザーの
		// 場合だけだが、特権サービスが名前を先に取って管理者の Para Code を待ち構える経路は残る（2026-08-20 調査）。
		// 開けるなら Windows では名前付きパイプをやめてループバック TCP にするのが筋。
		//
		// 加えて、こちらは題名も cwd も ConPTY も Windows では機能しない前提で書いてあり、
		// 文字列の引数（Windows 専用の形）を渡されると起動を断る。
		if (currentPlatform() === 'win32') {
			logService.info('[ParadisPtyHost] not using a daemon on Windows yet: the named pipe cannot tell us who it is talking to');
			return chose('in_app', 'windows', inApp());
		}
		const hostPaths = paradisPtyHostPaths({ stateDir: environmentMainService.userDataPath, platform: currentPlatform() });
		if (hostPaths.socketPathTooLong) {
			// 黙って落とすと、症状は「毎回ターミナルが作り直される」だけになり原因に辿り着けない。
			logService.warn(`[ParadisPtyHost] not using a daemon: the socket path is too long for this platform (${hostPaths.socketPath.length} chars at ${hostPaths.socketPath}). Try a shorter --user-data-dir.`);
			return chose('in_app', 'path_too_long', inApp());
		}
		// 置き場所は pty ホストを起こす瞬間だけ渡す。main の `process.env` へ入れっぱなしにすると、
		// 拡張ホストなど main が起こすものすべてに漏れる（paradisScopedEnvPtyHostStarter.ts）。
		return chose('handover', 'none', new ParadisScopedEnvPtyHostStarter(inApp(), { [PARADIS_PTY_HOST_STATE_DIR]: environmentMainService.userDataPath }));
	}

	return chose('in_app', 'none', inApp());
}
