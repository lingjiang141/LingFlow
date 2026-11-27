import { chooseIdle, playbackFrame } from "./animation-policy.js";
import { subjectBounds } from "./subject-scale.js";

// Find the union of alpha bounds over every frame, so props are not cropped.
function cropBounds(bitmap, animation) {
  const scale = 4, fw = Math.ceil(animation.frameWidth / scale), fh = Math.ceil(animation.frameHeight / scale);
  const scratch = document.createElement("canvas");
  scratch.width = fw * animation.columns; scratch.height = fh * animation.rows;
  const context = scratch.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, scratch.width, scratch.height);
  const pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
  const subject = subjectBounds(pixels, scratch.width, fw, fh, animation.columns, animation.frameCount);
  let left = fw, top = fh, right = 0, bottom = 0;
  for (let y = 0; y < scratch.height; y++) for (let x = 0; x < scratch.width; x++) {
    const frame = Math.floor(y / fh) * animation.columns + Math.floor(x / fw);
    if (frame >= animation.frameCount || pixels[(y * scratch.width + x) * 4 + 3] < 30) continue;
    const px = x % fw, py = y % fh;
    left = Math.min(left, px); right = Math.max(right, px); top = Math.min(top, py); bottom = Math.max(bottom, py);
  }
  scratch.width = scratch.height = 1;
  if (right <= left) return { x: 0, y: 0, width: animation.frameWidth, height: animation.frameHeight };
  const x = Math.max(0, left * scale - 8), y = Math.max(0, top * scale - 8);
  return { x, y, width: Math.min(animation.frameWidth, (right + 1) * scale + 8) - x,
    height: Math.min(animation.frameHeight, (bottom + 1) * scale + 8) - y,
    subject: { centerX: subject.centerX * scale, bottom: subject.bottom * scale, height: subject.height * scale } };
}

export class PetAnimator {
  constructor(canvas, api, catalog) {
    this.canvas = canvas; this.api = api; this.catalog = catalog; this.generation = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { this.pausedAt = performance.now(); cancelAnimationFrame(this.raf); }
      else if (this.current) {
        if (this.pausedAt) this.started += performance.now() - this.pausedAt;
        this.pausedAt = null; this.draw(this.generation);
      }
    });
  }
  async load(character, animation, generation = this.generation) {
    const result = await this.api.image(character.id, animation.id);
    if (generation !== this.generation) throw Error("Animation request replaced");
    const bitmap = await createImageBitmap(new Blob([result.bytes], { type: "image/webp" }));
    if (generation !== this.generation) { bitmap.close(); throw Error("Animation request replaced"); }
    return { bitmap, animation, character: character.id, crop: cropBounds(bitmap, animation) };
  }
  async setMode(characterId, viewing) {
    if (this.character?.id === characterId && this.viewing === viewing) return;
    const generation = ++this.generation;
    cancelAnimationFrame(this.raf);
    this.next?.bitmap.close(); this.next = null;
    this.character = this.catalog.characters.find(character => character.id === characterId);
    this.viewing = viewing;
    const action = viewing ? this.character.animations.find(action => action.id === this.character.coding) : chooseIdle(this.character, null, Math.random, true);
    try {
      const loaded = await this.load(this.character, action);
      if (generation !== this.generation) { loaded.bitmap.close(); return; }
      this.current?.bitmap.close(); this.current = loaded;
      this.started = performance.now(); this.lastFrame = -1;
      this.pausedAt = document.hidden ? this.started : null;
      this.prefetch(generation); this.draw(generation);
    } catch {
      if (generation === this.generation) this.canvas.dataset.error = "动画暂不可用";
    }
  }
  prefetch(generation) {
    if (this.viewing) return;
    const character = this.character;
    const target = chooseIdle(character, this.current.animation.id);
    void this.load(character, target).catch(error => {
      if (generation !== this.generation) throw error;
      return this.load(character, chooseIdle(character, this.current?.animation.id, Math.random, true));
    })
      .then(next => { if (generation !== this.generation) next.bitmap.close(); else this.next = next; }).catch(() => {});
  }
  draw(generation) {
    if (generation !== this.generation || document.hidden) return;
    let position = playbackFrame(this.current.animation, performance.now() - this.started, this.viewing);
    if (position.finished && this.next) {
      this.current.bitmap.close(); this.current = this.next; this.next = null;
      this.started = performance.now(); this.lastFrame = -1;
      this.prefetch(generation); position = playbackFrame(this.current.animation, 0, false);
    }
    if (position.frame !== this.lastFrame) {
      this.lastFrame = position.frame;
      const { bitmap, animation, crop } = this.current;
      const ratio = devicePixelRatio || 1;
      if (this.canvas.width !== Math.round(184 * ratio)) { this.canvas.width = Math.round(184 * ratio); this.canvas.height = Math.round(170 * ratio); }
      const context = this.canvas.getContext("2d"); context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, 184, 170);
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
      const subject = crop.subject ?? { centerX: crop.x + crop.width / 2, bottom: crop.y + crop.height, height: crop.height };
      const scale = 128 / (this.character?.referenceHeight ?? subject.height);
      const dx = 92 + (crop.x - subject.centerX) * scale;
      let dy = 162 + (crop.y - subject.bottom) * scale;
      const subjTop = dy + (subject.bottom - subject.height - crop.y) * scale;
      const subjBottom = dy + (subject.bottom - crop.y) * scale;
      if (subjTop < 0) dy -= subjTop;
      else if (subjBottom > 170) dy -= subjBottom - 170;
      context.drawImage(bitmap, position.frame % animation.columns * animation.frameWidth + crop.x,
        Math.floor(position.frame / animation.columns) * animation.frameHeight + crop.y, crop.width, crop.height,
        dx, dy, crop.width * scale, crop.height * scale);
      this.canvas.dataset.subjectHeight = String(Math.round(subject.height * scale));
      this.canvas.dataset.animation = animation.id;
      this.canvas.dataset.character = this.current.character;
      this.canvas.dataset.frame = String(position.frame);
      this.canvas.dataset.loops = String(position.loops);
      delete this.canvas.dataset.error;
    }
    this.raf = requestAnimationFrame(() => this.draw(generation));
  }
}
