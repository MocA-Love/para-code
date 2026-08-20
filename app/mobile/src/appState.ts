// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * アプリ全体で共有する MobileController と接続状態の Zustand ストア。
 * 画面（screens）はここから状態を購読し、コントローラ経由で操作する。
 */

import { AppState as RNAppState } from 'react-native';
import { create } from 'zustand';
import { decodePairingUri, deriveNotifyKey, type Identity, type NotifyPayload, type PairingPayload } from '@para/protocol';
import { MobileController, MobileWarmLeaseControllerRegistry, createEmptyStoreState, loadOrCreateIdentity, reserveOperationRun, revokeSelfOnRelay, isAgentWaiting, type AgentActivityDetailMessage, type AgentMessageSendResult, type AgentQuestionAnswer, type AgentToolImage, type BrowserTargetsResult, type FsDocxResult, type FsFindResult, type FsMediaResult, type FsGrepResult, type FsHighlightResult, type FsListResult, type FsResolveLinkResult, type FsUploadResult, type FsPdfResult, type FsReadResult, type FsXlsxResult, type MobileDisposable, type MobileWarmLeaseController, type ScmCommitFilesResult, type ScmCommitResult, type ScmDiffResult, type ScmLogResult, type ScmStatusResult, type ScmXlsxDiffResult, type SpaceDiskResult, type PresetDef, type PresetListResult, type PresetRunResult, type SpaceNoteResult, type StoreState, type SystemResourcesResult, type TermStreamEvent, type GithubUsageResult, type RateLimitsResult, type RtkSavingsResult, type UsageDashboardResult, type WorktreeCreateResult, type WorktreeFormResult } from './store.js';
import { releaseArchivedOnAttention } from './archivedAgents.js';
import { DEFAULT_HOME_PREFERENCES, parseHomePreferences, type HomeListPreferences } from './homeSort.js';
import { toolImageCache } from './agentToolImages.js';
import { PairingClient } from './pairingClient.js';
import {
	applyReportedPcName,
	loadActivePcId,
	loadPairedPcs,
	nextFallbackPcName,
	parseScopedKeys,
	sanitizePcName,
	deleteLegacyCredentials,
	savePairedPcs,
	saveActivePcId,
	scopedKeysFor,
	withScopedKeys,
	type PairedPc,
	type ScopedKeyRecord,
} from './pcs.js';
import type { ConnectionState, PairedCredentials } from './relayClient.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { setMobileDiagnosticCorrelationTag } from './mobileDiagnostics.js';
import { configureNotificationHandler, createTerminalOperationOutboxStore, deleteLegacyNotifyKey, deleteNotifyKey, ensureNotificationPermission, getApnsDeviceToken, migrateLegacyTerminalOperationOutbox, persistNotifyKey, presentLocalNotification, rnSocketFactory, secureKeyStore } from './platform.js';
import { connectionActionForAppState, shouldRunForegroundWork } from './appLifecycle.js';
import { shouldPresentNotifyBanner } from './notificationPolicy.js';
import { notifySubtitle } from './notifyPresentation.js';
import { DEFAULT_TERMINAL_PREFS, normalizeTerminalPrefs, type TerminalPrefs, type TerminalViewport } from './terminalViewport.js';
import { MobileVoiceLifecycle } from './voiceLifecycle.js';
import { activateVoiceSession, deactivateVoiceSession, enqueueVoiceClip, isVoiceSessionSupported, onVoiceSessionRemoteStop } from '../modules/para-voice-session/index.js';

/**
 * PC側とモバイル側の Sentry イベントを突き合わせる相関IDを設定する。
 * PC側と同じ規則（deviceId の SHA-256 先頭8桁）。生の deviceId は送らない。
 * 起動時だけでなくペアリング成立時にも呼ぶ（E2Eの版数不一致やハンドシェイク失敗は
 * まさに初回ペアリング直後に出るので、そのセッションで欠けていると突き合わせられない）。
 */
function applyPairingCorrelationTag(deviceId: string | undefined): void {
	// 相手がいなくなったら（最後のPCを解除した）タグも空にする。残すと、解除済みPCの
	// 識別子由来の値がその後の診断イベントに付き続ける。
	setMobileDiagnosticCorrelationTag(
		'para.pairing',
		deviceId !== undefined ? bytesToHex(sha256(new TextEncoder().encode(deviceId))).slice(0, 8) : '',
	);
}

/**
 * PC切り替えUI（ドロワーのPCカード/シート）が使う、ペアリング済みPC1台ぶんの見え方。
 * いま見ていないPCも接続を保っている限り件数まで分かるので、切り替える前に
 * 「どのPCで待たれているか」が見える。
 */
export interface PcSummary {
	readonly id: string;
	readonly name: string;
	/**
	 * 一覧の色分けに使う安定した値（PCの長期公開鍵から作る）。
	 * 並び順から決めると、台帳の順が入れ替わったときに同じPCの色が変わってしまう。
	 * 同じ名前を名乗るPCが2台あっても、色が違えば別物だと気づける。
	 */
	readonly hue: number;
	/** そのPCとのリレー接続の状態（いま見ているPC以外も接続を保つ設定なら 'online' になりうる）。 */
	readonly connection: ConnectionState;
	/** リレーの向こうでPara Codeが動いているか。 */
	readonly pcOnline: boolean;
	readonly workspaces: number;
	readonly terminals: number;
	/** 応答待ち（質問・承認）のエージェント数。 */
	readonly waiting: number;
	/** 最後にPCがオンラインだと確認できた時刻（一度も繋がっていなければ undefined）。 */
	readonly lastOnlineAt: number | undefined;
	/**
	 * そのPCのバッテリー（ノートPCのみ。デスクトップや未対応の版では undefined）。
	 * 一覧の行に出すため、いま見ているPCだけでなく全PCぶんをここに載せる。
	 */
	readonly battery: { readonly level: number; readonly charging: boolean } | undefined;
}

