// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '../../store.js';
import { openSessionTarget } from './openSessionTarget.js';

type Terminal = WorkspaceState['terminals'][number];

function terminal(terminalKey: string, extra: Partial<Terminal> = {}): Terminal {
	return { terminalKey, id: 1, windowId: 1, rendererGeneration: 1, title: terminalKey, ...extra };
}

const base = { ready: true, pcCount: 1, activePcId: 'pc-1' };

describe('openSessionTarget', () => {
	it('waits until the ledger and the PC state are ready', () => {
		expect(openSessionTarget({ ...base, ready: false, workspace: undefined }).kind).toBe('wait');
		expect(openSessionTarget({ ...base, workspace: undefined }).kind).toBe('wait');
		expect(openSessionTarget({ ...base, workspace: { complete: false, terminals: [], activeWs: undefined } }).kind).toBe('wait');
	});

	it('goes home when nothing is paired or nothing needs attention', () => {
		expect(openSessionTarget({ ...base, pcCount: 0, activePcId: undefined, workspace: undefined }).kind).toBe('home');
		expect(openSessionTarget({ ...base, workspace: { complete: true, terminals: [terminal('t1', { agent: true, agentStatus: 'working', ws: 'w1' })], activeWs: 'w1' } }).kind).toBe('home');
	});

	it('opens the session of the agent that needs attention', () => {
		const target = openSessionTarget({
			...base,
			workspace: {
				complete: true,
				terminals: [terminal('t1', { agent: true, agentStatus: 'working', ws: 'w1' }), terminal('t2', { agent: true, agentStatus: 'permission', ws: 'w2' })],
				activeWs: 'w1',
			},
		});
		expect(target).toEqual({ kind: 'session', pcId: 'pc-1', spaceId: 'w2', terminalKey: 't2' });
	});

	it('falls back to the active space, then to the PC screen', () => {
		const waiting = terminal('t1', { agent: true, agentStatus: 'permission' });
		expect(openSessionTarget({ ...base, workspace: { complete: true, terminals: [waiting], activeWs: 'w1' } })).toEqual({ kind: 'session', pcId: 'pc-1', spaceId: 'w1', terminalKey: 't1' });
		expect(openSessionTarget({ ...base, workspace: { complete: true, terminals: [waiting], activeWs: undefined } })).toEqual({ kind: 'pc', pcId: 'pc-1' });
	});
});
