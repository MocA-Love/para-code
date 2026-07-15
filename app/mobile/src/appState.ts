// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * アプリ全体で共有する MobileController と接続状態の Zustand ストア。
 * 画面（screens）はここから状態を購読し、コントローラ経由で操作する。
 */

import { AppState as RNAppState } from 'react-native';
import { create } from 'zustand';
import type { Identity, PairingPayload } from '@para/protocol';
import { decodePairingUri, deriveNotifyKey } from '@para/protocol';
import { MobileController, clearCredentials, loadCredentials, loadOrCreateIdentity, reserveOperationRun, revokeSelfOnRelay, saveCredentials, type AgentActivityDetailMessage, type AgentMessageSendResult, type AgentQuestionAnswer, type BrowserTargetsResult, type FsDocxResult, type FsFindResult, type FsMediaResult, type FsGrepResult, type FsHighlightResult, type FsListResult, type FsResolveLinkResult, type FsUploadResult, type FsPdfResult, type FsReadResult, type FsXlsxResult, type ScmCommitFilesResult, type ScmCommitResult, type ScmDiffResult, type ScmLogResult, type ScmStatusResult, type ScmXlsxDiffResult, type StoreState, type TermStreamEvent, type UsageDashboardResult, type WorktreeCreateResult, type WorktreeFormResult } from './store.js';
import { PairingClient } from './pairingClient.js';
import type { PairedCredentials } from './relayClient.js';
import { configureNotificationHandler, deleteNotifyKey, ensureNotificationPermission, getApnsDeviceToken, persistNotifyKey, presentLocalNotification, rnSocketFactory, secureKeyStore, terminalOperationOutboxStore } from './platform.js';
import { connectionActionForAppState, shouldPresentForegroundNotification, shouldRunForegroundWork } from './appLifecycle.js';

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
	/** ターミナル画面で選択中の論理キー（ws切替時はリセット）。 */
	selectedTerminalKey: string | undefined;
	setSelectedTerminalKey(terminalKey: string | undefined): void;
	/** ブラウザ画面を離れても最後のtarget/URLを静止画と一緒に復元するためのUIキャッシュ。 */
	browserSelection: { targetId: string; url: string; desktopEpoch: string } | undefined;
	setBrowserSelection(selection: { targetId: string; url: string; desktopEpoch: string } | undefined): void;
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
	discardUnknownTerminalOperations(): Promise<boolean>;
	attachTerminal(terminalKey: string): void;
	detachTerminal(terminalKey: string): void;
	/** ターミナル名を変更する（PC側の実インスタンスにも反映され、他端末にも同期される）。 */
	renameTerminal(terminalKey: string, title: string): void;
	/** ターミナルを削除する（PC側の実インスタンスも閉じる。呼び出し側で確認済みの前提）。 */
	closeTerminal(terminalKey: string): void;
	/** エージェントの「レビュー」状態を確認済みにする（ステータスバッジのポップオーバーから）。 */
	ackAgentStatus(terminalKey: string): void;
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
	subscribeTerminal(terminalKey: string, listener: (ev: TermStreamEvent) => void): () => void;
	sendInput(terminalKey: string, data: string): Promise<boolean>;
	sendLiveInput(terminalKey: string, data: string): boolean;
	/** 矢印キーをセマンティック名で送る（PC側が端末モードに合わせてエンコードする）。 */
	sendArrowKey(terminalKey: string, key: 'up' | 'down' | 'right' | 'left'): void;
	/** テキスト入力を送る（PC側でbracketed paste対応。execute=trueで実行）。 */
	sendTextInput(terminalKey: string, text: string, execute: boolean): Promise<boolean>;
	sendAgentMessage(terminalKey: string, text: string): Promise<AgentMessageSendResult>;
	answerAgentQuestion(terminalKey: string, interactionId: string, answers: readonly AgentQuestionAnswer[]): Promise<boolean>;
	answerAgentApproval(terminalKey: string, interactionId: string, choice: string): Promise<boolean>;
	updateClaudeSetting(terminalKey: string, setting: 'model' | 'effort', value: string): Promise<boolean>;
	requestAgentActivityDetail(terminalKey: string, activityId: string): Promise<AgentActivityDetailMessage[]>;
	createTerminal(ws?: string): void;
	attachAgent(terminalKey: string): void;
	detachAgent(terminalKey: string): void;
	refreshAgent(terminalKey: string): void;
	requestAgentModelCatalog(terminalKey: string): void;
	requestAgentCommandCatalog(terminalKey: string): void;
	updateAgentSettings(terminalKey: string, model: string, effort: string): void;
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
	fsResolveLink(ws: string, path: string): Promise<FsResolveLinkResult>;
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
	sessionProtocolReady: false,
	workspace: undefined,
	protocolError: undefined,
	terminalOperationIssue: undefined,
	unknownTerminalOperationCount: 0,
	terminalOutput: new Map(),
	notifications: [],
	browserFrame: undefined,
	agentChats: new Map(),
	ready: false,
	paired: false,
	manualOffline: false,
	selectedWs: undefined,
	homeShowAllWorkspaces: true,
	selectedTerminalKey: undefined,
	browserSelection: undefined,
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
			const operationRun = await reserveOperationRun(secureKeyStore);
			const creds = await loadCredentials(secureKeyStore);
			const persistedOperationOutbox = await terminalOperationOutboxStore.loadCandidates();
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
					if (!shouldPresentForegroundNotification(RNAppState.currentState, payload.at, Date.now(), NOTIFY_BANNER_MAX_AGE_MS)) {
						return;
					}
					void presentLocalNotification(payload.title, payload.body, { ws: payload.ws, terminalKey: payload.terminalKey, agentToken: payload.agentToken });
				},
				getApnsDeviceToken,
				// 開発ビルド(expo run:ios)は aps-environment=development なので sandbox APNs 宛に登録する
				__DEV__ ? 'dev' : 'prod',
				persistNotifyKey,
				operationRun,
				terminalOperationOutboxStore,
				persistedOperationOutbox,
				creds,
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
				const action = connectionActionForAppState(appState);
				if (action === 'resume') {
					if (!useAppStore.getState().manualOffline) {
						controller?.resumeFromBackground();
					}
					startHeartbeat();
				} else {
					// inactiveを含む非表示中は画面用タイマーを止める。接続を切るのは完全な
					// backgroundだけにし、コントロールセンター等の短い中断では再接続を起こさない。
					stopHeartbeat();
					if (action === 'suspend' && !useAppStore.getState().manualOffline) {
						controller?.suspendForBackground();
					}
				}
			});
			if (shouldRunForegroundWork(RNAppState.currentState)) {
				startHeartbeat();
			}
			set({ ready: true, paired: !!creds });
			if (creds) {
				ensureNotificationPermission().catch(err => console.warn('[appState] notification permission request failed', err));
				controller.connect(creds);
				// KeyStore読込中にバックグラウンドへ移った場合、changeイベント時点ではまだ
				// clientが無い。接続作成直後にも現在状態を確認し、背景用ソケットを残さない。
				if (connectionActionForAppState(RNAppState.currentState) === 'suspend') {
					controller.suspendForBackground();
				}
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
		const previousCredentials = await loadCredentials(secureKeyStore);
		const payload: PairingPayload = decodePairingUri(uri);
		// 直前のペアリングが残っていれば畳んでから開始する。
		pairing?.cancel();
		const client = new PairingClient(identity, deviceName, rnSocketFactory);
		pairing = client;
		try {
			const creds: PairedCredentials = await client.pair(payload, { onSasCode: onSas });
			try {
				// 先に新資格情報をdurable化し、旧pair journalは後続reset成功まで保持する。
				// この順序ならKeychain書込失敗で旧pending/unknown記録を失わない。
				await saveCredentials(secureKeyStore, creds);
			} catch (error) {
				await revokeSelfOnRelay(creds);
				throw error;
			}
			try {
				await controller?.reset();
			} catch (error) {
				// resetは旧pairへ自動復帰する。永続資格情報も旧値へ補償して新pairを失効する。
				if (previousCredentials !== undefined) {
					await saveCredentials(secureKeyStore, previousCredentials);
				} else {
					await clearCredentials(secureKeyStore);
				}
				await revokeSelfOnRelay(creds);
				throw error;
			}
			set({ paired: true, browserSelection: undefined });
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
		try {
			// 資格情報削除が成功するまではcontroller/journalへ触れず、失敗時に旧pairを完全保持する。
			await clearCredentials(secureKeyStore);
			await deleteNotifyKey();
		} catch (error) {
			if (creds !== undefined) {
				await saveCredentials(secureKeyStore, creds);
			}
			throw error;
		}
		try {
			await controller?.reset();
		} catch (error) {
			// journal clear失敗時はresetが旧接続へ戻す。Keychain側も旧資格情報へ補償する。
			if (creds !== undefined) {
				await saveCredentials(secureKeyStore, creds);
				if (identity !== undefined) {
					const key = deriveNotifyKey(identity.secretKey, creds.pcPublicKey);
					await persistNotifyKey([...key].map(byte => byte.toString(16).padStart(2, '0')).join(''));
				}
			}
			throw error;
		}
		set({ paired: false, manualOffline: false, selectedWs: undefined, homeShowAllWorkspaces: true, selectedTerminalKey: undefined, browserSelection: undefined });
		// ローカル削除完了後にrelay資格情報をbest-effort失効する。失敗しても端末上のtokenは
		// 既に消えており、PC側からも後で失効できるためローカル解除は巻き戻さない。
		if (creds) {
			await revokeSelfOnRelay(creds).catch(error => console.warn('[appState] relay credential revocation failed after local unpair', error));
		}
	},

	discardUnknownTerminalOperations() {
		return controller?.discardUnknownTerminalOperations() ?? Promise.resolve(true);
	},

	attachTerminal(terminalKey: string) {
		controller?.attachTerminal(terminalKey);
	},

	detachTerminal(terminalKey: string) {
		controller?.detachTerminal(terminalKey);
	},

	renameTerminal(terminalKey: string, title: string) {
		controller?.renameTerminal(terminalKey, title);
	},

	closeTerminal(terminalKey: string) {
		controller?.closeTerminal(terminalKey);
	},

	ackAgentStatus(terminalKey: string) {
		controller?.ackAgentStatus(terminalKey);
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

	subscribeTerminal(terminalKey: string, listener: (ev: TermStreamEvent) => void) {
		return controller?.subscribeTerminal(terminalKey, listener) ?? (() => { });
	},

	sendInput(terminalKey: string, data: string) {
		return controller?.sendInput(terminalKey, data) ?? Promise.resolve(false);
	},

	sendLiveInput(terminalKey: string, data: string) {
		return controller?.sendLiveInput(terminalKey, data) ?? false;
	},

	sendArrowKey(terminalKey: string, key: 'up' | 'down' | 'right' | 'left') {
		controller?.sendArrowKey(terminalKey, key);
	},

	sendTextInput(terminalKey: string, text: string, execute: boolean) {
		return controller?.sendTextInput(terminalKey, text, execute) ?? Promise.resolve(false);
	},

	sendAgentMessage(terminalKey: string, text: string) {
		return controller?.sendAgentMessage(terminalKey, text) ?? Promise.resolve({ status: 'rejected' as const });
	},

	answerAgentQuestion(terminalKey: string, interactionId: string, answers: readonly AgentQuestionAnswer[]) {
		return controller?.answerAgentQuestion(terminalKey, interactionId, answers) ?? Promise.resolve(false);
	},

	answerAgentApproval(terminalKey: string, interactionId: string, choice: string) {
		return controller?.answerAgentApproval(terminalKey, interactionId, choice) ?? Promise.resolve(false);
	},

	updateClaudeSetting(terminalKey: string, setting: 'model' | 'effort', value: string) {
		return controller?.updateClaudeSetting(terminalKey, setting, value) ?? Promise.resolve(false);
	},

	requestAgentActivityDetail(terminalKey: string, activityId: string) {
		return controller?.requestAgentActivityDetail(terminalKey, activityId) ?? Promise.reject(new Error('not connected'));
	},

	createTerminal(ws?: string) {
		controller?.createTerminal(ws);
	},

	attachAgent(terminalKey: string) {
		controller?.attachAgent(terminalKey);
	},

	detachAgent(terminalKey: string) {
		controller?.detachAgent(terminalKey);
	},

	refreshAgent(terminalKey: string) {
		controller?.refreshAgent(terminalKey);
	},

	requestAgentModelCatalog(terminalKey: string) {
		controller?.requestAgentModelCatalog(terminalKey);
	},

	requestAgentCommandCatalog(terminalKey: string) {
		controller?.requestAgentCommandCatalog(terminalKey);
	},

	updateAgentSettings(terminalKey: string, model: string, effort: string) {
		controller?.updateAgentSettings(terminalKey, model, effort);
	},

	setSelectedWs(ws: string) {
		set({ selectedWs: ws, selectedTerminalKey: undefined });
	},

	setHomeShowAllWorkspaces(value: boolean) {
		set({ homeShowAllWorkspaces: value });
	},

	setSelectedTerminalKey(terminalKey: string | undefined) {
		set({ selectedTerminalKey: terminalKey });
	},

	setBrowserSelection(selection: { targetId: string; url: string; desktopEpoch: string } | undefined) {
		set({ browserSelection: selection });
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

	fsResolveLink(ws: string, path: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.fsResolveLink(ws, path);
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
