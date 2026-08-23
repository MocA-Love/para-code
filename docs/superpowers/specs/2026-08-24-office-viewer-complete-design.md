# Office Viewer / Diff 完全対応設計

作成日: 2026-08-24  
対象基点: `origin/main` (`d254b26541e`)  
実装ブランチ: `feat/office-viewer-complete`

## 1. 目的

Para Code の Excel 表示、Excel Diff、Word 表示、Word Diffについて、既知の書式・構造・差分の欠落を解消する。ブラウザで完全描画できない、または安全に実行してはいけない要素も無言で消さず、種類・場所・fingerprint・理由を表示する。

調査根拠は次の2成果物と現行コードである。

- `docs/report-officee.html`: 調査時点の詳細監査とA/B/C/D識別子
- `docs/report-office-mock.html`: 現行mainへ再照合した比較モックと追加監査項目

本設計における「完全対応」はMicrosoft Excel/Wordの組版・計算・マクロ実行を再実装する意味ではない。次の不変条件を満たす状態を指す。

1. 読めるOPCパッケージの全Partと全Relationshipを棚卸しする。
2. 解釈できない要素もopaque changeとして比較対象へ残す。
3. 描画不能要素はplaceholderまたはInspectorへ必ず表示する。
4. 暗号化、破損、上限到達、未解析Partを空文書や「変更なし」と扱わない。
5. マクロ、ActiveX、OLE、DDE、外部接続を実行・自動取得しない。
6. 各監査項目をコード、テスト、実機証跡の3点へ結び付ける。

## 2. 非目標

- Wordデスクトップと同じ自動改ページ・禁則・フォントメトリクスの完全再実装
- Excel数式の再計算、Pivot refresh、外部connectionの更新
- VBA、XLM macro、ActiveX、OLEの実行またはdecompile
- 外部URL、外部画像、connection sourceの自動fetch
- 署名の暗号学的検証
- 旧バイナリ形式 `.xls` / `.doc` の内容解析

非目標の要素も検出、分類、fingerprint比較、安全な案内までは実装対象に含む。

## 3. 全体アーキテクチャ

```text
File / Remote / Git / Index / Untitled
                |
         SourceSnapshot
                |
       Office Viewer Kernel
   source revision / budget / error
   bounded inventory / versioned IPC
                |
     +----------+----------+
     |                     |
Spreadsheet Adapter      Word Adapter
     |                     |
Semantic Workbook        Story / Package Model
     |                     |
Semantic Diff            Semantic Diff
     |                     |
Viewport Render Model    Docx Render Adapter
     +----------+----------+
                |
Grid / Paper / Inspector / Placeholder
```

### 3.1 Office Viewer Kernel

Kernelは形式非依存の次の責務だけを持つ。

- serializableな`SourceDescriptor`と、backend所有の`BackendSnapshot`: source種別、revision、size、stream、watch
- bounded package inventory
- error taxonomy、budget、capability、coverage
- versioned IPC、document handle、cancellation、dispose
- search、print、accessibilityの共通contract
- contentを記録しないtiming・budget・degraded telemetry

Excel/Word固有の式、表、Story、Drawing等はKernelへ入れない。

### 3.2 Package Inventory

`IOfficePackageInventory` は描画・意味解析より先に生成する。

- format/container: xlsx、xlsm、docx、zip、CFB encrypted等
- Part: canonical URI、content type、圧縮/展開size、raw hash、canonical hash
- Relationship: source、type、internal/external target、missing、cycle
- Feature: formula、table、pivot、chart、comment、Story、field、macro、OLE等
- Security: encryption、macro、external、embedded object、protection、signature
- Coverage: `parsed / partial / opaque / unsafe / failed / omittedByBudget`
- Budget usage: entries、展開量、最大Part、media、elapsed time

ZIP entry順、timestamp、namespace prefix、属性順、rId再採番は意味差分にしない。未知XMLはnamespace-aware canonical XML、binaryはSHA-256で比較する。

### 3.3 Versioned IPC

新しい `officeDocument/v1` channelを導入する。

- `inspect(source)`
- `open(source)`
- `getViewport(handle, locator, range)`
- `compare(original, modified, categories, cursor)`
- `search(handle, query, cursor)`
- `getRenderableAsset(handle, assetId, offset, length)`
- `close(handle)`
- `cancel(requestId)`

responseは必ずprotocol version、source revision、outcome、warnings、budget usage、timingsを持つ。旧`parseWorkbook`はcompatibility adapterとして残し、段階移行中も既存serializerとEditor IDを壊さない。

## 4. Source・ライフサイクル

`SourceDescriptor`と`BackendSnapshot`の組は次を統一する。具体的な所有境界は17.1節を規範とする。

- working tree file
- `vscode-remote`
- Git commit
- `git:index` / staged
- 片側削除
- LFS pointer
- binary working copyを取得できるuntitled

解析開始時と公開時にrevisionを比較する。watcher更新、remote connection epoch変更、input切替では旧requestをcancelする。generation tokenだけでなくsource revision一致を公開条件とする。

LFSはpointer signatureを検出し、Git履歴側ではoid/sizeをopaque semanticとして比較する。`.git/lfs/objects`直読、smudge、network downloadは行わない。working treeが実体bytesを提供する場合だけ通常解析する。片側削除はerrorではなくside-missing snapshotとしてDiffへ渡す。

## 5. Excel設計

### 5.1 Semantic Workbook Model

Diffの正本はCSSや表示文字列ではなく`WorkbookSnapshot`とする。

- workbook: date system、calc settings、defined names、properties、protection、external refs
- sheet: identity、name、order、state、tabColor、views、freeze/split、RTL
- row/column: size、hidden、custom、bestFit、outline、collapsed、style
- cells: sparse chunks、merge、validation、CF、hyperlink、comment
- objects: drawing、image、chart、table、pivot、slicer、sparkline
- print: area、titles、breaks、page setup、header/footer、options
- security: VBA、signature、ActiveX、OLE、external、connection

セルは次を分離して保持する。

- stored typeとraw lexical value
- formula text/kind/ref/shared index
- cached resultのpresent/type/raw value
- style ref、numFmt ID/code/source、direct style、protection
- rich text、hyperlink ref、comment ref、validation refs

