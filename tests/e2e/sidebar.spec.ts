import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const view = (page: Page) => page.locator(".doc-view--active");

async function openBookmarks(page: Page, name: string) {
  await page.goto("/");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /Open a PDF/ }).click()]);
  await chooser.setFiles(fixture(name));
  await expect(view(page).locator('.page[data-index="0"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");
  await page.keyboard.press("F4");
  await page.getByRole("tab", { name: "Bookmarks" }).click();
}

test("bookmarks stay expanded when you jump, and show the section you're in", async ({ page }) => {
  await openBookmarks(page, "chapters.pdf");
  const tree = page.getByRole("tree", { name: "Bookmarks" });
  const part2 = tree.getByRole("treeitem").filter({ has: page.getByRole("button", { name: /^Part 2/ }) });
  await part2.getByRole("button", { name: "Expand" }).click();
  await tree.getByRole("button", { name: "Chapter 8", exact: true }).click();
  await expect(view(page).getByLabel("Page number")).toHaveValue("141");
  // Still open after the jump, with the chapter marked as where the reader is.
  await expect(part2).toHaveAttribute("aria-expanded", "true");
  await expect(tree.getByRole("button", { name: "Chapter 8", exact: true })).toHaveAttribute("aria-current", "location");
  // Going to a page in a collapsed part opens it to show the current chapter.
  await view(page).getByLabel("Page number").fill("265");
  await view(page).getByLabel("Page number").press("Enter");
  await expect(tree.getByRole("button", { name: "Chapter 14", exact: true })).toHaveAttribute("aria-current", "location");
  await expect(tree.getByRole("button", { name: "Chapter 14", exact: true })).toBeVisible();
  await expect(part2).toHaveAttribute("aria-expanded", "true");
  // Part 3 was opened only to show the reader's place, so it closes again when they leave; Part 2 was opened by hand and stays.
  const part3 = tree.getByRole("treeitem").filter({ has: page.getByRole("button", { name: /^Part 3/ }) });
  await expect(part3).toHaveAttribute("aria-expanded", "true");
  await view(page).getByLabel("Page number").fill("30");
  await view(page).getByLabel("Page number").press("Enter");
  await expect(tree.getByRole("button", { name: "Chapter 2", exact: true })).toHaveAttribute("aria-current", "location");
  await expect(part3).toHaveAttribute("aria-expanded", "false");
  await expect(part2).toHaveAttribute("aria-expanded", "true");
});

test("the sidebar can be resized, and remembers its width", async ({ page }) => {
  await openBookmarks(page, "chapters.pdf");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const before = (await sidebar.boundingBox())!.width;
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 200, { steps: 5 });
  await page.mouse.up();
  const after = (await sidebar.boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 120);
  // Keyboard works too.
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(after);
  const kept = (await sidebar.boundingBox())!.width;
  await page.reload();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /Open a PDF/ }).click()]);
  await chooser.setFiles(fixture("chapters.pdf"));
  await page.keyboard.press("F4");
  await expect.poll(async () => (await page.getByRole("complementary", { name: "Sidebar" }).boundingBox())?.width).toBe(kept);
});

test("the add-bookmark button stays on one line", async ({ page }) => {
  await openBookmarks(page, "long-300.pdf");
  await view(page).getByLabel("Page number").fill("288");
  await view(page).getByLabel("Page number").press("Enter");
  const add = page.getByRole("button", { name: "Add bookmark for page 288" });
  await expect(add).toBeVisible();
  const h = (await add.boundingBox())!.height;
  expect(h).toBeLessThan(36);
});
