// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルアプリの状態ストア（UI非依存の中核）。RelayClient/PairingClient を束ね、
 * PCから届く state スナップショットと接続状態を保持する。Zustand から購読する。
 *
 * 永続化（identity/credentials）は KeyStore インターフェースで注入する
 * （本番は expo-secure-store、テストはメモリ実装）。
 */

import { type Frame, type Identity, type NotifyPayload, decodeNotify, generateIdentity } from '@para/protocol';
import { RelayClient, type ConnectionState, type PairedCredentials, type SocketFactory } from './relayClient.js';

/** PCから届くワークスペース状態（stateチャネルのJSON）。 */
export interface WorkspaceState {
	activeWs: string | undefined;
	workspaces: { id: string; name: string; color?: string; branch?: string }[];
	terminals: { id: number; title: string; ws?: string; agentStatus?: string }[];
}

/** scm status 応答。 */
export interface ScmStatusResult {
	branch: string;
	files: { x: string; y: string; path: string }[];
}
/** scm diff 応答。 */
export interface ScmDiffResult {
	diff: string;
}
/** scm log 応答。 */
export interface ScmLogResult {
	commits: { hash: string; when: string; subject: string }[];
}
/** scm commit 応答。 */
export interface ScmCommitResult {
	output: string;
}
/** fs list 応答。 */
export interface FsListResult {
	entries: { name: string; dir: boolean; size?: number }[];
}
/** fs read 応答。 */
export interface FsReadResult {
	content: string;
	truncated: boolean;
	size: number;
}

/** browser targets 応答。 */
export interface BrowserTargetsResult {
	targets: { targetId: string; title: string; url: string }[];
}
/** browser の直近 screencast フレーム。 */
export interface BrowserFrame {
	/** JPEG の base64。 */
	data: string;
	w: number;
	h: number;
}

/** 秘密情報の永続化。 */
export interface KeyStore {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	deleteItem(key: string): Promise<void>;
}

export interface StoreState {
	connection: ConnectionState;
	pcOnline: boolean;
	workspace: WorkspaceState | undefined;
	/** ターミナルID → 受信済み出力（末尾のみ保持）。 */
	terminalOutput: Map<number, string>;
	/** 受信した通知（新しい順、最大50件）。 */
	notifications: NotifyPayload[];
	/** browser ミラーの直近フレーム（未開始は undefined）。 */
	browserFrame: BrowserFrame | undefined;
}

const IDENTITY_KEY = 'para.identity';
const CREDS_KEY = 'para.credentials';
const MAX_TERM_BUFFER = 200_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** identity を KeyStore から読み込む。無ければ生成して保存する。 */
export async function loadOrCreateIdentity(keyStore: KeyStore): Promise<{ identity: Identity; created: boolean }> {
	const raw = await keyStore.getItem(IDENTITY_KEY);
	if (raw) {
		const parsed = JSON.parse(raw) as { pub: string; sec: string };
		return {
			identity: {
				publicKey: fromB64(parsed.pub),
				secretKey: fromB64(parsed.sec),
			},
			created: false,
		};
	}
	const identity = generateIdentity();
	await keyStore.setItem(IDENTITY_KEY, JSON.stringify({ pub: toB64(identity.publicKey), sec: toB64(identity.secretKey) }));
	return { identity, created: true };
}

export async function loadCredentials(keyStore: KeyStore): Promise<PairedCredentials | undefined> {
	const raw = await keyStore.getItem(CREDS_KEY);
	if (!raw) {
		return undefined;
	}
	const p = JSON.parse(raw) as { relayUrl: string; deviceId: string; mobileId: string; mobileToken: string; pcPublicKey: string };
	return { relayUrl: p.relayUrl, deviceId: p.deviceId, mobileId: p.mobileId, mobileToken: p.mobileToken, pcPublicKey: fromB64(p.pcPublicKey) };
}

export async function saveCredentials(keyStore: KeyStore, creds: PairedCredentials): Promise<void> {
	await keyStore.setItem(CREDS_KEY, JSON.stringify({
		relayUrl: creds.relayUrl,
		deviceId: creds.deviceId,
		mobileId: creds.mobileId,
		mobileToken: creds.mobileToken,
		pcPublicKey: toB64(creds.pcPublicKey),
	}));
}

