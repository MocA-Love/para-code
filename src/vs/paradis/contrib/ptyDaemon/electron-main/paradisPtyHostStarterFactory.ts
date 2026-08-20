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
import { ParadisDaemonPtyHostStarter } from './paradisDaemonPtyHostStarter.js';
import { IParadisPtyDaemonPaths, ParadisDaemonPlatform, paradisPtyDaemonPaths } from '../common/paradisPtyDaemonPaths.js';

/** 常駐を使うかどうかの設定。既定は false。 */
export const PARADIS_PTY_DAEMON_ENABLED = 'paradis.terminal.daemon.enabled';

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

	if (configurationService.getValue(PARADIS_PTY_DAEMON_ENABLED) !== true) {
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
