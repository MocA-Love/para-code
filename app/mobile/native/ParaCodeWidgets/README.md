# ParaCodeWidgets（iOS Widget Extension / Live Activity・ホーム画面とロック画面のウィジェット）

PARA-CODE: fork-owned directory (Para Code).

エージェントの実行状況・応答待ちをロック画面/Dynamic Islandに表示する Live Activity
（ActivityKit + WidgetKit）と、ホーム画面・ロック画面のウィジェット（案 A 要対応・B エージェント・
C PC の状態・D スペース。iOS 17 以上）のソース一式。JS側の同期は `app/mobile/src/liveActivitySync.ts`、
ネイティブ橋渡しは Expo ローカルモジュール `app/mobile/modules/para-live-activity/`
（こちらは `ios/` 外なのでリポジトリに追跡される）。

**`app/mobile/ios/` は `app/.gitignore` で無視されている**（Expo の prebuild 成果物扱い）ため、
実際に Xcode プロジェクトへ組み込まれた実体（`app/mobile/ios/ParaCodeWidgets/` と
`ParaCodeMobile.xcodeproj` のターゲット定義）はリポジトリに残らない。ここに追跡用の
ソースコピーを置き、`ios/` を作り直した場合の復元手順を記す。

## `npx expo prebuild --clean` 等で ios/ を作り直した場合の復元手順

1. このディレクトリのファイル一式（Swift 11個 + Info.plist + `ParaCodeWidgets.entitlements` + `paracode-logo.png`）を
   `app/mobile/ios/ParaCodeWidgets/` へコピー
2. Xcode で `ParaCodeMobile.xcworkspace` を開き、File → New → Target… → **Widget Extension** を追加
   - Product Name: `ParaCodeWidgets` / Team: WB4G82C384 / Language: Swift
   - 「Include Live Activity」「Include Configuration App Intent」は**チェックしない**（Bundle内で自前定義するため。付けた場合は生成テンプレートを全て削除）
   - Bundle Identifier が `ltd.paradis.paracode.mobile.ParaCodeWidgets` になることを確認
3. 生成されたテンプレートの Swift/Info.plist を本ディレクトリのもので置き換える
   （Info.plist の `NSExtensionPointIdentifier` は `com.apple.widgetkit-extension`）。
   `paracode-logo.png` は以前 Live Activity のロゴに使っていたが、案 D（2026-09-27）からは読んでいない。
   復元時は Resources へ入れなくてよい
4. ターゲットの iOS Deployment Target をメインアプリと揃え、
   `CURRENT_PROJECT_VERSION` / `MARKETING_VERSION` もメインアプリと一致させる
   （不一致だとビルド時に CFBundleVersion / CFBundleShortVersionString の警告が出る）
5. メインアプリ側の `Info.plist` に `NSSupportsLiveActivities: true` があることを確認
   （`app.json` の `ios.infoPlist` に設定済みなので prebuild で再生成される）
6. Swift はすべて ParaCodeWidgets ターゲットの Sources に入れる。**`WidgetShared.swift` だけは NotifyExtension
   ターゲットの Sources にも入れる**（通知拡張が要約を書き換えるため）
7. ParaCodeWidgets の Build Settings の `CODE_SIGN_ENTITLEMENTS` を `ParaCodeWidgets/ParaCodeWidgets.entitlements` に
   する（Debug / Release の両方）。App Group `group.ltd.paradis.paracode.mobile` はメインアプリ・NotifyExtension の
   entitlements にも入れる（Signing & Capabilities → App Groups）

## ホーム画面・ロック画面のウィジェット（2026-09-27）

- ウィジェットは PC・リレーに繋がない。App Group の `widget-snapshot.json`（要約）と `widget-settings.json`
  （設定 → ウィジェット）を読むだけ。形は `WidgetShared.swift` と JS の `src/widgets/snapshot.ts`・`settings.ts` で
  二重定義になっているので、片方だけ変えないこと
