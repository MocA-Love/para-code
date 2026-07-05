// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * アプリ全体で共有する MobileController と接続状態の Zustand ストア。
 * 画面（screens）はここから状態を購読し、コントローラ経由で操作する。
 */

import { create } from 'zustand';
import type { Identity, PairingPayload } from '@para/protocol';
import { decodePairingUri } from '@para/protocol';
import { MobileController, loadCredentials, loadOrCreateIdentity, saveCredentials, type BrowserTargetsResult, type FsListResult, type FsReadResult, type ScmCommitResult, type ScmDiffResult, type ScmLogResult, type ScmStatusResult, type StoreState } from './store.js';
import { PairingClient } from './pairingClient.js';
import type { PairedCredentials } from './relayClient.js';
import { configureNotificationHandler, ensureNotificationPermission, presentLocalNotification, rnSocketFactory, secureKeyStore } from './platform.js';

interface AppState extends StoreState {
	ready: boolean;
	paired: boolean;
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
	attachTerminal(id: number): void;
	detachTerminal(id: number): void;
	sendInput(id: number, data: string): void;
	createTerminal(ws?: string): void;
	scmStatus(ws: string): Promise<ScmStatusResult>;
	scmDiff(ws: string, path?: string, staged?: boolean): Promise<ScmDiffResult>;
	scmCommit(ws: string, message: string, all: boolean): Promise<ScmCommitResult>;
	scmLog(ws: string): Promise<ScmLogResult>;
	fsList(ws: string, path: string): Promise<FsListResult>;
	fsRead(ws: string, path: string, highlight?: boolean): Promise<FsReadResult>;
	browserTargets(): Promise<BrowserTargetsResult>;
	browserStart(targetId: string): Promise<void>;
	browserStop(): Promise<void>;
	browserInput(input: { kind: 'tap' | 'scroll' | 'back' | 'forward' | 'reload' | 'text'; nx?: number; ny?: number; dy?: number; text?: string }): void;
}

let identity: Identity | undefined;
let controller: MobileController | undefined;

export const useAppStore = create<AppState>(set => ({
	connection: 'offline',
	pcOnline: false,
	workspace: undefined,
	terminalOutput: new Map(),
	notifications: [],
	browserFrame: undefined,
	ready: false,
	paired: false,
	selectedWs: undefined,
	selectedTerminalId: undefined,

	async init() {
		configureNotificationHandler();
		const loaded = await loadOrCreateIdentity(secureKeyStore);
		identity = loaded.identity;
		controller = new MobileController(
			identity,
			rnSocketFactory,
			s => set({ ...s }),
			payload => { void presentLocalNotification(payload.title, payload.body, { ws: payload.ws, terminalId: payload.terminalId }); },
		);
		const creds = await loadCredentials(secureKeyStore);
		set({ ready: true, paired: !!creds });
		if (creds) {
			ensureNotificationPermission().catch(err => console.warn('[appState] notification permission request failed', err));
			controller.connect(creds);
		}
	},

	async pairFromUri(uri: string, deviceName: string, onSas: (code: string) => void) {
		if (!identity) {
			throw new Error('not initialized');
		}
		const payload: PairingPayload = decodePairingUri(uri);
		const pairing = new PairingClient(identity, deviceName, rnSocketFactory);
		const creds: PairedCredentials = await pairing.pair(payload, { onSasCode: onSas });
		await saveCredentials(secureKeyStore, creds);
		set({ paired: true });
		controller?.connect(creds);
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

	scmLog(ws: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.scmLog(ws);
	},

	fsList(ws: string, path: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.fsList(ws, path);
	},

	fsRead(ws: string, path: string, highlight?: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.fsRead(ws, path, highlight);
	},

	browserTargets() {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.browserTargets();
	},

	browserStart(targetId: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.browserStart(targetId);
	},

	browserStop() {
		return controller?.browserStop() ?? Promise.resolve();
	},

	browserInput(input) {
		controller?.browserInput(input);
	},
}));
