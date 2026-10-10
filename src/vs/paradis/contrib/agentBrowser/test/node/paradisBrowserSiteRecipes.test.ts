/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';
import { IParadisSiteRecipe, ParadisSiteRecipesStore, paradisCheckSiteRecipe, paradisFormatSiteRecipesHint, paradisFormatSiteRecipesList, paradisSiteRecipeSteps } from '../../node/paradisBrowserSiteRecipes.js';

const TOKEN = 'pane-token';
const META = { date: new Date(2026, 9, 10, 12), agent: 'claude' as const };

function textOf(result: unknown): string {
	return ((result as { content: { text?: string }[] }).content).map(item => item.text ?? '').join('\n');
}

function errorOf(result: ReturnType<typeof paradisCheckSiteRecipe>): string | undefined {
	return result.ok ? undefined : result.error;
}

interface IRecipeInternals {
	_siteRecipeTool(ingressLease: object, name: string, args: unknown): Promise<unknown>;
	_withSiteHints(ingressLease: object, name: string, args: unknown, result: unknown, kinds: { notes: boolean; recipes: boolean }): Promise<unknown>;
}

suite('Paradis site recipes (E3)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let folder: string;
	setup(async () => {
		folder = await fs.mkdtemp(join(tmpdir(), 'paradis-site-recipes-'));
	});
	teardown(async () => {
		await fs.rm(folder, { recursive: true, force: true });
	});

	test('save_recipe checks the name, the params, the steps and secrets', () => {
		const steps = [{ tool: 'fill_by', args: { role: 'textbox', name: 'Email', value: '{{email}}' } }];
		assert.deepStrictEqual({
			badName: errorOf(paradisCheckSiteRecipe({ name: 'log in!', steps }, META)),
			undeclared: errorOf(paradisCheckSiteRecipe({ name: 'login', steps }, META)),
			badSteps: errorOf(paradisCheckSiteRecipe({ name: 'login', steps: [{ tool: 'close_browser_tab', args: {} }] }, META))?.startsWith('save_recipe: "steps" step 1: "close_browser_tab" cannot be used'),
			badDone: errorOf(paradisCheckSiteRecipe({ name: 'login', steps, params: ['email'], done_when: { nope: 1 } }, META)) !== undefined,
			secret: errorOf(paradisCheckSiteRecipe({ name: 'login', steps: [{ tool: 'navigate_page', args: { url: 'https://example.com/?token=ghp_abcdefghijklmnopqrstuvwxyz' } }] }, META))?.startsWith('save_recipe did not save the recipe: it looks like'),
			fixedPassword: errorOf(paradisCheckSiteRecipe({ name: 'login', steps: [{ tool: 'fill_by', args: { role: 'textbox', name: 'Password', value: 'hunter2' } }] }, META)),
			passwordParam: errorOf(paradisCheckSiteRecipe({ name: 'login', params: [{ name: 'password', description: 'the account password' }], steps: [{ tool: 'fill_by', args: { role: 'textbox', name: 'Password', value: '{{password}}' } }] }, META)),
			ok: paradisCheckSiteRecipe({ name: 'login', description: 'Log in and land on the dashboard', params: ['email'], steps, done_when: { text: 'Dashboard' } }, META),
		}, {
			badName: 'save_recipe needs a "name" of letters, digits, "-" or "_" (at most 40 characters), for example "export-orders-csv".',
			undeclared: 'save_recipe: the steps use {{email}} but "params" does not list it.',
			badSteps: true,
			badDone: true,
			secret: true,
			fixedPassword: 'save_recipe did not save the recipe: a step fills "Password" with a fixed value. Make it a parameter such as {{password}} and pass it to run_recipe.',
			passwordParam: undefined,
			ok: { ok: true, recipe: { name: 'login', description: 'Log in and land on the dashboard', params: [{ name: 'email' }], steps, doneWhen: { text: 'Dashboard' }, date: '2026-10-10', agent: 'claude' } },
		});
	});

	test('run_recipe fills params as plain text, as quoted values inside scripts, and keeps $ literal', () => {
		const recipe: IParadisSiteRecipe = {
			name: 'search', params: [{ name: 'q' }], date: '2026-10-10', doneWhen: { text: 'Results for {{q}}' },
			steps: [
				{ tool: 'fill_by', args: { role: 'searchbox', value: '{{q}}' } },
				{ tool: 'evaluate_script', args: { function: '() => document.title.includes({{q}})' } },
				{ expect: { predicate: '() => location.search.includes({{q}})' } },
				{ repeat_until: { text: '{{q}}' }, steps: [{ tool: 'click_by', args: { text: 'More {{q}}' } }], max: 2 },
			],
		};
		assert.deepStrictEqual({
			filled: paradisSiteRecipeSteps(recipe, { q: `a"b $1.text` }),
			missing: paradisSiteRecipeSteps(recipe, {}),
		}, {
			filled: {
				ok: true, steps: [
					{ tool: 'fill_by', args: { role: 'searchbox', value: 'a"b $$1.text' } },
					{ tool: 'evaluate_script', args: { function: '() => document.title.includes("a\\"b $$1.text")' } },
					{ expect: { predicate: '() => location.search.includes("a\\"b $$1.text")' } },
					{ repeat_until: { text: 'a"b $$1.text' }, steps: [{ tool: 'click_by', args: { text: 'More a"b $$1.text' } }], max: 2 },
					{ expect: { text: 'Results for a"b $$1.text' } },
				],
			},
			missing: { ok: false, error: 'run_recipe: the recipe "search" needs "q" in "params".' },
		});
	});

	test('the store replaces a recipe saved under the same name, and the hint lists names and params', async () => {
		const store = new ParadisSiteRecipesStore(join(folder, 'recipes.json'));
		const recipe = (name: string, description: string): IParadisSiteRecipe => ({ name, description, params: [{ name: 'month' }], steps: [{ tool: 'click_by', args: { text: 'Export' } }], date: '2026-10-10' });
		const first = await store.save('/repo', 'https://shop.example', recipe('export', 'old'));
		const second = await store.save('/repo', 'https://shop.example', recipe('export', 'new'));
		const listed = await new ParadisSiteRecipesStore(join(folder, 'recipes.json')).list('/repo', 'https://shop.example');
		assert.deepStrictEqual({
			first,
			second,
			descriptions: listed.map(item => item.description),
			hint: paradisFormatSiteRecipesHint('https://shop.example', listed),
			list: paradisFormatSiteRecipesList('https://shop.example', [{ ...listed[0], description: 'Open the export page.', agent: 'codex', doneWhen: { text: 'Export' } }]),
			otherRepo: await store.list('/other', 'https://shop.example'),
		}, {
			first: false,
			second: true,
			descriptions: ['new'],
			hint: '[Saved recipes for https://shop.example] export (params: month). Run one with run_recipe instead of repeating its steps; list_recipes shows what each does.',
			list: 'Recipes for https://shop.example in this repository:\n- export (2026-10-10, codex): Open the export page. Params: month. 1 step(s), done when {"text":"Export"}.',
			otherRepo: [],
		});
	});

	test('run_recipe runs the steps on the chosen tab, and on a failure shows the page and how to fix the recipe', async () => {
		const calls: string[] = [];
		let failClick = false;
		const tabs = new Map([['tab-1', 'https://shop.example/home'], ['tab-2', 'https://docs.example/']]);
		const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
			_siteRecipes: new ParadisSiteRecipesStore(join(folder, 'recipes.json')),
			_siteNotesShown: new Map<string, Set<string>>(),
			_siteNoteSpaces: new Map(),
			_paneSessions: new Map([[TOKEN, { agent: 'codex' }]]),
			_requireIngressLease: () => { },
			_classifyCaller: async () => 'pane',
			_siteNoteSpace: async () => ({ key: '/repo' }),
			_defaultTabId: () => 'tab-1',
			_callOwningWindow: async () => ({ ok: true, value: { ok: true, openedCount: 0, tabs: [...tabs.entries()].map(([tabId, url]) => ({ tabId, url, title: '', openedByAgent: true })) } }),
			_scopeBinding: (token: string, tabId: string) => tabs.has(tabId) ? {} : undefined,
			_callTool: async (_lease: object, params: { name: string; arguments: Record<string, unknown> }) => {
				calls.push(`${params.name} ${JSON.stringify(params.arguments)}`);
				if (params.name === 'take_snapshot') {
					return { content: [{ type: 'text', text: '## Latest page snapshot\nuid=1_0 RootWebArea "Shop"' }] };
				}
				return failClick && params.name === 'click_by' ? { content: [{ type: 'text', text: 'click_by: no element matches text "Export".' }], isError: true } : { content: [{ type: 'text', text: 'ok' }] };
			},
		}) as unknown as IRecipeInternals;
		const lease = { token: TOKEN };
		const saved = textOf(await service._siteRecipeTool(lease, 'save_recipe', {
			name: 'export', description: 'Open the export page', params: ['month'],
			steps: [{ tool: 'click_by', args: { text: 'Export' } }, { tool: 'fill_by', args: { name: 'Month', value: '{{month}}' } }],
			done_when: { text: 'Export ready' },
		}));
		const otherSite = textOf(await service._siteRecipeTool(lease, 'save_recipe', { name: 'x', steps: [{ sleep_ms: 1 }], url: 'https://bank.example/' }));
		const missingParam = textOf(await service._siteRecipeTool(lease, 'run_recipe', { name: 'export' }));
		const ran = textOf(await service._siteRecipeTool(lease, 'run_recipe', { name: 'export', params: { month: '2026-09' }, tab_id: 'tab-1' }));
		const ranCalls = calls.splice(0);
		failClick = true;
		const stopped = textOf(await service._siteRecipeTool(lease, 'run_recipe', { name: 'export', params: { month: '2026-09' } }));
		const stoppedCalls = calls.splice(0);
		const ownPaneHint = textOf(await service._withSiteHints(lease, 'get_text', {}, { content: [{ type: 'text', text: 'page' }] }, { notes: false, recipes: true }));
		const nextPaneHint = textOf(await service._withSiteHints({ token: 'next-pane' }, 'get_text', {}, { content: [{ type: 'text', text: 'page' }] }, { notes: false, recipes: true }));
		assert.deepStrictEqual({
			saved,
			otherSite,
			missingParam,
			ranCalls,
			ranEnd: ran.endsWith('Recipe "export" finished and its done_when holds.'),
			stoppedCalls,
			stoppedEnd: stopped.endsWith('Recipe "export" stopped at the failed step above. The page now:\n## Latest page snapshot\nuid=1_0 RootWebArea "Shop"\nFix the steps (the site may have changed) and call save_recipe with the same name "export".'),
			ownPaneHint,
			nextPaneHint,
		}, {
			saved: 'Saved the recipe "export" for https://shop.example. Run it with run_recipe and params month; later agents in this repository see its name when they open the site.',
			otherSite: 'save_recipe only changes recipes of a site open in this pane\'s tabs, and https://bank.example is not. Open the site first.',
			missingParam: 'run_recipe: the recipe "export" needs "month" in "params".',
			ranCalls: [
				'click_by {"text":"Export","tab_id":"tab-1"}',
				'fill_by {"name":"Month","value":"2026-09","tab_id":"tab-1"}',
				'wait_until {"timeout_seconds":5,"text":"Export ready","state":"visible","tab_id":"tab-1"}',
			],
			ranEnd: true,
			stoppedCalls: ['click_by {"text":"Export","tab_id":"tab-1"}', 'take_snapshot {"tab_id":"tab-1"}'],
			stoppedEnd: true,
			ownPaneHint: 'page',
			nextPaneHint: 'page\n[Saved recipes for https://shop.example] export (params: month). Run one with run_recipe instead of repeating its steps; list_recipes shows what each does.',
		});
	});
});