空セル、空文字列、数値`1`、文字列`"1"`、式結果`1`、cache無しを別物にする。

### 5.2 ExcelJSとOOXML

ExcelJSは基本セル、既存style、merge等のbest-effort projectionとして残す。raw worksheet XML、styles、shared strings、theme、relsを正本として欠落を補う。

regexによるXML解析は新規では増やさない。DTD/entityを無効化したnamespace-aware parserを使う。rendererへ任意XMLや任意SVGを渡さず、Node側でtyped primitiveへ変換する。

### 5.3 数値書式・条件付き書式

- 決定的なNumber Format Engineを作る。
- 1900/1904、locale token、会計、百分率、分数、指数、条件sectionを扱う。
- 数式は再計算せず、保存式・cache・cache無しを表示する。
- CF rule、sqref、priority、stopIfTrue、dxfを意味Diffする。
- 評価可能なcellIs、colorScale、dataBar、iconSetを描画する。
- 外部参照や未対応式は推測せず「rule検出済み・実効表示未評価」と示す。

### 5.4 行列・Sheet Diff

使用範囲、print area、viewportを分離し、hidden行列もsemantic modelへ残す。

- sheet matching: part identity、name、content fingerprintの一対一照合
- row/column matching: patience anchor＋bounded Myers/LCS
- budget fallbackはcertaintyを下げ、UIへ明示
- mergeは独立構造として比較
- sheet rename/order/state、行列size/hidden/group、freeze/viewを個別変更にする
- scroll同期はpixelではなく共有alignment mapの論理anchorを使う

### 5.5 Object・安全性

- Table/filter/sortは定義と範囲を表示・比較する。
- Pivotはsource/cache/field配置を表示し、refreshはしない。
- 対応chartは保存cacheまたは安全に解決できるrangeからSVG描画する。
- 3D/combo/external chart等はanchored placeholderにする。
- legacy note、threaded comment、person、hyperlink target/location/tooltipを扱う。
- VBA、signature、ActiveX、OLE、external、connectionはredact済み診断とhash比較だけを行う。

### 5.6 Excel表示性能

Node側にsnapshot handleを持ち、全Workbookをbase64で返さない。二次元virtualizationでlive DOMを約5,000〜10,000セル以下に抑える。freezeはcorner/top/left/bodyの4領域で同期し、画像は可視化時にdecodeする。

## 6. Word設計

### 6.1 二重パイプライン

Wordは意味解析と描画を分離する。

```text
DOCX bytes
  +-- Safe OPC Analyzer -> Word Semantic Model -> Semantic Diff
  +-- Render Adapter -> docx-preview / helper renderer -> DOM anchor
```

Diff engineはdocx-preview ASTやDOMを参照しない。semantic node IDからRender Adapterのanchorへ注釈する。

### 6.2 Story Model

次のStoryを区別する。

- body
- header/footer: section scopeとdefault/first/even
- footnote/endnote
- comment: anchor、body、author/date、reply/resolve
- textbox: VML/DrawingML containerとanchor
- glossary、altChunk、content control内Story

構造はSection、Paragraph、Table/Row/Cell、ContentControl、Drawing、AltChunk、UnknownBlockの木で保持する。inlineもtext、tab、break type、symbol、hyperlink、bookmark、field、OMML、revision、image、note/comment referenceへ分ける。

### 6.3 Styles・Table・List

- docDefaults、paragraph/character/table/numbering style、basedOn/link/next
- theme color/font、East Asia/CS font、embedded font metadata
- direct property、resolved effective value、provenance

style定義変更は集約した1件とし、影響nodeを関連付ける。全段落を変更件数として水増ししない。

表はgrid座標、merge、width/height、border、shading、style、RTL、repeat header、cantSplitを持つ。別表間のcross matchは禁止する。ListはnumIdではなく正規化したdefinition fingerprintで比較する。

### 6.4 Image・Math・Field・Section・Revision

画像はcontent identity、placement、presentation、sourceを分離する。同一pathのbinary差し替え、resize、crop、rotation、alt textを別変更にする。

- OMML: canonical XML fingerprint＋可能ならMathML/text projection
- Field: instruction、saved result、dirty、lockを分離。再計算しない
- Section: break、paper、margin、columns、page number、Story refs等
- Revision: ins/del/moveとproperty change、author/date/id

文書内revisionと左右文書間Diffは別レイヤーで表示する。move成立後も内容・書式・object差分を比較する。文字Diffはgrapheme cluster単位へ移行する。

### 6.5 Drawing・高度オブジェクト

- Picture/VMLは現行描画を継承
- DrawingML shape/textbox/WordArtは対応geometryをSVG化
- SmartArtは安全なflow/hierarchy近似またはplaceholder
- Chartは対応typeをSVG化し、未対応typeはseries/source付きplaceholder
- OLE/ActiveX/embedded packageは実行せず、preview画像・種類・hashだけ表示
- Macro/signatureは存在・未検証を表示
- External relationshipは自動取得しない

### 6.6 docx-preview

現行0.3.7をRender Adapterへ隔離する。手動patchをminified直接編集から再現可能なsource build＋patch queueへ移す。0.4.0は別Adapterとしてgolden比較後に切り替え、PC/mobile bundleを同一成果物から生成する。

## 7. UI設計

### 7.1 通常表示

- 「忠実描画 / 近似 / 代替N / 解析不完全」の診断リボン
- Story、Objects、SecurityのInspector
- inline/block placeholderとInspectorの相互ナビ
- semantic search
- WordのFinal/Original/Markup表示切替
- Excelのfreeze、group、comment、link、CF、chart表示

### 7.2 Diff

変更recordは次を持つ。

- category: content、formatting、structure、annotation、revision、object、security
- subject: sheet/cell/range/story/node/part
- before/after
- certainty: exact、normalized、visual、opaque
- source parts
- navigable anchor

Sheet/Story別Inspector、カテゴリfilter、変更一覧と表示markerの双方向ナビを提供する。位置不明なpackage変更もInspectorから到達可能にする。

### 7.3 No Changes条件

`No changes` / `変更はありません` は次の全条件が成立した場合だけ表示する。

