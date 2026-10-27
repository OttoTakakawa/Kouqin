import { timeline } from "./model.mjs";

const clamp = (value, low = 0, high = 1) =>
  Math.min(high, Math.max(low, value));

// Musical activity is an estimate, not chorus recognition. Explicit annotations win.
export function buildPerformance(score) {
  const sequence = timeline(score);
  const phrases = [];
  let phrase = { events: [], signature: [] };
  const firstEvents = new Map();
  for (const event of sequence.events)
    if (!firstEvents.has(event.index)) firstEvents.set(event.index, event);
  let noteIndex = -1;
  for (const note of score.notes) {
    noteIndex++;
    if (note.type === "break") {
      if (phrase.events.length) phrases.push(phrase);
      phrase = { events: [], signature: [] };
    } else if (note.type === "note") {
      phrase.events.push(firstEvents.get(noteIndex));
      phrase.signature.push(`${note.degree}:${note.octave}:${note.duration}`);
    }
  }
  if (phrase.events.length) phrases.push(phrase);
  const repeats = new Map();
  for (const row of phrases) {
    row.key = row.signature.join("/");
    repeats.set(row.key, (repeats.get(row.key) || 0) + 1);
    const voiced = row.events.filter((event) => event.note !== null);
    const seconds = row.events.reduce((sum, event) => sum + event.duration, 0);
    const density = voiced.length / Math.max(seconds, 0.25);
    const height = voiced.length
      ? voiced.reduce((sum, event) => sum + clamp((event.note - 60) / 20), 0) /
        voiced.length
      : 0;
    let movement = 0;
    for (let i = 1; i < voiced.length; i++)
      movement += Math.min(12, Math.abs(voiced[i].note - voiced[i - 1].note));
    row.activity = voiced.length
      ? clamp(
          0.13 +
            0.52 * clamp((density - 0.45) / 3.5) +
            0.2 * height +
            0.15 * clamp(movement / Math.max(1, voiced.length - 1) / 7),
        )
      : 0;
  }
  const minimum = Math.min(...phrases.map((row) => row.activity), 1);
  const maximum = Math.max(...phrases.map((row) => row.activity), 0);
  const byIndex = new Map();
  phrases.forEach((row, section) => {
    const contrast =
      maximum - minimum > 0.14
        ? (row.activity - minimum) / (maximum - minimum)
        : row.activity;
    const repetition =
      row.events.length >= 4 && repeats.get(row.key) > 1 ? 0.06 : 0;
    const automatic = clamp(
      row.activity * 0.76 + contrast * 0.19 + repetition,
      0.12,
      0.88,
    );
    const lastVoiced = row.events.findLastIndex((event) => event.note !== null);
    row.events.forEach((event, position) => {
      const annotation = score.notes[event.index].performance;
      const energy =
        event.note === null
          ? 0.08
          : annotation === "chorus"
            ? 1
            : annotation === "calm"
              ? 0.16
              : automatic;
      byIndex.set(event.index, {
        ...event,
        energy,
        section,
        last: position === lastVoiced,
        mode:
          event.note === null
            ? "rest"
            : annotation || (energy > 0.66 ? "surge" : "flow"),
      });
    });
  });
  return {
    ...sequence,
    byIndex,
    beatSeconds: (60 * (score.durationScale ?? 1)) / score.bpm,
  };
}

export function noteEnvelope(event, time) {
  if (
    !event ||
    event.note === null ||
    time < event.at ||
    time >= event.at + event.duration
  )
    return { attack: 0, sustain: 0, progress: 0 };
  const elapsed = time - event.at;
  const progress = clamp(elapsed / event.duration);
  return {
    attack: Math.exp(-elapsed / 0.14),
    sustain:
      Math.min(1, elapsed / 0.06) *
      Math.min(1, (event.duration - elapsed) / 0.12),
    progress,
  };
}

const palettes = {
  ink: { base: 206, sat: 40, light: 44, ink: 27 },
  forest: { base: 133, sat: 26, light: 42, ink: 24 },
  dark: { base: 205, sat: 44, light: 62, ink: 86 },
};

