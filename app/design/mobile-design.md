# Para Code Mobile — 設計書（ドラフト v1）

作成: 2026-07-05。UIモックアップは同ディレクトリの `mobile.html` を参照。

## 0. ゴールと前提

- PCで動くPara Codeから離れた場所（別ネットワーク含む）から、iPhoneで作業を続行できる
- 対象機能: ターミナル操作 / ソース管理 / ファイル閲覧 / ブラウザ(para-browser)閲覧 / エージェント(Claude Code, Codex)の状態監視と質問への即時回答（プッシュ通知）
- ワークスペース単位で切り替えるUI（mobile.html準拠）
- iOS先行、Androidを後続。PC側はfork実装ルール（新規ファイル完結・PARA-PATCH最小）を厳守

## 1. 全体アーキテクチャ

```
┌─ iPhone ────────────┐      ┌─ リレーサーバ ──────────────┐      ┌─ PC (Para Code) ────────────────┐
│ Para Code Mobile     │ WSS  │ Cloudflare Workers          │ WSS  │ shared process                   │
│ (React Native+Expo)  │◄────►│  + Durable Objects          │◄────►│  paradisMobileRelayClient        │
│  - xterm.js(WebView) │      │  (deviceIdごとに1 DO,       │      │  (デバイス鍵/E2E/再接続/多重化)   │
│  - E2E暗号(libsodium)│      │   ルーティングのみ・中身は  │      │        ▲ IPC channel             │
│  - APNs + NSE復号    │      │   復号できない)             │      │ 各workbenchウィンドウ             │
└─────────────────────┘      │  + APNsプッシュ送信          │      │  paradisMobileWorkspaceProvider  │
                              └────────────────────────────┘      │  (terminal/scm/fs/browser提供)    │
                                                                   └──────────────────────────────────┘
```

- **両端ともoutbound WSSのみ**。PC側のポート開放・固定IP不要、NAT/ファイアウォール越えが自動で成立する
- **リレーは暗号文の転送だけ**を行う（E2E暗号化、§3）。リレーが侵害されてもターミナル内容・ファイル内容は読めない
- PC側の接続オーナーは **shared process**（アプリで1つ、ウィンドウのreload/closeに影響されない。`/agent-hook` サーバと同居できる既存パターン）。各ウィンドウは自ワークスペースの機能を shared process にIPC channelで提供する

### リポジトリ構成（2026-07-05決定: 同一リポジトリ）

PC側contributionは `src/vs/paradis/contrib/mobileRelay/`、モバイルアプリ・リレー・共有プロトコルは**本リポジトリのルート直下 `./app`**（pnpm workspace）に置く:

```
app/
├── design/       # 設計書・UIモックアップ（このファイル）
├── mobile/       # React Native (Expo) アプリ
├── relay/        # Cloudflare Workers + Durable Objects
└── protocol/     # フレーム定義・E2E暗号・型 (TS共有)
```

- ルート直下の新規ディレクトリはupstreamとのコンフリクトリスクがほぼ無い
- hygieneチェックは対象外（2026-07-05確認: `build/filters.ts` の `all` はルート直下ファイルと build/extensions/scripts/src/test 配下のみを対象とし、`app/**` はそもそも含まれない。PARA-PATCH不要）。ESLintはTSコードを置く段階で要確認。`.gitignore` へのRN/Expo生成物の追加は必要
- 注意: `src/vs/` はVS Code独自ビルドのため `./app/protocol` を直接importできない。プロトコル定義は `src/vs/paradis/contrib/mobileRelay/common/` へ**コピー同期**する（同期チェックスクリプトを `app/protocol` 側に置く）

## 2. ペアリングと認証

### 2.1 鍵の構成

| 鍵 | 保管場所 | 用途 |
|---|---|---|
| PCデバイス鍵 (X25519) | PC: Electron `safeStorage` で暗号化して application スコープに保存 | デバイス同一性・E2E |
| モバイルデバイス鍵 (X25519) | iOS: Secure Enclave/Keychain (`expo-secure-store`) | 同上 |
| セッション鍵 | メモリのみ | 接続ごとにECDH+HKDFで導出、XChaCha20-Poly1305で全フレームを暗号化 |

暗号ライブラリは両端とも libsodium（PC: `sodium-native` は避け、既存依存に合わせWASM版 or tweetnacl。実装時に選定）。

### 2.2 初回ペアリングフロー

