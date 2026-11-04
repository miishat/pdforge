import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const view = (page: Page) => page.locator(".doc-view:not([hidden])");
const rendered = (page: Page) => expect(view(page).locator('.page[data-index="0"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");

async function open(page: Page, name: string) {
  await page.goto("/");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /Open a PDF/ }).click()]);
  await chooser.setFiles(fixture(name));
  await rendered(page);
}
async function openBytes(page: Page, name: string, buffer: Buffer) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /Open a PDF/ }).click()]);
  await chooser.setFiles({ name, mimeType: "application/pdf", buffer });
}
const protect = (page: Page) => view(page).getByRole("tab", { name: "Protect", exact: true }).click();

async function findPage(page: Page, text: string): Promise<string | null> {
  await page.keyboard.press("Control+f");
  await page.getByLabel("Find in document").fill(text);
  const status = page.locator(".searchbar__status");
  await expect(status).not.toHaveText(/Searching/);
  await expect(status).not.toHaveText("");
  const s = await status.textContent();
  const result = s === "No results" ? null : await page.getByLabel("Page number").inputValue();
  await page.keyboard.press("Escape");
  return result;
}

test("protect with an open password; the saved file asks for it", async ({ page }) => {
  await open(page, "sample.pdf");
  await protect(page);
  await expect(page.locator(".status-pill")).toHaveText("Not protected");
  await page.getByRole("button", { name: "Security" }).click();
  const dialog = page.getByRole("dialog", { name: "Security" });
  await dialog.getByRole("checkbox", { name: "Require a password to open the file" }).check();
  await dialog.getByLabel("Open password", { exact: true }).fill("open sesame");
  await dialog.getByLabel("Repeat open password", { exact: true }).fill("open sesame");
  await dialog.getByRole("checkbox", { name: "Copy text and images" }).uncheck();
  await dialog.getByLabel("Permissions password", { exact: true }).fill("owner-secret");
  await dialog.getByLabel("Repeat permissions password", { exact: true }).fill("owner-secret");
  await dialog.getByRole("button", { name: "Protect" }).click();
  await expect(page.locator(".status-pill")).toHaveText("Protected when you save");
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const bytes = readFileSync(await download.path());
  await expect(page.locator(".status-pill")).toHaveText(/Protected · AES 256-bit/);

  await page.getByRole("button", { name: "Close sample.pdf" }).click();
  await openBytes(page, "locked.pdf", bytes);
  await page.getByLabel("Password").fill("open sesame");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await rendered(page);
  expect(await findPage(page, "quick brown fox")).toBe("1");
});

test("recognise text on a scanned page makes it searchable", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page, "scanned.pdf");
  expect(await findPage(page, "quick brown fox")).toBeNull();
  await protect(page);
  await page.getByRole("button", { name: "Recognise text" }).click();
  const dialog = page.getByRole("dialog", { name: "Recognise text" });
  await expect(dialog.locator(".chip")).toHaveText("English");
  await dialog.getByRole("button", { name: "Recognise" }).click();
  await expect(page.getByText(/Recognised text on 1 page/)).toBeVisible({ timeout: 90_000 });
  expect(await findPage(page, "quick brown fox")).toBe("1");
  // One undo step removes it again.
  await page.keyboard.press("Control+z");
  expect(await findPage(page, "quick brown fox")).toBeNull();
});

test("compress shows the size before and after", async ({ page }) => {
  await open(page, "photo.pdf");
  await protect(page);
  await page.getByRole("button", { name: "Compress" }).click();
  const dialog = page.getByRole("dialog", { name: "Compress" });
  await expect(dialog.getByText(/Current size: \d/)).toBeVisible();
  await dialog.getByText("Screen", { exact: true }).click();
  await dialog.getByRole("button", { name: "Compress" }).click();
  await expect(dialog.locator(".size-compare__delta--good")).toHaveText(/−\d+%/);
  await expect(dialog.getByText(/1 image scaled down/)).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const size = readFileSync(await download.path()).length;
  expect(size).toBeLessThan(readFileSync(fixture("photo.pdf")).length / 3);
});

test("export to Markdown and Word", async ({ page }) => {
  await open(page, "sample.pdf");
  await protect(page);
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Markdown (.md)…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  const [md] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Export…" }).click()]);
  expect(md.suggestedFilename()).toBe("sample.md");
  const text = readFileSync(await md.path(), "utf8");
  expect(text).toMatch(/^# PDForge sample document$/m);
  expect(text).toContain("quick brown fox");

  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Word document (.docx)…" }).click();
  const [docx] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Export…" }).click()]);
  expect(docx.suggestedFilename()).toBe("sample.docx");
  expect(readFileSync(await docx.path()).subarray(0, 2).toString()).toBe("PK");
});

test("PDF/A check and conversion", async ({ page }) => {
  await open(page, "features.pdf");
  await protect(page);
  await page.getByRole("button", { name: "PDF/A" }).click();
  const dialog = page.getByRole("dialog", { name: "PDF/A archiving" });
  await expect(dialog.getByText(/requirements? not met/)).toBeVisible();
  await expect(dialog.locator(".check-status--fail").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Convert to PDF/A-2b" }).click();
  await expect(dialog.getByText(/Converted to PDF\/A-2b/)).toBeVisible();
  await expect(dialog.locator(".check-status--fail")).toHaveCount(0);
  await expect(dialog.locator(".check-status--fixed").first()).toBeVisible();
});

test("a damaged file is repaired on open and explained", async ({ page }) => {
  await open(page, "damaged.pdf");
  await expect(page.getByText("This file was damaged.")).toBeVisible();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByRole("dialog", { name: "Repair" }).getByText(/rebuilt its structure and all 5 pages read correctly/)).toBeVisible();
});

test("create a PDF from a web page and an image", async ({ page }) => {
  await page.goto("/");
  const html = "<html><body><h1>Trip notes</h1><p>Packed the tent.</p></body></html>";
  const png = readFileSync(fixture("../../src-tauri/icons/32x32.png"));
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Create a PDF from files" }).click()]);
  await chooser.setFiles([
    { name: "notes.html", mimeType: "text/html", buffer: Buffer.from(html) },
    { name: "logo.png", mimeType: "image/png", buffer: png },
  ]);
  await rendered(page);
  await expect(page.getByRole("tab", { name: /Combined\.pdf/ })).toBeVisible();
  await expect(page.getByLabel("Page number")).toBeVisible();
  expect(await findPage(page, "Packed the tent")).toBe("1");
});
