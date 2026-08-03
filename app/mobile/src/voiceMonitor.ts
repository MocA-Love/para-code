// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PC renderer から送られる音声通知の audio-only WebRTC 受信クライアント。
 * 通常のブラウザ映像ミラーとは独立した peer を使い、ユーザーが明示的に開始した間だけ接続する。
 */

import { useAppStore } from './appState.js';
import { isVoiceSessionSupported } from '../modules/para-voice-session/index.js';

interface WebrtcModule {
	RTCPeerConnection: new (config: object) => RtcPeerConnectionLike;
}

interface RtcPeerConnectionLike {
	addTransceiver(kind: string, init: { direction: string }): void;
	createOffer(options?: object): Promise<{ sdp?: string; type: string }>;
	setLocalDescription(desc: object): Promise<void>;
	setRemoteDescription(desc: object): Promise<void>;
	addIceCandidate(candidate: object): Promise<void>;
	close(): void;
	connectionState: string;
}

let webrtcModule: WebrtcModule | undefined | null = null;
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

export function isVoiceMonitorSupported(): boolean {
	return isVoiceSessionSupported() && loadWebrtc() !== undefined;
}

export interface VoiceMonitorSession {
	stop(): void;
	onClosed(cb: () => void): void;
}

const STUN_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const CONNECT_TIMEOUT_MS = 15_000;
const DISCONNECT_GRACE_MS = 15_000;

/** 指定 renderer から音声を受ける peer を確立する。 */
export async function startVoiceMonitor(windowId: number, signal?: AbortSignal): Promise<VoiceMonitorSession> {
	const mod = loadWebrtc();
	if (!mod) {
		throw new Error('webrtc unavailable in this build');
	}
	const store = useAppStore.getState();
	const sid = `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	const turnServers = await store.fetchTurnIceServers().catch(() => []);
	if (signal?.aborted) {
		throw new Error('voice monitor aborted');
	}
	const pc = new mod.RTCPeerConnection({ iceServers: [...STUN_SERVERS, ...turnServers] });
	let closed = false;
	let established = false;
	let closedCb: (() => void) | undefined;
	let connectTimer: ReturnType<typeof setTimeout> | undefined;
	let disconnectGraceTimer: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;

	const cleanup = (notifyPc: boolean) => {
		if (closed) {
			return;
		}
		closed = true;
		if (connectTimer !== undefined) {
			clearTimeout(connectTimer);
			connectTimer = undefined;
		}
		if (disconnectGraceTimer !== undefined) {
			clearTimeout(disconnectGraceTimer);
			disconnectGraceTimer = undefined;
		}
		if (abortListener !== undefined) {
			signal?.removeEventListener('abort', abortListener);
			abortListener = undefined;
		}
		store.clearVoiceWebrtcIceHandler(sid);
		try {
			pc.close();
		} catch { /* ignore */ }
		if (notifyPc) {
			store.voiceWebrtcStop(sid);
		}
		if (established) {
			closedCb?.();
		}
	};
	let rejectAbort!: (error: Error) => void;
	const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
	abortListener = () => {
		cleanup(true);
		rejectAbort(new Error('voice monitor aborted'));
	};
	signal?.addEventListener('abort', abortListener, { once: true });
	const abortable = <T>(promise: Promise<T>): Promise<T> => signal === undefined ? promise : Promise.race([promise, aborted]);

	try {
		pc.addTransceiver('audio', { direction: 'recvonly' });
		let remoteSet = false;
		const pendingIce: object[] = [];
		store.setVoiceWebrtcIceHandler(sid, candidate => {
			if (remoteSet) {
				pc.addIceCandidate(candidate).catch(() => { /* invalid candidate */ });
			} else if (pendingIce.length < 64) {
				pendingIce.push(candidate);
			}
		});
		(pc as unknown as { onicecandidate: ((event: { candidate?: { toJSON(): object } | null }) => void) | null }).onicecandidate = event => {
			if (event.candidate) {
				useAppStore.getState().voiceWebrtcSendIce(event.candidate.toJSON(), sid);
			}
		};

		const connected = new Promise<void>((resolve, reject) => {
			connectTimer = setTimeout(() => reject(new Error('voice webrtc connect timeout')), CONNECT_TIMEOUT_MS);
			(pc as unknown as { onconnectionstatechange: (() => void) | null }).onconnectionstatechange = () => {
				if (pc.connectionState === 'connected') {
					if (connectTimer !== undefined) {
						clearTimeout(connectTimer);
						connectTimer = undefined;
					}
					if (disconnectGraceTimer !== undefined) {
						clearTimeout(disconnectGraceTimer);
						disconnectGraceTimer = undefined;
					}
					resolve();
				} else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
					if (!established) {
						reject(new Error(`voice webrtc ${pc.connectionState}`));
					} else {
						cleanup(false);
					}
				} else if (pc.connectionState === 'disconnected' && established) {
					disconnectGraceTimer ??= setTimeout(() => {
						disconnectGraceTimer = undefined;
						if (pc.connectionState !== 'connected') {
							cleanup(false);
						}
					}, DISCONNECT_GRACE_MS);
				}
			};
		});
		// offer応答待ちが15秒を超える場合でも、後からrejectされるPromiseを未処理にしない。
		void connected.catch(() => { /* outer abortable await が同じ失敗を処理する */ });

		const offer = await abortable(pc.createOffer());
		await abortable(pc.setLocalDescription(offer));
		if (!offer.sdp) {
			throw new Error('empty voice offer sdp');
		}
		const answer = await abortable(store.voiceWebrtcOffer(windowId, offer.sdp, sid));
		if (!answer.sdp) {
			throw new Error('empty voice answer sdp');
		}
		await abortable(pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp }));
		remoteSet = true;
		for (const candidate of pendingIce.splice(0)) {
			pc.addIceCandidate(candidate).catch(() => { /* invalid candidate */ });
		}
		await abortable(connected);
		established = true;

		return {
			stop: () => cleanup(true),
			onClosed: cb => { closedCb = cb; },
		};
	} catch (error) {
		cleanup(true);
		throw error;
	}
}
