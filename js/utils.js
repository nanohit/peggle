// Peggle Utils - Math helpers and collision detection

export const Utils = {
  // Generate unique ID
  generateId() {
    return 'id-' + Math.random().toString(36).substr(2, 9);
  },

  // Distance between two points
  distance(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  },

  // Vector magnitude
  magnitude(vx, vy) {
    return Math.sqrt(vx * vx + vy * vy);
  },

  // Normalize vector
  normalize(vx, vy) {
    const mag = this.magnitude(vx, vy);
    if (mag === 0) return { x: 0, y: 0 };
    return { x: vx / mag, y: vy / mag };
  },

  // Dot product
  dot(x1, y1, x2, y2) {
    return x1 * x2 + y1 * y2;
  },

  // Clamp value between min and max
  clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  },

  // Linear interpolation
  lerp(a, b, t) {
    return a + (b - a) * t;
  },

  // Angle between two points (radians)
  angleBetween(x1, y1, x2, y2) {
    return Math.atan2(y2 - y1, x2 - x1);
  },

  // Degrees to radians
  degToRad(degrees) {
    return degrees * (Math.PI / 180);
  },

  // Radians to degrees
  radToDeg(radians) {
    return radians * (180 / Math.PI);
  },

  // Check if point is inside circle
  pointInCircle(px, py, cx, cy, radius) {
    return this.distance(px, py, cx, cy) <= radius;
  },

  // Check if two circles overlap
  circlesOverlap(x1, y1, r1, x2, y2, r2) {
    return this.distance(x1, y1, x2, y2) < (r1 + r2);
  },

  // Circle-circle collision detection and response
  circleCollision(ball, peg) {
    const dx = ball.x - peg.x;
    const dy = ball.y - peg.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const minDist = ball.radius + peg.radius;

    if (dist >= minDist) return null;

    // Collision detected - calculate response
    const nx = dx / dist; // Normal x
    const ny = dy / dist; // Normal y

    // Relative velocity
    const dvx = ball.vx;
    const dvy = ball.vy;

    // Relative velocity along normal
    const dvn = dvx * nx + dvy * ny;

    // Only resolve if objects are approaching
    if (dvn > 0) return null;

    return {
      normal: { x: nx, y: ny },
      depth: minDist - dist,
      relativeVelocityNormal: dvn
    };
  },

  // Snap value to grid
  snapToGrid(value, gridSize) {
    return Math.round(value / gridSize) * gridSize;
  },

  // Snap angle to increments (in degrees)
  snapAngle(angle, increment) {
    return Math.round(angle / increment) * increment;
  },

  // Random integer between min and max (inclusive)
  randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  },

  // Shuffle array (Fisher-Yates)
  shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },

  // Deep clone object
  deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  },

  // Throttle function calls
  throttle(func, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },

  // Debounce function calls
  debounce(func, wait) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }
};
