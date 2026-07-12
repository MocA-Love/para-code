// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * アプリ全体で共有する MobileController と接続状態の Zustand ストア。
 * 画面（screens）はここから状態を購読し、コントローラ経由で操作する。
 */

import { AppState as RNAppState } from 'react-native';
import { create } from 'zustand';
import type { Identity, PairingPayload } from '@para/protocol';
import { decodePairingUri } from '@para/protocol';
import { MobileController, clearCredentials, loadCredentials, loadOrCreateIdentity, revokeSelfOnRelay, saveCredentials, type AgentActivityDetailMessage, type AgentQuestionAnswer, type BrowserTargetsResult, type FsDocxResult, type FsFindResult, type FsMediaResult, type FsGrepResult, type FsHighlightResult, type FsListResult, type FsUploadResult, type FsPdfResult, type FsReadResult, type FsXlsxResult, type ScmCommitFilesResult, type ScmCommitResult, type ScmDiffResult, type ScmLogResult, type ScmStatusResult, type ScmXlsxDiffResult, type StoreState, type TermStreamEvent, type UsageDashboardResult, type WorktreeCreateResult, type WorktreeFormResult } from './store.js';
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
	/**
	 * ホームのエージェント一覧を全ワークスペース横断で表示するか。falseの間はドロワーの
	 * 選択中ワークスペース（selectedWs）に絞り込む。既定はtrue（アプリ再起動時はここに戻る。
	 * AsyncStorage等へは永続化しない）。バックグラウンド復帰やタブ切替では維持される。
	 */
	homeShowAllWorkspaces: boolean;
	setHomeShowAllWorkspaces(value: boolean): void;
	/** ターミナル画面で選択中のターミナルID（ws切替時はリセット）。 */
	selectedTerminalId: number | undefined;
	setSelectedTerminalId(id: number | undefined): void;
	/**
	 * 通知設定（設定画面）。agentDone/agentQuestionがfalseの種別はOS通知（バナー）を
	 * 出さない（アプリ内の通知一覧には残る）。suppressWhenPcFocusedはPC側の判断のみに
	 * 使う（PCがフォーカスされている間はそもそもモバイルへ配信しない）。いずれもPC側に
	 * 同期され、アプリ未起動時のAPNsリモートプッシュ抑制もPC側のdispatchNotifyが行う。
	 */
	notifyPrefs: { agentDone: boolean; agentQuestion: boolean; suppressWhenPcFocused: boolean };
	setNotifyPref(key: 'agentDone' | 'agentQuestion' | 'suppressWhenPcFocused', enabled: boolean): void;
	/** 通知一覧を全消去する（通知一覧画面のクリアボタン）。 */
	clearNotifications(): void;
	/** 通知一覧から単一項目を消す（項目タップで遷移した時）。他端末の一覧にも同期される。 */
	dismissNotification(id: string): void;
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
	/** ターミナル名を変更する（PC側の実インスタンスにも反映され、他端末にも同期される）。 */
	renameTerminal(id: number, title: string): void;
	/** ターミナルを削除する（PC側の実インスタンスも閉じる。呼び出し側で確認済みの前提）。 */
	closeTerminal(id: number): void;
	/** エージェントの「レビュー」状態を確認済みにする（ステータスバッジのポップオーバーから）。 */
	ackAgentStatus(id: number): void;
	/**
	 * ピン留め状態（キーは pinKeyForTerminal 参照）。モバイル端末ローカルのみの状態で、
	 * PCへは同期しない（ホーム一覧の並び順の好みなのでPC側に対応概念が無いため）。
	 */
	pinnedKeys: Set<string>;
	togglePin(key: string): void;
	/**
	 * コンポーザーの下書き（キーは pinKeyForTerminal 等のエージェント/ターミナル単位の一意ID）。
	 * 画面遷移で入力中テキストが消えないようメモリ上に退避する。キーごとに分離されるため
	 * 別のエージェントの入力欄には表示されない。端末ローカルのみでPC・他端末へは同期せず、
	 * AsyncStorage等へも永続化しない（アプリ再起動で消える）。
	 */
	agentDrafts: Record<string, string>;
	/** 下書きを更新する（空文字を渡すとそのキーの下書きを消す）。 */
	setAgentDraft(key: string, text: string): void;
	/** 下書きを消す（送信完了時など）。 */
	clearAgentDraft(key: string): void;
	/** ターミナル同期ストリームの購読（購読時にリプレイキャッシュを同期再生）。 */
	subscribeTerminal(id: number, listener: (ev: TermStreamEvent) => void): () => void;
	sendInput(id: number, data: string): void;
	/** 矢印キーをセマンティック名で送る（PC側が端末モードに合わせてエンコードする）。 */
	sendArrowKey(id: number, key: 'up' | 'down' | 'right' | 'left'): void;
	/** テキスト入力を送る（PC側でbracketed paste対応。execute=trueで実行）。 */
	sendTextInput(id: number, text: string, execute: boolean): void;
	sendAgentMessage(id: number, text: string): Promise<boolean>;
	answerAgentQuestion(id: number, interactionId: string, answers: readonly AgentQuestionAnswer[]): Promise<boolean>;
	answerAgentApproval(id: number, interactionId: string, choice: 'yes' | 'no'): Promise<boolean>;
	updateClaudeSetting(id: number, setting: 'model' | 'effort', value: string): Promise<boolean>;
	requestAgentActivityDetail(id: number, activityId: string): Promise<AgentActivityDetailMessage[]>;
	createTerminal(ws?: string): void;
	attachAgent(id: number): void;
	detachAgent(id: number): void;
	refreshAgent(id: number): void;
	requestAgentModelCatalog(id: number): void;
	updateAgentSettings(id: number, model: string, effort: string): void;
	scmStatus(ws: string): Promise<ScmStatusResult>;
	scmDiff(ws: string, path?: string, staged?: boolean): Promise<ScmDiffResult>;
	scmCommit(ws: string, message: string, all: boolean): Promise<ScmCommitResult>;
	scmLog(ws: string, opts?: { limit?: number; skip?: number }): Promise<ScmLogResult>;
	scmCommitFiles(ws: string, hash: string): Promise<ScmCommitFilesResult>;
	/** worktree（スペース）作成フォームの材料。 */
	worktreeForm(): Promise<WorktreeFormResult>;
	/** worktree（スペース）を作成する（PC版の作成ダイアログと同じ処理がPC側で走る）。 */
	createWorktree(opts: { repo: string; name?: string; branch?: string; base?: string; prompt?: string; agent?: string }): Promise<WorktreeCreateResult>;
	fsList(ws: string, path: string): Promise<FsListResult>;
	fsRead(ws: string, path: string, highlight?: boolean): Promise<FsReadResult>;
	fsXlsx(ws: string, path: string, sheet?: number): Promise<FsXlsxResult>;
	fsPdf(ws: string, path: string): Promise<FsPdfResult>;
	fsDocx(ws: string, path: string): Promise<FsDocxResult>;
	fsMedia(ws: string, path: string): Promise<FsMediaResult>;
	fsFind(ws: string, query: string): Promise<FsFindResult>;
	fsGrep(ws: string, query: string): Promise<FsGrepResult>;
	fsUpload(name: string, dataBase64: string): Promise<FsUploadResult>;
	/** コード断片のシンタックスハイライト（PCの現行テーマ）。 */
	fsHighlight(text: string, lang?: string): Promise<FsHighlightResult>;
	scmXlsxDiff(ws: string, path: string): Promise<ScmXlsxDiffResult>;
	/** ccusage 使用量ダッシュボード。bypassCache=true で shared process 側の TTL キャッシュを無視して再取得する。 */
	usageDashboard(bypassCache?: boolean): Promise<UsageDashboardResult>;
	browserTargets(): Promise<BrowserTargetsResult>;
	browserStart(targetId: string): Promise<void>;
	/** keepFrame=true で最後のフレームを残したまま停止する（タブblur時の一時停止用）。 */
	browserStop(keepFrame?: boolean): Promise<void>;
	browserInput(input: { kind: 'tap' | 'scroll' | 'back' | 'forward' | 'reload' | 'text' | 'navigate'; nx?: number; ny?: number; dy?: number; dx?: number; text?: string; url?: string }): void;
	/**
	 * WebRTCミラー表示中にJPEGフレームの受信処理を止める（フルパース前に読み捨てて
	 * JSスレッド飽和を防ぐ。PC側はフォールバック用にJPEGを送り続けている）。
	 */
	setJpegFramesSuspended(suspended: boolean): void;
	/** WebRTCミラーのシグナリング（webrtcMirror.ts が使う。sid はセッション識別子）。 */
	webrtcOffer(targetId: string, sdp: string, sid: string): Promise<{ sdp?: string }>;
	webrtcSendIce(candidate: object, sid: string): void;
	webrtcStop(sid: string): void;
	setWebrtcIceHandler(sid: string, handler: (candidate: object) => void): void;
	/** sid が現在登録中のハンドラと一致する場合のみ解除する（旧世代のcleanupが現行を消さないため）。 */
	clearWebrtcIceHandler(sid: string): void;
	fetchTurnIceServers(): Promise<object[]>;
}

