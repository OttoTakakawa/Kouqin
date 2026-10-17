import { Soundfont } from "smplr";
import { timeline } from "./model.mjs";
import harmonicaLoops from "./audio/harmonica-loops-calibrated.json";
import musyngkiteLoops from "./audio/musyngkite-loops-calibrated.json";
import musyngkiteSource from "./audio/musyngkite-harmonica-mp3.js";

import generaluserLoops from "./audio/generaluser-loops.json";
import generaluserSource from "./audio/generaluser-harmonica-mp3.js";
import vcslNormalLoops from "./audio/vcsl-normal-loops.json";
import vcslNormalSource from "./audio/vcsl-normal-harmonica-mp3.js";
import vcslSoftLoops from "./audio/vcsl-soft-loops.json";
import vcslSoftSource from "./audio/vcsl-soft-harmonica-mp3.js";
import vcslVibLoops from "./audio/vcsl-vib-loops.json";
import vcslVibSource from "./audio/vcsl-vib-harmonica-mp3.js";

const sampledVoices = {
  harmonica: {
    url: "/audio/harmonica-mp3.js",
    loops: harmonicaLoops,
    gain: 20,
  },
  musyngkite: {
    url:
      "data:text/plain;charset=utf-8," + encodeURIComponent(musyngkiteSource),
    loops: musyngkiteLoops,
    gain: 20,
  },
  generaluser: {
    url:
      "data:text/plain;charset=utf-8," + encodeURIComponent(generaluserSource),
    loops: generaluserLoops,
    gain: 20,
  },
  "vcsl-normal": {
    url:
      "data:text/plain;charset=utf-8," + encodeURIComponent(vcslNormalSource),
    loops: vcslNormalLoops,
    gain: 4.5,
  },
  "vcsl-soft": {
    url: "data:text/plain;charset=utf-8," + encodeURIComponent(vcslSoftSource),
    loops: vcslSoftLoops,
    gain: 8,
  },
  "vcsl-vib": {
    url: "data:text/plain;charset=utf-8," + encodeURIComponent(vcslVibSource),
    loops: vcslVibLoops,
    gain: 3,
  },
};

export class Player {
  context = null;
  instruments = new Map();
  loading = new Map();
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
    const bank = sampledVoices[voice];
    if (bank && !this.instruments.has(voice)) {
      if (!this.loading.has(voice)) {
        const pending = (async () => {
          const instrument = Soundfont(this.context, {
            instrumentUrl: bank.url,
            loopDataUrl:
              "data:application/json," +
              encodeURIComponent(JSON.stringify(bank.loops)),
            destination: this.gain,
            extraGain: bank.gain,
            volume: 100,
          });
          await instrument.ready;
          this.instruments.set(voice, instrument);
        })().catch((e) => {
          this.loading.delete(voice);
          throw Error("口琴音色加载失败，可切换其他音色重试。" + e.message);
        });
        this.loading.set(voice, pending);
      }
      await this.loading.get(voice);
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
    this.offset =
      this.sequence.events.find(
        (e) => e.index >= (options.initialIndex ?? options.start ?? 0),
      )?.at ?? 0;
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
      this.offset,
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
    if (sampledVoices[this.voice]) {
      this.instruments
        .get(this.voice)
        .start({ note, time, duration, velocity: 85 });
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
    for (const instrument of this.instruments.values()) instrument.stop();
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
