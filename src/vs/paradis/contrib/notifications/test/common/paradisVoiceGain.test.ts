/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCorrectedPlaybackVolume, paradisResolveVoiceGainDb, paradisVolumePercentToDb } from '../../common/paradisVoiceGain.js';

suite('paradisVoiceGain', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('converts the volume setting to dB and applies the gain table copy with the +8dB cap', () => {
		const round = (value: number) => Math.round(value * 10) / 10;
		assert.deepStrictEqual({
			db: [100, 50, 10, 0, 150].map(paradisVolumePercentToDb),
			gain: [
				paradisResolveVoiceGainDb('aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default'),
				paradisResolveVoiceGainDb('elevenlabs:unknown:eleven_v4_turbo'),
				paradisResolveVoiceGainDb('openai:x:y'),
				paradisResolveVoiceGainDb('elevenlabs:a:b', { entries: { 'elevenlabs:a:b': 12 }, defaultDb: 0 }),
			],
			playback: [
				round(paradisCorrectedPlaybackVolume(100, 'aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default')),
				round(paradisCorrectedPlaybackVolume(50, 'elevenlabs:p2RZwE9UMQp5xjKPWM5c:eleven_flash_v2_5')),
				paradisCorrectedPlaybackVolume(0, undefined),
			],
		}, {
			db: [0, -6, -20, undefined, 0],
			gain: [4.1, -1.1, 0, 8],
			playback: [160.3, 14.1, 0],
		});
	});
});
