/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisLayoutNode,
	IParadisResolvedLayoutPreset,
	isValidLayoutPresetDefinition,
	PARADIS_LAYOUT_MAX_SLOTS,
	paradisCountLayoutSlots,
	paradisFlattenLayoutSlots,
	paradisLayoutGroupArguments,
	paradisLayoutOrientationValue,
	paradisLayoutPresetFingerprint,
	paradisLayoutPresetSummary,
	paradisNormalizeLayoutNodes,
	paradisResolveLayoutPresetIndex,
} from '../../common/paradisLayoutPresets.js';
import {
	paradisOrientationAtDepth,
	paradisRemoveLayoutSlot,
	paradisSplitLayoutSlot,
	paradisUpdateLayoutSlot,
} from '../../common/paradisLayoutTreeEdit.js';

const empty = (): IParadisLayoutNode => ({ slot: { kind: 'empty' } });

/**
 * ユーザーが例に挙げた形:「左に縦積みターミナル2つ、右上にブラウザ、右下にターミナル」。
 * ルートは columns（左右2列）で、各列の子は直交して上下に並ぶ。
 */
function exampleLayout(): IParadisLayoutNode[] {
	return [
		{ children: [{ slot: { kind: 'terminal', command: 'npm run dev' } }, { slot: { kind: 'terminal', command: 'npm test' } }] },
		{ children: [{ slot: { kind: 'browser', url: 'http://localhost:5173' } }, { slot: { kind: 'terminal' } }] },
	];
}

suite('Paradis Layout Presets - model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('枠は深さ優先（GRID_APPEARANCE と同じ順）で列挙される', () => {
		assert.deepStrictEqual(paradisFlattenLayoutSlots(exampleLayout()), [
			{ kind: 'terminal', command: 'npm run dev' },
			{ kind: 'terminal', command: 'npm test' },
			{ kind: 'browser', url: 'http://localhost:5173' },
			{ kind: 'terminal' },
		]);
	});

	test('applyLayout へ渡す形は中身を落とし、size は指定があるときだけ載せる', () => {
		const root: IParadisLayoutNode[] = [
			{ size: 0.3, slot: { kind: 'terminal', command: 'npm run dev' } },
			{ size: 0.7, children: [empty(), { size: 0.5, slot: { kind: 'browser' } }] },
		];
		assert.deepStrictEqual(paradisLayoutGroupArguments(root), [
			{ size: 0.3 },
			{ size: 0.7, groups: [{}, { size: 0.5 }] },
		]);
	});

	test('orientation は columns=0(横並び) / rows=1(縦並び) に対応し、既定は columns', () => {
		assert.deepStrictEqual(
			[paradisLayoutOrientationValue('columns'), paradisLayoutOrientationValue('rows'), paradisLayoutOrientationValue(undefined)],
			[0, 1, 0],
		);
	});

	test('入れ子の並びは1段ごとに直交する', () => {
		assert.deepStrictEqual(
			[1, 2, 3, 4].map(depth => paradisOrientationAtDepth('columns', depth)),
			['columns', 'rows', 'columns', 'rows'],
		);
	});

	test('要約は種類ごとに件数をまとめる', () => {
		const labels = { empty: '未設定', terminal: 'ターミナル', browser: 'ブラウザ', file: 'ファイル' } as const;
		assert.strictEqual(
			paradisLayoutPresetSummary({ name: 'x', root: exampleLayout() }, labels),
			'ターミナル×3 · ブラウザ',
		);
	});
});

suite('Paradis Layout Presets - validation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('名前・root・種類・比率の不正なエントリは弾く', () => {
		const cases: [string, unknown][] = [
			['名前なし', { root: [empty()] }],
			['名前が空白のみ', { name: '   ', root: [empty()] }],
			['root が空', { name: 'x', root: [] }],
			['root が配列でない', { name: 'x', root: {} }],
			['知らない種類', { name: 'x', root: [{ slot: { kind: 'database' } }] }],
			['知らない orientation', { name: 'x', orientation: 'diagonal', root: [empty()] }],
			['比率が 0', { name: 'x', root: [{ size: 0, slot: { kind: 'empty' } }] }],
			['比率が負', { name: 'x', root: [{ size: -1, slot: { kind: 'empty' } }] }],
			['比率が数値でない', { name: 'x', root: [{ size: '0.5', slot: { kind: 'empty' } }] }],
			['コマンドが文字列でない', { name: 'x', root: [{ slot: { kind: 'terminal', command: 42 } }] }],
		];
		assert.deepStrictEqual(
			cases.map(([label, value]) => [label, isValidLayoutPresetDefinition(value)]),
			cases.map(([label]) => [label, false]),
		);
	});

	test('妥当な定義（例のレイアウト）は通る', () => {
		assert.strictEqual(isValidLayoutPresetDefinition({ name: 'フロントエンド開発', orientation: 'columns', root: exampleLayout() }), true);
	});

	test('比率は相対値なので 1 を超える書き方も通る', () => {
		assert.strictEqual(isValidLayoutPresetDefinition({ name: 'x', root: [{ size: 3, slot: { kind: 'empty' } }, { size: 7, slot: { kind: 'empty' } }] }), true);
	});

	test('枠が上限を超える定義は、黙って切り詰めずに丸ごと弾く', () => {
		const root = Array.from({ length: PARADIS_LAYOUT_MAX_SLOTS + 1 }, empty);
		assert.strictEqual(isValidLayoutPresetDefinition({ name: 'x', root }), false);
		assert.strictEqual(isValidLayoutPresetDefinition({ name: 'x', root: root.slice(0, PARADIS_LAYOUT_MAX_SLOTS) }), true);
	});

	test('入れ子が深すぎる定義は弾く', () => {
		let node: IParadisLayoutNode = empty();
		for (let depth = 0; depth < 8; depth++) {
			node = { children: [node, empty()] };
		}
		assert.strictEqual(isValidLayoutPresetDefinition({ name: 'x', root: [node] }), false);
	});
});

