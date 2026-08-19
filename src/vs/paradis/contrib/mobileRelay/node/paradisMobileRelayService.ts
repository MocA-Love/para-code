/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

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
import { IParadisCdpFrameSubscription, IParadisSharedPageBindings, paradisCodexPaneEndpointFilePath, paradisCodexPaneSocketPath } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { ParadisCdpUpstream } from '../../agentBrowser/node/paradisCdpUpstream.js';
import { ParadisMobileAgentChat } from './paradisMobileAgentChat.js';
import { ParadisRemoteTranscriptMirrorStore } from './paradisRemoteTranscriptMirror.js';
import { ParadisAgentSessionStore } from './paradisAgentSessionStore.js';
import { ParadisMobileBrowserMirror } from './paradisMobileBrowserMirror.js';
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
import { PARADIS_PUSH_PAYLOAD_LIMIT_BYTES, ParadisMissedNotifyQueue, paradisNotifyPcFocusQuiet, paradisResolveNotifyDelivery } from '../common/paradisNotifyDelivery.js';
import { paradisAgentLabel, paradisNotifyTitle } from '../common/paradisNotifyPresentation.js';
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
import { ParadisVoiceSubscriptions } from '../common/paradisVoiceSubscriptions.js';
import { PARADIS_JSON_GZIP_RESPONSE_ENCODING, paradisEncodeNegotiatedGzipJsonResponse } from '../common/paradisMobileGzipJson.js';
import { paradisDeliverVoiceClip } from './paradisVoiceClipDelivery.js';

// Node（shared process）で使うファイルシステム / crypto。
import { promises as fs } from 'fs';

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
 * 切断してからSentryへ報告するまでの猶予。
 *
 * 実測ではこの接続の切断はほぼ全てが経路側の異常切断（close code 1006、closeフレーム無し）で、
 * Macのスリープ復帰やネットワーク切替、リレー（Cloudflare Durable Object）の退避で日に数回起きる。
 * 再接続は初回500msで、ユーザーから見ればモバイルが一瞬オフラインになるだけの正常系なので、
 * 1回ごとにerrorとして上げると本物の障害がそのノイズに埋もれる。逆に完全に黙らせると、
 * リレーが実際に死んでいるケース（トークン失効で毎回1006、Worker障害）に気づけない。
 * そこで「猶予内に復帰できたら報告しない、できなければ報告する」に振り分ける。
 *
 * 60秒はバックオフ（500ms×2^n、上限30秒）で7回試行できる長さ＝一過性の切断なら必ず復帰している。
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

interface PairedMobile {
	readonly mobileId: string;
	readonly name: string;
	/** モバイルの長期公開鍵（base64url）。データ接続時のハンドシェイク相手鍵。 */
	readonly pubKey: string;
	/**
	 * モバイルの通知設定（アプリの設定画面から notify チャネルで同期される）。
	 * どれも「バナーを出さない」だけで、通知一覧へは常に届ける（`paradisNotifyDelivery.ts`）。
	 *
	 * `pcFocusQuiet` が「PC操作中は鳴らさない」。旧キー `suppressWhenPcFocused` を使い回さないのは、
	 * 旧いPara Codeがそのキーを「配信そのものを止める」と解釈するため。ディスクに旧キーで true を
	 * 残すと、PCを旧版へ巻き戻したときにその解釈が復活し、PCフォーカス中の通知がAPNsも含めて
	 * 捨てられる。旧キーは**書かず**、旧アプリから受け取ったときの読み取りだけに使う。
	 */
	notifyPrefs?: { agentDone?: boolean; agentQuestion?: boolean; pcFocusQuiet?: boolean; suppressWhenPcFocused?: boolean };
}

