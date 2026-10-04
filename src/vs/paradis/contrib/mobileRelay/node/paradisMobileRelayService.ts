/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisAgentHookRemoteHostId } from '../../agentBrowser/common/paradisAgentHooks.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createHash } from 'crypto';
import { hostname } from 'os';
import { reportParadisDiagnosticError, runInParadisSpan, setParadisDiagnosticCorrelationTag } from '../../sentry/common/paradisSentryDiagnostics.js';
import {
	MobileIdentity,
	SecureChannel,
	deriveNotifyKey,
	deriveSasCode,
	generatePersistableIdentity,
	importIdentity,
	respondHandshake,
	sealNotify,
} from '../common/paradisMobileCrypto.js';
import { FrameMux, IParadisMobileFrameTrafficSample } from '../common/paradisMobileMux.js';
import { ParadisMobileSendQueue } from '../common/paradisMobileSendQueue.js';
import { IParadisCdpFrameSubscription, IParadisSharedPageBindings } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { ParadisCdpUpstream } from '../../agentBrowser/node/paradisCdpUpstream.js';
import { ParadisMobileAgentChat } from './paradisMobileAgentChat.js';
import { ParadisRemoteTranscriptMirrorStore } from './paradisRemoteTranscriptMirror.js';
import { ParadisAgentSessionStore } from './paradisAgentSessionStore.js';
import { paradisMobileDismissTags, paradisMobilePushIds } from './paradisMobilePushIds.js';
import { IParadisRelayPairedMobile, IParadisRelayPersistedState, ParadisRelayStoreProblem, paradisMoveRelayStateAside, paradisPruneRelayStateLeftovers, paradisReadRelayState, paradisWriteRelayState } from './paradisMobileRelayStateFile.js';
import { ParadisMobileBrowserMirror } from './paradisMobileBrowserMirror.js';
import { IParadisMobileBrowserScopeSnapshot, paradisMobileBrowserViewsInSpace, paradisSanitizeMobileBrowserScopeSnapshot } from '../common/paradisMobileBrowserScope.js';
import { BrowserSearchEngineSettingId } from '../../../../workbench/contrib/browserView/common/browserSearch.js';
import { ParadisMobileTerminalRegistry } from './paradisMobileTerminalRegistry.js';
import {
	Channels,
	ChannelId,
	decodeParadisMobileWarmLeaseRequest,
	decodeNotifyControl,
	decodeRelayControl,
	encodeNotify,
	encodeNotifyDismissed,
	encodeNotifyDismissedByToken,
	ParadisNotifyQuiet,
	peekNotifyMeta,
	encodeRelayControl,
	encodePairingUri,
	fromBase64Url,
	mobileIdToString,
	NotifyPayload,
	PARADIS_RELAY_KEEPALIVE_PING,
	packPcData,
	toBase64Url,
	unpackPcData,
} from '../common/paradisMobileProtocol.js';
import { PARADIS_MOBILE_BUILTIN_REQUEST_KINDS } from '../common/paradisMobileRequestKinds.js';
import { PARADIS_MOBILE_MIN_COMPATIBLE_MOBILE, paradisEvaluateMobileCompat, paradisHasMobileCapability, paradisIsAcceptedMobileWireVersion, paradisParseMobileCapabilities } from '../common/paradisMobileCompat.js';
import { PARADIS_PUSH_PAYLOAD_LIMIT_BYTES, ParadisMissedNotifyQueue, paradisNotifyIncludeContent, paradisNotifyPcFocusQuiet, paradisNotifyPrefersDetail, paradisResolveNotifyDelivery } from '../common/paradisNotifyDelivery.js';
import { PARADIS_NOTIFY_DETAIL_MAX_CHARS, paradisComposeNotifyVariants, paradisFitNotifyBytesForPush, paradisLegacyNotifySubtitle, paradisNotifyTabLabel } from '../common/paradisNotifyCompose.js';
import { ParadisNotifyHookLedger, paradisResolveNotifyContent } from './paradisNotifyContentSource.js';
import { decodeNotifyVisibility, encodeNotifyVisibilityAck } from '../common/paradisMobileVisibility.js';
import { ParadisNotifyDismissLedger, paradisNotifyDismissOpened, paradisWithNotifyDismiss } from '../common/paradisNotifyDismissLedger.js';
import { ParadisBackgroundSessionWatch, ParadisRecentTrustedNotifies } from '../common/paradisMobileBackgroundGrace.js';
import { paradisClassifyRevokeResponse, paradisEnqueueRevoke, paradisRevokeRetried, paradisSanitizeRevokeOutbox, type IParadisRelayRevokeEntry } from '../common/paradisRelayRevokeOutbox.js';
import { paradisAgentLabel, paradisNotifyTitle } from '../common/paradisNotifyPresentation.js';
import { IParadisAgentPaneInsight, IParadisAgentPaneInsightSource } from '../../agentInsights/common/paradisAgentInsights.js';
import { IParadisAgentChatCommand, IParadisAgentChatCursor, IParadisAgentChatImageData, IParadisAgentChatSource, IParadisAgentChatView } from '../../agentChat/common/paradisAgentChat.js';
import {
	IParadisConfirmedAgentPanes,
	IParadisMobileInboundFrame,
	IParadisMobileWindowStateV2,
	IParadisMobilePairingSession,
	IParadisMobileRelayService,
	IParadisMobileStatus,
	PARADIS_MOBILE_DEFAULT_RELAY_URL,
	PARADIS_MOBILE_PROTOCOL_VERSION,
	ParadisMobileConnectionState,
	ParadisMobileInboundFrameWire,
	ParadisMobilePairingEvent,
	ParadisMobileTerminalOperationStatus,
	paradisFormatPcName,
	paradisMobileWindowRoute,
} from '../common/paradisMobileRelay.js';
import { IParadisMobileWindowLeaseRef, ParadisMobileOperationLedger } from './paradisMobileOperationLedger.js';
import { IParadisMobileRendererManifest, IParadisMobileWindowLease, ParadisMobileWindowLeaseClient } from '../common/paradisMobileWindowLease.js';
import { IParadisMobilePaneOwner } from './paradisMobilePaneRegistry.js';
import { ParadisAgentCommandAuthority, ParadisAgentCommandDeliveryResult } from '../common/paradisAgentCommandLifecycle.js';
import { ParadisMobileTrafficDiagnostics, startParadisMobileTrafficDiagnostics } from './paradisMobileTrafficDiagnostics.js';
import { ParadisMobileStateDelivery } from './paradisMobileStateDelivery.js';
import { paradisRoundMobileResources } from '../common/paradisMobileHostResources.js';
import { ParadisHostResourceSampler } from '../../resourceMonitor/node/paradisHostResources.js';
import { paradisDecodeBinaryFsUpload } from '../common/paradisMobileFileUpload.js';
import { ParadisRelayDisconnectReporter } from '../common/paradisRelayDisconnectReport.js';
import { PARADIS_RELAY_STABLE_CONNECTION_MS, paradisRelayJitteredDelayMs, paradisRelayReconnectDelayMs } from '../common/paradisRelayReconnectDelay.js';
import { ParadisVoiceSubscriptions } from '../common/paradisVoiceSubscriptions.js';
import { PARADIS_JSON_GZIP_RESPONSE_ENCODING, paradisEncodeNegotiatedGzipJsonResponse } from '../common/paradisMobileGzipJson.js';
import { paradisCreateVoiceDelivery } from './paradisVoiceClipDelivery.js';
import { ParadisMobileVoiceEvent } from '../common/paradisMobileVoiceStream.js';
import { paradisGetMachineIdHash } from '../../../node/paradisMachineId.js';
import { paradisClaudeModBridge } from '../../claudeMod/node/paradisClaudeModBridge.js';

/**
 * リレー接続の保活間隔。経路のアイドルタイムアウトより十分短く、かつ常時接続の台数分だけ
 * 発生するトラフィックなので無駄に短くもしない値として45秒を採る。死活検知は最悪2tick（90秒）。
 */
const RELAY_KEEPALIVE_INTERVAL_MS = 45_000;
/** WSハンドシェイクの応答を待つ上限（undiciの既定headersTimeout 300秒では復帰が遅すぎる）。 */
const RELAY_CONNECT_TIMEOUT_MS = 15_000;
/** これだけ連続でpongが返らなければ「このリレーは保活に応答しない」と学習し直す。 */
const RELAY_KEEPALIVE_TIMEOUT_GIVE_UP = 3;
/**
 * ws（ワークスペース）を持たないリクエストを windowId + rendererGeneration だけで配送してよい
 * 「接続先セグメント」向けの型一覧。provider(`paradisMobileWorkspaceProvider.ts`)側で
 * ws を見ずに処理する分岐と対応させること。ここに無い型（upload・worktree作成等、本来 ws による
 * 所有権検証を必要とする操作）は、ws を省略しても ws 経路の検証（`ownerOfWorkspace`）を通らず
 * 弾かれるようにする。
 */
const PARADIS_WORKSPACE_LESS_REQUEST_TYPES: ReadonlySet<string> = new Set(['usage', 'rtk', 'limits', 'github', 'sysres', 'spacedisk', 'hl']);
/**
 * 切断してからSentryへ報告するまでの猶予。
 *
 * 実測ではこの接続の切断はほぼ全てが経路側の異常切断（close code 1006、closeフレーム無し）で、
 * Macのスリープ復帰やネットワーク切替、リレー（Cloudflare Durable Object）の退避で日に数回起きる。
 * 再接続は初回500msで、ユーザーから見ればモバイルが一瞬オフラインになるだけの正常系なので、
 * 1回ごとにerrorとして上げると本物の障害がそのノイズに埋もれる。逆に完全に黙らせると、
 * リレーが実際に死んでいるケース（トークン失効で毎回1006、Worker障害）に気づけない。
 * そこで「猶予内に復帰できたら報告しない、できなければ報告する」に振り分ける。
 *
 * 60秒はバックオフ（完全ジッタ。n 回目は [0, min(30秒, 500ms×2^(n-1))) の一様乱数で平均はその半分）で
 * 平均8〜9回試行できる長さ（平均の累計は 6回で約16秒、7回で約31秒、8回で約46秒、9回で約61秒）＝
 * 一過性の切断なら必ず復帰している。
 */
const RELAY_DISCONNECT_REPORT_DELAY_MS = 60_000;
/**
 * 猶予切れの時点から、さらにこの回数だけ連続で再接続に失敗していなければ報告しない。
 *
 * 猶予（{@link RELAY_DISCONNECT_REPORT_DELAY_MS}）だけでは Mac のスリープを弾けない。スリープ中は
 * setTimeout も再接続タイマーも止まるため、復帰した瞬間に「猶予は過ぎている／再接続はまだ0回」と
 * いう状態でタイマーが発火し、実際には数百ms後に繋がる切断まで報告していた（実測でSentryの
 * desktop-relay グループの大半がこれ）。経過時間ではなく「起きている間に何回試して駄目だったか」を
 * 条件にすれば、スリープも一過性の経路断も落ちて、本当に復帰できない障害だけが残る。
 *
 * 5回は上限30秒のバックオフで約2.5分。猶予と合わせて「3分以上繋がらない」が報告の条件になる。
 */
const RELAY_DISCONNECT_REPORT_AFTER_ATTEMPTS = 5;
/**
 * 1006 での再接続がこの回数続いたら、pcToken がまだ有効かをHTTPで確かめる。
 *
 * WebSocketのハンドシェイクは、リレーが401で拒否した場合も経路が死んだ場合も undici からは
 * 全く同じ形（close 1006 / reason 空 / error メッセージ空）に見える。区別できないまま
 * 30秒間隔で永久に再試行していたため、トークンが失効すると再起動しても直らないのに
 * ユーザーには「なぜか繋がらない」としか見えなかった。
 */
const RELAY_AUTH_PROBE_AFTER_ATTEMPTS = 3;
/** 認証切れが確定した後の再接続間隔。復帰は再ペアリングでしか起きないので長く取る。 */
const RELAY_UNAUTHORIZED_RETRY_MS = 5 * 60_000;
/** スリープ復帰直後の ping に pong が返るのを待つ上限。平常の往復は数百ms。 */
const RELAY_RESUME_PROBE_TIMEOUT_MS = 5_000;
/**
 * 「このセッションはもう無い」とモバイルへ伝えるために送るバイト数。
 *
 * 中身に意味は無く、**確実に復号に失敗すること**だけが要件。封緘フレームは
 * 12Bカウンタnonce + 8Bフレームヘッダ + 16B GCMタグ で最低36Bあるので、それより短ければ
 * モバイルの `Cipher.open` が nonce を読む前に「message too short」で必ず落ちる
 * （鍵やカウンタの状態に依存しないので、どんな食い違い方をしていても同じ結果になる）。
 * 32Bはモバイル→PCの hello と同じ長さなので**避ける**（逆流時に自己回復の分岐と紛れる）。
 */
const PARADIS_MOBILE_RESYNC_MARKER_BYTES = 8;
/**
 * 確立済みのセッションを「食い違った」と見なすまでの連続復号失敗回数。
 *
 * 1回で畳まないのは、別ソケットをまたいだ順序逆転で遅れて届く迷子フレームがあるため
 * （`Cipher.open` は失敗時にカウンタを進めないので、1個では desync しない）。
 * 立ったばかりの健全なセッションを蹴らないための猶予。
 */
const PARADIS_MOBILE_RESYNC_AFTER_FAILURES = 3;
/**
 * ハンドシェイク中・直後の旧鍵フレームは想定内として Sentry へ送らないが、確立してから一度も
 * 復号できないまま、この件数に届いたら本当の異常として1回だけ送る（張り替えが回っていない）。
 */
const PARADIS_MOBILE_STALE_FRAME_REPORT_AFTER = 30;
/**
 * PC本体のCPU/メモリ/ディスクをサンプリングする間隔。CPU使用率はこの区間の平均になる。
 * 短くしても丸め（5%刻み）で潰れるだけで再送が増えるだけなので、これ以上は詰めない。
 */
const HOST_RESOURCE_SAMPLE_INTERVAL_MS = 10_000;
/**
 * リソースの変化だけを理由に desktop state を再送する最小間隔。
 * state はモバイル全台へのブロードキャスト（全ワークスペース・全ターミナルを含むJSON＋封緘）なので、
 * 10秒ごとに撃つと端末の無線を起こし続ける。ドロワーを開いたときに1分以内の値が出れば足りる。
 */
const HOST_RESOURCE_BROADCAST_MIN_INTERVAL_MS = 60_000;

type PersistedState = IParadisRelayPersistedState;

/**
 * 版が合わないアプリへ送る State の代わり。アプリは State の `protocolVersion` と `minCompatibleMobile` だけで
 * どちらを更新すべきか決める（`paradisEvaluateMobileCompat`）ので、それ以外は載せない。
 */
const PARADIS_MOBILE_PROTOCOL_GUIDANCE = new TextEncoder().encode(JSON.stringify({
	protocolVersion: PARADIS_MOBILE_PROTOCOL_VERSION,
	minCompatibleMobile: PARADIS_MOBILE_MIN_COMPATIBLE_MOBILE,
}));

/** 1つのモバイルとのデータ接続（ハンドシェイク進行 + 確立後のFrameMux）。 */
export class MobileSession {
	private channel: SecureChannel | undefined;
	private mux: FrameMux | undefined;
	private confirmed = false;
	private negotiatedProtocolVersion: number | undefined;
	private readonly stateDelivery = new ParadisMobileStateDelivery();
	// 受信payloadを厳密に直列化する（H-2/#17）。confirmed遷移をまたぐハンドシェイク期は
	// mux外なので、ここで直列化しないと同一TCPチャンクで届いたconfirmとアプリフレームが
	// 並行してpendingVerifyに流れ、nonceカウンタが恒久desyncする。
	private rxChain: Promise<void> = Promise.resolve();

	constructor(
		readonly mobileId: string,
		private readonly mobileIdBytes: Uint8Array,
		private readonly mobilePubKey: Uint8Array,
		private readonly pcIdentity: MobileIdentity,
		private readonly sendToRelay: (payload: Uint8Array) => boolean,
		private readonly onFrame: (frame: IParadisMobileInboundFrame) => void,
		private readonly onTraffic: ((sample: IParadisMobileFrameTrafficSample) => void) | undefined,
		private readonly logService: ILogService,
		/** 全端末で 1 本の送信の列（mux の版 4）。無ければこのセッションだけの列（テスト用）。 */
		private readonly sendQueue?: ParadisMobileSendQueue,
	) { }

	private _epoch = 0;

	/**
	 * 暗号セッションの世代。確立するたびに 1 つ進む。音声の流れは始めたときの世代を控え、
	 * 変わったら送るのをやめる（張り替えた後のアプリはその流れを知らない）。
	 */
	get epoch(): number {
		return this._epoch;
	}

	get isOnline(): boolean {
		return this.confirmed;
	}

	/**
	 * アプリが「裏に回った」と知らせてきて、まだ「前面に戻った」を受けていない（W2-34）。
	 * セッションごとに持つので、張り直した接続では必ず前面扱いから始まる（アプリは裏で張り直さない）。
	 */
	backgrounded = false;

	private _lastInboundAt = 0;

	/** 最後にこのモバイルから何か受け取ってからの経過ms。受信実績が無ければ `undefined`。 */
	msSinceLastInbound(now: number): number | undefined {
		return this._lastInboundAt === 0 ? undefined : now - this._lastInboundAt;
	}

	get hasCurrentProtocol(): boolean {
		return this.negotiatedProtocolVersion !== undefined;
	}

	/**
	 * このモバイルが State の要求で広告した capability（W2-17）。W2-17 より前のアプリ・未交渉は
	 * `undefined`（＝何も持っていない扱い。`paradisHasMobileCapability` は false を返す）。
	 */
	get capabilities(): readonly string[] | undefined {
		return this.negotiatedCapabilities;
	}

	private negotiatedCapabilities: readonly string[] | undefined;

	/** このセッションで話している版（窓の中で PC とアプリの古い方）。未交渉・版が合わないなら `undefined`。 */
	get wireVersion(): number | undefined {
		return this.negotiatedProtocolVersion;
	}

	/** 版の不一致をこのセッションで Sentry へ送ったか（アプリは State を何度も求めるので、1回に絞る）。 */
	private protocolMismatchReported = false;

	/**
	 * State の要求の版が合わなかった。このセッションへは State の代わりに版だけの案内を送る。
	 * 版 4 の断片は版 3 のアプリが組み立てられないので、案内は必ず断片に切らない大きさ（16KiB 以下）にする。
	 */
	private protocolBlocked = false;

	/**
	 * このモバイルがDesktop Stateの圧縮を明示的に要求したか（旧アプリは何も送らない）。
	 * **既定は必ず非圧縮**。gzipを無条件に送ると、旧アプリの `JSON.parse` が例外になり、
	 * それが受信側の catch に握り潰されて「エラー表示のないままホームが空で固まる」に化ける。
	 */
	private negotiatedStateEncoding: string | undefined;

