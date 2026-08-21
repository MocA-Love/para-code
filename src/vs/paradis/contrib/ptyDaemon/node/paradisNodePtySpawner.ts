/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐の中で実際に pty を起こす。**常駐の中で唯一 node-pty を触る場所。**
//
// ここが1枚だけ挟まっているのは、抱え方 (`ParadisPtyHolder`) を本物のシェル無しで確かめられる
// ようにするため。あちらで見張っているのは「いつ止めて、いつ流すか」で、node-pty の中身とは
// 関係が無い。
//
// 起動オプションは upstream の `TerminalProcess` と揃えてある。**揃っていないと、同じシェルが
// 常駐経由のときだけ違う振る舞いをする**ことになり、原因を辿るのが極端に難しくなる。

import { IPty, spawn } from 'node-pty';
import { IParadisPtySpawnRequest } from '../common/paradisPtyProtocol.js';
import { IParadisPtyProcess } from './paradisPtyHolder.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';

/**
 * 端末の種類。
 *
 * 非 Windows で `xterm-256color` を名乗るのは upstream と同じ。ここを変えると、シェルの
 * プロンプトや色の出方が常駐経由のときだけ変わる。
 */
const TERM_NAME = 'xterm-256color';

export function paradisSpawnNodePty(request: IParadisPtySpawnRequest): IParadisPtyProcess {
	const pty = spawn(request.file, [...request.args], {
		name: TERM_NAME,
		cwd: request.cwd,
		env: { ...request.env },
		cols: request.cols,
		rows: request.rows,
	});
	return new ParadisNodePty(pty);
}

class ParadisNodePty implements IParadisPtyProcess {

	constructor(private readonly pty: IPty) { }

	get pid(): number { return this.pty.pid; }
	get process(): string { return this.pty.process; }

	onData(listener: (data: string) => void) {
		const subscription = this.pty.onData(listener);
		return toDisposable(() => subscription.dispose());
	}

	onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void) {
		const subscription = this.pty.onExit(listener);
		return toDisposable(() => subscription.dispose());
	}

	write(data: string): void { this.pty.write(data); }
	resize(cols: number, rows: number): void { this.pty.resize(cols, rows); }
	kill(signal?: string): void { this.pty.kill(signal); }
	pause(): void { this.pty.pause(); }
	resume(): void { this.pty.resume(); }
}
