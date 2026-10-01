import React, { useEffect, useState } from "react";
import { StaticCanvas } from "fabric";
import { project } from "../editor/render/adapter";
// Thumbnails are ephemeral presentation data, never canonical snapshots.
export function VersionPreview({ id, name }: { id: string; name: string }) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let stopped = false,
      objectUrl = "";
    void (async () => {
      const saved = await window.photo.checkpointPreview(id);
      if (stopped) return;
      const scale = Math.min(
        240 / saved.document.width,
        150 / saved.document.height,
      );
      const canvas = new StaticCanvas(undefined, {
        width: Math.max(1, Math.round(saved.document.width * scale)),
        height: Math.max(1, Math.round(saved.document.height * scale)),
        enableRetinaScaling: false,
        renderOnAddRemove: false,
      });
      try {
        canvas.setViewportTransform([scale, 0, 0, scale, 0, 0]);
        await project(canvas, saved.document, saved.assets);
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas
            .getElement()
            .toBlob(
              (b) =>
                b ? resolve(b) : reject(Error("Thumbnail encoding failed")),
              "image/png",
            ),
        );
        if (!stopped) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      } finally {
        await canvas.dispose();
      }
    })().catch((e) => {
      if (!stopped) setError((e as Error).message);
    });
    return () => {
      stopped = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);
  return url ? (
    <img className="version-thumbnail" src={url} alt={`Preview of ${name}`} />
  ) : (
    <p className="hint">
      {error ? "Preview unavailable: " + error : "Rendering preview…"}
    </p>
  );
}
