import { chromium } from 'playwright';

const BASE = 'http://localhost:3945';
const OUT = '/private/tmp/css-floor-mine/eye';
const themes = ['default', 'midnight', 'catppuccin'];

const markup = `
<div id="probe" style="position:relative;min-height:520px;background:var(--chrome-bg);padding:24px;display:flex;flex-direction:column;gap:18px;">
  <div class="launchpad" style="position:relative;height:180px;border:1px solid var(--chrome-border);">
    <div class="lp-aurora">
      <div class="lp-aurora__blob lp-aurora__blob--pink"></div>
      <div class="lp-aurora__blob lp-aurora__blob--green"></div>
      <div class="lp-aurora__blob lp-aurora__blob--amber"></div>
    </div>
    <div style="position:relative;z-index:1;display:flex;gap:6px;align-items:flex-end;height:40px;">
      <span class="lp-wave-bar"></span><span class="lp-wave-bar"></span><span class="lp-wave-bar"></span>
    </div>
    <button class="lp-action-card" style="--card-hue:#d3869b;width:200px;margin-top:12px;">
      <div class="lp-glow-layer"></div>
      <div class="card-icon"></div>
      <h3>CLONE</h3><p class="card-desc">desc</p><span class="card-count">3</span>
    </button>
  </div>
  <div style="display:flex;gap:16px;flex-wrap:wrap;">
    <div class="floating-pill"><span class="floating-pill__dot floating-pill__dot--transcribing"></span>Working…</div>
    <div class="capture-pill capture-pill--recording"><span class="capture-pill__dot"></span>Rec</div>
    <div class="ui-menu"><div class="ui-menu__item"><span class="ui-menu__label">Item</span></div></div>
    <div class="ui-dialog" style="width:160px;height:60px;">Dialog glass</div>
  </div>
  <div class="postcard" style="width:300px;"><div class="postcard__grain"></div><div class="postcard__stamp"></div>
    <div class="goal goal--mini"><div class="goal__track" style="position:relative;height:8px;--goal-pct:0.6;--goal-accent:#d3869b;"><div class="goal__fill"></div><div class="goal__shimmer"></div></div></div>
  </div>
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 760, height: 620 }, deviceScaleFactor: 1 });
await page.goto(`${BASE}/src/test/visual/harness.html`, { waitUntil: 'networkidle' });
await page.evaluate((m) => { document.body.innerHTML = m; }, markup);
await page.waitForTimeout(300);

const checks = await page.evaluate(() => {
  const cs = (sel) => getComputedStyle(document.querySelector(sel));
  return {
    auroraBlobAnim: cs('.lp-aurora__blob--pink').animationName,
    waveBarAnim: cs('.lp-wave-bar').animationName,
    breathRingAnim: getComputedStyle(document.querySelector('.lp-glow-layer'), '::after').animationName,
    pillDotAnim: cs('.floating-pill__dot').animationName,
    capturePillBackdrop: cs('.capture-pill').backdropFilter || cs('.capture-pill').webkitBackdropFilter,
    uiMenuBackdrop: cs('.ui-menu').backdropFilter || cs('.ui-menu').webkitBackdropFilter,
    uiDialogBackdrop: cs('.ui-dialog').backdropFilter || cs('.ui-dialog').webkitBackdropFilter,
    goalFillAnim: cs('.goal__fill').animationName,
    postcardAnim: cs('.postcard').animationName,
  };
});
console.log('COMPUTED CHECKS:', JSON.stringify(checks));

for (const t of themes) {
  await page.evaluate((th) => {
    if (th === 'default') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', th);
  }, t);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}-${t}.png` });
  console.log('screenshot', t);
}
await browser.close();
