// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { mergeWorkspaceState, type WorkspaceState } from './store.js';
import { reuseWorkspaceState } from './workspaceIdentity.js';

/**
 * 構造共有の境目を固定するテスト。本質は2つ。
 * 「値が同じなら参照を据え置く」ことと、「引き継ぎは絶対にしない」こと（特に resources）。
 */

/** PCから届く経路と同じ形で新品参照を作る（store は JSON.parse で受け取る）。 */
function clone(state: WorkspaceState): WorkspaceState {
	return JSON.parse(JSON.stringify(state)) as WorkspaceState;
}

function makeState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
	return {
		protocolVersion: 3,
		desktopEpoch: 'epoch-1',
		revision: 1,
		complete: true,
		renderers: [{ windowId: 1, rendererGeneration: 1, ready: true }],
		activeWs: 'ws-1',
		workspaces: [{ id: 'ws-1', sourceId: 'src-1', windowId: 1, name: 'Repo' }],
		terminals: [
			{ terminalKey: 't-1', id: 1, windowId: 1, rendererGeneration: 1, title: 'zsh' },
			{ terminalKey: 't-2', id: 2, windowId: 1, rendererGeneration: 1, title: 'claude' },
		],
		...overrides,
	};
}

describe('reuseWorkspaceState', () => {
	test('値が完全に同じなら前回の state をそのまま返す', () => {
		const previous = makeState();
		expect(reuseWorkspaceState(previous, clone(previous))).toBe(previous);
	});

	test('ターミナル1件の変化では、変わった配列と要素だけが新品になる', () => {
		const previous = makeState();
		const next = clone(previous);
		next.terminals = next.terminals.map((terminal, index) => index === 1 ? { ...terminal, title: 'vim' } : terminal);
		const result = reuseWorkspaceState(previous, next);
		expect({
			whole: result === previous,
			renderers: result.renderers === previous.renderers,
			workspaces: result.workspaces === previous.workspaces,
			terminals: result.terminals === previous.terminals,
			unchangedTerminal: result.terminals[0] === previous.terminals[0],
			changedTerminal: result.terminals[1] === next.terminals[1],
		}).toEqual({
			whole: false,
			renderers: true,
			workspaces: true,
			terminals: false,
			unchangedTerminal: true,
			changedTerminal: true,
		});
	});

	test('並び順が変わったら「変化」として扱う（画面の並びが変わるため）', () => {
		const previous = makeState();
		const next = clone(previous);
		next.terminals.reverse();
		const result = reuseWorkspaceState(previous, next);
		expect({
			terminals: result.terminals === previous.terminals,
			order: result.terminals.map(terminal => terminal.terminalKey),
		}).toEqual({ terminals: false, order: ['t-2', 't-1'] });
	});

	test('resources が届かなくなったら引き継がずに消す（もう配信しない、の意味）', () => {
		const previous = makeState({ resources: { memUsed: 1_000, memTotal: 8_000 } });
		const result = reuseWorkspaceState(previous, clone(makeState()));
		expect(result.resources).toBeUndefined();
	});

	test('battery も同様に、消えたら消えたまま・付いたら新しい値を採る', () => {
		const withBattery = makeState({ battery: { level: 50, charging: false } });
		const removed = reuseWorkspaceState(withBattery, clone(makeState()));
		const added = reuseWorkspaceState(makeState(), clone(withBattery));
		expect({ removed: removed.battery, added: added.battery })
			.toEqual({ removed: undefined, added: { level: 50, charging: false } });
	});

	test('入れ子（pr / note）の変化も拾い、無関係な配列は据え置く', () => {
		const previous = makeState({
			workspaces: [{ id: 'ws-1', sourceId: 'src-1', windowId: 1, name: 'Repo', pr: { number: 7, state: 'open', url: 'https://example.test/7' } }],
		});
		const next = clone(previous);
		next.workspaces = next.workspaces.map(workspace => ({ ...workspace, pr: { number: 7, state: 'merged' as const, url: 'https://example.test/7' } }));
		const result = reuseWorkspaceState(previous, next);
		expect({
			workspaces: result.workspaces === previous.workspaces,
			terminals: result.terminals === previous.terminals,
			state: result.workspaces[0]?.pr?.state,
		}).toEqual({ workspaces: false, terminals: true, state: 'merged' });
	});

	test('部分state（complete:false）でも、変わっていない配列は据え置かれる', () => {
		const previous = makeState();
		const incoming = clone(makeState({ complete: false, revision: 2 }));
		const applied = reuseWorkspaceState(previous, mergeWorkspaceState(previous, incoming));
		expect({
			whole: applied === previous,
			revision: applied.revision,
			terminals: applied.terminals === previous.terminals,
			workspaces: applied.workspaces === previous.workspaces,
		}).toEqual({ whole: false, revision: 2, terminals: true, workspaces: true });
	});
});
