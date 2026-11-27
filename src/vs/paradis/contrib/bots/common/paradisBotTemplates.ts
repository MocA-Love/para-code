/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のテンプレート（作成の S のモーダルから開く M のモーダルの一覧）と、テンプレートごとの人格メモ（SOUL.md）の中身・
// 付属のスキル（SKILL.md）。
//
// Orca（stablyai/orca、MIT License）の 24 個のテンプレートのうち、Slack・Linear・Google を前提にせず GitHub とこの PC
// だけで動くものから、Para Code で意味のある 6 個を選び、中身とスキルを Para Code 向けに日本語で書き直した。
// 作った後のテンプレートの変更は、作り済みの Bot に届かない（人格メモとスキルは作るときに 1 回だけ書く）。
//
// スキルは Bot の専用フォルダの `.claude/skills/<名前>/SKILL.md`（Claude Code のプロジェクトのスキル）と
// `.agents/skills/<名前>/SKILL.md`（Codex）に置き、人格メモからも場所を指す（見つからない版のエージェントでも読めるように）。

import { localize } from '../../../../nls.js';

export type ParadisBotTemplateCategory = 'coding' | 'releases' | 'ops';
export const PARADIS_BOT_TEMPLATE_CATEGORIES: readonly ParadisBotTemplateCategory[] = ['coding', 'releases', 'ops'];

export interface IParadisBotTemplateSkill {
	/** フォルダの名前（英小文字とハイフン）。 */
	readonly name: string;
	/** SKILL.md の front matter の説明（エージェントがいつ使うかを決める 1 文）。 */
	readonly description: string;
	/** SKILL.md の本文（見出しから）。 */
	readonly body: string;
}

export interface IParadisBotTemplate {
	readonly id: string;
	readonly category: ParadisBotTemplateCategory;
	/** 一覧と作成のモーダルの名前（Bot の名前の既定にもなる）。 */
	readonly name: string;
	/** 一覧の 2 行目。作成のモーダルの「役割」の既定にもなる。 */
	readonly role: string;
	readonly watches: string;
	readonly does: string;
	readonly reports: string;
	/** 最初の会話ですること（人格メモに書く）。 */
	readonly firstChat: string;
	readonly skill?: IParadisBotTemplateSkill;
	/** 付いてくるものの補足（定期実行など）。 */
	readonly note?: string;
}

export function paradisBotTemplateCategoryLabel(category: ParadisBotTemplateCategory | 'all', count?: number): string {
	switch (category) {
		case 'all': return localize('paradis.bots.templates.all', "すべて（{0}）", count ?? 0);
		case 'coding': return localize('paradis.bots.templates.coding', "コーディング");
		case 'releases': return localize('paradis.bots.templates.releases', "リリースと CI");
		case 'ops': return localize('paradis.bots.templates.ops', "運用");
	}
}

// ---- スキル ----------------------------------------------------------------------------------------

const PR_REVIEW_SKILL: IParadisBotTemplateSkill = {
	name: 'pr-review-checklist',
	description: localize('paradis.bots.skill.prReview.description', "PR の差分を読み、危ない変更と足りないテストをファイルと行つきで挙げるときの手順。"),
	body: localize('paradis.bots.skill.prReview.body', "# PR のレビュー\n\n書き始める前に差分を全部読み、大事な変更の周り（呼び出し元・テスト・間接に触るファイル）も読みます。\n\n## 見ること\n\n1. 振る舞いの変化: 既定値、消えた分岐、変わったエラー、順番、設定の名前など、使う人や別のモジュールが気づくもの。\n2. 端の場合: 空の入力、値が無い、2 回目の呼び出し、再試行、時間切れ、同時の呼び出し、とても大きい入力。\n3. 足りないテスト: 新しい分岐や直した不具合に、変更が無ければ落ちるテストが無い。\n4. 危ない変更: 移行、削除、権限の確認、起動時に動くもの、共有の状態、公開の API と通信の形。\n5. 残りもの: デバッグの出力、コメントにしたコード、本当の穴を隠す TODO。\n\n## 書き方\n\n- 1 つの指摘を 1 行に、重いものから。\n- 指摘ごとにファイルと行（`src/retry.ts:42`）を書き、何が・誰に・いつ起きるかを書く。\n- 確かでないときはそう書く。数を増やさない（本物の 3 件は推測の 10 件に勝つ）。\n- 書き方と名前は、不具合を隠しているときだけ。\n- 最後の 1 行に「マージしてよい」か「先に直すこと」。\n\n## してはいけないこと\n\n- 報告は会話に書く。PR にコメントするのは、持ち主が良いと言ってから。\n- 他人のブランチへ push しない。\n"),
};

