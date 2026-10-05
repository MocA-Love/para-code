/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisAivisMcpErrorMessage,
	paradisExportVoiceGainsArgs,
	paradisImportVoiceGainsArgs,
	paradisIsInitialVoiceGain,
	paradisIsSafeAivisMcpPath,
	paradisParseVoiceGainExport,
	paradisParseVoiceGainImport,
	paradisParseVoiceGainList,
	paradisResetVoiceGainArgs,
	paradisSetGainLearningArgs,
	paradisVoiceGainProgress,
} from '../../common/paradisVoiceGains.js';

suite('paradisVoiceGains', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the --list-gains output and drops rows with a broken key', () => {
		const stdout = JSON.stringify({
			version: 1, target: -20, learnWindow: 9, minLearnSeconds: 2.5, entries: [
				{ key: 'elevenlabs:voiceA:eleven_v4_turbo', provider: 'elevenlabs', voice: 'voiceA', model: 'eleven_v4_turbo', gainDb: -6.8, sampleCount: 12, updatedAt: 1759600000000 },
				{ key: 'aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default', gainDb: 4.5, sampleCount: 3 },
				{ key: 'broken key', gainDb: 1, sampleCount: 1 },
				{ key: 'elevenlabs:voiceB:eleven_v3', gainDb: 'x', sampleCount: -2 },
				{ key: 'custom:a:b:m', gainDb: 0.5, sampleCount: 0, updatedAt: null, extra: true },
				{ key: 'x'.repeat(299) + '::', gainDb: 0, sampleCount: 0, updatedAt: null },
				{ key: 'nocolon', gainDb: 0, sampleCount: 0, updatedAt: null },
			],
		});
		assert.deepStrictEqual({
			list: paradisParseVoiceGainList(stdout),
			defaults: paradisParseVoiceGainList('{"entries":[]}'),
			broken: [paradisParseVoiceGainList('not json'), paradisParseVoiceGainList('{"entries":1}'), paradisParseVoiceGainList('[]')],
		}, {
			list: {
				target: -20, learnWindow: 9, minLearnSeconds: 2.5, entries: [
					{ key: 'elevenlabs:voiceA:eleven_v4_turbo', provider: 'elevenlabs', voice: 'voiceA', model: 'eleven_v4_turbo', gainDb: -6.8, sampleCount: 12, updatedAt: 1759600000000 },
					{ key: 'aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default', provider: 'aivis', voice: 'a670e6b8-0852-45b2-8704-1bc9862f2fe6', model: 'default', gainDb: 4.5, sampleCount: 3, updatedAt: undefined },
					{ key: 'elevenlabs:voiceB:eleven_v3', provider: 'elevenlabs', voice: 'voiceB', model: 'eleven_v3', gainDb: undefined, sampleCount: 0, updatedAt: undefined },
					// aivis-mcp と同じく最初と最後の `:` で分ける
					{ key: 'custom:a:b:m', provider: 'custom', voice: 'a:b', model: 'm', gainDb: 0.5, sampleCount: 0, updatedAt: undefined },
				],
			},
			defaults: { target: undefined, learnWindow: 9, minLearnSeconds: 2.5, entries: [] },
			broken: [undefined, undefined, undefined],
		});
	});

	test('reads the export and import results', () => {
		assert.deepStrictEqual([
			paradisParseVoiceGainExport('{"ok":true,"written":7}\n'),
			paradisParseVoiceGainExport('{"ok":false}'),
			paradisParseVoiceGainImport('{"ok":true,"added":2,"updated":1,"skipped":3,"evicted":0,"dropped":4,"future":1}'),
			paradisParseVoiceGainImport('{"ok":true,"added":2,"updated":1,"skipped":3,"evicted":0}'),
			paradisParseVoiceGainImport('ok'),
			paradisAivisMcpErrorMessage('error: file not found\nmore'),
		], [
			7,
			undefined,
			{ added: 2, updated: 1, skipped: 3, evicted: 0, dropped: 4 },
			{ added: 2, updated: 1, skipped: 3, evicted: 0, dropped: 0 },
			undefined,
			'file not found',
		]);
	});

	test('builds the arguments and refuses what aivis-mcp must not receive', () => {
		assert.deepStrictEqual({
			reset: [
				paradisResetVoiceGainArgs('elevenlabs:voiceA:eleven_v4_turbo'),
				paradisResetVoiceGainArgs('elevenlabs:a b:m'),
				paradisResetVoiceGainArgs('--key'),
				paradisResetVoiceGainArgs('-x:v:m'),
				paradisResetVoiceGainArgs(`a:${'v'.repeat(196)}:m`),
				paradisResetVoiceGainArgs(`a:${'v'.repeat(197)}:m`),
			],
			export: [paradisExportVoiceGainsArgs('/Users/example/gains file.json', 'darwin'), paradisExportVoiceGainsArgs('gains.json', 'darwin')],
			import: [
				paradisImportVoiceGainsArgs('/tmp/g.json', false, 'linux'),
				paradisImportVoiceGainsArgs('C:\\Users\\example\\g.json', true, 'win32'),
				paradisImportVoiceGainsArgs('C:\\a&b\\g.json', true, 'win32'),
				paradisImportVoiceGainsArgs('/tmp/g.json', true, 'win32'),
			],
			learning: [
				paradisSetGainLearningArgs(12, 3),
				paradisSetGainLearningArgs(9, undefined),
				paradisSetGainLearningArgs(undefined, 0.5),
				paradisSetGainLearningArgs(undefined, undefined),
				paradisSetGainLearningArgs(51, undefined),
				paradisSetGainLearningArgs(2.5, undefined),
				paradisSetGainLearningArgs(undefined, 0.4),
			],
			paths: [paradisIsSafeAivisMcpPath('/a\nb', 'darwin'), paradisIsSafeAivisMcpPath('', 'darwin')],
		}, {
			reset: [
				['--reset-gain', '--key', 'elevenlabs:voiceA:eleven_v4_turbo'],
				undefined,
				undefined,
				undefined,
				['--reset-gain', '--key', `a:${'v'.repeat(196)}:m`],
				undefined,
			],
			export: [['--export-gains', '/Users/example/gains file.json', '--json'], undefined],
			import: [
				['--import-gains', '/tmp/g.json', '--json'],
				['--import-gains', 'C:\\Users\\example\\g.json', '--overwrite', '--json'],
				undefined,
				undefined,
			],
			learning: [
				['--set-gain-learning', '--window', '12', '--min-seconds', '3'],
				['--set-gain-learning', '--window', '9'],
				['--set-gain-learning', '--min-seconds', '0.5'],
				undefined,
				undefined,
				undefined,
				undefined,
			],
			paths: [false, false],
		});
	});

	test('shows the learning progress up to the window', () => {
		assert.deepStrictEqual([
			paradisIsInitialVoiceGain({ sampleCount: 0, updatedAt: undefined }),
			paradisIsInitialVoiceGain({ sampleCount: 0, updatedAt: 1 }),
			paradisVoiceGainProgress({ sampleCount: 12 }, 9),
			paradisVoiceGainProgress({ sampleCount: 3 }, 9),
			paradisVoiceGainProgress({ sampleCount: 0 }, 0),
		], [
			true,
			false,
			{ done: 9, learning: false },
			{ done: 3, learning: true },
			{ done: 0, learning: true },
		]);
	});
});
