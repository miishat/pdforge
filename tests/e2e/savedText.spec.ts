import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const view = (page: Page) => page.locator(".doc-view--active");

async function open(page: Page, name: string) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /^Open a (PDF|file)/ }).first().click()]);
  await chooser.setFiles(fixture(name));
  await expect(view(page).locator('.page[data-index="0"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");
}

async function find(page: Page, word: string, status: string) {
  await page.keyboard.press("Control+f");
  await view(page).getByLabel("Find in document").fill(word);
  await expect(view(page).locator(".searchbar__status")).toHaveText(status);
}

/** What's saved, from the browser build's store (the desktop app keeps the same in its data folder). */
function savedEntries(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ key: string; size: number; used: number }[]>((resolve, reject) => {
        const req = indexedDB.open("pdforge-search-text", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("texts", { keyPath: "key" });
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction("texts", "readonly").objectStore("texts").getAll();
          all.onsuccess = () => (resolve(all.result.map(({ key, size, used }) => ({ key, size, used }))), req.result.close());
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

test("a large PDF's text is saved after its first search and used next time; it can be cleared", async ({ page }) => {
  await page.goto("/");
  await open(page, "long-600.pdf");
  await find(page, "quetzal", "1 of 1");
  await expect.poll(async () => (await savedEntries(page)).length, { timeout: 20_000 }).toBe(1);
  const [first] = await savedEntries(page);
  expect(first.key).toMatch(/^[0-9a-f]{64}$/);
  expect(first.size).toBeGreaterThan(1000);
  expect(first.size).toBeLessThan(200_000);

  // A new session: the saved text is read back (marking it used) instead of reading all 600 pages again.
  await page.reload();
  await open(page, "long-600.pdf");
  await find(page, "quetzal", "1 of 1");
  await expect(view(page).getByLabel("Page number")).toHaveValue("450");
  await expect.poll(async () => (await savedEntries(page))[0]?.used ?? 0).toBeGreaterThan(first.used);

  // Smaller files aren't saved.
  await open(page, "long-300.pdf");
  await find(page, "performance", "1 of 300");
  await page.waitForTimeout(500);
  expect(await savedEntries(page)).toHaveLength(1);

  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox", { name: "Command" });
  await input.fill("clear saved search");
  await input.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Saved search data cleared" })).toBeVisible();
  expect(await savedEntries(page)).toHaveLength(0);
});
