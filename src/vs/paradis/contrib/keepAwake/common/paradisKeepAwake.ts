/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スリープ防止機能（paradis.power.keepAwake）の設定キー・コマンドID・共有定数。

export const PARADIS_KEEP_AWAKE_SETTING = 'paradis.power.keepAwake';

import type { IParadisAgentPaneStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';

/**
 * スリープ防止のモード。
 * - off: 何もしない
 * - auto: エージェントが作業中・許可待ち・質問中のペインがある間だけシステムスリープを防止する（既定）。
 *   同じ状態が {@link PARADIS_KEEP_AWAKE_AUTO_MAX_SAME_STATE_MS} 続いたペインは数えない
 *   （放置された許可待ちで一晩起き続けないため）
 * - system: 常にシステムスリープのみ防止。画面の消灯・ロックは許容し、その間もプロセスは動き続ける
 * - display: 常に画面スリープも防止。無操作による自動ロックも発動しなくなる
 */
export type ParadisKeepAwakeMode = 'off' | 'auto' | 'system' | 'display';

/** 実際に掛ける powerSaveBlocker の種類（auto は状況に応じて 'system' か 'off' に解決される）。 */
export type ParadisKeepAwakeBlockerMode = Exclude<ParadisKeepAwakeMode, 'auto'>;

/** 既定のモード。設定レジストリの既定値と、不正値の読み替え先を兼ねる。 */
export const PARADIS_KEEP_AWAKE_DEFAULT_MODE: ParadisKeepAwakeMode = 'auto';

/** auto モードで、同じ状態がこれ以上続いたペインはスリープ防止の理由として数えない。 */
export const PARADIS_KEEP_AWAKE_AUTO_MAX_SAME_STATE_MS = 2 * 60 * 60 * 1000;

/** 設定値を安全に正規化する（不正値は既定の 'auto' 扱い）。 */
export function toParadisKeepAwakeMode(value: unknown): ParadisKeepAwakeMode {
	return value === 'off' || value === 'auto' || value === 'system' || value === 'display' ? value : PARADIS_KEEP_AWAKE_DEFAULT_MODE;
}

/**
 * auto モードでスリープを防ぐべきかどうか。作業中・許可待ち・質問中のペインが1つでもあり、かつ
 * その状態に入ってから {@link PARADIS_KEEP_AWAKE_AUTO_MAX_SAME_STATE_MS} 未満なら true。
 * 完了（review）やアイドル（エントリなし）は数えない。
 */
export function paradisAgentsNeedKeepAwake(paneStatuses: readonly Pick<IParadisAgentPaneStatus, 'status' | 'changedAt'>[], now: number): boolean {
	return paneStatuses.some(pane =>
		(pane.status === 'working' || pane.status === 'permission' || pane.status === 'question')
		&& now - pane.changedAt < PARADIS_KEEP_AWAKE_AUTO_MAX_SAME_STATE_MS);
}

/** ステータスバークリック等から呼ぶ、モード選択Quick Pickを開くコマンド。 */
export const PARADIS_KEEP_AWAKE_SELECT_COMMAND = 'paradis.power.selectKeepAwakeMode';

/**
 * モバイルデバイス接続時などリモート作業の開始点から呼ぶことを想定した内部コマンド。
 * 設定が 'off' の場合のみ、スリープ防止を有効にするよう推奨する通知を出す
 * （「今後表示しない」選択可）。コマンドとしては登録済みだが、現時点では
 * どこからも executeCommand されていない（mobileRelay contribution からの呼び出しは未実装）。
 */
export const PARADIS_KEEP_AWAKE_PROMPT_COMMAND = 'paradis.power.promptKeepAwakeForRemote';
