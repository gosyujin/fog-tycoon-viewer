# fog-tycoon-viewer

fog-tycoon の外出先用ビューア(静的ページ)。GitHub Pages に置く。**コード・鍵・データは含まない。**

開くと App key の入力画面が出て、Dropbox で認可(読み取りのみ)した端末だけが `points.json` を読める。
データは本体 `fog-tycoon` の `scripts/export.mjs` が Dropbox の App Folder(`/points.json`)に書く。

## セットアップ

1. Dropbox App Console で App Folder 型のアプリを作り、Permissions で `files.content.read` と `files.content.write` を有効にする。
2. Redirect URIs に Pages の URL(`https://note.gosyujin.com/fog-tycoon-viewer/`)を登録する。
3. この repo を GitHub に push し、Settings → Pages で `main` / root を公開する。
4. スマホで Pages を開き、App key を入力して認可する。

## 機能
- 霧(通った場所だけ晴れる) / ヒートマップ(右下の 🌫/🔥 ボタンで切替。通った場所を訪問日数で 青=1日・緑=2〜3日・黄=4〜9日・赤=10日〜 に色分けし、凡例を表示。選択はこの端末に記憶) / 軌跡(既定オフ) / 霧の濃さ / 晴れ半径 / 期間の切り替え(⚙ にまとめ、値はこの端末に記憶する)
- 現在地ボタン(下中央の ◎。起動時は現在地を表示(測位に失敗したら低精度で1回取り直す)。10分以内の再読み込み・復帰は最後の表示位置を維持。HTTPS が要るので Pages 上でだけ使える)
- リアルタイム追跡(◎の右の ●。押すと連続測位して軌跡(橙)と霧の晴れ範囲に即反映、画面は点けたまま。地図を動かすと追従が外れ、◎で戻る。追跡した点は保存しない)
- 地図の1本指ズーム(ダブルタップして指を離さず上下にドラッグ。向きは `app.js` の `ONE_FINGER_DIR` で反転できる)
- ボタン類はダブルタップでページが拡大しない(`touch-action: manipulation`。拡大縮小は地図だけ)
- 画面左下に `build <sha> (<時刻>)` を表示。起動時に最新のデプロイと比べ、古ければ読み直す(GitHub Actions が `build-info.js` を上書き。ローカルは `dev`)
- 通信できないときは端末に残した控えを表示

## 注意
- 霧の描画コードは本体 `fog-tycoon` の `app.js` と同じ。直すときは両方に反映する。
- `points.json` は行動履歴。Pages の URL は公開されるが、データは Dropbox 認可がないと読めない。
