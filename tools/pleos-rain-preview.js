// Load in the local Pleos Virtual Console's Forest view for rehearsal capture.
// Use the Console's vehicle and wiper readings as inputs to the visual effect.
(() => {
  if (typeof drawWindshieldEffects !== 'function' || typeof vehicle === 'undefined' ||
      typeof cockpitFeatures === 'undefined' || typeof rCtx === 'undefined') {
    throw new Error('Pleos Virtual Console windshield renderer is unavailable');
  }
  // The capture tab observes the emulator. Disable the Console's local
  // pedal integrator, which would otherwise publish its own coasting speed.
  if (typeof queueCommit === 'function') queueCommit = () => {};
  if (typeof physicsTick === 'function') physicsTick = () => {};
  const drops = Array.from({ length: 58 }, (_, index) => ({
    x: (index * 0.61803398875) % 1,
    y: (index * 0.41421356237) % 1,
    size: 0.65 + ((index * 13) % 19) / 30,
  }));
  let previousTime = null, previousSpeed = null, acceleration = 0, sweep = 0, wetness = 1;
  let tunnel = null;
  const wrap = value => ((value % 1) + 1) % 1;
  const rates = { Auto: .7, Low: 1.05, High: 1.9 };

  // A rehearsal route marker. Advance through it using the emulator speed.
  window.setZrideTunnel = (approachM, lengthM) => {
    if (!Number.isFinite(approachM) || !Number.isFinite(lengthM) || approachM < 0 || lengthM <= 0) {
      throw new RangeError('Expected a nonnegative approach and positive tunnel length');
    }
    tunnel = { position: -approachM, length: lengthM };
  };

  function drawTunnel(width, height, distance, inside) {
    const horizon = height * .48, center = width * .5;
    const zoom = Math.min(2.8, 19 / Math.max(2, distance));
    const half = width * .26 * zoom, rise = height * .33 * zoom;
    const floor = horizon + height * .2 * zoom;
    const arch = (extra) => {
      rCtx.moveTo(center-half-extra, floor+extra);
      rCtx.lineTo(center-half-extra, horizon);
      rCtx.quadraticCurveTo(center-half-extra, horizon-rise-extra, center, horizon-rise-extra);
      rCtx.quadraticCurveTo(center+half+extra, horizon-rise-extra, center+half+extra, horizon);
      rCtx.lineTo(center+half+extra, floor+extra);
      rCtx.closePath();
    };
    rCtx.beginPath();
    if (inside) {
      rCtx.moveTo(0,0);
      rCtx.lineTo(width,0);
      rCtx.lineTo(width,height);
      rCtx.lineTo(0,height);
      rCtx.closePath();
      rCtx.fillStyle='#3b3c40';
    } else {
      arch(Math.max(5,12*zoom));
      rCtx.fillStyle='#6c7070';
    }
    arch(0);
    rCtx.fill('evenodd');
    if (inside) {
      rCtx.strokeStyle='rgba(234,190,112,.68)';
      rCtx.lineWidth=2;
      for (const side of [-1,1]) {
        rCtx.beginPath();
        rCtx.moveTo(center+side*half, horizon-rise*.46);
        rCtx.lineTo(center+side*width*.47, height*.14);
        rCtx.stroke();
      }
    }
  }

  drawWindshieldEffects = (width, height) => {
    const mode = cockpitFeatures.wipers.front.mode;
    const now = performance.now() / 1000;
    const dt = previousTime === null ? 0 : Math.min(.08, now - previousTime);
    previousTime = now;
    const speed = Math.min(100, Math.abs(Number(vehicle.speed_kph) || 0));
    if (tunnel) {
      tunnel.position += speed / 3.6 * dt;
      if (tunnel.position >= tunnel.length) tunnel = null;
    }
    const inside = tunnel !== null && tunnel.position >= 0;
    if (tunnel) drawTunnel(width,height,inside ? tunnel.length-tunnel.position : -tunnel.position,inside);
    const steering = Math.max(-1, Math.min(1, (Number(vehicle.steering_deg) || 0) / 540));
    const frameAcceleration = dt > 0 && previousSpeed !== null
      ? Math.max(-30, Math.min(30, (speed - previousSpeed) / dt))
      : 0;
    previousSpeed = speed;
    acceleration += (frameAcceleration - acceleration) * (1 - Math.exp(-5 * dt));
    const fall = .38 + speed * .010;
    const drift = (.055 + steering * .48) * speed / 60;
    const length = 9 + speed * .40 + Math.abs(acceleration) * .13;
    if (!rates[mode]) return;
    wetness = inside ? wetness * Math.exp(-3.2 * dt) : 1;

    const baseX = width * .5, baseY = height * .96, radius = height * .78;
    sweep += rates[mode] * dt;
    const angle = -Math.cos(sweep * Math.PI * 2) * .72;
    rCtx.save();
    rCtx.lineCap = 'round';
    let visibleDrops = 0;
    for (const drop of drops) {
      drop.x = wrap(drop.x + drift * dt * drop.size);
      drop.y += fall * dt * drop.size;
      if (!inside) drop.y = wrap(drop.y);
      if (drop.y > 1 || wetness < .035) continue;
      visibleDrops++;
      const x = drop.x * width, y = drop.y * height * .9;
      const dx = x - baseX, dy = baseY - y;
      const wiped = dy > 0 && Math.hypot(dx, dy) < radius &&
        Math.abs(Math.atan2(dx, dy) - angle) < .16;
      rCtx.strokeStyle = `rgba(185,218,238,${(wiped ? .14 : .58)*wetness})`;
      rCtx.lineWidth = drop.size * 1.2;
      rCtx.beginPath();
      rCtx.moveTo(x, y);
      rCtx.lineTo(x - drift * length * drop.size, y - length * drop.size);
      rCtx.stroke();
    }
    rCtx.strokeStyle = 'rgba(13,19,22,.82)';
    rCtx.lineWidth = 4;
    rCtx.beginPath();
    rCtx.moveTo(baseX, baseY);
    rCtx.lineTo(baseX + Math.sin(angle) * radius, baseY - Math.cos(angle) * radius);
    rCtx.stroke();
    rCtx.restore();
    window.zrideWindshieldSample = {
      speed, steering, mode, fall, drift, length, inside,
      freshDrops: inside ? 0 : drops.length, visibleDrops,
    };
  };
})();
