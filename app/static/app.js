// Foundry Voice Live Studio - browser client.
// Speaks the Voice Live realtime protocol (JSON events over WebSocket) through the
// local gateway (/ws), which adds Microsoft Entra ID auth. See README for the protocol.

const $ = (id) => document.getElementById(id);

const SAMPLE_PROMPTS = [
  "What can you do, and what is Voice Live doing in this conversation?",
  "Search Microsoft Learn: which regions support Voice Live avatars?",
  "What's the weather in Seattle right now?",
  "Tell me a long story about a dragon who learns to code.",
  "¿Puedes seguir la conversación en español?",
  "Explain semantic voice activity detection in one sentence.",
];

// Rough mouth openness (0..1) for each Azure viseme ID (0-21).
const VISEME_OPENNESS = [0, .7, 1, .8, .6, .5, .4, .3, .6, .9, .7, .9, .5, .4, .4, .2, .3, .2, .15, .3, .4, 0];

const state = {
  ws: null,
  serverConfig: {},
  sessionReady: false,
  micOn: false,
  pttActive: false,
  captureCtx: null,
  mediaStream: null,
  playCtx: null,
  nextPlayTime: 0,
  activeSources: [],
  responseAudioStart: null,
  pendingTimed: [],
  timers: [],
  latencyStart: null,
  latencyMeasured: false,
  assistantEl: null,
  userEls: new Map(),
  pendingFunctionOutputs: [],
  responseActive: false,
  followUpPending: false,
  pc: null,
  avatarRequested: false,
  avatarActive: false,
  greetingSent: false,
  audioOut: 0,
  audioIn: 0,
};

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
init();

async function init() {
  bindRangeOutputs();
  bindVisibility();
  renderSamplePrompts();

  $("connectBtn").onclick = () => (state.ws ? disconnect() : connect());
  $("micBtn").onclick = () => setMic(!state.micOn);
  $("stopBtn").onclick = () => {
    send({ type: "response.cancel" });
    stopPlayback();
  };
  $("applyLive").onclick = () => {
    const session = buildSession();
    delete session.avatar; // avatar and input format are fixed for the session
    delete session.input_audio_sampling_rate;
    send({ type: "session.update", session });
    addMessage("system", "Sent session.update with the current settings.");
  };
  $("composer").onsubmit = (e) => {
    e.preventDefault();
    sendText($("textInput").value.trim());
    $("textInput").value = "";
  };
  $("toggleInspector").onclick = () => ($("inspector").hidden = !$("inspector").hidden);
  $("clearEvents").onclick = () => ($("events").innerHTML = "");
  const ptt = $("pttBtn");
  ptt.onpointerdown = () => startPushToTalk();
  ptt.onpointerup = ptt.onpointerleave = () => endPushToTalk();

  try {
    const res = await fetch("/api/config");
    state.serverConfig = await res.json();
  } catch {
    state.serverConfig = {};
  }
  const cfg = state.serverConfig;
  $("model").innerHTML = (cfg.models || []).map((m) => `<option>${m}</option>`).join("");
  $("accessCodeRow").hidden = !cfg.accessCodeRequired;
  if (!cfg.agentModeAvailable) {
    $("mode").value = "model";
    $("mode").querySelector('option[value="agent"]').disabled = true;
  }
  $("agentInfo").textContent = cfg.agentModeAvailable
    ? `Agent "${cfg.agentName}" in project "${cfg.projectName}" on ${cfg.endpointHost}. Voice defaults are stored on the agent; the settings below override them for this session.`
    : "No agent configured on the server (AGENT_NAME / FOUNDRY_PROJECT_NAME). Direct model mode only.";
  updateVisibility();
}

