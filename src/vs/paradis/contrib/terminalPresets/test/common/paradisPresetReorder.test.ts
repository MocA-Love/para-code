/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisPresetMovePlan,
	isParadisPresetMoveRefusal,
	paradisApplyPresetMovePlan,
	paradisMoveListEntries,
	paradisMovePresetDefinitions,
	paradisPlanPresetMove,
	paradisPlanPresetMoveToFolder,
	paradisPlanPresetNest,
	paradisPlanPresetStep,
	IParadisPresetDropSpot,
	paradisPresetDropSpot,
	ParadisPresetDropTarget,
	paradisPresetMoveFolderChoices,
	paradisPresetPlaceOf,
	paradisPresetReorderBlocked,
	ParadisPresetMoveItem,
	ParadisPresetMoveRefusal,
} from '../../common/paradisPresetReorder.js';
import { IParadisPresetDefinition, IParadisResolvedPreset, paradisGroupPresetsByFolder, paradisPresetKey, paradisPresetScopeKey } from '../../common/paradisTerminalPresets.js';

const PRESET_FILE = URI.file('/projects/sample-app/.paracode.json');
const WORKSPACE_SCOPE = `workspace:${PRESET_FILE.toString()}`;
const USER_SCOPE = 'user';

/** ユーザー設定の 1 件。`hidden` は別リポジトリ用（appliesTo）で、この一覧には出ない。 */
function userDefinition(name: string, folder?: string, hidden?: boolean): IParadisPresetDefinition {
	return { id: `id-${name}`, name, commands: [`echo ${name}`], folder, appliesTo: hidden ? ['other-app'] : undefined };
}

/**
 * スクリーンショットと同じ形の並び。ユーザー設定には、一覧に出ない別リポジトリ用の Lint が
 * Rst と Prn の間に混ざっている。
 */
function sampleUserList(): IParadisPresetDefinition[] {
	return [
		userDefinition('C'),
		userDefinition('X'),
		userDefinition('F'),
		userDefinition('B'),
		userDefinition('Dwn'),
		userDefinition('Rst'),
		userDefinition('Lint', undefined, true),
		userDefinition('Prn'),
		userDefinition('Prn (SSH)'),
		userDefinition('PRD', 'Proxy'),
		userDefinition('Prev', 'Proxy'),
		userDefinition('Dev', 'Proxy'),
		userDefinition('O'),
	];
}

const WORKSPACE_LIST: IParadisPresetDefinition[] = [
	{ name: 'SETUP', commands: ['npm ci'] },
	{ name: 'Run', commands: ['npm run dev'] },
];

/** サービスの presets と同じ形（リポジトリが先、ユーザー設定は一覧に出るものだけ）に解決する。 */
function resolve(userList: readonly IParadisPresetDefinition[], workspaceList: readonly IParadisPresetDefinition[] = WORKSPACE_LIST): IParadisResolvedPreset[] {
	const workspace = workspaceList.map((definition, index): IParadisResolvedPreset => ({
		...definition,
		source: 'workspace',
		sourceUri: PRESET_FILE,
		sourceIndex: index,
		key: paradisPresetKey('workspace', PRESET_FILE, definition, index),
	}));
	const user = userList
		.map((definition, index): IParadisResolvedPreset => ({ ...definition, source: 'user', sourceIndex: index, key: paradisPresetKey('user', undefined, definition, index) }))
		.filter(preset => !preset.appliesTo);
	return [...workspace, ...user];
}

function find(presets: readonly IParadisResolvedPreset[], name: string): IParadisResolvedPreset {
	const preset = presets.find(candidate => candidate.name === name);
	assert.ok(preset, name);
	return preset;
}

function presetItem(presets: readonly IParadisResolvedPreset[], name: string): ParadisPresetMoveItem {
	return { kind: 'preset', preset: find(presets, name) };
}

const proxyFolder: ParadisPresetMoveItem = { kind: 'folder', scopeKey: USER_SCOPE, folder: 'Proxy' };

/** 一覧の見た目。フォルダは `名前/[中身]`。 */
function display(presets: readonly IParadisResolvedPreset[]): string[] {
	return paradisGroupPresetsByFolder(presets).map(group => group.folder ? `${group.folder}/[${group.presets.map(preset => preset.name).join(', ')}]` : group.presets[0].name);
}

