<!-- PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md. -->

# browserExtensions — 内蔵ブラウザへの同梱Chrome拡張

内蔵ブラウザ（browserView）の Electron セッションへ、同梱した Chrome 拡張をロードする機能。
ロード実体は `electron-main/paradisBrowserExtensions.ts`、呼び出し点は
`src/vs/platform/browserView/electron-main/browserSession.ts` の `configure()`（PARA-PATCH 1行）。

## 同梱している拡張（vendored、`electron-main/media/` 配下）

| ディレクトリ | 拡張 | バージョン | 取得元 | ライセンス |
|---|---|---|---|---|
| `media/react-devtools/` | React Developer Tools | 7.0.1 (2026-07-04 取得) | Chrome Web Store `fmkadmapgofadopljbjfkapdkoienihi` の CRX3 を展開 | MIT (facebook/react) |

## 更新手順

1. CRX を取得: `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=<Chromeバージョン>&acceptformat=crx2,crx3&x=id%3D<拡張ID>%26uc`
2. CRX3 ヘッダ（`Cr24` マジック + 4byte version + 4byte header 長 + header）を除去して ZIP として展開
3. `media/<拡張名>/` を丸ごと差し替え、この表のバージョンと取得日を更新

## 制約（Electron の拡張サポートは部分実装）

- unpacked のみロード可能。ストアからのインストール・自動更新は無い（更新は上記の手動手順）
- browser action（ツールバーアイコン + ポップアップ UI）と Native Messaging は動作しない
- devtools_page ベースの拡張（React DevTools 等）が主対象。内蔵ブラウザの「Developer Tools」で
  DevTools を開くと React / Profiler タブが現れる
- persistent なセッション（Global / Workspace スコープ）にのみロードされる。Ephemeral セッションは
  in-memory のため Electron 側の制約でロード不可

## リポジトリ運用上の注意

`media/` 配下はサードパーティのビルド済み成果物なので、hygiene / eslint / stylelint から除外している
（`build/filters.ts`、`.eslint-ignore` の PARA-PATCH）。マーカーコメントも埋め込まない
（`NOTES.md` の「コメントを書けないファイルへの変更一覧」参照）。
