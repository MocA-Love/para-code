/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';

/**
 * クリップボードが「テキストなし・画像のみ」（macOSのスクリーンショット等）のとき、
 * ターミナル内のTUI（Claude Code / Codex / opencode 等）が画像添付のトリガーとして
 * 監視している Ctrl+V (0x16) を生バイトでPTYへ送る。
 *
 * `raw.input()` は bracketed paste のラップも kitty CSI-u エンコードも通らず、
 * onData 経由で 0x16 がそのまま PTY に書き込まれる。TUI側はこれを合図に自分で
 * OSクリップボードから画像を読み取るため、画像データ自体をターミナルへ流す必要はない。
 *
 * 呼び出し元（terminal.clipboard.contribution.ts の paste()）でテキストとファイルパスの
 * 解決が両方空振りした場合のみ呼ぶこと。テキストペーストの既存挙動
 * （複数行警告・末尾改行剥がし・onWillPaste/onDidPaste）には一切影響させない。
 *
 * @returns 画像を検出して 0x16 を送った場合は true、クリップボードに画像が無い場合は false
 */
export async function paradisTryTerminalImagePaste(clipboardService: IClipboardService, xterm: { raw: RawXtermTerminal }): Promise<boolean> {
	let image: Uint8Array;
	try {
		image = await clipboardService.readImage();
	} catch {
		// クリップボードアクセス失敗時はテキストペーストの既存経路へフォールスルーさせる
		return false;
	}
	if (image.length === 0) {
		return false;
	}
	xterm.raw.input('\x16', true);
	return true;
}