function bindRangeOutputs() {
  const pairs = {
    temperature: "temperatureOut", voiceTemperature: "voiceTempOut", voiceRate: "rateOut",
    vadThreshold: "vadThresholdOut", silenceMs: "silenceOut", prefixMs: "prefixOut", interimLatency: "interimLatencyOut",
  };
  for (const [input, output] of Object.entries(pairs)) {
    const update = () => ($(output).textContent = $(input).value);
    $(input).addEventListener("input", update);
    update();
  }
}

function bindVisibility() {
  for (const id of ["mode", "voiceType", "avatarKind", "greeting", "vadType", "avatarEnabled"]) {
    $(id).addEventListener("change", updateVisibility);
  }
}

function updateVisibility() {
  const mode = $("mode").value;
  document.querySelectorAll("[data-show]").forEach((el) => (el.hidden = el.dataset.show !== mode));
  document.querySelectorAll("[data-voice]").forEach((el) => (el.hidden = el.dataset.voice !== $("voiceType").value));
  document.querySelectorAll("[data-avatar]").forEach((el) => (el.hidden = el.dataset.avatar !== $("avatarKind").value));
  document.querySelectorAll("[data-greeting]").forEach((el) => (el.hidden = el.dataset.greeting !== $("greeting").value));
  const vt = $("voiceType").value;
  document.querySelector("[data-voice-rate]").hidden = vt === "openai" || vt === "azure-realtime-native";
  $("pttBtn").hidden = $("vadType").value !== "none";
}

