"use strict";
/* =========================================================
   パチスロ農林水産業 - app.js
========================================================= */

/* ---------------------------------------------------------
   0. 定数定義
--------------------------------------------------------- */
const SYMBOLS = ["🌾", "🍅", "🧅", "🍆", "🥦", "🍓", "🌹", "🐖", "🐗", "🦌"];
// index: 0 稲穂 1 トマト 2 タマネギ 3 ナス 4 ブロッコリー 5 イチゴ 6 バラ 7 豚 8 イノシシ 9 シカ

const CELL = (function(){
  // CSSの --cell と一致させる（@media で変わるため実測する）
  const probe = document.createElement("div");
  probe.style.height = "var(--cell)";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.documentElement.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).height) || 78;
  probe.remove();
  return px;
})();

const REEL_COUNT = 3;
const REPEAT = 14; // ストリップに何セット並べるか
const STRIP_LEN = SYMBOLS.length * REPEAT;
const UNIT = SYMBOLS.length * CELL; // 1セット分のpx高さ（ループ単位）

const BET = 3; // 1回転あたりのベット額（万円）
const START_FUNDS = 100; // 自己資金（万円）
const MIN_CONTINUE_FUNDS = 3; // これ未満になったら終了
const MAX_SPINS = 100;

// 役定義：絵柄インデックス（KOYAKU_Cのみ複数候補）
const OUTCOMES = [
  { key: "HAZURE",    label: "ハズレ",   payout: 0,   symbol: null,        rare: false },
  { key: "KOYAKU_A",  label: "小役（稲穂）", payout: 3,   symbol: 0,           rare: false },
  { key: "KOYAKU_B",  label: "小役（トマト）", payout: 6,   symbol: 1,           rare: false },
  { key: "KOYAKU_C",  label: "小役（畑の恵み）", payout: 9,   symbol: [2, 3, 4],   rare: false },
  { key: "RARE_A",    label: "出荷額全国トップクラスの予感", payout: 20,  symbol: 6, rare: true,
    effect: "rare-a", flashClass: "flash-pink" },
  { key: "RARE_B",    label: "出荷額県下トップクラスの予感", payout: 40,  symbol: 5, rare: true,
    effect: "rare-b", flashClass: "flash-red" },
  { key: "RARE_C",    label: "畜産チャンス", payout: 70, symbol: 7, rare: true,
    effect: "rare-c", flashClass: "flash-yellow" },
  { key: "JACKPOT_A", label: "有害鳥獣出現", payout: 200, symbol: 8, rare: true,
    effect: "jackpot-a", flashClass: "flash-redblack" },
  { key: "JACKPOT_B", label: "ジビエチャンス", payout: 400, symbol: 9, rare: true,
    effect: "jackpot-b", flashClass: null },
];

// 設定1〜6の出現率（万分率・合計10000）順序はOUTCOMESと同じ
const SETTING_TABLE = {
  1: [8800, 650, 280, 150, 70, 30, 14, 5, 1],
  2: [8500, 700, 320, 180, 160, 80, 40, 15, 5],
  3: [8200, 750, 350, 200, 250, 140, 80, 25, 5],
  4: [7800, 800, 380, 230, 350, 220, 140, 60, 20],
  5: [6800, 900, 450, 300, 600, 420, 300, 180, 50],
  6: [5800, 1000, 550, 370, 850, 620, 500, 250, 60],
};

const HISTORY_KEY = "norin_suisan_slot_history_v1";

/* ---------------------------------------------------------
   1. 状態
--------------------------------------------------------- */
const state = {
  setting: null,
  spinCount: 0,
  funds: START_FUNDS,
  totalBet: 0,
  totalPayout: 0,
  jackpotCount: 0,
  maxSingleWin: 0,
  spinning: false,
  ended: false,
  sessionStartAt: null,
};

// リールごとの現在位置（px）
const reelPos = [0, UNIT * 0.3, UNIT * 0.6];
let reelRAF = [null, null, null];

