// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { agentModelOptions } from './agentModels.js';
import {
	EMPTY_HIDDEN_MODELS,
	HIDDEN_MODELS_KEY,
	canHideModel,
	countVisibleModels,
	initialModelSelection,
	loadHiddenModels,
	modelVisibilityAgent,
	normalizeHiddenModels,
	pickerModelChoices,
	replayHiddenModelOps,
	saveHiddenModels,
	withModelHidden,
} from './modelVisibility.js';

const CODEX = [
	{ id: 'gpt-6.1-sol', isDefault: true },
	{ id: 'gpt-6.1' },
	{ id: 'gpt-6.1-mini' },
];

const choices = (list: ReturnType<typeof pickerModelChoices>) => list.map(choice => `${choice.option.id}${choice.hidden ? ' (hidden)' : ''}`);

describe('隠す設定の保存形', () => {
	test('壊れた値・重複・文字列以外は落とす', () => {
		expect([
			normalizeHiddenModels(undefined),
			normalizeHiddenModels('x'),
			normalizeHiddenModels({ claude: ['opus', 'opus', 3, ''], codex: 'gpt' }),
		]).toEqual([EMPTY_HIDDEN_MODELS, EMPTY_HIDDEN_MODELS, { claude: ['opus'], codex: [] }]);
	});

	test('何も隠していなければ項目ごと消し、隠していれば JSON で書いて読み戻せる', async () => {
		const saved = new Map<string, string>();
		const log: string[] = [];
		const store = {
			getItem: async (key: string) => saved.get(key) ?? null,
			setItem: async (key: string, value: string) => { saved.set(key, value); log.push(`set ${key}`); },
			deleteItem: async (key: string) => { saved.delete(key); log.push(`delete ${key}`); },
		};
		await saveHiddenModels(store, { claude: ['haiku'], codex: [] });
		const loaded = await loadHiddenModels(store);
		await saveHiddenModels(store, EMPTY_HIDDEN_MODELS);
		saved.set(HIDDEN_MODELS_KEY, '{broken');
		const broken = await loadHiddenModels(store);
		expect({ loaded, broken, log }).toEqual({
			loaded: { claude: ['haiku'], codex: [] },
			broken: EMPTY_HIDDEN_MODELS,
			log: [`set ${HIDDEN_MODELS_KEY}`, `delete ${HIDDEN_MODELS_KEY}`],
		});
	});

	test('隠す・戻すはエージェントごとで、変わらなければ同じオブジェクト', () => {
		const hidden = withModelHidden(EMPTY_HIDDEN_MODELS, 'codex', 'gpt-6.1', true);
		expect({
			hidden,
			again: withModelHidden(hidden, 'codex', 'gpt-6.1', true) === hidden,
			restored: withModelHidden(hidden, 'codex', 'gpt-6.1', false),
			agents: [modelVisibilityAgent('claude'), modelVisibilityAgent('codex'), modelVisibilityAgent('shell'), modelVisibilityAgent(undefined)],
		}).toEqual({
			hidden: { claude: [], codex: ['gpt-6.1'] },
			again: true,
			restored: EMPTY_HIDDEN_MODELS,
			agents: ['claude', 'codex', undefined, undefined],
		});
	});

	test('読み込み前の切り替えは、保存値の上に順に当て直す（もう一方のエージェントの保存値は消さない）', () => {
		const stored = { claude: ['haiku'], codex: ['gpt-6.1'] };
		expect({
			replayed: replayHiddenModelOps(stored, [
				{ agent: 'codex', id: 'gpt-6.1-mini', hidden: true },
				{ agent: 'codex', id: 'gpt-6.1', hidden: false },
				{ agent: 'codex', id: 'gpt-6.1-mini', hidden: false },
				{ agent: 'codex', id: 'gpt-6.1-sol', hidden: true },
			]),
			none: replayHiddenModelOps(stored, []) === stored,
		}).toEqual({
			replayed: { claude: ['haiku'], codex: ['gpt-6.1-sol'] },
			none: true,
		});
	});
});

