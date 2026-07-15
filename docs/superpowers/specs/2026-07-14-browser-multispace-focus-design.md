# Browser Multispace and Focus Isolation Design

## 目的

複数スペースで複数のPara Browser MCPを同時利用しても、ペインとBrowserViewの対応を維持し、MCP操作がユーザーのターミナル入力やIMEへ影響しないようにする。

## 現状の問題

- `terminalService.instances`は通常・editor・background terminalを含むが、別スペースへparkしたpanel groupと専用台帳へparkしたeditor terminalは含まない。
- Unit 1でペイントークン台帳を生存判定の正にしたため、parkだけでtokenが退役する問題は解消済み。ただしmanifestのshell PID補完、binding UIのペイン列挙、scope照合は依然としてpark済みinstanceを見落とす。
- bindingダイアログのfallbackが全スペースの既知BrowserViewを使うため、別スペースの先頭ページを選ぶ場合がある。
- terminalとBrowserViewのscopeをbinding作成時に照合しておらず、別スペース間の誤bindingをshared processでも拒否できない。
- すべての`Input.*`直前に`webContents.focus()`を呼ぶため、ターミナルやIMEからフォーカスが移る。

## 採用方式

MCP用のペイン生存台帳をUI可視性から分離し、実際のterminal instance disposeを退役の正とする。`Input.*`はBrowserView固有のElectron debuggerへ直接配送し、OS・workbenchのフォーカスを変更しない。

この設計は`2026-07-14-browser-mcp-recovery-design.md`のbinding generation、Renderer manifest、ペイントークン台帳を前提とする。binding generationは入力要求の失効にも使い、ペインの生存は引き続きinstance disposeでtoken台帳から削除された時点を正とする。

## ペイン列挙と生存authority

- 共通の列挙関数で`terminalService.instances`（通常・editor・background）、`ITerminalGroupService.paradisParkedGroups`、`paradisListParkedTerminalEditorInstances()`を合算し、instanceIdで重複排除する。
- ペインの生存authorityは既存`IParadisPaneTokenService`とする。UI上の表示・park状態は退役理由にせず、terminal instance disposeでtokenが台帳から消えた時だけ退役する。
- detach/reattach中は旧・新instanceIdが一時的に同じtokenを持ち得るため、列挙結果は`getInstanceForToken(token) === instanceId`を満たす現行instanceだけに絞り、tokenでも重複排除する。`listPaneTokens()`もreverse mapの現行対応だけを返す。
- Renderer manifestは`listPaneTokens()`で全live tokenを列挙し、共通列挙関数で見つかったinstanceのshell PIDを補完する。別の生存台帳や定期full-replaceは追加しない。
- Renderer manifestはウィンドウごとの単調増加`authorityRevision`を持ち、各tokenへ解決済みterminal scopeも添える。Browser scopeも同じrevisionのmanifestへ`viewId → scope`として含め、shared processは現行Renderer connection leaseに属する最新revisionだけをbinding authorityとして保持する。scope event中の`pending`も値として同期し、以前のstable値へfallbackしない。送信は専用singletonのsingle-flight queueへ直列化し、成功ackされたrevisionだけを`syncNow()`の結果としてbindへ渡す。
- terminal/browser復元中は`complete: false`、両initialization barrier完了後かつlifecycle shutdown外では通常変更ごとに`complete: true`を送る。これにより明示terminal-exit通知が失敗しても次のfull snapshotでowner/bindingを回収する。Renderer reload/window shutdown開始後は同期をfreezeし、dispose過程の空台帳を`complete: true`で送らない。新Rendererは再びbarrier完了までincompleteとし、park済みtokenも常に含める。
- binding UIのペイン一覧にも共通列挙関数を使い、scope条件に一致するpark済みペインの既存bindingを管理できるようにする。
- 同じPTYをdetach/reattachした場合は、既存の復元pane tokenと新instanceの対応を使い、旧instanceの遅延disposeで新対応を消さない。

## スペースとbinding

