import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const validImageId = value => typeof value === 'string' && /^[a-f0-9]{64}\.jpg$/.test(value);
const failure = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export function createImageStore(directory) {
  return {
    async upload(body) {
      if (!body || Object.keys(body).some(key => !['data', 'mimeType'].includes(key)) || !['image/jpeg', 'image/png'].includes(body.mimeType)) throw failure(415, 'image_type_not_supported');
      if (typeof body.data === 'string' && body.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw failure(413, 'image_too_large');
      if (typeof body.data !== 'string' || !body.data.length || body.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw failure(422, 'invalid_image');
      const input = Buffer.from(body.data, 'base64');
      if (input.toString('base64') !== body.data) throw failure(422, 'invalid_image');
      if (input.length > MAX_IMAGE_BYTES) throw failure(413, 'image_too_large');
      let output;
      try {
        const image = sharp(input, { limitInputPixels: 40_000_000, failOn: 'warning' });
        const metadata = await image.metadata();
        const expected = body.mimeType === 'image/png' ? 'png' : 'jpeg';
        if (metadata.format !== expected || (metadata.pages ?? 1) !== 1) throw new Error('unsupported_image');
        output = await image.rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
      } catch { throw failure(422, 'invalid_image'); }
      if (output.data.length > MAX_IMAGE_BYTES) throw failure(413, 'image_too_large');
      const id = `${createHash('sha256').update(output.data).digest('hex')}.jpg`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, output.data, { flag: 'wx', mode: 0o600 });
        await rename(temporary, join(directory, id));
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
      return { id, width: output.info.width, height: output.info.height, size: output.data.length, mimeType: 'image/jpeg' };
    },
    async load(id) {
      if (!validImageId(id)) throw failure(422, 'invalid_image_id');
      try { return await readFile(join(directory, id)); }
      catch (error) { if (error.code === 'ENOENT') throw failure(422, 'uploaded_image_not_found'); throw error; }
    }
  };
}
