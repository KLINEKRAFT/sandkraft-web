// Bootstrap, tool state and the frame loop.

import { getContext, GLError } from './gl.js';
import { SandSim, TOOL, MOULD_SHAPE } from './sim.js';
import { Renderer } from './renderer.js';
import { Camera } from './camera.js';
import { Input } from './input.js';
import { Props, PROP_KINDS } from './props.js';
import * as storage from './storage.js';

// Two tiers, chosen from the device rather than offered as a setting. A phone
// that cannot hold the high one should not be asked to decide that about itself.
//
// The domain went from 48 m to 96 m — four times the area — so the resolutions
// went up with it. What has to stay roughly constant is the *texel size*, not
// the texel count: texel size is what decides how sharp an edge the sand can
// hold, and at 0.33 m a moulded tower still has a crisp lip. Substeps came down
// to pay for it, which costs a little stiffness in the avalanche and nothing
// visible.
const TIERS = {
    phone:   { sim: 288, terrainGrid: 224, skirtGrid: 112, waterGrid: 128, substeps: 2, maxDPR: 2.0 },
    desktop: { sim: 384, terrainGrid: 352, skirtGrid: 160, waterGrid: 192, substeps: 3, maxDPR: 2.0 },
};

const canvas = document.getElementById('scene');
const ui = document.getElementById('ui');
const fatal = document.getElementById('fatal');
const toast = document.getElementById('toast');

function die(message) {
    fatal.textContent = message;
    fatal.hidden = false;
    ui.hidden = true;
    canvas.hidden = true;
}

let gl, floatRenderable;
try {
    ({ gl, floatRenderable } = getContext(canvas));
} catch (err) {
    die(err instanceof GLError ? err.message : String(err));
    throw err;
}

const coarse = window.matchMedia('(pointer: coarse)').matches;
const tier = coarse ? TIERS.phone : TIERS.desktop;

const sim = new SandSim(gl, floatRenderable, tier.sim);
const renderer = new Renderer(gl, tier);
const camera = new Camera();
const props = new Props(gl);

sim.reset();

const env = {
    time: 0,
    seaBase: -0.35,
    waveAmplitude: 0.85,
    erosion: 1.0,
    sunDir: normalize3([0.42, 0.72, 0.35]),
};

const state = {
    tool: TOOL.dig,
    radius: 3.0,
    shape: 0,                       // brush footprint: 0 round, 1 square
    mouldShape: MOULD_SHAPE.tower,
    propKind: 0,
    working: false,
    tide: true,
    // How long the current stroke has been down, for the strength ramp.
    strokeAge: 0,
};

/// The tool arrives over this long rather than at full rate on the first frame.
/// Without it a tap gouges, which was the single most-complained-about thing
/// about the first cut of this game.
const RAMP_SECONDS = 0.20;

// ------------------------------------------------------------------- cursor
//
// Where the tool is and how big it is, in world metres, drawn onto the sand by
// the terrain shader. On a phone there is no hover and therefore no cursor, so
// this has to be *shown* rather than assumed: it appears when you touch the
// beach, when you move the size slider, and when you change tool, and it fades
// out on its own a beat after you stop.

/// How long the ring stays at full strength after the last thing that moved it.
const CURSOR_HOLD = 1.1;

const cursor = {
    x: 0, z: -12,        // the middle of the working pad, until a touch says otherwise
    radius: 3.0,
    shape: 0,
    active: 0,           // eased 0..1: is the tool actually working
    alpha: 0,            // eased 0..1: is the ring visible at all
    pulse: 0,            // decays after a tap, flaring the ring
    hold: 0,             // seconds of full visibility left
    tint: new Float32Array([1, 1, 1]),
};

/// One colour per tool, so the ring says *which* tool as well as how big.
const TOOL_TINT = {
    [TOOL.dig]:     [1.00, 0.42, 0.26],
    [TOOL.pour]:    [1.00, 0.74, 0.28],
    [TOOL.pack]:    [0.70, 0.53, 0.96],
    [TOOL.wet]:     [0.26, 0.78, 0.95],
    [TOOL.wall]:    [0.96, 0.55, 0.34],
    [TOOL.flatten]: [0.52, 0.86, 0.60],
    [TOOL.mould]:   [0.99, 0.66, 0.33],
    [TOOL.prop]:    [0.52, 0.86, 0.60],
    [TOOL.erase]:   [0.93, 0.93, 0.97],
};

