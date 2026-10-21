// Run in the application Docker image with the repository bind-mounted at /app.
import sharp from 'sharp';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
for (const size of [16, 48, 128]) await sharp(resolve(root, 'public/content-studio.svg')).resize(size, size).png().toFile(resolve(root, `extension/assets/icon-${size}.png`));
