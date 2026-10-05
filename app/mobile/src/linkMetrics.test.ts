// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { paradisParseMetricsPing } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileLinkMetrics.js';
import { AppLinkMetrics, formatAppLinkMetricsReport, type VoicePlaybackCounters } from './linkMetrics.js';

function harness(voice?: () => VoicePlaybackCounters | undefined) {
	let now = 0;
	let tick: (() => void) | undefined;
	const metrics = new AppLinkMetrics({
		now: () => now,
		wallClock: () => 1_700_000_000_000,
		setInterval: callback => { tick = callback; return 1; },
		clearInterval: () => { tick = undefined; },
		...(voice !== undefined ? { readVoiceStats: voice } : {}),
	});
	return {
		metrics,
		advance: (ms: number) => { now += ms; },
		tick: () => tick?.(),
		ticking: () => tick !== undefined,
		counts: () => Object.fromEntries(Object.entries(metrics.snapshot().histograms).map(([name, summary]) => [name, summary.count])),
	};
}

describe('AppLinkMetrics', () => {
	test('records nothing and sends no ping while off', () => {
		const h = harness();
		const sent: string[] = [];
		h.metrics.registerPinger(text => { sent.push(text); return true; });
		h.metrics.noteInput();
		h.metrics.noteTermData(3);
		h.metrics.noteChunk({ ch: 'term', bytes: 10, more: false, openMs: 1 });
		h.tick();
		expect({ counts: h.counts(), sent, ticking: h.ticking() }).toEqual({ counts: {}, sent: [], ticking: false });
	});

	test('measures a key from the send through the echo to the drawn frame', () => {
		const h = harness();
		h.metrics.setEnabled(true);
		const inputAt = h.metrics.noteInput();
		h.advance(4);
		h.metrics.noteInputSent(inputAt);
		h.advance(60);
		h.metrics.noteTermData(1);
		const injectedAt = h.metrics.noteTermInjected()!;
		h.advance(10);
		h.metrics.noteTermDrawn(injectedAt);
		const snapshot = h.metrics.snapshot();
		expect({
			send: snapshot.histograms['app.term.input.sendMs']?.max,
			receive: snapshot.histograms['app.term.echo.keyToReceiveMs']?.max,
			draw: snapshot.histograms['app.term.drawMs']?.max,
			keyToDraw: snapshot.histograms['app.term.echo.keyToDrawMs']?.max,
		}).toEqual({ send: 4, receive: 64, draw: 10, keyToDraw: 74 });
	});

	test('pings every two seconds only through registered senders and carries the last round trip', () => {
		const h = harness();
		const sent: string[] = [];
		h.metrics.registerPinger(text => { sent.push(text); return true; });
		h.metrics.setEnabled(true);
		h.tick();
		h.tick();
		h.advance(80);
		const first = paradisParseMetricsPing(sent[0]!)!;
		h.metrics.notePong(first.id);
		h.metrics.notePong(first.id);
		h.tick();
		h.tick();
		expect({ pings: sent.map(text => paradisParseMetricsPing(text)), rtt: h.metrics.snapshot().histograms['app.rtt.ms'] }).toEqual({
			pings: [{ id: 0 }, { id: 1, rttMs: 80 }],
			rtt: { count: 1, min: 80, max: 80, mean: 80, p50: 80, p95: 80, p99: 80 },
		});
	});

	test('counts voice start delay, underruns, drops and prebuffer changes from the native counters', () => {
		let stats: VoicePlaybackCounters = { started: 0, underruns: 0, dropped: 0, prebufferMs: 500, lastStartDelayMs: -1 };
		const h = harness(() => stats);
		h.metrics.setEnabled(true);
		h.metrics.noteVoiceStart('s1');
		h.advance(30);
		h.metrics.noteVoiceChunk('s1');
		h.metrics.noteVoiceChunk('s1');
		stats = { started: 1, underruns: 2, dropped: 1, prebufferMs: 750, lastStartDelayMs: 640 };
		h.tick();
		h.metrics.noteVoiceEnd('s1', true);
		const snapshot = h.metrics.snapshot();
		expect({ histograms: h.counts(), ttfa: snapshot.histograms['app.voice.timeToFirstAudioMs']?.max, firstChunk: snapshot.histograms['app.voice.firstChunkMs']?.max, counters: snapshot.counters }).toEqual({
			histograms: { 'app.voice.firstChunkMs': 1, 'app.voice.prebufferMs': 1, 'app.voice.timeToFirstAudioMs': 1 },
			ttfa: 640,
			firstChunk: 30,
			counters: { 'app.voice.abortedStreams': 1, 'app.voice.dropped': 1, 'app.voice.prebufferRaised': 1, 'app.voice.streams': 1, 'app.voice.underruns': 2 },
		});
	});

	test('measures the delivery rate of a fragmented transfer and formats the report without content', () => {
		const h = harness();
		h.metrics.setEnabled(true);
		h.metrics.noteChunk({ ch: 'fs', bytes: 64 * 1024, more: true, openMs: 0.5 });
		h.advance(500);
		h.metrics.noteChunk({ ch: 'fs', bytes: 64 * 1024, more: false, openMs: 0.5 });
		const snapshot = h.metrics.snapshot();
		const report = JSON.parse(formatAppLinkMetricsReport(snapshot, '0.0.0', 1)) as { source: string; appVersion: string; histograms: Record<string, { max: number }> };
		expect({ source: report.source, appVersion: report.appVersion, rate: report.histograms['app.rx.burstKiBps']?.max, burst: report.histograms['app.rx.fs.burstMs']?.max, opens: h.counts()['app.rx.openMs'] })
			.toEqual({ source: 'app', appVersion: '0.0.0', rate: 256, burst: 500, opens: 2 });
	});
});
