import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// PRD 12.2, Noboru brand theme: every text pair meets WCAG AA (4.5:1) and the
// focus ring meets 3:1, in light and in dark. The values are read from
// app/globals.css, so a token change that breaks contrast fails here.

const css = readFileSync("app/globals.css", "utf8");

/** The custom properties declared in the first block that starts at `from`. */
function tokensIn(source: string, from: number): Map<string, string> {
  const open = source.indexOf("{", from);
  const close = source.indexOf("}", open);
  const block = source.slice(open + 1, close);
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1]!, match[2]!.trim());
  }
  return tokens;
}

const lightStart = css.search(/^:root\s*\{/m);
const darkMedia = css.search(/@media \(prefers-color-scheme: dark\)\s*\{/);
const themes = {
  light: tokensIn(css, lightStart),
  dark: tokensIn(css, css.indexOf(":root", darkMedia)),
};

type Rgb = [number, number, number];

/** Linear-light sRGB channel from a gamma-encoded one (0..1). */
function toLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function hexToLinear(hex: string): Rgb {
  const digits =
    hex.length === 4
      ? [...hex.slice(1)].map((d) => d + d)
      : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
  const [r, g, b] = digits.map((d) => toLinear(parseInt(d, 16) / 255));
  return [r!, g!, b!];
}

/** OKLCH to linear sRGB (Björn Ottosson's OKLab matrices), clipped to the gamut. */
function oklchToLinear(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb: Rgb = [
    4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  ];
  return rgb.map((v) => Math.min(1, Math.max(0, v))) as Rgb;
}

/** A solid colour from a token value: #hex or oklch(L C H). */
function parseColor(value: string): Rgb {
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) return hexToLinear(value);
  const oklch = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(
    value,
  );
  if (oklch) {
    const l = Number(oklch[1]) / (oklch[2] ? 100 : 1);
    return oklchToLinear(l, Number(oklch[3]), Number(oklch[4]));
  }
  throw new Error(`Not a solid colour this test can read: ${value}`);
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function token(theme: keyof typeof themes, name: string): Rgb {
  const value = themes[theme].get(name);
  if (!value) throw new Error(`--${name} is missing in the ${theme} theme`);
  return parseColor(value);
}

const WHITE: Rgb = [1, 1, 1];

// [foreground token, background token, minimum ratio]
const PAIRS: [string, string, number][] = [
  ["foreground", "background", 4.5],
  ["muted-foreground", "background", 4.5],
  ["muted-foreground", "muted", 4.5],
  ["muted-foreground", "card", 4.5],
  ["primary-foreground", "primary", 4.5],
  ["card-foreground", "card", 4.5],
  ["popover-foreground", "popover", 4.5],
  ["secondary-foreground", "secondary", 4.5],
  ["accent-foreground", "accent", 4.5],
  ["primary-strong", "background", 4.5],
  ["primary-strong", "card", 4.5],
  ["sidebar-primary-foreground", "sidebar-primary", 4.5],
  ["ring", "background", 3],
  ["ring", "card", 3],
  // The destructive button's focus border is solid --destructive.
  ["destructive", "background", 3],
];

describe("theme contrast (PRD 12.2)", () => {
  it("reads both theme blocks from app/globals.css", () => {
    expect(lightStart).toBeGreaterThanOrEqual(0);
    expect(darkMedia).toBeGreaterThan(lightStart);
    expect(themes.light.get("primary")).toBe("#77cb35");
    expect(themes.dark.get("primary")).toBe("#77cb35");
  });

  it("converts known colours correctly", () => {
    expect(contrast(parseColor("#000"), WHITE)).toBeCloseTo(21, 5);
    expect(contrast(parseColor("oklch(1 0 0)"), WHITE)).toBeCloseTo(1, 3);
    // #77cb35 is oklch(0.7603 0.1972 134.64); both spellings give the same colour.
    const lime = parseColor("#77cb35");
    const limeOklch = parseColor("oklch(0.7603 0.1972 134.64)");
    for (let i = 0; i < 3; i++) expect(limeOklch[i]).toBeCloseTo(lime[i]!, 2);
    // Lime on white is why the darker shade exists.
    expect(contrast(lime, WHITE)).toBeLessThan(3);
  });

  for (const theme of ["light", "dark"] as const) {
    for (const [fg, bg, min] of PAIRS) {
      it(`${theme}: --${fg} on --${bg} is at least ${min}:1`, () => {
        expect(
          contrast(token(theme, fg), token(theme, bg)),
        ).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it("light: the dark green text shade reads on white", () => {
    expect(
      contrast(token("light", "primary-strong"), WHITE),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("dark: lime text reads on the dark surfaces", () => {
    expect(
      contrast(token("dark", "primary"), token("dark", "background")),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

// The --ring pairs above hold only for a solid ring. A halo such as
// `ring-ring/50` blends with the surface (#3d7a12 at 50% over white is about
// 2.1:1), so it must never be the only focus indicator.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(tsx?|css)$/.test(file))
    .map((file) => join(dir, file));
}

const SOURCES = [...sourceFiles("app"), ...sourceFiles("components")].map(
  (file) => ({ file, lines: readFileSync(file, "utf8").split(/\r?\n/) }),
);

function linesMatching(pattern: RegExp): string[] {
  return SOURCES.flatMap(({ file, lines }) =>
    lines.flatMap((line, i) =>
      pattern.test(line) ? [`${file}:${i + 1}`] : [],
    ),
  );
}

describe("focus indicators are solid (PRD 12.2, 3:1 for focus rings)", () => {
  it("scans the app and component sources", () => {
    expect(SOURCES.length).toBeGreaterThan(20);
  });

  it("the default focus outline (plain links) uses the solid ring colour", () => {
    expect(css).toMatch(/@apply border-border outline-ring;/);
    expect(linesMatching(/outline-ring\/\d/)).toEqual([]);
  });

  it("every translucent ring halo sits next to a solid ring border", () => {
    const halos = linesMatching(/ring-ring\/\d/);
    expect(halos.length).toBeGreaterThan(0);
    const alone = SOURCES.flatMap(({ file, lines }) =>
      lines.flatMap((line, i) =>
        /ring-ring\/\d/.test(line) &&
        !/focus-visible:border-ring(?![\w/-])/.test(line)
          ? [`${file}:${i + 1}`]
          : [],
      ),
    );
    expect(alone).toEqual([]);
  });

  it("no focus border is made translucent", () => {
    expect(linesMatching(/focus-visible:border-[\w-]+\/\d/)).toEqual([]);
  });

  it("the calendar day cells use the solid ring", () => {
    const calendar = readFileSync("components/month-calendar.tsx", "utf8");
    expect(calendar).toMatch(/focus-visible:ring-ring(?![\w/-])/);
  });
});

describe("the Noboru mark (PRD 12.2)", () => {
  const LIME = "0,0 94,0 94,107";
  const DARK = "6,30 6,136 100,136";

  it.each(["components/brand-mark.tsx", "app/icon.svg", "app/apple-icon.tsx"])(
    "%s draws the same two triangles",
    (file) => {
      const source = readFileSync(file, "utf8");
      expect(source).toContain(`points="${LIME}"`);
      expect(source).toContain(`points="${DARK}"`);
      expect(source).toContain("#77cb35");
    },
  );

  it("is decorative in the app, so the wordmark keeps its accessible name", () => {
    expect(readFileSync("components/brand-mark.tsx", "utf8")).toContain(
      "aria-hidden",
    );
    expect(readFileSync("components/top-bar.tsx", "utf8")).toContain(
      'aria-label="Knit, Today"',
    );
  });

  it("the app icon turns light in dark mode", () => {
    const icon = readFileSync("app/icon.svg", "utf8");
    expect(icon).toContain("#212121");
    expect(icon).toMatch(/@media \(prefers-color-scheme: dark\)[^}]*#f5f5f5/);
  });
});
