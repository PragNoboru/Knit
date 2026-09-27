import type { MetadataRoute } from "next";

// D5: installable to the home screen (web manifest, no offline mode).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Knit",
    short_name: "Knit",
    description: "Daily tasks from the team's trackers",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#171717",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
