'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { splitCaptionPhrases } = require('./voice.cjs');

const FPS = 30;
const SILENT_TIMELINE_RATE = 24000;
const LEAD_SECONDS = 0.16;
const TAIL_SECONDS = 0.2;
const THEMES = {
  violet: [[10, 8, 25], [109, 55, 163], [45, 64, 146], [163, 49, 109]],
  ember: [[20, 9, 22], [176, 59, 31], [119, 50, 90], [194, 89, 40]],
  ocean: [[4, 15, 26], [19, 103, 141], [37, 57, 137], [19, 133, 101]]
};
const THEME_NAMES = Object.keys(THEMES);
const FONT = process.platform === 'win32' ? 'Arial' : 'DejaVu Sans';

function abortIfNeeded(signal) {
  if (signal?.aborted) {
    throw Object.assign(new Error('Render cancelled.'), { name: 'AbortError' });
  }
}

function run(command, args, { cwd, signal, progress, message }) {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    let result = '';
    let lineBuffer = '';
    const stop = () => child.kill();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.stdout.on('data', chunk => {
      if (!progress) {
        result = (result + chunk).slice(-16000);
        return;
      }
      lineBuffer += chunk;
      let newline = lineBuffer.indexOf('\n');
      while (newline !== -1) {
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
        if (match) progress(Number(match[1]) / 1e6);
        newline = lineBuffer.indexOf('\n');
      }
    });
    child.on('error', error => {
      signal?.removeEventListener('abort', stop);
      reject(new Error(message + ' ' + error.message));
    });
    child.on('close', code => {
      signal?.removeEventListener('abort', stop);
      try {
        abortIfNeeded(signal);
        if (code !== 0) {
          const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ');
          throw new Error(message + (detail ? ' ' + detail : ''));
        }
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function hash(value) {
  let result = 2166136261;
  for (const character of String(value)) {
    result = Math.imul(result ^ character.codePointAt(0), 16777619);
  }
  return result >>> 0;
}

function localPath(value) {
  return typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : null;
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function fileExists(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function assignFootage(project, outputPath) {
  const assetById = new Map((project.assets || []).map(asset => [String(asset.id), asset]));
  const assets = [];
  for (const asset of assetById.values()) {
    const file = localPath(asset.path);
    if (file && await fileExists(file)) assets.push({ ...asset, path: file });
  }
  const imported = (project.clips || []).map(localPath).filter(Boolean).map(file => ({
    path: file,
    title: path.basename(file)
  }));
  const available = [...imported];
  for (const asset of assets) {
    if (!available.some(other => samePath(other.path, asset.path))) available.push(asset);
  }
  const seed = hash(project.title || '');
  const ordered = available.slice().sort((a, b) => hash(a.path + seed) - hash(b.path + seed));

  return project.scenes.map((scene, index) => {
    let asset;
    if (scene.clipId !== undefined && scene.clipId !== null && scene.clipId !== '') {
      if (!assetById.has(String(scene.clipId))) {
        throw new Error('A selected background clip is missing from this project. Choose another clip for ' + scene.heading + '.');
      }
      asset = assets.find(item => String(item.id) === String(scene.clipId));
      if (!asset) {
        throw new Error('Download or re-import the background clip for ' + scene.heading + ' before rendering.');
      }
    } else if (['custom', 'auto', 'shuffle'].includes(project.background) && ordered.length) {
      asset = ordered[index % ordered.length];
    }
    if (project.background === 'custom' && !asset) {
      throw new Error('Import a background clip or choose a built-in background before rendering.');
    }
    if (asset && samePath(asset.path, outputPath)) {
      throw new Error('Choose an export filename different from the source footage.');
    }
    const theme = Object.hasOwn(THEMES, project.background)
      ? project.background
      : THEME_NAMES[(index + seed) % THEME_NAMES.length];
    return { ...scene, asset, theme };
  });
}

async function confirmFootage(scenes, ffprobePath, cwd, signal) {
  const checked = new Set();
  for (const { asset } of scenes) {
    if (!asset || checked.has(asset.path)) continue;
    checked.add(asset.path);
    if (!await fileExists(asset.path)) {
      throw new Error('Cannot find ' + path.basename(asset.path) + '. Re-import it or choose a different background.');
    }
    if (!ffprobePath) continue;
    const result = await run(ffprobePath, [
      '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-select_streams', 'v:0', '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0', asset.path
    ], {
      cwd,
      signal,
      message: 'Could not read ' + path.basename(asset.path) + '.'
    });
    if (!/^video/m.test(result)) {
      throw new Error(path.basename(asset.path) + ' has no video stream. Choose a different background clip.');
    }
  }
}

function wavSamples(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The narration engine returned an unreadable WAV file.');
  }
  let format;
  let pcm;
  for (let start = 12; start + 8 <= buffer.length;) {
    const type = buffer.toString('ascii', start, start + 4);
    const bytes = buffer.readUInt32LE(start + 4);
    const data = start + 8;
    if (data + bytes > buffer.length) break;
    if (type === 'fmt ' && bytes >= 16) {
      format = {
        encoding: buffer.readUInt16LE(data),
        channels: buffer.readUInt16LE(data + 2),
        rate: buffer.readUInt32LE(data + 4),
        bits: buffer.readUInt16LE(data + 14)
      };
    }
    if (type === 'data') pcm = buffer.subarray(data, data + bytes);
    start = data + bytes + (bytes % 2);
  }
  if (!format || format.encoding !== 1 || format.channels !== 1 ||
      format.rate < 8000 || format.rate > 192000 || format.bits !== 16 ||
      !pcm?.length || pcm.length % 2) {
    throw new Error('The narration engine must return mono 16-bit PCM audio.');
  }
  return { pcm, rate: format.rate };
}

function trimPhrase(pcm, rate, text) {
  const block = Math.round(rate / 100) * 2;
  let start = -1;
  let end = 0;
  for (let offset = 0; offset < pcm.length; offset += block) {
    const stop = Math.min(offset + block, pcm.length);
    let energy = 0;
    for (let index = offset; index < stop; index += 2) {
      const sample = pcm.readInt16LE(index);
      energy += sample * sample;
    }
    if (energy > (stop - offset) / 2 * 100 ** 2) {
      if (start < 0) start = offset;
      end = stop;
    }
  }
  if (start < 0) return pcm;
  const sentenceEnd = /[.!?…][”’"')\]]*$/u.test(text);
  const punctuationEnd = /[,;:–—][”’"')\]]*$/u.test(text);
  const pause = sentenceEnd ? 0.19 : punctuationEnd ? 0.12 : 0.07;
  return pcm.subarray(
    Math.max(0, start - Math.round(rate * 0.05) * 2),
    Math.min(pcm.length, end + Math.round(rate * pause) * 2)
  );
}

function wavHeader(dataLength, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(dataLength + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

async function appendBuffer(file, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
    if (!bytesWritten) throw new Error('Could not write the narration audio.');
    offset += bytesWritten;
  }
}

async function makeTimeline(project, scenes, voiceEngine, cwd, signal, report) {
  const portrait = project.aspect === 'portrait';
  const phrases = scenes.map(scene => splitCaptionPhrases(
    String(scene.narration || ''),
    portrait ? { maxCharacters: 32, maxWords: 6 } : undefined
  ));
  const empty = phrases.findIndex(group => !group.length);
  if (empty !== -1) throw new Error('Add narration words to scene ' + (empty + 1) + ' before rendering.');
  const count = phrases.reduce((sum, group) => sum + group.length, 0);
  const narrated = project.narration !== false;
  if (narrated && !voiceEngine) throw new Error('Local narration is unavailable. Check the voice model in Settings.');
  const synthesize = async text => {
    const { path: speechPath } = await voiceEngine.synthesize({ text, signal });
    abortIfNeeded(signal);
    const { pcm, rate } = wavSamples(await fs.readFile(speechPath));
    return { pcm: trimPhrase(pcm, rate, text), rate };
  };
  const firstPhrase = narrated ? await synthesize(phrases[0][0]) : null;
  const sampleRate = firstPhrase?.rate || SILENT_TIMELINE_RATE;
  const out = narrated ? await fs.open(path.join(cwd, 'narration.wav'), 'w') : null;
  let writtenSamples = 0;
  let writtenFrames = 0;
  let processed = 0;
  try {
    if (out) await appendBuffer(out, wavHeader(0, sampleRate));
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index];
      scene.cues = [];
      let localSamples = Math.round(LEAD_SECONDS * sampleRate);
      if (out) await appendBuffer(out, Buffer.alloc(localSamples * 2));
      for (const text of phrases[index]) {
        abortIfNeeded(signal);
        const start = localSamples / sampleRate;
        if (out) {
          const { pcm, rate } = processed === 0 ? firstPhrase : await synthesize(text);
          if (rate !== sampleRate) throw new Error('The narration engine changed sample rates between phrases.');
          await appendBuffer(out, pcm);
          localSamples += pcm.length / 2;
        } else {
          localSamples += Math.round(Math.max(0.8, Array.from(text).length / 14) * sampleRate);
        }
        scene.cues.push({ text, start, end: localSamples / sampleRate });
        processed += 1;
        report(3 + 32 * processed / count, out
          ? 'Synthesizing narration · ' + processed + ' of ' + count + ' phrases'
          : 'Timing the captions');
      }
      const audibleSeconds = localSamples / sampleRate;
      scene.frames = Math.ceil((audibleSeconds + TAIL_SECONDS) * FPS);
      scene.duration = scene.frames / FPS;
      writtenFrames += scene.frames;
      const sceneSamples = Math.round(writtenFrames * sampleRate / FPS) - writtenSamples;
      if (out) await appendBuffer(out, Buffer.alloc((sceneSamples - localSamples) * 2));
      writtenSamples += sceneSamples;
    }
    if (out) await out.write(wavHeader(writtenSamples * 2, sampleRate), 0, 44, 0);
  } finally {
    await out?.close();
  }
  return narrated;
}

function artImage(theme, portrait) {
  const [base, ...accents] = THEMES[theme];
  const width = portrait ? 360 : 640;
  const height = portrait ? 640 : 360;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = x / width;
      const b = y / height;
      const glow = [
        Math.exp(-((a - 0.09) ** 2 * 7 + (b - 0.79) ** 2 * 5)),
        Math.exp(-((a - 0.83) ** 2 * 6 + (b - 0.25) ** 2 * 8)),
        Math.exp(-((a - 1.07) ** 2 * 11 + (b - 0.83) ** 2 * 9))
      ];
      const curve = 6.5 * b + 3 * Math.sin(a * 2.8 + 0.75) + 1.4 * a;
      const lines = 12 * Math.max(0, Math.sin(curve * 7)) ** 12;
      const grain = ((Math.imul(x + 29, y + 1) ^ Math.imul(y + 297, x + 7)) & 15) / 5 - 1;
      const offset = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const color = base[channel] + accents.reduce((sum, value, index) => {
          return sum + 0.66 * value[channel] * glow[index];
        }, 0) + lines + grain;
        pixels[offset + channel] = Math.min(255, Math.max(0, Math.round(color)));
      }
    }
  }
  return Buffer.concat([Buffer.from('P6\n' + width + ' ' + height + '\n255\n'), pixels]);
}

function glyphWidth(text, fontSize) {
  let size = 0;
  for (const character of text) {
    if (/\p{M}/u.test(character)) continue;
    if (/\s/.test(character)) size += 0.34;
    else if (/[ilIjt.,'!|:]/.test(character)) size += 0.34;
    else if (/[mMwW@%&]/.test(character)) size += 0.91;
    else if (/[^\u0000-\u02ff]/u.test(character)) size += 0.99;
    else if (/[A-Z]/.test(character)) size += 0.74;
    else size += 0.62;
  }
  return size * fontSize;
}

function wrapText(value, size, width, maxLines = Infinity) {
  const words = String(value ?? '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!word) continue;
    if (line && glyphWidth(line + ' ' + word, size) <= width) {
      line += ' ' + word;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    for (const character of word) {
      if (line && glyphWidth(line + character, size) > width) {
        lines.push(line);
        line = '';
      }
      line += character;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = Array.from(lines[maxLines - 1]);
    while (last.length && glyphWidth(last.join('') + '…', size) > width) last.pop();
    lines[maxLines - 1] = last.join('').trimEnd() + '…';
  }
  return lines;
}

function assText(value) {
  return value.replace(/\\/g, '\\\u2060').replace(/{/g, '\\{').replace(/}/g, '\\}')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
}

function fitText(value, width, maxLinesAtSize, preferred, smallest) {
  for (let size = preferred; size >= smallest; size -= 1) {
    const lines = wrapText(value, size, width);
    if (lines.length <= maxLinesAtSize(size)) return { size, lines };
  }
  return { size: smallest, lines: wrapText(value, smallest, width, maxLinesAtSize(smallest)) };
}

function assTime(seconds) {
  const centiseconds = Math.round(seconds * 100);
  const two = number => String(number).padStart(2, '0');
  const hours = Math.floor(centiseconds / 360000);
  const minutes = two(Math.floor(centiseconds / 6000) % 60);
  const sec = two(Math.floor(centiseconds / 100) % 60);
  return hours + ':' + minutes + ':' + sec + '.' + two(centiseconds % 100);
}

function makeOverlay(project, scene) {
  const portrait = project.aspect === 'portrait';
  const [width, height] = portrait ? [1080, 1920] : [1920, 1080];
  const card = portrait ? [72, 353, 936, 980] : [174, 198, 1572, 590];
  const [left, top, cardWidth, cardHeight] = card;
  const inset = portrait ? 61 : 70;
  const textX = left + inset;
  const textWidth = cardWidth - inset * 2;
  const events = [];
  const dialogue = (layer, style, content, start = 0, end = scene.duration) => {
    events.push('Dialogue: ' + [layer, assTime(start), assTime(end), style, '', 0, 0, 0, '', content].join(','));
  };
  const rounded = (x, y, w, h, r, color, alpha, layer = 0) => {
    const drawing = 'm ' + r + ' 0 l ' + (w - r) + ' 0 b ' + w + ' 0 ' + w + ' 0 ' + w + ' ' + r +
      ' l ' + w + ' ' + (h - r) + ' b ' + w + ' ' + h + ' ' + w + ' ' + h + ' ' + (w - r) + ' ' + h +
      ' l ' + r + ' ' + h + ' b 0 ' + h + ' 0 ' + h + ' 0 ' + (h - r) +
      ' l 0 ' + r + ' b 0 0 0 0 ' + r + ' 0';
    dialogue(layer, 'Shape', '{\\an7\\pos(' + x + ',' + y + ')\\p1\\1c&H' + color + '&\\alpha&H' + alpha + '&}' + drawing);
  };
  const label = (style, x, y, size, lines, layer = 2, start = 0, end = scene.duration, align = 7) => {
    if (!lines.length) return;
    dialogue(layer, style,
      '{\\an' + align + '\\pos(' + x + ',' + y + ')\\fs' + size + '}' + lines.map(assText).join('\\N'),
      start, end);
  };
  rounded(left + 9, top + 14, cardWidth, cardHeight, 40, '0D0806', '98');
  rounded(left, top, cardWidth, cardHeight, 40, '7A6860', '78');
  rounded(left + 3, top + 3, cardWidth - 6, cardHeight - 6, 38, '1E1411', '16', 1);
  rounded(textX, top + (portrait ? 77 : 59), 62, 7, 3, 'F499B3', '06', 2);
  const context = fitText(project.title, cardWidth - 35, () => 2, portrait ? 34 : 31, 24);
  label('Context', left + 8, top - (portrait ? 102 : 82), context.size, context.lines);
  const heading = fitText(scene.heading || project.title, textWidth, () => portrait ? 3 : 2, 72, 54);
  const headingY = top + (portrait ? 111 : 84);
  label('Heading', textX, headingY, heading.size, heading.lines);
  const detailY = headingY + Math.ceil(heading.size * 1.16 * heading.lines.length) + 24;
  const creditY = top + cardHeight - (portrait ? 125 : 70);
  const detail = fitText(scene.overlay, textWidth,
    size => Math.max(1, Math.floor((creditY - detailY - 13) / (size * 1.2))),
    47, portrait ? 30 : 26);
  label('Detail', textX, detailY, detail.size, detail.lines);

  const sourceIds = new Set((scene.sourceIds || []).map(String));
  const sources = (project.sources || []).filter(source => sourceIds.has(String(source.id)));
  if (sources.length) {
    const sourceLine = 'Sources  ·  ' + sources.map(source => source.title || source.url).join('  ·  ');
    const creditSize = portrait ? 29 : 26;
    label('Credit', textX, creditY, creditSize, wrapText(sourceLine, creditSize, textWidth, portrait ? 2 : 1));
  }
  if (scene.asset?.id) {
    const clipLine = ['Footage', scene.asset.title, scene.asset.author, scene.asset.license].filter(Boolean).join('  ·  ');
    const creditSize = portrait ? 28 : 24;
    label('Credit', left + 8, top + cardHeight + 31, creditSize, wrapText(clipLine, creditSize, cardWidth, portrait ? 2 : 1));
  }
  const captionSize = portrait ? 59 : 62;
  for (const cue of scene.cues) {
    const lines = wrapText(cue.text, captionSize, portrait ? 890 : 1530);
    label('Caption', width / 2, portrait ? 1590 : 1000, captionSize, lines, 3, cue.start, cue.end, 2);
  }

  const style = (name, color, bold, outline = 0, shadow = 0, border = 1) =>
    'Style: ' + [name, FONT, 36, color, color, '&HDC181016', '&H990A060B', bold, 0, 0, 0,
      100, 100, 0, 0, border, outline, shadow, 7, 0, 0, 0, 1].join(',');
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'PlayResX: ' + width,
    'PlayResY: ' + height,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style('Shape', '&H00FFFFFF', 0),
    style('Context', '&H00F4E6E9', -1, 0, 2),
    style('Heading', '&H00FAF4F4', -1),
    style('Detail', '&H00E6DDE4', 0),
    style('Credit', '&H00E6D1DF', 0, 0, 2),
    style('Caption', '&H00FFFFFF', -1, 5, 2),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    ''
  ].join('\n');
}

async function renderScene({ project, scene, index, width, height, cwd, ffmpegPath, preview, signal, progress }) {
  const overlayName = 'overlay-' + index + '.ass';
  await fs.writeFile(path.join(cwd, overlayName), makeOverlay(project, scene), 'utf8');
  let input;
  let framing;
  if (scene.asset) {
    const still = /\.(?:png|jpe?g|bmp|webp)$/i.test(scene.asset.path);
    input = [...(still ? ['-loop', '1', '-framerate', String(FPS)] : ['-stream_loop', '-1']), '-i', scene.asset.path];
    framing = [
      'scale=' + width + ':' + height + ':force_original_aspect_ratio=increase:flags=bicubic',
      'crop=' + width + ':' + height,
      'fps=' + FPS,
      'drawbox=color=black@0.34:t=fill'
    ];
  } else {
    input = ['-i', scene.theme + '.ppm'];
    const phase = (index % 13) * 0.37;
    framing = [
      "zoompan=z='1.11+0.035*sin(on/94+" + phase + ")':" +
        "x='iw/2-iw/zoom/2+iw*0.016*cos(on/117+" + phase + ")':" +
        "y='ih/2-ih/zoom/2+ih*0.024*sin(on/108+" + phase + ")':" +
        'd=' + scene.frames + ':s=' + width + 'x' + height + ':fps=' + FPS
    ];
  }
  const filters = [...framing, 'setsar=1', 'format=yuv420p', 'ass=' + overlayName];
  const segmentName = 'scene-' + index + '.mp4';
  await run(ffmpegPath, [
    '-hide_banner', '-v', 'error', '-nostdin', '-y', '-progress', 'pipe:1',
    '-protocol_whitelist', 'file,pipe',
    ...input,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-filter_threads', '2',
    '-vf', filters.join(','), '-frames:v', String(scene.frames),
    '-c:v', 'libx264', '-threads', '4', '-preset', preview ? 'ultrafast' : 'veryfast',
    '-crf', preview ? '25' : '19', '-pix_fmt', 'yuv420p', '-video_track_timescale', '30000',
    segmentName
  ], {
    cwd, signal, progress,
    message: 'Could not render scene ' + (index + 1) + (scene.asset ? ' with ' + path.basename(scene.asset.path) : '') + '.'
  });
  return segmentName;
}

async function renderVideo({ project, outputPath, ffmpegPath, ffprobePath, voiceEngine, onProgress, signal, preview = false }) {
  if (!Array.isArray(project?.scenes) || project.scenes.length === 0) {
    throw new Error('Add at least one scene before rendering.');
  }
  abortIfNeeded(signal);
  const target = path.resolve(outputPath);
  const ffmpeg = ffmpegPath || 'ffmpeg';
  let previousPercent = -1;
  const report = (value, message) => {
    const percent = Math.max(0, Math.min(Math.floor(value), 100));
    if (percent > previousPercent) {
      previousPercent = percent;
      onProgress?.({ percent, message });
    }
  };
  report(0, 'Preparing the video');
  const temp = await fs.mkdtemp(path.join(path.dirname(target), '.commentary-'));
  try {
    const scenes = await assignFootage(project, target);
    await confirmFootage(scenes, ffprobePath, temp, signal);
    for (const theme of new Set(scenes.filter(scene => !scene.asset).map(scene => scene.theme))) {
      await fs.writeFile(path.join(temp, theme + '.ppm'), artImage(theme, project.aspect === 'portrait'));
    }
    abortIfNeeded(signal);
    report(2, 'Preparing narration and captions');
    const narrated = await makeTimeline(project, scenes, voiceEngine, temp, signal, report);
    const width = (project.aspect === 'portrait' ? 1080 : 1920) / (preview ? 2 : 1);
    const height = (project.aspect === 'portrait' ? 1920 : 1080) / (preview ? 2 : 1);
    const duration = scenes.reduce((seconds, scene) => seconds + scene.duration, 0);
    const segments = [];
    let completed = 0;
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index];
      const message = 'Rendering scene ' + (index + 1) + ' of ' + scenes.length;
      const progress = seconds => report(36 + 60 * (completed + Math.min(seconds, scene.duration)) / duration, message);
      progress(0);
      segments.push(await renderScene({
        project, scene, index, width, height, cwd: temp, ffmpegPath: ffmpeg, preview, signal, progress
      }));
      completed += scene.duration;
    }
    report(97, 'Building the MP4');
    await fs.writeFile(path.join(temp, 'scene-list.txt'), segments.map((segment, index) =>
      "file '" + segment + "'\nduration " + scenes[index].duration.toFixed(9)
    ).join('\n') + '\n');
    await run(ffmpeg, [
      '-hide_banner', '-v', 'error', '-nostdin', '-y',
      '-f', 'concat', '-safe', '1', '-i', 'scene-list.txt',
      ...(narrated ? ['-i', 'narration.wav'] : []),
      '-map', '0:v:0',
      ...(narrated ? ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100'] : ['-an']),
      '-c:v', 'copy', '-movflags', '+faststart', 'ready.mp4'
    ], { cwd: temp, signal, message: 'Could not combine the scenes into an MP4.' });
    abortIfNeeded(signal);
    try {
      await fs.rename(path.join(temp, 'ready.mp4'), target);
    } catch (error) {
      if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) {
        throw new Error('Could not save the MP4. Close the destination file or choose a different export location.', { cause: error });
      }
      throw error;
    }
    report(100, preview ? 'Preview ready' : 'Video exported');
    return { outputPath: target, duration };
  } finally {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

module.exports = { renderVideo };