function renderSamplePrompts() {
  $("samples").innerHTML = "";
  for (const prompt of SAMPLE_PROMPTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ghost";
    b.textContent = prompt;
    b.onclick = () => sendText(prompt);
    $("samples").appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Session configuration (session.update payload)
// ---------------------------------------------------------------------------
function buildSession() {
  const mode = $("mode").value;
  const session = {
    modalities: ["text", "audio"],
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
    input_audio_sampling_rate: Number($("sampleRate").value),
    voice: buildVoice(),
    turn_detection: buildTurnDetection(),
    input_audio_transcription: buildTranscription(),
  };

  const ns = $("noiseSuppression").value;
  if (ns) session.input_audio_noise_reduction = { type: ns };
  if ($("serverEc").checked) session.input_audio_echo_cancellation = { type: "server_echo_cancellation" };

  const interim = $("interim").value;
  const latency = Number($("interimLatency").value);
  if (interim === "llm") {
    session.interim_response = {
      type: "llm_interim_response",
      triggers: ["latency", "tool"],
      latency_threshold_ms: latency,
      instructions: "Say a very short, natural filler such as 'Let me check that for you.' Never answer the question itself.",
    };
  } else if (interim === "static") {
    session.interim_response = {
      type: "static_interim_response",
      triggers: ["latency", "tool"],
      latency_threshold_ms: latency,
      texts: ["One moment please.", "Let me check that for you.", "Just a second."],
    };
  }

  if ($("wordTimestamps").checked) session.output_audio_timestamp_types = ["word"];
  if ($("visemes").checked) session.animation = { outputs: ["viseme_id"] };

  state.avatarRequested = $("avatarEnabled").checked;
  if (state.avatarRequested) session.avatar = buildAvatar();

  if (mode === "model") {
    // Instructions, temperature and tools belong to the agent in agent mode.
    session.instructions = $("instructions").value;
    session.temperature = Number($("temperature").value);
    const tools = buildTools();
    if (tools.length) {
      session.tools = tools;
      session.tool_choice = "auto";
    }
  }
  return session;
}

function buildVoice() {
  const type = $("voiceType").value;
  const rate = $("voiceRate").value;
  if (type === "openai") return { type: "openai", name: $("openaiVoice").value };
  if (type === "azure-realtime-native") return { type: "azure-realtime-native", name: $("nativeVoice").value };
  if (type === "azure-custom") {
    return { type: "azure-custom", name: $("customVoiceName").value.trim(), endpoint_id: $("customVoiceEndpoint").value.trim(), rate };
  }
  const name = $("voiceNameCustom").value.trim() || $("voiceName").value;
  const voice = { type: "azure-standard", name, rate };
  if (name.includes("DragonHD")) voice.temperature = Number($("voiceTemperature").value);
  return voice;
}

function buildTurnDetection() {
  const type = $("vadType").value;
  if (type === "none") return null;
  if (type === "semantic_vad") return { type, eagerness: "auto", interrupt_response: $("interruptResponse").checked };
  const td = {
    type,
    threshold: Number($("vadThreshold").value),
    prefix_padding_ms: Number($("prefixMs").value),
    silence_duration_ms: Number($("silenceMs").value),
    auto_truncate: $("autoTruncate").checked,
  };
  if (type.startsWith("azure_semantic_vad")) {
    td.interrupt_response = $("interruptResponse").checked;
    td.remove_filler_words = $("removeFiller").checked;
    // EOU detection needs the cascaded (STT -> LLM -> TTS) pipeline, not native speech-to-speech models.
    if ($("eouModel").value && !isSpeechToSpeechModel()) td.end_of_utterance_detection = { model: $("eouModel").value };
  }
  return td;
}

function isSpeechToSpeechModel() {
  return $("mode").value === "model" && $("model").value.includes("realtime");
}

function buildTranscription() {
  const t = { model: $("sttModel").value };
  if ($("sttLanguage").value) t.language = $("sttLanguage").value;
  const phrases = $("phraseList").value.split(",").map((p) => p.trim()).filter(Boolean);
  if (phrases.length) t.phrase_list = phrases;
  const custom = $("customSpeech").value.trim();
  if (custom) {
    t.custom_speech = Object.fromEntries(custom.split(",").map((pair) => pair.split("=").map((s) => s.trim())));
  }
  return t;
}

function buildAvatar() {
  const custom = $("avatarCustom").checked;
  const bg = $("avatarBg").value.toUpperCase() + "FF";
  if ($("avatarKind").value === "photo") {
    const avatar = { type: "photo-avatar", model: $("photoModel").value, character: $("photoAvatar").value.trim(), video: { codec: "h264" } };
    if (custom) avatar.customized = true;
    return avatar;
  }
  const value = $("videoAvatar").value.trim();
  const [character, ...style] = value.split("-");
  const avatar = {
    type: "video-avatar",
    character: custom ? value : character,
    customized: custom,
    video: {
      codec: "h264",
      resolution: { width: 1920, height: 1080 },
      crop: { top_left: [560, 0], bottom_right: [1360, 1080] },
      background: { color: bg },
    },
  };
  if (!custom && style.length) avatar.style = style.join("-");
  return avatar;
}

function buildTools() {
  const tools = [];
  if ($("toolTime").checked) {
    tools.push({
      type: "function",
      name: "get_current_time",
      description: "Get the current local date and time, optionally for an IANA time zone such as Europe/Paris.",
      parameters: { type: "object", properties: { timezone: { type: "string", description: "IANA time zone" } } },
    });
  }
  if ($("toolWeather").checked) {
    tools.push({
      type: "function",
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: { type: "object", properties: { location: { type: "string", description: "City name" } }, required: ["location"] },
    });
  }
  if ($("toolMcp").checked) {
    tools.push({
      type: "mcp",
      server_label: "microsoft_learn",
      server_url: "https://learn.microsoft.com/api/mcp",
      require_approval: "never",
    });
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------
function connect() {
  const mode = $("mode").value;
  const params = new URLSearchParams({ mode });
  if (mode === "model") params.set("model", $("model").value);
  if (state.serverConfig.accessCodeRequired) params.set("code", $("accessCode").value);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";

  setStatus("connecting", "Connecting...");
  $("connectBtn").textContent = "Stop session";
  $("chat").innerHTML = "";
  Object.assign(state, { sessionReady: false, greetingSent: false, avatarActive: false, audioIn: 0, audioOut: 0 });

  const ws = new WebSocket(`${proto}//${location.host}/ws?${params}`);
  state.ws = ws;
  ws.onmessage = (e) => handleServerEvent(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (e.reason) addMessage("error", `Connection closed: ${e.reason}`);
    teardown();
  };
  ws.onerror = () => addMessage("error", "WebSocket error - is the server running?");
}

function disconnect() {
  state.ws?.close();
  teardown();
}

function teardown() {
  state.ws = null;
  state.sessionReady = false;
  setMic(false);
  state.mediaStream?.getTracks().forEach((t) => t.stop());
  state.captureCtx?.close();
  state.mediaStream = state.captureCtx = null;
  stopPlayback();
  state.pc?.close();
  state.pc = null;
  state.avatarActive = false;
  $("avatarContainer").hidden = true;
  $("avatarContainer").innerHTML = "";
  $("orb").hidden = false;
  setStatus("", "Disconnected");
  setConvState("idle");
  $("connectBtn").textContent = "Start session";
  for (const id of ["micBtn", "stopBtn", "textInput", "sendBtn", "applyLive", "pttBtn"]) $(id).disabled = true;
}

function send(event) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify(event));
  if (event.type === "input_audio_buffer.append") {
    $("audioOut").textContent = ++state.audioOut;
    if (!$("showAudio").checked) return;
  }
  logEvent("out", event);
}

function sendText(text) {
  if (!text || !state.sessionReady) return;
  stopPlayback();
  addMessage("user", text);
  send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  send({ type: "response.create" });
  startLatencyTimer();
}

function sendGreeting() {
  if (state.greetingSent) return;
  state.greetingSent = true;
  const kind = $("greeting").value;
  if (kind === "llm") {
    send({
      type: "conversation.item.create",
      item: { type: "message", role: "system", content: [{ type: "input_text", text: "Greet the user warmly in one short sentence and offer to help." }] },
    });
    send({ type: "response.create" });
  } else if (kind === "pregenerated") {
    send({
      type: "response.create",
      response: {
        pre_generated_assistant_message: { type: "message", role: "assistant", content: [{ type: "text", text: $("greetingText").value }] },
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Server events
// ---------------------------------------------------------------------------
async function handleServerEvent(evt) {
  const type = evt.type;
  const isAudio = type === "response.audio.delta" || type === "response.output_audio.delta";
  if (!isAudio || $("showAudio").checked) logEvent("in", evt);

  switch (type) {
    case "gateway.connected":
      addMessage("system", `Connected to ${evt.mode === "agent" ? "agent" : "model"} "${evt.target}" (API ${evt.api_version}). Configuring session...`);
      send({ type: "session.update", session: buildSession() });
      break;

    case "session.created":
      $("sessionId").textContent = evt.session?.id || "-";
      break;

    case "session.updated": {
      const s = evt.session || {};
      $("sessionId").textContent = s.id || $("sessionId").textContent;
      $("activeVoice").textContent = s.voice?.name || s.voice || "-";
      if (state.sessionReady) break;
      state.sessionReady = true;
      setStatus("connected", "Connected");
      for (const id of ["micBtn", "stopBtn", "textInput", "sendBtn", "applyLive", "pttBtn"]) $(id).disabled = false;
      if (s.agent?.name) addMessage("system", `Foundry agent: ${s.agent.name}${s.agent.description ? " - " + s.agent.description : ""}`);
      addMessage("system", "Session ready. Speak, type, or tap a sample prompt.");
      setMic(true); // not awaited: the permission prompt must not delay the greeting
      if (state.avatarRequested && s.avatar?.ice_servers) {
        startAvatar(s.avatar.ice_servers);
      } else {
        sendGreeting();
      }
      break;
    }

    case "session.avatar.connecting":
      await finishAvatar(evt.server_sdp);
      break;

    case "input_audio_buffer.speech_started":
      stopPlayback();
      setConvState("listening");
      state.userEls.set(evt.item_id, addMessage("user", "..."));
      break;

    case "input_audio_buffer.speech_stopped":
      setConvState("thinking");
      startLatencyTimer();
      break;

    case "conversation.item.input_audio_transcription.delta": {
      const el = state.userEls.get(evt.item_id);
      if (el) el.textContent = (el.textContent === "..." ? "" : el.textContent) + (evt.delta || "");
      break;
    }

    case "conversation.item.input_audio_transcription.completed": {
      const el = state.userEls.get(evt.item_id) || addMessage("user", "");
      el.textContent = evt.transcript?.trim() || "(no speech recognised)";
      break;
    }

    case "response.created":
      state.responseActive = true;
      state.assistantEl = null;
      state.responseAudioStart = null;
      state.pendingTimed = [];
      setConvState("thinking");
      break;

    case "response.audio_transcript.delta":
    case "response.output_audio_transcript.delta":
    case "response.text.delta":
    case "response.output_text.delta":
      appendAssistant(evt.delta);
      break;

    case "response.audio.delta":
    case "response.output_audio.delta":
      $("audioIn").textContent = ++state.audioIn;
      stopLatencyTimer();
      setConvState("speaking");
      if (!state.avatarActive) playPcm(evt.delta);
      break;

    case "response.audio_timestamp.delta":
      scheduleTimed(evt.audio_offset_ms, () => ($("liveWord").textContent = evt.text));
      break;

    case "response.animation_viseme.delta":
      scheduleTimed(evt.audio_offset_ms, () => setMouth(VISEME_OPENNESS[evt.viseme_id] ?? 0));
      break;

    case "response.output_item.added": {
      const item = evt.item || {};
      if (item.type && item.type !== "message") addMessage("tool", `Tool call: ${item.name || item.server_label || item.type}`);
      break;
    }

    case "response.function_call_arguments.done":
      state.pendingFunctionOutputs.push(runFunction(evt.name, evt.call_id, evt.arguments));
      break;

    case "mcp_list_tools.completed":
      addMessage("tool", "MCP server tools loaded.");
      break;

    case "response.done": {
      state.responseActive = false;
      const r = evt.response || {};
      if (r.status === "failed") addMessage("error", `Response failed: ${JSON.stringify(r.status_details?.error || r.status_details)}`);
      if (state.pendingFunctionOutputs.length) {
        const outputs = await Promise.all(state.pendingFunctionOutputs.splice(0));
        outputs.forEach((item) => send({ type: "conversation.item.create", item }));
        state.followUpPending = true;
      }
      // Only one response may be active; a VAD-triggered turn can start while tools run.
      if (state.followUpPending && !state.responseActive) {
        state.followUpPending = false;
        send({ type: "response.create" });
      } else if (!state.activeSources.length) {
        setConvState(state.micOn ? "listening" : "idle");
      }
      break;
    }

    case "error":
      addMessage("error", evt.error?.message || JSON.stringify(evt.error));
      break;
  }
}

// ---------------------------------------------------------------------------
// Client-side function tools (direct model mode)
// ---------------------------------------------------------------------------
async function runFunction(name, callId, argsJson) {
  let output;
  try {
    const args = JSON.parse(argsJson || "{}");
    addMessage("tool", `Running ${name}(${JSON.stringify(args)})`);
    if (name === "get_current_time") {
      const opts = args.timezone ? { timeZone: args.timezone } : {};
      output = { now: new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", ...opts }), timezone: args.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone };
    } else if (name === "get_weather") {
      output = await getWeather(args.location);
    } else {
      output = { error: `Unknown function ${name}` };
    }
  } catch (err) {
    output = { error: String(err) };
  }
  return { type: "function_call_output", call_id: callId, output: JSON.stringify(output) };
}

async function getWeather(location) {
  const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(location)}`)).json();
  const place = geo.results?.[0];
  if (!place) return { error: `Could not find ${location}` };
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m`;
  const wx = await (await fetch(url)).json();
  return { location: `${place.name}, ${place.country}`, units: wx.current_units, current: wx.current, note: "weather_code uses WMO codes" };
}

// ---------------------------------------------------------------------------
// Microphone capture
// ---------------------------------------------------------------------------
async function ensureCapture() {
  if (state.captureCtx) return;
  const sampleRate = Number($("sampleRate").value);
  state.mediaStream = await navigator.mediaDevices.getUserMedia({
    // Avatar audio arrives over WebRTC, which the server echo canceller can't reference, so use the browser's.
    audio: { channelCount: 1, echoCancellation: $("browserEc").checked || state.avatarRequested, noiseSuppression: false, autoGainControl: true },
  });
  state.captureCtx = new AudioContext({ sampleRate });
  await state.captureCtx.audioWorklet.addModule("pcm-worklet.js");
  const source = state.captureCtx.createMediaStreamSource(state.mediaStream);
  const node = new AudioWorkletNode(state.captureCtx, "pcm-capture");
  const sink = state.captureCtx.createGain();
  sink.gain.value = 0;
  source.connect(node).connect(sink).connect(state.captureCtx.destination);
  node.port.onmessage = (e) => {
    const streaming = $("vadType").value === "none" ? state.pttActive : state.micOn;
    if (streaming && state.sessionReady) send({ type: "input_audio_buffer.append", audio: toBase64(e.data) });
  };
}

async function setMic(on) {
  if (on) {
    try {
      await ensureCapture();
    } catch (err) {
      addMessage("error", `Microphone unavailable: ${err.message}. You can still type.`);
      on = false;
    }
  }
  state.micOn = on;
  $("micBtn").textContent = on ? "Mic on" : "Mic off";
  $("micBtn").classList.toggle("on", on);
  if (state.sessionReady) setConvState(on ? "listening" : "idle");
}

function startPushToTalk() {
  if (!state.sessionReady) return;
  stopPlayback();
  send({ type: "response.cancel" });
  send({ type: "input_audio_buffer.clear" });
  state.pttActive = true;
  setConvState("listening");
}

function endPushToTalk() {
  if (!state.pttActive) return;
  state.pttActive = false;
  send({ type: "input_audio_buffer.commit" });
  send({ type: "response.create" });
  startLatencyTimer();
}

// ---------------------------------------------------------------------------
// Playback, barge-in, word captions and visemes
// ---------------------------------------------------------------------------
function playPcm(base64) {
  if (!state.playCtx) state.playCtx = new AudioContext({ sampleRate: 24000 });
  const ctx = state.playCtx;
  const bytes = fromBase64(base64);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const buffer = ctx.createBuffer(1, pcm.length, 24000);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const startAt = Math.max(ctx.currentTime + 0.02, state.nextPlayTime);
  source.start(startAt);
  state.nextPlayTime = startAt + buffer.duration;
  state.activeSources.push(source);
  source.onended = () => {
    state.activeSources = state.activeSources.filter((s) => s !== source);
    if (!state.activeSources.length) {
      setMouth(0);
      $("liveWord").innerHTML = "&nbsp;";
      setConvState(state.micOn ? "listening" : "idle");
    }
  };

  if (state.responseAudioStart === null) {
    state.responseAudioStart = startAt;
    state.pendingTimed.splice(0).forEach(([offset, fn]) => scheduleTimed(offset, fn));
  }
}

function scheduleTimed(offsetMs, fn) {
  if (state.avatarActive) return; // the avatar does its own lip-sync
  if (state.responseAudioStart === null || !state.playCtx) {
    state.pendingTimed.push([offsetMs, fn]);
    return;
  }
  const delay = (state.responseAudioStart + offsetMs / 1000 - state.playCtx.currentTime) * 1000;
  state.timers.push(setTimeout(fn, Math.max(0, delay)));
}

function stopPlayback() {
  state.activeSources.forEach((s) => {
    s.onended = null;
    try { s.stop(); } catch { /* already stopped */ }
  });
  state.activeSources = [];
  state.nextPlayTime = 0;
  state.timers.forEach(clearTimeout);
  state.timers = [];
  state.pendingTimed = [];
  setMouth(0);
  $("liveWord").innerHTML = "&nbsp;";
}

function setMouth(openness) {
  $("mouth").setAttribute("ry", String(2 + openness * 14));
}

// ---------------------------------------------------------------------------
// Avatar (WebRTC)
// ---------------------------------------------------------------------------
async function startAvatar(iceServers) {
  addMessage("system", "Connecting avatar video...");
  const pc = new RTCPeerConnection({
    iceServers: iceServers.map((s) => ({ urls: s.urls, username: s.username || undefined, credential: s.credential || undefined })),
  });
  state.pc = pc;
  pc.ontrack = (e) => {
    const el = document.createElement(e.track.kind);
    el.autoplay = true;
    el.playsInline = true;
    el.srcObject = e.streams[0];
    $("avatarContainer").appendChild(el);
    if (e.track.kind === "video") {
      $("avatarContainer").hidden = false;
      $("orb").hidden = true;
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      state.avatarActive = true;
      addMessage("system", "Avatar connected.");
      sendGreeting();
    } else if (pc.connectionState === "failed") {
      addMessage("error", "Avatar WebRTC connection failed.");
      sendGreeting();
    }
  };
  pc.addTransceiver("video", { direction: "sendrecv" });
  pc.addTransceiver("audio", { direction: "sendrecv" });
  pc.createDataChannel("eventChannel");
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(resolve, 4000);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    };
  });
  send({ type: "session.avatar.connect", client_sdp: btoa(JSON.stringify(pc.localDescription)) });
}

async function finishAvatar(serverSdp) {
  if (!state.pc || !serverSdp) return;
  try {
    await state.pc.setRemoteDescription(JSON.parse(atob(serverSdp)));
  } catch (err) {
    addMessage("error", `Avatar SDP error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (role === "user" || role === "assistant") {
    const label = document.createElement("span");
    label.className = "role";
    label.textContent = role === "user" ? "You" : "Agent";
    div.appendChild(label);
  }
  const body = document.createElement("span");
  body.textContent = text;
  div.appendChild(body);
  $("chat").appendChild(div);
  $("chat").scrollTop = $("chat").scrollHeight;
  return body;
}

function appendAssistant(delta) {
  if (!delta) return;
  if (!state.assistantEl) state.assistantEl = addMessage("assistant", "");
  state.assistantEl.textContent += delta;
  $("chat").scrollTop = $("chat").scrollHeight;
}

function setStatus(cls, text) {
  $("statusDot").className = `dot ${cls}`;
  $("statusText").textContent = text;
}

function setConvState(s) {
  $("convState").textContent = s;
  $("orb").className = `orb ${s}`;
}

function startLatencyTimer() {
  state.latencyStart = performance.now();
  state.latencyMeasured = false;
}

function stopLatencyTimer() {
  if (state.latencyMeasured || state.latencyStart === null) return;
  state.latencyMeasured = true;
  $("latency").textContent = `${Math.round(performance.now() - state.latencyStart)} ms to first audio`;
}

function logEvent(direction, evt) {
  const li = document.createElement("li");
  li.className = `${direction}${evt.type === "error" ? " err" : ""}`;
  li.innerHTML = `<span class="dir">${direction === "out" ? "&uarr;" : "&darr;"}</span>`;
  li.appendChild(document.createTextNode(evt.type));
  li.onclick = () => {
    const pre = li.querySelector("pre");
    if (pre) return pre.remove();
    const p = document.createElement("pre");
    p.textContent = JSON.stringify(evt, (k, v) => (typeof v === "string" && v.length > 300 ? v.slice(0, 300) + `... (${v.length} chars)` : v), 2);
    li.appendChild(p);
  };
  const list = $("events");
  list.appendChild(li);
  while (list.children.length > 600) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
}

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