interface AppState extends StoreState {
	ready: boolean;
	paired: boolean;
	/** ペアリング済みPCの一覧（台帳の順）。 */
	pcs: PcSummary[];
	/** いま画面が見ているPC。 */
	activePcId: string | undefined;
	/** 同じPCの再pairを含む active controller オブジェクトの交代世代。 */
	controllerRevision: number;
	/** windowId を指定すると、その接続先（ローカル/SSHリモート）へ warm lease を固定する。 */
	acquireUsageWarmLease(windowId?: number): MobileDisposable;
	acquireSpaceDiskWarmLease(): MobileDisposable;
	/**
	 * 見ていないPCとも接続を保つか。オフにすると、いま見ているPC以外は切断して
	 * プッシュ通知だけで様子を知る（モバイル回線の通信量を抑えたい人向け。既定はオン）。
	 */
	keepBackgroundPcs: boolean;
	setKeepBackgroundPcs(value: boolean): void;
	/**
	 * 見ていないPCからの通知をバナーで出すか（既定はオン）。オフでも通知一覧には残る。
	 * PC側の通知設定（notifyPrefs）とは別で、こちらは端末内の判断。
	 */
	notifyOtherPcs: boolean;
	setNotifyOtherPcs(value: boolean): void;
	/** 見ているPCを切り替える。未知のIDは無視する。 */
	switchPc(id: string): void;
	/**
	 * 「PCを選ぶ」以外の目的のついでに起きる切り替え（通知タップ、他PCの使用量を開く等）。
	 * 切り替わったことを画面上部で知らせ、直前のPCへ戻れるようにする。
	 *
	 * 切り替えは見た目以上に大きい操作で、開いていたスペース・ターミナルの選択が外れる。
	 * ユーザーが自分で選んだのでなければ、戻る手段を必ず添える。
	 */
	switchPcWithReturn(id: string): void;
	/** PCの表示名を変える（以後PCから届く名前で上書きされない）。 */
	renamePc(id: string, name: string): Promise<void>;
	/** そのPCとのペアリングだけを解除する。 */
	removePc(id: string): Promise<void>;
	/**
	 * 通知タップなどで自動的にPCが切り替わったときの告知（画面上部のトースト）。
	 * `previousPcId` があれば「戻る」で元のPCへ帰れる。
	 */
	pcSwitchNotice: { readonly pcId: string; readonly name: string; readonly previousPcId: string | undefined } | undefined;
	dismissPcSwitchNotice(): void;
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
	 * 「接続先セグメント」(rtk/ccusage/rate limit) で選択中の接続先ID（`RelayHost.id`）。
	 * 4画面で共有する（`selectedWs` と同じ作法。永続化しない、PC切替・ペアリング解除で
	 * リセットする）。選んだ接続先が一覧から消えても自動で他へは移さない
	 * （別マシンの数字を同じUIで見せてしまう取り違えを避けるため）。
	 */
	selectedHostId: string | undefined;
	setSelectedHost(id: string): void;
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
	/**
	 * iPadの常設サイドバーを畳んでいるか（アイコンのみのレール表示）。狭い幅（iPhone、
	 * Split View/Slide Over）では意味を持たない。端末に保存し、次回起動時も同じ見え方にする。
	 */
	sidebarCollapsed: boolean;
	setSidebarCollapsed(value: boolean): void;
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
	 * ターミナル表示の設定（設定 →「ターミナル」）。この端末の中だけの設定で、PCへは
	 * 送らない（PCが持つと複数台のスマホで奪い合いになる）。`matchPcWidth` を入れた
	 * ときだけ、いま見ているターミナルの寸法申告がPCへ届く。
	 */
	terminalPrefs: TerminalPrefs;
	setTerminalPref<K extends keyof TerminalPrefs>(key: K, value: TerminalPrefs[K]): void;
	/**
	 * ターミナル画面が実測した「読める寸法」をPCへ申告する（PTYをこの寸法へ寄せてもらう）。
	 * `undefined` で申告を取り下げる（画面を離れた・設定オフ）。
	 */
	setTerminalViewport(viewport: TerminalViewport | undefined): void;
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
	/** QRから読み取ったURIでペアリングする。SAS表示はonSasで受ける。成立したPCへ切り替わる。 */
	pairFromUri(uri: string, deviceName: string, onSas: (code: string) => void): Promise<void>;
	/** 進行中のペアリングを中断する（ペアリング画面から離脱したとき等）。 */
	cancelPairing(): void;
	/** すべてのPCとのペアリングを解除する（リレー上の資格情報も失効させ、ローカルの保存分も削除する）。 */
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
	 * コマンドプリセットのうち、この端末では一覧に出さないもの（キーは PresetDef.key）。
	 * ピン留めと同じくこの端末ローカルのみで、PCへは同期しない（複数のスマホや iPad で
	 * 取り合いになるため。プリセットの定義そのものはPC側でしか編集できない）。
	 */
	presetHiddenKeys: Set<string>;
	setPresetHidden(key: string, hidden: boolean): void;
	/**
	 * 実行してよいと一度言ったプリセットの鍵（presetApprovalKey ＝ key とPCが出した署名）。
	 * PC側の autoRun と同じ流儀で、初回だけ内容を見せて確認し、コマンドや作業ディレクトリが
	 * 書き換わったらもう一度確認する。**コマンド本文はここに残さない**（署名だけで足りる）。
	 */
	presetApprovedSignatures: Set<string>;
	approvePreset(signature: string): void;
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
	/** TUI上のスワイプによるスクロール（送れなくても再試行しない）。 */
	scrollTerminal(terminalKey: string, dir: 'up' | 'down', lines: number): void;
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
	/** そのスペースで使えるコマンドプリセット一覧（PC版のピン留めボタンと同じ定義）。 */
	presetList(ws: string): Promise<PresetListResult>;
	/**
	 * コマンドプリセットを実行する（PC側は必ず新しいターミナルを作る）。
	 * signature は一覧で受け取った承認署名。PCが実行の直前に作り直して突き合わせるので、
	 * 手元で確認したあとに定義が書き換わっていれば実行されない。
	 */
	presetRun(ws: string, key: string, signature: string): Promise<PresetRunResult>;
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
	/**
	 * ccusage 使用量ダッシュボード。bypassCache=true で shared process 側の TTL キャッシュを無視して再取得する。
	 * windowId を指定すると、その接続先（ローカル/SSHリモート）で取得した値を返す（「接続先セグメント」向け）。
	 */
	usageDashboard(bypassCache?: boolean, windowId?: number): Promise<UsageDashboardResult>;
	/** RTK(Rust Token Killer)の節約状況。bypassCache/windowId の意味は usageDashboard と同じ。 */
	rtkSavings(bypassCache?: boolean, windowId?: number): Promise<RtkSavingsResult>;
	/** Rate Limit(AIリミット)スナップショット。bypassCache/windowId の意味は usageDashboard と同じ。 */
	rateLimits(bypassCache?: boolean, windowId?: number): Promise<RateLimitsResult>;
	/** GitHub API利用状況。bypassCache の意味は usageDashboard と同じ。 */
	githubUsage(bypassCache?: boolean): Promise<GithubUsageResult>;
	/** PC本体のリソース内訳（「システム」画面）。bypassCache の意味は usageDashboard と同じ。 */
	systemResources(bypassCache?: boolean): Promise<SystemResourcesResult>;
	/**
	 * スペースごとのディスク使用量（「システム」画面のボリューム内訳）。
	 * PC側が1時間ごとに測っておくので通常は即座に返る。bypassCache は測り直しで数十秒〜数分かかる。
	 */
	spaceDisk(bypassCache?: boolean): Promise<SpaceDiskResult>;
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
/** 進行中のペアリングクライアント（cancelPairing で中断するため保持）。 */
let pairing: PairingClient | undefined;

/**
 * ペアリング済みPC1台ぶんの実行時の持ち物。
 *
 * `controller` はPCごとに独立していて、いま見ていないPCのぶんも（設定が許す限り）繋いだままにする。
 * 見ていないPCの `state` はストアへ流さず、ここに退避しておく。切り替えたときに、そのPCの
 * 現在の状態をそのまま画面へ載せ替えられるようにするため。
 */
interface PcRuntime {
	pc: PairedPc;
	readonly controller: MobileController;
	/** そのコントローラが最後に報告した状態（アクティブなら画面と同じ内容）。 */
	state: StoreState;
	lastOnlineAt: number | undefined;
	/**
	 * 一度でも connect() を呼んだか。コントローラは初回だけ資格情報を渡す必要があり
	 * （以後は自分で覚えている）、繋ぎ直しは reconnect() で行う。
	 */
	started: boolean;
	/** そのPCで書きかけだったコンポーザーの下書き（切り替えて戻ったときに復元する）。 */
	drafts: Record<string, string>;
}

/** deviceId → 実行時。台帳の順序は `pcOrder` が持つ（Mapの挿入順に依存しない）。 */
const runtimes = new Map<string, PcRuntime>();
let pcOrder: string[] = [];
let activePcId: string | undefined;
/**
 * いま見ているPCのコントローラ。画面から呼ぶ操作はすべてこれを通す
 * （切り替えのたびに付け替えるので、各アクションは常にアクティブなPCへ届く）。
 */
let controller: MobileController | undefined;

/** active controller と Zustand へ公開する revision を同じ遷移で更新する appState 境界。 */
export class MobileWarmLeaseAppStateBridge<T extends MobileWarmLeaseController = MobileWarmLeaseController> {
	private controller: T | undefined;
	private readonly controllers = new MobileWarmLeaseControllerRegistry();

	replace(next: T | undefined): { readonly controller: T | undefined; readonly controllerRevision: number } {
		if (this.controller !== next) {
			this.controllers.replace(next);
			this.controller = next;
		}
		return { controller: this.controller, controllerRevision: this.controllers.revision };
	}

	acquireUsageWarmLease(windowId?: number): MobileDisposable {
		return this.controllers.acquire('ccusage', windowId);
	}

