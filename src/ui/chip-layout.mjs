const chipHeight = 24;
const compactWidth = 28;
const gutter = 3;

function box(x, y, halfWidth, top, bottom) {
  return {
    left: x - halfWidth,
    right: x + halfWidth,
    top: y + top,
    bottom: y + bottom,
  };
}

function nearestFreePoint(preferred, width, stage, obstacles) {
  const halfWidth = width / 2 + gutter;
  const halfHeight = chipHeight / 2 + gutter;
  const xMax = stage.width - halfWidth;
  const yMax = stage.height - halfHeight;
  if (xMax < halfWidth || yMax < halfHeight) return null;
  const xs = [
    Math.max(halfWidth, Math.min(preferred.x, xMax)),
    halfWidth,
    xMax,
  ];
  const ys = [
    Math.max(halfHeight, Math.min(preferred.y, yMax)),
    halfHeight,
    yMax,
  ];
  for (const obstacle of obstacles) {
    xs.push(obstacle.left - halfWidth, obstacle.right + halfWidth);
    ys.push(obstacle.top - halfHeight, obstacle.bottom + halfHeight);
  }
  let nearest = null;
  let distance = Infinity;
  for (const x of xs) {
    if (x < halfWidth || x > xMax) continue;
    for (const y of ys) {
      if (y < halfHeight || y > yMax) continue;
      const score = (x - preferred.x) ** 2 + (y - preferred.y) ** 2;
      if (score >= distance) continue;
      if (
        obstacles.some(
          (r) =>
            x + halfWidth > r.left &&
            x - halfWidth < r.right &&
            y + halfHeight > r.top &&
            y - halfHeight < r.bottom,
        )
      )
        continue;
      nearest = { x, y };
      distance = score;
    }
  }
  return nearest;
}

export function placeMessageChips(edges, centers, stage) {
  // Match the 56px agent icon and the 132px name/status column in style.css.
  const obstacles = [...centers].flatMap(({ x, y }) => [
    box(x, y, 31, -31, 31),
    box(x, y, 66, 30, 67),
  ]);
  const placed = [];
  for (const edge of edges) {
    const preferred = { x: edge.labelX, y: edge.labelY };
    const point = nearestFreePoint(preferred, compactWidth, stage, obstacles);
    if (!point) continue;
    placed.push({ ...edge, ...point });
    obstacles.push(
      box(point.x, point.y, compactWidth / 2, -chipHeight / 2, chipHeight / 2),
    );
  }
  return placed;
}
