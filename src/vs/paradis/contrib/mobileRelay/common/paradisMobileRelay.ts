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
import { IParadisMobileWindowLease } from './paradisMobileWindowLease.js';

// ---- 設定キー ----

/** リレー接続の常駐を有効化する。ペアリング済みデバイスがあれば起動時に自動接続。 */
export const PARADIS_MOBILE_ENABLED_KEY = 'paradis.mobile.enabled';
/** リレーのベースURL（セルフホスト用）。 */
export const PARADIS_MOBILE_RELAY_URL_KEY = 'paradis.mobile.relayUrl';
/** 実験的: 稼働中Codex app-server daemonからトークン単位の進捗通知を購読する。 */
export const PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY = 'paradis.mobile.agent.codexDaemonStreaming';

// 2026-07-05 デプロイ済み（本番Cloudflareアカウント、app/relay/wrangler.jsonc参照）。
export const PARADIS_MOBILE_DEFAULT_RELAY_URL = 'wss://para-mobile-relay.cloudflare8234.workers.dev';

// ---- IPC チャネル ----

export const PARADIS_MOBILE_RELAY_CHANNEL = 'paradisMobileRelay';
/** complete/operation sequence/Renderer世代を必須化した公開PC↔mobile契約。 */
export const PARADIS_MOBILE_PROTOCOL_VERSION = 3;

export interface IParadisConfirmedAgentPanes {
	readonly revision: number;
	readonly tokens: readonly string[];
}

/** protocol v2: renderer が shared process へ同期するワークスペース。 */
export interface IParadisMobileWindowWorkspaceV2 {
	readonly id: string;
	readonly name: string;
	readonly color?: string;
	readonly branch?: string;
	readonly parent?: string;
	readonly pr?: { readonly number: number; readonly state: 'open' | 'draft' | 'merged' | 'closed'; readonly url: string };
}

/** protocol v2: renderer 内のターミナル。id はこのウィンドウ内でのみ一意。 */
export interface IParadisMobileWindowTerminalV2 {
	readonly terminalKey: string;
	readonly id: number;
	readonly title: string;
	readonly ws?: string;
	readonly agent?: boolean;
	readonly agentToken?: string;
	readonly agentStatus?: string;
	readonly cols?: number;
	readonly rows?: number;
}

/** protocol v2: renderer 一つ分の状態。 */
export interface IParadisMobileWindowStateV2 {
	readonly activeWs: string | undefined;
	readonly workspaces: readonly IParadisMobileWindowWorkspaceV2[];
	readonly terminals: readonly IParadisMobileWindowTerminalV2[];
}

/** protocol v2: shared process が付与する、全ウィンドウで一意なワークスペース。 */
export interface IParadisMobileWorkspaceV2 extends Omit<IParadisMobileWindowWorkspaceV2, 'id' | 'parent'> {
	readonly id: string;
	readonly sourceId: string;
	readonly windowId: number;
	readonly parent?: string;
}

/** protocol v3: shared process が付与する所有Renderer付きターミナル。 */
export interface IParadisMobileTerminalV3 extends IParadisMobileWindowTerminalV2 {
	readonly windowId: number;
	readonly rendererGeneration: number;
}

/** protocol v3: Main manifest上のRendererと、そのstate同期barrier。 */
export interface IParadisMobileRendererStateV3 {
	readonly windowId: number;
	readonly rendererGeneration: number;
	readonly ready: boolean;
}

/** protocol v3: モバイルへ送る全PCウィンドウの統合状態。 */
export interface IParadisMobileDesktopStateV3 {
	readonly protocolVersion: 3;
	readonly desktopEpoch: string;
	readonly revision: number;
	readonly complete: boolean;
	readonly renderers: readonly IParadisMobileRendererStateV3[];
	readonly activeWs: string | undefined;
	readonly workspaces: readonly IParadisMobileWorkspaceV2[];
	readonly terminals: readonly IParadisMobileTerminalV3[];
}

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
 * onInboundFrame のIPCワイヤ形式。IParadisMobileInboundFrameオブジェクトをそのままイベント
 * データにすると、IPCの引数シリアライザがpayload(VSBuffer)をネストされたプロパティとして
 * JSON.stringifyしてしまいバイト列が壊れる（sendFrameと同じ理由）。タプル配列にすると
 * 各要素がトップレベル値としてシリアライズされ、VSBufferが正しくバイナリのまま転送される。
 */
export type ParadisMobileInboundFrameWire = readonly [ch: ChannelId, ws: string | undefined, seq: number, payload: VSBuffer, mobileId: string | undefined];

export type ParadisMobileTerminalOperationStatus = 'accepted' | 'stale-epoch' | 'terminal-not-found' | 'failed' | 'stale-renderer' | 'outcome-unknown';

