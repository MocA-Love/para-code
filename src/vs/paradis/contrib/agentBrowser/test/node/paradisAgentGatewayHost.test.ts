/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { promises as fs } from 'fs';
import type * as http from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentGatewayEndpoint, PARADIS_AGENT_GATEWAY_FILE_NAME, PARADIS_AGENT_GATEWAY_HANDOVER_KEY_HEADER, PARADIS_AGENT_GATEWAY_HANDOVER_PATH, PARADIS_AGENT_GATEWAY_PORT_BASE, PARADIS_AGENT_GATEWAY_PROBE_PATH, paradisAgentGatewayPortCandidates, paradisParseAgentGatewayFile, paradisParseAgentGatewayPortFile } from '../../common/paradisAgentGateway.js';
import { ParadisAgentGatewayHost, paradisReadAgentGatewaySources } from '../../node/paradisAgentGatewayHost.js';

const quietLog = { info: () => { }, warn: () => { } };

suite('ParadisAgentGatewayHost', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const hosts: ParadisAgentGatewayHost[] = [];
	const servers: http.Server[] = [];
	let directory: string;
	let httpModule: typeof http;

	suiteSetup(async () => {
		httpModule = await import('http');
	});

	setup(async () => {
		directory = await fs.mkdtemp(join(tmpdir(), 'paradis-gateway-'));
	});

	teardown(async () => {
		for (const host of hosts.splice(0)) {
			host.dispose();
		}
		for (const server of servers.splice(0)) {
			await new Promise<void>(resolve => {
				server.closeAllConnections();
				server.close(() => resolve());
			});
		}
		await fs.rm(directory, { recursive: true, force: true });
	});

	interface IWatchedHost {
		readonly host: ParadisAgentGatewayHost;
		/** 受け口の場所か持ち主が、条件に合う形になるのを待つ。 */
		when(predicate: (endpoint: IParadisAgentGatewayEndpoint | undefined, holding: boolean) => boolean): Promise<IParadisAgentGatewayEndpoint | undefined>;
	}

	function host(paraCodeDirectory: string, version?: number): IWatchedHost {
		let last: { readonly endpoint: IParadisAgentGatewayEndpoint | undefined; readonly holding: boolean } | undefined;
		const waiting: Array<() => void> = [];
		const created = new ParadisAgentGatewayHost({
			paraCodeDirectory, log: quietLog, version, standbyPollMs: 30, relay: { waitLimitMs: 300, retryDelayMs: 20 },
			onDidChange: (endpoint, holding) => {
				last = { endpoint, holding };
				for (const check of [...waiting]) {
					check();
				}
			},
		});
		hosts.push(created);
		return {
			host: created,
			when: predicate => new Promise(resolve => {
				const check = () => {
					if (last !== undefined && predicate(last.endpoint, last.holding)) {
						waiting.splice(waiting.indexOf(check), 1);
						resolve(last.endpoint);
					}
				};
				waiting.push(check);
				check();
			}),
		};
	}

	function request(port: number, method: string, path: string, headers: http.OutgoingHttpHeaders = {}, body = ''): Promise<{ readonly status: number; readonly body: string }> {
		return new Promise((resolve, reject) => {
			const outgoing = httpModule.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, response => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
			});
			outgoing.on('error', reject);
			outgoing.end(body);
		});
	}

	async function readFile(): Promise<ReturnType<typeof paradisParseAgentGatewayFile>> {
		try {
			return paradisParseAgentGatewayFile(await fs.readFile(join(directory, PARADIS_AGENT_GATEWAY_FILE_NAME), 'utf8'));
		} catch {
			return undefined;
		}
	}

	test('holds a port, records it for other processes on the host, and relays to the port file', async () => {
		const received: string[] = [];
		const window = httpModule.createServer((req, res) => {
			if (req.url !== PARADIS_AGENT_GATEWAY_PROBE_PATH) {
				received.push(`${req.method} ${req.url}`);
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{"ok":true}');
		});
		servers.push(window);
		await new Promise<void>(resolve => window.listen(0, '127.0.0.1', () => resolve()));
		await fs.mkdir(join(directory, 'ports'));
		await fs.writeFile(join(directory, 'ports', '0123456789abcdef.json'), JSON.stringify({ protocolVersion: 1, port: (window.address() as AddressInfo).port }));

		const endpoint = await host(directory).host.getEndpoint();
		assert.ok(endpoint);
		const file = await readFile();
		const mode = (await fs.stat(join(directory, PARADIS_AGENT_GATEWAY_FILE_NAME))).mode & 0o777;
		const response = await request(endpoint.port, 'POST', '/mcp', { authorization: 'Bearer t' }, '{}');

		assert.deepStrictEqual(
			{ recordedPort: file?.port, pid: file?.pid, mode: process.platform === 'win32' ? 0o600 : mode, status: response.status, received },
			{ recordedPort: endpoint.port, pid: process.pid, mode: 0o600, status: 200, received: ['POST /mcp'] },
		);
	});

	test('a second server of the same home stands by, answers with the same port, and takes it when the holder goes away', async () => {
		const first = host(directory);
		const firstEndpoint = await first.host.getEndpoint();
		assert.ok(firstEndpoint);
		const second = host(directory);
		const standbyEndpoint = await second.host.getEndpoint();

		first.host.dispose();
		const takenOver = await second.when((_endpoint, holding) => holding);
		const info = await request(firstEndpoint.port, 'GET', '/paradis-gateway/info');

		assert.deepStrictEqual({ standby: standbyEndpoint?.port, after: takenOver?.port, answers: info.status }, { standby: firstEndpoint.port, after: firstEndpoint.port, answers: 200 });
	});

	test('a newer server takes the port over from an older one and the number stays the same', async () => {
		const older = host(directory, 1);
		const olderEndpoint = await older.host.getEndpoint();
		assert.ok(olderEndpoint);
		const newer = host(directory, 2);

		const newerEndpoint = await newer.host.getEndpoint();
		const info = JSON.parse((await request(olderEndpoint.port, 'GET', '/paradis-gateway/info')).body);
		// 譲った側は控えに回り、新しい持ち主の番号を答える
		const olderAfter = await older.when((endpoint, holding) => !holding && endpoint?.version === 2);

		assert.deepStrictEqual(
			{ newer: newerEndpoint, servedBy: info.version, olderAfter },
			{ newer: { port: olderEndpoint.port, version: 2 }, servedBy: 2, olderAfter: { port: olderEndpoint.port, version: 2 } },
		);
	});

	test('refuses a handover without the key, or to a server that is not newer', async () => {
		const holder = host(directory, 5);
		const endpoint = await holder.host.getEndpoint();
		assert.ok(endpoint);
		const file = await readFile();
		assert.ok(file);

		const wrongKey = await request(endpoint.port, 'POST', PARADIS_AGENT_GATEWAY_HANDOVER_PATH, { [PARADIS_AGENT_GATEWAY_HANDOVER_KEY_HEADER]: 'x'.repeat(file.handoverKey.length) }, JSON.stringify({ version: 9 }));
		const notNewer = await request(endpoint.port, 'POST', PARADIS_AGENT_GATEWAY_HANDOVER_PATH, { [PARADIS_AGENT_GATEWAY_HANDOVER_KEY_HEADER]: file.handoverKey }, JSON.stringify({ version: 5 }));

		assert.deepStrictEqual({ wrongKey: wrongKey.status, notNewer: notNewer.status, still: await holder.host.getEndpoint() }, { wrongKey: 403, notNewer: 403, still: endpoint });
	});

	test('does not join a gateway that belongs to another home', async () => {
		const other = await fs.mkdtemp(join(tmpdir(), 'paradis-gateway-other-'));
		try {
			const foreign = host(other);
			const foreignEndpoint = await foreign.host.getEndpoint();
			assert.ok(foreignEndpoint);
			// 前に使っていた番号として、別のホームの受け口の番号が記録に残っていた
			await fs.writeFile(join(directory, PARADIS_AGENT_GATEWAY_FILE_NAME), JSON.stringify({ protocolVersion: 1, port: foreignEndpoint.port, pid: 1, gatewayVersion: 1, handoverKey: 'k'.repeat(48) }));

			const endpoint = await host(directory).host.getEndpoint();

			assert.ok(endpoint !== undefined && endpoint.port !== foreignEndpoint.port);
		} finally {
			for (const created of hosts.splice(0)) {
				created.dispose();
			}
			await fs.rm(other, { recursive: true, force: true });
		}
	});

	test('reads the port files newest first, skips broken ones, and drops the shared one when a PC file has the same port', async () => {
		await fs.mkdir(join(directory, 'ports'));
		await fs.writeFile(join(directory, 'ports', 'aaaaaaaaaaaaaaaa.json'), JSON.stringify({ protocolVersion: 1, port: 21001 }));
		await fs.writeFile(join(directory, 'ports', 'bbbbbbbbbbbbbbbb.json'), JSON.stringify({ protocolVersion: 1, port: 21002 }));
		await fs.writeFile(join(directory, 'ports', 'cccccccccccccccc.json'), '{"protocolVersion":1,"po');
		await fs.writeFile(join(directory, 'ports', 'not-a-source.json'), JSON.stringify({ port: 21009 }));
		await fs.writeFile(join(directory, 'paradis-browser-mcp.json'), JSON.stringify({ protocolVersion: 1, port: 21002 }));
		const old = new Date(Date.now() - 60_000);
		await fs.utimes(join(directory, 'ports', 'aaaaaaaaaaaaaaaa.json'), old, old);

		assert.deepStrictEqual(await paradisReadAgentGatewaySources(directory), [{ id: 'bbbbbbbbbbbbbbbb', port: 21002 }, { id: 'aaaaaaaaaaaaaaaa', port: 21001 }]);
	});

	test('parses the files and orders the candidate ports', () => {
		assert.deepStrictEqual(
			{
				empty: paradisParseAgentGatewayPortFile(''),
				partial: paradisParseAgentGatewayPortFile('{"port":'),
				outOfRange: paradisParseAgentGatewayPortFile('{"port":70000}'),
				port: paradisParseAgentGatewayPortFile('{"protocolVersion":1,"port":25163}'),
				unknownVersion: paradisParseAgentGatewayFile(JSON.stringify({ protocolVersion: 2, port: 25000, pid: 1, gatewayVersion: 1, handoverKey: 'k'.repeat(48) })),
				candidates: paradisAgentGatewayPortCandidates(3, 30000).slice(0, 3),
				wraps: paradisAgentGatewayPortCandidates(12767, undefined).slice(0, 2),
			},
			{
				empty: undefined, partial: undefined, outOfRange: undefined, port: 25163, unknownVersion: undefined,
				candidates: [30000, PARADIS_AGENT_GATEWAY_PORT_BASE + 3, PARADIS_AGENT_GATEWAY_PORT_BASE + 4],
				wraps: [32767, PARADIS_AGENT_GATEWAY_PORT_BASE],
			},
		);
	});
});
