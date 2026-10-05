/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisAgentDictionaryCurrent } from '../../common/paradisAgentDictionary.js';
import { IParadisAivisMcpRunResult, ParadisAgentDictionarySyncService, paradisRunAivisMcp } from '../../node/paradisAgentDictionarySync.js';

const UUID_A = '11111111-2222-4333-8444-555555555555';

/** aivis-mcp の代わり。呼ばれた引数を覚え、`--set-dictionary` / `--clear-dictionary` で設定（current）を書き換える。 */
class FakeAivisMcp {
	readonly calls: string[][] = [];
	version: string | undefined = 'aivis-mcp v2.5.3';
	current: IParadisAgentDictionaryCurrent = {};
	fail = false;

	readonly run = async (args: readonly string[]): Promise<IParadisAivisMcpRunResult> => {
		this.calls.push([...args]);
		if (args[0] === '--version') {
			return this.version === undefined ? { code: undefined, stdout: '', stderr: 'ENOENT' } : { code: 0, stdout: `${this.version}\n`, stderr: '' };
		}
		if (this.fail) {
			return { code: 1, stdout: '', stderr: 'error: lock' };
		}
		const provider = args[2] as 'elevenlabs' | 'aivis';
		const next = { ...this.current };
		if (args[0] === '--set-dictionary') {
			next[provider] = args[4];
		} else {
			delete next[provider];
		}
		this.current = next;
		return { code: 0, stdout: 'ok\n', stderr: '' };
	};
}

suite('ParadisAgentDictionarySyncService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let statePath: string;

	setup(() => {
		dir = mkdtempSync(join(tmpdir(), 'paradis-agent-dict-'));
		statePath = join(dir, 'state', 'agent-dictionary.json');
	});

	teardown(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function create(fake: FakeAivisMcp): ParadisAgentDictionarySyncService {
		return new ParadisAgentDictionarySyncService({
			getEnv: async () => ({}),
			logService: new NullLogService(),
			run: fake.run,
			readCurrent: async () => fake.current,
			statePath,
		});
	}

	test('sets once, skips the same value, and clears only what it wrote when turned off', async () => {
		const fake = new FakeAivisMcp();
		const service = create(fake);
		const on = { enabled: true, dictionaries: { elevenlabs: 'el1', aivis: UUID_A } };
		const first = await service.apply(on);
		const again = await service.apply(on);
		// 利用者が aivis-mcp 側で Aivis の辞書を外した後にオフにする: Aivis は触らない
		fake.current = { elevenlabs: 'el1' };
		const off = await service.apply({ enabled: false, dictionaries: on.dictionaries });
		assert.deepStrictEqual({
			statuses: [first.status, again.status, off.status],
			calls: fake.calls,
			current: fake.current,
			state: JSON.parse(readFileSync(statePath, 'utf8')),
		}, {
			statuses: ['applied', 'unchanged', 'applied'],
			calls: [
				['--version'],
				['--set-dictionary', '--provider', 'elevenlabs', '--id', 'el1'],
				['--set-dictionary', '--provider', 'aivis', '--id', UUID_A],
				['--version'],
				['--clear-dictionary', '--provider', 'elevenlabs'],
			],
			current: {},
			state: {},
		});
	});

	test('does nothing with aivis-mcp 2.5.2 or without aivis-mcp, and keeps nothing when the command fails', async () => {
		const request = { enabled: true, dictionaries: { elevenlabs: 'el1', aivis: '' } };
		const old = new FakeAivisMcp();
		old.version = 'aivis-mcp v2.5.2';
		const missing = new FakeAivisMcp();
		missing.version = undefined;
		const failing = new FakeAivisMcp();
		failing.fail = true;
		const results = [
			(await create(old).apply(request)).status,
			(await create(missing).apply(request)).status,
			(await create(failing).apply(request)).status,
		];
		assert.deepStrictEqual({
			results,
			calls: [old.calls, missing.calls, failing.calls],
			stateWritten: JSON.parse(readFileSync(statePath, 'utf8')),
		}, {
			results: ['unsupported', 'unsupported', 'failed'],
			calls: [[['--version']], [['--version']], [['--version'], ['--set-dictionary', '--provider', 'elevenlabs', '--id', 'el1']]],
			stateWritten: {},
		});
	});

	test('runs the aivis-mcp found on PATH with fixed arguments', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const bin = join(dir, 'bin');
		const log = join(dir, 'calls.log');
		const config = join(dir, 'config.json');
		rmSync(bin, { recursive: true, force: true });
		mkdirSync(bin);
		const script = join(bin, 'aivis-mcp');
		writeFileSync(script, [
			'#!/bin/sh',
			'if [ "$1" = "--version" ]; then echo "aivis-mcp v2.5.3"; exit 0; fi',
			`echo "$*" >> "${log}"`,
			`if [ "$1" = "--set-dictionary" ]; then printf '{"aivis":{"userDictionaryUuid":"%s"}}' "$5" > "${config}"; else echo '{}' > "${config}"; fi`,
			'echo ok',
		].join('\n'));
		chmodSync(script, 0o755);
		const env = { PATH: `${bin}:/usr/bin:/bin`, AIVIS_CONFIG_FILE: config };
		const service = new ParadisAgentDictionarySyncService({ getEnv: async () => env, logService: new NullLogService(), statePath });
		const set = await service.apply({ enabled: true, dictionaries: { elevenlabs: '', aivis: UUID_A } });
		const cleared = await service.apply({ enabled: false, dictionaries: { elevenlabs: '', aivis: UUID_A } });
		const rejected = await paradisRunAivisMcp(['--id', 'a b'], env);
		assert.deepStrictEqual({
			statuses: [set.status, cleared.status],
			log: readFileSync(log, 'utf8').trim().split('\n'),
			config: readFileSync(config, 'utf8').trim(),
			stateExists: existsSync(statePath),
			rejected: rejected.code,
		}, {
			statuses: ['applied', 'applied'],
			log: [`--set-dictionary --provider aivis --id ${UUID_A}`, '--clear-dictionary --provider aivis'],
			config: '{}',
			stateExists: true,
			rejected: undefined,
		});
	});
});
