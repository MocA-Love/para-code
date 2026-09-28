/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Portions adapted from stablyai/orca (MIT): src/shared/claude-model-list-probe.ts

// 新しいスペースで選べるモデル候補を、インストール済みの CLI から取ってくるための共有定義。
//
// - Claude Code: `claude -p --input-format stream-json` に制御要求 `list_models` を1つ送ると、
//   /model の一覧をそのまま返す（API は呼ばない）。古い CLI は error を返すだけなので候補は空になる
// - Codex: `codex app-server` の `model/list`
//
// 置き換えるのは「既定のエージェント定義」のモデル候補だけ。設定 `paradis.workspaceSwitch.agents` を
// 利用者が自分で書いた行は、その内容を変えない（CLI が受け付けなくなった Codex のフラグだけは
// 読み替える）。今か過去の既定の行をそのまま書き写しただけの行は、CLI の候補を当てはめた今の既定の行に
// 差し替える。取れなかったときは今の固定の候補を使う。

import { Event } from '../../../../base/common/event.js';
import { equals } from '../../../../base/common/objects.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IParadisAgentCommandTemplate, IParadisAgentModelOption, PARADIS_CODEX_FULL_AUTO_FLAGS, PARADIS_DEFAULT_AGENT_COMMANDS, paradisCodexEffortFlag } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { PARADIS_PAST_DEFAULT_AGENT_COMMANDS } from './paradisAgentListPastDefaults.js';

export const PARADIS_AGENT_MODEL_CATALOG_CHANNEL = 'paradisAgentModelCatalog';

export const PARADIS_WORKSPACE_AGENTS_SETTING = 'paradis.workspaceSwitch.agents';

export type ParadisCatalogAgentId = 'claude' | 'codex';

/** CLI から取れたモデル1件。 */
export interface IParadisDiscoveredModel {
	/** `--model` に渡す値。 */
	readonly id: string;
	/** 選択肢に出す名前（無ければ id を出す）。 */
	readonly label?: string;
	/** 別名が今の CLI で指す正式なモデル id（Claude の `resolvedModel`。例: opus → claude-opus-5-5）。 */
	readonly resolvedModel?: string;
	/** 選べるエフォート。空配列 = エフォート非対応。 */
	readonly efforts: readonly string[];
	/** 「既定」を選んだときに実際に使われるエフォート。 */
	readonly defaultEffort?: string;
}

export interface IParadisAgentModelCatalog {
	readonly agentId: ParadisCatalogAgentId;
	/** 取得に使った CLI の `--version` の出力（キャッシュの鍵）。 */
	readonly cliVersion: string;
	readonly models: readonly IParadisDiscoveredModel[];
	readonly fetchedAt: number;
}

/**
 * `--model` の後ろに置く文字列。コマンドはシェルへそのまま渡るので、記号を含む id
 * （`opus[1m]` など。zsh では `[...]` がグロブになる）は二重引用符で囲む。二重引用符は
 * sh / zsh / PowerShell / cmd のどれでも同じ意味になる。それでも安全に書けない id は undefined（候補から外す）。
 */
export function paradisModelFlagValue(id: string): string | undefined {
	if (/^[A-Za-z0-9._:/-]+$/.test(id)) {
		return id;
	}
	return /^[A-Za-z0-9._:/\[\]-]+$/.test(id) ? `"${id}"` : undefined;
}

// ---------- Claude Code ----------

/** 会話ファイルを残さないフラグ（2.1.283 にはある。無い古い版では外して取り直す）。 */
export const PARADIS_CLAUDE_NO_SESSION_PERSISTENCE_FLAG = '--no-session-persistence';

/** `list_models` の制御要求（stdin に1行で書く）。 */
export const PARADIS_CLAUDE_MODEL_LIST_STDIN = `${JSON.stringify({
	type: 'control_request',
	request_id: 'para-code-model-catalog',
	request: { subtype: 'list_models' },
})}\n`;