	acquireSpaceDiskWarmLease(): MobileDisposable {
		return this.controllers.acquire('spaceDisk');
	}
}

const warmLeaseAppState = new MobileWarmLeaseAppStateBridge<MobileController>();

function replaceActiveController(next: MobileController | undefined): number {
	const transition = warmLeaseAppState.replace(next);
	controller = transition.controller;
	return transition.controllerRevision;
}
/** ピン留め・アーカイブのPC別記録（保存形はPC ID → キー配列）。 */
let pinnedRecord: ScopedKeyRecord = {};
let archivedRecord: ScopedKeyRecord = {};
/**
 * コマンドプリセットの「一覧に出さないもの」と「実行を承認済みのもの」のPC別記録。
 * プリセットの定義はPCごとに違うので、ピン留めと同じくPC IDで分ける。
 */
let presetHiddenRecord: ScopedKeyRecord = {};
let presetApprovedRecord: ScopedKeyRecord = {};
/**
 * このアプリ起動ぶんのターミナル操作の世代（init で1つ予約する）。
 * あとから足したPCのコントローラにも同じ値を渡す（操作IDはコントローラごとの
 * ランダムな接頭辞を持つので、PCをまたいで衝突しない）。
 */
let currentOperationRun = 1;

function summarizeRuntime(runtime: PcRuntime): PcSummary {
	const workspace = runtime.state.workspace;
	const terminals = workspace?.terminals ?? [];
	return {
		id: runtime.pc.id,
		name: runtime.pc.name,
		hue: pcHue(runtime.pc),
		connection: runtime.state.connection,
		pcOnline: runtime.state.pcOnline,
		workspaces: workspace?.workspaces.length ?? 0,
		terminals: terminals.length,
		waiting: terminals.filter(terminal => isAgentWaiting(terminal.agentStatus)).length,
		lastOnlineAt: runtime.lastOnlineAt,
		battery: workspace?.battery,
	};
}

/** PCの長期公開鍵から色を決める（並び順に依存しない、そのPC固有の値）。 */
function pcHue(pc: PairedPc): number {
	let hash = 0;
	for (const byte of pc.creds.pcPublicKey) {
		hash = (hash * 31 + byte) >>> 0;
	}
	return hash;
}

function sameSummary(a: PcSummary, b: PcSummary): boolean {
	return a.id === b.id && a.name === b.name && a.hue === b.hue && a.connection === b.connection && a.pcOnline === b.pcOnline
		&& a.workspaces === b.workspaces && a.terminals === b.terminals && a.waiting === b.waiting
		&& a.lastOnlineAt === b.lastOnlineAt
		// battery はオブジェクトなので中身で比べる（参照比較だと毎回「変わった」ことになり、
		// 一覧を購読しているUIとLive Activityの同期が状態更新のたびに走ってしまう）。
		&& a.battery?.level === b.battery?.level && a.battery?.charging === b.battery?.charging;
}

/**
 * 直前に配ったPC一覧。**中身が変わっていなければ同じ配列を返す**ためのキャッシュ。
 * PCからの状態は実行中で最大10Hz届き、接続中のPCの台数ぶん重なる。毎回新しい配列を
 * 配ると、一覧を購読しているUIとLive Activityの同期がその頻度で走ってしまう。
 */
let lastSummaries: PcSummary[] = [];

function pcSummaries(): PcSummary[] {
	const next = pcOrder
		.map(id => runtimes.get(id))
		.filter((runtime): runtime is PcRuntime => runtime !== undefined)
		.map(summarizeRuntime);
	if (next.length === lastSummaries.length && next.every((summary, index) => sameSummary(summary, lastSummaries[index]!))) {
		return lastSummaries;
	}
	lastSummaries = next;
	return next;
}

function pairedPcs(): PairedPc[] {
	return pcOrder
		.map(id => runtimes.get(id)?.pc)
		.filter((pc): pc is PairedPc => pc !== undefined);
}

function persistPcs(): void {
	savePairedPcs(secureKeyStore, pairedPcs()).catch(err => console.warn('[appState] failed to save paired PCs', err));
}
/** init() の二重実行防止（Fast Refresh 等での再マウント対策）。同期的に立てて async 再入も弾く。 */
let initStarted = false;
/** 通知設定の再送subscribeの多重登録防止（init()失敗リトライ対策）。 */
let prefsSyncSubscribed = false;
/**
 * ネイティブの音声セッション操作を直列化するチェーン。
 * Expo の AsyncFunction は呼び出しごとに並行実行されるため、停止直後に再開すると
 * 後着した deactivate がセッションを畳んでしまう（JSの呼び出し順は保証にならない）。
 */
let voiceNativeChain: Promise<void> = Promise.resolve();
/** 接続復帰で購読を送り直す購読の多重登録防止。 */
let voiceResubscribeSubscribed = false;
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
		if (useAppStore.getState().manualOffline) {
			return;
		}
		for (const runtime of connectedRuntimes()) {
			// いま見ているPCは、繋がっていなければ即座に張り直す（画面が待っているため）。
			// 見ていないPCは「繋がっているつもりなのに死んでいる」場合の確認だけにとどめ、
			// 未接続なら再接続クライアント自身のバックオフに任せる。全台を毎回叩き起こすと、
			// 到達できないPCへ25秒ごとに接続を試み続けることになる。
			if (runtime.pc.id === activePcId || runtime.state.connection === 'online') {
				runtime.controller.ensureConnected();
			}
		}
	}, 25_000);
}

/**
 * ワークスペースを指定する操作の前に、そのIDがいま見ているPCのものか確かめる。
 *
 * ワークスペースIDは `<ウィンドウ番号>:<リポジトリのパス由来のID>` なので、同じリポジトリを
 * 同じ場所に置いた2台のPCでは**一致しうる**。画面が古いIDを握ったまま切り替えが起きると
 * （通知タップやペアリング解除による自動切り替えは、ユーザーの操作なしに起こる）、
 * コミットやファイル書き込みが別のPCへ着弾する。ここで弾いて取り違えを止める。
 */
function isActiveWorkspace(ws: string): boolean {
	const workspace = useAppStore.getState().workspace;
	// まだ一覧が届いていない間は判断材料が無いので通す（PC側でも存在確認される）。
	if (workspace === undefined || workspace.workspaces.length === 0) {
		return true;
	}
	return workspace.workspaces.some(entry => entry.id === ws);
}

/** 上の判定に引っかかったときに返す拒否理由（画面にはそのまま出る）。 */
function wrongPcWorkspaceError(): Error {
	return new Error('このワークスペースは、いま接続しているPCのものではありません');
}

/** いま接続を保つべきPC（アクティブ＋設定が許すなら残り全部）。 */
function connectedRuntimes(): PcRuntime[] {
	const keepBackground = useAppStore.getState().keepBackgroundPcs;
	return [...runtimes.values()].filter(runtime => keepBackground || runtime.pc.id === activePcId);
}

/**
 * PCごとのコントローラを作る。作った時点では接続せず、接続方針（applyConnectionPolicy）に任せる。
 * 通知鍵とアウトボックスはPC単位に分ける（混ざると復号できない通知・取り違えた操作記録になる）。
 */
/**
 * 単一PC時代の通知鍵（サフィックス無し）を片付ける。
 *
 * PCごとの鍵を1つでも保存できたあとに呼ぶ。**先に消してはいけない**（PCがオフラインで
 * 新しい鍵をまだ保存できていない間に消すと、その間のプッシュ本文が読めなくなる）。
 * 失敗しても次に鍵を保存したときへ持ち越すため、起動ごとに1度だけ試す形にしている。
 */
let legacyNotifyKeyRetired = false;
function retireLegacyNotifyKey(): void {
	if (legacyNotifyKeyRetired) {
		return;
	}
	legacyNotifyKeyRetired = true;
	deleteLegacyNotifyKey().catch(err => {
		legacyNotifyKeyRetired = false;
		console.warn('[appState] failed to delete legacy notify key', err);
	});
}

/**
 * そのPCの通知鍵を、NSEと共有しているKeychainへ保存する。
 *
 * 通知鍵は「自分の長期秘密鍵 × 相手の長期公開鍵」だけで決まり、接続の有無や回数で変わらない
 * （`deriveNotifyKey` はセッション鍵と違い ephemeral を混ぜない）。つまり**ペアリング済みで
 * ありさえすれば、そのPCへ繋いでいなくても同じ鍵を計算して保存できる**。
 *
 * 以前は接続時（`MobileController.connect`）にしか保存しておらず、「見ていないPCとの接続を保つ」
 * がオフだと非アクティブPCの鍵が入らないままだった。その状態だとNSEがプッシュ本文を復号できず、
 * 本文が固定文（「新しい通知があります」）のままになるうえ、遷移先（PC・ワークスペース・
 * ターミナル）も復元できないため通知をタップしてもホームのままになる。接続方針と切り離して
 * 「ペアリング済みの全PCぶん」を確保する。
 */
