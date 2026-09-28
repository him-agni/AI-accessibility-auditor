/**
 * Image alt text: a deterministic placeholder check on every scan, and screenshots
 * for the optional AI review.
 *
 * axe checks that an image has an alt attribute. It does not read the value, so
 * `alt="IMG_0042.jpg"` or `alt="logo"` passes. WCAG names exactly these —
 * file names and placeholder text — as a failure of 1.1.1 (technique F30), which
 * makes them measurable without a model.
 *
 * Whether a real description is *accurate* is a judgement, and that part is the
 * AI review in `lib/fixes/alt-review.ts`, off unless ALT_TEXT_REVIEW is set.
 * Screenshots are taken here, only when asked, because they must come from the
 * already-rendered page: fetching image URLs from the Worker would bypass the
 * request guard every browser request goes through.
 *
 * Best-effort: a failure returns no findings.
 */
import type { FindingInput, ImageSample, Occurrence } from "../fixes/types";

const MAX_EVIDENCE = 4;
/** Images sent to the model per audit. Each is one inline image in one request. */
const MAX_REVIEWED = 6;
const MAX_SCREENSHOT_PX = 512;

export type PageImage = {
  selector: string;
  html: string;
  alt: string;
  src: string;
  context: string;
  /** Position in document coordinates, for the screenshot clip. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ImageInspection = {
  /** Visible, loaded images with non-empty alt text. */
  images: PageImage[];
  /** Screenshots for the AI review; empty unless capture was requested. */
  samples: ImageSample[];
};

interface ImagePage {
  evaluate<T>(fn: () => T): Promise<T>;
  screenshot(options: {
    type: "jpeg";
    quality: number;
    encoding: "base64";
    clip: { x: number; y: number; width: number; height: number; scale: number };
  }): Promise<string | Uint8Array>;
}

/* -- runs inside the page; it must not close over anything in this module -- */

function collectImages(): PageImage[] {
  const MAX_IMAGES = 200;
  const MIN_SIDE = 32;
  const clean = (value: string) => value.replace(/\s+/g, " ").trim();

  const images: PageImage[] = [];
  for (const img of document.querySelectorAll("img[alt]")) {
    const image = img as HTMLImageElement;
    const alt = clean(image.getAttribute("alt") || "");
    const rect = image.getBoundingClientRect();
    const style = getComputedStyle(image);
    if (!alt || rect.width < MIN_SIDE || rect.height < MIN_SIDE) continue;
    if (!image.complete || image.naturalWidth === 0 || style.visibility === "hidden" || style.opacity === "0") continue;

    const caption = image.closest("figure")?.querySelector("figcaption");
    const control = image.closest("a[href], button");
    const around = image.closest("figure, a, button, li, p") ?? image.parentElement?.parentElement ?? image.parentElement;
    const context = [
      caption ? `caption: ${clean(caption.textContent || "").slice(0, 150)}` : "",
      control ? `inside a ${control.tagName === "A" ? "link" : "button"}` : "",
      around ? `nearby text: ${clean(around.textContent || "").slice(0, 200)}` : "",
    ].filter((part) => part && !part.endsWith(": ")).join(" | ");

    let selector = "img";
    if (image.id) selector += `#${image.id}`;
    else if (image.classList.length) selector += `.${[...image.classList].slice(0, 2).join(".")}`;

    images.push({
      selector,
      html: (image.outerHTML || "").slice(0, 300),
      alt: alt.slice(0, 200),
      src: (image.currentSrc || image.src || "").slice(0, 300),
      context,
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    });
    if (images.length >= MAX_IMAGES) break;
  }
  return images;
}

/* -- placeholder detection, pure so it can be tested -- */

const FILE_EXTENSION = /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?)$/i;
const CAMERA_NAME = /^(img|image|dsc[nf]?|pxl|photo|screenshot|screen shot|capture)[\s_-]*\d{2,}/i;
const OPAQUE_ID = /^[\d\s_-]+$|^[0-9a-f]{8,}$/i;
const GENERIC_WORDS = new Set([
  "image", "img", "photo", "photograph", "picture", "pic", "graphic", "logo", "icon", "banner",
  "spacer", "placeholder", "thumbnail", "thumb", "untitled", "alt", "alt text", "null", "undefined",
  "none", "blank", "default", "hero", "hero image", "image of", "photo of", "picture of",
]);

