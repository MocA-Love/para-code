// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブラウザミラーの WebRTC 受信クライアント（設計: app/design/webrtc-mirror-design.md）。
// PC側 renderer のストリーマ（paradisMobileWebrtcStreamer.ts）と browser チャネルの
// E2E経由でシグナリングし、内蔵ブラウザ単体の映像トラックを recvonly で受信する。
//
// react-native-webrtc はネイティブモジュールのため、リンクされていないビルド
// （WebRTC対応前の dev client 等）では import 時に throw する。遅延 require + try/catch で
// 吸収し、その場合は isWebrtcAvailable() が false（呼び出し側はJPEGミラーのまま）。

import { useAppStore } from './appState.js';

interface WebrtcModule {
	RTCPeerConnection: new (config: object) => RtcPeerConnectionLike;
	RTCView: unknown;
}

/** react-native-webrtc の RTCPeerConnection のうち、この機能が使う面だけの型。 */
export interface RtcPeerConnectionLike {
	addTransceiver(kind: string, init: { direction: string }): void;
	createOffer(options?: object): Promise<{ sdp?: string; type: string }>;
	setLocalDescription(desc: object): Promise<void>;
	setRemoteDescription(desc: object): Promise<void>;
	addIceCandidate(candidate: object): Promise<void>;
	close(): void;
	connectionState: string;
	addEventListener(type: string, listener: (event: never) => void): void;
	onicecandidate?: ((event: { candidate?: { toJSON(): object } | null }) => void) | null;
	ontrack?: ((event: { streams: { toURL(): string }[] }) => void) | null;
	onconnectionstatechange?: (() => void) | null;
}

let webrtcModule: WebrtcModule | undefined | null = null; // null=未試行
function loadWebrtc(): WebrtcModule | undefined {
	if (webrtcModule === null) {
		try {
			webrtcModule = require('react-native-webrtc') as WebrtcModule;
		} catch {
			webrtcModule = undefined;
		}
	}
	return webrtcModule ?? undefined;
}

/** ネイティブモジュールがこのビルドに含まれているか。 */
export function isWebrtcAvailable(): boolean {
	return loadWebrtc() !== undefined;
}

/** RTCView コンポーネント（未リンクなら undefined）。 */
export function getRtcView(): unknown {
	return loadWebrtc()?.RTCView;
}

export interface WebrtcMirrorSession {
	/** RTCView の streamURL に渡す値。 */
	streamUrl: string;
	/** ピアを閉じ、PC側にも stop を送る。 */
	stop(): void;
	/** 切断検知（failed/closed）で1回呼ばれる。 */
	onClosed: (cb: () => void) => void;
}

const STUN_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const CONNECT_TIMEOUT_MS = 10_000;
/** disconnected からの自然復帰を待つ猶予。過ぎたら畳んでJPEGへ（failed/closedは即時）。 */
const DISCONNECT_GRACE_MS = 5_000;

