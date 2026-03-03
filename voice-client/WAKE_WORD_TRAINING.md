# Wake Word Training Guide

How to train a custom openWakeWord model locally on macOS ARM64 (Apple Silicon).

## Prerequisites

- macOS with Apple Silicon (M1/M2/M4)
- Python 3.12 via Homebrew
- ~10GB free disk space
- git-lfs: `brew install git-lfs`

## Environment Setup

```bash
# Create venv
python3.12 -m venv /tmp/wakeword-train
source /tmp/wakeword-train/bin/activate

# Install deps (ORDER MATTERS — version constraints are critical)
pip install "setuptools<70"        # pkg_resources needed by webrtcvad
pip install "numpy<2"              # pyarrow 14 needs numpy.core.multiarray (removed in numpy 2.x)
pip install "pyarrow<15"           # datasets 2.14.6 uses pa.PyExtensionType (removed in pyarrow 15+)
pip install "scipy<1.15"           # acoustics needs scipy.special.sph_harm (renamed in scipy 1.15+)
pip install datasets==2.14.6
pip install torch==2.5.0 torchaudio==2.5.0
pip install piper-tts piper-phonemize-cross
pip install openwakeword
pip install onnx onnxruntime
pip install speechbrain tqdm pyyaml soundfile librosa mutagen audiomentations
pip install torch-audiomentations acoustics

# Clone required repos
cd /tmp
git clone https://github.com/dscripka/piper-sample-generator.git
git clone https://github.com/dscripka/openwakeword.git
cd openwakeword && pip install -e . && cd ..
```

### Key Version Constraints

| Package | Constraint | Reason |
|---------|-----------|--------|
| pyarrow | <15 | datasets 2.14.6 uses `pa.PyExtensionType`, removed in pyarrow 15+ |
| numpy | <2 | pyarrow 14 uses `numpy.core.multiarray`, gone in numpy 2.x |
| setuptools | <70 | webrtcvad uses `pkg_resources`, removed in setuptools 82+ |
| scipy | <1.15 | `acoustics` imports `scipy.special.sph_harm`, renamed to `sph_harm_y` in 1.15 |
| piper-phonemize-cross | 1.2.1 | Has macOS ARM64 wheel (cp312-macosx_11_0_arm64) |

## Download Training Data

### 1. Pre-computed Features (required, ~5.7GB total)

These are the main negative training data — 2000 hours of pre-computed openWakeWord features.

```bash
# Training features (5.5GB)
wget https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy -O /tmp/openwakeword_features_ACAV100M_2000_hrs_16bit.npy

# Validation features (185MB)
wget https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy -O /tmp/validation_set_features.npy
```

### 2. Embedding Models (required)

Download to openwakeword's resource directory:

```bash
cd /tmp/openwakeword/openwakeword/resources/models/
wget https://github.com/dscripka/openWakeWord/releases/download/v0.5.0/embedding_model.onnx
wget https://github.com/dscripka/openWakeWord/releases/download/v0.5.0/embedding_model.tflite
wget https://github.com/dscripka/openWakeWord/releases/download/v0.5.0/melspectrogram.onnx
wget https://github.com/dscripka/openWakeWord/releases/download/v0.5.0/melspectrogram.tflite
```

### 3. MIT Room Impulse Responses (required for augmentation)

```bash
cd /tmp
git lfs install
git clone https://huggingface.co/datasets/davidscripka/MIT_environmental_impulse_responses
```

Then convert to 16kHz int16 wav:

```python
import datasets, scipy, numpy as np, os
from pathlib import Path
from tqdm import tqdm

os.makedirs('/tmp/mit_rirs', exist_ok=True)
rir_dataset = datasets.Dataset.from_dict(
    {'audio': [str(i) for i in Path('/tmp/MIT_environmental_impulse_responses/16khz').glob('*.wav')]}
).cast_column('audio', datasets.Audio())
for row in tqdm(rir_dataset, desc='Converting RIRs'):
    name = row['audio']['path'].split('/')[-1]
    scipy.io.wavfile.write(f'/tmp/mit_rirs/{name}', 16000, (row['audio']['array']*32767).astype(np.int16))
```

### 4. Background Audio (for augmentation)

You need background noise clips (speech, music, ambient sounds) in 16kHz wav format.

**AudioSet** (environmental sounds — slow to extract, 42+ clips is fine):
```bash
# Download one parquet shard (~688MB)
curl -sL "https://huggingface.co/datasets/agkphysics/AudioSet/resolve/main/data/bal_train/00.parquet" -o /tmp/audioset_bal_00.parquet
```

Then extract audio via pyarrow + soundfile (see training script for details). Note: extraction is slow (~7s/clip due to resampling).

**FMA** (music — fast streaming download):
```python
import datasets
ds = datasets.load_dataset('rudraml/fma', name='small', split='train', streaming=True)
ds = iter(ds.cast_column('audio', datasets.Audio(sampling_rate=16000)))
# Extract ~120 clips (1 hour of 30s segments)
```

