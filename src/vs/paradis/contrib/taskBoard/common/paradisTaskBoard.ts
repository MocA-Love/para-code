/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/*
 * タスクボードの型と、画面・サーバー間の約束（RPC）。
 *
 * このファイルは VS Code の仕組みに依存しない。開発用のローカルサーバー（app/taskboard）と
 * 画面（React）がそのまま読み込み、後で Para Code の shared process に載せるときも同じものを使う。
 * 画面に出す文言はここに置かない（画面側で状態から組み立てる）。
 */

/** 工程の外にいるタスクの位置。 */
export const TASK_BOARD_TODO = 'todo';
export const TASK_BOARD_DONE = 'done';

export type TaskBoardStepKind = 'agent' | 'human' | 'run' | 'wait';
export type TaskBoardAgentKind = 'claude' | 'codex';
export type TaskBoardStepAgent = 'any' | TaskBoardAgentKind;
/** run 工程の中身。draft-pr はドラフト PR を作る。command は任意のコマンド。 */
export type TaskBoardRunAction = 'draft-pr' | 'command';
/** wait 工程が見張るもの。review はレビュー（ボットを含む）、checks は CI。 */
export type TaskBoardWaitAction = 'review' | 'checks';
/** human 工程の種類。approve は計画などの承認、merge は PR のマージ。 */
export type TaskBoardGate = 'approve' | 'merge';

/** フローの 1 工程。 */
export interface ITaskBoardStep {
	readonly id: string;
	readonly name: string;
	readonly kind: TaskBoardStepKind;
	/** agent 工程の担当。 */
	readonly agent?: TaskBoardStepAgent;
	/** agent 工程の指示。`{issue}` は Issue の番号とタイトルに置き換わる。 */
	readonly prompt?: string;
	readonly run?: TaskBoardRunAction;
	readonly command?: string;
	readonly wait?: TaskBoardWaitAction;
	readonly gate?: TaskBoardGate;
	/** 失敗・差し戻しのときに戻る工程。 */
	readonly onFail?: string;
	/** 軸の欄（intake.stageField）で、この工程に当たる選択肢の名前。 */
	readonly projectOption?: string;
}

export type TaskBoardIntakeSource = 'github-project' | 'github-issues' | 'none';

/** 取り込み元。github-project は Projects (v2)、github-issues はリポジトリの Issue。 */
export interface ITaskBoardIntake {
	readonly source: TaskBoardIntakeSource;
	readonly owner?: string;
	readonly repo?: string;
	readonly project?: number;
	/** 未着手とみなすステータスのフィールド名（既定 Status）。 */
	readonly statusField?: string;
	/** 未着手とみなすステータスの値（既定 Todo）。 */
	readonly todoValues?: readonly string[];
	/** 締切に使う日付のフィールド名。省略時は最初の日付フィールド。 */
	readonly dueField?: string;
	/** 優先度に使う単一選択のフィールド名。 */
	readonly priorityField?: string;
	/** かんばんの軸にする単一選択の欄（例: Status (AI)）。工程ごとの projectOption と対応させる。 */
	readonly stageField?: string;
	/** 完了したときに軸の欄へ書く選択肢（例: Done）。 */
	readonly doneOption?: string;
	/** 工程が変わったら軸の欄へ書き戻すか（既定 true）。 */
	readonly writeBack?: boolean;
}

export type TaskBoardWorkspaceKind = 'clone-pool' | 'worktree';
export type TaskBoardReleaseOn = 'pr-opened' | 'merged';

/**
 * 作業場所の変更を誰がコミットするか。push とドラフト PR は「ドラフト PR」の工程が行う（工程を外せば作らない）。
 * - ask: エージェントにはコミットを頼まない。PR を作る前に未コミットの変更があれば、人に聞く（既定）
 * - agent: エージェントへの指示に「タスクのブランチにコミットして（push はしない）」を書き足す
 * - board: PR を作る前に、残った変更をボードがまとめてコミットする
 */
export type TaskBoardCommitPolicy = 'ask' | 'agent' | 'board';

