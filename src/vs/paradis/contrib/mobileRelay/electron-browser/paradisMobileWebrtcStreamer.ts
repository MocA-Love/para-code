/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルブラウザミラーの WebRTC ストリーマ（renderer 側、設計: app/design/webrtc-mirror-design.md）。
//
// モバイルからの webrtc-offer（browser チャネル、E2E経由でMITM耐性あり）を受け、
// getDisplayMedia で内蔵ブラウザ(WebContentsView)単体の映像トラックを取得して
// RTCPeerConnection でモバイルへ送出する。対象ビューの選別は、shared process が
// offer 転送前に electron-main を arm 済み（paradisBrowserMirrorCapture.ts の
// one-shot 状態を app.ts の setDisplayMediaRequestHandler が消費する）。
//
// WebRTC スタックは renderer にしか無いため、ここ（workbench ウィンドウ）で動く。
// ウィンドウ reload でピアは消えるが、モバイル側が確立タイムアウトで既存の
// JPEG ミラーへフォールバックするため致命的ではない。

import { getActiveWindow } from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Channels } from '../common/paradisMobileProtocol.js';
import { IParadisMobileInboundFrame } from '../common/paradisMobileRelay.js';

/** モバイル→PC のシグナリング（browser チャネル JSON、t: 'webrtc-*'）。 */
interface IWebrtcSignal {
	t: 'webrtc-offer' | 'webrtc-ice' | 'webrtc-stop';
	/** 要求応答の相関ID（offer のみ。answer/error が同じ id で返る）。 */
	id?: string;
	targetId?: string;
	sdp?: string;
	candidate?: RTCIceCandidateInit;
	/**
	 * セッション識別子（モバイル側の startWebrtcMirror 1回ごとに一意）。
	 * モバイルの確立フェーズは長い（TURN取得＋offer応答のawait）ため、素早いターゲット
	 * 切替では新旧セッションが過渡的に共存する。古いセッションのcleanupが送る stop/ice を
	 * これで識別して弾き、現行ピアを巻き添えにしない。旧クライアントは未設定（=常に受理）。
	 */
	sid?: string;
}

interface IPeerState {
	pc: RTCPeerConnection;
	stream: MediaStream;
	/** このピアを張ったofferのセッションID（旧クライアントはundefined）。 */
	sid: string | undefined;
	/** setRemoteDescription 完了済みか（完了前に届いたICEは pendingIce へ溜める）。 */
	remoteSet: boolean;
	/** connectionState==='disconnected' の復帰猶予タイマー。 */
	disconnectTimer: ReturnType<typeof setTimeout> | undefined;
}

/** answer前ICEキューの上限（暴走対策。通常のトリクルは数個〜十数個）。 */
const MAX_PENDING_ICE = 64;
/** disconnected からの復帰を待つ猶予。過ぎたらキャプチャごと解放（モバイルはJPEGへ落ちている）。 */
const DISCONNECT_GRACE_MS = 10_000;

const STUN_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/**
 * mobileId ごとに1つの送出ピアを管理する。offer 受信で作り直し、
 * stop/切断/トラック終了（ビューが閉じられた）で破棄する。
 */
export class ParadisMobileWebrtcStreamer extends Disposable {

	private readonly peers = new Map<string, IPeerState>();
	/**
	 * mobileId ごとの offer 世代。getDisplayMedia の await 中に新しい offer / stop が
	 * 割り込んだ場合、古い方は取得済みストリームを止めて破棄する（同時 offer での
	 * ピア/キャプチャのリーク防止）。
	 */
	private readonly offerGen = new Map<string, number>();
	/**
	 * answer（setRemoteDescription）前に届いたモバイルのICE candidateの一時キュー。
	 * PC側はarm往復＋getDisplayMediaでピア生成が数百ms遅れるのに対し、モバイルは
	 * offer送信直後からトリクルするため、キュー無しでは先行candidateを取りこぼす
	 * （peer-reflexive頼みになり、NAT構成次第で確立失敗→JPEG降格の温床になる）。
	 */
	private readonly pendingIce = new Map<string, { sid: string | undefined; candidates: RTCIceCandidateInit[] }>();
	/** mobileId ごとの現在有効なセッションID（直近offerのsid）。stale な ice/stop を弾く。 */
	private readonly currentSid = new Map<string, string | undefined>();
	private readonly decoder = new TextDecoder();
	private readonly encoder = new TextEncoder();

