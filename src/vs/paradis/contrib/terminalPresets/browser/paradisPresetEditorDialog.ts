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
// 行の並び替えは挿入で行う（paradisPresetReorder.ts）。行左端の grip ハンドル（⋮⋮）からの HTML5
// ドラッグ＆ドロップでは行の間に挿入線を出し、フォルダの行の中ほどに重ねるとフォルダへ入れる。
// フォルダもひとまとまりで動かせる。↑↓・Alt+↑ / Alt+↓ はフォルダを飛び越え、フォルダの端からは
// 外へ出る。Alt+→ / Alt+← と右クリックでフォルダへ入れる・出す。保存先（ユーザー設定 /
// .paracode.json）を跨ぐ位置では赤い線と理由を出して止める。検索・フィルタ中は見えていない行を
// 挟んだ位置が見た目と一致しなくなるため、手動並び替え自体を無効化する。
//
// 編集フォームへの遷移（選択トグル・新規作成・左ナビ・Esc・戻る）は、未保存の入力があるときに
// 破棄確認（dialogService.confirm）を挟む。dirty 判定はフォームを開いた時点の値との比較。
//
// 保存先として「ユーザー設定（settings.json）」と「このリポジトリ（.paracode.json）」を選べる。
// ダイアログの実装様式は paradisYouTubeImportDialog.ts / paradisCreateWorktreeDialog.ts と同じ
// 自前 DOM + backdrop 方式。
//
// 一覧はフォルダでグループ化して表示できる（paradisGroupPresetsByFolder）。フォルダは基本的には
// 独立した実体ではなく、複数プリセットが同じ folder 文字列を持つことだけで成り立つ——メイン一覧の
// グループ化はこの仕組みのまま変えていない。フォルダは通常「1件以上のプリセットをそこへ移動する」
// ことで生まれる（選択 → 一括操作 → フォルダへ移動 → 新しいフォルダを作成、またはプリセット編集
// フォームのフォルダ欄に名前を書く）。加えて、ヘッダーの「新規フォルダ」ボタンから中身が0件の
// 「空フォルダ」も作れる——こちらは軽量な台帳（IParadisResolvedPresetFolder）に名前だけを記録し、
// ナビ（左サイドバー）とフォルダ名の入力補完（datalist・移動先メニュー）にだけ反映される
// （paradisAllFolderNames）。空フォルダの削除はナビでの右クリックから行う。

import './media/paradisPresetEditorDialog.css';
import * as dom from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Codicon, getAllCodicons } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import {
	IParadisPresetDefinition,
	IParadisPresetGroup,
	IParadisPresetService,
	IParadisPresetTask,
	IParadisResolvedPreset,
	paradisAllFolderNames,
	paradisBuildPresetHosts,
	paradisFindPresetNameConflict,
	paradisGetPresetTasks,
	paradisGroupPresetsByFolder,
	paradisIsReservedPresetHost,
	paradisPresetCommandSignature,
	paradisPresetFingerprint,
	paradisPresetHostsLabel,
	paradisPresetQualifier,
	paradisPresetQualifiers,
	paradisPresetScopeKey,
	ParadisPresetAction,
	ParadisPresetLayout,
	PARADIS_PRESET_AGENT_PROMPT_MAX_LENGTH,
	paradisPresetAction,
	ParadisPresetNameConflict,
	ParadisPresetSource,
	PARADIS_PRESET_HOST_LOCAL,
	PARADIS_PRESET_HOST_REMOTE,
	PARADIS_PROJECT_ROOT_ENV_VAR,
	PARADIS_WORKSPACE_PRESET_FILE,
} from '../common/paradisTerminalPresets.js';
import { paradisFolderLabelMoves } from '../common/paradisPresetLocalLedger.js';
import {
	IParadisPresetMovePlan,
	isParadisPresetMoveRefusal,
	paradisApplyPresetMovePlan,
	paradisPlanPresetMove,
	paradisPlanPresetMoveToFolder,
	paradisPlanPresetNest,
	paradisPlanPresetStep,
	paradisPresetBlocks,
	paradisPresetDropSpot,
	ParadisPresetDropTarget,
	paradisPresetMoveFolderChoices,
	paradisPresetPlaceOf,
	paradisPresetReorderBlocked,
	paradisPresetSameItem,
	ParadisPresetMoveItem,
	ParadisPresetMoveRefusal,
	ParadisPresetPosition,
} from '../common/paradisPresetReorder.js';

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

/** ドラッグ中のポインタの位置から決めた、入る位置とその書き込み方。 */
interface IParadisPresetDropHit {
	readonly position: ParadisPresetPosition;
	readonly plan: IParadisPresetMovePlan | ParadisPresetMoveRefusal;
	/** フォルダの行の中ほど（フォルダへ入れる）。挿入線ではなくフォルダを強調する。 */
	readonly into: boolean;
	readonly label: string;
}

/**
 * 一覧を描いたときの要素の台帳。ドロップ先の判定・挿入線の位置・並び替え後のフォーカスの戻し先を、
 * セレクタで探さずに引くために描きながら記録する。フォルダのキーは {@link paradisListFolderKey}。
 */
interface IParadisPresetListElements {
	/** 行と保存先の見出し（描いた順）。 */
	readonly targets: HTMLElement[];
	readonly presetRows: Map<string, HTMLElement>;
	readonly folderRows: Map<string, HTMLElement>;
	readonly folderChildren: Map<string, HTMLElement>;
	/** 行 → その行の grip。 */
	readonly grips: Map<HTMLElement, HTMLElement>;
	/** 保存先 → その保存先で最後に描いた行。 */
	readonly scopeTails: Map<string, HTMLElement>;
}

function paradisEmptyListElements(): IParadisPresetListElements {
	return { targets: [], presetRows: new Map(), folderRows: new Map(), folderChildren: new Map(), grips: new Map(), scopeTails: new Map() };
}

