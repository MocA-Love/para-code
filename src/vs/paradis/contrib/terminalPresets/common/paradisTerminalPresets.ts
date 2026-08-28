/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// コマンドプリセット機能（Superset の Terminal Presets 相当）の共通型定義。
// プリセットは2つのレベルで定義できる:
//   - ユーザーレベル: 設定 paradis.terminal.presets（appliesTo で対象リポジトリを絞れる）
//   - リポジトリレベル: ワークスペースフォルダ直下の .paracode.json（そのリポジトリでのみ有効。
//     コミットすればチームや worktree 全体に行き渡る）

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { GeneralShellType, ITerminalEnvironment, TerminalShellType } from '../../../../platform/terminal/common/terminal.js';
import { paradisSshHostFromAuthority } from '../../../common/paradisHostPath.js';

/** ワークスペースフォルダ直下で認識する設定ファイル名。 */
export const PARADIS_WORKSPACE_PRESET_FILE = '.paracode.json';

/**
 * 親リポジトリの絶対パスを渡す環境変数名。
 * .paracode.json に書ける2種類のコマンド（setup/teardown スクリプトと、worktree 作成直後に
 * 自動実行されるプリセット）の両方へ同じ名前で渡す。片方でしか使えないと「同じファイルに
 * 書いたのに動かない」という混乱を生むため、置き場所によらず同じ変数名で解決できるようにする。
 */
export const PARADIS_PROJECT_ROOT_ENV_VAR = 'PARACODE_PROJECT_ROOT_PATH';

/** 設定キー（ユーザーレベルのプリセット定義）。 */
export const PARADIS_PRESETS_SETTING = 'paradis.terminal.presets';

/**
 * 設定キー（空でも存在する「フォルダ」の台帳、ユーザーレベル）。
 * フォルダ自体はプリセットの folder フィールドが一致するだけの存在（下記コメント参照）だが、
 * それだと中身が0件になった瞬間に一覧・ナビから消えてしまう。中身が無くてもフォルダを
 * 残しておきたい場合に、この台帳へ名前だけを書く。
 */
export const PARADIS_PRESET_FOLDERS_SETTING = 'paradis.terminal.presetFolders';

/**
 * hosts 条件の特殊値: SSH 未接続（ローカル）のウィンドウでのみ有効。
 * ホスト名との衝突は受け入れる——`local` という名前の SSH ホストを「hosts: ["local"]」で
 * 指した場合もローカル扱いになるが、その運用は設定側でホスト別名を変えて避ける。
 */
export const PARADIS_PRESET_HOST_LOCAL = 'local';

/**
 * hosts 条件の特殊値: リモート接続中ならどのホストでも有効。
 *
 * SSH 以外の接続先（WSL・devcontainer 等）も含む——条件の実体は「未接続でない」ことであって、
 * 接続方式は問わない。「SSH」という呼び名は主な利用形態に合わせたもの。
 */
export const PARADIS_PRESET_HOST_REMOTE = 'remote';

/**
 * プリセットの起動モード（旧形式）。
 * エディタ領域のターミナルは1エディタ=1ターミナルのため、「split」はエディタグループの分割になる。
 * 新形式では tasks + layout を使う（paradisGetPresetTasks が両形式を正規化する）。
 */
export const PARADIS_PRESET_LAUNCH_MODES = ['current-terminal', 'new-terminal', 'new-terminal-each', 'split'] as const;
export type ParadisPresetLaunchMode = typeof PARADIS_PRESET_LAUNCH_MODES[number];

/**
 * タスク群（＝ターミナル群）の並べ方。
 *   - tabs: 各タスクをアクティブグループのタブとして並べる
 *   - split: エディタグループを右→下の交互に分割してタスクごとに並べる
 *   - current: 全タスクのコマンドを連結してアクティブなターミナルに送る（旧 current-terminal 相当）
 *   - smart: current と同じくアクティブなターミナルへ連結して送るが、そのターミナルが
 *     コマンド実行中（busy）なら送らずに新しいターミナルを作る
 */
export const PARADIS_PRESET_LAYOUTS = ['tabs', 'split', 'current', 'smart'] as const;
export type ParadisPresetLayout = typeof PARADIS_PRESET_LAYOUTS[number];

/** 1タスク = 1ターミナル。名前・作業ディレクトリ・そのターミナルで順に実行するコマンド列を持つ。 */
export interface IParadisPresetTask {
	/** ターミナルのタイトル。未指定はプリセット名。 */
	readonly name?: string;
	/** 作業ディレクトリ。相対ならワークスペースフォルダ基準。未指定はプリセットの cwd。 */
	readonly cwd?: string;
	/** このターミナルで実行するコマンド（上から順、失敗時は後続を実行しない）。 */
	readonly commands: readonly string[];
}

