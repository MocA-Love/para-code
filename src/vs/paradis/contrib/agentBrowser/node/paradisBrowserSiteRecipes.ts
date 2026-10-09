/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// サイトの手順（para-browser-improvement.html の E3、設定 `paradis.agentBrowser.siteRecipes`。既定は無効）。
// エージェントが、あるサイトで決まった画面へ行くまでの操作（ログイン、CSV の書き出し画面を開く…）を run_steps の
// 手順書（paradisBrowserRunStepsFlow.ts）と同じ形で保存し、次から run_recipe の 1 回の呼び出しでやり直す。
//
// 決め事（q.html Q303・Q304）:
// - 保存はサイトメモ（E4）と同じく、スペース（リポジトリ）とオリジンの組ごと。名前が同じなら置き換える（直して保存し直す）
// - 変わる値は `{{name}}` のパラメータにして、run_recipe で渡す。秘密の値は手順に書かせない（伏せ字の判定と、
//   パスワード欄へ決まった値を入れる手順を断る）
// - 「その画面に着いた」の確かめ（done_when）を最後に足す。途中で止まったら、止まった手順と、その時のページの
//   スナップショットの頭を返し、エージェントが直して保存し直す
// - 手順は uid ではなく role・name・text で書かせる（uid はページを読み直すと変わる）

import { homedir } from 'os';
import { join } from '../../../../base/common/path.js';
import { paradisParseRunStepsFlow, paradisRunStepsScriptArguments } from './paradisBrowserRunStepsFlow.js';
import { paradisSiteNoteLooksSecret } from './paradisBrowserSiteNotes.js';
import { ParadisBrowserSiteStore, paradisLocalDate } from './paradisBrowserSiteStore.js';

const MAX_RECIPES_PER_KEY = 30;
/** 1 つの手順の大きさ（JSON の文字数）。 */
const MAX_RECIPE_CHARS = 40_000;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_PARAMS = 20;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const PLACEHOLDER = /\{\{\s*(?<name>[A-Za-z0-9][A-Za-z0-9_-]{0,39})\s*\}\}/g;
/** パスワードらしい欄の名前（ここへ決まった値を入れる手順は断る）。 */
const PASSWORD_FIELD = /pass(?:word|code|phrase)?\b|\bpin\b|secret|otp|パスワード|暗証番号/i;

export interface IParadisSiteRecipeParam {
	readonly name: string;
	readonly description?: string;
}

export interface IParadisSiteRecipe {
	readonly name: string;
	readonly description?: string;
	readonly params: readonly IParadisSiteRecipeParam[];
	/** run_steps の手順書と同じ形の手順（`{{name}}` のパラメータを含む）。 */
	readonly steps: readonly unknown[];
	/** 着いたことの確かめ（run_steps の expect と同じ形の条件）。 */
	readonly doneWhen?: Readonly<Record<string, unknown>>;
	/** 保存した日（YYYY-MM-DD、利用者の暦）。 */
	readonly date: string;
	readonly agent?: 'claude' | 'codex';
	readonly commit?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 既定の置き場（利用者のフォルダの .para-code の下）。 */
export function paradisSiteRecipesDefaultPath(): string {
	return join(homedir(), '.para-code', 'browser-recipes', 'recipes.json');
}

/** 手順の置き場（paradisBrowserSiteStore.ts。ファイルの欄は `recipes`）。 */
export class ParadisSiteRecipesStore {
	private readonly store: ParadisBrowserSiteStore<IParadisSiteRecipe>;

	constructor(filePath: string) {
		this.store = new ParadisBrowserSiteStore(filePath, 'recipes');
	}

	list(space: string, origin: string): Promise<readonly IParadisSiteRecipe[]> {
		return this.store.list(space, origin);
	}

	/** 同じ名前があれば置き換える。置き換えたら true。 */
	save(space: string, origin: string, recipe: IParadisSiteRecipe): Promise<boolean> {
		return this.store.update(space, origin, recipes => {
			const replaced = recipes.some(item => item.name === recipe.name);
			return { value: replaced, items: [...recipes.filter(item => item.name !== recipe.name), recipe].slice(-MAX_RECIPES_PER_KEY) };
		});
	}