/**
 * `list_models` を送るときの引数。
 * - `--verbose` が無いと `-p` は stream-json の出力を拒む
 * - 設定は利用者の層（`~/.claude/settings.json`）だけを読む。`-p` は workspace trust を確かめない
 *   ので、作業ディレクトリのプロジェクト設定（`apiKeyHelper` や `env` を書ける）を読ませない。
 *   2.1.283 で、作業ディレクトリの `.claude/settings.json` の hook が、これを付けないと走り、
 *   付けると走らないことを確かめている
 * - hook を一切動かさない（利用者の SessionStart hook や Para Code の通知 hook が、モデル一覧を
 *   取るだけの裏のプロセスで走らないように）。利用者の設定（使えるモデルの制限など）は読ませる
 * - MCP サーバーを起こさない。空の会話ファイルを残さない
 */
export const PARADIS_CLAUDE_MODEL_LIST_ARGS: readonly string[] = [
	'-p',
	'--setting-sources', 'user',
	'--settings', '{"disableAllHooks":true}',
	'--strict-mcp-config',
	PARADIS_CLAUDE_NO_SESSION_PERSISTENCE_FLAG,
	'--input-format', 'stream-json',
	'--output-format', 'stream-json',
	'--verbose',
];

/** 一覧に出てこないが CLI が受け付ける別名。既定の候補から引き継ぐ。 */
const CLAUDE_UNLISTED_ALIASES: readonly string[] = ['opusplan'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 説明文の先頭（`Opus 5.5 · Best for …` の `Opus 5.5`）。API キーで使っているときだけこの形になる。 */
function claudeDescriptionHead(description: unknown): string | undefined {
	if (typeof description !== 'string' || !description.includes('·')) {
		return undefined;
	}
	const head = description.split('·')[0].trim();
	return head.length > 0 && head.length <= 40 ? head : undefined;
}

/**
 * Claude の正式なモデル id から版つきの名前を作る（`claude-opus-5-5` → `Opus 5.5`、
 * `claude-haiku-4-5-20251001` → `Haiku 4.5`、`claude-opus-5-5[1m]` → `Opus 5.5 · 1M`）。形が違えば undefined。
 */
export function paradisClaudeModelDisplayName(modelId: string): string | undefined {
	const match = /^claude-(?<family>[a-z]+)-(?<major>\d+)(?:-(?<minor>\d{1,2}))?(?:-\d{8})?(?:\[(?<suffix>[a-z0-9]+)\])?$/i.exec(modelId.trim());
	if (!match?.groups) {
		return undefined;
	}
	const { family, major, minor, suffix } = match.groups;
	const name = `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor !== undefined ? `.${minor}` : ''}`;
	return suffix !== undefined ? `${name} · ${suffix.toUpperCase()}` : name;
}

/**
 * Claude の1行の名前。版が分かる順に、正式な id から作った名前・説明文の先頭・`displayName` を使う。
 * `displayName` は /model の見出し（`Opus` / `Fable`）で版を含まず、説明文はサブスクリプションで
 * 使っていると階層の説明（`Most capable for ambitious work`）になるため、どちらも最後の手段にする。
 */
function claudeModelName(entry: Record<string, unknown>, resolvedModel: string | undefined): string | undefined {
	const fromId = resolvedModel !== undefined ? paradisClaudeModelDisplayName(resolvedModel) : undefined;
	if (fromId !== undefined) {
		return fromId;
	}
	const name = claudeDescriptionHead(entry.description)
		?? (typeof entry.displayName === 'string' && entry.displayName.trim().length > 0 && entry.displayName.length <= 40 ? entry.displayName.trim() : undefined);
	// ラベルは `opus[1m] (<名前>)` の形にするので、名前の末尾の括弧（`Opus (1M context)`）は ` · ` に替えて二重にしない
	return name?.replace(/\s*\((?<note>[^()]+)\)$/, ' · $<note>');
}

/**
 * `list_models` の応答（stdout 全体）からモデル一覧を取り出す。取れなければ空配列。
 *
 * `default` の行は「今の既定が指す先」を写しただけなので外す（ダイアログには別に「既定」がある）。
 * `disabled` の行は CLI の更新が要るモデルの仮置きで、その値を `--model` に渡すと失敗するので外す。
 */
export function paradisParseClaudeModelList(stdout: string): IParadisDiscoveredModel[] {
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.startsWith('{') || !line.includes('control_response')) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const response = isRecord(parsed) && parsed.type === 'control_response' && isRecord(parsed.response) ? parsed.response : undefined;
		const models = response?.subtype === 'success' && isRecord(response.response) ? response.response.models : undefined;
		if (!Array.isArray(models)) {
			continue;
		}
		const seen = new Set<string>();
		const result: IParadisDiscoveredModel[] = [];
		for (const entry of models) {
			if (!isRecord(entry) || typeof entry.value !== 'string' || entry.disabled === true) {
				continue;
			}
			const id = entry.value.trim();
			if (id === 'default' || seen.has(id) || paradisModelFlagValue(id) === undefined) {
				continue;
			}
			seen.add(id);
			const resolvedModel = typeof entry.resolvedModel === 'string' && entry.resolvedModel.trim().length > 0 ? entry.resolvedModel.trim() : undefined;
			const name = claudeModelName(entry, resolvedModel);
			const efforts = entry.supportsEffort === true && Array.isArray(entry.supportedEffortLevels)
				? entry.supportedEffortLevels.filter((level): level is string => typeof level === 'string')
				: [];
			result.push({
				id,
				...(name !== undefined && name.toLowerCase() !== id.toLowerCase() ? { label: `${id} (${name})` } : {}),
				...(resolvedModel !== undefined ? { resolvedModel } : {}),
				efforts,
			});
		}
		if (result.length > 0) {
			return result;
		}
	}
	return [];
}

