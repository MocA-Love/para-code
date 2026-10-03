/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisComposeNotifyBody, paradisComposeNotifyVariants, paradisFitNotifyBytesForPush, paradisFitNotifyForPush, paradisLegacyNotifySubtitle, paradisNotifyCategoryId, paradisNotifyTabLabel, paradisSealedNotifyLength, paradisStripMarkdownForNotify } from '../../common/paradisNotifyCompose.js';
import { paradisNotifyIncludeContent, paradisNotifyPrefersDetail } from '../../common/paradisNotifyDelivery.js';

suite('paradisComposeNotifyBody', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('種類の言葉を頭に付け、Markdown を外した本文と原文の詳細を作る', () => {
		assert.deepStrictEqual([
			paradisComposeNotifyBody({ category: 'done', content: '## 結果\n**テスト**は通りました', includeContent: true }),
			paradisComposeNotifyBody({ category: 'approval', content: 'Bash: `npm run test`', includeContent: true }),
			paradisComposeNotifyBody({ category: 'question', content: 'どちらにしますか？', includeContent: true }),
			paradisComposeNotifyBody({ category: 'error', content: 'You\'ve hit your usage limit.', errorCode: 'usage_limit_exceeded', includeContent: true }),
		], [
			{ body: '完了: 結果\nテストは通りました', detail: '## 結果\n**テスト**は通りました' },
			{ body: '承認待ち: Bash: npm run test', detail: 'Bash: `npm run test`' },
			{ body: '質問: どちらにしますか？', detail: 'どちらにしますか？' },
			{ body: 'エラー: エージェントがエラーで止まりました（usage_limit_exceeded）\nYou\'ve hit your usage limit.', detail: 'You\'ve hit your usage limit.' },
		]);
	});

	test('内容を含めない設定・中身が無いときは定型文（エラーの理由のコードだけは出す）', () => {
		assert.deepStrictEqual([
			paradisComposeNotifyBody({ category: 'done', content: '秘密の話', includeContent: false }),
			paradisComposeNotifyBody({ category: 'approval', includeContent: true }),
			paradisComposeNotifyBody({ category: 'question', content: '   ', includeContent: true }),
			paradisComposeNotifyBody({ category: 'error', content: '詳細', errorCode: 'rate_limit', includeContent: false }),
			paradisComposeNotifyBody({ category: 'error', errorCode: 'not a code!', includeContent: true }),
		], [
			{ body: 'エージェントが作業を完了しました' },
			{ body: 'エージェントが確認を求めています' },
			{ body: 'エージェントが質問しています' },
			{ body: 'エージェントがエラーで止まりました（rate_limit）' },
			{ body: 'エージェントがエラーで止まりました' },
		]);
	});

	test('秘密らしい値は本文でも詳細でも伏せる', () => {
		const composed = paradisComposeNotifyBody({ category: 'done', content: 'API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 を設定しました', includeContent: true });
		assert.deepStrictEqual([composed.body.includes('abcdefghijklmnop'), composed.detail?.includes('abcdefghijklmnop')], [false, false]);
	});

	test('Markdown の装飾に包まれた秘密も、本文と詳細の両方で伏せる', () => {
		const samples = [
			'**password**: hunter2xyz',
			'password: `hunter2xyz`',
			'- `DB_PASSWORD`: `s3cretValue`',
			'| API_KEY | abcdef123456 |',
			'| DB_PASSWORD | hunter2xyz | 本番 |',
		];
		const leaks = samples.map(sample => {
			const composed = paradisComposeNotifyBody({ category: 'done', content: `結果\n\n${sample}\n\n以上`, includeContent: true });
			return [composed.body, composed.detail ?? ''].some(text => /hunter2xyz|s3cretValue|abcdef123456/.test(text));
		});
		assert.deepStrictEqual(leaks, [false, false, false, false, false]);
	});

	test('表の行は伏せた値のセルだけを伏せ字にし、表の形を残す', () => {
		const composed = paradisComposeNotifyBody({ category: 'done', content: '| 名前 | 値 | 環境 |\n| --- | --- | --- |\n| DB_PASSWORD | hunter2xyz | 本番 |\n| region | us-east-1 | 本番 |', includeContent: true });
		assert.strictEqual(composed.detail, '| 名前 | 値 | 環境 |\n| --- | --- | --- |\n| DB_PASSWORD | *** | 本番 |\n| region | us-east-1 | 本番 |');
	});

	test('秘密の無い行の装飾はそのまま残す', () => {
		const composed = paradisComposeNotifyBody({ category: 'done', content: '**完了**しました\n\n| 名前 | 値 |\n| --- | --- |\n| a | 1 |', includeContent: true });
		assert.strictEqual(composed.detail, '**完了**しました\n\n| 名前 | 値 |\n| --- | --- |\n| a | 1 |');
	});

	test('長い発言は本文の上限で切る', () => {
		const composed = paradisComposeNotifyBody({ category: 'done', content: 'あ'.repeat(3000), includeContent: true });
		// allow-any-unicode-next-line
		assert.deepStrictEqual([composed.body.length, composed.body.endsWith('…'), composed.detail?.length], [1000, true, 3000]);
	});

	test('カテゴリの識別子', () => {
		assert.deepStrictEqual(['done', 'approval', 'question', 'error'].map(category => paradisNotifyCategoryId(category as 'done')), ['para.done', 'para.approval', 'para.question', 'para.error']);
	});
});

