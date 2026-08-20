// Handing a chip to the person looking at it. The app frame is sandboxed
// without `allow-downloads`, so nothing inside it can start a download: an
// anchor with a download attribute is refused whether script clicks it or a
// person does. What the frame can do is put the finished PNG on screen as a
// real image, and let the browser's own menu take it from there.

import { DIAMETER } from "./chip.ts";

type Props = {
  title: string;
  fileName: string;
  scale: number;
  /** The PNG itself, as a data URL, so there is no object URL to outlive. */
  src: string;
  onClose: () => void;
};

export const ChipSavePanel = ({ title, fileName, scale, src, onClose }: Props) => {
  const side = DIAMETER * scale;
  return (
    <div className="nt-dialog chipswap-save" role="dialog" aria-label={`Save ${title}`}>
      <h3 className="nt-section-title">Save “{title}”</h3>
      <div className="nt-dialog-body">
        <img
          alt={`${title} at ${side} by ${side} pixels`}
          className="chipswap-save-image"
          height={side}
          src={src}
          width={side}
        />
        <p className="nt-help">
          Right-click the chip and choose “Save image as…”. On a touch screen,
          press and hold it instead.
        </p>
        <p className="nt-meta">
          {side} × {side} pixels, transparent outside the circle. Your browser
          will suggest a name of its own — this chip is{" "}
          <strong>{fileName}</strong>.
        </p>
      </div>
      <div className="nt-dialog-actions">
        <button
          className="nt-button nt-button--ghost nt-button--sm"
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>
    </div>
  );
};