- 両側source revisionが確定
- package inventory完了
- budget打切りなし
- failed/uninspected partなし
- semantic diff 0件

それ以外はdegraded/blocked理由を表示する。

## 8. 共通エラー

文字列例外ではなく構造化エラーを返す。

- Source: notFound、permission、changed、sideMissing、unsupportedScheme
- Container: invalid、encrypted、zipBomb、limitExceeded
- Format: unsupported、malformed、featureUnsupported
- Engine: libraryMissing、versionMismatch、crashed
- Transport: timeout、cancelled、disconnected、payloadTooLarge
- Render: cspBlocked、workerFailed、blank、outOfMemory
- Diff: partial、truncated、stale、sideUnavailable
- Export: printFailed、unsupported

各errorはseverity、recoverable、side、userAction、sanitized cause codeを持つ。未描画機能とbudget打切りはwarning/degradedとして扱う。

## 9. Security・Budget

初期budgetはprofile別に固定し、性能測定後に変更する。

- Desktop local: compressed 32MiB、expanded 256MiB、20,000 entries
- Remote/mobile: compressed 20MiB、expanded 128MiB、10,000 entries
- Browser: compressed 16MiB、expanded 96MiB、10,000 entries

追加制限:

- 単一Part/media、総media、圧縮比
- XML depth、node、attribute length、総文字数
- image pixel count
- relationship cycle、path traversal、duplicate part
- parse/diff time budgetとCancellationToken

DTD/entity、再帰的embedded展開、macro/OLE/ActiveX/DDE実行、外部fetchを禁止する。SVGとaltChunk HTMLはsanitize済み表示またはplaceholderにする。filenameやpackage dataをinline scriptへ直接埋め込まない。

## 10. Platform

- Desktop: shared process backend
- Remote: 新serverではremote backend、旧serverではlocal fallback＋明示warning
- Browser: Web Worker backend。未対応時は理由付きfallback
- Mobile: versioned capability negotiationとCSPを追加

現行mobileではExcel表示とExcel DiffがPC生成HTML relay、Word表示が端末内docx-preview、Word Diffが未対応である。この状態を正しくcapabilityとして表現し、段階的に共通contractへ移行する。

## 11. Search・Print・Accessibility

- semantic searchでvirtualization外、hidden range、Header、Footnote、Textboxを検索
- print専用modelからscript無しHTML/PDFを生成
- Excelはprint area/page setup、Wordはsection/saved page情報、PDFは元PDFを優先
- spreadsheetはgrid/rowheader/columnheaderとkeyboard navigation
- tabs、toggle、change listへ正しいARIA
- logical row/column count、active descendant、aria-live
- 色だけで変更種別を示さない
- high contrastとreduced motionを検証

## 12. 性能・Observability

記録するのは形式、scheme、backend、version、size bucket、part/cell/page数、各phase時間、cache/cancel/budget/degraded件数、IPC量、error codeである。本文、セル値、filename、path、connection secretは記録しない。

目標:

- 初期IPC payload 2MiB以下
- cancel観測250ms以内
- 小文書のfirst usable paintを現行比10%以上悪化させない
- Excel live DOM 10,000セル以下
- Word/PDFはpage lazy renderと遠方page破棄
- content hash＋engine version＋budget profileをcache keyにする

## 13. テスト設計

各実装は失敗テストから開始する。

- handcrafted OOXML fixture: 1 feature 1 document
- semantic snapshot golden
- canonicalization/property test
- unsupported Part sensitivity test
- diff symmetry/idempotence/count invariant
- DOM/Render Adapter contractとvisual golden
- ZIP bomb、XXE、traversal、cycle、SVG/altChunk、external URL fuzz
- lifecycle: reopen、rapid switch、watch burst、cancel、remote reconnect
- performance: 100k〜5M cells、16,384 columns、200 pages、large media
- platform: file、remote、git/index、commit、side missing、LFS、untitled
- a11y: keyboard、screen reader semantics、high contrast

実機ではPara Codeを起動し、Excel/Word通常表示・Diff、検索、印刷、Remote、Git staged、片側削除を確認する。

## 14. 実装段階とレビュー

1. 監査matrix・fixture・contract
2. Kernel・inventory・budget・error・IPC
3. Excel semantic/model/diff
4. Excel render/performance/search/print
5. Word Story/package semantic/diff
6. Word render/high-level object
7. Remote/Web/Mobile/CSP/a11y/lifecycle
8. performance、全監査close、changelog

レビューcheckpoint:

- Kernel後: API/security/budget
- Excel後: OOXML意味論/Diff/performance
- Word後: Story/render/vendored dependency
- Platform後: Remote/Web/Mobile/CSP/a11y/lifecycle
- 最終: code quality/security/architecture/regressionの4並列レビュー

実装担当とreviewerは分け、修正後は同じreviewerへ再確認する。

## 15. Git・PR

`origin/main` (`d254b26541e`) から `.worktrees/office-viewer-complete` / `feat/office-viewer-complete` を作成済みである。ローカルmain固有のOffice無関係commitと他の未追跡物は含めない。

段階ごとに独立review可能なcommitを作る。main更新とのconflictが発生した場合は勝手に解消せずユーザーへ確認する。全実装・検証・最終レビュー後にpushし、main向けDraft PRを作成する。

PR本文には監査項目ごとのcommit、test、実機証跡、性能比較、safe fallback、review結果を記載する。

## 16. 完了条件の概要

製品としては、全監査項目の分類、silent omissionの排除、安全なplaceholder、検証Gate、review checkpointを満たしたときだけ完成とする。Git操作とPRは製品の正しさとは分離し、規範的なProduct AcceptanceとDelivery Checklistを27節に定義する。

## 17. 規範的Contract追補

この節は前節までの概念記述を実装可能なcontractへ具体化する。表現が競合する場合は本節以降を優先する。

### 17.1 Source所有権

IPCを越える`SourceDescriptor`とbackend内部の`BackendSnapshot`を分ける。

```ts
interface SourceDescriptor {
	kind: 'file' | 'remote' | 'gitCommit' | 'gitIndex' | 'workingTree' | 'untitled' | 'sideMissing';
	uri?: string;
	revisionHint?: string;
	displayName: string;
	side?: 'original' | 'modified';
}

interface BackendSnapshot {
	descriptor: SourceDescriptor;
	revision: string;
	size: number;
	openStream(): AsyncIterable<Uint8Array>;
	dispose(): void;
}
```

