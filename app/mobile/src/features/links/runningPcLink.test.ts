// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { isPcPath, relayRunningPcLink } from './runningPcLink.js';

describe('relayRunningPcLink', () => {
	test('PC の中の画面へのリンクは、クエリごと中継の画面へ渡す', () => {
		expect([
			relayRunningPcLink('/pc/pc-1/session/1:w1?tab=terminal:t1&latest=x'),
			relayRunningPcLink('paracode-mobile:///pc/pc-1#frag'),
			relayRunningPcLink('paracode-mobile://pc/pc-1/source-control/1:w1'),
		]).toEqual([
			'/open-session?to=%2Fpc%2Fpc-1%2Fsession%2F1%3Aw1%3Ftab%3Dterminal%3At1%26latest%3Dx',
			'/open-session?to=%2Fpc%2Fpc-1',
			'/open-session?to=%2Fpc%2Fpc-1%2Fsource-control%2F1%3Aw1',
		]);
	});

	test('ほかの画面・ほかのスキームはそのまま', () => {
		const others = ['/', '/settings/terminal', '/open-session?latest=a', 'paracode-mobile://pair?d=abc', 'exp+para://expo-development-client/?url=x', '/pcs'];
		expect(others.map(relayRunningPcLink)).toEqual(others);
	});
});

describe('isPcPath', () => {
	test('PC の中の画面だけを通す', () => {
		expect(['/pc/pc-1', '/pc/pc-1/', '/pc/pc-1/session/1%3Aw1?path=a/../b', '/pc/', '/settings', 'https://example.com/pc/x'].map(isPcPath)).toEqual([true, true, true, false, false, false]);
	});

	test('PC の外へ出る区切り（`.`・`..`・その符号化・空・壊れた符号化）は拒む', () => {
		const escapes = [
			'/pc/x/../../settings',
			'/pc/x/./session/a',
			'/pc/../settings',
			'/pc/x/%2e%2e/%2E%2E/settings',
			'/pc/x/.%2e/settings',
			'/pc/x/%2e',
			'/pc/x/a%2f..%2fb',
			'/pc/x/a%5cb',
			'/pc/x//session',
			'/pc/x/%E0%A4%A',
		];
		expect(escapes.map(isPcPath)).toEqual(escapes.map(() => false));
	});
});
