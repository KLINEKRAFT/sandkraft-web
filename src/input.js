// Touch, mouse and trackpad, on one code path.
//
// The rule, which is the whole interaction model: **one finger works the sand,
// two fingers move the camera.** A sandbox where the first thing a finger does
// is spin the world is a sandbox nobody digs in. On a mouse, the right button
// or a held Shift stands in for the second finger.

export class Input {
    constructor(canvas, camera, callbacks) {
        this.canvas = canvas;
        this.camera = camera;
        this.cb = callbacks;

        this.pointers = new Map();
        this.orbiting = false;
        this.panning = false;
        this.lastOrbit = null;

        // Pointer Events cover touch, mouse and pencil in one API, and Safari on
        // iOS has had them since 13. Touch Events are not worth the branch.
        canvas.addEventListener('pointerdown', (e) => this.down(e), { passive: false });
        canvas.addEventListener('pointermove', (e) => this.move(e), { passive: false });
        canvas.addEventListener('pointerup', (e) => this.up(e));
        canvas.addEventListener('pointercancel', (e) => this.up(e));
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            camera.zoom(Math.exp(e.deltaY * 0.0016));
        }, { passive: false });

        // iOS fires these on the *page* for pinches that start on the canvas.
        // Without them a two-finger pinch zooms the browser instead of the beach.
        for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
            document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
        }
    }

    normalised(e) {
        const r = this.canvas.getBoundingClientRect();
        return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    }

    down(e) {
        e.preventDefault();
        this.canvas.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, this.normalised(e));

        const secondary = e.button === 2 || e.button === 1 || e.shiftKey;
        if (this.pointers.size >= 2 || secondary) {
            this.orbiting = true;
            // Middle button or a held Space pans; right button or Shift orbits.
            if (e.button === 1 || e.ctrlKey) { this.panning = true; }
            this.cb.onStopWork();
            this.beginOrbit();
        } else {
            this.cb.onWork(...this.normalised(e), true);
        }
    }

    move(e) {
        if (!this.pointers.has(e.pointerId)) {
            // Hover: no work, but the cursor ring should still follow.
            if (this.pointers.size === 0) { this.cb.onHover(...this.normalised(e)); }
            return;
        }
        e.preventDefault();
        this.pointers.set(e.pointerId, this.normalised(e));

        if (this.orbiting) { this.updateOrbit(); }
        else { this.cb.onWork(...this.normalised(e), false); }
    }

    up(e) {
        this.pointers.delete(e.pointerId);
        if (this.pointers.size === 0) {
            this.orbiting = false;
            this.cb.onStopWork();
        } else if (this.orbiting) {
            this.beginOrbit();
        }
    }

    beginOrbit() {
        this.lastOrbit = this.orbitState();
    }

    orbitState() {
        const pts = [...this.pointers.values()];
        if (pts.length === 0) { return null; }
        let cx = 0, cy = 0;
        for (const p of pts) { cx += p[0]; cy += p[1]; }
        cx /= pts.length; cy /= pts.length;
        let spread = 0;
        if (pts.length >= 2) { spread = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]); }
        return { cx, cy, spread };
    }

    updateOrbit() {
        const now = this.orbitState();
        const was = this.lastOrbit;
        if (!now || !was) { return; }

        const dx = now.cx - was.cx;
        const dy = now.cy - was.cy;

        if (this.panning) {
            this.camera.pan(dx, dy);
        } else {
            this.camera.orbit(dx * -3.2, dy * 2.2);
        }

        if (now.spread > 0 && was.spread > 0) {
            this.camera.zoom(was.spread / now.spread);
        }
        this.lastOrbit = now;
    }

    /// Two fingers orbit; two fingers with a modifier — or the middle mouse
    /// button — pan instead. Set by the UI's Pan toggle on touch, where there
    /// is no modifier to hold.
    setPanning(on) { this.panning = !!on; }
}
