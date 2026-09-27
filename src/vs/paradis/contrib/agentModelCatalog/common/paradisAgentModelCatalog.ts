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
// 利用者が自分で書いている場合は、その内容を一切変えない。取れなかったときは今の固定の候補を使う。

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IParadisAgentCommandTemplate, IParadisAgentModelOption, PARADIS_DEFAULT_AGENT_COMMANDS } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';

export const PARADIS_AGENT_MODEL_CATALOG_CHANNEL = 'paradisAgentModelCatalog';

export const PARADIS_WORKSPACE_AGENTS_SETTING = 'paradis.workspaceSwitch.agents';

export type ParadisCatalogAgentId = 'claude' | 'codex';

/** CLI から取れたモデル1件。 */
export interface IParadisDiscoveredModel {
	/** `--model` に渡す値。 */
	readonly id: string;
	/** 選択肢に出す名前（無ければ id を出す）。 */
	readonly label?: string;
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

/** `list_models` の制御要求（stdin に1行で書く）。 */
export const PARADIS_CLAUDE_MODEL_LIST_STDIN = `${JSON.stringify({
	type: 'control_request',
	request_id: 'para-code-model-catalog',
	request: { subtype: 'list_models' },
})}\n`;

/**
 * `list_models` を送るときの引数。
 * - `--verbose` が無いと `-p` は stream-json の出力を拒む
 * - hook を一切動かさない（利用者の SessionStart hook や Para Code の通知 hook が、モデル一覧を
 *   取るだけの裏のプロセスで走らないように）。利用者の設定（使えるモデルの制限など）は読ませる
 * - MCP サーバーを起こさない
 */
export const PARADIS_CLAUDE_MODEL_LIST_ARGS: readonly string[] = [
	'-p',
	'--settings', '{"disableAllHooks":true}',
	'--strict-mcp-config',
	'--input-format', 'stream-json',
	'--output-format', 'stream-json',
	'--verbose',
];

/** 一覧に出てこないが CLI が受け付ける別名。既定の候補から引き継ぐ。 */
const CLAUDE_UNLISTED_ALIASES: readonly string[] = ['opusplan'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 説明文の先頭（`Opus 5.5 · Best for …` の `Opus 5.5`）。 */
function claudeDescriptionHead(description: unknown): string | undefined {
	if (typeof description !== 'string') {
		return undefined;
	}
	const head = description.split('·')[0].trim();
	return head.length > 0 && head.length <= 40 ? head : undefined;
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
			const head = claudeDescriptionHead(entry.description);
			const efforts = entry.supportsEffort === true && Array.isArray(entry.supportedEffortLevels)
				? entry.supportedEffortLevels.filter((level): level is string => typeof level === 'string')
				: [];
			result.push({ id, ...(head !== undefined && head.toLowerCase() !== id.toLowerCase() ? { label: `${id} (${head})` } : {}), efforts });
		}
		if (result.length > 0) {
			return result;
		}
	}
	return [];
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
				efforts = [...efforts, ...added.map(id => ({ id, flag: `--effort ${id}` }))];
			}
		}
		return { ...template, models, ...(efforts !== undefined ? { efforts } : {}) };
	});
}

// ---------- 画面側が使う入口 ----------

/**
 * 利用者が `paradis.workspaceSwitch.agents` を自分で書いているか。
 * `getValue` は未設定でもスキーマの既定値（既定の定義）を返すので、どの層に値があるかで判断する。
 */
export function paradisIsAgentListUserDefined(configurationService: IConfigurationService): boolean {
	const inspected = configurationService.inspect<unknown>(PARADIS_WORKSPACE_AGENTS_SETTING);
	return [
		inspected.applicationValue,
		inspected.userValue,
		inspected.userLocalValue,
		inspected.userRemoteValue,
		inspected.workspaceValue,
		inspected.workspaceFolderValue,
		inspected.memoryValue,
		inspected.policyValue,
	].some(value => value !== undefined);
}

let discoveredCatalogs: readonly IParadisAgentModelCatalog[] = [];

/** CLI から取れた一覧を覚える（画面側の取得役だけが呼ぶ）。 */
export function paradisSetDiscoveredAgentModels(catalogs: readonly IParadisAgentModelCatalog[]): void {
	discoveredCatalogs = catalogs;
}

/**
 * 新しいスペースで選べるエージェント定義。ダイアログとモバイルからの作成で同じ規則を使う。
 * - 利用者が設定を書いていれば、その内容（'none' は予約語なので除く）
 * - 書いていなければ既定の定義に、CLI から取れたモデル候補を当てはめたもの
 */
export function paradisResolveAgentTemplates(configurationService: IConfigurationService): readonly IParadisAgentCommandTemplate[] {
	if (paradisIsAgentListUserDefined(configurationService)) {
		const configured = configurationService.getValue<IParadisAgentCommandTemplate[]>(PARADIS_WORKSPACE_AGENTS_SETTING);
		if (Array.isArray(configured) && configured.length > 0) {
			// 'none' は「実行しない」を表す予約識別子（セグメントの固定項目）のため、
			// 設定で誤って同じ id が指定されても既定端末とエージェント端末の二重起動を避けるため除外する
			return configured.filter(agent => agent && typeof agent.id === 'string' && agent.id !== 'none' && typeof agent.command === 'string');
		}
		return PARADIS_DEFAULT_AGENT_COMMANDS;
	}
	return discoveredCatalogs.length > 0 ? paradisApplyDiscoveredModels(PARADIS_DEFAULT_AGENT_COMMANDS, discoveredCatalogs) : PARADIS_DEFAULT_AGENT_COMMANDS;
}
