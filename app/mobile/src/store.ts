// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルアプリの状態ストア（UI非依存の中核）。RelayClient/PairingClient を束ね、
 * PCから届く state スナップショットと接続状態を保持する。Zustand から購読する。
 *
 * 永続化（identity/credentials）は KeyStore インターフェースで注入する
 * （本番は expo-secure-store、テストはメモリ実装）。
 */

import { type Frame, type Identity, type NotifyPayload, decodeNotify, deriveNotifyKey, generateIdentity } from '@para/protocol';
import { RelayClient, encodeRelayControl, type ConnectionState, type PairedCredentials, type SocketFactory } from './relayClient.js';

/** PCから届くワークスペース状態（stateチャネルのJSON）。 */
export interface WorkspaceState {
	activeWs: string | undefined;
	workspaces: { id: string; name: string; color?: string; branch?: string }[];
	terminals: { id: number; title: string; ws?: string; agentStatus?: string; cols?: number; rows?: number }[];
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
	/** skip+limitの先にまだコミットが残っているか（追加読み込みボタンの表示判定）。 */
	hasMore?: boolean;
	/** リモート(origin)から導出したWeb URL（コミットページへのリンク用）。 */
	webUrl?: string;
}
/** scm commit 応答。 */
export interface ScmCommitResult {
	output: string;
}
/** scm commitFiles 応答（1コミットの変更ファイル一覧）。 */
export interface ScmCommitFilesResult {
	files: { status: string; path: string }[];
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
	/** highlight要求時: PCの現行テーマでトークン化されたHTML（.monaco-tokenized-source）。 */
	html?: string;
	/** highlight要求時: トークン色のカラーマップCSS。 */
	css?: string;
	/** highlight要求時: エディタ背景色/前景色。 */
	bg?: string;
	fg?: string;
	/** ハイライトがサイズ上限で先頭のみになっている。 */
	highlightTruncated?: boolean;
}

