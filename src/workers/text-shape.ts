import { deform, type Deformation } from "../editor/render/deformation";
const scope = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<{ settings: Deformation; pixels: Uint8ClampedArray }>,
  ) => void;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = ({ data }) => {
  try {
    const result = deform(data.settings, data.pixels);
    scope.postMessage(result, [result.pixels.buffer]);
  } catch (error) {
    scope.postMessage({ error: (error as Error).message });
  }
};
