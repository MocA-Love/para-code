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
import { paradisRunAutoRunPresets } from '../../browser/paradisTerminalPresets.contribution.js';
import { IParadisPresetService, IParadisResolvedPreset, IParadisRunPresetOptions } from '../../common/paradisTerminalPresets.js';

const TEST_FOLDER = URI.file('/repo-worktrees/feature');

function createPreset(name: string): IParadisResolvedPreset {
	return { key: name, name, commands: [`run-${name}`], source: 'user', autoRun: true };
}

suite('paradisRunAutoRunPresets', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createInstantiationService(failingPresets: ReadonlySet<string>, partiallyStartedPresets: ReadonlySet<string> = new Set()): { instantiationService: TestInstantiationService; runs: string[]; forceNewTerminal: boolean[] } {
		const runs: string[] = [];
		const forceNewTerminal: boolean[] = [];
		const presets = [createPreset('first'), createPreset('second'), createPreset('third')];
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IParadisPresetService, new class extends mock<IParadisPresetService>() {
			override async getPresetsForFolder(): Promise<readonly IParadisResolvedPreset[]> {
				return presets;
			}

			override async runPreset(preset: IParadisResolvedPreset, options?: IParadisRunPresetOptions): Promise<void> {
				runs.push(preset.name);
				forceNewTerminal.push(options?.forceNewTerminal === true);
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
		return { instantiationService, runs, forceNewTerminal };
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
});