- 既存`ParadisBrowserWorkspaceScope`の`_viewRepositories`を唯一のbrowser scope台帳として残し、`IParadisBrowserScopeService`経由でBrowserView IDからstable stateKeyを参照できるようにする。別のMapを新設しない。
- Unit 1ではelectron-mainのBrowserViewとbindingをRenderer reload中も保持するため、`viewId → stateKey`を`StorageScope.WORKSPACE`/`StorageTarget.MACHINE`へ保存し、service生成時に既知viewをtagする前に復元する。reload後にmainから再列挙されたinactive scopeのviewを現在scopeへ上書きしない。
- Renderer/window shutdown中の`BrowserEditorInput.dispose`では保存scopeを削除しない。実ユーザーclose（shutdown外）とscope retireだけで削除する。起動時に一時absentなviewを一括削除せず、inactive working setから後で復元されるstable viewIdのscopeを保持する。
- service構築時にstorageを同期loadしてから最初の`onDidChangeBrowserViews`購読/tagを行う。`ILifecycleService.onWillShutdown`でshutdown開始flagを立て、`onWillDispose`ではflagに加えて`lifecycleService.willShutdown`を直接確認し、listener順序に依存せずmappingを保持する。通常時の`onWillDispose`だけを実ユーザーcloseとしmappingを削除・persistする。scope retireは`onDidRetireScope`を唯一の一括削除契機にし、repository changeや起動時absentだけでは削除しない。
- storage parse結果は`valid | absent | corrupt`を区別する。`corrupt`を空Mapとして自動tagせず、初期snapshotでscopeを復元できないviewは`pending`へ隔離する。`absent`でもアプデ直後にMainへ旧viewが残る可能性を考慮し、初期化中に現れた未知viewは、barrier後に現在の`getContextualBrowserViews()`へ属することを確認できたものだけstable active scopeへtagし、inactiveな未知viewは`pending`のままにする。barrier後に新規作成されたviewは通常のactive scopeへtagする。
- scope retire時は保存Mapから削除したviewIdを初期化完了までtombstoneへ保持する。Main snapshotから遅れて同じIDが現れた場合はtag前に`dispose(true)`し、現在scopeで復活させない。snapshot成功時もknown台帳に残るtombstoned IDを一括clearせず、snapshotでabsentと証明できたIDまたは`dispose(true)`後にknownから消えたIDだけ掃除する。snapshot失敗時はlate viewの復活を防ぐため保持する。
- `IParadisBrowserScopeService`は`resolveScope(viewId)`、`initializationBarrier`、単調増加revisionとstable change eventを公開する。実装はsingleton本体とAfterRestored starterに分け、contributionとの二重生成・managed stateKeyの二重Mapを禁止する。storage同期load直後からbarrier完了までは保存済みviewだけを`managed`、未知viewを`pending`とする。barrier後は保存済みviewを`managed`、`isSwitching`中や既知viewの初期tag中を`pending`、安定した`activeStateKey`がある新規viewをそのstateKeyの`managed`、`isParadisManagedWorkspaceWindow() === false`の通常workspaceだけを`unscoped`とする。managed windowで`activeStateKey`が未確定なら`pending`とし、`activeStateKey === undefined`だけでunscopedとは判定しない。
- `IBrowserViewWorkbenchService.whenInitialized`はMain既存view snapshotの完了と成功可否を示すnon-rejecting Promiseとし、desktop実装ではcreate event listenerを先に登録してからsnapshotを開始してsnapshot/listen gapを作らない。snapshot取得だけでなくsnapshot各viewのaccept callbackがthrowした場合も`false`へ収束し、Web実装は`Promise.resolve(true)`を返す。
- `onDidChangeRepositories`はmapping削除には使わないが、通常workspaceで`unscoped`だった既知viewをParadis管理対象へ登録した場合と、storage `absent`で初期化中に`pending`となった既知viewが後からcontextualになった場合の初回tag再評価triggerとして維持する。scope switch完了時もpendingとunscopedの全既知contextual viewを再評価し、`corrupt`由来でない`pending`を現行active scopeの`managed`または通常workspaceの`unscoped`へ収束させる。`corrupt`由来の`pending`は明示close/reopen等まで隔離し、repository一覧の一時変動だけで既存managed mappingを削除・unscoped化しない。
- workspace switch serviceが同じfolder URIへ状態キーだけを矯正する場合も、previous stateKeyが変われば`onDidSwitchScope`を発火する。URI一致の早期returnでbrowser/terminal scopeの再評価を取りこぼさない。
- 既存`IParadisTerminalScopeService`はgroup台帳に加えてlive`_instanceScopes`を優先参照する。これによりgroupからbackgroundへ移ったinstanceも元のscopeを保持し、active scopeへ誤追随しない。
- Renderer内部のscope解決結果は`{ kind: 'managed'; stateKey: string } | { kind: 'unscoped' } | { kind: 'pending' }`で表す。workspace切替中、terminal backend再接続中で復元scope未確定、既知viewの初期tag未完了は`pending`、Paradis管理外の通常ワークスペースだけを`unscoped`とする。登録repositoryの有無だけでmanaged/pendingを決めない。
- 既存`IParadisTerminalScopeService`へstable scope変更eventを追加し、token→現行instanceId→terminal scopeを解決する。Browser scope serviceも初期tag、実reassignment、retireを区別したeventを持つ。BrowserView disposeやRenderer teardownはscope変更eventとして扱わず、Unit 1のgeneration付き消滅reconcileへ任せる。
- binding作成時はRendererでterminal/browser双方のstable scopeを解決し、同じ`kind`かつmanagedなら同じstateKeyの場合だけshared processへ送る。`pending`は送信不可、`unscoped`同士は従来互換で許可する。shared processもdiscriminated scope同士を比較し、不一致を拒否したうえでbindingへscopeを保存する。
- bindはprepare/commitの2段階にする。prepareは現行Renderer connection lease、authority manifestのobject identity/revision、token owner、terminal/browser scopeをsnapshotしてからelectron-mainのview owner/target identityをawaitし、戻った後に同じauthorityであることを再検証して短寿命・単発のticketを返す。Rendererはticket取得後に両scope snapshot/revisionを再解決し、変化していればabortする。commitはawaitを含めず、同一connection・同一manifest object/revision・同一scope・未使用ticketを再検証してからgenerationを進める。これによりowner/scope変更中の一時bindingを公開しない。
- prepareはtokenごとのmutation epochと開始時binding identity/generationもsnapshotする。bind/unbind/retire/owner transfer/最初のticket commitはepochを進め、同じepochから並行発行された残りticketを失効させる。後着の古いticketが新bindingを巻き戻せない。
- binding UI/modelはbind直前にmanifest同期サービスの`syncNow()`をawaitし、そのrevisionをprepareへ渡す。新規token直後にowner未同期で誤拒否されるレースを避ける一方、同期失敗時にowner検証を省略しない。
- Renderer authority同期は`onWillSwitchScope`/`onDidSwitchScope`、terminal接続状態、両initialization barrier、terminal/browser scope change、pane token、BrowserView集合を直接購読し、`pending`を含む現在値をsingle-flight queueへ載せる。成功ackは実際にacceptされたrevisionを返し、重複した非同期送信の古い応答を新authorityとして扱わない。
- bindingダイアログのページ解決は「指定ペインのexact既存binding → active BrowserView → `getContextualBrowserViews()`内の最初のmodel」の順にし、reload直後はbrowser scope `initializationBarrier`をawaitしてからfallbackする。未binding fallbackで`getKnownBrowserViews()`全体は使わない。
- 新規bindのペイン候補はbrowser scopeとterminal scopeが一致するものだけに絞る。`pending`中は別スペースへ推測せず、再試行可能なエラーを表示する。ただし既にbindingがある行はscope不一致でも管理用に表示し、unbindは許可、bind/rebindだけを無効化して理由を示す。
- scope filterはbinding modelの共通APIへ集約し、モーダルダイアログだけでなく「Share Browser Page with Terminal Pane」のQuickPick経路にも適用する。別入口からcross-scope bindを試せないようにし、最終的なbind本体でも同じ検証を繰り返す。描画後のscope変化で最終gateが拒否した場合、Dialog/QuickPickはPromise rejectionを捨てずlocalizedな再試行案内を表示する。
- 既存bindingは単なるスペース切替では破棄しない。非表示スペースのAgentも、そのスペースに属するBrowserViewを継続操作できる。
- ユーザーがBrowserViewを共有化した後のbindはRenderer内でtoken単位に直列化する。definiteなcommit前失敗では最新binding一覧を再確認し、同じpageのbindingが0件の場合だけ共有状態をrollbackする。commit応答喪失はoutcome unknownとして扱い、成功有無を確認できないまま共有解除しない。
- terminalまたはBrowserViewのstable scopeが実際に変更された場合だけ、保存済みscopeとの一致を再検証し、`unbindIfCurrent(token, generation)`で当該世代だけを解除する。一時的な`pending`、park/unpark、Renderer reloadでは解除しない。BrowserView破棄時の既存generation付きreconcileも維持する。
- backendの配送は引き続きexact tokenと単一targetIdを使い、アクティブページ推測を行わない。

