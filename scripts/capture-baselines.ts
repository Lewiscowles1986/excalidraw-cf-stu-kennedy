import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Capture visual baselines from the PRE-FIX `main` dev server.
 *
 * Usage (server on :5173 must be serving the `main` branch):
 *   bun scripts/capture-baselines.ts
 *
 * Web fonts are blocked so baselines are independent of the font-loading
 * behavior change introduced by the @import fix.
 *
 * Uses the SAME synthetic-event drawing helpers as tests/visual.spec.ts so
 * baselines and actual screenshots are produced identically.
 */

const BASE_URL = process.env.BASELINE_URL ?? 'http://localhost:5173';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.join(__dirname, '..', 'tests', 'visual', '__screenshots__');

fs.mkdirSync(OUT_DIR, { recursive: true });

async function openLanding(page) {
  await page.goto(`${BASE_URL}/`);
  await page.waitForSelector('.landing-title');
  await page.waitForTimeout(400);
}

async function openCanvas(page) {
  await page.goto(`${BASE_URL}/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#excalidraw-canvas');
  await page.waitForSelector('#toolbar');
  await page.waitForSelector('.toolbar-btn');
  await page.waitForTimeout(600);
}

async function allowSyntheticPointer(page) {
  await page.addInitScript(() => {
    const patch = () => {
      const proto = (window as any).Element.prototype;
      if ((proto as any).__pwPatched) return;
      (proto as any).__pwPatched = true;
      const origCap = proto.setPointerCapture;
      proto.setPointerCapture = function (pointerId: number) {
        try {
          return origCap.call(this, pointerId);
        } catch {
          /* synthetic pointer is not active — ignore */
        }
      };
      const origRel = proto.releasePointerCapture;
      proto.releasePointerCapture = function (pointerId: number) {
        try {
          return origRel.call(this, pointerId);
        } catch {
          /* synthetic pointer is not active — ignore */
        }
      };
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', patch);
    } else {
      patch();
    }
  });
}

async function selectTool(page, tool: string) {
  await page.evaluate((t) => {
    window.dispatchEvent(
      new CustomEvent('excalidraw:set-tool', { detail: { tool: t } })
    );
  }, tool);
  await page.waitForTimeout(80);
}

async function addText(page, x: number, y: number, text: string) {
  await page.evaluate(([tx, ty]) => {
    const canvas = document.getElementById('excalidraw-canvas')!;
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', {
        button: 0, bubbles: true, cancelable: true,
        pointerId: 9, pointerType: 'mouse', isPrimary: true,
        clientX: tx, clientY: ty,
      })
    );
  }, [x, y]);
  await page.waitForSelector('#text-editor');
  await page.keyboard.type(text);
  await page.evaluate(() =>
    (document.getElementById('text-editor') as HTMLTextAreaElement).blur()
  );
  await page.waitForTimeout(150);
}

async function drawShape(page, tool: string, x1: number, y1: number, x2: number, y2: number) {
  await selectTool(page, tool);
  await page.evaluate(([ax, ay, bx, by]) => {
    const canvas = document.getElementById('excalidraw-canvas')!;
    const opts = { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'mouse', isPrimary: true };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...opts, button: 0, clientX: ax, clientY: ay }));
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      canvas.dispatchEvent(new PointerEvent('pointermove', {
        ...opts,
        clientX: ax + ((bx - ax) * i) / steps,
        clientY: ay + ((by - ay) * i) / steps,
      }));
    }
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...opts, button: 0, clientX: bx, clientY: by }));
  }, [x1, y1, x2, y2]);
  await page.waitForTimeout(150);
}

async function drawFreedraw(page) {
  await selectTool(page, 'freedraw');
  await page.evaluate(() => {
    const canvas = document.getElementById('excalidraw-canvas')!;
    const opts = { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'mouse', isPrimary: true };
    const pts = [[70, 380], [100, 355], [120, 385], [150, 370], [190, 378], [230, 372]];
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...opts, button: 0, clientX: pts[0][0], clientY: pts[0][1] }));
    for (const [px, py] of pts.slice(1)) {
      canvas.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: px, clientY: py }));
    }
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...opts, button: 0, clientX: pts[pts.length - 1][0], clientY: pts[pts.length - 1][1] }));
  });
  await page.waitForTimeout(150);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});
await context.route('**fonts.googleapis.com**', (route) => route.abort());
await context.route('**fonts.gstatic.com**', (route) => route.abort());
const page = await context.newPage();
await allowSyntheticPointer(page);

await openLanding(page);
await page.screenshot({ path: path.join(OUT_DIR, 'landing-baseline.png') });
console.log('captured landing-baseline.png');

await openCanvas(page);
await page.screenshot({ path: path.join(OUT_DIR, 'canvas-baseline.png') });
console.log('captured canvas-baseline.png');

await drawShape(page, 'rectangle', 120, 160, 300, 300);
await drawShape(page, 'ellipse', 380, 160, 520, 280);
await drawFreedraw(page);
await selectTool(page, 'text');
await addText(page, 620, 180, 'Baseline');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT_DIR, 'canvas-drawn-baseline.png') });
console.log('captured canvas-drawn-baseline.png');

await selectTool(page, 'selection');
await page.waitForTimeout(200);
await page.click('.action-btn[title="Export drawing"]');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT_DIR, 'export-dialog-baseline.png') });
console.log('captured export-dialog-baseline.png');

await browser.close();
console.log('All baselines captured from', BASE_URL);