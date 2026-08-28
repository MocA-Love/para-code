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
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, resolve, sep } from '../../../../base/common/path.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { BACKGROUND_TASK_ID_MAX_LENGTH, BACKGROUND_TASK_MAX_ENTRIES, fireParadisAgentTurnEnded, fireParadisAgentTurnStarted, getParadisAgentPaneActivity, IParadisAgentHookEvent, IParadisAgentNestedHookEvent, onParadisAgentHookEvent, onParadisAgentNestedHookEvent, setParadisAgentPaneActivity, setParadisAgentPaneIssueUrls } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { IParadisAgentHomes, paradisClaudeConfigDir, paradisCodexHome, paradisLocalAgentPath, paradisResolveAgentHomes } from '../../agentBrowser/node/paradisAgentHome.js';
import { paradisExtractIssueUrls } from '../../../common/paradisIssueDetection.js';
import { paradisIsWslAgentHomePath } from '../../../common/paradisWslAgentHome.js';
import { paradisCwdGroupKey } from '../../../common/paradisWslPath.js';
import { IParadisCodexApprovalInteraction, IParadisCodexDaemonEvent, IParadisCodexModelOption, IParadisCodexThreadMessage, IParadisCodexThreadSettings, IParadisCodexThreadTarget, PARADIS_CODEX_DAEMON_DISCONNECTED, ParadisCodexControlError, ParadisCodexLiveClient, truncateCodexLiveText } from './paradisCodexLiveClient.js';
import { paradisBuildAgentCommandCatalog, type IParadisAgentCommandOption } from './paradisAgentCommandCatalog.js';
import { IParadisAgentActivityState, ParadisAgentActivityTracker } from './paradisAgentActivity.js';
import { IParadisMobilePaneOwner, ParadisMobilePaneOwnership, ParadisMobilePaneRegistry, paradisMergeLivePaneMetadata } from './paradisMobilePaneRegistry.js';
import { ParadisAgentSessionStore } from './paradisAgentSessionStore.js';
import { ParadisRemoteTranscriptMirrorStore, paradisIsRemoteAgentTranscriptMirrorPath, paradisRemoteTranscriptMirrorRoots } from './paradisRemoteTranscriptMirror.js';
import { type IParadisClaudeSubagentMeta, type IParadisRecoveredAgentActivity, paradisParseClaudePersistedActivity, paradisParseCodexPersistedActivity } from './paradisPersistedAgentActivity.js';
import { type IParadisAgentLiveAppendPatch, PARADIS_AGENT_LIVE_APPEND_ENCODING, paradisAgentLivePayloadForEncoding } from '../common/paradisMobileAgentLivePatch.js';
import { paradisAgentQuestionKeySequence } from '../common/paradisAgentQuestionKeys.js';
import { ParadisDirectoryWalkLedger } from '../common/paradisDirectoryWalkLedger.js';
import { runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';

/** エージェントCLIの種別 (transcriptパスから判定)。 */
export type ParadisAgentKind = 'claude' | 'codex';
export type ParadisCliDiscoveryMode = 'new' | 'resume' | 'fork';

/** kind==='question' の選択肢1件。 */
export interface IParadisAgentQuestionOption {
	readonly label: string;
	readonly description?: string;
}

/**
 * tool_result に含まれていた画像1枚のメタ情報。実体（base64）はここには載せず、
 * モバイルがステップを開いたときの 'tool-image' 要求で初めて転送する。
 */
export interface IParadisAgentChatImage {
	/** 同一メッセージ内での並び順。'tool-image' 要求のキー（rev と組で1枚を指す）。 */
	readonly index: number;
	/** 'image/png' 等。モバイルは data URI の組み立てに使う。 */
	readonly mediaType: string;
	/** デコード後のおおよそのバイト数（モバイルの容量表示用）。 */
	readonly bytes: number;
	/**
	 * 大きすぎて実体を保持していない。モバイルは取り寄せを試みず、その旨を表示する
	 * （保持期限切れと区別するためのフラグ）。
	 */
	readonly oversize?: true;
}

/** モバイルへ送る正規化済みチャットメッセージ1件。 */
export interface IParadisAgentChatMessage {
	/** epoch内で単調増加する連番 (差分同期用)。 */
	readonly rev: number;
	readonly role: 'user' | 'assistant' | 'tool';
	readonly kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'question' | 'peer_message';
	readonly text: string;
	/** kind==='tool_use' のときのツール名。 */
	readonly tool?: string;
	/** 元イベントの時刻 (epoch ms、取れた場合のみ)。 */
	readonly ts?: number;
	/** kind==='question' のとき: タブ見出し（AskUserQuestion の header）。 */
	readonly header?: string;
	/** kind==='question' のとき: 選択肢（TUIの表示順 = 番号キーの割り当て順）。 */
	readonly options?: readonly IParadisAgentQuestionOption[];
	/** kind==='question' のとき: 複数選択可能な質問か（TUIではトグル選択 + Enter確定）。 */
	readonly multiSelect?: boolean;
	/** kind==='question' | 'tool_result' のとき: 対応付け用の tool_use ID。
	 *  同じIDの tool_result が後続に現れたら質問は回答済み（モバイルはUIを非活性化する）。 */
	readonly toolUseId?: string;
	/** kind==='question' のとき: 同一 AskUserQuestion 呼び出しのグループキー。
	 *  複数質問はモバイル側でこのキーごとに1枚のステップ式カードへ集約され、
	 *  全問回答が揃ってから一括でTUIへ注入される（1問ごとのEnterはフォーム全体を
	 *  Submitしてしまうため）。 */
	readonly questionGroup?: string;
	/** kind==='question' のとき: グループ内の位置（0起点）。 */
	readonly questionIndex?: number;
	/** kind==='question' のとき: グループの総質問数。 */
	readonly questionCount?: number;
	/** kind==='peer_message': Claude Code Agent Teamsの送信元と要約。 */
	readonly peerName?: string;
	readonly peerSummary?: string;
	/** kind==='tool_result' のとき: ツールがエラーを返したか（transcriptの is_error）。 */
	readonly isError?: boolean;
	/**
	 * text が TOOL_TEXT_LIMIT / TEXT_LIMIT で切り詰められている。モバイルは 'tool-full'
	 * リクエストで全文を取り寄せられる（展開時のオンデマンド取得）。
	 */
	readonly truncated?: boolean;
	/**
	 * 画像のメタ情報。ツール結果に含まれていた画像（Readで読んだ画像、MCPのスクリーンショット、
	 * Codex の view_image）と、ユーザーが発言に貼った画像の両方で付く。
	 * 実体は 'tool-image' で別途取り寄せる。
	 */
	readonly images?: readonly IParadisAgentChatImage[];
}

/** transcript確定前に表示する一時的な実行状況。履歴revには含めず、常に最新値で置換する。 */
export interface IParadisAgentLiveState {
	readonly phase: 'thinking' | 'tool' | 'message' | 'permission';
	readonly source: 'hook' | 'transcript' | 'codex-daemon' | 'pty';
	/** 現在の処理が始まった時刻（経過時間表示用）。 */
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly tool?: string;
	readonly detail?: string;
	/** MessageDisplay / daemon deltaで先出しする生成中テキスト。 */
	readonly text?: string;
	readonly final?: boolean;
	/** transcript/PTYが明示的に報告した経過秒。無ければstartedAtから算出する。 */
	readonly elapsedSeconds?: number;
	/** PTY等が表示した概算生成トークン数。 */
	readonly tokenCount?: number;
}

/** セッションのメタ情報（モバイルのエージェントタブに表示する）。 */
export interface IParadisAgentSessionInfo {
	/** モデル名（Claude: assistant行の message.model、Codex: turn_context.model）。 */
	readonly model?: string;
	/** reasoning effort（Codex: turn_context.effort、Claude: settings.json の既定値 + /effort の実行記録）。 */
	readonly effort?: string;
}

export type IParadisAgentInteraction =
	| { readonly kind: 'question'; readonly id: string }
	| {
		readonly kind: 'approval'; readonly id: string; readonly title?: string; readonly detail?: string;
		readonly choices?: IParadisCodexApprovalInteraction['choices'];
	};

export function paradisIsCodexDaemonApprovalInteraction(interactionId: string): boolean {
	return interactionId.startsWith('codex:') || interactionId.startsWith('codex-status:');
}

/**
 * ターンやセッションの終了を伝える hook か。
 *
 * これらを取りこぼすと live 状態と activeTurnTokens が stuck し、モバイルが
 * 「応答を生成中」のまま固着したうえ、モデル変更なども入力待ち判定に弾かれ続ける。
 * 終了時は質問・承認・活動表示も同じ完了処理へ収束させる必要がある。
 */
export function paradisIsTurnEndHookEvent(eventName: string): boolean {
	return eventName === 'Stop' || eventName === 'StopFailure' || eventName === 'SessionEnd' || eventName === 'agent-turn-complete';
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
 * 現在モバイルへ提示すべき interaction を決める。未回答の質問を承認より優先する。
 *
 * 承認と質問はエージェント側で同時に成立しないが、tool_use_id を伴わない PermissionRequest から
 * 作られた pendingApproval は合成IDになり PostToolUse と一致しないためターン終了まで解除されない。
 * 承認を先に返していた頃は、それが後続の質問を覆い隠してモバイルからの回答が全て
 * stale-interaction で弾かれていた（「質問なのに許可/拒否しか出ず、押しても効かない」の実体）。
 *
 * 逆向きの固着（質問が承認を永久に覆う）を防ぐため、pendingQuestions 側にも
 * ターン終了での解除経路（ParadisAgentChatTailer.clearPendingQuestions）を用意してある。
 */
export function paradisPickCurrentInteraction(
	messages: readonly IParadisAgentChatMessage[],
	pendingQuestions: ReadonlySet<string>,
	pendingApproval: Extract<IParadisAgentInteraction, { readonly kind: 'approval' }> | undefined,
): IParadisAgentInteraction | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.kind === 'question' && message.toolUseId !== undefined && pendingQuestions.has(message.toolUseId)) {
			return { kind: 'question', id: message.questionGroup ?? message.toolUseId };
		}
	}
	return pendingApproval ?? null;
}

export interface IParadisAgentActivityDetailMessage {
	readonly role: 'user' | 'assistant' | 'tool';
	readonly kind: 'text' | 'thinking' | 'tool';
	readonly text: string;
	/**
	 * kind==='tool' のとき、呼び出しか結果か。モバイルはこれと toolUseId で
	 * 親のチャット画面と同じタイムライン（ツール名つきのステップ）を組み立てる。
	 */
	readonly toolKind?: 'tool_use' | 'tool_result';
	readonly tool?: string;
	readonly toolUseId?: string;
	readonly ts?: number;
	readonly isError?: boolean;
}

/** transcriptの生メッセージを SubAgent詳細用へ落とす（Claude / Codex 共通）。 */
function toDetailMessage(message: IRawMessage): IParadisAgentActivityDetailMessage {
	const kind: IParadisAgentActivityDetailMessage['kind'] = message.kind === 'thinking' ? 'thinking' : message.kind === 'tool_use' || message.kind === 'tool_result' ? 'tool' : 'text';
	return {
		role: message.role, kind, text: message.text,
		...(message.kind === 'tool_use' || message.kind === 'tool_result' ? { toolKind: message.kind } : {}),
		...(message.tool !== undefined ? { tool: message.tool } : {}),
		...(message.toolUseId !== undefined ? { toolUseId: message.toolUseId } : {}),
		...(message.ts !== undefined ? { ts: message.ts } : {}),
		...(message.isError === true ? { isError: true } : {}),
	};
}

/** agentチャネルのモバイル→PCメッセージ。 */
type AgentInbound =
	| { t: 'attach'; id: number; token?: string; epoch?: string; afterRev?: number; liveEncoding?: string }
	| { t: 'detach'; id: number; token?: string }
	| { t: 'action/sendMessage'; id: number; token?: string; requestId: string; epoch: string; text: string }
	| { t: 'action/answerQuestion'; id: number; token?: string; requestId: string; epoch: string; interactionId: string; answers: readonly AgentQuestionAnswer[] }
	| { t: 'action/answerApproval'; id: number; token?: string; requestId: string; epoch: string; interactionId: string; choice: string }
	| { t: 'action/claudeSetting'; id: number; token?: string; requestId: string; epoch: string; setting: 'model' | 'effort'; value: string }
	| { t: 'model-catalog'; id: number; token?: string; requestId: string }
	| { t: 'command-catalog'; id: number; token?: string; requestId: string }
	| { t: 'settings-update'; id: number; token?: string; requestId: string; model: string; effort: string }
	| { t: 'activity-detail'; id: number; token?: string; requestId: string; epoch: string; activityId: string }
	| { t: 'tool-full'; id: number; token?: string; requestId: string; epoch: string; rev: number }
	| { t: 'tool-image'; id: number; token?: string; requestId: string; epoch: string; rev: number; index: number };

/** agentチャネルのPC→モバイルメッセージ。 */
type AgentOutbound =
	| { t: 'snapshot'; id: number; agent: ParadisAgentKind; epoch: string; rev: number; messages: IParadisAgentChatMessage[]; truncated?: boolean; info?: IParadisAgentSessionInfo; live?: IParadisAgentLiveState | null; liveRevision?: number; activity?: IParadisAgentActivityState | null; interaction?: IParadisAgentInteraction | null; capabilities?: { readonly agentActions: true; readonly claudeSettings?: true } }
	| { t: 'delta'; id: number; agent: ParadisAgentKind; epoch: string; rev: number; messages: IParadisAgentChatMessage[]; info?: IParadisAgentSessionInfo; live?: IParadisAgentLiveState | null; liveRevision?: number; liveAppend?: IParadisAgentLiveAppendPatch; activity?: IParadisAgentActivityState | null; interaction?: IParadisAgentInteraction | null; capabilities?: { readonly agentActions: true; readonly claudeSettings?: true } }
	| { t: 'model-catalog'; id: number; requestId: string; models: readonly IParadisCodexModelOption[] }
	| { t: 'command-catalog'; id: number; requestId: string; commands: readonly IParadisAgentCommandOption[] }
	| { t: 'command-catalog-error'; id: number; requestId: string; message: string }
	| { t: 'settings-update'; id: number; requestId: string; status: 'pending' | 'confirmed' | 'failed'; info?: IParadisAgentSessionInfo; code?: string; message?: string }
	| { t: 'action-result'; id: number; requestId: string; status: 'accepted' | 'rejected'; code?: string; message?: string; consumed?: boolean }
	| { t: 'activity-detail'; id: number; requestId: string; activityId: string; messages?: readonly IParadisAgentActivityDetailMessage[]; error?: string }
	| { t: 'tool-full'; id: number; requestId: string; rev: number; text?: string; error?: string }
	| { t: 'tool-image'; id: number; requestId: string; rev: number; index: number; mediaType?: string; data?: string; error?: string }
	| { t: 'model-control-error'; id: number; requestId: string; code: string; message: string }
	| { t: 'none'; id: number };

type AgentQuestionAnswer =
	| { readonly kind: 'option'; readonly index: number }
	| { readonly kind: 'multi'; readonly indices: readonly number[] }
	| { readonly kind: 'text'; readonly optionCount: number; readonly text: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const POLL_INTERVAL_MS = 1500;
/** Claude hookが渡す agent_id の受理形。SubagentStart/Stopの2経路(親子関係の解決・backgroundTasks反映)で共有する。 */
const PARADIS_CLAUDE_AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,500}$/;
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
/**
 * 通知回数のカウンタを覚えておく上限（計測用。超過分は最後に触ったものから遠い順に捨てる）。
 *
 * 1回の通知で「グループ単位」と「内容単位」の2エントリを使うので、質問の実効履歴はこの半分。
 * 追い出しで消えるとカウントが1に戻り、**まさに検出したい重複が上限付近で見えなくなる**ため、
 * 素朴な挿入順ではなく最終利用順で捨てる（{@link bumpQuestionNotifyCount}）。
 */
const QUESTION_NOTIFY_COUNT_LIMIT = 400;
/** 目印にするラベル片の長さ。検証側の上限（`paradisMobileWorkspaceProvider`）はこれより緩い。 */
const PARADIS_QUESTION_READY_MARKER_LENGTH = 12;

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
/** 本文テキストの上限 (モバイル表示用。超過は末尾に…を付けて切る)。 */
const TEXT_LIMIT = 6000;
const TOOL_TEXT_LIMIT = 1500;
/**
 * 'tool-full'（モバイルの展開時オンデマンド取得）で返せる全文の1件あたり上限。
 * 転送とPCメモリの両方を有界にするため、これを超える出力はここで打ち切る。
 */