/** fs xlsx 応答（PC側でレンダリングされたExcelの1シート分の静的HTML + シート一覧）。 */
export interface FsXlsxResult {
	html: string;
	/** ブックの全シート名（ネイティブのシートタブ表示用）。 */
	sheets?: string[];
	/** 今回レンダリングされたシートのインデックス。 */
	sheet?: number;
}
/** fs pdf 応答（PDFバイナリの base64。WKWebView のネイティブPDF表示に使う）。 */
export interface FsPdfResult {
	data: string;
	size: number;
}
/** fs docx 応答（Word文書バイナリの base64。WebView 内の docx-preview でレンダリングする）。 */
export interface FsDocxResult {
	data: string;
	size: number;
}
/** fs media 応答（画像・動画・音声バイナリの base64）。 */
export interface FsMediaResult {
	data: string;
	size: number;
}
/** fs find 応答（ファイル名検索、ルート相対パスのランク順）。 */
export interface FsFindResult {
	files: string[];
	truncated: boolean;
}
/** fs grep 応答（テキスト全文検索）。 */
export interface FsGrepResult {
	matches: { path: string; line: number; text: string }[];
	truncated: boolean;
}
/** fs upload 応答（PC側に保存された添付ファイルのフルパス）。 */
export interface FsUploadResult {
	path: string;
}
/** scm xlsxDiff 応答（PC側でレンダリングされたExcel差分の静的HTML）。 */
export interface ScmXlsxDiffResult {
	html: string;
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

/** kind==='question' の選択肢1件。 */
export interface AgentQuestionOption {
	label: string;
	description?: string;
}

/** agent チャネルの正規化済みチャットメッセージ（PC側 paradisMobileAgentChat.ts と一致）。 */
export interface AgentChatMessage {
	rev: number;
	role: 'user' | 'assistant' | 'tool';
	kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'question';
	text: string;
	tool?: string;
	ts?: number;
	/** kind==='question': タブ見出し。 */
	header?: string;
	/** kind==='question': 選択肢（表示順 = TUIの番号キー割り当て順）。 */
	options?: AgentQuestionOption[];
	/** kind==='question': 複数選択可能な質問か（TUIではトグル選択 + Enter確定）。 */
	multiSelect?: boolean;
	/** kind==='question' | 'tool_result': 対応付け用ID。同IDの tool_result が後続にあれば回答済み。 */
	toolUseId?: string;
}

/** セッションのメタ情報（PC側 transcript から学習した最新値）。 */
export interface AgentSessionInfo {
	/** モデル名（Claude: assistant行の model、Codex: turn_context.model）。 */
	model?: string;
	/** reasoning effort（Codex: turn_context、Claude: settings.json の既定値 + /effort の実行記録）。 */
	effort?: string;
}

/** ターミナル1つ分のエージェントチャット状態。 */
export interface AgentChatState {
	/** 'claude' | 'codex'。 */
	agent: string;
	/** PC側tailerのepoch（再接続時の差分同期に使う）。 */
	epoch: string;
	/** 受信済み最終rev。 */
	rev: number;
	messages: AgentChatMessage[];
	/** 古い履歴が省略されている。 */
	truncated: boolean;
	/** PC側にセッションが見つからなかった（エージェント未起動等）。 */
	none?: boolean;
	/** セッションのメタ情報（model / effort）。 */
	info?: AgentSessionInfo;
}

/**
 * 「人間の対応が必要」なエージェント状態か（赤表示・応答待ちバッジの判定）。
 * permission = ツール実行の許可待ち、question = 選択式質問（AskUserQuestion）への回答待ち。
 */
export function isAgentWaiting(status: string | undefined): boolean {
	return status === 'permission' || status === 'question';
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
	/** ターミナルID → エージェントチャット状態（agentチャネル）。 */
	agentChats: Map<number, AgentChatState>;
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

export async function clearCredentials(keyStore: KeyStore): Promise<void> {
	await keyStore.deleteItem(CREDS_KEY);
}

/**
 * リレー上の自分の資格情報を失効させる（ペアリング解除）。mobileToken 本人認証なので
 * 自分の分しか消せない。ネットワーク断などの失敗は false を返す（ローカル解除は続行してよい）。
 * RNのfetchは既定タイムアウトを持たないため、ハーフオープン接続で unpair() 全体が
 * ハングしないよう AbortController で上限を切る。
 */
export async function revokeSelfOnRelay(creds: PairedCredentials, fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): Promise<boolean> {
	const httpBase = creds.relayUrl.replace(/\/$/, '').replace(/^ws/, 'http');
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), timeoutMs);
	try {
		const res = await fetchImpl(`${httpBase}/device/${creds.deviceId}/mobile/self-revoke`, {
			method: 'POST',
			headers: { authorization: `Bearer ${creds.mobileToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ mobileId: creds.mobileId }),
			signal: abort.signal,
		});
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
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
	private lastCredentials: PairedCredentials | undefined;
	readonly state: StoreState = {
		connection: 'offline',
		pcOnline: false,
		workspace: undefined,
		terminalOutput: new Map(),
		notifications: [],
		browserFrame: undefined,
		agentChats: new Map(),
	};

	/**
	 * agentチャットの購読中ターミナルID → 購読者数（参照カウント）。
	 * ホーム画面のアテンションカードとエージェント画面が同じターミナルを同時に
	 * 購読しうる（別ターミナルの場合は2件同時）ため単一IDでは表現できない。
	 * 再接続時はここに残っている全IDを再attachする。
	 */
	private attachedAgents = new Map<number, number>();

	constructor(
		private readonly identity: Identity,
		private readonly socketFactory: SocketFactory,
		private readonly onChange: (state: StoreState) => void,
		/** 通知受信時のフック（expo-notifications によるローカル通知表示など）。 */
		private readonly onNotify?: (payload: NotifyPayload) => void,
		/** APNsデバイストークンの取得（iOS実機のみ値を返す）。接続確立ごとにリレーへ登録する。 */
		private readonly getPushToken?: () => Promise<string | undefined>,
		/** aps-environment（開発ビルド='dev'、TestFlight/App Store='prod'）。 */
		private readonly pushEnv: 'dev' | 'prod' = 'prod',
		/** 通知鍵(hex)の永続化（NSEと共有するKeychainへ。iOSのみ）。 */
		private readonly persistNotifyKey?: (hex: string) => Promise<void>,
	) { }

	private static bytesToHexStatic(bytes: Uint8Array): string {
		let out = '';
		for (const b of bytes) {
			out += b.toString(16).padStart(2, '0');
		}
		return out;
	}

	/** 接続確立時にAPNsトークンをリレーへ登録する（アプリ未起動時のプッシュ配送先）。 */
	private registerPushToken(): void {
		if (!this.getPushToken) {
			return;
		}
		this.getPushToken().then(token => {
			if (token !== undefined) {
				this.client?.sendControl(encodeRelayControl({ type: 'register-push', token, env: this.pushEnv }));
			}
		}).catch(() => { /* トークン未取得（シミュレータ・権限拒否等）は黙って無視 */ });
	}

	connect(creds: PairedCredentials): void {
		this.lastCredentials = creds;
		// アプリ未起動時のプッシュ本文を Notification Service Extension が復号できるよう、
		// 長期鍵ペアから導出した通知鍵を共有Keychainへ保存しておく（設計書 §5.2）。
		if (this.persistNotifyKey) {
			try {
				const notifyKey = deriveNotifyKey(this.identity.secretKey, creds.pcPublicKey);
				void this.persistNotifyKey(MobileController.bytesToHexStatic(notifyKey)).catch(() => { /* シミュレータ等では失敗してよい */ });
			} catch { /* 導出失敗時はプッシュ本文が固定文になるだけ（致命的でない） */ }
		}
		this.client?.close();
		this.client = new RelayClient(this.identity, creds, this.socketFactory, {
			onStateChange: s => {
				this.state.connection = s;
				this.emit();
				// 再接続完了時: 購読中のagentチャットがあれば手元のepoch/revで再attachする
				// （PC側はepoch一致なら差分のみ、不一致なら全量スナップショットを返す）。
				if (s === 'online') {
					for (const id of this.attachedAgents.keys()) {
						this.sendAgentAttach(id);
					}
				}
				if (s === 'online') {
					this.registerPushToken();
				}
			},
			onPcPresence: online => { this.state.pcOnline = online; this.emit(); },
			onFrame: frame => this.handleFrame(frame),
		});
		this.client.connect();
	}

	disconnect(): void {
		this.client?.close();
		this.client = undefined;
		this.state.connection = 'offline';
		this.state.pcOnline = false;
		this.emit();
	}

	/** ペアリング解除時: 接続を閉じ、保持している資格情報と表示状態をすべて初期化する。 */
	reset(): void {
		this.client?.close();
		this.client = undefined;
		this.lastCredentials = undefined;
		this.attachedAgents.clear();
		this.state.connection = 'offline';
		this.state.pcOnline = false;
		this.state.workspace = undefined;
		this.state.terminalOutput = new Map();
		this.state.notifications = [];
		this.state.browserFrame = undefined;
		this.state.agentChats = new Map();
		this.emit({ term: true, notifications: true, agentChats: true });
	}

	/** 手動切断後などに、保存済み資格情報で接続し直す。 */
	reconnect(): void {
		if (this.client) {
			this.client.ensureConnected();
		} else if (this.lastCredentials) {
			this.connect(this.lastCredentials);
		}
	}

	/** 未接続なら即座に接続、'online' 表示中は生存確認する（フォアグラウンド復帰時用）。 */
	ensureConnected(): void {
		const client = this.client;
		if (!client) {
			return;
		}
		if (client.connectionState === 'online') {
			// zombie検出: 応答が必ず返るstate要求を送り、無応答なら接続を作り直す
			this.requestState();
			client.probeLiveness();
		} else {
			client.ensureConnected();
		}
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

	// --- agent チャット（エージェントセッションのチャットミラー） ----------------

	/**
	 * エージェントチャットの購読を開始する（切断→再接続時は自動で再attachされる）。
	 * 参照カウント方式: 同じidに対する2件目以降の呼び出しはPCへの再送信をせず
	 * カウントのみ増やす（ホーム画面とエージェント画面が同時に同じターミナルを
	 * 購読するケースで、片方のdetachがもう片方の購読を切らないようにするため）。
	 */
	attachAgent(id: number): void {
		const count = (this.attachedAgents.get(id) ?? 0) + 1;
		this.attachedAgents.set(id, count);
		if (count === 1) {
			this.sendAgentAttach(id);
		}
	}

	detachAgent(id: number): void {
		const count = this.attachedAgents.get(id);
		if (count === undefined) {
			return;
		}
		if (count <= 1) {
			this.attachedAgents.delete(id);
			this.client?.send('agent', encoder.encode(JSON.stringify({ t: 'detach', id })));
		} else {
			this.attachedAgents.set(id, count - 1);
		}
	}

	/** チャット表示の再読み込み（セッションが見つからなかった後の再試行にも使う）。 */
	refreshAgent(id: number): void {
		this.state.agentChats.delete(id);
		this.emit({ agentChats: true });
		if (this.attachedAgents.has(id)) {
			this.sendAgentAttach(id);
		}
	}

	private sendAgentAttach(id: number): void {
		// 手元に同ターミナルの受信済み状態があれば epoch/afterRev を申告して差分だけ受け取る。
		const existing = this.state.agentChats.get(id);
		const body = existing !== undefined && !existing.none
			? { t: 'attach', id, epoch: existing.epoch, afterRev: existing.rev }
			: { t: 'attach', id };
		this.client?.send('agent', encoder.encode(JSON.stringify(body)));
	}

	// --- scm / fs（リクエスト/レスポンス） ------------------------------------

	private requestCounter = 0;
	private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: unknown }>();

	private request<T>(channel: 'scm' | 'fs' | 'browser', body: object, timeoutMs = 30_000): Promise<T> {
		const client = this.client;
		if (!client) {
			return Promise.reject(new Error('not connected'));
		}
		const id = `r${this.requestCounter++}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('request timeout'));
			}, timeoutMs);
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
	scmLog(ws: string, opts?: { limit?: number; skip?: number }): Promise<ScmLogResult> {
		return this.request<ScmLogResult>('scm', { t: 'log', ws, ...(opts?.limit !== undefined ? { limit: opts.limit } : {}), ...(opts?.skip !== undefined ? { skip: opts.skip } : {}) });
	}

	scmCommitFiles(ws: string, hash: string): Promise<ScmCommitFilesResult> {
		return this.request<ScmCommitFilesResult>('scm', { t: 'commitFiles', ws, hash });
	}

	/** ディレクトリ一覧（ワークスペースルート相対パス）。 */
	fsList(ws: string, path: string): Promise<FsListResult> {
		return this.request<FsListResult>('fs', { t: 'list', ws, path });
	}

	/** ファイル読み取り（上限つき）。highlight=trueでPCテーマのハイライトHTMLも返る。 */
	fsRead(ws: string, path: string, highlight?: boolean): Promise<FsReadResult> {
		return this.request<FsReadResult>('fs', { t: 'read', ws, path, ...(highlight ? { highlight: true } : {}) });
	}

	/** xlsx の1シートをPC側でレンダリングした静的HTMLを取得する（重いブックはPC側の生成に時間がかかるため長め）。 */
	fsXlsx(ws: string, path: string, sheet?: number): Promise<FsXlsxResult> {
		return this.request<FsXlsxResult>('fs', { t: 'xlsx', ws, path, ...(sheet !== undefined ? { sheet } : {}) }, 120_000);
	}

	/** PDF バイナリを base64 で取得する（大きい PDF はチャンク転送で時間がかかるため長め）。 */
	fsPdf(ws: string, path: string): Promise<FsPdfResult> {
		return this.request<FsPdfResult>('fs', { t: 'pdf', ws, path }, 120_000);
	}

	/** Word(.docx) バイナリを base64 で取得する（レンダリングはモバイルの WebView 内で行う）。 */
	fsDocx(ws: string, path: string): Promise<FsDocxResult> {
		return this.request<FsDocxResult>('fs', { t: 'docx', ws, path }, 120_000);
	}

	/** 画像・動画・音声バイナリを base64 で取得する（大きいファイルはチャンク転送で時間がかかるため長め）。 */
	fsMedia(ws: string, path: string): Promise<FsMediaResult> {
		return this.request<FsMediaResult>('fs', { t: 'media', ws, path }, 120_000);
	}

	/**
	 * 画像等をPCへアップロードし、保存先フルパスを受け取る（エージェントへの添付用。
	 * PC側は userData 配下の専用ディレクトリに保存し、モバイルはパスをPTYへ貼り付ける）。
	 */
	fsUpload(name: string, dataBase64: string): Promise<FsUploadResult> {
		return this.request<FsUploadResult>('fs', { t: 'upload', name, data: dataBase64 }, 120_000);
	}

	/** ファイル名検索（ワークスペース全体、.gitignore尊重、PC側ripgrep）。 */
	fsFind(ws: string, query: string): Promise<FsFindResult> {
		return this.request<FsFindResult>('fs', { t: 'find', ws, query });
	}

	/** テキスト全文検索（ワークスペース全体、PC側ripgrep）。 */
	fsGrep(ws: string, query: string): Promise<FsGrepResult> {
		return this.request<FsGrepResult>('fs', { t: 'grep', ws, query });
	}

	/** xlsx の差分(HEAD vs 作業ツリー)をPC側でレンダリングした静的HTMLを取得する。 */
	scmXlsxDiff(ws: string, path: string): Promise<ScmXlsxDiffResult> {
		return this.request<ScmXlsxDiffResult>('scm', { t: 'xlsxDiff', ws, path }, 120_000);
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

	/**
	 * screencast を停止する。keepFrame=true のときは最後のフレームを残したまま停止する
	 * （タブのblur等で一時停止する用途。再フォーカス時に静止画→最新画面へ自然に切り替わる）。
	 */
	async browserStop(keepFrame = false): Promise<void> {
		if (!keepFrame) {
			this.state.browserFrame = undefined;
			this.emit();
		}
		try {
			await this.request<void>('browser', { t: 'stop' });
		} catch { /* 接続断などは無視 */ }
	}

	/** 入力イベントを送る（正規化座標）。 */
	browserInput(input: { kind: 'tap' | 'scroll' | 'back' | 'forward' | 'reload' | 'text' | 'navigate'; nx?: number; ny?: number; dy?: number; dx?: number; text?: string; url?: string }): void {
		this.client?.send('browser', encoder.encode(JSON.stringify({ t: 'input', ...input })));
	}

	// --- browser WebRTC ミラー（app/design/webrtc-mirror-design.md） ---------------

	/** PC→mobile の ICE candidate 受信ハンドラ（webrtcMirror.ts が登録する。単一スロット）。 */
	webrtcIceHandler: ((candidate: object) => void) | undefined;

	/** WebRTC offer を送り、PC側ストリーマの answer SDP を待つ。 */
	webrtcOffer(targetId: string, sdp: string): Promise<{ sdp?: string }> {
		return this.request<{ sdp?: string }>('browser', { t: 'webrtc-offer', targetId, sdp }, 20_000);
	}

	/** 自分の ICE candidate をPCへ送る（fire-and-forget）。 */
	webrtcSendIce(candidate: object): void {
		this.client?.send('browser', encoder.encode(JSON.stringify({ t: 'webrtc-ice', candidate })));
	}

	/** PC側のピアを畳ませる。 */
	webrtcStop(): void {
		this.client?.send('browser', encoder.encode(JSON.stringify({ t: 'webrtc-stop' })));
	}

	/**
	 * TURN短期資格情報をリレーから取得する（Cloudflare Realtime）。リレー側にシークレットが
	 * 未設定の場合や失敗時は空配列（STUNのみで続行）。対称NAT越え（キャリア回線⇔自宅PC等）に必要。
	 */
	async fetchTurnIceServers(timeoutMs = 5_000): Promise<object[]> {
		const creds = this.lastCredentials;
		if (!creds) {
			return [];
		}
		const httpBase = creds.relayUrl.replace(/\/$/, '').replace(/^ws/, 'http');
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), timeoutMs);
		try {
			const res = await fetch(`${httpBase}/device/${creds.deviceId}/turn`, {
				method: 'POST',
				headers: { authorization: `Bearer ${creds.mobileToken}`, 'content-type': 'application/json' },
				body: JSON.stringify({ mobileId: creds.mobileId }),
				signal: abort.signal,
			});
			if (!res.ok) {
				return [];
			}
			const data = await res.json() as { iceServers?: object[] };
			return Array.isArray(data.iceServers) ? data.iceServers : [];
		} catch {
			return [];
		} finally {
			clearTimeout(timer);
		}
	}