## ウィンドウ所有権

- shared processはRenderer manifestの全entryから、PID有無に関係なく`token → windowCtx` owner台帳を持つ。shell PID台帳とは分離し、complete/incompleteとRenderer connection leaseはUnit 1と同じ規則で更新する。
- owner/scope manifestはconnection単位のobject identityで保持する。旧Rendererの遅延sync、prepare、commitは現行connection leaseと一致しなければ拒否し、同じ`window:<id>`文字列だけでは新世代を上書きできない。
- 新Renderer connection登録時に旧connectionのauthority eligibilityと未使用prepare ticketを同期的に失効させる。channelはprepare/commit/unbind等へconnection objectを渡し、serviceは呼出開始時だけでなくawait後/commit時にもobject identityを検証する。
- 新Renderer connectionは最初のauthority manifestがatomic acceptされるまでprepare不可とする。token owner lockはreload越しに維持するが、旧manifestを新connectionのauthorityとして流用しない。
- cross-windowのtoken owner上書きは禁止する。owner設定は未所有または同じ現行windowからの更新だけを許可し、別windowのincomplete/delayed manifestは既存ownerを奪えない。所有移転は旧ownerのauthoritative `complete: true` snapshotでtoken消滅が確定した後、またはElectron Mainのwindow destroyが確定した後だけ許可する。競合中は両windowへのfallbackをせずretryable errorにする。
- manifest内にcross-window token競合、duplicate token/view、invalid scope/revision、件数・文字列長上限超過が1件でもあればrevision全体をatomic rejectし、部分適用・成功ackを行わない。parserは型coercionを行わず、revision/window IDをsafe integer、token/pageId/stateKeyを上限付き非空文字列として厳密検証する。競合manifestは保留・自動昇格せず、旧owner解放後も新owner側の新revision再同期を必須にする。
- `bind(windowCtx, token, pageId, ...)`はtoken ownerが同じ現行windowCtxであることを必須にする。owner未同期・別window owner・retired windowは拒否し、既存bindingや他windowへfallbackしない。
- Renderer channelのtoken系mutation/list（unbind、conditional unbind、terminal exit、status acknowledge/list、seen token listを含む）は現行connectionとtoken owner windowを検証し、別windowのtoken状態を参照・変更できない。Main/mobile内部の直接service APIとは分離する。
- legacy public `bind`は削除または常時拒否し、binding生成経路を`prepareBind → commitBind`だけにする。旧`syncPaneShells`もauthority syncへ置換し、互換用に残す場合は現行connectionからのPID補完だけに限定してowner・scope・retire・bindingへ作用させない。
- electron-mainはBrowserViewの`owner.mainWindowId`を返す検証APIを持つ。shared processはbind時に`window:<id>`とview ownerを照合し、内部bindingへowner window IDとexpected targetIdを固定する。
- 入力配送時にもelectron-mainでexpected window ID、view ID、targetId、同一BrowserView instanceを照合する。同名stateKeyを持つ別windowや同じviewIdを再利用した別windowへ配送しない。
- electron-mainはBrowserView instance生成時のopaque leaseを持ち、bind prepareでwindow ID/targetIdと一緒に返す。binding後のvisibility、screenshot、backgroundThrottling、focusless inputもすべて`windowId + viewId + targetId + opaque lease`の同じexact検証APIを使う。viewId再利用後の別instanceへcaptureやthrottling変更を流さず、unbind時のthrottling復元も旧exact instanceにだけ適用する。
- background throttlingのbinding参照数も`pageId`単独ではなく`windowId + viewId + targetId + opaque lease`のexact identity単位で数え、commit成功後にだけ無効化し、最後のexact binding解除後にだけ同じ旧instanceへ復元する。

