import type { PhotoDocument } from "../model/document";
export class History {
  private past: PhotoDocument[] = [];
  private future: PhotoDocument[] = [];
  constructor(readonly limit = 50) {}
  push(previous: PhotoDocument) {
    this.past.push(structuredClone(previous));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current: PhotoDocument) {
    const doc = this.past.pop();
    if (doc) this.future.push(structuredClone(current));
    return doc;
  }
  redo(current: PhotoDocument) {
    const doc = this.future.pop();
    if (doc) this.past.push(structuredClone(current));
    return doc;
  }
  clear() {
    this.past = [];
    this.future = [];
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}