export interface ITaskBoardWorkspacePolicy {
	readonly kind: TaskBoardWorkspaceKind;
	/** 作業場所を返す時点。 */
	readonly releaseOn: TaskBoardReleaseOn;
	/** 同時に作業場所を借りられるタスクの数。 */
	readonly maxRunning: number;
	/** 変更を誰がコミットするか（省略時は ask）。 */
	readonly commit?: TaskBoardCommitPolicy;
}

export type TaskBoardFlowScope = 'builtin' | 'team' | 'personal';

export interface ITaskBoardFlow {
	readonly id: string;
	readonly name: string;
	readonly scope: TaskBoardFlowScope;
	readonly intake: ITaskBoardIntake;
	readonly workspace: ITaskBoardWorkspacePolicy;
	readonly steps: readonly ITaskBoardStep[];
}

export type TaskBoardStatus =
	| 'todo'
	| 'queued'
	| 'preparing'
	| 'working'
	| 'question'
	| 'permission'
	| 'approval'
	| 'stalled'
	| 'failed'
	| 'waiting'
	| 'ready'
	| 'done';

/** 人の出番がある状態。 */
export const TASK_BOARD_ATTENTION_STATUSES: readonly TaskBoardStatus[] = ['question', 'permission', 'approval', 'stalled', 'failed', 'ready'];

export function taskBoardNeedsAttention(status: TaskBoardStatus): boolean {
	return TASK_BOARD_ATTENTION_STATUSES.includes(status);
}

export interface ITaskBoardQuestionOption {
	readonly label: string;
	readonly detail?: string;
	/** この選択肢に対応するモック（成果物の id）。 */
	readonly artifactId?: string;
}

export interface ITaskBoardQuestion {
	readonly id: string;
	readonly kind: 'question' | 'permission';
	readonly text: string;
	readonly options: readonly ITaskBoardQuestionOption[];
	/** 自分で書いて答えられるか。 */
	readonly allowText: boolean;
	readonly askedAt: number;
}

export type TaskBoardArtifactKind = 'plan' | 'mock' | 'screenshot' | 'report';

export interface ITaskBoardArtifact {
	readonly id: string;
	readonly kind: TaskBoardArtifactKind;
	readonly title: string;
	readonly stepId: string;
	readonly createdAt: number;
	/** 作業場所の中のファイル。 */
	readonly path?: string;
	/** 中身（plan / report は Markdown、mock は HTML、screenshot は data URL）。 */
	readonly content?: string;
	/** スナップショットでは中身を省き、有無だけを伝える（中身は /api/artifacts から読む）。 */
	readonly hasContent?: boolean;
}

export type TaskBoardHistoryResult = 'done' | 'skipped' | 'sentBack' | 'failed' | 'cancelled';

export interface ITaskBoardHistoryEntry {
	readonly stepId: string;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly result: TaskBoardHistoryResult;
	readonly note?: string;
	readonly agent?: TaskBoardAgentKind;
}

export type TaskBoardActivityKind = 'tool' | 'message' | 'answer' | 'input' | 'system' | 'error';

export interface ITaskBoardActivity {
	readonly at: number;
	readonly kind: TaskBoardActivityKind;
	readonly label: string;
	readonly detail?: string;
}

export interface ITaskBoardIssueRef {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly url: string;
}

export type TaskBoardPrState = 'draft' | 'open' | 'merged' | 'closed';
export type TaskBoardChecksState = 'success' | 'failure' | 'pending' | 'none';
export type TaskBoardReviewState = 'approved' | 'changes' | 'commented' | 'none';

/** タスクに結び付いた PR の要約（一覧と工程の判定に使う分だけ）。 */
export interface ITaskBoardPrRef {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly url: string;
	readonly title?: string;
	readonly state: TaskBoardPrState;
	readonly checks: TaskBoardChecksState;
	readonly checksPassed?: number;
	readonly checksTotal?: number;
	readonly review: TaskBoardReviewState;
	/** シミュレーションが作った PR（GitHub には無い）。 */
	readonly simulated?: boolean;
	readonly updatedAt?: number;
}

