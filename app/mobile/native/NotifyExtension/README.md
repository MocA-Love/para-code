# NotifyExtension（iOS Notification Service Extension）

PARA-CODE: fork-owned directory (Para Code).

APNs リモート通知のカスタムペイロード `e`（base64url の AES-256-GCM 暗号文）を復号し、
通知の title/body を実際の内容（エージェントの質問文など）へ差し替える NSE のソース一式。

**`app/mobile/ios/` は `app/.gitignore` で無視されている**（Expo の prebuild 成果物扱い）ため、
実際に Xcode プロジェクトへ組み込まれた実体（`app/mobile/ios/NotifyExtension/` と
`ParaCodeMobile.xcodeproj` のターゲット定義）はリポジトリに残らない。ここに追跡用の
ソースコピーを置き、`ios/` を作り直した場合の復元手順を記す。

## `npx expo prebuild --clean` 等で ios/ を作り直した場合の復元手順

1. このディレクトリの3ファイルを `app/mobile/ios/NotifyExtension/` へコピー
2. Xcode で `ParaCodeMobile.xcworkspace` を開き、File → New → Target… → **Notification Service Extension** を追加
   - Product Name: `NotifyExtension` / Team: WB4G82C384 / Language: Swift
   - Bundle Identifier が `ltd.paradis.paracode.mobile.NotifyExtension` になることを確認
3. 生成されたテンプレートの `NotificationService.swift` / `Info.plist` を本ディレクトリのもので置き換え、
   ターゲットの Signing & Capabilities で **Keychain Sharing** を追加し
   `ltd.paradis.paracode.mobile.shared` を登録（= `NotifyExtension.entitlements`）
4. メインアプリ（ParaCodeMobile）側にも同じ **Keychain Sharing** グループを追加し、
   `Info.plist` に `UIBackgroundModes: [remote-notification]` があることを確認
   （app.json にも設定済みだが、prebuild が反映しない場合は手動で）
5. NSE ターゲットの iOS Deployment Target をメインアプリと揃える
6. 復元後、NSE の `Info.plist` にある `CFBundleShortVersionString`（ハードコード `0.1.0`）を
   メインアプリのバージョン（app.json の `version`）と揃える。App Store 提出時、
   メインアプリと Extension の `CFBundleShortVersionString` が一致していないと
   ITMS エラーになる。Xcode 上でターゲットの Version を書き換え、このコピーへも反映すること

## 鍵の受け渡し（設計）

- メインアプリが接続時に `deriveNotifyKey(モバイル長期秘密鍵, PC長期公開鍵)` で導出した
  32バイト鍵の hex を、expo-secure-store で共有 Keychain へ保存する
  （service `paracode.notify`（実際の kSecAttrService は `paracode.notify:no-auth`）、
  account `notifyKey.<PCのdeviceId>`、access group `WB4G82C384.ltd.paradis.paracode.mobile.shared`、
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY）。実装: `app/mobile/src/platform.ts` の `persistNotifyKey`
- **鍵はペアリング相手のPCごとに1本**（複数PCとペアリングできるため）。APNsのペイロードには
  送信元PCが書かれていないので、NSE は access group 内の `notifyKey*` を**全件読んで順に試す**
  （AES-GCM の認証タグが合うのは1本だけ）。復号できた鍵の account 名から PC の deviceId を取り出し、
  `userInfo["pcId"]` として通知に載せる。アプリはこれを見て、通知タップ時に該当PCへ切り替える
- account が `notifyKey`（サフィックス無し）の項目は単一PCしか扱えなかった頃の名残。アプリは
  複数PC対応版への初回起動で、PCごとの鍵を保存し直したあとにこれを削除する
- ワイヤ形式は `12Bノンス || AES-256-GCM暗号文(tag込み)` = CryptoKit の
  `AES.GCM.SealedBox(combined:)` がそのまま受ける形式
- 復号した JSON は `NotifyPayload`（`app/protocol/src/notify.ts`）
