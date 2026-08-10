import sharp from 'sharp';

// bni-logo.jpg is a plain red-on-white JPEG (no alpha channel) — this reads
// its raw pixels and writes public/bni-logo-transparent.png with the white
// background knocked out, for use anywhere the logo sits on a colored or
// dark page background (the kiosk header). bni-logo.jpg itself is left
// untouched and stays in use by scripts/make-icons.ts, which needs a solid
// (non-transparent) background to composite the home-screen icons onto.
//
// Usage: npx tsx scripts/process-logos.ts

const SRC = 'public/bni-logo.jpg';
const OUT = 'public/bni-logo-transparent.png';

// A pixel counts as "background" once every channel clears WHITE_THRESHOLD.
// Below RAMP_START it's treated as fully-opaque logo ink. In between, alpha
// ramps linearly rather than snapping straight from 0 to 255 — a hard cutoff
// at a single threshold leaves a visible jagged/aliased edge around curved
// letterforms; the ramp gives antialiasing pixels a soft fade instead.
const RAMP_START = 230;
const WHITE_THRESHOLD = 245;

async function main() {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels !== 4) throw new Error(`expected 4 channels after ensureAlpha(), got ${channels}`);

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // "near-white" means ALL THREE channels are high, not just the average —
    // a saturated color with high luminance (e.g. bright yellow) shouldn't
    // get knocked out just because it's "light". min() enforces that.
    const minChannel = Math.min(r, g, b);

    let alpha: number;
    if (minChannel >= WHITE_THRESHOLD) {
      alpha = 0;
    } else if (minChannel <= RAMP_START) {
      alpha = 255;
    } else {
      const t = (minChannel - RAMP_START) / (WHITE_THRESHOLD - RAMP_START);
      alpha = Math.round(255 * (1 - t));
    }
    data[i + 3] = alpha;
  }

  await sharp(data, { raw: { width, height, channels } }).png().toFile(OUT);
  console.log(`Wrote ${OUT} (${width}x${height})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
