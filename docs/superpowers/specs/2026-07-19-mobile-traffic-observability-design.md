# Paracode Mobile 通信量計測基盤 設計仕様

## 目的

Paracode Mobile の通信量削減を安全に進めるため、最適化前のPC・Relay間E2Eフレームをチャネル別に計測する。フェーズ0では既存コードを変えず総通信量の基準シナリオを固定し、フェーズ1では明示的に有効化した開発環境だけでローカル集計を出力する。

## 安全条件

- 既定状態では計測処理を生成せず、現行の送受信経路を維持する。
- プロトコルv3、暗号方式、nonce、seq、チャンク境界、送信順序を変更しない。
- ペイロード本文、workspace、terminal、mobile ID、ファイルパス、URL、通知内容を記録しない。
- 記録する値は方向、チャネル、フレーム数、アプリケーションペイロード長、封緘済み長だけとする。
- observerとログ出力の失敗を送受信処理へ伝播させない。
- 外部テレメトリやRelay APIを追加しない。
- ユーザー所有の未追跡ファイルを変更しない。
- コミット、プッシュ、マイグレーションを行わない。

## フェーズ0: 基準シナリオ

実機能を変更せず、同じ時間と操作で総通信量、再接続回数、復帰時間を取得する。

1. foregroundで30分放置する。
2. Terminalを10分使用する。
3. Agentで長文応答を生成する。
4. JPEGのみのブラウザミラーを5分使用する。
5. WebRTC確立中のブラウザミラーを5分使用する。
6. PDF、docx、画像を一度ずつ開く。
7. background移行・復帰を行う。
8. 同じ操作を低速・高遅延条件で繰り返す。

iOS Simulatorを第一候補とし、実Relayとのペアリングが必要な自動操作には既存の疑似モバイルハーネスを読み取り専用で利用できる。ハーネスを正式な計測基盤へ取り込むことは本フェーズの対象外とする。

## フェーズ1: PC側FrameMuxの計測

### FrameMux observer

PC側の非同期`FrameMuxOptions`へ任意の`onTraffic`を追加する。送信は封緘と送出が成功した直後、受信は復号とフレームdecodeが成功した直後に1サンプルを通知する。

サンプルは以下だけを持つ。

- `direction`: `sent`または`received`
- `channel`: 既存の`ChannelId`
- `payloadBytes`: 当該チャンクのアプリケーションペイロード長
- `sealedBytes`: AES-GCM封緘済みフレーム長
- `more`: 後続チャンクの有無

observer例外は握りつぶす。observer未指定時は既存処理と同じ経路になる。

### 集計

新しいNode側集計器が方向・チャネル単位で次を加算する。

- frame count
- logical message count（`more:false`のフレーム数）
- payload bytes
- sealed bytes
- PC・Relay間ペイロード概算（sealed bytes + version 1 byte + mobile ID 16 bytes）

集計器は本文や識別子を受け取らない。スナップショット取得時に集計をリセットし、直前区間だけを返す。

### 有効化と出力

環境変数`PARADIS_MOBILE_TRAFFIC_DIAGNOSTICS=1`で起動したPCだけ有効にする。60秒ごとに既存`ILogService`へ集計JSONを1行出力する。値がない区間は出力しない。停止時はtimerを破棄する。

環境変数未設定時は集計器、timer、observerを生成しない。

## エラー処理

- 復号・decode失敗は現行の`onError`と再接続処理だけが扱い、計測対象に含めない。
- observerまたは集計ログの失敗はbest-effortとして無視する。
- 数値は非負の安全整数として内部生成値だけを加算する。
- 集計機能を無効にしてもセッション再作成を必要としない。次回PC起動時に環境変数を外せば完全に旧経路へ戻る。

## テスト方針

- TDDでobserver未実装時に失敗するFrameMuxテストを先に追加する。
- 送信と受信のサンプル値が実際のフレーム長と一致することを確認する。
- 大容量チャンクでframe countとlogical message countを区別する。
- observerがthrowしても相手側handlerへ同じペイロードが届くことを確認する。
- 集計器がチャネル・方向別に加算し、snapshot後にリセットされることを確認する。
- TypeScript typecheck後に関連Mochaテストを実行する。
- iOS Simulatorでは既存機能の接続、background復帰、Terminal、Agent、ブラウザを確認する。

## 非対象

- JPEG重複排除、Base64廃止、圧縮、差分同期、キャッシュ、liveness変更。
- WebRTC確立中のJPEG停止。
- 外部テレメトリ、永続ログ、診断UI。
- App Store配布、Relayデプロイ、コミット、プッシュ。