	negotiateProtocol(payload: Uint8Array): boolean {
		let request: { protocolVersion?: unknown; minCompatiblePc?: unknown; capabilities?: unknown; stateEncoding?: unknown } = {};
		try {
			const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				request = parsed;
			}
		} catch {
			// 読めない要求は版 0 のアプリとして扱う（下の判定で「アプリが古い」になる）。
		}
		// 版の窓の判定はアプリと同じ関数で行う（paradisMobileCompat.ts）。minCompatiblePc を送らない
		// W2-17 より前のアプリは、これまでどおり版の完全一致だけが通る。
		const verdict = paradisEvaluateMobileCompat({
			mobileProtocolVersion: request.protocolVersion,
			mobileMinCompatiblePc: request.minCompatiblePc,
			pcProtocolVersion: PARADIS_MOBILE_PROTOCOL_VERSION,
			pcMinCompatibleMobile: PARADIS_MOBILE_MIN_COMPATIBLE_MOBILE,
		});
		this.negotiatedProtocolVersion = verdict.kind === 'ok' ? verdict.wireVersion : undefined;
		this.protocolBlocked = verdict.kind === 'blocked';
		this.negotiatedCapabilities = verdict.kind === 'ok' ? paradisParseMobileCapabilities(request.capabilities) : undefined;
		this.negotiatedStateEncoding = verdict.kind === 'ok' && request.stateEncoding === PARADIS_JSON_GZIP_RESPONSE_ENCODING
			? PARADIS_JSON_GZIP_RESPONSE_ENCODING
			: undefined;
		if (verdict.kind === 'blocked' && !this.protocolMismatchReported) {
			this.protocolMismatchReported = true;
			// 版数不一致は「繋がっているのに何も表示されない」形で現れる（アプリだけ更新した等）。
			// 無言で undefined にすると、片側の nonce エラーしか手掛かりが残らない。
			// どちらが古いかはアプリも State の minCompatibleMobile から同じ結論を出し、画面で案内する。
			reportParadisDiagnosticError('owned', 'mobile-e2e', 'protocol-mismatch', new Error('Mobile protocol version mismatch'), {
				phase: 'handshaking',
				transport: 'websocket',
				safe_expected: PARADIS_MOBILE_PROTOCOL_VERSION,
				safe_received: typeof request.protocolVersion === 'number' ? request.protocolVersion : -1,
				safe_reason: verdict.reason,
			});
		}
		return this.hasCurrentProtocol;
	}

	/**
	 * モバイルからのバイナリを受信キューに積む。前のpayload処理の完了後に順に処理し、
	 * confirmed遷移をまたぐ並行実行を防ぐ。返すPromiseはこのpayloadの処理完了で解決する
	 * （呼び出し側がisOnline遷移を検査できるように）。
	 */
	enqueuePayload(payload: Uint8Array): Promise<void> {
		// 通知の配送経路を決める材料。ソケットの有無ではなく「最後に本当に何か受け取った時刻」で
		// 生死を判断する（iOSはバックグラウンドでソケットをhalf-openのまま放置するため。
		// 詳細は paradisNotifyDelivery.ts）。復号前に更新するのは、届いたバイトそのものが
		// 「アプリのプロセスが動いている」証拠だから。
		this._lastInboundAt = Date.now();
		const result = this.rxChain.then(() => this.handlePayload(payload));
		// handlePayload は内部でcatch済みなのでrejectしないが、念のため鎖が切れないようにする。
		this.rxChain = result.catch(() => { });
		return result;
	}

	/** モバイルからのバイナリ（この mobileId 宛の payload）を処理する。 */
	private async handlePayload(payload: Uint8Array): Promise<void> {
		// この payload の失敗が「暗号層のもの」かどうか。**セッションを畳んでよいのは暗号層の
		// 失敗だけ**で、フレームを配ったあとのハンドラ例外（アプリ層のバグ）で畳むと、
		// 1フレーム捨てれば済んだものがモバイルの再接続に化ける。FrameMux は復号失敗を
		// onError で握り潰すので、ここに落ちる例外はハンドラ由来と復号由来が混ざる。
		let cryptoFailure = false;
		// 失敗したときに「想定内の旧鍵フレーム」とみなせるか。確立してから1つも復号できていない間
		// （ハンドシェイク中・直後）は、張り替え前の鍵で封緘されたフレームが遅れて届くのが普通。
		const settledAtStart = this.confirmed && this.decryptedSinceConfirm;
		try {
			if (!this.channel) {
				cryptoFailure = true;
				// 最初のバイナリは hello（ephemeral公開鍵32B）。responderハンドシェイクを実行。
				// response（=respEph+封緘ack）はそのまま relay 経由でモバイルへ返す
				// （sendToRelay が packPcData で mobileId を付ける）。
				const responder = await respondHandshake(this.pcIdentity, this.mobilePubKey, payload);
				cryptoFailure = false;
				this.channel = responder.channel;
				this.pendingVerify = responder.verifyConfirm;
				// 新しいセッションが立ったので、再ハンドシェイク要求の1回きり制限も解く
				// （このセッションが将来また食い違ったら、もう一度だけ知らせられるように）。
				this.resyncRequested = false;
				this.sendToRelay(responder.response);
				return;
			}
			if (!this.confirmed) {
				// 次は confirm。検証してFrameMuxを確立。
				cryptoFailure = true;
				await this.pendingVerify!(payload);
				cryptoFailure = false;
				this.confirmed = true;
				this.decryptedSinceConfirm = false;
				this.staleFrameFailures = 0;
				this.staleFrameLogged = false;
				this.mux?.dispose();
				this._epoch++;
				this.mux = new FrameMux(this.channel, {
					sendSealed: (sealed: Uint8Array) => this.sendToRelay(sealed),
					...(this.sendQueue !== undefined ? { sendQueue: this.sendQueue } : {}),
					// FrameMux は onError を渡すと復号失敗を握り潰して throw しない。ここで捕まえて
					// 下の catch へ載せ直さないと、「復号できない32Bは新しい hello とみなして
					// セッションをリセットする」自己回復も計装も、確立後は一切効かない
					// （旧セッションに固着したモバイルが二度と接続できなくなる経路）。
					onError: (err: unknown) => { this.lastMuxError = err; },
					// 断片の組み立ての誤りは復号できた後の話なので、張り直しの判定（暗号層の失敗）には数えない
					onAssemblyError: (err: Error) => this.recordAssemblyError(err),
					...(this.onTraffic !== undefined ? { onTraffic: this.onTraffic } : {}),
				});
				this.mux.on(Channels.State, f => this.emit(f));
				this.mux.on(Channels.Terminal, f => this.emit(f));
				this.mux.on(Channels.Scm, f => this.emit(f));
				this.mux.on(Channels.Fs, f => this.emit(f));
				this.mux.on(Channels.Browser, f => this.emit(f));
				this.mux.on(Channels.Agent, f => this.emit(f));
				this.mux.on(Channels.Notify, f => this.emit(f));
				return;
			}
			this.lastMuxError = undefined;
			await this.mux!.receive(payload);
			if (this.lastMuxError !== undefined) {
				const muxError = this.lastMuxError;
				this.lastMuxError = undefined;
				cryptoFailure = true;
				throw muxError;
			}
			// ここまで来たら復号できている。単発の迷子フレームで畳まないための連続カウンタを戻す。
			this.consecutiveCryptoFailures = 0;
			this.decryptedSinceConfirm = true;
			this.staleFrameFailures = 0;
		} catch (err) {
			// 自己回復: ハンドシェイク確立中/確立後に処理できない32Bのペイロードが届いた場合、
			// それはモバイルが再接続して送り直した新しい hello（ephemeral公開鍵32B）である
			// 可能性が高い（正規のsealed frameはヘッダ+nonce+tagで32Bより必ず大きい）。
			// リレーからのモバイルoffline通知が欠落した場合（旧ソケットのcloseが届かない等）、
			// 古いセッションに固着したままだと新しい接続のhelloを永久に復号失敗で無視し続けて
			// モバイルが二度と接続できなくなるため、セッションを破棄してhelloとして処理し直す。
			if (payload.length === 32 && this.channel !== undefined) {
				this.logService.info(`[paradisMobileRelay] session ${this.mobileId}: undecryptable 32B payload; treating as new hello (session reset)`);
				this.resetSessionState();
				await this.handlePayload(payload);
				return;
			}
			// セッションリセット（上の32B分岐）は正常な自己回復なのでイベント化しない。
			// ここに来るのは復号にも hello 解釈にも失敗した本物の異常（鍵の固着、フレーム破損、
			// 受信ハンドラ自体の例外）で、それらを検知する唯一の窓口になる。鍵やペイロードは載せない。
			const resync = this.resyncIfSessionDiverged(cryptoFailure);
			if (cryptoFailure && !settledAtStart && this.recordStaleFrameFailure(payload.length, resync)) {
				return;
			}
			reportParadisDiagnosticError('owned', 'mobile-e2e', 'frame-open-failed', err, {
				phase: this.confirmed ? 'online' : 'handshaking',
				transport: 'websocket',
				safe_payload_bytes: payload.length,
				// 畳んだのか、様子見なのか、送れなかったのか。復帰しないケースの切り分けが変わる。
				safe_resync: resync,
			});
			this.logService.warn(`[paradisMobileRelay] session ${this.mobileId} error`, err);
		}
	}

	private pendingVerify: ((confirm: Uint8Array) => Promise<void>) | undefined;
	/** FrameMux が握り潰した直近の復号失敗（handlePayload が拾い直して共通処理へ載せる）。 */
	private lastMuxError: unknown;
	/** このセッションで既に再ハンドシェイク要求を送ったか。送り直しは再確立まで1回きり。 */
	private resyncRequested = false;
	/** 復号に失敗し続けている回数。1回でも復号できたら戻す。 */
	private consecutiveCryptoFailures = 0;
	/** 今のセッションを確立してから、1つでもフレームを復号できたか。 */
	private decryptedSinceConfirm = false;
	/** ハンドシェイク中・直後に開けなかった旧鍵フレームの数（復号できたら戻す）。 */
	private staleFrameFailures = 0;
	/** 旧鍵フレームのことを、このセッションの確立までに一度ログへ残したか。 */
	private staleFrameLogged = false;

	/**
	 * ハンドシェイク中・直後に届いた旧鍵のフレームを、Sentry へ送らずに片付ける（7S）。
	 *
	 * モバイルが再接続して張り替える間、張り替え前の鍵で封緘したフレームが遅れて届くのは想定内で、
	 * 開けなければ {@link resyncIfSessionDiverged} がやり直しを促して自己回復する。1件ずつ
	 * error として送ると、本当の異常（確立して復号できていたセッションが続けて開けなくなる）が
	 * その中に埋もれる。ログは確立ごとに1回だけ info にし、残りは trace にする。
	 *
	 * ただし何十件続いても一度も復号できないなら、張り替えが回っていない本当の異常なので
	 * 送る側へ回す（false を返す）。
	 * @returns 片付けた（送らない）なら true
	 */
	private recordStaleFrameFailure(payloadBytes: number, resync: string): boolean {
		this.staleFrameFailures++;
		if (this.staleFrameFailures === PARADIS_MOBILE_STALE_FRAME_REPORT_AFTER) {
			return false;
		}
		const message = `[paradisMobileRelay] session ${this.mobileId}: dropped a ${payloadBytes}B frame sealed with the previous session key (resync: ${resync})`;
		if (this.staleFrameLogged) {
			this.logService.trace(message);
		} else {
			this.staleFrameLogged = true;
			this.logService.info(message);
		}
		return true;
	}

	/**
	 * 食い違ったセッションだけを畳んで、モバイルへ「やり直せ」と伝える。
	 *
	 * 既存の32B自己回復は「PCが古いセッションに固着、モバイルが新しい hello を送る」方向しか
	 * 救えない。本番で起きているのは**逆向き**で、PCが新しく、モバイルが確立済みのつもりで
	 * sealed frame を送ってくる。PCから知らせる経路が無いため、モバイルは自力で気付くまで
	 * 詰まる（主経路は45〜65秒の死活監視で戻るが、rxだけ固着してtxが無事な派生形では
	 * 受信が続くので**永久に発火しない**）。
	 *
	 * 専用の制御メッセージを足さないのは、**旧バージョンのアプリでもそのまま治る**ようにするため。
	 * 確立済みのモバイルは受け取ったバイナリを必ず復号しようとし、失敗すれば `onFatal` から
	 * ソケットを閉じて張り直す。だから「復号できないバイト列」を1回送るだけで再ハンドシェイクが起きる。
	 *
	 * **畳んでよい条件を絞ること。** ここは復号失敗だけでなくフレーム配布後のハンドラ例外も
	 * 通る（`FrameMux` は復号失敗を onError で握り潰すので、`receive()` の reject は
	 * アプリ層の例外）。アプリ層のバグで畳むと、1フレーム捨てれば済んだものが再接続に化け、
	 * しかもモバイルが再接続後に同じフレームを送り直すとループになる。
	 * 単発の遅着フレームでも畳まない: 別ソケットをまたいだ順序逆転で、立ったばかりの健全な
	 * セッションを蹴ってしまう（`Cipher.open` は失敗時にカウンタを進めないので、1個の迷子では
	 * desync しない）。
	 *
	 * 制約:
	 * - **長さは32Bにしない**。32Bはモバイル→PCの hello と同じ形で、逆流したときに自己回復の
	 *   分岐と衝突する
	 * - **セッションにつき1回だけ**。毎フレーム返すと再接続ループになる
	 * - モバイルがまだハンドシェイク中なら、向こうは established 前のバイナリを読み飛ばすので
	 *   単に無視される（無害）
	 */
	private resyncIfSessionDiverged(cryptoFailure: boolean): 'sent' | 'already-sent' | 'not-connected' | 'watching' | 'not-crypto' {
		if (!cryptoFailure) {
			// アプリ層の例外。セッションは健全なので触らない。
			return 'not-crypto';
		}
		this.consecutiveCryptoFailures++;
		// セッションが無いのに封緘フレームが来た＝本番で観測した形。これは1回で確定できる。
		// それ以外（確立済みなのに復号できない）は、迷子1個と本物の固着を区別するために続きを見る。
		const diverged = this.channel === undefined || this.consecutiveCryptoFailures >= PARADIS_MOBILE_RESYNC_AFTER_FAILURES;
		if (!diverged) {
			return 'watching';
		}
		if (this.resyncRequested) {
			return 'already-sent';
		}
		const marker = new Uint8Array(PARADIS_MOBILE_RESYNC_MARKER_BYTES);
		if (!this.sendToRelay(marker)) {
			// リレーへのソケットが落ちている。届いていないのにラッチを立てると、
			// このセッションは二度とやり直しを促せなくなる。
			return 'not-connected';
		}
		this.resyncRequested = true;
		// 送ったあとに畳む。次に届く hello を素直に受けられる状態へ戻す。
		this.resetSessionState();
		return 'sent';
	}

	/** ハンドシェイク前の状態へ戻す。次の hello から作り直せるようにするためだけのもの。 */
	private resetSessionState(): void {
		this.consecutiveCryptoFailures = 0;
		this.decryptedSinceConfirm = false;
		this.channel = undefined;
		// 列に残った古い鍵の断片を送らない（新しいセッションのアプリは開けずに張り直してしまう）
		this.mux?.dispose();
		this.mux = undefined;
		this.confirmed = false;
		this.negotiatedProtocolVersion = undefined;
		this.protocolBlocked = false;
		this.negotiatedCapabilities = undefined;
		this.protocolMismatchReported = false;
		// **必ず一緒に落とすこと。** セッションは mobileId で再接続をまたいで再利用されるため、
		// ここに前回の交渉結果が残ると、アプリを古い版へ入れ直した端末に対して、次の requestState
		// が届く前のブロードキャストで gzip を送ってしまう（旧アプリはJSON.parseで例外になり、
		// それが握り潰されてホームが空のまま固まる）。
		this.negotiatedStateEncoding = undefined;
		this.pendingVerify = undefined;
		this.stateDelivery.reset();
	}

	private emit(frame: { ch: ChannelId; ws?: string; seq: number; payload: Uint8Array }): void {
		// 送信元モバイルのIDを付けて renderer へ渡す（要求元にのみ返すべき応答の宛先解決に使う）。
		this.onFrame({ ch: frame.ch, ws: frame.ws, seq: frame.seq, payload: VSBuffer.wrap(frame.payload), mobileId: this.mobileId });
	}

	/** PC→モバイルのフレームを封緘して送る。 */
	async sendFrame(ch: ChannelId, ws: string | undefined, payload: Uint8Array): Promise<void> {
		if (this.mux) {
			await this.mux.send(ch, payload, ws);
		}
	}

	/**
	 * PC→モバイルのDesktop Stateを送る。
	 * `force`はrequestStateなど応答必須の宛先指定送信で使い、完全一致でも必ず送る。
	 * 戻り値は実際に送信した場合だけtrueになり、成功したpayloadだけが次回の比較対象になる。
	 */
	async sendDesktopState(payload: Uint8Array, force: boolean): Promise<boolean> {
		const mux = this.mux;
		if (mux === undefined) {
			return false;
		}
		// 圧縮は送信直前のここだけで行う。`deliver` の無変化判定は渡された非圧縮JSONのまま
		// 動くので、gzip の出力が実行ごとに揺れても dedupe が壊れることはない
		// （圧縮後のバイト列で比較すると、同じ内容でも別物と判定されて毎回送ってしまう）。
		if (this.protocolBlocked) {
			// 版が合わないアプリには、版だけの小さな案内を送る（断片に切らないので版 3 のアプリも読める）
			await mux.send(Channels.State, PARADIS_MOBILE_PROTOCOL_GUIDANCE);
			return true;
		}
		return this.stateDelivery.deliver(payload, force, async state => {
			const encoded = await paradisEncodeNegotiatedGzipJsonResponse(this.negotiatedStateEncoding, state) ?? state;
			await mux.send(Channels.State, encoded);
		});
	}

	/** 断片の組み立ての誤りの数（暗号層の失敗とは別に数える）。 */
	private assemblyErrors = 0;

	get assemblyErrorCount(): number {
		return this.assemblyErrors;
	}

	private recordAssemblyError(error: Error): void {
		this.assemblyErrors++;
		// 1 回目と、その後は 100 回ごとに残す（壊れた送り手がログを埋めないように）
		if (this.assemblyErrors === 1 || this.assemblyErrors % 100 === 0) {
			this.logService.warn(`[paradisMobileRelay] session ${this.mobileId}: dropped a frame that could not be reassembled (${this.assemblyErrors} so far)`, error);
		}
	}

	/** このセッションを捨てる。列に残った送信を取り下げる。 */
	close(): void {
		this.resetSessionState();
	}

	get idBytes(): Uint8Array {
		return this.mobileIdBytes;
	}
}

/**
 * shared process 常駐のモバイルリレーサービス。リレーへの outbound WSS を所有し、
 * E2E暗号・ペアリング・フレーム多重化を行う。renderer とは IPC チャネルで接続する。
 */
interface IParadisMobileRelayMetricsTimer extends IDisposable {
	cancel(): void;
	cancelAndSet(runner: () => void, interval: number): void;
}

/** @internal Constructor dependencies used only by deterministic lifecycle tests. */
export interface IParadisMobileRelayServiceTestSeams {
	readonly stateBroadcastMetricsTimer?: IParadisMobileRelayMetricsTimer;
	readonly disableHostResourceSampling?: boolean;
	/** 台帳の書き込み（保存の失敗を再現するテストが差し替える）。 */
	readonly writeRelayState?: (filePath: string, state: IParadisRelayPersistedState) => Promise<void>;
	/** このPCの機械の印の読み出し（既定は OS の機械 ID。テストは OS を読まない値に差し替える）。 */
	readonly readMachineIdHash?: () => Promise<string | undefined>;
}

/**
 * `fetch` の失敗理由を識別子 1 語に落とす。`err.cause.code`（Node の errno 名）か `err.cause.name`
 * （`TimeoutError` 等）だけを見るので、ホスト名や URL は含まれない。
 */
function probeFailureCause(err: unknown): string {
	const cause = (err as { cause?: { code?: unknown; name?: unknown } } | undefined)?.cause;
	for (const value of [cause?.code, cause?.name, (err as { name?: unknown } | undefined)?.name]) {
		if (typeof value === 'string' && /^[A-Za-z_][\w]{0,47}$/.test(value)) {
			return value;
		}
	}
	return 'unknown';
}

/** renderer から届いたペイントークンの形を確かめる（IPC の入力は信用しない）。 */
function paradisIsAgentChatToken(token: unknown): token is string {
	return typeof token === 'string' && token.length > 0 && token.length <= 200;
}

export class ParadisMobileRelayService extends Disposable implements IParadisMobileRelayService, IParadisAgentPaneInsightSource, IParadisAgentChatSource {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<IParadisMobileStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private readonly _onPairingEvent = this._register(new Emitter<ParadisMobilePairingEvent>());
	readonly onPairingEvent = this._onPairingEvent.event;

	private readonly _onInboundFrame = this._register(new Emitter<ParadisMobileInboundFrameWire>());
	readonly onInboundFrame = this._onInboundFrame.event;

	private readonly _onDidChangeConfirmedAgentPanes = this._register(new Emitter<IParadisConfirmedAgentPanes>());
	readonly onDidChangeConfirmedAgentPanes = this._onDidChangeConfirmedAgentPanes.event;
	private readonly _onDidRequestAgentPaneSync = this._register(new Emitter<IParadisMobileWindowLease>());
	readonly onDidRequestAgentPaneSync = this._onDidRequestAgentPaneSync.event;
	private confirmedAgentPanes: IParadisConfirmedAgentPanes = { revision: 0, tokens: [], tokensOutsideHookReach: [] };
	/** デスクトップ UI 向け: ペインの様子が変わった（agentInsights が購読する。モバイルとは無関係）。 */
	private readonly _onDidChangeAgentPaneInsights = this._register(new Emitter<void>());
	readonly onDidChangeAgentPaneInsights = this._onDidChangeAgentPaneInsights.event;
	/** デスクトップのチャット表示向け: 見られているペインの会話が変わった（agentChat が購読する。モバイルとは無関係）。 */
	private readonly _onDidChangeAgentChat = this._register(new Emitter<readonly string[]>());
	readonly onDidChangeAgentChat = this._onDidChangeAgentChat.event;

	// PC本体（マシン全体）のリソースサンプラー。CPUは累積値の差分なので使い回す必要がある。
	private readonly hostResourceSampler = new ParadisHostResourceSampler();
	private hostResourceSamplingInFlight = false;
	/** リソースだけを理由にした直近の再送時刻。最小間隔の判定に使う。 */
	private lastHostResourceBroadcastAt = 0;
	/** 最小間隔に阻まれて送れなかった変化があるか（次に間隔が空いたときに送る）。 */
	private hostResourceBroadcastPending = false;
	/** サンプリング失敗をwarnで1回だけ残したか（以降はtraceに落とす）。 */
	private hostResourceSamplingFailureLogged = false;

	private state: PersistedState = { mobiles: [] };
	private identity: MobileIdentity | undefined;
	/** 保存した鍵と台帳を読めなかった理由（読めていれば undefined）。 */
	private storeProblem: ParadisRelayStoreProblem | undefined;
	/** その理由を利用者へ知らせる役を、どれかのウィンドウへ渡したか。 */
	private storeProblemNoticed: ParadisRelayStoreProblem | undefined;
	/** 台帳を一度読めたか（以後は initialize のたびに読み直さない）。 */
	private stateLoaded = false;
	private loading: Promise<void> | undefined;
	/** 台帳の読み書きの列。 */
	private storeQueue: Promise<unknown> = Promise.resolve();
	private identityCreation: Promise<MobileIdentity> | undefined;
	private enabled = false;
	private connectionState: ParadisMobileConnectionState = 'disabled';
	// Mobile relay が有効な間だけ動かし、shared process の不要な定期起床を避ける。
	private readonly stateBroadcastMetricsTimer: IParadisMobileRelayMetricsTimer;
	private readonly writeRelayState: (filePath: string, state: IParadisRelayPersistedState) => Promise<void>;
	private readonly readMachineIdHash: () => Promise<string | undefined>;
	private machineIdHashRequested = false;
	private stateBroadcastMetricsEnabled = false;
	private stateBroadcastMetricsGeneration = 0;

	private socket: WebSocket | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectAttempt = 0;
	private readonly disconnectReporter: ParadisRelayDisconnectReporter;
	private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
	private connectTimer: ReturnType<typeof setTimeout> | undefined;
	/** 繋がってから一定時間後に失敗の回数を戻すタイマー。 */
	private stableConnectionTimer: ReturnType<typeof setTimeout> | undefined;
	/** スリープ復帰直後に撃った ping の返事を待つタイマー。 */
	private resumeProbeTimer: ReturnType<typeof setTimeout> | undefined;
	/** 連続でpongが返らなかった回数。リレー側の保活対応をいつ学習し直すかの判断に使う。 */
	private consecutiveKeepaliveTimeouts = 0;
	/** pcToken が失効していると確認できた状態。再ペアリングするまで復帰しない。 */
	private unauthorized = false;
	private authProbeInFlight = false;
	/** 直近のプローブ結果。同じ結論を送り続けてレートリミッタを食い潰さないための番人。 */
	private lastAuthProbeOutcome: 'ok' | 'unauthorized' | 'rejected' | 'unreachable' | undefined;
	/** 直前のpingにpongが返っていない。次のtickでも返っていなければ経路が死んだとみなす。 */
	private awaitingPong = false;
	/** 最後に ping を撃った時刻（保活の定期チェックが、スリープ復帰の ping を見切らないため）。 */
	private lastPingSentAt = 0;
	/**
	 * このリレーがpongを返すと確認できたか。保活未対応のリレー（PC側だけ先に更新された場合など）を
	 * 死活判定に使わないためのフラグで、リレーの能力を表すので接続をまたいで保持する。
	 */
	private keepaliveAcknowledged = false;
	private readonly sessions = new Map<string, MobileSession>();
	private readonly terminalRegistry = new ParadisMobileTerminalRegistry();
	private readonly terminalOperations = new ParadisMobileOperationLedger();
	private readonly agentCommandAuthority = new ParadisAgentCommandAuthority();
	private readonly terminalOperationTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly webrtcRendererLeases = new Map<string, { readonly sid: string; readonly owner: IParadisMobileWindowLeaseRef }>();
	private readonly voiceSubscriptions = new ParadisVoiceSubscriptions();
	/**
	 * PC からリレーへのソケットは全端末で 1 本なので、送信の列も 1 本（mux の版 4）。ソケットの送信バッファが
	 * 32KiB を超えている間は次の断片を積まない。
	 */
	private readonly sendQueue = new ParadisMobileSendQueue({ bufferedAmount: () => this.socket?.bufferedAmount ?? 0 });
	/** 音声通知の配信（`voice.stream.v1` と `voice-clip`）。 */
	private readonly voiceDelivery = paradisCreateVoiceDelivery(this.voiceSubscriptions, {
		getSession: mobileId => this.sessions.get(mobileId),
		congestionBytes: () => this.sendQueue.congestionBytes(),
		warn: (message, error) => {
			if (error === undefined) {
				this.logService.warn(message);
			} else {
				this.logService.warn(message, error);
			}
		},
	});
	private rendererAuthorityChain = Promise.resolve();

	// ペアリング中の状態
	private pairing: {
		pairId: string;
		pairingToken: Uint8Array;
		mobilePubKey?: Uint8Array;
		proposedName: string;
		// SAS表示済み（awaiting-approval発火済み）。これ以降は mobilePubKey を凍結し、
		// 別の公開鍵を持つpairing-msgでの上書きを禁じる（C-2: SASすり替え防止）。
		sasShown: boolean;
	} | undefined;

	private readonly statePath: string;
	private relayUrlOverride: string | undefined;
	/** モバイルのPC一覧に出す表示名（renderer が設定値かホスト名を解決して渡す）。 */
	private pcName: string | undefined;

	// para-browser の CDP screencast ミラー（設計書 M3、browser チャネル）
	private readonly browserMirror: ParadisMobileBrowserMirror;

