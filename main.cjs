const { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createDraft } = require('./research.cjs');
const { renderVideo } = require('./render.cjs');
const { createVoiceEngine } = require('./voice.cjs');
const { createMediaRegistry, downloadVideo, importVideo, ownedVideo } = require('./media.cjs');
const { DEFAULT_MODEL, assertNarratable, demoProject, httpsUrl, normalizeProject, projectHash } = require('./project.cjs');

protocol.registerSchemesAsPrivileged([{
  scheme: 'studio-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

const uiFile = path.join(__dirname, 'ui', 'index.html');
const registry = createMediaRegistry();
let activeJob;
let window;
let paths;
let voiceEngine;
let settings = { model: DEFAULT_MODEL, encryptedKey: '' };
let sessionKey = '';
let reviewed;
let previewHistory = [];
let lastExport = '';
let quitting = false;

function bytesPath(name) {
  const override = process.env[`SPLICE_${name.toUpperCase()}_PATH`];
  if (override) return override;
  return app.isPackaged && process.platform === 'win32'
    ? path.join(process.resourcesPath, 'ffmpeg', `${name}.exe`)
    : name;
}

async function atomicText(filename, content) {
  const temporary = path.join(path.dirname(filename), `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function encryptionAvailable() {
  return safeStorage.isEncryptionAvailable()
    && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
}

function apiKey() {
  if (sessionKey) return sessionKey;
  if (!settings.encryptedKey || !encryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(settings.encryptedKey, 'base64'));
  } catch {
    return '';
  }
}

async function publicSettings() {
  const voice = await voiceEngine.status();
  return {
    hasKey: Boolean(apiKey()),
    model: settings.model,
    voiceAvailable: typeof voice === 'boolean' ? voice : Boolean(voice?.available),
  };
}

async function updateSettings(value) {
  const next = { ...settings };
  let nextSession = sessionKey;
  if (typeof value?.model === 'string') {
    next.model = value.model.trim() || DEFAULT_MODEL;
    if (!/^gemini-[a-z0-9.-]{1,80}$/.test(next.model)) throw new Error('Enter a valid Gemini model name.');
  }

  const newKey = typeof value?.apiKey === 'string' ? value.apiKey.trim() : '';
  if (value?.clearKey) {
    next.encryptedKey = '';
    nextSession = '';
  } else if (newKey) {
    if (newKey.length > 400 || /\s/.test(newKey)) throw new Error('Paste the API key from Google AI Studio.');
    if (encryptionAvailable()) {
      next.encryptedKey = safeStorage.encryptString(newKey).toString('base64');
      nextSession = '';
    } else {
      next.encryptedKey = '';
      nextSession = newKey;
    }
  }

  await atomicText(paths.settings, JSON.stringify(next, null, 2));
  settings = next;
  sessionKey = nextSession;
  return publicSettings();
}

function notify(event) {
  if (!window || window.isDestroyed()) return;
  const percent = Math.max(0, Math.min(100, Math.round(Number(event?.percent) || 0)));
  window.webContents.send('studio:progress', { percent, message: String(event?.message || '') });
}

function runJob(work) {
  if (activeJob) throw new Error('Wait for the current task to finish or cancel it.');
  const controller = new AbortController();
  const job = { controller };
  activeJob = job;
  job.promise = Promise.resolve().then(() => work(controller.signal)).catch(error => {
    if (controller.signal.aborted) throw new Error('Canceled.');
    throw error;
  }).finally(() => {
    if (activeJob === job) activeJob = undefined;
  });
  return job.promise;
}

async function generate(payload, signal) {
  const key = apiKey();
  if (!key) throw new Error('Add your Gemini API key in Settings to generate a draft.');
  const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim().slice(0, 6000) : '';
  if (!prompt) throw new Error('Enter a prompt for your video.');
  const targetSeconds = Math.max(15, Math.min(1800, Math.round(Number(payload.targetSeconds) || 60)));
  const aspect = payload.aspect === 'landscape' ? 'landscape' : 'portrait';
  const previous = payload.previous ? normalizeProject(payload.previous) : undefined;
  const excludedSourceIds = Array.isArray(payload.excludedSourceIds)
    ? payload.excludedSourceIds.filter(id => typeof id === 'string').slice(0, 100)
    : [];
  const addedSources = Array.isArray(payload.addedSources)
    ? payload.addedSources.slice(0, 20).map(source => ({
      title: typeof source?.title === 'string' ? source.title.trim().slice(0, 250) : '',
      url: httpsUrl(source?.url),
      excerpt: typeof source?.excerpt === 'string' ? source.excerpt.trim().slice(0, 3000) : '',
    })).filter(source => source.title && source.url && source.excerpt)
    : [];
  const addedSourceUrls = Array.isArray(payload.addedSourceUrls)
    ? payload.addedSourceUrls.slice(0, 20).map(httpsUrl).filter(Boolean) : [];
  const feedback = typeof payload.feedback === 'string' ? payload.feedback.trim().slice(0, 6000) : '';

  const draft = await createDraft({
    prompt, targetSeconds, aspect, previous, feedback, excludedSourceIds, addedSources, addedSourceUrls,
    apiKey: key, model: settings.model, signal, onProgress: notify,
  });
  return normalizeProject({
    ...draft, prompt, targetSeconds, aspect,
    background: previous?.background || 'auto',
    clips: previous?.clips || [],
  });
}

async function prepareMedia(project, signal) {
  const clips = [];
  if (project.background === 'custom' || project.background === 'auto') {
    for (const clip of project.clips) {
      const owned = await ownedVideo(paths.imports, clip);
      if (owned) clips.push(owned);
    }
  }
  if (project.background === 'custom' && !clips.length) {
    throw new Error('Import a background video or choose a different background.');
  }

  const assets = project.assets.map(asset => ({ ...asset, path: '' }));
  const warnings = [];
  if (project.background === 'auto') {
    const selected = new Set(project.scenes.map(scene => scene.clipId).filter(Boolean));
    const downloads = assets.filter(asset => selected.has(asset.id));
    if (!downloads.length) downloads.push(...assets.slice(0, 5));

    let complete = 0;
    if (downloads.length) notify({ percent: 2, message: 'Getting background footage…' });
    for (let index = 0; index < downloads.length; index += 3) {
      signal.throwIfAborted();
      await Promise.all(downloads.slice(index, index + 3).map(async asset => {
        try {
          asset.path = await downloadVideo(asset, paths.downloads, signal);
        } catch {
          signal.throwIfAborted();
          warnings.push(`Footage unavailable: ${asset.title}. The preview uses another background where needed.`);
        }
        complete += 1;
        notify({ percent: 2 + Math.round(10 * complete / downloads.length), message: `Getting background footage · ${complete}/${downloads.length}` });
      }));
    }
  }

  const readyAssets = assets.filter(asset => asset.path);
  const readyIds = new Set(readyAssets.map(asset => asset.id));
  const scenes = project.scenes.map(scene => ({ ...scene, clipId: readyIds.has(scene.clipId) ? scene.clipId : '' }));
  return { project: { ...project, clips, scenes, assets: readyAssets }, warnings };
}

async function previewVideo(payload, signal) {
  const input = normalizeProject(payload?.project);
  assertNarratable(input);
  reviewed = undefined;
  const { project, warnings } = await prepareMedia(input, signal);
  const folder = await fs.mkdtemp(path.join(paths.previews, 'render-'));
  const outputPath = path.join(folder, 'preview.mp4');

  try {
    const result = await renderVideo({
      project, outputPath, voiceEngine, signal, preview: true,
      ffmpegPath: bytesPath('ffmpeg'), ffprobePath: bytesPath('ffprobe'),
      onProgress: ({ percent, message }) => notify({ percent: 12 + percent * 0.88, message }),
    });
    signal.throwIfAborted();
    const media = registry.add(outputPath);
    previewHistory.push({ folder, id: media.id });
    if (previewHistory.length > 2) {
      const oldest = previewHistory.shift();
      registry.remove(oldest.id);
      await fs.rm(oldest.folder, { recursive: true, force: true }).catch(() => {});
    }
    reviewed = { hash: projectHash(input), project };
    return { url: media.url, duration: result?.duration, warnings: [...warnings, ...(result?.warnings || [])] };
  } catch (error) {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function safeBasename(title) {
  return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80) || 'Splice video';
}

function credits(project) {
  const lines = [project.title, '', 'Research sources'];
  for (const source of project.sources) lines.push(`- ${source.title}\n  ${source.url}`);
  if (project.background === 'auto' && project.assets.length) {
    lines.push('', 'Background footage');
    for (const asset of project.assets) {
      lines.push(`- ${asset.title} by ${asset.author || 'the credited creator'}\n  ${asset.url}\n  ${asset.license} ${asset.licenseUrl}\n  Footage may have been trimmed, resized, cropped, muted, or looped.`);
    }
  }
  return lines.join('\n') + '\n';
}

async function saveCredits(outputPath, project) {
  const base = outputPath.slice(0, -4);
  const content = credits(project);
  for (let index = 1; index <= 100; index += 1) {
    const suffix = index === 1 ? '' : '-' + index;
    const filename = base + '.credits' + suffix + '.txt';
    try {
      await fs.writeFile(filename, content, { encoding: 'utf8', flag: 'wx' });
      return filename;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('All adjacent credits filenames are in use.');
}

async function exportVideo(payload, signal) {
  const draft = normalizeProject(payload?.project);
  assertNarratable(draft);
  const approved = reviewed;
  if (!approved || approved.hash !== projectHash(draft)) throw new Error('Build a new preview for your current edits before exporting.');
  const selected = await dialog.showSaveDialog(window, {
    title: 'Export approved video',
    defaultPath: path.join(app.getPath('videos'), safeBasename(draft.title) + '.mp4'),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  signal.throwIfAborted();
  if (selected.canceled || !selected.filePath) return { canceled: true };

  const outputPath = selected.filePath.toLowerCase().endsWith('.mp4') ? selected.filePath : selected.filePath + '.mp4';
  const inputs = [...approved.project.clips, ...approved.project.assets.map(asset => asset.path)];
  const existing = await fs.realpath(outputPath).catch(() => path.resolve(outputPath));
  if (inputs.some(input => path.relative(existing, input) === '')) throw new Error('Choose a save location away from your input footage.');
  const result = await renderVideo({
    project: approved.project, outputPath, voiceEngine, onProgress: notify, signal,
    ffmpegPath: bytesPath('ffmpeg'), ffprobePath: bytesPath('ffprobe'),
  });

  lastExport = outputPath;
  let creditsPath;
  let warning;
  try {
    creditsPath = await saveCredits(outputPath, approved.project);
  } catch {
    warning = 'The MP4 saved. The separate source and footage credits file could not be written.';
  }
  return { path: outputPath, duration: result?.duration, creditsPath, warning };
}

function registerHandlers() {
  const handlers = {
    getSettings: publicSettings,
    saveSettings: updateSettings,
    createDraft: payload => runJob(signal => generate(payload, signal)),
    demo: () => {
      reviewed = undefined;
      return demoProject();
    },
    addClips: async () => {
      const choice = await dialog.showOpenDialog(window, {
        title: 'Import background footage',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'ogv', 'ogg', 'avi'] }],
      });
      return choice.canceled ? [] : await Promise.all(choice.filePaths.slice(0, 20).map(file => importVideo(file, paths.imports)));
    },
    preview: payload => runJob(signal => previewVideo(payload, signal)),
    exportVideo: payload => runJob(signal => exportVideo(payload, signal)),
    cancel: () => {
      activeJob?.controller.abort();
    },
    saveProject: async payload => {
      const project = normalizeProject(payload?.project);
      const chosen = await dialog.showSaveDialog(window, {
        title: 'Save project',
        defaultPath: path.join(app.getPath('documents'), safeBasename(project.title) + '.splice.json'),
        filters: [{ name: 'Splice Desk project', extensions: ['json'] }],
      });
      if (chosen.canceled || !chosen.filePath) return { canceled: true };
      await atomicText(chosen.filePath, JSON.stringify({ version: 1, project }, null, 2));
      return { path: chosen.filePath };
    },
    openProject: async () => {
      const chosen = await dialog.showOpenDialog(window, {
        title: 'Open project',
        properties: ['openFile'],
        filters: [{ name: 'Splice Desk project', extensions: ['json'] }],
      });
      if (chosen.canceled || !chosen.filePaths.length) return { canceled: true };
      const file = chosen.filePaths[0];
      try {
        if ((await fs.stat(file)).size > 12 * 1024 * 1024) throw new Error('Project exceeds the file size limit.');
        const document = JSON.parse(await fs.readFile(file, 'utf8'));
        if (document?.version !== 1) throw new Error('Unsupported project version.');
        const project = normalizeProject(document.project);
        reviewed = undefined;
        return { path: file, project };
      } catch {
        throw new Error('This file is not a readable Splice Desk project.');
      }
    },
    openExternal: async payload => {
      const url = httpsUrl(payload?.url);
      if (url) await shell.openExternal(url);
    },
    showItem: payload => {
      if (lastExport && payload?.path === lastExport) shell.showItemInFolder(lastExport);
    },
  };

  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`studio:${name}`, (event, payload) => {
      if (!window || event.sender !== window.webContents || event.senderFrame?.url !== pathToFileURL(uiFile).href) {
        throw new Error('The request did not come from the editor.');
      }
      return handler(payload);
    });
  }
}

function openWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#101114',
    title: 'Splice Desk',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = undefined; });
  window.loadFile(uiFile);
}

async function start() {
  const folder = app.getPath('userData');
  paths = {
    settings: path.join(folder, 'settings.json'),
    imports: path.join(folder, 'imports'),
    downloads: path.join(folder, 'footage'),
    previews: path.join(folder, 'previews'),
    voiceCache: path.join(folder, 'narration'),
  };
  await fs.rm(paths.previews, { recursive: true, force: true }).catch(() => {});
  await Promise.all([paths.imports, paths.downloads, paths.previews, paths.voiceCache].map(file => fs.mkdir(file, { recursive: true })));
  try {
    const saved = JSON.parse(await fs.readFile(paths.settings, 'utf8'));
    if (typeof saved.model === 'string' && /^gemini-[a-z0-9.-]{1,80}$/.test(saved.model)) settings.model = saved.model;
    if (typeof saved.encryptedKey === 'string') settings.encryptedKey = saved.encryptedKey;
  } catch {
    // Start with defaults if there is no readable settings file.
  }

  voiceEngine = createVoiceEngine({
    resourcesPath: app.isPackaged
      ? process.resourcesPath
      : path.join(__dirname, 'stage', process.platform === 'win32' ? 'win' : 'linux'),
    cachePath: paths.voiceCache,
  });

  protocol.handle('studio-media', request => registry.serve(request));
  registerHandlers();
  openWindow();
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('Splice Desk could not start', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!activeJob || quitting) return;
    event.preventDefault();
    quitting = true;
    activeJob.controller.abort();
    activeJob.promise.catch(() => {}).finally(() => app.quit());
  });
} else {
  app.quit();
}