`SourceDescriptor`にstream、watcher、file handleを入れない。Desktop local/shared process、remote agent、Web Workerがそれぞれ`BackendSnapshot`を所有する。

- local file: local backendがfile streamを開き、前後revisionとcontent hashを確定する。
- Git commit/index: workbench SourceBrokerがGit FS providerからbounded spoolする。
- new remote server: descriptorだけをremote backendへ送り、remote側で解析する。
- old remote server: workbench SourceBrokerがremote IFileServiceから上限付きchunkでlocal spoolへ転送する。全量base64は禁止する。
- untitled: workbench SourceBrokerがbinary working copyのbytesを2MiB以下のchunkでspoolする。
- sideMissing: streamを持たない正常なDiff sourceであり、通常表示では`blocked`、Diffではadded/removed全体を生成する。

watcherはsnapshot ownerが保持する。公開時に`revisionHint`ではなくbackendが確定した`revision`を再照合する。

### 17.2 Outcome状態機械

全operationは次のoutcomeを返す。

| Outcome | 意味 | 通常表示 | Diff | No Changes |
|---|---|---|---|---|
| `complete` | 全対象を解析済み | 継続 | 継続 | 許可 |
| `degraded` | 一部をopaque/近似/上限省略 | 警告付き継続 | 警告付き継続 | 禁止 |
| `blocked` | 暗号化・hard limit等で内容解析不能 | 理由とaction | 対象sideを明示 | 禁止 |
| `sideMissing` | Diff片側が存在しない | 適用外 | 全体added/removed | 禁止 |
| `cancelled` | 利用者・新revisionで取消 | 旧inputを維持 | 旧Diffを維持 | 禁止 |
| `stale` | 公開前にrevision不一致 | 再取得 | 再取得 | 禁止 |
| `failed` | engine/transport/renderの回復不能失敗 | error UI | error UI | 禁止 |

hash未完了または途中打切りのopaque Partは`degraded`である。全bytesを読みcanonical/raw hashを確定した`completeOpaque` PartはPart coverageの一種で、document outcomeの`complete`へ集約できる。この場合は内容同一性を全bytesで確認済みのためNo Changes判定を許可するが、render outcomeにはplaceholderを残す。

`warning`はoutcomeではなく診断である。retry可能性、user action、sideは構造化errorに含める。

### 17.3 Completeness Manifest

viewport renderと全体Diffを分離する。`compare()`はviewportとは無関係に全semantic領域を走査し、pageをstreamできてもterminal manifestが確定するまで0件を確定しない。

```ts
interface CompletenessManifest {
	expectedParts: number;
	visitedParts: number;
	parsedParts: number;
	opaqueParts: number;
	failedParts: number;
	omittedParts: number;
	expectedSemanticUnits: number;
	visitedSemanticUnits: number;
	terminal: boolean;
}
```

`No Changes`条件には`terminal === true`、expected/visited一致、failed/omitted 0を追加する。変更pageが0件でもterminal前は「解析中」、degraded terminalは「検出された変更0件・判定不完全」と表示する。

### 17.4 Handle寿命とQuota

document handleは`ownerId + random nonce`で所有者を検証する。

- clientあたり同時4 handle
- backend全体のsemantic snapshot cache 512MiB
- idle timeout 10分
- memory pressure時は非active handleをLRU破棄
- editor dispose、window close、renderer crash、remote disconnectで即時close
- source revision変更で旧handleをinvalid化
- serializerはhandleを保存せずSourceDescriptorから再open

closeは冪等にする。handle leak testとbackend crash cleanup testを必須にする。

### 17.5 Asset取得境界

汎用`getBlob(partId)`は提供しない。`getRenderableAsset(handle, assetId, range)`へ限定する。

- allowlist: raster image、検証済みfont subset、sanitized SVG、生成済みchart/placeholder preview
- deny: VBA、OLE、ActiveX、signature、embedded package、connection、custom XML raw、unknown binary
- unsafe partはNode側でhash/metadata/既存previewだけを派生させる
- 1 response chunk 2MiB、asset総量はbudget内
- rangeとasset IDをbackend manifestで検証し、package pathを直接受け取らない
- external relationshipはasset APIから取得できない

### 17.6 Canonicalization

既知Partはsemantic parserの型付き値を比較する。ExcelJS/docx-previewのprojectionがraw OOXMLと異なる場合、raw OOXMLをsemantic正本とし、library値はrender diagnosticへだけ使う。

未知XMLと既知Part内の未知subtreeは次でcanonicalizeする。

- namespace URI＋local nameでQNameを表現しprefix差を無視
- 属性をQName順にsort
- `xml:space="preserve"`以外の要素間indent whitespaceを無視
- text node内の空白は変更しない
- schema defaultを推測・挿入しない
- Relationship参照属性はcanonical target identityへ置換
- Markup Compatibilityは選択したChoice/Fallbackと、非選択branchのopaque hashを両方保持
- 未知subtreeごとにSourceRefとhashを持ち、Part全体の1件へ潰さない

## 18. Word照合アルゴリズム

### 18.1 Story照合

Storyは`kind + section binding + role(default/first/even) + normalized content fingerprint`で候補化する。共有Header/Footerは実体と参照edgeを分け、内容変更とsectionからの付替えを別変更にする。

### 18.2 Tree照合

親境界を越えるmatchを禁止する。

1. Section: source orderとsectPr fingerprint、前後のunique paragraph anchorで対応付ける。
2. Table: 同一Story/Section内でgrid signature、caption/前後anchor、内容fingerprintを使う。
3. Row/Cell: 対応Table内だけでgrid coordinate、span/merge、内容signatureを使う。
4. Paragraph: 対応container内でunique stable anchor、patience diff、bounded Myersの順に照合する。
5. Run/Inline: grapheme cluster sequence、semantic node kind、format provenanceを比較する。

重複候補のtie-breakは、container内相対距離、構造signature、前後anchor一致の順とする。同点は無理にmatchせずadded/removedへ分け、certaintyを`ambiguous`にする。