/** プリセット定義（settings.json / .paracode.json に書かれる形そのまま）。 */
export interface IParadisPresetDefinition {
	/**
	 * このプリセットの識別子。**名前は識別子ではない**（同じ名前のプリセットを複数登録できる）。
	 *
	 * ユーザー設定（settings.json）へ保存するときは自動で採番して書き込む。改名しても同じ
	 * プリセットとして追跡でき、同名が並んでも削除・並び替えが取り違えない。
	 * リポジトリの .paracode.json には**書き足さない**（git で共有されるファイルの差分を
	 * 増やさないため）。id を持たない定義は「定義元ファイル内の位置」で識別する。
	 */
	readonly id?: string;
	/** 表示名（ボタンのツールチップ・一覧に使う）。同名の重複を許す。 */
	readonly name: string;
	readonly description?: string;
	/** 旧形式: 実行するコマンド（上から順）。tasks があればそちらが優先。 */
	readonly commands?: readonly string[];
	/** 新形式: タスク（＝ターミナル）ごとのコマンド定義。 */
	readonly tasks?: readonly IParadisPresetTask[];
	/** tasks の並べ方。未指定は tabs。 */
	readonly layout?: ParadisPresetLayout;
	/** ボタンアイコンの codicon 名（例: "rocket"）。未指定は "run"。 */
	readonly icon?: string;
	/** 既定の作業ディレクトリ。相対ならワークスペースフォルダ基準。未指定はワークスペースフォルダ。 */
	readonly cwd?: string;
	/** 旧形式: 起動モード。未指定は new-terminal。tasks があれば無視される。 */
	readonly launchMode?: ParadisPresetLaunchMode;
	/**
	 * 所属フォルダ名（任意）。同じ保存先・同じ名前の値を持つプリセット同士が、一覧でフォルダとして
	 * まとめて表示される（{@link paradisGroupPresetsByFolder}）。フォルダ自体は独立した実体ではなく、
	 * この文字列タグの一致だけで成り立つ——空フォルダという状態は存在しない。
	 */
	readonly folder?: string;
	/** ターミナルタブバー右側にボタンとして表示するか。未指定は true。 */
	readonly pinned?: boolean;
	/** ピン留めボタンにアイコンに加えて名前も表示するか。未指定は false（アイコンのみ）。 */
	readonly pinnedLabel?: boolean;
	/** 「新しいスペース（worktree）を作成」直後に自動実行するか。 */
	readonly autoRun?: boolean;
	/**
	 * ユーザーレベル専用: このプリセットを表示するリポジトリの条件。
	 * フォルダ名（basename）または絶対パスで指定。未指定は全リポジトリで有効。
	 */
	readonly appliesTo?: readonly string[];
	/**
	 * このプリセットを有効にする実行環境（接続先マシン）の条件。複数指定は OR、
	 * {@link IParadisPresetDefinition.appliesTo} とは AND。未指定はどこでも有効。
	 *
	 * 値は次のいずれか:
	 *   - {@link PARADIS_PRESET_HOST_LOCAL}（"local"）: SSH 未接続のウィンドウで有効
	 *   - {@link PARADIS_PRESET_HOST_REMOTE}（"remote"）: SSH 接続中ならどのホストでも有効
	 *   - それ以外: ~/.ssh/config の Host エントリ名（authority `ssh-remote+<host>` の後半）と
	 *     大小文字を無視して比較し、一致する接続先のウィンドウでのみ有効
	 *
	 * appliesTo と違い .paracode.json 側でも意味を持つ——同じリポジトリを手元と SSH 先の両方に
	 * clone している構成では、リポジトリ名やパスの一致では両者を区別できないため。
	 */
	readonly hosts?: readonly string[];
}

/** プリセットの保存元。 */
export type ParadisPresetSource = 'user' | 'workspace';

/** 現在のワークスペースで有効な、解決済みプリセット。 */
export interface IParadisResolvedPreset extends IParadisPresetDefinition {
	/** 保存元（user = settings.json / workspace = .paracode.json）。 */
	readonly source: ParadisPresetSource;
	/** workspace ソースの場合、定義元の .paracode.json の URI。 */
	readonly sourceUri?: URI;
	/**
	 * 定義元（設定配列 / .paracode.json の presets 配列）における位置。
	 * 保存・削除・並び替えはこの位置を使う。**名前で探さない**（同名が並びうるため）。
	 */
	readonly sourceIndex: number;
	/** メニュー登録などに使う安定キー。id があれば id 由来、無ければ位置由来。 */
	readonly key: string;
	/**
	 * workspace ソース専用: このマシンでだけ、タブバーへの表示から外されているか（計算値。
	 * 定義そのものには存在しないフィールドで、.paracode.json には一切書き込まれない）。
	 * リポジトリ由来のプリセットを「自分だけ非表示にしたい」場合に使う——`pinned: false` を
	 * 書き込むと git で共有されるファイルがチーム全員分書き換わってしまうため、
	 * {@link IParadisPresetService.setWorkspacePresetLocallyHidden} は代わりにこのマシンだけの
	 * 台帳へ記録する。
	 */
	readonly locallyHidden?: boolean;
	/**
	 * hosts 条件（{@link IParadisPresetDefinition.hosts}）が現在のウィンドウの接続先と
	 * 一致しないことを示す計算値。定義そのものには存在しないフィールドで、設定には書き込まれない。
	 *
	 * appliesTo と違い、この条件は「同一設定を別ウィンドウで見たときの差」なので、条件不一致でも
	 * 管理ダイアログからは消さない——完全に消すと「SSH 先でしか出ないプリセット」を手元から
	 * 編集する手段が失われる。代わりにタブバー・QuickPick・モバイル・autoRun といった
	 * **実行の入り口側で `envInactive` を除外し**、ダイアログでは薄表示＋実行不可で示す。
	 */
	readonly envInactive?: boolean;
}

/** 空でも存在できるフォルダの台帳エントリ（プリセットが1件も無くても一覧に残せる）。 */
export interface IParadisResolvedPresetFolder {
	readonly name: string;
	readonly source: ParadisPresetSource;
	readonly sourceUri?: URI;
	/** 定義元配列（設定 or .paracode.json の presetFolders）内の位置。削除に使う。 */
	readonly sourceIndex: number;
}

