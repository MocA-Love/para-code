// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { displayedRoute, routeFromStats, type RtcStatLike } from './browserRoute.js';

function report(stats: readonly RtcStatLike[]): Map<string, RtcStatLike> {
	return new Map(stats.map(stat => [stat.id ?? '', stat]));
}

function pairOf(local: string, remote: string, viaTransport: boolean): Map<string, RtcStatLike> {
	return report([
		...(viaTransport ? [{ id: 'T1', type: 'transport', selectedCandidatePairId: 'P1' }] : []),
		{ id: 'P0', type: 'candidate-pair', localCandidateId: 'L0', remoteCandidateId: 'R0', nominated: false, state: 'failed' },
		{ id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', nominated: true, state: 'succeeded' },
		{ id: 'L0', type: 'local-candidate', candidateType: 'relay' },
		{ id: 'R0', type: 'remote-candidate', candidateType: 'relay' },
		{ id: 'L1', type: 'local-candidate', candidateType: local },
		{ id: 'R1', type: 'remote-candidate', candidateType: remote },
	]);
}

describe('browser mirror route', () => {
	test('選ばれた候補の組の種類から経路を決める（transport が無ければ nominated かつ succeeded の組）', () => {
		expect([
			routeFromStats(pairOf('host', 'host', true)),
			routeFromStats(pairOf('srflx', 'host', true)),
			routeFromStats(pairOf('prflx', 'srflx', false)),
			routeFromStats(pairOf('host', 'relay', true)),
			routeFromStats(pairOf('relay', 'srflx', false)),
			routeFromStats(report([{ id: 'T1', type: 'transport', selectedCandidatePairId: 'missing' }])),
			routeFromStats(report([])),
		]).toEqual(['lan', 'direct', 'direct', 'turn', 'turn', undefined, undefined]);
	});

	test('JPEG を写しているときはリレーサーバー経由、WebRTC の経路が分からない間は出さない', () => {
		expect([
			displayedRoute(true, 'lan', true),
			displayedRoute(true, undefined, true),
			displayedRoute(false, 'lan', true),
			displayedRoute(false, undefined, false),
		]).toEqual(['lan', undefined, 'relay', undefined]);
	});
});