## フォーカス非干渉入力

- browser-level CDP proxyの対象primary page sessionとpage-level `/devtools/page/<targetId>`の両方で`Input.*`を識別し、同じmain配送境界へ入れる。解決できないroot/child sessionの`Input.*`はraw upstreamへ流さず明示拒否する。
- methodとparamsをelectron-mainへ送り、同じviewIdから解決した対象BrowserViewの`BrowserViewDebugger.sendCommandRaw(method, params)`でroot pageへ実行する。upstream CDPのsessionIdはElectron debugger側のsessionIdではないため渡さない。
- mouse、keyboard、insertText、IME composition相当、touch、dragを同じ境界で処理する。
- ユーザーがフォーカスしているwebContents、active editor、terminal selectionを変更しない。
- 操作後にフォーカスを戻す方式は採用しない。
- CDPのtrusted keydownはBrowserView preloadの`vscode:browserView:keydown`とmainの`before-input-event`からworkbench keybindingへ転送され得る。`BrowserView`にautomation input境界を設け、該当`Input.dispatchKeyEvent`の実行中と遅延到着する一致key eventだけ`onDidKeyCommand`転送を抑止する。Webページ自身への入力は止めず、通常のユーザーkey eventは抑止しない。
- automation key抑止は各`Input.dispatchKeyEvent`ごとに一意sequenceを発行し、canonical `type`、key/code、location、ElectronとCDP間で正規化したmodifier bitset、autoRepeatを照合する。CDP `rawKeyDown`/`keyDown`とElectron/DOM `keydown`はcanonical `keyDown`へ正規化し、`keyUp`/`char`は別typeのまま扱う。Mainは現在のmain/subframe全preloadへinactiveな期待signatureをIPC通知し、送信対象frame全件の登録ackとframe集合不変を確認する。その後もexact identityとuser focusを再検証してからpreloadをactivateし、全frameのactivate ack後にもう一度identity/focusを検証して、Main側期待値の同期commitとCDP送信を同じturnで行う。未ready・detach・navigation中のframe、ack失敗、user-focusedなpreloadは入力を送らずretryableにする。preloadの`keydown`はactiveな完全一致sequenceかつdocumentがuser-focusedでない場合だけ1回消費して`preventDefault()`/`stopPropagation()`/workbench IPCを行わず、ページのイベント処理を維持する。focus時はElectron Mainのauthoritativeな`webContents` focus eventがMain期待値を失効させ、全preloadへcancelを送る。preloadはtrustedなwindow focusだけをlocal fail-safeとして受理し、cancel到着前もdocument focus中の一致eventを消費しない。Mainのpreload IPC受信と`before-input-event`もcommit済みの同じsequenceを経路ごとに1回だけ抑止し、hidden/crashed用の`preventDefault()`と`onDidKeyCommand`を行わない。sequenceは未到着のもう一方の経路を待つためcommand完了後250msまで保持するが、各経路の消費済みflagは戻さないため、その後の同一signature user keyは通常どおり即時転送する。Main/preload各最大32件、view破棄/debugger detach/navigationで全破棄する。TTLだけ・key文字だけの広い抑止は行わない。
- BrowserViewのwebContentsがユーザーフォーカス中は、同一signatureの実入力と合成入力を完全識別できないため、keyboard/insertText/IME系automationをmain送信前にretryable拒否する。agentが操作を継続するにはユーザーがそのBrowserViewからフォーカスを外す必要がある。送信commit後にuser focusが入った場合も、同一物理キーの誤抑止を避けるためcommit済み期待値を即時失効させる。このfocus invalidationはcompletion後TTLより優先し、送信直後の狭いraceで遅延automation keyを抑止できない可能性よりユーザー入力を優先する。mouse/touch/dragもページ上の実ユーザー操作と競合し得るため、focus中は同じく拒否し、ユーザー操作保護を優先する。
- shared processはbinding解決時のexpected DevTools targetIdもmain IPCへ渡す。electron-mainは`Input.*`以外を拒否し、送信前後で同じBrowserView instanceが現行かつtargetId一致であることを確認する。viewIdが再利用されても新しいページへ配送しない。BrowserView固有debuggerで表現できないmethodは、`webContents.focus()`やupstream転送へfallbackせず、method名と`PARA_BROWSER_RETRYABLE`理由を含むCDP errorを返す。
- exact descriptor単位に共有入力キューを1本持ち、各entryへbinding object/generationとexpected targetを固定して、browser-level/page-levelの両WebSocketから同じキューへ投入する。rebindでgenerationが変わっても旧entryを別queueで追い越さず、旧entryのdrain後に新authorityを再検証する。実行中を含め最大256件、serialized paramsは1MiBまで、各main IPC timeoutは5秒とする。mouse down/move/up、key down/up、IME composition、drag/touchの全route横断順序を維持し、上限超過・過大paramsは明示的なretryable errorとする。
- 同一connectionでInput受信後に来た非Input commandは、そのInputがcommit/errorになるまでbarrierの後へ並べ、`Runtime.*`やsnapshotが操作結果を追い越さないようにする。非Input同士の既存順序は変えない。connection close時はそのconnection由来の未実行entryを明示errorで破棄し、別connectionのentryは継続する。
- shared processは入力のqueue投入時と実行直前にbinding object/generation・session→target対応・接続leaseを確認し、main IPCの完了後にも同じauthorityを確認する。electron-mainも送信直前のopaque focus authorityを保持し、応答後に同じobjectであることを確認するため、送信中のfocus→blurも成功扱いしない。main IPC送信直前をcommit pointとし、それ以前のoverflow・close・generation変更は`PARA_BROWSER_RETRYABLE`、送信後のtransport失敗・5秒timeout・identity/focus authority変更は副作用実行済みの可能性を示す`PARA_BROWSER_OUTCOME_UNKNOWN`をCDP errorとして返す。Mainが送信前に確定できたfocused/identity/allowlist/preload-ack拒否だけは、IPC応答後でもretryableとして返す。late completionはdrainして成功応答せず、upstreamや別ページへfallbackしない。
- focusless main配送はページ操作に必要な`Input.dispatchKeyEvent`、`Input.insertText`、`Input.imeSetComposition`、`Input.dispatchMouseEvent`、`Input.dispatchTouchEvent`、`Input.dispatchDragEvent`だけをallowlist化する。`Input.setIgnoreInputEvents`等の状態変更methodと未知の`Input.*`はmethod名を含むretryable errorで拒否する。
- 実装前に隔離したCode OSS実行で、Electron debuggerへの直接keyboard/mouse/touch/IME入力が可視・非表示BrowserViewへ届き、workbenchのfocused webContentsとterminal/IME入力面が変わらないことを確認する。成立しなければfocus fallbackは追加せず、この設計単位を再検討する。

