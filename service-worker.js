"use strict";
/* =========================================================
   パチスロ農林水産業 - service-worker.js
   方針：完全オフライン優先（Cache Only）。自動更新・自動skipWaiting・
   自動reloadは一切行わない。更新はページ側からの手動操作のみで適用。
========================================================= */

// ⚠️ ファイルを更新するたびに必ずこの番号を上げること（app.js の SW_CACHE_NAME とも一致させる）
const CACHE_NAME = "norin-suisan-slot-v3";
const META_CACHE_NAME = CACHE_NAME + "-meta";

// 実在するファイル名と完全一致させること。service-worker.js自身は含めない。
const ASSETS = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

/* ---------- ユーティリティ ---------- */

function toFullUrl(relativePath) {
  return new URL(relativePath, self.location).href;
}

// Cache API の put/match キーは有効なhttp(s) URLである必要があるため、
// 実在しない仮想パスをこのオリジン配下のURLとして作る（実際にfetchはしない・ASSETSにも含めない）。
const DIAG_KEY = toFullUrl("./__diag__");

// 各ファイルを最大3回リトライしてキャッシュする。
// 1回目: no-store / 2回目: default / 3回目: no-store と交互に試す（モバイルでの不安定対策）。
async function cacheAssetWithRetry(cache, relativePath) {
  const fullUrl = toFullUrl(relativePath);
  const modes = ["no-store", "default", "no-store"];
  let lastError = "";

  for (let attempt = 0; attempt < modes.length; attempt++) {
    try {
      const response = await fetch(fullUrl, { cache: modes[attempt] });
      if (!response || !response.ok) {
        lastError = `HTTP ${response ? response.status : "no-response"}`;
        continue;
      }
      await cache.put(fullUrl, response.clone());
      return { success: true, url: fullUrl, attempts: attempt + 1 };
    } catch (e) {
      lastError = (e && e.message) ? e.message : String(e);
    }
  }
  return { success: false, url: fullUrl, error: lastError, attempts: modes.length };
}

async function cacheAllAssets() {
  const cache = await caches.open(CACHE_NAME);
  const results = await Promise.allSettled(
    ASSETS.map((path) => cacheAssetWithRetry(cache, path))
  );
  const summary = results.map((r) =>
    r.status === "fulfilled" ? r.value : { success: false, url: "(unknown)", error: String(r.reason) }
  );
  const diag = {
    at: Date.now(),
    expected: ASSETS.length,
    succeeded: summary.filter((s) => s.success).length,
    details: summary,
  };
  await saveDiagnostics(diag);
  return diag;
}

async function saveDiagnostics(diag) {
  try {
    const metaCache = await caches.open(META_CACHE_NAME);
    await metaCache.put(DIAG_KEY, new Response(JSON.stringify(diag), {
      headers: { "Content-Type": "application/json" },
    }));
  } catch (e) {
    // 診断情報の保存に失敗しても致命的ではないため握りつぶす
  }
}

async function loadDiagnostics() {
  try {
    const metaCache = await caches.open(META_CACHE_NAME);
    const res = await metaCache.match(DIAG_KEY);
    if (!res) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

/* ---------- install ---------- */
// 注意：ここで skipWaiting() は絶対に呼ばない（手動更新方式のため）
self.addEventListener("install", (event) => {
  event.waitUntil(cacheAllAssets());
});

/* ---------- activate ---------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== META_CACHE_NAME)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

/* ---------- fetch（Cache Only） ---------- */
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // GET以外、http(s)以外のリクエストはスルーする
  if (req.method !== "GET") return;
  if (!req.url.startsWith("http")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const indexUrl = toFullUrl("./index.html");
        const indexCached = await cache.match(indexUrl);
        if (indexCached) return indexCached;

        const direct = await cache.match(req);
        if (direct) return direct;

        return new Response(
          "オフラインで利用できません。一度オンライン環境でこのアプリを開き、キャッシュを作成してください。",
          { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;

      // クエリ文字列違いなどに対応するため、正規化したURLでも探す
      try {
        const normalized = new URL(req.url);
        normalized.search = "";
        const cached2 = await cache.match(normalized.href);
        if (cached2) return cached2;
      } catch (e) {
        // ignore
      }

      return new Response("", { status: 404 });
    })()
  );
});

/* ---------- message（ページ⇔SW通信） ---------- */
self.addEventListener("message", (event) => {
  const data = event.data || {};

  if (data.type === "CACHE_NOW") {
    event.waitUntil(
      (async () => {
        const diag = await cacheAllAssets();
        const clientsList = await self.clients.matchAll();
        clientsList.forEach((c) => c.postMessage({ type: "CACHE_NOW_DONE", diag }));
      })()
    );
    return;
  }

  if (data.type === "GET_DIAG") {
    event.waitUntil(
      (async () => {
        const diag = await loadDiagnostics();
        if (event.source) {
          event.source.postMessage({ type: "DIAG_RESULT", diag });
        }
      })()
    );
    return;
  }

  if (data.type === "SKIP_WAITING") {
    // ページ側の「更新する」ボタン押下時のみ呼ばれる（自動実行はしない）
    self.skipWaiting();
    return;
  }
});
