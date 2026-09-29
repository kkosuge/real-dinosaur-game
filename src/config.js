/* Real Dinosaur Game — tunable constants (classic script; also loadable in Node).
 * World units: logical height H = 540. Chrome's T-Rex Runner constants are scaled by K world units per Chrome px.
 * Units "per tick" are per fixed 1/60 s simulation step. */
(function (root) {
  'use strict';
  var RDG = (root.RDG = root.RDG || {});
  var H = 540;
  var K = 2.2;

  RDG.config = {
    VERSION: '1.4.1', // keep in step with sw.js (rdg-v1.4.1)
    H: H,
    K: K,
    ASPECT_MIN: 1.5,
    ASPECT_MAX: 3.2,
    HORIZON_Y: 0.74 * H, // distant plain meets mountains / sky
    GROUND_Y: 0.76 * H, // running line (feet / obstacle bases)

    // ---- fixed-step loop ----
    FPS: 60,
    STEP_MS: 1000 / 60,
    MAX_FRAME_MS: 250, // clamp after tab switch etc.
    MAX_STEPS_PER_FRAME: 10,

    // ---- touch ----
    // During a run a touch here ducks (fast-falls in the air); every other touch jumps. Fractions of the canvas:
    // left of x1 and below y0 = the bottom third of the LEFT half, so the right thumb (and a tap near the ground on
    // the right) always jumps. The renderer marks the zone for touch players (idle, pause, the first run's start,
    // GAME OVER until they have ducked by touch).
    TOUCH_DUCK_ZONE: { x1: 0.5, y0: 2 / 3 },
    TOUCH_GUIDE_FADE_MS: [5000, 7000], // first run: the duck-zone marker fades out between these run times
    MUTE_BUTTON: 44, // touch: CSS px hit square of the speaker button (top-left; idle, pause and GAME OVER only)

    // ---- share (src/share.js) ----
    // The URL the GAME OVER share button posts. '' = this page's address (origin + path, never the query / hash) when
    // it is a public http(s) host; nothing for file:, localhost, *.local and private / LAN addresses. Set it to the
    // game's public address to always link there (e.g. 'https://example.com/real-dinosaur-game/').
    SHARE_URL: '',

    // ---- asset loader ----
    // images still pending once this passes without any image arriving get placeholders (swapped for the real ones
    // on arrival); a slow but moving download is waited for up to LOAD_TIMEOUT_MAX_MS from the start
    LOAD_TIMEOUT_MS: 5000,
    LOAD_TIMEOUT_MAX_MS: 15000,

    // ---- actors (world units) ----
    DINO_HEIGHT: 104, // standing visible height (feet -> top of head)
    DINO_TAIL_X: 40, // world x of the tail tip
    DINO_LENGTH_RATIO: 1.75, // fallback only: the length is measured from the manifest (tailTipPx -> snout) when possible
    CACTUS_LARGE_H: 0.245 * H, // the reference saguaro is 0.25H (1.3x the dino)
    CACTUS_SMALL_H: 0.14 * H,
    CACTUS_OVERLAP: 0.1, // fraction of member width overlapping the previous member in a group
    CACTUS_OVERLAP_JITTER: 0.12,
    PTERO_WINGSPAN_RATIO: 0.8, // x dino length
    PTERO_ALT_MARGIN: 6, // clearance between ptero hitboxes and the dino (high / mid altitude)
    PTERO_LOW_CLEAR: 12, // height of the low ptero's lowest hitbox above the ground
    PTERO_VIS_CLEAR: 4, // min gap between the ptero's visible wingtips and the ground / the dino it passes over
    PTERO_ANIM_FPS: 8,

    // ---- Chrome physics scaled by K (per tick) ----
    SPEED: 6 * K,
    MAX_SPEED: 13 * K,
    ACCELERATION: 0.001 * K,
    GRAVITY: 0.6 * K,
    INITIAL_JUMP_VELOCITY: -10 * K, // minus speed / 10
    DROP_VELOCITY: -5 * K,
    MIN_JUMP_RISE: 30 * K, // release after this height cuts the jump
    MAX_JUMP_RISE: 63 * K, // holding: velocity is capped to DROP_VELOCITY above this rise
    SPEED_DROP_COEFFICIENT: 3, // fast-fall multiplier
    FAST_DROP_VELOCITY: 1 * K,
    JUMP_BUFFER_MS: 100, // a jump pressed this long before landing still fires on landing

    // ---- obstacles (Chrome semantics) ----
    SPAWN_X: 1800, // obstacles enter here (right of the widest possible viewport, 540 * 3.2 = 1728)
    REMOVE_MARGIN: 80,
    MAX_OBSTACLES: 10,
    CLEAR_TIME: 3000, // ms without obstacles after start
    GAP_COEFFICIENT: 0.6,
    MAX_GAP_COEFFICIENT: 1.5,
    MAX_OBSTACLE_DUPLICATION: 2,
    MAX_OBSTACLE_LENGTH: 3,
    // type order: 0 small cactus, 1 large cactus, 2 pterodactyl
    OBSTACLE_MIN_GAP: [120 * K, 120 * K, 150 * K],
    OBSTACLE_MULTIPLE_SPEED: [4 * K, 7 * K, 999 * K],
    OBSTACLE_MIN_SPEED: [0, 0, 8.5 * K],
    PTERO_SPEED_OFFSET: 0.8 * K,
    // fairness: every spawned obstacle must have a >= FAIR_MIN_WINDOW_TICKS timing window for some action, and the
    // gap to the previous obstacle must leave FAIR_SLACK_TICKS of reaction time after the previous one is cleared.
    FAIR_MIN_WINDOW_TICKS: 3,
    FAIR_SLACK_TICKS: 5,

    // ---- score / cycle ----
    SCORE_COEFFICIENT: 0.025 / K, // points per world unit
    ACHIEVEMENT_DISTANCE: 100,
    FLASH_DURATION: 250,
    FLASH_ITERATIONS: 3,
    NIGHT_DISTANCE: 700, // night starts at every multiple of this score
    NIGHT_DURATION: 12000, // ms from night trigger until dawn starts
    NIGHT_FADE: 2600, // ms day -> dusk -> night (and back)
    GAMEOVER_CLEAR_TIME: 750,
    MAX_SCORE: 99999,

    // ---- animation ----
    // at SPEED; grows with speed^RUN_CYCLE_SPEED_EXP. The real run cycle's planted foot travels ~0.37 x DINO_HEIGHT
    // per frame, so ~5 cycles/s is slide-free at SPEED; 4.6 keeps the feet nearly planted without a frantic cadence
    // at MAX_SPEED (~7 cycles/s = 28 frame changes/s).
    RUN_CYCLES_PER_SEC: 4.6,
    RUN_CYCLE_SPEED_EXP: 0.55,
    DUCK_CYCLES_PER_SEC: 3.2,
    IDLE_BLINK_PERIOD: 3.6, // s

    // ---- rendering ----
    // (render.js keeps its own render tunables in RC at the top of the file, e.g. the night actor grade, moon rim,
    // foreground decor count, ground shade and night cloud look; the keys below are the shared ones it reads)
    MAX_BACKING_PIXELS: 9.5e6,
    GROUND_FACTOR_HORIZON: 0.35, // ground scroll factor at HORIZON_Y (1.0 at GROUND_Y exactly)
    GROUND_FACTOR_BOTTOM: 2.7, // at the bottom edge
    GROUND_SLICES_MAX: 150,
    MOUNTAIN_SCROLL: 0.03,
    MOUNTAIN_FAR_SCROLL: 0.012,
    MOUNTAIN_PEAK_Y: 0.64 * H, // top of the tallest peak of the near range
    MOUNTAIN_FAR_SCALE: 0.62,
    GROUND_BAND_END: 0.8, // rows HORIZON_Y..(this fraction of the way to GROUND_Y) scroll as ONE rigid band so the
                          // distant scrub baked into the ground texture is not sheared apart; ramps to 1.0 at GROUND_Y
    CLOUD_COUNT: 7,
    CLOUD_WIDTH: [90, 170], // far -> near cloud width (world units); reference clouds are ~140-160u
    CLOUD_WIND: 0.0035, // world units per ms (idle drift is off; drift only while running)
    DECOR_PX_TO_U: 0.105, // decor sprite px -> world units at GROUND_Y (x row scale factor)
    DECOR_BG_COUNT: 72, // pebbles / tufts between the horizon and the running line
    DECOR_MID_COUNT: 38, // small stones just in front of the running line
    DECOR_SIZE: [0.9, 0.6, 1.4], // size multipliers per layer (bg, mid, fg)
    // the pre-blurred decor variants sit ~4.5 % of the sprite width above the canvas bottom (blur fade room):
    // shift them down by that much so they rest on the ground instead of hovering
    DECOR_BLUR_LIFT: { rock: 0.046, grass: 0.041 },
    DECOR_SHADOW: { rock: 0.3, grass: 0.16 }, // contact shadow opacity under mid / foreground decor
    SUN_BLOOM: 0.95, // day only: warm lens bloom in the top-left corner (screen blend), matches the reference glare
    SUN_BLOOM_RADIUS: 0.6, // x H
    VIGNETTE: 0.1, // corner darkening (the reference photo has almost none)
    SHAKE_MS: 380,
    SHAKE_AMPLITUDE: 7,
    HUD_FONT: 'bold {px}px "Courier New", Courier, "Liberation Mono", monospace',
    HUD_SIZE: 41, // measured on the reference: digits ~24u tall, 22.6u advance, right edge 70u from the edge
    HUD_ADVANCE: 0.55, // glyph advance in em
    HUD_RIGHT: 70,
    HUD_TOP: 53.5,
    HUD_COLOR_DAY: '#535353',
    HUD_COLOR_NIGHT: '#e2e6ee',
    // page colours: pillarbox side bands, theme-color and the loading frame (sampled from the assets at runtime when
    // possible; dusk / night ground colours are derived from the grade)
    PAGE_SKY_DAY: '#c2c4c7',
    PAGE_SKY_DUSK: '#6c7590',
    PAGE_SKY_NIGHT: '#0a101c',
    PAGE_GROUND_DAY: '#9c8773',
    // grading (multiply colours). Terrain = clouds, mountains, ground, decor; actors = dino, obstacles, dust.
    GRADE_DUSK: [240, 200, 174],
    GRADE_NIGHT: [88, 100, 134],
    NIGHT_LIFT: [8, 12, 20], // additive moonlight lift on terrain so the night stays readable
    MOUNTAIN_NIGHT_DARKEN: 0.5,
    ACTOR_GRADE_DUSK: [255, 222, 196],

    STORAGE_HI: 'rdg.hiScore',
    STORAGE_MUTE: 'rdg.muted'
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
