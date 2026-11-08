# faces.py — where the people are, shot by shot, so a wide TV frame can be
# cropped tall without cutting them off. Free and local (OpenCV's bundled
# face detector).
#
#   python3 clipfarm/faces.py <video> <start> <dur>
#
# Prints JSON: [{"s": 0.0, "e": 3.2, "cx": 0.41}, ...] — times relative to
# <start>, cx = horizontal centre to keep (0 = left edge, 1 = right edge).
import json, sys
import cv2
import numpy as np

video, start, dur = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
cap = cv2.VideoCapture(video)
cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
det = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
side = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_profileface.xml')
step = 0.25
samples = []  # (t, hist, faces[(cx, w)])
t = 0.0
while t <= dur:
    cap.set(cv2.CAP_PROP_POS_MSEC, (start + t) * 1000)
    ok, frame = cap.read()
    if not ok:
        break
    small = cv2.resize(frame, (640, 360))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    hist = cv2.calcHist([small], [0, 1, 2], None, [8, 8, 8], [0, 256] * 3)
    cv2.normalize(hist, hist)
    found = list(det.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=6, minSize=(28, 28)))
    # Reality TV is full of people talking side-on: look for profiles both ways.
    found += list(side.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=6, minSize=(28, 28)))
    flip = cv2.flip(gray, 1)
    found += [(640 - x - w, y, w, h) for (x, y, w, h) in side.detectMultiScale(flip, scaleFactor=1.15, minNeighbors=6, minSize=(28, 28))]
    faces = [((x + w / 2) / 640, w / 640) for (x, y, w, h) in found]
    samples.append((t, hist, faces))
    t += step

# Shot boundaries: a big jump in colour histogram between samples.
shots, cur = [], [samples[0]] if samples else []
for a, b in zip(samples, samples[1:]):
    if cv2.compareHist(a[1], b[1], cv2.HISTCMP_CORREL) < 0.6:
        shots.append(cur); cur = []
    cur.append(b)
if cur:
    shots.append(cur)

out, last = [], 0.5
CROP = 0.45  # share of the source width the tall crop shows
for sh in shots:
    faces = [f for s in sh for f in s[2]]
    if faces:
        xs = np.array([f[0] for f in faces]); ws = np.array([f[1] for f in faces])
        lo, hi = np.percentile(xs - ws / 2, 10), np.percentile(xs + ws / 2, 90)
        # Everyone fits: centre on the group. Otherwise follow the biggest face.
        cx = (lo + hi) / 2 if hi - lo <= CROP * 0.95 else float(xs[np.argmax(ws)])
    else:
        cx = 0.5
    cx = float(min(max(cx, CROP / 2), 1 - CROP / 2))
    out.append({'s': round(sh[0][0], 2), 'e': round(sh[-1][0] + step, 2), 'cx': round(cx, 3)})
    last = cx
print(json.dumps(out))