/* ---------------------------------------------------------
   2. DOM参照
--------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const screens = {
  title: $("screen-title"),
  main: $("screen-main"),
  history: $("screen-history"),
};

const el = {
  settingGrid: $("setting-grid"),
  btnStartGame: $("btn-start-game"),
  btnShowHistory: $("btn-show-history"),
  btnOpenDiag: $("btn-open-diag"),

  displaySetting: $("display-setting"),
  displaySpinCount: $("display-spincount"),
  displayFunds: $("display-funds"),
  resultBanner: $("result-banner"),
  btnSpin: $("btn-spin"),
  btnQuit: $("btn-quit"),
  reelZone: $("reel-zone"),
  effectOverlay: $("effect-overlay"),

  historyList: $("history-list"),
  btnHistoryBack: $("btn-history-back"),
  btnHistoryClear: $("btn-history-clear"),

  modalEnd: $("modal-end"),
  endTitle: $("end-title"),
  endMessage: $("end-message"),
  endPayout: $("end-payout"),
  endBet: $("end-bet"),
  endSpins: $("end-spins"),
  endJackpots: $("end-jackpots"),
  btnEndHistory: $("btn-end-history"),
  btnEndTitle: $("btn-end-title"),

  updateBanner: $("update-banner"),
  btnUpdateApply: $("btn-update-apply"),
  btnUpdateLater: $("btn-update-later"),

  diagPanel: $("diag-panel"),
  diagSummary: $("diag-summary"),
  diagUrlList: $("diag-url-list"),
  diagFailList: $("diag-fail-list"),
  btnCheckUpdate: $("btn-check-update"),
  btnCacheNow: $("btn-cache-now"),
  btnDiagRefresh: $("btn-diag-refresh"),
  btnDiagClose: $("btn-diag-close"),
};

const strips = [$("strip-0"), $("strip-1"), $("strip-2")];

/* ---------------------------------------------------------
   3. 画面遷移
--------------------------------------------------------- */
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("is-active"));
  screens[name].classList.add("is-active");
}

/* ---------------------------------------------------------
   4. リール初期構築
--------------------------------------------------------- */
function buildStrips() {
  strips.forEach((stripEl, idx) => {
    let html = "";
    for (let i = 0; i < STRIP_LEN; i++) {
      html += `<div class="symbol-cell">${SYMBOLS[i % SYMBOLS.length]}</div>`;
    }
    stripEl.innerHTML = html;
    setReelTransform(idx, reelPos[idx], false);
  });
}

function setReelTransform(reelIdx, pos, withTransition) {
  const stripEl = strips[reelIdx];
  stripEl.style.transition = withTransition ? "transform .65s cubic-bezier(.18,.86,.32,1.07)" : "none";
  stripEl.style.transform = `translateY(${CELL - pos}px)`;
}

/* ---------------------------------------------------------
   5. 抽籤
--------------------------------------------------------- */
function drawOutcome(setting) {
  const table = SETTING_TABLE[setting];
  const r = Math.floor(Math.random() * 10000);
  let acc = 0;
  for (let i = 0; i < table.length; i++) {
    acc += table[i];
    if (r < acc) return OUTCOMES[i];
  }
  return OUTCOMES[0];
}

function resolveSymbolIndex(outcome) {
  if (outcome.symbol === null) return null;
  if (Array.isArray(outcome.symbol)) {
    return outcome.symbol[Math.floor(Math.random() * outcome.symbol.length)];
  }
  return outcome.symbol;
}

function randomLoseSymbols() {
  // 3つが一致しないようにランダム生成
  let a, b, c;
  do {
    a = Math.floor(Math.random() * SYMBOLS.length);
    b = Math.floor(Math.random() * SYMBOLS.length);
    c = Math.floor(Math.random() * SYMBOLS.length);
  } while (a === b && b === c);
  return [a, b, c];
}

/* ---------------------------------------------------------
   6. リール回転エンジン
--------------------------------------------------------- */
const SPIN_SPEED = 1400; // px/sec

function startSpinAnim(reelIdx) {
  let last = performance.now();
  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;
    reelPos[reelIdx] += SPIN_SPEED * dt;
    if (reelPos[reelIdx] >= UNIT * 4) {
      reelPos[reelIdx] -= UNIT * 4; // 周期的にリセット（見た目は同じ）
    }
    setReelTransform(reelIdx, reelPos[reelIdx], false);
    reelRAF[reelIdx] = requestAnimationFrame(frame);
  }
  reelRAF[reelIdx] = requestAnimationFrame(frame);
}

