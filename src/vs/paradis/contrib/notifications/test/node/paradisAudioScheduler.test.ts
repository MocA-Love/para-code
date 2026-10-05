/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AivisError,
	AivisHandoffResult,
	AivisSynthesizeResult,
	AivisTaskRunner,
	AudioScheduler,
	AudioSchedulerDeps,
} from '../../node/paradisAudioScheduler.js';

const EMPTY_AUDIO = Buffer.from('audio');

async function waitForIdle(scheduler: AudioScheduler): Promise<void> {
	for (let i = 0; i < 100; i++) {
		await Promise.resolve();
		if (!scheduler.isAivisBusy && scheduler.aivisQueueSize === 0) {
			return;
		}
	}
	assert.fail('AudioScheduler did not become idle');
}

function successfulRunner(name: string, events: string[], result?: AivisSynthesizeResult): AivisTaskRunner {
	return {
		async synthesize() {
			events.push(`synthesize:${name}`);
			return result ?? { audio: Buffer.from(name) };
		},
		async play(audio) {
			events.push(`play:${audio.toString()}`);
		},
	};
}

function createScheduler(overrides: Partial<AudioSchedulerDeps> = {}): AudioScheduler {
	return new AudioScheduler({
		playRingtone: onComplete => onComplete(),
		notifyAivisPaused: () => { },
		...overrides,
	});
}

