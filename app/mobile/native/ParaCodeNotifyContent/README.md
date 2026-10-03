# ParaCodeNotifyContent（iOS Notification Content Extension）

PARA-CODE: fork-owned directory (Para Code).

通知を長押ししたときの画面。エージェントの最後の発言（承認ならコマンド、質問なら質問文）を Markdown のまま描き、
下に「開く」を置く（`mobile-notification-mock.html` の B2）。許可・拒否・返信は iOS のボタン（カテゴリのアクション）で、
アプリが起動時に登録する（`app/mobile/src/notificationActions.ts`）。押すとアプリが前面で開き、Face ID の後に送る
（`app/mobile/src/notificationActionRunner.ts`）。この拡張からは何も送らない。

`app/mobile/ios/` は `app/.gitignore` で無視されているので、ここに追跡用のコピーを置く。

## 中身の受け渡し

| 通知 | 読む場所 | 書く人 |
|---|---|---|
| プッシュ | `userInfo` の最上位の `detail`・`category` | 通知拡張（NotifyExtension）。復号できなければ剥がす |
| アプリのローカル通知 | `userInfo["body"]`（expo の data）の `detail`・`category` | アプリ（`src/appState.ts` の `handleNotify`） |

プッシュの `userInfo["body"]` は APNs の生ペイロード（リレーが書ける）なので読まない。App Group・Keychain は使わない。
`detail` が無いとき（古い PC、「通知に内容を含める」がオフ、プッシュに入りきらなかった）は本文を出す。

## ターゲットの作り方（`ios/` を作り直した場合）

`npx expo prebuild` は使わない（NotifyExtension と ParaCodeWidgets が消える）。2026-10-04 は `project.pbxproj` を手で
編集して足した（ID の接頭辞は `FC…`）。Xcode で作り直すときは次のとおり。

1. このディレクトリの `NotificationViewController.swift` と `Info.plist` を `app/mobile/ios/ParaCodeNotifyContent/` へコピーする
2. Xcode で `ParaCodeMobile.xcworkspace` を開き、File → New → Target… → **Notification Content Extension**
   - Product Name: `ParaCodeNotifyContent` / Team: WB4G82C384 / Language: Swift
   - Bundle Identifier が `ltd.paradis.paracode.mobile.ParaCodeNotifyContent` になること
3. 生成されたテンプレートの Swift・storyboard・Info.plist を消し、1 のファイルを使う（storyboard は使わない。
   Info.plist の `NSExtensionPrincipalClass` が `$(PRODUCT_MODULE_NAME).NotificationViewController`）
4. Deployment Target（16.4）、`MARKETING_VERSION`・`CURRENT_PROJECT_VERSION` をアプリと揃える（Info.plist はこの 2 つを参照する）
5. アプリの「Embed Foundation Extensions」に `ParaCodeNotifyContent.appex` が入っていること

## Communication Notification（送り主のアイコン）のためのアプリ側の設定

通知拡張（`native/NotifyExtension/`）が送り主のエージェントを `INSendMessageIntent` で載せる。次の 3 つが無いと効かない。

- アプリの entitlements（`ios/ParaCodeMobile/ParaCodeMobile.entitlements`）に `com.apple.developer.usernotifications.communication` = `true`
  （Xcode の Signing & Capabilities → Communication Notifications）
- アプリの `ios/ParaCodeMobile/Info.plist` の `NSUserActivityTypes` に `INSendMessageIntent`
- 通知拡張の Info.plist の `NSExtensionAttributes.IntentsSupported` に `INSendMessageIntent`（`native/NotifyExtension/Info.plist`）

送り主のアイコンは `native/NotifyExtension/agent-claude.png` / `agent-codex.png` を NotifyExtension の Resources に入れる。