/** プリセット実行時に呼び出し側が指定できる一時的な実行条件。 */
export interface IParadisRunPresetOptions {
	/** 相対 cwd の基準（および cwd 未指定時の作業ディレクトリ）。 */
	readonly cwd?: URI;
	/** current-terminal 指定でも既存のアクティブ端末を再利用しない。 */
	readonly forceNewTerminal?: boolean;
	/**
	 * 新規作成したターミナルインスタンスを明示的に紐付けるワークスペース切り替えの状態キー。
	 * 未指定なら既定の（生成時点でアクティブな状態キーへの）暗黙タグ付けに任せる。
	 * 呼び出し元が「今アクティブなスコープとは限らない対象」（worktree 作成直後の自動実行等）を
	 * 明確に把握している場合に指定し、生成〜表示の間にユーザーが別スコープへ切り替えても
	 * 誤った (現在アクティブな) スコープへ紐付いてしまう競合を防ぐ。
	 */
	readonly stateKey?: string;
	/**
	 * 新規作成するターミナルへ渡す環境変数。既存の環境（ウィンドウの環境と
	 * terminal.integrated.env.* 設定）へマージされる（strictEnv を立てないため）。
	 * ただし既定プロファイル自身が同じキーを持つ場合はプロファイル側が優先される。
	 * 値に null を入れるとその変数を削除できる。
	 * 既存ターミナルを再利用する経路（layout: current かつ forceNewTerminal 未指定、または
	 * layout: smart でアクティブなターミナルが busy でなく再利用されたとき）では、起動済み
	 * プロセスの環境を変更できないため反映されない。
	 */
	readonly env?: ITerminalEnvironment;
	/** 最初のターミナルまたはコマンドを開始した時点で呼び出す。 */
	readonly onDidStart?: () => void;
	/**
	 * このプリセットがターミナルを作るたびに、その instanceId を渡す。
	 * 呼び出し側が「実行の前後でインスタンス一覧の差分を取る」方法に頼らないために要る——
	 * 1タスクごとにプロセスの起動を待つので実行は実時間で数秒かかり、その間にPCの操作や
	 * 別の要求が作った無関係なターミナルまで拾ってしまう。
	 */
	readonly onDidCreateTerminal?: (instanceId: number) => void;
}

/** 保存時の指定。 */
export interface IParadisSavePresetOptions {
	/**
	 * 置き換える既存プリセット。編集（同じ1件を書き換える）と、同名衝突で「置き換える」を
	 * 選んだ場合にだけ渡す。未指定なら新しい1件として追加する。
	 */
	readonly replace?: IParadisResolvedPreset;
}

export const IParadisPresetService = createDecorator<IParadisPresetService>('paradisPresetService');

export interface IParadisPresetService {
	readonly _serviceBrand: undefined;

	/** 有効なプリセット集合が変わったとき（設定変更・.paracode.json 変更・フォルダ切り替え）。 */
	readonly onDidChangePresets: Event<void>;

	/** 現在のワークスペースで有効なプリセット（appliesTo 解決済み）。 */
	readonly presets: readonly IParadisResolvedPreset[];

	/** 空でも存在するフォルダの台帳（既にプリセットが1件以上あるフォルダ名は含まない——重複表示を避けるため）。 */
	readonly folders: readonly IParadisResolvedPresetFolder[];

	/**
	 * 指定フォルダで有効なプリセットをその場で読み直して返す（キャッシュ非依存）。
	 * worktree 作成直後など、onDidChangeWorkspaceFolders 由来の再読込を待てない場面で使う。
	 */
	getPresetsForFolder(folderUri: URI): Promise<readonly IParadisResolvedPreset[]>;

	/**
	 * プリセットを実行する。
	 * @param options.cwd 相対 cwd の基準（および cwd 未指定時の作業ディレクトリ）を明示する。
	 *   worktree 作成直後などワークスペースフォルダの反映を待てない場面で使う。
	 */
	runPreset(preset: IParadisResolvedPreset, options?: IParadisRunPresetOptions): Promise<void>;

	/**
	 * プリセットを保存する。
	 * `options.replace` を渡したときだけ既存の1件を置き換え、渡さなければ常に新しい1件として
	 * 追加する（同じ名前の既存プリセットがあっても上書きしない）。
	 */
	savePreset(definition: IParadisPresetDefinition, target: ParadisPresetSource, options?: IParadisSavePresetOptions): Promise<void>;

	/**
	 * プリセットを同一スコープ内で1つ前(-1)／後ろ(+1)へ移動する（表示順＝配列順を入れ替える）。
	 * スコープ（user / workspace）や workspace の定義元ファイルをまたぐ移動はしない（no-op）。
	 */
	movePreset(preset: IParadisResolvedPreset, direction: -1 | 1): Promise<void>;

	/** プリセットを定義元から削除する。 */
	deletePreset(preset: IParadisResolvedPreset): Promise<void>;

	/**
	 * 複数プリセットへ folder ラベルをまとめて設定する。フォルダへの移動・フォルダから出す・
	 * フォルダ名の変更（既存メンバー全員へ新しい名前を書き戻す）に使う。
	 * 対象が複数の定義元ファイル（ユーザー設定・複数リポジトリの .paracode.json）にまたがっていても、
	 * ファイルごとに1回ずつ読み書きする。
	 */
	setPresetsFolder(presets: readonly IParadisResolvedPreset[], folder: string | undefined): Promise<void>;

	/** 複数プリセットをまとめて削除する（対象が複数の定義元ファイルにまたがっていてもよい）。 */
	deletePresets(presets: readonly IParadisResolvedPreset[]): Promise<void>;

