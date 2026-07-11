/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';

export const IParadisWorkspaceSwitchService = createDecorator<IParadisWorkspaceSwitchService>('paradisWorkspaceSwitchService');

/**
 * ワークスペース切り替え(機能1)の切り替え対象として登録されたリポジトリ1件分。
 * uri がワークスペースのルートフォルダとして folders に投入される。
 */
export interface IParadisWorkspaceRepository {
	readonly id: string;
	readonly name: string;
	readonly uri: URI;
	/** PARADIS_WORKSPACE_COLORS のパレットID。undefined = デフォルト(色なし) */
	readonly color?: string;
}

/**
 * リポジトリに設定できる色のパレット。Superset (apps/desktop の
 * shared/constants/project-colors.ts) と同一の固定12色。
 */
export interface IParadisWorkspaceColor {
	readonly id: string;
	readonly hex: string;
}

export const PARADIS_WORKSPACE_COLORS: readonly IParadisWorkspaceColor[] = Object.freeze([
	{ id: 'red', hex: '#ef4444' },
	{ id: 'orange', hex: '#f97316' },
	{ id: 'yellow', hex: '#eab308' },
	{ id: 'lime', hex: '#84cc16' },
	{ id: 'green', hex: '#22c55e' },
	{ id: 'teal', hex: '#14b8a6' },
	{ id: 'cyan', hex: '#06b6d4' },
	{ id: 'blue', hex: '#3b82f6' },
	{ id: 'indigo', hex: '#6366f1' },
	{ id: 'purple', hex: '#a855f7' },
	{ id: 'pink', hex: '#ec4899' },
	{ id: 'slate', hex: '#64748b' },
]);

/** パレットIDから hex を引く。未知のID/undefined は undefined */
export function paradisWorkspaceColorHex(colorId: string | undefined): string | undefined {
	return PARADIS_WORKSPACE_COLORS.find(color => color.id === colorId)?.hex;
}

// --- git worktree ------------------------------------------------------------------------------

/** 登録リポジトリ配下で検出された git worktree 1件分 (リストの入れ子行として表示される) */
export interface IParadisWorktree {
	/** 親リポジトリ (IParadisWorkspaceRepository.id) */
	readonly repositoryId: string;
	/** Workspaces ビューで見せる表示名 */
	readonly name: string;
	/** チェックアウト中のブランチ名 (detached HEAD なら短縮SHA) */
	readonly branch?: string;
	readonly uri: URI;
	/** 作業ツリーのディレクトリが見つからない (自動削除OFFで残っている) */
	readonly missing?: boolean;
	/**
	 * true の場合、この行は実際の git worktree ではなくリポジトリ本体 (main checkout) を
	 * 表す合成エントリ (Workspaces ビューがリポジトリ行を純粋なグルーピング見出しにするため、
	 * main checkout もリスト内の1行として子要素に混ぜ込む)。切り替え/状態キーは
	 * worktree 単位ではなく repositoryId をそのまま使う。
	 */
	readonly isMainCheckout?: boolean;
}

export const IParadisWorktreeService = createDecorator<IParadisWorktreeService>('paradisWorktreeService');

/**
 * 登録リポジトリの git worktree を検出・監視するサービス。
 * `git worktree list` は使わず、upstream の git 拡張と同じく `.git/worktrees/` を
 * 直接読む (extensions/git/src/git.ts の getWorktreesFS と同アルゴリズム)。
 */
export interface IParadisWorktreeService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeWorktrees: Event<void>;
	/** 設定による表示対象外も含め、ディスク上で検出した全worktree。 */
	getDetectedWorktrees(repositoryId: string): readonly IParadisWorktree[];
	getWorktrees(repositoryId: string): readonly IParadisWorktree[];
	/** リポジトリ本体 (main checkout) のブランチ名 (detached HEAD なら短縮SHA)。git 管理外なら undefined */
	getRepositoryBranch(repositoryId: string): string | undefined;
	/** 作成直後など、表示名を伴う worktree を既知リストへ登録する */
	addKnownWorktree(worktree: IParadisWorktree): void;
	/** 自動削除OFFで残った missing エントリを手動でリストから外す */
	removeKnownWorktree(worktree: IParadisWorktree): void;
	/**
	 * リポジトリ内の worktree の表示順を指定する (Workspaces ビューの「上へ移動/下へ移動」用)。
	 * orderedUris は getWorktrees が返す worktree の uri.toString() の配列。
	 */
	setWorktreeOrder(repositoryId: string, orderedUris: readonly string[]): void;
}

