// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { defaultRelayHostId, localRelayWindowId, relayHostsFrom, wantsClaudeHost, type RelayHostRendererLike } from './relayHosts.js';

describe('relayHostsFrom', () => {
	test('host未配信のrendererは無視する（旧PC・state未同期のウィンドウ）', () => {
		const renderers: RelayHostRendererLike[] = [
			{ windowId: 1, ready: true },
			{ windowId: 2, ready: true, host: { kind: 'local', id: 'local' } },
		];
		expect(relayHostsFrom(renderers).map(h => h.id)).toEqual(['local']);
	});

	test('同一ホストの複数ウィンドウはhost.idで1件に束ねる（無意味な重複を出さない）', () => {
		const renderers: RelayHostRendererLike[] = [
			{ windowId: 1, ready: true, host: { kind: 'local', id: 'local' } },
			{ windowId: 2, ready: true, host: { kind: 'local', id: 'local' } },
		];
		expect(relayHostsFrom(renderers)).toHaveLength(1);
	});

	test('同一ホストで一方だけreadyなら、readyな方を代表ウィンドウに選ぶ', () => {
		const renderers: RelayHostRendererLike[] = [
			{ windowId: 1, ready: false, host: { kind: 'remote', id: 'ssh-remote+x', label: 'x' } },
			{ windowId: 2, ready: true, host: { kind: 'remote', id: 'ssh-remote+x', label: 'x' } },
		];
		const hosts = relayHostsFrom(renderers);
		expect(hosts).toHaveLength(1);
		expect(hosts[0]?.windowId).toBe(2);
		expect(hosts[0]?.ready).toBe(true);
	});

	test('local を先頭、以降はラベル順に並べる', () => {
		const renderers: RelayHostRendererLike[] = [
			{ windowId: 1, ready: true, host: { kind: 'remote', id: 'b', label: 'zeta' } },
			{ windowId: 2, ready: true, host: { kind: 'remote', id: 'a', label: 'alpha' } },
			{ windowId: 3, ready: true, host: { kind: 'local', id: 'local' } },
		];
		expect(relayHostsFrom(renderers).map(h => h.id)).toEqual(['local', 'a', 'b']);
	});

	test('localのラベルは常に「ローカル」（PC側のkind=localに付くlabelは無視する）', () => {
		const renderers: RelayHostRendererLike[] = [
			{ windowId: 1, ready: true, host: { kind: 'local', id: 'local' } },
		];
		expect(relayHostsFrom(renderers)[0]?.label).toBe('ローカル');
	});

	test('remoteのラベル未配信時はhost.idをそのまま使う', () => {
		const renderers: RelayHostRendererLike[] = [
			{ windowId: 1, ready: true, host: { kind: 'remote', id: 'ssh-remote+myserver' } },
		];
		expect(relayHostsFrom(renderers)[0]?.label).toBe('ssh-remote+myserver');
	});
});

describe('defaultRelayHostId', () => {
	const renderers: RelayHostRendererLike[] = [
		{ windowId: 1, ready: true, host: { kind: 'local', id: 'local' } },
		{ windowId: 2, ready: true, host: { kind: 'remote', id: 'b', label: 'myserver' } },
	];
	const hosts = relayHostsFrom(renderers);

	test('activeWindowId が一致するホストを優先する', () => {
		expect(defaultRelayHostId(hosts, renderers, 2)).toBe('b');
	});

	test('activeWindowId未指定・不一致のときは最初のreadyホストへ落ちる', () => {
		expect(defaultRelayHostId(hosts, renderers, undefined)).toBe('local');
		expect(defaultRelayHostId(hosts, renderers, 999)).toBe('local');
	});

	test('ホストが1件も無ければundefined', () => {
		expect(defaultRelayHostId([], [], undefined)).toBeUndefined();
	});

	test('activeWindowIdが同一ホストの非代表ウィンドウでも、そのホストを優先する（代表ウィンドウだけの比較だと外れる）', () => {
		// windowId 2, 3 は同じリモートホスト。relayHostsFrom は 2 を代表に選ぶが、
		// activeWs は 3 にある想定。windowId直接比較だと外れてローカルへ落ちてしまう。
		const multiWindowRenderers: RelayHostRendererLike[] = [
			{ windowId: 1, ready: true, host: { kind: 'local', id: 'local' } },
			{ windowId: 2, ready: true, host: { kind: 'remote', id: 'b', label: 'myserver' } },
			{ windowId: 3, ready: true, host: { kind: 'remote', id: 'b', label: 'myserver' } },
		];
		const multiWindowHosts = relayHostsFrom(multiWindowRenderers);
		expect(defaultRelayHostId(multiWindowHosts, multiWindowRenderers, 3)).toBe('b');
	});
});

describe('localRelayWindowId', () => {
	test('応答できるローカルのウィンドウだけを選ぶ（無ければ名指ししない）', () => {
		const ssh = { kind: 'remote', id: 'ssh-remote+x', label: 'x' } as const;
		const local = { kind: 'local', id: 'local' } as const;
		expect({
			sshFirst: localRelayWindowId([{ windowId: 1, ready: true, host: ssh }, { windowId: 2, ready: false, host: local }, { windowId: 3, ready: true, host: local }]),
			onlySsh: localRelayWindowId([{ windowId: 1, ready: true, host: ssh }]),
			oldPc: localRelayWindowId([{ windowId: 1, ready: true }]),
			noState: localRelayWindowId(undefined),
		}).toEqual({ sshFirst: 3, onlySsh: undefined, oldPc: undefined, noState: undefined });
	});
});

describe('wantsClaudeHost', () => {
	test('使用量の画面で接続先を選んだときだけ、接続先の Claude を頼む', () => {
		expect({
			remote: wantsClaudeHost({ id: 'ssh-remote+x', kind: 'remote', label: 'x', windowId: 2, ready: true }),
			local: wantsClaudeHost({ id: 'local', kind: 'local', label: 'ローカル', windowId: 1, ready: true }),
			none: wantsClaudeHost(undefined),
		}).toEqual({ remote: true, local: false, none: false });
	});
});
