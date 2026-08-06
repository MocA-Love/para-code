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
		version: '0.5.0',
		date: '2026-08-06',
		headline: '通知の中身が戻り、画面ごとの見方が増えました',
		items: [
			{
				icon: 'chatbox-ellipses-outline',
				title: '通知の中身が「新しい通知があります」だけになる問題を直しました',
				body: '「見ていないPCとの接続を保つ」をオフにしていると、そのPCからの通知が中身のない文面で届いていました。どの設定でも、これまで通り質問や作業完了の内容が読めます。タップしたときにそのPCの該当の会話が開くようにもなります。',
				tone: 'green',
			},
			{
				icon: 'browsers-outline',
				title: 'PCの欄で、切り替えの矢印が設定ボタンに重なる問題を直しました',
				body: '2台以上ペアリングしていると「他N台」の表示が入るぶん幅が足りず、右端の歯車と重なって見えていました。',
			},
			{
				icon: 'battery-half-outline',
				title: 'バッテリーの色を、残量だけで分かるようにしました',
				body: '10%以下は赤、少なめなら黄色、十分あれば緑です。充電中はこれまで色が変わっていましたが、これからは稲妻の印だけで示します（充電中は80%を超えると緑になります）。ロック画面の表示も同じ色に揃えました。',
				tone: 'green',
			},
			{
				icon: 'desktop-outline',
				title: '設定のPCをタップすると、そのPC専用の画面が開きます',
				body: '使用量への入口と、名前の変更・ペアリング解除をここにまとめました。一覧の行に小さなアイコンが並ばなくなったので、開くつもりで消してしまうことがありません。使用量の見出しには、いま見ているPCの名前が出ます。',
				tone: 'purple',
			},
			{
				icon: 'battery-charging-outline',
				title: '設定のPC一覧に、それぞれのバッテリー残量が出ます',
				body: '接続中のノートPCだけに出ます（切れている相手の残量は古い値なので出しません）。',
			},
			{
				icon: 'filter-outline',
				title: 'Ccusageを、期間とエージェントで絞り込めるようになりました',
				body: '7日・30日・90日から選べます。Claude / Codex などエージェント別に見ることもでき、新しく「プロジェクト別」の内訳が増えました。',
			},
			{
				icon: 'speedometer-outline',
				title: 'Rate Limitから「最大使用率」「次のリセット」をなくしました',
				body: 'まとめた数字より、アカウントごとの枠がそのまま並んでいるほうが分かりやすいためです。5時間・7日・モデル別の枠は、そのアカウントが持っているものだけが出ます。',
			},
			{
				icon: 'pulse-outline',
				title: 'GitHub APIで、失敗や遅い呼び出しが分かるようになりました',
				body: '呼び出し元ごとに、失敗した件数・レート制限に当たった件数・かかった時間が出ます。問題が無いときは時間だけの静かな表示です。',
			},
			{
				icon: 'hardware-chip-outline',
				title: 'システムの内訳を、CPU順とメモリ順に分けました',
				body: '1行に2本並んでいた棒をやめ、「CPU使用率順」と「メモリ使用量順」の2つの一覧にしました。どちらの棒がどちらか、色で覚える必要がなくなります。',
			},
			{
				icon: 'refresh-outline',
				title: '使用量の画面が待たされにくくなり、右上から手動で更新できます',
				body: 'PC側が30分ごとに裏で集計しておくようにしました。いますぐ最新にしたいときは右上の更新ボタン（または下に引く操作）を使えます。Ccusageにはいつ取得した数字かも出ます。',
				tone: 'green',
			},
			{
				icon: 'home-outline',
				title: 'スペースを切り替えると、ホームに戻るようになりました',
				body: 'ターミナルやファイルを開いたままスペースを変えると、前のスペースの画面がそのまま残って分かりにくくなっていました。「すべて表示」を押したときも同じです（設定などを開いている間は閉じません）。',
			},
			{
				icon: 'document-text-outline',
				title: 'ソース管理で .md や .html の変更を開くと、まず読める形で出ます',
				body: 'これまでは生の差分から始まっていました。増えた行数・減った行数は今までどおり見えていて、「Diff」に切り替えればどこが変わったかも確認できます。',
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
				title: '複数のPCとペアリングしたまま、見るPCを切り替えられます',
				body: '左のパネル上部のPCの欄をタップすると、ペアリング済みのPCが並びます。選ぶだけで切り替わり、これまでのように解除して繋ぎ直す必要はありません。',
				tone: 'purple',
			},
			{
				icon: 'notifications-outline',
				title: '見ていないPCで質問が出ていることも分かります',
				body: 'PCの欄と一覧に、他のPCで待っている件数が出ます。通知も届き、タップすればそのPCへ切り替わって該当の会話が開きます。',
			},
			{
				icon: 'pricetag-outline',
				title: 'PCに名前が付くようになりました',
				body: 'PC側で決めた名前（未設定ならそのマシンの名前）が一覧に出ます。設定の一覧から、この端末だけで使う呼び名に変えることもできます。',
				tone: 'green',
			},
			{
				icon: 'options-outline',
				title: '設定からPCの追加・名前の変更・解除ができます',
				body: '見ていないPCとの接続を保つか、他のPCの通知を出すかも選べます。接続を切ると通信量は減りますが、切り替えるまでそのPCの件数は分かりません。',
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
				title: 'iPadでは、スペースの一覧を出したままエージェントと話せます',
				body: '画面の左にスペース一覧がいつも表示され、右側で会話・ターミナル・ファイルを見られます。横向きでも使えるようになりました。',
				tone: 'purple',
			},
			{
				icon: 'apps-outline',
				title: 'iPadでは、切り替えのボタンが左下にまとまりました',
				body: 'ホーム・ターミナル・ソース管理・ファイルの4つで、iPhoneの下部にあるものと同じです。画面を分けて使っていて幅が狭いときは、これまで通り下部に戻ります。',
			},
			{
				icon: 'text-outline',
				title: 'iPadでは、画面が広くても文章が読みやすい幅に収まります',
				body: '1行が長くなりすぎないよう本文の幅を抑えて中央に寄せ、下から出るパネルも広がりすぎないようにしました。ターミナルの文字は逆に、広い画面いっぱいまで大きくなります。',
				tone: 'green',
			},
			{
				icon: 'documents-outline',
				title: 'iPadでは、ファイルや差分を開いてもスペース一覧が残ります',
				body: '全画面ではなくシートとして開くので、開いたまま隣の一覧を見比べられます。',
			},
			{
				icon: 'funnel-outline',
				title: 'ホームの一覧を並べ替えたり、状態で絞り込めるようになりました',
				body: '一覧の上のボタンで「実行中だけ」のように絞り込めます。並び順もステータス順・スペース順・名前順から選べ、同じ順位のときの並びも指定できます。選んだ設定は次に開いたときも残ります。',
			},
			{
				icon: 'shuffle-outline',
				title: 'ホームの既定の並びが少し変わりました',
				body: '同じ状態のエージェントが続くとき、これまではPCのタブの順でしたが、スペースごとにまとまるようになりました。元に近い並びは「並び替え」から選び直せます。',
				tone: 'yellow',
			},
		],
	},
	{
		version: '0.2.5',
		date: '2026-08-04',
		headline: 'PCのAivis音声を、このiPhoneでも聞けます',
		items: [
			{
				icon: 'information-circle-outline',
				title: 'エージェントの画面から、名前の変更とメモの書き込みができるようになりました',
				body: '上部のターミナル名をタップすると、名前の変更・スペースのメモ・ピン留め・アーカイブ・削除がまとまったパネルが開きます。会話を見ながらチェック項目を足せます。',
				tone: 'purple',
			},
			{
				icon: 'volume-high-outline',
				title: 'PCで流れるAivisの音声を、iPhoneでも聞けるようになりました',
				body: 'ホーム右上のボタンから開始している間だけ、PCで作られた読み上げ音声がこのiPhoneでも鳴ります。画面を閉じていても、ロック中でも届きます。',
			},
			{
				icon: 'mic-off-outline',
				title: '音声はスピーカーから鳴り、マイクは使いません',
				body: '受話口から小さく鳴ったり、マイク使用中の表示が出たりすることがあった問題を直しました。あわせて、開始しても「再接続しています」から進まないことがあったのも直しています。',
				tone: 'green',
			},
			{
				icon: 'musical-notes-outline',
				title: '音声を聞いている間、ロック画面にアプリのアイコンが出るようになりました',
				body: 'これまでは粗い画像が引き伸ばされて表示されていました。',
			},
		],
	},
	{
		version: '0.2.4',
		date: '2026-07-30',
		items: [
			{
				icon: 'link-outline',
				title: 'ペアリング直後や解除時にアプリが閉じなくなりました',
				body: '初回接続の完了時と、接続済みのPCとのペアリングを解除したときに、アプリが終了することがありました。',
				tone: 'green',
			},
			{
				icon: 'list-outline',
				title: '複数の質問への回答が、ずれずに届くようになりました',
				body: '全部答えて送っても、回答が1問ずつずれて入ったり、途中で止まったままになることがありました。PC側へ送る操作の送り方を直しています。',
				tone: 'green',
			},
			{
				icon: 'create-outline',
				title: '自由入力欄に触れても、選んだ回答が消えなくなりました',
				body: '選択肢を選んだあとに自由入力欄を一度触って空にすると、選んだ内容まで取り消されて送信ボタンが押せなくなっていました。',
				tone: 'green',
			},
			{
				icon: 'notifications-outline',
				title: '他のアプリを使っている間も通知が届くようになりました',
				body: 'このアプリを開いたまま別のアプリへ切り替えると、エージェントからの通知が届かないことがありました。',
				tone: 'green',
			},
			{
				icon: 'moon-outline',
				title: 'PCの前にいる間はスマホが鳴らなくなりました',
				body: '席を外している間だけ鳴ります。鳴らさなかった通知も通知一覧には残るので、あとから読み返せます。設定で戻せます。',
			},
			{
				icon: 'chatbubbles-outline',
				title: '見ているエージェントの画面には、同じ内容のバナーを重ねません',
			},
			{
				icon: 'archive-outline',
				title: 'オフラインの間に届いた通知が、通知一覧に並ぶようになりました',
				body: '接続が切れている間に発生した通知は、つなぎ直したときにまとめて一覧へ入ります。',
				tone: 'green',
			},
			{
				icon: 'trash-outline',
				title: '通知一覧をまとめて消しても、あとで戻らなくなりました',
				body: 'クリアしたことがPCにも伝わるようになり、他の端末の一覧からも同時に消えます。',
				tone: 'green',
			},
			{
				icon: 'logo-github',
				title: '設定からGitHubのレート枠を確認できるようになりました',
				body: 'Core/GraphQLの残量に加えて、期間別・呼び出し元別・スペース別の内訳も見られます。',
				tone: 'accent',
			},
			{
				icon: 'hardware-chip-outline',
				title: 'PCのCPU・メモリ・ディスクの空きが見えるようになりました',
				body: 'ワークスペースの一覧を開くと、バッテリーの下に今の使用状況が出ます。余裕が無くなってきたときだけ色が付きます。',
				tone: 'accent',
			},
			{
				icon: 'pie-chart-outline',
				title: '何がPCのリソースを使っているか調べられるようになりました',
				body: '使用状況をタップするか設定の「システム」を開くと、Para Code本体・ターミナル・スペース・ディスクごとの内訳が見られます。',
				tone: 'accent',
			},
		],
	},
	{
		version: '0.2.3',
		date: '2026-07-29',
		items: [
			{
				icon: 'hand-left-outline',
				title: '応答の途中で上へスクロールしても、引き戻されなくなりました',
				body: '返事が流れている最中に読み返そうとすると、指を離した瞬間に一番下へ飛ばされることがありました。上へ動かしたら追従を止め、自分で下まで戻ったときだけ再開します。',
				tone: 'green',
			},
			{
				icon: 'lock-open-outline',
				title: '画面を消したままでも、通知で起こされたときに繋がるようになりました',
				body: 'ロック中はペアリング情報を読み出せず、そのまま接続に失敗することがありました。ロック解除を一度でも済ませていれば読めるように保存し直します。',
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
				title: 'やり取りの中の画像が、その場で見られるようになりました',
				body: 'エージェントが読んだスクリーンショットや、自分が貼った画像に小さなプレビューが出ます。タップすると全画面で開けます。これまでは「[image]」とだけ表示されていました。',
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
				icon: 'chevron-down-circle-outline',
				title: 'エージェントを開いた瞬間から最新のやり取りが見えるようになりました',
				body: '開いたあとに履歴が上から流れ落ちて、最新まで一気にスクロールしていくことがありました。',
				tone: 'green',
			},
			{
				icon: 'add-circle-outline',
				title: 'メモの項目をその場で足せるようになりました',
				body: '編集に入らなくても、一覧の下の「項目を追加」から書けます。改行するたびに1件ずつ増え、記号を打つ必要はありません。',
			},
			{
				icon: 'checkbox-outline',
				title: 'メモの編集にチェックリストのボタンが付きました',
				body: 'キーボードの上のボタンで、その行をチェック・見出し・箇条書きに変えられます。チェックの行で改行すると、次の行も続けてチェックになります。',
			},
			{
				icon: 'language-outline',
				title: 'メモの入力中に日本語の変換が勝手に確定されなくなりました',
				body: 'パソコンや他の端末から更新が届くと、変換の途中で文字が確定されてしまうことがありました。',
				tone: 'green',
			},
			{
				icon: 'layers-outline',
				title: '質問しているエージェントが全部ホームに並ぶように',
				body: 'これまで上部に出るのは1件だけで、2件目以降は自分で探しに行く必要がありました。いまは応答待ちが件数付きで並び、答えたいものをタップすると開いてその場で回答できます（開くのは常に1件）。',
			},
			{
				icon: 'remove-outline',
				title: 'ホーム一覧の赤い縦線をやめました',
				body: '答えを待っているものは上の「応答待ち」にまとまるので、一覧の行を縦線で強調する必要がなくなりました。',
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
