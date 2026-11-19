'use strict';

const byId = (id) => document.getElementById(id);
const api = window.studio;
const defaultModel = 'gemini-3.5-flash-lite';
const examplePrompt = 'Make a punchy 60-second commentary video about why the sky is blue and sunsets turn red. Open with a question and use atmospheric footage.';
const state = {
  project: null,
  preview: null,
  previewPlayable: false,
  settings: null,
  view: 'prompt',
  tab: 'script',
  sceneIndex: 0,
  excluded: new Set(),
  addedSources: [],
  busy: null,
  dirty: false,
  savedPath: '',
  exportPath: '',
  replaceAction: null,
  durationTouched: false,
  aspectTouched: false,
};

const views = {
  prompt: byId('prompt-panel'),
  draft: byId('draft-panel'),
  preview: byId('review-panel'),
};

const studioButtons = [
  'new-project', 'settings', 'open-project', 'save-project', 'fill-example',
  'generate', 'revise', 'load-demo', 'build-preview', 'open-review',
  'tab-script', 'tab-sources', 'tab-footage', 'approve-export', 'show-export',
];

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}

function icon(id) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const use = document.createElementNS(namespace, 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '#i-' + id);
  svg.append(use);
  return svg;
}

function button(text, className, action, iconId) {
  const element = node('button', className);
  element.type = 'button';
  if (iconId) element.append(icon(iconId));
  if (text) element.append(document.createTextNode(text));
  element.addEventListener('click', action);
  return element;
}

function filename(path) {
  return String(path).split(/[\\/]/u).pop() || 'Video';
}

function durationText(seconds) {
  const whole = Math.round(Number(seconds) || 0);
  if (whole < 60) return whole + ' sec';
  const minutes = Math.floor(whole / 60);
  return minutes + ' min' + (whole % 60 ? ' ' + (whole % 60) + ' sec' : '');
}

function aspectText(aspect) {
  return aspect === 'landscape' ? 'Landscape · 16:9' : 'Vertical · 9:16';
}

function promptOptions(prompt) {
  const units = '(seconds?|secs?|minutes?|mins?|s|m)';
  const amount = '(\\d{1,4}(?:\\.\\d+)?)\\s*[-–]?\\s*' + units + '\\b';
  const nearFormat = new RegExp('\\b' + amount + '\\s*[-–]?\\s*(?:vertical|portrait|landscape|horizontal|long|commentary|video|explainer|short|documentary|montage)', 'iu');
  const nearRequest = new RegExp('\\b(?:make|create|generate|produce|keep|length|duration|runtime|run for)\\s+(?:it\\s+|me\\s+|an?\\s+|at\\s+|about\\s+|around\\s+|under\\s+|to\\s+)*' + amount, 'iu');
  const match = prompt.match(nearFormat) || prompt.match(nearRequest);
  const seconds = match ? Math.round(Number(match[1]) * (/^m/iu.test(match[2]) ? 60 : 1)) : undefined;
  const aspectMatch = prompt.match(/\b(9\s*:\s*16|16\s*:\s*9|vertical|portrait(?:\s+(?:format|layout|video))|landscape|horizontal)\b/iu)?.[1].toLowerCase();
  const aspect = aspectMatch
    ? /^(?:16\s*:|landscape|horizontal)/u.test(aspectMatch) ? 'landscape'
      : /^(?:9\s*:|vertical|portrait)/u.test(aspectMatch) ? 'portrait' : undefined
    : undefined;
  return { seconds, aspect };
}

function syncPromptOptions() {
  const { seconds, aspect } = promptOptions(byId('prompt').value);
  if (!state.durationTouched && seconds >= 15 && seconds <= 1800) {
    const format = seconds > 180 ? 'long' : 'short';
    const currentFormat = document.querySelector('input[name="format"]:checked').value;
    const currentAspect = byId('aspect').value;
    const layout = state.aspectTouched ? currentAspect : aspect || (format === currentFormat ? currentAspect : undefined);
    formatInput(format, seconds, layout);
  }
  if (!state.aspectTouched && aspect) byId('aspect').value = aspect;
}

function plainError(error) {
  return String(error?.message || error || 'Something went wrong.')
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^Error:\s*/u, '');
}