/** Claude Code の設定のうち、`--effort` を付けないときのエフォートを決める部分。 */
export interface IParadisClaudeEffortSettings {
	/** 環境変数 `CLAUDE_CODE_EFFORT_LEVEL`。設定より優先される。 */
	readonly envEffortLevel?: string;
	/** `settings.json` の `effortLevel`。 */
	readonly effortLevel?: string;
	/** `settings.json` の `modelSettings.<正式なモデル id>.effortLevel`。 */
	readonly modelEffortLevels?: Readonly<Record<string, string>>;
}

/** `settings.json` の中身から {@link IParadisClaudeEffortSettings} を取り出す（読めない値は捨てる）。 */
export function paradisReadClaudeEffortSettings(settings: unknown, envEffortLevel: string | undefined): IParadisClaudeEffortSettings {
	const effortLevel = isRecord(settings) && typeof settings.effortLevel === 'string' ? settings.effortLevel : undefined;
	const modelEffortLevels: Record<string, string> = {};
	if (isRecord(settings) && isRecord(settings.modelSettings)) {
		for (const [model, value] of Object.entries(settings.modelSettings)) {
			if (isRecord(value) && typeof value.effortLevel === 'string') {
				modelEffortLevels[paradisNormalizeClaudeModelId(model)] = value.effortLevel;
			}
		}
	}
	const env = envEffortLevel?.trim();
	return {
		...(env ? { envEffortLevel: env } : {}),
		...(effortLevel !== undefined ? { effortLevel } : {}),
		...(Object.keys(modelEffortLevels).length > 0 ? { modelEffortLevels } : {}),
	};
}

/** 照合用に正式なモデル id から `[1m]` と日付を外す（`claude-haiku-4-5-20251001` → `claude-haiku-4-5`）。 */
export function paradisNormalizeClaudeModelId(modelId: string): string {
	return modelId.trim().toLowerCase().replace(/\[[a-z0-9]+\]$/, '').replace(/-\d{8}$/, '');
}

/**
 * Claude の各モデルに「既定」を選んだときのエフォートを添える。Claude Code は `--effort` が無いと
 * 環境変数 → `modelSettings` のそのモデルの値 → `effortLevel` → モデルごとの既定、の順に決める。
 * そのモデルが選べない値は飛ばして次を見る。最後の「モデルごとの既定」は `list_models` に無いので、
 * ここでは足さない（既定の候補の値を引き継ぐ）。
 *
 * 限界: 読むのは環境変数と利用者の `settings.json` だけ。プロジェクトの設定（`.claude/settings*.json`）と
 * 組織の managed settings、`maxEffortLevel` による上限は見ないので、そこで決めている人には実際と違う値が出る。
 */
