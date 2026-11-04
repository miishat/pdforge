import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const view = (page: Page) => page.locator(".doc-view--active");
const rendered = (page: Page) => expect(view(page).locator('.page[data-index="0"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");

async function open(page: Page, ...names: string[]) {
  await page.goto("/");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /Open a PDF/ }).click()]);
  await chooser.setFiles(names.map(fixture));
  await rendered(page);
}
async function palette(page: Page, query: string) {
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox", { name: "Command" });
  await input.fill(query);
  await input.press("Enter");
}
const pageNumber = (page: Page) => view(page).getByLabel("Page number");

test("command palette runs actions by name", async ({ page }) => {
  await open(page, "sample.pdf");
  await palette(page, "organize mode");
  await expect(view(page).getByRole("tab", { name: "Organize", exact: true })).toHaveAttribute("aria-selected", "true");
  await palette(page, "last page");
  await page.keyboard.press("Control+Shift+1");
  await palette(page, "last page");
  await expect(pageNumber(page)).toHaveValue("5");
  // Recently used commands come first.
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("option").first()).toContainText("Last page");
  await page.keyboard.press("Escape");
});

test("shortcuts can be rebound, and vim keys turned on", async ({ page }) => {
  await open(page, "sample.pdf");
  await palette(page, "keyboard shortcuts");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await dialog.getByLabel("Filter shortcuts").fill("Last page");
  await dialog.getByRole("button", { name: "Change shortcut for Last page" }).click();
  await page.keyboard.press("Control+Shift+L");
  await expect(dialog.getByRole("button", { name: "Change shortcut for Last page" })).toContainText("Ctrl+Shift+L");
  await dialog.getByRole("checkbox", { name: /Vim-style navigation/ }).check();
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("Control+Shift+L");
  await expect(pageNumber(page)).toHaveValue("5");
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await expect(pageNumber(page)).toHaveValue("1");
  await page.keyboard.press("l");
  await expect(pageNumber(page)).toHaveValue("2");
  // Settings persist across reloads.
  await page.reload();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /Open a PDF/ }).click()]);
  await chooser.setFiles(fixture("sample.pdf"));
  await rendered(page);
  await page.keyboard.press("Control+Shift+L");
  await expect(pageNumber(page)).toHaveValue("5");
});

