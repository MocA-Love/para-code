// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { rpcErrorText } from '../src/format.js';

describe('rpcErrorText', () => {
	test('network の失敗は、HTTP の状態があれば添えて出す', () => {
		expect([
			rpcErrorText('network', 'HTTP 502'),
			rpcErrorText('network', 'Failed to fetch'),
			rpcErrorText('network', 'unauthorized'),
		]).toEqual([
			'サーバーが応答しませんでした（HTTP 502）',
			'サーバーにつながりません',
			'サーバーのトークンが変わりました。ターミナルの URL を開き直してください',
		]);
	});
});
