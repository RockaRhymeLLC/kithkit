# Recipe: Speech-to-Text (Whisper CLI)

Set up local speech recognition for your Kithkit agent using `whisper-cpp`. Transcription runs entirely on-device — no API keys or internet required.

---

## Prerequisites

- macOS with Homebrew installed
- `whisper-cpp` — install via Homebrew
- A WAV audio source (microphone input from voice client, or test file)
- Kithkit daemon running

---

## Setup Steps

### 1. Install whisper-cpp

```bash
brew install whisper-cpp
```

Verify the install:

```bash
whisper-cli --version
```

### 2. Create a models directory

```bash
mkdir -p models
```

### 3. Download a model

Choose a model based on your accuracy/speed tradeoff:

| Model | Size | Speed | Accuracy |
|-------|------|-------|----------|
| `tiny.en` | 75 MB | Fastest | Low |
| `base.en` | 142 MB | Fast | Moderate |
| `small.en` | 466 MB | Moderate | Good |
| `medium.en` | 1.5 GB | Slow | High |

Download `small.en` (recommended starting point):

```bash
curl -L -o models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
```

### 4. Test with a WAV file

```bash
whisper-cli -m models/ggml-small.en.bin -f test.wav
```

You should see a transcription printed to stdout. If `test.wav` does not exist, record a short clip:

```bash
# Record 5 seconds using sox (brew install sox)
rec -r 16000 -c 1 test.wav trim 0 5
```

### 5. Enable STT in the daemon config

Open `kithkit.config.yaml` and set:

```yaml
channels:
  voice:
    enabled: true
    stt:
      engine: whisper-cpp
      model: small.en
      language: en
```

Restart the daemon for the change to take effect.

---

## Reference Code

Daemon STT module pattern (`daemon/src/voice/stt.ts`):

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

interface STTConfig {
  model: string;      // e.g. "small.en"
  language: string;   // e.g. "en"
  projectDir: string; // absolute path to project root
}

// Hallucination filter: known false-positive patterns from silence or noise
const HALLUCINATIONS = new Set([
  'you',
  'thank you',
  'thanks',
  'bye bye',
  'bye',
  '...',
  '. . .',
  '♪',
]);

function filterHallucinations(text: string): string {
  const normalized = text.toLowerCase().trim();
  return HALLUCINATIONS.has(normalized) ? '' : text;
}

export async function transcribe(
  wavPath: string,
  config: STTConfig
): Promise<string> {
  const modelPath = path.join(config.projectDir, 'models', `ggml-${config.model}.bin`);

  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-l', config.language,
    '--beam-size', '1',   // REQUIRED on Apple Silicon — see Troubleshooting
    '--no-timestamps',
    '--no-prints',
  ];

  // 30-second hard timeout — prevents hung processes on bad audio
  const { stdout } = await execFileAsync('whisper-cli', args, { timeout: 30000 });

  const raw = stdout.trim();
  return filterHallucinations(raw);
}
```

Daemon HTTP endpoint registration:

```typescript
// POST /voice/stt
// Accepts: multipart/form-data or raw WAV body
// Returns: { text: string }
app.post('/voice/stt', async (req, res) => {
  const wavPath = await saveUploadedAudio(req); // write to temp file
  const text = await transcribe(wavPath, sttConfig);
  await fs.unlink(wavPath); // clean up temp file
  res.json({ text });
});
```

---

## Config Snippet

```yaml
channels:
  voice:
    enabled: true
    stt:
      engine: whisper-cpp
      model: small.en        # Model file: models/ggml-small.en.bin
      language: en           # ISO 639-1 language code
```

**Daemon endpoint**: `POST /voice/stt`
- Accepts raw WAV audio (16kHz, mono, 16-bit PCM)
- Returns `{ "text": "transcribed text" }` or `{ "text": "" }` if silence/hallucination detected

---

## Troubleshooting

### `whisper-cli: command not found`

Homebrew may not be on your PATH. Try:

```bash
which whisper-cli
# If missing, add Homebrew to PATH:
export PATH="/opt/homebrew/bin:$PATH"
# Add that line to ~/.zshrc for persistence
```

### Garbled, incorrect, or empty transcription

Check that your audio is in the correct format. whisper-cpp requires:
- Sample rate: **16000 Hz**
- Channels: **mono (1)**
- Bit depth: **16-bit PCM**

Convert an existing file with ffmpeg:

```bash
ffmpeg -i input.mp3 -ar 16000 -ac 1 -c:a pcm_s16le output.wav
```

### Transcription always returns "you", "thank you", or "bye bye"

This is a known whisper.cpp hallucination on silence or very short noise bursts. The reference code's `filterHallucinations()` function handles this — add any additional false positives you observe to the `HALLUCINATIONS` set.

### Output is very slow on Apple Silicon

Make sure `--beam-size 1` is in your args. This is mandatory on M1/M2/M3/M4 chips due to a whisper.cpp bug (#3493) that causes exponential slowdown at higher beam sizes. Do not remove this flag.

### Process times out

If transcription regularly exceeds the 30-second timeout, the audio file may be too large or corrupted. Check that the voice client is only sending speech segments (not continuous recording). A typical 5-10 second utterance should transcribe in under 3 seconds on `small.en`.

### Model file not found

Verify the model path matches the config. If `model: small.en` is set, the daemon looks for `models/ggml-small.en.bin` relative to the project root. Re-run the download curl command from the project root.