const FULL_TEXT_LIMIT = 64 * 1024;
/** 1ペインが保持する全文キャッシュの上限（件数・合計バイト）。古いrevから捨てる。 */
const FULL_TEXT_CACHE_ENTRIES = 40;
const FULL_TEXT_CACHE_BYTES = 2 * 1024 * 1024;
/**
 * 'tool-image'（モバイルの展開時オンデマンド取得）で扱う画像1枚あたりの上限。
 * transcript には base64 のまま入っているため、その文字数で判定する（生バイトの約4/3 =
 * 生 2.2MB 程度まで）。MAX_TRANSCRIPT_LINE_BYTES より小さくしておくこと（それを超える行は
 * そもそも transcript から読めない）。超過した画像はメタに oversize を立てて実体を捨てる。
 */
const TOOL_IMAGE_BASE64_LIMIT = 3 * 1024 * 1024;
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
/**
 * 1メッセージから拾う画像の枚数上限。'tool-image' 要求の index 上限（100未満）と揃える
 * （取り寄せられない画像のカードをモバイルに出さないため）。
 */
const MAX_IMAGES_PER_MESSAGE = 100;
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

function truncateText(text: string, limit: number): string {
	// allow-any-unicode-next-line
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 表示用に切り詰めつつ、切り詰めたときだけ全文（FULL_TEXT_LIMIT まで）を添えて返す。
 * 全文は送信メッセージには載せず、tailer が rev 単位で保持してモバイルの
 * 'tool-full' リクエスト（展開時のオンデマンド取得）に応答するために使う。
 */
function withTruncation(text: string, limit: number): { readonly text: string; readonly truncated?: true; readonly fullText?: string } {
	if (text.length <= limit) {
		return { text };
	}
	// allow-any-unicode-next-line
	return { text: `${text.slice(0, limit)}…`, truncated: true, fullText: text.slice(0, FULL_TEXT_LIMIT) };
}

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
	if (/[\\/]\.codex[\\/]/.test(transcriptPath) || /[\\/]rollout-[^\\/]*\.jsonl$/.test(transcriptPath)) {
		return 'codex';
	}
	const codexHome = paradisCodexHome();
	return (transcriptPath === codexHome || transcriptPath.startsWith(codexHome + sep)) ? 'codex' : 'claude';
}

/**
 * hook経由で届いた transcript_path が許可ディレクトリ（~/.claude / ~/.codex 配下）に
 * 収まっているかを検証する。ペイントークンはターミナルの全子プロセスへ環境変数として
 * 渡るため、hookエンドポイントを騙って任意ファイルをモバイルへtailさせる悪用を防ぐ
 * （所在検証 + realpath でシンボリックリンク・`..` 経由の脱出も排除する）。
 */
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
	const roots = [paradisClaudeConfigDir(), paradisCodexHome(), ...paradisRemoteTranscriptMirrorRoots()];
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
		const agentType = str(parsed?.['agentType']);
		const description = str(parsed?.['description']);
		const spawnDepth = num(parsed?.['spawnDepth']);
		if (agentType === undefined && description === undefined && spawnDepth === undefined) { return undefined; }
		return {
			...(agentType !== undefined ? { agentType } : {}),
			...(description !== undefined ? { description } : {}),
			...(spawnDepth !== undefined ? { spawnDepth } : {}),
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
		if (match === null) { continue; }
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

async function discoverCodexPersistedSubagentFiles(rootThreadId: string, homes: IParadisAgentHomes): Promise<readonly ICodexPersistedSubagentFile[]> {
	if (!/^[A-Za-z0-9._:-]{1,500}$/.test(rootThreadId)) { return []; }
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
			const id = str(row?.['id']);
			// state DB に書かれているのは Codex から見たパス。WSL なら Linux 側の表記なので戻す。
			const path = paradisLocalAgentPathOrUndefined(homes, str(row?.['rollout_path']));
			const source = str(row?.['source']);
			const mtime = num(row?.['mtime']);
			const relationship = source !== undefined ? paradisParseCodexThreadSource(source) : undefined;
			return id !== undefined && /^[A-Za-z0-9._:-]{1,500}$/.test(id) && path !== undefined && isAbsolute(path) && path.endsWith('.jsonl') && source !== undefined && mtime !== undefined && relationship !== undefined
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

// ---- transcript行 → 正規化メッセージ --------------------------------------------------------

interface IRawMessage {
	readonly role: 'user' | 'assistant' | 'tool';
	readonly kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'question' | 'peer_message';
	readonly text: string;
	readonly tool?: string;
	readonly ts?: number;
	readonly header?: string;
	readonly options?: readonly IParadisAgentQuestionOption[];
	readonly multiSelect?: boolean;
	readonly toolUseId?: string;
	readonly questionGroup?: string;
	readonly questionIndex?: number;
	readonly questionCount?: number;
	readonly peerName?: string;
	readonly peerSummary?: string;
	readonly isError?: boolean;
	/** 切り詰め前の全文。モバイルへは送らず tailer が 'tool-full' 用に保持する。 */
	readonly fullText?: string;
	/** 画像の実体。モバイルへは送らず tailer が 'tool-image' 用に保持する。 */
	readonly imageData?: readonly IFlattenedImage[];
}

/**
 * 表示メッセージには乗らない「状態のためのシグナル」。パース時に1バッチ分を収集し、
 * tailer がバックグラウンドタスク・質問回答待ち・セッションメタ情報の追跡へ反映する。
 */
type ICodexTranscriptActivityEvent =
	| { readonly type: 'turnStart'; readonly at: number }
	| { readonly type: 'subagent'; readonly id: string; readonly agentPath?: string; readonly kind: 'started' | 'interacted' | 'interrupted'; readonly at: number }
	| { readonly type: 'turnEnd'; readonly reason: 'completed' | 'failed' | 'interrupted'; readonly at: number };

interface IParseSignals {
	/** バックグラウンドタスク（サブエージェント等）の起動: id → 起動時刻。 */
	readonly openedTasks: Map<string, number>;
	/** task-notification が届いた（完了・失敗・停止いずれも）タスクID。 */
	readonly closedTasks: string[];
	/** 出現した質問 (AskUserQuestion) の tool_use_id。 */
	readonly askedQuestionIds: string[];
	/** tool_result が現れた tool_use_id（質問の「回答済み」判定）。 */
	readonly answeredIds: string[];
	/** 実ユーザーのテキスト発話があった（未回答質問クリアの保険）。 */
	userText: boolean;
	/**
	 * ターンが終了した（Codex event_msg の task_complete / error / turn_aborted）。
	 * usage limit 等のエラー中断は Stop 系 hook が発火しないため、transcript が唯一の検出点。
	 * ライブ追記時のみライブ状態（考え中表示）の解除に使う。
	 */
	turnEnded: 'completed' | 'failed' | 'interrupted' | undefined;
	readonly codexActivityTimeline: ICodexTranscriptActivityEvent[];
	/**
	 * 直前に現れた Codex の view_image 呼び出しの call_id。
	 * Codex は読んだ画像の実体を「関数の結果」ではなく直後の user メッセージへ書くため、
	 * その画像をユーザーの発言ではなく view_image の結果として繋ぐのに使う。
	 */
	pendingCodexImageCallId?: string;
	model?: string;
	effort?: string;
	/**
	 * transcript の行が書かれた CLI のバージョン（Claude Code は各行に `version` を持つ）。
	 *
	 * 回答をTUIへ流すキー列は特定バージョンの実挙動に合わせてあるため（paradisAgentQuestionKeys の
	 * 冒頭を参照）、壊れたときに「どの版から変わったか」を切り分けられるようにこれだけ拾う。
	 */
	cliVersion?: string;
}

function newParseSignals(): IParseSignals {
	return { openedTasks: new Map(), closedTasks: [], askedQuestionIds: [], answeredIds: [], codexActivityTimeline: [], userText: false, turnEnded: undefined };
}

function decodeXmlAttribute(value: string): string {
	return value.replace(/&quot;/g, '"').replace(/&apos;/g, String.fromCodePoint(39)).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Claude Code Agent TeamsのMailbox配送を通常のユーザー発言から分離する。 */
function parseClaudePeerMessage(rawText: string, ts: number | undefined): IRawMessage | null | undefined {
	// ユーザーがタグ文字列を質問に含めただけのケースを誤分類しないよう、Claude Codeが
	// 付ける配送prefixまたはcross-session wrapperが先頭にある場合だけ内部通信として扱う。
	if (!rawText.startsWith('Another Claude session sent a message') && !rawText.startsWith('<cross-session-message>')) {
		return undefined;
	}
	const tagged = /<(teammate-message|agent-message)\b([^>]*)>([\s\S]*?)<\/\1>/.exec(rawText);
	if (tagged === null) {
		const crossSession = /<cross-session-message>([\s\S]*?)<\/cross-session-message>/.exec(rawText);
		const text = (crossSession?.[1] ?? rawText.replace(/^Another Claude session sent a message(?: while you were working)?:?\s*/, '')).trim();
		return text.length > 0 ? { role: 'assistant', kind: 'peer_message', text: truncateText(text, TEXT_LIMIT), ts } : null;
	}
	const attributes = tagged[2];
	const body = tagged[3].trim();
	try {
		const protocol = rec(JSON.parse(body));
		if (protocol?.['type'] === 'idle_notification') {
			return null;
		}
	} catch {
		// 通常の自然言語レポートはJSONではない。
	}
	if (body.length === 0) {
		return null;
	}
	const name = /\b(?:teammate_id|from)="([^"]+)"/.exec(attributes)?.[1];
	const summary = /\bsummary="([^"]+)"/.exec(attributes)?.[1];
	return {
		role: 'assistant', kind: 'peer_message', text: truncateText(body, TEXT_LIMIT), ts,
		...(name !== undefined ? { peerName: decodeXmlAttribute(name) } : {}),
		...(summary !== undefined ? { peerSummary: decodeXmlAttribute(summary) } : {}),
	};
}

/** unknown からの安全なプロパティ読み出し。 */
function rec(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

function isValidApprovalAction(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'action/answerApproval' }> {
	return msg.t === 'action/answerApproval'
		&& typeof msg.epoch === 'string' && msg.epoch.length > 0 && msg.epoch.length <= 200
		&& typeof msg.interactionId === 'string' && msg.interactionId.length > 0 && msg.interactionId.length <= 500
		&& typeof msg.choice === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(msg.choice)
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
	return msg.t === 'command-catalog' && Object.keys(msg).every(key => key === 't' || key === 'id' || key === 'token' || key === 'requestId')
		&& isValidControlRequest(msg);
}

function isValidSettingsUpdateRequest(msg: AgentInboundCandidate): msg is AgentInboundCandidate & Extract<AgentInbound, { t: 'settings-update' }> {
	return msg.t === 'settings-update'
		&& typeof msg.model === 'string' && msg.model.length > 0 && msg.model.length <= 500
		&& typeof msg.effort === 'string' && msg.effort.length > 0 && msg.effort.length <= 100
		&& isValidControlRequest(msg);
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
		case 'action/answerApproval': return isValidApprovalAction(msg) ? msg : undefined;
		case 'action/claudeSetting': return isValidClaudeSettingAction(msg) ? msg : undefined;
		case 'model-catalog': return isValidModelCatalogRequest(msg) ? msg : undefined;
		case 'command-catalog': return isValidCommandCatalogRequest(msg) ? msg : undefined;
		case 'settings-update': return isValidSettingsUpdateRequest(msg) ? msg : undefined;
		case 'activity-detail': return isValidActivityDetailRequest(msg) ? msg : undefined;
		case 'tool-full': return isValidToolFullRequest(msg) ? msg : undefined;
		case 'tool-image': return isValidToolImageRequest(msg) ? msg : undefined;
		default: return undefined;
	}
}