export interface WebrtcMirrorTimers {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface WebrtcMirrorHost {
	fetchTurnIceServers(): Promise<object[]>;
	webrtcOffer(targetId: string, sdp: string, sid: string): Promise<{ sdp?: string }>;
	webrtcSendIce(candidate: object, sid: string): void;
	webrtcStop(sid: string): void;
	setWebrtcIceHandler(sid: string, handler: (candidate: object) => void): void;
	clearWebrtcIceHandler(sid: string): void;
}

export interface WebrtcMirrorStartDependencies {
	createPeer(config: object): RtcPeerConnectionLike;
	host: WebrtcMirrorHost;
	timers: WebrtcMirrorTimers;
	createSessionId(): string;
}

/**
 * 指定ターゲットの WebRTC ミラーを開始する。確立できなければ throw
 * （呼び出し側は既存のJPEGミラーへフォールバックする）。
 */
export async function startWebrtcMirror(targetId: string, signal?: AbortSignal): Promise<WebrtcMirrorSession> {
	const mod = loadWebrtc();
	if (!mod) {
		throw new Error('webrtc unavailable in this build');
	}
	return startWebrtcMirrorWithDependencies(targetId, {
		createPeer: config => new mod.RTCPeerConnection(config),
		host: useAppStore.getState(),
		timers: globalThis,
		createSessionId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
	}, signal);
}

/** ネイティブ境界を注入可能にした実装本体。fake clockで接続競合を再現するテストにも使う。 */
export async function startWebrtcMirrorWithDependencies(targetId: string, dependencies: WebrtcMirrorStartDependencies, signal?: AbortSignal): Promise<WebrtcMirrorSession> {
	const { host, timers } = dependencies;
	// セッション識別子。確立フェーズが長い（TURN取得＋offer応答のawait）ため、素早い切替では
	// 新旧セッションが過渡的に共存する。全シグナリングに付与し、PC側は stale な stop/ice を弾き、
	// store側は別セッション宛のICEを現行ハンドラへ流さない（ハンドラ解除も自分の分のみ）。
	const sid = dependencies.createSessionId();
	let pc: RtcPeerConnectionLike | undefined;
	let closed = false;
	let closedCb: (() => void) | undefined;
	let connectTimer: unknown;
	let disconnectGraceTimer: unknown;
	let iceHandlerRegistered = false;
	let signalingStarted = false;
	let cancelled = signal?.aborted ?? false;
	let settleStream: (outcome: { readonly kind: 'stream'; readonly stream: { toURL(): string } } | { readonly kind: 'error'; readonly error: Error }) => void = () => { };
	const cleanup = (notifyPc: boolean) => {
		if (closed) {
			return;
		}
		closed = true;
		if (connectTimer !== undefined) {
			timers.clearTimeout(connectTimer); // 確立途中の失敗でも10sタイマーを残さない（放置Promiseのreject防止）
			connectTimer = undefined;
		}
		if (disconnectGraceTimer !== undefined) {
			timers.clearTimeout(disconnectGraceTimer);
			disconnectGraceTimer = undefined;
		}
		if (iceHandlerRegistered) {
			host.clearWebrtcIceHandler(sid);
			iceHandlerRegistered = false;
		}
		try {
			pc?.close();
		} catch { /* ignore */ }
		if (notifyPc && signalingStarted) {
			host.webrtcStop(sid);
		}
		closedCb?.();
	};
	const cancelledError = () => new Error('webrtc mirror start cancelled');
	const ensureActive = () => {
		if (cancelled || signal?.aborted) {
			throw cancelledError();
		}
	};
	let rejectDeadline!: (error: Error) => void;
	const deadlinePromise = new Promise<never>((_resolve, reject) => {
		rejectDeadline = reject;
		connectTimer = timers.setTimeout(() => {
			const error = new Error('webrtc connect timeout');
			cancelled = true;
			settleStream({ kind: 'error', error });
			reject(error);
		}, CONNECT_TIMEOUT_MS);
	});
	const onAbort = () => {
		const error = cancelledError();
		cancelled = true;
		settleStream({ kind: 'error', error });
		rejectDeadline(error);
	};
	if (signal !== undefined) {
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
		}
	}

	const establish = async (): Promise<WebrtcMirrorSession> => {
		// TURN資格情報（対称NAT越え用）。リレー側が未設定なら空＝STUNのみ。
		const turnServers = await host.fetchTurnIceServers().catch(() => []);
		ensureActive();
		const peer = dependencies.createPeer({ iceServers: [...STUN_SERVERS, ...turnServers] });
		pc = peer;
		ensureActive();
		peer.addTransceiver('video', { direction: 'recvonly' });

		// PC→mobile の ICE を受ける（answer 前に届いた分も RTCPeerConnection がキューイングする
		// とは限らないため、remoteDescription 設定前は自前で溜める）
		let remoteSet = false;
		const pendingIce: object[] = [];
		host.setWebrtcIceHandler(sid, candidate => {
			if (remoteSet) {
				peer.addIceCandidate(candidate).catch(() => { /* 無効なcandidateは無視 */ });
			} else {
				pendingIce.push(candidate);
			}
		});
		iceHandlerRegistered = true;
		// mobile→PC の ICE
		peer.onicecandidate = e => {
			if (e.candidate) {
				host.webrtcSendIce(e.candidate.toJSON(), sid);
			}
		};

		// ストリーム受信を待つPromise（track イベント）
		const streamPromise = new Promise<{ readonly kind: 'stream'; readonly stream: { toURL(): string } } | { readonly kind: 'error'; readonly error: Error }>(resolve => {
			settleStream = resolve;
			peer.ontrack = e => {
				const stream = e.streams[0];
				if (stream) {
					resolve({ kind: 'stream', stream });
				}
			};
		});
		peer.onconnectionstatechange = () => {
			if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
				const error = new Error(`webrtc connection ${peer.connectionState}`);
				cleanup(false);
				settleStream({ kind: 'error', error });
			} else if (peer.connectionState === 'disconnected') {
				// disconnected は一時的で自然復帰しうる。即畳まず猶予を置き、復帰しなければJPEGへ
				disconnectGraceTimer ??= timers.setTimeout(() => {
					disconnectGraceTimer = undefined;
					if (peer.connectionState !== 'connected') {
						const error = new Error('webrtc connection disconnected');
						cleanup(false);
						settleStream({ kind: 'error', error });
					}
				}, DISCONNECT_GRACE_MS);
			} else if (peer.connectionState === 'connected' && disconnectGraceTimer !== undefined) {
				timers.clearTimeout(disconnectGraceTimer);
				disconnectGraceTimer = undefined;
			}
		};