suite('AudioScheduler', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const schedulers: AudioScheduler[] = [];
	const track = (scheduler: AudioScheduler): AudioScheduler => {
		schedulers.push(scheduler);
		return scheduler;
	};

	teardown(() => {
		for (const scheduler of schedulers.splice(0)) {
			scheduler.dispose();
		}
		sinon.restore();
	});

	test('suppresses a duplicate ringtone while audio is busy', () => {
		const completions: Array<() => void> = [];
		let plays = 0;
		const scheduler = track(createScheduler({
			playRingtone: onComplete => {
				plays++;
				completions.push(onComplete);
			},
		}));

		scheduler.playRingtone();
		scheduler.playRingtone();
		assert.strictEqual(plays, 1);

		completions[0]();
		scheduler.playRingtone();
		assert.strictEqual(plays, 2);
	});

	test('synthesizes and plays normal-priority tasks in FIFO order', async () => {
		const events: string[] = [];
		const scheduler = track(createScheduler());

		scheduler.enqueueAivis(successfulRunner('first', events));
		scheduler.enqueueAivis(successfulRunner('second', events));
		scheduler.enqueueAivis(successfulRunner('third', events));
		await waitForIdle(scheduler);

		assert.deepStrictEqual(events, [
			'synthesize:first',
			'play:first',
			'synthesize:second',
			'play:second',
			'synthesize:third',
			'play:third',
		]);
	});

	test('places high-priority work ahead of queued normal work without interrupting the active task', async () => {
		const firstSynthesis = new DeferredPromise<AivisSynthesizeResult>();
		const firstSynthesisStarted = new DeferredPromise<void>();
		const events: string[] = [];
		const scheduler = track(createScheduler());

		scheduler.enqueueAivis({
			synthesize: () => {
				events.push('synthesize:first');
				void firstSynthesisStarted.complete();
				return firstSynthesis.p;
			},
			play: async () => { events.push('play:first'); },
		});
		await firstSynthesisStarted.p;
		scheduler.enqueueAivis(successfulRunner('second', events));
		scheduler.enqueueAivis(successfulRunner('urgent', events), 'high');

		await firstSynthesis.complete({ audio: EMPTY_AUDIO });
		await waitForIdle(scheduler);

		assert.deepStrictEqual(events, [
			'synthesize:first',
			'play:first',
			'synthesize:urgent',
			'play:urgent',
			'synthesize:second',
			'play:second',
		]);
	});

	test('holds playback while dictating and plays the queued work after release', async () => {
		const events: string[] = [];
		let ringtones = 0;
		const firstSynthesis = new DeferredPromise<AivisSynthesizeResult>();
		const firstSynthesisStarted = new DeferredPromise<void>();
		const scheduler = track(createScheduler({ playRingtone: onComplete => { ringtones++; onComplete(); } }));

		// 合成中に音声入力が始まった発話は、解除まで再生を待つ
		scheduler.enqueueAivis({
			synthesize: () => {
				events.push('synthesize:first');
				void firstSynthesisStarted.complete();
				return firstSynthesis.p;
			},
			play: async audio => { events.push(`play:${audio.toString()}`); },
		});
		await firstSynthesisStarted.p;
		scheduler.setHeld(true);
		scheduler.playRingtone();
		scheduler.enqueueAivis(successfulRunner('second', events));
		await firstSynthesis.complete({ audio: Buffer.from('first') });
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}
		const whileHeld = { events: [...events], ringtones, queued: scheduler.aivisQueueSize };

		scheduler.setHeld(false);
		await waitForIdle(scheduler);

		assert.deepStrictEqual({ whileHeld, afterRelease: events }, {
			whileHeld: { events: ['synthesize:first'], ringtones: 0, queued: 1 },
			afterRelease: ['synthesize:first', 'play:first', 'synthesize:second', 'play:second'],
		});
	});

	test('waits for the exhausted rate-limit window before synthesizing the next task', async () => {
		const events: string[] = [];
		const sleeps: number[] = [];
		const sleepStarted = new DeferredPromise<void>();
		const sleepGate = new DeferredPromise<void>();
		const scheduler = track(createScheduler({
			now: () => 1_500,
			sleep: ms => {
				sleeps.push(ms);
				void sleepStarted.complete();
				return sleepGate.p;
			},
		}));

		scheduler.enqueueAivis(successfulRunner('first', events, {
			audio: Buffer.from('first'),
			rateLimit: { remaining: 0, resetSeconds: 2, capturedAt: 1_000 },
		}));
		scheduler.enqueueAivis(successfulRunner('second', events));
		await sleepStarted.p;

		assert.deepStrictEqual(sleeps, [2_000]);
		assert.deepStrictEqual(events, [
			'synthesize:first',
			'play:first',
		]);

		await sleepGate.complete();
		await waitForIdle(scheduler);

		assert.deepStrictEqual(events, [
			'synthesize:first',
			'play:first',
			'synthesize:second',
			'play:second',
		]);
	});

	test('retries a retryable synthesis failure three times with exponential backoff', async () => {
		const sleeps: number[] = [];
		const sleepStarted = [
			new DeferredPromise<void>(),
			new DeferredPromise<void>(),
		];
		const sleepGates = [
			new DeferredPromise<void>(),
			new DeferredPromise<void>(),
		];
		let sleepIndex = 0;
		let attempts = 0;
		const played: string[] = [];
		const scheduler = track(createScheduler({
			sleep: ms => {
				const index = sleepIndex++;
				sleeps.push(ms);
				void sleepStarted[index].complete();
				return sleepGates[index].p;
			},
		}));

		scheduler.enqueueAivis({
			async synthesize() {
				attempts++;
				if (attempts < 3) {
					throw new AivisError('retryable', `attempt ${attempts}`);
				}
				return { audio: Buffer.from('recovered') };
			},
			async play(audio) {
				played.push(audio.toString());
			},
		});
		await sleepStarted[0].p;

		assert.strictEqual(attempts, 1);
		assert.deepStrictEqual(sleeps, [1_000]);
		assert.deepStrictEqual(played, []);

		await sleepGates[0].complete();
		await sleepStarted[1].p;
		assert.strictEqual(attempts, 2);
		assert.deepStrictEqual(sleeps, [1_000, 2_000]);
		assert.deepStrictEqual(played, []);

		await sleepGates[1].complete();
		await waitForIdle(scheduler);

		assert.strictEqual(attempts, 3);
		assert.deepStrictEqual(played, ['recovered']);
	});

	test('gives up after three retryable failures and advances queued work', async () => {
		const sleeps: number[] = [];
		const sleepStarted = [
			new DeferredPromise<void>(),
			new DeferredPromise<void>(),
		];
		const sleepGates = [
			new DeferredPromise<void>(),
			new DeferredPromise<void>(),
		];
		let sleepIndex = 0;
		const laterEvents: string[] = [];
		let attempts = 0;
		const scheduler = track(createScheduler({
			sleep: ms => {
				const index = sleepIndex++;
				sleeps.push(ms);
				void sleepStarted[index].complete();
				return sleepGates[index].p;
			},
		}));

		scheduler.enqueueAivis({
			async synthesize() {
				attempts++;
				throw new AivisError('retryable', 'service unavailable', 503);
			},
			async play() { assert.fail('failed synthesis must not play audio'); },
		});
		scheduler.enqueueAivis(successfulRunner('after-failure', laterEvents));
		await sleepStarted[0].p;

		assert.strictEqual(attempts, 1);
		assert.deepStrictEqual(laterEvents, []);

		await sleepGates[0].complete();
		await sleepStarted[1].p;
		assert.strictEqual(attempts, 2);
		assert.deepStrictEqual(laterEvents, []);

		await sleepGates[1].complete();
		await waitForIdle(scheduler);

		assert.strictEqual(attempts, 3);
		assert.deepStrictEqual(sleeps, [1_000, 2_000]);
		assert.deepStrictEqual(laterEvents, [
			'synthesize:after-failure',
			'play:after-failure',
		]);
	});

	test('uses the server reset delay plus margin for a 429 retry', async () => {
		const sleeps: number[] = [];
		const sleepStarted = new DeferredPromise<void>();
		const sleepGate = new DeferredPromise<void>();
		let attempts = 0;
		const scheduler = track(createScheduler({
			sleep: ms => {
				sleeps.push(ms);
				void sleepStarted.complete();
				return sleepGate.p;
			},
		}));

		scheduler.enqueueAivis({
			async synthesize() {
				attempts++;
				if (attempts === 1) {
					throw new AivisError('retryable', 'rate limited', 429, 3);
				}
				return { audio: EMPTY_AUDIO };
			},
			async play() { },
		});
		await sleepStarted.p;

		assert.deepStrictEqual(sleeps, [3_500]);
		assert.strictEqual(attempts, 1);

		await sleepGate.complete();
		await waitForIdle(scheduler);

		assert.strictEqual(attempts, 2);
	});

	test('pauses and drains queued work after a fatal synthesis error', async () => {
		const firstSynthesis = new DeferredPromise<AivisSynthesizeResult>();
		const firstSynthesisStarted = new DeferredPromise<void>();
		const pausedReasons: string[] = [];
		const laterEvents: string[] = [];
		const scheduler = track(createScheduler({
			notifyAivisPaused: reason => { pausedReasons.push(reason); },
		}));

		scheduler.enqueueAivis({
			synthesize: () => {
				void firstSynthesisStarted.complete();
				return firstSynthesis.p;
			},
			async play() { assert.fail('fatal synthesis must not play audio'); },
		});
		scheduler.enqueueAivis(successfulRunner('queued', laterEvents));
		await firstSynthesisStarted.p;
		assert.strictEqual(scheduler.aivisQueueSize, 1);

		await firstSynthesis.error(new AivisError('fatal', 'invalid API key', 401));
		await waitForIdle(scheduler);

		assert.strictEqual(scheduler.isPaused, true);
		assert.strictEqual(scheduler.aivisQueueSize, 0);
		assert.deepStrictEqual(pausedReasons, ['invalid API key']);
		assert.deepStrictEqual(laterEvents, []);

		scheduler.enqueueAivis(successfulRunner('ignored', laterEvents));
		assert.deepStrictEqual(laterEvents, []);
	});

	test('resume accepts new work after a fatal pause', async () => {
		const events: string[] = [];
		const scheduler = track(createScheduler());

		scheduler.enqueueAivis({
			async synthesize() { throw new AivisError('fatal', 'invalid model', 404); },
			async play() { },
		});
		await waitForIdle(scheduler);
		assert.strictEqual(scheduler.isPaused, true);

		scheduler.resume();
		scheduler.enqueueAivis(successfulRunner('after-resume', events));
		await waitForIdle(scheduler);

		assert.strictEqual(scheduler.isPaused, false);
		assert.deepStrictEqual(events, ['synthesize:after-resume', 'play:after-resume']);
	});

	test('suppresses ringtone playback while Aivis is synthesizing and playing', async () => {
		const synthesis = new DeferredPromise<AivisSynthesizeResult>();
		const synthesisStarted = new DeferredPromise<void>();
		const playback = new DeferredPromise<void>();
		const playbackStarted = new DeferredPromise<void>();
		let ringtonePlays = 0;
		const scheduler = track(createScheduler({
			playRingtone: onComplete => {
				ringtonePlays++;
				onComplete();
			},
		}));

		scheduler.enqueueAivis({
			synthesize: () => {
				void synthesisStarted.complete();
				return synthesis.p;
			},
			play: () => {
				void playbackStarted.complete();
				return playback.p;
			},
		});
		await synthesisStarted.p;

		scheduler.playRingtone();
		assert.strictEqual(ringtonePlays, 0);

		await synthesis.complete({ audio: EMPTY_AUDIO });
		await playbackStarted.p;
		scheduler.playRingtone();
		assert.strictEqual(ringtonePlays, 0);

		await playback.complete();
		await waitForIdle(scheduler);
		scheduler.playRingtone();
		assert.strictEqual(ringtonePlays, 1);
	});

	test('dispose cancels queued playback and ignores later work', async () => {
		const synthesis = new DeferredPromise<AivisSynthesizeResult>();
		const synthesisStarted = new DeferredPromise<void>();
		const playRingtone = sinon.spy((_onComplete: () => void) => { });
		let plays = 0;
		let laterSynthesis = 0;
		const scheduler = track(createScheduler({ playRingtone }));

		scheduler.enqueueAivis({
			synthesize: () => {
				void synthesisStarted.complete();
				return synthesis.p;
			},
			async play() { plays++; },
		});
		scheduler.enqueueAivis({
			async synthesize() {
				laterSynthesis++;
				return { audio: EMPTY_AUDIO };
			},
			async play() { plays++; },
		});
		await synthesisStarted.p;
		assert.strictEqual(scheduler.aivisQueueSize, 1);

		scheduler.dispose();
		await synthesis.complete({ audio: EMPTY_AUDIO });
		await waitForIdle(scheduler);
		scheduler.enqueueAivis(successfulRunner('ignored', []));
		scheduler.playRingtone();

		assert.strictEqual(scheduler.aivisQueueSize, 0);
		assert.strictEqual(plays, 0);
		assert.strictEqual(laterSynthesis, 0);
		assert.strictEqual(playRingtone.called, false);
	});

	test('ringtone safety timeout releases queued Aivis playback', async () => {
		const clock = sinon.useFakeTimers();
		const events: string[] = [];
		const synthesisStarted = new DeferredPromise<void>();
		const scheduler = track(createScheduler({
			playRingtone: () => { },
			ringtoneSafetyTimeoutMs: 25,
		}));

		scheduler.playRingtone();
		scheduler.enqueueAivis({
			synthesize: () => {
				events.push('synthesize:after-timeout');
				void synthesisStarted.complete();
				return Promise.resolve({ audio: Buffer.from('after-timeout') });
			},
			async play(audio) {
				events.push(`play:${audio.toString()}`);
			},
		});
		await synthesisStarted.p;
		assert.deepStrictEqual(events, ['synthesize:after-timeout']);

		clock.tick(25);
		await waitForIdle(scheduler);

		assert.deepStrictEqual(events, ['synthesize:after-timeout', 'play:after-timeout']);
	});

	test('Aivis playback safety timeout advances to the next queued task', async () => {
		const clock = sinon.useFakeTimers();
		const neverFinishes = new DeferredPromise<void>();
		const playbackStarted = new DeferredPromise<void>();
		const events: string[] = [];
		const scheduler = track(createScheduler({ aivisPlaySafetyTimeoutMs: 25 }));

		scheduler.enqueueAivis({
			async synthesize() {
				events.push('synthesize:stuck');
				return { audio: Buffer.from('stuck') };
			},
			play() {
				events.push('play:stuck');
				void playbackStarted.complete();
				return neverFinishes.p;
			},
		});
		scheduler.enqueueAivis(successfulRunner('next', events));
		await playbackStarted.p;
		assert.strictEqual(scheduler.isAivisBusy, true);
		assert.strictEqual(scheduler.aivisQueueSize, 1);

		clock.tick(25);
		await waitForIdle(scheduler);

		assert.deepStrictEqual(events, [
			'synthesize:stuck',
			'play:stuck',
			'synthesize:next',
			'play:next',
		]);
	});

	test('waits for the worker play lock outside the playback safety timeout, so a long wait does not cut the voice short (N-2)', async () => {
		const clock = sinon.useFakeTimers();
		const lock = new DeferredPromise<void>();
		const firstPlaying = new DeferredPromise<void>();
		const firstDone = new DeferredPromise<void>();
		const events: string[] = [];
		const scheduler = track(createScheduler({ aivisPlaySafetyTimeoutMs: 25, waitForPlayLock: () => lock.p }));
		scheduler.enqueueAivis({
			...successfulRunner('first', events),
			play: audio => {
				events.push(`play:${audio.toString()}`);
				void firstPlaying.complete();
				return firstDone.p;
			},
		});
		scheduler.enqueueAivis(successfulRunner('second', events));
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}
		// lock を待つ間に安全網の時間が過ぎても、次の声へ進まない
		clock.tick(100);
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}
		const beforeLock = [...events];
		lock.complete();
		await firstPlaying.p;
		// 鳴らし始めてから安全網より短い時間では、まだ次の声を鳴らさない
		clock.tick(10);
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}
		const whilePlaying = [...events];
		firstDone.complete();
		await waitForIdle(scheduler);
		assert.deepStrictEqual({ beforeLock, whilePlaying, events }, {
			beforeLock: ['synthesize:first'],
			whilePlaying: ['synthesize:first', 'play:first'],
			events: ['synthesize:first', 'play:first', 'synthesize:second', 'play:second'],
		});
	});

	suite('queue limit', () => {
		test('drops normal-priority tasks when the queue is full', async () => {
			const infos: string[] = [];
			const gate = new DeferredPromise<void>();
			const events: string[] = [];
			const scheduler = track(createScheduler({ maxQueuedAivisTasks: 2, logInfo: message => infos.push(message) }));

			scheduler.enqueueAivis({
				synthesize: () => { events.push('synthesize:blocking'); return Promise.resolve({ audio: EMPTY_AUDIO }); },
				play: () => { events.push('play:blocking'); return gate.p; },
			});
			await Promise.resolve();
			// 実行中の1件は queue の外なので、待機キュー2件まで受け付ける
			scheduler.enqueueAivis(successfulRunner('queued-1', events));
			scheduler.enqueueAivis(successfulRunner('queued-2', events));
			assert.strictEqual(scheduler.aivisQueueSize, 2);
			scheduler.enqueueAivis(successfulRunner('dropped', events));
			assert.strictEqual(scheduler.aivisQueueSize, 2);

			gate.complete();
			await waitForIdle(scheduler);
			assert.ok(infos.some(message => message.includes('queue is full')));
			assert.deepStrictEqual(events, [
				'synthesize:blocking',
				'play:blocking',
				'synthesize:queued-1',
				'play:queued-1',
				'synthesize:queued-2',
				'play:queued-2',
			]);
			assert.strictEqual(events.includes('synthesize:dropped'), false);
		});

		test('a high-priority task evicts the oldest normal task instead of being dropped', async () => {
			const gate = new DeferredPromise<void>();
			const events: string[] = [];
			const scheduler = track(createScheduler({ maxQueuedAivisTasks: 2 }));

			scheduler.enqueueAivis({
				synthesize: () => { events.push('synthesize:blocking'); return Promise.resolve({ audio: EMPTY_AUDIO }); },
				play: () => { events.push('play:blocking'); return gate.p; },
			});
			await Promise.resolve();
			scheduler.enqueueAivis(successfulRunner('old-normal', events));
			scheduler.enqueueAivis(successfulRunner('other-normal', events));
			assert.strictEqual(scheduler.aivisQueueSize, 2);

			scheduler.enqueueAivis(successfulRunner('urgent', events), 'high');
			assert.strictEqual(scheduler.aivisQueueSize, 2);

			gate.complete();
			await waitForIdle(scheduler);
			// old-normal が追い出され、urgent は other-normal より先に処理される
			assert.deepStrictEqual(events, [
				'synthesize:blocking',
				'play:blocking',
				'synthesize:urgent',
				'play:urgent',
				'synthesize:other-normal',
				'play:other-normal',
			]);
			assert.strictEqual(events.includes('synthesize:old-normal'), false);
		});

		test('an all-high full queue evicts the oldest high entry for a new high task', async () => {
			const gates = [new DeferredPromise<void>(), new DeferredPromise<void>(), new DeferredPromise<void>()];
			const events: string[] = [];
			const scheduler = track(createScheduler({ maxQueuedAivisTasks: 2 }));

			for (let i = 0; i < 3; i++) {
				scheduler.enqueueAivis({
					synthesize: () => { events.push(`synthesize:h${i}`); return Promise.resolve({ audio: Buffer.from(`h${i}`) }); },
					play: () => { events.push(`play:h${i}`); return gates[i].p; },
				}, 'high');
			}
			// 先頭(h0)だけ実行に入り、h1/h2 が待機。上限2の状態で h3 を投げると最古の h1 が追い出される
			assert.strictEqual(scheduler.aivisQueueSize, 2);

			scheduler.enqueueAivis(successfulRunner('h3', events), 'high');
			assert.strictEqual(scheduler.aivisQueueSize, 2);

			for (const gate of gates) { gate.complete(); }
			await waitForIdle(scheduler);
			// h0(実行中) → h2 → h3 の順。h1 は追い出されたため再生されない
			assert.deepStrictEqual(events, [
				'synthesize:h0',
				'play:h0',
				'synthesize:h2',
				'play:h2',
				'synthesize:h3',
				'play:h3',
			]);
		});
	});

	suite('handoff to aivis-mcp --ingest', () => {
		test('hands off up to three at a time, high first, and keeps the rest queued until one is released', async () => {
			const gates = new Map<string, DeferredPromise<AivisHandoffResult>>();
			const started: string[] = [];
			const runner = (name: string): AivisTaskRunner => ({
				synthesize: async () => ({ audio: Buffer.from(name) }),
				play: async () => { },
				handoff: () => {
					started.push(name);
					const gate = new DeferredPromise<AivisHandoffResult>();
					gates.set(name, gate);
					return gate.p;
				},
			});
			const scheduler = track(createScheduler({ isHandoffAvailable: () => true }));
			scheduler.setHeld(true); // 音声入力中でも渡す（止めるのは worker の hold）
			scheduler.enqueueAivis(runner('n1'), 'normal');
			scheduler.enqueueAivis(runner('n2'), 'normal');
			scheduler.enqueueAivis(runner('n3'), 'normal');
			scheduler.enqueueAivis(runner('h1'), 'high');
			scheduler.enqueueAivis(runner('n4'), 'normal');
			await Promise.resolve();
			const firstWave = [...started];
			gates.get('n1')!.complete({ kind: 'released' });
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
			assert.deepStrictEqual({ firstWave, afterRelease: [...started] }, {
				firstWave: ['n1', 'n2', 'n3'],
				afterRelease: ['n1', 'n2', 'n3', 'h1'],
			});
			for (const gate of gates.values()) {
				if (!gate.isSettled) {
					gate.complete({ kind: 'released' });
				}
			}
		});

		test('plays a handoff that failed before queued with the audio it already received', async () => {
			const events: string[] = [];
			const scheduler = track(createScheduler({ isHandoffAvailable: () => true }));
			scheduler.enqueueAivis({
				synthesize: async () => { events.push('synthesize'); return { audio: Buffer.from('fresh') }; },
				play: async audio => { events.push(`play:${audio.toString()}`); },
				handoff: async attempt => { events.push(`handoff:${attempt}`); return { kind: 'fallback', audio: Buffer.from('received') }; },
			});
			await waitForIdle(scheduler);
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
			assert.deepStrictEqual(events, ['handoff:1', 'play:received']);
		});

		test('retries a retryable synthesis failure and pauses on a fatal one', async () => {
			const events: string[] = [];
			const paused: string[] = [];
			const scheduler = track(createScheduler({ isHandoffAvailable: () => true, sleep: async () => { }, notifyAivisPaused: reason => paused.push(reason) }));
			scheduler.enqueueAivis({
				synthesize: async () => ({ audio: EMPTY_AUDIO }),
				play: async () => { },
				handoff: async attempt => {
					events.push(`handoff:${attempt}`);
					if (attempt === 1) {
						throw new AivisError('retryable', 'timeout');
					}
					return { kind: 'released' };
				},
			});
			scheduler.enqueueAivis({
				synthesize: async () => ({ audio: EMPTY_AUDIO }),
				play: async () => { },
				handoff: async () => { events.push('handoff:fatal'); throw new AivisError('fatal', 'bad key', 401); },
			});
			for (let i = 0; i < 30; i++) {
				await Promise.resolve();
			}
			assert.deepStrictEqual({ events, paused, isPaused: scheduler.isPaused }, {
				events: ['handoff:1', 'handoff:fatal', 'handoff:2'],
				paused: ['bad key'],
				isPaused: true,
			});
		});

		test('falls back to the local playback path when --ingest is unavailable', async () => {
			const events: string[] = [];
			const scheduler = track(createScheduler({ isHandoffAvailable: () => false }));
			scheduler.enqueueAivis({
				...successfulRunner('local', events),
				handoff: async () => { events.push('handoff'); return { kind: 'released' }; },
			});
			await waitForIdle(scheduler);
			assert.deepStrictEqual(events, ['synthesize:local', 'play:local']);
		});

		test('keeps presynthesized local voices out of the rate-limit wait and the fatal pause', async () => {
			const events: string[] = [];
			const sleeps: number[] = [];
			const scheduler = track(createScheduler({ sleep: async ms => { sleeps.push(ms); }, now: () => 0 }));
			// 残り 0 のレート制限を覚えさせてから、fatal で止める
			scheduler.enqueueAivis(successfulRunner('limited', events, { audio: Buffer.from('limited'), rateLimit: { remaining: 0, resetSeconds: 60, capturedAt: 0 } }));
			await waitForIdle(scheduler);
			scheduler.enqueueAivis({
				synthesize: async () => { throw new AivisError('fatal', 'bad key', 401); },
				play: async () => { },
			});
			const entered = scheduler.enqueueAivis({ synthesize: async () => ({ audio: Buffer.from('remote') }), play: async audio => { events.push(`play:${audio.toString()}`); } }, 'normal', { localOnly: true, ignorePause: true, presynthesized: true });
			for (let i = 0; i < 30; i++) {
				await Promise.resolve();
			}
			const enteredWhilePaused = scheduler.enqueueAivis(successfulRunner('dropped', events));
			assert.deepStrictEqual({ events, isPaused: scheduler.isPaused, entered, enteredWhilePaused, sleeps: sleeps.length }, {
				events: ['synthesize:limited', 'play:limited', 'play:remote'],
				isPaused: true,
				entered: true,
				enteredWhilePaused: false,
				// fatal の件はレート制限を待つが、合成済みの声は待たない
				sleeps: 1,
			});
		});

		test('plays the held ringtone when a handoff falls back without audio while the scheduler is paused', async () => {
			const fallback = new DeferredPromise<AivisHandoffResult>();
			const dropped: string[] = [];
			const scheduler = track(createScheduler({ isHandoffAvailable: () => true }));
			scheduler.enqueueAivis({
				synthesize: async () => ({ audio: EMPTY_AUDIO }),
				play: async () => { },
				handoff: async () => { throw new AivisError('fatal', 'bad key', 401); },
				onDropped: () => dropped.push('fatal'),
			});
			scheduler.enqueueAivis({
				synthesize: async () => ({ audio: EMPTY_AUDIO }),
				play: async () => { },
				handoff: () => fallback.p,
				onDropped: () => dropped.push('fallback'),
			});
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
			fallback.complete({ kind: 'fallback' });
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
			assert.deepStrictEqual({ dropped, paused: scheduler.isPaused }, { dropped: ['fatal', 'fallback'], paused: true });
		});
		test('waits for --ingest to come back instead of playing directly while the worker may be alive, up to a limit (H5)', async () => {
			const events: string[] = [];
			let now = 0;
			const scheduler = track(createScheduler({ isHandoffAvailable: () => true, sleep: async () => { }, now: () => now, maxHandoffDeferMs: 5_000 }));
			let calls = 0;
			scheduler.enqueueAivis({
				...successfulRunner('a', events),
				handoff: async () => { events.push(`handoff:${++calls}`); return calls < 3 ? { kind: 'defer' } : { kind: 'released' }; },
			});
			for (let i = 0; i < 40; i++) {
				await Promise.resolve();
			}
			scheduler.enqueueAivis({
				...successfulRunner('b', events),
				handoff: async () => { events.push('handoff:b'); now += 6_000; return { kind: 'defer' }; },
			});
			for (let i = 0; i < 40; i++) {
				await Promise.resolve();
			}
			assert.deepStrictEqual(events, ['handoff:1', 'handoff:2', 'handoff:3', 'handoff:b', 'handoff:b', 'synthesize:b', 'play:b']);
		});

		test('retries a handoff whose synthesis broke before the first audio byte after it was released (M6)', async () => {
			const events: string[] = [];
			const scheduler = track(createScheduler({ isHandoffAvailable: () => true, sleep: async () => { } }));
			scheduler.enqueueAivis({
				synthesize: async () => ({ audio: EMPTY_AUDIO }),
				play: async () => { },
				handoff: async attempt => {
					events.push(`handoff:${attempt}`);
					return { kind: 'released', settled: Promise.resolve(attempt === 1 ? { retry: new AivisError('retryable', 'reset') } : {}) };
				},
			});
			for (let i = 0; i < 40; i++) {
				await Promise.resolve();
			}
			assert.deepStrictEqual(events, ['handoff:1', 'handoff:2']);
		});

		test('keeps at most four transfers in flight even after they are released (H4)', async () => {
			const started: string[] = [];
			const transfers: Array<DeferredPromise<{}>> = [];
			const scheduler = track(createScheduler({ isHandoffAvailable: () => true }));
			for (const name of ['a', 'b', 'c', 'd', 'e']) {
				scheduler.enqueueAivis({
					synthesize: async () => ({ audio: EMPTY_AUDIO }),
					play: async () => { },
					handoff: async () => {
						started.push(name);
						const transfer = new DeferredPromise<{}>();
						transfers.push(transfer);
						return { kind: 'released', settled: transfer.p };
					},
				});
			}
			for (let i = 0; i < 40; i++) {
				await Promise.resolve();
			}
			const whileTransferring = [...started];
			transfers[0].complete({});
			for (let i = 0; i < 40; i++) {
				await Promise.resolve();
			}
			assert.deepStrictEqual({ whileTransferring, after: [...started] }, { whileTransferring: ['a', 'b', 'c', 'd'], after: ['a', 'b', 'c', 'd', 'e'] });
			for (const transfer of transfers) {
				if (!transfer.isSettled) {
					transfer.complete({});
				}
			}
		});

		test('admits accepted voices into reserved slots when the queue is full and never evicts them (M7)', async () => {
			const scheduler = track(createScheduler({ maxQueuedAivisTasks: 1 }));
			scheduler.setHeld(true);
			const runner = successfulRunner('x', []);
			const normal = scheduler.enqueueAivis(runner, 'normal');
			const reserved = Array.from({ length: 9 }, () => scheduler.enqueueAivis(runner, 'normal', { localOnly: true, ignorePause: true, presynthesized: true, reserved: true }));
			const high = scheduler.enqueueAivis(runner, 'high');
			const overflow = scheduler.enqueueAivis(runner, 'normal');
			assert.deepStrictEqual({ normal, reserved, high, overflow, size: scheduler.aivisQueueSize }, {
				normal: true,
				reserved: [true, true, true, true, true, true, true, true, false],
				high: true,
				overflow: false,
				size: 9,
			});
		});

		test('hands synthesized audio back to the worker once before playing it locally (OM2, H5)', async () => {
			const events: string[] = [];
			const scheduler = track(createScheduler({ isHandoffAvailable: () => true }));
			scheduler.enqueueAivis({
				synthesize: async () => { events.push('synthesize'); return { audio: Buffer.from('fresh') }; },
				play: async audio => { events.push(`play:${audio.toString()}`); },
				handoff: async () => { events.push('handoff'); return { kind: 'fallback', audio: Buffer.from('received') }; },
				handoffAudio: async audio => { events.push(`handoff-audio:${audio.toString()}`); return { kind: 'fallback', audio }; },
			});
			for (let i = 0; i < 40; i++) {
				await Promise.resolve();
			}
			await waitForIdle(scheduler);
			assert.deepStrictEqual(events, ['handoff', 'handoff-audio:received', 'play:received']);
		});

		test('keeps the rate limit reported by a handoff that fell back (M8)', async () => {
			const sleeps: number[] = [];
			const scheduler = track(createScheduler({ isHandoffAvailable: () => true, sleep: async ms => { sleeps.push(ms); }, now: () => 0 }));
			scheduler.enqueueAivis({
				...successfulRunner('first', []),
				handoff: async () => ({ kind: 'fallback', rateLimit: { remaining: 0, resetSeconds: 10, capturedAt: 0 } }),
			});
			for (let i = 0; i < 40; i++) {
				await Promise.resolve();
			}
			// 合成し直す前に、覚えたレート制限の窓が空くのを待つ
			assert.deepStrictEqual(sleeps, [10_500]);
		});
		test('puts a handed-back task back at its original place instead of the front, and holds later ones while it waits (M-2)', async () => {
			const started: string[] = [];
			let firstCalls = 0;
			const scheduler = track(createScheduler({ isHandoffAvailable: () => true, sleep: async () => { }, maxConcurrentHandoffs: 1 }));
			const runner = (name: string): AivisTaskRunner => ({
				synthesize: async () => ({ audio: EMPTY_AUDIO }),
				play: async () => { },
				handoff: async () => {
					started.push(name);
					if (name === 'a' && ++firstCalls === 1) {
						return { kind: 'defer' };
					}
					return { kind: 'released' };
				},
			});
			scheduler.enqueueAivis(runner('a'));
			scheduler.enqueueAivis(runner('b'));
			scheduler.enqueueAivis(runner('c'));
			for (let i = 0; i < 60; i++) {
				await Promise.resolve();
			}
			assert.deepStrictEqual(started, ['a', 'a', 'b', 'c']);
		});

		test('stops waiting for --ingest after one deferral timed out, until a handoff succeeds again (M-3)', async () => {
			const events: string[] = [];
			let now = 0;
			let mode: 'defer' | 'release' = 'defer';
			const scheduler = track(createScheduler({ isHandoffAvailable: () => true, sleep: async () => { now += 1_000; }, now: () => now, maxHandoffDeferMs: 2_000 }));
			const runner = (name: string): AivisTaskRunner => ({
				...successfulRunner(name, events),
				handoff: async () => { events.push(`handoff:${name}`); return mode === 'defer' ? { kind: 'defer' } : { kind: 'released' }; },
			});
			scheduler.enqueueAivis(runner('a'));
			for (let i = 0; i < 80; i++) {
				await Promise.resolve();
			}
			// 一度待ちきれなかった後は、待たずに Para Code が鳴らす
			scheduler.enqueueAivis(runner('b'));
			for (let i = 0; i < 80; i++) {
				await Promise.resolve();
			}
			mode = 'release';
			scheduler.enqueueAivis(runner('c'));
			for (let i = 0; i < 80; i++) {
				await Promise.resolve();
			}
			mode = 'defer';
			scheduler.enqueueAivis(runner('d'));
			for (let i = 0; i < 20; i++) {
				await Promise.resolve();
			}
			// 渡せた（c）後は、また復旧を待つ（d はすぐには Para Code が鳴らさず、渡し直す）
			assert.deepStrictEqual(events.slice(0, 11), ['handoff:a', 'handoff:a', 'handoff:a', 'synthesize:a', 'play:a', 'handoff:b', 'synthesize:b', 'play:b', 'handoff:c', 'handoff:d', 'handoff:d']);
		});

		test('waits for --ingest again once a child introduced itself, even before a handoff succeeded (LOW)', async () => {
			const events: string[] = [];
			let now = 0;
			const scheduler = track(createScheduler({ isHandoffAvailable: () => true, sleep: async () => { now += 1_000; }, now: () => now, maxHandoffDeferMs: 2_000 }));
			const runner = (name: string): AivisTaskRunner => ({
				...successfulRunner(name, events),
				handoff: async () => { events.push(`handoff:${name}`); return { kind: 'defer' }; },
			});
			scheduler.enqueueAivis(runner('a'));
			for (let i = 0; i < 80; i++) {
				await Promise.resolve();
			}
			// 子が名乗った（その後また起こし直しになった）。時間切れを忘れて、b はまた復旧を待つ
			scheduler.noteHandoffReady();
			scheduler.enqueueAivis(runner('b'));
			for (let i = 0; i < 20; i++) {
				await Promise.resolve();
			}
			assert.deepStrictEqual(events.slice(0, 7), ['handoff:a', 'handoff:a', 'handoff:a', 'synthesize:a', 'play:a', 'handoff:b', 'handoff:b']);
		});
	});
});
