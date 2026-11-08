/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisParseSpeechHelperLine, paradisSpeechEngineAvailability, paradisSpeechEngineUnavailableMessage, paradisSpeechHelperLocale } from '../../common/paradisSpeechEngine.js';

suite('Paradis speech engine (common)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('is available on macOS 26 (Darwin 25) and later only', () => {
		assert.deepStrictEqual({
			sequoia: paradisSpeechEngineAvailability('darwin', '24.6.0'),
			tahoe: paradisSpeechEngineAvailability('darwin', '25.0.0'),
			later: paradisSpeechEngineAvailability('darwin', '26.1.0'),
			garbage: paradisSpeechEngineAvailability('darwin', ''),
			windows: paradisSpeechEngineAvailability('win32', '10.0.26100'),
			linux: paradisSpeechEngineAvailability('linux', '7.0.0'),
			messages: [paradisSpeechEngineUnavailableMessage('available'), typeof paradisSpeechEngineUnavailableMessage('macOSTooOld'), typeof paradisSpeechEngineUnavailableMessage('unsupportedPlatform')],
		}, {
			sequoia: 'macOSTooOld',
			tahoe: 'available',
			later: 'available',
			garbage: 'macOSTooOld',
			windows: 'unsupportedPlatform',
			linux: 'unsupportedPlatform',
			messages: [undefined, 'string', 'string'],
		});
	});

	test('passes the upstream language through and leaves automatic to the helper', () => {
		assert.deepStrictEqual(['ja-JP', 'auto', 'AUTO', '', undefined, ' en-US '].map(paradisSpeechHelperLocale), ['ja-JP', 'auto', 'auto', 'auto', 'auto', 'en-US']);
	});

	test('reads the helper lines and skips anything malformed', () => {
		assert.deepStrictEqual([
			'{"type":"status","state":"downloading","progress":1.5}',
			'{"type":"status","state":"loading"}',
			'{"type":"status","state":"sleeping"}',
			'{"type":"ready","locale":"ja-JP","transcriber":"dictation"}',
			'{"type":"text","committed":"a","tentative":"b"}',
			'{"type":"text","committed":"a"}',
			'{"type":"final","text":"ab"}',
			'{"type":"error","code":"locale"}',
			'not json',
			'null',
		].map(paradisParseSpeechHelperLine), [
			{ type: 'status', state: 'downloading', progress: 1 },
			{ type: 'status', state: 'loading' },
			undefined,
			{ type: 'ready', locale: 'ja-JP', transcriber: 'dictation' },
			{ type: 'text', committed: 'a', tentative: 'b' },
			undefined,
			{ type: 'final', text: 'ab' },
			{ type: 'error', code: 'locale', message: undefined },
			undefined,
			undefined,
		]);
	});
});
