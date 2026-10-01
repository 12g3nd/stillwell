# Stillwell

An offline Windows photo editor with photo filters,
clone/spot-heal, painting and local liquify, alongside constrained TIFF/SVG/PSD import,
print size/resolution, borders, PDF export, versions, portable projects and editable layers.
Originals stay immutable. HEIC remains unsupported.

## Install

`npm run installer` builds `release/Stillwell-Setup-<version>.exe`, an unsigned
per-user installer (no administrator rights). It installs to
`%LOCALAPPDATA%\Programs\Stillwell` and adds Start menu and desktop shortcuts;
uninstall from Windows Settings → Apps. Projects live in the local library and are
kept across reinstalls. `npm run package` still produces the portable
`release/win-unpacked/Stillwell.exe` directory build.

## Launch

From a terminal in this folder:

```powershell
npm ci
npm start
```

Node 24.15.0 was used. Installing dependencies requires network access. The running
application uses bundled files and blocks network requests.

## Everyday workflow

1. Open a PNG, JPEG, static WebP/TIFF, geometry SVG or flattened 8-bit RGB PSD,
   drop one onto the workspace, or choose Paste image for PNG/JPEG/WebP clipboard data.
   Import creates a local project with copies of the original and working image.
2. Drag the image or enter X/Y. Scroll to zoom, Space-drag to pan, and use Fit to
   return to the document. Arrow keys nudge one pixel; Shift nudges ten.
3. Choose **Crop & size**. Crop uses a numeric rectangle. Resize image scales the
   composition; Canvas size changes the boundary without scaling. Choose Fit, Fill,
   or Stretch for resizing, a nine-point canvas anchor, or a wallpaper preset.
4. **Preview size**, then **Apply** or **Cancel**. Escape cancels a preview. Switching
   tools/projects and exporting are disabled while a preview needs a decision.
5. Choose PNG, JPEG or WebP in the right panel, then Export. JPEG flattens transparency
   onto the selected matte. All exports require a new filename, preserving existing files.

The grid, guides, selection outlines and checker never export. All operations preserve the original; crop hides
pixels outside its new boundary, so enlarging the canvas can reveal them again.
Image resize scales the editable composition and resamples during rendering.

## Layers and guides

Add images or basic editable text in Layers. Ctrl/Shift-click rows to select multiple
layers; drag rows within the same group to reorder, or use Up/Down. Rename, duplicate,
hide and lock layers. Numeric X/Y coordinates are relative to the parent group;
width/height measure the scaled local axes. Aspect lock preserves their ratio.
Alignment uses canvas bounds for one layer and selection bounds for multiple layers.
Distribution needs three layers and makes equal gaps.

Group sibling layers to preserve an editable tree. Groups composite in isolation:
children blend together first, then group opacity/blend applies once against layers
below. Normal, Multiply and Screen are supported. Ungroup requires 100% group opacity
and Normal blend on the group and its direct children to preserve appearance.
A parent lock protects its descendants.
Select nested children in the panel to edit them; canvas dragging moves root layers
or groups. Other multiselected layers follow the dragged layer when released.

Guide visibility and snapping to grid, guides and layers have independent switches.
Guides persist and follow crop, resize, rotate and flip. Snapping uses a six-screen-pixel
threshold. Typography controls are available from the Text tool or a text layer's
Typography button.

## Cutouts and transparency

Select an image layer, then choose **Cutout**. Rectangle and ellipse selections use
whole image-pixel boundaries. Drag a freehand outline, or click polygon vertices and
choose Finish polygon / Enter. Escape clears the unfinished selection. The colour
wand samples the unmasked working image, with 0–255 tolerance and optional four-way
contiguity. Its colour comparison includes alpha and ignores invisible RGB differences.

The tinted overlay shows the selected area. Choose **Keep selected**, **Remove selected**,
or **Restore selected**; Invert selection chooses the outside instead. Selections are
temporary and clear when switching tools/images or applying an edit; only masks save.
The Remove brush hides pixels, and the Restore brush keeps/reveals them. A stroke is
one undo entry. Brush diameter and feather are in the image's own pixels, independent
of viewport zoom or parent transforms. Feather uses a Gaussian blur; it affects the
next selection/stroke, or choose Feather mask to soften an existing mask.

**Invert mask** swaps kept and hidden coverage. **Restore entire image** resets the
mask without changing source alpha: pixels transparent in the original stay transparent.
Masks are separate immutable PNG blobs; undo switches references. Pixel processing
runs in a cancellable worker, with no network calls. Closing waits for an active edit
and its save. A parent lock also protects the image mask.

Checker/White/Black changes only the inspection backdrop. **Trim transparent edges**
crops the canvas to the visible composition's nonzero alpha, including soft edges;
undo restores the old boundary. A fully transparent composition is left unchanged.
Selections, guides, and inspection backgrounds never enter exports. Use PNG for
verified lossless transparency. There is no automatic subject recognition.

## Typography