function notice(message, kind = '') {
  byId('notice-text').textContent = message;
  byId('notice').classList.toggle('error', kind === 'error');
  byId('notice').hidden = !message;
}

function hasSourceChanges() {
  return Boolean(state.excluded.size || state.addedSources.length);
}

function status() {
  const hasKey = Boolean(state.settings?.hasKey);
  byId('connection').classList.toggle('ready', hasKey);
  byId('connection-text').textContent = !state.settings
    ? 'Gemini setup unavailable'
    : hasKey ? 'Gemini key saved' : 'Gemini key needed';
}

function renderControls() {
  const blocked = Boolean(state.busy) || !api;
  const hasProject = Boolean(state.project);
  const hasPreview = Boolean(state.preview);
  const pendingSources = hasSourceChanges();

  for (const id of studioButtons) byId(id).disabled = blocked;
  for (const control of document.querySelectorAll('#prompt-form input, #prompt-form textarea, #prompt-form select, #revision-form textarea, #draft-content input, #draft-content textarea, #draft-content select, #draft-content button')) {
    if (!control.hasAttribute('data-always-disabled')) control.disabled = blocked;
  }
  for (const [view, panel] of Object.entries(views)) {
    panel.hidden = state.view !== view;
    const step = byId('step-' + view);
    step.disabled = blocked || (view !== 'prompt' && !hasProject);
    if (state.view === view) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  }

  byId('save-project').disabled = blocked || !hasProject;
  byId('build-preview').disabled = blocked || !hasProject || pendingSources;
  byId('approve-export').disabled = blocked || !hasPreview || !state.previewPlayable || pendingSources;
  byId('cancel-job').disabled = !state.busy || state.busy.canceling;
  byId('job-card').hidden = !state.busy;
  byId('crumb-title').textContent = state.project?.title || 'Untitled project';
  byId('crumb-title').title = state.savedPath || state.project?.title || '';

  const pageTitle = byId('page-title');
  const pageDescription = byId('page-description');
  if (state.view === 'prompt') {
    pageTitle.textContent = 'New commentary video';
    pageDescription.textContent = 'Describe your video. Splice Desk finds sources and footage, then assembles the first cut.';
  } else {
    pageTitle.textContent = state.project?.title || 'Untitled project';
    const sceneLabel = state.project?.scenes?.length === 1 ? ' scene' : ' scenes';
    pageDescription.textContent = [
      (state.project?.scenes?.length || 0) + sceneLabel,
      'Target ' + durationText(state.project?.targetSeconds),
      aspectText(state.project?.aspect),
    ].join('  ·  ');
  }

  byId('load-demo').hidden = hasProject;
  byId('sample-info').hidden = hasProject;
  byId('sample-poster').hidden = hasProject;
  byId('preview-info').hidden = !hasProject;
  byId('empty-preview').hidden = !hasProject || hasPreview;
  byId('empty-preview-text').textContent = pendingSources
    ? 'Apply your source changes to build a new preview.'
    : state.busy?.phase === 'preview' ? 'Assembling footage, voice, and captions…' : 'Build a preview to see your latest edits.';
  byId('preview-video').hidden = !hasPreview;
  byId('viewer').classList.toggle('portrait', state.project?.aspect === 'portrait');
  byId('build-preview').hidden = !hasProject || hasPreview;
  byId('open-review').hidden = !hasPreview || state.view === 'preview';
  byId('preview-badge').textContent = !hasProject ? 'Sample' : hasPreview ? state.previewPlayable ? 'Ready' : 'Loading' : 'Draft';
  byId('preview-badge').classList.toggle('ready', state.previewPlayable);
  byId('preview-duration').textContent = hasPreview ? durationText(state.preview.duration) : 'Target ' + durationText(state.project?.targetSeconds);

  byId('review-status').textContent = pendingSources
    ? 'Apply your source changes before previewing and exporting.'
    : hasPreview
      ? 'Play the preview to review the footage, spoken captions, and timing. Approve when you are ready to render the MP4.'
      : 'Build a preview of the current draft to enable export.';
  byId('spec-aspect').textContent = aspectText(state.project?.aspect);
  byId('spec-duration').textContent = hasPreview ? durationText(state.preview.duration) : 'Target ' + durationText(state.project?.targetSeconds);
  byId('export-complete').hidden = !state.exportPath;
}

