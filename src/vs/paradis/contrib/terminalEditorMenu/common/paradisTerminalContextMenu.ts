/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの本文とタブの右クリックに足す項目（Q592）のうち、画面に依らない決まりごと。

/**
 * 「ターミナルをリセット」で xterm へ書く列。アプリが入れたまま終わった入力モードだけを戻す
 * （画面とスクロールバック、シェル統合の印は消さない。消すのは「クリア」）。pty へは送らない。
 * マウスの報告（1000/1002/1003、書式の 1006/1015）、ブラケットペースト（2004）、フォーカスの報告（1004）、
 * カーソルキーのアプリモード（?1）、テンキーのアプリモード（ESC >）、カーソルの表示（?25h）。
 */
export const PARADIS_TERMINAL_INPUT_MODE_RESET = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1004l\x1b[?1l\x1b>\x1b[?25h';

/** 「コンテキストをコピー」で取る行数（Orca と同じ）。 */
export const PARADIS_TERMINAL_CONTEXT_LINES = 800;

/** バッファの 1 行（xterm の IBufferLine から取り出したもの）。 */
export interface IParadisTerminalBufferLine {
	readonly text: string;
	/** 前の行の折り返しの続きか。 */
	readonly isWrapped: boolean;
}

/**
 * バッファの行から、末尾の `maxLines` 行ぶんの文を作る。折り返しの続きの行は前の行へつなぎ、
 * 末尾の空行は落とす。
 */
export function paradisTerminalBufferTail(lines: readonly IParadisTerminalBufferLine[], maxLines: number): string {
	const logical: string[] = [];
	for (const line of lines) {
		if (line.isWrapped && logical.length > 0) {
			logical[logical.length - 1] += line.text;
		} else {
			logical.push(line.text);
		}
	}
	const trimmed = logical.map(line => line.replace(/\s+$/, ''));
	while (trimmed.length > 0 && trimmed[trimmed.length - 1].length === 0) {
		trimmed.pop();
	}
	return trimmed.slice(Math.max(0, trimmed.length - maxLines)).join('\n');
}

/** タブの色の丸。本家の「色の変更...」と同じ ANSI の 8 色（テーマの色の名前で保存される）。 */
export interface IParadisTerminalTabColor {
	/** 本家の `changeColor` に渡す色の名前。 */
	readonly colorId: string;
	/** コマンド ID と CSS のクラスに使う短い名前。 */
	readonly key: string;
}

export const PARADIS_TERMINAL_TAB_COLORS: readonly IParadisTerminalTabColor[] = [
	{ colorId: 'terminal.ansiBlack', key: 'black' },
	{ colorId: 'terminal.ansiRed', key: 'red' },
	{ colorId: 'terminal.ansiGreen', key: 'green' },
	{ colorId: 'terminal.ansiYellow', key: 'yellow' },
	{ colorId: 'terminal.ansiBlue', key: 'blue' },
	{ colorId: 'terminal.ansiMagenta', key: 'magenta' },
	{ colorId: 'terminal.ansiCyan', key: 'cyan' },
	{ colorId: 'terminal.ansiWhite', key: 'white' },
];

/** タブの色のサブメニューの MenuId の名前（HTML のメニューでは menuIcons が丸の一列に開く）。 */
export const PARADIS_TERMINAL_TAB_COLOR_SUBMENU_ID = 'paradisTerminalTabColorSubmenu';

/** 色ごとのコマンド ID。色なしは `none`。 */
export function paradisTerminalTabColorCommandId(key: string): string {
	return `paradis.terminal.tabColor.${key}`;
}

/** 色の丸に付けるクラス（色は paradisTerminalContextMenu.css が描く。色なしは破線の丸）。 */
export function paradisTerminalTabColorClass(key: string): string {
	return key === 'none' ? 'paradis-color-default' : `paradis-terminal-color-${key}`;
}

/**
 * 本文のメニューのエージェントの節を出すか。エージェントの hook が来たことがあっても、シェル統合が
 * 「シェルのプロンプトが入力を待っている（何も動いていない）」と言うなら、エージェントは終わってシェルへ
 * 戻っている。hook がまだ来ていなくても、動いているコマンドが Claude Code・Codex の起動なら出す。
 * シェル統合が無い・決めきれないときは hook の実績だけで決める。
 */
export function paradisIsAgentRunningInTerminal(hasHook: boolean, atShellPrompt: boolean, executingAgentCommand: boolean): boolean {
	if (atShellPrompt) {
		return false;
	}
	return hasHook || executingAgentCommand;
}
