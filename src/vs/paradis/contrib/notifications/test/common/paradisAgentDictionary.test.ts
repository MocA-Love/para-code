/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisAgentDictionaryRequest,
	paradisAgentDictionaryArgs,
	paradisAgentDictionaryFromConfig,
	paradisAgentDictionaryRequestFromSettings,
	paradisNormalizeAgentDictionaryRequest,
	paradisPlanAgentDictionarySteps,
} from '../../common/paradisAgentDictionary.js';

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function request(enabled: boolean, elevenlabs = '', aivis = ''): IParadisAgentDictionaryRequest {
	return { enabled, dictionaries: { elevenlabs, aivis } };
}

suite('paradisAgentDictionary', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds the aivis-mcp arguments and refuses ids aivis-mcp would reject', () => {
		assert.deepStrictEqual([
			paradisAgentDictionaryArgs({ kind: 'set', provider: 'elevenlabs', id: 'dict_A-1' }),
			paradisAgentDictionaryArgs({ kind: 'set', provider: 'aivis', id: UUID_A }),
			paradisAgentDictionaryArgs({ kind: 'clear', provider: 'elevenlabs' }),
			paradisAgentDictionaryArgs({ kind: 'clear', provider: 'aivis' }),
			paradisAgentDictionaryArgs({ kind: 'forget', provider: 'aivis' }),
			paradisAgentDictionaryArgs({ kind: 'set', provider: 'aivis', id: 'not-a-uuid' }),
			paradisAgentDictionaryArgs({ kind: 'set', provider: 'elevenlabs', id: 'a b" & c' }),
		], [
			['--set-dictionary', '--provider', 'elevenlabs', '--id', 'dict_A-1'],
			['--set-dictionary', '--provider', 'aivis', '--id', UUID_A],
			['--clear-dictionary', '--provider', 'elevenlabs'],
			['--clear-dictionary', '--provider', 'aivis'],
			undefined,
			undefined,
			undefined,
		]);
	});

	test('sets a new dictionary, but not again when it was already written or is already in aivis-mcp', () => {
		assert.deepStrictEqual({
			fresh: paradisPlanAgentDictionarySteps(request(true, 'el1', UUID_A), {}, {}),
			changed: paradisPlanAgentDictionarySteps(request(true, 'el2'), { elevenlabs: 'el1' }, { elevenlabs: 'el1' }),
			sameAsWritten: paradisPlanAgentDictionarySteps(request(true, 'el1', UUID_A), { elevenlabs: 'el1', aivis: UUID_A }, { elevenlabs: 'el1', aivis: UUID_A }),
			// 書いた後で利用者が aivis-mcp 側を変えた: 同じ設定のままなら上書きしない
			userChangedAfterWrite: paradisPlanAgentDictionarySteps(request(true, 'el1'), { elevenlabs: 'el1' }, { elevenlabs: 'other' }),
			alreadyInAivisMcp: paradisPlanAgentDictionarySteps(request(true, '', UUID_A), {}, { aivis: UUID_A }),
			invalidId: paradisPlanAgentDictionarySteps(request(true, '', 'bad'), {}, {}),
		}, {
			fresh: [{ kind: 'set', provider: 'elevenlabs', id: 'el1' }, { kind: 'set', provider: 'aivis', id: UUID_A }],
			changed: [{ kind: 'set', provider: 'elevenlabs', id: 'el2' }],
			sameAsWritten: [],
			userChangedAfterWrite: [],
			alreadyInAivisMcp: [],
			invalidId: [],
		});
	});

	test('clears only what Para Code wrote when turned off or when the dictionary is removed', () => {
		assert.deepStrictEqual({
			offAndUnchanged: paradisPlanAgentDictionarySteps(request(false, 'el1', UUID_A), { elevenlabs: 'el1', aivis: UUID_A }, { elevenlabs: 'el1', aivis: UUID_A }),
			offButUserPickedAnother: paradisPlanAgentDictionarySteps(request(false, 'el1', UUID_A), { elevenlabs: 'el1', aivis: UUID_A }, { elevenlabs: 'el1', aivis: UUID_B }),
			offNothingWritten: paradisPlanAgentDictionarySteps(request(false, 'el1', UUID_A), {}, { elevenlabs: 'el1', aivis: UUID_A }),
			dictionaryRemoved: paradisPlanAgentDictionarySteps(request(true, '', UUID_A), { elevenlabs: 'el1', aivis: UUID_A }, { elevenlabs: 'el1', aivis: UUID_A }),
			configUnreadable: paradisPlanAgentDictionarySteps(request(false), { aivis: UUID_A }, undefined),
		}, {
			offAndUnchanged: [{ kind: 'clear', provider: 'elevenlabs' }, { kind: 'clear', provider: 'aivis' }],
			offButUserPickedAnother: [{ kind: 'clear', provider: 'elevenlabs' }, { kind: 'forget', provider: 'aivis' }],
			offNothingWritten: [],
			dictionaryRemoved: [{ kind: 'clear', provider: 'elevenlabs' }],
			configUnreadable: [],
		});
	});

	test('reads the settings, the IPC request and the aivis-mcp config defensively', () => {
		assert.deepStrictEqual({
			defaultOn: paradisAgentDictionaryRequestFromSettings({ userDictionaryUuid: UUID_A, elevenLabsDictionaryId: 'el1' }),
			off: paradisAgentDictionaryRequestFromSettings({ shareDictionaryWithAgents: false, userDictionaryUuid: '', elevenLabsDictionaryId: '' }),
			normalized: paradisNormalizeAgentDictionaryRequest({ enabled: 'yes', dictionaries: { elevenlabs: ' el1 ', aivis: 3 } }),
			broken: paradisNormalizeAgentDictionaryRequest(null),
			config: paradisAgentDictionaryFromConfig({ elevenlabs: { pronunciationDictionaryId: 'el1', pronunciationDictionaryVersionId: 'v' }, aivis: { userDictionaryUuid: '' } }),
			configBroken: paradisAgentDictionaryFromConfig('x'),
		}, {
			defaultOn: { enabled: true, dictionaries: { elevenlabs: 'el1', aivis: UUID_A } },
			off: { enabled: false, dictionaries: { elevenlabs: '', aivis: '' } },
			normalized: { enabled: false, dictionaries: { elevenlabs: 'el1', aivis: '' } },
			broken: { enabled: false, dictionaries: { elevenlabs: '', aivis: '' } },
			config: { elevenlabs: 'el1' },
			configBroken: {},
		});
	});
});