export interface ITaskBoardLabel {
	readonly name: string;
	readonly color?: string;
}

export type TaskBoardTaskSource = 'github' | 'manual' | 'adopted';

export interface ITaskBoardTask {
	readonly id: string;
	readonly title: string;
	readonly source: TaskBoardTaskSource;
	readonly issue?: ITaskBoardIssueRef;
	readonly labels: readonly ITaskBoardLabel[];
	/** 締切（YYYY-MM-DD）。 */
	readonly due?: string;
	readonly priority?: string;
	readonly projectStatus?: string;
	/** Projects の項目の id（書き戻しに使う）。 */
	readonly projectItemId?: string;
	/** 軸の欄の、GitHub 側の今の値。 */
	readonly projectStage?: string;
	readonly assignees: readonly string[];
	/** 担当者などのアイコン（GitHub のログイン名 → 画像の URL）。 */
	readonly avatars?: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly flowId: string;
	/** `todo`・`done`・工程の id。 */
	readonly step: string;
	readonly status: TaskBoardStatus;
	readonly stepSince: number;
	/**
	 * 工程に入るたびに 1 増える試行番号。口（エージェント・コマンド・作業場所の準備）からの報告は
	 * この番号を添えて届き、今の番号と違うもの（やり直しや差し戻しの前の遅れた報告）は捨てる。
	 */
	readonly attempt: number;
	/** 空き待ちの間に預かっている指示（差し戻しの理由を含む）。作業場所が空いたら組み立てて送る。 */
	readonly pending?: { readonly prompt?: string; readonly feedback?: string };
	/** 今の工程でエージェントに送った指示（ボードが書き足す報告の頼みは除く）。 */
	readonly stepPrompt?: string;
	/** PR を作る工程が、作業場所の未コミットの変更で止まった（ファイルの一覧）。人がコミットするか決める。 */
	readonly uncommitted?: readonly string[];
	/** uncommitted のうち、git が追跡していない新しいファイル。 */
	readonly untracked?: readonly string[];
	readonly queuedAt?: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly agent?: TaskBoardAgentKind;
	readonly model?: string;
	/** 借りている作業場所の id。 */
	readonly place?: string;
	readonly branch?: string;
	readonly pr?: ITaskBoardPrRef;
	/** PR をこのフローの工程（ドラフト PR）が作ったか。取り込んだ時点で付いていた PR は false。 */
	readonly prOwned?: boolean;
	readonly question?: ITaskBoardQuestion;
	/** 今していること（エージェントの報告や自動処理の段階）。 */
	readonly activity?: string;
	readonly activities: readonly ITaskBoardActivity[];
	readonly history: readonly ITaskBoardHistoryEntry[];
	readonly artifacts: readonly ITaskBoardArtifact[];
	/** ターミナルの出力（新しいものが後ろ）。 */
	readonly log: readonly string[];
	readonly contextPct?: number;
	readonly error?: string;
}

/** 作業場所 1 つ。クローンの使い回しでは固定、ワークツリーでは借りるときに作る。 */
export interface ITaskBoardSlot {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly kind: TaskBoardWorkspaceKind;
	readonly leasedBy?: string;
	/** 未コミットの変更が残っていて貸し出せない。 */
	readonly dirty?: boolean;
	readonly missing?: boolean;
}

export type TaskBoardManualStatus = 'working' | 'question' | 'permission' | 'idle';

/** ボードの外で手で起動したエージェント。 */
export interface ITaskBoardManualSession {
	readonly id: string;
	readonly name: string;
	readonly branch?: string;
	readonly agent: TaskBoardAgentKind;
	readonly status: TaskBoardManualStatus;
	readonly text: string;
	readonly since: number;
}

export type TaskBoardGitHubMode = 'off' | 'connecting' | 'ok' | 'error';

export interface ITaskBoardRateLimit {
	readonly remaining: number;
	readonly limit: number;
	readonly resetAt: number;
}

