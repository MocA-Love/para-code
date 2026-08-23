# ParaCode 回帰・資源効率・狭幅UI監査修正設計

## 背景

前回公開リリース `v1.132.0-paracode-123`（`a5367401a3bd`）から、追加監査時点の
`origin/main`（`8c5bd783f570`）までを対象に、次の四点を監査した。初回監査後の
`fec28eb7b56b..8c5bd783f570` も、main更新のたびに差分・呼出関係・資源寿命の観点で
再確認している。最後の更新で入ったmobile terminal routingとport list widgetも対象に含む。

1. 前回リリース後に新しく入った回帰
2. ParaCode所有コードのメモリ、CPU、RAM、外部通信の無駄
3. PR #42（upstream 1.134.0取り込み）によるParaCode独自機能の消失
4. iPhone 13を含む狭い画面で操作不能になるUI

PR #42については、公式VS Code 1.132.0／1.134.0とPRのbase／headを三方向比較した。
PR baseに存在した正規化済み `PARA-PATCH` マーカーの消失はなく、ParaCode所有領域、
製品設定、依存、contribution入口、更新認証、BrowserView、terminalの主要独自経路も
保持されていた。したがって、PR #42そのものを戻したり独自機能を再注入したりする変更は行わない。

## 方針

修正は一つのブランチと一つのPRにまとめ、原因単位の独立コミットに分ける。各修正は、可能な限り
失敗する回帰テストを先に追加し、そのテストを通す最小変更に限定する。静的根拠だけでは実害を
確定できない候補は変更せず、監査結果としてPR本文に残す。

## 修正対象