	/** 消せたら true。 */
	delete(space: string, origin: string, name: string): Promise<boolean> {
		return this.store.update(space, origin, recipes => {
			const kept = recipes.filter(item => item.name !== name);
			return kept.length === recipes.length ? { value: false } : { value: true, items: kept };
		});
	}
}

/** 手順（入れ子の for_each / repeat_until を含む）の 1 つ 1 つを、道具の手順か条件かに分けて渡す。 */
function visitSteps(steps: readonly unknown[], visit: (step: Record<string, unknown>) => void): void {
	for (const step of steps) {
		if (!isRecord(step)) {
			continue;
		}
		visit(step);
		if (Array.isArray(step.steps)) {
			visitSteps(step.steps, visit);
		}
	}
}

/** 文字の値を全部たどる。 */
function visitStrings(value: unknown, visit: (text: string) => void): void {
	if (typeof value === 'string') {
		visit(value);
	} else if (Array.isArray(value)) {
		value.forEach(item => visitStrings(item, visit));
	} else if (isRecord(value)) {
		Object.values(value).forEach(item => visitStrings(item, visit));
	}
}

/** save_recipe の引数を確かめて、保存する形にする。 */
export function paradisCheckSiteRecipe(args: Record<string, unknown>, meta: { readonly date: Date; readonly agent?: 'claude' | 'codex'; readonly commit?: string }): { readonly ok: true; readonly recipe: IParadisSiteRecipe } | { readonly ok: false; readonly error: string } {
	const name = typeof args.name === 'string' ? args.name.trim() : '';
	if (!NAME_PATTERN.test(name)) {
		return { ok: false, error: 'save_recipe needs a "name" of letters, digits, "-" or "_" (at most 40 characters), for example "export-orders-csv".' };
	}
	if (!Array.isArray(args.steps) || args.steps.length === 0) {
		return { ok: false, error: 'save_recipe needs "steps": the same list as run_steps takes.' };
	}
	const rawParams = Array.isArray(args.params) ? args.params : [];
	const params: IParadisSiteRecipeParam[] = [];
	for (const raw of rawParams) {
		const param = typeof raw === 'string' ? { name: raw } : isRecord(raw) && typeof raw.name === 'string' ? { name: raw.name, ...(typeof raw.description === 'string' && raw.description.trim() ? { description: raw.description.trim().slice(0, MAX_DESCRIPTION_CHARS) } : {}) } : undefined;
		if (param === undefined || !NAME_PATTERN.test(param.name) || params.some(item => item.name === param.name)) {
			return { ok: false, error: `save_recipe: each of "params" must be a distinct name of letters, digits, "-" or "_" (or {"name", "description"}); got ${JSON.stringify(raw)}.` };
		}
		params.push(param);
	}
	if (params.length > MAX_PARAMS) {
		return { ok: false, error: `save_recipe takes at most ${MAX_PARAMS} params.` };
	}
	const doneWhen = isRecord(args.done_when) ? args.done_when : undefined;
	const steps = [...args.steps, ...(doneWhen !== undefined ? [{ expect: doneWhen }] : [])];
	const parsed = paradisParseRunStepsFlow({ steps });
	if (!parsed.ok) {
		return { ok: false, error: `save_recipe: ${parsed.error}` };
	}
	const used = new Set<string>();
	visitStrings(steps, text => {
		for (const match of text.matchAll(PLACEHOLDER)) {
			used.add(match.groups!.name);
		}
	});
	const undeclared = [...used].filter(param => !params.some(item => item.name === param));
	if (undeclared.length > 0) {
		return { ok: false, error: `save_recipe: the steps use {{${undeclared.join('}}, {{')}}} but "params" does not list ${undeclared.length === 1 ? 'it' : 'them'}.` };
	}
	const serialized = JSON.stringify({ steps, params, description: args.description });
	if (serialized.length > MAX_RECIPE_CHARS) {
		return { ok: false, error: `save_recipe: the recipe is too long (${serialized.length} characters, at most ${MAX_RECIPE_CHARS}).` };
	}
	if (paradisSiteNoteLooksSecret(serialized)) {
		return { ok: false, error: 'save_recipe did not save the recipe: it looks like it contains a password, token or key. Make the value a parameter such as {{password}} and pass it to run_recipe.' };
	}
	let fixedSecret: string | undefined;
	visitSteps(steps, step => {
		const stepArgs = isRecord(step.args) ? step.args : undefined;
		if (fixedSecret !== undefined || stepArgs === undefined || (step.tool !== 'fill_by' && step.tool !== 'type_text')) {
			return;
		}
		const where = ['name', 'selector', 'text', 'label'].map(key => stepArgs[key]).filter((value): value is string => typeof value === 'string').join(' ');
		const value = typeof stepArgs.value === 'string' ? stepArgs.value : typeof stepArgs.text === 'string' && step.tool === 'type_text' ? stepArgs.text : undefined;
		if (value !== undefined && PASSWORD_FIELD.test(where) && !/^\{\{[^}]+\}\}$/.test(value.trim())) {
			fixedSecret = where;
		}
	});
	if (fixedSecret !== undefined) {
		return { ok: false, error: `save_recipe did not save the recipe: a step fills "${fixedSecret.slice(0, 60)}" with a fixed value. Make it a parameter such as {{password}} and pass it to run_recipe.` };
	}
	const description = typeof args.description === 'string' && args.description.trim() ? args.description.trim().slice(0, MAX_DESCRIPTION_CHARS) : undefined;
	return {
		ok: true,
		recipe: {
			name,
			...(description !== undefined ? { description } : {}),
			params,
			steps: args.steps,
			...(doneWhen !== undefined ? { doneWhen } : {}),
			date: paradisLocalDate(meta.date),
			...(meta.agent ? { agent: meta.agent } : {}),
			...(meta.commit ? { commit: meta.commit } : {}),
		},
	};
}

