# Speech-to-Text (Whisper CLI)

On-device speech recognition via whisper-cpp. No API keys required — everything runs locally.

## Prerequisites

- macOS with Homebrew
- whisper-cpp (`brew install whisper-cpp`)

## Setup

```bash
# Install whisper-cpp
brew install whisper-cpp

# Download a model (small.en recommended for most use cases)
whisper-cpp-download-ggml-model small.en

# Test with a WAV file (must be 16kHz mono 16-bit PCM)
whisper-cli -m ~/.cache/whisper/ggml-small.en.bin -f test.wav
```

### Model Size Comparison

| Model       | Size   | Notes                        |
|-------------|--------|------------------------------|
| tiny.en     | 75MB   | Fastest, lowest accuracy     |
| base.en     | 142MB  | Good balance for fast hardware |
| small.en    | 466MB  | Recommended — best accuracy/speed tradeoff |
| medium.en   | 1.5GB  | High accuracy, slower        |

## Config Snippet

```yaml
channels:
  voice:
    stt:
      engine: whisper-cpp
      model: small.en
      model_dir: ~/.cache/whisper
      language: en
      beam_size: 1          # REQUIRED on Apple Silicon — see Troubleshooting
      timeout_ms: 10000
```

## Key Reference Code

### Transcribe Function

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Known whisper hallucinations — filter these out
const HALLUCINATIONS = new Set(['you', 'thank you', 'bye bye', 'thanks for watching']);

async function transcribe(wavPath: string, modelPath: string): Promise<string | null> {
  const { stdout } = await execFileAsync('whisper-cli', [
    '-m', modelPath,
    '-f', wavPath,
    '--no-timestamps',
    '--beam-size', '1',   // REQUIRED on Apple Silicon to avoid garbled output
    '-l', 'en',
    '--output-txt',
    '--print-special', 'false',
  ]);

  const text = stdout.trim().toLowerCase();

  if (!text || HALLUCINATIONS.has(text)) {
    return null;
  }

  return stdout.trim();
}
```

### POST /voice/stt Endpoint

```typescript
// Daemon route — accepts audio upload, returns transcript
app.post('/voice/stt', upload.single('audio'), async (req, res) => {
  const wavPath = req.file?.path;
  if (!wavPath) return res.status(400).json({ error: 'No audio file provided' });

  try {
    const transcript = await transcribe(wavPath, config.stt.modelPath);
    if (transcript === null) {
      return res.json({ transcript: null, filtered: true });
    }
    return res.json({ transcript });
  } finally {
    fs.unlink(wavPath, () => {});  // clean up temp file
  }
});
```

## Troubleshooting

**`whisper-cli: command not found`**
Homebrew installs to `/opt/homebrew/bin` on Apple Silicon. Make sure it is on `PATH`. Add to shell profile:
```bash
export PATH="/opt/homebrew/bin:$PATH"
```
The daemon spawns processes with a stripped `PATH` — set `env.PATH` explicitly in the spawn options or use the absolute binary path.

**Garbled / nonsense output**
whisper-cpp requires audio to be **16kHz mono 16-bit PCM WAV**. Convert with ffmpeg:
```bash
ffmpeg -i input.mp3 -ar 16000 -ac 1 -sample_fmt s16 output.wav
```

**Hallucinations (empty room returns "thank you", "you", etc.)**
This is a known whisper behaviour on silence or background noise. The `HALLUCINATIONS` filter above covers the most common false positives. Expand the set as you encounter new ones. You can also raise the VAD (voice activity detection) threshold to avoid sending silence to the model.

**Very slow on Apple Silicon**
Set `--beam-size 1` in your CLI args (already included in the reference code). Without this, whisper-cpp may use a large beam search that runs extremely slowly on Apple Silicon MPS and produces garbled results.

**Timeout**
The default `timeout_ms: 10000` is tight for larger models. For `medium.en`, increase to `30000`. Transcription time scales with audio length and model size.

**Model not found**
Models are downloaded to `~/.cache/whisper/` by `whisper-cpp-download-ggml-model`. Confirm the path:
```bash
ls ~/.cache/whisper/
# Should list: ggml-small.en.bin (or whichever model you downloaded)
```
Set `model_dir` in config to match the actual path if it differs.
