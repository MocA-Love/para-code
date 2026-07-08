// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * アプリ全体で共有する MobileController と接続状態の Zustand ストア。
 * 画面（screens）はここから状態を購読し、コントローラ経由で操作する。
 */

import { AppState as RNAppState } from 'react-native';
import { create } from 'zustand';
import type { Identity, PairingPayload } from '@para/protocol';
import { decodePairingUri } from '@para/protocol';
import { MobileController, clearCredentials, loadCredentials, loadOrCreateIdentity, revokeSelfOnRelay, saveCredentials, type BrowserTargetsResult, type FsDocxResult, type FsFindResult, type FsMediaResult, type FsGrepResult, type FsListResult, type FsUploadResult, type FsPdfResult, type FsReadResult, type FsXlsxResult, type ScmCommitFilesResult, type ScmCommitResult, type ScmDiffResult, type ScmLogResult, type ScmStatusResult, type ScmXlsxDiffResult, type StoreState } from './store.js';
import { PairingClient } from './pairingClient.js';
import type { PairedCredentials } from './relayClient.js';
import { configureNotificationHandler, ensureNotificationPermission, getApnsDeviceToken, persistNotifyKey, presentLocalNotification, rnSocketFactory, secureKeyStore } from './platform.js';

interface AppState extends StoreState {
	ready: boolean;
	paired: boolean;
	/** ユーザーがホームの切断ボタンで明示的に切断した状態（自動再接続を抑止）。 */
	manualOffline: boolean;
	/** リレー接続を手動で切断する。 */
	disconnectRelay(): void;
	/** 手動切断後に接続し直す（未接続で固まっている場合の再接続にも使える）。 */
	connectRelay(): void;
	/** ワークスペースバーで選択中のワークスペースID（全画面で連動）。 */
	selectedWs: string | undefined;
	setSelectedWs(ws: string): void;
	/** ターミナル画面で選択中のターミナルID（ws切替時はリセット）。 */
	selectedTerminalId: number | undefined;
	setSelectedTerminalId(id: number | undefined): void;
	/** 初期化（起動時に1回）。identityをロードし、資格情報があれば接続する。 */
	init(): Promise<void>;
	/** QRから読み取ったURIでペアリングする。SAS表示はonSasで受ける。 */
	pairFromUri(uri: string, deviceName: string, onSas: (code: string) => void): Promise<void>;
	/** 進行中のペアリングを中断する（ペアリング画面から離脱したとき等）。 */
	cancelPairing(): void;
	/** ペアリングを完全に解除する（リレー上の資格情報も失効させ、ローカルの保存分も削除する）。 */
	unpair(): Promise<void>;
	attachTerminal(id: number): void;
	detachTerminal(id: number): void;
	sendInput(id: number, data: string): void;
	createTerminal(ws?: string): void;
	attachAgent(id: number): void;
	detachAgent(id: number): void;
	refreshAgent(id: number): void;
	scmStatus(ws: string): Promise<ScmStatusResult>;
	scmDiff(ws: string, path?: string, staged?: boolean): Promise<ScmDiffResult>;
	scmCommit(ws: string, message: string, all: boolean): Promise<ScmCommitResult>;
	scmLog(ws: string, opts?: { limit?: number; skip?: number }): Promise<ScmLogResult>;
	scmCommitFiles(ws: string, hash: string): Promise<ScmCommitFilesResult>;
	fsList(ws: string, path: string): Promise<FsListResult>;
	fsRead(ws: string, path: string, highlight?: boolean): Promise<FsReadResult>;
	fsXlsx(ws: string, path: string, sheet?: number): Promise<FsXlsxResult>;
	fsPdf(ws: string, path: string): Promise<FsPdfResult>;
	fsDocx(ws: string, path: string): Promise<FsDocxResult>;
	fsMedia(ws: string, path: string): Promise<FsMediaResult>;
	fsFind(ws: string, query: string): Promise<FsFindResult>;
	fsGrep(ws: string, query: string): Promise<FsGrepResult>;
	fsUpload(name: string, dataBase64: string): Promise<FsUploadResult>;
	scmXlsxDiff(ws: string, path: string): Promise<ScmXlsxDiffResult>;
	browserTargets(): Promise<BrowserTargetsResult>;
	browserStart(targetId: string): Promise<void>;
	/** keepFrame=true で最後のフレームを残したまま停止する（タブblur時の一時停止用）。 */
	browserStop(keepFrame?: boolean): Promise<void>;
	browserInput(input: { kind: 'tap' | 'scroll' | 'back' | 'forward' | 'reload' | 'text'; nx?: number; ny?: number; dy?: number; text?: string }): void;
}

