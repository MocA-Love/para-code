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

/** nonceを同一性の基準に使ってよいか検証する。長さ上限はPTY env経由のpane tokenと揃える。 */


/**
 * 同一性の基準として使える shell integration nonce だけを通す。
 *
 * nonce は persistentProcessId と違い revive を跨いで不変なので、世代を跨ぐ突き合わせに使える
 * 唯一の識別子。ただし `DetachedTerminal` は空文字を持つため、素通しすると「空文字キーで
 * 全インスタンスが衝突する」という新しい取り違えを作ってしまう。ここで必ず弾く。
 */
// PARA-PATCH: the pty host validates nonces too, so the single definition lives in the platform layer
export { paradisTerminalIdentityNonce } from '../../../../platform/terminal/common/terminal.js';

/** revive/detach元PTYが保持する実tokenを優先し、新規PTYだけnonceをtokenとして使う。 */
export function restoredPaneToken(shellIntegrationNonce: string, revivedPaneToken: string | undefined): string {
	return revivedPaneToken !== undefined && revivedPaneToken.length > 0 && revivedPaneToken.length <= 200
		? revivedPaneToken
		: paneTokenFromShellIntegrationNonce(shellIntegrationNonce);
}

/**
 * Stable terminal-key ownership. A persistent PTY can briefly have both its
 * detached and reattached renderer instances alive; the newest binding is the
 * authority and a delayed dispose from the old instance must not remove it.
 */
export class ParadisTerminalIdentityIndex {
	private readonly keyByInstanceId = new Map<number, string>();
	private readonly instanceIdByKey = new Map<string, number>();

	bind(instanceId: number, terminalKey: string): void {
		const previousKey = this.keyByInstanceId.get(instanceId);
		if (previousKey !== undefined && previousKey !== terminalKey && this.instanceIdByKey.get(previousKey) === instanceId) {
			this.instanceIdByKey.delete(previousKey);
		}

		const previousInstanceId = this.instanceIdByKey.get(terminalKey);
		if (previousInstanceId !== undefined && previousInstanceId !== instanceId) {
			this.keyByInstanceId.delete(previousInstanceId);
		}

		this.keyByInstanceId.set(instanceId, terminalKey);
		this.instanceIdByKey.set(terminalKey, instanceId);
	}

	unbind(instanceId: number): void {
		const terminalKey = this.keyByInstanceId.get(instanceId);
		this.keyByInstanceId.delete(instanceId);
		if (terminalKey !== undefined && this.instanceIdByKey.get(terminalKey) === instanceId) {
			this.instanceIdByKey.delete(terminalKey);
		}
	}

	getTerminalKey(instanceId: number): string | undefined {
		return this.keyByInstanceId.get(instanceId);
	}

	getInstanceId(terminalKey: string): number | undefined {
		return this.instanceIdByKey.get(terminalKey);
	}
}
