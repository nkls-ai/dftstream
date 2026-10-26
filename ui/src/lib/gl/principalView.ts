// Default camera orientation for the 3D structure viewer.
//
// 3Dmol starts with the identity rotation, i.e. looking down the model's z
// axis. Any molecule laid out along z (HCN, CO2, an NEB image of a linear
// system) then renders as a single sphere. Instead we rotate the model so its
// principal axes line up with the screen: the axis of largest spread runs
// left-right, the second bottom-top, and the smallest points at the viewer.
// A linear molecule is shown side-on, a planar one face-on.

export type Point3 = readonly [number, number, number];
/** Quaternion as [x, y, z, w] — 3Dmol's getView()/setView() order. */
export type Quaternion = [number, number, number, number];

type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];

/**
 * Eigen-decomposition of a symmetric 3x3 matrix by cyclic Jacobi rotations.
 * Returns eigenvalues and the matching unit eigenvectors (as columns of V).
 */
export function symmetricEigen3(m: Mat3): { values: [number, number, number]; vectors: Mat3 } {
  // Flat row-major working copies: a[3 * row + col].
  const a = [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const at = (arr: number[], r: number, c: number) => arr[3 * r + c]!;
  const put = (arr: number[], r: number, c: number, x: number) => {
    arr[3 * r + c] = x;
  };
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(at(a, 0, 1)) + Math.abs(at(a, 0, 2)) + Math.abs(at(a, 1, 2));
    if (off < 1e-12) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = at(a, p, q);
      if (Math.abs(apq) < 1e-15) continue;
      const theta = (at(a, q, q) - at(a, p, p)) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = at(a, k, p);
        const akq = at(a, k, q);
        put(a, k, p, c * akp - s * akq);
        put(a, k, q, s * akp + c * akq);
      }
      for (let k = 0; k < 3; k++) {
        const apk = at(a, p, k);
        const aqk = at(a, q, k);
        put(a, p, k, c * apk - s * aqk);
        put(a, q, k, s * apk + c * aqk);
      }
      for (let k = 0; k < 3; k++) {
        const vkp = at(v, k, p);
        const vkq = at(v, k, q);
        put(v, k, p, c * vkp - s * vkq);
        put(v, k, q, s * vkp + c * vkq);
      }
    }
  }
  return {
    values: [at(a, 0, 0), at(a, 1, 1), at(a, 2, 2)],
    vectors: [
      [at(v, 0, 0), at(v, 0, 1), at(v, 0, 2)],
      [at(v, 1, 0), at(v, 1, 1), at(v, 1, 2)],
      [at(v, 2, 0), at(v, 2, 1), at(v, 2, 2)],
    ],
  };
}

/** Rotation matrix (row-major, proper: det = +1) to a unit quaternion. */
export function matrixToQuaternion(r: Mat3): Quaternion {
  const trace = r[0][0] + r[1][1] + r[2][2];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(r[2][1] - r[1][2]) / s, (r[0][2] - r[2][0]) / s, (r[1][0] - r[0][1]) / s, s / 4];
  }
  if (r[0][0] > r[1][1] && r[0][0] > r[2][2]) {
    const s = Math.sqrt(1 + r[0][0] - r[1][1] - r[2][2]) * 2;
    return [s / 4, (r[0][1] + r[1][0]) / s, (r[0][2] + r[2][0]) / s, (r[2][1] - r[1][2]) / s];
  }
  if (r[1][1] > r[2][2]) {
    const s = Math.sqrt(1 + r[1][1] - r[0][0] - r[2][2]) * 2;
    return [(r[0][1] + r[1][0]) / s, s / 4, (r[1][2] + r[2][1]) / s, (r[0][2] - r[2][0]) / s];
  }
  const s = Math.sqrt(1 + r[2][2] - r[0][0] - r[1][1]) * 2;
  return [(r[0][2] + r[2][0]) / s, (r[1][2] + r[2][1]) / s, s / 4, (r[1][0] - r[0][1]) / s];
}

/**
 * Quaternion that rotates `points` so their largest principal axis lies
 * along screen x, the second along y and the smallest along z (towards
 * the viewer). Identity for fewer than two points.
 */
export function principalViewQuaternion(points: readonly Point3[]): Quaternion {
  if (points.length < 2) return [0, 0, 0, 1];
  const n = points.length;
  const c = [0, 0, 0];
  for (const p of points) for (let k = 0; k < 3; k++) c[k]! += p[k]! / n;
  let [xx, xy, xz, yy, yz, zz] = [0, 0, 0, 0, 0, 0];
  for (const p of points) {
    const dx = p[0] - c[0]!;
    const dy = p[1] - c[1]!;
    const dz = p[2] - c[2]!;
    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }
  const cov: Mat3 = [
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ];
  const { values, vectors } = symmetricEigen3(cov);
  const order = [0, 1, 2].sort((i, j) => values[j]! - values[i]!);
  const axis = (k: number): [number, number, number] => [vectors[0][k]!, vectors[1][k]!, vectors[2][k]!];
  const e1 = axis(order[0]!);
  const e2 = axis(order[1]!);
  // e3 = e1 x e2 keeps the rotation proper (no mirror image).
  const e3: [number, number, number] = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  // Rows are the principal axes: R * e1 = x̂, R * e2 = ŷ, R * e3 = ẑ.
  return matrixToQuaternion([e1, e2, e3]);
}

/** Applies quaternion q to vector p (for tests and callers that verify). */
export function rotateByQuaternion(q: Quaternion, p: Point3): [number, number, number] {
  const [x, y, z, w] = q;
  // v' = v + 2w (u x v) + 2 u x (u x v), u = (x, y, z)
  const ux = y * p[2] - z * p[1];
  const uy = z * p[0] - x * p[2];
  const uz = x * p[1] - y * p[0];
  return [
    p[0] + 2 * (w * ux + y * uz - z * uy),
    p[1] + 2 * (w * uy + z * ux - x * uz),
    p[2] + 2 * (w * uz + x * uy - y * ux),
  ];
}
