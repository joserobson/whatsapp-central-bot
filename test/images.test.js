import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createImageStore, MAX_IMAGE_BYTES } from '../src/images.js';

test('upload valida conteúdo, normaliza orientação, remove metadados e persiste JPEG', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'image-store-'));
  const store = createImageStore(dir);
  try {
    const jpeg = await sharp({ create: { width: 100, height: 50, channels: 3, background: '#ff0000' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const first = await store.upload({ mimeType: 'image/jpeg', data: jpeg.toString('base64') });
    assert.equal(first.width, 50); assert.equal(first.height, 100);
    const metadata = await sharp(await store.load(first.id)).metadata();
    assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.exif, undefined);
    const png = await sharp({ create: { width: 3000, height: 1500, channels: 4, background: '#ffffff00' } }).png().toBuffer();
    const result = await store.upload({ mimeType: 'image/png', data: png.toString('base64') });
    assert.equal(result.width, 2048); assert.equal(result.height, 1024);
    assert.ok(result.size < MAX_IMAGE_BYTES);
    assert.deepEqual(await createImageStore(dir).load(result.id), await readFile(join(dir, result.id)));
    assert.equal((await store.upload({ mimeType: 'image/png', data: png.toString('base64') })).id, result.id);
    assert.ok((await readdir(dir)).every(file => file.endsWith('.jpg')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('upload recusa tamanho, falsificação de tipo, corrupção e caminhos arbitrários', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'image-reject-'));
  const store = createImageStore(dir);
  const jpeg = await readFile(new URL('../src/admin/public/example-banner.jpg', import.meta.url));
  try {
    await assert.rejects(store.upload({ mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }), { statusCode: 415 });
    await assert.rejects(store.upload({ mimeType: 'image/png', data: jpeg.toString('base64') }), { statusCode: 422 });
    await assert.rejects(store.upload({ mimeType: 'image/jpeg', data: jpeg.subarray(0, 30).toString('base64') }), { statusCode: 422 });
    await assert.rejects(store.upload({ mimeType: 'image/jpeg', data: Buffer.from('not an image').toString('base64') }), { statusCode: 422 });
    await assert.rejects(store.upload({ mimeType: 'image/jpeg', data: 'invalid!' }), { statusCode: 422 });
    await assert.rejects(store.upload({ mimeType: 'image/jpeg', data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }), { statusCode: 413 });
    await assert.rejects(store.load('../config.json'), { statusCode: 422 });
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