/**
 * 接続と受信フレームを状態に反映するコントローラ。UIフレームワーク非依存で、
 * onChange コールバックで購読側（Zustand set 等）へ通知する。
 */
export class MobileController {
	private client: RelayClient | undefined;
	readonly state: StoreState = {
		connection: 'offline',
		pcOnline: false,
		workspace: undefined,
		terminalOutput: new Map(),
		notifications: [],
		browserFrame: undefined,
	};

	constructor(
		private readonly identity: Identity,
		private readonly socketFactory: SocketFactory,
		private readonly onChange: (state: StoreState) => void,
		/** 通知受信時のフック（expo-notifications によるローカル通知表示など）。 */
		private readonly onNotify?: (payload: NotifyPayload) => void,
	) { }

	connect(creds: PairedCredentials): void {
		this.client?.close();
		this.client = new RelayClient(this.identity, creds, this.socketFactory, {
			onStateChange: s => { this.state.connection = s; this.emit(); },
			onPcPresence: online => { this.state.pcOnline = online; this.emit(); },
			onFrame: frame => this.handleFrame(frame),
		});
		this.client.connect();
	}

	disconnect(): void {
		this.client?.close();
		this.client = undefined;
	}

	/** ターミナルにアタッチ（出力購読を要求）。 */
	attachTerminal(id: number): void {
		this.sendTerm({ t: 'attach', id });
	}

	detachTerminal(id: number): void {
		this.sendTerm({ t: 'detach', id });
	}

	/** ターミナルへ入力を送る。 */
	sendInput(id: number, data: string): void {
		this.sendTerm({ t: 'input', id, data });
	}

	/** PC側に新規ターミナルを作成する（ws指定でそのリポジトリをcwdに）。 */
	createTerminal(ws?: string): void {
		this.client?.send('term', encoder.encode(JSON.stringify({ t: 'create', ws })));
	}

	/** 現在の状態スナップショットを要求する。 */
	requestState(): void {
		this.client?.send('state', new Uint8Array(0));
	}

	private sendTerm(msg: { t: string; id: number; data?: string }): void {
		this.client?.send('term', encoder.encode(JSON.stringify(msg)));
	}

	// --- scm / fs（リクエスト/レスポンス） ------------------------------------