export function paradisApplyClaudeDefaultEfforts(models: readonly IParadisDiscoveredModel[], settings: IParadisClaudeEffortSettings): IParadisDiscoveredModel[] {
	return models.map(model => {
		const resolved = model.resolvedModel !== undefined ? paradisNormalizeClaudeModelId(model.resolvedModel) : undefined;
		const candidates = [settings.envEffortLevel, resolved !== undefined ? settings.modelEffortLevels?.[resolved] : undefined, settings.effortLevel];
		const effort = candidates.find(candidate => candidate !== undefined && model.efforts.includes(candidate));
		return effort !== undefined ? { ...model, defaultEffort: effort } : model;
	});
}

// ---------- Codex ----------

/** `model/list` の応答（1ページ分）からモデル一覧を取り出す。`hidden` は外す。 */
export function paradisParseCodexModelList(result: unknown): IParadisDiscoveredModel[] {
	const data = isRecord(result) && Array.isArray(result.data) ? result.data : [];
	const models: IParadisDiscoveredModel[] = [];
	for (const entry of data) {
		if (!isRecord(entry) || entry.hidden === true) {
			continue;
		}
		const id = typeof entry.model === 'string' && entry.model.length > 0 ? entry.model : typeof entry.id === 'string' ? entry.id : '';
		if (paradisModelFlagValue(id) === undefined) {
			continue;
		}
		const efforts = Array.isArray(entry.supportedReasoningEfforts)
			? entry.supportedReasoningEfforts.map(effort => isRecord(effort) ? effort.reasoningEffort : undefined).filter((effort): effort is string => typeof effort === 'string')
			: [];
		models.push({
			id,
			efforts,
			...(typeof entry.defaultReasoningEffort === 'string' ? { defaultEffort: entry.defaultReasoningEffort } : {}),
		});
	}
	return models;
}

/** `model/list` の次のページの目印（無ければ undefined）。 */
export function paradisCodexModelListNextCursor(result: unknown): string | undefined {
	return isRecord(result) && typeof result.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : undefined;
}

// ---------- 既定の定義への当てはめ ----------

function toModelOption(template: IParadisAgentCommandTemplate, model: IParadisDiscoveredModel): IParadisAgentModelOption {
	const previous = template.models?.find(option => option.id === model.id);
	const defaultEffort = model.defaultEffort ?? previous?.defaultEffort;
	return {
		id: model.id,
		...(model.label !== undefined ? { label: model.label } : previous?.label !== undefined ? { label: previous.label } : {}),
		...(model.resolvedModel !== undefined ? { resolvedModel: model.resolvedModel } : {}),
		flag: `--model ${paradisModelFlagValue(model.id)}`,
		efforts: model.efforts,
		...(defaultEffort !== undefined && model.efforts.includes(defaultEffort) ? { defaultEffort } : {}),
	};
}

/**
 * 既定のエージェント定義のモデル候補を、CLI から取れた一覧で置き換える。
 * 取れていないエージェント（空の一覧を含む）は既定のまま残す。
 * エフォートの語彙は、既定の語彙に無いものが一覧に現れたときだけ同じ書式で足す。
 */
