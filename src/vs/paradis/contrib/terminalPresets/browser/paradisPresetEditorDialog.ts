/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// コマンドプリセットの管理ダイアログ（Settings Editor 風 2 ペイン構成）。
//   - 左ナビ: 検索ボックス（名前・説明・コマンドの部分一致）、フォルダツリー（すべて／各フォルダ／
//     (フォルダなし)＋件数バッジ）、出所フィルタ（ユーザー設定／.paracode.json）。
//   - 右コンテンツ: プリセット行の一覧 ⇄ 編集フォームを切り替えて表示する。ナビは常設で、
//     クリックすると一覧へ戻った上でフィルタが適用される。
//
// 行の並び替えは従来の ↑↓ 隣接スワップに加え、行左端の grip ハンドル（⋮⋮）からの HTML5
// ドラッグ＆ドロップと、Alt+↑ / Alt+↓ キーボード操作をサポートする。並び替えの土台は
// swapPresets（同一スコープ内の2件入れ替え）なので、フォルダ跨ぎ・保存先跨ぎの移動は不可——
// ドラッグ先が別フォルダ／別保存先なら拒否してダイアログ内トーストを出す。
//
// 保存先として「ユーザー設定（settings.json）」と「このリポジトリ（.paracode.json）」を選べる。
// ダイアログの実装様式は paradisYouTubeImportDialog.ts / paradisCreateWorktreeDialog.ts と同じ
// 自前 DOM + backdrop 方式。
//
// 一覧はフォルダでグループ化して表示できる（paradisGroupPresetsByFolder）。フォルダは独立した
// 実体ではなく、複数プリセットが同じ folder 文字列を持つことだけで成り立つ——そのため「空の
// フォルダを単体で作る」操作は無い。フォルダは必ず「1件以上のプリセットをそこへ移動する」ことで
// 生まれる（選択 → 一括操作 → フォルダへ移動 → 新しいフォルダを作成、またはプリセット編集フォームの
// フォルダ欄に名前を書く）。

import './media/paradisPresetEditorDialog.css';
import * as dom from '../../../../base/browser/dom.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Codicon, getAllCodicons } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import {
	IParadisPresetDefinition,
	IParadisPresetGroup,
	IParadisPresetService,
	IParadisPresetTask,
	IParadisResolvedPreset,
	paradisDistinctFolderNames,
	paradisFindPresetNameConflict,
	paradisGetPresetTasks,
	paradisGroupPresetsByFolder,
	paradisPresetCommandSignature,
	paradisPresetFingerprint,
	paradisPresetHostsLabel,
	paradisPresetQualifier,
	paradisPresetQualifiers,
	paradisPresetScopeKey,
	ParadisPresetLayout,
	ParadisPresetNameConflict,
	ParadisPresetSource,
	PARADIS_PRESET_HOST_LOCAL,
	PARADIS_PRESET_HOST_REMOTE,
	PARADIS_PROJECT_ROOT_ENV_VAR,
	PARADIS_WORKSPACE_PRESET_FILE,
} from '../common/paradisTerminalPresets.js';

const $ = dom.$;

/**
 * 保存ボタンを押した後の行き先。
 *   - save: 保存する（replace があればその1件を置き換える。無ければ新しい1件として追加）
 *   - blocked: 保存できない理由をフォームに出す（見分けが付かなくなる編集）
 *   - cancel: 何もしない
 */
type ISaveDecision =
	| { readonly kind: 'save'; readonly replace?: IParadisResolvedPreset }
	| { readonly kind: 'blocked'; readonly message: string }
	| { readonly kind: 'cancel' };

/** フォルダ削除時に選べる行き先。 */
type IDeleteFolderDecision = 'keep' | 'deleteAll' | undefined;

/** {@link IParadisPresetGroup} のうち、folder を持つことが確定しているもの（フォルダ行の描画に使う）。 */
type IParadisFolderGroup = IParadisPresetGroup & { readonly folder: string };

/**
 * 左ナビの選択状態。フォルダと出所は排他の単一選択（Settings Editor のセクション選択と同じ
 * 「今どれを見ているか」のモデル）。folder が undefined のときは「(フォルダなし)」を指す。
 */
type ParadisPresetEditorFilter =
	| { readonly kind: 'all' }
	| { readonly kind: 'folder'; readonly folder?: string }
	| { readonly kind: 'source'; readonly source: ParadisPresetSource };

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.presetEditor.title', "コマンドプリセット");
// allow-any-unicode-next-line
const STR_EMPTY = localize('paradis.presetEditor.empty', "プリセットがまだありません。「新規作成」から追加できます。");
// allow-any-unicode-next-line
const STR_NEW = localize('paradis.presetEditor.new', "新規作成");
// allow-any-unicode-next-line
const STR_CLOSE = localize('paradis.presetEditor.close', "閉じる");
// allow-any-unicode-next-line
const STR_RUN = localize('paradis.presetEditor.run', "実行");
// allow-any-unicode-next-line
const STR_EDIT = localize('paradis.presetEditor.edit', "編集");
// allow-any-unicode-next-line
const STR_DUPLICATE = localize('paradis.presetEditor.duplicate', "複製");
// allow-any-unicode-next-line
const strDuplicateName = (name: string) => localize('paradis.presetEditor.duplicateName', "{0} のコピー", name);
// allow-any-unicode-next-line
const strDuplicatedNotice = (name: string) => localize('paradis.presetEditor.duplicatedNotice', "「{0}」を複製しました", name);
// allow-any-unicode-next-line
const STR_DELETE = localize('paradis.presetEditor.delete', "削除");
// allow-any-unicode-next-line
const STR_NAME = localize('paradis.presetEditor.name', "名前");
// allow-any-unicode-next-line
const STR_DESCRIPTION = localize('paradis.presetEditor.description', "説明（任意）");
// allow-any-unicode-next-line
const STR_FOLDER = localize('paradis.presetEditor.folder', "フォルダ（任意。同じ名前を付けると一覧でまとめて表示されます）");
// allow-any-unicode-next-line
const STR_FOLDER_PLACEHOLDER = localize('paradis.presetEditor.folderPlaceholder', "例: Docker");
// allow-any-unicode-next-line
const STR_TASKS = localize('paradis.presetEditor.tasks', "ターミナル（1枚ごとに名前・作業ディレクトリ・コマンドを指定）");
// allow-any-unicode-next-line
const STR_TASK_NAME = localize('paradis.presetEditor.taskName', "ターミナル名（任意）");
// allow-any-unicode-next-line
const STR_TASK_CWD = localize('paradis.presetEditor.taskCwd', "作業ディレクトリ（任意）");
// allow-any-unicode-next-line
const STR_TASK_COMMANDS_PLACEHOLDER = localize('paradis.presetEditor.taskCommands', "コマンド（1行に1つ、上から順に実行）");
// allow-any-unicode-next-line
const STR_ADD_TASK = localize('paradis.presetEditor.addTask', "＋ ターミナルを追加");
// allow-any-unicode-next-line
const STR_ICON = localize('paradis.presetEditor.icon', "アイコン（一覧をクリックして選択。入力で絞り込み）");
// allow-any-unicode-next-line
const STR_ICON_EMPTY = localize('paradis.presetEditor.iconEmpty', "一致するアイコンがありません。");
// allow-any-unicode-next-line
const STR_CWD = localize('paradis.presetEditor.cwd', "既定の作業ディレクトリ（任意。ターミナル側で未指定のときに使用。相対パスはリポジトリルート基準）");
// allow-any-unicode-next-line
const STR_LAYOUT = localize('paradis.presetEditor.layout', "ターミナルの並べ方");
// allow-any-unicode-next-line
const STR_LAYOUT_TABS = localize('paradis.presetEditor.layout.tabs', "タブで並べる");
// allow-any-unicode-next-line
const STR_LAYOUT_SPLIT = localize('paradis.presetEditor.layout.split', "分割して並べる");
// allow-any-unicode-next-line
const STR_LAYOUT_CURRENT = localize('paradis.presetEditor.layout.current', "アクティブなターミナルで実行（全コマンド連結）");
// allow-any-unicode-next-line
const STR_PINNED = localize('paradis.presetEditor.pinned', "ターミナルタブバー右側にボタンとして表示する");
// allow-any-unicode-next-line
const STR_PINNED_LABEL = localize('paradis.presetEditor.pinnedLabel', "ボタンにアイコンに加えて名前も表示する");
// allow-any-unicode-next-line
const STR_DISPLAY = localize('paradis.presetEditor.display', "表示");
// allow-any-unicode-next-line
const STR_AUTORUN = localize('paradis.presetEditor.autoRun', "「新しいスペース（worktree）を作成」直後に自動実行する");
// allow-any-unicode-next-line
const STR_AUTORUN_HINT = localize('paradis.presetEditor.autoRunHint', "実行時は環境変数 {0} に親リポジトリの絶対パスが渡されます", PARADIS_PROJECT_ROOT_ENV_VAR);
// allow-any-unicode-next-line
const STR_TARGET = localize('paradis.presetEditor.target', "保存先");
// allow-any-unicode-next-line
const STR_TARGET_USER = localize('paradis.presetEditor.targetUser', "ユーザー設定（すべてのリポジトリ）");
// allow-any-unicode-next-line
const strTargetWorkspace = (repoName: string) => localize('paradis.presetEditor.targetWorkspace', "このリポジトリ（{0}/.paracode.json — コミットで共有できます）", repoName);
// allow-any-unicode-next-line
const STR_APPLIES_TO = localize('paradis.presetEditor.appliesTo', "対象リポジトリ（任意。1行に1つ、フォルダ名または絶対パス。空欄は全リポジトリ）");
// allow-any-unicode-next-line
const STR_HOST_ENV = localize('paradis.presetEditor.hostEnv', "実行環境");
// allow-any-unicode-next-line
const STR_HOST_LOCAL = localize('paradis.presetEditor.hostLocal', "ローカル（SSH 未接続）");
// allow-any-unicode-next-line
const STR_HOST_REMOTE = localize('paradis.presetEditor.hostRemote', "リモート（SSH 接続中）");
// allow-any-unicode-next-line
const STR_HOST_CHIPS_LABEL = localize('paradis.presetEditor.hostChipsLabel', "ホストの絞り込み（任意。空欄なら接続先を問わない）");
// allow-any-unicode-next-line
const STR_HOST_CHIP_INPUT_PLACEHOLDER = localize('paradis.presetEditor.hostChipInput', "~/.ssh/config の Host 名");
// allow-any-unicode-next-line
const STR_HOST_CHIP_REMOVE = localize('paradis.presetEditor.hostChipRemove', "削除");
// allow-any-unicode-next-line
const STR_HOST_ENV_HINT_ANY = localize('paradis.presetEditor.hostEnvHintAny', "どちらも未チェックの場合は、すべての場所で表示されます（条件なし）。チェックした環境との AND 条件として「対象リポジトリ」が効きます。");
// allow-any-unicode-next-line
const STR_HOST_CHIPS_HINT_REMOTE_OFF = localize('paradis.presetEditor.hostChipsHintRemoteOff', "「リモート」にチェックを付けると編集できます。");
// allow-any-unicode-next-line
const STR_INACTIVE_BADGE = localize('paradis.presetEditor.inactiveBadge', "このウィンドウでは非表示");
// allow-any-unicode-next-line
const strRunDisabledTooltip = (hostsLabel: string | undefined) => hostsLabel
	// allow-any-unicode-next-line
	? localize('paradis.presetEditor.runDisabledQualified', "実行環境（{0}）に一致するウィンドウでのみ実行できます", hostsLabel)
	// allow-any-unicode-next-line
	: localize('paradis.presetEditor.runDisabled', "現在の接続先では実行できないプリセットです");
