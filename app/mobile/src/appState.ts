// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * アプリ全体で共有する MobileController と接続状態の Zustand ストア。
 * 画面（screens）はここから状態を購読し、コントローラ経由で操作する。
 */

import { AppState as RNAppState } from 'react-native';
import { create } from 'zustand';
import type { Identity, PairingPayload } from '@para/protocol';
import { decodePairingUri, deriveNotifyKey } from '@para/protocol';
import { MobileController, clearCredentials, loadCredentials, loadOrCreateIdentity, reserveOperationRun, revokeSelfOnRelay, saveCredentials, type AgentActivityDetailMessage, type AgentMessageSendResult, type AgentQuestionAnswer, type AgentToolImage, type BrowserTargetsResult, type FsDocxResult, type FsFindResult, type FsMediaResult, type FsGrepResult, type FsHighlightResult, type FsListResult, type FsResolveLinkResult, type FsUploadResult, type FsPdfResult, type FsReadResult, type FsXlsxResult, type ScmCommitFilesResult, type ScmCommitResult, type ScmDiffResult, type ScmLogResult, type ScmStatusResult, type ScmXlsxDiffResult, type SpaceNoteResult, type StoreState, type SystemResourcesResult, type TermStreamEvent, type GithubUsageResult, type RateLimitsResult, type UsageDashboardResult, type WorktreeCreateResult, type WorktreeFormResult } from './store.js';
import { releaseArchivedOnAttention } from './archivedAgents.js';
import { DEFAULT_HOME_PREFERENCES, parseHomePreferences, type HomeListPreferences } from './homeSort.js';
import { toolImageCache } from './agentToolImages.js';
import { PairingClient } from './pairingClient.js';
import type { PairedCredentials } from './relayClient.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { setMobileDiagnosticCorrelationTag } from './mobileDiagnostics.js';
import { configureNotificationHandler, deleteNotifyKey, ensureNotificationPermission, getApnsDeviceToken, persistNotifyKey, presentLocalNotification, rnSocketFactory, secureKeyStore, terminalOperationOutboxStore } from './platform.js';
import { connectionActionForAppState, shouldRunForegroundWork } from './appLifecycle.js';
import { shouldPresentNotifyBanner } from './notificationPolicy.js';
import { activateVoiceSession, deactivateVoiceSession, enqueueVoiceClip, isVoiceSessionSupported, onVoiceSessionRemoteStop } from '../modules/para-voice-session/index.js';

/**
 * PC側とモバイル側の Sentry イベントを突き合わせる相関IDを設定する。
 * PC側と同じ規則（deviceId の SHA-256 先頭8桁）。生の deviceId は送らない。
 * 起動時だけでなくペアリング成立時にも呼ぶ（E2Eの版数不一致やハンドシェイク失敗は
 * まさに初回ペアリング直後に出るので、そのセッションで欠けていると突き合わせられない）。
 */
function applyPairingCorrelationTag(deviceId: string | undefined): void {
	if (deviceId !== undefined) {
		setMobileDiagnosticCorrelationTag('para.pairing', bytesToHex(sha256(new TextEncoder().encode(deviceId))).slice(0, 8));
	}
}

