const { createHash, randomUUID } = require('node:crypto');
const { existsSync, promises: fs } = require('node:fs');
const { join } = require('node:path');

const modelFiles = {
  durationPredictor: 'duration_predictor.int8.onnx',
  textEncoder: 'text_encoder.int8.onnx',
  vectorEstimator: 'vector_estimator.int8.onnx',
  vocoder: 'vocoder.int8.onnx',
  ttsJson: 'tts.json',
  unicodeIndexer: 'unicode_indexer.bin',
  voiceStyle: 'voice.bin',
};

const voiceLabel = 'Local AI voice (English)';
const engineSignature = 'supertonic-3-int8-2026-05-11-voice-6-v2';
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const joinsNextWord = /^(?:a|an|the|and|or|of|for|in|on|into|at|to|by|from|with|across|between|about|as|that|than)$/iu;

function splitCaptionPhrases(text, { maxCharacters = 44, maxWords = 8 } = {}) {
  const phrases = [];
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    for (const { segment } of sentenceSegmenter.segment(line.trim())) {
      const words = segment.trim().split(/\s+/u).filter(Boolean);
      let index = 0;
      while (index < words.length) {
        let end = index + 1;
        let length = words[index].length;
        while (end < words.length && end - index < maxWords && length + words[end].length + 1 <= maxCharacters) {
          length += words[end].length + 1;
          end += 1;
        }
        if (end < words.length) {
          let foundPause = false;
          for (let pause = end; pause >= index + 3; pause -= 1) {
            if (/[,;:\u2013\u2014][”’"']?$/u.test(words[pause - 1])) {
              end = pause;
              foundPause = true;
              break;
            }
          }
          if (!foundPause) {
            while (end > index + 2 && joinsNextWord.test(words[end - 1])) end -= 1;
          }
        }
        const phrase = words.slice(index, end).join(' ');
        if (/[\p{L}\p{N}]/u.test(phrase)) phrases.push(phrase);
        index = end;
      }
    }
  }
  return phrases;
}

async function readCachedDuration(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const header = Buffer.alloc(44);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== 44 || header.toString('ascii', 0, 4) !== 'RIFF'
        || header.toString('ascii', 8, 12) !== 'WAVE' || header.toString('ascii', 36, 40) !== 'data') return null;
    const bytesPerSecond = header.readUInt32LE(28);
    const dataSize = header.readUInt32LE(40);
    const { size } = await handle.stat();
    return bytesPerSecond > 0 && dataSize > 0 && size === dataSize + 44 ? dataSize / bytesPerSecond : null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  } finally {
    await handle?.close();
  }
}

function waveBytes(samples, sampleRate) {
  const buffer = Buffer.allocUnsafe(44 + samples.length * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), 44 + index * 2);
  }
  return buffer;
}

function createVoiceEngine({ resourcesPath, cachePath }) {
  const platform = process.platform === 'win32' ? 'win' : process.platform;
  const stage = resourcesPath || join(__dirname, 'stage', platform);
  const voiceRoot = join(stage, 'voice');
  const packagePath = join(voiceRoot, 'node_modules', 'sherpa-onnx-node');
  const nativePath = join(voiceRoot, 'node_modules', `sherpa-onnx-${platform}-${process.arch}`, 'sherpa-onnx.node');
  const modelPath = join(voiceRoot, 'model');
  const supertonic = Object.fromEntries(Object.entries(modelFiles).map(([key, file]) => [key, join(modelPath, file)]));
  let initialization;
  let queue = Promise.resolve();

  function status() {
    const available = [packagePath, nativePath, ...Object.values(supertonic)].every(existsSync);
    return { available, label: voiceLabel, error: available ? null : 'The local AI voice files are missing. Reinstall the complete app package.' };
  }

  async function initialize() {
    const availability = status();
    if (!availability.available) throw new Error(availability.error);
    try {
      const sherpa = require(packagePath);
      const tts = await sherpa.OfflineTts.createAsync({
        model: { supertonic, numThreads: 2, provider: 'cpu' },
        maxNumSentences: 1,
      });
      const generationConfig = new sherpa.GenerationConfig({
        sid: 6,
        speed: 0.92,
        numSteps: 8,
        extra: { lang: 'en' },
      });
      return { tts, generationConfig };
    } catch (error) {
      throw new Error(`The local AI voice could not start. Verify the app package is complete. ${error.message}`, { cause: error });
    }
  }

  async function generate({ text, signal }) {
    signal?.throwIfAborted();
    const speech = String(text ?? '').replace(/\s+/gu, ' ').trim();
    if (!/[\p{L}\p{N}]/u.test(speech)) throw new Error('The caption needs words for the AI voice to read.');
    const key = createHash('sha256').update(engineSignature).update('\0').update(speech).digest('hex');
    const path = join(cachePath, `${key}.wav`);
    const cached = await readCachedDuration(path);
    signal?.throwIfAborted();
    if (cached) return { path, duration: cached };

    initialization ??= initialize().catch(error => {
      initialization = undefined;
      throw error;
    });
    const { tts, generationConfig } = await initialization;
    signal?.throwIfAborted();
    // Electron's V8 memory sandbox does not support external ArrayBuffers.
    const audio = await tts.generateAsync({ text: speech, generationConfig, enableExternalBuffer: false,
      onProgress: () => !signal?.aborted });
    signal?.throwIfAborted();
    if (!audio?.samples?.length || !(audio.sampleRate > 0)) throw new Error('The local AI voice did not produce audio for a caption. Edit that line and try again.');

    await fs.mkdir(cachePath, { recursive: true });
    const temporary = join(cachePath, `${key}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, waveBytes(audio.samples, audio.sampleRate), { signal });
      signal?.throwIfAborted();
      await fs.rename(temporary, path);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return { path, duration: audio.samples.length / audio.sampleRate };
  }

  function synthesize(options) {
    const result = queue.then(() => generate(options));
    queue = result.catch(() => {});
    return result;
  }

  return { status, synthesize };
}

module.exports = { createVoiceEngine, splitCaptionPhrases };