## エラー処理

- scope不一致のbindは候補選択段階で防ぐ。rendererからbackendへterminal/browser双方のdiscriminated scopeを送り、一致しない要求をbackendでも拒否する。`pending`は安全側で拒否し、管理外ワークスペースの`unscoped`同士だけは許可する。
- token owner未同期、window owner不一致、view owner/target identity不一致はretryable errorとし、別window・別ページへfallbackしない。
- park/unpark中の一時的なrenderer状態はtoken退役につなげない。
- 対象BrowserView破棄、debugger detach、unsupported inputは他のペインへfallbackしない。
- 入力エラーはユーザーの現在フォーカスを維持したままLLMへ返す。

## 検証

- 2スペースに通常・editor・background・park中panel・park中editor terminalを作り、全tokenがmanifestとbinding UIへ残る。
- detach/reattachで同じtokenを持つ旧・新instanceが重なる間も、現行instanceだけがPID/UIに現れる。
- backgroundへ移したterminalのscopeがactive space切替で変わらない。
- park/unparkだけではbinding generationが変わらず、実際のdisposeでは該当tokenだけが退役する。
- スペース切替後も各tokenが元のBrowserViewだけを操作する。
- 未bindingダイアログが別スペースのBrowserViewを選ばない。
- scope不一致・`pending`のbindingをRendererとshared processの双方が拒否し、管理外の`unscoped`同士は従来どおり利用できる。
- 同じstateKeyを持つ2ウィンドウ間でtoken/pageIdを交差させてもbindと入力を拒否する。PID未確定tokenにもwindow ownerが付く。
- Window Bのincomplete/delayed manifestへWindow Aのlive tokenを混ぜてもownerを奪えず、Window Aのauthoritative complete snapshotまたはwindow destroy後だけ移転できる。
- legacy `bind`とowner/scope/retireへ作用するlegacy manifest経路を拒否する。Window BからWindow Aのtokenをlist/unbind/retire/ackできず、Main/window-destroyの内部cleanupだけが専用APIでowner checkを迂回できる。
- 新Renderer connection登録直後から最初のaccepted manifest前、Main descriptor await中のconnection置換・scope/revision変更、同一epochの並行ticket逆順commit、ticket再利用・期限切れ・上限超過をすべて拒否する。
- terminal exit通知が失敗しても、shutdown/reload外の次のauthoritative complete snapshotで消滅tokenとbindingを回収する。
- mouse、keyboard、insertText、touch、dragの前後でfocused webContentsが変わらない。
- mouse down/move/up、key down/up、IME compositionを連続送信してもelectron-mainで受信順が逆転せず、キュー上限超過時にupstreamや別ページへfallbackしない。
- browser-levelとpage-levelの別WebSocketから同じbindingへ同時入力してもgeneration/target共有キューで順序が一意になり、直後の`Runtime.*`/snapshotが未完了Inputを追い越さない。commit後のgeneration変更はoutcome-unknownとして報告する。
- modifier key、Escape、function keyをCDP送信してもworkbench command/keybindingが発火せず、ページ側には届く。通常のユーザーshortcut転送は維持する。
- browser-levelとpage-levelの双方で`Input.*`が同じnon-focus配送・lease・owner検証を通る。
- terminalでIME変換中にMCP入力を実行しても、変換確定・キャンセル・文字誤配送が起きない。
- BrowserView破棄・同じviewIdでの再生成と同時の入力が別ページへ流れない。
- BrowserView破棄・同じviewIdでの再生成と同時のvisibility/screenshot/backgroundThrottlingが新instanceへ流れず、旧bindingのtargetIdを新しいtargetへ再解決しない。
- renderer再起動後にpark中を含む台帳が再構築される。
- renderer/app再起動後もinactive scopeのBrowserViewが元のstateKeyを保持し、現在scopeへ一括再tag・誤unbindされない。ユーザーcloseとscope retireでは保存mappingが削除される。
- browser scope storageの壊れたJSON、重複viewId、scope retire、shutdown中dispose、reload直後に遅れて現れるinactive viewをそれぞれ検証し、初期化barrier完了前の未知viewは`pending`になる。
- scope retireが初期化barrierより先に起きても、遅延snapshotのviewIdはtombstoneで破棄され現在scopeへ復活しない。storage `absent`/`corrupt`時のinactive初期viewはcontextual所属を推測せず`pending`を維持する。

## レビュー境界

ペイン台帳、scope binding、focusless inputを個別にレビューし、最後に複数スペース統合レビューを行う。Critical/Important指摘を解消するまで次の設計単位へ進まない。