	// エージェントセッションのチャットミラー（agentチャネル）。transcript の tail は
	// ファイルI/O・hookバス購読とも shared process 側の仕事なのでここで直接処理する
	// （browser チャネルと同じ方針。renderer は経由しない）。
	private readonly agentChat: ParadisMobileAgentChat;
	private readonly remoteTranscriptMirror: ParadisRemoteTranscriptMirrorStore;
	private readonly trafficDiagnostics: ParadisMobileTrafficDiagnostics | undefined;

	constructor(
		private readonly userDataPath: string,
		private readonly encryptionService: IEncryptionService,
		private readonly cdpFrames: IParadisCdpFrameSubscription | undefined,
		// agentBrowser の共有ページバインディング（targets応答の sharedToken 用）。
		// 同一 shared process 内の直接参照を sharedProcessMain.ts が注入する。
		private readonly sharedPageBindings: IParadisSharedPageBindings | undefined,
		private readonly windowLeaseClient: ParadisMobileWindowLeaseClient,
		private readonly logService: ILogService,
		configurationService?: IConfigurationService,
		_args?: NativeParsedArgs,
		// 音声通知（流れの開始・断片・終わりと、1 本まるごと）。同一 shared process の通知サービスが発火する。
		voiceClips?: Event<ParadisMobileVoiceEvent>,
		testSeams?: IParadisMobileRelayServiceTestSeams,
	) {
		super();
		this.stateBroadcastMetricsTimer = this._register(testSeams?.stateBroadcastMetricsTimer ?? new IntervalTimer());
		this.writeRelayState = testSeams?.writeRelayState ?? paradisWriteRelayState;
		this.readMachineIdHash = testSeams?.readMachineIdHash ?? paradisGetMachineIdHash;
		this.disconnectReporter = this._register(new ParadisRelayDisconnectReporter({
			reportDelayMs: RELAY_DISCONNECT_REPORT_DELAY_MS,
			reportAfterAttempts: RELAY_DISCONNECT_REPORT_AFTER_ATTEMPTS,
			getReconnectAttempt: () => this.reconnectAttempt,
			report: report => reportParadisDiagnosticError('owned', 'desktop-relay', report.operation, new Error(report.message), {
				...report.extras,
			}),
		}));
		if (voiceClips !== undefined) {
			this._register(voiceClips(event => this.voiceDelivery.handle(event)));
		}
		const trafficDiagnosticsSession = startParadisMobileTrafficDiagnostics(
			process.env.PARADIS_MOBILE_TRAFFIC_DIAGNOSTICS,
			line => this.logService.info(`[paradisMobileRelay][traffic] ${line}`),
		);
		this.trafficDiagnostics = trafficDiagnosticsSession?.diagnostics;
		if (trafficDiagnosticsSession !== undefined) {
			this._register(trafficDiagnosticsSession);
		}
		this.statePath = join(this.userDataPath, 'paradis-mobile-relay.json');
		// エージェントセッション対応表の永続化先。shared process再起動（=PC再起動・アップデート）を
		// またいで、実行中エージェントのモバイル表示を復元するために使う。
		const agentSessionStore = new ParadisAgentSessionStore(join(this.userDataPath, 'paradis-agent-sessions.json'), this.logService);
		// 冷スタート（起動時点で `DevToolsActivePort` が他インスタンスに上書きされていた）でも
		// 上流へ辿り着けるよう、electron-main が確定させたポートを候補に加える。ここを忘れると
		// 「PCのブラウザ共有は直ったのにスマホのミラーだけ繋がらない」になる。
		const cdpUpstream = new ParadisCdpUpstream(this.userDataPath, this.logService, {
			resolveMainPort: async () => await cdpFrames?.resolveUpstreamPort() ?? undefined,
		});
		this.browserMirror = this._register(new ParadisMobileBrowserMirror(cdpUpstream, cdpFrames, sharedPageBindings, this.logService, {
			// browser.page.v1 の `open`: PC のアドレスバーと同じ検索エンジンの設定を読む（未設定なら Google）。
			resolveSearchEngine: () => configurationService?.getValue<unknown>(BrowserSearchEngineSettingId),
			// browser.space.v1: Renderer が送った台帳から、そのスペースのページの targetId を引く。
			resolveSpaceTargetIds: (windowId, ws) => this.resolveBrowserSpaceTargetIds(windowId, ws),
			// browser.focus.v1: 欄の中身を含む `focus` は、受けると広告したアプリにだけ送る。
			mobileHasCapability: async (mobileId, name) => paradisHasMobileCapability(await this.getMobileCapabilities(mobileId), name),
		}));
		// SSH 接続先の transcript は shared process からは開けない。接続中のウィンドウに写して
		// もらい、tailer にはその写しを読ませる。
		this.remoteTranscriptMirror = this._register(new ParadisRemoteTranscriptMirrorStore(this.userDataPath, this.logService));
		this.agentChat = this._register(new ParadisMobileAgentChat(
			(mobileId, payload) => {
				const session = this.sessions.get(mobileId);
				if (session?.hasCurrentProtocol) {
					session.sendFrame(Channels.Agent, undefined, payload).catch(err => this.logService.warn('[paradisMobileRelay] agent reply failed', err));
				}
			},
			(mobileId, windowId, windowSession, rendererGeneration, payload) => {
				const owner = { windowId, windowSession, rendererGeneration };
				this.withCurrentRegisteredLease(owner, async () => {
					this._onInboundFrame.fire([Channels.Agent, paradisMobileWindowRoute(windowId, windowSession, rendererGeneration), 0, VSBuffer.wrap(payload), mobileId]);
				}).catch(error => this.logService.warn('[paradisMobileRelay] agent action routing failed', error));
			},
			// transcript に質問(AskUserQuestion等)が現れた → 質問本文入りの通知を全モバイルへ流す。
			// hookベースの agentStatus 遷移通知(renderer側 emitNotify)は AskUserQuestion では
			// 発火しないことがあるため、こちらが質問通知の主経路。
			info => this.notifyAgentQuestion(info),
			this.logService,
			owner => this.withCurrentRegisteredLease(owner, async () => true).then(result => result === true, () => false),
			owner => this._onDidRequestAgentPaneSync.fire({
				windowId: owner.windowId,
				windowSession: owner.windowSession,
				rendererGeneration: owner.rendererGeneration,
			}),
			agentSessionStore,
			this.remoteTranscriptMirror,
		));
		this._register(toDisposable(() => { void agentSessionStore.flush(); }));
		this._register(toDisposable(() => { if (this.revokeTimer !== undefined) { clearTimeout(this.revokeTimer); } }));
		this._register(toDisposable(() => this.backgroundSessions.dispose()));
		this._register(this.agentChat.onDidChangeDesktopPaneInsights(() => this._onDidChangeAgentPaneInsights.fire()));
		this._register(this.agentChat.onDidChangeDesktopChat(tokens => this._onDidChangeAgentChat.fire(tokens)));
		// Claude Code の mod（Claude Mods）が質問・承認でモバイルの答えを待ってよいか（paradisClaudeModBridge.ts）。
		// 承認は、アプリが今リレーに繋がっているときだけ待つ。
		paradisClaudeModBridge.setPresence(() => !this.enabled || this.state.mobiles.length === 0 ? 'off'
			: [...this.sessions.values()].some(session => session.hasCurrentProtocol) ? 'connected' : 'enabled');
		this._register(this.agentChat.onDidChangeConfirmedAgentPanes(({ tokens, tokensOutsideHookReach }) => {
			this.confirmedAgentPanes = { revision: this.confirmedAgentPanes.revision + 1, tokens, tokensOutsideHookReach };
			this._onDidChangeConfirmedAgentPanes.fire(this.confirmedAgentPanes);
		}));
		// PC側でペインを確認済みにした（フォーカス中の自動既読 or ターミナルを開いての手動既読）
		// ときも、モバイル側の通知履歴から対応する通知を消す（M起点のdismissと同じ配送経路）。
		if (this.sharedPageBindings) {
			this._register(this.sharedPageBindings.onDidAcknowledgePane(token => this.dispatchAgentDismiss(token)));
		}
		this._register(this.windowLeaseClient.onDidChangeManifest(manifest => {
			this.observeManifest(manifest);
			this.enqueueRendererAuthority(() => this.broadcastDesktopState(undefined, manifest)).catch(error => this.logService.warn('[paradisMobileRelay] manifest state broadcast failed', error));
		}));
		this._register(toDisposable(() => {
			for (const timer of this.terminalOperationTimers.values()) {
				clearTimeout(timer);
			}
			this.terminalOperationTimers.clear();
			this.webrtcRendererLeases.clear();
			this.disconnect();
		}));
		if (!testSeams?.disableHostResourceSampling) {
			this.startHostResourceSampling();
		}
	}

	/**
	 * Mobile relayが有効な間だけdesktop state broadcast計測タイマーを動かす。
	 *
	 * 無効化時は、停止済みタイマーのキュー済みcallbackが実行されても古い集計を報告しないよう、
	 * 集計も同時に捨てる。
	 */
	private setStateBroadcastMetricsEnabled(enabled: boolean): void {
		if (this.stateBroadcastMetricsEnabled === enabled) {
			return;
		}
		this.stateBroadcastMetricsEnabled = enabled;
		const generation = ++this.stateBroadcastMetricsGeneration;
		if (!enabled) {
			this.stateBroadcastMetricsTimer.cancel();
			this.resetStateBroadcastMetrics();
			return;
		}
		this.resetStateBroadcastMetrics();
		this.stateBroadcastMetricsTimer.cancelAndSet(() => {
			if (this.stateBroadcastMetricsEnabled && generation === this.stateBroadcastMetricsGeneration) {
				this.reportStateBroadcastMetrics();
			}
		}, 60_000);
	}

	/** 計測用: Desktop State の broadcast 回数と、そのうち実際に電波へ出した回数を1分ごとに残す。 */
	private reportStateBroadcastMetrics(): void {
		if (this.broadcastCount === 0) {
			return;
		}
		const calls = this.broadcastCount;
		const sent = this.broadcastSentCount;
		this.resetStateBroadcastMetrics();
		this.logService.info(`[paradisMobileRelay][metrics] desktop state broadcast: ${calls} calls, ${sent} sent, ${calls - sent} deduped`);
	}

	private resetStateBroadcastMetrics(): void {
		this.broadcastCount = 0;
		this.broadcastSentCount = 0;
	}

	// --- PC本体のリソース使用量 -------------------------------------------------

	/**
	 * PC本体（マシン全体）のCPU/メモリ/ディスクを定期サンプリングして desktop state に載せる。
	 * バッテリーと違い renderer からは取れない（sandbox化されたrendererにはOSのAPIが無い）ため、
	 * shared process が直接読む。オンラインのモバイルが1台も無い間は何も測らない。
	 */
	private startHostResourceSampling(): void {
		const timer = setInterval(() => {
			this.reportHostResourceSamplingFailure(this.sampleHostResources());
		}, HOST_RESOURCE_SAMPLE_INTERVAL_MS);
		// 未ペアリング・全台オフラインでも10秒ごとに走るタイマーなので、これだけで
		// shared process を起こし続けないようにする（キャストは dom/node の setInterval 型衝突を
		// 避けるためで、wslRemoteAgentHostService.ts と同じ手当て）。
		(timer as unknown as NodeJS.Timeout).unref();
		this._register(toDisposable(() => clearInterval(timer)));
	}

	/**
	 * サンプリングの失敗を握り潰さない。恒常的に失敗するとモバイル側はドロワーの3値が
	 * 出ないだけになり「対応していないPC」と区別が付かないため、最初の1回はwarnで残す。
	 */
	private reportHostResourceSamplingFailure(work: Promise<void>): void {
		work.catch(error => {
			if (this.hostResourceSamplingFailureLogged) {
				this.logService.trace('[paradisMobileRelay] host resource sampling failed', error);
				return;
			}
			this.hostResourceSamplingFailureLogged = true;
			this.logService.warn('[paradisMobileRelay] host resource sampling failed', error);
		});
	}

	private async sampleHostResources(): Promise<void> {
		if (this.hostResourceSamplingInFlight) {
			return;
		}
		let hasOnlineSession = false;
		for (const session of this.sessions.values()) {
			if (session.isOnline) {
				hasOnlineSession = true;
				break;
			}
		}
		if (!hasOnlineSession) {
			return;
		}
		this.hostResourceSamplingInFlight = true;
		try {
			const host = await this.hostResourceSampler.read();
			if (this.terminalRegistry.setHostResources(paradisRoundMobileResources(host))) {
				this.hostResourceBroadcastPending = true;
			}
			if (!this.hostResourceBroadcastPending) {
				return;
			}
			// 丸めても実機の値は揺れ続けるので（実測で毎区間が変化）、変化検出だけでは
			// desktop state 全体（全ワークスペース・全ターミナル）の再送を10秒ごとに撃ち続けてしまう。
			// リソースだけを理由にした再送はここで間引く。他の理由（ターミナル状態の変化等）で
			// 送られる state には、そのとき registry が持っている最新値がそのまま乗る。
			const now = Date.now();
			if (now - this.lastHostResourceBroadcastAt < HOST_RESOURCE_BROADCAST_MIN_INTERVAL_MS) {
				return;
			}
			this.lastHostResourceBroadcastAt = now;
			this.hostResourceBroadcastPending = false;
			// 他のstate配送と同じくrenderer authorityの直列化に載せる（reconcileが
			// windowの登録・解除の途中に割り込んで中途state を publish するのを防ぐ）。
			await this.enqueueRendererAuthority(() => this.broadcastDesktopState());
		} finally {
			this.hostResourceSamplingInFlight = false;
		}
	}

	// --- 永続化 ---------------------------------------------------------------

	/**
	 * 鍵とペアリング台帳を、まだ読めていなければ読む（読めない状態で止めている間は読み直す）。
	 *
	 * `initialize` はウィンドウごとに呼ばれる。そのたびに読み直すと、別のウィンドウの一時的な
	 * 読み取りの失敗で稼働中の接続が落ち、読んでいる間に済んだペアリングが巻き戻っていた。
	 * 一度読めたら、以後はメモリの台帳が正で、ファイルは保存で追いかけるだけにする。
	 */
	private ensureLoaded(): Promise<void> {
		if (this.stateLoaded && !this.isStoreBlocked()) {
			return Promise.resolve();
		}
		if (!this.loading) {
			const loading = this.enqueueStore(() => this.load()).finally(() => {
				if (this.loading === loading) {
					this.loading = undefined;
				}
			});
			this.loading = loading;
		}
		return this.loading;
	}