	/**
	 * 空のフォルダを作る。同名のフォルダ（台帳・実プリセットの folder いずれか）が既にあれば
	 * 何もせず false を返す（作成できたときは true）。呼び出し側は false のとき、無言で
	 * 成功したかのように扱わず、名前が重複している旨をユーザーへ伝えること。
	 */
	createFolder(name: string, target: ParadisPresetSource): Promise<boolean>;

	/** 台帳から空フォルダを削除する（中身のプリセットには触れない——呼び出し側は中身が0件であることを確認してから呼ぶこと）。 */
	deleteFolder(folder: IParadisResolvedPresetFolder): Promise<void>;

	/**
	 * ピン留め（タブバーへの表示）だけを切り替える。定義元ファイルの他のフィールドには一切触れない
	 * ——`source`/`sourceUri`/`sourceIndex`/`key` は解決済みプリセットが持つ実装都合の値であり、
	 * これらをそのまま書き込むと user 設定や .paracode.json（git 共有）へ絶対パス等が混入する。
	 *
	 * workspace ソースのプリセットを非表示にしたいだけなら、こちらではなく
	 * {@link setWorkspacePresetLocallyHidden} を使う（定義元ファイルを一切変更しない）。
	 */
	setPresetPinned(preset: IParadisResolvedPreset, pinned: boolean): Promise<void>;

	/**
	 * workspace ソース（.paracode.json 由来）のプリセットを、このマシンでだけタブバーから
	 * 隠す／戻す。git で共有される定義元ファイルには一切書き込まない——リポジトリの持ち主が
	 * チーム向けに登録したプリセットを、自分の画面でだけ非表示にしたい場合に使う。
	 * user ソースのプリセットに対しては no-op（{@link setPresetPinned} を使う）。
	 */
	setWorkspacePresetLocallyHidden(preset: IParadisResolvedPreset, hidden: boolean): void;

	/**
	 * 2つのプリセットの並び順（定義元ファイル内の位置）を入れ替える。
	 * 保存先や定義元ファイルが異なる組み合わせでは何もしない。
	 */
	swapPresets(presetA: IParadisResolvedPreset, presetB: IParadisResolvedPreset): Promise<void>;
}

// --- 識別 ----------------------------------------------------------------------------------------

/**
 * プリセットの安定キー。id を持つ定義（ユーザー設定で保存したもの）は id 由来、持たない定義
 * （手書き、および .paracode.json）は定義元での位置由来にする。
 *
 * 位置由来のキーは並び替え・削除でずれる。ずれると、このキーを覚えている側の記録が別の
 * プリセットを指す。モバイルの実行承認は「もう一度内容を確認する」という安全側に倒れるが、
 * **モバイルで非表示にしたものの一覧（app/mobile/src/presets.ts の visiblePresets）は安全側に
 * 倒れない**——隠していないものが消え、隠したものが出る。それでもこの形にしているのは、
 * git で共有される .paracode.json へ実装都合の識別子を書き足すコストの方が高いため。
 * ユーザー設定（id を持てる）側では起きない。
 *
 * `definition.id` は {@link paradisUsablePresetId} で正規化済みであること（文字列でない id や
 * 重複した id をそのまま渡すと、別のプリセットと同じキーになる）。
 */
export function paradisPresetKey(source: ParadisPresetSource, sourceUri: URI | undefined, definition: IParadisPresetDefinition, index: number): string {
	const suffix = typeof definition.id === 'string' && definition.id.length > 0 ? definition.id : `#${index}`;
	return source === 'workspace' ? `workspace:${sourceUri?.toString() ?? ''}:${suffix}` : `user:${suffix}`;
}

/**
 * 読み込んだ定義の id を、識別子として使ってよいものだけに正規化する。
 *
 * 設定ファイルは手で編集できるので、id が文字列でないことも、エントリごとコピーされて
 * **同じ id が2つある**こともある。重複した id をそのまま使うと、2件目を編集・削除した
 * つもりで1件目が書き換わる（id を主キーにした以上、ここが最悪の事故になる）。
 * 使えない id は捨てて位置で識別させる。
 *
 * @param taken 既に使われた id。この関数が呼ばれるたびに書き足す。
 */
export function paradisUsablePresetId(definition: IParadisPresetDefinition, taken: Set<string>): string | undefined {
	const id = definition.id;
	if (typeof id !== 'string' || id.length === 0 || taken.has(id)) {
		return undefined;
	}
	taken.add(id);
	return id;
}

/**
 * 定義の中身から作る指紋。「その位置に居るのが本当に当人か」を確かめるために使う。
 *
 * 名前とコマンドだけでは足りない——同名・同コマンドで作業ディレクトリや対象リポジトリだけが
 * 違う2件は、この機能では**正規に並べて登録できる**。片方が外部で消えたときに、残った双子を
 * 当人と誤認して上書き・削除してしまう。ユーザーが編集できる項目はすべて突き合わせる。
 */
export function paradisPresetFingerprint(definition: IParadisPresetDefinition, options?: { readonly ignoreAppliesTo?: boolean }): string {
	const { tasks, layout } = paradisGetPresetTasks(definition);
	return JSON.stringify([
		definition.name.trim(),
		(definition.description ?? '').trim(),
		(definition.cwd ?? '').trim(),
		definition.icon ?? '',
		// リポジトリレベルでは appliesTo は読み込み時に捨てられる（そのリポジトリ自体が対象）。
		// 解決済みの側には残っていないので、突き合わせからも外す。
		options?.ignoreAppliesTo ? [] : definition.appliesTo?.map(entry => entry.trim()) ?? [],
		definition.hosts?.map(entry => entry.trim()) ?? [],
		(definition.folder ?? '').trim(),
		definition.pinned !== false,
		definition.pinnedLabel === true,
		definition.autoRun === true,
		layout,
		tasks.map(task => [task.name ?? '', task.cwd ?? '', task.commands]),
	]);
}