1. PC: コマンド「**Para: モバイルデバイスを接続**」→ 鍵ペア生成（未生成時）、リレーに `deviceId` を登録し、**短命ペアリングトークン**（TTL 5分・1回限り）を発行
2. PC: QRコードを表示。内容 = `{relayUrl, deviceId, pairingToken, pcPubKey}`
3. モバイル: QRスキャン → リレーに pairingToken で接続 → 自分の pubKey を pcPubKey 宛に暗号化して送信
4. **相互検証**: 両端で共有秘密から6桁の検証コード（SAS）を導出して表示。PC側ダイアログでユーザーが「モバイルに表示されたコードと一致」を確認して承認 → リレーによるMITMを排除
5. 両端が相手の公開鍵を永続化。リレーDOは `deviceId ↔ mobileId(+APNsトークン)` のルーティング情報のみ保存

mobile.html のペアリング画面の6桁コードはこの**SAS検証コード**（QRが読めない環境向けの手動入力コードも兼ねる）。

### 2.3 再接続時の認証

- モバイル→リレー: デバイス鍵によるチャレンジ署名（Ed25519に変換 or 別途署名鍵）でDOに認証
- PC→リレー: 同様。PCはPara Code起動中は常時WSSを維持（切断時は指数バックオフで再接続）
- E2Eレイヤー: 接続確立ごとにephemeral X25519でECDH（長期鍵と組み合わせるNoise IKパターン相当）→ 前方秘匿性を確保

## 3. プロトコル

E2Eチャネル上に**チャネル多重化されたバイナリフレーム**（msgpack）を流す:

```
Frame = { ch: string, ws?: string, seq: number, payload: bytes }
```

| ch | 方向 | 内容 |
|---|---|---|
| `state` | PC→M | ワークスペース一覧・ターミナル一覧・エージェント状態のスナップショット+差分。ホーム画面とバッジの供給源 |
| `term` | 双方向 | PTY入出力(生バイナリ)・resize・タブ操作。ターミナルIDはPC側の実インスタンスに対応（ミラー方式、§4.2） |
| `scm` | 双方向 | リポジトリ状態・変更一覧・diff取得・コミット実行 |
| `fs` | M→PC要求 | ディレクトリ一覧・ファイル読み取り（サイズ上限付き）。書き込みはv1では対象外 |
| `browser` | 双方向 | para-browserのCDP screencastフレーム(PC→M)と入力イベント(M→PC) |
| `notify` | PC→M | プッシュ対象イベント（§6）。オンライン時はin-app、オフライン時はリレー経由APNs |

- `state` はスナップショット+差分方式（切断復帰時はスナップショット再送）
- `term` / `browser` はバックプレッシャ制御（モバイル側のwindow update方式）。帯域が細い時はscreencastのフレームレート/品質を落とす

## 4. PC側実装設計（Para Code / このリポジトリ）

fork規約準拠: `src/vs/paradis/contrib/mobileRelay/` 配下の新規ファイル + 集約importへの追記のみで完結させる。

```
src/vs/paradis/contrib/mobileRelay/
├── common/paradisMobileRelay.ts            # プロトコル型・設定キー・チャネルID定数
├── node/paradisMobileRelayClient.ts        # shared process常駐: WSS接続・E2E・多重化・再接続
├── node/paradisMobileRelayChannel.ts       # ウィンドウ⇔shared processのIPC channel
├── electron-browser/
│   ├── paradisMobileRelay.contribution.ts  # ウィンドウ側: ペアリングコマンド/QRダイアログ/WorkspaceProvider登録
│   ├── paradisMobilePairingDialog.ts       # QR表示・SAS承認ダイアログ
│   └── paradisMobileWorkspaceProvider.ts   # terminal/scm/fs/browserの各ハンドラ
└── browser/paradisMobileRelaySettings.contribution.ts  # 設定スキーマ登録
```

- shared process側のコードロードは、`/agent-hook`（agentBrowser系）が既に確立している shared process 登録ポイントに相乗りする（実装時に該当箇所を確認し、必要なら1行PARA-PATCH）
- 集約import: `paradis.electron-browser.contribution.ts` と `paradis.common.contribution.ts` に各1行

### 4.1 既存資産の再利用（重要）

| 必要機能 | 再利用する既存実装 |
|---|---|
| エージェント状態（実行中/応答待ち/レビュー待ち） | `IParadisAgentStatusStore`（`workspaceSwitch/common/`）。shared processの`/agent-hook`がClaude Codeフックを受けて`permission/working/review`に集計済み |
| 通知イベント | `ParadisNotificationTrigger` の状態遷移検知にファンアウト先（`notify`チャネル）を追加 |
| ブラウザミラー | `agentBrowser/node/paradisCdpFilterProxy.ts` 等のCDP基盤。`Page.startScreencast` + `Input.dispatch*` で実現 |
| ワークスペース概念 | `IParadisWorkspaceSwitchService` / ターミナルスコープ（`IParadisTerminalScopeService`） |
| スリープ防止の推奨通知 | keepAwake設計（別途設計済み）の内部コマンド `paradis.power.promptKeepAwakeForRemote` をモバイル初回接続時に実行 |