interface PersistedState {
	// encSecret: safeStorageで暗号化したpkcs8秘密鍵。pkcs8: 平文(旧形式/暗号化不可環境のフォールバック)。
	identity?: { pubKey: string; encSecret?: string; pkcs8?: string };
	device?: { deviceId: string; pcToken: string };
	mobiles: PairedMobile[];
}

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
	) { }

	get isOnline(): boolean {
		return this.confirmed;
	}

	private _lastInboundAt = 0;

	/** 最後にこのモバイルから何か受け取ってからの経過ms。受信実績が無ければ `undefined`。 */
	msSinceLastInbound(now: number): number | undefined {
		return this._lastInboundAt === 0 ? undefined : now - this._lastInboundAt;
	}

	get hasCurrentProtocol(): boolean {
		return this.negotiatedProtocolVersion === PARADIS_MOBILE_PROTOCOL_VERSION;
	}

	/**
	 * このモバイルがDesktop Stateの圧縮を明示的に要求したか（旧アプリは何も送らない）。
	 * **既定は必ず非圧縮**。gzipを無条件に送ると、旧アプリの `JSON.parse` が例外になり、
	 * それが受信側の catch に握り潰されて「エラー表示のないままホームが空で固まる」に化ける。
	 */
	private negotiatedStateEncoding: string | undefined;

	negotiateProtocol(payload: Uint8Array): boolean {
		let received: unknown;
		try {
			const request = JSON.parse(new TextDecoder().decode(payload)) as { protocolVersion?: unknown; stateEncoding?: unknown };
			received = request.protocolVersion;
			this.negotiatedProtocolVersion = request.protocolVersion === PARADIS_MOBILE_PROTOCOL_VERSION
				? PARADIS_MOBILE_PROTOCOL_VERSION
				: undefined;
			this.negotiatedStateEncoding = request.stateEncoding === PARADIS_JSON_GZIP_RESPONSE_ENCODING
				? PARADIS_JSON_GZIP_RESPONSE_ENCODING
				: undefined;
		} catch {
			this.negotiatedProtocolVersion = undefined;
			this.negotiatedStateEncoding = undefined;
		}
		if (!this.hasCurrentProtocol) {
			// 版数不一致は「繋がっているのに何も表示されない」形で現れる（アプリだけ更新した等）。
			// 無言で undefined にすると、片側の nonce エラーしか手掛かりが残らない。
			reportParadisDiagnosticError('owned', 'mobile-e2e', 'protocol-mismatch', new Error('Mobile protocol version mismatch'), {
				phase: 'handshaking',
				transport: 'websocket',
				safe_expected: PARADIS_MOBILE_PROTOCOL_VERSION,
				safe_received: typeof received === 'number' ? received : -1,
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
				this.mux = new FrameMux(this.channel, {
					sendSealed: (sealed: Uint8Array) => this.sendToRelay(sealed),
					// FrameMux は onError を渡すと復号失敗を握り潰して throw しない。ここで捕まえて
					// 下の catch へ載せ直さないと、「復号できない32Bは新しい hello とみなして
					// セッションをリセットする」自己回復も計装も、確立後は一切効かない
					// （旧セッションに固着したモバイルが二度と接続できなくなる経路）。
					onError: (err: unknown) => { this.lastMuxError = err; },
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
		this.channel = undefined;
		this.mux = undefined;
		this.confirmed = false;
		this.negotiatedProtocolVersion = undefined;
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
		return this.stateDelivery.deliver(payload, force, async state => {
			const encoded = await paradisEncodeNegotiatedGzipJsonResponse(this.negotiatedStateEncoding, state) ?? state;
			await mux.send(Channels.State, encoded);
		});
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
}

export class ParadisMobileRelayService extends Disposable implements IParadisMobileRelayService {
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
	private enabled = false;
	private connectionState: ParadisMobileConnectionState = 'disabled';
	// Mobile relay が有効な間だけ動かし、shared process の不要な定期起床を避ける。
	private readonly stateBroadcastMetricsTimer: IParadisMobileRelayMetricsTimer;
	private stateBroadcastMetricsEnabled = false;
	private stateBroadcastMetricsGeneration = 0;

	private socket: WebSocket | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectAttempt = 0;
	private readonly disconnectReporter: ParadisRelayDisconnectReporter;
	private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
	private connectTimer: ReturnType<typeof setTimeout> | undefined;
	/** 連続でpongが返らなかった回数。リレー側の保活対応をいつ学習し直すかの判断に使う。 */
	private consecutiveKeepaliveTimeouts = 0;
	/** pcToken が失効していると確認できた状態。再ペアリングするまで復帰しない。 */
	private unauthorized = false;
	private authProbeInFlight = false;
	/** 直近のプローブ結果。同じ結論を送り続けてレートリミッタを食い潰さないための番人。 */
	private lastAuthProbeOutcome: 'ok' | 'unauthorized' | 'rejected' | 'unreachable' | undefined;
	/** 直前のpingにpongが返っていない。次のtickでも返っていなければ経路が死んだとみなす。 */
	private awaitingPong = false;
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
		_configurationService?: IConfigurationService,
		_args?: NativeParsedArgs,
		// 生成済みAivis音声（MP3）。同一 shared process の通知サービスが発火する。
		voiceClips?: Event<VSBuffer>,
		testSeams?: IParadisMobileRelayServiceTestSeams,
	) {
		super();
		this.stateBroadcastMetricsTimer = this._register(testSeams?.stateBroadcastMetricsTimer ?? new IntervalTimer());
		this.disconnectReporter = this._register(new ParadisRelayDisconnectReporter({
			reportDelayMs: RELAY_DISCONNECT_REPORT_DELAY_MS,
			reportAfterAttempts: RELAY_DISCONNECT_REPORT_AFTER_ATTEMPTS,
			getReconnectAttempt: () => this.reconnectAttempt,
			report: report => reportParadisDiagnosticError('owned', 'desktop-relay', report.operation, new Error(report.message), {
				...report.extras,
			}),
		}));
		if (voiceClips !== undefined) {
			this._register(voiceClips(clip => this.broadcastVoiceClip(clip)));
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
		this.browserMirror = this._register(new ParadisMobileBrowserMirror(cdpUpstream, cdpFrames, sharedPageBindings, this.logService));
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
			// WindowsはUnix socketの代わりに、ランチャーが書くws endpointファイルを接続targetにする。
			token => process.platform === 'win32'
				? paradisCodexPaneEndpointFilePath(this.userDataPath, token)
				: paradisCodexPaneSocketPath(this.userDataPath, token),
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

	private async load(): Promise<void> {
		try {
			const raw = await fs.readFile(this.statePath, 'utf8');
			const parsed = JSON.parse(raw) as PersistedState;
			this.state = { mobiles: parsed.mobiles ?? [], device: parsed.device, identity: parsed.identity };
		} catch {
			this.state = { mobiles: [] };
		}
		const stored = this.state.identity;
		if (stored) {
			const pkcs8B64 = await this.decryptSecret(stored);
			if (pkcs8B64 !== undefined) {
				this.identity = await importIdentity(fromBase64Url(pkcs8B64), fromBase64Url(stored.pubKey));
				// 旧形式(平文pkcs8)で読めた場合は暗号化形式へ移行して保存し直す。
				if (stored.pkcs8 !== undefined) {
					await this.persistIdentitySecret(this.identity, fromBase64Url(pkcs8B64));
					await this.save();
				}
			}
		}
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

	private async save(): Promise<void> {
		// 秘密鍵は persistIdentitySecret で safeStorage 暗号化済み。ファイルも 0600 で作成する。
		const json = JSON.stringify(this.state);
		await fs.writeFile(this.statePath, json, { encoding: 'utf8', mode: 0o600 });
	}

	private async ensureIdentity(): Promise<MobileIdentity> {
		if (this.identity) {
			return this.identity;
		}
		const { identity, pkcs8 } = await generatePersistableIdentity();
		this.identity = identity;
		await this.persistIdentitySecret(identity, pkcs8);
		await this.save();
		return identity;
	}

	// --- 公開API（IPC） -------------------------------------------------------

	async getStatus(): Promise<IParadisMobileStatus> {
		return this.snapshot();
	}

	async getConfirmedAgentPanes(): Promise<IParadisConfirmedAgentPanes> {
		return this.confirmedAgentPanes;
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
			onlineMobiles: [...this.sessions.values()].filter(s => s.hasCurrentProtocol).length,
			...(this.unauthorized ? { unauthorized: true } : {}),
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
			// ただし「到達すらできない」ことは経路側の証拠なので、それは残す。
			this.reportAuthProbe('unreachable', undefined);
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
		this.relayUrlOverride = relayUrl;
		// renderer が設定値を持ってくる前でも名前が空にならないよう、ホスト名を既定として入れておく
		// （まだ誰も繋がっていないので、ここではブロードキャストしない）。
		if (this.pcName === undefined) {
			this.pcName = paradisFormatPcName(undefined, hostname());
			this.terminalRegistry.setPcName(this.pcName);
		}
		await this.load();
		this.updateDiagnosticCorrelation();
		this.enabled = enabled;
		this.setStateBroadcastMetricsEnabled(enabled);
		this.disconnectReporter.setEnabled(enabled);
		if (enabled && this.state.device) {
			this.connect();
		} else {
			this.setConnectionState(enabled ? 'disconnected' : 'disabled');
		}
		this.updateEagerTailing();
	}

	async setEnabled(enabled: boolean): Promise<void> {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		this.setStateBroadcastMetricsEnabled(enabled);
		if (enabled) {
			if (this.state.device) {
				this.connect();
			} else {
				this.setConnectionState('disconnected');
			}
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
		// 通知はプレビュー用途なので本文を短く切る。長文のまま封緘するとAPNsの4KB制限
		// （リレー側の3800B上限チェック）を超え、アプリ未起動時のプッシュだけがサイレントに
		// 落ちる（全文はチャット画面が別経路で同期する）。700字 = 日本語でもUTF-8で約2.1KB、
		// JSON+GCMタグ+base64url(×1.33)を足しても3800Bに収まる。
		// allow-any-unicode-next-line
		const body = info.text.length > 700 ? `${info.text.slice(0, 700)}…` : info.text;
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
		// どのPCから来たかを、フレーム・プッシュ・取り置きの全部に同じ形で乗せる。
		// 通知を作る場所は shared process と renderer の2つあるが、出口はここだけなので刻むのもここ。
		const bytes = this.stampNotifyOrigin(inputBytes);
		// 配送判断と、既読時のキュー刈り取りに要る項目を1回のパースで取り出す
		// （形式不正なら種別が undefined になり、鳴らす側へ倒れる）。
		const meta = peekNotifyMeta(bytes);
		const now = Date.now();
		const pcFocused = this.pcFocused;
		// 台数分の再エンコードを避けるため理由ごとに1回だけ作る。
		const quietCache = new Map<ParadisNotifyQuiet, Uint8Array>();
		const quietBytes = (reason: ParadisNotifyQuiet) => {
			let cached = quietCache.get(reason);
			if (cached === undefined) {
				cached = this.quietNotifyBytes(bytes, reason);
				quietCache.set(reason, cached);
			}
			return cached;
		};
		for (const mobile of this.state.mobiles) {
			const session = this.sessions.get(mobile.mobileId);
			const delivery = paradisResolveNotifyDelivery({
				kind: meta.kind,
				prefs: mobile.notifyPrefs,
				pcFocused,
				sessionReady: session?.hasCurrentProtocol === true,
				msSinceLastInbound: session?.msSinceLastInbound(now),
			});
			// フレームは通知一覧のためのもの。鳴らす必要が無い通知も、あとからスマホで
			// 「PCの前にいた間に何があったか」を追えるように送る（以前は配信自体を止めていた）。
			if (delivery.frame && session !== undefined) {
				const frameBytes = delivery.quiet !== undefined ? quietBytes(delivery.quiet) : bytes;
				session.sendFrame(Channels.Notify, undefined, frameBytes).catch(err => this.logService.warn('[paradisMobileRelay] notify frame failed', err));
			}
			// 上のフレームが本当に届いたかは分からない（相手が凍っていてもソケットは生きたままに
			// 見える。これがそもそもの不具合の原因）。届いたかに関わらず取り置き、次に繋がったとき
			// 通知一覧へ流し直す。モバイルはIDで重複を弾くので、二重に並ぶことはない。
			// 流し直す分は必ず `muted`: そのときには鳴らす機会が過ぎている。`pushed` にすると、
			// プッシュを受け取れない端末が復帰時に大昔の通知で鳴ってしまう。
			this.missedNotify.add(mobile.mobileId, { id: meta.id, agentToken: meta.agentToken, bytes: quietBytes('muted') });
			if (!delivery.push) {
				continue;
			}
			this.notifyKeyFor(mobile.mobileId, mobile.pubKey).then(async key => {
				const encoded = await this.sealNotifyForPush(key, bytes);
				if (encoded === undefined) {
					return;
				}
				if (expectedOwner !== undefined) {
					await this.withCurrentRegisteredLease(expectedOwner, async () => {
						this.sendControl({ type: 'push-notify', mobileId: mobile.mobileId, payload: encoded });
					});
				} else {
					this.sendControl({ type: 'push-notify', mobileId: mobile.mobileId, payload: encoded });
				}
			}).catch(err => this.logService.warn('[paradisMobileRelay] push-notify seal failed', err));
		}
	}

	/**
	 * プッシュ用に通知を封緘する。リレーの上限に収まらなければ本文を削って詰め直す。
	 *
	 * リレーは大きすぎるペイロードを黙って捨てる（APNsの4KB制限のため）。捨てられると、
	 * フレーム側は既に「PCがプッシュを送ったから鳴らさないで」と伝えたあとなので、
	 * その通知だけバナーが**完全に消える**。以前はここで警告を出すだけで送っていた。
	 *
	 * 本文は発生元で700字に切ってあるが、そこへ送信元の名乗り・長いワークスペースキー・
	 * エージェントトークンが積み上がると上限に届きうる。鳴らないより短い方がましなので、
	 * 収まるまで本文を削る。削り切っても収まらない（本文以外で埋まっている）ときだけ諦める。
	 */
	private async sealNotifyForPush(key: Uint8Array, bytes: Uint8Array): Promise<string | undefined> {
		let payload = bytes;
		// 削るたびに縮むので2回もあれば収まる。それでも駄目なら本文以外で埋まっているので打ち切る。
		for (let attempt = 0; attempt < 4; attempt++) {
			const encoded = toBase64Url(await sealNotify(key, payload));
			if (encoded.length <= PARADIS_PUSH_PAYLOAD_LIMIT_BYTES) {
				if (attempt > 0) {
					this.logService.warn(`[paradisMobileRelay] push payload trimmed to fit ${PARADIS_PUSH_PAYLOAD_LIMIT_BYTES}B`);
				}
				return encoded;
			}
			// base64url は3バイトを4文字にするので、削るべき文字数の3/4が生バイトでの不足分。
			// 端数と封緘の増分を吸収するために少し多めに削る。
			const overflow = encoded.length - PARADIS_PUSH_PAYLOAD_LIMIT_BYTES;
			const trimmed = this.trimNotifyBody(payload, Math.ceil(overflow * 0.75) + 16);
			if (trimmed === undefined) {
				this.logService.warn(`[paradisMobileRelay] push payload too large (${encoded.length}B) and cannot be trimmed; dropping the push`);
				return undefined;
			}
			payload = trimmed;
		}
		this.logService.warn('[paradisMobileRelay] push payload stayed over the limit after trimming; dropping the push');
		return undefined;
	}

	/**
	 * 通知の本文を指定バイト数ぶん削った版を作る。これ以上削れない（本文が空、または
	 * JSONとして読めない）ときは undefined を返し、呼び出し側に打ち切らせる。
	 */
	private trimNotifyBody(bytes: Uint8Array, shortfall: number): Uint8Array | undefined {
		try {
			const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> | null;
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return undefined;
			}
			const body = parsed['body'];
			if (typeof body !== 'string' || body.length === 0) {
				return undefined;
			}
			const encoder = new TextEncoder();
			// 日本語は1文字3バイトになりうるので、文字数ではなくバイト数で測って削る。
			const originalBytes = encoder.encode(body).length;
			let next = body;
			while (next.length > 0 && originalBytes - encoder.encode(next).length < shortfall) {
				next = next.slice(0, -1);
			}
			// allow-any-unicode-next-line
			const replacement = next.length > 0 ? `${next}…` : '';
			return new TextEncoder().encode(JSON.stringify({ ...parsed, body: replacement }));
		} catch {
			return undefined;
		}
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

	/** モバイルから同期された通知設定（notifyチャネル M→PC）を保存する。 */
	private handleNotifyPrefs(mobileId: string, payload: Uint8Array): void {
		try {
			const msg = JSON.parse(new TextDecoder().decode(payload)) as { t?: string; agentDone?: boolean; agentQuestion?: boolean; suppressWhenPcFocused?: boolean; pcFocusQuiet?: boolean };
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
			};
			// モバイルはonline遷移のたびに再送してくるため、値が変わった時だけ書き込む
			// （バックグラウンド復帰ごとのディスク書き込みチャーンを避ける）。
			const prev = mobile.notifyPrefs;
			if (prev && prev.agentDone === next.agentDone && prev.agentQuestion === next.agentQuestion && paradisNotifyPcFocusQuiet(prev) === next.pcFocusQuiet) {
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
	private handleNotifyDismiss(fromMobileId: string, notifyId: string): void {
		// 取り置きからも外す。残すと、あとで繋がったときに処理済みの通知が未読として蘇る。
		this.missedNotify.drop({ id: notifyId });
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

	async revokeDevice(deviceName: string): Promise<void> {
		const removed = this.state.mobiles.filter(m => m.name === deviceName);
		this.state.mobiles = this.state.mobiles.filter(m => m.name !== deviceName);
		await this.save();
		this.updateEagerTailing();
		// M-1: リレー側の資格情報も失効させ、既存のモバイル接続を切断する。
		for (const m of removed) {
			this.sessions.delete(m.mobileId);
			this.webrtcRendererLeases.delete(m.mobileId);
			this.dropVoiceSubscriber(m.mobileId);
			this.missedNotify.forget(m.mobileId);
			this.browserMirror.stopSession(m.mobileId);
			this.agentChat.dropSubscriber(m.mobileId);
			this.notifyKeyCache.delete(m.mobileId);
			void this.revokeOnRelay(m.mobileId);
		}
		this._onDidChangeStatus.fire(this.snapshot());
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
	async notifyAgentCliCommand(lease: IParadisMobileWindowLease, paneToken: string, generation: number, commandLine: string, agent: 'claude' | 'codex', mode: 'new' | 'resume' | 'fork', cwd: string | undefined, commandCwd?: string, sessionId?: string): Promise<ParadisAgentCommandDeliveryResult> {
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

	async notifyAgentCliCommandFinished(lease: IParadisMobileWindowLease, paneToken: string, generation: number): Promise<ParadisAgentCommandDeliveryResult> {
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
				this.agentChat.onCliCommandFinished(paneToken);
			}
			return decision.result;
		}) ?? 'stale';
	}

	async setAgentLiveOptions(options: { readonly codexDaemonStreaming: boolean }): Promise<void> {
		this.agentChat.setCodexDaemonEnabled(options.codexDaemonStreaming === true);
	}

	/**
	 * モバイルのPC一覧に出す、このPCの表示名を設定する。renderer は設定値をそのまま渡し、
	 * 空のときのホスト名へのフォールバックはここで行う（renderer からは `os` を読めないため）。
	 * 変わったときだけ desktop state を送り直す（名前は滅多に変わらないので間引きは要らない）。
	 */
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

	private async revokeOnRelay(mobileId: string): Promise<void> {
		if (!this.state.device) {
			return;
		}
		try {
			await fetch(`${this.relayHttpBase()}/device/${this.state.device.deviceId}/mobile/revoke`, {
				method: 'POST',
				headers: { authorization: `Bearer ${this.state.device.pcToken}`, 'content-type': 'application/json' },
				body: JSON.stringify({ mobileId }),
			});
		} catch (err) {
			this.logService.warn('[paradisMobileRelay] relay revoke failed', err);
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

	async removeTerminalWindow(lease: IParadisMobileWindowLease): Promise<void> {
		await this.enqueueRendererAuthority(async () => {
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

		if (message.protocolVersion !== PARADIS_MOBILE_PROTOCOL_VERSION || message.desktopEpoch !== this.terminalRegistry.desktopEpoch) {
			this.finishTerminalOperation(mobileId, operationId, 'stale-epoch');
			return;
		}
		if (typeof message.t !== 'string' || !['attach', 'detach', 'ack', 'input', 'create', 'rename', 'close', 'ackStatus'].includes(message.t)) {
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
		let message: { id?: unknown; protocolVersion?: unknown; desktopEpoch?: unknown; windowId?: unknown; ws?: unknown };
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
		if (message.protocolVersion !== PARADIS_MOBILE_PROTOCOL_VERSION || message.desktopEpoch !== this.terminalRegistry.desktopEpoch
			|| typeof message.windowId !== 'number' || !Number.isInteger(message.windowId)
			|| typeof message.ws !== 'string' || message.ws.length === 0) {
			this.sendWindowFrameError(frame, message.id, 'PC画面の状態が更新されました。もう一度お試しください');
			return;
		}
		const owner = this.terminalRegistry.ownerOfWorkspace(message.windowId, message.ws);
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
			this.reconnectAttempt = 0;
			// 復帰したので、次に断が起きたら改めて結論を残す。捨てないと「機体あたり1件」で
			// 打ち止めになり、インシデントが何回起きたのかが数えられなくなる。
			this.lastAuthProbeOutcome = undefined;
			this.setUnauthorized(false);
			// 復帰できたので、直前の切断は報告しない（詳細は RELAY_DISCONNECT_REPORT_DELAY_MS 参照）。
			this.disconnectReporter.recovered();
			this.setConnectionState('online');
			this.startKeepalive(socket);
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
				this.onKeepaliveTimeout(socket);
				return;
			}
			this.sendKeepalivePing(socket);
		}, RELAY_KEEPALIVE_INTERVAL_MS);
		this.keepaliveTimer = timer;
	}

	private sendKeepalivePing(socket: WebSocket): void {
		this.awaitingPong = true;
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
	private onKeepaliveTimeout(socket: WebSocket): void {
		this.stopKeepalive();
		try { socket.close(4001, 'keepalive timeout'); } catch { /* すでに死んでいる */ }
		// pongを返さないリレーへ張り替わった場合（Workerのロールバックや段階デプロイ）、
		// 「pongを返すリレーだ」という学習が残ったままだと45秒ごとの自己切断ループになる。
		// 連続でタイムアウトしたら学習を取り消し、ping送出だけの経路保活へ戻す。
		this.consecutiveKeepaliveTimeouts++;
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
		this.awaitingPong = false;
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
		for (const id of this.sessions.keys()) {
			this.browserMirror.stopSession(id);
			this.agentChat.dropSubscriber(id);
		}
		this.sessions.clear();
		this.webrtcRendererLeases.clear();
		this.voiceSubscriptions.clear();
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
	private reportAuthProbe(outcome: 'ok' | 'unauthorized' | 'rejected' | 'unreachable', status: number | undefined): void {
		if (this.lastAuthProbeOutcome === outcome) {
			return;
		}
		this.lastAuthProbeOutcome = outcome;
		runInParadisSpan('desktop-relay', 'auth-probe', {
			safe_outcome: outcome,
			safe_reconnect_count: this.reconnectAttempt,
			safe_http_status: status ?? -1,
			safe_relay_kind: this.relayUrlOverride === undefined ? 'default' : 'custom',
		}, () => { });
	}

	private disconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.stopKeepalive();
		this.clearConnectTimer();
		// 意図した切断なので、予約済みの切断レポートは破棄する（機能を無効化しただけで
		// 「復帰できなかった」と報告してしまわないように）。
		this.disconnectReporter.setEnabled(false);
		// onclose と同様、セッション破棄前に per-mobile リソースを解放する。
		for (const id of this.sessions.keys()) {
			this.browserMirror.stopSession(id);
			this.agentChat.dropSubscriber(id);
		}
		this.sessions.clear();
		this.webrtcRendererLeases.clear();
		this.voiceSubscriptions.clear();
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
		const delay = this.unauthorized
			? RELAY_UNAUTHORIZED_RETRY_MS
			: Math.min(500 * 2 ** this.reconnectAttempt, 30_000);
		this.reconnectAttempt++;
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
						// M→PC方向のnotifyチャネル: 通知設定の同期 or 既読(dismiss)メッセージ。
						const control = decodeNotifyControl(frame.payload.buffer);
						if (control?.t === 'dismiss') {
							this.handleNotifyDismiss(idStr, control.id);
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

	/**
	 * 生成済みMP3を、音声通知を開始しているモバイルへそのまま配る。
	 * 履歴は持たず、その時点で受信中の端末だけに届ける（未接続中の音声は再送しない）。
	 *
	 * モバイルは受信中 VOICE_SUBSCRIPTION_REFRESH ごとに同じsidで宣言し直すので、
	 * 宣言が途切れた購読は期限切れとして落とす（停止のfire-and-forgetが届かなかった場合の保険）。
	 */
	private broadcastVoiceClip(clip: VSBuffer): void {
		void paradisDeliverVoiceClip(this.voiceSubscriptions, clip.buffer, Date.now(), {
			getSession: mobileId => this.sessions.get(mobileId),
			warn: (message, error) => {
				if (error === undefined) {
					this.logService.warn(message);
				} else {
					this.logService.warn(message, error);
				}
			},
		});
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
			// WebSocket.send の型は ArrayBuffer を要求するため、生成済みバッファをそのまま渡す
			// （packPcData は offset 0 の専有バッファを返す）。
			this.socket.send(framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer);
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
			this.sessions.delete(msg.mobileId);
			this.webrtcRendererLeases.delete(msg.mobileId);
			this.dropVoiceSubscriber(msg.mobileId);
			this.browserMirror.stopSession(msg.mobileId);
			this.agentChat.dropSubscriber(msg.mobileId);
			this._onDidChangeStatus.fire(this.snapshot());
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
		if (!this.state.mobiles.some(m => m.mobileId === mobileId)) {
			return;
		}
		this.state.mobiles = this.state.mobiles.filter(m => m.mobileId !== mobileId);
		await this.save();
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
