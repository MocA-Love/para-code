/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisCodexAccountsState } from '../../common/paradisCodexAccounts.js';
import { ParadisCodexAccountsService } from '../../node/paradisCodexAccountsService.js';
import { paradisLinkCodexSessions } from '../../node/paradisCodexSessionLinker.js';

function idToken(email: string): string {
	return `header.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.signature`;
}

suite('Paradis Codex account switching', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let stateDirectory: string;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'paradis-codex-switch-'));
		home = join(root, 'home');
		stateDirectory = join(root, 'state');
		for (const [name, email] of [['.codex', 'a@example.com'], ['.codex-2', 'b@example.com']]) {
			mkdirSync(join(home, name), { recursive: true });
			writeFileSync(join(home, name, 'auth.json'), JSON.stringify({ tokens: { id_token: idToken(email), account_id: name } }));
		}
		// ログインに失敗したホーム（auth.json が無い）は候補に出さない
		mkdirSync(join(home, '.codex-3', 'log'), { recursive: true });
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function createService(): ParadisCodexAccountsService {
		return new ParadisCodexAccountsService({
			logService: new NullLogService(),
			stateDirectory,
			resolveEnv: async () => ({}),
			homeDirectory: home,
			skipStartupLink: true,
		});
	}

	function summarize(state: IParadisCodexAccountsState) {
		return {
			homes: state.homes.map(entry => [entry.label, entry.email, entry.isDefault]),
			selected: state.selection.homePath,
			revision: state.selection.revision,
		};
	}

	test('lists signed-in homes and keeps the selection across restarts for every window', async () => {
		const first = createService();
		const events: (string | undefined)[] = [];
		const listener = first.onDidChangeState(state => events.push(state.selection.homePath));
		const initial = summarize(await first.getState());
		const selected = summarize(await first.selectHome(join(home, '.codex-2')));
		await first.linkSessions();
		listener.dispose();
		first.dispose();

		const second = createService();
		const reloaded = summarize(await second.getState());
		const backToDefault = summarize(await second.selectHome(join(home, '.codex')));
		second.dispose();

		assert.deepStrictEqual({ initial, selected, reloaded, backToDefault, events }, {
			initial: { homes: [['~/.codex', 'a@example.com', true], ['~/.codex-2', 'b@example.com', false]], selected: undefined, revision: 0 },
			selected: { homes: [['~/.codex', 'a@example.com', true], ['~/.codex-2', 'b@example.com', false]], selected: join(home, '.codex-2'), revision: 1 },
			reloaded: { homes: [['~/.codex', 'a@example.com', true], ['~/.codex-2', 'b@example.com', false]], selected: join(home, '.codex-2'), revision: 1 },
			backToDefault: { homes: [['~/.codex', 'a@example.com', true], ['~/.codex-2', 'b@example.com', false]], selected: undefined, revision: 2 },
			events: [join(home, '.codex-2')],
		});
	});

	test('refuses homes that are not signed in or not Codex homes', async () => {
		const service = createService();
		await assert.rejects(service.selectHome(join(home, '.codex-3')));
		await assert.rejects(service.selectHome(join(root, 'elsewhere')));
		const state = await service.getState();
		service.dispose();
		assert.deepStrictEqual({ selected: state.selection.homePath, revision: state.selection.revision }, { selected: undefined, revision: 0 });
	});

	test('hard-links conversations both ways without overwriting or following symlinks', async () => {
		const a = join(home, '.codex');
		const b = join(home, '.codex-2');
		const day = join('sessions', '2026', '09', '27');
		mkdirSync(join(a, day), { recursive: true });
		mkdirSync(join(b, day), { recursive: true });
		writeFileSync(join(a, day, 'rollout-from-a.jsonl'), 'a\n');
		writeFileSync(join(b, day, 'rollout-from-b.jsonl'), 'b\n');
		// 同じ名前で中身が違うものは上書きしない
		writeFileSync(join(a, day, 'rollout-both.jsonl'), 'a-version\n');
		writeFileSync(join(b, day, 'rollout-both.jsonl'), 'b-version\n');
		// シンボリックリンクは元にしない
		writeFileSync(join(root, 'outside.jsonl'), 'secret\n');
		symlinkSync(join(root, 'outside.jsonl'), join(a, day, 'rollout-link.jsonl'));
		// 会話ログ以外は触らない
		writeFileSync(join(a, day, 'notes.txt'), 'x');

		const summary = await paradisLinkCodexSessions([a, b]);

		assert.deepStrictEqual({
			summary,
			aHasB: readFileSync(join(a, day, 'rollout-from-b.jsonl'), 'utf8'),
			bHasA: readFileSync(join(b, day, 'rollout-from-a.jsonl'), 'utf8'),
			sameInode: statSync(join(a, day, 'rollout-from-a.jsonl')).ino === statSync(join(b, day, 'rollout-from-a.jsonl')).ino,
			bothKept: [readFileSync(join(a, day, 'rollout-both.jsonl'), 'utf8'), readFileSync(join(b, day, 'rollout-both.jsonl'), 'utf8')],
			symlinkCopied: safeRead(join(b, day, 'rollout-link.jsonl')),
			notesCopied: safeRead(join(b, day, 'notes.txt')),
		}, {
			summary: { linked: 2, skippedExisting: 0, skippedUnsupported: 0, failed: 0 },
			aHasB: 'b\n',
			bHasA: 'a\n',
			sameInode: true,
			bothKept: ['a-version\n', 'b-version\n'],
			symlinkCopied: undefined,
			notesCopied: undefined,
		});
	});

	function safeRead(path: string): string | undefined {
		try {
			return readFileSync(path, 'utf8');
		} catch {
			return undefined;
		}
	}
});