| # | 領域 | 確定した問題 | 完了条件 |
|---|---|---|---|
| 1 | Mobile iOS | 可変幅TerminalPickerと2操作を非圧縮の単一headerRightへ入れ、390pt級でpickerがクリップされる | compact幅では全操作へ到達できる固定幅メニューを表示し、390/375/320ptで幅予算を超えない |
| 2 | Mobile Android/旧iOS | native picker非対応時のchipBandを描画されない`below`へ渡している | fallback帯を本文上部へ直接描画し、端末を切り替えられる |
| 3 | Mobile home | 320pt級で左島と右上4操作が収まらない | compact幅では固定幅の統合メニューへ縮退し、全操作へ到達できる |
| 4 | Web phone UI | phone layoutのChanges画面にCreate Pull Request操作が存在しない | mobile changes用menuから既存changes actionを実行できる |
| 5 | Mobile WebView | Androidで省略される`isTopFrame`をfalse扱いし、危険URL拒否と外部URL移送を迂回する | 明示的な`false`だけiframe扱いし、undefinedではトップフレーム規則を適用する |
| 6 | Mobile diff | ハンク内の`+++value`／`---value`をファイルヘッダーと誤認して捨てる | ハンク状態を追跡し、内容行をadd/delとして保持する |
| 7 | Session history | 599px以下の戻るボタン表示が後続の同一詳細度ルールで上書きされる | 1カラム詳細画面で戻るボタンが表示される |
| 8 | Git repository parking | removed-folderの一次parkingが祖先repositoryとreal pathを考慮しない | 現workspaceを包含する、または包含されるrepositoryを一次・二次判定ともparkしない |
| 9 | Windows process | Node timeout callback後ではwrapperがexit済みで、孫process treeを安全にkillできない | timeout期限にwrapperが生存中の段階でtree killを開始し、完了・dispose時にtimerを解除する |
| 10 | HTML preview | 非loopback tunnelを拒否する例外経路で取得済み参照をdisposeしない | 拒否経路でtunnelを正確に一度disposeする |
| 11 | Binding dialog polling | devices以外のタブでも4秒周期の列挙と全面renderを続ける | devices表示中だけpollし、退出・disposeで停止する |
| 12 | Binding dialog listeners | 検索ごとの行再描画で旧行listenerを保持する | 一覧専用DisposableStoreを再描画前にclearする |
| 13 | Release notes | CTSの`dispose()`が通信をcancelせず、閉じたmodalも保持する | 再オープン・閉鎖で旧通信をcancelし、現行インスタンスだけをcleanupする |
| 14 | Aivis usage | 音量等の無関係な設定変更でもusage/me APIを毎回再取得する | API key・期間が不変なら取得を再利用し、古い応答を描画しない |
| 15 | Codex directory walk | CWD別の走査時刻Mapが無制限に増える | TTLと件数上限を持つ小さなLRU相当の台帳にし、現行の走査抑制を維持する |
| 16 | PTY host lifecycle | daemon starterとfallback starterがIPC EventEmitter listenerを`removeHandler`で解除し、dispose後もlistenerを残す | 両starterが登録時と同一参照を`removeListener`へ渡し、dispose後のlistener数がbaselineへ戻る |
| 17 | Bookmark diagnostics | 破損bookmark JSONの`SyntaxError`が保存内容の断片を診断へ含め得る | 復旧用raw backupは維持し、診断へは固定文言のErrorだけを渡す |
| 18 | Keep Awake | start/stop失敗時に所有blocker IDを失い、実状態と表示がずれ、停止を再試行できない | 成功したblockerだけを所有し、stop失敗IDを保持・再試行し、所有中の実効modeを表示する |
| 19 | Service status | 継続障害をproviderごとの全pollで報告し、送信抑制前のevent構築とbreadcrumbを反復するうえ、応答本文がErrorへ混入し得る | 連続失敗episodeにつきproviderごとに一度だけ固定Errorを報告し、成功後の再失敗は再度報告する |
| 20 | Browser live diagnostics | model未解決を5回数えた後はcapture失敗が6回目となり、`=== 5`条件で永続失敗を報告しない | 診断用には実capture失敗だけを数え、5回目を一度だけ報告し、capture成功時にguardをresetする |
| 21 | Terminal separator diagnostics | module評価時の報告がdiagnostic reporter設定前にno-opとなる | fallback登録は同期のまま維持し、reporter初期化後のlifecycleで欠損を一度報告する |
| 22 | Diagnostic privacy boundary | raw Error本文へHTTP body、保存内容、file pathが入る複数の確定経路があり、sanitizerは任意本文やpath全体を除去しない | 各Sentry adapterが共通helperで固定message・固定name・frameなしのErrorへ変換し、raw message、stack、cause、任意propertyを送らない |
| 23 | Port list narrow layout | panel幅を常に440pxへ固定し、390/375/320pxでは右側のPID・終了操作がviewport外へ出る | viewport左右8px内へ収まる幅と位置を計算し、compact rowでも終了操作へ到達できる |
| 24 | Port list background work | 閉じた静的アイコンのためだけに各titlebarが毎分`lsof`/`ps`または`/proc`全走査を続ける | panel非表示中はtimerと列挙を停止し、open直後とopen中だけ取得する |
| 25 | Port list Kill All | N件の各kill IPCが毎回全portを再列挙し、最後のrefreshを含めN+1回の高コスト走査になる | batch IPCが一度のfresh snapshotで全対象を再検証し、各PIDの結果を返す |
| 26 | Port list route identity | `getConnection()`のlocal値`null`を`undefined`と比較し、表示はremote、実killはlocalとなる | `null`を唯一のlocal値として表示、fail-closed判定、channel選択を同じpredicateへ揃える |
| 27 | Remote port ownership | 同一endpointの複数socket inodeと同一inodeの複数PIDをMap上書きで欠落させる | connectionをinode単位、ownerを`Map<inode, Set<pid>>`で保持し全socket/PID組をentry化する |

## コンポーネント設計

### 1. 狭幅ヘッダーとターミナル切替

phone/compact幅（既存の共通size classが`compact`を返す環境）では、ターミナル一覧、コマンド
プリセット、新規ターミナルを一つの44pt固定幅ネイティブメニューへ統合する。可変幅の端末名は
header itemとして使わず、選択状態はメニューのcheckmarkと状態アイコンで示す。regular幅では
既存の視覚構成を維持する。

ホームも同じcompact判定を使い、archive、音声通知、通知一覧、新規作成を一つのoverflow menuへ
まとめる。各項目は既存callbackを呼び、業務ロジックを複製しない。regular幅では既存の個別操作を
維持する。

