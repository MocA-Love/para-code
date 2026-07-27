---
name: merge-upstream
description: "Para Code (microsoft/vscode fork) へ upstream の新しいリリースタグを取り込む。マージベース特定 → PARA-PATCH マーカー監査 → graft + squash マージ → コンフリクト解消 → 型/レイヤー検証 → 意味的レビュー → 実機確認 → リリースまでを通す。'VS Code 1.130 に対応したい'『upstream を取り込みたい』『本家のアップデートに追従したい』のような依頼で使う。"
---

# upstream (microsoft/vscode) 取り込み

Para Code は `microsoft/vscode` の fork。upstream のリリースタグを定期的に取り込む。

**このリポジトリ特有の前提（これを知らないと手順を誤る）**:

- `main` の履歴は upstream と**共通祖先を持たない**。起点コミットは upstream スナップショットを1コミットに圧縮したもの（push 転送量の問題による。`NOTES.md` の「pushトラブルの記録」参照）。素朴な `git merge upstream/main` は全ファイルコンフリクトになる
- したがって毎回 **`git replace --graft` でローカルに共通祖先を教えてから `git merge --squash`** する。squash なので upstream の巨大な履歴は push されない
- fork の変更は `PARA-PATCH:`（upstream 由来ファイルへの変更）と `PARA-CODE:`（fork 新規ファイル）のマーカーで識別する。**コンフリクト解消はこのマーカーに依存する**ので、マーカーが欠けている箇所があるとマージで fork 変更が黙って消える

所要時間の目安: 監査〜マージ〜検証で数時間、リリース CI が約30分。

---

## フェーズ0: 準備と現状把握

```bash
git -C <repo> fetch upstream --tags
git tag -l '1.13*'                      # 取り込みたいタグの存在確認
grep -m1 '"version"' package.json       # 現在のベースバージョン
git config rerere.enabled               # true であること（過去の解消を再利用）
```

**マージベースの特定**（`NOTES.md` の「リポジトリ構成」に記載があるはず）:

- 通常は NOTES.md に「現在のツリーが対応するupstreamコミット」が書いてある。それを使う
- 書かれていない/信用できない場合は、起点コミットのツリーハッシュと一致する upstream コミットを探す:

```bash
# 起点コミットの日付近傍の upstream コミットと差分ファイル数を比較（全走査は10分でタイムアウトするので日付で絞る）
for c in $(git log upstream/main --format='%H' --before='<起点コミットの翌日>' | head -20); do
  n=$(git diff --name-only $c <起点コミット> | wc -l | tr -d ' '); echo "$n $c"
done | sort -n | head -5
```

差分が fork 追加ファイル（NOTES.md / mise.toml 等）だけになるコミットが正解。

---

## フェーズ1: マーカー監査（マージ前に必ず実施）

**なぜ必要か**: コンフリクト解消は「upstream 側を採用して PARA-PATCH 行を再挿入」という方針を取る。マーカーが無い fork 変更はこの方針で消える。しかも過去に `para:` プレフィックスを付け忘れたコミットがあると `git log --grep '^para:'` の網からも漏れる。

```bash
BASE=<マージベースのupstreamコミット>
# upstream 由来ファイルへの fork 変更（M = modified）を列挙
git diff --name-status $BASE HEAD | awk '$1=="M"{print $2}' > /tmp/fork-modified.txt

# マーカーが無いものを検出
while read f; do [ -f "$f" ] && ! grep -q 'PARA-PATCH' "$f" && echo "$f"; done < /tmp/fork-modified.txt
```

検出されたファイルの扱い:

- **コメントを書けるファイル（.ts/.js/.css 等）**: マーカーを後付けする。並列サブエージェントに領域ごと（terminal 系 / editor 系 …）分担させると速い。指示に必ず含めること:
  - hunk ごとに `git log`/`git blame` で由来コミットを特定し、理由を英語 ASCII 1行で書く（日本語は hygiene 違反）
  - **既存行を1文字も変更しない**（コメント行の追加のみ）
  - 自己検証2コマンド: `git diff --numstat HEAD -- <files>` で削除列が全て0、`git diff -U0 HEAD -- <files> | grep '^+' | grep -v '^+++' | grep -v 'PARA-PATCH'` が空
- **コメントを書けないファイル（JSON/バイナリ/plist）**: `NOTES.md` の「コメントを書けないファイルへの変更一覧」に載っているか確認する。載っていなければ追記する

