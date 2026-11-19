const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const extractZip = require('extract-zip');

const run = promisify(execFile);
const version = '8.1.2';
const expectedHash = 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec';
const archiveRoot = `ffmpeg-${version}-essentials_build`;
const archiveUrl = `https://www.gyan.dev/ffmpeg/builds/packages/${archiveRoot}.zip`;
const projectRoot = path.resolve(__dirname, '..');
const cache = path.resolve(process.env.SPLICE_BUILD_CACHE || path.join(projectRoot, '.cache'));
const destination = path.join(projectRoot, 'stage', 'win', 'ffmpeg');

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const buffer of createReadStream(file)) hash.update(buffer);
  return hash.digest('hex');
}

async function cachedArchive() {
  const archive = path.join(cache, `ffmpeg-${version}.zip`);
  let actualHash;
  try {
    actualHash = await sha256(archive);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (actualHash === expectedHash) return archive;

  const downloadDir = await fs.mkdtemp(path.join(cache, 'ffmpeg-download-'));
  const download = path.join(downloadDir, 'ffmpeg.zip');
  try {
    console.log(`Downloading FFmpeg ${version} for Windows x64`);
    await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--fail', '--location', '--silent', '--show-error', '--retry', '3',
      '--connect-timeout', '20', '--max-time', '300', '--output', download, archiveUrl
    ]);
    if (await sha256(download) !== expectedHash) {
      throw new Error(`FFmpeg ${version} archive checksum does not match the pinned release`);
    }
    await fs.rename(download, archive);
  } finally {
    await fs.rm(downloadDir, { recursive: true, force: true });
  }
  return archive;
}

async function stage() {
  await fs.mkdir(cache, { recursive: true });
  const archive = await cachedArchive();
  const extracted = await fs.mkdtemp(path.join(cache, 'ffmpeg-extract-'));
  try {
    await extractZip(archive, { dir: extracted });
    const directory = path.join(extracted, archiveRoot);
    await fs.mkdir(destination, { recursive: true });
    await Promise.all([
      fs.copyFile(path.join(directory, 'bin', 'ffmpeg.exe'), path.join(destination, 'ffmpeg.exe')),
      fs.copyFile(path.join(directory, 'bin', 'ffprobe.exe'), path.join(destination, 'ffprobe.exe')),
      fs.copyFile(path.join(directory, 'LICENSE'), path.join(destination, 'LICENSE')),
      fs.copyFile(path.join(directory, 'README.txt'), path.join(destination, 'BUILD-README.txt')),
      fs.writeFile(path.join(destination, 'SOURCE.txt'), [
        `FFmpeg ${version} Windows x64 essentials binaries from Gyan Doshi`,
        `Binary archive: ${archiveUrl}`,
        `Binary archive SHA-256: ${expectedHash}`,
        'FFmpeg source code: https://github.com/FFmpeg/FFmpeg/commit/38b88335f9',
        'FFmpeg source archive: https://github.com/FFmpeg/FFmpeg/archive/38b88335f9.tar.gz',
        'Upstream build information and library list: https://www.gyan.dev/ffmpeg/builds/',
        'Upstream binary release and build repository: https://github.com/GyanD/codexffmpeg',
        'See LICENSE and BUILD-README.txt for the binaries’ license and build details.',
        ''
      ].join('\n'), 'utf8')
    ]);
    console.log(`FFmpeg and FFprobe are staged in ${destination}`);
  } finally {
    await fs.rm(extracted, { recursive: true, force: true });
  }
}

stage().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
