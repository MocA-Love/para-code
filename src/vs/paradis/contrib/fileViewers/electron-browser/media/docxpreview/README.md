# Vendored docx-preview + JSZip

PARA-CODE: fork-owned directory (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

このディレクトリは npm から取得した vendored サードパーティ成果物です。Word (.docx)
ビューア（`../paradisDocxFileEditor.ts`）が webview 内で読み込み、.docx を HTML に
レンダリングします。UMD 版を classic script として読み込む方式のため、以下を使います。

- `docx-preview.min.js` — `docx-preview@0.3.7`（Apache-2.0, Volodymyr Baydalka）の
  `package/dist/` より。UMD 版。グローバル `docx` を定義し、`jszip` をグローバル
  `JSZip` として外部参照する。
- `jszip.min.js` — `jszip@3.10.1`（MIT または GPL-3.0 のデュアルライセンス。本 fork は
  MIT の下で使用）の `package/dist/` より。UMD 版。グローバル `JSZip` を定義する。
- `LICENSE-docx-preview` — docx-preview の Apache-2.0 ライセンス全文
- `LICENSE-jszip` — jszip のライセンス全文（MIT / GPL-3.0）

## docx-preview 0.4.0 compatibility candidate

0.4.0 は現行 0.3.7 を直ちに置換せず、versioned adapter と golden 比較用の候補として
固定する。PC/mobile の現行追跡成果物は、切替タスクまでは下記 0.3.7 のままとする。
0.4.0 の build metadata は次のとおり。

| 対象 | 固定値 |
|---|---|
| npm archive | `https://registry.npmjs.org/docx-preview/-/docx-preview-0.4.0.tgz` |
| archive SHA-256 | `94c336d6a1ea69d188bc95bfb4c6de55ea6414270477359ddda557d1a5bea447` |
| upstream source | `package/dist/docx-preview.min.js` |
| upstream source SHA-256 | `051ef503f2677d53159a388b7384e950eda41ea4e47a103e5e36f124d7faea40` |
| license | Apache-2.0、`package/LICENSE` |
| license SHA-256 | `8668bf4417d161e4eb4d47d6044526e4914d9eb3c748573d9bb7e87708c1253f` |
| patched PC source SHA-256 | `a60958918afcc4579216ea44637736f6ad21ae41c2ae64b6c48bbb62ee89600b` |
| mobile JSON SHA-256 | `48834320a889913b60431aa369a80f83e1a0036c041511be345ed6dcfbd2aa9c` |

`paradisDocxPreview040Adapter.ts` の patch queue は、0.4.0 でも未修正だった次の7件だけを
この順序で適用する。各 source matcher は1回だけ一致する必要があり、upstream drift または
二重適用は失敗にする。

1. `vml-stroke-attributes`
2. `vertical-writing-variants`
3. `table-layout-type-attribute`
4. `hanging-indent-tab-stop`
5. `fixed-table-width`
6. `page-relative-vml-origin`
7. `numbering-css-content`

0.4.0 は `renderDocument(document, options): Promise<Node[]>` と `options.h` を提供する。
adapter は `h` で logical node ID/anchor だけを付与し、VML の `from`/`to`、画像 transform、
page style の生値を変更しない。semantic parser、package security、外部 asset policyは既存経路が
正本であり、この adapter では再実装しない。0.4.0 の `mmlMath` container が AST の
`cssStyle` を `h` へ渡さない箇所だけ、文書順で MathML root に logical anchor を引き継ぐ。

次のコマンドは2つの独立した clean temp directory へ同じ PC/mobile 候補を生成し、archive、
source、license、両出力の固定 hash を検証する。最後に2回目の hash 検証済み PC 候補を
`out/` の test helper へ渡し、実0.4 UMDの最小 golden を実行する。追跡成果物への書込みは行わない。

```sh
npm run transpile-client
for BUILD_RUN in 1 2; do
  TASK_TMP=$(mktemp -d)
  curl -fsSLo "$TASK_TMP/archive.tgz" \
    https://registry.npmjs.org/docx-preview/-/docx-preview-0.4.0.tgz
  printf '%s  %s\n' \
    94c336d6a1ea69d188bc95bfb4c6de55ea6414270477359ddda557d1a5bea447 \
    "$TASK_TMP/archive.tgz" | shasum -a 256 -c -
  tar -xzf "$TASK_TMP/archive.tgz" -C "$TASK_TMP"
  printf '%s  %s\n' \
    051ef503f2677d53159a388b7384e950eda41ea4e47a103e5e36f124d7faea40 \
    "$TASK_TMP/package/dist/docx-preview.min.js" | shasum -a 256 -c -
  printf '%s  %s\n' \
    8668bf4417d161e4eb4d47d6044526e4914d9eb3c748573d9bb7e87708c1253f \
    "$TASK_TMP/package/LICENSE" | shasum -a 256 -c -
  TASK_TMP="$TASK_TMP" node --input-type=module <<'NODE'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { applyDocxPreview040Patches } from './out/vs/paradis/contrib/fileViewers/electron-browser/word/paradisDocxPreview040Adapter.js';

const root = process.env.TASK_TMP;
const upstream = readFileSync(`${root}/package/dist/docx-preview.min.js`, 'utf8');
const patched = applyDocxPreview040Patches(upstream);
const jszip = readFileSync('src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/jszip.min.js', 'utf8');
mkdirSync(`${root}/pc`, { recursive: true });
mkdirSync(`${root}/mobile`, { recursive: true });
writeFileSync(`${root}/pc/docx-preview.min.js`, patched);
writeFileSync(`${root}/mobile/docxPreviewBundle.json`,
  `{"version": 1, "jszip": ${JSON.stringify(jszip)}, "docxPreview": ${JSON.stringify(patched)}}`);
NODE
  printf '%s  %s\n' \
    a60958918afcc4579216ea44637736f6ad21ae41c2ae64b6c48bbb62ee89600b \
    "$TASK_TMP/pc/docx-preview.min.js" | shasum -a 256 -c -
  printf '%s  %s\n' \
    48834320a889913b60431aa369a80f83e1a0036c041511be345ed6dcfbd2aa9c \
    "$TASK_TMP/mobile/docxPreviewBundle.json" | shasum -a 256 -c -
done
cp "$TASK_TMP/pc/docx-preview.min.js" \
  out/vs/paradis/contrib/fileViewers/test/electron-browser/paradisDocxPreview040Candidate.min.js
./scripts/test.sh --run \
  src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisDocxPreview040Adapter.test.ts
```

## 更新手順

`docx-preview@0.3.7` は公開 tarball の SHA-256 を固定し、
`build/next/index.ts` の順序付きパッチキューを1回ずつ適用して再生成する。
同じコマンドが PC 用成果物とモバイル用 JSON を生成するため、個別にコピー・編集しない。

```sh
npm run gulp -- docx-preview-037
npm run gulp -- docx-preview-037-check
```

クリーンな任意ディレクトリへの再現確認には次を使う。

```sh
node build/next/index.ts docx-preview-037 --out <dir>
```

JSZip を更新する場合だけ、ライセンスを含めて取得し、スクリプト内の固定 SHA-256 と
バージョン表記を同時に更新する。

```sh
npm pack jszip@<version>
tar -xzf jszip-<version>.tgz
cp package/dist/jszip.min.js .
cp package/LICENSE.markdown LICENSE-jszip
```

更新時はこの README のバージョン表記も更新すること。
ビルド同梱は `build/next/index.ts` の `desktopResourcePatterns`（実リリース経路）と
`build/gulpfile.vscode.ts` の `vscodeResourceIncludes` の両方に glob 登録済み。

## 再現ビルドで適用するパッチ（`docx-preview.min.js`、2026-07-06）

`docx-preview@0.3.7`（GitHub `master` の現行実装でも同様、未修正）の
`HtmlRenderer.levelTextToContent()` は、番号付き/箇条書きリストの CSS `content` 値を
テンプレートリテラルの二重ネストで組み立てており、生成される値が
`content: ""counter(docx-num-5-0, decimal)"".\9";` のような不正な CSS になる
（`counter()` 呼び出しをクォートで囲んでしまい、さらに外側からもクォートしている）。
ブラウザはこの `content` 宣言をパースエラーとして無視し（計算値は `content: none`）、
**番号・箇条書きの記号が一切表示されない**。

この関数の実装を、正しい CSS（`counter(...)` はクォート無し、リテラル文字列部分だけ
`JSON.stringify` でクォートし、スペース区切りで連結する）に置換する。

再更新時（`npm pack` で新バージョンを取得し直す際）は、新しい `docx-preview.min.js` に
このパッチが必要かどうか確認し、必要ならこの内容で再適用すること。壊れた実装かどうかは、
実際に番号付きリストを含む .docx をレンダリングし、DevTools で `::before` の
計算済み `content` が `none` になっていないかで確認できる。

## 再現ビルドのパッチ2件目（VML図形の `strokecolor`/`strokeweight` 未対応、2026-07-06）

VML 図形（`<v:line>`/`<v:rect>`/`<v:oval>` 等。斜線コネクタ・罫線装飾など実務文書で
多用される）は、線の色・太さを (a) `<v:stroke color="..." weight="...">` という子要素、
(b) 図形要素自身の `strokecolor`/`strokeweight` 属性、の2通りの書き方で指定できる
（VML仕様上どちらも有効）。原実装の VML 属性パーサ（`Ce(e,t)` 関数、`for(const t of
v.attrs(e)) switch(t.localName)`）は (a) の子要素形式にしか対応する `case` が無く、
(b) の属性形式（実務ではこちらの方が一般的）を完全に無視する。結果、生成される SVG の
`<line>`/`<rect>` 等に `stroke` 属性が一切付かず、ブラウザの既定値 `stroke: none` により
**図形が透明になり完全に見えなくなる**（数値が壊れて無視される numbering バグと違い、
こちらは属性自体がパース時点で捨てられ復元不可能なため、後処理では直せない）。

`Ce` 関数の属性パース switch 文に `case"strokecolor"`（`stroke` へ、末尾の
`" [3040]"`のようなテーマカラー参照サフィックスを除去）と `case"strokeweight"`
（`stroke-width` へ）を追加した。

再更新時は、罫線・斜線コネクタ（`<v:line>` 等）を含む .docx で、DevTools の
Elements パネルから該当 `<line>`/`<rect>` の computed `stroke` が `none` に
なっていないかで壊れているか確認できる。

## 再現ビルドのパッチ3件目（ページ幅の不整合、2026-07-07）

複数ページの実務文書（契約書・重要事項説明書等）で、ページごとに白紙の幅が大きく
異なって見える（あるページだけ極端に広い/狭い）不具合。根本原因は3つ重なっていた。

1. **`<w:textDirection>` の V バリアント未対応**: `tbRlV`/`lrTbV`/`tbLrV`（縦書きの
   亜種、文字回転の有無が違うだけで書字方向自体は `tbRl`/`lrTb`/`btLr` と同じ）が
   `parseTableCellVerticalText` のマッピングに無く、フォールバックで横書き
   (`horizontal-tb`) として描画されていた。本来「幅は狭いが十分な高さ」の縦書き
   セルの中身が横方向に大きくはみ出し、テーブル・ページ全体を押し広げていた。
   マッピングに `tbRlV`/`lrTbV`/`tbLrV` を追加（対応する非V版と同じ設定）。

2. **`valueOfTblLayout` の属性名バグ（本件の核心）**: OOXML(ECMA-376) の
   `<w:tblLayout>` は値を `w:type` 属性で持つ（他の多くの要素と違い `w:val` ではない）。
   原実装は `v.attr(e,"val")` を参照しており常に空文字列になるため、
   `<w:tblLayout w:type="fixed"/>` が指定されていても常に無視されて
   `table-layout:auto` にフォールバックしていた。`w:tblW type="auto"` かつ
   `tblLayout type="fixed"` の文書では、`table-layout:auto` が「折り返せない内容
   (プレースホルダ変数名等の連続した英数字トークン)を含む列があるとテーブル全体を
   押し広げてよい」という挙動になるため、そのままページ全体の幅まで拡大していた。
   `"val"` を `"type"` に修正（`renderTable.ts` 相当の1文字の違いだが影響は大きい）。

3. **`tblW=auto` 時の幅の未計算**: 2.の修正後も、`table-layout:fixed` はテーブル
   全体の絶対幅が明示されていないと機能しない（列同士の比率は固定されるが、
   テーブル自体のサイズは内容依存のままになる）。`renderTable` で、
   `width:auto` かつ `table-layout:fixed` かつ全 `gridCol` に幅がある場合は
   その合計を明示的な `width` として補完し、`table-layout` 自体が省略されている
   場合（`width` は明示）は `fixed` をデフォルトとして補うようにした。

これに加えて、`table-layout:fixed` で固定された列幅を実データ未投入のプレースホルダ
（`{{変数名}}` のような折り返せない長いトークン）が超えるとセルの外や隣接セルの上に
オーバーフローして重なって見えるため、`paradisDocxFileEditor.ts` 側の注入CSSで
`table td, table th { overflow-wrap: break-word; }` を追加し、はみ出さず折り返すようにした
（これは vendored ファイルではなく `paradisDocxFileEditor.ts` 側の変更）。

再更新時は、複数ページの実務文書（列幅固定・縦書きラベル列を含む表がある文書）で
DevTools から `.docx-wrapper > section.docx` 各要素の `getBoundingClientRect().width`
を比較し、ページごとに値が食い違っていないかで確認できる。

## 再現ビルドのパッチ4件目（図形の位置とタブストップ、2026-07-07）

1. **ページ基準のVML図形の位置ズレ**: `mso-position-{horizontal,vertical}-relative:page`
   （ページ左上原点で配置する指定）を持つVML図形（「線で抹消」の斜線コネクタ等）について、
   原実装（`renderVmlElement`）は position:absolute を含む style をそのまま流すだけで
   left/top を与えないため、svg がアンカー段落の位置（static position）に置かれ、その中で
   from/to のページ基準座標が描かれる = アンカー位置とページ座標が二重に加算され、図形が
   本来のページ位置から大きくズレて別ページの内容の上に描かれていた。relative:page の
   指定がある軸は left/top を 0 にするパッチを適用（ビューア側CSSで `section.docx` に
   `position:relative` を付与しページ要素を基準にしている。この2つはセット）。

2. **hanging indent 段落の行頭タブ**: Word の仕様では、hanging indent（ぶら下げ
   インデント、CSSでは text-indent が負）を持つ段落の行頭タブ文字は「left indent の位置」
   へのジャンプとして扱われる（明示タブストップより優先）。実務文書の目次で多用される
   「[tab]見出し[tab]ページ番号」構造（先頭タブは実質幅ゼロ、2つ目だけが右揃え+点線
   リーダー）がこれに依存する。原実装のタブストップ計算（`je` 関数、experimental
   オプションで有効化）はこの暗黙ストップを知らず、行頭タブに右端の右揃え+リーダー
   ストップを選んでしまい、見出しが行末へ押し出されリーダー線が行頭に来る崩れ方を
   していた。text-indent が負の段落ではインデント位置(pos:0)の左タブをストップ候補の
   先頭に補うパッチを適用。

なお、タブストップ計算自体は docx-preview の `experimental: true` オプションで有効になる
機能（無効だとタブが全角空白1つになり、右揃えタブや点線リーダーが機能しない）。
`paradisDocxFileEditor.ts` 側の renderAsync オプションで有効化している。

## 描画対象へ目印を出させるパッチ（2026-08-29 追加。バグ修正ではなく機能追加）

docx-preview はグラフ・SmartArt・DrawingML 図形を描かない。Para Code はその中身を自前の
SVG（`electron-browser/word/paradisWordObjectRenderer.ts`）で補うが、差し込み先を決めるには
「この枠がどの図のものか」を知る必要がある。

docx-preview は理解できない drawing でも `renderDrawing` が extent の大きさを持つ空の
`inline-block` を残すので枠自体はある。しかし目印が無いと出現順で推測するしかなく、それは
実運用で必ずずれる。

- `mc:AlternateContent` は対応名前空間リストが空（`Le=[]`）のため **Choice を捨てて Fallback の
  VML を描く**。Word が書く図形・テキストボックスはほぼこの形で、枠が作られない
- 画像は `<img>` になるので枠にならない
- ヘッダーはページごとに複製される

1件でもずれると以降が全部ずれ、別の図の位置に描いてしまう。そこで次の2箇所を書き換え、
`wp:docPr@id` を枠の属性として出させている。

1. `parseDrawingWrapper` の要素ループに `case"docPr":t.paradisDrawingId=v.attr(o,"id");break;` を追加
2. `renderDrawing` に `null!=e.paradisDrawingId&&t.setAttribute("data-paradis-drawing-id",e.paradisDrawingId),` を追加

上流の描画結果には影響しない（属性が1つ増えるだけ）。対応づけの実装は
`common/word/paradisWordOverlayPlacement.ts`、差し込みは `paradisDocxFileEditor.ts` の
webview スクリプト内。

## モバイルアプリ用バンドル（要同期）

Para Code Mobile の Word ビューア（`app/mobile/src/components/fileViewer.tsx` の
`buildDocxHtml`）は、このディレクトリの **パッチ済み** `jszip.min.js` /
`docx-preview.min.js` を `app/mobile/assets/docxpreview/docxPreviewBundle.json`
（`{ version, jszip, docxPreview }`、xtermBundle.json と同方式）として同梱し、
WebView 内で実行する。`docx-preview-037` コマンドはこの JSON も同じ入力 bytes から
同時生成し、`docx-preview-037-check` は両成果物の固定ハッシュを検証する。

なお、モバイル側の `buildDocxHtml` には WKWebView(WebKit) 専用のレンダリング回避策が
2つ入っている（PC版のChromiumでは不要なため、vendored ライブラリ側ではなく
モバイルのHTML後処理として実装している）:

1. WebKit は表セル直上の `writing-mode`（直交フロー）をレイアウトできず、縦書きセルの
   文字が1文字ずつ横に積まれてセル幅が暴走する → writing-mode をセル内のラッパー div へ移す
2. WebKit は `border-collapse` の表で 1px 未満の罫線を描画しない（Word 標準罫線は
   0.5pt ≒ 0.67px なので細罫線がほぼ全滅する）→ 1px 未満の罫線幅を 1px へ底上げする
