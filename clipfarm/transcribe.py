# transcribe.py — word-timed transcript of one video, for finding moments and
# burning captions. Free and local (faster-whisper on CPU).
#
#   python3 clipfarm/transcribe.py <video> <out.json> [model]
#
# Audio is decoded by ffmpeg into 16 kHz mono and handed over as an array, so
# faster-whisper's own decoder (PyAV, whose API shifts between releases) is
# never used.
import json, subprocess, sys
import numpy as np
from faster_whisper import WhisperModel

video, out = sys.argv[1], sys.argv[2]
raw = subprocess.run(
    ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
    check=True, capture_output=True,
).stdout
audio = np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0

model = WhisperModel(sys.argv[3] if len(sys.argv) > 3 else "base.en", device="cpu", compute_type="int8")
segments, info = model.transcribe(audio, word_timestamps=True, vad_filter=True)
data = {"language": info.language, "segments": []}
for s in segments:
    data["segments"].append({
        "start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip(),
        "words": [{"s": round(w.start, 2), "e": round(w.end, 2), "w": w.word.strip()} for w in (s.words or [])],
    })
with open(out, "w") as f:
    json.dump(data, f)
print(f"{len(data['segments'])} segments")
