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
		version: '0.12.30',
		date: '2026-11-26',
		items: [
			{
				icon: 'refresh-circle-outline',
				title: '質問や許可に答えた後、カードや「質問」「許可待ち」の表示が残ることがある問題を直しました',
				body: 'PC が受け付けたのにカードが残るときは、PC から状態を取り直します。それでも残るときは「選び直す」が出ます。PC の Para Code の更新も要ります。',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.29',
		date: '2026-11-22',
		items: [
			{
				icon: 'play-circle-outline',
				title: '閉じた Antigravity CLI のターミナル宛ての預かり送信から、会話を再開できるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
		],
	},
	{
		version: '0.12.28',
		date: '2026-11-19',
		items: [
			{
				icon: 'notifications-outline',
				title: 'PC が 2 台以上のとき、通知の副題に OpenCode・Antigravity の名前が出ないのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.27',
		date: '2026-11-19',
		items: [
			{
				icon: 'git-compare-outline',
				title: '変更の画面の「差分」で、Markdown・HTML を描いた見た目のまま比べられるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'options-outline',
				title: '変更の画面で開いたときの見方を、Markdown は「差分」、HTML は「Raw」にしました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.26',
		date: '2026-11-18',
		items: [
			{
				icon: 'create-outline',
				title: 'Claude Code の返信を、書かれている最中から読めるようになりました',
			},
		],
	},
	{
		version: '0.12.25',
		date: '2026-11-16',
		items: [
			{
				icon: 'time-outline',
				title: 'Antigravity CLI の許可の確認が時間切れになったら、カードを押せないようにしました',
				body: '時間切れの確認は PC のターミナルで答えてください。',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.24',
		date: '2026-11-16',
		items: [
			{
				icon: 'chatbubbles-outline',
				title: 'Antigravity CLI の会話と質問をアプリで見て、チャット欄から送れるようになりました',
				body: '質問・確認への回答は PC の端末で答えてください。',
			},
			{
				icon: 'time-outline',
				title: '過去の会話の一覧に Antigravity CLI の会話も出て、PC で再開できるようになりました',
			},
			{
				icon: 'rocket-outline',
				title: 'アプリから Antigravity CLI を起動でき、使用量にそのリミットも出るようになりました',
			},
		],
	},
	{
		version: '0.12.23',
		date: '2026-11-15',
		items: [
			{
				icon: 'refresh-outline',
				title: '使用量の画面に、Claude のリミットリセットの残りと期限が出るようになりました',
			},
		],
	},
	{
		version: '0.12.22',
		date: '2026-11-13',
		items: [
			{
				icon: 'accessibility-outline',
				title: 'VoiceOver で、お知らせ・状態の点・一覧の値や列の幅を読み上げるようにしました',
				tone: 'green',
			},
			{
				icon: 'hand-left-outline',
				title: 'ボタンを押したときの手応えを、行やカードと同じ地の色の変化にそろえました',
				tone: 'green',
			},
			{
				icon: 'shield-checkmark-outline',
				title: 'Markdown のプレビューで、埋め込みのページや外の画像を読み込まないようにしました',
				tone: 'green',
			},
			{
				icon: 'shield-checkmark-outline',
				title: 'HTML・Excel・Word から外のページへ出るときは、開く前に確かめるようにしました',
				tone: 'green',
			},
			{
				icon: 'shield-checkmark-outline',
				title: '暗号化されていない中継サーバー（ws://）の QR コードではペアリングしないようにしました',
				body: '自前の中継サーバーは PC の設定で wss:// を指定してください。',
				tone: 'yellow',
			},
			{
				icon: 'git-commit-outline',
				title: '接続が切れても、PC でコミットできていれば「コミットしました」と出るようにしました',
				tone: 'green',
			},
			{
				icon: 'git-branch-outline',
				title: 'ソース管理と差分の画面で、字の太さとアイコンをそろえ、× と選択の丸を押しやすくしました',
				tone: 'green',
			},
			{
				icon: 'home-outline',
				title: 'ホームの「おかえりなさい」を外し、件数のカードを一番上に出すようにしました',
				body: '設定の「チャット UI」は「会話の表示」に名前を変えました。',
				tone: 'green',
			},
			{
				icon: 'refresh-outline',
				title: '過去の会話・変更のレビュー・コンテキストの内訳で、読み込みに失敗しても中身を残し、理由を日本語で出すようにしました',
				body: '取り直しの間は「更新中」と出し、その場で再試行できます。',
				tone: 'green',
			},
			{
				icon: 'refresh-outline',
				title: '「エージェントを起動」で候補を読めないとき、理由を出してその場で再試行できるようにしました',
				tone: 'green',
			},
			{
				icon: 'document-text-outline',
				title: 'ターミナルや会話のファイルのリンクも、行番号と検索のある画面で開くようにしました',
				tone: 'green',
			},
			{
				icon: 'color-palette-outline',
				title: '設定 → 色の「選択の印」の色が、質問の選択肢とキー行にも当たるようにしました',
				tone: 'green',
			},
			{
				icon: 'cloud-offline-outline',
				title: 'ペアリングで中継サーバーにつながらないとき、通信状態を確かめるよう案内するようにしました',
				tone: 'green',
			},
			{
				icon: 'warning-outline',
				title: '承認カードで、+ を付けた push にも「強制 push」の札を出すようにしました',
				tone: 'green',
			},
			{
				icon: 'accessibility-outline',
				title: 'VoiceOver で、セッションのタブ・メモの選択の丸・ウィジェットの「確認済み」を読み上げるようにしました',
				tone: 'green',
			},
			{
				icon: 'accessibility-outline',
				title: '「視差効果を減らす」がオンのときは、実行中の輪を回さないようにしました',
				tone: 'green',
			},
			{
				icon: 'text-outline',
				title: 'ボタン・空の表示・更新のお知らせの文字の太さを、ほかの画面とそろえました',
				tone: 'green',
			},
			{
				icon: 'refresh-outline',
				title: 'レビューのメモから起動するエージェントの候補を、PC とつながり直したら読み直すようにしました',
				tone: 'green',
			},
			{
				icon: 'git-merge-outline',
				title: 'マージ中にスペースを移ると、前のスペースの失敗が移った先に出ていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'chatbubble-ellipses-outline',
				title: '質問への回答を送れなかったとき、打った回答が消えていたのを直しました',
				body: '送れなかった回答は入力欄の下書きに戻ります。',
				tone: 'green',
			},
			{
				icon: 'image-outline',
				title: '写真を読み込めなかったとき、何も出ずに止まっていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'terminal-outline',
				title: '起動のシートで「ターミナル」を選んでも、後で Claude に変わることがあったのを直しました',
				tone: 'green',
			},
			{
				icon: 'home-outline',
				title: 'ホームの数字と内蔵ブラウザのページ数が、桁が変わると横に揺れていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'open-outline',
				title: 'HTML のファイルを開くと、Safari が勝手に開くことがあったのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.21',
		date: '2026-11-12',
		items: [
			{
				icon: 'shield-checkmark-outline',
				title: 'PC で「実行の前に確認する」にしたコマンドプリセットは、アプリでも確認を出すようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'cloud-offline-outline',
				title: 'SSH 先の会話を PC が読めていないとき、トークに「最新を取得できていません」と出すようにしました',
				tone: 'green',
			},
			{
				icon: 'shield-checkmark-outline',
				title: '「名前を打って確認」にしたコマンドプリセットは、名前を打つまで実行しないようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'cloud-offline-outline',
				title: 'SSH 先の長い会話で前の発言を読み込めないときは、PC のターミナルで見られると出すようにしました',
				tone: 'green',
			},
			{
				icon: 'cloud-offline-outline',
				title: 'SSH 先の長い会話で、トークが古いまま止まることがあったのを直しました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
		],
	},
	{
		version: '0.12.20',
		date: '2026-11-10',
		items: [
			{
				icon: 'eye-off-outline',
				title: 'PC の「AI 利用リミット」で隠したアカウントを、使用量・ホーム・ウィジェットにも出さないようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'swap-horizontal-outline',
				title: 'PC の一覧が届く前のモデル名で、fable を Fable 5.2 と出すようにしました',
				tone: 'green',
			},
			{
				icon: 'information-circle-outline',
				title: '使用量の画面で、金額に含められないモデルがあるとき、その名前を注記で出すようにしました',
				tone: 'green',
			},
			{
				icon: 'eye-off-outline',
				title: '使用量の画面で、隠したアカウントを「非表示中のアカウント」に畳んで名前だけ出すようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'swap-horizontal-outline',
				title: 'Mythos 5.2 が出た後、会話の途中で Mythos 5.1 に切り替えられなかったのを直しました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
		],
	},
	{
		version: '0.12.19',
		date: '2026-11-07',
		items: [
			{
				icon: 'albums-outline',
				title: '発言の長押しの「前後の発言もまとめて選ぶ…」で、発言をまたいで選んでコピーできるようになりました',
			},
			{
				icon: 'return-up-back-outline',
				title: '発言の長押しの「引用して返信」で、その発言を引用して返信できるようになりました',
			},
			{
				icon: 'ellipsis-horizontal-circle-outline',
				title: '発言・ファイル・ソース管理・差分の行の長押しで、操作のメニューが出るようになりました',
			},
			{
				icon: 'search-outline',
				title: 'ファイル一覧のフォルダの長押しで、そのフォルダの中だけを検索できるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'swap-horizontal-outline',
				title: '会話の途中で、Mythos 5.1 のように版を固定したモデルにも切り替えられるようになりました',
			},
			{
				icon: 'document-text-outline',
				title: 'Markdown や HTML のプレビューのファイルのパスを、押して開けるようになりました',
			},
			{
				icon: 'send-outline',
				title: 'クイック返信を押したら、そのまま送れるようになりました',
				body: '設定 →「クイック返信」でオンにすると使えます。',
			},
			{
				icon: 'swap-horizontal-outline',
				title: '過去の会話を Codex で再開するとき、どちらのアカウントで開くかを選べるようになりました',
			},
			{
				icon: 'pie-chart-outline',
				title: 'セッションのシートの「コンテキスト」から、使っているものの内訳を開けるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'copy-outline',
				title: '会話のコードブロックにコピーのボタンが付き、発言をその場で選んでコピーできるようになりました',
			},
			{
				icon: 'link-outline',
				title: '会話の中の素の URL を、押して開いたりコピーしたりできるようになりました',
			},
			{
				icon: 'ellipsis-horizontal-circle-outline',
				title: '過去の会話の発言や差分レビューの見出しのパスも、長押しで操作できるようになりました',
			},
			{
				icon: 'server-outline',
				title: 'SSH 先のスペースでは、モデルのシートに SSH 先の Claude Code のモデルが並ぶようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'document-text-outline',
				title: 'ツールのファイルのカードからファイルを開け、引用や箇条書きも読みやすくしました',
				tone: 'green',
			},
			{
				icon: 'text-outline',
				title: '「範囲を選んでコピー…」で、押した単語がすぐ選ばれ、表とコードの見た目も元の表示とそろえました',
				tone: 'green',
			},
			{
				icon: 'phone-portrait-outline',
				title: '「範囲を選んでコピー…」のお知らせが、選んでいる発言やクイック返信の帯に重ならないようにしました',
				tone: 'green',
			},
			{
				icon: 'document-outline',
				title: 'ファイルのビューアで、幅や色を指定していない HTML を読みやすく出すようにしました',
				tone: 'green',
			},
			{
				icon: 'lock-open-outline',
				title: '起動直後の Face ID は、出せないとき少し待って 1 回だけやり直し、取り消した直後は出ないようにしました',
				tone: 'green',
			},
			{
				icon: 'color-palette-outline',
				title: '設定のスイッチをオンのときアクセントの色にし、見分けやすくしました',
				tone: 'green',
			},
			{
				icon: 'alert-circle-outline',
				title: '描画が止まった Word の文書を、数秒で「表示できない」と知らせるようにしました',
				tone: 'green',
			},
			{
				icon: 'checkmark-done-outline',
				title: '「確認済みをステージ」で、確認の後に書き換えられたファイルを足さないようにしました',
				tone: 'green',
			},
			{
				icon: 'swap-horizontal-outline',
				title: 'ターミナルのタブを行き来したとき、表示が出るまで待たないようにしました',
				tone: 'green',
			},
			{
				icon: 'shield-checkmark-outline',
				title: '画面の表示中に問題が起きても、アプリごと落ちずに「再試行」を出すようにしました',
				tone: 'green',
			},
			{
				icon: 'flash-outline',
				title: 'エージェントの作業中やターミナルの出力が多いときの、画面のもたつきを減らしました',
				tone: 'green',
			},
			{
				icon: 'document-outline',
				title: '大きな PDF・Word・画像を開くときに、アプリが固まる時間を短くしました',
				tone: 'green',
			},
			{
				icon: 'document-outline',
				title: '裏から戻ったとき、変わっていないファイルは読んでいた位置を残すようにしました',
				tone: 'green',
			},
			{
				icon: 'tablet-landscape-outline',
				title: 'iPad で列やドックの幅を変えるときの動きを軽くしました',
				tone: 'green',
			},
			{
				icon: 'copy-outline',
				title: 'コピーしたときのお知らせを、どの画面でもそろえました',
				tone: 'green',
			},
			{
				icon: 'checkmark-done-outline',
				title: '「確認済みをステージ」で足せなかったファイルは、理由を分けて知らせるようにしました',
				tone: 'green',
			},
			{
				icon: 'git-branch-outline',
				title: 'ソース管理の未追跡のフォルダの行で、アイコンと名前が正しく出ないのを直しました',
				tone: 'green',
			},
			{
				icon: 'text-outline',
				title: 'PC の画面の行の最後の発言に、Markdown の記号が混ざって出ていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'keypad-outline',
				title: 'iPad で発言を長押ししたとき、キーボードがメニューを隠していたのを直しました',
				tone: 'green',
			},
			{
				icon: 'alert-circle-outline',
				title: 'ファイルのビューアで、読めない形の中身が届くと落ちていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'alert-circle-outline',
				title: '表示に失敗したときの案内が、画面の上端や iPad のウィンドウの操作ボタンに重なっていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'tablet-landscape-outline',
				title: 'iPad で開いているセッションの行をもう一度押すと、入力途中の文字やターミナルが消えていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'document-outline',
				title: 'ファイルや差分の表示が、白紙のまま戻らないことがあったのを直しました',
				tone: 'green',
			},
			{
				icon: 'time-outline',
				title: '前面に戻った直後に、過去の会話の一覧を読み込めないままになるのを直しました',
				tone: 'green',
			},
			{
				icon: 'document-outline',
				title: '大きな Word が「表示結果が空でした」になることがあったのを直しました',
				tone: 'green',
			},
			{
				icon: 'speedometer-outline',
				title: '過去の会話とソース管理で、文字を打つたびに画面が引っかかるのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.18',
		date: '2026-10-28',
		items: [
			{
				icon: 'help-circle-outline',
				title: 'Codex が作業を止めずに出す質問に、モバイルから答えられるようになりました',
			},
		],
	},
	{
		version: '0.12.17',
		date: '2026-10-27',
		items: [
			{
				icon: 'chatbubbles-outline',
				title: 'OpenCode の会話を、モバイルで確認・操作できるようになりました',
			},
			{
				icon: 'time-outline',
				title: '連携に対応していない OpenCode でも、過去の会話の一覧と再開を使えるようになりました',
			},
		],
	},
	{
		version: '0.12.16',
		date: '2026-10-26',
		items: [
			{
				icon: 'chatbubble-ellipses-outline',
				title: '選択肢を選ばずにメモだけで答えるときは、送る前に確かめるようにしました',
				tone: 'green',
			},
			{
				icon: 'checkbox-outline',
				title: '複数選択の質問で「その他」に書いて答えると、チェックした選択肢が外れていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'hand-left-outline',
				title: '複数の質問のカードで素早くタップすると、先のチェックが外れることがあったのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.15',
		date: '2026-10-21',
		items: [
			{
				icon: 'lock-closed-outline',
				title: 'Face ID を登録していない端末でも、パスコードでアプリをロックできるようになりました',
			},
			{
				icon: 'document-text-outline',
				title: '送れなかったメモや依頼の文が、知らせなく消えないようにしました',
				body: '保存できなかったメモはクリップボードに写します。',
				tone: 'green',
			},
			{
				icon: 'apps-outline',
				title: 'ウィジェットで確認済みにした操作を、送れるまで送り直すようにしました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.14',
		date: '2026-10-20',
		items: [
			{
				icon: 'shield-checkmark-outline',
				title: 'PC でしか許可できない確認と、読むだけの操作の確認を見分けて出すようになりました',
			},
		],
	},
	{
		version: '0.12.13',
		date: '2026-10-19',
		items: [
			{
				icon: 'eye-off-outline',
				title: 'スクリーンショット用に、使用量のアカウントのメールを番号で出せるようになりました',
				body: '使用量の画面の右上の目のボタンで切り替えます。',
			},
			{
				icon: 'home-outline',
				title: 'ホームのカードのメールも、使用量の画面と同じ番号で出すようにしました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.12',
		date: '2026-10-16',
		items: [
			{
				icon: 'notifications-outline',
				title: '通知を長押ししたとき、中身が出ずに暗い板だけになっていたのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.11',
		date: '2026-10-15',
		items: [
			{
				icon: 'create-outline',
				title: 'PC の Claude Code の入力欄の書きかけが、会話の入力欄の上に出るようになりました',
				body: 'Para Code と Claude Code 2.1.300 以上が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'create-outline',
				title: 'PC の入力欄に書きかけがある間は、送った発言が書きかけにつながらないようにしました',
				body: 'Para Code と Claude Code 2.1.300 以上が要ります。',
				tone: 'yellow',
			},
		],
	},
	{
		version: '0.12.10',
		date: '2026-10-10',
		items: [
			{
				icon: 'images-outline',
				title: '画像を埋め込んだ大きな HTML も、最後まで開いて画像を押せるようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
		],
	},
	{
		version: '0.12.9',
		date: '2026-10-09',
		items: [
			{
				icon: 'stats-chart-outline',
				title: 'ホームの「要対応」「実行中」「今日のコスト」を押して、中身を開けるようになりました',
			},
			{
				icon: 'stats-chart-outline',
				title: 'ホームの「実行中」を全 PC の合計にし、見ていない PC のカードにも数を出すようにしました',
				tone: 'green',
			},
			{
				icon: 'stats-chart-outline',
				title: 'ホームで、つながっていない PC の台数をカードの下に出すようにしました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.8',
		date: '2026-10-08',
		items: [
			{
				icon: 'sparkles-outline',
				title: 'モデルの候補の Haiku を Haiku 5.5 にし、effort も選べるようにしました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.7',
		date: '2026-10-07',
		items: [
			{
				icon: 'people-outline',
				title: 'Claude Code のエージェントチームを、トークで 1 枚のカードとして見られるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'navigate-outline',
				title: 'ブラウザの画面共有で、エージェントのカーソルが見えるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
		],
	},
	{
		version: '0.12.6',
		date: '2026-10-06',
		items: [
			{
				icon: 'ellipse-outline',
				title: '入力欄の細い輪で、コンテキストの使用率とキャッシュの切れ目が分かるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'moon-outline',
				title: 'PC のおやすみモードを、アプリから PC ごとに入れたり切ったりできるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'git-network-outline',
				title: 'Claude Code の Workflow を、トークで 1 枚のカードとして見られるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'notifications-off-outline',
				title: 'ほかの iPhone・iPad や PC で見た通知が、この端末からも消えるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'pulse-outline',
				title: '設定の「接続の記録」で、通信の速さを計測できるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'document-text-outline',
				title: '大きいテキストファイルを、最後まで読めるようになりました',
			},
			{
				icon: 'terminal-outline',
				title: 'SSH の接続先で動くエージェントの、バックグラウンドのシェルの出力を読めるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'ellipse-outline',
				title: '入力欄の輪を押して、キャッシュやコンテキスト、シェルと Monitor の一覧を見られるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'speedometer-outline',
				title: 'claude-swap と共有している Claude のアカウントで、使用量の前の値を残すようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'link-outline',
				title: 'PC から登録を外されたときは、ペアリングし直しを案内するようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'checkmark-done-outline',
				title: '送れたか分からない指示を送り直しても、二重に届かないようにしました',
				tone: 'green',
			},
			{
				icon: 'git-network-outline',
				title: 'Workflow が動かしたサブエージェントも、一覧と詳細に出るようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'flash-outline',
				title: '会話を開いたときの読み込みを軽くしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'document-text-outline',
				title: 'Markdown と HTML のプレビューを、色付けを待たずに開くようにしました',
				tone: 'green',
			},
			{
				icon: 'document-text-outline',
				title: 'PowerPoint・zip・HEIC のような開けない形式は、「この形式はまだ開けません」と出すようにしました',
				tone: 'green',
			},
			{
				icon: 'git-compare-outline',
				title: 'SSH の接続先が応答しないときは、待ち続けずに「接続先が応答しません」と出すようにしました',
				tone: 'green',
			},
			{
				icon: 'globe-outline',
				title: 'ブラウザの画面共有で、映像が止まったら画像の共有に戻るようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'notifications-outline',
				title: '音声通知をオンにしたまま別のアプリへ移ると、バナーが出なかったのを直しました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'git-network-outline',
				title: 'サブエージェントの詳細が、開いている間に止まっていたのを直しました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'git-compare-outline',
				title: '大きな差分を開くと、読み込み中のまま止まっていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'chatbox-ellipses-outline',
				title: '差分のメモを保存し直すと、2 件に重なっていたのを直しました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'terminal-outline',
				title: 'ターミナルを開き直すと、さかのぼれる履歴が短くなっていたのを直しました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
		],
	},
	{
		version: '0.12.5',
		date: '2026-10-05',
		items: [
			{
				icon: 'volume-high-outline',
				title: '読み上げ（Aivis・ElevenLabs）の使用量を見られるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'volume-high-outline',
				title: '音声通知が、PC で合成を始めるとすぐ鳴り、声の大きさもそろうようにしました',
				body: 'PC の Para Code も更新しないとつながりません。',
				tone: 'yellow',
			},
			{
				icon: 'call-outline',
				title: '電話で音声通知が途切れても、終わった後に続きから鳴るようにしました',
				tone: 'green',
			},
			{
				icon: 'volume-high-outline',
				title: '続けて届いた音声通知を、捨てずに順に鳴らすようにしました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.4',
		date: '2026-10-04',
		items: [
			{
				icon: 'code-slash-outline',
				title: 'スラッシュコマンドの候補に、プラグインや MCP のコマンドも出るようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'alert-circle-outline',
				title: '存在しないコマンドを送ったとき、理由を出して文を入力欄に戻すようにしました',
				tone: 'green',
			},
			{
				icon: 'options-outline',
				title: '入力欄の /model と /effort で、PC に一覧を開かずにモデルのシートが開くようにしました',
				tone: 'green',
			},
			{
				icon: 'options-outline',
				title: 'モデルのピルや /model の別名から、確認の画面を出さずに切り替えるようにしました',
				tone: 'green',
			},
			{
				icon: 'albums-outline',
				title: 'PC で設定の画面（/config）が開いている間は、入力欄の上に帯と「閉じる」を出すようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'stats-chart-outline',
				title: '/usage は使用量の画面、/status はこの端末のカードで開くようにしました',
				tone: 'green',
			},
			{
				icon: 'layers-outline',
				title: 'コンテキストの圧縮を、区切り線と畳んだ要約で出すようにしました',
				tone: 'green',
			},
			{
				icon: 'alert-circle-outline',
				title: 'Codex の入力欄に文字が残っているときは、送らずに理由と端末を開くボタンを出すようにしました',
				tone: 'green',
			},
			{
				icon: 'options-outline',
				title: 'Codex で /model を送ろうとしたときは、送る前に案内を出すようにしました',
				tone: 'green',
			},
			{
				icon: 'albums-outline',
				title: '画面を開くスラッシュコマンドは、候補に札を付け、手で打って送るときは確かめるようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'layers-outline',
				title: 'コンテキストの圧縮中は「会話を要約しています」と出し、Codex の圧縮も区切り線で出すようにしました',
				tone: 'green',
			},
			{
				icon: 'send-outline',
				title: 'Codex で、送信ボタンが押せないままになることがあったのを直しました',
				tone: 'green',
			},
			{
				icon: 'layers-outline',
				title: '圧縮の要約が自分の発言として出る・「/compact」が 2 つ並ぶのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.3',
		date: '2026-10-04',
		items: [
			{
				icon: 'terminal-outline',
				title: 'Claude Code が裏で動かしているシェルを、入力欄の右のピルから確かめて止められるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'shield-checkmark-outline',
				title: '許可のカードで、コマンドの全文やファイルの差分を見てから答えられるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'shield-checkmark-outline',
				title: '許可のカードの「No」と「拒否」を「拒否」にまとめ、代わりの指示を書けるようにしました',
				tone: 'green',
			},
			{
				icon: 'pulse-outline',
				title: 'システムの画面で、グラフと同じ値のバーを出さないようにしました',
				tone: 'green',
			},
			{
				icon: 'shield-checkmark-outline',
				title: 'サブエージェントからの許可のカードに、送り元を出すようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'resize-outline',
				title: 'iPad で、使用量の画面の右の列がはみ出していたのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.2',
		date: '2026-10-03',
		items: [
			{
				icon: 'pulse-outline',
				title: 'PC のシステム使用率を、推移のグラフで見られるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'refresh-circle-outline',
				title: 'Codex の枠のリセットの残り回数と期限を、見られるようになりました',
			},
			{
				icon: 'help-circle-outline',
				title: '質問の選択肢のプレビューを見て、答えられるようになりました',
			},
			{
				icon: 'help-circle-outline',
				title: 'Claude Mods が動いている PC では、質問ごとのメモと「質問に答えずに話す」が使えるようになりました',
			},
			{
				icon: 'notifications-outline',
				title: '通知でエージェントの返答を読み、許可・拒否や返信ができるようになりました',
			},
			{
				icon: 'bulb-outline',
				title: 'Claude Code が Advisor に相談している様子が、分かるようになりました',
			},
			{
				icon: 'git-network-outline',
				title: '会話の中で、呼んだサブエージェントの状態が分かるようになりました',
			},
			{
				icon: 'pulse-outline',
				title: 'システム使用率のグラフで、SSH の接続先のマシンも選べるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'images-outline',
				title: '送った画像を共有・写真に保存し、長押しでパスをコピーできるようになりました',
			},
			{
				icon: 'notifications-outline',
				title: '設定の「通知に内容を含める」で、通知に中身を出すかどうかを選べるようになりました',
			},
			{
				icon: 'bulb-outline',
				title: 'サブエージェントの画面の「アドバイザー」で、相談のモデルや返答を確かめられるようになりました',
			},
			{
				icon: 'images-outline',
				title: '送った画像を会話の先頭に札で並べ、押すと全画面で開けるようにしました',
				tone: 'green',
			},
			{
				icon: 'information-circle-outline',
				title: '送れなかったことの知らせを、エージェントの発言と分けて出すようにしました',
				tone: 'green',
			},
			{
				icon: 'lock-open-outline',
				title: 'Face ID のあとも、開いていた画面や入力途中の文字が残るようにしました',
				tone: 'green',
			},
			{
				icon: 'shield-checkmark-outline',
				title: 'ロック中に、確認のダイアログを操作できないようにしました',
				tone: 'green',
			},
			{
				icon: 'notifications-outline',
				title: '通知で、失敗を完了と分けて知らせるようにしました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.1',
		date: '2026-10-03',
		headline: '使用量を全 PC の合計で見られるようになりました',
		items: [
			{
				icon: 'stats-chart-outline',
				title: 'ホームと使用量の画面で、全 PC の合計を見られるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'apps-outline',
				title: 'ホーム画面のウィジェットで、全 PC の合計か特定の PC かを選べるようになりました',
			},
			{
				icon: 'stats-chart-outline',
				title: '使用量の画面で PC の行を押すと、その PC だけを見られるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'time-outline',
				title: '使用量の画面で「request timeout」を出にくくし、前回の値を残すようにしました',
				tone: 'green',
			},
			{
				icon: 'time-outline',
				title: '使用量の画面で、オフラインの PC は最後に取れた値を薄く出すようにしました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.12.0',
		date: '2026-10-02',
		headline: 'ブラウザの画面を作り直しました',
		items: [
			{
				icon: 'browsers-outline',
				title: 'ブラウザの戻る・進む・再読み込み・アドレス・ページ数・全画面を、上の 1 行にまとめました',
				tone: 'green',
			},
			{
				icon: 'expand-outline',
				title: 'ブラウザを全画面で見られるようになりました',
			},
			{
				icon: 'search-outline',
				title: 'ブラウザのアドレスに URL でない言葉を打つと、検索するようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'search-outline',
				title: 'ブラウザのアドレスの長押しで、題名と URL の表示を切り替えられるようになりました',
			},
			{
				icon: 'create-outline',
				title: 'ブラウザのページの入力欄をタップすると、キーボードが自動で開くようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'bookmark-outline',
				title: 'ブラウザのアドレスの下に、PC と同じブックマークバーが出るようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'bookmark-outline',
				title: 'ブラウザのアドレスの左端の印で、映像が届く経路が分かるようになりました',
			},
			{
				icon: 'git-branch-outline',
				title: 'ファイル一覧に Git の色が付くようになりました',
			},
			{
				icon: 'search-outline',
				title: '開いたファイルの中を、検索できるようになりました',
			},
			{
				icon: 'create-outline',
				title: 'メモの項目を長押しすると、完了・編集・コピー・削除を選べるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'git-compare-outline',
				title: '差分の画面で「表示・差分・Raw」を切り替えられるようになりました',
			},
			{
				icon: 'git-compare-outline',
				title: '差分の画面で、画像を変更前と並べて比べられるようになりました',
			},
			{
				icon: 'text-outline',
				title: '設定の「チャット UI」で、会話の文字サイズを変えられるようになりました',
			},
			{
				icon: 'eye-off-outline',
				title: '使わないモデルを、モデルを選ぶ画面から隠せるようになりました',
			},
			{
				icon: 'expand-outline',
				title: 'iPhone で端末を横に倒すと、ブラウザを横向きの全画面で見られるようになりました',
			},
			{
				icon: 'create-outline',
				title: 'メモの項目を消した後、お知らせの「元に戻す」で戻せるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'pulse-outline',
				title: '設定の「触覚フィードバック」で、操作の手応えをオフにできるようになりました',
			},
			{
				icon: 'browsers-outline',
				title: 'ブラウザのページの一覧には、今見ているスペースのページだけを並べるようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'search-outline',
				title: 'ブラウザの読み込み中に進み具合の線を出し、再読み込みのボタンで止められるようにしました',
				tone: 'green',
			},
			{
				icon: 'speedometer-outline',
				title: '大きなファイルや日本語の多いファイルを開くのと、会話やターミナルの受信を速くしました',
				tone: 'green',
			},
			{
				icon: 'folder-open-outline',
				title: 'ファイルのアイコンを、PC で選んでいるテーマとそろえました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'albums-outline',
				title: 'iPad でファイルを開いて戻ると、一覧と開いていたフォルダが戻るようにしました',
				tone: 'green',
			},
			{
				icon: 'git-network-outline',
				title: 'Codex の会話に、サブエージェントの結果とゴール・計画も出るようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'git-network-outline',
				title: '会話の途中で Codex のモデルを変える操作をなくしました',
				tone: 'green',
			},
			{
				icon: 'sparkles-outline',
				title: 'Claude Code と Codex の印を、PC と同じすっきりした形にそろえました',
				tone: 'green',
			},
			{
				icon: 'sparkles-outline',
				title: 'エージェントの一覧で、最新の発言の前の状態の点をなくしました',
				tone: 'green',
			},
			{
				icon: 'browsers-outline',
				title: 'ブラウザの上へ・下へのボタンと下のツールバーをなくし、映像を広く出すようにしました',
				tone: 'green',
			},
			{
				icon: 'pulse-outline',
				title: '承認や質問が届いたときは、手応えで知らせるようにしました',
				tone: 'green',
			},
			{
				icon: 'accessibility-outline',
				title: 'VoiceOver で、切り替えられないモデルの理由を読み上げるようにしました',
				tone: 'green',
			},
			{
				icon: 'pulse-outline',
				title: '操作の手応え（触覚）を、確定・選択・警告・失敗で変わるように作り直しました',
				tone: 'green',
			},
			{
				icon: 'git-network-outline',
				title: 'Codex の会話で、AGENTS.md が自分の発言に出る・動いているのに「待機中」と出るのを直しました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'checkmark-done-outline',
				title: 'エージェントに読まれた発言が、「送信予定」に残り続けることがあったのを直しました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'git-pull-request-outline',
				title: 'SSH で接続している先のソース管理が「読み込み中」のまま止まるのを直しました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
		],
	},
	{
		version: '0.11.2',
		date: '2026-10-02',
		items: [
			{
				icon: 'pulse-outline',
				title: 'Claude Code が出力を見張っている Monitor を、入力欄のモデル名の右で確かめられるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'git-branch-outline',
				title: 'サブエージェントの一覧に、バックグラウンドのコマンドのような中身の無い項目を並べないようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'git-branch-outline',
				title: 'サブエージェントの一覧で、動いているものを「完了」「中断」と出していたのを直しました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
		],
	},
	{
		version: '0.11.1',
		date: '2026-10-02',
		items: [
			{
				icon: 'funnel-outline',
				title: 'PC の画面の絞り込みで、エージェントだけ・ターミナルだけを出せるようになりました',
			},
			{
				icon: 'funnel-outline',
				title: 'PC の画面の状態の絞り込みに、ふつうのターミナルが混ざらないようにしました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.11.0',
		date: '2026-10-01',
		items: [
			{
				icon: 'create-outline',
				title: 'ブラウザの画面から、PC のページへ文字とキーを入力できるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
		],
	},
	{
		version: '0.10.1',
		date: '2026-09-29',
		headline: '画面を「PC → スペース → セッション」の順に作り直しました',
		items: [
			{
				icon: 'layers-outline',
				title: '画面を「PC → スペース → セッション」の順に押し進む形へ作り直しました',
				tone: 'green',
			},
			{
				icon: 'notifications-outline',
				title: '右上のベルに、質問の通知の件数が付くようになりました',
			},
			{
				icon: 'funnel-outline',
				title: 'PC の画面を並べ替え、状態やスペースで分けた段を畳めるようになりました',
			},
			{
				icon: 'tablet-landscape-outline',
				title: 'iPad で、左に PC のエージェント一覧、右にセッションを並べて使えるようになりました',
			},
			{
				icon: 'tablet-landscape-outline',
				title: 'iPad で、ソース管理・ファイル・メモを会話の右に並べて開けるようになりました',
			},
			{
				icon: 'keypad-outline',
				title: 'iPad の外付けキーボードで、タブやエージェントを移れるようになりました',
			},
			{
				icon: 'paper-plane-outline',
				title: '作業を終えたエージェントへの短い返信を、入力欄の上のチップから選べるようになりました',
			},
			{
				icon: 'checkmark-circle-outline',
				title: '許可のカードに、PC の画面と同じ番号付きの選択肢が並ぶようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'apps-outline',
				title: 'ホーム画面とロック画面にウィジェットを置けるようになりました',
				body: 'iOS 17 以上で使えます。',
			},
			{
				icon: 'color-palette-outline',
				title: 'ボタン・自分の発言・選択の印の色を、設定で変えられるようになりました',
			},
			{
				icon: 'cloud-upload-outline',
				title: 'ソース管理から、ファイルごとのステージとプッシュ・取り込み・フェッチができるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'cloud-upload-outline',
				title: 'ブランチのカードに、リモートとの差（↑先行・↓遅れ）が出るようになりました',
			},
			{
				icon: 'git-pull-request-outline',
				title: 'ソース管理の「プルリクエスト」で、PR と CI の状態を見てマージできるようになりました',
				body: 'PC に GitHub CLI（gh）が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'git-pull-request-outline',
				title: '失敗した CI のチェックを、ログを添えてエージェントに直してもらえるようになりました',
			},
			{
				icon: 'construct-outline',
				title: 'コミットが失敗したとき、理由の要約と「AI に直してもらう」が出るようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'checkmark-done-outline',
				title: '確認済みのファイルだけを、まとめてステージできるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'git-compare-outline',
				title: '確認の印を PC に残し、iPhone と iPad で同じ進み具合を見られるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'chatbox-ellipses-outline',
				title: '差分の行を長押ししてメモを書き、まとめてエージェントに送れるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'link-outline',
				title: 'ターミナルのファイルパスや URL を、押して開けるようになりました',
			},
			{
				icon: 'copy-outline',
				title: 'ターミナルの文字を長押しで選んで、コピーできるようになりました',
			},
			{
				icon: 'time-outline',
				title: '長い会話を、最初の依頼までさかのぼれるようになりました',
			},
			{
				icon: 'time-outline',
				title: '終わった会話にも、「過去の会話」から続きを頼めるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'pulse-outline',
				title: '設定の「接続の記録」で、つながらない理由を調べられるようになりました',
			},
			{
				icon: 'git-compare-outline',
				title: '差分から、実際のファイルを開けるようになりました',
			},
			{
				icon: 'list-outline',
				title: 'ホームのクイック操作から、ペアリングと新しいスペースの作成へ進めるようになりました',
			},
			{
				icon: 'funnel-outline',
				title: 'PC の画面の右下の＋でエージェントを起動し、長押しで操作を選べるようになりました',
			},
			{
				icon: 'tablet-landscape-outline',
				title: 'iPad で、左の列の幅を変えたり隠したりできるようになりました',
			},
			{
				icon: 'chatbubbles-outline',
				title: '承認のカードで、長いコマンドの全文を開いて確かめられるようになりました',
			},
			{
				icon: 'chatbubbles-outline',
				title: 'ほかのエージェントの要対応へ、画面の上から続けて移れるようになりました',
			},
			{
				icon: 'paper-plane-outline',
				title: '設定の「クイック返信」で、返信の候補を足したり並べ替えたりできるようになりました',
			},
			{
				icon: 'apps-outline',
				title: 'ウィジェットから、未確認を確認済みにできるようになりました',
			},
			{
				icon: 'apps-outline',
				title: '設定 → ウィジェットで、ウィジェットとロック画面に出す中身を選べるようになりました',
			},
			{
				icon: 'cloud-upload-outline',
				title: 'ソース管理から、ブランチを公開できるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'chatbox-ellipses-outline',
				title: '送ったメモや古くなった差分のメモを、まとめて消せるようになりました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'pulse-outline',
				title: '「接続の記録」の診断を、「報告をコピー」で写せるようになりました',
			},
			{
				icon: 'notifications-outline',
				title: '通知と音声の設定を 1 画面にまとめました',
				tone: 'green',
			},
			{
				icon: 'list-outline',
				title: 'ホームに要対応・実行中・今日のコスト、PC のカード、最後のセッションの「再開」をまとめました',
				tone: 'green',
			},
			{
				icon: 'chatbubbles-outline',
				title: '承認と質問への回答を、入力欄のすぐ上の 1 か所でできるようにしました',
				tone: 'green',
			},
			{
				icon: 'warning-outline',
				title: '削除や強制 push のような危険な操作の承認に、赤い札を付けるようにしました',
				tone: 'green',
			},
			{
				icon: 'git-compare-outline',
				title: '確認済みのファイルが後から書き換えられたら、「確認後に変更あり」と出すようにしました',
				tone: 'green',
			},
			{
				icon: 'language-outline',
				title: 'ターミナルのライブ入力を最初からオンにし、日本語と絵文字も打てるようにしました',
				tone: 'green',
			},
			{
				icon: 'language-outline',
				title: 'つながっていない間にターミナルへ打った文字は、送らずに捨てて知らせるようにしました',
				tone: 'green',
			},
			{
				icon: 'terminal-outline',
				title: 'ターミナルのキー行に Ctrl・⇧Tab・^D を足し、Enter なしで入力できるようにしました',
				tone: 'green',
			},
			{
				icon: 'terminal-outline',
				title: 'ターミナルのキー行の矢印と⌫ を、押し続けると繰り返すようにしました',
				tone: 'green',
			},
			{
				icon: 'resize-outline',
				title: 'PC でターミナルの幅を戻されたとき、「再び合わせる」を出すようにしました',
				tone: 'green',
			},
			{
				icon: 'arrow-up-circle-outline',
				title: 'つながらないときに、理由と次にやることを出すようにしました',
				tone: 'green',
			},
			{
				icon: 'swap-horizontal-outline',
				title: 'ほかのアプリからすぐ戻ったときは、接続し直さずに使えるようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'swap-horizontal-outline',
				title: '回線が戻ったときや Wi-Fi とモバイル回線が切り替わったときに、すぐ繋ぎ直すようにしました',
				tone: 'green',
			},
			{
				icon: 'document-text-outline',
				title: '起動した直後から、前回の PC の一覧を出すようにしました',
				tone: 'green',
			},
			{
				icon: 'notifications-off-outline',
				title: 'PC で確認した通知を、通知センターとロック画面からも消すようにしました',
				tone: 'green',
			},
			{
				icon: 'notifications-off-outline',
				title: '同じエージェントの完了通知を、最新の 1 件にまとめるようにしました',
				tone: 'green',
			},
			{
				icon: 'server-outline',
				title: '使用量を 1 つの画面にまとめ、SSH 先の Claude の使用量も見られるようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'contrast-outline',
				title: '色づかいを落ち着かせ、状態の呼び名と色をどの画面でもそろえました',
				tone: 'green',
			},
			{
				icon: 'contrast-outline',
				title: '文字の大きさと角の丸みをそろえ、小さすぎた文字やボタンを見やすくしました',
				tone: 'green',
			},
			{
				icon: 'git-branch-outline',
				title: '未追跡のファイルを追加と区別し、パンくずから途中の階層へ戻れるようにしました',
				tone: 'green',
			},
			{
				icon: 'document-text-outline',
				title: 'スペースのメモで、PC やエージェントが書き足した分を消さずに保存するようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'speedometer-outline',
				title: '返事やターミナルの出力が流れている間の、もたつき・電池の減り・発熱を抑えました',
				tone: 'green',
			},
			{
				icon: 'speedometer-outline',
				title: 'ターミナルの表示が止まったときは、自動で読み直すようにしました',
				tone: 'green',
			},
			{
				icon: 'keypad-outline',
				title: '設定から開く画面の下の余白と、画面の端で見切れていたメニューをそろえました',
				tone: 'green',
			},
			{
				icon: 'hand-left-outline',
				title: 'スワイプのボタンを出したまま一覧をスクロールすると、行が閉じるようにしました',
				tone: 'green',
			},
			{
				icon: 'tablet-landscape-outline',
				title: 'iPad のウィンドウで、左上の操作ボタンと戻るボタンが重ならないようにしました',
				tone: 'green',
			},
			{
				icon: 'sparkles-outline',
				title: 'effort のない Haiku では、effort を出さないようにしました',
				tone: 'green',
			},
			{
				icon: 'funnel-outline',
				title: 'PC の画面の並び順や畳んだ段を、アプリを閉じても覚えるようにしました',
				tone: 'green',
			},
			{
				icon: 'chatbubbles-outline',
				title: '質問への回答を「回答する」で送り、届いたかどうか分かるようにしました',
				tone: 'green',
			},
			{
				icon: 'pulse-outline',
				title: 'ロック画面と Dynamic Island を押すと、そのセッションを直接開くようにしました',
				tone: 'green',
			},
			{
				icon: 'pulse-outline',
				title: 'アプリが止まって古くなったロック画面の表示は、灰色にするようにしました',
				tone: 'green',
			},
			{
				icon: 'color-palette-outline',
				title: '色の設定で、読みにくい色や状態の色に近い色を選ぶと注意を出すようにしました',
				tone: 'green',
			},
			{
				icon: 'git-pull-request-outline',
				title: 'マージキューに入れたときは、「マージキューに入れました」と出すようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'link-outline',
				title: 'ターミナルの localhost のような URL は、PC の内蔵ブラウザで開いて映すようにしました',
				tone: 'green',
			},
			{
				icon: 'terminal-outline',
				title: 'ターミナルの文字を設定より小さくせず、はみ出す分は横にスクロールできるようにしました',
				tone: 'green',
			},
			{
				icon: 'time-outline',
				title: 'PC に届かない間に送った続きの依頼を、預かって後で届けるようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'arrow-up-circle-outline',
				title: 'PC とアプリの版が少し違うだけなら、そのままつながるようにしました',
				tone: 'green',
			},
			{
				icon: 'arrow-up-circle-outline',
				title: '起動直後は「接続されていません」ではなく、準備中と出すようにしました',
				tone: 'green',
			},
			{
				icon: 'contrast-outline',
				title: '水色のボタンの文字・差分の行番号・待機中の点・iPad の件数バッジを読みやすくしました',
				tone: 'green',
			},
			{
				icon: 'git-compare-outline',
				title: '差分からファイルを読み込めないときは、理由を出すようにしました',
				tone: 'green',
			},
			{
				icon: 'document-text-outline',
				title: 'スペースのメモが PC で書き換えられていたら、書きかけをクリップボードに写すようにしました',
				body: 'PC の Para Code の更新が要ります。',
				tone: 'yellow',
			},
			{
				icon: 'speedometer-outline',
				title: 'とても長いコマンドの出力は途中を省いて出し、コピーでは全文を写すようにしました',
				tone: 'green',
			},
			{
				icon: 'stats-chart-outline',
				title: 'GitHub の Rate Limit の一覧で、再ログインが要るときだけそう伝えるようにしました',
				tone: 'green',
			},
			{
				icon: 'sparkles-outline',
				title: 'モデルの候補に、PC の Claude Code から取った一覧を使うようにしました',
				tone: 'green',
			},
			{
				icon: 'pulse-outline',
				title: 'ロック画面と Dynamic Island の表示を、状況に合わせて切り替わる形に作り直しました',
				tone: 'green',
			},
			{
				icon: 'accessibility-outline',
				title: 'VoiceOver でボタンとして読まれなかった操作と、小さすぎた＋ボタンを直しました',
				tone: 'green',
			},
			{
				icon: 'open-outline',
				title: 'アプリを閉じている間に届いた通知を押しても、セッションが開かなかったのを直しました',
				tone: 'green',
			},
			{
				icon: 'speedometer-outline',
				title: '画面を移ったとき、上のバーのボタンが出ないことがあったのを直しました',
				tone: 'green',
			},
			{
				icon: 'stats-chart-outline',
				title: 'GitHub の残量が 100% のまま動かない・正常なアカウントが「エラー」と出るのを直しました',
				tone: 'green',
			},
			{
				icon: 'keypad-outline',
				title: '入力欄やターミナルの最後の行が、キーボードやキーの行に隠れていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'chatbubbles-outline',
				title: '触っていないのに会話が上下へ飛んだり、最後の返答の途中で止まったりするのを直しました',
				tone: 'green',
			},
			{
				icon: 'clipboard-outline',
				title: 'ターミナルの「貼付」と、会話の入力・結果の「コピー」が効かなかったのを直しました',
				tone: 'green',
			},
			{
				icon: 'hand-left-outline',
				title: 'スワイプを横取りされたとき、アーカイブや戻すが勝手に実行されるのを直しました',
				tone: 'green',
			},
			{
				icon: 'git-compare-outline',
				title: 'ファイルや差分の中のリンクを開くと、戻れなくなることがあったのを直しました',
				tone: 'green',
			},
			{
				icon: 'git-compare-outline',
				title: '差分の空の行や区切りの行、白く光る表示ほか、表示のずれを 4 か所直しました',
				tone: 'green',
			},
			{
				icon: 'browsers-outline',
				title: 'iPad の Split View で幅を変えると、画面が作り直されていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'sparkles-outline',
				title: 'Claude Code のモデルの切り替えで、Opus 5.5 が「Opus 5」と出ていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'terminal-outline',
				title: 'PC 版の「空いていれば実行・忙しければ新規」のプリセットが一覧から消えるのを直しました',
				tone: 'green',
			},
			{
				icon: 'stats-chart-outline',
				title: 'GitHub の「直近5分の消費量」が正しく出ていなかったのを直しました',
				tone: 'green',
			},
			{
				icon: 'checkmark-circle-outline',
				title: 'Claude の許可に答えたとき、PC の入力欄に余計な改行が残るのを直しました',
				tone: 'green',
			},
			{
				icon: 'keypad-outline',
				title: 'ソース管理のコミット欄が、キーボードの下に沈んでいたのを直しました',
				tone: 'green',
			},
			{
				icon: 'keypad-outline',
				title: '回転や Split View で幅が変わると、ターミナルの高さがずれていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'hand-left-outline',
				title: '長押しのメニューを開いている間に、一覧の行が動いていたのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.9.0',
		date: '2026-08-19',
		headline: 'アプリに戻ったときの追いつきが速くなりました',
		items: [
			{
				icon: 'flash-outline',
				title: 'アプリに戻ってから、会話の続きが出るまでを速くしました',
				tone: 'green',
			},
			{
				icon: 'expand-outline',
				title: 'iPad で、差分も画面いっぱいに広げられるようになりました',
			},
			{
				icon: 'laptop-outline',
				title: 'RTK・Ccusage・Rate Limit を、PC の接続先ごとに見られるようになりました',
			},
			{
				icon: 'speedometer-outline',
				title: 'エージェントが動いている間の一覧を軽くしました',
				tone: 'green',
			},
			{
				icon: 'cellular-outline',
				title: 'PC から届く状態のデータを圧縮し、通信量を減らしました',
				tone: 'green',
			},
			{
				icon: 'shield-checkmark-outline',
				title: '古い質問や許可のカードに、そのまま回答できてしまうことがあったのを直しました',
				tone: 'green',
			},
			{
				icon: 'notifications-outline',
				title: '同じ質問の通知が、何度も鳴っていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'document-text-outline',
				title: '大きめの HTML ファイルが、途中で切れていたのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.8.0',
		date: '2026-08-09',
		headline: '上のバーが画面をまたいで1つになりました',
		items: [
			{
				icon: 'contract-outline',
				title: '画面を移るとき、上のバーが空になっていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'flash-outline',
				title: 'PC のコマンドプリセットをアプリから実行し、一覧に出すものを端末ごとに選べるようになりました',
			},
			{
				icon: 'flash-outline',
				title: 'RTK が削ったトークン量を、アプリから見られるようになりました',
			},
			{
				icon: 'contract-outline',
				title: 'iPad で、左の一覧を細く畳めるようになりました',
			},
			{
				icon: 'expand-outline',
				title: 'iPad で、ファイルとブラウザを画面いっぱいに広げられるようになりました',
			},
			{
				icon: 'swap-vertical-outline',
				title: 'Claude Code のようにマウス操作を受け付ける画面を、縦スワイプでスクロールできるようになりました',
			},
			{
				icon: 'albums-outline',
				title: '設定やブラウザでも、上のバーが形を変えて入れ替わるようにしました',
				tone: 'green',
			},
			{
				icon: 'speedometer-outline',
				title: 'ターミナルを開いているときの動作を軽くしました',
				tone: 'green',
			},
			{
				icon: 'pricetag-outline',
				title: '同じ名前のコマンドプリセットを、名前の横の手掛かりで見分けられるようにしました',
				tone: 'green',
			},
			{
				icon: 'pricetag-outline',
				title: 'この版では、コマンドプリセットの実行前の確認を一度出し直し、隠したものを表示に戻しました',
				body: '隠したいものは一覧から選び直してください。',
				tone: 'yellow',
			},
			{
				icon: 'notifications-outline',
				title: '通知の見出しを、待っているワークツリーの名前にしました',
				tone: 'green',
			},
			{
				icon: 'terminal-outline',
				title: 'ターミナルの切り替えを、上の名前から選ぶ形にしました',
				tone: 'green',
			},
			{
				icon: 'terminal-outline',
				title: 'ほかのターミナルに応答待ちがあると、名前の右上に赤い点を出すようにしました',
				tone: 'green',
			},
			{
				icon: 'search-outline',
				title: 'ファイル検索の欄をスクロールしても消えないようにし、一致した箇所を水色で示すようにしました',
				tone: 'green',
			},
			{
				icon: 'notifications-outline',
				title: 'お知らせが、画面を押し下げないようにしました',
				tone: 'green',
			},
			{
				icon: 'notifications-outline',
				title: '「再接続中」「オフライン」は、スペース名の下に出すようにしました',
				tone: 'green',
			},
			{
				icon: 'create-outline',
				title: 'ターミナル名の変更を、iOS 標準の入力にそろえました',
				tone: 'green',
			},
			{
				icon: 'options-outline',
				title: 'エージェント情報の閉じるボタンと下の 4 つのボタンを、ほかの画面とそろえました',
				tone: 'green',
			},
			{
				icon: 'options-outline',
				title: 'エージェント情報で、名前を押してそのまま変えられるようにしました',
				tone: 'green',
			},
			{
				icon: 'flash-outline',
				title: 'コマンドプリセットを初めて実行するときは、走るコマンドを見せて確かめるようにしました',
				tone: 'green',
			},
			{
				icon: 'contract-outline',
				title: '上のバーの中身が固まる・絞り込みのボタンが枠だけになる・1 行目が潜るのを直しました',
				tone: 'green',
			},
			{
				icon: 'lock-open-outline',
				title: 'アプリを閉じている間の通知が、「新しい通知があります」のままになるのを直しました',
				tone: 'green',
			},
			{
				icon: 'search-outline',
				title: 'ファイル検索で、1 文字打つとキーボードが閉じていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'options-outline',
				title: 'エージェント情報で、状態と枝名の札の高さのずれを直しました',
				tone: 'green',
			},
			{
				icon: 'resize-outline',
				title: 'スペース一覧の＋と、ソース管理の「最近のコミット」の余白のずれを直しました',
				tone: 'green',
			},
			{
				icon: 'lock-open-outline',
				title: 'アプリを閉じている間の通知を押しても、目的の画面へ飛べなかったのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.7.0',
		date: '2026-08-08',
		headline: '触ったところが iOS らしく動くようになりました',
		items: [
			{
				icon: 'add-circle-outline',
				title: '＋のメニューを、iOS 標準のメニューにしました',
				tone: 'green',
			},
			{
				icon: 'chevron-down-circle-outline',
				title: 'シートを、下へ引いて閉じられるようになりました',
			},
			{
				icon: 'notifications-outline',
				title: 'お知らせを上へ払って、待たずに消せるようになりました',
			},
			{
				icon: 'add-circle-outline',
				title: 'エージェントの起動を、「エージェントを起動」の中にまとめました',
				tone: 'green',
			},
			{
				icon: 'phone-portrait-outline',
				title: 'シートを、画面の端から浮いた形にしました',
				tone: 'green',
			},
			{
				icon: 'notifications-outline',
				title: 'お知らせを、画面上部の 1 か所にまとめました',
				tone: 'green',
			},
			{
				icon: 'document-text-outline',
				title: 'メモがどのスペースのものかを出し、その場で切り替えられるようにしました',
				tone: 'green',
			},
			{
				icon: 'color-palette-outline',
				title: '暗い画面で、数字のカード・CPU とメモリの行・並び替えの選択肢の色を整えました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.6.0',
		date: '2026-08-07',
		headline: 'ターミナルの文字が読める大きさになりました',
		items: [
			{
				icon: 'terminal-outline',
				title: 'ターミナルの文字サイズを、選べるようになりました',
			},
			{
				icon: 'swap-vertical-outline',
				title: 'ターミナルを指でなぞって、前の表示へさかのぼれるようになりました',
			},
			{
				icon: 'phone-portrait-outline',
				title: 'PC のターミナルを、この画面の幅に合わせられるようになりました',
				body: '設定からオンにします（ベータ）。',
			},
			{
				icon: 'add-circle-outline',
				title: '右上の「＋」から、起動・作成・メモ・並び替えのメニューを開けるようになりました',
			},
			{
				icon: 'hand-left-outline',
				title: '一覧を左へスワイプして、確認済み・アーカイブ・削除を選べるようになりました',
			},
			{
				icon: 'chevron-down-outline',
				title: '下へスクロールすると、下のバーを小さくするようにしました',
				tone: 'green',
			},
			{
				icon: 'layers-outline',
				title: '上のバーを浮かせ、内容がその下を流れるようにしました',
				tone: 'green',
			},
			{
				icon: 'hand-left-outline',
				title: 'ソース管理とファイルでも、右へスワイプでスペース一覧を開けるようにしました',
				tone: 'green',
			},
			{
				icon: 'apps-outline',
				title: 'ホーム右上のボタンを 1 つのまとまりにし、当たり判定を広げました',
				tone: 'green',
			},
			{
				icon: 'funnel-outline',
				title: '一覧の上の並び替えのバーをなくし、本文を上から始めるようにしました',
				tone: 'green',
			},
			{
				icon: 'funnel-outline',
				title: '絞り込みのボタンを、スクロールしても上に留まるようにしました',
				tone: 'green',
			},
			{
				icon: 'chevron-forward-outline',
				title: '設定の中の項目を、横から開くようにしました',
				tone: 'green',
			},
			{
				icon: 'search-outline',
				title: 'ファイルの検索欄を、使うときだけ出すようにしました',
				tone: 'green',
			},
			{
				icon: 'git-commit-outline',
				title: 'ソース管理の見た目を整え、右上から読み直せるようにしました',
				tone: 'green',
			},
			{
				icon: 'trash-outline',
				title: '通知をすべて消すときに、一度確認するようにしました',
				tone: 'green',
			},
			{
				icon: 'sparkles-outline',
				title: 'スペース一覧と設定の中の部品を、すりガラスの見た目にそろえました',
				tone: 'green',
			},
			{
				icon: 'folder-outline',
				title: 'ファイルの一覧と検索結果を、ほかの画面と同じ札にそろえました',
				tone: 'green',
			},
			{
				icon: 'tablet-landscape-outline',
				title: 'iPad でも右上に、開いているスペースの名前を出すようにしました',
				tone: 'green',
			},
			{
				icon: 'layers-outline',
				title: '上のバーに、画面の名前を出すのをやめました',
				tone: 'green',
			},
			{
				icon: 'chevron-forward-outline',
				title: '設定の右上の×で、どこからでも設定を閉じられるようにしました',
				tone: 'green',
			},
			{
				icon: 'phone-portrait-outline',
				title: 'キーボードを開くと、ターミナルの表示が崩れていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'notifications-off-outline',
				title: '応答待ちの件数が、二重に出ていたのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.5.1',
		date: '2026-08-06',
		items: [
			{
				icon: 'link-outline',
				title: 'つながっているのに、操作が何も効かなくなるのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.5.0',
		date: '2026-08-06',
		headline: '通知の中身が戻り、画面ごとの見方が増えました',
		items: [
			{
				icon: 'chatbox-ellipses-outline',
				title: '通知の中身が「新しい通知があります」だけになるのを直しました',
				tone: 'green',
			},
			{
				icon: 'desktop-outline',
				title: '設定の PC をタップすると、その PC 専用の画面が開くようになりました',
			},
			{
				icon: 'battery-charging-outline',
				title: '設定の PC 一覧に、それぞれのバッテリー残量が出るようになりました',
			},
			{
				icon: 'filter-outline',
				title: 'Ccusage を、期間とエージェントで絞り込めるようになりました',
			},
			{
				icon: 'filter-outline',
				title: 'Ccusage で、「プロジェクト別」の内訳を見られるようになりました',
			},
			{
				icon: 'pulse-outline',
				title: 'GitHub API で、失敗や遅い呼び出しが分かるようになりました',
			},
			{
				icon: 'pie-chart-outline',
				title: 'システムの「ボリューム」で、スペースごとの容量を見られるようになりました',
			},
			{
				icon: 'filter-outline',
				title: 'Ccusage に、いつ取得した数字かが出るようになりました',
			},
			{
				icon: 'pie-chart-outline',
				title: 'システムの「ボリューム」で、worktree を持つスペースの内訳を開けるようになりました',
			},
			{
				icon: 'notifications-outline',
				title: '通知を押すと、その PC の該当の会話が開くようにしました',
				tone: 'green',
			},
			{
				icon: 'battery-half-outline',
				title: 'バッテリーの色を残量だけで決め、ロック画面の表示も同じ色にそろえました',
				tone: 'green',
			},
			{
				icon: 'speedometer-outline',
				title: 'Rate Limit から「最大使用率」「次のリセット」をなくしました',
				tone: 'green',
			},
			{
				icon: 'hardware-chip-outline',
				title: 'システムの内訳を、CPU 順とメモリ順の 2 つの一覧に分けました',
				tone: 'green',
			},
			{
				icon: 'refresh-outline',
				title: '使用量の画面を待たされにくくし、右上から手動で更新できるようにしました',
				tone: 'green',
			},
			{
				icon: 'home-outline',
				title: 'スペースを切り替えると、ホームに戻るようにしました',
				tone: 'green',
			},
			{
				icon: 'document-text-outline',
				title: 'ソース管理で .md や .html の変更を開くと、まず読める形で出すようにしました',
				tone: 'green',
			},
			{
				icon: 'desktop-outline',
				title: '使用量の見出しに、いま見ている PC の名前を出すようにしました',
				tone: 'green',
			},
			{
				icon: 'browsers-outline',
				title: 'PC の欄で、切り替えの矢印が設定ボタンに重なるのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.4.0',
		date: '2026-08-06',
		headline: '複数のPCを行き来できます',
		items: [
			{
				icon: 'desktop-outline',
				title: '複数の PC とペアリングしたまま、見る PC を切り替えられるようになりました',
			},
			{
				icon: 'notifications-outline',
				title: '見ていない PC で質問が出ていることも、分かるようになりました',
			},
			{
				icon: 'pricetag-outline',
				title: 'PC に名前が付き、この端末だけの呼び名にも変えられるようになりました',
			},
			{
				icon: 'options-outline',
				title: '設定から PC の追加・名前の変更・解除ができるようになりました',
			},
			{
				icon: 'options-outline',
				title: '見ていない PC との接続を保つか、ほかの PC の通知を出すかを選べるようになりました',
			},
			{
				icon: 'notifications-outline',
				title: 'ほかの PC の通知を押すと、その PC へ切り替えて会話を開けるようになりました',
			},
		],
	},
	{
		version: '0.3.0',
		date: '2026-08-05',
		headline: 'iPadに対応しました',
		items: [
			{
				icon: 'tablet-landscape-outline',
				title: 'iPad で、スペースの一覧を出したままエージェントと話せるようになりました',
			},
			{
				icon: 'tablet-landscape-outline',
				title: 'iPad の横向きでも、使えるようになりました',
			},
			{
				icon: 'funnel-outline',
				title: 'ホームの一覧を並べ替えたり、状態で絞り込んだりできるようになりました',
			},
			{
				icon: 'apps-outline',
				title: 'iPad では、切り替えのボタンを左下にまとめました',
				tone: 'green',
			},
			{
				icon: 'text-outline',
				title: 'iPad では、文章を読みやすい幅に収めるようにしました',
				tone: 'green',
			},
			{
				icon: 'documents-outline',
				title: 'iPad では、ファイルや差分を開いてもスペース一覧を残すようにしました',
				tone: 'green',
			},
			{
				icon: 'shuffle-outline',
				title: 'ホームの既定の並びを、スペースごとにまとめる形に変えました',
				body: '元に近い並びは「並び替え」から選べます。',
				tone: 'green',
			},
			{
				icon: 'text-outline',
				title: 'iPad では、ターミナルの文字を広い画面いっぱいまで大きくするようにしました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.2.5',
		date: '2026-08-04',
		headline: 'PCのAivis音声を、このiPhoneでも聞けます',
		items: [
			{
				icon: 'volume-high-outline',
				title: 'PC で流れる Aivis の音声を、iPhone でも聞けるようになりました',
			},
			{
				icon: 'information-circle-outline',
				title: 'エージェントの画面から、名前の変更とメモの書き込みができるようになりました',
			},
			{
				icon: 'information-circle-outline',
				title: 'エージェントの画面から、ピン留め・アーカイブ・削除もできるようになりました',
			},
			{
				icon: 'musical-notes-outline',
				title: '音声を聞いている間、ロック画面にアプリのアイコンを出すようにしました',
				tone: 'green',
			},
			{
				icon: 'mic-off-outline',
				title: '音声が受話口から小さく鳴る・マイク使用中の表示が出るのを直しました',
				tone: 'green',
			},
			{
				icon: 'mic-off-outline',
				title: '音声を始めても、「再接続しています」から進まないことがあったのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.2.4',
		date: '2026-07-30',
		items: [
			{
				icon: 'logo-github',
				title: '設定から、GitHub のレート枠を確認できるようになりました',
			},
			{
				icon: 'hardware-chip-outline',
				title: 'PC の CPU・メモリ・ディスクの空きが、見えるようになりました',
			},
			{
				icon: 'pie-chart-outline',
				title: '何が PC のリソースを使っているか、調べられるようになりました',
			},
			{
				icon: 'moon-outline',
				title: 'PC の前にいる間は、スマホを鳴らさないようにしました',
				body: '設定で戻せます。',
				tone: 'green',
			},
			{
				icon: 'chatbubbles-outline',
				title: '見ているエージェントの画面には、同じ内容のバナーを重ねないようにしました',
				tone: 'green',
			},
			{
				icon: 'archive-outline',
				title: 'オフラインの間に届いた通知を、通知一覧に並べるようにしました',
				tone: 'green',
			},
			{
				icon: 'trash-outline',
				title: '通知一覧をまとめて消すと、ほかの端末の一覧からも消えるようにしました',
				tone: 'green',
			},
			{
				icon: 'link-outline',
				title: 'ペアリング直後や解除したときに、アプリが閉じていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'list-outline',
				title: '複数の質問への回答が、ずれて届いていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'create-outline',
				title: '自由入力欄に触れると、選んだ回答が消えていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'notifications-outline',
				title: 'ほかのアプリを使っている間に、通知が届かなかったのを直しました',
				tone: 'green',
			},
			{
				icon: 'trash-outline',
				title: '通知一覧をまとめて消しても、あとで戻っていたのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.2.3',
		date: '2026-07-29',
		items: [
			{
				icon: 'hand-left-outline',
				title: '応答の途中で上へスクロールすると、引き戻されていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'lock-open-outline',
				title: '画面を消したまま通知で起こされたとき、繋がらなかったのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.2.2',
		date: '2026-07-28',
		items: [
			{
				icon: 'image-outline',
				title: 'やり取りの中の画像を、その場で見られるようになりました',
			},
			{
				icon: 'add-circle-outline',
				title: 'メモの項目を、一覧の下からその場で足せるようになりました',
			},
			{
				icon: 'checkbox-outline',
				title: 'メモの編集で、行をチェック・見出し・箇条書きに変えられるようになりました',
			},
			{
				icon: 'people-outline',
				title: 'SubAgent 一覧を、いま動いているものと直近の履歴だけにしました',
				tone: 'green',
			},
			{
				icon: 'pricetag-outline',
				title: 'SubAgent の名前と依頼内容を、出すようにしました',
				tone: 'green',
			},
			{
				icon: 'layers-outline',
				title: '質問しているエージェントを、全部ホームに並べるようにしました',
				tone: 'green',
			},
			{
				icon: 'remove-outline',
				title: 'ホーム一覧の赤い縦線をなくしました',
				tone: 'green',
			},
			{
				icon: 'help-circle-outline',
				title: '終わったエージェントが、「状態不明」と出ていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'list-outline',
				title: 'SubAgent の詳細で、ツール履歴がアイコンだけになっていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'chevron-down-circle-outline',
				title: 'エージェントを開いたとき、履歴が上から流れ落ちていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'language-outline',
				title: 'メモの入力中に、日本語の変換が勝手に確定されていたのを直しました',
				tone: 'green',
			},
			{
				icon: 'swap-horizontal-outline',
				title: 'ホーム一覧の左スワイプが、効かなかったのを直しました',
				tone: 'green',
			},
			{
				icon: 'paper-plane-outline',
				title: '送信予定の一覧が、最後まで読めなかったのを直しました',
				tone: 'green',
			},
			{
				icon: 'swap-horizontal-outline',
				title: 'ホーム一覧の右スワイプで、ワークスペースが開かなかったのを直しました',
				tone: 'green',
			},
		],
	},
	{
		version: '0.2.1',
		date: '2026-07-28',
		items: [
			{
				icon: 'paper-plane-outline',
				title: '作業中に送ったメッセージを、「送信予定」として見られるようになりました',
			},
			{
				icon: 'file-tray-full-outline',
				title: '終わったエージェントを、ホームからアーカイブで片付けられるようになりました',
			},
			{
				icon: 'pin',
				title: 'PC でピン留めしたスペースを、ドロワーに残せるようになりました',
			},
			{
				icon: 'file-tray-full-outline',
				title: 'アーカイブしたエージェントを、ヘッダーの箱から見返して戻せるようになりました',
			},
			{
				icon: 'reader-outline',
				title: 'メモと新しいエージェントを、押したところから広がる全画面で開くようにしました',
				tone: 'green',
			},
			{
				icon: 'create-outline',
				title: 'メモの保存とキャンセルを、画面の上部へ移しました',
				tone: 'green',
			},
			{
				icon: 'hand-left-outline',
				title: '一覧の長押しメニューを、早く開くようにしました',
				tone: 'green',
			},
			{
				icon: 'file-tray-full-outline',
				title: 'アーカイブしたエージェントは、質問や応答待ちになるとホームへ戻すようにしました',
				tone: 'green',
			},
			{
				icon: 'help-circle-outline',
				title: '複数ステップの質問で、答えがずれて PC に入っていたのを直しました',
				tone: 'green',
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
				title: '思考とツール実行を、1 件ずつ開けるようになりました',
			},
			{
				icon: 'construct-outline',
				title: 'ツールごとに、見やすい形で出すようにしました',
				tone: 'green',
			},
			{
				icon: 'swap-horizontal-outline',
				title: '表とコードを、横スクロールで見られるようにしました',
				tone: 'green',
			},
			{
				icon: 'people-outline',
				title: 'SubAgent の詳細も、エージェントの画面と同じ表示にそろえました',
				tone: 'green',
			},
			{
				icon: 'list-outline',
				title: '思考やツールの中身が、数行で切られていたのを直しました',
				tone: 'green',
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