/**
 * hosts 条件を人間向けの短い語に整える（同名区別語・実行不可の説明など表示共用）。
 * 特殊値は表示語へ、それ以外はホスト名そのもの。重複は除去する。
 */
export function paradisPresetHostsLabel(hosts: readonly string[] | undefined): string | undefined {
	const entries = (hosts ?? []).map(entry => entry.trim()).filter(entry => entry.length > 0);
	if (entries.length === 0) {
		return undefined;
	}
	const labels = entries.map(host => {
		if (host === PARADIS_PRESET_HOST_LOCAL) {
			// allow-any-unicode-next-line
			return localize('paradis.presetHostQualifier.local', "ローカル");
		}
		if (host === PARADIS_PRESET_HOST_REMOTE) {
			// allow-any-unicode-next-line
			return localize('paradis.presetHostQualifier.remote', "リモート");
		}
		return host;
	});
	const unique = [...new Set(labels)];
	return unique.length > 0 ? unique.join(', ') : undefined;
}

/**
 * hosts 条件（{@link IParadisPresetDefinition.hosts}）が現在の接続先と一致するか。
 *
 * @param currentAuthority 現在のウィンドウの remote authority。未接続（ローカル）なら undefined
 *   （`environmentService.remoteAuthority` は未接続で空文字になるため呼び出し側で空を落とす）。
 *   接続先は 1 ウィンドウにつき 1 つで起動後に変わらないため、再評価は設定変更時だけで足りる。
 */
export function paradisPresetHostsMatch(hosts: readonly string[] | undefined, currentAuthority: string | undefined): boolean {
	const entries = (hosts ?? []).map(entry => entry.trim()).filter(entry => entry.length > 0);
	if (entries.length === 0) {
		return true;
	}
	const sshHost = paradisSshHostFromAuthority(currentAuthority)?.toLowerCase();
	return entries.some(entry => {
		if (entry === PARADIS_PRESET_HOST_LOCAL) {
			return !currentAuthority;
		}
		if (entry === PARADIS_PRESET_HOST_REMOTE) {
			return !!currentAuthority;
		}
		// 特定ホスト名。ssh-remote 以外の接続先（devcontainer 等）にはホスト名が無いので不一致。
		return !!sshHost && entry.toLowerCase() === sshHost;
	});
}

/**
 * その語が hosts 条件の特殊値（"local" / "remote"）か。
 *
 * {@link paradisPresetHostsMatch} は特殊値を**完全一致**で判定するので、ここも完全一致で見る。
 * 大文字を含む "Local" は特殊値ではなくホスト名として扱われる（照合時に小文字化されるため、
 * 実際に `local` という名前の SSH ホストへ繋いでいるときだけ一致する）。
 */
export function paradisIsReservedPresetHost(value: string): boolean {
	return value === PARADIS_PRESET_HOST_LOCAL || value === PARADIS_PRESET_HOST_REMOTE;
}

/**
 * 編集 UI の状態（ローカル☑ / リモート☑ / ホスト列挙）から hosts 条件を組み立てる。
 *
 * **ホスト列挙から特殊値を落とす**のがこの関数の要。ホスト名の欄に "local" と打ててしまうと、
 * 「リモートの local という名前のホストだけ」のつもりが `["local"]` として保存され、条件が
 * 「SSH 未接続のときだけ」へ**裏返る**（読み直すとチップも消えるので、UI 上は何も残らない）。
 * 保存経路をここ1本に絞って、その化けを起こせなくする。
 *
 * ホスト列挙があるときは "remote" を書かない（列挙が「リモート有効＋絞り込み」を含意するため
 * 冗長。読み込み側は列挙の存在でリモートのチェックを復元する）。
 */
export function paradisBuildPresetHosts(selection: { readonly local: boolean; readonly remote: boolean; readonly hosts: readonly string[] }): string[] | undefined {
	const entries: string[] = [];
	if (selection.local) {
		entries.push(PARADIS_PRESET_HOST_LOCAL);
	}
	if (selection.remote) {
		const named = selection.hosts.map(host => host.trim()).filter(host => host.length > 0 && !paradisIsReservedPresetHost(host));
		entries.push(...(named.length > 0 ? named : [PARADIS_PRESET_HOST_REMOTE]));
	}
	return entries.length > 0 ? entries : undefined;
}

/**
 * 書き戻す直前のリストから、対象プリセットの位置を解決する。見つからなければ -1。
 *
 * 一覧を開いてから保存するまでの間に、設定ファイルを手で編集したり別ウィンドウで並び替えたり
 * された可能性があるので、覚えていた位置をそのまま信じない。id があれば id で、無ければ
 * 「その位置の中身が指紋まで一致するか」で確かめる。
 */
export function paradisResolvePresetIndex(list: readonly unknown[], preset: IParadisResolvedPreset): number {
	if (preset.id) {
		const byId = list.findIndex(entry => isValidPresetDefinition(entry) && entry.id === preset.id);
		if (byId >= 0) {
			return byId;
		}
	}
	const candidate = list[preset.sourceIndex];
	const options = { ignoreAppliesTo: preset.source === 'workspace' };
	return isValidPresetDefinition(candidate) && paradisPresetFingerprint(candidate, options) === paradisPresetFingerprint(preset, options)
		? preset.sourceIndex
		: -1;
}

/** パス文字列（絶対パスでもフォルダ名でも）の最後のセグメント。区別語を短く保つために使う。 */
function lastSegment(value: string): string {
	const segments = value.replace(/[\\/]+$/, '').split(/[\\/]/);
	return segments[segments.length - 1] || value;
}

