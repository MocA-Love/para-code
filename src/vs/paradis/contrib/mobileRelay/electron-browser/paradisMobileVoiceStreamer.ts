/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { getActiveWindow } from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Channels } from '../common/paradisMobileProtocol.js';
import { IParadisMobileInboundFrame } from '../common/paradisMobileRelay.js';

interface IVoiceWebrtcSignal {
	t: 'voice-webrtc-offer' | 'voice-webrtc-ice' | 'voice-webrtc-stop';
	id?: string;
	sdp?: string;
	candidate?: RTCIceCandidateInit;
	sid?: string;
}

interface IVoicePeer {
	readonly pc: RTCPeerConnection;
	readonly sid: string | undefined;
	remoteSet: boolean;
	disconnectTimer: ReturnType<typeof setTimeout> | undefined;
}

const STUN_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const MAX_PENDING_ICE = 64;
const DISCONNECT_GRACE_MS = 15_000;
const MAX_QUEUED_CLIPS = 8;
const MAX_QUEUED_CLIP_BYTES = 16 * 1024 * 1024;
const MAX_SCHEDULED_SOURCES = 32;
const MAX_CLIP_DURATION_SECONDS = 120;
const MAX_SCHEDULE_AHEAD_SECONDS = 120;

/** decodeAudioDataへ渡す前にLayer IIIフレームを走査し、巨大PCMへ展開される入力を拒否する。 */
function mp3DurationSeconds(bytes: Uint8Array, maximumSeconds: number): number | undefined {
	let offset = 0;
	if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
		if ((bytes[6]! | bytes[7]! | bytes[8]! | bytes[9]!) & 0x80) {
			return undefined;
		}
		const tagSize = (bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!;
		offset = 10 + tagSize + ((bytes[5]! & 0x10) !== 0 ? 10 : 0);
		if (offset > bytes.length) {
			return undefined;
		}
	}

	// エンコーダ由来の少量の先行paddingだけ許し、無制限のsync探索はしない。
	const searchEnd = Math.min(bytes.length - 4, offset + 4096);
	while (offset <= searchEnd && !(bytes[offset] === 0xff && (bytes[offset + 1]! & 0xe0) === 0xe0)) {
		offset++;
	}

	const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
	const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
	const baseSampleRates = [44_100, 48_000, 32_000];
	let duration = 0;
	let frames = 0;
	while (offset + 4 <= bytes.length) {
		const b1 = bytes[offset + 1]!;
		const b2 = bytes[offset + 2]!;
		if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) {
			break;
		}
		const versionBits = (b1 >> 3) & 0x03;
		const layerBits = (b1 >> 1) & 0x03;
		const bitrateIndex = (b2 >> 4) & 0x0f;
		const sampleRateIndex = (b2 >> 2) & 0x03;
		if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
			return undefined;
		}
		const isMpeg1 = versionBits === 3;
		const divisor = isMpeg1 ? 1 : versionBits === 2 ? 2 : 4;
		const sampleRate = baseSampleRates[sampleRateIndex]! / divisor;
		const bitrateKbps = (isMpeg1 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex]!;
		const padding = (b2 >> 1) & 0x01;
		const frameLength = Math.floor((isMpeg1 ? 144_000 : 72_000) * bitrateKbps / sampleRate) + padding;
		if (frameLength < 4 || offset + frameLength > bytes.length) {
			return undefined;
		}
		duration += (isMpeg1 ? 1152 : 576) / sampleRate;
		if (duration > maximumSeconds) {
			return undefined;
		}
		frames++;
		offset += frameLength;
	}
	// 通知音声として成立する連続MP3だけを許す。ID3v1等の小さな末尾メタデータは許容する。
	return frames >= 2 && bytes.length - offset <= 1024 ? duration : undefined;
}

/**
 * 1本の連続Web Audioトラックへ合成済みMP3を順番に投入し、開始中の各モバイルへ送る。
 * 音声イベントは履歴化せず、ピアが無い時点で届いたクリップは即破棄する。
 */
export class ParadisMobileVoiceStreamer extends Disposable {
	private readonly peers = new Map<string, IVoicePeer>();
	private readonly currentSid = new Map<string, string | undefined>();
	private readonly offerGeneration = new Map<string, number>();
	private readonly pendingIce = new Map<string, { sid: string | undefined; candidates: RTCIceCandidateInit[] }>();
	private readonly decoder = new TextDecoder();
	private readonly encoder = new TextEncoder();
	private audioContext: AudioContext | undefined;
	private destination: MediaStreamAudioDestinationNode | undefined;
	private silenceSource: ConstantSourceNode | undefined;
	private scheduledUntil = 0;
	private audioGeneration = 0;
	private clipQueue: Promise<void> = Promise.resolve();
	private queuedClipCount = 0;
	private queuedClipBytes = 0;
	private readonly scheduledSources = new Set<AudioBufferSourceNode>();

