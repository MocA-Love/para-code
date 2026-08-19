/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains a PARA-CODE comment)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { GeneralShellType, ITerminalEnvironment, PosixShellType, WindowsShellType } from '../../../../../platform/terminal/common/terminal.js';
import { paradisRunAutoRunPresets } from '../../browser/paradisTerminalPresets.contribution.js';
import {
	IParadisPresetDefinition,
	IParadisPresetService,
	IParadisResolvedPreset,
	IParadisRunPresetOptions,
	paradisFindPresetNameConflict,
	paradisJoinPresetCommands,
	paradisPresetKey,
	paradisPresetQualifiers,
	paradisResolvePresetIndex,
	paradisUsablePresetId,
	ParadisPresetNameConflict,
	PARADIS_PROJECT_ROOT_ENV_VAR,
} from '../../common/paradisTerminalPresets.js';

const TEST_FOLDER = URI.file('/repo-worktrees/feature');

function createPreset(name: string): IParadisResolvedPreset {
	return { key: `user:${name}`, name, commands: [`run-${name}`], source: 'user', sourceIndex: 0, autoRun: true };
}

suite('paradisRunAutoRunPresets', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createInstantiationService(failingPresets: ReadonlySet<string>, partiallyStartedPresets: ReadonlySet<string> = new Set()): { instantiationService: TestInstantiationService; runs: string[]; forceNewTerminal: boolean[]; stateKeys: (string | undefined)[]; envs: (ITerminalEnvironment | undefined)[] } {
		const runs: string[] = [];
		const forceNewTerminal: boolean[] = [];
		const stateKeys: (string | undefined)[] = [];
		const envs: (ITerminalEnvironment | undefined)[] = [];
		const presets = [createPreset('first'), createPreset('second'), createPreset('third')];
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IParadisPresetService, new class extends mock<IParadisPresetService>() {
			override async getPresetsForFolder(): Promise<readonly IParadisResolvedPreset[]> {
				return presets;
			}

			override async runPreset(preset: IParadisResolvedPreset, options?: IParadisRunPresetOptions): Promise<void> {
				runs.push(preset.name);
				forceNewTerminal.push(options?.forceNewTerminal === true);
				stateKeys.push(options?.stateKey);
				envs.push(options?.env);
				if (partiallyStartedPresets.has(preset.name)) {
					options?.onDidStart?.();
				}
				if (failingPresets.has(preset.name)) {
					throw new Error(`failed: ${preset.name}`);
				}
			}
		}());
		instantiationService.stub(IDialogService, new (mock<IDialogService>())());
		instantiationService.stub(IStorageService, new (mock<IStorageService>())());
		instantiationService.stub(ILogService, new NullLogService());
		return { instantiationService, runs, forceNewTerminal, stateKeys, envs };
	}

	test('preserves partial success and continues after a preset fails', async () => {
		const { instantiationService, runs, forceNewTerminal } = createInstantiationService(new Set(['second']));

		const ranAny = await instantiationService.invokeFunction(paradisRunAutoRunPresets, TEST_FOLDER, '/repo');

		assert.deepStrictEqual({ ranAny, runs, forceNewTerminal }, {
			ranAny: true,
			runs: ['first', 'second', 'third'],
			forceNewTerminal: [true, true, true],
		});
	});

	test('returns false when every preset fails', async () => {
		const { instantiationService, runs } = createInstantiationService(new Set(['first', 'second', 'third']));

		const ranAny = await instantiationService.invokeFunction(paradisRunAutoRunPresets, TEST_FOLDER, '/repo');

		assert.deepStrictEqual({ ranAny, runs }, { ranAny: false, runs: ['first', 'second', 'third'] });
	});

	test('preserves a partial start within a failed preset', async () => {
		const { instantiationService, runs } = createInstantiationService(
			new Set(['first', 'second', 'third']),
			new Set(['second']),
		);

		const ranAny = await instantiationService.invokeFunction(paradisRunAutoRunPresets, TEST_FOLDER, '/repo');

		assert.deepStrictEqual({ ranAny, runs }, { ranAny: true, runs: ['first', 'second', 'third'] });
	});

	test('forwards the explicit stateKey to every preset run, so terminals are tagged to the target scope regardless of what is active on the PC when they finish starting', async () => {
		const { instantiationService, stateKeys } = createInstantiationService(new Set());

		await instantiationService.invokeFunction(paradisRunAutoRunPresets, TEST_FOLDER, '/repo', 'worktree:test-scope');

		assert.deepStrictEqual(stateKeys, ['worktree:test-scope', 'worktree:test-scope', 'worktree:test-scope']);
	});

	test('forwards the parent repository path to every preset run, so commands can reach the parent repository the same way setup scripts do', async () => {
		const { instantiationService, envs } = createInstantiationService(new Set());

		await instantiationService.invokeFunction(paradisRunAutoRunPresets, TEST_FOLDER, '/repo');

		assert.deepStrictEqual(envs, Array(3).fill({ [PARADIS_PROJECT_ROOT_ENV_VAR]: '/repo' }));
	});
});

