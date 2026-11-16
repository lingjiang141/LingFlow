// Alpha mass suppresses isolated sparkles and large, nearly transparent effects.
// Use a median across frames so occasional stretching does not resize a clip.
export function subjectBounds(pixels, sheetWidth, frameWidth, frameHeight, columns, frameCount) {
  const measurements = [];
  for (let frame = 0; frame < frameCount; frame += 3) {
    const rows = new Float64Array(frameHeight), cols = new Float64Array(frameWidth);
    let total = 0;
    for (let y = 0; y < frameHeight; y++) for (let x = 0; x < frameWidth; x++) {
      const alpha = pixels[((Math.floor(frame / columns) * frameHeight + y) * sheetWidth + frame % columns * frameWidth + x) * 4 + 3];
      if (alpha < 100) continue;
      rows[y] += alpha; cols[x] += alpha; total += alpha;
    }
    if (!total) continue;
    const quantile = (values, fraction) => {
      let sum = 0;
      for (let index = 0; index < values.length; index++) { sum += values[index]; if (sum >= total * fraction) return index; }
      return values.length - 1;
    };
    measurements.push({ left: quantile(cols, .04), right: quantile(cols, .96), top: quantile(rows, .02), bottom: quantile(rows, .98) });
  }
  if (!measurements.length) return { centerX: frameWidth / 2, bottom: frameHeight, height: frameHeight };
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  return { centerX: median(measurements.map(item => (item.left + item.right) / 2)),
    bottom: median(measurements.map(item => item.bottom + 1)), height: median(measurements.map(item => item.bottom - item.top + 1)) };
}
