// Upgrade only the unedited 0.2.0 example. A user's modified draft keeps its own route.
export async function previousStockChapter(doc) {
  if(doc?.id!=='tomorrow.chapter01'||!globalThis.crypto?.subtle)return false;
  const bytes=new TextEncoder().encode(JSON.stringify(doc));
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const hex=Array.from(digest,x=>x.toString(16).padStart(2,'0')).join('');
  return hex==='c2878be73a1e8a5c203a8772c57a436a19b21e8c1272bb56a2963121e17ea9db';
}
