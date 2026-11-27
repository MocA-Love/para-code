/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_BOT_ROLE_MAX_LENGTH } from '../../common/paradisBotsBandModel.js';
import { paradisBotHomeRelativePath, PARADIS_BOT_LIMITS } from '../../common/paradisBots.js';
import { PARADIS_BOT_TEMPLATE_CATALOG, paradisBotTemplate, paradisBotTemplateDefaultName, paradisBotTemplateSkillFile, paradisBotTemplateSkillPaths, paradisBotTemplateSkillSection, paradisBotTemplateSoul, paradisFilterBotTemplates } from '../../common/paradisBotTemplates.js';

suite('Paradis bot templates', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('一覧の並びと分類・検索', () => {
		assert.deepStrictEqual({
			all: PARADIS_BOT_TEMPLATE_CATALOG.map(template => `${template.category}:${template.id}:${template.skill?.name ?? '-'}`),
			releases: paradisFilterBotTemplates('releases', '').map(template => template.id),
			search: paradisFilterBotTemplates('all', 'ＣＩ').map(template => template.id),
			searchRole: paradisFilterBotTemplates('all', 'スペース').map(template => template.id),
			none: paradisFilterBotTemplates('ops', 'レビュー').length,
			unknown: paradisBotTemplate('blank'),
		}, {
			all: ['coding:review:pr-review-checklist', 'coding:repro:bug-reproduction', 'coding:deps:dependency-upgrade', 'releases:release:release-readiness', 'releases:ci:ci-failure-triage', 'ops:patrol:workspace-hygiene'],
			releases: ['release', 'ci'],
			search: ['ci'],
			searchRole: ['patrol'],
			none: 0,
			unknown: undefined,
		});
	});

	test('名前と役割は作成のモーダルの上限に収まり、スキルの場所は専用フォルダの中', () => {
		const problems = PARADIS_BOT_TEMPLATE_CATALOG.flatMap(template => [
			template.name.length > PARADIS_BOT_LIMITS.name ? `${template.id}: name` : undefined,
			template.role.length > PARADIS_BOT_ROLE_MAX_LENGTH ? `${template.id}: role` : undefined,
			...(template.skill ? paradisBotTemplateSkillPaths(template.skill).map(path => paradisBotHomeRelativePath(path) === path ? undefined : `${template.id}: ${path}`) : []),
		]).filter(problem => problem !== undefined);
		assert.deepStrictEqual(problems, []);
	});

	test('人格メモとスキルのファイル', () => {
		const review = paradisBotTemplate('review')!;
		assert.deepStrictEqual({
			soul: `${paradisBotTemplateSoul('レビュー係', ' 自分の言葉の役割 ', review)}\n${paradisBotTemplateSkillSection(review.skill!)}`,
			// スキルの節は人格メモの側には入れない（置けたときに shared process が足す）
			soulWithoutSkill: paradisBotTemplateSoul('レビュー係', '', review).includes('## スキル'),
			paths: paradisBotTemplateSkillPaths(review.skill!),
			skillHead: paradisBotTemplateSkillFile(review.skill!).split('\n').slice(0, 6),
		}, {
			soul: [
				'# レビュー係',
				'',
				'自分の言葉の役割',
				'',
				'## 見るもの',
				'',
				'自分にレビューが来た PR（選んだリポジトリ）',
				'',
				'## すること',
				'',
				'差分を読んで、危ない変更と足りないテストをファイルと行つきで挙げる',
				'',
				'## 知らせること',
				'',
				'判断が要る指摘だけ',
				'',
				'## 最初の会話で',
				'',
				'どのリポジトリを見るかを聞き、レビュー待ちの PR を読んで、見つけたことを会話に書く。GitHub にコメントするのは、持ち主が良いと言ってから。',
				'',
				'## スキル',
				'',
				'- pr-review-checklist: 作業の前に `.claude/skills/pr-review-checklist/SKILL.md`（Codex では `.agents/skills/pr-review-checklist/SKILL.md`）を読み、その手順に従う。',
				'',
			].join('\n'),
			soulWithoutSkill: false,
			paths: ['.claude/skills/pr-review-checklist/SKILL.md', '.agents/skills/pr-review-checklist/SKILL.md'],
			skillHead: [
				'---',
				'name: pr-review-checklist',
				'description: "PR の差分を読み、危ない変更と足りないテストをファイルと行つきで挙げるときの手順。"',
				'---',
				'',
				'# PR のレビュー',
			],
		});
	});

	test('SKILL.md の front matter は name と description だけ（allowed-tools などで道具の許可を足さない）。説明は引用符で囲む', () => {
		const heads = PARADIS_BOT_TEMPLATE_CATALOG.flatMap(template => template.skill ? [paradisBotTemplateSkillFile(template.skill)] : [])
			.map(file => file.split('\n---\n')[0].split('\n').slice(1).map(line => line.split(':')[0]));
		const quoted = PARADIS_BOT_TEMPLATE_CATALOG.flatMap(template => template.skill ? [paradisBotTemplateSkillFile(template.skill).split('\n')[2]] : [])
			.every(line => /^description: ".*"$/u.test(line));
		assert.deepStrictEqual({ heads: [...new Set(heads.map(keys => keys.join(',')))], quoted }, { heads: ['name,description'], quoted: true });
	});

	test('同じテンプレートから 2 体目を作るときは名前に番号を足す', () => {
		assert.deepStrictEqual([
			paradisBotTemplateDefaultName('PR のレビュー係', ['別の Bot']),
			paradisBotTemplateDefaultName('PR のレビュー係', ['PR のレビュー係']),
			paradisBotTemplateDefaultName('PR のレビュー係', ['ｐｒ のレビュー係', 'PR のレビュー係 2']),
		], ['PR のレビュー係', 'PR のレビュー係 2', 'PR のレビュー係 3']);
	});
});