マーカー追記は挙動を変えないので、`typecheck-client` を通してから独立したコミットにする（`para: backfill missing PARA-PATCH markers ahead of the <version> merge`）。監査結果（違反コミット一覧など）は NOTES.md にも記録する。

---

## フェーズ2: 事前調査（コンフリクトの規模と危険度を見積もる）

```bash
TAG=<取り込むタグ>
# fork 変更ファイル × upstream 変更ファイルの交差（= コンフリクトし得る箇所）を churn 順に
while read f; do
  u=$(git diff --numstat $BASE $TAG -- "$f" | awk '{print $1+$2}')
  [ -n "$u" ] && [ "$u" != "0" ] && echo "$u $f"
done < /tmp/fork-modified.txt | sort -rn

# modify/delete コンフリクト（upstream が消した fork 変更ファイル）
git diff --name-status -M $BASE $TAG | awk '$1~/^(D|R)/' > /tmp/upstream-dr.txt
while read f; do grep -E "	$f(	|$)" /tmp/upstream-dr.txt; done < /tmp/fork-modified.txt

# add/add パス衝突（fork 新規ファイルと同名を upstream も追加）
comm -12 <(git diff --name-status $BASE HEAD | awk '$1=="A"{print $2}' | sort) \
         <(git diff --name-status $BASE $TAG   | awk '$1=="A"{print $2}' | sort)

# ビルド前提の変更（毎回確認: Node/Electron のバージョン要件）
git diff $BASE $TAG -- .nvmrc .npmrc package.json | head -40
```

リリースノート（`https://code.visualstudio.com/updates/vX_Y`）も読み、fork が触っている領域（ターミナル、エディタ、update、browserView、カスタムエディタ等）への言及を拾う。

---

## フェーズ3: 試験マージ（別 worktree で）

**main は絶対に汚さない**。worktree を切って作業する。

```bash
git replace --graft <起点コミット> $BASE          # ローカルのみ。push されない
git merge-base main $TAG                          # $BASE が返れば成功
git worktree add ../<repo>-merge-trial -b merge/upstream-<version> main
cd ../<repo>-merge-trial && git merge --squash $TAG
git diff --name-only --diff-filter=U               # コンフリクト一覧
```

### コンフリクト解消の定石

| 種類 | 方針 |
|---|---|
| import 行 | 両方の import を残すのが基本（upstream の新規 + fork の PARA-PATCH 付き） |
| 集約 import ファイル（`workbench.common.main.ts` 等） | 自分の1行を残すだけの機械的解消 |
| upstream がメソッドを新設して呼び出し側が増えた | **fork のパッチを新メソッド側へ移す**（例: スクロールバー無効化を `_getScrollbarOptions()` の return に移し、両呼び出し点をカバー） |
| upstream が定数/設定を削除 | fork がその定数を使っていないか全ツリー grep で裏取りしてから削除に追従 |
| `package-lock.json` | 手作業でマージしない。upstream 版を `git checkout $TAG -- package-lock.json` してから `npm install` で再生成し、fork 固有依存が復元されたか確認 |
| `build/lib/stylelint/vscode-known-variables.json` | upstream 配列を丸ごと採用し、paradis 変数だけ再挿入 |
| テーマ JSON | upstream がアクセント色を使い続けるキーはブランド色維持、無彩色に変えたキーは upstream 追従（判断が割れるのでユーザーに確認する） |

解消後は必ず: 未解消マーカーゼロの確認（`git grep -l '^<<<<<<< HEAD'`）、`grep -rl 'PARA-PATCH'` のファイル数が main と一致するか。

---

## フェーズ4: 機械検証

```bash
npm install                    # ← 必須。Electron/依存が変わっている
npm run typecheck-client
npm run valid-layers-check
```

**Node バージョン**: upstream が `.nvmrc` を上げていると `build/npm/preinstall.ts` が `npm install` を弾く。fork 所有の `mise.toml` を同じ値に上げて `mise install` する（mise.toml のコミットは hygiene の既知衝突で `--no-verify` が必要）。

**`build/node_modules`**: root の `npm install` が exit 0 でも build/ のサブインストールがスキップされることがある。起動時に `gulp-merge-json` の `ERR_MODULE_NOT_FOUND` が出たら `cd build && npm ci`。

---

## フェーズ5: 意味的レビュー（自動マージ = 正しい、ではない）

型が通っても、upstream のリファクタが fork パッチの前提（呼び出し順・状態遷移・ライフサイクル）を壊していることがある。フェーズ2で出した**交差ファイル全件**を領域ごとに分けて、並列サブエージェントで三方向比較させる。

