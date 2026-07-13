/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';

/** PTY再生成で数値IDが変わっても維持されるnonceを、モバイル公開用の名前空間へ変換する。 */
export function terminalKeyFromShellIntegrationNonce(shellIntegrationNonce: string): string {
	return `terminal:${shellIntegrationNonce}`;
}

/** Renderer・アプリ終了ではPTYが復元されるため関連メタデータを保持し、実際に閉じた場合だけ削除する。 */
export function shouldRemovePersistedTerminalIdentity(reason: TerminalExitReason | undefined): boolean {
	return reason === TerminalExitReason.User
		|| reason === TerminalExitReason.Process
		|| reason === TerminalExitReason.Extension;
}
