#!/usr/bin/env python3
"""
image_tools.py - image engine for the Dev Tools backend (src/libs/tools/image.ts).

Ported from the D:\\image-compress benchmarking project (benchmark_engine.py, batch_compressor.py,
strip_jpeg.py): lossless JPEG marker stripping, Pillow encoders for JPEG/WebP/AVIF/HEIC/PNG, EXIF
orientation handling, Lanczos/bicubic downscaling, PSNR + SSIM metrics (numpy, no scikit-image)
and multi-core batch processing with ProcessPoolExecutor.

Usage:  python image_tools.py <command> <spec.json>
Commands: caps | compress | batch | benchmark | transform

The spec file is JSON written by the Node side. Progress is reported as stdout lines of the form
{"progress": n, "message": "..."}; the final stdout line is the JSON result.
"""

import json
import math
import os
import shutil
import struct
import sys
import threading
import time
import zipfile
from concurrent.futures import ProcessPoolExecutor, as_completed

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageSequence, features

try:
    import pillow_heif  # type: ignore

    pillow_heif.register_heif_opener()
    HAS_HEIF = True
except Exception:  # pragma: no cover - optional
    HAS_HEIF = False

if not features.check('avif'):
    # Older Pillow: fall back to the pillow-avif-plugin if it is installed.
    try:
        import pillow_avif  # type: ignore  # noqa: F401
    except Exception:
        pass

# Refuse decompression bombs early (default Pillow limit is ~179 MP as an error).
Image.MAX_IMAGE_PIXELS = 150_000_000

IMAGE_EXTS = {'.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.webp', '.avif', '.heic', '.heif', '.gif', '.bmp', '.tif', '.tiff', '.ico'}
EXT_FOR = {'jpg': 'jpg', 'png': 'png', 'webp': 'webp', 'avif': 'avif', 'heic': 'heic', 'gif': 'gif', 'bmp': 'bmp', 'tiff': 'tiff', 'ico': 'ico'}
PIL_FORMAT = {'jpg': 'JPEG', 'png': 'PNG', 'webp': 'WEBP', 'avif': 'AVIF', 'heic': 'HEIF', 'gif': 'GIF', 'bmp': 'BMP', 'tiff': 'TIFF', 'ico': 'ICO'}
# Pillow's format name of a decoded file -> our short format key.
FROM_PIL = {'JPEG': 'jpg', 'MPO': 'jpg', 'PNG': 'png', 'WEBP': 'webp', 'AVIF': 'avif', 'HEIF': 'heic', 'GIF': 'gif',
            'BMP': 'bmp', 'TIFF': 'tiff', 'ICO': 'ico'}
ALPHA_FORMATS = {'png', 'webp', 'avif', 'heic', 'gif', 'tiff', 'ico'}
RESAMPLE = {'lanczos': Image.Resampling.LANCZOS, 'bicubic': Image.Resampling.BICUBIC,
            'bilinear': Image.Resampling.BILINEAR, 'nearest': Image.Resampling.NEAREST}

# Quality tiers from the image-compress README (compression_benchmark_results.txt).
PRESETS = {
    # preset: (quality per output format, default max dimension)
    'near': ({'jpg': 85, 'webp': 85, 'avif': 75, 'heic': 75, 'png': 0, 'gif': 0, 'tiff': 0, 'bmp': 0, 'ico': 0}, 0),
    'web': ({'jpg': 75, 'webp': 75, 'avif': 65, 'heic': 65, 'png': 256, 'gif': 0, 'tiff': 0, 'bmp': 0, 'ico': 0}, 2560),
    'aggressive': ({'jpg': 50, 'webp': 50, 'avif': 40, 'heic': 50, 'png': 128, 'gif': 0, 'tiff': 0, 'bmp': 0, 'ico': 0}, 1600),
}


# ---------------------------------------------------------------------------------------------
# small utilities
# ---------------------------------------------------------------------------------------------

def emit_progress(pct, message=None):
    line = {'progress': round(float(pct), 1)}
    if message:
        line['message'] = str(message)[:200]
    print(json.dumps(line), flush=True)


def parse_color(value, default=(255, 255, 255, 255)):
    """'#rgb', '#rrggbb', '#rrggbbaa' or 'transparent' -> RGBA tuple."""
    if not value:
        return default
    v = str(value).strip().lower()
    if v in ('transparent', 'none'):
        return (0, 0, 0, 0)
    if v.startswith('#'):
        v = v[1:]
    if len(v) in (3, 4):
        v = ''.join(c * 2 for c in v)
    try:
        if len(v) == 6:
            return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16), 255)
        if len(v) == 8:
            return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16), int(v[6:8], 16))
    except ValueError:
        pass
    return default


def has_alpha(im):
    if im.mode in ('RGBA', 'LA', 'PA', 'RGBa', 'La'):
        return True
    return im.mode == 'P' and 'transparency' in im.info


def alpha_is_used(im):
    """True when the image has an alpha channel with at least one non-opaque pixel."""
    if not has_alpha(im):
        return False
    a = im.convert('RGBA').getchannel('A')
    lo, _ = a.getextrema()
    return lo < 255


def flatten(im, bg=(255, 255, 255, 255)):
    """Composite onto an opaque background -> RGB."""
    if not has_alpha(im):
        return im.convert('RGB') if im.mode != 'RGB' else im
    rgba = im.convert('RGBA')
    base = Image.new('RGBA', rgba.size, (bg[0], bg[1], bg[2], 255))
    base.alpha_composite(rgba)
    return base.convert('RGB')


def normalize_mode(im):
    """Bring exotic modes (CMYK, I;16, F, P, 1...) to L / LA / RGB / RGBA."""
    if im.mode in ('RGB', 'RGBA', 'L', 'LA'):
        return im
    if has_alpha(im):
        return im.convert('RGBA')
    if im.mode in ('1', 'I;16', 'I;16B', 'I;16L', 'I', 'F'):
        if im.mode in ('I;16', 'I;16B', 'I;16L', 'I'):
            # 16-bit grayscale: scale down to 8-bit instead of clipping.
            arr = np.asarray(im, dtype=np.float64)
            mx = arr.max() if arr.size else 1
            arr = (arr * (255.0 / (65535.0 if mx > 255 else 255.0))).clip(0, 255).astype(np.uint8)
            return Image.fromarray(arr, 'L')
        return im.convert('L')
    return im.convert('RGB')


def unique_name(name, used):
    stem, ext = os.path.splitext(name)
    candidate = name
    i = 2
    while candidate.lower() in used:
        candidate = f'{stem}-{i}{ext}'
        i += 1
    used.add(candidate.lower())
    return candidate


def file_kind(path):
    """Detect our short format key by content (falls back to the extension)."""
    try:
        with Image.open(path) as im:
            return FROM_PIL.get(im.format or '', None) or ext_kind(path)
    except Exception:
        return ext_kind(path)


def ext_kind(path):
    e = os.path.splitext(path)[1].lower().lstrip('.')
    return {'jpeg': 'jpg', 'jpe': 'jpg', 'jfif': 'jpg', 'tif': 'tiff', 'heif': 'heic'}.get(e, e)


