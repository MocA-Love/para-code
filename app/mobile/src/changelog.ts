// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルアプリの更新履歴。
 *
 * ここが唯一の正本で、以下の2つが同じ配列を読む:
 *  - 更新後の初回起動で出す「アップデートのお知らせ」シート（updateSheet.tsx）
 *  - 設定 →「更新履歴」の一覧（app/changelog.tsx）
 *
 * **`app/mobile/` 配下をユーザー向けに変更したら、その作業の中で先頭バージョンの
 * `items` に1件追記すること**（運用ルールはリポジトリルートの CLAUDE.md 参照）。
 * 先頭の version は app.json の version と一致させる（ずれると通知が出ない／
 * 古い内容が出る。changelog.test.ts がこの一致を検査する）。
 */

/** お知らせシートの1項目。 */
export interface MobileChangelogItem {
	/** Ionicons の名前。 */
	readonly icon: string;
	/** 何ができるようになったか（体言止めにしない、短い一文）。 */
	readonly title: string;
	/** 補足（1〜2文）。省略可。 */
	readonly body?: string;
	/** アイコンの色調。既定は accent。 */
	readonly tone?: 'accent' | 'green' | 'purple' | 'yellow';
}

/** 1バージョンぶんの更新内容。 */
export interface MobileRelease {
	/** app.json の version と同じ形式（例: '0.2.0'）。 */
	readonly version: string;
	/** YYYY-MM-DD。 */
	readonly date: string;
	/** その版の目玉。書くとシートの大見出しになる（省略時は「今回の変更」）。 */
	readonly headline?: string;
	/** 空にするとその版はお知らせを出さない（内部整備だけのリリース用）。 */
	readonly items: readonly MobileChangelogItem[];
}

