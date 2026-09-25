// CLAUDE.md: "No em dashes in any UI copy or docs; use a colon, comma or
// middle dot." Checks every text file git knows about (committed or new, not
// ignored), except the tracker fixtures, which are sample data from real
// sheets. In UI code it also catches the escaped forms, which render the same.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Built from its code point: Prettier would turn an escape into the character.
const EM_DASH = String.fromCharCode(0x2014);
const ESCAPED_EM_DASH = /&mdash;|&#8212;|&#x2014;|\\u2014|\\u\{2014\}/i;
const TEXT_FILE =
  /\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|mts|css|json|ya?ml|sql|html|txt|example)$/i;
const SKIPPED = [/^fixtures\//, /^pnpm-lock\.yaml$/];
const UI_CODE = /^(app|components)\//;

/**
 * @param {string} path Repo-relative path with forward slashes.
 * @returns {boolean} Whether the file is checked at all.
 */
export function isChecked(path) {
  return TEXT_FILE.test(path) && !SKIPPED.some((skip) => skip.test(path));
}

/**
 * @param {Array<{ path: string, content: string }>} files
 * @returns {Array<{ path: string, line: number }>} Every line with an em dash.
 */
export function findEmDashes(files) {
  /** @type {Array<{ path: string, line: number }>} */
  const hits = [];
  for (const { path, content } of files) {
    const checkEscapes = UI_CODE.test(path);
    content.split("\n").forEach((text, index) => {
      if (
        text.includes(EM_DASH) ||
        (checkEscapes && ESCAPED_EM_DASH.test(text))
      ) {
        hits.push({ path, line: index + 1 });
      }
    });
  }
  return hits;
}

function main() {
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path && isChecked(path) && existsSync(path));
  const hits = findEmDashes(
    listed.map((path) => ({ path, content: readFileSync(path, "utf8") })),
  );
  if (hits.length > 0) {
    for (const { path, line } of hits) {
      console.error(
        `${path}:${line}: em dash (use a colon, comma or middle dot)`,
      );
    }
    process.exit(1);
  }
  console.log(`No em dashes in ${listed.length} files.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