def load_image(path, draft_box=None):
    """Open, apply EXIF orientation, and normalise the mode. Returns (image, info)."""
    im = Image.open(path)
    fmt = FROM_PIL.get(im.format or '', ext_kind(path))
    info = {
        'format': fmt,
        'icc': im.info.get('icc_profile'),
        'exif': im.info.get('exif'),
        'origMode': im.mode,
        'animated': bool(getattr(im, 'is_animated', False)) and getattr(im, 'n_frames', 1) > 1,
        'n_frames': getattr(im, 'n_frames', 1),
    }
    if draft_box and fmt == 'jpg':
        # Fast IDCT downscale while decoding (batch_compression_stats.md: ~30% faster).
        try:
            im.draft('RGB', draft_box)
        except Exception:
            pass
    try:
        transposed = ImageOps.exif_transpose(im)
        if transposed is not None:
            im = transposed
    except Exception:
        im.load()
    exif_after = im.info.get('exif')
    if exif_after is not None:
        info['exif'] = exif_after
    if info['origMode'] == 'CMYK':
        info['icc'] = None  # a CMYK profile would be wrong once converted to RGB
    im = normalize_mode(im)
    return im, info


def fit_max(im, max_dim, resample=Image.Resampling.LANCZOS):
    if not max_dim or max_dim <= 0:
        return im
    w, h = im.size
    if max(w, h) <= max_dim:
        return im
    if w >= h:
        nw, nh = max_dim, max(1, round(h * max_dim / w))
    else:
        nw, nh = max(1, round(w * max_dim / h)), max_dim
    return im.resize((nw, nh), resample)


# ---------------------------------------------------------------------------------------------
# encoders
# ---------------------------------------------------------------------------------------------

