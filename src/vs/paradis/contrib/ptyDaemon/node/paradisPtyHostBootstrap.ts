/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// pty ホストが起きたときに、常駐を使うかどうかを決めて繋ぐ。
//
// **ローカルもリモートもここを通る。** ローカルではアプリの中の pty ホストが、SSH ではリモートの
// サーバーが、同じこの関数を呼ぶ。Electron の口を使っていないので同じコードで済む。
//
// 使うかどうかは環境変数で受ける。設定を読む口はプロセスによって違うが、**pty ホストを起こす側は
// どちらの場合も設定を知っている**ので、そこで決めて渡すのがいちばん素直で、判断が1箇所に済む。

import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisPtyHostPaths, ParadisPtyHostPlatform } from '../common/paradisPtyHostPaths.js';
import { paradisPtyDaemonEnv } from '../common/paradisPtyDaemonEnv.js';
import { PARADIS_PTY_PROTOCOL_VERSION } from '../common/paradisPtyProtocol.js';
import { paradisEnsurePtyHost } from './paradisEnsurePtyHost.js';
import { paradisUsePtyDaemon } from './paradisTerminalProcessFactory.js';

/**
 * 常駐に置き場所を与える環境変数。**これが無ければ常駐は使わない**（今までどおり）。
 *
 * 値は状態を置くディレクトリ。ここより下に 0700 のディレクトリを作り、ソケットと台帳を置く。
 */
export const PARADIS_PTY_HOST_STATE_DIR = 'PARADIS_PTY_HOST_STATE_DIR';

function currentPlatform(): ParadisPtyHostPlatform {
	return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
}

export interface IParadisPtyHostBootstrapOptions {
	readonly env: { readonly [key: string]: string | undefined };
	/** 常駐を起こすときに使う実行ファイル。Electron では `process.execPath`、素の node でも同じ。 */
	readonly execPath: string;
	/** 常駐として起きるための入口を指す引数（`bootstrap-fork` のパス）。 */
	readonly bootstrapPath: string;
	readonly logService: ILogService;
}

/**
 * 常駐を使うなら繋ぐ。**繋げなくても何も壊さない**（今までどおりこのプロセスの中で起こす）。
 *
 * 返すのは「常駐に繋がったか」だけ。引き取りは呼び出し側が `PtyService` を作った後に行う。
 */
export async function paradisBootstrapPtyHost(options: IParadisPtyHostBootstrapOptions): Promise<boolean> {
	const stateDir = options.env[PARADIS_PTY_HOST_STATE_DIR];
	if (!stateDir) {
		return false;
	}

	const paths = paradisPtyHostPaths({ stateDir, platform: currentPlatform() });
	const connection = await paradisEnsurePtyHost({
		paths,
		launch: {
			execPath: options.execPath,
			args: [options.bootstrapPath],
			env: {
				VSCODE_ESM_ENTRYPOINT: 'vs/paradis/contrib/ptyDaemon/node/paradisPtyHostDaemonEntry',
				// 常駐が自分で置き場所を計算し直して、渡された値と突き合わせるために要る。
				[PARADIS_PTY_HOST_STATE_DIR]: stateDir,
				// 台帳と身元の仕組みは前の常駐と共通。版を「ビルド」の位置に入れるのは、
				// **この常駐にとってビルドに当たるものが protocol の版だから**。
				...paradisPtyDaemonEnv(
					{ socketPath: paths.socketPath, buildKey: `v${PARADIS_PTY_PROTOCOL_VERSION}`, ledgerDir: paths.ledgerDir, ledgerFile: paths.ledgerFile, socketPathTooLong: paths.socketPathTooLong },
					`protocol-v${PARADIS_PTY_PROTOCOL_VERSION}`,
				),
			},
		},
		logService: options.logService,
	});

	if (!connection) {
		return false;
	}
	paradisUsePtyDaemon(connection);
	return true;
}