/** パラメータの値を差し込む。スクリプトの引数（evaluate_script の function、predicate など）には引用符付きの文字の値として入れる。 */
function fill(text: string, values: Readonly<Record<string, string>>, script: boolean): string {
	// 値の中の `$` は run_steps の参照（`$2.text`）と読まれないように `$$` にする
	return text.replace(PLACEHOLDER, (_match, name: string) => {
		const value = values[name] ?? '';
		return (script ? JSON.stringify(value) : value).replaceAll('$', '$$$$');
	});
}

function fillDeep(value: unknown, values: Readonly<Record<string, string>>): unknown {
	if (typeof value === 'string') {
		return fill(value, values, false);
	}
	if (Array.isArray(value)) {
		return value.map(item => fillDeep(item, values));
	}
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillDeep(item, values)]));
	}
	return value;
}

/** 条件（expect / repeat_until / done_when）。predicate だけがスクリプト。 */
function fillCondition(condition: unknown, values: Readonly<Record<string, string>>): unknown {
	if (!isRecord(condition)) {
		return condition;
	}
	return Object.fromEntries(Object.entries(condition).map(([key, item]) => [key, key === 'predicate' && typeof item === 'string' ? fill(item, values, true) : fillDeep(item, values)]));
}

function fillSteps(steps: readonly unknown[], values: Readonly<Record<string, string>>): unknown[] {
	return steps.map(step => {
		if (!isRecord(step)) {
			return step;
		}
		const scripts = typeof step.tool === 'string' ? paradisRunStepsScriptArguments(step.tool) : [];
		return Object.fromEntries(Object.entries(step).map(([key, item]) => {
			if (key === 'args' && isRecord(item)) {
				return [key, Object.fromEntries(Object.entries(item).map(([argKey, argValue]) => [argKey, scripts.includes(argKey) && typeof argValue === 'string' ? fill(argValue, values, true) : fillDeep(argValue, values)]))];
			}
			if (key === 'expect' || key === 'repeat_until') {
				return [key, fillCondition(item, values)];
			}
			if (key === 'steps' && Array.isArray(item)) {
				return [key, fillSteps(item, values)];
			}
			return [key, fillDeep(item, values)];
		}));
	});
}

/** run_recipe の手順（パラメータを差し込み、done_when を最後の expect にしたもの）。足りないパラメータがあれば断る。 */
export function paradisSiteRecipeSteps(recipe: IParadisSiteRecipe, rawValues: unknown): { readonly ok: true; readonly steps: unknown[] } | { readonly ok: false; readonly error: string } {
	const values: Record<string, string> = {};
	if (isRecord(rawValues)) {
		for (const [key, value] of Object.entries(rawValues)) {
			if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
				values[key] = String(value);
			}
		}
	}
	const missing = recipe.params.filter(param => values[param.name] === undefined).map(param => param.name);
	if (missing.length > 0) {
		return { ok: false, error: `run_recipe: the recipe "${recipe.name}" needs ${missing.map(name => `"${name}"`).join(', ')} in "params".` };
	}
	const steps = [...recipe.steps, ...(recipe.doneWhen !== undefined ? [{ expect: recipe.doneWhen }] : [])];
	return { ok: true, steps: fillSteps(steps, values) };
}

