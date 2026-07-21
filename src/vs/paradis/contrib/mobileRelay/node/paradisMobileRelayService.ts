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
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { ILogService } from '../../../../platform/log/common/log.js';
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
import { IParadisCdpFrameSubscription, IParadisSharedPageBindings, paradisCodexPaneSocketPath } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { ParadisCdpUpstream } from '../../agentBrowser/node/paradisCdpUpstream.js';
import { ParadisMobileAgentChat } from './paradisMobileAgentChat.js';
import { ParadisAgentSessionStore } from './paradisAgentSessionStore.js';
import { IParadisFileSearchResult, IParadisTextSearchResult, paradisSearchFiles, paradisSearchText } from './paradisMobileSearch.js';
import { ParadisMobileBrowserMirror } from './paradisMobileBrowserMirror.js';
import { ParadisMobileTerminalRegistry } from './paradisMobileTerminalRegistry.js';
import {
	Channels,
	ChannelId,
	decodeNotifyControl,
	decodeRelayControl,
	encodeNotify,
	encodeNotifyDismissed,
	encodeNotifyDismissedByToken,
	peekNotifyKind,
	encodeRelayControl,
	encodePairingUri,
	fromBase64Url,
	mobileIdToString,
	NotifyPayload,
	packPcData,
	toBase64Url,
	unpackPcData,
} from '../common/paradisMobileProtocol.js';
import {
	IParadisGitResult,
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
	paradisMobileWindowRoute,
} from '../common/paradisMobileRelay.js';
import { IParadisMobileWindowLeaseRef, ParadisMobileOperationLedger } from './paradisMobileOperationLedger.js';
import { IParadisMobileRendererManifest, IParadisMobileWindowLease, ParadisMobileWindowLeaseClient } from '../common/paradisMobileWindowLease.js';
import { IParadisMobilePaneOwner } from './paradisMobilePaneRegistry.js';
import { ParadisAgentCommandAuthority, ParadisAgentCommandDeliveryResult } from '../common/paradisAgentCommandLifecycle.js';
import { ParadisMobileTrafficDiagnostics, startParadisMobileTrafficDiagnostics } from './paradisMobileTrafficDiagnostics.js';
import { ParadisMobileStateDelivery } from './paradisMobileStateDelivery.js';
import { paradisDecodeBinaryFsUpload } from '../common/paradisMobileFileUpload.js';

// Node（shared process）で使うファイルシステム / crypto。
import { promises as fs } from 'fs';

