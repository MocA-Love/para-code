/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAivisSupportsPlayAudio, paradisLooksLikeMp3 } from '../../common/paradisRemoteVoice.js';
import { IParadisLocalVoicePlayOptions, ParadisLocalVoicePlayer, ParadisVoiceProcessRunner } from '../../node/paradisLocalVoicePlayer.js';

/** ID3 で始まる見本の MP3（末尾の 1 バイトで見分ける）。 */
function mp3(id: number): Uint8Array {
	return new Uint8Array([0x49, 0x44, 0x33, 0x04, id]);
}

function options(deadline = Number.MAX_SAFE_INTEGER, signal = new AbortController().signal): IParadisLocalVoicePlayOptions {
	return { signal, deadline };
}

suite('ParadisLocalVoicePlayer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the aivis-mcp version', () => {
		assert.deepStrictEqual(
			['aivis-mcp v2.4.0', 'aivis-mcp v2.10.1\n', 'aivis-mcp v3.0.0', 'aivis-mcp v2.3.9', 'aivis-mcp v1.99.99', 'unknown'].map(paradisAivisSupportsPlayAudio),
			[true, true, true, false, false, false],
		);
		assert.deepStrictEqual(
			[mp3(1), new Uint8Array([0xff, 0xfb, 0x90, 0x00]), new Uint8Array([0x3c, 0x68, 0x74, 0x6d]), new Uint8Array([0xff])].map(paradisLooksLikeMp3),
			[true, true, false, false],
		);
	});

	test('enqueues in arrival order and skips old aivis-mcp', async () => {
		const calls: string[] = [];
		let version = 'aivis-mcp v2.3.0';
		let now = 0;
		const runner: ParadisVoiceProcessRunner = async (args, _env, stdin) => {
			calls.push(args[0] === '--version' ? 'version' : `play:${stdin?.[4]}`);
			return args[0] === '--version' ? { code: 0, stdout: version } : { code: 0, stdout: 'queued\n' };
		};
		const player = new ParadisLocalVoicePlayer(async () => ({}), runner, () => now);

		const old = await player.play(mp3(1), options());
		version = 'aivis-mcp v2.4.0';
		// 古い版だった結果は 1 分覚えている
		const stillOld = await player.play(mp3(2), options());
		now = 61_000;
		const results = await Promise.all([player.play(mp3(3), options()), player.play(mp3(4), options())]);

		assert.deepStrictEqual({ old, stillOld, results, calls }, {
			old: false,
			stillOld: false,
			results: [true, true],
			calls: ['version', 'version', 'play:3', 'play:4'],
		});
	});

	test('reports failure when aivis-mcp is missing or fails', async () => {
		let fail: 'missing' | 'exit' = 'missing';
		const runner: ParadisVoiceProcessRunner = async args => {
			if (fail === 'missing') {
				throw new Error('ENOENT');
			}
			return args[0] === '--version' ? { code: 0, stdout: 'aivis-mcp v2.4.0' } : { code: 1, stdout: '' };
		};
		let now = 0;
		const player = new ParadisLocalVoicePlayer(async () => ({}), runner, () => now);
		const missing = await player.play(mp3(1), options());
		fail = 'exit';
		now = 61_000;
		const exited = await player.play(mp3(2), options());
		assert.deepStrictEqual({ missing, exited }, { missing: false, exited: false });
	});

	test('does not enqueue past the deadline, after abort, or non-MP3 bytes', async () => {
		const calls: string[] = [];
		const runner: ParadisVoiceProcessRunner = async args => {
			calls.push(args[0]);
			return args[0] === '--version' ? { code: 0, stdout: 'aivis-mcp v2.4.0' } : { code: 0, stdout: 'queued' };
		};
		const player = new ParadisLocalVoicePlayer(async () => ({}), runner, () => 100);
		const aborted = new AbortController();
		aborted.abort();
		const results = [
			await player.play(mp3(1), options(100)),
			await player.play(mp3(2), options(undefined, aborted.signal)),
			await player.play(new Uint8Array([0x3c, 0x68, 0x74, 0x6d]), options()),
			// 終了コードが 0 でも、積めた印が無ければ積めていない
			await new ParadisLocalVoicePlayer(async () => ({}), async args => args[0] === '--version' ? { code: 0, stdout: 'aivis-mcp v2.4.0' } : { code: 0, stdout: '' }).play(mp3(3), options()),
		];
		assert.deepStrictEqual({ results, calls }, { results: [false, false, false, false], calls: [] });
	});

	test('refuses to queue more than the pending limit', async () => {
		let release: () => void = () => { };
		const gate = new Promise<void>(resolve => { release = resolve; });
		const runner: ParadisVoiceProcessRunner = async args => {
			if (args[0] === '--version') {
				return { code: 0, stdout: 'aivis-mcp v2.4.0' };
			}
			await gate;
			return { code: 0, stdout: 'queued' };
		};
		const player = new ParadisLocalVoicePlayer(async () => ({}), runner);
		const queued = [1, 2, 3, 4].map(id => player.play(mp3(id), options()));
		const overflow = await player.play(mp3(5), options());
		release();
		assert.deepStrictEqual({ overflow, queued: await Promise.all(queued) }, { overflow: false, queued: [true, true, true, true] });
	});
});