各エージェントへ渡す前提:
- マージ結果ツリー（worktree のパス）、fork 現行（main）、マージベース、upstream タグ
- 比較方法: `git diff $BASE..main -- <file>`（fork の意図） vs `git diff $BASE..$TAG -- <file>`（upstream の意図） vs マージ結果
- 担当領域の fork 機能の背景（NOTES.md の該当セクションを読ませる）
- 報告形式: ファイルごとに `VERDICT: OK / ISSUE`（行参照・失敗シナリオ・推奨修正付き）

領域分割の例: 自動アップデート基盤 / エディタ・workbench / browserView・CDP / ターミナル / native・ウィンドウ / ビルド・CI・独自ビューア。

**特に見るべき観点**:
- fork が差し込んだヘッダー・パラメータが、upstream が新設した経路にも載っているか（リクエスト経路の網羅性など）
- fork が実装するインターフェースに upstream がメンバーを追加していないか
- upstream が削除した設定/API への参照が fork 側に残っていないか
- 上位レイヤーの挙動変更（例: カスタムエディタの diff 既定、設定ゲートの廃止）が fork 機能に波及しないか

---

## フェーズ6: 実機確認

`launch` スキルで起動する（`TMPDIR=/tmp` 必須。パス長103文字制限）。worktree から起動する場合は本物の `npm ci` + `npm run compile` が要る（transpile だけではアイコン・組み込み拡張が壊れる）。

確認項目（fork 機能の全系統を一巡）: 起動 / Agent Sessions ウィンドウ / 自動アップデートチェック / 独自ファイルビューア（md 差分含む） / ターミナル（グリッド分割・スクロールバー・履歴サジェスト） / Para Browser / モバイルリレー / ウィンドウ透過 / テーマの見た目。

**upstream の新機能が fork 機能と干渉することがある**（1.129 では Modern UI のフローティングシェル背景がウィンドウ透過を潰した）。この種の修正は fork 所有ファイル内で完結させる（例: 透過 CSS に `.floating-panels` 用ルールを追加。詳細度を1クラス分上げて upstream に勝たせる）。

---

## フェーズ7: 確定とリリース

```bash
# worktree で squash コミット（product.json の hygiene 既知衝突により --no-verify）
git commit --no-verify -m "para: merge upstream <TAG>

<自動マージ件数 / 手動解消したファイル / 検証結果 / レビュー結果を記載>"

# マージ中に main が進んでいたら取り込む
git merge --no-commit --no-ff main && git commit --no-verify -m "para: merge main into the <version> merge branch"

# main へ反映（fast-forward）
git checkout main && git merge --ff-only merge/upstream-<version>
```

**NOTES.md の更新**（次回のために必須）: 「現在のツリーが対応する upstream コミット」をタグ名で更新し、次回の graft 手順（`git replace --graft <今回のsquashコミット> <その実親> <今回のタグ>`）を書き残す。

**changelog**: `src/vs/paradis/contrib/releaseNotes/.../paradisChangelog.md` の `## 未リリース` に、ユーザー視点で「ベースの VS Code を X.Y 相当へ更新しました」+ 目に見える変更（配色の変化など）を書く。リリース時に `## paracode-N（YYYY-MM-DD）` へ確定。

**リリース**: `NOTES.md` の「リリース手順（runbook）」に従う。タグは `v{新upstreamバージョン}-paracode-{N}`（N は連番継続、package.json は触らない）。push すると `para-release.yml` が5プラットフォームのビルド〜配信まで自動で走る。

**後片付け**: `git worktree remove`、ブランチ削除、`git replace -d <起点コミット>`。

---

## 判断をユーザーに委ねるべきポイント

- テーマ配色の解消方針（upstream の新デザイン追従 vs ブランド色維持）
- upstream の新実験機能を既定で有効にするか
- push とリリースのタイミング（**指示なくコミット・push しない**のがこのリポジトリのルール）

## 落とし穴（実測）

- `git log upstream/main` の全走査は10分でタイムアウトする。必ず日付や件数で絞る
- squash コミット時、rerere が解消を記録するので次回以降の同種コンフリクトは自動適用される
- `--user-data-dir` のパス長103文字制限（`TMPDIR=/tmp`）
- `npm run typecheck-client | tail` はパイプで exit code が隠れる。`> log; echo $?` で確認する
- 監査で `PARA-CODE:` マーカーが upstream 由来ファイルに紛れ込んでいるのを見つけることがある（本来は fork 新規ファイル専用）。実害は小さいが記録しておく