suite('paradisStripMarkdownForNotify', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('見出し・箇条書き・強調・リンク・コード・表を外す', () => {
		const markdown = [
			'# 見出し',
			'',
			'- **太字**と*斜体*と`code`',
			'- [リンク](https://example.com) と ![図](a.png)',
			'> 引用',
			'---',
			'```ts',
			'const a = 1;',
			'const b = 2;',
			'```',
			'| 名前 | 値 |',
			'| --- | --- |',
			'| a | 1 |',
			'snake_case_name は崩さない',
		].join('\n');
		assert.strictEqual(paradisStripMarkdownForNotify(markdown), [
			'見出し',
			'・太字と斜体とcode',
			'・リンク と 図',
			'引用',
			'const a = 1;',
			'名前 / 値',
			'a / 1',
			'snake_case_name は崩さない',
		].join('\n'));
	});
});

suite('paradisNotifyTabLabel / paradisLegacyNotifySubtitle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('エージェントの印を外し、空・エージェント名・スペース名と同じなら出さない', () => {
		assert.deepStrictEqual([
			// allow-any-unicode-next-line
			paradisNotifyTabLabel('✳ Monotor 180秒待機設置', 'Claude', 'para-code'),
			// allow-any-unicode-next-line
			paradisNotifyTabLabel('⠂ 作業中', 'Claude', 'para-code'),
			paradisNotifyTabLabel('claude', 'Claude', 'para-code'),
			paradisNotifyTabLabel('para-code', 'Codex', 'para-code'),
			// allow-any-unicode-next-line
			paradisNotifyTabLabel('✳', 'Claude', 'para-code'),
			paradisNotifyTabLabel(undefined, 'Claude', 'para-code'),
		], ['Monotor 180秒待機設置', '作業中', undefined, undefined, undefined, undefined]);
	});

	test('旧い受け手向けの副題は「エージェント · タブ名」', () => {
		assert.deepStrictEqual([
			paradisLegacyNotifySubtitle('Claude', 'monitor'),
			paradisLegacyNotifySubtitle('Codex', undefined),
			paradisLegacyNotifySubtitle(undefined, 'monitor'),
			paradisLegacyNotifySubtitle(undefined, undefined),
		], ['Claude · monitor', 'Codex', 'monitor', undefined]);
	});
});

