# lfm3-inference

Standalone Node.js/TypeScript server for local Liquid AI multimodal and decision models.
The gateway starts and supervises one `llama-server` process per configured model, routes requests
by model ID, and serves both development source and compiled production builds.

The default downloads use F16 weights and projector for Omni, and Q8_0 weights and projector
for d1. Omni F16 passed the German real-time speech round-trip that failed with Q8_0 in testing.

| Model ID       | Upstream model                                                         | Purpose                                                            |
| -------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `lfm3-omni-2b` | [LFM3-Omni-2B-GGUF](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF) | Text, image, audio and video understanding; text and speech output |
| `d1-omni-2b`   | [d1-Omni-2B-GGUF](https://huggingface.co/LiquidAI/d1-Omni-2B-GGUF)     | Typed decisions over text, JSON and media                          |

The runtime is pinned to [llama.cpp b11960 / v0.8.0](https://github.com/ggml-org/llama.cpp/releases/tag/b11960).
Downloads use immutable model revisions and SHA-256 verification. Weights and runtime binaries
stay outside version control. The source code is MIT licensed; the model weights retain
Liquid AI's [LFM license](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/blob/main/LICENSE).

## Requirements

- Node.js 24.19 or newer and npm.
- Windows x64 or Ubuntu x64 with an NVIDIA GPU and a driver compatible with the downloaded
  CUDA runtime. The installer selects CUDA 12.4 on Windows and CUDA 12.8 on Ubuntu.
- macOS Intel or Apple Silicon uses Metal. CUDA is not available on macOS.
- `tar` in PATH for runtime extraction; included with current Windows, Ubuntu and macOS.
- `ffmpeg` and `ffprobe` in PATH for video input and live media tests.
- Enough RAM/VRAM for the configured models, projectors, context and speech decoder.
  The default two-model configuration was exercised on an RTX 3090 with 24 GB VRAM.

## Install and run

Run these commands from this repository's root:

```sh
git clone https://github.com/mlnima/lfm3-inference.git
cd lfm3-inference
npm ci
node -e "require('node:fs').copyFileSync('.env.example', '.env')"
npm run download
npm run build
npm start
```

For development, use `npm run dev` instead of the build/start commands. This runs TypeScript
directly; stop and restart it after source changes. Ctrl+C stops the gateway and its runtime
processes. Startup failure shuts down processes already started. IPC supervisors also stop their
owned runtime trees if the gateway exits abruptly. Other Node.js or inference processes are never
targeted for shutdown.

The server becomes available after all configured models report ready. Native runtime ports
bind only to `127.0.0.1`. The gateway binds to all interfaces by default:

- Local API: `http://localhost:18080/v1`
- LAN API: `http://<server-LAN-IP>:18080/v1`
- Readiness: `GET http://localhost:18080/health`

Allow the selected gateway port through your host firewall when accessing it from another device.
API requests use `Authorization: Bearer change.me`, or Anthropic's `x-api-key: change.me`.
Set a different `API_KEY` in your local `.env` before exposing the service beyond your trusted LAN.

## Configuration

`.env.example` documents all gateway settings. `.env` loads automatically; environment variables
already supplied by the process take precedence.

| Variable              | Default                           | Meaning                                                     |
| --------------------- | --------------------------------- | ----------------------------------------------------------- |
| `HOST`                | `0.0.0.0`                         | Gateway bind address; use `127.0.0.1` for local access only |
| `PORT`                | `18080`                           | Gateway port                                                |
| `API_KEY`             | `change.me` in example            | Bearer or `x-api-key` credential; unset disables key checks |
| `MODELS_CONFIG`       | `models.json`                     | Model configuration file                                    |
| `LLAMA_SERVER_BIN`    | `vendor/llama/llama-server[.exe]` | Existing runtime executable override                        |
| `GPU_LAYERS`          | `all`                             | llama.cpp GPU offload setting                               |
| `STARTUP_TIMEOUT_MS`  | `180000`                          | Readiness timeout per runtime                               |
| `SHUTDOWN_TIMEOUT_MS` | `10000`                           | Runtime termination grace period on Unix                    |
| `REQUEST_TIMEOUT_MS`  | `300000`                          | Maximum inference request time                              |
| `MAX_BODY_BYTES`      | `134217728`                       | Maximum HTTP request body, including base64 media           |

`npm run download` initializes ignored `models.json` from `models.example.json` if absent.
Add entries with a unique `id` and backend `port`, a `role` of `omni` or `decision`, local
`modelPath` and optional `projectorPath`. `args` appends native llama.cpp arguments. Optional
`downloads` entries contain `path`, `url`, and `sha256`. Run the downloader again after adding
model files. Paths resolve from the repository root. These role names describe API routing;
future compatible model families can use the same configuration.

To supply a runtime yourself, set `LLAMA_SERVER_BIN` and run:

```sh
npm run download -- --models-only
```

Both models use an 8192-token context and one slot per process. d1 also uses batch and ubatch
sizes of 8192. A decision question, its state and media must fit in a single ubatch.
Omni starts with `--reasoning off --jinja`, as required for its chat and tool templates.

## HTTP and WebSocket APIs

The [pinned llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/b11960/tools/server/README.md)
defines the native request and response formats. The gateway preserves native errors,
event streams, tool calls and audio bytes.

| Endpoint                             | Model role | Notes                                                         |
| ------------------------------------ | ---------- | ------------------------------------------------------------- |
| `GET /v1/models`                     | Both       | Configured model IDs                                          |
| `POST /v1/chat/completions`          | Omni       | OpenAI chat, tools, structured output, SSE                    |
| `POST /v1/responses`                 | Omni       | Native OpenAI Responses compatibility                         |
| `POST /v1/completions`               | Omni       | OpenAI text completions                                       |
| `POST /v1/messages`                  | Omni       | Anthropic Messages and SSE                                    |
| `POST /v1/messages/count_tokens`     | Omni       | Anthropic token counting                                      |
| `POST /v1/systemone`                 | Decision   | Native TypeSafe-compatible decisions                          |
| `POST /tts`                          | Omni       | Native WAV/float32 PCM synthesis, optional streaming          |
| `POST /v1/audio/speech`              | Omni       | OpenAI-style synthesis; WAV or signed PCM16 at 24 kHz         |
| `POST /v1/audio/transcriptions`      | Omni       | Multipart ASR; `file`, `model`, `language`, `response_format` |
| `WS /v1/realtime?model=lfm3-omni-2b` | Omni       | Native text/audio conversation and transcription              |

Supply the exact configured `model` ID. Omitting it selects the first model with the required
role. Native `/tts` also accepts multipart audio reference uploads. Transcription returns
`{"text":"..."}` by default, or plain text with `response_format=text`; other formats and
timestamp fields are not implemented. Speech formats other than WAV and PCM are not implemented.
The native `/tts` PCM format remains float32, with its encoding stated in `Content-Type`.
The OpenAI-style speech endpoint converts PCM to signed 16-bit little-endian samples.

### Text and image understanding

```sh
curl http://localhost:18080/v1/chat/completions \
  -H "Authorization: Bearer change.me" -H "Content-Type: application/json" \
  -d '{"model":"lfm3-omni-2b","temperature":0,"messages":[{"role":"user","content":"What is two plus two?"}]}'
```

For images, a message's `content` array contains `image_url` parts and text. Audio uses
`{"type":"input_audio","input_audio":{"data":"<base64>","format":"wav"}}`.
Video uses `{"type":"input_video","input_video":{"data":"<base64 MP4>"}}`.
Omni receives video frames and the soundtrack. Use the system prompt
`Answer questions about the video using what you see and hear.` for video questions.

### Decisions, including images

```json
{
  "model": "d1-omni-2b",
  "state": "I was charged twice. Please refund the duplicate charge.",
  "questions": {
    "team": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": { "billing": "Charges and refunds", "technical": "Software faults" }
    },
    "refund": { "type": "noul", "instructions": "Is a refund requested?" },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is the issue?",
      "criteria": ["Can wait", "Today", "Immediate"]
    }
  }
}
```

POST this JSON to `/v1/systemone`. `answers` contains the selected choice and probabilities,
the probability-weighted score, or a `noul` truth probability. d1 returns decisions in a
forward pass and generates no chat tokens.

For image decisions, add `"files":["data:image/png;base64,<base64>"]`; `images` is an alias.
`state` can be JSON or `null`. Audio/video data URLs use `data:audio/wav;base64,...` and
`data:video/mp4;base64,...`. Spoken questions use an `input_audio` part as `instructions`.
At this runtime version, d1 reads video frames without the soundtrack. Multi-label choices,
extraction, estimates and bounding boxes are not supported by this runtime. Predictions and
confidence values require evaluation on your own data.

### Speech and real-time voice

```sh
curl http://localhost:18080/v1/audio/speech \
  -H "Authorization: Bearer change.me" -H "Content-Type: application/json" \
  -d '{"model":"lfm3-omni-2b","input":"Hello from the local model.","voice":"female","response_format":"wav"}' \
  --output speech.wav
```

Voices are `female` and `male`; language is `lang` on `/tts` and `language` or `lang` on the
speech adapter. Native acoustic sampling settings and speaker references pass through.
For ASR, the adapter uses the model's `Perform ASR in <language>.` system prompt.

Real-time clients authenticate in the WebSocket HTTP headers. Use `session.update`,
`conversation.item.create` or `input_audio_buffer.append`/`commit`, then `response.create`.
Audio input is PCM16 mono at the rate reported by `session.created`; generated audio deltas
are PCM16 at the reported output rate. Set `output_modalities` to `["text","audio"]` for
interleaved output. See `tests/liveRealtime.test.ts` for a complete client.

For Omni transcription sessions, send `session.update` with `session.type="transcription"`
before the first audio. The pinned runtime initially opens Omni in conversation mode.
Raw `/v1/completions` requests require the model's instruction template; use Chat Completions
when supplying ordinary user messages. The tests include an explicit template example.

## Verification

```sh
npm test
npm run lint
npm run typecheck
npm run format:check
npm run check:limits
npm run build
npm run test:live
```

With the gateway stopped, `npm run test:lifecycle` starts real production runtimes to check
normal shutdown, abrupt gateway exit, startup cancellation and invalid model/executable cleanup.

Start the server before running live tests. Tests use actual models, recorded audio/video and
generated image fixtures. They check expected answers, decode audio and transcribe generated
speech, including WebSocket audio. Generated media and evidence go to ignored `artifacts/live/`.
`LFM3_TEST_URL` selects another gateway; `API_KEY` selects its credential. Live fixtures require
internet access on the first run and FFmpeg. Automated samples cannot establish perfect model
accuracy across arbitrary inputs.

CI checks formatting, lint, source limits, gateway unit tests and compilation on Windows,
Ubuntu and macOS. GPU inference must be evaluated separately on each deployment platform.

### Recorded verification

On 2026-10-28, Windows with Node.js 24.19, an RTX 3090, and the pinned b11960 runtime:

| Check                                               | Observed result                |
| --------------------------------------------------- | ------------------------------ |
| Gateway regression tests                            | 4 passed, 0 failed             |
| Live inference tests, Omni F16 and d1 Q8_0          | 33 passed, 0 failed, 0 skipped |
| Actual process lifecycle tests                      | 6 passed, 0 failed             |
| Localhost and host LAN-address readiness            | HTTP 200                       |
| Formatting, lint, strict types and production build | Passed                         |

Live tests include decision choices/scores/probabilities, image/audio/video decisions, spoken
questions, text and media understanding, both API families and event streams, schema output,
tool round trips, WAV and PCM, voices, German speech, real-time transcription, conversation
memory, spoken visual questions and speech translation. Generated audio is decoded and checked
for non-silence, then transcribed to verify expected words.

The earlier Q8_0 Omni configuration failed a German real-time speech round-trip. The F16
configuration passed both a focused comparison and the complete live suite. The failed Q8_0
result is the reason for the higher-precision default. It is not a guarantee for every utterance
or language. Native GPU inference on Ubuntu/macOS and access from a separate LAN device were
not exercised in this Windows run.