### 4.2 ターミナルは「ミラー」方式

新しいヘッドレスセッションを作るのではなく、**PCの実ターミナルインスタンスにアタッチ**する:

- 一覧/状態: `ITerminalService` のインスタンス列挙 + ワークスペーススコープで絞り込み
- 出力: `instance.onData`（xterm連携の生データ）を購読して転送。接続時に直近バッファ（scrollback末尾N KB）をスナップショット送信
- 入力: `instance.sendText` / 生入力パス。リサイズはモバイル側の表示都合でPC側を変えない（モバイルは自前のxterm.jsでreflow）→ 実装時にreflowの品質を検証し、必要ならPC側と寸法同期するモードを追加

これにより「PCで作業していた続きをそのままスマホで操作」が成立する（mobile.htmlのタブミラーと一致）。

### 4.3 設定

- `paradis.mobile.enabled` (bool, def: false) — リレー接続の常駐を有効化。ペアリング済みデバイスがあれば起動時に自動接続
- `paradis.mobile.relayUrl` (string, def: 公式リレー) — セルフホスト用
- ペアリング済みデバイスの管理コマンド: 「Para: モバイルデバイスの管理」（一覧・失効）

## 5. モバイルアプリ設計

### 5.1 技術スタック（推奨: React Native + Expo）

| 選択肢 | 判断 |
|---|---|
| **React Native + Expo (dev client)** ✅ | TS資産（protocolパッケージ）を共有でき、Android展開が同一コード。xterm.jsはWebViewで実績あり。APNs/SecureStore/QRスキャンはExpoモジュールで揃う |
| SwiftUIネイティブ | 端末体験は最良だがAndroidで全書き直し。チームのTS中心スキルと合わない |
| Flutter | Dartに資産がない |

- ターミナル描画: `react-native-webview` 内の **xterm.js**（PC側と同じレンダラ＝エスケープシーケンス互換性が保証される）。修飾キー行・IME入力はRN側UIからWebViewへ注入
- 状態管理: protocolパッケージの `state` スナップショット+差分をそのままstoreに反映（Zustand等）
- 画面構成は mobile.html の通り: ホーム / ターミナル / ソース管理 / ファイル / ブラウザ + ワークスペース切り替えバー

### 5.2 プッシュ通知（E2Eを保ったまま）

1. PC → リレー: `notify` イベント（**E2E暗号化済みペイロード**）
2. リレー → APNs: `mutable-content: 1` で暗号文ペイロードをそのまま送信（APNs/リレーには「通知が発生した」ことしか分からない）
3. iOS **Notification Service Extension** がKeychainのセッション鍵…ではなく長期鍵から導出した通知用鍵で復号し、「Claude Code — para-code: 質問があります…」を組み立てて表示
4. タップ → 該当ワークスペースのターミナル画面へディープリンク

通知種別: エージェントの質問/許可要求（permission）、タスク完了（review）、長時間タスクの完了、接続切断（PCオフライン化）。

配布形態（2026-07-05決定）: **TestFlight内部テスト配布**（Apple Developer Program加入済み）。App Store公開は当面しない。

### 5.3 オフライン/切断時の挙動

- 接続断はホームのPCカードに明示（「オフライン · 最終接続 x分前」）
- `state` の最終スナップショットは閲覧可能のまま（操作はグレーアウト）
- PCがスリープした場合もこの経路で検知 → keepAwake推奨との連携

## 6. リレーサーバ設計（Cloudflare Workers + Durable Objects）

既存のPara Code配布基盤がCloudflare（wrangler）にあるため同居させる。

- **deviceIdごとに1つのDO**: PC側WSSとモバイル側WSS（複数可）を保持し、フレームを転送するだけ。WebSocket Hibernationでアイドルコストほぼゼロ
- DOの永続状態: `{deviceId, pcPubKey, mobiles: [{mobileId, mobilePubKey, apnsToken}]}` — 鍵は公開鍵のみ、秘密は一切持たない
- ペアリングトークン発行/検証、APNs送信（Workers から HTTP/2 APNs API）
- 帯域対策: フレームサイズ上限・レート制限。screencastはPC側で品質調整するためリレーは無関心でよい
- 認証されないWSSは即切断。DOはルーティングメタデータ以外をログにも残さない

