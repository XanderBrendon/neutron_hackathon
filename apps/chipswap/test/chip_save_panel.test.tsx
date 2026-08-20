import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChipSavePanel } from "../src/chip_save_panel.tsx";

const markup = (props: Partial<Parameters<typeof ChipSavePanel>[0]> = {}) =>
  renderToStaticMarkup(
    <ChipSavePanel
      fileName="moonrise-4-496px.png"
      onClose={() => {}}
      scale={16}
      src="data:image/png;base64,AAAA"
      title="Moonrise"
      {...props}
    />,
  );

// The browser names a saved image after the URL it came from, which for a data
// URL is nothing useful. The name we would have given it has to be on screen.
test("the panel shows the name to save the chip under", () => {
  expect(markup()).toContain("moonrise-4-496px.png");
});

test("the panel says how large the saved image really is", () => {
  expect(markup()).toContain("496 × 496");
  expect(markup({ fileName: "moonrise-4-31px.png", scale: 1 })).toContain("31 × 31");
});

// The whole point of the panel: downloads are blocked in the app frame, so the
// browser's own menu is the way out. Saying so is the feature.
test("the panel explains how to save the image", () => {
  expect(markup()).toContain("Save image as");
});

test("the image is the chip, described for anyone not seeing it", () => {
  const html = markup();
  expect(html).toContain('src="data:image/png;base64,AAAA"');
  expect(html).toContain('alt="Moonrise at 496 by 496 pixels"');
});

// A 31x31 image shown large must stay a grid of squares, not a blur.
test("the preview keeps its pixels crisp", () => {
  expect(markup()).toContain("chipswap-save-image");
});