interface AppState extends StoreState {
	ready: boolean;
	paired: boolean;
	/** ユーザーがホームの切断ボタンで明示的に切断した状態（自動再接続を抑止）。 */
	manualOffline: boolean;
	/** ユーザー操作で開始する、PCからの音声通知受信状態。 */
	voiceNotifications: {
		desired: boolean;
		status: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'unsupported' | 'error';
		error?: string;
	};
	startVoiceNotifications(): void;
	stopVoiceNotifications(): void;
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
	/**
	 * ホーム一覧の並び替え・絞り込みの設定。見たい順序は人によって違うので選べるようにし、
	 * 端末へ保存して次回起動時も同じ見え方にする（判定は homeSort.ts）。
	 */
	homePreferences: HomeListPreferences;
	setHomePreferences(next: HomeListPreferences): void;
	/** ターミナル画面で選択中の論理キー（ws切替時はリセット）。 */
	selectedTerminalKey: string | undefined;
	setSelectedTerminalKey(terminalKey: string | undefined): void;
	/** ブラウザ画面を離れても最後のtarget/URLを静止画と一緒に復元するためのUIキャッシュ。 */
	browserSelection: { targetId: string; url: string; desktopEpoch: string } | undefined;
	setBrowserSelection(selection: { targetId: string; url: string; desktopEpoch: string } | undefined): void;
	/**
	 * 通知設定（設定画面）。ここでオフにした種別と、PC操作中の抑制は「バナーを出さない」
	 * であって「届かない」ではない（抑制された通知もアプリ内の通知一覧には残る）。
	 * 3つともPC側へ同期し、鳴らすべきかの判断はPC側の `paradisNotifyDelivery.ts` が持つ
	 * （アプリ未起動時のプッシュを送るかどうかもそこで決まるため、PCが知っている必要がある）。
	 */
	notifyPrefs: { agentDone: boolean; agentQuestion: boolean; suppressWhenPcFocused: boolean };
	setNotifyPref(key: 'agentDone' | 'agentQuestion' | 'suppressWhenPcFocused', enabled: boolean): void;
	/**
	 * いま開いているエージェント画面のターミナルキー。その画面を見ている間は同じエージェントの
	 * 通知バナーを出さない（画面に出ている内容をバナーで被せないため）。
	 */
	viewingTerminalKey: string | undefined;
	setViewingTerminalKey(terminalKey: string | undefined): void;
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
	 * アーカイブ状態（キーは pinKeyForTerminal 参照）。ピン留めと同じくこの端末ローカルのみで、
	 * PCへは同期しない。ホーム一覧から外すだけで、PC側のターミナルはそのまま動き続ける。
	 * 質問・応答待ちになったエージェントは自動で解除される（releaseArchivedOnAttention）。
	 */
	archivedKeys: Set<string>;
	setArchived(key: string, archived: boolean): void;
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
	answerAgentQuestion(terminalKey: string, interactionId: string, answers: readonly AgentQuestionAnswer[]): Promise<AgentMessageSendResult>;
	answerAgentApproval(terminalKey: string, interactionId: string, choice: string): Promise<AgentMessageSendResult>;
	updateClaudeSetting(terminalKey: string, setting: 'model' | 'effort', value: string): Promise<AgentMessageSendResult>;
	requestAgentActivityDetail(terminalKey: string, activityId: string): Promise<AgentActivityDetailMessage[]>;
	requestAgentToolFullText(terminalKey: string, rev: number): Promise<string>;
	requestAgentToolImage(terminalKey: string, rev: number, index: number): Promise<AgentToolImage>;
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
	createWorktree(opts: { repo: string; name?: string; branch?: string; base?: string; prompt?: string; agent?: string; model?: string; effort?: string; permission?: string; runSetup?: boolean }): Promise<WorktreeCreateResult>;
	/** 既存ワークスペースで新しいターミナルを作ってエージェントCLIを起動する（ホームの＋ボタン）。 */
	launchAgent(opts: { ws: string; agent: string; prompt?: string; model?: string; effort?: string; permission?: string }): Promise<void>;
	/** スペースのメモ本文（PC版 Workspaces ビュー下部のメモ欄と同じ内容）。 */
	noteGet(ws: string): Promise<SpaceNoteResult>;
	/** スペースのメモ本文を更新する。 */
	noteSet(ws: string, text: string): Promise<SpaceNoteResult>;
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
	/** Rate Limit(AIリミット)スナップショット。bypassCache の意味は usageDashboard と同じ。 */
	rateLimits(bypassCache?: boolean): Promise<RateLimitsResult>;
	/** GitHub API利用状況。bypassCache の意味は usageDashboard と同じ。 */
	githubUsage(bypassCache?: boolean): Promise<GithubUsageResult>;
	/** PC本体のリソース内訳（「システム」画面）。bypassCache の意味は usageDashboard と同じ。 */
	systemResources(bypassCache?: boolean): Promise<SystemResourcesResult>;
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
	/** 音声通知（PCが作ったMP3のリレー配信）の購読制御。 */
	voiceSubscribe(sid: string): Promise<{ ok?: boolean }>;
	voiceUnsubscribe(sid: string): void;
	setVoiceClipHandler(sid: string, handler: (base64: string) => void): void;
	/** sid が現在登録中のハンドラと一致する場合のみ解除する。 */
	clearVoiceClipHandler(sid: string): void;
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
/** 受信中の音声通知セッションID（PC側の配信対象を識別する）。 */
let voiceSid: string | undefined;
/**
 * ネイティブの音声セッション操作を直列化するチェーン。
 * Expo の AsyncFunction は呼び出しごとに並行実行されるため、停止直後に再開すると
 * 後着した deactivate がセッションを畳んでしまう（JSの呼び出し順は保証にならない）。
 */
let voiceNativeChain: Promise<void> = Promise.resolve();
/** 接続復帰で購読を送り直す購読の多重登録防止。 */
let voiceResubscribeSubscribed = false;
let voiceRetryTimer: ReturnType<typeof setTimeout> | undefined;
let voiceGeneration = 0;
let voiceRemoteStopSubscription: (() => void) | undefined;
/** 購読の再宣言間隔。PCはリレー切断で購読を忘れるため、受信中は送り直し続ける。 */
const VOICE_RESUBSCRIBE_MS = 20_000;
const VOICE_RETRY_MS = 3_000;
let connectionHeartbeat: ReturnType<typeof setInterval> | undefined;

function stopConnectionHeartbeat(): void {
	if (connectionHeartbeat !== undefined) {
		clearInterval(connectionHeartbeat);
		connectionHeartbeat = undefined;
	}
}

function startConnectionHeartbeat(): void {
	stopConnectionHeartbeat();
	connectionHeartbeat = setInterval(() => {
		if (!useAppStore.getState().manualOffline) {
			controller?.ensureConnected();
		}
	}, 25_000);
}

function runVoiceNative(operation: () => Promise<void>): Promise<void> {
	const next = voiceNativeChain.then(operation, operation);
	voiceNativeChain = next.catch(() => { /* 後続の操作は前段の失敗に引きずられない */ });
	return next;
}

function clearVoiceRetry(): void {
	if (voiceRetryTimer !== undefined) {
		clearTimeout(voiceRetryTimer);
		voiceRetryTimer = undefined;
	}
}

function scheduleVoiceReconnect(generation: number, message?: string): void {
	if (generation !== voiceGeneration || !useAppStore.getState().voiceNotifications.desired) {
		return;
	}
	clearVoiceRetry();
	useAppStore.setState({ voiceNotifications: { desired: true, status: 'reconnecting', ...(message ? { error: message } : {}) } });
	voiceRetryTimer = setTimeout(() => {
		voiceRetryTimer = undefined;
		void connectVoiceMonitor(generation);
	}, VOICE_RETRY_MS);
}

/**
 * PCへ「音声通知を受け取る」と宣言する。成功したら一定間隔で宣言し直し、
 * リレーが張り直された場合もPC側の配信対象へ戻る。
 */
async function connectVoiceMonitor(generation: number): Promise<void> {
	if (generation !== voiceGeneration) {
		return;
	}
	const state = useAppStore.getState();
	const sid = voiceSid;
	if (!state.voiceNotifications.desired || sid === undefined) {
		return;
	}
	if (state.sessionProtocolReady && state.workspace !== undefined && state.workspace.voiceClips !== 'relay-v1') {
		endVoiceNotifications();
		useAppStore.setState({ voiceNotifications: { desired: false, status: 'unsupported', error: 'PC版のPara Codeを音声通知対応版へ更新してください' } });
		return;
	}
	if (!state.pcOnline || !state.sessionProtocolReady) {
		scheduleVoiceReconnect(generation, 'PCへの接続を待っています');
		return;
	}
	try {
		await state.voiceSubscribe(sid);
		if (generation !== voiceGeneration || !useAppStore.getState().voiceNotifications.desired) {
			return;
		}
		if (useAppStore.getState().voiceNotifications.status !== 'live') {
			useAppStore.setState({ voiceNotifications: { desired: true, status: 'live' } });
		}
		clearVoiceRetry();
		voiceRetryTimer = setTimeout(() => {
			voiceRetryTimer = undefined;
			void connectVoiceMonitor(generation);
		}, VOICE_RESUBSCRIBE_MS);
	} catch (error) {
		const message = error instanceof Error ? error.message : '音声接続に失敗しました';
		scheduleVoiceReconnect(generation, message);
	}
}

async function beginVoiceNotifications(): Promise<void> {
	if (!isVoiceSessionSupported()) {
		useAppStore.setState({ voiceNotifications: { desired: false, status: 'unsupported', error: 'このビルドでは音声通知を利用できません' } });
		return;
	}
	const initialState = useAppStore.getState();
	if (initialState.sessionProtocolReady && initialState.workspace !== undefined && initialState.workspace.voiceClips !== 'relay-v1') {
		useAppStore.setState({ voiceNotifications: { desired: false, status: 'unsupported', error: 'PC版のPara Codeを音声通知対応版へ更新してください' } });
		return;
	}
	const generation = ++voiceGeneration;
	clearVoiceRetry();
	const sid = `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	voiceSid = sid;
	useAppStore.setState({ voiceNotifications: { desired: true, status: 'connecting' } });
	try {
		await runVoiceNative(activateVoiceSession);
		if (generation !== voiceGeneration) {
			return;
		}
		voiceRemoteStopSubscription?.();
		voiceRemoteStopSubscription = onVoiceSessionRemoteStop(() => useAppStore.getState().stopVoiceNotifications());
		useAppStore.getState().setVoiceClipHandler(sid, base64 => {
			void enqueueVoiceClip(base64).catch(() => { /* 再生できないクリップは捨てる */ });
		});
		await connectVoiceMonitor(generation);
	} catch (error) {
		if (generation !== voiceGeneration) {
			return;
		}
		const message = error instanceof Error ? error.message : '音声通知を開始できませんでした';
		voiceSid = undefined;
		useAppStore.getState().clearVoiceClipHandler(sid);
		useAppStore.setState({ voiceNotifications: { desired: false, status: 'error', error: message } });
		await runVoiceNative(deactivateVoiceSession).catch(() => { /* 停止の失敗は表示済みのエラーへ足さない */ });
	}
}

function endVoiceNotifications(): void {
	voiceGeneration++;
	clearVoiceRetry();
	const sid = voiceSid;
	voiceSid = undefined;
	if (sid !== undefined) {
		const state = useAppStore.getState();
		state.clearVoiceClipHandler(sid);
		state.voiceUnsubscribe(sid);
	}
	voiceRemoteStopSubscription?.();
	voiceRemoteStopSubscription = undefined;
	useAppStore.setState({ voiceNotifications: { desired: false, status: 'idle' } });
	void runVoiceNative(deactivateVoiceSession).catch(() => { /* 停止できなくても操作は完了扱い */ });
	if (connectionActionForAppState(RNAppState.currentState) === 'suspend' && !useAppStore.getState().manualOffline) {
		stopConnectionHeartbeat();
		controller?.suspendForBackground();
	}
}

export const useAppStore = create<AppState>(set => ({
	connection: 'offline',
	pcOnline: false,
	sessionProtocolReady: false,
	pushRegistered: undefined,
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
	voiceNotifications: { desired: false, status: 'idle' },
	selectedWs: undefined,
	homeShowAllWorkspaces: true,
	homePreferences: DEFAULT_HOME_PREFERENCES,
	selectedTerminalKey: undefined,
	browserSelection: undefined,
	// suppressWhenPcFocused の既定はオン。PCの前にいる間もスマホが鳴るのが通知過多の
	// 主因だったため、席を外している間だけ鳴る側を既定にしている（PC側の既定と揃えてある）。
	// 一度でも設定画面で触ればその値が保存され、以降はこの既定を使わない。
	notifyPrefs: { agentDone: true, agentQuestion: true, suppressWhenPcFocused: true },
	viewingTerminalKey: undefined,
	pinnedKeys: new Set(),
	archivedKeys: new Set(),
	agentDrafts: {},

	startVoiceNotifications() {
		if (!useAppStore.getState().voiceNotifications.desired) {
			void beginVoiceNotifications();
		}
	},

	stopVoiceNotifications() {
		endVoiceNotifications();
	},

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
			applyPairingCorrelationTag(creds?.deviceId);
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
							// `!== false` にしておく: この設定が追加される前の版で通知トグルを触った人は
							// このキーが欠けた記録を持っており、`=== true` だと新しい既定（オン）が
							// その人たちにだけ効かない。明示的にオフにした人だけがオフになる。
							suppressWhenPcFocused: parsed.suppressWhenPcFocused !== false,
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
			// アーカイブ状態をロード（保存が無い/壊れている場合は空集合のまま）
			try {
				const raw = await secureKeyStore.getItem('archivedTerminals');
				if (raw) {
					const parsed = JSON.parse(raw) as unknown;
					if (Array.isArray(parsed)) {
						set({ archivedKeys: new Set(parsed.filter((k): k is string => typeof k === 'string')) });
					}
				}
			} catch (err) {
				console.warn('[appState] failed to load archivedTerminals', err);
			}
			// ホーム一覧の並び替え・絞り込み設定をロード（保存が無い/壊れている場合は既定のまま）
			try {
				const raw = await secureKeyStore.getItem('homeListPreferences');
				if (raw) {
					set({ homePreferences: parseHomePreferences(JSON.parse(raw) as unknown) });
				}
			} catch (err) {
				console.warn('[appState] failed to load homeListPreferences', err);
			}
			controller = new MobileController(
				identity,
				rnSocketFactory,
				s => {
					// 状態が届くたびにアーカイブの印を点検する（回答待ちになったものは
					// 一覧へ戻し、消えたターミナルの印は捨てる）。archivedAgents.ts 参照。
					// workspace が無い間（切断時にクリアされる）は点検しない。ターミナルが
					// 0件に見えるため、全部の印を「消えたターミナル」として捨ててしまう。
					const archivedKeys = useAppStore.getState().archivedKeys;
					const nextArchived = s.workspace !== undefined
						? releaseArchivedOnAttention(archivedKeys, s.workspace.terminals)
						: archivedKeys;
					if (nextArchived !== archivedKeys) {
						const value = nextArchived as Set<string>;
						set({ archivedKeys: value });
						secureKeyStore.setItem('archivedTerminals', JSON.stringify([...value])).catch(err => console.warn('[appState] failed to save archivedTerminals', err));
					}
					set({ ...s });
				},
				payload => {
					// バナーを出すかの判断は notificationPolicy.ts に集約してある
					// （届いた通知を一覧へ入れるのは store 側で、そちらは無条件）。
					const state = useAppStore.getState();
					if (!shouldPresentNotifyBanner(payload, {
						appState: RNAppState.currentState,
						prefs: state.notifyPrefs,
						viewingTerminalKey: state.viewingTerminalKey,
						pushRegistered: state.pushRegistered,
						now: Date.now(),
					})) {
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
			// 音声通知の購読はPC側で揮発する（リレー切断・ソケット張り直しで消える）。
			// 20秒の定期再宣言だけだと復帰まで無音が続くため、オンラインへ戻った瞬間に送り直す。
			if (!voiceResubscribeSubscribed) {
				voiceResubscribeSubscribed = true;
				useAppStore.subscribe((next, prev) => {
					const recovered = (next.connection === 'online' && prev.connection !== 'online')
						|| (next.pcOnline && !prev.pcOnline)
						|| (next.sessionProtocolReady && !prev.sessionProtocolReady);
					if (recovered && next.voiceNotifications.desired) {
						clearVoiceRetry();
						void connectVoiceMonitor(voiceGeneration);
					}
				});
			}
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
			// inactive（通知センターやコントロールセンターを引き下げた、システムのダイアログが
			// 乗った等）はソケットを維持するので、心拍も止めない。止めるとPC側から「無音が
			// 続いた＝アプリが凍った」と見えてプッシュが飛び、前面で見ている画面にまでバナーが
			// 出る（PC側の判断材料は最後に受け取った時刻なので、黙るとそう見える）。
			RNAppState.addEventListener('change', appState => {
				const action = connectionActionForAppState(appState);
				if (action === 'resume') {
					if (!useAppStore.getState().manualOffline) {
						controller?.resumeFromBackground();
					}
					startConnectionHeartbeat();
				} else if (action === 'suspend') {
					const state = useAppStore.getState();
					// 音声通知を明示的に開始している間は、PCから届く音声クリップの受信に
					// Relay が必要なため、バックグラウンドでもソケットと心拍を維持する。
					if (!state.voiceNotifications.desired) {
						stopConnectionHeartbeat();
					}
					if (!state.manualOffline && !state.voiceNotifications.desired) {
						controller?.suspendForBackground();
					}
				}
			});
			if (shouldRunForegroundWork(RNAppState.currentState)) {
				startConnectionHeartbeat();
			}
			set({ ready: true, paired: !!creds });
			if (creds) {
				ensureNotificationPermission().catch(err => console.warn('[appState] notification permission request failed', err));
				controller.connect(creds);
				// KeyStore読込中にバックグラウンドへ移った場合、changeイベント時点ではまだ
				// clientが無い。接続作成直後にも現在状態を確認し、背景用ソケットを残さない。
				if (connectionActionForAppState(RNAppState.currentState) === 'suspend' && !useAppStore.getState().voiceNotifications.desired) {
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
		endVoiceNotifications();
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
				applyPairingCorrelationTag(creds.deviceId);
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
		endVoiceNotifications();
		const creds = await loadCredentials(secureKeyStore);
		try {
			// 資格情報削除が成功するまではcontroller/journalへ触れず、失敗時に旧pairを完全保持する。
			await clearCredentials(secureKeyStore);
			await deleteNotifyKey();
		} catch (error) {
			if (creds !== undefined) {
				await saveCredentials(secureKeyStore, creds);
				applyPairingCorrelationTag(creds.deviceId);
			}
			throw error;
		}
		try {
			await controller?.reset();
		} catch (error) {
			// journal clear失敗時はresetが旧接続へ戻す。Keychain側も旧資格情報へ補償する。
			if (creds !== undefined) {
				await saveCredentials(secureKeyStore, creds);
				applyPairingCorrelationTag(creds.deviceId);
				if (identity !== undefined) {
					const key = deriveNotifyKey(identity.secretKey, creds.pcPublicKey);
					await persistNotifyKey([...key].map(byte => byte.toString(16).padStart(2, '0')).join(''));
				}
			}
			throw error;
		}
		set({ paired: false, manualOffline: false, selectedWs: undefined, homeShowAllWorkspaces: true, selectedTerminalKey: undefined, browserSelection: undefined });
		// PC画面の一部が写り込んだ画像をメモリに残さない（取得済みの画像はストア外のキャッシュにある）。
		toolImageCache.clear();
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

	setArchived(key: string, archived: boolean) {
		const current = useAppStore.getState().archivedKeys;
		if (current.has(key) === archived) {
			return;
		}
		const next = new Set(current);
		if (archived) {
			next.add(key);
		} else {
			next.delete(key);
		}
		set({ archivedKeys: next });
		secureKeyStore.setItem('archivedTerminals', JSON.stringify([...next])).catch(err => console.warn('[appState] failed to save archivedTerminals', err));
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
		return controller?.answerAgentQuestion(terminalKey, interactionId, answers)
			?? Promise.resolve<AgentMessageSendResult>({ status: 'rejected', message: 'PCとの接続が切れています' });
	},

	answerAgentApproval(terminalKey: string, interactionId: string, choice: string) {
		return controller?.answerAgentApproval(terminalKey, interactionId, choice)
			?? Promise.resolve<AgentMessageSendResult>({ status: 'rejected', message: 'PCとの接続が切れています' });
	},

	updateClaudeSetting(terminalKey: string, setting: 'model' | 'effort', value: string) {
		return controller?.updateClaudeSetting(terminalKey, setting, value)
			?? Promise.resolve<AgentMessageSendResult>({ status: 'rejected', message: 'PCとの接続が切れています' });
	},

	requestAgentActivityDetail(terminalKey: string, activityId: string) {
		return controller?.requestAgentActivityDetail(terminalKey, activityId) ?? Promise.reject(new Error('not connected'));
	},

	requestAgentToolFullText(terminalKey: string, rev: number) {
		return controller?.requestAgentToolFullText(terminalKey, rev) ?? Promise.reject(new Error('not connected'));
	},

	requestAgentToolImage(terminalKey: string, rev: number, index: number) {
		return controller?.requestAgentToolImage(terminalKey, rev, index) ?? Promise.reject(new Error('not connected'));
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

	setHomePreferences(next: HomeListPreferences) {
		set({ homePreferences: next });
		secureKeyStore.setItem('homeListPreferences', JSON.stringify(next)).catch(err => console.warn('[appState] failed to save homeListPreferences', err));
	},

	setSelectedTerminalKey(terminalKey: string | undefined) {
		set({ selectedTerminalKey: terminalKey });
	},

	setBrowserSelection(selection: { targetId: string; url: string; desktopEpoch: string } | undefined) {
		set({ browserSelection: selection });
	},

	setViewingTerminalKey(terminalKey: string | undefined) {
		set({ viewingTerminalKey: terminalKey });
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

	createWorktree(opts: { repo: string; name?: string; branch?: string; base?: string; prompt?: string; agent?: string; model?: string; effort?: string; permission?: string; runSetup?: boolean }) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.createWorktree(opts);
	},

	launchAgent(opts: { ws: string; agent: string; prompt?: string; model?: string; effort?: string; permission?: string }) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.launchAgent(opts);
	},

	noteGet(ws: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.noteGet(ws);
	},

	noteSet(ws: string, text: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.noteSet(ws, text);
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

	rateLimits(bypassCache?: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.rateLimits(bypassCache);
	},

	githubUsage(bypassCache?: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.githubUsage(bypassCache);
	},

	systemResources(bypassCache?: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.systemResources(bypassCache);
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

	voiceSubscribe(sid) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.voiceSubscribe(sid);
	},

	voiceUnsubscribe(sid) {
		controller?.voiceUnsubscribe(sid);
	},

	setVoiceClipHandler(sid, handler) {
		if (controller) {
			controller.voiceClipHandler = { sid, fn: handler };
		}
	},

	clearVoiceClipHandler(sid) {
		if (controller && controller.voiceClipHandler?.sid === sid) {
			controller.voiceClipHandler = undefined;
		}
	},

	fetchTurnIceServers() {
		return controller?.fetchTurnIceServers() ?? Promise.resolve([]);
	},
}));
