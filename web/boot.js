import('./app.js').catch((error) => {
  const el = document.getElementById('loadHint');
  el.textContent = '无法打开排练室。请更新 Android System WebView 后重试。';
  console.error(error);
});