/**
 * 同名のプリセットを見分けるための短い語。**そのプリセットを他と分けている値**を使う。
 * 名前が唯一なら表示に使わない（{@link paradisPresetQualifiers} が同名のときだけ配る）。
 *
 * 候補の順序は「ユーザーが区別のために書いたと解釈できる度合い」で決めている。
 */
export function paradisPresetQualifier(preset: IParadisResolvedPreset): string | undefined {
	const appliesTo = preset.appliesTo?.map(entry => entry.trim()).filter(entry => entry.length > 0) ?? [];
	if (appliesTo.length > 0) {
		return appliesTo.map(lastSegment).join(', ');
	}
	// hosts 条件は「このプリセットを他と分けている値」の筆頭。同名が「ローカル用 / gpu-node01 用」
	// と並ぶとき、その違いをここで短い語にして見せる。
	const hostsLabel = paradisPresetHostsLabel(preset.hosts);
	if (hostsLabel) {
		return hostsLabel;
	}
	const folder = preset.folder?.trim();
	if (folder) {
		return folder;
	}
	const cwd = preset.cwd?.trim();
	if (cwd) {
		return cwd;
	}
	const taskCwds = [...new Set(paradisGetPresetTasks(preset).tasks.map(task => task.cwd?.trim()).filter((cwd): cwd is string => !!cwd))];
	if (taskCwds.length === 1) {
		return taskCwds[0];
	}
	if (preset.source === 'workspace' && preset.sourceUri) {
		// .paracode.json の1つ上＝そのリポジトリのフォルダ名。複数リポジトリを開いているときに
		// 「どのリポジトリのプリセットか」が唯一の違いになるケースを拾う。
		const segments = preset.sourceUri.path.split('/').filter(segment => segment.length > 0);
		return segments.length >= 2 ? segments[segments.length - 2] : undefined;
	}
	return undefined;
}

/**
 * 一覧のうち同じ名前が2件以上あるものにだけ区別語を割り当てた表（キー → 区別語）。
 * 単独の名前には何も割り当てない——区別が要らない場面で表示を増やさないため。
 */
export function paradisPresetQualifiers(presets: readonly IParadisResolvedPreset[]): Map<string, string> {
	const counts = new Map<string, number>();
	for (const preset of presets) {
		const name = preset.name.trim();
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const result = new Map<string, string>();
	for (const preset of presets) {
		if ((counts.get(preset.name.trim()) ?? 0) < 2) {
			continue;
		}
		const qualifier = paradisPresetQualifier(preset);
		if (qualifier) {
			result.set(preset.key, qualifier);
		}
	}
	return result;
}

// --- フォルダ ------------------------------------------------------------------------------------
//
// フォルダは基本的には独立した実体を持たない——プリセットの folder フィールドが同じ値であることだけで
// 成り立つ（{@link IParadisPresetDefinition.folder}）。そのため保存先ファイルへ実装都合のレコードを
// 足さずに済むが、それだけだと中身が0件になった瞬間にフォルダそのものが一覧から消えてしまう。
// 空でもフォルダを残したい場合だけ、軽量な台帳（{@link IParadisResolvedPresetFolder}、
// PARADIS_PRESET_FOLDERS_SETTING）に名前を書く。台帳はメイン一覧のフォルダグループ化には関わらず、
// ナビ（左サイドバー）とフォルダ名の入力補完（datalist・移動先メニュー）にだけ使われる
// （{@link paradisAllFolderNames}）。

/**
 * プリセット（または空フォルダ台帳エントリ）の保存先の識別キー。保存先が異なれば同じフォルダ名
 * でも別のフォルダとして扱う（書き込み先を跨がないため）。↑↓の移動可否判定（隣接プリセットが
 * 同一スコープか）や、ゴースト台帳削除のスコープ絞り込みにも使う——ロジックを複数箇所に
 * 重複させると、フォルダのグループ化・移動可否判定・削除範囲が食い違いかねない。
 * {@link IParadisResolvedPreset} と {@link IParadisResolvedPresetFolder} はどちらも
 * `source`/`sourceUri` を持つため、そのどちらも受け取れる。
 */
export function paradisPresetScopeKey(entry: { readonly source: ParadisPresetSource; readonly sourceUri?: URI }): string {
	return entry.source === 'workspace' ? `workspace:${entry.sourceUri?.toString() ?? ''}` : 'user';
}

/** 一覧の1グループ。folder が undefined の場合は「フォルダに入っていない」単独のプリセット（presets は必ず1件）。 */
export interface IParadisPresetGroup {
	readonly folder?: string;
	readonly presets: readonly IParadisResolvedPreset[];
}

/**
 * 表示順を保ったまま、同じ保存先・同じフォルダ名を持つプリセットをグループ化する。
 * グループの並び順は「そのフォルダが最初に現れた位置」で決まる——フォルダの中身が定義元ファイル内で
 * 連続していなくても、一覧ではフォルダとしてまとめて表示される。
 */
export function paradisGroupPresetsByFolder(presets: readonly IParadisResolvedPreset[]): readonly IParadisPresetGroup[] {
	const groups: { folder?: string; presets: IParadisResolvedPreset[] }[] = [];
	const indexByKey = new Map<string, number>();
	for (const preset of presets) {
		const folder = preset.folder?.trim();
		if (!folder) {
			groups.push({ presets: [preset] });
			continue;
		}
		const key = `${paradisPresetScopeKey(preset)}::${folder}`;
		const existingIndex = indexByKey.get(key);
		if (existingIndex === undefined) {
			indexByKey.set(key, groups.length);
			groups.push({ folder, presets: [preset] });
		} else {
			groups[existingIndex].presets.push(preset);
		}
	}
	return groups;
}

/** 現在のプリセット群に存在するフォルダ名の一覧（重複除去、出現順）。「フォルダへ移動」メニューに使う。 */
export function paradisDistinctFolderNames(presets: readonly IParadisResolvedPreset[]): readonly string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const preset of presets) {
		const folder = preset.folder?.trim();
		if (folder && !seen.has(folder)) {
			seen.add(folder);
			result.push(folder);
		}
	}
	return result;
}