suite('Paradis Layout Presets - tree editing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ルート直下が1枠だけのときの分割は、入れ子にせずルートの向きを反転する', () => {
		const result = paradisSplitLayoutSlot([{ slot: { kind: 'terminal' } }], 'columns', [0], 'down');
		assert.deepStrictEqual(
			{ orientation: result.orientation, root: result.root, created: result.created },
			{ orientation: 'rows', root: [{ slot: { kind: 'terminal' } }, { slot: { kind: 'empty' } }], created: [1] },
		);
	});

	test('親の並びと同じ向きの分割は、入れ子を増やさず兄弟として差し込む', () => {
		const result = paradisSplitLayoutSlot([empty(), empty()], 'columns', [0], 'right');
		assert.deepStrictEqual(
			{ root: result.root, created: result.created, orientation: result.orientation },
			{ root: [empty(), empty(), empty()], created: [1], orientation: 'columns' },
		);
	});

	test('親の並びと直交する分割は、その枠を分岐に置き換える', () => {
		const result = paradisSplitLayoutSlot([{ slot: { kind: 'terminal' } }, empty()], 'columns', [0], 'down');
		assert.deepStrictEqual(
			{ root: result.root, created: result.created },
			{ root: [{ children: [{ slot: { kind: 'terminal' } }, empty()] }, empty()], created: [0, 1] },
		);
	});

	test('上／左への分割では新しい枠が手前に入る', () => {
		const result = paradisSplitLayoutSlot([{ slot: { kind: 'terminal' } }, empty()], 'columns', [1], 'left');
		assert.deepStrictEqual(
			{ root: result.root, created: result.created },
			{ root: [{ slot: { kind: 'terminal' } }, empty(), empty()], created: [1] },
		);
	});

	test('子が1つだけの分岐は正規化で畳まれる（枠と中身が1つずれるのを防ぐ）', () => {
		// グリッド側（sanitizeGridNodeDescriptor）はルート以外の単一子の分岐を葉に潰す。
		// 潰されたまま中身を配ると、以降の枠すべてに1つ後ろの中身が入り、末尾は消える。
		const handWritten: IParadisLayoutNode[] = [
			{ children: [{ children: [{ slot: { kind: 'terminal' } }, { slot: { kind: 'browser' } }] }] },
			{ slot: { kind: 'file', path: 'README.md' } },
		];
		const normalized = paradisNormalizeLayoutNodes(handWritten);
		assert.deepStrictEqual(normalized, [
			{ children: [{ slot: { kind: 'terminal' } }, { slot: { kind: 'browser' } }] },
			{ slot: { kind: 'file', path: 'README.md' } },
		]);
		// 正規化しても枠の数と並びは変わらない＝中身の対応はずれない
		assert.deepStrictEqual(paradisFlattenLayoutSlots(normalized), paradisFlattenLayoutSlots(handWritten));
		assert.strictEqual(paradisLayoutGroupArguments(normalized).length, 2);
	});

	test('指紋は正規化してから比べる（生の定義と読み込み済みを突き合わせられる）', () => {
		const nested = { name: 'x', root: [{ children: [{ slot: { kind: 'terminal' as const } }] }] };
		const flat = { name: 'x', root: [{ slot: { kind: 'terminal' as const } }] };
		assert.strictEqual(paradisLayoutPresetFingerprint(nested), paradisLayoutPresetFingerprint(flat));
	});

	test('分割で兄弟が増えるときは、合計が 1 でなくなる比率を落とす', () => {
		const result = paradisSplitLayoutSlot([{ size: 0.4, slot: { kind: 'terminal' } }, { size: 0.6, slot: { kind: 'browser' } }], 'columns', [0], 'right');
		assert.deepStrictEqual(result.root, [{ slot: { kind: 'terminal' } }, empty(), { slot: { kind: 'browser' } }]);
	});

	test('枠が上限に達していたら分割しない', () => {
		const root = Array.from({ length: PARADIS_LAYOUT_MAX_SLOTS }, empty);
		const result = paradisSplitLayoutSlot(root, 'columns', [0], 'right');
		assert.strictEqual(paradisCountLayoutSlots(result.root), PARADIS_LAYOUT_MAX_SLOTS);
		assert.strictEqual(result.created, undefined);
	});

	test('例のレイアウトを分割の積み重ねだけで組み立てられる', () => {
		// 1枠 →（右へ分割）→ 左右2列 →（左を下へ分割・右を下へ分割）→ 2×2
		let root: readonly IParadisLayoutNode[] = [empty()];
		let orientation: 'columns' | 'rows' = 'columns';
		({ root, orientation } = paradisSplitLayoutSlot(root, orientation, [0], 'right'));
		({ root, orientation } = paradisSplitLayoutSlot(root, orientation, [0], 'down'));
		({ root, orientation } = paradisSplitLayoutSlot(root, orientation, [1], 'down'));

		root = paradisUpdateLayoutSlot(root, [0, 0], { kind: 'terminal', command: 'npm run dev' });
		root = paradisUpdateLayoutSlot(root, [0, 1], { kind: 'terminal', command: 'npm test' });
		root = paradisUpdateLayoutSlot(root, [1, 0], { kind: 'browser', url: 'http://localhost:5173' });
		root = paradisUpdateLayoutSlot(root, [1, 1], { kind: 'terminal' });

		assert.deepStrictEqual({ orientation, root }, { orientation: 'columns', root: exampleLayout() });
	});

	test('枠を減らして子が1つになった分岐は畳まれる', () => {
		const root = paradisRemoveLayoutSlot(exampleLayout(), [0, 1]);
		assert.deepStrictEqual(root, [
			{ slot: { kind: 'terminal', command: 'npm run dev' } },
			{ children: [{ slot: { kind: 'browser', url: 'http://localhost:5173' } }, { slot: { kind: 'terminal' } }] },
		]);
	});

	test('畳むときは分岐が持っていた比率を残った子へ引き継ぐ', () => {
		const root = paradisRemoveLayoutSlot([{ size: 0.3, children: [empty(), { slot: { kind: 'terminal' } }] }, { size: 0.7, slot: { kind: 'browser' } }], [0, 0]);
		assert.deepStrictEqual(root, [{ size: 0.3, slot: { kind: 'terminal' } }, { size: 0.7, slot: { kind: 'browser' } }]);
	});

	test('最後の1枠を消しても、枠0個にはせず白紙の1枠に戻す', () => {
		assert.deepStrictEqual(paradisRemoveLayoutSlot([{ slot: { kind: 'terminal' } }], [0]), [empty()]);
	});

	test('存在しない道順への操作は木を変えない', () => {
		const root = exampleLayout();
		assert.deepStrictEqual(paradisRemoveLayoutSlot(root, [5]), root);
		assert.deepStrictEqual(paradisUpdateLayoutSlot(root, [0, 9], { kind: 'terminal' }), root);
		assert.deepStrictEqual(paradisSplitLayoutSlot(root, 'columns', [], 'right').root, root);
	});

	test('中身の差し替えは元の木を壊さない（下書きの取り消しが効くこと）', () => {
		const root = exampleLayout();
		const next = paradisUpdateLayoutSlot(root, [0, 0], { kind: 'file', path: 'src/index.ts' });
		assert.deepStrictEqual(paradisFlattenLayoutSlots(root)[0], { kind: 'terminal', command: 'npm run dev' });
		assert.deepStrictEqual(paradisFlattenLayoutSlots(next)[0], { kind: 'file', path: 'src/index.ts' });
	});

});

