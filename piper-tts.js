"use strict";

/* ==========================================================================
   PiperTTS · Moteur de Synthèse Vocale Haute Fidélité pour Navigation GPS
   - Intégration native des modèles neuronaux Piper ONNX (/api/tts)
   - Normalisation phonétique, prosodique et grammaticale avancée en français
   - Chaîne acoustique Web Audio API (égalisation chaleur, lissage HF, compresseur)
   - Passerelle Web Speech HD priorisant les voix neuronales naturelles (Edge Natural, Chrome, Apple HD)
   - Cache audio intelligent pour une latence nulle en guidage temps réel
   ========================================================================== */

// Gestionnaire de stockage sécurisé résistant au blocage "Tracking Prevention" (Edge / Safari / Chrome)
var safeStorage = window.safeStorage = (() => {
  const mem = new Map();
  let available = false;
  try {
    const k = "__maps_test__";
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(k, "1");
      window.localStorage.removeItem(k);
      available = true;
    }
  } catch {}
  return {
    getItem(key) {
      if (available) {
        try { return window.localStorage.getItem(key); } catch {}
      }
      return mem.has(key) ? mem.get(key) : null;
    },
    setItem(key, val) {
      if (available) {
        try { window.localStorage.setItem(key, val); return; } catch {}
      }
      mem.set(key, String(val));
    },
    removeItem(key) {
      if (available) {
        try { window.localStorage.removeItem(key); return; } catch {}
      }
      mem.delete(key);
    }
  };
})();
if (typeof window !== "undefined") {
  window.safeStorage = safeStorage;
}

const PIPER_VOICES_REGISTRY = [
  { id: "fr_FR-siwis-medium", label: "Siwis (Féminine · Claire & Naturelle)", gender: "female", quality: "medium", pitch: 1.0, rate: 1.0 },
  { id: "fr_FR-tom-medium", label: "Tom (Masculine · Naturelle & Posée)", gender: "male", quality: "medium", pitch: 1.0, rate: 0.98 },
  { id: "fr_FR-mls-medium", label: "MLS Studio (Féminine · Studio HD)", gender: "female", quality: "medium", pitch: 1.0, rate: 1.0 },
  { id: "fr_FR-upmc-medium", label: "UPMC (Féminine · Expressive & Chaleureuse)", gender: "female", quality: "medium", pitch: 1.0, rate: 1.0 },
  { id: "fr_FR-siwis-low", label: "Siwis Rapide (Féminine · Fluide)", gender: "female", quality: "low", pitch: 1.0, rate: 1.04 },
  { id: "fr_FR-gilles-low", label: "Gilles (Masculine · Dynamique)", gender: "male", quality: "low", pitch: 1.0, rate: 1.02 },
  { id: "fr_FR-mls_1840-low", label: "MLS 1840 (Masculine · Douce)", gender: "male", quality: "low", pitch: 1.0, rate: 1.0 },
];

class PiperTTSManager {
  constructor() {
    this.audioCtx = null;
    this.currentSource = null;
    this.currentUtterance = null;
    this.serverUrl = typeof window !== "undefined" ? window.location.origin : "";
    this.backendAvailable = false;
    this.backendEngine = "web-speech-hd";
    this.voices = [...PIPER_VOICES_REGISTRY];
    this.voiceName = safeStorage.getItem("mon_maps_piper_voice") || "fr_FR-siwis-medium";
    this.selectedVoiceURI = safeStorage.getItem("mon_maps_selected_voice_uri") || "";
    this.isSpeaking = false;
    this.voiceRate = parseFloat(safeStorage.getItem("mon_maps_piper_rate")) || 1.0;
    this.voicePitch = parseFloat(safeStorage.getItem("mon_maps_piper_pitch")) || 1.0;

    // File d'attente et déduplication pour éviter que les instructions ne se coupent la parole
    this.queuedSpeech = null;
    this.lastSpokenText = "";
    this.lastSpokenTime = 0;

    // Cache audio en mémoire pour rejouer instantanément les instructions fréquentes
    this.audioCache = new Map();
    this.cachedUtterances = new Map();

    // Filtres acoustiques Web Audio API
    this.warmthFilter = null;
    this.smoothFilter = null;
    this.compressor = null;

    this._initAudio();
    this._initSpeechVoices();
    this._checkBackend();
    this._fetchRemoteVoices();
  }