/// The radius the ring should draw, which is the radius the tool will *use* —
/// not always the slider's number. A ring that lies is worse than none.
function cursorRadius() {
    if (state.tool === TOOL.mould) { return state.radius * 0.85; }
    if (state.tool === TOOL.erase) { return Math.max(state.radius, 2.0); }
    if (state.tool === TOOL.prop)  { return 1.1; }        // a placement mark, not a brush
    return state.radius;
}

/// Likewise the footprint: the brush toggle governs the continuous tools, and
/// the mould's own shape governs the mould.
function cursorShape() {
    if (state.tool === TOOL.mould) { return state.mouldShape === MOULD_SHAPE.block ? 1 : 0; }
    if (state.tool === TOOL.prop || state.tool === TOOL.erase) { return 0; }
    return state.shape;
}

/// Put the ring somewhere and keep it up for a while.
function markCursor(x, z, hold = CURSOR_HOLD) {
    cursor.x = x;
    cursor.z = z;
    cursor.hold = Math.max(cursor.hold, hold);
}

/// Show the ring where it already is — for the slider and the tool buttons,
/// where nothing has been touched but the size or the colour just changed.
function flashCursor(hold = 1.6) {
    cursor.hold = Math.max(cursor.hold, hold);
}

function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 2200);
}

// -------------------------------------------------------------------- canvas

// The pixel-ratio cap, which the frame-time watchdog below is allowed to lower.
let dprCap = tier.maxDPR;

