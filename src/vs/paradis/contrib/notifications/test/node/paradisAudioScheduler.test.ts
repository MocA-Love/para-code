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
});
