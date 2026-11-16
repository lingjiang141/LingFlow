export function chooseIdle(character, previous, random = Math.random, bundledOnly = false) {
  const options = character.animations.filter(action => action.id !== character.coding &&
    (!bundledOnly || character.bundled.includes(action.id)));
  const different = options.filter(action => action.id !== previous);
  const pool = different.length ? different : options;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}
export function playbackFrame(animation, elapsedMs, viewing) {
  const elapsedFrames = Math.floor(Math.max(0, elapsedMs) * animation.fps / 1000);
  const finished = !viewing && elapsedFrames >= animation.frameCount * 2;
  return { frame: finished ? animation.frameCount - 1 : elapsedFrames % animation.frameCount,
    finished, loops: Math.floor(elapsedFrames / animation.frameCount) };
}