- 要約を書くのはアプリ（`src/widgets/widgetSync.ts`。前面の間は間引いて、背面へ移るときは必ず）と、
  通知拡張（`NotificationService.swift` → `WidgetStore.applyNotification`。閉じている間の要対応）
- 「確認済みにする」は `MarkReviewedIntent`（iOS 17。ロック中は解除が要る）。要約の表示をすぐ変え、
  `widget-outbox.json` に押した時点の未確認の始まり（`since`）と一緒に積む。アプリが次に PC へ繋いだら、
  いまの未確認の始まりがそれと同じか前のときだけ既存の `ackAgentStatus` で送り、積み置きから消す
  （押した後に終わった別の完了は確認済みにしない。始まりが分からなければ送らない。`src/widgets/snapshot.ts` の `planWidgetOutbox`）
- 要約は通知拡張も書くので、アプリは書く直前に読み直し、見ていない PC の要対応は `eventAt` の新しい方を残して
  合わせてから書く（`mergeUnviewedPcsFromDisk`。比べて書くのは `writeWidgetFileIfUnchanged` の 1 回の協調の中）。
  通知拡張が書き換える PC は、通知鍵の項目名から分かったものだけ（分からなければ要約はそのまま）
- 押したときのリンクは `paracode-mobile:///widget/<行き先>?pc=…&space=…&terminal=…`。いまのルートへの
  書き換えは `src/features/links/widgetLinks.ts`（ルートを変えてもウィジェットは直さなくてよい）
- 設定（長押し →「ウィジェットを編集」）は `WidgetIntents.swift` の AppIntentConfiguration。PC・スペースの
  候補は要約から出す。「既定」はアプリの設定（設定 → ウィジェット）に従う
- iOS 16.x（配信の下限 16.4）ではホーム画面のウィジェットは出ない（WidgetBundle の `if #available(iOS 17.0, *)`）

## 設計メモ

- `ParaCodeActivityAttributes` 構造体は **メインアプリ側**
  （`modules/para-live-activity/ios/ParaLiveActivityModule.swift`）にも同名で複製してある。
  ActivityKit はプロセス間を「型名の一致」で対応付けるため、両者のフィールド定義を
  常に一致させること（片方だけ変更すると Live Activity が表示されなくなる）。JS 側の型
  （`modules/para-live-activity/index.ts`）も同じ形にする。読み込みは欠けた項目を既定値で補う
- 静的属性: `pcId` / `pcName`（本当の PC 名。変わったらアプリが作り直す）
- ContentState（案 D「状態で切り替え」、2026-09-27）: `phase`（attention / running / done / offline）、
  件数（`waitingCount` / `runningCount` / `doneCount`）、`attention`（古い順に最大 2 件。先頭だけツール名と
  コマンドまたは質問文）、`running`（最大 2 件。最後のツールと対象）、`done`（新しい順に最大 3 件。かかった時間）、
  `battery`、`updatedAt` / `asOf` / `endsAt`（すべて epoch ミリ秒）。組み立ては `src/liveActivityState.ts`
- 描画は `ParaCodeLiveActivity.swift`。形はモック `paracode-live-activity-mock.html` の案 D。左に状態の印、右に数
  （expanded・ロック画面は右に PC 名）の並びは全状態で固定。expanded とロック画面は 160pt 以内に収める
- 古い表示: `staleDate`（最後の更新の 2 分後）を過ぎるか、phase が offline なら灰色にして時計を止め、右上を「◯時点」にする
- 押したときのリンクはウィジェットと同じ `WidgetLink`（`WidgetShared.swift`）。表示していた 1 件は `session`、
  完了は `pc`、オフラインは `home`
- 現状の更新はアプリのJSが動いている間のみ（段階 2 でプッシュ更新にする。準備の場所はリポジトリルートの NOTES.md）