function persistNotifyKeyFor(pc: PairedPc): void {
	if (identity === undefined) {
		return;
	}
	try {
		const key = deriveNotifyKey(identity.secretKey, pc.creds.pcPublicKey);
		void persistNotifyKey(pc.id, bytesToHex(key))
			// 保存できたときだけ単一PC時代の鍵を片付ける（失敗したまま消すと、どの鍵でも
			// 復号できない状態を作ってしまう）。
			.then(saved => { if (saved) { retireLegacyNotifyKey(); } })
			.catch(err => console.warn('[appState] failed to persist notify key', err));
	} catch (err) {
		// 導出に失敗してもアプリは動く（そのPCのプッシュ本文が固定文になるだけ）。
		console.warn('[appState] failed to derive notify key', err);
	}
}

function createRuntime(pc: PairedPc, operationRun: number, persistedOutbox: readonly string[]): PcRuntime {
	// 接続するかどうかに関わらず、このPCの通知鍵はここで確保しておく。
	// （init: 保存済み全PC、pairFromUri: 追加した直後のPC、の両方がこの関数を通る）
	persistNotifyKeyFor(pc);
	// コールバックは台帳から引き直す。コンストラクタの途中で状態が届いても（将来そうなっても）
	// まだ作っていない実行時の持ち物を触らずに済み、繋ぎ直しで作り替えたときも新しい方へ届く。
	const current = (): PcRuntime | undefined => runtimes.get(pc.id) ?? pending;
	let pending: PcRuntime | undefined;
	const controller = new MobileController(
		identity!,
		rnSocketFactory,
		state => { const target = current(); if (target !== undefined) { applyControllerState(target, state); } },
		payload => { const target = current(); if (target !== undefined) { handleNotify(target, payload); } },
		getApnsDeviceToken,
		// 開発ビルド(expo run:ios)は aps-environment=development なので sandbox APNs 宛に登録する
		__DEV__ ? 'dev' : 'prod',
		// 接続時にも保存し直す（起動時の保存が失敗していた場合の取り戻し口）。
		// ここでも、保存できたときだけ単一PC時代の鍵を片付ける。
		hex => persistNotifyKey(pc.id, hex).then(saved => { if (saved) { retireLegacyNotifyKey(); } }),
		operationRun,
		createTerminalOperationOutboxStore(pc.id),
		persistedOutbox,
		pc.creds,
	);
	pending = { pc, controller, state: createEmptyStoreState(), lastOnlineAt: undefined, started: false, drafts: {} };
	return pending;
}

/**
 * コントローラからの状態更新をストアへ流す。いま見ているPCのぶんだけが画面の状態になり、
 * それ以外は一覧の件数（PcSummary）にだけ効く。
 */
function applyControllerState(runtime: PcRuntime, next: StoreState): void {
	const wasOnline = runtime.state.connection === 'online';
	runtime.state = next;
	if (next.pcOnline) {
		runtime.lastOnlineAt = Date.now();
	}
	// 見ていないPCにも、繋がった時点で同じ通知設定を持たせる（PC側はこの値でアプリ未起動時の
	// プッシュを送るか決めるため、届いていないと裏のPCだけ設定を無視して鳴り続ける）。
	// アクティブなPCぶんは init() の購読が送る。
	if (runtime.pc.id !== activePcId && !wasOnline && next.connection === 'online') {
		runtime.controller.sendNotifyPrefs(useAppStore.getState().notifyPrefs);
	}
	// PCが名乗った名前を台帳へ取り込む（ユーザーが自分で付けた名前は上書きしない）。
	adoptReportedPcName(runtime, next.workspace?.pcName);
	if (runtime.pc.id !== activePcId) {
		useAppStore.setState({ pcs: pcSummaries() });
		return;
	}
	// 状態が届くたびにアーカイブの印を点検する（回答待ちになったものは一覧へ戻し、
	// 消えたターミナルの印は捨てる）。archivedAgents.ts 参照。workspace が無い間
	// （切断時にクリアされる）は点検しない。ターミナルが0件に見えるため、全部の印を
	// 「消えたターミナル」として捨ててしまう。
	const archivedKeys = useAppStore.getState().archivedKeys;
	const nextArchived = next.workspace !== undefined
		? releaseArchivedOnAttention(archivedKeys, next.workspace.terminals)
		: archivedKeys;
	if (nextArchived !== archivedKeys) {
		const value = nextArchived as Set<string>;
		useAppStore.setState({ archivedKeys: value });
		persistArchivedKeys(runtime.pc.id, value);
	}
	useAppStore.setState({ ...next, pcs: pcSummaries() });
}

/** PCから届いた表示名を台帳へ反映する（変化があれば保存し直す）。 */
function adoptReportedPcName(runtime: PcRuntime, reported: string | undefined): void {
	const updated = applyReportedPcName([runtime.pc], runtime.pc.id, reported);
	const next = updated[0];
	if (next === undefined || next === runtime.pc) {
		return;
	}
	runtime.pc = next;
	persistPcs();
	useAppStore.setState({ pcs: pcSummaries() });
}

function persistPcPreferences(): void {
	const state = useAppStore.getState();
	secureKeyStore.setItem('pcPreferences', JSON.stringify({
		keepBackgroundPcs: state.keepBackgroundPcs,
		notifyOtherPcs: state.notifyOtherPcs,
	})).catch(err => console.warn('[appState] failed to save pcPreferences', err));
}

function persistPinnedKeys(pcId: string, keys: ReadonlySet<string>): void {
	pinnedRecord = withScopedKeys(pinnedRecord, pcId, keys);
	secureKeyStore.setItem('pinnedTerminals', JSON.stringify(pinnedRecord)).catch(err => console.warn('[appState] failed to save pinnedTerminals', err));
}

function persistArchivedKeys(pcId: string, keys: ReadonlySet<string>): void {
	archivedRecord = withScopedKeys(archivedRecord, pcId, keys);
	secureKeyStore.setItem('archivedTerminals', JSON.stringify(archivedRecord)).catch(err => console.warn('[appState] failed to save archivedTerminals', err));
}

function persistPresetHiddenKeys(pcId: string, keys: ReadonlySet<string>): void {
	presetHiddenRecord = withScopedKeys(presetHiddenRecord, pcId, keys);
	secureKeyStore.setItem('presetHidden', JSON.stringify(presetHiddenRecord)).catch(err => console.warn('[appState] failed to save presetHidden', err));
}

function persistPresetApprovals(pcId: string, keys: ReadonlySet<string>): void {
	presetApprovedRecord = withScopedKeys(presetApprovedRecord, pcId, keys);
	secureKeyStore.setItem('presetApproved', JSON.stringify(presetApprovedRecord)).catch(err => console.warn('[appState] failed to save presetApproved', err));
}

/**
 * 通知の受け取り。どのPCから来たかを添えて、タップされたときにそのPCへ切り替えられるようにする。
 * バナーを出すかの判断は notificationPolicy.ts に集約してある（届いた通知を一覧へ入れるのは
 * store 側で、そちらは無条件）。
 */
function handleNotify(runtime: PcRuntime, payload: NotifyPayload): void {
	const state = useAppStore.getState();
	const isActive = runtime.pc.id === activePcId;
	if (!isActive && !state.notifyOtherPcs) {
		return;
	}
	if (!shouldPresentNotifyBanner(payload, {
		appState: RNAppState.currentState,
		prefs: state.notifyPrefs,
		// 「その画面を見ているから出さない」は、いま見ているPCの通知にしか当てはまらない。
		viewingTerminalKey: isActive ? state.viewingTerminalKey : undefined,
		pushRegistered: runtime.state.pushRegistered,
		now: Date.now(),
	})) {
		return;
	}
	// タイトルはPCが決めたワークツリー名のまま出す。2台以上と繋いでいるときに「どのPCの話か」を
	// 足すのは電話側の仕事で、細い行の末尾へ回す（notifyPresentation.ts）。台帳の名前を渡すのは、
	// ユーザーが付け替えた名前をPCが知らないため。
	void presentLocalNotification(payload.title, notifySubtitle(payload.subtitle, runtime.pc.name, runtimes.size > 1), payload.body, {
		ws: payload.ws,
		terminalKey: payload.terminalKey,
		agentToken: payload.agentToken,
		pcId: runtime.pc.id,
	});
}