	private handleFrame(frame: Frame): void {
		if (frame.ch === 'scm' || frame.ch === 'fs') {
			this.settleResponse(frame.payload);
			return;
		}
		if (frame.ch === 'agent') {
			this.handleAgentFrame(frame.payload);
			return;
		}
		if (frame.ch === 'browser') {
			// screencastフレーム（id無しのストリーム）と要求応答（id有り）が混在する
			try {
				const msg = JSON.parse(decoder.decode(frame.payload)) as { t?: string; id?: string; data?: string; w?: number; h?: number; candidate?: object };
				if (msg.t === 'frame' && typeof msg.data === 'string') {
					this.state.browserFrame = { data: msg.data, w: msg.w ?? 0, h: msg.h ?? 0 };
					this.emit();
				} else if (msg.t === 'webrtc-ice' && msg.candidate) {
					this.webrtcIceHandler?.(msg.candidate);
				} else if (msg.id) {
					this.settleResponse(frame.payload);
				}
			} catch { /* ignore */ }
			return;
		}
		if (frame.ch === 'state') {
			try {
				this.state.workspace = JSON.parse(decoder.decode(frame.payload)) as WorkspaceState;
				// 切断中に exit 通知を取り逃したケースに備え、現存しないターミナルの
				// terminalOutput / agentChats エントリを掃除する。
				const live = new Set(this.state.workspace.terminals.map(t => t.id));
				for (const id of this.state.terminalOutput.keys()) {
					if (!live.has(id)) {
						this.state.terminalOutput.delete(id);
					}
				}
				for (const id of this.state.agentChats.keys()) {
					if (!live.has(id)) {
						this.state.agentChats.delete(id);
						this.attachedAgents.delete(id);
					}
				}
				// workspace は再代入で参照が変わる。terminalOutput / agentChats は上の掃除で
				// ミューテートしうるため、常に新参照へ差し替える（掃除が空振りでも安全側に倒す）。
				this.emit({ term: true, agentChats: true });
			} catch { /* ignore malformed */ }
		} else if (frame.ch === 'term') {
			try {
				const msg = JSON.parse(decoder.decode(frame.payload)) as { t: string; id: number; data?: string; snapshot?: boolean };
				if (msg.t === 'data' && typeof msg.data === 'string') {
					// snapshot（attach時のVT画面復元）はバッファを置き換える。追記だと再attachの
					// たびにスナップショットが積み重なり、xtermへの再生で画面が二重・崩壊するため。
					const prev = msg.snapshot ? '' : (this.state.terminalOutput.get(msg.id) ?? '');
					const next = (prev + msg.data).slice(-MAX_TERM_BUFFER);
					this.state.terminalOutput.set(msg.id, next);
					this.emit({ term: true });
				} else if (msg.t === 'exit') {
					this.state.terminalOutput.delete(msg.id);
					// 閉じたターミナルは二度と再attachされないため、チャット履歴も掃除する。
					// （放置すると agentChats に使い捨てターミナル分のチャットが蓄積し続ける）
					this.state.agentChats.delete(msg.id);
					this.attachedAgents.delete(msg.id);
					this.emit({ term: true, agentChats: true });
				}
			} catch { /* ignore */ }
		} else if (frame.ch === 'notify') {
			try {
				const payload = decodeNotify(frame.payload);
				// 重複IDは無視。新しい順に最大50件保持。
				if (!this.state.notifications.some(n => n.id === payload.id)) {
					this.state.notifications = [payload, ...this.state.notifications].slice(0, 50);
					this.emit({ notifications: true });
					this.onNotify?.(payload);
				}
			} catch { /* ignore */ }
		}
	}

