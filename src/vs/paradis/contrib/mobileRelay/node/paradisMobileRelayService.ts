/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	MobileIdentity,
	SecureChannel,
	deriveSasCode,
	generatePersistableIdentity,
	importIdentity,
	respondHandshake,
} from '../common/paradisMobileCrypto.js';
import { FrameMux } from '../common/paradisMobileMux.js';
import {
	Channels,
	ChannelId,
	decodeRelayControl,
	encodeRelayControl,
	encodePairingUri,
	fromBase64Url,
	mobileIdToString,
	packPcData,
	toBase64Url,
	unpackPcData,
} from '../common/paradisMobileProtocol.js';
import {
	IParadisMobileInboundFrame,
	IParadisMobilePairingSession,
	IParadisMobileRelayService,
	IParadisMobileStatus,
	PARADIS_MOBILE_DEFAULT_RELAY_URL,
	ParadisMobileConnectionState,
	ParadisMobilePairingEvent,
} from '../common/paradisMobileRelay.js';

// Node（shared process）で使うファイルシステム / crypto。
import { promises as fs } from 'fs';

interface PairedMobile {
	readonly mobileId: string;
	readonly name: string;
	/** モバイルの長期公開鍵（base64url）。データ接続時のハンドシェイク相手鍵。 */
	readonly pubKey: string;
}

interface PersistedState {
	identity?: { pubKey: string; pkcs8: string };
	device?: { deviceId: string; pcToken: string };
	mobiles: PairedMobile[];
}

/** 1つのモバイルとのデータ接続（ハンドシェイク進行 + 確立後のFrameMux）。 */
class MobileSession {
	private channel: SecureChannel | undefined;
	private mux: FrameMux | undefined;
	private confirmed = false;

	constructor(
		readonly mobileId: string,
		private readonly mobileIdBytes: Uint8Array,
		private readonly mobilePubKey: Uint8Array,
		private readonly pcIdentity: MobileIdentity,
		private readonly sendToRelay: (payload: Uint8Array) => void,
		private readonly onFrame: (frame: IParadisMobileInboundFrame) => void,
		private readonly logService: ILogService,
	) { }

	get isOnline(): boolean {
		return this.confirmed;
	}

	/** モバイルからのバイナリ（この mobileId 宛の payload）を処理する。 */
	async handlePayload(payload: Uint8Array): Promise<void> {
		try {
			if (!this.channel) {
				// 最初のバイナリは hello（ephemeral公開鍵32B）。responderハンドシェイクを実行。
				// response（=respEph+封緘ack）はそのまま relay 経由でモバイルへ返す
				// （sendToRelay が packPcData で mobileId を付ける）。
				const responder = await respondHandshake(this.pcIdentity, this.mobilePubKey, payload);
				this.channel = responder.channel;
				this.pendingVerify = responder.verifyConfirm;
				this.sendToRelay(responder.response);
				return;
			}
			if (!this.confirmed) {
				// 次は confirm。検証してFrameMuxを確立。
				await this.pendingVerify!(payload);
				this.confirmed = true;
				this.mux = new FrameMux(this.channel, {
					sendSealed: (sealed: Uint8Array) => this.sendToRelay(sealed),
					onError: (err: unknown) => this.logService.warn('[paradisMobileRelay] frame open failed', err),
				});
				this.mux.on(Channels.State, f => this.emit(f));
				this.mux.on(Channels.Terminal, f => this.emit(f));
				this.mux.on(Channels.Scm, f => this.emit(f));
				this.mux.on(Channels.Fs, f => this.emit(f));
				this.mux.on(Channels.Browser, f => this.emit(f));
				return;
			}
			await this.mux!.receive(payload);
		} catch (err) {
			this.logService.warn(`[paradisMobileRelay] session ${this.mobileId} error`, err);
		}
	}

	private pendingVerify: ((confirm: Uint8Array) => Promise<void>) | undefined;

	private emit(frame: { ch: ChannelId; ws?: string; seq: number; payload: Uint8Array }): void {
		this.onFrame({ ch: frame.ch, ws: frame.ws, seq: frame.seq, payload: VSBuffer.wrap(frame.payload) });
	}

	/** PC→モバイルのフレームを封緘して送る。 */
	async sendFrame(ch: ChannelId, ws: string | undefined, payload: Uint8Array): Promise<void> {
		if (this.mux) {
			await this.mux.send(ch, payload, ws);
		}
	}

	get idBytes(): Uint8Array {
		return this.mobileIdBytes;
	}
}