**Gotcha**: The old AudioSet tar file URLs (`bal_train09.tar`) return "Entry not found" — the dataset was converted to Parquet format. Use the parquet approach above.

## Training Configuration

Key parameters in the YAML config:

```yaml
target_phrase: ["hey are too"]     # Phonetic spelling of your wake word
n_samples: 1000                     # TTS examples to generate (more = better, slower)
n_samples_val: 500                  # Validation examples
steps: 10000                        # Training steps (10K-50K)
max_negative_weight: 1500           # Higher = fewer false positives, lower recall
target_false_positives_per_hour: 0.2
layer_size: 32                      # Model size (32 is default/recommended)
```

### Choosing Target Phrase

The target phrase should be a **phonetic approximation** using common English words:
- "hey R2" → `"hey are too"` (sounds like "hey ar-too")
- "hey BMO" → `"hey bee mo"` (the "bee mo" sounds)

This matters because Piper TTS generates the synthetic training data from text.

## Running Training

```bash
source /tmp/wakeword-train/bin/activate
cd /tmp
python3 /tmp/train_wake_word.py
```

The pipeline has 4 steps:
1. **Generate clips** (~5-10 min): Piper TTS generates synthetic speech examples
2. **Augment clips** (~10-30 min): Apply room impulse responses + background noise
3. **Train model** (~30-60 min for 10K steps): Binary classifier on openWakeWord features
4. **Export ONNX**: Final model saved to output directory

### Expected Output

```
/tmp/my_custom_model/
  hey_are_too.onnx          # The wake word model (~50KB)
  hey_are_too.tflite         # TensorFlow Lite version
  positive_train/            # Generated training clips
  positive_val/              # Generated validation clips
```

## Deploying the Model

Copy the `.onnx` file to the voice client:

```bash
cp /tmp/my_custom_model/hey_are_too.onnx voice-client/hey_r2.onnx
```

Update the voice client config to reference the model:

```yaml
wake_word:
  models:
    - hey_r2.onnx
  threshold: 0.5   # Adjust based on testing (lower = more sensitive)
```

## Troubleshooting

### `ImportError: cannot import name 'sph_harm' from 'scipy.special'`
scipy is too new. Downgrade: `pip install "scipy<1.15"`

### `ValueError: BuilderConfig ... doesn't have a 'trust_remote_code' key`
datasets library too old for some HuggingFace datasets. Use streaming mode or download parquet directly.

### `ImportError: No module named 'numpy.core.multiarray'`
numpy is too new. Downgrade: `pip install "numpy<2"`

### AudioSet `Entry not found`
Old tar URLs are dead. Use parquet approach (see Download section).

### piper-phonemize not found / build fails
Use `piper-phonemize-cross` instead — it has pre-built wheels for macOS ARM64.

### Training runs but accuracy is low
- Increase `n_samples` (try 5000-10000)
- Increase `steps` (try 20000-50000)
- Run multiple training sequences (train, re-train, re-train) as we did for "hey BMO"
- Adjust `max_negative_weight` (higher = fewer false positives but lower recall)

## Gotchas

### macOS multiprocessing pickle error
PyTorch DataLoader with `num_workers > 0` fails on macOS due to `spawn` context not being able to pickle lambdas in train.py. Fix: patch `/tmp/openwakeword/openwakeword/train.py` to use `num_workers=0` on Darwin (see the platform check patch in this project's history).

### TFLite conversion fails (onnx_tf not found)
Training outputs `.onnx` but fails converting to `.tflite`. This is fine — openWakeWord uses ONNX. Just ignore the error and use the `.onnx` file.

### Must specify `inference_framework='onnx'`
When loading custom models: `Model(wakeword_models=['hey_r2.onnx'], inference_framework='onnx')`. Default framework is tflite which won't load .onnx files.

### ACAV features file is 17.3GB
The pre-computed features download is huge. If interrupted, use `curl -C -` to resume. Verify with numpy: `np.load(path, mmap_mode='r')` — if it throws "mmap length greater than file size", the file is truncated.

### scipy/acoustics compatibility
The `acoustics` library needs `scipy<1.15` because `sph_harm` was renamed to `sph_harm_y`.

## Performance Notes

- On M4 Mac Mini: clip generation ~5min (1000 examples), augmentation ~15min, training 2:08 for 10K steps + 44s for 1K refinement
- Total wall time for a complete run: ~20-25 minutes (excluding data downloads)
- Memory: ~4GB RAM during training (features are memory-mapped)
- The 17.3GB feature file uses memory-mapping, so it doesn't need to fit in RAM

## Results (hey R2, first run)

| Metric | Value |
|--------|-------|
| Accuracy | 79.8% |
| Recall | 59.6% |
| FP/hr | 1.95 |
| Model size | 201KB |
| Training | 10K steps + 1K refinement |
| Config | 1000 examples, max_negative_weight 1500 |

Compare to "hey BMO" (3 training sequences): Accuracy 72.5%, Recall 45.4%, FP/hr 1.5. The "hey R2" model performs better on first run — likely because "are too" is more phonetically distinct than "bee mo".
