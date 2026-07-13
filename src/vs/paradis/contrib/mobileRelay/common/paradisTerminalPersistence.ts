/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** PTY再生成で数値IDが変わっても維持されるnonceを、モバイル公開用の名前空間へ変換する。 */
export function terminalKeyFromShellIntegrationNonce(shellIntegrationNonce: string): string {
	return `terminal:${shellIntegrationNonce}`;
}

/** pane tokenもreviveされるPTY nonceから決定し、数値persistentProcessIdへ依存させない。 */
export function paneTokenFromShellIntegrationNonce(shellIntegrationNonce: string): string {
	return shellIntegrationNonce;
}

/** revive/detach元PTYが保持する実tokenを優先し、新規PTYだけnonceをtokenとして使う。 */
export function restoredPaneToken(shellIntegrationNonce: string, revivedPaneToken: string | undefined): string {
	return revivedPaneToken !== undefined && revivedPaneToken.length > 0 && revivedPaneToken.length <= 200
		? revivedPaneToken
		: paneTokenFromShellIntegrationNonce(shellIntegrationNonce);
}