def encode(im, fmt, path, quality=80, *, progressive=True, method=4, lossless=False, bg=(255, 255, 255, 255),
           icc=None, exif=None, colors=0, speed=6):
    """Save `im` as `fmt` (our short key) to `path`."""
    kw = {}
    if icc:
        kw['icc_profile'] = icc
    if exif and fmt in ('jpg', 'webp', 'png', 'avif', 'heic', 'tiff'):
        kw['exif'] = exif
    q = int(max(1, min(100, quality or 80)))

    if fmt == 'jpg':
        out = flatten(im, bg) if im.mode not in ('RGB', 'L') else im
        out.save(path, 'JPEG', quality=q, optimize=True, progressive=bool(progressive), **kw)
    elif fmt == 'webp':
        out = im if im.mode in ('RGB', 'RGBA') else im.convert('RGBA' if has_alpha(im) else 'RGB')
        if lossless:
            # For lossless WebP, `quality` is the compression effort (Pillow default 80).
            out.save(path, 'WEBP', lossless=True, quality=q, method=int(method), **kw)
        else:
            out.save(path, 'WEBP', quality=q, method=int(method), **kw)
    elif fmt == 'avif':
        out = im if im.mode in ('RGB', 'RGBA') else im.convert('RGBA' if has_alpha(im) else 'RGB')
        out.save(path, 'AVIF', quality=100 if lossless else q, speed=int(speed), **kw)
    elif fmt == 'heic':
        if not HAS_HEIF:
            raise RuntimeError('HEIC encoding needs the pillow-heif Python package')
        out = im if im.mode in ('RGB', 'RGBA') else im.convert('RGBA' if has_alpha(im) else 'RGB')
        out.save(path, 'HEIF', quality=-1 if lossless else q, **kw)
    elif fmt == 'png':
        out = im
        if colors and colors > 1:
            # Lossy palette reduction (pngquant-style) for the web / aggressive tiers.
            src = im.convert('RGBA') if has_alpha(im) else im.convert('RGB')
            out = src.quantize(colors=int(min(256, colors)), method=Image.Quantize.FASTOCTREE if src.mode == 'RGBA'
                               else Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
        out.save(path, 'PNG', optimize=True, **kw)
    elif fmt == 'gif':
        src = im.convert('RGBA') if has_alpha(im) else im.convert('RGB')
        out = src.quantize(colors=int(colors) if colors and colors > 1 else 256,
                           method=Image.Quantize.FASTOCTREE if src.mode == 'RGBA' else Image.Quantize.MEDIANCUT)
        out.save(path, 'GIF', optimize=True)
    elif fmt == 'bmp':
        flatten(im, bg).save(path, 'BMP')
    elif fmt == 'tiff':
        out = im if im.mode in ('RGB', 'RGBA', 'L', 'LA') else im.convert('RGB')
        out.save(path, 'TIFF', compression='tiff_adobe_deflate', **({'icc_profile': icc} if icc else {}))
    elif fmt == 'ico':
        src = im.convert('RGBA')
        side = max(src.size)
        square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
        square.paste(src, ((side - src.width) // 2, (side - src.height) // 2))
        sizes = [s for s in (16, 24, 32, 48, 64, 128, 256) if s <= max(16, side)]
        square.resize((min(256, side),) * 2, Image.Resampling.LANCZOS).save(path, 'ICO', sizes=[(s, s) for s in sizes])
    else:
        raise ValueError(f'Unsupported output format: {fmt}')


# ---------------------------------------------------------------------------------------------
# lossless JPEG marker stripping (strip_jpeg.py)
# ---------------------------------------------------------------------------------------------

def jpeg_orientation(data):
    try:
        from io import BytesIO
        with Image.open(BytesIO(data)) as im:
            return int(im.getexif().get(0x0112, 1) or 1)
    except Exception:
        return 1


def strip_jpeg_bytes(data, keep_icc=True, keep_exif=False):
    """
    Drop APPn (except optionally ICC APP2 / EXIF APP1) and COM segments before SOS.
    The entropy-coded scan data is copied untouched, so decoded pixels are bit-identical.
    If the photo relies on an EXIF orientation tag we keep a minimal EXIF with only that tag,
    otherwise the image would display rotated.
    Returns (bytes, stripped_bytes_count, markers_removed).
    """
    if data[:2] != b'\xff\xd8':
        raise ValueError('Not a valid JPEG')
    orientation = 1 if keep_exif else jpeg_orientation(data)
    pos = 2
    out = [b'\xff\xd8']
    removed = []
    exif_written = False
    while pos < len(data) - 1:
        if data[pos] != 0xFF:
            pos += 1
            continue
        marker = data[pos + 1]
        if marker == 0xFF:  # fill byte
            pos += 1
            continue
        if marker == 0xDA:  # SOS: copy everything from here on verbatim
            out.append(data[pos:])
            break
        if marker in (0xD8, 0xD9, 0x01) or 0xD0 <= marker <= 0xD7:
            pos += 2
            continue
        if pos + 4 > len(data):
            raise ValueError('Truncated JPEG header')
        length = struct.unpack('>H', data[pos + 2:pos + 4])[0]
        segment = data[pos:pos + 2 + length]
        payload = data[pos + 4:pos + 2 + length]
        is_app = 0xE0 <= marker <= 0xEF
        keep = not is_app and marker != 0xFE
        if marker == 0xE2 and keep_icc and payload.startswith(b'ICC_PROFILE\x00'):
            keep = True
        if marker == 0xE1 and keep_exif and payload.startswith(b'Exif\x00\x00'):
            keep = True
        if marker == 0xE0 and payload.startswith(b'JFIF\x00'):
            # JFIF APP0 is 18 bytes and some decoders like seeing it; keeping it costs nothing.
            keep = True
        if keep:
            out.append(segment)
        else:
            removed.append({'marker': f'0x{marker:02X}', 'bytes': len(segment)})
        if not keep and marker == 0xE1 and orientation != 1 and not exif_written:
            ex = Image.Exif()
            ex[0x0112] = orientation
            exif_bytes = ex.tobytes()
            out.append(b'\xff\xe1' + struct.pack('>H', len(exif_bytes) + 2) + exif_bytes)
            exif_written = True
        pos += 2 + length
    result = b''.join(out)
    return result, len(data) - len(result), removed


# ---------------------------------------------------------------------------------------------
# metrics: PSNR + SSIM (numpy; matches skimage.structural_similarity defaults: 7x7 uniform
# window, sample covariance, K1=0.01, K2=0.03, data_range=255, border cropped)
# ---------------------------------------------------------------------------------------------

def _box_mean(x, k=7):
    c = np.pad(x, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    return s / float(k * k)


def ssim_gray(a, b):
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    if a.shape != b.shape:
        raise ValueError('shape mismatch')
    if min(a.shape) < 7:
        return 1.0 if np.array_equal(a, b) else float(1 - np.mean(np.abs(a - b)) / 255.0)
    k = 7
    n = k * k
    cov_norm = n / (n - 1.0)
    ux, uy = _box_mean(a), _box_mean(b)
    uxx, uyy, uxy = _box_mean(a * a), _box_mean(b * b), _box_mean(a * b)
    vx = cov_norm * (uxx - ux * ux)
    vy = cov_norm * (uyy - uy * uy)
    vxy = cov_norm * (uxy - ux * uy)
    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    s = ((2 * ux * uy + c1) * (2 * vxy + c2)) / ((ux * ux + uy * uy + c1) * (vx + vy + c2))
    return float(s.mean())


def gray_sample(arr, step):
    a = arr[::step, ::step]
    return 0.2989 * a[..., 0] + 0.5870 * a[..., 1] + 0.1140 * a[..., 2]


def rgb_array(im):
    return np.asarray(flatten(im) if im.mode != 'RGB' else im, dtype=np.uint8)


class Reference:
    """Decoded original kept in memory for comparing many variants."""

    def __init__(self, im):
        self.arr = rgb_array(im)
        self.h, self.w = self.arr.shape[:2]
        # Sample ~1000 px on the long side for SSIM (the original engine used [::4] on 4160 px).
        self.step = max(1, int(round(max(self.w, self.h) / 1024)))
        self.gray = gray_sample(self.arr, self.step)

    def compare(self, im):
        if im.size != (self.w, self.h):
            im = flatten(im).resize((self.w, self.h), Image.Resampling.LANCZOS)
        arr = rgb_array(im)
        # Chunked MSE so 12+ MP images don't allocate several hundred MB.
        total = 0.0
        max_diff = 0
        rows = max(1, 2_000_000 // max(1, self.w * 3))
        for y in range(0, self.h, rows):
            d = self.arr[y:y + rows].astype(np.int16) - arr[y:y + rows].astype(np.int16)
            total += float(np.sum(d.astype(np.float64) ** 2))
            max_diff = max(max_diff, int(np.abs(d).max()))
        mse = total / float(self.arr.size)
        psnr = float('inf') if mse == 0 else 20 * math.log10(255.0 / math.sqrt(mse))
        ssim = ssim_gray(self.gray, gray_sample(arr, self.step))
        return psnr, ssim, max_diff


def metric_json(psnr, ssim):
    return {'psnr': None if psnr is None or math.isinf(psnr) else round(psnr, 2),
            'psnrInf': bool(psnr is not None and math.isinf(psnr)),
            'ssim': None if ssim is None else round(ssim, 5)}


# ---------------------------------------------------------------------------------------------
# process pool helpers
# ---------------------------------------------------------------------------------------------

def _watch_parent(ppid):
    """Exit the worker when the parent (killed by the Node side on cancel/timeout) disappears."""
    if os.name == 'nt':
        try:
            import ctypes
            k32 = ctypes.windll.kernel32
            handle = k32.OpenProcess(0x00100000, False, ppid)  # SYNCHRONIZE
            if handle:
                k32.WaitForSingleObject(handle, 0xFFFFFFFF)
                os._exit(1)
        except Exception:
            return
    else:
        while True:
            time.sleep(1.0)
            if os.getppid() != ppid:
                os._exit(1)


def _worker_init(ppid):
    threading.Thread(target=_watch_parent, args=(ppid,), daemon=True).start()


def worker_count(requested, jobs):
    cpus = os.cpu_count() or 2
    n = int(requested) if requested and int(requested) > 0 else cpus
    return max(1, min(n, cpus, jobs, 16))


def run_parallel(fn, tasks, workers, label):
    """Run fn(task) over tasks (in a process pool when worthwhile); yields results in completion order."""
    total = len(tasks)
    if total == 0:
        return
    if workers <= 1 or total == 1:
        for i, t in enumerate(tasks, 1):
            yield fn(t)
            emit_progress(5 + 90 * i / total, f'{label} {i}/{total}')
        return
    done = 0
    with ProcessPoolExecutor(max_workers=workers, initializer=_worker_init, initargs=(os.getpid(),)) as ex:
        futures = [ex.submit(fn, t) for t in tasks]
        for fut in as_completed(futures):
            done += 1
            try:
                yield fut.result()
            except Exception as e:  # worker crashed (e.g. memory)
                yield {'error': f'worker failed: {e}'}
            emit_progress(5 + 90 * done / total, f'{label} {done}/{total}')


# ---------------------------------------------------------------------------------------------
# compress (single files, presets)
# ---------------------------------------------------------------------------------------------

def target_format(src_fmt, wanted, alpha):
    if wanted and wanted != 'keep':
        return wanted
    if src_fmt in ('jpg', 'png', 'webp', 'avif', 'heic', 'gif'):
        return src_fmt
    if src_fmt == 'tiff':
        return 'png' if alpha else 'jpg'
    return 'png'  # bmp, ico, unknown


def compress_one(task):
    src = task['input']
    o = task['options']
    t0 = time.time()
    res = {'file': task['name'], 'origSize': os.path.getsize(src)}
    try:
        with open(src, 'rb') as f:
            data = f.read()
        src_fmt = file_kind(src)
        preset = o.get('preset', 'web')
        keep_meta = bool(o.get('keepMetadata'))
        keep_icc = bool(o.get('keepIcc', True)) or keep_meta
        resample = RESAMPLE.get(o.get('resample', 'lanczos'), Image.Resampling.LANCZOS)

        im, info = load_image(src)
        orig_w, orig_h = im.size
        res.update({'origWidth': orig_w, 'origHeight': orig_h, 'inputFormat': src_fmt})
        ref = Reference(im) if o.get('metrics', True) else None
        alpha = alpha_is_used(im)
        fmt = target_format(src_fmt, o.get('format', 'keep'), alpha)
        out_dir = task['outDir']
        stem = os.path.splitext(task.get('outFile') or task['name'])[0]
        out_path = os.path.join(out_dir, f'{stem}.{EXT_FOR[fmt]}')
        method = ''

        if preset == 'lossless':
            if src_fmt == 'jpg' and fmt == 'jpg':
                stripped, saved, removed = strip_jpeg_bytes(data, keep_icc=keep_icc, keep_exif=keep_meta)
                with open(out_path, 'wb') as f:
                    f.write(stripped)
                method = f'Marker strip ({len(removed)} segment{"s" if len(removed) != 1 else ""} removed)'
                res['removed'] = removed
            elif fmt in ('png', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'heic', 'ico'):
                lossless_fmt = fmt if fmt in ('png', 'webp') else ('png' if fmt in ('bmp', 'tiff', 'ico') else fmt)
                if lossless_fmt != fmt:
                    fmt = lossless_fmt
                    out_path = os.path.join(out_dir, f'{stem}.{EXT_FOR[fmt]}')
                if fmt in ('png', 'webp'):
                    encode(im, fmt, out_path, 90, lossless=True, method=5, icc=info['icc'] if keep_icc else None,
                           exif=info['exif'] if keep_meta else None)
                    method = 'Lossless re-encode (optimize)' if fmt == 'png' else 'Lossless WebP (method 6)'
                else:
                    shutil.copyfile(src, out_path)
                    method = 'Already compressed (kept original)'
            else:
                shutil.copyfile(src, out_path)
                method = 'No lossless option for this format (kept original)'
        else:
            if preset == 'custom':
                q = int(o.get('quality') or 80)
                max_dim = int(o.get('maxDim') or 0)
                colors = int(o.get('pngColors') or 0)
            else:
                table, default_max = PRESETS.get(preset, PRESETS['web'])
                q = table.get(fmt, 80) or 80
                colors = table.get('png', 0) if fmt == 'png' else 0
                max_dim = int(o.get('maxDim') or 0) or default_max
            work = fit_max(im, max_dim, resample)
            if fmt == 'png' and preset == 'custom':
                colors = int(o.get('pngColors') or 0)
            encode(work, fmt, out_path, q, progressive=o.get('progressive', True), method=int(o.get('webpMethod', 4)),
                   bg=parse_color(o.get('background', '#ffffff')), icc=info['icc'] if keep_icc else None,
                   exif=info['exif'] if keep_meta else None, colors=colors)
            if fmt == 'png':
                method = f'PNG optimize{f" + {colors}-color palette" if colors else ""}'
            elif fmt in ('gif', 'bmp', 'tiff', 'ico'):
                method = fmt.upper()
            else:
                method = f'{fmt.upper()} Q{q}'
            if work.size != im.size:
                method += f' · max {max_dim}px'

        new_size = os.path.getsize(out_path)
        kept = False
        if o.get('neverLarger', True) and new_size >= res['origSize'] and fmt == src_fmt:
            # Re-encoding made it bigger: ship the original (stripped if it is a JPEG).
            if src_fmt == 'jpg':
                stripped, _, _ = strip_jpeg_bytes(data, keep_icc=keep_icc, keep_exif=keep_meta)
                with open(out_path, 'wb') as f:
                    f.write(stripped if len(stripped) < len(data) else data)
            else:
                shutil.copyfile(src, out_path)
            new_size = os.path.getsize(out_path)
            kept = True
            method += ' → larger than input, kept original'

        with Image.open(out_path) as check:
            out_im = ImageOps.exif_transpose(check) or check
            out_im.load()
            res['width'], res['height'] = out_im.size
            if ref is not None:
                psnr, ssim, max_diff = ref.compare(normalize_mode(out_im))
                res.update(metric_json(psnr, ssim))
                res['maxDiff'] = max_diff
        res.update({
            'output': os.path.basename(out_path), 'outputPath': out_path, 'format': fmt, 'newSize': new_size,
            'savedPct': round((1 - new_size / res['origSize']) * 100, 2) if res['origSize'] else 0,
            'method': method, 'keptOriginal': kept, 'ms': int((time.time() - t0) * 1000),
        })
    except Exception as e:
        res['error'] = f'{type(e).__name__}: {e}'
    return res


def cmd_compress(spec):
    out_dir = spec['outDir']
    os.makedirs(out_dir, exist_ok=True)
    o = spec.get('options', {})
    used = set()
    tasks = []
    for inp in spec['inputs']:
        stem = os.path.splitext(inp['name'])[0]
        fmt_guess = o.get('format', 'keep')
        ext = EXT_FOR.get(fmt_guess) if fmt_guess != 'keep' else None
        # Reserve a unique output name up-front so parallel workers never collide.
        src_fmt = ext_kind(inp['path'])
        out_ext = ext or EXT_FOR.get(target_format(src_fmt, 'keep', False), 'png')
        if o.get('preset') == 'lossless' and out_ext not in ('jpg', 'png', 'webp', 'avif', 'heic', 'gif'):
            out_ext = 'png'
        tasks.append({'input': inp['path'], 'name': inp['name'], 'outDir': out_dir,
                      'outFile': unique_name(f'{stem}.{out_ext}', used), 'options': o})
    workers = worker_count(o.get('workers'), len(tasks))
    emit_progress(3, f'Compressing {len(tasks)} image(s) on {workers} worker(s)')
    results = list(run_parallel(compress_one, tasks, workers, 'Compressed'))
    order = {t['name']: i for i, t in enumerate(tasks)}
    results.sort(key=lambda r: order.get(r.get('file'), 0))
    ok = [r for r in results if 'error' not in r]
    total_before = sum(r['origSize'] for r in ok)
    total_after = sum(r['newSize'] for r in ok)
    return {
        'files': results,
        'totals': {'count': len(ok), 'errors': len(results) - len(ok), 'before': total_before, 'after': total_after,
                   'savedPct': round((1 - total_after / total_before) * 100, 2) if total_before else 0},
        'workers': workers,
    }


# ---------------------------------------------------------------------------------------------
# batch (batch_compressor.py): many files and/or zips -> one zip with the same tree
# ---------------------------------------------------------------------------------------------

MAX_BATCH_IMAGES = 5000
MAX_ZIP_UNCOMPRESSED = 4 * 1024 ** 3


def safe_rel(path):
    parts = [p for p in path.replace('\\', '/').split('/') if p not in ('', '.', '..')]
    parts = [''.join(ch if ch.isalnum() or ch in ' ._-()[]+@,' else '_' for ch in p)[:150] for p in parts]
    return '/'.join(p for p in parts if p.strip('. '))


def batch_one(task):
    src, dst, o = task['input'], task['output'], task['options']
    t0 = time.time()
    try:
        orig = os.path.getsize(src)
        max_dim = int(o.get('maxDim') or 0)
        draft = None
        if o.get('fastDecode') and max_dim:
            with Image.open(src) as probe:
                w, h = probe.size
            if max(w, h) > max_dim:
                s = max_dim / max(w, h)
                draft = (max(1, math.ceil(w * s)), max(1, math.ceil(h * s)))
        im, info = load_image(src, draft_box=draft)
        ow, oh = im.size
        im = fit_max(im, max_dim, RESAMPLE.get(o.get('resample', 'lanczos'), Image.Resampling.LANCZOS))
        fmt = o['format']
        if fmt == 'keep':
            fmt = target_format(info['format'], 'keep', alpha_is_used(im))
            dst = os.path.splitext(dst)[0] + '.' + EXT_FOR[fmt]
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        keep_meta = bool(o.get('keepMetadata'))
        encode(im, fmt, dst, int(o.get('quality', 75)), method=int(o.get('webpMethod', 4)), progressive=True,
               icc=info['icc'] if (keep_meta or o.get('keepIcc', True)) else None,
               exif=info['exif'] if keep_meta else None, bg=parse_color(o.get('background', '#ffffff')),
               colors=int(o.get('pngColors') or 0) if fmt == 'png' else 0)
        new = os.path.getsize(dst)
        return {'file': task['rel'], 'output': os.path.relpath(dst, task['root']).replace('\\', '/'), 'origSize': orig,
                'newSize': new, 'width': im.size[0], 'height': im.size[1], 'origWidth': ow, 'origHeight': oh,
                'ms': int((time.time() - t0) * 1000)}
    except Exception as e:
        return {'file': task['rel'], 'error': f'{type(e).__name__}: {e}'}


def cmd_batch(spec):
    o = spec.get('options', {})
    work = spec['workDir']
    src_root = os.path.join(work, 'src')
    out_root = os.path.join(work, 'compressed')
    os.makedirs(src_root, exist_ok=True)
    os.makedirs(out_root, exist_ok=True)

    entries = []  # (abs input path, relative path)
    zips = [i for i in spec['inputs'] if i['name'].lower().endswith('.zip')]
    skipped = []
    budget = MAX_ZIP_UNCOMPRESSED
    for inp in spec['inputs']:
        if inp['name'].lower().endswith('.zip'):
            prefix = safe_rel(os.path.splitext(inp['name'])[0]) + '/' if len(zips) > 1 else ''
            try:
                with zipfile.ZipFile(inp['path']) as zf:
                    for zi in zf.infolist():
                        if zi.is_dir():
                            continue
                        rel = safe_rel(zi.filename)
                        if not rel or rel.startswith('__MACOSX/') or os.path.basename(rel).startswith('._'):
                            continue
                        if os.path.splitext(rel)[1].lower() not in IMAGE_EXTS:
                            skipped.append(rel)
                            continue
                        if len(entries) >= MAX_BATCH_IMAGES:
                            raise ValueError(f'More than {MAX_BATCH_IMAGES} images in the upload')
                        budget -= zi.file_size
                        if budget < 0:
                            raise ValueError('Zip contents exceed the 4 GB uncompressed limit')
                        dest = os.path.join(src_root, f'z{len(entries)}' + os.path.splitext(rel)[1].lower())
                        with zf.open(zi) as fsrc, open(dest, 'wb') as fdst:
                            shutil.copyfileobj(fsrc, fdst, 1024 * 1024)
                        entries.append((dest, prefix + rel))
            except zipfile.BadZipFile:
                raise ValueError(f'{inp["name"]} is not a valid zip file')
        else:
            if len(entries) >= MAX_BATCH_IMAGES:
                raise ValueError(f'More than {MAX_BATCH_IMAGES} images in the upload')
            entries.append((inp['path'], safe_rel(inp['name']) or 'image'))
    if not entries:
        raise ValueError('No images found in the upload')

    fmt = o.get('format', 'webp')
    used = set()
    tasks = []
    for path, rel in entries:
        stem = os.path.splitext(rel)[0]
        out_rel = unique_name(f'{stem}.{EXT_FOR.get(fmt, "img") if fmt != "keep" else "keep"}', used)
        tasks.append({'input': path, 'rel': rel, 'output': os.path.join(out_root, *out_rel.split('/')),
                      'root': out_root, 'options': {**o, 'format': fmt}})

    workers = worker_count(o.get('workers'), len(tasks))
    emit_progress(4, f'{len(tasks)} images on {workers} worker(s)')
    t0 = time.time()
    results = list(run_parallel(batch_one, tasks, workers, 'Compressed'))
    elapsed = time.time() - t0
    ok = [r for r in results if 'error' not in r]
    errs = [r for r in results if 'error' in r]
    before = sum(r['origSize'] for r in ok)
    after = sum(r['newSize'] for r in ok)

    emit_progress(96, 'Writing zip')
    os.makedirs(spec['outDir'], exist_ok=True)
    zip_path = os.path.join(spec['outDir'], spec.get('zipName') or 'compressed-images.zip')
    ok.sort(key=lambda r: r['output'])
    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
        for r in ok:
            zf.write(os.path.join(out_root, *r['output'].split('/')), r['output'])
        lines = ['file,output,original_bytes,new_bytes,saved_pct,width,height,ms']
        for r in ok:
            saved = (1 - r['newSize'] / r['origSize']) * 100 if r['origSize'] else 0
            lines.append(f'"{r["file"]}","{r["output"]}",{r["origSize"]},{r["newSize"]},{saved:.1f},{r["width"]},{r["height"]},{r["ms"]}')
        for r in errs:
            lines.append(f'"{r["file"]}",ERROR,,,,,,"{r["error"]}"')
        zf.writestr('_compression-report.csv', '\n'.join(lines) + '\n', compress_type=zipfile.ZIP_DEFLATED)

    return {
        'zip': zip_path,
        'stats': {
            'count': len(ok), 'errors': len(errs), 'before': before, 'after': after,
            'savedPct': round((1 - after / before) * 100, 2) if before else 0,
            'elapsedSec': round(elapsed, 2), 'throughput': round(len(results) / elapsed, 2) if elapsed > 0 else None,
            'workers': workers, 'skipped': len(skipped),
        },
        'errors': errs[:200],
        'files': [{k: r[k] for k in ('file', 'output', 'origSize', 'newSize', 'width', 'height')} for r in ok[:500]],
        'skippedFiles': skipped[:50],
    }


# ---------------------------------------------------------------------------------------------
# benchmark (benchmark_engine.py): one image -> ~33 profiles with metrics
# ---------------------------------------------------------------------------------------------

def P(id_, name, category, fmt, q=None, notes='', **kw):
    return dict(id=id_, name=name, category=category, fmt=fmt, q=q, notes=notes, **kw)


PROFILES = [
    P('01', 'Lossless JPEG (EXIF stripped)', 'lossless', 'jpg', strip=True, notes='Bit-identical DCT/pixels; removes EXIF/APP/COM markers'),
    P('02', 'Lossless WebP', 'lossless', 'webp', lossless=True, method=4, notes='Pixel-exact; encodes JPEG noise, so photos usually grow'),
    P('03', 'Lossless PNG', 'lossless', 'png', lossless=True, notes='Pixel-exact; Deflate on photo noise usually expands'),
    P('04', 'JPEG Q95 (optimized)', 'near', 'jpg', 95, progressive=False, notes='Optimized Huffman tables, negligible loss'),
    P('05', 'JPEG Q90 (progressive)', 'near', 'jpg', 90, notes='Progressive scan + optimized Huffman'),
    P('06', 'JPEG Q85 (progressive)', 'near', 'jpg', 85, notes='Standard high-fidelity photo archival'),
    P('07', 'WebP Q90', 'near', 'webp', 90, method=5, notes='High fidelity modern WebP'),
    P('08', 'WebP Q85', 'near', 'webp', 85, method=5, notes='Visually indistinguishable on 4K monitors'),
    P('09', 'AVIF Q85', 'near', 'avif', 85, notes='Next-gen AV1 intra, high fidelity'),
    P('10', 'AVIF Q75', 'near', 'avif', 75, notes='Remarkable fidelity at low size'),
    P('11', 'HEIC Q85', 'near', 'heic', 85, notes='Apple/iOS native HEVC intra'),
    P('12', 'HEIC Q75', 'near', 'heic', 75, notes='Apple ecosystem standard photo quality'),
    P('13', 'JPEG Q80 (progressive)', 'web', 'jpg', 80, notes='Balanced JPEG for web delivery'),
    P('14', 'JPEG Q75 (progressive)', 'web', 'jpg', 75, notes='Classic web standard for photos'),
    P('15', 'JPEG Q70 (progressive)', 'web', 'jpg', 70, notes='Minor high-frequency loss'),
    P('16', 'WebP Q75', 'web', 'webp', 75, method=5, notes='Industry standard WebP for the web'),
    P('17', 'WebP Q65', 'web', 'webp', 65, method=5, notes='High compression, great perceptual clarity'),
    P('18', 'AVIF Q65', 'web', 'avif', 65, notes='Next-gen sweet spot: big savings, no ringing'),
    P('19', 'AVIF Q55', 'web', 'avif', 55, notes='Deep reduction, minimal visible distortion'),
    P('20', 'HEIC Q65', 'web', 'heic', 65, notes='HEVC web/mobile standard'),
    P('21', 'JPEG Q50', 'aggressive', 'jpg', 50, progressive=False, notes='Visible 8x8 block artifacts'),
    P('22', 'JPEG Q30', 'aggressive', 'jpg', 30, progressive=False, notes='Strong artifacts, color banding'),
    P('23', 'WebP Q50', 'aggressive', 'webp', 50, method=5, notes='Noticeable smoothing, no DCT blocks'),
    P('24', 'WebP Q30', 'aggressive', 'webp', 30, method=5, notes='Heavy smoothing, fast mobile load'),
    P('25', 'AVIF Q40', 'aggressive', 'avif', 40, notes='Soft edges; beats JPEG/WebP at low bitrates'),
    P('26', 'AVIF Q25', 'aggressive', 'avif', 25, notes='Extreme compression, tiny footprint'),
    P('27', 'Resized 75% · WebP Q80', 'resized', 'webp', 80, method=5, scale=0.75, notes='Sharper than most 4K screens need'),
    P('28', 'Resized 50% · WebP Q80', 'resized', 'webp', 80, method=5, scale=0.5, notes='2K/QHD: ideal for retina laptops'),
    P('29', 'Resized 50% · AVIF Q65', 'resized', 'avif', 65, scale=0.5, notes='2K with AVIF: extreme efficiency'),
    P('30', 'Max 1920px · WebP Q75', 'resized', 'webp', 75, method=5, maxDim=1920, notes='Desktop fullscreen viewing'),
    P('31', 'Max 1200px · WebP Q75', 'resized', 'webp', 75, method=5, maxDim=1200, notes='Web hero banner / blog image'),
    P('32', 'Max 1200px · AVIF Q60', 'resized', 'avif', 60, maxDim=1200, notes='Sub-150KB hero for fast LCP'),
    P('33', 'Max 1200px · JPEG Q75', 'resized', 'jpg', 75, maxDim=1200, notes='Universal legacy fallback'),
]

CATEGORY_LABEL = {'lossless': 'Lossless', 'near': 'Near-lossless', 'web': 'Web sweet spot',
                  'aggressive': 'Aggressive', 'resized': 'Resolution + format'}


def slug(s):
    return ''.join(c.lower() if c.isalnum() else '_' for c in s).strip('_').replace('__', '_')


def bench_one(task):
    p = task['profile']
    src = task['input']
    out = task['output']
    caps = task['caps']
    row = {'id': p['id'], 'name': p['name'], 'category': p['category'], 'categoryLabel': CATEGORY_LABEL[p['category']],
           'format': p['fmt'], 'quality': p['q'], 'notes': p['notes'], 'output': os.path.basename(out)}
    try:
        if not caps.get(p['fmt'], False):
            row['skipped'] = f'{p["fmt"].upper()} encoding is not available on this server'
            return row
        im, info = load_image(src)
        src_fmt = info['format']
        if p.get('strip') and src_fmt != 'jpg':
            row['skipped'] = 'Bitstream stripping only applies to JPEG input'
            return row
        ref = Reference(im)
        t0 = time.time()
        if p.get('strip'):
            with open(src, 'rb') as f:
                data = f.read()
            stripped, _, _ = strip_jpeg_bytes(data, keep_icc=True)
            with open(out, 'wb') as f:
                f.write(stripped)
        else:
            work = im
            if p.get('scale'):
                w, h = im.size
                work = im.resize((max(1, int(w * p['scale'])), max(1, int(h * p['scale']))), Image.Resampling.LANCZOS)
            elif p.get('maxDim'):
                work = fit_max(im, p['maxDim'])
            encode(work, p['fmt'], out, p['q'] or 80, progressive=p.get('progressive', True), method=p.get('method', 5),
                   lossless=bool(p.get('lossless')), icc=info['icc'])
        enc_ms = (time.time() - t0) * 1000
        size = os.path.getsize(out)
        with Image.open(out) as chk:
            out_im = ImageOps.exif_transpose(chk) or chk
            out_im.load()
            row['width'], row['height'] = out_im.size
            psnr, ssim, max_diff = ref.compare(normalize_mode(out_im))
        row.update(metric_json(psnr, ssim))
        row.update({'size': size, 'maxDiff': max_diff, 'encodeMs': round(enc_ms, 1)})
    except Exception as e:
        row['error'] = f'{type(e).__name__}: {e}'
    return row


def encode_caps():
    caps = {}
    probe = Image.new('RGB', (16, 16), (200, 80, 40))
    import io
    for key in ('jpg', 'png', 'webp', 'avif', 'heic', 'gif', 'bmp', 'tiff', 'ico'):
        try:
            if key == 'heic' and not HAS_HEIF:
                raise RuntimeError('no heif')
            buf = io.BytesIO()
            if key == 'heic':
                probe.save(buf, 'HEIF', quality=50)
            elif key == 'avif':
                probe.save(buf, 'AVIF', quality=50)
            else:
                probe.save(buf, PIL_FORMAT[key])
            caps[key] = buf.tell() > 0
        except Exception:
            caps[key] = False
    return caps


def cmd_benchmark(spec):
    o = spec.get('options', {})
    inp = spec['inputs'][0]
    out_dir = spec['outDir']
    os.makedirs(out_dir, exist_ok=True)
    cats = [c.strip() for c in str(o.get('categories') or '').split(',') if c.strip()]
    ids = [c.strip().zfill(2) for c in str(o.get('profiles') or '').split(',') if c.strip()]
    profiles = [p for p in PROFILES if (not cats or p['category'] in cats) and (not ids or p['id'] in ids)]
    if not profiles:
        raise ValueError('No profiles selected')
    caps = encode_caps()
    with Image.open(inp['path']) as probe:
        ow, oh = probe.size
    im, info = load_image(inp['path'])
    w, h = im.size
    del im
    tasks = []
    for p in profiles:
        name = f'{p["id"]}_{slug(p["name"])}.{EXT_FOR[p["fmt"]]}'
        tasks.append({'profile': p, 'input': inp['path'], 'output': os.path.join(out_dir, name), 'caps': caps})
    # Longest jobs first (HEIC/x265 and lossless WebP dominate) so they overlap with the cheap ones.
    cost = {'heic': 5, 'png': 3, 'webp': 2, 'avif': 2, 'jpg': 1}
    tasks.sort(key=lambda t: -(cost.get(t['profile']['fmt'], 1) + (3 if t['profile'].get('lossless') else 0)
                               - (1 if t['profile'].get('scale') or t['profile'].get('maxDim') else 0)))
    workers = worker_count(o.get('workers') or (4 if o.get('parallel', True) else 1), len(tasks))
    emit_progress(3, f'{len(tasks)} profiles on {workers} worker(s)')
    rows = list(run_parallel(bench_one, tasks, workers, 'Encoded'))
    rows.sort(key=lambda r: r['id'])
    orig_size = os.path.getsize(inp['path'])
    for r in rows:
        if 'size' in r:
            r['reductionPct'] = round((1 - r['size'] / orig_size) * 100, 2)
            r['ratio'] = round(orig_size / r['size'], 2) if r['size'] else None
    return {
        'original': {'name': inp['name'], 'size': orig_size, 'width': w, 'height': h, 'format': info['format'],
                     'megapixels': round(w * h / 1e6, 2), 'storedWidth': ow, 'storedHeight': oh},
        'rows': rows, 'workers': workers, 'caps': caps,
        'outputs': [os.path.join(out_dir, r['output']) for r in rows if 'size' in r],
    }


# ---------------------------------------------------------------------------------------------
# transform: convert / resize / crop / rotate / watermark
# ---------------------------------------------------------------------------------------------

FONT_CANDIDATES = [
    'C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeuib.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/liberation/LiberationSans-Bold.ttf', '/usr/share/fonts/noto/NotoSans-Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
]


def load_font(size):
    size = max(6, int(size))
    env = os.environ.get('TOOLS_FONT')
    for path in ([env] if env else []) + FONT_CANDIDATES:
        if path and os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # very old Pillow
        return ImageFont.load_default()


def text_mark(text, font, color, outline):
    stroke = max(1, round(font.size / 18)) if outline else 0
    l, t, r, b = font.getbbox(text, stroke_width=stroke)
    w, h = max(1, r - l), max(1, b - t)
    layer = Image.new('RGBA', (w + 2, h + 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    lum = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]
    stroke_fill = (0, 0, 0, 160) if lum > 128 else (255, 255, 255, 160)
    d.text((1 - l, 1 - t), text, font=font, fill=color, stroke_width=stroke, stroke_fill=stroke_fill)
    return layer


def apply_watermark(im, o, logo):
    W, H = im.size
    had_alpha = has_alpha(im)
    base = im.convert('RGBA')
    scale = max(1.0, min(100.0, float(o.get('scale', 25)))) / 100.0
    if o.get('mode') == 'logo':
        if logo is None:
            raise ValueError('Upload a logo image for logo watermarks')
        mark = logo.convert('RGBA')
        tw = max(1, int(W * scale))
        mark = mark.resize((tw, max(1, round(mark.height * tw / mark.width))), Image.Resampling.LANCZOS)
    else:
        text = str(o.get('text') or '© Watermark')[:200]
        color = parse_color(o.get('color', '#ffffff'))
        size = float(o.get('fontSize') or 0)
        if size <= 0:
            # Auto: make the text span `scale` of the image width.
            probe = load_font(100)
            l, _, r, _ = probe.getbbox(text)
            size = 100 * (W * scale) / max(1, r - l)
        mark = text_mark(text, load_font(min(size, 2000)), color, bool(o.get('outline', True)))
    angle = float(o.get('angle', 0) or 0)
    if angle:
        mark = mark.rotate(-angle, expand=True, resample=Image.Resampling.BICUBIC)  # clockwise, like CSS
    opacity = max(0.0, min(100.0, float(o.get('opacity', 50)))) / 100.0
    if opacity < 1:
        a = mark.getchannel('A').point(lambda v: int(v * opacity))
        mark.putalpha(a)
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    margin = int(min(W, H) * max(0.0, float(o.get('margin', 3))) / 100.0)
    pos = o.get('position', 'br')
    mw, mh = mark.size
    if pos == 'tiled':
        gap = max(0.2, float(o.get('gap', 60)) / 100.0)
        sx, sy = int(mw * (1 + gap)), int(mh * (1 + gap * 2))
        row = 0
        for y in range(-mh // 2, H + mh, max(1, sy)):
            off = (sx // 2) if row % 2 else 0
            for x in range(-mw // 2 - off, W + mw, max(1, sx)):
                layer.paste(mark, (x, y), mark)
            row += 1
    else:
        col = {'l': 0, 'c': 1, 'r': 2}
        vy = pos[0] if pos in ('tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br') else 'b'
        hx = pos[-1] if len(pos) == 2 else 'c'
        if pos == 'c':
            vy, hx = 'm', 'c'
        x = [margin, (W - mw) // 2, W - mw - margin][col.get(hx, 2)]
        y = {'t': margin, 'm': (H - mh) // 2, 'b': H - mh - margin}.get(vy, H - mh - margin)
        layer.paste(mark, (x, y), mark)
    out = Image.alpha_composite(base, layer)
    return out if had_alpha else out.convert('RGB')


def resize_op(im, o):
    W, H = im.size
    mode = o.get('mode', 'maxside')
    resample = RESAMPLE.get(o.get('resample', 'lanczos'), Image.Resampling.LANCZOS)
    no_up = bool(o.get('noUpscale', True))
    if mode == 'percent':
        p = max(0.1, min(1000.0, float(o.get('percent', 50)))) / 100.0
        if no_up and p > 1:
            p = 1
        return im.resize((max(1, round(W * p)), max(1, round(H * p))), resample)
    if mode == 'maxside':
        m = int(o.get('maxSide', 1200))
        if m <= 0:
            return im
        if no_up and max(W, H) <= m:
            return im
        s = m / max(W, H)
        return im.resize((max(1, round(W * s)), max(1, round(H * s))), resample)
    # exact box with a fit mode (same semantics as sharp / CSS object-fit)
    tw = int(o.get('width') or 0)
    th = int(o.get('height') or 0)
    if tw <= 0 and th <= 0:
        return im
    if tw <= 0:
        tw = max(1, round(W * th / H))
    if th <= 0:
        th = max(1, round(H * tw / W))
    fit = o.get('fit', 'contain')
    if fit == 'fill':
        if no_up and (tw > W or th > H):
            tw, th = min(tw, W), min(th, H)
        return im.resize((tw, th), resample)
    if fit == 'cover':
        s = max(tw / W, th / H)
        if no_up and s > 1:
            # Crop the box out of the original instead of enlarging.
            s = 1
            tw, th = min(tw, W), min(th, H)
        nw, nh = max(tw, round(W * s)), max(th, round(H * s))
        r = im.resize((nw, nh), resample)
        gx, gy = {'center': (0.5, 0.5), 'top': (0.5, 0), 'bottom': (0.5, 1), 'left': (0, 0.5), 'right': (1, 0.5)}.get(o.get('gravity', 'center'), (0.5, 0.5))
        x, y = int((nw - tw) * gx), int((nh - th) * gy)
        return r.crop((x, y, x + tw, y + th))
    s = min(tw / W, th / H)
    if no_up:
        s = min(s, 1)
    nw, nh = max(1, round(W * s)), max(1, round(H * s))
    r = im.resize((nw, nh), resample) if (nw, nh) != (W, H) else im
    if fit == 'inside':
        return r
    # contain: letterbox onto the exact box
    bg = parse_color(o.get('background', 'transparent'))
    canvas = Image.new('RGBA', (tw, th), bg)
    rr = r.convert('RGBA')
    canvas.alpha_composite(rr, ((tw - nw) // 2, (th - nh) // 2))
    return canvas if bg[3] < 255 or has_alpha(r) else canvas.convert('RGB')


def crop_op(im, o):
    W, H = im.size
    x = max(0, min(W - 1, int(round(float(o.get('x', 0))))))
    y = max(0, min(H - 1, int(round(float(o.get('y', 0))))))
    w = int(round(float(o.get('width', W))))
    h = int(round(float(o.get('height', H))))
    w = max(1, min(W - x, w))
    h = max(1, min(H - y, h))
    return im.crop((x, y, x + w, y + h))


def rotate_op(im, o):
    if o.get('flipH'):
        im = ImageOps.mirror(im)
    if o.get('flipV'):
        im = ImageOps.flip(im)
    angle = float(o.get('angle', 0) or 0) % 360
    if angle == 0:
        return im
    # Exact quarter turns are lossless transposes (clockwise angles, like CSS rotate()).
    quarter = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}
    if angle in quarter:
        return im.transpose(quarter[angle])
    fill = parse_color(o.get('fill', 'transparent'))
    src = im.convert('RGBA') if (fill[3] < 255 or has_alpha(im)) else im.convert('RGB')
    out = src.rotate(-angle, resample=Image.Resampling.BICUBIC, expand=bool(o.get('expand', True)),
                     fillcolor=fill if src.mode == 'RGBA' else fill[:3])
    return out


def transform_one(task):
    o = task['options']
    op = task['op']
    src = task['input']
    t0 = time.time()
    res = {'file': task['name'], 'origSize': os.path.getsize(src)}
    try:
        logo = None
        if op == 'watermark' and task.get('logo'):
            logo, _ = load_image(task['logo'])
        im, info = load_image(src)
        res['origWidth'], res['origHeight'] = im.size
        fmt_opt = o.get('format', 'keep')
        animated = info['animated'] and op == 'convert' and fmt_opt in ('gif', 'webp') and o.get('keepAnimation', True)

        if op == 'resize':
            im = resize_op(im, o)
        elif op == 'crop':
            im = crop_op(im, o)
        elif op == 'rotate':
            im = rotate_op(im, o)
        elif op == 'watermark':
            im = apply_watermark(im, o, logo)

        alpha = alpha_is_used(im)
        fmt = target_format(info['format'], fmt_opt, alpha)
        if fmt == 'heic' and not HAS_HEIF:
            fmt = 'png' if alpha else 'jpg'
        out_path = os.path.join(task['outDir'], task['outFile'].rsplit('.', 1)[0] + '.' + EXT_FOR[fmt])
        q = int(o.get('quality', 85))
        if animated:
            frames, durations = [], []
            with Image.open(src) as anim:
                for fr in ImageSequence.Iterator(anim):
                    frames.append(fr.convert('RGBA'))
                    durations.append(fr.info.get('duration', 100))
            kw = {'save_all': True, 'append_images': frames[1:], 'duration': durations, 'loop': 0}
            if fmt == 'webp':
                frames[0].save(out_path, 'WEBP', quality=q, method=4, **kw)
            else:
                frames[0].save(out_path, 'GIF', optimize=True, disposal=2, **kw)
            res['frames'] = len(frames)
        else:
            encode(im, fmt, out_path, q, bg=parse_color(o.get('background', '#ffffff')), icc=info['icc'],
                   method=int(o.get('webpMethod', 4)), progressive=o.get('progressive', True),
                   lossless=bool(o.get('lossless')), colors=int(o.get('colors') or 0))
        res.update({'output': os.path.basename(out_path), 'outputPath': out_path, 'format': fmt,
                    'newSize': os.path.getsize(out_path), 'width': im.size[0], 'height': im.size[1],
                    'ms': int((time.time() - t0) * 1000)})
        if alpha and fmt in ('jpg', 'bmp'):
            res['note'] = f'Transparency flattened onto {o.get("background", "#ffffff")}'
    except Exception as e:
        res['error'] = f'{type(e).__name__}: {e}'
    return res


SUFFIX = {'convert': '', 'resize': '-resized', 'crop': '-cropped', 'rotate': '-rotated', 'watermark': '-watermarked'}


def cmd_transform(spec):
    op = spec['op']
    o = spec.get('options', {})
    out_dir = spec['outDir']
    os.makedirs(out_dir, exist_ok=True)
    logo = spec.get('logo')
    used = set()
    tasks = []
    for inp in spec['inputs']:
        stem = os.path.splitext(inp['name'])[0] + SUFFIX.get(op, '')
        fmt = o.get('format', 'keep')
        ext = EXT_FOR.get(fmt) if fmt != 'keep' else ext_kind(inp['path'])
        # Reserve the stem for this file (the worker may switch the extension).
        out_file = unique_name(f'{stem}.{ext}', used)
        tasks.append({'op': op, 'input': inp['path'], 'name': inp['name'], 'outDir': out_dir, 'outFile': out_file,
                      'options': o, 'logo': logo})
    workers = worker_count(o.get('workers'), len(tasks))
    results = list(run_parallel(transform_one, tasks, workers, 'Processed'))
    order = {t['name']: i for i, t in enumerate(tasks)}
    results.sort(key=lambda r: order.get(r.get('file'), 0))
    return {'files': results, 'workers': workers}


# ---------------------------------------------------------------------------------------------
# caps
# ---------------------------------------------------------------------------------------------

def cmd_caps(_spec):
    import PIL
    read = {'jpg': True, 'png': True, 'webp': features.check('webp'), 'avif': features.check('avif') or 'AVIF' in Image.OPEN,
            'heic': HAS_HEIF, 'gif': True, 'bmp': True, 'tiff': True, 'ico': True}
    return {'pillow': PIL.__version__, 'pillowHeif': getattr(sys.modules.get('pillow_heif'), '__version__', None),
            'numpy': np.__version__, 'python': sys.version.split()[0], 'cpus': os.cpu_count(),
            'encode': encode_caps(), 'decode': read, 'freetype': features.check('freetype2')}


COMMANDS = {'caps': cmd_caps, 'compress': cmd_compress, 'batch': cmd_batch, 'benchmark': cmd_benchmark,
            'transform': cmd_transform}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(f'usage: image_tools.py <{"|".join(COMMANDS)}> [spec.json]', file=sys.stderr)
        sys.exit(2)
    spec = {}
    if len(sys.argv) > 2:
        with open(sys.argv[2], 'r', encoding='utf-8') as f:
            spec = json.load(f)
    try:
        result = COMMANDS[sys.argv[1]](spec)
    except Exception as e:
        print(f'{type(e).__name__}: {e}' if not isinstance(e, ValueError) else str(e), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, allow_nan=False, default=str), flush=True)


if __name__ == '__main__':
    main()
