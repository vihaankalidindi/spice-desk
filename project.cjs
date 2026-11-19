const { createHash } = require('node:crypto');

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const BACKGROUNDS = new Set(['auto', 'shuffle', 'violet', 'ember', 'ocean', 'custom']);

function text(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function list(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function httpsUrl(value) {
  try {
    const url = new URL(text(value, 2000));
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url.href : '';
  } catch {
    return '';
  }
}

function commonsMedia(value, thumbnail = false) {
  const candidate = httpsUrl(value);
  if (!candidate) return '';
  const url = new URL(candidate);
  const hosts = thumbnail ? ['upload.wikimedia.org', 'thumb.wikimedia.org'] : ['upload.wikimedia.org'];
  if (!hosts.includes(url.hostname) || !url.pathname.startsWith('/wikipedia/commons/')) return '';
  const extensions = thumbnail ? /\.(?:jpg|jpeg|png|webp)$/i : /\.(?:webm|ogv|ogg|mp4)$/i;
  return extensions.test(url.pathname) ? url.href : '';
}

function normalizeProject(value) {
  if (!value || typeof value !== 'object') throw new Error('This project file could not be read.');

  const sources = list(value.sources, 100).map(source => ({
    id: text(source?.id, 100),
    title: text(source?.title, 250),
    url: httpsUrl(source?.url),
    excerpt: text(source?.excerpt, 3000),
    userProvided: Boolean(source?.userProvided),
  })).filter(source => source.id && source.title && source.url);
  const assets = list(value.assets, 60).map(asset => ({
    id: text(asset?.id, 100),
    title: text(asset?.title, 250),
    author: text(asset?.author, 250),
    license: text(asset?.license, 100),
    licenseUrl: httpsUrl(asset?.licenseUrl),
    url: httpsUrl(asset?.url),
    downloadUrl: commonsMedia(asset?.downloadUrl),
    thumbnailUrl: commonsMedia(asset?.thumbnailUrl, true),
    path: text(asset?.path, 2000),
    duration: Math.max(0, Number(asset?.duration) || 0),
    width: Math.max(0, Number(asset?.width) || 0),
    height: Math.max(0, Number(asset?.height) || 0),
  })).filter(asset => asset.id && asset.title && asset.url && asset.downloadUrl);
  const sourceIds = new Set(sources.map(source => source.id));
  const assetIds = new Set(assets.map(asset => asset.id));
  const scenes = list(value.scenes, 150).map(scene => ({
    heading: text(scene?.heading, 100),
    narration: text(scene?.narration, 6500),
    overlay: text(scene?.overlay, 340),
    sourceIds: [...new Set(list(scene?.sourceIds, 8).filter(id => sourceIds.has(id)))],
    clipId: assetIds.has(scene?.clipId) ? scene.clipId : '',
  })).filter(scene => scene.narration || scene.heading || scene.overlay);
  const topics = list(value.topics, 12).map(topic => typeof topic === 'string'
    ? text(topic, 200)
    : { title: text(topic?.title, 200), angle: text(topic?.angle || topic?.description || topic?.reason, 650) });
  const targetSeconds = Math.max(15, Math.min(1800, Math.round(Number(value.targetSeconds) || 60)));

  return {
    title: text(value.title, 160) || 'Untitled video',
    description: text(value.description, 2000),
    prompt: text(value.prompt, 6000),
    targetSeconds,
    aspect: value.aspect === 'landscape' ? 'landscape' : 'portrait',
    scenes,
    sources,
    assets,
    background: BACKGROUNDS.has(value.background) ? value.background : 'auto',
    clips: [...new Set(list(value.clips, 50).map(clip => text(clip, 2000)).filter(Boolean))],
    narration: true,
    warnings: list(value.warnings, 30).map(item => text(item, 550)).filter(Boolean),
    topics,
  };
}

function projectHash(project) {
  return createHash('sha256').update(JSON.stringify(normalizeProject(project))).digest('hex');
}

function assertNarratable(project) {
  if (!project.scenes.length) throw new Error('Generate a draft or open a project to get started.');
  const emptyIndex = project.scenes.findIndex(scene => !scene.narration);
  if (emptyIndex >= 0) throw new Error(`Scene ${emptyIndex + 1} needs narration before you can preview.`);
}

function demoProject() {
  return normalizeProject({
    title: 'Why the sky turns blue',
    prompt: 'Make a short, curious explainer about the science behind a blue sky and a red sunset.',
    description: 'A short sample with original animated backgrounds and locally generated narration.',
    targetSeconds: 45,
    aspect: 'portrait',
    background: 'ocean',
    scenes: [
      {
        heading: 'One sun, two colors',
        overlay: 'Why is the sky blue by day and orange at sunset?',
        narration: 'Look up at noon, and the sky is usually blue. Wait until sunset, and that same sky can turn orange. The sun did not change color. The light just took a different path to reach you.',
        sourceIds: ['nasa-blue-sky'],
      },
      {
        heading: 'Light gets scattered',
        overlay: 'Short blue wavelengths scatter more than long red wavelengths.',
        narration: 'Sunlight contains a range of colors. When it reaches our atmosphere, the tiny molecules in the air scatter shorter wavelengths, like blue, much more than longer wavelengths, like red. That scattered blue light reaches your eyes from across the sky.',
        sourceIds: ['nasa-blue-sky'],
      },
      {
        heading: 'The long way through',
        overlay: 'At sunset, sunlight travels through more atmosphere.',
        narration: 'At sunset, the sun is low on the horizon. Its light travels through a longer stretch of air. More blue light scatters out of that direct path, leaving the light that reaches you looking warmer.',
        sourceIds: ['nasa-blue-sky'],
      },
      {
        heading: 'Same light, different path',
        overlay: 'A blue afternoon and a red sunset come from the same process.',
        narration: 'So the next time you see a red sunset, picture the light taking the long way through the atmosphere. You are seeing what is left after much of the blue has scattered away.',
        sourceIds: ['nasa-blue-sky'],
      },
    ],
    sources: [{
      id: 'nasa-blue-sky',
      title: 'Why Is the Sky Blue? · NASA Space Place',
      url: 'https://spaceplace.nasa.gov/blue-sky/en/',
      excerpt: 'NASA explains how shorter wavelengths scatter in the atmosphere and why the longer path at sunset makes the sky look red.',
    }],
  });
}

module.exports = { DEFAULT_MODEL, assertNarratable, commonsMedia, demoProject, httpsUrl, normalizeProject, projectHash };
