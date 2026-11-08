/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { join } from '../../../../../base/common/path.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILocalTranscriptionModelStatus, ILocalTranscriptionResult } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { IParadisSpeechHelperProcess, ParadisSpeechEngine, paradisSpeechHelperCandidates } from '../../node/paradisSpeechEngineService.js';

/** 補助プログラムの代わり。標準出力へ行を書き、標準入力に届いたものを溜める。 */
class FakeHelper extends EventEmitter implements IParadisSpeechHelperProcess {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly received: Buffer[] = [];
	readonly signals: (NodeJS.Signals | undefined)[] = [];
	stdinEnded = false;

	constructor(readonly file: string, readonly args: readonly string[]) {
		super();
		this.stdin.on('data', (chunk: Buffer) => this.received.push(chunk));
		this.stdin.on('end', () => { this.stdinEnded = true; });
	}

	send(message: object): void {
		this.stdout.write(`${JSON.stringify(message)}\n`);
	}

	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.emit('exit', code, signal);
	}

	kill(signal?: NodeJS.Signals): boolean {
		this.signals.push(signal);
		setImmediate(() => this.exit(null, signal ?? 'SIGTERM'));
		return true;
	}
}

/** 出力の 'data' はイベントループを 1 回回すと届く。 */
function flush(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

suite('Paradis speech engine (utility process)', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createEngine(helperFound = true) {
		const helpers: FakeHelper[] = [];
		const engine = disposables.add(new ParadisSpeechEngine({
			helperPath: async () => helperFound ? '/Applications/Para Code.app/Contents/Helpers/ParadisSpeech' : undefined,
			spawn: (file, args) => {
				const helper = new FakeHelper(file, args);
				helpers.push(helper);
				return helper;
			},
			stopTimeoutMs: 50,
		}));
		const statuses: ILocalTranscriptionModelStatus[] = [];
		const results: ILocalTranscriptionResult[] = [];
		disposables.add(engine.onDidChangeModelStatus(status => statuses.push(status)));
		disposables.add(engine.onDidTranscribe(result => results.push(result)));
		return { engine, helpers, statuses, results };
	}

	test('runs one helper per dictation: progress, interim text, and the final text after the input closes', async () => {
		const { engine, helpers, statuses, results } = createEngine();
		await engine.start({ locale: 'ja-JP' });
		const helper = helpers[0];
		await engine.pushAudio(VSBuffer.wrap(new Uint8Array([1, 2, 3, 4])));
		helper.send({ type: 'status', state: 'downloading', progress: 0.5 });
		helper.send({ type: 'ready', locale: 'ja-JP', transcriber: 'speech' });
		helper.send({ type: 'text', committed: 'こんにちは', tentative: '世' });
		helper.send({ type: 'unknown' });
		await flush();
		const stopped = engine.stop();
		await flush();
		helper.send({ type: 'final', text: 'こんにちは世界' });
		await flush();
		helper.exit(0);
		assert.deepStrictEqual({
			final: await stopped,
			args: helper.args,
			audio: Buffer.concat(helper.received).toString('hex'),
			stdinEnded: helper.stdinEnded,
			statuses,
			results,
			status: await engine.getModelStatus(),
		}, {
			final: 'こんにちは世界',
			args: ['transcribe', '--locale', 'ja-JP'],
			audio: '01020304',
			stdinEnded: true,
			statuses: [
				{ state: 'loading' },
				{ state: 'downloading', progress: 0.5 },
				{ state: 'ready', downloaded: true },
			],
			results: [
				{ text: 'こんにちは世', finalizedText: 'こんにちは', isFinal: false },
				{ text: 'こんにちは世界', finalizedText: 'こんにちは世界', isFinal: true },
			],
			status: { state: 'ready', downloaded: true },
		});
	});

	test('answers ready at once for a language that was prepared before', async () => {
		const { engine, helpers, statuses } = createEngine();
		await engine.start({ locale: 'ja-JP' });
		helpers[0].send({ type: 'ready', locale: 'ja-JP' });
		await flush();
		await engine.cancel();
		await engine.start({ locale: 'ja-JP' });
		await engine.cancel();
		await engine.start({ locale: 'en-US' });
		await engine.cancel();
		assert.deepStrictEqual({ statuses, signals: helpers.map(helper => helper.signals) }, {
			statuses: [
				{ state: 'loading' },
				{ state: 'ready', downloaded: false },
				{ state: 'ready' },
				{ state: 'loading' },
				{ state: 'idle' },
			],
			signals: [['SIGTERM'], ['SIGTERM'], ['SIGTERM']],
		});
	});

	test('reports failures with Para error codes, never the Foundry import codes', async () => {
		const missing = createEngine(false);
		await missing.engine.start({ locale: 'auto' });

		const helperError = createEngine();
		await helperError.engine.start({ locale: 'ja-JP' });
		helperError.helpers[0].send({ type: 'error', code: 'assets', message: 'offline' });
		await flush();

		const crashed = createEngine();
		await crashed.engine.start({ locale: 'ja-JP' });
		crashed.helpers[0].stderr.write('dyld: Symbol not found\n');
		await flush();
		crashed.helpers[0].exit(null, 'SIGABRT');

		const codes = [missing, helperError, crashed].map(({ statuses }) => statuses[statuses.length - 1].errorCode);
		assert.deepStrictEqual(codes, ['paradisHelperMissing', 'paradisAssets', 'paradisFailed']);
		assert.ok(codes.every(code => code !== 'network' && code !== 'notFound'));
		assert.match(crashed.statuses[crashed.statuses.length - 1].error ?? '', /dyld: Symbol not found/);
	});

	test('stops waiting for a helper that does not finish and keeps the text so far', async () => {
		const { engine, helpers } = createEngine();
		await engine.start({ locale: 'ja-JP' });
		helpers[0].send({ type: 'text', committed: '途中', tentative: 'まで' });
		await flush();
		assert.deepStrictEqual({ text: await engine.stop(), signals: helpers[0].signals }, { text: '途中まで', signals: ['SIGTERM'] });
	});

	test('looks for the packaged helper first and the development build only in development', () => {
		const appRoot = join('/Applications', 'Para Code.app', 'Contents', 'Resources', 'app');
		assert.deepStrictEqual({
			packaged: paradisSpeechHelperCandidates(appRoot, false),
			development: paradisSpeechHelperCandidates('/repo', true),
		}, {
			packaged: [join('/Applications', 'Para Code.app', 'Contents', 'Helpers', 'ParadisSpeech')],
			development: [join('/', 'Helpers', 'ParadisSpeech'), join('/repo', '.build', 'paradis', 'speech', 'ParadisSpeech')],
		});
	});
});
