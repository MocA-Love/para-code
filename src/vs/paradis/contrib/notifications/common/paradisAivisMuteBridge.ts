/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// おやすみモードを Para Code の外にも波及させるための共有定義。
// Para Code 内の抑制は paradisNotificationTrigger.contribution.ts の _notify() が担うが、
// 別のターミナルや別のMCPクライアントから直接叩かれる aivis-mcp の発話はその対象外なので、
// おやすみモードの状態変化を `aivis --mute` / `--unmute` として aivis-mcp 側へ伝える。
// 実行本体は shared process 側（node/paradisAivisMuteBridgeChannel.ts）にある。

export const PARADIS_AIVIS_MUTE_BRIDGE_CHANNEL = 'paradisAivisMuteBridge';

export interface IParadisAivisMuteBridgeService {
	/**
	 * aivis-mcp 側のミュート状態をおやすみモードに合わせる。
	 * - `enabled` が false なら解除（`--unmute`）
	 * - `enabled` が true で `remainingMs` 未指定なら無期限のミュート
	 * - `enabled` が true で `remainingMs` 指定ありならその時間だけのミュート
	 *
	 * aivis コマンドが無い環境も正常系として扱うため、失敗しても reject しない。
	 */
	sync(enabled: boolean, remainingMs: number | undefined): Promise<void>;
}
