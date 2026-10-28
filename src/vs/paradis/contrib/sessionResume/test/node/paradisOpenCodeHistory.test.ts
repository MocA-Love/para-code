/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { listOpenCodeSessions, paradisOpenCodeDatabasePaths, readOpenCodeMessages } from '../../node/paradisOpenCodeHistory.js';
import { ParadisSessionResumeService } from '../../node/paradisSessionResumeChannel.js';

const nodeRequire = createRequire(import.meta.url);
suite('ParadisOpenCodeHistory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let dbPath: string;
	setup(async () => { root = await fs.mkdtemp(join(tmpdir(), 'paradis-opencode-history-')); dbPath = join(root, 'opencode-local.db'); });
	teardown(async () => { await fs.rm(root, { recursive: true, force: true }); });

	function populate(legacy = false): void {
		const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		const database = new DatabaseSync(dbPath);
		try {
			database.exec(`CREATE TABLE ${legacy ? 'session' : 'session_v2'} (id TEXT, title TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, metadata TEXT)`);
			const insert = database.prepare(`INSERT INTO ${legacy ? 'session' : 'session_v2'} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
			insert.run('ses_one', 'First topic', '/project', null, 10, 30, null, '{}');
			insert.run('ses_two', 'Second topic', '/project', null, 20, 40, null, '{}');
			insert.run('ses_child', 'Child', '/project', 'ses_one', 20, 50, null, '{}');
			insert.run('ses_other', 'Other', '/other', null, 20, 50, null, '{}');
			insert.run('ses_archived', 'Archived', '/project', null, 20, 60, 60, '{}');
			if (legacy) {
				database.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
				database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_user', 'ses_one', 11, JSON.stringify({ role: 'user' }));
				database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_answer', 'ses_one', 12, JSON.stringify({ role: 'assistant' }));
				database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part_user', 'msg_user', 'ses_one', 11, JSON.stringify({ type: 'text', text: 'Original request' }));
				database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part_answer', 'msg_answer', 'ses_one', 12, JSON.stringify({ type: 'text', text: 'Completed answer' }));
				return;
			}
			database.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)');
			const message = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)');
			message.run('msg_user', 'ses_one', 'user', 1, 11, JSON.stringify({ text: 'Original request' }));
			message.run('msg_answer', 'ses_one', 'assistant', 2, 12, JSON.stringify({ content: [
				{ type: 'reasoning', text: 'Plan the change' },
				{ type: 'tool', id: 'call_read', name: 'read', state: { status: 'completed', input: { path: 'file.ts' }, content: [{ type: 'text', text: 'File contents' }] } },
				{ type: 'text', text: 'Completed answer' },
			] }));
			message.run('msg_other', 'ses_other', 'user', 1, 13, JSON.stringify({ text: 'Unrelated request' }));
		} finally { database.close(); }
	}

	for (const legacy of [false, true]) {
		test(`reads ${legacy ? 'legacy' : 'v2'} history read-only with stable IDs and directory/session isolation`, async () => {
			populate(legacy);
			const before = await fs.readFile(dbPath);
			const sessions = await listOpenCodeSessions(dbPath, ['/project']);
			const messages = await readOpenCodeMessages(dbPath, 'ses_one');
			assert.deepStrictEqual({
				sessions: sessions.map(session => [session.id, session.cli]),
				messages: messages.filter(message => message.kind === 'message').map(message => [message.role, message.text]),
				stable: messages.map(message => message.id),
			}, {
				sessions: [['ses_two', 'opencode'], ['ses_one', 'opencode']],
				messages: [['user', 'Original request'], ['assistant', 'Completed answer']],
				stable: legacy ? ['msg_user:text:part_user', 'msg_answer:text:part_answer'] : ['msg_user', 'msg_answer:reasoning:0', 'msg_answer:tool:call_read', 'msg_answer:text:2'],
			});
			assert.deepStrictEqual(await fs.readFile(dbPath), before);
		});
	}

	test('reads each session from the table that holds its rows when a database has both schemas', async () => {
		populate(true);
		const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		const database = new DatabaseSync(dbPath);
		try {
			database.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)');
			database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run('msg_new', 'ses_two', 'user', 1, 21, JSON.stringify({ text: 'Newer schema request' }));
		} finally { database.close(); }
		assert.deepStrictEqual({
			legacyRows: (await readOpenCodeMessages(dbPath, 'ses_one')).map(message => message.text),
			newRows: (await readOpenCodeMessages(dbPath, 'ses_two')).map(message => message.text),
			missing: await readOpenCodeMessages(dbPath, 'ses_other'),
		}, { legacyRows: ['Original request', 'Completed answer'], newRows: ['Newer schema request'], missing: [] });
	});

	test('matches a Windows working directory that OpenCode stored with forward slashes', async () => {
		populate();
		const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		const database = new DatabaseSync(dbPath);
		try {
			database.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('ses_windows', 'Windows', 'C:/work/app', null, 1, 2, null, '{}');
		} finally { database.close(); }
		assert.deepStrictEqual((await listOpenCodeSessions(dbPath, ['C:\\work\\app'])).map(session => session.id), ['ses_windows']);
	});

	test('redacts credential tool inputs before forwarding history to another surface', async () => {
		populate();
		const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		const database = new DatabaseSync(dbPath);
		try {
			database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run('msg_credentials', 'ses_one', 'assistant', 3, 13, JSON.stringify({ content: [{ type: 'tool', id: 'credentials', name: 'para-browser_set_http_credentials', state: { status: 'completed', input: { password: 'fixture-private-value' } } }] }));
		} finally { database.close(); }
		assert.strictEqual(JSON.stringify(await readOpenCodeMessages(dbPath, 'ses_one')).includes('fixture-private-value'), false);
	});

	test('does not create missing databases or accept unsafe session IDs', async () => {
		await assert.rejects(readOpenCodeMessages(dbPath, 'ses_missing'));
		await assert.rejects(fs.stat(dbPath));
		await assert.rejects(readOpenCodeMessages(dbPath, 'ses_a\' OR 1=1'));
	});

	test('finds the databases compatible CLIs declared, then every file in the OpenCode folder, and drops declared paths that leave home', async () => {
		const home = join(root, 'home');
		const touch = async (...parts: string[]) => { await fs.mkdir(join(home, ...parts.slice(0, -1)), { recursive: true }); await fs.writeFile(join(home, ...parts), ''); };
		await touch('.example', 'data', 'opencode-local.db');
		await touch('.local', 'share', 'opencode', 'opencode.db');
		await touch('.local', 'share', 'opencode', 'opencode-local.db');
		await fs.mkdir(join(root, 'outside'), { recursive: true });
		await fs.writeFile(join(root, 'outside', 'escape.db'), '');
		await fs.symlink(join(root, 'outside', 'escape.db'), join(home, '.example', 'data', 'linked.db'));
		const remembered = [
			{ path: join(home, '.example', 'data', 'opencode-local.db'), cli: '/opt/example/bin/example-cli', label: 'Example CLI' },
			{ path: join(home, '.example', 'data', 'missing.db'), cli: '/opt/example/bin/example-cli' },
			{ path: join(home, '.example', 'data', 'linked.db'), cli: '/opt/example/bin/example-cli' },
			{ path: join(root, 'outside', 'escape.db'), cli: '/opt/example/bin/example-cli' },
		];
		const listed = (await paradisOpenCodeDatabasePaths({}, home, remembered)).map(database => [database.path.slice(home.length + 1), database.cli, database.label]);
		assert.deepStrictEqual(listed, [
			['.example/data/opencode-local.db', '/opt/example/bin/example-cli', 'Example CLI'],
			['.local/share/opencode/opencode-local.db', 'opencode', undefined],
			['.local/share/opencode/opencode.db', 'opencode', undefined],
		]);
	});

	test('lists a conversation copied into several databases once, from the copy updated last', async () => {
		populate();
		const copyPath = join(root, 'opencode.db');
		await fs.copyFile(dbPath, copyPath);
		const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		const database = new DatabaseSync(copyPath);
		try {
			database.prepare('UPDATE session_v2 SET time_updated = ? WHERE id = ?').run(99, 'ses_two');
		} finally { database.close(); }
		const service = new ParadisSessionResumeService({
			resolveAgentHomes: cwd => ({ claude: join(root, 'claude'), codex: join(root, 'codex'), matchCwd: cwd }),
			openCodeDatabases: async () => [{ path: dbPath, cli: '/opt/example/bin/example-cli' }, { path: copyPath, cli: 'opencode' }],
		}, new NullLogService());
		const sessions = await service.list({ spaces: [{ stateKey: 'project', name: 'Project', cwd: '/project', current: true }] });
		assert.deepStrictEqual(sessions.map(session => [session.id, session.cli, session.updatedAt]).sort(), [['ses_one', '/opt/example/bin/example-cli', 30], ['ses_two', 'opencode', 99]]);
	});

	test('lists the databases a request names for this machine (an SSH host gets them from the PC) and drops malformed entries', async () => {
		populate();
		let received: unknown;
		const service = new ParadisSessionResumeService({
			resolveAgentHomes: cwd => ({ claude: join(root, 'claude'), codex: join(root, 'codex'), matchCwd: cwd }),
			openCodeDatabases: async requested => { received = requested; return requested.map(database => ({ path: database.path, cli: database.cli, ...(database.label !== undefined ? { label: database.label } : {}) })); },
		}, new NullLogService());
		const sessions = await service.list({
			spaces: [{ stateKey: 'project', name: 'Project', cwd: '/project', current: true }],
			openCodeDatabases: [
				{ path: dbPath, cli: '/opt/example/bin/example-cli', label: 'Example CLI' },
				{ path: dbPath, cli: 'rm -rf /' },
				{ path: 'relative.db', cli: '/opt/example/bin/example-cli' },
				{ path: dbPath, cli: '/opt/example/bin/example-cli', label: 'bad\u0007' },
			],
		});
		assert.deepStrictEqual({ received, clis: [...new Set(sessions.map(session => [session.cli, session.cliLabel].join(' ')))] }, {
			received: [{ path: dbPath, cli: '/opt/example/bin/example-cli', label: 'Example CLI' }],
			clis: ['/opt/example/bin/example-cli Example CLI'],
		});
	});

	test('desktop catalog keeps sessions in one database distinct and supports preview/search/resume details', async () => {
		populate();
		const service = new ParadisSessionResumeService({
			resolveAgentHomes: cwd => ({ claude: join(root, 'claude'), codex: join(root, 'codex'), matchCwd: cwd }),
			openCodeDatabases: async () => [{ path: dbPath, cli: '/opt/example/bin/example-cli' }],
		}, new NullLogService());
		const sessions = await service.list({ spaces: [{ stateKey: 'project', name: 'Project', cwd: '/project', current: true }] });
		const selected = sessions.find(session => session.id === 'ses_one')!;
		assert.strictEqual(new Set(sessions.map(session => session.catalogId)).size, 2);
		assert.deepStrictEqual((await service.preview(selected.catalogId)).messages.map(message => message.text), ['Original request', 'Completed answer']);
		assert.strictEqual((await service.details(selected.catalogId)).firstPrompt, 'Original request');
		assert.strictEqual((await service.search('test', 'Original request', [selected.catalogId]))[0]?.catalogId, selected.catalogId);
	});
});
