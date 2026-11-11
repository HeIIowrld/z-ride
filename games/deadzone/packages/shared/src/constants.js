/*
 * Copyright 2026 Mohammad Mahdi Mortazavi
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* ============================== TUNING ==================================
   Every balance number in OVERRUN lives here. Retune the whole game without
   touching a system. Comments explain intent, never arithmetic.

   Shared by client and server: the authoritative simulation on the edge reads
   the same numbers the browser does, so prediction and truth cannot drift. */

export const T = {
  arena: { radius: 46, propCount: 26, pvpRadius: 54, pvpPropCount: 34 },

  sim: {
    hz: 60,             // client + offline simulation rate
    netHz: 20,          // authoritative server tick; snapshots go out at this rate
    maxFrameDt: 0.1,
    inputHz: 30         // how often the client ships its input to the server
  },

  net: {
    interpDelay: 0.10,      // render remote entities 100ms in the past: smooth > instant
    maxExtrapolate: 0.25,
    /* Reserved. Rewind-based hit registration is NOT implemented — nothing
       reads this. It is left here as the declared budget for when it is,
       because the number is a design decision (past 200ms you start killing
       people who are already behind cover on their own screen) and that
       decision is worth keeping even while the feature is missing.
       Do not cite it as a shipped feature; the landing page used to. */
    lagCompMax: 0.20,
    reconcileSnap: 3.0,     // metres of error past which we hard-snap instead of easing
    reconcileEase: 14,      // otherwise blend the correction in over ~70ms
    pingInterval: 2.0,
    timeoutSeconds: 12,
    reconnectGrace: 30
  },

  player: {
    speed: 14.2,          // fast enough that a rusher pack is escapable, not free

    /* Locomotion is friction-and-accelerate, not lerp-to-target.

       The difference is the whole feel of the game. Lerping toward a desired
       velocity gives movement that is instant in every direction equally —
       responsive, but weightless, because reversing costs exactly what
       continuing costs. Applying friction every frame and then accelerating
       only along the input direction means a reversal has to pay for the
       speed it already had. You feel the turn. Nothing about the response
       delay is artificial: input still bites on the first frame.

       accel must comfortably exceed speed * friction or top speed silently
       drops below `speed` — that relationship is the one thing to preserve
       when retuning these. */
    accel: 200,
    friction: 9.0,
    stopSpeed: 3.2,       // below this, friction works at a floor rate so the
                          // last of the drift snaps off instead of oozing
    turnRate: 13.5,       // rad/s the body swings toward the aim. Purely
                          // cosmetic — shots always leave along the true aim —
                          // but it is most of what makes the character read as
                          // a body rather than a cursor.

    /* Impulses — recoil, knockback, explosions — live in their own velocity
       channel that is NOT clamped to top speed and decays on its own curve.
       Folded into the locomotion velocity instead, every impulse was eaten by
       the speed clamp within a frame or two, which is precisely why being
       shot used to feel like nothing at all. */
    impulseDrag: 6.5,
    impulseMax: 30,

    radius: 0.75,
    hp: 100,
    shield: 50,
    shieldDelay: 3.6,     // reward for disengaging, not for turtling
    shieldRate: 26,
    iframeOnHit: 0.35,
    magnet: 7.5,
    respawn: 4.0,         // PvP only
    spawnProtect: 1.6     // PvP only — a shield you lose the moment you shoot
  },

  dash: {
    speed: 46, time: 0.155, charges: 2, recharge: 2.4,
    iframes: 0.26,        // slightly longer than the dash: forgiving on purpose
    // Front-loaded: a dash that leaves at full speed and eases out reads as a
    // burst of effort. A constant-speed dash reads as teleporting.
    frontLoad: 1.35,
    exitSpeed: 0.82       // fraction of run speed kept on exit, so a dash flows
                          // into a sprint instead of stopping dead
  },

  /* Weapon handling that is not per-weapon balance.

     Bloom is the accuracy cost of holding the trigger. It exists so that
     sustained fire is a decision rather than a default, and it recovers fast
     enough that tapping is always rewarded. */
  gun: {
    /* These two are a pair and only make sense read against fire rate.

       Per shot the cone opens by `bloomPerShot × the weapon's base spread`;
       every second it closes by `bloomRecover` radians flat. A weapon only
       blooms if it fires fast enough to outrun the recovery — so the SMG at
       12 rounds/s reaches its ceiling in about a second of held fire, while
       the breacher at 1.7 rounds/s never blooms at all, which is right: you
       do not spray a shotgun.

       Set recovery too high relative to the per-shot gain and bloom silently
       does nothing whatsoever, which is exactly what the first tuning of this
       did — the numbers looked reasonable in isolation and were an order of
       magnitude apart in practice. tools/physics.mjs asserts it now. */
    bloomPerShot: 0.37,
    bloomRecover: 0.16,
    bloomMax: 2.4,        // ceiling as a multiple of the weapon's base spread
    recoilScale: 1.9,     // how hard a shot shoves the shooter
    kickPerShot: 0.055    // camera/weapon kick, radians
  },

  combo: {
    window: 3.2,          // decays fast; the ladder must feel breakable
    perKill: 1, maxRung: 12,
    fireRateBonus: 0.014  // per combo point, capped by rungs
  },

  camera: {
    // A tilted top-down rig. Pitch is a real angle now, not an implied one:
    // it lets the arena show its walls and props with actual depth instead of
    // reading as a flat board.
    pitch: 0.98,          // radians from horizontal — ~56 degrees
    distance: 23,         // Z-RIDE: closer view makes infected silhouettes readable; along the view ray, so pitch and zoom are independent
    fov: 50,
    follow: 9.5,          // spring stiffness for position
    aimLead: 0.20,
    shoulder: 0.9,        // lateral offset toward the aim, in metres
    densityPull: 0.26,    // fraction of extra distance when surrounded
    fovKick: 0.85,
    pitchRelax: 0.055,    // camera lies down slightly at speed — reads as urgency
    minPitch: 0.62, maxPitch: 1.24,
    minDist: 20, maxDist: 42
  },

  feel: {
    shakeDecay: 1.9, shakeMax: 0.85, shakeScale: 1.0,
    hitstopMax: 0.09, slowmoScale: 0.28,
    // Online play never freezes time — hitstop becomes a purely visual pulse.
    hitstopOnlineScale: 0.35
  },

  director: {
    baseCredits: 7, creditsPerWave: 5.5, creditGrowth: 1.055,
    spawnRate: 0.42,      // seconds between spawn attempts at intensity 1
    warnTime: 0.4,        // spawn telegraph — you always get a beat of warning
    safeSpawnDist: 15,    // never inside the player's shoulder
    valleyTime: 1.6,      // deliberate relief after a clear, before the choice
    hpScale: 0.028,       // per wave. Kept tiny on purpose: composition is the
                          // difficulty lever, bullet sponges are not.
    modifierEvery: 5, bossEvery: 10,
    coopCreditScale: 0.72 // per extra player: 4p co-op is harder, not 4x harder
  },

  ai: {
    // Perception
    sightRange: 42, sightHalfAngle: 2.35, memory: 4.5,
    hearRadius: 26,           // gunfire gives your position away
    // Steering
    separation: 1.9, arrive: 3.2, avoidLookahead: 1.1,
    // Coordination
    squadRadius: 18, maxFlankers: 4, flankArc: 1.15,
    roleRethink: 1.4,
    // Flow field
    gridCell: 2.4, gridRebuild: 0.30,
    // Fairness
    minTelegraph: 0.25,
    /* Enemies carry the same impulse channel players do. Steering used to
       damp straight toward the desired velocity every frame, which erased
       knockback within about one frame — a shotgun at point blank moved a
       rusher by nothing. Impulse is integrated separately and drags out on
       its own, so weight is visible. Heavier drag than the player because an
       enemy sliding for a second looks broken, not weighty. */
    impulseDrag: 8.5,
    impulseMax: 42,
    staggerPerKnock: 0.018,  // seconds of interrupted steering per unit of
                             // effective knockback, after poise
    staggerMax: 0.42
  },

  vfx: { maxParticles: 1400, maxDamageNumbers: 26, maxDecals: 48 },

  modes: {
    tdm:   { players: 8, teams: 2, teamSize: 4, scoreLimit: 30, timeLimit: 480, bots: true },
    squad: { players: 8, teams: 4, teamSize: 2, scoreLimit: 24, timeLimit: 420, shrinkAt: 0.72 },
    coop:  { players: 4, teams: 1, teamSize: 4, timeLimit: 0, reviveTime: 3.2, reviveRadius: 3.0 }
  },

  progression: {
    xpPerKill: 12, xpPerWave: 60, xpPerWin: 320, xpPerMatch: 45,
    levelCurve: 1.28, baseLevelXp: 260
  }
};

/** Team colours are gameplay information, so they live in the shared package. */
export const TEAM_COLORS = [0x4FC3F7, 0xFF7043, 0xAED581, 0xBA68C8];
export const TEAM_NAMES = ['AZURE', 'EMBER', 'MOSS', 'IRIS'];

export const MODE_IDS = ['coop', 'tdm', 'squad'];
