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
import { IParadisElevenLabsVoiceTuning } from '../../common/paradisVoiceTuning.js';
import { IParadisAivisMcpRunResult, ParadisAgentDictionarySyncService, paradisRunAivisMcp } from '../../node/paradisAgentDictionarySync.js';

const UUID_A = '11111111-2222-4333-8444-555555555555';

/** aivis-mcp の代わり。呼ばれた引数を覚え、`--set-dictionary` / `--clear-dictionary` で設定（current）を書き換える。 */
class FakeAivisMcp {
	readonly calls: string[][] = [];
	version: string | undefined = 'aivis-mcp v2.5.3';
	current: IParadisAgentDictionaryCurrent = {};
	voices: Record<string, IParadisElevenLabsVoiceTuning> = {};
	fail = false;
	/** `--version` をこの回数だけ時間切れにする（起動直後の重いマシン）。 */
	versionTimeouts = 0;

	readonly run = async (args: readonly string[]): Promise<IParadisAivisMcpRunResult> => {
		this.calls.push([...args]);
		if (args[0] === '--version' && this.versionTimeouts > 0) {
			this.versionTimeouts--;
			return { code: undefined, stdout: '', stderr: '', failure: 'timed out after 30s' };
		}
		if (args[0] === '--version') {
			return this.version === undefined ? { code: undefined, stdout: '', stderr: 'ENOENT' } : { code: 0, stdout: `${this.version}\n`, stderr: '' };
		}
		if (this.fail) {
			return { code: 1, stdout: '', stderr: 'error: lock' };
		}
		if (args[0] === '--set-voice-settings' || args[0] === '--clear-voice-settings') {
			const voices = { ...this.voices };
			if (args[0] === '--clear-voice-settings') {
				delete voices[args[2]];
			} else {
				const entry: { stability?: number; similarityBoost?: number } = { ...voices[args[2]] };
				for (let i = 3; i < args.length; i += 2) {
					entry[args[i] === '--stability' ? 'stability' : 'similarityBoost'] = Number(args[i + 1]);
				}
				voices[args[2]] = entry;
			}
			this.voices = voices;
			return { code: 0, stdout: 'ok\n', stderr: '' };
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
	/** 予約された「もう一度試す」（待ち時間と、呼ぶと試し直す関数）。 */
	let retries: { delayMs: number; run: () => Promise<void>; cancelled: boolean }[];

	setup(() => {
		dir = mkdtempSync(join(tmpdir(), 'paradis-agent-dict-'));
		statePath = join(dir, 'state', 'agent-dictionary.json');
		retries = [];
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
			readCurrentVoiceSettings: async () => fake.voices,
			statePath,
			scheduleRetry: (run, delayMs) => {
				const entry = { delayMs, run, cancelled: false };
				retries.push(entry);
				return { dispose: () => { entry.cancelled = true; } };
			},
		});
	}

	/** 最後に予約された試し直しを動かし、その同期が終わるまで待つ。 */
	function runRetry(): Promise<void> {
		return retries[retries.length - 1].run();
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

	test('tries again later when aivis-mcp could not be run at startup, and stops when a new setting comes or after the last try', async () => {
		const request = { enabled: true, dictionaries: { elevenlabs: 'el1', aivis: '' } };
		// 起動直後: 2 つのウィンドウから同じ設定が来て、どちらも --version が時間切れ
		const fake = new FakeAivisMcp();
		fake.versionTimeouts = 3;
		const service = create(fake);
		const first = await Promise.all([service.apply(request), service.apply(request)]);
		const scheduledAfterStartup = retries.map(entry => ({ delayMs: entry.delayMs, cancelled: entry.cancelled }));
		await runRetry();
		await runRetry();
		const synced = { current: fake.current, retries: retries.length };

		// 見つからないままなら、決まった回数で諦める
		const missing = new FakeAivisMcp();
		missing.version = undefined;
		retries = [];
		rmSync(statePath);
		const missingService = create(missing);
		await missingService.apply(request);
		for (let i = 0; i < 4; i++) {
			await runRetry();
		}
		const missingDelays = retries.map(entry => entry.delayMs);

		// 試し直しを待っている間に設定が変わったら、古い設定では試さない
		const changed = new FakeAivisMcp();
		changed.versionTimeouts = 1;
		retries = [];
		rmSync(statePath, { force: true });
		const changedService = create(changed);
		await changedService.apply(request);
		await changedService.apply({ enabled: false, dictionaries: request.dictionaries });

		assert.deepStrictEqual({
			first: first.map(result => result.status),
			scheduledAfterStartup,
			calls: fake.calls,
			synced,
			missing: { versionCalls: missing.calls.length, delays: missingDelays },
			changed: { cancelled: retries[0].cancelled, calls: changed.calls },
		}, {
			first: ['unsupported', 'unsupported'],
			// 先に来た分は、後から同じ設定が来たので予約しない
			scheduledAfterStartup: [{ delayMs: 15_000, cancelled: false }],
			calls: [['--version'], ['--version'], ['--version'], ['--version'], ['--set-dictionary', '--provider', 'elevenlabs', '--id', 'el1']],
			synced: { current: { elevenlabs: 'el1' }, retries: 2 },
			missing: { versionCalls: 5, delays: [15_000, 60_000, 300_000, 900_000] },
			changed: { cancelled: true, calls: [['--version']] },
		});
	});

	test('writes the voice settings with aivis-mcp 2.5.4, keeps the dictionary only on 2.5.3, and clears only what it wrote', async () => {
		const dictionaries = { elevenlabs: 'el1', aivis: '' };
		const voiceSettings = { v1: { stability: 0.5, similarityBoost: 0.75 }, v2: { stability: 0.3 } };
		// 2.5.3: 辞書だけ書いて、声の調整は飛ばす（覚えない）
		const older = new FakeAivisMcp();
		const olderResult = await create(older).apply({ enabled: true, dictionaries, voiceSettings });
		const olderState = JSON.parse(readFileSync(statePath, 'utf8'));
		rmSync(statePath);

		const fake = new FakeAivisMcp();
		fake.version = 'aivis-mcp v2.5.4';
		const service = create(fake);
		const first = await service.apply({ enabled: true, dictionaries, voiceSettings });
		const again = await service.apply({ enabled: true, dictionaries, voiceSettings });
		// 利用者が aivis-mcp 側で v2 を変えた後にオフにする: v2 は消さずに忘れる
		fake.voices = { ...fake.voices, v2: { stability: 0.9 } };
		const off = await service.apply({ enabled: false, dictionaries, voiceSettings });
		assert.deepStrictEqual({
			older: { status: olderResult.status, calls: older.calls, voices: older.voices, state: olderState },
			statuses: [first.status, again.status, off.status],
			calls: fake.calls,
			voices: fake.voices,
			state: JSON.parse(readFileSync(statePath, 'utf8')),
		}, {
			older: {
				status: 'applied',
				calls: [['--version'], ['--set-dictionary', '--provider', 'elevenlabs', '--id', 'el1']],
				voices: {},
				state: { elevenlabs: 'el1' },
			},
			statuses: ['applied', 'unchanged', 'applied'],
			calls: [
				['--version'],
				['--set-dictionary', '--provider', 'elevenlabs', '--id', 'el1'],
				['--set-voice-settings', '--voice', 'v1', '--stability', '0.5', '--similarity', '0.75'],
				['--set-voice-settings', '--voice', 'v2', '--stability', '0.3'],
				['--version'],
				['--clear-dictionary', '--provider', 'elevenlabs'],
				['--clear-voice-settings', '--voice', 'v1'],
			],
			voices: { v2: { stability: 0.9 } },
			state: {},
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
		const notFound = await paradisRunAivisMcp(['--version'], { PATH: '/usr/bin:/bin' });
		writeFileSync(script, '#!/bin/sh\nsleep 5\n');
		const timedOut = await paradisRunAivisMcp(['--version'], env, 200);
		assert.deepStrictEqual({
			statuses: [set.status, cleared.status],
			log: readFileSync(log, 'utf8').trim().split('\n'),
			config: readFileSync(config, 'utf8').trim(),
			stateExists: existsSync(statePath),
			rejected: rejected.code,
			failures: [notFound.failure, timedOut.failure],
		}, {
			statuses: ['applied', 'applied'],
			log: [`--set-dictionary --provider aivis --id ${UUID_A}`, '--clear-dictionary --provider aivis'],
			config: '{}',
			stateExists: true,
			rejected: undefined,
			failures: ['not found on PATH', 'timed out after 0.2s'],
		});
	});
});