/**
 * worktree の切り替え状態キー (working set / ターミナル / パネル状態の分離キー)。
 * リポジトリは IParadisWorkspaceRepository.id をそのまま使う。
 */
export function paradisWorktreeStateKey(uri: URI): string {
	return `worktree:${uri.toString()}`;
}

// --- ターミナルスコープ / エージェント状態 -------------------------------------------------------

export const IParadisTerminalScopeService = createDecorator<IParadisTerminalScopeService>('paradisTerminalScopeService');

/**
 * ターミナルグループのリポジトリ別スコープ管理 (park/unpark)。
 * エージェント状態ポーラーが「ターミナルインスタンス → 状態キー」の対応を引くのにも使う。
 */
export interface IParadisTerminalScopeService {
	readonly _serviceBrand: undefined;
	/** インスタンスの所属スコープ (park 中のグループも対象)。不明なら undefined */
	getStateKeyForInstance(instanceId: number): string | undefined;
	/**
	 * インスタンスの所属グループを指定スコープへ付け替える。アクティブスコープ以外を
	 * 指定した場合は即座に park する (モバイル発の「PCで非表示のワークスペース向け
	 * ターミナル作成」用。既定のタグ付けはアクティブスコープ所属になるため)
	 */
	assignInstanceScope(instanceId: number, stateKey: string): void;
}

export const IParadisAgentStatusStore = createDecorator<IParadisAgentStatusStore>('paradisAgentStatusStore');

/**
 * スコープ (状態キー) ごとのエージェント実行状態ストア。
 * 書き込みは electron-browser のポーラー (shared process の /agent-hook 通知を集計) が行い、
 * Workspaces ビュー (browser 層) はここから読むだけ。Web ビルドでは常に空。
 */
export interface IParadisAgentStatusStore {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAgentStatuses: Event<void>;
	getScopeStatus(stateKey: string): ParadisAgentStatus | undefined;
	/**
	 * ターミナルインスタンス単体のエージェント実行状態（スコープ集約前のペイン単位の値）。
	 * モバイルのホーム一覧・Live Activity 用: スコープ集約値を使うと同スコープの
	 * 無関係なターミナルまで「実行中」に見えてしまうため、ペイン単位で引く。
	 */
	getInstanceStatus(instanceId: number): ParadisAgentStatus | undefined;
	/** そのインスタンスでエージェントCLIが動いた実績（hook発火）があるか。 */
	isAgentInstance(instanceId: number): boolean;
	/** ポーラー専用 */
	setScopeStatuses(statuses: Map<string, ParadisAgentStatus>): void;
	/** ポーラー専用（ペイン単位の状態とエージェント実績インスタンスの一括更新） */
	setInstanceStates(statuses: Map<number, ParadisAgentStatus>, agentInstanceIds: Set<number>): void;
}

/**
 * 複数リポジトリを単一のマルチルートワークスペース内で瞬時に切り替えるサービス。
 * ワークスペースの identity (configPath 由来の workspace id) を固定したまま
 * IWorkspaceEditingService.updateFolders で folders だけを入れ替えることで、
 * WORKSPACE スコープの storage (エディタ viewState / 展開状態 / タスク履歴等) を
 * リポジトリ間で共有しつつ Extension Host を再起動させない (relauncher 側の PARA-PATCH と対)。
 */
