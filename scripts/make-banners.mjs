// Render assets/banner-{light,dark}.svg to PNG with resvg (system fonts).
// Output is 2x (2024x688) so the README picture stays sharp on retina.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const dir = fileURLToPath(new URL('../assets/', import.meta.url));
for (const name of ['banner-light', 'banner-dark']) {
  const svg = readFileSync(`${dir}${name}.svg`, 'utf8');
  const png = new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 } }).render().asPng();
  writeFileSync(`${dir}${name}.png`, png);
  console.log(`${name}.png`, png.length, 'bytes');
}