moveは未対応集合でunique normalized fingerprintを持つnodeだけ候補化する。move pairを作った後に必ずcontent、format、object、whitespaceを再比較する。table間・Story間moveは独立カテゴリとし、暗黙matchしない。

### 18.3 BudgetとFallback

- Story内block candidate pair: 250,000
- 1 alignment region: 50,000 pair
- paragraph grapheme diff: 4,000,000 DP cell
- 1 paragraph: 100,000 grapheme

上限超過時はposition pairingへ黙って落とさず、unique anchorだけを確定し、残りをcoarse added/removedとして`degraded`にする。certaintyは`exact / normalized / heuristic / ambiguous / opaque / degraded`から選ぶ。

## 19. 数値化したSecurity Budget

実際に展開したstream byteを逐次加算し、ZIP headerの申告値だけを信用しない。hard limit到達時は現在entryの展開をabortする。

| 制限 | Desktop local | Remote/Mobile | Browser |
|---|---:|---:|---:|
| 圧縮入力 | 32MiB | 20MiB | 16MiB |
| 展開総量 | 256MiB | 128MiB | 96MiB |
| entry数 | 20,000 | 10,000 | 10,000 |
| 単一XML Part | 64MiB | 32MiB | 24MiB |
| 単一binary/media | 32MiB | 24MiB | 16MiB |
| media総量 | 128MiB | 64MiB | 48MiB |
| 最大圧縮比 | 200x | 150x | 100x |
| XML depth | 128 | 96 | 96 |
| XML node数/Part | 2,000,000 | 1,000,000 | 750,000 |
| attribute長 | 1MiB | 512KiB | 512KiB |
| image pixel | 100MP | 50MP | 40MP |
| inspect時間 | 30s | 30s | 20s |
| semantic parse | 60s | 60s | 45s |
| diff | 90s | 90s | 60s |

80%到達でwarning、hard limit到達で当該Partを`omittedByBudget`にする。ただしcentral directory走査自体が安全に継続できる場合は残りPartのinventoryを続ける。container全体の展開総量、entry数、圧縮比超過は`blocked`とし、内容解析を停止する。

## 20. Platform Capability Matrix

最終状態を次で固定する。`Native`は端末内、`Host`は接続中Para Code backend、`Explicit fallback`は内容を実行せず検出・案内する状態である。

| Platform | Excel View | Excel Diff | Word View | Word Diff |
|---|---|---|---|---|
| Desktop local | Native | Native | Native | Native |
| Desktop SSH/remote | Remote backend。旧serverはbounded local spool | 同左 | 同左 | 同左 |
| Web workbench | Web Worker＋browser renderer | Web Worker＋semantic Diff | Web Worker＋docx render adapter | Web Worker＋semantic Diff |
| Mobile connected | Host HTML/semantic relay | Host HTML/semantic relay | Native render＋Host diagnostics | Host semantic/render relay |
| Mobile standalone | Explicit fallback: 保存情報と安全診断のみ | Explicit fallback | Native basic view＋diagnostics | Explicit fallback: PC接続action |

Mobile standaloneのExcel/Word Diffを「変更なし」やbinary warningへ落とさず、必要なcapabilityと接続actionを表示することでclosedとする。WebはExcel/Word viewer contributionをbrowser層へ登録する。

### 20.1 対応拡張子

- full semantic parse/view/diff: `.xlsx`, `.xlsm`, `.xltx`, `.xltm`, `.docx`, `.docm`, `.dotx`, `.dotm`
- diagnostic viewer/explicit unsupported: `.xlsb`, `.ods`, `.xls`, `.doc`, `.rtf`
- macro/template形式もread-onlyで、macro/OLE等は実行しない

resolverはdiagnostic対象にも専用案内を登録し、文字化けbinary editorへ黙って落とさない。

## 21. Git Index・LFS・互換性

### 21.1 Git Index

`gitIndex`は内部`SourceDescriptor.kind`であり新URI schemeではない。既存Git extensionの`git:` FS resourceとref metadataから生成する。

- HEAD→index: staged changes
- index→working tree: unstaged changes
- repository status/index change eventを購読してrevisionを更新
- revisionはrepository root、HEAD、index checksum、path、working statから生成
- rename/deleteは旧path/new pathを持つside snapshotへ正規化

`.git`内部を直接watchしない。

### 21.2 LFS

LFS pointerを検出した場合、Git履歴側ではpointerのoid/sizeをopaque semanticとして比較する。`.git/lfs/objects`直読、smudge、network fetchは行わない。working tree側が実体bytesを提供する場合だけ通常解析する。片側がpointerなら`degraded`とし、oid変更をDiffへ出す。

### 21.3 Version Negotiation

- protocol v1 clientはv1 backendを優先
- backendがv1非対応なら旧`parseWorkbook`/既存Word pathへfallbackしwarning表示
- new backend＋old clientは旧channelを最低2リリース維持
- mobile capability handshakeにprotocol versionとfeature bitsetを追加
- serializerはSourceDescriptorとview stateだけを保存し、handleは復元時に再生成
- 旧channel廃止条件は2リリースのtelemetry、remote/mobile最小version更新、fallback利用率1%未満

## 22. Number Format・CF契約

### 22.1 Number Format

- semantic Diffはformat codeとlocale metadataを比較し、表示localeに依存しない。
- 表示はworkbook locale hintがあれば優先し、なければapplication localeを使う。
- date/timeはtimezoneを適用せずserial値として計算する。
- serial 60は`1900-02-29`互換値として特別保持する。
- built-in ID 0〜49と任意custom codeを解析する。
- positive/negative/zero/text section、condition、color、escape、quoted text、fraction、scientific、percent、accounting、date/time tokenを扱う。
- 解釈不能tokenはraw code付き`approximated`表示にし、generalへ黙って落とさない。

### 22.2 Conditional Formatting

全ruleをsemantic比較する。描画evaluationは次のsubsetを完成条件とする。

- cellIs: 全operator、relative/absolute reference
- expression: arithmetic、comparison、AND/OR/NOT、同一workbook cell/range reference
- top10、aboveAverage、duplicate/unique、containsText、timePeriod
- colorScale、dataBar、iconSet
- priority昇順、`stopIfTrue`適用