export interface IParadisWorkspaceSwitchService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeRepositories: Event<void>;

	/**
	 * スコープ (状態キー) が恒久的に破棄されたときに発火する (リポジトリ削除 / worktree 削除)。
	 * ペイロードは破棄された状態キー。スコープ別に持たれる状態 (park 中ターミナル / SCM入力の
	 * 下書き 等) を各コンポーネントが掃除するためのブロードキャスト。
	 */
	readonly onDidRetireScope: Event<string>;

	/**
	 * 切り替え処理の冒頭 (状態退避の直前) に発火する。ペイロードは切り替え元の
	 * 状態キー (リポジトリID or worktree キー。リスト外なら undefined)。SCM入力の
	 * 退避など、updateFolders でリソースが破棄される前に済ませたい処理のためのフック。
	 */
	readonly onWillSwitchScope: Event<string | undefined>;
	/** 切り替え完了時。ペイロードは切り替え先の状態キー */
	readonly onDidSwitchScope: Event<string>;

	readonly repositories: readonly IParadisWorkspaceRepository[];

	/**
	 * 現在アクティブなエントリの状態キー (リポジトリID or worktree キー)。
	 * working set / ターミナル / ブラウザ / パネル状態の分離キーとして使う。
	 * リスト外のフォルダが開かれている場合は undefined。
	 */
	readonly activeStateKey: string | undefined;

	/**
	 * 現在ワークスペースのルートに入っている登録済みリポジトリ。
	 * worktree やリスト外のフォルダが開かれている場合は undefined。
	 */
	readonly activeRepository: IParadisWorkspaceRepository | undefined;

	/**
	 * switchRepository の実行中 (退避 → updateFolders → 復元 の間) は true。
	 * ブラウザスコープ側が「切り替えによるエディタクローズ」と「ユーザーによる
	 * タブクローズ」を区別して dispose を veto するために使う。
	 */
	readonly isSwitching: boolean;

	addRepository(uri: URI, name?: string): Promise<IParadisWorkspaceRepository>;
	removeRepository(id: string): Promise<void>;
	renameRepository(id: string, name: string): Promise<void>;
	/** color は PARADIS_WORKSPACE_COLORS のID。undefined でデフォルトに戻す */
	setRepositoryColor(id: string, color: string | undefined): Promise<void>;

	/**
	 * ワークスペースの folders を対象リポジトリ1つに入れ替える。
	 * マルチルート (WORKSPACE) 状態でのみ動作する (単一フォルダ状態から呼ぶと
	 * upstream が新規 untitled workspace を作ってしまい workspace id が変わるため拒否する)。
	 */
	switchRepository(id: string): Promise<void>;

	/** worktree へ切り替える (状態キーは paradisWorktreeStateKey(uri)) */
	switchToWorktree(worktree: IParadisWorktree): Promise<void>;

	/**
	 * 指定スコープに紐づく保存済み状態 (working set / パネル表示状態) を破棄し、
	 * onDidRetireScope を発火する。リポジトリ削除・worktree 削除のライフサイクル終端から
	 * 呼び、二度と到達できなくなったスコープの状態が WORKSPACE ストレージや park 中の
	 * ターミナルとして残り続けるのを防ぐ。
	 */
	discardScopeState(stateKey: string): void;
}

// --- Extension Host 再起動の抑止フラグ ---------------------------------------------------------
//
// upstream の WorkspaceChangeExtHostRelauncher (relauncher.contribution.ts) は folders[0] の
// 変化を検知すると Extension Host を全再起動する。根拠は非推奨 workspace.rootPath 互換のみ。
// Para Code のワークスペース切り替えは folders を丸ごと入れ替えるため、この再起動が起きると
// 切り替えのたびに全拡張機能が落ちて「瞬時の切り替え」が成立しない。
// このウィンドウが Para Code 管理下 (リポジトリ切り替え運用中) になった時点でフラグを立て、
// relauncher 側の PARA-PATCH がこれを読んで再起動をスキップする。
// module スコープの変数で持つのは、relauncher (upstream ファイル) 側の変更を
// 「import 1行 + 条件 1語」に抑えるため (DI サービス注入はコンフリクト面が広がる)。

let paradisManagedWorkspaceWindow = false;

/**
 * このウィンドウを Para Code 管理下 (リポジトリ切り替え運用中) として記録する。
 * 一度立てたらウィンドウの生存中は下ろさない。
 */
export function markParadisManagedWorkspaceWindow(): void {
	paradisManagedWorkspaceWindow = true;
}

/**
 * relauncher の PARA-PATCH から参照される。true の間は folders[0] 変化による
 * Extension Host 再起動をスキップする。
 */
export function isParadisManagedWorkspaceWindow(): boolean {
	return paradisManagedWorkspaceWindow;
}