const CI_SKILL: IParadisBotTemplateSkill = {
	name: 'ci-failure-triage',
	description: localize('paradis.bots.skill.ci.description', "落ちたチェックを、本物の失敗・不安定なテスト・基盤の問題に分けて原因を書くときの手順。"),
	body: localize('paradis.bots.skill.ci.body', "# 落ちたチェックの仕分け\n\n## 先に分ける\n\n- 本物の失敗: 再実行しても同じように落ち、失敗が変更の中のコードを指している。\n- 不安定: コードを変えずに再実行すると通る、または関係の無い変更でも落ちる。同じチェックのほかのブランチでの最近の結果を見る。\n- 基盤: 実行機・ネットワーク・キャッシュ・パッケージの取得、またはテストが始まる前の時間切れ。ログが途中で終わるか、コードではなくサービスの名前が出る。\n\n## 本物の失敗\n\n1. 最後ではなく最初のエラーを読む（後のエラーは多くがその響き）。\n2. 始まったコミットを探す（同じブランチで通った後の最初の失敗）。\n3. ファイルと行を挙げ、なぜ壊れたかを書く。\n\n## 不安定なチェック\n\n- 一覧を持つ: チェックの名前、テストの名前、最近の実行で何回落ちたか、エラーの行。\n- 10 回に 1 回より多く落ちるものを挙げる。\n\n## 書き方\n\nチェックごとに 1 行: 名前、種類（本物・不安定・基盤）、原因か根拠、次の一手。直し始めるのは持ち主が良いと言ってから。\n"),
};

const RELEASE_SKILL: IParadisBotTemplateSkill = {
	name: 'release-readiness',
	description: localize('paradis.bots.skill.release.description', "次のリリースを止めているものと、入る変更の一覧を短く保つときの手順。"),
	body: localize('paradis.bots.skill.release.body', "# リリースの準備\n\nこの一覧に開いたものが無ければ、リリースできます。短く、今の状態に保ちます。\n\n## リリースを止めるもの\n\n1. リリースのブランチか、リリースに入れる PR で落ちている必須のチェック。\n2. リリースに要るのにレビュー待ちの PR。\n3. 止めている Issue（blocker のラベル、またはリリースのマイルストーンで閉じていないもの）。\n4. 前のリリースの後に見つかった戻り（regression）の、まだマージしていない直し。\n\n## 書き方\n\n- 上の 4 種で分け、リンクを付ける。\n- 1 件ごとに、誰の持ち分か、どれだけ待っているか。\n- 最初の行に「止まっている」か「出せる」と、一番大きい止めているもの。\n- 止めないものは書かない。\n- 入る変更は「新機能・改善・修正」に分けて変更履歴の下書きにする。実機で確かめていないものには印を付ける。\n\n## 正直に\n\n- 書く前に 1 件ずつ確かめ直す（マージ済みの PR や、通った再実行はもう止めていない）。\n- 自分で「出せる」と決めない。「出せそうです」と書き、決めるのは持ち主。\n- タグを打たない・リリースを公開しない。\n"),
};

const REPRO_SKILL: IParadisBotTemplateSkill = {
	name: 'bug-reproduction',
	description: localize('paradis.bots.skill.repro.description', "報告された不具合を再現し、どこで起き始めるかを探すときの手順。"),
	body: localize('paradis.bots.skill.repro.body', "# 不具合の再現\n\nわざと起こせない不具合は、まだ分かっていません。先に再現、次に説明、直すのは最後です。\n\n## 手順\n\n1. 事実を集める: 版、OS、報告した人がしたこと、期待したこと、起きたこと。足りないものを書き、1 回だけ聞く。\n2. 手順を書く: きれいな状態から始まる、ほかの人がたどれる番号つきの手順。\n3. 起こす: 手順どおりに動かす。起きなければ 1 つずつ変え（OS・データの大きさ・タイミング・設定）、試したことを残す。\n4. 小さくする: これ以上消すと起きなくなるところまで手順を減らす。\n5. テストで示す: テストのあるコードなら、落ちるテストが一番の再現。\n6. 始まる場所を探す: 最後に正しい所から最初に間違う所までデータを追い、ファイルと行を挙げる。\n\n## 書き方\n\n- 手順と、毎回起きるか時々か（どれくらいの割合か）。\n- 原因を 1〜2 文で、ファイルと行つきで。\n- 直し方の案とその危なさ。直し始めるのは持ち主が良いと言ってから。\n\n再現できなければ、試したことと、何があれば進めるかを書きます。\n"),
};