Add a text layer, then open **Text**. Double-click a root text layer or use **Edit on
canvas** for any selected text layer, including one inside a group. Done / Ctrl+Enter
commits one undo entry; Escape cancels. Ctrl+A selects text while editing. Ctrl+S
finishes the edit and saves; closing also finishes and saves the draft.

The Text panel provides multiline content, installed font faces with a sample, font
size/colour, bold/italic/underline, word wrapping, line/letter spacing and paragraph
alignment. Background fills follow text lines. Outline and shadow stay editable.
Wrap width is in local text pixels; scaling a layer remains separate. Unbroken words
can extend the wrapping box, and all output is clipped at the document boundary.

**Import font file** copies a local font into immutable project assets. The tested TTF
workflow reopens after the external font file is deleted with identical PNG output.
OTF/WOFF/WOFF2 files are also accepted and validated by Chromium's font loader, but those
formats have not yet been covered by font fixtures. Font imports are limited to 20 MB.
Installed fonts retain their face identity without embedding their bytes. Missing or
invalid faces produce an error; choose a replacement or import the required file.
No fonts are installed globally or downloaded.

Favourite fonts and up to 30 named text styles are saved in the project. A style
includes font and appearance settings; applying it preserves the receiving layer's
content, ID and placement. Imported fonts referenced only by a style/favourite are
still retained. Use **Local shelf** to reuse an image/cutout or the selected text's style
in other projects. Text styles preserve the receiving layer's content. The shelf holds
30 items; Remove archives its local copy without changing projects that use it.

**Curve & warp** bends the whole paragraph into an upward/downward arch, a wave or
a bulge/pinch. Curve and warp can be combined; signed amounts range from -100 to 100.
These are paragraph deformations, not circular text or an arbitrary path editor.
Content, fonts and parameters remain editable in **Text content** and saved styles.
Ctrl+S or closing the window finishes a pending Text content draft before saving.
Reset curve and warp restores direct on-canvas editing. Undo restores either shape.
Font layout and effects use Fabric; a local background worker deforms the derived
pixels. The bitmap is regenerated from editable text, never saved as the text layer.
Rendering is at document resolution; enlarging a shaped layer can soften edges.
Padding protects effects and group edges; the document boundary still clips exports.

Typography is uniform per layer; rich text runs,
variable-font axes and advanced shaping controls are not implemented. Automated text
fixtures cover Latin multiline layouts, not every writing system or glyph fallback.

## Saving and returning

Committed changes autosave after a short idle delay. The status says **Unsaved**,
**Saving**, **Saved**, or **Save failed** based on the completed disk operation.
Ctrl+S flushes a save immediately. A failed save shows Retry and blocks switching or
closing until the pending committed changes can be written. Closing flushes pending
edits; an unapplied size preview prompts before it is discarded.

Use **Projects** or the opening screen to reopen saved work after restart. **Reveal
library** opens the app-owned `projects` folder under its Windows user-data directory.
The library does not depend on the external source file remaining in place.

Undo/redo keeps up to 50 document states in the current session; Ctrl+Z / Ctrl+Y work
outside input fields. Named checkpoints persist across restarts. Restoring one keeps
the current state as a new "Before restore" checkpoint, then creates a new revision.

**Versions** includes thumbnails and the 12 latest rolling autosaved versions. Paging
keeps the list manageable. Named versions remain available; restoring never deletes
later revisions. Rolling cleanup removes only old index entries, not image/revision
bytes. Local autosave is not a backup; full storage pruning remains later work.

**Open/Export portable project**, in Projects or Versions, uses a local `.stillwell` file.
Earlier `.sjphoto` archives remain readable. Existing pre-release libraries are reused
when present. The archive includes current state, checkpoints, originals, masks and imported fonts, with binary
assets separate from metadata. Move that file anywhere and open an independent local
copy. Installed fonts must still be available on the receiving machine. The global
shelf and unindexed revisions are not included. Limits: 512 MB, 100 checkpoints and
512 unique assets. Damaged/incomplete containers are rejected before import writes.

## Photo adjustments

Select an image and choose **Adjustments**. Exposure, brightness, contrast, saturation,
temperature/tint and sharpening operate on that image. **Levels & tone curve** adds
black/white points, gamma and output controls at 25/50/75% input. Exposure uses linear
light; temperature/tint are relative colour shifts, not Kelvin calibration.

Choose **Preview adjustments**, compare **Show before/after**, then **Apply adjustments**
or **Cancel adjustments**. Preview cannot export or change a saved version. Apply is one
undo step and preserves original bytes, placement and the cutout mask. These are applied
raster changes rather than adjustment layers; use a checkpoint before experimenting.

## Print and compatibility

Choose **Print settings** for PPI, an inside border and PDF export. Apply print
settings before exporting. Changing PPI changes physical size without changing the
pixels. **Resize to a physical size** explicitly fits the editable composition to
the entered millimetres at the chosen PPI. Borders cover the inside edge, stay
editable, and appear in every export; zero removes them.

