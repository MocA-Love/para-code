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

/** ワークスペースフォルダ直下で認識する設定ファイル名。 */
export const PARADIS_WORKSPACE_PRESET_FILE = '.paracode.json';

/** 設定キー（ユーザーレベルのプリセット定義）。 */
export const PARADIS_PRESETS_SETTING = 'paradis.terminal.presets';

/**
 * プリセットの起動モード。
 * エディタ領域のターミナルは1エディタ=1ターミナルのため、「split」はエディタグループの分割になる。
 */
export const PARADIS_PRESET_LAUNCH_MODES = ['current-terminal', 'new-terminal', 'new-terminal-each', 'split'] as const;
export type ParadisPresetLaunchMode = typeof PARADIS_PRESET_LAUNCH_MODES[number];

/** プリセット定義（settings.json / .paracode.json に書かれる形そのまま）。 */
export interface IParadisPresetDefinition {
	/** 表示名（ボタンのツールチップ・一覧に使う）。 */
	readonly name: string;
	readonly description?: string;
	/** 実行するコマンド（上から順）。 */
	readonly commands: readonly string[];
	/** ボタンアイコンの codicon 名（例: "rocket"）。未指定は "run"。 */
	readonly icon?: string;
	/** 作業ディレクトリ。相対ならワークスペースフォルダ基準。未指定はワークスペースフォルダ。 */
	readonly cwd?: string;
	/** 起動モード。未指定は new-terminal。 */
	readonly launchMode?: ParadisPresetLaunchMode;
	/** ターミナルタブバー右側にボタンとして表示するか。未指定は true。 */
	readonly pinned?: boolean;
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

/** 定義の最低限のバリデーション（不正エントリは読み飛ばす）。 */
export function isValidPresetDefinition(value: unknown): value is IParadisPresetDefinition {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as IParadisPresetDefinition;
	return typeof candidate.name === 'string' && candidate.name.trim().length > 0
		&& Array.isArray(candidate.commands) && candidate.commands.length > 0
		&& candidate.commands.every(command => typeof command === 'string' && command.trim().length > 0);
}
