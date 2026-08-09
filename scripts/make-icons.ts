import sharp from 'sharp';

async function icon(size: number, out: string, padRatio: number) {
  const pad = Math.round(size * padRatio);
  const logo = await sharp('public/bni-logo.jpg')
    .resize(size - pad * 2, size - pad * 2, { fit: 'inside' })
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: logo, gravity: 'centre' }])
    .png()
    .toFile(out);
}

async function main() {
  await icon(512, 'public/icon-512.png', 0.12);
  await icon(192, 'public/icon-192.png', 0.12);
  await icon(512, 'public/icon-maskable-512.png', 0.2);
  console.log('Icons generated');
}
main();
