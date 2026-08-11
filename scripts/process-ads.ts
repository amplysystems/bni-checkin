import sharp from 'sharp';

// Re-derives the four ad creatives (public/ads/*.jpg) from their original,
// uncompressed source files on the desktop. The versions previously checked
// into public/ads/*.png were produced from an already lossy-compressed
// intermediate and looked soft once stretched full-bleed in the attract loop
// / splash backdrop / (former) login panel. This reads the true originals
// instead. Mirrors scripts/process-logos.ts's structure/usage pattern.
//
// Usage: npx tsx scripts/process-ads.ts

const JOBS: { src: string; out: string }[] = [
  { src: 'C:\\Users\\barri\\OneDrive\\Desktop\\BNI\\BNI Hero.png', out: 'public/ads/hero.jpg' },
  { src: 'C:\\Users\\barri\\OneDrive\\Desktop\\BNI\\BNI = YOUR BUSINESS DESERVES.png', out: 'public/ads/deserves.jpg' },
  { src: 'C:\\Users\\barri\\OneDrive\\Desktop\\BNI\\BNI Theyre Building.png', out: 'public/ads/building.jpg' },
  // REMOVED 2026-08-11 — do not restore: "BNI ASK HIM.png" ("Ask him what a
  // referral is worth") pictures a member who withdrew consent for his
  // likeness. The source file still exists on the Desktop (it's Jason's
  // asset, not ours to delete), which is exactly why this entry is commented
  // out rather than silently dropped: re-running this script must never
  // re-publish it. See ADS in app/kiosk/kiosk-client.tsx.
  // { src: '...BNI ASK HIM.png', out: 'public/ads/ask.jpg' },
];

// withoutEnlargement means a source narrower than this keeps its native
// width rather than being upscaled.
const TARGET_WIDTH = 2048;
const JPEG_QUALITY = 85;

async function main() {
  for (const { src, out } of JOBS) {
    const info = await sharp(src)
      .resize({ width: TARGET_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toFile(out);
    console.log(`${out}: ${info.width}x${info.height}, ${(info.size / 1024).toFixed(0)}KB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