### 6.1 料金（2026-07時点、Cloudflare公式）

リレーは暗号文を転送するだけ（復号・DB書き込みはペアリング時のみ）で、WebSocket Hibernationによりアイドル中はduration非課金。課金に効くのはメッセージ数とアクティブ時間。

- **無料プラン(Free)で個人〜少人数はほぼ収まる**: Workers/DOリクエスト各100,000/日、DO duration 13,000 GB-s/日、SQLite合計5GB。ペアリング時しかDB書き込みしないためストレージ枠は問題にならない
- **有料(Workers Paid $5/月)の従量単価**: Workersリクエスト1,000万/月込 +$0.30/百万、DOリクエスト100万/月込 +$0.15/百万、DO duration 400,000 GB-s/月込 +$12.50/百万GB-s、SQLite 5GB-month込 +$0.20/GB-month
- **WebSocket受信は20:1で圧縮計算**（20メッセージ=リクエスト1件）。ターミナルのキー入力1打=1メッセージなのでこの圧縮が強く効く
- **スペックは自動スケール**（DOはPC1台=1インスタンスで分散、サイジング不要）。料金は「同時接続N人」枠ではなく純粋な従量で、概ねPC台数に比例。個人利用で月額が二桁ドルに乗ることはまず無い
- APNs自体はApple側の無料インフラ。Cloudflare側の追加費用はプッシュ送信のWorkersリクエスト分のみ

## 7. 段階的ロードマップ

| Phase | 内容 | 完了条件 |
|---|---|---|
| **M0** | protocolパッケージ + リレーDO + PC側relayClientの骨格。ペアリング(QR/SAS)成立 | CLIテストクライアントでPCとE2E疎通 |
| **M1** | `state` + `term` + APNs通知。モバイルアプリ(ホーム/ターミナルのみ) | 外出先からClaude Codeの質問に回答できる |
| **M2** | `scm` + `fs`（ソース管理・ファイル画面） | スマホからdiff確認+コミット |
| **M3** | `browser`（CDP screencastミラー） | para-browser閲覧・操作 |
| **M4** | Android対応 / LAN直結モード（mDNS発見でリレー迂回、低レイテンシ） | — |

M1が「離れても作業続行」の最小価値。ここまでを最初のマイルストーンにする。

### 実装状況（2026-07-05 時点）

- **M0 完了**: `app/protocol`（E2E暗号・ペアリング・フレームコーデック、AES-256-GCM + X25519 + HKDF-SHA256）、`app/relay`（Cloudflare Workers + DeviceDO、WebSocket Hibernation）、PC側 `src/vs/paradis/contrib/mobileRelay/`（shared process常駐サービス + renderer contribution）、`app/mobile` の接続/ペアリングクライアント中核ロジックを実装済み
- **暗号方針**: PC側はvscodeへの新規npm依存を避けるため Node webcrypto で実装、モバイル側は @noble（純JS、RN対応）。両者のワイヤ互換は `app/protocol/test/interop.test.ts` が保証
- **検証済み**: protocol/relay/mobile のユニット・統合テスト（フルE2E: mobile↔実リレー(miniflare)↔PCハーネスでペアリング〜双方向フレーム）、実dev buildでPCがローカルリレーに provision→WS接続→pair/begin してペアリングURIダイアログを表示するところまで確認
- **M1 実装済み**: モバイルアプリのUI画面（ホーム/ペアリング(QR+SAS)/ターミナル）、通知パイプライン（PC側 notify チャネル：エージェント状態の permission/review 遷移を検知して送信 → モバイルで通知一覧反映＋expo-notificationsローカル通知）。オンライン/接続時の「エージェントの質問通知」はこの経路で完結。protocol/relay/mobile のユニット・統合テストでカバー
- **M1 完了（2026-07-05 シミュレータ実機E2E検証済み）**: iOS 26.5 シミュレータでオンデバイス実行を確認（Expo SDK 57 / RN 0.86 へ移行。SDK 52 は Xcode 26.6 と非互換で起動不能だった）。ペアリング（QR/リンク貼り付け→SAS→承認）、状態同期、ターミナルミラー双方向、scrollback初期同期（attach時に `getContentsAsText` 末尾を送信）まで実機確認。PC側は QR コードを自前エンコーダ（`paradisQrCode.ts`、依存ゼロ、CoreImage デコーダで往復検証済み）で webview パネル表示
- **M2 完了（同日E2E検証済み）**: scm（status/diff/commit/log。gitはshared processの `runGit` で実行、サブコマンド許可リスト制）と fs（list/read。ワークスペースルート配下限定・シンボリックリンク除外・256KB上限）。モバイルからの実コミットを検証済み
- **M3 完了（同日E2E検証済み）**: browser ミラー。**Page.startScreencast は Electron の WebContentsView ではフレームを発火しない（実測）** ため、Page.captureScreenshot の 700ms ポーリング + 入力直後の即時キャプチャで実装。タップは正規化座標→CSS座標変換で `Input.dispatchMouseEvent`（**buttons:1 必須**、無いとクリック合成されない）。PC→モバイルのライブフレーム同期とモバイル→PCのタップ dispatch を双方向で実機検証済み
- **UI**: `app/design/mobile.html` のモックアップ準拠に全面改装（2026-07-05）。下部5タブ（ホーム/ターミナル/ソース管理/ファイル/ブラウザ）+ 上部ワークスペースバー（全画面連動・応答待ちバッジ）+ ホームのPCカード/エージェント状態/「回答する」導線。デザイントークンは `src/theme.ts` に集約
- **UI改編（2026-07-11）**: ブラウザの独立タブを廃止して下部4タブ化し、ブラウザはエージェント詳細ヘッダーのボタンから開くスタック画面（`app/browser.tsx`）に変更（用途が「エージェントの作業結果を見る」に従属するため）。PC側 `targets` 応答に agentBrowser のバインディング由来の `sharedToken` を付与し、遷移元エージェントと共有中のページを自動選択、ヘッダーボタンには緑ドットを表示。複数ページは画面上部のタブチップで切替
- **M1 残（実機必須で本環境では検証不能）**: APNsリモート通知のオフライン配送（リレー→APNs→Notification Service Extension。NSEはネイティブSwift実装＋Apple署名が必要）、xterm.js in WebView による端末完全再現（現状はANSI除去の簡易表示で動作）
- **未着手**: M4(Android/LAN直結)、リレーのprovisionレート制限（DoS対策）

