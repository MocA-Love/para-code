/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisGithubReferenceLookup } from '../../../../common/paradisIssueDetection.js';
import { IParadisWorktreeNamingInput, paradisDecideWorktreeNaming } from '../../common/paradisWorktreeNaming.js';

suite('worktree naming from a pasted issue or pull request', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ISSUE_URL = 'https://github.com/acme/app/issues/2236';
	// allow-any-unicode-next-line
	const TITLE = 'テンプレートJSONの重説マッピング';
	/** 作成元として残る Issue（題名は取れたときだけ）。 */
	const origin = (title?: string) => ({ url: ISSUE_URL, number: 2236, kind: 'issue' as const, ...(title !== undefined ? { title } : {}) });
	const found: ParadisGithubReferenceLookup = { kind: 'ok', info: { kind: 'issue', owner: 'acme', repo: 'app', number: 2236, title: TITLE, url: ISSUE_URL, state: 'open' } };

	/** 決め方を走らせ、結果と、外へ出た呼び出し（gh・命名のモデル）を返す。 */
	async function decide(input: Partial<IParadisWorktreeNamingInput>, options: { readonly lookup?: ParadisGithubReferenceLookup; readonly generated?: { readonly title?: string; readonly branch?: string } } = {}) {
		const calls: string[] = [];
		const naming = await paradisDecideWorktreeNaming({ name: '', branch: undefined, prompt: '', ...input }, {
			onNaming: () => { },
			lookupReference: async url => {
				calls.push(`gh ${url}`);
				return options.lookup;
			},
			generate: async namingPrompt => {
				calls.push(`model ${namingPrompt}`);
				return options.generated ?? {};
			},
			fallbackBranchName: seeds => `fallback(${seeds.map(seed => seed ?? '').join('|')})`,
			log: () => { },
		});
		return { naming, calls };
	}

	test('names the space after the first pasted issue and numbers the branch, using the title only as naming input', async () => {
		const prompt = `${ISSUE_URL} and https://github.com/acme/app/issues/2198`;

		assert.deepStrictEqual(await decide({ prompt }, { lookup: found, generated: { title: 'model title', branch: 'template-json-mapping' } }), {
			naming: {
				branch: '2236-template-json-mapping',
				// allow-any-unicode-next-line
				spaceName: '#2236 テンプレートJSONの重説マッピング',
				suggestedTitle: 'model title',
				// 作ったスペースに残す作成元（一覧の行のチップ）
				origin: origin(TITLE),
			},
			// 取るのは最初の URL だけ。題名は命名のモデルへの入力にだけ入る（結果に指示は無く、エージェントへ渡る指示は変わらない）
			calls: [`gh ${ISSUE_URL}`, `model ${TITLE}\n${prompt}`],
		});
	});

	test('a typed name or branch always wins, and nothing is fetched when both are typed', async () => {
		// allow-any-unicode-next-line
		const typedName = '重説マッピング修正';

		assert.deepStrictEqual({
			name: await decide({ prompt: ISSUE_URL, name: typedName }, { lookup: found, generated: { branch: 'mapping' } }),
			branch: await decide({ prompt: ISSUE_URL, branch: 'my-branch' }, { lookup: found }),
			both: await decide({ prompt: ISSUE_URL, name: typedName, branch: 'my-branch' }, { lookup: found }),
		}, {
			// 名前は打ったもの、番号はブランチ名にだけ使う
			name: { naming: { branch: '2236-mapping', spaceName: typedName, suggestedTitle: ISSUE_URL.slice(0, 24) + '\u2026', origin: origin(TITLE) }, calls: [`gh ${ISSUE_URL}`, `model ${TITLE}\n${ISSUE_URL}`] },
			// ブランチ名を打っていれば番号も足さず、命名のモデルも呼ばない
			// allow-any-unicode-next-line
			branch: { naming: { branch: 'my-branch', spaceName: '#2236 テンプレートJSONの重説マッピング', origin: origin(TITLE) }, calls: [`gh ${ISSUE_URL}`] },
			// 取りに行かなくても、作成元は残す（題名は無い）
			both: { naming: { branch: 'my-branch', spaceName: typedName, origin: origin() }, calls: [] },
		});
	});

	test('uses what the dialog already fetched, honours a dismissed card, and falls back when the lookup fails or times out', async () => {
		const dialogReference = { url: 'https://github.com/acme/app/pull/2241', number: 2241, kind: 'pr' as const, title: 'Fix the mapping' };

		assert.deepStrictEqual({
			fetched: await decide({ prompt: ISSUE_URL, reference: dialogReference }),
			dismissed: await decide({ prompt: ISSUE_URL, skipReference: true }, { lookup: found, generated: { branch: 'from-prompt' } }),
			failed: await decide({ prompt: ISSUE_URL }, { lookup: { kind: 'failed', reason: 'notFound' } }),
			timedOut: await decide({ prompt: ISSUE_URL, name: 'Typed' }, {}),
			noModel: await decide({ prompt: ISSUE_URL }, { lookup: found }),
		}, {
			// ダイアログが選んだ PR（指示の最初の URL ではない）を使い、取り直さない。モデルが使えなければ英字の題名から作る
			fetched: { naming: { branch: '2241-fix-the-mapping', spaceName: '#2241 Fix the mapping', suggestedTitle: ISSUE_URL.slice(0, 24) + '\u2026', origin: dialogReference }, calls: [`model Fix the mapping\n${ISSUE_URL}`] },
			dismissed: { naming: { branch: 'from-prompt', spaceName: '', suggestedTitle: ISSUE_URL.slice(0, 24) + '\u2026' }, calls: [`model ${ISSUE_URL}`] },
			// 取れなければ今までの付け方（作成は止めない）
			failed: { naming: { branch: `fallback(|${ISSUE_URL})`, spaceName: '', suggestedTitle: ISSUE_URL.slice(0, 24) + '\u2026', origin: origin() }, calls: [`gh ${ISSUE_URL}`, `model ${ISSUE_URL}`] },
			timedOut: { naming: { branch: `fallback(Typed|${ISSUE_URL})`, spaceName: 'Typed', suggestedTitle: ISSUE_URL.slice(0, 24) + '\u2026', origin: origin() }, calls: [`gh ${ISSUE_URL}`, `model ${ISSUE_URL}`] },
			// 日本語の題名でモデルも使えないときは、URL の文字からではなく番号から作る
			// allow-any-unicode-next-line
			noModel: { naming: { branch: 'issue-2236', spaceName: '#2236 テンプレートJSONの重説マッピング', suggestedTitle: ISSUE_URL.slice(0, 24) + '\u2026', origin: origin(TITLE) }, calls: [`gh ${ISSUE_URL}`, `model ${TITLE}\n${ISSUE_URL}`] },
		});
	});

	test('keeps the old naming when the prompt has no issue or pull request', async () => {
		assert.deepStrictEqual({
			// allow-any-unicode-next-line
			prompt: await decide({ prompt: 'ログインを直す' }, { generated: { title: 'ログイン修正', branch: 'fix-login' } }),
			empty: await decide({ name: 'Space' }),
		}, {
			// allow-any-unicode-next-line
			prompt: { naming: { branch: 'fix-login', spaceName: '', suggestedTitle: 'ログイン修正' }, calls: ['model ログインを直す'] },
			empty: { naming: { branch: 'fallback(Space|)', spaceName: 'Space' }, calls: [] },
		});
	});
});