export function paradisApplyDiscoveredModels(templates: readonly IParadisAgentCommandTemplate[], catalogs: readonly IParadisAgentModelCatalog[]): IParadisAgentCommandTemplate[] {
	return templates.map(template => {
		const catalog = catalogs.find(candidate => candidate.agentId === template.id);
		if (catalog === undefined || catalog.models.length === 0 || template.models === undefined) {
			return template;
		}
		const models = catalog.models.map(model => toModelOption(template, model));
		if (template.id === 'claude') {
			for (const alias of CLAUDE_UNLISTED_ALIASES) {
				const option = template.models.find(candidate => candidate.id === alias);
				if (option !== undefined && !models.some(model => model.id === alias)) {
					models.push(option);
				}
			}
		}
		let efforts = template.efforts;
		if (efforts !== undefined) {
			const known = new Set(efforts.map(effort => effort.id));
			const added = [...new Set(catalog.models.flatMap(model => model.efforts))].filter(effort => !known.has(effort) && /^[a-z0-9_-]+$/i.test(effort));
			if (added.length > 0) {
				efforts = [...efforts, ...added.map(id => ({ id, flag: template.id === 'codex' ? paradisCodexEffortFlag(id) : `--effort ${id}` }))];
			}
		}
		return { ...template, models, ...(efforts !== undefined ? { efforts } : {}) };
	});
}

// ---------- 画面側が使う入口 ----------

/** 今と過去の既定値に含まれていた行を id ごとに並べたもの（settings.json に書き写されたときの JSON の形）。 */
let knownDefaultRows: Map<string, unknown[]> | undefined;

function defaultRowsById(): Map<string, unknown[]> {
	if (knownDefaultRows === undefined) {
		knownDefaultRows = new Map();
		const current: unknown[] = JSON.parse(JSON.stringify(PARADIS_DEFAULT_AGENT_COMMANDS));
		for (const row of [...current, ...PARADIS_PAST_DEFAULT_AGENT_COMMANDS.flat()]) {
			const id = isRecord(row) && typeof row.id === 'string' ? row.id : undefined;
			if (id !== undefined) {
				knownDefaultRows.set(id, [...knownDefaultRows.get(id) ?? [], row]);
			}
		}
	}
	return knownDefaultRows;
}

/**
 * 設定の1行が、同じ id の今か過去の既定の行をそのまま書き写したものか。設定エディタの
 * 「settings.json で編集」はその時点の既定値を丸ごと書き写すので、そういう行は利用者が決めたものではない。
 */
export function paradisIsKnownDefaultAgentRow(row: unknown): boolean {
	const id = isRecord(row) && typeof row.id === 'string' ? row.id : undefined;
	return id !== undefined && (defaultRowsById().get(id) ?? []).some(known => equals(row, known));
}

/** 'none' は「実行しない」を表す予約識別子（セグメントの固定項目）なので、設定に書かれていても使わない。 */
function isUsableRow(row: unknown): row is IParadisAgentCommandTemplate {
	return isRecord(row) && typeof row.id === 'string' && row.id !== 'none' && typeof row.command === 'string';
}

/** 設定に書かれた一覧。どの層にも値が無い・配列でない・空なら undefined（既定の一覧を使う）。 */
function configuredAgentRows(configurationService: IConfigurationService): readonly IParadisAgentCommandTemplate[] | undefined {
	// `getValue` は未設定でもスキーマの既定値を返すので、どこかの層に値があるときだけ読む
	const inspected = configurationService.inspect<unknown>(PARADIS_WORKSPACE_AGENTS_SETTING);
	const layers = [
		inspected.applicationValue, inspected.userValue, inspected.userLocalValue, inspected.userRemoteValue,
		inspected.workspaceValue, inspected.workspaceFolderValue, inspected.memoryValue, inspected.policyValue,
	];
	if (layers.every(value => value === undefined)) {
		return undefined;
	}
	const configured = configurationService.getValue<unknown>(PARADIS_WORKSPACE_AGENTS_SETTING);
	return Array.isArray(configured) && configured.length > 0 ? configured.filter(isUsableRow) : undefined;
}

/**
 * 設定に書かれた行のうち、利用者が自分で書いた（既定の行を書き写しただけではない）もの。
 * 既定に無い id の行と、既定の行を書き換えた行が入る。
 */
export function paradisCustomAgentRows(configurationService: IConfigurationService): readonly IParadisAgentCommandTemplate[] {
	return (configuredAgentRows(configurationService) ?? []).filter(row => !paradisIsKnownDefaultAgentRow(row));
}

