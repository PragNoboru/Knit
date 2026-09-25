import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

// Server-side modules: secrets, the sync engine, Google access. UI components
// never import them (CLAUDE.md invariants 9 and 10). The build also fails if
// client code reaches lib/env.ts, which imports "server-only".
const SERVER_MODULES = [
  "@/lib/env",
  "@/lib/supabase/service",
  "@/lib/sync/*",
  "@/lib/sheets/*",
  "server-only",
  "googleapis",
  "google-auth-library",
];

const READS_THE_CLOCK =
  "Domain code is pure: take `today` as a parameter instead of reading the clock.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    rules: {
      // CLAUDE.md: TypeScript strict, no `any`.
      "@typescript-eslint/no-explicit-any": "error",
      // CLAUDE.md: zod at every boundary. Environment variables are read
      // only in lib/env.ts and lib/public-env.ts, where they are validated.
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read environment variables through lib/env.ts or lib/public-env.ts, where zod validates them.",
        },
      ],
    },
  },
  {
    files: [
      "lib/env.ts",
      "lib/public-env.ts",
      "instrumentation.ts",
      "*.config.{ts,mts,mjs}",
      "scripts/**",
      "tests/**",
    ],
    rules: { "no-restricted-properties": "off" },
  },
  {
    // Domain functions are pure and take `today` as a parameter (CLAUDE.md
    // conventions and invariant 1).
    files: ["lib/domain/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: READS_THE_CLOCK,
        },
        {
          selector:
            "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: READS_THE_CLOCK,
        },
      ],
    },
  },
  {
    // UI components hold no business rules and no secrets (PRD 16).
    files: ["components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: SERVER_MODULES,
              message:
                "UI components must not import server modules; pass data from a Server Component or call a server action.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