/** 一覧の中でフォルダ 1 つを指すキー（折りたたみの記録と同じ形）。 */
function paradisListFolderKey(scopeKey: string, folder: string): string {
	return `${scopeKey}::${folder}`;
}

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
const STR_NEW_FOLDER = localize('paradis.presetEditor.newFolder', "新規フォルダ");
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
// 複製の連打で「完全一致の同名ペア」を作らせないための拒否トースト。
// allow-any-unicode-next-line
const strDuplicateSkipped = (name: string) => localize('paradis.presetEditor.duplicateSkipped', "同じ内容のプリセット「{0}」が既にあるため、複製していません", name);
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
const STR_ACTION = localize('paradis.presetEditor.action', "種別");
// allow-any-unicode-next-line
const STR_ACTION_RUN = localize('paradis.presetEditor.action.run', "コマンドを実行する（Enter を送る）");
// allow-any-unicode-next-line
const STR_ACTION_INSERT = localize('paradis.presetEditor.action.insert', "入力欄に入れるだけ（Enter を送らない）");
// allow-any-unicode-next-line
const STR_ACTION_AGENT_PROMPT = localize('paradis.presetEditor.action.agentPrompt', "エージェント向けプロンプト（今のエージェントの入力欄へ入れる）");
// allow-any-unicode-next-line
const STR_ACTION_HINT_INSERT = localize('paradis.presetEditor.action.hintInsert', "アクティブなターミナルの入力欄にコマンドを入れます（Enter は送りません）。複数のコマンドは && でつないだ1行になります。エージェントが許可や質問の回答を待っている間は入れません。");
// allow-any-unicode-next-line
const STR_ACTION_HINT_AGENT_PROMPT = localize('paradis.presetEditor.action.hintAgentPrompt', "ターミナルの右クリックメニュー「エージェントにプロンプトを挿入」や、タブバーのボタンから使えます。Claude Code / Codex が動いているターミナルの入力欄に貼り付けとして入り、送信はしません。");
// allow-any-unicode-next-line
const STR_PROMPT = localize('paradis.presetEditor.prompt', "プロンプト");
// allow-any-unicode-next-line
const STR_INSERT_COMMANDS = localize('paradis.presetEditor.insertCommands', "入れるコマンド（1行に1つ）");
// allow-any-unicode-next-line
const STR_INSERT_COMMANDS_PLACEHOLDER = localize('paradis.presetEditor.insertCommandsPlaceholder', "例: git log --oneline -20");
// allow-any-unicode-next-line
const STR_PROMPT_PLACEHOLDER = localize('paradis.presetEditor.promptPlaceholder', "例: 変更点をレビューして、問題があれば箇条書きで挙げてください");
// allow-any-unicode-next-line
const STR_PROMPT_REQUIRED = localize('paradis.presetEditor.promptRequired', "プロンプトを入力してください。");
// allow-any-unicode-next-line
const STR_LAYOUT = localize('paradis.presetEditor.layout', "ターミナルの並べ方");
// allow-any-unicode-next-line
const STR_LAYOUT_TABS = localize('paradis.presetEditor.layout.tabs', "タブで並べる");
// allow-any-unicode-next-line
const STR_LAYOUT_SPLIT = localize('paradis.presetEditor.layout.split', "分割して並べる");
// allow-any-unicode-next-line
const STR_LAYOUT_CURRENT = localize('paradis.presetEditor.layout.current', "アクティブなターミナルで実行（全コマンド連結）");
// allow-any-unicode-next-line
const STR_LAYOUT_SMART = localize('paradis.presetEditor.layout.smart', "空いていれば実行・忙しければ新規（自動判定）");
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
const strHostChipReserved = (value: string) => localize('paradis.presetEditor.hostChipReserved', "「{0}」は実行環境そのものを表す予約語のため、ホスト名には使えません。上のチェックボックスで指定してください。", value);
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
const STR_REORDER_FAILED = localize('paradis.presetEditor.reorderFailed', "並べ替えられませんでした");
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
const STR_FOLDER_NAME_DUPLICATE = localize('paradis.presetEditor.folderNameDuplicate', "同じ名前のフォルダが既にあります。");
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
const strDeleteEmptyFolderMultiScopeConfirm = (name: string, count: number) => localize('paradis.presetEditor.deleteEmptyFolderMultiScopeConfirm', "フォルダ「{0}」を削除しますか？（{1}箇所に存在します）", name, count);
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
const strNavFolderEmptyHint = (name: string) => localize('paradis.presetEditor.navFolderEmptyHint', "{0}（空のフォルダ。右クリックで削除できます）", name);
// allow-any-unicode-next-line
const STR_NAV_CAPTION_SOURCE = localize('paradis.presetEditor.navCaptionSource', "出所");
// allow-any-unicode-next-line
const STR_NAV_SOURCE_USER = localize('paradis.presetEditor.navSourceUser', "ユーザー設定");
// allow-any-unicode-next-line
const STR_NAV_SOURCE_WORKSPACE = localize('paradis.presetEditor.navSourceWorkspace', "リポジトリ（.paracode.json）");
// allow-any-unicode-next-line
const STR_NAV_CAPTION_HINTS = localize('paradis.presetEditor.navCaptionHints', "操作のヒント");
// allow-any-unicode-next-line
const strGripTitle = (name: string) => localize('paradis.presetEditor.gripTitle', "{0}: 左端をつかんでドラッグ、Alt+↑ / Alt+↓ で並び替え、Alt+→ / Alt+← でフォルダへ入れる・出す。Enter で移動のメニュー", name);
// allow-any-unicode-next-line
const strFolderGripTitle = (name: string) => localize('paradis.presetEditor.folderGripTitle', "{0}: 左端をつかんでドラッグ、または Alt+↑ / Alt+↓ でフォルダごと並び替え。Enter で移動のメニュー", name);
// 並び替えの後に読み上げる新しい位置。
// allow-any-unicode-next-line
const strMovedTo = (name: string, index: number, count: number) => localize('paradis.presetEditor.movedTo', "{0} を {1} / {2} 番目へ移しました", name, index, count);
// allow-any-unicode-next-line
const strMovedToInFolder = (name: string, folder: string, index: number, count: number) => localize('paradis.presetEditor.movedToInFolder', "{0} を {1} フォルダの中の {2} / {3} 番目へ移しました", name, folder, index, count);
// allow-any-unicode-next-line
const STR_HINT_REORDER = localize('paradis.presetEditor.hintReorder', "行の左端 ⋮⋮ をドラッグすると、行の間に線が出てそこへ入ります。フォルダの行の中ほどに重ねるとフォルダに入ります。");
// allow-any-unicode-next-line
const STR_HINT_KEYS = localize('paradis.presetEditor.hintKeys', "Alt+↑ / Alt+↓ で 1 つずつ（フォルダはひとまとまり）、Alt+→ でフォルダへ入れる、Alt+← でフォルダから出す。右クリックでも移せます。");
// allow-any-unicode-next-line
const STR_HINT_NO_CROSS = localize('paradis.presetEditor.hintNoCross', "※ 保存先（ユーザー設定 / .paracode.json）を跨ぐ移動はできません。");
// allow-any-unicode-next-line
const STR_MOVE_UP = localize('paradis.presetEditor.moveUp', "上へ移動");
// allow-any-unicode-next-line
const STR_MOVE_DOWN = localize('paradis.presetEditor.moveDown', "下へ移動");
// allow-any-unicode-next-line
const strMoveToFolder = (folder: string) => localize('paradis.presetEditor.moveToFolderNamed', "「{0}」フォルダへ移動", folder);
// allow-any-unicode-next-line
const STR_MOVE_OUT_OF_FOLDER = localize('paradis.presetEditor.moveOutOfFolder', "フォルダから出す");
// allow-any-unicode-next-line
const STR_MOVE_REFUSED_SCOPE = localize('paradis.presetEditor.moveRefusedScope', "保存先（ユーザー設定 / .paracode.json）を跨いでは移せません");
// allow-any-unicode-next-line
const STR_MOVE_REFUSED_TOP = localize('paradis.presetEditor.moveRefusedTop', "一番上です");
// allow-any-unicode-next-line
const STR_MOVE_REFUSED_BOTTOM = localize('paradis.presetEditor.moveRefusedBottom', "一番下です");
// allow-any-unicode-next-line
const STR_MOVE_REFUSED_NEST = localize('paradis.presetEditor.moveRefusedNest', "フォルダの中にフォルダは入れられません");
// allow-any-unicode-next-line
const STR_MOVE_REFUSED_NO_FOLDER = localize('paradis.presetEditor.moveRefusedNoFolder', "すぐ上にも下にもフォルダがありません");
// allow-any-unicode-next-line
const STR_MOVE_REFUSED_NOT_IN_FOLDER = localize('paradis.presetEditor.moveRefusedNotInFolder', "フォルダに入っていません");
// ドラッグ中に挿入線の横へ出す「どこに入るか」。
// allow-any-unicode-next-line
const strDropBefore = (name: string) => localize('paradis.presetEditor.dropBefore', "{0} の前", name);
// allow-any-unicode-next-line
const strDropAfter = (name: string) => localize('paradis.presetEditor.dropAfter', "{0} の後", name);
// allow-any-unicode-next-line
const strDropBeforeFolder = (folder: string) => localize('paradis.presetEditor.dropBeforeFolder', "{0} フォルダの前", folder);
// allow-any-unicode-next-line
const strDropAfterFolder = (folder: string) => localize('paradis.presetEditor.dropAfterFolder', "{0} フォルダの後", folder);
// allow-any-unicode-next-line
const strDropAfterFolderHint = (folder: string) => localize('paradis.presetEditor.dropAfterFolderHint', "{0} フォルダの後（右へずらすとフォルダの中）", folder);
// allow-any-unicode-next-line
const strDropIntoFolder = (folder: string) => localize('paradis.presetEditor.dropIntoFolder', "{0} フォルダに入れる", folder);
// allow-any-unicode-next-line
const strDropInFolderBefore = (folder: string, name: string) => localize('paradis.presetEditor.dropInFolderBefore', "{0} フォルダの中・{1} の前", folder, name);
// allow-any-unicode-next-line
const strDropFolderEnd = (folder: string) => localize('paradis.presetEditor.dropFolderEnd', "{0} フォルダの中の最後", folder);
// allow-any-unicode-next-line
const strDropFolderEndHint = (folder: string) => localize('paradis.presetEditor.dropFolderEndHint', "{0} フォルダの中の最後（左へずらすとフォルダの後）", folder);
// 一覧の保存先ごとの見出し。.paracode.json はリポジトリ（フォルダ）ごとに別の保存先になる。
// allow-any-unicode-next-line
const strSectionWorkspace = (folder: string) => localize('paradis.presetEditor.sectionWorkspace', "{0}（.paracode.json）", folder);
// 検索語・ナビフィルタがあるときの手動並び替え（DnD・↑↓・Alt+↑↓）の無効化理由。
// allow-any-unicode-next-line
const STR_REORDER_BLOCKED_BY_FILTER = localize('paradis.presetEditor.reorderBlockedByFilter', "フィルタ中は並び替えできません");

// 編集中の未保存入力を捨てる前に出す確認。primary が「破棄」で、キャンセルすると元の画面に留まる。
// allow-any-unicode-next-line
const STR_DISCARD_MESSAGE = localize('paradis.presetEditor.discardMessage', "未保存の変更を破棄しますか？");
// allow-any-unicode-next-line
const STR_DISCARD = localize('paradis.presetEditor.discard', "破棄");

/** これ未満の件数なら「実行」は確認なしで即実行する（1〜2件は単発実行と同じ感覚で押せてよいため）。 */
const BULK_RUN_CONFIRM_THRESHOLD = 3;

/** ダイアログ内トーストを自動で消すまでの時間（ms）。 */
const TOAST_REMOVE_DELAY = 2400;

// アイコンピッカーに出す全codicon（アルファベット順）。モジュールロード時に一度だけ確定する。
const ALL_CODICONS = getAllCodicons().sort((a, b) => a.id.localeCompare(b.id));

const ACTION_LABELS: readonly { action: ParadisPresetAction; label: string }[] = [
	{ action: 'run', label: STR_ACTION_RUN },
	{ action: 'insert', label: STR_ACTION_INSERT },
	{ action: 'agent-prompt', label: STR_ACTION_AGENT_PROMPT },
];

