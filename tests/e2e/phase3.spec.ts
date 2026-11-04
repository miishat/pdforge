import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const view = (page: Page) => page.locator(".doc-view:not([hidden])");

async function open(page: Page, ...names: string[]) {
  await page.goto("/");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /Open a PDF/ }).click()]);
  await chooser.setFiles(names.map(fixture));
  await expect(view(page).locator('.page[data-index="0"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");
}
const mode = (page: Page, name: string) => view(page).getByRole("tab", { name, exact: true }).click();

/** The page number (1-based) where `text` is found first, using the find bar. */
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

async function pt(page: Page, index: number, x: number, y: number) {
  const box = (await view(page).locator(`.page[data-index="${index}"]`).boundingBox())!;
  const s = box.width / 612;
  return { x: box.x + x * s, y: box.y + y * s };
}

test.describe("organize", () => {
  test("reorder by dragging, delete, rotate and undo", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Organize");
    const cards = view(page).locator(".org-card");
    await expect(cards).toHaveCount(5);
    await cards.nth(4).dragTo(cards.nth(0), { targetPosition: { x: 5, y: 60 } });
    await expect(cards.nth(0)).toHaveAttribute("aria-selected", "true");
    await mode(page, "Read");
    expect(await findPage(page, "Last page")).toBe("1");

    await mode(page, "Organize");
    await cards.nth(1).click();
    await page.keyboard.press("Delete");
    await expect(cards).toHaveCount(4);
    await cards.nth(0).click();
    await page.getByRole("button", { name: "Rotate right" }).click();
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await expect(cards).toHaveCount(5);
  });

  test("insert a blank page and pages from another file", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Organize");
    await view(page).locator(".org-card").nth(0).click();
    await page.getByRole("button", { name: "Insert pages" }).click();
    await page.getByRole("menuitem", { name: "Blank page" }).click();
    await expect(view(page).locator(".org-card")).toHaveCount(6);
    await expect(view(page).locator(".org-card").nth(1)).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Insert pages" }).click();
    await page.getByRole("menuitem", { name: "Pages from a file…" }).click();
    const dialog = page.getByRole("dialog", { name: "Insert pages from a file" });
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), dialog.getByRole("button", { name: "Choose PDF…" }).click()]);
    await chooser.setFiles(fixture("features.pdf"));
    await expect(dialog.getByText("features.pdf · 3 pages")).toBeVisible();
    await dialog.getByPlaceholder("e.g. 1-3, 5").fill("2-3");
    await dialog.getByRole("radio", { name: "At the end" }).check();
    await dialog.getByRole("button", { name: "Insert" }).click();
    await expect(view(page).locator(".org-card")).toHaveCount(8);
    await expect(page.locator(".page-input__total")).toHaveText("of 8");
  });

  test("extract pages into a new tab and split into files", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Organize");
    await view(page).locator(".org-card").nth(1).click();
    await view(page).locator(".org-card").nth(3).click({ modifiers: ["Shift"] });
    await page.getByRole("button", { name: "Extract" }).click();
    await page.getByRole("dialog", { name: "Extract pages" }).getByRole("button", { name: "Extract 3 pages" }).click();
    await expect(page.getByRole("tab", { name: /sample \(pages 2-4\)\.pdf/ })).toHaveAttribute("aria-selected", "true");
    await expect(view(page).locator(".page-input__total")).toHaveText("of 3");

    await page.getByRole("tab", { name: /^sample\.pdf/ }).click();
    await page.getByRole("button", { name: "Split" }).click();
    const downloads: string[] = [];
    page.on("download", (d) => downloads.push(d.suggestedFilename()));
    const dialog = page.getByRole("dialog", { name: "Split document" });
    await dialog.getByLabel("Pages per file").fill("2");
    await dialog.getByRole("button", { name: "Split into 3 files" }).click();
    await expect.poll(() => downloads.length).toBe(3);
    expect(downloads[0]).toBe("sample - 01 pages 1-2.pdf");
  });

  test("combine files into a new document with bookmarks", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Organize");
    await page.getByRole("button", { name: "Combine files" }).click();
    const dialog = page.getByRole("dialog", { name: "Combine files" });
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), dialog.getByRole("button", { name: "Add files…" }).click()]);
    await chooser.setFiles([fixture("features.pdf")]);
    await dialog.getByRole("button", { name: "Combine 2 files" }).click();
    await expect(page.getByRole("tab", { name: /Combined\.pdf/ })).toHaveAttribute("aria-selected", "true");
    await expect(view(page).locator(".page-input__total")).toHaveText("of 8");
    // The new tab registers its shortcuts just after it appears; on a slow machine the first F4 can land before that.
    const sidebar = view(page).getByRole("button", { name: "Sidebar", exact: true });
    await expect(async () => {
      if ((await sidebar.getAttribute("aria-pressed")) !== "true") await page.keyboard.press("F4");
      await expect(sidebar).toHaveAttribute("aria-pressed", "true", { timeout: 1000 });
    }).toPass();
    await page.getByRole("tab", { name: "Bookmarks" }).click();
    await expect(page.locator(".tree__label")).toHaveText(["sample", "features"]);
  });
});