suite('paradisFitNotifyForPush', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

	test('詳細を描けるアプリには、本文を下限まで削ってから詳細を削る', () => {
		const record = { kind: 'agent-done', id: 'n1', body: 'あ'.repeat(600), detail: 'い'.repeat(600) };
		const fitted = paradisFitNotifyForPush(record, 600 * 3 - 160 * 3 + 300, true);
		assert.ok(fitted);
		assert.deepStrictEqual([
			(fitted.body as string).length <= 161,
			typeof fitted.detail === 'string' && (fitted.detail as string).length >= 200 && (fitted.detail as string).length < 600,
			byteLength(record) - byteLength(fitted) >= 600 * 3 - 160 * 3 + 300,
		], [true, true, true]);
	});

	test('詳細が下限より短くしか残らないなら詳細を捨て、本文を戻す', () => {
		const record = { kind: 'agent-done', id: 'n1', body: 'あ'.repeat(600), detail: 'い'.repeat(250) };
		const fitted = paradisFitNotifyForPush(record, 1500, true);
		assert.ok(fitted);
		assert.deepStrictEqual([fitted.detail, (fitted.body as string).length > 160, byteLength(record) - byteLength(fitted) >= 1500], [undefined, true, true]);
	});

	test('詳細を描けないアプリには詳細を捨て、本文だけを削る。削れなければ undefined', () => {
		const fitted = paradisFitNotifyForPush({ id: 'n1', body: 'abcdefghij', detail: 'xyz' }, 15, false);
		assert.deepStrictEqual([fitted?.detail, fitted?.body, paradisFitNotifyForPush({ id: 'n1', body: '' }, 10, false)], [undefined, 'abcdefghij', undefined]);
		const trimmed = paradisFitNotifyForPush({ id: 'n1', body: 'abcdefghij' }, 4, false);
		// allow-any-unicode-next-line
		assert.strictEqual(trimmed?.body, 'abc…');
	});

	test('大きい詳細に片付けの印が付いても、印は残して本文と詳細を削り、封緘後の上限に収める', () => {
		const dismiss = Array.from({ length: 10 }, (_, index) => index.toString(16).padStart(32, 'a'));
		const record = { kind: 'agent-done', id: 'n1', title: 'para-code', body: 'あ'.repeat(1000), detail: 'い'.repeat(6000), agentToken: 't'.repeat(40), dismiss };
		const bytes = new TextEncoder().encode(JSON.stringify(record));
		const fitted = paradisFitNotifyBytesForPush(bytes, 3800, true);
		assert.ok(fitted);
		const parsed = JSON.parse(new TextDecoder().decode(fitted)) as { dismiss: string[]; body: string; detail?: string };
		assert.deepStrictEqual([
			paradisSealedNotifyLength(fitted.length) <= 3800,
			parsed.dismiss,
			parsed.body.length < 1000,
			typeof parsed.detail === 'string' && parsed.detail.length >= 200,
		], [true, dismiss, true, true]);
	});

	test('改行や引用符の多い詳細も、JSON にしたときの長さで削るので丸ごと捨てない', () => {
		const detail = '"q"\n'.repeat(1500);
		const record = { kind: 'agent-done', id: 'n1', title: 'para-code', body: '完了: '.concat('x'.repeat(400)), detail };
		const fitted = paradisFitNotifyBytesForPush(new TextEncoder().encode(JSON.stringify(record)), 3800, true);
		assert.ok(fitted);
		const parsed = JSON.parse(new TextDecoder().decode(fitted)) as { detail?: string };
		assert.deepStrictEqual([
			paradisSealedNotifyLength(fitted.length) <= 3800,
			typeof parsed.detail === 'string' && parsed.detail.length >= 200 && detail.startsWith(parsed.detail.slice(0, -1)),
		], [true, true]);
	});

	test('削る量は JSON のバイト数で見積もる（改行 1 字は 2 バイト）', () => {
		const fitted = paradisFitNotifyForPush({ id: 'n1', body: 'ab\n\n\n\n' }, 5, false);
		// 改行 4 字（JSON で 8 バイト）を外せば足りる。生の文字数で数えると 全部削っていた
		// allow-any-unicode-next-line
		assert.strictEqual(fitted?.body, 'ab…');
	});

	test('収まっているものはそのまま返し、JSON でないものは undefined', () => {
		const small = new TextEncoder().encode(JSON.stringify({ id: 'n1', body: 'ok' }));
		assert.deepStrictEqual([paradisFitNotifyBytesForPush(small, 3800, true) === small, paradisFitNotifyBytesForPush(new TextEncoder().encode('x'.repeat(4000)), 3800, true)], [true, undefined]);
	});

	test('「通知に内容を含める」は、項目を同期してきた新しいアプリが true のときだけ。旧アプリ（項目なし）は含めない', () => {
		assert.deepStrictEqual([
			paradisNotifyIncludeContent(undefined), paradisNotifyIncludeContent({ agentDone: true }),
			paradisNotifyIncludeContent({ includeContent: false }), paradisNotifyIncludeContent({ includeContent: true }),
			paradisNotifyPrefersDetail(undefined), paradisNotifyPrefersDetail({ agentDone: true }), paradisNotifyPrefersDetail({ includeContent: false }),
		], [false, false, false, true, false, false, true]);
	});

	test('旧アプリ（includeContent が undefined）へ送る版には、本文の中身・詳細・コマンドが無い', () => {
		const base = { kind: 'agent-question', id: 'n1', title: 'para-code', body: 'Bash: npm test', detail: '古い詳細', interactionId: 'toolu_1' };
		const variants = paradisComposeNotifyVariants(base, { category: 'approval', content: 'Bash: `rm -rf build`' });
		const pick = (prefs: { includeContent?: boolean; agentDone?: boolean } | undefined) => paradisNotifyIncludeContent(prefs) ? variants.withContent : variants.withoutContent;
		const oldApp = [pick(undefined), pick({ agentDone: true, includeContent: undefined })];
		assert.deepStrictEqual(oldApp.map(record => [record.body, record.detail, JSON.stringify(record).includes('rm -rf')]), [
			['エージェントが確認を求めています', undefined, false],
			['エージェントが確認を求めています', undefined, false],
		]);
		assert.deepStrictEqual([pick({ includeContent: true }).body, pick({ includeContent: true }).detail], ['承認待ち: Bash: rm -rf build', 'Bash: `rm -rf build`']);
	});

	test('内容を含めない版は副題からタブ名も外す（エージェント名だけ残す）', () => {
		const base = { kind: 'agent-done', id: 'n1', title: 'para-code', body: '', tab: 'monitor 設置', subtitle: 'Claude · monitor 設置', agent: 'claude' };
		const variants = paradisComposeNotifyVariants(base, { category: 'done', content: '終わりました', agentLabel: 'Claude' });
		const noAgent = paradisComposeNotifyVariants(base, { category: 'done', content: '終わりました' });
		assert.deepStrictEqual([
			[variants.withContent.tab, variants.withContent.subtitle],
			[variants.withoutContent.tab, variants.withoutContent.subtitle],
			[noAgent.withoutContent.tab, noAgent.withoutContent.subtitle],
		], [
			['monitor 設置', 'Claude · monitor 設置'],
			[undefined, 'Claude'],
			[undefined, undefined],
		]);
	});
});