native menuを利用できないAndroid／旧iOSでは、既存chipBandをヘッダー仕様へ渡さず、ターミナル
本文の先頭へ直接描画する。帯の高さを本文余白へ反映し、TermViewや入力欄を覆わない。

### 2. Web phone changes actions

desktop title barのanchorを複製せず、既存の`MenuId.AgentsChangesToolbar`を
`MenuWorkbenchToolBar`でmobile changes overlayのheaderへ配置する。`vs/sessions/browser`から
`vs/sessions/contrib`をimportしないレイヤー制約を守りつつ、Create Pull Requestを含む既存
command/action実装、enablement、visibility、エラー通知をdesktopと共有する。active session
resourceをmenu argumentに渡し、mobile overlayは戻る、縮小可能なタイトル、actions、ファイル一覧の
順に配置する。compact幅ではactionsをoverflowにまとめる。

### 3. 純粋な表示・判定回帰

WebView guardは`request.isTopFrame === false`だけをiframeとして許可する。diff parserは
`diff --git`境界でhunk状態をresetし、有効な`@@`でhunkへ入り、hunk外だけ`+++`／`---`を
メタデータとして除外する。session history CSSは広幅既定の`display:none`をcontainer ruleより前へ
移し、狭幅ruleがcascadeの最終決定になるようにする。

Git parkingでは、現在のworkspace folderの論理pathとreal pathを先に収集する。removed-folder由来
候補と全open repositoryを重複のない一つの候補集合へまとめ、既存の双方向包含predicateへ一度だけ
通してからparkする。active editorのrepositoryは従来どおり除外する。

### 4. プロセスと所有資源

Windows CLI timeoutは、`execFile`内部timeout後のcallbackからtree killする方式をやめる。共有helperで
明示timerを設定し、期限到達時にwrapper PIDが生存している間に`paradisKillChildProcessTree`を呼ぶ。
callback、正常完了、channel disposeではtimerを必ず解除する。timeoutか通常エラーかは呼出側へ明示的に
返し、ccusageのoffline retry抑制等、既存の判断を維持する。

HTML preview tunnelは、取得成功からmounterへ所有権を移すまでを一つの局所的な所有区間とする。
loopback検証等が失敗した場合はその場でdisposeし、成功時だけ通常のmounter disposeへ移譲する。

PTY host starterはdaemon経路とupstream fallback経路の双方で、message-channel listenerをnamed fieldとして
保持する。登録に使った同一関数参照を`removeListener`へ渡し、starterのdispose後にIPC EventEmitter上へ
残さない。upstream所有ファイルの差分には理由付き`PARA-PATCH`を付ける。

Keep AwakeはElectron APIから独立したcontrollerが、成功済みblockerをIDとmodeの組として所有する。
start成功時だけ所有集合へ追加し、stop成功時だけ削除する。stop失敗はIDを失わず次のreconcileで再試行し、
表示は要求値ではなく所有中blockerの実効強度`display > system > off`から求める。要求変更を直列化して、
pending start中にoffへ変わった場合も、遅れて得たIDを停止または再試行対象として必ず追跡する。

### 5. ポーリング、イベント、キャッシュ

Binding dialogはdevicesタブの選択状態をpolling leaseの所有者にする。tab遷移時に
`MutableDisposable`の値を交換し、devices退出時とdialog dispose時に即座に停止する。pane行listenerは
一覧専用storeへ登録し、検索・フィルタによる一覧再描画の冒頭でclearする。snapshot内容が不変の更新で
全面DOM再構築を発生させないようモデル層で正規化後の内容を比較し、初回取得後のbackground pollでは
loadingだけを理由に全dialogへ変更通知を送らない。

Release notesはmodalとfetch CTSを一つの世代として管理する。新世代開始前とmodal閉鎖時に旧CTSを
cancelしてdisposeし、Promiseのfinallyでは自分が現行世代の場合だけmodule-level参照をclearする。
遅れて完了した旧PromiseはcacheやDOMを更新しない。

Aivis usageはAPI keyと期間をcache keyにし、同じsection instance内の結果と通信をsingle-flight化する。
音量、話速、声種、辞書、出力形式等の変更は取得済み結果を再描画するだけにし、usage/meを再取得しない。
設定画面を閉じて新しいsection instanceを開いた場合は最新値を取得する。世代番号で古い応答を破棄する。