suite('Paradis Layout Presets - identity', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const resolved = (definition: { id?: string; name: string; root: IParadisLayoutNode[] }, sourceIndex: number): IParadisResolvedLayoutPreset =>
		({ ...definition, sourceIndex, key: definition.id ?? `#${sourceIndex}` });

	test('並び替えられていても id で本人を見つける', () => {
		const preset = resolved({ id: 'a', name: '開発', root: [empty()] }, 0);
		const list = [{ name: '別物', root: [empty()] }, { id: 'a', name: '開発', root: [empty()] }];
		assert.strictEqual(paradisResolveLayoutPresetIndex(list, preset), 1);
	});

	test('id が無い定義は、その位置の中身が指紋まで一致するときだけ本人と認める', () => {
		const preset = resolved({ name: '開発', root: [{ slot: { kind: 'terminal', command: 'npm run dev' } }] }, 0);
		const same = [{ name: '開発', root: [{ slot: { kind: 'terminal', command: 'npm run dev' } }] }];
		// 名前も形も同じでコマンドだけ違う「双子」は、取り違えないよう別物として扱う
		const twin = [{ name: '開発', root: [{ slot: { kind: 'terminal', command: 'npm start' } }] }];
		assert.deepStrictEqual(
			[paradisResolveLayoutPresetIndex(same, preset), paradisResolveLayoutPresetIndex(twin, preset)],
			[0, -1],
		);
	});
});
