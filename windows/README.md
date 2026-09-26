# Compositor for Windows

This folder is the Windows version of Compositor. It has the same tools, menus, panels and behaviour as the Mac
app, and it reads and writes the same project format, so a project can move between a Mac and a PC.

The Mac app is written in Swift with Apple-only frameworks (AppKit, SwiftUI, Core Image, Metal, Vision), so it
cannot run on Windows. This version is a port of the same editor to Electron, TypeScript, React and WebGL 2; every
feature was translated from the Mac source. The Mac project in the rest of the repository is unchanged.

- [Install it](#install-it)
- [Build and run it from source](#build-and-run-it-from-source)
- [Open the app](#open-the-app)
- [The window](#the-window)
- [A first project, step by step](#a-first-project-step-by-step)
- [Features and how to use them](#features-and-how-to-use-them)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Differences from the Mac app](#differences-from-the-mac-app)
- [Troubleshooting](#troubleshooting)
- [For developers](#for-developers)

## Install it

Every push to GitHub that changes `windows/` makes the
[Windows workflow](../.github/workflows/windows.yml) build and test the app on Windows and attach two files to the
run (GitHub → **Actions** → **Windows** → the latest run → **Artifacts** → `Compositor-Windows`):

| File | What it is |
| --- | --- |
| `Compositor-Setup-<version>.exe` | The installer. Installs for your user (no administrator needed), lets you pick the folder, and adds Start menu and desktop shortcuts. Uninstall it from **Settings → Apps**. |
| `Compositor-<version>-Portable.exe` | A single program you can run from anywhere (a USB stick, Downloads) without installing. It unpacks itself each time it starts, so it opens a little slower than the installed app. |

The installer first asks who Compositor is for:

- **Only for me** (the default) needs no administrator rights and suggests a folder in your user profile
  (`%LOCALAPPDATA%\Programs\Compositor`). You can choose another folder, but not one that needs administrator rights,
  such as Program Files; if you do, the installer says so before installing anything.
- **Anyone who uses this computer** asks Windows for administrator permission and suggests Program Files.

Pushing a tag named after the version in `package.json` (for example `v1.0.4`) also publishes both files as a
GitHub release, which is where **Help → Check for Updates…** looks for new versions.

The builds are not code-signed, so the first time you run one Windows SmartScreen may say *“Windows protected your
PC”*: click **More info**, then **Run anyway**.

Requirements: Windows 10 or 11, 64-bit, with a graphics driver that supports WebGL 2 (practically every PC from the
last ten years).

## Build and run it from source

1. Install [Node.js 22 LTS](https://nodejs.org) (it includes `npm`) and [Git](https://git-scm.com).
2. Get the code and install the dependencies:
   ```powershell
   git clone https://github.com/rambo-mn/Compositor.git
   cd Compositor\windows
   npm install
   ```
3. Run the app:
   ```powershell
   npm start
   ```
4. Build the installer and the portable app (they appear in `windows\release\`):
   ```powershell
   npm run dist
   ```
   `npm run dist` also downloads Remove Background's model (about 170 MB) into `resources\models\` so the installer
   includes it. `npm run pack` builds just the unpacked app folder, which is quicker for trying a build.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Checks the TypeScript. |
| `npm test` | Unit tests (the editor’s logic and the project format). |
| `npm run e2e` | Builds the app and drives it with Playwright: painting, selections, adjustments, filters, masks, saving and reopening, dialogs, Remove Background and 26 GPU pixel checks. |
| `npm run watch` | Rebuilds on every change (run `npx electron .` in another terminal). |
| `npm run fetch-model` | Downloads Remove Background’s model into `resources\models\`. |
| `npm run icons` | Rebuilds `build\icon.ico` from the Mac app’s icon artwork. |

## Open the app

- **Installed:** Start menu → **Compositor**, or the desktop shortcut.
- **Portable:** double-click `Compositor-<version>-Portable.exe`.
- **From source:** `npm start` in the `windows` folder.

You can also open things straight into it:

- Double-click a **`.comp` project** in File Explorer (the installer registers the file type).
- Drag **images** (JPEG, PNG, HEIC, TIFF, WebP, BMP, GIF) or **projects** onto the window. Images dropped on the
  canvas land where you drop them; images dropped on a tab go into that project; images dropped on the **+** button or
  the **New** slot that appears in the tab strip open in new tabs.
- Right-click an image → **Open with** → **Choose another app** → **Choose an app on your PC**, and pick
  `Compositor.exe` (the installer puts it in `%LOCALAPPDATA%\Programs\Compositor`).
- Paste an image copied in another app with **Ctrl+V**.

The first launch fills the screen; after that the window opens where and how you left it. Only one copy of the app
runs at a time — files opened while it is running go to the open window.

## The window

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ File Edit View Select Image Filter Layer Help   +  [tab] [tab]  Fit 100% ⊕ ⊖ │  title bar
├──────────────────────────────────────────────────────────────────────────────┤
│ the current tool's options                                                   │  option bar
├────┬───────────────────────────────────────────────────────────┬─────────────┤
│tool│                                                           │ Layers      │
│rail│                         canvas                            │ blend, opac.│
│    │                                                           │ layer list  │
│ ▣▢ │                                                           │ + ▭ ◐ … 🗑  │
├────┴───────────────────────────────────────────────────────────┴─────────────┤
│ zoom · canvas size · sRGB                              how to use this tool  │  status bar
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Title bar:** the menus; **+** (new canvas); a tab for each open project (a dot means unsaved changes, **×** closes
  it); **Fit**, **100%** and zoom in/out. Drag an empty part of the bar to move the window; double-click it to
  maximize.
- **Option bar:** the settings of the tool you are using (size, mode, tolerance, Apply/Cancel…).
- **Tool rail:** the tools, and under them the foreground and background colours.
- **Canvas:** your image on a checkerboard (transparency). A new project shows the **New canvas** page here.
- **Layers panel:** blend mode and opacity of the selected layer, the layer list, and buttons for new layers,
  folders, masks, adjustment layers and deleting. Drag its left edge to make it wider or narrower.
- **Status bar:** the zoom, the canvas size, and a one-line reminder of how the current tool works (or
  *Working…* during long operations).

Floating panels (Levels, Hue/Saturation, filters, the colour picker) open over the canvas without blocking it; drag
their title to move them, **Enter** is OK and **Esc** is Cancel. Dialogs (Canvas Size, Image Size, Export JPEG,
questions) dim the window until you answer.

## A first project, step by step

1. Start Compositor. On **New canvas**, type a size (1920 × 1080 is filled in; if an image is on the clipboard, its
   size is) and click **Create canvas** — or click **Import image** to start from a photo, whose size becomes the
   canvas size.
2. Drag more images onto the canvas; each becomes a layer.
3. Press **V** and drag a layer to move it; drag a corner handle to resize it, the small circle above it to rotate
   it, then press **Enter** to apply.
4. Press **B**, pick a colour with the swatch at the bottom of the tool rail, and paint.
5. Click the mask button at the bottom of the Layers panel and paint in black to hide parts of a layer.
6. **Image → Levels…** (Ctrl+L) or **Hue/Saturation…** (Ctrl+U) to adjust colours.
7. **Ctrl+S** saves the project (`.comp`); **File → Export PNG…** or **Export JPEG…** makes an image to share.

## Features and how to use them

On Windows, **Ctrl** replaces the Mac’s ⌘ and **Alt** replaces ⌥ (Option), exactly as in Photoshop for Windows.

### Projects and tabs

- **New canvas** — **File → New Canvas…** (Ctrl+N) or **+** opens a new tab with the New canvas page: width and
  height in pixels (1 to 30,000), transparent, sRGB.
- **Open** — **File → Open Project…** (Ctrl+O) opens one or more `.comp` projects in tabs. A project that is already
  open is switched to, not opened twice.
- **Open a Mac project** — Mac projects are folders named `Something.comp`. Open them with **File → Open Mac Project
  Folder…**, or drag the folder onto the window.
- **Save** — **File → Save** (Ctrl+S). A new project asks where; after that it saves in place. **Save As…**
  (Ctrl+Shift+S) saves a copy under a new name. Projects keep every layer, mask, adjustment layer, folder, blend mode
  and position, at full resolution.
- **Save for a Mac** — **File → Save As Mac Project Folder…** writes the folder form the Mac app opens.
- **Tabs** — click a tab to switch projects; **×** or **File → Close Project** (Ctrl+W) closes one. If it has unsaved
  changes you are asked to **Save**, **Don’t Save** or **Cancel**; closing the window asks about every unsaved
  project.
- **Layers between projects** — drag a layer from the Layers panel onto another project’s tab (or the **New** slot)
  to copy it there, with its mask and contents.
- **Undo / Redo** — **Edit → Undo** (Ctrl+Z) and **Redo** (Ctrl+Shift+Z or Ctrl+Y); the menu names the step. Up to 100
  steps per project (fewer with very large images).

### Importing and exporting

- **Import** — **File → Import Images…**, **Import image** on the New canvas page, or drag files in. JPEG, PNG,
  HEIC, TIFF, WebP, BMP and GIF are read, with their colour profiles converted to sRGB and camera orientation
  applied. The first image of an empty project sets the canvas size. Limits: 30,000 pixels a side, 100 megapixels of
  layers per project.
- **Paste** — **Ctrl+V** pastes an image from the clipboard (a screenshot, an image copied in a browser, or pixels
  copied in Compositor, which go back where they came from) as a new layer.
- **Copy** — **Ctrl+C** copies the selected pixels of the active layer (the whole layer without a selection);
  **Ctrl+Shift+C** (Copy Merged) copies everything visible; **Ctrl+X** cuts.
- **Export PNG** — **File → Export PNG…** (Ctrl+Shift+E): the visible image, with transparency, at the canvas size
  and the document’s resolution.
- **Export JPEG** — **File → Export JPEG…** (Ctrl+Alt+Shift+S): a live preview with the file size; set **Quality**
  and the **Background for transparency** colour, then **Export…**.

### Looking around

- **Zoom** — Ctrl+wheel, Alt+wheel or a touchpad pinch zoom about the pointer; **View → Zoom In/Out** (Ctrl+= /
  Ctrl+-); **Fit Canvas** (Ctrl+0); **Actual Pixels** (Ctrl+1), where one image pixel is one screen pixel. From 200%
  pixels are shown as sharp squares; from 800% a **pixel grid** appears (**View → Pixel Grid**).
- **Pan** — scroll the wheel (Shift+wheel sideways), hold **Space** and drag, drag with the middle mouse button, or use
  the **Hand** tool (H).
- **Zoom tool** (Z) — click to zoom in, Alt-click to zoom out, or drag right/left to zoom smoothly. Its option bar
  takes an exact percentage.
- **Full screen** — **View → Full Screen** (F11).

### Tools

Pick a tool on the rail or with its key. Each tool’s options are in the option bar.

- **Move / Transform (V)** — drag to move the layer; the box’s handles resize it, the circle above rotates it, and
  **Enter** applies (**Esc** cancels). Shift keeps proportions (or unlocks them when the lock is on), rotates in 15°
  steps and keeps moves on one axis; Alt resizes about the centre; **Alt-drag duplicates** the layer; **Ctrl-drag a
  handle distorts** the layer in perspective. Moves snap to the canvas’s and other layers’ edges and centres (guides
  show where); press Ctrl during a drag to move freely. Arrow keys nudge by 1 px (Shift: 10). The option bar has exact
  **X, Y, W, H, Scale, angle**, the aspect lock, **Sampling** (Nearest, Smooth, High quality), **Flip H/V**, **Auto
  Select** (click picks the layer under the pointer; otherwise Ctrl-click does) and **Show Controls** (Ctrl+H). With
  several layers or a folder selected, they transform together. Transforms never lose quality: a layer keeps its
  full-resolution pixels however small you make it.
- **Marquee (M)** — drag a **Rectangle** or **Ellipse** selection. Shift adds, Alt subtracts (or choose **New / Add /
  Subtract**); press Shift again during a drag for a square or circle.
- **Lasso (L)** — **Freehand**: drag around an area. **Polygonal**: click corners; close by clicking the first corner,
  double-clicking or pressing Enter; Backspace removes the last corner; Esc cancels.
- **Magic Wand (W)** — click a colour to select similar colours. **Tolerance** (0–255), **Sample size** (the clicked
  pixel, or a 3×3 or 5×5 average), **This Layer / All Layers**, **Contiguous** (only connected pixels) and
  **Anti-alias**.
- With any selection tool: drag inside the selection to move its outline; **Ctrl-drag** inside it cuts and moves the
  pixels (Ctrl+Alt-drag copies them); arrows nudge the outline, Ctrl+arrows the pixels; **Expand**/**Contract** by a
  number of pixels; **Delete** clears the selected pixels; a click without dragging deselects.
- **Crop (C)** — drag a frame (or adjust the one covering the canvas), then **Enter** or **Apply Crop**. **Ratio**:
  Free, Original, 1:1, 4:3 or 16:9. Edges snap to the canvas and layers (Ctrl: no snapping); Alt resizes
  symmetrically. Drag the frame past the canvas to make the canvas bigger. Esc cancels.
- **Brush (B) and Eraser (E)** — **Paint** with the foreground colour or **Erase** to transparency. **Size**,
  **Hardness** and **Opacity**. **[** and **]** change the size, **Shift+[** and **Shift+]** the hardness, and the
  digits the opacity (1 = 10% … 9 = 90%, 0 = 100%, two quick digits for values like 45%). Right-drag left/right to
  resize the brush on the canvas (with Shift: hardness). Shift-click paints a straight line from the last stroke;
  holding Shift while painting keeps the stroke horizontal or vertical. Esc cancels a stroke. On a mask it paints
  black (hide) or white (reveal).
- **Spot Healing Brush (J)** — paint over blemishes to replace them with the surrounding texture: **Content-Aware**,
  **Create Texture** or **Proximity Match**.
- **Clone Stamp (S)** — **Alt-click** where to copy from, then paint. The circle previews what will be copied and a
  cross marks the source. **Aligned** keeps the source moving with the brush between strokes; **This Layer / All
  Layers** chooses what is copied.
- **Smear (R)** — **Liquify** pushes pixels along the stroke, **Blur** softens, **Smudge** drags colour along.
  Works on masks too. Its opacity is **Strength**.
- **Gradient (G)** — drag a line; drag its ends to adjust it before **Enter** (or Apply). **Linear** or **Radial**,
  **Foreground to Background** or **Foreground to Transparent**, **Reverse**, **Opacity**; Shift keeps the line to
  45° steps. On a mask it draws a black-to-white gradient.
- **Shape (U)** — drag a **Rectangle** (with rounded corners from **Radius**) or **Ellipse**, filled with the
  foreground colour, on a new layer. Shift makes a square or circle, Alt draws from the centre, **Shift+U** switches
  shape, Esc cancels. Shapes stay sharp when you resize them later.
- **Eyedropper (I)** — click or drag on the canvas to pick the foreground colour; the **Sample Ring** shows the new
  colour above the old one. With the Brush, Spot Healing or Gradient tool, hold Alt and click to do the same.
- **Hand (H)** and **Zoom (Z)** — see *Looking around*. **No tool (A)** makes canvas clicks do nothing.

### Colours

- The two swatches at the bottom of the tool rail are the **foreground** (top) and **background** colours. Click one
  to open the **colour picker**: a saturation/brightness square, a hue strip, RGB values and a hex code; click the
  canvas while it is open to sample a colour; OK keeps it.
- **X** swaps them, **D** resets black and white (the small arrows beside the swatches do the same).
- With a mask selected the colours are black or white only (click a swatch to choose).

### Selections (Select menu)

- **All** (Ctrl+A), **Deselect** (Ctrl+D), **Inverse** (Ctrl+Shift+I).
- **Layer’s Pixels** — selects the active layer’s visible pixels. **Mask’s Black Areas** — selects what the mask
  hides. (Or Ctrl-click a layer or mask thumbnail; Ctrl+Shift adds, Ctrl+Alt subtracts.)
- **Expand / Contract by N px** — the amounts are set in the selection tools’ option bar.
- **Edit → Fill with Foreground Color** (Alt+Backspace) / **Background Color** (Ctrl+Backspace), **Clear Selection
  Pixels**, and **Content-Aware Fill…** (Shift+Backspace), which fills the selection from the surrounding image — even
  past the layer’s edge, to extend a photo.
- **Layer → Transform Selection** (Ctrl+T with a selection) lifts the selected pixels so you can move, scale, rotate
  or distort just them.
- **Layer → Layer via Copy** (Ctrl+J) copies the selected pixels to a new layer.

### Layers

- **New Blank Layer** (Ctrl+Shift+N or the first footer button), **Duplicate Layer** (Ctrl+J without a selection),
  **Delete** (Delete key or the trash button), **Rename** (double-click the name, or **Layer → Rename Layer…**).
- **Show/hide** with the eye; press an eye and drag down the list to show or hide several layers at once.
- **Reorder** by dragging rows (drop onto a folder’s middle to put a layer inside it); **Alt-drag** duplicates.
  **Move Layer Up/Down** (Ctrl+] / Ctrl+[).
- **Select several** with Ctrl-click and Shift-click; they then move, transform, group or merge together.
- **Folders** — **Group Selected Layers** (Ctrl+G or the folder button); **Move Out of Folder**; the arrow collapses a
  folder. A folder can have its own mask, which hides everything inside.
- **Opacity** and **blend mode** — at the top of the Layers panel. Hovering over a blend mode in its menu previews it
  on the canvas. **Shift++** and **Shift+-** step through the 13 modes: Normal, Multiply, Screen, Overlay, Darken,
  Lighten, Difference, Color Dodge, Color Burn, Hue, Saturation, Color and Luminosity. With the Move tool, the digit
  keys set the layer’s opacity.
- **Merge** (Ctrl+E) — **Merge Down** the active layer into the one below, **Merge Layers** when several are selected,
  or **Merge Group** for a folder.
- **Flip Layer** and **Image → Flip Canvas**, horizontal or vertical.
- **Layer masks** — the mask button adds a white mask (reveal all), or with a selection, a mask that hides the
  selected area. Click the mask thumbnail to paint on it (black hides, white reveals, grey partly); click the layer
  thumbnail to paint the image again. **Shift-click** the mask to turn it off (a red slash) or on. The chain between
  the thumbnails links layer and mask; click it to **unlink** them and move or transform the mask on its own.
  **Alt-drag** a mask onto another layer to copy it. Right-click a row for **Add White/Black Mask**,
  **Enable/Disable Mask**, **Delete Mask**. **Image → Invert** (Ctrl+I) inverts a selected mask.
- **Clipping masks** — **Layer → Create Clipping Mask** (Ctrl+Alt+G), or **Alt-click the bottom edge of a row**: the
  layer shows only where the layer below it has pixels (the row is indented with ↳). Do the same to release it.
- **Adjustment layers** — **Layer → New Adjustment Layer** or the half-circle footer button: **Hue/Saturation,
  Levels, Curves, Exposure, Gradient Map, Grain**. They change everything beneath them without touching the pixels;
  double-click one to edit it again; give it a mask or clip it to a layer to limit it.
- **Right-click a row** for Rename, Hide/Show, masks, Release Clipping Mask, Move Out of Folder and Delete.

### Image menu

- **Curves…** (Ctrl+M) — per channel (RGB, Red, Green, Blue): click the graph to add points (up to 32), drag them,
  **Remove point**, **Reset curve**.
- **Levels…** (Ctrl+L) — the layer’s histogram; drag the black, grey (gamma) and white input handles and the output
  handles, or type values; per channel; eyedroppers that set **Black**, **Gray** or **White** from a pixel you click;
  **Auto**: Contrast, Color, or Color + neutral midtones; **Preview** (Alt+P).
- **Hue/Saturation…** (Ctrl+U) — **Hue**, **Saturation** and **Lightness** for the whole image (**Master**) or one
  colour range (Reds, Yellows, Greens, Cyans, Blues, Magentas). For a range, the spectrum bars show and let you drag
  the band it affects, the eyedroppers set, widen or narrow the band from the image, and **Apply outside this range**
  inverts it. The hand button is the **targeted adjustment**: drag left/right on the image to change that colour’s
  saturation (Ctrl-drag: its hue). **Colorize** tints the whole layer one hue.
- **Exposure…** — Exposure, Offset and Gamma.
- **Gradient Map…** — maps dark to light tones onto a **Shadows** and a **Highlights** colour (click a swatch to pick
  it), with **Reverse**.
- **Grain…** — film grain: Amount, Size and Roughness.
- **Invert** (Ctrl+I) — inverts the layer’s colours (or the selected mask).
- **Canvas Size…** (Ctrl+Alt+C) — new width and height in pixels, percent, inches or centimetres, optionally relative
  to the current size or with the aspect locked; the **anchor** grid chooses which point stays fixed; **Canvas
  extension** fills new space (transparent, foreground, background, black, white or a custom colour). Nothing is
  scaled.
- **Image Size…** (Ctrl+Alt+I) — resamples every layer to a new size (with the chosen sampling), or with **Resample**
  off, changes only the print resolution.
- **Flip Canvas Horizontal / Vertical**.

All adjustments preview live, apply to the selection only when there is one, and are single undo steps.

### Filter menu

- **Gaussian Blur…** — Radius 0.1–250 px. The blur spreads past the layer’s edges.
- **Motion Blur…** — Angle and Distance (up to 2,000 px).
- **Add Noise…** — Amount, Uniform or Gaussian, Monochromatic.
- **Lens Correction…** — Remove Distortion: positive straightens barrel distortion, negative pincushion.
- **Remove Background…** — finds the main subject and hides the background with a layer mask, so nothing is deleted
  and you can paint the background back. **Basic** uses the model’s mask as it is; **Advanced** adds **Refine** (pull
  the mask onto the image’s own edges — hair and fur), **Contrast** (clear semi-transparent haze) and **Shift Edge**
  (shrink or grow the mask to drop a coloured rim). It runs on the graphics card where WebGPU is available (a second
  or two), otherwise on the processor (from several seconds to about a minute, depending on the computer). Copies of
  the app that weren’t installed with the model download it once (about 170 MB); the panel shows the progress.

## Keyboard shortcuts

**Help → Keyboard Shortcuts** (F1) shows these in the app.

| Mac | Windows | Action |
| --- | --- | --- |
| ⌘N / ⌘O / ⌘S / ⇧⌘S / ⌘W | Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S / Ctrl+W | New, Open, Save, Save As, Close |
| ⇧⌘E / ⇧⌥⌘S | Ctrl+Shift+E / Ctrl+Alt+Shift+S | Export PNG / JPEG |
| ⌘Z / ⇧⌘Z | Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) | Undo / Redo |
| ⌘X ⌘C ⇧⌘C ⌘V | Ctrl+X Ctrl+C Ctrl+Shift+C Ctrl+V | Cut, Copy, Copy Merged, Paste |
| ⌥⌫ / ⌘⌫ / ⇧⌫ | Alt+Backspace / Ctrl+Backspace / Shift+Backspace | Fill foreground / background, Content-Aware Fill |
| ⌘A / ⌘D / ⇧⌘I | Ctrl+A / Ctrl+D / Ctrl+Shift+I | Select all, deselect, inverse |
| ⌘M ⌘L ⌘U ⌘I | Ctrl+M Ctrl+L Ctrl+U Ctrl+I | Curves, Levels, Hue/Saturation, Invert |
| ⌥⌘C / ⌥⌘I | Ctrl+Alt+C / Ctrl+Alt+I | Canvas Size / Image Size |
| ⌘T ⌘J ⌘G ⌥⌘G ⌘E | Ctrl+T Ctrl+J Ctrl+G Ctrl+Alt+G Ctrl+E | Transform, Layer via Copy/Duplicate, Group, Clipping Mask, Merge |
| ⇧⌘N / ⌘] / ⌘[ | Ctrl+Shift+N / Ctrl+] / Ctrl+[ | New layer, move layer up / down |
| ⌘0 ⌘1 ⌘= ⌘− ⌘H | Ctrl+0 Ctrl+1 Ctrl+= Ctrl+- Ctrl+H | Fit, 100%, zoom in/out, transform controls |
| — | F11 / F1 / Alt+letter | Full screen / shortcuts / open a menu (Alt+F File, Alt+E Edit…) |
| V M L W C B E J S R G U I H Z A | same | Tools |
| [ ] ⇧[ ⇧] 1–0 X D | same | Brush size, hardness, opacity; swap and reset colours |
| Space, ⌥-click, ⌘-drag | Space, Alt-click, Ctrl-drag | Pan; tool variants as described above |

## Differences from the Mac app

- **Keys:** Ctrl for ⌘ and Alt for ⌥. The Mac’s Control-drag (move without snapping) is Ctrl pressed during the drag.
- **Menus** are in the window’s title bar instead of the macOS menu bar. There is also View → Full Screen,
  Help → Keyboard Shortcuts, and File → Open/Save As Mac Project Folder.
- **Project files:** on Windows a `.comp` project is a single file (a ZIP of the same manifest and images the Mac app
  keeps in its project folder), so it can be double-clicked, emailed and synced like any document. The Mac app opens
  folder projects only: use **Save As Mac Project Folder…** for a project you want to open on a Mac, and **Open Mac
  Project Folder…** (or drag the folder in) for one made on a Mac. See [docs/project-format.md](../docs/project-format.md).
- **Remove Background** uses the open-source ISNet model instead of Apple’s Vision framework, so its masks differ a
  little from the Mac’s.
- **Updates** come from this repository’s GitHub releases instead of the Mac’s Sparkle feed.
- **Extras on Windows:** the middle mouse button pans; the Transform bar scrolls with the wheel when the window is
  narrow; **Help → Keyboard Shortcuts**.

## Troubleshooting

- **“Compositor needs WebGL 2”** — update your graphics driver. As a fallback, start it with software rendering:
  set the environment variable `COMPOSITOR_SOFTWARE_GL=1` (for example `set COMPOSITOR_SOFTWARE_GL=1` then run the
  `.exe` from the same Command Prompt). It is slower, but works everywhere.
- **SmartScreen warning** — the builds aren’t signed; choose **More info → Run anyway**.
- **“Error opening file for writing: …\Uninstall Compositor.exe”** while installing — installers built before
  this check was added show this when **Only for me** is chosen with a folder that needs administrator rights, such
  as `D:\Program Files`. Click **Abort**, run the installer again, and either keep the suggested folder or choose
  **Anyone who uses this computer**. Current installers check the folder first and explain what to do.
- **Remove Background can’t download its model** — the computer needs internet access to GitHub the first time (or
  install with the installer, which carries the model). The model is saved in
  `%APPDATA%\Compositor\models\`.
- **Settings and window position** live in `%APPDATA%\Compositor\`. Deleting that folder resets them.
- **Developer tools** — F12 in a development build (Ctrl+Shift+F12 in an installed one).

## For developers

```
windows/
├── src/main/            Electron main process: window, file dialogs, file access, clipboard, updates, the model
├── src/renderer/
│   ├── model/           Documents, layers, transforms, selections, adjustments (ported from Compositor/Document)
│   ├── raster/          Tiled pixel storage, the brush engine and the CPU pixel kernels (ported from the C kernels)
│   ├── gl/              The WebGL 2 compositor: tiles, blend modes, masks, clipping, adjustments, the canvas view
│   ├── gpu/             The shared GPU service (rendering, blurs, warps, thumbnails)
│   ├── workers/         Web workers running the heavy kernels
│   ├── session/         EditorSession and Workspace: every command and tool, undo, projects (ported from Swift)
│   ├── io/              Image decoding/encoding and the project format
│   ├── ml/              Remove Background (ONNX Runtime)
│   └── ui/              The React interface: menus, bars, canvas input, Layers panel, panels and dialogs
├── tests/unit/          Vitest unit tests
├── tests/e2e/           Playwright tests of the running app
├── scripts/             build (esbuild), icons, model download, screenshots
└── electron-builder.yml Packaging for Windows
```

The Swift sources remain the reference: most TypeScript files name the Swift file they port, and keep its
structure and comments, so a change on one side can be carried to the other.
