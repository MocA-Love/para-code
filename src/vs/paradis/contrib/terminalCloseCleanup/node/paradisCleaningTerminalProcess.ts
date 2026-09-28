/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// upstream の `TerminalProcess` に、閉じたときに裏のプロセスを止める処理（W2-32）を足しただけの器。
//
// `paradisTerminalProcessFactory.ts` の唯一の生成点で `new TerminalProcess(...)` の代わりに作る
// ので、upstream 側の変更は無い。`shutdown` は「本当に閉じる」ときだけ呼ばれ、スペース切り替えの
// 退避・別ウィンドウへの移動・切り離しは `shutdown` を通らない（`detach` / 器の付け替え）ので、
// それらでは何も止めない。`kill` 相当のシグナル送信（`sendSignal`）には手を入れない。

import { Event } from '../../../../base/common/event.js';
import { IProcessEnvironment } from '../../../../base/common/platform.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IShellLaunchConfig, ITerminalProcessOptions } from '../../../../platform/terminal/common/terminal.js';
import { TerminalProcess } from '../../../../platform/terminal/node/terminalProcess.js';
import { paradisShutdownStoppingDescendants } from './paradisTerminalDescendants.js';

export class ParadisCleaningTerminalProcess extends TerminalProcess {

	private shellPid: number | undefined;
	private closing = false;

	constructor(
		/** 閉じたときに裏のプロセスを止めるか（設定と OS から決めたもの）。 */
		private readonly stopDescendantsOnClose: boolean,
		shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		cols: number,
		rows: number,
		env: IProcessEnvironment,
		executableEnv: IProcessEnvironment,
		options: ITerminalProcessOptions,
		private readonly paradisLogService: ILogService,
		productService: IProductService,
	) {
		super(shellLaunchConfig, cwd, cols, rows, env, executableEnv, options, paradisLogService, productService);
		this._register(this.onProcessReady(event => {
			this.shellPid = event.pid;
		}));
	}

	override shutdown(immediate: boolean): void {
		const shellPid = this.shellPid;
		// 2 回目以降（猶予の途中で「今すぐ」と言われた等）は本来の処理へそのまま渡す。
		if (!this.stopDescendantsOnClose || this.closing || shellPid === undefined || shellPid <= 1) {
			super.shutdown(immediate);
			return;
		}
		this.closing = true;
		// シェルの終了は、本来の終了を呼ぶ前から聞いておく。
		const exited = Event.toPromise(this.onProcessExit);
		paradisShutdownStoppingDescendants(shellPid, () => super.shutdown(immediate), exited, this.paradisLogService);
	}
}
