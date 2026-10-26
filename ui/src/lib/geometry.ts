export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function atomDistance(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function atomAngle(a: Vec3, b: Vec3, c: Vec3): number {
  const ba = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const bc = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const dot = ba.x * bc.x + ba.y * bc.y + ba.z * bc.z;
  const magBA = Math.sqrt(ba.x * ba.x + ba.y * ba.y + ba.z * ba.z);
  const magBC = Math.sqrt(bc.x * bc.x + bc.y * bc.y + bc.z * bc.z);
  if (magBA === 0 || magBC === 0) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (magBA * magBC)));
  return Math.acos(cos) * (180 / Math.PI);
}

export function atomDihedral(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const b1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const b2 = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const b3 = { x: d.x - c.x, y: d.y - c.y, z: d.z - c.z };

  const n1 = cross(b1, b2);
  const n2 = cross(b2, b3);

  const magB2 = Math.sqrt(dot(b2, b2));
  if (magB2 === 0) return 0;

  const cosPhi = dot(n1, n2);
  const sinPhi = dot(cross(n1, n2), b2) / magB2;

  return Math.atan2(sinPhi, cosPhi) * (180 / Math.PI);
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function midpoint(a: Vec3, b: Vec3): Vec3 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}
