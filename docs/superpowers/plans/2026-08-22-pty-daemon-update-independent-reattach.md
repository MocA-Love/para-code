# 常駐ターミナルを、更新と SSH をまたいで繋ぎ直せるようにする

2026-08-22 調査。実装前の設計。ここに書いた事実はすべてソースを読んで確認したもので、
確認できなかったことは「未確認」と明記してある。

## 目的

1. **Para Code を更新しても、走っているターミナルに繋ぎ直せる**
2. **SSH 先でも同じことができる**

いまはどちらもできない。1 は常駐のソケット名にビルドを混ぜてあるため、更新すると新旧が
別の名前になって出会えない。2 は pty を REH サーバーの中が持っており、サーバーがコミット
ごとに配布されるため、更新すると別のサーバーが入って古い方に取り残される。

## 壁の正体は「ビルド鍵」ではなく「面積」

ソケット名にビルドを混ぜたのは、混線を検知するためではなく**起こさないため**だった。理由は
1つで、ソケットの向こうに `IPtyService` を丸ごと置いていること。

```
IPtyService のメソッド数 = 42
  createProcess attachToProcess detachFromProcess shutdownAll listProcesses …
  serializeTerminalState reviveTerminalProcesses refreshProperty updateProperty …
```

この 42 個には `ISerializedTerminalState` や `IProcessDetails` のように VS Code の内部表現を
そのまま運ぶものが含まれる。**42 個は凍結できない。** だから新旧を出会わせない、という判断は
当時として正しかった。

なお「upstream がこの面をどれくらい変えるか」は、**このリポジトリからは測れない**（履歴が
fork 起点の 2026-07-01 から。upstream 取り込みは 1.130.0 の 1 回だけ）。その 1 回で
`platform/terminal/common/terminal.ts` に入った変更は次の 1 行だけだった。

```
+	CommandCode = 'commandcode',
```

enum の追加で後方互換。データ点が 1 つしかないので「滅多に変わらない」とは言い切れないが、
少なくとも毎回壊れるものではない。

## 分割線は `ITerminalChildProcess`。`IPtyService` ではない

調査でいちばん効いたのがここ。**`IPtyService` の 1 段下に、ずっと薄い面がある。**

```
ITerminalChildProcess のメソッド数 = 13
  start shutdown input sendSignal processBinary resize clearBuffer
  acknowledgeDataEvent setUnicodeVersion getInitialCwd getCwd
  refreshProperty updateProperty
```

13 個のうち **11 個は pty に対する原始的な操作**で、VS Code の状態を運ばない。直列化も
revive もレイアウト情報もここには出てこない。

残る 2 個、`refreshProperty` と `updateProperty` は別で、**`IProcessPropertyMap` という
VS Code の型を運ぶ**（`IShellLaunchConfig` / `TerminalShellType` /
`ShellIntegrationInjectionFailureReason` などを含む）。しかも 1.130.0 で 1 行増えたのは
**まさにこの enum** だった。ここを常駐へ通してしまうと 42 個のときと同じ問題が戻る。

調べたところ、**この 2 個は常駐を越える必要が無い**。11 種類の property を1つずつ見ると、
出どころは次の 3 つしかない。

- **pid から引けるもの** — `Cwd` / `InitialCwd` / `Title` / `ShellType` / `HasChildProcesses`。
  常駐とアプリ側は常に同じ機械の上に居るので、pid さえ分かればアプリ側で引ける
  （`list()` が pid を返す）
- **もともとアプリ側の状態** — `FixedDimensions` / `OverrideDimensions`
- **注入の結果** — `ResolvedShellLaunchConfig` / `UsedShellIntegrationInjection` /
  `FailedShellIntegrationActivation` / `ShellIntegrationInjectionFailureReason`。
  注入をアプリ側へ寄せる（後述）ので、**結果も最初からアプリ側にある**

つまり property の面は丸ごとアプリ側に残せる。**常駐へ渡すのは 11 個だけで、そこに VS Code の
型は 1 つも出てこない。** これが凍結できる根拠で、「たぶん変わらないだろう」という見込みでは
ない。

そして node-pty を持つ具象クラスの生成点は、**リポジトリ全体で 1 箇所しかない**。

```
src/vs/platform/terminal/node/ptyService.ts:353
	const process = new TerminalProcess(shellLaunchConfig, cwd, cols, rows, env, executableEnv, options, …);
```

`ITerminalChildProcess` に準拠した新実装を新規ファイルに書き、この 1 行だけを差し替える。
CLAUDE.md が繰り返し勧めている形（ターミナル 2D グリッドと同じ）にそのまま乗る。

## どこに何を置くか