	private requestCounter = 0;
	private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: unknown }>();

	private request<T>(channel: 'scm' | 'fs' | 'browser', body: object): Promise<T> {
		const client = this.client;
		if (!client) {
			return Promise.reject(new Error('not connected'));
		}
		const id = `r${this.requestCounter++}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('request timeout'));
			}, 30_000);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			client.send(channel, encoder.encode(JSON.stringify({ id, ...body })));
		});
	}

	private settleResponse(payload: Uint8Array): void {
		try {
			const msg = JSON.parse(decoder.decode(payload)) as { id?: string; error?: string };
			if (!msg.id) {
				return;
			}
			const entry = this.pending.get(msg.id);
			if (!entry) {
				return;
			}
			this.pending.delete(msg.id);
			clearTimeout(entry.timer as Parameters<typeof clearTimeout>[0]);
			if (msg.error) {
				entry.reject(new Error(msg.error));
			} else {
				entry.resolve(msg);
			}
		} catch { /* ignore */ }
	}

	/** git status（変更ファイル一覧 + ブランチ名）。 */
	scmStatus(ws: string): Promise<ScmStatusResult> {
		return this.request<ScmStatusResult>('scm', { t: 'status', ws });
	}

	/** git diff（path省略で全体、staged=trueでステージ済み）。 */
	scmDiff(ws: string, path?: string, staged?: boolean): Promise<ScmDiffResult> {
		return this.request<ScmDiffResult>('scm', { t: 'diff', ws, path, staged });
	}

	/** コミット（all=trueで git add -A してから）。 */
	scmCommit(ws: string, message: string, all: boolean): Promise<ScmCommitResult> {
		return this.request<ScmCommitResult>('scm', { t: 'commit', ws, message, all });
	}

	/** 直近コミット一覧。 */
	scmLog(ws: string): Promise<ScmLogResult> {
		return this.request<ScmLogResult>('scm', { t: 'log', ws });
	}

	/** ディレクトリ一覧（ワークスペースルート相対パス）。 */
	fsList(ws: string, path: string): Promise<FsListResult> {
		return this.request<FsListResult>('fs', { t: 'list', ws, path });
	}

	/** ファイル読み取り（上限つき）。 */
	fsRead(ws: string, path: string): Promise<FsReadResult> {
		return this.request<FsReadResult>('fs', { t: 'read', ws, path });
	}

	// --- browser（para-browser ミラー、設計書 M3） ------------------------------

	/** ミラー可能なブラウザページ一覧。 */
	browserTargets(): Promise<BrowserTargetsResult> {
		return this.request<BrowserTargetsResult>('browser', { t: 'targets' });
	}

	/** screencast を開始する（フレームは state.browserFrame に流れ込む）。 */
	browserStart(targetId: string): Promise<void> {
		return this.request<void>('browser', { t: 'start', targetId });
	}

	/** screencast を停止する。 */
	async browserStop(): Promise<void> {
		this.state.browserFrame = undefined;
		this.emit();
		try {
			await this.request<void>('browser', { t: 'stop' });
		} catch { /* 接続断などは無視 */ }
	}

	/** 入力イベントを送る（正規化座標）。 */
	browserInput(input: { kind: 'tap' | 'scroll' | 'back' | 'forward' | 'reload' | 'text'; nx?: number; ny?: number; dy?: number; text?: string }): void {
		this.client?.send('browser', encoder.encode(JSON.stringify({ t: 'input', ...input })));
	}

	private handleFrame(frame: Frame): void {
		if (frame.ch === 'scm' || frame.ch === 'fs') {
			this.settleResponse(frame.payload);
			return;
		}
		if (frame.ch === 'browser') {
			// screencastフレーム（id無しのストリーム）と要求応答（id有り）が混在する
			try {
				const msg = JSON.parse(decoder.decode(frame.payload)) as { t?: string; id?: string; data?: string; w?: number; h?: number };
				if (msg.t === 'frame' && typeof msg.data === 'string') {
					this.state.browserFrame = { data: msg.data, w: msg.w ?? 0, h: msg.h ?? 0 };
					this.emit();
				} else if (msg.id) {
					this.settleResponse(frame.payload);
				}
			} catch { /* ignore */ }
			return;
		}
		if (frame.ch === 'state') {
			try {
				this.state.workspace = JSON.parse(decoder.decode(frame.payload)) as WorkspaceState;
				this.emit();
			} catch { /* ignore malformed */ }
		} else if (frame.ch === 'term') {
			try {
				const msg = JSON.parse(decoder.decode(frame.payload)) as { t: string; id: number; data?: string };
				if (msg.t === 'data' && typeof msg.data === 'string') {
					const prev = this.state.terminalOutput.get(msg.id) ?? '';
					const next = (prev + msg.data).slice(-MAX_TERM_BUFFER);
					this.state.terminalOutput.set(msg.id, next);
					this.emit();
				} else if (msg.t === 'exit') {
					this.state.terminalOutput.delete(msg.id);
					this.emit();
				}
			} catch { /* ignore */ }
		} else if (frame.ch === 'notify') {
			try {
				const payload = decodeNotify(frame.payload);
				// 重複IDは無視。新しい順に最大50件保持。
				if (!this.state.notifications.some(n => n.id === payload.id)) {
					this.state.notifications = [payload, ...this.state.notifications].slice(0, 50);
					this.emit();
					this.onNotify?.(payload);
				}
			} catch { /* ignore */ }
		}
	}

	private emit(): void {
		this.onChange({ ...this.state, terminalOutput: new Map(this.state.terminalOutput), notifications: [...this.state.notifications] });
	}
}

// base64（依存を足さず、@para/protocol の base64url を使う）。
import { fromBase64Url as fromB64, toBase64Url as toB64 } from '@para/protocol';
