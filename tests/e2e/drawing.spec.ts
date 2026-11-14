import { expect, test, type Page } from "./helpers";
import { fileURLToPath } from "node:url";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const view = (page: Page) => page.locator(".doc-view--active");

/** Counts page renders sent to each engine worker (the main engine is the first one started). */
async function countRenders(page: Page) {
  await page.addInitScript(() => {
    const counts: number[] = [];
    (window as unknown as { __renders: number[] }).__renders = counts;
    const Real = window.Worker;
    window.Worker = class extends Real {
      constructor(url: string | URL, opts?: WorkerOptions) {
        super(url, opts);
        // The engine's worker file (named worker-<hash>.js in the built app); the text and pack helpers are others.
        if (!/(^|\/)worker(-[\w-]+)?\.(js|ts)/.test(new URL(String(url), location.href).pathname)) return;
        const i = counts.push(0) - 1;
        const post = this.postMessage.bind(this);
        this.postMessage = ((msg: { op?: string }, transfer?: Transferable[]) => {
          if (msg?.op === "render") counts[i]++;
          return post(msg, transfer as Transferable[]);
        }) as Worker["postMessage"];
      }
    } as typeof Worker;
  });
}

const renders = (page: Page) => page.evaluate(() => (window as unknown as { __renders: number[] }).__renders);

test("pages are drawn by two helper engines as well as the main one", async ({ page }) => {
  await countRenders(page);
  await page.goto("/");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /^Open a (PDF|file)/ }).first().click()]);
  await chooser.setFiles(fixture("long-300.pdf"));
  await expect(view(page).locator('.page[data-index="0"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");
  await expect.poll(async () => (await renders(page)).length).toBe(3);

  // Jump around: the helpers take a share of the pages.
  for (const n of [40, 120, 200, 260]) {
    await view(page).getByLabel("Page number").fill(String(n));
    await view(page).getByLabel("Page number").press("Enter");
    await expect(view(page).locator(`.page[data-index="${n - 1}"] canvas.page__canvas`)).toHaveAttribute("data-rendered", "true");
  }
  const [, h1, h2] = await renders(page);
  expect(h1 + h2).toBeGreaterThan(0);
});