/**
 * 接続方針を反映する。アクティブなPCは必ず繋ぎ、それ以外は「見ていないPCとの接続を保つ」設定に従う。
 * 手動切断中（manualOffline）は何も繋がない。
 */
function applyConnectionPolicy(): void {
	const state = useAppStore.getState();
	// inactive（通知センターを引き下げた等）ではソケットを維持する。ここを
	// shouldRunForegroundWork で判定すると、その一瞬でも全PCの接続を畳んでしまう。
	const suspended = connectionActionForAppState(RNAppState.currentState) === 'suspend' && !state.voiceNotifications.desired;
	for (const runtime of runtimes.values()) {
		const shouldConnect = !state.manualOffline && (runtime.pc.id === activePcId || state.keepBackgroundPcs);
		if (!shouldConnect) {
			runtime.controller.disconnect();
			continue;
		}
		if (runtime.started) {
			runtime.controller.reconnect();
		} else {
			runtime.started = true;
			runtime.controller.connect(runtime.pc.creds);
		}
		if (suspended) {
			runtime.controller.suspendForBackground();
		}
	}
	useAppStore.setState({ pcs: pcSummaries() });
}

/**
 * 見るPCを切り替える。画面の状態はそのPCのコントローラが持っている最新の内容へ載せ替え、
 * ワークスペース選択や開いていたブラウザなど、PCをまたぐと意味が変わるものは選び直しにする。
 */
function activatePc(id: string, notice?: { readonly previousPcId: string | undefined }): void {
	const runtime = runtimes.get(id);
	if (runtime === undefined || id === activePcId) {
		return;
	}
	// 音声通知の購読は切り替え前のPCに対して張ったもの。持ち越すと、見ていないPCの
	// 音声が読み上げられ続けることになるのでここで畳む。
	endVoiceNotifications();
	const previous = activePcId !== undefined ? runtimes.get(activePcId) : undefined;
	if (previous !== undefined) {
		previous.controller.releaseAllWarmLeases();
		// 画面側の購読解除（画面を離れるときのcleanup）は「いま見ているPC」へ届いてしまうため、
		// 切り替え前のPCの購読はここでまとめて畳む。放置すると、そのPCは再接続のたびに
		// 再attachされ、見ていない間もずっと差分を送り続ける。
		previous.controller.detachAll();
		// 画面幅の申告も切り替え前のPCへ明示的に取り下げる。申告は「いま見ているPC」にしか
		// 送らないので、切り替えただけでは前のPCに取り下げが届かない。接続を保つ設定
		// （keepBackgroundPcs）だと disconnect も通らないため、そのPCのターミナルが細いまま
		// 残り、更新タイマーだけが回り続ける。
		previous.controller.setTerminalViewport(undefined);
		// 書きかけの文章はPCごとに取っておく（切り替えて戻ったときに残っている）。
		previous.drafts = useAppStore.getState().agentDrafts;
	}
	// 切り替え前のPCで見ていた画像（PC画面の一部が写り込む）はメモリに残さない。
	toolImageCache.clear();
	activePcId = id;
	const nextControllerRevision = replaceActiveController(runtime.controller);
	applyPairingCorrelationTag(runtime.pc.creds.deviceId);
	void saveActivePcId(secureKeyStore, id).catch(err => console.warn('[appState] failed to save active PC', err));
	useAppStore.setState({
		...runtime.state,
		activePcId: id,
		controllerRevision: nextControllerRevision,
		pcs: pcSummaries(),
		selectedWs: undefined,
		selectedHostId: undefined,
		selectedTerminalKey: undefined,
		browserSelection: undefined,
		homeShowAllWorkspaces: true,
		viewingTerminalKey: undefined,
		pinnedKeys: scopedKeysFor(pinnedRecord, id),
		archivedKeys: scopedKeysFor(archivedRecord, id),
		presetHiddenKeys: scopedKeysFor(presetHiddenRecord, id),
		presetApprovedSignatures: scopedKeysFor(presetApprovedRecord, id),
		agentDrafts: runtime.drafts,
		...(notice !== undefined ? { pcSwitchNotice: { pcId: id, name: runtime.pc.name, previousPcId: notice.previousPcId } } : {}),
	});
	applyConnectionPolicy();
	// 切り替え先が既に繋がっていても、手元の表示は古い可能性があるので取り直す
	// （ensureConnected は接続済みなら state 要求と生存確認を行う）。
	runtime.controller.ensureConnected();
}

function runVoiceNative(operation: () => Promise<void>): Promise<void> {
	const next = voiceNativeChain.then(operation, operation);
	voiceNativeChain = next.catch(() => { /* 後続の操作は前段の失敗に引きずられない */ });
	return next;
}

