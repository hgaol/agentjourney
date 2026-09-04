import { readFile } from "node:fs/promises";
import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { fixturePath } from "@agentjourney/test-fixtures";

async function selectAstryxOption(
  page: Page,
  scope: Locator,
  label: string,
  optionName: string
): Promise<void> {
  await scope.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

async function expectNativeChromeDocked(page: Page, stage: FrameLocator): Promise<void> {
  const frameBox = await page.locator("iframe.journey-stage").boundingBox();
  const footerBox = await stage.locator(".stage-native-footer").boundingBox();
  expect(frameBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect(Math.abs((frameBox!.y + frameBox!.height) - (footerBox!.y + footerBox!.height))).toBeLessThan(1);
}

test("opening the Vite URL directly completes local authorization", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto("http://127.0.0.1:5173/");
  await expect(page.getByRole("heading", { name: "Revisit how the work unfolded." })).toBeVisible({ timeout: 15_000 });
  expect(consoleErrors.filter((message) => !message.includes("401 (Unauthorized)"))).toEqual([]);
  await context.close();

  const deepContext = await browser.newContext();
  const deepPage = await deepContext.newPage();
  await deepPage.goto("http://127.0.0.1:5173/settings");
  await expect(deepPage.getByRole("heading", { name: "Archive operations" })).toBeVisible({ timeout: 15_000 });
  expect(new URL(deepPage.url()).pathname).toBe("/settings");
  await deepContext.close();
});

test("reviews and re-renders a captured Journey", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Revisit how the work unfolded." })).toBeVisible();
  await expect(page.getByText("Read the greeting file.")).toBeVisible();
  await page.getByText("Read the greeting file.").click();

  await expect(page.getByTestId("terminal-replay-debugger")).toBeVisible();
  await expect(page.locator(".terminal-session-title strong")).toHaveText("Read the greeting file.");
  await expect(page.getByLabel("Terminal session replay")).toBeVisible();
  const stage = page.frameLocator("iframe.journey-stage");
  await expect(stage.getByText("The file contains the greeting constant.", { exact: true })).toBeVisible();
  await expect(page.locator("iframe.journey-stage")).toHaveAttribute("title", "Pi Journey Stage");

  await page.getByLabel("Renderer").selectOption("builtin.codex-cli");
  await expect(page.locator("iframe.journey-stage")).toHaveAttribute("title", "OpenAI Codex Journey Stage");
  await expect(stage.getByText("The file contains the greeting constant.", { exact: true })).toBeVisible();

  await page.getByLabel("Renderer").selectOption("example.compact-renderer");
  await expect(page.locator("iframe.journey-stage")).toHaveAttribute("title", "Compact Renderer Journey Stage");
  await expect(stage.getByRole("heading", { name: /Custom Journey Stage/u })).toBeVisible();

  await page.getByRole("button", { name: "REPLAY", exact: true }).click();
  await expect(page.getByLabel("Agent Thread replay lanes")).toBeVisible();
  await expect(page.locator(".terminal-pane-header")).toContainText("REPLAY");
  await expect(page.locator(".terminal-transport > span")).toContainText("1/");
  await expect(page.locator(".terminal-play")).toHaveText("Ⅱ");
  await expect(page.locator(".terminal-transport > span")).not.toContainText("1/");
  await page.locator(".terminal-play").click();
  await page.getByRole("button", { name: "Evidence" }).click();
  await expect(page.getByRole("dialog", { name: "Source Evidence inspector" })).toBeVisible();
  await expect(page.getByText("Exact Source Bundle")).toBeVisible();
});