let identity: Identity | undefined;
let controller: MobileController | undefined;
/** 進行中のペアリングクライアント（cancelPairing で中断するため保持）。 */
let pairing: PairingClient | undefined;
/** init() の二重実行防止（Fast Refresh 等での再マウント対策）。同期的に立てて async 再入も弾く。 */
let initStarted = false;

export const useAppStore = create<AppState>(set => ({
	connection: 'offline',
	pcOnline: false,
	workspace: undefined,
	terminalOutput: new Map(),
	notifications: [],
	browserFrame: undefined,
	agentChats: new Map(),
	ready: false,
	paired: false,
	manualOffline: false,
	selectedWs: undefined,
	selectedTerminalId: undefined,

	async init() {
		// 二重初期化を防ぐ。放置すると旧 MobileController/RelayClient が close されず、
		// 新旧2つが同じ set() へ state を書き込んで表示が競合し、AppState リスナも蓄積する。
		if (initStarted) {
			return;
		}
		initStarted = true;
		try {
			configureNotificationHandler();
			const loaded = await loadOrCreateIdentity(secureKeyStore);
			identity = loaded.identity;
			controller = new MobileController(
				identity,
				rnSocketFactory,
				s => set({ ...s }),
				payload => { void presentLocalNotification(payload.title, payload.body, { ws: payload.ws, terminalId: payload.terminalId }); },
				getApnsDeviceToken,
				// 開発ビルド(expo run:ios)は aps-environment=development なので sandbox APNs 宛に登録する
				__DEV__ ? 'dev' : 'prod',
				persistNotifyKey,
			);
			// フォアグラウンド復帰時、接続が死んでいたら即座に繋ぎ直す（iOSはバックグラウンドで
			// ソケットが黙って死ぬため、これが無いと再起動/復帰後に繋がらないことがある）。
			// 加えてフォアグラウンド中は定期ハートビート（state要求+生存確認）を回す。
			// WSにはping/pongが無く「送信して初めて切断に気づく」ため、放置中に接続が
			// 静かに死ぬと『接続しています…』のまま固まって見える問題への対策。
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			const startHeartbeat = () => {
				stopHeartbeat();
				heartbeat = setInterval(() => {
					if (!useAppStore.getState().manualOffline) {
						controller?.ensureConnected();
					}
				}, 25_000);
			};
			const stopHeartbeat = () => {
				if (heartbeat !== undefined) {
					clearInterval(heartbeat);
					heartbeat = undefined;
				}
			};
			RNAppState.addEventListener('change', appState => {
				if (appState === 'active') {
					if (!useAppStore.getState().manualOffline) {
						controller?.ensureConnected();
					}
					startHeartbeat();
				} else {
					// バックグラウンドではタイマーを止める（バッテリー対策。iOSはいずれにせよ
					// バックグラウンドのJSタイマーを止めるが、明示しておく）
					stopHeartbeat();
				}
			});
			startHeartbeat();
			const creds = await loadCredentials(secureKeyStore);
			set({ ready: true, paired: !!creds });
			if (creds) {
				ensureNotificationPermission().catch(err => console.warn('[appState] notification permission request failed', err));
				controller.connect(creds);
			}
		} catch (err) {
			// 一過性の失敗（KeyStore読み取り等）で ready:false に張り付かないよう、
			// 次回の init() で再試行できるようにガードを戻す（特に dev の Fast Refresh は
			// モジュール状態が保持されるため、戻さないと復帰不能になる）。
			initStarted = false;
			throw err;
		}
	},

	disconnectRelay() {
		set({ manualOffline: true });
		controller?.disconnect();
	},

	connectRelay() {
		set({ manualOffline: false });
		controller?.reconnect();
	},

	async pairFromUri(uri: string, deviceName: string, onSas: (code: string) => void) {
		if (!identity) {
			throw new Error('not initialized');
		}
		const payload: PairingPayload = decodePairingUri(uri);
		// 直前のペアリングが残っていれば畳んでから開始する。
		pairing?.cancel();
		const client = new PairingClient(identity, deviceName, rnSocketFactory);
		pairing = client;
		try {
			const creds: PairedCredentials = await client.pair(payload, { onSasCode: onSas });
			await saveCredentials(secureKeyStore, creds);
			set({ paired: true });
			controller?.connect(creds);
		} finally {
			if (pairing === client) {
				pairing = undefined;
			}
		}
	},

	cancelPairing() {
		pairing?.cancel();
		pairing = undefined;
	},

	async unpair() {
		const creds = await loadCredentials(secureKeyStore);
		// 先にリレー側の資格情報を失効させる（WebSocketとは独立したHTTPなので接続状態に依らず
		// 送れる）。失敗してもローカル解除は続行する: トークン実体はこの端末にしか無いため、
		// リレーに残っても悪用はできず、PC側の失効操作でも掃除できる。
		if (creds) {
			await revokeSelfOnRelay(creds);
		}
		controller?.reset();
		await clearCredentials(secureKeyStore);
		set({ paired: false, manualOffline: false, selectedWs: undefined, selectedTerminalId: undefined });
	},

	attachTerminal(id: number) {
		controller?.attachTerminal(id);
	},

	detachTerminal(id: number) {
		controller?.detachTerminal(id);
	},

	sendInput(id: number, data: string) {
		controller?.sendInput(id, data);
	},

	createTerminal(ws?: string) {
		controller?.createTerminal(ws);
	},

	attachAgent(id: number) {
		controller?.attachAgent(id);
	},

	detachAgent(id: number) {
		controller?.detachAgent(id);
	},

	refreshAgent(id: number) {
		controller?.refreshAgent(id);
	},

	setSelectedWs(ws: string) {
		set({ selectedWs: ws, selectedTerminalId: undefined });
	},

	setSelectedTerminalId(id: number | undefined) {
		set({ selectedTerminalId: id });
	},

	scmStatus(ws: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.scmStatus(ws);
	},

	scmDiff(ws: string, path?: string, staged?: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.scmDiff(ws, path, staged);
	},

	scmCommit(ws: string, message: string, all: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.scmCommit(ws, message, all);
	},

	scmLog(ws: string, opts?: { limit?: number; skip?: number }) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.scmLog(ws, opts);
	},

	scmCommitFiles(ws: string, hash: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.scmCommitFiles(ws, hash);
	},

	fsList(ws: string, path: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.fsList(ws, path);
	},

	fsRead(ws: string, path: string, highlight?: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.fsRead(ws, path, highlight);
	},

	fsXlsx(ws: string, path: string, sheet?: number) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.fsXlsx(ws, path, sheet);
	},

	fsPdf(ws: string, path: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.fsPdf(ws, path);
	},

	fsDocx(ws: string, path: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.fsDocx(ws, path);
	},

	fsMedia(ws: string, path: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.fsMedia(ws, path);
	},

	fsFind(ws: string, query: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.fsFind(ws, query);
	},

	fsGrep(ws: string, query: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.fsGrep(ws, query);
	},

	fsUpload(name: string, dataBase64: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.fsUpload(name, dataBase64);
	},

	scmXlsxDiff(ws: string, path: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.scmXlsxDiff(ws, path);
	},

	browserTargets() {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.browserTargets();
	},

	browserStart(targetId: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.browserStart(targetId);
	},

	browserStop(keepFrame?: boolean) {
		return controller?.browserStop(keepFrame) ?? Promise.resolve();
	},

	browserInput(input) {
		controller?.browserInput(input);
	},
}));
