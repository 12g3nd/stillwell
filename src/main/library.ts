import {
  mkdir,
  readFile,
  readdir,
  rename,
  open,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  documentSchema,
  type PhotoDocument,
  type ImportResult,
} from "../editor/model/document";
import { hashBytes, references } from "./project";

const uuid = z.string().uuid();
const headSchema = z.object({ revision: uuid, updated: z.string() });
const checkpointSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(80),
  revision: uuid,
  created: z.string(),
  kind: z.enum(["named", "rolling"]).optional(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type Recent = {
  id: string;
  name: string;
  width: number;
  height: number;
  updated: string;
  recovered: boolean;
};
export type LibraryFault = (
  phase: "assets" | "manifest" | "head",
) => Promise<void>;
async function durable(path: string, bytes: Uint8Array | string) {
  const file = await open(path, "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function replace(path: string, bytes: string) {
  const temp = path + "." + randomUUID() + ".tmp";
  await durable(temp, bytes);
  await rename(temp, path);
}
async function json(path: string) {
  if ((await stat(path)).size > 2 * 1024 * 1024)
    throw Error("Project metadata is too large");
  return JSON.parse(await readFile(path, "utf8"));
}

// Main-process only. No renderer-selected paths. Revisions and blobs are immutable.
export class Library {
  constructor(
    readonly root: string,
    private fault?: LibraryFault,
  ) {}
  private dir(id: string) {
    return join(this.root, uuid.parse(id));
  }
  async archive(id: string) {
    // UUID validation keeps both paths inside this app-owned library. The folder
    // remains on disk and is excluded from the active shelf's UUID-only listing.
    await rename(this.dir(id), join(this.root, "archived-" + uuid.parse(id)));
  }
  async save(
    input: PhotoDocument,
    assets: Record<string, Uint8Array>,
    rolling = true,
  ) {
    const doc = documentSchema.parse(input),
      dir = this.dir(doc.id);
    await mkdir(join(dir, "assets"), { recursive: true });
    await mkdir(join(dir, "revisions"), { recursive: true });
    for (const hash of references(doc)) {
      const path = join(dir, "assets", hash);
      try {
        const existing = await readFile(path);
        if (hashBytes(existing) !== hash)
          throw Error("Stored asset is damaged");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        const bytes = assets[hash];
        if (
          !bytes ||
          bytes.length > 128 * 1024 * 1024 ||
          hashBytes(bytes) !== hash
        )
          throw Error("Missing or damaged image asset");
        await durable(path, bytes);
      }
    }
    await this.fault?.("assets");
    const revision = randomUUID();
    await durable(
      join(dir, "revisions", revision + ".json"),
      JSON.stringify(doc),
    );
    await this.fault?.("manifest");
    // Only a verified previous head becomes the fallback. Failed writes cannot replace it.
    let previous: Awaited<ReturnType<Library["readHead"]>> | undefined;
    try {
      previous = await this.readHead(doc.id, "head.json");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          await this.readHead(doc.id, "previous.json");
        } catch {
          throw e;
        }
      }
    }
    // A failed fallback write must abort the save, not be mistaken for a corrupt head.
    if (previous)
      await replace(join(dir, "previous.json"), JSON.stringify(previous.head));
    if (previous && rolling) {
      const checkpoints = join(dir, "checkpoints");
      await mkdir(checkpoints, { recursive: true });
      const entry: Checkpoint = {
        id: previous.head.revision,
        revision: previous.head.revision,
        name: "Autosaved version",
        created: previous.head.updated,
        kind: "rolling",
      };
      await durable(
        join(checkpoints, entry.id + ".json"),
        JSON.stringify(entry),
      ).catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
    }
    await this.fault?.("head");
    const head = { revision, updated: new Date().toISOString() };
    await replace(join(dir, "head.json"), JSON.stringify(head));
    // Only trim rolling index entries. Immutable revisions/assets and named
    // checkpoints remain untouched. Pruning failure cannot invalidate a saved head.
    if (rolling) {
      try {
        const old = (await this.checkpoints(doc.id))
          .filter((c) => c.kind === "rolling")
          .slice(12);
        for (const entry of old)
          await unlink(join(dir, "checkpoints", entry.id + ".json"));
      } catch {
        /* Retry rolling-index maintenance on the next save. */
      }
    }
    return head;
  }
  private async revision(id: string, revision: string): Promise<ImportResult> {
    const dir = this.dir(id);
    const doc = documentSchema.parse(
      await json(join(dir, "revisions", uuid.parse(revision) + ".json")),
    );
    if (doc.id !== id) throw Error("Project identity mismatch");
    const assets: Record<string, Uint8Array> = {};
    for (const hash of references(doc)) {
      const path = join(dir, "assets", hash);
      if ((await stat(path)).size > 128 * 1024 * 1024)
        throw Error("Image asset is too large");
      const bytes = await readFile(path);
      if (hashBytes(bytes) !== hash)
        throw Error("Image asset checksum mismatch");
      assets[hash] = bytes;
    }
    return { document: doc, assets };
  }
  private async readHead(id: string, file: string) {
    const head = headSchema.parse(await json(join(this.dir(id), file)));
    return { ...(await this.revision(id, head.revision)), head };
  }
  async load(id: string) {
    try {
      return { ...(await this.readHead(id, "head.json")), recovered: false };
    } catch {
      try {
        return {
          ...(await this.readHead(id, "previous.json")),
          recovered: true,
        };
      } catch {
        throw Error(
          "Project could not be recovered. Its files have been preserved.",
        );
      }
    }
  }
  async recent(): Promise<Recent[]> {
    await mkdir(this.root, { recursive: true });
    const rows: Recent[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !uuid.safeParse(entry.name).success) continue;
      try {
        const result = await this.load(entry.name);
        rows.push({
          id: entry.name,
          name: result.document.name,
          width: result.document.width,
          height: result.document.height,
          updated: result.head.updated,
          recovered: result.recovered,
        });
      } catch {
        /* An unreadable project stays on disk; no deletion or index dependency. */
      }
    }
    return rows.sort((a, b) => b.updated.localeCompare(a.updated));
  }
  async checkpoint(
    id: string,
    name: string,
    metadata?: { created?: string; kind?: "named" | "rolling" },
  ) {
    const current = await this.load(id);
    const entry = checkpointSchema.parse({
      id: randomUUID(),
      name: name.trim(),
      revision: current.head.revision,
      created: metadata?.created ?? new Date().toISOString(),
      kind: metadata?.kind,
    });
    const dir = join(this.dir(id), "checkpoints");
    await mkdir(dir, { recursive: true });
    await durable(join(dir, entry.id + ".json"), JSON.stringify(entry));
    return entry;
  }
  async checkpoints(id: string) {
    const dir = join(this.dir(id), "checkpoints");
    await mkdir(dir, { recursive: true });
    const entries: Checkpoint[] = [];
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".json")) continue;
      entries.push(checkpointSchema.parse(await json(join(dir, file))));
    }
    return entries.sort((a, b) => b.created.localeCompare(a.created));
  }
  async restore(id: string, checkpointId: string) {
    const result = await this.preview(id, checkpointId);
    await this.save(result.document, result.assets);
    return result;
  }
  async preview(id: string, checkpointId: string) {
    const entry = checkpointSchema.parse(
      await json(
        join(this.dir(id), "checkpoints", uuid.parse(checkpointId) + ".json"),
      ),
    );
    const result = await this.revision(id, entry.revision);
    return result;
  }
}