	private handleAgentFrame(payload: Uint8Array): void {
		try {
			const msg = JSON.parse(decoder.decode(payload)) as {
				t: string; id: number; agent?: string; epoch?: string; rev?: number;
				messages?: AgentChatMessage[]; truncated?: boolean; info?: AgentSessionInfo;
			};
			if (typeof msg.id !== 'number') {
				return;
			}
			if (msg.t === 'none') {
				this.state.agentChats.set(msg.id, { agent: '', epoch: '', rev: -1, messages: [], truncated: false, none: true });
				this.emit({ agentChats: true });
				return;
			}
			if (msg.t === 'snapshot') {
				this.state.agentChats.set(msg.id, {
					agent: msg.agent ?? 'claude',
					epoch: msg.epoch ?? '',
					rev: msg.rev ?? -1,
					messages: msg.messages ?? [],
					truncated: msg.truncated === true,
					...(msg.info !== undefined ? { info: msg.info } : {}),
				});
				this.emit({ agentChats: true });
				return;
			}
			if (msg.t === 'delta') {
				const existing = this.state.agentChats.get(msg.id);
				if (!existing || existing.epoch !== msg.epoch) {
					// epoch不一致の差分は適用できない → 全量を取り直す（欠落したまま表示しない）。
					if (this.attachedAgents.has(msg.id)) {
						this.client?.send('agent', encoder.encode(JSON.stringify({ t: 'attach', id: msg.id })));
					}
					return;
				}
				// 重複revは捨てる（再attach応答と押し出しdeltaの競合対策）。
				const fresh = (msg.messages ?? []).filter(m => !existing.messages.some(e => e.rev === m.rev));
				this.state.agentChats.set(msg.id, {
					...existing,
					rev: msg.rev ?? existing.rev,
					messages: [...existing.messages, ...fresh].slice(-500),
					...(msg.info !== undefined ? { info: msg.info } : {}),
				});
				this.emit({ agentChats: true });
			}
		} catch { /* ignore */ }
	}