const LAYOUT_LABELS: readonly { layout: ParadisPresetLayout; label: string }[] = [
	{ layout: 'tabs', label: STR_LAYOUT_TABS },
	{ layout: 'split', label: STR_LAYOUT_SPLIT },
	{ layout: 'current', label: STR_LAYOUT_CURRENT },
	{ layout: 'smart', label: STR_LAYOUT_SMART },
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
		accessor.get(IHoverService),
	);
}

/** 常設シェル（ヘッダー／左ナビ／右コンテンツ）。再描画は右コンテンツの中身だけ行う。 */
class ParadisPresetEditorDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _dialog: HTMLElement;
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

	/** 表示中の key → プリセット本体（キーボード・右クリック・ドロップ先の解決に使う）。 */
	private _rowPresets = new Map<string, IParadisResolvedPreset>();
	/**
	 * 一覧を描いたときの、絞り込み前の見えているプリセット（{@link IParadisPresetService.presets}）。
	 * 並び替えの位置はこの並びで計算する。
	 */
	private _listPresets: readonly IParadisResolvedPreset[] = [];
	private _listElements = paradisEmptyListElements();
	/** ドラッグ中のもの（dragstart〜drop/dragend の間だけ非 undefined）。 */
	private _dragging: ParadisPresetMoveItem | undefined;
	/** ドラッグ中に挿入線・フォルダの強調を描く一覧の要素（list 直下の重ね絵）。 */
	private readonly _dropIndicator = this._register(new MutableDisposable<DisposableStore>());
	/**
	 * 並び替えの後、描き直した一覧で探す動かした行（新しい位置の読み上げと、`focus` ならフォーカスの
	 * 戻し先）。.paracode.json の手書きのプリセットは位置由来のキーで、動かすとキーが変わるので、
	 * 保存先と指紋で探す。同じ中身のプリセットが並ぶときのために、同じ指紋の中で何番目か（`ordinal`）も持つ。
	 */
	private _pendingMove: { readonly scopeKey: string; readonly fingerprint?: string; readonly ordinal?: number; readonly folder?: string; readonly focus: boolean } | undefined;
	/**
	 * 並び替えの書き込み中。書き込みが終わって一覧を描き直すまでの間に次の移動（連打・長押し）を
	 * 受けると、古い並びから作った書き込み方を重ねて渡すことになり、対象を見失う。終わるまで受け付けない。
	 */
	private _moveInFlight = false;
	/**
	 * 編集フォームの dirty 判定。「フォームを開いた時点の値」と「現在値」を同じ形で読み取る
	 * 関数を、編集ビュー（プリセット編集／フォルダ名変更／新規フォルダ）ごとに登録する。
	 * 一覧に戻った時点で解除する。
	 */
	private _readEditState: (() => Record<string, unknown>) | undefined;
	private _initialEditState: Record<string, unknown> | undefined;

	constructor(
		layoutService: ILayoutService,
		private readonly presetService: IParadisPresetService,
		private readonly dialogService: IDialogService,
		private readonly contextService: IWorkspaceContextService,
		private readonly contextMenuService: IContextMenuService,
		private readonly hoverService: IHoverService,
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
			void this._confirmDiscardUnsaved().then(proceed => {
				if (!proceed) {
					return;
				}
				this._selecting = !this._selecting;
				if (!this._selecting) {
					this._selectedKeys.clear();
				}
				// 編集フォーム中表示中に押された場合も、一覧へ戻して選択モードを反映させる
				this._renderList();
			});
		}));
		this._newBtnEl = dom.append(headerActions, $('button.ppe-btn.ppe-btn-primary')) as HTMLButtonElement;
		this._newBtnEl.type = 'button';
		this._newBtnEl.textContent = STR_NEW;
		this._chromeStore.add(dom.addDisposableListener(this._newBtnEl, 'click', () => {
			void this._confirmDiscardUnsaved().then(proceed => {
				if (proceed) {
					this._renderEdit(undefined);
				}
			});
		}));
		const newFolderBtnEl = dom.append(headerActions, $('button.ppe-btn')) as HTMLButtonElement;
		newFolderBtnEl.type = 'button';
		newFolderBtnEl.textContent = STR_NEW_FOLDER;
		this._chromeStore.add(dom.addDisposableListener(newFolderBtnEl, 'click', () => {
			void this._confirmDiscardUnsaved().then(proceed => {
				if (proceed) {
					this._renderFolderCreateEmpty();
				}
			});
		}));
		const closeBtn = dom.append(headerActions, $('button.ppe-btn.ppe-close-btn')) as HTMLButtonElement;
		closeBtn.type = 'button';
		// allow-any-unicode-next-line
		closeBtn.textContent = '✕';
		closeBtn.title = STR_CLOSE;
		closeBtn.setAttribute('aria-label', STR_CLOSE);
		this._chromeStore.add(dom.addDisposableListener(closeBtn, 'click', () => {
			void this._confirmDiscardUnsaved().then(proceed => {
				if (proceed) {
					this.dispose();
				}
			});
		}));

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
			let filter: ParadisPresetEditorFilter;
			if (kind === 'all') {
				filter = { kind: 'all' };
			} else if (kind === 'folder') {
				filter = { kind: 'folder', folder: btn.dataset.folder || undefined };
			} else if (kind === 'source') {
				filter = { kind: 'source', source: btn.dataset.source === 'workspace' ? 'workspace' : 'user' };
			} else {
				return;
			}
			// 編集中にナビを触った場合も、まず一覧へ戻す（フィルタは一覧に対する操作のため）
			void this._confirmDiscardUnsaved().then(proceed => {
				if (!proceed) {
					return;
				}
				this._filter = filter;
				this._renderList();
			});
		}));
		// 空フォルダ（data-empty-folder）だけ、右クリックで確認なしに台帳から削除する。中身が
		// 1件以上あるフォルダは対象外（そちらは一覧のフォルダ行の「削除」ボタンを使う——
		// 中身をどうするか選ばせる必要があるため、右クリックの1手では済ませられない）。
		this._chromeStore.add(dom.addDisposableListener(this._navEl, 'contextmenu', async e => {
			const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.ppe-nav-item');
			if (!btn || btn.dataset.kind !== 'folder' || !btn.dataset.emptyFolder || !btn.dataset.folder) {
				return;
			}
			e.preventDefault();
			// 同名のフォルダがスコープ違いで複数（user と workspace の両方など）あることがあるので、
			// 1件だけ探して消すと見た目には消えたのに別スコープのエントリが台帳に残ってしまう。
			// このボタンはどのスコープのフォルダかという情報を持たないため、ここでは名前だけで
			// 一括して消す（_confirmDeleteFolder はスコープが分かっているのでそちらに絞る）。
			const name = btn.dataset.folder;
			const folders = this.presetService.folders.filter(candidate => candidate.name === name);
			if (folders.length === 0) {
				return;
			}
			// 2箇所以上（複数スコープ）にまたがるときだけ、消える前に確認する。1件しか無いときは
			// 従来どおり確認なしで即削除する。
			if (folders.length > 1) {
				const result = await this.dialogService.confirm({ message: strDeleteEmptyFolderMultiScopeConfirm(name, folders.length), primaryButton: STR_DELETE });
				if (!result.confirmed) {
					return;
				}
			}
			try {
				// 同一ファイル・同一設定に同名エントリが複数あるとき、並列の read-modify-write だと
				// 片方の削除が消えてしまう（lost update）。直列に処理する。
				for (const folder of folders) {
					await this.presetService.deleteFolder(folder);
				}
			} catch (error) {
				await this.dialogService.error(STR_DELETE_FAILED, error instanceof Error ? error.message : String(error));
			}
			this._renderList();
		}));
		dom.append(navScroll, $('.ppe-nav-caption')).textContent = STR_NAV_CAPTION_HINTS;
		const navHint = dom.append(navScroll, $('.ppe-nav-hint'));
		dom.append(navHint, $('div')).textContent = STR_HINT_REORDER;
		dom.append(navHint, $('div')).textContent = STR_HINT_KEYS;
		dom.append(navHint, $('div')).textContent = STR_HINT_NO_CROSS;
		this._contentEl = dom.append(body, $('.ppe-content'));

		// Alt+↑ / Alt+↓（1 つずつ、フォルダはひとまとまり）と Alt+→ / Alt+←（フォルダへ入れる・
		// 出す）。行内のどの要素（grip 含む）にフォーカスがあっても効くように、コンテンツ全体に
		// 委譲する。選択モード中（workspace の key 移動で選択が全解除される事故源）と、検索・
		// フィルタ中（見えていない行を挟んだ位置が見た目と一致しないため）は無効。
		this._chromeStore.add(dom.addDisposableListener(this._contentEl, 'keydown', e => {
			if (this._mode !== 'list' || this._selecting || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
				return;
			}
			if (this._reorderBlockReason()) {
				return;
			}
			if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
				return;
			}
			const item = this._itemOfRow((e.target as HTMLElement).closest<HTMLElement>('.ppe-row'));
			if (!item) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			const presets = this._listPresets;
			const plan = e.key === 'ArrowUp' || e.key === 'ArrowDown'
				? paradisPlanPresetStep(presets, item, e.key === 'ArrowUp' ? -1 : 1)
				: paradisPlanPresetNest(presets, item, e.key === 'ArrowRight');
			void this._applyMove(plan, item, true);
		}));
		// 右クリック（ContextMenu キー・Shift+F10 も同じイベントで来る）で並び替えのメニュー。
		this._chromeStore.add(dom.addDisposableListener(this._contentEl, 'contextmenu', e => {
			if (this._mode !== 'list' || this._selecting || this._reorderBlockReason()) {
				return;
			}
			const row = (e.target as HTMLElement).closest<HTMLElement>('.ppe-row');
			const item = this._itemOfRow(row);
			if (!row || !item) {
				return;
			}
			e.preventDefault();
			// キーボード（メニューキー・Shift+F10）から開くと座標が 0,0 で来るので、行に寄せる。
			this._showMoveMenu(e.clientX === 0 && e.clientY === 0 ? row : { x: e.clientX, y: e.clientY }, item);
		}));

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				void this._confirmDiscardUnsaved().then(proceed => {
					if (proceed) {
						this.dispose();
					}
				});
			}
		}));
		this._register(dom.addDisposableListener(this._backdrop, 'keydown', e => {
			// IME の変換中 Escape は「変換の取り消し」であってダイアログを閉じる操作ではない
			if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
				e.preventDefault();
				if (this._mode === 'edit') {
					void this._confirmDiscardUnsaved().then(proceed => {
						if (proceed) {
							this._renderList();
						}
					});
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

	// --- 編集フォームの dirty 判定・破棄確認 ---------------------------------------------------------

	/**
	 * 現在の編集ビューの入力状態スナップショットを登録する。{@link _renderEdit} などの
	 * 編集ビューが、全コントロールの初期化後に「現在値を読む関数」を渡して呼ぶ。
	 * 一覧へ戻る（_renderList）と解除される。
	 */
	private _trackEditState(read: () => Record<string, unknown>): void {
		this._readEditState = read;
		this._initialEditState = read();
	}

	private _editIsDirty(): boolean {
		if (!this._readEditState || !this._initialEditState) {
			return false;
		}
		return JSON.stringify(this._initialEditState) !== JSON.stringify(this._readEditState());
	}

	/**
	 * 未保存の編集入力を捨ててよいか確認する。dirty でなければ（＝捨てるものがなければ）
	 * 確認なしで続行。破棄を選んだときだけ true を返す。
	 */
	private async _confirmDiscardUnsaved(): Promise<boolean> {
		if (!this._editIsDirty()) {
			return true;
		}
		const result = await this.dialogService.confirm({
			message: STR_DISCARD_MESSAGE,
			primaryButton: STR_DISCARD,
		});
		return result.confirmed;
	}

	/**
	 * 手動並び替え（DnD・↑↓・Alt+↑↓）ができないとき、その理由（title 表示共用）。
	 * 検索語やナビフィルタがあると表示が絞り込まれ、隣接スワップの結果が見た目と
	 * 一致しなくなるため、丸ごと無効化する。
	 */
	private _reorderBlockReason(): string | undefined {
		return paradisPresetReorderBlocked(this._searchQuery, this._filter.kind) ? STR_REORDER_BLOCKED_BY_FILTER : undefined;
	}

	/** 行（プリセットの行かフォルダの行）が指すもの。 */
	private _itemOfRow(row: HTMLElement | null): ParadisPresetMoveItem | undefined {
		if (!row) {
			return undefined;
		}
		const key = row.dataset.presetKey;
		if (key) {
			const preset = this._rowPresets.get(key);
			return preset ? { kind: 'preset', preset } : undefined;
		}
		const { folderName, scopeKey } = row.dataset;
		return row.classList.contains('ppe-folder-row') && folderName && scopeKey ? { kind: 'folder', scopeKey, folder: folderName } : undefined;
	}

	/** 動かせない理由の文言。並びが変わらないだけのとき（unchanged）は黙って何もしない。 */
	private _refusalMessage(refusal: ParadisPresetMoveRefusal, item: ParadisPresetMoveItem): string | undefined {
		const scopeKey = item.kind === 'preset' ? paradisPresetScopeKey(item.preset) : item.scopeKey;
		const scopeKeys = this._listPresets.map(preset => paradisPresetScopeKey(preset));
		switch (refusal) {
			case 'otherScope':
				return STR_MOVE_REFUSED_SCOPE;
			case 'scopeStart':
				// 上に別の保存先の並びがあるなら、それを越えられないことを言う。
				return scopeKeys.indexOf(scopeKey) > 0 ? STR_MOVE_REFUSED_SCOPE : STR_MOVE_REFUSED_TOP;
			case 'scopeEnd':
				return scopeKeys.lastIndexOf(scopeKey) < scopeKeys.length - 1 ? STR_MOVE_REFUSED_SCOPE : STR_MOVE_REFUSED_BOTTOM;
			case 'nestFolder':
				return STR_MOVE_REFUSED_NEST;
			case 'noFolderNearby':
				return STR_MOVE_REFUSED_NO_FOLDER;
			case 'notInFolder':
				return STR_MOVE_REFUSED_NOT_IN_FOLDER;
			case 'unchanged':
				return undefined;
		}
	}

	/**
	 * 並び替えを書き込む。動かせなければ理由をトーストで出す。書き込みの失敗（`.paracode.json` が
	 * 読めない・壊れている等）も理由を出す。黙って何も起きないと、並べ替えが効かないようにしか見えない。
	 * `keepFocus` はキーボード・右クリックから動かしたとき、描き直した一覧で同じ行へフォーカスを戻す。
	 */
	private async _applyMove(plan: IParadisPresetMovePlan | ParadisPresetMoveRefusal, item: ParadisPresetMoveItem, keepFocus: boolean): Promise<void> {
		if (this._moveInFlight) {
			return;
		}
		if (isParadisPresetMoveRefusal(plan)) {
			const message = this._refusalMessage(plan, item);
			if (message) {
				this._toast(message);
			}
			return;
		}
		if (item.kind === 'preset') {
			const scopeKey = paradisPresetScopeKey(item.preset);
			const fingerprint = paradisPresetFingerprint({ ...item.preset, folder: plan.folder });
			const ordinal = paradisApplyPresetMovePlan(this._listPresets, plan)
				.filter(preset => paradisPresetScopeKey(preset) === scopeKey && paradisPresetFingerprint(preset) === fingerprint)
				.findIndex(preset => preset.key === item.preset.key);
			this._pendingMove = { scopeKey, fingerprint, ordinal: Math.max(0, ordinal), focus: keepFocus };
		} else {
			this._pendingMove = { scopeKey: item.scopeKey, folder: item.folder, focus: keepFocus };
		}
		this._moveInFlight = true;
		try {
			await this.presetService.movePresets(plan);
		} catch (error) {
			this._pendingMove = undefined;
			void this.dialogService.error(STR_REORDER_FAILED, error instanceof Error ? error.message : String(error));
		} finally {
			this._moveInFlight = false;
		}
	}

	/** 描き直した一覧で、並び替えた行の新しい位置を読み上げ、キーボードから動かしたなら grip へフォーカスを戻す（{@link _pendingMove}）。 */
	private _restorePendingMove(): void {
		const pending = this._pendingMove;
		if (!pending) {
			return;
		}
		this._pendingMove = undefined;
		const elements = this._listElements;
		let row: HTMLElement | undefined;
		let item: ParadisPresetMoveItem | undefined;
		if (pending.folder !== undefined) {
			row = elements.folderRows.get(paradisListFolderKey(pending.scopeKey, pending.folder));
			item = { kind: 'folder', scopeKey: pending.scopeKey, folder: pending.folder };
		} else {
			// 描いた順ではなく保存先の配列の順（_listPresets）で数える。ordinal はその順で数えてある。
			const preset = this._listPresets
				.filter(candidate => paradisPresetScopeKey(candidate) === pending.scopeKey && paradisPresetFingerprint(candidate) === pending.fingerprint)[pending.ordinal ?? 0];
			row = preset ? elements.presetRows.get(preset.key) : undefined;
			item = preset ? { kind: 'preset', preset } : undefined;
		}
		if (!row || !item) {
			return;
		}
		if (pending.focus) {
			elements.grips.get(row)?.focus();
		}
		const place = paradisPresetPlaceOf(this._listPresets, item);
		if (place) {
			const name = item.kind === 'preset' ? item.preset.name : item.folder;
			status(place.folder ? strMovedToInFolder(name, place.folder, place.index, place.count) : strMovedTo(name, place.index, place.count));
		}
	}

	/** 右クリック（キーボードのメニューキーを含む）の並び替えメニュー。 */
	private _showMoveMenu(anchor: HTMLElement | { readonly x: number; readonly y: number }, item: ParadisPresetMoveItem): void {
		const presets = this._listPresets;
		const up = paradisPlanPresetStep(presets, item, -1);
		const down = paradisPlanPresetStep(presets, item, 1);
		const actions: IAction[] = [
			toAction({ id: 'paradis.presetEditor.moveUp', label: STR_MOVE_UP, enabled: !isParadisPresetMoveRefusal(up), run: () => void this._applyMove(up, item, true) }),
			toAction({ id: 'paradis.presetEditor.moveDown', label: STR_MOVE_DOWN, enabled: !isParadisPresetMoveRefusal(down), run: () => void this._applyMove(down, item, true) }),
		];
		if (item.kind === 'preset') {
			const folders = paradisPresetMoveFolderChoices(presets, item.preset);
			const inFolder = !!item.preset.folder?.trim();
			if (folders.length > 0 || inFolder) {
				actions.push(new Separator());
			}
			for (const folder of folders) {
				actions.push(toAction({
					id: `paradis.presetEditor.moveToFolderNamed.${folder}`,
					label: strMoveToFolder(folder),
					class: ThemeIcon.asClassName(Codicon.folder),
					run: () => void this._applyMove(paradisPlanPresetMoveToFolder(presets, item.preset, folder), item, true),
				}));
			}
			if (inFolder) {
				actions.push(toAction({
					id: 'paradis.presetEditor.moveOutOfFolder',
					label: STR_MOVE_OUT_OF_FOLDER,
					run: () => void this._applyMove(paradisPlanPresetNest(presets, item, false), item, true),
				}));
			}
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
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
		this._readEditState = undefined;
		this._initialEditState = undefined;
		this._dropIndicator.clear();
		dom.clearNode(this._contentEl);
		this._rowPresets = new Map();
		this._listElements = paradisEmptyListElements();

		const presets = this.presetService.presets;
		this._listPresets = presets;
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

		// 保存先（ユーザー設定・各リポジトリの .paracode.json）が 2 つ以上並ぶときは、境目に見出しを
		// 出す。保存先を跨いで動かせない理由が、一覧を見ただけで分かるようにするため。
		const reorderBlocked = this._reorderBlockReason();
		const groups = paradisGroupPresetsByFolder(filtered);
		const showSections = new Set(filtered.map(preset => paradisPresetScopeKey(preset))).size > 1;
		let lastScopeKey: string | undefined;
		for (const group of groups) {
			const first = group.presets[0];
			const scopeKey = paradisPresetScopeKey(first);
			if (showSections && scopeKey !== lastScopeKey) {
				const section = dom.append(list, $('.ppe-section'));
				section.dataset.scopeKey = scopeKey;
				this._listElements.targets.push(section);
				section.textContent = first.source === 'workspace' && first.sourceUri ? strSectionWorkspace(basename(dirname(first.sourceUri))) : STR_NAV_SOURCE_USER;
			}
			lastScopeKey = scopeKey;
			if (group.folder) {
				this._renderFolderGroup(list, group as IParadisFolderGroup, qualifiers, reorderBlocked);
				continue;
			}
			this._renderPresetRow(list, first, { qualifiers, reorderBlocked });
		}
		this._wireListDragAndDrop(list);
		this._restorePendingMove();
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
			readonly title?: string;
		}): HTMLButtonElement => {
			const btn = dom.append(parent, $('button.ppe-nav-item')) as HTMLButtonElement;
			btn.type = 'button';
			btn.classList.toggle('on', options.active);
			btn.setAttribute('aria-pressed', String(options.active));
			btn.title = options.title ?? label;
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

		// フォルダはツリー状に字下げして表示する（実プリセット由来 + 空フォルダ台帳、
		// paradisAllFolderNames の出現順）。空フォルダ（folderCounts に無い＝0件）は
		// data-empty-folder を立てておき、右クリック削除の委譲リスナーがここを見て判定する。
		const folders = this.presetService.folders;
		const folderNames = paradisAllFolderNames(presets, folders);
		if (folderNames.length > 0) {
			const tree = dom.append(this._navItemsEl, $('.ppe-nav-tree'));
			for (const name of folderNames) {
				const isEmpty = !folderCounts.has(name);
				mkItem(tree, name, {
					icon: Codicon.folder,
					count: folderCounts.get(name) ?? 0,
					active: this._filter.kind === 'folder' && this._filter.folder === name,
					dataset: { kind: 'folder', folder: name, ...(isEmpty ? { emptyFolder: '1' } : {}) },
					title: isEmpty ? strNavFolderEmptyHint(name) : name,
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
			readonly reorderBlocked?: string;
		},
	): void {
		const row = dom.append(container, $('.ppe-row'));
		// hosts 条件が現在の接続先と一致しない行は薄く表示する。消さないのは「SSH 先でしか出ない
		// プリセット」を手元から編集する手段を残すため（envInactive のコメント参照）。
		row.classList.toggle('dim', !!preset.envInactive);
		const scopeKey = paradisPresetScopeKey(preset);
		row.dataset.presetKey = preset.key;
		row.dataset.scopeKey = scopeKey;
		const folder = preset.folder?.trim();
		if (folder) {
			row.dataset.folderName = folder;
		}
		this._rowPresets.set(preset.key, preset);
		this._listElements.presetRows.set(preset.key, row);
		this._listElements.targets.push(row);
		this._listElements.scopeTails.set(scopeKey, row);
		const item: ParadisPresetMoveItem = { kind: 'preset', preset };

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

		this._appendGrip(row, item, options.reorderBlocked ?? strGripTitle(preset.name), !options.reorderBlocked);

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
		this._appendMoveButtons(actions, item, options.reorderBlocked);
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
			try {
				await this.presetService.runPreset(preset);
			} catch (error) {
				// エージェント向けは「今のターミナルでエージェントが動いていない」等の理由で入れられない
				// ことがあり、その理由は例外のメッセージで届く。
				await this.dialogService.error(STR_OPERATION_FAILED, error instanceof Error ? error.message : String(error));
			}
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
				action: preset.action,
				prompt: preset.prompt,
				tasks: paradisPresetAction(preset) !== 'run' ? undefined : tasks.tasks.map(task => ({ name: task.name, cwd: task.cwd, commands: [...task.commands] })),
				layout: paradisPresetAction(preset) !== 'run' ? undefined : tasks.layout,
				icon: preset.icon,
				cwd: preset.cwd,
				pinned: preset.pinned,
				pinnedLabel: preset.pinnedLabel,
				autoRun: preset.autoRun,
				appliesTo: preset.appliesTo ? [...preset.appliesTo] : undefined,
				hosts: preset.hosts ? [...preset.hosts] : undefined,
			};
			try {
				// 連打で「完全一致の同名ペア」を作らせない。同じ保存先に指紋まで一致する
				// プリセットがあるときは保存せず、理由をトーストで出す。
				const fingerprintOptions = { ignoreAppliesTo: preset.source === 'workspace' };
				const fingerprint = paradisPresetFingerprint(definition, fingerprintOptions);
				const twin = this._presetsInSaveTarget(preset.source, preset)
					.find(candidate => candidate.key !== preset.key && paradisPresetFingerprint(candidate, fingerprintOptions) === fingerprint);
				if (twin) {
					this._toast(strDuplicateSkipped(twin.name));
					return;
				}
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
	 * grip ハンドル（⋮⋮）。ここから mousedown したときだけ row を draggable にすることで、
	 * 「行本文のテキスト選択やボタン押下」と DnD を共存させる。検索・フィルタ中は並び替えを
	 * 無効化し、ホバーで理由を見せる。dragstart / dragend も行ごとにここで受ける（落とす先の
	 * 判定は一覧全体で行う。{@link _wireListDragAndDrop}）。
	 */
	private _appendGrip(row: HTMLElement, item: ParadisPresetMoveItem, label: string, enabled: boolean): void {
		const grip = dom.append(row, $('span.ppe-grip'));
		grip.tabIndex = 0;
		// allow-any-unicode-next-line
		grip.textContent = '⋮⋮';
		grip.setAttribute('role', 'button');
		this._listElements.grips.set(row, grip);
		grip.setAttribute('aria-label', label);
		this._viewStore.add(this.hoverService.setupDelayedHover(grip, { content: label, container: this._backdrop }));
		if (this._selecting || !enabled) {
			return;
		}
		// role=button なので Enter / Space で押せるようにする。押すと右クリックと同じ移動のメニューを行に寄せて出す。
		this._viewStore.add(dom.addDisposableListener(grip, 'keydown', e => {
			if ((e.key === 'Enter' || e.key === ' ') && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				this._showMoveMenu(row, item);
			}
		}));
		this._viewStore.add(dom.addDisposableListener(grip, 'mousedown', () => {
			row.draggable = true;
			// ドラッグが始まらないまま grip の外で mouseup しても draggable を確実に解除する
			//（grip 直上の mouseup は dragend / drop 側でも解除されるので二重で問題ない）。
			// 補助ウィンドウでは `window` は本体側を指してしまい mouseup が来ない。grip が載っている
			// ウィンドウを取る。
			this._viewStore.add(dom.addDisposableListener(dom.getWindow(grip), 'mouseup', () => {
				row.draggable = false;
			}, { once: true, capture: true }));
		}));
		this._viewStore.add(dom.addDisposableListener(row, 'dragstart', e => {
			// 行の中のボタン等から始まったドラッグ（draggable を立てていない）は扱わない。
			if (e.target !== row || !row.draggable) {
				return;
			}
			this._dragging = item;
			row.classList.add('dragging');
			const transfer = e.dataTransfer;
			if (transfer) {
				transfer.effectAllowed = 'move';
				try {
					transfer.setData('text/plain', item.kind === 'preset' ? item.preset.name : item.folder);
				} catch {
					// 一部の環境では setData が例外を投げる。並び替えには使わないデータなので無視。
				}
			}
		}));
		this._viewStore.add(dom.addDisposableListener(row, 'dragend', () => {
			row.draggable = false;
			row.classList.remove('dragging');
			this._dragging = undefined;
			this._dropIndicator.clear();
		}));
	}

	/**
	 * 一覧全体のドロップ判定（{@link _dropHitAt}）と、挿入線・フォルダの強調の表示。行の間の隙間に
	 * 落としても、一番近い行で判定する。
	 */
	private _wireListDragAndDrop(list: HTMLElement): void {
		this._viewStore.add(dom.addDisposableListener(list, 'dragover', e => {
			const item = this._dragging;
			if (!item) {
				return;
			}
			const hit = this._dropHitAt(list, item, e);
			// 保存先を跨ぐ位置でも preventDefault して drop を受ける。キャンセルしないと drop が来ず、
			// 理由のトーストを出せない（dropEffect='none' でも同様に drop が抑制される）。
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = hit && hit.plan !== 'unchanged' ? 'move' : 'none';
			}
			this._showDropIndicator(list, hit);
		}));
		this._viewStore.add(dom.addDisposableListener(list, 'dragleave', e => {
			// 子要素の間を移るときにも dragleave は来る。一覧の外へ出たときだけ消す。
			if (!(e.relatedTarget instanceof Node) || !list.contains(e.relatedTarget)) {
				this._dropIndicator.clear();
			}
		}));
		this._viewStore.add(dom.addDisposableListener(list, 'drop', e => {
			const item = this._dragging;
			if (!item) {
				return;
			}
			e.preventDefault();
			const hit = this._dropHitAt(list, item, e);
			this._dropIndicator.clear();
			if (hit) {
				void this._applyMove(hit.plan, item, false);
			}
		}));
	}

	/**
	 * ドラッグ中のポインタの位置から、入る位置を決める。ポインタに一番近い行（行の間の隙間でも）を
	 * 選び、行の中の縦の位置と字下げとの左右から {@link paradisPresetDropSpot} で位置を決める。
	 */
	private _dropHitAt(list: HTMLElement, item: ParadisPresetMoveItem, e: DragEvent): IParadisPresetDropHit | undefined {
		let target: HTMLElement | undefined;
		let rect: DOMRect | undefined;
		let best = Number.POSITIVE_INFINITY;
		for (const candidate of this._listElements.targets) {
			const candidateRect = candidate.getBoundingClientRect();
			const distance = e.clientY < candidateRect.top ? candidateRect.top - e.clientY : e.clientY >= candidateRect.bottom ? e.clientY - candidateRect.bottom : 0;
			if (distance < best) {
				best = distance;
				target = candidate;
				rect = candidateRect;
			}
		}
		const scopeKey = target?.dataset.scopeKey;
		if (!target || !rect || !scopeKey) {
			return undefined;
		}
		const rel = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0;
		const rowItem = this._itemOfRow(target);
		let dropTarget: ParadisPresetDropTarget;
		if (target.classList.contains('ppe-section')) {
			dropTarget = { kind: 'section', scopeKey };
		} else if (rowItem?.kind === 'folder') {
			dropTarget = { kind: 'folder', scopeKey, folder: rowItem.folder, expanded: this._listElements.folderChildren.has(paradisListFolderKey(scopeKey, rowItem.folder)) };
		} else if (rowItem?.kind === 'preset') {
			const childrenLeft = target.parentElement?.getBoundingClientRect().left ?? rect.left;
			dropTarget = { kind: 'preset', preset: rowItem.preset, leftOfIndent: e.clientX < childrenLeft };
		} else {
			return undefined;
		}
		const { position, into, hint } = paradisPresetDropSpot(this._listPresets, item, dropTarget, rel);
		const plan = paradisPlanPresetMove(this._listPresets, item, position);
		return { position, plan, into, label: plan === 'otherScope' ? STR_MOVE_REFUSED_SCOPE : this._dropLabel(position, into, hint) };
	}

	/** 挿入線の横に出す「どこに入るか」。 */
	private _dropLabel(position: ParadisPresetPosition, into: boolean, hint: 'folderEnd' | 'afterFolder' | undefined): string {
		if (position.kind === 'folder') {
			if (into) {
				return strDropIntoFolder(position.folder);
			}
			if (position.before) {
				return strDropInFolderBefore(position.folder, position.before.name);
			}
			return hint === 'folderEnd' ? strDropFolderEndHint(position.folder) : strDropFolderEnd(position.folder);
		}
		const blocks = paradisPresetBlocks(this._listPresets, position.scopeKey);
		const before = position.before;
		const index = before ? blocks.findIndex(block => paradisPresetSameItem(block.item, before)) : blocks.length;
		const previous = blocks[index - 1]?.item;
		if (before?.kind === 'folder') {
			return strDropBeforeFolder(before.folder);
		}
		if (previous?.kind === 'folder') {
			return hint === 'afterFolder' ? strDropAfterFolderHint(previous.folder) : strDropAfterFolder(previous.folder);
		}
		if (before) {
			return strDropBefore(before.preset.name);
		}
		return previous ? strDropAfter(previous.preset.name) : '';
	}

	/** 挿入線（入れられない位置なら赤い点線）か、フォルダへ入れるときのフォルダの強調を出す。 */
	private _showDropIndicator(list: HTMLElement, hit: IParadisPresetDropHit | undefined): void {
		const store = new DisposableStore();
		this._dropIndicator.value = store;
		if (!hit || hit.plan === 'unchanged') {
			return;
		}
		const denied = isParadisPresetMoveRefusal(hit.plan);
		const listRect = list.getBoundingClientRect();
		const position = hit.position;
		const elements = this._listElements;
		let lineTop: number | undefined;
		let lineLeft = 0;
		if (position.kind === 'folder' && hit.into && !denied) {
			const folderKey = paradisListFolderKey(position.scopeKey, position.folder);
			const header = elements.folderRows.get(folderKey);
			const marked = [header, elements.folderChildren.get(folderKey)].filter((element): element is HTMLElement => !!element);
			for (const element of marked) {
				element.classList.add('drop-into');
			}
			store.add(toDisposable(() => marked.forEach(element => element.classList.remove('drop-into'))));
			if (header) {
				const headerRect = header.getBoundingClientRect();
				lineTop = headerRect.top - listRect.top + headerRect.height / 2;
			}
		} else if (position.kind === 'folder') {
			const children = elements.folderChildren.get(paradisListFolderKey(position.scopeKey, position.folder));
			const anchor = position.before ? elements.presetRows.get(position.before.key) : undefined;
			if (anchor) {
				const anchorRect = anchor.getBoundingClientRect();
				lineTop = anchorRect.top - listRect.top - 3;
				lineLeft = anchorRect.left - listRect.left;
			} else if (children) {
				const childrenRect = children.getBoundingClientRect();
				lineTop = childrenRect.bottom - listRect.top + 1;
				lineLeft = childrenRect.left - listRect.left;
			}
		} else if (position.before) {
			const before = position.before;
			const anchor = before.kind === 'preset' ? elements.presetRows.get(before.preset.key) : elements.folderRows.get(paradisListFolderKey(before.scopeKey, before.folder));
			if (anchor) {
				lineTop = anchor.getBoundingClientRect().top - listRect.top - 3;
			}
		} else {
			const last = elements.scopeTails.get(position.scopeKey);
			if (last) {
				lineTop = last.getBoundingClientRect().bottom - listRect.top + 1;
			}
		}
		if (lineTop === undefined) {
			return;
		}
		if (!(position.kind === 'folder' && hit.into && !denied)) {
			const line = dom.append(list, $('.ppe-drop-line'));
			line.classList.toggle('denied', denied);
			line.style.top = `${lineTop}px`;
			line.style.left = `${lineLeft}px`;
			store.add(toDisposable(() => line.remove()));
		}
		if (hit.label) {
			const label = dom.append(list, $('.ppe-drop-label'));
			label.classList.toggle('denied', denied);
			label.classList.toggle('into', hit.into && !denied);
			label.textContent = hit.label;
			label.style.top = `${lineTop}px`;
			store.add(toDisposable(() => label.remove()));
		}
	}

	/** ↑↓ ボタン。押せないときはホバーで理由を出す。 */
	private _appendMoveButtons(actions: HTMLElement, item: ParadisPresetMoveItem, reorderBlocked: string | undefined): void {
		const moveBtn = (label: string, ariaLabel: string, direction: -1 | 1): void => {
			const btn = dom.append(actions, $('button.ppe-btn.ppe-task-btn')) as HTMLButtonElement;
			btn.type = 'button';
			btn.textContent = label;
			btn.setAttribute('aria-label', ariaLabel);
			const plan = reorderBlocked || this._selecting ? undefined : paradisPlanPresetStep(this._listPresets, item, direction);
			// disabled にするとホバーのイベントが来なくなり理由を見せられないので、aria-disabled で表す。
			const disabled = !plan || isParadisPresetMoveRefusal(plan);
			btn.setAttribute('aria-disabled', String(disabled));
			btn.classList.toggle('disabled', disabled);
			const reason = reorderBlocked ?? (plan && isParadisPresetMoveRefusal(plan) ? this._refusalMessage(plan, item) : undefined);
			this._viewStore.add(this.hoverService.setupDelayedHover(btn, { content: reason ? `${ariaLabel}: ${reason}` : ariaLabel, container: this._backdrop }));
			this._viewStore.add(dom.addDisposableListener(btn, 'click', e => {
				if (plan && !isParadisPresetMoveRefusal(plan)) {
					// Enter / Space で押したとき（detail が 0）は、描き直しで押したボタンごと消えて
					// フォーカスが失われるので、動かした行の grip へ戻す。
					void this._applyMove(plan, item, e.detail === 0);
				}
			}));
		};
		// allow-any-unicode-next-line
		moveBtn('↑', STR_MOVE_UP, -1);
		// allow-any-unicode-next-line
		moveBtn('↓', STR_MOVE_DOWN, 1);
	}

	/** フォルダ1件（ヘッダー行＋展開時は中身の行）。 */
	private _renderFolderGroup(container: HTMLElement, group: IParadisFolderGroup, qualifiers: Map<string, string>, reorderBlocked: string | undefined): void {
		const folderKey = paradisListFolderKey(paradisPresetScopeKey(group.presets[0]), group.folder);
		const collapsed = this._collapsedFolders.has(folderKey);

		const row = dom.append(container, $('.ppe-row.ppe-folder-row'));
		const item: ParadisPresetMoveItem = { kind: 'folder', scopeKey: paradisPresetScopeKey(group.presets[0]), folder: group.folder };
		row.dataset.scopeKey = item.scopeKey;
		row.dataset.folderName = group.folder;
		this._listElements.folderRows.set(paradisListFolderKey(item.scopeKey, group.folder), row);
		this._listElements.targets.push(row);
		this._listElements.scopeTails.set(item.scopeKey, row);
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
		this._appendGrip(row, item, reorderBlocked ?? strFolderGripTitle(group.folder), !reorderBlocked);
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
		this._appendMoveButtons(actions, item, reorderBlocked);
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
		this._listElements.folderChildren.set(paradisListFolderKey(item.scopeKey, group.folder), children);
		for (const preset of group.presets) {
			this._renderPresetRow(children, preset, { qualifiers, reorderBlocked });
		}
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
		const presets = this.presetService.presets;
		const folders = this.presetService.folders;
		const folderNames = paradisAllFolderNames(presets, folders);
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
		this._trackEditState(() => ({ name: nameInput.value }));

		const errorEl = dom.append(this._contentEl, $('.ppe-error'));
		const footer = dom.append(this._contentEl, $('.ppe-footer'));
		const backBtn = dom.append(footer, $('button.ppe-btn')) as HTMLButtonElement;
		backBtn.textContent = STR_BACK;
		this._viewStore.add(dom.addDisposableListener(backBtn, 'click', () => {
			void this._confirmDiscardUnsaved().then(proceed => {
				if (proceed) {
					this._renderList();
				}
			});
		}));
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
				// 「フォルダ名も表示する」の印はフォルダ名をキーに持つので、新しい名前へ移す
				// （移さないと古い名前に残り、改名したフォルダのボタンがアイコンだけになる）。
				for (const move of paradisFolderLabelMoves(group.presets, group.folder, name)) {
					if (this.presetService.isFolderLabelShown(move.from)) {
						this.presetService.setFolderLabelShown(move.from, false);
						this.presetService.setFolderLabelShown(move.to, true);
					}
				}
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
		this._trackEditState(() => ({ name: nameInput.value }));

		const errorEl = dom.append(this._contentEl, $('.ppe-error'));
		const footer = dom.append(this._contentEl, $('.ppe-footer'));
		const backBtn = dom.append(footer, $('button.ppe-btn')) as HTMLButtonElement;
		backBtn.textContent = STR_BACK;
		this._viewStore.add(dom.addDisposableListener(backBtn, 'click', () => {
			void this._confirmDiscardUnsaved().then(proceed => {
				if (proceed) {
					this._renderList();
				}
			});
		}));
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
	 * 空のフォルダを作るビュー（ヘッダーの「新規フォルダ」から）。{@link _renderFolderCreate}
	 * （選択済みプリセットをフォルダへ移す版）と違い移す対象が無いため、保存先（ユーザー設定 /
	 * このリポジトリ）を own で選ばせる——空フォルダは「どのプリセットが選ばれているか」から
	 * 保存先を推測できない。
	 */
	private _renderFolderCreateEmpty(): void {
		this._mode = 'edit';
		this._viewStore.clear();
		const { grid } = this._openEditPane(strFolderCreateTitle());

		const nameControl = this._formRow(grid, STR_FOLDER_NAME);
		const nameInput = dom.append(nameControl, $('input.ppe-input')) as HTMLInputElement;
		nameInput.type = 'text';
		nameInput.placeholder = STR_FOLDER_PLACEHOLDER;

		// 保存先ラジオ。_renderEdit の makeTargetRadio と同じ組み立てで、プリセットの保存先選択と
		// 見た目を揃える（ここだけ別の UI に見えると、同じ機能の一部だと気づきにくい）。
		const folder = this.contextService.getWorkspace().folders[0];
		const targetRow = dom.append(this._formRow(grid, STR_TARGET), $('.ppe-target-row'));
		const makeTargetRadio = (value: ParadisPresetSource, label: string, disabled: boolean): HTMLInputElement => {
			const wrap = dom.append(targetRow, $('.ppe-check-row'));
			const input = dom.append(wrap, $('input.ppe-radio')) as HTMLInputElement;
			input.type = 'radio';
			input.name = 'ppe-folder-target';
			input.value = value;
			input.disabled = disabled;
			const labelEl = dom.append(wrap, $('label.ppe-check-label'));
			labelEl.textContent = label;
			if (!disabled) {
				this._viewStore.add(dom.addDisposableListener(labelEl, 'click', () => { input.checked = true; }));
			}
			return input;
		};
		const userRadio = makeTargetRadio('user', STR_TARGET_USER, false);
		const workspaceRadio = makeTargetRadio('workspace', folder ? strTargetWorkspace(basename(folder.uri)) : PARADIS_WORKSPACE_PRESET_FILE, !folder);
		userRadio.checked = true;

		this._trackEditState(() => ({ name: nameInput.value, target: workspaceRadio.checked ? 'workspace' : 'user' }));

		const errorEl = dom.append(this._contentEl, $('.ppe-error'));
		const footer = dom.append(this._contentEl, $('.ppe-footer'));
		const backBtn = dom.append(footer, $('button.ppe-btn')) as HTMLButtonElement;
		backBtn.textContent = STR_BACK;
		this._viewStore.add(dom.addDisposableListener(backBtn, 'click', () => {
			void this._confirmDiscardUnsaved().then(proceed => {
				if (proceed) {
					this._renderList();
				}
			});
		}));
		const createBtn = dom.append(footer, $('button.ppe-btn.ppe-btn-primary')) as HTMLButtonElement;
		createBtn.textContent = STR_FOLDER_CREATE;
		this._viewStore.add(dom.addDisposableListener(createBtn, 'click', async () => {
			const name = nameInput.value.trim();
			if (!name) {
				errorEl.textContent = STR_FOLDER_NAME_REQUIRED;
				return;
			}
			try {
				const created = await this.presetService.createFolder(name, workspaceRadio.checked ? 'workspace' : 'user');
				if (!created) {
					errorEl.textContent = STR_FOLDER_NAME_DUPLICATE;
					return;
				}
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
			// 空フォルダ台帳（presetService.folders）に同名のエントリが残っていると、中身が0件に
			// なった直後にゴーストの空フォルダとしてナビへ復活してしまう。ここは削除したフォルダの
			// スコープ（source + sourceUri）が分かっているので、名前だけでなくスコープも一致する
			// エントリだけに絞る——名前だけで絞ると、無関係な別リポジトリの .paracode.json にある
			// 同名フォルダまで巻き込んで消してしまう。
			const scope = paradisPresetScopeKey(group.presets[0]);
			const ghostFolders = this.presetService.folders.filter(folder =>
				paradisPresetScopeKey(folder) === scope && folder.name === group.folder);
			// 同一ファイル・同一設定に同名エントリが複数あるとき、並列の read-modify-write だと
			// 片方の削除が消えてしまう（lost update）。直列に処理する。
			for (const folder of ghostFolders) {
				await this.presetService.deleteFolder(folder);
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
		const presets = this.presetService.presets;
		const folders = this.presetService.folders;
		const folderNames = paradisAllFolderNames(presets, folders);
		if (folderNames.length > 0) {
			const datalist = dom.append(folderField, $('datalist#ppe-folder-datalist'));
			for (const name of folderNames) {
				dom.append(datalist, $('option')).setAttribute('value', name);
			}
			folderInput.setAttribute('list', 'ppe-folder-datalist');
		}

		// 種別（実行 / 入力欄に入れるだけ / エージェント向け）。種別で意味を持たない行は隠す。
		const actionField = field(STR_ACTION);
		const actionSelect = dom.append(actionField, $('select.ppe-input.ppe-select')) as HTMLSelectElement;
		for (const { action, label } of ACTION_LABELS) {
			const option = dom.append(actionSelect, $('option')) as HTMLOptionElement;
			option.value = action;
			option.textContent = label;
		}
		actionSelect.value = editing ? paradisPresetAction(editing) : 'run';
		const actionHint = dom.append(actionField, $('.ppe-check-hint'));

		const promptField = field(STR_PROMPT);
		const promptInput = dom.append(promptField, $('textarea.ppe-input.ppe-commands')) as HTMLTextAreaElement;
		promptInput.rows = 5;
		promptInput.maxLength = PARADIS_PRESET_AGENT_PROMPT_MAX_LENGTH;
		promptInput.placeholder = STR_PROMPT_PLACEHOLDER;
		promptInput.value = editing?.prompt ?? '';

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
		const autoRunHint = dom.append(displayControl, $('.ppe-check-hint'));
		autoRunHint.textContent = STR_AUTORUN_HINT;

		// 種別ごとの行の出し分け。行はラベル列（直前の兄弟）とコントロール列の2セルで1行。
		const setRowVisible = (control: HTMLElement, visible: boolean): void => {
			control.style.display = visible ? '' : 'none';
			const label = control.previousElementSibling as HTMLElement | null;
			if (label) {
				label.style.display = visible ? '' : 'none';
			}
		};
		const updateActionVisibility = (): void => {
			const action = actionSelect.value as ParadisPresetAction;
			const commandsVisible = action === 'run';
			// 挿入だけ・エージェント向けの本文は prompt に置く（古い版が commands を Enter 付きで実行しないように）
			setRowVisible(promptField, action !== 'run');
			const promptLabel = promptField.previousElementSibling as HTMLElement | null;
			if (promptLabel) {
				promptLabel.textContent = action === 'insert' ? STR_INSERT_COMMANDS : STR_PROMPT;
			}
			promptInput.placeholder = action === 'insert' ? STR_INSERT_COMMANDS_PLACEHOLDER : STR_PROMPT_PLACEHOLDER;
			setRowVisible(tasksField, commandsVisible);
			setRowVisible(addTaskBtn.parentElement as HTMLElement, commandsVisible);
			// 並べ方と既定の作業ディレクトリは「実行」だけ（入れるだけは今のターミナルへ入れる）
			setRowVisible(layoutSelect.parentElement as HTMLElement, action === 'run');
			setRowVisible(cwdInput.parentElement as HTMLElement, action === 'run');
			// スペース作成直後の自動実行も「実行」だけ
			for (const element of [autoRunInput.parentElement as HTMLElement, autoRunHint]) {
				element.style.display = action === 'run' ? '' : 'none';
			}
			actionHint.textContent = action === 'insert' ? STR_ACTION_HINT_INSERT : action === 'agent-prompt' ? STR_ACTION_HINT_AGENT_PROMPT : '';
		};
		updateActionVisibility();
		this._viewStore.add(dom.addDisposableListener(actionSelect, 'change', updateActionVisibility));

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
		const hostChips = hasRemoteLiteral ? [] : initialHosts.filter(entry => !paradisIsReservedPresetHost(entry));
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
			// 予約語（local / remote）はホスト名として受けない。受けてしまうと条件が
			// 「SSH 未接続のときだけ」へ裏返る（paradisBuildPresetHosts のコメント参照）。
			// 打った文字は消さずに残し、直せるようにする。
			if (paradisIsReservedPresetHost(value)) {
				chipsHint.textContent = strHostChipReserved(value);
				return;
			}
			chipInput.value = '';
			if (!value || hostChips.some(existing => existing.toLowerCase() === value.toLowerCase())) {
				return;
			}
			chipsHint.textContent = '';
			hostChips.push(value);
			renderChips();
			chipInput.focus();
		};
		this._viewStore.add(dom.addDisposableListener(chipInput, 'keydown', e => {
			// IME の変換確定 Enter は「チップの追加」ではないので無視する。確定しただけで
			// 未確定の文字列がチップになってしまうため。keyCode 229 は isComposing を
			// 立てない環境向けの保険。
			if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
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
			// 見た目 (CSS の pointer-events) だけでなく入力欄自体も止める。キーボードで
			// タブ移動すると触れてしまい、打ったホスト名が保存時に黙って捨てられるため。
			chipInput.disabled = !enabled;
			chipsHint.textContent = enabled ? '' : STR_HOST_CHIPS_HINT_REMOTE_OFF;
		};
		renderChips();
		updateHostChipsEnabled();
		this._viewStore.add(dom.addDisposableListener(hostRemoteInput, 'change', updateHostChipsEnabled));
		// 手入力の補完候補は、既存プリセットが実際に使っているホスト名（特殊値を除く）。
		// フォルダ欄と同じく、フォームを開いた時点の一覧で一度だけ作る。
		const knownHosts = [...new Set(this.presetService.presets
			.flatMap(preset => preset.hosts ?? [])
			.filter(entry => !paradisIsReservedPresetHost(entry)))]
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

		// 全コントロールが出揃った時点で初期値を撮る。「開いた直後にいきなり確認が出る」ことを
		// 避けるため、dirty はここでの値との比較で判定する。
		this._trackEditState(() => ({
			name: nameInput.value,
			description: descriptionInput.value,
			folder: folderInput.value,
			action: actionSelect.value,
			prompt: promptInput.value,
			tasks: taskDrafts.map(draft => ({ name: draft.name, cwd: draft.cwd, commands: draft.commands })),
			layout: layoutSelect.value,
			icon: iconInput.value,
			cwd: cwdInput.value,
			pinned: pinnedInput.checked,
			pinnedLabel: pinnedLabelInput.checked,
			autoRun: autoRunInput.checked,
			target: workspaceRadio.checked ? 'workspace' : 'user',
			hostLocal: hostLocalInput.checked,
			hostRemote: hostRemoteInput.checked,
			hostChips: [...hostChips],
			appliesTo: appliesToInput.value,
		}));

		const errorEl = dom.append(this._contentEl, $('.ppe-error'));

		const footer = dom.append(this._contentEl, $('.ppe-footer'));
		const backBtn = dom.append(footer, $('button.ppe-btn')) as HTMLButtonElement;
		backBtn.textContent = STR_BACK;
		this._viewStore.add(dom.addDisposableListener(backBtn, 'click', () => {
			void this._confirmDiscardUnsaved().then(proceed => {
				if (proceed) {
					this._renderList();
				}
			});
		}));
		const saveBtn = dom.append(footer, $('button.ppe-btn.ppe-btn-primary')) as HTMLButtonElement;
		saveBtn.textContent = STR_SAVE;
		this._viewStore.add(dom.addDisposableListener(saveBtn, 'click', async () => {
			const name = nameInput.value.trim();
			if (!name) {
				errorEl.textContent = STR_NAME_REQUIRED;
				return;
			}
			const action = actionSelect.value as ParadisPresetAction;
			const tasks: IParadisPresetTask[] = action !== 'run' ? [] : taskDrafts
				.map(draft => ({
					name: draft.name.trim() || undefined,
					cwd: draft.cwd.trim() || undefined,
					commands: draft.commands.split('\n').map(line => line.trim()).filter(line => line.length > 0),
				}))
				.filter(task => task.commands.length > 0);
			const prompt = promptInput.value.replace(/\s+$/, '');
			if (action !== 'run' && prompt.trim().length === 0) {
				errorEl.textContent = action === 'insert' ? STR_COMMANDS_REQUIRED : STR_PROMPT_REQUIRED;
				return;
			}
			if (action === 'run' && tasks.length === 0) {
				errorEl.textContent = STR_COMMANDS_REQUIRED;
				return;
			}
			const appliesTo = appliesToInput.value.split('\n').map(line => line.trim()).filter(line => line.length > 0);
			// hosts 条件は UI の状態から paradisBuildPresetHosts が組み立てる（予約語の除去も含めて
			// 保存経路をそこ1本に絞ってある）。
			const hosts = paradisBuildPresetHosts({
				local: hostLocalInput.checked,
				remote: hostRemoteInput.checked,
				hosts: hostChips,
			});
			// 保存は常に新形式（tasks + layout）。旧形式の commands / launchMode はここで移行される
			const definition: IParadisPresetDefinition = {
				name,
				description: descriptionInput.value.trim() || undefined,
				folder: folderInput.value.trim() || undefined,
				// run は書かない（既定値。従来の定義と同じ形のまま保存し、古い版でも読めるようにする）
				action: action === 'run' ? undefined : action,
				prompt: action !== 'run' ? prompt : undefined,
				tasks: action !== 'run' ? undefined : tasks,
				layout: action === 'run' ? layoutSelect.value as ParadisPresetLayout : undefined,
				icon: iconInput.value.trim() || undefined,
				cwd: action === 'run' ? cwdInput.value.trim() || undefined : undefined,
				pinned: pinnedInput.checked,
				pinnedLabel: pinnedInput.checked && pinnedLabelInput.checked ? true : undefined,
				autoRun: action === 'run' && autoRunInput.checked,
				appliesTo: userRadio.checked && appliesTo.length > 0 ? appliesTo : undefined,
				hosts,
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