const DEPS_SKILL: IParadisBotTemplateSkill = {
	name: 'dependency-upgrade',
	description: localize('paradis.bots.skill.deps.description', "古い・脆弱な依存を調べ、まとまりごとに上げ方を提案するときの手順。"),
	body: localize('paradis.bots.skill.deps.body', "# 依存の更新\n\n## 何を上げるか\n\n- まずセキュリティの勧告を、重い順に。\n- 次にメジャー版、その次にマイナー版とパッチ。\n- プロジェクトのパッケージマネージャーとその監査のコマンドを使う（道具を変えない）。\n\n## まとめ方\n\n- 一緒に出るパッケージ（フレームワークとそのプラグイン）は 1 つのまとまり。\n- メジャー版の更新はそれぞれ 1 つのまとまり。\n- 勧告の無いマイナー版とパッチは 1 つにまとめてよい。\n\n## まとまりごとに\n\n1. 今の版から新しい版までの変更履歴を読み、壊れる変更と、コードが使っている非推奨のものを控える。\n2. そのまとまりだけを上げる。lock ファイルの変更も同じコミットに入れる。\n3. ビルドとテストを走らせる。壊れたものを直すか、止めて報告する。\n4. まとまりごとに 1 つの PR。説明に版、当てはまった壊れる変更、そのために変えたことを書く。\n\n## 書き方\n\n急ぐものから: パッケージ、今の版と新しい版、理由（勧告かメジャー版か）、見込みの手間。PR を開くのは持ち主が良いと言ってから。\n"),
};

const PATROL_SKILL: IParadisBotTemplateSkill = {
	name: 'workspace-hygiene',
	description: localize('paradis.bots.skill.patrol.description', "終わった・放置されたスペース（ワークツリー）と、誰も見ていないエージェントの作業を見つけるときの手順。"),
	body: localize('paradis.bots.skill.patrol.body', "# スペースの見回り\n\n## 終わった・放置された\n\n- 終わった: PR がマージか閉じられ、その後に変更が無い。\n- 放置: 2 週間以上変更が無く、開いた PR も無い。\n- 誰も見ていない作業: エージェントが終えたのに、持ち主が差分も PR も見ていない。\n\n## 消す前に確かめること\n\n1. コミットしていない変更（ファイルを挙げる）。\n2. push していないコミット。\n3. その中で動いているエージェントやターミナル。\n\nコミットしていない・push していない作業のあるスペースは、持ち主が名前を挙げて良いと言わない限り消しません。\n\n## 書き方\n\n一覧: スペース、終わった・放置・未確認に見える理由、上の確かめたこと。消すのは持ち主が選んだものだけ。\n"),
};

// ---- テンプレート ----------------------------------------------------------------------------------

