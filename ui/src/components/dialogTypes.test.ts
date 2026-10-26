import { describe, expect, test } from "bun:test";
import {
  dialogCancelLabel,
  dialogConfirmLabel,
  dialogTone,
  type ActiveDialog,
  type AlertOptions,
  type ConfirmOptions,
  type PromptOptions,
} from "./dialogTypes";

const noop = () => { /* test resolver — result unused */ };

function confirm(opts: Partial<ConfirmOptions> = {}): ActiveDialog {
  return { kind: "confirm", opts: { title: "t", ...opts }, resolve: noop };
}
function prompt(opts: Partial<PromptOptions> = {}): ActiveDialog {
  return { kind: "prompt", opts: { title: "t", ...opts }, resolve: noop };
}
function alert(opts: Partial<AlertOptions> = {}): ActiveDialog {
  return { kind: "alert", opts: { title: "t", ...opts }, resolve: noop };
}

describe("dialogTone", () => {
  test("confirm and alert honor their tone", () => {
    expect(dialogTone(confirm({ title: "t", tone: "danger" }))).toBe("danger");
    expect(dialogTone(alert({ title: "t", tone: "danger" }))).toBe("danger");
  });
  test("defaults and prompts are neutral", () => {
    expect(dialogTone(confirm())).toBe("default");
    expect(dialogTone(prompt())).toBe("default");
  });
});

describe("dialogConfirmLabel", () => {
  test("explicit label wins", () => {
    expect(dialogConfirmLabel(confirm({ title: "t", confirmLabel: "Yes" }), "default")).toBe("Yes");
  });
  test("danger confirm defaults to Delete", () => {
    expect(dialogConfirmLabel(confirm(), "danger")).toBe("Delete");
  });
  test("neutral confirm defaults to OK, prompt to Save, alert to OK", () => {
    expect(dialogConfirmLabel(confirm(), "default")).toBe("OK");
    expect(dialogConfirmLabel(prompt(), "default")).toBe("Save");
    expect(dialogConfirmLabel(alert(), "default")).toBe("OK");
  });
});

describe("dialogCancelLabel", () => {
  test("confirm and prompt default to Cancel", () => {
    expect(dialogCancelLabel(confirm())).toBe("Cancel");
    expect(dialogCancelLabel(prompt())).toBe("Cancel");
  });
  test("alerts have no cancel button", () => {
    expect(dialogCancelLabel(alert())).toBeNull();
  });
});
