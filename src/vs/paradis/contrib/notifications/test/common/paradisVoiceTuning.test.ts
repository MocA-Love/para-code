/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentDictionaryRequestFromSettings, paradisNormalizeAgentDictionaryRequest } from '../../common/paradisAgentDictionary.js';
import {
	paradisElevenLabsModelIgnoresSpeed,
	paradisElevenLabsVoiceSettingsBody,
	paradisIsElevenLabsV3Model,
	paradisNormalizeVoiceTuningMap,
	paradisPlanAllVoiceTuningSteps,
	paradisToElevenLabsSavedVoiceTuning,
	paradisVoiceTuningArgs,
	paradisVoiceTuningFromConfig,
} from '../../common/paradisVoiceTuning.js';

suite('paradisVoiceTuning', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds voice_settings only with the values the voice has, rounding stability to three steps on v3', () => {
		assert.deepStrictEqual([
			paradisElevenLabsVoiceSettingsBody('eleven_v4_turbo', 1, undefined),
			paradisElevenLabsVoiceSettingsBody('eleven_v4_turbo', 1, { stability: 0.37, similarityBoost: 0.8 }),
			paradisElevenLabsVoiceSettingsBody('eleven_flash_v2_5', 0.9, { similarityBoost: 2 }),
			paradisElevenLabsVoiceSettingsBody('eleven_v3', 1, { stability: 0.2 }),
			paradisElevenLabsVoiceSettingsBody('eleven_v3', 1, { stability: 0.25 }),
			paradisElevenLabsVoiceSettingsBody('eleven_v3', 1, { stability: 0.8, similarityBoost: 0.55 }),
		], [
			{ speed: 1 },
			{ speed: 1, stability: 0.35, similarity_boost: 0.8 },
			{ speed: 0.9, similarity_boost: 1 },
			{ speed: 1, stability: 0 },
			{ speed: 1, stability: 0.5 },
			{ speed: 1, stability: 1, similarity_boost: 0.55 },
		]);
	});

	test('tells the model families apart and reads the saved settings of a voice', () => {
		assert.deepStrictEqual({
			v3: ['eleven_v3', 'eleven_v3_alpha', 'eleven_v30', 'eleven_v4_turbo'].map(paradisIsElevenLabsV3Model),
			speedIgnored: ['eleven_v4', 'eleven_v4_turbo', 'eleven_v40', 'eleven_v3', 'eleven_flash_v2_5'].map(paradisElevenLabsModelIgnoresSpeed),
			saved: paradisToElevenLabsSavedVoiceTuning({ stability: 0.42, similarity_boost: 1.4, style: 0, speed: 1 }),
			savedEmpty: paradisToElevenLabsSavedVoiceTuning(null),
		}, {
			v3: [true, true, false, false],
			speedIgnored: [true, true, false, false, false],
			saved: { stability: 0.42, similarityBoost: 1 },
			savedEmpty: {},
		});
	});

	test('normalizes stored values and carries them in the agent request', () => {
		const map = paradisNormalizeVoiceTuningMap({ voiceA: { stability: 0.512, similarityBoost: 'x' }, 'bad id': { stability: 1 }, voiceB: {}, voiceC: { similarityBoost: -1 } });
		assert.deepStrictEqual({
			map,
			fromSettings: paradisAgentDictionaryRequestFromSettings({ shareDictionaryWithAgents: true, elevenLabsVoiceSettings: map }),
			fromSettingsEmpty: paradisAgentDictionaryRequestFromSettings({ elevenLabsVoiceSettings: {} }),
			normalized: paradisNormalizeAgentDictionaryRequest({ enabled: true, dictionaries: {}, voiceSettings: { 'a"b': { stability: 1 }, v1: { stability: 0.3 } } }),
			// aivis-mcp が拒む名前（Object の性質の名前）は声として扱わない
			reserved: Object.keys(paradisNormalizeVoiceTuningMap(JSON.parse('{"__proto__":{"stability":1},"constructor":{"stability":1},"prototype":{"stability":1},"v1":{"stability":1}}'))),
		}, {
			map: { voiceA: { stability: 0.5 }, voiceC: { similarityBoost: 0 } },
			fromSettings: { enabled: true, dictionaries: { elevenlabs: '', aivis: '' }, voiceSettings: { voiceA: { stability: 0.5 }, voiceC: { similarityBoost: 0 } } },
			fromSettingsEmpty: { enabled: true, dictionaries: { elevenlabs: '', aivis: '' } },
			normalized: { enabled: true, dictionaries: { elevenlabs: '', aivis: '' }, voiceSettings: { v1: { stability: 0.3 } } },
			reserved: ['v1'],
		});
	});

	test('reads the voice settings in the aivis-mcp config without rounding them', () => {
		assert.deepStrictEqual([
			paradisVoiceTuningFromConfig({ elevenlabs: { voiceSettings: { v1: { stability: 0.51, similarityBoost: 0.75 }, v2: { stability: 3 } } } }),
			paradisVoiceTuningFromConfig({}),
			paradisVoiceTuningFromConfig(null),
		], [
			{ v1: { stability: 0.51, similarityBoost: 0.75 } },
			{},
			{},
		]);
	});

	test('plans the aivis-mcp steps: skips the same value, clears only what Para Code wrote, clears leftovers first', () => {
		const desired = { v1: { stability: 0.5, similarityBoost: 0.75 }, v2: { stability: 0.3 }, v3: { similarityBoost: 0.9 } };
		const written = { v1: { stability: 0.5, similarityBoost: 0.75 }, v4: { stability: 0.2 }, v5: { stability: 0.6 } };
		const current = { v3: { stability: 0.4, similarityBoost: 0.1 }, v4: { stability: 0.2 }, v5: { stability: 0.9 } };
		assert.deepStrictEqual({
			on: paradisPlanAllVoiceTuningSteps(true, desired, written, current),
			// オフにすると、書いた値がそのまま残っている声だけ消す（v1 は aivis-mcp 側に無いので忘れる）
			off: paradisPlanAllVoiceTuningSteps(false, desired, written, current),
			// aivis-mcp の設定が読めなければ消さない
			unreadable: paradisPlanAllVoiceTuningSteps(false, desired, written, undefined),
		}, {
			on: [
				{ kind: 'set', voiceId: 'v2', tuning: { stability: 0.3 } },
				{ kind: 'clear', voiceId: 'v3' },
				{ kind: 'set', voiceId: 'v3', tuning: { similarityBoost: 0.9 } },
				{ kind: 'clear', voiceId: 'v4' },
				{ kind: 'forget', voiceId: 'v5' },
			],
			off: [
				{ kind: 'forget', voiceId: 'v1' },
				{ kind: 'clear', voiceId: 'v4' },
				{ kind: 'forget', voiceId: 'v5' },
			],
			unreadable: [],
		});
	});

	test('builds the aivis-mcp arguments', () => {
		assert.deepStrictEqual([
			paradisVoiceTuningArgs({ kind: 'set', voiceId: 'v_1-A', tuning: { stability: 0.5, similarityBoost: 0.75 } }),
			paradisVoiceTuningArgs({ kind: 'set', voiceId: 'v1', tuning: { similarityBoost: 1 } }),
			paradisVoiceTuningArgs({ kind: 'set', voiceId: 'v1', tuning: {} }),
			paradisVoiceTuningArgs({ kind: 'clear', voiceId: 'v1' }),
			paradisVoiceTuningArgs({ kind: 'forget', voiceId: 'v1' }),
			paradisVoiceTuningArgs({ kind: 'clear', voiceId: 'v 1;' }),
			paradisVoiceTuningArgs({ kind: 'clear', voiceId: '--stability' }),
			paradisVoiceTuningArgs({ kind: 'clear', voiceId: 'constructor' }),
		], [
			['--set-voice-settings', '--voice', 'v_1-A', '--stability', '0.5', '--similarity', '0.75'],
			['--set-voice-settings', '--voice', 'v1', '--similarity', '1'],
			undefined,
			['--clear-voice-settings', '--voice', 'v1'],
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});
});
