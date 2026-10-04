// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { WorkspaceState } from './store.js';
import {
	defaultSessionTab,
	findPc,
	findSpace,
	pcRouteStatus,
	resolveSessionTab,
	sessionTabToPin,
	spaceIdOfTerminal,
	spaceRouteStatus,
	spaceTerminals,
} from './navigationTargets.js';

type Terminal = WorkspaceState['terminals'][number];

function terminal(terminalKey: string, ws: string | undefined, extra: Partial<Terminal> = {}): Terminal {
	return { terminalKey, id: 1, windowId: 1, rendererGeneration: 1, title: terminalKey, ws, ...extra };
}

function workspace(terminals: Terminal[], complete = true): WorkspaceState {
	return {
		protocolVersion: 4,
		desktopEpoch: 'epoch',
		revision: 1,
		complete,
		renderers: [{ windowId: 1, rendererGeneration: 1, ready: true }],
		activeWs: '1:w1',
		workspaces: [
			{ id: '1:w1', sourceId: 'w1', windowId: 1, name: 'app' },
			{ id: '1:w2', sourceId: 'w2', windowId: 1, name: 'docs' },
		],
		terminals,
	};
}

describe('PC', () => {
	const pcs = [{ id: 'pc-a' }, { id: 'pc-b' }];

	test('台帳から引く', () => {
		expect(findPc(pcs, 'pc-b')).toEqual({ id: 'pc-b' });
		expect(findPc(pcs, 'pc-x')).toBeUndefined();
		expect(findPc(pcs, undefined)).toBeUndefined();
	});

	test('いま見ている PC か、切り替えが要るか、台帳に無いか', () => {
		expect(pcRouteStatus(pcs, 'pc-a', 'pc-a')).toBe('active');
		expect(pcRouteStatus(pcs, 'pc-a', 'pc-b')).toBe('inactive');
		expect(pcRouteStatus(pcs, 'pc-a', 'pc-x')).toBe('unknown');
		expect(pcRouteStatus(pcs, undefined, undefined)).toBe('unknown');
	});
});

describe('スペース', () => {
	test('ID で引く', () => {
		expect(findSpace(workspace([]), '1:w2')?.name).toBe('docs');
		expect(findSpace(workspace([]), '9:w9')).toBeUndefined();
		expect(findSpace(undefined, '1:w1')).toBeUndefined();
	});

	test('全体が届く前は「無い」と決めつけない', () => {
		expect(spaceRouteStatus(undefined, '1:w1')).toBe('loading');
		expect(spaceRouteStatus(workspace([], false), '9:w9')).toBe('loading');
		expect(spaceRouteStatus(workspace([], true), '9:w9')).toBe('missing');
		expect(spaceRouteStatus(workspace([], false), '1:w1')).toBe('ready');
	});

	test('スペースに属するターミナルを届いた順で返す', () => {
		const ws = workspace([terminal('a', '1:w1'), terminal('b', '1:w2'), terminal('c', '1:w1'), terminal('d', undefined)]);
		expect(spaceTerminals(ws, '1:w1').map(t => t.terminalKey)).toEqual(['a', 'c']);
		expect(spaceTerminals(ws, undefined)).toEqual([]);
		expect(spaceIdOfTerminal(ws, 'b')).toBe('1:w2');
		expect(spaceIdOfTerminal(ws, 'd')).toBeUndefined();
		expect(spaceIdOfTerminal(ws, 'zz')).toBeUndefined();
	});
});

describe('セッションのタブ', () => {
	const ws = workspace([
		terminal('shell', '1:w1'),
		terminal('agent-idle', '1:w1', { agent: true }),
		terminal('agent-ask', '1:w1', { agent: true, agentStatus: 'question' }),
		terminal('other', '1:w2', { agent: true, agentStatus: 'permission' }),
	]);

	test('指定が無ければ 要対応のエージェント → エージェント → 先頭 の順', () => {
		expect(defaultSessionTab(spaceTerminals(ws, '1:w1'))).toEqual({ kind: 'terminal', terminalKey: 'agent-ask' });
		expect(defaultSessionTab([terminal('s', '1:w1'), terminal('ag', '1:w1', { agent: true })])).toEqual({ kind: 'terminal', terminalKey: 'ag' });
		expect(defaultSessionTab([terminal('s', '1:w1')])).toEqual({ kind: 'terminal', terminalKey: 's' });
		expect(defaultSessionTab([])).toBeUndefined();
	});

	test('指定されたターミナルを開く', () => {
		const resolved = resolveSessionTab(ws, '1:w1', { kind: 'terminal', terminalKey: 'shell' });
		expect(resolved.status === 'terminal' ? resolved.terminal.terminalKey : resolved.status).toBe('shell');
	});

	test('指定されたターミナルが見つからなくても、別のタブへすり替えない', () => {
		expect(resolveSessionTab(ws, '1:w1', { kind: 'terminal', terminalKey: 'gone' })).toEqual({ status: 'missing' });
		// 別のスペースのターミナルを指定されても開かない
		expect(resolveSessionTab(ws, '1:w1', { kind: 'terminal', terminalKey: 'other' })).toEqual({ status: 'missing' });
		// 全体が届く前は待つ
		expect(resolveSessionTab(workspace([], false), '1:w1', { kind: 'terminal', terminalKey: 'gone' })).toEqual({ status: 'loading' });
	});

	test('指定が無いときは既定のタブ、ターミナルが無ければ空', () => {
		const resolved = resolveSessionTab(ws, '1:w1', undefined);
		expect(resolved.status === 'terminal' ? resolved.terminal.terminalKey : resolved.status).toBe('agent-ask');
		expect(resolveSessionTab(workspace([]), '1:w1', undefined)).toEqual({ status: 'empty' });
		expect(resolveSessionTab(undefined, '1:w1', undefined)).toEqual({ status: 'loading' });
	});

	test('ブラウザはスペースに1つなので、指定されればそのまま開く', () => {
		expect(resolveSessionTab(ws, '1:w1', { kind: 'browser' })).toEqual({ status: 'browser' });
	});

	test('指定なしで開いたときだけ、既定で開いたタブを固定する', () => {
		expect([
			sessionTabToPin(undefined, resolveSessionTab(ws, '1:w1', undefined), true),
			sessionTabToPin({ kind: 'terminal', terminalKey: 'shell' }, resolveSessionTab(ws, '1:w1', { kind: 'terminal', terminalKey: 'shell' }), true),
			sessionTabToPin(undefined, resolveSessionTab(workspace([]), '1:w1', undefined), true),
			sessionTabToPin(undefined, resolveSessionTab(undefined, '1:w1', undefined), false),
			// 全体が届く前（要対応のエージェントがまだ届いていないかもしれない）は固定しない
			sessionTabToPin(undefined, resolveSessionTab(ws, '1:w1', undefined), false),
		]).toEqual([{ kind: 'terminal', terminalKey: 'agent-ask' }, undefined, undefined, undefined, undefined]);
	});
});
