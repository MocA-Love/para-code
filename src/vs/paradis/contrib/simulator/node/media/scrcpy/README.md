# Vendored scrcpy-server

PARA-CODE: fork-owned directory (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

このディレクトリは scrcpy v5.0.1（Apache-2.0, Copyright (C) 2018 Genymobile, Copyright (C) 2018-2026 Romain Vimont, https://github.com/Genymobile/scrcpy ）のリリースの `scrcpy-server-v5.0.1` を、手を加えずに置いたものです（q.html Q585 の ⑥b・D3）。Android のシミュレータ（エミュレータ・実機）の映像と操作に使います。

- `scrcpy-server-v5.0.1.jar` — 端末（Android）の上で `app_process` が読む server。shared process（`../../android/paradisScrcpySession.ts`）が `adb push` で端末の `/data/local/tmp/scrcpy-server.jar` へ送り、`adb reverse` で端末から fork の待ち受けへつながらせる。Mach-O ではないので、macOS の署名・公証の対象ではない。リリースの sha256 は `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`
- `LICENSE` — Apache-2.0 の全文（リポジトリの v5.0.1 のタグのもの。2026-11-08 取得）。リポジトリに NOTICE は無い

adb は同梱しない（Android SDK の利用規約 3.4。利用者の Android SDK のものを使う）。

## 更新手順

scrcpy の client と server の通信の形は版ごとに変わる（scrcpy の `doc/develop.md`）。版を上げるときは、`build/paradis/simulator/vendorScrcpy.ts` の版と sha256 を直してから実行し、`../../../common/paradisScrcpy.ts`（`PARADIS_SCRCPY_VERSION`、server の引数、映像の包みと操作のメッセージの形）を新しい版の server・client のソースと突き合わせ直す。

```sh
node build/paradis/simulator/vendorScrcpy.ts
node build/paradis/simulator/vendorScrcpy.ts --check   # 置いたファイルが表と同じか（通信しない）
```

`ThirdPartyNotices.txt` と `NOTES.md` の「コメントを書けないファイルへの変更一覧」の版も直す。
