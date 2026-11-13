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

test("a search can find far more than 5,000 results, and the list stays light", async ({ page }) => {
  await page.goto("/");
  await open(page, "long-600.pdf");
  await page.keyboard.press("Control+f");
  await view(page).getByRole("button", { name: "Regular expression" }).click();
  await view(page).getByLabel("Find in document").fill("[a-z]");
  // About 20,000 letters across 600 pages: all counted (no "+"), with thousands separators.
  await expect(view(page).locator(".searchbar__status")).toHaveText(/^1 of \d{2},\d{3}$/, { timeout: 30_000 });
  const total = Number((await view(page).locator(".searchbar__status").textContent())!.replace(/^1 of |,/g, ""));
  expect(total).toBeGreaterThan(5000);

  await page.keyboard.press("F4");
  const items = view(page).locator(".results__item");
  // Only the rows near view exist, and they show the text around each hit.
  await expect(items.first()).toContainText("Page");
  expect(await items.count()).toBeLessThan(200);
  // Jumping to the last result scrolls the list there and fills in its text.
  await view(page).getByLabel("Find in document").press("Shift+Enter");
  await expect(view(page).locator(".searchbar__status")).toHaveText(`${total.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`);
  const current = view(page).locator('.results__item[aria-current="true"]');
  await expect(current).toBeVisible();
  await expect(current.locator("mark")).toHaveText(/^[a-z]$/i);
  await expect(view(page).getByLabel("Page number")).toHaveValue("600");
});
