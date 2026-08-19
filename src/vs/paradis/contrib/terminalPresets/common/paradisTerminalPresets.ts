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
 */
export const PARADIS_PRESET_LAYOUTS = ['tabs', 'split', 'current'] as const;
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
	 * 既存ターミナルを再利用する経路（layout: current かつ forceNewTerminal 未指定）では、
	 * 起動済みプロセスの環境を変更できないため反映されない。
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
	 * ピン留め（タブバーへの表示）だけを切り替える。定義元ファイルの他のフィールドには一切触れない
	 * ——`source`/`sourceUri`/`sourceIndex`/`key` は解決済みプリセットが持つ実装都合の値であり、
	 * これらをそのまま書き込むと user 設定や .paracode.json（git 共有）へ絶対パス等が混入する。
	 */
	setPresetPinned(preset: IParadisResolvedPreset, pinned: boolean): Promise<void>;

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
		(definition.folder ?? '').trim(),
		definition.pinned !== false,
		definition.pinnedLabel === true,
		definition.autoRun === true,
		layout,
		tasks.map(task => [task.name ?? '', task.cwd ?? '', task.commands]),
	]);
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
// フォルダは独立した実体を持たない——プリセットの folder フィールドが同じ値であることだけで
// 成り立つ（{@link IParadisPresetDefinition.folder}）。そのため「空フォルダ」は表現できないが、
// 保存先ファイルへ実装都合のレコードを足さずに済む。

/**
 * プリセットの保存先の識別キー。保存先が異なれば同じフォルダ名でも別のフォルダとして扱う
 * （書き込み先を跨がないため）。↑↓の移動可否判定（隣接プリセットが同一スコープか）にも使う——
 * ロジックを2箇所に重複させると、フォルダのグループ化と移動可否判定が食い違いかねない。
 */
export function paradisPresetScopeKey(preset: IParadisResolvedPreset): string {
	return preset.source === 'workspace' ? `workspace:${preset.sourceUri?.toString() ?? ''}` : 'user';
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