volatile function、external workbook、connection、unsupported functionを含むruleは評価せず、rule存在と`notEvaluated`理由を表示する。

## 23. Search・Print・UI Recovery

### 23.1 Search

既定検索対象:

- formatted display text、raw text、formula text
- comment/note、hyperlink display/target、alt text、placeholder抽出text
- Word body/Story/field instruction/saved result
- hidden row/sheetとnon-body Storyも対象にし、結果にlocation badgeを付ける

security metadata、connection secret、macro binary、opaque raw XMLは検索しない。検索はliteral、Unicode正規化NFC、application localeのcase-insensitiveを既定とし、match-case optionだけ提供する。結果上限10,000、page 200件、cursorはsource revisionへbindし更新時にinvalid化する。

### 23.2 Print

- Desktop: Print Modelからscript無しprint webviewを作りnative print/PDFへ渡す。
- Web: Print Modelをbrowser printへ渡す。
- Mobile connected: Host生成PDFをshare/exportする。
- Mobile standalone: supported native viewだけ印刷し、未対応はPC接続action。

Excelはprint area/page setupを使用する。Wordはsaved break/section情報を使用し、Word同等の自動改ページでないことを印刷previewに明示する。placeholderは消さず、種類と理由をboxとして印刷する。生成後のpage rangeを指定可能にする。

### 23.3 UI State・Recovery

zoom、Diff category filter、Word revision mode、active sheet/storyをeditor view stateとしてstorageへ保存する。source固有情報をglobal keyへ混ぜない。

- cancel: input epoch前のinput/view stateへ復帰
- blank detection: adapter ready後にexpected root/anchorを検査
- retry: loopback remount 1回、isolated webview再作成1回の最大2回
- 2回失敗後は`render.blank`と既定アプリ/再試行actionを表示
- service worker fallbackはviewer種別・origin・generationを検証

## 24. 単一PRの安全境界

全対応を1本のPRにすることはユーザーの明示要件である。PR分割の代わりにcommit、feature flag、shadow mode、review gateで境界を作る。

内部flag:

- `officeKernelShadow`
- `officeSemanticSpreadsheet`
- `officeVirtualizedSpreadsheet`
- `officeSemanticWord`
- `officePlatformBackend`
- `officeSearchPrint`

進行規則:

1. Kernelは既存表示を変えずshadow実行し、inventory差とbudgetだけ検証する。
2. Excel/Word semanticはdual-readし、現行結果との差をdiagnosticに限定する。
3. 各review gateと回帰test通過後に該当flagのdefaultを新経路へ切り替える。
4. 旧render/parse pathはPR内にruntime rollbackとして残す。
5. final gateで新経路をdefaultにし、旧経路は明示fallbackだけにする。
6. performance/security regression時は該当flagを戻せる。

各commitはbuild可能・test可能にし、共有contract変更とadapter変更を同commitへ混ぜない。

## 25. 合否判定可能な検証Gate

fixtureは固定seed generatorと小さなchecked-in corpusで作る。CIと実機は同じcommand・fixture hashを記録する。

| Gate | 合格条件 |
|---|---|
| Semantic completeness | inventory全Partにcoverage outcome、未分類node 0 |
| Diff invariant | A対A=0、左右反転でadded/removed反転、summary件数=detail件数 |
| Opaque sensitivity | 未知Partの1byte変更を必ず1件以上検出 |
| Canonical stability | ZIP順、prefix、属性順、rId再採番だけでは0件 |
| Visual | 基準画像との差0.5%以下。approximated領域はmaskを明示 |
| Small document | first usable paintが同一machine baselineの110%以内 |
| Large Excel | 100k cellsでlive DOM 10,000以下、initial IPC 2MiB以下 |
| Extreme Excel | 5M cells/16,384列でhard crashせず30秒以内にcompleteまたはdegraded |
| Large Word | 200 pagesでpage lazy render、offscreen page保持20以下 |
| Memory | 1 document handle 512MiB hard cap、close後5秒以内に80%以上解放 |
| Cancel | request cancelを250ms以内に観測しstale publish 0 |
| ZIP security | 各hard limit境界±1、traversal、XXE、cycle、ratio超過を期待outcomeへ分類 |
| Compatibility | new/old client/backend、desktop/remote/mobileのmatrix全組合せ |
| Accessibility | keyboard-only全操作、axe相当重大違反0、high contrastで色以外の識別あり |

性能gateはApple Silicon CI runnerのmachine ID、OS、Electron build、fixture hashを結果へ記録し、絶対時間と同一run内baseline比の両方を見る。

## 26. 用語集

| Contract enum | UI表示 | 意味 |
|---|---|---|
| `complete` | 完全に解析済み | No Changes判定可能 |
| `degraded` | 解析不完全 | 一部opaque/近似/省略 |
| `blocked` | 内容を解析できません | 暗号化・hard limit等 |
| `parsed` | 忠実描画 | semantic解析済み |
| `partial` | 近似 | 意味の一部を描画 |
| `opaque` | 代替表示 | hash/metadataのみ |
| `completeOpaque` | 全bytes比較済み代替 | analysis complete、render placeholder |
| `unsafe` | 安全上表示制限 | 実行・raw取得禁止 |
| `exact` | 完全一致比較 | raw/typed値で比較 |
| `normalized` | 正規化比較 | ID/prefix差を除外 |
| `heuristic` | 推定対応 | matching推定あり |
| `ambiguous` | 対応不確実 | 同点候補を分離 |

## 27. Product AcceptanceとDelivery Checklist

### 27.1 Product Acceptance

1. 全監査項目が実装、明示fallback、意図的非対応のいずれかへ分類され、silent omissionがない。
2. completeness manifestとNo Changes条件を満たす。
3. security budget、asset allowlist、external/macro/OLE非実行を満たす。
4. capability matrixの各cellが実装またはexplicit fallbackとして確認できる。
5. 検証Gateとreview checkpointのCritical/Importantがすべて解消済み。

### 27.2 Delivery Checklist

1. Office scope外の差分がない。
2. 段階commitとreview証跡が揃う。
3. origin/main更新を確認し、conflict時はユーザー判断を得る。
4. push済み。
5. main向けDraft PRに監査matrix、test、実機、性能、fallback、review結果を記載済み。

