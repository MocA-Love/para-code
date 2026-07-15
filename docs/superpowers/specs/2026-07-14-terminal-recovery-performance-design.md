# Terminal Recovery and Performance Design

## 目的

アプリ再起動、スペース切替、worktree作成、terminal group再生成を跨いでもClaude/Codex認識とterminal所属を維持し、大量出力中のPara固有処理が他terminalの入力を遅延させないようにする。

## 現状

- 現HEADにはpersistent PTYからのpane token復元、token復元後の実行中command再評価、instance/persistent process単位のscope台帳がある。
- これらは配布タグより後の変更を含むため、回帰テストで契約を固定する必要がある。
- Agent Terminal Hint parserはmobile relay有効時に全terminalの出力を受け、走査間隔判定より前にANSI除去を行う。
- docker-compose等の大量出力では、xterm描画やPTY Hostに加えてこのRenderer処理が負荷を増やす可能性がある。

## 採用方式

既存のidentity/scope設計を維持し、欠落経路をテストで特定して必要な箇所だけ修正する。性能はPara固有の出力ホットパスをAgent terminalへ限定し、正規表現走査を時間窓ごとにまとめた後で計測する。

## Agent認識の復元

- retained PTY環境のpane tokenをattach情報へ載せ、rendererで同じtokenを復元する。
- shell integration nonce由来tokenはfallbackとし、PTYが保持するtokenを優先する。
- CommandDetection capabilityとpane tokenの復元順序に依存せず、両方が揃った時点で実行中commandを評価する。
- Claude/Codex通知が一時失敗した場合は、同じcommandが実行中の間だけ再送する。
- hook、transcript、CommandDetectionの確定度は既存のAgent Session Controller契約を維持する。

## terminal所属

- 今セッションの正は`instanceId -> stateKey`、再起動復元の正は`persistentProcessId -> stateKey`とする。
- terminal groupのobject identityは所属判定に使わない。
- async preset、worktree setup、Agent launchは作成開始時の明示stateKeyを最後まで渡す。
- 明示stateKeyがないterminalは、生成時の`initialCwd`を登録済みrepository/worktreeパスへ最長一致させて所属を決め、現在のactive scopeは最後のfallbackにする。後続の`cd`では所属を変更しない。
- background化、group再生成、park/unparkではinstance台帳から所属を復元する。
- process ID確定時に永続マッピングを書き直し、再接続完了後に復元groupを再照合する。
- terminal disposeとscope retireで対応する台帳だけを削除する。

## 出力ホットパス

- Terminal Hint parserの対象を、confirmedまたはprovisionalに実行中のAgent terminalへ限定する。
- 非Agent terminalは`onData`で正規表現やANSI除去を行わない。
- Agent terminalでもraw tailを上限付きで保持し、scan interval到達前は文字列追加と末尾切り詰めだけを行う。
- scan時に最新raw tailへANSI除去を1回行い、既存のelapsed/token抽出を実行する。
- raw bufferは16,384文字、正規化後bufferは4,096文字を上限とする。scan間隔は400ms、emit間隔は800msの既存値を維持する。
- mobile terminal streamの既存backpressureを維持し、計測で支配的と判明しない限り暗号化・転送設計は変更しない。

## 計測

- 通常terminalとAgent terminalへ同量の高頻度出力を流し、Renderer CPU、PTY Host CPU、hint parser呼び出し回数を測る。
- mobile relay disabled/enabled、terminal未購読/購読の条件を分ける。
- 別terminalでキー入力からechoまでの遅延を測る。
- Para固有処理の軽量化後も遅延が残る場合は、RendererとPTY Hostのprofileを取得し、xterm変更は別の根拠ある修正として扱う。

## 検証

- persistent reconnectで同じpane tokenになる。
- token先行、capability先行の両方で実行中Claude/Codexを認識する。
- async作成中に別スペースへ切り替えても作成元scopeへ所属する。
- taskやextension経由で遅延生成されたterminalも、initial cwdに対応するscopeへ所属する。
- background化、park/unpark、group再生成、再起動後も所属が変わらない。
- 非Agent terminalの大量出力でTerminal HintのANSI除去・regex scanが走らない。
- Agent terminalの大量出力でもscan回数が設定間隔を超えず、bufferが上限を超えない。
- mobile購読の有無による他terminalのinput-to-echo遅延悪化を、同一環境のrelay無効時に対してp95で10%以内かつ5ms以内に収める。

## レビュー境界

identity復元、scope所属、出力ホットパス、計測結果を別々にレビューする。性能改善は測定値を添えて独立レビューし、原因未確認のxterm変更を混ぜない。
