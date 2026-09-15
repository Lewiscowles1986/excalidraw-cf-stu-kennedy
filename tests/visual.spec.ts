import { test, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Visual regression tests for the CSS @import fix.
 *
 * Baselines are captured from the pre-fix `main` build and stored in
 * tests/visual/__screenshots__/*-baseline.png (see scripts/capture-baselines.ts).
 *
 * IMPORTANT: the fix intentionally changes font rendering (on `main` the
 * misplaced @import was dropped from prod builds so web fonts never loaded).
 * So baselines must be captured WITH web fonts blocked, to isolate
 * layout/geometry from font differences. A separate test asserts the NEW
 * behavior: web fonts now load successfully.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOTS_DIR = path.join(__dirname, 'visual', '__screenshots__');

// Block the Google Fonts @import so baseline (main, where the import was
// silently dropped) and fixed build render with identical system fonts.
async function blockWebFonts(context) {
  await context.route('**fonts.googleapis.com**', (route) => route.abort());
  await context.route('**fonts.gstatic.com**', (route) => route.abort());
}

// The app calls setPointerCapture/releasePointerCapture in its pointer
// handlers; with synthetic PointerEvents (no active pointer) those throw and
// abort element creation. addInitScript re-applies the patch on navigation.
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

async function openLanding(page) {
  await page.goto('/');
  await page.waitForSelector('.landing-title');
  await page.waitForTimeout(400);
}

async function openCanvas(page) {
  await page.goto('/new', { waitUntil: 'networkidle' });
  await page.waitForSelector('#excalidraw-canvas');
  await page.waitForSelector('#toolbar');
  await page.waitForSelector('.toolbar-btn');
  await page.waitForTimeout(600);
}

// Select a tool via the same CustomEvent the toolbar dispatches.
async function selectTool(page, tool: string) {
  await page.evaluate((t) => {
    window.dispatchEvent(
      new CustomEvent('excalidraw:set-tool', { detail: { tool: t } })
    );
  }, tool);
  await page.waitForTimeout(80);
}

// Create a text element with synthetic pointerdown (no default focus
// behavior, so the textarea keeps focus), type, then commit via blur().
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

function comparePngs(bufA: Buffer, bufB: Buffer) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  let diff = 0;
  const total = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) > 0 ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > 0 ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > 0
    ) {
      diff++;
    }
  }
  return diff / total;
}

function baselinePath(name: string): string {
  return path.join(SHOTS_DIR, `${name}-baseline.png`);
}

async function expectMatchesBaseline(page, name: string, maxDiffRatio = 0.001) {
  const buf = await page.screenshot();
  const base = fs.readFileSync(baselinePath(name));
  const ratio = comparePngs(buf, base);
  // Screenshot comparison against baseline
  expect(
    ratio,
    `Visual diff ${(ratio * 100).toFixed(3)}% for "${name}" exceeds threshold ${(maxDiffRatio * 100).toFixed(1)}%`
  ).toBeLessThanOrEqual(maxDiffRatio);
}

test.describe('visual baseline comparison (fonts blocked)', () => {
  test.beforeEach(async ({ context }) => {
    await blockWebFonts(context);
  });

  test.beforeEach(async ({ page }) => {
    await allowSyntheticPointer(page);
  });

  test('landing page matches main baseline', async ({ page }) => {
    await openLanding(page);
    await expectMatchesBaseline(page, 'landing');
  });

  test('canvas with tools matches main baseline', async ({ page }) => {
    await openCanvas(page);
    await expectMatchesBaseline(page, 'canvas');
  });

  test('canvas with drawn scene matches main baseline', async ({ page }) => {
    await openCanvas(page);
    await drawShape(page, 'rectangle', 120, 160, 300, 300);
    await drawShape(page, 'ellipse', 380, 160, 520, 280);
    await drawFreedraw(page);
    await selectTool(page, 'text');
    await addText(page, 620, 180, 'Baseline');
    await page.waitForTimeout(400);
    await expectMatchesBaseline(page, 'canvas-drawn');
  });

  test('properties panel and export dialog match main baseline', async ({ page }) => {
    await openCanvas(page);
    await drawShape(page, 'rectangle', 120, 160, 300, 300);
    await drawShape(page, 'ellipse', 380, 160, 520, 280);
    await drawFreedraw(page);
    await selectTool(page, 'text');
    await addText(page, 620, 180, 'Baseline');
    await page.waitForTimeout(400);
    // Matches capture script: trusted click on Export leaves the text element
    // selected (clicking Export moves focus but never clears app selection).
    await page.click('.action-btn[title="Export drawing"]');
    await page.waitForTimeout(300);
    await expectMatchesBaseline(page, 'export-dialog');
  });
});

test.describe('font loading behavior (new, intentional change)', () => {
  // The suite runs against localhost:5173 (see playwright.config.ts). For this
  // test to observe the FIXED behavior, that port must serve the fixed branch
  // (e.g. `bun run dev` in this worktree). Against a `main` server the test
  // would fail — which is exactly the regression it documents.
  test('web fonts load after fix (were silently dropped on main)', async ({ page }) => {
    let fontImportSeen = false;
    page.on('request', (req) => {
      if (req.url().includes('fonts.googleapis.com')) fontImportSeen = true;
    });
    await page.goto('/');
    await page.waitForSelector('.landing-title');
    await page.waitForTimeout(2000);
    await expect(fontImportSeen, 'Google Fonts stylesheet should be requested after the fix').toBe(true);
    // Wait until the DM Sans FontFace actually reports loaded (the @import
    // resolves asynchronously; JetBrains Mono loads lazily on first use).
    await page.waitForFunction(() => {
      const faces = Array.from(document.fonts);
      return faces.some((f) => f.family.replace(/"/g, '') === 'DM Sans' && f.status === 'loaded');
    }, { timeout: 10_000 });
    const dmSans = await page.evaluate(() => document.fonts.check('16px "DM Sans"'));
    await expect(dmSans, 'DM Sans should be available').toBe(true);
  });
});