Codex directory walkの時刻台帳は、走査抑制間隔と同じ5分を過ぎたentryを参照時に除去し、挿入時は
古い順に128件まで削除する。これにより抑制の意味を変えず、長寿命processでもメモリを有界にする。

### 6. 診断の秘匿性、頻度、到達性

Bookmark破損時は、ローカルのrecovery backupへ元raw値を残す既存復旧を維持する一方、診断には
`Browser bookmark storage could not be parsed`という固定Errorだけを渡す。JSON parserが入力断片をmessageへ含めても、
bookmark titleやURLが外部診断へ渡らない境界にする。

Service statusはproviderごとの連続失敗episodeを共有trackerで管理する。最初の失敗だけを固定Errorと安全な
provider enumで報告し、同じ障害中のpollでは状態更新だけを行う。正常なJSON応答を得た時点でepisodeを閉じ、
その後の再失敗は新しいepisodeとして直ちに一度報告する。HTTP response bodyやparse errorはUI表示にだけ使い、
診断Errorへは渡さない。

Browser live thumbnailは、既存のretry/backoff用`failures`とは別に診断専用gateを持つ。model未解決は診断回数へ
加算せず、1枚も表示できていない間の実capture例外だけを数え、5回目に一度報告する。capture成功でgateをresetする。

Terminal word separatorのdefault取得とoverride登録はmodule評価時の同期処理を維持する。欠損フラグだけを
記録し、`AfterRestored`のcontributionから一度報告してdesktop reporter初期化前のno-opを避ける。Webで
reporterがない場合は従来どおり安全なno-opとし、fallback separator自体は必ず登録する。

すべての明示診断は、desktopの3つのprocess固有Sentry adapterが`captureException`する直前に共通helperで
safe Errorへ変換する。domain側のreporter spyや元例外の伝播契約は変えない。messageはfeature/operationという
内部分類だけから固定生成し、nameは`Error`、stackは固定first lineだけにする。元Errorのmessage、stack、cause、
任意propertyは一切参照・コピーしない。非Error、stackなし、custom stack、stack getterがthrowする値でも
診断呼出し自体はthrowしない。これによりbookmark、CAPI/HTTP response、
filesystem/remote cwdを含む既知経路だけでなく、今後追加されるraw Errorにも同じ秘匿境界を適用する。

### 7. Port listの狭幅表示と高コスト処理

Port list panelは440pxを最大幅とし、実幅を`viewport width - 16px`以下へ縮めて左右8pxの余白内へ配置する。
compact幅ではrowのgap、固定列、risk badgeを縮退させ、process名をellipsisにして終了ボタンを必ず残す。
幅とleft位置はresizeのたびに同じpure geometry関数から求める。

panelを閉じている間、titlebar iconはsnapshotを表示に使わないため、idle poll timerとvisibility復帰pollを
持たない。panel open時に即時取得し、表示中だけ15秒周期を所有し、close/disposeでcancelする。前回snapshotは
次回open直後の暫定表示にだけ再利用し、直後のfresh取得で更新する。

「すべて終了」はentryごとに全portを再走査せず、単一batch IPCへ対象配列を渡す。backendは入力を個別検証し、
fresh snapshotを一度だけ収集してPID・port・process nameを照合し、自身/親processを除外したうえで各SIGTERMを
実行する。個別失敗数を返し、rendererは既存の部分失敗通知と最後の一回refreshを維持する。

route判定は`IRemoteAgentService.getConnection()`の契約どおり`null`をlocalとする。panelタイトル・確認文言へ渡す
`connectedToRemote`、kill/killAllのexpected route照合、実channel選択の3箇所を同じpredicateへ揃え、利用者が
承認した対象マシンと実際の破壊対象が食い違わないようにする。

remote列挙では`/proc/net/tcp*`のLISTEN行を`ip:port`ではなくsocket inodeで区別する。同じinodeを複数PIDが
参照する場合も`Set<pid>`で全ownerを保持し、全`(socket,pid)`を表示・batch再検証対象へ含める。

