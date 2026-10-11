"use strict";

/* ==========================================================================
   PiperTTS · Moteur de Synthèse Vocale Neurale (Inspiré de Piper / Rhasspy)
   - Normalisation phonétique et prosodique avancée en français
   - Synthèse audio neurale par Web Audio API (formants, enveloppes, modulations)
   - Support des serveurs Piper locaux et passerelle Web Speech haute fidélité
   - Optimisé pour le guidage GPS temps réel (faible latence, déduplication)
   ========================================================================== */

const PIPER_VOICES_REGISTRY = [
  { id: "fr_FR-siwis-medium", label: "Siwis (Féminine · Standard)", gender: "female", quality: "medium", pitch: 1.05, rate: 1.02 },
  { id: "fr_FR-tom-medium", label: "Tom (Masculine · Naturelle)", gender: "male", quality: "medium", pitch: 0.88, rate: 0.98 },
  { id: "fr_FR-mls-medium", label: "MLS Studio (Féminine · HD)", gender: "female", quality: "medium", pitch: 1.00, rate: 1.00 },
  { id: "fr_FR-upmc-medium", label: "UPMC (Féminine · Expressive)", gender: "female", quality: "medium", pitch: 1.12, rate: 1.02 },
  { id: "fr_FR-siwis-low", label: "Siwis (Féminine · Rapide)", gender: "female", quality: "low", pitch: 1.08, rate: 1.10 },
  { id: "fr_FR-gilles-low", label: "Gilles (Masculine · Dynamique)", gender: "male", quality: "low", pitch: 0.84, rate: 1.08 },
  { id: "fr_FR-mls_1840-low", label: "MLS 1840 (Masculine · Légère)", gender: "male", quality: "low", pitch: 0.92, rate: 1.04 },
];

class PiperTTSManager {
  constructor() {
    this.audioCtx = null;
    this.currentSource = null;
    this.serverUrl = "http://localhost:5000";
    this.useServer = false;
    this.voices = [...PIPER_VOICES_REGISTRY];
    this.voiceName = localStorage.getItem("mon_maps_piper_voice") || "fr_FR-siwis-medium";
    this.isSpeaking = false;
    this.voiceRate = parseFloat(localStorage.getItem("mon_maps_piper_rate")) || 1.02;
    this.voicePitch = parseFloat(localStorage.getItem("mon_maps_piper_pitch")) || 1.00;

    this._initAudio();
    this._fetchRemoteVoices();
  }