/**
 * 利用者が `paradis.workspaceSwitch.agents` に、既定と違う行を書いているか（ダイアログの「設定で固定中」）。
 * 既定の行を書き写しただけの行は数えない。行を消したり並べ替えたりしただけなら固定とはみなさない。
 */
export function paradisIsAgentListUserDefined(configurationService: IConfigurationService): boolean {
	return paradisCustomAgentRows(configurationService).length > 0;
}

/** CLI から取ったモデル一覧を使う行があるか（無ければ CLI を起こさない）。 */
export function paradisAgentListUsesCatalog(configurationService: IConfigurationService): boolean {
	const rows = configuredAgentRows(configurationService);
	return rows === undefined || rows.some(row => (row.id === 'claude' || row.id === 'codex') && paradisIsKnownDefaultAgentRow(row));
}

/** 既定へ戻すときに消せない層（利用者に理由を伝えるため）。 */
export type ParadisAgentListBlockedLayer = 'workspaceFolder' | 'policy' | 'application';

/** 既定へ戻すと消える行と、戻せない層。 */
export interface IParadisAgentListResetPlan {
	/** 既定に無い id の行（利用者が足したエージェント）。 */
	readonly addedIds: readonly string[];
	/** 既定にある id だが、中身を書き換えた行。 */
	readonly modifiedIds: readonly string[];
	/** 値があっても Para Code からは消せない層。 */
	readonly blockedLayers: readonly ParadisAgentListBlockedLayer[];
}

export function paradisAgentListResetPlan(configurationService: IConfigurationService): IParadisAgentListResetPlan {
	const custom = paradisCustomAgentRows(configurationService);
	const defaults = defaultRowsById();
	const inspected = configurationService.inspect<unknown>(PARADIS_WORKSPACE_AGENTS_SETTING);
	const blockedLayers: ParadisAgentListBlockedLayer[] = [];
	if (inspected.workspaceFolderValue !== undefined) {
		blockedLayers.push('workspaceFolder');
	}
	if (inspected.policyValue !== undefined) {
		blockedLayers.push('policy');
	}
	if (inspected.applicationValue !== undefined) {
		blockedLayers.push('application');
	}
	return {
		addedIds: custom.filter(row => !defaults.has(row.id)).map(row => row.id),
		modifiedIds: custom.filter(row => defaults.has(row.id)).map(row => row.id),
		blockedLayers,
	};
}

/**
 * 設定に書かれた一覧を消して既定へ戻す（利用者の設定・ワークスペースの設定・メモリ上の値）。
 * フォルダの設定・ポリシー・アプリケーションの層の値は消せない（{@link paradisAgentListResetPlan} の blockedLayers）。
 */
export async function paradisResetAgentListSetting(configurationService: IConfigurationService): Promise<void> {
	const inspected = configurationService.inspect<unknown>(PARADIS_WORKSPACE_AGENTS_SETTING);
	const targets: ConfigurationTarget[] = [];
	if (inspected.userLocalValue !== undefined || inspected.userValue !== undefined) {
		targets.push(ConfigurationTarget.USER_LOCAL);
	}
	if (inspected.userRemoteValue !== undefined) {
		targets.push(ConfigurationTarget.USER_REMOTE);
	}
	if (inspected.workspaceValue !== undefined) {
		targets.push(ConfigurationTarget.WORKSPACE);
	}
	if (inspected.memoryValue !== undefined) {
		targets.push(ConfigurationTarget.MEMORY);
	}
	for (const target of targets) {
		await configurationService.updateValue(PARADIS_WORKSPACE_AGENTS_SETTING, undefined, target);
	}
}

/** シェルの語に分ける（引用符は外す）。コマンドの形を見るためだけのもので、厳密な解釈はしない。 */
function shellWords(command: string): string[] {
	const words: string[] = [];
	let word: string | undefined;
	let quote: '"' | '\'' | undefined;
	for (const character of command.trim()) {
		if (quote !== undefined) {
			if (character === quote) {
				quote = undefined;
			} else {
				word = (word ?? '') + character;
			}
		} else if (character === '"' || character === '\'') {
			quote = character;
			word ??= '';
		} else if (/\s/.test(character)) {
			if (word !== undefined) {
				words.push(word);
				word = undefined;
			}
		} else {
			word = (word ?? '') + character;
		}
	}
	if (word !== undefined) {
		words.push(word);
	}
	return words;
}