function resize() {
    // Clamp the pixel ratio. A 3x iPhone display asks for nine times the
    // fragments of a 1x one, and the ink outline is the same width either way —
    // so past 2x you are paying for pixels nobody can see.
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    renderer.resize(w, h);
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
resize();

// --------------------------------------------------------------------- input

const groundAt = (x, z) => sim.groundAt(x, z);

/// Tools that are one action per tap rather than a continuous stroke.
function isInstant(tool) {
    return tool === TOOL.mould || tool === TOOL.prop || tool === TOOL.erase;
}

function onWork(nx, ny, fresh) {
    const p = camera.pickGround(nx, ny, groundAt);
    if (!p) { return; }
    const [x, z] = p;

    markCursor(x, z);
    if (fresh) { cursor.pulse = 1; }

    if (isInstant(state.tool)) {
        if (!fresh) { return; }        // one per tap, not one per frame
        if (state.tool === TOOL.mould) {
            sim.armMould({
                x, z,
                radius: state.radius * 0.85,
                height: state.radius * 0.95,
                shape: state.mouldShape,
            });
        } else if (state.tool === TOOL.prop) {
            props.add(state.propKind, x, z);
        } else if (state.tool === TOOL.erase) {
            if (!props.removeNear(x, z, Math.max(state.radius, 2.0))) {
                showToast('Nothing to pick up here');
            }
        }
        return;
    }

    if (fresh) {
        state.strokeAge = 0;
        sim.beginStroke(x, z, {
            tool: state.tool,
            radius: state.radius,
            shape: state.shape,
            // Wall height scales with the brush, so the size slider governs how
            // big a rampart you drag out as well as how wide it is.
            parameter: Math.max(0.6, state.radius * 0.55),
            baseY: sim.surfaceAt(x, z),
        });
    }
    sim.extendStroke(x, z, Math.min(1, state.strokeAge / RAMP_SECONDS));
    state.working = true;
}

const input = new Input(canvas, camera, {
    onWork,
    // Desktop only — there is no hover on a touchscreen — but where it exists
    // the ring should track the pointer without waiting for a click.
    onHover: (nx, ny) => {
        const p = camera.pickGround(nx, ny, groundAt);
        if (p) { markCursor(p[0], p[1], 0.20); }
    },
    onStopWork: () => { state.working = false; sim.endStroke(); },
});

// ------------------------------------------------------------------------ UI

function selectTool(tool, button) {
    state.tool = tool;
    for (const b of document.querySelectorAll('[data-tool]')) {
        b.classList.toggle('on', b === button);
    }
    // The contextual row only shows what the current tool actually uses.
    document.getElementById('shapes').hidden = tool !== TOOL.mould;
    document.getElementById('propbar').hidden = tool !== TOOL.prop;
    // Show the ring in the new tool's colour and at the new tool's size. Some
    // tools do not use the slider's number at all, and this is where you find
    // that out.
    refreshSizeReadout();
    flashCursor(1.4);
}

for (const button of document.querySelectorAll('[data-tool]')) {
    button.addEventListener('click', () => selectTool(TOOL[button.dataset.tool], button));
}

for (const button of document.querySelectorAll('[data-shape]')) {
    button.addEventListener('click', () => {
        state.mouldShape = MOULD_SHAPE[button.dataset.shape];
        for (const b of document.querySelectorAll('[data-shape]')) {
            b.classList.toggle('on', b === button);
        }
        flashCursor(1.2);
    });
}

// The prop picker is built from the kind list so the two cannot drift.
const propbar = document.getElementById('propbar');
PROP_KINDS.forEach((kind, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (i === 0 ? ' on' : '');
    b.innerHTML = `<span class="glyph">${kind.glyph}</span>`;
    b.title = kind.id;
    b.addEventListener('click', () => {
        state.propKind = i;
        for (const other of propbar.children) { other.classList.toggle('on', other === b); }
    });
    propbar.appendChild(b);
});

const sizeInput = document.getElementById('size');
const sizeValue = document.getElementById('sizeval');

/// The readout says what the *current tool* will use, not what the slider says,
/// because those are not always the same number — a mould turns out at 0.85 of
/// it and Place does not use it at all. Same source as the ring, so the number
/// and the picture cannot disagree.
function refreshSizeReadout() {
    sizeValue.textContent = state.tool === TOOL.prop
        ? '—'
        : `${cursorRadius().toFixed(1)} m`;
}

sizeInput.addEventListener('input', (e) => {
    state.radius = parseFloat(e.target.value);
    refreshSizeReadout();
    // The number and the ring move together, which is the only way a metre
    // means anything on a beach you are looking at from forty of them.
    flashCursor();
});
refreshSizeReadout();

document.getElementById('footprint').addEventListener('click', (e) => {
    state.shape = state.shape ? 0 : 1;
    e.currentTarget.classList.toggle('on', state.shape === 1);
    e.currentTarget.querySelector('.glyph').textContent = state.shape ? '◼' : '⬤';
    flashCursor(1.2);
});

// The hint has done its job the moment a finger lands on the beach.
const hint = document.getElementById('hint');
canvas.addEventListener('pointerdown', () => { hint.hidden = true; }, { once: true });

// Nine tools do not fit across a phone, so the bar scrolls — and a bar that
// scrolls without saying so is a bar whose last four tools do not exist. The
// fade on the right edge is the whole affordance; it goes away at the end.
const toolwrap = document.querySelector('.toolwrap');
const toolbar = toolwrap.querySelector('.tools');

function updateToolFade() {
    const remaining = toolbar.scrollWidth - toolbar.clientWidth - toolbar.scrollLeft;
    toolwrap.classList.toggle('atend', remaining <= 4);
}

toolbar.addEventListener('scroll', updateToolFade, { passive: true });
window.addEventListener('resize', updateToolFade);
window.addEventListener('orientationchange', () => setTimeout(updateToolFade, 160));

// --------------------------------------------------------------------- menu

const sheet = document.getElementById('sheet');
const slotList = document.getElementById('slots');

async function refreshSlots() {
    const entries = await storage.summarise();
    slotList.innerHTML = '';
    for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'slot';
        row.innerHTML = `<span class="slotname">Beach ${entry.slot + 1}</span>
                         <span class="slotinfo">${storage.describe(entry)}</span>`;

        const saveBtn = document.createElement('button');
        saveBtn.className = 'mini';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', async () => {
            const field = sim.snapshot();
            if (!field) { showToast('This device cannot read the sand back'); return; }
            await storage.save(entry.slot, {
                resolution: sim.resolution,
                field,
                props: props.snapshot(),
                camera: { yaw: camera.yaw, pitch: camera.pitch, distance: camera.distance,
                          target: camera.target.slice() },
            });
            showToast(`Saved to Beach ${entry.slot + 1}`);
            refreshSlots();
        });

        const loadBtn = document.createElement('button');
        loadBtn.className = 'mini';
        loadBtn.textContent = 'Load';
        loadBtn.disabled = entry.empty;
        loadBtn.addEventListener('click', async () => {
            const record = await storage.load(entry.slot);
            if (!record) { return; }
            if (!sim.restore(record.field, record.resolution)) {
                // Being explicit beats loading it at the wrong stride and
                // showing a shredded shore.
                showToast(`That beach was saved at ${record.resolution}², this device runs ${sim.resolution}²`);
                return;
            }
            props.replaceAll(record.props || []);
            if (record.camera) {
                camera.yaw = record.camera.yaw;
                camera.pitch = record.camera.pitch;
                camera.distance = record.camera.distance;
                camera.target = record.camera.target.slice();
            }
            showToast(`Loaded Beach ${entry.slot + 1}`);
            sheet.hidden = true;
        });

        row.append(saveBtn, loadBtn);
        slotList.appendChild(row);
    }
}

