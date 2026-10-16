import { Soundfont } from "smplr";
import { timeline } from "./model.mjs";

export class Player {
  context = null;
  instrument = null;
  loading = null;
  playing = false;
  paused = false;
  offset = 0;
  position = 0;
  current = -1;
  gain = null;
  nodes = new Set();
  generation = 0;
  volume = 0.55;
  onFrame = () => {};
  onState = () => {};

  async init(voice) {
    this.context ||= new AudioContext();
    await this.context.resume();
    if (!this.gain) {
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
    }
    if (voice === "harmonica" && !this.instrument) {
      this.loading ||= (async () => {
        const instrument = Soundfont(this.context, {
          instrumentUrl: "/audio/harmonica-mp3.js",
          loopDataUrl: "/audio/harmonica-loop.json",
          destination: this.gain,
          extraGain: 1,
          volume: 70,
        });
        await instrument.ready;
        this.instrument = instrument;
      })().catch((e) => {
        this.loading = null;
        throw Error("口琴音色加载失败，可切换合成音重试。" + e.message);
      });
      await this.loading;
    }
  }

  setVolume(value) {
    this.volume = value;
    if (this.gain)
      this.gain.gain.setTargetAtTime(value, this.context.currentTime, 0.02);
  }

  async start(score, options) {
    this.stop();
    const generation = this.generation;
    this.onState("loading");
    try {
      await this.init(options.voice);
    } catch (e) {
      this.onState("stopped");
      throw e;
    }
    if (generation !== this.generation) return;
    this.sequence = timeline(score, options.start, options.end);
    if (!this.sequence.events.length) {
      this.onState("stopped");
      throw Error("这一段还没有音符。");
    }
    this.voice = options.voice;
    this.loop = options.loop;
    this.offset = 0;
    this.paused = false;
    this.playing = true;
    this.schedule();
  }

  schedule() {
    this.epoch = this.context.currentTime + 0.035;
    this.next = this.sequence.events.findIndex(
      (e) => e.at + e.duration > this.offset + 0.00001,
    );
    if (this.next < 0) this.next = this.sequence.events.length;
    this.onState("playing");
    // Audio scheduling continues when rendering is throttled; animation reads the same clock.
    this.tickTimer = setInterval(() => this.tick(), 25);
    this.tick();
    const draw = () => {
      if (!this.playing) return;
      this.onFrame(this.position, this.sequence.duration, this.current);
      this.raf = requestAnimationFrame(draw);
    };
    this.raf = requestAnimationFrame(draw);
  }

  tick() {
    this.position = Math.max(
      0,
      this.context.currentTime - this.epoch + this.offset,
    );
    if (this.position >= this.sequence.duration) {
      this.silence();
      if (this.loop) {
        this.offset = 0;
        this.schedule();
      } else {
        this.playing = false;
        this.paused = false;
        this.onFrame(this.sequence.duration, this.sequence.duration, -1);
        this.onState("stopped");
      }
      return;
    }
    while (
      this.next < this.sequence.events.length &&
      this.sequence.events[this.next].at < this.position + 0.13
    ) {
      const e = this.sequence.events[this.next++];
      const elapsed = Math.max(0, this.offset - e.at);
      if (e.note !== null)
        this.sound(
          e.note,
          Math.max(this.context.currentTime, this.epoch + e.at - this.offset),
          e.duration - elapsed,
        );
    }
    this.current =
      this.sequence.events.find(
        (e) => e.at <= this.position && e.at + e.duration > this.position,
      )?.index ?? -1;
  }

  sound(note, time, duration) {
    if (this.voice === "harmonica") {
      this.instrument.start({ note, time, duration, velocity: 85 });
      return;
    }
    const osc = this.context.createOscillator(),
      envelope = this.context.createGain();
    osc.type = "triangle";
    osc.frequency.value = 440 * 2 ** ((note - 69) / 12);
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(
      0.32,
      time + Math.min(0.015, duration / 4),
    );
    envelope.gain.setValueAtTime(
      0.32,
      time + Math.max(0.016, duration - 0.025),
    );
    envelope.gain.linearRampToValueAtTime(0, time + duration);
    osc.connect(envelope);
    envelope.connect(this.gain);
    this.nodes.add(osc);
    osc.onended = () => {
      this.nodes.delete(osc);
      osc.disconnect();
      envelope.disconnect();
    };
    osc.start(time);
    osc.stop(time + duration + 0.005);
  }

  pause() {
    if (!this.playing) return;
    this.offset = Math.min(this.sequence.duration, this.position);
    this.silence();
    this.playing = false;
    this.paused = true;
    this.onState("paused");
  }
  async resume() {
    await this.context.resume();
    this.paused = false;
    this.playing = true;
    this.schedule();
  }
  silence() {
    clearInterval(this.tickTimer);
    cancelAnimationFrame(this.raf);
    this.instrument?.stop();
    for (const osc of this.nodes) {
      try {
        osc.stop();
      } catch {}
    }
    this.nodes.clear();
  }
  stop() {
    this.generation++;
    this.silence();
    this.playing = false;
    this.paused = false;
    this.offset = 0;
    this.position = 0;
    this.current = -1;
    this.onState("stopped");
    this.onFrame(0, this.sequence?.duration || 0, -1);
  }
}
