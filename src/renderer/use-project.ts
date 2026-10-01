import { useEffect, useRef, useState } from "react";
import { History } from "../editor/commands/history";
import {
  documentSchema,
  type PhotoDocument,
  type ImportResult,
} from "../editor/model/document";
export function useProject() {
  const [doc, setDoc] = useState<PhotoDocument>();
  const current = useRef<PhotoDocument | undefined>(undefined);
  const assets = useRef<Record<string, Uint8Array>>({});
  const history = useRef(new History(50));
  const [historyTick, setHistoryTick] = useState(0);
  const [saveState, setSaveState] = useState("Saved");
  const [saveError, setSaveError] = useState("");
  const version = useRef(0),
    saved = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    saving = useRef<Promise<void> | undefined>(undefined);
  async function flush() {
    clearTimeout(timer.current);
    while (current.current && saved.current < version.current) {
      if (saving.current) {
        await saving.current;
        continue;
      }
      const snapshot = structuredClone(current.current),
        v = version.current;
      setSaveState("Saving…");
      setSaveError("");
      const task = window.photo
        .saveProject(snapshot, v)
        .then(() => {
          saved.current = v;
          setSaveState(v === version.current ? "Saved" : "Unsaved");
        })
        .catch((e) => {
          setSaveState("Save failed");
          setSaveError(
            String(e.message).replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            ),
          );
          throw e;
        })
        .finally(() => {
          saving.current = undefined;
        });
      saving.current = task;
      await task;
    }
  }
  function schedule() {
    version.current++;
    window.photo.markDirty(version.current);
    setSaveState("Unsaved");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush().catch(() => {});
    }, 400);
  }
  function adopt(result: ImportResult) {
    clearTimeout(timer.current);
    assets.current = result.assets;
    current.current = result.document;
    setDoc(result.document);
    history.current.clear();
    setHistoryTick((t) => t + 1);
    version.current = saved.current = 0;
    setSaveState("Saved");
    setSaveError("");
  }
  function commit(input: PhotoDocument, record = true) {
    const next = documentSchema.parse(input);
    if (
      current.current &&
      JSON.stringify(current.current) === JSON.stringify(next)
    )
      return;
    if (record && current.current) history.current.push(current.current);
    current.current = next;
    setDoc(next);
    setHistoryTick((t) => t + 1);
    schedule();
  }
  function undo() {
    if (!current.current) return;
    const next = history.current.undo(current.current);
    if (next) commit(next, false);
    return next;
  }
  function redo() {
    if (!current.current) return;
    const next = history.current.redo(current.current);
    if (next) commit(next, false);
    return next;
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    doc,
    current,
    assets,
    adopt,
    commit,
    flush,
    undo,
    redo,
    saveState,
    saveError,
    canUndo: history.current.canUndo,
    canRedo: history.current.canRedo,
    historyTick,
  };
}