function stopReelAt(reelIdx, targetSymbolIndex) {
  if (reelRAF[reelIdx]) {
    cancelAnimationFrame(reelRAF[reelIdx]);
    reelRAF[reelIdx] = null;
  }
  const current = reelPos[reelIdx];
  const currentFlat = current / CELL;
  const loops = 8 + reelIdx; // リールごとに微妙にループ数を変えて自然に
  let minFlat = Math.ceil(currentFlat) + 4 + loops * SYMBOLS.length;
  const mod = ((minFlat % SYMBOLS.length) + SYMBOLS.length) % SYMBOLS.length;
  const diff = ((targetSymbolIndex - mod) + SYMBOLS.length) % SYMBOLS.length;
  const targetFlat = minFlat + diff;
  const targetPos = targetFlat * CELL;
  reelPos[reelIdx] = targetPos;
  setReelTransform(reelIdx, targetPos, true);
}

function normalizeReelPositions() {
  // アイドル中にpxを小さく保つ（見た目は同一）
  reelPos.forEach((p, i) => {
    const normalized = p % UNIT;
    reelPos[i] = normalized;
    setReelTransform(i, normalized, false);
  });
}

/* ---------------------------------------------------------
   7. 演出
--------------------------------------------------------- */
function clearEffect() {
  el.effectOverlay.className = "effect-overlay";
  el.effectOverlay.innerHTML = "";
  el.reelZone.classList.remove("shake");
}

function showEffect(outcome) {
  clearEffect();
  el.effectOverlay.classList.add("is-active");
  if (outcome.flashClass) el.effectOverlay.classList.add(outcome.flashClass);

  const textEl = document.createElement("div");
  textEl.className = "effect-text";
  textEl.textContent = outcome.label;
  el.effectOverlay.appendChild(textEl);

  if (outcome.effect === "rare-a") {
    spawnParticles("🌹", 16, "fallDown", 2.2);
  } else if (outcome.effect === "rare-b") {
    spawnParticles("🍓", 16, "fallDown", 2.0);
  } else if (outcome.effect === "rare-c") {
    spawnParticles("🐖", 8, "flyAcross", 1.6);
  } else if (outcome.effect === "jackpot-a") {
    el.reelZone.classList.add("shake");
    spawnParticles("🐗", 6, "flyAcross", 1.0);
  } else if (outcome.effect === "jackpot-b") {
    const rb = document.createElement("div");
    rb.className = "rainbow-border";
    el.effectOverlay.appendChild(rb);
    spawnParticles("✨", 14, "confettiFall", 2.4);
    spawnParticles("🎉", 6, "confettiFall", 2.2);
  }
}

function spawnParticles(emoji, count, animName, durationBase) {
  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.className = "particle";
    p.textContent = emoji;
    const startX = Math.random() * 90;
    const startY = animName === "flyAcross" ? Math.random() * 80 : -10;
    p.style.left = startX + "%";
    p.style.top = startY + "%";
    const dur = durationBase + Math.random() * 1.2;
    const delay = Math.random() * 1.4;
    p.style.animation = `${animName} ${dur}s ease-in ${delay}s 2`;
    el.effectOverlay.appendChild(p);
  }
}

/* ---------------------------------------------------------
   8. スピン本体
--------------------------------------------------------- */
function updateHUD() {
  el.displaySetting.textContent = state.setting;
  el.displaySpinCount.textContent = state.spinCount;
  el.displayFunds.textContent = state.funds;
}

function setSpinEnabled(enabled) {
  el.btnSpin.disabled = !enabled;
  el.btnQuit.disabled = !enabled;
}

function onSpinPressed() {
  if (state.spinning || state.ended) return;
  if (state.funds < BET) return;
  if (state.spinCount >= MAX_SPINS) return;

  state.spinning = true;
  setSpinEnabled(false);
  el.resultBanner.textContent = "";
  clearEffect();

  state.spinCount += 1;
  state.funds -= BET;
  state.totalBet += BET;
  updateHUD();

  // 抽籤
  const outcome = drawOutcome(state.setting);
  const isRare = outcome.rare;

  // リール回転開始
  for (let i = 0; i < REEL_COUNT; i++) startSpinAnim(i);

  const baseDelay = isRare ? 5000 : 2000;

  if (isRare) {
    setTimeout(() => showEffect(outcome), 300);
  }

  setTimeout(() => {
    resolveSpin(outcome);
  }, baseDelay);
}

