// An orbit camera, and the arithmetic to turn a touch into a place on the beach.
//
// Only the pieces this game actually needs. There is no matrix inverse here on
// purpose: the picking ray is built straight from the camera basis, which is
// both shorter and better conditioned than unprojecting a clip-space point.

export const DOMAIN = { minX: -48, minZ: -48, sizeX: 96, sizeZ: 96 };

export class Camera {
    constructor() {
        this.target = [0, 0.9, -10];
        this.distance = 52;
        // Yaw 0 stands you behind the dunes looking out to sea, which is the
        // only opening shot for a beach. The sea is toward +Z, so the camera has
        // to sit at -Z — get the sign wrong and the game opens on a wall of dune.
        this.yaw = 0.0;
        // High enough to look *down* on the working pad — relief you cannot see
        // is relief nobody sculpts — but not so high the sea leaves the frame,
        // because the sea is the antagonist.
        this.pitch = 0.62;           // radians above the horizon
        this.fovBase = 0.85;         // vertical FOV at landscape or squarer
        this.fovY = this.fovBase;
        this.aspect = 1;

        this.eye = [0, 0, 0];
        this.forward = [0, 0, -1];
        this.right = [1, 0, 0];
        this.up = [0, 1, 0];
        this.viewProj = new Float32Array(16);
    }

    orbit(dYaw, dPitch) {
        this.yaw += dYaw;
        // Stop short of both poles. At the top the camera gimbals and the beach
        // spins under your finger; at the bottom you end up inside the sand.
        this.pitch = clamp(this.pitch + dPitch, 0.08, 1.35);
    }

    zoom(factor) {
        this.distance = clamp(this.distance * factor, 8, 150);
    }

    /// Slide the look-at point across the ground. Two fingers dragged together
    /// pan; twisted apart they orbit. On a 96 m beach panning stopped being
    /// optional — you cannot reach the far headland by orbiting around the
    /// middle of it.
    pan(dx, dy) {
        // Move in the camera's own ground plane so a drag goes where it looks
        // like it should, and scale by distance so the ground tracks the finger
        // at any zoom.
        const k = this.distance * 0.9;
        const fwd = normalize([this.forward[0], 0, this.forward[2]]);
        this.target[0] += (-this.right[0] * dx + fwd[0] * dy) * k;
        this.target[2] += (-this.right[2] * dx + fwd[2] * dy) * k;

        // Keep the camera over the world rather than out in the fog.
        this.target[0] = clamp(this.target[0], -60, 60);
        this.target[2] = clamp(this.target[2], -60, 60);
    }

    update(aspect) {
        this.aspect = aspect;

        // A phone held upright is about 0.46 aspect. Holding the vertical FOV
        // fixed there leaves a horizontal field of roughly 24 degrees — a
        // letterbox slot you cannot play a beach through. Widen vertically until
        // the *horizontal* field is respectable instead, and cap it before the
        // perspective goes fisheye.
        this.fovY = aspect < 1
            ? Math.min(2 * Math.atan(Math.tan(this.fovBase * 0.5) / aspect), 1.30)
            : this.fovBase;

        const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);

        // Spherical offset from the target. Negated in Z so yaw 0 puts the
        // camera landward of the target, facing the water.
        const dir = [cp * sy, sp, -cp * cy];
        this.eye = [
            this.target[0] + dir[0] * this.distance,
            this.target[1] + dir[1] * this.distance,
            this.target[2] + dir[2] * this.distance,
        ];

        this.forward = normalize([-dir[0], -dir[1], -dir[2]]);
        this.right = normalize(cross(this.forward, [0, 1, 0]));
        this.up = cross(this.right, this.forward);

        const proj = perspective(this.fovY, aspect, 0.35, 400);
        const view = lookAt(this.eye, this.target, [0, 1, 0]);
        multiply(this.viewProj, proj, view);
        return this.viewProj;
    }

    /// A ray through a point on the canvas, in normalised 0..1 coordinates with
    /// the origin at the top left.
    ray(nx, ny) {
        const tanHalf = Math.tan(this.fovY * 0.5);
        const sx = (nx * 2 - 1) * tanHalf * this.aspect;
        const sy = (1 - ny * 2) * tanHalf;
        return normalize([
            this.forward[0] + this.right[0] * sx + this.up[0] * sy,
            this.forward[1] + this.right[1] * sx + this.up[1] * sy,
            this.forward[2] + this.right[2] * sx + this.up[2] * sy,
        ]);
    }

    /// Where a touch lands on the beach.
    ///
    /// Fixed-point iteration against a horizontal plane: intersect at the
    /// current height guess, ask the ground how tall it is there, intersect
    /// again. On a heightfield this converges in two or three passes, and it is
    /// far cheaper than marching.
    ///
    /// A single plane at a guessed height is *not* good enough, which is worth
    /// recording because it was tried: the working pad sits about a metre above
    /// where a naive guess puts it, and at this camera angle a metre of height
    /// error is several metres of ground error — enough that a bucket of sand
    /// aimed at dry beach lands in the surf.
    pickGround(nx, ny, heightAt) {
        const rd = this.ray(nx, ny);
        if (Math.abs(rd[1]) < 1e-4) { return null; }

        let h = 1.0;
        let p = null;
        for (let i = 0; i < 3; i++) {
            const t = (h - this.eye[1]) / rd[1];
            if (t <= 0) { return null; }
            p = [this.eye[0] + rd[0] * t, this.eye[2] + rd[2] * t];
            if (!heightAt) { break; }
            h = heightAt(p[0], p[1]);
        }
        return p;
    }
}

// ------------------------------------------------------------------ maths

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

function normalize(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY * 0.5);
    const nf = 1 / (near - far);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) * nf;
    m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
}

function lookAt(eye, center, up) {
    const f = normalize([center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]]);
    const s = normalize(cross(f, up));
    const u = cross(s, f);
    const m = new Float32Array(16);
    m[0] = s[0]; m[4] = s[1];  m[8]  = s[2];
    m[1] = u[0]; m[5] = u[1];  m[9]  = u[2];
    m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2];
    m[12] = -(s[0] * eye[0] + s[1] * eye[1] + s[2] * eye[2]);
    m[13] = -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]);
    m[14] =  (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]);
    m[15] = 1;
    return m;
}

function multiply(out, a, b) {
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            out[c * 4 + r] = a[r] * b[c * 4]
                           + a[4 + r] * b[c * 4 + 1]
                           + a[8 + r] * b[c * 4 + 2]
                           + a[12 + r] * b[c * 4 + 3];
        }
    }
    return out;
}