/** 一覧の並び（分類の順、その中は使われそうな順）。白紙は一覧の外（作成のモーダルの既定）。 */
export const PARADIS_BOT_TEMPLATE_CATALOG: readonly IParadisBotTemplate[] = [
	{
		id: 'review',
		category: 'coding',
		name: localize('paradis.bots.template.review', "PR のレビュー係"),
		role: localize('paradis.bots.template.reviewRole', "開いた PR を読み、危ない変更と足りないテストを挙げる。"),
		watches: localize('paradis.bots.template.reviewWatches', "自分にレビューが来た PR（選んだリポジトリ）"),
		does: localize('paradis.bots.template.reviewDoes', "差分を読んで、危ない変更と足りないテストをファイルと行つきで挙げる"),
		reports: localize('paradis.bots.template.reviewReports', "判断が要る指摘だけ"),
		firstChat: localize('paradis.bots.template.reviewFirst', "どのリポジトリを見るかを聞き、レビュー待ちの PR を読んで、見つけたことを会話に書く。GitHub にコメントするのは、持ち主が良いと言ってから。"),
		skill: PR_REVIEW_SKILL,
	},
	{
		id: 'repro',
		category: 'coding',
		name: localize('paradis.bots.template.repro', "不具合の再現係"),
		role: localize('paradis.bots.template.reproRole', "報告から再現の手順を作り、どこで起き始めるかを探す。"),
		watches: localize('paradis.bots.template.reproWatches', "持ち主が渡した不具合の報告（Issue・メモ・会話）"),
		does: localize('paradis.bots.template.reproDoes', "再現の手順を作って起こし、手順を小さくして、起き始める場所をファイルと行つきで挙げる"),
		reports: localize('paradis.bots.template.reproReports', "再現できたとき・足りない情報があるとき"),
		firstChat: localize('paradis.bots.template.reproFirst', "どの不具合から始めるかを聞く。報告に足りないもの（版・OS・手順）があれば 1 回だけ聞く。直し始めるのは持ち主が良いと言ってから。"),
		skill: REPRO_SKILL,
	},
	{
		id: 'deps',
		category: 'coding',
		name: localize('paradis.bots.template.deps', "依存の更新係"),
		role: localize('paradis.bots.template.depsRole', "古い・脆弱なパッケージを調べ、上げ方を提案する。"),
		watches: localize('paradis.bots.template.depsWatches', "選んだリポジトリの依存とセキュリティの勧告"),
		does: localize('paradis.bots.template.depsDoes', "勧告とメジャー版を先に、まとまりごとに上げ方と手間を挙げる"),
		reports: localize('paradis.bots.template.depsReports', "勧告が見つかったとき"),
		firstChat: localize('paradis.bots.template.depsFirst', "どのリポジトリを見るかを聞き、監査のコマンドで今の勧告と古い依存を一覧にする。PR を開くのは持ち主が良いと言ってから。"),
		skill: DEPS_SKILL,
	},
	{
		id: 'release',
		category: 'releases',
		name: localize('paradis.bots.template.release', "リリース係"),
		role: localize('paradis.bots.template.releaseRole', "次のリリースに入る PR と変更履歴と実機確認の残りをまとめる。迷ったら聞く。"),
		watches: localize('paradis.bots.template.releaseWatches', "前のリリースの後にマージした PR、落ちているチェック、レビュー待ちの PR"),
		does: localize('paradis.bots.template.releaseDoes', "止めているものの一覧と、変更履歴の下書き（実機で確かめていないものに印）を作る"),
		reports: localize('paradis.bots.template.releaseReports', "リリースを止めるものが見つかったとき"),
		firstChat: localize('paradis.bots.template.releaseFirst', "前のリリースのタグを探し、入る PR と止めているものを一覧にする。タグを打つ・公開するのは持ち主。"),
		skill: RELEASE_SKILL,
	},
	{
		id: 'ci',
		category: 'releases',
		name: localize('paradis.bots.template.ci', "CI の見張り"),
		role: localize('paradis.bots.template.ciRole', "落ちたチェックを調べ、原因と直し方をまとめる。"),
		watches: localize('paradis.bots.template.ciWatches', "開いている PR のチェック（選んだリポジトリ）"),
		does: localize('paradis.bots.template.ciDoes', "本物の失敗・不安定・基盤の問題に分け、原因と直し方をまとめる。不安定なチェックの一覧を持つ"),
		reports: localize('paradis.bots.template.ciReports', "本物の失敗だけ"),
		firstChat: localize('paradis.bots.template.ciFirst', "最近 2 週間のチェックを読んで不安定なものを挙げ、開いている PR の落ちたチェックを 1 つずつ説明する。直し始めるのは持ち主が良いと言ってから。"),
		skill: CI_SKILL,
	},
	{
		id: 'patrol',
		category: 'ops',
		name: localize('paradis.bots.template.patrol', "見回り係"),
		role: localize('paradis.bots.template.patrolRole', "終わったのに誰も見ていないエージェントの作業と、片付けてよいスペースを挙げる。"),
		watches: localize('paradis.bots.template.patrolWatches', "Para Code のスペース（ワークツリー）とその PR"),
		does: localize('paradis.bots.template.patrolDoes', "見ていない作業と、終わった・放置のスペースを挙げ、消すかどうかを聞く"),
		reports: localize('paradis.bots.template.patrolReports', "まとめて 1 日 1 回"),
		firstChat: localize('paradis.bots.template.patrolFirst', "今のスペースを一覧にして、終わった・放置・未確認に見えるものを挙げる。スペースを消すのは持ち主が選んだものだけ。"),
		skill: PATROL_SKILL,
		note: localize('paradis.bots.template.patrolNote', "見回りの定期実行はオフで入ります。Bot の設定のタブで時刻を決めます"),
	},
];

