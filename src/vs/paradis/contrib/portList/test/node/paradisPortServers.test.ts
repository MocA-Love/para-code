/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import type * as http from 'http';
import { AddressInfo } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPortEntry, IParadisPortPageInfo, IParadisPortPageRequest } from '../../common/paradisPortList.js';
import { ParadisPortPageProbeCache, ParadisPortServerDescriber, paradisAppRootFor, parseHtmlIconHref, parseHtmlTitle, parseLsofCwdOutput, parsePsCommOutput, probeHostForAddress, probePortPage } from '../../node/paradisPortServers.js';

suite('ParadisPortServers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses lsof cwd output, titles, icon links and probe hosts', () => {
		assert.deepStrictEqual({
			cwds: [...parseLsofCwdOutput('p101\nfcwd\nn/Users/a/app\np102\nfcwd\nn/tmp\np103\n').entries()],
			title: parseHtmlTitle('<html><head><title>\n  Acme &amp; Co &#x2014; Admin </title></head></html>'),
			noTitle: parseHtmlTitle('<html><title>   </title></html>'),
			icon: parseHtmlIconHref('<link rel="stylesheet" href="/a.css"><link rel="shortcut icon" href="/static/fav.png">'),
			hosts: ['127.0.0.1', '::1', '*', '0.0.0.0', '::', '192.168.1.5'].map(probeHostForAddress),
		}, {
			cwds: [[101, '/Users/a/app'], [102, '/tmp']],
			title: 'Acme & Co \u2014 Admin',
			noTitle: undefined,
			icon: '/static/fav.png',
			hosts: ['127.0.0.1', '::1', '127.0.0.1', '127.0.0.1', '127.0.0.1', undefined],
		});
	});

	test('reads the title and icon of a local page, and treats other responses as not a page', async () => {
		const httpModule: typeof http = await import('http');
		const server = httpModule.createServer((request, response) => {
			if (request.url === '/') {
				response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				response.end('<title>Local App</title><link rel="icon" href="/i.png">');
			} else if (request.url === '/i.png') {
				response.writeHead(200, { 'content-type': 'image/png' });
				response.end(Buffer.from([1, 2, 3]));
			} else {
				response.writeHead(404);
				response.end();
			}
		});
		const api = httpModule.createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{}');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
		try {
			const port = (server.address() as AddressInfo).port;
			const apiPort = (api.address() as AddressInfo).port;
			assert.deepStrictEqual(await Promise.all([
				probePortPage({ port, address: '127.0.0.1' }),
				probePortPage({ port: apiPort, address: '127.0.0.1' }),
				probePortPage({ port, address: '10.0.0.1' }),
			]), [
				{ port, isPage: true, scheme: 'http', title: 'Local App', faviconDataUrl: 'data:image/png;base64,AQID' },
				{ port: apiPort, isPage: false, scheme: 'http' },
				{ port, isPage: false, scheme: 'http' },
			]);
		} finally {
			server.close();
			api.close();
		}
	});

	test('caches probes for a while and caps the number of ports per request', async () => {
		const probed: number[] = [];
		let now = 0;
		const cache = new ParadisPortPageProbeCache(async (request: IParadisPortPageRequest): Promise<IParadisPortPageInfo> => {
			probed.push(request.port);
			return { port: request.port, isPage: false, scheme: 'http' };
		}, () => now);
		const many = Array.from({ length: 20 }, (_, i) => ({ port: 3000 + i, address: '127.0.0.1' }));
		const first = await cache.probePages([...many, { port: 'x' }]);
		await cache.probePages([{ port: 3000, address: '127.0.0.1' }]);
		now = 20_000;
		await cache.probePages([{ port: 3000, address: '127.0.0.1' }]);
		assert.deepStrictEqual({ returned: first.length, probed: probed.length, last: probed[probed.length - 1] }, { returned: 16, probed: 17, last: 3000 });
	});

	test('skips well-known non-HTTP ports and does not ask the same process again once it is not a page', async () => {
		const probed: string[] = [];
		let alive = true;
		let now = 0;
		const cache = new ParadisPortPageProbeCache(async (request: IParadisPortPageRequest): Promise<IParadisPortPageInfo> => {
			probed.push(`${request.pid}:${request.port}`);
			return { port: request.port, isPage: false, scheme: 'http' };
		}, () => now, () => alive);
		await cache.probePages([{ port: 5432, address: '127.0.0.1', pid: 1 }, { port: 6379, address: '127.0.0.1', pid: 2 }, { port: 4000, address: '127.0.0.1', pid: 3 }]);
		// 覚えておく 15 秒を過ぎても、同じプロセスなら聞き直さない
		now = 20_000;
		await cache.probePages([{ port: 4000, address: '127.0.0.1', pid: 3 }]);
		// プロセスが終われば、同じ番号の新しいサーバーとして聞き直す
		alive = false;
		now = 40_000;
		await cache.probePages([{ port: 4000, address: '127.0.0.1', pid: 3 }]);
		assert.deepStrictEqual(probed, ['3:4000', '3:4000']);
	});

	test('adds working folders, drops Para Code\'s own processes, and reads each process once while cached', async () => {
		const reads: number[][] = [];
		let now = 0;
		const describer = new ParadisPortServerDescriber({
			cacheMs: 2000,
			now: () => now,
			ownPids: [100],
			appRoot: '/Applications/Para Code.app',
			homeDir: '/Users/u',
			readCwds: async pids => { reads.push([...pids]); return new Map(pids.map(pid => [pid, `/work/${pid}`])); },
			readExes: async pids => new Map(pids.map(pid => [pid, pid === 101 ? '/Applications/Para Code.app/Contents/Frameworks/Para Code Helper (Plugin).app/Contents/MacOS/Para Code Helper (Plugin)' : '/usr/local/bin/node'])),
		});
		const entries: IParadisPortEntry[] = [100, 101, 102].map(pid => ({ port: 3000 + pid, proto: 'TCP', pid, processName: 'p', address: '127.0.0.1', risky: false }));
		const first = await describer.describe(entries, 1);
		await describer.describe(entries, 2);
		now = 5000;
		await describer.describe(entries, 3);
		assert.deepStrictEqual({
			ports: first.entries.map(entry => [entry.port, entry.cwd]),
			home: first.homeDir,
			reads,
			appRoots: [paradisAppRootFor('/Applications/Para Code.app/Contents/MacOS/Para Code'), paradisAppRootFor('/usr/share/para-code/para-code'), paradisAppRootFor('/usr/bin/node')],
			ps: [...parsePsCommOutput('  101 /Applications/A.app/Contents/MacOS/A\n  102 /usr/local/bin/node\n').entries()],
		}, {
			ports: [[3102, '/work/102']],
			home: '/Users/u',
			reads: [[100, 101, 102], [100, 101, 102]],
			appRoots: ['/Applications/Para Code.app', '/usr/share/para-code', undefined],
			ps: [[101, '/Applications/A.app/Contents/MacOS/A'], [102, '/usr/local/bin/node']],
		});
	});
});
