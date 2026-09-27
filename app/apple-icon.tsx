import { ImageResponse } from "next/og";

// D5: the home-screen icon on phones (the same mark as app/icon.svg).
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
        background: "#171717",
      }}
    >
      <svg width="120" height="120" viewBox="0 0 64 64">
        <path
          d="M20 16v32M20 34l16-18M26 28l14 20"
          fill="none"
          stroke="#fafafa"
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>,
    size,
  );
}
