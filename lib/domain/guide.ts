/**
 * PRD 12.9, N80: the tracker template link the admin saves on the Guide page. Pure: the
 * server action and the Guide's loader use these rules, and the tests check them here.
 */

/** 8.1 settings: the key the link is kept under. */
export const TEMPLATE_LINK_KEY = "tracker_template_url";

/** N80: a Google Sheets file id, 20 to 128 letters, digits, "-" or "_". */
const FILE_ID = /^[A-Za-z0-9_-]{20,128}$/;
const SHEET_PATH = /^\/spreadsheets\/d\/([^/]+)(?:\/.*)?$/;
const MAX_LINK_LENGTH = 2000;

export interface TemplateLink {
  fileId: string;
  /** What Knit saves: https://docs.google.com/spreadsheets/d/{id}. */
  url: string;
  /** Google's make-a-copy page for the template. */
  copyUrl: string;
}

const sheetUrl = (fileId: string) =>
  `https://docs.google.com/spreadsheets/d/${fileId}`;

/** N80: Google's make-a-copy page for a spreadsheet. */
export function templateCopyUrl(fileId: string): string {
  return `${sheetUrl(fileId)}/copy`;
}

/**
 * N80: only a `https://docs.google.com/spreadsheets/d/{id}` link is a template link, with
 * anything after the id (`/edit`, `?usp=sharing`, `#gid=0`). Anything else, a published-to-web
 * link (`/d/e/...`) or another host included, is null.
 */
export function parseTemplateLink(input: string): TemplateLink | null {
  const text = input.trim();
  if (text === "" || text.length > MAX_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "docs.google.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  )
    return null;
  const fileId = SHEET_PATH.exec(url.pathname)?.[1];
  if (fileId === undefined || !FILE_ID.test(fileId)) return null;
  return {
    fileId,
    url: sheetUrl(fileId),
    copyUrl: templateCopyUrl(fileId),
  };
}

/** 12.9: the copy of the template link form and the Guide's template line. */
export const TEMPLATE_LINK_COPY = {
  label: "Link to the tracker template",
  hint: "The Google Sheets link of the blank template. Everyone gets a link to make their own copy. Leave it empty to remove it.",
  submit: "Save link",
  invalid:
    "Paste the link of a Google Sheet. It starts with https://docs.google.com/spreadsheets/d/",
  saved: "Link saved.",
  removed: "Link removed.",
  failed: "The link could not be saved. Try again.",
  get: "Get the tracker template",
  askAdmin: "Ask the admin for the tracker template.",
  noneYet: "No template link yet. Add it under Tracker template link below.",
} as const;