	constructor(
		private readonly sendFrame: (frame: IParadisMobileInboundFrame) => void,
		voiceClips: Event<VSBuffer>,
		private readonly logService: ILogService,
	) {
		super();
		this._register(voiceClips(clip => this.enqueueClip(clip)));
		this._register({ dispose: () => this.stopAll() });
	}

	handleInbound(frame: IParadisMobileInboundFrame): void {
		let message: IVoiceWebrtcSignal;
		try {
			message = JSON.parse(this.decoder.decode(frame.payload.buffer)) as IVoiceWebrtcSignal;
		} catch {
			return;
		}
		const mobileId = frame.mobileId ?? '';
		if (mobileId.length === 0) {
			return;
		}
		if (message.t === 'voice-webrtc-offer' && typeof message.sdp === 'string') {
			this.currentSid.set(mobileId, message.sid);
			void this.handleOffer(mobileId, message.id, message.sdp, message.sid);
			return;
		}
		if (message.t === 'voice-webrtc-ice' && message.candidate !== undefined) {
			if (this.isStaleSid(mobileId, message.sid)) {
				return;
			}
			const peer = this.peers.get(mobileId);
			if (peer?.remoteSet) {
				peer.pc.addIceCandidate(message.candidate).catch(error => this.logService.warn('[paradisMobileVoice] addIceCandidate failed', error));
			} else {
				let queue = this.pendingIce.get(mobileId);
				if (queue === undefined || queue.sid !== message.sid) {
					queue = { sid: message.sid, candidates: [] };
					this.pendingIce.set(mobileId, queue);
				}
				if (queue.candidates.length < MAX_PENDING_ICE) {
					queue.candidates.push(message.candidate);
				}
			}
			return;
		}
		if (message.t === 'voice-webrtc-stop' && !this.isStaleSid(mobileId, message.sid)) {
			this.stopPeer(mobileId);
		}
	}

	stopAll(): void {
		for (const mobileId of [...this.peers.keys()]) {
			this.stopPeer(mobileId, false);
		}
		this.currentSid.clear();
		this.pendingIce.clear();
		this.disposeAudioGraph();
	}

	private isStaleSid(mobileId: string, sid: string | undefined): boolean {
		const current = this.currentSid.get(mobileId);
		return sid !== undefined && current !== undefined && sid !== current;
	}

