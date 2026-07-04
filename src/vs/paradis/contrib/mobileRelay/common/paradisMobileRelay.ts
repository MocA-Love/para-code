/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルリレー機能の設定キー・IPCチャネル契約・共有型。
//
// アーキテクチャ（設計書 §4）:
//  - shared process: リレーWSS接続 + E2E暗号 + フレーム多重化を所有（ウィンドウreloadに非依存、
//    Node webcryptoでX25519が確実に動く）
//  - renderer(window): 自ワークスペースのターミナル/状態を提供し、ペアリングUIを表示
// 両者は ISharedProcessService の IPC チャネル（下記）で接続する。

import { Event } from '../../../../base/common/event.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ChannelId } from './paradisMobileProtocol.js';

// ---- 設定キー ----

/** リレー接続の常駐を有効化する。ペアリング済みデバイスがあれば起動時に自動接続。 */
export const PARADIS_MOBILE_ENABLED_KEY = 'paradis.mobile.enabled';
/** リレーのベースURL（セルフホスト用）。 */
export const PARADIS_MOBILE_RELAY_URL_KEY = 'paradis.mobile.relayUrl';

export const PARADIS_MOBILE_DEFAULT_RELAY_URL = 'wss://para-mobile-relay.paradis.workers.dev';

// ---- IPC チャネル ----

export const PARADIS_MOBILE_RELAY_CHANNEL = 'paradisMobileRelay';

/** shared process の接続状態。 */
export type ParadisMobileConnectionState = 'disabled' | 'disconnected' | 'connecting' | 'online';

/** 現在のリレー状態のスナップショット。 */
export interface IParadisMobileStatus {
	readonly state: ParadisMobileConnectionState;
	readonly deviceId: string | undefined;
	/** 承認済みモバイルデバイスの表示名一覧。 */
	readonly pairedDevices: readonly string[];
	/** 現在オンラインのモバイル接続数。 */
	readonly onlineMobiles: number;
}

/** ペアリング開始時に renderer へ返す、QR/検証コード表示用の情報。 */
export interface IParadisMobilePairingSession {
	readonly deviceId: string;
	/** QRコードにエンコードする paracode-mobile://pair URI。 */
	readonly pairingUri: string;
	/** 手動入力用の6桁ペアリングトークン先頭（表示用ではなくSAS確認を使うため参考値）。 */
	readonly expiresAt: number;
}

/** ペアリング進行イベント（shared process → renderer）。 */
export type ParadisMobilePairingEvent =
	// モバイルが接続してハンドシェイクが進み、SAS検証コードが確定した
	| { readonly kind: 'awaiting-approval'; readonly sasCode: string; readonly proposedName: string }
	// ペアリング成立
	| { readonly kind: 'paired'; readonly deviceName: string }
	// タイムアウト/失敗/拒否
	| { readonly kind: 'failed'; readonly reason: string };

/** renderer ⇔ shared process のフレーム。 */
export interface IParadisMobileInboundFrame {
	readonly ch: ChannelId;
	readonly ws: string | undefined;
	readonly seq: number;
	readonly payload: VSBuffer;
	/**
	 * 対象/送信元モバイルのID。
	 * - shared process → renderer（受信）: フレームの送信元モバイル。
	 * - renderer → shared process（送信）: 宛先モバイル。省略時は全オンラインモバイルへ
	 *   ブロードキャスト（state スナップショット等、全デバイス共通の情報向け）。指定時は
	 *   そのモバイルにのみ送る（ターミナル出力など、要求元だけに返すべき情報向け。M-2）。
	 */
	readonly mobileId?: string;
}

/**
 * shared process 側チャネルが公開するメソッド/イベント（renderer から call/listen する）。
 * ProxyChannel.fromService で自動チャネル化するため、メソッドは async、イベントは Event<T> とする。
 */
export interface IParadisMobileRelayService {
	readonly _serviceBrand: undefined;

	// 起動時初期化（enabled と relayUrl を渡す。renderer から1回呼ぶ）
	initialize(enabled: boolean, relayUrl: string | undefined): Promise<void>;

	// 状態
	readonly onDidChangeStatus: Event<IParadisMobileStatus>;
	getStatus(): Promise<IParadisMobileStatus>;

	// 有効/無効
	setEnabled(enabled: boolean): Promise<void>;

	// ペアリング
	readonly onPairingEvent: Event<ParadisMobilePairingEvent>;
	beginPairing(): Promise<IParadisMobilePairingSession>;
	approvePairing(): Promise<void>;
	cancelPairing(): Promise<void>;
	/** 承認済みデバイスを失効させる。 */
	revokeDevice(deviceName: string): Promise<void>;

	// フレーム: shared process が復号したモバイル→PCフレームを renderer へ配送
	readonly onInboundFrame: Event<IParadisMobileInboundFrame>;
	// renderer → shared process: PC→モバイルフレームを封緘して送出
	sendFrame(frame: IParadisMobileInboundFrame): Promise<void>;
}