function focusView(view) {
  if (view !== 'prompt' && !state.project) return;
  state.view = view;
  if (view === 'draft') renderEditor();
  renderControls();
}

function updateProgress({ percent, message } = {}) {
  if (!state.busy || state.busy.canceling) return;
  if (typeof message === 'string' && message) byId('job-message').textContent = message;
  if (Number.isFinite(percent)) byId('job-progress').value = Math.max(0, Math.min(100, percent));
}

async function run(phase, initialMessage, action) {
  if (state.busy || !api) return;
  notice('');
  state.busy = { phase, canceling: false };
  updateProgress({ percent: 0, message: initialMessage });
  renderControls();
  try {
    await action();
  } catch (error) {
    const message = plainError(error);
    if (state.busy.canceling || /\b(abort(ed)?|cancel(l)?ed)\b/iu.test(message)) notice('Task canceled.');
    else notice(message, 'error');
  } finally {
    state.busy = null;
    renderControls();
  }
}

async function cancel() {
  if (!state.busy || state.busy.canceling) return;
  state.busy.canceling = true;
  byId('job-message').textContent = 'Canceling…';
  renderControls();
  try {
    await api.cancel();
  } catch (error) {
    notice(plainError(error), 'error');
    if (state.busy) state.busy.canceling = false;
    renderControls();
  }
}