document.getElementById('menu').addEventListener('click', () => {
    sheet.hidden = !sheet.hidden;
    if (!sheet.hidden) { refreshSlots(); }
});
document.getElementById('closesheet').addEventListener('click', () => { sheet.hidden = true; });

const tideButton = document.getElementById('tide');
tideButton.addEventListener('click', () => {
    state.tide = !state.tide;
    env.erosion = state.tide ? 1.0 : 0.0;
    tideButton.classList.toggle('on', state.tide);
    tideButton.querySelector('.slotinfo').textContent = state.tide
        ? 'The sea works the shore' : 'The sea leaves it alone';
});

const panButton = document.getElementById('panmode');
panButton.addEventListener('click', () => {
    const on = !panButton.classList.contains('on');
    panButton.classList.toggle('on', on);
    input.setPanning(on);
    panButton.querySelector('.slotinfo').textContent = on
        ? 'Two fingers slide the beach' : 'Two fingers turn the beach';
});

document.getElementById('reset').addEventListener('click', () => {
    sim.reset(env.seaBase);
    props.clear();
    sheet.hidden = true;
    showToast('A fresh beach');
});

// ------------------------------------------------------------------- the loop

let last = performance.now();

// A frame-time watchdog, because this cannot be tested on every phone it will
// run on and a beach that renders at eight frames a second is not a beach.
//
// It only ever steps *down*, and only twice. A watchdog that also steps back up
// oscillates: it lowers the resolution, the frame time drops, it raises it
// again, and the picture pulses between two sharpnesses forever — which is far
// more distracting than simply running at the lower one.
const watchdog = { frames: 0, total: 0, steps: 0 };

function checkFrameTime(dt) {
    if (watchdog.steps >= 2) { return; }
    watchdog.frames++;
    watchdog.total += dt;
    if (watchdog.frames < 90) { return; }

    const mean = watchdog.total / watchdog.frames;
    watchdog.frames = 0;
    watchdog.total = 0;

    // 32 ms is about 30 fps. Below that the sand stops feeling like a material.
    if (mean > 0.032 && dprCap > 1.0) {
        dprCap = watchdog.steps === 0 ? 1.5 : 1.0;
        watchdog.steps++;
        resize();
        showToast('Eased the detail back to keep it smooth');
    }
}

/// Ease the ring toward what the tool state says it should be.
///
/// It arrives fast and leaves slowly on purpose. Appearing late reads as lag;
/// vanishing the instant you lift a finger reads as a bug, because the thing
/// you most want to look at is the hole you just made and where the tool was
/// when you made it.
function updateCursor(dt) {
    cursor.hold = Math.max(0, cursor.hold - dt);
    cursor.pulse = Math.max(0, cursor.pulse - dt * 3.2);

    cursor.radius = cursorRadius();
    cursor.shape = cursorShape();

    const tint = TOOL_TINT[state.tool] || TOOL_TINT[TOOL.dig];
    cursor.tint[0] = tint[0];
    cursor.tint[1] = tint[1];
    cursor.tint[2] = tint[2];

    const wantAlpha = (state.working || cursor.hold > 0) ? 1 : 0;
    const alphaRate = wantAlpha > cursor.alpha ? 14 : 4.5;
    cursor.alpha += (wantAlpha - cursor.alpha) * Math.min(1, alphaRate * dt);
    // An exponential fade never quite arrives. Cut the tail rather than leave a
    // one-per-cent ring sitting on the beach for the rest of the session.
    if (wantAlpha === 0 && cursor.alpha < 0.012) { cursor.alpha = 0; }

    const wantActive = state.working ? 1 : 0;
    cursor.active += (wantActive - cursor.active) * Math.min(1, 11 * dt);
}

function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    checkFrameTime(dt);
    env.time += dt;

    if (state.working) {
        state.strokeAge += dt;
        // Re-issue the ramp each frame so a finger held still keeps working and
        // eases in rather than arriving at full strength.
        sim.stroke.strength = Math.min(1, state.strokeAge / RAMP_SECONDS);
    }

    sim.step(dt, tier.substeps, env);
    updateCursor(dt);

    camera.update(canvas.width / canvas.height);
    renderer.draw(sim, camera, env, props, cursor);

    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// The page starts hidden so a failed context does not flash a dead UI first.
ui.hidden = false;

// Only now does the tool bar have a width to measure — a hidden element reports
// a scrollWidth of zero, which reads as "nothing more to scroll" and hides the
// very affordance that says otherwise.
requestAnimationFrame(updateToolFade);

function normalize3(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return new Float32Array([v[0] / l, v[1] / l, v[2] / l]);
}