  /**
   * Initialise le pipeline acoustique Web Audio pour adoucir le rendu vocal
   */
  _initAudio() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      this.audioCtx = new AudioContextClass();

      // 1. Rehaussement doux des bas-médiums (chaleur du timbre vocal)
      this.warmthFilter = this.audioCtx.createBiquadFilter();
      this.warmthFilter.type = "lowshelf";
      this.warmthFilter.frequency.value = 240;
      this.warmthFilter.gain.value = 1.8;

      // 2. Atténuation subtile des très hautes fréquences (suppression du côté métallique/nasillard)
      this.smoothFilter = this.audioCtx.createBiquadFilter();
      this.smoothFilter.type = "highshelf";
      this.smoothFilter.frequency.value = 9500;
      this.smoothFilter.gain.value = -2.2;

      // 3. Compresseur de dynamique pour homogénéiser le volume en environnement bruité
      this.compressor = this.audioCtx.createDynamicsCompressor();
      this.compressor.threshold.value = -18;
      this.compressor.knee.value = 18;
      this.compressor.ratio.value = 3.0;
      this.compressor.attack.value = 0.005;
      this.compressor.release.value = 0.20;

      // Chaînage
      this.warmthFilter.connect(this.smoothFilter);
      this.smoothFilter.connect(this.compressor);
      this.compressor.connect(this.audioCtx.destination);
    } catch (e) {
      console.warn("AudioContext non disponible pour PiperTTS:", e);
    }
  }

  /**
   * Surveillance du chargement asynchrone des voix du navigateur
   */
  _initSpeechVoices() {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const onVoices = () => {
      this._findBestWebSpeechVoice();
      this._dispatchEngineStatus();
      window.dispatchEvent(new CustomEvent("piper-voices-ready"));
    };

    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = onVoices;
    }
    // Appel immédiat si les voix sont déjà en cache mémoire du navigateur
    onVoices();
  }

  /**
   * Vérifie si le serveur local dispose du moteur Piper natif ONNX
   */
  async _checkBackend() {
    // Si l'application tourne sur Live Server (ex: port 5500 ou autre serveur statique sans backend Node)
    // On évite d'émettre des requêtes 404 inutiles dans la console
    const isStaticServer = typeof window !== "undefined" && (window.location.port === "5500" || window.location.protocol === "file:");
    if (isStaticServer) {
      this.backendAvailable = false;
      this.backendEngine = "web-speech-hd";
      this._dispatchEngineStatus();
      return;
    }

    try {
      const res = await fetch("/api/tts/status");
      if (res.ok) {
        const data = await res.json();
        this.backendAvailable = Boolean(data.piperAvailable);
        this.backendEngine = data.engine || (this.backendAvailable ? "piper-native" : "web-speech-hd");
        this._dispatchEngineStatus();
      } else {
        this.backendAvailable = false;
        this.backendEngine = "web-speech-hd";
      }
    } catch {
      this.backendAvailable = false;
      this.backendEngine = "web-speech-hd";
    }
  }

  async _fetchRemoteVoices() {
    const isStaticServer = typeof window !== "undefined" && (window.location.port === "5500" || window.location.protocol === "file:");
    if (isStaticServer) return;
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

  _dispatchEngineStatus() {
    const detail = this.getEngineStatus();
    window.dispatchEvent(new CustomEvent("piper-engine-status", { detail }));
  }

  getEngineStatus() {
    const rawVoices = typeof window !== "undefined" && "speechSynthesis" in window ? (window.speechSynthesis.getVoices() || []) : [];
    let activeWebVoice = null;
    if (this.selectedVoiceURI) {
      activeWebVoice = rawVoices.find((v) => v.voiceURI === this.selectedVoiceURI || v.name === this.selectedVoiceURI);
    }
    if (!activeWebVoice) {
      activeWebVoice = this._findBestWebSpeechVoice();
    }

    const activePiper = this.voices.find((v) => v.id === this.voiceName);
    const isPiperActive = this.backendAvailable && !this.selectedVoiceURI;

    let displayLabel = activePiper?.label || "Piper TTS";
    if (this.selectedVoiceURI && activeWebVoice) {
      displayLabel = activeWebVoice.name;
    } else if (activeWebVoice) {
      displayLabel = activeWebVoice.name;
    }

    return {
      backendAvailable: this.backendAvailable,
      engine: isPiperActive ? "piper-native" : "web-speech-hd",
      voiceId: this.selectedVoiceURI ? `web:${this.selectedVoiceURI}` : (activePiper?.id || this.voiceName),
      voiceLabel: displayLabel,
      webVoiceName: activeWebVoice?.name || "Synthèse vocale système",
      selectedVoiceURI: this.selectedVoiceURI,
    };
  }

  getVoices() {
    return this.voices;
  }

  /**
   * Retourne la liste RÉELLE et complète des voix installées dans le navigateur/système
   * Triées et catégorisées par région (Belgique, France, etc.) et fidélité
   */
  getRealAvailableVoices() {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return { belgian: [], french: [], otherFr: [], allFr: [], piper: this.voices };
    }
    const rawList = window.speechSynthesis.getVoices() || [];
    const fr = rawList.filter((v) => v.lang && v.lang.toLowerCase().startsWith("fr"));

    const belgian = [];
    const french = [];
    const otherFr = [];

    fr.forEach((v) => {
      const l = (v.lang || "").toLowerCase();
      const n = (v.name || "").toLowerCase();
      const isBe = l.includes("be") || n.includes("belgium") || n.includes("belgique") || n.includes("charline") || n.includes("gerard");
      const isFr = (l.includes("fr") || l === "fr") && !isBe && !l.includes("ca") && !l.includes("ch");

      // Nettoyage esthétique du nom de la voix
      let cleanName = v.name;
      cleanName = cleanName.replace(/Microsoft\s+/i, "");
      cleanName = cleanName.replace(/\s+Online\s+\(Natural\)/i, " (HD Naturelle)");
      cleanName = cleanName.replace(/\s+-\s+French\s+\([^)]+\)/i, "");

      const isNatural = n.includes("natural") || n.includes("online") || n.includes("neural") || n.includes("google") || n.includes("siri") || n.includes("enhanced");
      const isFemale = /denise|charline|eloise|brigitte|audrey|celine|julie|hortense|sylvie|charlotte|female|femme/i.test(n);
      const genderTag = isFemale ? "Féminine" : "Masculine";

      const item = {
        name: v.name,
        voiceURI: v.voiceURI || v.name,
        displayName: `${cleanName} · ${genderTag}${isNatural ? " ⚡ HD" : ""}`,
        lang: v.lang,
        gender: isFemale ? "female" : "male",
        isNatural,
        isBelgian: isBe,
        rawVoice: v,
      };

      if (isBe) belgian.push(item);
      else if (isFr) french.push(item);
      else otherFr.push(item);
    });

    const sortFn = (a, b) => (b.isNatural ? 1 : 0) - (a.isNatural ? 1 : 0) || a.displayName.localeCompare(b.displayName);
    belgian.sort(sortFn);
    french.sort(sortFn);
    otherFr.sort(sortFn);

    return {
      belgian,
      french,
      otherFr,
      allFr: [...belgian, ...french, ...otherFr],
      piper: this.voices,
    };
  }

  setVoice(voiceIdOrKey) {
    if (!voiceIdOrKey) return;

    if (voiceIdOrKey.startsWith("web:")) {
      this.selectedVoiceURI = voiceIdOrKey.slice(4);
      safeStorage.setItem("mon_maps_selected_voice_uri", this.selectedVoiceURI);
      safeStorage.setItem("mon_maps_piper_voice", voiceIdOrKey);
      this._dispatchEngineStatus();
      return;
    }

    if (voiceIdOrKey.startsWith("piper:")) {
      this.selectedVoiceURI = "";
      safeStorage.removeItem("mon_maps_selected_voice_uri");
      this.voiceName = voiceIdOrKey.slice(6);
      safeStorage.setItem("mon_maps_piper_voice", this.voiceName);
      this._dispatchEngineStatus();
      return;
    }

    const v = this.voices.find((item) => item.id === voiceIdOrKey);
    if (v) {
      this.voiceName = v.id;
      this.selectedVoiceURI = "";
      safeStorage.removeItem("mon_maps_selected_voice_uri");
      safeStorage.setItem("mon_maps_piper_voice", v.id);
      if (v.pitch != null) this.voicePitch = v.pitch;
      if (v.rate != null) this.voiceRate = v.rate;
      this._dispatchEngineStatus();
      return;
    }

    // Identifiant direct d'une voix Web Speech (URI ou nom)
    this.selectedVoiceURI = voiceIdOrKey;
    safeStorage.setItem("mon_maps_selected_voice_uri", this.selectedVoiceURI);
    safeStorage.setItem("mon_maps_piper_voice", `web:${voiceIdOrKey}`);
    this._dispatchEngineStatus();
  }

  setRate(rate) {
    this.voiceRate = Math.max(0.8, Math.min(1.3, Number(rate) || 1.0));
    safeStorage.setItem("mon_maps_piper_rate", String(this.voiceRate));
  }

  setPitch(pitch) {
    this.voicePitch = Math.max(0.85, Math.min(1.15, Number(pitch) || 1.0));
    safeStorage.setItem("mon_maps_piper_pitch", String(this.voicePitch));
  }

  /**
   * Normalisation phonétique, grammaticale et prosodique avancée en français
   * Transforme les abréviations routières brutes en phrases fluides et naturelles
   */
  normalizeNavigationText(text) {
    if (!text) return "";
    let s = String(text).trim();

    // 1. Remplacement des points de suspension et doubles espaces pour une respiration naturelle
    s = s.replace(/\s*…\s*/g, ", ");
    s = s.replace(/\s*\.{3}\s*/g, ", ");

    // 2. Distances et vitesses en unités naturelles parlées
    // Note: on traite 'mètres' d'abord, puis 'm' avec lookahead strict pour ne jamais toucher à 'mètres'
    s = s.replace(/(\d+)\s*mètres?\b/gi, (match, n) => (Number(n) === 1 ? "1 mètre" : `${n} mètres`));
    s = s.replace(/(\d+)\s*m(?![a-zA-ZÀ-ÿ0-9])/gi, (match, n) => (Number(n) === 1 ? "1 mètre" : `${n} mètres`));
    s = s.replace(/(\d+(?:[.,]\d+)?)\s*kilomètres?\b/gi, (match, n) => `${n.replace(".", " virgule ")} kilomètres`);
    s = s.replace(/(\d+(?:[.,]\d+)?)\s*km(?![a-zA-ZÀ-ÿ0-9])/gi, (match, n) => `${n.replace(".", " virgule ")} kilomètres`);
    s = s.replace(/(\d+)\s*km\/h\b/gi, "$1 kilomètres-heure");

    // 3. Ordinaux et sorties de carrefours giratoires
    s = s.replace(/\b1(?:ère|re|er)\b/gi, "première");
    s = s.replace(/\b2(?:ème|nd|nde|e)\b/gi, "deuxième");
    s = s.replace(/\b3(?:ème|e)\b/gi, "troisième");
    s = s.replace(/\b4(?:ème|e)\b/gi, "quatrième");
    s = s.replace(/\b5(?:ème|e)\b/gi, "cinquième");
    s = s.replace(/\b6(?:ème|e)\b/gi, "sixième");

    // 4. Réseau routier et autoroutier belge et français avec liaison naturelle
    s = s.replace(/\bE\s*(\d+)\b/gi, "l'autoroute E $1");
    s = s.replace(/\bR\s*([0-9]+)\b/gi, "le Ring R $1");
    s = s.replace(/\bA\s*(\d+)\b/gi, "l'autoroute A $1");
    s = s.replace(/\b(?:RN|N)\s*(\d+)\b/gi, "la route nationale $1");
    s = s.replace(/\b(?:RD|D)\s*(\d+)\b/gi, "la départementale $1");
    s = s.replace(/\bM\s*(\d+)\b/gi, "la métropolitaine $1");
    s = s.replace(/\bC\s*(\d+)\b/gi, "la voie communale $1");

    // 5. Types de voies et abréviations toponymiques
    s = s.replace(/\b(?:Bd|Bvd)\.?\b/gi, "boulevard");
    s = s.replace(/\bAv\.?\b/gi, "avenue");
    s = s.replace(/\bAll\.?\b/gi, "allée");
    s = s.replace(/\bImp\.?\b/gi, "impasse");
    s = s.replace(/\bPl\.?\b/gi, "place");
    s = s.replace(/\bSq\.?\b/gi, "square");
    s = s.replace(/\bRte\.?\b/gi, "route");
    s = s.replace(/\bPass\.?\b/gi, "passage");
    s = s.replace(/\bCh\.?\b/gi, "chemin");
    s = s.replace(/\bSent\.?\b/gi, "sentier");
    s = s.replace(/\bPont\b/gi, "pont");
    s = s.replace(/\bSt[\s-]/gi, "Saint-");
    s = s.replace(/\bSte[\s-]/gi, "Sainte-");
    s = s.replace(/\bDir\.?\b/gi, "direction");
    s = s.replace(/\bN°\s*(\d+)\b/gi, "numéro $1");

    // 6. Articles naturels devant les voies ("sur Rue de Paris" -> "sur la rue de Paris")
    s = s.replace(/\bsur\s+rue\b/gi, "sur la rue");
    s = s.replace(/\bsur\s+avenue\b/gi, "sur l'avenue");
    s = s.replace(/\bsur\s+allée\b/gi, "sur l'allée");
    s = s.replace(/\bsur\s+impasse\b/gi, "sur l'impasse");
    s = s.replace(/\bsur\s+boulevard\b/gi, "sur le boulevard");
    s = s.replace(/\bsur\s+route\b/gi, "sur la route");
    s = s.replace(/\bsur\s+chemin\b/gi, "sur le chemin");
    s = s.replace(/\bsur\s+place\b/gi, "sur la place");

    // 7. Élimination des cassures prosodiques (minusculiser après les virgules de timing)
    // Ex: "Dans 300 mètres, Au rond-point" -> "Dans 300 mètres, au rond-point"
    s = s.replace(/,\s+([A-ZÀ-ÖØ-ß])/g, (match, letter) => {
      // Préserver les sigles ou noms propres évidents
      if (match.includes("A ") || match.includes("Saint")) return match;
      return `, ${letter.toLowerCase()}`;
    });

    // 8. Nettoyage de la ponctuation résiduelle
    s = s.replace(/\s*,\s*,+/g, ", ");
    s = s.replace(/\s+/g, " ").trim();

    // Assurer un point final pour une intonation descendante naturelle en fin de phrase
    if (s && !/[.!?]$/.test(s)) s += ".";

    return s;
  }

  /**
   * Sélectionne la meilleure voix neuronale haute fidélité disponible dans le navigateur
   * Priorité absolue aux voix Microsoft Online Natural (Denise/Henri), Google et Apple Neural
   * Exclut expressément les anciennes voix robotiques Windows SAPI 5 Desktop
   */
  _findBestWebSpeechVoice(targetGender = "female") {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
    const allVoices = window.speechSynthesis.getVoices() || [];
    const frVoices = allVoices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("fr"));
    if (!frVoices.length) return allVoices[0] || null;

    const scoreVoice = (v) => {
      const name = (v.name || "").toLowerCase();
      let score = 0;

      // Bonus maximal : voix neuronales en ligne Edge (Denise Online, Henri Online)
      if (name.includes("online") && name.includes("natural")) score += 200;
      else if (name.includes("natural") || name.includes("neural")) score += 150;
      else if (name.includes("google")) score += 90;
      else if (name.includes("enhanced") || name.includes("premium")) score += 80;
      else if (name.includes("microsoft") && !name.includes("desktop")) score += 40;

      // Malus éliminatoire : anciennes voix robotiques Windows SAPI 5 Desktop (Hortense / Paul Desktop)
      if (name.includes("desktop") || name.includes("sapi")) score -= 300;

      // Détection du genre vocal
      const isFemale = /denise|hortense|julie|celine|eloise|brigitte|audrey|aurelie|female|femme/i.test(name);
      const isMale = /henri|paul|thomas|alain|jerome|nicolas|male|homme/i.test(name);

      if (targetGender === "female" && isFemale) score += 70;
      if (targetGender === "male" && isMale) score += 70;

      // Bonus pour le français de Belgique ou de France
      if (v.lang === "fr-BE" || name.includes("belgium") || name.includes("belgique") || name.includes("charline") || name.includes("gerard")) score += 40;
      if (v.lang === "fr-FR" || v.lang === "fr_FR") score += 25;

      return score;
    };

    frVoices.sort((a, b) => scoreVoice(b) - scoreVoice(a));
    return frVoices[0] || null;
  }

  /**
   * Joue un AudioBuffer avec le chaînage acoustique de réchauffement vocal
   */
  _playAudioBuffer(audioBuffer, options = {}) {
    if (!this.audioCtx) return false;

    if (this.audioCtx.state === "suspended") {
      this.audioCtx.resume().catch(() => {});
    }

    try {
      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;

      // Connexion aux filtres acoustiques si disponibles, sinon destination directe
      if (this.warmthFilter) {
        source.connect(this.warmthFilter);
      } else {
        source.connect(this.audioCtx.destination);
      }

      source.onended = () => {
        this.isSpeaking = false;
        this.currentSource = null;
        options.onEnd?.();
      };

      this.isSpeaking = true;
      this.currentSource = source;
      source.start(0);
      options.onStart?.();
      return true;
    } catch (e) {
      console.warn("Échec lecture buffer audio:", e);
      return false;
    }
  }

  /**
   * Synthétise et prononce le texte de guidage avec Piper TTS
   * Gère une file d'attente fluide sans couper la parole intempestivement
   */
  speak(rawText, options = {}) {
    const text = this.normalizeNavigationText(rawText);
    if (!text) return;

    const now = Date.now();
    // Déduplication : ne pas répéter la même instruction dans les 3,5 secondes
    if (text === this.lastSpokenText && now - this.lastSpokenTime < 3500 && !options.force) {
      return;
    }

    // Si une instruction est déjà en cours et qu'on ne force pas l'interruption :
    // On la met en attente pour la jouer dès la fin sans se couper la parole !
    if (this.isSpeaking && !options.force) {
      this.queuedSpeech = { text, options, time: now };
      return;
    }

    this._executeSpeak(text, options);
  }

  async _executeSpeak(text, options = {}) {
    this.stop(false);

    this.lastSpokenText = text;
    this.lastSpokenTime = Date.now();
    this.isSpeaking = true;

    const onComplete = () => {
      this.isSpeaking = false;
      this.currentSource = null;
      this.currentUtterance = null;
      options.onEnd?.();

      // Traiter l'instruction en file d'attente s'il y en a une récente (< 6s)
      if (this.queuedSpeech) {
        const next = this.queuedSpeech;
        this.queuedSpeech = null;
        if (Date.now() - next.time < 6000 && next.text !== this.lastSpokenText) {
          // Pause respiratoire naturelle de 280ms
          setTimeout(() => {
            this._executeSpeak(next.text, next.options);
          }, 280);
        }
      }
    };

    const currentProfile = this.voices.find((v) => v.id === this.voiceName) || {};
    const targetGender = currentProfile.gender || "female";
    const cacheKey = `${this.voiceName}::${text}`;

    // 1. Lecture instantanée depuis le cache audio mémoire (latence = 0 ms)
    if (this.audioCache.has(cacheKey)) {
      const cachedBuffer = this.audioCache.get(cacheKey);
      if (this._playAudioBuffer(cachedBuffer, { ...options, onEnd: onComplete })) {
        return;
      }
    }

    // 2. Moteur neuronal Piper natif ONNX via /api/tts
    try {
      const rateVal = options.rate || this.voiceRate || 1.0;
      const audioUrl = `/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(this.voiceName)}&rate=${rateVal}`;
      const res = await fetch(audioUrl);

      if (res.ok && res.headers.get("content-type")?.includes("audio/wav")) {
        const arrayBuffer = await res.arrayBuffer();
        if (this.audioCtx) {
          if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
          const decodedBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);

          // Mémorisation en cache
          if (this.audioCache.size > 80) {
            const firstKey = this.audioCache.keys().next().value;
            this.audioCache.delete(firstKey);
          }
          this.audioCache.set(cacheKey, decodedBuffer);

          this.backendAvailable = true;
          this.backendEngine = "piper-native";
          this._playAudioBuffer(decodedBuffer, { ...options, onEnd: onComplete });
          return;
        }
      }
    } catch {
      // Serveur injoignable ou en erreur, bascule transparente sur le moteur HD
    }

    // 3. Moteur Web Speech HD (Voix neuronales naturelles du navigateur)
    if ("speechSynthesis" in window) {
      this.backendEngine = "web-speech-hd";
      const u = new SpeechSynthesisUtterance(text);
      const allWebVoices = window.speechSynthesis.getVoices() || [];

      let matchedVoice = null;
      if (this.selectedVoiceURI) {
        matchedVoice = allWebVoices.find((v) => v.voiceURI === this.selectedVoiceURI || v.name === this.selectedVoiceURI);
      }
      if (!matchedVoice) {
        matchedVoice = this._findBestWebSpeechVoice(targetGender);
      }

      if (matchedVoice) {
        u.voice = matchedVoice;
        u.lang = matchedVoice.lang || "fr-FR";
      } else {
        u.lang = "fr-FR";
      }

      u.onstart = () => {
        this.isSpeaking = true;
        options.onStart?.();
      };
      u.onend = () => {
        onComplete();
      };
      u.onerror = () => {
        onComplete();
      };

      this.currentUtterance = u;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    }
  }

  testVoice(voiceId = null) {
    if (voiceId) this.setVoice(voiceId);
    const active = this.voices.find((v) => v.id === this.voiceName);
    const label = active?.label || "Piper";
    this.speak(
      `Guidage vocal ${label} activé. Dans 300 mètres, au rond-point, prenez la deuxième sortie sur l'avenue de la République.`,
      { force: true }
    );
  }

  stop(clearQueue = true) {
    if (clearQueue) {
      this.queuedSpeech = null;
    }
    this.isSpeaking = false;
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch {}
      this.currentSource = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try { window.speechSynthesis.cancel(); } catch {}
      this.currentUtterance = null;
    }
  }
}

// Instanciation unique exposée globalement
window.PiperTTS = new PiperTTSManager();
