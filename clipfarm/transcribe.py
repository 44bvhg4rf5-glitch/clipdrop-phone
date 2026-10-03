# transcribe.py — word-timed transcript of one video, for finding moments and
# burning captions. Free and local (faster-whisper on CPU).
#
#   python3 clipfarm/transcribe.py <video> <out.json> [model]
import json, sys
from faster_whisper import WhisperModel

video, out = sys.argv[1], sys.argv[2]
model = WhisperModel(sys.argv[3] if len(sys.argv) > 3 else "base.en", device="cpu", compute_type="int8")
segments, info = model.transcribe(video, word_timestamps=True, vad_filter=True)
data = {"language": info.language, "segments": []}
for s in segments:
    data["segments"].append({
        "start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip(),
        "words": [{"s": round(w.start, 2), "e": round(w.end, 2), "w": w.word.strip()} for w in (s.words or [])],
    })
with open(out, "w") as f:
    json.dump(data, f)
print(f"{len(data['segments'])} segments")