/** 一覧の 1 つ（無ければ undefined）。 */
export function paradisBotTemplate(id: string | undefined): IParadisBotTemplate | undefined {
	return PARADIS_BOT_TEMPLATE_CATALOG.find(template => template.id === id);
}

/** 分類で絞り、名前・役割で探す（大文字・小文字と全角・半角をそろえる）。 */
export function paradisFilterBotTemplates(category: ParadisBotTemplateCategory | 'all', query: string): readonly IParadisBotTemplate[] {
	const key = query.trim().normalize('NFKC').toLowerCase();
	return PARADIS_BOT_TEMPLATE_CATALOG.filter(template => (category === 'all' || template.category === category)
		&& (key.length === 0 || `${template.name}\n${template.role}`.normalize('NFKC').toLowerCase().includes(key)));
}

/** スキルを置く専用フォルダの中の相対パス（Claude Code と Codex の両方）。 */
export function paradisBotTemplateSkillPaths(skill: Pick<IParadisBotTemplateSkill, 'name'>): readonly string[] {
	return [`.claude/skills/${skill.name}/SKILL.md`, `.agents/skills/${skill.name}/SKILL.md`];
}

/**
 * SKILL.md の中身（front matter つき）。front matter は `name` と `description` だけ（`allowed-tools` などで道具の許可を
 * 足さない）。説明は訳で `:`・`#` が入っても YAML として読めるよう、引用符で囲む。
 */
export function paradisBotTemplateSkillFile(skill: IParadisBotTemplateSkill): string {
	return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}`;
}

/** 人格メモ（SOUL.md）の末尾に足すスキルの節（スキルを置けたときだけ足す）。 */
export function paradisBotTemplateSkillSection(skill: Pick<IParadisBotTemplateSkill, 'name'>): string {
	const [claude, codex] = paradisBotTemplateSkillPaths(skill);
	return [
		localize('paradis.bots.templateSoul.skills', "## スキル"),
		'',
		localize('paradis.bots.templateSoul.skill', "- {0}: 作業の前に `{1}`（Codex では `{2}`）を読み、その手順に従う。", skill.name, claude, codex),
		'',
	].join('\n');
}

/** 同じ名前の Bot がいれば「名前 2」「名前 3」…と番号を足す（テンプレートから 2 体目を作るとき）。 */
export function paradisBotTemplateDefaultName(name: string, taken: readonly string[]): string {
	const used = new Set(taken.map(value => value.trim().normalize('NFKC').toLowerCase()));
	const key = (value: string) => value.normalize('NFKC').toLowerCase();
	if (!used.has(key(name))) {
		return name;
	}
	for (let index = 2; ; index++) {
		const candidate = `${name} ${index}`;
		if (!used.has(key(candidate))) {
			return candidate;
		}
	}
}

/**
 * テンプレートから作る Bot の人格メモ（SOUL.md）。役割は作成のモーダルで書き換えた文。スキルの節は入れない
 * （スキルを置けたときに、shared process が {@link paradisBotTemplateSkillSection} を末尾に足す）。
 */
export function paradisBotTemplateSoul(name: string, role: string, template: IParadisBotTemplate): string {
	const lines = [
		`# ${name}`,
		'',
		role.trim() || template.role,
		'',
		localize('paradis.bots.templateSoul.watches', "## 見るもの"),
		'',
		template.watches,
		'',
		localize('paradis.bots.templateSoul.does', "## すること"),
		'',
		template.does,
		'',
		localize('paradis.bots.templateSoul.reports', "## 知らせること"),
		'',
		template.reports,
		'',
		localize('paradis.bots.templateSoul.first', "## 最初の会話で"),
		'',
		template.firstChat,
		'',
	];
	return lines.join('\n');
}