function resolveSpin(outcome) {
  let targets;
  if (outcome.key === "HAZURE") {
    targets = randomLoseSymbols();
  } else {
    const s = resolveSymbolIndex(outcome);
    targets = [s, s, s];
  }

  const stopGap = 380;
  for (let i = 0; i < REEL_COUNT; i++) {
    setTimeout(() => stopReelAt(i, targets[i]), i * stopGap);
  }

  const totalStopTime = (REEL_COUNT - 1) * stopGap + 750;
  setTimeout(() => finishSpin(outcome), totalStopTime);
}

function finishSpin(outcome) {
  clearEffect();
  normalizeReelPositions();

  if (outcome.payout > 0) {
    state.funds += outcome.payout;
    state.totalPayout += outcome.payout;
    if (outcome.payout > state.maxSingleWin) state.maxSingleWin = outcome.payout;
    if (outcome.key.startsWith("JACKPOT")) state.jackpotCount += 1;
    el.resultBanner.textContent = `${SYMBOLS[Array.isArray(outcome.symbol) ? outcome.symbol[0] : outcome.symbol] || ""} ${outcome.label}！ +${outcome.payout}万円`;
  } else {
    el.resultBanner.textContent = "ハズレ…";
  }

  updateHUD();
  state.spinning = false;

  if (state.funds < MIN_CONTINUE_FUNDS) {
    endSession("funds", `自己資金がなくなり、\n営農を続けられなくなりました(ﾉД\`･ﾞ)`);
    return;
  }
  if (state.spinCount >= MAX_SPINS) {
    endSession("maxspins", `${MAX_SPINS}回転に到達しました。\nお疲れさまでした！`);
    return;
  }
  setSpinEnabled(true);
}

function onQuitPressed() {
  if (state.spinning || state.ended) return;
  endSession("quit", "営農を終了しました。\nお疲れさまでした！");
}

/* ---------------------------------------------------------
   9. セッション終了・実績保存
--------------------------------------------------------- */
function endSession(reasonKey, message) {
  state.ended = true;
  setSpinEnabled(false);

  const reasonLabelMap = {
    funds: "資金不足により終了",
    maxspins: "100回転に到達し終了",
    quit: "「やめる」を押して終了",
  };

  const record = {
    at: Date.now(),
    setting: state.setting,
    spins: state.spinCount,
    totalBet: state.totalBet,
    totalPayout: state.totalPayout,
    finalFunds: state.funds,
    jackpotCount: state.jackpotCount,
    maxSingleWin: state.maxSingleWin,
    reason: reasonLabelMap[reasonKey] || reasonKey,
  };
  saveHistoryRecord(record);

  el.endTitle.textContent = reasonKey === "funds" ? "営農終了" : "結果";
  el.endMessage.textContent = message;
  el.endPayout.textContent = state.totalPayout;
  el.endBet.textContent = state.totalBet;
  el.endSpins.textContent = state.spinCount;
  el.endJackpots.textContent = state.jackpotCount;
  el.modalEnd.classList.remove("hidden");
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveHistoryRecord(record) {
  const list = loadHistory();
  list.unshift(record);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch (e) {
    console.error("履歴の保存に失敗しました", e);
  }
}

function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch (e) {}
}

