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

async function pt(page: Page, index: number, x: number, y: number) {
  const box = (await view(page).locator(`.page[data-index="${index}"]`).boundingBox())!;
  const s = box.width / 612;
  return { x: box.x + x * s, y: box.y + y * s };
}

async function drag(page: Page, index: number, from: [number, number], to: [number, number]) {
  const a = await pt(page, index, ...from);
  const b = await pt(page, index, ...to);
  await page.mouse.move(a.x, a.y);
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

async function mode(page: Page, name: "Read" | "Comment" | "Fill & Sign") {
  await view(page).getByRole("tab", { name, exact: true }).click();
}

async function commentsPanel(page: Page) {
  if (!(await page.locator(".sidebar").count())) await page.keyboard.press("F4");
  await page.getByRole("tab", { name: "Comments" }).click();
}

test.describe("comments", () => {
  test("highlight by dragging over text, then undo and redo", async ({ page }) => {
    await open(page, "features.pdf");
    await mode(page, "Comment");
    await page.getByRole("button", { name: "Highlight text" }).click();
    await drag(page, 0, [72, 145], [250, 145]);
    await expect(view(page).locator('.annot-hit[data-type="Highlight"]')).toHaveCount(1);
    await expect(page.getByRole("tab", { name: /features\.pdf/ }).locator(".tab__dirty")).toBeVisible();
    await page.keyboard.press("Control+z");
    await expect(view(page).locator('.annot-hit[data-type="Highlight"]')).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /features\.pdf/ }).locator(".tab__dirty")).toHaveCount(0);
    await page.keyboard.press("Control+y");
    await expect(view(page).locator('.annot-hit[data-type="Highlight"]')).toHaveCount(1);
  });

  test("highlight existing selection from the right-click menu", async ({ page }) => {
    await open(page, "features.pdf");
    const p = await pt(page, 0, 160, 145);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(150);
    await page.mouse.dblclick(p.x, p.y);
    await page.mouse.click(p.x, p.y, { button: "right" });
    await page.getByRole("menuitem", { name: "Highlight" }).click();
    await mode(page, "Comment");
    await expect(view(page).locator('.annot-hit[data-type="Highlight"]')).toHaveCount(1);
  });

  test("draw shapes, select, move with arrow keys and delete", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Comment");
    await page.getByRole("button", { name: "Shapes", exact: true }).click();
    await drag(page, 0, [100, 200], [250, 300]);
    await page.getByRole("button", { name: "Draw" }).click();
    await drag(page, 0, [300, 200], [400, 260]);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    const rect = view(page).locator('.annot-hit[data-type="Square"]');
    await expect(rect).toHaveCount(1);
    await expect(view(page).locator('.annot-hit[data-type="Ink"]')).toHaveCount(1);
    await rect.click({ position: { x: 4, y: 4 } });
    await expect(rect).toHaveAttribute("aria-pressed", "true");
    const before = (await rect.boundingBox())!;
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(async () => Math.round((await rect.boundingBox())!.x - before.x)).toBeGreaterThan(10);
    await page.keyboard.press("Delete");
    await expect(rect).toHaveCount(0);
  });

  test("sticky note and text box with typed text appear in the comments list", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Comment");
    await page.getByRole("button", { name: "Sticky note" }).click();
    const n = await pt(page, 0, 450, 100);
    await page.mouse.click(n.x, n.y);
    await page.getByLabel("Note text").fill("Check the figures");
    await page.getByRole("button", { name: "Close note" }).click();
    await page.getByRole("button", { name: "Text box" }).click();
    const t = await pt(page, 0, 100, 400);
    await page.mouse.click(t.x, t.y);
    await page.getByLabel("Text box contents").fill("Typed straight onto the page");
    await page.keyboard.press("Control+Enter");
    await commentsPanel(page);
    await expect(page.locator(".thread")).toHaveCount(2);
    await expect(page.locator(".comment__edit").first()).toHaveValue("Check the figures");
    await expect(page.getByLabel(/Comment text for Text box/)).toHaveValue("Typed straight onto the page");
  });

  test("reply to a comment and set its status", async ({ page }) => {
    await open(page, "features.pdf");
    await mode(page, "Comment");
    await commentsPanel(page);
    const thread = page.locator(".thread").filter({ hasText: "Check the summit height." });
    await thread.getByRole("button", { name: "Reply" }).click();
    await page.getByLabel("Reply", { exact: true }).fill("Measured at 2,100 m.");
    await thread.locator(".reply-form").getByRole("button", { name: "Reply" }).click();
    await expect(thread.locator(".reply")).toHaveCount(1);
    await thread.getByLabel("Status").selectOption("Accepted");
    await expect(thread.locator(".status-chip")).toHaveText("Accepted");
    // Filtering by status keeps only that thread.
    await page.getByRole("button", { name: "Filter comments" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Accepted" }).click();
    await expect(page.locator(".thread")).toHaveCount(1);
  });

  test("measure a distance at a scale", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Comment");
    await page.getByRole("button", { name: /^Measure/ }).first().click();
    await drag(page, 0, [72, 400], [216, 400]);
    await commentsPanel(page);
    await expect(page.locator(".comment__edit").first()).toHaveValue("2.00 in");
  });

  test("export comments as XFDF and import them into another document", async ({ page }) => {
    await open(page, "features.pdf", "sample.pdf");
    await page.getByRole("tab", { name: /features\.pdf/ }).click();
    await page.getByRole("button", { name: "More" }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Export comments…" }).click()]);
    expect(download.suggestedFilename()).toBe("features.xfdf");
    const path = await download.path();
    expect(readFileSync(path, "utf8")).toContain("<xfdf");
    await page.getByRole("tab", { name: /sample\.pdf/ }).click();
    await page.getByRole("button", { name: "More" }).click();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("menuitem", { name: "Import comments…" }).click()]);
    await chooser.setFiles(path);
    await expect(view(page).locator(".status-line")).toHaveText("Imported 2 comments");
  });
});

