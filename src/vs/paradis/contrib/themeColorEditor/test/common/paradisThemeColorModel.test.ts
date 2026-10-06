/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisColorLayers,
	paradisApplyColorEdits,
	paradisBuildCssVariableReverseMap,
	paradisBuildMemoryValue,
	paradisBuildScopedPreview,
	paradisCollectColorCandidates,
	paradisColorPreviewValue,
	paradisCssValueColorIds,
	paradisExactScopeShadowed,
	paradisMergeScopedEdits,
	paradisPlanRevertToParaDefault,
	paradisFilterColorEntries,
	paradisGroupColorEntries,
	paradisJsonEquals,
	paradisMatchSyntaxTarget,
	paradisPlanRevertToTheme,
	paradisReadSemanticStyle,
	paradisReadTextMateRules,
	paradisReplaceExactScope,
	paradisResolveColorOrigin,
	paradisStripPseudoElements,
	paradisThemeScopeMatches,
	paradisThemeSpecificValues,
	paradisToggleFontStyle,
	paradisTokenStyleToGroupValue,
	paradisTokenStyleToSemanticValue,
} from '../../common/paradisThemeColorModel.js';

/** Para Code の既定（paradisDefaultSettings.contribution.ts と同じ形）。 */
const PARA_DEFAULT = {
	'[Houston]': { 'statusBar.background': '#09AFD9', 'tab.activeBorderTop': '#09AFD9' },
	'[Light 2026]': { 'statusBar.background': '#0598BD' },
};

