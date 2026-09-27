// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { stackWithoutRoute } from './pcStackAnchor.js';

const state = {
	type: 'stack',
	index: 2,
	routes: [{ key: 'anchor' }, { key: 'pc-a' }, { key: 'pc-b' }],
};

describe('stackWithoutRoute', () => {
	test('下に敷かれた PC の無い器を除き、前面のルートはそのまま（index を詰める）', () => {
		expect(stackWithoutRoute(state, 'anchor')).toEqual({ type: 'stack', index: 1, routes: [{ key: 'pc-a' }, { key: 'pc-b' }] });
	});

	test('前面のルート・見つからないルートは除かない', () => {
		expect([stackWithoutRoute(state, 'pc-b'), stackWithoutRoute(state, 'missing')]).toEqual([undefined, undefined]);
	});
});
