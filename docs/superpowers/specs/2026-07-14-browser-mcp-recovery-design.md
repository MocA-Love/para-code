# Browser MCP Recovery Design

## 目的

Para Browser MCPがスクリーンショット、接続切断、タイムアウト、BrowserView破棄の後もアプリ再起動なしで回復し、障害を同じペイン内に限定する。

## 現状の問題

- `Page.captureScreenshot`のElectron委譲は一部パラメータで迂回され、成功扱いの全透明画像も検出しない。
- tokenごとのchrome-devtools-mcp子プロセスは、外側のタイムアウトやMCP再接続後も生存して同じMutex停止を引き継ぐ。
- BrowserViewが破棄されてもshared processのbindingと解決済みtargetIdが残る場合がある。
- `DevToolsActivePort`から解決した上流CDPポートは失敗後もキャッシュされる。
- MCP shimのHTTP要求に明示的な接続・応答タイムアウトがなく、ポートファイルのPIDも検証しない。

## 採用方式

ペインtokenごとに単調増加するbinding generationを持つ。binding、CDP接続、chrome-devtools-mcp子プロセス、pending tool callを同じgenerationへ所属させ、世代変更時に古い資源を一括破棄する。サービス全体は再起動せず、影響を該当tokenへ限定する。

## ライフサイクル

- 初回bindでgenerationを作成し、`token -> generation -> pageId/targetId/child`を関連付ける。
- rebind、unbind、BrowserView破棄はgenerationを進め、古いCDP接続と子プロセスを終了する。
- BrowserView破棄の自動unbindは、rendererが観測したbinding generationとshared processの現在generationが一致する場合だけ実行する。消滅検出後に同じtokenが再bindされていれば、新しいbindingは解除しない。
- rendererはknown台帳で実際に`present -> absent`を観測したpageIdだけを自動unbind候補として保持する。復元途中でまだknownへ追加されていない別pageIdは、無関係なcloseを契機に解除しない。
- rendererは削除観測時刻を記録し、最初に成功したbinding取得で、その時刻より前から存在した`{ token, pageId, generation }`だけを解除候補として固定する。同一ミリ秒は新bindingの誤解除を避けるため保守的に除外し、binding取得失敗中または消滅検出後に成立したrebindを候補へ昇格させない。
- binding取得または条件付きunbindが一時失敗した候補は、成功、同じgenerationの消滅確認、stale確認、または同pageIdの再追加まで保持して再試行する。`unbindIfCurrent=false`はstale確認として候補を完了し、新しいgenerationを次回候補にしない。再試行は直列化し、dispose後は開始しない。
- tool callのタイムアウト、HTTP client abort、子プロセス異常、CDP切断後の再接続失敗は、そのgenerationを不健全として子プロセスを終了する。
- 次のtool callは現在generationへ新しい子プロセスを生成する。
- 古いgenerationから遅れて返った応答はクライアントへ返さない。
- ペインdisposeは全generationをretireし、binding、status、CDPキャッシュを既存のtoken退役処理で削除する。

## CDP上流の自己回復

- `/json/version`または`/json/list`のfetch失敗時は、キャッシュした上流ポートを無効化する。
- `DevToolsActivePort`を読み直して、同じ要求を1回だけ再試行する。
- 上流CDPのfetchは1試行5秒で中断し、無限待機を許可しない。
- 2回目も失敗した場合は、endpointと段階を含むエラーを返す。tokenはログへ平文で出さない。
- MCP port fileはportとPIDを検証し、PIDが生存していない場合は直ちに再読込する。shimからshared processへの接続確立は5秒、tool call全体は既存の300秒上限より長い310秒で中断する。
- MCP port fileは同じディレクトリの一時ファイルへ書いてからrenameする。shared processの新旧世代が重なった際に、旧世代のdisposeが新世代のport fileを削除する競合を避けるため、disposeでは固定port fileをunlinkしない。残ったrecordはPID生存確認により無効化され、次回起動時に原子的に置換される。

## スクリーンショット

- 非表示BrowserViewは描画を起こした後、次のpaintを待ってからcaptureする。
- `NativeImage.isEmpty()`、寸法、PNG/WebP/JPEGのバイト長、アルファ値を検査する。
- 空または全透明なら次のpaintを待って最大5回まで再試行する。
- ブラウザレベル接続のsession frameとページレベル接続の両方で、viewport、full-page、element、および`scale: 1`のclipを共通のBrowserView capture境界へ寄せる。`clip.scale != 1`は対応外として明示エラーにする。
- PNG/JPEGは共通captureへ寄せる。Electron `NativeImage`で安全に再エンコードできないWebPは、表示中BrowserViewの生CDPでのみ許可し、非表示時はPNG/JPEGを案内する明示エラーにする。
- BrowserView破棄やgeneration変更中のcaptureはstale結果を返さず、`PARA_BROWSER_RETRYABLE`理由付きのMCP tool errorにする。
- delegated captureが空・透明・失敗になった場合は生CDPへ黙ってfallbackせず、理由付きエラーにする。`fromSurface: false`、`clip.scale != 1`、非表示WebPも明示的に拒否する。
- shared processはcapture/visibility問い合わせ前のbinding参照とgenerationを保持し、electron-main応答後にも一致を確認する。撮影中のrebind結果を旧要求へ返さない。

## ログ

tokenはSHA-256の先頭12桁で表し、generation、pageId、child PID、gateway/upstream port、tool名、開始・終了時間、終了理由を記録する。スクリーンショットは委譲経路、再試行理由、画像寸法と透明判定だけを記録し、画像内容は記録しない。

## エラー処理

- timeoutとabortはpending promiseの削除だけで終えず、該当子プロセスを終了する。
- rebind中の要求はstale generationとして`PARA_BROWSER_RETRYABLE`理由付きのMCP tool errorにする。
- BrowserView破棄はgeneration一致を条件とする自動unbindとして扱う。
- 回復不能な場合も他tokenの子プロセスやbindingは維持する。

## 検証

- generation変更後に古い子プロセスと応答が再利用されない。
- tool timeout、client abort、CDP切断後の次回呼び出しで新しい子プロセスが生成される。
- BrowserView破棄で削除観測時点のbindingとtargetIdだけが削除され、検出後またはbinding取得失敗中に成立した新世代bindingは維持される。
- stale CDP portを再解決し、1回だけ再試行する。
- viewport、full-page、element、`scale: 1`のclipについて、PNG/JPEGのcapture結果が不透明である。表示中WebPは既存互換経路を維持し、非表示WebPは明示エラーになる。
- 全透明の正常応答を検出して再試行し、上限到達時は明示エラーになる。
- あるtokenの障害が他tokenのtool callへ影響しない。

## レビュー境界

この単位はgeneration管理、CDP自己回復、BrowserView破棄連携、スクリーンショットの4段階で自己レビューし、完了後に独立レビューを行う。Critical/Important指摘を解消するまで次の設計単位へ進まない。
