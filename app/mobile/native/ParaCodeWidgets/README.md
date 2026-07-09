# ParaCodeWidgets（iOS Widget Extension / Live Activity）

PARA-CODE: fork-owned directory (Para Code).

エージェントの実行状況・応答待ちをロック画面/Dynamic Islandに表示する Live Activity
（ActivityKit + WidgetKit）のソース一式。JS側の同期は `app/mobile/src/liveActivitySync.ts`、
ネイティブ橋渡しは Expo ローカルモジュール `app/mobile/modules/para-live-activity/`
（こちらは `ios/` 外なのでリポジトリに追跡される）。

**`app/mobile/ios/` は `app/.gitignore` で無視されている**（Expo の prebuild 成果物扱い）ため、
実際に Xcode プロジェクトへ組み込まれた実体（`app/mobile/ios/ParaCodeWidgets/` と
`ParaCodeMobile.xcodeproj` のターゲット定義）はリポジトリに残らない。ここに追跡用の
ソースコピーを置き、`ios/` を作り直した場合の復元手順を記す。

## `npx expo prebuild --clean` 等で ios/ を作り直した場合の復元手順

1. このディレクトリのファイル一式（Swift 2つ + Info.plist + `paracode-logo.png`）を
   `app/mobile/ios/ParaCodeWidgets/` へコピー
2. Xcode で `ParaCodeMobile.xcworkspace` を開き、File → New → Target… → **Widget Extension** を追加
   - Product Name: `ParaCodeWidgets` / Team: WB4G82C384 / Language: Swift
   - 「Include Live Activity」「Include Configuration App Intent」は**チェックしない**（Bundle内で自前定義するため。付けた場合は生成テンプレートを全て削除）
   - Bundle Identifier が `ltd.paradis.paracode.mobile.ParaCodeWidgets` になることを確認
3. 生成されたテンプレートの Swift/Info.plist を本ディレクトリのもので置き換える
   （Info.plist の `NSExtensionPointIdentifier` は `com.apple.widgetkit-extension`）。
   `paracode-logo.png` は ParaCodeWidgets ターゲットの **Resources（Copy Bundle Resources）**
   へ追加する（ロック画面/Dynamic Island のロゴ。`assets/pairing-logo.png` の
   `sips -Z 128` 縮小コピー。無くてもビルドは通り、ターミナルシンボルへフォールバックする）
4. ターゲットの iOS Deployment Target をメインアプリと揃え、
   `CURRENT_PROJECT_VERSION` / `MARKETING_VERSION` もメインアプリと一致させる
   （不一致だとビルド時に CFBundleVersion / CFBundleShortVersionString の警告が出る）
5. メインアプリ側の `Info.plist` に `NSSupportsLiveActivities: true` があることを確認
   （`app.json` の `ios.infoPlist` に設定済みなので prebuild で再生成される）

## 設計メモ

- `ParaCodeActivityAttributes` 構造体は **メインアプリ側**
  （`modules/para-live-activity/ios/ParaLiveActivityModule.swift`）にも同名で複製してある。
  ActivityKit はプロセス間を「型名の一致」で対応付けるため、両者のフィールド定義を
  常に一致させること（片方だけ変更すると Live Activity が表示されなくなる）
- ContentState: `waitingCount` / `runningCount` / `agents`（最大2件の {name, status}）/
  `questionPreview`。JS側の構築は `liveActivitySync.ts`
- 現状の更新はアプリのJSが動いている間のみ（プッシュ経由のバックグラウンド更新は将来対応）