	constructor(
		private readonly sendFrame: (frame: IParadisMobileInboundFrame) => void,
		private readonly logService: ILogService,
	) {
		super();
		this._register({ dispose: () => this.stopAll() });
	}

	/** browser チャネルの受信フレームを処理する。webrtc-* 以外は無視（呼び出し側で振り分け済み想定）。 */
	handleInbound(frame: IParadisMobileInboundFrame): void {
		let msg: IWebrtcSignal;
		try {
			msg = JSON.parse(this.decoder.decode(frame.payload.buffer)) as IWebrtcSignal;
		} catch {
			return;
		}
		const mobileId = frame.mobileId ?? '';
		if (mobileId.length === 0) {
			// 宛先不明のまま応答すると sendFrame が全端末ブロードキャストになるため処理しない
			return;
		}
		if (msg.t === 'webrtc-offer' && typeof msg.sdp === 'string') {
			this.currentSid.set(mobileId, msg.sid);
			void this.handleOffer(mobileId, msg.id, msg.sdp, msg.sid);
		} else if (msg.t === 'webrtc-ice' && msg.candidate) {
			if (this.isStaleSid(mobileId, msg.sid)) {
				return; // 破棄済み旧セッションのICE
			}
			const peer = this.peers.get(mobileId);
			if (peer && peer.remoteSet) {
				peer.pc.addIceCandidate(msg.candidate).catch(err => this.logService.warn('[paradisWebrtc] addIceCandidate failed', err));
			} else {
				// ピア生成前／answer設定前に届いた分。setRemoteDescription後にまとめて適用する
				let queue = this.pendingIce.get(mobileId);
				if (!queue || queue.sid !== msg.sid) {
					queue = { sid: msg.sid, candidates: [] };
					this.pendingIce.set(mobileId, queue);
				}
				if (queue.candidates.length < MAX_PENDING_ICE) {
					queue.candidates.push(msg.candidate);
				}
			}
		} else if (msg.t === 'webrtc-stop') {
			if (this.isStaleSid(mobileId, msg.sid)) {
				return; // 旧セッションのcleanupによるstop。現行ピアを巻き添えにしない
			}
			this.stopPeer(mobileId);
		}
	}

	/** 現行セッション（直近offer）と異なるsidか。どちらか未設定なら互換のため受理する。 */
	private isStaleSid(mobileId: string, sid: string | undefined): boolean {
		const current = this.currentSid.get(mobileId);
		return sid !== undefined && current !== undefined && sid !== current;
	}

	/** すべてのピアを破棄する（モバイル全切断・dispose 時）。 */
	stopAll(): void {
		for (const mobileId of [...this.peers.keys()]) {
			this.stopPeer(mobileId);
		}
	}

