import { ImageResponse } from "next/og";

// D5: the home-screen icon on phones. PRD 12.2: the Noboru mark (the same as
// app/icon.svg) on white with padding.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#ffffff",
      }}
    >
      <svg width="88" height="120" viewBox="0 0 100 136">
        <polygon points="0,0 94,0 94,107" fill="#77cb35" />
        <polygon points="6,30 6,136 100,136" fill="#212121" />
      </svg>
    </div>,
    size,
  );
}
