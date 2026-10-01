import React, { useEffect, useState } from "react";
import type {
  Layer,
  RecentProject,
  ImportResult,
} from "../editor/model/document";
export function ShelfControls(p: {
  layer?: Layer;
  disabled: boolean;
  run(action: () => Promise<void>): Promise<void>;
  flush(): Promise<void>;
  insert(result: ImportResult): Promise<void>;
}) {
  const [items, setItems] = useState<RecentProject[]>([]),
    [name, setName] = useState("");
  useEffect(() => {
    void p.run(async () => setItems(await window.photo.shelfList()));
  }, []);
  return (
    <section aria-label="Local shelf">
      <p className="hint">
        Keep up to 30 image cutouts and text styles for other projects on this
        computer. Text styles apply to the selected text layer.
      </p>
      <label>
        Shelf name
        <input
          aria-label="Shelf name"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={p.disabled}
        />
      </label>
      <button
        disabled={
          p.disabled ||
          !p.layer ||
          p.layer.kind === "group" ||
          !name.trim() ||
          items.length >= 30
        }
        onClick={() =>
          void p.run(async () => {
            await p.flush();
            await window.photo.shelfSave(p.layer!.id, name);
            setName("");
            setItems(await window.photo.shelfList());
          })
        }
      >
        Save selected to shelf
      </button>
      {items.length === 0 && <p className="hint">Your shelf is empty.</p>}
      {items.map((item) => (
        <div className="project-row" key={item.id}>
          <button
            disabled={p.disabled}
            onClick={() =>
              void p.run(async () => {
                await p.flush();
                await p.insert(await window.photo.shelfLoad(item.id));
              })
            }
          >
            {item.name}
          </button>
          <button
            aria-label={`Remove ${item.name} from shelf`}
            disabled={p.disabled}
            onClick={() =>
              void p.run(async () => {
                await window.photo.shelfRemove(item.id);
                setItems(await window.photo.shelfList());
              })
            }
          >
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}