export function paradisIsValidAgentInboundForTest(value: unknown): boolean {
	return parseAgentInbound(value) !== undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stableTextHash(value: string): string {
	let hash = 2166136261;
	for (const character of value) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
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
}

export function paradisParseCodexSessionMeta(firstLine: string): IParadisCodexSessionMeta | undefined {
	try {
		const meta = rec(JSON.parse(firstLine));
		const payload = rec(meta?.['payload']);
		const cwd = str(payload?.['cwd']);
		if (meta?.['type'] !== 'session_meta' || cwd === undefined) {
			return undefined;
		}
		const sessionId = str(payload?.['session_id']) ?? str(payload?.['id']);
		const sourceSpawn = rec(rec(rec(payload?.['source'])?.['subagent'])?.['thread_spawn']);
		const parentThreadId = str(payload?.['parent_thread_id']) ?? str(sourceSpawn?.['parent_thread_id']);
		const rawDepth = num(payload?.['depth']) ?? num(sourceSpawn?.['depth']);
		const depth = rawDepth !== undefined ? Math.min(5, Math.max(1, Math.trunc(rawDepth))) : undefined;
		const agentPath = str(payload?.['agent_path']) ?? str(sourceSpawn?.['agent_path']);
		const agentNickname = str(payload?.['agent_nickname']) ?? str(sourceSpawn?.['agent_nickname']);
		// SubAgentのthreadは `source.subagent.thread_spawn` / `thread_source` で名乗る。これが無い
		// 形式でも、親を指すthread IDを持つなら子とみなす。比較相手はこのrollout自身のID (`id`) で
		// あって `session_id` ではない: 現行Codexは子rolloutの `session_id` へ「親の」thread IDを
		// 書くため、session_idと比べると子が必ずrootへ化ける（このペインのセッションが子の会話に
		// 差し替わり、モバイルに「親セッションが切り替わりました」が出る）。
		const ownThreadId = str(payload?.['id']) ?? sessionId;
		const spawnedAsSubagent = sourceSpawn !== undefined || str(payload?.['thread_source']) === 'subagent';
		const subagent = spawnedAsSubagent || (parentThreadId !== undefined && parentThreadId !== ownThreadId);
		return {
			cwd, ...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
			...(subagent ? { subagent: true as const, ...(parentThreadId !== undefined ? { parentThreadId } : {}) } : {}),
			...(depth !== undefined ? { depth } : {}), ...(agentPath !== undefined ? { agentPath } : {}),
			...(agentNickname !== undefined ? { agentNickname } : {}),
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
		return rec(rec(rec(JSON.parse(source))?.['subagent'])?.['thread_spawn']) === undefined;
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
		const spawn = rec(rec(rec(JSON.parse(source))?.['subagent'])?.['thread_spawn']);
		const parentThreadId = str(spawn?.['parent_thread_id']);
		const rawDepth = num(spawn?.['depth']);
		if (parentThreadId === undefined || rawDepth === undefined) { return undefined; }
		const agentNickname = str(spawn?.['agent_nickname']);
		const agentRole = str(spawn?.['agent_role']);
		return { parentThreadId, depth: Math.min(5, Math.max(1, Math.trunc(rawDepth))), ...(agentNickname !== undefined ? { agentNickname } : {}), ...(agentRole !== undefined ? { agentRole } : {}) };
	} catch { return undefined; }
}

/** 新規起動は生成時刻、resumeは更新時刻でCLI実行との相関を検証する。 */
export function paradisCliDiscoveryCandidateIsFresh(candidate: { readonly mtime: number; readonly createdAt?: number }, minMtime: number | undefined, mode: ParadisCliDiscoveryMode): boolean {
	if (minMtime === undefined) { return true; }
	return mode === 'resume' ? candidate.mtime >= minMtime : candidate.createdAt !== undefined && candidate.createdAt >= minMtime;
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

interface ITranscriptProgress {
	readonly tool: string;
	readonly detail?: string;
	readonly elapsedSeconds?: number;
	readonly done?: boolean;
}

/** Claude transcriptのephemeral progress行を、表示に必要な最小情報へ正規化する。 */
function parseClaudeProgress(obj: Record<string, unknown>): ITranscriptProgress | undefined {
	if (obj['type'] !== 'progress') {
		return undefined;
	}
	const data = rec(obj['data']);
	const type = str(data?.['type']);
	if (type === 'bash_progress') {
		const output = str(data?.['output'])?.trim();
		const detail = output?.split(/\r?\n/).filter(Boolean).at(-1);
		const elapsedSeconds = num(data?.['elapsedTimeSeconds']);
		return {
			tool: 'Bash',
			...(detail !== undefined ? { detail: truncateText(detail, 500) } : {}),
			...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}),
		};
	}
	if (type === 'mcp_progress') {
		const toolName = str(data?.['toolName']) ?? 'MCP';
		const serverName = str(data?.['serverName']);
		const progressMessage = str(data?.['progressMessage']);
		const status = str(data?.['status']);
		const elapsedTimeMs = num(data?.['elapsedTimeMs']);
		const detail = [serverName !== undefined ? `${serverName} MCP` : undefined, progressMessage].filter((part): part is string => part !== undefined && part.length > 0).join(' · ');
		return {
			tool: toolName,
			...(detail.length > 0 ? { detail: truncateText(detail, 500) } : {}),
			...(elapsedTimeMs !== undefined ? { elapsedSeconds: Math.max(0, Math.round(elapsedTimeMs / 1000)) } : {}),
			...((status === 'completed' || status === 'failed') ? { done: true } : {}),
		};
	}
	return undefined;
}

/**
 * 画像1枚のメタ情報（モバイルへ送る側）を作る。実体を保持できるかの判定も兼ねる:
 * transcript の1行上限を超える画像はそもそも読めないため、保持できる上限
 * （TOOL_IMAGE_BASE64_LIMIT）を超えたものは oversize として実体を捨てる。
 */
export function paradisToolImageMeta(index: number, image: { readonly mediaType: string; readonly base64: string }): IParadisAgentChatImage {
	// base64 の実バイト数（末尾パディングを除いた概算）。モバイルの容量表示にだけ使う。
	const padding = image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0;
	const bytes = Math.max(0, Math.floor(image.base64.length * 3 / 4) - padding);
	return {
		index, mediaType: image.mediaType, bytes,
		...(image.base64.length > TOOL_IMAGE_BASE64_LIMIT ? { oversize: true as const } : {}),
	};
}

/** 上限どうしの整合（画像は transcript の1行に収まる範囲でしか扱えない）を検査するため公開する。 */
export const paradisAgentChatImageLimitsForTest = {
	get toolImageBase64Limit() { return TOOL_IMAGE_BASE64_LIMIT; },
	get maxTranscriptLineBytes() { return MAX_TRANSCRIPT_LINE_BYTES; },
	get maxImagesPerMessage() { return MAX_IMAGES_PER_MESSAGE; },
	get initialReadTailBytes() { return INITIAL_READ_TAIL_BYTES; },
} as const;

/** tool_result の content に含まれていた画像1枚（実体つき）。 */
interface IFlattenedImage {
	readonly mediaType: string;
	/** transcript に入っていた base64 そのまま。モバイルへは 'tool-image' でのみ渡す。 */
	readonly base64: string;
}

/** tool_result 等の content (string | ブロック配列) を表示テキストと画像へ分解した結果。 */
interface IFlattenedContent {
	readonly text: string;
	readonly images: readonly IFlattenedImage[];
}

function isImageMediaType(value: string): boolean {
	return /^image\/[a-zA-Z0-9.+-]{1,60}$/.test(value);
}

/**
 * 平坦化後の本文が画像のプレースホルダだけか（＝読める文が1つも無いか）。
 * 画像ブロックは `[image]` の行として残るため、本文の有無はこれで判定する。
 */
function isImagePlaceholderOnly(text: string): boolean {
	return text.split('\n').every(line => {
		const trimmed = line.trim();
		return trimmed.length === 0 || trimmed === '[image]';
	});
}

/**
 * Codex が rollout に書く画像は data URI 形式（`data:image/png;base64,...`）。
 * 想定外の形（外部URL・base64以外のエンコード）は取り込まない。
 */
export function parseImageDataUri(value: string | undefined): IFlattenedImage | undefined {
	if (value === undefined) {
		return undefined;
	}
	const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(value);
	const mediaType = match?.[1];
	const base64 = match?.[2];
	if (mediaType === undefined || base64 === undefined || base64.length === 0 || !isImageMediaType(mediaType)) {
		return undefined;
	}
	return { mediaType, base64 };
}

/** tool_result 等の content (string | ブロック配列) を表示テキストへ平坦化する。 */
function flattenContent(content: unknown): string {
	return flattenContentParts(content).text;
}

/**
 * flattenContent の画像つき版。画像ブロックは表示テキストでは従来どおり `[image]` の
 * プレースホルダにしつつ（この行しか読めない旧モバイルのため）、実体を別に取り出す。
 */
function flattenContentParts(content: unknown): IFlattenedContent {
	if (typeof content === 'string') {
		return { text: content, images: [] };
	}
	if (Array.isArray(content)) {
		const parts: string[] = [];
		const images: IFlattenedImage[] = [];
		for (const block of content) {
			const b = rec(block);
			if (!b) {
				continue;
			}
			const text = str(b['text']);
			if (text !== undefined) {
				parts.push(text);
			} else if (b['type'] === 'image') {
				// Claude: { type:'image', source:{ type:'base64', media_type, data } }
				parts.push('[image]');
				const source = rec(b['source']);
				const base64 = str(source?.['data']);
				const mediaType = str(source?.['media_type']);
				if (str(source?.['type']) === 'base64' && base64 !== undefined && base64.length > 0 && mediaType !== undefined && isImageMediaType(mediaType)) {
					images.push({ mediaType, base64 });
				}
			} else if (b['type'] === 'input_image') {
				// Codex: { type:'input_image', image_url:'data:image/png;base64,...' }
				parts.push('[image]');
				const image = parseImageDataUri(str(b['image_url']));
				if (image !== undefined) {
					images.push(image);
				}
			}
		}
		return { text: parts.join('\n'), images };
	}
	return { text: '', images: [] };
}

/**
 * AskUserQuestion の input（{ questions: [{ question, header, options: [{label, description}] , multiSelect? }] }）を
 * question メッセージ列へ展開する。想定形でなければ空配列（呼び出し側が汎用 tool_use にフォールバック）。
 */
function parseAskUserQuestions(input: unknown, toolUseId: string | undefined, ts: number | undefined): IRawMessage[] {
	const inputRec = rec(input);
	const questionsRaw = inputRec?.['questions'];
	if (!Array.isArray(questionsRaw)) {
		return [];
	}
	const out: IRawMessage[] = [];
	for (const questionRaw of questionsRaw) {
		const q = rec(questionRaw);
		const questionText = str(q?.['question']);
		if (!q || questionText === undefined || questionText.trim().length === 0) {
			continue;
		}
		const options: IParadisAgentQuestionOption[] = [];
		const optionsRaw = q['options'];
		if (Array.isArray(optionsRaw)) {
			for (const optionRaw of optionsRaw) {
				const o = rec(optionRaw);
				const label = str(o?.['label']);
				if (label !== undefined && label.trim().length > 0) {
					const description = str(o?.['description']);
					options.push({ label: truncateText(label, 200), ...(description !== undefined ? { description: truncateText(description, 500) } : {}) });
				}
			}
		}
		out.push({
			role: 'assistant', kind: 'question', text: truncateText(questionText, TEXT_LIMIT), ts,
			...(str(q['header']) !== undefined ? { header: str(q['header']) } : {}),
			...(options.length > 0 ? { options } : {}),
			...(q['multiSelect'] === true ? { multiSelect: true } : {}),
			...(toolUseId !== undefined ? { toolUseId } : {}),
		});
	}
	// 同一呼び出しの複数質問はモバイル側で1枚のステップ式カードへ集約するため、グループメタを
	// 付与する（グループキーは transcript 経路では実 toolUseId。ライブ注入経路では toolUseId が
	// 無いため injectLiveQuestions 側で合成キーを設定する）。
	return out.map((message, index) => ({
		...message,
		questionIndex: index,
		questionCount: out.length,
		...(toolUseId !== undefined ? { questionGroup: toolUseId } : {}),
	}));
}

/**
 * 「TUI が選択肢リストを出し終えたか」を画面文字列で判定するための目印を作る。
 *
 * 打鍵を流し始めてよいのは、リストがキーボードフォーカスを取った後。**それより前に送ると
 * 入力欄へ吸われて消える**（Claude Code 2.1.223 で実測。単問・単一選択はキーが1つしか無いので、
 * 取りこぼすと二度と拾えない）。フッタの英語表記（`Esc to cancel` 等）に頼ると TUI の文言変更で
 * 黙って壊れるため、**その質問自身の先頭の選択肢ラベル**を目印にする。
 *
 * ターミナルは折り返すので、長いラベルは画面上で途切れる。先頭の短い一片だけを使う。
 * 目印を作れない場合（ラベルが無い・記号だけ等）は `undefined` を返し、待たずに従来どおり流す。
 */
export function paradisQuestionReadyMarker(question: Pick<IRawMessage, 'options'> | undefined): string | undefined {
	const label = question?.options?.[0]?.label;
	if (typeof label !== 'string') {
		return undefined;
	}
	// **空白を取り除いてから切る**。空白の手前で切ると `"✓ Yes"` のような1文字トークンで
	// 目印を作れなくなり、逆に空白を残すと折り返しの改行で照合が外れる。
	// 照合側も同じ規則で空白を落とす（paradisScreenShowsMarker）。
	const marker = label.replace(/\s+/g, '').slice(0, PARADIS_QUESTION_READY_MARKER_LENGTH);
	return marker.length >= 2 ? marker : undefined;
}

/**
 * ライブ質問（hook注入）と transcript 上の本物の質問を突き合わせるための内容キー。
 * 両者とも parseAskUserQuestions を通るため、truncate 後のテキストが一致する。
 */
function liveQuestionContentKey(m: Pick<IRawMessage, 'text' | 'options'>): string {
	return `${m.text}\0${(m.options ?? []).map(o => o.label).join('\x01')}`;
}

/**
 * transcript に現れた質問に対応する注入済みライブ質問の合成IDを台帳から取り出す。
 * まず内容キー（質問文+選択肢ラベル列）の完全一致で引き、外れた場合は質問文のみの
 * 第2段マッチへフォールバックする。第2段は hook 側/transcript 側の一方で選択肢が
 * 欠落した場合（Windows の PowerShell hook が tool_input の深い配列を落とす等）の救済で、
 * 同文の別質問を誤って間引かないよう、候補が1エントリに絞れるときだけ適用する。
 * 内容キーは `text + '\0' + labels` 形式のため、`text + '\0'` の前方一致 = 質問文の完全一致。
 */
export function paradisTakeLiveQuestionSyntheticId(liveQuestions: Map<string, string[]>, message: Pick<IRawMessage, 'text' | 'options'>): string | undefined {
	let key = liveQuestionContentKey(message);
	let ids = liveQuestions.get(key);
	if (ids === undefined || ids.length === 0) {
		// 選択肢欠落は「一方の options が空」の形でしか起きないため、第2段は
		// 「incoming が選択肢なし、または台帳側エントリが選択肢なし（キーが text+'\0' のみ）」
		// に限定する。両側に異なる選択肢が付いた同文の質問は別物として素通しする
		// （誤 dedup で実在質問を隠し、回答を別質問へ誤紐付けするのを防ぐ）。
		const textPrefix = `${message.text}\0`;
		const incomingHasNoOptions = (message.options ?? []).length === 0;
		const candidates = [...liveQuestions.entries()].filter(([entryKey, entryIds]) =>
			entryIds.length > 0 && entryKey.startsWith(textPrefix) && (incomingHasNoOptions || entryKey === textPrefix));
		if (candidates.length !== 1) {
			return undefined;
		}
		[key, ids] = candidates[0];
	}
	const syntheticId = ids.shift();
	if (syntheticId !== undefined && ids.length === 0) {
		liveQuestions.delete(key);
	}
	return syntheticId;
}

/**
 * メッセージ列に未回答のまま残っている同内容の質問があるかを返す。突き合わせは内容キーの
 * 完全一致に加え、どちらかの選択肢が欠落しているケースを質問文のみでも拾う
 * （前方一致は `'\0'` 区切りのため質問文の完全一致と等価）。回答済みの同文質問とは衝突しない。
 */
export function paradisHasPendingDuplicateQuestion(
	messages: readonly Pick<IParadisAgentChatMessage, 'kind' | 'text' | 'options' | 'toolUseId'>[],
	pendingQuestions: ReadonlySet<string>,
	message: Pick<IRawMessage, 'text' | 'options'>,
): boolean {
	const contentKey = liveQuestionContentKey(message);
	const textPrefix = `${message.text}\0`;
	const incomingHasNoOptions = (message.options ?? []).length === 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const existing = messages[index];
		if (existing.kind !== 'question' || existing.toolUseId === undefined || !pendingQuestions.has(existing.toolUseId)) {
			continue;
		}
		const existingKey = liveQuestionContentKey(existing);
		if (existingKey === contentKey) {
			return true;
		}
		// 質問文のみの一致は「どちらかの選択肢が欠落している」場合に限る
		// （take 側と同じ理由: 同文・異選択肢の別質問を誤って抑制しない）
		const existingHasNoOptions = (existing.options ?? []).length === 0;
		if ((incomingHasNoOptions && existingKey.startsWith(textPrefix))
			|| (existingHasNoOptions && contentKey.startsWith(`${existing.text}\0`))) {
			return true;
		}
	}
	return false;
}

/**
 * Claude Code のユーザーロール行のテキストを表示メッセージへ変換する。
 * ハーネスが user ロールとして注入する合成テキスト（バックグラウンドタスクの完了通知・
 * スラッシュコマンドの実行記録・system-reminder 等）は「ユーザーの発言」として
 * 吹き出し表示すると誤解を招くため、種類ごとに変換・除去する。
 */
function pushClaudeUserText(out: IRawMessage[], rawText: string, ts: number | undefined, signals: IParseSignals): void {
	const trimmed = rawText.trim();
	if (trimmed.length === 0) {
		return;
	}
	const peerMessage = parseClaudePeerMessage(trimmed, ts);
	if (peerMessage !== undefined) {
		if (peerMessage !== null) {
			out.push(peerMessage);
		}
		return;
	}
	// ユーザーがescでツール実行（AskUserQuestion等）を中断した際にハーネスが注入する
	// 内部マーカー。ユーザーの発言ではないため表示しない（signals.userTextも立てない。
	// 立てると同一バッチ内の未回答質問カードを誤ってクリアしてしまう）。
	if (/^\[Request interrupted by user( for tool use)?\]$/.test(trimmed)) {
		return;
	}
	// バックグラウンドタスク（サブエージェント等）の完了通知。ユーザーの発言ではなく
	// ハーネスからの通知なので、ツール結果カードとして表示する。
	if (trimmed.startsWith('<task-notification>')) {
		for (const match of trimmed.matchAll(/<task-id>([^<\n]+)<\/task-id>/g)) {
			signals.closedTasks.push(match[1].trim());
		}
		const summary = /<summary>([\s\S]*?)<\/summary>/.exec(trimmed)?.[1]?.trim();
		const result = /<result>([\s\S]*?)<\/result>/.exec(trimmed)?.[1]?.trim();
		const status = /<status>([^<\n]+)<\/status>/.exec(trimmed)?.[1]?.trim();
		// allow-any-unicode-next-line
		const title = summary !== undefined && summary.length > 0 ? `バックグラウンドタスク完了: ${summary}` : 'バックグラウンドタスクが完了しました';
		const parts = [title];
		if (status !== undefined && status !== 'completed') {
			parts.push(`status: ${status}`);
		}
		if (result !== undefined && result.length > 0) {
			parts.push(result);
		}
		out.push({ role: 'tool', kind: 'tool_result', ...withTruncation(parts.join('\n'), TOOL_TEXT_LIMIT), ts });
		return;
	}
	// スラッシュコマンドの実行記録（/compact 等）。コマンド名だけを短く出す。
	const commandName = /<command-name>([^<\n]*)<\/command-name>/.exec(trimmed)?.[1]?.trim();
	if (commandName !== undefined && commandName.length > 0) {
		const commandArgs = /<command-args>([^<\n]*)<\/command-args>/.exec(trimmed)?.[1]?.trim();
		out.push({ role: 'user', kind: 'text', text: truncateText(commandArgs ? `${commandName} ${commandArgs}` : commandName, TEXT_LIMIT), ts });
		return;
	}
	// ローカルコマンドの出力・注意書きはノイズなので出さない。ただし /effort の実行記録は
	// セッションの effort 変更としてメタ情報へ反映する（Claude の transcript に effort の
	// 直接の記録は無く、これと settings.json の既定値だけが手掛かり）。
	if (trimmed.startsWith('<local-command-stdout>') || trimmed.startsWith('<local-command-caveat>')) {
		const effortMatch = /^<local-command-stdout>Set effort level to (\w+)/.exec(trimmed);
		if (effortMatch) {
			signals.effort = effortMatch[1];
		}
		return;
	}
	// 本文へ付随する system-reminder（メモリ想起等のハーネス注入）は表示から除く。
	const text = rawText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
	if (text.length === 0) {
		return;
	}
	signals.userText = true;
	out.push({ role: 'user', kind: 'text', text: truncateText(text, TEXT_LIMIT), ts });
}

