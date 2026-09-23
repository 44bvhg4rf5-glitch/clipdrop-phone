# koala_i2v.py — runs on a free Kaggle GPU, not on the Mac.
#
# kaggle-run.sh uploads an episode's pack (shotN.png + prompts.json) as a
# private dataset and pushes this script as a private GPU notebook. It animates
# each still with Wan 2.2 TI2V 5B — the same free model family the Mac could
# only run in a cut-down form — and writes shotN.mp4 to /kaggle/working, which
# kaggle-run.sh downloads back into the pack. Progress and any errors go to
# log.txt so a failed run can be diagnosed from its output alone.

import glob, json, os, subprocess, sys, time, traceback

OUT = '/kaggle/working'
LOG = open(os.path.join(OUT, 'log.txt'), 'a', buffering=1)

def log(*a):
    line = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a)
    print(line, flush=True)
    LOG.write(line + '\n')

subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', '-U',
                'diffusers', 'transformers', 'accelerate', 'ftfy',
                'sentencepiece', 'imageio', 'imageio-ffmpeg'], check=True)

import torch
from diffusers import AutoencoderKLWan, WanImageToVideoPipeline
from diffusers.utils import export_to_video, load_image

found = glob.glob('/kaggle/input/**/prompts.json', recursive=True)
if not found:
    log('no prompts.json in the attached dataset'); sys.exit(1)
src = os.path.dirname(found[0])
job = json.load(open(found[0]))
cfg = job.get('settings', {})

MODEL = cfg.get('model', 'Wan-AI/Wan2.2-TI2V-5B-Diffusers')
W, H = int(cfg.get('width', 480)), int(cfg.get('height', 832))      # multiples of 32
FRAMES = int(cfg.get('frames', 81))                                   # 4n+1; 81 ≈ 3.4s at 24fps
STEPS = int(cfg.get('steps', 30))
GUIDANCE = float(cfg.get('guidance', 5.0))
SEED = int(cfg.get('seed', 20260101))

gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none'
major = torch.cuda.get_device_capability()[0] if torch.cuda.is_available() else 0
# Kaggle's free GPUs (T4, P100) predate bfloat16; half precision is the fallback.
dtype = torch.bfloat16 if major >= 8 else torch.float16
log(f'gpu={gpu} dtype={dtype} model={MODEL} {W}x{H} frames={FRAMES} steps={STEPS}')

# The VAE stays in float32: it is small, and half-precision VAEs are the usual
# source of black or speckled frames.
vae = AutoencoderKLWan.from_pretrained(MODEL, subfolder='vae', torch_dtype=torch.float32)
pipe = WanImageToVideoPipeline.from_pretrained(MODEL, vae=vae, torch_dtype=dtype)
pipe.enable_model_cpu_offload()   # 16 GB of GPU is not enough to hold everything at once
try:
    pipe.vae.enable_tiling()
except Exception:
    pass

done = 0
for shot in job['shots']:
    n = shot['n']
    out = os.path.join(OUT, f'shot{n}.mp4')
    try:
        t0 = time.time()
        image = load_image(os.path.join(src, shot['image'])).convert('RGB').resize((W, H))
        frames = pipe(
            image=image,
            prompt=shot['prompt'],
            negative_prompt=shot.get('negative', ''),
            height=H, width=W, num_frames=FRAMES,
            num_inference_steps=STEPS, guidance_scale=GUIDANCE,
            generator=torch.Generator('cpu').manual_seed(SEED + n),
        ).frames[0]
        export_to_video(frames, out, fps=24)
        done += 1
        log(f'shot {n}: ok in {int(time.time() - t0)}s')
    except Exception as e:
        log(f'shot {n}: FAILED {type(e).__name__}: {e}')
        LOG.write(traceback.format_exc() + '\n')
    torch.cuda.empty_cache()

log(f'finished: {done}/{len(job["shots"])} shots')