export interface ITaskBoardGitHubState {
	readonly mode: TaskBoardGitHubMode;
	readonly login?: string;
	/** GitHub の自分のアイコン（avatars.githubusercontent.com）。 */
	readonly avatarUrl?: string;
	readonly rest?: ITaskBoardRateLimit;
	readonly graphql?: ITaskBoardRateLimit;
	readonly lastSyncAt?: number;
	readonly nextSyncAt?: number;
	readonly syncing?: boolean;
	readonly error?: string;
	/** 取り込み元の表示名（例: `owner の Projects #3`）。 */
	readonly sourceLabel?: string;
	readonly requestCount?: number;
}

export type TaskBoardAgentMode = 'simulated' | 'para-code';

export interface ITaskBoardRuntime {
	readonly agents: TaskBoardAgentMode;
	/** agents が para-code のとき、Para Code の接続口につながっているか。 */
	readonly agentsConnected?: boolean;
	/** つながっていない理由。 */
	readonly agentsDetail?: string;
	/** Codex の設定で、まだ常に許可になっていないボードのツール（agents が para-code のとき）。 */
	readonly codexApprovalMissing?: readonly string[];
	/** 画像とモックの URL に付ける、読むだけの鍵（RPC には使えない）。 */
	readonly assetKey?: string;
	/** 書き足す先の Codex の設定（ボードのサーバーの CODEX_HOME から決まる）。 */
	readonly codexConfigPath?: string;
	/** シミュレーションの速さ（1 = 標準）。 */
	readonly speed: number;
	/** 作業場所の git 操作を実際に行うか。 */
	readonly realWorkspaces: boolean;
	readonly repoPath?: string;
	readonly repoLabel?: string;
}

export interface ITaskBoardSnapshot {
	readonly version: number;
	readonly now: number;
	readonly tasks: readonly ITaskBoardTask[];
	readonly flows: readonly ITaskBoardFlow[];
	readonly activeFlowId: string;
	readonly slots: readonly ITaskBoardSlot[];
	readonly manual: readonly ITaskBoardManualSession[];
	readonly github: ITaskBoardGitHubState;
	readonly runtime: ITaskBoardRuntime;
}

export type TaskBoardNoticeKind = 'question' | 'permission' | 'approval' | 'stalled' | 'failed' | 'ready' | 'started' | 'queued' | 'dequeued' | 'done' | 'sentBack' | 'synced' | 'error';

/** 画面にトーストで知らせる出来事。文言は画面側で組み立てる。 */
export interface ITaskBoardNotice {
	readonly id: string;
	readonly kind: TaskBoardNoticeKind;
	readonly at: number;
	readonly taskId?: string;
	readonly stepId?: string;
	readonly detail?: string;
}

/* ---------------- 詳細（必要なときだけ GitHub から読む） ---------------- */

export interface ITaskBoardComment {
	readonly id?: string;
	readonly author: string;
	readonly authorAvatar?: string;
	readonly body: string;
	/** GitHub が描画した本文（画像の署名付き URL などを含む）。画面で無害化してから表示する。 */
	readonly bodyHTML?: string;
	readonly createdAt: string;
	readonly isBot?: boolean;
}

export type TaskBoardIssueEventKind = 'labeled' | 'unlabeled' | 'assigned' | 'referenced' | 'closed' | 'reopened' | 'renamed';

export interface ITaskBoardIssueEvent {
	readonly kind: TaskBoardIssueEventKind;
	readonly actor: string;
	readonly actorAvatar?: string;
	readonly at: string;
	readonly label?: ITaskBoardLabel;
	readonly assignee?: string;
	readonly pr?: { readonly number: number; readonly title: string; readonly url: string; readonly state: TaskBoardPrState };
}

export interface ITaskBoardIssueDetail {
	/** GitHub のノード id（コメントの投稿先）。 */
	readonly id?: string;
	readonly title: string;
	readonly body: string;
	readonly bodyHTML?: string;
	readonly authorAvatar?: string;
	readonly locked?: boolean;
	readonly url: string;
	readonly state: 'open' | 'closed';
	readonly author: string;
	readonly createdAt: string;
	readonly comments: readonly ITaskBoardComment[];
	readonly events: readonly ITaskBoardIssueEvent[];
	readonly linkedPrs: readonly { readonly number: number; readonly title: string; readonly url: string; readonly state: TaskBoardPrState }[];
	readonly simulated?: boolean;
}