interface PairedMobile {
	readonly mobileId: string;
	readonly name: string;
	/** モバイルの長期公開鍵（base64url）。データ接続時のハンドシェイク相手鍵。 */
	readonly pubKey: string;
	/**
	 * モバイルの通知設定（アプリの設定画面から notify チャネルで同期される）。
	 * agentDone/agentQuestionがfalseの種別はAPNsフォールバックプッシュを送らない
	 * （オンライン時のフレーム配送は続ける: アプリ内の通知一覧に載せるかはモバイル側が
	 * 判断する）。未設定は全てtrue扱い。suppressWhenPcFocusedはtrueの間、PCがフォーカス
	 * されている間の配信自体（オンラインフレーム・APNs両方）を止める（未設定はfalse=抑制なし）。
	 */
	notifyPrefs?: { agentDone?: boolean; agentQuestion?: boolean; suppressWhenPcFocused?: boolean };
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
		private readonly sendToRelay: (payload: Uint8Array) => void,
		private readonly onFrame: (frame: IParadisMobileInboundFrame) => void,
		private readonly onTraffic: ((sample: IParadisMobileFrameTrafficSample) => void) | undefined,
		private readonly logService: ILogService,
	) { }

	get isOnline(): boolean {
		return this.confirmed;
	}

	get hasCurrentProtocol(): boolean {
		return this.negotiatedProtocolVersion === PARADIS_MOBILE_PROTOCOL_VERSION;
	}

	negotiateProtocol(payload: Uint8Array): boolean {
		try {
			const request = JSON.parse(new TextDecoder().decode(payload)) as { protocolVersion?: unknown };
			this.negotiatedProtocolVersion = request.protocolVersion === PARADIS_MOBILE_PROTOCOL_VERSION
				? PARADIS_MOBILE_PROTOCOL_VERSION
				: undefined;
		} catch {
			this.negotiatedProtocolVersion = undefined;
		}
		return this.hasCurrentProtocol;
	}

	/**
	 * モバイルからのバイナリを受信キューに積む。前のpayload処理の完了後に順に処理し、
	 * confirmed遷移をまたぐ並行実行を防ぐ。返すPromiseはこのpayloadの処理完了で解決する
	 * （呼び出し側がisOnline遷移を検査できるように）。
	 */
	enqueuePayload(payload: Uint8Array): Promise<void> {
		const result = this.rxChain.then(() => this.handlePayload(payload));
		// handlePayload は内部でcatch済みなのでrejectしないが、念のため鎖が切れないようにする。
		this.rxChain = result.catch(() => { });
		return result;
	}

	/** モバイルからのバイナリ（この mobileId 宛の payload）を処理する。 */
	private async handlePayload(payload: Uint8Array): Promise<void> {
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
			await this.mux!.receive(payload);
		} catch (err) {
			// 自己回復: ハンドシェイク確立中/確立後に処理できない32Bのペイロードが届いた場合、
			// それはモバイルが再接続して送り直した新しい hello（ephemeral公開鍵32B）である
			// 可能性が高い（正規のsealed frameはヘッダ+nonce+tagで32Bより必ず大きい）。
			// リレーからのモバイルoffline通知が欠落した場合（旧ソケットのcloseが届かない等）、
			// 古いセッションに固着したままだと新しい接続のhelloを永久に復号失敗で無視し続けて
			// モバイルが二度と接続できなくなるため、セッションを破棄してhelloとして処理し直す。
			if (payload.length === 32 && this.channel !== undefined) {
				this.logService.info(`[paradisMobileRelay] session ${this.mobileId}: undecryptable 32B payload; treating as new hello (session reset)`);
				this.channel = undefined;
				this.mux = undefined;
				this.confirmed = false;
				this.negotiatedProtocolVersion = undefined;
				this.pendingVerify = undefined;
				this.stateDelivery.reset();
				await this.handlePayload(payload);
				return;
			}
			this.logService.warn(`[paradisMobileRelay] session ${this.mobileId} error`, err);
		}
	}

	private pendingVerify: ((confirm: Uint8Array) => Promise<void>) | undefined;

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
		return this.stateDelivery.deliver(payload, force, state => mux.send(Channels.State, state));
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

	private readonly _onInboundFrame = this._register(new Emitter<ParadisMobileInboundFrameWire>());
	readonly onInboundFrame = this._onInboundFrame.event;

	private readonly _onDidChangeConfirmedAgentPanes = this._register(new Emitter<IParadisConfirmedAgentPanes>());
	readonly onDidChangeConfirmedAgentPanes = this._onDidChangeConfirmedAgentPanes.event;
	private readonly _onDidRequestAgentPaneSync = this._register(new Emitter<IParadisMobileWindowLease>());
	readonly onDidRequestAgentPaneSync = this._onDidRequestAgentPaneSync.event;
	private confirmedAgentPanes: IParadisConfirmedAgentPanes = { revision: 0, tokens: [] };

	private state: PersistedState = { mobiles: [] };
	private identity: MobileIdentity | undefined;
	private enabled = false;
	private connectionState: ParadisMobileConnectionState = 'disabled';

	private socket: WebSocket | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectAttempt = 0;
	private readonly sessions = new Map<string, MobileSession>();
	private readonly terminalRegistry = new ParadisMobileTerminalRegistry();
	private readonly terminalOperations = new ParadisMobileOperationLedger();
	private readonly agentCommandAuthority = new ParadisAgentCommandAuthority();
	private readonly terminalOperationTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly webrtcRendererLeases = new Map<string, { readonly sid: string; readonly owner: IParadisMobileWindowLeaseRef }>();
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

	// para-browser の CDP screencast ミラー（設計書 M3、browser チャネル）
	private readonly browserMirror: ParadisMobileBrowserMirror;

	// エージェントセッションのチャットミラー（agentチャネル）。transcript の tail は
	// ファイルI/O・hookバス購読とも shared process 側の仕事なのでここで直接処理する
	// （browser チャネルと同じ方針。renderer は経由しない）。
	private readonly agentChat: ParadisMobileAgentChat;
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
	) {
		super();
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
		this.browserMirror = this._register(new ParadisMobileBrowserMirror(new ParadisCdpUpstream(this.userDataPath, this.logService), cdpFrames, sharedPageBindings, this.logService));
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
			token => paradisCodexPaneSocketPath(this.userDataPath, token),
			owner => this.withCurrentRegisteredLease(owner, async () => true).then(result => result === true, () => false),
			owner => this._onDidRequestAgentPaneSync.fire({
				windowId: owner.windowId,
				windowSession: owner.windowSession,
				rendererGeneration: owner.rendererGeneration,
			}),
			agentSessionStore,
		));
		this._register(toDisposable(() => { void agentSessionStore.flush(); }));
		this._register(this.agentChat.onDidChangeConfirmedAgentPanes(tokens => {
			this.confirmedAgentPanes = { revision: this.confirmedAgentPanes.revision + 1, tokens };
			this._onDidChangeConfirmedAgentPanes.fire(this.confirmedAgentPanes);
		}));
		// PC側でペインを確認済みにした（フォーカス中の自動既読 or ターミナルを開いての手動既読）
		// ときも、モバイル側の通知履歴から対応する通知を消す（M起点のdismissと同じ配送経路）。
		if (this.sharedPageBindings) {
			this._register(this.sharedPageBindings.onDidAcknowledgePane(token => this.dispatchAgentDismiss(token)));
		}
		this._register(this.windowLeaseClient.onDidChangeManifest(manifest => {
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
		this.updateEagerTailing();
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
		this.updateEagerTailing();
	}

	/** リレー有効 かつ ペアリング済みモバイルが1台以上あるときだけ、質問検出用の常時tailを回す。 */
	private updateEagerTailing(): void {
		this.agentChat.setEagerTailing(this.enabled && this.state.mobiles.length > 0);
	}

	/** transcript に現れた質問を Notify として全モバイルへ届ける（オフラインへはAPNsプッシュ）。 */
	private notifyAgentQuestion(info: { terminalId: number; agent: 'claude' | 'codex'; text: string; header?: string; ws?: string; agentToken: string; owner: IParadisMobilePaneOwner }): void {
		// 通知はプレビュー用途なので本文を短く切る。長文のまま封緘するとAPNsの4KB制限
		// （リレー側の3800B上限チェック）を超え、アプリ未起動時のプッシュだけがサイレントに
		// 落ちる（全文はチャット画面が別経路で同期する）。700字 = 日本語でもUTF-8で約2.1KB、
		// JSON+GCMタグ+base64url(×1.33)を足しても3800Bに収まる。
		// allow-any-unicode-next-line
		const body = info.text.length > 700 ? `${info.text.slice(0, 700)}…` : info.text;
		const terminal = this.terminalRegistry.desktopState().terminals.find(candidate => candidate.agentToken === info.agentToken);
		const payload: NotifyPayload = {
			kind: 'agent-question',
			id: `q${generateUuid()}`,
			// allow-any-unicode-next-line
			title: info.header !== undefined && info.header.length > 0 ? `質問: ${info.header}` : 'エージェントからの質問',
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
	 * - オンライン: 通常のE2Eフレーム（アプリ内でローカル通知として表示される）
	 * - オフライン（アプリ未起動/バックグラウンドでWS切断中）: 通知鍵で封緘した暗号文を
	 *   push-notify 制御メッセージでリレーへ渡し、リレーがAPNsへフォールバック配送する。
	 *   リレー/APNsに見えるのは「通知が発生した」ことだけで、本文はiOSのNotification
	 *   Service Extension が復号する（設計書 §5.2）。
	 */
	private dispatchNotify(bytes: Uint8Array, expectedOwner?: IParadisMobileWindowLease): void {
		if (expectedOwner !== undefined) {
			this.withCurrentRegisteredLease(expectedOwner, async () => this.dispatchNotifyNow(bytes, expectedOwner))
				.catch(error => this.logService.warn('[paradisMobileRelay] notify owner validation failed', error));
			return;
		}
		this.dispatchNotifyNow(bytes);
	}

	private dispatchNotifyNow(bytes: Uint8Array, expectedOwner?: IParadisMobileWindowLease): void {
		// APNs抑制判定用に種別だけ覗く（形式不正なら抑制せず送る側に倒す）
		const kind = peekNotifyKind(bytes);
		// PCフォーカス中の抑制は「作業の進捗（完了/質問）を今PCで見ているなら通知不要」という
		// 意図のため、エラー・切断系（現状は将来拡張用に型があるのみで未実装）には適用しない。
		const focusSuppressible = kind === 'agent-done' || kind === 'agent-question';
		const focusSuppressed = focusSuppressible && this.pcFocused;
		for (const mobile of this.state.mobiles) {
			// PCフォーカス中はそもそも配信しない（suppressWhenPcFocused）。オンライン/オフライン
			// どちらの経路も対象: 対応済みの通知が後からモバイルの通知一覧に残り続ける問題
			// （dismissed-token同期は「PC側で確認した」ケースのみをカバーする）を、配信自体を
			// 止めることで避ける。
			if (focusSuppressed && mobile.notifyPrefs?.suppressWhenPcFocused === true) {
				continue;
			}
			const session = this.sessions.get(mobile.mobileId);
			if (session?.hasCurrentProtocol) {
				session.sendFrame(Channels.Notify, undefined, bytes).catch(err => this.logService.warn('[paradisMobileRelay] notify frame failed', err));
				continue;
			}
			// オフライン時のAPNsフォールバックは、モバイルが同期してきた通知設定を尊重する
			// （オンライン時のフレームは常に送る: 表示可否はモバイル側が判断する）。
			const prefs = mobile.notifyPrefs;
			if (prefs && ((kind === 'agent-done' && prefs.agentDone === false) || (kind === 'agent-question' && prefs.agentQuestion === false))) {
				continue;
			}
			this.notifyKeyFor(mobile.mobileId, mobile.pubKey).then(async key => {
				const sealed = await sealNotify(key, bytes);
				if (expectedOwner !== undefined) {
					await this.withCurrentRegisteredLease(expectedOwner, async () => {
						this.sendControl({ type: 'push-notify', mobileId: mobile.mobileId, payload: toBase64Url(sealed) });
					});
				} else {
					this.sendControl({ type: 'push-notify', mobileId: mobile.mobileId, payload: toBase64Url(sealed) });
				}
			}).catch(err => this.logService.warn('[paradisMobileRelay] push-notify seal failed', err));
		}
	}

	/** モバイルから同期された通知設定（notifyチャネル M→PC）を保存する。 */
	private handleNotifyPrefs(mobileId: string, payload: Uint8Array): void {
		try {
			const msg = JSON.parse(new TextDecoder().decode(payload)) as { t?: string; agentDone?: boolean; agentQuestion?: boolean; suppressWhenPcFocused?: boolean };
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
				suppressWhenPcFocused: msg.suppressWhenPcFocused === true,
			};
			// モバイルはonline遷移のたびに再送してくるため、値が変わった時だけ書き込む
			// （バックグラウンド復帰ごとのディスク書き込みチャーンを避ける）。
			const prev = mobile.notifyPrefs;
			if (prev && prev.agentDone === next.agentDone && prev.agentQuestion === next.agentQuestion && prev.suppressWhenPcFocused === next.suppressWhenPcFocused) {
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
		const bytes = encodeNotifyDismissedByToken(token);
		for (const mobile of this.state.mobiles) {
			const session = this.sessions.get(mobile.mobileId);
			if (session?.hasCurrentProtocol) {
				session.sendFrame(Channels.Notify, undefined, bytes).catch(err => this.logService.warn('[paradisMobileRelay] agent dismiss forward failed', err));
			}
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
			this.browserMirror.stopSession(m.mobileId);
			this.agentChat.dropSubscriber(m.mobileId);
			this.notifyKeyCache.delete(m.mobileId);
			void this.revokeOnRelay(m.mobileId);
		}
		this._onDidChangeStatus.fire(this.snapshot());
	}

	/**
	 * scmチャネル用のgit実行。サブコマンドを許可リストで制限し、オプション経由の
	 * 任意コマンド実行（--upload-pack等）を防ぐため各引数も検査する。
	 */
	async runGit(repoPath: string, args: readonly string[]): Promise<IParadisGitResult> {
		const ALLOWED_SUBCOMMANDS = new Set(['status', 'diff', 'add', 'commit', 'log', 'rev-parse', 'branch', 'restore', 'remote', 'show']);
		if (args.length === 0 || !ALLOWED_SUBCOMMANDS.has(args[0])) {
			throw new Error(`paradisMobileRelay: git subcommand not allowed: ${args[0] ?? '(none)'}`);
		}
		// 外部コマンド実行やリポジトリ差し替えに繋がるオプションを拒否
		const FORBIDDEN = /^--(upload-pack|receive-pack|exec|git-dir|work-tree|config-env)\b|^-c$|^-C$/;
		for (const a of args) {
			if (FORBIDDEN.test(a)) {
				throw new Error(`paradisMobileRelay: git argument not allowed: ${a}`);
			}
		}
		const { execFile } = await import('child_process');
		// core.quotepath=false: 既定では非ASCIIパスが八進エスケープ+引用符("\345...")で
		// 出力され、モバイルのソース管理タブで文字化け表示になるため無効化する。
		return new Promise<IParadisGitResult>(resolve => {
			execFile('git', ['-C', repoPath, '-c', 'core.quotepath=false', ...args], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
				const rawCode: unknown = err ? (err as NodeJS.ErrnoException & { code?: unknown }).code ?? 1 : 0;
				resolve({ code: typeof rawCode === 'number' ? rawCode : 1, stdout: String(stdout), stderr: String(stderr) });
			});
		});
	}

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

	async notifyAgentTerminalHint(lease: IParadisMobileWindowLease, terminalId: number, hint: { readonly elapsedSeconds?: number; readonly tokenCount?: number }): Promise<void> {
		await this.withCurrentRegisteredLease(lease, async () => this.agentChat.onTerminalHint(lease.windowId, lease.windowSession, lease.rendererGeneration, terminalId, hint));
	}

	/** fsチャネル用: ripgrepによるファイル名検索（rendererはプロセスを起動できないためここで実行）。 */
	async searchFiles(rootPath: string, query: string, maxResults: number): Promise<IParadisFileSearchResult> {
		return paradisSearchFiles(rootPath, query, Math.min(Math.max(1, maxResults), 500), this.logService);
	}

	/** fsチャネル用: ripgrepによるテキスト全文検索。 */
	async searchText(rootPath: string, query: string, maxResults: number): Promise<IParadisTextSearchResult> {
		return paradisSearchText(rootPath, query, Math.min(Math.max(1, maxResults), 500), this.logService);
	}

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

	private broadcastDesktopState(mobileId?: string, suppliedManifest?: IParadisMobileRendererManifest): Promise<void> {
		const run = this.desktopStateBroadcastChain.then(async () => {
			try {
				const manifest = suppliedManifest ?? await this.windowLeaseClient.manifest();
				for (const removed of this.terminalRegistry.reconcile(manifest)) {
					this.cleanupRemovedRenderer(removed);
				}
			} catch (error) {
				this.logService.warn('[paradisMobileRelay] failed to read Renderer lease manifest', error);
				return;
			}
			const state = this.terminalRegistry.desktopState();
			const bytes = new TextEncoder().encode(JSON.stringify(state));
			if (mobileId !== undefined) {
				const session = this.sessions.get(mobileId);
				if (session?.isOnline) {
					await session.sendDesktopState(bytes, true);
				}
				return;
			}
			for (const session of this.sessions.values()) {
				if (session.isOnline) {
					await session.sendDesktopState(bytes, false);
				}
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
			// PC自身のリレーWSが切れた場合も、presence offline経路と同じ3点セットで
			// per-mobileリソース（browserMirrorのcaptureTimer/上流CDPソケット、agentChatの購読）を解放する。
			for (const id of this.sessions.keys()) {
				this.browserMirror.stopSession(id);
				this.agentChat.dropSubscriber(id);
			}
			this.sessions.clear();
			this.webrtcRendererLeases.clear();
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
		// onclose と同様、セッション破棄前に per-mobile リソースを解放する。
		for (const id of this.sessions.keys()) {
			this.browserMirror.stopSession(id);
			this.agentChat.dropSubscriber(id);
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
						// WebRTCシグナリング（t: 'webrtc-*'）は renderer のストリーマが処理する
						// （WebRTCスタックはrendererにしか無い）。offer は getDisplayMedia が
						// 対象ビュー単体を返すよう electron-main を先に arm してから転送する。
						const webrtc = this.peekWebrtcSignal(frame.payload.buffer);
						if (webrtc !== undefined) {
							this.forwardWebrtcSignal(idStr, frame, webrtc).catch(err => this.logService.warn('[paradisMobileRelay] webrtc routing failed', err));
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
		}
	}

	/**
	 * browser チャネルのペイロードが WebRTC シグナリング（t: 'webrtc-*'）なら
	 * そのJSONを返す。違えば undefined（既存の browserMirror が処理する）。
	 */
	private peekWebrtcSignal(payload: Uint8Array): { t: 'webrtc-offer' | 'webrtc-ice' | 'webrtc-stop'; targetId?: unknown; sid?: unknown; id?: unknown } | undefined {
		try {
			const msg = JSON.parse(new TextDecoder().decode(payload)) as { t?: unknown; targetId?: unknown; sid?: unknown; id?: unknown };
			if (msg.t === 'webrtc-offer' || msg.t === 'webrtc-ice' || msg.t === 'webrtc-stop') {
				return msg as { t: 'webrtc-offer' | 'webrtc-ice' | 'webrtc-stop'; targetId?: unknown; sid?: unknown; id?: unknown };
			}
		} catch { /* JSONでないペイロードは既存処理へ */ }
		return undefined;
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
		if (msg.type === 'pairing-msg' && typeof msg.data === 'string') {
			await this.onPairingMessage(msg.data, msg.pairId);
		} else if (msg.type === 'paired' && typeof msg.mobileId === 'string' && msg.mobileId.length > 0) {
			await this.onPaired(msg.mobileId);
		} else if (msg.type === 'presence' && msg.peer === 'mobile' && typeof msg.mobileId === 'string') {
			// モバイルが切断/再接続したら、そのmobileIdの確立済みセッションを破棄する。
			// これをしないと、再接続時のモバイルの新しい hello を確立済みセッションが
			// アプリフレーム扱いして復号失敗し、恒久的に通信不能になる（H-3）。
			if (!msg.online) {
				this.sessions.delete(msg.mobileId);
				this.webrtcRendererLeases.delete(msg.mobileId);
				this.browserMirror.stopSession(msg.mobileId);
				this.agentChat.dropSubscriber(msg.mobileId);
				this._onDidChangeStatus.fire(this.snapshot());
			}
		} else if (msg.type === 'mobile-revoked' && typeof msg.mobileId === 'string') {
			await this.onMobileRevoked(msg.mobileId);
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
		this.notifyKeyCache.delete(mobileId);
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
