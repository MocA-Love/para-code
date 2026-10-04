/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェント(Claude Code / Codex)セッションのチャットミラー (agentチャネル、shared process側)。
//
// PCのターミナルでTUIとして動いているエージェントの会話を、TUIに一切手を入れずに
// 構造化チャットとしてモバイルへミラーする:
//  - セッション特定: notify.sh (v2) がPOSTするhook JSONの transcript_path / session_id
//    (paradisAgentHookBus 経由)。画面パースには依存しない
//  - 本文: transcript JSONL (Claude: ~/.claude/projects/**.jsonl、Codex: ~/.codex/sessions/**
//    rollout) を tail してパースする。append-only なのでオフセット追跡で差分だけ読む
//  - モバイルからの通常入力とClaude承認は既存の term チャネル (PTY stdin注入) を使う
//  - Codexの承認・モデル一覧・次ターン設定はapp-serverの構造化RPCを使う
//    （承認の多択情報を失わず、PTYの表示やショートカットには依存しない）
//
// 切断・再接続への堅牢性 (設計方針):
//  - 確定会話の真実の源はディスク上の transcript。未決着の承認だけはtranscriptに
//    記録されないため、app-server server requestをライブ状態の正本として扱う
//  - 各tailerは epoch (tail開始ごとに一意) + rev (メッセージ連番) を持つ。モバイルは
//    attach 時に手元の epoch/afterRev を申告し、epoch一致なら差分のみ、不一致
//    (shared process再起動・セッション切替) なら全量スナップショットを受け取る
//  - ファイル監視は fs.watch + ポーリングの二重化 (watchの取りこぼし・未作成ファイル対応)。
//    truncate/置き換え (サイズ減少) を検知したら epoch を切り替えて読み直す

import { watch, type Dirent, FSWatcher, promises as fs } from 'fs';
import { createRequire } from 'module';
import { homedir } from 'os';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, resolve, sep } from '../../../../base/common/path.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { BACKGROUND_TASK_ID_MAX_LENGTH, BACKGROUND_TASK_MAX_ENTRIES, fireParadisAgentAwaitingUser, fireParadisAgentTurnEnded, fireParadisAgentTurnStarted, getParadisAgentPaneActivity, IParadisAgentHookEvent, IParadisAgentNestedHookEvent, onParadisAgentHookEvent, onParadisAgentNestedHookEvent, setParadisAgentPaneActivity, setParadisAgentPaneIssueUrls } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { IParadisAgentHomes, paradisClaudeConfigDir, paradisCodexHomes, paradisEachCodexHome, paradisIsWithinCodexHome, paradisLocalAgentPath, paradisResolveAgentHomes } from '../../agentBrowser/node/paradisAgentHome.js';
import { paradisExtractIssueUrls } from '../../../common/paradisIssueDetection.js';
import { paradisIsWslAgentHomePath } from '../../../common/paradisWslAgentHome.js';
import { paradisCwdGroupKey } from '../../../common/paradisWslPath.js';
import { paradisBuildAgentCommandCatalog, paradisBuiltInAgentCommands, paradisLegacyAgentCommandCatalog, paradisNormalizeModCommandList, type IParadisAgentCommandOption } from './paradisAgentCommandCatalog.js';
import { IParadisSlashCommand, PARADIS_SLASH_COMMAND_REJECTED_CODE, paradisParseSlashCommand, paradisSlashRejectionMessage } from '../common/paradisAgentSlashCommand.js';
import { IParadisAgentActivityState, IParadisAgentAdvisorUpdate, ParadisAgentActivityTracker } from './paradisAgentActivity.js';
import { IParadisMobilePaneOwner, ParadisMobilePaneOwnership, ParadisMobilePaneRegistry, paradisMergeLivePaneMetadata } from './paradisMobilePaneRegistry.js';
import { ParadisAgentSessionStore } from './paradisAgentSessionStore.js';
import { ParadisRemoteTranscriptMirrorStore, paradisIsRemoteAgentTranscriptMirrorPath, paradisRemoteTranscriptMirrorRoots } from './paradisRemoteTranscriptMirror.js';
import { type IParadisClaudeSubagentMeta, type IParadisRecoveredAgentActivity, paradisParseClaudeAdvisors, paradisParseClaudePersistedActivity, paradisParseCodexPersistedActivity } from './paradisPersistedAgentActivity.js';
import { type IParadisAgentLiveAppendPatch, PARADIS_AGENT_LIVE_APPEND_ENCODING, paradisAgentLivePayloadForEncoding } from '../common/paradisMobileAgentLivePatch.js';
import { paradisAgentApprovalKeySequence, paradisAgentQuestionKeySequence } from '../common/paradisAgentQuestionKeys.js';
import { PARADIS_AGENT_QUESTION_NOTES_LIMIT, PARADIS_AGENT_QUESTION_RESPONSE_LIMIT, paradisAgentQuestionClarifyDeny, paradisBuildModQuestionAnswer } from '../common/paradisAgentQuestionModAnswer.js';
import { IParadisAgentApprovalOption, paradisApprovalSuggestionLabels, paradisParseApprovalOptionChoice } from '../common/paradisAgentApprovalOptions.js';
import { IParadisAgentApprovalAgent, IParadisAgentApprovalRequest, PARADIS_AGENT_APPROVAL_DENY_MESSAGE_LIMIT, PARADIS_APPROVAL_INSTRUCTION_MARKER, ParadisAgentApprovalSuggestionScope, paradisApprovalDenyMessage, paradisSanitizeApprovalInstruction, paradisApprovalSuggestionScope, paradisBuildAgentApprovalRequest } from '../common/paradisAgentApprovalRequest.js';
import { paradisAgentSessionKey } from '../common/paradisMobileAgentResume.js';
import { PARADIS_RESUME_SESSION_ID_PATTERN } from '../../sessionResume/common/paradisSessionResume.js';
import { IParadisHistoryCursor, PARADIS_HISTORY_FILE_CAP, PARADIS_HISTORY_PAGE_LIMIT, paradisDecodeHistoryCursor, paradisEncodeHistoryCursor, paradisHistoryCursorHasMore, paradisReadTranscriptHistory } from './paradisAgentChatHistory.js';
import { ParadisDirectoryWalkLedger } from '../common/paradisDirectoryWalkLedger.js';
import { IParadisClaudeTranscriptPrefixMatch, ParadisHookTranscriptSightings, paradisClaudeTranscriptIsBackground, paradisClaudeTranscriptSessionKind, paradisFindClaudeTranscriptByIdPrefix, paradisListClaudeTranscriptsByIdPrefixAcrossProjects } from './paradisClaudeBackgroundSessions.js';
import { ParadisClaudeModBridge, paradisClaudeModBridge, paradisClaudeModWaitForPrevious, ParadisClaudeModEvent, IParadisClaudeModPendingPermission, IParadisClaudeModPendingQuestion } from '../../claudeMod/node/paradisClaudeModBridge.js';
import { paradisIsDisplayOnlyModRow } from '../../claudeMod/common/paradisClaudeMod.js';
import { runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';
import type { IParadisNotifyPaneContent } from './paradisNotifyContentSource.js';
import { IParadisAgentPaneInsight, IParadisAgentPaneInteraction, IParadisAgentPromptCache, PARADIS_PROMPT_CACHE_TTL_5M, paradisOneLine, paradisReadClaudePromptCacheUsage, paradisReadClaudeRequestStart, paradisSelectInsightSubagents, paradisSummarizePermissionInput, paradisSummarizeQuestionInput } from '../../agentInsights/common/paradisAgentInsights.js';
import { IParadisAgentApprovalChoice, IParadisAgentChatCommand, IParadisAgentChatCursor, IParadisAgentChatImage, IParadisAgentChatImageData, IParadisAgentChatMessage, IParadisAgentChatView, IParadisAgentInteraction, IParadisAgentLiveState, IParadisAgentSessionInfo, PARADIS_ADVISOR_TOOL, ParadisAgentKind, paradisAgentQuestionHasPreview, paradisIsCodexDaemonApprovalInteraction, paradisPickCurrentInteraction } from '../../agentChat/common/paradisAgentChat.js';
import { IParadisAgentMonitor, ParadisAgentMonitorWatch, paradisMonitorsForStoppedPane } from '../../agentChat/common/paradisAgentMonitors.js';
import { IParadisAgentShell, paradisShellsAccess, paradisShellsForStoppedPane } from '../../agentChat/common/paradisAgentShells.js';
import { IParadisAgentShellsField, ParadisAgentShellInbound, ParadisAgentShellOutbound, paradisClaudeSessionIdFromTranscript, paradisHandleShellRequest, paradisIsValidShellRequest } from './paradisAgentShellOutput.js';
import { IFlattenedImage, IParadisAgentActivityDetailMessage, IParseSignals, IRawMessage, ICodexTranscriptActivityEvent, ITranscriptProgress, liveQuestionContentKey, MAX_IMAGES_PER_MESSAGE, newClaudeQueuedPromptState, newParseSignals, num, paradisParseCodexDetailLinesForTest, paradisQuestionReadyMarker, paradisTakeLiveQuestionSyntheticId, paradisHasPendingDuplicateQuestion, paradisToolImageMeta, parseAskUserQuestions, parseClaudeLine, parseClaudeProgress, parseCodexLine, rec, str, TEXT_LIMIT, toDetailMessage, TOOL_IMAGE_BASE64_LIMIT, TOOL_TEXT_LIMIT, truncateText } from '../../agentChat/common/paradisAgentTranscriptParser.js';

// 会話の型と transcript の正規化は、デスクトップのチャット表示と共有するため agentChat/common へ
// 切り出した。既存の呼び出し元（テスト）がこのモジュールから引けるよう、公開していたものは再公開する。
export type { IParadisAgentChatImage, IParadisAgentChatMessage, IParadisAgentInteraction, IParadisAgentLiveState, IParadisAgentQuestionOption, IParadisAgentSessionInfo, ParadisAgentKind } from '../../agentChat/common/paradisAgentChat.js';
export { paradisIsCodexDaemonApprovalInteraction, paradisPickCurrentInteraction } from '../../agentChat/common/paradisAgentChat.js';
export type { IParadisAgentActivityDetailMessage } from '../../agentChat/common/paradisAgentTranscriptParser.js';
export { paradisHasPendingDuplicateQuestion, paradisParseClaudeTranscriptLineForTest, paradisParseCodexDetailLinesForTest, paradisParseCodexTranscriptLineForTest, paradisParseCodexTranscriptLinesForTest, paradisQuestionReadyMarker, paradisTakeLiveQuestionSyntheticId, paradisToolImageMeta } from '../../agentChat/common/paradisAgentTranscriptParser.js';

/** `attach` は `claude attach <id>`（会話 id の先頭で決め打ちする。作業ディレクトリからは推測しない）。 */
export type ParadisCliDiscoveryMode = 'new' | 'resume' | 'fork' | 'attach';

/** Codex のモデルをモバイルから変えようとしたときの返事（ライブ連携をやめたため）。 */
const PARADIS_CODEX_MODEL_CONTROL_UNSUPPORTED_MESSAGE = 'Codex のモデルはモバイルから変えられません。PC のターミナルで /model から変えてください';

/**
 * ターンやセッションの終了を伝える hook か。
 *
 * これらを取りこぼすと live 状態と activeTurnTokens が stuck し、モバイルが
 * 「応答を生成中」のまま固着したうえ、モデル変更なども入力待ち判定に弾かれ続ける。
 * 終了時は質問・承認・活動表示も同じ完了処理へ収束させる必要がある。
 */
export function paradisIsTurnEndHookEvent(eventName: string): boolean {
	// Interrupt は Codex の Esc による中断（0.150+）。rollout の turn_aborted より先に届くので、ここでも閉じる
	return eventName === 'Stop' || eventName === 'StopFailure' || eventName === 'SessionEnd' || eventName === 'agent-turn-complete' || eventName === 'Interrupt';
}

/**
 * 終了済みのターンを live 状態として蘇生させる遅着 hook かどうか。
 *
 * hook は curl の別プロセスから並行 POST されるため、Stop と前後して MessageDisplay や
 * PostToolUse が届く。発火時刻は Emitter が同期で採番するので単純な前後比較では「Stop より
 * 後に発火した遅着」を捕まえられず、時間の窓で判定する必要がある。
 * MessageDisplay だけでなく PreToolUse / PostToolUse / PermissionRequest も setLiveState を
 * 呼ぶので、どれが遅れて届いても同じ「二度と消えない live」を作れてしまう。
 * ターンの開始（UserPromptSubmit）と終了そのものは窓の対象外。
 */
export function paradisIsLateHookAfterTurnEnd(eventName: string, at: number, turnEndedAt: number | undefined): boolean {
	switch (eventName) {
		case 'UserPromptSubmit':
		case 'Stop':
		case 'StopFailure':
		case 'SessionEnd':
		case 'TerminalExit':
		case 'agent-turn-complete':
		case 'Interrupt':
			return false;
		default:
			break;
	}
	// 負の差分（pendingHooks の replay で古い at が再投入された場合など）も窓の内側として扱う。
	// この経路で来るのは「終了より前に発火した更新」＝終了後に反映してはいけないものなので、
	// 遅着と同じく捨てるのが正しい。at は同一プロセスの Date.now() なので、壁時計の巻き戻しで
	// 大きく負に振れることは実質ない。
	const sinceTurnEnd = turnEndedAt === undefined ? undefined : Math.max(0, at - turnEndedAt);
	return sinceTurnEnd !== undefined && sinceTurnEnd <= LATE_HOOK_AFTER_TURN_END_MS;
}


/**
 * mod が `ok: false` で断った送信への返事（キーでは送り直さない）。`busy`（別の発言の最中）と `unavailable`（渡せなかった）は
 * undefined（呼び出し側がキーで送る）。
 */
function paradisModRefusalResult(result: string): { readonly code: string; readonly message: string } | undefined {
	switch (result) {
		case 'refused': return { code: 'send-refused', message: MOD_SEND_REFUSED_MESSAGE };
		case 'stale': return { code: 'stale-session', message: '操作対象のエージェントセッションが変わりました' };
		case 'panel-open': return { code: PARADIS_PANEL_OPEN_CODE, message: PARADIS_PANEL_OPEN_MESSAGE };
		default: return undefined;
	}
}

/** agentチャネルのモバイル→PCメッセージ。 */
type AgentInbound =
	| { t: 'attach'; id: number; token?: string; epoch?: string; afterRev?: number; liveEncoding?: string }
	| { t: 'detach'; id: number; token?: string }
	| { t: 'action/sendMessage'; id: number; token?: string; requestId: string; epoch: string; text: string; sendId?: string }
	| { t: 'action/answerQuestion'; id: number; token?: string; requestId: string; epoch: string; interactionId: string; answers: readonly AgentQuestionAnswer[] }
	/**
	 * 「質問に答えずに話す」（TUI の「Chat about this」、`agent.question.chat.v1`）。全問を取り下げる。mod が待っているときだけ受ける。
	 * `response` があればそれを返事として渡し、無ければ途中までの回答（`answers`。未回答は null）とメモを添えて拒否する。
	 */
	| { t: 'action/clarifyQuestion'; id: number; token?: string; requestId: string; epoch: string; interactionId: string; response?: string; answers?: readonly (AgentQuestionAnswer | null)[] }
	/** `message`: 拒否（`no`）に添える指示（`agent.approval.detail.v1`。承認の `answerVia: 'mod'` のときだけ。mod へ値で渡す）。 */
	| { t: 'action/answerApproval'; id: number; token?: string; requestId: string; epoch: string; interactionId: string; choice: string; optionLabel?: string; promptHash?: string; message?: string }
	/** 承認の画面に出ている番号付きの選択肢を求める（W2-21、`agent.approval.options.v1`）。答えは所有ウィンドウが直接返す。 */
	| { t: 'approval-options'; id: number; token?: string; requestId: string; epoch: string; interactionId: string }
	| { t: 'action/claudeSetting'; id: number; token?: string; requestId: string; epoch: string; setting: 'model' | 'effort'; value: string }
	| { t: 'model-catalog'; id: number; token?: string; requestId: string }
	/** `format: 2`（`agent.commands.v2`）: 同じ名前の重なり・`plugin` / `mcp` の出どころを含む一覧を求める。無ければ古い形で返す。 */
	| { t: 'command-catalog'; id: number; token?: string; requestId: string; format?: 2 }
	| { t: 'settings-update'; id: number; token?: string; requestId: string; model: string; effort: string }
	| { t: 'activity-detail'; id: number; token?: string; requestId: string; epoch: string; activityId: string }
	| { t: 'tool-full'; id: number; token?: string; requestId: string; epoch: string; rev: number }
	| { t: 'tool-image'; id: number; token?: string; requestId: string; epoch: string; rev: number; index: number }
	/**
	 * 古い発言を求める（W2-30、`agent.history.page.v1`）。`beforeRev` はモバイルが持っているいちばん古い発言の rev。
	 * `cursor` が無ければ PC のメモリ（リング）から、あれば前回の返事の `cursor` の位置から記録ファイルを後ろへ読む。
	 */
	| { t: 'history'; id: number; token?: string; requestId: string; epoch: string; beforeRev: number; cursor?: string; limit?: number }
	/** バックグラウンドのシェルの出力の末尾と停止（`agent.shells.v1`。paradisAgentShellOutput.ts）。 */
	| ParadisAgentShellInbound;

/** agentチャネルのPC→モバイルメッセージ。 */
type AgentOutbound =
	| { t: 'snapshot'; id: number; agent: ParadisAgentKind; epoch: string; rev: number; messages: IParadisAgentChatMessage[]; truncated?: boolean; info?: IParadisAgentSessionInfo; live?: IParadisAgentLiveState | null; liveRevision?: number; activity?: IParadisAgentActivityState | null; interaction?: IParadisAgentInteraction | null; capabilities?: { readonly agentActions: true; readonly claudeSettings?: true }; monitors?: readonly IParadisAgentMonitor[]; monitorsAt?: number } & IParadisAgentShellsField
	| { t: 'delta'; id: number; agent: ParadisAgentKind; epoch: string; rev: number; messages: IParadisAgentChatMessage[]; info?: IParadisAgentSessionInfo; live?: IParadisAgentLiveState | null; liveRevision?: number; liveAppend?: IParadisAgentLiveAppendPatch; activity?: IParadisAgentActivityState | null; interaction?: IParadisAgentInteraction | null; capabilities?: { readonly agentActions: true; readonly claudeSettings?: true }; monitors?: readonly IParadisAgentMonitor[]; monitorsAt?: number } & IParadisAgentShellsField
	| { t: 'command-catalog'; id: number; requestId: string; commands: readonly IParadisAgentCommandOption[]; format?: 2 }
	| { t: 'command-catalog-error'; id: number; requestId: string; message: string }
	| { t: 'settings-update'; id: number; requestId: string; status: 'pending' | 'confirmed' | 'failed'; info?: IParadisAgentSessionInfo; code?: string; message?: string }
	/** `late: true`: 受け付けた後で断られたと分かった（キーで送ったスラッシュコマンドへの Claude Code の `Unknown command`）。 */
	| { t: 'action-result'; id: number; requestId: string; status: 'accepted' | 'rejected'; code?: string; message?: string; consumed?: boolean; late?: true }
	| { t: 'activity-detail'; id: number; requestId: string; activityId: string; messages?: readonly IParadisAgentActivityDetailMessage[]; error?: string }
	| { t: 'tool-full'; id: number; requestId: string; rev: number; text?: string; error?: string }
	| { t: 'tool-image'; id: number; requestId: string; rev: number; index: number; mediaType?: string; data?: string; error?: string }
	| { t: 'model-control-error'; id: number; requestId: string; code: string; message: string }
	/**
	 * 承認の選択肢（W2-21）。ふつうは所有ウィンドウ（画面を読める renderer）が直接返し、ここから送るのは
	 * 求めが古い・画面を読めない相手のときの `error` だけ。
	 */
	| { t: 'approval-options'; id: number; requestId: string; interactionId: string; options?: readonly IParadisAgentApprovalOption[]; promptHash?: string; warning?: string; error?: string }
	/**
	 * 古い発言（W2-30）。messages は古い順。記録ファイルから読んだものの rev は負の数（-1 から古い方へ減る）で、全文・画像の
	 * 取り寄せはできない。`cursor` があれば続きがあり、次の求めにそのまま付ける。`hasMore` が false ならこれより前は無いか、
	 * `capped`（1 ペインで読める上限に達した）。
	 */
	| { t: 'history'; id: number; requestId: string; epoch: string; messages?: readonly IParadisAgentChatMessage[]; cursor?: string; hasMore?: boolean; capped?: true; error?: string }
	| ParadisAgentShellOutbound
	| { t: 'none'; id: number };

/**
 * 1 問ぶんの回答。`notes`（メモ、`agent.question.notes.v1`）は preview のある質問にだけ付けられ、mod が待っているときしか渡せない。
 * `kind: 'notes'` は選択肢を選ばずにメモだけで答えるもの（同じ条件）。
 */
type AgentQuestionAnswer =
	| { readonly kind: 'option'; readonly index: number; readonly notes?: string }
	| { readonly kind: 'multi'; readonly indices: readonly number[]; readonly notes?: string }
	| { readonly kind: 'text'; readonly optionCount: number; readonly text: string; readonly notes?: string }
	| { readonly kind: 'notes'; readonly notes: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const POLL_INTERVAL_MS = 1500;
/** スラッシュコマンドの一覧を覚えておく時間（`/` を打つたびに求められる。デスクトップのチャット欄の COMMAND_CACHE_TTL と同じ考え方）。 */
const COMMAND_CATALOG_CACHE_MS = 30_000;
/** キーで送った Claude Code のスラッシュコマンドが断られたか（transcript の `Unknown command: /x`）を見張る上限（送った時刻から）。 */
const CLAUDE_UNKNOWN_COMMAND_WAIT_MS = 8_000;
/** 画面が開いているかの答えを覚えておく時間（続けて送るときの往復を省く。画面を開け閉めする間よりは十分短い）。 */
const DIALOG_ANSWER_CACHE_MS = 500;
/** 承認・質問以外の画面（/config など）が PC でキーを持っているときの断り（`action-result` の code と文）。 */
const PARADIS_PANEL_OPEN_CODE = 'panel-open';
const PARADIS_PANEL_OPEN_MESSAGE = 'PC の Claude Code で画面（/config など）が開いたままです。端末を開いて Esc を送ると閉じられます。閉じてから送り直してください';
/** mod が発言を送れなかったと答えたときの文（理由が届かなかったとき）。 */
const MOD_SEND_REFUSED_MESSAGE = 'PC の Claude Code がこの発言を受け付けませんでした。PC の画面で確かめてください';
/** Claude hookが渡す agent_id の受理形。SubagentStart/Stopの2経路(親子関係の解決・backgroundTasks反映)で共有する。 */
const PARADIS_CLAUDE_AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,500}$/;
/** state DB・rollout の名前に使われる Codex の thread ID の形（SQL・パスへ渡す前の検査）。 */
const PARADIS_CODEX_THREAD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,500}$/;
/** backgroundTasks上でtranscriptパース由来ID (openedTasks/closedTasks) と衝突させないための名前空間。 */
const HOOK_BACKGROUND_TASK_PREFIX = 'hook:';
/** 初回読み込みでファイルがこれより大きい場合、末尾のみ読む (長大セッション対策)。 */
const INITIAL_READ_MAX_BYTES = 8 * 1024 * 1024;
const INITIAL_READ_TAIL_BYTES = 4 * 1024 * 1024;
const APPEND_READ_CHUNK_BYTES = 1024 * 1024;
/**
 * 1行の上限。行はチャンクをまたいで remainder に積むため、この値を超えた行は
 * 先頭が落ちて JSON として壊れ、行ごと捨てられる。tool_result に入る画像
 * (base64) は1行が数MBになるので、TOOL_IMAGE_BASE64_LIMIT より大きく取る。
 * 初回読みの末尾窓 (INITIAL_READ_TAIL_BYTES) も同様に、画像行が丸ごと収まる幅が要る。
 */
const MAX_TRANSCRIPT_LINE_BYTES = 4 * 1024 * 1024;
/** 保持するメッセージ数の上限 (超過分は古いものから捨てる)。 */
const MESSAGE_RING_LIMIT = 400;
/** 預かりの送信の id を覚えておく数と時間（W2-29 のレビュー M4。アプリが預かるのは 24 時間まで）。 */
const SEND_ID_LIMIT = 500;
const SEND_ID_TTL_MS = 24 * 60 * 60 * 1000;
/** リングから押し出した発言の位置を残す数（W2-30。モバイルが持つ 500 件を十分に上回る）。 */
const EVICTED_POSITION_LIMIT = 2000;
/**
 * 通知回数のカウンタを覚えておく上限（計測用。超過分は最後に触ったものから遠い順に捨てる）。
 *
 * 1回の通知で「グループ単位」と「内容単位」の2エントリを使うので、質問の実効履歴はこの半分。
 * 追い出しで消えるとカウントが1に戻り、**まさに検出したい重複が上限付近で見えなくなる**ため、
 * 素朴な挿入順ではなく最終利用順で捨てる（{@link bumpQuestionNotifyCount}）。
 */
const QUESTION_NOTIFY_COUNT_LIMIT = 400;

/**
 * 質問の通知がどこまで進んだか。`dispatched` 以外は「出そうとしてやめた」。
 *
 * 「通知が届かない」の切り分けは、この内訳が無いと始まらない（浮上した回数だけを数えていても、
 * 出さなかったのか出したのに届かなかったのかが永久に分からない）。
 */
type ParadisQuestionNotifyOutcome = 'dispatched' | 'no-terminal' | 'no-owner' | 'unauthorized' | 'owner-changed' | 'authorize-failed' | 'suppressed-group' | 'suppressed-content';

/**
 * 群キーの抑制期限。1回の AskUserQuestion（質問N問）に対して鳴らすのは1度だけにする。
 * 期限を切るのは、回答が失われてTUIが同じ質問を出し直したときに鳴らし直せるようにするため
 * （期限が無いと、一度取りこぼした質問はその後どれだけ再提示されても二度と鳴らない）。
 */
const QUESTION_NOTIFY_GROUP_SUPPRESS_TTL_MS = 10 * 60_000;

/**
 * 内容キーの抑制期限。**群キーより意図的に短くしてある。**
 *
 * 内容キーは質問文と選択肢が同じなら一致するので、『続けますか？[はい/いいえ]』のような
 * 定型の再掲まで巻き込む。本来は「前の同内容質問がまだ未回答か」で線を引くのが正しいが、
 * 狙っている経路またぎの重複（live で浮上したものが transcript に書き出される）は秒オーダーで
 * 起きるのに対し、同じ文面が改めて聞かれるのは分オーダーなので、その時間差で近似している。
 * ここを伸ばすと定型質問の2回目以降が鳴らなくなる。
 */
const QUESTION_NOTIFY_CONTENT_SUPPRESS_TTL_MS = 60_000;
/** 回答のキー列を流し終えたかを見る待ち時間の上限（計測用）。 */
const QUESTION_SETTLE_MAX_WAIT_MS = 30_000;
/** attach応答スナップショットで送る最大件数。 */
const SNAPSHOT_SEND_LIMIT = 200;
/** 1ペインが保持する全文キャッシュの上限（件数・合計バイト）。古いrevから捨てる。 */
const FULL_TEXT_CACHE_ENTRIES = 40;
const FULL_TEXT_CACHE_BYTES = 2 * 1024 * 1024;
/**
 * 保持する画像キャッシュの上限（枚数・base64合計文字数）。参照の古い順に捨てる。
 * 画像は1枚で全文キャッシュ全体に匹敵するため、全文とは別枠で会計する。
 *
 * **上限は全ペインの合計**である点に注意（{@link ParadisSharedImageCache}）。ペインごとに
 * この枠を持たせると、エージェントを開いているペインの数だけメモリが積み上がる。base64 は
 * JS の文字列なので実メモリは文字数の約2倍で、16M 文字 = 約32MB。ここが常駐の上限になる。
 */
const IMAGE_CACHE_ENTRIES = 24;
const IMAGE_CACHE_BYTES = 16 * 1024 * 1024;
/** 1ペインで同時に送れる 'tool-image' の数（画面に見えている枚数ぶんは通す）。 */
const TOOL_IMAGE_MAX_IN_FLIGHT = 4;
const PERSISTED_ACTIVITY_HEAD_BYTES = 256 * 1024;
const PERSISTED_ACTIVITY_MAX_AGENTS = 100;
const PERSISTED_ACTIVITY_META_MAX_BYTES = 64 * 1024;
/**
 * live ティッカー（モバイルの「応答を生成中（NN分NN秒）」）を強制失効させるまでの無更新時間。
 * 完了シグナル（Claude の Stop hook / Codex の turn/completed）は単一障害点で、1つでも
 * 取りこぼすと経過カウンタが永久に伸び続け、さらに isAgentPrompt が false のままになって
 * モバイルからのモデル・Effort 変更まで拒否され続ける。SubAgent活動やペインstatusには
 * 同種のsweepが既にあるので、live状態にも最終防衛線を置く。
 *
 * ターン進行中かどうかで閾値を変えないのは、shared process の再起動やリレー再ロードで
 * ターン途中から参加すると UserPromptSubmit を取りこぼし「実行中なのに終了済み扱い」に
 * なるため。短い閾値を当てると実行中の live を誤って消し、さらに isAgentPrompt が true に
 * なって実行中のCLIへ /model 等が注入されうる。progress を出さない長時間ツール（Bash等）
 * でも更新は途切れるので、誤発火しない長さに倒す。
 */
const LIVE_STALE_MS = 30 * 60_000;
/** ペイン同期前に受けたhookを保持する時間とtoken単位の上限。 */
const PENDING_HOOK_TTL_MS = 120_000;
const PENDING_HOOK_LIMIT = 256;
/** rollout path → root/SubAgent 判定の記憶上限（無制限な成長の防止のみが目的）。 */
const CODEX_ROLLOUT_ORIGIN_CACHE_LIMIT = 512;
/**
 * ターン終了後、遅れて届いた live 更新を無視する猶予。
 *
 * hook は curl の別プロセスから並行 POST されるため、Stop と前後して MessageDisplay や
 * PostToolUse が届く。clearLiveState は liveMessageBuffers も消すので遅着分は重複判定にも
 * 掛からず、prefix 無し・startedAt=遅着時刻 で live を作り直してしまい、そしてそれを消す
 * イベントはもう来ない（モバイルの「応答を生成中(NN分NN秒)」が伸び続ける直接原因）。
 * 発火時刻の単純な前後比較では、Stop より後に発火した遅着を捕まえられないため窓で判定する。
 * 新しいターンが始まれば UserPromptSubmit が窓を解除するので、次ターンの更新は捨てない。
 */
const LATE_HOOK_AFTER_TURN_END_MS = 3_000;
const nodeRequire = createRequire(import.meta.url);
/**
 * Claude Code が、利用者が許可を拒否したツールの結果に書く定型文の書き出し（tool_result の is_error と組で見る）。
 * 全文は "The user doesn't want to proceed with this tool use. The tool use was rejected … STOP what you are
 * doing and wait for the user to tell you how to proceed." で、エージェントはそこで次の指示を待つ。
 */
const PARADIS_CLAUDE_TOOL_REJECTED_PREFIX = `The user doesn't want to proceed with this tool use`;
/**
 * Codex が、利用者が承認を拒否した（codex-cli 0.155.1 の `No, and tell Codex what to do differently (esc)`）
 * ツールの結果（function_call_output）の最後の行。実機では `Wall time: 7.5 seconds\naborted by user` のように
 * 前に経過時間の行が付く。直後に rollout へ `turn_aborted` を書き、次の指示を待つ。
 */
const PARADIS_CODEX_TOOL_ABORTED_TEXT = 'aborted by user';

/**
 * 利用者が許可を拒否して、エージェントが止まって次の指示を待つツールの結果か（Claude Code の定型文、Codex の `aborted by user`）。
 *
 * 拒否に指示が添えてあるもの（TUI の Tab to amend の「No, and tell Claude what to do differently」と、モバイルの「拒否して
 * 指示を書く」。どちらも {@link PARADIS_APPROVAL_INSTRUCTION_MARKER} を含む）は、エージェントがその指示で作業を続けるので
 * 止まった拒否に数えない（数えると、作業中のペインを待機へ落とし、live を消してしまう）。
 */
export function paradisIsToolRejection(agent: ParadisAgentKind, message: IParadisAgentChatMessage): boolean {
	if (message.kind !== 'tool_result') {
		return false;
	}
	return agent === 'codex'
		? message.text.trim().split('\n').pop()?.trim() === PARADIS_CODEX_TOOL_ABORTED_TEXT
		: message.isError === true && message.text.startsWith(PARADIS_CLAUDE_TOOL_REJECTED_PREFIX) && !message.text.includes(PARADIS_APPROVAL_INSTRUCTION_MARKER);
}

/** ペインごとに覚える未完了のツール呼び出しの上限（hook の取りこぼしで伸び続けないように）。 */
const PARADIS_OPEN_TOOL_USE_LIMIT = 256;
/** Agent の PreToolUse から SubagentStart までを同じ起動とみなす長さ（許可の確認を待つ間も含める）。 */
const SUBAGENT_START_PAIRING_WINDOW_MS = 10 * 60_000;
/** mod から受け取った行・ファイルから読んだ行の uuid を覚えておく件数（1 ペインあたり）。 */
const MOD_ROW_LEDGER_LIMIT = 2_000;
/** mod へ渡した回答を覚えておく時間（同じカードへの二度目をキーの経路へ回さないため）。 */
const MOD_ANSWER_LOCK_MS = 60_000;
/** mod が生成中の文章を流している間、MessageDisplay hook の先出しを使わない時間。 */
const MOD_STREAM_PREFERRED_MS = 5 * 60_000;
/** mod が busy で断った発言を、1 通目の行方が分かるまで待つ上限。過ぎたらキーで送る。 */
const MOD_BUSY_WAIT_MS = 15_000;

/** hook 由来の承認の選択肢（許可 / 拒否）。モバイルは画面の番号付きの選択肢を求めることがある（W2-21）。 */
const PARADIS_DEFAULT_APPROVAL_CHOICES: readonly IParadisAgentApprovalChoice[] = Object.freeze([
	{ id: 'yes', label: '許可', tone: 'approve' },
	{ id: 'no', label: '拒否', tone: 'deny' },
]);

/** mod から受け取った行を、ファイルに同じ行が現れるのを待って保留する時間（ファイルの方が先なら mod の行は捨てる）。 */
const MOD_ROW_HOLD_MS = 300;

/**
 * mod（Claude Mods）が答えられ、「以後は確認しない」のルールも足せる承認の選択肢。`always` は mod が
 * PermissionRequest の permission_suggestions をそのまま返す。足されるルールを文言に出し、設定ファイルやモードのように
 * セッションを越えて残るものを含むときは「今回だけ」と「ルールを残す」をはっきり分ける。モバイルは選択肢が
 * 「許可 / 拒否」だけでないとき画面の選択肢を求めないので、答えは値のまま mod へ届く。
 */
export function paradisModApprovalChoices(suggestions: readonly unknown[]): readonly IParadisAgentApprovalChoice[] {
	const entries = suggestions.map(rec).filter((entry): entry is Record<string, unknown> => entry !== undefined);
	const modes = paradisApprovalSuggestionLabels(entries.filter(entry => entry.type === 'setMode')) ?? [];
	const ruleEntries = entries.filter(entry => entry.type !== 'setMode');
	const rules = paradisApprovalSuggestionLabels(ruleEntries) ?? [];
	if (modes.length === 0 && rules.length === 0) {
		return PARADIS_DEFAULT_APPROVAL_CHOICES;
	}
	// 残り方の分からないもの（`destination` が無い・知らない値）は、残る側に倒す（paradisApprovalSuggestionScope と同じ）
	const persistentRules = ruleEntries.some(entry => entry.destination !== 'session');
	// 文言は 200 文字まで（モバイルの上限）。入りきらない分は「ほか n 件」にまとめる
	const list = (prefix: string, items: readonly string[], suffix = '') => {
		for (let shown = items.length; shown > 0; shown--) {
			const rest = items.length - shown;
			const label = `${prefix}${items.slice(0, shown).join('、')}${rest > 0 ? ` ほか ${rest} 件` : ''}${suffix}`;
			if (label.length <= 200) {
				return label;
			}
		}
		return `${prefix}${items.length} 件${suffix}`.slice(0, 200);
	};
	const always = modes.length > 0
		? list('許可してモードを切り替える: ', [...modes, ...rules])
		: persistentRules
			? list('許可して設定に残す: ', rules)
			: list('許可（このセッションでは以後確認しない: ', rules, '）');
	// モードの切り替えや設定ファイルへの書き込みはセッションを越えて残るので、「今回だけ」をはっきり分ける
	const lasting = modes.length > 0 || persistentRules;
	return [
		{ id: 'yes', label: lasting ? '今回だけ許可' : '許可', tone: 'approve' },
		{ id: 'always', label: always, tone: lasting ? 'neutral' : 'approve' },
		{ id: 'no', label: '拒否', tone: 'deny' },
	];
}


/** 承認のカードの本文（ツール名と、説明かコマンドか入力の JSON）。hook と mod の承認を突き合わせるのにも使う。 */
function paradisApprovalRequestText(toolName: string | undefined, toolInput: unknown): string {
	const input = rec(toolInput);
	const detail = str(input?.description) ?? str(input?.command) ?? (input !== undefined ? JSON.stringify(input) : '');
	return [toolName, detail].filter(v => v !== undefined && v.length > 0).join(': ');
}

/** キーの順序に依らない JSON（PreToolUse と PermissionRequest の tool_input を突き合わせるため）。 */
function paradisStableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(paradisStableJson).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${paradisStableJson(record[key])}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'undefined';
}

/** デスクトップのチャット表示の登録の期限。表示側はこれより短い間隔で送り直す。 */
const PARADIS_DESKTOP_CHAT_WATCH_TTL_MS = 30_000;
/** 1ウィンドウが一度に見られるペインの数（外からの入力で Set が伸び続けないための上限）。 */
const PARADIS_DESKTOP_CHAT_MAX_TOKENS = 256;
/** 変化の知らせをまとめる間隔。生成中の文字の流れが途切れて見えない程度に短くする。 */
const PARADIS_DESKTOP_CHAT_NOTIFY_DELAY_MS = 80;

/** 生成中テキストは後続deltaが見えるよう、上限超過時は末尾を保持する。 */
function truncateLiveText(text: string, limit: number): string {
	// allow-any-unicode-next-line
	return text.length > limit ? `…${text.slice(-(limit - 1))}` : text;
}

function newEpoch(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** {@link paradisLocalAgentPath} の、値が無いこともある版。 */
function paradisLocalAgentPathOrUndefined(homes: IParadisAgentHomes, recordedPath: string | undefined): string | undefined {
	return recordedPath === undefined ? undefined : paradisLocalAgentPath(homes, recordedPath);
}

function agentKindForPath(transcriptPath: string): ParadisAgentKind {
	// CODEX_HOME を移動していると ".codex" がパスに現れないため、rolloutのファイル名規約と
	// 解決済みhome配下かでも判定する (Claude の transcript は <uuid>.jsonl でrollout-接頭辞を持たない)。
	// アカウントを切り替えると ~/.codex-2 のような別ホームに書かれるので、その形も Codex とみなす。
	if (/[\\/]\.codex(?:-[\w.]+)?[\\/]/.test(transcriptPath) || /[\\/]rollout-[^\\/]*\.jsonl$/.test(transcriptPath)) {
		return 'codex';
	}
	return paradisIsWithinCodexHome(transcriptPath) ? 'codex' : 'claude';
}

/**
 * hook経由で届いた transcript_path が許可ディレクトリ（~/.claude / ~/.codex 配下）に
 * 収まっているかを検証する。ペイントークンはターミナルの全子プロセスへ環境変数として
 * 渡るため、hookエンドポイントを騙って任意ファイルをモバイルへtailさせる悪用を防ぐ
 * （所在検証 + realpath でシンボリックリンク・`..` 経由の脱出も排除する）。
 */
/** 許可 root の realpath（解決できたものだけ覚える。root は起動中に変わらない）。 */
const rootRealpaths = new Map<string, string>();

/** 許可 root の字面と realpath 後の綴り（重複なし）。 */
async function paradisRootSpellings(roots: readonly string[]): Promise<string[]> {
	const spellings = new Set<string>();
	for (const root of roots) {
		spellings.add(root);
		let real = rootRealpaths.get(root);
		if (real === undefined) {
			try {
				real = await fs.realpath(root);
				rootRealpaths.set(root, real);
			} catch {
				// まだ無い（初回起動前など）。字面だけで比べる。
			}
		}
		if (real !== undefined) {
			spellings.add(real);
		}
	}
	return [...spellings];
}

/** 回帰テスト用。本番と同じ規則で transcript のパスを許すかを返す。 */
export function paradisIsAllowedTranscriptPathForTest(transcriptPath: string): Promise<boolean> {
	return isAllowedTranscriptPath(transcriptPath);
}

async function isAllowedTranscriptPath(transcriptPath: string): Promise<boolean> {
	if (!isAbsolute(transcriptPath) || !transcriptPath.endsWith('.jsonl')) {
		return false;
	}
	const resolved = resolve(transcriptPath);
	if (paradisIsWslAgentHomePath(resolved)) {
		// WSL の中の symlink は Windows 側の realpath では解決されない（UNC がそのまま返る）ので、
		// 解決結果を根拠にできない。字面の検証だけで許す。ディストロ内の symlink で許可 root の
		// 外へ抜けられる余地は残るが、そこへファイルを置ける相手は既にそのユーザーのホームへ
		// 書ける立場にあり、中身をコピーすれば同じ結果を得られる。
		return true;
	}
	// 接続先の transcript は写しを読む。写しは私たちしか書かない場所にあるので、許可rootに加える
	// （hookを騙って任意ファイルを読ませる筋道は増えない）。
	// 許可 root は、字面と realpath 後の両方の綴りで比べる。`CLAUDE_CONFIG_DIR` などが symlink を含むと
	// （macOS の `/tmp` → `/private/tmp`）、エージェントが報告する transcript のパスや、下の実体の確認で得る
	// パスが root の字面と合わず、正しい transcript を「root の外」として拒んでいた（フェーズ6の実機確認）。
	// root の外へ抜ける symlink は、実体（realpath）が どちらの綴りの root にも入らないので引き続き拒む。
	// Codex はアカウントごとに別ホーム（~/.codex-2 等）へ書くので、全ホームを許可 root にする。
	const roots = await paradisRootSpellings([paradisClaudeConfigDir(), ...paradisCodexHomes(), ...paradisRemoteTranscriptMirrorRoots()]);
	const within = (candidate: string) => roots.some(root => candidate === root || candidate.startsWith(root + sep));
	if (!within(resolved)) {
		return false;
	}
	try {
		// 実体（シンボリックリンク解決後）も許可ディレクトリ内であること。
		return within(await fs.realpath(transcriptPath));
	} catch {
		// 未作成ファイルは字面検証のみで許可する（tailerは作成を待てる）。
		return true;
	}
}

async function isAllowedOpenTranscriptPath(handle: fs.FileHandle, transcriptPath: string): Promise<boolean> {
	if (!await isAllowedTranscriptPath(transcriptPath)) { return false; }
	try {
		const [opened, current] = await Promise.all([handle.stat(), fs.stat(await fs.realpath(transcriptPath))]);
		return opened.dev === current.dev && opened.ino === current.ino && opened.isFile();
	} catch { return false; }
}

/** 復元用に先頭メタ情報と末尾状態を上限付きで読み、途中行は採用しない。 */
async function readPersistedTranscriptLines(transcriptPath: string): Promise<readonly string[]> {
	if (!await isAllowedTranscriptPath(transcriptPath)) { return []; }
	let handle: fs.FileHandle | undefined;
	try {
		const stat = await fs.stat(transcriptPath);
		if (!stat.isFile() || stat.size <= 0) { return []; }
		handle = await fs.open(transcriptPath, 'r');
		if (!await isAllowedOpenTranscriptPath(handle, transcriptPath)) { return []; }
		const tailBytes = Math.min(INITIAL_READ_TAIL_BYTES, stat.size);
		if (stat.size <= PERSISTED_ACTIVITY_HEAD_BYTES + tailBytes) {
			const buffer = Buffer.alloc(stat.size);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return buffer.subarray(0, bytesRead).toString('utf8').split('\n').filter(Boolean);
		}
		const head = Buffer.alloc(PERSISTED_ACTIVITY_HEAD_BYTES);
		const tail = Buffer.alloc(tailBytes);
		const [headRead, tailRead] = await Promise.all([
			handle.read(head, 0, head.length, 0),
			handle.read(tail, 0, tail.length, stat.size - tailBytes),
		]);
		const headLines = head.subarray(0, headRead.bytesRead).toString('utf8').split('\n');
		headLines.pop();
		const tailLines = tail.subarray(0, tailRead.bytesRead).toString('utf8').split('\n');
		tailLines.shift();
		return [...headLines, ...tailLines].filter(Boolean);
	} catch {
		return [];
	} finally {
		if (handle !== undefined) { await handle.close().catch(() => undefined); }
	}
}

interface IClaudePersistedSubagentFile {
	readonly id: string;
	readonly path: string;
	readonly mtime: number;
	readonly meta?: IParadisClaudeSubagentMeta;
}

/**
 * `agent-<id>.meta.json`（Claude Codeが子transcriptと並べて書く素性メタ）を読む。
 * 種別・依頼内容・階層はここにしか無く、これが無いと一覧が「SubAgent」だらけになる。
 */
async function readClaudeSubagentMeta(transcriptPath: string): Promise<IParadisClaudeSubagentMeta | undefined> {
	const raw = await fs.readFile(transcriptPath.replace(/\.jsonl$/i, '.meta.json'), 'utf8').catch(() => undefined);
	if (raw === undefined || raw.length > PERSISTED_ACTIVITY_META_MAX_BYTES) { return undefined; }
	try {
		const parsed = rec(JSON.parse(raw));
		const agentType = str(parsed?.agentType);
		const description = str(parsed?.description);
		const spawnDepth = num(parsed?.spawnDepth);
		const name = str(parsed?.name);
		if (agentType === undefined && description === undefined && spawnDepth === undefined && name === undefined) { return undefined; }
		return {
			...(agentType !== undefined ? { agentType } : {}),
			...(description !== undefined ? { description } : {}),
			...(spawnDepth !== undefined ? { spawnDepth } : {}),
			...(name !== undefined ? { name } : {}),
		};
	} catch {
		return undefined;
	}
}

async function discoverClaudePersistedSubagentFiles(rootTranscriptPath: string): Promise<readonly IClaudePersistedSubagentFile[]> {
	const dir = resolve(rootTranscriptPath, '..');
	const filename = rootTranscriptPath.slice(rootTranscriptPath.lastIndexOf(sep) + 1).replace(/\.jsonl$/i, '');
	const subagentsDir = join(dir, filename, 'subagents');
	let entries: Dirent[];
	try { entries = await fs.readdir(subagentsDir, { withFileTypes: true }); } catch { return []; }
	const files: { id: string; path: string; mtime: number }[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) { continue; }
		const match = /^agent-([A-Za-z0-9._:-]{1,500})\.jsonl$/.exec(entry.name);
		// `/btw` の脇の質問も同じ置き場に `agent-aside_question-*` として書かれるが、サブエージェントではない
		if (match === null || match[1].startsWith('aside_question-')) { continue; }
		const path = join(subagentsDir, entry.name);
		if (!await isAllowedTranscriptPath(path)) { continue; }
		const stat = await fs.stat(path).catch(() => undefined);
		if (stat?.isFile()) { files.push({ id: match[1], path, mtime: stat.mtimeMs }); }
	}
	const selected = files.sort((a, b) => b.mtime - a.mtime).slice(0, PERSISTED_ACTIVITY_MAX_AGENTS);
	return Promise.all(selected.map(async file => {
		const meta = await readClaudeSubagentMeta(file.path);
		return { ...file, ...(meta !== undefined ? { meta } : {}) };
	}));
}

interface ICodexPersistedSubagentFile {
	readonly id: string;
	readonly path: string;
	readonly source: string;
	readonly mtime: number;
}

/**
 * 全 Codex ホームを順に見て、最初に見つかった結果を返す。アカウントを切り替えるとペインごとに
 * 別のホームで Codex が動くので、既定のホームだけを見ると取りこぼす。
 */
async function firstInCodexHomes<T>(homes: IParadisAgentHomes, find: (home: IParadisAgentHomes) => Promise<T | undefined>): Promise<T | undefined> {
	for (const home of paradisEachCodexHome(homes)) {
		const found = await find(home);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

async function discoverCodexPersistedSubagentFiles(rootThreadId: string, homes: IParadisAgentHomes): Promise<readonly ICodexPersistedSubagentFile[]> {
	return await firstInCodexHomes(homes, async home => {
		const found = await discoverCodexPersistedSubagentFilesInHome(rootThreadId, home);
		return found.length > 0 ? found : undefined;
	}) ?? [];
}

async function discoverCodexPersistedSubagentFilesInHome(rootThreadId: string, homes: IParadisAgentHomes): Promise<readonly ICodexPersistedSubagentFile[]> {
	if (!PARADIS_CODEX_THREAD_ID_PATTERN.test(rootThreadId)) { return []; }
	let database: DatabaseSync | undefined;
	try {
		const names = await fs.readdir(homes.codex);
		const stateDb = names.filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
		if (stateDb === undefined) { return []; }
		const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		database = new DatabaseSyncCtor(join(homes.codex, stateDb), { readOnly: true });
		const rows = database.prepare(`
			SELECT id, rollout_path, source, COALESCE(updated_at_ms, updated_at * 1000) AS mtime
			FROM threads
			WHERE archived = 0 AND source LIKE '%"thread_spawn"%'
			ORDER BY mtime DESC
			LIMIT 1000
		`).all() as unknown[];
		const candidates = rows.map(value => {
			const row = rec(value);
			const id = str(row?.id);
			// state DB に書かれているのは Codex から見たパス。WSL なら Linux 側の表記なので戻す。
			const path = paradisLocalAgentPathOrUndefined(homes, str(row?.rollout_path));
			const source = str(row?.source);
			const mtime = num(row?.mtime);
			const relationship = source !== undefined ? paradisParseCodexThreadSource(source) : undefined;
			return id !== undefined && PARADIS_CODEX_THREAD_ID_PATTERN.test(id) && path !== undefined && isAbsolute(path) && path.endsWith('.jsonl') && source !== undefined && mtime !== undefined && relationship !== undefined
				? { id, path, source, mtime, parentId: relationship.parentThreadId, depth: relationship.depth }
				: undefined;
		}).filter((value): value is ICodexPersistedSubagentFile & { readonly parentId: string; readonly depth: number } => value !== undefined);
		const selected: ICodexPersistedSubagentFile[] = [];
		let parents = new Set([rootThreadId]);
		for (let depth = 1; depth <= 5 && parents.size > 0 && selected.length < PERSISTED_ACTIVITY_MAX_AGENTS; depth++) {
			const children = candidates.filter(candidate => parents.has(candidate.parentId) && !selected.some(item => item.id === candidate.id));
			selected.push(...children.slice(0, PERSISTED_ACTIVITY_MAX_AGENTS - selected.length));
			parents = new Set(children.map(child => child.id));
		}
		return selected;
	} catch {
		return [];
	} finally {
		database?.close();
	}
}


type AgentInboundCandidate = Record<string, unknown>;
type ValidTerminalIdentity = AgentInboundCandidate & { readonly id: number; readonly token?: string };
type ValidControlRequest = ValidTerminalIdentity & { readonly requestId: string };

function isValidTerminalIdentity(msg: AgentInboundCandidate): msg is ValidTerminalIdentity {
	return typeof msg.id === 'number' && Number.isSafeInteger(msg.id) && msg.id >= 0
		&& (msg.token === undefined || (typeof msg.token === 'string' && msg.token.length > 0 && msg.token.length <= 200));
}

function isValidControlRequest(msg: AgentInboundCandidate): msg is ValidControlRequest {
	return typeof msg.requestId === 'string' && msg.requestId.length > 0 && msg.requestId.length <= 100
		&& isValidTerminalIdentity(msg);
}

function isValidAgentQuestionAnswer(value: unknown): value is AgentQuestionAnswer {
	const answer = rec(value);
	if (answer === undefined || typeof answer.kind !== 'string') {
		return false;
	}
	const notesValid = answer.notes === undefined || (typeof answer.notes === 'string' && answer.notes.trim().length > 0 && answer.notes.length <= PARADIS_AGENT_QUESTION_NOTES_LIMIT);
	if (!notesValid) {
		return false;
	}
	if (answer.kind === 'notes') {
		return answer.notes !== undefined;
	}
	if (answer.kind === 'option') {
		return Number.isInteger(answer.index) && typeof answer.index === 'number' && answer.index >= 0 && answer.index < 100;
	}
	if (answer.kind === 'multi') {
		return Array.isArray(answer.indices) && answer.indices.length > 0 && answer.indices.length <= 100
			&& answer.indices.every((index: unknown) => typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 100);
	}
	return answer.kind === 'text' && typeof answer.optionCount === 'number' && Number.isInteger(answer.optionCount) && answer.optionCount >= 0 && answer.optionCount < 100
		&& typeof answer.text === 'string' && answer.text.trim().length > 0 && answer.text.length <= 10_000;
}

/** 回答がそのカード（質問）の形に合うか。メモは preview のある質問にだけ付けられる。 */
function paradisQuestionAnswerFits(question: IParadisAgentChatMessage | undefined, answer: AgentQuestionAnswer): boolean {
	if (question === undefined) {
		return false;
	}
	const optionCount = question.options?.length ?? 0;
	if (answer.notes !== undefined && !paradisAgentQuestionHasPreview(question)) {
		return false;
	}
	switch (answer.kind) {
		case 'option': return question.multiSelect !== true && answer.index < optionCount;
		case 'multi': return question.multiSelect === true && answer.indices.every(value => value < optionCount);
		case 'text': return answer.optionCount === optionCount;
		case 'notes': return true;
	}
}

/** キーの列で渡せる回答（メモを持たない、選択肢・複数選択・自由入力）。 */
function paradisIsKeyQuestionAnswer(answer: AgentQuestionAnswer): answer is Exclude<AgentQuestionAnswer, { readonly kind: 'notes' }> {
	return answer.kind !== 'notes' && answer.notes === undefined;
}

function paradisQuestionKeyShape(question: IParadisAgentChatMessage): { readonly optionCount: number; readonly multiSelect: boolean; readonly hasPreview: boolean } {
	return { optionCount: question.options?.length ?? 0, multiSelect: question.multiSelect === true, hasPreview: paradisAgentQuestionHasPreview(question) };
}

function paradisShownOptionLabels(question: IParadisAgentChatMessage): readonly string[] {
	return (question.options ?? []).map(option => option.label);
}

/** カードの選択肢のラベルの切り詰め（parseAskUserQuestions と同じ）。 */
function paradisTruncateOptionLabel(label: string): string {
	return truncateText(label, 200);
}

function isValidAttachRequest(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'attach' }> {
	return msg.t === 'attach'
		&& (msg.epoch === undefined || (typeof msg.epoch === 'string' && msg.epoch.length > 0 && msg.epoch.length <= 200))
		&& (msg.afterRev === undefined || (typeof msg.afterRev === 'number' && Number.isSafeInteger(msg.afterRev) && msg.afterRev >= -1))
		&& (msg.liveEncoding === undefined || (typeof msg.liveEncoding === 'string' && msg.liveEncoding.length > 0 && msg.liveEncoding.length <= 100))
		&& isValidTerminalIdentity(msg);
}

function isValidDetachRequest(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'detach' }> {
	return msg.t === 'detach' && isValidTerminalIdentity(msg);
}

function isValidSendMessageAction(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'action/sendMessage' }> {
	return msg.t === 'action/sendMessage'
		&& typeof msg.epoch === 'string' && msg.epoch.length > 0 && msg.epoch.length <= 200
		&& typeof msg.text === 'string' && msg.text.trim().length > 0 && msg.text.length <= 100_000
		&& (msg.sendId === undefined || (typeof msg.sendId === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(msg.sendId)))
		&& isValidControlRequest(msg);
}

function isValidQuestionAction(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'action/answerQuestion' }> {
	return msg.t === 'action/answerQuestion'
		&& typeof msg.epoch === 'string' && msg.epoch.length > 0 && msg.epoch.length <= 200
		&& typeof msg.interactionId === 'string' && msg.interactionId.length > 0 && msg.interactionId.length <= 500
		&& Array.isArray(msg.answers) && msg.answers.length > 0 && msg.answers.length <= 20
		&& msg.answers.every(isValidAgentQuestionAnswer)
		&& isValidControlRequest(msg);
}

function isValidClarifyQuestionAction(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'action/clarifyQuestion' }> {
	return msg.t === 'action/clarifyQuestion'
		&& typeof msg.epoch === 'string' && msg.epoch.length > 0 && msg.epoch.length <= 200
		&& typeof msg.interactionId === 'string' && msg.interactionId.length > 0 && msg.interactionId.length <= 500
		&& (msg.response === undefined || (typeof msg.response === 'string' && msg.response.trim().length > 0 && msg.response.length <= PARADIS_AGENT_QUESTION_RESPONSE_LIMIT))
		&& (msg.answers === undefined || (Array.isArray(msg.answers) && msg.answers.length > 0 && msg.answers.length <= 20
			&& msg.answers.every((answer: unknown) => answer === null || isValidAgentQuestionAnswer(answer))))
		&& isValidControlRequest(msg);
}

function isValidApprovalAction(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'action/answerApproval' }> {
	return msg.t === 'action/answerApproval'
		&& typeof msg.epoch === 'string' && msg.epoch.length > 0 && msg.epoch.length <= 200
		&& typeof msg.interactionId === 'string' && msg.interactionId.length > 0 && msg.interactionId.length <= 500
		&& typeof msg.choice === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(msg.choice)
		&& (msg.optionLabel === undefined || (typeof msg.optionLabel === 'string' && msg.optionLabel.length > 0 && msg.optionLabel.length <= 500))
		&& (msg.promptHash === undefined || (typeof msg.promptHash === 'string' && /^[0-9a-f]{40}$/.test(msg.promptHash)))
		&& (msg.message === undefined || (msg.choice === 'no' && typeof msg.message === 'string' && paradisSanitizeApprovalInstruction(msg.message).length > 0 && msg.message.length <= PARADIS_AGENT_APPROVAL_DENY_MESSAGE_LIMIT))
		&& isValidControlRequest(msg);
}

function isValidApprovalOptionsRequest(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'approval-options' }> {
	return msg.t === 'approval-options'
		&& typeof msg.epoch === 'string' && msg.epoch.length > 0 && msg.epoch.length <= 200
		&& typeof msg.interactionId === 'string' && msg.interactionId.length > 0 && msg.interactionId.length <= 500
		&& isValidControlRequest(msg);
}

function isValidClaudeSettingAction(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'action/claudeSetting' }> {
	return msg.t === 'action/claudeSetting'
		&& typeof msg.epoch === 'string' && msg.epoch.length > 0 && msg.epoch.length <= 200
		&& (msg.setting === 'model' || msg.setting === 'effort')
		&& typeof msg.value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(msg.value)
		&& isValidControlRequest(msg);
}

function isValidModelCatalogRequest(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'model-catalog' }> {
	return msg.t === 'model-catalog' && isValidControlRequest(msg);
}

function isValidCommandCatalogRequest(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'command-catalog' }> {
	return msg.t === 'command-catalog' && Object.keys(msg).every(key => key === 't' || key === 'id' || key === 'token' || key === 'requestId' || key === 'format')
		&& (msg.format === undefined || msg.format === 2)
		&& isValidControlRequest(msg);
}

function isValidSettingsUpdateRequest(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'settings-update' }> {
	return msg.t === 'settings-update'
		&& typeof msg.model === 'string' && msg.model.length > 0 && msg.model.length <= 500
		&& typeof msg.effort === 'string' && msg.effort.length > 0 && msg.effort.length <= 100
		&& isValidControlRequest(msg);
}

/** Advisor の平文の返答を、activity-detail の応答のメッセージ 1 件にする（サブエージェントの詳細と同じ形）。 */
export function paradisAdvisorReplyMessage(reply: NonNullable<ReturnType<ParadisAgentActivityTracker['advisorReply']>>): IParadisAgentActivityDetailMessage {
	return {
		role: 'tool', kind: 'tool', toolKind: 'tool_result', tool: PARADIS_ADVISOR_TOOL, text: reply.text,
		...(reply.truncated ? { truncated: true } : {}),
		advisor: { ...(reply.advisor.model !== undefined ? { model: reply.advisor.model } : {}), outcome: 'text' },
	};
}

function isValidActivityDetailRequest(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'activity-detail' }> {
	return msg.t === 'activity-detail'
		&& typeof msg.epoch === 'string' && msg.epoch.length > 0 && msg.epoch.length <= 200
		&& typeof msg.activityId === 'string' && msg.activityId.length > 0 && msg.activityId.length <= 500
		&& isValidControlRequest(msg);
}

function isValidToolFullRequest(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'tool-full' }> {
	return msg.t === 'tool-full'
		&& typeof msg.epoch === 'string' && msg.epoch.length > 0 && msg.epoch.length <= 200
		&& typeof msg.rev === 'number' && Number.isInteger(msg.rev) && msg.rev >= 0
		&& isValidControlRequest(msg);
}

function isValidToolImageRequest(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'tool-image' }> {
	return msg.t === 'tool-image'
		&& typeof msg.epoch === 'string' && msg.epoch.length > 0 && msg.epoch.length <= 200
		&& typeof msg.rev === 'number' && Number.isInteger(msg.rev) && msg.rev >= 0
		&& typeof msg.index === 'number' && Number.isInteger(msg.index) && msg.index >= 0 && msg.index < 100
		&& isValidControlRequest(msg);
}

function isValidHistoryRequest(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'history' }> {
	return msg.t === 'history'
		&& typeof msg.epoch === 'string' && msg.epoch.length > 0 && msg.epoch.length <= 200
		&& typeof msg.beforeRev === 'number' && Number.isSafeInteger(msg.beforeRev) && msg.beforeRev >= -PARADIS_HISTORY_FILE_CAP - 1
		&& (msg.cursor === undefined || (typeof msg.cursor === 'string' && paradisDecodeHistoryCursor(msg.cursor) !== undefined))
		&& (msg.limit === undefined || (typeof msg.limit === 'number' && Number.isInteger(msg.limit) && msg.limit >= 1 && msg.limit <= PARADIS_HISTORY_PAGE_LIMIT))
		&& isValidControlRequest(msg);
}

function parseAgentInbound(value: unknown): AgentInbound | undefined {
	const msg = rec(value);
	if (msg === undefined) {
		return undefined;
	}
	switch (msg.t) {
		case 'attach': return isValidAttachRequest(msg) ? msg : undefined;
		case 'detach': return isValidDetachRequest(msg) ? msg : undefined;
		case 'action/sendMessage': return isValidSendMessageAction(msg) ? msg : undefined;
		case 'action/answerQuestion': return isValidQuestionAction(msg) ? msg : undefined;
		case 'action/clarifyQuestion': return isValidClarifyQuestionAction(msg) ? msg : undefined;
		case 'action/answerApproval': return isValidApprovalAction(msg) ? msg : undefined;
		case 'approval-options': return isValidApprovalOptionsRequest(msg) ? msg : undefined;
		case 'action/claudeSetting': return isValidClaudeSettingAction(msg) ? msg : undefined;
		case 'model-catalog': return isValidModelCatalogRequest(msg) ? msg : undefined;
		case 'command-catalog': return isValidCommandCatalogRequest(msg) ? msg : undefined;
		case 'settings-update': return isValidSettingsUpdateRequest(msg) ? msg : undefined;
		case 'activity-detail': return isValidActivityDetailRequest(msg) ? msg : undefined;
		case 'tool-full': return isValidToolFullRequest(msg) ? msg : undefined;
		case 'tool-image': return isValidToolImageRequest(msg) ? msg : undefined;
		case 'history': return isValidHistoryRequest(msg) ? msg : undefined;
		case 'shell-output':
		case 'action/stopShell': return isValidControlRequest(msg) && paradisIsValidShellRequest(msg) ? msg as ValidControlRequest & ParadisAgentShellInbound : undefined;
		default: return undefined;
	}
}

export function paradisIsValidAgentInboundForTest(value: unknown): boolean {
	return parseAgentInbound(value) !== undefined;
}

/** Codex rollout先頭行から、cwdと共有daemonのthread IDを取り出す。 */
export interface IParadisCodexSessionMeta {
	readonly cwd: string;
	/**
	 * 共有daemonのthread ID。**SubAgentのrolloutでは「親の」thread IDが入る**
	 * （現行Codexは子rolloutの `session_id` へ親のIDを書き、自分のIDは `id` 側にある）。
	 * root判定にこの値を使ってはいけない。{@link subagent} を見ること。
	 */
	readonly sessionId?: string;
	/** SubAgentのthreadなら親のthread ID（親IDを読めなかった子では undefined になりうる）。 */
	readonly parentThreadId?: string;
	/** SubAgentとして生成されたthreadのrolloutか。root判定はこのフラグで行う。 */
	readonly subagent?: true;
	readonly depth?: number;
	readonly agentPath?: string;
	readonly agentNickname?: string;
	/**
	 * `codex fork` / TUI の `/fork` で作った thread なら、元の thread ID（codex-cli 0.160.0 で実測）。
	 * fork 先は fork した瞬間に state DB の行と rollout ができ、持ち主のペインが決まる前から照合の候補に入る。
	 * サブエージェントの rollout にも入ることがある（その場合は {@link subagent} も立つ）。
	 */
	readonly forkedFromId?: string;
	/** fork 先の rollout が過去の会話を写さずに参照している、元の rollout の範囲（`history_base`）。 */
	readonly historyBase?: IParadisCodexHistoryBase;
}

/** fork 先の rollout の `history_base`。元の rollout の先頭から `endByteOffset` バイトまでが、fork 先の過去の会話。 */
export interface IParadisCodexHistoryBase {
	readonly threadId: string;
	readonly endByteOffset: number;
}

export function paradisParseCodexSessionMeta(firstLine: string): IParadisCodexSessionMeta | undefined {
	try {
		const meta = rec(JSON.parse(firstLine));
		const payload = rec(meta?.payload);
		const cwd = str(payload?.cwd);
		if (meta?.type !== 'session_meta' || cwd === undefined) {
			return undefined;
		}
		const sessionId = str(payload?.session_id) ?? str(payload?.id);
		const sourceSpawn = rec(rec(rec(payload?.source)?.subagent)?.thread_spawn);
		const parentThreadId = str(payload?.parent_thread_id) ?? str(sourceSpawn?.parent_thread_id);
		const rawDepth = num(payload?.depth) ?? num(sourceSpawn?.depth);
		const depth = rawDepth !== undefined ? Math.min(5, Math.max(1, Math.trunc(rawDepth))) : undefined;
		const agentPath = str(payload?.agent_path) ?? str(sourceSpawn?.agent_path);
		const agentNickname = str(payload?.agent_nickname) ?? str(sourceSpawn?.agent_nickname);
		// SubAgentのthreadは `source.subagent.thread_spawn` / `thread_source` で名乗る。これが無い
		// 形式でも、親を指すthread IDを持つなら子とみなす。比較相手はこのrollout自身のID (`id`) で
		// あって `session_id` ではない: 現行Codexは子rolloutの `session_id` へ「親の」thread IDを
		// 書くため、session_idと比べると子が必ずrootへ化ける（このペインのセッションが子の会話に
		// 差し替わり、モバイルに「親セッションが切り替わりました」が出る）。
		const ownThreadId = str(payload?.id) ?? sessionId;
		const spawnedAsSubagent = sourceSpawn !== undefined || str(payload?.thread_source) === 'subagent';
		const subagent = spawnedAsSubagent || (parentThreadId !== undefined && parentThreadId !== ownThreadId);
		const forkedFromId = str(payload?.forked_from_id);
		const historyBaseRaw = rec(payload?.history_base);
		const historyBaseThreadId = str(historyBaseRaw?.thread_id);
		const historyBaseEnd = num(historyBaseRaw?.end_byte_offset);
		const historyBase = historyBaseThreadId !== undefined && PARADIS_CODEX_THREAD_ID_PATTERN.test(historyBaseThreadId)
			&& historyBaseEnd !== undefined && Number.isSafeInteger(historyBaseEnd) && historyBaseEnd >= 0
			? { threadId: historyBaseThreadId, endByteOffset: historyBaseEnd } : undefined;
		return {
			cwd, ...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
			...(subagent ? { subagent: true as const, ...(parentThreadId !== undefined ? { parentThreadId } : {}) } : {}),
			...(depth !== undefined ? { depth } : {}), ...(agentPath !== undefined ? { agentPath } : {}),
			...(agentNickname !== undefined ? { agentNickname } : {}),
			...(forkedFromId !== undefined && forkedFromId.length > 0 && forkedFromId !== ownThreadId ? { forkedFromId } : {}),
			...(historyBase !== undefined ? { historyBase } : {}),
		};
	} catch {
		return undefined;
	}
}



/**
 * 常駐スキャンの間隔。1周で、未確定のターミナルごとに Claude の projects ディレクトリを
 * readdir + stat する。WSL 越しだとそれなりの費用になるので、詰めすぎない。
 */
const PARADIS_SESSION_SCAN_INTERVAL_MS = 30_000;

/** 1周が返ってこなくなったとみなして排他を解除するまでの時間。 */
const PARADIS_SESSION_SCAN_STUCK_MS = 5 * 60_000;

/** Codex の sessions/ 総なめを、同じホームに対して再び許すまでの間隔。 */
const PARADIS_CODEX_DIRECTORY_WALK_INTERVAL_MS = 5 * 60_000;
const PARADIS_CODEX_DIRECTORY_WALK_LIMIT = 128;

interface IParadisDirectoryWalkBudget {
	mayRun(key: string): boolean;
	mark(key: string): void;
}

/**
 * 常駐スキャンが「そのターミナルで今動いている」とみなす transcript の更新の新しさ。
 *
 * 窓を広げるほど同じフォルダの過去のセッションまで候補に入り、候補がちょうど1件のときしか
 * 採らない仕組みの都合で「どれか決められない」に倒れて何も拾えなくなる。逆に狭すぎると、
 * 質問を出したまま待っているセッションを取りこぼす。
 */
const PARADIS_SESSION_SCAN_RECENT_MS = 5 * 60_000;

/** state DBのsourceはSubAgentだけJSONで親thread情報を持つ。root探索では混在させない。 */
export function paradisIsCodexRootThreadSource(source: string): boolean {
	try {
		return rec(rec(rec(JSON.parse(source))?.subagent)?.thread_spawn) === undefined;
	} catch { return true; }
}

export interface IParadisCodexThreadSource {
	readonly parentThreadId: string;
	readonly depth: number;
	readonly agentNickname?: string;
	readonly agentRole?: string;
}

export function paradisParseCodexThreadSource(source: string): IParadisCodexThreadSource | undefined {
	try {
		const spawn = rec(rec(rec(JSON.parse(source))?.subagent)?.thread_spawn);
		const parentThreadId = str(spawn?.parent_thread_id);
		const rawDepth = num(spawn?.depth);
		if (parentThreadId === undefined || rawDepth === undefined) { return undefined; }
		const agentNickname = str(spawn?.agent_nickname);
		const agentRole = str(spawn?.agent_role);
		return { parentThreadId, depth: Math.min(5, Math.max(1, Math.trunc(rawDepth))), ...(agentNickname !== undefined ? { agentNickname } : {}), ...(agentRole !== undefined ? { agentRole } : {}) };
	} catch { return undefined; }
}

/** 新規起動は生成時刻、resumeは更新時刻でCLI実行との相関を検証する。 */
export function paradisCliDiscoveryCandidateIsFresh(candidate: { readonly mtime: number; readonly createdAt?: number }, minMtime: number | undefined, mode: ParadisCliDiscoveryMode): boolean {
	if (minMtime === undefined) { return true; }
	return mode === 'resume' || mode === 'attach' ? candidate.mtime >= minMtime : candidate.createdAt !== undefined && candidate.createdAt >= minMtime;
}

export function paradisSelectUnambiguousSessionCandidate<T extends { readonly transcriptPath: string; readonly mtime: number }>(
	candidates: readonly T[],
	minMtime: number | undefined,
	excludedPaths: ReadonlySet<string>,
): T | undefined {
	const fresh = candidates
		.filter(candidate => !excludedPaths.has(candidate.transcriptPath))
		.filter(candidate => minMtime === undefined || candidate.mtime >= minMtime)
		.sort((a, b) => b.mtime - a.mtime);
	return fresh.length === 1 ? fresh[0] : undefined;
}


/** 上限どうしの整合（画像は transcript の1行に収まる範囲でしか扱えない）を検査するため公開する。 */
export const paradisAgentChatImageLimitsForTest = {
	get toolImageBase64Limit() { return TOOL_IMAGE_BASE64_LIMIT; },
	get maxTranscriptLineBytes() { return MAX_TRANSCRIPT_LINE_BYTES; },
	get maxImagesPerMessage() { return MAX_IMAGES_PER_MESSAGE; },
	get initialReadTailBytes() { return INITIAL_READ_TAIL_BYTES; },
} as const;


/** Claude hookの公式pathを優先し、規定配置をフォールバック候補として返す。 */
export function paradisClaudeSubagentTranscriptCandidates(transcriptPath: string, activityId: string, hookTranscriptPath?: string): readonly string[] {
	if (!/^[A-Za-z0-9._:-]{1,500}$/.test(activityId)) { return []; }
	const dir = resolve(transcriptPath, '..');
	const filename = transcriptPath.slice(transcriptPath.lastIndexOf(sep) + 1).replace(/\.jsonl$/i, '');
	const agentFile = `${activityId.startsWith('agent-') ? activityId : `agent-${activityId}`}.jsonl`;
	return [...new Set([...(hookTranscriptPath !== undefined ? [hookTranscriptPath] : []), join(dir, filename, 'subagents', agentFile), join(dir, 'subagents', agentFile)])];
}

/**
 * 名前付きで起動したエージェントの子 transcript は `agent-a<name>-<16桁>.jsonl` という ID を持つ
 * （実データで確認）。名前を書いた meta.json が無い（SSH の写しは .jsonl しか写さない）ときの予備。
 */
export function paradisClaudeNamedAgentFromFileId(fileId: string): string | undefined {
	return /^a(?<name>[A-Za-z0-9._:-]+)-[0-9a-f]{16}$/.exec(fileId)?.groups?.name;
}

/** Claudeの子transcript pathに埋め込まれた所有Agent ID。root transcriptならundefined。 */
export function paradisClaudeAgentIdFromTranscriptPath(transcriptPath: string): string | undefined {
	const normalized = transcriptPath.replace(/\\/g, '/');
	const match = /\/subagents\/agent-([^/]+)\.jsonl$/i.exec(normalized);
	return match?.[1];
}

/** 現行Claudeの `<session>/subagents/agent-*.jsonl` からroot transcriptを復元する。 */
export function paradisClaudeRootTranscriptPath(transcriptPath: string): string | undefined {
	const normalized = transcriptPath.replace(/\\/g, '/');
	const match = /^(.*)\/([^/]+)\/subagents\/agent-[^/]+\.jsonl$/i.exec(normalized);
	if (match?.[1] === undefined || match[2] === undefined) { return undefined; }
	return `${match[1]}/${match[2]}.jsonl`;
}

/**
 * hookの発信元rolloutが root thread か SubAgent か。'unknown' は session_meta を読めなかった
 * （生成直後で先頭行がまだ書かれていない等）ことを表し、root と断定してはいけない状態。
 */
export type ParadisCodexRolloutOrigin = 'root' | 'subagent' | 'unknown';

/**
 * hookのtranscript_pathを「ペインの親セッション」のtranscriptへ正規化する。
 *
 * ネストした子エージェント（Claudeのsidechain / Codexのsubagent thread）で発火したhookは
 * 子自身のtranscriptを指す。これをそのままペインのセッションとしてclaimすると、親の会話が
 * 子の会話へ置き換わり（モバイルの「親セッションが切り替わりました」）、tailerも張り替わる。
 *
 * Claudeは子pathから root transcript を復元できるが、Codexの子threadは親と同じ
 * `rollout-*.jsonl` 命名・同じcwdで別ファイルになるため、pathから親を復元する手段が無い。
 * よって親が未確定なら 'drop' を返し、子でペインのセッションをbootstrapさせない
 * （親はcwd探索/state DB探索が root thread だけを候補にして確定させる）。
 *
 * 素性を判定できなかったCodex rollout ('unknown') は、確定済みのペインでは現行セッションを
 * 保ち、rebindだけを見送る（子の生成直後に飛んできた最初のhookで乗っ取られないため）。
 * セッション未確定のペインでは従来どおり確定させる（新規セッションの検知を止めない）。
 */
export function paradisResolveHookSessionTranscript(input: {
	readonly hookTranscriptPath: string;
	readonly paneTranscriptPath: string | undefined;
	readonly claudeNestedAgentId: string | undefined;
	readonly codexOrigin: ParadisCodexRolloutOrigin | undefined;
}): { readonly kind: 'session'; readonly transcriptPath: string; readonly nested: 'claude' | 'codex' | undefined } | { readonly kind: 'drop' } {
	const { hookTranscriptPath, paneTranscriptPath, claudeNestedAgentId, codexOrigin } = input;
	if (claudeNestedAgentId !== undefined) {
		return {
			kind: 'session', nested: 'claude',
			transcriptPath: paneTranscriptPath ?? paradisClaudeRootTranscriptPath(hookTranscriptPath) ?? hookTranscriptPath,
		};
	}
	if (codexOrigin === 'subagent') {
		return paneTranscriptPath !== undefined
			? { kind: 'session', transcriptPath: paneTranscriptPath, nested: 'codex' }
			: { kind: 'drop' };
	}
	if (codexOrigin === 'unknown' && paneTranscriptPath !== undefined && paneTranscriptPath !== hookTranscriptPath) {
		return { kind: 'session', transcriptPath: paneTranscriptPath, nested: 'codex' };
	}
	return { kind: 'session', transcriptPath: hookTranscriptPath, nested: undefined };
}


// ---- hook未発火時のセッション探索フォールバック ------------------------------------------------

async function discoverCodexSessionsFromStateDb(cwd: string, minMtime: number | undefined, homes: IParadisAgentHomes = paradisResolveAgentHomes(cwd)): Promise<{ agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number }[] | undefined> {
	// 全ホームの候補を合わせる。会話ログをホーム間でハードリンクしているので、同じ thread が
	// 複数のホームに載りうる。thread ID で1つにまとめ、更新が新しい方を残す。
	// 主のホームの state DB が読めないとき（古い Codex）は従来どおり undefined を返し、呼び出し側の
	// sessions/ の走査に任せる。
	const [primary, ...others] = paradisEachCodexHome(homes);
	const merged = await discoverCodexSessionsFromStateDbInHome(cwd, minMtime, primary);
	if (merged === undefined) {
		return undefined;
	}
	for (const home of others) {
		const found = await discoverCodexSessionsFromStateDbInHome(cwd, minMtime, home);
		for (const candidate of found ?? []) {
			const index = candidate.sessionId === undefined ? -1 : merged.findIndex(existing => existing.sessionId === candidate.sessionId);
			if (index < 0) {
				merged.push(candidate);
			} else if (candidate.mtime > merged[index].mtime) {
				merged[index] = candidate;
			}
		}
	}
	return merged.sort((a, b) => b.mtime - a.mtime);
}

async function discoverCodexSessionsFromStateDbInHome(cwd: string, minMtime: number | undefined, homes: IParadisAgentHomes): Promise<{ agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number }[] | undefined> {
	let database: DatabaseSync | undefined;
	try {
		// realpath は同じ名前空間の中でしか意味を持たない。WSL の作業ディレクトリを Windows 側で
		// 解決しても UNC のまま返ってくるだけなので、突合にはディストロ内の表記だけを使う。
		const realCwd = homes.wsl !== undefined ? homes.matchCwd : await fs.realpath(cwd).catch(() => cwd);
		const names = await fs.readdir(homes.codex);
		const stateDb = names.filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
		if (stateDb === undefined) {
			return undefined;
		}
		const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		database = new DatabaseSyncCtor(join(homes.codex, stateDb), { readOnly: true });
		const rows = database.prepare(`
			SELECT id, rollout_path, source, COALESCE(updated_at_ms, updated_at * 1000) AS mtime,
				COALESCE(created_at_ms, created_at * 1000) AS created_at
			FROM threads
			WHERE (cwd = ? OR cwd = ?) AND archived = 0
				AND (? IS NULL OR COALESCE(updated_at_ms, updated_at * 1000) >= ?)
			ORDER BY mtime DESC
		`).all(homes.matchCwd, realCwd, minMtime ?? null, minMtime ?? null) as unknown[];
		const candidates: { agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number }[] = [];
		for (const value of rows) {
			const row = rec(value);
			const recordedPath = str(row?.rollout_path);
			// state DB に書かれているのは Codex から見たパス。WSL なら Linux 側の表記なので、
			// この Windows プロセスから開ける UNC へ戻さないと後続の検証も読み取りも通らない。
			const transcriptPath = recordedPath !== undefined ? paradisLocalAgentPath(homes, recordedPath) : undefined;
			const sessionId = str(row?.id);
			const mtime = num(row?.mtime);
			const createdAt = num(row?.created_at);
			const source = str(row?.source);
			if (transcriptPath === undefined || !isAbsolute(transcriptPath) || !transcriptPath.endsWith('.jsonl') || mtime === undefined || source === undefined || !paradisIsCodexRootThreadSource(source)) {
				continue;
			}
			candidates.push({
				agent: 'codex', transcriptPath, mtime,
				...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
				...(createdAt !== undefined ? { createdAt } : {}),
			});
		}
		return candidates;
	} catch {
		return undefined; // 古いCodex/SQLite非対応環境ではファイル走査へフォールバック
	} finally {
		database?.close();
	}
}

/** 現行Codex state DBからthread IDに一致するrolloutを取得する。 */
async function discoverCodexTranscriptByThreadId(threadId: string, homes: IParadisAgentHomes): Promise<string | undefined> {
	return firstInCodexHomes(homes, home => discoverCodexTranscriptByThreadIdInHome(threadId, home));
}

async function discoverCodexTranscriptByThreadIdInHome(threadId: string, homes: IParadisAgentHomes): Promise<string | undefined> {
	if (!PARADIS_CODEX_THREAD_ID_PATTERN.test(threadId)) { return undefined; }
	let database: DatabaseSync | undefined;
	try {
		const names = await fs.readdir(homes.codex);
		const stateDb = names.filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
		if (stateDb === undefined) { return undefined; }
		const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		database = new DatabaseSyncCtor(join(homes.codex, stateDb), { readOnly: true });
		const row = rec(database.prepare('SELECT rollout_path FROM threads WHERE id = ? AND archived = 0 LIMIT 1').get(threadId));
		const transcriptPath = paradisLocalAgentPathOrUndefined(homes, str(row?.rollout_path));
		return transcriptPath !== undefined && isAbsolute(transcriptPath) && transcriptPath.endsWith('.jsonl') ? transcriptPath : undefined;
	} catch {
		return undefined;
	} finally {
		database?.close();
	}
}

/** CLIのresume/fork対象として、root threadだけをIDで厳密に取得する。 */
async function discoverCodexRootTranscriptByThreadId(threadId: string, homes: IParadisAgentHomes): Promise<string | undefined> {
	return firstInCodexHomes(homes, home => discoverCodexRootTranscriptByThreadIdInHome(threadId, home));
}

async function discoverCodexRootTranscriptByThreadIdInHome(threadId: string, homes: IParadisAgentHomes): Promise<string | undefined> {
	if (!PARADIS_CODEX_THREAD_ID_PATTERN.test(threadId)) { return undefined; }
	let database: DatabaseSync | undefined;
	try {
		const names = await fs.readdir(homes.codex);
		const stateDb = names.filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
		if (stateDb === undefined) { return undefined; }
		const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		database = new DatabaseSyncCtor(join(homes.codex, stateDb), { readOnly: true });
		const row = rec(database.prepare('SELECT rollout_path, source FROM threads WHERE id = ? AND archived = 0 LIMIT 1').get(threadId));
		const transcriptPath = paradisLocalAgentPathOrUndefined(homes, str(row?.rollout_path));
		const source = str(row?.source);
		// state DB に書かれているのは Codex から見たパス。WSL なら Linux 側の表記なので戻す。
		return transcriptPath !== undefined && isAbsolute(transcriptPath) && transcriptPath.endsWith('.jsonl')
			&& source !== undefined && paradisIsCodexRootThreadSource(source) ? paradisLocalAgentPath(homes, transcriptPath) : undefined;
	} catch {
		return undefined;
	} finally {
		database?.close();
	}
}

async function discoverCodexThreadSourceById(threadId: string, homes: IParadisAgentHomes): Promise<IParadisCodexThreadSource | undefined> {
	return firstInCodexHomes(homes, home => discoverCodexThreadSourceByIdInHome(threadId, home));
}

async function discoverCodexThreadSourceByIdInHome(threadId: string, homes: IParadisAgentHomes): Promise<IParadisCodexThreadSource | undefined> {
	if (!PARADIS_CODEX_THREAD_ID_PATTERN.test(threadId)) { return undefined; }
	let database: DatabaseSync | undefined;
	try {
		const names = await fs.readdir(homes.codex);
		const stateDb = names.filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
		if (stateDb === undefined) { return undefined; }
		const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		database = new DatabaseSyncCtor(join(homes.codex, stateDb), { readOnly: true });
		const row = rec(database.prepare('SELECT source FROM threads WHERE id = ? AND archived = 0 LIMIT 1').get(threadId));
		const source = str(row?.source);
		return source !== undefined ? paradisParseCodexThreadSource(source) : undefined;
	} catch { return undefined; } finally { database?.close(); }
}

/**
 * Codex rollout の先頭行（session_meta）を読む。cwd探索とhookの親子判定の両方が使う。
 * session_meta は書き出し後に変わらないため、先頭16KBだけ読めば足りる。
 */
/**
 * rollout の先頭行（session_meta）の上限。codex-cli 0.155.1 の先頭行は base_instructions を含んで 22,116 バイト
 * あり（フェーズ6の実機確認）、以前の 16KB では読み切れず、素性（root / SubAgent）が分からないまま同じタブの
 * 新しい Codex の会話へ乗り換えられなかった。大きめに取り、超えたら諦める（読み切れない行は解析しない）。
 */
const CODEX_SESSION_META_MAX_BYTES = 1024 * 1024;
const FIRST_LINE_CHUNK_BYTES = 64 * 1024;

/** ファイルの先頭行を改行まで読む。上限までに改行が無ければ undefined（改行が無いまま終わったらその全体）。 */
async function paradisReadFirstLine(handle: fs.FileHandle, maxBytes: number): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	let total = 0;
	while (total < maxBytes) {
		const chunk = Buffer.alloc(Math.min(FIRST_LINE_CHUNK_BYTES, maxBytes - total));
		const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
		if (bytesRead === 0) {
			return total === 0 ? undefined : Buffer.concat(chunks).toString('utf8');
		}
		const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
		if (newline !== -1) {
			chunks.push(chunk.subarray(0, newline));
			return Buffer.concat(chunks).toString('utf8');
		}
		chunks.push(chunk.subarray(0, bytesRead));
		total += bytesRead;
	}
	return undefined;
}

/** 回帰テスト用。rollout の先頭行を本番と同じ読み方で解析する。 */
export function paradisReadCodexRolloutSessionMetaForTest(rolloutPath: string): Promise<IParadisCodexSessionMeta | undefined> {
	return readCodexRolloutSessionMeta(rolloutPath);
}

async function readCodexRolloutSessionMeta(rolloutPath: string): Promise<IParadisCodexSessionMeta | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(rolloutPath, 'r');
	} catch {
		return undefined;
	}
	try {
		const firstLine = await paradisReadFirstLine(handle, CODEX_SESSION_META_MAX_BYTES);
		return firstLine === undefined ? undefined : paradisParseCodexSessionMeta(firstLine);
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => { /* ignore */ });
	}
}

/** fork の fork（TUI で `/fork` を重ねたもの）を、元の会話へさかのぼる段数の上限。 */
const CODEX_FORK_HISTORY_MAX_DEPTH = 8;

/**
 * Codex の fork 先の rollout の先頭行（session_meta）の `history_base` から、fork 先の過去の会話を読む
 * （codex-cli 0.160.0 の fork 先は過去の会話を写さず、元の rollout の先頭から `end_byte_offset` バイトまでを参照する）。
 * 元がさらに fork 先なら、その `history_base` もさかのぼる。返すのは古い順に並べた完全な行の文字列で、
 * fork 先の rollout の行の前にそのまま続けて読めばよい（元の rollout の範囲と fork 先の行は重ならない）。
 *
 * 元の rollout が見つからない・`end_byte_offset` がファイルの長さを超える・行の境目でない・中の thread ID が
 * 違うときは、その段より古い会話は出さない（1 段目でそうなら undefined。fork 先だけを出す）。
 * 読むのは新しい方から合計 budgetBytes まで（初回読み込みの末尾窓と同じ考え方。途中の行は捨てる）。
 * truncated は、1 段以上読めたうえで、それより古い会話を出していない（予算・段数の上限・さらに古い段が
 * 読めない）こと。
 */
export async function paradisReadCodexForkHistory(firstLine: string, resolveThreadTranscript: (threadId: string) => Promise<string | undefined>, budgetBytes: number): Promise<{ readonly text: string; readonly truncated: boolean } | undefined> {
	const segments: Buffer[] = [];
	const visited = new Set<string>();
	let meta = paradisParseCodexSessionMeta(firstLine);
	let remaining = budgetBytes;
	let truncated = false;
	for (let depth = 0; ; depth++) {
		const base = meta?.historyBase;
		if (base === undefined || base.endByteOffset === 0) {
			break;
		}
		if (depth >= CODEX_FORK_HISTORY_MAX_DEPTH || remaining <= 0 || visited.has(base.threadId)) {
			truncated = segments.length > 0;
			break;
		}
		visited.add(base.threadId);
		const parentPath = await resolveThreadTranscript(base.threadId).catch(() => undefined);
		const segment = parentPath !== undefined ? await paradisReadCodexHistoryBaseSegment(parentPath, base, remaining) : undefined;
		if (segment === undefined) {
			truncated = segments.length > 0;
			break;
		}
		segments.unshift(segment.body);
		remaining -= segment.body.length;
		if (segment.truncated) {
			truncated = true; // 予算を使い切った。これより古い段は読まない
			break;
		}
		meta = segment.meta;
	}
	return segments.length > 0 ? { text: Buffer.concat(segments).toString('utf8'), truncated } : undefined;
}

/** 元の rollout の先頭から `history_base.end_byte_offset` までの、完全な行だけ（予算を超えたら新しい方から）。 */
async function paradisReadCodexHistoryBaseSegment(rolloutPath: string, base: IParadisCodexHistoryBase, budgetBytes: number): Promise<{ readonly body: Buffer; readonly truncated: boolean; readonly meta: IParadisCodexSessionMeta | undefined } | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(rolloutPath, 'r');
	} catch {
		return undefined;
	}
	try {
		if (!await isAllowedOpenTranscriptPath(handle, rolloutPath)) {
			return undefined;
		}
		const stat = await handle.stat();
		if (base.endByteOffset > stat.size) {
			return undefined;
		}
		const firstLine = await paradisReadFirstLine(handle, CODEX_SESSION_META_MAX_BYTES);
		const meta = firstLine !== undefined ? paradisParseCodexSessionMeta(firstLine) : undefined;
		// 中の thread ID（rollout 自身の id。session_id はサブエージェントだと親の値になる）が一致するか
		const ownId = firstLine !== undefined ? str(rec(rec(safeJsonParseRecord(firstLine))?.payload)?.id) : undefined;
		if (ownId !== base.threadId) {
			return undefined;
		}
		const start = Math.max(0, base.endByteOffset - budgetBytes);
		const buffer = Buffer.alloc(base.endByteOffset - start);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		let body = buffer.subarray(0, bytesRead);
		// 行の境目で終わっていないなら、範囲の読み違い（形式が変わった等）。混ぜて出さない
		if (bytesRead !== buffer.length || body[body.length - 1] !== 0x0a) {
			return undefined;
		}
		if (start > 0) {
			const firstNewline = body.indexOf(0x0a);
			body = body.subarray(firstNewline + 1);
		}
		return { body, truncated: start > 0, meta };
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => { /* ignore */ });
	}
}

function safeJsonParseRecord(text: string): Record<string, unknown> | undefined {
	try {
		return rec(JSON.parse(text));
	} catch {
		return undefined;
	}
}

/**
 * 作業ディレクトリの Claude Code の記録の置き場（`~/.claude/projects/<cwdスラッグ>`）。
 *
 * Claude Code はcwdをrealpath解決してからスラッグ化するため、symlink経由のターミナルでも
 * 一致するよう解決後のパスを使う（解決失敗時は文字面のまま）。
 * スラッグは Claude Code が cwd から機械的に作る。したがって、こちらも
 * **その CLI から見た作業ディレクトリ**から作らないと一致しない。WSL の中で動く
 * claude が作るのは `-home-u-projects-repo` で、UNC から作った
 * `--wsl-localhost-<distro>-home-u-projects-repo` とは構造的に別物になる。
 * なおディストロの中の symlink は解決しない（Windows 側の realpath は UNC を
 * そのまま返すため）。リポジトリへの道中に symlink がある構成では当たらない。
 */
async function paradisClaudeProjectDirForCwd(cwd: string, homes: IParadisAgentHomes): Promise<string> {
	let resolvedCwd = homes.matchCwd;
	if (homes.wsl === undefined) {
		try {
			resolvedCwd = await fs.realpath(cwd);
		} catch { /* 消えたディレクトリ等は文字面で試す */ }
	}
	return join(homes.claude, 'projects', resolvedCwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Claude の transcript のファイル名から会話 id（小文字）を返す。サブエージェントの記録は対象外。 */
function paradisClaudeSessionIdOfTranscript(transcriptPath: string): string | undefined {
	const name = transcriptPath.split(/[\\/]/).pop() ?? '';
	return name.endsWith('.jsonl') && !name.startsWith('agent-') ? name.slice(0, -'.jsonl'.length).toLowerCase() : undefined;
}

/**
 * ターミナルのcwdから実行中らしいエージェントセッションのtranscriptを探す。
 * hookは「アプリ起動後に発火したイベント」しか知れないため、Para Code起動前から
 * 動いているセッションや発言がまだ無いセッションはこれで拾う（後からhookが発火したら
 * そちらが正となり上書きされる）。
 * - Claude: ~/.claude/projects/<cwdスラッグ>/ の最新 .jsonl
 * - Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl の直近ファイルのうち
 *           先頭行 session_meta の cwd が一致する最新のもの
 */
async function discoverSessionByCwd(cwd: string, agent: ParadisAgentKind, minMtime?: number, excludedPaths: ReadonlySet<string> = new Set(), mode?: ParadisCliDiscoveryMode, allowCodexDirectoryWalk: boolean = true, onCodexDirectoryWalk?: () => void, codexForkPolicy?: IParadisCodexForkPolicy): Promise<{ agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number } | undefined> {
	const candidates: { agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number }[] = [];
	// エージェントCLIが実際に読み書きしているホームと、その CLI から見た作業ディレクトリ。
	// ペインが WSL の中を指していれば、ここでディストロ側へ切り替わる。
	const homes = paradisResolveAgentHomes(cwd);

	// Claude: cwd → プロジェクトディレクトリのスラッグ（英数字以外を '-' に置換）。
	if (agent === 'claude') {
		try {
			const dir = await paradisClaudeProjectDirForCwd(cwd, homes);
			const names = await fs.readdir(dir);
			for (const name of names) {
				if (!name.endsWith('.jsonl')) {
					continue;
				}
				try {
					const stat = await fs.stat(join(dir, name));
					candidates.push({ agent: 'claude', transcriptPath: join(dir, name), mtime: stat.mtimeMs });
				} catch { /* 消えた直後などは無視 */ }
			}
		} catch { /* プロジェクトディレクトリ無し = Claudeセッション無し */ }
	}

	// Codex: sessions配下を走査し、コマンド開始後に更新されたrolloutを新しい順に見て
	// session_meta.cwdを突合する。作成日が古いresumeセッションもmtime更新で候補になる。
	if (agent === 'codex') {
		const indexed = await discoverCodexSessionsFromStateDb(cwd, minMtime, homes);
		if (indexed !== undefined) {
			candidates.push(...indexed);
		}
		// state DB が読めないときだけ sessions/ を総なめする。定期スキャンからは使わない
		// （数分おきに数百ファイルを stat することになり、WSL 越しでは特に重い）。
		if (indexed === undefined && allowCodexDirectoryWalk) {
			onCodexDirectoryWalk?.();
			try {
				const sessionsRoot = join(homes.codex, 'sessions');
				const rollouts: { path: string; mtime: number }[] = [];
				const collect = async (dir: string, depth: number): Promise<void> => {
					let entries: Dirent[];
					try {
						entries = await fs.readdir(dir, { withFileTypes: true });
					} catch {
						return;
					}
					for (const entry of entries) {
						const path = join(dir, entry.name);
						if (entry.isDirectory() && depth < 3) {
							await collect(path, depth + 1);
						} else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
							try {
								const stat = await fs.stat(path);
								if (minMtime === undefined || stat.mtimeMs >= minMtime) {
									rollouts.push({ path, mtime: stat.mtimeMs });
								}
							} catch { /* 消えた直後などは無視 */ }
						}
					}
				};
				await collect(sessionsRoot, 0);
				rollouts.sort((a, b) => b.mtime - a.mtime);
				for (const rollout of rollouts) {
					try {
						const meta = await readCodexRolloutSessionMeta(rollout.path);
						if (meta?.cwd === homes.matchCwd && meta.subagent !== true) {
							const sessionId = meta.sessionId;
							candidates.push({
								agent: 'codex', transcriptPath: rollout.path, mtime: rollout.mtime,
								...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
							});
						}
					} catch { /* 壊れた行・読み取り失敗は無視 */ }
				}
			} catch { /* sessions ディレクトリ無し = Codexセッション無し */ }
		}
	}

	// minMtime 指定時は「それ以降に更新されたtranscript」だけを受け付ける (コマンド実行検知
	// トリガーの鮮度ガード。古いセッションを誤って現行扱いにしない)。
	// cwdだけでは同一cwdの複数セッションをペインへ一意に帰属できない。誤threadの会話表示や
	// モデル変更を避けるため、候補が複数ある場合は推測せず未確定のままにする。
	// Codexの新規起動・forkは更新時刻だけでなくDBの生成時刻で先に候補を絞る。
	// 同じcwdで別threadが同時に更新されても、今回生成された1件を曖昧扱いで落とさない。
	const eligible = agent === 'codex' && minMtime !== undefined && mode !== undefined
		? candidates.filter(candidate => paradisCliDiscoveryCandidateIsFresh(candidate, minMtime, mode))
		: candidates;
	// daemon が動かす会話（`/fork` の分岐先・`claude --bg`）は、同じ作業フォルダで元の会話と並んで
	// 更新され続けるが、どのペインの会話でもない。候補に残すと、元のペインがこれと元の会話を行き来する。
	// Codex の fork 先は fork した瞬間に作られ、持ち主のペインが最初の発言まで分からない。fork を打ったペイン以外が
	// 採らないよう、fork 先は forked_from_id がそのペインの会話（または `codex fork X` の X）のときだけ残す。
	if (agent === 'codex' && codexForkPolicy !== undefined) {
		const { kept, unreadable } = await paradisWithCodexForkPolicy(eligible, minMtime, excludedPaths, codexForkPolicy);
		const selected = paradisSelectUnambiguousSessionCandidate(kept, minMtime, excludedPaths);
		// 素性を読めなかった候補は、一意かどうかの判定には数えるが、選ばれても結ばない（次の照合で読み直す）
		return selected !== undefined && unreadable.has(selected.transcriptPath) ? undefined : selected;
	}
	const inPane = agent === 'claude' ? await paradisWithoutClaudeBackgroundTranscripts(eligible, minMtime, excludedPaths) : eligible;
	return paradisSelectUnambiguousSessionCandidate(inPane, minMtime, excludedPaths);
}

/** ペインで打った `codex fork` の元。parent は `codex fork X`、any は id 無し・`--last`、unknown は id が形に合わない。 */
type ParadisCodexForkRequest = { readonly kind: 'parent'; readonly parentId: string } | { readonly kind: 'any' } | { readonly kind: 'unknown' };

/** 照合で、Codex の fork 先（session_meta に forked_from_id がある thread）をこのペインに結んでよいか。 */
export interface IParadisCodexForkPolicy {
	/** fork 先を結んでよい元の thread ID（このペインの今の会話と、このペインで打った `codex fork X` の X）。 */
	readonly allowedParents: ReadonlySet<string>;
	/**
	 * `codex fork`（id 無し・`--last`）を打った後。打った後に作られた fork 先を、元が {@link foreignParents} で
	 * なければ結んでよい。
	 */
	readonly anyParent: boolean;
	/**
	 * ほかの生存ペインの今の会話。元がこれらの fork 先は、そのペインの TUI の `/fork` かもしれないので、
	 * {@link anyParent} では結ばない（hook に任せる）。
	 */
	readonly foreignParents: ReadonlySet<string>;
	/** ほかのペインで打った `codex fork X` の X。その fork 先はそのペインのものなので、ここでは結ばない。 */
	readonly reservedParents: ReadonlySet<string>;
	/** fork 先だけを採る（`codex fork` を打った直後の探索。同じフォルダで始まった別の会話を採らない）。 */
	readonly forkOnly: boolean;
}

/** fork 元が forkedFromId（fork 先でなければ undefined）の候補を、このペインに結んでよいか。 */
export function paradisCodexForkCandidateAllowed(forkedFromId: string | undefined, policy: IParadisCodexForkPolicy): boolean {
	if (forkedFromId === undefined) {
		return !policy.forkOnly;
	}
	if (policy.reservedParents.has(forkedFromId)) {
		return false;
	}
	if (policy.allowedParents.has(forkedFromId)) {
		return true;
	}
	return policy.anyParent && !policy.foreignParents.has(forkedFromId);
}

/** rollout のパス → forked_from_id（fork 先でなければ null）。session_meta は書いた後に変わらないので使い回す。 */
const codexForkedFromCache = new Map<string, string | null>();
const CODEX_FORKED_FROM_CACHE_LIMIT = 1024;

/**
 * rollout の forked_from_id。fork 先でなければ null、読めない（先頭行が書きかけ・壊れている等）なら 'unreadable'。
 * ファイルが無い thread は fork 先ではない（Codex は最初の発言まで rollout を作らないが、fork 先は fork した瞬間に作る）。
 */
async function paradisCodexForkedFromId(rolloutPath: string): Promise<string | null | 'unreadable'> {
	const cached = codexForkedFromCache.get(rolloutPath);
	if (cached !== undefined) {
		return cached;
	}
	const meta = await readCodexRolloutSessionMeta(rolloutPath);
	if (meta === undefined) {
		const missing = await fs.stat(rolloutPath).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
		// 無いことは覚えない（最初の発言で作られる）
		return missing ? null : 'unreadable';
	}
	const forkedFromId = meta.forkedFromId ?? null;
	codexForkedFromCache.set(rolloutPath, forkedFromId);
	while (codexForkedFromCache.size > CODEX_FORKED_FROM_CACHE_LIMIT) {
		const oldest = codexForkedFromCache.keys().next();
		if (oldest.done === true) {
			break;
		}
		codexForkedFromCache.delete(oldest.value);
	}
	return forkedFromId;
}

/**
 * 照合の候補から、このペインのものでない Codex の fork 先を外す（どのみち選ばれない候補は読まない）。
 * session_meta を読めない候補は残して unreadable に入れる。一意かどうかの判定には数え（ほかの候補を
 * 一意と取り違えないため）、選ばれたときだけ見送る（fork 先かもしれないので、次の照合で読み直す）。
 */
async function paradisWithCodexForkPolicy<T extends { readonly transcriptPath: string; readonly mtime: number }>(candidates: readonly T[], minMtime: number | undefined, excludedPaths: ReadonlySet<string>, policy: IParadisCodexForkPolicy): Promise<{ readonly kept: T[]; readonly unreadable: ReadonlySet<string> }> {
	const kept: T[] = [];
	const unreadable = new Set<string>();
	for (const candidate of candidates) {
		if (excludedPaths.has(candidate.transcriptPath) || (minMtime !== undefined && candidate.mtime < minMtime)) {
			kept.push(candidate); // 後段で落ちる
			continue;
		}
		const forkedFromId = await paradisCodexForkedFromId(candidate.transcriptPath);
		if (forkedFromId === 'unreadable') {
			unreadable.add(candidate.transcriptPath);
			kept.push(candidate);
		} else if (paradisCodexForkCandidateAllowed(forkedFromId ?? undefined, policy)) {
			kept.push(candidate);
		}
	}
	return { kept, unreadable };
}

/**
 * 照合の候補から、daemon が動かす Claude の会話を外す（どのみち選ばれない候補は読まない）。
 * 読めない・決まらない候補も外す（fail-closed。照合は推測なので、分岐先かもしれないものは採らない）。
 */
async function paradisWithoutClaudeBackgroundTranscripts<T extends { readonly transcriptPath: string; readonly mtime: number }>(candidates: readonly T[], minMtime: number | undefined, excludedPaths: ReadonlySet<string>): Promise<T[]> {
	const kept: T[] = [];
	for (const candidate of candidates) {
		if (excludedPaths.has(candidate.transcriptPath) || (minMtime !== undefined && candidate.mtime < minMtime)
			|| await paradisClaudeTranscriptSessionKind(candidate.transcriptPath) === 'pane') {
			kept.push(candidate);
		}
	}
	return kept;
}

// ---- tailer ---------------------------------------------------------------------------------

/** 回答待ちの承認1件。 */
interface IParadisApprovalEntry {
	readonly interaction: Extract<IParadisAgentInteraction, { readonly kind: 'approval' }>;
	/** 重複の印（同じ要求の再発火を捨てるため）。 */
	readonly key: string;
	/** デスクトップのチャット表示のためだけに入れた（ペインの状態に数えない）。 */
	readonly desktopOnly: boolean;
	/** 合成 id の承認を、どの待ち合わせで解くか（ParadisMobileAgentChat.syntheticApprovalWaits）。 */
	readonly waitKey?: string;
	/** デスクトップかモバイルから答え終えた（表に出さない。ツールの完了で列から外れる）。 */
	readonly answered?: boolean;
}

interface ITailerDelegate {
	/**
	 * 追記分のメッセージが確定した (差分push用)。
	 * quiet は、デスクトップのチャット表示のためだけに入れた質問で、モバイルへの質問通知を出さない印。
	 */
	onDelta(messages: IParadisAgentChatMessage[], options?: { readonly quiet?: boolean }): void;
	/** epoch が切り替わった (truncate検知・読み直し)。購読者へ全量スナップショットを送り直す。 */
	onEpochReset(): void;
	/** アクティビティ（バックグラウンドタスク・質問回答待ち）が変化した。 */
	onActivity(): void;
	/** セッションメタ情報（model / effort）が変化した。 */
	onInfo(): void;
	/** Claude Code の Monitor の一覧が変化した（起動・出力・終了・推定による時間切れ）。 */
	onMonitors?(): void;
	/** Claude transcriptのephemeral progress行を受けた。履歴には追加しない。 */
	onProgress(progress: ITranscriptProgress): void;
	/** ライブ追記で Advisor の呼び出し・結果（`advisor` の付いたメッセージ）を読んだ。 */
	onAdvisors?(messages: readonly IParadisAgentChatMessage[]): void;
	/** ライブ追記でターン終了（task_complete / error / turn_aborted）を検出した。 */
	onTurnEnded(reason: 'completed' | 'failed' | 'interrupted', errorCode?: string): void;
	/** rolloutに永続化されたCodex活動を順序どおりtrackerへ収束させる。 */
	onCodexActivityTimeline(events: readonly ICodexTranscriptActivityEvent[]): void;
	/**
	 * transcript にこの起動後の追記を観測した。
	 * 「そのペインでエージェントが今も動いている」証拠として使う（内容は問わない）。
	 */
	onAppended(): void;
	/**
	 * 追記行から検出した GitHub Issue URL の集合が変化した（累積・重複無し）。
	 * ワークスペース一覧のIssueマーク用。エージェントが動いていないペインでは呼ばれないため、
	 * 呼び出し側 (paradisAgentHookBus) でペインの生死に紐づけて自然に消す。
	 */
	onIssueUrlsUpdated?(issueUrls: ReadonlySet<string>): void;
	/**
	 * 追記で、これらのツールの結果が transcript に書かれた（PostToolUse が来ない拒否の検出に使う）。
	 * rejected は、利用者が許可を拒否した結果（Claude Code の定型文）が含まれていたか。
	 */
	onToolResults?(toolUseIds: readonly string[], rejected: boolean): void;
}

/**
 * ツール結果に含まれていた画像の実体を、**全ペイン合計**で上限を張って保持する LRU。
 *
 * 保持はペイン（tailer）ごとに持つのが自然だが、それだと上限がペイン数だけ掛け算になる。
 * 画像は1枚で数MBあり、base64 は JS 文字列なので実メモリは文字数の約2倍になるため、
 * エージェントを開いたペインが増えるほど常駐が積み上がってしまう。表示に必要なのは
 * 「いま開いているステップの画像」だけなので、合計で1つの枠を分け合う。
 *
 * 所有者（tailer）は取り出しキーの名前空間としてのみ使い、ペインが消えるときと epoch が
 * 振り直されるときに {@link releaseOwner} でまとめて捨てる。
 */
class ParadisSharedImageCache {

	/** `owner\0rev:index` → 実体。Map の挿入順を LRU として使う。 */
	private readonly entries = new Map<string, IFlattenedImage>();
	private bytes = 0;

	private static key(owner: string, rev: number, index: number): string {
		return `${owner}\0${rev}:${index}`;
	}

	set(owner: string, rev: number, index: number, image: IFlattenedImage): void {
		const key = ParadisSharedImageCache.key(owner, rev, index);
		this.drop(key);
		this.entries.set(key, image);
		this.bytes += image.base64.length;
		// 1メッセージに複数枚あるとき、全部積んでから削ると一時的に上限を大きく超える。
		while (this.entries.size > IMAGE_CACHE_ENTRIES || this.bytes > IMAGE_CACHE_BYTES) {
			const oldest = this.entries.keys().next();
			if (oldest.done === true) {
				break;
			}
			this.drop(oldest.value);
		}
	}

	/** 取り出した画像は最近参照した扱いに直す（ページ送り中の画像が新着に押し出されないため）。 */
	get(owner: string, rev: number, index: number): IFlattenedImage | undefined {
		const key = ParadisSharedImageCache.key(owner, rev, index);
		const image = this.entries.get(key);
		if (image !== undefined) {
			this.entries.delete(key);
			this.entries.set(key, image);
		}
		return image;
	}

	/** そのペインぶんを丸ごと捨てる（ペインの破棄・epoch リセット）。 */
	releaseOwner(owner: string): void {
		const prefix = `${owner}\0`;
		for (const key of [...this.entries.keys()]) {
			if (key.startsWith(prefix)) {
				this.drop(key);
			}
		}
	}

	/** テストから合計の在庫を確かめるため。 */
	stats(): { readonly count: number; readonly bytes: number } {
		return { count: this.entries.size, bytes: this.bytes };
	}

	private drop(key: string): void {
		const existing = this.entries.get(key);
		if (existing !== undefined) {
			this.bytes -= existing.base64.length;
			this.entries.delete(key);
		}
	}
}

/** 画像キャッシュはプロセスで1つ（上限がペイン数に比例しないようにするため）。 */
const sharedImageCache = new ParadisSharedImageCache();

/** 上限の整合とペイン間の枠共有を検証するため公開する。 */
export const paradisSharedImageCacheForTest = sharedImageCache;

/**
 * 1つの transcript ファイルの追記を追いかけ、正規化メッセージのリングバッファを維持する。
 * fs.watch (即時性) + ポーリング (确実性) の二重化。ファイル未作成・一時的な読み取り失敗は
 * 次のポーリングで自然に回復する。読み取りは Promise チェーンで直列化する。
 */
class TranscriptTailer {
	epoch = newEpoch();
	rev = 0;
	readonly messages: IParadisAgentChatMessage[] = [];
	/**
	 * 切り詰めたツール出力の全文: rev → 全文。モバイルがステップを展開したときだけ
	 * 'tool-full' で取りに来る（常時送るとリレーの転送量が跳ねるため）。
	 * 件数・合計バイトの両方に上限を置き、古い rev から捨てる。
	 */
	private readonly fullTexts = new Map<number, string>();
	private fullTextBytes = 0;
	/**
	 * 画像キャッシュ内でこのペインぶんを指す名前空間。全文と違い、画像の実体は
	 * {@link sharedImageCache} が全ペイン合計の枠で持つ（1枚が全文キャッシュ全体に匹敵する
	 * サイズになるため、ペインごとに枠を持たせると常駐がペイン数に比例してしまう）。
	 */
	private readonly imageOwner = `tailer-${newEpoch()}`;
	/** これまでに追記行から検出した GitHub Issue URL（出現順、重複無し）。epochリセットで捨てる。 */
	private readonly issueUrls = new Set<string>();
	/** 実行中バックグラウンドタスク（サブエージェント等）: id → 起動時刻 (epoch ms)。 */
	readonly backgroundTasks = new Map<string, number>();
	/** 回答待ちの質問 (AskUserQuestion) の tool_use_id。 */
	readonly pendingQuestions = new Set<string>();
	/** mod（Claude Mods）が待っていて値で答えられる質問のカード（questionGroup ?? toolUseId）。`answerVia` の元。 */
	private modQuestionIds: ReadonlySet<string> = new Set<string>();
	/** Claude Code の Monitor の一覧（epoch ごと。モバイルのコンポーザーのピルに出す）。 */
	private readonly monitorWatch = new ParadisAgentMonitorWatch(() => this.delegate.onMonitors?.());
	/**
	 * PreToolUse hook でライブ注入した質問: 内容キー → 合成toolUseId。Claude Code は
	 * AskUserQuestion の tool_use を決着（回答/中断）まで transcript へ flush しないため、
	 * hook 供給の合成カードを先に出し、決着後に transcript へ現れる本物と突き合わせる。
	 */
	private readonly liveQuestions = new Map<string, string[]>();
	/**
	 * transcript に現れた本物の tool_use_id → 合成ID群（後続 tool_result の付け替え用）。
	 * 1回の AskUserQuestion に複数の質問が含まれると、合成カードは質問ごとに別IDだが
	 * 本物の tool_use_id / tool_result は1つなので、配列で全合成IDを決着させる。
	 */
	private readonly liveQuestionRealIds = new Map<string, string[]>();
	private liveQuestionSeq = 0;
	/** ライブ注入の質問グループ連番（1回の AskUserQuestion hook = 1グループ）。 */
	private liveQuestionGroupSeq = 0;
	/** セッションメタ情報（transcriptから学習した最新値）。 */
	model: string | undefined;
	effort: string | undefined;
	/** transcript の行が書かれた CLI のバージョン。計測にのみ使う（モバイルへは送らない）。 */
	cliVersion: string | undefined;
	/** Claude Code が「そのコマンドは無い」と書いたコマンド（最近 20 件。行の時刻）。モバイルの送信の断りに使う。 */
	readonly unknownSlashCommands: { readonly name: string; readonly at: number }[] = [];
	/**
	 * Claude のプロンプトキャッシュを最後に使ったリクエストの時刻と有効期限の長さ
	 * （デスクトップのスペース一覧・ターミナルの残り時間表示用。モバイルへは送らない）。
	 */
	promptCache: IParadisAgentPromptCache | undefined;
	/** 初回読み込みが完了したら resolve (attach応答はこれを待つ)。 */
	readonly ready: Promise<void>;

	private offset = 0;
	private remainder = '';
	/** 作業中に送った発言の控え。読み取りの塊をまたいで重複（Esc 後の書き直し）を見分けるため持ち続ける。 */
	private claudeQueuedPrompts = newClaudeQueuedPromptState();
	// transcript を offset 連続で読み進める間、UTF-8マルチバイト文字が読み境界で分断されても
	// 化けないよう stream モードでデコードする（境界の継続バイトはデコーダ内部で持ち越される）。
	// epoch reset（offset 0 へ巻き戻し）時は新しいインスタンスに差し替えて内部状態を捨てる。
	private decoder = new TextDecoder();
	private initialTruncated = false;
	private watcher: FSWatcher | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private chain: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(
		readonly transcriptPath: string,
		readonly agent: ParadisAgentKind,
		private readonly delegate: ITailerDelegate,
		private readonly logService: ILogService,
		/**
		 * このセッションが SSH の接続先で動いているか（読んでいるのは接続先 transcript の写し）。
		 * 手元の設定ファイルは向こうのエージェントとは無関係なので、既定値の補完をやめる。
		 */
		remote: boolean = false,
		/**
		 * Codex の thread ID から rollout のパスを引く（fork 先の過去の会話を、元の rollout から読むため）。
		 * 渡さなければ fork 先の rollout だけを出す（SSH の写しは元の rollout を写さない）。
		 */
		private readonly resolveCodexThreadTranscript?: (threadId: string) => Promise<string | undefined>,
	) {
		this.ready = this.enqueue(() => this.initialLoad());
		this.startWatching();
		this.pollTimer = setInterval(() => this.enqueue(() => this.readAppended()), POLL_INTERVAL_MS);
		if (agent === 'claude' && !remote) {
			// Claude の transcript は effort を直接記録しない。既定値を settings.json から
			// 補完する（セッション内の /effort 変更は transcript の実行記録が上書きする）。
			// 接続先のセッションでは補完しない: 手元の settings.json を読んで配ると、向こうで
			// /effort を打っていないセッションに **PC本体の設定値** が現在値として出てしまう。
			// 分からないものは分からないままにする。
			this.loadClaudeDefaultEffort().catch(() => { /* settings.json 無し・壊れは無視 */ });
		}
	}

	/** ~/.claude/settings.json の effortLevel を、transcript由来の値が無い場合の既定として適用する。 */
	private async loadClaudeDefaultEffort(): Promise<void> {
		const raw = await fs.readFile(join(paradisClaudeConfigDir(), 'settings.json'), 'utf8');
		const effortLevel = str(rec(JSON.parse(raw))?.effortLevel);
		if (!this.disposed && effortLevel !== undefined && effortLevel.length > 0 && this.effort === undefined) {
			this.effort = effortLevel;
			this.delegate.onInfo();
		}
	}

	get wasInitialTruncated(): boolean {
		return this.initialTruncated;
	}

	dispose(): void {
		this.disposed = true;
		for (const timer of this.modRowTimers) {
			clearTimeout(timer);
		}
		this.modRowTimers.clear();
		this.monitorWatch.dispose();
		this.watcher?.close();
		this.watcher = undefined;
		if (this.pollTimer !== undefined) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		// 画像の実体だけは共有の枠にあるので、ペインが消えても LRU の押し出しを待たずに返す。
		sharedImageCache.releaseOwner(this.imageOwner);
	}

	private enqueue(work: () => Promise<void>): Promise<void> {
		const run = this.chain.then(async () => {
			if (!this.disposed) {
				await work();
			}
		});
		this.chain = run.catch(err => this.logService.trace('[paradisAgentChat] tail read failed (will retry on next poll)', String(err)));
		return this.chain;
	}

	private startWatching(): void {
		// ファイル未作成だと watch は throw する。その場合はポーリングだけで追い、
		// 最初の読み取り成功時に張り直す。watchはヒント扱いで、失われても poll が拾う。
		try {
			this.watcher = watch(this.transcriptPath, { persistent: false }, () => {
				this.enqueue(() => this.readAppended());
			});
			this.watcher.on('error', () => {
				this.watcher?.close();
				this.watcher = undefined;
			});
		} catch {
			this.watcher = undefined;
		}
	}

	private async initialLoad(): Promise<void> {
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(this.transcriptPath, 'r');
		} catch {
			return; // 未作成。ポーリングで readAppended が offset 0 から読み始める
		}
		try {
			if (!await isAllowedOpenTranscriptPath(handle, this.transcriptPath)) { return; }
			const stat = await handle.stat();
			let start = 0;
			if (stat.size > INITIAL_READ_MAX_BYTES) {
				start = stat.size - INITIAL_READ_TAIL_BYTES;
				this.initialTruncated = true;
			}
			const length = stat.size - start;
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, start);
			let body = buffer.subarray(0, bytesRead);
			let lineBase = start;
			if (start > 0) {
				// 途中から読んだ場合、最初の不完全行を捨てる。行の頭のバイト位置を覚えるため、文字にする前のバイト列で探す
				// （古い発言をファイルから読むときの境目になる。W2-30）。
				const firstNewline = body.indexOf(0x0a);
				lineBase = firstNewline >= 0 ? start + firstNewline + 1 : start + bytesRead;
				body = body.subarray(firstNewline >= 0 ? firstNewline + 1 : bytesRead);
			}
			// fork 先の rollout は過去の会話を写さず、元の rollout の範囲を参照する。先頭から読めたときだけ、
			// その範囲を先に読んで続けて出す（読み込みの合計は末尾窓と同じ幅まで）
			const forkHistory = start === 0 && this.agent === 'codex' && this.resolveCodexThreadTranscript !== undefined
				? await this.readCodexForkHistory(body, INITIAL_READ_TAIL_BYTES - bytesRead) : undefined;
			if (this.disposed) {
				return;
			}
			const text = this.decoder.decode(body, { stream: true });
			this.lineBase = lineBase;
			this.offset = start + bytesRead;
			// ここまで来て初めて「現在の末尾」を掴めた。open に失敗した回はここを通らず
			// offset が 0 のままなので、次の読みは追記ではなく全文の読み直しになる。
			this.sawInitialEof = true;
			if (forkHistory !== undefined) {
				this.consumeForkHistory(forkHistory.text);
				// 元の会話の古い方を出していない。モバイルに「これより前がある」と伝える
				if (forkHistory.truncated) {
					this.initialTruncated = true;
				}
			}
			this.consumeText(text, false);
			if (!this.watcher) {
				this.startWatching();
			}
		} finally {
			await handle.close();
		}
	}

	/** {@link initialLoad} で現在の末尾を掴めたか。掴む前の読みは追記ではない。 */
	private sawInitialEof = false;

	/** 読み込んだ fork 先の rollout の先頭行から、元の rollout の過去の会話を読む（fork 先でなければ undefined）。 */
	private async readCodexForkHistory(body: Buffer, budgetBytes: number): Promise<{ readonly text: string; readonly truncated: boolean } | undefined> {
		const newline = body.indexOf(0x0a);
		const resolveThread = this.resolveCodexThreadTranscript;
		if (newline <= 0 || budgetBytes <= 0 || resolveThread === undefined) {
			return undefined;
		}
		try {
			return await paradisReadCodexForkHistory(body.subarray(0, newline).toString('utf8'), resolveThread, budgetBytes);
		} catch (err) {
			this.logService.trace('[paradisAgentChat] reading the history of a forked Codex thread failed', String(err));
			return undefined;
		}
	}

	/**
	 * fork 先の過去の会話（元の rollout の行）を、会話の頭に足す。表示するだけで、ペインの状態（タスク・質問・
	 * ターン・サブエージェント）には使わない（それは fork 先の行から作る）。行の位置も持たせない（古い発言の
	 * 読み取りは fork 先の rollout を読むので、別のファイルの位置を混ぜない）。
	 *
	 * 制限: 古い発言の読み取り（モバイルの 'history'）は fork 先の rollout しか読まないので、リングから押し出された
	 * 元の会話の行や、予算を超えて読まなかった元の会話の行は、後から取り寄せられない（`truncated` は立つが、
	 * 取り寄せても何も返らない）。
	 * 元の会話の行が操作できるカードに見えることは無い: Codex の行から質問（kind: 'question'）は作らず、
	 * 承認のカードは hook のライブの列から出る（行からは作らない）。ツールの呼び出しは、結果の行が範囲内に
	 * あれば完了として出る。
	 */
	private consumeForkHistory(text: string): void {
		const signals = newParseSignals(this.claudeQueuedPrompts);
		const entries: { readonly obj: Record<string, unknown> }[] = [];
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length === 0) {
				continue;
			}
			try {
				const obj = rec(JSON.parse(trimmed));
				if (obj !== undefined) {
					entries.push({ obj });
				}
			} catch {
				// 壊れた行はスキップ
			}
		}
		this.consumeEntries(entries, signals, false, undefined, false, true);
	}

	/** 持ち越している不完全な行（remainder）の頭のバイト位置。行の頭の位置を数える起点（W2-30）。 */
	private lineBase = 0;
	/**
	 * 記録ファイルから作った発言の rev → その発言の位置（行の頭のバイト位置と、その行を解釈して出た発言の中での順番）。
	 * リングにある発言のぶん。モバイルへは送らない。順番はパーサーの単位で数える（古い発言の読み取り
	 * `paradisReadTranscriptHistory` が同じ行を解釈し直して先頭から `keep` 件を採るのと揃えるため。L1）。
	 */
	private readonly positionByRev = new Map<number, IParadisHistoryCursor>();
	/**
	 * リングから押し出した発言の位置（新しい方から {@link EVICTED_POSITION_LIMIT} 件）。モバイルはリングより多く
	 * （新しい発言の差分で 500 件まで）持つので、モバイルのいちばん古い発言がもうリングに無くても、そこから前を
	 * 記録ファイルで読めるように残す（W2-30 のレビュー H3）。
	 */
	private readonly evictedPositions = new Map<number, IParadisHistoryCursor>();

	/** リングを上限まで縮める。押し出した発言の位置は、上限付きで残す。 */
	private trimRing(): void {
		if (this.messages.length <= MESSAGE_RING_LIMIT) {
			return;
		}
		const evicted = this.messages.splice(0, this.messages.length - MESSAGE_RING_LIMIT);
		for (const message of evicted) {
			const position = this.positionByRev.get(message.rev);
			if (position !== undefined) {
				this.positionByRev.delete(message.rev);
				this.evictedPositions.set(message.rev, position);
			}
		}
		while (this.evictedPositions.size > EVICTED_POSITION_LIMIT) {
			const oldest = this.evictedPositions.keys().next();
			if (oldest.done === true) {
				break;
			}
			this.evictedPositions.delete(oldest.value);
		}
	}

	/**
	 * rev `before` の発言より前の発言が、記録ファイルのどこから前にあるか（W2-30 の 2 段目の起点）。
	 * `before` 以上でいちばん古い「ファイルから作った発言」の位置を使う（手前に hook から差し込んだ発言があっても、
	 * それはファイルに無いので飛ばしてよい）。押し出した位置も残っていない（古すぎる）なら undefined。
	 * 何も見つからなければ、読み終えたところ（それより前の行からは、残っている発言が 1 つもできなかった）。
	 */
	historyCursorBefore(before: number): IParadisHistoryCursor | undefined {
		let best: { readonly rev: number; readonly position: IParadisHistoryCursor } | undefined;
		for (const positions of [this.evictedPositions, this.positionByRev]) {
			for (const [rev, position] of positions) {
				if (rev >= before && (best === undefined || rev < best.rev)) {
					best = { rev, position };
				}
			}
		}
		if (best !== undefined) {
			return best.position;
		}
		const oldestKnown = Math.min(...this.evictedPositions.keys(), ...this.positionByRev.keys());
		// 残している位置より古い発言を指されたら、どこから前かは分からない。
		return Number.isFinite(oldestKnown) && before < oldestKnown ? undefined : { offset: this.lineBase, keep: 0 };
	}

	private async readAppended(): Promise<void> {
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(this.transcriptPath, 'r');
		} catch {
			return; // 消えている/未作成。次のポーリングで再試行
		}
		try {
			if (!await isAllowedOpenTranscriptPath(handle, this.transcriptPath)) { return; }
			const stat = await handle.stat();
			if (stat.size < this.offset) {
				// truncate / 置き換え。epoch を切り替えて読み直す (購読者は全量を受け取り直す)
				this.logService.info(`[paradisAgentChat] transcript shrank, re-reading: ${this.transcriptPath}`);
				this.epoch = newEpoch();
				this.rev = 0;
				this.messages.length = 0;
				this.offset = 0;
				this.remainder = '';
				this.claudeQueuedPrompts = newClaudeQueuedPromptState();
				this.lineBase = 0;
				this.positionByRev.clear();
				this.evictedPositions.clear();
				this.modRowRevs.clear();
				this.fileUuids.clear();
				// offset 0 から読み直すので、前のバイト境界を持ち越したデコーダは捨てる。
				this.decoder = new TextDecoder();
				this.initialTruncated = false;
				this.backgroundTasks.clear();
				this.pendingQuestions.clear();
				// 会話が替わったので Monitor の一覧も空にする（読み直しで今の transcript から作り直す）。
				this.monitorWatch.clear();
				this.approvalQueue.length = 0;
				this.approvalDeniedInTurn = false;
				this.liveQuestions.clear();
				this.liveQuestionRealIds.clear();
				// rev が 0 から振り直されるため、退避済みの全文・画像をそのまま残すと新しい rev の
				// 中身と取り違えられる（epoch の検証は通ってしまう）。ここで必ず捨てる。
				this.clearRetainedPayloads();
				this.model = undefined;
				this.effort = undefined;
				// cliVersion は据え置く。次の行で必ず上書きされるうえ、消すとその間の計測から
				// 版が欠ける（モバイルへ出す情報ではないので古い値が残っても表示に影響しない）。
				await handle.close().catch(() => { /* ignore */ });
				await this.initialLoad();
				// initialLoad が読み直した後の状態で購読者・状態レジストリを同期し直す
				// （新ファイルにタスク・質問が無い場合も「無し」を確実に反映する）。
				this.delegate.onEpochReset();
				this.delegate.onActivity();
				this.delegate.onInfo();
				// consumeText 内の issueUrlsChanged 判定は「差分があった時だけ」呼ぶため、
				// truncate後の読み直しで検出Issueが1件も無くなった回だと呼ばれずに前の会話の
				// URLが bus に残ってしまう。onActivity 等と同じく、ここで無条件に1回反映する。
				this.delegate.onIssueUrlsUpdated?.(this.issueUrls);
				return;
			}
			if (stat.size === this.offset) {
				return;
			}
			while (this.offset < stat.size) {
				const length = Math.min(APPEND_READ_CHUNK_BYTES, stat.size - this.offset);
				const buffer = Buffer.alloc(length);
				const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
				if (bytesRead === 0) { break; }
				this.offset += bytesRead;
				this.consumeText(this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true }), true);
			}
			if (!this.watcher) {
				this.startWatching();
			}
			// 初回の末尾を掴めていない状態での読みは「追記」ではない（全文の読み直し）。
			// ここで証拠にしてしまうと、前回から引き継いだセッションが1バイトも書かれて
			// いないのに「動いている」と誤判定される。
			if (this.sawInitialEof) {
				this.delegate.onAppended();
			}
			this.sawInitialEof = true;
		} finally {
			await handle.close().catch(() => { /* ignore */ });
		}
	}

	/**
	 * 切り詰め前の全文を rev 単位で保持する。件数・合計バイトのどちらかが上限を超えたら
	 * 古い rev から捨てる（長時間セッションでPCのメモリが伸び続けないようにするため）。
	 */
	private retainFullText(rev: number, text: string): void {
		this.fullTexts.set(rev, text);
		this.fullTextBytes += text.length;
		while (this.fullTexts.size > FULL_TEXT_CACHE_ENTRIES || this.fullTextBytes > FULL_TEXT_CACHE_BYTES) {
			const oldest = this.fullTexts.keys().next();
			if (oldest.done === true) {
				break;
			}
			this.fullTextBytes -= this.fullTexts.get(oldest.value)?.length ?? 0;
			this.fullTexts.delete(oldest.value);
		}
	}

	/** 'tool-full' 応答用。保持期限を過ぎた rev は undefined（モバイルは切り詰め表示のまま）。 */
	fullTextFor(rev: number): string | undefined {
		return this.fullTexts.get(rev);
	}

	/**
	 * 画像の実体を保持し、モバイルへ送るメタ情報（index/mediaType/バイト数）だけを返す。
	 * 上限超過の画像は実体を捨ててメタだけ残す（モバイルは「大きすぎる」表示にできる）。
	 */
	private retainImages(rev: number, images: readonly IFlattenedImage[]): readonly IParadisAgentChatImage[] {
		const meta: IParadisAgentChatImage[] = [];
		for (let index = 0; index < Math.min(images.length, MAX_IMAGES_PER_MESSAGE); index++) {
			const image = images[index];
			if (image === undefined) {
				continue;
			}
			// 大きすぎる画像は実体を持たない。モバイルが「保持期限切れ」と取り違えないよう
			// メタで区別できるようにする。
			const imageMeta = paradisToolImageMeta(index, image);
			meta.push(imageMeta);
			if (imageMeta.oversize === true) {
				continue;
			}
			sharedImageCache.set(this.imageOwner, rev, index, image);
		}
		return meta;
	}

	/**
	 * 'tool-image' 応答用。保持期限を過ぎた画像・上限超過の画像は undefined
	 * （他のペインが新しい画像を読み込むと、こちらの古い画像が押し出されることもある）。
	 */
	imageFor(rev: number, index: number): IFlattenedImage | undefined {
		return sharedImageCache.get(this.imageOwner, rev, index);
	}

	/** rev を振り直す（epochリセット）際に、rev をキーにした退避データを捨てる。 */
	private clearRetainedPayloads(): void {
		this.fullTexts.clear();
		this.fullTextBytes = 0;
		sharedImageCache.releaseOwner(this.imageOwner);
		// truncate等でepochが切り替わる = 会話の連続性が切れるため、検出済みIssueも
		// 読み直し後の内容から作り直す (initialLoad が consumeText を再度呼ぶことで再検出される)。
		this.issueUrls.clear();
	}

	/** 読み取ったテキストを行に分割してパースし、リングへ追加する。末尾の不完全行は持ち越す。 */
	private consumeText(text: string, emitDelta: boolean): void {
		const combined = this.remainder + text;
		const lines = combined.split('\n');
		const lastPiece = lines.pop() ?? '';
		this.remainder = lastPiece.slice(-MAX_TRANSCRIPT_LINE_BYTES);
		// 行の頭のバイト位置（古い発言をファイルから読むときの境目。W2-30）。
		let lineOffset = this.lineBase;
		const signals = newParseSignals(this.claudeQueuedPrompts);
		const entries: { readonly obj: Record<string, unknown>; readonly lineStart: number }[] = [];
		let latestProgress: ITranscriptProgress | undefined;
		let issueUrlsChanged = false;
		for (const line of lines) {
			const lineStart = lineOffset;
			lineOffset += Buffer.byteLength(line, 'utf8') + 1;
			const trimmed = line.trim();
			if (trimmed.length === 0) {
				continue;
			}
			// Issue URLはユーザーの発話・ツール入出力どちらにも現れ得るため、パース前の生JSON行
			// テキストへ直接正規表現を当てる（メッセージ種別ごとの本文取り出しに依存しない）。
			for (const url of paradisExtractIssueUrls(trimmed)) {
				if (!this.issueUrls.has(url)) {
					this.issueUrls.add(url);
					issueUrlsChanged = true;
				}
			}
			let obj: Record<string, unknown> | undefined;
			try {
				obj = rec(JSON.parse(trimmed));
			} catch {
				continue; // 壊れた行はスキップ (フォーマット変化への耐性)
			}
			if (!obj) {
				continue;
			}
			if (this.agent === 'claude') {
				if (emitDelta) {
					// 書かれた直後に読んだ行の時刻で、transcript の時計と PC の時計のずれを測る（SSH の写しは接続先の時計）。
					const writtenAt = Date.parse(str(obj.timestamp) ?? '');
					if (Number.isFinite(writtenAt)) {
						this.monitorWatch.observeClock(writtenAt);
					}
				}
				this.observePromptCache(obj);
				const progress = parseClaudeProgress(obj);
				if (progress !== undefined) {
					latestProgress = progress;
					continue;
				}
				// mod（Claude Mods）から先に受け取った行。中身は表示済みなので、位置と、ファイルにしか無い値だけを拾う
				if (this.adoptModRow(obj, lineStart, signals)) {
					continue;
				}
			}
			entries.push({ obj, lineStart });
		}
		this.lineBase = lineOffset + (lastPiece.length > this.remainder.length ? Buffer.byteLength(lastPiece.slice(0, lastPiece.length - this.remainder.length), 'utf8') : 0);
		this.consumeEntries(entries, signals, emitDelta, latestProgress, issueUrlsChanged);
	}

	/**
	 * 解釈した行をメッセージにしてリングへ足す（ファイルから読んだ行と、mod から受け取った行の共通の処理）。
	 * lineStart はファイルの行の頭のバイト位置（mod の行には無い。ファイルに現れたときに {@link adoptModRow} が入れる）。
	 */
	private consumeEntries(
		entries: readonly { readonly obj: Record<string, unknown>; readonly lineStart?: number; readonly modUuid?: string }[],
		signals: IParseSignals,
		emitDelta: boolean,
		latestProgress?: ITranscriptProgress,
		issueUrlsChanged = false,
		forkHistory = false,
	): void {
		// fullText / imageData はここでだけ通過する（この直後に退避して送信対象から外す）。
		const added: (IParadisAgentChatMessage & { fullText?: string; imageData?: readonly IFlattenedImage[] })[] = [];
		for (const { obj, lineStart, modUuid } of entries) {
			const modRevs: { rev: number; keep: number }[] | undefined = modUuid !== undefined ? [] : undefined;
			const raw = this.agent === 'claude' ? parseClaudeLine(obj, signals) : parseCodexLine(obj, signals);
			for (const [rawIndex, message] of raw.entries()) {
				const position: IParadisHistoryCursor | undefined = lineStart !== undefined ? { offset: lineStart, keep: rawIndex } : undefined;
				// ライブ質問の決着処理: hookで注入済みの質問が決着後に transcript へ本物として
				// 現れたら間引き（合成カードで表示済み）、対応する tool_result は合成IDへ
				// 付け替える（モバイル側の合成カードが「回答済み」になる）。
				if (message.kind === 'question') {
					const syntheticId = this.takeLiveQuestionMatch(message);
					if (syntheticId !== undefined) {
						if (message.toolUseId !== undefined) {
							const ids = this.liveQuestionRealIds.get(message.toolUseId);
							if (ids !== undefined) {
								ids.push(syntheticId);
							} else {
								this.liveQuestionRealIds.set(message.toolUseId, [syntheticId]);
							}
						}
						continue;
					}
				}
				if (message.kind === 'tool_result' && message.toolUseId !== undefined) {
					const syntheticIds = this.liveQuestionRealIds.get(message.toolUseId);
					if (syntheticIds !== undefined) {
						this.liveQuestionRealIds.delete(message.toolUseId);
						for (const syntheticId of syntheticIds) {
							signals.answeredIds.push(syntheticId);
							this.setPosition(this.rev, position);
							modRevs?.push({ rev: this.rev, keep: rawIndex });
							added.push({ ...message, toolUseId: syntheticId, rev: this.rev++ });
						}
						continue;
					}
				}
				this.setPosition(this.rev, position);
				modRevs?.push({ rev: this.rev, keep: rawIndex });
				added.push({ ...message, rev: this.rev++ });
			}
			if (modUuid !== undefined && modRevs !== undefined) {
				this.rememberModRow(modUuid, modRevs);
			}
		}
		// fullText / 画像の実体は送信メッセージから外し、rev 単位でここに退避する
		// （'tool-full' / 'tool-image' の取り寄せ用）。画像はメタ情報だけをメッセージに残す。
		for (let i = 0; i < added.length; i++) {
			const message = added[i];
			if (message === undefined) {
				continue;
			}
			let replacement = message;
			if (replacement.fullText !== undefined) {
				this.retainFullText(replacement.rev, replacement.fullText);
				const { fullText, ...rest } = replacement;
				replacement = rest;
			}
			if (replacement.imageData !== undefined) {
				const images = this.retainImages(replacement.rev, replacement.imageData);
				const { imageData, ...rest } = replacement;
				replacement = images.length > 0 ? { ...rest, images } : rest;
			}
			added[i] = replacement;
		}
		if (forkHistory) {
			// fork 先の過去の会話: 発言とモデル・effort だけを取る（fork 先の行が後から上書きする）
			this.model = signals.model ?? this.model;
			this.effort = signals.effort ?? this.effort;
			this.messages.push(...added);
			this.trimRing();
			return;
		}
		// 結果が書かれたツールの承認は決着している（ターミナルで拒否したときは hook が来ず、これが唯一の手がかり）。
		const resultIds = added.filter(message => message.kind === 'tool_result' && message.toolUseId !== undefined).map(message => message.toolUseId!);
		const hadQueuedApproval = this.approvalQueue.length > 0;
		if (signals.codexActivityTimeline.some(event => event.type === 'turnStart')) {
			this.approvalDeniedInTurn = false;
		}
		const approvalsSettled = emitDelta && this.settleApprovalsByToolResults(resultIds);
		if (emitDelta && resultIds.length > 0) {
			const rejected = added.some(message => paradisIsToolRejection(this.agent, message));
			// 承認の拒否を覚えておく。Codex は拒否の結果（`aborted by user`）の直後に `turn_aborted` を書くが、
			// 結果で承認はもう列から外れているので、ターンの終わりの時点では列を見ても拒否と分からない。
			if (rejected && hadQueuedApproval) {
				this.approvalDeniedInTurn = true;
			}
			this.delegate.onToolResults?.(resultIds, rejected);
		}
		this.applySignals(signals, emitDelta);
		if (emitDelta) {
			const advisors = added.filter(message => message.advisor !== undefined && message.toolUseId !== undefined);
			if (advisors.length > 0) {
				this.delegate.onAdvisors?.(advisors);
			}
		}
		if (approvalsSettled && added.length === 0) {
			this.delegate.onDelta([]);
		}
		if (approvalsSettled) {
			this.delegate.onActivity();
		}
		if (latestProgress !== undefined) {
			this.delegate.onProgress(latestProgress);
		}
		if (issueUrlsChanged) {
			this.delegate.onIssueUrlsUpdated?.(this.issueUrls);
		}
		if (added.length === 0) {
			return;
		}
		this.messages.push(...added);
		this.trimRing();
		if (emitDelta) {
			this.delegate.onDelta(added);
		}
	}

	// ---- Claude Code の mod（Claude Mods）から受け取る行 -------------------------------------------
	//
	// mod は transcript に書かれる行を、書き込みの直前に uuid 付きで渡してくる（ファイルより中央値 93 ms、
	// AskUserQuestion の行は回答前に）。届いた行はすぐに会話へ足し、同じ uuid の行がファイルに現れたら
	// 足さずに位置（古い発言を読むときの境目）だけを覚える。mod が来ないペインでは何も変わらない。

	/** mod から足した行の uuid → その行から作った発言の rev と、行の中での順番。ファイルに現れたら消す。 */
	private readonly modRowRevs = new Map<string, readonly { readonly rev: number; readonly keep: number }[]>();
	/** ファイルから読んだ行の uuid（mod の行が遅れて届いたときに二重にしない）。 */
	private readonly fileUuids = new Set<string>();

	private setPosition(rev: number, position: IParadisHistoryCursor | undefined): void {
		if (position !== undefined) {
			this.positionByRev.set(rev, position);
		}
	}

	private rememberModRow(uuid: string, revs: readonly { readonly rev: number; readonly keep: number }[]): void {
		this.modRowRevs.set(uuid, revs);
		while (this.modRowRevs.size > MOD_ROW_LEDGER_LIMIT) {
			const oldest = this.modRowRevs.keys().next();
			if (oldest.done === true) {
				break;
			}
			this.modRowRevs.delete(oldest.value);
		}
	}

	/**
	 * ファイルの行が mod から足した行と同じなら、位置とファイルにしか無い値（モデル名・版）だけを拾って true。
	 * 違えば uuid を覚えて false（ふつうに解釈する）。
	 */
	private adoptModRow(obj: Record<string, unknown>, lineStart: number, signals: IParseSignals): boolean {
		const uuid = str(obj.uuid);
		if (uuid === undefined) {
			return false;
		}
		const revs = this.modRowRevs.get(uuid);
		if (revs === undefined) {
			this.fileUuids.add(uuid);
			while (this.fileUuids.size > MOD_ROW_LEDGER_LIMIT * 2) {
				const oldest = this.fileUuids.values().next();
				if (oldest.done === true) {
					break;
				}
				this.fileUuids.delete(oldest.value);
			}
			return false;
		}
		this.modRowRevs.delete(uuid);
		const inRing = new Set(this.messages.map(message => message.rev));
		for (const { rev, keep } of revs) {
			(inRing.has(rev) ? this.positionByRev : this.evictedPositions).set(rev, { offset: lineStart, keep });
		}
		const version = str(obj.version);
		if (version !== undefined) {
			signals.cliVersion = version;
		}
		const model = str(rec(obj.message)?.model);
		if (model !== undefined && model.length > 0) {
			signals.model = model;
		}
		return true;
	}

	/** 保留中の mod の行のタイマー（届いた順に足すので、順番はタイマーの順のまま）。 */
	private readonly modRowTimers = new Set<ReturnType<typeof setTimeout>>();

	/**
	 * mod から受け取った本会話の行（prompt / response）を足す。{@link MOD_ROW_HOLD_MS} だけ保留し、その間に
	 * ファイルへ同じ行が現れたら捨てる（ファイルの方が速かった）。足す前にファイルの追記を読み切るので、
	 * ファイルに先に書かれていたもの（ツールの結果・作業中に送った発言など）より後ろに並ぶ。
	 * 返す Promise は、足し終えた（または捨てた）ところで解決する。
	 */
	ingestModRow(row: { readonly uuid: string; readonly at: number; readonly advisorModel?: string; readonly message: { readonly type: string; readonly role?: string; readonly isMeta?: boolean; readonly content: unknown } }): Promise<void> {
		if (this.agent !== 'claude' || this.disposed) {
			return Promise.resolve();
		}
		return new Promise<void>(resolve => {
			const timer = setTimeout(() => {
				this.modRowTimers.delete(timer);
				this.enqueue(async () => {
					await this.readAppended();
					if (this.fileUuids.has(row.uuid) || this.modRowRevs.has(row.uuid)) {
						return;
					}
					const obj: Record<string, unknown> = {
						type: row.message.type,
						uuid: row.uuid,
						timestamp: new Date(row.at).toISOString(),
						...(row.message.isMeta === true ? { isMeta: true } : {}),
						...(row.advisorModel !== undefined ? { advisorModel: row.advisorModel } : {}),
						message: { ...(row.message.role !== undefined ? { role: row.message.role } : {}), content: row.message.content },
					};
					this.consumeEntries([{ obj, modUuid: row.uuid }], newParseSignals(this.claudeQueuedPrompts), this.sawInitialEof);
				}).then(resolve, resolve);
			}, MOD_ROW_HOLD_MS);
			this.modRowTimers.add(timer);
		});
	}

	/**
	 * Para Code からの知らせを会話に 1 行足す（transcript には無い）。送った発言がエージェントへ届かなかったときなど、
	 * もう答え終えた操作の失敗を伝えるのに使う。`notice` を付け、新しいアプリとデスクトップはエージェントの発言と
	 * 分けて灰色の 1 行で出す（古いアプリは本文として出す）。
	 */
	injectNotice(text: string): void {
		this.enqueue(async () => {
			const message: IParadisAgentChatMessage = { role: 'assistant', kind: 'text', text: truncateText(text, TEXT_LIMIT), ts: Date.now(), rev: this.rev++, notice: true };
			this.messages.push(message);
			this.trimRing();
			this.delegate.onDelta([message]);
		});
	}

	/** 答えていない承認（表に出す候補）。 */
	approvalInteractions(): readonly Extract<IParadisAgentInteraction, { readonly kind: 'approval' }>[] {
		return this.approvalQueue.filter(entry => !entry.answered).map(entry => entry.interaction);
	}

	/**
	 * 承認のカードの選択肢を、mod が答えられるか（`resolve` が選択肢を返すか）で直す。答えられないものは「許可 / 拒否」。
	 * `answerVia: 'mod'` は、mod が拒否に指示を添えられるときだけ付ける（それ以外は外す）。
	 */
	updateModApprovals(resolve: (interaction: Extract<IParadisAgentInteraction, { readonly kind: 'approval' }>) => { readonly choices: readonly IParadisAgentApprovalChoice[]; readonly denyMessage: boolean } | undefined): void {
		this.enqueue(async () => {
			let changed = false;
			for (let index = 0; index < this.approvalQueue.length; index++) {
				const entry = this.approvalQueue[index];
				if (entry.answered || paradisIsCodexDaemonApprovalInteraction(entry.interaction.id)) {
					continue;
				}
				const resolved = resolve(entry.interaction);
				const choices = resolved?.choices ?? PARADIS_DEFAULT_APPROVAL_CHOICES;
				const viaMod = resolved?.denyMessage === true;
				if (JSON.stringify(entry.interaction.choices) !== JSON.stringify(choices) || (entry.interaction.answerVia === 'mod') !== viaMod) {
					const { answerVia: _previous, ...rest } = entry.interaction;
					this.approvalQueue[index] = { ...entry, interaction: { ...rest, choices, ...(viaMod ? { answerVia: 'mod' as const } : {}) } };
					changed = true;
				}
			}
			if (changed) {
				this.delegate.onDelta([]);
				this.delegate.onActivity();
			}
		});
	}

	/** 直前の user 行（ユーザーの発言か tool_result）の時刻＝次のリクエストを送った時刻の近似。 */
	private promptRequestStartedAt: number | undefined;

	/**
	 * assistant 行の usage からプロンプトキャッシュの使い方を拾う（デスクトップ表示専用）。
	 * 起点は応答を書き終えた時刻ではなく、その応答を求めたリクエストの時刻（直前の user 行）。
	 * 読み込みだけのリクエストは有効期限の長さを変えないので、直前に書いたときの長さを引き継ぐ。
	 */
	private observePromptCache(line: Record<string, unknown>): void {
		const requestStart = paradisReadClaudeRequestStart(line);
		if (requestStart !== undefined) {
			this.promptRequestStartedAt = requestStart;
			return;
		}
		const usage = paradisReadClaudePromptCacheUsage(line);
		if (usage === undefined) {
			return;
		}
		const usedAt = this.promptRequestStartedAt !== undefined && this.promptRequestStartedAt <= usage.at ? this.promptRequestStartedAt : usage.at;
		if (this.promptCache !== undefined && usedAt < this.promptCache.lastUsedAt) {
			return;
		}
		this.promptCache = { lastUsedAt: usedAt, ttlMs: usage.ttlMs ?? this.promptCache?.ttlMs ?? PARADIS_PROMPT_CACHE_TTL_5M };
	}

	/**
	 * 回答待ちの承認（届いた順）。並列のツールで許可要求が重なることがあり（TUI は後から来たものを先に
	 * 出し、答えると前のものを出す）、1枠だと先の許可が中継から消える。表に出す（currentInteraction が
	 * 返す）のは最後の1件で、それが解けたら次のものを出す。モバイルへ送る形は1件のまま変えない。
	 */
	private readonly approvalQueue: IParadisApprovalEntry[] = [];
	/** このターンで利用者が承認を拒否した（ターンの終わりで戻す。stoppedOnApproval）。 */
	private approvalDeniedInTurn = false;
	private approvalSeq = 0;

	/** 今表に出している承認。 */
	private get pendingApproval(): Extract<IParadisAgentInteraction, { readonly kind: 'approval' }> | undefined {
		const index = this.frontApprovalIndex();
		return index < 0 ? undefined : this.approvalQueue[index].interaction;
	}

	/**
	 * 表に出す承認の位置（答えていないもののうち最後に積んだもの。無ければ -1）。答え終えた承認は、
	 * ツールの完了で列から外れるまで残るが、表には出さない（答えていない次の1件を出す）。
	 */
	private frontApprovalIndex(): number {
		for (let index = this.approvalQueue.length - 1; index >= 0; index--) {
			if (!this.approvalQueue[index].answered) {
				return index;
			}
		}
		return -1;
	}

	/** 承認を列から外す（該当が無ければ何もしない）。外したら true。 */
	private removeApprovals(predicate: (entry: IParadisApprovalEntry) => boolean): boolean {
		let removed = false;
		for (let index = this.approvalQueue.length - 1; index >= 0; index--) {
			if (predicate(this.approvalQueue[index])) {
				this.approvalQueue.splice(index, 1);
				removed = true;
			}
		}
		return removed;
	}
	/** デスクトップのチャット表示のためだけに入れた質問の合成 id。ペインの状態（質問中）に数えない。 */
	readonly desktopOnlyQuestionIds = new Set<string>();

	/**
	 * PermissionRequest hook で受けた承認要求の内容（ツール名・コマンド等）を表示カードとして
	 * 注入する。Codex は承認要求を rollout に一切書かず、Claude もプロンプト表示中は
	 * transcript に現れないため、hook が唯一のライブな供給源。モバイル側はこのメッセージの
	 * 内容を承認バー（許可/拒否）に添えて表示する。
	 *
	 * `detail`（1 行）は古いアプリの表示と、hook と mod の承認の本文での突き合わせに使うので形を変えない。
	 * 新しいアプリ向けには、ツールごとに分けた中身（`request`）と、許可を求めたサブエージェント、
	 * 「以後は確認しない」の残り方を添える（agent.approval.detail.v1）。
	 */
	injectApprovalRequest(toolName: string | undefined, toolInput: unknown, toolUseId?: string, desktopOnly = false, waitKey?: string, sameContentLimit = 1, suggestions?: readonly string[],
		extra?: { readonly agent?: IParadisAgentApprovalAgent; readonly suggestionScope?: ParadisAgentApprovalSuggestionScope }): void {
		this.enqueue(async () => {
			// ここで pendingQuestions を見て注入自体を捨ててはいけない。PermissionRequest hook は
			// 1プロンプトにつき1回しか来ないため、落とすと承認要求が永久に復元されない。
			// AskUserQuestion 由来の二重カードは currentInteraction が質問を優先することで
			// 表示上隠れる（承認は解除されるまで保持しておく必要がある）。
			const text = paradisApprovalRequestText(toolName, toolInput);
			if (text.length === 0) {
				return;
			}
			// 本文（説明を先に採る）だけだと、説明が同じで中身の違う呼び出しを再送と取り違えるので、入力も鍵に含める
			const content = `${text}\0${paradisStableJson(toolInput)}`;
			const key = toolUseId !== undefined ? `${toolUseId}:${content}` : content;
			// 同じ内容の要求が、同じ内容の未完了のツール呼び出しの数より多くなるなら、同じ hook の再送として捨てる。
			// 並列の同じ呼び出し（同じファイルの Read を2つ等）は、呼び出しの数まで別の承認として積む。
			if (this.approvalQueue.filter(entry => entry.key === key).length >= Math.max(1, sameContentLimit)) {
				return;
			}
			const interactionId = toolUseId ?? `approval:${this.epoch}:${this.approvalSeq++}`;
			const request = paradisBuildAgentApprovalRequest(toolName, toolInput, extra?.agent);
			this.approvalQueue.push({
				interaction: {
					kind: 'approval', id: interactionId, title: '操作の許可', detail: truncateText(text, TOOL_TEXT_LIMIT),
					choices: PARADIS_DEFAULT_APPROVAL_CHOICES,
					...(suggestions !== undefined ? { suggestions } : {}),
					...(request !== undefined ? { request } : {}),
					...(suggestions !== undefined && extra?.suggestionScope !== undefined ? { suggestionScope: extra.suggestionScope } : {}),
				},
				key,
				desktopOnly,
				...(waitKey !== undefined ? { waitKey } : {}),
			});
			const message: IParadisAgentChatMessage = {
				role: 'assistant', kind: 'tool_use', tool: 'approval_request',
				text: truncateText(text, TOOL_TEXT_LIMIT), ts: Date.now(), rev: this.rev++, toolUseId: interactionId,
			};
			this.messages.push(message);
			this.trimRing();
			this.delegate.onDelta([message]);
			this.delegate.onActivity();
		});
	}

	/**
	 * 承認を解く。toolUseId が一致するものを外す。force（拒否の hook）は、一致するものが無ければ表の1件を
	 * 外す。all（ターン終了）はすべて外す。
	 */
	clearApprovalRequest(toolUseId: string | undefined, force: boolean, all = false): void {
		this.enqueue(async () => {
			let removed = all
				? this.removeApprovals(() => true)
				: toolUseId !== undefined && this.removeApprovals(entry => entry.interaction.id === toolUseId);
			if (!removed && force && this.approvalQueue.length > 0) {
				this.approvalQueue.pop();
				removed = true;
			}
			if (!removed) {
				return;
			}
			this.delegate.onDelta([]);
			this.delegate.onActivity();
		});
	}

	currentInteraction(): IParadisAgentInteraction | null {
		const current = paradisPickCurrentInteraction(this.messages, this.pendingQuestions, this.pendingApproval);
		return current?.kind === 'question' ? { ...current, answerVia: this.modQuestionIds.has(current.id) ? 'mod' : 'keys' } : current;
	}

	/** 回答待ちの質問のカードの ID（questionGroup ?? toolUseId）。 */
	pendingQuestionInteractionIds(): readonly string[] {
		const ids = new Set<string>();
		for (const message of this.messages) {
			if (message.kind === 'question' && message.toolUseId !== undefined && this.pendingQuestions.has(message.toolUseId)) {
				ids.add(message.questionGroup ?? message.toolUseId);
			}
		}
		return [...ids];
	}

	/** mod で答えられる質問のカードを入れ替える。変わったら購読者へ interaction を送り直す。 */
	setModQuestionIds(ids: ReadonlySet<string>): void {
		if (ids.size === this.modQuestionIds.size && [...ids].every(id => this.modQuestionIds.has(id))) {
			return;
		}
		this.modQuestionIds = ids;
		this.delegate.onDelta([]);
	}

	/**
	 * 承認要求が回答待ちかどうか。currentInteraction は質問を優先して承認を隠すため、
	 * 「承認が存在するか」という事実が必要な箇所（ペイン状態の補正など）はこちらを使う。
	 */
	hasPendingApproval(): boolean {
		return this.approvalQueue.some(entry => !entry.desktopOnly && !entry.answered);
	}

	/** デスクトップ専用のものも含めて、回答待ちの承認が残っているか。 */
	hasAnyPendingApproval(): boolean {
		return this.approvalQueue.some(entry => !entry.answered);
	}

	/**
	 * このターンが承認のところで止まったか（答え終えたものも含めて承認が列に残っている、またはこのターンで
	 * 承認を拒否した）。中断されたターンを完了（review）ではなく次の指示待ち（idle）とみなすのに使う。
	 */
	stoppedOnApproval(): boolean {
		return this.approvalQueue.length > 0 || this.approvalDeniedInTurn;
	}

	/** 今キューに積まれている処理（承認の解除など）が済んだ後に実行する。 */
	afterQueue(work: () => void): Promise<void> {
		return this.enqueue(async () => work());
	}

	/**
	 * 回答待ちの質問があるか（ペインの状態用）。デスクトップのチャット表示のためだけに入れた質問は
	 * 数えない（モバイル向けの注入が動いていない構成で、ペインの状態を以前と変えないため）。
	 */
	hasPendingQuestionForStatus(): boolean {
		for (const id of this.pendingQuestions) {
			if (!this.desktopOnlyQuestionIds.has(id)) {
				return true;
			}
		}
		return false;
	}

	/** モバイルが購読を始めた・注入が有効になった: デスクトップ専用の印を外し、ペインの状態へ反映する。 */
	promoteDesktopOnly(): void {
		this.enqueue(async () => {
			if (!this.approvalQueue.some(entry => entry.desktopOnly) && this.desktopOnlyQuestionIds.size === 0) {
				return;
			}
			for (let index = 0; index < this.approvalQueue.length; index++) {
				this.approvalQueue[index] = { ...this.approvalQueue[index], desktopOnly: false };
			}
			this.desktopOnlyQuestionIds.clear();
			this.delegate.onActivity();
		});
	}

	/**
	 * 合成 id（tool_use_id の無い PermissionRequest から作った承認）の承認を解く。いつ解くかは呼び出し側が
	 * PreToolUse / PostToolUse の tool_use_id を数えて決める（ParadisMobileAgentChat.syntheticApprovalWaits）。
	 */
	clearSyntheticApproval(waitKey: string): void {
		this.enqueue(async () => {
			if (!this.removeApprovals(entry => entry.waitKey === waitKey && entry.interaction.id.startsWith('approval:'))) {
				return;
			}
			this.delegate.onDelta([]);
			this.delegate.onActivity();
		});
	}

	/**
	 * デスクトップかモバイルから答え終えた承認に印を付ける。表に出す候補から外し（答えていない次の1件が
	 * 表に出る。同じ内容の許可が2つ続いたとき、2つ目を出すため）、同じ本文の要求の再発火も新しい承認として
	 * 受け付ける。承認そのものは、今までどおりツールの完了で列から外れるまで残す。
	 */
	markApprovalAnswered(interactionId: string): void {
		this.enqueue(async () => {
			let changed = false;
			for (let index = 0; index < this.approvalQueue.length; index++) {
				const entry = this.approvalQueue[index];
				if (entry.interaction.id === interactionId && !entry.answered) {
					this.approvalQueue[index] = { ...entry, answered: true, key: `answered:${entry.key}:${index}:${Date.now()}` };
					changed = true;
				}
			}
			if (changed) {
				this.delegate.onDelta([]);
				this.delegate.onActivity();
			}
		});
	}

	/**
	 * transcript に書かれたツールの結果で承認を解く。Claude Code は許可をターミナルで拒否したとき、
	 * PostToolUse も PermissionDenied も出さず、transcript に is_error の tool_result を書くだけ
	 * （2.1.283 で確認）。結果が書かれた時点でそのツールの承認は決着している。
	 */
	private settleApprovalsByToolResults(toolUseIds: readonly string[]): boolean {
		if (toolUseIds.length === 0 || this.approvalQueue.length === 0) {
			return false;
		}
		const ids = new Set(toolUseIds);
		return this.removeApprovals(entry => ids.has(entry.interaction.id));
	}

	/**
	 * 質問の決着（PostToolUse）またはターン終了で、未回答のまま残った質問の回答待ちを解除する。
	 *
	 * pendingQuestions は本来 transcript の tool_result 到達で消えるが、hook 由来のライブ質問は
	 * 合成IDのため内容キーで突き合わせており（paradisTakeLiveQuestionSyntheticId）、Windows の
	 * PowerShell hook が選択肢を落とすなどでマッチを外すと永久に残る。currentInteraction が
	 * 質問を承認より優先する以上、これが残ると今度は承認が回答不能になるため対の解除経路を置く。
	 */
	clearPendingQuestions(): void {
		this.enqueue(async () => {
			if (!this.discardPendingQuestions()) {
				return;
			}
			this.delegate.onDelta([]);
			this.delegate.onActivity();
		});
	}

	/**
	 * 未回答の質問と、合成IDの突合台帳をまとめて捨てる。
	 *
	 * pendingQuestions だけを消すと台帳（liveQuestions / liveQuestionRealIds）に古い合成IDが
	 * 残り、次に同じ質問文が出たときに先頭の古いIDが shift される。すると transcript の本物の
	 * 質問が「表示済み」として間引かれ、その tool_result も古いIDへ付け替えられて、新しく
	 * 注入したカードだけが未回答で残る＝同じ固着が即座に再発する。epoch reset の経路と同じ
	 * 組で消すのが不変条件。
	 */
	private discardPendingQuestions(): boolean {
		if (this.pendingQuestions.size === 0 && this.liveQuestions.size === 0 && this.liveQuestionRealIds.size === 0) {
			return false;
		}
		this.pendingQuestions.clear();
		this.liveQuestions.clear();
		this.liveQuestionRealIds.clear();
		this.desktopOnlyQuestionIds.clear();
		return true;
	}

	hasPendingInteraction(interaction: IParadisAgentInteraction): boolean {
		const current = this.currentInteraction();
		return current?.kind === interaction.kind && current.id === interaction.id;
	}

	pendingQuestionMessages(interactionId: string): readonly IParadisAgentChatMessage[] {
		return this.messages.filter(message => message.kind === 'question' && (message.questionGroup ?? message.toolUseId) === interactionId
			&& message.toolUseId !== undefined && this.pendingQuestions.has(message.toolUseId))
			.sort((a, b) => (a.questionIndex ?? 0) - (b.questionIndex ?? 0));
	}

	private takeLiveQuestionMatch(message: IRawMessage): string | undefined {
		return paradisTakeLiveQuestionSyntheticId(this.liveQuestions, message);
	}

	private hasPendingQuestionForText(message: IRawMessage): boolean {
		return paradisHasPendingDuplicateQuestion(this.messages, this.pendingQuestions, message);
	}

	/**
	 * PreToolUse hook で受けた AskUserQuestion の tool_input をライブ質問カードとして注入する。
	 * transcript の読み取りと同じキューで直列化し、rev 採番・リング更新の競合を防ぐ。
	 * 注入されたカードは delegate.onDelta 経由で購読者へ届き、（onDelta 内の既存処理で）
	 * 質問プッシュ通知も発火する。quiet のときは通知を出さない（デスクトップのチャット表示のためだけに
	 * 入れる場合。モバイル向けの注入が動いていない構成で、モバイルへ新しく通知を出さないため）。
	 */
	injectLiveQuestions(input: unknown, quiet = false): void {
		this.enqueue(async () => {
			const parsed = parseAskUserQuestions(input, undefined, Date.now());
			// transcript 側が先に同じ質問群を出している（hook の配送が transcript 読み取りより
			// 遅れた）場合は注入しない。内容キー完全一致に加えて質問文のみでも突き合わせるのは、
			// 一方の経路で選択肢が欠落しても（Windows の PowerShell hook が tool_input の深い
			// 配列を落とす等）二重カードにしないため。判定は未回答の質問に限る（回答済みの
			// 同文質問との誤衝突を防ぐ）。群の一部だけ一致する状態は transcript が tool_use を
			// 行単位で原子的に書くため起きない想定だが、万一の際は質問の取りこぼし防止を優先
			// して注入する
			if (parsed.length > 0 && parsed.every(message => this.hasPendingQuestionForText(message))) {
				return;
			}
			// 1回の hook = 1つの AskUserQuestion 呼び出し。複数質問をモバイル側で1枚の
			// ステップ式カードへ集約できるよう、共通の合成グループキーを付与する
			const groupId = `liveg:${this.epoch}:${this.liveQuestionGroupSeq++}`;
			const added: IParadisAgentChatMessage[] = [];
			const occurrences = new Map<string, number>();
			for (const message of parsed) {
				const key = liveQuestionContentKey(message);
				const occurrence = occurrences.get(key) ?? 0;
				occurrences.set(key, occurrence + 1);
				const existingIds = this.liveQuestions.get(key) ?? [];
				if (existingIds.length > occurrence) {
					continue; // 同一質問の多重hook（リトライ等）は無視
				}
				const syntheticId = `live:${this.epoch}:${this.liveQuestionSeq++}`;
				existingIds.push(syntheticId);
				this.liveQuestions.set(key, existingIds);
				this.pendingQuestions.add(syntheticId);
				if (quiet) {
					this.desktopOnlyQuestionIds.add(syntheticId);
				}
				added.push({ ...message, toolUseId: syntheticId, questionGroup: groupId, rev: this.rev++ });
			}
			if (added.length === 0) {
				return;
			}
			// 質問が始まった以上、hook 由来の解除されずに残った承認要求は既に無効。合成IDの
			// pendingApproval は PostToolUse と一致せずターン終了まで残るため、ここで落として
			// おく（currentInteraction の質問優先と合わせた二重の保険）。
			// ただし Codex app-server 由来の承認は実際に serverRequest が応答待ちなので消さない。
			// 消すと handleApprovalAction の daemon 経路に乗らず Codex が永久にブロックされる。
			this.removeApprovals(entry => !paradisIsCodexDaemonApprovalInteraction(entry.interaction.id));
			this.messages.push(...added);
			this.trimRing();
			this.delegate.onDelta(added, quiet ? { quiet: true } : undefined);
			this.delegate.onActivity();
		});
	}

	/** モバイルへ送る Monitor の一覧（Claude のセッションだけ。Codex には無い）。時刻は PC の時計。 */
	monitors(): IParadisAgentMonitor[] {
		return this.monitorWatch.snapshot();
	}

	/** バックグラウンドのシェルの一覧（Monitor と同じ係が追う）。 */
	shells(): IParadisAgentShell[] {
		return this.monitorWatch.shellSnapshot();
	}

	shellOutputFile(shellId: string): string | undefined {
		return this.monitorWatch.shellOutputFile(shellId);
	}

	isShellRunning(shellId: string): boolean {
		return this.monitorWatch.isShellRunning(shellId);
	}

	/** アプリから止めた（transcript に残らない）。変われば onMonitors で一覧を送る。 */
	markShellStoppedFromMobile(shellId: string): void {
		this.monitorWatch.markShellStoppedFromMobile(shellId);
	}

	/** 出力ファイルの最後の行が印ではなかった（推定の終わりを取り消す）。 */
	markShellRunningFromOutput(shellId: string): void {
		this.monitorWatch.markShellRunningFromOutput(shellId);
	}

	/** 出力ファイルの最後の印で終わりが分かった（推定）。 */
	markShellEndedFromOutput(shellId: string, end: { readonly status: 'completed' | 'failed' | 'stopped'; readonly exitCode?: number }): void {
		this.monitorWatch.markShellEndedFromOutput(shellId, end);
	}

	/**
	 * Claude Code のセッションが終わった（SessionEnd hook）。Monitor はプロセスと一緒に止まるが
	 * transcript には何も残らないので、動いていたものを「停止（推定）」にする。
	 */
	endMonitorsForSessionEnd(at: number): void {
		this.monitorWatch.endSession(at);
	}

	/**
	 * SubagentStart/SubagentStop hook 由来のバックグラウンドタスク開始を反映する。
	 * transcriptパース由来 (openedTasks) と同じ backgroundTasks を共有するが、キーは
	 * `hook:` 接頭辞 (呼び出し側の HOOK_BACKGROUND_TASK_PREFIX) で名前空間を分け、由来の
	 * 異なるIDが衝突して誤って早期closeされないようにする。上限は copyPaneActivity
	 * (paradisAgentHookBus.ts) の公開上限と合わせる: 超えた分はどのみち公開されないので、
	 * ここで弾いておかないと外部プロセスからの入力で無制限に Map が伸び得る。
	 */
	markBackgroundTaskOpen(id: string, at: number): void {
		if (this.backgroundTasks.has(id) || this.backgroundTasks.size >= BACKGROUND_TASK_MAX_ENTRIES) {
			return;
		}
		this.backgroundTasks.set(id, at);
		this.delegate.onActivity();
	}

	/** SubagentStart/SubagentStop hook 由来のバックグラウンドタスク終了を反映する。 */
	markBackgroundTaskClose(id: string): void {
		if (this.backgroundTasks.delete(id)) {
			this.delegate.onActivity();
		}
	}

	/**
	 * hook由来 (HOOK_BACKGROUND_TASK_PREFIX接頭辞) のバックグラウンドタスクだけを破棄する。
	 * transcriptパース由来 (openedTasks) は対象外。SubagentStop の発火漏れ等で閉じ損ねた
	 * エントリを、次のユーザーターン開始時に持ち越さないためのもの。
	 */
	clearHookBackgroundTasks(): void {
		let changed = false;
		for (const id of this.backgroundTasks.keys()) {
			if (id.startsWith(HOOK_BACKGROUND_TASK_PREFIX) && this.backgroundTasks.delete(id)) {
				changed = true;
			}
		}
		if (changed) {
			this.delegate.onActivity();
		}
	}

	/** パースで収集したシグナルをタスク・質問・メタ情報の追跡へ反映し、変化があれば通知する。 */
	private applySignals(signals: IParseSignals, live: boolean): void {
		let activityChanged = false;
		for (const [id, at] of signals.openedTasks) {
			if (!this.backgroundTasks.has(id)) {
				this.backgroundTasks.set(id, at);
				activityChanged = true;
			}
		}
		for (const id of signals.closedTasks) {
			if (this.backgroundTasks.delete(id)) {
				activityChanged = true;
			}
		}
		for (const id of signals.askedQuestionIds) {
			if (!this.pendingQuestions.has(id)) {
				this.pendingQuestions.add(id);
				activityChanged = true;
			}
		}
		for (const id of signals.answeredIds) {
			if (this.pendingQuestions.delete(id)) {
				activityChanged = true;
			}
		}
		// 保険: 実ユーザーのテキスト発話が現れた＝会話は先へ進んでいる。未回答のまま残った
		// 質問（形式外の回答・割り込み等）は回答待ち扱いを解除し、赤表示が残らないようにする。
		if (signals.userText && this.pendingQuestions.size > 0) {
			this.discardPendingQuestions();
			activityChanged = true;
		}
		let infoChanged = false;
		if (signals.model !== undefined && signals.model !== this.model) {
			this.model = signals.model;
			infoChanged = true;
		}
		if (signals.effort !== undefined && signals.effort !== this.effort) {
			this.effort = signals.effort;
			infoChanged = true;
		}
		// 計測専用。モバイルへは送らないので infoChanged には含めない。
		if (signals.cliVersion !== undefined) {
			this.cliVersion = signals.cliVersion;
		}
		for (const sighting of signals.unknownSlashCommands ?? []) {
			this.unknownSlashCommands.push({ name: sighting.name, at: sighting.ts ?? Date.now() });
		}
		this.unknownSlashCommands.splice(0, Math.max(0, this.unknownSlashCommands.length - 20));
		if (activityChanged) {
			this.delegate.onActivity();
		}
		if (infoChanged) {
			this.delegate.onInfo();
		}
		if (signals.codexActivityTimeline.length > 0) { this.delegate.onCodexActivityTimeline(signals.codexActivityTimeline); }
		// 初回読み込み・読み直し（live でない）では知らせない。その後の snapshot が一覧を運ぶ。
		this.monitorWatch.apply(signals.monitorSignals, live, signals.shellSignals);
		// ターン終了はライブ追記でのみ通知する（初回読み込み・epoch読み直しの履歴に含まれる
		// 過去の task_complete で、現在進行中のライブ状態を消してしまわないように）。
		if (live && signals.turnEnded !== undefined) {
			this.delegate.onTurnEnded(signals.turnEnded, signals.turnErrorCode);
		}
		if (signals.turnEnded !== undefined) {
			this.approvalDeniedInTurn = false;
		}
	}
}

// ---- マネージャ ------------------------------------------------------------------------------

interface IPaneSessionInfo {
	readonly token: string;
	readonly agent: ParadisAgentKind;
	readonly transcriptPath: string;
	readonly sessionId: string | undefined;
	/**
	 * 前回の起動から永続化で引き継いだセッションか。この起動中に見つけた／hookで確定した
	 * ものと区別するために持つ。引き継ぎ分は、動いている証拠が付くまで外へ出さない。
	 */
	readonly restoredFromDisk?: boolean;
}

interface ICommandCatalogContext {
	readonly token: string;
	readonly session: IPaneSessionInfo;
	readonly owner: IParadisMobilePaneOwner;
	readonly cwd: string;
}

interface IAgentSubscriber {
	readonly owner: IParadisMobilePaneOwner;
	readonly liveEncoding: string | undefined;
}

/**
 * 「そのターミナルでエージェントが動いている」として外へ出すペインを決める。
 *
 * セッションを覚えていることと、いま動いていることは別。前回の起動で使ったセッションは
 * ディスクから復元されるので、覚えているだけを根拠にすると、**昨日終了したエージェントが
 * 翌日の一覧に並ぶ**。かといって「最近書き込みがあったか」で判断してもいけない。質問を
 * 出したまま30分待っているエージェントを落としてしまい、それを拾うことこそが主目的だから。
 *
 * そこで、この起動中に一度でも掴んだ「そのペインで動いている証拠」をラッチとして持ち、
 * 前回の起動から引き継いだだけのセッションは、証拠が付くまで出さない。
 */
export function paradisConfirmedAgentPaneTokens(
	confirmedTokens: Iterable<string>,
	liveTokens: Iterable<string>,
	restoredWithoutEvidence: ReadonlySet<string> = new Set(),
): readonly string[] {
	const live = new Set(liveTokens);
	return [...confirmedTokens].filter(token => live.has(token) && !restoredWithoutEvidence.has(token)).sort();
}

/**
 * agentチャネル本体。hookバスからペイン⇔transcriptの対応を学習し、モバイルの購読
 * (attach/detach) に応じて tailer を起動・停止する。tailer は購読者がいる間だけ動かし、
 * 誰も見ていないファイルの監視コストを避ける (再attach時はファイルから全量再構築)。
 */
export class ParadisMobileAgentChat extends Disposable {

	private readonly _onDidChangeConfirmedAgentPanes = this._register(new Emitter<{ readonly tokens: readonly string[]; readonly tokensOutsideHookReach: readonly string[] }>());
	readonly onDidChangeConfirmedAgentPanes = this._onDidChangeConfirmedAgentPanes.event;
	private lastConfirmedAgentPaneTokens: readonly string[] = [];
	private lastAgentPaneTokensOutsideHookReach: readonly string[] = [];

	// ---- デスクトップ UI 向けの読み取り口（モバイルへ送るものには一切影響しない） ----
	private readonly _onDidChangeDesktopPaneInsights = this._register(new Emitter<void>());
	/** どれかのペインの様子（サブエージェント・最後の発言・待っている内容・キャッシュ）が変わった。 */
	readonly onDidChangeDesktopPaneInsights = this._onDidChangeDesktopPaneInsights.event;
	/**
	 * hook から拾った「いま待っている内容」。モバイル向けの質問/承認の注入はペアリング済みの
	 * モバイルがあるときだけ動くため、デスクトップはそれに頼らず hook から直接覚えておく。
	 */
	private readonly desktopInteractions = new Map<string, IParadisAgentPaneInteraction>();
	/** tailer から作った待ち内容を最初に見た時刻（内容が変わるまで同じ時刻を返すため）。 */
	private readonly desktopTailerInteractionSeenAt = new Map<string, { readonly key: string; readonly at: number }>();
	/** 前回知らせた時点の様子の指紋。変わったペインがあるときだけ知らせる。 */
	private readonly desktopInsightSignatures = new Map<string, string>();
	private desktopInsightTimer: ReturnType<typeof setTimeout> | undefined;

	/** ペイントークン → 既知のセッション情報 (hookバスから学習、購読の有無に関わらず保持)。 */
	private readonly paneSessions = new Map<string, IPaneSessionInfo>();
	/** ペイントークン → transcript で見た最後のターンの終わり（通知の中身。失敗の理由。`notifyPaneContent`）。 */
	private readonly notifyTurnEnds = new Map<string, NonNullable<IParadisNotifyPaneContent['turnEnd']>>();
	/**
	 * tokenが一時的にliveでなくなった（renderer交代・ウィンドウ間移動・shared process再起動を
	 * またぐ再同期の隙間）ペインのセッション退避先。tokenが再びliveになった時点で検証して
	 * paneSessionsへ復活させる。即時破棄すると、リロードや再起動のたびに全ペインの
	 * エージェント確定が失われ、モバイルのホームからエージェントが消える。
	 */
	private readonly retiredSessions = new Map<string, { readonly session: IPaneSessionInfo; readonly retiredAt: number }>();
	private readonly sessionReviveInFlight = new Set<string>();
	private lastPersistedSessionSignature: string | undefined;
	private static readonly RETIRED_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
	/** transcriptPath → 所有ペイントークン。同一threadを複数ペインへ誤割当しない。 */
	private readonly transcriptClaims = new Map<string, string>();
	/** ターミナルinstanceId → ペイントークン (rendererから同期)。 */
	private readonly terminalToToken = new Map<number, string>();
	/** ペイントークン → ターミナルのcwd (rendererから同期。hook未発火時のセッション探索用)。 */
	private readonly tokenToCwd = new Map<string, string>();
	/** ペイントークン → workspace状態キー（通知タップ先の一意化用）。 */
	private readonly tokenToWorkspace = new Map<string, string>();
	/**
	 * ペイントークン → そのペインのエージェントが動いている接続先の印と、最後に届いた時刻
	 * （SSH 接続先の hook だけが名乗る）。
	 *
	 * 手元にあるのは接続先 transcript の写しだけで、設定ファイルもセッション置き場も向こうの
	 * ディスクにある。この印が付いているペインでは、cwd からの探索も手元の設定の読み出しも
	 * **やらない**（同じ絶対パスが両側に存在すると、手元のセッションや設定を接続先のものとして
	 * 見せてしまう。誤ったものを出すくらいなら出さない）。
	 */
	private readonly tokenToRemoteHost = new Map<string, { readonly host: string; readonly at: number }>();
	/**
	 * ペイントークン → 接続先の hook が最後に届いた時刻。ウィンドウが接続先の rollout を探して
	 * 知らせてくるもの（onRemoteTranscriptDiscovered）より hook を正とするための目印。
	 */
	private readonly remoteHookAt = new Map<string, number>();
	/** ペイントークン → 稼働中の tailer (購読者がいる間のみ)。 */
	private readonly tailers = new Map<string, TranscriptTailer>();
	/** ペイントークン → 購読中モバイルIDとattach時のexact owner。Renderer交代後は
	 * 新しいattachまで旧購読へdeltaを流さない。 */
	private readonly subscribers = new Map<string, Map<string, IAgentSubscriber>>();
	/** ペイントークン → transcript確定前の最新ライブ状態。履歴とは独立に置換する。 */
	private readonly liveStates = new Map<string, IParadisAgentLiveState>();
	/** ペイントークン → live state更新の単調増加revision。append欠落・逆順検出に使う。 */
	private readonly liveRevisions = new Map<string, number>();
	private readonly activityTrackers = new Map<string, ParadisAgentActivityTracker>();
	/** Claude SubagentStopが通知した子transcript（pane token + agent ID → 許可済みpath）。 */
	private readonly claudeSubagentTranscriptPaths = new Map<string, string>();
	/**
	 * Codex rollout path → root thread か SubAgent か。session_meta は書き出し後に
	 * 変わらないため、hookのたびに読み直さずここへ覚える（'unknown' は覚えない）。
	 */
	private readonly codexRolloutOrigins = new Map<string, ParadisCodexRolloutOrigin>();
	/** PreToolUse/PostToolUseの対応付け。並行ツールの古い完了で最新表示を消さないために使う。 */
	private readonly liveToolIds = new Map<string, string>();
	/** Claude MessageDisplayの行バッチをメッセージ単位で連結する内部バッファ。 */
	private readonly liveMessageBuffers = new Map<string, { messageId: string; lastIndex: number; text: string; startedAt: number; final: boolean }>();
	/**
	 * ターンが終了した時刻（hook の at）。遅れて届いた MessageDisplay で live 状態を
	 * 蘇生させないためのガードに使う。SubAgent活動側の「終了済みは蘇生させない」規約と対。
	 */
	private readonly lastTurnEndedAt = new Map<string, number>();
	/** Codex daemonのagentMessage deltaをitem単位で連結する内部バッファ。 */
	private readonly codexMessageBuffers = new Map<string, { itemId: string; text: string; startedAt: number }>();
	/** Codex daemonで現在表示中のitem ID。古いitem/completedによる巻き戻しを防ぐ。 */
	private readonly codexActiveItems = new Map<string, string>();
	/** main agentがターン処理中のtoken。Claude hook / Codex app-serverの開始・終了で更新する。 */
	private readonly activeTurnTokens = new Set<string>();
	/** tokenごとにhookの検証と反映を受信順へ直列化する。 */
	private readonly hookProcessing = new Map<string, Promise<void>>();
	/** ペイン同期より先着したhook。質問など一度しか来ないイベントを順序付きで保持する。 */
	private readonly pendingHooks = new Map<string, { readonly event: IParadisAgentHookEvent; readonly transcriptPath: string; readonly receivedAt: number }[]>();
	private readonly pendingHookTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** ペアリング済みモバイル向けのライブ質問/承認注入を有効にする。status用tailは常時動作する。 */
	private eagerTailing = false;
	private readonly pendingActions = new Map<string, { readonly mobileId: string; readonly token: string; readonly epoch: string; readonly terminalId: number; readonly windowId: number; readonly windowSession: string; readonly interaction?: IParadisAgentInteraction; readonly interactionKey?: string; readonly requirePrompt?: boolean; readonly sendKey?: string; readonly timer: ReturnType<typeof setTimeout> }>();
	private readonly completedActions = new Map<string, { readonly token: string; readonly epoch: string; readonly terminalId: number; readonly windowId: number; readonly windowSession: string; readonly interaction?: IParadisAgentInteraction; readonly interactionKey?: string; readonly requirePrompt?: boolean; readonly timer: ReturnType<typeof setTimeout> }>();
	private readonly interactionClaims = new Map<string, string>();
	/** 計測専用: `token\0questionGroup` → その質問グループで通知を送った回数。 */
	private readonly questionNotifyCounts = new Map<string, number>();
	/**
	 * 実際に通知を出した群キー・内容キー → その時刻。重複通知の抑制に使う（計測専用ではない）。
	 *
	 * キーが2種類あるのは、重複が2つの別々の理由で起きるため。1つの AskUserQuestion に質問が
	 * N問あればN回鳴る（群キーで止まる）のに加え、同じ質問が live（hook由来）と transcript
	 * （記録由来）の両経路で浮上する。後者は `questionGroup` の名前空間が経路ごとに違う
	 * （transcript は toolUseId、live は `liveg:` 合成キー）ので、**群キーでは同一視できない**。
	 *
	 * ディスクへは残さない。再起動後に「通知済み」と誤判定して一度も鳴らないほうが、
	 * 重複して鳴るより明らかに害が大きい。
	 */
	private readonly questionNotifiedAt = new Map<string, number>();
	/**
	 * 計測専用: `token\0interactionId` → その質問が最初に浮上した時刻。
	 *
	 * **レース説と「操作が遅れて届いた」を切り分ける唯一の材料。** TUI は質問を描いてから
	 * 選択肢リストがフォーカスを取るまでに隙間があり、そこへ打鍵が届くと入力欄へ吸われて消える。
	 * ただしユーザーが通知を見てタップするのは普通は数十秒〜数分後で、原理的にその窓の外になる。
	 * どちらが本番の不成立を説明するのかは、この経過時間を回答の結果と突き合わせないと決まらない。
	 */
	private readonly questionFirstSeenAt = new Map<string, number>();
	/** 計測専用: キー注入後に質問が消えたかを確かめる遅延チェック。 */
	private readonly questionSettleTimers = new Set<ReturnType<typeof setTimeout>>();
	private readonly activityDetailRequests = new Map<string, string>();
	/** 記録ファイルから古い発言を読んでいるペイン（1 ペインで同時に 1 本。W2-30）。 */
	private readonly historyReads = new Set<string>();
	/** バックグラウンドのシェルの出力を読んでいるペイン（1 ペインで同時に 1 本。agent.shells.v1）。 */
	private readonly shellOutputReads = new Set<string>();
	/** 最後に送った `shellsAccess`（mod の生き死にで変わったら送り直す）。 */
	private readonly shellsAccessSent = new Map<string, string>();
	/** 送信中の 'tool-image': `mobileId\0requestId` → token。1件あたり数MBのため同時数を抑える。 */
	private readonly toolImageRequests = new Map<string, string>();
	private readonly persistedActivityTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Stateがpane snapshotより先着したattachを、対応表の同期完了まで短時間だけ保留する。 */
	private readonly pendingAttaches = new Map<string, { readonly mobileId: string; readonly msg: { id: number; token?: string; epoch?: string; afterRev?: number; liveEncoding?: string }; readonly timer: ReturnType<typeof setTimeout>; attempt: number }>();
	private readonly attachGenerations = new Map<string, number>();
	private attachGenerationCounter = 0;
	private attachDisposed = false;

	constructor(
		private readonly send: (mobileId: string, payload: Uint8Array) => void,
		private readonly requestAction: (mobileId: string, windowId: number, windowSession: string, rendererGeneration: number, payload: Uint8Array) => void,
		/** 質問(AskUserQuestion等)がtranscriptに現れた（回答待ちが始まった）。通知の発火元。 */
		private readonly onQuestion: (info: { terminalId: number; agent: ParadisAgentKind; text: string; ws?: string; agentToken: string; owner: IParadisMobilePaneOwner }) => void,
		private readonly logService: ILogService,
		private readonly authorizeOwner: (owner: IParadisMobilePaneOwner) => Promise<boolean> = async () => true,
		private readonly requestPaneSync: (owner: IParadisMobilePaneOwner) => void = () => { },
		private readonly sessionStore?: ParadisAgentSessionStore,
		/** SSH 接続先の transcript を手元へ写す台帳。無ければ接続先の会話は読まないだけ。 */
		private readonly remoteTranscriptMirror?: ParadisRemoteTranscriptMirrorStore,
		codexDirectoryWalkBudget?: IParadisDirectoryWalkBudget,
		/** Claude Code の mod（Claude Mods）の受け口。テストは自前のものを渡す。 */
		private readonly claudeModBridge: ParadisClaudeModBridge = paradisClaudeModBridge,
		/** mod へ渡した回答の鍵（同じカードへの二度目を断る時間）に使う時計。テストは差し替える。 */
		private readonly modAnswerNow: () => number = Date.now,
	) {
		super();
		this.codexDirectoryWalkLedger = codexDirectoryWalkBudget ?? new ParadisDirectoryWalkLedger(PARADIS_CODEX_DIRECTORY_WALK_INTERVAL_MS, PARADIS_CODEX_DIRECTORY_WALK_LIMIT);
		this._register(this.claudeModBridge.onEvent(event => this.onModEvent(event)));
		this._register(toDisposable(() => clearTimeout(this.desktopInsightTimer)));
		this._register(toDisposable(() => clearTimeout(this.desktopChatTimer)));
		this._register(toDisposable(() => {
			for (const timer of this.desktopClaimTimers) {
				clearTimeout(timer);
			}
			this.desktopClaimTimers.clear();
		}));
		this._register(onParadisAgentHookEvent(event => this.onHookEvent(event)));
		void this.loadPersistedSessions();
		this._register(onParadisAgentNestedHookEvent(event => this.onNestedHookEvent(event)));
		const activitySweepTimer = setInterval(() => {
			void this.sweepAgentActivity();
			// ペインが消えた接続先 transcript は追いかけない（消えても次のhookでまた載る）。
			this.remoteTranscriptMirror?.retainLiveTokens(token => this.isLiveToken(token));
		}, 60_000);
		this._register(toDisposable(() => clearInterval(activitySweepTimer)));
		const sessionScanTimer = setInterval(() => {
			void this.scanPanesForUnclaimedSessions();
		}, PARADIS_SESSION_SCAN_INTERVAL_MS);
		this._register(toDisposable(() => clearInterval(sessionScanTimer)));
		this._register(toDisposable(() => {
			this.attachDisposed = true;
			this.attachGenerations.clear();
			for (const pending of this.pendingAttaches.values()) {
				clearTimeout(pending.timer);
			}
			this.pendingAttaches.clear();
			for (const token of [...this.tailers.keys()]) {
				this.disposeTailer(token);
			}
			for (const timers of this.cliDiscoveryTimers.values()) {
				for (const timer of timers) {
					clearTimeout(timer);
				}
			}
			this.cliDiscoveryTimers.clear();
			for (const timer of this.cliReconciliationTimers.values()) { clearInterval(timer); }
			this.cliReconciliationTimers.clear();
			this.cliReconciliationWatermarks.clear();
			this.hookTranscriptSightings.clear();
			this.attachProjectScans.clear();
			for (const timer of this.pendingHookTimers.values()) {
				clearTimeout(timer);
			}
			this.pendingHookTimers.clear();
			this.pendingHooks.clear();
			this.hookProcessing.clear();
			for (const pending of this.pendingActions.values()) {
				clearTimeout(pending.timer);
			}
			this.pendingActions.clear();
			for (const completed of this.completedActions.values()) {
				clearTimeout(completed.timer);
			}
			this.completedActions.clear();
			this.interactionClaims.clear();
			this.activityDetailRequests.clear();
			this.toolImageRequests.clear();
			for (const timer of this.persistedActivityTimers.values()) { clearTimeout(timer); }
			this.persistedActivityTimers.clear();
			for (const timer of this.questionSettleTimers) { clearTimeout(timer); }
			this.questionSettleTimers.clear();
			this.questionNotifyCounts.clear();
			this.questionNotifiedAt.clear();
		}));
	}

	/**
	 * hookまたは鮮度検証済みtranscript探索で、実在するエージェントセッションとの対応が
	 * 確定したペイントークン。単なる `claude` / `codex` コマンド検知は含めない。
	 */
	getConfirmedAgentPaneTokens(): readonly string[] {
		return this.confirmedAgentPaneTokens();
	}

	ownerOfPaneToken(token: string): IParadisMobilePaneOwner | undefined {
		return this.paneRegistry.ownerOf(token);
	}

	ownershipOfPaneToken(token: string): ParadisMobilePaneOwnership {
		return this.paneRegistry.ownershipOf(token);
	}

	/** rendererがPTY画面からbest-effort抽出した装飾情報を、既存ライブ状態へだけ合成する。 */
	onTerminalHint(windowId: number, windowSession: string, rendererGeneration: number, terminalId: number, hint: { readonly elapsedSeconds?: number; readonly tokenCount?: number }): void {
		const exactOwner = this.paneRegistry.ownerOfTerminal(windowId, windowSession, rendererGeneration, terminalId);
		const tokenOwner = exactOwner !== undefined ? this.paneRegistry.ownerOf(exactOwner.token, terminalId) : undefined;
		const token = exactOwner !== undefined && tokenOwner !== undefined && this.samePaneOwner(exactOwner, tokenOwner) ? exactOwner.token : undefined;
		const previous = token !== undefined ? this.liveStates.get(token) : undefined;
		if (token === undefined || previous === undefined) {
			return; // PTY文字列だけでエージェント起動を確定しない
		}
		const now = Date.now();
		this.setLiveState(token, {
			...previous,
			...(hint.elapsedSeconds !== undefined ? { startedAt: now - hint.elapsedSeconds * 1000 } : {}),
			updatedAt: now,
			...(hint.elapsedSeconds !== undefined ? { elapsedSeconds: hint.elapsedSeconds } : {}),
			...(hint.tokenCount !== undefined ? { tokenCount: hint.tokenCount } : {}),
		});
	}

	/**
	 * ペアリング済みモバイル向けのライブ質問/承認注入を切り替える。CodexのStopなし終了を
	 * 検出するstatus用tailerはモバイル接続から独立しているため、無効化しても停止しない。
	 */
	setEagerTailing(enabled: boolean): void {
		if (this.eagerTailing === enabled) {
			return;
		}
		this.eagerTailing = enabled;
		if (enabled) {
			for (const [token, session] of this.paneSessions) {
				if (this.terminalIdForToken(token) !== undefined) {
					this.ensureTailer(token, session);
				}
			}
			for (const tailer of this.tailers.values()) {
				tailer.promoteDesktopOnly();
			}
		}
	}

	private readonly paneRegistry = new ParadisMobilePaneRegistry();
	/** mobileId + requestId → 対象ペイン。設定ファイル走査の重複と濫用を抑止する。 */
	private readonly commandCatalogRequests = new Map<string, string>();
	/** ペインごとのスラッシュコマンドの一覧（{@link agentCommandCatalog}）。 */
	private readonly commandCatalogCache = new Map<string, { readonly at: number; readonly promise: Promise<readonly IParadisAgentCommandOption[]> }>();

	/**
	 * renderer から同期される「ターミナルinstanceId ⇔ ペイントークン」対応表。
	 *
	 * shared process は全ウィンドウで共有されるため、全体を置換すると別ウィンドウの登録が
	 * 消え、そのウィンドウのペインの tailer (fs.watch + ポーリング) が同期のたびに破棄/再生成
	 * を繰り返してしまう。windowId 単位で置換し、全ウィンドウ分をマージして対応表を再構築する。
	 * terminalId (instanceId) はウィンドウ内でしか一意でないため、ウィンドウ間で衝突したIDは
	 * attach/controlの解決対象から外す。ペイントークンはUUIDなので確定状態の同期には使える。
	 * 空配列も「生存中だがペインがない」状態として保持する。ウィンドウの破棄は
	 * removePanesでsession一致を確認してから削除する。
	 */
	syncPanes(windowId: number, windowSession: string, rendererGeneration: number, revision: number, entries: readonly { terminalId: number; token: string; cwd?: string; ws?: string }[]): boolean {
		if (!this.paneRegistry.syncWindow(windowId, windowSession, rendererGeneration, revision, entries)) {
			return false;
		}
		this.rebuildPaneMappings();
		for (const pending of [...this.pendingAttaches.values()]) {
			this.handleAttach(pending.mobileId, pending.msg, true).catch(err => this.logService.warn('[paradisAgentChat] deferred attach failed', err));
		}
		return true;
	}

	removePanes(windowId: number, windowSession: string, rendererGeneration: number): void {
		if (!this.paneRegistry.removeWindow(windowId, windowSession, rendererGeneration)) {
			return;
		}
		this.rebuildPaneMappings();
	}

	/** Renderer交代時に、そのexact ownerへ配送済みのAction/interaction claimを即時解放する。 */
	removeOwnerActions(windowId: number, windowSession: string, _rendererGeneration: number): void {
		const pendingTombstones = new Set<string>();
		for (const [key, pending] of [...this.pendingActions]) {
			if (pending.windowId !== windowId || pending.windowSession !== windowSession) {
				continue;
			}
			clearTimeout(pending.timer);
			this.pendingActions.delete(key);
			this.releaseInteractionClaim(pending.interactionKey, key);
			const tombstoneTimer = setTimeout(() => this.completedActions.delete(key), 60_000);
			this.completedActions.set(key, {
				token: pending.token,
				epoch: pending.epoch,
				terminalId: pending.terminalId,
				windowId: pending.windowId,
				windowSession: pending.windowSession,
				...(pending.interaction !== undefined ? { interaction: pending.interaction } : {}),
				...(pending.interactionKey !== undefined ? { interactionKey: pending.interactionKey } : {}),
				...(pending.requirePrompt === true ? { requirePrompt: true } : {}),
				timer: tombstoneTimer,
			});
			pendingTombstones.add(key);
			const requestId = key.slice(key.indexOf('\0') + 1);
			this.sendTo(pending.mobileId, { t: 'action-result', id: pending.terminalId, requestId, status: 'rejected', code: 'outcome-unknown', message: 'PCウィンドウが再起動したため操作結果を確認できません' }, pending.token);
		}
		for (const [key, completed] of [...this.completedActions]) {
			if (pendingTombstones.has(key) || completed.windowId !== windowId || completed.windowSession !== windowSession) {
				continue;
			}
			this.releaseInteractionClaim(completed.interactionKey, key);
			const separator = key.indexOf('\0');
			const mobileId = key.slice(0, separator);
			const requestId = key.slice(separator + 1);
			this.sendTo(mobileId, { t: 'action-result', id: completed.terminalId, requestId, status: 'rejected', code: 'outcome-unknown', message: 'PCウィンドウが再起動したため操作結果を確認できません' }, completed.token);
		}
	}

	private rebuildPaneMappings(): void {
		const entries = this.paneRegistry.allEntries();
		const nextCwds = paradisMergeLivePaneMetadata(this.tokenToCwd, entries, 'cwd');
		const nextWorkspaces = paradisMergeLivePaneMetadata(this.tokenToWorkspace, entries, 'ws');
		this.terminalToToken.clear();
		this.tokenToCwd.clear();
		this.tokenToWorkspace.clear();
		const ambiguousTerminalIds = new Set<number>();
		for (const entry of entries) {
			if (typeof entry.terminalId === 'number' && typeof entry.token === 'string' && entry.token.length > 0) {
				const previous = this.terminalToToken.get(entry.terminalId);
				if (previous !== undefined && previous !== entry.token) {
					ambiguousTerminalIds.add(entry.terminalId);
					this.terminalToToken.delete(entry.terminalId);
				} else if (!ambiguousTerminalIds.has(entry.terminalId)) {
					this.terminalToToken.set(entry.terminalId, entry.token);
				}
			}
		}
		for (const [token, cwd] of nextCwds) {
			this.tokenToCwd.set(token, cwd);
		}
		for (const [token, workspace] of nextWorkspaces) {
			this.tokenToWorkspace.set(token, workspace);
		}
		// セッションは判明済みだが terminalId 対応が今届いたペインの常時tailを開始する
		// （hookが先・ペイン同期が後の順で来るケース）。
		for (const [token, session] of this.paneSessions) {
			if (this.terminalIdForToken(token) !== undefined && !this.tailers.has(token)) {
				this.ensureTailer(token, session);
			}
		}
		// 消えたターミナル（PC側でclose等）の購読・tailerを掃除する。detachは
		// terminalId→token解決に依存するため、ここで拾わないとtailerがリークする。
		const liveTokens = this.allLiveTokens();
		const now = Date.now();
		for (const [token, pending] of [...this.pendingHooks]) {
			const fresh = pending.filter(entry => now - entry.receivedAt <= PENDING_HOOK_TTL_MS);
			if (fresh.length === 0) {
				this.pendingHooks.delete(token);
				const timer = this.pendingHookTimers.get(token);
				if (timer !== undefined) {
					clearTimeout(timer);
					this.pendingHookTimers.delete(token);
				}
				continue;
			}
			if (fresh.length !== pending.length) {
				this.pendingHooks.set(token, fresh);
			}
			if (liveTokens.has(token)) {
				this.pendingHooks.delete(token);
				const timer = this.pendingHookTimers.get(token);
				if (timer !== undefined) {
					clearTimeout(timer);
					this.pendingHookTimers.delete(token);
				}
				for (const entry of fresh) {
					this.enqueueHookEvent(entry.event, entry.transcriptPath, true);
				}
			}
		}
		for (const token of [...this.subscribers.keys()]) {
			if (!liveTokens.has(token)) {
				this.subscribers.delete(token);
			}
		}
		for (const token of [...this.tailers.keys()]) {
			if (!liveTokens.has(token)) {
				this.disposeTailer(token);
			}
		}
		for (const [token, timers] of [...this.cliDiscoveryTimers]) {
			if (!liveTokens.has(token)) {
				for (const timer of timers) {
					clearTimeout(timer);
				}
				this.cliDiscoveryTimers.delete(token);
				this.cliDiscoveryGenerations.delete(token);
			}
		}
		for (const token of [...this.cliReconciliationTimers.keys()]) {
			if (!liveTokens.has(token)) { this.onCliCommandFinished(token, 'pane-gone'); this.cliDiscoveryGenerations.delete(token); }
		}
		// paneSessions も掃除する（放置するとclose済みターミナルのセッション情報が単調増加する）。
		// ただし即時破棄はしない: renderer交代・ウィンドウ間移動・再起動後の再同期では、tokenが
		// 「一時的にliveでない」だけの隙間が必ずできる。ここで破棄するとリロードのたびに全ペインの
		// エージェント確定が失われるため、retiredSessionsへ退避し、tokenが再びliveになった時点で
		// 復活させる（TTL経過分はloadPersistedSessions/persistSessions側で失効する）。
		for (const token of [...this.paneSessions.keys()]) {
			if (!liveTokens.has(token)) {
				const removed = this.paneSessions.get(token);
				this.paneSessions.delete(token);
				if (removed !== undefined) {
					this.retiredSessions.set(token, { session: removed, retiredAt: Date.now() });
					if (this.transcriptClaims.get(removed.transcriptPath) === token) {
						this.transcriptClaims.delete(removed.transcriptPath);
					}
				}
				this.liveStates.delete(token);
				this.liveRevisions.delete(token);
				this.liveToolIds.delete(token);
				this.liveMessageBuffers.delete(token);
				this.lastTurnEndedAt.delete(token);
				this.codexMessageBuffers.delete(token);
				this.codexActiveItems.delete(token);
				this.activityTrackers.delete(token);
				this.pendingSubagentCalls.delete(token);
				this.advisorLiveIds.delete(token);
				this.clearClaudeSubagentTranscripts(token);
				this.activeTurnTokens.delete(token);
			}
		}
		// ツール呼び出しの追跡は終了 hook / SessionStart でしか消えないので、それが届かずにペインが消えると
		// 入力の指紋ごと残り続ける。リロードの隙間で退避に載ったばかりのペインだけは、復活後に replay される
		// PermissionRequest を元の tool_use_id へ結び付けられるよう、保留中の hook と同じ猶予だけ残す
		// （live でない間は hook が保留に積まれるだけなので、猶予中にここが増えることはない）。
		for (const token of new Set([...this.openToolUses.keys(), ...this.syntheticApprovalWaits.keys(), ...this.liveBeforePermission.keys()])) {
			const retired = this.retiredSessions.get(token);
			if (!liveTokens.has(token) && !(retired !== undefined && now - retired.retiredAt <= PENDING_HOOK_TTL_MS)) {
				this.openToolUses.delete(token);
				this.syntheticApprovalWaits.delete(token);
				this.liveBeforePermission.delete(token);
			}
		}
		// 接続先の印は、ウィンドウのリロードでtokenが一瞬liveでなくなる隙間では捨てない
		// （捨てると復活したペインが「手元のもの」に戻り、次のhookが来るまでの間だけ手元の
		// セッションや設定を探しに行ってしまう）。セッションが確定していれば退避に載るのでそれを
		// 根拠にできるが、hookは来たがtranscriptがまだ無いペインはどこにも載らないため、
		// 直近に印が届いていたものも残す。
		for (const [token, remote] of [...this.tokenToRemoteHost]) {
			if (!liveTokens.has(token) && !this.retiredSessions.has(token) && now - remote.at > PENDING_HOOK_TTL_MS) {
				this.tokenToRemoteHost.delete(token);
				this.remoteHookAt.delete(token);
			}
		}
		// 常駐スキャンは世代の記録だけを残すことがある（セッションもタイマーも持たないので、
		// 他の掃除ループのどれにも掛からない）。CLIを一度も起動しない普通のターミナルのぶんが
		// 際限なく積もらないよう、生きているtokenだけに揃える。
		for (const token of [...this.cliDiscoveryGenerations.keys()]) {
			if (!liveTokens.has(token)) {
				this.cliDiscoveryGenerations.delete(token);
				this.cliReconciliationWatermarks.delete(token);
			}
		}
		for (const token of [...this.cliCodexForkRequests.keys()]) {
			if (!liveTokens.has(token)) {
				this.cliCodexForkRequests.delete(token);
			}
		}
		this.hookTranscriptSightings.forgetRootsExcept(token => liveTokens.has(token) || this.retiredSessions.has(token));
		for (const token of [...this.attachProjectScans.keys()]) {
			if (!liveTokens.has(token)) {
				this.attachProjectScans.delete(token);
			}
		}
		for (const token of liveTokens) {
			if (!this.paneSessions.has(token) && this.retiredSessions.has(token)) {
				this.reviveRetiredSession(token);
			}
		}
		this.persistSessions();
		this.emitConfirmedAgentPanesIfChanged();
	}

	/** 前回起動時に確定していたセッション対応表を読み込み、liveなペインへ復活を試みる。 */
	private async loadPersistedSessions(): Promise<void> {
		if (this.sessionStore === undefined) {
			return;
		}
		try {
			const entries = await this.sessionStore.load();
			if (this.attachDisposed) {
				return;
			}
			for (const entry of entries) {
				if (this.paneSessions.has(entry.token) || this.retiredSessions.has(entry.token)) {
					continue;
				}
				this.retiredSessions.set(entry.token, {
					session: { token: entry.token, agent: entry.agent, transcriptPath: entry.transcriptPath, sessionId: entry.sessionId, restoredFromDisk: true },
					retiredAt: entry.savedAt,
				});
			}
			for (const token of [...this.retiredSessions.keys()]) {
				if (this.isLiveToken(token) && !this.paneSessions.has(token)) {
					this.reviveRetiredSession(token);
				}
			}
		} catch (err) {
			this.logService.warn('[paradisAgentChat] failed to load persisted agent sessions', err);
		}
	}

	/** paneSessions + 退避分をまとめて永続化する（storeが未設定なら何もしない）。 */
	private persistSessions(): void {
		if (this.sessionStore === undefined) {
			return;
		}
		const now = Date.now();
		for (const [token, entry] of [...this.retiredSessions]) {
			if (now - entry.retiredAt > ParadisMobileAgentChat.RETIRED_SESSION_TTL_MS) {
				this.retiredSessions.delete(token);
			}
		}
		// pane syncのたびに呼ばれるため、対応表の実内容が変わった時だけ書き出す。
		const signature = [
			...[...this.paneSessions.values()].map(session => `${session.token}\u0000${session.agent}\u0000${session.transcriptPath}\u0000${session.sessionId ?? ''}`),
			...[...this.retiredSessions.values()].map(({ session }) => `${session.token}\u0000${session.agent}\u0000${session.transcriptPath}\u0000${session.sessionId ?? ''}\u0000retired`),
		].sort().join('\n');
		if (signature === this.lastPersistedSessionSignature) {
			return;
		}
		this.lastPersistedSessionSignature = signature;
		this.sessionStore.persist([
			...[...this.paneSessions.values()].map(session => ({
				token: session.token, agent: session.agent, transcriptPath: session.transcriptPath,
				...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
				savedAt: now,
			})),
			...[...this.retiredSessions.values()].map(({ session, retiredAt }) => ({
				token: session.token, agent: session.agent, transcriptPath: session.transcriptPath,
				...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
				savedAt: retiredAt,
			})),
		]);
	}

	/** 退避済みセッションを、tokenが再びliveになったペインへ検証付きで復活させる。 */
	private reviveRetiredSession(token: string): void {
		if (this.sessionReviveInFlight.has(token)) {
			return;
		}
		const entry = this.retiredSessions.get(token);
		if (entry === undefined || this.paneSessions.has(token) || !this.isLiveToken(token)) {
			return;
		}
		this.sessionReviveInFlight.add(token);
		(async () => {
			try {
				const session = entry.session;
				// 退避の取り消しは、どちらも「消してよいと確かめられたとき」だけにする。
				// 判定できなかっただけで捨てると、次のペイン同期で復活を試す機会ごと失う。
				// WSL のホームは PC 起動直後やディストロ停止中に一時的に届かなくなるので、
				// 「届かない」を「消えた」と読むと、会話が丸ごと恒久的に失われる。
				if (!(await isAllowedTranscriptPath(session.transcriptPath))) {
					return;
				}
				const stat = await fs.stat(session.transcriptPath).catch((error: NodeJS.ErrnoException) => error);
				if (stat instanceof Error) {
					if (stat.code === 'ENOENT' || stat.code === 'ENOTDIR') {
						this.retiredSessions.delete(token); // 本当に無い
					}
					return;
				}
				if (!stat.isFile()) {
					this.retiredSessions.delete(token);
					return;
				}
				// await中にhook・探索・別ペインのclaimが先行していたら復活しない（強い証拠を優先）。
				if (this.attachDisposed || this.paneSessions.has(token) || !this.isLiveToken(token)
					|| this.retiredSessions.get(token) !== entry
					|| this.transcriptClaimedByOther(session.transcriptPath, token)) {
					return;
				}
				this.retiredSessions.delete(token);
				this.paneSessions.set(token, session);
				this.transcriptClaims.set(session.transcriptPath, token);
				this.persistSessions();
				this.ensureEagerTailer(token, session);
				this.emitConfirmedAgentPanesIfChanged();
				this.pushToSubscribers(token);
			} finally {
				this.sessionReviveInFlight.delete(token);
			}
		})().catch(err => this.logService.warn('[paradisAgentChat] agent session revive failed', err));
	}

	/** コマンド検知トリガーの再探索タイマー (dispose時に確実に止める)。 */
	private readonly cliDiscoveryTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
	private readonly cliDiscoveryGenerations = new Map<string, number>();
	private readonly cliReconciliationTimers = new Map<string, ReturnType<typeof setInterval>>();
	private readonly cliReconciliationWatermarks = new Map<string, number>();
	/** hook で見た transcript。ほかのペインの照合で採らないために覚える。 */
	private readonly hookTranscriptSightings = new ParadisHookTranscriptSightings();
	/**
	 * ペインで打った `codex fork [X]`。fork 先が見つかって結ばれるまで（または CLI が終わるまで）持つ。
	 * 照合はこれを見て、fork 先をコマンドを打ったペインにだけ結ぶ（{@link codexForkPolicyFor}）。
	 */
	private readonly cliCodexForkRequests = new Map<string, ParadisCodexForkRequest>();
	/**
	 * `claude attach <id>` で全作業フォルダを見て一致があった結果。同じ起動（世代）の再試行では使い回す
	 * （再試行は 4 回あり、毎回 `~/.claude/projects` 全体を読むと重い）。
	 */
	private readonly attachProjectScans = new Map<string, { readonly generation: number; readonly idPrefix: string; readonly result: readonly IParadisClaudeTranscriptPrefixMatch[] }>();

	/**
	 * ターミナルで `claude` / `codex` コマンドの実行開始を検知した (shell integration 由来)。
	 * これ自体を「エージェント起動」とはみなさず、cwd ベースのセッション探索を前倒しする
	 * トリガーとしてのみ使う。transcript / rollout の作成はコマンド起動から数秒遅れるため、
	 * 少し待って数回試す。鮮度ガード (コマンド開始時刻より新しい更新のみ受理) により、
	 * `claude --help` のような空振りで古いセッションを掴む誤検知は起きない。
	 */
	onCliCommandDetected(token: string, agent: ParadisAgentKind, mode: ParadisCliDiscoveryMode, cwd: string | undefined, commandCwd?: string, sessionId?: string): void {
		if (!this.isLiveToken(token)) {
			return;
		}
		// このターミナルでエージェントCLIが起動したのを実際に見た。前回から引き継いだ
		// セッションであっても、これで「今このペインで動いている」と言い切れる。
		this.rememberAgentEvidence(token);
		const baseCwd = cwd ?? this.tokenToCwd.get(token);
		const effectiveCwd = commandCwd !== undefined && baseCwd !== undefined ? resolve(baseCwd, commandCwd) : baseCwd;
		if (effectiveCwd === undefined) {
			return;
		}
		this.tokenToCwd.set(token, effectiveCwd);
		this.cancelCliDiscovery(token);
		// `codex fork X` の X は元の会話で、このペインの会話ではない（X を完全一致で結ぶと、元のペインの
		// 会話を奪う）。X は「fork 先を探す手がかり」として控え、探索は forked_from_id が X の新しい thread を採る。
		this.cliCodexForkRequests.delete(token);
		let requestedSessionId = sessionId;
		if (agent === 'codex' && mode === 'fork') {
			// id が無い（`codex fork`・`--last`）なら元は問わない。id が形に合わないなら元は分からないので、
			// fork 先は照合では結ばず hook に任せる
			this.cliCodexForkRequests.set(token, sessionId === undefined ? { kind: 'any' }
				: PARADIS_CODEX_THREAD_ID_PATTERN.test(sessionId) ? { kind: 'parent', parentId: sessionId } : { kind: 'unknown' });
			requestedSessionId = undefined;
		}
		const generation = (this.cliDiscoveryGenerations.get(token) ?? 0) + 1;
		this.cliDiscoveryGenerations.set(token, generation);
		// resume 直後は既存transcriptへの追記になるため、開始時刻より少し手前まで許容する。
		const minMtime = Date.now() - 15_000;
		this.cliReconciliationWatermarks.set(token, minMtime);
		const previousReconciliation = this.cliReconciliationTimers.get(token);
		if (previousReconciliation !== undefined) {
			clearInterval(previousReconciliation);
			this.cliReconciliationTimers.delete(token);
		}
		if (mode === 'attach') {
			// `claude attach <id>`: 会話は daemon の配下で動いていて、このペインには hook が来ない。どの会話かは
			// id でしか決まらないので、作業フォルダからは探さない（同じフォルダの元の会話や別の分岐先を掴む）。
			// attach 中の会話の切り替え（agent view からの選び直し）も hook が無いので追えない。照合も始めない
			// （daemon の会話は照合の候補に入らないので、張り替え先は誤りにしかならない）。
			if (agent !== 'claude' || sessionId === undefined) {
				return;
			}
			for (const delayMs of [500, 2_000, 6_000, 15_000]) {
				this.scheduleCliDiscovery(token, generation, delayMs, () => this.discoverAndNotify(token, agent, mode, effectiveCwd, undefined, generation, sessionId));
			}
			return;
		}
		// 共有daemonは起動済みthreadのrollout初回flushが遅れることがあるため、短い即時探索に
		// 加えて30秒・60秒でも再確認する。鮮度ガードは維持されるので、待機を延ばしても
		// コマンド開始前の古いセッションを誤って拾うことはない。
		for (const delayMs of [2_000, 6_000, 15_000, 30_000, 60_000]) {
			this.scheduleCliDiscovery(token, generation, delayMs, () => this.discoverAndNotify(token, agent, mode, effectiveCwd, minMtime, generation, requestedSessionId));
		}
		// TUI内の /resume はshell commandを再発火しない。hookが無い環境でも、CLIが
		// 実行中の間だけroot threadの一意な更新を追跡してsession切替を検出する。
		// hook が届くペインでも続ける（Codex の TUI の /resume は SessionStart を出さないことがある）。
		// `/fork` の分岐先は、sessionKind: "bg" と hook の控え（daemon の会話・ほかのペインの会話・子エージェント）の
		// 両方で候補から外れるので、照合が元の会話と分岐先を行き来することはない。
		// Codex の `/fork` の分岐先は同じペインで動く（TUI が分岐先へ切り替わる）。照合は forked_from_id が
		// このペインの今の会話と一致する分岐先だけを採り、ほかのペインの照合からは外す（codexForkPolicyFor）。
		const reconciliation = setInterval(() => {
			if (this.cliDiscoveryGenerations.get(token) !== generation || !this.isLiveToken(token)) { return; }
			const watermark = this.cliReconciliationWatermarks.get(token) ?? minMtime;
			this.discoverAndNotify(token, agent, 'resume', effectiveCwd, watermark, generation)
				.catch(err => this.logService.warn('[paradisAgentChat] cli session reconciliation failed', err));
		}, 5_000);
		this.cliReconciliationTimers.set(token, reconciliation);
	}

	/**
	 * @param reason `exited` はシェルが CLI の終了を知らせた（Ctrl+C・異常終了も含む）。答える相手が居ないので、
	 * 許可待ち・質問中も解き、承認・質問のカードと claim も外す。`suspended`（Ctrl+Z で止めただけ。`fg` で戻る）と
	 * `pane-gone`（リロード等でペインの一覧から一時的に消えただけ）は、まだ答えを待っている CLI かもしれないので
	 * ターン終了だけを知らせ、許可待ち・質問中とカードは残す
	 */
	onCliCommandFinished(token: string, reason: 'exited' | 'suspended' | 'pane-gone' = 'exited'): void {
		this.cancelCliDiscovery(token);
		this.cliDiscoveryGenerations.set(token, (this.cliDiscoveryGenerations.get(token) ?? 0) + 1);
		this.activeTurnTokens.delete(token);
		if (reason === 'exited') {
			// 先にペインの状態を許可待ち・質問中から idle へ移してからカードを外す。逆にすると、カードが外れた
			// 知らせ（pendingApproval の解除）でペインが「答えた」とみなされ working へ戻り、続くターン終了で
			// 確認待ち（review）になって完了の通知が鳴る。
			fireParadisAgentTurnEnded(token, 'cli-exit');
			const tailer = this.tailers.get(token);
			tailer?.clearApprovalRequest(undefined, true, true);
			tailer?.clearPendingQuestions();
			this.releaseInteractionClaimsFor(token);
			// このペインの会話は、別のペインで `--resume` し直されうる。照合で採れるように控えから外す。
			this.hookTranscriptSightings.forgetRoots(token);
		} else {
			fireParadisAgentTurnEnded(token);
		}
		this.stopCliReconciliation(token);
	}

	/** コマンド検知トリガーの探索を1回予約する（世代が変わっていたら走らせない）。 */
	private scheduleCliDiscovery(token: string, generation: number, delayMs: number, discover: () => Promise<void>): void {
		const timer = setTimeout(() => {
			const timers = this.cliDiscoveryTimers.get(token);
			timers?.delete(timer);
			if (timers?.size === 0) {
				this.cliDiscoveryTimers.delete(token);
			}
			if (this.cliDiscoveryGenerations.get(token) !== generation) {
				return;
			}
			discover().catch(err => this.logService.warn('[paradisAgentChat] discovery on cli command failed', err));
		}, delayMs);
		let timers = this.cliDiscoveryTimers.get(token);
		if (timers === undefined) {
			timers = new Set();
			this.cliDiscoveryTimers.set(token, timers);
		}
		timers.add(timer);
	}

	private stopCliReconciliation(token: string): void {
		this.cliCodexForkRequests.delete(token);
		const timer = this.cliReconciliationTimers.get(token);
		if (timer !== undefined) {
			clearInterval(timer);
			this.cliReconciliationTimers.delete(token);
		}
		this.cliReconciliationWatermarks.delete(token);
	}

	private cancelCliDiscovery(token: string): void {
		const timers = this.cliDiscoveryTimers.get(token);
		if (timers !== undefined) {
			for (const timer of timers) {
				clearTimeout(timer);
			}
			this.cliDiscoveryTimers.delete(token);
		}
	}

	/** モバイルの切断 (presence offline)。そのモバイルの購読をすべて解放する。 */
	dropSubscriber(mobileId: string): void {
		// activity-detailの実読取はキャンセル不能。切断後もfinallyまでin-flight枠を
		// 保持し、即再接続による並列上限の迂回を防ぐ（応答は購読検証で抑止される）。
		for (const [key, pending] of [...this.pendingActions]) {
			if (pending.mobileId === mobileId) {
				clearTimeout(pending.timer);
				this.pendingActions.delete(key);
				this.releaseInteractionClaim(pending.interactionKey, key);
			}
		}
		for (const [key, completed] of [...this.completedActions]) {
			if (key.startsWith(`${mobileId}\0`)) {
				clearTimeout(completed.timer);
				this.completedActions.delete(key);
				this.releaseInteractionClaim(completed.interactionKey, key);
			}
		}
		for (const [key, pending] of [...this.pendingAttaches]) {
			if (pending.mobileId === mobileId) {
				clearTimeout(pending.timer);
				this.pendingAttaches.delete(key);
			}
		}
		const attachPrefix = `${mobileId}\0`;
		for (const key of [...this.attachGenerations.keys()]) {
			if (key.startsWith(attachPrefix)) {
				this.attachGenerations.delete(key);
			}
		}
		for (const token of [...this.subscribers.keys()]) {
			if (this.removeSubscriber(token, mobileId)) {
				this.stopTailerIfUnsubscribed(token);
			}
		}
	}

	/** agentチャネルのモバイル→PCメッセージを処理する。 */
	handleInbound(mobileId: string, payload: Uint8Array): void {
		let msg: AgentInbound;
		try {
			const parsed = parseAgentInbound(JSON.parse(decoder.decode(payload)));
			if (parsed === undefined) {
				return;
			}
			msg = parsed;
		} catch {
			return;
		}
		switch (msg.t) {
			case 'attach':
				this.handleAttach(mobileId, msg).catch(err => this.logService.warn('[paradisAgentChat] attach failed', err));
				break;
			case 'detach': {
				this.cancelAttach(this.pendingAttachKey(mobileId, msg.id, msg.token));
				const token = this.resolveInboundToken(msg.id, msg.token);
				if (token !== undefined && this.removeSubscriber(token, mobileId)) {
					this.stopTailerIfUnsubscribed(token);
				}
				break;
			}
			case 'action/sendMessage':
				this.handleSendMessageAction(mobileId, msg);
				break;
			case 'action/answerQuestion':
				this.handleQuestionAction(mobileId, msg);
				break;
			case 'action/clarifyQuestion':
				this.handleClarifyQuestionAction(mobileId, msg);
				break;
			case 'action/answerApproval':
				this.handleApprovalAction(mobileId, msg);
				break;
			case 'approval-options':
				this.handleApprovalOptionsRequest(mobileId, msg);
				break;
			case 'action/claudeSetting':
				this.handleClaudeSettingAction(mobileId, msg);
				break;
			case 'model-catalog':
				this.handleModelCatalogRequest(mobileId, msg).catch(err => this.logService.warn('[paradisAgentChat] model catalog failed', err));
				break;
			case 'command-catalog':
				this.handleCommandCatalogRequest(mobileId, msg).catch(err => this.logService.warn('[paradisAgentChat] command catalog failed', err));
				break;
			case 'settings-update':
				this.handleSettingsUpdateRequest(mobileId, msg).catch(err => this.logService.warn('[paradisAgentChat] settings update failed', err));
				break;
			case 'activity-detail':
				this.handleActivityDetailRequest(mobileId, msg).catch(err => this.logService.warn('[paradisAgentChat] activity detail failed', err));
				break;
			case 'tool-full':
				this.handleToolFullRequest(mobileId, msg);
				break;
			case 'tool-image':
				this.handleToolImageRequest(mobileId, msg);
				break;
			case 'history':
				this.handleHistoryRequest(mobileId, msg).catch(err => this.logService.warn('[paradisAgentChat] history failed', err));
				break;
			case 'shell-output':
			case 'action/stopShell':
				this.handleShellRequest(mobileId, msg).catch(err => this.logService.warn('[paradisAgentChat] background shell request failed', err));
				break;
		}
	}

	/**
	 * バックグラウンドのシェルの出力の末尾（`shell-output`）と停止（`action/stopShell`）。agent.shells.v1。
	 * 出力のパスは transcript で覚えたものだけを使い、SSH・WSL・Windows では読まない・止めない（`shellsAccess`）。
	 * 止めるのは mod（Claude Mods）の TaskStop だけで、transcript に残らないので ack で一覧を「停止」に直す。
	 */
	private async handleShellRequest(mobileId: string, msg: ParadisAgentShellInbound): Promise<void> {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		const valid = token !== undefined && tailer !== undefined && tailer.agent === 'claude' && tailer.epoch === msg.epoch && this.hasSubscriber(token, mobileId);
		await paradisHandleShellRequest(msg, valid ? {
			// 出力の置き場も mod も、tailer が読んでいる transcript の会話のもの
			key: token, access: this.shellsAccessFor(token, tailer), sessionId: paradisClaudeSessionIdFromTranscript(tailer.transcriptPath), reads: this.shellOutputReads,
			outputFile: shellId => tailer.shellOutputFile(shellId),
			isRunning: shellId => tailer.isShellRunning(shellId),
			markOutputEnded: (shellId, end) => tailer.markShellEndedFromOutput(shellId, end),
			markOutputRunning: shellId => tailer.markShellRunningFromOutput(shellId),
			markStopped: shellId => this.tailers.get(token)?.markShellStoppedFromMobile(shellId),
			stopTask: (sessionId, shellId) => this.claudeModBridge.stopTask(token, sessionId, shellId),
			log: message => this.logService.info(message),
		} : undefined, reply => this.sendTo(mobileId, { ...reply, id: msg.id, requestId: msg.requestId }, token ?? msg.token));
	}

	/** この構成でシェルの出力と停止を使えるか（SSH・WSL・Windows では使えない。停止は mod が生きているときだけ）。 */
	private shellsAccessFor(token: string, tailer: TranscriptTailer) {
		const cwd = this.tokenToCwd.get(token);
		const where = this.isRemoteAgentPane(token) ? 'ssh' as const
			: cwd !== undefined && paradisResolveAgentHomes(cwd).wsl !== undefined ? 'wsl' as const
				: process.platform === 'win32' ? 'windows' as const : undefined;
		return paradisShellsAccess(where, this.claudeModBridge.isAlive(token, paradisClaudeSessionIdFromTranscript(tailer.transcriptPath)));
	}

	/** mod の生き死に（`alive-changed`・`hello`・`bye`・`pending-changed`）で停止の可否が変わったら、一覧ごと送り直す。 */
	private resendShellsAccessIfChanged(token: string): void {
		const tailer = this.tailers.get(token);
		const terminalId = this.terminalIdForToken(token);
		if (tailer === undefined || tailer.agent !== 'claude' || terminalId === undefined) {
			return;
		}
		if (JSON.stringify(this.shellsAccessFor(token, tailer)) !== this.shellsAccessSent.get(token)) {
			this.sendToSubscribers(token, { t: 'delta', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages: [], ...this.monitorsField(token, tailer) });
		}
	}

	/**
	 * 古い発言を返す（W2-30、Q122）。
	 *
	 * 1 段目: `cursor` が無ければ、PC のメモリにある発言（ペインごとに 400 件のリング）のうち `beforeRev` より前を返す。
	 * リングを読み切ったら、その手前の記録ファイルの位置を `cursor` として添える。`beforeRev` がもうリングに無い（モバイルは
	 * 差分で 500 件まで持つ）ときは、押し出した発言の位置（2000 件まで残す）からすぐに記録ファイルを読む。
	 * 2 段目: `cursor` があれば、記録ファイルをその位置から後ろへ読んで返す（1 回 2MB まで）。rev は負の数を振り、1 ペインで
	 * {@link PARADIS_HISTORY_FILE_CAP} 件まで。重いので 1 ペインで同時に 1 本だけ。
	 */
	private async handleHistoryRequest(mobileId: string, msg: Extract<AgentInbound, { t: 'history' }>): Promise<void> {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		const reply = (body: Omit<Extract<AgentOutbound, { t: 'history' }>, 't' | 'id' | 'requestId' | 'epoch'>) => {
			this.sendTo(mobileId, { t: 'history', id: msg.id, requestId: msg.requestId, epoch: msg.epoch, ...body }, token ?? msg.token);
		};
		if (token === undefined || tailer === undefined || tailer.epoch !== msg.epoch || !this.hasSubscriber(token, mobileId)) {
			reply({ error: 'stale-session' });
			return;
		}
		const limit = msg.limit ?? 60;
		let cursor: IParadisHistoryCursor | undefined = msg.cursor !== undefined ? paradisDecodeHistoryCursor(msg.cursor) : undefined;
		if (cursor === undefined) {
			if (msg.beforeRev < 0) {
				reply({ error: 'history-moved' });
				return;
			}
			const ring = tailer.messages;
			const oldestRingRev = ring[0]?.rev;
			if (oldestRingRev !== undefined && msg.beforeRev >= oldestRingRev) {
				const older = ring.filter(message => message.rev < msg.beforeRev);
				const page = older.slice(-limit);
				if (older.length > page.length) {
					reply({ messages: page, hasMore: true });
					return;
				}
				const floor = tailer.historyCursorBefore(page[0]?.rev ?? msg.beforeRev);
				const next = floor !== undefined && paradisHistoryCursorHasMore(floor) ? paradisEncodeHistoryCursor(floor) : undefined;
				reply({ messages: page, hasMore: next !== undefined, ...(next !== undefined ? { cursor: next } : {}) });
				return;
			}
			// モバイルのいちばん古い発言がもうリングに無い（モバイルは差分で 500 件まで持つ。リングは 400 件）。
			// 押し出した発言の位置が残っていれば、そこから前を記録ファイルで読む（レビュー H3）。
			cursor = tailer.historyCursorBefore(msg.beforeRev);
			if (cursor === undefined) {
				reply({ error: 'history-moved' });
				return;
			}
			if (!paradisHistoryCursorHasMore(cursor)) {
				reply({ messages: [], hasMore: false });
				return;
			}
		}
		// ファイルから読んだ発言の rev は負の数。最初のページはモバイルの持っている rev（0 以上）の手前の -1 から振る。
		const newestRev = Math.min(msg.beforeRev, 0) - 1;
		const remaining = PARADIS_HISTORY_FILE_CAP + newestRev + 1;
		if (remaining <= 0) {
			reply({ messages: [], hasMore: false, capped: true });
			return;
		}
		if (this.historyReads.has(token)) {
			reply({ error: 'busy' });
			return;
		}
		this.historyReads.add(token);
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(tailer.transcriptPath, 'r');
			if (!await isAllowedOpenTranscriptPath(handle, tailer.transcriptPath)) {
				reply({ error: 'unavailable' });
				return;
			}
			const stat = await handle.stat();
			if (cursor.offset > stat.size) {
				reply({ error: 'history-moved' });
				return;
			}
			const page = await paradisReadTranscriptHistory(handle, tailer.agent, cursor, Math.min(limit, remaining), newestRev);
			// 読んでいる間に会話が読み直された（ファイルが縮んだ等）なら、位置の意味が変わっている。
			if (this.tailers.get(token) !== tailer || tailer.epoch !== msg.epoch) {
				reply({ error: 'stale-session' });
				return;
			}
			const capped = page.next !== undefined && remaining - page.messages.length <= 0;
			reply({
				messages: page.messages,
				hasMore: page.next !== undefined && !capped,
				...(page.next !== undefined && !capped ? { cursor: paradisEncodeHistoryCursor(page.next) } : {}),
				...(capped ? { capped: true } : {}),
			});
		} catch {
			reply({ error: 'unavailable' });
		} finally {
			this.historyReads.delete(token);
			await handle?.close().catch(() => { /* ignore */ });
		}
	}

	/**
	 * ツール出力の全文取得。モバイルがステップを展開したときだけ呼ばれる。
	 * transcript は読み直さず、tailer が切り詰め時に退避しておいた全文だけを返す
	 * （読み直しは長大セッションで重く、rev の再現性も保証できないため）。
	 */
	private handleToolFullRequest(mobileId: string, msg: Extract<AgentInbound, { t: 'tool-full' }>): void {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		if (token === undefined || tailer === undefined || tailer.epoch !== msg.epoch || !this.hasSubscriber(token, mobileId)) {
			this.sendTo(mobileId, { t: 'tool-full', id: msg.id, requestId: msg.requestId, rev: msg.rev, error: '全文を取得できません' }, token ?? msg.token);
			return;
		}
		const text = tailer.fullTextFor(msg.rev);
		if (text === undefined) {
			this.sendTo(mobileId, { t: 'tool-full', id: msg.id, requestId: msg.requestId, rev: msg.rev, error: 'この出力の全文は保持期限を過ぎています' }, token);
			return;
		}
		this.sendTo(mobileId, { t: 'tool-full', id: msg.id, requestId: msg.requestId, rev: msg.rev, text }, token);
	}

	/**
	 * tool_result に含まれていた画像の取り寄せ。モバイルがステップを開いたときだけ呼ばれる。
	 * 全文と同じく transcript は読み直さず、tailer が退避しておいた実体だけを返す。
	 */
	private handleToolImageRequest(mobileId: string, msg: Extract<AgentInbound, { t: 'tool-image' }>): void {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		const fail = (message: string): void => {
			this.sendTo(mobileId, { t: 'tool-image', id: msg.id, requestId: msg.requestId, rev: msg.rev, index: msg.index, error: message }, token ?? msg.token);
		};
		if (token === undefined || tailer === undefined || tailer.epoch !== msg.epoch || !this.hasSubscriber(token, mobileId)) {
			fail('画像を取得できません');
			return;
		}
		// 1件で数MBを stringify + seal する重い経路なので、activity-detail と同じく
		// ペイン単位で同時実行数を抑える（画面に見えている枚数ぶんは通す）。
		const requestKey = `${mobileId}\0${msg.requestId}`;
		const inFlightForToken = [...this.toolImageRequests.values()].filter(value => value === token).length;
		if (this.toolImageRequests.has(requestKey) || inFlightForToken >= TOOL_IMAGE_MAX_IN_FLIGHT) {
			fail('画像の取得が混み合っています。少し待ってから開き直してください');
			return;
		}
		const image = tailer.imageFor(msg.rev, msg.index);
		if (image === undefined) {
			fail('この画像は保持期限を過ぎています');
			return;
		}
		this.toolImageRequests.set(requestKey, token);
		void this.sendToAuthorized(mobileId, { t: 'tool-image', id: msg.id, requestId: msg.requestId, rev: msg.rev, index: msg.index, mediaType: image.mediaType, data: image.base64 }, token)
			.finally(() => this.toolImageRequests.delete(requestKey));
	}

	private async handleActivityDetailRequest(mobileId: string, msg: Extract<AgentInbound, { t: 'activity-detail' }>): Promise<void> {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const session = token !== undefined ? this.paneSessions.get(token) : undefined;
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		const owner = token !== undefined ? this.ownerForPane(msg.id, token) : undefined;
		// Advisor の平文の返答（旧世代のモデル）。一覧には載せず、詳細を開いたときにここで返す（ファイルは読まない）
		const advisorReply = token !== undefined ? this.activityTrackers.get(token)?.advisorReply(msg.activityId) : undefined;
		if (advisorReply !== undefined && token !== undefined) {
			const current = () => this.paneSessions.get(token) === session && this.tailers.get(token) === tailer && tailer?.epoch === msg.epoch && this.hasSubscriber(token, mobileId);
			if (session === undefined || owner === undefined || !current() || !await this.authorizeOwner(owner)) {
				this.sendTo(mobileId, { t: 'activity-detail', id: msg.id, requestId: msg.requestId, activityId: msg.activityId, error: 'Advisor の返答を確認できません' }, token);
				return;
			}
			// 承認を待つ間に会話が替わった・購読をやめたかもしれない。確かめ直し、返答も今の tracker から取り直す
			const reply = current() ? this.activityTrackers.get(token)?.advisorReply(msg.activityId) : undefined;
			if (reply === undefined) {
				if (this.hasSubscriber(token, mobileId)) {
					this.sendTo(mobileId, { t: 'activity-detail', id: msg.id, requestId: msg.requestId, activityId: msg.activityId, error: 'Advisor の返答の対象セッションが更新されました' }, token, owner);
				}
				return;
			}
			this.sendTo(mobileId, { t: 'activity-detail', id: msg.id, requestId: msg.requestId, activityId: msg.activityId, messages: [paradisAdvisorReplyMessage(reply)] }, token, owner);
			return;
		}
		const known = token !== undefined && this.activityTrackers.get(token)?.snapshot()?.agents.some(agent => agent.id === msg.activityId && agent.role === 'subagent' && (agent.provider === undefined || agent.provider === session?.agent));
		const requestKey = `${mobileId}\0${msg.requestId}`;
		const inFlightForToken = token !== undefined ? [...this.activityDetailRequests.values()].filter(value => value === token).length : 0;
		if (token === undefined || session === undefined || owner === undefined || tailer?.epoch !== msg.epoch || !known || !this.hasSubscriber(token, mobileId) || this.activityDetailRequests.has(requestKey) || inFlightForToken >= 2 || !await this.authorizeOwner(owner)) {
			this.sendTo(mobileId, { t: 'activity-detail', id: msg.id, requestId: msg.requestId, activityId: msg.activityId, error: 'SubAgentの詳細を確認できません' }, token ?? msg.token);
			return;
		}
		this.activityDetailRequests.set(requestKey, token);
		try {
			const messages = session.agent === 'codex'
				? await this.readCodexSubagentMessages(token, msg.activityId)
				: await this.readClaudeSubagentMessages(session.transcriptPath, msg.activityId, this.claudeSubagentTranscriptPaths.get(`${token}\0${msg.activityId}`));
			if (this.paneSessions.get(token) === session && this.tailers.get(token) === tailer && tailer.epoch === msg.epoch && this.hasSubscriber(token, mobileId)
				&& this.activityTrackers.get(token)?.snapshot()?.agents.some(agent => agent.id === msg.activityId && agent.role === 'subagent')) {
				this.sendTo(mobileId, { t: 'activity-detail', id: msg.id, requestId: msg.requestId, activityId: msg.activityId, messages }, token, owner);
			} else if (this.hasSubscriber(token, mobileId)) {
				this.sendTo(mobileId, { t: 'activity-detail', id: msg.id, requestId: msg.requestId, activityId: msg.activityId, error: 'SubAgent詳細の対象セッションが更新されました' }, token, owner);
			}
		} catch {
			if (this.paneSessions.get(token) === session && this.tailers.get(token) === tailer && tailer.epoch === msg.epoch && this.hasSubscriber(token, mobileId)) {
				this.sendTo(mobileId, { t: 'activity-detail', id: msg.id, requestId: msg.requestId, activityId: msg.activityId, error: 'SubAgent transcriptを取得できませんでした' }, token, owner);
			} else if (this.hasSubscriber(token, mobileId)) {
				this.sendTo(mobileId, { t: 'activity-detail', id: msg.id, requestId: msg.requestId, activityId: msg.activityId, error: 'SubAgent詳細の対象セッションが更新されました' }, token, owner);
			}
		} finally {
			this.activityDetailRequests.delete(requestKey);
		}
	}

	private async readCodexSubagentMessages(token: string, activityId: string): Promise<readonly IParadisAgentActivityDetailMessage[]> {
		// 接続先のペインはホームが引けない（手元を探しに行かせない）。写しの無い SubAgent の
		// 本文は取りようがないので、そのまま「取得できませんでした」を返す
		const homes = this.agentHomesForToken(token);
		const transcriptPath = homes === undefined ? undefined : await discoverCodexTranscriptByThreadId(activityId, homes);
		if (transcriptPath === undefined || !(await isAllowedTranscriptPath(transcriptPath))) { throw new Error('Codex SubAgent transcript not found'); }
		const stat = await fs.stat(transcriptPath);
		const start = Math.max(0, stat.size - INITIAL_READ_TAIL_BYTES);
		const handle = await fs.open(transcriptPath, 'r');
		try {
			if (!(await isAllowedOpenTranscriptPath(handle, transcriptPath))) { throw new Error('Codex SubAgent transcript path changed'); }
			const buffer = Buffer.alloc(stat.size - start);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
			const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
			if (start > 0) { lines.shift(); }
			return paradisParseCodexDetailLinesForTest(lines);
		} finally {
			await handle.close();
		}
	}

	private async readClaudeSubagentMessages(transcriptPath: string, activityId: string, hookTranscriptPath?: string): Promise<readonly IParadisAgentActivityDetailMessage[]> {
		const candidates = paradisClaudeSubagentTranscriptCandidates(transcriptPath, activityId, hookTranscriptPath);
		let selected: string | undefined;
		for (const candidate of candidates) {
			if (await isAllowedTranscriptPath(candidate) && await fs.stat(candidate).then(stat => stat.isFile()).catch(() => false)) {
				selected = candidate;
				break;
			}
		}
		if (selected === undefined) { return []; }
		const stat = await fs.stat(selected);
		const start = Math.max(0, stat.size - INITIAL_READ_TAIL_BYTES);
		const handle = await fs.open(selected, 'r');
		try {
			if (!(await isAllowedOpenTranscriptPath(handle, selected))) { return []; }
			const buffer = Buffer.alloc(stat.size - start);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
			const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
			if (start > 0) { lines.shift(); }
			const out: IParadisAgentActivityDetailMessage[] = [];
			for (const line of lines) {
				let parsed: Record<string, unknown> | undefined;
				try { parsed = rec(JSON.parse(line)); } catch { continue; }
				if (parsed === undefined) { continue; }
				for (const message of parseClaudeLine(parsed, newParseSignals(), true)) {
					if (message.kind === 'question' || message.kind === 'peer_message') { continue; }
					out.push(toDetailMessage(message));
				}
			}
			return out.slice(-200);
		} finally {
			await handle.close();
		}
	}

	/**
	 * `viaMod` が true（モバイルからの最初の受け付け）なら、待機中の Claude Code へは mod（Claude Mods）の
	 * `$.prompt.submit` で送る。mod へ渡せなかったときは false で呼び直し、今までどおりウィンドウのキー入力で送る。
	 * `dialogChecked` は、承認・質問以外の画面（`/config` など）が開いていないかを mod に聞き終えたか（{@link checkClaudeDialog}）。
	 */
	private handleSendMessageAction(mobileId: string, msg: Extract<AgentInbound, { t: 'action/sendMessage' }>, viaMod = true, dialogChecked = false): void {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const session = token !== undefined ? this.paneSessions.get(token) : undefined;
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		const owner = token !== undefined ? this.ownerForPane(msg.id, token) : undefined;
		const key = this.actionKey(mobileId, msg.requestId);
		// 預かった送信（W2-29）の送り直し: 同じ id を一度ウィンドウへ渡したら、二度目は送らずに受け付け済みと答える
		// （アプリが送っている途中で落ちて、起動し直して送り直したとき。レビュー M4）。
		const sendKey = msg.sendId !== undefined ? `${mobileId}\0${msg.sendId}` : undefined;
		if (sendKey !== undefined && this.dispatchedSendIds.has(sendKey)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'accepted', code: 'duplicate' }, token ?? msg.token);
			return;
		}
		if (token === undefined || session === undefined || tailer === undefined || tailer.epoch !== msg.epoch || owner === undefined || !this.hasSubscriber(token, mobileId) || this.pendingActions.has(key) || this.completedActions.has(key)
			|| (!dialogChecked && this.dialogChecks.has(key))) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'stale-session', message: '操作対象のエージェントセッションが変わりました' }, token ?? msg.token);
			return;
		}
		const rejection = this.sendRejection(session, msg.text);
		if (rejection !== undefined) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', ...rejection }, token);
			return;
		}
		if (!dialogChecked && this.checkClaudeDialog(mobileId, msg.id, msg.requestId, key, token, session, tailer, () => this.handleSendMessageAction(mobileId, msg, viaMod, true))) {
			return;
		}
		if (viaMod && this.trySendViaMod(mobileId, msg, token, session, tailer, key, sendKey)) {
			return;
		}
		const timer = setTimeout(() => {
			if (this.pendingActions.delete(key)) {
				this.forgetSendId(sendKey);
				this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'action-timeout', message: '操作対象のウィンドウが応答しませんでした' }, token);
			}
		}, 5_000);
		this.rememberSendId(sendKey);
		this.pendingActions.set(key, { mobileId, token, epoch: msg.epoch, terminalId: msg.id, windowId: owner.windowId, windowSession: owner.windowSession, timer, ...(sendKey !== undefined ? { sendKey } : {}) });
		// スラッシュコマンドが「そのコマンドは無い」と断られたら、受け付けずに断る。
		// - Claude Code: transcript に書かれる `Unknown command: /x` の行で確かめる（受け付けはそのまま返し、
		//   {@link watchClaudeSlashRejection} が後から断りを送る）
		// - Codex: transcript に残らないので、所有ウィンドウが Enter の後の画面を読む
		const slash = paradisParseSlashCommand(msg.text);
		if (slash !== undefined && session.agent === 'claude') {
			this.rememberClaudeSlashCheck(key, { token, command: slash.name, sentAt: Date.now(), sendKey });
			void this.watchClaudeSlashRejection(mobileId, msg.id, msg.requestId, key).catch(error => this.logService.warn('[paradisAgentChat] watching a slash command failed', error));
		}
		// `agent`: 所有ウィンドウは Codex のペインで、前に断られたコマンドの文字が入力欄に残っていないかを貼り付けの前に確かめる
		this.requestAction(mobileId, owner.windowId, owner.windowSession, owner.rendererGeneration, encoder.encode(JSON.stringify({
			...msg, token, windowId: owner.windowId, agent: session.agent,
			...(slash !== undefined && session.agent === 'codex' ? { slashCheck: { agent: 'codex', command: slash.name } } : {}),
		})));
	}

	/** mod に画面のことを聞いている最中の操作（actionKey）。同じ requestId の二度目を弾く。 */
	private readonly dialogChecks = new Set<string>();
	/** ペインごとに、画面が開いていると答えられた時刻（{@link DIALOG_ANSWER_CACHE_MS} だけ使う）。 */
	private readonly dialogAnswers = new Map<string, { readonly sessionId: string; readonly at: number }>();

	/**
	 * Claude Code で、承認・質問以外の画面（`/config`・`/rewind` など）がキーを持っていないかを mod に聞いてから `proceed` する。
	 * 開いていれば、キーを打たずに断る（その画面に文字と Enter が入る）。承認・質問を待っている間は、その判定を優先して
	 * 聞かない（mod の問い合わせはそれらの画面と区別できない）。mod が答えられないときはそのまま進む。聞いたら true。
	 */
	private checkClaudeDialog(mobileId: string, terminalId: number, requestId: string, key: string, token: string, session: IPaneSessionInfo, tailer: TranscriptTailer, proceed: () => void): boolean {
		const sessionId = session.sessionId;
		if (session.agent !== 'claude' || sessionId === undefined || !this.claudeModBridge.supports(token, sessionId, 'prompt.dialog') || tailer.currentInteraction() !== null) {
			return false;
		}
		const reject = () => this.sendTo(mobileId, { t: 'action-result', id: terminalId, requestId, status: 'rejected', code: PARADIS_PANEL_OPEN_CODE, message: PARADIS_PANEL_OPEN_MESSAGE }, token);
		// 画面が開いている間に続けて送るときの往復を省く（「開いている」の答えだけを少しの間使う。「閉じている」を使い回すと、
		// その間に開いた画面へ打ってしまう）
		const cached = this.dialogAnswers.get(token);
		if (cached !== undefined && cached.sessionId === sessionId && Date.now() - cached.at < DIALOG_ANSWER_CACHE_MS) {
			reject();
			return true;
		}
		this.dialogChecks.add(key);
		void this.claudeModBridge.isDialogOpen(token, sessionId).catch(() => undefined).then(open => {
			this.dialogChecks.delete(key);
			if (open === true) {
				this.dialogAnswers.set(token, { sessionId, at: Date.now() });
			} else {
				this.dialogAnswers.delete(token);
			}
			if (open === true) {
				this.sendTo(mobileId, { t: 'action-result', id: terminalId, requestId, status: 'rejected', code: PARADIS_PANEL_OPEN_CODE, message: PARADIS_PANEL_OPEN_MESSAGE }, token);
				return;
			}
			proceed();
		});
		return true;
	}

	/** 送る前に断る理由: Claude Code の内部向けのコマンド（`__` で始まるもの）。 */
	private sendRejection(session: IPaneSessionInfo, text: string): { readonly code: string; readonly message: string } | undefined {
		if (session.agent !== 'claude') {
			return undefined;
		}
		const slash = paradisParseSlashCommand(text);
		if (slash !== undefined && slash.name.startsWith('__')) {
			return { code: PARADIS_SLASH_COMMAND_REJECTED_CODE, message: `/${slash.name} は Claude Code の内部向けのコマンドなので送れません` };
		}
		return undefined;
	}

	/** キーで送った Claude Code のスラッシュコマンド（actionKey → 確かめる中身）。所有ウィンドウの返事を待たせて確かめる。 */
	private readonly claudeSlashChecks = new Map<string, { readonly token: string; readonly command: string; readonly sentAt: number; readonly sendKey: string | undefined }>();

	private rememberClaudeSlashCheck(key: string, check: { readonly token: string; readonly command: string; readonly sentAt: number; readonly sendKey: string | undefined }): void {
		const now = Date.now();
		for (const [candidate, entry] of this.claudeSlashChecks) {
			if (now - entry.sentAt > 60_000) {
				this.claudeSlashChecks.delete(candidate);
			}
		}
		this.claudeSlashChecks.set(key, check);
	}

	/**
	 * キーで送った Claude Code のスラッシュコマンドを見張る（所有ウィンドウの受け付けの返事は止めない）。transcript に
	 * `Unknown command: /x` が書かれたら、同じ requestId への追いかけの断り（`late: true`。新しいアプリは理由を出して文を
	 * 入力欄へ戻す。古いアプリは答え終えた requestId を捨てる）と、会話の知らせの行（古いアプリにも見える）を送る。
	 * コマンドの実行記録が先に書かれたら見張りをやめる。relay の送信の鎖とは別に、ここだけで待つ。
	 */
	private async watchClaudeSlashRejection(mobileId: string, terminalId: number, requestId: string, key: string): Promise<void> {
		const check = this.claudeSlashChecks.get(key);
		if (check === undefined) {
			return;
		}
		try {
			// 所有ウィンドウが受け取って打った送信（claim 済み）に限る。打たなかった送信へ、同じ名前の別の断りを結びつけない
			if (!await this.waitForClaudeUnknownCommand(check) || !this.completedActions.has(key)) {
				return;
			}
		} finally {
			this.claudeSlashChecks.delete(key);
		}
		// 何も実行されていないので、同じ預かりの送信を送り直せるようにする
		this.forgetSendId(check.sendKey);
		const message = paradisSlashRejectionMessage('claude', check.command);
		this.tailers.get(check.token)?.injectNotice(message);
		this.sendTo(mobileId, { t: 'action-result', id: terminalId, requestId, status: 'rejected', code: PARADIS_SLASH_COMMAND_REJECTED_CODE, message, late: true }, check.token);
	}

	private async waitForClaudeUnknownCommand(check: { readonly token: string; readonly command: string; readonly sentAt: number }): Promise<boolean> {
		const deadline = check.sentAt + CLAUDE_UNKNOWN_COMMAND_WAIT_MS;
		const since = check.sentAt - 1_000;
		for (; ;) {
			const tailer = this.tailers.get(check.token);
			if (tailer === undefined) {
				return false;
			}
			await tailer.afterQueue(() => { });
			if (tailer.unknownSlashCommands.some(entry => entry.name === check.command && entry.at >= since)) {
				return true;
			}
			// 実行記録（`/name` の発言）が書かれた: そのコマンドはあった
			if (tailer.messages.some(message => message.role === 'user' && message.kind === 'text' && (message.ts ?? 0) >= since
				&& (message.text === `/${check.command}` || message.text.startsWith(`/${check.command} `)))) {
				return false;
			}
			if (Date.now() >= deadline) {
				return false;
			}
			await new Promise<void>(resolve => setTimeout(resolve, 150));
		}
	}

	/** ウィンドウへ渡した預かりの送信の id（mobileId と組。最近 {@link SEND_ID_LIMIT} 件、24 時間）。 */
	private readonly dispatchedSendIds = new Map<string, number>();

	private rememberSendId(sendKey: string | undefined): void {
		if (sendKey === undefined) {
			return;
		}
		const now = Date.now();
		this.dispatchedSendIds.set(sendKey, now);
		for (const [candidate, at] of this.dispatchedSendIds) {
			if (this.dispatchedSendIds.size <= SEND_ID_LIMIT && now - at < SEND_ID_TTL_MS) {
				break;
			}
			this.dispatchedSendIds.delete(candidate);
		}
	}

	/** ウィンドウが受け取らなかった（古い・時間切れ）送信は、送り直せるように忘れる。 */
	private forgetSendId(sendKey: string | undefined): void {
		if (sendKey !== undefined) {
			this.dispatchedSendIds.delete(sendKey);
		}
	}

	private handleClaudeSettingAction(mobileId: string, msg: Extract<AgentInbound, { t: 'action/claudeSetting' }>, dialogChecked = false): void {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const session = token !== undefined ? this.paneSessions.get(token) : undefined;
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		const owner = token !== undefined ? this.ownerForPane(msg.id, token) : undefined;
		const key = this.actionKey(mobileId, msg.requestId);
		if (token === undefined || session?.agent !== 'claude' || tailer === undefined || tailer.epoch !== msg.epoch || owner === undefined
			|| !this.hasSubscriber(token, mobileId) || !this.isAgentPrompt(token, tailer) || this.pendingActions.has(key) || this.completedActions.has(key)
			|| (!dialogChecked && this.dialogChecks.has(key))) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'not-at-prompt', message: 'Claude Codeが入力待ちの時だけ設定を変更できます' }, token ?? msg.token);
			return;
		}
		// `/model` などを打つので、ほかの画面（モバイルから開いた /config など）が開いていればキーを打たずに断る
		if (!dialogChecked && this.checkClaudeDialog(mobileId, msg.id, msg.requestId, key, token, session, tailer, () => this.handleClaudeSettingAction(mobileId, msg, true))) {
			return;
		}
		const timer = setTimeout(() => {
			if (this.pendingActions.delete(key)) {
				this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'action-timeout', message: '操作対象のウィンドウが応答しませんでした' }, token);
			}
		}, 5_000);
		this.pendingActions.set(key, { mobileId, token, epoch: msg.epoch, terminalId: msg.id, windowId: owner.windowId, windowSession: owner.windowSession, requirePrompt: true, timer });
		this.requestAction(mobileId, owner.windowId, owner.windowSession, owner.rendererGeneration, encoder.encode(JSON.stringify({
			t: 'action/claudeSetting', id: msg.id, token, requestId: msg.requestId, epoch: msg.epoch,
			setting: msg.setting, value: msg.value, windowId: owner.windowId,
		})));
	}

	private isAgentPrompt(token: string, tailer: TranscriptTailer): boolean {
		return !this.activeTurnTokens.has(token) && this.liveStates.get(token) === undefined && tailer.currentInteraction() === null;
	}

	private handleQuestionAction(mobileId: string, msg: Extract<AgentInbound, { t: 'action/answerQuestion' }>): void {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const questions = token !== undefined ? this.tailers.get(token)?.pendingQuestionMessages(msg.interactionId) ?? [] : [];
		const answersMatch = questions.length === msg.answers.length && msg.answers.every((answer, index) => paradisQuestionAnswerFits(questions[index], answer));
		if (!answersMatch) {
			this.recordQuestionAnswerShape(token, msg, questions, 0, 'rejected-mismatch');
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'invalid-answer', message: '質問の選択肢が更新されました' }, token ?? msg.token);
			return;
		}
		// mod（Claude Mods）が質問を待っていれば、キーを打たずに値で答える（mod が無い・待っていなければキーの経路）
		if (token !== undefined && this.tryAnswerQuestionViaMod(mobileId, msg, token, questions)) {
			return;
		}
		// キーで渡せない回答: メモ（キーの列を確かめていない）と、preview のある質問への自由入力（その質問には「その他」の行が無い）
		const keyAnswers = msg.answers.filter(paradisIsKeyQuestionAnswer);
		const parts = keyAnswers.length === msg.answers.length ? paradisAgentQuestionKeySequence(questions.map(paradisQuestionKeyShape), keyAnswers) : [];
		if (parts.length === 0) {
			this.recordQuestionAnswerShape(token, msg, questions, 0, 'rejected-mismatch');
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'invalid-answer', message: 'この回答は PC のターミナルへ渡せません。メモと、下書きのある質問への「その他」は PC の画面で答えてください' }, token ?? msg.token);
			return;
		}
		this.recordQuestionAnswerShape(token, msg, questions, parts.length, 'dispatched');
		// TUI が選択肢リストへキーボードフォーカスを移すより前に打鍵を流すと、その1打鍵は
		// リストではなく**入力欄へ吸われて消える**（Claude Code 2.1.223 で実測）。単問・単一選択は
		// キー列が「数字1つ」だけなので、それを取りこぼすと後続で拾い直す機会が無く、
		// モバイル側には送信成功に見えたまま TUI は何も起きない。先頭の選択肢ラベルが画面に
		// 出るのを待ってから流すための目印を渡す。
		this.dispatchInteractionAction(mobileId, msg, { kind: 'question', id: msg.interactionId }, parts,
			paradisQuestionReadyMarker(questions[0]));
		this.scheduleQuestionSettleCheck(token, msg.interactionId, questions.length, parts.length);
	}

	/**
	 * モバイルから届いた回答の「形」を記録する。
	 *
	 * TUI へ流すキー列は Claude Code の実挙動に合わせて組んであり（paradisAgentQuestionKeys。
	 * 2.1.220 で実測し、2.1.223 で規則が変わっていないことを確認済み）、
	 * 質問の数・選択肢の数・複数選択・自由入力の有無で段取りが変わる。どの組み合わせで壊れるかは
	 * 手元では再現しきれないので、実際に使われた組み合わせと結果を残す。
	 *
	 * 質問文・選択肢のラベル・自由入力の本文は載せない（件数と種別だけ）。
	 */
	private recordQuestionAnswerShape(
		token: string | undefined,
		msg: Extract<AgentInbound, { t: 'action/answerQuestion' }>,
		questions: readonly IParadisAgentChatMessage[],
		keyPartCount: number,
		outcome: 'dispatched' | 'rejected-mismatch',
	): void {
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		const agent = tailer?.agent;
		const cliVersion = tailer?.cliVersion;
		// 質問が浮上してから回答が届くまで。TUI のフォーカス移動レース（描画直後の数百ms）で
		// 説明できるのか、それとも別の理由なのかは、この値と `answer-settled` の結果を
		// 突き合わせて初めて決まる。
		const msSinceQuestion = this.msSinceQuestionFirstSeen(token, msg.interactionId);
		runInParadisSpan('agentQuestion', 'answer', {
			safe_outcome: outcome,
			...(msSinceQuestion !== undefined ? { safe_ms_since_question: msSinceQuestion } : {}),
			safe_question_count: questions.length,
			safe_answer_count: msg.answers.length,
			// 例 "4,3,2"。Other 行までの下矢印の数がこれで決まるので、ずれると別の行を叩く。
			safe_option_counts: questions.map(question => question.options?.length ?? 0).join(','),
			safe_multi_select_count: questions.filter(question => question.multiSelect === true).length,
			// 自由入力は「番号 → 本文 → Enter」の順が要る唯一の経路で、いちばん壊れやすい。
			safe_free_text_count: msg.answers.filter(answer => answer.kind === 'text').length,
			safe_key_parts: keyPartCount,
			...(agent !== undefined ? { safe_agent: agent } : {}),
			// キー列は特定バージョンのTUI挙動に合わせてある。壊れた版を切り分けるための決め手。
			...(cliVersion !== undefined ? { safe_cli_version: cliVersion } : {}),
		}, () => { });
	}

	/**
	 * キーを流し終えた頃に、その質問が本当に消えたかを確かめて記録する。
	 *
	 * 「モバイルでは送れたのに TUI が動いていない」を捉えるための唯一の指標。送信そのものは
	 * 成功扱いになるので、これが false のときだけ段取りの前提が崩れている。
	 */
	private scheduleQuestionSettleCheck(token: string | undefined, interactionId: string, questionCount: number, keyPartCount: number): void {
		if (token === undefined) {
			return;
		}
		const tailer = this.tailers.get(token);
		if (tailer === undefined) {
			return;
		}
		const epoch = tailer.epoch;
		// 送った時点での経過を先に取る（待ち時間ぶん後ろにずれないように）。`safe_resolved` を
		// これで分ければ、「早く答えたものだけ落ちている＝レース」なのかが一目で分かる。
		const msSinceQuestion = this.msSinceQuestionFirstSeen(token, interactionId);
		// キーは delayMs=300 の間隔で1つずつ流れる。全部届いてから見ないと「まだ残っている」と
		// 誤って読むため、列の長さぶん待ってから確かめる。
		const waitMs = Math.min(QUESTION_SETTLE_MAX_WAIT_MS, keyPartCount * 300 + 3_000);
		const timer = setTimeout(() => {
			this.questionSettleTimers.delete(timer);
			const current = this.tailers.get(token);
			if (current === undefined || current.epoch !== epoch) {
				return; // セッションが変わった。回答の成否とは無関係なので測らない。
			}
			runInParadisSpan('agentQuestion', 'answer-settled', {
				safe_resolved: !current.hasPendingInteraction({ kind: 'question', id: interactionId }),
				...(msSinceQuestion !== undefined ? { safe_ms_since_question: msSinceQuestion } : {}),
				safe_question_count: questionCount,
				safe_key_parts: keyPartCount,
				safe_agent: current.agent,
				...(current.cliVersion !== undefined ? { safe_cli_version: current.cliVersion } : {}),
			}, () => { });
		}, waitMs);
		this.questionSettleTimers.add(timer);
	}

	private handleApprovalAction(mobileId: string, msg: Extract<AgentInbound, { t: 'action/answerApproval' }>): void {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const session = token !== undefined ? this.paneSessions.get(token) : undefined;
		if (paradisIsCodexDaemonApprovalInteraction(msg.interactionId)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'stale-interaction', message: 'この承認要求はすでに完了しています' }, token ?? msg.token);
			return;
		}
		// mod（Claude Mods）が承認を待っていれば、キーを打たずに値で答える（「以後は確認しない」もここだけ）。
		if (token !== undefined && session?.agent === 'claude') {
			const viaMod = this.tryAnswerApprovalViaMod(token, msg.interactionId, msg.choice, msg.optionLabel, { mobileId, epoch: msg.epoch }, msg.message);
			if (viaMod === 'answered' || viaMod === 'locked') {
				this.sendTo(mobileId, viaMod === 'answered'
					? { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'accepted' }
					: { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'interaction-locked', message: 'PC側で反映を待っています。変わらない場合はPCの画面で確認してください' }, token);
				return;
			}
		}
		if (msg.message !== undefined) {
			// 指示を添えた拒否は mod でしか渡せない（キーの経路は選択肢の位置に依って確かめられない）。指示を落として
			// Esc で拒否すると、指示を書いた人には伝わったように見えてしまうので、送らずに断る
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'stale-interaction', message: '指示を添えて拒否できなくなりました。拒否だけを送るか、PCの画面で回答してください' }, token ?? msg.token);
			return;
		}
		if (msg.choice === 'always') {
			// 「以後は確認しない」は mod でしか渡せない（キーの列を確かめていない）。mod が待つのをやめた後に押された
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'stale-interaction', message: 'この確認はもう回答を待っていません。PCの画面で確認してください' }, token ?? msg.token);
			return;
		}
		const agent = session?.agent;
		// 画面の番号付きの選択肢から選んだ回答（W2-21）は `opt:<n>` と、そのとき見えていた文言で届く。
		// 文言が無いものは確かめようが無いので受け付けない。
		const optionNumber = paradisParseApprovalOptionChoice(msg.choice);
		const validOption = optionNumber !== undefined && msg.optionLabel !== undefined;
		if (msg.choice !== 'yes' && msg.choice !== 'no' && !validOption) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'invalid-answer', message: '承認の選択肢が更新されました' }, token ?? msg.token);
			return;
		}
		if (validOption) {
			// キーは送る直前に所有ウィンドウが画面を読み直して決める（Codex は行末の近道が要る）。ここでは
			// 番号を仮に置き、確かめる文言を添える。
			this.dispatchInteractionAction(mobileId, msg, { kind: 'approval', id: msg.interactionId }, [String(optionNumber)], undefined,
				{ expectOption: { n: optionNumber, label: msg.optionLabel as string }, agent: agent === 'codex' ? 'codex' : 'claude', ...(msg.promptHash !== undefined ? { promptHash: msg.promptHash } : {}) });
			return;
		}
		const parts = paradisAgentApprovalKeySequence(agent === 'codex' ? 'codex' : 'claude', msg.choice as 'yes' | 'no');
		this.dispatchInteractionAction(mobileId, msg, { kind: 'approval', id: msg.interactionId }, parts);
	}

	/**
	 * 承認の画面の選択肢を求められた（W2-21）。画面は所有ウィンドウでしか読めないので、確かめてから
	 * ウィンドウへ回す。答え（選択肢か「読めない」）はウィンドウがモバイルへ直接返す。
	 *
	 * ここで断るのは、求めが古い（別の承認・別の会話）か、Codex の app-server 経由の承認（選択肢は
	 * 最初から構造化されて届く）のとき。
	 */
	private handleApprovalOptionsRequest(mobileId: string, msg: Extract<AgentInbound, { t: 'approval-options' }>): void {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const session = token !== undefined ? this.paneSessions.get(token) : undefined;
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		const owner = token !== undefined ? this.ownerForPane(msg.id, token) : undefined;
		const interaction = tailer?.currentInteraction();
		if (token === undefined || session === undefined || tailer === undefined || tailer.epoch !== msg.epoch || owner === undefined
			|| !this.hasSubscriber(token, mobileId) || interaction?.kind !== 'approval' || interaction.id !== msg.interactionId
			|| paradisIsCodexDaemonApprovalInteraction(msg.interactionId)) {
			this.sendTo(mobileId, { t: 'approval-options', id: msg.id, requestId: msg.requestId, interactionId: msg.interactionId, error: 'stale-interaction' }, token ?? msg.token);
			return;
		}
		this.requestAction(mobileId, owner.windowId, owner.windowSession, owner.rendererGeneration, encoder.encode(JSON.stringify({
			t: 'action/approvalOptions', id: msg.id, token, requestId: msg.requestId, epoch: msg.epoch, interactionId: msg.interactionId,
			agent: session.agent, windowId: owner.windowId,
		})));
	}

	private dispatchInteractionAction(
		mobileId: string,
		msg: Extract<AgentInbound, { t: 'action/answerQuestion' | 'action/answerApproval' }>,
		interaction: IParadisAgentInteraction,
		parts: readonly string[],
		readyMarker?: string,
		/** 画面の番号付きの選択肢で答えたとき（W2-21）: 送る直前に確かめる番号と文言、キーを決めるためのエージェントの種類。 */
		approvalOption?: { readonly expectOption: IParadisAgentApprovalOption; readonly agent: 'claude' | 'codex'; readonly promptHash?: string },
	): void {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		const owner = token !== undefined ? this.ownerForPane(msg.id, token) : undefined;
		const key = this.actionKey(mobileId, msg.requestId);
		const interactionKey = token !== undefined ? `${token}\0${msg.epoch}\0${interaction.kind}\0${interaction.id}` : undefined;
		if (token === undefined || tailer === undefined || tailer.epoch !== msg.epoch || owner === undefined
			|| !this.hasSubscriber(token, mobileId) || !tailer.hasPendingInteraction(interaction)
			|| interactionKey === undefined
			// 上限は暴走した列を弾くための安全弁。複数選択の質問は送信ボタンまでの移動キーが
			// 選択肢の数だけ増えるため、多問ぶんを見込んだ余裕を持たせている。
			|| parts.length === 0 || parts.length > 400 || this.pendingActions.has(key) || this.completedActions.has(key)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'stale-interaction', message: '回答対象の質問または承認要求が変わりました' }, token ?? msg.token);
			return;
		}
		// 同じ interaction への回答が既にPC側へ渡っている。TUI が消費し損ねてカードが残った場合、
		// ユーザーは押し直すしかないが、これを stale-interaction と同じ扱いで黙って弾くと
		// 「押しても何も起きない」ようにしか見えない。状態を区別して伝える。
		if (this.interactionClaims.has(interactionKey)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'interaction-locked', message: 'PC側で反映を待っています。変わらない場合はPCの画面で確認してください' }, token);
			return;
		}
		const timer = setTimeout(() => {
			if (this.pendingActions.delete(key)) {
				this.releaseInteractionClaim(interactionKey, key);
				this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'action-timeout', message: '操作対象のウィンドウが応答しませんでした' }, token);
			}
		}, 5_000);
		this.interactionClaims.set(interactionKey, key);
		this.pendingActions.set(key, { mobileId, token, epoch: msg.epoch, terminalId: msg.id, windowId: owner.windowId, windowSession: owner.windowSession, interaction, interactionKey, timer });
		this.requestAction(mobileId, owner.windowId, owner.windowSession, owner.rendererGeneration, encoder.encode(JSON.stringify({
			t: 'action/interaction', id: msg.id, token, requestId: msg.requestId, epoch: msg.epoch, interaction, parts, delayMs: 300, windowId: owner.windowId,
			...(readyMarker !== undefined ? { readyMarker } : {}),
			...(approvalOption !== undefined ? { expectOption: approvalOption.expectOption, agent: approvalOption.agent, ...(approvalOption.promptHash !== undefined ? { expectPromptHash: approvalOption.promptHash } : {}) } : {}),
		})));
	}

	claimSendMessageAction(mobileId: string, requestId: string, token: string, epoch: string, windowId: number, windowSession: string): 'claimed' | 'stale' | 'expired' {
		const key = this.actionKey(mobileId, requestId);
		const pending = this.pendingActions.get(key);
		if (pending === undefined) {
			return 'expired';
		}
		clearTimeout(pending.timer);
		this.pendingActions.delete(key);
		const completedTimer = setTimeout(() => {
			const completed = this.completedActions.get(key);
			this.completedActions.delete(key);
			this.releaseInteractionClaim(completed?.interactionKey, key);
		}, 60_000);
		this.completedActions.set(key, {
			token, epoch, terminalId: pending.terminalId, windowId: pending.windowId, windowSession: pending.windowSession,
			...(pending.interaction !== undefined ? { interaction: pending.interaction } : {}),
			...(pending.interactionKey !== undefined ? { interactionKey: pending.interactionKey } : {}), timer: completedTimer,
			...(pending.requirePrompt === true ? { requirePrompt: true } : {}),
		});
		const currentTailer = this.tailers.get(token);
		const owner = this.ownerForPane(pending.terminalId, token);
		const valid = pending.token === token && pending.epoch === epoch && pending.windowId === windowId && pending.windowSession === windowSession
			&& owner?.windowId === windowId && owner.windowSession === windowSession && currentTailer?.epoch === epoch && this.hasSubscriber(token, mobileId)
			&& (pending.interaction === undefined || currentTailer.hasPendingInteraction(pending.interaction))
			&& (pending.requirePrompt !== true || this.isAgentPrompt(token, currentTailer))
			&& (pending.interactionKey === undefined || this.interactionClaims.get(pending.interactionKey) === key);
		if (!valid) {
			this.releaseInteractionClaim(pending.interactionKey, key);
			this.forgetSendId(pending.sendKey);
		}
		return valid ? 'claimed' : 'stale';
	}

	continueInteractionAction(mobileId: string, requestId: string, token: string, epoch: string, terminalId: number, windowId: number, windowSession: string): 'valid' | 'completed' | 'stale' {
		const key = this.actionKey(mobileId, requestId);
		const completed = this.completedActions.get(key);
		const tailer = this.tailers.get(token);
		const owner = this.ownerForPane(terminalId, token);
		if (completed === undefined || completed.token !== token || completed.epoch !== epoch || completed.terminalId !== terminalId || completed.windowId !== windowId || completed.windowSession !== windowSession
			|| owner?.windowId !== windowId || owner.windowSession !== windowSession || tailer?.epoch !== epoch || !this.hasSubscriber(token, mobileId)
			|| (completed.interactionKey !== undefined && this.interactionClaims.get(completed.interactionKey) !== key)) {
			this.releaseInteractionClaim(completed?.interactionKey, key);
			return 'stale';
		}
		if (completed.interaction === undefined) {
			return 'stale';
		}
		if (tailer.hasPendingInteraction(completed.interaction)) {
			return 'valid';
		}
		this.releaseInteractionClaim(completed.interactionKey, key);
		return 'completed';
	}

	validateClaimedAction(mobileId: string, requestId: string, token: string, epoch: string, terminalId: number, windowId: number, windowSession: string): boolean {
		const completed = this.completedActions.get(this.actionKey(mobileId, requestId));
		const tailer = this.tailers.get(token);
		const owner = this.ownerForPane(terminalId, token);
		return completed !== undefined && completed.token === token && completed.epoch === epoch
			&& completed.terminalId === terminalId && completed.windowId === windowId && completed.windowSession === windowSession
			&& owner?.windowId === windowId && owner.windowSession === windowSession && tailer?.epoch === epoch
			&& this.hasSubscriber(token, mobileId)
			&& (completed.requirePrompt !== true || (this.paneSessions.get(token)?.agent === 'claude' && this.isAgentPrompt(token, tailer)));
	}

	finalizeInteractionAction(mobileId: string, requestId: string, token: string, outcome: 'accepted' | 'failed', windowId: number, windowSession: string): void {
		const key = this.actionKey(mobileId, requestId);
		const completed = this.completedActions.get(key);
		// モバイルから答え終えた承認も、表に出す候補から外す（デスクトップと同じ。同じ内容の次の許可を出すため）。
		const answered = completed ?? this.pendingActions.get(key);
		if (outcome === 'accepted' && answered?.token === token && answered.windowId === windowId && answered.windowSession === windowSession
			&& answered.interaction?.kind === 'approval') {
			this.tailers.get(token)?.markApprovalAnswered(answered.interaction.id);
		}
		if (outcome === 'failed' && completed?.token === token && completed.windowId === windowId && completed.windowSession === windowSession
			&& this.ownerForPane(completed.terminalId, token)?.windowSession === windowSession) {
			this.releaseInteractionClaim(completed.interactionKey, key);
		}
	}

	private releaseInteractionClaim(interactionKey: string | undefined, actionKey: string): void {
		if (interactionKey !== undefined && this.interactionClaims.get(interactionKey) === actionKey) {
			this.interactionClaims.delete(interactionKey);
		}
	}

	/**
	 * このペインの interaction claim を解放する。
	 *
	 * 以前は approval だけを対象にしていたため、質問の claim は 60 秒タイマーでしか解けなかった。
	 * モバイルのカードは 15 秒で再タップ可能に戻るので、TUI が回答を消費し損ねたケースでは
	 * 残り 45 秒のあいだ何度押しても無言で拒否され続けていた。
	 */
	private releaseInteractionClaimsFor(token: string, filter?: string): void {
		// filter は 'question' / 'approval'（kind 単位）か、interaction id そのもの。
		// キーは `token\0epoch\0kind\0id`。
		for (const key of [...this.interactionClaims.keys()]) {
			const parts = key.split('\0');
			if (parts[0] !== token) {
				continue;
			}
			if (filter === undefined || parts[2] === filter || parts[3] === filter) {
				this.interactionClaims.delete(key);
			}
		}
	}

	private actionKey(mobileId: string, requestId: string): string {
		return `${mobileId}\0${requestId}`;
	}

	private ownerForPane(terminalId: number, token: string): IParadisMobilePaneOwner | undefined {
		return this.paneRegistry.ownerOf(token, terminalId);
	}

	private codexControlSession(mobileId: string, terminalId: number, paneToken?: string): { readonly token: string; readonly owner: IParadisMobilePaneOwner } | undefined {
		const token = this.resolveInboundToken(terminalId, paneToken);
		const session = token !== undefined ? this.paneSessions.get(token) : undefined;
		const owner = token !== undefined ? this.ownerForPane(terminalId, token) : undefined;
		if (token === undefined || session?.agent !== 'codex' || session.sessionId === undefined || owner === undefined || !this.hasSubscriber(token, mobileId)) {
			return undefined;
		}
		return { token, owner };
	}

	/**
	 * Codex のモデル一覧（古いモバイルアプリが求めてくる）。走っている Codex へ設定を渡す口が無いので、
	 * 待たせずに「モバイルからは変えられない」と返す（新しいアプリは info.modelControl で画面を開かない）。
	 */
	private async handleModelCatalogRequest(mobileId: string, msg: { readonly id: number; readonly token?: string; readonly requestId: string }): Promise<void> {
		const session = this.codexControlSession(mobileId, msg.id, msg.token);
		if (session === undefined) {
			this.sendControlError(mobileId, msg.id, msg.requestId, 'unavailable', '操作対象のCodexセッションを確認できません', msg.token);
			return;
		}
		this.sendControlError(mobileId, msg.id, msg.requestId, 'unsupported', PARADIS_CODEX_MODEL_CONTROL_UNSUPPORTED_MESSAGE, session.token, session.owner);
	}

	private async handleCommandCatalogRequest(mobileId: string, msg: Extract<AgentInbound, { t: 'command-catalog' }>): Promise<void> {
		const requestKey = `${mobileId}\0${msg.requestId}`;
		const inFlightForMobile = [...this.commandCatalogRequests.keys()].filter(key => key.startsWith(`${mobileId}\0`)).length;
		if (this.commandCatalogRequests.has(requestKey) || inFlightForMobile >= 4) {
			this.sendCommandCatalogError(mobileId, msg, 'コマンド一覧を取得中です。少し待ってからお試しください');
			return;
		}

		// Reserve before waiting so reconnect races cannot create unbounded waiters.
		this.commandCatalogRequests.set(requestKey, msg.token ?? '');
		try {
			const context = await this.waitForCommandCatalogContext(mobileId, msg);
			if (context === undefined) {
				this.sendCommandCatalogError(mobileId, msg, 'PC側のエージェント接続を同期中です。詳細画面を再接続してからお試しください');
				return;
			}
			const { token, session, owner, cwd } = context;
			const inFlightForToken = [...this.commandCatalogRequests.entries()]
				.filter(([key, value]) => key !== requestKey && value === token).length;
			if (inFlightForToken >= 2) {
				this.sendCommandCatalogError(mobileId, msg, 'コマンド一覧を取得中です。少し待ってからお試しください');
				return;
			}
			this.commandCatalogRequests.set(requestKey, token);

			const catalog = await this.agentCommandCatalog(token, session, cwd);
			const commands = msg.format === 2 ? catalog : paradisLegacyAgentCommandCatalog(catalog);
			const currentOwner = this.ownerForPane(msg.id, token);
			if (this.paneSessions.get(token) !== session || this.tokenToCwd.get(token) !== cwd || currentOwner === undefined
				|| !this.samePaneOwner(currentOwner, owner) || !this.hasSubscriber(token, mobileId) || !await this.authorizeOwner(owner)) {
				this.sendCommandCatalogError(mobileId, msg, '対象セッションが切り替わりました');
				return;
			}
			if (!await this.sendToAuthorized(mobileId, { t: 'command-catalog', id: msg.id, requestId: msg.requestId, commands, ...(msg.format === 2 ? { format: 2 as const } : {}) }, token, owner)) {
				this.sendCommandCatalogError(mobileId, msg, '対象セッションが切り替わりました');
			}
		} catch {
			this.sendCommandCatalogError(mobileId, msg, 'コマンド一覧を取得できませんでした');
		} finally {
			this.commandCatalogRequests.delete(requestKey);
		}
	}

	/**
	 * そのペインで使えるスラッシュコマンド（モバイルとデスクトップのチャット欄で共有。{@link COMMAND_CATALOG_CACHE_MS} だけ覚える）。
	 * - SSH の接続先で動くペイン: 手元の設定は読まず、組み込みだけ
	 * - mod（1.2.0 以降）が生きている Claude: mod の `$.command.list()`（プラグイン・MCP の prompt を含む、Claude Code の候補と同じ順）
	 * - それ以外: ファイルから組み立てる
	 */
	private agentCommandCatalog(token: string, session: IPaneSessionInfo, cwd: string): Promise<readonly IParadisAgentCommandOption[]> {
		const remote = this.isRemoteAgentPane(token);
		const codexVersion = session.agent === 'codex' ? this.tailers.get(token)?.cliVersion : undefined;
		const key = [token, session.sessionId ?? '', session.agent, cwd, remote ? 'remote' : 'local', codexVersion ?? ''].join('\0');
		const now = Date.now();
		for (const [candidate, entry] of this.commandCatalogCache) {
			if (now - entry.at >= COMMAND_CATALOG_CACHE_MS) {
				this.commandCatalogCache.delete(candidate);
			}
		}
		const cached = this.commandCatalogCache.get(key);
		if (cached !== undefined) {
			return cached.promise;
		}
		const promise = (async (): Promise<readonly IParadisAgentCommandOption[]> => {
			if (remote) {
				// 接続先のコマンドは手元からは分からない（向こうの設定を読む口が無い）。組み込みだけを返す
				return paradisBuiltInAgentCommands(session.agent);
			}
			const sessionId = session.sessionId;
			if (session.agent === 'claude' && sessionId !== undefined && this.claudeModBridge.supports(token, sessionId, 'commands.list')) {
				const listed = paradisNormalizeModCommandList(await this.claudeModBridge.listCommands(token, sessionId).catch(() => undefined));
				if (listed !== undefined && listed.length > 0) {
					return listed;
				}
			}
			return paradisBuildAgentCommandCatalog(session.agent, cwd, { ...(codexVersion !== undefined ? { codexVersion } : {}) });
		})();
		this.commandCatalogCache.set(key, { at: now, promise });
		// 失敗した一覧は覚えない（次の `/` で取り直す）
		promise.catch(() => this.commandCatalogCache.delete(key));
		return promise;
	}

	private async waitForCommandCatalogContext(mobileId: string, msg: Extract<AgentInbound, { t: 'command-catalog' }>): Promise<ICommandCatalogContext | undefined> {
		let requestedOwner: string | undefined;
		for (let attempt = 0; attempt < 20; attempt++) {
			const token = this.resolveInboundToken(msg.id, msg.token);
			const session = token !== undefined ? this.paneSessions.get(token) : undefined;
			const owner = token !== undefined ? this.ownerForPane(msg.id, token) : undefined;
			const cwd = token !== undefined ? this.tokenToCwd.get(token) : undefined;
			if (owner !== undefined && cwd === undefined) {
				const ownerKey = `${owner.windowId}\0${owner.windowSession}\0${owner.rendererGeneration}`;
				if (requestedOwner !== ownerKey) {
					requestedOwner = ownerKey;
					try {
						this.requestPaneSync(owner);
					} catch (error) {
						this.logService.warn('[paradisAgentChat] renderer pane sync request failed', error);
					}
				}
			}
			if (token !== undefined && session !== undefined && owner !== undefined && cwd !== undefined
				&& this.hasSubscriber(token, mobileId) && await this.authorizeOwner(owner).catch(() => false)) {
				const currentOwner = this.ownerForPane(msg.id, token);
				if (currentOwner !== undefined && this.samePaneOwner(currentOwner, owner)
					&& this.hasSubscriber(token, mobileId)
					&& this.paneSessions.get(token) === session
					&& this.tokenToCwd.get(token) === cwd) {
					return { token, session, owner, cwd };
				}
			}
			await new Promise<void>(resolve => setTimeout(resolve, 50));
		}
		return undefined;
	}

	private sendCommandCatalogError(mobileId: string, msg: Extract<AgentInbound, { t: 'command-catalog' }>, message: string): void {
		// Request failures contain no pane data and must reach the paired mobile even
		// before attach/subscriber recovery completes. The original token and
		// requestId let the mobile reject a same-terminal-id response from another window.
		const token = msg.token;
		const response: AgentOutbound = {
			t: 'command-catalog-error', id: msg.id, requestId: msg.requestId, message
		};
		this.send(mobileId, encoder.encode(JSON.stringify({ ...response, ...(token !== undefined ? { token } : {}) })));
	}

	/** Codex のモデルと effort の変更（古いモバイルアプリから）。モデル一覧と同じく、変えられないと返す。 */
	private async handleSettingsUpdateRequest(mobileId: string, msg: { readonly id: number; readonly token?: string; readonly requestId: string; readonly model: string; readonly effort: string }): Promise<void> {
		const session = this.codexControlSession(mobileId, msg.id, msg.token);
		if (session === undefined) {
			this.sendControlError(mobileId, msg.id, msg.requestId, 'unavailable', '操作対象のCodexセッションを確認できません', msg.token);
			return;
		}
		if (!await this.authorizeOwner(session.owner)) {
			this.sendTo(mobileId, { t: 'settings-update', id: msg.id, requestId: msg.requestId, status: 'failed', code: 'stale-session', message: '操作対象のウィンドウが切り替わりました' }, session.token);
			return;
		}
		this.sendTo(mobileId, { t: 'settings-update', id: msg.id, requestId: msg.requestId, status: 'failed', code: 'unsupported', message: PARADIS_CODEX_MODEL_CONTROL_UNSUPPORTED_MESSAGE }, session.token, session.owner);
	}

	private sendControlError(mobileId: string, terminalId: number, requestId: string, code: string, message: string, token?: string, owner?: IParadisMobilePaneOwner): void {
		this.sendTo(mobileId, { t: 'model-control-error', id: terminalId, requestId, code, message }, token, owner);
	}

	private samePaneOwner(a: IParadisMobilePaneOwner, b: IParadisMobilePaneOwner): boolean {
		return a.windowId === b.windowId && a.windowSession === b.windowSession && a.rendererGeneration === b.rendererGeneration
			&& a.terminalId === b.terminalId && a.token === b.token;
	}

	private async handleAttach(mobileId: string, msg: { id: number; token?: string; epoch?: string; afterRev?: number; liveEncoding?: string }, retry = false): Promise<void> {
		const pendingKey = this.pendingAttachKey(mobileId, msg.id, msg.token);
		const attachGeneration = retry ? this.attachGenerations.get(pendingKey) : ++this.attachGenerationCounter;
		if (attachGeneration === undefined || this.attachDisposed) {
			return;
		}
		if (!retry) {
			this.attachGenerations.set(pendingKey, attachGeneration);
			this.clearPendingAttach(pendingKey);
		}
		const token = this.resolveInboundToken(msg.id, msg.token);
		const owner = token !== undefined ? this.ownerForPane(msg.id, token) : undefined;
		if (token === undefined || owner === undefined) {
			if (msg.token !== undefined) {
				this.deferAttach(pendingKey, mobileId, msg);
			} else {
				this.clearAttachGeneration(pendingKey, attachGeneration);
			}
			return;
		}
		// authority待ちの間もpendingを保持する。Renderer交代syncが先行した場合は同じ
		// generationのretryが新ownerで走り、detach/drop/期限切れはgenerationを無効化する。
		const pendingAttach = this.deferAttach(pendingKey, mobileId, msg);
		const attempt = ++pendingAttach.attempt;
		const authorized = await this.authorizeOwner(owner);
		if (this.attachDisposed || this.attachGenerations.get(pendingKey) !== attachGeneration
			|| this.pendingAttaches.get(pendingKey) !== pendingAttach || pendingAttach.attempt !== attempt) {
			return;
		}
		const currentOwner = this.ownerForPane(msg.id, token);
		if (!authorized || currentOwner === undefined || !this.samePaneOwner(currentOwner, owner)) {
			return;
		}
		this.clearPendingAttach(pendingKey);
		try {
			const currentSession = this.paneSessions.get(token);
			if (currentSession === undefined) {
				// エージェント未起動、または探索でも見つからない。モバイル側は
				// 「ターミナルタブで見る」案内を出す。トークンが分かる場合は購読者として
				// 記録しておき、後からhookでセッションが判明したら自動でスナップショットを
				// 送り直す(エージェント起動を待たずにattachしたケースの自己回復)。
				this.addSubscriber(token, mobileId, owner, msg.liveEncoding);
				this.sendTo(mobileId, { t: 'none', id: msg.id }, token, owner);
				return;
			}
			this.addSubscriber(token, mobileId, owner, msg.liveEncoding);
			const tailer = this.ensureTailer(token, currentSession);
			await tailer.ready;
			// attach処理中に購読またはセッションが置き換わっていたら旧snapshotを送らない。
			if (this.attachDisposed || this.attachGenerations.get(pendingKey) !== attachGeneration
				|| !this.hasSubscriber(token, mobileId) || this.paneSessions.get(token) !== currentSession || this.tailers.get(token) !== tailer) {
				return;
			}
			const afterRev = msg.afterRev;
			// 差分応答は「afterRevの続きが欠けなくリングに残っている」場合のみ。切断中に
			// リング上限を超えて古い分が退避済みだと、先頭revが飛んでいてサイレント欠落に
			// なるため、その場合は全量スナップショットへフォールバックする。
			const oldestRev = tailer.messages.length > 0 ? tailer.messages[0].rev : tailer.rev;
			const info = this.infoOf(token, tailer);
			const live = this.liveStates.get(token) ?? null;
			const liveRevision = this.liveRevisions.get(token) ?? 0;
			const activity = this.activityTrackers.get(token)?.snapshot() ?? null;
			const interaction = tailer.currentInteraction();
			if (msg.epoch === tailer.epoch && typeof afterRev === 'number' && afterRev >= oldestRev - 1) {
				// モバイルが同一epochの途中まで持っている → 差分のみ (リレー瞬断からの再接続)
				const messages = tailer.messages.filter(m => m.rev > afterRev);
				this.sendTo(mobileId, { t: 'delta', id: msg.id, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages, ...(info !== undefined ? { info } : {}), live, liveRevision, activity, interaction, capabilities: { agentActions: true, ...(tailer.agent === 'claude' ? { claudeSettings: true } : {}) }, ...this.monitorsField(token, tailer) }, token, owner);
			} else {
				const messages = tailer.messages.slice(-SNAPSHOT_SEND_LIMIT);
				this.sendTo(mobileId, {
					t: 'snapshot', id: msg.id, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages,
					...(tailer.wasInitialTruncated || tailer.messages.length > messages.length ? { truncated: true } : {}),
					...(info !== undefined ? { info } : {}),
					live, liveRevision, activity, interaction, capabilities: { agentActions: true, ...(tailer.agent === 'claude' ? { claudeSettings: true } : {}) },
					...this.monitorsField(token, tailer),
				}, token, owner);
			}
		} finally {
			this.clearAttachGeneration(pendingKey, attachGeneration);
		}
	}

	private pendingAttachKey(mobileId: string, terminalId: number, token: string | undefined): string {
		return `${mobileId}\0${terminalId}\0${token ?? ''}`;
	}

	private deferAttach(key: string, mobileId: string, msg: { id: number; token?: string; epoch?: string; afterRev?: number; liveEncoding?: string }): { readonly mobileId: string; readonly msg: { id: number; token?: string; epoch?: string; afterRev?: number; liveEncoding?: string }; readonly timer: ReturnType<typeof setTimeout>; attempt: number } {
		const existing = this.pendingAttaches.get(key);
		if (existing !== undefined) {
			return existing;
		}
		while (this.pendingAttaches.size >= 256) {
			const oldest = this.pendingAttaches.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.cancelAttach(oldest);
		}
		const timer = setTimeout(() => this.cancelAttach(key), 15_000);
		const pending = { mobileId, msg, timer, attempt: 0 };
		this.pendingAttaches.set(key, pending);
		return pending;
	}

	private clearPendingAttach(key: string): void {
		const pending = this.pendingAttaches.get(key);
		if (pending !== undefined) {
			clearTimeout(pending.timer);
			this.pendingAttaches.delete(key);
		}
	}

	private cancelAttach(key: string): void {
		this.clearPendingAttach(key);
		this.attachGenerations.delete(key);
	}

	private clearAttachGeneration(key: string, generation: number): void {
		if (this.attachGenerations.get(key) === generation) {
			this.attachGenerations.delete(key);
		}
	}

	/** tool_inputからティッカーに有用な短い説明だけを抽出する（巨大なJSONは送らない）。 */
	private static toolDetail(toolInput: unknown): string | undefined {
		const input = rec(toolInput);
		if (input === undefined) {
			return undefined;
		}
		for (const key of ['command', 'file_path', 'path', 'query', 'pattern', 'url', 'description']) {
			const value = str(input[key]);
			if (value !== undefined && value.trim().length > 0) {
				return truncateText(value.trim().replace(/\s+/g, ' '), 500);
			}
		}
		return undefined;
	}

	/** hookを履歴とは独立したライブ状態へ反映する。 */
	private updateLiveFromHook(event: IParadisAgentHookEvent): void {
		if (paradisIsLateHookAfterTurnEnd(event.event, event.at, this.lastTurnEndedAt.get(event.token))) {
			return;
		}
		switch (event.event) {
			case 'UserPromptSubmit':
				this.liveToolIds.delete(event.token);
				this.liveMessageBuffers.delete(event.token);
				this.lastTurnEndedAt.delete(event.token);
				this.setLiveState(event.token, {
					phase: 'thinking', source: 'hook', startedAt: event.at, updatedAt: event.at,
				});
				return;
			case 'PreToolUse': {
				if (event.toolUseId !== undefined) {
					this.liveToolIds.set(event.token, event.toolUseId);
				} else {
					this.liveToolIds.delete(event.token);
				}
				const phase = event.toolName === 'AskUserQuestion' ? 'permission' : 'tool';
				const detail = ParadisMobileAgentChat.toolDetail(event.toolInput);
				this.setLiveState(event.token, {
					phase, source: 'hook', startedAt: event.at, updatedAt: event.at,
					...(event.toolName !== undefined ? { tool: event.toolName === 'WebSearch' ? 'web_search' : event.toolName } : {}),
					...(detail !== undefined ? { detail } : {}),
				});
				return;
			}
			case 'PostToolUse':
			case 'PostToolUseFailure':
			case 'PermissionDenied': {
				const currentToolId = this.liveToolIds.get(event.token);
				if (event.toolUseId !== undefined && currentToolId !== undefined && event.toolUseId !== currentToolId) {
					return;
				}
				this.liveToolIds.delete(event.token);
				const previous = this.liveStates.get(event.token);
				this.setLiveState(event.token, {
					phase: 'thinking', source: 'hook', startedAt: previous?.startedAt ?? event.at, updatedAt: event.at,
				});
				return;
			}
			case 'PermissionRequest': {
				// 許可が決着したときに戻せるよう、許可を待つ前の様子を覚える（決着を知らせる hook が来ない
				// 拒否があるため。settleLiveAfterApprovals）。
				const before = this.liveStates.get(event.token);
				if (before?.phase !== 'permission') {
					this.liveBeforePermission.set(event.token, before);
				}
				const detail = ParadisMobileAgentChat.toolDetail(event.toolInput);
				this.setLiveState(event.token, {
					phase: 'permission', source: 'hook', startedAt: event.at, updatedAt: event.at,
					...(event.toolName !== undefined ? { tool: event.toolName } : {}),
					...(detail !== undefined ? { detail } : {}),
				});
				return;
			}
			case 'MessageDisplay':
				this.updateLiveMessage(event);
				return;
		}
	}

	/** MessageDisplayの重複バッチを除外し、同一メッセージのdeltaを順番に連結する。 */
	private updateLiveMessage(event: IParadisAgentHookEvent): void {
		if (event.messageId === undefined || event.messageDelta === undefined || event.messageIndex === undefined) {
			return;
		}
		// mod（Claude Mods）が生成中の文章を流しているなら、そちらが速くて細かい（行単位の hook は使わない）
		if (this.modStreamingFor(event.token, event.at)) {
			return;
		}
		const previous = this.liveMessageBuffers.get(event.token);
		if (previous?.messageId === event.messageId && event.messageIndex <= previous.lastIndex) {
			return;
		}
		const startedAt = previous?.messageId === event.messageId ? previous.startedAt : event.at;
		const prefix = previous?.messageId === event.messageId ? previous.text : '';
		const text = truncateLiveText(prefix + event.messageDelta, TEXT_LIMIT);
		const buffer = {
			messageId: event.messageId,
			lastIndex: event.messageIndex,
			text,
			startedAt,
			final: event.messageFinal === true,
		};
		this.liveMessageBuffers.set(event.token, buffer);
		this.setLiveState(event.token, {
			phase: 'message', source: 'hook', startedAt, updatedAt: event.at, text,
			...(buffer.final ? { final: true } : {}),
		});
	}

	private setLiveState(token: string, state: IParadisAgentLiveState): void {
		const previous = this.liveStates.get(token);
		const baseRevision = this.liveRevisions.get(token) ?? 0;
		const revision = baseRevision + 1;
		this.liveStates.set(token, state);
		this.liveRevisions.set(token, revision);
		this.pushLiveToSubscribers(token, previous, state, baseRevision, revision);
		this.scheduleDesktopChatCheck();
	}

	private clearLiveState(token: string): void {
		const hadState = this.liveStates.delete(token);
		this.liveToolIds.delete(token);
		this.liveMessageBuffers.delete(token);
		if (hadState) {
			const revision = (this.liveRevisions.get(token) ?? 0) + 1;
			this.liveRevisions.set(token, revision);
			this.pushFullLiveToSubscribers(token, null, revision);
			this.scheduleDesktopChatCheck();
		}
	}

	/** Stop系hookを通常経路・保留経路とも同じ完全な終了状態へ収束させる。 */
	private completeTurnFromHook(event: IParadisAgentHookEvent): boolean {
		const live = this.liveStates.get(event.token);
		if (live !== undefined && live.startedAt > event.at) {
			return false; // この終了より後に始まったターンが進行中
		}
		this.lastTurnEndedAt.set(event.token, event.at);
		this.activeTurnTokens.delete(event.token);
		this.liveBeforePermission.delete(event.token);
		this.clearLiveState(event.token);
		const tracker = this.activityTrackers.get(event.token);
		const activityEnded = event.event === 'SessionEnd'
			? tracker?.endSession('interrupted', event.at) === true
			: tracker?.endTurn(event.at) === true;
		if (activityEnded) {
			this.pushActivityToSubscribers(event.token);
		}
		const tailer = this.tailers.get(event.token);
		tailer?.clearApprovalRequest(undefined, true, true);
		tailer?.clearPendingQuestions();
		this.releaseInteractionClaimsFor(event.token);
		this.schedulePersistedAgentActivityReconcile(event.token);
		return true;
	}

	/**
	 * 完了シグナルを取りこぼした live 状態を失効させる最終防衛線（60秒周期）。
	 *
	 * activeTurnTokens も一緒に落とすのは、Stop hook が破棄されるとターン管理も同時に stuck
	 * するため。これを残すと live を消しても isAgentPrompt が false のままになり、モバイルからの
	 * モデル・Effort 変更が「Claude Codeが入力待ちの時だけ設定を変更できます」で拒否され続ける。
	 *
	 * 一方 fireParadisAgentTurnEnded は意図的に発火しない。発火するとペイン状態が review へ移り
	 * 「エージェントが作業を完了しました」の偽プッシュ通知が飛ぶ。ここは「完了を検知した」のでは
	 * なく「完了を検知できなかった」場面なので、通知は出さず表示の固着だけを解く。
	 */
	private sweepStaleLiveStates(now: number): void {
		for (const [token, live] of [...this.liveStates]) {
			const idleMs = now - live.updatedAt;
			if (idleMs <= LIVE_STALE_MS) {
				continue;
			}
			this.logService.warn(`[ParadisMobileAgentChat] sweeping stale live state after ${Math.round(idleMs / 1000)}s without updates (phase=${live.phase})`);
			this.activeTurnTokens.delete(token);
			this.clearLiveState(token);
		}
	}

	/** transcriptに永続化される長時間ツールprogressを、hookティッカーの補足へ反映する。 */
	private updateLiveFromProgress(token: string, progress: ITranscriptProgress): void {
		const previous = this.liveStates.get(token);
		// 生成本文の先出しが始まった後に、遅れてflushされたツールprogressで上書きしない。
		if (previous?.phase === 'message') {
			return;
		}
		const now = Date.now();
		if (progress.done) {
			this.setLiveState(token, {
				phase: 'thinking', source: 'transcript', startedAt: previous?.startedAt ?? now, updatedAt: now,
			});
			return;
		}
		const startedAt = progress.elapsedSeconds !== undefined
			? now - progress.elapsedSeconds * 1000
			: previous?.phase === 'tool' ? previous.startedAt : now;
		this.setLiveState(token, {
			phase: 'tool', source: 'transcript', startedAt, updatedAt: now, tool: progress.tool,
			...(progress.detail !== undefined ? { detail: progress.detail } : {}),
			...(progress.elapsedSeconds !== undefined ? { elapsedSeconds: progress.elapsedSeconds } : {}),
		});
	}

	/**
	 * 会話の追記で読んだ Advisor の呼び出し・結果を、一覧（サブエージェントの画面のアドバイザー）と生成中の表示へ
	 * 当てる。生成中の表示は `tool:'Advisor'`・`detail:<モデル>` にする（古いアプリは「実行中: Advisor」と出す）。
	 * この経路は親の会話の transcript だけなので、サブエージェントの中の相談は親の生成中の表示に上がらない。
	 */
	private applyAdvisorMessages(token: string, messages: readonly IParadisAgentChatMessage[]): void {
		const now = Date.now();
		const tracker = this.activityTracker(token);
		const advisors: IParadisAgentAdvisorUpdate[] = [];
		let started: { readonly id: string; readonly model?: string; readonly startedAt: number } | undefined;
		const ended = new Set<string>();
		for (const message of messages) {
			const id = message.toolUseId;
			const info = message.advisor;
			if (id === undefined || info === undefined) {
				continue;
			}
			const at = Math.min(message.ts ?? now, now);
			if (message.kind === 'tool_use') {
				// mod の行にはモデル名が無いことがある。相談中の行だけ、前の相談で分かったモデル名で補う
				// （結果や読み直しの値は transcript のモデル名を正本にする）
				const model = info.model ?? tracker.advisorModel();
				advisors.push({ id, ...(model !== undefined ? { model } : {}), status: 'running', startedAt: at, updatedAt: at });
				started = { id, ...(model !== undefined ? { model } : {}), startedAt: at };
			} else if (message.kind === 'tool_result') {
				const outcome = info.outcome ?? 'redacted';
				advisors.push({
					id, ...(info.model !== undefined ? { model: info.model } : {}),
					status: outcome === 'error' ? 'failed' : 'completed', outcome,
					...(info.errorCode !== undefined ? { errorCode: info.errorCode } : {}),
					...(outcome === 'text' ? this.advisorReplyText(token, message) : {}),
					startedAt: at, updatedAt: at,
				});
				ended.add(id);
				if (started?.id === id) {
					started = undefined;
				}
			}
		}
		if (tracker.applyAdvisors(advisors, now)) {
			this.pushActivityToSubscribers(token);
		}
		const current = this.liveStates.get(token);
		if (started !== undefined && !ended.has(started.id)) {
			const model = started.model;
			this.advisorLiveIds.set(token, started.id);
			this.setLiveState(token, {
				phase: 'tool', source: 'transcript', startedAt: started.startedAt, updatedAt: now, tool: PARADIS_ADVISOR_TOOL,
				...(model !== undefined ? { detail: model } : {}),
			});
		} else if (current?.phase === 'tool' && current.tool === PARADIS_ADVISOR_TOOL && ended.has(this.advisorLiveIds.get(token) ?? '')) {
			// 返答が来た。エージェントは続けて考える（次の hook・本文で置き換わる）
			this.advisorLiveIds.delete(token);
			this.setLiveState(token, { phase: 'thinking', source: 'transcript', startedAt: now, updatedAt: now });
		}
	}

	/** 平文の返答の本文。会話の行は切り詰めてあるので、tailer が退避した全文があればそちらを使う。 */
	private advisorReplyText(token: string, message: IParadisAgentChatMessage): { readonly text: string; readonly textTruncated?: true } {
		const full = message.truncated === true ? this.tailers.get(token)?.fullTextFor(message.rev) : undefined;
		const text = full ?? message.text;
		return { text, ...(full === undefined && message.truncated === true ? { textTruncated: true } : {}) };
	}

	/** 現在attach中の全モバイルへライブ状態だけを空deltaとして送る。 */
	private pushLiveToSubscribers(token: string, previous: IParadisAgentLiveState | undefined, live: IParadisAgentLiveState, baseRevision: number, revision: number): void {
		const terminalId = this.terminalIdForToken(token);
		const tailer = this.tailers.get(token);
		if (terminalId !== undefined && tailer !== undefined) {
			for (const [mobileId, subscriber] of this.subscribers.get(token) ?? []) {
				const livePayload = paradisAgentLivePayloadForEncoding(subscriber.liveEncoding, previous, live, baseRevision, revision);
				this.sendTo(mobileId, {
					t: 'delta', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev,
					messages: [], ...livePayload,
				}, token, subscriber.owner);
			}
		}
	}

	private pushFullLiveToSubscribers(token: string, live: IParadisAgentLiveState | null, liveRevision: number): void {
		const terminalId = this.terminalIdForToken(token);
		const tailer = this.tailers.get(token);
		if (terminalId !== undefined && tailer !== undefined) {
			this.sendToSubscribers(token, {
				t: 'delta', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev,
				messages: [], live, liveRevision,
			});
		}
	}

	// ---- Claude Code の mod（Claude Mods） ----------------------------------------------------------
	//
	// mod（resources/paradis/claude-mod）が読み込まれたペインでは、今の hook・transcript・キーの経路と並べて
	// 次を使う（paradisClaudeModBridge.ts）。mod が来ない・止まったペインでは、どれも今の経路だけで動く。
	//  - 観測: 会話の行（uuid で重複を除き、速い方を使う）・生成中の文章・ターンの始まりと終わり
	//  - サブエージェント: 開始＝Agent の tool.call の結果、再開＝SubagentStart の再送、終了＝agentId 付きの turn.complete
	//  - 質問・承認: モバイルの回答をキーではなく値で mod へ渡す（PC の TUI と並んで、先に答えた方を使う）
	//  - 送信: エージェントが待機中のときだけ mod の `$.prompt.submit` で送る

	/** mod が流している生成中の文章（本会話のいまのブロック）。 */
	private readonly modLive = new Map<string, { readonly turnId: string; readonly step: number; readonly index: number; readonly text: string; readonly startedAt: number }>();
	/** mod から生成中の文章が最後に届いた時刻（MessageDisplay hook より mod を使う判断に使う）。 */
	private readonly modStreamedAt = new Map<string, number>();
	/** mod へ渡した回答（`token\0kind\0interactionId` → 時刻）。同じカードへの二度目をキーの経路へ回さない。 */
	private readonly modAnswered = new Map<string, number>();
	/** mod で送っている最中の発言（actionKey）。同じ requestId の二度目を弾く。 */
	private readonly modSendRequests = new Set<string>();
	/** ペインごとに、mod へ渡して行方を待っている発言（受け取った・送れた・失敗で決着する）。 */
	private readonly modSendsInFlight = new Map<string, Promise<void>>();
	/** mod の承認に合うカードが無いときに、自前で出すまでの待ち（hook のカードが先に来るのを待つ）。 */
	private readonly modApprovalTimers = new Map<string, ReturnType<typeof setTimeout>>();

	private onModEvent(event: ParadisClaudeModEvent): void {
		const token = event.token;
		const session = this.paneSessions.get(token);
		// ペインの今の会話から来たものだけ使う（同じペインで別に起動した claude -p などは無視する）
		if (session === undefined || session.agent !== 'claude' || session.sessionId !== event.sessionId || !this.isLiveToken(token)) {
			return;
		}
		if (event.type === 'alive-changed' || event.type === 'hello' || event.type === 'bye' || event.type === 'pending-changed') {
			this.resendShellsAccessIfChanged(token);
		}
		switch (event.type) {
			case 'row': {
				const tailer = this.tailers.get(token);
				if (tailer === undefined || tailer.transcriptPath !== session.transcriptPath) {
					return;
				}
				const content = event.message.content;
				if (!event.verified && !paradisIsDisplayOnlyModRow(event.door, event.message.role, content)) {
					// 送り主を確かめていない行は、応答の文章と思考だけを表示に使う。ツールの呼び出し（質問・Agent・Monitor など）や
					// 発言を含む行は、カード・回答待ち・サブエージェントの状態を作れてしまうので捨て、ファイルの行に任せる
					return;
				}
				if (event.verified) {
					this.rememberAgentEvidence(token);
				}
				const ingested = tailer.ingestModRow(event);
				if (event.door === 'response' && Array.isArray(content) && content.some(block => rec(block)?.type === 'text')) {
					// 確定した本文が会話に入ったので、生成中の文章は消す（二重に見せない）
					void ingested.then(() => this.clearModLive(token));
				}
				return;
			}
			case 'turn.start':
				this.activeTurnTokens.add(token);
				this.lastTurnEndedAt.delete(token);
				this.modLive.delete(token);
				if (!this.liveStates.has(token)) {
					this.setLiveState(token, { phase: 'thinking', source: 'hook', startedAt: event.at, updatedAt: event.at });
				}
				return;
			case 'turn.complete':
				if (event.agentId !== undefined) {
					this.endModSubagent(token, event.agentId, event.aborted ? 'interrupted' : event.reason === 'error' || event.reason === 'refusal' ? 'failed' : 'completed', event.at);
					return;
				}
				// 本会話のターンの終わり。承認のカード・質問・ペインの状態の片付けは hook の Stop に任せる
				// （mod の知らせだけで承認や質問を消さない）。生成中の文章の控えだけを捨てる。
				this.modLive.delete(token);
				return;
			case 'step':
				this.updateLiveFromModStep(token, event.turnId, event.step, event.chunks, event.end, event.at);
				return;
			case 'subagent.start':
				this.startModSubagent(token, event.agentId, event.at, event.subagentType ?? event.name, event.description, false, event.toolUseId);
				return;
			case 'subagent.resume':
				this.startModSubagent(token, event.agentId, event.at, event.agentType, undefined, true);
				return;
			case 'pending-changed':
				if (event.kind === 'permission') {
					this.refreshModApprovals(token);
				} else {
					this.refreshModQuestions(token);
				}
				return;
			case 'bye':
				this.modLive.delete(token);
				this.modStreamedAt.delete(token);
				return;
			default:
				return;
		}
	}

	/** mod がこのペインへ生成中の文章を流しているか（流していれば MessageDisplay hook の先出しは使わない）。 */
	private modStreamingFor(token: string, at: number): boolean {
		const streamedAt = this.modStreamedAt.get(token);
		return streamedAt !== undefined && at - streamedAt < MOD_STREAM_PREFERRED_MS && this.claudeModBridge.isAlive(token, this.paneSessions.get(token)?.sessionId);
	}

	private updateLiveFromModStep(token: string, turnId: string, step: number, chunks: readonly { readonly index: number; readonly text: string }[], end: boolean, at: number): void {
		if (paradisIsLateHookAfterTurnEnd('MessageDisplay', at, this.lastTurnEndedAt.get(token))) {
			return;
		}
		this.modStreamedAt.set(token, at);
		let current = this.modLive.get(token);
		let changed = false;
		for (const chunk of chunks) {
			if (current === undefined || current.turnId !== turnId || current.step !== step || current.index !== chunk.index) {
				current = { turnId, step, index: chunk.index, text: '', startedAt: at };
			}
			current = { ...current, text: truncateLiveText(current.text + chunk.text, TEXT_LIMIT) };
			changed = true;
		}
		if (current === undefined || (!changed && !end) || current.turnId !== turnId || current.step !== step || current.text.length === 0) {
			return;
		}
		this.modLive.set(token, current);
		this.setLiveState(token, {
			phase: 'message', source: 'hook', startedAt: current.startedAt, updatedAt: at, text: current.text,
			...(end ? { final: true } : {}),
		});
	}

	private clearModLive(token: string): void {
		if (this.modLive.delete(token) && this.liveStates.get(token)?.phase === 'message') {
			this.clearLiveState(token);
		}
	}

	/**
	 * mod の無い Claude ペインで、Agent / Task の PreToolUse の tool_use_id と、直後の SubagentStart の子を結ぶ
	 * （hook の payload には結果が無いので、記録の読み直しを待たずに会話のカードを一覧へ結ぶため）。
	 * 待っている呼び出しが Agent 1 件だけのときだけ結ぶ。並列の起動や SendMessage の再開と重なって
	 * どれがどの子か分からないときは結ばず、待ちを捨てる（記録の読み直しで結ばれる）。
	 */
	private linkSubagentStartFromHooks(event: IParadisAgentHookEvent, freshSubagent: string | undefined, tracker: ParadisAgentActivityTracker): boolean {
		const token = event.token;
		if (event.event === 'UserPromptSubmit' || paradisIsTurnEndHookEvent(event.event) || event.event === 'SessionStart') {
			this.pendingSubagentCalls.delete(token);
			return false;
		}
		let pending = this.pendingSubagentCalls.get(token);
		if (event.event === 'PreToolUse' && event.toolUseId !== undefined && (event.toolName === 'Agent' || event.toolName === 'Task' || event.toolName === 'SendMessage')) {
			if (pending === undefined) {
				pending = { launches: new Map(), resumes: new Map() };
				this.pendingSubagentCalls.set(token, pending);
			}
			const target = event.toolName === 'SendMessage' ? pending.resumes : pending.launches;
			if (target.size < PARADIS_OPEN_TOOL_USE_LIMIT) {
				target.set(event.toolUseId, event.at);
			}
			return false;
		}
		if (pending === undefined) {
			return false;
		}
		if ((event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') && event.toolUseId !== undefined) {
			pending.launches.delete(event.toolUseId);
			pending.resumes.delete(event.toolUseId);
		} else if (event.event === 'SubagentStart') {
			// 届かなかった SubagentStart（許可を断った起動など）の待ちが、次の起動と組まないよう古いものは捨てる
			for (const calls of [pending.launches, pending.resumes]) {
				for (const [toolUseId, at] of calls) {
					if (event.at - at > SUBAGENT_START_PAIRING_WINDOW_MS) { calls.delete(toolUseId); }
				}
			}
			const [only] = pending.launches.size === 1 && pending.resumes.size === 0 ? pending.launches.keys() : [];
			if (freshSubagent !== undefined && only !== undefined) {
				pending.launches.delete(only);
				return tracker.linkToolUse(freshSubagent, only, event.at, true);
			}
			if (freshSubagent !== undefined || pending.launches.size > 1) {
				// どの呼び出しの子か決められない。残すと後の起動と取り違えるので、待っている起動を全部捨てる
				pending.launches.clear();
			}
		}
		if (pending.launches.size === 0 && pending.resumes.size === 0) {
			this.pendingSubagentCalls.delete(token);
		}
		return false;
	}

	/**
	 * サブエージェントの開始・再開（同じ id で何度来ても一覧は 1 件）。`resume` は mod の `subagent.resume`
	 * （classic の SubagentStart）。`subagent.start` は Agent の呼び出しの結果から作られ、フォアグラウンドの子では
	 * いつも子が終わった後に届く（2 秒以上遅れることもある）ので、終わった子を動いているに戻さない。
	 */
	private startModSubagent(token: string, agentId: string, at: number, label: string | undefined, detail: string | undefined, resume: boolean, toolUseId?: string): void {
		if (!PARADIS_CLAUDE_AGENT_ID_PATTERN.test(agentId)) {
			return;
		}
		const tracker = this.activityTracker(token);
		const started = !resume && tracker.hasEndedAgent(agentId) ? false : tracker.applyClaude('SubagentStart', { agent_id: agentId, ...(label !== undefined ? { agent_type: label } : {}), ...(detail !== undefined ? { prompt: detail } : {}) }, at);
		// 起動した Agent の呼び出し（mod は toolUseId を添えて知らせる）。会話のカードがこれで一覧の項目を引く
		const linked = toolUseId !== undefined && tracker.linkToolUse(agentId, toolUseId, at, true);
		if (started || linked) {
			this.pushActivityToSubscribers(token);
		}
		const running = tracker.snapshot()?.agents.some(agent => agent.id === agentId && agent.status === 'running') === true;
		const backgroundTaskId = `${HOOK_BACKGROUND_TASK_PREFIX}${agentId}`;
		if (running && backgroundTaskId.length <= BACKGROUND_TASK_ID_MAX_LENGTH) {
			this.tailers.get(token)?.markBackgroundTaskOpen(backgroundTaskId, at);
		}
		this.schedulePersistedAgentActivityReconcile(token);
	}

	/** サブエージェントの終わり（agentId 付きの turn.complete。TaskStop で止めたときは SubagentStop が来ない）。 */
	private endModSubagent(token: string, agentId: string, status: 'completed' | 'interrupted' | 'failed', at: number): void {
		if (this.activityTrackers.get(token)?.applyClaudeSubagentEnd(agentId, status, at) === true) {
			this.pushActivityToSubscribers(token);
		}
		this.tailers.get(token)?.markBackgroundTaskClose(`${HOOK_BACKGROUND_TASK_PREFIX}${agentId}`);
		this.schedulePersistedAgentActivityReconcile(token);
	}

	/**
	 * 許可を求めたサブエージェント（hook の `agent_id` / `agent_type`、mod の `agentId`）。本会話からの許可は undefined。
	 * 呼び名は TUI の「from the … agent」と同じ `agent_type` を優先し、無ければ活動の一覧の名前を使う。
	 */
	private approvalAgent(token: string, agentId: string | undefined, agentType: string | undefined): IParadisAgentApprovalAgent | undefined {
		// 送り元を作るのは agent_id があるときだけ（本会話の hook に agent_type だけが付くことがあっても送り元にしない）
		const id = agentId !== undefined && agentId.length > 0 && agentId.length <= 200 ? agentId : undefined;
		const type = agentType !== undefined && agentType.trim().length > 0 ? agentType.slice(0, 200) : undefined;
		if (id === undefined) {
			return undefined;
		}
		const known = this.activityTrackers.get(token)?.agentSummary(id);
		const name = type ?? known?.label;
		return { id, ...(name !== undefined ? { name: name.slice(0, 200) } : {}), role: known?.role ?? 'subagent' };
	}

	/** 承認のカードに合う、mod の承認の待ち（tool_use_id、無ければカードの本文で突き合わせる）。 */
	private matchModPermission(
		interaction: Extract<IParadisAgentInteraction, { readonly kind: 'approval' }>,
		pending: readonly IParadisClaudeModPendingPermission[],
		cards: readonly Extract<IParadisAgentInteraction, { readonly kind: 'approval' }>[],
	): IParadisClaudeModPendingPermission | undefined {
		const byId = pending.find(permission => permission.toolUseId !== undefined && permission.toolUseId === interaction.id);
		if (byId !== undefined) {
			return byId;
		}
		// 本文が完全に一致し、そのカードもその待ちも 1 つずつに決まるときだけ結ぶ（決まらなければ結ばない。
		// 呼び出し側が mod の内容で別にカードを出す）。古いカードを別の呼び出しの待ちと結ばないため
		// 本文（`detail`）は説明をコマンドより先に採るので、説明が同じで中身が違う呼び出しを取り違えうる。中身（ツールごとに
		// 分けた入力。送り元は除く）も一致することを条件にする。中身を持たない古いカードは本文だけで見る
		const textOf = (permission: IParadisClaudeModPendingPermission) => truncateText(paradisApprovalRequestText(permission.toolName, permission.toolInput), TOOL_TEXT_LIMIT);
		const inputKey = (request: IParadisAgentApprovalRequest | undefined) => {
			if (request === undefined) {
				return undefined;
			}
			const { agent: _agent, ...input } = request;
			return paradisStableJson(input);
		};
		const sameInput = (card: Extract<IParadisAgentInteraction, { readonly kind: 'approval' }>, key: string | undefined) => card.request === undefined || inputKey(card.request) === key;
		const byText = pending.filter(permission => textOf(permission) === interaction.detail
			&& sameInput(interaction, inputKey(paradisBuildAgentApprovalRequest(permission.toolName, permission.toolInput)))
			// tool_use_id を持つ待ちは、合成 id のカード（hook が呼び出しを決められなかったもの）とだけ本文で結ぶ
			&& (permission.toolUseId === undefined || (interaction.id.startsWith('approval:') && !cards.some(card => card.id === permission.toolUseId))));
		const sameCards = cards.filter(card => card.detail === interaction.detail && sameInput(card, inputKey(interaction.request)));
		return byText.length === 1 && sameCards.length === 1 ? byText[0] : undefined;
	}

	/**
	 * mod の承認の待ちが増えた・終わった。カードの選択肢を直し、合うカードが無ければ（自前の PermissionRequest hook が
	 * 無い・届かない）少し待ってから mod の内容でカードを出す。
	 */
	private refreshModApprovals(token: string): void {
		const session = this.paneSessions.get(token);
		const tailer = this.tailers.get(token);
		if (session === undefined || tailer === undefined) {
			return;
		}
		const apply = () => {
			if (this.tailers.get(token) !== tailer) {
				return;
			}
			const pending = this.claudeModBridge.pendingPermissions(token, session.sessionId);
			const cards = tailer.approvalInteractions();
			tailer.updateModApprovals(interaction => {
				const permission = this.matchModPermission(interaction, pending, cards);
				return permission !== undefined ? { choices: paradisModApprovalChoices(permission.suggestions), denyMessage: permission.acceptsDenyMessage } : undefined;
			});
			const unmatched = pending.filter(permission => !cards.some(card => this.matchModPermission(card, [permission], cards) !== undefined));
			if (unmatched.length === 0 || this.modApprovalTimers.has(token)) {
				return;
			}
			const timer = setTimeout(() => {
				this.modApprovalTimers.delete(token);
				if (this.tailers.get(token) !== tailer) {
					return;
				}
				void tailer.afterQueue(() => {
					const currentCards = tailer.approvalInteractions();
					const mobileWants = this.eagerTailing || this.subscribers.has(token);
					for (const permission of this.claudeModBridge.pendingPermissions(token, session.sessionId)) {
						if (!currentCards.some(card => this.matchModPermission(card, [permission], currentCards) !== undefined) && tailer.pendingQuestions.size === 0) {
							tailer.injectApprovalRequest(permission.toolName, permission.toolInput, permission.toolUseId, !mobileWants, undefined, 1, paradisApprovalSuggestionLabels(permission.suggestions), {
								agent: this.approvalAgent(token, permission.agentId, undefined),
								suggestionScope: paradisApprovalSuggestionScope(permission.suggestions),
							});
						}
					}
					void tailer.afterQueue(() => apply());
				});
			}, 1_500);
			this.modApprovalTimers.set(token, timer);
		};
		// 同じペインの hook（PermissionRequest のカード）を先に済ませてから突き合わせる
		void (this.hookProcessing.get(token) ?? Promise.resolve()).then(() => tailer.afterQueue(apply));
	}

	private lockModAnswer(key: string): void {
		const now = this.modAnswerNow();
		this.modAnswered.set(key, now);
		for (const [candidate, at] of this.modAnswered) {
			if (now - at > MOD_ANSWER_LOCK_MS) {
				this.modAnswered.delete(candidate);
			}
		}
	}

	private isModAnswerLocked(key: string): boolean {
		const at = this.modAnswered.get(key);
		return at !== undefined && this.modAnswerNow() - at <= MOD_ANSWER_LOCK_MS;
	}

	/** 質問のカード（モバイルへ出したもの）に合う、mod の質問の待ち（tool_use_id、無ければ質問文の並びで突き合わせる）。 */
	private matchModQuestion(token: string, interactionId: string, questions: readonly IParadisAgentChatMessage[]): IParadisClaudeModPendingQuestion | undefined {
		const session = this.paneSessions.get(token);
		if (session?.agent !== 'claude' || questions.length === 0) {
			return undefined;
		}
		const pending = this.claudeModBridge.pendingQuestions(token, session.sessionId);
		const sameTexts = (candidate: IParadisClaudeModPendingQuestion) => candidate.questions.length === questions.length
			&& candidate.questions.every((question, index) => truncateText(question.question, TEXT_LIMIT) === questions[index]?.text);
		const target = pending.find(candidate => candidate.toolUseId !== undefined && candidate.toolUseId === interactionId) ?? pending.find(sameTexts);
		return target !== undefined && target.questions.length === questions.length ? target : undefined;
	}

	/**
	 * mod の質問の待ちが増えた・終わった、または質問のカードが増えた。カードごとに mod で答えられるか（`answerVia`）を直す。
	 * アプリはこれを見て、メモと「質問に答えずに話す」を出すか決める。
	 */
	private refreshModQuestions(token: string): void {
		const tailer = this.tailers.get(token);
		if (tailer === undefined) {
			return;
		}
		void tailer.afterQueue(() => {
			if (this.tailers.get(token) !== tailer) {
				return;
			}
			const ids = new Set<string>();
			for (const interactionId of tailer.pendingQuestionInteractionIds()) {
				if (this.matchModQuestion(token, interactionId, tailer.pendingQuestionMessages(interactionId)) !== undefined) {
					ids.add(interactionId);
				}
			}
			tailer.setModQuestionIds(ids);
		});
	}

	/**
	 * モバイルの質問の回答を mod へ値で渡す（`{ questions, answers, annotations }`。answers は「質問文 → 選んだラベル」、
	 * 複数選択は `, ` でつなぐ。annotations は選んだ選択肢の preview とメモ。Claude Code の TUI が返すものと同じ形）。
	 * mod が待っていなければ false（キーの経路）。
	 */
	private tryAnswerQuestionViaMod(mobileId: string, msg: Extract<AgentInbound, { t: 'action/answerQuestion' }>, token: string, questions: readonly IParadisAgentChatMessage[]): boolean {
		const tailer = this.tailers.get(token);
		if (tailer === undefined || tailer.epoch !== msg.epoch || !this.hasSubscriber(token, mobileId)
			|| !tailer.hasPendingInteraction({ kind: 'question', id: msg.interactionId })) {
			return false;
		}
		const lockKey = `${token}\0question\0${msg.interactionId}`;
		if (this.isModAnswerLocked(lockKey)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'interaction-locked', message: 'PC側で反映を待っています。変わらない場合はPCの画面で確認してください' }, token);
			return true;
		}
		const target = this.matchModQuestion(token, msg.interactionId, questions);
		// カードの選択肢（表示用に切り詰めたもの）から、mod が受け取った元のラベルと preview を引く
		const built = target !== undefined ? paradisBuildModQuestionAnswer(target.questions, questions.map(paradisShownOptionLabels), msg.answers, paradisTruncateOptionLabel) : undefined;
		if (target === undefined || built === undefined || !this.claudeModBridge.answerQuestion(token, target.id, built.answers, built.annotations)) {
			return false;
		}
		this.lockModAnswer(lockKey);
		this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'accepted' }, token);
		return true;
	}

	/**
	 * 「質問に答えずに話す」（`agent.question.chat.v1`）。mod が待っているときだけ渡せる（キーの列は確かめていない。
	 * TUI の「Chat about this」は送信ボタンの先にあり、行き過ぎると以降のキーがエージェントへの発言になる）。
	 */
	private handleClarifyQuestionAction(mobileId: string, msg: Extract<AgentInbound, { t: 'action/clarifyQuestion' }>): void {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		const reject = (code: string, message: string) => this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code, message }, token ?? msg.token);
		if (token === undefined || tailer === undefined || tailer.epoch !== msg.epoch || !this.hasSubscriber(token, mobileId)
			|| !tailer.hasPendingInteraction({ kind: 'question', id: msg.interactionId })) {
			reject('stale-interaction', '回答対象の質問が変わりました');
			return;
		}
		const lockKey = `${token}\0question\0${msg.interactionId}`;
		if (this.isModAnswerLocked(lockKey)) {
			reject('interaction-locked', 'PC側で反映を待っています。変わらない場合はPCの画面で確認してください');
			return;
		}
		const questions = tailer.pendingQuestionMessages(msg.interactionId);
		const target = this.matchModQuestion(token, msg.interactionId, questions);
		if (target === undefined) {
			reject('stale-interaction', 'この質問はもう取り下げられません。PC の画面で確認してください');
			return;
		}
		const partial = questions.map((question, index) => {
			const answer = msg.answers?.[index] ?? undefined;
			return answer !== undefined && paradisQuestionAnswerFits(question, answer) ? answer : undefined;
		});
		const clarify = msg.response !== undefined
			? { kind: 'response' as const, response: msg.response }
			: { kind: 'deny' as const, deny: paradisAgentQuestionClarifyDeny(target.questions, questions.map(paradisShownOptionLabels), partial, paradisTruncateOptionLabel, index => paradisAgentQuestionHasPreview(questions[index] ?? {})) };
		if (!this.claudeModBridge.clarifyQuestion(token, target.id, clarify)) {
			reject('stale-interaction', 'この質問はもう取り下げられません。PC の画面で確認してください');
			return;
		}
		this.lockModAnswer(lockKey);
		this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'accepted' }, token);
	}

	/**
	 * 承認の回答を mod へ値で渡す。'yes' と画面の 1 番（Yes）は許可、'always' と画面の 2 番以降の Yes（以後は確認しない）は
	 * 許可とルールの追加、'no' は拒否。mod が待っていなければ 'none'（呼び出し側はキーの経路へ）。
	 * `denyMessage`（拒否に添える指示）は、指示を受け取れる mod が待っているときだけ渡す。渡せなければ 'none'
	 * （呼び出し側は指示を落として Esc で拒否してはいけない）。
	 */
	private tryAnswerApprovalViaMod(token: string, interactionId: string, choice: string, optionLabel: string | undefined, mobile?: { readonly mobileId: string; readonly epoch: string }, denyMessage?: string): 'answered' | 'locked' | 'none' {
		const session = this.paneSessions.get(token);
		const tailer = this.tailers.get(token);
		if (session?.agent !== 'claude' || tailer === undefined || (mobile !== undefined && (tailer.epoch !== mobile.epoch || !this.hasSubscriber(token, mobile.mobileId)))) {
			return 'none';
		}
		const optionNumber = paradisParseApprovalOptionChoice(choice);
		const yesOption = optionNumber !== undefined && optionLabel !== undefined && /^yes\b/i.test(optionLabel.trim());
		const decision: { readonly allow: boolean; readonly always: boolean } | undefined = choice === 'yes' || (yesOption && optionNumber === 1) ? { allow: true, always: false }
			: choice === 'always' || (yesOption && optionNumber !== undefined && optionNumber > 1) ? { allow: true, always: true }
				: choice === 'no' ? { allow: false, always: false }
					: undefined;
		if (decision === undefined) {
			return 'none';
		}
		const cards = tailer.approvalInteractions();
		const interaction = cards.find(card => card.id === interactionId);
		const lockKey = `${token}\0approval\0${interactionId}`;
		if (interaction === undefined) {
			return this.isModAnswerLocked(lockKey) ? 'locked' : 'none';
		}
		const permission = this.matchModPermission(interaction, this.claudeModBridge.pendingPermissions(token, session.sessionId), cards);
		if (permission === undefined || (decision.always && !permission.hasSuggestions)
			|| (denyMessage !== undefined && (decision.allow || !permission.acceptsDenyMessage))) {
			return 'none';
		}
		if (this.isModAnswerLocked(lockKey)) {
			return 'locked';
		}
		if (!this.claudeModBridge.answerPermission(token, permission.id, decision.allow ? 'allow' : 'deny', decision.always,
			denyMessage !== undefined ? paradisApprovalDenyMessage(denyMessage) : undefined)) {
			return 'none';
		}
		this.lockModAnswer(lockKey);
		tailer.markApprovalAnswered(interactionId);
		return 'answered';
	}

	/** デスクトップのチャット表示の「以後は確認しない」（キーでは答えられないので mod へ渡す）。 */
	answerDesktopApprovalViaMod(token: string, interactionId: string, choice: string): boolean {
		return this.tryAnswerApprovalViaMod(token, interactionId, choice, undefined) === 'answered';
	}

	/**
	 * 待機中の Claude Code へ、モバイルの発言を mod の `$.prompt.submit` で送る（キー入力も貼り付けも要らず、
	 * ターンが始まったところで受理が分かる）。スラッシュコマンドは mod の `$.command.run` で実行する（mod 1.2.0 以降）。
	 * 作業中・`!` `#` で始まる文・mod が無いときは false（キーの経路）。
	 */
	private trySendViaMod(mobileId: string, msg: Extract<AgentInbound, { t: 'action/sendMessage' }>, token: string, session: IPaneSessionInfo, tailer: TranscriptTailer, key: string, sendKey: string | undefined): boolean {
		const sessionId = session.sessionId;
		const text = msg.text;
		if (session.agent !== 'claude' || sessionId === undefined || text.trim().length === 0
			|| !this.claudeModBridge.isAlive(token, sessionId) || this.claudeModBridge.isBusy(token, sessionId) || !this.isAgentPrompt(token, tailer)) {
			return false;
		}
		if (text.trimStart().startsWith('/')) {
			const slash = paradisParseSlashCommand(text);
			return slash !== undefined && this.claudeModBridge.supports(token, sessionId, 'command.run')
				&& this.trySendSlashCommandViaMod(mobileId, msg, token, sessionId, slash, key, sendKey);
		}
		if (/^[!#]/.test(text.trimStart())) {
			return false;
		}
		if (this.modSendRequests.has(key)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'stale-session', message: '操作対象のエージェントセッションが変わりました' }, token);
			return true;
		}
		this.modSendRequests.add(key);
		this.rememberSendId(sendKey);
		const submittedAt = Date.now();
		const onLateFailure = () => {
			// mod は受け取ったが、送れなかった（`$.prompt.submit` が失敗した）。モバイルは答え終えた requestId の 2 回目の
			// 結果を捨てるので、会話に知らせの行を足して既存の表示で伝える
			this.forgetSendId(sendKey);
			const head = text.trim().replace(/\s+/g, ' ');
			// allow-any-unicode-next-line
			this.tailers.get(token)?.injectNotice(`送れませんでした: ${head.length > 60 ? `${head.slice(0, 60)}…` : head}`);
		};
		// mod は 1 通ずつしか送らず、最中に渡した 2 通目は busy で断る。
		// そのときは 1 通目の行方（受け取った・送れた・失敗）が分かるまで待ってからキーで送る（先に打つと順番が入れ替わる）
		const previousModSend = this.modSendsInFlight.get(token);
		const sending = this.claudeModBridge.submitPrompt(token, sessionId, text, onLateFailure);
		const settled = sending.then(() => undefined, () => undefined);
		this.modSendsInFlight.set(token, settled);
		void settled.then(() => {
			if (this.modSendsInFlight.get(token) === settled) {
				this.modSendsInFlight.delete(token);
			}
		});
		sending.then(async result => {
			if (result === 'busy') {
				await paradisClaudeModWaitForPrevious(previousModSend, MOD_BUSY_WAIT_MS);
			}
			if (result === 'unconfirmed') {
				// mod から返事が無い。transcript にこの発言が入っていれば送れている（入っていなければキーで送る）
				await this.tailers.get(token)?.afterQueue(() => { });
				const landed = this.tailers.get(token)?.messages.some(message => message.role === 'user' && message.kind === 'text'
					&& (message.ts ?? 0) >= submittedAt - 1_000 && message.text.trim() === text.trim()) === true;
				result = landed ? 'accepted' : 'unavailable';
			}
			this.modSendRequests.delete(key);
			if (result === 'accepted') {
				this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'accepted' }, token);
				return;
			}
			this.forgetSendId(sendKey);
			// mod が断った（`ok: false`）。キーでは送り直さない（断った理由ごと無視して打つことになる）
			const refusal = paradisModRefusalResult(result);
			if (refusal !== undefined) {
				this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', ...refusal }, token);
				return;
			}
			// mod へ渡していない（または別の発言の最中だった）。今までどおりウィンドウのキー入力で送る
			this.handleSendMessageAction(mobileId, msg, false);
		}, error => {
			this.modSendRequests.delete(key);
			this.forgetSendId(sendKey);
			this.logService.warn('[paradisAgentChat] sending through the Claude Code mod failed', error);
			this.handleSendMessageAction(mobileId, msg, false);
		});
		return true;
	}

	/**
	 * スラッシュコマンドを mod の `$.command.run` で実行する。Claude Code が断ったら（名前が無い等）、その理由を付けて
	 * 受け付けずに返す（アプリは理由を入力欄の上に出し、文を入力欄へ戻す）。mod へ渡せなければキーの経路で送る。
	 */
	private trySendSlashCommandViaMod(mobileId: string, msg: Extract<AgentInbound, { t: 'action/sendMessage' }>, token: string, sessionId: string, slash: IParadisSlashCommand, key: string, sendKey: string | undefined): boolean {
		if (this.modSendRequests.has(key)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'stale-session', message: '操作対象のエージェントセッションが変わりました' }, token);
			return true;
		}
		this.modSendRequests.add(key);
		this.rememberSendId(sendKey);
		const onLateFailure = (reason: string | undefined) => {
			// 画面を開くコマンドなどで、受け取った後に失敗した。モバイルはもう答えを受け取っているので、会話に知らせの行を足す
			this.forgetSendId(sendKey);
			this.tailers.get(token)?.injectNotice(paradisSlashRejectionMessage('claude', slash.name, reason));
		};
		const previousModSend = this.modSendsInFlight.get(token);
		const running = this.claudeModBridge.runCommand(token, sessionId, slash.name, slash.args, onLateFailure);
		const settled = running.then(() => undefined, () => undefined);
		this.modSendsInFlight.set(token, settled);
		void settled.then(() => {
			if (this.modSendsInFlight.get(token) === settled) {
				this.modSendsInFlight.delete(token);
			}
		});
		running.then(async result => {
			if (result.outcome === 'busy') {
				await paradisClaudeModWaitForPrevious(previousModSend, MOD_BUSY_WAIT_MS);
			}
			this.modSendRequests.delete(key);
			if (result.outcome === 'accepted') {
				this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'accepted' }, token);
				return;
			}
			this.forgetSendId(sendKey);
			if (result.outcome === 'refused') {
				// 理由が届かなくても断りとして返す（キーでは送り直さない）
				this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: PARADIS_SLASH_COMMAND_REJECTED_CODE, message: paradisSlashRejectionMessage('claude', slash.name, result.message) }, token);
				return;
			}
			const refusal = paradisModRefusalResult(result.outcome);
			if (refusal !== undefined) {
				this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', ...refusal }, token);
				return;
			}
			if (result.outcome === 'unconfirmed') {
				// mod へ渡したが返事が無い。キーで送り直すと二度実行しうるので、送らずに確かめてもらう
				this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'action-timeout', message: 'PC の Claude Code から返事がありませんでした。PC の画面で確かめてから送り直してください' }, token);
				return;
			}
			// mod へ渡していない（または mod が送れなかった）。今までどおりウィンドウのキー入力で送る
			this.handleSendMessageAction(mobileId, msg, false);
		}, error => {
			this.modSendRequests.delete(key);
			this.forgetSendId(sendKey);
			this.logService.warn('[paradisAgentChat] running a slash command through the Claude Code mod failed', error);
			this.handleSendMessageAction(mobileId, msg, false);
		});
		return true;
	}

	// ---- デスクトップ UI 向けの読み取り口 ----------------------------------------------------------
	//
	// ここから下はモバイルへ何も送らない。既に読んでいる transcript・hook・活動ツリーの結果を、
	// デスクトップが引ける形に写すだけ（IParadisAgentPaneInsightSource、agentInsights 参照）。

	/**
	 * 指定したペインの様子。セッションが確定していない・もう生きていないペインは返さない。
	 * モバイル連携の有効/無効には依存しない（status 用の tail はモバイル接続から独立して動いている）。
	 */
	getDesktopPaneInsights(tokens: readonly string[]): IParadisAgentPaneInsight[] {
		const insights: IParadisAgentPaneInsight[] = [];
		for (const token of tokens) {
			const insight = this.desktopPaneInsight(token);
			if (insight !== undefined) {
				insights.push(insight);
			}
		}
		return insights;
	}

	/**
	 * 通知の中身に使うペインの様子（最後の発言・ターンの終わり・待っている承認や質問）。モバイルへは何も送らない。
	 * 決め方は `paradisNotifyContentSource.ts` の `paradisResolveNotifyContent`。
	 */
	notifyPaneContent(token: string): IParadisNotifyPaneContent | undefined {
		const session = this.paneSessions.get(token);
		const tailer = this.tailers.get(token);
		const turnEnd = this.notifyTurnEnds.get(token);
		if (session === undefined && tailer === undefined && turnEnd === undefined) {
			return undefined;
		}
		let lastAssistant: IParadisNotifyPaneContent['lastAssistant'];
		for (let index = (tailer?.messages.length ?? 0) - 1; index >= 0 && tailer !== undefined; index--) {
			const message = tailer.messages[index];
			if (message.role === 'user' && message.kind === 'text') {
				break; // 今のターンより前の発言は、この通知の話ではない
			}
			if (message.role === 'assistant' && message.kind === 'text' && message.text.trim().length > 0) {
				lastAssistant = { text: message.text, isError: message.isError === true, ...(message.ts !== undefined ? { at: message.ts } : {}) };
				break;
			}
		}
		const current = tailer?.currentInteraction() ?? null;
		let interaction: IParadisNotifyPaneContent['interaction'];
		if (current?.kind === 'approval') {
			interaction = { kind: 'approval', id: current.id, ...(current.detail !== undefined ? { text: current.detail } : {}) };
		} else if (current?.kind === 'question' && tailer !== undefined) {
			const text = tailer.pendingQuestionMessages(current.id).map(message => message.text).filter(text => text.trim().length > 0).join('\n\n');
			interaction = { kind: 'question', id: current.id, ...(text.length > 0 ? { text } : {}) };
		}
		const agent = session?.agent ?? tailer?.agent;
		return {
			...(agent !== undefined ? { agent } : {}),
			...(lastAssistant !== undefined ? { lastAssistant } : {}),
			...(turnEnd !== undefined ? { turnEnd } : {}),
			...(interaction !== undefined ? { interaction } : {}),
		};
	}

	private desktopPaneInsight(token: string): IParadisAgentPaneInsight | undefined {
		const session = this.paneSessions.get(token);
		if (session === undefined || !this.isLiveToken(token)) {
			return undefined;
		}
		const tailer = this.tailers.get(token);
		const subagents = paradisSelectInsightSubagents((this.activityTrackers.get(token)?.snapshot()?.agents ?? []).map(agent => ({
			id: agent.id,
			label: agent.label,
			role: agent.role,
			status: agent.status,
			startedAt: agent.startedAt,
			updatedAt: agent.updatedAt,
			...(agent.depth !== undefined ? { depth: agent.depth } : {}),
		})));
		let lastMessage: IParadisAgentPaneInsight['lastMessage'];
		for (let index = (tailer?.messages.length ?? 0) - 1; index >= 0 && tailer !== undefined; index--) {
			const message = tailer.messages[index];
			// Para Code の知らせ（notice）はエージェントの発言ではないので、最後の発言に数えない
			if (message.role === 'assistant' && message.kind === 'text' && message.notice !== true && message.text.trim().length > 0) {
				lastMessage = { text: paradisOneLine(message.text, 300), ...(message.ts !== undefined ? { at: message.ts } : {}) };
				break;
			}
		}
		const interaction = this.desktopInteractions.get(token) ?? (tailer !== undefined ? this.desktopInteractionFromTailer(token, tailer) : undefined);
		const promptCache = session.agent === 'claude' ? tailer?.promptCache : undefined;
		return {
			token,
			agent: session.agent,
			subagents,
			...(lastMessage !== undefined ? { lastMessage } : {}),
			...(interaction !== undefined ? { interaction } : {}),
			...(promptCache !== undefined ? { promptCache } : {}),
		};
	}

	/** hook から拾えなかったとき（再起動直後など）に、tailer が持っている未決着の質問・承認から作る。 */
	private desktopInteractionFromTailer(token: string, tailer: TranscriptTailer): IParadisAgentPaneInteraction | undefined {
		let found: Omit<IParadisAgentPaneInteraction, 'at'> & { readonly at?: number } | undefined;
		if (tailer.pendingQuestions.size > 0) {
			for (let index = tailer.messages.length - 1; index >= 0; index--) {
				const message = tailer.messages[index];
				if (message.kind === 'question' && message.toolUseId !== undefined && tailer.pendingQuestions.has(message.toolUseId) && !tailer.desktopOnlyQuestionIds.has(message.toolUseId)) {
					found = { kind: 'question', text: paradisOneLine(message.text, 200), ...(message.ts !== undefined ? { at: message.ts } : {}) };
					break;
				}
			}
		}
		const current = found === undefined ? tailer.currentInteraction() : null;
		// デスクトップのチャット表示のためだけに入れた承認（hasPendingApproval が数えないもの）は、
		// ここでも数えない。以前どおり hook から覚えた内容（desktopInteractions）だけで決める。
		if (current?.kind === 'approval' && tailer.hasPendingApproval()) {
			const text = [current.title, current.detail].filter((part): part is string => part !== undefined && part.length > 0).join(': ');
			if (text.length > 0) {
				found = { kind: 'permission', text: paradisOneLine(text, 200) };
			}
		}
		if (found === undefined) {
			this.desktopTailerInteractionSeenAt.delete(token);
			return undefined;
		}
		// 時刻が記録に無いものは「最初に見えた時刻」を覚えて使い回す。毎回 Date.now() を入れると
		// 指紋が確認のたびに変わり、変化の知らせが出続けて全ウィンドウが取り直してしまう。
		const key = `${found.kind}\0${found.text}`;
		let seen = this.desktopTailerInteractionSeenAt.get(token);
		if (seen?.key !== key) {
			seen = { key, at: found.at ?? Date.now() };
			this.desktopTailerInteractionSeenAt.set(token, seen);
		}
		return { kind: found.kind, text: found.text, at: found.at ?? seen.at };
	}

	/**
	 * hook から「いま待っている内容」を覚える。質問は AskUserQuestion の PreToolUse、許可は
	 * PermissionRequest で始まり、ツールの完了・拒否・次の依頼・ターン終了で消える。
	 */
	private recordDesktopInteraction(event: IParadisAgentHookEvent): void {
		const token = event.token;
		const current = this.desktopInteractions.get(token);
		let next: IParadisAgentPaneInteraction | undefined = current;
		switch (event.event) {
			case 'PreToolUse': {
				if (event.toolName === 'AskUserQuestion') {
					const text = paradisSummarizeQuestionInput(event.toolInput);
					next = text !== undefined ? { kind: 'question', text, at: event.at } : current;
				}
				break;
			}
			case 'PermissionRequest': {
				if (event.toolName !== 'AskUserQuestion') {
					const text = paradisSummarizePermissionInput(event.toolName, event.toolInput);
					next = text !== undefined ? { kind: 'permission', text, at: event.at } : current;
				}
				break;
			}
			case 'PostToolUse':
			case 'PostToolUseFailure':
				next = current !== undefined && (current.kind === 'question') === (event.toolName === 'AskUserQuestion') ? undefined : current;
				break;
			case 'PermissionDenied':
				next = current?.kind === 'permission' ? undefined : current;
				break;
			case 'UserPromptSubmit':
			case 'SessionStart':
			case 'SessionEnd':
				next = undefined;
				break;
			default:
				if (paradisIsTurnEndHookEvent(event.event)) {
					next = undefined;
				}
		}
		if (next === current) {
			if (event.event !== 'MessageDisplay') {
				this.scheduleDesktopInsightCheck();
			}
			return;
		}
		if (next === undefined) {
			this.desktopInteractions.delete(token);
		} else {
			this.desktopInteractions.set(token, next);
		}
		this.scheduleDesktopInsightCheck();
	}

	/** 変化の知らせをまとめる。知らせるのは指紋が変わったペインがあるときだけ。 */
	private scheduleDesktopInsightCheck(): void {
		// チャット表示も同じ契機（追記・活動・hook・tailer の張り替え）で取り直しが要る。
		this.scheduleDesktopChatCheck();
		if (this.desktopInsightTimer !== undefined || this._store.isDisposed) {
			return;
		}
		this.desktopInsightTimer = setTimeout(() => {
			this.desktopInsightTimer = undefined;
			this.checkDesktopInsights();
		}, 250);
	}

	private checkDesktopInsights(): void {
		const live = this.allLiveTokens();
		for (const token of [...this.desktopInteractions.keys()]) {
			if (!live.has(token)) {
				this.desktopInteractions.delete(token);
			}
		}
		for (const token of [...this.desktopTailerInteractionSeenAt.keys()]) {
			if (!live.has(token)) {
				this.desktopTailerInteractionSeenAt.delete(token);
			}
		}
		for (const token of [...this.desktopExitedTokens]) {
			if (!live.has(token)) {
				this.desktopExitedTokens.delete(token);
				this.sessionEndedAt.delete(token);
			}
		}
		for (const token of [...this.shellsAccessSent.keys()]) {
			if (!live.has(token)) {
				this.shellsAccessSent.delete(token);
			}
		}
		let changed = false;
		const seen = new Set<string>();
		for (const insight of this.getDesktopPaneInsights([...this.paneSessions.keys()])) {
			seen.add(insight.token);
			const signature = JSON.stringify(insight);
			if (this.desktopInsightSignatures.get(insight.token) !== signature) {
				this.desktopInsightSignatures.set(insight.token, signature);
				changed = true;
			}
		}
		for (const token of [...this.desktopInsightSignatures.keys()]) {
			if (!seen.has(token)) {
				this.desktopInsightSignatures.delete(token);
				changed = true;
			}
		}
		if (changed) {
			this._onDidChangeDesktopPaneInsights.fire();
		}
	}

	// ---- デスクトップのチャット表示向けの読み取り口（agentChat） ------------------------------------
	//
	// モバイルの attach と同じ tailer を、デスクトップの画面が引ける形に写すだけ。ここからモバイルへは
	// 何も送らない（IParadisAgentChatSource、agentChat/common/paradisAgentChat.ts 参照）。

	/**
	 * チャット表示を持つウィンドウが見ているペイン。
	 *
	 * 見ている間は、モバイルとつないでいなくても質問・承認の中身を hook から tailer へ入れる
	 * （Claude Code は AskUserQuestion を回答されるまで transcript に書かないので、入れないと
	 * デスクトップに質問のカードを出せない）。ウィンドウが閉じたり落ちたりして送り直しが途絶えたら、
	 * 期限で外す。
	 */
	private readonly desktopChatWatchers = new Map<string, { readonly tokens: ReadonlySet<string>; readonly visible: ReadonlySet<string>; readonly expiresAt: number }>();
	/** SessionEnd を受けてからまだ次の hook が来ていないペイン。 */
	private readonly desktopExitedTokens = new Set<string>();
	/** SessionEnd を受けた時刻（Monitor を「停止（推定）」にするときの終わった時刻）。desktopExitedTokens と同じ寿命。 */
	private readonly sessionEndedAt = new Map<string, number>();
	private readonly _onDidChangeDesktopChat = this._register(new Emitter<readonly string[]>());
	/** 見られているペインの会話（履歴・生成中の様子・待っている内容・モデル）が変わった。 */
	readonly onDidChangeDesktopChat = this._onDidChangeDesktopChat.event;
	private readonly desktopChatSignatures = new Map<string, string>();
	private desktopChatTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * ウィンドウが見ているペインを差し替える（送り直しで期限を延ばす）。tokens は質問・承認の中身を
	 * 取り込むペイン（チャットを開いていないものも含む）、visible は変化を知らせるペイン（チャット表示中）。
	 */
	watchDesktopChat(watcherId: string, tokens: readonly string[], visible: readonly string[] = []): void {
		if (tokens.length === 0) {
			this.desktopChatWatchers.delete(watcherId);
		} else {
			this.desktopChatWatchers.set(watcherId, {
				tokens: new Set(tokens.slice(0, PARADIS_DESKTOP_CHAT_MAX_TOKENS)),
				visible: new Set(visible.slice(0, PARADIS_DESKTOP_CHAT_MAX_TOKENS)),
				expiresAt: Date.now() + PARADIS_DESKTOP_CHAT_WATCH_TTL_MS,
			});
		}
		// 見始めたペインは、セッションが確定していればすぐ読み始める（初回の取得を待たせない）。
		for (const token of tokens) {
			const session = this.paneSessions.get(token);
			if (session !== undefined) {
				this.ensureEagerTailer(token, session);
			}
		}
		this.scheduleDesktopChatCheck();
	}

	/** いずれかのウィンドウのチャット表示が、このペインを見ているか。期限切れの登録はここで外す。 */
	private isDesktopChatWatched(token: string): boolean {
		const now = Date.now();
		let watched = false;
		for (const [watcherId, watcher] of [...this.desktopChatWatchers]) {
			if (watcher.expiresAt < now) {
				this.desktopChatWatchers.delete(watcherId);
			} else if (watcher.tokens.has(token)) {
				watched = true;
			}
		}
		return watched;
	}

	/**
	 * 1ペイン分の会話。起点（前回の epoch と rev）が今の読み取りと合えば差分だけ、合わなければ
	 * 保持している全量を返す。セッションが確定していない・もう生きていないペインは undefined。
	 */
	async getDesktopChat(token: string, cursor: IParadisAgentChatCursor | undefined): Promise<IParadisAgentChatView | undefined> {
		const session = this.paneSessions.get(token);
		if (session === undefined || !this.isLiveToken(token)) {
			return undefined;
		}
		const tailer = this.tailers.get(token) ?? (this.terminalIdForToken(token) !== undefined ? this.ensureTailer(token, session) : undefined);
		if (tailer === undefined) {
			return undefined;
		}
		await tailer.ready;
		if (this.tailers.get(token) !== tailer) {
			return undefined; // 読み込みを待つ間にセッションが替わった。知らせを受けて取り直してもらう。
		}
		const oldestRev = tailer.messages.length > 0 ? tailer.messages[0].rev : tailer.rev;
		// 差分で返せるのは「起点の続きが欠けずにリングに残っている」ときだけ（モバイルの attach と同じ）。
		const incremental = cursor !== undefined && cursor.epoch === tailer.epoch && cursor.rev <= tailer.rev && cursor.rev >= oldestRev;
		const messages = incremental ? tailer.messages.filter(message => message.rev >= cursor.rev) : [...tailer.messages];
		const interaction = tailer.currentInteraction();
		const info = this.infoOf(token, tailer);
		return {
			token,
			agent: tailer.agent,
			epoch: tailer.epoch,
			rev: tailer.rev,
			reset: !incremental,
			messages,
			...(!incremental && (tailer.wasInitialTruncated || oldestRev > 0) ? { truncated: true } : {}),
			...(info !== undefined ? { info } : {}),
			live: this.liveStates.get(token) ?? null,
			interaction,
			...(interaction?.kind === 'question' ? { pendingQuestions: tailer.pendingQuestionMessages(interaction.id) } : {}),
			busy: this.activeTurnTokens.has(token) || this.liveStates.has(token),
			...(this.desktopExitedTokens.has(token) ? { agentExited: true } : {}),
		};
	}

	/** 切り詰めて渡したメッセージの全文（tailer が退避しておいた分だけ。読み直さない）。 */
	getDesktopChatFullText(token: string, epoch: string, rev: number): string | undefined {
		const tailer = this.isLiveToken(token) ? this.tailers.get(token) : undefined;
		return tailer?.epoch === epoch ? tailer.fullTextFor(rev) : undefined;
	}

	/** メッセージに付いていた画像の実体（tailer が退避しておいた分だけ）。 */
	getDesktopChatImage(token: string, epoch: string, rev: number, index: number): IParadisAgentChatImageData | undefined {
		const tailer = this.isLiveToken(token) ? this.tailers.get(token) : undefined;
		const image = tailer?.epoch === epoch ? tailer.imageFor(rev, index) : undefined;
		return image !== undefined ? { mediaType: image.mediaType, data: image.base64 } : undefined;
	}

	/** そのペインのエージェントで使えるスラッシュコマンド（モバイルへ送る一覧と同じもの）。 */
	async getDesktopChatCommands(token: string): Promise<readonly IParadisAgentChatCommand[]> {
		const session = this.paneSessions.get(token);
		const cwd = this.tokenToCwd.get(token);
		if (session === undefined || !this.isLiveToken(token)) {
			return [];
		}
		// 接続先で動いているペインは組み込みだけ（手元の設定からは作らない）。cwd がまだ同期されていないときは、
		// プロジェクトのコマンドを探さずホームの分だけにする。
		return this.agentCommandCatalog(token, session, cwd ?? homedir());
	}

	// ---- 許可要求と tool_use_id の対応付け ---------------------------------------------------------
	//
	// Claude Code の PermissionRequest hook には tool_use_id が無い（公式の hook リファレンスの
	// 「PermissionRequest input」: "like PreToolUse hooks, but without tool_use_id"）。そのままだと承認は
	// 合成 id になり PostToolUse と照合できず、ターン終了まで残る。PreToolUse（tool_use_id・tool_name・
	// tool_input を持つ）を覚えておき、ツール名と入力が同じ未完了の呼び出しが1つだけならその id を承認に付ける。
	// 決まらないときは合成 id のまま、その時点で未完了だった同名のツール（とその後に始まった同名のツール）が
	// 全部終わったときだけ解く。1つも覚えていなければ、以前どおりターン終了まで解かない。

	/** ペイン → 未完了のツール呼び出し（tool_use_id → ツール名と入力の指紋）。 */
	private readonly openToolUses = new Map<string, Map<string, { readonly tool: string; readonly inputKey: string }>>();
	/** 生成中の表示に出している Advisor の相談（ペインの token → server_tool_use の id）。 */
	private readonly advisorLiveIds = new Map<string, string>();
	/**
	 * mod の無い Claude ペインで、SubagentStart をまだ待っている呼び出し（ペインの token → toolUseId → 受けた時刻）。
	 * `launches` は Agent / Task、`resumes` は SendMessage（子を再開すると SubagentStart がもう一度届く）。
	 * {@link linkSubagentStartFromHooks} が、待っているのが Agent 1 件だけのときだけ子と結ぶ。
	 */
	private readonly pendingSubagentCalls = new Map<string, { readonly launches: Map<string, number>; readonly resumes: Map<string, number> }>();
	/** ペイン → 待ち合わせの印 → 合成 id の承認が待っている、同名の未完了のツール呼び出し。 */
	private readonly syntheticApprovalWaits = new Map<string, Map<string, { readonly tool: string; readonly ids: Set<string> }>>();
	private syntheticWaitSeq = 0;

	/**
	 * hook からツール呼び出しの開始・完了を覚える。PermissionRequest なら、承認に付ける tool_use_id
	 * （hook 自身が持っていればそれ）か、合成 id の承認を解く待ち合わせの印を返す。
	 */
	private trackToolUse(event: IParadisAgentHookEvent): { readonly toolUseId?: string; readonly waitKey?: string; readonly sameContentLimit?: number } {
		const token = event.token;
		if (paradisIsTurnEndHookEvent(event.event) || event.event === 'SessionStart') {
			this.openToolUses.delete(token);
			this.syntheticApprovalWaits.delete(token);
			return {};
		}
		let open = this.openToolUses.get(token);
		if (event.event === 'PreToolUse' && event.toolUseId !== undefined && event.toolName !== undefined) {
			if (open === undefined) {
				open = new Map();
				this.openToolUses.set(token, open);
			}
			if (open.size >= PARADIS_OPEN_TOOL_USE_LIMIT) {
				open.delete(open.keys().next().value!);
			}
			open.set(event.toolUseId, { tool: event.toolName, inputKey: paradisStableJson(event.toolInput) });
			// 承認の後に始まった同名のツールも待つ（PermissionRequest が PreToolUse より先に届いた場合に備える）。
			for (const wait of this.syntheticApprovalWaits.get(token)?.values() ?? []) {
				if (wait.tool === event.toolName) {
					wait.ids.add(event.toolUseId);
				}
			}
			return {};
		}
		if ((event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') && event.toolUseId !== undefined) {
			this.finishToolUses(token, [event.toolUseId]);
			return {};
		}
		if (event.event !== 'PermissionRequest') {
			return {};
		}
		if (event.toolUseId !== undefined) {
			return { toolUseId: event.toolUseId };
		}
		const inputKey = paradisStableJson(event.toolInput);
		const matches = [...(open ?? [])].filter(([, use]) => use.tool === event.toolName && use.inputKey === inputKey);
		if (matches.length === 1) {
			return { toolUseId: matches[0][0] };
		}
		// 決まらない。今の同名の未完了の呼び出しが全部終わるまで待つ（空なら待たない＝ターン終了まで残る）。
		const sameTool = [...(open ?? [])].filter(([, use]) => use.tool === event.toolName).map(([id]) => id);
		if (event.toolName === undefined || sameTool.length === 0) {
			return {};
		}
		const waitKey = `w${++this.syntheticWaitSeq}`;
		let waits = this.syntheticApprovalWaits.get(token);
		if (waits === undefined) {
			waits = new Map();
			this.syntheticApprovalWaits.set(token, waits);
		}
		waits.set(waitKey, { tool: event.toolName, ids: new Set(sameTool) });
		return { waitKey, sameContentLimit: matches.length };
	}

	/** 許可を待つ前の様子（ペイン → 様子。無ければ何も動いていなかった）。 */
	private readonly liveBeforePermission = new Map<string, IParadisAgentLiveState | undefined>();

	/**
	 * transcript に結果が書かれて承認が決着した後の、生成中の様子を直す。Claude Code 2.1.283 は許可を Esc で
	 * 拒否しても hook を出さないので、許可を待つ様子（「許可を待っています n秒」）が次のターンまで残っていた。
	 * - 利用者が拒否した結果（Claude Code の定型文）なら、エージェントは次の指示を待っている。ターンを終える
	 * - それ以外で承認が残っていなければ、許可を待つ前の様子へ戻す
	 */
	private settleLiveAfterApprovals(token: string, rejected: boolean): void {
		const tailer = this.tailers.get(token);
		if (tailer === undefined || tailer.hasAnyPendingApproval()) {
			return;
		}
		const live = this.liveStates.get(token);
		if (rejected) {
			// 完了ではなく、エージェントが止まって次の指示を待っている。ペインは確認待ち（review）ではなく
			// 状態なし（idle）へ移す（review にすると完了の通知が鳴る）。
			this.liveBeforePermission.delete(token);
			this.activeTurnTokens.delete(token);
			this.clearLiveState(token);
			fireParadisAgentAwaitingUser(token);
			return;
		}
		if (live?.phase !== 'permission' || live.tool === 'AskUserQuestion') {
			return;
		}
		const before = this.liveBeforePermission.get(token);
		this.liveBeforePermission.delete(token);
		if (before === undefined) {
			this.clearLiveState(token);
		} else {
			this.setLiveState(token, { ...before, updatedAt: Date.now() });
		}
	}

	/** ツール呼び出しが終わった（PostToolUse か、transcript の tool_result）。待ち合わせが空になった承認を解く。 */
	private finishToolUses(token: string, toolUseIds: readonly string[]): void {
		const open = this.openToolUses.get(token);
		const waits = this.syntheticApprovalWaits.get(token);
		for (const id of toolUseIds) {
			open?.delete(id);
			for (const [waitKey, wait] of [...(waits ?? [])]) {
				if (wait.ids.delete(id) && wait.ids.size === 0) {
					waits?.delete(waitKey);
					this.tailers.get(token)?.clearSyntheticApproval(waitKey);
				}
			}
		}
		if (open?.size === 0) {
			this.openToolUses.delete(token);
		}
		if (waits?.size === 0) {
			this.syntheticApprovalWaits.delete(token);
		}
	}

	/** デスクトップのチャット表示が打鍵で答えている interaction の claim（`token\0kind\0id` → claim）。 */
	private readonly desktopInteractionClaims = new Map<string, { readonly key: string; readonly claim: string }>();
	private readonly desktopClaimTimers = new Set<ReturnType<typeof setTimeout>>();
	private desktopClaimSeq = 0;

	/**
	 * デスクトップのチャット表示が質問・承認へ打鍵で答える前に、モバイルと同じ claim を取る。
	 * 取れなければ（モバイルやこの画面からの回答が反映待ち）false。
	 */
	claimDesktopInteraction(token: string, kind: 'question' | 'approval', id: string): boolean {
		const tailer = this.tailers.get(token);
		if (tailer === undefined || !tailer.hasPendingInteraction({ kind, id })) {
			return false;
		}
		const key = `${token}\0${tailer.epoch}\0${kind}\0${id}`;
		if (this.interactionClaims.has(key)) {
			return false;
		}
		const claim = `desktop\0${++this.desktopClaimSeq}`;
		this.interactionClaims.set(key, claim);
		this.desktopInteractionClaims.set(`${token}\0${kind}\0${id}`, { key, claim });
		return true;
	}

	/**
	 * claim を返す。送り終えた回答は、TUI が消費して interaction が消えるまで同じものへの回答を
	 * 受け付けない（モバイルの completedActions と同じ 60 秒。質問の決着・ターン終了ではその場で解ける）。
	 */
	releaseDesktopInteraction(token: string, kind: 'question' | 'approval', id: string, sent: boolean): void {
		const entryKey = `${token}\0${kind}\0${id}`;
		const entry = this.desktopInteractionClaims.get(entryKey);
		if (entry === undefined) {
			return;
		}
		this.desktopInteractionClaims.delete(entryKey);
		if (sent && kind === 'approval') {
			// 同じ本文の許可要求がもう一度出たら（同じコマンドの再実行）、新しい承認として受け付ける。
			// 覚えたままだと重複として捨て、答え終えた古いカードだけが残る。
			this.tailers.get(token)?.markApprovalAnswered(id);
		}
		if (!sent) {
			this.releaseInteractionClaim(entry.key, entry.claim);
			return;
		}
		const timer = setTimeout(() => {
			this.desktopClaimTimers.delete(timer);
			this.releaseInteractionClaim(entry.key, entry.claim);
		}, 60_000);
		this.desktopClaimTimers.add(timer);
	}

	/** 見られているペインの指紋を比べ、変わったものだけを知らせる。 */
	private scheduleDesktopChatCheck(): void {
		if (this.desktopChatTimer !== undefined || this._store.isDisposed || this.desktopChatWatchers.size === 0) {
			return;
		}
		this.desktopChatTimer = setTimeout(() => {
			this.desktopChatTimer = undefined;
			this.checkDesktopChat();
		}, PARADIS_DESKTOP_CHAT_NOTIFY_DELAY_MS);
	}

	private checkDesktopChat(): void {
		const changed: string[] = [];
		const watched = new Set<string>();
		// 知らせるのはチャット表示中のペインだけ（生成中は頻繁に変わるので、全ペインを知らせると全ウィンドウへ
		// IPC が流れ続ける）。閉じているペインは、次に開いたときに差分で追いつく。
		for (const token of new Set([...this.desktopChatWatchers.values()].flatMap(watcher => [...watcher.visible]))) {
			if (!this.isDesktopChatWatched(token)) {
				continue;
			}
			watched.add(token);
			const signature = this.desktopChatSignature(token);
			if (this.desktopChatSignatures.get(token) !== signature) {
				this.desktopChatSignatures.set(token, signature);
				changed.push(token);
			}
		}
		for (const token of [...this.desktopChatSignatures.keys()]) {
			if (!watched.has(token)) {
				this.desktopChatSignatures.delete(token);
			}
		}
		if (changed.length > 0) {
			this._onDidChangeDesktopChat.fire(changed);
		}
	}

	/** 取り直しが要るかを決める指紋。本文は含めない（rev と live の revision で変化が分かる）。 */
	private desktopChatSignature(token: string): string {
		const tailer = this.tailers.get(token);
		if (tailer === undefined || !this.paneSessions.has(token)) {
			return '';
		}
		const interaction = tailer.currentInteraction();
		const info = this.infoOf(token, tailer);
		return [
			tailer.epoch, tailer.rev, this.liveRevisions.get(token) ?? 0,
			interaction === null ? '' : `${interaction.kind}:${interaction.id}:${interaction.kind === 'approval' ? interaction.choices?.length ?? 0 : ''}`,
			info?.model ?? '', info?.effort ?? '',
			this.activeTurnTokens.has(token) ? 'busy' : 'idle',
			this.desktopExitedTokens.has(token) ? 'exited' : '',
		].join('\0');
	}

	private activityTracker(token: string): ParadisAgentActivityTracker {
		let tracker = this.activityTrackers.get(token);
		if (tracker === undefined) {
			tracker = new ParadisAgentActivityTracker();
			this.activityTrackers.set(token, tracker);
		}
		return tracker;
	}

	/**
	 * 60秒周期の失効処理。落とす前に必ず永続transcriptで生存を確認する。
	 *
	 * 親のhookは子Agentが走っている間は届かないため、確認なしに失効させると
	 * 「まだ動いている子Agentが状態不明になる」誤表示が必ず起きる。
	 */
	private async sweepAgentActivity(): Promise<void> {
		const active = [...this.activityTrackers].filter(([, tracker]) => tracker.hasActiveWork()).map(([token]) => token);
		await Promise.all(active.map(token => this.reconcilePersistedAgentActivity(token)
			.catch(error => this.logService.trace('[paradisAgentChat] activity liveness check failed', String(error)))));
		const now = Date.now();
		for (const [token, tracker] of this.activityTrackers) {
			if (tracker.sweepStale(now)) {
				this.pushActivityToSubscribers(token);
			}
		}
		this.sweepStaleLiveStates(now);
	}

	private schedulePersistedAgentActivityReconcile(token: string, delay = 350): void {
		const previous = this.persistedActivityTimers.get(token);
		if (previous !== undefined) { clearTimeout(previous); }
		const timer = setTimeout(() => {
			this.persistedActivityTimers.delete(token);
			this.reconcilePersistedAgentActivity(token).catch(error => this.logService.trace('[paradisAgentChat] persisted activity recovery failed', String(error)));
		}, delay);
		this.persistedActivityTimers.set(token, timer);
	}

	/** 現在の親セッションが所有する永続JSONだけから、欠落したSubAgent活動を補完する。 */
	private async reconcilePersistedAgentActivity(token: string): Promise<void> {
		const session = this.paneSessions.get(token);
		const tailer = this.tailers.get(token);
		if (session === undefined || tailer === undefined || !this.isLiveToken(token)) { return; }
		const epoch = tailer.epoch;
		const now = Date.now();
		const recovered: IParadisRecoveredAgentActivity[] = [];
		const claudeTranscriptPaths: { readonly id: string; readonly path: string }[] = [];
		// SendMessage で再開した呼び出し（子の ID → toolUseId）。会話のカードと一覧の項目を結ぶ
		const resumeToolUseIds = new Map<string, string[]>();
		// Advisor への相談（親の会話と、各サブエージェントの transcript から。サブエージェントの分はその子の ID を持つ）
		const advisors: IParadisAgentAdvisorUpdate[] = [];
		const rememberResumes = (found: ReadonlyMap<string, readonly string[]>) => {
			for (const [id, toolUseIds] of found) {
				resumeToolUseIds.set(id, [...(resumeToolUseIds.get(id) ?? []), ...toolUseIds]);
			}
		};
		if (session.agent === 'claude') {
			const owners = new Map<string, IParadisRecoveredAgentActivity>();
			const spawned = new Map<string, IParadisRecoveredAgentActivity>();
			const rememberSpawned = (agent: IParadisRecoveredAgentActivity) => {
				const previous = spawned.get(agent.id);
				if (previous === undefined || agent.updatedAt >= previous.updatedAt) {
					// 起動の呼び出しの id は、起動を読めた記録にしか無い。新しい記録で消さない
					spawned.set(agent.id, agent.toolUseIds === undefined && previous?.toolUseIds !== undefined ? { ...agent, toolUseIds: previous.toolUseIds } : agent);
				}
			};
			// ID の付いていない完了通知（起動の記録が読み込み範囲の外にあった等）。Bash や Monitor の通知も
			// 混ざるので、子 transcript が実在する ID にだけ当てる。
			const notifications = new Map<string, { readonly status: IParadisRecoveredAgentActivity['status']; readonly at: number }>();
			const rememberNotifications = (found: ReadonlyMap<string, { readonly status: IParadisRecoveredAgentActivity['status']; readonly at: number }>) => {
				for (const [id, notice] of found) {
					const previous = notifications.get(id);
					if (previous === undefined || notice.at >= previous.at) { notifications.set(id, notice); }
				}
			};
			const rootStat = await fs.stat(session.transcriptPath).catch(() => undefined);
			const rootLines = await readPersistedTranscriptLines(session.transcriptPath);
			if (rootStat !== undefined) {
				const parsed = paradisParseClaudePersistedActivity(undefined, rootLines, rootStat.mtimeMs, now);
				for (const agent of parsed.spawned) { rememberSpawned(agent); }
				rememberNotifications(parsed.notifications);
				rememberResumes(parsed.resumeToolUseIds);
				advisors.push(...paradisParseClaudeAdvisors(undefined, rootLines, now));
			}
			const files = await discoverClaudePersistedSubagentFiles(session.transcriptPath);
			// 名前付きの起動は、親の会話が名前で呼び、ファイルは別の ID を持つ。名前 → ファイル ID で1つに束ねる
			const fileIdsByName = new Map<string, string>();
			for (const file of files) {
				const fileLines = await readPersistedTranscriptLines(file.path);
				const parsed = paradisParseClaudePersistedActivity(file.id, fileLines, file.mtime, now, file.meta);
				advisors.push(...paradisParseClaudeAdvisors(file.id, fileLines, now));
				// ファイル ID から名前を取るのは meta の写らない SSH の写しだけ（手元の古い版の `acompact-` 等を名前と誤読しない）
				const fileName = file.meta?.name ?? (paradisIsRemoteAgentTranscriptMirrorPath(file.path) ? paradisClaudeNamedAgentFromFileId(file.id) : undefined);
				if (parsed.owner !== undefined) { owners.set(file.id, fileName !== undefined ? { ...parsed.owner, name: fileName, label: fileName } : parsed.owner); }
				for (const agent of parsed.spawned) { rememberSpawned(agent); }
				rememberNotifications(parsed.notifications);
				rememberResumes(parsed.resumeToolUseIds);
				if (fileName !== undefined) { fileIdsByName.set(fileName, file.id); }
				claudeTranscriptPaths.push({ id: file.id, path: file.path });
			}
			for (const [id, agent] of [...spawned]) {
				const fileId = fileIdsByName.get(agent.name ?? id);
				if (fileId !== undefined && fileId !== id && !owners.has(id)) {
					spawned.delete(id);
					rememberSpawned({ ...agent, id: fileId });
				}
			}
			for (const [name, toolUseIds] of [...resumeToolUseIds]) {
				const fileId = fileIdsByName.get(name);
				if (fileId !== undefined && fileId !== name) {
					resumeToolUseIds.delete(name);
					resumeToolUseIds.set(fileId, [...(resumeToolUseIds.get(fileId) ?? []), ...toolUseIds]);
				}
			}
			for (const [id, notice] of notifications) {
				const owner = owners.get(id);
				if (owner !== undefined && !spawned.has(id) && notice.at >= (owner.lastLineAt ?? 0)) {
					rememberSpawned({ ...owner, status: notice.status, updatedAt: Math.max(owner.updatedAt, notice.at) });
				}
			}
			for (const id of new Set([...owners.keys(), ...spawned.keys()])) {
				const owner = owners.get(id);
				const spawn = spawned.get(id);
				if (owner === undefined) { if (spawn !== undefined) { recovered.push(spawn); } continue; }
				if (spawn === undefined) { recovered.push(owner); continue; }
				// 親の会話の「完了」（完了通知・フォアグラウンドの結果）は、子がその後に書いた作業を打ち消さない。
				// SendMessage で再開した子は、古い完了の記録の後に新しい行を書き続ける。
				const explicitTerminal = (spawn.status === 'completed' || spawn.status === 'failed' || spawn.status === 'interrupted')
					&& spawn.updatedAt >= (owner.lastLineAt ?? 0);
				recovered.push({
					...owner,
					...(owner.name !== undefined || spawn.name === undefined ? {} : { name: spawn.name }),
					// 名前付きの起動は名前の方が見分けやすい（種類は同じ code-reviewer が並びがち）
					label: owner.name ?? (spawn.label !== 'SubAgent' ? spawn.label : owner.label),
					...(spawn.detail !== undefined ? { detail: spawn.detail } : {}),
					...(spawn.parentId !== undefined ? { parentId: spawn.parentId } : {}),
					...(spawn.depth !== undefined ? { depth: spawn.depth } : {}),
					...(spawn.toolUseIds !== undefined ? { toolUseIds: spawn.toolUseIds } : {}),
					status: explicitTerminal ? spawn.status : owner.status,
					startedAt: Math.min(spawn.startedAt, owner.startedAt),
					updatedAt: explicitTerminal ? Math.max(spawn.updatedAt, owner.updatedAt) : owner.updatedAt,
				});
			}
		} else if (session.sessionId !== undefined) {
			// homes が引けないのは接続先のペイン。SubAgent の記録は向こうのディスクにあるので、
			// 手元の ~/.codex を探しに行かせない（同じ綴りの別マシンの記録を並べてしまう）
			const homes = this.agentHomesForToken(token);
			const files = homes === undefined ? [] : await discoverCodexPersistedSubagentFiles(session.sessionId, homes);
			for (const file of files) {
				const parsed = paradisParseCodexPersistedActivity(file.id, file.source, await readPersistedTranscriptLines(file.path), file.mtime, now);
				if (parsed === undefined) { continue; }
				if (parsed.parentId === session.sessionId) {
					const { parentId: _, ...rootChild } = parsed;
					recovered.push(rootChild);
				} else {
					recovered.push(parsed);
				}
			}
		}
		if (this.paneSessions.get(token) !== session || this.tailers.get(token)?.epoch !== epoch || !this.isLiveToken(token)) { return; }
		for (const item of claudeTranscriptPaths) {
			this.claudeSubagentTranscriptPaths.set(`${token}\0${item.id}`, item.path);
		}
		const allowedIds = new Set<string>();
		const bounded = recovered.filter(agent => {
			if (allowedIds.has(agent.id)) { return true; }
			if (allowedIds.size >= PERSISTED_ACTIVITY_MAX_AGENTS) { return false; }
			allowedIds.add(agent.id);
			return true;
		});
		let changed = bounded.length > 0 && this.activityTracker(token).mergeRecoveredAgents(bounded, now);
		if (advisors.length > 0) {
			changed = this.activityTracker(token).applyAdvisors(advisors, now) || changed;
		}
		for (const [id, toolUseIds] of resumeToolUseIds) {
			for (const toolUseId of toolUseIds) {
				changed = this.activityTracker(token).linkToolUse(id, toolUseId, now) || changed;
			}
		}
		if (changed) {
			this.pushActivityToSubscribers(token);
		}
	}

	private async enrichCodexActivityRelationship(token: string, activityId: string, at: number): Promise<void> {
		// homes が引けないのは接続先のペイン。親子関係は向こうのディスクを読まないと分からないので、
		// 手元の ~/.codex から拾った同名 thread を親として付けてしまわないよう、ここで止める
		const homes = this.agentHomesForToken(token);
		if (homes === undefined) { return; }
		const source = await discoverCodexThreadSourceById(activityId, homes);
		if (source === undefined || !this.isLiveToken(token)) { return; }
		const rootThreadId = this.paneSessions.get(token)?.sessionId;
		const parentId = source.parentThreadId === rootThreadId ? undefined : source.parentThreadId;
		if (this.activityTracker(token).setAgentRelationship(activityId, parentId, source.depth, at)) {
			this.pushActivityToSubscribers(token);
		}
	}

	/**
	 * hookの発信元rolloutが root thread か SubAgent かを返す（非Codexは undefined）。
	 * 判定材料は rollout 先頭行の session_meta だけで、これは書き出し後に変わらないため
	 * path単位で結果を保持する。読めなかった場合は 'unknown' を返し、覚えない
	 * （子の生成直後は先頭行がまだ書かれておらず、rootと断定すると乗っ取りが再発する）。
	 */
	private async codexRolloutOrigin(transcriptPath: string): Promise<ParadisCodexRolloutOrigin | undefined> {
		if (agentKindForPath(transcriptPath) !== 'codex') {
			return undefined;
		}
		const cached = this.codexRolloutOrigins.get(transcriptPath);
		if (cached !== undefined) {
			return cached;
		}
		const meta = await readCodexRolloutSessionMeta(transcriptPath);
		if (meta === undefined) {
			return 'unknown';
		}
		if (this.codexRolloutOrigins.size >= CODEX_ROLLOUT_ORIGIN_CACHE_LIMIT) {
			const oldest = this.codexRolloutOrigins.keys().next();
			if (oldest.done !== true) {
				this.codexRolloutOrigins.delete(oldest.value);
			}
		}
		const origin: ParadisCodexRolloutOrigin = meta.subagent === true ? 'subagent' : 'root';
		this.codexRolloutOrigins.set(transcriptPath, origin);
		return origin;
	}

	private clearClaudeSubagentTranscripts(token: string): void {
		for (const key of this.claudeSubagentTranscriptPaths.keys()) {
			if (key.startsWith(`${token}\0`)) { this.claudeSubagentTranscriptPaths.delete(key); }
		}
	}

	private pushActivityToSubscribers(token: string): void {
		this.scheduleDesktopInsightCheck();
		const terminalId = this.terminalIdForToken(token);
		const tailer = this.tailers.get(token);
		if (terminalId !== undefined && tailer !== undefined) {
			this.sendToSubscribers(token, {
				t: 'delta', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev,
				messages: [], activity: this.activityTrackers.get(token)?.snapshot() ?? null,
			});
		}
	}

	private onHookEvent(event: IParadisAgentHookEvent): void {
		this.recordDesktopInteraction(event);
		// デスクトップのチャット表示が「エージェントはもう終わった」と判断するための印（終わったペインへ
		// 文を送ると、シェルでコマンドとして実行されるため）。SessionEnd の後に別の hook が来たら消す。
		if (event.event === 'SessionEnd') {
			this.desktopExitedTokens.add(event.token);
			this.sessionEndedAt.set(event.token, event.at);
			this.tailers.get(event.token)?.endMonitorsForSessionEnd(event.at);
		} else if (this.desktopExitedTokens.delete(event.token)) {
			this.sessionEndedAt.delete(event.token);
			this.scheduleDesktopChatCheck();
		}
		// hook はペインの環境変数を継承したプロセスからしか届かない。届いた時点で
		// 「今このペインでエージェントが動いている」証拠になる（transcript の有無は問わない）。
		if (this.isLiveToken(event.token)) {
			this.rememberAgentEvidence(event.token);
		}
		// 印が付いていれば、このペインのエージェントは接続先で動いている。transcript の有無に
		// 関わらず覚えておく（手元のディスクを探しに行かせないための唯一の根拠になる）。
		if (event.remoteHostId !== undefined) {
			this.tokenToRemoteHost.set(event.token, { host: event.remoteHostId, at: Date.now() });
			this.remoteHookAt.set(event.token, event.at);
		}
		if (event.transcriptPath === undefined || event.transcriptPath.length === 0) {
			// agent種別を確定できないため、transcript_path無しのhookだけではcwd探索しない。
			// CLI検知経路がagent種別付きで鮮度検証済み探索を行う。
			return;
		}
		// SSH 接続先の hook が名乗るのは接続先のパスで、ここからは開けない。写し先のパスへ
		// 読み替えて、以降はローカルの transcript と全く同じ経路に乗せる。写しがまだ無くても
		// tailer はファイルの出現を待てるので、ここで足踏みする必要はない。
		const transcriptPath = this.remoteTranscriptMirror?.localPathForHookPath(event.transcriptPath, event.token, event.remoteHostId) ?? event.transcriptPath;
		if (transcriptPath !== event.transcriptPath) {
			this.followRemoteSubagentTranscript(event);
		}
		this.enqueueHookEvent(event, transcriptPath, false);
	}

	/**
	 * SSH の接続先の Codex の rollout を、ウィンドウが接続先のディスクから見つけた（hook が届かない
	 * 接続先でも会話を写すための経路。relay の noteRemoteAgentTranscript から来る）。
	 *
	 * 写しの対象に加え、そのペインの会話として結び付ける（cwd 探索の discoverAndNotify と同じ置き換え方）。
	 * `codex` の起動より後に接続先の hook が届いていれば、hook の方が正しいので何もしない
	 * （同じ作業ディレクトリで 2 つの Codex を動かしていると、こちらは取り違えうる）。
	 */
	async onRemoteTranscriptDiscovered(token: string, remotePath: string, remoteHostId: string, commandStartedAt: number): Promise<'accepted' | 'ignored' | 'hooked' | 'stale'> {
		if (!this.isLiveToken(token)) {
			return 'stale';
		}
		if ((this.remoteHookAt.get(token) ?? Number.NEGATIVE_INFINITY) >= commandStartedAt) {
			return 'hooked';
		}
		if (agentKindForPath(remotePath) !== 'codex') {
			return 'ignored';
		}
		const transcriptPath = this.remoteTranscriptMirror?.localPathForHookPath(remotePath, token, remoteHostId);
		if (transcriptPath === undefined || !(await isAllowedTranscriptPath(transcriptPath))) {
			return 'ignored';
		}
		if (!this.isLiveToken(token)) {
			return 'stale';
		}
		if ((this.remoteHookAt.get(token) ?? Number.NEGATIVE_INFINITY) >= commandStartedAt) {
			return 'hooked';
		}
		// 接続先で動くペインだと覚える（手元の ~/.codex を cwd で探しに行かせない）
		this.tokenToRemoteHost.set(token, { host: remoteHostId, at: Date.now() });
		if (this.transcriptClaimedByOther(transcriptPath, token)) {
			return 'ignored';
		}
		const previous = this.paneSessions.get(token);
		if (previous?.transcriptPath === transcriptPath) {
			return 'accepted';
		}
		if (previous !== undefined) {
			this.paneSessions.delete(token);
			if (this.transcriptClaims.get(previous.transcriptPath) === token) {
				this.transcriptClaims.delete(previous.transcriptPath);
			}
			this.disposeTailer(token);
			this.clearLiveState(token);
			this.activityTrackers.delete(token);
			this.advisorLiveIds.delete(token);
			this.clearClaudeSubagentTranscripts(token);
			this.activeTurnTokens.delete(token);
		}
		// rollout の名前の末尾は thread id（rollout-<時刻>-<uuid>.jsonl）
		const sessionId = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(remotePath)?.[1];
		const session: IPaneSessionInfo = { token, agent: 'codex', transcriptPath, sessionId };
		this.paneSessions.set(token, session);
		this.retiredSessions.delete(token);
		this.persistSessions();
		this.transcriptClaims.set(transcriptPath, token);
		this.emitConfirmedAgentPanesIfChanged();
		this.ensureEagerTailer(token, session);
		this.pushToSubscribers(token);
		this.logService.info(`[paradisAgentChat] following a Codex conversation on the host without hooks: ${remotePath}`);
		return 'accepted';
	}

	/**
	 * 接続先で動くサブエージェントの transcript も写す対象に加える。写しは hook の `transcript_path`
	 * が指すファイルにしか張られず、子のファイル（`<session>/subagents/agent-<id>.jsonl`）はそこに
	 * 現れないので、加えないと一覧の補完も詳細の表示も手元で空振りする。
	 */
	private followRemoteSubagentTranscript(event: IParadisAgentHookEvent): void {
		if (event.event !== 'SubagentStart' && event.event !== 'SubagentStop') {
			return;
		}
		const agentId = str(event.payload?.agent_id);
		if (agentId === undefined || !PARADIS_CLAUDE_AGENT_ID_PATTERN.test(agentId) || event.transcriptPath === undefined) {
			return;
		}
		const reported = str(event.payload?.agent_transcript_path);
		const rootPath = event.transcriptPath;
		// 子の中で起きた hook は、子自身の transcript を名乗る。その場合は親の置き場から辿れない
		const derived = /\.jsonl$/i.test(rootPath) && paradisClaudeAgentIdFromTranscriptPath(rootPath) === undefined
			? `${rootPath.slice(0, -'.jsonl'.length)}/subagents/agent-${agentId}.jsonl`
			: undefined;
		const remotePath = reported !== undefined && paradisClaudeAgentIdFromTranscriptPath(reported) === agentId ? reported : derived;
		if (remotePath === undefined) {
			return;
		}
		this.remoteTranscriptMirror?.localPathForHookPath(remotePath, event.token, event.remoteHostId);
		if (event.event === 'SubagentStop') {
			// 終わった子の写しを台帳に残し続けると、接続先の監視と読み取りが子の数だけ増える。
			// Start で導いたパスが Stop の申告と違った場合は、そちらも外す。
			this.remoteTranscriptMirror?.noteSubagentFinished(remotePath);
			if (derived !== undefined && derived !== remotePath) {
				this.remoteTranscriptMirror?.noteSubagentFinished(derived);
			}
		}
	}

	/**
	 * そのペインのエージェントが SSH の接続先で動いているか。
	 *
	 * 根拠は hook に付いてきた接続先の印。shared process が上がり直した直後は印が無いので、
	 * ディスクから復元したセッションについては transcript が写し置き場の中にあるかも見る
	 * （写しを作るのは私たちだけなので、置き場の中にあること自体が接続先のものである証拠）。
	 */
	private isRemoteAgentPane(token: string): boolean {
		return this.tokenToRemoteHost.has(token)
			|| paradisIsRemoteAgentTranscriptMirrorPath(this.paneSessions.get(token)?.transcriptPath)
			|| paradisIsRemoteAgentTranscriptMirrorPath(this.retiredSessions.get(token)?.session.transcriptPath);
	}

	/**
	 * realpath検証を含むhook処理をtoken単位で直列化する。
	 *
	 * hookは別々のHTTP要求として並行到着する。検証完了順を「最新」とみなして先行イベントを
	 * 捨てると、AskUserQuestionやStopのような一度しか来ない状態遷移まで失われるため、受信順を
	 * 保ったまま全イベントを処理する。
	 */
	private enqueueHookEvent(event: IParadisAgentHookEvent, transcriptPath: string, pathAlreadyChecked: boolean): void {
		const previous = this.hookProcessing.get(event.token) ?? Promise.resolve();
		const current = previous
			.then(() => this.onHookEventChecked(event, transcriptPath, pathAlreadyChecked))
			.catch(err => this.logService.warn('[paradisAgentChat] hook event handling failed', err));
		this.hookProcessing.set(event.token, current);
		void current.then(() => {
			if (this.hookProcessing.get(event.token) === current) {
				this.hookProcessing.delete(event.token);
			}
		});
	}

	/**
	 * ネストした子エージェント（ingress の所有権分類が 'nested' としたhook）を
	 * Agent tree & Tasks へ投影する。ペインの親セッション・tailer・ライブ状態は触らない。
	 */
	private onNestedHookEvent(event: IParadisAgentNestedHookEvent): void {
		// 印は親のhookと同じように覚える。子のhookが先に届くことがあり（shared process の
		// 再起動直後など）、そこで取りこぼすと親の初回hookが来るまで手元のペイン扱いのままになる。
		if (event.remoteHostId !== undefined) {
			this.tokenToRemoteHost.set(event.token, { host: event.remoteHostId, at: Date.now() });
		}
		// 子エージェントや daemon の会話の transcript は、どのペインの会話でもない。照合で採らないよう覚える。
		if (event.transcriptPath !== undefined && event.transcriptPath.length > 0 && event.remoteHostId === undefined) {
			this.hookTranscriptSightings.note(event.transcriptPath, event.token, event.background === true ? 'background' : 'nested', Date.now());
		}
		if (event.background === true) {
			// daemon の配下で動く会話（`/fork` の分岐先・`claude --bg`）。daemon を最初に起こしたペインの
			// token を持って届くだけで、そのペインの子エージェントではない。ペインには何も出さない。
			return;
		}
		if (!this.isLiveToken(event.token)) {
			return;
		}
		const provider = event.nestedAgent
			?? (event.transcriptPath !== undefined && event.transcriptPath.length > 0 ? agentKindForPath(event.transcriptPath) : undefined);
		const key = event.sessionId ?? event.transcriptPath;
		if (provider === undefined || key === undefined || key.length === 0) {
			return;
		}
		if (this.activityTracker(event.token).applyNestedAgentHook(provider, key, event.event, event.at, str(event.payload?.prompt))) {
			this.pushActivityToSubscribers(event.token);
		}
	}

	/**
	 * そのターミナルで動くエージェントCLIのホーム。作業ディレクトリが分からないうちは
	 * 従来どおりこのプロセスのホームを指す。
	 *
	 * 接続先で動いているペインでは undefined を返す。向こうのホームは手元から開けず、代わりに
	 * 手元のホームを返すと、同じ綴りの別マシンの記録を「このペインのもの」として見せてしまう
	 * （SubAgent の一覧・詳細は、間違ったものを出すくらいなら出ない方がよい）。
	 */
	private agentHomesForToken(token: string): IParadisAgentHomes | undefined {
		if (this.isRemoteAgentPane(token)) {
			return undefined;
		}
		return paradisResolveAgentHomes(this.tokenToCwd.get(token) ?? '');
	}

	private sessionScanStartedAt: number | undefined;
	/** 作業ディレクトリごとの、Codex の sessions/ を最後に総なめした時刻と走査予算。 */
	private readonly codexDirectoryWalkLedger: IParadisDirectoryWalkBudget;

	/**
	 * コマンド検知に頼らず、作業ディレクトリだけを頼りにセッションを見つける。
	 *
	 * 実行コマンドからの検知は、ターミナルで走っているのが literal な `claude` / `codex` の
	 * ときにしか成立しない。ssh やエイリアス越しに起動している場合、Para Code を起動する前から
	 * 動いている場合、ラッパを噛ませている場合は、そこに一切引っかからない。ここでは直近に
	 * 書き込みのあった transcript だけを候補にして突き合わせる。
	 */
	private async scanPanesForUnclaimedSessions(): Promise<void> {
		// 9p/UNC が固まって読み取りが返らないと、排他フラグを戻す機会そのものが来ない。
		// この機能が効くのはまさにその環境なので、時間で強制解除する。
		if (this.sessionScanStartedAt !== undefined && Date.now() - this.sessionScanStartedAt < PARADIS_SESSION_SCAN_STUCK_MS) {
			return;
		}
		if (this.attachDisposed) {
			return;
		}
		// 同じ作業ディレクトリに未確定のターミナルが2つ以上あるときは、どちらのセッションなのかを
		// 作業ディレクトリだけでは原理的に決められない。取り違えたまま永続化されるくらいなら、
		// 何もしないほうがよい（そのぶん、同じ場所で2枚目を開いている間は検知されない）。
		const tokensByCwd = new Map<string, { readonly token: string; readonly cwd: string }[]>();
		for (const [token, cwd] of this.tokenToCwd) {
			if (!this.isLiveToken(token) || this.paneSessions.has(token)) {
				continue;
			}
			// 接続先で動いているペインの作業フォルダは向こうの綴り。手元に同じ綴りがあると
			// （同名ユーザーの Linux 同士など）手元のセッションを掴んでしまうので探索しない。
			// このペインは hook（＝接続先からの唯一の経路）でしか確定させない。
			if (this.isRemoteAgentPane(token)) {
				continue;
			}
			const key = paradisCwdGroupKey(cwd);
			const panes = tokensByCwd.get(key);
			if (panes !== undefined) { panes.push({ token, cwd }); } else { tokensByCwd.set(key, [{ token, cwd }]); }
		}
		const targets = [...tokensByCwd.values()].filter(panes => panes.length === 1).map(panes => panes[0]);
		if (targets.length === 0) {
			return;
		}
		const scanStartedAt = Date.now();
		this.sessionScanStartedAt = scanStartedAt;
		try {
			for (const { token, cwd } of targets) {
				if (this.attachDisposed) {
					return;
				}
				// 退避中のペインが持っている transcript には手を出さない。先に掴んでしまうと、本来の
				// 持ち主が復活するときに claim を取り戻せず、会話を恒久的に失う。1周は UNC 越しで
				// 秒単位かかるので、ループの中で取り直す（開始時の1枚では取りこぼす）。
				const minMtime = Date.now() - PARADIS_SESSION_SCAN_RECENT_MS;
				// 世代は据え置く（進行中のCLI探索を無効化しないため）。未登録のまま 0 を渡すと
				// discoverAndNotify の世代ガードで即 return されるので、無ければ 0 を登録しておく。
				let generation = this.cliDiscoveryGenerations.get(token);
				if (generation === undefined) {
					generation = 0;
					this.cliDiscoveryGenerations.set(token, generation);
				}
				for (const agent of ['claude', 'codex'] as const) {
					if (this.attachDisposed || this.paneSessions.has(token) || !this.isLiveToken(token)) {
						break;
					}
					// 退避中のペインが持っている transcript には手を出さない。先に掴んでしまうと、本来の
					// 持ち主が復活するときに claim を取り戻せず、会話を恒久的に失う。1回の探索が
					// 秒単位かかるので、その都度取り直す（周回の頭で1枚取るだけでは取りこぼす）。
					const retained = new Set([...this.retiredSessions.values()].map(entry => entry.session.transcriptPath));
					// mode は 'resume' 固定。'new' / 'fork' は生成時刻での相関を要求するので、
					// Para Code を起動する前から動いているセッションが必ず落ちる。
					const cwdGroupKey = paradisCwdGroupKey(cwd);
					const allowCodexDirectoryWalk = agent === 'codex' && this.codexDirectoryWalkLedger.mayRun(cwdGroupKey);
					// state DB が使えず、実際に Codex の sessions/ 走査へ入ったcallbackでだけ予算を消費する。
					const onCodexDirectoryWalk = agent === 'codex' ? () => this.codexDirectoryWalkLedger.mark(cwdGroupKey) : undefined;
					await this.discoverAndNotify(token, agent, 'resume', cwd, minMtime, generation, undefined, retained, allowCodexDirectoryWalk, onCodexDirectoryWalk)
						.catch(err => this.logService.trace(`[paradisAgentChat] standing session scan failed: ${err instanceof Error ? err.message : String(err)}`));
				}
			}
		} finally {
			// 強制解除で始まった次の周回の印を消さない（消すと30秒ごとに周回が積み上がる）。
			if (this.sessionScanStartedAt === scanStartedAt) {
				this.sessionScanStartedAt = undefined;
			}
		}
	}

	/**
	 * このペインの照合で、Codex の fork 先をどう扱うか。fork 先を結んでよいのは、元がこのペインの今の会話
	 * （TUI の `/fork`）か、このペインで打った `codex fork X` の X のときだけ。ほかのペインで打った
	 * `codex fork X` の X から作られた fork 先は、そのペインのものなので外す。
	 */
	private codexForkPolicyFor(token: string, mode: ParadisCliDiscoveryMode): IParadisCodexForkPolicy {
		const request = this.cliCodexForkRequests.get(token);
		const allowedParents = new Set<string>();
		const ownSessionId = this.paneSessions.get(token)?.sessionId;
		if (ownSessionId !== undefined) {
			allowedParents.add(ownSessionId);
		}
		if (request?.kind === 'parent') {
			allowedParents.add(request.parentId);
		}
		const reservedParents = new Set<string>();
		for (const [other, otherRequest] of this.cliCodexForkRequests) {
			if (other !== token && otherRequest.kind === 'parent' && this.isLiveToken(other)) {
				reservedParents.add(otherRequest.parentId);
			}
		}
		const foreignParents = new Set<string>();
		for (const [other, session] of this.paneSessions) {
			if (other !== token && session.agent === 'codex' && session.sessionId !== undefined && this.isLiveToken(other)) {
				foreignParents.add(session.sessionId);
			}
		}
		return { allowedParents, anyParent: request?.kind === 'any', foreignParents, reservedParents, forkOnly: mode === 'fork' };
	}

	/** cwdからセッションを探し、見つかれば登録して購読者へスナップショットを送り直す。 */
	private async discoverAndNotify(token: string, agent: ParadisAgentKind, mode: ParadisCliDiscoveryMode, cwd: string, minMtime: number | undefined, generation: number, requestedSessionId?: string, additionalExcludedPaths?: ReadonlySet<string>, allowCodexDirectoryWalk: boolean = true, onCodexDirectoryWalk?: () => void): Promise<void> {
		// 探索先はどれも手元のディスク（~/.claude/projects と ~/.codex/sessions）。接続先で
		// 動いているペインに当てると、たまたま同じ綴りの手元のセッションを結び付けてしまう。
		// shell integration 由来の cwd も向こうの綴りなので、ここが最後の関所になる。
		if (this.isRemoteAgentPane(token)) {
			return;
		}
		const previous = this.paneSessions.get(token);
		if (requestedSessionId !== undefined && previous?.sessionId === requestedSessionId) {
			return;
		}
		if (mode === 'attach' && requestedSessionId !== undefined && previous !== undefined && previous.agent === 'claude'
			&& paradisClaudeSessionIdOfTranscript(previous.transcriptPath)?.startsWith(requestedSessionId.toLowerCase()) === true) {
			return;
		}
		const claimedByOthers = new Set([...this.transcriptClaims]
			.filter(([, owner]) => owner !== token)
			.map(([path]) => path));
		if (previous !== undefined) {
			claimedByOthers.add(previous.transcriptPath);
		}
		for (const path of additionalExcludedPaths ?? []) {
			claimedByOthers.add(path);
		}
		// hook で見たほかのペインの会話・子エージェントの会話・daemon の会話は、作業フォルダが同じでも採らない。
		for (const path of this.hookTranscriptSightings.excludedFor(token, Date.now())) {
			claimedByOthers.add(path);
		}
		let exactSession = false;
		let discovered: { agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number } | undefined;
		if (mode === 'attach') {
			// `claude attach <id>`: 会話 id の先頭で決め打ちする。見つからない・決められないときは何もしない
			// （作業フォルダから推測すると、同じフォルダの元の会話や別の分岐先を掴む）。daemon の会話の控えは
			// ここでは外さない（attach する相手そのものなので）。ほかのペインの claim だけを避ける。
			if (agent !== 'claude' || requestedSessionId === undefined) {
				return;
			}
			const homes = paradisResolveAgentHomes(cwd);
			const projectsRoot = join(homes.claude, 'projects');
			const scanAllProjects = async (idPrefix: string) => {
				const cached = this.attachProjectScans.get(token);
				if (cached !== undefined && cached.generation === generation && cached.idPrefix === idPrefix) {
					return cached.result;
				}
				const result = await paradisListClaudeTranscriptsByIdPrefixAcrossProjects(projectsRoot, idPrefix);
				// 一致があったときだけ使い回す（まだ書かれていない transcript は、次の再試行で見つかりうる）
				if (result.length > 0) {
					this.attachProjectScans.set(token, { generation, idPrefix, result });
				}
				return result;
			};
			const found = await paradisFindClaudeTranscriptByIdPrefix(projectsRoot, await paradisClaudeProjectDirForCwd(cwd, homes), requestedSessionId, scanAllProjects);
			// ほかのペインの claim と、退避中のペイン（復活を待っている）の会話は採らない
			const retained = [...this.retiredSessions].some(([retiredToken, entry]) => retiredToken !== token && entry.session.transcriptPath === found?.transcriptPath);
			if (found === undefined || retained || this.transcriptClaimedByOther(found.transcriptPath, token)) {
				return;
			}
			discovered = { agent: 'claude', transcriptPath: found.transcriptPath, mtime: found.mtime, sessionId: found.sessionId };
			exactSession = true;
		}
		if (agent === 'codex' && requestedSessionId !== undefined && PARADIS_CODEX_THREAD_ID_PATTERN.test(requestedSessionId)) {
			const transcriptPath = await discoverCodexRootTranscriptByThreadId(requestedSessionId, paradisResolveAgentHomes(cwd));
			if (transcriptPath !== undefined && !claimedByOthers.has(transcriptPath)) {
				const stat = await fs.stat(transcriptPath).catch(() => undefined);
				if (stat !== undefined) {
					discovered = { agent: 'codex', transcriptPath, mtime: stat.mtimeMs, sessionId: requestedSessionId };
					exactSession = true;
				}
			}
		}
		if (mode !== 'attach') {
			const codexForkPolicy = agent === 'codex' ? this.codexForkPolicyFor(token, mode) : undefined;
			discovered ??= await discoverSessionByCwd(cwd, agent, minMtime, claimedByOthers, mode, allowCodexDirectoryWalk, onCodexDirectoryWalk, codexForkPolicy);
		}
		if (discovered === undefined || this.attachDisposed
			|| this.cliDiscoveryGenerations.get(token) !== generation
			|| !this.isLiveToken(token) || this.tokenToCwd.get(token) !== cwd
			|| this.transcriptClaimedByOther(discovered.transcriptPath, token)
			|| !(await isAllowedTranscriptPath(discovered.transcriptPath))) {
			return;
		}
		// CLI起動との相関には更新時刻ではなくファイル生成時刻を使う。別paneの古いthreadが
		// 偶然同時に更新されても、新規起動paneへ割り当てない。復元探索はこの制約を使わない。
		// state DB由来の候補はDBのcreated_atで判定する。Codexは最初のターンまでrollout実ファイルを
		// 生成しないため、ファイルのbirthtimeを待つと起動直後のセッションを取りこぼす。
		if (!exactSession && minMtime !== undefined && discovered.createdAt !== undefined) {
			if (!paradisCliDiscoveryCandidateIsFresh(discovered, minMtime, mode)) { return; }
		} else if (!exactSession && minMtime !== undefined && mode !== 'resume') {
			try {
				const stat = await fs.stat(discovered.transcriptPath);
				if (stat.birthtimeMs < minMtime) { return; }
			} catch { return; }
		}
		if (this.attachDisposed
			|| this.cliDiscoveryGenerations.get(token) !== generation
			|| !this.isLiveToken(token) || this.tokenToCwd.get(token) !== cwd
			|| this.transcriptClaimedByOther(discovered.transcriptPath, token)
			|| this.paneSessions.get(token) !== previous) {
			return;
		}
		if (previous?.transcriptPath === discovered.transcriptPath) {
			return;
		}
		if (previous !== undefined) {
			this.paneSessions.delete(token);
			if (this.transcriptClaims.get(previous.transcriptPath) === token) {
				this.transcriptClaims.delete(previous.transcriptPath);
			}
			this.disposeTailer(token);
			this.clearLiveState(token);
			this.activityTrackers.delete(token);
			this.advisorLiveIds.delete(token);
			this.clearClaudeSubagentTranscripts(token);
			this.activeTurnTokens.delete(token);
		}
		const session: IPaneSessionInfo = { token, agent: discovered.agent, transcriptPath: discovered.transcriptPath, sessionId: discovered.sessionId };
		this.paneSessions.set(token, session);
		this.retiredSessions.delete(token);
		// `codex fork X` の fork 先が結ばれた（以後の `/fork` は、今の会話を元にして追う）
		this.cliCodexForkRequests.delete(token);
		this.persistSessions();
		this.transcriptClaims.set(discovered.transcriptPath, token);
		this.cliReconciliationWatermarks.set(token, Math.max(this.cliReconciliationWatermarks.get(token) ?? 0, discovered.mtime + 1));
		this.emitConfirmedAgentPanesIfChanged();
		this.ensureEagerTailer(token, session);
		this.pushToSubscribers(token);
	}

	/** status収束のため、セッション確定済みの生存ペインはモバイル購読が無くてもtailする。 */
	private ensureEagerTailer(token: string, session: IPaneSessionInfo): void {
		if (this.terminalIdForToken(token) !== undefined) {
			this.ensureTailer(token, session);
		}
	}

	/** 購読者がいれば、そのペインの現行セッションでattach相当のスナップショットを送る。 */
	private pushToSubscribers(token: string): void {
		const subscribers = [...(this.subscribers.get(token)?.keys() ?? [])];
		const terminalId = this.terminalIdForToken(token);
		if (terminalId !== undefined) {
			for (const subscriber of subscribers) {
				this.handleAttach(subscriber, { id: terminalId, token }).catch(err => this.logService.warn('[paradisAgentChat] push after session discovery failed', err));
			}
		}
	}

	private async onHookEventChecked(event: IParadisAgentHookEvent, transcriptPath: string, pathAlreadyChecked: boolean): Promise<void> {
		if (!pathAlreadyChecked && !(await isAllowedTranscriptPath(transcriptPath))) {
			this.logService.warn(`[paradisAgentChat] rejected transcript path outside allowed roots: ${transcriptPath}`);
			return;
		}
		const isTurnEnd = paradisIsTurnEndHookEvent(event.event);
		if (!this.isLiveToken(event.token)) {
			// 終了はペイン同期を待つと表示が固着するため、保留と併せて即時にも反映しておく。
			if (isTurnEnd) {
				this.completeTurnFromHook(event);
			}
			const pending = this.pendingHooks.get(event.token) ?? [];
			pending.push({ event, transcriptPath, receivedAt: Date.now() });
			if (pending.length > PENDING_HOOK_LIMIT) {
				pending.splice(0, pending.length - PENDING_HOOK_LIMIT);
			}
			this.pendingHooks.set(event.token, pending);
			const previousTimer = this.pendingHookTimers.get(event.token);
			if (previousTimer !== undefined) {
				clearTimeout(previousTimer);
			}
			const timer = setTimeout(() => {
				this.pendingHooks.delete(event.token);
				this.pendingHookTimers.delete(event.token);
			}, PENDING_HOOK_TTL_MS);
			this.pendingHookTimers.set(event.token, timer);
			return;
		}
		// nested SubAgent内で発火したhookのtranscript_pathは子自身を指す。これをpaneの
		// main sessionとしてclaimすると親会話が子会話へ置換されるため、既知rootまたは
		// 現行規約から復元したrootへ正規化する。子pathは親子相関にだけ使う。
		// Claudeのsidechain（pathで判別可能）に加え、Codexのsubagent thread（親と同じ
		// rollout命名・同じcwdのためsession_metaを読まないと判別できない）も対象にする。
		const claudeNestedAgentId = paradisClaudeAgentIdFromTranscriptPath(transcriptPath);
		// 既知の親からのhookは素性が確定しているので、rolloutを読み直さない（生成直後の
		// 未書き込みウィンドウに晒されるのは、本当に未知のpathだけになる）。
		const knownPaneTranscriptPath = this.paneSessions.get(event.token)?.transcriptPath;
		const codexOrigin = claudeNestedAgentId !== undefined || knownPaneTranscriptPath === transcriptPath
			? undefined
			: await this.codexRolloutOrigin(transcriptPath);
		const resolved = paradisResolveHookSessionTranscript({
			hookTranscriptPath: transcriptPath,
			paneTranscriptPath: this.paneSessions.get(event.token)?.transcriptPath,
			claudeNestedAgentId,
			codexOrigin,
		});
		if (resolved.kind === 'drop') {
			// 親未確定のペインへ届いた Codex subagent thread のhook。ここで確定させると
			// 子の会話がペインの会話になるため捨てる（親はcwd/state DB探索が確定させる）。
			// このとき子の質問カード・承認カードのライブ注入も落ちる。親が未確定のままでは
			// 注入先の tailer が子rolloutのものになってしまい、それがこのバグ自体だから。
			this.logService.trace(`[paradisAgentChat] dropped nested codex subagent hook for pane without a session: ${event.event}`);
			return;
		}
		const { transcriptPath: sessionTranscriptPath, nested } = resolved;
		// 発信元のプロセスを確かめられなかった hook（pid が無い等）は、daemon の配下の会話（`/fork` の分岐先）の
		// ものかもしれない。所有者が決まる前に分岐先の hook が先に届くと、分岐先がこのペインの会話になってしまう。
		// Claude の transcript を初めてこのペインの会話にするときだけ、中身の sessionKind でも確かめる。
		// SessionStart の source: resume はペインの持ち主が会話を開き直した（分岐先を `--resume` し直したときは、
		// まだ末尾の行も bg のまま）ので確かめない。捨てた hook は控えに残さない（次の hook でもう一度確かめる。
		// 分岐先は照合の候補から sessionKind で外れるので、控えが無くても照合には採られない）。
		if (event.ownerUnverified === true && event.remoteHostId === undefined && nested === undefined
			&& !(event.event === 'SessionStart' && str(event.payload?.source) === 'resume')
			&& agentKindForPath(sessionTranscriptPath) === 'claude'
			&& this.paneSessions.get(event.token)?.transcriptPath !== sessionTranscriptPath
			&& !this.hookTranscriptSightings.isRootFor(sessionTranscriptPath, event.token)
			&& await paradisClaudeTranscriptIsBackground(sessionTranscriptPath)) {
			this.logService.trace(`[paradisAgentChat] dropped an unverified hook whose transcript is a daemon-hosted Claude session: ${event.event}`);
			return;
		}
		if (event.remoteHostId === undefined) {
			const seenAt = Date.now();
			this.hookTranscriptSightings.note(sessionTranscriptPath, event.token, 'root', seenAt);
			if (transcriptPath !== sessionTranscriptPath) {
				this.hookTranscriptSightings.note(transcriptPath, event.token, 'nested', seenAt);
			}
		}
		this.pendingHooks.delete(event.token);
		const pendingTimer = this.pendingHookTimers.get(event.token);
		if (pendingTimer !== undefined) {
			clearTimeout(pendingTimer);
			this.pendingHookTimers.delete(event.token);
		}
		const submittedPrompt = str(event.payload?.prompt)?.trimStart();
		const isLocalSettingCommand = event.event === 'UserPromptSubmit' && submittedPrompt !== undefined && /^\/(?:model|effort)\s+\S/.test(submittedPrompt);
		// バックグラウンドの Bash・Monitor・サブエージェントの完了通知も UserPromptSubmit として届く
		// （Claude Code 2.1.287 で実測）。ユーザーの新しいターンではないので、前ターンの片付けには使わない。
		const isHarnessNotification = event.event === 'UserPromptSubmit' && submittedPrompt?.startsWith('<task-notification>') === true;
		if (!isLocalSettingCommand && !isTurnEnd) {
			this.updateLiveFromHook(event);
		}
		this.cancelCliDiscovery(event.token);
		// shell integrationが対話型CLIの実行中を追跡している場合、TUI内 /resume の
		// fallback監視は維持する。強いhook証拠の時刻より前へ戻らないようwatermarkだけ進める。
		if (this.cliReconciliationTimers.has(event.token)) {
			this.cliReconciliationWatermarks.set(event.token, Math.max(this.cliReconciliationWatermarks.get(event.token) ?? 0, event.at + 1));
		} else {
			this.cliDiscoveryGenerations.set(event.token, (this.cliDiscoveryGenerations.get(event.token) ?? 0) + 1);
		}
		const previousOwner = this.transcriptClaims.get(sessionTranscriptPath);
		if (previousOwner !== undefined && previousOwner !== event.token) {
			// ペイン環境を伴うhookはcwd探索より強い証拠なので、探索由来の誤claimを置き換える。
			this.paneSessions.delete(previousOwner);
			this.disposeTailer(previousOwner);
			this.liveStates.delete(previousOwner);
			this.liveRevisions.delete(previousOwner);
			this.liveToolIds.delete(previousOwner);
			this.liveMessageBuffers.delete(previousOwner);
			this.lastTurnEndedAt.delete(previousOwner);
			this.codexMessageBuffers.delete(previousOwner);
			this.codexActiveItems.delete(previousOwner);
			this.activityTrackers.delete(previousOwner);
			this.advisorLiveIds.delete(previousOwner);
			this.clearClaudeSubagentTranscripts(previousOwner);
			this.activeTurnTokens.delete(previousOwner);
			this.cancelCliDiscovery(previousOwner);
			this.cliDiscoveryGenerations.set(previousOwner, (this.cliDiscoveryGenerations.get(previousOwner) ?? 0) + 1);
			// 奪われた側を見ているモバイルへ知らせ直す（会話が無くなったので 'none' が届く）。知らせないと、
			// tailer が消えたまま前の会話の表示が残り、以後の更新も届かない。
			this.pushToSubscribers(previousOwner);
		}
		const previous = this.paneSessions.get(event.token);
		const info: IPaneSessionInfo = {
			token: event.token,
			agent: agentKindForPath(sessionTranscriptPath),
			transcriptPath: sessionTranscriptPath,
			// nestedなhookのsession_idを、親のsessionId（Codexのroot thread ID等、SubAgent探索や
			// daemon照合の基準）へ書き込ませない。Codexの子threadのsession_idは「子自身の」IDなので
			// 親が未知でも採らない。Claudeのsidechainは親のsession_idを持つのでfallbackしてよい。
			sessionId: nested === 'codex' ? previous?.sessionId
				: nested === 'claude' ? previous?.sessionId ?? event.sessionId
					: event.sessionId,
		};
		if (previous !== undefined && previous.transcriptPath !== sessionTranscriptPath
			&& this.transcriptClaims.get(previous.transcriptPath) === event.token) {
			this.transcriptClaims.delete(previous.transcriptPath);
		}
		this.paneSessions.set(event.token, info);
		this.retiredSessions.delete(event.token);
		if (previous?.transcriptPath !== info.transcriptPath) {
			this.cliCodexForkRequests.delete(event.token);
		}
		this.persistSessions();
		this.transcriptClaims.set(sessionTranscriptPath, event.token);
		this.emitConfirmedAgentPanesIfChanged();

		// エージェント起動などでこのペインのセッションが初めて判明した
		// → 「セッションなし」表示のまま待っている購読者にスナップショットを送る。
		if (previous === undefined) {
			this.ensureEagerTailer(event.token, info);
			this.pushToSubscribers(event.token);
		} else if (previous.transcriptPath !== info.transcriptPath) {
			// 同じペインで別セッションが始まった (claude再起動・/clear・resume等でファイルが変わる)
			// → 稼働中の tailer を張り替え、購読者には新セッションのスナップショットを送り直す。
			this.activityTrackers.delete(event.token);
			this.pendingSubagentCalls.delete(event.token);
			this.advisorLiveIds.delete(event.token);
			this.clearClaudeSubagentTranscripts(event.token);
			this.activeTurnTokens.delete(event.token);
			this.disposeTailer(event.token);
			this.ensureEagerTailer(event.token, info);
			this.pushToSubscribers(event.token);
		}
		const subagentActivityId = event.event === 'SubagentStart' || event.event === 'SubagentStop' ? str(event.payload?.agent_id) : undefined;
		const subagentId = subagentActivityId !== undefined && PARADIS_CLAUDE_AGENT_ID_PATTERN.test(subagentActivityId) ? subagentActivityId : undefined;
		if (event.event === 'SubagentStop') {
			const agentTranscriptPath = str(event.payload?.agent_transcript_path);
			if (subagentId !== undefined && agentTranscriptPath !== undefined && await isAllowedTranscriptPath(agentTranscriptPath)) {
				this.claudeSubagentTranscriptPaths.set(`${event.token}\0${subagentId}`, agentTranscriptPath);
			}
		}
		// メイン待機中 (fork/general-purpose等のsubagentへ調査を委任している間) に review 化して
		// 完了通知音が誤発火する事例があった。実行中のsubagentを backgroundTasks に見せることで、
		// paradisAgentBrowserService.ts の既存安全弁 (paradisCountLiveBackgroundTasks 経由、
		// Stop が来てもbackgroundTasksが残っていればreviewへ畳まずworkingを維持する) を
		// Subagentにも適用させる。モバイルの agentStatusStore も同じ listPaneStatuses を参照するため、
		// モバイル側で subagent 実行中に「レビュー」表示になる不具合もこれで併せて直る。
		if (subagentId !== undefined) {
			const backgroundTaskId = `${HOOK_BACKGROUND_TASK_PREFIX}${subagentId}`;
			if (backgroundTaskId.length <= BACKGROUND_TASK_ID_MAX_LENGTH) {
				// status収束のため、モバイル購読の有無に関わらず反映する (ensureEagerTailer と同じ方針)。
				// tailer不在 (ウィンドウ再読み込み中等でterminalIdが未解決) の間は open/close とも
				// 対称に無言でスキップされ、安全弁が効かない従来挙動に戻るだけで実害はない。
				this.ensureEagerTailer(event.token, info);
				const tailer = this.tailers.get(event.token);
				if (event.event === 'SubagentStart') {
					tailer?.markBackgroundTaskOpen(backgroundTaskId, event.at);
				} else {
					tailer?.markBackgroundTaskClose(backgroundTaskId);
				}
			}
		}
		if (event.event === 'UserPromptSubmit' && !isLocalSettingCommand && !isHarnessNotification) {
			// 新しいユーザーターンが始まった時点で前ターンのsubagentは全て終わっている。
			// SubagentStop の発火漏れ (Claude Code側の既知の制約) やhookの到着順序の逆転
			// (並行POSTのため理論上あり得る) で閉じ損ねた hook: エントリを次ターンまで持ち越さない。
			// これは「次ターン開始まで」の救済であり、同一ターン内で取りこぼした場合は
			// paradisAgentBrowserService.ts の stale sweep (最大15分、
			// PARADIS_AGENT_BACKGROUND_TASK_STALE_MS) が効くまで、review表示が working へ
			// 巻き戻ったまま＝完了通知が遅れて鳴る側の実害が残る。
			this.tailers.get(event.token)?.clearHookBackgroundTasks();
		}
		if (event.event === 'UserPromptSubmit' && !isLocalSettingCommand && this.activityTracker(event.token).beginTurn()) {
			this.pushActivityToSubscribers(event.token);
		}
		if (event.event === 'UserPromptSubmit' && !isLocalSettingCommand) {
			this.activeTurnTokens.add(event.token);
		}
		// Claudeのsidechainだけ、hook payloadへ親Agent IDを補って活動ツリーへ繋ぐ。
		// Codexのsubagent threadはrolloutのタイムラインとstate DBから関係を復元済みなので、
		// ここでClaude形式の親子を注入すると同じSubAgentが二重に現れる。
		const activityPayload = event.payload !== undefined && claudeNestedAgentId !== undefined && event.payload.parent_agent_id === undefined
			? { ...event.payload, parent_agent_id: claudeNestedAgentId }
			: event.payload;
		const tracker = this.activityTracker(event.token);
		// 新しい起動か（一覧にまだいない子の SubagentStart）は、applyClaude が一覧へ足す前に見る
		const freshSubagent = info.agent === 'claude' && event.event === 'SubagentStart' && subagentId !== undefined && !tracker.hasAgent(subagentId) ? subagentId : undefined;
		let activityChanged = activityPayload !== undefined && tracker.applyClaude(event.event, activityPayload, event.at);
		if (info.agent === 'claude') {
			activityChanged = this.linkSubagentStartFromHooks(event, freshSubagent, tracker) || activityChanged;
		}
		if (activityChanged) {
			this.pushActivityToSubscribers(event.token);
		}
		this.schedulePersistedAgentActivityReconcile(event.token);
		if (isTurnEnd) {
			this.completeTurnFromHook(event);
		}

		// AskUserQuestion のライブ検出: Claude Code は質問の tool_use を決着（回答/中断）まで
		// transcript へ flush しないため、PreToolUse hook の tool_input から合成質問カードを
		// 注入する（チャット表示・回答待ちバッジ・プッシュ通知の唯一のライブな供給源）。
		if (event.event === 'PreToolUse' && event.toolName === 'AskUserQuestion' && event.toolInput !== undefined
			&& (this.eagerTailing || this.subscribers.has(event.token) || this.isDesktopChatWatched(event.token))) {
			// デスクトップのチャット表示のためだけに入れる（モバイル向けの注入が動いていない）ときは、
			// モバイルへの質問通知を出さない。モバイルから見た振る舞いを変えないため。
			const mobileWants = this.eagerTailing || this.subscribers.has(event.token);
			this.ensureTailer(event.token, this.paneSessions.get(event.token) ?? info).injectLiveQuestions(event.toolInput, !mobileWants);
		}

		// 承認要求のライブ検出: Codex は承認要求を rollout に書かず、Claude もプロンプト
		// 表示中は transcript に現れないため、PermissionRequest hook の tool_name / tool_input
		// から内容カードを注入する（モバイルの承認バーに「何を承認するのか」を添える）。
		// AskUserQuestion は除外: 上の PreToolUse 経路が選択肢つき質問カードを注入済みで、
		// こちらも注入すると生JSONの承認カードが二重に出る（回答も質問カード側で完結する）。
		// tool_name が取れない PermissionRequest（旧CLI・パース失敗）でも、質問回答待ち中は
		// AskUserQuestion 由来とみなして注入しない（質問カードと承認カードの二重表示防止）。
		const approvalTarget = this.trackToolUse(event);
		if (event.event === 'PermissionRequest' && event.toolName !== 'AskUserQuestion'
			// 質問の回答待ちかは、ペインの状態（デスクトップ専用の質問を数えない）ではなく tailer の実際の有無で見る
			&& !getParadisAgentPaneActivity(event.token).pendingQuestion
			&& !((this.tailers.get(event.token)?.pendingQuestions.size ?? 0) > 0)
			&& (event.toolName !== undefined || event.toolInput !== undefined)
			&& (this.eagerTailing || this.subscribers.has(event.token) || this.isDesktopChatWatched(event.token))) {
			const mobileWants = this.eagerTailing || this.subscribers.has(event.token);
			this.ensureTailer(event.token, this.paneSessions.get(event.token) ?? info).injectApprovalRequest(event.toolName, event.toolInput, approvalTarget.toolUseId, !mobileWants, approvalTarget.waitKey, approvalTarget.sameContentLimit,
				paradisApprovalSuggestionLabels(event.payload?.permission_suggestions), {
				agent: this.approvalAgent(event.token, str(event.payload?.agent_id), str(event.payload?.agent_type)),
				suggestionScope: paradisApprovalSuggestionScope(event.payload?.permission_suggestions),
			});
		}
		const forceApprovalClear = event.event === 'PermissionDenied';
		const matchingApprovalClear = (event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') && event.toolUseId !== undefined;
		if ((forceApprovalClear || matchingApprovalClear) && this.tailers.has(event.token)) {
			this.tailers.get(event.token)?.clearApprovalRequest(event.toolUseId, forceApprovalClear);
		}
		// 未回答のまま残った質問の解除。質問を承認より優先するようになったため、決着し損ねた
		// 合成IDの質問が残ると以後の承認が回答不能になる（clearPendingQuestions 参照）。
		// 本命は AskUserQuestion の PostToolUse: 質問の決着を即時かつ確実に知らせる唯一の信号で、
		// transcript の内容キー突合に依存しない。ターン終了を待つ設計だと、同じターン内で本物の
		// 許可プロンプトが出た場合にそのターンが承認待ちで止まるため Stop が原理的に来ず、
		// 一番効かせたい場面で効かない。ターン終了時の解除は completeTurnFromHook がまとめて行う。
		// PermissionDenied は承認の拒否であってターン終了ではないので質問は残す。
		const questionSettled = (event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') && event.toolName === 'AskUserQuestion';
		if (questionSettled) {
			this.tailers.get(event.token)?.clearPendingQuestions();
			// 決着した interaction の claim も解放する（残すと次の回答が60秒間ロックされる）。
			// 質問の決着では question の claim だけを解く。まとめて解放すると、同じターンで
			// 進行中の承認の claim まで解けて二重注入（'1'+CR がもう一度PTYへ）の窓ができる。
			this.releaseInteractionClaimsFor(event.token, 'question');
		}
	}

	/** transcript の直近ターンの model / effort を返す。 */
	private infoOf(token: string, tailer: TranscriptTailer): IParadisAgentSessionInfo | undefined {
		const model = tailer.model;
		const effort = tailer.effort;
		// ターミナルが閉じた後にスマホから再開するための指紋（W2-29）。セッション ID そのものは送らない。
		const sessionId = this.paneSessions.get(token)?.sessionId;
		const resumeKey = sessionId !== undefined && PARADIS_RESUME_SESSION_ID_PATTERN.test(sessionId) ? paradisAgentSessionKey(tailer.agent, sessionId) : undefined;
		// 走っている Codex へ設定を渡す口が無いので、Codex のモデルはモバイルから変えられない。モデルが
		// まだ分からないうちから伝えて、選択の画面を開かせない
		const modelControl = tailer.agent === 'codex' ? 'none' : undefined;
		if (model === undefined && effort === undefined && resumeKey === undefined && modelControl === undefined) {
			return undefined;
		}
		return {
			...(model !== undefined ? { model } : {}),
			...(effort !== undefined ? { effort } : {}),
			...(resumeKey !== undefined ? { resumeKey } : {}),
			...(modelControl !== undefined ? { modelControl } : {}),
		};
	}

	private pushInfoToSubscribers(token: string): void {
		this.scheduleDesktopChatCheck();
		const terminalId = this.terminalIdForToken(token);
		const tailer = this.tailers.get(token);
		const info = tailer !== undefined ? this.infoOf(token, tailer) : undefined;
		if (terminalId !== undefined && tailer !== undefined && info !== undefined) {
			this.sendToSubscribers(token, { t: 'delta', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages: [], info });
		}
	}

	private ensureTailer(token: string, session: IPaneSessionInfo): TranscriptTailer {
		const existing = this.tailers.get(token);
		if (existing !== undefined && existing.transcriptPath === session.transcriptPath) {
			return existing;
		}
		if (existing !== undefined) {
			this.disposeTailer(token);
		}
		const pushActivity = () => {
			this.scheduleDesktopInsightCheck();
			setParadisAgentPaneActivity(token, {
				backgroundTasks: new Map(tailer.backgroundTasks),
				pendingQuestion: tailer.hasPendingQuestionForStatus(),
				// currentInteraction は質問を優先して承認を隠すため、ここは「承認が存在するか」の事実を渡す
				pendingApproval: tailer.hasPendingApproval(),
			});
		};
		const remote = this.isRemoteAgentPane(token) || paradisIsRemoteAgentTranscriptMirrorPath(session.transcriptPath);
		const tailer = new TranscriptTailer(session.transcriptPath, session.agent, {
			onDelta: (messages, options) => {
				this.scheduleDesktopInsightCheck();
				const live = this.liveStates.get(token);
				if (live?.phase === 'message' && live.final && messages.some(message => message.role === 'assistant' && message.kind === 'text')) {
					// MessageDisplayの最終バッチはtranscript本文が届くまで表示し、確定本文との二重表示を避ける。
					this.clearLiveState(token);
				}
				const terminalId = this.terminalIdForToken(token);
				if (terminalId !== undefined) {
					this.sendToSubscribers(token, { t: 'delta', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages, interaction: tailer.currentInteraction() });
				}
				// 質問のカードが増えた（mod の待ちが先に来ていれば、ここで初めて突き合わせられる）
				if (messages.some(message => message.kind === 'question')) {
					this.refreshModQuestions(token);
				}
				// 質問の出現は購読の有無に関わらず通知へ流す（アプリを開いていないモバイルへの
				// プッシュ供給源。onDelta はライブ追記でのみ呼ばれるため過去分の再通知はない）。
				for (const message of options?.quiet === true ? [] : messages) {
					if (message.kind !== 'question') {
						continue;
					}
					if (terminalId === undefined) {
						// ペインが引けないと通知そのものが始まらない。ここを黙って飛ばすと
						// 「出さなかった」記録が1件も残らず、届かない理由の内訳から欠ける。
						this.recordQuestionNotifyShape(token, message, 'no-terminal');
						continue;
					}
					this.notifyQuestionForCurrentOwner(token, tailer, terminalId, message);
				}
				if (messages.some(message => message.tool === 'Agent' || message.tool === 'Task' || message.text.startsWith('バックグラウンドタスク'))) {
					this.schedulePersistedAgentActivityReconcile(token);
				}
			},
			onEpochReset: () => {
				this.scheduleDesktopChatCheck();
				const terminalId = this.terminalIdForToken(token);
				if (terminalId !== undefined) {
					const messages = tailer.messages.slice(-SNAPSHOT_SEND_LIMIT);
					const info = this.infoOf(token, tailer);
					this.sendToSubscribers(token, { t: 'snapshot', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages, ...(info !== undefined ? { info } : {}), live: this.liveStates.get(token) ?? null, liveRevision: this.liveRevisions.get(token) ?? 0, activity: this.activityTrackers.get(token)?.snapshot() ?? null, interaction: tailer.currentInteraction(), capabilities: { agentActions: true, ...(tailer.agent === 'claude' ? { claudeSettings: true } : {}) }, ...this.monitorsField(token, tailer) });
				}
				// 読み直したカードを mod の待ちと突き合わせ直す（変われば delta で answerVia を送り直す）
				this.refreshModQuestions(token);
			},
			// この起動後に transcript が伸びた＝そのペインでエージェントが今も動いている。
			// hook が届かない構成（WSL のディストロの中）と、質問を出したまま止まっていた
			// セッションを、鮮度の推測を持ち込まずに引き継ぎ扱いから解くための唯一の経路。
			onAppended: () => this.rememberAgentEvidence(token),
			// PostToolUse が来ない拒否（ターミナルでの Esc）でも、合成 id の承認の待ち合わせを進める。
			onToolResults: (toolUseIds, rejected) => {
				this.finishToolUses(token, toolUseIds);
				// 承認の解除は tailer のキューで行われるので、その後で生成中の様子を直す。
				void tailer.afterQueue(() => this.settleLiveAfterApprovals(token, rejected));
			},
			// ワークスペース一覧のIssueマーク用。ペインの生死に紐づける判定 (activityGuard) は
			// setParadisAgentPaneIssueUrls 側で行うため、ここでは検出結果をそのまま渡すだけでよい。
			onIssueUrlsUpdated: issueUrls => setParadisAgentPaneIssueUrls(token, issueUrls),
			// バックグラウンドタスク・質問回答待ちの変化を状態レジストリへ反映する
			// （ParadisAgentBrowserService がペイン実行状態 working/question の判定に使う）。
			onActivity: pushActivity,
			// model / effort の変化は空deltaで購読者へ届ける（メッセージ本文とは独立に変わるため）。
			onInfo: () => this.pushInfoToSubscribers(token),
			// Monitor の一覧は本文と独立に変わる（出力の通知・時間の経過）ので、空 delta で丸ごと届ける。
			onMonitors: () => {
				const terminalId = this.terminalIdForToken(token);
				if (terminalId !== undefined) {
					this.sendToSubscribers(token, { t: 'delta', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages: [], ...this.monitorsField(token, tailer) });
				}
			},
			onProgress: progress => this.updateLiveFromProgress(token, progress),
			onAdvisors: messages => this.applyAdvisorMessages(token, messages),
			onCodexActivityTimeline: events => {
				const tracker = this.activityTracker(token);
				let changed = false;
				for (const event of events) {
					if (event.type === 'turnStart') {
						this.activeTurnTokens.add(token);
						fireParadisAgentTurnStarted(token, this.tokenToCwd.get(token));
					} else if (event.type === 'subagent') {
						changed = tracker.applyCodex('item/started', { item: { type: 'subAgentActivity', agentThreadId: event.id, agentPath: event.agentPath, kind: event.kind, ...(event.detail !== undefined ? { prompt: event.detail } : {}), ...(event.via !== undefined ? { interaction: event.via } : {}), ...(event.callId !== undefined ? { callId: event.callId } : {}) } }, event.at) || changed;
						this.enrichCodexActivityRelationship(token, event.id, event.at).catch(err => this.logService.trace('[paradisAgentChat] codex activity relationship lookup failed', String(err)));
					} else if (event.type === 'goal') {
						changed = tracker.applyCodexGoal(event, event.at) || changed;
					} else if (event.type === 'plan') {
						changed = tracker.applyCodexPlan(event.steps, event.at) || changed;
					} else {
						this.activeTurnTokens.delete(token);
						// 承認が残ったままの中断（承認の拒否）は完了ではない（直後の onTurnEnded がペインを idle へ移す）。
						// ここで完了の合図を出すと、答えた時点で作業中へ戻っていたペインが確認待ち（review）へ移り、
						// 完了の通知が鳴る。
						if (!(event.reason === 'interrupted' && tailer.stoppedOnApproval())) {
							fireParadisAgentTurnEnded(token);
						}
						changed = tracker.endTurn(event.at, event.reason) || changed;
					}
				}
				if (changed) { this.pushActivityToSubscribers(token); }
				this.schedulePersistedAgentActivityReconcile(token);
				this.scheduleDesktopChatCheck();
			},
			// ターン終了（Codex の task_complete / error / turn_aborted）: 考え中表示を解除し、
			// ペイン実行状態（working）側の解除は hook バス経由で ParadisAgentBrowserService に任せる。
			onTurnEnded: (reason, errorCode) => {
				// 通知の中身（失敗の理由）のために、ペインの状態を動かす前に覚える（状態が変わると完了の通知が出る）。
				this.notifyTurnEnds.delete(token);
				this.notifyTurnEnds.set(token, { reason, ...(errorCode !== undefined ? { errorCode } : {}), at: Date.now() });
				if (this.notifyTurnEnds.size > 500) {
					const oldest = this.notifyTurnEnds.keys().next().value;
					if (oldest !== undefined) {
						this.notifyTurnEnds.delete(oldest);
					}
				}
				this.activeTurnTokens.delete(token);
				this.clearLiveState(token);
				// 承認が残ったままターンが中断された（Codex の承認をカードやターミナルで拒否すると、ターンが
				// 中断されて終わる。カードで答えた承認は「回答済み」で列に残っている）なら、承認を外し、ペインは
				// 完了（review）ではなく状態なし（idle）へ移す（完了の通知を鳴らさない）。
				if (reason === 'interrupted' && tailer.stoppedOnApproval()) {
					tailer.clearApprovalRequest(undefined, true, true);
					fireParadisAgentAwaitingUser(token);
				} else {
					fireParadisAgentTurnEnded(token);
				}
				this.scheduleDesktopChatCheck();
			},
			// 接続先かどうかは、これから読むファイルそのものでも見る。`isRemoteAgentPane` は
			// 「今このペインに載っているセッション」を見るが、ここへは差し替え中の新しい
			// セッションが渡ってくることがあり、その一瞬だけ判定が食い違う
		}, this.logService, remote, remote || session.agent !== 'codex' ? undefined : async threadId => {
			// fork 先の過去の会話は、同じホームの元の rollout から読む（許可した場所の外は読まない）
			const transcriptPath = await discoverCodexTranscriptByThreadId(threadId, this.agentHomesForToken(token) ?? paradisResolveAgentHomes(''));
			return transcriptPath !== undefined && await isAllowedTranscriptPath(transcriptPath) ? transcriptPath : undefined;
		});
		this.tailers.set(token, tailer);
		tailer.ready.then(() => {
			this.scheduleDesktopInsightCheck();
			if (this.tailers.get(token) === tailer) {
				this.schedulePersistedAgentActivityReconcile(token, 0);
				// 初回読み込みのカードは onDelta を通らない。mod が先に待っていた質問を keys のまま残さない
				this.refreshModQuestions(token);
			}
		}).catch(error => this.logService.trace('[paradisAgentChat] initial persisted activity recovery failed', String(error)));
		return tailer;
	}

	/** tailer を破棄し、そのペインのアクティビティを「何もしていない」へ戻す（stale な赤/実行中表示の防止）。 */
	private disposeTailer(token: string): void {
		const recoveryTimer = this.persistedActivityTimers.get(token);
		if (recoveryTimer !== undefined) {
			clearTimeout(recoveryTimer);
			this.persistedActivityTimers.delete(token);
		}
		this.modLive.delete(token);
		const modApprovalTimer = this.modApprovalTimers.get(token);
		if (modApprovalTimer !== undefined) {
			clearTimeout(modApprovalTimer);
			this.modApprovalTimers.delete(token);
		}
		const tailer = this.tailers.get(token);
		if (tailer !== undefined) {
			this.scheduleDesktopInsightCheck();
			tailer.dispose();
			this.tailers.delete(token);
			// 読むのをやめた会話の Codex の計画・ゴールを「実行中」のまま残さない
			if (this.activityTrackers.get(token)?.settleCodexPlanAndGoal(Date.now()) === true) { this.pushActivityToSubscribers(token); }
			setParadisAgentPaneActivity(token, { backgroundTasks: new Map(), pendingQuestion: false, pendingApproval: false });
			// tailer 破棄時点で検出済みIssueもリセットする。/clear や resume でこのトークンに
			// 新しい tailer が張られたとき、新会話が1件もIssueへ触れなければ onIssueUrlsUpdated が
			// 一度も呼ばれず、ここでクリアしないと前の会話のIssue URLが (Issueマークがアイドル中も
			// 消えなくなった今は) ペイン終了まで恒久的に残ってしまう。
			setParadisAgentPaneIssueUrls(token, new Set());
		}
	}

	private stopTailerIfUnsubscribed(token: string): void {
		// status用tailはセッション確定済みの生存ペインに常駐させる。
		if (this.paneSessions.has(token) && this.isLiveToken(token)) {
			return;
		}
		if (!this.subscribers.has(token)) {
			this.disposeTailer(token);
		}
	}

	/**
	 * 質問1件ごとに、通知が「どこまで進んだか」を記録する。
	 *
	 * **`outcome` を必ず渡すこと。** 以前はこの記録を {@link notifyQuestionForCurrentOwner} の
	 * 直前で無条件に呼んでいたが、その先には owner 不在・authorize 失敗・owner 交代という
	 * 打ち切り経路があるため、**測れていたのは「質問メッセージが浮上した回数」だけ**だった。
	 *
	 * `dispatched` が意味するのは「配送層へ渡した」ところまで。その先の抑制ポリシー
	 * （PCにフォーカスがある間は鳴らさない）・リレー・APNs のペイロード上限は**まだ測れていない**
	 * ので、「通知が端末に出た」と読まないこと。
	 *
	 * 重なりの数え方も2種類ある。どちらか片方では実態が見えない:
	 * - `safe_group_seq` … 同じ `questionGroup` の中で何本目か。複数問の AskUserQuestion で
	 *   問の数だけ通知が出ていることを示す
	 * - `safe_content_seq` … **同じ内容の質問が何回通知されたか**。live(hook由来) と
	 *   transcript(記録由来) は `questionGroup` の名前空間が別（`liveg:` と実 toolUseId）なので、
	 *   グループ単位では二重通知が別物として数えられ、カウントが1に戻ってしまう。
	 *   内容キーで数えて初めて「同じ質問が40〜60秒あけて2回出ている」が見える
	 *
	 * 送るのは件数と経路と結果だけ。**内容キーはカウンタの引き当てにしか使わず、
	 * 質問文・選択肢は載せない。**
	 */
	private recordQuestionNotifyShape(token: string, message: IParadisAgentChatMessage, outcome: ParadisQuestionNotifyOutcome): void {
		const group = message.questionGroup ?? message.toolUseId;
		if (group !== undefined) {
			// 同じ質問が live と transcript の両経路で浮上するので、**最初の1回だけ**を起点にする。
			// `group` は回答時の `interactionId` と同じ値（parseAskUserQuestions が付ける）。
			const seenKey = `${token}\0${group}`;
			if (!this.questionFirstSeenAt.has(seenKey)) {
				this.questionFirstSeenAt.set(seenKey, Date.now());
				this.evictOldest(this.questionFirstSeenAt, QUESTION_NOTIFY_COUNT_LIMIT);
			}
		}
		// 群が引けない質問はカウンタを引き当てられないが、**記録自体は必ず残す**。ここで
		// 打ち切ると、抑制で鳴らさなかったぶんが計測から丸ごと消え、「減った」のか
		// 「壊れて出なくなった」のかを区別できなくなる（この仕組みで唯一の検証手段）。
		const groupSeq = group === undefined ? -1 : this.bumpQuestionNotifyCount(`g\0${token}\0${group}`);
		const contentSeq = this.bumpQuestionNotifyCount(`c\0${token}\0${liveQuestionContentKey(message)}`);
		runInParadisSpan('agentQuestion', 'notify', {
			// 2以上なら同じ質問グループで通知が重なっている。
			safe_group_seq: groupSeq,
			// 2以上なら同じ内容の質問が経路をまたいで重複通知されている。
			safe_content_seq: contentSeq,
			safe_index: message.questionIndex ?? -1,
			safe_total: message.questionCount ?? -1,
			// live = hook 由来（TUIに出た時点）、transcript = 書き出された記録由来。
			safe_source: message.toolUseId?.startsWith('live:') === true ? 'live' : 'transcript',
			safe_multi_select: message.multiSelect === true,
			safe_option_count: message.options?.length ?? 0,
			// dispatched 以外は「通知を出そうとしてやめた」。届かない理由の内訳になる。
			safe_outcome: outcome,
		}, () => { });
	}

	/** 通知回数のカウンタを1つ進める。上限を超えたら「最後に触ってから最も経った」ものを捨てる。 */
	private bumpQuestionNotifyCount(key: string): number {
		const seq = (this.questionNotifyCounts.get(key) ?? 0) + 1;
		// `Map.set` は既存キーの挿入順を変えない。消し直してから入れることで、反復順が
		// 最終利用順になる（そうしないと、よく使われているキーほど先に追い出される）。
		this.questionNotifyCounts.delete(key);
		this.questionNotifyCounts.set(key, seq);
		this.evictOldest(this.questionNotifyCounts, QUESTION_NOTIFY_COUNT_LIMIT);
		return seq;
	}

	/** 計測用の台帳が無限に伸びないよう、上限を超えたぶんを古い順に捨てる。 */
	private evictOldest(ledger: Map<string, number>, limit: number): void {
		while (ledger.size > limit) {
			const stalest = ledger.keys().next();
			if (stalest.done) {
				return;
			}
			ledger.delete(stalest.value);
		}
	}

	/** 質問が最初に浮上してからの経過ms。起点を覚えていなければ `undefined`。 */
	private msSinceQuestionFirstSeen(token: string | undefined, interactionId: string): number | undefined {
		if (token === undefined) {
			return undefined;
		}
		const seenAt = this.questionFirstSeenAt.get(`${token}\0${interactionId}`);
		return seenAt === undefined ? undefined : Date.now() - seenAt;
	}

	private notifyQuestionForCurrentOwner(token: string, tailer: TranscriptTailer, terminalId: number, message: IParadisAgentChatMessage): void {
		const owner = this.ownerForPane(terminalId, token);
		if (owner === undefined) {
			this.recordQuestionNotifyShape(token, message, 'no-owner');
			return;
		}
		// 同じ質問グループの2問目以降と、live/transcript の両経路で浮上した同一内容は鳴らさない。
		const suppressed = this.suppressedQuestionNotify(token, message);
		if (suppressed !== undefined) {
			// 抑制したぶんも必ず記録する。ここを黙って return にすると、通知が減ったのか
			// 壊れて出なくなったのかを後から区別できなくなる。
			this.recordQuestionNotifyShape(token, message, suppressed);
			return;
		}
		// authorize は非同期なので、同じ群の2問目が待ち行列で追い抜かないよう先に予約する。
		// 実際に鳴らせなかった経路では**必ず**取り消すこと（取り消し漏れ＝その質問は二度と鳴らない）。
		const reservation = this.reserveQuestionNotify(token, message);
		void this.authorizeOwner(owner).then(authorized => {
			if (!authorized) {
				reservation.release();
				this.recordQuestionNotifyShape(token, message, 'unauthorized');
				return;
			}
			const current = this.ownerForPane(terminalId, token);
			if (current === undefined || !this.samePaneOwner(current, owner) || this.tailers.get(token) !== tailer) {
				reservation.release();
				this.recordQuestionNotifyShape(token, message, 'owner-changed');
				return;
			}
			try {
				const ws = this.tokenToWorkspace.get(token);
				this.onQuestion({ terminalId, agent: tailer.agent, text: message.text, ...(ws !== undefined ? { ws } : {}), agentToken: token, owner });
				this.recordQuestionNotifyShape(token, message, 'dispatched');
			} catch (error) {
				// `.then(onFulfilled, onRejected)` は成功枝で投げた例外を第2引数で拾わない。
				// ここで捕まえないと、予約が残ったまま計測も残らず、その質問はTTLのあいだ
				// 一度も鳴らない（しかも理由が記録に出ない）。
				reservation.release();
				this.recordQuestionNotifyShape(token, message, 'authorize-failed');
				this.logService.warn('[paradisAgentChat] question notify dispatch failed', error);
			}
		}, error => {
			reservation.release();
			this.recordQuestionNotifyShape(token, message, 'authorize-failed');
			this.logService.warn('[paradisAgentChat] question owner validation failed', error);
		});
	}

	/** 抑制の突き合わせに使う2種類のキー。群が引けない質問は内容キーだけで判定する。 */
	private questionNotifyKeys(token: string, message: IParadisAgentChatMessage): { readonly group: string | undefined; readonly content: string } {
		const group = message.questionGroup ?? message.toolUseId;
		return {
			group: group === undefined ? undefined : `g\0${token}\0${group}`,
			content: `c\0${token}\0${liveQuestionContentKey(message)}`,
		};
	}

	/**
	 * 直近に同じ質問を鳴らしていれば、その理由を返す。
	 *
	 * 内容キーは `liveQuestionContentKey`（質問文＋選択肢ラベル）の**完全一致**で見る。
	 * `paradisHasPendingDuplicateQuestion` が持つ「片側の選択肢が空なら質問文だけで同一とみなす」
	 * 第2段は入れていないので、hookが選択肢を落とした場合（Windows の PowerShell など）の
	 * 経路またぎはここでは止まらない。そこは取り込み時点の照合（`takeLiveQuestionMatch`）が
	 * 受け持っている領域で、二重に緩い規則を持ち込むと同文の別質問まで巻き込む。
	 */
	private suppressedQuestionNotify(token: string, message: IParadisAgentChatMessage): ParadisQuestionNotifyOutcome | undefined {
		const keys = this.questionNotifyKeys(token, message);
		const now = Date.now();
		if (keys.group !== undefined && this.recentlyNotifiedQuestion(keys.group, now, QUESTION_NOTIFY_GROUP_SUPPRESS_TTL_MS)) {
			// 群で止めたぶんも内容キーを覚えておく。ここを飛ばすと、同じ内容が別経路
			// （群キーの名前空間が live と transcript で違う）で浮上したときに素通りし、
			// 経路またぎの重複が半分残る＝この抑制の狙いの半分が効かなくなる。
			this.questionNotifiedAt.set(keys.content, now);
			this.evictOldest(this.questionNotifiedAt, QUESTION_NOTIFY_COUNT_LIMIT);
			return 'suppressed-group';
		}
		return this.recentlyNotifiedQuestion(keys.content, now, QUESTION_NOTIFY_CONTENT_SUPPRESS_TTL_MS) ? 'suppressed-content' : undefined;
	}

	/** 期限切れの記録はその場で捨てる（再提示された質問を鳴らし直せるようにするため）。 */
	private recentlyNotifiedQuestion(key: string, now: number, ttlMs: number): boolean {
		const notifiedAt = this.questionNotifiedAt.get(key);
		if (notifiedAt === undefined) {
			return false;
		}
		if (now - notifiedAt <= ttlMs) {
			return true;
		}
		this.questionNotifiedAt.delete(key);
		return false;
	}

	private reserveQuestionNotify(token: string, message: IParadisAgentChatMessage): { release(): void } {
		const keys = this.questionNotifyKeys(token, message);
		const now = Date.now();
		const reserved = keys.group === undefined ? [keys.content] : [keys.group, keys.content];
		for (const key of reserved) {
			this.questionNotifiedAt.set(key, now);
		}
		this.evictOldest(this.questionNotifiedAt, QUESTION_NOTIFY_COUNT_LIMIT);
		return {
			release: () => {
				for (const key of reserved) {
					this.questionNotifiedAt.delete(key);
				}
			},
		};
	}

	private terminalIdForToken(token: string): number | undefined {
		return this.paneRegistry.ownerOf(token)?.terminalId;
	}

	private resolveInboundToken(terminalId: number, paneToken: string | undefined): string | undefined {
		if (paneToken === undefined) {
			return undefined;
		}
		return this.isLiveToken(paneToken) && this.terminalIdForToken(paneToken) === terminalId ? paneToken : undefined;
	}

	/**
	 * snapshot / delta に載せる Monitor の一覧（Claude のセッションだけ。空でも送り、モバイルの一覧を揃える）。
	 * 時刻は PC の時計なので、送信時刻 `monitorsAt` を添える（モバイルが手元の時計へ直す）。
	 * ペインでエージェントが動いていない（SessionEnd の後・ペインが生きていない）ときは、動いているものを
	 * 「停止（推定）」にして送る。推定は tailer のメモリにしか無く、作り直すと再生で running に戻るため、
	 * 送るたびにここで判定する。
	 */
	private monitorsField(token: string, tailer: TranscriptTailer): { monitors?: readonly IParadisAgentMonitor[]; monitorsAt?: number } & IParadisAgentShellsField {
		if (tailer.agent !== 'claude') {
			return {};
		}
		const monitors = tailer.monitors();
		const shells = tailer.shells();
		const paneStopped = this.desktopExitedTokens.has(token) || !this.isLiveToken(token);
		const now = Date.now();
		const shellsAccess = this.shellsAccessFor(token, tailer);
		this.shellsAccessSent.set(token, JSON.stringify(shellsAccess));
		return {
			monitors: paneStopped ? paradisMonitorsForStoppedPane(monitors, this.sessionEndedAt.get(token)) : monitors, monitorsAt: now,
			// バックグラウンドのシェル（agent.shells.v1）も同じ決まりで送る。出力と停止の可否を添える
			shells: paneStopped ? paradisShellsForStoppedPane(shells, this.sessionEndedAt.get(token)) : shells, shellsAt: now, shellsAccess,
		};
	}

	/** {@link monitorsField} の判定をテストから確かめるため。 */
	monitorsForTest(token: string): ({ monitors?: readonly IParadisAgentMonitor[]; monitorsAt?: number } & IParadisAgentShellsField) | undefined {
		const tailer = this.tailers.get(token);
		return tailer !== undefined ? this.monitorsField(token, tailer) : undefined;
	}

	private isLiveToken(token: string): boolean {
		return this.allLiveTokens().has(token);
	}

	private allLiveTokens(): Set<string> {
		const tokens = new Set<string>();
		for (const entry of this.paneRegistry.allEntries()) {
			tokens.add(entry.token);
		}
		return tokens;
	}

	private transcriptClaimedByOther(transcriptPath: string, token: string): boolean {
		const owner = this.transcriptClaims.get(transcriptPath);
		return owner !== undefined && owner !== token;
	}

	private confirmedAgentPaneTokens(): readonly string[] {
		const restoredWithoutEvidence = new Set<string>();
		for (const [token, session] of this.paneSessions) {
			if (session.restoredFromDisk === true) {
				restoredWithoutEvidence.add(token);
			}
		}
		return paradisConfirmedAgentPaneTokens(this.paneSessions.keys(), this.allLiveTokens(), restoredWithoutEvidence);
	}

	/**
	 * 「そのペインでエージェントが動いている」と分かったので、引き継ぎ扱いを解く。
	 *
	 * 別の集合で覚えるのではなくセッション自身を書き換えるのは、ウィンドウのリロードや
	 * ウィンドウ間の移動で token が一瞬 live でなくなる隙間が必ずあるため。並行に持つと
	 * その隙間で証拠だけが消え、セッションは引き継ぎ扱いのまま復活して二度と出なくなる。
	 */
	private rememberAgentEvidence(token: string): void {
		const session = this.paneSessions.get(token);
		if (session !== undefined && session.restoredFromDisk === true) {
			this.paneSessions.set(token, { ...session, restoredFromDisk: false });
			this.emitConfirmedAgentPanesIfChanged();
		}
		const retired = this.retiredSessions.get(token);
		if (retired !== undefined && retired.session.restoredFromDisk === true) {
			this.retiredSessions.set(token, { ...retired, session: { ...retired.session, restoredFromDisk: false } });
		}
	}

	/**
	 * 確定しているペインのうち、hook が原理的に届かない場所で動いているぶん。
	 *
	 * いまのところ「WSL のディストロの中」がそれにあたる。ここでは作業フォルダの一致だけを
	 * 根拠にセッションを結び付けているので、hook で正確に分かる環境にまでこの弱い根拠を
	 * 広げると、外部のターミナルで動かしているエージェントを取り違えて並べてしまう。
	 */
	private agentPaneTokensOutsideHookReach(confirmed: readonly string[]): readonly string[] {
		return confirmed.filter(token => {
			const cwd = this.tokenToCwd.get(token);
			return cwd !== undefined && paradisResolveAgentHomes(cwd).wsl !== undefined;
		});
	}

	private emitConfirmedAgentPanesIfChanged(): void {
		const next = this.confirmedAgentPaneTokens();
		const nextOutsideHookReach = this.agentPaneTokensOutsideHookReach(next);
		if (next.length === this.lastConfirmedAgentPaneTokens.length
			&& next.every((token, index) => token === this.lastConfirmedAgentPaneTokens[index])
			&& nextOutsideHookReach.length === this.lastAgentPaneTokensOutsideHookReach.length
			&& nextOutsideHookReach.every((token, index) => token === this.lastAgentPaneTokensOutsideHookReach[index])) {
			return;
		}
		this.lastConfirmedAgentPaneTokens = next;
		this.lastAgentPaneTokensOutsideHookReach = nextOutsideHookReach;
		this._onDidChangeConfirmedAgentPanes.fire({ tokens: next, tokensOutsideHookReach: nextOutsideHookReach });
	}


	private addSubscriber(token: string, mobileId: string, owner: IParadisMobilePaneOwner, liveEncoding: string | undefined): void {
		let subscribers = this.subscribers.get(token);
		if (subscribers === undefined) {
			subscribers = new Map<string, IAgentSubscriber>();
			this.subscribers.set(token, subscribers);
		}
		subscribers.set(mobileId, {
			owner,
			liveEncoding: liveEncoding === PARADIS_AGENT_LIVE_APPEND_ENCODING ? PARADIS_AGENT_LIVE_APPEND_ENCODING : undefined,
		});
		// デスクトップのためだけに入れていた質問・承認は、モバイルが見始めたらふつうの扱いに戻す。
		this.tailers.get(token)?.promoteDesktopOnly();
	}

	private removeSubscriber(token: string, mobileId: string): boolean {
		const subscribers = this.subscribers.get(token);
		if (subscribers === undefined || !subscribers.delete(mobileId)) {
			return false;
		}
		if (subscribers.size === 0) {
			this.subscribers.delete(token);
		}
		return true;
	}

	private hasSubscriber(token: string, mobileId: string): boolean {
		const subscribedOwner = this.subscribers.get(token)?.get(mobileId)?.owner;
		const currentOwner = this.paneRegistry.ownerOf(token);
		return subscribedOwner !== undefined && currentOwner !== undefined && this.samePaneOwner(subscribedOwner, currentOwner);
	}

	private sendToSubscribers(token: string, msg: AgentOutbound): void {
		for (const [mobileId, subscriber] of this.subscribers.get(token) ?? []) {
			this.sendTo(mobileId, msg, token, subscriber.owner);
		}
	}

	private sendTo(mobileId: string, msg: AgentOutbound, token?: string, expectedOwner?: IParadisMobilePaneOwner): void {
		void this.sendToAuthorized(mobileId, msg, token, expectedOwner);
	}

	private async sendToAuthorized(mobileId: string, msg: AgentOutbound, token?: string, expectedOwner?: IParadisMobilePaneOwner): Promise<boolean> {
		const payload = encoder.encode(JSON.stringify({ ...msg, ...(token !== undefined ? { token } : {}) }));
		if (token === undefined) {
			this.send(mobileId, payload);
			return true;
		}
		const owner = expectedOwner ?? this.subscribers.get(token)?.get(mobileId)?.owner ?? this.paneRegistry.ownerOf(token);
		if (owner === undefined) {
			return false;
		}
		try {
			const authorized = await this.authorizeOwner(owner);
			const current = this.paneRegistry.ownerOf(token);
			const subscribed = this.subscribers.get(token)?.get(mobileId)?.owner;
			if (authorized && current !== undefined && subscribed !== undefined
				&& this.samePaneOwner(current, owner) && this.samePaneOwner(subscribed, owner)) {
				this.send(mobileId, payload);
				return true;
			}
		} catch (error) {
			this.logService.warn('[paradisAgentChat] outbound owner validation failed', error);
		}
		return false;
	}
}
