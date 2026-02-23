# Third-Party Notices

This file lists the third-party dependencies used by Kithkit and their licenses.

## Runtime Dependencies

### better-sqlite3

- **License**: MIT
- **Repository**: https://github.com/WiseLibs/better-sqlite3
- **Copyright**: Copyright (c) 2017 Joshua Wise

### @anthropic-ai/claude-agent-sdk

- **License**: Proprietary (Anthropic)
- **Repository**: https://github.com/anthropics/claude-agent-sdk
- **Copyright**: Copyright (c) Anthropic PBC
- **Terms**: https://code.claude.com/docs/en/legal-and-compliance

### @huggingface/transformers

- **License**: Apache-2.0
- **Repository**: https://github.com/huggingface/transformers.js
- **Copyright**: Copyright (c) Hugging Face

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

### sqlite-vec

- **License**: MIT OR Apache-2.0
- **Repository**: https://github.com/asg017/sqlite-vec
- **Author**: Alex Garcia

### cron-parser

- **License**: MIT
- **Repository**: https://github.com/harrisiirak/cron-parser
- **Copyright**: Copyright (c) Harri Siirak

### js-yaml

- **License**: MIT
- **Repository**: https://github.com/nodeca/js-yaml
- **Copyright**: Copyright (c) 2011-2015 by Vitaly Puzrin

## Models

### all-MiniLM-L6-v2

- **License**: Apache-2.0
- **Source**: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- **ONNX conversion**: https://huggingface.co/Xenova/all-MiniLM-L6-v2
- **Copyright**: Copyright (c) Nils Reimers, Iryna Gurevych (UKP Lab, TU Darmstadt)
- **Paper**: Reimers & Gurevych, 2019. "Sentence-BERT: Sentence Embeddings using Siamese BERT-Networks"

Used at runtime for semantic memory embeddings via Hugging Face Transformers.js. The model is downloaded on first use and cached locally — it is not bundled with Kithkit.

## Transitive Dependencies

Notable transitive dependencies pulled in by the above:

| Package | License | Pulled in by |
|---------|---------|-------------|
| sharp | Apache-2.0 | @huggingface/transformers |
| protobufjs | BSD-3-Clause | @huggingface/transformers |
| prebuild-install | MIT | better-sqlite3 |
| node-addon-api | MIT | better-sqlite3 |
| luxon | MIT | cron-parser |
| argparse | Python-2.0 | js-yaml |

All transitive dependency licenses are permissive (MIT, Apache-2.0, BSD-3-Clause, Python-2.0) and compatible with Kithkit's MIT license.

## Recipe-Referenced Projects (Not Bundled)

The following projects are documented in Kithkit's integration recipes but are **not included or distributed** with Kithkit. Users install them separately if needed.

| Project | License | Recipe |
|---------|---------|--------|
| [whisper.cpp](https://github.com/ggerganov/whisper.cpp) | MIT | voice-stt |
| [Kokoro ONNX](https://github.com/thewh1teagle/kokoro-onnx) | MIT | voice-tts |
| [Himalaya](https://github.com/soywod/himalaya) | GPL-3.0 | himalaya-email |
| [openWakeWord](https://github.com/dscripka/openWakeWord) | Apache-2.0 | voice-client |
| [Cerberus](https://github.com/emailmonday/Cerberus) | MIT | email-compose (reference) |