	/**
	 * 台帳の読み書きを1本に並べる。保存は投げっぱなしで呼ばれる所があり、並べないと古い中身の
	 * 書き込みが新しい中身を追い越しうる。中身は実行する時点で文字列にする。
	 */
	private enqueueStore<T>(work: () => Promise<T>): Promise<T> {
		const result = this.storeQueue.then(work);
		this.storeQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	/**
	 * 鍵とペアリング台帳を読む（{@link ensureLoaded} から、読み書きの列の中で呼ぶ）。
	 *
	 * 「まだ無い」（初回）と「あるのに読めない」を分ける。以前は読めない・復号できないときに空の台帳と
	 * 新しい鍵で黙って上書きしていたので、キーチェーンの一時的な拒否や書き込み途中のクラッシュだけで
	 * 全スマホのペアリングが一度に外れていた。いまは:
	 * - 壊れている（JSON として読めない／形が違う）: 日時付きの名前へ退避し、作り直せる状態にして知らせる
	 * - 読めない・復号できない: ファイルを残したまま接続を止め、再試行か作り直しの同意を待つ
	 *   （{@link save} と {@link ensureIdentity} はこの間ファイルに触らない）
	 */
	private async load(): Promise<void> {
		// 書きかけで落ちた一時ファイルと、古い退避を片付ける（読み書きの列の中なので書き込みと重ならない）
		await paradisPruneRelayStateLeftovers(this.statePath).catch(() => undefined);
		const read = await paradisReadRelayState(this.statePath);
		if (read.kind === 'missing') {
			this.adoptLoadedState({ mobiles: [] }, undefined);
			return;
		}
		if (read.kind === 'unreadable') {
			this.logService.error('[paradisMobileRelay] failed to read the pairing state; keeping it untouched', read.error);
			this.blockOnUnreadableState('unreadable');
			return;
		}
		if (read.kind === 'corrupt') {
			let aside: string | undefined;
			try {
				aside = await paradisMoveRelayStateAside(this.statePath, 'corrupt');
			} catch (err) {
				// 退避できないものを上書きはしない。読めないのと同じ扱いで止める。
				this.logService.error('[paradisMobileRelay] failed to move the corrupt pairing state aside; keeping it untouched', err);
				this.blockOnUnreadableState('unreadable');
				return;
			}
			if (aside !== undefined) {
				this.logService.error(`[paradisMobileRelay] the pairing state was corrupt and was moved to ${aside}`);
			}
			// 退避できた、または別の読み込みが先に退避して無くなっていた。どちらも空から始める。
			this.adoptLoadedState({ mobiles: [] }, undefined, 'corrupt');
			return;
		}
		// 鍵を戻せるまでは this.state に入れない（読んでいる間に済んだ変更を巻き戻さないため）
		const parsed = read.state;
		const stored = parsed.identity;
		if (!stored) {
			this.adoptLoadedState(parsed, undefined);
			return;
		}
		const pkcs8B64 = await this.decryptSecret(stored);
		let identity: MobileIdentity | undefined;
		if (pkcs8B64 !== undefined) {
			try {
				identity = await importIdentity(fromBase64Url(pkcs8B64), fromBase64Url(stored.pubKey));
			} catch (err) {
				this.logService.error('[paradisMobileRelay] failed to import the stored identity', err);
			}
		}
		if (!identity) {
			// 台帳（ペアリング済みの端末名）は見せたまま、鍵が戻るまで接続も保存もしない。
			this.blockOnUnreadableState('undecryptable', parsed);
			return;
		}
		this.adoptLoadedState(parsed, identity);
		// 旧形式(平文pkcs8)で読めた場合は暗号化形式へ移行して保存し直す（列の中なので直接書く）。
		if (stored.pkcs8 !== undefined && pkcs8B64 !== undefined) {
			await this.persistIdentitySecret(identity, fromBase64Url(pkcs8B64));
			await this.writeStateNow();
		}
	}

	/** 読めた台帳を採る。以後は {@link ensureLoaded} で読み直さない。 */
	private adoptLoadedState(state: PersistedState, identity: MobileIdentity | undefined, problem?: 'corrupt'): void {
		this.state = state;
		this.identity = identity;
		this.notifyKeyCache.clear();
		this.stateLoaded = true;
		this.setStoreProblem(problem);
	}

	/** 読めない台帳を残したまま止める。接続は切り、鍵は持たない。 */
	private blockOnUnreadableState(problem: 'unreadable' | 'undecryptable', state: PersistedState = { mobiles: [] }): void {
		this.state = state;
		this.identity = undefined;
		this.notifyKeyCache.clear();
		this.disconnect();
		this.setStoreProblem(problem);
	}

	/** 読めない台帳を残したまま止めているか（この間は上書きも接続もしない）。 */
	private isStoreBlocked(): boolean {
		return this.storeProblem === 'unreadable' || this.storeProblem === 'undecryptable';
	}

	private setStoreProblem(problem: ParadisRelayStoreProblem | undefined): void {
		if (this.storeProblem === problem) {
			return;
		}
		this.storeProblem = problem;
		if (problem === undefined) {
			this.storeProblemNoticed = undefined;
		}
		this._onDidChangeStatus.fire(this.snapshot());
	}

	/** 有効かつペアリング済みなら繋ぎ、そうでなければ今の状態を表示に出す。 */
	private connectIfReady(): void {
		if (this.enabled && this.state.device && !this.isStoreBlocked()) {
			this.connect();
		} else {
			this.setConnectionState(this.enabled ? 'disconnected' : 'disabled');
		}
	}

	async retryLoadState(): Promise<void> {
		if (!this.isStoreBlocked()) {
			return;
		}
		await this.ensureLoaded();
		this.updateDiagnosticCorrelation();
		this.disconnectReporter.setEnabled(this.enabled);
		this.connectIfReady();
		this.updateEagerTailing();
		this._onDidChangeStatus.fire(this.snapshot());
	}

	async discardUnreadableState(): Promise<void> {
		const problem = this.storeProblem;
		if (problem === undefined) {
			return;
		}
		if (problem !== 'corrupt') {
			// 退避できなければ作り直さない（上書きすると、キーチェーンが戻っても取り戻せない）。
			const aside = await this.enqueueStore(() => paradisMoveRelayStateAside(this.statePath, problem));
			if (aside !== undefined) {
				this.logService.warn(`[paradisMobileRelay] the unreadable pairing state was moved to ${aside} at the user's request`);
			}
		}
		this.disconnect();
		this.state = { mobiles: [] };
		this.identity = undefined;
		this.notifyKeyCache.clear();
		this.stateLoaded = true;
		this.storeProblem = undefined;
		this.storeProblemNoticed = undefined;
		this.setUnauthorized(false);
		this.disconnectReporter.setEnabled(this.enabled);
		this.connectIfReady();
		this.updateEagerTailing();
		this._onDidChangeStatus.fire(this.snapshot());
	}

	private async decryptSecret(stored: NonNullable<PersistedState['identity']>): Promise<string | undefined> {
		if (stored.encSecret !== undefined) {
			try {
				return await this.encryptionService.decrypt(stored.encSecret);
			} catch (err) {
				this.logService.error('[paradisMobileRelay] failed to decrypt identity secret', err);
				return undefined;
			}
		}
		return stored.pkcs8; // 旧形式(平文)フォールバック
	}

	/** pkcs8秘密鍵を safeStorage で暗号化して state.identity に格納する（不可なら平文フォールバック）。 */
	private async persistIdentitySecret(identity: MobileIdentity, pkcs8: Uint8Array): Promise<void> {
		const pkcs8B64 = toBase64Url(pkcs8);
		try {
			const encSecret = await this.encryptionService.encrypt(pkcs8B64);
			this.state.identity = { pubKey: toBase64Url(identity.publicKey), encSecret };
		} catch (err) {
			// safeStorageが使えない環境（例: キーリング無しのLinux）では平文で保存（mode 0600）。
			this.logService.warn('[paradisMobileRelay] safeStorage unavailable, storing identity secret in plaintext', err);
			this.state.identity = { pubKey: toBase64Url(identity.publicKey), pkcs8: pkcs8B64 };
		}
	}

	/** 台帳を保存する。読み書きの列に並べ、中身は書く時点のものにする。 */
	private save(): Promise<void> {
		return this.enqueueStore(() => this.writeStateNow());
	}

	private async writeStateNow(): Promise<void> {
		// 読めなかった台帳は上書きしない（キーチェーンが戻れば読めるかもしれない）。
		if (this.isStoreBlocked()) {
			throw new Error('The mobile pairing state could not be read; it is not overwritten until it is retried or discarded.');
		}
		// 秘密鍵は persistIdentitySecret で safeStorage 暗号化済み。ファイルは常に 0600。
		await this.writeRelayState(this.statePath, this.state);
		// 壊れた台帳を退避した後、新しい台帳を書けたら案内は役目を終える。
		if (this.storeProblem === 'corrupt') {
			this.setStoreProblem(undefined);
		}
	}

	private async ensureIdentity(): Promise<MobileIdentity> {
		if (this.identity) {
			return this.identity;
		}
		// 鍵を読めないまま新しい鍵を作ると、保存した鍵でペアリングした端末が全部外れる。
		if (this.isStoreBlocked()) {
			throw new Error('The mobile pairing key could not be read. Retry, or re-pair to create a new key.');
		}
		// 同時に呼ばれても鍵を2つ作らない（後から作った方で先の鍵を上書きしない）
		if (!this.identityCreation) {
			const creation = (async () => {
				const { identity, pkcs8 } = await generatePersistableIdentity();
				this.identity = identity;
				await this.persistIdentitySecret(identity, pkcs8);
				await this.save();
				return identity;
			})().finally(() => {
				if (this.identityCreation === creation) {
					this.identityCreation = undefined;
				}
			});
			this.identityCreation = creation;
		}
		return this.identityCreation;
	}

	/**
	 * 「鍵を読めない」を利用者へ知らせる役を、ウィンドウ1つにだけ渡す（全ウィンドウに同じ通知が
	 * 並ばないように）。理由が変わるか解消するまでに true を返すのは1回だけ。
	 */
	async claimStoreProblemNotice(problem: string): Promise<boolean> {
		if (this.storeProblem === undefined || problem !== this.storeProblem || this.storeProblemNoticed === this.storeProblem) {
			return false;
		}
		this.storeProblemNoticed = this.storeProblem;
		return true;
	}

	// --- 公開API（IPC） -------------------------------------------------------

	async getMobileWireVersion(mobileId: string): Promise<number | undefined> {
		return this.sessions.get(mobileId)?.wireVersion;
	}

	async getMobileCapabilities(mobileId: string): Promise<readonly string[] | undefined> {
		const session = this.sessions.get(mobileId);
		return session?.hasCurrentProtocol ? session.capabilities : undefined;
	}

	async getStatus(): Promise<IParadisMobileStatus> {
		return this.snapshot();
	}

	async getConfirmedAgentPanes(): Promise<IParadisConfirmedAgentPanes> {
		return this.confirmedAgentPanes;
	}

	/** デスクトップ UI 向けの読み取り口。モバイル連携が無効でも動く（送信は一切しない）。 */
	async getAgentPaneInsights(tokens: readonly string[]): Promise<readonly IParadisAgentPaneInsight[]> {
		return this.agentChat.getDesktopPaneInsights(Array.isArray(tokens) ? tokens.filter(token => typeof token === 'string') : []);
	}

	// --- デスクトップのチャット表示向けの読み取り口（agentChat）。モバイル連携が無効でも動く。モバイルへは送らない。

	async watchAgentChat(watcherId: string, tokens: readonly string[], visible?: readonly string[]): Promise<void> {
		if (typeof watcherId !== 'string' || watcherId.length === 0 || watcherId.length > 200 || !Array.isArray(tokens)) {
			return;
		}
		const visibleTokens = Array.isArray(visible) ? visible.filter(token => paradisIsAgentChatToken(token)) : [];
		this.agentChat.watchDesktopChat(watcherId, tokens.filter(token => paradisIsAgentChatToken(token)), visibleTokens);
	}

	async getAgentChat(token: string, cursor: IParadisAgentChatCursor | undefined): Promise<IParadisAgentChatView | undefined> {
		if (!paradisIsAgentChatToken(token)) {
			return undefined;
		}
		const validCursor = cursor !== undefined && cursor !== null && typeof cursor.epoch === 'string' && Number.isSafeInteger(cursor.rev) ? { epoch: cursor.epoch, rev: cursor.rev } : undefined;
		return this.agentChat.getDesktopChat(token, validCursor);
	}

	async getAgentChatFullText(token: string, epoch: string, rev: number): Promise<string | undefined> {
		return paradisIsAgentChatToken(token) && typeof epoch === 'string' && Number.isSafeInteger(rev) ? this.agentChat.getDesktopChatFullText(token, epoch, rev) : undefined;
	}

	async getAgentChatImage(token: string, epoch: string, rev: number, index: number): Promise<IParadisAgentChatImageData | undefined> {
		return paradisIsAgentChatToken(token) && typeof epoch === 'string' && Number.isSafeInteger(rev) && Number.isSafeInteger(index)
			? this.agentChat.getDesktopChatImage(token, epoch, rev, index)
			: undefined;
	}

	async getAgentChatCommands(token: string): Promise<readonly IParadisAgentChatCommand[]> {
		return paradisIsAgentChatToken(token) ? this.agentChat.getDesktopChatCommands(token) : [];
	}

	async claimAgentChatInteraction(token: string, kind: 'question' | 'approval', id: string): Promise<boolean> {
		return paradisIsAgentChatToken(token) && (kind === 'question' || kind === 'approval') && typeof id === 'string' && id.length <= 500
			? this.agentChat.claimDesktopInteraction(token, kind, id)
			: false;
	}

	async releaseAgentChatInteraction(token: string, kind: 'question' | 'approval', id: string, sent: boolean): Promise<void> {
		if (paradisIsAgentChatToken(token) && (kind === 'question' || kind === 'approval') && typeof id === 'string') {
			this.agentChat.releaseDesktopInteraction(token, kind, id, sent === true);
		}
	}

	async answerAgentChatApproval(token: string, interactionId: string, choiceId: string): Promise<boolean> {
		// 選択肢付きの承認は Codex のペイン専用 app-server から来ていた（それはやめた）。いま答えられるのは、
		// Claude Code の mod（Claude Mods）が待っている承認の「以後は確認しない」だけ（キーでは渡せない）
		return paradisIsAgentChatToken(token) && typeof interactionId === 'string' && choiceId === 'always'
			? this.agentChat.answerDesktopApprovalViaMod(token, interactionId, choiceId)
			: false;
	}

	async claimAgentAction(mobileId: string, requestId: string, token: string, epoch: string, lease: IParadisMobileWindowLease): Promise<'claimed' | 'stale' | 'expired'> {
		return await this.withCurrentRegisteredLease(lease, async () => this.agentChat.claimSendMessageAction(mobileId, requestId, token, epoch, lease.windowId, lease.windowSession)) ?? 'stale';
	}

	async continueAgentInteraction(mobileId: string, requestId: string, token: string, epoch: string, terminalId: number, lease: IParadisMobileWindowLease): Promise<'valid' | 'completed' | 'stale'> {
		return await this.withCurrentRegisteredLease(lease, async () => this.agentChat.continueInteractionAction(mobileId, requestId, token, epoch, terminalId, lease.windowId, lease.windowSession)) ?? 'stale';
	}

	async finalizeAgentInteraction(mobileId: string, requestId: string, token: string, outcome: 'accepted' | 'failed', lease: IParadisMobileWindowLease): Promise<void> {
		await this.withCurrentRegisteredLease(lease, async () => {
			this.agentChat.finalizeInteractionAction(mobileId, requestId, token, outcome, lease.windowId, lease.windowSession);
		});
	}

	async validateAgentAction(mobileId: string, requestId: string, token: string, epoch: string, terminalId: number, lease: IParadisMobileWindowLease): Promise<boolean> {
		return await this.withCurrentRegisteredLease(lease, async () => this.agentChat.validateClaimedAction(mobileId, requestId, token, epoch, terminalId, lease.windowId, lease.windowSession)) ?? false;
	}

	private snapshot(): IParadisMobileStatus {
		return {
			state: this.connectionState,
			deviceId: this.state.device?.deviceId,
			pairedDevices: this.state.mobiles.map(m => m.name),
			pairedMobiles: this.state.mobiles.map(m => ({ mobileId: m.mobileId, name: m.name })),
			onlineMobiles: [...this.sessions.values()].filter(s => s.hasCurrentProtocol).length,
			...(this.unauthorized ? { unauthorized: true } : {}),
			...(this.storeProblem !== undefined ? { storeProblem: this.storeProblem } : {}),
		};
	}

	/**
	 * pcToken の失効が確定した（またはしなくなった）ことを記録し、UIへ通知する。
	 * 状態が変わったときだけ通知するのは、5分間隔の再試行のたびに再描画させないため。
	 */
	private setUnauthorized(unauthorized: boolean): void {
		if (this.unauthorized === unauthorized) {
			return;
		}
		this.unauthorized = unauthorized;
		this._onDidChangeStatus.fire(this.snapshot());
	}

	/**
	 * pcToken がまだ有効かをHTTPで確かめる（副作用のない pc/check を叩く）。
	 *
	 * WebSocket のハンドシェイクは、リレーが401で拒否した場合も経路が死んだ場合も undici からは
	 * 同じ close 1006 に見えるため、これが両者を区別する唯一の手段。404 を返す古いリレーや
	 * 5xx・ネットワーク例外は「判別不能」なので何も確定させない（誤って再ペアリングを促さない）。
	 */
	private async probeAuthorization(): Promise<void> {
		const device = this.state.device;
		if (this.authProbeInFlight || !device || !this.enabled) {
			return;
		}
		this.authProbeInFlight = true;
		try {
			const res = await fetch(`${this.relayHttpBase()}/device/${device.deviceId}/pc/check`, {
				method: 'POST',
				headers: { authorization: `Bearer ${device.pcToken}` },
				// ハーフオープンな経路では undici の既定(300秒)まで待ってしまい、その間ずっと
				// authProbeInFlight が立って検知が遅れる。
				signal: AbortSignal.timeout(10_000),
			});
			// 401 だけを認証切れとみなす。リレーが返すのは 401 のみで、403 は WAF・企業プロキシ・
			// キャプティブポータルが返す典型コード。そうした経路では WS も 1006 で落ちるため、
			// 403 を受理すると「案内どおり再ペアリングしても直らない」誤検知になる。
			if (res.status === 401) {
				this.logService.warn('[paradisMobileRelay] relay rejected the stored pcToken; re-pairing is required');
				this.setUnauthorized(true);
			} else if (res.ok) {
				this.setUnauthorized(false);
			}
			// **この結果が Sentry に無いせいで切り分けが止まっていた。** 1006 は経路断でも
			// 401 拒否でも同じ形で届くので、close code だけでは永久に決着しない。プローブは
			// その区別のために存在するのに、判定をローカル状態へ書くだけで外へ出していなかった。
			// 到達できて 200 なら経路もトークンも生きている＝WS 側だけが落ちている、と確定できる。
			this.reportAuthProbe(res.ok ? 'ok' : res.status === 401 ? 'unauthorized' : 'rejected', res.status);
		} catch (err) {
			// ネットワーク自体が死んでいる＝認証の問題ではないので何も確定させない。
			this.logService.trace('[paradisMobileRelay] auth probe failed', String(err));
			// ただし「到達すらできない」ことは経路側の証拠なので、それは残す。undici の cause code
			// （ENOTFOUND / ECONNREFUSED / CERT_* / TimeoutError）で DNS・拒否・TLS・黒穴が 1 件で決まる。
			this.reportAuthProbe('unreachable', undefined, probeFailureCause(err));
		} finally {
			this.authProbeInFlight = false;
		}
	}

	private setConnectionState(state: ParadisMobileConnectionState): void {
		if (this.connectionState !== state) {
			this.connectionState = state;
			this._onDidChangeStatus.fire(this.snapshot());
		}
	}

	async initialize(enabled: boolean, relayUrl: string | undefined): Promise<void> {
		// 設定は既定値を持つので、未設定でも renderer は既定 URL を文字列で渡してくる。それを
		// override として持つと `safe_relay_kind` が全員 `custom` になり（2026-09 の Sentry で
		// 3 台・全イベントがそうだった）、自前リレー利用者だけの障害を切り分けられない。
		this.relayUrlOverride = relayUrl === undefined || relayUrl.replace(/\/$/, '') === PARADIS_MOBILE_DEFAULT_RELAY_URL ? undefined : relayUrl;
		// renderer が設定値を持ってくる前でも名前が空にならないよう、ホスト名を既定として入れておく
		// （まだ誰も繋がっていないので、ここではブロードキャストしない）。
		if (this.pcName === undefined) {
			this.pcName = paradisFormatPcName(undefined, hostname());
			this.terminalRegistry.setPcName(this.pcName);
		}
		this.loadMachineIdHash();
		await this.ensureLoaded();
		this.updateDiagnosticCorrelation();
		this.enabled = enabled;
		this.setStateBroadcastMetricsEnabled(enabled);
		this.disconnectReporter.setEnabled(enabled);
		this.connectIfReady();
		this.updateEagerTailing();
	}

	async setEnabled(enabled: boolean): Promise<void> {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		this.setStateBroadcastMetricsEnabled(enabled);
		if (enabled) {
			this.connectIfReady();
		} else {
			this.disconnect();
			this.setConnectionState('disabled');
		}
		this.updateEagerTailing();
	}

	/** リレー有効 かつ ペアリング済みモバイルが1台以上あるときだけ、質問検出用の常時tailを回す。 */
	private updateEagerTailing(): void {
		this.agentChat.setEagerTailing(this.enabled && this.state.mobiles.length > 0);
	}

	/** transcript に現れた質問を Notify として全モバイルへ届ける（オフラインへはAPNsプッシュ）。 */
	private notifyAgentQuestion(info: { terminalId: number; agent: 'claude' | 'codex'; text: string; ws?: string; agentToken: string; owner: IParadisMobilePaneOwner }): void {
		// 本文には質問文の原文を入れ、`category: 'question'` を付けて出口へ渡す。種類の言葉・Markdown の除去・
		// 伏せ字・長さの調整は出口（composeNotifyVariants）がまとめて行う（プッシュの 3800B に収まるまで削るのも出口）。
		const body = info.text.slice(0, PARADIS_NOTIFY_DETAIL_MAX_CHARS);
		const desktopState = this.terminalRegistry.desktopState();
		const terminal = desktopState.terminals.find(candidate => candidate.agentToken === info.agentToken);
		// ターミナルの ws は shared process が窓IDを冠したキーなので、workspaces 側も同じキーで引ける。
		const workspace = terminal?.ws !== undefined ? desktopState.workspaces.find(candidate => candidate.id === terminal.ws) : undefined;
		const payload: NotifyPayload = {
			kind: 'agent-question',
			id: `q${generateUuid()}`,
			// タイトルはワークツリー名だけに使い、質問の見出し（header）は本文に譲る。
			// 本文には質問文そのものが入っているので、見出しを足しても同じことを二度言うだけになる。
			title: paradisNotifyTitle(workspace?.name, terminal?.title),
			subtitle: paradisAgentLabel(info.agent),
			body,
			category: 'question',
			agent: info.agent,
			terminalId: info.terminalId,
			...(terminal !== undefined ? { terminalKey: terminal.terminalKey, windowId: terminal.windowId } : {}),
			agentToken: info.agentToken,
			...(terminal?.ws !== undefined ? { ws: terminal.ws } : {}),
			at: Date.now(),
		};
		this.dispatchNotify(encodeNotify(payload), info.owner);
	}

	// モバイルID → 通知鍵（PC長期秘密鍵 × モバイル長期公開鍵から導出、プロセス寿命でキャッシュ）。
	private readonly notifyKeyCache = new Map<string, Promise<Uint8Array>>();

	/** 届いたか分からない通知の取り置き（次に繋がったら通知一覧へ流し直す）。 */
	private readonly missedNotify = new ParadisMissedNotifyQueue();

	/** 通知の中身の出どころ（hook の最後の発言・失敗の理由・承認の中身。`paradisNotifyContentSource.ts`）。 */
	private readonly notifyHookLedger = this._register(new ParadisNotifyHookLedger());

	/** 出した通知と、片付いた通知（W2-27。次のプッシュでロック画面から消してもらう）。 */
	private readonly dismissLedger = new ParadisNotifyDismissLedger();

	/** 裏に回ったスマホの期限（W2-34）と、裏に回る直前に信用してプッシュしなかった通知。 */
	private readonly backgroundSessions = new ParadisBackgroundSessionWatch();
	private readonly recentTrustedNotifies = new ParadisRecentTrustedNotifies();

	private notifyKeyFor(mobileId: string, pubKeyB64: string): Promise<Uint8Array> {
		let cached = this.notifyKeyCache.get(mobileId);
		if (!cached) {
			cached = (async () => {
				const identity = await this.ensureIdentity();
				return deriveNotifyKey(identity.privateKey, fromBase64Url(pubKeyB64));
			})();
			// 失敗をキャッシュしない（次回再導出させる）
			cached.catch(() => this.notifyKeyCache.delete(mobileId));
			this.notifyKeyCache.set(mobileId, cached);
		}
		return cached;
	}

	/**
	 * Notify ペイロードを全ペアリング済みモバイルへ配送する。
	 * - E2Eフレーム: セッションがあれば必ず送る（アプリ内の通知一覧のため）
	 * - APNsプッシュ: 「鳴らすべき」かつ「アプリが自力でバナーを出せると信用できない」ときに送る。
	 *   通知鍵で封緘した暗号文を push-notify 制御メッセージでリレーへ渡し、リレーがAPNsへ配送する。
	 *   リレー/APNsに見えるのは「通知が発生した」ことだけで、本文はiOSのNotification
	 *   Service Extension が復号する（設計書 §5.2）。
	 *
	 * どちらを送るかの判断は `paradisNotifyDelivery.ts` に切り出してある（そちらのコメントに
	 * 「ソケットが残っていてもアプリは死んでいることがある」という前提の説明がある）。
	 */
	private dispatchNotify(bytes: Uint8Array, expectedOwner?: IParadisMobileWindowLease): void {
		if (expectedOwner !== undefined) {
			this.withCurrentRegisteredLease(expectedOwner, async () => this.dispatchNotifyNow(bytes, expectedOwner))
				.catch(error => this.logService.warn('[paradisMobileRelay] notify owner validation failed', error));
			return;
		}
		this.dispatchNotifyNow(bytes);
	}

	private dispatchNotifyNow(inputBytes: Uint8Array, expectedOwner?: IParadisMobileWindowLease): void {
		const now = Date.now();
		// 本文（最後の発言・承認の中身・質問文）と種類を決める（notify.content.v1）。通知を作る場所は2つあるが、
		// 出口はここだけなので中身を足すのもここ。「通知に内容を含める」はスマホごとの設定なので、含める版と
		// 含めない版を作っておき、スマホごとに選ぶ。
		const variants = this.composeNotifyVariants(inputBytes, now);
		// どのPCから来たかを、フレーム・プッシュ・取り置きの全部に同じ形で乗せる。
		// 通知を作る場所は shared process と renderer の2つあるが、出口はここだけなので刻むのもここ。
		const fullBytes = this.stampNotifyOrigin(variants?.withContent ?? inputBytes);
		const plainBytes = variants !== undefined ? this.stampNotifyOrigin(variants.withoutContent) : fullBytes;
		// 配送判断と、既読時のキュー刈り取りに要る項目を1回のパースで取り出す
		// （形式不正なら種別が undefined になり、鳴らす側へ倒れる）。
		const meta = peekNotifyMeta(fullBytes);
		const pcFocused = this.pcFocused;
		if (meta.id !== undefined) {
			this.dismissLedger.record(meta.id, meta.agentToken, meta.kind, now);
		}
		// 次のプッシュで消してもらう、片付いた通知（W2-27）。どのスマホにも同じ一覧を載せる（印は鍵ごとに作る）。
		const dismissIds = this.dismissLedger.dismissable(now, meta.id);
		// 台数分の再エンコードを避けるため、版と理由ごとに1回だけ作る。
		const quietCache = new Map<string, Uint8Array>();
		const quietBytes = (bytes: Uint8Array, reason: ParadisNotifyQuiet) => {
			const cacheKey = `${bytes === fullBytes ? 'full' : 'plain'}:${reason}`;
			let cached = quietCache.get(cacheKey);
			if (cached === undefined) {
				cached = this.quietNotifyBytes(bytes, reason);
				quietCache.set(cacheKey, cached);
			}
			return cached;
		};
		for (const mobile of this.state.mobiles) {
			const session = this.sessions.get(mobile.mobileId);
			const bytes = paradisNotifyIncludeContent(mobile.notifyPrefs) ? fullBytes : plainBytes;
			const delivery = paradisResolveNotifyDelivery({
				kind: meta.kind,
				prefs: mobile.notifyPrefs,
				pcFocused,
				sessionReady: session?.hasCurrentProtocol === true,
				msSinceLastInbound: session?.msSinceLastInbound(now),
				appBackgrounded: session?.backgrounded === true,
			});
			// フレームは通知一覧のためのもの。鳴らす必要が無い通知も、あとからスマホで
			// 「PCの前にいた間に何があったか」を追えるように送る（以前は配信自体を止めていた）。
			if (delivery.frame && session !== undefined) {
				const frameBytes = delivery.quiet !== undefined ? quietBytes(bytes, delivery.quiet) : bytes;
				session.sendFrame(Channels.Notify, undefined, frameBytes).catch(err => this.logService.warn('[paradisMobileRelay] notify frame failed', err));
			}
			// 上のフレームが本当に届いたかは分からない（相手が凍っていてもソケットは生きたままに
			// 見える。これがそもそもの不具合の原因）。届いたかに関わらず取り置き、次に繋がったとき
			// 通知一覧へ流し直す。モバイルはIDで重複を弾くので、二重に並ぶことはない。
			// 流し直す分は必ず `muted`: そのときには鳴らす機会が過ぎている。`pushed` にすると、
			// プッシュを受け取れない端末が復帰時に大昔の通知で鳴ってしまう。
			this.missedNotify.add(mobile.mobileId, { id: meta.id, agentToken: meta.agentToken, bytes: quietBytes(bytes, 'muted') });
			if (!delivery.push) {
				// 鳴らすべきなのに、アプリが自分で出せると信用してプッシュしなかった。直後にアプリが
				// 「裏に回った」と言ってきたら、プッシュし直す（W2-34。`paradisMobileBackgroundGrace.ts`）。
				if (delivery.quiet === undefined && delivery.frame) {
					this.recentTrustedNotifies.add(mobile.mobileId, bytes, now);
				}
				continue;
			}
			this.pushNotifyTo(mobile, bytes, dismissIds, expectedOwner);
		}
	}

	/** 1台のモバイルへ通知をプッシュで送る（通知鍵で封緘し、リレーへ push-notify を頼む）。 */
	private pushNotifyTo(mobile: IParadisRelayPairedMobile, inputBytes: Uint8Array, dismissIds: readonly string[], expectedOwner?: IParadisMobileWindowLease): void {
		// 長押しの画面（detail）を描けないアプリには詳細を載せない（読まれない分で本文を削らない）。
		const preferDetail = paradisNotifyPrefersDetail(mobile.notifyPrefs);
		const bytes = preferDetail ? inputBytes : this.withoutNotifyDetail(inputBytes);
		this.notifyKeyFor(mobile.mobileId, mobile.pubKey).then(async key => {
			// 片付けの印（W2-27）は捨てない。収まらなければ本文と詳細のほうを削る（`paradisFitNotifyBytesForPush`）。
			// 印だけで上限を超える（ありえない大きさ）ときに限って、印を外した版で詰め直す。
			const withDismiss = paradisWithNotifyDismiss(bytes, paradisMobileDismissTags(key, dismissIds));
			const fitted = paradisFitNotifyBytesForPush(withDismiss, PARADIS_PUSH_PAYLOAD_LIMIT_BYTES, preferDetail)
				?? (withDismiss !== bytes ? paradisFitNotifyBytesForPush(bytes, PARADIS_PUSH_PAYLOAD_LIMIT_BYTES, preferDetail) : undefined);
			if (fitted === undefined) {
				this.logService.warn('[paradisMobileRelay] push payload cannot be trimmed under the relay limit; dropping the push');
				return;
			}
			const encoded = toBase64Url(await sealNotify(key, fitted));
			if (encoded.length > PARADIS_PUSH_PAYLOAD_LIMIT_BYTES) {
				this.logService.warn(`[paradisMobileRelay] push payload too large (${encoded.length}B); dropping the push`);
				return;
			}
			// 同じエージェントの通知はロック画面で置き換え、同じスペースの通知はまとめる（W2-08）。
			// ID は通知鍵の HMAC なので、リレーと APNs からは中身を推測できない。旧リレーは読まずに無視する。
			const push = { type: 'push-notify', mobileId: mobile.mobileId, payload: encoded, ...paradisMobilePushIds(key, bytes) } as const;
			if (expectedOwner !== undefined) {
				await this.withCurrentRegisteredLease(expectedOwner, async () => {
					this.sendControl(push);
				});
			} else {
				this.sendControl(push);
			}
		}).catch(err => this.logService.warn('[paradisMobileRelay] push-notify seal failed', err));
	}

	/** 詳細（detail）を外した版。JSONとして読めない・詳細が無いときはそのまま返す。 */
	private withoutNotifyDetail(bytes: Uint8Array): Uint8Array {
		try {
			const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> | null;
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.detail === undefined) {
				return bytes;
			}
			delete parsed.detail;
			return new TextEncoder().encode(JSON.stringify(parsed));
		} catch {
			return bytes;
		}
	}