/** Renderer宛フレームをwindow IDだけでなく起動世代にも固定する。 */
export function paradisMobileWindowRoute(windowId: number, windowSession: string, rendererGeneration: number): string {
	return `window:${windowId}:${rendererGeneration}:${windowSession}`;
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
	readonly onInboundFrame: Event<ParadisMobileInboundFrameWire>;
	/** hookまたは検証済みtranscriptで実在セッションが確定したペイントークン一覧。 */
	readonly onDidChangeConfirmedAgentPanes: Event<IParadisConfirmedAgentPanes>;
	getConfirmedAgentPanes(): Promise<IParadisConfirmedAgentPanes>;
	// renderer → shared process: PC→モバイルフレームを封緘して送出。
	// payload(VSBuffer)はIPCの引数シリアライザがVSBufferをバイナリのまま転送できるよう
	// トップレベル引数として渡す（IParadisMobileInboundFrameオブジェクトへネストすると
	// serialize()のObject分岐でJSON.stringifyされ、VSBufferの中身が壊れる）。
	sendFrame(lease: IParadisMobileWindowLease, ch: ChannelId, ws: string | undefined, mobileId: string | undefined, payload: VSBuffer): Promise<void>;

	/** renderer 一つ分の protocol v2 状態を shared process の統合 registry へ同期する。 */
	syncTerminalWindow(lease: IParadisMobileWindowLease, state: IParadisMobileWindowStateV2): Promise<void>;
	/** dispose された renderer の lease を、session が現在値と一致する場合だけ解除する。 */
	removeTerminalWindow(lease: IParadisMobileWindowLease): Promise<void>;
	/** Rendererで実際に操作が完了した後、そのleaseからだけ最終結果を確定する。 */
	completeTerminalOperation(lease: IParadisMobileWindowLease, mobileId: string, operationId: string, status: ParadisMobileTerminalOperationStatus): Promise<void>;

	/**
	 * scmチャネル用のgit実行（rendererはプロセスを起動できないためshared processで実行）。
	 * サブコマンドはサービス実装側の許可リストで制限される。
	 */
	runGit(repoPath: string, args: readonly string[]): Promise<IParadisGitResult>;

	/**
	 * agentチャネル用: 「ターミナルinstanceId ⇔ ペイントークン」対応表の同期（ウィンドウ単位の全置換。
	 * shared process は全ウィンドウ共有のため、windowId で自ウィンドウの分だけを置き換える）。
	 * renderer がターミナル一覧の変化に合わせて呼び、ウィンドウを閉じる際は空配列で自分の分を消す。
	 * モバイルの端末操作はwindowId + terminalId、エージェント操作はさらにペイントークンで識別する。
	 */
	syncAgentPanes(lease: IParadisMobileWindowLease, revision: number, entries: readonly { terminalId: number; token: string; cwd?: string; ws?: string }[]): Promise<void>;
	/** rendererがAgent Actionを実行する直前に、shared processのsession epochを再検証して一度だけclaimする。 */
	claimAgentAction(mobileId: string, requestId: string, token: string, epoch: string, lease: IParadisMobileWindowLease): Promise<'claimed' | 'stale' | 'expired'>;
	/** interactionキー列の待機区間ごとに、sessionとinteractionが継続中か再検証する。 */
	continueAgentInteraction(mobileId: string, requestId: string, token: string, epoch: string, terminalId: number, lease: IParadisMobileWindowLease): Promise<'valid' | 'completed' | 'stale'>;
	/** renderer側のinteractionキー列が成功・失敗・取消のいずれかで終了したことを通知し、排他claimを解放する。 */
	finalizeAgentInteraction(mobileId: string, requestId: string, token: string, outcome: 'accepted' | 'failed', lease: IParadisMobileWindowLease): Promise<void>;
	/** 長時間Action完了時にsession/ownerがclaim時と同じか確認する。 */
	validateAgentAction(mobileId: string, requestId: string, token: string, epoch: string, terminalId: number, lease: IParadisMobileWindowLease): Promise<boolean>;

	/**
	 * renderer → shared process: このウィンドウのフォーカス状態を報告する（PCフォーカス中の
	 * モバイル通知抑制、suppressWhenPcFocused用）。IHostService.hasFocusはウィンドウ単位・
	 * shared processは全ウィンドウ共有のため、windowIdキーで管理し「いずれかのウィンドウが
	 * フォーカス中ならPCフォーカス中」と判定する。ウィンドウを閉じる際は focused=false で送る。
	 */
	setPcFocus(lease: IParadisMobileWindowLease, focused: boolean): Promise<void>;

	/**
	 * agentチャネル用: ターミナルで `claude` / `codex` コマンドの実行開始を検知した (shell
	 * integration 由来)。起動の確定情報としては使わず、そのペインの cwd ベースのセッション探索を
	 * 前倒しするトリガーとしてのみ使う (実在する新しい transcript の発見をもって確定するため、
	 * `claude --help` のような空振りは誤検知にならない)。
	 */
	notifyAgentCliCommand(lease: IParadisMobileWindowLease, paneToken: string, agent: 'claude' | 'codex', mode: 'new' | 'resume' | 'fork', cwd: string | undefined, commandCwd?: string, sessionId?: string): Promise<void>;
	/** 対話型Agent CLIが終了した。TUI内resume監視と一時状態を解除する。 */
	notifyAgentCliCommandFinished(lease: IParadisMobileWindowLease, paneToken: string): Promise<void>;

	/** 実験的Codex daemon購読の設定をshared processへ同期する。 */
	setAgentLiveOptions(options: { readonly codexDaemonStreaming: boolean }): Promise<void>;

	/** PTY表示からbest-effort抽出した経過時間等を既存ライブ状態へ補足する。 */
	notifyAgentTerminalHint(lease: IParadisMobileWindowLease, terminalId: number, hint: { readonly elapsedSeconds?: number; readonly tokenCount?: number }): Promise<void>;

	/** fsチャネル用: ripgrepによるファイル名検索（.gitignore尊重・再帰）。 */
	searchFiles(rootPath: string, query: string, maxResults: number): Promise<{ files: string[]; truncated: boolean }>;

	/** fsチャネル用: ripgrepによるテキスト全文検索（スマートケース・リテラル一致）。 */
	searchText(rootPath: string, query: string, maxResults: number): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }>;
}

/** runGit の結果。 */
export interface IParadisGitResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}