test.describe("edit", () => {
  test("edit a line of text in place", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Edit");
    await page.getByRole("button", { name: "Edit text" }).click();
    await view(page).getByRole("button", { name: "Edit text: Page one of five." }).click();
    const input = page.getByLabel("Edit line");
    await expect(input).toHaveValue("Page one of five.");
    await input.fill("Page one of five, edited.");
    await input.press("Enter");
    await mode(page, "Read");
    expect(await findPage(page, "edited")).toBe("1");
  });

  test("add new text to a page", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Edit");
    await page.getByRole("button", { name: "Add text" }).click();
    const p = await pt(page, 0, 100, 300);
    await page.mouse.click(p.x, p.y);
    await page.getByLabel("New text").fill("Freshly added words");
    await page.keyboard.press("Control+Enter");
    await mode(page, "Read");
    expect(await findPage(page, "Freshly added")).toBe("1");
  });

  test("page numbers and a watermark", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Edit");
    await page.getByRole("button", { name: "Page design" }).click();
    await page.getByRole("menuitem", { name: "Page numbers…" }).click();
    await page.getByRole("dialog", { name: "Page numbers" }).getByRole("button", { name: "Apply" }).click();
    await page.getByRole("button", { name: "Page design" }).click();
    await page.getByRole("menuitem", { name: "Watermark…" }).click();
    await page.getByLabel("Watermark text").fill("DRAFT COPY");
    await page.getByRole("dialog", { name: "Watermark" }).getByRole("button", { name: "Apply" }).click();
    expect(await findPage(page, "Page 3 of 5")).toBe("3");
    expect(await findPage(page, "DRAFT COPY")).not.toBeNull();
    await page.getByRole("button", { name: "Page design" }).click();
    await page.getByRole("menuitem", { name: "Remove watermark" }).click();
    expect(await findPage(page, "DRAFT COPY")).toBeNull();
  });

  test("find and redact removes data from the saved file", async ({ page }) => {
    await open(page, "redact.pdf");
    await mode(page, "Edit");
    await page.getByRole("button", { name: "Redact", exact: true }).click();
    await page.getByRole("menuitem", { name: "Find and redact…" }).click();
    const dialog = page.getByRole("dialog", { name: "Find and redact" });
    await dialog.getByRole("checkbox", { name: "Phone numbers" }).uncheck();
    await dialog.getByPlaceholder("e.g. Project Bluebird").fill("BLUEBIRD");
    await dialog.getByRole("button", { name: "Find", exact: true }).click();
    await expect(dialog.getByText("3 matches found.")).toBeVisible();
    await dialog.getByRole("button", { name: "Mark 3 for redaction" }).click();
    await expect(page.locator(".infobar--bad")).toContainText("3 areas are marked");
    await page.locator(".infobar--bad").getByRole("button", { name: "Apply redactions…" }).click();
    await page.getByRole("dialog", { name: "Apply 3 redactions" }).getByRole("button", { name: "Apply redactions" }).click();
    await expect(page.locator(".infobar--bad")).toHaveCount(0);
    expect(await findPage(page, "BLUEBIRD")).toBeNull();
    expect(await findPage(page, "jane.doe")).toBeNull();
    const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
    const bytes = readFileSync(await download.path());
    // Reopen the saved file: the redacted words are gone.
    await page.getByRole("button", { name: "Close redact.pdf" }).click();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /Open a PDF/ }).click()]);
    await chooser.setFiles({ name: "saved.pdf", mimeType: "application/pdf", buffer: bytes });
    await expect(view(page).locator('.page[data-index="0"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");
    expect(await findPage(page, "BLUEBIRD")).toBeNull();
    expect(await findPage(page, "Secret project")).toBe("1");
  });

  test("mark an area for redaction by dragging", async ({ page }) => {
    await open(page, "redact.pdf");
    await mode(page, "Edit");
    await page.getByRole("button", { name: "Mark area for redaction" }).click();
    const a = await pt(page, 0, 60, 120);
    const b = await pt(page, 0, 300, 140);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator(".infobar--bad")).toContainText("1 area is marked");
  });

  test("remove hidden information", async ({ page }) => {
    await open(page, "redact.pdf");
    await mode(page, "Edit");
    await page.getByRole("button", { name: "Redact", exact: true }).click();
    await page.getByRole("menuitem", { name: "Remove hidden information…" }).click();
    await page.getByRole("dialog", { name: "Remove hidden information" }).getByRole("button", { name: "Remove" }).click();
    await expect(view(page).locator(".status-line")).toContainText("scripts");
    await page.keyboard.press("Control+d");
    await expect(page.getByRole("dialog", { name: "Document properties" }).getByText("Jane Doe")).toHaveCount(0);
  });

  test("draw a link to another page", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Edit");
    await page.getByRole("button", { name: "Links" }).click();
    const a = await pt(page, 0, 72, 280);
    const b = await pt(page, 0, 250, 310);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    const dialog = page.getByRole("dialog", { name: "Add link" });
    await dialog.getByRole("radio", { name: /Page in this document/ }).check();
    await dialog.getByLabel("Target page").fill("4");
    await dialog.getByRole("button", { name: "Add link" }).click();
    await mode(page, "Read");
    await view(page).locator('.page[data-index="0"] .page__link').first().click();
    await expect(page.getByLabel("Page number")).toHaveValue("4");
  });

  test("move an image", async ({ page }) => {
    await open(page, "redact.pdf");
    await mode(page, "Edit");
    await page.getByRole("button", { name: "Edit images" }).click();
    const img = view(page).locator(".edit-image").first();
    await expect(img).toBeVisible();
    const before = (await img.boundingBox())!;
    await page.mouse.move(before.x + 20, before.y + 20);
    await page.mouse.down();
    await page.mouse.move(before.x + 120, before.y + 20, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await view(page).locator(".edit-image").first().boundingBox())!.x - before.x)).toBeGreaterThan(80);
  });
});

