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
interface RtcPeerConnectionLike {
	addTransceiver(kind: string, init: { direction: string }): void;
	createOffer(options?: object): Promise<{ sdp?: string; type: string }>;
	setLocalDescription(desc: object): Promise<void>;
	setRemoteDescription(desc: object): Promise<void>;
	addIceCandidate(candidate: object): Promise<void>;
	close(): void;
	connectionState: string;
	addEventListener(type: string, listener: (event: never) => void): void;
}

let webrtcModule: WebrtcModule | undefined | null = null; // null=未試行
function loadWebrtc(): WebrtcModule | undefined {
	if (webrtcModule === null) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
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

/**
 * 指定ターゲットの WebRTC ミラーを開始する。確立できなければ throw
 * （呼び出し側は既存のJPEGミラーへフォールバックする）。
 */
export async function startWebrtcMirror(targetId: string): Promise<WebrtcMirrorSession> {
	const mod = loadWebrtc();
	if (!mod) {
		throw new Error('webrtc unavailable in this build');
	}
	const store = useAppStore.getState();
	// TURN資格情報（対称NAT越え用）。リレー側が未設定なら空＝STUNのみ。
	const turnServers = await store.fetchTurnIceServers().catch(() => []);
	const pc = new mod.RTCPeerConnection({ iceServers: [...STUN_SERVERS, ...turnServers] });
	let closed = false;
	let closedCb: (() => void) | undefined;
	const cleanup = (notifyPc: boolean) => {
		if (closed) {
			return;
		}
		closed = true;
		store.setWebrtcIceHandler(undefined);
		try {
			pc.close();
		} catch { /* ignore */ }
		if (notifyPc) {
			store.webrtcStop();
		}
		closedCb?.();
	};

	try {
		pc.addTransceiver('video', { direction: 'recvonly' });

		// PC→mobile の ICE を受ける（answer 前に届いた分も RTCPeerConnection がキューイングする
		// とは限らないため、remoteDescription 設定前は自前で溜める）
		let remoteSet = false;
		const pendingIce: object[] = [];
		store.setWebrtcIceHandler(candidate => {
			if (remoteSet) {
				pc.addIceCandidate(candidate).catch(() => { /* 無効なcandidateは無視 */ });
			} else {
				pendingIce.push(candidate);
			}
		});
		// mobile→PC の ICE
		(pc as unknown as { onicecandidate: ((e: { candidate?: { toJSON(): object } | null }) => void) | null }).onicecandidate = e => {
			if (e.candidate) {
				useAppStore.getState().webrtcSendIce(e.candidate.toJSON());
			}
		};

		// ストリーム受信を待つPromise（track イベント）
		const streamPromise = new Promise<{ toURL(): string }>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('webrtc connect timeout')), CONNECT_TIMEOUT_MS);
			(pc as unknown as { ontrack: ((e: { streams: { toURL(): string }[] }) => void) | null }).ontrack = e => {
				const stream = e.streams[0];
				if (stream) {
					clearTimeout(timer);
					resolve(stream);
				}
			};
		});

		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		if (!offer.sdp) {
			throw new Error('empty offer sdp');
		}
		const answer = await store.webrtcOffer(targetId, offer.sdp);
		if (!answer.sdp) {
			throw new Error('empty answer sdp');
		}
		await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
		remoteSet = true;
		for (const c of pendingIce.splice(0)) {
			pc.addIceCandidate(c).catch(() => { /* ignore */ });
		}

		const stream = await streamPromise;

		(pc as unknown as { onconnectionstatechange: (() => void) | null }).onconnectionstatechange = () => {
			if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
				cleanup(false);
			}
		};

		return {
			streamUrl: stream.toURL(),
			stop: () => cleanup(true),
			onClosed: cb => { closedCb = cb; },
		};
	} catch (err) {
		cleanup(true);
		throw err;
	}
}
