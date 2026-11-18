const margin = 20;

export function clampBounds(bounds, areas, primary, floating = false) {
  let width = Math.min(
    Math.max(bounds.width || (floating ? 320 : 520), floating ? 280 : 420),
    primary.width,
  );
  let height = Math.min(
    Math.max(bounds.height || (floating ? 64 : 500), floating ? 56 : 480),
    primary.height,
  );
  let x =
    bounds.x ?? primary.x + Math.max(margin, primary.width - width - margin);
  let y = bounds.y ?? primary.y + margin;
  let area =
    areas.find(
      (a) =>
        Math.min(x + width, a.x + a.width) - Math.max(x, a.x) >= 100 &&
        Math.min(y + height, a.y + a.height) - Math.max(y, a.y) >= 60,
    ) || primary;
  width = Math.min(width, area.width);
  height = Math.min(height, area.height);
  x = Math.min(Math.max(x, area.x), area.x + area.width - width);
  y = Math.min(Math.max(y, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width, height };
}

export const dockMetrics = {
  size: 45,
  previewWidth: 224,
  visible: 23,
  previewVisible: 224,
  snapDistance: 12,
};

export function rightEdgeGap(bounds, area) {
  return area.x + area.width - (bounds.x + bounds.width);
}

// Called only on release: merely crossing an edge during a drag never docks.
export function shouldDock(bounds, area, moved) {
  return moved && rightEdgeGap(bounds, area) <= dockMetrics.snapDistance;
}

export function dockBounds(bounds, area, preview = false) {
  const width = preview ? dockMetrics.previewWidth : dockMetrics.size;
  const visible = preview ? dockMetrics.previewVisible : dockMetrics.visible;
  return {
    x: area.x + area.width - visible,
    y: Math.min(
      Math.max(bounds.y, area.y),
      area.y + area.height - dockMetrics.size,
    ),
    width,
    height: dockMetrics.size,
  };
}

// Native clipping excludes DWM's rectangular resize/shadow pixels in compact modes.
export function roundedWindowShape(width, height, radius = 16) {
  const r = Math.min(radius, Math.floor(height / 2), Math.floor(width / 2));
  const rows = [];
  for (let y = 0; y < height; y++) {
    const cy =
      y < r ? r - y - 0.5 : y >= height - r ? y - (height - r) + 0.5 : 0;
    const inset = cy
      ? Math.ceil(r - Math.sqrt(Math.max(0, r * r - cy * cy)))
      : 0;
    rows.push({ x: inset, y, width: width - 2 * inset, height: 1 });
  }
  return rows;
}

export function inDockZone(point, area) {
  return (
    point.x >= area.x + area.width - 48 &&
    point.x <= area.x + area.width &&
    point.y >= area.y &&
    point.y <= area.y + area.height
  );
}