/** Codex の値を取るオプション（`resources/paradis/bin/codex` の一覧と同じ）。サブコマンドを探すときに値を飛ばす。 */
const CODEX_OPTIONS_WITH_VALUE = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval']);

/**
 * Codex を起動するコマンドなら、その後ろの引数（Codex 自身に渡る部分）の位置を返す。
 * `codex` / パスの末尾が codex / 引用符で包んだパス / 先頭の `env X=1` と `X=1` / `npx`・`bunx`・`pnpm dlx` 経由
 * （`codex` か `@openai/codex[@版]`）を見分ける。Codex でなければ undefined。
 */
function codexArgumentsIndex(words: readonly string[]): number | undefined {
	let index = 0;
	if (words[index] === 'env') {
		index++;
	}
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) {
		index++;
	}
	const runner = words[index];
	if (runner === 'npx' || runner === 'bunx' || (runner === 'pnpm' && words[index + 1] === 'dlx')) {
		index += runner === 'pnpm' ? 2 : 1;
		while (index < words.length && words[index].startsWith('-')) {
			index++;
		}
		return /^(codex|@openai\/codex)(@[^\s]+)?$/i.test(words[index] ?? '') ? index + 1 : undefined;
	}
	return /(^|[\\/])codex(\.cmd|\.exe|\.ps1)?$/i.test(words[index] ?? '') ? index + 1 : undefined;
}

/** Codex の非対話のサブコマンド（`exec` / `e`）で起動するか。`exec` は `--ask-for-approval` を受け付けない。 */
function isCodexExec(words: readonly string[], argumentsIndex: number): boolean {
	for (let index = argumentsIndex; index < words.length; index++) {
		const word = words[index];
		if (word === '--' || word.startsWith('{')) {
			return false;
		}
		if (!word.startsWith('-')) {
			return word === 'exec' || word === 'e';
		}
		if (!word.includes('=') && CODEX_OPTIONS_WITH_VALUE.has(word)) {
			index++;
		}
	}
	return false;
}

/**
 * フラグ文字列の中の、codex-cli 0.155.1 が受け付けない指定を読み替える。
 * - `--effort <id>`（`--effort=<id>`、引用符付き、`--effort {effort}` を含む）→ `-c model_reasoning_effort=<id>`
 * - `--full-auto` → `--sandbox workspace-write --ask-for-approval on-request`。`exec` は `--ask-for-approval` を
 *   拒否するので、`exec` のときは `--sandbox workspace-write` だけにする
 */
