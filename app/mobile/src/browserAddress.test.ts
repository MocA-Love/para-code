// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { addressHost, addressLabel, classifyBrowserAddress, legacyNavigateUrl } from './browserAddress.js';

describe('browser address', () => {
	test('打った文字を URL か検索に分ける（手元の網の中は http、それ以外は https を付ける）', () => {
		const inputs = ['', '  https://example.com/a  ', 'http://localhost:3000', 'example.com', 'docs.example.co.jp/path?q=1', 'localhost:5173', '192.168.1.10:8080/app', 'devbox:3000', 'my-pc.local', 'worktree', 'para code mobile', 'https://example.com/a b', 'xn--eckwd4c7c.xn--zckzah'];
		expect(inputs.map(classifyBrowserAddress)).toEqual([
			undefined,
			{ kind: 'url', url: 'https://example.com/a' },
			{ kind: 'url', url: 'http://localhost:3000' },
			{ kind: 'url', url: 'https://example.com' },
			{ kind: 'url', url: 'https://docs.example.co.jp/path?q=1' },
			{ kind: 'url', url: 'http://localhost:5173' },
			{ kind: 'url', url: 'http://192.168.1.10:8080/app' },
			{ kind: 'url', url: 'http://devbox:3000' },
			{ kind: 'url', url: 'http://my-pc.local' },
			{ kind: 'search', query: 'worktree' },
			{ kind: 'search', query: 'para code mobile' },
			{ kind: 'search', query: 'https://example.com/a b' },
			{ kind: 'url', url: 'https://xn--eckwd4c7c.xn--zckzah' },
		]);
	});

	test('古い PC へは、検索を Google の URL にして送る', () => {
		expect(['example.com', 'para code', '日本語 検索', ''].map(legacyNavigateUrl)).toEqual([
			'https://example.com',
			'https://www.google.com/search?q=para+code',
			'https://www.google.com/search?q=%E6%97%A5%E6%9C%AC%E8%AA%9E+%E6%A4%9C%E7%B4%A2',
			undefined,
		]);
	});

	test('アドレス欄は題名（無ければホスト名）か、https:// を外した URL を出す', () => {
		expect({
			title: addressLabel('https://www.example.com/docs', 'Docs', 'title'),
			noTitle: addressLabel('https://www.example.com/docs', '  ', 'title'),
			url: addressLabel('https://www.example.com/docs', 'Docs', 'url'),
			http: addressLabel('http://localhost:5173/', 'Vite', 'url'),
			hosts: ['https://user@Example.com:8443/x', 'about:blank', 'http://[::1]:3000/'].map(addressHost),
		}).toEqual({
			title: 'Docs',
			noTitle: 'example.com',
			url: 'www.example.com/docs',
			http: 'http://localhost:5173/',
			hosts: ['example.com', undefined, '[::1]'],
		});
	});
});