## 8. セキュリティ上の設計判断まとめ

- リレーには**ゼロトラスト**: E2E必須、リレーは暗号文ルーティングのみ。SAS検証でペアリング時のMITMも排除
- ターミナル遠隔操作は事実上のリモートシェル。**ペアリングはPC側での物理的な承認操作を必須**とし、デバイス失効をPC側からいつでも実行可能にする
- モバイル側の鍵はKeychain(Secure Enclave)保管、アプリ起動時にFace ID/Touch IDでゲート（設定でon/off）
- `fs` の読み取りはワークスペースルート配下に制限（シンボリックリンク越え禁止）
- リレーURLを設定で差し替え可能にし、セルフホストの選択肢を残す

### 8.1 セキュリティレビューでの修正（2026-07-05、コードレビュー反映）

- **ペアリング認可の厳格化**: `pair/begin` を pcToken で認証（第三者がペアリングセッションを勝手に発行できない）。承認時の資格情報は対象 pairId のソケットにのみ送り、ペアリングトークンは承認で即失効（1回限り）
- **SASすり替えMITM対策**: pairing-msg に pairId を付与し PC 側で検証、SAS 表示後は相手公開鍵を凍結して別鍵での上書きを禁止（承認するのは「SAS を表示した鍵ちょうど」）
- **AEAD カウンタの堅牢化**: 受信カウンタは復号成功時のみ前進（不正1フレームで恒久 desync しない）。webcrypto の非同期 seal は方向別に直列化（nonce 再利用防止）
- **再接続・失効**: モバイル切断でセッション破棄、リレーに revoke エンドポイントを追加して失効を伝播
- **端末出力の宛先分離**: ターミナル出力は attach を要求したモバイルにのみ返す（複数デバイス時の相互漏洩を防止）
- **PC 側長期秘密鍵の暗号化（対応済み）**: 秘密鍵(pkcs8)を `IEncryptionMainService`(safeStorage) で暗号化して保存するようにした（`app.ts` の encryption チャネルを shared process にも公開）。旧平文形式は読込時に自動移行。safeStorage 不可環境（キーリング無し Linux 等）のみ mode 0600 平文にフォールバック。実 dev build で暗号化保存（encSecret のみ・平文 pkcs8 無し）を確認済み

## 9. 未決事項

- [ ] xterm.js in WebView の入力レイテンシ・IME品質の実機検証（M1の最初に検証スパイクを置く）
- [ ] Codexの状態検知カバレッジ（現行`/agent-hook`はClaude Codeフック前提。Codex側の検知方法を実装時に確認）
- [ ] リレーの公式ホスト名・課金保護（Cloudflare無料枠で足りる想定だが、screencast帯域は要実測）
