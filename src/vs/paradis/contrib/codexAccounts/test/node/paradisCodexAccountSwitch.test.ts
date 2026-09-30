/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisCodexAccountsState } from '../../common/paradisCodexAccounts.js';
import { paradisNotifyCodexHomesChanged } from '../../../agentBrowser/node/paradisAgentHome.js';
import { ParadisCodexAccountsChannel } from '../../node/paradisCodexAccountsChannel.js';
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
	const day = join('sessions', '2026', '09', '27');

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'paradis-codex-switch-'));
		home = join(root, 'home');
		stateDirectory = join(root, 'state');
		for (const [name, email] of [['.codex', 'a@example.com'], ['.codex-2', 'b@example.com'], ['.codex-4', 'c@example.com']]) {
			mkdirSync(join(home, name), { recursive: true });
			writeFileSync(join(home, name, 'auth.json'), JSON.stringify({ tokens: { id_token: idToken(email), account_id: name } }));
		}
		// ログインに失敗したホーム（auth.json が無い）は候補に出さない
		mkdirSync(join(home, '.codex-3', 'log'), { recursive: true });
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function createService(options: { readonly shareConversations?: boolean } = {}): ParadisCodexAccountsService {
		return new ParadisCodexAccountsService({
			logService: new NullLogService(),
			stateDirectory,
			resolveEnv: async () => ({}),
			homeDirectory: home,
			skipBackgroundWork: true,
			shareConversations: () => options.shareConversations !== false,
		});
	}

	function summarize(state: IParadisCodexAccountsState) {
		return {
			homes: state.homes.map(entry => [entry.label, entry.email, entry.isDefault]),
			selected: state.selection.homePath,
			revision: state.selection.revision,
		};
	}

	function rollout(codexHome: string, name: string, content = `${name}\n`): string {
		mkdirSync(join(codexHome, day), { recursive: true });
		const path = join(codexHome, day, name);
		writeFileSync(path, content);
		return path;
	}

	function exists(path: string): boolean {
		try {
			statSync(path);
			return true;
		} catch {
			return false;
		}
	}

	const homesList = [['~/.codex', 'a@example.com', true], ['~/.codex-2', 'b@example.com', false], ['~/.codex-4', 'c@example.com', false]];

	test('lists signed-in homes and keeps the selection across restarts for every window', async () => {
		const first = createService();
		const events: (string | undefined)[] = [];
		const listener = first.onDidChangeState(state => events.push(state.selection.homePath));
		const initial = summarize(await first.getState());
		const selected = summarize(await first.selectHome(join(home, '.codex-2')));
		await first.whenLinked();
		listener.dispose();
		first.dispose();

		const second = createService();
		const reloaded = summarize(await second.getState());
		const backToDefault = summarize(await second.selectHome(join(home, '.codex')));
		await second.whenLinked();
		second.dispose();

		assert.deepStrictEqual({ initial, selected, reloaded, backToDefault, events }, {
			initial: { homes: homesList, selected: undefined, revision: 0 },
			selected: { homes: homesList, selected: join(home, '.codex-2'), revision: 1 },
			reloaded: { homes: homesList, selected: join(home, '.codex-2'), revision: 1 },
			backToDefault: { homes: homesList, selected: undefined, revision: 2 },
			events: [join(home, '.codex-2')],
		});
	});

	test('refuses homes that are not signed in or not Codex homes, and serializes concurrent choices', async () => {
		const service = createService();
		await assert.rejects(service.selectHome(join(home, '.codex-3')));
		await assert.rejects(service.selectHome(join(root, 'elsewhere')));
		const [a, b] = await Promise.all([service.selectHome(join(home, '.codex-2')), service.selectHome(join(home, '.codex-4'))]);
		await service.whenLinked();
		service.dispose();
		assert.deepStrictEqual([a.selection.revision, b.selection.revision, b.selection.homePath], [1, 2, join(home, '.codex-4')]);
	});

	// Para Code を更新した直後は、同じ接続先に古い版の REH が残り、同じ選択のファイルを書き換える。
	// 番号はそちらの方が小さいことがあるので、こちらの続きの番号で全ウィンドウへ配り直す。
	test('follows a selection another process wrote, with a revision newer than the one it handed out', async () => {
		const service = createService();
		await service.selectHome(join(home, '.codex-2'));
		await service.selectHome(join(home, '.codex-4'));
		await service.whenLinked();
		const events: (string | undefined)[] = [];
		const listener = service.onDidChangeState(state => events.push(state.selection.homePath));
		const selectionFile = join(stateDirectory, 'codex-account-selection.json');
		writeFileSync(`${selectionFile}.other`, JSON.stringify({ version: 1, homePath: join(home, '.codex-2'), revision: 1 }));
		renameSync(`${selectionFile}.other`, selectionFile);
		await service.revalidate();
		const state = await service.getState();
		listener.dispose();
		service.dispose();
		assert.deepStrictEqual({ events, selected: state.selection.homePath, revision: state.selection.revision }, {
			events: [join(home, '.codex-2')],
			selected: join(home, '.codex-2'),
			revision: 3,
		});
	});

	// REH は利用者の設定を読めないので、会話ログを共有するかはウィンドウが問い合わせに添えた値を使う。
	test('takes the preferences the window sends with getState and selectHome, and ignores malformed ones', async () => {
		const service = createService();
		const received: boolean[] = [];
		const channel = new ParadisCodexAccountsChannel<{ readonly clientId: string }>(service, undefined, preferences => received.push(preferences.shareConversations));
		const ctx = { clientId: 'window-a' };
		await channel.call(ctx, 'getState', [{ shareConversations: false }]);
		await channel.call(ctx, 'selectHome', [join(home, '.codex-2'), { shareConversations: true }]);
		await channel.call(ctx, 'getState', [{ shareConversations: 'no' }]);
		await channel.call(ctx, 'getState');
		await service.whenLinked();
		service.dispose();
		assert.deepStrictEqual(received, [false, true]);
	});

	// 選んだホームを使用量パネルから消したら、既定のホームへ戻して全ウィンドウへ知らせる。
	test('falls back to the default home and tells every window when the selected home is removed', async () => {
		const service = createService();
		await service.selectHome(join(home, '.codex-2'));
		await service.whenLinked();
		const events: (string | undefined)[] = [];
		const listener = service.onDidChangeState(state => events.push(state.selection.homePath ?? 'default'));
		rmSync(join(home, '.codex-2'), { recursive: true, force: true });
		await service.revalidate();
		const state = await service.getState();
		listener.dispose();
		service.dispose();
		assert.deepStrictEqual({ events, selected: state.selection.homePath, homes: state.homes.map(entry => entry.label) }, {
			events: ['default'],
			selected: undefined,
			homes: ['~/.codex', '~/.codex-4'],
		});
	});

	// 使用量パネルでアカウントを消したら（shared process の中で知らせが来たら）、待たずに見直す。
	test('re-checks the selection as soon as the limits monitor reports a home change', async () => {
		const service = new ParadisCodexAccountsService({
			logService: new NullLogService(),
			stateDirectory,
			resolveEnv: async () => ({}),
			homeDirectory: home,
			shareConversations: () => false,
		});
		await service.selectHome(join(home, '.codex-2'));
		const changed = new Promise<string | undefined>(resolve => {
			const listener = service.onDidChangeState(state => {
				listener.dispose();
				resolve(state.selection.homePath);
			});
		});
		rmSync(join(home, '.codex-2'), { recursive: true, force: true });
		paradisNotifyCodexHomesChanged();
		const selected = await changed;
		service.dispose();
		assert.strictEqual(selected, undefined);
	});

	// 会話を広げるのは実際に行き来した2つのホームの間だけ。設定でやめられる。
	test('links conversations only between the homes switched from and to, unless turned off', async () => {
		rollout(join(home, '.codex'), 'rollout-a.jsonl');
		rollout(join(home, '.codex-4'), 'rollout-c.jsonl');
		const off = createService({ shareConversations: false });
		await off.selectHome(join(home, '.codex-2'));
		await off.whenLinked();
		off.dispose();
		const linkedWhileOff = exists(join(home, '.codex-2', day, 'rollout-a.jsonl'));

		const on = createService();
		await on.selectHome(join(home, '.codex'));
		await on.selectHome(join(home, '.codex-2'));
		await on.whenLinked();
		on.dispose();
		assert.deepStrictEqual({
			linkedWhileOff,
			intoSecond: exists(join(home, '.codex-2', day, 'rollout-a.jsonl')),
			notFromThird: exists(join(home, '.codex-2', day, 'rollout-c.jsonl')),
			notIntoThird: exists(join(home, '.codex-4', day, 'rollout-a.jsonl')),
		}, { linkedWhileOff: false, intoSecond: true, notFromThird: false, notIntoThird: false });
	});

	test('hard-links conversations both ways without overwriting or following symlinks', async () => {
		const a = join(home, '.codex');
		const b = join(home, '.codex-2');
		rollout(a, 'rollout-from-a.jsonl', 'a\n');
		rollout(b, 'rollout-from-b.jsonl', 'b\n');
		// 同じ名前で中身が違うものは上書きしない
		rollout(a, 'rollout-both.jsonl', 'a-version\n');
		rollout(b, 'rollout-both.jsonl', 'b-version\n');
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
			symlinkCopied: exists(join(b, day, 'rollout-link.jsonl')),
			notesCopied: exists(join(b, day, 'notes.txt')),
		}, {
			summary: { linked: 2, skippedExisting: 0, skippedRemoved: 0, skippedOtherOrigin: 0, skippedUnsupported: 0, failed: 0 },
			aHasB: 'b\n',
			bHasA: 'a\n',
			sameInode: true,
			bothKept: ['a-version\n', 'b-version\n'],
			symlinkCopied: false,
			notesCopied: false,
		});
	});

	// 消した・アーカイブした会話を、もう一方のホームから足し戻さない（何度リンクし直しても）。新しく作るディレクトリは 0700。
	test('never brings back conversations the user removed and creates private directories', async () => {
		const a = join(home, '.codex');
		const b = join(home, '.codex-2');
		const ledgerPath = join(stateDirectory, 'links.json');
		const secret = rollout(a, 'rollout-secret.jsonl');
		await paradisLinkCodexSessions([a, b], { ledgerPath });
		const createdMode = statSync(join(b, 'sessions', '2026')).mode & 0o777;
		rmSync(secret);
		const second = await paradisLinkCodexSessions([a, b], { ledgerPath });
		const third = await paradisLinkCodexSessions([a, b], { ledgerPath });
		assert.deepStrictEqual({
			second,
			third,
			backInA: exists(secret),
			createdMode: isWindows ? 0o700 : createdMode,
		}, {
			second: { linked: 0, skippedExisting: 0, skippedRemoved: 1, skippedOtherOrigin: 0, skippedUnsupported: 0, failed: 0 },
			third: { linked: 0, skippedExisting: 0, skippedRemoved: 1, skippedOtherOrigin: 0, skippedUnsupported: 0, failed: 0 },
			backInA: false,
			createdMode: 0o700,
		});
	});

	// .codex → .codex-2 → .codex-4 と切り替えても、.codex で書いた会話は .codex-4 へ届かない。
	test('only links conversations that started in one of the two homes being linked', async () => {
		const a = join(home, '.codex');
		const b = join(home, '.codex-2');
		const c = join(home, '.codex-4');
		const ledgerPath = join(stateDirectory, 'links.json');
		const observeHomes = [a, b, c];
		rollout(a, 'rollout-from-a.jsonl');
		await paradisLinkCodexSessions([a, b], { ledgerPath, observeHomes });
		rollout(b, 'rollout-from-b.jsonl');
		const second = await paradisLinkCodexSessions([b, c], { ledgerPath, observeHomes });
		assert.deepStrictEqual({
			second,
			aInC: exists(join(c, day, 'rollout-from-a.jsonl')),
			bInC: exists(join(c, day, 'rollout-from-b.jsonl')),
		}, {
			second: { linked: 1, skippedExisting: 0, skippedRemoved: 0, skippedOtherOrigin: 1, skippedUnsupported: 0, failed: 0 },
			aInC: false,
			bInC: true,
		});
	});

	// 台帳が読めないときは、どれを消したのか分からないので何もリンクせず、壊れた台帳を退避する。
	test('stops linking and moves an unreadable ledger aside', async () => {
		const a = join(home, '.codex');
		const b = join(home, '.codex-2');
		mkdirSync(stateDirectory, { recursive: true });
		const ledgerPath = join(stateDirectory, 'links.json');
		writeFileSync(ledgerPath, '{broken');
		rollout(a, 'rollout-old.jsonl');
		const first = await paradisLinkCodexSessions([a, b], { ledgerPath });
		rollout(a, 'rollout-new.jsonl');
		const second = await paradisLinkCodexSessions([a, b], { ledgerPath });
		assert.deepStrictEqual({
			first,
			second,
			oldInB: exists(join(b, day, 'rollout-old.jsonl')),
			newInB: exists(join(b, day, 'rollout-new.jsonl')),
			backedUp: readdirSync(stateDirectory).some(name => name.startsWith('links.json.unreadable-')),
		}, {
			first: { linked: 0, skippedExisting: 0, skippedRemoved: 0, skippedOtherOrigin: 0, skippedUnsupported: 0, failed: 0, ledgerUnavailable: true },
			second: { linked: 1, skippedExisting: 0, skippedRemoved: 0, skippedOtherOrigin: 1, skippedUnsupported: 0, failed: 0 },
			oldInB: false,
			newInB: true,
			backedUp: true,
		});
	});
});
