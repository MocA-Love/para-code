// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * アプリ全体で共有する MobileController と接続状態の Zustand ストア。
 * 画面（screens）はここから状態を購読し、コントローラ経由で操作する。
 */

import { create } from 'zustand';
import type { Identity, PairingPayload } from '@para/protocol';
import { decodePairingUri } from '@para/protocol';
import { MobileController, loadCredentials, loadOrCreateIdentity, saveCredentials, type StoreState } from './store.js';
import { PairingClient } from './pairingClient.js';
import type { PairedCredentials } from './relayClient.js';
import { ensureNotificationPermission, presentLocalNotification, rnSocketFactory, secureKeyStore } from './platform.js';

interface AppState extends StoreState {
	ready: boolean;
	paired: boolean;
	/** 初期化（起動時に1回）。identityをロードし、資格情報があれば接続する。 */
	init(): Promise<void>;
	/** QRから読み取ったURIでペアリングする。SAS表示はonSasで受ける。 */
	pairFromUri(uri: string, deviceName: string, onSas: (code: string) => void): Promise<void>;
	attachTerminal(id: number): void;
	sendInput(id: number, data: string): void;
}

let identity: Identity | undefined;
let controller: MobileController | undefined;

export const useAppStore = create<AppState>(set => ({
	connection: 'offline',
	pcOnline: false,
	workspace: undefined,
	terminalOutput: new Map(),
	notifications: [],
	ready: false,
	paired: false,

	async init() {
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
			void ensureNotificationPermission();
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

	sendInput(id: number, data: string) {
		controller?.sendInput(id, data);
	},
}));
