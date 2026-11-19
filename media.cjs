const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { commonsMedia } = require('./project.cjs');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.ogv', '.ogg', '.avi']);
const DOWNLOAD_LIMIT = 150 * 1024 * 1024;
const IMPORT_LIMIT = 4 * 1024 * 1024 * 1024;
const MIME_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.ogg': 'video/ogg', '.avi': 'video/x-msvideo',
};

function inside(parent, filename) {
  const relative = path.relative(parent, filename);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function ownedVideo(folder, filename) {
  if (!filename || !path.isAbsolute(filename) || !VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase())) return '';
  try {
    const [base, resolved] = await Promise.all([fs.realpath(folder), fs.realpath(filename)]);
    const stats = await fs.stat(resolved);
    return inside(base, resolved) && stats.isFile() && stats.size ? resolved : '';
  } catch {
    return '';
  }
}

async function downloadVideo(asset, folder, signal) {
  const url = commonsMedia(asset.downloadUrl);
  if (!url) throw new Error('The footage link was unavailable.');
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  const key = createHash('sha256').update(url).digest('hex');
  const filename = path.join(folder, key + extension);
  const cached = await ownedVideo(folder, filename);
  if (cached) return cached;

  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const response = await fetch(url, {
    signal: requestSignal,
    redirect: 'error',
    headers: { 'User-Agent': 'SpliceDesk/1.0 (desktop video editor; Wikimedia Commons media)' },
  });
  const contentType = response.headers.get('content-type')?.split(';')[0].toLowerCase();
  const isOgg = extension === '.ogg' || extension === '.ogv';
  if (!response.ok || !response.body || (!contentType?.startsWith('video/') && !(isOgg && contentType === 'application/ogg'))) {
    await response.body?.cancel();
    throw new Error('Wikimedia Commons did not return a playable video file.');
  }
  if (Number(response.headers.get('content-length')) > DOWNLOAD_LIMIT) {
    await response.body.cancel();
    throw new Error('The footage exceeds the 150 MB download limit.');
  }

  const temporary = path.join(folder, `${key}.${randomUUID()}.download`);
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > DOWNLOAD_LIMIT) callback(new Error('The footage exceeds the 150 MB download limit.'));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'wx' }), { signal: requestSignal });
    signal.throwIfAborted();
    if (!received) throw new Error('The footage file was empty.');
    await fs.rename(temporary, filename);
    return filename;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function importVideo(source, folder) {
  const extension = path.extname(source).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(extension)) throw new Error('Choose an MP4, MOV, M4V, MKV, WebM, OGV, or AVI video.');
  const info = await fs.stat(source);
  if (!info.isFile() || info.size === 0 || info.size > IMPORT_LIMIT) throw new Error('Choose a nonempty video smaller than 4 GB.');
  const importFolder = path.join(folder, randomUUID());
  await fs.mkdir(importFolder);
  const target = path.join(importFolder, path.basename(source));
  try {
    await fs.copyFile(source, target);
    return target;
  } catch (error) {
    await fs.rm(importFolder, { force: true, recursive: true }).catch(() => {});
    throw error;
  }
}

function createMediaRegistry() {
  const files = new Map();

  return {
    add(filename) {
      const id = randomUUID();
      files.set(id, filename);
      return { id, url: `studio-media://file/${id}` };
    },
    remove(id) {
      files.delete(id);
    },
    async serve(request) {
      const url = new URL(request.url);
      const filename = url.hostname === 'file' && files.get(url.pathname.slice(1));
      if (!filename) return new Response(null, { status: 404 });
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
      const stats = await fs.stat(filename).catch(() => null);
      if (!stats?.size) return new Response(null, { status: 404 });

      const size = stats.size;
      const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Type': MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream',
      });
      let start = 0;
      let end = size - 1;
      let status = 200;
      const range = request.headers.get('range');

      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
          headers.set('Content-Range', `bytes */${size}`);
          return new Response(null, { status: 416, headers });
        }
        if (match[1]) {
          start = Number(match[1]);
          end = match[2] ? Math.min(end, Number(match[2])) : end;
        } else {
          start = Math.max(0, size - Number(match[2]));
        }
        if (start >= size || end < start) {
          headers.set('Content-Range', `bytes */${size}`);
          return new Response(null, { status: 416, headers });
        }
        headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
        status = 206;
      }

      headers.set('Content-Length', String(end - start + 1));
      const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(filename, { start, end }));
      return new Response(body, { status, headers });
    },
  };
}

module.exports = { createMediaRegistry, downloadVideo, importVideo, ownedVideo };