export type TaskBoardCheckState = 'success' | 'failure' | 'pending' | 'queued' | 'skipped' | 'neutral' | 'cancelled';

export interface ITaskBoardCheck {
	readonly name: string;
	readonly state: TaskBoardCheckState;
	readonly detail?: string;
	readonly durationSec?: number;
	readonly url?: string;
}

export interface ITaskBoardReview {
	readonly author: string;
	readonly authorAvatar?: string;
	readonly bodyHTML?: string;
	readonly state: 'approved' | 'changes' | 'commented' | 'dismissed' | 'pending';
	readonly body: string;
	readonly at: string;
	readonly isBot: boolean;
}

export interface ITaskBoardReviewThread {
	readonly path: string;
	readonly line?: number;
	readonly author: string;
	readonly authorAvatar?: string;
	readonly body: string;
	readonly bodyHTML?: string;
	readonly diffHunk?: string;
	readonly resolved: boolean;
}

export interface ITaskBoardPrFile {
	readonly path: string;
	readonly additions: number;
	readonly deletions: number;
	readonly status: 'added' | 'modified' | 'removed' | 'renamed' | 'changed';
}

export interface ITaskBoardPullDetail {
	readonly id?: string;
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly state: TaskBoardPrState;
	readonly author: string;
	readonly authorAvatar?: string;
	readonly body: string;
	readonly bodyHTML?: string;
	/** PR の会話のコメント（レビュー以外）。 */
	readonly comments: readonly ITaskBoardComment[];
	readonly base: string;
	readonly head: string;
	readonly additions: number;
	readonly deletions: number;
	readonly createdAt: string;
	readonly mergeable?: 'mergeable' | 'conflicting' | 'unknown';
	readonly reviewDecision?: 'approved' | 'changes' | 'required' | 'none';
	readonly commits: readonly { readonly sha: string; readonly message: string; readonly author: string; readonly authorAvatar?: string; readonly at: string }[];
	readonly checks: readonly ITaskBoardCheck[];
	readonly reviews: readonly ITaskBoardReview[];
	readonly threads: readonly ITaskBoardReviewThread[];
	readonly files: readonly ITaskBoardPrFile[];
	readonly simulated?: boolean;
}

/* ---------------- RPC ---------------- */

