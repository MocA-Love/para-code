# Vendored serve-sim

PARA-CODE: fork-owned directory (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

このディレクトリは npm の `serve-sim@0.1.49`（Apache-2.0, Copyright 2026 Evan Bacon, https://github.com/EvanBacon/serve-sim ）の公開物のうち、シミュレータのホストの子プロセス（`../../paradisSimulatorHostMain.ts`）が使う分だけを、手を加えずに置いたものです。ホストは serve-sim の CLI を起こさず、公開の export `serve-sim/middleware`（`dist/middleware.js` の `simMiddleware`）を組み込んで Unix ソケットだけで待ち受けます（q.html Q585 の D1）。

- `package.json` — `"type": "module"` が ESM として読むのに要る
- `LICENSE` — Apache-2.0 の全文。npm の公開物には入っていないので、GitHub のリポジトリのもの（2026-11-08 取得）を置いた。リポジトリに NOTICE は無い
- `dist/middleware.js` — ミドルウェア（bundle 済み。外から読むのは `ws` だけで、本体の `node_modules` のものを使う）
- `dist/native/serve-sim-native.node` — 映像と HID の N-API アドオン（Mach-O、universal）
- `dist/simduo/serve-sim-duo-hid` — iPhone Duo の開閉の補助（Mach-O）
- `dist/simax/serve-sim-ax-settings` — 表示の設定の補助（Mach-O）

カメラ（`dist/simcam/`）、3D の描画（`dist/simduo/serve-sim-duo-render`）、CLI（`dist/serve-sim.js`）、ソースは使わないので入れていない（q.html Q585 の D4）。`native.ts` は `dist/native/` から `../simduo/serve-sim-duo-hid` を引くので、`dist/` の下の並びは公開物のまま保つ。

## 入力の WebSocket（`/helper/<udid>/ws`）で届く種類

ホストが upgrade を通すのはこの 1 本だけです。serve-sim 0.1.49 では、この口の受け手は `src/device-session.ts` の `attachHidSocket` → `handleHidMessage` で、先頭の 1 バイトの種類ごとに次の操作だけをします（2026-11-08 に公開物の `src/` と `Sources/SimNative/` を読んで確認）。シェルを動かす種類・ファイルを読み書きする種類はありません（シェルは別の口 `/exec`・`/exec-ws` で、ホストの許可の一覧の外）。知らない種類は何もせずに捨てます。

| 種類 | 中身 | 起こすもの |
|---|---|---|
| 0x03 | 1 本指のタッチ（0〜1 の座標） | HID |
| 0x04 | ボタン（名前、または HID の page/usage）。`home` は SpringBoard を `xcrun simctl launch <udid> com.apple.springboard` で前に出す（引数は固定） | HID・固定の simctl |
| 0x05 | 2 本指のタッチ（ピンチ） | HID |
| 0x06 | キー（HID の usage） | HID |
| 0x07 | 回転 | HID |
| 0x08 | Core Animation の表示の診断の切り替え（`setCADebugOption`） | シミュレータの表示 |
| 0x09 | メモリ警告を送る | シミュレータ |
| 0x0a | Digital Crown | HID |
| 0x0b | スクロール | HID |
| 0x0c | ソフトウェアキーボードの切り替え | HID |
| 0x0d | 映像の大きさの希望（キャプチャの解像度） | 映像 |
| 0x0e | 開閉（姿勢か角度）。Duo では `serve-sim-duo-hid` を `xcrun simctl spawn <udid>` で起こし、数値だけの行を送る | HID・固定の simctl |

どれも利用者本人の権限でそのシミュレータを操作するだけなので、ホストでは種類を絞っていません。版を上げるときは、この表を新しい版の `handleHidMessage` と突き合わせ直し、シェル・ファイル・任意の実行ファイルを扱う種類が増えていたら、ホストで upgrade の後のフレームを見て止める形にすること。

リポジトリの `.gitignore` はすべての `dist` を無視するので、このフォルダの `.gitignore` で `dist/` だけ戻している。

## 更新手順

`build/paradis/simulator/vendorServeSim.ts` の版・tgz の sha256・ファイルごとの sha256 の表を直してから、次を実行する（tgz を落として sha256 を確かめ、必要な分だけ展開する）。

```sh
node build/paradis/simulator/vendorServeSim.ts
node build/paradis/simulator/vendorServeSim.ts --check   # 置いたファイルが表と同じか（通信しない）
```

版を上げたら、`../../../common/paradisSimulator.ts` の `PARADIS_SERVE_SIM_VERSION`、`ThirdPartyNotices.txt`、`NOTES.md` の「コメントを書けないファイルへの変更一覧」の版も直す。
