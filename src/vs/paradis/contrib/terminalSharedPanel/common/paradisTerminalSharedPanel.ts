/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 下部パネルの「共通ターミナル」（どのスペースにも属さないターミナル）の設定と判定。
//
// ふだんのターミナルはエディタのタブとしてスペースごとに持ち替わる。下部パネルのターミナルだけは
// スペースを切り替えても退避せず、スペースを消しても消えない共通の置き場にする。

import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IShellLaunchConfig, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';

/** 下部パネルのターミナルをスペース共通にするか。変更はウィンドウの再読み込み後に反映する。 */
export const PARADIS_TERMINAL_SHARED_PANEL_ENABLED = 'paradis.terminal.sharedPanel.enabled';

/** 共通ターミナルを新しく開くときのフォルダ。空ならホームフォルダ。 */
export const PARADIS_TERMINAL_SHARED_PANEL_CWD = 'paradis.terminal.sharedPanel.cwd';

/** 設定値を真偽に直す。未設定（既定値の読み込み前を含む）は有効として扱う。 */
export function paradisIsTerminalSharedPanelEnabled(value: unknown): boolean {
	return value !== false;
}

/**
 * この起動設定に共通ターミナルの開始フォルダを入れてよいか。
 *
 * 触るのは「パネルに新しく作る、フォルダの指定が無いシェル」だけ。分割（親の cwd を継ぐ）や
 * フォルダを選んで開いた場合、タスク・拡張機能・復元（attach）のターミナルは、呼び出し元が
 * 決めた場所をそのまま使う。拡張機能が作るターミナルも、拡張機能はワークスペースのフォルダで
 * 開く前提で作っているので触らない。
 */
export function paradisShouldApplySharedPanelCwd(shellLaunchConfig: IShellLaunchConfig, target: TerminalLocation): boolean {
	return target === TerminalLocation.Panel
		&& shellLaunchConfig.cwd === undefined
		&& shellLaunchConfig.attachPersistentProcess === undefined
		&& shellLaunchConfig.customPtyImplementation === undefined
		&& shellLaunchConfig.isFeatureTerminal !== true
		&& shellLaunchConfig.isExtensionOwnedTerminal !== true
		&& shellLaunchConfig.hideFromUser !== true
		&& shellLaunchConfig.type === undefined;
}

/**
 * 設定値から開始フォルダを決める。
 *
 * - 空: ホームフォルダ
 * - `~` / `~/...`: ホームフォルダからの相対
 * - 絶対パス: そのまま（接続先がある場合は接続先のパスとして扱う）
 * - それ以外の相対パス: ホームフォルダからの相対
 *
 * ホームフォルダの URI をそのまま土台にするので、SSH 接続中は接続先のフォルダになる。
 */
export function paradisResolveSharedPanelCwd(configured: unknown, userHome: URI): URI {
	const value = typeof configured === 'string' ? configured.trim() : '';
	if (value.length === 0 || value === '~') {
		return userHome;
	}
	if (value.startsWith('~/') || value.startsWith('~\\')) {
		return joinPath(userHome, value.slice(2));
	}
	const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(value);
	if (value.startsWith('/') || isWindowsAbsolute) {
		return userHome.scheme === Schemas.file
			? URI.file(value)
			: userHome.with({ path: isWindowsAbsolute ? `/${value.replace(/\\/g, '/')}` : value });
	}
	return joinPath(userHome, value);
}
