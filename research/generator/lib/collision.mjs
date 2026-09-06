const DEFAULT_RADIUS = 8.5;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function collisionFootprint(object, padding = 0) {
  if (object.kind === 'circle') {
    return {
      kind: 'circle', x: finite(object.transform?.x), y: finite(object.transform?.y),
      radius: finite(object.geometry?.radius, DEFAULT_RADIUS) + padding
    };
  }
  return {
    kind: 'rectangle', x: finite(object.transform?.x), y: finite(object.transform?.y),
    rotation: finite(object.transform?.rotation),
    halfWidth: finite(object.geometry?.width, 34) / 2 + padding,
    halfHeight: finite(object.geometry?.height, 10.2) / 2 + padding
  };
}

function rectangleCorners(shape) {
  const cos = Math.cos(shape.rotation);
  const sin = Math.sin(shape.rotation);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = sx * shape.halfWidth;
    const y = sy * shape.halfHeight;
    return { x: shape.x + x * cos - y * sin, y: shape.y + x * sin + y * cos };
  });
}

export function collisionBounds(shape) {
  if (shape.kind === 'circle') {
    return { minX: shape.x - shape.radius, maxX: shape.x + shape.radius, minY: shape.y - shape.radius, maxY: shape.y + shape.radius };
  }
  const corners = rectangleCorners(shape);
  return {
    minX: Math.min(...corners.map(point => point.x)), maxX: Math.max(...corners.map(point => point.x)),
    minY: Math.min(...corners.map(point => point.y)), maxY: Math.max(...corners.map(point => point.y))
  };
}

function circleRectangle(circle, rectangle) {
  const cos = Math.cos(-rectangle.rotation);
  const sin = Math.sin(-rectangle.rotation);
  const dx = circle.x - rectangle.x;
  const dy = circle.y - rectangle.y;
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  const closestX = clamp(localX, -rectangle.halfWidth, rectangle.halfWidth);
  const closestY = clamp(localY, -rectangle.halfHeight, rectangle.halfHeight);
  return Math.hypot(localX - closestX, localY - closestY) < circle.radius;
}

function rectangleRectangle(left, right) {
  const a = rectangleCorners(left);
  const b = rectangleCorners(right);
  const axes = [left.rotation, left.rotation + Math.PI / 2, right.rotation, right.rotation + Math.PI / 2]
    .map(angle => ({ x: Math.cos(angle), y: Math.sin(angle) }));
  for (const axis of axes) {
    const project = corners => corners.map(point => point.x * axis.x + point.y * axis.y);
    const leftProjection = project(a);
    const rightProjection = project(b);
    if (Math.max(...leftProjection) <= Math.min(...rightProjection)
        || Math.max(...rightProjection) <= Math.min(...leftProjection)) return false;
  }
  return true;
}

export function collisionFootprintsOverlap(left, right) {
  if (left.kind === 'circle' && right.kind === 'circle') {
    return Math.hypot(left.x - right.x, left.y - right.y) < left.radius + right.radius;
  }
  if (left.kind === 'circle') return circleRectangle(left, right);
  if (right.kind === 'circle') return circleRectangle(right, left);
  return rectangleRectangle(left, right);
}

export function objectsOverlap(left, right, padding = 0) {
  return collisionFootprintsOverlap(collisionFootprint(left, padding), collisionFootprint(right, padding));
}