test("split view shows two documents side by side, scrolling together", async ({ page }) => {
  await open(page, "sample.pdf", "long-300.pdf");
  await page.keyboard.press("Control+\\");
  await expect(page.locator(".doc-view:not([hidden])")).toHaveCount(2);
  await expect(page.getByRole("checkbox", { name: "Scroll together" })).toBeChecked();
  const left = page.locator(".doc-view--left");
  const right = page.locator(".doc-view--right");
  // Both halves have laid out and drawn their first page.
  await expect(right.locator('.page[data-index="0"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");
  await expect(left.locator('.page[data-index="0"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");
  await left.locator('.page[data-index="0"]').click();
  await expect(left).toHaveClass(/doc-view--active/);
  await left.getByLabel("Page number").fill("4");
  await left.getByLabel("Page number").press("Enter");
  await expect(right.getByLabel("Page number")).toHaveValue("4");
  await page.getByRole("button", { name: "Close split view" }).click();
  await expect(page.locator(".doc-view:not([hidden])")).toHaveCount(1);
});

test("compare two versions lists the changed words", async ({ page }) => {
  await open(page, "sample.pdf");
  await palette(page, "compare");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Choose a PDF…" }).click()]);
  await chooser.setFiles(fixture("sample-v2.pdf"));
  const changes = page.getByRole("region", { name: "Compare documents" }).locator(".change");
  await expect(page.locator(".compare__summary")).toContainText("3 text changes");
  await expect(changes.nth(0)).toContainText("brown");
  await expect(changes.nth(0)).toContainText("red");
  await expect(changes.nth(2)).toContainText("4821.");
  await changes.nth(2).click();
  await expect(page.locator(".mark--current").first()).toBeVisible();
  await expect(page.locator(".compare__summary")).not.toContainText("checking pages");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Compare documents" })).toHaveCount(0);
});

test("extract a table to Excel", async ({ page }) => {
  await open(page, "table.pdf");
  await palette(page, "extract tables");
  const dialog = page.getByRole("dialog", { name: "Extract tables" });
  await expect(dialog.locator(".table-preview th").first()).toHaveText("Region");
  await expect(dialog.locator(".table-preview tr").nth(3)).toContainText("West coast");
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Export…" }).click()]);
  expect(download.suggestedFilename()).toBe("table tables.xlsx");
  expect(readFileSync(await download.path()).subarray(0, 2).toString()).toBe("PK");
});

test("accessibility check and fixes", async ({ page }) => {
  await open(page, "features.pdf");
  await palette(page, "check accessibility");
  const dialog = page.getByRole("dialog", { name: "Accessibility" });
  await expect(dialog.getByText("Tagged for screen readers")).toBeVisible();
  await dialog.getByLabel("Document title").fill("Feature tour");
  await dialog.getByRole("button", { name: "Fix what PDForge can" }).click();
  await expect(page.getByText(/Fixed: language, title/)).toBeVisible();
  await expect(dialog.locator(".check-report__item", { hasText: "Document language set" }).locator(".check-status--pass")).toBeVisible();
});

test("batch: compress several files", async ({ page }) => {
  await page.goto("/");
  await open(page, "sample.pdf");
  await palette(page, "batch");
  const dialog = page.getByRole("dialog", { name: "Batch actions" });
  await dialog.getByRole("button", { name: "New workflow" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Shrink");
  await dialog.getByRole("button", { name: "Add a step" }).click();
  await page.getByRole("menuitem", { name: "Compress" }).click();
  await dialog.getByRole("button", { name: "Add a step" }).click();
  await page.getByRole("menuitem", { name: "Add a watermark" }).click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), dialog.getByRole("button", { name: "Choose files…" }).click()]);
  await chooser.setFiles([fixture("photo.pdf"), fixture("sample.pdf"), fixture("encrypted.pdf")]);
  const downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await dialog.getByRole("button", { name: "Run on 3 files" }).click();
  await expect(dialog.getByText("2 of 3 files done; 1 failed.")).toBeVisible({ timeout: 60_000 });
  expect(downloads.sort()).toEqual(["photo (processed).pdf", "sample (processed).pdf"]);
  await expect(dialog.locator(".batch__failed")).toContainText("password-protected");
  // The workflow is saved.
  await dialog.locator("footer").getByRole("button", { name: "Close" }).click();
  await palette(page, "batch");
  await expect(page.getByRole("dialog", { name: "Batch actions" }).getByText("Shrink")).toBeVisible();
});

test("the assistant is off by default and sends nothing without confirmation", async ({ page }) => {
  const requests: string[] = [];
  await page.route("https://api.anthropic.com/**", async (route) => {
    requests.push(route.request().postData() ?? "");
    const events = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A five-page sample about a fox " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[p. 1] and an invoice [p. 2]." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ];
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
      body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    });
  });
  await open(page, "sample.pdf");
  await palette(page, "assistant");
  const panel = page.getByRole("complementary", { name: "Assistant" });
  await expect(panel.getByRole("checkbox", { name: "Turn on the assistant" })).not.toBeChecked();
  await panel.getByRole("checkbox", { name: "Turn on the assistant" }).check();
  await panel.getByLabel("Anthropic API key").fill("sk-ant-test");
  await panel.getByRole("button", { name: "Done" }).click();
  await panel.getByRole("button", { name: "Summarise" }).click();
  const confirm = panel.getByRole("alertdialog", { name: "Confirm sending" });
  await expect(confirm).toContainText("Send all 5 pages of sample.pdf");
  await expect(confirm).toContainText("Anthropic (Claude, claude-opus-5-5)");
  expect(requests).toHaveLength(0);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(requests).toHaveLength(0);
  await panel.getByRole("button", { name: "Summarise" }).click();
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByText(/A five-page sample about a fox/)).toBeVisible();
  expect(requests).toHaveLength(1);
  const body = JSON.parse(requests[0]);
  expect(body.model).toBe("claude-opus-5-5");
  expect(body.messages[0].content).toContain("[Page 2]");
  // Citations go to the page.
  await panel.getByRole("button", { name: "p. 2" }).click();
  await expect(pageNumber(page)).toHaveValue("2");
});
