/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisTerminalNonceScopeDisagreement,
	paradisLookupProcessDetailScope,
	paradisMigrateProcessScopesToNonceScopes,
	paradisProcessDetailScopeLookupId,
	paradisParseTerminalNonceScopeStorage,
	paradisPruneNonceScopes,
	paradisResolveNonceScope,
	paradisResolveOrphanPtyOwners,
	paradisSerializeTerminalNonceScopeStorage,
} from '../../common/paradisTerminalNonceScope.js';

const NONCE_A = '11111111-1111-4111-8111-111111111111';
const NONCE_B = '22222222-2222-4222-8222-222222222222';

suite('Paradis terminal nonce scope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips a ledger and rejects a malformed one whole rather than in part', () => {
		const raw = paradisSerializeTerminalNonceScopeStorage(new Map([[NONCE_A, 'scope:a'], [NONCE_B, 'worktree:b']]));
		assert.ok(raw !== undefined);
		assert.deepStrictEqual([...paradisParseTerminalNonceScopeStorage(raw)!], [[NONCE_A, 'scope:a'], [NONCE_B, 'worktree:b']]);

		// 半端に生き残った対応で誤ったスペースへ寄せる方が害が大きいので、1件でも壊れていれば全部捨てる。
		for (const broken of [
			'not json',
			JSON.stringify({ nonce: NONCE_A, repositoryId: 'scope:a' }),
			JSON.stringify([{ nonce: '', repositoryId: 'scope:a' }]),
			JSON.stringify([{ nonce: NONCE_A, repositoryId: '' }]),
			JSON.stringify([{ nonce: NONCE_A, repositoryId: 'scope:a' }, { nonce: NONCE_A, repositoryId: 'scope:b' }]),
			JSON.stringify([{ nonce: NONCE_A, repositoryId: 'scope:a' }, null]),
		]) {
			assert.strictEqual(paradisParseTerminalNonceScopeStorage(broken), undefined, broken.slice(0, 40));
		}
	});

	// nonce 台帳は「ID 台帳が漏らした端末を拾う」ためのもので、引けなければ従来の答えをそのまま返す。
	// 食い違ったときに ID 台帳を採るのは、nonce の revive 跨ぎの不変性が実機未検証のため。
	test('fills in what the process ledger missed but never overrides it', () => {
		const ledger = new Map([[NONCE_A, 'scope:from-nonce']]);
		const disagreements: IParadisTerminalNonceScopeDisagreement[] = [];
		const resolve = (nonce: string | undefined, processStateKey: string | undefined) =>
			paradisResolveNonceScope(ledger, nonce, processStateKey, d => disagreements.push(d));

		assert.strictEqual(resolve(NONCE_A, undefined), 'scope:from-nonce', 'ID台帳が漏らした端末を拾う');
		assert.strictEqual(resolve(NONCE_B, undefined), undefined, '台帳に無ければ従来どおり未解決');
		assert.strictEqual(resolve(undefined, 'scope:from-pid'), 'scope:from-pid', 'nonceが無ければ従来の答え');
		assert.strictEqual(resolve('', 'scope:from-pid'), 'scope:from-pid', '空nonceはキーにしない');
		assert.strictEqual(resolve(NONCE_A, 'scope:from-nonce'), 'scope:from-nonce', '一致は素通し');
		assert.deepStrictEqual(disagreements, [], 'ここまで食い違いは起きない');

		assert.strictEqual(resolve(NONCE_A, 'scope:from-pid'), 'scope:from-pid', '食い違ったらID台帳を採る');
		assert.deepStrictEqual(disagreements, [{ nonce: NONCE_A, nonceStateKey: 'scope:from-nonce', processStateKey: 'scope:from-pid' }]);
	});

	// 上限を超えたら保存を諦める（呼び出し側は前回の内容を残して警告する）。黙って
	// 空の台帳を書くと、それまでの対応が全部消えて所属不明が一気に増える。
	test('gives up persisting rather than writing a truncated ledger', () => {
		const tooMany = new Map<string, string>();
		for (let index = 0; index < 4_097; index++) {
			tooMany.set(`nonce-${index}`, 'scope:a');
		}
		assert.strictEqual(paradisSerializeTerminalNonceScopeStorage(tooMany), undefined);
	});

	// 移行の初回起動で翻訳しないと、既存の端末が一斉に「nonceでは引けない」状態から始まる。
	test('translates the process ledger without overwriting what this session already knows', () => {
		const ledger = new Map([[NONCE_A, 'scope:this-session']]);
		const migrated = paradisMigrateProcessScopesToNonceScopes(
			ledger,
			new Map([[1, 'scope:stale'], [2, 'worktree:b'], [3, 'scope:no-nonce']]),
			new Map([[1, NONCE_A], [2, NONCE_B]]),
		);

		// 足した分だけを返す。呼び出し側が読み側の全件を写して prune を巻き戻さないための契約。
		assert.deepStrictEqual({
			added: [...migrated],
			ledger: [...ledger],
			second: [...paradisMigrateProcessScopesToNonceScopes(ledger, new Map(), new Map())],
		}, {
			added: [[NONCE_B, 'worktree:b']],
			ledger: [[NONCE_A, 'scope:this-session'], [NONCE_B, 'worktree:b']],
			second: [],
		});
	});

	// 台帳のキーは「前セッションの PTY ID」で、PTY 一覧が返すのは今世代の ID。呼び出し側が
	// revive 元の ID を選んで渡す前提なので、この関数は渡された対応表をそのまま信じる。
	// 新旧の ID がたまたま衝突しても別の端末のスコープを拾わないことを、ここで固定しておく。
	test('trusts the caller to hand over ids from the ledger generation', () => {
		const ledger = new Map<string, string>();
		paradisMigrateProcessScopesToNonceScopes(
			ledger,
			// 前セッションの台帳: ID 7 は worktree:old のものだった。
			new Map([[7, 'worktree:old']]),
			// 呼び出し側が revive 元の ID (7) を選んで渡した場合だけ対応が作られる。
			new Map([[7, NONCE_A]]),
		);
		assert.deepStrictEqual([...ledger], [[NONCE_A, 'worktree:old']]);

		const mismatched = new Map<string, string>();
		paradisMigrateProcessScopesToNonceScopes(
			mismatched,
			new Map([[7, 'worktree:old']]),
			// 今世代の ID (99) しか分からない端末は、対応を作らずに見送る。
			new Map([[99, NONCE_B]]),
		);
		assert.deepStrictEqual([...mismatched], []);
	});

	test('drops records that no live terminal owns any more', () => {
		const ledger = new Map([[NONCE_A, 'scope:a'], [NONCE_B, 'worktree:b']]);
		paradisPruneNonceScopes(ledger, [NONCE_A, undefined, '']);
		assert.deepStrictEqual([...ledger], [[NONCE_A, 'scope:a']]);
	});

	// この台帳が拾いたいのは「非アクティブスペースの端末」で、それはそのスペースへ切り替えるまで
	// live にならない。読み側まで prune すると、起動のたびに対象を自分で捨てることになる
	// （ID 台帳が読み側と書き側を分けているのと同じ理由）。呼び出し側がその2枚を保つ前提を、
	// 起動 → prune → 切り替えで復元、の順で固定しておく。
	test('keeps a non-active space terminal resolvable after a startup prune', () => {
		const stored = new Map([[NONCE_A, 'scope:active'], [NONCE_B, 'worktree:other']]);
		const writeSide = new Map(stored);
		const readSide = new Map(stored);

		// 起動直後に live なのはアクティブスペースの端末だけ。
		paradisPruneNonceScopes(writeSide, [NONCE_A]);

		assert.deepStrictEqual({
			write: [...writeSide],
			// 別スペースへ切り替えて初めて復元される端末は、読み側から引けなければならない。
			resolvedAfterSwitch: paradisResolveNonceScope(readSide, NONCE_B, undefined),
		}, {
			write: [[NONCE_A, 'scope:active']],
			resolvedAfterSwitch: 'worktree:other',
		});
	});

	// 常駐から引き取った端末は、前世代の ID を持たないまま今世代の ID を渡されて現れる。ID 台帳の
	// 鍵は前世代の ID なので、そのまま引くと**空振りでは済まず別端末の記録に当たる**。実機では、
	// 更新をまたいだ端末がどのスペースにも出てこない／別スペースに紛れる、という形になる。
	test('a terminal taken back from a daemon is placed by its nonce, never by its new id', () => {
		// 前セッションの ID 5 は、いまは無関係な端末のもの。
		const processScopes = new Map([[5, 'worktree:someone-else']]);
		const nonceScopes = new Map([[NONCE_A, 'worktree:mine']]);

		assert.deepStrictEqual({
			adopted: paradisLookupProcessDetailScope(
				{ id: 5, shellIntegrationNonce: NONCE_A, paradisAdopted: true }, processScopes, nonceScopes),
			lookupId: paradisProcessDetailScopeLookupId({ id: 5, shellIntegrationNonce: NONCE_A, paradisAdopted: true }),
			// 引き取り以外は今までどおり: revive は前世代の ID を教えてくれるし、リロードは ID が変わらない。
			revived: paradisLookupProcessDetailScope(
				{ id: 20, shellIntegrationNonce: NONCE_B, paradisRevivedFromPersistentProcessId: 5 }, processScopes, nonceScopes),
			reloaded: paradisLookupProcessDetailScope(
				{ id: 5, shellIntegrationNonce: NONCE_B }, processScopes, nonceScopes),
		}, {
			adopted: 'worktree:mine',
			lookupId: undefined,
			revived: 'worktree:someone-else',
			reloaded: 'worktree:someone-else',
		});
	});

	// 孤児 PTY への attach は、端末をスペースまたぎで動かしうる唯一の経路。nonce は「同じ端末か」
	// しか示さないので、所有スペースを台帳で証明できないものは全部落とす、という判定を固定する。
	suite('paradisResolveOrphanPtyOwners', () => {

		const WORKSPACE = 'workspace:mine';

		function resolve(
			details: readonly { id: number; shellIntegrationNonce: string; workspaceId: string; paradisRevivedFromPersistentProcessId?: number; paradisAdopted?: boolean }[],
			ledgers: {
				restoredProcess?: readonly (readonly [number, string])[];
				restoredNonce?: readonly (readonly [string, string])[];
				nonce?: readonly (readonly [string, string])[];
			} = {},
		) {
			const owners = paradisResolveOrphanPtyOwners(
				details,
				WORKSPACE,
				new Map(ledgers.restoredProcess ?? []),
				new Map(ledgers.restoredNonce ?? []),
				new Map(ledgers.nonce ?? []),
			);
			return Object.fromEntries([...owners].map(([nonce, owner]) => [nonce, owner]));
		}

		test('claims a pty whose owner the current nonce ledger knows', () => {
			assert.deepStrictEqual(
				resolve([{ id: 7, shellIntegrationNonce: NONCE_A, workspaceId: WORKSPACE }], { nonce: [[NONCE_A, 'worktree:mine']] }),
				{ [NONCE_A]: { id: 7, stateKey: 'worktree:mine' } },
			);
		});

		test('falls back to the restored ledgers when the current one has forgotten the terminal', () => {
			assert.deepStrictEqual({
				byRestoredNonce: resolve(
					[{ id: 7, shellIntegrationNonce: NONCE_A, workspaceId: WORKSPACE }],
					{ restoredNonce: [[NONCE_A, 'worktree:mine']] }),
				byRestoredProcessId: resolve(
					[{ id: 7, shellIntegrationNonce: NONCE_B, workspaceId: WORKSPACE }],
					{ restoredProcess: [[7, 'worktree:mine']] }),
			}, {
				byRestoredNonce: { [NONCE_A]: { id: 7, stateKey: 'worktree:mine' } },
				byRestoredProcessId: { [NONCE_B]: { id: 7, stateKey: 'worktree:mine' } },
			});
		});

		test('refuses every pty whose owning space cannot be proven', () => {
			assert.deepStrictEqual({
				// どの台帳も知らない。nonce が一致するというだけで attach すると、所属不明の端末が
				// 「今のスペース」に吸い寄せられて混ざる。
				unknownOwner: resolve([{ id: 7, shellIntegrationNonce: NONCE_A, workspaceId: WORKSPACE }]),
				// 復元時と現在で別のスペースを指している。どちらが正しいか決められない。
				disagreeingLedgers: resolve(
					[{ id: 7, shellIntegrationNonce: NONCE_A, workspaceId: WORKSPACE }],
					{ restoredNonce: [[NONCE_A, 'worktree:mine']], nonce: [[NONCE_A, 'worktree:other']] }),
				// 別ウィンドウ (別ワークスペース) の端末。
				otherWorkspace: resolve(
					[{ id: 7, shellIntegrationNonce: NONCE_A, workspaceId: 'workspace:other' }],
					{ nonce: [[NONCE_A, 'worktree:mine']] }),
				// nonce を持たない端末は同一性を示せない。
				missingNonce: resolve(
					[{ id: 7, shellIntegrationNonce: '', workspaceId: WORKSPACE }],
					{ restoredProcess: [[7, 'worktree:mine']] }),
			}, {
				unknownOwner: {},
				disagreeingLedgers: {},
				otherWorkspace: {},
				missingNonce: {},
			});
		});

		test('drops both sides when the same nonce comes back twice', () => {
			// 同一性を証明できないので、先に見つかった方も残さない。
			assert.deepStrictEqual(
				resolve([
					{ id: 7, shellIntegrationNonce: NONCE_A, workspaceId: WORKSPACE },
					{ id: 8, shellIntegrationNonce: NONCE_A, workspaceId: WORKSPACE },
					{ id: 9, shellIntegrationNonce: NONCE_B, workspaceId: WORKSPACE },
				], { nonce: [[NONCE_A, 'worktree:mine'], [NONCE_B, 'worktree:mine']] }),
				{ [NONCE_B]: { id: 9, stateKey: 'worktree:mine' } },
			);
		});

		test('keeps a terminal taken back from a daemon out of the space its new id happens to hit', () => {
			// 引き取った端末は今世代の ID で現れる。ID 台帳を引くと別端末の記録に当たるため、
			// ID 側は引かず nonce だけで判断する（paradisProcessDetailScopeLookupId と同じ理由）。
			assert.deepStrictEqual({
				withoutNonceLedger: resolve(
					[{ id: 5, shellIntegrationNonce: NONCE_A, workspaceId: WORKSPACE, paradisAdopted: true }],
					{ restoredProcess: [[5, 'worktree:someone-else']] }),
				withNonceLedger: resolve(
					[{ id: 5, shellIntegrationNonce: NONCE_A, workspaceId: WORKSPACE, paradisAdopted: true }],
					{ restoredProcess: [[5, 'worktree:someone-else']], nonce: [[NONCE_A, 'worktree:mine']] }),
			}, {
				withoutNonceLedger: {},
				withNonceLedger: { [NONCE_A]: { id: 5, stateKey: 'worktree:mine' } },
			});
		});
	});
});