	private async handleOffer(mobileId: string, id: string | undefined, sdp: string, sid: string | undefined): Promise<void> {
		this.stopPeer(mobileId);
		const generation = (this.offerGeneration.get(mobileId) ?? 0) + 1;
		this.offerGeneration.set(mobileId, generation);
		let track: MediaStreamTrack;
		try {
			track = await this.ensureAudioTrack();
		} catch (error) {
			this.logService.warn('[paradisMobileVoice] audio graph failed', error);
			this.send(mobileId, { t: 'voice-webrtc-error', id, sid, error: 'audio unavailable' });
			return;
		}
		if (this.offerGeneration.get(mobileId) !== generation) {
			return;
		}
		const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
		const peer: IVoicePeer = { pc, sid, remoteSet: false, disconnectTimer: undefined };
		this.peers.set(mobileId, peer);
		pc.addTrack(track, this.destination!.stream);
		pc.onicecandidate = event => {
			if (event.candidate !== null) {
				this.send(mobileId, { t: 'voice-webrtc-ice', candidate: event.candidate.toJSON(), sid });
			}
		};
		pc.onconnectionstatechange = () => {
			if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
				this.stopPeer(mobileId);
			} else if (pc.connectionState === 'disconnected' && peer.disconnectTimer === undefined) {
				peer.disconnectTimer = setTimeout(() => {
					peer.disconnectTimer = undefined;
					if (this.peers.get(mobileId) === peer && pc.connectionState !== 'connected') {
						this.stopPeer(mobileId);
					}
				}, DISCONNECT_GRACE_MS);
			} else if (pc.connectionState === 'connected' && peer.disconnectTimer !== undefined) {
				clearTimeout(peer.disconnectTimer);
				peer.disconnectTimer = undefined;
			}
		};
		try {
			await pc.setRemoteDescription({ type: 'offer', sdp });
			peer.remoteSet = true;
			const queued = this.pendingIce.get(mobileId);
			if (queued?.sid === sid) {
				this.pendingIce.delete(mobileId);
				for (const candidate of queued.candidates) {
					pc.addIceCandidate(candidate).catch(error => this.logService.warn('[paradisMobileVoice] queued addIceCandidate failed', error));
				}
			}
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			this.send(mobileId, { t: 'voice-webrtc-answer', id, sdp: answer.sdp, sid });
		} catch (error) {
			this.logService.warn('[paradisMobileVoice] negotiation failed', error);
			this.send(mobileId, { t: 'voice-webrtc-error', id, sid, error: 'negotiation failed' });
			this.stopPeer(mobileId);
		}
	}

	private async ensureAudioTrack(): Promise<MediaStreamTrack> {
		if (this.audioContext === undefined || this.destination === undefined) {
			const context = new (getActiveWindow().AudioContext)({ sampleRate: 48_000 });
			const destination = context.createMediaStreamDestination();
			const silence = context.createConstantSource();
			silence.offset.value = 0;
			silence.connect(destination);
			silence.start();
			this.audioContext = context;
			this.destination = destination;
			this.silenceSource = silence;
			this.scheduledUntil = context.currentTime;
		}
		if (this.audioContext.state === 'suspended') {
			await this.audioContext.resume();
		}
		const track = this.destination.stream.getAudioTracks()[0];
		if (track === undefined) {
			throw new Error('audio track unavailable');
		}
		return track;
	}

	private enqueueClip(clip: VSBuffer): void {
		if (this.peers.size === 0) {
			return;
		}
		const bytes = Uint8Array.from(clip.buffer);
		if (this.queuedClipCount >= MAX_QUEUED_CLIPS || this.queuedClipBytes + bytes.byteLength > MAX_QUEUED_CLIP_BYTES) {
			this.logService.warn('[paradisMobileVoice] clip dropped because the decode queue is full');
			return;
		}
		this.queuedClipCount++;
		this.queuedClipBytes += bytes.byteLength;
		const generation = this.audioGeneration;
		this.clipQueue = this.clipQueue
			.then(() => this.scheduleClip(bytes, generation))
			.catch(error => this.logService.warn('[paradisMobileVoice] clip decode failed', error))
			.finally(() => {
				this.queuedClipCount = Math.max(0, this.queuedClipCount - 1);
				this.queuedClipBytes = Math.max(0, this.queuedClipBytes - bytes.byteLength);
			});
	}

	private async scheduleClip(bytes: Uint8Array, generation: number): Promise<void> {
		if (this.peers.size === 0 || generation !== this.audioGeneration) {
			return;
		}
		if (mp3DurationSeconds(bytes, MAX_CLIP_DURATION_SECONDS) === undefined) {
			this.logService.warn('[paradisMobileVoice] invalid or overlong MP3 dropped before decode');
			return;
		}
		await this.ensureAudioTrack();
		const context = this.audioContext!;
		const encoded = Uint8Array.from(bytes).buffer;
		const decoded = await context.decodeAudioData(encoded);
		if (this.peers.size === 0 || generation !== this.audioGeneration) {
			return;
		}
		if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > MAX_CLIP_DURATION_SECONDS
			|| this.scheduledSources.size >= MAX_SCHEDULED_SOURCES) {
			this.logService.warn('[paradisMobileVoice] clip dropped because the playback schedule is full');
			return;
		}
		const source = context.createBufferSource();
		source.buffer = decoded;
		source.connect(this.destination!);
		const startAt = Math.max(context.currentTime + 0.02, this.scheduledUntil);
		if (startAt - context.currentTime > MAX_SCHEDULE_AHEAD_SECONDS) {
			source.disconnect();
			this.logService.warn('[paradisMobileVoice] clip dropped because playback is too far behind');
			return;
		}
		this.scheduledSources.add(source);
		source.onended = () => {
			this.scheduledSources.delete(source);
			try { source.disconnect(); } catch { /* ignore */ }
		};
		source.start(startAt);
		this.scheduledUntil = startAt + decoded.duration;
	}

	private stopPeer(mobileId: string, disposeGraphWhenEmpty = true): void {
		this.offerGeneration.set(mobileId, (this.offerGeneration.get(mobileId) ?? 0) + 1);
		this.pendingIce.delete(mobileId);
		const peer = this.peers.get(mobileId);
		if (peer === undefined) {
			return;
		}
		this.peers.delete(mobileId);
		if (peer.disconnectTimer !== undefined) {
			clearTimeout(peer.disconnectTimer);
		}
		try {
			peer.pc.onicecandidate = null;
			peer.pc.onconnectionstatechange = null;
			peer.pc.close();
		} catch { /* ignore */ }
		if (disposeGraphWhenEmpty && this.peers.size === 0) {
			this.disposeAudioGraph();
		}
	}

	private disposeAudioGraph(): void {
		this.audioGeneration++;
		this.clipQueue = Promise.resolve();
		this.scheduledUntil = 0;
		try { this.silenceSource?.stop(); } catch { /* ignore */ }
		this.silenceSource?.disconnect();
		for (const source of this.scheduledSources) {
			try { source.stop(); } catch { /* ignore */ }
			try { source.disconnect(); } catch { /* ignore */ }
		}
		this.scheduledSources.clear();
		this.destination?.stream.getTracks().forEach(track => track.stop());
		void this.audioContext?.close().catch(() => { /* ignore */ });
		this.silenceSource = undefined;
		this.destination = undefined;
		this.audioContext = undefined;
	}

	private send(mobileId: string, message: object): void {
		this.sendFrame({
			ch: Channels.Browser,
			ws: undefined,
			seq: 0,
			payload: VSBuffer.wrap(this.encoder.encode(JSON.stringify(message))),
			mobileId,
		});
	}
}
