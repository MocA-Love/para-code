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
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { GeneralShellType, TerminalShellType } from '../../../../platform/terminal/common/terminal.js';

/** ワークスペースフォルダ直下で認識する設定ファイル名。 */
export const PARADIS_WORKSPACE_PRESET_FILE = '.paracode.json';

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
	/** 表示名（ボタンのツールチップ・一覧に使う）。 */
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
	/** メニュー登録などに使う安定キー。 */
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
	/** 最初のターミナルまたはコマンドを開始した時点で呼び出す。 */
	readonly onDidStart?: () => void;
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

	/** プリセットを保存する（新規または name 一致の既存を置換）。 */
	savePreset(definition: IParadisPresetDefinition, target: ParadisPresetSource, replaceName?: string): Promise<void>;

	/** プリセットを定義元から削除する。 */
	deletePreset(preset: IParadisResolvedPreset): Promise<void>;
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