| もの | 置き場所 | 理由 |
| --- | --- | --- |
| node-pty の子プロセス | **常駐** | これが生き残らなければ意味が無い |
| 切れている間の出力（輪バッファ） | **常駐** | アプリが落ちている間に出た分は、常駐しか受け取れない |
| cols/rows | **常駐** | pty の状態そのもの |
| 不透明なメタデータ | **常駐** | 預かってそのまま返すだけ。**常駐は中身を読まない** |
| シェル統合の注入 | アプリ | 後述。**ここが設計の要** |
| 環境変数コレクションの解決 | アプリ | すでにアプリ側（`terminalProcessManager.ts:488`）。`createProcess` には解決済みの env が届く |
| 題名・cwd・子プロセスの有無・シェル種別 | アプリ | どれも pid から引ける。常駐とアプリは常に同じ機械の上に居る（後述） |
| `refreshProperty` / `updateProperty` の面 | アプリ | 上記のとおり全 11 種類がアプリ側で作れる。**常駐へ通さない** |
| `PtyService` / `PersistentTerminalProcess` | アプリ | 台帳・猶予時間・孤児の問い合わせ・レイアウト情報はすべて作り直せる |
| serialize / revive | アプリ | 常駐とは無関係。今のまま |

### シェル統合の注入をアプリ側へ寄せる（要）

いま `getShellIntegrationInjection()` は `TerminalProcess.start()`（`terminalProcess.ts:211`）
から呼ばれている。**つまり pty を持つ側が注入している。**

このまま常駐へ持っていくと、常駐がシェル統合のスクリプトを抱えることになる。すると
**スクリプトを出す側（常駐）と、その OSC を読む側（アプリ）が別々に更新される**。両者が
ずれたときに壊れ方が読めないので、これは避ける。

アプリ側が注入を済ませ、**解決し切った `{ file, args, env, cwd }` を常駐へ渡す**。常駐は
渡されたものを起動するだけになり、スクリプトはアプリの中に留まる。読む側と出す側が
常に同じビルドから来ることが保証される。

## 凍結する protocol

```
hello(protocolVersion, clientProof) -> { protocolVersion, daemonPid }
list()                              -> [{ handle, pid, cols, rows, alive, metadata }]
spawn({ file, args, env, cwd, cols, rows, metadata }) -> handle
attach(handle, sinceSeq)            -> { frames: [{ cols, rows, data }], seq }
input(handle, data)
resize(handle, cols, rows)
setMetadata(handle, metadata)
kill(handle, signal?)

setLayout(scopeId, layout)          # layout も不透明
getLayout(scopeId)                  -> layout
```

`metadata` は常駐にとって**ただのバイト列**。`workspaceId` / `icon` / `title` / `fixedDimensions`
のような、増えたり形が変わったりするものは全部ここに入れる。**常駐が読まないものは、形が
変わっても壊れない。** これが「確実」の中身で、運用上の約束ではなく設計上の性質。

リプレイの形（`{ cols, rows, data }` の並び）は既存の `TerminalRecorder` がすでにこの形で
持っている（`RecorderEntry { cols, rows, data: string[] }`, 104 行）。作り直しではなく、
**常駐側へ移すだけ**で足りる。

### レイアウト情報も不透明にできる（確認済み）

タブと分割の配置は、いま `PtyService._workspaceLayoutInfos` が持っている。`PtyService` を
アプリ側へ動かすと、**アプリを再起動したときにここが消える**。今それが消えないのは、
pty ホストが常駐として生き残っているからで、分割線を動かすと前提が変わる。

調べたところ、これは不透明にできる。

- `setTerminalLayoutInfo(args)` は `args` を **workspaceId で引けるようにしまうだけ**（1行）
- 中身は id の並びで、`IProcessDetails` は含まれない
- `getTerminalLayoutInfo()` が読み出し時に id を `IProcessDetails` へ**展開している**

つまり**しまうのは常駐、展開はアプリ**に分けられる。展開側だけが VS Code の型を知っていれば
よく、常駐はバイト列を預かるだけで済む。

新しい版を足すときは省略可能な項目の追加だけにする。`hello` で版を突き合わせ、相手が
自分より新しい／古い場合の扱いをそこで決める。

## 実装の山は「生きているターミナルを引き取る」

ここが唯一、今のコードに対応物が無い部分なので、見積もりはここに集中する。

アプリを起動し直すと、アプリ側の `PersistentTerminalProcess` は消えている。一方で常駐は
ターミナルを抱えたまま生きている。したがって**常駐の `list()` から、アプリ側の器を作り直す**
必要がある。

似て見えるが `reviveTerminalProcesses` は使えない。あれはバッファの文字を復元して
**シェルを起動し直す**もので、走っているプロセスは死ぬ。引き取りは、走っているプロセスに
**繋ぎ直す**別物になる。

## SSH

差し替え口はローカルとまったく同じで、**しかも 1 行**。

```
src/vs/server/node/serverServices.ts:256
	const ptyHostStarter = instantiationService.createInstance(NodePtyHostStarter, {...})
```

さらにここは**すでに PARA-PATCH 済みの領域の中**（猶予時間の調整で触ってある）。
契約も小さい（`IPtyHostConnection = { client, store, onDidProcessExit }` の 3 つだけ）。