	private async handleOffer(mobileId: string, id: string | undefined, sdp: string, sid: string | undefined): Promise<void> {
		// 既存ピアは作り直す（モバイル側の再ネゴシエーション起点）
		this.stopPeer(mobileId);
		const gen = (this.offerGen.get(mobileId) ?? 0) + 1;
		this.offerGen.set(mobileId, gen);

		let stream: MediaStream;
		try {
			// shared process が offer 転送前に electron-main を arm 済みなので、
			// ここでの getDisplayMedia は対象 WebContentsView 単体のトラックを返す
			// （arm が解決できない場合は main 側が fail-closed で拒否 → ここで throw）。
			const mediaDevices = getActiveWindow().navigator.mediaDevices;
			stream = await mediaDevices.getDisplayMedia({ video: true, audio: false });
		} catch (err) {
			this.logService.warn('[paradisWebrtc] getDisplayMedia failed', err);
			this.send(mobileId, { t: 'webrtc-error', id, error: String(err instanceof Error ? err.message : err) });
			return;
		}
		if (this.offerGen.get(mobileId) !== gen) {
			// await 中に新しい offer / stop が割り込んだ（自分は古い世代）→ 破棄
			stream.getTracks().forEach(t => t.stop());
			return;
		}
		const [track] = stream.getVideoTracks();
		if (!track) {
			stream.getTracks().forEach(t => t.stop());
			this.send(mobileId, { t: 'webrtc-error', id, error: 'no video track' });
			return;
		}

		const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
		const peer: IPeerState = { pc, stream, sid, remoteSet: false, disconnectTimer: undefined };
		this.peers.set(mobileId, peer);
		pc.addTrack(track, stream);

		pc.onicecandidate = e => {
			if (e.candidate) {
				this.send(mobileId, { t: 'webrtc-ice', candidate: e.candidate.toJSON(), sid });
			}
		};
		pc.onconnectionstatechange = () => {
			if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
				this.stopPeer(mobileId);
			} else if (pc.connectionState === 'disconnected') {
				// モバイルのオフライン化等。復帰しなければキャプチャごと解放する（明示stopが
				// 届かない切断ではこれが唯一の解放経路。failed到達は数十秒かかることがある）
				if (this.peers.get(mobileId) === peer && peer.disconnectTimer === undefined) {
					peer.disconnectTimer = setTimeout(() => {
						peer.disconnectTimer = undefined;
						if (this.peers.get(mobileId) === peer && pc.connectionState !== 'connected') {
							this.stopPeer(mobileId);
						}
					}, DISCONNECT_GRACE_MS);
				}
			} else if (pc.connectionState === 'connected' && peer.disconnectTimer !== undefined) {
				clearTimeout(peer.disconnectTimer);
				peer.disconnectTimer = undefined;
			}
		};
		// 対象ビューが閉じられるとトラックが終了する → ピアも畳む（モバイルはJPEGへフォールバック）
		track.onended = () => this.stopPeer(mobileId);

		try {
			await pc.setRemoteDescription({ type: 'offer', sdp });
			peer.remoteSet = true;
			// answer前（arm往復＋getDisplayMediaの間）に届いていたICEをまとめて適用する
			const queued = this.pendingIce.get(mobileId);
			if (queued && queued.sid === sid) {
				this.pendingIce.delete(mobileId);
				for (const candidate of queued.candidates) {
					pc.addIceCandidate(candidate).catch(err => this.logService.warn('[paradisWebrtc] queued addIceCandidate failed', err));
				}
			}
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			this.send(mobileId, { t: 'webrtc-answer', id, sdp: answer.sdp, sid });
		} catch (err) {
			this.logService.warn('[paradisWebrtc] negotiation failed', err);
			this.send(mobileId, { t: 'webrtc-error', id, error: String(err instanceof Error ? err.message : err), sid });
			this.stopPeer(mobileId);
		}
	}

	private stopPeer(mobileId: string): void {
		// 進行中(handleOfferのawait中)の古い offer も無効化する
		this.offerGen.set(mobileId, (this.offerGen.get(mobileId) ?? 0) + 1);
		this.pendingIce.delete(mobileId);
		const peer = this.peers.get(mobileId);
		if (!peer) {
			return;
		}
		this.peers.delete(mobileId);
		if (peer.disconnectTimer !== undefined) {
			clearTimeout(peer.disconnectTimer);
			peer.disconnectTimer = undefined;
		}
		try {
			peer.pc.onicecandidate = null;
			peer.pc.onconnectionstatechange = null;
			peer.pc.close();
		} catch { /* ignore */ }
		peer.stream.getTracks().forEach(t => {
			t.onended = null;
			t.stop();
		});
	}

	private send(mobileId: string, msg: object): void {
		// mobileId は handleInbound で非空を保証済み。undefined へ変換すると
		// sendFrame が全端末ブロードキャストになるため、そのまま渡す。
		this.sendFrame({
			ch: Channels.Browser,
			ws: undefined,
			seq: 0,
			payload: VSBuffer.wrap(this.encoder.encode(JSON.stringify(msg))),
			mobileId,
		});
	}
}