/** 道具の結果に添える 1 行（そのサイトに保存した手順の名前とパラメータ）。 */
export function paradisFormatSiteRecipesHint(origin: string, recipes: readonly IParadisSiteRecipe[]): string | undefined {
	if (recipes.length === 0) {
		return undefined;
	}
	const names = recipes.map(recipe => `${recipe.name}${recipe.params.length > 0 ? ` (params: ${recipe.params.map(param => param.name).join(', ')})` : ''}`);
	return `[Saved recipes for ${origin}] ${names.join('; ')}. Run one with run_recipe instead of repeating its steps; list_recipes shows what each does.`;
}

/** list_recipes の一覧。 */
export function paradisFormatSiteRecipesList(origin: string, recipes: readonly IParadisSiteRecipe[]): string {
	if (recipes.length === 0) {
		return `No recipes for ${origin} in this repository.`;
	}
	return [`Recipes for ${origin} in this repository:`, ...recipes.map(recipe => {
		const params = recipe.params.map(param => `${param.name}${param.description ? ` (${param.description})` : ''}`).join(', ');
		return `- ${recipe.name} (${recipe.date}${recipe.agent ? `, ${recipe.agent}` : ''}${recipe.commit ? `, commit ${recipe.commit}` : ''}): ${recipe.description ?? '(no description)'}${params ? `. Params: ${params}` : ''}. ${recipe.steps.length} step(s)${recipe.doneWhen ? `, done when ${JSON.stringify(recipe.doneWhen)}` : ''}.`;
	})].join('\n');
}

export const PARADIS_SITE_RECIPE_TOOL_NAMES: ReadonlySet<string> = new Set(['save_recipe', 'run_recipe', 'list_recipes', 'delete_recipe']);

const URL_PROPERTY = { type: 'string', description: 'A URL of the site (the recipe belongs to its origin). Default: the URL of this pane\'s current tab.' };

/** サイトの手順の道具（設定が有効なときだけ tools/list に出す）。 */
export const PARADIS_SITE_RECIPE_TOOLS = [
	{
		name: 'save_recipe',
		description: 'Save the steps that reach a screen on a website open in this pane (for example logging in, or opening the CSV export page), so later agents in this repository can repeat them with one run_recipe call. Steps take the same form as run_steps (tools, expect, sleep_ms, for_each, repeat_until); write elements by role, name or text, not uid. Put values that change in {{name}} placeholders and list them in params; never write passwords or other secrets into the steps. done_when checks that the screen was reached. Saving under an existing name replaces it (fix a recipe this way when it stops).',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Short name, letters, digits, "-" or "_", for example "export-orders-csv".' },
				description: { type: 'string', description: `What the recipe does and which screen it ends on (at most ${MAX_DESCRIPTION_CHARS} characters).` },
				steps: { type: 'array', items: { type: 'object' }, description: 'The steps, as for run_steps. Strings may contain {{param}}.' },
				params: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name'] }] }, description: 'Names of the {{param}} placeholders, optionally with a description.' },
				done_when: { type: 'object', description: 'Condition that holds on the target screen, as in run_steps expect, for example {"text": "Export orders"}.' },
				url: URL_PROPERTY,
			},
			required: ['name', 'steps'],
			additionalProperties: false,
		},
	},
	{
		name: 'run_recipe',
		description: 'Run a recipe saved for the website (see save_recipe and list_recipes) in this pane\'s current tab, or the tab given as tab_id. If a step fails, the result says which one and shows the start of the page snapshot; fix the steps and save the recipe again under the same name.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'The recipe name.' },
				params: { type: 'object', additionalProperties: { type: 'string' }, description: 'Values for the recipe\'s {{param}} placeholders.' },
				url: URL_PROPERTY,
			},
			required: ['name'],
			additionalProperties: false,
		},
	},
	{
		name: 'list_recipes',
		description: 'List the recipes saved for a website in this repository, with their params, the screen they end on, the date and the agent that saved them.',
		inputSchema: { type: 'object', properties: { url: URL_PROPERTY }, additionalProperties: false },
	},
	{
		name: 'delete_recipe',
		description: 'Delete a recipe of a website open in this pane that is wrong or no longer needed.',
		inputSchema: {
			type: 'object',
			properties: { name: { type: 'string', description: 'The recipe name.' }, url: URL_PROPERTY },
			required: ['name'],
			additionalProperties: false,
		},
	},
] as const;
