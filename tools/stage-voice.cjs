const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, promises: fs } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const stage = path.resolve(__dirname, '..', 'stage');
const downloads = path.join(stage, 'voice-downloads');
const version = '2.0.2';
const modelArchive = 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2';
const ortDirectory = 'onnxruntime-win-x64-MT-Release-1.28.2';
const nativeHashes = {
  win: 'b49c291b694277955b5a6a06dd6b0f7f328a437e0a345befd0f7454450738079',
  linux: '09c70eb7f9d5abee48ca135dc5ed1ab33f4df765dc38d8acf9e4969365b2eea4',
};

async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function obtain(name, url, hash) {
  const file = path.join(downloads, name);
  try {
    if (await sha256(file) === hash) return file;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await exec('curl', ['-fLsS', '--connect-timeout', '15', '--max-time', '240', '--retry', '2', '-o', temporary, url]);
    if (await sha256(temporary) !== hash) throw new Error(`Integrity check failed for ${name}`);
    await fs.rename(temporary, file);
    return file;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function npmPackage(name, hash) {
  const filename = `${name}-${version}.tgz`;
  return obtain(filename, `https://registry.npmjs.org/${name}/-/${filename}`, hash);
}

async function extract(file, target, ...members) {
  await fs.mkdir(target, { recursive: true });
  await exec('tar', ['-xf', file, '-C', target, '--strip-components=1', ...members]);
}

async function main() {
  const platform = process.argv[2] || (process.platform === 'win32' ? 'win' : 'linux');
  if (!Object.hasOwn(nativeHashes, platform)) throw new Error('Specify either win or linux for x64 voice staging.');
  const target = path.join(stage, platform, 'voice');
  const marker = path.join(target, 'STAGED.txt');
  const stamp = `${version} ${modelArchive} with model license\n`;
  if (await fs.readFile(marker, 'utf8').catch(() => '') === stamp) {
    console.log(`Local AI voice already staged for ${platform}.`);
    return;
  }

  await fs.mkdir(downloads, { recursive: true });
  const nativeName = `sherpa-onnx-${platform}-x64`;
  const [javascript, native, model, sherpaLicense, ort, modelLicense] = await Promise.all([
    npmPackage('sherpa-onnx-node', 'dcebf1db8650a52987342accb2b9a0faba91f079ee970f90aae047202db3af57'),
    npmPackage(nativeName, nativeHashes[platform]),
    obtain(modelArchive, `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${modelArchive}`,
      '82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427'),
    obtain('sherpa-license.txt', `https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v${version}/LICENSE`,
      'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'),
    obtain(`${ortDirectory}.tar.bz2`, `https://github.com/csukuangfj/onnxruntime-libs/releases/download/v1.28.2/${ortDirectory}.tar.bz2`,
      'cd7f757f7a38ce14238bc9198bee197a9430b42ec3ecadea3408dd2e832eb02e'),
    obtain('supertonic-3-openrail-m.txt', 'https://huggingface.co/Supertone/supertonic-3/raw/3cadd1ee6394adea1bd021217a0e650ede09a323/LICENSE',
      '0d944a9110fed9a9602d60e0423a272903e7bd21ab060490774efc77c2275e9f'),
  ]);

  await fs.mkdir(path.dirname(target), { recursive: true });
  const pending = await fs.mkdtemp(path.join(path.dirname(target), 'voice-pending-'));
  try {
    const licenses = path.join(pending, 'licenses');
    await Promise.all([
      extract(javascript, path.join(pending, 'node_modules', 'sherpa-onnx-node')),
      extract(native, path.join(pending, 'node_modules', nativeName)),
      extract(model, path.join(pending, 'model')),
      extract(ort, path.join(licenses, 'onnxruntime'), `${ortDirectory}/LICENSE`, `${ortDirectory}/ThirdPartyNotices.txt`),
    ]);
    await fs.copyFile(sherpaLicense, path.join(licenses, 'sherpa-onnx-LICENSE.txt'));
    await fs.copyFile(modelLicense, path.join(licenses, 'Supertonic-3-OpenRAIL-M.txt'));
    await fs.writeFile(path.join(pending, 'MODEL-NOTICE.txt'),
      'Supertonic 3 by Supertone Inc. Local ONNX int8 conversion by the sherpa-onnx project.\n'
      + 'Model source: https://huggingface.co/Supertone/supertonic-3\n'
      + 'The model is distributed under the OpenRAIL-M license. See licenses/Supertonic-3-OpenRAIL-M.txt for its use restrictions.\n'
      + `Inference runtime: sherpa-onnx ${version} (Apache 2.0) and ONNX Runtime (MIT).\n`);
    await fs.writeFile(path.join(pending, 'STAGED.txt'), stamp);
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(pending, target);
    console.log(`Local AI voice staged for ${platform}.`);
  } finally {
    await fs.rm(pending, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
