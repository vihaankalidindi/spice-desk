# Splice Desk

Splice Desk turns a prompt into an editable commentary-video draft. It finds source material and reusable footage, writes scene narration, and assembles a preview with foreground facts and spoken captions.

## Get started

1. Download the Windows x64 installer from the [latest release](../../releases/latest), run it on a 64-bit Windows 11 PC, and open Splice Desk.
2. Choose **Try sample** to preview the editing and export workflow offline.
3. For new prompts, create a Gemini API key in Google AI Studio and paste it into **Settings**. A free-tier project can use the app within Google's model and account quotas.
4. Pick **Short-form** for 15 seconds to 3 minutes or **Long-form** for 3 to 30 minutes. You can choose either vertical or landscape layout. Enter a topic or a broad request, then generate the draft.
5. Review the source links and footage. Edit a scene or describe a revision in the prompt box. Build a fresh preview after edits, then choose **Approve and export**.

Target length guides the script. The actual duration follows the generated narration and pacing. Both layouts export a 1080p H.264/AAC MP4 at 30 frames per second. The export includes a separate text file with links and footage credits for use when publishing.

## What runs where

Gemini receives the prompt, relevant source excerpts, and revision instructions. Wikipedia and Wikimedia Commons supply article excerpts and footage metadata. Imported clips, neural narration, preview composition, and MP4 export stay on your computer. The installer bundles an English AI voice powered by Supertonic 3 and an FFmpeg encoder. Once needed footage is cached, preview and export work without internet access. Your Gemini key is encrypted with Windows user protection. The bundled voice model is subject to the Supertonic 3 OpenRAIL-M terms included with the installer.

The app stores imported footage and downloaded media under the Windows user profile. Save a project as a `.splice.json` file. Project files reopen on the same PC with their local media cache.

## Build from source

Use Node.js 22.12 or newer on Windows x64.

```powershell
npm ci
npm run package:windows
```

The build stages the Windows FFmpeg tools, neural voice runtime and model, and produces an NSIS installer in `release/`. Third-party notices are included with the staged runtime assets. For development, stage the local voice for your platform, provide FFmpeg and FFprobe on PATH, and run `npm start`.