	/**
	 * 通知の本文・種類・副題の材料を決める（notify.content.v1）。中身の出どころは hook と tailer
	 * （`paradisNotifyContentSource.ts`）、文言は `paradisNotifyCompose.ts`。エージェントの通知でなければ undefined。
	 * 「通知に内容を含める」の版（withContent）と含めない版（withoutContent）を返す。
	 */
	private composeNotifyVariants(bytes: Uint8Array, now: number): { readonly withContent: Uint8Array; readonly withoutContent: Uint8Array } | undefined {
		let record: Record<string, unknown>;
		try {
			const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return undefined;
			}
			record = parsed as Record<string, unknown>;
		} catch {
			return undefined;
		}
		const kind = record.kind;
		if (kind !== 'agent-done' && kind !== 'agent-question' && kind !== 'agent-error') {
			return undefined;
		}
		const token = typeof record.agentToken === 'string' && record.agentToken.length > 0 ? record.agentToken : undefined;
		const presetQuestion = record.category === 'question';
		const pane = token !== undefined ? this.agentChat.notifyPaneContent(token) : undefined;
		const resolution = paradisResolveNotifyContent({
			kind,
			...(presetQuestion ? { presetCategory: 'question' as const, ...(typeof record.body === 'string' ? { presetContent: record.body } : {}) } : {}),
			...(token !== undefined ? { hookTurnEnd: this.notifyHookLedger.turnEnd(token, now), hookApproval: this.notifyHookLedger.approval(token, now) } : {}),
			...(pane !== undefined ? { pane } : {}),
			now,
		});
		if (resolution === undefined) {
			return undefined;
		}
		const agent = pane?.agent ?? (record.agent === 'claude' || record.agent === 'codex' ? record.agent : undefined);
		const agentLabel = agent !== undefined ? paradisAgentLabel(agent) : undefined;
		const title = typeof record.title === 'string' ? record.title : '';
		// タブ名は PC の状態のターミナル名を正とする（renderer の通知は副題にターミナル名を入れてくるので、無ければそれ）。
		const terminal = token !== undefined ? this.terminalRegistry.desktopState().terminals.find(candidate => candidate.agentToken === token) : undefined;
		const tabSource = terminal?.title ?? (!presetQuestion && typeof record.subtitle === 'string' ? record.subtitle : undefined);
		const tab = paradisNotifyTabLabel(tabSource, agentLabel, title);
		const legacySubtitle = paradisLegacyNotifySubtitle(agentLabel, tab);
		const base: Record<string, unknown> = {
			...record,
			kind: resolution.kind,
			category: resolution.category,
			...(agent !== undefined ? { agent } : {}),
			...(tab !== undefined ? { tab } : {}),
			...(resolution.interactionId !== undefined ? { interactionId: resolution.interactionId } : {}),
		};
		delete base.subtitle;
		delete base.detail;
		if (legacySubtitle !== undefined) {
			base.subtitle = legacySubtitle;
		}
		const variants = paradisComposeNotifyVariants(base, {
			...(agentLabel !== undefined ? { agentLabel } : {}),
			category: resolution.category,
			...(resolution.content !== undefined ? { content: resolution.content } : {}),
			...(resolution.summary !== undefined ? { summary: resolution.summary } : {}),
			...(resolution.errorCode !== undefined ? { errorCode: resolution.errorCode } : {}),
		});
		const encoder = new TextEncoder();
		return { withContent: encoder.encode(JSON.stringify(variants.withContent)), withoutContent: encoder.encode(JSON.stringify(variants.withoutContent)) };
	}

	/**
	 * 送信元PC（deviceId と表示名）を通知へ刻む。
	 *
	 * 受け取る側はこれを2つに使う。ひとつはPCの切り替え（通知をタップしたとき、そのPCへ移る）。
	 * もうひとつは表示で、2台以上とペアリングしているときだけエージェント名の後ろへPC名を継ぎ足す。
	 * 封緘の中に入るのでリレーには見えず、差し替えもできない。
	 *
	 * JSONとして読めないバイト列はそのまま返す（判定不能なものを黙って作り替えない）。
	 */
	private stampNotifyOrigin(bytes: Uint8Array): Uint8Array {
		const pcId = this.state.device?.deviceId;
		if (pcId === undefined && this.pcName === undefined) {
			return bytes;
		}
		try {
			const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> | null;
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return bytes;
			}
			return new TextEncoder().encode(JSON.stringify({
				...parsed,
				...(pcId !== undefined ? { pcId } : {}),
				...(this.pcName !== undefined ? { pcName: this.pcName } : {}),
			}));
		} catch {
			return bytes;
		}
	}

	/**
	 * 同じ通知に「バナーは出さないでほしい」印を付けた版を作る。
	 * JSONとして読めないバイト列はそのまま返す（判定不能なものを黙って作り替えない）。
	 */
	private quietNotifyBytes(bytes: Uint8Array, reason: ParadisNotifyQuiet): Uint8Array {
		try {
			const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> | null;
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return bytes;
			}
			return new TextEncoder().encode(JSON.stringify({ ...parsed, quiet: reason }));
		} catch {
			return bytes;
		}
	}

	/** セッションが確立した直後に取り置き分を流す。IDが同じものはモバイル側が弾く。 */
	private flushMissedNotify(mobileId: string, session: MobileSession): void {
		for (const entry of this.missedNotify.take(mobileId)) {
			session.sendFrame(Channels.Notify, undefined, entry.bytes)
				.catch(err => this.logService.warn('[paradisMobileRelay] missed notify replay failed', err));
		}
	}

	/**
	 * アプリが裏に回った・前面に戻った（W2-34）。裏に回った印はこのセッションの間だけ持ち、
	 * 立っている間の通知は受信が新しくてもプッシュで送る（`paradisResolveNotifyDelivery` の `appBackgrounded`）。
	 * 確認を返すのは印を立て終えてから（確認を受けたアプリは接続を保つので、先に返すと取りこぼす）。
	 * 前面に戻ったら、裏にいた間の通知を鳴らさない形で流し直す（握手をやり直さないので、握手のときの流し直しが走らない）。
	 */
	private handleNotifyVisibility(mobileId: string, session: MobileSession, state: 'background' | 'foreground', id: string | undefined): void {
		if (this.sessions.get(mobileId) !== session) {
			return;
		}
		const wasBackgrounded = session.backgrounded;
		session.backgrounded = state === 'background';
		session.sendFrame(Channels.Notify, undefined, encodeNotifyVisibilityAck(state, id))
			.catch(err => this.logService.warn('[paradisMobileRelay] visibility ack failed', err));
		if (state === 'background') {
			// 裏にいる間は画面が見えないので、ブラウザミラーのキャプチャはすぐ止める
			// （アプリは前面に戻ったら張り直す）。
			this.browserMirror.stopSession(mobileId);
			// iOS は裏のアプリを数秒で止めるので、アプリの30秒のタイマーは当てにならない。
			// 前面に戻らないまま期限が来たら、presence offline と同じ後始末をする。
			this.backgroundSessions.begin(mobileId, () => {
				if (this.sessions.get(mobileId) === session && session.backgrounded) {
					this.logService.info('[paradisMobileRelay] backgrounded mobile did not come back; dropping its session');
					this.dropMobileSession(mobileId);
				}
			});
			// 裏に回る直前の約1往復の間に、信用してプッシュしなかった通知をプッシュし直す。
			const mobile = this.state.mobiles.find(candidate => candidate.mobileId === mobileId);
			// PC で確認済みにした・別の端末で開いたなど、もう片付いた通知は鳴らし直さない。
			const recent = this.recentTrustedNotifies.take(mobileId, Date.now()).filter(bytes => !this.dismissLedger.isSettled(peekNotifyMeta(bytes).id));
			if (mobile !== undefined && recent.length > 0) {
				const dismissIds = this.dismissLedger.dismissable(Date.now());
				for (const bytes of recent) {
					this.pushNotifyTo(mobile, bytes, dismissIds.filter(dismissId => dismissId !== peekNotifyMeta(bytes).id));
				}
			}
			return;
		}
		this.backgroundSessions.end(mobileId);
		if (wasBackgrounded && session.hasCurrentProtocol) {
			this.flushMissedNotify(mobileId, session);
		}
	}

	/**
	 * モバイル1台のセッションと、それに付いた配信（ブラウザミラー・チャットの購読・WebRTC・音声）を捨てる
	 * （presence offline と、裏に回ったまま戻らなかったとき）。
	 */
	private dropMobileSession(mobileId: string): void {
		this.sessions.get(mobileId)?.close();
		this.sessions.delete(mobileId);
		this.backgroundSessions.end(mobileId);
		this.recentTrustedNotifies.forget(mobileId);
		this.webrtcRendererLeases.delete(mobileId);
		this.dropVoiceSubscriber(mobileId);
		this.browserMirror.stopSession(mobileId);
		this.agentChat.dropSubscriber(mobileId);
		this._onDidChangeStatus.fire(this.snapshot());
	}

	/** モバイルから同期された通知設定（notifyチャネル M→PC）を保存する。 */
	private handleNotifyPrefs(mobileId: string, payload: Uint8Array): void {
		try {
			const msg = JSON.parse(new TextDecoder().decode(payload)) as { t?: string; agentDone?: boolean; agentQuestion?: boolean; suppressWhenPcFocused?: boolean; pcFocusQuiet?: boolean; includeContent?: boolean };
			if (msg.t !== 'prefs') {
				return;
			}
			const mobile = this.state.mobiles.find(m => m.mobileId === mobileId);
			if (!mobile) {
				return;
			}
			const next = {
				agentDone: msg.agentDone !== false,
				agentQuestion: msg.agentQuestion !== false,
				// 新しいアプリは `pcFocusQuiet` で送ってくる。旧アプリは旧キーしか送らないので
				// そちらへフォールバックする（旧キーはここでしか読まず、保存もしない）。
				pcFocusQuiet: typeof msg.pcFocusQuiet === 'boolean' ? msg.pcFocusQuiet : msg.suppressWhenPcFocused === true,
				// 「通知に内容を含める」（notify.content.v1）。知らない旧アプリは送ってこない。そのときは書かずに
				// 定型文を送る（Q175 A。書いてあるか自体が「長押しの画面を描けるアプリか」の印になる）。
				...(typeof msg.includeContent === 'boolean' ? { includeContent: msg.includeContent } : {}),
			};
			// モバイルはonline遷移のたびに再送してくるため、値が変わった時だけ書き込む
			// （バックグラウンド復帰ごとのディスク書き込みチャーンを避ける）。
			const prev = mobile.notifyPrefs;
			if (prev && prev.agentDone === next.agentDone && prev.agentQuestion === next.agentQuestion && paradisNotifyPcFocusQuiet(prev) === next.pcFocusQuiet && prev.includeContent === next.includeContent) {
				return;
			}
			mobile.notifyPrefs = next;
			this.save().catch(err => this.logService.warn('[paradisMobileRelay] notify prefs save failed', err));
		} catch (err) {
			this.logService.warn('[paradisMobileRelay] invalid notify prefs payload', err);
		}
	}

	/**
	 * モバイルが通知一覧で項目を処理した（タップ/クリア）ことを他のペアリング済み端末へ伝える
	 * （notifyチャネル M→PC→他M）。オフライン端末はAPNsで起こしてまで同期する話ではないため
	 * オンラインのセッションにのみ配送する（次回オンライン化時は素直に残っていて構わない）。
	 */
	private handleNotifyDismiss(fromMobileId: string, notifyId: string, opened: boolean): void {
		// 取り置きからも外す。残すと、あとで繋がったときに処理済みの通知が未読として蘇る。
		this.missedNotify.drop({ id: notifyId });
		// 裏にいるスマホのロック画面からは、次のプッシュで消してもらう（W2-27）。
		this.dismissLedger.markDismissed(notifyId, Date.now(), opened);
		const bytes = encodeNotifyDismissed(notifyId);
		for (const mobile of this.state.mobiles) {
			if (mobile.mobileId === fromMobileId) {
				continue;
			}
			const session = this.sessions.get(mobile.mobileId);
			if (session?.hasCurrentProtocol) {
				session.sendFrame(Channels.Notify, undefined, bytes).catch(err => this.logService.warn('[paradisMobileRelay] notify dismiss forward failed', err));
			}
		}
	}

	/**
	 * PC側でペインが確認済みになった（{@link IParadisSharedPageBindings.onDidAcknowledgePane}）ことを
	 * 全ペアリング済みモバイルへ伝え、そのagentTokenに紐づく通知を履歴からも消させる。
	 * handleNotifyDismissと同様、オフライン端末はAPNsで起こしてまで同期する話ではないため
	 * オンラインのセッションにのみ配送する（次回オンライン化時は素直に残っていて構わない）。
	 */
	private dispatchAgentDismiss(token: string): void {
		// PCで確認済みにした分は、まだ届けていない取り置きからも外す。
		this.missedNotify.drop({ agentToken: token });
		// 確認より前に出した同じエージェントの通知は、次のプッシュでロック画面から消してもらう（W2-27）。
		this.dismissLedger.markAcknowledged(token, Date.now());
		const bytes = encodeNotifyDismissedByToken(token);
		for (const mobile of this.state.mobiles) {
			const session = this.sessions.get(mobile.mobileId);
			if (session?.hasCurrentProtocol) {
				session.sendFrame(Channels.Notify, undefined, bytes).catch(err => this.logService.warn('[paradisMobileRelay] agent dismiss forward failed', err));
			}
		}
	}

	/**
	 * PC側とモバイル側のイベントを突き合わせるための非PIIな相関IDを設定する。
	 *
	 * 両側とも Sentry の `user` を落としているため、これが無いと「PC側の切断」と「同時刻の
	 * モバイル側のエラー」が同じ事象なのかを判定できず、1件の事象が2件に見える。
	 * deviceId 自体はペアリングURIに載る値なので、そのままではなくハッシュ断片だけを送る。
	 */
	private updateDiagnosticCorrelation(): void {
		const deviceId = this.state.device?.deviceId;
		if (deviceId === undefined) {
			return;
		}
		setParadisDiagnosticCorrelationTag('para.pairing', createHash('sha256').update(deviceId).digest('hex').slice(0, 8));
	}

	private relayHttpBase(): string {
		const ws = (this.relayUrlOverride ?? PARADIS_MOBILE_DEFAULT_RELAY_URL).replace(/\/$/, '');
		return ws.replace(/^ws/, 'http');
	}

	private relayWsBase(): string {
		return (this.relayUrlOverride ?? PARADIS_MOBILE_DEFAULT_RELAY_URL).replace(/\/$/, '');
	}

	/**
	 * ペアリングを開始する。
	 *
	 * resetRegistration を渡すと、既存のデバイス登録を捨てて新規 provision からやり直す。
	 * リレーが保存済みの pcToken を拒否している状態（unauthorized）では、同じ資格情報で
	 * pair/begin を叩いても必ず401になり、ユーザーには復旧手段が無くなるため。ただし
	 * 破棄はペアリング済みモバイルを全て失う操作なので、呼び出し側で同意を取ってから渡すこと
	 * （2台目を追加するだけのつもりで押した操作で既存端末を失わせない）。
	 */
	async beginPairing(resetRegistration = false): Promise<IParadisMobilePairingSession> {
		const identity = await this.ensureIdentity();

		// 破棄は新しい登録が取れてからにする。先に捨てるとオフラインやリレー障害のときに
		// 「失っただけ」が確定し、しかも device が無いので connect() が即 return して
		// 再接続も走らなくなる。
		if (!this.state.device || resetRegistration) {
			const pcToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
			const res = await fetch(`${this.relayHttpBase()}/device/new/provision`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ pcPublicKey: toBase64Url(identity.publicKey), pcToken }),
			});
			if (!res.ok) {
				throw new Error(`provision failed: ${res.status}`);
			}
			const body = await res.json() as { deviceId: string };
			if (resetRegistration && this.state.device) {
				this.logService.warn('[paradisMobileRelay] replacing the rejected device registration');
				// 旧 deviceId の Durable Object へは二度と到達できないので、そこに紐づいていた
				// ペアリング済みモバイルも同時に無効になる。
				this.state.mobiles = [];
				this.disconnect();
			}
			this.state.device = { deviceId: body.deviceId, pcToken };
			this.setUnauthorized(false);
			this.updateEagerTailing();
			this.updateDiagnosticCorrelation();
			await this.save();
		}
		// ペアリング中はメッセージを受けるため必ず接続する（既に接続済みなら no-op）。
		this.connect();

		// ペアリングトークンを発行。pcTokenで認証する（リレー側で本人確認。C-1）。
		const res = await fetch(`${this.relayHttpBase()}/device/${this.state.device.deviceId}/pair/begin`, {
			method: 'POST',
			headers: { authorization: `Bearer ${this.state.device.pcToken}` },
		});
		if (!res.ok) {
			throw new Error(`pair/begin failed: ${res.status}`);
		}
		const body = await res.json() as { pairId: string; pairingToken: string; expiresAt: number };
		const pairingToken = fromBase64Url(body.pairingToken);
		this.pairing = { pairId: body.pairId, pairingToken, proposedName: 'モバイルデバイス', sasShown: false };

		const pairingUri = encodePairingUri({
			version: 1,
			relayUrl: this.relayWsBase(),
			deviceId: this.state.device.deviceId,
			pairId: body.pairId,
			pairingToken,
			pcPublicKey: identity.publicKey,
			// 初回ペアリングの時点で名前が分かると、モバイルは接続前のPC一覧にも正しい名前を出せる。
			...(this.pcName !== undefined ? { pcName: this.pcName } : {}),
		});
		return { deviceId: this.state.device.deviceId, pairingUri, expiresAt: body.expiresAt };
	}

	async approvePairing(): Promise<void> {
		if (!this.pairing || !this.pairing.mobilePubKey) {
			throw new Error('no pairing awaiting approval');
		}
		this.sendControl({ type: 'pairing-approve', pairId: this.pairing.pairId, name: this.pairing.proposedName });
		// 実際の mobiles への追加は relay からの 'paired'(mobileId) 受信時に行う。
	}

	async cancelPairing(): Promise<void> {
		if (this.pairing) {
			this.sendControl({ type: 'pairing-reject', pairId: this.pairing.pairId });
			this.pairing = undefined;
		}
	}

	async revokeDevice(deviceName: string, mobileId?: string): Promise<void> {
		// 名前は端末が名乗るものなので重なりうる。id を渡されたら、その1台だけを外す
		const matches = (m: { readonly mobileId: string; readonly name: string }) => mobileId !== undefined ? m.mobileId === mobileId : m.name === deviceName;
		const removed = this.state.mobiles.filter(matches);
		this.state.mobiles = this.state.mobiles.filter(m => !matches(m));
		// リレーへの取り消しは、台帳から外すのと同じ書き込みで積む（W2-35）。書けた後は、リレーが
		// 受け取ったと確かめるまで送り直す（落ちても次の起動で続きから送る）。
		const device = this.state.device;
		if (device !== undefined) {
			let outbox = this.revokeOutbox();
			for (const m of removed) {
				outbox = paradisEnqueueRevoke(outbox, device.deviceId, m.mobileId, Date.now());
			}
			this.state.pendingRelayRevokes = outbox;
		}
		try {
			await this.save();
		} finally {
			// 台帳を書けなくても（ENOSPC・権限など）、外すと決めた端末の接続はここで切る。保存の失敗は呼び出し側へ返す
			this.updateEagerTailing();
			// M-1: リレー側の資格情報も失効させ、既存のモバイル接続を切断する。
			for (const m of removed) {
				this.sessions.get(m.mobileId)?.close();
				this.sessions.delete(m.mobileId);
				this.webrtcRendererLeases.delete(m.mobileId);
				this.dropVoiceSubscriber(m.mobileId);
				this.missedNotify.forget(m.mobileId);
				this.browserMirror.stopSession(m.mobileId);
				this.agentChat.dropSubscriber(m.mobileId);
				this.notifyKeyCache.delete(m.mobileId);
				this.backgroundSessions.end(m.mobileId);
				this.recentTrustedNotifies.forget(m.mobileId);
			}
			void this.drainRevokeOutbox(true);
			this._onDidChangeStatus.fire(this.snapshot());
		}
	}

	// --- SSH 接続先 transcript の写し -----------------------------------------------------------
	//
	// 接続先を見られるのは、そこへ繋いでいるウィンドウだけ。読む作業はウィンドウに任せ、
	// ここは「どれを写すか」「どこまで写したか」だけを持つ。

	async listRemoteTranscriptMirrors(ownerId: string): Promise<readonly string[]> {
		return this.remoteTranscriptMirror.list(ownerId);
	}

	async beginRemoteTranscriptMirror(ownerId: string, remotePath: string): Promise<number> {
		return this.remoteTranscriptMirror.begin(ownerId, remotePath);
	}

	async appendRemoteTranscriptMirror(ownerId: string, remotePath: string, data: VSBuffer): Promise<number> {
		return this.remoteTranscriptMirror.append(ownerId, remotePath, data.buffer);
	}

	async resetRemoteTranscriptMirror(ownerId: string, remotePath: string): Promise<number> {
		return this.remoteTranscriptMirror.reset(ownerId, remotePath);
	}

	async releaseRemoteTranscriptMirrors(ownerId: string): Promise<void> {
		this.remoteTranscriptMirror.release(ownerId);
	}

	// runGit は paradisWorktreeGitChannel.ts（shared process と REH サーバーの両方に登録）へ移した。
	// SSH 接続先のリポジトリを操作するには git を接続先で動かす必要があり、mobileRelay サービスは
	// shared process 専用のため対応できない。

	/**
	 * agentチャネル用: renderer から「ターミナルinstanceId ⇔ ペイントークン」対応表を同期する
	 * （ウィンドウ単位の全置換）。チャットミラーはこの対応でモバイルの attach(id) を transcript へ解決する。
	 */
	async syncAgentPanes(lease: IParadisMobileWindowLease, revision: number, entries: readonly { terminalId: number; token: string; cwd?: string; ws?: string }[]): Promise<void> {
		await this.withCurrentRegisteredLease(lease, async () => {
			const synced = this.agentChat.syncPanes(lease.windowId, lease.windowSession, lease.rendererGeneration, revision, entries);
			if (!synced) {
				if (!this.terminalRegistry.isWindowReady(lease.windowId, lease.windowSession, lease.rendererGeneration)) {
					throw new Error('Agent pane snapshot was rejected before Renderer became ready');
				}
				return;
			}
			this.agentCommandAuthority.retain(this.agentCommandOwner(lease), new Set(entries.map(entry => entry.token)));
			if (this.terminalRegistry.markWindowReady(lease.windowId, lease.windowSession, lease.rendererGeneration)) {
				await this.broadcastDesktopState();
			}
		});
	}

	/**
	 * windowId → 直近報告されたフォーカス状態と受信時刻。suppressWhenPcFocused の判定に使う。
	 * rendererはフォーカス変化イベントに加え定期ハートビートでも再送する（下記WINDOW_FOCUS_TTL_MS
	 * コメント参照）。renderer がクラッシュ等でdisposeを経ずに落ちた場合、ハートビートが途絶えて
	 * 古いfocused=trueがTTL超過で自然に無視されるようにし、通知が恒久的にサイレント抑制される
	 * ことを防ぐ。
	 */
	private readonly windowFocus = new Map<number, { windowSession: string; rendererGeneration: number; focused: boolean; at: number }>();

	/**
	 * ハートビート間隔（renderer側、paradisMobileRelay.contribution.ts）より十分長い猶予。
	 * これを超えて更新が無いウィンドウは「もう存在しない」とみなしフォーカス判定から除外する。
	 */
	private static readonly WINDOW_FOCUS_TTL_MS = 90_000;

	/** いずれかのウィンドウがフォーカス中（かつ生存報告がTTL内）なら true（PCフォーカス中とみなす）。 */
	private get pcFocused(): boolean {
		const now = Date.now();
		let focused = false;
		for (const [windowId, entry] of this.windowFocus) {
			if (now - entry.at > ParadisMobileRelayService.WINDOW_FOCUS_TTL_MS
				|| this.terminalRegistry.leaseOfWindow(windowId)?.windowSession !== entry.windowSession
				|| this.terminalRegistry.leaseOfWindow(windowId)?.rendererGeneration !== entry.rendererGeneration) {
				this.windowFocus.delete(windowId);
				continue;
			}
			if (entry.focused) {
				focused = true;
			}
		}
		return focused;
	}

	async setPcFocus(lease: IParadisMobileWindowLease, focused: boolean): Promise<void> {
		await this.withCurrentRegisteredLease(lease, async () => {
			this.windowFocus.set(lease.windowId, { windowSession: lease.windowSession, rendererGeneration: lease.rendererGeneration, focused, at: Date.now() });
		});
	}

	/**
	 * agentチャネル用: `claude` / `codex` コマンドの実行開始検知 (shell integration 由来)。
	 * cwd ベースのセッション探索を前倒しするトリガーとしてのみ使う (詳細は common の interface コメント)。
	 */
	async notifyAgentCliCommand(lease: IParadisMobileWindowLease, paneToken: string, generation: number, commandLine: string, agent: 'claude' | 'codex', mode: 'new' | 'resume' | 'fork' | 'attach', cwd: string | undefined, commandCwd?: string, sessionId?: string): Promise<ParadisAgentCommandDeliveryResult> {
		return await this.withCurrentRegisteredLease(lease, async () => {
			const ownership = this.agentChat.ownershipOfPaneToken(paneToken);
			if (ownership.kind === 'ambiguous') {
				return 'ambiguous';
			}
			if (ownership.kind !== 'owned' || !this.sameLease(ownership.owner, lease)) {
				return 'stale';
			}
			const decision = this.agentCommandAuthority.start(this.agentCommandOwner(lease), paneToken, generation, commandLine);
			if (decision.apply) {
				this.agentChat.onCliCommandDetected(paneToken, agent, mode, cwd, commandCwd, sessionId);
			}
			return decision.result;
		}) ?? 'stale';
	}

	async noteRemoteAgentTranscript(lease: IParadisMobileWindowLease, paneToken: string, remoteAuthority: string, remotePath: string, commandStartedAt: number): Promise<'accepted' | 'ignored' | 'hooked' | 'stale'> {
		return await this.withCurrentRegisteredLease(lease, async () => {
			const ownership = this.agentChat.ownershipOfPaneToken(paneToken);
			if (ownership.kind !== 'owned' || !this.sameLease(ownership.owner, lease)) {
				return 'stale' as const;
			}
			// hook の印と同じ組み立て方にする（写し先の置き場と、接続先のペインの判定がこれで揃う）
			const remoteHostId = paradisAgentHookRemoteHostId(remoteAuthority);
			if (remoteHostId === undefined || typeof remotePath !== 'string' || typeof commandStartedAt !== 'number') {
				return 'ignored' as const;
			}
			return this.agentChat.onRemoteTranscriptDiscovered(paneToken, remotePath, remoteHostId, commandStartedAt);
		}) ?? 'stale';
	}

	async notifyAgentCliCommandFinished(lease: IParadisMobileWindowLease, paneToken: string, generation: number, suspended?: boolean): Promise<ParadisAgentCommandDeliveryResult> {
		return await this.withCurrentRegisteredLease(lease, async () => {
			const ownership = this.agentChat.ownershipOfPaneToken(paneToken);
			if (ownership.kind === 'ambiguous') {
				return 'ambiguous';
			}
			if (ownership.kind !== 'owned' || !this.sameLease(ownership.owner, lease)) {
				return 'stale';
			}
			const decision = this.agentCommandAuthority.finish(this.agentCommandOwner(lease), paneToken, generation);
			if (decision.apply) {
				this.agentChat.onCliCommandFinished(paneToken, suspended === true ? 'suspended' : 'exited');
			}
			return decision.result;
		}) ?? 'stale';
	}

	/**
	 * モバイルのPC一覧に出す、このPCの表示名を設定する。renderer は設定値をそのまま渡し、
	 * 空のときのホスト名へのフォールバックはここで行う（renderer からは `os` を読めないため）。
	 * 変わったときだけ desktop state を送り直す（名前は滅多に変わらないので間引きは要らない）。
	 */
	/**
	 * このPCの機械の印を desktop state に載せる（モバイルが複数PCの使用量を合計するとき、SSH 先が別に
	 * ペアリングしたPCと同じ機械かを見分けるため）。読めたら以後は読まない。読めなければ載せず、次の initialize で読み直す。
	 */
	private loadMachineIdHash(): void {
		if (this.machineIdHashRequested) {
			return;
		}
		this.machineIdHashRequested = true;
		this.readMachineIdHash().then(async machineIdHash => {
			if (machineIdHash === undefined) {
				// 読めなかった。次に initialize されたときに読み直す
				this.machineIdHashRequested = false;
				return;
			}
			if (this._store.isDisposed) {
				return;
			}
			if (this.terminalRegistry.setMachineIdHash(machineIdHash)) {
				await this.enqueueRendererAuthority(() => this.broadcastDesktopState());
			}
		}).catch(error => {
			this.machineIdHashRequested = false;
			this.logService.trace('[paradisMobileRelay] could not read the machine id', error);
		});
	}

	async setPcName(pcName: string | undefined): Promise<void> {
		const next = paradisFormatPcName(pcName, hostname());
		if (this.pcName === next) {
			return;
		}
		this.pcName = next;
		if (this.terminalRegistry.setPcName(next)) {
			await this.enqueueRendererAuthority(() => this.broadcastDesktopState());
		}
	}

	async notifyAgentTerminalHint(lease: IParadisMobileWindowLease, terminalId: number, hint: { readonly elapsedSeconds?: number; readonly tokenCount?: number }): Promise<void> {
		await this.withCurrentRegisteredLease(lease, async () => this.agentChat.onTerminalHint(lease.windowId, lease.windowSession, lease.rendererGeneration, terminalId, hint));
	}

	// searchFiles / searchText は paradisRemoteSearchChannel.ts（shared process と REH サーバーの
	// 両方に登録）へ移した。SSH 接続先のワークスペースを検索するには、ripgrep を接続先で
	// 動かす必要があり、mobileRelay サービスは shared process 専用のため対応できない。

	/** 台帳の取り消し待ち（W2-35）。形の合わない項目は捨てて読む。 */
	private revokeOutbox(): IParadisRelayRevokeEntry[] {
		return paradisSanitizeRevokeOutbox(this.state.pendingRelayRevokes);
	}

	private revokeDrain: Promise<void> | undefined;
	private revokeTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * 取り消し待ちをリレーへ送る（W2-35）。済んだもの・送っても変わらないもの・今の登録ではないものは外し、
	 * 一時的に失敗したものは間隔を空けて送り直す。`force` はリレーへつながった直後など、待ちを無視して送るとき。
	 * 同時には1本だけ流す。
	 */
	private drainRevokeOutbox(force = false): Promise<void> {
		if (this.revokeDrain !== undefined) {
			return this.revokeDrain;
		}
		const run = this.drainRevokeOutboxNow(force).finally(() => {
			this.revokeDrain = undefined;
			this.scheduleRevokeRetry();
		});
		this.revokeDrain = run;
		return run;
	}

	private async drainRevokeOutboxNow(force: boolean): Promise<void> {
		if (this.isStoreBlocked() || this.state.pendingRelayRevokes === undefined) {
			return;
		}
		const device = this.state.device;
		const now = Date.now();
		let changed = false;
		const next: IParadisRelayRevokeEntry[] = [];
		const snapshot = this.revokeOutbox();
		const key = (entry: IParadisRelayRevokeEntry) => `${entry.deviceId}\n${entry.mobileId}`;
		for (const entry of snapshot) {
			if (device === undefined || entry.deviceId !== device.deviceId) {
				// 登録し直した後の古い登録の取り消しは捨てる（古い登録には PC がもうつながらない）。
				changed = true;
				continue;
			}
			if (!force && entry.nextAt > now) {
				next.push(entry);
				continue;
			}
			const response = await this.revokeOnRelay(device, entry.mobileId);
			const outcome = paradisClassifyRevokeResponse(response?.status, response?.body);
			changed = true;
			if (outcome === 'retry') {
				next.push(paradisRevokeRetried(entry, Date.now(), Math.random()));
			} else if (outcome === 'drop') {
				this.logService.warn('[paradisMobileRelay] relay refused a revoke permanently; dropping it');
			}
		}
		if (!changed) {
			return;
		}
		// 送っている間に積まれた分（別の端末の解除）は、そのまま残す。
		const processed = new Set(snapshot.map(key));
		const merged = [...next, ...this.revokeOutbox().filter(entry => !processed.has(key(entry)))];
		this.state.pendingRelayRevokes = merged.length > 0 ? merged : undefined;
		await this.save().catch(err => this.logService.warn('[paradisMobileRelay] failed to save the revoke outbox', err));
	}

	/** いちばん早い送り直しの時刻にタイマーを張る。 */
	private scheduleRevokeRetry(): void {
		if (this.revokeTimer !== undefined) {
			clearTimeout(this.revokeTimer);
			this.revokeTimer = undefined;
		}
		if (this._store.isDisposed) {
			return;
		}
		const outbox = this.revokeOutbox();
		if (outbox.length === 0 || this.isStoreBlocked()) {
			return;
		}
		const delay = Math.max(1_000, Math.min(...outbox.map(entry => entry.nextAt)) - Date.now());
		this.revokeTimer = setTimeout(() => {
			this.revokeTimer = undefined;
			void this.drainRevokeOutbox();
		}, delay);
	}

	/**
	 * リレーへ1回だけ取り消しを送り、HTTP の状態を返す（通信が失敗したら undefined）。404 のときだけ、
	 * リレー自身の応答かを見分けるために本文も読む。以前は応答を見ず、401 や 5xx でも成功とみなしていた（W2-35）。
	 */
	private async revokeOnRelay(device: { readonly deviceId: string; readonly pcToken: string }, mobileId: string): Promise<{ readonly status: number; readonly body?: string } | undefined> {
		try {
			const response = await fetch(`${this.relayHttpBase()}/device/${device.deviceId}/mobile/revoke`, {
				method: 'POST',
				headers: { authorization: `Bearer ${device.pcToken}`, 'content-type': 'application/json' },
				body: JSON.stringify({ mobileId }),
				signal: AbortSignal.timeout(15_000),
			});
			if (response.status === 404) {
				return { status: 404, body: (await response.text()).slice(0, 64) };
			}
			return { status: response.status };
		} catch (err) {
			this.logService.warn('[paradisMobileRelay] relay revoke failed', err);
			return undefined;
		}
	}

	async sendFrame(lease: IParadisMobileWindowLease, ch: ChannelId, ws: string | undefined, mobileId: string | undefined, payload: VSBuffer): Promise<void> {
		await this.withCurrentRegisteredLease(lease, async () => {
			const bytes = payload.buffer;
			if (ch === Channels.Notify && mobileId === undefined) {
				this.dispatchNotify(bytes, lease);
				return;
			}
			if (mobileId !== undefined) {
				const session = this.sessions.get(mobileId);
				if (session?.hasCurrentProtocol) {
					await session.sendFrame(ch, ws, bytes);
				}
				return;
			}
			for (const session of this.sessions.values()) {
				if (session.hasCurrentProtocol) {
					await session.sendFrame(ch, ws, bytes);
				}
			}
		});
	}

	async syncTerminalWindow(lease: IParadisMobileWindowLease, state: IParadisMobileWindowStateV2): Promise<void> {
		await this.withCurrentMainLease(lease, async validation => {
			const previous = this.terminalRegistry.leaseOfWindow(lease.windowId);
			this.terminalRegistry.syncWindow(lease.windowId, lease.windowSession, lease.rendererGeneration, state, validation, false);
			const current = this.terminalRegistry.leaseOfWindow(lease.windowId);
			if (this.sameLease(current, lease) && previous !== undefined && !this.sameLease(previous, lease)) {
				this.cleanupRemovedRenderer(previous);
			}
			const conflicts = this.terminalRegistry.conflictingTerminalKeys();
			if (conflicts.length > 0) {
				this.logService.error(`[paradisMobileRelay] duplicate terminalKey registration: ${conflicts.map(key => key.slice(0, 8)).join(',')}`);
			}
			await this.broadcastDesktopState();
		});
	}

	/** windowId → そのウィンドウの「ブラウザビュー → スペース」の台帳（browser.space.v1）。 */
	private readonly browserScopes = new Map<number, { readonly windowSession: string; readonly rendererGeneration: number; readonly snapshot: IParadisMobileBrowserScopeSnapshot }>();

	async syncBrowserScopes(lease: IParadisMobileWindowLease, snapshot: IParadisMobileBrowserScopeSnapshot): Promise<boolean> {
		const sanitized = paradisSanitizeMobileBrowserScopeSnapshot(snapshot);
		if (sanitized === undefined) {
			return false;
		}
		return await this.withCurrentRegisteredLease(lease, async () => {
			this.browserScopes.set(lease.windowId, { windowSession: lease.windowSession, rendererGeneration: lease.rendererGeneration, snapshot: sanitized });
			return true;
		}) ?? false;
	}

	/**
	 * そのウィンドウの、そのスペース（`sourceId` = stateKey）のページの targetId。台帳が無い・古いなら
	 * `undefined`（呼び出し側は全件を返す）。
	 */
	private async resolveBrowserSpaceTargetIds(windowId: number, ws: string): Promise<ReadonlySet<string> | undefined> {
		const entry = this.browserScopes.get(windowId);
		const cdpFrames = this.cdpFrames;
		if (entry === undefined || cdpFrames === undefined) {
			return undefined;
		}
		const current = this.terminalRegistry.leaseOfWindow(windowId);
		if (current === undefined || current.windowSession !== entry.windowSession || current.rendererGeneration !== entry.rendererGeneration) {
			return undefined;
		}
		const targetIds = await Promise.all(paradisMobileBrowserViewsInSpace(entry.snapshot, ws).map(viewId => cdpFrames.resolveTargetId(viewId).catch(() => null)));
		return new Set(targetIds.filter((targetId): targetId is string => typeof targetId === 'string'));
	}

	async removeTerminalWindow(lease: IParadisMobileWindowLease): Promise<void> {
		await this.enqueueRendererAuthority(async () => {
			const scopes = this.browserScopes.get(lease.windowId);
			if (scopes !== undefined && scopes.windowSession === lease.windowSession && scopes.rendererGeneration === lease.rendererGeneration) {
				this.browserScopes.delete(lease.windowId);
			}
			const removed = this.terminalRegistry.removeWindow(lease.windowId, lease.windowSession, lease.rendererGeneration);
			// terminal stateの初回同期よりpane同期が先に届いた場合も、同じsessionだけは掃除する。
			this.agentChat.removePanes(lease.windowId, lease.windowSession, lease.rendererGeneration);
			if (removed) {
				this.agentChat.removeOwnerActions(lease.windowId, lease.windowSession, lease.rendererGeneration);
				this.markTerminalOperationsUnknownForOwner(lease);
				await this.broadcastDesktopState();
			}
		});
	}

	private desktopStateBroadcastChain = Promise.resolve();

	/**
	 * main プロセスから push された最新の Renderer lease manifest。
	 *
	 * broadcast のたびに `manifest()` をRPCで取りに行くと、state再送を直列化している
	 * `enqueueRendererAuthority` の中に main プロセス往復が1回ずつ挟まる。エージェントを
	 * 大量に動かしているとこのチェーンが常時埋まり、モバイル復帰時のstate応答がその分だけ
	 * 後ろへ押し出される。`onDidChangeManifest` は manifest を変える全経路
	 * （trackWindow / destroyWindow / addConnection / removeConnection / claim）から
	 * fire されるので、こちらをキャッシュして使い、RPCは初回イベント到着前だけにする。
	 */
	private cachedManifest: IParadisMobileRendererManifest | undefined;

	/** 逆行するmanifest（RPC応答がイベントに追い越された場合）でキャッシュを巻き戻さない。 */
	private observeManifest(manifest: IParadisMobileRendererManifest): void {
		if (this.cachedManifest === undefined || manifest.revision >= this.cachedManifest.revision) {
			this.cachedManifest = manifest;
		}
	}

	/** 計測用: broadcast の回数と、そのうち実際に電波へ出した回数。 */
	private broadcastCount = 0;
	private broadcastSentCount = 0;

	private broadcastDesktopState(mobileId?: string, suppliedManifest?: IParadisMobileRendererManifest): Promise<void> {
		const run = this.desktopStateBroadcastChain.then(async () => {
			this.broadcastCount++;
			try {
				const manifest = suppliedManifest ?? this.cachedManifest ?? await this.windowLeaseClient.manifest();
				this.observeManifest(manifest);
				for (const removed of this.terminalRegistry.reconcile(manifest)) {
					this.cleanupRemovedRenderer(removed);
				}
			} catch (error) {
				this.logService.warn('[paradisMobileRelay] failed to read Renderer lease manifest', error);
				return;
			}
			const targetedSession = mobileId !== undefined ? this.sessions.get(mobileId) : undefined;
			let hasOnlineSession = false;
			if (mobileId === undefined) {
				for (const session of this.sessions.values()) {
					if (session.isOnline) {
						hasOnlineSession = true;
						break;
					}
				}
			}
			if (mobileId !== undefined ? !targetedSession?.isOnline : !hasOnlineSession) {
				return;
			}
			const state = this.terminalRegistry.desktopState();
			const bytes = new TextEncoder().encode(JSON.stringify(state));
			if (mobileId !== undefined) {
				if (targetedSession?.isOnline && await targetedSession.sendDesktopState(bytes, true)) {
					this.broadcastSentCount++;
				}
				return;
			}
			let sent = false;
			for (const session of this.sessions.values()) {
				if (session.isOnline && await session.sendDesktopState(bytes, false)) {
					sent = true;
				}
			}
			if (sent) {
				this.broadcastSentCount++;
			}
		});
		this.desktopStateBroadcastChain = run.catch(() => { });
		return run;
	}

	private cleanupRemovedRenderer(lease: IParadisMobileWindowLease): void {
		this.agentCommandAuthority.retain(this.agentCommandOwner(lease), new Set());
		this.agentChat.removePanes(lease.windowId, lease.windowSession, lease.rendererGeneration);
		this.agentChat.removeOwnerActions(lease.windowId, lease.windowSession, lease.rendererGeneration);
		this.markTerminalOperationsUnknownForOwner(lease);
		const focus = this.windowFocus.get(lease.windowId);
		if (focus?.windowSession === lease.windowSession && focus.rendererGeneration === lease.rendererGeneration) {
			this.windowFocus.delete(lease.windowId);
		}
		for (const [mobileId, active] of this.webrtcRendererLeases) {
			if (this.sameLease(active.owner, lease)) {
				this.webrtcRendererLeases.delete(mobileId);
			}
		}
	}

	private sameLease(a: IParadisMobileWindowLease | undefined, b: IParadisMobileWindowLease): boolean {
		return a?.windowId === b.windowId && a.windowSession === b.windowSession && a.rendererGeneration === b.rendererGeneration;
	}

	private agentCommandOwner(lease: IParadisMobileWindowLease): string {
		return `${lease.windowId}:${lease.windowSession}:${lease.rendererGeneration}`;
	}

	private enqueueRendererAuthority<T>(task: () => Promise<T>): Promise<T> {
		const run = this.rendererAuthorityChain.then(task);
		this.rendererAuthorityChain = run.then(() => undefined, () => undefined);
		return run;
	}

	private withCurrentMainLease<T>(lease: IParadisMobileWindowLease, task: (validation: Awaited<ReturnType<ParadisMobileWindowLeaseClient['validate']>>) => Promise<T>): Promise<T | undefined> {
		return this.enqueueRendererAuthority(async () => {
			const validation = await this.windowLeaseClient.validate(lease);
			return validation.valid ? task(validation) : undefined;
		});
	}

	private withCurrentRegisteredLease<T>(lease: IParadisMobileWindowLease, task: () => Promise<T>): Promise<T | undefined> {
		return this.enqueueRendererAuthority(async () => {
			if (!this.sameLease(this.terminalRegistry.leaseOfWindow(lease.windowId), lease)) {
				return undefined;
			}
			const validation = await this.windowLeaseClient.validate(lease);
			if (!validation.valid || !this.sameLease(this.terminalRegistry.leaseOfWindow(lease.windowId), lease)) {
				return undefined;
			}
			return task();
		});
	}

	private async handleTerminalFrame(frame: IParadisMobileInboundFrame): Promise<void> {
		let message: { protocolVersion?: unknown; desktopEpoch?: unknown; operationId?: unknown; operationRun?: unknown; operationSeq?: unknown; t?: unknown; terminalKey?: unknown; windowId?: unknown; ws?: unknown };
		try {
			message = JSON.parse(new TextDecoder().decode(frame.payload.buffer)) as typeof message;
		} catch {
			return;
		}
		const mobileId = frame.mobileId;
		if (mobileId === undefined || typeof message.operationId !== 'string' || message.operationId.length === 0 || message.operationId.length > 200
			|| typeof message.operationRun !== 'number' || !Number.isSafeInteger(message.operationRun) || message.operationRun < 1
			|| typeof message.operationSeq !== 'number' || !Number.isSafeInteger(message.operationSeq) || message.operationSeq < 0) {
			return;
		}
		const operationId = message.operationId;
		const existing = this.terminalOperations.lookup(mobileId, operationId);
		if (existing !== undefined) {
			if (existing.kind === 'final') {
				this.sendTerminalOperationResult(mobileId, operationId, existing.status);
			} else if (existing.kind === 'unknown') {
				this.sendTerminalOperationResult(mobileId, operationId, 'outcome-unknown');
			}
			return;
		}

		if (!paradisIsAcceptedMobileWireVersion(message.protocolVersion) || message.desktopEpoch !== this.terminalRegistry.desktopEpoch) {
			this.finishTerminalOperation(mobileId, operationId, 'stale-epoch');
			return;
		}
		if (typeof message.t !== 'string' || !['attach', 'detach', 'ack', 'input', 'viewport', 'scroll', 'create', 'rename', 'close', 'ackStatus'].includes(message.t)) {
			this.finishTerminalOperation(mobileId, operationId, 'terminal-not-found');
			return;
		}

		let owner: IParadisMobileWindowLeaseRef | undefined;
		if (message.t === 'create') {
			const requestedWindowId = typeof message.windowId === 'number' && Number.isInteger(message.windowId) ? message.windowId : undefined;
			owner = requestedWindowId !== undefined && typeof message.ws === 'string' && message.ws.length > 0
				? this.terminalRegistry.ownerOfWorkspace(requestedWindowId, message.ws)
				: undefined;
		} else if (typeof message.terminalKey === 'string' && message.terminalKey.length > 0 && message.terminalKey.length <= 200) {
			owner = this.terminalRegistry.ownerOf(message.terminalKey);
		}
		if (owner === undefined) {
			// ownerを確定できない要求はledgerの順序を進めない。Renderer復旧中の
			// workspaceを誤って送っても、別Rendererの保留操作へ影響させない。
			this.sendTerminalOperationResult(mobileId, operationId, 'terminal-not-found');
			return;
		}
		const begin = this.terminalOperations.begin(mobileId, operationId, message.operationRun, message.operationSeq, owner);
		if (begin.kind !== 'started') {
			if (begin.kind === 'final') {
				this.sendTerminalOperationResult(mobileId, operationId, begin.status);
			} else if (begin.kind === 'unknown') {
				this.sendTerminalOperationResult(mobileId, operationId, 'outcome-unknown');
			}
			return;
		}
		let delivered: boolean | undefined;
		try {
			delivered = await this.withCurrentRegisteredLease(owner, async () => {
				if (!this.terminalOperations.bindOwner(mobileId, operationId, owner)) {
					this.finishTerminalOperation(mobileId, operationId, 'outcome-unknown');
					return false;
				}
				const timerKey = this.terminalOperationKey(mobileId, operationId);
				this.terminalOperationTimers.set(timerKey, setTimeout(() => {
					this.terminalOperationTimers.delete(timerKey);
					if (this.terminalOperations.markOutcomeUnknown(mobileId, operationId, owner)) {
						this.sendTerminalOperationResult(mobileId, operationId, 'outcome-unknown');
					}
				}, 10_000));
				this._onInboundFrame.fire([Channels.Terminal, paradisMobileWindowRoute(owner.windowId, owner.windowSession, owner.rendererGeneration), frame.seq, frame.payload, mobileId]);
				return true;
			});
		} catch (error) {
			this.logService.warn('[paradisMobileRelay] Renderer lease validation failed during terminal delivery', error);
			const timer = this.terminalOperationTimers.get(this.terminalOperationKey(mobileId, operationId));
			if (timer !== undefined) {
				clearTimeout(timer);
				this.terminalOperationTimers.delete(this.terminalOperationKey(mobileId, operationId));
			}
			this.finishTerminalOperation(mobileId, operationId, 'outcome-unknown');
			return;
		}
		if (delivered === undefined) {
			this.finishTerminalOperation(mobileId, operationId, 'stale-renderer');
		}
	}

	private async handleWindowFrame(frame: IParadisMobileInboundFrame): Promise<void> {
		const warmLease = frame.ch === Channels.Fs
			? decodeParadisMobileWarmLeaseRequest(frame.payload.buffer)
			: { kind: 'not-warm' } as const;
		if (warmLease.kind !== 'not-warm') {
			if (warmLease.kind === 'invalid' || frame.mobileId === undefined
				|| warmLease.request.desktopEpoch !== this.terminalRegistry.desktopEpoch) {
				return;
			}
			const owner = this.terminalRegistry.leaseOfWindow(warmLease.request.windowId);
			if (owner === undefined || owner.rendererGeneration !== warmLease.request.rendererGeneration) {
				return;
			}
			await this.withCurrentRegisteredLease(owner, async () => {
				this._onInboundFrame.fire([frame.ch, paradisMobileWindowRoute(owner.windowId, owner.windowSession, owner.rendererGeneration), frame.seq, frame.payload, frame.mobileId]);
			});
			return;
		}
		let message: { id?: unknown; protocolVersion?: unknown; desktopEpoch?: unknown; windowId?: unknown; ws?: unknown; rendererGeneration?: unknown; t?: unknown };
		const binaryUpload = frame.ch === Channels.Fs ? paradisDecodeBinaryFsUpload(frame.payload.buffer) : undefined;
		if (binaryUpload !== undefined) {
			message = binaryUpload;
		} else {
			try {
				message = JSON.parse(new TextDecoder().decode(frame.payload.buffer)) as typeof message;
			} catch {
				return;
			}
		}
		if (typeof message.id !== 'string' || message.id.length === 0 || message.id.length > 200) {
			return;
		}
		if (!paradisIsAcceptedMobileWireVersion(message.protocolVersion) || message.desktopEpoch !== this.terminalRegistry.desktopEpoch
			|| typeof message.windowId !== 'number' || !Number.isInteger(message.windowId)) {
			this.sendWindowFrameError(frame, message.id, 'PC画面の状態が更新されました。もう一度お試しください');
			return;
		}
		const hasWorkspace = typeof message.ws === 'string' && message.ws.length > 0;
		// ワークスペースに紐付かないリクエスト（「接続先セグメント」の usage/rtk/limits/github 等）は
		// ws を持たず、代わりに rendererGeneration で対象ウィンドウを直接指定する。`t` を
		// PARADIS_WORKSPACE_LESS_REQUEST_TYPES で絞るのは、この経路が本来 ws による所有権検証を
		// 必要とする操作（upload・worktree作成等）へ誤って使われないようにするため
		// （provider側は t で分岐するだけで ws の有無自体はここまで来ると検証しないため、
		// 許可リストが無いと「ws を送らなければ検証を素通りできる」形になってしまう）。
		// 登録表（paradisMobileRequestHandlers.ts）で受ける新しい種類も ws 無しで通す。そちらは ws が無ければ
		// スペースを持たない（root が undefined）ので、所有権の検証を素通りして既存の操作に届くことはない。
		const hasRendererGeneration = typeof message.rendererGeneration === 'number' && Number.isInteger(message.rendererGeneration)
			&& typeof message.t === 'string' && (PARADIS_WORKSPACE_LESS_REQUEST_TYPES.has(message.t)
				|| !PARADIS_MOBILE_BUILTIN_REQUEST_KINDS[frame.ch === Channels.Scm ? 'scm' : 'fs'].includes(message.t));
		if (!hasWorkspace && !hasRendererGeneration) {
			this.sendWindowFrameError(frame, message.id, 'PC画面の状態が更新されました。もう一度お試しください');
			return;
		}
		const owner = hasWorkspace
			? this.terminalRegistry.ownerOfWorkspace(message.windowId, message.ws as string)
			: this.terminalRegistry.readyOwnerOfWindow(message.windowId, message.rendererGeneration as number);
		if (owner === undefined) {
			this.sendWindowFrameError(frame, message.id, 'PC画面の再接続が完了してから操作してください');
			return;
		}
		try {
			const delivered = await this.withCurrentRegisteredLease(owner, async () => {
				this._onInboundFrame.fire([frame.ch, paradisMobileWindowRoute(owner.windowId, owner.windowSession, owner.rendererGeneration), frame.seq, frame.payload, frame.mobileId]);
				return true;
			});
			if (delivered !== true) {
				this.sendWindowFrameError(frame, message.id, 'PC画面が再接続されたため操作を中断しました');
			}
		} catch (error) {
			this.logService.warn('[paradisMobileRelay] Renderer lease validation failed during window delivery', error);
			this.sendWindowFrameError(frame, message.id, 'PC画面の状態を確認できませんでした');
		}
	}

	private sendWindowFrameError(frame: IParadisMobileInboundFrame, requestId: string, error: string): void {
		const mobileId = frame.mobileId;
		const session = mobileId !== undefined ? this.sessions.get(mobileId) : undefined;
		if (session?.hasCurrentProtocol) {
			const payload = new TextEncoder().encode(JSON.stringify({ id: requestId, error }));
			session.sendFrame(frame.ch, undefined, payload).catch(sendError => this.logService.warn('[paradisMobileRelay] window error reply failed', sendError));
		}
	}

	private finishTerminalOperation(mobileId: string, operationId: string, status: ParadisMobileTerminalOperationStatus): void {
		this.terminalOperations.finalize(mobileId, operationId, status);
		this.sendTerminalOperationResult(mobileId, operationId, status);
	}

	async completeTerminalOperation(lease: IParadisMobileWindowLease, mobileId: string, operationId: string, status: ParadisMobileTerminalOperationStatus): Promise<void> {
		if (!['accepted', 'terminal-not-found', 'failed', 'stale-renderer'].includes(status)) {
			return;
		}
		// current lease照合はしない。配送時にledgerへ固定したexact ownerだけが、交代後でも
		// timeout済み操作の遅延完了を確定できる。
		if (!this.terminalOperations.complete(mobileId, operationId, lease, status)) {
			return;
		}
		const timerKey = this.terminalOperationKey(mobileId, operationId);
		const timer = this.terminalOperationTimers.get(timerKey);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.terminalOperationTimers.delete(timerKey);
		}
		this.sendTerminalOperationResult(mobileId, operationId, status);
	}

	private terminalOperationKey(mobileId: string, operationId: string): string {
		return `${mobileId}\0${operationId}`;
	}

	private markTerminalOperationsUnknownForOwner(owner: IParadisMobileWindowLeaseRef): void {
		for (const operation of this.terminalOperations.markOwnerOutcomeUnknown(owner)) {
			const timerKey = this.terminalOperationKey(operation.mobileId, operation.operationId);
			const timer = this.terminalOperationTimers.get(timerKey);
			if (timer !== undefined) {
				clearTimeout(timer);
				this.terminalOperationTimers.delete(timerKey);
			}
			this.sendTerminalOperationResult(operation.mobileId, operation.operationId, 'outcome-unknown');
		}
	}

	private sendTerminalOperationResult(mobileId: string, operationId: string, status: ParadisMobileTerminalOperationStatus): void {
		const session = this.sessions.get(mobileId);
		if (session?.hasCurrentProtocol) {
			const payload = new TextEncoder().encode(JSON.stringify({ t: 'operation-result', operationId, status }));
			session.sendFrame(Channels.Terminal, undefined, payload).catch(err => this.logService.warn('[paradisMobileRelay] terminal operation result failed', err));
		}
	}

	// --- 接続 -----------------------------------------------------------------

	private connect(): void {
		if (this.socket || !this.state.device) {
			return;
		}
		const identity = this.identity;
		if (!identity) {
			return;
		}
		this.setConnectionState('connecting');
		// finding #7: pcTokenはURLクエリではなく Sec-WebSocket-Protocol サブプロトコル
		// (`para-auth.<token>`) で送る。クエリだとWorkers Logsに長期トークンが平文で残るため。
		// pcTokenはbase64urlなのでsubprotocol tokenとしてそのまま有効。
		const url = `${this.relayWsBase()}/device/${this.state.device.deviceId}/ws?role=pc`;
		let socket: WebSocket;
		try {
			socket = new WebSocket(url, [`para-auth.${this.state.device.pcToken}`]);
		} catch (err) {
			this.logService.error('[paradisMobileRelay] failed to open socket', err);
			reportParadisDiagnosticError('owned', 'desktop-relay', 'open-socket', err, {
				phase: 'connecting',
				reconnect_count: this.reconnectAttempt,
				transport: 'websocket',
			});
			this.scheduleReconnect();
			return;
		}
		socket.binaryType = 'arraybuffer';
		this.socket = socket;
		// ハンドシェイクの応答が返ってこない経路では onopen も onclose も来ない（undiciの既定は
		// headersTimeout 300秒）。this.socket が埋まったままだと connect() は早期returnするので、
		// 保活タイムアウトと同じくローカル側で見切りをつける。保活タイムアウト直後の再接続は
		// まさに同じ死んだ経路へ張りに行くため、ここが無いと復帰が5分遅れる。
		this.connectTimer = setTimeout(() => {
			this.connectTimer = undefined;
			if (this.socket !== socket) {
				return;
			}
			try { socket.close(4002, 'connect timeout'); } catch { /* すでに死んでいる */ }
			this.socket = undefined;
			this.handleDisconnected('connect-timeout', 'Desktop relay connection attempt timed out', {
				close_code: 4002,
				safe_close_reason: 'connect timeout',
				safe_socket_error: '',
			});
		}, RELAY_CONNECT_TIMEOUT_MS);

		socket.onopen = () => {
			if (this.socket !== socket) {
				return;
			}
			this.clearConnectTimer();
			// 失敗の回数は、この接続が一定時間続いてから 0 に戻す（繋がった直後に落ちる経路で
			// 最短間隔の張り直しを繰り返さないため。Orca の RELAY_STABLE_CONNECTION_MS と同じ）。
			this.armStableConnectionReset(socket);
			// 復帰したので、次に断が起きたら改めて結論を残す。捨てないと「機体あたり1件」で
			// 打ち止めになり、インシデントが何回起きたのかが数えられなくなる。
			this.lastAuthProbeOutcome = undefined;
			this.setUnauthorized(false);
			// 復帰できたので、直前の切断は報告しない（詳細は RELAY_DISCONNECT_REPORT_DELAY_MS 参照）。
			this.disconnectReporter.recovered();
			this.setConnectionState('online');
			this.startKeepalive(socket);
			// リレーへつながったら、取り消し待ちを待ちの時刻に関わらず送る（W2-35）。
			void this.drainRevokeOutbox(true);
		};
		// 張り替え直後は旧ソケットからもメッセージが届きうる。pongが現在の接続の死活状態を
		// 書き換えてしまわないよう、現行ソケット以外のメッセージは捨てる。
		socket.onmessage = event => {
			if (this.socket !== socket) {
				return;
			}
			void this.onSocketMessage(event.data);
		};
		// WebSocketの 'error' は close の直前に必ず来るうえ、ErrorEvent 自体は理由を持たない
		// （Sentryでは "[object ErrorEvent]" という中身のないissueになる）。切断1回につき
		// 2件report されるのも避けたいので、ここでは記録だけして onclose 側でまとめて送る。
		let socketErrorMessage = '';
		socket.onerror = event => {
			// Nodeには ErrorEvent のグローバルが無い(instanceof は ReferenceError)ので、message を直接見る。
			const message = (event as { message?: unknown }).message;
			socketErrorMessage = typeof message === 'string' && message ? message : 'error';
		};
		socket.onclose = event => {
			// disconnect() や新しい接続への張り替え、保活タイムアウトで破棄済みのソケットからも
			// onclose は届く。以降の後始末・再接続・reportはいずれも「現在の接続が落ちた」ときだけの
			// 処理なので、古いソケットのイベントはここで捨てる（意図した切断のreportで統計を汚さない
			// ためでもある）。
			if (this.socket !== socket) {
				return;
			}
			this.socket = undefined;
			this.clearConnectTimer();
			this.stopKeepalive();
			// 切断元の判別材料はcodeとreasonしかない（1006=経路側の異常切断、1000+'superseded'=
			// リレーが新しいPC接続で置き換え、1000+'revoked'=ペアリング解除、等）。operationにcodeを
			// 含めるのは、fingerprintがoperation単位で、混ぜるとレアなcodeが10分3件の制限に埋もれるため。
			this.handleDisconnected(`unexpected-close-${event.code}`, `Desktop relay connection closed (code ${event.code})`, {
				close_code: event.code,
				safe_close_reason: event.reason ? event.reason.slice(0, 64) : '',
				safe_socket_error: socketErrorMessage,
			});
		};
	}

	/**
	 * リレーへの接続を定期的なpingで保活する。
	 *
	 * 実測では切断がすべて close code 1006（closeフレーム無し）＋reason空で、リレー自身が閉じる
	 * 1000/'superseded' とは別物だった。つまり経路（NAT/エッジ）がアイドル接続を落としている。
	 * pingはリレー側のエッジが自動応答するのでDurable Objectは起きない（＝コストが増えない）。
	 * 送ったpingに次のtick（45秒）までpongが返らなければ経路が死んだとみなして自分から閉じ、
	 * 通常の再接続に載せる。切断からの検知は最悪90秒（切れた直後にpingを撃った場合）。
	 * 4001で閉じるのは、Sentry上で「こちらが死活検知で閉じた」ケースを1006と区別するため。
	 *
	 * ただし死活判定は「このリレーがpongを返すと分かっている」場合に限る。保活に未対応のリレーへ
	 * 繋いだ場合（PC側だけ先に更新された場合など）にpong無しを異常と見なすと、90秒ごとに自分から
	 * 切って再接続する状態に化けてしまう。pingの送信自体は経路の保活として無害なので続ける。
	 * 接続直後に1回pingを撃つのは、この判定材料（pongが返るか）を数百msで確定させるため。
	 */
	private startKeepalive(socket: WebSocket): void {
		this.stopKeepalive();
		this.sendKeepalivePing(socket);
		const timer = setInterval(() => {
			if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
				// 自分のタイマーだけを止める。this.keepaliveTimer は既に次の接続のものかもしれない。
				clearInterval(timer);
				return;
			}
			if (this.awaitingPong && this.keepaliveAcknowledged) {
				// 返事を待っている ping が、この間隔の半分より新しい＝スリープ復帰で撃ったもの。
				// その見切りは復帰のプローブ（5秒）に任せ、ここでは健全な接続を閉じない。
				if (Date.now() - this.lastPingSentAt < RELAY_KEEPALIVE_INTERVAL_MS / 2) {
					return;
				}
				this.onKeepaliveTimeout(socket);
				return;
			}
			this.sendKeepalivePing(socket);
		}, RELAY_KEEPALIVE_INTERVAL_MS);
		this.keepaliveTimer = timer;
	}

	private sendKeepalivePing(socket: WebSocket): void {
		this.awaitingPong = true;
		this.lastPingSentAt = Date.now();
		try {
			socket.send(PARADIS_RELAY_KEEPALIVE_PING);
		} catch {
			this.awaitingPong = false;
		}
	}

	/**
	 * 経路が死んだと判定したときの後始末。
	 *
	 * `close()` を呼ぶだけでは足りない。undiciのWebSocketはcloseフレームを書いてCLOSINGにするだけで
	 * ソケットを破棄せず、まさにこの状況（相手に何も届かない経路）ではcloseイベントがTCPの再送を
	 * 諦めるまで（数分〜十数分）発火しない。その間 `this.socket` が埋まったままだと `connect()` は
	 * 早期returnして再接続に入れないので、ローカル側は即座に切断済みとして扱う。
	 */
	private onKeepaliveTimeout(socket: WebSocket, countTowardGiveUp = true): void {
		this.stopKeepalive();
		try { socket.close(4001, 'keepalive timeout'); } catch { /* すでに死んでいる */ }
		// pongを返さないリレーへ張り替わった場合（Workerのロールバックや段階デプロイ）、
		// 「pongを返すリレーだ」という学習が残ったままだと45秒ごとの自己切断ループになる。
		// 連続でタイムアウトしたら学習を取り消し、ping送出だけの経路保活へ戻す。
		// スリープ復帰の5秒のプローブは経路が死んでいて当然の場面なので数えない。
		if (countTowardGiveUp) {
			this.consecutiveKeepaliveTimeouts++;
		}
		if (this.consecutiveKeepaliveTimeouts >= RELAY_KEEPALIVE_TIMEOUT_GIVE_UP) {
			this.keepaliveAcknowledged = false;
			this.consecutiveKeepaliveTimeouts = 0;
		}
		if (this.socket !== socket) {
			return;
		}
		this.socket = undefined;
		// close codeは往復しない（相手からcloseフレームが返らない場合、undiciは1006で上書きする）ので、
		// 「こちらが死活検知で切った」ことはoperation名で区別する。
		this.handleDisconnected('keepalive-timeout', 'Desktop relay keepalive timed out', {
			close_code: 4001,
			safe_close_reason: 'keepalive timeout',
			safe_socket_error: '',
		});
	}

	private stopKeepalive(): void {
		if (this.keepaliveTimer) {
			clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = undefined;
		}
		this.clearResumeProbe();
		this.awaitingPong = false;
	}

	/** 接続が {@link PARADIS_RELAY_STABLE_CONNECTION_MS} 続いたら、失敗の回数を 0 に戻す。 */
	private armStableConnectionReset(socket: WebSocket): void {
		this.clearStableConnectionReset();
		const timer = setTimeout(() => {
			if (this.stableConnectionTimer === timer) {
				this.stableConnectionTimer = undefined;
			}
			if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
				this.reconnectAttempt = 0;
			}
		}, PARADIS_RELAY_STABLE_CONNECTION_MS);
		this.stableConnectionTimer = timer;
	}

	private clearStableConnectionReset(): void {
		if (this.stableConnectionTimer) {
			clearTimeout(this.stableConnectionTimer);
			this.stableConnectionTimer = undefined;
		}
	}

	private clearResumeProbe(): void {
		if (this.resumeProbeTimer) {
			clearTimeout(this.resumeProbeTimer);
			this.resumeProbeTimer = undefined;
		}
	}

	/**
	 * OS のスリープ復帰。リレーへの接続を今すぐ確かめ、死んでいれば張り直す。
	 *
	 * スリープ中は経路（NAT・リレーのエッジ）が接続を忘れていることが多いのに、保活の ping は 45 秒
	 * ごとなので、切断に気づくまで最悪 90 秒かかり、その間スマホには「PC オフライン」が出て通知も
	 * 届かなかった。pong を返すリレーなら今すぐ ping を撃って数秒で見切り、確かめようのない接続
	 * （保活未対応のリレー・ハンドシェイク中）はスリープを跨いだものを信用せず張り直す。
	 * 眠っていた間の失敗は数えず、最短の間隔から始める。
	 */
	async handleSystemResume(): Promise<void> {
		if (!this.enabled || !this.state.device || this.isStoreBlocked()) {
			return;
		}
		this.reconnectAttempt = 0;
		const socket = this.socket;
		if (!socket) {
			if (this.reconnectTimer) {
				clearTimeout(this.reconnectTimer);
				this.reconnectTimer = undefined;
			}
			this.connect();
			return;
		}
		if (socket.readyState === WebSocket.OPEN && this.keepaliveAcknowledged) {
			this.clearResumeProbe();
			this.sendKeepalivePing(socket);
			const timer = setTimeout(() => {
				if (this.resumeProbeTimer === timer) {
					this.resumeProbeTimer = undefined;
				}
				if (this.socket === socket && this.awaitingPong) {
					this.onKeepaliveTimeout(socket, false);
				}
			}, RELAY_RESUME_PROBE_TIMEOUT_MS);
			this.resumeProbeTimer = timer;
			return;
		}
		try { socket.close(4003, 'system resume'); } catch { /* すでに死んでいる */ }
		this.socket = undefined;
		this.clearConnectTimer();
		this.stopKeepalive();
		this.handleDisconnected('system-resume', 'Desktop relay connection was replaced after the system resumed', {
			close_code: 4003,
			safe_close_reason: 'system resume',
			safe_socket_error: '',
		});
	}

	private clearConnectTimer(): void {
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = undefined;
		}
	}

	/**
	 * リレーとの接続が失われたあとの共通処理。onclose と保活タイムアウトの両方から呼ぶ。
	 * 呼び出し側が `this.socket` を先にクリアしていること。
	 */
	private handleDisconnected(operation: string, message: string, extras: Record<string, unknown>): void {
		// PC自身のリレーWSが切れた場合も、presence offline経路と同じ3点セットで
		// per-mobileリソース（browserMirrorのcaptureTimer/上流CDPソケット、agentChatの購読）を解放する。
		const mobileSessionCount = this.sessions.size;
		this.clearStableConnectionReset();
		for (const [id, session] of this.sessions) {
			this.browserMirror.stopSession(id);
			this.agentChat.dropSubscriber(id);
			session.close();
		}
		this.sessions.clear();
		this.webrtcRendererLeases.clear();
		this.voiceSubscriptions.clear();
		this.voiceDelivery.clear();
		if (!this.enabled) {
			this.setConnectionState('disabled');
			return;
		}
		this.disconnectReporter.arm(operation, message, {
			phase: this.connectionState,
			reconnect_count: this.reconnectAttempt,
			transport: 'websocket',
			// close code だけでは「既定リレーか自前か」「保活が効いていたか」「そもそも
			// モバイルが繋がっていたか」が分からず、経路都合とリレー障害を切り分けられない。
			safe_relay_kind: this.relayUrlOverride === undefined ? 'default' : 'custom',
			safe_keepalive_acked: this.keepaliveAcknowledged,
			safe_consecutive_timeouts: this.consecutiveKeepaliveTimeouts,
			safe_mobile_sessions: mobileSessionCount,
			...extras,
		});
		this.setConnectionState('disconnected');
		// 再接続が続くなら、経路の問題なのか認証切れなのかを確かめる（close code だけでは区別
		// できない。1006 は経路断でも401拒否でも同じ形で届く）。
		if (this.reconnectAttempt >= RELAY_AUTH_PROBE_AFTER_ATTEMPTS) {
			void this.probeAuthorization();
		}
		this.scheduleReconnect();
	}

	/**
	 * 認証プローブの結果を残す。
	 *
	 * **例外ではなく span で送る。** `ok`（＝経路もトークンも生きていて WS だけが落ちている）は
	 * 知りたい結論のひとつであって障害ではないので、error として issue 化すると
	 * 「正常でした」がエラー件数に混ざる。span なら4つの結末を属性で並べて数えられるし、
	 * 例外側のレートリミッタ（fingerprint あたり10分3件）とも無関係になる。
	 *
	 * 結論が変わったときだけ送る。再接続は数分で何十回も回るので、毎回送ると
	 * 「その断続の原因は経路か認証か」という1つの答えが件数に埋もれる。
	 * 断が復帰したら {@link lastAuthProbeOutcome} は onopen で捨てるので、
	 * **次のインシデントでは改めて1件残る**（機体あたり1件で打ち止めにはならない）。
	 */
	private reportAuthProbe(outcome: 'ok' | 'unauthorized' | 'rejected' | 'unreachable', status: number | undefined, cause?: string): void {
		if (this.lastAuthProbeOutcome === outcome) {
			return;
		}
		this.lastAuthProbeOutcome = outcome;
		runInParadisSpan('desktop-relay', 'auth-probe', {
			safe_outcome: outcome,
			safe_reconnect_count: this.reconnectAttempt,
			safe_http_status: status ?? -1,
			safe_relay_kind: this.relayUrlOverride === undefined ? 'default' : 'custom',
			...(cause !== undefined ? { safe_cause: cause } : {}),
		}, () => { });
	}

	private disconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.stopKeepalive();
		this.clearConnectTimer();
		this.clearStableConnectionReset();
		// 意図した切断なので、予約済みの切断レポートは破棄する（機能を無効化しただけで
		// 「復帰できなかった」と報告してしまわないように）。
		this.disconnectReporter.setEnabled(false);
		// onclose と同様、セッション破棄前に per-mobile リソースを解放する。
		for (const [id, session] of this.sessions) {
			this.browserMirror.stopSession(id);
			this.agentChat.dropSubscriber(id);
			session.close();
		}
		this.sessions.clear();
		this.webrtcRendererLeases.clear();
		this.voiceSubscriptions.clear();
		this.voiceDelivery.clear();
		if (this.socket) {
			try { this.socket.close(); } catch { /* ignore */ }
			this.socket = undefined;
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || !this.enabled) {
			return;
		}
		// 認証切れが確定しているなら、30秒間隔で叩き続けても復帰しない（再ペアリング待ち）。
		// どちらも揺らぎを入れ、リレーの更新で全 PC が同時に切れても同じ時刻に押し寄せないようにする。
		this.reconnectAttempt++;
		const delay = this.unauthorized
			? paradisRelayJitteredDelayMs(RELAY_UNAUTHORIZED_RETRY_MS)
			: paradisRelayReconnectDelayMs(this.reconnectAttempt);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, delay);
	}

	private async onSocketMessage(data: string | ArrayBuffer): Promise<void> {
		if (typeof data === 'string') {
			await this.onControl(data);
			return;
		}
		const bytes = new Uint8Array(data);
		let mobileId: Uint8Array;
		let payload: Uint8Array;
		try {
			const unpacked = unpackPcData(bytes);
			mobileId = unpacked.mobileId;
			payload = unpacked.payload;
		} catch {
			return;
		}
		const idStr = mobileIdToString(mobileId);
		let session = this.sessions.get(idStr);
		if (!session) {
			const paired = this.state.mobiles.find(m => m.mobileId === idStr);
			if (!paired || !this.identity) {
				return; // 未知のモバイル。無視。
			}
			const trafficDiagnostics = this.trafficDiagnostics;
			session = new MobileSession(
				idStr,
				mobileId,
				fromBase64Url(paired.pubKey),
				this.identity,
				sealed => this.sendBinaryToMobile(mobileId, sealed),
				frame => {
					if (frame.ch === Channels.State) {
						const wasReady = session!.hasCurrentProtocol;
						session!.negotiateProtocol(frame.payload.buffer);
						if (session!.hasCurrentProtocol !== wasReady) {
							this._onDidChangeStatus.fire(this.snapshot());
							this.updateEagerTailing();
							if (session!.hasCurrentProtocol) {
								// 切れている間に発生した通知を一覧へ流し直す（バナーはプッシュ側が担っている）。
								this.flushMissedNotify(idStr, session!);
							}
						}
						this.enqueueRendererAuthority(() => this.broadcastDesktopState(idStr)).catch(err => this.logService.warn('[paradisMobileRelay] state reply failed', err));
						return;
					}
					if (!session!.hasCurrentProtocol) {
						this.enqueueRendererAuthority(() => this.broadcastDesktopState(idStr)).catch(err => this.logService.warn('[paradisMobileRelay] protocol guidance failed', err));
						return;
					}
					// browser / agent チャネルは shared process 内で直接処理する
					// （rendererはCDP・ワークスペース外ファイルに触れないため）。それ以外は renderer へ配送。
					if (frame.ch === Channels.Agent) {
						this.agentChat.handleInbound(idStr, frame.payload.buffer);
						return;
					}
					if (frame.ch === Channels.Terminal) {
						this.handleTerminalFrame(frame).catch(err => this.logService.warn('[paradisMobileRelay] terminal routing failed', err));
						return;
					}
					if (frame.ch === Channels.Scm || frame.ch === Channels.Fs) {
						this.handleWindowFrame(frame).catch(err => this.logService.warn('[paradisMobileRelay] window routing failed', err));
						return;
					}
					if (frame.ch === Channels.Notify) {
						// アプリが裏に回った・前面に戻った（W2-34）。確認を返したときだけ、アプリは接続を保つ。
						const visibility = decodeNotifyVisibility(frame.payload.buffer);
						if (visibility?.t === 'visibility') {
							this.handleNotifyVisibility(idStr, session!, visibility.state, visibility.id);
							return;
						}
						// M→PC方向のnotifyチャネル: 通知設定の同期 or 既読(dismiss)メッセージ。
						const control = decodeNotifyControl(frame.payload.buffer);
						if (control?.t === 'dismiss') {
							this.handleNotifyDismiss(idStr, control.id, paradisNotifyDismissOpened(frame.payload.buffer));
							return;
						}
						this.handleNotifyPrefs(idStr, frame.payload.buffer);
						return;
					}
					if (frame.ch === Channels.Browser) {
						// 音声通知の購読制御（t: 'voice-*'）はここで完結する（音声はMP3のまま
						// このリレーが配るので renderer を経由しない）。
						const voiceControl = this.peekVoiceControl(frame.payload.buffer);
						if (voiceControl !== undefined) {
							this.handleVoiceControl(idStr, voiceControl);
							return;
						}
						// WebRTCシグナリング（t: 'webrtc-*'）は renderer のストリーマが処理する
						// （WebRTCスタックはrendererにしか無い）。offer は getDisplayMedia が
						// 対象ビュー単体を返すよう electron-main を先に arm してから転送する。
						const webrtc = this.peekWebrtcSignal(frame.payload.buffer);
						if (webrtc !== undefined) {
							this.forwardWebrtcSignal(idStr, frame, webrtc)
								.catch(err => this.logService.warn('[paradisMobileRelay] webrtc routing failed', err));
							return;
						}
						const respond = (payload: Uint8Array) => {
							const s = this.sessions.get(idStr);
							if (s?.hasCurrentProtocol) {
								s.sendFrame(Channels.Browser, undefined, payload).catch(err => this.logService.warn('[paradisMobileRelay] browser reply failed', err));
							}
						};
						this.browserMirror.handleRequest(idStr, frame.payload.buffer, respond).catch(err => this.logService.warn('[paradisMobileRelay] browser request failed', err));
						return;
					}
					this._onInboundFrame.fire([frame.ch, frame.ws, frame.seq, frame.payload, frame.mobileId]);
				},
				trafficDiagnostics === undefined ? undefined : sample => trafficDiagnostics.record(sample),
				this.logService,
				this.sendQueue,
			);
			this.sessions.set(idStr, session);
		}
		const wasOnline = session.isOnline;
		await session.enqueuePayload(payload);
		if (session.isOnline !== wasOnline) {
			this._onDidChangeStatus.fire(this.snapshot());
			// 繋がった直後にPC本体のリソースを1回測る。次の定期サンプリングを待つと、モバイル側は
			// 最大10秒のあいだ「未対応PC」と区別が付かない空欄を見ることになる。
			this.reportHostResourceSamplingFailure(this.sampleHostResources());
		}
	}

	/**
	 * browser チャネルのペイロードが WebRTC シグナリング（t: 'webrtc-*'）なら
	 * そのJSONを返す。違えば undefined（既存の browserMirror が処理する）。
	 */
	private peekWebrtcSignal(payload: Uint8Array): { t: 'webrtc-offer' | 'webrtc-ice' | 'webrtc-stop'; targetId?: unknown; windowId?: unknown; sid?: unknown; id?: unknown } | undefined {
		try {
			const msg = JSON.parse(new TextDecoder().decode(payload)) as { t?: unknown; targetId?: unknown; windowId?: unknown; sid?: unknown; id?: unknown };
			if (msg.t === 'webrtc-offer' || msg.t === 'webrtc-ice' || msg.t === 'webrtc-stop') {
				return { t: msg.t, targetId: msg.targetId, windowId: msg.windowId, sid: msg.sid, id: msg.id };
			}
		} catch { /* JSONでないペイロードは既存処理へ */ }
		return undefined;
	}

	/**
	 * browser チャネルのペイロードが音声通知の購読制御（t: 'voice-start' / 'voice-stop'）なら
	 * そのJSONを返す。音声はWebRTCではなくこのリレー自身がMP3のまま配るため、
	 * renderer を経由せず shared process 内で完結させる。
	 */
	private peekVoiceControl(payload: Uint8Array): { t: 'voice-start' | 'voice-stop'; sid: string; id?: string } | undefined {
		try {
			const msg = JSON.parse(new TextDecoder().decode(payload)) as { t?: unknown; sid?: unknown; id?: unknown };
			if ((msg.t === 'voice-start' || msg.t === 'voice-stop')
				&& typeof msg.sid === 'string' && msg.sid.length > 0 && msg.sid.length <= 200) {
				const id = typeof msg.id === 'string' && msg.id.length > 0 && msg.id.length <= 200 ? msg.id : undefined;
				return { t: msg.t, sid: msg.sid, ...(id !== undefined ? { id } : {}) };
			}
		} catch { /* JSONでないペイロードは既存処理へ */ }
		return undefined;
	}

	/** モバイルの「音声通知を開始/停止」を受け、以降のMP3配信対象を更新する。 */
	private handleVoiceControl(mobileId: string, control: { t: 'voice-start' | 'voice-stop'; sid: string; id?: string }): void {
		if (control.t === 'voice-start') {
			this.voiceSubscriptions.start(mobileId, control.sid, Date.now());
		} else {
			this.voiceSubscriptions.stop(mobileId, control.sid);
		}
		if (control.id === undefined) {
			return;
		}
		const session = this.sessions.get(mobileId);
		if (session?.hasCurrentProtocol) {
			const payload = new TextEncoder().encode(JSON.stringify({ id: control.id, ok: true }));
			session.sendFrame(Channels.Browser, undefined, payload)
				.catch(err => this.logService.warn('[paradisMobileRelay] voice control reply failed', err));
		}
	}

	/**
	 * Relay切断・presence更新・失効でモバイルセッションを捨てる際、音声の配信対象からも外す。
	 * 別モバイルがオンラインのままでも、失効した端末へ後続の音声を送り続けない。
	 */
	private dropVoiceSubscriber(mobileId: string): void {
		this.voiceSubscriptions.drop(mobileId);
	}

	private async forwardWebrtcSignal(
		mobileId: string,
		frame: IParadisMobileInboundFrame,
		signal: { t: 'webrtc-offer' | 'webrtc-ice' | 'webrtc-stop'; targetId?: unknown; sid?: unknown; id?: unknown },
	): Promise<void> {
		if (typeof signal.sid !== 'string' || signal.sid.length === 0 || signal.sid.length > 200) {
			return;
		}
		const sid = signal.sid;
		let owner: IParadisMobileWindowLeaseRef | undefined;
		if (signal.t === 'webrtc-offer') {
			if (typeof signal.id !== 'string' || signal.id.length === 0 || signal.id.length > 200
				|| typeof signal.targetId !== 'string' || signal.targetId.length === 0 || signal.targetId.length > 500) {
				return;
			}
			owner = await this.resolveWebrtcOwner(signal.targetId);
			if (owner === undefined) {
				return;
			}
			this.webrtcRendererLeases.set(mobileId, { sid, owner });
			if (this.cdpFrames) {
				try {
					await this.cdpFrames.armMirrorCapture(signal.targetId);
				} catch (err) {
					this.logService.warn('[paradisMobileRelay] webrtc arm failed', err);
				}
			}
			if (this.webrtcRendererLeases.get(mobileId)?.sid !== sid) {
				return;
			}
		} else {
			const active = this.webrtcRendererLeases.get(mobileId);
			owner = active?.sid === sid ? active.owner : undefined;
			if (owner === undefined || !this.sameLease(this.terminalRegistry.leaseOfWindow(owner.windowId), owner)) {
				this.webrtcRendererLeases.delete(mobileId);
				return;
			}
		}
		const delivered = await this.withCurrentRegisteredLease(owner, async () => {
			this._onInboundFrame.fire([frame.ch, paradisMobileWindowRoute(owner.windowId, owner.windowSession, owner.rendererGeneration), frame.seq, frame.payload, frame.mobileId]);
			return true;
		});
		if (delivered !== true) {
			this.webrtcRendererLeases.delete(mobileId);
			return;
		}
		if (signal.t === 'webrtc-stop') {
			this.webrtcRendererLeases.delete(mobileId);
		}
	}

	private async resolveWebrtcOwner(targetId: string): Promise<IParadisMobileWindowLeaseRef | undefined> {
		if (this.cdpFrames !== undefined) {
			try {
				const windowId = await this.cdpFrames.resolveTargetWindowId(targetId);
				if (windowId !== null) {
					return this.terminalRegistry.leaseOfWindow(windowId);
				}
			} catch (err) {
				this.logService.warn('[paradisMobileRelay] failed to resolve WebRTC target window', err);
			}
		}
		if (this.sharedPageBindings !== undefined) {
			try {
				const binding = (await this.sharedPageBindings.listBoundCdpTargets()).find(candidate => candidate.targetId === targetId);
				if (binding !== undefined) {
					const owner = this.agentChat.ownerOfPaneToken(binding.token);
					return owner !== undefined && this.sameLease(this.terminalRegistry.leaseOfWindow(owner.windowId), owner)
						? owner
						: undefined;
				}
			} catch (err) {
				this.logService.warn('[paradisMobileRelay] failed to resolve WebRTC target owner', err);
			}
		}
		return undefined;
	}

	/**
	 * モバイル宛のバイナリをリレーへ流す。**送れたかどうかを返す。**
	 *
	 * リレーへのソケットが無い/開いていないときは黙って捨てる（従来どおり。切断中の送信は
	 * 再接続後に意味を失うので握り潰してよい）。ただし「送った」ことを前提に状態を進める
	 * 呼び出し側があるので、捨てたことは伝える。
	 */
	private sendBinaryToMobile(mobileId: Uint8Array, sealed: Uint8Array): boolean {
		if (this.socket && this.socket.readyState === 1) {
			const framed = packPcData(mobileId, sealed);
			// WebSocket.send の型は ArrayBuffer を要求する。packPcData は offset 0・全長一致の
			// 専有バッファを直接構築して返すため、コピーせずそのまま渡せる。
			this.socket.send(framed.buffer as ArrayBuffer);
			return true;
		}
		return false;
	}

	private async onControl(text: string): Promise<void> {
		let msg;
		try {
			msg = decodeRelayControl(text);
		} catch {
			return;
		}
		if (msg.type === 'pairing-msg' && typeof msg.data === 'string') {
			await this.onPairingMessage(msg.data, msg.pairId);
		} else if (msg.type === 'paired' && typeof msg.mobileId === 'string' && msg.mobileId.length > 0) {
			await this.onPaired(msg.mobileId);
		} else if (msg.type === 'presence' && msg.peer === 'mobile' && typeof msg.mobileId === 'string') {
			// モバイルが切断/再接続したら、そのmobileIdの確立済みセッションを破棄する。
			// これをしないと、再接続時のモバイルの新しい hello を確立済みセッションが
			// アプリフレーム扱いして復号失敗し、恒久的に通信不能になる（H-3）。
			//
			// online:true でも破棄するのは、リレーが同一mobileIdの旧ソケットを閉じてから新ソケットを
			// 受理するとき、旧ソケットのclose由来のofflineが飛ばないため（残ソケット数が0のときだけ
			// 通知する仕様）。offlineを待っていると古いチャネルを保持したままモバイルへ封緘フレームを
			// 送り続け、ハンドシェイク中の相手がそれを応答と誤読して接続をやり直す。online:true は
			// リレーが新しいモバイルソケットを受理したときにしか出ないので、破棄して取り違えはない。
			// なお、この制御はリレーが新ソケットへ101を返す前にPCソケットへ書かれるため、同じ接続を
			// 流れてくるモバイルのhelloより必ず先に届く（＝確立直後のセッションを消す心配はない）。
			this.dropMobileSession(msg.mobileId);
		} else if (msg.type === 'mobile-revoked' && typeof msg.mobileId === 'string') {
			await this.onMobileRevoked(msg.mobileId);
		} else if (msg.type === 'pong') {
			this.awaitingPong = false;
			this.keepaliveAcknowledged = true;
			this.consecutiveKeepaliveTimeouts = 0;
		}
	}

	/** モバイル側からの自己ペアリング解除（リレー経由）。PC側の登録・セッションも掃除する。 */
	private async onMobileRevoked(mobileId: string): Promise<void> {
		// リレーが消したと知らせてきたので、同じスマホの取り消し待ちは要らない（W2-35）。
		const outbox = this.revokeOutbox();
		const remainingOutbox = outbox.filter(entry => entry.mobileId !== mobileId);
		const outboxChanged = remainingOutbox.length !== outbox.length;
		if (outboxChanged) {
			this.state.pendingRelayRevokes = remainingOutbox.length > 0 ? remainingOutbox : undefined;
		}
		if (!this.state.mobiles.some(m => m.mobileId === mobileId)) {
			if (outboxChanged) {
				await this.save();
			}
			return;
		}
		this.state.mobiles = this.state.mobiles.filter(m => m.mobileId !== mobileId);
		await this.save();
		this.sessions.get(mobileId)?.close();
		this.sessions.delete(mobileId);
		this.webrtcRendererLeases.delete(mobileId);
		this.dropVoiceSubscriber(mobileId);
		this.notifyKeyCache.delete(mobileId);
		this.missedNotify.forget(mobileId);
		this.browserMirror.stopSession(mobileId);
		this.agentChat.dropSubscriber(mobileId);
		this.updateEagerTailing();
		this._onDidChangeStatus.fire(this.snapshot());
	}

	private async onPairingMessage(dataB64: string, pairId: string | undefined): Promise<void> {
		if (!this.pairing || !this.identity) {
			return;
		}
		// C-2: 進行中のペアリング(pairId)以外からのメッセージは無視する。
		if (pairId !== undefined && pairId !== this.pairing.pairId) {
			return;
		}
		// C-2: 既にSASを表示した後は相手鍵を凍結し、別鍵での上書き（SASすり替え）を禁じる。
		if (this.pairing.sasShown) {
			return;
		}
		// pairing-msg の中身: モバイルの長期公開鍵(base64url JSON)。
		try {
			const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(dataB64))) as { pub?: string; name?: string };
			if (typeof payload.pub !== 'string') {
				return;
			}
			const mobilePubKey = fromBase64Url(payload.pub);
			if (mobilePubKey.length !== 32) {
				return;
			}
			this.pairing.mobilePubKey = mobilePubKey;
			if (typeof payload.name === 'string' && payload.name.length > 0) {
				this.pairing.proposedName = payload.name.slice(0, 64);
			}
			const sasCode = await deriveSasCode(this.identity, mobilePubKey, this.pairing.pairingToken);
			// C-2: SAS表示以降は相手鍵を凍結する（承認するのは「今SASを表示した鍵」ちょうど）。
			this.pairing.sasShown = true;
			this._onPairingEvent.fire({ kind: 'awaiting-approval', sasCode, proposedName: this.pairing.proposedName });
		} catch (err) {
			this.logService.warn('[paradisMobileRelay] bad pairing message', err);
		}
	}

	private async onPaired(mobileId: string): Promise<void> {
		if (!this.pairing || !this.pairing.mobilePubKey) {
			return;
		}
		const name = this.uniqueName(this.pairing.proposedName);
		this.state.mobiles.push({ mobileId, name, pubKey: toBase64Url(this.pairing.mobilePubKey) });
		await this.save();
		this.pairing = undefined;
		this._onPairingEvent.fire({ kind: 'paired', deviceName: name });
		this._onDidChangeStatus.fire(this.snapshot());
		this.updateEagerTailing();
	}

	private uniqueName(base: string): string {
		if (!this.state.mobiles.some(m => m.name === base)) {
			return base;
		}
		let i = 2;
		while (this.state.mobiles.some(m => m.name === `${base} ${i}`)) {
			i++;
		}
		return `${base} ${i}`;
	}

	private sendControl(msg: Parameters<typeof encodeRelayControl>[0]): void {
		if (this.socket && this.socket.readyState === 1) {
			this.socket.send(encodeRelayControl(msg));
		}
	}
}