suite('paradisThemeColorModel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('theme scope keys match the same way as the theme service (multi-scope and wildcards)', () => {
		const keys = ['[Houston]', '[Abyss][Houston]', '[Hou*]', '[*ton]', '[*ust*]', '[Abyss]', 'Houston', '[houston]'];
		assert.deepStrictEqual(keys.map(key => paradisThemeScopeMatches('Houston', key)), [true, true, true, true, true, false, false, false]);
	});

	test('theme specific values merge matching scopes in key order and concatenate arrays', () => {
		assert.deepStrictEqual(paradisThemeSpecificValues({
			'editor.background': '#000000',
			'[Houston]': { a: '#111111', rules: [1] },
			'[Abyss]': { a: '#999999' },
			'[Hou*]': { a: '#222222', rules: [2] },
		}, 'Houston'), { a: '#222222', rules: [1, 2] });
	});

	test('origin: theme-scoped values beat unscoped ones, then higher layers win', () => {
		const layers = (user: unknown, workspace?: unknown): IParadisColorLayers => ({ paraDefault: PARA_DEFAULT, user, workspace });
		assert.deepStrictEqual([
			paradisResolveColorOrigin(layers(undefined), 'Houston', 'statusBar.background'),
			// スコープなしのユーザーの値は、default 層の "[Houston]" に負ける
			paradisResolveColorOrigin(layers({ 'statusBar.background': '#FF0000' }), 'Houston', 'statusBar.background'),
			paradisResolveColorOrigin(layers({ '[Houston]': { 'statusBar.background': '#FF0000' } }), 'Houston', 'statusBar.background'),
			paradisResolveColorOrigin(layers({ '[Houston]': { 'statusBar.background': '#FF0000' } }, { '[Houston]': { 'statusBar.background': '#00FF00' } }), 'Houston', 'statusBar.background'),
			paradisResolveColorOrigin(layers({ 'editor.background': '#123456' }), 'Houston', 'editor.background'),
			paradisResolveColorOrigin(layers(undefined), 'Houston', 'editor.background'),
			paradisResolveColorOrigin(layers({ '[Houston]': { 'editor.background': 'default' } }), 'Houston', 'editor.background'),
		], [
			{ source: 'paraDefault', value: '#09AFD9', scoped: true },
			{ source: 'paraDefault', value: '#09AFD9', scoped: true },
			{ source: 'user', value: '#FF0000', scoped: true },
			{ source: 'workspace', value: '#00FF00', scoped: true },
			{ source: 'user', value: '#123456', scoped: false },
			{ source: 'theme', value: undefined, scoped: false },
			{ source: 'user', value: 'default', scoped: true },
		]);
	});

	test('saving edits only touches the current theme scope and keeps every other key', () => {
		const user = {
			'editor.background': '#101010',
			'[Abyss]': { 'statusBar.background': '#AAAAAA' },
			'[Houston]': { 'statusBar.background': '#FF0000', 'tab.activeBorderTop': '#00FF00' },
		};
		const result = paradisApplyColorEdits(user, 'Houston', new Map([['statusBar.background', '#7A3FD0'], ['tab.activeBorderTop', undefined], ['badge.background', 'default']]));
		assert.deepStrictEqual({ result, untouched: user['[Houston]'] }, {
			result: {
				'editor.background': '#101010',
				'[Abyss]': { 'statusBar.background': '#AAAAAA' },
				'[Houston]': { 'statusBar.background': '#7A3FD0', 'badge.background': 'default' },
			},
			untouched: { 'statusBar.background': '#FF0000', 'tab.activeBorderTop': '#00FF00' },
		});
	});

	test('saving removes an emptied scope and returns undefined when nothing is left', () => {
		assert.deepStrictEqual([
			paradisApplyColorEdits({ '[Houston]': { a: '#111111' } }, 'Houston', new Map([['a', undefined]])),
			paradisApplyColorEdits({ '[Houston]': { a: '#111111' }, b: '#222222' }, 'Houston', new Map([['a', undefined]])),
			paradisApplyColorEdits(undefined, 'Light 2026', new Map([['a', '#333333']])),
		], [
			undefined,
			{ b: '#222222' },
			{ '[Light 2026]': { a: '#333333' } },
		]);
	});

	test('preview values match what will be in effect after saving', () => {
		const layers: IParadisColorLayers = { paraDefault: PARA_DEFAULT, user: { '[Houston]': { 'statusBar.background': '#FF0000' } }, workspace: undefined };
		assert.deepStrictEqual([
			paradisColorPreviewValue(layers, 'Houston', 'statusBar.background', '#7A3FD0'),
			// ユーザーの値を消す → 同じパスの Para Code の既定を見せる
			paradisColorPreviewValue(layers, 'Houston', 'statusBar.background', undefined),
			// Para Code の既定が無い色を消す → null で同じパスの値を隠す
			paradisColorPreviewValue(layers, 'Houston', 'editor.background', undefined),
			// ワークスペースのスコープ内の値は保存後も勝つので、それを見せる
			paradisColorPreviewValue({ ...layers, workspace: { '[Houston]': { 'statusBar.background': '#00FF00' } } }, 'Houston', 'statusBar.background', '#7A3FD0'),
		], ['#7A3FD0', '#09AFD9', null, '#00FF00']);
	});

	test('memory value keeps the original memory value and adds per-theme previews', () => {
		assert.deepStrictEqual([
			paradisBuildMemoryValue({ x: '#000000', '[Houston]': { y: '#111111' } }, new Map([['Houston', { a: '#222222', b: null }], ['Abyss', { c: '#333333' }]])),
			paradisBuildMemoryValue(undefined, new Map()),
		], [
			{ x: '#000000', '[Houston]': { y: '#111111', a: '#222222', b: null }, '[Abyss]': { c: '#333333' } },
			undefined,
		]);
	});

	test('revert to theme removes the user value when that is enough, otherwise writes the theme color or "default"', () => {
		const withoutUser: IParadisColorLayers = { paraDefault: PARA_DEFAULT, user: undefined, workspace: undefined };
		assert.deepStrictEqual([
			paradisPlanRevertToTheme(withoutUser, 'Houston', 'editor.background', '#17191E'),
			paradisPlanRevertToTheme(withoutUser, 'Houston', 'statusBar.background', '#343841'),
			paradisPlanRevertToTheme(withoutUser, 'Houston', 'tab.activeBorderTop', undefined),
		], [undefined, '#343841', 'default']);
	});

	test('filter and group the color list', () => {
		const entries = [
			{ id: 'statusBar.background', description: 'Status bar background color.' },
			{ id: 'statusBar.foreground', description: 'Status bar foreground color.' },
			{ id: 'tab.activeBackground', description: 'Active tab background.' },
			{ id: 'focusBorder', description: 'Overall border color for focused elements.' },
		];
		const label = (group: string) => group === 'statusBar' ? 'ステータスバー' : group;
		assert.deepStrictEqual({
			byLabel: paradisFilterColorEntries(entries, 'ステータスバー background', label).map(entry => entry.id),
			byTerms: paradisFilterColorEntries(entries, 'TAB、back', label).map(entry => entry.id),
			empty: paradisFilterColorEntries(entries, '  ', label).length,
			groups: paradisGroupColorEntries(entries, label).map(group => [group.label, group.entries.map(entry => entry.id)]),
		}, {
			byLabel: ['statusBar.background'],
			byTerms: ['tab.activeBackground'],
			empty: 4,
			groups: [['focusBorder', ['focusBorder']], ['tab', ['tab.activeBackground']], ['ステータスバー', ['statusBar.background', 'statusBar.foreground']]],
		});
	});

	test('CSS variables map back to color ids, including nested fallbacks and ambiguous names', () => {
		const reverse = paradisBuildCssVariableReverseMap(['statusBar.background', 'editor.background', 'a.b-c', 'a-b.c']);
		assert.deepStrictEqual([
			paradisCssValueColorIds('var(--vscode-statusBar-background, var(--vscode-editor-background))', reverse),
			paradisCssValueColorIds('1px solid var( --vscode-a-b-c )', reverse),
			paradisCssValueColorIds('var(--vscode-font-family)', reverse),
		], [['statusBar.background', 'editor.background'], ['a.b-c', 'a-b.c'], []]);
	});

	test('candidates come from the element first, ordered by role, without duplicates', () => {
		const reverse = paradisBuildCssVariableReverseMap(['statusBar.background', 'statusBar.foreground', 'statusBar.border', 'focusBorder']);
		const levels = [
			[{ property: 'color', value: 'var(--vscode-statusBar-foreground)' }, { property: 'background-color', value: 'var(--vscode-statusBar-background)' }],
			[{ property: 'border-top', value: '1px solid var(--vscode-statusBar-border)' }, { property: 'background', value: 'var(--vscode-statusBar-background)' }],
			[{ property: 'outline-color', value: 'var(--vscode-focusBorder)' }],
		];
		assert.deepStrictEqual(paradisCollectColorCandidates(levels, reverse, 3), [
			{ id: 'statusBar.background', role: 'background', depth: 0 },
			{ id: 'statusBar.foreground', role: 'foreground', depth: 0 },
			{ id: 'statusBar.border', role: 'border', depth: 1 },
		]);
	});

	test('pseudo elements are stripped so the owner element matches', () => {
		assert.deepStrictEqual([
			paradisStripPseudoElements('.a .b::before, .c:hover::after'),
			paradisStripPseudoElements('.x::-webkit-scrollbar-thumb:hover'),
			paradisStripPseudoElements('input::placeholder'),
		], ['.a .b, .c:hover', '.x:hover', 'input']);
	});

	test('font styles and token style values', () => {
		assert.deepStrictEqual({
			on: paradisToggleFontStyle('bold', 'italic', true),
			off: paradisToggleFontStyle('italic bold', 'italic', false),
			none: paradisToggleFontStyle('bold', 'bold', false),
			groupColor: paradisTokenStyleToGroupValue({ foreground: '#FF0000' }),
			groupStyle: paradisTokenStyleToGroupValue({ foreground: '#FF0000', fontStyle: 'italic' }),
			groupEmpty: paradisTokenStyleToGroupValue({}),
			semantic: paradisTokenStyleToSemanticValue({ foreground: '#00FF00', fontStyle: 'bold' }),
			semanticRead: paradisReadSemanticStyle({ foreground: '#00FF00', bold: true, italic: false }),
			rules: paradisReadTextMateRules([{ scope: ['a', 'b'], settings: { foreground: '#111111' } }, { scope: 'c', settings: '#222222' }, { settings: {} }, 'x']),
		}, {
			on: 'italic bold',
			off: 'bold',
			none: '',
			groupColor: '#FF0000',
			groupStyle: { foreground: '#FF0000', fontStyle: 'italic' },
			groupEmpty: undefined,
			semantic: { foreground: '#00FF00', italic: false, bold: true, underline: false, strikethrough: false },
			semanticRead: { foreground: '#00FF00', fontStyle: 'bold' },
			rules: [{ scope: 'a, b', settings: { foreground: '#111111' } }, { scope: 'c', settings: { foreground: '#222222' } }],
		});
	});

	test('syntax scope replacement keeps other scopes and builds a preview that hides removed keys', () => {
		const user = { comments: '#000000', '[Houston]': { keywords: '#111111', strings: '#222222', textMateRules: [{ scope: 'a', settings: {} }] }, '[Abyss]': { keywords: '#333333' } };
		const draft = { keywords: '#444444', textMateRules: [] };
		assert.deepStrictEqual({
			saved: paradisReplaceExactScope(user, 'Houston', draft),
			cleared: paradisReplaceExactScope({ '[Houston]': { keywords: '#111111' } }, 'Houston', { keywords: undefined }),
			preview: paradisBuildScopedPreview(user['[Houston]'], draft),
			semanticPreview: paradisBuildScopedPreview({ rules: { variable: '#111111', 'function': '#222222' } }, { rules: { variable: '#333333' } }, ['rules']),
		}, {
			saved: { comments: '#000000', '[Houston]': { keywords: '#444444', textMateRules: [] }, '[Abyss]': { keywords: '#333333' } },
			cleared: undefined,
			preview: { keywords: '#444444', strings: null, textMateRules: [] },
			semanticPreview: { rules: { variable: '#333333', 'function': null } },
		});
	});

	test('json equality ignores key order and undefined values', () => {
		assert.deepStrictEqual([
			paradisJsonEquals({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }),
			paradisJsonEquals({ a: 1, b: undefined }, { a: 1 }),
			paradisJsonEquals({ a: [1, 2] }, { a: [2, 1] }),
		], [true, true, false]);
	});

	test('clicking a token picks the user rule, then the group, then proposes a new rule', () => {
		const scopes = ['source.ts', 'meta.function.ts', 'storage.type.function.ts'];
		const rules = [{ scope: 'storage', settings: {} }, { scope: 'meta.function storage.type', settings: {} }, { scope: 'string', settings: {} }];
		assert.deepStrictEqual([
			paradisMatchSyntaxTarget(scopes, rules),
			paradisMatchSyntaxTarget(scopes, []),
			paradisMatchSyntaxTarget(['source.ts', 'keyword.operator.arithmetic.ts'], []),
			paradisMatchSyntaxTarget(['source.ts', 'punctuation.terminator.statement.ts'], []),
			paradisMatchSyntaxTarget(['source.ts'], []),
		], [
			{ kind: 'rule', index: 1 },
			{ kind: 'group', group: 'keywords' },
			{ kind: 'newRule', scope: 'keyword.operator.arithmetic.ts' },
			{ kind: 'newRule', scope: 'punctuation.terminator.statement.ts' },
			undefined,
		]);
	});

	test('merging scoped edits applies only what the draft changed onto the current value', () => {
		const original = { comments: '#000000', keywords: '#111111', textMateRules: [{ scope: 'a', settings: {} }] };
		assert.deepStrictEqual({
			plain: paradisMergeScopedEdits({ comments: '#999999', strings: '#222222', keywords: '#111111', textMateRules: [{ scope: 'a', settings: {} }] }, original, { comments: '#000000', textMateRules: [{ scope: 'a', settings: {} }] }),
			rulesConflict: paradisMergeScopedEdits({ ...original, textMateRules: [{ scope: 'c', settings: {} }] }, original, { ...original, textMateRules: [] }),
			semantic: paradisMergeScopedEdits({ rules: { variable: '#AAAAAA', parameter: '#BBBBBB' } }, { rules: { variable: '#AAAAAA', 'function': '#CCCCCC' } }, { rules: { variable: '#DDDDDD' } }, ['rules']),
		}, {
			plain: { merged: { comments: '#999999', strings: '#222222', textMateRules: [{ scope: 'a', settings: {} }] }, conflicts: [] },
			rulesConflict: { merged: { comments: '#000000', keywords: '#111111', textMateRules: [] }, conflicts: ['textMateRules'] },
			semantic: { merged: { rules: { variable: '#DDDDDD', parameter: '#BBBBBB' } }, conflicts: [] },
		});
	});

	test('scoped preview shows the workspace value for keys the workspace sets', () => {
		assert.deepStrictEqual(paradisBuildScopedPreview(
			{ keywords: '#111111', textMateRules: [{ scope: 'a', settings: {} }] },
			{ keywords: '#222222', textMateRules: [], comments: '#333333' },
			[],
			{ textMateRules: [{ scope: 'w', settings: {} }], strings: '#444444' },
		), { keywords: '#222222', textMateRules: [{ scope: 'w', settings: {} }], comments: '#333333' });
	});

	test('revert to Para Code default writes the default explicitly when removing is not enough', () => {
		const layers = (user: unknown): IParadisColorLayers => ({ paraDefault: PARA_DEFAULT, user, workspace: undefined });
		assert.deepStrictEqual([
			paradisPlanRevertToParaDefault(layers(undefined), 'Houston', 'statusBar.background'),
			paradisPlanRevertToParaDefault(layers({ '[A][Houston]': { 'statusBar.background': '#FF0000' } }), 'Houston', 'statusBar.background'),
			paradisPlanRevertToParaDefault(layers({ 'statusBar.background': '#FF0000' }), 'Light 2026', 'statusBar.background'),
		], [undefined, '#09AFD9', undefined]);
	});

	test('the exact theme scope can be shadowed by a later matching key', () => {
		const user = { '[Houston]': { a: '#111111' }, '[A][Houston]': { a: '#222222', b: '#333333' }, '[Hou*]': {} };
		assert.deepStrictEqual([
			paradisExactScopeShadowed(user, 'Houston', 'a'),
			paradisExactScopeShadowed(user, 'Houston', 'c'),
			paradisExactScopeShadowed({ '[A][Houston]': { a: '#222222' }, '[Houston]': { a: '#111111' } }, 'Houston', 'a'),
			paradisExactScopeShadowed({ '[A][Houston]': { a: '#222222' } }, 'Houston', 'a'),
		], [true, false, false, false]);
	});
});