test.describe("saving", () => {
  test("Ctrl+S saves (downloads in the browser) and clears the unsaved dot", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Comment");
    await page.getByRole("button", { name: "Shapes", exact: true }).click();
    await drag(page, 0, [100, 200], [250, 300]);
    const dot = page.getByRole("tab", { name: /sample\.pdf/ }).locator(".tab__dirty");
    await expect(dot).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
    expect(download.suggestedFilename()).toBe("sample.pdf");
    const bytes = readFileSync(await download.path());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.toString("latin1")).toContain("/Square");
    await expect(dot).toHaveCount(0);
  });

  test("closing a tab with unsaved changes asks first", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Comment");
    await page.getByRole("button", { name: "Sticky note" }).click();
    const n = await pt(page, 0, 300, 300);
    await page.mouse.click(n.x, n.y);
    await page.getByRole("button", { name: "Close sample.pdf" }).click();
    const dialog = page.getByRole("dialog", { name: "Save changes to sample.pdf?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("tab", { name: /sample\.pdf/ })).toBeVisible();
    await page.getByRole("button", { name: "Close sample.pdf" }).click();
    await page.getByRole("button", { name: "Don't save" }).click();
    await expect(page.getByRole("button", { name: /Open a PDF/ })).toBeVisible();
  });
});

test.describe("forms", () => {
  test("fill fields with Tab, see totals recalculate, toggle checkboxes and pick options", async ({ page }) => {
    await open(page, "form.pdf");
    await mode(page, "Fill & Sign");
    await page.getByLabel("Full name").click();
    await page.keyboard.type("Ada Lovelace");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Quantity A")).toBeFocused();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("10");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Total")).toHaveValue("$13.00");
    await expect(page.getByLabel("Full name")).toHaveValue("Ada Lovelace");
    const sub = page.getByRole("checkbox", { name: "Subscribe to updates" });
    await sub.click();
    await expect(sub).toHaveAttribute("aria-checked", "true");
    const radios = page.getByRole("radio", { name: "Size" });
    await radios.nth(1).click();
    await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
    await expect(radios.nth(0)).toHaveAttribute("aria-checked", "false");
    await page.getByLabel("Colour", { exact: true }).selectOption("Blue");
    await expect(page.getByLabel("Colour", { exact: true })).toHaveValue("Blue");
  });

  test("date fields use a date picker and store the document's format", async ({ page }) => {
    await open(page, "form.pdf");
    const date = page.getByLabel("Delivery date");
    await date.click();
    await expect(date).toHaveAttribute("type", "date");
    await date.fill("2026-12-25");
    // Tab would move between the picker's day/month/year parts; Enter confirms.
    await date.press("Enter");
    await expect(date).toHaveValue("12/25/2026");
  });

  test("rejects text in number fields and can clear the form", async ({ page }) => {
    await open(page, "form.pdf");
    await mode(page, "Fill & Sign");
    await page.getByLabel("Quantity A").fill("lots");
    await page.keyboard.press("Tab");
    await expect(page.locator(".status-line")).toHaveText('"lots" isn\'t a number.');
    await page.getByLabel("Full name").fill("Someone");
    await page.keyboard.press("Tab");
    await page.getByRole("button", { name: "Clear form" }).click();
    await expect(page.getByLabel("Full name")).toHaveValue("");
  });

  test("flattening turns fields into page content", async ({ page }) => {
    await open(page, "form.pdf");
    await page.getByLabel("Full name").fill("Kept forever");
    await page.keyboard.press("Tab");
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Flatten…" }).click();
    await page.getByRole("dialog", { name: "Flatten document" }).getByRole("button", { name: "Flatten" }).click();
    await expect(page.getByLabel("Full name")).toHaveCount(0);
    await page.keyboard.press("Control+f");
    await page.getByLabel("Find in document").fill("Kept forever");
    await expect(page.locator(".searchbar__status")).toHaveText("1 of 1");
  });
});