/** 新しい順に並べる。 */
export const MOBILE_CHANGELOG: readonly MobileRelease[] = [
	{
		version: '0.2.2',
		date: '2026-07-28',
		items: [
			{
				icon: 'chevron-down-circle-outline',
				title: 'エージェントを開いた瞬間から最新のやり取りが見えるようになりました',
				body: '開いたあとに履歴が上から流れ落ちて、最新まで一気にスクロールしていくことがありました。',
				tone: 'green',
			},
			{
				icon: 'people-outline',
				title: 'SubAgent一覧が、いま動いているものと直近の履歴だけになりました',
				body: '長く続いたセッションでは終わった子エージェントが何十件もたまり、今の状況が埋もれていました。1日より前のものは下の「過去の履歴を表示」にまとめています。',
			},
			{
				icon: 'pricetag-outline',
				title: 'SubAgentの名前と依頼内容が出るようになりました',
				body: 'これまでは一覧も詳細も「SubAgent」と並ぶだけで、どれが何をしていたのか見分けられませんでした。',
				tone: 'green',
			},
			{
				icon: 'help-circle-outline',
				title: '終わったエージェントが「状態不明」と表示されなくなりました',
				body: '終了の合図を取りこぼしても記録から判断します。長く走っている子エージェントも、生きているか確かめてから状態を落とすようにしました。',
				tone: 'green',
			},
			{
				icon: 'list-outline',
				title: 'SubAgentの詳細で、ツール履歴がアイコンだけになる問題を直しました',
				body: 'ツール名や対象が押し潰されて見えず、四角い印だけが並んでいました。',
				tone: 'green',
			},
			{
				icon: 'swap-horizontal-outline',
				title: 'ホーム一覧の左スワイプが効くようになりました',
				body: 'アーカイブしようと横に引いても行が動かず、ワークスペースを開く右スワイプまで効かなくなっていました。',
				tone: 'green',
			},
			{
				icon: 'paper-plane-outline',
				title: '送信予定の一覧が最後まで読めるように',
				body: '下の端で切れて続きに進めず、本文も画面の端に張り付いていました。指でたどって最後まで読めます。',
				tone: 'green',
			},
		],
	},
	{
		version: '0.2.1',
		date: '2026-07-28',
		items: [
			{
				icon: 'reader-outline',
				title: 'メモと新しいエージェントの開き方を刷新',
				body: '下からせり上がるシートをやめ、通知と同じく押したところから画面が広がる開き方になりました。どちらも全画面になり、項目が窮屈でなくなりました。',
			},
			{
				icon: 'create-outline',
				title: 'メモの保存とキャンセルを画面上部に',
				body: 'キーボードのすぐ上にあって押し間違えていたボタンを、指の届く上端へ移しました。',
				tone: 'green',
			},
			{
				icon: 'help-circle-outline',
				title: '複数ステップの質問に正しく答えられるように',
				body: '「その他」に自由入力したときや、複数選択の質問が混ざっているときに、答えが1問ずつずれてPCに入っていました。',
				tone: 'green',
			},
			{
				icon: 'paper-plane-outline',
				title: '作業中に送ったメッセージが「送信予定」として見えるように',
				body: 'エージェントが手を空けるまで会話に現れず、送れたのか分からなくなっていました。実行中の表示に件数が出て、タップすると読まれる順に確認できます。',
				tone: 'green',
			},
			{
				icon: 'file-tray-full-outline',
				title: '終わったエージェントをホームから片付けられるように',
				body: '一覧を左へスワイプするとアーカイブに入り、PCではそのまま動き続けます。ヘッダーの箱から見返して戻せます。質問や応答待ちになったものは自動でホームへ戻ります。',
			},
			{
				icon: 'hand-left-outline',
				title: '一覧の長押しメニューが早く開くように',
				body: '押してからメニューが出るまでの待ち時間を半分にしました。',
				tone: 'green',
			},
			{
				icon: 'pin',
				title: 'よく使うスペースをドロワーに残せるように',
				body: 'PCでピン留めしたスペースは、リポジトリを折りたたんでも一覧に残ります。ピンの印が付いた行がそれです。',
			},
		],
	},
	{
		version: '0.2.0',
		date: '2026-07-28',
		headline: 'エージェントの作業が読めるように',
		items: [
			{
				icon: 'list-outline',
				title: '思考とツール実行を1件ずつ開ける',
				body: 'エージェントが実行したことが時系列で並び、ツール名・対象・所要時間が一覧できます。開いた中身が数行で切られることもなくなりました。',
			},
			{
				icon: 'construct-outline',
				title: 'ツールごとに見やすい形で表示',
				body: 'コマンドと出力、ファイル、変更の差分、検索結果、チェックリスト。失敗したものは赤く示されます。',
				tone: 'yellow',
			},
			{
				icon: 'swap-horizontal-outline',
				title: '表とコードを横スクロールで',
				body: '画面幅に押し込まれて桁が崩れることがなくなりました。隠れている側にグラデーションが出ます。',
				tone: 'green',
			},
			{
				icon: 'people-outline',
				title: 'SubAgent の詳細も同じ表示に',
				body: 'これまでツール名が分からず「Tool」とだけ出ていた画面が、エージェント画面と同じ見え方になりました。',
				tone: 'purple',
			},
		],
	},
];

/**
 * セマンティックバージョンの比較（a が新しければ正、古ければ負）。
 * 数値以外の接尾辞（'1.2.0-beta.1' など）は数値部分だけで比較し、同値なら 0 を返す。
 */
export function compareVersions(a: string, b: string): number {
	const parse = (value: string) => value.split('.').map(part => Number.parseInt(part, 10) || 0);
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

/**
 * お知らせを出すべきリリース群（新しい順）。空配列なら何も出さない。
 *
 *  - `lastSeen === undefined`（新規インストール）は出さない。使ったことがない人に
 *    「変更点」を見せても意味がないため、呼び出し側は現在バージョンを既読にするだけにする
 *  - 既読より新しく、現在バージョン以下のものだけを対象にする（手元のアプリに
 *    入っていない先の版を見せない）
 *  - `items` が空の版（内部整備のみ）は除く。全部除かれたら結果も空になる
 */
export function pendingReleases(current: string, lastSeen: string | undefined, releases: readonly MobileRelease[] = MOBILE_CHANGELOG): MobileRelease[] {
	if (lastSeen === undefined) {
		return [];
	}
	return releases
		.filter(release => release.items.length > 0
			&& compareVersions(release.version, lastSeen) > 0
			&& compareVersions(release.version, current) <= 0)
		.sort((a, b) => compareVersions(b.version, a.version));
}
