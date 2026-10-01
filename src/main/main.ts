import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  clipboard,
  shell,
} from "electron";
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, basename, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashBytes, references } from "./project";
import { Library } from "./library";
import { printPdf } from "./print";
import { filterSchema, type PhotoFilter } from "../editor/model/filters";
import { strokeSchema } from "../editor/model/strokes";
import { pack, importPortable, PORTABLE_LIMIT } from "./portable";
import {
  adjustmentSchema,
  type Adjustments,
} from "../editor/model/adjustments";
import { locate, isLocked } from "../editor/commands/layers";
import {
  selectionSchema,
  maskEditSchema,
  type MaskBitmap,
  type TrimBounds,
} from "../editor/model/mask";
import {
  documentSchema,
  MAX_PIXELS,
  type ImportResult,
  type ExportOptions,
} from "../editor/model/document";
let win: BrowserWindow, worker: Worker;
let active: ImportResult | undefined;
// Selection previews are transient and bounded to one image; only applied masks
// become project assets and participate in undo/history.
let activeSelection:
  { projectId: string; layerId: string; bitmap: MaskBitmap } | undefined;
let dirtyVersion = 0,
  savedVersion = 0,
  allowClose = false,
  pending = 0;
let previewActive = false;
let textEditingActive = false,
  operationActive = false;