test.describe("fill & sign", () => {
  test("create a typed signature and place it on the page", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Fill & Sign");
    await page.getByRole("button", { name: "Add signature" }).click();
    await page.getByRole("menuitem", { name: "Create signature…" }).click();
    const dialog = page.getByRole("dialog", { name: "Create signature" });
    await dialog.getByLabel("Your name").fill("Ada Lovelace");
    await dialog.getByRole("button", { name: "Use signature" }).click();
    await expect(page.locator(".annot-layer[data-tool='place']").first()).toBeVisible();
    const p = await pt(page, 0, 300, 250);
    await page.mouse.click(p.x, p.y);
    await expect(view(page).locator('.annot-hit[data-type="Stamp"]')).toHaveCount(1);
    // It's saved for next time.
    await page.getByRole("button", { name: "Add signature" }).click();
    await expect(page.getByRole("menuitem", { name: /^Signature$/ })).toBeVisible();
    await page.keyboard.press("Escape");
    // Check marks stay active for repeated placement.
    await page.getByRole("button", { name: "Add check mark" }).click();
    for (const y of [320, 350]) {
      const c = await pt(page, 0, 100, y);
      await page.mouse.click(c.x, c.y);
    }
    await page.keyboard.press("Escape");
    await expect(view(page).locator('.annot-hit[data-type="Ink"]')).toHaveCount(2);
  });

  test("sign with a certificate and see the signature verified", async ({ page }) => {
    await open(page, "sample.pdf");
    await mode(page, "Fill & Sign");
    await page.getByRole("button", { name: "Certificate" }).click();
    const dialog = page.getByRole("dialog", { name: "Sign with a certificate" });
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), dialog.getByRole("button", { name: "Choose digital ID…" }).click()]);
    await chooser.setFiles(fixture("test-signer.p12"));
    await dialog.getByLabel("Certificate password").fill("wrong");
    await dialog.getByRole("button", { name: "Open certificate" }).click();
    await expect(dialog.getByText("That password doesn't open this certificate file.")).toBeVisible();
    await dialog.getByLabel("Certificate password").fill("test");
    await dialog.getByRole("button", { name: "Open certificate" }).click();
    await expect(dialog.getByText("Test Signer", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/self-signed certificate/)).toBeVisible();
    await dialog.getByRole("button", { name: /Continue/ }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), drag(page, 0, [72, 250], [300, 310])]);
    expect(download.suggestedFilename()).toBe("sample-signed.pdf");
    await expect(page.locator(".infobar--warn")).toContainText("Signed by Test Signer");
    await expect(page.getByRole("tab", { name: "Signatures" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".sig__detail").first()).toHaveText("The document hasn't been changed since it was signed.");
    await page.getByRole("button", { name: "Trust this signer" }).click();
    await expect(page.locator(".infobar--good")).toContainText("All signatures are valid");
  });

  test("a signed file reopens with a valid signature", async ({ page }) => {
    // Sign, download, then open the downloaded file in a fresh tab.
    await open(page, "sample.pdf");
    await mode(page, "Fill & Sign");
    await page.getByRole("button", { name: "Certificate" }).click();
    const dialog = page.getByRole("dialog", { name: "Sign with a certificate" });
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), dialog.getByRole("button", { name: "Choose digital ID…" }).click()]);
    await chooser.setFiles(fixture("test-signer.p12"));
    await dialog.getByLabel("Certificate password").fill("test");
    await dialog.getByRole("button", { name: "Open certificate" }).click();
    await dialog.getByRole("button", { name: /Continue/ }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), drag(page, 0, [72, 250], [300, 310])]);
    const signedPath = await download.path();
    // The tab now shows the signed copy's name.
    await page.getByRole("button", { name: "Close sample-signed.pdf" }).click();
    const [chooser2] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /Open a PDF/ }).click()]);
    await chooser2.setFiles({ name: "signed.pdf", mimeType: "application/pdf", buffer: readFileSync(signedPath) });
    await expect(page.locator(".infobar").filter({ hasText: "Signed by Test Signer" })).toBeVisible();
  });
});