PDF keeps ordinary ungrouped text and the border as vectors. Groups, blending,
shadows and shaped text use a clearly labelled raster fallback for the artwork.
Print at actual size / 100%. PDFs are sRGB; printer/CMYK proofing is not implemented.

SVG and PSD open as image layers, with a persistent note explaining flattening.
SVG accepts geometry only and rejects external resources. TIFF must have one page.
HEIC is not enabled; convert a copy to a supported format while keeping the original.
PSD support is limited to flattened 8-bit RGB composites; Photoshop layers are not
preserved. SVG imports rasterize supported geometry.

## Filters, retouch, drawing and liquify

**Filters** offers black-and-white, sepia, Gaussian blur, pixelate and vignette with
an amount control. Blur and pixelate also have a size control. Preview, compare
before/after, then Apply or Cancel. Each application is one undo step; alpha and
cutout masks remain intact. Settings are temporary drafts, not adjustment layers.

**Retouch → Clone**: select an image, choose Pick clone source, click the source,
then paint the destination. Every new stroke starts at the picked source; it does
not use an aligned source across strokes. Sampling reads the pre-stroke image,
preventing feedback smears. Retouch preserves destination alpha and any cutout mask.
**Spot heal** uses one click and nearby texture to repair small blemishes. It does
not remove large objects or infer a scene; reduce the brush or use Clone when nearby
texture cannot fit. It needs a sufficiently opaque nearby source.

**Draw → New paint layer** adds a separate transparent raster layer. Choose colour,
size, hardness and opacity, then paint. You can also paint on a selected existing
image. The new layer can be moved, transformed, hidden, duplicated and saved like
other image layers. Use Cutout's remove/restore brush for reversible erasing.
Strokes are raster pixels, not editable vector paths; undo is available per stroke.

**Liquify** deforms the selected image and its cutout mask together. Push follows
a drag; Pinch and Expand reshape a local region. The sampled pixels appear after
release; the stroke overlay is only a placement guide. Each stroke is one undo step.
Make a named version before experimenting. Repeated deformations resample pixels
and can soften detail; Undo restores exact prior assets.

Brush size is 1–256 image pixels, independent of viewport zoom. Hardness controls
edge softness; opacity/strength ranges from 1–100%. Only a visible, unlocked image
with visible/unlocked parents can be targeted through the panel. Text stays editable
and is not rasterized by these tools. Escape cancels an unfinished stroke; a running
brush job also has Cancel. Jobs time out at 60 seconds, and long strokes reject
instead of committing only a prefix. Source images are never overwritten.

These are mouse/keyboard tools. Pen pressure, vector drawing, cross-layer clone,
content-aware healing and mesh/freeze/reconstruct liquify are not implemented.
Stillwell opens in a dark theme; the sun/moon button in the header switches to the
light theme and the choice is remembered on this computer. Each tool has its own
colour on the rail and in its panel. `npm run icons` regenerates the app icon from
`build/icon.svg`.

## Verify / build

```powershell
npm run typecheck
npm test
npm run package
$env:PHOTO_PACKAGED=(Resolve-Path 'release/win-unpacked/Stillwell.exe').Path
node node_modules/playwright/cli.js test -g 'daily workflow|save failure|drop and clipboard|native import|1920|hidden layer workflow|hidden multiselect|hidden cutout|hidden typography:|hidden Gate 5|hidden Gate 6|hidden Gate 7'
Remove-Item Env:PHOTO_PACKAGED
```

Tests use synthetic fixtures and isolated temporary profiles. `PHOTO_EDITOR_DATA` is
a startup-only profile override for test runs, not a renderer filesystem capability.
Native dialog selections and clipboard reads are stubbed in automation; the user's
clipboard and photographs are not inspected or changed. Tests set PHOTO_EDITOR_HIDDEN=1
for offscreen windows, suppressed native dialogs and hidden interaction. DPI checks
use emulated device metrics; physical monitor scaling is unverified.

Verification covers synthetic fixtures; manual visual quality, tablet input and physical
print accuracy remain unverified.

## Boundaries

Maximum 24 MP, 12,000 pixels per side and 128 MB per imported file. Working pixels are
8-bit sRGB. Full-size composition remains in Chromium; Sharp decoding/orientation and
encoding run in worker threads. A synthetic 24 MP workflow is benchmarked, with a
brief large-image renderer hitch; 30 maximum-size layers and abrupt machine power-loss
recovery remain unverified. The current gallery is a simple project list;
Versions includes thumbnails. The bounded
layer tree supports 30 total nodes, eight groups and four levels of group nesting.
Cutout paths are bounded to 4,096 sampled points; longer gestures should be split into
multiple strokes. Feather is limited to 100 image pixels, brush diameter to 1,000.
Selections operate on one image at a time. Combined add/subtract selections, pressure
sensitivity, semantic cutouts and a separate mask-only view are not implemented.
