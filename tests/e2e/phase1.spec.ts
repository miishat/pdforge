import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function open(page: Page, ...names: string[]) {
  await page.goto("/");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /Open a PDF/ }).click()]);
  await chooser.setFiles(names.map(fixture));
  await expect(page.locator('.doc-view:not([hidden]) .page[data-index="0"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");
}

const view = (page: Page) => page.locator(".doc-view:not([hidden])");

/** Client coordinates of a page-space point on page `index` (rotation 0). */
async function pagePoint(page: Page, index: number, x: number, y: number) {
  const box = (await view(page).locator(`.page[data-index="${index}"]`).boundingBox())!;
  const s = box.width / 612;
  return { x: box.x + x * s, y: box.y + y * s };
}

test.describe("tabs", () => {
  test("opens several files as tabs and switches between them", async ({ page }) => {
    await open(page, "features.pdf", "sample.pdf");
    const tabs = page.getByRole("tablist", { name: "Open documents" }).getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await expect(page.getByRole("tab", { name: /sample\.pdf/ })).toHaveAttribute("aria-selected", "true");
    await expect(view(page).locator(".page-input__total")).toHaveText("of 5");
    await page.keyboard.press("Control+Tab");
    await expect(page.getByRole("tab", { name: /features\.pdf/ })).toHaveAttribute("aria-selected", "true");
    await expect(view(page).locator(".page-input__total")).toHaveText("of 3");
    await page.keyboard.press("Control+w");
    await expect(tabs).toHaveCount(1);
    await expect(page).toHaveTitle("sample.pdf – PDForge");
  });
});

test.describe("sidebar", () => {
  test("thumbnails navigate and follow the current page", async ({ page }) => {
    await open(page, "sample.pdf");
    await page.keyboard.press("F4");
    const thumbs = page.locator(".thumb");
    await expect(thumbs).toHaveCount(5);
    await expect(thumbs.nth(0).locator("canvas")).toHaveAttribute("data-rendered", "true");
    await thumbs.nth(3).click();
    await expect(page.getByLabel("Page number")).toHaveValue("4");
    await expect(thumbs.nth(3)).toHaveAttribute("aria-current", "page");
  });

  test("bookmarks jump to their chapter", async ({ page }) => {
    await open(page, "features.pdf");
    await page.getByRole("button", { name: "Sidebar" }).click();
    await page.getByRole("tab", { name: "Bookmarks" }).click();
    await page.getByRole("button", { name: "Chapter 2: Rivers", exact: true }).click();
    await expect(page.getByLabel("Page number")).toHaveValue("3");
  });

  test("comments and attachments are listed", async ({ page }) => {
    await open(page, "features.pdf");
    await page.keyboard.press("F4");
    await page.getByRole("tab", { name: "Comments" }).click();
    await expect(page.locator(".comment")).toHaveCount(2);
    await expect(page.getByText("Check the summit height.")).toBeVisible();
    await page.getByRole("tab", { name: "Attachments" }).click();
    await expect(page.getByText("notes.txt")).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Save notes.txt" }).click()]);
    expect(download.suggestedFilename()).toBe("notes.txt");
  });

  test("panels without content are hidden", async ({ page }) => {
    await open(page, "sample.pdf");
    await page.keyboard.press("F4");
    // Bookmarks always shows (to add the first one); empty attachments and layers don't.
    await expect(page.getByRole("tab", { name: "Attachments" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Layers" })).toHaveCount(0);
  });
});

test.describe("search", () => {
  test("finds all matches, steps through them and lists them", async ({ page }) => {
    await open(page, "features.pdf");
    await page.keyboard.press("Control+f");
    await page.getByLabel("Find in document").fill("aurora");
    await expect(page.locator(".searchbar__status")).toHaveText("1 of 5");
    await expect(view(page).locator(".hit--current")).toHaveCount(1);
    await page.getByLabel("Find in document").press("Enter");
    await expect(page.locator(".searchbar__status")).toHaveText("2 of 5");
    await expect(page.getByLabel("Page number")).toHaveValue("2");
    await page.keyboard.press("Shift+F3");
    await expect(page.locator(".searchbar__status")).toHaveText("1 of 5");

    // Lowercase "aurora" only: pages 1, 2 and "auroras" on page 3.
    await page.getByRole("button", { name: "Match case" }).click();
    await expect(page.locator(".searchbar__status")).toHaveText("1 of 3");
    await page.getByRole("button", { name: "Match case" }).click();
    await page.getByRole("button", { name: "Whole words" }).click();
    await expect(page.locator(".searchbar__status")).toHaveText("1 of 4");

    await page.keyboard.press("F4");
    await expect(page.getByRole("tab", { name: "Search results" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".results__item")).toHaveCount(4);
    await page.locator(".results__item").nth(3).click();
    await expect(page.getByLabel("Page number")).toHaveValue("3");
  });

  test("reports invalid regular expressions and empty results", async ({ page }) => {
    await open(page, "features.pdf");
    await page.keyboard.press("Control+f");
    await page.getByRole("button", { name: "Regular expression" }).click();
    await page.getByLabel("Find in document").fill("([");
    await expect(page.locator(".searchbar__status")).toHaveText("That search pattern isn't valid.");
    await page.getByLabel("Find in document").fill("zebra");
    await expect(page.locator(".searchbar__status")).toHaveText("No results");
    await page.keyboard.press("Escape");
    await expect(page.locator(".searchbar")).toHaveCount(0);
  });
});

test.describe("selection", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("drag selects text and Ctrl+C copies it", async ({ page }) => {
    await open(page, "features.pdf");
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByLabel("Page number")).toHaveValue("2");
    await expect(view(page).locator('.page[data-index="1"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");
    // The "Mountains are tall. …" line spans y≈101–117 in page space; drag across "Mountains are tall".
    const a = await pagePoint(page, 1, 72, 109);
    const b = await pagePoint(page, 1, 175, 109);
    await page.mouse.move(a.x, a.y);
    await page.waitForTimeout(150);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
    await expect(view(page).locator(".selection")).not.toHaveCount(0);
    await page.keyboard.press("Control+c");
    await expect(page.locator(".status-line")).toHaveText("Copied");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toMatch(/^Mountains are tall/);
  });

  test("double-click selects a word; right-click offers to find it", async ({ page }) => {
    await open(page, "features.pdf");
    const p = await pagePoint(page, 0, 160, 145); // "aurora" on the "Search term" line
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(150);
    await page.mouse.dblclick(p.x, p.y);
    await expect(view(page).locator(".selection")).toHaveCount(1);
    await page.mouse.click(p.x, p.y, { button: "right" });
    await page.getByRole("menuitem", { name: "Find selected text" }).click();
    await expect(page.getByLabel("Find in document")).toHaveValue(/aurora/i);
    await expect(page.locator(".searchbar__status")).toContainText("of 5");
  });
});

test.describe("links and history", () => {
  test("internal links navigate and Alt+Left goes back", async ({ page }) => {
    await open(page, "features.pdf");
    await view(page).locator('.page[data-index="0"] .page__link').first().click();
    await expect(page.getByLabel("Page number")).toHaveValue("3");
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(page.getByLabel("Page number")).toHaveValue("1");
    await page.keyboard.press("Alt+ArrowRight");
    await expect(page.getByLabel("Page number")).toHaveValue("3");
  });

  test("external links ask before opening", async ({ page }) => {
    await open(page, "features.pdf");
    await view(page).locator('.page[data-index="0"] .page__link').nth(1).click();
    await expect(page.getByRole("dialog", { name: "Open this link?" })).toBeVisible();
    await expect(page.getByText("https://example.com/")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("view options", () => {
  test("rotate swaps page dimensions", async ({ page }) => {
    await open(page, "sample.pdf");
    await page.keyboard.press("Control+1");
    const before = (await view(page).locator('.page[data-index="0"]').boundingBox())!;
    await page.keyboard.press("Control+Shift+Equal");
    await expect
      .poll(async () => Math.round((await view(page).locator('.page[data-index="0"]').boundingBox())!.width))
      .toBe(Math.round(before.height));
  });

  test("two-page layout puts pages side by side and keeps your place", async ({ page }) => {
    await open(page, "sample.pdf");
    await page.getByLabel("Page number").fill("4");
    await page.getByLabel("Page number").press("Enter");
    await expect(page.getByLabel("Page number")).toHaveValue("4");
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Two pages", exact: true }).click();
    const a = (await view(page).locator('.page[data-index="0"]').boundingBox())!;
    const b = (await view(page).locator('.page[data-index="1"]').boundingBox())!;
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    expect(b.x).toBeGreaterThan(a.x + a.width);
    // Page 4 sits in the second spread (pages 3–4), which should still be in view.
    const p4 = (await view(page).locator('.page[data-index="3"]').boundingBox())!;
    const area = (await view(page).locator(".canvas-area").boundingBox())!;
    expect(p4.y).toBeLessThan(area.y + area.height / 2);
    expect(p4.y + p4.height).toBeGreaterThan(area.y);
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Single page" }).click();
  });

  test("reading modes tint the page", async ({ page }) => {
    await open(page, "sample.pdf");
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Night" }).click();
    await expect(view(page).locator(".canvas-area")).toHaveClass(/canvas-area--night/);
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Normal" }).click();
  });

  test("very high zoom adds a sharp detail tile", async ({ page }) => {
    await open(page, "sample.pdf");
    await page.getByLabel("Zoom level").fill("800");
    await page.getByLabel("Zoom level").press("Enter");
    await expect(view(page).locator('.page[data-index="0"] .page__detail')).toBeVisible({ timeout: 8000 });
  });

  test("marquee zoom zooms into the dragged area", async ({ page }) => {
    await open(page, "sample.pdf");
    await page.keyboard.press("z");
    await expect(page.locator(".tool-hint")).toBeVisible();
    const a = await pagePoint(page, 0, 72, 60);
    const b = await pagePoint(page, 0, 300, 140);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    const z = parseInt(await page.getByLabel("Zoom level").inputValue(), 10);
    expect(z).toBeGreaterThan(250);
  });

  test("presentation mode shows one page and Esc leaves", async ({ page }) => {
    await open(page, "sample.pdf");
    await page.keyboard.press("Control+l");
    await expect(page.getByRole("dialog", { name: "Presentation" })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".presentation__hint")).toContainText("3 / 5");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Presentation" })).toHaveCount(0);
    await expect(page.getByLabel("Page number")).toHaveValue("3");
  });
});

test.describe("dialogs", () => {
  test("document properties show metadata, fonts and permissions", async ({ page }) => {
    await open(page, "features.pdf");
    await page.keyboard.press("Control+d");
    const dialog = page.getByRole("dialog", { name: "Document properties" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("PDForge Features")).toBeVisible();
    await expect(dialog.getByText("Phase 1 test document")).toBeVisible();
    await expect(dialog.getByText("PDF 1.7")).toBeVisible();
    await expect(dialog.getByText("Helvetica")).toBeVisible();
    await expect(dialog.getByText("8.50 × 11.00 in (216 × 279 mm)")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("print dialog validates page ranges", async ({ page }) => {
    await open(page, "sample.pdf");
    await page.keyboard.press("Control+p");
    const dialog = page.getByRole("dialog", { name: "Print" });
    await dialog.getByLabel("Page range").fill("2-9");
    await expect(dialog.getByText("This document has 5 pages.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Continue to print" })).toBeDisabled();
    await dialog.getByLabel("Page range").fill("2-3");
    await expect(dialog.getByRole("button", { name: "Continue to print" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });
});