function upgradeCodexFlagText(text: string, exec: boolean): string {
	return text
		.replace(/(^|\s)--effort(?:\s+|=)(["']?)(?<value>\{effort\}|[A-Za-z0-9_-]+)\2(?=\s|$)/g, (...args) => {
			const groups = args[args.length - 1] as { value: string };
			return `${args[1]}${paradisCodexEffortFlag(groups.value)}`;
		})
		.replace(/(^|\s)--full-auto(?=\s|$)/g, (_all, lead: string) => `${lead}${exec ? '--sandbox workspace-write' : PARADIS_CODEX_FULL_AUTO_FLAGS}`);
}

/**
 * 利用者が書いた Codex の定義にある、codex-cli 0.155.1 が受け付けないフラグを読み替える
 * （コマンド・モデル・エフォート・権限のフラグすべて）。どちらも渡すと Codex が起動しないので、
 * 書いた内容よりも起動できることを優先する。Codex のコマンドでなければそのまま返す。
 */
export function paradisUpgradeLegacyCodexFlags(template: IParadisAgentCommandTemplate): IParadisAgentCommandTemplate {
	if (typeof template.command !== 'string') {
		return template;
	}
	const words = shellWords(template.command);
	const argumentsIndex = codexArgumentsIndex(words);
	if (argumentsIndex === undefined) {
		return template;
	}
	const exec = isCodexExec(words, argumentsIndex);
	const upgrade = (flag: unknown) => typeof flag === 'string' ? upgradeCodexFlagText(flag, exec) : flag;
	const mapFlags = <T extends { readonly flag: string }>(options: readonly T[] | undefined) => Array.isArray(options)
		? options.map(option => isRecord(option) ? { ...option, flag: upgrade(option.flag) } : option)
		: options;
	return {
		...template,
		command: upgradeCodexFlagText(template.command, exec),
		...(template.models !== undefined ? { models: mapFlags(template.models) } : {}),
		...(template.efforts !== undefined ? { efforts: mapFlags(template.efforts) } : {}),
		...(template.permissions !== undefined ? { permissions: mapFlags(template.permissions) } : {}),
	};
}

/**
 * 新しいスペースで選べるエージェント定義。ダイアログとモバイルからの作成で同じ規則を使う。
 * - 設定に一覧が無ければ、既定の定義に CLI から取れたモデル候補を当てはめたもの
 * - 一覧があれば、その並びのまま行ごとに決める。既定の行を書き写しただけの行（今か過去の既定と同じ）は、
 *   CLI の候補を当てはめた今の既定の行に差し替える。利用者が足した行・書き換えた行はそのまま使う
 *   （Codex の古いフラグだけ読み替える）。消した行は足さない
 */
export function paradisResolveAgentTemplates(configurationService: IConfigurationService, catalogs: readonly IParadisAgentModelCatalog[]): readonly IParadisAgentCommandTemplate[] {
	const defaults = catalogs.length > 0 ? paradisApplyDiscoveredModels(PARADIS_DEFAULT_AGENT_COMMANDS, catalogs) : PARADIS_DEFAULT_AGENT_COMMANDS;
	const configured = configuredAgentRows(configurationService);
	if (configured === undefined) {
		return defaults;
	}
	return configured.map(row => (paradisIsKnownDefaultAgentRow(row) ? defaults.find(candidate => candidate.id === row.id) : undefined) ?? paradisUpgradeLegacyCodexFlags(row));
}

export const IParadisAgentModelCatalogService = createDecorator<IParadisAgentModelCatalogService>('paradisAgentModelCatalogService');

/** 新しいスペースの作成で使うエージェント定義を持つ（画面側）。 */
export interface IParadisAgentModelCatalogService {
	readonly _serviceBrand: undefined;
	/** CLI から取った一覧が変わった。 */
	readonly onDidChange: Event<void>;
	/** 今わかっている一覧で組み立てたエージェント定義（{@link paradisResolveAgentTemplates}）。 */
	getAgentTemplates(): readonly IParadisAgentCommandTemplate[];
	/**
	 * CLI から取り直すよう頼む。結果は {@link onDidChange} で届く。shared process 側で
	 * 60 秒は同じ結果を使い回し、CLI は版が変わったときだけ起こすので、ダイアログを開くたびに呼んでよい。
	 */
	refresh(): void;
	/**
	 * 設定 `paradis.workspaceSwitch.agents` に既定と違う行があり、その行は CLI から取った候補を使わないか
	 * （{@link paradisIsAgentListUserDefined}）。変わったときも {@link onDidChange} が来る。
	 */
	isFixedBySettings(): boolean;
	/**
	 * 確かめてから設定の一覧を消し、既定（CLI から取った候補）へ戻す。
	 * 確認で「settings.json を開く」が選ばれたときは開かずに 'openSettings' を返す。呼び出した画面が
	 * 自分のダイアログを閉じてから {@link openSettingsJson} を呼ぶ（ダイアログの背面に開くと編集できないため）。
	 */
	resetToDefault(): Promise<ParadisAgentListResetResult>;
	/** 設定 `paradis.workspaceSwitch.agents` の場所で、利用者の settings.json を開く。 */
	openSettingsJson(): Promise<void>;
}

/** {@link IParadisAgentModelCatalogService.resetToDefault} の結果。 */
export type ParadisAgentListResetResult = 'reset' | 'openSettings' | 'unchanged';