suite('presets with the same name', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function resolved(definition: IParadisPresetDefinition, index: number, sourceUri?: URI): IParadisResolvedPreset {
		const source = sourceUri ? 'workspace' as const : 'user' as const;
		return { ...definition, source, sourceUri, sourceIndex: index, key: paradisPresetKey(source, sourceUri, definition, index) };
	}

	test('identifies a preset by its id, or by its position when the file carries no id', () => {
		const file = URI.file('/repo/.paracode.json');
		assert.deepStrictEqual([
			paradisPresetKey('user', undefined, { id: 'a1b2c3d4', name: 'dev', commands: ['bun dev'] }, 3),
			// 手書きのユーザー設定と .paracode.json は id を持たないので位置で識別する
			paradisPresetKey('user', undefined, { name: 'dev', commands: ['bun dev'] }, 3),
			paradisPresetKey('workspace', file, { name: 'dev', commands: ['bun dev'] }, 1),
			// 同名でも位置が違えば別のキーになる（名前は識別子ではない）
			paradisPresetKey('user', undefined, { name: 'dev', commands: ['bun dev'] }, 4),
		], ['user:a1b2c3d4', 'user:#3', 'workspace:file:///repo/.paracode.json:#1', 'user:#4']);
	});

	test('hands out a qualifier only where the same name appears more than once', () => {
		const presets = [
			resolved({ name: 'dev', commands: ['bun dev'], appliesTo: ['/Users/example/para-code'] }, 0),
			resolved({ name: 'dev', commands: ['pnpm dev'], appliesTo: ['relay'] }, 1),
			// 対象リポジトリを持たない同名は作業ディレクトリで分ける
			resolved({ name: 'test', commands: ['vitest'], cwd: './app/mobile' }, 2),
			resolved({ name: 'test', commands: ['vitest'] }, 3),
			// 単独の名前には区別語を出さない（区別が要らない場面で表示を増やさない）
			resolved({ name: 'build', commands: ['bun run build'], cwd: './app/web' }, 4),
		];
		assert.deepStrictEqual([...paradisPresetQualifiers(presets)], [
			['user:#0', 'para-code'],
			['user:#1', 'relay'],
			['user:#2', './app/mobile'],
		]);
	});

	test('classifies a name collision by whether the two can be told apart in the list', () => {
		const existing = [
			resolved({ name: 'dev', description: 'front', commands: ['bun dev'], appliesTo: ['para-code'] }, 0),
		];
		assert.deepStrictEqual([
			paradisFindPresetNameConflict({ name: 'test', commands: ['vitest'] }, existing).kind,
			// 同名でも対象リポジトリが違えば見分けが付く（並べて登録してよい）
			paradisFindPresetNameConflict({ name: 'dev', commands: ['pnpm dev'], appliesTo: ['relay'] }, existing).kind,
			// 説明が違えば見分けが付く
			paradisFindPresetNameConflict({ name: 'dev', description: 'api', commands: ['go run .'], appliesTo: ['para-code'] }, existing).kind,
			// 名前・対象リポジトリ・説明が全部同じだと一覧で区別できない
			paradisFindPresetNameConflict({ name: 'dev', description: 'front', commands: ['go run .'], appliesTo: ['para-code'] }, existing).kind,
		], [
			ParadisPresetNameConflict.None,
			ParadisPresetNameConflict.Distinguishable,
			ParadisPresetNameConflict.Distinguishable,
			ParadisPresetNameConflict.Indistinguishable,
		]);
	});

	test('treats folder as one more distinguishing value, without letting it hide or eclipse the others', () => {
		const existing = [
			resolved({ name: 'build', folder: 'Web', commands: ['bun run build'] }, 0),
		];
		assert.deepStrictEqual([
			// 同じフォルダでも cwd が違えば見分けが付く（folder が cwd を覆い隠して保存をブロックしない）
			paradisFindPresetNameConflict({ name: 'build', folder: 'Web', cwd: './frontend', commands: ['bun run build'] }, existing).kind,
			// フォルダだけ違えば見分けが付く（folder 自体も区別語として働く）
			paradisFindPresetNameConflict({ name: 'build', folder: 'Api', commands: ['bun run build'] }, existing).kind,
			// フォルダ・cwd・説明まで全部同じなら区別できない
			paradisFindPresetNameConflict({ name: 'build', folder: 'Web', commands: ['bun run build'] }, existing).kind,
		], [
			ParadisPresetNameConflict.Distinguishable,
			ParadisPresetNameConflict.Distinguishable,
			ParadisPresetNameConflict.Indistinguishable,
		]);
	});

	test('points at the preset it actually collided with, not at the first one sharing the name', () => {
		const existing = [
			resolved({ name: 'dev', commands: ['bun dev'], appliesTo: ['para-code'] }, 0),
			resolved({ name: 'dev', commands: ['pnpm dev'], appliesTo: ['relay'] }, 1),
			resolved({ name: 'dev', commands: ['go run .'] }, 2),
		];
		// 対象リポジトリ指定なしの3件目と区別が付かない。ここで先頭を置き換えると
		// 無関係な para-code 向けのプリセットが消える
		const conflict = paradisFindPresetNameConflict({ name: 'dev', commands: ['cargo run'] }, existing);
		assert.deepStrictEqual(
			{ kind: conflict.kind, sameName: conflict.sameName.length, replaces: conflict.indistinguishableFrom?.key },
			{ kind: ParadisPresetNameConflict.Indistinguishable, sameName: 3, replaces: 'user:#2' },
		);
	});

	test('refuses to resolve a position whose occupant is no longer that preset', () => {
		const dev = resolved({ name: 'dev', commands: ['bun dev'], cwd: './app/web' }, 1);
		const twin = { name: 'dev', commands: ['bun dev'], cwd: './app/mobile' };
		assert.deepStrictEqual([
			// 位置も中身も一致
			paradisResolvePresetIndex([{ name: 'other', commands: ['x'] }, { name: 'dev', commands: ['bun dev'], cwd: './app/web' }], dev),
			// 前の1件が外部で消えて位置がずれた。名前もコマンドも同じ「双子」が来ているが、
			// 作業ディレクトリが違うので当人ではない（ここで通すと無関係な1件を潰す）
			paradisResolvePresetIndex([{ name: 'other', commands: ['x'] }, twin], dev),
			// id を持つ定義は位置がずれても追える
			paradisResolvePresetIndex(
				[twin, { name: 'renamed', commands: ['bun dev'], id: 'abc123' }],
				{ ...dev, id: 'abc123' },
			),
			// 壊れたエントリがその位置に来ている
			paradisResolvePresetIndex([{ name: 'other', commands: ['x'] }, { name: '' }], dev),
		], [1, -1, 1, -1]);
	});

	test('still finds a repository preset whose file carries an appliesTo that the loader drops', () => {
		const file = URI.file('/repo/.paracode.json');
		// .paracode.json に手書きされた appliesTo は読み込み時に捨てられる（そのリポジトリ自体が
		// 対象なので意味を持たない）。突き合わせでそれを見ると、編集も削除もできなくなる
		const raw = { name: 'dev', commands: ['bun dev'], appliesTo: ['other-repo'] };
		const loaded: IParadisResolvedPreset = {
			...raw, appliesTo: undefined, source: 'workspace', sourceUri: file, sourceIndex: 0,
			key: paradisPresetKey('workspace', file, raw, 0),
		};
		assert.strictEqual(paradisResolvePresetIndex([raw], loaded), 0);
	});

	test('drops ids that cannot identify anything, so a copy-pasted entry cannot hijack its twin', () => {
		const taken = new Set<string>();
		assert.deepStrictEqual([
			paradisUsablePresetId({ name: 'a', commands: ['x'], id: 'abc123' }, taken),
			// settings.json でエントリごとコピーされた場合。2件目は位置で識別させる
			paradisUsablePresetId({ name: 'b', commands: ['x'], id: 'abc123' }, taken),
			paradisUsablePresetId({ name: 'c', commands: ['x'] }, taken),
			paradisUsablePresetId({ name: 'd', commands: ['x'], id: 5 as unknown as string }, taken),
		], ['abc123', undefined, undefined, undefined]);
	});
});

suite('paradisJoinPresetCommands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses native conditional chaining outside PowerShell', () => {
		assert.strictEqual(paradisJoinPresetCommands(['first', 'second'], PosixShellType.Bash), 'first && second');
		assert.strictEqual(paradisJoinPresetCommands(['first', 'second'], WindowsShellType.CommandPrompt), 'first && second');
	});

	test('supports Windows PowerShell 5.1 without pipeline chain operators', () => {
		assert.strictEqual(
			paradisJoinPresetCommands(['first', 'second', 'third'], GeneralShellType.PowerShell),
			'first; if ($?) { second; if ($?) { third } }',
		);
	});
});