function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderHistory() {
  const list = loadHistory();
  if (list.length === 0) {
    el.historyList.innerHTML = `<div class="history-empty">まだ実績がありません。<br>営農をスタートしてみましょう。</div>`;
    return;
  }
  el.historyList.innerHTML = list.map((r) => {
    const net = r.totalPayout - r.totalBet;
    const netText = (net >= 0 ? "+" : "") + net;
    return `
      <div class="history-item">
        <div class="hi-top"><span>設定${r.setting}</span><span>${formatDate(r.at)}</span></div>
        <div class="hi-grid">
          <span>回転数: ${r.spins}回</span>
          <span>大当たり: ${r.jackpotCount}回</span>
          <span>投資金額: ${r.totalBet}万円</span>
          <span>獲得金額: ${r.totalPayout}万円</span>
          <span>最終所持金: ${r.finalFunds}万円</span>
          <span>1プレイ最高: ${r.maxSingleWin}万円</span>
        </div>
        <div class="hi-grid">
          <span>収支: ${netText}万円</span>
        </div>
        <div class="hi-reason">${r.reason}</div>
      </div>
    `;
  }).join("");
}

/* ---------------------------------------------------------
   10. ゲーム開始・リセット
--------------------------------------------------------- */
let selectedSetting = null;

function resetState() {
  state.spinCount = 0;
  state.funds = START_FUNDS;
  state.totalBet = 0;
  state.totalPayout = 0;
  state.jackpotCount = 0;
  state.maxSingleWin = 0;
  state.spinning = false;
  state.ended = false;
  state.sessionStartAt = Date.now();
}

function startGame() {
  if (!selectedSetting) {
    alert("設定を選択してください。");
    return;
  }
  resetState();
  state.setting = selectedSetting;
  updateHUD();
  el.resultBanner.textContent = "";
  clearEffect();
  setSpinEnabled(true);
  showScreen("main");
}

/* ---------------------------------------------------------
   11. イベント登録
--------------------------------------------------------- */
function initSettingButtons() {
  const buttons = el.settingGrid.querySelectorAll(".setting-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("is-selected"));
      btn.classList.add("is-selected");
      selectedSetting = parseInt(btn.dataset.setting, 10);
    });
  });
}

function initEvents() {
  initSettingButtons();
  el.btnStartGame.addEventListener("click", startGame);
  el.btnShowHistory.addEventListener("click", () => {
    renderHistory();
    showScreen("history");
  });
  el.btnHistoryBack.addEventListener("click", () => showScreen("title"));
  el.btnHistoryClear.addEventListener("click", () => {
    if (confirm("実績をすべて削除しますか？この操作は元に戻せません。")) {
      clearHistory();
      renderHistory();
    }
  });

  el.btnSpin.addEventListener("click", onSpinPressed);
  el.btnQuit.addEventListener("click", onQuitPressed);

  el.btnEndHistory.addEventListener("click", () => {
    el.modalEnd.classList.add("hidden");
    renderHistory();
    showScreen("history");
  });
  el.btnEndTitle.addEventListener("click", () => {
    el.modalEnd.classList.add("hidden");
    showScreen("title");
  });

  el.btnOpenDiag.addEventListener("click", () => {
    el.diagPanel.classList.remove("hidden");
    refreshDiagPanel();
  });
  el.btnDiagClose.addEventListener("click", () => el.diagPanel.classList.add("hidden"));
}

/* ===========================================================
   12. PWA：Service Worker登録・更新バナー・診断パネル
   ※ CACHE_NAME は service-worker.js 側と必ず一致させること
=========================================================== */
const SW_CACHE_NAME = "norin-suisan-slot-v2"; // ⚠️ service-worker.js の CACHE_NAME と同期させる
const EXPECTED_ASSET_COUNT = 6; // index.html, style.css, app.js, manifest.json, icon-192.png, icon-512.png

let swReg = null;
let cacheNowResponded = true;

function setUpdateBannerVisible(visible) {
  el.updateBanner.classList.toggle("hidden", !visible);
}

function showUpdateBanner(reg) {
  setUpdateBannerVisible(true);
  el.btnUpdateApply.onclick = () => {
    if (!reg.waiting) return;
    reg.waiting.postMessage({ type: "SKIP_WAITING" });
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => { window.location.reload(); },
      { once: true }
    );
  };
  el.btnUpdateLater.onclick = () => setUpdateBannerVisible(false);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./service-worker.js", {
        updateViaCache: "none",
      });
      swReg = reg;

      // ページロード時点で既にwaitingが存在する場合も検知する
      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdateBanner(reg);
      }

      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && reg.waiting && navigator.serviceWorker.controller) {
            showUpdateBanner(reg);
          }
        });
      });
    } catch (e) {
      console.error("Service Worker登録に失敗しました", e);
    }
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type === "CACHE_NOW_DONE") {
      cacheNowResponded = true;
      renderDiagFromSW(data.diag);
      refreshDiagCacheList();
      alert(`キャッシュの再取得が完了しました（成功 ${data.diag.succeeded}/${data.diag.expected}）`);
    } else if (data.type === "DIAG_RESULT") {
      renderDiagFromSW(data.diag);
    }
  });
}

