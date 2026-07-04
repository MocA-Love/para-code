/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スリープ防止機能（paradis.power.keepAwake）の設定キー・コマンドID・共有定数。

export const PARADIS_KEEP_AWAKE_SETTING = 'paradis.power.keepAwake';

/**
 * スリープ防止のモード。
 * - off: 何もしない（既定）
 * - system: システムスリープのみ防止。画面の消灯・ロックは許容し、その間もプロセスは動き続ける
 * - display: 画面スリープも防止。無操作による自動ロックも発動しなくなる
 */
export type ParadisKeepAwakeMode = 'off' | 'system' | 'display';

/** 設定値を安全に正規化する（不正値は 'off' 扱い）。 */
export function toParadisKeepAwakeMode(value: unknown): ParadisKeepAwakeMode {
	return value === 'system' || value === 'display' ? value : 'off';
}

/** ステータスバークリック等から呼ぶ、モード選択Quick Pickを開くコマンド。 */
export const PARADIS_KEEP_AWAKE_SELECT_COMMAND = 'paradis.power.selectKeepAwakeMode';

/**
 * モバイルデバイス接続時などリモート作業の開始点から呼ぶ内部コマンド。
 * 設定が 'off' の場合のみ、スリープ防止を有効にするよう推奨する通知を出す
 * （「今後表示しない」選択可）。将来の mobileRelay contribution はこのコマンドIDを
 * executeCommand するだけでよく、import依存は発生しない。
 */
export const PARADIS_KEEP_AWAKE_PROMPT_COMMAND = 'paradis.power.promptKeepAwakeForRemote';