// allow-any-unicode-next-line
const STR_BACK = localize('paradis.presetEditor.back', "戻る");
// allow-any-unicode-next-line
const STR_SAVE = localize('paradis.presetEditor.save', "保存");
// allow-any-unicode-next-line
const STR_NAME_REQUIRED = localize('paradis.presetEditor.nameRequired', "名前を入力してください。");
// allow-any-unicode-next-line
const STR_COMMANDS_REQUIRED = localize('paradis.presetEditor.commandsRequired', "コマンドを1つ以上入力してください。");
// allow-any-unicode-next-line
const strDeleteConfirm = (name: string) => localize('paradis.presetEditor.deleteConfirm', "プリセット「{0}」を削除しますか？", name);
// allow-any-unicode-next-line
const strDeleteConfirmOthers = (count: number) => localize('paradis.presetEditor.deleteConfirmOthers', "同じ名前のプリセットが他に{0}件ありますが、そちらは残ります。", count);
// allow-any-unicode-next-line
const strSameNameHintNew = (count: number) => localize('paradis.presetEditor.sameNameHintNew', "同じ名前のプリセットが{0}件あります。このまま保存すると並んで登録されます（置き換えるかどうかは保存時に選べます）。", count);
// allow-any-unicode-next-line
const strSameNameHintEdit = (count: number) => localize('paradis.presetEditor.sameNameHintEdit', "同じ名前のプリセットが他に{0}件あります。一覧やボタンでは、対象リポジトリなどの違いで見分けます。", count);
// allow-any-unicode-next-line
const strConflictMessage = (name: string) => localize('paradis.presetEditor.conflictMessage', "「{0}」という名前のプリセットが既にあります。", name);
// allow-any-unicode-next-line
const STR_CONFLICT_ADD = localize('paradis.presetEditor.conflictAdd', "別のプリセットとして追加");
// allow-any-unicode-next-line
const STR_CONFLICT_REPLACE = localize('paradis.presetEditor.conflictReplace', "置き換える");
// allow-any-unicode-next-line
const STR_CONFLICT_CANCEL = localize('paradis.presetEditor.conflictCancel', "キャンセル");
// allow-any-unicode-next-line
const STR_INDISTINGUISHABLE_MESSAGE = localize('paradis.presetEditor.indistinguishableMessage', "同じ内容のプリセットが既にあります。");
// allow-any-unicode-next-line
const STR_INDISTINGUISHABLE_DETAIL = localize('paradis.presetEditor.indistinguishableDetail', "名前・対象リポジトリ・説明がすべて同じため、並べても一覧やボタンで見分けられません。並べて登録したい場合は、キャンセルして名前を変えるか説明を付けてください。");
// allow-any-unicode-next-line
const strExistingDetail = (commands: string, qualifier: string) => localize('paradis.presetEditor.conflictExisting', "既存: {0}{1}", commands, qualifier ? localize('paradis.presetEditor.conflictQualifier', "（{0}）", qualifier) : '');
// allow-any-unicode-next-line
const strExistingCount = (count: number) => localize('paradis.presetEditor.conflictExistingCount', "同じ名前のプリセットが既に{0}件あります。置き換えたい場合は、一覧から対象を選んで編集または削除してください。", count);
// allow-any-unicode-next-line
const STR_DELETE_FAILED = localize('paradis.presetEditor.deleteFailed', "削除できませんでした");
// allow-any-unicode-next-line
const STR_OPERATION_FAILED = localize('paradis.presetEditor.operationFailed', "操作に失敗しました");
// allow-any-unicode-next-line
const STR_SOURCE_USER = localize('paradis.presetEditor.sourceUser', "ユーザー");
// allow-any-unicode-next-line
const STR_SOURCE_WORKSPACE = localize('paradis.presetEditor.sourceWorkspace', "リポジトリ");
// allow-any-unicode-next-line
const STR_LOCALLY_HIDDEN_BADGE = localize('paradis.presetEditor.locallyHiddenBadge', "自分だけ非表示中");
// allow-any-unicode-next-line
const STR_UNHIDE = localize('paradis.presetEditor.unhide', "表示する");
// allow-any-unicode-next-line
const STR_SELECT = localize('paradis.presetEditor.select', "選択");
// allow-any-unicode-next-line
const strSelectPreset = (name: string) => localize('paradis.presetEditor.selectPreset', "{0} を選択", name);
// allow-any-unicode-next-line
const strSelectFolder = (name: string) => localize('paradis.presetEditor.selectFolder', "フォルダ「{0}」の中身をまとめて選択", name);
// allow-any-unicode-next-line
const strFolderCount = (count: number) => localize('paradis.presetEditor.folderCount', "{0}件", count);
// allow-any-unicode-next-line
const STR_FOLDER_EXPAND = localize('paradis.presetEditor.folderExpand', "展開する");
// allow-any-unicode-next-line
const STR_FOLDER_COLLAPSE = localize('paradis.presetEditor.folderCollapse', "折りたたむ");
// allow-any-unicode-next-line
const STR_FOLDER_NAME = localize('paradis.presetEditor.folderName', "フォルダ名");
// allow-any-unicode-next-line
const STR_FOLDER_NAME_REQUIRED = localize('paradis.presetEditor.folderNameRequired', "フォルダ名を入力してください。");
// allow-any-unicode-next-line
const strFolderRenameTitle = (name: string) => localize('paradis.presetEditor.folderRenameTitle', "{0} — フォルダ名を変更", name);
// allow-any-unicode-next-line
const strFolderCreateTitle = () => localize('paradis.presetEditor.folderCreateTitle', "{0} — 新しいフォルダ", STR_TITLE);
// allow-any-unicode-next-line
const strFolderCreateHint = (count: number) => localize('paradis.presetEditor.folderCreateHint', "選択した{0}件をこのフォルダへ移動します。", count);
// allow-any-unicode-next-line
const STR_FOLDER_CREATE = localize('paradis.presetEditor.folderCreate', "作成");
// allow-any-unicode-next-line
const strDeleteFolderMessage = (name: string) => localize('paradis.presetEditor.deleteFolderMessage', "フォルダ「{0}」を削除しますか？", name);
// allow-any-unicode-next-line
const strDeleteFolderDetail = (count: number) => localize('paradis.presetEditor.deleteFolderDetail', "フォルダの中身（{0}件）をどうするか選んでください。", count);
// allow-any-unicode-next-line
const STR_DELETE_FOLDER_KEEP = localize('paradis.presetEditor.deleteFolderKeep', "フォルダだけ削除する（中身は残す）");
// allow-any-unicode-next-line
const strDeleteFolderAll = (count: number) => localize('paradis.presetEditor.deleteFolderAll', "中身ごと削除する（{0}件）", count);
// allow-any-unicode-next-line
const strBulkCount = (count: number) => localize('paradis.presetEditor.bulkCount', "{0}件選択中", count);
// allow-any-unicode-next-line
const STR_BULK_MOVE = localize('paradis.presetEditor.bulkMove', "フォルダへ移動");
// allow-any-unicode-next-line
const STR_BULK_MOVE_NEW_FOLDER = localize('paradis.presetEditor.bulkMoveNewFolder', "新しいフォルダを作成...");
// allow-any-unicode-next-line
const STR_BULK_UNFILE = localize('paradis.presetEditor.bulkUnfile', "フォルダから出す");
// allow-any-unicode-next-line
const STR_BULK_CLEAR = localize('paradis.presetEditor.bulkClear', "選択を解除");
// allow-any-unicode-next-line
const strBulkDeleteMessage = (count: number) => localize('paradis.presetEditor.bulkDeleteMessage', "選択した{0}件を削除しますか？", count);
// allow-any-unicode-next-line
const strBulkRunMessage = (count: number) => localize('paradis.presetEditor.bulkRunMessage', "選択した{0}件を順番に実行しますか？", count);
// allow-any-unicode-next-line
const STR_BULK_RUN_FAILED = localize('paradis.presetEditor.bulkRunFailed', "一部のプリセットを実行できませんでした");
// allow-any-unicode-next-line
const STR_BULK_RUN_ALL_INACTIVE = localize('paradis.presetEditor.bulkRunAllInactive', "選択したプリセットは現在の接続先では実行できません");
// allow-any-unicode-next-line
const strBulkRunSkipped = (count: number) => localize('paradis.presetEditor.bulkRunSkipped', "（{0} 件は現在のウィンドウでは実行できないため除きます）", count);

// --- 2 ペイン UI 用の文言 ---------------------------------------------------------------------------------

// allow-any-unicode-next-line
const STR_SEARCH_PLACEHOLDER = localize('paradis.presetEditor.searchPlaceholder', "プリセットを検索（名前・説明・コマンド）");
// allow-any-unicode-next-line
const strSearchHits = (count: number) => localize('paradis.presetEditor.searchHits', "{0}件ヒット", count);
// allow-any-unicode-next-line
const STR_NO_MATCH = localize('paradis.presetEditor.noMatch', "該当するプリセットがありません。");
// allow-any-unicode-next-line
const STR_NAV_CAPTION_PRESETS = localize('paradis.presetEditor.navCaptionPresets', "プリセット");
// allow-any-unicode-next-line
const STR_NAV_ALL = localize('paradis.presetEditor.navAll', "すべて");
// allow-any-unicode-next-line
const STR_NAV_UNFILED = localize('paradis.presetEditor.navUnfiled', "(フォルダなし)");
// allow-any-unicode-next-line
const STR_NAV_CAPTION_SOURCE = localize('paradis.presetEditor.navCaptionSource', "出所");
// allow-any-unicode-next-line
const STR_NAV_SOURCE_USER = localize('paradis.presetEditor.navSourceUser', "ユーザー設定");
// allow-any-unicode-next-line
const STR_NAV_SOURCE_WORKSPACE = localize('paradis.presetEditor.navSourceWorkspace', "リポジトリ（.paracode.json）");
// allow-any-unicode-next-line
const STR_NAV_CAPTION_HINTS = localize('paradis.presetEditor.navCaptionHints', "操作のヒント");
// allow-any-unicode-next-line
const strGripTitle = (name: string) => localize('paradis.presetEditor.gripTitle', "{0}: 左端をつかんでドラッグ、または Alt+↑ / Alt+↓ で並び替え", name);
// allow-any-unicode-next-line
const STR_HINT_REORDER = localize('paradis.presetEditor.hintReorder', "行の左端 ⋮⋮ をドラッグ、または Alt+↑ / Alt+↓ でも並び替えられます。");
// allow-any-unicode-next-line
const STR_HINT_NO_CROSS = localize('paradis.presetEditor.hintNoCross', "※ フォルダを跨ぐ移動と、保存先（ユーザー設定 / .paracode.json）を跨ぐ移動はできません。");
// allow-any-unicode-next-line
const STR_MOVE_REJECTED_FOLDER = localize('paradis.presetEditor.moveRejectedFolder', "フォルダを跨ぐ移動はできません");
// allow-any-unicode-next-line
const STR_MOVE_REJECTED_SCOPE = localize('paradis.presetEditor.moveRejectedScope', "保存先が異なるプリセット同士は入れ替えられません");

/** これ未満の件数なら「実行」は確認なしで即実行する（1〜2件は単発実行と同じ感覚で押せてよいため）。 */
const BULK_RUN_CONFIRM_THRESHOLD = 3;

/** ダイアログ内トーストを自動で消すまでの時間（ms）。 */
const TOAST_REMOVE_DELAY = 2400;

// アイコンピッカーに出す全codicon（アルファベット順）。モジュールロード時に一度だけ確定する。
const ALL_CODICONS = getAllCodicons().sort((a, b) => a.id.localeCompare(b.id));

const LAYOUT_LABELS: readonly { layout: ParadisPresetLayout; label: string }[] = [
	{ layout: 'tabs', label: STR_LAYOUT_TABS },
	{ layout: 'split', label: STR_LAYOUT_SPLIT },
	{ layout: 'current', label: STR_LAYOUT_CURRENT },
];

// 開いているダイアログの参照。コマンド・設定内リンク・タブバーのボタンなど複数の入り口から
// 呼ばれるため、多重に開いて重ならないようにシングルトンにする。
let paradisActivePresetEditorDialog: ParadisPresetEditorDialog | undefined;

export function openParadisPresetEditorDialog(accessor: ServicesAccessor): void {
	if (paradisActivePresetEditorDialog) {
		return;
	}
	// ダイアログは自身の close で自己 dispose する
	paradisActivePresetEditorDialog = new ParadisPresetEditorDialog(
		accessor.get(ILayoutService),
		accessor.get(IParadisPresetService),
		accessor.get(IDialogService),
		accessor.get(IWorkspaceContextService),
		accessor.get(IContextMenuService),
	);
}

class ParadisPresetEditorDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _dialog: HTMLElement;
	/** 常設シェル（ヘッダー／左ナビ／右コンテンツ）。再描画は右コンテンツの中身だけ行う。 */
	private readonly _selectToggleEl: HTMLButtonElement;
	private readonly _newBtnEl: HTMLButtonElement;
	private readonly _navEl: HTMLElement;
	private readonly _searchInput: HTMLInputElement;
	private readonly _searchHitsEl: HTMLElement;
	private readonly _navItemsEl: HTMLElement;
	private readonly _contentEl: HTMLElement;
	/** 常設部分のリスナー。render ごとの {@link _viewStore} とは分けて管理する。 */
	private readonly _chromeStore = this._register(new DisposableStore());
	private readonly _viewStore = this._register(new DisposableStore());
	private _mode: 'list' | 'edit' = 'list';

	/** 一覧の複数選択モード。トグルで on/off し、off になったら選択も捨てる。 */
	private _selecting = false;
	private readonly _selectedKeys = new Set<string>();
	/**
	 * 選択した時点の指紋（key → paradisPresetFingerprint）。.paracode.json 由来のキーは位置由来
	 * （paradisPresetKey）なので、外部で別の1件が消える等して並びがずれると、key 自体は残っていても
	 * 「中身が別のプリセットにすり替わっている」ことがある——key の存在チェックだけでは拾えない。
	 * _renderList() のたびに選択中のキーぶんだけ撮り直し、onDidChangePresets でここと食い違って
	 * いたら選択を丸ごと捨てる。
	 */
	private _selectedFingerprints = new Map<string, string>();
	/** 折りたたんだフォルダのキー（scope::folder名）。既定は展開。ダイアログの表示中だけ保持する。 */
	private readonly _collapsedFolders = new Set<string>();

	/** 左ナビで選択中のフィルタ（フォルダ／出所は排他単一選択）。 */
	private _filter: ParadisPresetEditorFilter = { kind: 'all' };
	private _searchQuery = '';

	/** 表示中の各行の並び替え可否（key → 上下の隣接プリセット）。Alt+↑↓ キーボード操作から参照する。 */
	private _moveTargets = new Map<string, { up?: IParadisResolvedPreset; down?: IParadisResolvedPreset }>();
	/** 表示中の key → プリセット本体（ドラッグ＆ドロップの drop 先解決にも使う）。 */
	private _rowPresets = new Map<string, IParadisResolvedPreset>();
	/** ドラッグ中のプリセット（dragstart〜drop/dragend の間だけ非 undefined）。 */
	private _dragging: IParadisResolvedPreset | undefined;

	constructor(
		layoutService: ILayoutService,
		private readonly presetService: IParadisPresetService,
		private readonly dialogService: IDialogService,
		private readonly contextService: IWorkspaceContextService,
		private readonly contextMenuService: IContextMenuService,
	) {
		super();

		this._backdrop = $('.paradis-preset-editor-backdrop');
		this._dialog = $('.paradis-preset-editor-dialog');
		this._backdrop.appendChild(this._dialog);

		// --- ヘッダー（常設）: タイトル + 選択トグル + 新規作成 + 閉じる ---
		const header = dom.append(this._dialog, $('.ppe-header'));
		dom.append(header, $('h3.ppe-title')).textContent = STR_TITLE;
		const headerActions = dom.append(header, $('.ppe-header-actions'));
		this._selectToggleEl = dom.append(headerActions, $('button.ppe-btn.ppe-select-toggle')) as HTMLButtonElement;
		this._selectToggleEl.type = 'button';
		this._selectToggleEl.textContent = STR_SELECT;
		this._chromeStore.add(dom.addDisposableListener(this._selectToggleEl, 'click', () => {
			this._selecting = !this._selecting;
			if (!this._selecting) {
				this._selectedKeys.clear();
			}
			// 編集フォーム中表示中に押された場合も、一覧へ戻して選択モードを反映させる
			this._renderList();
		}));
		this._newBtnEl = dom.append(headerActions, $('button.ppe-btn.ppe-btn-primary')) as HTMLButtonElement;
		this._newBtnEl.type = 'button';
		this._newBtnEl.textContent = STR_NEW;
		this._chromeStore.add(dom.addDisposableListener(this._newBtnEl, 'click', () => this._renderEdit(undefined)));
		const closeBtn = dom.append(headerActions, $('button.ppe-btn.ppe-close-btn')) as HTMLButtonElement;
		closeBtn.type = 'button';
		// allow-any-unicode-next-line
		closeBtn.textContent = '✕';
		closeBtn.title = STR_CLOSE;
		closeBtn.setAttribute('aria-label', STR_CLOSE);
		this._chromeStore.add(dom.addDisposableListener(closeBtn, 'click', () => this.dispose()));

		// --- ボディ: 左ナビ + 右コンテンツ ---
		const body = dom.append(this._dialog, $('.ppe-body'));
		this._navEl = dom.append(body, $('.ppe-nav'));
		const search = dom.append(this._navEl, $('.ppe-search'));
		dom.append(search, $(`span${ThemeIcon.asCSSSelector(Codicon.search)}`));
		this._searchInput = dom.append(search, $('input.ppe-search-input')) as HTMLInputElement;
		this._searchInput.type = 'text';
		this._searchInput.spellcheck = false;
		this._searchInput.placeholder = STR_SEARCH_PLACEHOLDER;
		this._searchInput.setAttribute('aria-label', STR_SEARCH_PLACEHOLDER);
		this._chromeStore.add(dom.addDisposableListener(this._searchInput, 'input', () => {
			this._searchQuery = this._searchInput.value;
			if (this._mode === 'list') {
				this._renderList();
			}
		}));
		this._searchHitsEl = dom.append(this._navEl, $('.ppe-search-hits'));
		const navScroll = dom.append(this._navEl, $('.ppe-nav-scroll'));
		// フィルタ項目（すべて／フォルダ群／出所）は render のたびに作り直す。検索ボックスと
		// ヒントは常設なので、クリック委譲をナビ全体に張っておけば作り直しに耐える。
		this._navItemsEl = dom.append(navScroll, $('.ppe-nav-items'));
		this._chromeStore.add(dom.addDisposableListener(this._navEl, 'click', e => {
			const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.ppe-nav-item');
			if (!btn || !btn.dataset.kind) {
				return;
			}
			const kind = btn.dataset.kind;
			if (kind === 'all') {
				this._filter = { kind: 'all' };
			} else if (kind === 'folder') {
				this._filter = { kind: 'folder', folder: btn.dataset.folder || undefined };
			} else if (kind === 'source') {
				this._filter = { kind: 'source', source: btn.dataset.source === 'workspace' ? 'workspace' : 'user' };
			} else {
				return;
			}
			// 編集中にナビを触った場合も、まず一覧へ戻す（フィルタは一覧に対する操作のため）
			this._renderList();
		}));
		dom.append(navScroll, $('.ppe-nav-caption')).textContent = STR_NAV_CAPTION_HINTS;
		const navHint = dom.append(navScroll, $('.ppe-nav-hint'));
		dom.append(navHint, $('div')).textContent = STR_HINT_REORDER;
		dom.append(navHint, $('div')).textContent = STR_HINT_NO_CROSS;
		this._contentEl = dom.append(body, $('.ppe-content'));

		// Alt+↑ / Alt+↓ キーボード並び替え。行内のどの要素（grip 含む）にフォーカスがあっても
		// 効くように、コンテンツ全体に委譲する。
		this._chromeStore.add(dom.addDisposableListener(this._contentEl, 'keydown', e => {
			if (this._mode !== 'list' || !e.altKey) {
				return;
			}
			if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
				return;
			}
			const row = (e.target as HTMLElement).closest<HTMLElement>('.ppe-row[data-preset-key]');
			const key = row?.dataset.presetKey;
			const current = key ? this._rowPresets.get(key) : undefined;
			const targets = key ? this._moveTargets.get(key) : undefined;
			if (!current || !targets) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			const target = e.key === 'ArrowUp' ? targets.up : targets.down;
			if (target) {
				void this.presetService.swapPresets(current, target);
			}
		}));

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.dispose();
			}
		}));
		this._register(dom.addDisposableListener(this._backdrop, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				if (this._mode === 'edit') {
					this._renderList();
				} else {
					this.dispose();
				}
			}
		}));
		this._register(this.presetService.onDidChangePresets(() => {
			// key が残っていても中身が別物にすり替わっている可能性があるため、存在チェックだけでは
			// 足りない（_selectedFingerprints のコメント参照）。1件でも指紋が食い違っていたら、
			// 一括操作での巻き添えを避けるため選択を丸ごと捨てる。
			const live = new Map(this.presetService.presets.map(preset => [preset.key, preset]));
			for (const key of this._selectedKeys) {
				const current = live.get(key);
				if (!current || paradisPresetFingerprint(current) !== this._selectedFingerprints.get(key)) {
					this._selectedKeys.clear();
					break;
				}
			}
			if (this._mode === 'list') {
				this._renderList();
			}
		}));

		layoutService.activeContainer.appendChild(this._backdrop);
		this._renderList();
	}

	override dispose(): void {
		if (paradisActivePresetEditorDialog === this) {
			paradisActivePresetEditorDialog = undefined;
		}
		this._backdrop.remove();
		super.dispose();
	}

	// --- フィルタ・ユーティリティ ------------------------------------------------------------------

	/** プリセットが左ナビの選択（フォルダ／出所）に合致するか。 */
	private _matchesFilter(preset: IParadisResolvedPreset, filter: ParadisPresetEditorFilter): boolean {
		switch (filter.kind) {
			case 'all':
				return true;
			case 'folder':
				// グループ化（paradisGroupPresetsByFolder）と同じく trim 越しに比較する。
				// filter.folder === undefined は「(フォルダなし)」を意味する。
				return (preset.folder?.trim() || undefined) === filter.folder;
			case 'source':
				return preset.source === filter.source;
		}
	}

	/** プリセットが検索語（名前・説明・コマンドの部分一致）に合致するか。空クエリは常に true。 */
	private _matchesSearch(preset: IParadisResolvedPreset, query: string): boolean {
		if (!query) {
			return true;
		}
		const haystack = `${preset.name}\n${preset.description ?? ''}\n${paradisPresetCommandSignature(preset, ' ')}`.toLowerCase();
		return haystack.includes(query);
	}

	/**
	 * 2つのプリセットを入れ替えてよいか。「だめ」ときの理由も返す（トーストの文言を分けるため）。
	 * swapPresets の制約（同一スコープ内のみ）に加え、フォルダ跨ぎも UI 側で拒否する。
	 */
	private _reorderRejection(a: IParadisResolvedPreset, b: IParadisResolvedPreset): 'scope' | 'folder' | undefined {
		if (paradisPresetScopeKey(a) !== paradisPresetScopeKey(b)) {
			return 'scope';
		}
		if ((a.folder?.trim() || undefined) !== (b.folder?.trim() || undefined)) {
			return 'folder';
		}
		return undefined;
	}

	/** ダイアログ内トースト。フォーカスを奪わない軽い通知（並び替え拒否・複製完了など）。 */
	private _toast(message: string): void {
		const toast = $('.ppe-toast');
		toast.setAttribute('role', 'status');
		toast.textContent = message;
		this._backdrop.appendChild(toast);
		setTimeout(() => toast.remove(), TOAST_REMOVE_DELAY);
	}

	// --- 一覧ビュー -------------------------------------------------------------------------------

	private _renderList(): void {
		this._mode = 'list';
		this._viewStore.clear();
		dom.clearNode(this._contentEl);
		this._moveTargets = new Map();
		this._rowPresets = new Map();

		const presets = this.presetService.presets;
		// 選択中のキーぶんだけ、今の中身の指紋を撮り直す（onDidChangePresets が次に来たときの
		// すり替え検出に使う。_selectedFingerprints のコメント参照）。
		this._selectedFingerprints = new Map(
			presets.filter(preset => this._selectedKeys.has(preset.key)).map(preset => [preset.key, paradisPresetFingerprint(preset)]),
		);

		// 検索＋ナビフィルタを適用した表示対象。qualifier（同名の区別語）はフルセット基準で計算する
		// ——絞り込みで同名の片方しか見えていないときでも区別語が出ている方が誤認がない。
		const query = this._searchQuery.trim().toLowerCase();
		const filtered = presets.filter(preset =>
			this._matchesFilter(preset, this._filter) && this._matchesSearch(preset, query));
		const qualifiers = paradisPresetQualifiers(presets);

		this._syncSelectToggle();
		this._renderNavItems(presets, filtered.length);

		// 選択モードのバルクバーは一覧より上（sticky）に出す。何も選ばれていなければ出ない。
		this._renderBulkBar();

		const list = dom.append(this._contentEl, $('.ppe-list'));
		if (presets.length === 0) {
			dom.append(list, $('.ppe-empty')).textContent = STR_EMPTY;
		} else if (filtered.length === 0) {
			dom.append(list, $('.ppe-empty')).textContent = STR_NO_MATCH;
		}

		// ↑↓ の移動可否は「見えている並び（グループ化後）」基準で決める。生の配列（presets）の
		// 隣接で決めると、フォルダに入っていない1件がフォルダを挟んで並んでいるとき、ボタンは
		// 有効なのに見た目が1ミリも動かない（グループの並び順はフォルダの初出位置で決まり、
		// 単純な2件のスワップでは変わらないため）。フォルダをまたぐ移動は隣接スワップでは
		// 正しく表現できないので、単独プリセットの隣（表示上）がフォルダの中身なら押せなくする。
		const displayOrder: { readonly preset: IParadisResolvedPreset; readonly inFolder: boolean }[] = [];
		const groups = paradisGroupPresetsByFolder(filtered);
		for (const group of groups) {
			for (const preset of group.presets) {
				displayOrder.push({ preset, inFolder: !!group.folder });
			}
		}

		for (const group of groups) {
			if (group.folder) {
				this._renderFolderGroup(list, group as IParadisFolderGroup, qualifiers);
				continue;
			}
			const preset = group.presets[0];
			const displayIndex = displayOrder.findIndex(entry => entry.preset === preset);
			const prevEntry = displayIndex > 0 ? displayOrder[displayIndex - 1] : undefined;
			const nextEntry = displayIndex < displayOrder.length - 1 ? displayOrder[displayIndex + 1] : undefined;
			const up = prevEntry && !prevEntry.inFolder && paradisPresetScopeKey(prevEntry.preset) === paradisPresetScopeKey(preset) ? prevEntry.preset : undefined;
			const down = nextEntry && !nextEntry.inFolder && paradisPresetScopeKey(nextEntry.preset) === paradisPresetScopeKey(preset) ? nextEntry.preset : undefined;
			this._renderPresetRow(list, preset, { qualifiers, moveUp: up, moveDown: down });
		}
	}

	/** ヘッダーの「選択」トグルの見た目を現在の _selecting に合わせる。 */
	private _syncSelectToggle(): void {
		this._selectToggleEl.classList.toggle('active', this._selecting);
		this._selectToggleEl.setAttribute('aria-pressed', String(this._selecting));
	}

	/** 左ナビのフィルタ項目（すべて／フォルダ群／(フォルダなし)／出所）を作り直す。 */
	private _renderNavItems(presets: readonly IParadisResolvedPreset[], hitCount: number): void {
		dom.clearNode(this._navItemsEl);
		const hasQuery = this._searchQuery.trim().length > 0;
		this._searchHitsEl.textContent = hasQuery ? strSearchHits(hitCount) : '';

		// 件数バッジは「検索に引っかかる前の総数」基準。検索中にバッジが揺れるとフォルダ間の
		// 比較ができないため（ヒット件数は検索ボックス下に専用表示する）。
		const folderCounts = new Map<string, number>();
		let unfiledCount = 0;
		for (const preset of presets) {
			const folder = preset.folder?.trim();
			if (folder) {
				folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
			} else {
				unfiledCount++;
			}
		}

		const mkItem = (parent: HTMLElement, label: string, options: {
			readonly icon?: ThemeIcon;
			readonly count?: number;
			readonly active: boolean;
			readonly dataset: Record<string, string>;
		}): HTMLButtonElement => {
			const btn = dom.append(parent, $('button.ppe-nav-item')) as HTMLButtonElement;
			btn.type = 'button';
			btn.classList.toggle('on', options.active);
			btn.setAttribute('aria-pressed', String(options.active));
			btn.title = label;
			for (const [key, value] of Object.entries(options.dataset)) {
				btn.dataset[key] = value;
			}
			if (options.icon) {
				dom.append(btn, $('span.ppe-nav-icon')).classList.add(...ThemeIcon.asClassNameArray(options.icon));
			}
			dom.append(btn, $('span.ppe-nav-label')).textContent = label;
			if (options.count !== undefined) {
				dom.append(btn, $('span.ppe-nav-count')).textContent = String(options.count);
			}
			return btn;
		};

		dom.append(this._navItemsEl, $('.ppe-nav-caption')).textContent = STR_NAV_CAPTION_PRESETS;
		mkItem(this._navItemsEl, STR_NAV_ALL, {
			count: presets.length,
			active: this._filter.kind === 'all',
			dataset: { kind: 'all' },
		});

		// フォルダはツリー状に字下げして表示する（paradisDistinctFolderNames の出現順）。
		const folderNames = paradisDistinctFolderNames(presets);
		if (folderNames.length > 0) {
			const tree = dom.append(this._navItemsEl, $('.ppe-nav-tree'));
			for (const name of folderNames) {
				mkItem(tree, name, {
					icon: Codicon.folder,
					count: folderCounts.get(name) ?? 0,
					active: this._filter.kind === 'folder' && this._filter.folder === name,
					dataset: { kind: 'folder', folder: name },
				});
			}
		}
		mkItem(this._navItemsEl, STR_NAV_UNFILED, {
			count: unfiledCount,
			active: this._filter.kind === 'folder' && this._filter.folder === undefined,
			dataset: { kind: 'folder', folder: '' },
		});

		dom.append(this._navItemsEl, $('.ppe-nav-caption')).textContent = STR_NAV_CAPTION_SOURCE;
		mkItem(this._navItemsEl, STR_NAV_SOURCE_USER, {
			active: this._filter.kind === 'source' && this._filter.source === 'user',
			dataset: { kind: 'source', source: 'user' },
		});
		mkItem(this._navItemsEl, STR_NAV_SOURCE_WORKSPACE, {
			active: this._filter.kind === 'source' && this._filter.source === 'workspace',
			dataset: { kind: 'source', source: 'workspace' },
		});
	}

	/** 1件のプリセット行（一覧の直下、またはフォルダの中）。 */
	private _renderPresetRow(
		container: HTMLElement,
		preset: IParadisResolvedPreset,
		options: {
			readonly qualifiers: Map<string, string>;
			readonly moveUp?: IParadisResolvedPreset;
			readonly moveDown?: IParadisResolvedPreset;
		},
	): void {
		const row = dom.append(container, $('.ppe-row'));
		// hosts 条件が現在の接続先と一致しない行は薄く表示する。消さないのは「SSH 先でしか出ない
		// プリセット」を手元から編集する手段を残すため（envInactive のコメント参照）。
		row.classList.toggle('dim', !!preset.envInactive);
		row.dataset.presetKey = preset.key;
		this._rowPresets.set(preset.key, preset);
		this._moveTargets.set(preset.key, { up: options.moveUp, down: options.moveDown });

		if (this._selecting) {
			this._appendCheckbox(row, strSelectPreset(preset.name), this._selectedKeys.has(preset.key), checked => {
				if (checked) {
					this._selectedKeys.add(preset.key);
				} else {
					this._selectedKeys.delete(preset.key);
				}
				this._renderList();
			});
		}

		// grip ハンドル（⋮⋮）。ここから mousedown したときだけ row を draggable にすることで、
		// 「行本文のテキスト選択やボタン押下」と DnD を共存させる。
		const grip = dom.append(row, $('span.ppe-grip'));
		grip.tabIndex = 0;
		// allow-any-unicode-next-line
		grip.textContent = '⋮⋮';
		grip.title = strGripTitle(preset.name);
		grip.setAttribute('aria-label', strGripTitle(preset.name));
		if (!this._selecting) {
			this._viewStore.add(dom.addDisposableListener(grip, 'mousedown', () => {
				row.draggable = true;
			}));
			// ドラッグせずに離したときは draggable を元に戻しておく（次回の mousedown 待ち）。
			this._viewStore.add(dom.addDisposableListener(grip, 'mouseup', () => {
				row.draggable = false;
			}));
		}
		this._wireRowDragAndDrop(row, preset);

		const iconEl = dom.append(row, $('span.ppe-row-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(preset.icon ? ThemeIcon.fromId(preset.icon) : ThemeIcon.fromId('play')));
		const main = dom.append(row, $('.ppe-row-main'));
		const nameLine = dom.append(main, $('.ppe-row-name'));
		nameLine.textContent = preset.name;
		const badge = dom.append(nameLine, $('span.ppe-badge'));
		badge.textContent = preset.source === 'workspace' ? STR_SOURCE_WORKSPACE : STR_SOURCE_USER;
		badge.classList.toggle('workspace', preset.source === 'workspace');
		const qualifier = options.qualifiers.get(preset.key);
		if (qualifier) {
			dom.append(nameLine, $('span.ppe-badge.qualifier')).textContent = qualifier;
		}
		if (preset.locallyHidden) {
			dom.append(nameLine, $('span.ppe-badge.locally-hidden')).textContent = STR_LOCALLY_HIDDEN_BADGE;
		}
		if (preset.envInactive) {
			dom.append(nameLine, $('span.ppe-badge.inactive-warn')).textContent = STR_INACTIVE_BADGE;
		}
		dom.append(main, $('.ppe-row-detail')).textContent = preset.description || paradisPresetCommandSignature(preset, ' && ');

		const actions = dom.append(row, $('.ppe-row-actions'));
		const moveBtn = (label: string, target: IParadisResolvedPreset | undefined): void => {
			const btn = dom.append(actions, $('button.ppe-btn.ppe-task-btn')) as HTMLButtonElement;
			btn.type = 'button';
			btn.textContent = label;
			btn.disabled = !target;
			this._viewStore.add(dom.addDisposableListener(btn, 'click', () => {
				if (target) {
					void this.presetService.swapPresets(preset, target);
				}
			}));
		};
		// allow-any-unicode-next-line
		moveBtn('↑', options.moveUp);
		// allow-any-unicode-next-line
		moveBtn('↓', options.moveDown);
		if (preset.locallyHidden) {
			// タブバーの右クリック「非表示にする」で workspace ソースへ立てたフラグを戻す唯一の入口。
			// 定義元の .paracode.json には触れない（setWorkspacePresetLocallyHidden 参照）。
			const unhideBtn = dom.append(actions, $('button.ppe-btn')) as HTMLButtonElement;
			unhideBtn.textContent = STR_UNHIDE;
			this._viewStore.add(dom.addDisposableListener(unhideBtn, 'click', () => {
				this.presetService.setWorkspacePresetLocallyHidden(preset, false);
			}));
		}
		const runBtn = dom.append(actions, $('button.ppe-btn')) as HTMLButtonElement;
		runBtn.textContent = STR_RUN;
		runBtn.disabled = !!preset.envInactive;
		if (preset.envInactive) {
			// 区別語（qualifier）ではなく hosts 由来の語を載せる。qualifier は appliesTo が優先されるため、
			// リポジトリ指定持ちのプリセットで「実行環境（repo名）」という誤った説明になってしまう。
			runBtn.title = strRunDisabledTooltip(paradisPresetHostsLabel(preset.hosts));
		}
		this._viewStore.add(dom.addDisposableListener(runBtn, 'click', async () => {
			this.dispose();
			await this.presetService.runPreset(preset);
		}));
		const editBtn = dom.append(actions, $('button.ppe-btn')) as HTMLButtonElement;
		editBtn.textContent = STR_EDIT;
		this._viewStore.add(dom.addDisposableListener(editBtn, 'click', () => this._renderEdit(preset)));
		const duplicateBtn = dom.append(actions, $('button.ppe-btn')) as HTMLButtonElement;
		duplicateBtn.textContent = STR_DUPLICATE;
		duplicateBtn.title = strDuplicateName(preset.name);
		this._viewStore.add(dom.addDisposableListener(duplicateBtn, 'click', async () => {
			// 解決済みフィールド（source/sourceUri/sourceIndex/key/locallyHidden/envInactive）は
			// 定義ではないので写さない。id も新しく採番させたいので写さない。
			const tasks = paradisGetPresetTasks(preset);
			const definition: IParadisPresetDefinition = {
				name: strDuplicateName(preset.name),
				description: preset.description,
				folder: preset.folder,
				tasks: tasks.tasks.map(task => ({ name: task.name, cwd: task.cwd, commands: [...task.commands] })),
				layout: tasks.layout,
				icon: preset.icon,
				cwd: preset.cwd,
				pinned: preset.pinned,
				pinnedLabel: preset.pinnedLabel,
				autoRun: preset.autoRun,
				appliesTo: preset.appliesTo ? [...preset.appliesTo] : undefined,
				hosts: preset.hosts ? [...preset.hosts] : undefined,
			};
			try {
				await this.presetService.savePreset(definition, preset.source);
				this._toast(strDuplicatedNotice(definition.name));
			} catch (error) {
				await this.dialogService.error(STR_OPERATION_FAILED, error instanceof Error ? error.message : String(error));
			}
		}));
		const deleteBtn = dom.append(actions, $('button.ppe-btn.ppe-btn-danger')) as HTMLButtonElement;
		deleteBtn.textContent = STR_DELETE;
		this._viewStore.add(dom.addDisposableListener(deleteBtn, 'click', async () => {
			// 同名が並んでいると「どれを消すのか」が名前だけでは分からないので、
			// 消える1件の中身と、残る同名の件数まで書いてから確認する。
			const currentPresets = this.presetService.presets;
			const sameName = currentPresets.filter(candidate => candidate !== preset && candidate.name.trim() === preset.name.trim()).length;
			const detail = [
				qualifier ? `${qualifier}` : undefined,
				paradisPresetCommandSignature(preset, ' && '),
				sameName > 0 ? `\n${strDeleteConfirmOthers(sameName)}` : undefined,
			].filter((line): line is string => !!line).join('\n');
			const result = await this.dialogService.confirm({ message: strDeleteConfirm(preset.name), detail, primaryButton: STR_DELETE });
			if (!result.confirmed) {
				return;
			}
			try {
				await this.presetService.deletePreset(preset);
			} catch (error) {
				// 対象を見失った場合（設定が別の場所で変わった等）。黙って何も起きないと
				// 「削除ボタンが効かない」ようにしか見えないので、理由を出して一覧を作り直す。
				await this.dialogService.error(STR_DELETE_FAILED, error instanceof Error ? error.message : String(error));
				this._renderList();
			}
		}));
	}

	/**
	 * 行のドラッグ＆ドロップ並び替え。grip の mousedown で draggable を立てているので、dragstart は
	 * grip 発のドラッグでしか来ない。drop 先が別フォルダ／別保存先なら swapPresets を呼ばずに
	 * トーストで拒否する（swapPresets 自体もスコープ跨ぎを no-op にしているが、黙って何も起きない
	 * のではなく理由を見せる）。
	 */
	private _wireRowDragAndDrop(row: HTMLElement, preset: IParadisResolvedPreset): void {
		const clearDropMarks = (): void => {
			for (const el of Array.from(this._contentEl.querySelectorAll('.ppe-row.drop-target'))) {
				el.classList.remove('drop-target');
			}
		};
		const finishDrag = (): void => {
			row.draggable = false;
			row.classList.remove('dragging');
			clearDropMarks();
			this._dragging = undefined;
		};
		this._viewStore.add(dom.addDisposableListener(row, 'dragstart', e => {
			if (this._selecting || !row.draggable) {
				e.preventDefault();
				return;
			}
			this._dragging = preset;
			row.classList.add('dragging');
			const transfer = e.dataTransfer;
			if (transfer) {
				transfer.effectAllowed = 'move';
				try {
					transfer.setData('text/plain', preset.name);
				} catch {
					// 一部の環境では setData が例外を投げる。並び替えには使わないデータなので無視。
				}
			}
		}));
		this._viewStore.add(dom.addDisposableListener(row, 'dragend', finishDrag));
		this._viewStore.add(dom.addDisposableListener(row, 'dragover', e => {
			const dragging = this._dragging;
			if (!dragging || dragging.key === preset.key) {
				return;
			}
			if (this._reorderRejection(dragging, preset)) {
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'none';
				}
				return;
			}
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'move';
			}
			row.classList.add('drop-target');
		}));
		this._viewStore.add(dom.addDisposableListener(row, 'dragleave', () => {
			row.classList.remove('drop-target');
		}));
		this._viewStore.add(dom.addDisposableListener(row, 'drop', e => {
			e.preventDefault();
			row.classList.remove('drop-target');
			const dragging = this._dragging;
			if (!dragging || dragging.key === preset.key) {
				finishDrag();
				return;
			}
			finishDrag();
			const rejection = this._reorderRejection(dragging, preset);
			if (rejection === 'folder') {
				this._toast(STR_MOVE_REJECTED_FOLDER);
				return;
			}
			if (rejection === 'scope') {
				this._toast(STR_MOVE_REJECTED_SCOPE);
				return;
			}
			void this.presetService.swapPresets(dragging, preset);
		}));
	}

	/** フォルダ1件（ヘッダー行＋展開時は中身の行）。 */
	private _renderFolderGroup(container: HTMLElement, group: IParadisFolderGroup, qualifiers: Map<string, string>): void {
		const folderKey = `${paradisPresetScopeKey(group.presets[0])}::${group.folder}`;
		const collapsed = this._collapsedFolders.has(folderKey);

		const row = dom.append(container, $('.ppe-row.ppe-folder-row'));
		if (this._selecting) {
			const memberKeys = group.presets.map(preset => preset.key);
			const selectedCount = memberKeys.filter(key => this._selectedKeys.has(key)).length;
			const checkbox = this._appendCheckbox(row, strSelectFolder(group.folder), selectedCount === memberKeys.length, checked => {
				for (const key of memberKeys) {
					if (checked) {
						this._selectedKeys.add(key);
					} else {
						this._selectedKeys.delete(key);
					}
				}
				this._renderList();
			});
			checkbox.indeterminate = selectedCount > 0 && selectedCount < memberKeys.length;
		}
		const toggleBtn = dom.append(row, $('button.ppe-folder-toggle')) as HTMLButtonElement;
		toggleBtn.type = 'button';
		// allow-any-unicode-next-line
		toggleBtn.textContent = collapsed ? '▸' : '▾';
		toggleBtn.setAttribute('aria-label', collapsed ? STR_FOLDER_EXPAND : STR_FOLDER_COLLAPSE);
		toggleBtn.setAttribute('aria-expanded', String(!collapsed));
		this._viewStore.add(dom.addDisposableListener(toggleBtn, 'click', () => {
			if (collapsed) {
				this._collapsedFolders.delete(folderKey);
			} else {
				this._collapsedFolders.add(folderKey);
			}
			this._renderList();
		}));
		dom.append(row, $('span.ppe-row-icon')).classList.add(...ThemeIcon.asClassNameArray(Codicon.folder));
		const main = dom.append(row, $('.ppe-row-main'));
		const nameLine = dom.append(main, $('.ppe-folder-name-line'));
		dom.append(nameLine, $('span.ppe-folder-name')).textContent = group.folder;
		const scopeBadge = dom.append(nameLine, $('span.ppe-badge'));
		scopeBadge.textContent = group.presets[0].source === 'workspace' ? STR_SOURCE_WORKSPACE : STR_SOURCE_USER;
		scopeBadge.classList.toggle('workspace', group.presets[0].source === 'workspace');
		dom.append(nameLine, $('span.ppe-badge')).textContent = strFolderCount(group.presets.length);

		const actions = dom.append(row, $('.ppe-row-actions'));
		const editBtn = dom.append(actions, $('button.ppe-btn')) as HTMLButtonElement;
		editBtn.type = 'button';
		editBtn.textContent = STR_EDIT;
		this._viewStore.add(dom.addDisposableListener(editBtn, 'click', () => this._renderFolderRename(group)));
		const deleteBtn = dom.append(actions, $('button.ppe-btn.ppe-btn-danger')) as HTMLButtonElement;
		deleteBtn.type = 'button';
		deleteBtn.textContent = STR_DELETE;
		this._viewStore.add(dom.addDisposableListener(deleteBtn, 'click', () => this._confirmDeleteFolder(group)));

		if (collapsed) {
			return;
		}
		const children = dom.append(container, $('.ppe-folder-children'));
		children.setAttribute('role', 'group');
		children.setAttribute('aria-label', group.folder);
		group.presets.forEach((preset, memberIndex) => {
			this._renderPresetRow(children, preset, {
				qualifiers,
				moveUp: memberIndex > 0 ? group.presets[memberIndex - 1] : undefined,
				moveDown: memberIndex < group.presets.length - 1 ? group.presets[memberIndex + 1] : undefined,
			});
		});
	}

	private _appendCheckbox(row: HTMLElement, label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLInputElement {
		const checkbox = dom.append(row, $('input.ppe-row-check')) as HTMLInputElement;
		checkbox.type = 'checkbox';
		checkbox.checked = checked;
		checkbox.setAttribute('aria-label', label);
		this._viewStore.add(dom.addDisposableListener(checkbox, 'change', () => onChange(checkbox.checked)));
		return checkbox;
	}

	/** 選択中のプリセットに対する一括操作バー。何も選ばれていなければ何も出さない。 */
	private _renderBulkBar(): void {
		if (!this._selecting || this._selectedKeys.size === 0) {
			return;
		}
		const selected = this.presetService.presets.filter(preset => this._selectedKeys.has(preset.key));
		if (selected.length === 0) {
			return;
		}

		const bar = dom.append(this._contentEl, $('.ppe-bulk-bar'));
		dom.append(bar, $('span.ppe-bulk-count')).textContent = strBulkCount(selected.length);
		const actions = dom.append(bar, $('.ppe-bulk-actions'));

		// hosts 条件が現在の接続先と一致しないもの（envInactive）は一括実行からも外す。
		// 行単位の実行ボタン（disabled にしてある）と同じガード。残りが実行可能なら実行させて
		// よいが、除外があることは確認ダイアログに明示する（黙って一部だけ走るのを避ける）。
		const runnable = selected.filter(preset => !preset.envInactive);
		const skippedCount = selected.length - runnable.length;

		const runBtn = dom.append(actions, $('button.ppe-btn')) as HTMLButtonElement;
		runBtn.type = 'button';
		runBtn.textContent = STR_RUN;
		if (runnable.length === 0) {
			runBtn.disabled = true;
			runBtn.title = STR_BULK_RUN_ALL_INACTIVE;
		}
		this._viewStore.add(dom.addDisposableListener(runBtn, 'click', async () => {
			// 削除と同じく、まとまった数を1クリックでノークリック実行させない
			// （layout: 'current' のプリセットが複数選ばれていると、同じ端末へ次々流し込むことにもなる）。
			if (selected.length >= BULK_RUN_CONFIRM_THRESHOLD || skippedCount > 0) {
				const result = await this.dialogService.confirm({
					message: strBulkRunMessage(runnable.length),
					detail: [
						runnable.map(preset => preset.name).join(', '),
						skippedCount > 0 ? strBulkRunSkipped(skippedCount) : undefined,
					].filter((line): line is string => !!line).join('\n'),
					primaryButton: STR_RUN,
				});
				if (!result.confirmed) {
					return;
				}
			}
			this.dispose();
			const failed: string[] = [];
			for (const preset of runnable) {
				try {
					await this.presetService.runPreset(preset);
				} catch {
					// 1件失敗しても残りは続ける。ダイアログは既に閉じているので、失敗はまとめて
					// 最後に知らせる（黙って一部だけ実行されなかった、を防ぐ）。
					failed.push(preset.name);
				}
			}
			if (failed.length > 0) {
				await this.dialogService.error(STR_BULK_RUN_FAILED, failed.join(', '));
			}
		}));

		const moveBtn = dom.append(actions, $('button.ppe-btn')) as HTMLButtonElement;
		moveBtn.type = 'button';
		moveBtn.textContent = STR_BULK_MOVE;
		this._viewStore.add(dom.addDisposableListener(moveBtn, 'click', () => this._showMoveToFolderMenu(moveBtn, selected)));

		const unfileBtn = dom.append(actions, $('button.ppe-btn')) as HTMLButtonElement;
		unfileBtn.type = 'button';
		unfileBtn.textContent = STR_BULK_UNFILE;
		this._viewStore.add(dom.addDisposableListener(unfileBtn, 'click', async () => {
			try {
				await this.presetService.setPresetsFolder(selected, undefined);
				this._selectedKeys.clear();
				this._renderList();
			} catch (error) {
				await this.dialogService.error(STR_OPERATION_FAILED, error instanceof Error ? error.message : String(error));
				this._renderList();
			}
		}));

		const deleteBtn = dom.append(actions, $('button.ppe-btn.ppe-btn-danger')) as HTMLButtonElement;
		deleteBtn.type = 'button';
		deleteBtn.textContent = STR_DELETE;
		this._viewStore.add(dom.addDisposableListener(deleteBtn, 'click', async () => {
			const result = await this.dialogService.confirm({
				message: strBulkDeleteMessage(selected.length),
				detail: selected.map(preset => preset.name).join(', '),
				primaryButton: STR_DELETE,
			});
			if (!result.confirmed) {
				return;
			}
			try {
				await this.presetService.deletePresets(selected);
				this._selectedKeys.clear();
				this._renderList();
			} catch (error) {
				await this.dialogService.error(STR_DELETE_FAILED, error instanceof Error ? error.message : String(error));
				this._renderList();
			}
		}));

		const clearBtn = dom.append(bar, $('button.ppe-bulk-clear')) as HTMLButtonElement;
		clearBtn.type = 'button';
		// allow-any-unicode-next-line
		clearBtn.textContent = '✕';
		clearBtn.title = STR_BULK_CLEAR;
		this._viewStore.add(dom.addDisposableListener(clearBtn, 'click', () => {
			this._selectedKeys.clear();
			this._renderList();
		}));
	}

	/** 「フォルダへ移動」ボタンから開くコンテキストメニュー（既存フォルダ一覧＋新規作成）。 */
	private _showMoveToFolderMenu(anchor: HTMLElement, selected: readonly IParadisResolvedPreset[]): void {
		const folderNames = paradisDistinctFolderNames(this.presetService.presets);
		const actions: IAction[] = folderNames.map(name => toAction({
			id: `paradis.presetEditor.moveToFolder.${name}`,
			label: name,
			class: ThemeIcon.asClassName(Codicon.folder),
			run: async () => {
				try {
					await this.presetService.setPresetsFolder(selected, name);
					this._selectedKeys.clear();
					this._renderList();
				} catch (error) {
					await this.dialogService.error(STR_OPERATION_FAILED, error instanceof Error ? error.message : String(error));
					this._renderList();
				}
			},
		}));
		if (actions.length > 0) {
			actions.push(new Separator());
		}
		actions.push(toAction({
			id: 'paradis.presetEditor.moveToFolder.new',
			label: STR_BULK_MOVE_NEW_FOLDER,
			class: ThemeIcon.asClassName(Codicon.newFolder),
			run: () => this._renderFolderCreate(selected),
		}));
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}

	/** 右コンテンツ共通の見出し＋ form-grid の組み立て。フォルダ名変更・新規フォルダでも使う。 */
	private _openEditPane(title: string): { readonly grid: HTMLElement } {
		dom.clearNode(this._contentEl);
		dom.append(this._contentEl, $('h3.ppe-edit-heading')).textContent = title;
		const grid = dom.append(this._contentEl, $('.ppe-form-grid'));
		return { grid };
	}

	/** Settings 行スタイル（左ラベル列＝右寄せ／右コントロール列）の1行を足す。 */
	private _formRow(grid: HTMLElement, label: string | undefined): HTMLElement {
		if (label !== undefined) {
			dom.append(grid, $('div.ppe-flabel')).textContent = label;
		} else {
			// ラベルなし行（「＋ ターミナルを追加」など）。グリッドの段組みを保つために空セルを置く。
			dom.append(grid, $('div.ppe-flabel'));
		}
		return dom.append(grid, $('div.ppe-fcontrol'));
	}

	/** フォルダ名の変更ビュー。既存メンバー全員の folder を書き換える。 */
	private _renderFolderRename(group: IParadisFolderGroup): void {
		this._mode = 'edit';
		this._viewStore.clear();
		const { grid } = this._openEditPane(strFolderRenameTitle(group.folder));

		const control = this._formRow(grid, STR_FOLDER_NAME);
		const nameInput = dom.append(control, $('input.ppe-input')) as HTMLInputElement;
		nameInput.type = 'text';
		nameInput.value = group.folder;

		const errorEl = dom.append(this._contentEl, $('.ppe-error'));
		const footer = dom.append(this._contentEl, $('.ppe-footer'));
		const backBtn = dom.append(footer, $('button.ppe-btn')) as HTMLButtonElement;
		backBtn.textContent = STR_BACK;
		this._viewStore.add(dom.addDisposableListener(backBtn, 'click', () => this._renderList()));
		const saveBtn = dom.append(footer, $('button.ppe-btn.ppe-btn-primary')) as HTMLButtonElement;
		saveBtn.textContent = STR_SAVE;
		this._viewStore.add(dom.addDisposableListener(saveBtn, 'click', async () => {
			const name = nameInput.value.trim();
			if (!name) {
				errorEl.textContent = STR_FOLDER_NAME_REQUIRED;
				return;
			}
			try {
				await this.presetService.setPresetsFolder(group.presets, name);
				this._renderList();
			} catch (error) {
				errorEl.textContent = error instanceof Error ? error.message : String(error);
			}
		}));
	}

	/** 新しいフォルダを作るビュー。選択済みの1件以上を新しいフォルダ名へ移す。空フォルダは作れない。 */
	private _renderFolderCreate(members: readonly IParadisResolvedPreset[]): void {
		this._mode = 'edit';
		this._viewStore.clear();
		const { grid } = this._openEditPane(strFolderCreateTitle());

		const control = this._formRow(grid, STR_FOLDER_NAME);
		const nameInput = dom.append(control, $('input.ppe-input')) as HTMLInputElement;
		nameInput.type = 'text';
		nameInput.placeholder = STR_FOLDER_PLACEHOLDER;
		dom.append(control, $('.ppe-hint')).textContent = strFolderCreateHint(members.length);

		const errorEl = dom.append(this._contentEl, $('.ppe-error'));
		const footer = dom.append(this._contentEl, $('.ppe-footer'));
		const backBtn = dom.append(footer, $('button.ppe-btn')) as HTMLButtonElement;
		backBtn.textContent = STR_BACK;
		this._viewStore.add(dom.addDisposableListener(backBtn, 'click', () => this._renderList()));
		const createBtn = dom.append(footer, $('button.ppe-btn.ppe-btn-primary')) as HTMLButtonElement;
		createBtn.textContent = STR_FOLDER_CREATE;
		this._viewStore.add(dom.addDisposableListener(createBtn, 'click', async () => {
			const name = nameInput.value.trim();
			if (!name) {
				errorEl.textContent = STR_FOLDER_NAME_REQUIRED;
				return;
			}
			try {
				await this.presetService.setPresetsFolder(members, name);
				this._selectedKeys.clear();
				this._renderList();
			} catch (error) {
				errorEl.textContent = error instanceof Error ? error.message : String(error);
			}
		}));
	}

	/**
	 * フォルダ削除の確認。中身をどうするか（残す／消す）を選ばせる——「フォルダを消したつもりが
	 * 中のプリセットまで消えていた」という取り返しの付かない事故を避けるため、既定の1クリックには
	 * しない。
	 */
	private async _confirmDeleteFolder(group: IParadisFolderGroup): Promise<void> {
		const { result } = await this.dialogService.prompt<IDeleteFolderDecision>({
			message: strDeleteFolderMessage(group.folder),
			detail: strDeleteFolderDetail(group.presets.length),
			buttons: [
				{ label: STR_DELETE_FOLDER_KEEP, run: (): IDeleteFolderDecision => 'keep' },
				{ label: strDeleteFolderAll(group.presets.length), run: (): IDeleteFolderDecision => 'deleteAll' },
			],
			cancelButton: { label: STR_CONFLICT_CANCEL, run: (): IDeleteFolderDecision => undefined },
		});
		if (!result) {
			return;
		}
		try {
			if (result === 'keep') {
				await this.presetService.setPresetsFolder(group.presets, undefined);
			} else {
				await this.presetService.deletePresets(group.presets);
			}
			this._selectedKeys.clear();
			this._renderList();
		} catch (error) {
			await this.dialogService.error(STR_DELETE_FAILED, error instanceof Error ? error.message : String(error));
			this._renderList();
		}
	}

	// --- 編集ビュー -------------------------------------------------------------------------------

	private _renderEdit(editing: IParadisResolvedPreset | undefined): void {
		this._mode = 'edit';
		this._viewStore.clear();
		this._syncSelectToggle();
		const { grid } = this._openEditPane(editing ? `${STR_TITLE} — ${editing.name}` : `${STR_TITLE} — ${STR_NEW}`);

		// Settings 行スタイル: field() が「右寄せラベル列＋コントロール列」の1行を生む。
		// label 省略時は空のラベルセルを置く（「＋ ターミナルを追加」などラベルを持たない行用）。
		const field = (label?: string): HTMLElement => this._formRow(grid, label);

		const nameField = field(STR_NAME);
		const nameInput = dom.append(nameField, $('input.ppe-input')) as HTMLInputElement;
		nameInput.type = 'text';
		nameInput.value = editing?.name ?? '';
		// 押す前に気づけるようにする。保存時の確認（下の _resolveNameConflict）は最後の砦で、
		// ここで分かれば「名前を変える」「そのまま2件にする」をその場で決められる。
		const nameHint = dom.append(nameField, $('.ppe-hint.ppe-hint-warn'));
		// 数える相手は「これから書き込む先」に居るものだけ。ユーザー設定とリポジトリで
		// 同じ名前を使うのは衝突ではないので、そこまで数えると出なくてよい注意が出る。
		let hintTarget: ParadisPresetSource = editing?.source ?? 'user';
		const updateNameHint = () => {
			const name = nameInput.value.trim();
			const sameName = name
				? this._presetsInSaveTarget(hintTarget, editing).filter(candidate => candidate.key !== editing?.key && candidate.name.trim() === name).length
				: 0;
			nameHint.textContent = sameName === 0 ? '' : (editing ? strSameNameHintEdit(sameName) : strSameNameHintNew(sameName));
			nameInput.classList.toggle('warn', sameName > 0);
		};
		updateNameHint();
		this._viewStore.add(dom.addDisposableListener(nameInput, 'input', updateNameHint));

		const descriptionInput = dom.append(field(STR_DESCRIPTION), $('input.ppe-input')) as HTMLInputElement;
		descriptionInput.type = 'text';
		descriptionInput.value = editing?.description ?? '';

		const folderField = field(STR_FOLDER);
		const folderInput = dom.append(folderField, $('input.ppe-input')) as HTMLInputElement;
		folderInput.type = 'text';
		folderInput.placeholder = STR_FOLDER_PLACEHOLDER;
		folderInput.value = editing?.folder ?? '';
		const folderNames = paradisDistinctFolderNames(this.presetService.presets);
		if (folderNames.length > 0) {
			const datalist = dom.append(folderField, $('datalist#ppe-folder-datalist'));
			for (const name of folderNames) {
				dom.append(datalist, $('option')).setAttribute('value', name);
			}
			folderInput.setAttribute('list', 'ppe-folder-datalist');
		}

		// タスク（＝ターミナル）カードの編集領域。ドラフトは配列で持ち、追加・削除・並べ替えのたびに再描画する
		interface ITaskDraft { name: string; cwd: string; commands: string }
		const initialTasks: readonly IParadisPresetTask[] = editing ? paradisGetPresetTasks(editing).tasks : [];
		const taskDrafts: ITaskDraft[] = initialTasks.length > 0
			? initialTasks.map(task => ({ name: task.name ?? '', cwd: task.cwd ?? '', commands: task.commands.join('\n') }))
			: [{ name: '', cwd: '', commands: '' }];
		const tasksField = field(STR_TASKS);
		const tasksContainer = dom.append(tasksField, $('.ppe-tasks'));
		const addTaskBtn = dom.append(field(), $('button.ppe-btn.ppe-add-task')) as HTMLButtonElement;
		addTaskBtn.type = 'button';
		addTaskBtn.textContent = STR_ADD_TASK;
		// 再描画のたびにカード内リスナーを作り直すため、カード群専用の store を分ける
		const tasksStore = this._viewStore.add(new MutableDisposable<DisposableStore>());
		const renderTasks = () => {
			const store = tasksStore.value = new DisposableStore();
			dom.clearNode(tasksContainer);
			taskDrafts.forEach((draft, index) => {
				const card = dom.append(tasksContainer, $('.ppe-task-card'));
				const head = dom.append(card, $('.ppe-task-head'));
				const nameInput = dom.append(head, $('input.ppe-input.ppe-task-name')) as HTMLInputElement;
				nameInput.type = 'text';
				nameInput.placeholder = STR_TASK_NAME;
				nameInput.value = draft.name;
				store.add(dom.addDisposableListener(nameInput, 'input', () => { draft.name = nameInput.value; }));
				const cwdInput = dom.append(head, $('input.ppe-input.ppe-task-cwd')) as HTMLInputElement;
				cwdInput.type = 'text';
				cwdInput.placeholder = STR_TASK_CWD;
				cwdInput.spellcheck = false;
				cwdInput.value = draft.cwd;
				store.add(dom.addDisposableListener(cwdInput, 'input', () => { draft.cwd = cwdInput.value; }));
				const headBtn = (label: string, disabled: boolean, onClick: () => void): void => {
					const btn = dom.append(head, $('button.ppe-btn.ppe-task-btn')) as HTMLButtonElement;
					btn.type = 'button';
					btn.textContent = label;
					btn.disabled = disabled;
					store.add(dom.addDisposableListener(btn, 'click', onClick));
				};
				// allow-any-unicode-next-line
				headBtn('↑', index === 0, () => {
					[taskDrafts[index - 1], taskDrafts[index]] = [taskDrafts[index], taskDrafts[index - 1]];
					renderTasks();
				});
				// allow-any-unicode-next-line
				headBtn('↓', index === taskDrafts.length - 1, () => {
					[taskDrafts[index + 1], taskDrafts[index]] = [taskDrafts[index], taskDrafts[index + 1]];
					renderTasks();
				});
				// allow-any-unicode-next-line
				headBtn('✕', taskDrafts.length === 1, () => {
					taskDrafts.splice(index, 1);
					renderTasks();
				});
				const commandsInput = dom.append(card, $('textarea.ppe-input.ppe-commands')) as HTMLTextAreaElement;
				commandsInput.rows = 3;
				commandsInput.spellcheck = false;
				commandsInput.placeholder = STR_TASK_COMMANDS_PLACEHOLDER;
				commandsInput.value = draft.commands;
				store.add(dom.addDisposableListener(commandsInput, 'input', () => { draft.commands = commandsInput.value; }));
			});
		};
		renderTasks();
		this._viewStore.add(dom.addDisposableListener(addTaskBtn, 'click', () => {
			taskDrafts.push({ name: '', cwd: '', commands: '' });
			renderTasks();
		}));

		const layoutSelect = dom.append(field(STR_LAYOUT), $('select.ppe-input.ppe-select')) as HTMLSelectElement;
		for (const { layout, label } of LAYOUT_LABELS) {
			const option = dom.append(layoutSelect, $('option')) as HTMLOptionElement;
			option.value = layout;
			option.textContent = label;
		}
		layoutSelect.value = editing ? paradisGetPresetTasks(editing).layout : 'tabs';

		const iconField = field(STR_ICON);
		const iconRow = dom.append(iconField, $('.ppe-icon-row'));
		const iconInput = dom.append(iconRow, $('input.ppe-input.ppe-icon-input')) as HTMLInputElement;
		iconInput.type = 'text';
		iconInput.placeholder = 'play';
		iconInput.value = editing?.icon ?? '';
		const iconPreview = dom.append(iconRow, $('span.ppe-icon-preview'));
		const iconGrid = dom.append(iconField, $('.ppe-icon-grid'));
		const updateIconPreview = () => {
			iconPreview.className = 'ppe-icon-preview';
			const iconId = iconInput.value.trim() || 'play';
			iconPreview.classList.add(...ThemeIcon.asClassNameArray(ThemeIcon.fromId(iconId)));
		};
		// セルは一度だけ生成し、絞り込みは表示切替のみで行う（約750個のDOM再構築を
		// キーストロークごとに繰り返さないため）
		const iconGridEmpty = dom.append(iconGrid, $('.ppe-icon-grid-empty'));
		iconGridEmpty.textContent = STR_ICON_EMPTY;
		const iconCells: { readonly id: string; readonly cell: HTMLButtonElement }[] = [];
		for (const icon of ALL_CODICONS) {
			const cell = dom.append(iconGrid, $('button.ppe-icon-cell')) as HTMLButtonElement;
			cell.type = 'button';
			cell.title = icon.id;
			cell.dataset.iconId = icon.id;
			cell.appendChild($(`span${ThemeIcon.asCSSSelector(icon)}`));
			iconCells.push({ id: icon.id, cell });
		}
		const renderIconGrid = () => {
			const filter = iconInput.value.trim().toLowerCase();
			let visible = 0;
			for (const { id, cell } of iconCells) {
				const show = !filter || id.includes(filter);
				cell.style.display = show ? '' : 'none';
				cell.classList.toggle('selected', id === filter);
				if (show) {
					visible++;
				}
			}
			iconGridEmpty.style.display = visible === 0 ? '' : 'none';
		};
		updateIconPreview();
		renderIconGrid();
		this._viewStore.add(dom.addDisposableListener(iconInput, 'input', () => {
			updateIconPreview();
			renderIconGrid();
		}));
		// クリックはセルごとではなくグリッド1箇所に委譲する（絞り込みのたびのリスナー蓄積を避ける）
		this._viewStore.add(dom.addDisposableListener(iconGrid, 'click', e => {
			const cell = (e.target as HTMLElement).closest<HTMLElement>('.ppe-icon-cell');
			const iconId = cell?.dataset.iconId;
			if (iconId) {
				iconInput.value = iconId;
				updateIconPreview();
				renderIconGrid();
			}
		}));

		const cwdInput = dom.append(field(STR_CWD), $('input.ppe-input')) as HTMLInputElement;
		cwdInput.type = 'text';
		cwdInput.placeholder = './apps/web';
		cwdInput.spellcheck = false;
		cwdInput.value = editing?.cwd ?? '';

		// 「表示」グループ（ピン留めまわり＋ autoRun）。Settings 行としては1つの行にまとめる。
		const checkbox = (label: string, checked: boolean, parent: HTMLElement): HTMLInputElement => {
			const wrap = dom.append(parent, $('.ppe-check-row'));
			const input = dom.append(wrap, $('input.ppe-checkbox')) as HTMLInputElement;
			input.type = 'checkbox';
			input.checked = checked;
			const labelEl = dom.append(wrap, $('label.ppe-check-label'));
			labelEl.textContent = label;
			this._viewStore.add(dom.addDisposableListener(labelEl, 'click', () => {
				input.checked = !input.checked;
				// ラベルクリックでのトグルでも change 連動（pinnedLabel の表示切替・ホスト欄の
				// 出し崩しなど）を効かせる
				input.dispatchEvent(new Event('change'));
			}));
			return input;
		};
		const displayControl = field(STR_DISPLAY);
		const pinnedInput = checkbox(STR_PINNED, editing?.pinned !== false, displayControl);
		const pinnedLabelInput = checkbox(STR_PINNED_LABEL, editing?.pinnedLabel === true, displayControl);
		const pinnedLabelRow = pinnedLabelInput.parentElement as HTMLElement;
		pinnedLabelRow.classList.add('ppe-check-row-sub');
		const updatePinnedLabelVisibility = () => {
			pinnedLabelRow.style.display = pinnedInput.checked ? '' : 'none';
		};
		updatePinnedLabelVisibility();
		this._viewStore.add(dom.addDisposableListener(pinnedInput, 'change', updatePinnedLabelVisibility));
		const autoRunInput = checkbox(STR_AUTORUN, editing?.autoRun === true, displayControl);
		dom.append(displayControl, $('.ppe-check-hint')).textContent = STR_AUTORUN_HINT;

		// 保存先（既存編集時は変更不可）
		const folder = this.contextService.getWorkspace().folders[0];
		const targetField = field(STR_TARGET);
		const targetRow = dom.append(targetField, $('.ppe-target-row'));
		const makeTargetRadio = (value: ParadisPresetSource, label: string, disabled: boolean): HTMLInputElement => {
			const wrap = dom.append(targetRow, $('.ppe-check-row'));
			const input = dom.append(wrap, $('input.ppe-radio')) as HTMLInputElement;
			input.type = 'radio';
			input.name = 'ppe-target';
			input.value = value;
			input.disabled = disabled;
			const labelEl = dom.append(wrap, $('label.ppe-check-label'));
			labelEl.textContent = label;
			if (!disabled) {
				this._viewStore.add(dom.addDisposableListener(labelEl, 'click', () => {
					input.checked = true;
					updateAppliesToVisibility();
				}));
			}
			return input;
		};
		const userRadio = makeTargetRadio('user', STR_TARGET_USER, !!editing);
		const workspaceRadio = makeTargetRadio('workspace', folder ? strTargetWorkspace(basename(folder.uri)) : PARADIS_WORKSPACE_PRESET_FILE, !!editing || !folder);
		if (editing) {
			(editing.source === 'workspace' ? workspaceRadio : userRadio).checked = true;
			(editing.source === 'workspace' ? workspaceRadio : userRadio).disabled = false;
			(editing.source === 'workspace' ? userRadio : workspaceRadio).disabled = true;
		} else {
			userRadio.checked = true;
		}

		// 実行環境（hosts 条件）。ローカル／リモートの2チェックに、リモート側だけホストの絞り込み
		// （チップ）を組み合わせる。「local ∧ 特定ホスト」のような組合せを素直に表すため、
		// 排他的なプルダウンではなくチェックの組合せにしている。
		// 保存値との対応: ['local', <ホスト名…>] ⇔ ローカル☑ ＋ ホスト列挙（'remote' リテラルは
		// 「ホスト未指定のリモート」のときだけ書く。ホスト列挙があれば remote は自明なので冗長）。
		const initialHosts = editing?.hosts?.map(entry => entry.trim()).filter(entry => entry.length > 0) ?? [];
		// 手編集された設定に 'remote' とホスト名が併記されていた場合（例: ['remote', 'gpu01']）、
		// この UI では表現できない。'remote'（どのホストでも）の方が広い条件なのでそちらを採用し、
		// チップを捨てる——逆（チップだけ残す）だと、保存時に「gpu01 のみ」へ静かに縮んでしまう。
		const hasRemoteLiteral = initialHosts.includes(PARADIS_PRESET_HOST_REMOTE);
		const hostChips = hasRemoteLiteral ? [] : initialHosts.filter(entry => entry !== PARADIS_PRESET_HOST_LOCAL && entry !== PARADIS_PRESET_HOST_REMOTE);
		const hostEnvField = field(STR_HOST_ENV);
		const hostLocalInput = checkbox(STR_HOST_LOCAL, initialHosts.includes(PARADIS_PRESET_HOST_LOCAL), hostEnvField);
		const hostRemoteInput = checkbox(STR_HOST_REMOTE, hasRemoteLiteral || hostChips.length > 0, hostEnvField);
		dom.append(hostEnvField, $('.ppe-check-hint')).textContent = STR_HOST_ENV_HINT_ANY;

		const hostChipsWrap = dom.append(hostEnvField, $('.ppe-check-row-sub.ppe-host-chips'));
		const hostChipsLabel = dom.append(hostChipsWrap, $('label.ppe-label'));
		hostChipsLabel.textContent = STR_HOST_CHIPS_LABEL;
		const chipsRow = dom.append(hostChipsWrap, $('.ppe-chips-row'));
		// チップ群だけを作り直し、追加入力は作り直さない——input ごと再構成すると Enter 追加の
		// たびにフォーカスが飛んで連続入力できない。
		const chipsList = dom.append(chipsRow, $('span.ppe-chips-list'));
		const chipInput = dom.append(chipsRow, $('input.ppe-input.ppe-chip-input')) as HTMLInputElement;
		chipInput.type = 'text';
		chipInput.placeholder = STR_HOST_CHIP_INPUT_PLACEHOLDER;
		chipInput.spellcheck = false;
		const addChipFromInput = (): void => {
			const value = chipInput.value.trim();
			chipInput.value = '';
			if (!value || hostChips.some(existing => existing.toLowerCase() === value.toLowerCase())) {
				return;
			}
			hostChips.push(value);
			renderChips();
			chipInput.focus();
		};
		this._viewStore.add(dom.addDisposableListener(chipInput, 'keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				addChipFromInput();
			}
		}));
		const chipsHint = dom.append(hostChipsWrap, $('.ppe-hint'));
		const renderChips = (): void => {
			dom.clearNode(chipsList);
			for (const [index, host] of hostChips.entries()) {
				const chip = dom.append(chipsList, $('span.ppe-chip'));
				chip.textContent = host;
				const removeBtn = dom.append(chip, $('button.ppe-chip-x')) as HTMLButtonElement;
				removeBtn.type = 'button';
				removeBtn.textContent = '✕';
				removeBtn.title = STR_HOST_CHIP_REMOVE;
				removeBtn.setAttribute('aria-label', `${STR_HOST_CHIP_REMOVE}: ${host}`);
				this._viewStore.add(dom.addDisposableListener(removeBtn, 'click', () => {
					hostChips.splice(index, 1);
					renderChips();
					chipInput.focus();
				}));
			}
		};
		const updateHostChipsEnabled = (): void => {
			// ホストの絞り込みはリモート側の話（SSH 先を列挙するもの）。ローカルのみなら無効化して
			// 「触っても効かない」状態を見せる。
			const enabled = hostRemoteInput.checked;
			hostChipsWrap.classList.toggle('disabled', !enabled);
			chipsHint.textContent = enabled ? '' : STR_HOST_CHIPS_HINT_REMOTE_OFF;
		};
		renderChips();
		updateHostChipsEnabled();
		this._viewStore.add(dom.addDisposableListener(hostRemoteInput, 'change', updateHostChipsEnabled));
		// 手入力の補完候補は、既存プリセットが実際に使っているホスト名（特殊値を除く）。
		// フォルダ欄と同じく、フォームを開いた時点の一覧で一度だけ作る。
		const knownHosts = [...new Set(this.presetService.presets
			.flatMap(preset => preset.hosts ?? [])
			.filter(entry => entry !== PARADIS_PRESET_HOST_LOCAL && entry !== PARADIS_PRESET_HOST_REMOTE))]
			.sort((a, b) => a.localeCompare(b));
		if (knownHosts.length > 0) {
			const datalist = dom.append(hostChipsWrap, $('datalist#ppe-host-datalist'));
			for (const name of knownHosts) {
				dom.append(datalist, $('option')).setAttribute('value', name);
			}
			chipInput.setAttribute('list', 'ppe-host-datalist');
		}

		// appliesTo（保存先がユーザー設定のときのみ表示）。グリッドの段組みごと消すため、
		// ラベル列とコントロール列の両方を握っておく。
		const appliesToLabel = dom.append(grid, $('div.ppe-flabel'));
		appliesToLabel.textContent = STR_APPLIES_TO;
		const appliesToField = dom.append(grid, $('div.ppe-fcontrol'));
		const appliesToInput = dom.append(appliesToField, $('textarea.ppe-input')) as HTMLTextAreaElement;
		appliesToInput.rows = 2;
		appliesToInput.spellcheck = false;
		appliesToInput.value = editing?.appliesTo?.join('\n') ?? '';
		const updateAppliesToVisibility = () => {
			for (const cell of [appliesToLabel, appliesToField]) {
				cell.style.display = userRadio.checked ? '' : 'none';
			}
			// 保存先が変われば「同じ名前が何件あるか」も変わる
			hintTarget = workspaceRadio.checked ? 'workspace' : 'user';
			updateNameHint();
		};
		updateAppliesToVisibility();
		for (const radio of [userRadio, workspaceRadio]) {
			this._viewStore.add(dom.addDisposableListener(radio, 'change', updateAppliesToVisibility));
		}

		const errorEl = dom.append(this._contentEl, $('.ppe-error'));

		const footer = dom.append(this._contentEl, $('.ppe-footer'));
		const backBtn = dom.append(footer, $('button.ppe-btn')) as HTMLButtonElement;
		backBtn.textContent = STR_BACK;
		this._viewStore.add(dom.addDisposableListener(backBtn, 'click', () => this._renderList()));
		const saveBtn = dom.append(footer, $('button.ppe-btn.ppe-btn-primary')) as HTMLButtonElement;
		saveBtn.textContent = STR_SAVE;
		this._viewStore.add(dom.addDisposableListener(saveBtn, 'click', async () => {
			const name = nameInput.value.trim();
			if (!name) {
				errorEl.textContent = STR_NAME_REQUIRED;
				return;
			}
			const tasks: IParadisPresetTask[] = taskDrafts
				.map(draft => ({
					name: draft.name.trim() || undefined,
					cwd: draft.cwd.trim() || undefined,
					commands: draft.commands.split('\n').map(line => line.trim()).filter(line => line.length > 0),
				}))
				.filter(task => task.commands.length > 0);
			if (tasks.length === 0) {
				errorEl.textContent = STR_COMMANDS_REQUIRED;
				return;
			}
			const appliesTo = appliesToInput.value.split('\n').map(line => line.trim()).filter(line => line.length > 0);
			// hosts 条件を UI の状態から組み立てる。ホスト列挙があるときは 'remote' リテラルを
			// 書かない（列挙が「リモート有効＋絞り込み」を含意するため冗長。読み込み側は
			// 列挙の存在で remote チェックを復元する）。
			const hostEntries: string[] = [];
			if (hostLocalInput.checked) {
				hostEntries.push(PARADIS_PRESET_HOST_LOCAL);
			}
			if (hostRemoteInput.checked) {
				hostEntries.push(...(hostChips.length > 0 ? hostChips : [PARADIS_PRESET_HOST_REMOTE]));
			}
			// 保存は常に新形式（tasks + layout）。旧形式の commands / launchMode はここで移行される
			const definition: IParadisPresetDefinition = {
				name,
				description: descriptionInput.value.trim() || undefined,
				folder: folderInput.value.trim() || undefined,
				tasks,
				layout: layoutSelect.value as ParadisPresetLayout,
				icon: iconInput.value.trim() || undefined,
				cwd: cwdInput.value.trim() || undefined,
				pinned: pinnedInput.checked,
				pinnedLabel: pinnedInput.checked && pinnedLabelInput.checked ? true : undefined,
				autoRun: autoRunInput.checked,
				appliesTo: userRadio.checked && appliesTo.length > 0 ? appliesTo : undefined,
				hosts: hostEntries.length > 0 ? hostEntries : undefined,
			};
			const target: ParadisPresetSource = workspaceRadio.checked ? 'workspace' : 'user';
			const decision = await this._resolveNameConflict(definition, target, editing);
			if (decision.kind === 'cancel') {
				return;
			}
			if (decision.kind === 'blocked') {
				errorEl.textContent = decision.message;
				return;
			}
			try {
				await this.presetService.savePreset(definition, target, { replace: decision.replace });
				this._renderList();
			} catch (error) {
				errorEl.textContent = error instanceof Error ? error.message : String(error);
			}
		}));
	}

	/**
	 * その保存先に実際に書き込まれる既存プリセット。**書き込み先のファイル単位で絞る。**
	 * 複数のリポジトリを開いていると `presets` には別リポジトリの .paracode.json 由来も混ざり、
	 * それを衝突相手として置き換えると、触るつもりのないリポジトリのファイルが書き換わる。
	 */
	private _presetsInSaveTarget(target: ParadisPresetSource, editing: IParadisResolvedPreset | undefined): IParadisResolvedPreset[] {
		const folder = this.contextService.getWorkspace().folders[0];
		const targetFile = target === 'workspace'
			? (editing?.sourceUri ?? (folder ? joinPath(folder.uri, PARADIS_WORKSPACE_PRESET_FILE) : undefined))
			: undefined;
		return this.presetService.presets.filter(candidate => candidate.source === target
			&& (target === 'user' || candidate.sourceUri?.toString() === targetFile?.toString()));
	}

	/**
	 * 保存しようとしている定義が既存と名前で衝突したときの行き先を決める。
	 *
	 * 同名そのものは許す（対象リポジトリごとに「起動」を持つ、といった使い方は自然なため）。
	 * 止めるのは「並べても見分けが付かない」場合だけ。
	 *
	 * **置き換え先は必ず「衝突した相手」か「編集中の当人」に限る。** 同名の先頭を機械的に
	 * 置き換えると、3件目と衝突したのに1件目を潰す、といった取り違えが起きる。
	 * 編集では他を消す道を一切出さない（当人を書き換える操作であって、削除ではない）。
	 */
	private async _resolveNameConflict(
		definition: IParadisPresetDefinition,
		target: ParadisPresetSource,
		editing: IParadisResolvedPreset | undefined,
	): Promise<ISaveDecision> {
		const others = this._presetsInSaveTarget(target, editing).filter(candidate => candidate.key !== editing?.key);
		const conflict = paradisFindPresetNameConflict(definition, others);
		if (conflict.kind === ParadisPresetNameConflict.None) {
			return { kind: 'save', replace: editing };
		}
		if (editing) {
			// 編集で「まったく見分けが付かない」状態になるのは、この1件を直したいのか相手を
			// 消したいのかが読めない。ここで止めて、名前か説明を変えてもらう。
			return conflict.kind === ParadisPresetNameConflict.Indistinguishable
				? { kind: 'blocked', message: STR_INDISTINGUISHABLE_DETAIL }
				: { kind: 'save', replace: editing };
		}
		if (conflict.kind === ParadisPresetNameConflict.Indistinguishable) {
			// 見分けが付かないのは名前・区別語・説明であって、コマンドは違うのが普通。
			// 何が消えるのかを出さずに「置き換える」を押させない。
			const replaced = conflict.indistinguishableFrom;
			const result = await this.dialogService.confirm({
				message: STR_INDISTINGUISHABLE_MESSAGE,
				detail: [
					replaced ? strExistingDetail(paradisPresetCommandSignature(replaced, ' && '), '') : undefined,
					STR_INDISTINGUISHABLE_DETAIL,
				].filter((line): line is string => !!line).join('\n\n'),
				primaryButton: STR_CONFLICT_REPLACE,
			});
			return result.confirmed ? { kind: 'save', replace: replaced } : { kind: 'cancel' };
		}
		// 見分けが付く同名。既存が1件だけなら「どれを置き換えるか」が一意に決まるので置き換えも選べる。
		// 複数あるときは選ばせる画面が要るため、この場では追加に絞る（消したいなら一覧から削除できる）。
		const existing = conflict.sameName.length === 1 ? conflict.sameName[0] : undefined;
		const { result } = await this.dialogService.prompt<ISaveDecision>({
			message: strConflictMessage(definition.name.trim()),
			detail: existing
				? strExistingDetail(paradisPresetCommandSignature(existing, ' && '), paradisPresetQualifier(existing) ?? '')
				: strExistingCount(conflict.sameName.length),
			buttons: [
				{ label: STR_CONFLICT_ADD, run: (): ISaveDecision => ({ kind: 'save' }) },
				...(existing ? [{ label: STR_CONFLICT_REPLACE, run: (): ISaveDecision => ({ kind: 'save', replace: existing }) }] : []),
			],
			cancelButton: { label: STR_CONFLICT_CANCEL, run: (): ISaveDecision => ({ kind: 'cancel' }) },
		});
		return result ?? { kind: 'cancel' };
	}
}