test.describe("document structure", () => {
  test("add and rename a bookmark", async ({ page }) => {
    await open(page, "sample.pdf");
    await page.keyboard.press("F4");
    await page.getByRole("tab", { name: "Bookmarks" }).click();
    await page.getByRole("button", { name: /Add bookmark for page 1/ }).click();
    const name = page.getByLabel("Bookmark name");
    await name.fill("Introduction");
    await name.press("Enter");
    await expect(page.locator(".tree__label")).toHaveText(["Introduction"]);
    await expect(page.getByRole("tab", { name: /sample\.pdf/ }).locator(".tab__dirty")).toBeVisible();
  });

  test("edit the document title and attach a file", async ({ page }) => {
    await open(page, "sample.pdf");
    await page.keyboard.press("Control+d");
    const dialog = page.getByRole("dialog", { name: "Document properties" });
    await dialog.getByRole("button", { name: "Edit description" }).click();
    await dialog.getByLabel("Title").fill("Renamed title");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog.getByText("Renamed title")).toBeVisible();
    await page.keyboard.press("Escape");
    await mode(page, "Edit");
    await page.keyboard.press("F4");
    await page.getByRole("tab", { name: "Attachments" }).click();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Attach a file…" }).click()]);
    await chooser.setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await expect(page.locator(".file__name")).toHaveText(["notes.txt"]);
  });
});
