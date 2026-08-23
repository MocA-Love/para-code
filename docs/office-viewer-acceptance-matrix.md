# Office Viewer Acceptance Matrix

`docs/report-officee.html` の A/B/C/D 監査行と、`docs/report-office-mock.html` の追加網羅行を追跡する台帳。`verified-existing` は両レポートで対応済みと再監査された既存コミットだけであり、この計画での完了を意味しない。`pending` と `pending-fallback` は未実装で、fixture・test・runtime gate は後続タスクで実証してから更新する。

| id | requirement | ownerTask | expectedBehavior | fixture | unitTest | runtimeGate | status | commit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A-01 | Excel表示: 絶対行番号を表示する | existing | `excelRow` に一致する行見出し | historical:A-01 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| A-02 | Excel表示: `minCol` 起点の列ラベルを表示する | existing | 実列に一致する列見出し | historical:A-02 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| A-03 | 狭い数値セルを `######` 又は科学表記にする | spreadsheet-2 | 数値・日付を隣セルへ溢れさせない | future:xlsx/A-03 | future:spreadsheet-2 | desktop:xlsx-render | pending | pending |
| A-04 | 隠し行・打切り行を参照するdrawing anchorを近傍行へ置く | existing | anchorが y=0 へ飛ばない | historical:A-04 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| A-05 | font load 後に shrink-to-fit と文字overflowを再測定する | spreadsheet-6 | 測定後も切れ・過剰縮小を残さない | future:xlsx/A-05 | future:spreadsheet-6 | desktop:xlsx-render | pending | pending |
| A-06 | wrap と customHeight を両立する | existing | 固定行高と配置が壊れない | historical:A-06 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| A-07 | general 配置を値型ごとに再現する | existing | boolean/error中央、日付右寄せ | historical:A-07 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| A-08 | theme tint を HLS で解決する | existing | 中間tintもExcel表示に一致 | historical:A-08 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| A-09 | indexed color paletteを解決する | existing | legacy色を欠落させない | historical:A-09 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| A-10 | 任意 `textRotation` を描画する | spreadsheet-1 | 1〜180度の文字回転を保持する | future:xlsx/A-10 | future:spreadsheet-1 | desktop:xlsx-render | pending | pending |
| A-11 | drawingのrotation・arrow・fill・text・anchor・chartを扱う | spreadsheet-4 | 対応可能なobjectを描画又は明示placeholderにする | future:xlsx/A-11 | future:spreadsheet-4 | desktop:xlsx-render | pending | pending |
| A-12 | drawing scheme color派生を解決する | spreadsheet-4 | lumMod/lumOff/tintを適用する | future:xlsx/A-12 | future:spreadsheet-4 | desktop:xlsx-render | pending | pending |
| A-13 | freeze panesを再現する | spreadsheet-6 | splitとtop-left cellを固定する | future:xlsx/A-13 | future:spreadsheet-6 | desktop:xlsx-render | pending | pending |
| A-14 | MDW列幅を一貫して計算する | spreadsheet-2 | gridとpage layoutが同じ幅を使う | future:xlsx/A-14 | future:spreadsheet-2 | desktop:xlsx-render | pending | pending |
| A-15 | 大量列を仮想化し上限を適用する | spreadsheet-6 | 500列×2000行で全td構築しない | future:xlsx/A-15 | future:spreadsheet-6 | desktop:xlsx-render | pending | pending |
| A-16 | dashDot/hair罫線を忠実表示する | spreadsheet-1 | 罫線種別を潰さない | future:xlsx/A-16 | future:spreadsheet-1 | desktop:xlsx-render | pending | pending |
| A-17 | underline種別とverticalAlignを保持する | existing | double/accounting下線と縦位置を保つ | historical:A-17 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| A-18 | pattern/gradient fillを描画する | spreadsheet-1 | 塗りを無背景にしない | future:xlsx/A-18 | future:spreadsheet-1 | desktop:xlsx-render | pending | pending |
| A-19 | 印刷タイトルの繰返し列を反映する | spreadsheet-4 | 横ページ割りにrepeat columnsを適用する | future:xlsx/A-19 | future:spreadsheet-4 | desktop:xlsx-render | pending | pending |
| A-20 | centerContinuous/distributed/indentを再現する | existing | horizontal alignmentとindentを保つ | historical:A-20 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| A-21 | cache無し数式と日付fallbackを明示する | spreadsheet-2 | 空欄化せずlocale非依存で表示する | future:xlsx/A-21 | future:spreadsheet-2 | desktop:xlsx-render | pending | pending |
| A-22 | zoom/reload/pinchのUI状態を保つ | spreadsheet-7 | 再読込でscrollを失わない | future:xlsx/A-22 | future:spreadsheet-7 | desktop:xlsx-render | pending | pending |
| A-23 | high-contrastに適応する | spreadsheet-7 | sheet面もworkbench themeに追従する | future:xlsx/A-23 | future:spreadsheet-7 | desktop:xlsx-render | pending | pending |
| B-01 | 行挿入時にLCS整列する | existing | 以降の行を偽modifiedにしない | historical:B-01 | existing regression | report-office-mock correction | verified-existing | aa7a5be4791 |
| B-02 | parse失敗を空ブック扱いしない | existing | 失敗を明示しNo Changesにしない | historical:B-02 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| B-03 | MAX_ROWS打切りをDiff UIで通知する | existing | 未比較範囲を明示する | historical:B-03 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| B-04 | 式とcacheを別に比較する | spreadsheet-5 | 同値式変更とcache変化を分類する | future:xlsx/B-04 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| B-05 | `numFmt` のみの変更を比較する | spreadsheet-5 | 書式差分を不可視にしない | future:xlsx/B-05 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| B-06 | 中間列挿入を整列する | spreadsheet-5 | 以降の列を偽modifiedにしない | future:xlsx/B-06 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| B-07 | 浮動小数の再計算誤差を正規化する | spreadsheet-5 | 表示誤差を偽差分にしない | future:xlsx/B-07 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| B-08 | 行高差でlogical scroll同期する | spreadsheet-6 | wheel後も行位置を一致させる | future:xlsx/B-08 | future:spreadsheet-6 | desktop:xlsx-diff | pending | pending |
| B-09 | Diffに絶対行列見出しを表示する | existing | Excel行列番号を表示する | historical:B-09 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| B-10 | 結合構造差分を両側へ示す | spreadsheet-5 | hidden従属セルでも差分理由を示す | future:xlsx/B-10 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| B-11 | unchangedセルの詳細構築をearly-outする | spreadsheet-5 | 差分計算を不要に深比較しない | future:xlsx/B-11 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| B-12 | Diff gridを仮想化しIPCをboundedにする | spreadsheet-6 | 巨大列でfreezeしない | future:xlsx/B-12 | future:spreadsheet-6 | desktop:xlsx-diff | pending | pending |
| B-13 | validation-onlyの視覚区別を表示する | existing | 入力規則のみ変更を着色する | historical:B-13 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| B-14 | rename/orderを構造差分として照合する | spreadsheet-5 | 改名を単純add/removeにしない | future:xlsx/B-14 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| B-15 | 重複drawing名を安定照合する | spreadsheet-5 | Map後勝ちで変更を失わない | future:xlsx/B-15 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| B-16 | watcher更新をpatch表示する | spreadsheet-7 | 全DOMちらつきを避ける | future:xlsx/B-16 | future:spreadsheet-7 | desktop:xlsx-diff | pending | pending |
| B-17 | staged git:indexを監視する | platform-2 | 再stageでdiffを更新する | future:xlsx/B-17 | future:platform-2 | desktop:git-diff | pending | pending |
| B-18 | Diff凡例とコピー操作を提供する | existing | 色の意味を説明しコピーできる | historical:B-18 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| B-19 | semantic Diffの回帰ケースを追加する | spreadsheet-5 | 行列・式・format・sheetの盲点をテストする | future:xlsx/B-19 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| C-01 | 脚注・文末脚注本文をDiffする | word-4 | 見えているStory変更を列挙する | future:docx/C-01 | future:word-4 | desktop:docx-diff | pending | pending |
| C-02 | OMML内容hashをDiffする | word-3A | 数式編集をNO_CHANGEにしない | future:docx/C-02 | future:word-3A | desktop:docx-diff | pending | pending |
| C-03 | DrawingML textbox/SmartArt/chartを扱う | word-6 | 描画又は安全なplaceholderを示す | future:docx/C-03 | future:word-6 | desktop:docx-render | pending | pending |
| C-04 | Symbol/Wingdings箇条書きをDiffにも置換する | word-7 | PUA glyphを豆腐にしない | future:docx/C-04 | future:word-7 | desktop:docx-diff | pending | pending |
| C-05 | 広いコンテンツの紙幅をDiffで拡張する | word-7 | 表が白紙からはみ出さない | future:docx/C-05 | future:word-7 | desktop:docx-diff | pending | pending |
| C-06 | 移動＋編集を内容/書式/構造として比較する | word-4 | movedで差分を隠さない | future:docx/C-06 | future:word-4 | desktop:docx-diff | pending | pending |
| C-07 | reveal後のscroll同期を安定化する | word-7 | ghost高さ差で同期を上書きしない | future:docx/C-07 | future:word-7 | desktop:docx-diff | pending | pending |
| C-08 | CFB暗号化docxを正しく案内する | existing | 破損ではなくpassword-protectedと示す | historical:C-08 | existing regression | report-office-mock correction | verified-existing | f516d5d52f5 |
| C-09 | 片側欠落を安全fallbackへ渡す | platform-2 | resolver失敗でopen全体を失敗させない | future:docx/C-09 | future:platform-2 | desktop:scm-diff | pending | pending |
| C-10 | ZIP展開量とmediaをbudgetする | kernel-4 | zip bombをblocked/degradedにする | future:docx/C-10 | future:kernel-4 | desktop:docx-diff | pending | pending |
| C-11 | LCS最悪経路をboundedにする | word-4 | quit predicateで時間を制限する | future:docx/C-11 | future:word-4 | desktop:docx-diff | pending | pending |
| C-12 | 表のsemantic addressで照合する | word-4 | 別table間をcross-matchしない | future:docx/C-12 | future:word-4 | desktop:docx-diff | pending | pending |
| C-13 | 画像resizeとbinary変更を分類する | word-4 | resizeを単純差替えにしない | future:docx/C-13 | future:word-4 | desktop:docx-diff | pending | pending |
| C-14 | list restartを意味比較する | word-2 | numId再採番をノイズにしない | future:docx/C-14 | future:word-2 | desktop:docx-diff | pending | pending |
| C-15 | ghostを完全なlayoutで生成する | word-7 | table内を含め縦ずれを残さない | future:docx/C-15 | future:word-7 | desktop:docx-diff | pending | pending |
| C-16 | break/sectionを可視化する | word-3A | 改ページ種別とsection差を示す | future:docx/C-16 | future:word-3A | desktop:docx-diff | pending | pending |
| C-17 | ruby/RTL/commentsを明示的に扱う | word-7 | 対応又は制約をUI表示する | future:docx/C-17 | future:word-7 | desktop:docx-render | pending | pending |
| C-18 | `</script>` を含む名前をscriptへ埋込まない | platform-4 | 画面崩壊せず安全に表示する | future:docx/C-18 | future:platform-4 | desktop:docx-render | pending | pending |
| C-19 | 画像のみ変更の一覧にmeaningful excerptを出す | word-7 | U+FFFCだけを表示しない | future:docx/C-19 | future:word-7 | desktop:docx-diff | pending | pending |
| C-20 | zoom/format toggleを永続化する | word-7 | 入力切替後もUI状態を保つ | future:docx/C-20 | future:word-7 | desktop:docx-diff | pending | pending |
| C-21 | External imageを安全にplaceholder化する | word-6 | 自動fetchせず種類と理由を示す | future:docx/C-21 | future:word-6 | desktop:docx-render | pending-fallback | pending |
| D-01 | Spreadsheet parse失敗を世代管理付きで伝播する | platform-1 | 静かな誤差分を出さない | future:platform/D-01 | future:platform-1 | desktop:xlsx-diff | pending | pending |
| D-02 | Web workbenchへviewerを登録する | platform-3 | browserでcapabilityに従い開く | future:platform/D-02 | future:platform-3 | web:workbench | pending | pending |
| D-03 | remote xlsx sourceを適切なbackendで読む | platform-2 | 不要なbase64二重転送を避ける | future:platform/D-03 | future:platform-2 | remote:ssh | pending | pending |
| D-04 | 非OPC legacy形式を安全fallbackする | platform-1 | `.xls` 等を誤ってOffice viewerで開かない | future:platform/D-04 | future:platform-1 | desktop:legacy-open | pending-fallback | pending |
| D-05 | Office viewer全体へFindを提供する | platform-6 | Ctrl+Fで検索できる | future:platform/D-05 | future:platform-6 | desktop:find | pending | pending |
| D-06 | print/export actionを提供する | platform-7 | ページモデルから安全に出力する | future:platform/D-06 | future:platform-7 | desktop:print | pending | pending |
| D-07 | spreadsheet cancelで入力状態を復帰する | platform-1 | cancelled loadで旧入力を保つ | future:platform/D-07 | future:platform-1 | desktop:cancel | pending | pending |
| D-08 | size limitとエラー文言を統一する | kernel-2 | 上限超過を日本語の明示outcomeにする | future:platform/D-08 | future:kernel-2 | desktop:limit | pending | pending |
| D-09 | toolbar accessibilityを統一する | platform-8A | icon buttonにaccessible nameを付ける | future:platform/D-09 | future:platform-8A | desktop:a11y | pending | pending |
| D-10 | loopback fallbackでrecoveryを示す | platform-8B | 白紙を検知し復旧状態を出す | future:platform/D-10 | future:platform-8B | desktop:recovery | pending | pending |
| D-11 | untitled binary sourceをbrokerで扱う | kernel-3 | 未保存バイナリも明示的に解決する | future:platform/D-11 | future:kernel-3 | desktop:untitled | pending | pending |
| D-12 | Git LFS pointerを内容と誤認しない | platform-2 | LFS状態を明示し誤差分を避ける | future:platform/D-12 | future:platform-2 | desktop:git-lfs | pending | pending |
| M-EV-01 | Excel表示追加: 数値・日付書式を保持する | spreadsheet-2 | format codeに沿う表示 | future:xlsx/M-EV-01 | future:spreadsheet-2 | desktop:xlsx-render | pending | pending |
| M-EV-02 | Excel表示追加: 数式・型・shared/array式・cacheを保持する | spreadsheet-1 | semantic値を表示モデルと分離する | future:xlsx/M-EV-02 | future:spreadsheet-1 | desktop:xlsx-render | pending | pending |
| M-EV-03 | Excel表示追加: 狭い数値セルをoverflowさせない | spreadsheet-2 | `######`又は科学表記にする | future:xlsx/M-EV-03 | future:spreadsheet-2 | desktop:xlsx-render | pending | pending |
| M-EV-04 | Excel表示追加: font・文字装飾を保持する | spreadsheet-1 | underline/scheme/effectを保つ | future:xlsx/M-EV-04 | future:spreadsheet-1 | desktop:xlsx-render | pending | pending |
| M-EV-05 | Excel表示追加: pattern/gradient/dashDot/hairを描画する | spreadsheet-1 | fill/borderを欠落させない | future:xlsx/M-EV-05 | future:spreadsheet-1 | desktop:xlsx-render | pending | pending |
| M-EV-06 | Excel表示追加: 配置・任意回転・readingOrderを保持する | spreadsheet-1 | alignmentを忠実表示する | future:xlsx/M-EV-06 | future:spreadsheet-1 | desktop:xlsx-render | pending | pending |
| M-EV-07 | Excel表示追加: 条件付き書式を描画する | spreadsheet-3A | rules/dxf/data bar等を明示する | future:xlsx/M-EV-07 | future:spreadsheet-3A | desktop:xlsx-render | pending | pending |
| M-EV-08 | Excel表示追加: customHeight/bestFit/outlineを保持する | spreadsheet-1 | 行列状態と幅を保持する | future:xlsx/M-EV-08 | future:spreadsheet-1 | desktop:xlsx-render | pending | pending |
| M-EV-09 | Excel表示追加: hidden/veryHidden/freeze/RTL viewを保持する | spreadsheet-6 | sheet状態を明示する | future:xlsx/M-EV-09 | future:spreadsheet-6 | desktop:xlsx-render | pending | pending |
| M-EV-10 | Excel表示追加: validation UIを表示する | spreadsheet-3B | dropdown/prompt/errorを表示する | future:xlsx/M-EV-10 | future:spreadsheet-3B | desktop:xlsx-render | pending | pending |
| M-EV-11 | Excel表示追加: hyperlink/note/threadを表示する | spreadsheet-3B | targetと注釈を表示する | future:xlsx/M-EV-11 | future:spreadsheet-3B | desktop:xlsx-render | pending | pending |
| M-EV-12 | Excel表示追加: table/filter/pivotを扱う | spreadsheet-4A | 構造又はplaceholderを表示する | future:xlsx/M-EV-12 | future:spreadsheet-4A | desktop:xlsx-render | pending | pending |
| M-EV-13 | Excel表示追加: drawing/chartの非対応要素を明示する | spreadsheet-4C | 安全なobject placeholderを出す | future:xlsx/M-EV-13 | future:spreadsheet-4C | desktop:xlsx-render | pending | pending |
| M-EV-14 | Excel表示追加: print semanticsを保持する | spreadsheet-4A | area/title/header/footerを反映する | future:xlsx/M-EV-14 | future:spreadsheet-4A | desktop:xlsx-render | pending | pending |
| M-EV-15 | Excel表示追加: protection/external/macroを検出する | spreadsheet-4B | 実行せず状態を表示する | future:xlsx/M-EV-15 | future:spreadsheet-4B | desktop:xlsx-render | pending-fallback | pending |
| M-EV-16 | Excel表示追加: 大規模bookをbudget/virtualizeする | kernel-4 | 省略理由を表示する | future:xlsx/M-EV-16 | future:kernel-4 | desktop:xlsx-render | pending | pending |
| M-EV-17 | Excel表示追加: font後に縮小/overflowを再測定する | spreadsheet-6 | 遅延fontにも追従する | future:xlsx/M-EV-17 | future:spreadsheet-6 | desktop:xlsx-render | pending | pending |
| M-EV-18 | Excel表示追加: zoom/reload/theme状態を維持する | spreadsheet-7 | scroll/pinch/HCを扱う | future:xlsx/M-EV-18 | future:spreadsheet-7 | desktop:xlsx-render | pending | pending |
| M-ED-01 | Excel Diff追加: 数式・型・cacheを比較する | spreadsheet-5 | 表示同値の意味差を示す | future:xlsx/M-ED-01 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-02 | Excel Diff追加: numFmt差分を分類する | spreadsheet-5 | format-only changeを示す | future:xlsx/M-ED-02 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-03 | Excel Diff追加: 浮動小数を正規化する | spreadsheet-5 | 再計算誤差を誤検知しない | future:xlsx/M-ED-03 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-04 | Excel Diff追加: 行整列のfallback/曖昧性を示す | spreadsheet-5 | bounded resultと理由を出す | future:xlsx/M-ED-04 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-05 | Excel Diff追加: 中間列を整列する | spreadsheet-5 | insertion/deletion/moveを分類する | future:xlsx/M-ED-05 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-06 | Excel Diff追加: 比較範囲の打切りを示す | kernel-4 | 範囲外をNo Changesにしない | future:xlsx/M-ED-06 | future:kernel-4 | desktop:xlsx-diff | pending | pending |
| M-ED-07 | Excel Diff追加: 行高・列幅・hiddenを比較する | spreadsheet-5 | structural changesを示す | future:xlsx/M-ED-07 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-08 | Excel Diff追加: rename/order/stateを比較する | spreadsheet-5 | sheet構造差を示す | future:xlsx/M-ED-08 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-09 | Excel Diff追加: CSS射影外styleを比較する | spreadsheet-5 | protection/rotation/fill等を保つ | future:xlsx/M-ED-09 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-10 | Excel Diff追加: conditional formattingを比較する | spreadsheet-5 | ruleとeffective表示を分類する | future:xlsx/M-ED-10 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-11 | Excel Diff追加: merge差分を両側に示す | spreadsheet-5 | hidden cellを含め理由を示す | future:xlsx/M-ED-11 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-12 | Excel Diff追加: validationの意味を正規化する | spreadsheet-3B | x14/range/formulaを比較する | future:xlsx/M-ED-12 | future:spreadsheet-3B | desktop:xlsx-diff | pending | pending |
| M-ED-13 | Excel Diff追加: links/comments/namesを比較する | spreadsheet-5 | annotation差を示す | future:xlsx/M-ED-13 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-14 | Excel Diff追加: table/pivot/filterを比較する | spreadsheet-5 | structure差を示す | future:xlsx/M-ED-14 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-15 | Excel Diff追加: drawing/chartをsemantic比較する | spreadsheet-5 | 重複nameでも変更を失わない | future:xlsx/M-ED-15 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-16 | Excel Diff追加: print/break設定を比較する | spreadsheet-5 | settingと境界を示す | future:xlsx/M-ED-16 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-17 | Excel Diff追加: optional extras失敗をoutcome化する | kernel-2 | 無通知省略を避ける | future:xlsx/M-ED-17 | future:kernel-2 | desktop:xlsx-diff | pending | pending |
| M-ED-18 | Excel Diff追加: metadata/securityを比較する | spreadsheet-5 | properties/protection等を示す | future:xlsx/M-ED-18 | future:spreadsheet-5 | desktop:xlsx-diff | pending | pending |
| M-ED-19 | Excel Diff追加: logical scrollを同期する | spreadsheet-6 | 行高差を累積させない | future:xlsx/M-ED-19 | future:spreadsheet-6 | desktop:xlsx-diff | pending | pending |
| M-ED-20 | Excel Diff追加: comparison costをboundedにする | kernel-4 | early-out/virtualizationを使う | future:xlsx/M-ED-20 | future:kernel-4 | desktop:xlsx-diff | pending | pending |
| M-ED-21 | Excel Diff追加: IPC/memoryをboundedにする | platform-2 | chunkingとbudgetを適用する | future:xlsx/M-ED-21 | future:platform-2 | remote:xlsx-diff | pending | pending |
| M-ED-22 | Excel Diff追加: watcher/stagedを追従する | platform-2 | patch更新とgit:index更新を反映する | future:xlsx/M-ED-22 | future:platform-2 | desktop:git-diff | pending | pending |
| M-WV-01 | Word表示追加: 文字・段落の高度書式を保持する | word-2 | effect/widow/keepを明示する | future:docx/M-WV-01 | future:word-2 | desktop:docx-render | pending | pending |
| M-WV-02 | Word表示追加: styles/theme fontを保持する | word-2 | basedOn/themeTint等を解決する | future:docx/M-WV-02 | future:word-2 | desktop:docx-render | pending | pending |
| M-WV-03 | Word表示追加: numbering override/restartを保持する | word-2 | list semanticsを表示する | future:docx/M-WV-03 | future:word-2 | desktop:docx-render | pending | pending |
| M-WV-04 | Word表示追加: table詳細を保持する | word-2 | RTL/repeat/cantSplit等を示す | future:docx/M-WV-04 | future:word-2 | desktop:docx-render | pending | pending |
| M-WV-05 | Word表示追加: floating imageの不足を明示する | word-3A | wrap/external差をplaceholder化する | future:docx/M-WV-05 | future:word-3A | desktop:docx-render | pending | pending |
| M-WV-06 | Word表示追加: DrawingML shape/textboxを扱う | word-6 | safe placeholderを表示する | future:docx/M-WV-06 | future:word-6 | desktop:docx-render | pending | pending |
| M-WV-07 | Word表示追加: SmartArt/chartを扱う | word-6 | relation/data/fallbackを明示する | future:docx/M-WV-07 | future:word-6 | desktop:docx-render | pending | pending |
| M-WV-08 | Word表示追加: Header/Footer fidelityを示す | word-3A | field/page limitationを表示する | future:docx/M-WV-08 | future:word-3A | desktop:docx-render | pending | pending |
| M-WV-09 | Word表示追加: footnote/endnoteのlayoutを保持する | word-1 | numbering/separatorを保持する | future:docx/M-WV-09 | future:word-1 | desktop:docx-render | pending | pending |
| M-WV-10 | Word表示追加: commentsを安全に表示する | word-7 | enabled stateをUIで明示する | future:docx/M-WV-10 | future:word-7 | desktop:docx-render | pending | pending |
| M-WV-11 | Word表示追加: revisionsを意味表示する | word-3A | author/date/typeを示す | future:docx/M-WV-11 | future:word-3A | desktop:docx-render | pending | pending |
| M-WV-12 | Word表示追加: fieldsを分類する | word-3A | saved resultとrecalculation limitationを示す | future:docx/M-WV-12 | future:word-3A | desktop:docx-render | pending | pending |
| M-WV-13 | Word表示追加: OMML範囲を明示する | word-3A | unsupported mathをplaceholder化する | future:docx/M-WV-13 | future:word-3A | desktop:docx-render | pending | pending |
| M-WV-14 | Word表示追加: section/columnsを保持する | word-3A | page/column差を表示する | future:docx/M-WV-14 | future:word-3A | desktop:docx-render | pending | pending |
| M-WV-15 | Word表示追加: auto pagination非目標を明示する | word-7 | Word同等再組版を主張しない | future:docx/M-WV-15 | future:word-7 | desktop:docx-render | pending-fallback | pending |
| M-WV-16 | Word表示追加: 東アジア組版を明示する | word-7 | ruby/kinsoku/gridの制約を示す | future:docx/M-WV-16 | future:word-7 | desktop:docx-render | pending | pending |
| M-WV-17 | Word表示追加: external/embed/macroを検出する | word-3B | 実行/fetchせず状態を示す | future:docx/M-WV-17 | future:word-3B | desktop:docx-render | pending-fallback | pending |
| M-WV-18 | Word表示追加: size/encryptionをbudgetする | kernel-4 | CFB/budget outcomeを示す | future:docx/M-WV-18 | future:kernel-4 | desktop:docx-render | pending | pending |
| M-WV-19 | Word表示追加: file nameを安全に伝送する | platform-4 | script閉鎖文字列で崩さない | future:docx/M-WV-19 | future:platform-4 | desktop:docx-render | pending | pending |
| M-WD-01 | Word Diff追加: grapheme-safe文字差分にする | word-4 | clusterを分断しない | future:docx/M-WD-01 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-02 | Word Diff追加: 編集付き移動を分類する | word-4 | duplicate/long prefixをboundedに扱う | future:docx/M-WD-02 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-03 | Word Diff追加: effective styleを比較する | word-4 | explicit defaultとrendered styleを区別する | future:docx/M-WD-03 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-04 | Word Diff追加: styles/themeを比較する | word-4 | definition/theme/font差を示す | future:docx/M-WD-04 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-05 | Word Diff追加: table structureを比較する | word-4 | semantic table addressで照合する | future:docx/M-WD-05 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-06 | Word Diff追加: image binary/effectを比較する | word-4 | path同一の差替えを検出する | future:docx/M-WD-06 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-07 | Word Diff追加: VML/DrawingMLをopaque差分へ残す | word-6 | textbox等を無言で落とさない | future:docx/M-WD-07 | future:word-6 | desktop:docx-diff | pending | pending |
| M-WD-08 | Word Diff追加: Header/FooterをStoryとして比較する | word-4 | 件数/navにも含める | future:docx/M-WD-08 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-09 | Word Diff追加: footnote/endnote本文を比較する | word-4 | reference IDだけにしない | future:docx/M-WD-09 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-10 | Word Diff追加: commentsを比較する | word-4 | range/author/reply/stateを示す | future:docx/M-WD-10 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-11 | Word Diff追加: revision差を比較する | word-4 | 同じ最終表示の履歴差を示す | future:docx/M-WD-11 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-12 | Word Diff追加: field命令を比較する | word-4 | instruction/lock/dirtyを示す | future:docx/M-WD-12 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-13 | Word Diff追加: OMML内容を比較する | word-3A | fixed `math` keyを使わない | future:docx/M-WD-13 | future:word-3A | desktop:docx-diff | pending | pending |
| M-WD-14 | Word Diff追加: break/sectionを比較する | word-3A | page/column/section ref差を示す | future:docx/M-WD-14 | future:word-3A | desktop:docx-diff | pending | pending |
| M-WD-15 | Word Diff追加: list意味を比較する | word-2 | ID再採番ノイズを避ける | future:docx/M-WD-15 | future:word-2 | desktop:docx-diff | pending | pending |
| M-WD-16 | Word Diff追加: hyperlink/bookmarkを比較する | word-4 | target/anchor/tooltipを示す | future:docx/M-WD-16 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-17 | Word Diff追加: content control/altChunkを比較する | word-4 | MIMEとpart内容を示す | future:docx/M-WD-17 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-18 | Word Diff追加: metadata/securityを比較する | word-3B | properties/protectionを示す | future:docx/M-WD-18 | future:word-3B | desktop:docx-diff | pending | pending |
| M-WD-19 | Word Diff追加: 片側欠落をfallbackする | platform-2 | openを失敗させない | future:docx/M-WD-19 | future:platform-2 | desktop:scm-diff | pending | pending |
| M-WD-20 | Word Diff追加: ZIP/memoryをbudgetする | kernel-4 | expanded/media/ratioを制限する | future:docx/M-WD-20 | future:kernel-4 | desktop:docx-diff | pending | pending |
| M-WD-21 | Word Diff追加: LCSをboundedにする | word-4 | worst caseを打切る | future:docx/M-WD-21 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-22 | Word Diff追加: image resizeを過剰着色しない | word-4 | change categoryを分離する | future:docx/M-WD-22 | future:word-4 | desktop:docx-diff | pending | pending |
| M-WD-23 | Word Diff追加: ghost/scrollをlogicalにする | word-7 | tableを含め位置を揃える | future:docx/M-WD-23 | future:word-7 | desktop:docx-diff | pending | pending |
| M-WD-24 | Word Diff追加: UI stateを永続化する | word-7 | zoom/toggleをresetしない | future:docx/M-WD-24 | future:word-7 | desktop:docx-diff | pending | pending |
| M-WD-25 | Word Diff追加: UI同期と一覧を改善する | word-7 | excerpt/width/moved差を示す | future:docx/M-WD-25 | future:word-7 | desktop:docx-diff | pending | pending |
| M-X-01 | 共通追加: Web workbench capabilityを提供する | platform-3 | browserでviewerを登録する | future:platform/M-X-01 | future:platform-3 | web:workbench | pending | pending |
| M-X-02 | 共通追加: remote負荷をboundedにする | platform-2 | sourceを過剰複製しない | future:platform/M-X-02 | future:platform-2 | remote:ssh | pending | pending |
| M-X-03 | 共通追加: 対応拡張子を安全fallbackする | platform-1 | legacy非対応を明示する | future:platform/M-X-03 | future:platform-1 | desktop:legacy-open | pending-fallback | pending |
| M-X-04 | 共通追加: 統合検索を提供する | platform-6 | Ctrl+Fを利用できる | future:platform/M-X-04 | future:platform-6 | desktop:find | pending | pending |
| M-X-05 | 共通追加: print/exportを提供する | platform-7 | print modelから出力する | future:platform/M-X-05 | future:platform-7 | desktop:print | pending | pending |
| M-X-06 | 共通追加: cancel後に入力を復帰する | platform-1 | 旧入力を保つ | future:platform/M-X-06 | future:platform-1 | desktop:cancel | pending | pending |
| M-X-07 | 共通追加: size limitを統一する | kernel-2 | 32MiB/expanded budgetを明示する | future:platform/M-X-07 | future:kernel-2 | desktop:limit | pending | pending |
| M-X-08 | 共通追加: accessibility contractを満たす | platform-8A | 全操作にaccessible nameを持たせる | future:platform/M-X-08 | future:platform-8A | desktop:a11y | pending | pending |
| M-X-09 | 共通追加: loopback fallbackをrecoverする | platform-8B | blankをrecovery UIへ遷移する | future:platform/M-X-09 | future:platform-8B | desktop:recovery | pending | pending |
| M-X-10 | 共通追加: untitledをsource brokerで解決する | kernel-3 | binary sourceを明示解決する | future:platform/M-X-10 | future:kernel-3 | desktop:untitled | pending | pending |
| M-X-11 | 共通追加: Git LFSを明示する | platform-2 | pointerをOffice内容と扱わない | future:platform/M-X-11 | future:platform-2 | desktop:git-lfs | pending | pending |
| M-X-12 | 共通追加: SCM/watcher差を扱う | platform-2 | staged/side absenceを区別する | future:platform/M-X-12 | future:platform-2 | desktop:git-diff | pending | pending |
| M-X-13 | 共通追加: mobile capabilityを明示する | platform-5 | unsupported Word Diffを隠さない | future:platform/M-X-13 | future:platform-5 | mobile:capability | pending | pending |
| M-X-14 | 共通追加: docx-preview更新を再現可能にする | word-5B | adapter version/hash/patchを固定する | future:platform/M-X-14 | future:word-5B | desktop:adapter | pending | pending |