リモート側は**ローカルより簡単**になる。ローカルは Electron のサンドボックスがあるので
MessagePort の橋渡しプロセスを挟んでいるが、リモートは素の Node なのでソケットへ直接繋げる。
橋が要らない。置き場所・台帳・名乗り合い・終了方針はそのまま流用できる。

「アプリ側」＝ REH サーバーはリモート上に居るので、**常駐とアプリ側は常に同じ機械の上**に居る。
pid から cwd や題名を引く処理がそのまま成立するのはこのため（ローカルも同じ）。

### 必ず踏む落とし穴

- **systemd の `KillUserProcesses`。** 既定で有効な配布物では、SSH を切った瞬間に切り離した
  常駐ごと殺される（tmux が落ちるのと同じ現象）。`loginctl enable-linger` か
  `systemd-run --user --unit=` が要る。**あとから足せないので設計に織り込む。**
- **`XDG_RUNTIME_DIR` は使えない。** 最後のセッションが終わると消える。置き場所は
  `~/.para-code-server/ptyDaemon/`（0700）。
- **常駐は REH より長生きさせる**ので、REH のバンドルに相乗りしない。自分の Node と node-pty を
  `~/.para-code-server/ptyd/<protocol版>/` に持たせ、protocol 版でだけ入れ替える。

## 決めなければならないこと: 閉じている間、プログラムを走らせ切るか

調査の途中で、**いまの常駐は「本当の意味では走り続けていない」**ことが分かった。仕様として
記録しておく（実装前に方針を決める必要がある）。

フロー制御は `TerminalProcess` にあり、**アプリが受け取ったと言ってきた分だけ**先へ進む。

```
terminalProcess.ts:325  _unacknowledgedCharCount += data.length
                 :326  未確認が HighWatermarkChars を超えたら ptyProcess.pause()
```

その `acknowledgeDataEvent` はアプリ（xterm.js の書き込み完了）から来る。そして未確認分を
帳消しにする `clearUnacknowledgedChars()` の呼び出し元は、**アプリが繋ぎ直したときの
`triggerReplay()` ただ1箇所**しかない。

つまり **アプリを閉じている間、誰も「受け取った」と言わない。** 出力が高水位（いまは
100万文字 = 約1MB）に達した時点で pty が止まり、**プログラムは書き込みでブロックして
待つ**。戻ってくるまで進まない。何も失われないが、走り続けてもいない。

常駐にすると、ここは選べるようになる。

- **(a) 今と同じ** — 誰も見ていない間は高水位で止める。**1文字も失わない**代わりに、
  長いビルドは途中で待つ
- **(b) tmux と同じ** — 誰も繋いでいない間は常駐が代わりに受け取ったことにし、輪バッファで
  吸う。**プログラムは走り切る**代わりに、古い出力からこぼれる

**決定: (b) を採る**（2026-08-22）。閉じている間もプログラムは走り切る。

つまり常駐は、**誰も繋いでいない間だけ自分で受け取ったことにする**。輪バッファが一杯に
なったら古い方からこぼす。繋がっている間は今までどおりアプリの ack をそのまま pty へ通し、
代理はしない（見ている相手が追いつけないのに流し続ける理由は無い）。

こぼれ得ることは、繋ぎ直したときに**画面へ出す**。黙って歯抜けの画面を見せない
（`attach` が返す `seq` と要求した `sinceSeq` を比べれば、こぼれたかどうかは常駐側で分かる）。

## リスクと未解決

- **フロー制御は素通しできる（確認済み）。** `acknowledgeDataEvent` は 11 個の原始的操作の
  1つなので、アプリ → 常駐 → pty とそのまま流せる。上の (a)/(b) は、常駐が
  「誰も繋いでいないときに代理で ack するか」という 1 点の違いになる。
- **常駐が抱えたまま更新した直後の 1 回**は、アプリ側に器が無い状態から引き取ることになる。
  ここが最も壊れやすい経路なので、実機での確認を最優先にする。
- **Windows は現在も無効。** 名前付きパイプは機械全体の名前空間で、なりすましの検証手段が
  libuv に無い（`NOTES.md` に調査済み）。この設計でも Windows は別途。
- **upstream が `ITerminalChildProcess` を変えたとき**は protocol も変える必要がある。42 個より
  ずっと変わりにくいはずだが、これも upstream 側の履歴が無いので**未確認**。

## 段取り

1. protocol を確定して凍結する（この文書の「凍結する protocol」を仕様として固める）
2. `ITerminalChildProcess` 準拠の新実装を新規ファイルに書き、`ptyService.ts:353` の 1 行を差し替える。
   常駐側に node-pty と輪バッファを持たせる
3. シェル統合の注入をアプリ側へ寄せる
4. 「生きているターミナルの引き取り」を作る。ここで初めて更新をまたげるようになる
5. リモートへ配る。差し替えは `serverServices.ts:256` の 1 行。`enable-linger` を含む寿命管理を
   最初から入れる

1〜4 がローカル、5 が SSH。**4 まで来れば 5 は差し替え口 1 行と配布経路の追加**で、
実体は同じものになる。
