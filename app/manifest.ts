import type { MetadataRoute } from "next";

// D5: installable to the home screen (web manifest, no offline mode).
// PRD 12.2: white like the top bar and the icon background; the mark carries the brand.
// The install icon is the mark on a white tile (public/icon-tile.svg), like
// app/apple-icon.tsx, so its near-black triangle stays visible on a dark
// launcher or taskbar. app/icon.svg stays the transparent browser-tab icon.
// In dark mode the title bar follows the viewport themeColor in app/layout.tsx.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Knit",
    short_name: "Knit",
    description: "Daily tasks from the team's trackers",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon-tile.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
