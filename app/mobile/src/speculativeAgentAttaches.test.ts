// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { SpeculativeAgentAttaches } from './speculativeAgentAttaches.js';

describe('SpeculativeAgentAttaches', () => {
	test('skips only attaches already sent to the same target, and forgets them after each resume', () => {
		const ledger = new SpeculativeAgentAttaches();
		const sentTargets = new Map([['a', 'w1:1'], ['b', 'w1:1']]);
		const currentTargets = new Map([['a', 'w1:1'], ['b', 'w2:1'], ['c', 'w1:1']]);
		ledger.reset();
		ledger.add('a');
		ledger.add('b');
		const keys = ['a', 'b', 'c'];
		const first = ledger.takeResends(keys, key => currentTargets.get(key), key => sentTargets.get(key));
		// 同じ記録で 2 回目の張り直し（預かりのあふれなど）が来たら、全部送る
		const second = ledger.takeResends(keys, key => currentTargets.get(key), key => sentTargets.get(key));
		expect({ first, second }).toEqual({ first: ['b', 'c'], second: ['a', 'b', 'c'] });
	});
});