/**
 * 実プリセットの folder 名（{@link paradisDistinctFolderNames}）と、空フォルダ台帳
 * （{@link IParadisResolvedPresetFolder}）をマージした名前一覧。実プリセット由来を先に、
 * 台帳にしかない名前をその後ろに、それぞれ出現順で並べる。
 */
export function paradisAllFolderNames(presets: readonly IParadisResolvedPreset[], folders: readonly IParadisResolvedPresetFolder[]): readonly string[] {
	const fromPresets = paradisDistinctFolderNames(presets);
	const seen = new Set(fromPresets);
	const result = [...fromPresets];
	for (const folder of folders) {
		const name = folder.name.trim();
		if (name && !seen.has(name)) {
			seen.add(name);
			result.push(name);
		}
	}
	return result;
}

/** 保存しようとしている定義と、同じ保存先にある既存プリセットとの名前の衝突具合。 */
export const enum ParadisPresetNameConflict {
	/** 同じ名前は無い。そのまま保存してよい。 */
	None = 'none',
	/** 同じ名前はあるが、一覧やボタンで見分けが付く（区別語か説明が違う）。 */
	Distinguishable = 'distinguishable',
	/** 同じ名前で、区別語も説明も同じ。並べても見分けが付かない。 */
	Indistinguishable = 'indistinguishable',
}

/** 名前の衝突の内訳。どれと衝突したかまで返す（置き換え先を取り違えないため）。 */
export interface IParadisPresetNameConflict {
	readonly kind: ParadisPresetNameConflict;
	/** 同じ名前の既存プリセット。 */
	readonly sameName: readonly IParadisResolvedPreset[];
	/**
	 * 見分けが付かない相手（kind が Indistinguishable のときだけ）。
	 * 置き換えるならこれを指す。**同名の先頭ではない**——同名が3件あって2件目とだけ
	 * 区別が付かない場合、先頭を置き換えると無関係な1件を潰すことになる。
	 */
	readonly indistinguishableFrom?: IParadisResolvedPreset;
}

/**
 * 保存しようとしている定義が、既存プリセットと名前で衝突するかを分類する。
 *
 * @param others **同じ書き込み先**にある既存プリセット（ユーザー設定なら user 全件、
 *   リポジトリなら書き込む .paracode.json 由来のものだけ）。編集中の当人は呼び出し側で除く。
 *   書き込み先で絞るのは呼び出し側の責任で、ここは絞られている前提で区別語を比べる
 *   （区別語の候補にはリポジトリ名が含まれ、それは同じファイル内では全員等しい）。
 */
export function paradisFindPresetNameConflict(definition: IParadisPresetDefinition, others: readonly IParadisResolvedPreset[]): IParadisPresetNameConflict {
	const name = definition.name.trim();
	const sameName = others.filter(other => other.name.trim() === name);
	if (sameName.length === 0) {
		return { kind: ParadisPresetNameConflict.None, sameName };
	}
	// paradisPresetQualifier は「表示に出す1つの代表値」を選ぶ表示用のヒューリスティックで、
	// 衝突判定にはそのまま使えない——候補の優先順位（appliesTo > folder > cwd > ...）のせいで、
	// 先に来た候補が同じなら後ろの候補の違いが常に覆い隠される（例: フォルダだけ違う2件が
	// 「見分けが付かない」と誤判定される／同じフォルダで cwd だけ違う2件も同様）。
	// ここでは「見分けに使える値」を全部並べた合成キーで比較する——1つでも違えば区別できる。
	const distinctnessKeyOf = (candidate: IParadisPresetDefinition): string => JSON.stringify([
		(candidate.appliesTo ?? []).map(entry => entry.trim()).filter(entry => entry.length > 0).sort(),
		(candidate.hosts ?? []).map(entry => entry.trim()).filter(entry => entry.length > 0).sort(),
		(candidate.folder ?? '').trim(),
		(candidate.cwd ?? '').trim(),
		[...new Set(paradisGetPresetTasks(candidate).tasks.map(task => task.cwd?.trim()).filter((cwd): cwd is string => !!cwd))].sort(),
		(candidate.description ?? '').trim(),
	]);
	const key = distinctnessKeyOf(definition);
	const indistinguishableFrom = sameName.find(other => distinctnessKeyOf(other) === key);
	return indistinguishableFrom
		? { kind: ParadisPresetNameConflict.Indistinguishable, sameName, indistinguishableFrom }
		: { kind: ParadisPresetNameConflict.Distinguishable, sameName };
}

/** PowerShell 5.1を含む実行シェルに合わせ、失敗時に後続を実行しないコマンド列へ変換する。 */
export function paradisJoinPresetCommands(commands: readonly string[], shellType: TerminalShellType): string {
	if (commands.length === 0) {
		return '';
	}
	if (shellType !== GeneralShellType.PowerShell) {
		return commands.join(' && ');
	}
	let joined = commands[commands.length - 1];
	for (let index = commands.length - 2; index >= 0; index--) {
		joined = `${commands[index]}; if ($?) { ${joined} }`;
	}
	return joined;
}