test("uses an Astryx form dialog for Review annotations", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Read the greeting file.", { exact: true }).click();
  await page.getByLabel("Renderer").selectOption("builtin.pi");
  const stage = page.frameLocator("iframe.journey-stage");
  await expect(stage.locator("body")).toHaveCSS("background-color", "rgb(41, 44, 51)");
  await page.locator(".terminal-inspector-actions").getByRole("button", { name: "annotate" }).click();

  const dialog = page.getByRole("dialog", { name: "Review annotation" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/astryx-dialog/u);
  await expect(page.getByRole("heading", { name: "Review annotation" })).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-astryx-theme", "neutral");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.setViewportSize({ width: 390, height: 700 });
  const narrowDialogBox = await dialog.boundingBox();
  expect(narrowDialogBox).not.toBeNull();
  expect(narrowDialogBox!.x).toBeGreaterThanOrEqual(15);
  expect(narrowDialogBox!.x + narrowDialogBox!.width).toBeLessThanOrEqual(375);
  expect(narrowDialogBox!.height).toBeLessThanOrEqual(644);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByLabel("Reviewer note").fill("Follow up on this result");
  await page.getByRole("button", { name: "Save annotation" }).click();
  await expect(dialog).toBeHidden();

  await page.locator(".terminal-inspector-actions").getByRole("button", { name: "annotate" }).click();
  await expect(page.getByLabel("Reviewer note")).toHaveValue("Follow up on this result");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(stage.locator("body")).toHaveCSS("background-color", "rgb(41, 44, 51)");
});

