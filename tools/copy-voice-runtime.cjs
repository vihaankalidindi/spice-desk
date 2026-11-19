const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function copyVoiceRuntime({ electronPlatformName, appOutDir, packager }) {
  if (electronPlatformName !== 'win32') return;

  // Electron Builder filters node_modules from the resources tree. The voice engine loads
  // these native modules from disk beside its model and vendor DLLs.
  const source = path.join(packager.projectDir, 'stage', 'win', 'voice', 'node_modules');
  const target = path.join(appOutDir, 'resources', 'voice', 'node_modules');
  await fs.cp(source, target, { recursive: true });
};