## 28. 基点差分の注記

調査モックはローカル`ba8ca41d118`、実装branchはGitHubの`origin/main` `d254b26541e`を基点とする。両commit間のOffice viewer、Office mobile relay、Office assetには差分がないことを確認済みであり、設計・受入条件への影響はない。

## 29. SourceBrokerと実行隔離

### 29.1 Workbench SourceBroker

Git FS provider、index metadata、untitled working copyはworkbench/extension host側の能力であり、shared processから直接参照しない。workbench側に`IOfficeSourceBroker`を置き、source kindごとの経路を次で固定する。

| Source kind | 読み取り所有者 | Backendへの渡し方 |
|---|---|---|
| local `file` | local backend | descriptor URIを受け、backendがfile streamを開く |
| `vscode-remote`＋v1 server | remote backend | descriptorをremoteへ送りremoteでopen |
| `vscode-remote`＋old server | workbench broker | remote IFileServiceからbounded chunk spool |
| Git commit | workbench broker/Git FS provider | immutable revision付きbounded spool |
| Git index | workbench broker/Git FS provider | index revision付きbounded spool |
| working tree | local/remote file owner | fileと同じ。Git metadataはdescriptorへ付与 |
| untitled | workbench broker | binary working copyをbounded chunk spool |
| sideMissing | broker | bytesなしdescriptor |

spoolは1chunk 2MiB以下、総量はplatformのcompressed input budget以下とする。VSBuffer/transferableを使いbase64化しない。brokerはstreamを読みながらSHA-256を計算し、完了後にsealed spool ID、size、content hash、provider revisionをbackendへ渡す。backendは未sealed spoolを解析しない。

spoolは`ownerId + random nonce`で所有者を検証する。clientあたり同時2 spool、backend全体8 spool、総容量はDesktop 256MiB・Remote 128MiBとする。未sealed spoolは2分で破棄し、broker/backend crash、client disconnect、cancel、seal後のopen失敗でも即時削除する。handle作成の有無にかかわらずspool quotaを適用する。

provider etag/statはhintとして使い、確定revisionは`kind + provider identity + provider revision + size + content SHA-256`とする。spool前後のetag/statが変わった場合は`stale`として破棄する。watch eventが欠落してもcontent hashで同一性を保証する。

brokerを通らないlocal fileとv1 remoteでもbackendがstream読取中にSHA-256を計算し、open前後のprovider revision/etagを再取得する。前後不一致は`stale`、一致時だけcontent hashを確定revisionへ採用する。

### 29.2 Parse/Diff Worker

untrusted documentのinventory、XML parse、ExcelJS、semantic model、canonicalization、Diffはshared process event loopで直接実行しない。

- Desktop/Remote: Node worker thread。必要な場合だけutility processへ昇格
- Browser: Web Worker
- Mobile connected: Host backend worker
- Mobile standalone:端末側のbasic render以外は明示fallback

shared processはorchestratorとhandle registryだけを持つ。workerはdocumentごと、またはmemory quotaを共有できる小さなpoolで隔離する。

Node worker初期resource limit:

- max old generation: 384MiB
- max young generation: 32MiB
- stack: 8MiB
- 同時worker: clientあたり2、backend全体4

active worker heap、semantic cache、spool、derived assetを合算したbackend memory admission budgetはDesktop 1.25GiB、Remote 768MiB、Browser 512MiBとする。cacheはworker起動前にLRU evictionし、budgetを確保できないrequestは最大30秒queueする。なお確保できなければ`blocked(limitExceeded)`とする。backend全体4 workerは上限であり、admission budgetが同時数をさらに制限する。

協調cancelはXML 4,096 node、cell 4,096件、Diff 16,384 comparisonごとに確認する。cancel要求から250msでackが無ければorchestratorがworkerをterminateする。worker終了理由は次へ一意に写像する。

- 利用者・新revisionによるcancel強制terminate: `cancelled`
- parse/diff deadline: `blocked(limitExceeded)`
- worker memory resource limit/admission timeout: `blocked(limitExceeded)`
- worker内部の未処理例外・異常終了: `failed(engineCrashed)`

worker crashはshared processを落とさず、当該workerが所有するhandleだけをinvalid化する。

## 30. Render Anchor Contract

semantic nodeとrender DOMを次の`RenderAnchorKey`で結ぶ。

```ts
interface RenderAnchorKey {
	partUri: string;
	semanticPath: readonly number[];
	kind: string;
	ordinal: number;
	fingerprint: string;
}
```

- semantic parserが全nodeへkeyとstable node IDを付与する。
- Render Adapterはsource part/path/ordinalを使ってlibrary ASTまたは生成primitiveへnode IDを注入する。
- docx-preview 0.4 adapterでは`h()` hook、0.3.7 adapterでは隔離したAST bridgeで`data-paradis-node-id`を生成する。
- 1 DOM nodeへ複数semantic nodeが統合された場合はanchor mapを多対一で保持する。
- fingerprint collisionはpart/path/ordinalで分離し、それでも衝突する場合はanchorを`ambiguous`にする。
- libraryがnodeを省略した場合は最寄りの描画済みancestorへmarkerを置き、Inspectorに元のSourceRefと「正確な位置なし」を出す。
- anchor不存在を変更消失の理由にしてはならない。全Change recordはInspectorから到達可能にする。

## 31. Coverage集約規則

analysis outcomeとrender outcomeを分離する。

### 31.1 Analysis Outcome

- required Part（Content Types、root rels、main workbook/document、参照必須Part）の`failed/omitted`は`blocked`
- optional Partの`failed/omitted/partial`は`degraded`
- unknown/unsafe Partでも全bytesを読みcanonical/raw hashを確定できた場合はanalysis上`completeOpaque`
- `completeOpaque`は内容変化検出を保証するためNo Changes判定を許可する
- hash未完了、途中打切り、参照先欠落は`degraded`
- container hard limit、暗号化、central directory不正は`blocked`

document analysisは、全Partが`parsed`または`completeOpaque`なら`complete`、optionalに`partial/failed/omitted`があれば`degraded`、required/containerが失敗すれば`blocked`とする。