test("uses Astryx across shell controls and forensic dialog shells", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-astryx-theme", "neutral");
  const sourceFilter = page.getByRole("combobox", { name: "Source" });
  await sourceFilter.click();
  await page.getByRole("option", { name: "Pi", exact: true }).click();
  const searchCard = page.locator(".search-journey-card");
  await expect(searchCard).toHaveCount(1);
  await expect(page.locator(".section-title")).toContainText("1 Journey");
  await expect(searchCard).toContainText("12 matching Activities");
  await expect(searchCard).toContainText("12 activities");
  await expect(searchCard).toContainText("/workspace/acme");
  await expect(searchCard.locator("code")).toContainText("33333333");
  await expect(page.getByRole("button", { name: "Clear filters" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("combobox", { name: "From" })).toBeVisible();

  await page.getByText("Read the greeting file.", { exact: true }).click();
  await page.getByRole("button", { name: "coverage / fidelity" }).click();
  const coverage = page.getByRole("dialog", { name: "Coverage & fidelity" });
  await expect(coverage).toHaveClass(/agentjourney-astryx-dialog/u);
  await page.keyboard.press("Escape");
  await expect(coverage).toBeHidden();

  await page.getByRole("button", { name: "Evidence" }).click();
  const evidence = page.getByRole("dialog", { name: "Source Evidence inspector" });
  await expect(evidence).toHaveClass(/agentjourney-astryx-dialog/u);
  await evidence.getByRole("button", { name: "Reveal" }).click();
  await expect(evidence.getByText("Reveal unredacted Source Evidence?")).toBeVisible();
  await evidence.getByRole("button", { name: "Cancel" }).click();
  await page.keyboard.press("Escape");
  await expect(evidence).toBeHidden();

  await page.getByRole("button", { name: "review overlay" }).click();
  const overlay = page.getByRole("dialog", { name: "Organize this Journey" });
  await expect(overlay.getByRole("textbox", { name: "Display title" })).toBeVisible();
  await expect(overlay.getByRole("combobox", { name: "Project" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();

  await page.getByRole("button", { name: "MASKED" }).click();
  const reveal = page.getByRole("alertdialog", { name: "Reveal unredacted Canonical Activity?" });
  await expect(reveal.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(reveal).toBeHidden();
  await expect(page.getByRole("button", { name: "MASKED" })).toBeVisible();
});

test("keeps Astryx Platform Shell controls inside a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Source" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole("link", { name: "Sources" }).click();
  await expect(page.getByRole("button", { name: "Choose directory" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.locator(".astryx-file-input")).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("Pi renderer follows its native TUI visual hierarchy", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Read the greeting file.", { exact: true }).click();
  await page.getByLabel("Renderer").selectOption("builtin.pi");
  const stage = page.frameLocator("iframe.journey-stage");
  await expect(stage.locator("body")).toHaveCSS("background-color", "rgb(41, 44, 51)");
  await expect(stage.locator(".brand-mark")).toBeHidden();
  await expect(stage.locator(".stage-title")).toHaveCSS("color", "rgb(138, 190, 183)");
  await expect(stage.locator(".stage-native-pi-help-line")).toHaveCSS("color", "rgb(128, 128, 128)");
  await expect(stage.locator(".stage-native-pi-key").first()).toHaveCSS("color", "rgb(102, 102, 102)");
  await expect(stage.locator('.activity[data-kind="human-input"]').first()).toHaveCSS(
    "background-color",
    "rgb(52, 53, 65)"
  );
  await expect(stage.locator('.activity[data-kind="reasoning"] details').first()).toHaveAttribute("open", "");
  await expect(stage.locator('.activity[data-kind="tool-invocation"]').first()).toHaveCSS(
    "background-color",
    "rgb(40, 50, 40)"
  );
  await expect(stage.locator('.activity[data-kind="tool-invocation"][data-native-name="bash"]')).toHaveCSS(
    "background-color",
    "rgb(60, 40, 40)"
  );
  await expect(stage.locator('.activity[data-kind="tool-invocation"][data-native-name="bash"] .tool-timeout')).toHaveText(
    "(timeout 30s)"
  );
  const failedToolResult = stage.locator('.activity[data-kind="tool-result"][data-status="failed"]');
  await expect(failedToolResult).toHaveCSS("background-color", "rgb(60, 40, 40)");
  await expect(failedToolResult.locator(".tool-duration")).toHaveText("Took 1.0s");
  await expect(stage.locator(".markdown-heading")).toHaveCSS("color", "rgb(240, 198, 116)");
  await expect(stage.locator(".markdown-list-marker")).toHaveText("1.");
  await expect(stage.locator(".markdown-list-marker")).toHaveCSS("color", "rgb(138, 190, 183)");
  await expect(stage.locator(".stage-native-composer")).toBeVisible();
  await expect(stage.locator('.activity[data-kind="reasoning"] summary').first()).toHaveCSS("font-weight", "400");
  await expect(stage.locator(".stage-native-composer")).toHaveCSS("border-top-color", "rgb(129, 162, 190)");
  const frameBox = await page.locator("iframe.journey-stage").boundingBox();
  const composerBox = await stage.locator(".stage-native-composer").boundingBox();
  const cursorBox = await stage.locator(".stage-native-composer-entry > i").boundingBox();
  expect(frameBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(cursorBox).not.toBeNull();
  expect(composerBox!.height).toBe(38);
  expect(cursorBox).toMatchObject({ width: 8.5, height: 18.5 });
  expect(composerBox!.x - frameBox!.x).toBe(2.5);
  expect(Math.abs((frameBox!.x + frameBox!.width) - (composerBox!.x + composerBox!.width))).toBeLessThan(1);
  await expectNativeChromeDocked(page, stage);
});

test("Claude Code renderer follows the native TUI visual hierarchy", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Inspect greeting module", { exact: true }).click();
  const stage = page.frameLocator("iframe.journey-stage");
  const body = stage.locator("body");
  const human = stage.locator('.activity[data-kind="human-input"]').first();
  const artifact = stage.locator('.activity[data-kind="artifact"]').first();
  const payload = stage.locator(".activity-payload").first();
  const toolArgument = stage.locator(".tool-argument").first();
  await expect(body).toHaveCSS("background-color", "rgb(41, 44, 51)");
  await expect(human).toHaveCSS("background-color", "rgb(58, 58, 58)");
  await expect(human).toHaveCSS("border-left-width", "0px");
  await expect(artifact).toBeHidden();
  await expect(payload).toBeHidden();
  await expect(toolArgument).toHaveText("src/greeting.ts");
  await expect(toolArgument).toHaveCSS("color", "rgb(175, 215, 255)");
  await expect(page.locator(".terminal-native-path")).toHaveCSS("color", "rgb(141, 184, 232)");
  const assistantActivity = await stage.locator('.activity[data-kind="agent-output"]').first().boundingBox();
  const assistantMarker = await stage.locator('.activity[data-kind="agent-output"] .activity-marker').first().boundingBox();
  const assistantText = await stage.locator('.activity[data-kind="agent-output"] .activity-text').first().boundingBox();
  expect(assistantActivity).not.toBeNull();
  expect(assistantMarker).not.toBeNull();
  expect(assistantText).not.toBeNull();
  expect(assistantText!.x - assistantActivity!.x).toBeLessThan(28);
  const markerCenter = assistantMarker!.y + assistantMarker!.height / 2;
  const textFirstLineCenter = assistantText!.y + assistantText!.height / 2;
  expect(Math.abs(markerCenter - textFirstLineCenter)).toBeLessThan(2);
  const claudeMascot = await stage.locator(".brand-mark").evaluate((element) =>
    getComputedStyle(element, "::before").content
  );
  expect(claudeMascot).toContain("▐▛███▛█");
  await expect(stage.locator('.activity[data-kind="reasoning"]')).toBeHidden();
  await expect(stage.locator(".stage-native-composer")).toBeVisible();
  await expect(stage.locator(".stage-native-composer")).toHaveCSS("border-top-color", "rgb(128, 128, 128)");
  await expect(stage.locator(".stage-native-footer")).toBeVisible();
  await expect(stage.locator(".stage-native-footer-permission")).toContainText("bypass permissions on");
  await expect(stage.locator(".stage-native-footer-permission-mode")).toHaveCSS("color", "rgb(255, 135, 175)");
  await expect(stage.locator(".stage-native-footer-permission-help")).toHaveCSS("color", "rgb(148, 148, 148)");
  await expectNativeChromeDocked(page, stage);
});

test("Codex renderer follows the installed native TUI hierarchy", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Run the greeting tests.", { exact: true }).click();
  const stage = page.frameLocator("iframe.journey-stage");
  await expect(stage.locator("body")).toHaveCSS("background-color", "rgb(41, 44, 51)");
  await expect(stage.locator(".stage-title")).toHaveText("OpenAI Codex");
  await expect(stage.locator(".stage-head")).toHaveCSS("border-top-width", "1px");
  const codexContext = stage.locator('.activity[data-kind="context-injection"]');
  await expect(codexContext).toHaveCount(2);
  await expect(codexContext.first()).toBeHidden();
  await expect(codexContext.last()).toBeHidden();
  const interrupted = stage.locator('.activity[data-native-name="turn_aborted"]');
  await expect(interrupted).toContainText("Conversation interrupted");
  await expect(interrupted.locator(".activity-marker")).toHaveCSS("color", "rgb(205, 0, 0)");
  const human = stage.locator('.activity[data-kind="human-input"]').first();
  await expect(human).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const humanMarker = await human.locator(".activity-marker").evaluate((element) =>
    getComputedStyle(element, "::after").content
  );
  expect(humanMarker).toBe('"›"');
  const agentMarker = await stage.locator('.activity[data-kind="agent-output"] .activity-marker').first().evaluate(
    (element) => getComputedStyle(element, "::after").content
  );
  expect(agentMarker).toBe('"•"');
  const codexTool = stage.locator('.activity[data-kind="tool-invocation"]').first();
  await expect(codexTool.locator(".native-name")).toHaveCSS("font-weight", "700");
  await expect(codexTool.locator(".tool-argument")).toHaveText("pnpm test greeting");
  await expect(stage.locator('.activity[data-kind="tool-result"] + .activity[data-kind="agent-output"]')).toHaveCSS(
    "border-top-width",
    "1px"
  );
  await expect(stage.locator(".stage-native-composer")).toBeVisible();
  const placeholder = await stage.locator(".stage-native-composer").evaluate((element) =>
    getComputedStyle(element, "::after").content
  );
  expect(placeholder).toContain("Run /review on my current changes");
  await expect(stage.locator(".stage-native-footer-model")).toHaveCSS("color", "rgb(246, 226, 183)");
  await expect(stage.locator(".stage-native-footer-workspace")).toHaveCSS("color", "rgb(171, 223, 167)");
  await expect(stage.locator(".stage-native-footer-permission")).toHaveText("Ask for approval");
  await expect(stage.locator(".stage-native-footer-permission")).toHaveCSS("color", "rgb(200, 169, 238)");
  await expectNativeChromeDocked(page, stage);
});

test("renders prose around inline Markdown tokens without dropping content", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Inspect greeting module", { exact: true }).click();
  await page.getByLabel("Renderer").selectOption("builtin.claude-code");
  const stage = page.frameLocator("iframe.journey-stage");
  const formattedOutput = stage
    .locator('.activity[data-kind="agent-output"]')
    .filter({ has: stage.locator(".markdown-list-marker") });
  await expect(formattedOutput).toHaveCount(1);
  const renderedText = formattedOutput.locator(".activity-text");
  await expect(renderedText).toContainText("The formal-style update compiled cleanly");
  await expect(renderedText).toContainText("Icons removed");
  await expect(renderedText).toContainText("Links de-emphasized");
  await expect(renderedText).toContainText("Bolder name heading");
  await expect(renderedText).toContainText("Darker section rule");
  await expect(renderedText).toContainText("Verified by rebuilding all three variants");
});

test("GitHub Copilot CLI renderer follows its native colorful TUI hierarchy", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Check the greeting implementation.", { exact: true }).click();
  const stage = page.frameLocator("iframe.journey-stage");
  await expect(stage.locator("body")).toHaveCSS("background-color", "rgb(41, 44, 51)");
  await expect(stage.locator(".stage-native-tabs")).toBeVisible();
  await expect(stage.locator(".stage-native-tabs .active")).toHaveCSS("background-color", "rgb(97, 214, 214)");
  await expect(stage.locator(".stage-native-tabs span").nth(1)).toHaveCSS("background-color", "rgb(12, 12, 12)");
  await expect(stage.locator(".stage-native-tabs span").nth(2)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(stage.getByText("Model changed to copilot-test-model", { exact: true })).toBeVisible();
  await expect(stage.locator('.activity[data-native-name="session.model_change"] .activity-marker')).toHaveCSS(
    "color",
    "rgb(59, 120, 255)"
  );
  await expect(stage.locator(".stage-head")).toBeHidden();
  const copilotPrompt = stage.locator('.activity[data-kind="human-input"]').first();
  await expect(copilotPrompt).toHaveCSS("background-color", "rgb(12, 12, 12)");
  await expect(copilotPrompt.locator(".activity-time-full")).toBeHidden();
  await expect(copilotPrompt.locator(".activity-time-clock")).toHaveText(/^\d{1,2}:\d{2}$/u);
  const intent = stage.locator('.activity[data-native-name="report_intent"]');
  await expect(intent.locator(".activity-marker")).toHaveCSS("color", "rgb(22, 198, 12)");
  await expect(intent.locator(".tool-native-summary")).toHaveText(
    'intent: "Inspecting the greeting implementation" Intent logged'
  );
  const shell = stage.locator('.activity[data-capabilities~="shell"]').first();
  await expect(shell.locator(".activity-marker")).toHaveCSS("color", "rgb(249, 241, 165)");
  await expect(shell.locator(".native-name")).toHaveText("bash");
  await expect(shell.locator(".native-name")).toHaveCSS("font-size", "0px");
  await expect(shell.locator(".tool-native-summary")).toContainText("Check repository metadata");
  await expect(shell.locator(".tool-line-count")).toHaveText("1 line…");
  await expect(shell.locator(".tool-line-count")).toHaveCSS("margin-left", "4px");
  await expect(shell.locator(".tool-native-elapsed")).toHaveText("10s");
  await expect(shell.locator(".link-token")).toHaveCSS("color", "rgb(97, 214, 214)");
  await expect(shell.locator(".tool-argument")).toHaveCSS("white-space", "nowrap");
  await expect(shell.locator(".tool-argument")).toHaveCSS("text-overflow", "ellipsis");
  await expect(stage.locator('.activity[data-kind="agent-output"] .activity-marker').first()).toHaveCSS(
    "color",
    "rgb(188, 68, 167)"
  );
  const copilotToolResults = stage.locator('.activity[data-kind="tool-result"]');
  await expect(copilotToolResults).toHaveCount(3);
  await expect(copilotToolResults.first()).toBeHidden();
  await expect(copilotToolResults.last()).toBeHidden();
  await expect(stage.locator('.activity[data-kind="approval-request"]')).toBeHidden();
  await expect(stage.locator('.activity[data-kind="approval-decision"]')).toBeHidden();
  await expect(stage.locator('.activity[data-kind="context-injection"]').first()).toBeHidden();
  await expect(stage.locator(".stage-native-workspace")).toHaveText("/workspace/acme");
  await expect(stage.locator(".stage-native-workspace")).toBeVisible();
  await expect(stage.locator(".stage-native-composer")).toBeVisible();
  await expect(stage.locator(".stage-native-composer-marker")).toBeHidden();
  await expect(stage.locator(".stage-native-footer-key")).toHaveCount(4);
  await expect(stage.locator(".stage-native-footer-separator")).toHaveText(" · ");
  await expect(stage.locator(".stage-native-footer-effort")).toHaveText("Medium");
  await expectNativeChromeDocked(page, stage);
});

test("Copilot styling does not expose selectable empty reasoning rows", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Inspect greeting module", { exact: true }).click();
  await page.getByLabel("Renderer").selectOption("builtin.github-copilot-cli");
  const stage = page.frameLocator("iframe.journey-stage");
  await expect(stage.locator('.activity[data-kind="reasoning"]:not(:has(.collapsed-activity))')).toHaveCount(0);
  await expect(stage.locator('.activity[data-native-name="mode"]')).toBeHidden();
  await expect(stage.locator('.activity[data-native-name="permission-mode"]')).toBeHidden();
});

test("starts progressive Replay on the first switch from Review", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Read the greeting file.", { exact: true }).click();
  const stage = page.frameLocator("iframe.journey-stage");
  const finalAnswer = stage.getByText("The focused greeting test failed.", { exact: true });
  await expect(finalAnswer).toBeVisible();
  await page.getByRole("button", { name: "REPLAY", exact: true }).click();
  await expect(finalAnswer).toBeHidden();
  await expect(stage.locator(".activity")).toHaveCount(1);
  await expect(page.locator(".terminal-play")).toHaveText("Ⅱ");
  const remaining = page.getByTestId("replay-remaining-time");
  await expect(remaining).toHaveText(/^left \d{2}:\d{2}\.\d$/u);
  await expect(remaining).not.toHaveText("left 00:00.0");
  const initialRemaining = await remaining.textContent();
  await expect.poll(() => remaining.textContent()).not.toBe(initialRemaining);
});

test("simulates prompt typing in the Copilot composer before submission", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Read the greeting file.", { exact: true }).click();
  await page.getByLabel("Renderer").selectOption("builtin.github-copilot-cli");
  const stage = page.frameLocator("iframe.journey-stage");
  const promptPlayback = page.getByLabel("Prompt playback");
  await promptPlayback.selectOption("instant");
  await promptPlayback.selectOption("simulated");
  await expect(page.locator(".terminal-pane-header")).toContainText("simulated prompt typing");
  const typingSpeed = page.getByLabel("Typing speed");
  await expect(typingSpeed).toBeVisible();
  await typingSpeed.selectOption("0.5");
  await expect(typingSpeed).toHaveValue("0.5");
  const draft = stage.locator(".stage-native-composer-draft");
  await expect(draft).toHaveText(/.+/u, { timeout: 5_000 });
  await expect(stage.locator(".stage-native-composer")).toHaveCSS("background-color", "rgb(12, 12, 12)");
  const initialDraftLength = (await draft.textContent())!.length;
  await stage.locator(".stage").evaluate((element) => { element.dataset.typingStage = "stable"; });
  await expect.poll(async () => (await draft.textContent())!.length).toBeGreaterThan(initialDraftLength + 2);
  const play = page.locator(".terminal-play");
  await play.click();
  await expect(stage.locator(".stage")).toHaveAttribute("data-typing-stage", "stable");
  await expect(stage.locator('.activity[data-kind="human-input"]')).toHaveCount(0);
  await expect(page.locator(".terminal-transport > small")).toContainText("SIMULATED prompt typing 0.5×");
  await play.click();
  await expect(stage.locator('.activity[data-kind="human-input"]').getByText("Read the greeting file.", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(draft).toHaveText("");
});

test("replays Claude Code sessions with untimed control records placed by source order", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Inspect greeting module", { exact: true }).click();
  await page.getByRole("button", { name: "REPLAY", exact: true }).click();
  const play = page.locator(".terminal-play");
  await expect(play).toHaveText("Ⅱ");
  await play.click();
  await page.getByLabel("Replay playhead").fill("0");
  await expect(page.locator(".terminal-transport > small")).toContainText(
    "untimed · source-order placement"
  );
  await play.click();
  await expect(page.locator(".terminal-transport > span")).not.toContainText("1/");
});

test("offers clearly labeled simulated TUI streaming when recorded chunks are unavailable", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Read the greeting file.").click();
  const streaming = page.getByLabel("Content streaming");
  await expect(streaming.locator("option[value=recorded]")).toBeDisabled();
  await streaming.selectOption("simulated");
  await expect(page.locator(".terminal-pane-header")).toContainText("simulated stream");
  const streamingSpeed = page.getByLabel("Streaming speed");
  await expect(streamingSpeed).toBeVisible();
  await streamingSpeed.selectOption("8");
  await expect(streamingSpeed).toHaveValue("8");
  await expect(page.locator(".terminal-play")).toHaveText("Ⅱ");
  await expect(page.locator(".terminal-transport > small")).toContainText("SIMULATED cadence", {
    timeout: 5000
  });
  await expect(page.locator(".terminal-transport > small")).toContainText("stream 8×");
});

test("streams long responses without rebuilding the complete Stage", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Inspect greeting module", { exact: true }).click();
  await page.getByLabel("Prompt playback").selectOption("instant");
  await page.getByLabel("Content streaming").selectOption("simulated");
  await page.getByLabel("Streaming speed").selectOption("0.5");
  await page.getByLabel("Replay speed").selectOption("4");
  const stage = page.frameLocator("iframe.journey-stage");
  const streamedText = stage.locator('.activity[data-kind="agent-output"] .activity-text').last();
  await expect(streamedText).toContainText("The formal-style", { timeout: 10_000 });
  const initialLength = (await streamedText.textContent())!.length;
  await stage.locator(".stage").evaluate((element) => { element.dataset.streamingStage = "stable"; });
  await expect.poll(async () => (await streamedText.textContent())!.length).toBeGreaterThan(initialLength);
  await page.locator(".terminal-play").click();
  await expect(stage.locator(".stage")).toHaveAttribute("data-streaming-stage", "stable");
});

test("exports a configurable source-native Replay as MP4", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Read the greeting file.", { exact: true }).click();
  await page.getByRole("button", { name: "export mp4" }).click();
  const dialog = page.getByRole("dialog", { name: "Export Replay as MP4" });
  await expect(dialog).toBeVisible();
  const renderingEngine = dialog.getByRole("combobox", { name: "Rendering engine" });
  await renderingEngine.click();
  await expect(page.getByRole("option", { name: /Microsoft Edge/u })).toBeVisible();
  await expect(page.getByRole("option", { name: /Safari-compatible/u })).toBeVisible();
  await page.getByRole("option", { name: /Microsoft Edge/u }).click();
  await expect(renderingEngine).toContainText("Microsoft Edge");
  await renderingEngine.click();
  await page.getByRole("option", { name: /Auto · Chromium/u }).click();
  await selectAstryxOption(page, dialog, "Quality", "Standard · 720p");
  await selectAstryxOption(page, dialog, "Playback speed", "8×");
  await selectAstryxOption(page, dialog, "Frame rate", "30 fps");
  await selectAstryxOption(page, dialog, "Replay content", "Event steps");
  await dialog.getByRole("checkbox", { name: "Simulate user typing before prompt submission" }).check();
  await selectAstryxOption(page, dialog, "Typing speed", "Fast · 2×");
  await expect(dialog.getByRole("combobox", { name: "Typing speed" })).toContainText("Fast · 2×");
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await dialog.getByRole("button", { name: "Export MP4" }).click();
  const progress = dialog.getByRole("progressbar", { name: "MP4 export progress" });
  await expect(progress).toBeVisible();
  await expect.poll(async () => Number(await progress.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  await expect(dialog).toContainText(/Rendering frame|Encoding H\.264|Finalizing/u);
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/720p-8x\.mp4$/u);
  const filePath = await download.path();
  expect(filePath).not.toBeNull();
  const bytes = await readFile(filePath!);
  expect(bytes.byteLength).toBeGreaterThan(1_000);
  expect(bytes.subarray(4, 8).toString("ascii")).toBe("ftyp");
});

test("previews and downloads the same interactive source-native HTML export", async ({ page }) => {
  let exportRequests = 0;
  page.on("response", (response) => {
    if (response.url().includes("/export/html")) exportRequests += 1;
  });
  await page.goto("/");
  await page.getByText("Read the greeting file.", { exact: true }).click();
  await page.getByLabel("Renderer").selectOption("builtin.pi");
  await page.getByRole("button", { name: "export html" }).click();

  const dialog = page.getByRole("dialog", { name: "Export interactive HTML" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Generate preview" }).click();
  const previewElement = dialog.locator('iframe[title="Interactive HTML export preview"]');
  await expect(previewElement).toBeVisible();
  const preview = dialog.frameLocator('iframe[title="Interactive HTML export preview"]');
  await expect(preview.locator("html")).toHaveAttribute("data-export-ready", "true");
  await expect(preview.getByRole("button", { name: "Replay" })).toBeVisible();
  await expect(preview.getByLabel("Replay playhead")).toBeVisible();
  const exportedStage = preview.frameLocator("#agentjourney-export-stage");
  await expect(exportedStage.locator(".stage-title")).toHaveText("Pi");
  await expect(exportedStage.locator(".stage-native-composer")).toBeVisible();
  await expect(exportedStage.locator(".activity")).toHaveCount(12);

  await preview.locator("#prompt").selectOption("instant");
  await preview.getByLabel("Replay playhead").fill("6");
  await expect(exportedStage.locator(".activity")).toHaveCount(7);
  await expect(preview.locator("#count")).toHaveText("7/12");
  await preview.getByRole("button", { name: "Replay" }).click();
  await expect(exportedStage.locator(".activity")).toHaveCount(1);

  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download HTML" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.html$/u);
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const html = await readFile(downloadedPath!, "utf8");
  expect(html).toContain('id="agentjourney-export-stage"');
  expect(html).toContain("Simulated TUI stream");
  expect(exportRequests).toBe(1);
});

test("terminal transcript fills the available center pane", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Read the greeting file.").click();
  await page.getByTestId("terminal-replay-debugger").waitFor();
  const pane = await page.getByLabel("Terminal session replay").boundingBox();
  const stage = await page.locator(".terminal-stage-frame").boundingBox();
  const inspector = await page.locator(".terminal-activity-inspector").boundingBox();
  expect(pane).not.toBeNull();
  expect(stage).not.toBeNull();
  expect(stage!.height).toBeGreaterThan(pane!.height * 0.75);
  expect(Math.abs((stage!.y + stage!.height) - (pane!.y + pane!.height))).toBeLessThan(2);
  expect(inspector).not.toBeNull();
  expect(inspector!.x + inspector!.width).toBeLessThanOrEqual(1440);
});

test("shows date, size, and turn estimates in source scan previews", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sources" }).click();
  const piSource = page.locator(".source-card").filter({
    has: page.getByRole("heading", { name: "Pi", exact: true })
  });
  await piSource.getByRole("button", { name: "Choose root" }).click();
  const rootDialog = page.getByRole("dialog", { name: "Choose Source Root" });
  await rootDialog.getByRole("textbox", { name: "Absolute Source Root path" }).fill(fixturePath("pi"));
  await rootDialog.getByRole("button", { name: "Approve Source Root" }).click();
  await piSource.getByRole("button", { name: "Preview scan" }).click();
  const candidate = piSource.locator(".discovery-candidate");
  await expect(candidate.locator("time")).toHaveAttribute("datetime", "2026-01-01T10:00:00.000Z");
  await expect(candidate.locator(".discovery-candidate-size")).toContainText(/\d+(?:\.\d+)? (?:KB|B)/u);
  await expect(candidate.locator(".discovery-candidate-turns")).toHaveText("~2 turns");
});

test("shows source consent and archive operations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sources" }).click();
  await expect(page.getByRole("heading", { name: "Source Roots" })).toBeVisible();
  for (const name of ["Claude Code", "OpenAI Codex CLI", "Pi", "GitHub Copilot CLI"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Archive operations" })).toBeVisible();
  await expect(page.getByText("Journey Package import")).toBeVisible();
  await expect(page.getByText("Local Plugins")).toBeVisible();
  await expect(page.locator(".astryx-file-input")).toHaveCount(2);
  await page.getByRole("button", { name: "Rotate secret" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Rotate the local authorization secret?" });
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await page.getByRole("button", { name: "Run automatic cycle" }).click();
  await expect(page.getByLabel("Notifications").getByText("Automatic Capture Cycle complete", { exact: true })).toBeVisible();
});
