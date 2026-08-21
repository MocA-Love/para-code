/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナル1本を、常駐に持たせるか自分の中で持つかを決める。**差し替え口の実体。**
//
// `ptyService.ts` の `new TerminalProcess(...)` 1行をここへ向ける。upstream 側の変更は
// その1行と、抱える器の引数の型1行だけで済む。
//
// **プロセスに1つの状態を置いている。** 常駐への接続はこのプロセスに1本あればよく、
// `PtyService` へ引き回すと upstream 側の変更が増える。置き場所を1箇所に決めて、
// そこだけが可変であることを明示しておく。
//
// **常駐が使えないことは、ターミナルが使えないことではない。** 繋げなければ黙って今までどおり
// 自分の中で起こす。ここで諦めずに投げると、常駐まわりの些細な不調がターミナル全滅になる。

import { IProcessEnvironment } from '../../../../base/common/platform.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IShellLaunchConfig, ITerminalProcessOptions } from '../../../../platform/terminal/common/terminal.js';
import { TerminalProcess } from '../../../../platform/terminal/node/terminalProcess.js';
import { IParadisTerminalProcessLike } from '../common/paradisTerminalProcessLike.js';
import { IParadisPtyHostConnection } from './paradisEnsurePtyHost.js';
import { ParadisDaemonTerminalProcess } from './paradisDaemonTerminalProcess.js';

/**
 * 常駐への接続。**このプロセスに1つ。**
 *
 * 立ててあるときだけ常駐に持たせる。立っていなければ今までどおり。
 */
let connection: IParadisPtyHostConnection | undefined;

/** 常駐を使うと決まったときに、繋いだものをここへ預ける。 */
export function paradisUsePtyDaemon(value: IParadisPtyHostConnection | undefined): void {
	connection = value;
}

/** いま常駐に持たせているか。引き取りや状態表示が同じ答えを見るための唯一の口。 */
export function paradisPtyDaemonConnection(): IParadisPtyHostConnection | undefined {
	return connection;
}

/**
 * ターミナル1本を作る。`ptyService.ts` の唯一の生成点から呼ばれる。
 *
 * 引数は `TerminalProcess` のコンストラクタと同じ並びにしてある。**呼び出し側の1行を
 * 置き換えるだけで済ませる**ため。
 */
export function paradisCreateTerminalProcess(
	shellLaunchConfig: IShellLaunchConfig,
	cwd: string,
	cols: number,
	rows: number,
	env: IProcessEnvironment,
	executableEnv: IProcessEnvironment,
	options: ITerminalProcessOptions,
	logService: ILogService,
	productService: IProductService,
): IParadisTerminalProcessLike {
	if (connection) {
		return new ParadisDaemonTerminalProcess(
			connection.host, shellLaunchConfig, cwd, cols, rows, env, executableEnv, options, logService, productService,
		);
	}
	return new TerminalProcess(shellLaunchConfig, cwd, cols, rows, env, executableEnv, options, logService, productService);
}
