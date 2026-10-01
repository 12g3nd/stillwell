import { documentSchema, type PhotoDocument } from "../model/document";
type Matrix = [number, number, number, number, number, number];
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ].map((value) => (value === 0 ? 0 : value)) as Matrix;
}
function transform(
  doc: PhotoDocument,
  width: number,
  height: number,
  matrix: Matrix,
) {
  return documentSchema.parse({
    ...doc,
    width,
    height,
    layers: doc.layers.map((l) => ({
      ...l,
      transform: multiply(matrix, l.transform),
    })),
    ...(doc.guides
      ? {
          guides: doc.guides.map((guide) => {
            if (guide.axis === "x")
              return Math.abs(matrix[2]) < 1e-8
                ? { ...guide, position: matrix[0] * guide.position + matrix[4] }
                : {
                    ...guide,
                    axis: "y" as const,
                    position: matrix[1] * guide.position + matrix[5],
                  };
            return Math.abs(matrix[1]) < 1e-8
              ? { ...guide, position: matrix[3] * guide.position + matrix[5] }
              : {
                  ...guide,
                  axis: "x" as const,
                  position: matrix[2] * guide.position + matrix[4],
                };
          }),
        }
      : {}),
  });
}
export function crop(
  doc: PhotoDocument,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  if (
    ![x, y, width, height].every(Number.isInteger) ||
    x < 0 ||
    y < 0 ||
    x + width > doc.width ||
    y + height > doc.height
  )
    throw Error("Crop must stay within the document");
  return transform(doc, width, height, [1, 0, 0, 1, -x, -y]);
}
export function canvasSize(
  doc: PhotoDocument,
  width: number,
  height: number,
  anchor: number,
) {
  if (!Number.isInteger(anchor) || anchor < 0 || anchor > 8)
    throw Error("Invalid anchor");
  return transform(doc, width, height, [
    1,
    0,
    0,
    1,
    Math.round(((width - doc.width) * (anchor % 3)) / 2),
    Math.round(((height - doc.height) * Math.floor(anchor / 3)) / 2),
  ]);
}
export function resize(
  doc: PhotoDocument,
  width: number,
  height: number,
  mode: "stretch" | "fit" | "fill",
) {
  let x = width / doc.width,
    y = height / doc.height;
  if (mode !== "stretch")
    x = y = mode === "fit" ? Math.min(x, y) : Math.max(x, y);
  return transform(doc, width, height, [
    x,
    0,
    0,
    y,
    (width - doc.width * x) / 2,
    (height - doc.height * y) / 2,
  ]);
}
export function rotate(doc: PhotoDocument) {
  return transform(doc, doc.height, doc.width, [0, 1, -1, 0, doc.height, 0]);
}
export function flip(doc: PhotoDocument, axis: "horizontal" | "vertical") {
  return transform(
    doc,
    doc.width,
    doc.height,
    axis === "horizontal"
      ? [-1, 0, 0, 1, doc.width, 0]
      : [1, 0, 0, -1, 0, doc.height],
  );
}