/** 保存される配列。folder 付きは `名前@フォルダ`、一覧に出ないものは `(名前)`。 */
function stored(list: readonly unknown[]): string[] {
	return (list as IParadisPresetDefinition[]).map(definition => {
		const name = definition.appliesTo ? `(${definition.name})` : definition.name;
		return definition.folder ? `${name}@${definition.folder}` : name;
	});
}

function plan(result: IParadisPresetMovePlan | ParadisPresetMoveRefusal): IParadisPresetMovePlan {
	assert.ok(!isParadisPresetMoveRefusal(result), `refused: ${result}`);
	return result;
}

/** 計画を、保存される配列と一覧の見た目の両方に当てた結果。 */
function outcome(userList: readonly IParadisPresetDefinition[], result: IParadisPresetMovePlan | ParadisPresetMoveRefusal, workspaceList: readonly IParadisPresetDefinition[] = WORKSPACE_LIST): { stored: string[]; display: string[] } {
	const movePlan = plan(result);
	const next = paradisMovePresetDefinitions(userList, movePlan, () => new Error('gone'));
	return { stored: stored(next), display: display(resolve(next as IParadisPresetDefinition[], workspaceList)) };
}

/** ドロップで入る位置を読める形に。`user before Proxy/`、`in Proxy before end / into` など。 */
function spotText(spot: IParadisPresetDropSpot): string {
	const position = spot.position;
	const name = (item: ParadisPresetMoveItem | undefined) => !item ? 'end' : item.kind === 'preset' ? item.preset.name : `${item.folder}/`;
	const where = position.kind === 'top'
		? `${position.scopeKey === USER_SCOPE ? 'user' : 'workspace'} before ${name(position.before)}`
		: `in ${position.folder} before ${position.before?.name ?? 'end'}`;
	return [where, spot.into ? 'into' : undefined, spot.hint].filter(part => !!part).join(' / ');
}