/** Claude Code transcript JSONL の1行をパースする。表示対象外の行は空配列。 */
function parseClaudeLine(obj: Record<string, unknown>, signals: IParseSignals, includeSidechain = false): IRawMessage[] {
	if ((!includeSidechain && obj['isSidechain'] === true) || obj['isMeta'] === true) {
		return []; // サブエージェント内・メタ行はメインの会話に出さない
	}
	// 表示対象かどうかに関わらず拾う（どの行にも入っており、最後に見た値が今動いている版）。
	const version = str(obj['version']);
	if (version !== undefined) {
		signals.cliVersion = version;
	}
	const type = str(obj['type']);
	if (type !== 'user' && type !== 'assistant') {
		return []; // summary / system / file-history-snapshot 等
	}
	const message = rec(obj['message']);
	if (!message) {
		return [];
	}
	const tsRaw = str(obj['timestamp']);
	const tsParsed = tsRaw !== undefined ? Date.parse(tsRaw) : NaN;
	const ts = Number.isFinite(tsParsed) ? tsParsed : undefined;
	const out: IRawMessage[] = [];
	const content = message['content'];

	if (type === 'user') {
		if (typeof content === 'string') {
			pushClaudeUserText(out, content, ts, signals);
			return out;
		}
		if (Array.isArray(content)) {
			// ユーザーが貼った画像は tool_result ではなく content 直下に image ブロックとして入る。
			// 本文と同じ発言の一部なので、テキスト側のメッセージへまとめて添える。
			const pastedImages: IFlattenedImage[] = [];
			for (const block of content) {
				const b = rec(block);
				if (!b) {
					continue;
				}
				if (b['type'] === 'text') {
					pushClaudeUserText(out, str(b['text']) ?? '', ts, signals);
				} else if (b['type'] === 'image') {
					const image = flattenContentParts([b]).images[0];
					if (image !== undefined) {
						pastedImages.push(image);
					}
				} else if (b['type'] === 'tool_result') {
					const { text, images } = flattenContentParts(b['content']);
					// toolUseId は質問(AskUserQuestion)の「回答済み」判定に使う（本文が空でも回答は成立する）。
					const toolUseId = str(b['tool_use_id']);
					if (toolUseId !== undefined) {
						signals.answeredIds.push(toolUseId);
					}
					// バックグラウンドタスク（サブエージェント等）の起動応答から実行中タスクを学習する。
					if (/Async agent launched|running in the background/i.test(text)) {
						const idMatch = /\bagentId:\s*([A-Za-z0-9_-]+)/.exec(text) ?? /background with ID:\s*([A-Za-z0-9_-]+)/.exec(text);
						if (idMatch) {
							signals.openedTasks.set(idMatch[1], ts ?? Date.now());
						}
					}
					if (text.trim().length > 0 || images.length > 0) {
						out.push({
							role: 'tool', kind: 'tool_result', ...withTruncation(text, TOOL_TEXT_LIMIT), ts,
							...(toolUseId !== undefined ? { toolUseId } : {}),
							// transcript の is_error。モバイルは失敗ステップを赤で示す（推定に頼らない）。
							...(b['is_error'] === true ? { isError: true } : {}),
							...(images.length > 0 ? { imageData: images } : {}),
						});
					}
				}
			}
			if (pastedImages.length > 0) {
				// 直前のユーザー発言に添える。画像だけを貼った（本文なし）ときは
				// 画像だけの発言として1件作る。
				const last = out.at(-1);
				if (last?.role === 'user' && last.kind === 'text' && last.imageData === undefined) {
					out[out.length - 1] = { ...last, imageData: pastedImages };
				} else {
					signals.userText = true;
					out.push({ role: 'user', kind: 'text', text: '', ts, imageData: pastedImages });
				}
			}
		}
		return out;
	}

	// assistant
	const model = str(message['model']);
	if (model !== undefined && model.length > 0) {
		signals.model = model;
	}
	if (Array.isArray(content)) {
		for (const block of content) {
			const b = rec(block);
			if (!b) {
				continue;
			}
			if (b['type'] === 'text') {
				const text = str(b['text']) ?? '';
				if (text.trim().length > 0) {
					out.push({ role: 'assistant', kind: 'text', text: truncateText(text, TEXT_LIMIT), ts });
				}
			} else if (b['type'] === 'thinking') {
				const text = str(b['thinking']) ?? '';
				if (text.trim().length > 0) {
					out.push({ role: 'assistant', kind: 'thinking', ...withTruncation(text, TOOL_TEXT_LIMIT), ts });
				}
			} else if (b['type'] === 'tool_use') {
				const rawTool = str(b['name']) ?? 'tool';
				const tool = rawTool === 'WebSearch' ? 'web_search' : rawTool;
				const toolUseId = str(b['id']);
				// AskUserQuestion はユーザーへの選択式質問。汎用ツールとして折りたたむと
				// モバイルで質問に気づけないため、専用の question メッセージに展開する。
				if (tool === 'AskUserQuestion') {
					const questions = parseAskUserQuestions(b['input'], toolUseId, ts);
					if (questions.length > 0) {
						if (toolUseId !== undefined) {
							signals.askedQuestionIds.push(toolUseId);
						}
						out.push(...questions);
						continue;
					}
					// input が想定形でない場合は従来どおり汎用 tool_use として出す
				}
				let text = '';
				const input = rec(b['input']);
				if (tool === 'Agent' || tool === 'Task') {
					// サブエージェント起動は description（何をさせるか）を出す方が JSON より分かりやすい。
					const description = str(input?.['description']);
					const subagentType = str(input?.['subagent_type']);
					if (description !== undefined && description.length > 0) {
						text = subagentType !== undefined && subagentType.length > 0 ? `${description} (${subagentType})` : description;
					}
				}
				if (tool === 'web_search') {
					// クエリ文字列をそのまま出す（JSON のままだとモバイルの検索カードで読みにくい）。
					text = str(input?.['query']) ?? '';
				}
				if (text.length === 0) {
					try {
						text = JSON.stringify(b['input']);
					} catch { /* 表示は空でよい */ }
				}
				out.push({ role: 'assistant', kind: 'tool_use', tool, ...withTruncation(text, TOOL_TEXT_LIMIT), ts, ...(toolUseId !== undefined ? { toolUseId } : {}) });
			}
		}
	}
	return out;
}

/** transcript分類の回帰テスト用。productionと同じparserを1行だけ通す。 */
export function paradisParseClaudeTranscriptLineForTest(line: string): { messages: IRawMessage[]; userText: boolean } {
	let obj: Record<string, unknown> | undefined;
	try {
		obj = rec(JSON.parse(line));
	} catch {
		return { messages: [], userText: false };
	}
	if (obj === undefined) {
		return { messages: [], userText: false };
	}
	const signals = newParseSignals();
	const messages = JSON.parse(JSON.stringify(parseClaudeLine(obj, signals))) as IRawMessage[];
	return { messages, userText: signals.userText };
}

/** Codex transcript分類の回帰テスト用。productionと同じparserを1行だけ通す。 */
export function paradisParseCodexTranscriptLineForTest(line: string): { messages: IRawMessage[]; activity?: Omit<Extract<ICodexTranscriptActivityEvent, { type: 'subagent' }>, 'type'>; turn?: 'started' | 'ended' } {
	let obj: Record<string, unknown> | undefined;
	try {
		obj = rec(JSON.parse(line));
	} catch {
		return { messages: [] };
	}
	if (obj === undefined) {
		return { messages: [] };
	}
	const signals = newParseSignals();
	const messages = JSON.parse(JSON.stringify(parseCodexLine(obj, signals))) as IRawMessage[];
	const activity = signals.codexActivityTimeline.find((event): event is Extract<ICodexTranscriptActivityEvent, { type: 'subagent' }> => event.type === 'subagent');
	const turn = signals.codexActivityTimeline.find(event => event.type === 'turnStart' || event.type === 'turnEnd');
	return { messages, ...(activity !== undefined ? { activity: { id: activity.id, ...(activity.agentPath !== undefined ? { agentPath: activity.agentPath } : {}), kind: activity.kind, at: activity.at } } : {}), ...(turn !== undefined ? { turn: turn.type === 'turnStart' ? 'started' : 'ended' } : {}) };
}

/**
 * 連続する Codex rollout 行を1つの signals で通す（view_image のように、呼び出しと
 * 画像の実体が別の行に分かれる並びを検証するため）。
 */
export function paradisParseCodexTranscriptLinesForTest(lines: readonly string[]): IRawMessage[] {
	const signals = newParseSignals();
	const out: IRawMessage[] = [];
	for (const line of lines) {
		let obj: Record<string, unknown> | undefined;
		try {
			obj = rec(JSON.parse(line));
		} catch {
			continue;
		}
		if (obj !== undefined) {
			out.push(...parseCodexLine(obj, signals));
		}
	}
	return JSON.parse(JSON.stringify(out)) as IRawMessage[];
}

/** Codex子threadのrollout行を、SubAgent詳細用メッセージへ正規化する。 */
export function paradisParseCodexDetailLinesForTest(lines: readonly string[]): IParadisAgentActivityDetailMessage[] {
	const out: IParadisAgentActivityDetailMessage[] = [];
	for (const line of lines) {
		let parsed: Record<string, unknown> | undefined;
		try { parsed = rec(JSON.parse(line)); } catch { continue; }
		if (parsed === undefined) { continue; }
		for (const message of parseCodexLine(parsed, newParseSignals())) {
			if (message.kind === 'question' || message.kind === 'peer_message') { continue; }
			out.push(toDetailMessage(message));
		}
	}
	return out.slice(-200);
}