## エラー処理と互換性

- native menuがない環境は必ず本文内fallbackへ進み、操作入口を失わない。
- menu actionは既存callback/commandを呼び、新しい状態遷移を作らない。
- cancellationは古い処理だけを止め、現行世代を誤ってclearしないようidentityを比較する。
- process timeoutは正常完了とのraceを一度だけ完了するguardで吸収する。
- resource disposeは所有権移譲点を一つにし、漏れと二重disposeの双方をテストする。
- 診断へ渡すErrorはユーザー保存内容、HTTP response body、filesystem pathを含まない固定境界を持つ。
- 反復診断は成功で閉じる失敗episode単位に制限し、別providerや回復後の再障害を隠さない。
- PR #42で保持を確認した独自領域やupstreamコードは、今回の問題に直接必要な場所以外は変更しない。

## テスト戦略

実装はTDDで進め、各問題の失敗を確認してからproduction codeを変更する。

1. Mobile Vitest
   - iPhoneの390/375/320ptがcompact menuを選び、regular iPadだけ個別actionsを選ぶこと
   - native module非対応時のterminal fallback表示と選択
   - `isTopFrame`がfalse／undefined／trueの場合のURL規則
   - hunk内の`+++value`／`---value`、複数file diff
2. VS Code unit/component tests
   - mobile changes menuにCreate Pull Request actionが存在する
   - CSS cascade順または狭幅fixtureでdetail backが表示される
   - repository祖先、子孫、logical/real pathのparking判定
   - timeout timerの正常解除、期限到達、dispose、完了race
   - 非loopback tunnelの一回dispose
   - dialog tab遷移によるpoll leaseと行listenerの上限
   - release notes世代交代とclose cancellation
   - Aivis cache key、single-flight、stale response拒否
   - directory walk台帳のTTLと件数上限
   - 両PTY starterの登録listener参照とdispose後のlistener数
   - Keep Awakeのstart/stop失敗、mode切替、遅延startとoffのrace、停止再試行
   - bookmark破損復旧を維持した固定診断Error
   - service statusのfailure/failure/success/failure episodeとprovider独立性
   - browser live failure guardの閾値超過、一回報告、成功reset
   - terminal separator fallbackとlifecycle後の一回報告
   - diagnostic safe Errorのraw message/stack/cause/property除去、非Error・壊れたstackへの耐性
   - utility processのreporter統合経路でraw needleが最終eventへ残らないこと
   - port panel geometryの440/390/375/320px、compact rowで終了操作が残ること
   - port polling policyがclosedでtimer無し、openで15秒、close/disposeでcancelすること
   - Kill Allが一回だけcollectし、valid/invalid/protected/kill失敗を個別集計すること
   - local=`null`とremote connectionの表示・fail-closed・channel routeが一致すること
   - 同一endpointの異なるinodeと同一inodeの複数PIDがremote一覧で欠落しないこと
3. 静的検証
   - 変更対象のlintと型検査
   - `npm run typecheck-client`
   - `npm run valid-layers-check`
   - `git diff --check`
4. UI確認
   - 利用可能な環境でCode OSSを起動し、phone幅のChangesと狭幅session historyを操作する
   - iOS実機／simulatorを利用できない場合も、幅判定とcomponent testを必須証拠とし、実機未確認はPRへ明記する

## レビューとPR

実装後は、実装を担当していないSubagentへbase SHA、head SHA、要件表、検証結果を渡してレビューを依頼する。
CriticalまたはImportant指摘は原因を検証し、必要な修正と再検証を行う。最終的に一つのブランチをpushし、
`main`向けPRを作る。PR本文には監査範囲、PR #42で消失がなかった根拠、修正一覧、テスト結果、実機確認の
有無、修正しなかった未確定候補を記載する。

## 対象外

次は静的監査だけでは実害を確定できないため、このPRでは変更しない。

- iPad Split Viewのsize class閾値跨ぎによるnavigator再mount
- HTML preview配信中のclient切断時にReadStreamがEOFまで残る可能性
- remote user home初期取得失敗後のreload要求
- upstream由来のfixture内conflict marker文字列
