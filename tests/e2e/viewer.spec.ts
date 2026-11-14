import { expect, test, type Page } from "./helpers";
import { fileURLToPath } from "node:url";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function openFile(page: Page, name: string) {
  await page.goto("/");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /Open a PDF/ }).click()]);
  await chooser.setFiles(fixture(name));
}

test("start screen offers to open a file", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Open a PDF/ })).toBeVisible();
  await expect(page.getByText(/^Or drag files here\./)).toBeVisible();
  // The version, at the bottom of the window (the start screen fills it).
  await expect(page.locator(".start__footer")).toHaveText(/^PDForge \d+\.\d+\.\d+/);
  const box = (await page.locator(".start").boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(page.viewportSize()!.height - 2);
});

test("opens a PDF and renders the first page", async ({ page }) => {
  await openFile(page, "sample.pdf");
  await expect(page.getByRole("tab", { name: /sample\.pdf/ })).toBeVisible();
  // Only pages near the viewport are mounted.
  await expect(page.locator(".page").first()).toBeVisible();
  await expect(page.locator('.page[data-index="0"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");
  await expect(page.locator(".page-input__total")).toHaveText("of 5");
  await expect(page).toHaveTitle("sample.pdf – PDForge");
});

test("zoom controls change the zoom level", async ({ page }) => {
  await openFile(page, "sample.pdf");
  await page.getByRole("button", { name: "Zoom in" }).waitFor();
  await page.keyboard.press("Control+1");
  await expect(page.getByLabel("Zoom level")).toHaveValue("100%");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByLabel("Zoom level")).toHaveValue("110%");
  const width = await page.locator('.page[data-index="0"]').evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.round(width)).toBe(Math.round(612 * (96 / 72) * 1.1));
  await page.getByLabel("Zoom level").fill("250");
  await page.getByLabel("Zoom level").press("Enter");
  await expect(page.getByLabel("Zoom level")).toHaveValue("250%");
});

test("go to a page by number", async ({ page }) => {
  await openFile(page, "sample.pdf");
  const input = page.getByLabel("Page number");
  await input.fill("4");
  await input.press("Enter");
  await expect(page.locator('.page[data-index="3"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");
  await expect(input).toHaveValue("4");
});

test("password-protected PDF asks for the password", async ({ page }) => {
  await openFile(page, "encrypted.pdf");
  await expect(page.getByRole("heading", { name: "This PDF is password-protected" })).toBeVisible();
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByText("That password isn't right. Try again.")).toBeVisible();
  await page.getByLabel("Password").fill("secret");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator('.page[data-index="0"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");
});

test("a file that isn't a PDF shows a clear error", async ({ page }) => {
  await page.goto("/");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /Open a PDF/ }).click()]);
  await chooser.setFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("just some text") });
  await expect(page.getByRole("heading", { name: "Couldn't open notes.pdf" })).toBeVisible();
});

test("closing the tab returns to the start screen", async ({ page }) => {
  await openFile(page, "sample.pdf");
  await page.getByRole("button", { name: "Close sample.pdf" }).click();
  await expect(page.getByRole("button", { name: /Open a PDF/ })).toBeVisible();
});

test("a 300-page document opens fast and only renders nearby pages", async ({ page }) => {
  await page.goto("/");
  const t0 = Date.now();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /Open a PDF/ }).click()]);
  await chooser.setFiles(fixture("long-300.pdf"));
  await expect(page.locator('.page[data-index="0"] canvas.page__canvas')).toHaveAttribute("data-rendered", "true");
  expect(Date.now() - t0).toBeLessThan(3000);
  const rendered = await page.locator('canvas[data-rendered="true"]').count();
  expect(rendered).toBeLessThan(10);
});