export interface ITaskBoardRpc {
	snapshot: { params: Record<string, never>; result: ITaskBoardSnapshot };
	addTask: { params: { title: string; due?: string; body?: string; labels?: string[] }; result: { id: string } };
	start: { params: { taskId: string; stepId?: string; agent: TaskBoardAgentKind; prompt?: string }; result: void };
	move: { params: { taskId: string; to: string; reason?: string; from?: string; attempt?: number }; result: void };
	answer: { params: { taskId: string; questionId: string; optionIndex?: number; text?: string }; result: void };
	approve: { params: { taskId: string; note?: string; from?: string; attempt?: number }; result: void };
	sendBack: { params: { taskId: string; to?: string; reason?: string; from?: string; attempt?: number }; result: void };
	retry: { params: { taskId: string; from?: string; attempt?: number }; result: void };
	cancel: { params: { taskId: string }; result: void };
	complete: { params: { taskId: string; from?: string; attempt?: number }; result: void };
	markDone: { params: { taskId: string }; result: void };
	nudge: { params: { taskId: string }; result: void };
	sendInput: { params: { taskId: string; text: string }; result: void };
	sendKey: { params: { taskId: string; key: string }; result: void };
	removeTask: { params: { taskId: string }; result: void };
	answerManual: { params: { sessionId: string; allow: boolean }; result: void };
	adoptManual: { params: { sessionId: string; title: string }; result: { id: string } };
	saveFlow: { params: { flow: ITaskBoardFlow; scope: 'team' | 'personal' }; result: { path: string } };
	setActiveFlow: { params: { flowId: string }; result: void };
	sync: { params: Record<string, never>; result: void };
	setSpeed: { params: { speed: number }; result: void };
	issueDetail: { params: { taskId: string }; result: ITaskBoardIssueDetail | undefined };
	pullDetail: { params: { taskId: string }; result: ITaskBoardPullDetail | undefined };
	pullFilePatch: { params: { taskId: string; path: string }; result: { patch: string | undefined } };
	/** Issue か PR にコメントする（GitHub へ書き込む）。 */
	comment: { params: { taskId: string; target: 'issue' | 'pr'; body: string }; result: ITaskBoardComment };
	/** コメントのプレビュー用に、GitHub の書式で HTML にする。GitHub につないでいなければ undefined。 */
	renderMarkdown: { params: { taskId: string; text: string }; result: { html: string | undefined } };
	/** Projects の単一選択の欄と選択肢を読む。 */
	projectFields: { params: { owner: string; project: number }; result: readonly ITaskBoardProjectField[] };
	/** 軸の欄に選択肢を足す（無ければ欄を作る）。既存の選択肢と項目の値は保つ。 */
	addProjectOptions: { params: { owner: string; project: number; fieldName: string; options: readonly ITaskBoardProjectOptionInput[] }; result: { created: boolean; added: readonly string[] } };
	/** 作業場所の変更をすべてコミットし、止まった工程をやり直す（PR を作る工程が未コミットで止まったとき）。 */
	commitAndRetry: { params: { taskId: string; message: string; attempt?: number; trackedOnly?: boolean }; result: { sha: string } };
	/** エージェントのターミナルを閉じ、今の工程を新しいターミナルで始め直す（エージェントが止まって固まったとき）。 */
	restartAgent: { params: { taskId: string; attempt?: number }; result: void };
	/** タスクのドラフト PR を、レビュー待ち（Ready for review）にする（GitHub へ書き込む）。 */
	prReady: { params: { taskId: string }; result: void };
	/** 切り替えられるリポジトリの候補。 */
	repositories: { params: Record<string, never>; result: { readonly current?: string; readonly items: readonly ITaskBoardRepositoryChoice[] } };
	/** 別のリポジトリでボードを開き直す（サーバーが同じポートと鍵で起動し直し、画面は再接続する）。 */
	switchRepository: { params: { path: string }; result: void };
	/** Codex の設定に、ボードへの報告のツールを常に許可する設定を書き足す。 */
	approveCodexTools: { params: Record<string, never>; result: { path: string } };
}

export type TaskBoardRpcMethod = keyof ITaskBoardRpc;

export interface ITaskBoardRepositoryChoice {
	readonly path: string;
	readonly label: string;
	/** recent: 最近ボードで開いた / para-code: Para Code に登録されている */
	readonly source: 'recent' | 'para-code';
	readonly openedAt?: number;
}

export type TaskBoardProjectColor = 'GRAY' | 'BLUE' | 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'PINK' | 'PURPLE';

export interface ITaskBoardProjectOption {
	readonly id: string;
	readonly name: string;
	readonly color: TaskBoardProjectColor;
	readonly description: string;
}

export interface ITaskBoardProjectField {
	readonly id: string;
	readonly name: string;
	readonly options: readonly ITaskBoardProjectOption[];
}

export interface ITaskBoardProjectOptionInput {
	readonly name: string;
	readonly color: TaskBoardProjectColor;
	readonly description: string;
}

/** サーバーから画面へ流れるメッセージ。 */
export type TaskBoardServerMessage =
	| { readonly type: 'snapshot'; readonly snapshot: ITaskBoardSnapshot }
	| { readonly type: 'notice'; readonly notice: ITaskBoardNotice };

export type TaskBoardErrorCode =
	| 'not-found'
	| 'invalid-state'
	| 'invalid-params'
	| 'no-slot'
	| 'step-in-use'
	| 'github'
	| 'io'
	| 'internal';

/** RPC で画面に返すエラー。 */
export class TaskBoardError extends Error {
	readonly code: TaskBoardErrorCode;
	constructor(code: TaskBoardErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = 'TaskBoardError';
	}
}