suite('paradisPresetReorder', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('moves the preset below a folder to just above it with one step up, leaving everything else in place', () => {
		const userList = sampleUserList();
		const presets = resolve(userList);
		const result = outcome(userList, paradisPlanPresetStep(presets, presetItem(presets, 'O'), -1));
		assert.deepStrictEqual(result, {
			stored: ['C', 'X', 'F', 'B', 'Dwn', 'Rst', '(Lint)', 'Prn', 'Prn (SSH)', 'O', 'PRD@Proxy', 'Prev@Proxy', 'Dev@Proxy'],
			display: ['SETUP', 'Run', 'C', 'X', 'F', 'B', 'Dwn', 'Rst', 'Prn', 'Prn (SSH)', 'O', 'Proxy/[PRD, Prev, Dev]'],
		});
		// ドラッグで「Proxy フォルダの前」に落としても同じ書き込みになる。
		assert.deepStrictEqual(
			paradisPlanPresetMove(presets, presetItem(presets, 'O'), { kind: 'top', scopeKey: USER_SCOPE, before: proxyFolder }),
			paradisPlanPresetStep(presets, presetItem(presets, 'O'), -1),
		);
	});

	test('inserts instead of swapping, so the rows in between shift by one', () => {
		const userList = sampleUserList();
		const presets = resolve(userList);
		const result = outcome(userList, paradisPlanPresetMove(presets, presetItem(presets, 'O'), { kind: 'top', scopeKey: USER_SCOPE, before: presetItem(presets, 'F') }));
		assert.deepStrictEqual(result.display, ['SETUP', 'Run', 'C', 'X', 'O', 'F', 'B', 'Dwn', 'Rst', 'Prn', 'Prn (SSH)', 'Proxy/[PRD, Prev, Dev]']);
	});

	test('moves a whole folder as one block, including members that this repository does not show', () => {
		const userList = [...sampleUserList(), userDefinition('Stg', 'Proxy', true)];
		const presets = resolve(userList);
		assert.deepStrictEqual({
			up: outcome(userList, paradisPlanPresetStep(presets, proxyFolder, -1)),
			down: outcome(userList, paradisPlanPresetStep(presets, proxyFolder, 1)).stored,
			toTop: outcome(userList, paradisPlanPresetMove(presets, proxyFolder, { kind: 'top', scopeKey: USER_SCOPE, before: presetItem(presets, 'C') })).display,
		}, {
			up: {
				stored: ['C', 'X', 'F', 'B', 'Dwn', 'Rst', '(Lint)', 'Prn', 'PRD@Proxy', 'Prev@Proxy', 'Dev@Proxy', '(Stg)@Proxy', 'Prn (SSH)', 'O'],
				display: ['SETUP', 'Run', 'C', 'X', 'F', 'B', 'Dwn', 'Rst', 'Prn', 'Proxy/[PRD, Prev, Dev]', 'Prn (SSH)', 'O'],
			},
			down: ['C', 'X', 'F', 'B', 'Dwn', 'Rst', '(Lint)', 'Prn', 'Prn (SSH)', 'O', 'PRD@Proxy', 'Prev@Proxy', 'Dev@Proxy', '(Stg)@Proxy'],
			toTop: ['SETUP', 'Run', 'Proxy/[PRD, Prev, Dev]', 'C', 'X', 'F', 'B', 'Dwn', 'Rst', 'Prn', 'Prn (SSH)', 'O'],
		});
	});

	test('takes a preset out of its folder from either edge, and with Alt+Left from the middle', () => {
		const userList = sampleUserList();
		const presets = resolve(userList);
		assert.deepStrictEqual({
			firstUp: outcome(userList, paradisPlanPresetStep(presets, presetItem(presets, 'PRD'), -1)).display,
			lastDown: outcome(userList, paradisPlanPresetStep(presets, presetItem(presets, 'Dev'), 1)).display,
			middleOut: outcome(userList, paradisPlanPresetNest(presets, presetItem(presets, 'Prev'), false)),
			dragOut: outcome(userList, paradisPlanPresetMove(presets, presetItem(presets, 'Prev'), { kind: 'top', scopeKey: USER_SCOPE, before: presetItem(presets, 'C') })).display,
		}, {
			firstUp: ['SETUP', 'Run', 'C', 'X', 'F', 'B', 'Dwn', 'Rst', 'Prn', 'Prn (SSH)', 'PRD', 'Proxy/[Prev, Dev]', 'O'],
			lastDown: ['SETUP', 'Run', 'C', 'X', 'F', 'B', 'Dwn', 'Rst', 'Prn', 'Prn (SSH)', 'Proxy/[PRD, Prev]', 'Dev', 'O'],
			middleOut: {
				stored: ['C', 'X', 'F', 'B', 'Dwn', 'Rst', '(Lint)', 'Prn', 'Prn (SSH)', 'PRD@Proxy', 'Dev@Proxy', 'Prev', 'O'],
				display: ['SETUP', 'Run', 'C', 'X', 'F', 'B', 'Dwn', 'Rst', 'Prn', 'Prn (SSH)', 'Proxy/[PRD, Dev]', 'Prev', 'O'],
			},
			dragOut: ['SETUP', 'Run', 'Prev', 'C', 'X', 'F', 'B', 'Dwn', 'Rst', 'Prn', 'Prn (SSH)', 'Proxy/[PRD, Dev]', 'O'],
		});
	});

	test('puts a preset into a folder by drop, by Alt+Right and from the context menu', () => {
		const userList = sampleUserList();
		const presets = resolve(userList);
		assert.deepStrictEqual({
			dropBetween: outcome(userList, paradisPlanPresetMove(presets, presetItem(presets, 'C'), { kind: 'folder', scopeKey: USER_SCOPE, folder: 'Proxy', before: find(presets, 'Dev') })),
			intoAbove: outcome(userList, paradisPlanPresetNest(presets, presetItem(presets, 'O'), true)).display,
			intoBelow: outcome(userList, paradisPlanPresetNest(presets, presetItem(presets, 'Prn (SSH)'), true)).display,
			menu: outcome(userList, paradisPlanPresetMoveToFolder(presets, find(presets, 'X'), 'Proxy')).display,
			menuChoices: [paradisPresetMoveFolderChoices(presets, find(presets, 'X')), paradisPresetMoveFolderChoices(presets, find(presets, 'PRD')), paradisPresetMoveFolderChoices(presets, find(presets, 'Run'))],
			noFolderNearby: paradisPlanPresetNest(presets, presetItem(presets, 'C'), true),
			folderIntoFolder: [paradisPlanPresetNest(presets, proxyFolder, true), paradisPlanPresetMove(presets, proxyFolder, { kind: 'folder', scopeKey: USER_SCOPE, folder: 'Proxy', before: undefined })],
			notInFolder: paradisPlanPresetNest(presets, presetItem(presets, 'C'), false),
		}, {
			dropBetween: {
				stored: ['X', 'F', 'B', 'Dwn', 'Rst', '(Lint)', 'Prn', 'Prn (SSH)', 'PRD@Proxy', 'Prev@Proxy', 'C@Proxy', 'Dev@Proxy', 'O'],
				display: ['SETUP', 'Run', 'X', 'F', 'B', 'Dwn', 'Rst', 'Prn', 'Prn (SSH)', 'Proxy/[PRD, Prev, C, Dev]', 'O'],
			},
			intoAbove: ['SETUP', 'Run', 'C', 'X', 'F', 'B', 'Dwn', 'Rst', 'Prn', 'Prn (SSH)', 'Proxy/[PRD, Prev, Dev, O]'],
			intoBelow: ['SETUP', 'Run', 'C', 'X', 'F', 'B', 'Dwn', 'Rst', 'Prn', 'Proxy/[Prn (SSH), PRD, Prev, Dev]', 'O'],
			menu: ['SETUP', 'Run', 'C', 'F', 'B', 'Dwn', 'Rst', 'Prn', 'Prn (SSH)', 'Proxy/[PRD, Prev, Dev, X]', 'O'],
			menuChoices: [['Proxy'], [], []],
			noFolderNearby: 'noFolderNearby',
			folderIntoFolder: ['nestFolder', 'nestFolder'],
			notInFolder: 'notInFolder',
		});
	});

	test('lets the last preset leave its folder, which then disappears from the list', () => {
		const userList = [userDefinition('A'), userDefinition('Solo', 'Single'), userDefinition('Z')];
		const presets = resolve(userList, []);
		const solo = presetItem(presets, 'Solo');
		assert.deepStrictEqual({
			stepUp: outcome(userList, paradisPlanPresetStep(presets, solo, -1), []),
			dropBeforeOwnFolder: outcome(userList, paradisPlanPresetMove(presets, solo, { kind: 'top', scopeKey: USER_SCOPE, before: { kind: 'folder', scopeKey: USER_SCOPE, folder: 'Single' } }), []).display,
			stayInside: paradisPlanPresetMove(presets, solo, { kind: 'folder', scopeKey: USER_SCOPE, folder: 'Single', before: undefined }),
		}, {
			stepUp: { stored: ['A', 'Solo', 'Z'], display: ['A', 'Solo', 'Z'] },
			dropBeforeOwnFolder: ['A', 'Solo', 'Z'],
			stayInside: 'unchanged',
		});
	});

	test('stops at the border between the repository file and the user settings', () => {
		const presets = resolve(sampleUserList());
		assert.deepStrictEqual({
			userFirstUp: paradisPlanPresetStep(presets, presetItem(presets, 'C'), -1),
			workspaceLastDown: paradisPlanPresetStep(presets, presetItem(presets, 'Run'), 1),
			userIntoWorkspace: paradisPlanPresetMove(presets, presetItem(presets, 'O'), { kind: 'top', scopeKey: WORKSPACE_SCOPE, before: undefined }),
			workspaceIntoUserFolder: paradisPlanPresetMove(presets, presetItem(presets, 'Run'), { kind: 'folder', scopeKey: USER_SCOPE, folder: 'Proxy', before: undefined }),
			workspaceUp: display(paradisApplyPresetMovePlan(presets, plan(paradisPlanPresetStep(presets, presetItem(presets, 'Run'), -1)))).slice(0, 3),
		}, {
			userFirstUp: 'scopeStart',
			workspaceLastDown: 'scopeEnd',
			userIntoWorkspace: 'otherScope',
			workspaceIntoUserFolder: 'otherScope',
			workspaceUp: ['Run', 'SETUP', 'C'],
		});
		assert.strictEqual(paradisPresetScopeKey(find(presets, 'Run')), WORKSPACE_SCOPE);
	});

	test('keeps rows this repository does not show next to the rows they were stored with', () => {
		const userList = sampleUserList();
		const presets = resolve(userList);
		assert.deepStrictEqual({
			oToTop: outcome(userList, paradisPlanPresetMove(presets, presetItem(presets, 'O'), { kind: 'top', scopeKey: USER_SCOPE, before: presetItem(presets, 'C') })).stored,
			prnUp: outcome(userList, paradisPlanPresetStep(presets, presetItem(presets, 'Prn'), -1)).stored,
			rstDown: outcome(userList, paradisPlanPresetStep(presets, presetItem(presets, 'Rst'), 1)).stored,
		}, {
			oToTop: ['O', 'C', 'X', 'F', 'B', 'Dwn', 'Rst', '(Lint)', 'Prn', 'Prn (SSH)', 'PRD@Proxy', 'Prev@Proxy', 'Dev@Proxy'],
			prnUp: ['C', 'X', 'F', 'B', 'Dwn', 'Prn', 'Rst', '(Lint)', 'Prn (SSH)', 'PRD@Proxy', 'Prev@Proxy', 'Dev@Proxy', 'O'],
			rstDown: ['C', 'X', 'F', 'B', 'Dwn', '(Lint)', 'Prn', 'Rst', 'Prn (SSH)', 'PRD@Proxy', 'Prev@Proxy', 'Dev@Proxy', 'O'],
		});
	});

	test('reports positions that would not change anything, including the slots right before and after the dragged row', () => {
		const presets = resolve(sampleUserList());
		assert.deepStrictEqual([
			paradisPlanPresetMove(presets, presetItem(presets, 'X'), { kind: 'top', scopeKey: USER_SCOPE, before: presetItem(presets, 'X') }),
			paradisPlanPresetMove(presets, presetItem(presets, 'X'), { kind: 'top', scopeKey: USER_SCOPE, before: presetItem(presets, 'F') }),
			paradisPlanPresetMove(presets, presetItem(presets, 'O'), { kind: 'top', scopeKey: USER_SCOPE, before: undefined }),
			paradisPlanPresetMove(presets, presetItem(presets, 'Dev'), { kind: 'folder', scopeKey: USER_SCOPE, folder: 'Proxy', before: undefined }),
			paradisPlanPresetMove(presets, proxyFolder, { kind: 'top', scopeKey: USER_SCOPE, before: presetItem(presets, 'O') }),
		], ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged']);
	});

	test('picks the drop position from where the pointer is on the row', () => {
		const presets = resolve(sampleUserList());
		const c = presetItem(presets, 'C');
		const folderRow = (expanded: boolean): ParadisPresetDropTarget => ({ kind: 'folder', scopeKey: USER_SCOPE, folder: 'Proxy', expanded });
		const presetRow = (name: string, leftOfIndent = false): ParadisPresetDropTarget => ({ kind: 'preset', preset: find(presets, name), leftOfIndent });
		const spot = (target: ParadisPresetDropTarget, rel: number, item: ParadisPresetMoveItem = c) => spotText(paradisPresetDropSpot(presets, item, target, rel));
		assert.deepStrictEqual({
			folderTopQuarter: spot(folderRow(true), 0.1),
			folderMiddle: spot(folderRow(true), 0.5),
			folderBottomQuarterOpen: spot(folderRow(true), 0.9),
			folderBottomQuarterClosed: spot(folderRow(false), 0.9),
			draggedFolderOnItsRowLowerHalf: spot(folderRow(true), 0.6, proxyFolder),
			rowAboveFolderLowerHalf: spot(presetRow('Prn (SSH)'), 0.7),
			rowAboveFolderUpperHalf: spot(presetRow('Prn (SSH)'), 0.3),
			memberUpperHalf: spot(presetRow('Prev'), 0.3),
			memberLowerHalf: spot(presetRow('Prev'), 0.7),
			lastMemberLowerHalfLeft: spot(presetRow('Dev', true), 0.7),
			lastMemberLowerHalfRight: spot(presetRow('Dev', false), 0.7),
			section: spot({ kind: 'section', scopeKey: USER_SCOPE }, 0.5),
		}, {
			folderTopQuarter: 'user before Proxy/',
			folderMiddle: 'in Proxy before end / into',
			folderBottomQuarterOpen: 'in Proxy before PRD',
			folderBottomQuarterClosed: 'user before O',
			draggedFolderOnItsRowLowerHalf: 'user before O',
			rowAboveFolderLowerHalf: 'user before Proxy/',
			rowAboveFolderUpperHalf: 'user before Prn (SSH)',
			memberUpperHalf: 'in Proxy before Prev',
			memberLowerHalf: 'in Proxy before Dev',
			lastMemberLowerHalfLeft: 'user before O / afterFolder',
			lastMemberLowerHalfRight: 'in Proxy before end / folderEnd',
			section: 'user before C',
		});
	});

	test('drops a dragged folder before or after another folder when it is held over that folder\'s rows, never inside', () => {
		const presets = resolve([...sampleUserList(), userDefinition('Up', 'Docker'), userDefinition('Down', 'Docker')]);
		const docker: ParadisPresetMoveItem = { kind: 'folder', scopeKey: USER_SCOPE, folder: 'Docker' };
		const prev: ParadisPresetDropTarget = { kind: 'preset', preset: find(presets, 'Prev'), leftOfIndent: false };
		assert.deepStrictEqual([
			spotText(paradisPresetDropSpot(presets, docker, prev, 0.3)),
			spotText(paradisPresetDropSpot(presets, docker, prev, 0.7)),
			spotText(paradisPresetDropSpot(presets, docker, { kind: 'folder', scopeKey: USER_SCOPE, folder: 'Proxy', expanded: true }, 0.5)),
		], ['user before Proxy/', 'user before O', 'user before O']);
	});

	test('keeps a drop on the border between two storage locations on the side of the dragged row', () => {
		const presets = resolve(sampleUserList());
		assert.deepStrictEqual([
			// ユーザー設定の 1 件を .paracode.json の最後の行の下半分に重ねたら、ユーザー設定の先頭。
			spotText(paradisPresetDropSpot(presets, presetItem(presets, 'O'), { kind: 'preset', preset: find(presets, 'Run'), leftOfIndent: false }, 0.7)),
			// .paracode.json の 1 件をユーザー設定の見出しに重ねたら、.paracode.json の最後。
			spotText(paradisPresetDropSpot(presets, presetItem(presets, 'SETUP'), { kind: 'section', scopeKey: USER_SCOPE }, 0.5)),
		], ['user before C', 'workspace before end']);
	});

	test('tells where a row sits after a move, for the screen reader', () => {
		const presets = resolve(sampleUserList());
		assert.deepStrictEqual([
			paradisPresetPlaceOf(presets, presetItem(presets, 'O')),
			paradisPresetPlaceOf(presets, presetItem(presets, 'Prev')),
			paradisPresetPlaceOf(presets, proxyFolder),
			paradisPresetPlaceOf(presets, presetItem(presets, 'Run')),
		], [
			{ folder: undefined, index: 10, count: 10 },
			{ folder: 'Proxy', index: 2, count: 3 },
			{ folder: undefined, index: 9, count: 10 },
			{ folder: undefined, index: 2, count: 2 },
		]);
	});

	test('stops manual reordering while the list is narrowed by a search or a filter', () => {
		assert.deepStrictEqual([
			paradisPresetReorderBlocked('proxy', 'all'),
			paradisPresetReorderBlocked('', 'folder'),
			paradisPresetReorderBlocked('', 'source'),
			paradisPresetReorderBlocked('   ', 'all'),
		], [true, true, true, false]);
	});

	test('refuses to write when the stored list changed after the dialog was drawn', () => {
		const userList = sampleUserList();
		const presets = resolve(userList);
		const movePlan = plan(paradisPlanPresetStep(presets, presetItem(presets, 'O'), -1));
		const changed = userList.filter(definition => definition.name !== 'PRD');
		assert.throws(() => paradisMovePresetDefinitions(changed, movePlan, () => new Error('gone')), /gone/);
	});

	test('moves list entries by inserting them before or after an anchor, keeping their order', () => {
		const list = ['a', 'b', 'c', 'd', 'e'];
		assert.deepStrictEqual([
			paradisMoveListEntries(list, [3], 1, 'before', entry => entry),
			paradisMoveListEntries(list, [0, 2], 3, 'after', entry => entry.toUpperCase()),
			paradisMoveListEntries(list, [1], 1, 'before', entry => entry),
			paradisMoveListEntries(list, [4, 1], undefined, 'after', (entry, index) => `${entry}${index}`),
		], [
			['a', 'd', 'b', 'c', 'e'],
			['b', 'd', 'A', 'C', 'e'],
			['a', 'b', 'c', 'd', 'e'],
			['a', 'c', 'd', 'b1', 'e4'],
		]);
	});
});
