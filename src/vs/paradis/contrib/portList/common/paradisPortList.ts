/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポート一覧ウィジェット(PortKiller風)の共有型定義。
// データ源はローカル(shared process、node/paradisPortListChannel.ts)とリモート(REHサーバー、
// node/paradisPortListChannelServer.ts)の2箇所にあり、rendererはどちらへ問い合わせているかを
// electron-browser/paradisPortListClient.ts で切り替える。

export const PARADIS_PORT_LIST_CHANNEL = 'paradisPortList';

/** 現状は node/{paradisPortListChannel,paradisPortListChannelServer}.ts のどちらもTCPしか
 * 収集しないため 'UDP' は生成されない。将来UDP対応する際の型の器として残してある。 */
export type ParadisPortProtocol = 'TCP' | 'UDP';

export interface IParadisPortEntry {
	readonly port: number;
	readonly proto: ParadisPortProtocol;
	readonly pid: number;
	readonly processName: string;
	/** バインド先アドレス(表示用にそのまま出す。例: '127.0.0.1', '*', '::1')。 */
	readonly address: string;
	/** 全インターフェースへ公開されている('0.0.0.0'・'*'・'::' 相当)。 */
	readonly risky: boolean;
}

export interface IParadisPortListSnapshot {
	readonly entries: readonly IParadisPortEntry[];
	readonly collectedAt: number;
}

export interface IParadisPortListRequest {
	readonly force?: boolean;
}

/**
 * kill時に一覧取得時点のスナップショット値をそのまま渡す。サーバー側はkill直前に同じPIDが
 * 同じポートを今もlistenしているか再確認してから終了させる(TOCTOU対策。PIDは再利用されうる
 * ため、一覧提示から実行までの間に無関係な別プロセスへ入れ替わっている可能性がある)。
 */
export interface IParadisPortKillRequest {
	readonly port: number;
	readonly pid: number;
	readonly processName: string;
}

export function paradisIsRiskyPortAddress(address: string): boolean {
	// '0:0:0:0:0:0:0:0' は REHサーバー側(node/paradisPortListChannelServer.ts)の
	// parseHexAddress が全ゼロIPv6を展開形で返すために出てくる表記(圧縮形の '::' にはならない)。
	return address === '*' || address === '0.0.0.0' || address === '::' || address === '[::]' || address === '0:0:0:0:0:0:0:0';
}