const voiceLifecycle = new MobileVoiceLifecycle({
	getSnapshot() {
		const state = useAppStore.getState();
		return {
			nativeSupported: isVoiceSessionSupported(),
			protocolUnsupported: state.sessionProtocolReady && state.workspace !== undefined && state.workspace.voiceClips !== 'relay-v1',
			connectionReady: state.pcOnline && state.sessionProtocolReady,
		};
	},
	setState(voiceNotifications) {
		useAppStore.setState({ voiceNotifications });
	},
	createSessionId() {
		return `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	},
	activate() {
		return runVoiceNative(activateVoiceSession);
	},
	deactivate() {
		return runVoiceNative(deactivateVoiceSession);
	},
	async subscribe(sid) {
		await useAppStore.getState().voiceSubscribe(sid);
	},
	unsubscribe(sid) {
		useAppStore.getState().voiceUnsubscribe(sid);
	},
	setClipHandler(sid, handler) {
		useAppStore.getState().setVoiceClipHandler(sid, handler);
	},
	clearClipHandler(sid) {
		useAppStore.getState().clearVoiceClipHandler(sid);
	},
	onRemoteStop(handler) {
		return onVoiceSessionRemoteStop(handler);
	},
	enqueueClip(base64) {
		return enqueueVoiceClip(base64);
	},
	afterStop() {
		if (connectionActionForAppState(RNAppState.currentState) === 'suspend' && !useAppStore.getState().manualOffline) {
			stopConnectionHeartbeat();
			// 音声のために起きていたのは全PCぶんのソケット。1本だけ畳むと、裏のPCが
			// バックグラウンドで繋がったまま残り、PCからは「オンライン＝プッシュ不要」に見えて
			// その間の通知が届かなくなる。
			for (const runtime of runtimes.values()) {
				runtime.controller.suspendForBackground();
			}
		}
	},
});

function endVoiceNotifications(): void {
	voiceLifecycle.stop();
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
	pcs: [],
	activePcId: undefined,
	controllerRevision: 0,
	// 見ていないPCとの接続も既定では保つ。切り替えた瞬間に一覧が出ていて、裏で待たれている
	// 質問にも気づけるのがこの機能の要点なので、既定でそちらへ倒す。
	keepBackgroundPcs: true,
	notifyOtherPcs: true,
	pcSwitchNotice: undefined,
	manualOffline: false,
	voiceNotifications: { desired: false, status: 'idle' },
	selectedWs: undefined,
	selectedHostId: undefined,
	homeShowAllWorkspaces: true,
	homePreferences: DEFAULT_HOME_PREFERENCES,
	sidebarCollapsed: false,
	selectedTerminalKey: undefined,
	browserSelection: undefined,
	// suppressWhenPcFocused の既定はオン。PCの前にいる間もスマホが鳴るのが通知過多の
	// 主因だったため、席を外している間だけ鳴る側を既定にしている（PC側の既定と揃えてある）。
	// 一度でも設定画面で触ればその値が保存され、以降はこの既定を使わない。
	notifyPrefs: { agentDone: true, agentQuestion: true, suppressWhenPcFocused: true },
	terminalPrefs: DEFAULT_TERMINAL_PREFS,
	viewingTerminalKey: undefined,
	pinnedKeys: new Set(),
	archivedKeys: new Set(),
	presetHiddenKeys: new Set(),
	presetApprovedSignatures: new Set(),
	agentDrafts: {},

	startVoiceNotifications() {
		if (!useAppStore.getState().voiceNotifications.desired) {
			voiceLifecycle.start();
		}
	},

	stopVoiceNotifications() {
		endVoiceNotifications();
	},

	acquireUsageWarmLease(windowId?: number) {
		return warmLeaseAppState.acquireUsageWarmLease(windowId);
	},

	acquireSpaceDiskWarmLease() {
		return warmLeaseAppState.acquireSpaceDiskWarmLease();
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
			currentOperationRun = operationRun;
			// ペアリング済みPCの台帳を読む（単一PC時代の資格情報しか無ければ1台目として引き継ぐ）。
			const { pcs: storedPcs, migratedFromSinglePc } = await loadPairedPcs(secureKeyStore);
			const storedActiveId = await loadActivePcId(secureKeyStore);
			const initialActiveId = storedPcs.find(pc => pc.id === storedActiveId)?.id ?? storedPcs[0]?.id;
			applyPairingCorrelationTag(storedPcs.find(pc => pc.id === initialActiveId)?.creds.deviceId);
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
			// ターミナル表示の設定をロード（保存が無い/壊れている場合は既定のまま）。
			try {
				const raw = await secureKeyStore.getItem('terminalPrefs');
				if (raw) {
					set({ terminalPrefs: normalizeTerminalPrefs(JSON.parse(raw)) });
				}
			} catch (err) {
				console.warn('[appState] failed to load terminalPrefs', err);
			}
			// 接続方針の設定をロード（保存が無い/壊れている場合は既定のまま）。
			try {
				const raw = await secureKeyStore.getItem('pcPreferences');
				if (raw) {
					const parsed = JSON.parse(raw) as { keepBackgroundPcs?: unknown; notifyOtherPcs?: unknown };
					set({
						keepBackgroundPcs: parsed.keepBackgroundPcs !== false,
						notifyOtherPcs: parsed.notifyOtherPcs !== false,
					});
				}
			} catch (err) {
				console.warn('[appState] failed to load pcPreferences', err);
			}
			// iPadサイドバーの折りたたみ状態をロード（保存が無い/壊れている場合は既定のまま）。
			try {
				const raw = await secureKeyStore.getItem('sidebarCollapsed');
				if (raw) {
					set({ sidebarCollapsed: JSON.parse(raw) === true });
				}
			} catch (err) {
				console.warn('[appState] failed to load sidebarCollapsed', err);
			}
			// ピン留め・アーカイブはPCごとに分けて保存する。単一PC時代の配列形式は、
			// そのとき唯一のペアリング相手だったPCのものとして引き継ぐ。
			try {
				pinnedRecord = parseScopedKeys(await secureKeyStore.getItem('pinnedTerminals'), initialActiveId);
			} catch (err) {
				console.warn('[appState] failed to load pinnedTerminals', err);
			}
			try {
				archivedRecord = parseScopedKeys(await secureKeyStore.getItem('archivedTerminals'), initialActiveId);
			} catch (err) {
				console.warn('[appState] failed to load archivedTerminals', err);
			}
			// コマンドプリセットの表示・承認の記録もPCごとに分けて保存する（単一PC時代は無い機能）。
			try {
				presetHiddenRecord = parseScopedKeys(await secureKeyStore.getItem('presetHidden'), initialActiveId);
			} catch (err) {
				console.warn('[appState] failed to load presetHidden', err);
			}
			try {
				presetApprovedRecord = parseScopedKeys(await secureKeyStore.getItem('presetApproved'), initialActiveId);
			} catch (err) {
				console.warn('[appState] failed to load presetApproved', err);
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
			// 単一PC時代の持ち物をこのPCのものへ引き継ぐ（アウトボックスのファイル名と、
			// 上で読み込んだピン留め・アーカイブの保存形式）。
			if (migratedFromSinglePc && initialActiveId !== undefined) {
				await migrateLegacyTerminalOperationOutbox(initialActiveId);
				await savePairedPcs(secureKeyStore, storedPcs);
				await saveActivePcId(secureKeyStore, initialActiveId);
				// 台帳へ移し終えたら旧キーは残さない。残すと、そのPCとのペアリングを解除しても
				// mobileToken 一式が端末に居座る（リレー上の失効に失敗していれば有効なまま）。
				await deleteLegacyCredentials(secureKeyStore).catch(err => console.warn('[appState] failed to delete legacy credentials', err));
				secureKeyStore.setItem('pinnedTerminals', JSON.stringify(pinnedRecord)).catch(err => console.warn('[appState] failed to save pinnedTerminals', err));
				secureKeyStore.setItem('archivedTerminals', JSON.stringify(archivedRecord)).catch(err => console.warn('[appState] failed to save archivedTerminals', err));
			}
			// PCごとにコントローラを作る。接続は最後の接続方針の反映（applyConnectionPolicy）で行う。
			for (const pc of storedPcs) {
				const persistedOutbox = await createTerminalOperationOutboxStore(pc.id).loadCandidates();
				runtimes.set(pc.id, createRuntime(pc, operationRun, persistedOutbox));
			}
			pcOrder = storedPcs.map(pc => pc.id);
			activePcId = initialActiveId;
			const initialControllerRevision = replaceActiveController(initialActiveId !== undefined ? runtimes.get(initialActiveId)?.controller : undefined);
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
						voiceLifecycle.reconnect();
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
						// 見ていないPCも繋いだままにしている場合は、そちらも一緒に起こす。
						for (const runtime of connectedRuntimes()) {
							runtime.controller.resumeFromBackground();
						}
					}
					startConnectionHeartbeat();
				} else if (action === 'suspend') {
					const state = useAppStore.getState();
					for (const runtime of runtimes.values()) {
						try {
							runtime.controller.releaseAllWarmLeases();
						} catch {
							// 背景移行時の解放はbest-effortだが、失敗しても残りのPCは必ず解放する。
						}
					}
					// 音声通知を明示的に開始している間は、PCから届く音声クリップの受信に
					// Relay が必要なため、バックグラウンドでもソケットと心拍を維持する。
					if (!state.voiceNotifications.desired) {
						stopConnectionHeartbeat();
					}
					if (!state.manualOffline && !state.voiceNotifications.desired) {
						for (const runtime of runtimes.values()) {
							runtime.controller.suspendForBackground();
						}
					}
				}
			});
			if (shouldRunForegroundWork(RNAppState.currentState)) {
				startConnectionHeartbeat();
			}
			set({
				ready: true,
				paired: storedPcs.length > 0,
				pcs: pcSummaries(),
				activePcId: initialActiveId,
				controllerRevision: initialControllerRevision,
				pinnedKeys: scopedKeysFor(pinnedRecord, initialActiveId),
				archivedKeys: scopedKeysFor(archivedRecord, initialActiveId),
				presetHiddenKeys: scopedKeysFor(presetHiddenRecord, initialActiveId),
				presetApprovedSignatures: scopedKeysFor(presetApprovedRecord, initialActiveId),
			});
			if (storedPcs.length > 0) {
				ensureNotificationPermission().catch(err => console.warn('[appState] notification permission request failed', err));
				// 接続の開始・バックグラウンド中の抑制はまとめてここで判断する（KeyStore読込中に
				// バックグラウンドへ移った場合も、背景用ソケットを残さない）。
				applyConnectionPolicy();
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
		// 手動の切断はこの端末全体の操作として扱う（裏で繋いだままのPCが残ると、
		// 「切断中」と言いながら通信し続けることになる）。
		for (const runtime of runtimes.values()) {
			runtime.controller.disconnect();
		}
		set({ pcs: pcSummaries() });
	},

	connectRelay() {
		set({ manualOffline: false });
		applyConnectionPolicy();
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
			// PC側がリレー登録ごと作り直すと deviceId は変わるが、長期鍵（＝SASで確かめた相手の
			// 正体）は同じままになる。deviceId だけで見ると同じPCが2行に増え、片方は永久に
			// オフラインのまま通知鍵だけ残る（その鍵は新しい行のものと同じ値なので、解除しても
			// 通知本文を復号できてしまう）。公開鍵が一致する古い行は先に畳む。
			const samePublicKey = pairedPcs().find(item => item.id !== creds.deviceId
				&& item.creds.pcPublicKey.length === creds.pcPublicKey.length
				&& item.creds.pcPublicKey.every((byte, index) => byte === creds.pcPublicKey[index]));
			if (samePublicKey !== undefined) {
				await useAppStore.getState().removePc(samePublicKey.id)
					.catch(error => console.warn('[appState] failed to retire the previous registration of this PC', error));
			}
			const previousPcs = pairedPcs();
			// 同じPCと繋ぎ直した場合は台帳を増やさず、資格情報だけ差し替える
			// （リレー側の登録は作り直されているので、古い mobileToken はもう使えない）。
			const existing = runtimes.get(creds.deviceId);
			const name = existing?.pc.name
				?? sanitizePcName(payload.pcName)
				?? nextFallbackPcName(previousPcs);
			const pc: PairedPc = {
				id: creds.deviceId,
				creds,
				name,
				// PCが名乗った名前をそのまま採用した場合は、以後もPC側の変更に追従させる。
				renamed: existing?.pc.renamed ?? false,
				addedAt: existing?.pc.addedAt ?? Date.now(),
			};
			const nextPcs = existing !== undefined
				? previousPcs.map(item => (item.id === pc.id ? pc : item))
				: [...previousPcs, pc];
			try {
				// 先に台帳をdurable化する。ここで失敗したら、繋がったばかりの資格情報を
				// リレー上からも失効させて元の状態へ戻す。
				await savePairedPcs(secureKeyStore, nextPcs);
			} catch (error) {
				await revokeSelfOnRelay(creds);
				throw error;
			}
			if (existing !== undefined) {
				// 同じPCの繋ぎ直し。古い接続と、そのPC向けの未確定操作の記録は畳んでから入れ替える。
				try {
					await existing.controller.reset();
				} catch (error) {
					await savePairedPcs(secureKeyStore, previousPcs).catch(() => { /* 台帳は次回起動でも読み直される */ });
					await revokeSelfOnRelay(creds);
					throw error;
				}
				runtimes.delete(existing.pc.id);
			}
			const persistedOutbox = await createTerminalOperationOutboxStore(pc.id).loadCandidates();
			runtimes.set(pc.id, createRuntime(pc, currentOperationRun, persistedOutbox));
			pcOrder = nextPcs.map(item => item.id);
			// 手動で切断していたなら、ここで解除する。わざわざ繋ぎに来た操作なので、
			// 「追加できたのに繋がらない」で終わらせない。
			set({ paired: true, pcs: pcSummaries(), browserSelection: undefined, manualOffline: false });
			// 繋いだPCをそのまま見せる（追加直後に別のPCの画面が残っていると混乱する）。
			if (pc.id === activePcId) {
				// 同じPCの繋ぎ直し。activatePc は「既にアクティブ」として素通りするので、
				// コントローラの差し替えと、前の接続で溜まっていた表示の破棄をここで行う。
				const next = runtimes.get(pc.id);
				const nextControllerRevision = replaceActiveController(next?.controller);
				set({ ...(next?.state ?? createEmptyStoreState()), pcs: pcSummaries(), controllerRevision: nextControllerRevision, selectedTerminalKey: undefined, agentDrafts: {} });
				applyConnectionPolicy();
			} else {
				activatePc(pc.id);
			}
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
		// 全解除。1台ずつの解除は removePc が行う。1台で失敗しても残りは解除しきる
		// （途中で止まると「解除したつもりのPCが残っている」状態になるため）。
		//
		// **必ず1台ずつ順に行う**。removePc は「残るPCの一覧」を最初の await より前に読んでから
		// 保存するので、並行に走らせると互いの結果を上書きし合い（後勝ち）、解除したはずのPCが
		// 台帳に残る。残ったPCは次の起動で復活し、通知鍵まで作り直されてしまう
		// （解除したPCの通知本文が読める状態に戻る）。
		let failure: unknown;
		for (const id of [...pcOrder]) {
			try {
				await useAppStore.getState().removePc(id);
			} catch (error) {
				failure ??= error;
			}
		}
		if (failure !== undefined) {
			throw failure instanceof Error ? failure : new Error(String(failure));
		}
	},

	switchPc(id: string) {
		activatePc(id);
	},

	switchPcWithReturn(id: string) {
		activatePc(id, { previousPcId: activePcId });
	},

	async renamePc(id: string, name: string) {
		const runtime = runtimes.get(id);
		// 入力された名前も、PCが名乗る名前と同じ規則で整える（長さ・制御文字）。
		const trimmed = sanitizePcName(name);
		if (runtime === undefined || trimmed === undefined || trimmed === runtime.pc.name) {
			return;
		}
		// 以後はPCが名乗る名前で上書きしない（手で付けた呼び分けを残す）。
		runtime.pc = { ...runtime.pc, name: trimmed, renamed: true };
		set({ pcs: pcSummaries() });
		await savePairedPcs(secureKeyStore, pairedPcs());
	},

	async removePc(id: string) {
		const runtime = runtimes.get(id);
		if (runtime === undefined) {
			return;
		}
		const creds = runtime.pc.creds;
		const previousPcs = pairedPcs();
		const remaining = previousPcs.filter(pc => pc.id !== id);
		if (id === activePcId) {
			endVoiceNotifications();
		}
		try {
			// 台帳の更新が成功するまでコントローラへ触れない（失敗時にそのPCを完全に保持する）。
			await savePairedPcs(secureKeyStore, remaining);
			await deleteNotifyKey(id);
		} catch (error) {
			await savePairedPcs(secureKeyStore, previousPcs).catch(() => { /* 次回起動で読み直される */ });
			throw error;
		}
		try {
			await runtime.controller.reset();
		} catch (error) {
			// journal clear失敗時はresetが旧接続へ戻す。台帳と通知鍵も元へ戻す。
			await savePairedPcs(secureKeyStore, previousPcs).catch(() => { /* 次回起動で読み直される */ });
			if (identity !== undefined) {
				const key = deriveNotifyKey(identity.secretKey, creds.pcPublicKey);
				await persistNotifyKey(id, bytesToHex(key));
			}
			throw error;
		}
		runtimes.delete(id);
		pcOrder = remaining.map(pc => pc.id);
		if (remaining.length === 0) {
			applyPairingCorrelationTag(undefined);
		}
		// そのPCに紐づくローカルの記録（ピン留め・アーカイブ・コマンドプリセットの表示と承認）も
		// 一緒に片付ける。プリセットの承認記録を残すと、同じPCと繋ぎ直したときに「一度確認した」
		// 状態が復活し、本来もう一度出すべき実行前の確認を飛ばしてしまう。
		pinnedRecord = withScopedKeys(pinnedRecord, id, new Set());
		archivedRecord = withScopedKeys(archivedRecord, id, new Set());
		presetHiddenRecord = withScopedKeys(presetHiddenRecord, id, new Set());
		presetApprovedRecord = withScopedKeys(presetApprovedRecord, id, new Set());
		secureKeyStore.setItem('pinnedTerminals', JSON.stringify(pinnedRecord)).catch(err => console.warn('[appState] failed to save pinnedTerminals', err));
		secureKeyStore.setItem('archivedTerminals', JSON.stringify(archivedRecord)).catch(err => console.warn('[appState] failed to save archivedTerminals', err));
		secureKeyStore.setItem('presetHidden', JSON.stringify(presetHiddenRecord)).catch(err => console.warn('[appState] failed to save presetHidden', err));
		secureKeyStore.setItem('presetApproved', JSON.stringify(presetApprovedRecord)).catch(err => console.warn('[appState] failed to save presetApproved', err));
		// PC画面の一部が写り込んだ画像をメモリに残さない（取得済みの画像はストア外のキャッシュにある）。
		toolImageCache.clear();
		if (id === activePcId) {
			const next = pcOrder[0];
			activePcId = undefined;
			const nextControllerRevision = replaceActiveController(undefined);
			set({
				...createEmptyStoreState(),
				paired: remaining.length > 0,
				pcs: pcSummaries(),
				activePcId: undefined,
				controllerRevision: nextControllerRevision,
				selectedWs: undefined,
				selectedHostId: undefined,
				homeShowAllWorkspaces: true,
				selectedTerminalKey: undefined,
				browserSelection: undefined,
				viewingTerminalKey: undefined,
				pinnedKeys: new Set(),
				archivedKeys: new Set(),
				presetHiddenKeys: new Set(),
				presetApprovedSignatures: new Set(),
				agentDrafts: {},
				pcSwitchNotice: undefined,
			});
			// 保存の失敗でこの先（残ったPCへの切り替えとリレー失効）を止めない。止めると
			// 「PCは残っているのにどれも選ばれていない」状態でアプリ再起動まで固まる。
			saveActivePcId(secureKeyStore, undefined).catch(err => console.warn('[appState] failed to clear the active PC', err));
			if (next !== undefined) {
				activatePc(next);
			}
		} else {
			set({ paired: remaining.length > 0, pcs: pcSummaries() });
		}
		// ローカル削除完了後にrelay資格情報をbest-effort失効する。失敗しても端末上のtokenは
		// 既に消えており、PC側からも後で失効できるためローカル解除は巻き戻さない。
		await revokeSelfOnRelay(creds).catch(error => console.warn('[appState] relay credential revocation failed after local unpair', error));
	},

	setKeepBackgroundPcs(value: boolean) {
		set({ keepBackgroundPcs: value });
		persistPcPreferences();
		applyConnectionPolicy();
	},

	setNotifyOtherPcs(value: boolean) {
		set({ notifyOtherPcs: value });
		persistPcPreferences();
	},

	dismissPcSwitchNotice() {
		set({ pcSwitchNotice: undefined });
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
		if (activePcId === undefined) {
			return;
		}
		const current = useAppStore.getState().pinnedKeys;
		const next = new Set(current);
		if (next.has(key)) {
			next.delete(key);
		} else {
			next.add(key);
		}
		set({ pinnedKeys: next });
		persistPinnedKeys(activePcId, next);
	},

	setArchived(key: string, archived: boolean) {
		if (activePcId === undefined) {
			return;
		}
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
		persistArchivedKeys(activePcId, next);
	},

	setPresetHidden(key: string, hidden: boolean) {
		if (activePcId === undefined) {
			return;
		}
		const current = useAppStore.getState().presetHiddenKeys;
		if (current.has(key) === hidden) {
			return;
		}
		const next = new Set(current);
		if (hidden) {
			next.add(key);
		} else {
			next.delete(key);
		}
		set({ presetHiddenKeys: next });
		persistPresetHiddenKeys(activePcId, next);
	},

	approvePreset(signature: string) {
		if (activePcId === undefined) {
			return;
		}
		const current = useAppStore.getState().presetApprovedSignatures;
		if (current.has(signature)) {
			return;
		}
		const next = new Set(current);
		next.add(signature);
		set({ presetApprovedSignatures: next });
		persistPresetApprovals(activePcId, next);
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

	scrollTerminal(terminalKey: string, dir: 'up' | 'down', lines: number) {
		controller?.scrollTerminal(terminalKey, dir, lines);
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
		if (ws !== undefined && !isActiveWorkspace(ws)) {
			console.warn('[appState] ignored createTerminal for a workspace of another PC');
			return;
		}
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

	setSelectedHost(id: string) {
		set({ selectedHostId: id });
	},

	setHomeShowAllWorkspaces(value: boolean) {
		set({ homeShowAllWorkspaces: value });
	},

	setHomePreferences(next: HomeListPreferences) {
		set({ homePreferences: next });
		secureKeyStore.setItem('homeListPreferences', JSON.stringify(next)).catch(err => console.warn('[appState] failed to save homeListPreferences', err));
	},

	setSidebarCollapsed(value: boolean) {
		set({ sidebarCollapsed: value });
		secureKeyStore.setItem('sidebarCollapsed', JSON.stringify(value)).catch(err => console.warn('[appState] failed to save sidebarCollapsed', err));
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
		// **繋いでいる全PCへ送る**。いま見ているPCだけに送ると、裏のPCは古い設定のまま
		// プッシュを送り続け、「アプリを閉じているときだけ、切ったはずの通知が鳴る」になる。
		// オフライン中のPCには再接続時のフックで追いつく。
		for (const runtime of runtimes.values()) {
			runtime.controller.sendNotifyPrefs(next);
		}
	},

	setTerminalPref(key, value) {
		const next = { ...useAppStore.getState().terminalPrefs, [key]: value };
		set({ terminalPrefs: next });
		secureKeyStore.setItem('terminalPrefs', JSON.stringify(next)).catch(err => console.warn('[appState] failed to save terminalPrefs', err));
		// 幅合わせを切ったら、その場でPCへ「申告を取り下げる」を送る（PCの寸法が戻る）。
		// ターミナル画面を開いていなくても効かせたいので、画面側の副作用に頼らずここでも撃つ。
		// 入れ直したときは、ターミナル画面が実測した寸法で改めて申告される。
		if (key === 'matchPcWidth' && value === false) {
			useAppStore.getState().setTerminalViewport(undefined);
		}
	},

	setTerminalViewport(viewport: TerminalViewport | undefined) {
		// 申告は「いま見ているPC」だけに送る（裏のPCのターミナルを勝手に細くしない）。
		// 取り下げは**繋いでいる全PCへ送る**。PCを切り替えてからターミナル画面を離れると、
		// アクティブPCだけに送る作りでは切り替え前のPCに取り下げが届かず、そのPCの
		// ターミナルが細いまま取り残される（しかも controller が値を保持しているため、
		// 再接続時のattachで細い寸法を申告し直してしまう）。
		if (viewport === undefined) {
			for (const runtime of runtimes.values()) {
				runtime.controller.setTerminalViewport(undefined);
			}
			return;
		}
		controller?.setTerminalViewport(viewport);
	},

	clearNotifications() {
		controller?.clearNotifications();
	},

	dismissNotification(id: string) {
		controller?.dismissNotification(id);
	},

	scmStatus(ws: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.scmStatus(ws);
	},

	scmDiff(ws: string, path?: string, staged?: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.scmDiff(ws, path, staged);
	},

	scmCommit(ws: string, message: string, all: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.scmCommit(ws, message, all);
	},

	scmLog(ws: string, opts?: { limit?: number; skip?: number }) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.scmLog(ws, opts);
	},

	scmCommitFiles(ws: string, hash: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
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
		if (!isActiveWorkspace(opts.ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.launchAgent(opts);
	},

	presetList(ws: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.presetList(ws);
	},

	presetRun(ws: string, key: string, signature: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.presetRun(ws, key, signature);
	},

	noteGet(ws: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.noteGet(ws);
	},

	noteSet(ws: string, text: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.noteSet(ws, text);
	},

	fsList(ws: string, path: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.fsList(ws, path);
	},

	fsResolveLink(ws: string, path: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.fsResolveLink(ws, path);
	},

	fsRead(ws: string, path: string, highlight?: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.fsRead(ws, path, highlight);
	},

	fsXlsx(ws: string, path: string, sheet?: number) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.fsXlsx(ws, path, sheet);
	},

	fsPdf(ws: string, path: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.fsPdf(ws, path);
	},

	fsDocx(ws: string, path: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.fsDocx(ws, path);
	},

	fsMedia(ws: string, path: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.fsMedia(ws, path);
	},

	fsFind(ws: string, query: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.fsFind(ws, query);
	},

	fsGrep(ws: string, query: string) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
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
		if (!isActiveWorkspace(ws)) { return Promise.reject(wrongPcWorkspaceError()); }
		return controller.scmXlsxDiff(ws, path);
	},

	usageDashboard(bypassCache?: boolean, windowId?: number) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.usageDashboard(bypassCache, windowId);
	},

	rtkSavings(bypassCache?: boolean, windowId?: number) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.rtkSavings(bypassCache, windowId);
	},

	rateLimits(bypassCache?: boolean, windowId?: number) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.rateLimits(bypassCache, windowId);
	},

	githubUsage(bypassCache?: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.githubUsage(bypassCache);
	},

	systemResources(bypassCache?: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.systemResources(bypassCache);
	},

	spaceDisk(bypassCache?: boolean) {
		if (!controller) { return Promise.reject(new Error('not initialized')); }
		return controller.spaceDisk(bypassCache);
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
