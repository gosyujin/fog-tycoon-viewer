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
- コンパス(◎を長押し。地図が端末の向きに回り、向いている方向が上になる。もう一度長押しで北上に戻る。回転は leaflet-rotate。iOS は「モーションと方向」の許可が要る)
- リアルタイム追跡(◎の右の ●。押すと連続測位して軌跡(橙)と霧の晴れ範囲に即反映、画面は点けたまま。追従中は現在地が画面の中心に居続け、縮尺は変えない(追跡開始時だけ街区が見える縮尺まで寄る。追従中のズームは画面中心基準)。地図を1本指で動かすと追従が外れ、◎で戻る(2本指のピンチでは外れない)。追跡した点は保存しない。バックグラウンドや圏外を挟んで移動した区間は、軌跡を直線で結ばず切る)
- 地図の1本指ズーム(ダブルタップして指を離さず上下にドラッグ。向きは `app.js` の `ONE_FINGER_DIR` で反転できる)
- ボタン類はダブルタップでページが拡大しない(`touch-action: manipulation`。拡大縮小は地図だけ)
- 画面左下に `build <sha> (<時刻>)` を表示。起動時に最新のデプロイと比べ、古ければ読み直す(GitHub Actions が `build-info.js` を上書き。ローカルは `dev`)
- 地図タイルを端末にキャッシュ(`sw.js`。見たタイルだけを最大3000枚・14日間保存し、2回目以降は通信せずに表示。オフラインでも見たことのある場所は出る)。初期表示は前回の位置から始め、東京や日本全体を経由しない
- ⚙ の「Dawarich と同期」: Tailscale につながった Mac の同期サーバ(fog-tycoon の `scripts/sync-server.mjs`)に依頼し、Mac が Dawarich の最新データを書き出したら読み直して最新の軌跡にする。同期先の URL(Mac の `tailscale serve` の `https://…ts.net`)は ⚙ に入力し、この端末にだけ保存する
- 通信できないときは端末に残した控えを表示

## 注意
- 霧の描画コード (`Fog`) は本体 `fog-tycoon` の `app.js` と同じ(本体は地図が回らないが、回転対応のコードも同じものを入れてある)。直すときは両方に反映する。
- `points.json` は行動履歴。Pages の URL は公開されるが、データは Dropbox 認可がないと読めない。
