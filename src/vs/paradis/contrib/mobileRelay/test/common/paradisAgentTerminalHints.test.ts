/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentTerminalHintParser, paradisShouldAcceptAgentTerminalHint } from '../../common/paradisAgentTerminalHints.js';
import { IParadisTerminalHintTimer, paradisCreateAgentTerminalHintConsumer } from '../../common/paradisTerminalOutputHotPath.js';

suite('ParadisAgentTerminalHintParser', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('does not enter the parser hot path for ordinary terminals', () => {
		assert.strictEqual(paradisShouldAcceptAgentTerminalHint(true, 'plain-pane', false), false);
		assert.strictEqual(paradisShouldAcceptAgentTerminalHint(true, 'confirmed-pane', true), true);
		assert.strictEqual(paradisShouldAcceptAgentTerminalHint(false, 'confirmed-pane', true), false);
		assert.strictEqual(paradisShouldAcceptAgentTerminalHint(true, undefined, true), false);
	});

	test('keeps a bounded raw tail and strips terminal controls only once per 400ms scan window', () => {
		let now = 0;
		let scans = 0;
		let normalizations = 0;
		const parser = new ParadisAgentTerminalHintParser(
			() => now,
			{
				onScan: () => scans++,
				onNormalize: () => normalizations++,
			},
		);

		for (let index = 0; index < 10_000; index++) {
			parser.accept(`\x1b[32mline-${index.toString().padStart(5, '0')}\x1b[0m\n`);
		}
		assert.strictEqual(scans, 0);
		assert.strictEqual(normalizations, 0);
		assert.strictEqual(parser.rawBufferLength, 16_384);

		now = 400;
		parser.accept('\x1b[31mWorking (1m 02s • esc to interrupt) 12.5k tokens\x1b[0m');
		assert.strictEqual(scans, 1);
		assert.strictEqual(normalizations, 1);
		assert.ok(parser.normalizedBufferLength <= 4_096);
	});

	test('caps scans at one per 400ms and emissions at one per 800ms under high-frequency Agent output', () => {
		let now = 0;
		let scans = 0;
		const parser = new ParadisAgentTerminalHintParser(() => now, { onScan: () => scans++ });
		const emitted = [];
		for (let millisecond = 0; millisecond <= 2_000; millisecond++) {
			now = millisecond;
			const hint = parser.accept(`Working (${Math.floor(millisecond / 1_000) + 1}s • esc to interrupt) ${millisecond + 1} tokens\n`);
			if (hint !== undefined) {
				emitted.push({ at: millisecond, hint });
			}
		}
		assert.strictEqual(scans, 5);
		assert.deepStrictEqual(emitted.map(entry => entry.at), [800, 1_600]);
	});

	test('resets every generation-local buffer and fingerprint before ordinary output resumes', () => {
		let now = 800;
		let scans = 0;
		let normalizations = 0;
		const parser = new ParadisAgentTerminalHintParser(
			() => now,
			{
				onScan: () => scans++,
				onNormalize: () => normalizations++,
			},
		);

		assert.deepStrictEqual(parser.accept('Working (5s • esc to interrupt) 10 tokens'), { elapsedSeconds: 5, tokenCount: 10 });
		parser.reset();
		assert.strictEqual(parser.rawBufferLength, 0);
		assert.strictEqual(parser.normalizedBufferLength, 0);

		for (let index = 0; index < 1_000; index++) {
			now += 1_000;
			if (paradisShouldAcceptAgentTerminalHint(true, 'pane', false)) {
				parser.accept(`ordinary output ${index}`);
			}
		}
		assert.strictEqual(scans, 1);
		assert.strictEqual(normalizations, 1);

		now += 1_000;
		assert.deepStrictEqual(parser.accept('Working (5s • esc to interrupt) 10 tokens'), { elapsedSeconds: 5, tokenCount: 10 }, 'the previous generation fingerprint must not suppress the new generation');
	});

	test('does not emit an empty hint for an active marker without elapsed time or token count', () => {
		const parser = new ParadisAgentTerminalHintParser(() => 800);
		assert.strictEqual(parser.accept('esc to interrupt'), undefined);
	});

	test('preserves ANSI and agent marker recognition across arbitrary output chunk boundaries', () => {
		let now = 0;
		const parser = new ParadisAgentTerminalHintParser(() => now);
		for (const chunk of ['\x1b[', '32mWo', 'rking (1', 'm 02s • esc ', 'to inter', 'rupt) 12.', '5k tok']) {
			assert.strictEqual(parser.accept(chunk), undefined);
		}
		now = 800;
		assert.deepStrictEqual(parser.accept('ens\x1b[0m'), { elapsedSeconds: 62, tokenCount: 12_500 });
		assert.ok(parser.rawBufferLength <= 16_384);
	});

	test('timer-latches scans so synchronous chunks only append to the bounded deque', () => {
		const timer = new FakeHintTimer();
		let nowCalls = 0;
		let scans = 0;
		const hints: unknown[] = [];
		const parser = new ParadisAgentTerminalHintParser(() => { nowCalls++; return 800; }, { onScan: () => scans++ });
		const consumer = store.add(paradisCreateAgentTerminalHintConsumer(parser, hint => hints.push(hint), timer));

		consumer.accept('Working (1s • esc to interrupt) 1 token');
		for (let index = 0; index < 10_000; index++) {
			consumer.accept(`\x1b[32mline-${index}\x1b[0m\n`);
		}

		assert.strictEqual(nowCalls, 1);
		assert.strictEqual(scans, 1);
		assert.strictEqual(timer.size, 1);
		assert.deepStrictEqual(timer.delays, [400]);
		assert.strictEqual(parser.rawBufferLength, 16_384);
		assert.strictEqual(hints.length, 1);
	});

	test('timer callback only marks scan due and the next split-marker chunk performs the scan', () => {
		const timer = new FakeHintTimer();
		let now = 800;
		let scans = 0;
		const hints: unknown[] = [];
		const parser = new ParadisAgentTerminalHintParser(() => now, { onScan: () => scans++ });
		const consumer = store.add(paradisCreateAgentTerminalHintConsumer(parser, hint => hints.push(hint), timer));

		consumer.accept('\x1b[32mWork');
		consumer.accept('ing (1m 02s • esc to inter');
		assert.strictEqual(scans, 1);
		now = 1_600;
		timer.runAll();
		assert.strictEqual(scans, 1, 'timer callback must not scan without terminal output');
		consumer.accept('rupt) 12.5k tokens\x1b[0m');

		assert.strictEqual(scans, 2);
		assert.deepStrictEqual(hints, [{ elapsedSeconds: 62, tokenCount: 12_500 }]);
		assert.deepStrictEqual(timer.delays, [400, 400]);
	});

	test('reset and dispose clear timers and prevent generation-local tails from firing later', () => {
		const timer = new FakeHintTimer();
		let now = 800;
		const hints: unknown[] = [];
		const parser = new ParadisAgentTerminalHintParser(() => now);
		const consumer = paradisCreateAgentTerminalHintConsumer(parser, hint => hints.push(hint), timer);

		consumer.accept('Working (5s • esc to inter');
		consumer.reset();
		assert.strictEqual(timer.size, 0);
		assert.strictEqual(parser.rawBufferLength, 0);
		timer.runAll();
		now = 1_600;
		consumer.accept('ordinary output rupt) 10 tokens');
		assert.deepStrictEqual(hints, []);
		assert.strictEqual(timer.size, 1);

		consumer.dispose();
		assert.strictEqual(timer.size, 0);
		assert.strictEqual(parser.rawBufferLength, 0);
		consumer.accept('Working (9s • esc to interrupt) 99 tokens');
		assert.deepStrictEqual(hints, []);
	});
});

class FakeHintTimer implements IParadisTerminalHintTimer {
	readonly delays: number[] = [];
	private readonly callbacks = new Map<number, () => void>();
	private nextHandle = 1;

	get size(): number { return this.callbacks.size; }

	set(callback: () => void, delayMs: number): number {
		const handle = this.nextHandle++;
		this.delays.push(delayMs);
		this.callbacks.set(handle, callback);
		return handle;
	}

	clear(handle: unknown): void {
		if (typeof handle !== 'number') {
			assert.fail('FakeHintTimer handles must be numeric');
		}
		this.callbacks.delete(handle);
	}

	runAll(): void {
		const callbacks = [...this.callbacks.values()];
		this.callbacks.clear();
		for (const callback of callbacks) {
			callback();
		}
	}
}