/** Claude hookの公式pathを優先し、規定配置をフォールバック候補として返す。 */
export function paradisClaudeSubagentTranscriptCandidates(transcriptPath: string, activityId: string, hookTranscriptPath?: string): readonly string[] {
	if (!/^[A-Za-z0-9._:-]{1,500}$/.test(activityId)) { return []; }
	const dir = resolve(transcriptPath, '..');
	const filename = transcriptPath.slice(transcriptPath.lastIndexOf(sep) + 1).replace(/\.jsonl$/i, '');
	const agentFile = `${activityId.startsWith('agent-') ? activityId : `agent-${activityId}`}.jsonl`;
	return [...new Set([...(hookTranscriptPath !== undefined ? [hookTranscriptPath] : []), join(dir, filename, 'subagents', agentFile), join(dir, 'subagents', agentFile)])];
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

/** Codex rollout JSONL の1行をパースする。表示対象外の行は空配列。 */
function parseCodexLine(obj: Record<string, unknown>, signals: IParseSignals): IRawMessage[] {
	// rollout行: { timestamp, type, payload }
	if (obj['type'] === 'turn_context') {
		// ターンごとの実行コンテキスト（model / effort 等）。表示メッセージは無いがメタ情報を学習する。
		const context = rec(obj['payload']);
		const model = str(context?.['model']);
		const effort = str(context?.['effort']);
		if (model !== undefined && model.length > 0) {
			signals.model = model;
		}
		if (effort !== undefined && effort.length > 0) {
			signals.effort = effort;
		}
		return [];
	}
	if (obj['type'] === 'event_msg') {
		// event_msg は表示内容には使わず、SubAgent活動とターン終了の状態復元に使う。
		// usage limit（error / codex_error_info: usage_limit_exceeded）や
		// 中断（turn_aborted）は hooks.json に対応イベントが無く Stop hook が発火しないため、
		// ここで拾わないと「考え中」表示が永久に残る。
		const eventPayload = rec(obj['payload']);
		const eventType = str(eventPayload?.['type']);
		if (eventType === 'sub_agent_activity') {
			const id = str(eventPayload?.['agent_thread_id']);
			const kind = str(eventPayload?.['kind']);
			const timestamp = str(obj['timestamp']);
			const at = num(eventPayload?.['occurred_at_ms']) ?? (timestamp !== undefined ? Date.parse(timestamp) : NaN);
			if (id !== undefined && (kind === 'started' || kind === 'interacted' || kind === 'interrupted') && Number.isFinite(at)) {
				signals.codexActivityTimeline.push({ type: 'subagent', id, ...(str(eventPayload?.['agent_path']) !== undefined ? { agentPath: str(eventPayload?.['agent_path']) } : {}), kind, at });
			}
		}
		if (eventType === 'task_started') {
			const timestamp = str(obj['timestamp']);
			const at = timestamp !== undefined ? Date.parse(timestamp) : NaN;
			if (Number.isFinite(at)) { signals.codexActivityTimeline.push({ type: 'turnStart', at }); }
		}
		if (eventType === 'task_complete' || eventType === 'error' || eventType === 'turn_aborted') {
			signals.turnEnded = eventType === 'task_complete' ? 'completed' : eventType === 'turn_aborted' ? 'interrupted' : 'failed';
			const timestamp = str(obj['timestamp']);
			const at = timestamp !== undefined ? Date.parse(timestamp) : NaN;
			if (Number.isFinite(at)) { signals.codexActivityTimeline.push({ type: 'turnEnd', reason: signals.turnEnded, at }); }
		}
		return [];
	}
	if (obj['type'] !== 'response_item') {
		return []; // session_meta 等も対象外
	}
	const payload = rec(obj['payload']);
	if (!payload) {
		return [];
	}
	const tsRaw = str(obj['timestamp']);
	const tsParsed = tsRaw !== undefined ? Date.parse(tsRaw) : NaN;
	const ts = Number.isFinite(tsParsed) ? tsParsed : undefined;
	const ptype = str(payload['type']);
	// Codex のツール呼び出し/結果は call_id で対応付く (Claude の tool_use_id 相当)。
	// toolUseId に載せてモバイル側で呼び出し⇔結果の突き合わせに使えるようにする
	// (質問の回答済み判定は kind==='question' 限定なので Codex の ID が混ざっても影響しない)。
	let callId = str(payload['call_id']) ?? str(payload['id']);
	const out: IRawMessage[] = [];

	if (ptype === 'message') {
		const role = str(payload['role']);
		if (role !== 'user' && role !== 'assistant') {
			return []; // developer / system プロンプトは出さない
		}
		const { text, images } = flattenContentParts(payload['content']);
		// Codexはuserメッセージとして環境コンテキスト/プロジェクト指示を注入するため表示から除く。
		// 旧CLI(0.4x): <environment_context> / <user_instructions>
		// 新CLI(0.80+): 「# AGENTS.md instructions for <path>」見出し＋<INSTRUCTIONS>ラッパー
		const trimmedText = text.trim();
		if (/^<(environment_context|user_instructions|ENVIRONMENT_CONTEXT|INSTRUCTIONS)/.test(trimmedText)
			|| trimmedText.startsWith('# AGENTS.md instructions for')) {
			return [];
		}
		// view_image の実体が来るのは「直後の」メッセージだけなので、ここで必ず手放す。
		// 持ち越すと、実体が来ないまま後で貼られた無関係な画像がその呼び出しの結果として
		// 繋がってしまう（環境コンテキストの注入は上で弾いた後なので巻き込まれない）。
		const pendingImageCallId = signals.pendingCodexImageCallId;
		signals.pendingCodexImageCallId = undefined;
		if (images.length > 0) {
			// Codex は view_image の実体を「関数の結果」ではなく直後の user メッセージへ
			// input_image として書く。本文のない画像だけのメッセージがそれで、ユーザーの発言
			// ではなく直前の view_image の結果なので、ツール結果として繋ぐ（signals が覚えた
			// call_id を使う）。本文つき = ユーザーが貼った画像はそのまま発言として出す。
			const viewImageCallId = isImagePlaceholderOnly(trimmedText) ? pendingImageCallId : undefined;
			if (viewImageCallId !== undefined) {
				out.push({
					role: 'tool', kind: 'tool_result', text: truncateText(text, TOOL_TEXT_LIMIT), ts,
					toolUseId: viewImageCallId, imageData: images,
				});
				return out;
			}
			out.push({ role, kind: 'text', text: truncateText(text, TEXT_LIMIT), ts, imageData: images });
			return out;
		}
		if (trimmedText.length === 0) {
			return [];
		}
		out.push({ role, kind: 'text', text: truncateText(text, TEXT_LIMIT), ts });
	} else if (ptype === 'reasoning') {
		const text = flattenContent(payload['summary']);
		if (text.trim().length > 0) {
			out.push({ role: 'assistant', kind: 'thinking', ...withTruncation(text, TOOL_TEXT_LIMIT), ts });
		}
	} else if (ptype === 'function_call' || ptype === 'custom_tool_call' || ptype === 'mcp_tool_call') {
		// custom_tool_call は arguments でなく input にテキストが入る（それ以外は function_call と同形）
		const tool = str(payload['name']) ?? 'tool';
		const text = str(payload['arguments']) ?? str(payload['input']) ?? '';
		if (tool === 'view_image') {
			// 実体は直後の user メッセージへ書かれる。その画像をこの呼び出しへ繋ぐため覚えておく。
			signals.pendingCodexImageCallId = callId;
		}
		out.push({ role: 'assistant', kind: 'tool_use', tool, ...withTruncation(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
	} else if (ptype === 'web_search_call' || ptype === 'tool_search_call') {
		// web_search_call は action.query、tool_search_call は arguments(オブジェクト)にクエリが入る
		const action = rec(payload['action']);
		const args = rec(payload['arguments']);
		let query = str(action?.['query']) ?? str(args?.['query']) ?? '';
		if (ptype === 'web_search_call' && action !== undefined) {
			try {
				const actionText = JSON.stringify(action);
				if (/https?:\/\//i.test(actionText) && !query.includes(actionText)) { query = [query, actionText].filter(Boolean).join('\n'); }
			} catch { /* 表示はqueryだけでよい */ }
		}
		if (query.length === 0) {
			try {
				query = JSON.stringify(args ?? action ?? '');
			} catch { /* 表示は空でよい */ }
		}
		if (ptype === 'web_search_call' && callId === undefined && tsRaw !== undefined) {
			callId = `web:${tsRaw}:${stableTextHash(query)}`;
		}
		out.push({ role: 'assistant', kind: 'tool_use', tool: ptype === 'web_search_call' ? 'web_search' : 'tool_search', ...withTruncation(query, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
		if (ptype === 'web_search_call' && (payload['status'] === 'completed' || payload['status'] === 'failed')) {
			const resultText = payload['status'] === 'failed' ? `Web検索に失敗しました${query ? `\n${query}` : ''}` : query || 'Web検索完了';
			out.push({ role: 'tool', kind: 'tool_result', ...withTruncation(resultText, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}), ...(payload['status'] === 'failed' ? { isError: true } : {}) });
		}
	} else if (ptype === 'tool_search_output') {
		// tool_search_call の結果 ({ call_id, status, execution, tools: [...] })。見つかった
		// ツール一覧を結果カードとして出す (無視するとツール検索の結果だけ同期から抜ける)。
		const toolsRaw = payload['tools'];
		let text = '';
		if (Array.isArray(toolsRaw) && toolsRaw.length > 0) {
			try {
				text = toolsRaw.map(tool => {
					const t = rec(tool);
					return str(t?.['name']) ?? JSON.stringify(tool);
				}).join('\n');
			} catch { /* 表示は空でよい */ }
		}
		if (text.trim().length === 0) {
			text = str(payload['status']) ?? '';
		}
		if (text.trim().length > 0) {
			out.push({ role: 'tool', kind: 'tool_result', ...withTruncation(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
		}
	} else if (ptype === 'custom_tool_call_output') {
		const text = str(payload['output']) ?? '';
		if (text.trim().length > 0) {
			out.push({ role: 'tool', kind: 'tool_result', ...withTruncation(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
		}
	} else if (ptype === 'local_shell_call') {
		let text = '';
		try {
			text = JSON.stringify(payload['action']);
		} catch { /* 表示は空でよい */ }
		out.push({ role: 'assistant', kind: 'tool_use', tool: 'shell', ...withTruncation(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
	} else if (ptype === 'function_call_output') {
		const output = payload['output'];
		let text: string;
		let failed = false;
		if (typeof output === 'string') {
			text = output;
		} else {
			const o = rec(output);
			text = str(o?.['content']) ?? flattenContent(output) ?? '';
			// Codex は成否を output.success / metadata.exit_code で示す（形は実装依存なので取れた方だけ見る）。
			const exitCode = rec(o?.['metadata'])?.['exit_code'];
			failed = o?.['success'] === false || (typeof exitCode === 'number' && exitCode !== 0);
			if (!text) {
				try {
					text = JSON.stringify(output);
				} catch {
					text = '';
				}
			}
		}
		// view_image は結果本文を持たず（"attached local image path" とだけ書く）、実体は直後の
		// user メッセージに来る。この定型文を出すと画像カードと同じ枠が二重に並ぶので落とす。
		const isViewImagePlaceholder = callId !== undefined && callId === signals.pendingCodexImageCallId && text.trim() === 'attached local image path';
		if (text.trim().length > 0 && !isViewImagePlaceholder) {
			out.push({ role: 'tool', kind: 'tool_result', ...withTruncation(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}), ...(failed ? { isError: true } : {}) });
		}
	}
	return out;
}

// ---- hook未発火時のセッション探索フォールバック ------------------------------------------------

async function discoverCodexSessionsFromStateDb(cwd: string, minMtime: number | undefined, homes: IParadisAgentHomes = paradisResolveAgentHomes(cwd)): Promise<{ agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number }[] | undefined> {
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
			const recordedPath = str(row?.['rollout_path']);
			// state DB に書かれているのは Codex から見たパス。WSL なら Linux 側の表記なので、
			// この Windows プロセスから開ける UNC へ戻さないと後続の検証も読み取りも通らない。
			const transcriptPath = recordedPath !== undefined ? paradisLocalAgentPath(homes, recordedPath) : undefined;
			const sessionId = str(row?.['id']);
			const mtime = num(row?.['mtime']);
			const createdAt = num(row?.['created_at']);
			const source = str(row?.['source']);
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
	if (!/^[A-Za-z0-9._:-]{1,500}$/.test(threadId)) { return undefined; }
	let database: DatabaseSync | undefined;
	try {
		const names = await fs.readdir(homes.codex);
		const stateDb = names.filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
		if (stateDb === undefined) { return undefined; }
		const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		database = new DatabaseSyncCtor(join(homes.codex, stateDb), { readOnly: true });
		const row = rec(database.prepare('SELECT rollout_path FROM threads WHERE id = ? AND archived = 0 LIMIT 1').get(threadId));
		const transcriptPath = paradisLocalAgentPathOrUndefined(homes, str(row?.['rollout_path']));
		return transcriptPath !== undefined && isAbsolute(transcriptPath) && transcriptPath.endsWith('.jsonl') ? transcriptPath : undefined;
	} catch {
		return undefined;
	} finally {
		database?.close();
	}
}

/** CLIのresume/fork対象として、root threadだけをIDで厳密に取得する。 */
async function discoverCodexRootTranscriptByThreadId(threadId: string, homes: IParadisAgentHomes): Promise<string | undefined> {
	if (!/^[A-Za-z0-9._:-]{1,500}$/.test(threadId)) { return undefined; }
	let database: DatabaseSync | undefined;
	try {
		const names = await fs.readdir(homes.codex);
		const stateDb = names.filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
		if (stateDb === undefined) { return undefined; }
		const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		database = new DatabaseSyncCtor(join(homes.codex, stateDb), { readOnly: true });
		const row = rec(database.prepare('SELECT rollout_path, source FROM threads WHERE id = ? AND archived = 0 LIMIT 1').get(threadId));
		const transcriptPath = paradisLocalAgentPathOrUndefined(homes, str(row?.['rollout_path']));
		const source = str(row?.['source']);
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
	if (!/^[A-Za-z0-9._:-]{1,500}$/.test(threadId)) { return undefined; }
	let database: DatabaseSync | undefined;
	try {
		const names = await fs.readdir(homes.codex);
		const stateDb = names.filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
		if (stateDb === undefined) { return undefined; }
		const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		database = new DatabaseSyncCtor(join(homes.codex, stateDb), { readOnly: true });
		const row = rec(database.prepare('SELECT source FROM threads WHERE id = ? AND archived = 0 LIMIT 1').get(threadId));
		const source = str(row?.['source']);
		return source !== undefined ? paradisParseCodexThreadSource(source) : undefined;
	} catch { return undefined; } finally { database?.close(); }
}

/**
 * Codex rollout の先頭行（session_meta）を読む。cwd探索とhookの親子判定の両方が使う。
 * session_meta は書き出し後に変わらないため、先頭16KBだけ読めば足りる。
 */
async function readCodexRolloutSessionMeta(rolloutPath: string): Promise<IParadisCodexSessionMeta | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(rolloutPath, 'r');
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(16 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return paradisParseCodexSessionMeta(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '');
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => { /* ignore */ });
	}
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
async function discoverSessionByCwd(cwd: string, agent: ParadisAgentKind, minMtime?: number, excludedPaths: ReadonlySet<string> = new Set(), mode?: ParadisCliDiscoveryMode, allowCodexDirectoryWalk: boolean = true, onCodexDirectoryWalk?: () => void): Promise<{ agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number } | undefined> {
	const candidates: { agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number }[] = [];
	// エージェントCLIが実際に読み書きしているホームと、その CLI から見た作業ディレクトリ。
	// ペインが WSL の中を指していれば、ここでディストロ側へ切り替わる。
	const homes = paradisResolveAgentHomes(cwd);

	// Claude: cwd → プロジェクトディレクトリのスラッグ（英数字以外を '-' に置換）。
	// Claude Code はcwdをrealpath解決してからスラッグ化するため、symlink経由のターミナルでも
	// 一致するよう解決後のパスを使う（解決失敗時は文字面のまま）。
	if (agent === 'claude') {
		try {
			// スラッグは Claude Code が cwd から機械的に作る。したがって、こちらも
			// **その CLI から見た作業ディレクトリ**から作らないと一致しない。WSL の中で動く
			// claude が作るのは `-home-u-projects-repo` で、UNC から作った
			// `--wsl-localhost-<distro>-home-u-projects-repo` とは構造的に別物になる。
			// なおディストロの中の symlink は解決しない（Windows 側の realpath は UNC を
			// そのまま返すため）。リポジトリへの道中に symlink がある構成では当たらない。
			let resolvedCwd = homes.matchCwd;
			if (homes.wsl === undefined) {
				try {
					resolvedCwd = await fs.realpath(cwd);
				} catch { /* 消えたディレクトリ等は文字面で試す */ }
			}
			const slug = resolvedCwd.replace(/[^a-zA-Z0-9]/g, '-');
			const dir = join(homes.claude, 'projects', slug);
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
	return paradisSelectUnambiguousSessionCandidate(eligible, minMtime, excludedPaths);
}

// ---- tailer ---------------------------------------------------------------------------------

interface ITailerDelegate {
	/** 追記分のメッセージが確定した (差分push用)。 */
	onDelta(messages: IParadisAgentChatMessage[]): void;
	/** epoch が切り替わった (truncate検知・読み直し)。購読者へ全量スナップショットを送り直す。 */
	onEpochReset(): void;
	/** アクティビティ（バックグラウンドタスク・質問回答待ち）が変化した。 */
	onActivity(): void;
	/** セッションメタ情報（model / effort）が変化した。 */
	onInfo(): void;
	/** Claude transcriptのephemeral progress行を受けた。履歴には追加しない。 */
	onProgress(progress: ITranscriptProgress): void;
	/** ライブ追記でターン終了（task_complete / error / turn_aborted）を検出した。 */
	onTurnEnded(reason: 'completed' | 'failed' | 'interrupted'): void;
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
	/** 初回読み込みが完了したら resolve (attach応答はこれを待つ)。 */
	readonly ready: Promise<void>;

	private offset = 0;
	private remainder = '';
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
		const effortLevel = str(rec(JSON.parse(raw))?.['effortLevel']);
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
			let text = this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
			if (start > 0) {
				// 途中から読んだ場合、最初の不完全行を捨てる
				const firstNewline = text.indexOf('\n');
				text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
			}
			this.offset = start + bytesRead;
			// ここまで来て初めて「現在の末尾」を掴めた。open に失敗した回はここを通らず
			// offset が 0 のままなので、次の読みは追記ではなく全文の読み直しになる。
			this.sawInitialEof = true;
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
				// offset 0 から読み直すので、前のバイト境界を持ち越したデコーダは捨てる。
				this.decoder = new TextDecoder();
				this.initialTruncated = false;
				this.backgroundTasks.clear();
				this.pendingQuestions.clear();
				this.pendingApproval = undefined;
				this.lastApprovalKey = undefined;
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
		this.remainder = (lines.pop() ?? '').slice(-MAX_TRANSCRIPT_LINE_BYTES);
		// fullText / imageData はここでだけ通過する（この直後に退避して送信対象から外す）。
		const added: (IParadisAgentChatMessage & { fullText?: string; imageData?: readonly IFlattenedImage[] })[] = [];
		const signals = newParseSignals();
		let latestProgress: ITranscriptProgress | undefined;
		let issueUrlsChanged = false;
		for (const line of lines) {
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
				const progress = parseClaudeProgress(obj);
				if (progress !== undefined) {
					latestProgress = progress;
					continue;
				}
			}
			const raw = this.agent === 'claude' ? parseClaudeLine(obj, signals) : parseCodexLine(obj, signals);
			for (const message of raw) {
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
							added.push({ ...message, toolUseId: syntheticId, rev: this.rev++ });
						}
						continue;
					}
				}
				added.push({ ...message, rev: this.rev++ });
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
		this.applySignals(signals, emitDelta);
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
		if (this.messages.length > MESSAGE_RING_LIMIT) {
			this.messages.splice(0, this.messages.length - MESSAGE_RING_LIMIT);
		}
		if (emitDelta) {
			this.delegate.onDelta(added);
		}
	}

	/** 直近に注入した承認要求の内容キー（PermissionRequest hookの再発火による重複注入の抑止）。 */
	private lastApprovalKey: string | undefined;
	private pendingApproval: Extract<IParadisAgentInteraction, { readonly kind: 'approval' }> | undefined;
	private approvalSeq = 0;

	/**
	 * PermissionRequest hook で受けた承認要求の内容（ツール名・コマンド等）を表示カードとして
	 * 注入する。Codex は承認要求を rollout に一切書かず、Claude もプロンプト表示中は
	 * transcript に現れないため、hook が唯一のライブな供給源。モバイル側はこのメッセージの
	 * 内容を承認バー（許可/拒否）に添えて表示する。
	 */
	injectApprovalRequest(toolName: string | undefined, toolInput: unknown, toolUseId?: string): void {
		this.enqueue(async () => {
			// ここで pendingQuestions を見て注入自体を捨ててはいけない。PermissionRequest hook は
			// 1プロンプトにつき1回しか来ないため、落とすと承認要求が永久に復元されない。
			// AskUserQuestion 由来の二重カードは currentInteraction が質問を優先することで
			// 表示上隠れる（承認は解除されるまで保持しておく必要がある）。
			const input = rec(toolInput);
			const detail = str(input?.['description']) ?? str(input?.['command']) ?? (input !== undefined ? JSON.stringify(input) : '');
			const text = [toolName, detail].filter(v => v !== undefined && v.length > 0).join(': ');
			if (text.length === 0) {
				return;
			}
			const key = toolUseId !== undefined ? `${toolUseId}:${text}` : text;
			if (this.lastApprovalKey === key) {
				return; // 同一要求の再発火（リトライ等）は無視
			}
			const interactionId = toolUseId ?? `approval:${this.epoch}:${this.approvalSeq++}`;
			this.lastApprovalKey = key;
			this.pendingApproval = {
				kind: 'approval', id: interactionId, title: '操作の許可', detail: truncateText(text, TOOL_TEXT_LIMIT),
				choices: [
					{ id: 'yes', label: '許可', tone: 'approve' },
					{ id: 'no', label: '拒否', tone: 'deny' },
				],
			};
			const message: IParadisAgentChatMessage = {
				role: 'assistant', kind: 'tool_use', tool: 'approval_request',
				text: truncateText(text, TOOL_TEXT_LIMIT), ts: Date.now(), rev: this.rev++, toolUseId: interactionId,
			};
			this.messages.push(message);
			if (this.messages.length > MESSAGE_RING_LIMIT) {
				this.messages.splice(0, this.messages.length - MESSAGE_RING_LIMIT);
			}
			this.delegate.onDelta([message]);
			this.delegate.onActivity();
		});
	}

	/** Codex app-server由来の構造化された承認要求を、その選択肢を失わず表示する。 */
	injectCodexApprovalRequest(interaction: IParadisCodexApprovalInteraction): void {
		this.enqueue(async () => {
			if (this.pendingApproval?.id === interaction.id) { return; }
			const hadApproval = this.pendingApproval !== undefined;
			this.pendingApproval = interaction;
			this.lastApprovalKey = `codex:${interaction.id}`;
			if (hadApproval) {
				// hook経路が先着していた場合はカードだけ正式な選択肢へ置換し、履歴を重複させない。
				this.delegate.onDelta([]);
				this.delegate.onActivity();
				return;
			}
			const message: IParadisAgentChatMessage = {
				role: 'assistant', kind: 'tool_use', tool: 'approval_request', text: truncateText(interaction.detail || interaction.title, TOOL_TEXT_LIMIT),
				ts: Date.now(), rev: this.rev++, toolUseId: interaction.id,
			};
			this.messages.push(message);
			if (this.messages.length > MESSAGE_RING_LIMIT) {
				this.messages.splice(0, this.messages.length - MESSAGE_RING_LIMIT);
			}
			this.delegate.onDelta([message]);
			this.delegate.onActivity();
		});
	}

	/**
	 * 承認内容を同期できないときの案内カードを出す。
	 *
	 * replaceExisting は app-server との接続が切れた場合に使う。切断で app-server 側の
	 * pendingApprovals は捨てられるため、構造化された承認カード（codex:<thread>:<id>）を
	 * 残したままにすると、押しても daemon 経路に乗らず必ず失敗する。
	 */
	injectCodexApprovalFallback(threadId: string, replaceExisting = false): void {
		this.enqueue(async () => {
			const fallbackId = `codex-status:${threadId}`;
			// replaceExisting は「今ある daemon 承認を案内カードへ差し替える」モード。判定は必ず
			// キューの内側で行う（呼び出し側で同期に覗くと、先にキューへ積まれた解決処理が
			// まだ走っておらず、既に回答済みの承認に対して案内カードを生やしてしまう）。
			if (replaceExisting && this.pendingApproval === undefined) {
				return;
			}
			if (this.pendingApproval !== undefined
				&& (!replaceExisting || this.pendingApproval.id === fallbackId || !paradisIsCodexDaemonApprovalInteraction(this.pendingApproval.id))) {
				return;
			}
			this.pendingApproval = {
				kind: 'approval', id: fallbackId, title: 'Codexが許可を待っています',
				detail: '承認内容を同期できませんでした。PCのCodex画面で確認してください。', choices: [],
			};
			this.lastApprovalKey = fallbackId;
			this.delegate.onDelta([]);
			this.delegate.onActivity();
		});
	}

	clearApprovalRequest(toolUseId: string | undefined, force: boolean): void {
		this.enqueue(async () => {
			if (this.pendingApproval === undefined || (!force && (toolUseId === undefined || this.pendingApproval.id !== toolUseId))) {
				return;
			}
			this.pendingApproval = undefined;
			this.lastApprovalKey = undefined;
			this.delegate.onDelta([]);
			this.delegate.onActivity();
		});
	}

	clearCodexApprovalRequest(interactionId?: string): void {
		this.enqueue(async () => {
			if (this.pendingApproval === undefined || (interactionId !== undefined && this.pendingApproval.id !== interactionId)) { return; }
			this.pendingApproval = undefined;
			this.lastApprovalKey = undefined;
			this.delegate.onDelta([]);
			this.delegate.onActivity();
		});
	}

	currentInteraction(): IParadisAgentInteraction | null {
		return paradisPickCurrentInteraction(this.messages, this.pendingQuestions, this.pendingApproval);
	}

	/**
	 * 承認要求が回答待ちかどうか。currentInteraction は質問を優先して承認を隠すため、
	 * 「承認が存在するか」という事実が必要な箇所（ペイン状態の補正など）はこちらを使う。
	 */
	hasPendingApproval(): boolean {
		return this.pendingApproval !== undefined;
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
	 * 質問プッシュ通知も発火する。
	 */
	injectLiveQuestions(input: unknown): void {
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
			if (this.pendingApproval !== undefined && !paradisIsCodexDaemonApprovalInteraction(this.pendingApproval.id)) {
				this.pendingApproval = undefined;
				this.lastApprovalKey = undefined;
			}
			this.messages.push(...added);
			if (this.messages.length > MESSAGE_RING_LIMIT) {
				this.messages.splice(0, this.messages.length - MESSAGE_RING_LIMIT);
			}
			this.delegate.onDelta(added);
			this.delegate.onActivity();
		});
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
		if (activityChanged) {
			this.delegate.onActivity();
		}
		if (infoChanged) {
			this.delegate.onInfo();
		}
		if (signals.codexActivityTimeline.length > 0) { this.delegate.onCodexActivityTimeline(signals.codexActivityTimeline); }
		// ターン終了はライブ追記でのみ通知する（初回読み込み・epoch読み直しの履歴に含まれる
		// 過去の task_complete で、現在進行中のライブ状態を消してしまわないように）。
		if (live && signals.turnEnded !== undefined) {
			this.delegate.onTurnEnded(signals.turnEnded);
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

/** pane session集合を、Mobileのsocket別Codex購読ターゲットへ正規化する。 */
export function paradisCodexThreadTargetsForPaneSessions(
	sessions: Iterable<readonly [string, Pick<IPaneSessionInfo, 'agent' | 'sessionId'>]>,
	socketPathResolver: (token: string) => string | undefined,
): readonly IParadisCodexThreadTarget[] {
	const targetsByThread = new Map<string, IParadisCodexThreadTarget>();
	for (const [token, session] of sessions) {
		if (session.agent !== 'codex' || session.sessionId === undefined || session.sessionId.length === 0) {
			continue;
		}
		const socketPath = socketPathResolver(token);
		if (socketPath !== undefined) {
			targetsByThread.set(session.sessionId, { threadId: session.sessionId, socketPath });
		}
	}
	return [...targetsByThread.values()];
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

	/** ペイントークン → 既知のセッション情報 (hookバスから学習、購読の有無に関わらず保持)。 */
	private readonly paneSessions = new Map<string, IPaneSessionInfo>();
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
	/** daemonが確認した次ターンのCodexモデル設定。transcriptの直近ターン値より優先表示する。 */
	private readonly codexThreadSettings = new Map<string, IParadisCodexThreadSettings>();
	/** tokenごとにhookの検証と反映を受信順へ直列化する。 */
	private readonly hookProcessing = new Map<string, Promise<void>>();
	/** ペイン同期より先着したhook。質問など一度しか来ないイベントを順序付きで保持する。 */
	private readonly pendingHooks = new Map<string, { readonly event: IParadisAgentHookEvent; readonly transcriptPath: string; readonly receivedAt: number }[]>();
	private readonly pendingHookTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly codexLiveClient: ParadisCodexLiveClient;
	/** ペアリング済みモバイル向けのライブ質問/承認注入を有効にする。status用tailは常時動作する。 */
	private eagerTailing = false;
	private readonly pendingActions = new Map<string, { readonly mobileId: string; readonly token: string; readonly epoch: string; readonly terminalId: number; readonly windowId: number; readonly windowSession: string; readonly interaction?: IParadisAgentInteraction; readonly interactionKey?: string; readonly requirePrompt?: boolean; readonly timer: ReturnType<typeof setTimeout> }>();
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
		private readonly codexSocketPathResolver?: (token: string) => string | undefined,
		private readonly authorizeOwner: (owner: IParadisMobilePaneOwner) => Promise<boolean> = async () => true,
		private readonly requestPaneSync: (owner: IParadisMobilePaneOwner) => void = () => { },
		private readonly sessionStore?: ParadisAgentSessionStore,
		/** SSH 接続先の transcript を手元へ写す台帳。無ければ接続先の会話は読まないだけ。 */
		private readonly remoteTranscriptMirror?: ParadisRemoteTranscriptMirrorStore,
		codexDirectoryWalkBudget?: IParadisDirectoryWalkBudget,
	) {
		super();
		this.codexDirectoryWalkLedger = codexDirectoryWalkBudget ?? new ParadisDirectoryWalkLedger(PARADIS_CODEX_DIRECTORY_WALK_INTERVAL_MS, PARADIS_CODEX_DIRECTORY_WALK_LIMIT);
		this.codexLiveClient = this._register(new ParadisCodexLiveClient(event => this.onCodexDaemonEvent(event), this.logService));
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

	/** Codex pane app-server購読の有効/無効（renderer設定から同期）。 */
	setCodexDaemonEnabled(enabled: boolean): void {
		this.codexLiveClient.setEnabled(enabled);
		this.syncCodexDaemonThreads();
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
		}
	}

	private readonly paneRegistry = new ParadisMobilePaneRegistry();
	/** mobileId + requestId → 対象ペイン。設定ファイル走査の重複と濫用を抑止する。 */
	private readonly commandCatalogRequests = new Map<string, string>();

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
			if (!liveTokens.has(token)) { this.onCliCommandFinished(token); this.cliDiscoveryGenerations.delete(token); }
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
				this.codexThreadSettings.delete(token);
				this.activityTrackers.delete(token);
				this.clearClaudeSubagentTranscripts(token);
				this.activeTurnTokens.delete(token);
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
		for (const token of liveTokens) {
			if (!this.paneSessions.has(token) && this.retiredSessions.has(token)) {
				this.reviveRetiredSession(token);
			}
		}
		this.persistSessions();
		this.syncCodexDaemonThreads();
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
				this.syncCodexDaemonThreads();
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
		const generation = (this.cliDiscoveryGenerations.get(token) ?? 0) + 1;
		this.cliDiscoveryGenerations.set(token, generation);
		// resume 直後は既存transcriptへの追記になるため、開始時刻より少し手前まで許容する。
		const minMtime = Date.now() - 15_000;
		this.cliReconciliationWatermarks.set(token, minMtime);
		// 共有daemonは起動済みthreadのrollout初回flushが遅れることがあるため、短い即時探索に
		// 加えて30秒・60秒でも再確認する。鮮度ガードは維持されるので、待機を延ばしても
		// コマンド開始前の古いセッションを誤って拾うことはない。
		for (const delayMs of [2_000, 6_000, 15_000, 30_000, 60_000]) {
			const timer = setTimeout(() => {
				const timers = this.cliDiscoveryTimers.get(token);
				timers?.delete(timer);
				if (timers?.size === 0) {
					this.cliDiscoveryTimers.delete(token);
				}
				if (this.cliDiscoveryGenerations.get(token) !== generation) {
					return;
				}
				this.discoverAndNotify(token, agent, mode, effectiveCwd, minMtime, generation, sessionId).catch(err => this.logService.warn('[paradisAgentChat] discovery on cli command failed', err));
			}, delayMs);
			let timers = this.cliDiscoveryTimers.get(token);
			if (timers === undefined) {
				timers = new Set();
				this.cliDiscoveryTimers.set(token, timers);
			}
			timers.add(timer);
		}
		const previousReconciliation = this.cliReconciliationTimers.get(token);
		if (previousReconciliation !== undefined) { clearInterval(previousReconciliation); }
		// TUI内の /resume はshell commandを再発火しない。hookが無い環境でも、CLIが
		// 実行中の間だけroot threadの一意な更新を追跡してsession切替を検出する。
		const reconciliation = setInterval(() => {
			if (this.cliDiscoveryGenerations.get(token) !== generation || !this.isLiveToken(token)) { return; }
			const watermark = this.cliReconciliationWatermarks.get(token) ?? minMtime;
			this.discoverAndNotify(token, agent, 'resume', effectiveCwd, watermark, generation)
				.catch(err => this.logService.warn('[paradisAgentChat] cli session reconciliation failed', err));
		}, 5_000);
		this.cliReconciliationTimers.set(token, reconciliation);
	}

	onCliCommandFinished(token: string): void {
		this.cancelCliDiscovery(token);
		this.cliDiscoveryGenerations.set(token, (this.cliDiscoveryGenerations.get(token) ?? 0) + 1);
		this.activeTurnTokens.delete(token);
		fireParadisAgentTurnEnded(token);
		const timer = this.cliReconciliationTimers.get(token);
		if (timer !== undefined) { clearInterval(timer); this.cliReconciliationTimers.delete(token); }
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
			case 'action/answerApproval':
				this.handleApprovalAction(mobileId, msg);
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
				? await this.readCodexSubagentMessages(token, msg.activityId, session.sessionId)
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

	private static codexDetailMessage(message: IParadisCodexThreadMessage): IParadisAgentActivityDetailMessage {
		return message;
	}

	private async readCodexSubagentMessages(token: string, activityId: string, ownerThreadId: string | undefined): Promise<readonly IParadisAgentActivityDetailMessage[]> {
		try {
			return (await this.codexLiveClient.readThreadMessages(activityId, ownerThreadId)).map(ParadisMobileAgentChat.codexDetailMessage);
		} catch {
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

	private handleSendMessageAction(mobileId: string, msg: Extract<AgentInbound, { t: 'action/sendMessage' }>): void {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const session = token !== undefined ? this.paneSessions.get(token) : undefined;
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		const owner = token !== undefined ? this.ownerForPane(msg.id, token) : undefined;
		const key = this.actionKey(mobileId, msg.requestId);
		if (token === undefined || session === undefined || tailer === undefined || tailer.epoch !== msg.epoch || owner === undefined || !this.hasSubscriber(token, mobileId) || this.pendingActions.has(key) || this.completedActions.has(key)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'stale-session', message: '操作対象のエージェントセッションが変わりました' }, token ?? msg.token);
			return;
		}
		const timer = setTimeout(() => {
			if (this.pendingActions.delete(key)) {
				this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'action-timeout', message: '操作対象のウィンドウが応答しませんでした' }, token);
			}
		}, 5_000);
		this.pendingActions.set(key, { mobileId, token, epoch: msg.epoch, terminalId: msg.id, windowId: owner.windowId, windowSession: owner.windowSession, timer });
		this.requestAction(mobileId, owner.windowId, owner.windowSession, owner.rendererGeneration, encoder.encode(JSON.stringify({ ...msg, token, windowId: owner.windowId })));
	}

	private handleClaudeSettingAction(mobileId: string, msg: Extract<AgentInbound, { t: 'action/claudeSetting' }>): void {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const session = token !== undefined ? this.paneSessions.get(token) : undefined;
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		const owner = token !== undefined ? this.ownerForPane(msg.id, token) : undefined;
		const key = this.actionKey(mobileId, msg.requestId);
		if (token === undefined || session?.agent !== 'claude' || tailer === undefined || tailer.epoch !== msg.epoch || owner === undefined
			|| !this.hasSubscriber(token, mobileId) || !this.isAgentPrompt(token, tailer) || this.pendingActions.has(key) || this.completedActions.has(key)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'not-at-prompt', message: 'Claude Codeが入力待ちの時だけ設定を変更できます' }, token ?? msg.token);
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
		const answersMatch = questions.length === msg.answers.length && msg.answers.every((answer, index) => {
			const question = questions[index];
			const optionCount = question?.options?.length ?? 0;
			if (answer.kind === 'option') { return question?.multiSelect !== true && answer.index < optionCount; }
			if (answer.kind === 'multi') { return question?.multiSelect === true && answer.indices.every(value => value < optionCount); }
			return answer.optionCount === optionCount;
		});
		if (!answersMatch) {
			this.recordQuestionAnswerShape(token, msg, questions, 0, 'rejected-mismatch');
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'invalid-answer', message: '質問の選択肢が更新されました' }, token ?? msg.token);
			return;
		}
		const parts = paradisAgentQuestionKeySequence(
			questions.map(question => ({ optionCount: question.options?.length ?? 0, multiSelect: question.multiSelect === true })),
			msg.answers,
		);
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
		if (session?.agent === 'codex' && token !== undefined && session.sessionId !== undefined && this.codexLiveClient.hasPendingApproval(session.sessionId, msg.interactionId)) {
			this.handleCodexApprovalAction(mobileId, msg, token, session.sessionId).catch(error => {
				this.logService.warn('[paradisAgentChat] Codex approval action failed', error);
			});
			return;
		}
		if (paradisIsCodexDaemonApprovalInteraction(msg.interactionId)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'stale-interaction', message: 'この承認要求はすでに完了しています' }, token ?? msg.token);
			return;
		}
		const agent = session?.agent;
		const parts = agent === 'codex'
			? [msg.choice === 'yes' ? 'y' : 'd']
			: msg.choice === 'yes' ? ['1', '\r'] : ['\u001b'];
		if (msg.choice !== 'yes' && msg.choice !== 'no') {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'invalid-answer', message: '承認の選択肢が更新されました' }, token ?? msg.token);
			return;
		}
		this.dispatchInteractionAction(mobileId, msg, { kind: 'approval', id: msg.interactionId }, parts);
	}

	private async handleCodexApprovalAction(
		mobileId: string,
		msg: Extract<AgentInbound, { t: 'action/answerApproval' }>,
		token: string,
		threadId: string,
	): Promise<void> {
		const tailer = this.tailers.get(token);
		const interaction = tailer?.currentInteraction();
		const owner = this.ownerForPane(msg.id, token);
		const key = this.actionKey(mobileId, msg.requestId);
		const interactionKey = `${token}\0${msg.epoch}\0approval\0${msg.interactionId}`;
		if (tailer?.epoch !== msg.epoch || interaction?.kind !== 'approval' || interaction.id !== msg.interactionId
			|| owner === undefined || !this.hasSubscriber(token, mobileId) || this.interactionClaims.has(interactionKey)
			|| this.pendingActions.has(key) || this.completedActions.has(key)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'stale-interaction', message: '回答対象の承認要求が変わりました' }, token);
			return;
		}
		if (!await this.authorizeOwner(owner)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'stale-interaction', message: '操作対象のウィンドウが切り替わりました' }, token);
			return;
		}
		const currentOwner = this.ownerForPane(msg.id, token);
		if (currentOwner === undefined || !this.samePaneOwner(owner, currentOwner)
			|| tailer.epoch !== msg.epoch || !tailer.hasPendingInteraction(interaction)
			|| !this.hasSubscriber(token, mobileId) || this.interactionClaims.has(interactionKey)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'stale-interaction', message: '回答対象の承認要求が変わりました' }, token);
			return;
		}
		const timer = setTimeout(() => {
			if (this.pendingActions.delete(key)) {
				this.releaseInteractionClaim(interactionKey, key);
				this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'action-timeout', message: 'Codexへ承認結果を送信できませんでした' }, token);
			}
		}, 5_000);
		this.interactionClaims.set(interactionKey, key);
		this.pendingActions.set(key, { mobileId, token, epoch: msg.epoch, terminalId: msg.id, windowId: owner.windowId, windowSession: owner.windowSession, interaction, interactionKey, timer });
		try {
			await this.codexLiveClient.answerApproval(threadId, msg.interactionId, msg.choice);
			const pending = this.pendingActions.get(key);
			if (pending === undefined) { return; }
			clearTimeout(pending.timer);
			this.pendingActions.delete(key);
			const completedTimer = setTimeout(() => {
				const completed = this.completedActions.get(key);
				this.completedActions.delete(key);
				this.releaseInteractionClaim(completed?.interactionKey, key);
			}, 60_000);
			this.completedActions.set(key, { token, epoch: msg.epoch, terminalId: msg.id, windowId: owner.windowId, windowSession: owner.windowSession, interaction, interactionKey, timer: completedTimer });
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'accepted' }, token);
		} catch (error) {
			const pending = this.pendingActions.get(key);
			if (pending === undefined) { return; }
			clearTimeout(pending.timer);
			this.pendingActions.delete(key);
			this.releaseInteractionClaim(interactionKey, key);
			const normalized = error instanceof ParadisCodexControlError
				? { code: error.code, message: error.message }
				: { code: 'unavailable', message: 'Codexへ承認結果を送信できませんでした' };
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', ...normalized }, token);
		}
	}

	private dispatchInteractionAction(
		mobileId: string,
		msg: Extract<AgentInbound, { t: 'action/answerQuestion' | 'action/answerApproval' }>,
		interaction: IParadisAgentInteraction,
		parts: readonly string[],
		readyMarker?: string,
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

	private codexControlSession(mobileId: string, terminalId: number, paneToken?: string): { readonly token: string; readonly threadId: string; readonly owner: IParadisMobilePaneOwner } | undefined {
		const token = this.resolveInboundToken(terminalId, paneToken);
		const session = token !== undefined ? this.paneSessions.get(token) : undefined;
		const owner = token !== undefined ? this.ownerForPane(terminalId, token) : undefined;
		if (token === undefined || session?.agent !== 'codex' || session.sessionId === undefined || owner === undefined || !this.hasSubscriber(token, mobileId)) {
			return undefined;
		}
		return { token, threadId: session.sessionId, owner };
	}

	private async handleModelCatalogRequest(mobileId: string, msg: { readonly id: number; readonly token?: string; readonly requestId: string }): Promise<void> {
		const session = this.codexControlSession(mobileId, msg.id, msg.token);
		if (session === undefined) {
			this.sendControlError(mobileId, msg.id, msg.requestId, new ParadisCodexControlError('unavailable', '操作対象のCodexセッションを確認できません'), msg.token);
			return;
		}
		try {
			if (!await this.authorizeOwner(session.owner)) {
				throw new ParadisCodexControlError('unavailable', '操作対象のウィンドウが切り替わりました');
			}
			const models = await this.codexLiveClient.listModels(session.threadId);
			const current = this.codexControlSession(mobileId, msg.id, msg.token);
			if (current?.token !== session.token || current.threadId !== session.threadId || !this.samePaneOwner(current.owner, session.owner)) {
				throw new ParadisCodexControlError('unavailable', '操作対象のCodexセッションが切り替わりました');
			}
			this.sendTo(mobileId, { t: 'model-catalog', id: msg.id, requestId: msg.requestId, models }, session.token, session.owner);
		} catch (error) {
			this.sendControlError(mobileId, msg.id, msg.requestId, error, session.token, session.owner);
		}
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

			const commands = await paradisBuildAgentCommandCatalog(session.agent, cwd);
			const currentOwner = this.ownerForPane(msg.id, token);
			if (this.paneSessions.get(token) !== session || this.tokenToCwd.get(token) !== cwd || currentOwner === undefined
				|| !this.samePaneOwner(currentOwner, owner) || !this.hasSubscriber(token, mobileId) || !await this.authorizeOwner(owner)) {
				this.sendCommandCatalogError(mobileId, msg, '対象セッションが切り替わりました');
				return;
			}
			if (!await this.sendToAuthorized(mobileId, { t: 'command-catalog', id: msg.id, requestId: msg.requestId, commands }, token, owner)) {
				this.sendCommandCatalogError(mobileId, msg, '対象セッションが切り替わりました');
			}
		} catch {
			this.sendCommandCatalogError(mobileId, msg, 'コマンド一覧を取得できませんでした');
		} finally {
			this.commandCatalogRequests.delete(requestKey);
		}
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

	private async handleSettingsUpdateRequest(mobileId: string, msg: { readonly id: number; readonly token?: string; readonly requestId: string; readonly model: string; readonly effort: string }): Promise<void> {
		const session = this.codexControlSession(mobileId, msg.id, msg.token);
		if (session === undefined) {
			this.sendControlError(mobileId, msg.id, msg.requestId, new ParadisCodexControlError('unavailable', '操作対象のCodexセッションを確認できません'), msg.token);
			return;
		}
		if (!await this.authorizeOwner(session.owner)) {
			this.sendTo(mobileId, { t: 'settings-update', id: msg.id, requestId: msg.requestId, status: 'failed', code: 'stale-session', message: '操作対象のウィンドウが切り替わりました' }, session.token);
			return;
		}
		if (!await this.sendToAuthorized(mobileId, { t: 'settings-update', id: msg.id, requestId: msg.requestId, status: 'pending' }, session.token, session.owner)) {
			return;
		}
		try {
			const settings = await this.codexLiveClient.updateThreadSettings(session.threadId, msg.model, msg.effort);
			const current = this.codexControlSession(mobileId, msg.id, msg.token);
			if (current?.token !== session.token || current.threadId !== session.threadId || !this.samePaneOwner(current.owner, session.owner) || !await this.authorizeOwner(current.owner)) {
				this.sendTo(mobileId, { t: 'settings-update', id: msg.id, requestId: msg.requestId, status: 'failed', code: 'stale-session', message: '操作対象のCodexセッションが切り替わりました' }, current?.token ?? session.token);
				return;
			}
			this.codexThreadSettings.set(session.token, settings);
			this.pushInfoToSubscribers(session.token);
			const info = { model: settings.model, ...(settings.effort !== undefined ? { effort: settings.effort } : {}) };
			this.sendTo(mobileId, { t: 'settings-update', id: msg.id, requestId: msg.requestId, status: 'confirmed', info }, session.token, session.owner);
		} catch (error) {
			const normalized = ParadisMobileAgentChat.controlError(error);
			const current = this.codexControlSession(mobileId, msg.id, msg.token);
			this.sendTo(mobileId, {
				t: 'settings-update', id: msg.id, requestId: msg.requestId, status: 'failed',
				code: current?.token === session.token && current.threadId === session.threadId ? normalized.code : 'stale-session', message: current?.token === session.token && current.threadId === session.threadId ? normalized.message : '操作対象のCodexセッションが切り替わりました',
			}, session.token, session.owner);
		}
	}

	private sendControlError(mobileId: string, terminalId: number, requestId: string, error: unknown, token?: string, owner?: IParadisMobilePaneOwner): void {
		const normalized = ParadisMobileAgentChat.controlError(error);
		this.sendTo(mobileId, { t: 'model-control-error', id: terminalId, requestId, code: normalized.code, message: normalized.message }, token, owner);
	}

	private samePaneOwner(a: IParadisMobilePaneOwner, b: IParadisMobilePaneOwner): boolean {
		return a.windowId === b.windowId && a.windowSession === b.windowSession && a.rendererGeneration === b.rendererGeneration
			&& a.terminalId === b.terminalId && a.token === b.token;
	}

	private static controlError(error: unknown): { readonly code: string; readonly message: string } {
		if (error instanceof ParadisCodexControlError) {
			return { code: error.code, message: error.message };
		}
		return { code: 'unavailable', message: 'Codexのモデル設定を更新できませんでした' };
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
				this.sendTo(mobileId, { t: 'delta', id: msg.id, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages, ...(info !== undefined ? { info } : {}), live, liveRevision, activity, interaction, capabilities: { agentActions: true, ...(tailer.agent === 'claude' ? { claudeSettings: true } : {}) } }, token, owner);
			} else {
				const messages = tailer.messages.slice(-SNAPSHOT_SEND_LIMIT);
				this.sendTo(mobileId, {
					t: 'snapshot', id: msg.id, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages,
					...(tailer.wasInitialTruncated || tailer.messages.length > messages.length ? { truncated: true } : {}),
					...(info !== undefined ? { info } : {}),
					live, liveRevision, activity, interaction, capabilities: { agentActions: true, ...(tailer.agent === 'claude' ? { claudeSettings: true } : {}) },
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
	}

	private clearLiveState(token: string): void {
		const hadState = this.liveStates.delete(token);
		this.liveToolIds.delete(token);
		this.liveMessageBuffers.delete(token);
		if (hadState) {
			const revision = (this.liveRevisions.get(token) ?? 0) + 1;
			this.liveRevisions.set(token, revision);
			this.pushFullLiveToSubscribers(token, null, revision);
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
		this.clearLiveState(event.token);
		const tracker = this.activityTrackers.get(event.token);
		const activityEnded = event.event === 'SessionEnd'
			? tracker?.endSession('interrupted', event.at) === true
			: tracker?.endTurn(event.at) === true;
		if (activityEnded) {
			this.pushActivityToSubscribers(event.token);
		}
		const tailer = this.tailers.get(event.token);
		tailer?.clearApprovalRequest(undefined, true);
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

	/** pane app-serverへ購読させるのは、hookまたはrolloutメタ情報でthread IDを確定できたCodexセッションだけ。 */
	private syncCodexDaemonThreads(): void {
		this.codexLiveClient.setThreads(paradisCodexThreadTargetsForPaneSessions(
			this.paneSessions,
			token => this.codexSocketPathResolver?.(token),
		));
	}

	/** Codex daemonの通知を対応するペインの置換型ライブ状態へ投影する。 */
	private onCodexDaemonEvent(event: IParadisCodexDaemonEvent): void {
		for (const [token, session] of this.paneSessions) {
			if (session.agent === 'codex' && session.sessionId === event.threadId) {
				this.applyCodexDaemonEvent(token, event);
			}
		}
	}

	private applyCodexDaemonEvent(token: string, event: IParadisCodexDaemonEvent): void {
		const now = Date.now();
		const session = this.paneSessions.get(token);
		const tailer = session !== undefined ? this.ensureTailer(token, session) : undefined;
		if (event.approval !== undefined) {
			if (event.method === 'serverRequest/resolved') {
				tailer?.clearCodexApprovalRequest(event.approval.id);
				this.releaseInteractionClaimsFor(token, event.approval.id);
				this.clearLiveState(token);
			} else {
				tailer?.injectCodexApprovalRequest(event.approval);
				this.setLiveState(token, {
					phase: 'tool', source: 'codex-daemon', startedAt: now, updatedAt: now,
					tool: 'approval_request', detail: event.approval.detail || event.approval.title,
				});
			}
			return;
		}
		if (event.method === 'thread/status/changed') {
			const status = rec(event.params['status']);
			const flags = status?.['activeFlags'];
			const waiting = Array.isArray(flags) && flags.includes('waitingOnApproval');
			if (waiting) {
				tailer?.injectCodexApprovalFallback(event.threadId);
			} else {
				tailer?.clearCodexApprovalRequest(`codex-status:${event.threadId}`);
				this.releaseInteractionClaimsFor(token, `codex-status:${event.threadId}`);
			}
		}
		if (this.activityTracker(token).applyCodex(event.method, event.params, now)) {
			this.pushActivityToSubscribers(token);
		}
		const activityItem = rec(event.params['item']);
		if (str(activityItem?.['type']) === 'subAgentActivity') {
			const activityId = str(activityItem?.['agentThreadId']);
			if (activityId !== undefined) { this.enrichCodexActivityRelationship(token, activityId, now).catch(() => { /* state DB未反映中は次イベントで再試行 */ }); }
		}
		if (event.method === 'thread/settings/updated') {
			const settings = rec(event.params['threadSettings']);
			const model = str(settings?.['model']);
			const effort = str(settings?.['effort']);
			if (model !== undefined) {
				this.codexThreadSettings.set(token, { model, ...(effort !== undefined ? { effort } : {}) });
				this.pushInfoToSubscribers(token);
			}
			return;
		}
		if (event.method === 'turn/started') {
			this.activeTurnTokens.add(token);
			fireParadisAgentTurnStarted(token, this.tokenToCwd.get(token));
			if (this.activityTracker(token).beginTurn()) {
				this.pushActivityToSubscribers(token);
			}
			this.codexMessageBuffers.delete(token);
			this.codexActiveItems.delete(token);
			this.setLiveState(token, { phase: 'thinking', source: 'codex-daemon', startedAt: now, updatedAt: now });
			return;
		}
		if (event.method === PARADIS_CODEX_DAEMON_DISCONNECTED) {
			// app-server との接続が切れた。ターンが終わったのか単に経路が落ちたのかは区別
			// できないので、turn-ended は発火せず（偽の完了通知を避ける）、伸び続ける
			// 「応答を生成中」だけを「考え中」へ畳む。実際の完了は rollout の task_complete か、
			// それも来なければ live の staleness sweep が回収する。
			this.codexMessageBuffers.delete(token);
			this.codexActiveItems.delete(token);
			const disconnectedLive = this.liveStates.get(token);
			if (disconnectedLive?.phase === 'message') {
				this.setLiveState(token, {
					phase: 'thinking', source: 'codex-daemon', startedAt: disconnectedLive.startedAt, updatedAt: now,
				});
			}
			// app-server 側の pendingApprovals は切断で捨てられるため、構造化された承認カードを
			// 残したままにすると押しても daemon 経路に乗らず必ず失敗する。PCで確認するよう促す
			// フォールバックカードへ差し替える（承認が残っているかの判定は tailer のキュー内側で行う。
			// 切断時は解決イベントが先にキューへ積まれるため、ここで同期に覗くと既に回答済みの
			// 承認に対して案内カードを出してしまう）。
			tailer?.injectCodexApprovalFallback(event.threadId, true);
			return;
		}
		if (event.method === 'turn/completed' || event.method === 'turn/failed' || event.method === 'turn/aborted') {
			this.activeTurnTokens.delete(token);
			fireParadisAgentTurnEnded(token);
			// turn/failed は usage limit 等のエラー中断（turn/completed が来ないため、
			// ここで解除しないと「考え中」表示が残り続ける）。
			this.codexMessageBuffers.delete(token);
			this.codexActiveItems.delete(token);
			tailer?.clearCodexApprovalRequest();
			this.releaseInteractionClaimsFor(token);
			this.clearLiveState(token);
			if (this.activityTracker(token).endTurn(now)) {
				this.pushActivityToSubscribers(token);
			}
			return;
		}
		if (event.method === 'item/started') {
			const item = rec(event.params['item']);
			const itemId = str(item?.['id']);
			const itemType = str(item?.['type']);
			const startedAt = num(event.params['startedAtMs']) ?? now;
			if (itemId !== undefined) {
				this.codexActiveItems.set(token, itemId);
			}
			if (itemType === 'agentMessage') {
				if (itemId !== undefined) {
					this.codexMessageBuffers.set(token, { itemId, text: '', startedAt });
				}
				this.setLiveState(token, { phase: 'message', source: 'codex-daemon', startedAt, updatedAt: now });
				return;
			}
			if (itemType === 'reasoning') {
				this.setLiveState(token, { phase: 'thinking', source: 'codex-daemon', startedAt, updatedAt: now });
				return;
			}
			const tool = ParadisMobileAgentChat.codexItemToolName(itemType, item);
			if (tool !== undefined) {
				const detail = ParadisMobileAgentChat.codexItemDetail(itemType, item);
				this.setLiveState(token, {
					phase: 'tool', source: 'codex-daemon', startedAt, updatedAt: now, tool,
					...(detail !== undefined ? { detail } : {}),
				});
			}
			return;
		}
		if (event.method === 'item/agentMessage/delta') {
			const itemId = str(event.params['itemId']);
			const delta = str(event.params['delta']);
			if (itemId === undefined || delta === undefined) {
				return;
			}
			const previous = this.codexMessageBuffers.get(token);
			const startedAt = previous?.itemId === itemId ? previous.startedAt : now;
			const text = truncateCodexLiveText((previous?.itemId === itemId ? previous.text : '') + delta);
			this.codexMessageBuffers.set(token, { itemId, text, startedAt });
			this.codexActiveItems.set(token, itemId);
			this.setLiveState(token, { phase: 'message', source: 'codex-daemon', startedAt, updatedAt: now, text });
			return;
		}
		if (event.method === 'item/reasoning/summaryTextDelta') {
			const delta = str(event.params['delta']);
			if (delta === undefined) {
				return;
			}
			const previous = this.liveStates.get(token);
			const detail = truncateCodexLiveText((previous?.phase === 'thinking' ? previous.detail ?? '' : '') + delta);
			this.setLiveState(token, {
				phase: 'thinking', source: 'codex-daemon', startedAt: previous?.phase === 'thinking' ? previous.startedAt : now,
				updatedAt: now, detail,
			});
			return;
		}
		if (event.method === 'item/commandExecution/outputDelta') {
			const itemId = str(event.params['itemId']);
			const delta = str(event.params['delta']);
			if (delta === undefined) {
				return;
			}
			const previous = this.liveStates.get(token);
			const detail = truncateCodexLiveText([previous?.detail, delta.trim()].filter((part): part is string => part !== undefined && part.length > 0).join('\n'));
			if (itemId !== undefined) {
				this.codexActiveItems.set(token, itemId);
			}
			this.setLiveState(token, {
				phase: 'tool', source: 'codex-daemon', startedAt: previous?.phase === 'tool' ? previous.startedAt : now,
				updatedAt: now, tool: previous?.tool ?? 'shell', ...(detail.length > 0 ? { detail } : {}),
			});
			return;
		}
		if (event.method === 'item/completed') {
			const item = rec(event.params['item']);
			const itemId = str(item?.['id']);
			if (itemId !== undefined && this.codexActiveItems.get(token) !== itemId) {
				return;
			}
			this.codexActiveItems.delete(token);
			const previous = this.liveStates.get(token);
			this.setLiveState(token, {
				phase: 'thinking', source: 'codex-daemon', startedAt: previous?.startedAt ?? now, updatedAt: now,
			});
		}
	}

	private static codexItemToolName(itemType: string | undefined, item: Record<string, unknown> | undefined): string | undefined {
		switch (itemType) {
			case 'commandExecution': return 'shell';
			case 'fileChange': return 'apply_patch';
			case 'webSearch': return 'web_search';
			case 'mcpToolCall': {
				const server = str(item?.['server']);
				const tool = str(item?.['tool']) ?? 'tool';
				return server !== undefined ? `mcp__${server}__${tool}` : tool;
			}
			case 'dynamicToolCall': return str(item?.['tool']) ?? 'tool';
			case 'collabAgentToolCall': return str(item?.['tool']) ?? 'agent';
			case 'sleep': return 'sleep';
			case 'imageView': return 'view_image';
			case 'imageGeneration': return 'image_generation';
			default: return undefined;
		}
	}

	private static codexItemDetail(itemType: string | undefined, item: Record<string, unknown> | undefined): string | undefined {
		const value = itemType === 'commandExecution' ? str(item?.['command'])
			: itemType === 'webSearch' ? str(item?.['query'])
				: itemType === 'imageView' ? str(item?.['path'])
					: itemType === 'collabAgentToolCall' ? str(item?.['prompt'])
						: undefined;
		return value !== undefined && value.length > 0 ? truncateText(value.replace(/\s+/g, ' '), 500) : undefined;
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
		if (session.agent === 'claude') {
			const owners = new Map<string, IParadisRecoveredAgentActivity>();
			const spawned = new Map<string, IParadisRecoveredAgentActivity>();
			const rememberSpawned = (agent: IParadisRecoveredAgentActivity) => {
				const previous = spawned.get(agent.id);
				if (previous === undefined || agent.updatedAt >= previous.updatedAt) { spawned.set(agent.id, agent); }
			};
			const rootStat = await fs.stat(session.transcriptPath).catch(() => undefined);
			const rootLines = await readPersistedTranscriptLines(session.transcriptPath);
			if (rootStat !== undefined) {
				for (const agent of paradisParseClaudePersistedActivity(undefined, rootLines, rootStat.mtimeMs, now).spawned) { rememberSpawned(agent); }
			}
			const files = await discoverClaudePersistedSubagentFiles(session.transcriptPath);
			for (const file of files) {
				const parsed = paradisParseClaudePersistedActivity(file.id, await readPersistedTranscriptLines(file.path), file.mtime, now, file.meta);
				if (parsed.owner !== undefined) { owners.set(file.id, parsed.owner); }
				for (const agent of parsed.spawned) { rememberSpawned(agent); }
				claudeTranscriptPaths.push({ id: file.id, path: file.path });
			}
			for (const id of new Set([...owners.keys(), ...spawned.keys()])) {
				const owner = owners.get(id);
				const spawn = spawned.get(id);
				if (owner === undefined) { if (spawn !== undefined) { recovered.push(spawn); } continue; }
				if (spawn === undefined) { recovered.push(owner); continue; }
				const explicitTerminal = spawn.status === 'completed' || spawn.status === 'failed' || spawn.status === 'interrupted';
				recovered.push({
					...owner,
					label: spawn.label !== 'SubAgent' ? spawn.label : owner.label,
					...(spawn.detail !== undefined ? { detail: spawn.detail } : {}),
					...(spawn.parentId !== undefined ? { parentId: spawn.parentId } : {}),
					...(spawn.depth !== undefined ? { depth: spawn.depth } : {}),
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
		if (bounded.length > 0 && this.activityTracker(token).mergeRecoveredAgents(bounded, now)) {
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
		// hook はペインの環境変数を継承したプロセスからしか届かない。届いた時点で
		// 「今このペインでエージェントが動いている」証拠になる（transcript の有無は問わない）。
		if (this.isLiveToken(event.token)) {
			this.rememberAgentEvidence(event.token);
		}
		// 印が付いていれば、このペインのエージェントは接続先で動いている。transcript の有無に
		// 関わらず覚えておく（手元のディスクを探しに行かせないための唯一の根拠になる）。
		if (event.remoteHostId !== undefined) {
			this.tokenToRemoteHost.set(event.token, { host: event.remoteHostId, at: Date.now() });
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
		this.enqueueHookEvent(event, transcriptPath, false);
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
		if (!this.isLiveToken(event.token)) {
			return;
		}
		const provider = event.nestedAgent
			?? (event.transcriptPath !== undefined && event.transcriptPath.length > 0 ? agentKindForPath(event.transcriptPath) : undefined);
		const key = event.sessionId ?? event.transcriptPath;
		if (provider === undefined || key === undefined || key.length === 0) {
			return;
		}
		if (this.activityTracker(event.token).applyNestedAgentHook(provider, key, event.event, event.at, str(event.payload?.['prompt']))) {
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
		const claimedByOthers = new Set([...this.transcriptClaims]
			.filter(([, owner]) => owner !== token)
			.map(([path]) => path));
		if (previous !== undefined) {
			claimedByOthers.add(previous.transcriptPath);
		}
		for (const path of additionalExcludedPaths ?? []) {
			claimedByOthers.add(path);
		}
		let exactSession = false;
		let discovered: { agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number } | undefined;
		if (agent === 'codex' && requestedSessionId !== undefined && /^[A-Za-z0-9._:-]{1,500}$/.test(requestedSessionId)) {
			const transcriptPath = await discoverCodexRootTranscriptByThreadId(requestedSessionId, paradisResolveAgentHomes(cwd));
			if (transcriptPath !== undefined && !claimedByOthers.has(transcriptPath)) {
				const stat = await fs.stat(transcriptPath).catch(() => undefined);
				if (stat !== undefined) {
					discovered = { agent: 'codex', transcriptPath, mtime: stat.mtimeMs, sessionId: requestedSessionId };
					exactSession = true;
				}
			}
		}
		discovered ??= await discoverSessionByCwd(cwd, agent, minMtime, claimedByOthers, mode, allowCodexDirectoryWalk, onCodexDirectoryWalk);
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
			this.clearClaudeSubagentTranscripts(token);
			this.activeTurnTokens.delete(token);
		}
		const session: IPaneSessionInfo = { token, agent: discovered.agent, transcriptPath: discovered.transcriptPath, sessionId: discovered.sessionId };
		this.paneSessions.set(token, session);
		this.retiredSessions.delete(token);
		this.persistSessions();
		this.transcriptClaims.set(discovered.transcriptPath, token);
		this.cliReconciliationWatermarks.set(token, Math.max(this.cliReconciliationWatermarks.get(token) ?? 0, discovered.mtime + 1));
		this.emitConfirmedAgentPanesIfChanged();
		this.syncCodexDaemonThreads();
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
		this.pendingHooks.delete(event.token);
		const pendingTimer = this.pendingHookTimers.get(event.token);
		if (pendingTimer !== undefined) {
			clearTimeout(pendingTimer);
			this.pendingHookTimers.delete(event.token);
		}
		const submittedPrompt = str(event.payload?.['prompt'])?.trimStart();
		const isLocalSettingCommand = event.event === 'UserPromptSubmit' && submittedPrompt !== undefined && /^\/(?:model|effort)\s+\S/.test(submittedPrompt);
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
			this.codexThreadSettings.delete(previousOwner);
			this.activityTrackers.delete(previousOwner);
			this.clearClaudeSubagentTranscripts(previousOwner);
			this.activeTurnTokens.delete(previousOwner);
			this.cancelCliDiscovery(previousOwner);
			this.cliDiscoveryGenerations.set(previousOwner, (this.cliDiscoveryGenerations.get(previousOwner) ?? 0) + 1);
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
		this.persistSessions();
		this.transcriptClaims.set(sessionTranscriptPath, event.token);
		this.emitConfirmedAgentPanesIfChanged();
		this.syncCodexDaemonThreads();

		// エージェント起動などでこのペインのセッションが初めて判明した
		// → 「セッションなし」表示のまま待っている購読者にスナップショットを送る。
		if (previous === undefined) {
			this.ensureEagerTailer(event.token, info);
			this.pushToSubscribers(event.token);
		} else if (previous.transcriptPath !== info.transcriptPath) {
			// 同じペインで別セッションが始まった (claude再起動・/clear・resume等でファイルが変わる)
			// → 稼働中の tailer を張り替え、購読者には新セッションのスナップショットを送り直す。
			this.codexThreadSettings.delete(event.token);
			this.activityTrackers.delete(event.token);
			this.clearClaudeSubagentTranscripts(event.token);
			this.activeTurnTokens.delete(event.token);
			this.disposeTailer(event.token);
			this.ensureEagerTailer(event.token, info);
			this.pushToSubscribers(event.token);
		}
		const subagentActivityId = event.event === 'SubagentStart' || event.event === 'SubagentStop' ? str(event.payload?.['agent_id']) : undefined;
		const subagentId = subagentActivityId !== undefined && PARADIS_CLAUDE_AGENT_ID_PATTERN.test(subagentActivityId) ? subagentActivityId : undefined;
		if (event.event === 'SubagentStop') {
			const agentTranscriptPath = str(event.payload?.['agent_transcript_path']);
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
		if (event.event === 'UserPromptSubmit' && !isLocalSettingCommand) {
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
		const activityPayload = event.payload !== undefined && claudeNestedAgentId !== undefined && event.payload['parent_agent_id'] === undefined
			? { ...event.payload, parent_agent_id: claudeNestedAgentId }
			: event.payload;
		const activityChanged = activityPayload !== undefined && this.activityTracker(event.token).applyClaude(event.event, activityPayload, event.at);
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
			&& (this.eagerTailing || this.subscribers.has(event.token))) {
			this.ensureTailer(event.token, this.paneSessions.get(event.token) ?? info).injectLiveQuestions(event.toolInput);
		}

		// 承認要求のライブ検出: Codex は承認要求を rollout に書かず、Claude もプロンプト
		// 表示中は transcript に現れないため、PermissionRequest hook の tool_name / tool_input
		// から内容カードを注入する（モバイルの承認バーに「何を承認するのか」を添える）。
		// AskUserQuestion は除外: 上の PreToolUse 経路が選択肢つき質問カードを注入済みで、
		// こちらも注入すると生JSONの承認カードが二重に出る（回答も質問カード側で完結する）。
		// tool_name が取れない PermissionRequest（旧CLI・パース失敗）でも、質問回答待ち中は
		// AskUserQuestion 由来とみなして注入しない（質問カードと承認カードの二重表示防止）。
		if (event.event === 'PermissionRequest' && event.toolName !== 'AskUserQuestion'
			&& !getParadisAgentPaneActivity(event.token).pendingQuestion
			&& (event.toolName !== undefined || event.toolInput !== undefined)
			&& (this.eagerTailing || this.subscribers.has(event.token))) {
			this.ensureTailer(event.token, this.paneSessions.get(event.token) ?? info).injectApprovalRequest(event.toolName, event.toolInput, event.toolUseId);
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

	/** daemonの次ターン設定を優先し、無ければtranscriptの直近ターン値を返す。 */
	private infoOf(token: string, tailer: TranscriptTailer): IParadisAgentSessionInfo | undefined {
		const settings = this.codexThreadSettings.get(token);
		const model = settings?.model ?? tailer.model;
		const effort = settings?.effort ?? tailer.effort;
		if (model === undefined && effort === undefined) {
			return undefined;
		}
		return {
			...(model !== undefined ? { model } : {}),
			...(effort !== undefined ? { effort } : {}),
		};
	}

	private pushInfoToSubscribers(token: string): void {
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
			setParadisAgentPaneActivity(token, {
				backgroundTasks: new Map(tailer.backgroundTasks),
				pendingQuestion: tailer.pendingQuestions.size > 0,
				// currentInteraction は質問を優先して承認を隠すため、ここは「承認が存在するか」の事実を渡す
				pendingApproval: tailer.hasPendingApproval(),
			});
		};
		const tailer = new TranscriptTailer(session.transcriptPath, session.agent, {
			onDelta: messages => {
				const live = this.liveStates.get(token);
				if (live?.phase === 'message' && live.final && messages.some(message => message.role === 'assistant' && message.kind === 'text')) {
					// MessageDisplayの最終バッチはtranscript本文が届くまで表示し、確定本文との二重表示を避ける。
					this.clearLiveState(token);
				}
				const terminalId = this.terminalIdForToken(token);
				if (terminalId !== undefined) {
					this.sendToSubscribers(token, { t: 'delta', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages, interaction: tailer.currentInteraction() });
				}
				// 質問の出現は購読の有無に関わらず通知へ流す（アプリを開いていないモバイルへの
				// プッシュ供給源。onDelta はライブ追記でのみ呼ばれるため過去分の再通知はない）。
				for (const message of messages) {
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
				const terminalId = this.terminalIdForToken(token);
				if (terminalId !== undefined) {
					const messages = tailer.messages.slice(-SNAPSHOT_SEND_LIMIT);
					const info = this.infoOf(token, tailer);
					this.sendToSubscribers(token, { t: 'snapshot', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages, ...(info !== undefined ? { info } : {}), live: this.liveStates.get(token) ?? null, liveRevision: this.liveRevisions.get(token) ?? 0, activity: this.activityTrackers.get(token)?.snapshot() ?? null, interaction: tailer.currentInteraction(), capabilities: { agentActions: true, ...(tailer.agent === 'claude' ? { claudeSettings: true } : {}) } });
				}
			},
			// この起動後に transcript が伸びた＝そのペインでエージェントが今も動いている。
			// hook が届かない構成（WSL のディストロの中）と、質問を出したまま止まっていた
			// セッションを、鮮度の推測を持ち込まずに引き継ぎ扱いから解くための唯一の経路。
			onAppended: () => this.rememberAgentEvidence(token),
			// ワークスペース一覧のIssueマーク用。ペインの生死に紐づける判定 (activityGuard) は
			// setParadisAgentPaneIssueUrls 側で行うため、ここでは検出結果をそのまま渡すだけでよい。
			onIssueUrlsUpdated: issueUrls => setParadisAgentPaneIssueUrls(token, issueUrls),
			// バックグラウンドタスク・質問回答待ちの変化を状態レジストリへ反映する
			// （ParadisAgentBrowserService がペイン実行状態 working/question の判定に使う）。
			onActivity: pushActivity,
			// model / effort の変化は空deltaで購読者へ届ける（メッセージ本文とは独立に変わるため）。
			onInfo: () => {
				const settings = this.codexThreadSettings.get(token);
				if (settings !== undefined && tailer.model === settings.model && tailer.effort === settings.effort) {
					this.codexThreadSettings.delete(token);
				}
				this.pushInfoToSubscribers(token);
			},
			onProgress: progress => this.updateLiveFromProgress(token, progress),
			onCodexActivityTimeline: events => {
				const tracker = this.activityTracker(token);
				let changed = false;
				for (const event of events) {
					if (event.type === 'turnStart') {
						this.activeTurnTokens.add(token);
						fireParadisAgentTurnStarted(token, this.tokenToCwd.get(token));
					} else if (event.type === 'subagent') {
						changed = tracker.applyCodex('item/started', { item: { type: 'subAgentActivity', agentThreadId: event.id, agentPath: event.agentPath, kind: event.kind } }, event.at) || changed;
						this.enrichCodexActivityRelationship(token, event.id, event.at).catch(err => this.logService.trace('[paradisAgentChat] codex activity relationship lookup failed', String(err)));
					} else {
						this.activeTurnTokens.delete(token);
						fireParadisAgentTurnEnded(token);
						changed = tracker.endTurn(event.at) || changed;
					}
				}
				if (changed) { this.pushActivityToSubscribers(token); }
				this.schedulePersistedAgentActivityReconcile(token);
			},
			// ターン終了（Codex の task_complete / error / turn_aborted）: 考え中表示を解除し、
			// ペイン実行状態（working）側の解除は hook バス経由で ParadisAgentBrowserService に任せる。
			onTurnEnded: reason => {
				this.activeTurnTokens.delete(token);
				this.clearLiveState(token);
				fireParadisAgentTurnEnded(token);
			},
			// 接続先かどうかは、これから読むファイルそのものでも見る。`isRemoteAgentPane` は
			// 「今このペインに載っているセッション」を見るが、ここへは差し替え中の新しい
			// セッションが渡ってくることがあり、その一瞬だけ判定が食い違う
		}, this.logService, this.isRemoteAgentPane(token) || paradisIsRemoteAgentTranscriptMirrorPath(session.transcriptPath));
		this.tailers.set(token, tailer);
		tailer.ready.then(() => {
			if (this.tailers.get(token) === tailer) { this.schedulePersistedAgentActivityReconcile(token, 0); }
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
		const tailer = this.tailers.get(token);
		if (tailer !== undefined) {
			tailer.dispose();
			this.tailers.delete(token);
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