### 31.2 Render Outcome

各semantic nodeを`rendered / approximated / placeholder / blockedByPolicy / noAnchor`へ分類する。analysisが`complete`でもrenderはplaceholderを含み得る。この場合No Changes判定は可能だが、通常表示に「代替表示N」を出す。

## 32. Platform別CSP・Asset Sanitization

### 32.1 CSP

Desktop Word webview:

```text
default-src 'none';
script-src 'nonce-<random>' <exact-loopback-origin>;
style-src 'unsafe-inline';
img-src data: blob: <exact-loopback-origin>;
font-src data: blob: <exact-loopback-origin>;
connect-src <exact-loopback-origin> data: blob:;
object-src 'none'; frame-src 'none'; worker-src 'none';
```

`<exact-loopback-origin>`はmount成功時だけ許す。mount失敗または`vscode-remote`のwebview resource fallbackでは、`webview.cspSource`から得た正確なworkbench resource originを`script-src`、`font-src`、`connect-src`へ追加する。広い`https:`、wildcard host、任意portは許可しない。`unsafe-inline`はdocx-previewの生成styleを使う隔離Word webviewだけに許す。Excel workbench DOMは任意script/styleを文書から注入しない。

BrowserはWorkbench Worker Service経由のworkerだけを使い、`eval`、任意blob worker、外部originを許可しない。Office preview resourceはworkbench resource originと明示的なdata/blob mediaだけを許可する。

Mobile Office WebView:

```text
default-src 'none';
script-src 'nonce-<random>';
style-src 'unsafe-inline';
img-src data: blob:;
font-src data: blob:;
connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none';
```

`originWhitelist={['*']}`を廃止する。初期`about:blank`/injected HTMLだけを許し、`onShouldStartLoadWithRequest`で外部navigation、http/https/file schemeを拒否する。外部リンクはWebView navigationではなくnative確認dialog経由で開く。

### 32.2 SVG

許可elementは`svg, g, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, defs, clipPath, linearGradient, radialGradient, stop`だけとする。`foreignObject, script, style, animation, filter, image, iframe, audio, video`を除去する。event handler属性、external href、CSS `url()`、data URL、XML entityを拒否する。fill/stroke/transform等は型付きallowlistへ正規化する。

### 32.3 Font

raw embedded fontをrendererへ渡さない。trusted local subsetterが検証・再encodeしたWOFF2だけを許可する。

- input format: TTF/OTF/WOFF/WOFF2 metadata inspectionのみ
- output: WOFF2のみ
- output最大16MiB
- tables最大64、glyph最大65,535、展開後128MiB
- SVG glyph、external reference、重複/不正tableは拒否

subsetterが利用できないplatformではembedded fontを使わず、font metadataとfallback familyを表示する。

## 33. Compression Ratio・CF値源

圧縮比上限は各entryとcontainer集計の両方へ適用する。単一entryが上限を超えた時点でcontainer全体を`blocked(zipBomb)`とし、正常entryで比率を薄めることを許さない。

CF evaluatorが参照する値は次に限定する。

- direct cell: stored typed value
- formula cell: presentなcached typed result
- blank/error:その型を保持
- cache無し、external dependency、unsupported function、循環参照: `notEvaluated`

formatted textは評価入力にしない。数式再計算は行わない。参照先に1つでも未確定値があれば当該ruleを`notEvaluated`とし、rule自体のsemantic Diffは継続する。

## 34. Runtime Kill Switch

feature flagはcompile-time定数ではなく、`IConfigurationService`とprofile storageで解決するhidden settingにする。

```text
paradis.officeViewer.engine = auto | legacy | v1
paradis.officeViewer.kernelShadow = true | false
paradis.officeViewer.semanticSpreadsheet = true | false
paradis.officeViewer.virtualizedSpreadsheet = true | false
paradis.officeViewer.semanticWord = true | false
paradis.officeViewer.platformBackend = true | false
paradis.officeViewer.searchPrint = true | false
```

product defaultはfinal gate後に`v1`とする。user/workspace JSON、管理者policy、起動引数で再buildなしに`legacy`へ戻せる。`engine=legacy`は他の全subfeature settingを上書きし、Kernel shadowを除くopen/render/diff/search/printを確実に旧経路へ戻す。`engine=v1`では個別settingを段階rollbackに使う。remoteはclientとserverの双方でflagを評価し、不一致時は安全な低いcapabilityへnegotiationする。kill switch変更は次回openから適用し、active handleを強制変換しない。

## 35. 決定的なValidation Gate

25節のGateを次で補正する。

- Opaque sensitivity: binary bytesまたはcanonical XMLが変わった場合に1件以上検出。prefix、属性順、indentだけの変更はcanonical stabilityとして0件。
- Extreme Excel: semantic parseは60秒以内に`complete/degraded/blocked`へterminal、Diffは90秒以内。30秒条件は削除。
- Memory: Nodeを`--expose-gc`付き専用runnerで実行し、close直後にhandle count 0、3回forced GC後にsnapshot由来retained object 0、heapがbaseline＋20MiB以内。
- Visual: page/sheet/object領域ごとにpixel diff 0.5%以下。required landmarkの欠落は面積に関係なく失敗。approximated/placeholder領域は明示maskごとに別goldenを持つ。

## 36. Compatibility期待値

| Client | Backend | 結果 |
|---|---|---|
| v0 desktop | v0 local/remote | legacy成功 |
| v0 desktop | v1 local/remote | 旧channelでlegacy成功（2リリース） |
| v1 desktop | v0 local | warning付きlegacy fallback、semantic completenessなし |
| v1 desktop | v0 remote | bounded local spool＋warning。対応不可ならexplicit blocked |
| v1 desktop | v1 local/remote | v1完全経路 |
| old mobile | old PC | 既存relay |
| old mobile | new PC | v0 relay compatibility |
| new mobile | old PC | capability warning、既存Excel/Word表示、未提供Diffはexplicit fallback |
| new mobile | new PC | v1 capability matrix |
| Web v1 | Worker v1 | v1完全経路 |
| Web v1 | Worker unavailable | diagnostic viewer＋explicit blocked |

Compatibility testはこの10行を個別fixture/handshake testとして実行する。