describe('モデルを選ぶシートに並べる行', () => {
	test('隠したものを外し、使用中は隠していても「非表示」として残す', () => {
		expect([
			choices(pickerModelChoices(CODEX, ['gpt-6.1', 'gpt-6.1-mini'], 'gpt-6.1-mini')),
			choices(pickerModelChoices(CODEX, ['gpt-6.1'], undefined)),
		]).toEqual([
			['gpt-6.1-sol', 'gpt-6.1-mini (hidden)'],
			['gpt-6.1-sol', 'gpt-6.1-mini'],
		]);
	});

	test('新しく増えたモデルはそのまま出て、一覧から消えた id は何もしない', () => {
		const hidden = ['gpt-5-old', 'gpt-6.1'];
		expect({
			shown: choices(pickerModelChoices(CODEX, hidden, undefined)),
			visible: countVisibleModels(CODEX, hidden),
		}).toEqual({ shown: ['gpt-6.1-sol', 'gpt-6.1-mini'], visible: 2 });
	});

	test('一覧が入れ替わって表示中が 0 になったら、隠す設定を無視して全部出す', () => {
		expect(choices(pickerModelChoices(CODEX, ['gpt-6.1-sol', 'gpt-6.1', 'gpt-6.1-mini'], 'gpt-6.1'))).toEqual(['gpt-6.1-sol', 'gpt-6.1', 'gpt-6.1-mini']);
	});

	test('仮に選んでいるモデルを隠しても、「非表示」として残す', () => {
		expect(choices(pickerModelChoices(CODEX, ['gpt-6.1'], 'gpt-6.1-mini', 'gpt-6.1'))).toEqual(['gpt-6.1-sol', 'gpt-6.1 (hidden)', 'gpt-6.1-mini']);
	});

	test('Claude の固定の予備表にも同じ id で効く', () => {
		expect(choices(pickerModelChoices(agentModelOptions('claude'), ['haiku', 'fable'], 'opus'))).toEqual(['opus', 'sonnet']);
	});
});

describe('最後の 1 つ', () => {
	test('表示中が 1 つだけなら隠せない。使用中でも隠していれば数に入れない', () => {
		expect([
			canHideModel(CODEX, ['gpt-6.1'], 'gpt-6.1-sol'),
			canHideModel(CODEX, ['gpt-6.1', 'gpt-6.1-mini'], 'gpt-6.1-sol'),
			canHideModel(CODEX, ['gpt-6.1', 'gpt-6.1-mini'], 'gpt-6.1-mini'),
			canHideModel(CODEX, [], 'not-in-list'),
		]).toEqual([true, false, false, false]);
	});
});

describe('シートの初期選択', () => {
	const select = (hidden: string[], options: { pickedId?: string; currentId?: string; defaultId?: string; fallbackToFirst?: boolean }) => {
		const shown = pickerModelChoices(CODEX, hidden, options.currentId, options.pickedId).map(choice => choice.option);
		return initialModelSelection(shown, {
			pickedId: options.pickedId,
			currentId: options.currentId,
			defaultId: options.defaultId,
			fallbackToFirst: options.fallbackToFirst ?? true,
		})?.id;
	};

	test('選んだもの（隠していても） → 使用中 → 表示中の既定 → 表示中の先頭', () => {
		expect([
			select([], { pickedId: 'gpt-6.1', currentId: 'gpt-6.1-mini', defaultId: 'gpt-6.1-sol' }),
			select(['gpt-6.1-mini'], { currentId: 'gpt-6.1-mini', defaultId: 'gpt-6.1-sol' }),
			select([], { defaultId: 'gpt-6.1-sol' }),
			select(['gpt-6.1-sol'], { defaultId: 'gpt-6.1-sol' }),
			select(['gpt-6.1'], { pickedId: 'gpt-6.1', defaultId: 'gpt-6.1-sol' }),
		]).toEqual(['gpt-6.1', 'gpt-6.1-mini', 'gpt-6.1-sol', 'gpt-6.1', 'gpt-6.1']);
	});

	test('先頭へ落とさない指定（Claude）では、使用中が分からなければ何も選ばない', () => {
		expect(initialModelSelection(CODEX, { pickedId: undefined, currentId: undefined, defaultId: undefined, fallbackToFirst: false })).toBeUndefined();
	});
});
