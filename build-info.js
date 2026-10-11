/**
 * このファイルは GitHub Actions のデプロイ時に、実際のコミットSHAとビルド日時で
 * 上書きされる(.github/workflows/deploy-pages.yml 参照)。ローカルで開いたときは
 * このデフォルト値が使われる。
 */
window.BUILD_INFO = {
  sha: 'dev',
  time: 'ローカル環境',
};
