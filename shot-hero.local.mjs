import { chromium } from '@playwright/test';
const b = await chromium.launchPersistentContext('/tmp/claude-1000/-home-ubuntu-github-VoiceStudio/c1a48e57-40e9-4f45-8111-ea6bd6b2ee68/scratchpad/pw-nocors', { args: ['--disable-web-security'], viewport: { width: 1440, height: 900 } });
const p = await b.newPage();
await p.goto('http://127.0.0.1:5199', { waitUntil: 'networkidle' });
await p.waitForTimeout(7000);
await p.screenshot({ path: '/tmp/claude-1000/-home-ubuntu-github-VoiceStudio/c1a48e57-40e9-4f45-8111-ea6bd6b2ee68/scratchpad/hero-shot12.png', clip: { x: 0, y: 0, width: 1440, height: 320 } });
await b.close();
