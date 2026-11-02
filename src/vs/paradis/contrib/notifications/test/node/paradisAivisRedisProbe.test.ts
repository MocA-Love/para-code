/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { AddressInfo, createServer, Server, Socket } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAivisRedisKeyProbe, paradisParseRespReplies } from '../../node/paradisAivisRedisProbe.js';

/** 受けた RESP の配列を数え、GET には値（`$`）か null で答える偽の Redis。 */
function fakeRedis(values: ReadonlyMap<string, string>): { readonly server: Server; readonly connections: number[]; readonly commands: string[][] } {
	const connections: number[] = [];
	const commands: string[][] = [];
	const server = createServer((socket: Socket) => {
		connections.push(connections.length + 1);
		let pending = '';
		socket.on('data', chunk => {
			pending += chunk.toString('utf8');
			for (; ;) {
				const match = /^\*(\d+)\r\n((?:\$\d+\r\n[^\r]*\r\n)*)/.exec(pending);
				if (!match) {
					return;
				}
				const parts = [...match[2].matchAll(/\$\d+\r\n([^\r]*)\r\n/g)].map(part => part[1]);
				if (parts.length < Number(match[1])) {
					return;
				}
				pending = pending.slice(match[0].length);
				commands.push(parts);
				const value = parts[0] === 'GET' ? values.get(parts[1]) : undefined;
				socket.write(parts[0] !== 'GET' ? '+OK\r\n' : value === undefined ? '$-1\r\n' : `$${Buffer.byteLength(value)}\r\n${value}\r\n`);
			}
		});
	});
	return { server, connections, commands };
}

suite('ParadisAivisRedisKeyProbe', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('asks every GET over one connection, even when called at the same time, and sends AUTH and SELECT only once', async () => {
		const redis = fakeRedis(new Map([['lock', '1']]));
		await new Promise<void>(resolve => redis.server.listen(0, '127.0.0.1', resolve));
		try {
			const port = (redis.server.address() as AddressInfo).port;
			const probe = await ParadisAivisRedisKeyProbe.create({ REDIS_URL: `redis://user:secret@127.0.0.1:${port}/2` });
			const answers = [await probe?.has('lock'), ...await Promise.all([probe?.has('other'), probe?.has('lock')])];
			probe?.dispose();
			assert.deepStrictEqual({ answers, connections: redis.connections.length, commands: redis.commands }, {
				answers: [true, false, true],
				connections: 1,
				commands: [['AUTH', 'user', 'secret'], ['SELECT', '2'], ['GET', 'lock'], ['GET', 'other'], ['GET', 'lock']],
			});
		} finally {
			await new Promise<void>(resolve => redis.server.close(() => resolve()));
		}
	});

	test('reads bulk string lengths as bytes, not as characters', () => {
		const value = '\u3042\u3044';
		const text = `$${Buffer.byteLength(value)}\r\n${value}\r\n+OK\r\n`;
		assert.deepStrictEqual(paradisParseRespReplies(Buffer.from(text, 'utf8')), { replies: [value, 'OK'], consumed: Buffer.byteLength(text) });
	});
});