function requestStoragePersist() {
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted().then((already) => {
      if (already) {
        window.__persisted = true;
        return;
      }
      navigator.storage.persist().then((granted) => {
        window.__persisted = granted;
      });
    });
  } else {
    window.__persisted = null; // 非対応
  }
}

function swStatusText() {
  if (!swReg) return "未登録";
  if (swReg.installing) return "installing";
  if (swReg.waiting) return "waiting（更新待ち）";
  if (swReg.active) return "active（稼働中）";
  return "不明";
}

function persistText() {
  if (window.__persisted === true) return "許可済み";
  if (window.__persisted === false) return "未許可";
  if (window.__persisted === null) return "このブラウザは非対応";
  return "確認中...";
}

async function refreshDiagCacheList() {
  try {
    const cache = await caches.open(SW_CACHE_NAME);
    const keys = await cache.keys();
    const urls = keys.map((k) => k.url);
    el.diagUrlList.textContent = urls.length ? urls.join("\n") : "(キャッシュは空です)";
    return urls.length;
  } catch (e) {
    el.diagUrlList.textContent = "キャッシュ取得エラー: " + e.message;
    return 0;
  }
}

async function refreshDiagPanel() {
  const cachedCount = await refreshDiagCacheList();
  const lines = [
    `SW登録状態: ${swStatusText()}`,
    `controller: ${navigator.serviceWorker && navigator.serviceWorker.controller ? "あり" : "なし"}`,
    `ストレージ永続化: ${persistText()}`,
    `キャッシュ済みファイル数: ${cachedCount} / 期待値 ${EXPECTED_ASSET_COUNT}`,
  ];
  el.diagSummary.textContent = lines.join("\n");

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "GET_DIAG" });
  } else {
    el.diagFailList.textContent = "SWがこのページを制御していないため取得できません。";
  }
}

function renderDiagFromSW(diag) {
  if (!diag) {
    el.diagFailList.textContent = "情報がありません。";
    return;
  }
  const fails = (diag.details || []).filter((d) => !d.success);
  el.diagFailList.textContent = fails.length
    ? fails.map((f) => `${f.url}\n  → ${f.error || "原因不明"}`).join("\n\n")
    : `直近の失敗はありません（成功 ${diag.succeeded}/${diag.expected}）`;
}

function initPwaButtons() {
  el.btnCheckUpdate.addEventListener("click", async () => {
    if (!swReg) {
      alert("Service Workerが未登録です。");
      return;
    }
    try {
      await swReg.update();
    } catch (e) {
      console.error(e);
    }
    setTimeout(() => {
      if (swReg.waiting && navigator.serviceWorker.controller) {
        showUpdateBanner(swReg);
      } else {
        alert("現在お使いのバージョンが最新です。");
      }
    }, 500);
  });

  el.btnCacheNow.addEventListener("click", () => {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
      alert("Service Workerがこのページを制御していません。ページを再読み込みしてからお試しください。");
      return;
    }
    cacheNowResponded = false;
    navigator.serviceWorker.controller.postMessage({ type: "CACHE_NOW" });
    setTimeout(() => {
      if (!cacheNowResponded) {
        alert("3秒以内に応答がありませんでした。古いService Workerが原因の可能性があります。一度ページを再読み込みしてお試しください。");
      }
    }, 3000);
  });

  el.btnDiagRefresh.addEventListener("click", refreshDiagPanel);
}

/* ---------------------------------------------------------
   13. 初期化
--------------------------------------------------------- */
function init() {
  buildStrips();
  initEvents();
  initPwaButtons();
  registerServiceWorker();
  requestStoragePersist();
  showScreen("title");
}

document.addEventListener("DOMContentLoaded", init);