		const offer = await peer.createOffer();
		ensureActive();
		await peer.setLocalDescription(offer);
		ensureActive();
		if (!offer.sdp) {
			throw new Error('empty offer sdp');
		}
		signalingStarted = true;
		const answer = await host.webrtcOffer(targetId, offer.sdp, sid);
		ensureActive();
		if (!answer.sdp) {
			throw new Error('empty answer sdp');
		}
		await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
		ensureActive();
		remoteSet = true;
		for (const c of pendingIce.splice(0)) {
			peer.addIceCandidate(c).catch(() => { /* ignore */ });
		}

		const streamOutcome = await streamPromise;
		if (streamOutcome.kind === 'error') {
			throw streamOutcome.error;
		}
		ensureActive();

		return {
			streamUrl: streamOutcome.stream.toURL(),
			stop: () => cleanup(true),
			onClosed: cb => {
				closedCb = cb;
				if (closed) {
					cb();
				}
			},
		};
	};

	try {
		return await Promise.race([establish(), deadlinePromise]);
	} catch (err) {
		cancelled = true;
		cleanup(true);
		throw err;
	} finally {
		if (connectTimer !== undefined) {
			timers.clearTimeout(connectTimer);
			connectTimer = undefined;
		}
		signal?.removeEventListener('abort', onAbort);
	}
}

/** BrowserPanelの表示世代を、transportのSID世代と同じ寿命で管理する。 */
export class WebrtcMirrorCoordinator {
	private generation = 0;
	private session: WebrtcMirrorSession | undefined;
	private pendingAbort: AbortController | undefined;
	private disposed = false;

	constructor(
		private readonly startSession: (targetId: string, signal?: AbortSignal) => Promise<WebrtcMirrorSession>,
		private readonly onSessionChanged: (session: WebrtcMirrorSession | undefined) => void,
		private readonly onStartError: (error: unknown) => void,
	) { }

	start(targetId: string): void {
		if (this.disposed) {
			return;
		}
		const generation = ++this.generation;
		this.pendingAbort?.abort();
		const abort = new AbortController();
		this.pendingAbort = abort;
		const previous = this.session;
		this.session = undefined;
		previous?.stop();
		if (previous !== undefined) {
			this.onSessionChanged(undefined);
		}
		void this.startSession(targetId, abort.signal).then(session => {
			if (this.pendingAbort === abort) {
				this.pendingAbort = undefined;
			}
			if (this.disposed || generation !== this.generation) {
				session.stop();
				return;
			}
			this.session = session;
			session.onClosed(() => {
				if (!this.disposed && generation === this.generation && this.session === session) {
					this.session = undefined;
					this.onSessionChanged(undefined);
				}
			});
			if (this.session === session) {
				this.onSessionChanged(session);
			}
		}, error => {
			if (this.pendingAbort === abort) {
				this.pendingAbort = undefined;
			}
			if (!this.disposed && generation === this.generation) {
				this.onSessionChanged(undefined);
				this.onStartError(error);
			}
		});
	}

	stop(): void {
		if (this.disposed) {
			return;
		}
		this.generation++;
		this.pendingAbort?.abort();
		this.pendingAbort = undefined;
		const session = this.session;
		this.session = undefined;
		session?.stop();
		this.onSessionChanged(undefined);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.generation++;
		this.disposed = true;
		this.pendingAbort?.abort();
		this.pendingAbort = undefined;
		const session = this.session;
		this.session = undefined;
		session?.stop();
		this.onSessionChanged(undefined);
	}
}
