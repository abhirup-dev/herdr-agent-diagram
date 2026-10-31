import { describe, expect, test } from "bun:test";
import { applyDarkModeFilter } from "@excalidraw/common";
import { darkColor, isDark } from "../src/canvas/color.ts";
import { PALETTE } from "../src/canvas/edit.ts";

describe("dark mode colours", () => {
  test("match Excalidraw's applyDarkModeFilter across the palette", () => {
    const colors = [...PALETTE.flatMap(([, shades]) => shades), "#1e1e1e", "#ffffff", "#000", "#1e1e1e80", "#a5d8ffcc"];
    for (const c of colors) expect(darkColor(c)).toBe(applyDarkModeFilter(c));
  });
  test("non-hex colours pass through; isDark reads luminance", () => {
    expect(darkColor("transparent")).toBe("transparent");
    expect(isDark("#121212")).toBe(true);
    expect(isDark("#fdf6e3")).toBe(false);
  });
});