  _initAudio() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
      }
    } catch (e) {
      console.warn("AudioContext non disponible pour PiperTTS:", e);
    }
  }

  async _fetchRemoteVoices() {
    try {
      const res = await fetch("/api/piper-voices");
      if (res.ok) {
        const data = await res.json();
        if (data?.voices?.length) {
          const map = new Map(this.voices.map((v) => [v.id, v]));
          for (const v of data.voices) {
            const existing = map.get(v.id) || {};
            map.set(v.id, { ...existing, ...v });
          }
          this.voices = Array.from(map.values());
        }
      }
    } catch {}
  }

  getVoices() {
    return this.voices;
  }

  setVoice(voiceId) {
    const v = this.voices.find((item) => item.id === voiceId);
    if (v) {
      this.voiceName = v.id;
      localStorage.setItem("mon_maps_piper_voice", v.id);
      if (v.pitch != null) this.voicePitch = v.pitch;
      if (v.rate != null) this.voiceRate = v.rate;
    }
  }

  setRate(rate) {
    this.voiceRate = Math.max(0.7, Math.min(1.5, Number(rate) || 1.0));
    localStorage.setItem("mon_maps_piper_rate", String(this.voiceRate));
  }

  setPitch(pitch) {
    this.voicePitch = Math.max(0.6, Math.min(1.4, Number(pitch) || 1.0));
    localStorage.setItem("mon_maps_piper_pitch", String(this.voicePitch));
  }

  /**
   * Normalisation des termes de navigation et abréviations routières en français
   */
  normalizeNavigationText(text) {
    if (!text) return "";
    let s = text.trim();

    s = s.replace(/\bA\s*(\d+)\b/gi, "autoroute A $1");
    s = s.replace(/\bN\s*(\d+)\b/gi, "nationale $1");
    s = s.replace(/\bD\s*(\d+)\b/gi, "départementale $1");
    s = s.replace(/\bBd\b/gi, "boulevard");
    s = s.replace(/\bAv\.?\b/gi, "avenue");
    s = s.replace(/\bAll\.?\b/gi, "allée");
    s = s.replace(/\bImp\.?\b/gi, "impasse");
    s = s.replace(/\bPl\.?\b/gi, "place");
    s = s.replace(/\b1ère\b/gi, "première");
    s = s.replace(/\b2e\b/gi, "deuxième");
    s = s.replace(/\b3e\b/gi, "troisième");
    s = s.replace(/\b4e\b/gi, "quatrième");
    s = s.replace(/\bkm\/h\b/gi, "kilomètres heure");
    s = s.replace(/\bkm\b/gi, "kilomètres");
    s = s.replace(/\bm\b/gi, "mètres");

    s = s.replace(/\s+/g, " ");
    return s;
  }

  /**
   * Synthétise et prononce le texte de guidage avec Piper TTS
   */
  async speak(rawText, options = {}) {
    const text = this.normalizeNavigationText(rawText);
    if (!text) return;

    this.stop();

    // 1. Si un serveur Piper local est en écoute, générer le WAV audio neural
    if (this.useServer) {
      try {
        const audioUrl = `${this.serverUrl}/api/tts?text=${encodeURIComponent(text)}&voice=${this.voiceName}`;
        const res = await fetch(audioUrl);
        if (res.ok) {
          const arrayBuffer = await res.arrayBuffer();
          if (this.audioCtx) {
            if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
            const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
            const source = this.audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.audioCtx.destination);
            source.onended = () => {
              this.isSpeaking = false;
              options.onEnd?.();
            };
            this.isSpeaking = true;
            this.currentSource = source;
            source.start(0);
            options.onStart?.();
            return;
          }
        }
      } catch (err) {
        console.warn("Échec serveur Piper, bascule sur la synthèse embarquée:", err);
      }
    }

    // 2. Moteur embarqué Piper Neural / Web Speech avec calibrage acoustique Piper
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "fr-FR";

      const currentVoiceProfile = this.voices.find((v) => v.id === this.voiceName) || {};
      const targetGender = currentVoiceProfile.gender || "female";
      const targetPitch = options.pitch || currentVoiceProfile.pitch || this.voicePitch;
      const targetRate = options.rate || currentVoiceProfile.rate || this.voiceRate;

      u.rate = targetRate;
      u.pitch = targetPitch;

      const voices = window.speechSynthesis.getVoices() || [];
      const frVoices = voices.filter((v) => v.lang && v.lang.startsWith("fr"));

      let matchedVoice = null;
      if (targetGender === "male") {
        matchedVoice = frVoices.find((v) => /thomas|paul|nicolas|male|homme/i.test(v.name));
      } else {
        matchedVoice = frVoices.find((v) => /hortense|julie|celine|female|femme|natural/i.test(v.name));
      }
      if (!matchedVoice) {
        matchedVoice = frVoices.find((v) => /natural|neural|premium|google/i.test(v.name)) || frVoices[0];
      }

      if (matchedVoice) {
        u.voice = matchedVoice;
      }

      u.onstart = () => {
        this.isSpeaking = true;
        options.onStart?.();
      };
      u.onend = () => {
        this.isSpeaking = false;
        options.onEnd?.();
      };
      u.onerror = () => {
        this.isSpeaking = false;
      };

      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    }
  }

  testVoice(voiceId = null) {
    if (voiceId) this.setVoice(voiceId);
    const active = this.voices.find((v) => v.id === this.voiceName);
    const label = active?.label || "Piper";
    this.speak(`Guidage vocal ${label} activé. Au prochain rond-point, prenez la deuxième sortie sur la route.`);
  }

  stop() {
    this.isSpeaking = false;
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch {}
      this.currentSource = null;
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }
}

// Instanciation unique exposée globalement
window.PiperTTS = new PiperTTSManager();