function isValidCommandList(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.length > 0
		&& value.every(command => typeof command === 'string' && command.trim().length > 0);
}

/** hosts 条件の 1 エントリ。特殊値（local/remote）か、空でないホスト名の文字列。 */
function isValidHostEntry(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isValidPresetTask(value: unknown): value is IParadisPresetTask {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as IParadisPresetTask;
	return isValidCommandList(candidate.commands)
		&& (candidate.name === undefined || typeof candidate.name === 'string')
		&& (candidate.cwd === undefined || typeof candidate.cwd === 'string');
}

/** 定義の最低限のバリデーション（不正エントリは読み飛ばす）。旧形式(commands)・新形式(tasks)の両方を受け付ける。 */
export function isValidPresetDefinition(value: unknown): value is IParadisPresetDefinition {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as IParadisPresetDefinition;
	if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) {
		return false;
	}
	if (candidate.folder !== undefined && candidate.folder !== null && typeof candidate.folder !== 'string') {
		return false;
	}
	if (candidate.hosts !== undefined && (!Array.isArray(candidate.hosts) || !candidate.hosts.every(isValidHostEntry))) {
		return false;
	}
	if (Array.isArray(candidate.tasks)) {
		return candidate.tasks.length > 0 && candidate.tasks.every(isValidPresetTask);
	}
	return isValidCommandList(candidate.commands);
}

/**
 * 旧形式（commands + launchMode）・新形式（tasks + layout）を「タスク列＋レイアウト」に正規化する。
 * 旧形式の読み替え:
 *   - new-terminal（既定）: 全コマンドで1タスク、tabs
 *   - current-terminal: 全コマンドで1タスク、current
 *   - new-terminal-each: コマンドごとに1タスク、tabs
 *   - split: コマンドごとに1タスク、split
 */
export function paradisGetPresetTasks(definition: IParadisPresetDefinition): { readonly tasks: readonly IParadisPresetTask[]; readonly layout: ParadisPresetLayout } {
	const normalizeCommands = (commands: readonly string[]) =>
		commands.map(command => command.trim()).filter(command => command.length > 0);

	if (definition.tasks && definition.tasks.length > 0) {
		const tasks = definition.tasks
			.map(task => ({ ...task, commands: normalizeCommands(task.commands) }))
			.filter(task => task.commands.length > 0);
		return { tasks, layout: definition.layout ?? 'tabs' };
	}

	const commands = normalizeCommands(definition.commands ?? []);
	if (commands.length === 0) {
		return { tasks: [], layout: 'tabs' };
	}
	switch (definition.launchMode ?? 'new-terminal') {
		case 'current-terminal':
			return { tasks: [{ commands }], layout: 'current' };
		case 'new-terminal-each':
			return { tasks: commands.map(command => ({ commands: [command] })), layout: 'tabs' };
		case 'split':
			return { tasks: commands.map(command => ({ commands: [command] })), layout: 'split' };
		default:
			return { tasks: [{ commands }], layout: 'tabs' };
	}
}

/** 全タスクの全コマンドを1つの文字列にする（確認ダイアログ・一覧プレビュー用）。 */
export function paradisPresetCommandSignature(definition: IParadisPresetDefinition, separator = '\n'): string {
	return paradisGetPresetTasks(definition).tasks.flatMap(task => task.commands).join(separator);
}

/** ツールチップに載せるコマンド要約の上限。ボタンの説明であって本文の表示ではない。 */
export const PARADIS_PRESET_TOOLTIP_COMMAND_MAX_LENGTH = 120;

/**
 * ボタン1つで何が起きるかをホバーで補う。アイコンだけのピン留めボタンは、これが
 * 「押す前に中身を知る」唯一の手段になる（同名グループでは区別語も併記する）。
 * タブバーのボタン（{@link paradisPresetEditorDialog.ts} の一覧プレビューではなく、実際に
 * ホバーする側）と、そのカスタム描画（ParadisPresetClusterViewItem）の両方から使う共通実装。
 */
export function paradisPresetTooltip(preset: IParadisResolvedPreset, qualifier: string | undefined): string {
	const commands = paradisPresetCommandSignature(preset, ' && ');
	return [
		// allow-any-unicode-next-line
		qualifier ? localize('paradis.presetTooltip.name', "{0}（{1}）", preset.name, qualifier) : preset.name,
		preset.description,
		commands.length > PARADIS_PRESET_TOOLTIP_COMMAND_MAX_LENGTH ? `${commands.slice(0, PARADIS_PRESET_TOOLTIP_COMMAND_MAX_LENGTH)}…` : commands,
	].filter((part): part is string => !!part).join(' — ');
}

/**
 * autoRun の承認ハッシュ用の署名。コマンドに加えて作業ディレクトリ（プリセット既定・タスク別）も含める。
 * 同じコマンドでも実行場所が変われば意味が変わるため、cwd だけの書き換えで承認をすり抜けられないようにする。
 * cwd 指定が一切無い場合は旧実装（commands.join('\n')）と同値になり、既存の承認を無効化しない。
 */
export function paradisPresetApprovalSignature(definition: IParadisPresetDefinition): string {
	const parts: string[] = [];
	const presetCwd = definition.cwd?.trim();
	if (presetCwd) {
		parts.push(`#cwd:${presetCwd}`);
	}
	for (const task of paradisGetPresetTasks(definition).tasks) {
		const taskCwd = task.cwd?.trim();
		if (taskCwd) {
			parts.push(`#cwd:${taskCwd}`);
		}
		parts.push(...task.commands);
	}
	return parts.join('\n');
}
