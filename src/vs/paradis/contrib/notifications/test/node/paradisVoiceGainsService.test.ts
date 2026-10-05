/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisAivisMcpRunResult } from '../../node/paradisAgentDictionarySync.js';
import { ParadisVoiceGainsService } from '../../node/paradisVoiceGainsService.js';

const LIST = JSON.stringify({ version: 1, target: -20, learnWindow: 9, minLearnSeconds: 2.5, entries: [{ key: 'elevenlabs:v1:eleven_v4_turbo', provider: 'elevenlabs', voice: 'v1', model: 'eleven_v4_turbo', gainDb: -6.8, sampleCount: 9, updatedAt: 1 }] });

/** aivis-mcp の代わり。呼ばれた引数を覚える。 */
class FakeAivisMcp {
	readonly calls: string[][] = [];
	version: string | undefined = 'aivis-mcp v2.5.4';

	readonly run = async (args: readonly string[]): Promise<IParadisAivisMcpRunResult> => {
		this.calls.push([...args]);
		switch (args[0]) {
			case '--version': return this.version === undefined ? { code: undefined, stdout: '', stderr: 'ENOENT' } : { code: 0, stdout: `${this.version}\n`, stderr: '' };
			case '--list-gains': return { code: 0, stdout: LIST, stderr: '' };
			case '--reset-gain': return args[2] === 'elevenlabs:v1:eleven_v4_turbo' ? { code: 0, stdout: 'ok\n', stderr: '' } : { code: 1, stdout: '', stderr: 'error: no such key\n' };
			case '--export-gains': return { code: 0, stdout: '{"ok":true,"written":1}', stderr: '' };
			case '--import-gains': return { code: 0, stdout: '{"ok":true,"added":1,"updated":0,"skipped":2,"evicted":0,"dropped":3}', stderr: '' };
			case '--set-gain-learning': return { code: 0, stdout: 'ok\n', stderr: '' };
		}
		return { code: 1, stdout: '', stderr: 'error: unknown' };
	};
}

suite('ParadisVoiceGainsService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;

	setup(() => {
		dir = mkdtempSync(join(tmpdir(), 'paradis-voice-gains-'));
	});

	teardown(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function create(fake: FakeAivisMcp): ParadisVoiceGainsService {
		return new ParadisVoiceGainsService({ getEnv: async () => ({}), logService: new NullLogService(), run: fake.run, platform: 'darwin' });
	}

	test('needs aivis-mcp 2.5.4 and does not run anything else on older or missing ones', async () => {
		const old = new FakeAivisMcp();
		old.version = 'aivis-mcp v2.5.3';
		const missing = new FakeAivisMcp();
		missing.version = undefined;
		assert.deepStrictEqual({
			old: await create(old).list(),
			missing: await create(missing).reset('elevenlabs:v1:eleven_v4_turbo'),
			calls: [old.calls, missing.calls],
		}, {
			old: { status: 'unsupported', version: '2.5.3' },
			missing: { status: 'unsupported', version: undefined },
			calls: [[['--version']], [['--version']]],
		});
	});

	test('lists, resets, exports, imports and sets the learning window with checked arguments', async () => {
		const fake = new FakeAivisMcp();
		const service = create(fake);
		const source = join(dir, 'in.json');
		writeFileSync(source, '{}');
		const results = {
			list: (await service.list()).status,
			reset: await service.reset('elevenlabs:v1:eleven_v4_turbo'),
			resetUnknown: await service.reset('elevenlabs:v2:eleven_v4_turbo'),
			resetBad: await service.reset('a b'),
			exported: await service.exportTo(join(dir, 'out.json')),
			exportNoFolder: await service.exportTo(join(dir, 'missing', 'out.json')),
			exportRelative: await service.exportTo('out.json'),
			imported: await service.importFrom(source, true),
			importMissing: await service.importFrom(join(dir, 'none.json'), false),
			learning: await service.setLearning(12, 3),
			learningBad: await service.setLearning(0, undefined),
		};
		assert.deepStrictEqual({ results, calls: fake.calls }, {
			results: {
				list: 'ok',
				reset: { status: 'ok', value: true },
				resetUnknown: { status: 'failed', message: 'no such key' },
				resetBad: { status: 'failed', message: 'invalid argument' },
				exported: { status: 'ok', value: 1 },
				exportNoFolder: { status: 'failed', message: 'invalid file' },
				exportRelative: { status: 'failed', message: 'invalid file' },
				imported: { status: 'ok', value: { added: 1, updated: 0, skipped: 2, evicted: 0, dropped: 3 } },
				importMissing: { status: 'failed', message: 'invalid file' },
				learning: { status: 'ok', value: true },
				learningBad: { status: 'failed', message: 'invalid argument' },
			},
			// 版は一度だけ確かめる
			calls: [
				['--version'],
				['--list-gains', '--json'],
				['--reset-gain', '--key', 'elevenlabs:v1:eleven_v4_turbo'],
				['--reset-gain', '--key', 'elevenlabs:v2:eleven_v4_turbo'],
				['--export-gains', join(dir, 'out.json'), '--json'],
				['--import-gains', source, '--overwrite', '--json'],
				['--set-gain-learning', '--window', '12', '--min-seconds', '3'],
			],
		});
	});

	test('passes a path with spaces to the aivis-mcp found on PATH without a shell', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const bin = join(dir, 'bin');
		mkdirSync(bin);
		const log = join(dir, 'args.log');
		const script = join(bin, 'aivis-mcp');
		writeFileSync(script, [
			'#!/bin/sh',
			'if [ "$1" = "--version" ]; then echo "aivis-mcp v2.5.4"; exit 0; fi',
			`for a in "$@"; do echo "$a" >> "${log}"; done`,
			'echo \'{"ok":true,"written":0}\'',
		].join('\n'));
		chmodSync(script, 0o755);
		const folder = join(dir, 'a folder; $(echo x)');
		mkdirSync(folder);
		const service = new ParadisVoiceGainsService({ getEnv: async () => ({ PATH: `${bin}:/usr/bin:/bin` }), logService: new NullLogService() });
		const result = await service.exportTo(join(folder, 'gains.json'));
		assert.deepStrictEqual({ result, args: readFileSync(log, 'utf8').trim().split('\n') }, {
			result: { status: 'ok', value: 0 },
			args: ['--export-gains', join(folder, 'gains.json'), '--json'],
		});
	});
});