// One canvas, driven by the player's audio clock. No second animation clock or timers.
export class PerformanceStage {
  constructor(canvas, root) {
    this.canvas = canvas;
    this.root = root;
    this.context = canvas.getContext("2d");
    this.motion = matchMedia("(prefers-reduced-motion: reduce)");
    this.enabled = false;
    this.particles = [];
    this.waves = [];
    this.energy = 0;
    this.hue = null;
    this.previousIndex = -1;
    this.previousTime = null;
    this.node = null;
    this.bounds = null;
    this.resize = () => {
      this.width = 0;
      this.bounds = null;
    };
    window.addEventListener("resize", this.resize, { passive: true });
    root.addEventListener(
      "scroll",
      () => {
        this.bounds = null;
      },
      { passive: true },
    );
    this.motion.addEventListener("change", () => this.reset());
  }

  configure(enabled) {
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  reset() {
    this.particles.length = this.waves.length = 0;
    this.previousIndex = -1;
    this.previousTime = null;
    this.node = this.bounds = null;
    this.energy = 0;
    this.hue = null;
    document.body.classList.remove("stage-active");
    delete document.body.dataset.performance;
    for (const key of [
      "--stage-color",
      "--stage-ink",
      "--stage-alt",
      "--note-charge",
    ])
      this.root.style.removeProperty(key);
    if (this.context)
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  frame(time, event, node, beatSeconds) {
    if (
      !this.enabled ||
      this.motion.matches ||
      !this.context ||
      document.hidden
    ) {
      if (this.previousTime !== null) this.reset();
      return;
    }
    const changed =
      this.previousIndex !== event?.index || this.previousAt !== event?.at || time < this.previousTime;
    const dt =
      this.previousTime === null
        ? 0.016
        : clamp(time - this.previousTime, 0, 0.08);
    if (time < this.previousTime) this.particles.length = this.waves.length = 0;
    this.previousTime = time;
    const palette = palettes[document.body.dataset.theme] || palettes.ink;
    const target = event?.energy ?? 0.08;
    this.energy +=
      (target - this.energy) *
      (1 - Math.exp(-dt / (target > this.energy ? 0.4 : 0.85)));
    const beat = time / beatSeconds;
    // 色相锁在主题上：演出只调节明度与强度，不换颜色。
    // 曾经让色相在青/紫/粉/橙之间随能量转动，整屏会泛色、和墨蓝打架。
    const lift = this.energy * 8;
    const color = `hsl(${palette.base} ${palette.sat}% ${palette.light + lift}%)`;
    const alt = `hsl(${palette.base - 6} ${palette.sat - 8}% ${palette.light + 6 + lift}%)`;
    document.body.classList.add("stage-active");
    document.body.dataset.performance = event?.mode ?? "rest";
    this.root.style.setProperty("--stage-color", color);
    this.root.style.setProperty("--stage-alt", alt);
    this.root.style.setProperty(
      "--stage-ink",
      `hsl(${palette.base} ${palette.sat}% ${palette.ink}%)`,
    );
    const envelope = noteEnvelope(event, time);
    this.root.style.setProperty("--note-charge", String(envelope.sustain));
    if (changed) {
      this.previousIndex = event?.index ?? -1;
      this.previousAt = event?.at;
      this.node = node;
      this.bounds = null;
      this.released = false;
      // Seeking into a long note must not fake a new attack.
      if (node && event?.note !== null && time - event.at < 0.16) {
        const box = node.getBoundingClientRect();
        this.burst(box, time, event.energy, color, alt);
      }
    }
    if (
      node &&
      event?.last &&
      event.energy > 0.55 &&
      !this.released &&
      time >= event.at + event.duration - Math.min(0.15, event.duration * 0.25)
    ) {
      const box = node.getBoundingClientRect();
      this.waves.push({
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        at: time,
        color: alt,
      });
      this.waves = this.waves.slice(-5);
      this.released = true;
    }
    const ctx = this.context;
    this.fit();
    ctx.clearRect(0, 0, this.width, this.height);
    const dark = document.body.dataset.theme === "dark";
    this.ambient(ctx, beat, color, alt, dark);
    // 音符附近不再画任何东西：起音粒子会连成一圈虚线椭圆，长音光带像下划线，
    // 结束环又像靶子。读谱的时候，音符周围必须干净。
    // 音符本身的反馈交给 CSS 的 text-shadow —— 那层非常薄，不挡字。
  }

  fit() {
    const width = window.innerWidth,
      height = window.innerHeight;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (this.width === width && this.height === height && this.ratio === ratio)
      return;
    this.width = width;
    this.height = height;
    this.ratio = ratio;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  ambient(ctx, beat, color, alt, dark) {
    const energy = this.energy;
    const pulse = (0.5 + 0.5 * Math.cos(beat * Math.PI * 2)) ** 3;
    // 只留一层从顶部落下的淡光，随能量与节拍轻微起伏。
    // 之前这里是「两片铺满全屏的 wash + 5 道光束 + 4 条极光 + 35 个光点」，
    // 叠起来整屏泛色，音符反而糊了——可读性必须排在氛围前面。
    const gradient = ctx.createRadialGradient(
      this.width * 0.5,
      -this.height * 0.18,
      0,
      this.width * 0.5,
      -this.height * 0.18,
      this.height * 1.05,
    );
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, color.replace(/\)$/, " / 0)"));
    ctx.globalAlpha =
      (dark ? 0.05 : 0.035) + energy * 0.09 + pulse * energy * 0.035;
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalAlpha = 1;
  }

  burst(box, time, energy, color, alt) {
    const count = Math.round((this.width < 600 ? 7 : 10) + energy * 15);
    const x = box.x + box.width / 2,
      y = box.y + box.height * 0.72;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + time;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * (38 + energy * 125 + (i % 4) * 15),
        vy: Math.sin(angle) * (30 + energy * 95) - 30,
        at: time,
        life: 0.5 + (i % 4) * 0.12,
        size: 1.5 + (i % 3) * 0.9,
        color: i % 3 ? color : alt,
      });
    }
    this.particles = this.particles.slice(-160);
    this.waves = this.waves.slice(-5);
  }

  sustain(ctx, box, time, envelope, color, alt, duration) {
    const x = box.x + box.width / 2,
      y = box.bottom + 3;
    const energy = this.energy;
    const glow = ctx.createRadialGradient(
      x,
      y - box.height / 2,
      4,
      x,
      y - box.height / 2,
      65 + energy * 30,
    );
    glow.addColorStop(0, color);
    glow.addColorStop(1, color.replace(/\)$/, " / 0)"));
    ctx.fillStyle = glow;
    ctx.globalAlpha =
      (envelope.attack * 0.12 + envelope.sustain * 0.04) * energy;
    ctx.fillRect(x - 100, y - 130, 200, 200);
    // 长音不再画光带：那三条曲线落在音符下方，读谱时像下划线。
    // 椭圆描边同理，已经一并去掉——音符附近的线一律不做。
  }

  drawParticles(ctx, time) {
    this.particles = this.particles.filter(
      (particle) => time - particle.at < particle.life,
    );
    for (const particle of this.particles) {
      const age = time - particle.at,
        progress = age / particle.life;
      const x = particle.x + particle.vx * age,
        y = particle.y + particle.vy * age + 34 * age * age;
      ctx.globalAlpha = (1 - progress) ** 2 * 0.9;
      ctx.fillStyle = particle.color;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(progress * 2);
      ctx.shadowColor = particle.color;
      ctx.shadowBlur = this.energy > 0.6 ? 7 : 0;
      ctx.fillRect(
        -particle.size / 2,
        -particle.size / 2,
        particle.size,
        particle.size * (1 + this.energy),
      );
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  drawWaves(ctx, time) {
    this.waves = this.waves.filter((wave) => time - wave.at < 0.9);
    for (const wave of this.waves) {
      const progress = (time - wave.at) / 0.9;
      ctx.globalAlpha = (1 - progress) ** 2 * this.energy * 0.55;
      ctx.strokeStyle = wave.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const radius = 20 + progress * Math.min(320, this.width * 0.35);
      for (let i = 0; i <= 6; i++) {
        const angle = (i / 6) * Math.PI * 2 + progress * 0.22;
        const x = wave.x + Math.cos(angle) * radius,
          y = wave.y + Math.sin(angle) * radius * 0.35;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
