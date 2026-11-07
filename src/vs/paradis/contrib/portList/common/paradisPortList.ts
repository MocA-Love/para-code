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

/** 内蔵ブラウザの新しいタブが使う、待ち受けのポートと持ち主のプロセスの作業フォルダ。 */
export interface IParadisPortServerEntry extends IParadisPortEntry {
	/** プロセスの作業フォルダ（cwd）。取れない OS（Windows）や権限の無いプロセスでは undefined。 */
	readonly cwd?: string;
}

export interface IParadisPortServersSnapshot {
	readonly entries: readonly IParadisPortServerEntry[];
	/** ポートを集めたマシンのホームフォルダ。スペースのフォルダがホームそのものなら、作業フォルダで絞らないために使う。 */
	readonly homeDir: string;
	readonly collectedAt: number;
}

/** ページの題とアイコンを読みに行くポート。待ち受けのアドレスが loopback か全公開のものだけ読む。 */
export interface IParadisPortPageRequest {
	readonly port: number;
	readonly address: string;
}

export interface IParadisPortPageInfo {
	readonly port: number;
	/** `GET /` が 2xx の HTML を返したか。false なら題もアイコンも無い。 */
	readonly isPage: boolean;
	readonly scheme: 'http' | 'https';
	readonly title?: string;
	/** 64 KB 以下のアイコンを data URL にしたもの。 */
	readonly faviconDataUrl?: string;
}

/** 1 回の問い合わせで題を読みに行くポートの上限（新しいタブを開くたびに多数のサーバーへ要求を送らないため）。 */
export const PARADIS_PORT_PAGE_PROBE_LIMIT = 16;

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

export interface IParadisPortKillBatchResult {
	readonly failed: number;
}

export function paradisIsRiskyPortAddress(address: string): boolean {
	// '0:0:0:0:0:0:0:0' は REHサーバー側(node/paradisPortListChannelServer.ts)の
	// parseHexAddress が全ゼロIPv6を展開形で返すために出てくる表記(圧縮形の '::' にはならない)。
	return address === '*' || address === '0.0.0.0' || address === '::' || address === '[::]' || address === '0:0:0:0:0:0:0:0';
}
