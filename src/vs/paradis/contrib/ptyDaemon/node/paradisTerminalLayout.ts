/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タブと分割の配置を、常駐に預けて取り戻す。
//
// **これが無いと、引き取りは成功しても画面には何も出ない。** 配置は `PtyService` のメモリに
// しか無く、pty ホストはアプリと一緒に消えるので、アプリを起こし直した時点で空になる。窓は
// 配置を見て「どのターミナルに繋ぐか」を決めるため、空だと**誰も繋ぎに来ない**。走っている
// プロセスはあるのに、画面に出てくる経路そのものが無い、という形になる。
//
// **番号を持ち越さない。** 配置に入っているのはターミナルの番号だが、あれはアプリを起こす
// たびに 1 から振り直される。前の世代の番号をそのまま戻しても、どれにも当たらない。だから
// 預けるときに常駐側の handle へ書き換え、取り戻すときに新しい番号へ書き戻す。
//
// 常駐にとってはただの文字列で、中身は一切見ない（`paradisPtyProtocol.ts` の `setLayout`）。

import { ISetTerminalLayoutInfoArgs } from '../../../../platform/terminal/common/terminalProcess.js';

/** 番号を handle へ、handle を番号へ。分からないものは -1 にして、戻すときに落とす。 */
const UNKNOWN = -1;

export type ParadisIdLookup = (id: number) => number | undefined;

/**
 * 預ける形にする。番号を常駐側の handle へ書き換える。
 *
 * handle が分からないターミナル（常駐に載っていないもの）は残しておく意味が無いので落とす。
 * 残すと、取り戻したときに存在しない番号を指す配置になる。
 */
export function paradisEncodeLayout(args: ISetTerminalLayoutInfoArgs, handleOf: ParadisIdLookup): string {
	const encoded: ISetTerminalLayoutInfoArgs = {
		workspaceId: args.workspaceId,
		tabs: args.tabs.map(tab => ({
			isActive: tab.isActive,
			activePersistentProcessId: tab.activePersistentProcessId === undefined ? undefined : handleOf(tab.activePersistentProcessId) ?? UNKNOWN,
			terminals: tab.terminals
				.map(terminal => ({ ...terminal, terminal: handleOf(terminal.terminal) ?? UNKNOWN }))
				.filter(terminal => terminal.terminal !== UNKNOWN),
		})).filter(tab => tab.terminals.length > 0),
		background: args.background === null ? null : args.background.map(id => handleOf(id) ?? UNKNOWN).filter(handle => handle !== UNKNOWN),
	};
	return JSON.stringify(encoded);
}

/**
 * 取り戻す。handle を新しい番号へ書き戻す。
 *
 * **読めなくても投げない。** ここで投げると、配置が壊れているというだけで引き取り全体が
 * 落ちる。配置は作り直せるが、走っているプロセスは作り直せない。
 */
export function paradisDecodeLayout(raw: string, idOf: ParadisIdLookup): ISetTerminalLayoutInfoArgs | undefined {
	let parsed: ISetTerminalLayoutInfoArgs;
	try {
		parsed = JSON.parse(raw) as ISetTerminalLayoutInfoArgs;
	} catch {
		return undefined;
	}
	if (typeof parsed?.workspaceId !== 'string' || !Array.isArray(parsed.tabs)) {
		return undefined;
	}
	const tabs = parsed.tabs.map(tab => ({
		isActive: tab.isActive,
		activePersistentProcessId: tab.activePersistentProcessId === undefined ? undefined : idOf(tab.activePersistentProcessId),
		terminals: (tab.terminals ?? [])
			.map(terminal => ({ ...terminal, terminal: idOf(terminal.terminal) ?? UNKNOWN }))
			.filter(terminal => terminal.terminal !== UNKNOWN),
	})).filter(tab => tab.terminals.length > 0);

	if (tabs.length === 0) {
		// 1本も引き取れなかった配置を戻しても、空のタブが並ぶだけになる。
		return undefined;
	}
	return {
		workspaceId: parsed.workspaceId,
		tabs,
		background: (parsed.background ?? []).map(handle => idOf(handle) ?? UNKNOWN).filter(id => id !== UNKNOWN),
	};
}