function invalidatePreview() {
  state.preview = null;
  state.previewPlayable = false;
  state.exportPath = '';
  const video = byId('preview-video');
  if (video.hasAttribute('src')) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

function updateProject(update) {
  state.project = { ...state.project, ...update };
  state.dirty = true;
  invalidatePreview();
  renderControls();
}

function changeScene(index, update) {
  const scenes = state.project.scenes.map((scene, position) => position === index ? { ...scene, ...update } : scene);
  updateProject({ scenes });
}

function formatInput(format, seconds, aspect) {
  const long = format === 'long';
  const duration = byId('duration');
  const option = document.querySelector('input[name="format"][value="' + format + '"]');
  option.checked = true;
  duration.min = long ? '3' : '15';
  duration.max = long ? '30' : '180';
  duration.step = long ? 'any' : '1';
  duration.value = String(long ? (seconds ?? 600) / 60 : (seconds ?? 60));
  byId('duration-unit').textContent = long ? 'minutes' : 'seconds';
  byId('aspect').value = aspect ?? (long ? 'landscape' : 'portrait');
}

function adoptProject(project, savedPath = '') {
  if (!project || !Array.isArray(project.scenes) || !project.scenes.length) {
    throw new Error('This project has no video scenes.');
  }
  state.project = project;
  state.savedPath = savedPath;
  state.dirty = !savedPath;
  state.tab = 'script';
  state.sceneIndex = 0;
  state.excluded.clear();
  state.addedSources = [];
  byId('feedback').value = '';
  byId('prompt').value = project.prompt || '';
  state.durationTouched = false;
  state.aspectTouched = false;
  const seconds = Number(project.targetSeconds) || 60;
  formatInput(seconds >= 180 && (seconds > 180 || project.aspect === 'landscape') ? 'long' : 'short', seconds, project.aspect);
  invalidatePreview();
  focusView('draft');
}

function inputField(labelText, id, control) {
  const field = node('div', 'field');
  const label = node('label', '', labelText);
  label.htmlFor = id;
  control.id = id;
  field.append(label, control);
  return field;
}

function textInput(value, changed, maxLength, multiline = false) {
  const input = node(multiline ? 'textarea' : 'input');
  if (multiline) input.rows = 3;
  else input.type = 'text';
  input.value = value || '';
  input.maxLength = maxLength;
  input.addEventListener('input', () => changed(input.value));
  return input;
}

function option(value, label) {
  const item = node('option', '', label);
  item.value = value;
  return item;
}

function stepScene(index) {
  state.sceneIndex = index;
  renderEditor();
  renderControls();
}

function appendNotes(container) {
  const warnings = state.project.warnings;
  if (!Array.isArray(warnings) || !warnings.length) return;
  const details = node('details', 'warning-details');
  details.append(node('summary', '', 'Draft notes (' + warnings.length + ')'));
  const list = node('ul', 'note-list');
  for (const warning of warnings) list.append(node('li', '', String(warning)));
  details.append(list);
  container.append(details);
}

function renderScript(container) {
  const project = state.project;
  const index = state.sceneIndex;
  const scene = project.scenes[index];
  const form = node('div', 'editor-fields');
  const title = textInput(project.title, (value) => updateProject({ title: value }), 160);
  form.append(inputField('Video title', 'video-title', title));

  const sceneNavigation = node('div', 'scene-navigation');
  const selector = node('select');
  project.scenes.forEach((item, position) => selector.append(option(String(position), (position + 1) + ' · ' + (item.heading || 'Untitled scene'))));
  selector.value = String(index);
  selector.addEventListener('change', () => stepScene(Number(selector.value)));
  sceneNavigation.append(inputField('Scene', 'scene-select', selector));
  const arrows = node('div', 'scene-arrows');
  for (const [label, offset] of [['Previous scene', -1], ['Next scene', 1]]) {
    const arrow = button('', 'button button-soft', () => stepScene(index + offset), 'arrow');
    arrow.setAttribute('aria-label', label);
    arrow.title = label;
    if (offset < 0) arrow.firstElementChild.classList.add('previous-icon');
    if (!project.scenes[index + offset]) {
      arrow.disabled = true;
      arrow.setAttribute('data-always-disabled', '');
    }
    arrows.append(arrow);
  }
  sceneNavigation.append(arrows);
  form.append(sceneNavigation);

  const heading = textInput(scene.heading, (value) => {
    selector.options[index].textContent = (index + 1) + ' · ' + (value || 'Untitled scene');
    changeScene(index, { heading: value });
  }, 160);
  const overlay = textInput(scene.overlay, (value) => changeScene(index, { overlay: value }), 320, true);
  const narration = textInput(scene.narration, (value) => changeScene(index, { narration: value }), 3000, true);
  narration.rows = 5;
  form.append(
    inputField('Scene heading', 'scene-heading', heading),
    inputField('On-screen fact', 'scene-fact', overlay),
    inputField('Spoken captions', 'scene-narration', narration),
    node('p', 'field-hint', 'The AI voice reads this text aloud. Caption timing updates when you rebuild the preview.'),
  );

  if (project.assets?.some((asset) => asset.downloadUrl || asset.path)) {
    const assetSelect = node('select');
    assetSelect.append(option('', 'Automatic'));
    for (const asset of project.assets.filter((item) => item.downloadUrl || item.path)) assetSelect.append(option(asset.id, asset.title));
    assetSelect.value = scene.clipId || '';
    assetSelect.addEventListener('change', () => changeScene(index, { clipId: assetSelect.value || undefined }));
    form.append(inputField('Scene footage', 'scene-footage', assetSelect));
  }

  const sourceIds = new Set(scene.sourceIds || []);
  const sceneSources = (project.sources || []).filter((source) => sourceIds.has(source.id));
  if (sceneSources.length) {
    const sources = node('div', 'scene-source-links');
    sources.append(node('p', 'field-hint', 'Sources for this scene'));
    for (const source of sceneSources) sources.append(externalLink(source.title, source.url));
    form.append(sources);
  }

  appendNotes(form);
  appendTopics(form);
  container.append(form);
}

function appendTopics(container) {
  const topics = (state.project.topics || []).map((topic) => typeof topic === 'string' ? { title: topic } : topic);
  const choices = topics.filter((topic) => topic?.title && topic.title.toLowerCase() !== state.project.title.toLowerCase());
  if (!choices.length) return;
  const details = node('details', 'warning-details');
  details.append(node('summary', '', 'Try another angle'));
  const list = node('div', 'topic-list');
  for (const topic of choices) {
    const item = node('article', 'source-item');
    item.append(node('strong', '', topic.title));
    if (topic.angle) item.append(node('p', '', topic.angle));
    item.append(button('Use this angle', 'link-button', () => {
      const feedback = byId('feedback');
      feedback.value = 'Use this angle for the video: ' + topic.title + (topic.angle ? '. ' + topic.angle : '.');
      feedback.closest('details').open = true;
      feedback.focus();
    }));
    list.append(item);
  }
  details.append(list);
  container.append(details);
}

function externalLink(label, url) {
  const action = async () => {
    try {
      await api.openExternal({ url });
    } catch (error) {
      notice(plainError(error), 'error');
    }
  };
  const link = button('', 'link-button', action);
  link.append(document.createTextNode(label), icon('external'));
  return link;
}

function validThumbnail(value) {
  try {
    const url = new URL(value);
    const allowed = ['upload.wikimedia.org', 'thumb.wikimedia.org'];
    return url.protocol === 'https:' && allowed.includes(url.hostname) && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

function appendAddedSourceForm(container) {
  const details = node('details', 'revision source-add');
  details.append(node('summary', '', 'Add a source'));
  const form = node('form');
  const url = node('input');
  url.type = 'url';
  url.placeholder = 'https://…';
  url.required = true;
  url.maxLength = 4000;
  const title = node('input');
  title.type = 'text';
  title.required = true;
  title.maxLength = 200;
  const excerpt = node('textarea');
  excerpt.rows = 2;
  excerpt.required = true;
  excerpt.maxLength = 3000;
  const queue = node('button', 'button button-soft', 'Add to research');
  queue.type = 'submit';
  form.append(
    inputField('Source URL', 'source-url', url),
    inputField('Source title', 'source-title', title),
    inputField('Relevant excerpt', 'source-excerpt', excerpt),
    queue,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.busy) return;
    const cleanUrl = url.value.trim();
    if (!/^https:\/\//iu.test(cleanUrl)) {
      notice('Enter a source URL that starts with https://.', 'error');
      return;
    }
    const cleanTitle = title.value.trim();
    const cleanExcerpt = excerpt.value.trim();
    if (!cleanTitle || !cleanExcerpt) return;
    const source = { url: cleanUrl, title: cleanTitle, excerpt: cleanExcerpt };
    state.addedSources = [...state.addedSources.filter((item) => item.url !== cleanUrl), source];
    invalidatePreview();
    renderEditor();
    renderControls();
  });
  details.append(form);
  container.append(details);
}

function renderSources(container) {
  const sources = state.project.sources || [];
  const list = node('div', 'source-list editor-fields');
  if (!sources.length) list.append(node('p', 'field-hint', 'This draft has no linked research sources.'));

  for (const source of sources) {
    const item = node('article', 'source-item');
    item.append(externalLink(source.title || 'Open source', source.url));
    if (source.excerpt) item.append(node('p', '', source.excerpt));
    const label = node('label', 'source-exclusion');
    const check = node('input');
    check.type = 'checkbox';
    check.checked = state.excluded.has(source.id);
    check.addEventListener('change', () => {
      if (check.checked) state.excluded.add(source.id);
      else state.excluded.delete(source.id);
      invalidatePreview();
      renderSourceButtons();
      renderControls();
    });
    label.append(check, 'Exclude from next draft');
    item.append(label);
    list.append(item);
  }

  for (const source of state.addedSources) {
    const item = node('article', 'source-item');
    item.append(externalLink(source.title, source.url), node('p', '', 'Queued for the next draft'));
    item.append(button('Remove', 'link-button', () => {
      state.addedSources = state.addedSources.filter((entry) => entry !== source);
      renderEditor();
      renderControls();
    }));
    list.append(item);
  }

  const sourceButtons = node('div', 'editor-fields');
  sourceButtons.id = 'source-buttons';
  sourceButtons.append(
    node('p', 'source-pending', 'Regenerate to apply these source changes.'),
    button('Apply source changes', 'button button-soft', reviseDraft, 'check'),
  );
  list.append(sourceButtons);
  container.append(list);
  renderSourceButtons();
  appendAddedSourceForm(container);
}

function renderSourceButtons() {
  const group = byId('source-buttons');
  if (group) group.hidden = !hasSourceChanges();
}

async function addLocalClips() {
  if (state.busy) return;
  notice('');
  try {
    const paths = await api.addClips();
    if (!Array.isArray(paths) || !paths.length) return;
    const clips = Array.from(new Set([...(state.project.clips || []), ...paths]));
    updateProject({ clips, background: 'custom' });
    renderEditor();
    renderControls();
  } catch (error) {
    notice(plainError(error), 'error');
  }
}

function renderFootage(container) {
  const project = state.project;
  const group = node('div', 'editor-fields');
  const select = node('select');
  const choices = [
    ['auto', 'Match clips to scenes'],
    ['shuffle', 'Shuffle built-in backgrounds'],
    ['violet', 'Violet background'],
    ['ember', 'Ember background'],
    ['ocean', 'Ocean background'],
    ['custom', 'Shuffle imported clips'],
  ];
  for (const [value, label] of choices) {
    const entry = option(value, label);
    if (value === 'custom' && !project.clips?.length) entry.disabled = true;
    select.append(entry);
  }
  select.value = project.background || 'auto';
  select.addEventListener('change', () => updateProject({ background: select.value }));
  group.append(inputField('Background', 'background-mode', select));
  group.append(button('Import local clips', 'button button-soft', addLocalClips, 'plus'));

  if (project.clips?.length) {
    const list = node('div', 'asset-list');
    for (const path of project.clips) {
      const item = node('article', 'asset-item');
      item.append(node('strong', '', filename(path)));
      item.append(button('Remove', 'link-button', () => {
        const clips = project.clips.filter((clip) => clip !== path);
        updateProject({ clips, background: clips.length || project.background !== 'custom' ? project.background : 'auto' });
        renderEditor();
        renderControls();
      }));
      list.append(item);
    }
    group.append(list);
  }

  const assets = project.assets || [];
  if (assets.length) {
    const gallery = node('div', 'asset-list');
    gallery.append(node('p', 'field-hint', 'Research footage'));
    for (const asset of assets) {
      const item = node('article', 'asset-item');
      if (validThumbnail(asset.thumbnailUrl)) {
        const image = node('img', 'thumb');
        image.alt = '';
        image.referrerPolicy = 'no-referrer';
        image.loading = 'lazy';
        image.src = asset.thumbnailUrl;
        item.append(image);
      }
      if (asset.url) item.append(externalLink(asset.title, asset.url));
      else item.append(node('strong', '', asset.title));
      const credit = [asset.author, asset.license].filter(Boolean).join(' · ');
      if (credit) item.append(node('p', '', credit));
      gallery.append(item);
    }
    group.append(gallery);
  } else if (!project.clips?.length) {
    group.append(node('p', 'field-hint', 'This draft uses a built-in animated background.'));
  }
  container.append(group);
}

function renderEditor() {
  const content = byId('draft-content');
  content.replaceChildren();
  if (!state.project) return;
  for (const tab of ['script', 'sources', 'footage']) byId('tab-' + tab).setAttribute('aria-pressed', String(tab === state.tab));
  if (state.tab === 'script') renderScript(content);
  if (state.tab === 'sources') renderSources(content);
  if (state.tab === 'footage') renderFootage(content);
}

async function buildPreview() {
  if (!state.project || hasSourceChanges() || state.busy.canceling) return;
  state.busy.phase = 'preview';
  updateProgress({ percent: 0, message: 'Building video preview…' });
  renderControls();
  const result = await api.preview({ project: state.project });
  if (!result?.url) {
    if (state.busy.canceling || result?.canceled) return;
    throw new Error('The preview could not be opened.');
  }
  state.preview = result;
  state.previewPlayable = false;
  byId('preview-video').src = result.url;
  focusView('preview');
  if (Array.isArray(result.warnings) && result.warnings.length) notice(result.warnings.join(' '));
}

async function generateDraft(request) {
  if (!state.settings?.hasKey) {
    openSettings('Add a Gemini API key to generate a draft.');
    return;
  }
  await run('draft', 'Finding an angle and researching sources…', async () => {
    const project = await api.createDraft(request);
    if (state.busy.canceling) return;
    adoptProject(project);
    await buildPreview();
  });
}

function startDraft(event) {
  event.preventDefault();
  const prompt = byId('prompt').value.trim();
  if (!prompt) {
    notice('Describe the video you want to make.', 'error');
    byId('prompt').focus();
    return;
  }
  const promptedSeconds = promptOptions(prompt).seconds;
  if (!state.durationTouched && promptedSeconds !== undefined && (promptedSeconds < 15 || promptedSeconds > 1800)) {
    notice('Choose a duration between 15 seconds and 30 minutes.', 'error');
    return;
  }
  syncPromptOptions();
  const long = document.querySelector('input[name="format"]:checked').value === 'long';
  const seconds = Math.round(Number(byId('duration').value) * (long ? 60 : 1));
  return generateDraft({ prompt, targetSeconds: seconds, aspect: byId('aspect').value });
}

function reviseDraft(event) {
  event?.preventDefault();
  if (!state.project) return;
  const feedback = byId('feedback').value.trim();
  if (!feedback && !hasSourceChanges()) {
    notice('Describe a revision or change the draft sources.', 'error');
    byId('feedback').focus();
    return;
  }
  const project = state.project;
  const options = promptOptions(feedback);
  if (options.seconds !== undefined && (options.seconds < 15 || options.seconds > 1800)) {
    notice('Choose a duration between 15 seconds and 30 minutes.', 'error');
    return;
  }
  return generateDraft({
    prompt: project.prompt || project.title,
    targetSeconds: options.seconds ?? project.targetSeconds,
    aspect: options.aspect ?? project.aspect,
    previous: project,
    feedback,
    excludedSourceIds: Array.from(state.excluded),
    addedSources: state.addedSources,
  });
}

async function turnIntoDemo() {
  await run('draft', 'Opening the sample project…', async () => {
    const project = await api.demo();
    if (state.busy.canceling) return;
    adoptProject(project);
    await buildPreview();
  });
}

function resetProject() {
  state.project = null;
  state.savedPath = '';
  state.dirty = false;
  state.sceneIndex = 0;
  state.durationTouched = false;
  state.aspectTouched = false;
  state.excluded.clear();
  state.addedSources = [];
  byId('prompt').value = '';
  byId('feedback').value = '';
  formatInput('short');
  invalidatePreview();
  notice('');
  focusView('prompt');
  byId('prompt').focus();
}

function confirmReplacement(action, title, label) {
  if (!state.dirty) return action();
  state.replaceAction = action;
  byId('reset-title').textContent = title;
  byId('discard-project').textContent = label;
  byId('reset-dialog').showModal();
}

async function openProject() {
  try {
    const result = await api.openProject();
    if (result?.canceled) return;
    adoptProject(result.project, result.path);
    notice('');
  } catch (error) {
    notice(plainError(error), 'error');
  }
}

async function saveProject() {
  if (!state.project) return;
  try {
    const result = await api.saveProject({ project: state.project });
    if (result?.canceled) return;
    state.savedPath = result.path;
    state.dirty = false;
    renderControls();
    notice('Project saved as ' + filename(result.path) + '.');
  } catch (error) {
    notice(plainError(error), 'error');
  }
}

async function exportVideo() {
  if (!state.preview || !state.previewPlayable || hasSourceChanges()) return;
  await run('export', 'Preparing local MP4 export…', async () => {
    const result = await api.exportVideo({ project: state.project });
    if (result?.canceled || !result?.path) return;
    state.exportPath = result.path;
    byId('export-result').textContent = 'Saved ' + filename(result.path);
    if (result.warning) notice(result.warning, 'error');
    else if (result.creditsPath) notice('Video and source credits saved.');
  });
}

async function showFile() {
  try {
    await api.showItem({ path: state.exportPath });
  } catch (error) {
    notice(plainError(error), 'error');
  }
}

function settingsError(message) {
  byId('settings-error').textContent = message;
  byId('settings-error').hidden = !message;
}

function openSettings(message = '') {
  const settings = state.settings || {};
  byId('api-key').value = '';
  byId('api-key').placeholder = settings.hasKey ? 'A key is already saved' : 'Paste your Gemini API key';
  byId('model').value = settings.model || defaultModel;
  byId('remove-key').hidden = !settings.hasKey;
  byId('voice-status').textContent = settings.voiceAvailable
    ? 'Local AI narration is ready.'
    : 'Local AI narration is unavailable. Check that Splice Desk’s voice files are installed.';
  settingsError(message);
  byId('settings-dialog').showModal();
}

async function saveSettings(clearKey = false) {
  const key = byId('api-key').value.trim();
  const model = byId('model').value.trim();
  if (!model) return;
  const request = { model };
  if (clearKey) request.clearKey = true;
  else if (key) request.apiKey = key;
  const submit = byId('save-settings');
  const remove = byId('remove-key');
  submit.disabled = true;
  remove.disabled = true;
  try {
    await api.saveSettings(request);
    state.settings = await api.getSettings();
    status();
    byId('settings-dialog').close();
  } catch (error) {
    settingsError(plainError(error));
  } finally {
    submit.disabled = false;
    remove.disabled = false;
  }
}

for (const view of Object.keys(views)) byId('step-' + view).addEventListener('click', () => focusView(view));
for (const tab of ['script', 'sources', 'footage']) {
  byId('tab-' + tab).addEventListener('click', () => {
    state.tab = tab;
    renderEditor();
    renderControls();
  });
}
for (const input of document.querySelectorAll('input[name="format"]')) {
  input.addEventListener('change', () => {
    state.durationTouched = true;
    state.aspectTouched = true;
    formatInput(input.value);
  });
}
byId('duration').addEventListener('input', () => { state.durationTouched = true; });
byId('aspect').addEventListener('change', () => { state.aspectTouched = true; });
byId('prompt').addEventListener('input', syncPromptOptions);

byId('new-project').addEventListener('click', () => confirmReplacement(resetProject, 'Start a new project?', 'Start new project'));
byId('open-project').addEventListener('click', () => confirmReplacement(openProject, 'Open another project?', 'Open project'));
byId('save-project').addEventListener('click', saveProject);
byId('keep-project').addEventListener('click', () => byId('reset-dialog').close());
byId('discard-project').addEventListener('click', () => {
  const action = state.replaceAction;
  byId('reset-dialog').close();
  action?.();
});
byId('reset-dialog').addEventListener('close', () => { state.replaceAction = null; });
byId('prompt-form').addEventListener('submit', startDraft);
byId('revision-form').addEventListener('submit', reviseDraft);
byId('fill-example').addEventListener('click', () => {
  const input = byId('prompt');
  input.value = examplePrompt;
  syncPromptOptions();
  input.focus();
});
byId('load-demo').addEventListener('click', turnIntoDemo);
byId('build-preview').addEventListener('click', () => run('preview', 'Building video preview…', buildPreview));
byId('open-review').addEventListener('click', () => focusView('preview'));
byId('approve-export').addEventListener('click', exportVideo);
byId('show-export').addEventListener('click', showFile);
byId('cancel-job').addEventListener('click', cancel);
byId('notice-dismiss').addEventListener('click', () => notice(''));
byId('settings').addEventListener('click', () => openSettings());
byId('close-settings').addEventListener('click', () => byId('settings-dialog').close());
byId('settings-dialog').addEventListener('close', () => { byId('api-key').value = ''; });
byId('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  saveSettings();
});
byId('remove-key').addEventListener('click', () => saveSettings(true));
byId('get-key').addEventListener('click', async () => {
  try {
    await api.openExternal({ url: 'https://aistudio.google.com/app/apikey' });
  } catch (error) {
    settingsError(plainError(error));
  }
});
byId('preview-video').addEventListener('error', () => {
  if (!state.preview) return;
  invalidatePreview();
  renderControls();
  notice('The video preview could not be played. Build it again to review your edits.', 'error');
});
byId('preview-video').addEventListener('loadedmetadata', () => {
  if (!state.preview) return;
  state.previewPlayable = true;
  renderControls();
});

renderControls();
if (api) {
  api.onProgress(updateProgress);
  api.getSettings().then((settings) => {
    state.settings = settings;
    status();
  }).catch((error) => {
    status();
    notice(plainError(error), 'error');
  });
} else {
  status();
  notice('Open Splice Desk as a desktop app to generate and render videos.', 'error');
}