function fileStem(src: string) {
  const file = src.split(/[?#]/)[0].split("/").pop() ?? "";
  try {
    return decodeURIComponent(file).replace(FILE_EXTENSION, "").toLowerCase();
  } catch {
    return file.toLowerCase();
  }
}

/** Why an alt value is a placeholder rather than a description, or null if it is not. */
function placeholderReason(alt: string, src = ""): string | null {
  const value = alt.trim();
  const words = value.toLowerCase().replace(/["'“”‘’.,:;!?()[\]]/g, "").replace(/\s+/g, " ").trim();
  const stem = fileStem(src);

  if (FILE_EXTENSION.test(value)) return "is a file name";
  // Only a stem that looks machine-made: "acme.png" with alt "Acme" is a fine logo.
  if (stem && /[-_\d]/.test(stem) && value.toLowerCase() === stem) return "repeats the image's file name";
  if (CAMERA_NAME.test(value)) return "is a camera or screenshot file name";
  if (OPAQUE_ID.test(value)) return "is a number or ID, not a description";
  if (GENERIC_WORDS.has(words)) return `is the generic word "${value}", which says nothing about this image`;
  return null;
}

/** Placeholders first, since they need a suggestion most; then the largest images. */
function pickForReview(images: PageImage[]) {
  const area = (image: PageImage) => image.width * image.height;
  return [...images]
    .sort((a, b) => Number(placeholderReason(b.alt, b.src) !== null) - Number(placeholderReason(a.alt, a.src) !== null) || area(b) - area(a))
    .slice(0, MAX_REVIEWED);
}

async function screenshot(page: ImagePage, image: PageImage): Promise<ImageSample | null> {
  try {
    const scale = Math.min(1, MAX_SCREENSHOT_PX / Math.max(image.width, image.height));
    const data = await page.screenshot({
      type: "jpeg",
      quality: 70,
      encoding: "base64",
      clip: { x: Math.max(0, image.x), y: Math.max(0, image.y), width: image.width, height: image.height, scale },
    });
    if (typeof data !== "string" || !data) return null;
    return { selector: image.selector, html: image.html, alt: image.alt, context: image.context, jpegBase64: data };
  } catch {
    return null;
  }
}

/**
 * Collect images with alt text and, when `capture` is set, screenshot the ones
 * worth reviewing. Returns null on any failure.
 */
export async function inspectImages(page: ImagePage, capture: boolean): Promise<ImageInspection | null> {
  try {
    const images = await page.evaluate(collectImages);
    const samples: ImageSample[] = [];
    // One at a time: screenshots share the page, so they cannot run in parallel.
    for (const image of capture ? pickForReview(images) : []) {
      const sample = await screenshot(page, image);
      if (sample) samples.push(sample);
    }
    return { images, samples };
  } catch {
    return null;
  }
}

/** Placeholder alt text as a 1.1.1 finding. Carries `detector: "heuristic"`. */
export function imageFindings(result: ImageInspection | null): FindingInput[] {
  const placeholders = (result?.images ?? [])
    .map((image) => ({ image, reason: placeholderReason(image.alt, image.src) }))
    .filter((entry): entry is { image: PageImage; reason: string } => entry.reason !== null);
  if (placeholders.length === 0) return [];

  return [{
    ruleId: "alt-text-placeholder",
    kind: "violation",
    detector: "heuristic",
    impact: "moderate",
    title: "Images use file names or placeholder words as alt text",
    explanation: "These images have alt text, so automated checks pass them, but the text is a file name, an ID, or a word like \"image\" or \"logo\". A screen reader reads it out as if it were a description, and the person learns nothing about what the image shows or does.",
    wcag: [{ label: "1.1.1 Non-text Content", href: "https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html" }],
    count: placeholders.length,
    occurrences: placeholders.slice(0, MAX_EVIDENCE).map(({ image, reason }): Occurrence => ({
      selector: image.selector,
      html: image.html || "(markup not captured)",
      failure: `The alt text "${image.alt}" ${reason}.`,
    })),
  }];
}