let identity: Identity | undefined;
let controller: MobileController | undefined;
/** 進行中のペアリングクライアント（cancelPairing で中断するため保持）。 */
let pairing: PairingClient | undefined;
/** init() の二重実行防止（Fast Refresh 等での再マウント対策）。同期的に立てて async 再入も弾く。 */
let initStarted = false;
/** 通知設定の再送subscribeの多重登録防止（init()失敗リトライ対策）。 */
let prefsSyncSubscribed = false;
/** 発生からこれより古い通知はOS通知（バナー）に出さない（アプリ内一覧には残る）。 */
const NOTIFY_BANNER_MAX_AGE_MS = 60_000;

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
	homeShowAllWorkspaces: true,
	selectedTerminalId: undefined,
	notifyPrefs: { agentDone: true, agentQuestion: true, suppressWhenPcFocused: false },
	pinnedKeys: new Set(),
	agentDrafts: {},

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
			// 通知設定をロード（保存が無い/壊れている場合は既定値のまま）
			try {
				const raw = await secureKeyStore.getItem('notifyPrefs');
				if (raw) {
					const parsed = JSON.parse(raw) as Partial<AppState['notifyPrefs']>;
					set({
						notifyPrefs: {
							agentDone: parsed.agentDone !== false,
							agentQuestion: parsed.agentQuestion !== false,
							suppressWhenPcFocused: parsed.suppressWhenPcFocused === true,
						},
					});
				}
			} catch (err) {
				console.warn('[appState] failed to load notifyPrefs', err);
			}
			// ピン留め状態をロード（保存が無い/壊れている場合は空集合のまま）
			try {
				const raw = await secureKeyStore.getItem('pinnedTerminals');
				if (raw) {
					const parsed = JSON.parse(raw) as unknown;
					if (Array.isArray(parsed)) {
						set({ pinnedKeys: new Set(parsed.filter((k): k is string => typeof k === 'string')) });
					}
				}
			} catch (err) {
				console.warn('[appState] failed to load pinnedTerminals', err);
			}
			controller = new MobileController(
				identity,
				rnSocketFactory,
				s => set({ ...s }),
				payload => {
					// 通知設定でOFFの種別はOS通知を出さない（アプリ内の通知一覧には残る）
					const prefs = useAppStore.getState().notifyPrefs;
					if ((payload.kind === 'agent-done' && !prefs.agentDone) || (payload.kind === 'agent-question' && !prefs.agentQuestion)) {
						return;
					}
					// 発生から時間が経った通知はOS通知（バナー）を出さない（アプリ内の通知一覧には残る）。
					// iOSがバックグラウンドでアプリを凍結するとPC側からはオンラインに見えたまま
					// notifyフレームがソケットに滞留し、アプリを開いた瞬間にまとめて届くため、
					// 鮮度チェックなしだと過去の通知がその場で一斉にバナー表示されてしまう。
					// APNs経路のapns-expiration（TTL）に相当する判定のクライアント版。
					// PCとモバイルの時計ずれで新鮮な通知を落とさないよう、閾値は緩めに取る。
					if (Date.now() - payload.at > NOTIFY_BANNER_MAX_AGE_MS) {
						return;
					}
					void presentLocalNotification(payload.title, payload.body, { ws: payload.ws, terminalId: payload.terminalId, agentToken: payload.agentToken });
				},
				getApnsDeviceToken,
				// 開発ビルド(expo run:ios)は aps-environment=development なので sandbox APNs 宛に登録する
				__DEV__ ? 'dev' : 'prod',
				persistNotifyKey,
			);
			// オンラインになるたび通知設定をPCへ同期する（PC側の永続値を最新に保つ。
			// オフライン中に変更した設定もここで追いつく）。init()が後続処理の失敗で
			// リトライされた場合に多重登録しないようフラグでガードする。
			if (!prefsSyncSubscribed) {
				prefsSyncSubscribed = true;
				useAppStore.subscribe((s, prev) => {
					if (s.connection === 'online' && prev.connection !== 'online') {
						controller?.sendNotifyPrefs(s.notifyPrefs);
					}
				});
			}
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
		set({ paired: false, manualOffline: false, selectedWs: undefined, homeShowAllWorkspaces: true, selectedTerminalId: undefined });
	},

	attachTerminal(id: number) {
		controller?.attachTerminal(id);
	},

	detachTerminal(id: number) {
		controller?.detachTerminal(id);
	},

	renameTerminal(id: number, title: string) {
		controller?.renameTerminal(id, title);
	},

	closeTerminal(id: number) {
		controller?.closeTerminal(id);
	},

	ackAgentStatus(id: number) {
		controller?.ackAgentStatus(id);
	},

	togglePin(key: string) {
		const current = useAppStore.getState().pinnedKeys;
		const next = new Set(current);
		if (next.has(key)) {
			next.delete(key);
		} else {
			next.add(key);
		}
		set({ pinnedKeys: next });
		secureKeyStore.setItem('pinnedTerminals', JSON.stringify([...next])).catch(err => console.warn('[appState] failed to save pinnedTerminals', err));
	},

	setAgentDraft(key: string, text: string) {
		const current = useAppStore.getState().agentDrafts;
		if (text.length === 0) {
			if (current[key] === undefined) {
				return;
			}
			const next = { ...current };
			delete next[key];
			set({ agentDrafts: next });
			return;
		}
		if (current[key] === text) {
			return;
		}
		set({ agentDrafts: { ...current, [key]: text } });
	},

	clearAgentDraft(key: string) {
		const current = useAppStore.getState().agentDrafts;
		if (current[key] === undefined) {
			return;
		}
		const next = { ...current };
		delete next[key];
		set({ agentDrafts: next });
	},

	subscribeTerminal(id: number, listener: (ev: TermStreamEvent) => void) {
		return controller?.subscribeTerminal(id, listener) ?? (() => { });
	},

	sendInput(id: number, data: string) {
		controller?.sendInput(id, data);
	},

	sendArrowKey(id: number, key: 'up' | 'down' | 'right' | 'left') {
		controller?.sendArrowKey(id, key);
	},

	sendTextInput(id: number, text: string, execute: boolean) {
		controller?.sendTextInput(id, text, execute);
	},

	sendAgentMessage(id: number, text: string) {
		return controller?.sendAgentMessage(id, text) ?? Promise.resolve(false);
	},

	answerAgentQuestion(id: number, interactionId: string, answers: readonly AgentQuestionAnswer[]) {
		return controller?.answerAgentQuestion(id, interactionId, answers) ?? Promise.resolve(false);
	},

	answerAgentApproval(id: number, interactionId: string, choice: 'yes' | 'no') {
		return controller?.answerAgentApproval(id, interactionId, choice) ?? Promise.resolve(false);
	},

	updateClaudeSetting(id: number, setting: 'model' | 'effort', value: string) {
		return controller?.updateClaudeSetting(id, setting, value) ?? Promise.resolve(false);
	},

	requestAgentActivityDetail(id: number, activityId: string) {
		return controller?.requestAgentActivityDetail(id, activityId) ?? Promise.reject(new Error('not connected'));
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

	requestAgentModelCatalog(id: number) {
		controller?.requestAgentModelCatalog(id);
	},

	updateAgentSettings(id: number, model: string, effort: string) {
		controller?.updateAgentSettings(id, model, effort);
	},

	setSelectedWs(ws: string) {
		set({ selectedWs: ws, selectedTerminalId: undefined });
	},

	setHomeShowAllWorkspaces(value: boolean) {
		set({ homeShowAllWorkspaces: value });
	},

	setSelectedTerminalId(id: number | undefined) {
		set({ selectedTerminalId: id });
	},

	setNotifyPref(key: 'agentDone' | 'agentQuestion' | 'suppressWhenPcFocused', enabled: boolean) {
		const next = { ...useAppStore.getState().notifyPrefs, [key]: enabled };
		set({ notifyPrefs: next });
		secureKeyStore.setItem('notifyPrefs', JSON.stringify(next)).catch(err => console.warn('[appState] failed to save notifyPrefs', err));
		// PC側にも同期する（アプリ未起動時のAPNsリモートプッシュはPC側で抑制判定するため）。
		// オフライン中の変更は再接続時のonStateChange('online')フックで再送される。
		controller?.sendNotifyPrefs(next);
	},

	clearNotifications() {
		controller?.clearNotifications();
	},

	dismissNotification(id: string) {
		controller?.dismissNotification(id);
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

	worktreeForm() {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.worktreeForm();
	},

	createWorktree(opts: { repo: string; name?: string; branch?: string; base?: string; prompt?: string; agent?: string }) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.createWorktree(opts);
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

	fsHighlight(text: string, lang?: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.fsHighlight(text, lang);
	},

	scmXlsxDiff(ws: string, path: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.scmXlsxDiff(ws, path);
	},

	usageDashboard(bypassCache?: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.usageDashboard(bypassCache);
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

	setJpegFramesSuspended(suspended) {
		controller?.setJpegFramesSuspended(suspended);
	},

	webrtcOffer(targetId, sdp, sid) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.webrtcOffer(targetId, sdp, sid);
	},

	webrtcSendIce(candidate, sid) {
		controller?.webrtcSendIce(candidate, sid);
	},

	webrtcStop(sid) {
		controller?.webrtcStop(sid);
	},

	setWebrtcIceHandler(sid, handler) {
		if (controller) {
			controller.webrtcIceHandler = { sid, fn: handler };
		}
	},

	clearWebrtcIceHandler(sid) {
		if (controller && controller.webrtcIceHandler?.sid === sid) {
			controller.webrtcIceHandler = undefined;
		}
	},

	fetchTurnIceServers() {
		return controller?.fetchTurnIceServers() ?? Promise.resolve([]);
	},
}));