/**
 * shared process 常駐のモバイルリレーサービス。リレーへの outbound WSS を所有し、
 * E2E暗号・ペアリング・フレーム多重化を行う。renderer とは IPC チャネルで接続する。
 */
export class ParadisMobileRelayService extends Disposable implements IParadisMobileRelayService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<IParadisMobileStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private readonly _onPairingEvent = this._register(new Emitter<ParadisMobilePairingEvent>());
	readonly onPairingEvent = this._onPairingEvent.event;

	private readonly _onInboundFrame = this._register(new Emitter<IParadisMobileInboundFrame>());
	readonly onInboundFrame = this._onInboundFrame.event;

	private state: PersistedState = { mobiles: [] };
	private identity: MobileIdentity | undefined;
	private enabled = false;
	private connectionState: ParadisMobileConnectionState = 'disabled';

	private socket: WebSocket | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectAttempt = 0;
	private readonly sessions = new Map<string, MobileSession>();

	// ペアリング中の状態
	private pairing: {
		pairingToken: Uint8Array;
		mobilePubKey?: Uint8Array;
		proposedName: string;
	} | undefined;

	private readonly statePath: string;
	private relayUrlOverride: string | undefined;

	constructor(
		private readonly userDataPath: string,
		private readonly logService: ILogService,
	) {
		super();
		this.statePath = join(this.userDataPath, 'paradis-mobile-relay.json');
		this._register(toDisposable(() => this.disconnect()));
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
		if (this.state.identity) {
			this.identity = await importIdentity(fromBase64Url(this.state.identity.pkcs8), fromBase64Url(this.state.identity.pubKey));
		}
	}

	private async save(): Promise<void> {
		// TODO(follow-up): 秘密鍵は safeStorage(IEncryptionMainService経由)で暗号化して保存する。
		// 現状は既存のParadis secret保存(平文)と同水準。ファイルは 0600 で作成する。
		const json = JSON.stringify(this.state);
		await fs.writeFile(this.statePath, json, { encoding: 'utf8', mode: 0o600 });
	}

	private async ensureIdentity(): Promise<MobileIdentity> {
		if (this.identity) {
			return this.identity;
		}
		const { identity, pkcs8 } = await generatePersistableIdentity();
		this.identity = identity;
		this.state.identity = { pubKey: toBase64Url(identity.publicKey), pkcs8: toBase64Url(pkcs8) };
		await this.save();
		return identity;
	}

	// --- 公開API（IPC） -------------------------------------------------------

	async getStatus(): Promise<IParadisMobileStatus> {
		return this.snapshot();
	}

	private snapshot(): IParadisMobileStatus {
		return {
			state: this.connectionState,
			deviceId: this.state.device?.deviceId,
			pairedDevices: this.state.mobiles.map(m => m.name),
			onlineMobiles: [...this.sessions.values()].filter(s => s.isOnline).length,
		};
	}

	private setConnectionState(state: ParadisMobileConnectionState): void {
		if (this.connectionState !== state) {
			this.connectionState = state;
			this._onDidChangeStatus.fire(this.snapshot());
		}
	}

	async initialize(enabled: boolean, relayUrl: string | undefined): Promise<void> {
		this.relayUrlOverride = relayUrl;
		await this.load();
		this.enabled = enabled;
		if (enabled && this.state.device) {
			this.connect();
		} else {
			this.setConnectionState(enabled ? 'disconnected' : 'disabled');
		}
	}

	async setEnabled(enabled: boolean): Promise<void> {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
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
	}

	private relayHttpBase(): string {
		const ws = (this.relayUrlOverride ?? PARADIS_MOBILE_DEFAULT_RELAY_URL).replace(/\/$/, '');
		return ws.replace(/^ws/, 'http');
	}

	private relayWsBase(): string {
		return (this.relayUrlOverride ?? PARADIS_MOBILE_DEFAULT_RELAY_URL).replace(/\/$/, '');
	}

	async beginPairing(): Promise<IParadisMobilePairingSession> {
		const identity = await this.ensureIdentity();

		// 初回はデバイスをprovisionする。
		if (!this.state.device) {
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
			this.state.device = { deviceId: body.deviceId, pcToken };
			await this.save();
		}
		// ペアリング中はメッセージを受けるため必ず接続する（既に接続済みなら no-op）。
		this.connect();

		// ペアリングトークンを発行。
		const res = await fetch(`${this.relayHttpBase()}/device/${this.state.device.deviceId}/pair/begin`, { method: 'POST' });
		if (!res.ok) {
			throw new Error(`pair/begin failed: ${res.status}`);
		}
		const body = await res.json() as { pairId: string; pairingToken: string; expiresAt: number };
		const pairingToken = fromBase64Url(body.pairingToken);
		this.pairing = { pairingToken, proposedName: 'モバイルデバイス' };

		const pairingUri = encodePairingUri({
			version: 1,
			relayUrl: this.relayWsBase(),
			deviceId: this.state.device.deviceId,
			pairId: body.pairId,
			pairingToken,
			pcPublicKey: identity.publicKey,
		});
		return { deviceId: this.state.device.deviceId, pairingUri, expiresAt: body.expiresAt };
	}

	async approvePairing(): Promise<void> {
		if (!this.pairing || !this.pairing.mobilePubKey) {
			throw new Error('no pairing awaiting approval');
		}
		this.sendControl({ type: 'pairing-approve', name: this.pairing.proposedName });
		// 実際の mobiles への追加は relay からの 'paired'(mobileId) 受信時に行う。
	}

	async cancelPairing(): Promise<void> {
		if (this.pairing) {
			this.sendControl({ type: 'pairing-reject' });
			this.pairing = undefined;
		}
	}

	async revokeDevice(deviceName: string): Promise<void> {
		this.state.mobiles = this.state.mobiles.filter(m => m.name !== deviceName);
		await this.save();
		this._onDidChangeStatus.fire(this.snapshot());
	}

	async sendFrame(frame: IParadisMobileInboundFrame): Promise<void> {
		// ws（ワークスペース）に紐づかない全体フレーム、または特定モバイル宛。
		// 現状は全オンラインセッションへブロードキャスト（1台想定。将来 mobileId 指定に拡張）。
		const payload = frame.payload.buffer;
		for (const session of this.sessions.values()) {
			if (session.isOnline) {
				await session.sendFrame(frame.ch, frame.ws, payload);
			}
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
		const url = `${this.relayWsBase()}/device/${this.state.device.deviceId}/ws?role=pc&token=${encodeURIComponent(this.state.device.pcToken)}`;
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch (err) {
			this.logService.error('[paradisMobileRelay] failed to open socket', err);
			this.scheduleReconnect();
			return;
		}
		socket.binaryType = 'arraybuffer';
		this.socket = socket;

		socket.onopen = () => {
			this.reconnectAttempt = 0;
			this.setConnectionState('online');
		};
		socket.onmessage = event => { void this.onSocketMessage(event.data); };
		socket.onerror = () => { /* onclose が続く */ };
		socket.onclose = () => {
			this.socket = undefined;
			this.sessions.clear();
			if (this.enabled) {
				this.setConnectionState('disconnected');
				this.scheduleReconnect();
			} else {
				this.setConnectionState('disabled');
			}
		};
	}

	private disconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.sessions.clear();
		if (this.socket) {
			try { this.socket.close(); } catch { /* ignore */ }
			this.socket = undefined;
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || !this.enabled) {
			return;
		}
		const delay = Math.min(500 * 2 ** this.reconnectAttempt, 30_000);
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
			session = new MobileSession(
				idStr,
				mobileId,
				fromBase64Url(paired.pubKey),
				this.identity,
				sealed => this.sendBinaryToMobile(mobileId, sealed),
				frame => this._onInboundFrame.fire(frame),
				this.logService,
			);
			this.sessions.set(idStr, session);
		}
		const wasOnline = session.isOnline;
		await session.handlePayload(payload);
		if (session.isOnline !== wasOnline) {
			this._onDidChangeStatus.fire(this.snapshot());
		}
	}

	private sendBinaryToMobile(mobileId: Uint8Array, sealed: Uint8Array): void {
		if (this.socket && this.socket.readyState === 1) {
			const framed = packPcData(mobileId, sealed);
			// WebSocket.send の型は ArrayBuffer を要求するため、生成済みバッファをそのまま渡す
			// （packPcData は offset 0 の専有バッファを返す）。
			this.socket.send(framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer);
		}
	}

	private async onControl(text: string): Promise<void> {
		let msg;
		try {
			msg = decodeRelayControl(text);
		} catch {
			return;
		}
		if (msg.type === 'pairing-msg') {
			await this.onPairingMessage(msg.data);
		} else if (msg.type === 'paired') {
			await this.onPaired(msg.mobileId);
		}
	}

	private async onPairingMessage(dataB64: string): Promise<void> {
		if (!this.pairing || !this.identity) {
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