let cancelMaskJob: (() => void) | undefined;
let cancelStroke: (() => void) | undefined;
function strokeJob(payload: object): Promise<{
  bytes: Uint8Array;
  mask?: Uint8Array;
  width: number;
  height: number;
}> {
  return new Promise((res, rej) => {
    const job = new Worker(join(__dirname, "strokes.cjs")),
      id = randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      cancelStroke = undefined;
      job.removeAllListeners();
      void job.terminate();
    };
    const fail = (e: Error) => {
      cleanup();
      rej(e);
    };
    const timer = setTimeout(
      () => fail(Error("Brush operation timed out")),
      60000,
    );
    cancelStroke = () => fail(Error("Brush operation cancelled"));
    job.once("error", fail);
    job.once("exit", () => fail(Error("Brush worker stopped")));
    job.once("message", (message) => {
      cleanup();
      message.error ? rej(Error(message.error)) : res(message.result);
    });
    job.postMessage({ id, ...payload });
  });
}
function maskJob<T>(payload: object): Promise<T> {
  return new Promise((resolveJob, reject) => {
    const job = new Worker(join(__dirname, "mask.cjs")),
      id = randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      cancelMaskJob = undefined;
      job.removeAllListeners();
      void job.terminate();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(Error("Mask operation timed out")),
      60000,
    );
    cancelMaskJob = () => fail(Error("Mask operation cancelled"));
    job.once("error", fail);
    job.once("exit", () => fail(Error("Mask worker stopped unexpectedly")));
    job.on("message", (message) => {
      if (message.id !== id) return;
      cleanup();
      message.error ? reject(Error(message.error)) : resolveJob(message.result);
    });
    job.postMessage({ id, ...payload });
  });
}
let queue: Promise<unknown> = Promise.resolve();
const sources = new Set<string>();
const hiddenTesting = process.env.PHOTO_EDITOR_HIDDEN === "1";
const exportSchema = z.object({
  dpi: z.number().int().min(36).max(1200).optional(),
  format: z.enum(["png", "jpeg", "webp"]),
  quality: z.number().int().min(1).max(100),
  matte: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
const versionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
function raster(
  kind: string,
  bytes: Uint8Array,
  width?: number,
  height?: number,
  options?: ExportOptions | Adjustments | PhotoFilter,
): Promise<{
  bytes: Uint8Array;
  width: number;
  height: number;
  warning?: string;
}> {
  return new Promise((res, rej) => {
    worker = new Worker(join(__dirname, "raster.cjs"));
    const job = worker,
      id = randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      job.removeAllListeners();
      void job.terminate();
    };
    const timer = setTimeout(() => {
      cleanup();
      rej(Error("Image processing timed out"));
    }, 60000);
    job.once("error", (e) => {
      cleanup();
      rej(e);
    });
    job.once("exit", () => {
      cleanup();
      rej(Error("Image worker stopped unexpectedly"));
    });
    job.on("message", (msg) => {
      if (msg.id !== id) return;
      cleanup();
      msg.error ? rej(Error(msg.error)) : res(msg.result);
    });
    job.postMessage({ id, kind, bytes, width, height, options });
  });
}
app.setName("Stillwell");
// Keep existing pre-release libraries discoverable after the product rename.
const legacyProfile = ["Personal Photo Editor", "personal-photo-editor"]
  .map((name) => join(app.getPath("appData"), name))
  .find((path) => existsSync(join(path, "projects")));
if (legacyProfile) app.setPath("userData", legacyProfile);
// A startup-only profile override keeps automated fixtures outside the user's library.
if (process.env.PHOTO_EDITOR_DATA)
  app.setPath("userData", resolve(process.env.PHOTO_EDITOR_DATA));
const ownsLibrary = app.requestSingleInstanceLock();
if (!ownsLibrary) app.quit();
app.on("second-instance", () => {
  if (win && !hiddenTesting) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.whenReady().then(() => {
  if (!ownsLibrary) return;
  const library = new Library(join(app.getPath("userData"), "projects"));
  const shelf = new Library(join(app.getPath("userData"), "shelf"));
  const url = pathToFileURL(join(__dirname, "index.html")).href;
  session.defaultSession.webRequest.onBeforeRequest((details, cb) =>
    cb({
      cancel:
        !details.url.startsWith(pathToFileURL(__dirname).href + "/") &&
        !details.url.startsWith("blob:"),
    }),
  );
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission) =>
      permission === "local-fonts" &&
      contents === win?.webContents &&
      contents.getURL() === url,
  );
  session.defaultSession.setPermissionRequestHandler(
    (contents, permission, cb) =>
      cb(
        permission === "local-fonts" &&
          contents === win?.webContents &&
          contents.getURL() === url,
      ),
  );
  win = new BrowserWindow({
    show: !hiddenTesting,
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#E7E7E7",
    title: "Stillwell",
    webPreferences: {
      offscreen: hiddenTesting,
      backgroundThrottling: !hiddenTesting,
      preload: join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (hiddenTesting) {
    // Test mode never creates native dialogs or a visible window, even before mocks attach.
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
    win.webContents.setFrameRate(30);
  }
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  const trusted = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    e.sender === win.webContents &&
    e.senderFrame === win.webContents.mainFrame &&
    e.senderFrame.url === url;
  const handle = (name: string, fn: (...args: any[]) => Promise<any>) =>
    ipcMain.handle(name, (e, ...args) => {
      if (!trusted(e)) throw Error("Untrusted request");
      pending++;
      const task = queue.then(() => fn(...args));
      queue = task.catch(() => {});
      return task.finally(() => pending--);
    });
  const requireActive = () => {
    if (!active) throw Error("Open a project first");
    return active;
  };
  const ensureSaved = () => {
    if (dirtyVersion > savedVersion)
      throw Error("Save the current changes before switching projects");
  };
  handle("font:import", async () => {
    ensureSaved();
    const current = requireActive();
    const picked = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [
        { name: "Local font", extensions: ["ttf", "otf", "woff", "woff2"] },
      ],
    });
    if (picked.canceled) return null;
    const path = picked.filePaths[0];
    if ((await stat(path)).size > 20 * 1024 * 1024)
      throw Error("Font exceeds 20 MB");
    const bytes = await readFile(path);
    const signature = bytes.subarray(0, 4).toString("latin1");
    if (
      bytes.length < 12 ||
      !["\u0000\u0001\u0000\u0000", "OTTO", "wOFF", "wOF2"].includes(signature)
    )
      throw Error("Choose a TTF, OTF, WOFF or WOFF2 font");
    const hash = hashBytes(bytes);
    current.assets[hash] = bytes;
    sources.add(resolve(path).toLowerCase());
    return {
      font: {
        fontFamily: basename(path)
          .replace(/\.[^.]+$/, "")
          .slice(0, 120),
        fontAsset: hash,
      },
      bytes,
    };
  });
  const adopt = (result: ImportResult) => {
    active = result;
    activeSelection = undefined;
    dirtyVersion = savedVersion = 0;
    return result;
  };
  const maskTarget = (id: unknown) => {
    ensureSaved();
    const current = requireActive();
    const found = locate(current.document, z.string().max(80).parse(id));
    if (!found || found.layer.kind !== "raster")
      throw Error("Select one image layer");
    if (isLocked(current.document, found.layer.id))
      throw Error("Unlock the image and its parent groups first");
    return { current, layer: found.layer };
  };
  const registerMask = (
    current: ImportResult,
    result: Omit<MaskBitmap, "hash">,
  ): MaskBitmap => {
    const hash = hashBytes(result.bytes);
    current.assets[hash] = result.bytes;
    return { ...result, hash };
  };
  handle("mask:selection", async (id: unknown, input: unknown) => {
    const { current, layer } = maskTarget(id);
    const selection = selectionSchema.parse(input);
    const result = await maskJob<Omit<MaskBitmap, "hash">>({
      kind: "selection",
      source: current.assets[layer.asset],
      input: selection,
    });
    const bitmap = { ...result, hash: hashBytes(result.bytes) };
    activeSelection = {
      projectId: current.document.id,
      layerId: layer.id,
      bitmap,
    };
    return bitmap;
  });
  handle("mask:edit", async (id: unknown, input: unknown) => {
    const { current, layer } = maskTarget(id),
      edit = maskEditSchema.parse(input);
    if (
      edit.selection &&
      (activeSelection?.bitmap.hash !== edit.selection ||
        activeSelection.projectId !== current.document.id ||
        activeSelection.layerId !== layer.id)
    )
      throw Error("Unknown selection");
    return registerMask(
      current,
      await maskJob<Omit<MaskBitmap, "hash">>({
        kind: "edit",
        source: current.assets[layer.asset],
        mask: layer.mask ? current.assets[layer.mask] : undefined,
        selection: edit.selection ? activeSelection!.bitmap.bytes : undefined,
        input: edit,
      }),
    );
  });
  handle("mask:trim", async (bytes: unknown) => {
    ensureSaved();
    if (!(bytes instanceof Uint8Array) || bytes.length > 128 * 1024 * 1024)
      throw Error("Invalid trim image");
    requireActive();
    return maskJob<TrimBounds | null>({ kind: "trim", source: bytes });
  });
  ipcMain.on("mask:cancel", (e) => {
    if (trusted(e)) cancelMaskJob?.();
  });
  async function importImage(original: Uint8Array, name: string) {
    ensureSaved();
    if (original.length > 128 * 1024 * 1024)
      throw Error("File exceeds 128 MB limit");
    const image = await raster("import", original);
    const originalId = hashBytes(original),
      asset = hashBytes(image.bytes);
    const document = documentSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      name: name.slice(0, 200),
      importNote: image.warning,
      width: image.width,
      height: image.height,
      colourSpace: "srgb",
      layers: [
        {
          id: randomUUID(),
          name: name.slice(0, 200),
          kind: "raster",
          visible: true,
          opacity: 1,
          original: originalId,
          asset,
          transform: [1, 0, 0, 1, 0, 0],
        },
      ],
    });
    const result = {
      document,
      assets: { [originalId]: original, [asset]: image.bytes },
    };
    await library.save(document, result.assets);
    return adopt(result);
  }
  handle("image:open", async () => {
    ensureSaved();
    const pick = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [
        {
          name: "Photos",
          extensions: [
            "png",
            "jpg",
            "jpeg",
            "webp",
            "tif",
            "tiff",
            "svg",
            "psd",
          ],
        },
      ],
    });
    if (pick.canceled) return null;
    const path = pick.filePaths[0];
    if ((await stat(path)).size > 128 * 1024 * 1024)
      throw Error("File exceeds 128 MB limit");
    const result = await importImage(await readFile(path), basename(path));
    sources.add(resolve(path).toLowerCase());
    return result;
  });
  handle("image:add", async () => {
    ensureSaved();
    const current = requireActive();
    const pick = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [
        {
          name: "Photos",
          extensions: [
            "png",
            "jpg",
            "jpeg",
            "webp",
            "tif",
            "tiff",
            "svg",
            "psd",
          ],
        },
      ],
    });
    if (pick.canceled) return null;
    const path = pick.filePaths[0];
    if ((await stat(path)).size > 128 * 1024 * 1024)
      throw Error("File exceeds 128 MB limit");
    const original = await readFile(path),
      image = await raster("import", original),
      originalId = hashBytes(original),
      asset = hashBytes(image.bytes);
    const document = documentSchema.parse({
      ...current.document,
      schemaVersion: 2,
      importNote: image.warning ?? current.document.importNote,
      layers: [
        ...current.document.layers,
        {
          kind: "raster",
          id: randomUUID(),
          name: basename(path).slice(0, 200),
          visible: true,
          opacity: 1,
          transform: [1, 0, 0, 1, 0, 0],
          original: originalId,
          asset,
        },
      ],
    });
    const result = {
      document,
      assets: {
        ...current.assets,
        [originalId]: original,
        [asset]: image.bytes,
      },
    };
    await library.save(document, result.assets);
    active = result;
    sources.add(resolve(path).toLowerCase());
    return result;
  });
  handle("image:bytes", async (bytes: unknown, name: unknown) => {
    if (
      !(bytes instanceof Uint8Array) ||
      typeof name !== "string" ||
      name.length > 200
    )
      throw Error("Invalid image input");
    return importImage(bytes, name || "Dropped photo");
  });
  handle("image:paste", async () => {
    ensureSaved();
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) =>
        ["image/png", "image/jpeg", "image/webp"].includes(t),
      );
      if (!type) continue;
      const blob = await item.getType(type as "image/png");
      if (blob.size > 128 * 1024 * 1024)
        throw Error("Clipboard image exceeds 128 MB");
      return importImage(
        new Uint8Array(await blob.arrayBuffer()),
        "Pasted photo",
      );
    }
    return null;
  });
  handle("project:recent", () => library.recent());
  handle("project:checkpoint-preview", (id: unknown) =>
    library.preview(requireActive().document.id, z.string().uuid().parse(id)),
  );
  handle("image:adjust", async (id: unknown, settings: unknown) => {
    const { current, layer } = maskTarget(id);
    const result = await raster(
      "adjust",
      current.assets[layer.asset],
      undefined,
      undefined,
      adjustmentSchema.parse(settings),
    );
    const hash = hashBytes(result.bytes);
    current.assets[hash] = result.bytes;
    return { hash, bytes: result.bytes };
  });
  handle("image:filter", async (id: unknown, settings: unknown) => {
    const { current, layer } = maskTarget(id);
    const result = await raster(
      "filter",
      current.assets[layer.asset],
      undefined,
      undefined,
      filterSchema.parse(settings),
    );
    return registerMask(current, result);
  });
  handle("image:stroke", async (id: unknown, input: unknown) => {
    const { current, layer } = maskTarget(id),
      settings = strokeSchema.parse(input);
    const result = await strokeJob({
      bytes: current.assets[layer.asset],
      mask:
        layer.mask && ["push", "pinch", "expand"].includes(settings.kind)
          ? current.assets[layer.mask]
          : undefined,
      input: settings,
    });
    const bitmap = registerMask(current, result);
    const maskHash = result.mask ? hashBytes(result.mask) : undefined;
    if (maskHash && result.mask) current.assets[maskHash] = result.mask;
    return { ...bitmap, maskHash, mask: result.mask };
  });
  handle("image:paint-layer", async () => {
    ensureSaved();
    const current = requireActive();
    if (current.document.layers.length >= 30)
      throw Error("Layer limit reached");
    return registerMask(
      current,
      await strokeJob({
        input: "blank",
        width: current.document.width,
        height: current.document.height,
      }),
    );
  });
  ipcMain.on("image:cancel-stroke", (e) => {
    if (trusted(e)) cancelStroke?.();
  });
  handle("shelf:list", () => shelf.recent());
  handle("shelf:remove", (id: unknown) =>
    shelf.archive(z.string().uuid().parse(id)),
  );
  handle("shelf:save", async (id: unknown, name: unknown) => {
    ensureSaved();
    const current = requireActive();
    const layer = locate(current.document, z.string().parse(id))?.layer;
    if (!layer || layer.kind === "group")
      throw Error("Select an image or text layer for the shelf.");
    if ((await shelf.recent()).length >= 30)
      throw Error("The shelf holds up to 30 items.");
    const document = documentSchema.parse({
      ...current.document,
      id: randomUUID(),
      name: z.string().trim().min(1).max(80).parse(name),
      guides: [],
      fontFavourites: [],
      textPresets: [],
      layers: [
        {
          ...layer,
          transform: [1, 0, 0, 1, 40, 40],
          visible: true,
          locked: false,
        },
      ],
    });
    await shelf.save(document, current.assets, false);
  });
  handle("shelf:load", async (id: unknown) => {
    ensureSaved();
    const result = await shelf.load(z.string().uuid().parse(id));
    Object.assign(requireActive().assets, result.assets);
    return result;
  });
  handle("project:portable-export", async () => {
    ensureSaved();
    const bytes = await pack(library, requireActive().document.id);
    const pick = await dialog.showSaveDialog(win, {
      defaultPath: "project.stillwell",
      filters: [
        { name: "Stillwell project", extensions: ["stillwell", "sjphoto"] },
      ],
    });
    if (pick.canceled || !pick.filePath) return false;
    const output = resolve(pick.filePath).toLowerCase(),
      root = resolve(app.getPath("userData")).toLowerCase();
    if (sources.has(output) || output === root || output.startsWith(root + sep))
      throw Error(
        "Choose a new file outside the project library and imported sources.",
      );
    await writeFile(pick.filePath, bytes, { flag: "wx" });
    return true;
  });
  handle("project:portable-open", async () => {
    ensureSaved();
    const pick = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [
        { name: "Stillwell project", extensions: ["stillwell", "sjphoto"] },
      ],
    });
    if (pick.canceled) return null;
    const path = pick.filePaths[0];
    if ((await stat(path)).size > PORTABLE_LIMIT)
      throw Error("Portable project exceeds the 512 MB limit.");
    const result = await importPortable(
      library,
      await readFile(path),
      (bytes) => raster("import", bytes),
    );
    sources.add(resolve(path).toLowerCase());
    return adopt(result);
  });
  handle("project:load", async (id: unknown) => {
    ensureSaved();
    const result = await library.load(z.string().uuid().parse(id));
    adopt(result);
    return result;
  });
  handle("project:save", async (input: unknown, version: unknown) => {
    const current = requireActive(),
      doc = documentSchema.parse(input),
      v = versionSchema.parse(version);
    if (doc.id !== current.document.id)
      throw Error("Project identity mismatch");
    if (v < savedVersion) throw Error("Stale save request");
    for (const hash of references(doc))
      if (!current.assets[hash]) throw Error("Unknown image asset");
    await library.save(doc, current.assets);
    active = { ...current, document: doc };
    savedVersion = v;
  });
  handle("project:checkpoint", async (name: unknown) => {
    ensureSaved();
    await library.checkpoint(
      requireActive().document.id,
      z.string().trim().min(1).max(80).parse(name),
    );
  });
  handle("project:checkpoints", () =>
    library.checkpoints(requireActive().document.id),
  );
  handle("project:restore", async (id: unknown) => {
    ensureSaved();
    const current = requireActive();
    await library.checkpoint(
      current.document.id,
      "Before restore " + new Date().toLocaleString(),
    );
    return adopt(
      await library.restore(current.document.id, z.string().uuid().parse(id)),
    );
  });
  handle("project:reveal", async () => {
    if (hiddenTesting)
      throw Error("Explorer is disabled during hidden verification");
    await library.recent();
    const error = await shell.openPath(library.root);
    if (error) throw Error(error);
  });
  ipcMain.on("project:dirty", (e, version) => {
    if (trusted(e) && active && versionSchema.safeParse(version).success)
      dirtyVersion = Math.max(dirtyVersion, version);
  });
  win.on("close", (e) => {
    if (!allowClose && previewActive) {
      e.preventDefault();
      void dialog
        .showMessageBox(win, {
          type: "question",
          message: "Discard the size preview and close?",
          detail:
            "Your applied edits will be saved. The unapplied preview will be discarded.",
          buttons: ["Keep editing", "Discard preview and close"],
          defaultId: 0,
          cancelId: 0,
        })
        .then((result) => {
          if (result.response === 1) {
            previewActive = false;
            win.webContents.send("app:closing");
          }
        });
      return;
    }
    if (
      !allowClose &&
      (dirtyVersion > savedVersion ||
        pending ||
        textEditingActive ||
        operationActive)
    ) {
      e.preventDefault();
      win.webContents.send("app:closing");
    }
  });
  ipcMain.on("app:close-ready", (e) => {
    if (trusted(e))
      void queue.then(() => {
        if (dirtyVersion <= savedVersion) {
          allowClose = true;
          win.close();
        }
      });
  });
  ipcMain.on("project:preview", (e, value) => {
    if (trusted(e) && typeof value === "boolean") previewActive = value;
  });
  ipcMain.on("project:text-editing", (e, value) => {
    if (trusted(e) && typeof value === "boolean") textEditingActive = value;
  });
  ipcMain.on("project:operation", (e, value) => {
    if (trusted(e) && typeof value === "boolean") operationActive = value;
  });
  handle("image:pdf", async (svg: unknown) => {
    ensureSaved();
    const result = await printPdf(svg, requireActive().document);
    const pick = await dialog.showSaveDialog(win, {
      defaultPath: "photo-print.pdf",
      filters: [{ name: "Print PDF", extensions: ["pdf"] }],
    });
    if (pick.canceled || !pick.filePath) return false;
    const output = resolve(pick.filePath).toLowerCase(),
      protectedRoot = resolve(app.getPath("userData")).toLowerCase();
    if (
      sources.has(output) ||
      output === protectedRoot ||
      output.startsWith(protectedRoot + sep)
    )
      throw Error(
        "Choose a new file outside imported sources and the project library",
      );
    await writeFile(pick.filePath, result, { flag: "wx" });
    return true;
  });
  handle(
    "image:export",
    async (
      bytes: unknown,
      width: unknown,
      height: unknown,
      inputOptions: unknown = { format: "png", quality: 92, matte: "#ffffff" },
    ) => {
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.length > 128 * 1024 * 1024 ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        (width as number) < 1 ||
        (height as number) < 1 ||
        (width as number) > 12000 ||
        (height as number) > 12000 ||
        (width as number) * (height as number) > MAX_PIXELS
      )
        throw Error("Invalid export");
      const options = exportSchema.parse(inputOptions);
      const result = await raster(
        "export",
        bytes,
        width as number,
        height as number,
        options,
      );
      const extension = options.format === "jpeg" ? "jpg" : options.format;
      const pick = await dialog.showSaveDialog(win, {
        defaultPath: "photo-export." + extension,
        filters: [
          {
            name: options.format.toUpperCase() + " image",
            extensions: [extension],
          },
        ],
      });
      if (pick.canceled || !pick.filePath) return false;
      const output = resolve(pick.filePath).toLowerCase();
      if (sources.has(output))
        throw Error(
          "Choose a new file. Imported originals cannot be overwritten.",
        );
      if (
        output === library.root.toLowerCase() ||
        output.startsWith(library.root.toLowerCase() + sep)
      )
        throw Error("Export outside the project library");
      await writeFile(pick.filePath, result.bytes, { flag: "wx" }).catch(
        (e) => {
          if (e.code === "EEXIST")
            throw Error("That file already exists. Choose a new export name.");
          throw e;
        },
      );
      return true;
    },
  );
  win.loadURL(url);
});
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  void worker?.terminate();
  cancelMaskJob?.();
  cancelStroke?.();
});
