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
import { IPtyHostStarter } from '../../../../platform/terminal/node/ptyHost.js';
import { PARADIS_PTY_HOST_STATE_DIR } from '../node/paradisPtyHostBootstrap.js';
import { paradisPtyHostPaths } from '../common/paradisPtyHostPaths.js';
import { PARADIS_PTY_PROTOCOL_VERSION } from '../common/paradisPtyProtocol.js';
import { ParadisDaemonPtyHostStarter } from './paradisDaemonPtyHostStarter.js';
import { IParadisPtyDaemonPaths, ParadisDaemonPlatform, paradisPtyDaemonPaths } from '../common/paradisPtyDaemonPaths.js';
import { PARADIS_PTY_DAEMON_ENABLED, PARADIS_PTY_HOST_DAEMON_ENABLED } from '../common/paradisPtyDaemonSettingKey.js';

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
 * いま使う常駐の置き場所と、その台帳での鍵。
 *
 * **常駐は2種類ある。** 状態を見る・止める・終了時に残すかを決める、のどれもがここを通るので、
 * どちらを見るかの判断は1箇所に置く。分かれていると、新しい方を有効にした人には
 * 「動いていない」と見え、**終了時に全部のターミナルが畳まれる**（実際にそうなっていた）。
 */
/**
 * 見るべき台帳のすべて。
 *
 * **切り替えの途中では両方見る。** 旧い常駐が端末を抱えたまま走っている状態で新しい方へ
 * 切り替えると、片方しか見ていないと旧い常駐は状態パネルにも出ず、**止める手立ても無くなる**。
 * 掃除の導線を残すために、いま使う方に加えてもう片方も読む。
 */
export function paradisAllDaemonLedgers(
	configurationService: IConfigurationService,
	environmentMainService: IEnvironmentMainService,
	productService: IProductService,
): readonly string[] {
	const active = paradisActiveDaemonLedger(configurationService, environmentMainService, productService);
	const other = configurationService.getValue(PARADIS_PTY_HOST_DAEMON_ENABLED) === true
		? paradisPtyDaemonPathsFor(environmentMainService, productService).ledgerDir
		: paradisPtyHostPaths({ stateDir: environmentMainService.userDataPath, platform: currentPlatform() }).ledgerDir;
	return active.ledgerDir === other ? [active.ledgerDir] : [active.ledgerDir, other];
}

export function paradisActiveDaemonLedger(
	configurationService: IConfigurationService,
	environmentMainService: IEnvironmentMainService,
	productService: IProductService,
): { readonly ledgerDir: string; readonly buildKey: string } {
	if (configurationService.getValue(PARADIS_PTY_HOST_DAEMON_ENABLED) === true) {
		const paths = paradisPtyHostPaths({ stateDir: environmentMainService.userDataPath, platform: currentPlatform() });
		return { ledgerDir: paths.ledgerDir, buildKey: `v${PARADIS_PTY_PROTOCOL_VERSION}` };
	}
	const paths = paradisPtyDaemonPathsFor(environmentMainService, productService);
	return { ledgerDir: paths.ledgerDir, buildKey: paths.buildKey };
}

/** どちらかの常駐が使われる設定になっているか。 */
export function paradisAnyDaemonEnabled(configurationService: IConfigurationService): boolean {
	return configurationService.getValue(PARADIS_PTY_DAEMON_ENABLED) === true
		|| configurationService.getValue(PARADIS_PTY_HOST_DAEMON_ENABLED) === true;
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
): IPtyHostStarter {
	const inApp = () => new ElectronPtyHostStarter(reconnectConstants, configurationService, environmentMainService, lifecycleMainService, logService);

	// 更新をまたいで繋ぎ直せる薄い常駐。**pty ホストはアプリの中のまま**で、その中から常駐へ
	// 繋ぐので、ここは今までどおりの起こし方でよい。渡すのは置き場所だけ
	// (`paradisPtyHostBootstrap.ts` が受け取る)。
	if (configurationService.getValue(PARADIS_PTY_HOST_DAEMON_ENABLED) === true) {
		process.env[PARADIS_PTY_HOST_STATE_DIR] = environmentMainService.userDataPath;
		return inApp();
	}

	if (configurationService.getValue(PARADIS_PTY_DAEMON_ENABLED) !== true) {
		return inApp();
	}

	// Windows はここで止める。**名前付きパイプを使う限り、こちらでは塞げない穴が残るため。**
	//
	// 名前付きパイプの名前空間はマシン全体で共有で、名前は userDataPath とビルドから他のユーザー
	// にも計算できる。作るのに特権は要らず、先に作った側が持ち主になる。unix は置き場所が 0700
	// なので、他のユーザーはそもそもファイルを作れない。
	//
	// 盗聴の方 (偽物に繋いで全打鍵と環境変数を渡す) は、名乗り合い (`paradisPtyDaemonAuth`) で
	// 塞いである。残っているのは**接続した時点で成立してしまう方**で、こちらが相手を拒んでも
	// 遅い。
	//
	// 調査済み (2026-08-20):
	//  - libuv の `src/win/pipe.c` `open_named_pipe()` にある `CreateFileW` は3箇所とも
	//    `dwFlagsAndAttributes` が `FILE_FLAG_OVERLAPPED` のみ。ファイル全体に
	//    `SECURITY_SQOS_PRESENT` も `SECURITY_IDENTIFICATION` も出てこない。接続の両パス
	//    (即時・`ERROR_PIPE_BUSY` 後のリトライ) ともここを通る
	//  - Microsoft の "Impersonating a Named Pipe Client" いわく
	//    "By default, a server impersonates at the SecurityImpersonation impersonation level"。
	//    つまり未指定は危険な側の既定
	//
	// ただし被害の範囲は限られる。`ImpersonateNamedPipeClient` が通るのは、偽サーバーが
	// `SeImpersonatePrivilege` を持つ場合 (サービスアカウントなど) か、そもそも同じユーザーの
	// 場合だけ。**一般ユーザーの別アカウントでは成立しない**。それでも、特権サービスが名前を
	// 先に取って管理者の Para Code を待ち構える経路は残る。
	//
	// フラグを付けさせる手段はこちらに無い (Node の `net` にその口が無い)。開けるなら
	// **Windows では名前付きパイプをやめてループバック TCP にする**のが筋で、TCP には偽装の
	// 仕組み自体が無いので問題が丸ごと消える。認証は今の名乗り合いがそのまま使え、ポート番号は
	// 台帳に書けばよい。`ipc.net` の `serve`/`connect` は両方に対応している。
	if (currentPlatform() === 'win32') {
		logService.info('[ParadisPtyDaemon] not using a daemon on Windows yet: the named pipe cannot tell us who it is talking to');
		return inApp();
	}

	const paths = paradisPtyDaemonPathsFor(environmentMainService, productService);
	if (paths.socketPathTooLong) {
		// 黙って落とすと、症状は「毎回ターミナルが作り直される」だけになり原因に辿り着けない。
		logService.warn(`[ParadisPtyDaemon] not using a daemon: the socket path is too long for this platform (${paths.socketPath.length} chars at ${paths.socketPath}). Try a shorter --user-data-dir.`);
		return inApp();
	}

	logService.info(`[ParadisPtyDaemon] terminals will run in a daemon at ${paths.socketPath}`);
	return new ParadisDaemonPtyHostStarter(
		reconnectConstants,
		paths,
		paradisPtyDaemonBuildId(productService),
		environmentMainService,
		lifecycleMainService,
		logService,
	);
}