	/** 直近に onChange へ渡したスナップショット（未変更コレクションの参照据え置きに使う）。 */
	private lastEmitted: StoreState | undefined;

	/**
	 * 状態変化を購読側へ通知する。terminalOutput / notifications / agentChats の3コレクションは
	 * ミューテートしても参照は変わらないため、明示的に新しい参照へ差し替えないと Zustand の
	 * useShallow セレクタが変化を検知できない。逆に「毎回すべて new し直す」と、どのチャネルの
	 * 更新でも全画面が再レンダーされてしまう（バッテリー・描画コスト）。
	 *
	 * そこで changed で「今回中身を書き換えたコレクション」だけを新しい参照にし、書き換えていない
	 * ものは前回 emit した参照をそのまま渡す。これにより変更と参照更新が機械的に1対1で対応する。
	 * コレクションをミューテートした呼び出し元は、対応するフラグを必ず立てること
	 * （立て忘れると「更新したのに画面が変わらない」表示バグになる）。
	 *
	 * connection / pcOnline / workspace / browserFrame は常に丸ごと再代入されるスカラ相当なので、
	 * this.state の現在値をそのまま渡せば参照比較が正しく働く（changed で管理する必要はない）。
	 */
	private emit(changed?: { term?: boolean; notifications?: boolean; agentChats?: boolean }): void {
		const prev = this.lastEmitted;
		const next: StoreState = {
			connection: this.state.connection,
			pcOnline: this.state.pcOnline,
			workspace: this.state.workspace,
			browserFrame: this.state.browserFrame,
			terminalOutput: (!prev || changed?.term) ? new Map(this.state.terminalOutput) : prev.terminalOutput,
			notifications: (!prev || changed?.notifications) ? [...this.state.notifications] : prev.notifications,
			agentChats: (!prev || changed?.agentChats) ? new Map(this.state.agentChats) : prev.agentChats,
		};
		this.lastEmitted = next;
		this.onChange(next);
	}
}

// base64（依存を足さず、@para/protocol の base64url を使う）。
import { fromBase64Url as fromB64, toBase64Url as toB64 } from '@para/protocol';
