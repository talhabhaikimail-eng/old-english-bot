"""
doc_tools.py - PDF / image helper CLI for the Dev Tools "Files & Documents" converters.

Usage:  python doc_tools.py <command> <config.json>

The config is {"inputs": [{"path": ..., "filename": ...}], "outdir": ..., "options": {...}}.
Progress is reported as JSON lines {"progress": n, "message": "..."}; the final stdout line is
{"outputs": [{"path": ..., "filename": ...}], "meta": {...}}. User-facing errors go to stderr
as a single line and exit with status 2.

Commands: merge, split, compress, to-image, text, images-to-pdf, info, exif-strip
Requires PyMuPDF (pymupdf / fitz) for PDF commands and Pillow (+ pillow-heif for HEIC).
"""

import io
import json
import os
import re
import shutil
import struct
import sys
import zlib

try:
    import pymupdf as fitz  # PyMuPDF >= 1.24.3
except ImportError:  # pragma: no cover - older PyMuPDF
    try:
        import fitz  # type: ignore
    except ImportError:
        fitz = None


class UserError(Exception):
    pass


def progress(pct, message=None):
    d = {"progress": round(max(0, min(100, pct)), 1)}
    if message:
        d["message"] = message
    print(json.dumps(d), flush=True)


def need_fitz():
    if fitz is None:
        raise UserError("PyMuPDF is not installed on the server (pip install pymupdf)")


def stem(filename):
    base = os.path.basename(filename)
    s, _ = os.path.splitext(base)
    return s or "output"


def out_path(outdir, filename):
    return os.path.join(outdir, filename)


def open_pdf(path, filename, password=""):
    need_fitz()
    try:
        doc = fitz.open(path)
    except Exception as e:  # noqa: BLE001
        raise UserError(f"{filename}: not a readable PDF ({e})")
    if not doc.is_pdf:
        raise UserError(f"{filename}: not a PDF file")
    if doc.needs_pass:
        if not password:
            raise UserError(f"{filename} is password-protected - enter its password")
        if not doc.authenticate(password):
            raise UserError(f"{filename}: wrong password")
    if doc.page_count == 0:
        raise UserError(f"{filename} has no pages")
    return doc


def parse_ranges(spec, page_count):
    """'1-3,5,8-' -> [(1,3),(5,5),(8,N)] (1-based, inclusive). Raises UserError on bad input."""
    spec = (spec or "").strip()
    if not spec or spec.lower() == "all":
        return [(1, page_count)]
    out = []
    for raw in re.split(r"[,;\s]+", spec):
        part = raw.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d*)\s*-\s*(\d*)", part)
        if m:
            a = int(m.group(1)) if m.group(1) else 1
            b = int(m.group(2)) if m.group(2) else page_count
        elif part.isdigit():
            a = b = int(part)
        elif part.lower() == "last":
            a = b = page_count
        else:
            raise UserError(f'Invalid page range "{part}" - use forms like 1-3, 5, 8-')
        if a < 1 or b < 1:
            raise UserError(f'Page numbers start at 1 ("{part}")')
        if a > b:
            raise UserError(f'Range "{part}" is backwards')
        if a > page_count:
            raise UserError(f'Range "{part}" starts after the last page ({page_count})')
        out.append((a, min(b, page_count)))
    if not out:
        raise UserError("No pages selected")
    return out


def pages_from_ranges(spec, page_count):
    pages = []
    seen = set()
    for a, b in parse_ranges(spec, page_count):
        for p in range(a, b + 1):
            if p not in seen:
                seen.add(p)
                pages.append(p)
    return pages


def save_pdf(doc, path, **extra):
    kwargs = dict(garbage=4, deflate=True, deflate_images=True, deflate_fonts=True)
    kwargs.update(extra)
    try:
        doc.save(path, use_objstms=1, **kwargs)
    except TypeError:  # older PyMuPDF without object streams
        doc.save(path, **kwargs)


# --------------------------------------------------------------------------- merge

def cmd_merge(cfg):
    need_fitz()
    opts = cfg["options"]
    inputs = cfg["inputs"]
    password = opts.get("password") or ""
    out = fitz.open()
    toc = []
    total = 0
    for i, inp in enumerate(inputs):
        progress(5 + 85 * i / len(inputs), f"Adding {inp['filename']}")
        src = open_pdf(inp["path"], inp["filename"], password)
        start = out.page_count
        out.insert_pdf(src)
        if opts.get("bookmarks", True):
            toc.append([1, stem(inp["filename"]), start + 1])
            for lvl, title, page, *_ in src.get_toc(simple=True):
                if page >= 1:
                    toc.append([lvl + 1, title, start + page])
        total += src.page_count
        src.close()
    if toc:
        try:
            out.set_toc(toc)
        except Exception:  # noqa: BLE001 - malformed nested TOC: keep top level only
            out.set_toc([t for t in toc if t[0] == 1])
    progress(92, "Saving")
    name = (opts.get("outputName") or "").strip() or "merged"
    name = re.sub(r'[\\/:*?"<>|]+', "_", name)
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    path = out_path(cfg["outdir"], name)
    save_pdf(out, path)
    return {"outputs": [{"path": path, "filename": name}], "meta": {"pages": total, "files": len(inputs)}}


# --------------------------------------------------------------------------- split

def cmd_split(cfg):
    opts = cfg["options"]
    inp = cfg["inputs"][0]
    doc = open_pdf(inp["path"], inp["filename"], opts.get("password") or "")
    n = doc.page_count
    mode = opts.get("mode", "ranges")
    if mode == "ranges":
        groups = parse_ranges(opts.get("ranges") or "", n)
    elif mode == "every":
        k = max(1, int(opts.get("every") or 1))
        groups = [(a, min(a + k - 1, n)) for a in range(1, n + 1, k)]
    elif mode == "each":
        groups = [(p, p) for p in range(1, n + 1)]
    else:
        raise UserError(f"Unknown split mode {mode}")
    if len(groups) > 1000:
        raise UserError(f"That would create {len(groups)} files - the limit is 1000")
    if mode == "ranges" and opts.get("single"):
        # Extract the selected pages into one document instead of one file per range.
        groups = [groups]
    outputs = []
    s = stem(inp["filename"])
    width = len(str(n))
    for i, g in enumerate(groups):
        progress(5 + 90 * i / len(groups), f"Writing part {i + 1} of {len(groups)}")
        part = fitz.open()
        rngs = g if isinstance(g, list) else [g]
        for a, b in rngs:
            part.insert_pdf(doc, from_page=a - 1, to_page=b - 1)
        if isinstance(g, list):
            label = "selected"
        else:
            a, b = g
            label = f"p{str(a).zfill(width)}" if a == b else f"p{str(a).zfill(width)}-{str(b).zfill(width)}"
        name = f"{s}_{label}.pdf"
        path = out_path(cfg["outdir"], name)
        save_pdf(part, path)
        outputs.append({"path": path, "filename": name, "pages": part.page_count})
        part.close()
    return {
        "outputs": [{"path": o["path"], "filename": o["filename"]} for o in outputs],
        "meta": {"sourcePages": n, "parts": [{"file": o["filename"], "pages": o["pages"]} for o in outputs]},
    }


# --------------------------------------------------------------------------- compress

PRESETS = {
    "screen": (72, 45),
    "ebook": (150, 65),
    "printer": (300, 85),
    "lossless": (None, None),
}


def _pil():
    try:
        from PIL import Image  # noqa: F401
        return Image
    except ImportError:
        raise UserError("Pillow is not installed on the server (pip install pillow)")


def compress_images(doc, target_dpi, quality):
    Image = _pil()
    usage = {}  # xref -> (min effective dpi, page number)
    for page in doc:
        try:
            infos = page.get_image_info(xrefs=True)
        except Exception:  # noqa: BLE001
            continue
        for info in infos:
            xref = info.get("xref") or 0
            if xref <= 0:
                continue
            bbox = fitz.Rect(info["bbox"])
            if bbox.is_empty or bbox.width < 1 or bbox.height < 1:
                continue
            w, h = info["width"], info["height"]
            dpi = min(w * 72.0 / bbox.width, h * 72.0 / bbox.height)
            prev = usage.get(xref)
            if prev is None or dpi < prev[0]:
                usage[xref] = (dpi, page.number)
    stats = {"images": len(usage), "recompressed": 0, "downsampled": 0, "savedBytes": 0}
    done = set()
    for idx, (xref, (dpi, pno)) in enumerate(usage.items()):
        if idx % 5 == 0:
            progress(10 + 70 * idx / max(1, len(usage)), f"Image {idx + 1} of {len(usage)}")
        if xref in done:
            continue
        done.add(xref)
        try:
            meta = doc.extract_image(xref)
        except Exception:  # noqa: BLE001
            continue
        if not meta or meta.get("smask"):
            continue  # transparency masks: leave untouched
        if meta.get("bpc", 8) < 8 and meta.get("colorspace", 3) == 1:
            continue  # 1-bit scans compress far better as-is
        try:
            orig_len = len(doc.xref_stream_raw(xref) or b"")
        except Exception:  # noqa: BLE001
            continue
        if orig_len < 4096:
            continue
        try:
            pix = fitz.Pixmap(doc, xref)
        except Exception:  # noqa: BLE001
            continue
        if pix.alpha:
            continue
        if pix.n - pix.alpha >= 4 or (pix.colorspace and pix.colorspace.n not in (1, 3)):
            pix = fitz.Pixmap(fitz.csRGB, pix)
        mode = "L" if pix.n == 1 else "RGB"
        if pix.n not in (1, 3):
            continue
        img = Image.frombytes(mode, (pix.width, pix.height), pix.samples)
        scaled = False
        if dpi > target_dpi * 1.15:
            f = target_dpi / dpi
            nw, nh = max(1, round(pix.width * f)), max(1, round(pix.height * f))
            img = img.resize((nw, nh), Image.LANCZOS)
            scaled = True
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
        data = buf.getvalue()
        if len(data) < orig_len * 0.9:
            try:
                doc[pno].replace_image(xref, stream=data)
            except Exception:  # noqa: BLE001
                continue
            stats["recompressed"] += 1
            stats["downsampled"] += 1 if scaled else 0
            stats["savedBytes"] += orig_len - len(data)
    return stats


def strip_metadata(doc):
    try:
        doc.set_metadata({})
    except Exception:  # noqa: BLE001
        pass
    try:
        doc.del_xml_metadata()
    except Exception:  # noqa: BLE001
        pass
    for page in doc:
        try:
            if doc.xref_get_key(page.xref, "Thumb")[0] != "null":
                doc.xref_set_key(page.xref, "Thumb", "null")
        except Exception:  # noqa: BLE001
            pass


def cmd_compress(cfg):
    opts = cfg["options"]
    preset = opts.get("preset", "ebook")
    if preset not in PRESETS:
        raise UserError(f"Unknown preset {preset}")
    target, quality = PRESETS[preset]
    if opts.get("quality"):
        quality = int(opts["quality"]) if preset != "lossless" else None
    outputs, files = [], []
    for i, inp in enumerate(cfg["inputs"]):
        base = 100 * i / len(cfg["inputs"])
        progress(base + 2, f"Opening {inp['filename']}")
        doc = open_pdf(inp["path"], inp["filename"], opts.get("password") or "")
        before = os.path.getsize(inp["path"])
        stats = {"images": 0, "recompressed": 0, "downsampled": 0, "savedBytes": 0}
        if target:
            stats = compress_images(doc, target, quality)
        if opts.get("stripMetadata", True):
            strip_metadata(doc)
        progress(base + 85 / len(cfg["inputs"]), f"Rebuilding {inp['filename']}")
        name = inp["filename"] if inp["filename"].lower().endswith(".pdf") else stem(inp["filename"]) + ".pdf"
        path = out_path(cfg["outdir"], name)
        save_pdf(doc, path, clean=True)
        doc.close()
        after = os.path.getsize(path)
        kept = False
        if after >= before:
            shutil.copyfile(inp["path"], path)
            after, kept = before, True
        outputs.append({"path": path, "filename": name})
        files.append({"file": name, "before": before, "after": after, "keptOriginal": kept, **stats})
    tb = sum(f["before"] for f in files)
    ta = sum(f["after"] for f in files)
    return {"outputs": outputs, "meta": {"preset": preset, "before": tb, "after": ta,
                                         "savedPct": round(100 * (1 - ta / tb), 1) if tb else 0, "files": files}}


# --------------------------------------------------------------------------- to-image

def cmd_to_image(cfg):
    opts = cfg["options"]
    fmt = opts.get("format", "png")
    dpi = max(36, min(600, int(opts.get("dpi") or 150)))
    quality = max(1, min(100, int(opts.get("quality") or 90)))
    outputs = []
    pages_total = 0
    jobs = []
    for inp in cfg["inputs"]:
        doc = open_pdf(inp["path"], inp["filename"], opts.get("password") or "")
        pages = pages_from_ranges(opts.get("pages") or "", doc.page_count)
        jobs.append((inp, doc, pages))
        pages_total += len(pages)
    if pages_total > 2000:
        raise UserError(f"{pages_total} pages selected - render at most 2000 per job")
    done = 0
    ext = "jpg" if fmt == "jpg" else fmt
    for inp, doc, pages in jobs:
        s = stem(inp["filename"])
        width = len(str(doc.page_count))
        for p in pages:
            progress(2 + 96 * done / pages_total, f"Rendering {inp['filename']} page {p}")
            page = doc[p - 1]
            # Keep a single page under ~100 MP so a huge page size can't exhaust memory.
            area_in = (page.rect.width / 72) * (page.rect.height / 72)
            eff = dpi
            if area_in * dpi * dpi > 100e6:
                eff = int((100e6 / area_in) ** 0.5)
            pix = page.get_pixmap(dpi=eff, alpha=(fmt == "png" and bool(opts.get("transparent"))))
            name = f"{s}_p{str(p).zfill(width)}.{ext}"
            path = out_path(cfg["outdir"], name)
            if fmt == "png":
                pix.save(path)
            else:
                Image = _pil()
                img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                if fmt == "jpg":
                    img.save(path, format="JPEG", quality=quality, optimize=True, progressive=True, dpi=(eff, eff))
                else:
                    img.save(path, format="WEBP", quality=quality, method=4)
            outputs.append({"path": path, "filename": name})
            done += 1
        doc.close()
    return {"outputs": outputs, "meta": {"images": len(outputs), "dpi": dpi, "format": fmt}}


# --------------------------------------------------------------------------- text

def layout_text(page):
    words = page.get_text("words", sort=True)
    if not words:
        return ""
    widths = sorted((w[2] - w[0]) / max(1, len(w[4])) for w in words if w[4])
    cw = widths[len(widths) // 2] if widths else 5.0
    cw = max(cw, 1.0)
    heights = sorted(w[3] - w[1] for w in words)
    lh = max(heights[len(heights) // 2], 1.0)
    # Group words into visual lines by vertical centre.
    lines = []
    for w in sorted(words, key=lambda w: ((w[1] + w[3]) / 2, w[0])):
        cy = (w[1] + w[3]) / 2
        if lines and abs(lines[-1]["cy"] - cy) < lh * 0.5:
            lines[-1]["words"].append(w)
        else:
            lines.append({"cy": cy, "words": [w]})
    x0 = min(w[0] for w in words)
    out = []
    prev_cy = None
    for ln in lines:
        if prev_cy is not None and ln["cy"] - prev_cy > lh * 1.8:
            out.append("")
        prev_cy = ln["cy"]
        s = ""
        for w in sorted(ln["words"], key=lambda w: w[0]):
            col = int(round((w[0] - x0) / cw))
            if s and col <= len(s):
                col = len(s) + 1
            s = s.ljust(col) + w[4]
        out.append(s.rstrip())
    return "\n".join(out)


def cmd_text(cfg):
    opts = cfg["options"]
    mode = opts.get("mode", "plain")
    sep = opts.get("separators", True)
    outputs, files = [], []
    n_in = len(cfg["inputs"])
    for i, inp in enumerate(cfg["inputs"]):
        doc = open_pdf(inp["path"], inp["filename"], opts.get("password") or "")
        pages = pages_from_ranges(opts.get("pages") or "", doc.page_count)
        parts = []
        empty = 0
        for j, p in enumerate(pages):
            if j % 10 == 0:
                progress(100 * (i + j / len(pages)) / n_in, f"{inp['filename']}: page {p}")
            page = doc[p - 1]
            t = layout_text(page) if mode == "layout" else page.get_text("text", sort=True)
            t = t.replace("\r\n", "\n").rstrip()
            if not t.strip():
                empty += 1
            parts.append(f"===== Page {p} =====\n{t}" if sep else t)
        text = ("\n\n" if sep else "\n\f\n").join(parts).strip() + "\n"
        if not sep:
            text = text.replace("\n\f\n", "\n\n")
        name = stem(inp["filename"]) + ".txt"
        path = out_path(cfg["outdir"], name)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        outputs.append({"path": path, "filename": name})
        files.append({"file": name, "pages": doc.page_count, "extractedPages": len(pages),
                      "chars": len(text.strip()), "emptyPages": empty})
        doc.close()
    scanned = [f["file"] for f in files if f["extractedPages"] and f["emptyPages"] == f["extractedPages"]]
    return {"outputs": outputs, "meta": {"files": files, "pages": sum(f["pages"] for f in files),
                                         "chars": sum(f["chars"] for f in files),
                                         "noTextLayer": scanned}}


# --------------------------------------------------------------------------- images-to-pdf

PAGE_SIZES = {"a4": (595.28, 841.89), "letter": (612.0, 792.0), "legal": (612.0, 1008.0), "a3": (841.89, 1190.55),
              "a5": (419.53, 595.28)}


def open_image(path, filename):
    Image = _pil()
    try:
        import pillow_heif  # noqa: F401
        pillow_heif.register_heif_opener()
    except ImportError:
        if filename.lower().endswith((".heic", ".heif")):
            raise UserError("HEIC support needs pillow-heif on the server (pip install pillow-heif)")
    try:
        img = Image.open(path)
        img.load()
    except Exception as e:  # noqa: BLE001
        raise UserError(f"{filename}: not a readable image ({e})")
    return img


def iter_frames(img, filename):
    """All pages of a multi-page TIFF, otherwise just the first frame."""
    if getattr(img, "format", "") == "TIFF" and getattr(img, "n_frames", 1) > 1:
        for k in range(img.n_frames):
            img.seek(k)
            yield img.copy()
    else:
        yield img


def cmd_images_to_pdf(cfg):
    need_fitz()
    Image = _pil()
    from PIL import ImageOps
    opts = cfg["options"]
    size = opts.get("pageSize", "a4")
    orient = opts.get("orientation", "auto")
    margin = max(0.0, float(opts.get("margin") or 0)) * 72 / 25.4
    fit = opts.get("fit", "fit")
    quality = int(opts.get("quality") or 90)
    doc = fitz.open()
    n = len(cfg["inputs"])
    for i, inp in enumerate(cfg["inputs"]):
        progress(2 + 90 * i / n, f"Adding {inp['filename']}")
        src = open_image(inp["path"], inp["filename"])
        for frame in iter_frames(src, inp["filename"]):
            orientation = 1
            try:
                orientation = frame.getexif().get(0x0112, 1)
            except Exception:  # noqa: BLE001
                pass
            img = ImageOps.exif_transpose(frame) if orientation not in (1, None) else frame
            w, h = img.size
            if size == "fit":
                dpi = 96.0
                try:
                    d = img.info.get("dpi")
                    if d and d[0] and float(d[0]) >= 50:
                        dpi = float(d[0])
                except Exception:  # noqa: BLE001
                    pass
                pw, ph = w * 72 / dpi + 2 * margin, h * 72 / dpi + 2 * margin
            else:
                pw, ph = PAGE_SIZES.get(size, PAGE_SIZES["a4"])
                landscape = orient == "landscape" or (orient == "auto" and w > h)
                if landscape:
                    pw, ph = max(pw, ph), min(pw, ph)
                else:
                    pw, ph = min(pw, ph), max(pw, ph)
            box = fitz.Rect(margin, margin, pw - margin, ph - margin)
            if box.width < 10 or box.height < 10:
                raise UserError("Margin is too large for the page size")
            if fit == "fill" and size != "fit":
                # Cover the box: crop the image to the box aspect ratio.
                ar = box.width / box.height
                if w / h > ar:
                    nw = int(round(h * ar))
                    img = img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
                else:
                    nh = int(round(w / ar))
                    img = img.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
                w, h = img.size
                rect = box
            elif fit == "stretch" and size != "fit":
                rect = box
            else:
                sc = min(box.width / w, box.height / h)
                rw, rh = w * sc, h * sc
                rect = fitz.Rect(box.x0 + (box.width - rw) / 2, box.y0 + (box.height - rh) / 2,
                                 box.x0 + (box.width - rw) / 2 + rw, box.y0 + (box.height - rh) / 2 + rh)
            # Encode: pass JPEGs through untouched when possible, keep lossless sources lossless.
            fmt = (src.format or "").upper()
            untouched = img is frame and frame is src and fmt == "JPEG" and src.mode in ("RGB", "L", "CMYK")
            if untouched:
                with open(inp["path"], "rb") as f:
                    data = f.read()
            else:
                buf = io.BytesIO()
                has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
                if fmt in ("PNG", "GIF", "BMP", "TIFF") or has_alpha:
                    if img.mode not in ("RGB", "RGBA", "L", "LA"):
                        img = img.convert("RGBA" if has_alpha else "RGB")
                    img.save(buf, format="PNG", optimize=False)
                else:
                    if img.mode not in ("RGB", "L"):
                        img = img.convert("RGB")
                    img.save(buf, format="JPEG", quality=quality, optimize=True)
                data = buf.getvalue()
            page = doc.new_page(width=pw, height=ph)
            page.insert_image(rect, stream=data, keep_proportion=False)
    progress(95, "Saving PDF")
    name = (opts.get("outputName") or "").strip() or (stem(cfg["inputs"][0]["filename"]) if n == 1 else "images")
    name = re.sub(r'[\\/:*?"<>|]+', "_", name)
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    path = out_path(cfg["outdir"], name)
    save_pdf(doc, path, deflate_images=False)
    return {"outputs": [{"path": path, "filename": name}], "meta": {"pages": doc.page_count, "images": n}}


# --------------------------------------------------------------------------- info

def cmd_info(cfg):
    need_fitz()
    inp = cfg["inputs"][0]
    password = cfg["options"].get("password") or ""
    try:
        doc = fitz.open(inp["path"])
    except Exception as e:  # noqa: BLE001
        raise UserError(f"Not a readable PDF ({e})")
    info = {"encrypted": bool(doc.is_encrypted), "needsPassword": bool(doc.needs_pass), "unlocked": True}
    if doc.needs_pass:
        info["unlocked"] = bool(password) and bool(doc.authenticate(password))
        if not info["unlocked"]:
            info["pages"] = None
            return {"outputs": [], "meta": info}
    info["pages"] = doc.page_count
    md = doc.metadata or {}
    info["metadata"] = {k: v for k, v in md.items() if v}
    info["version"] = md.get("format") or ""
    if doc.page_count:
        r = doc[0].rect
        info["pageSize"] = {"widthPt": round(r.width, 1), "heightPt": round(r.height, 1),
                            "widthMm": round(r.width * 25.4 / 72, 1), "heightMm": round(r.height * 25.4 / 72, 1)}
        sample = min(doc.page_count, 3)
        info["hasText"] = any(doc[k].get_text("text").strip() for k in range(sample))
    try:
        info["bookmarks"] = len(doc.get_toc())
    except Exception:  # noqa: BLE001
        info["bookmarks"] = 0
    info["formFields"] = bool(doc.is_form_pdf)
    info["fileSize"] = os.path.getsize(inp["path"])
    return {"outputs": [], "meta": info}


# --------------------------------------------------------------------------- exif-strip

def _exif_summary(path):
    """Camera / GPS / date details for the report (best effort)."""
    try:
        img = open_image(path, os.path.basename(path))
        ex = img.getexif()
    except Exception:  # noqa: BLE001
        return {}
    out = {}
    if not ex:
        return out
    make, model = ex.get(0x010F), ex.get(0x0110)
    if make or model:
        out["camera"] = " ".join(str(x).strip("\x00 ") for x in (make, model) if x)
    try:
        sub = ex.get_ifd(0x8769)
        dt = sub.get(0x9003) or ex.get(0x0132)
    except Exception:  # noqa: BLE001
        dt = ex.get(0x0132)
    if dt:
        out["dateTaken"] = str(dt).strip("\x00 ")
    try:
        gps = ex.get_ifd(0x8825)
        if gps and (2 in gps or 4 in gps):
            out["gps"] = True
    except Exception:  # noqa: BLE001
        pass
    sw = ex.get(0x0131)
    if sw:
        out["software"] = str(sw).strip("\x00 ")
    out["orientation"] = ex.get(0x0112, 1)
    return out


def _orientation_app1(orientation):
    tiff = b"MM\x00\x2a\x00\x00\x00\x08" + struct.pack(">H", 1) + struct.pack(">HHIHH", 0x0112, 3, 1, orientation, 0) \
        + b"\x00\x00\x00\x00"
    payload = b"Exif\x00\x00" + tiff
    return b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload


def strip_jpeg(data, keep_icc=True, orientation=1):
    if data[:2] != b"\xff\xd8":
        raise UserError("Not a valid JPEG")
    pos = 2
    head = [b"\xff\xd8"]
    removed = []
    kept = []
    n = len(data)
    inserted_orientation = False

    def add_orientation():
        nonlocal inserted_orientation
        if orientation not in (None, 1) and not inserted_orientation:
            head.append(_orientation_app1(orientation))
            inserted_orientation = True

    while pos < n:
        if data[pos] != 0xFF:
            raise UserError("Corrupt JPEG (marker expected)")
        while pos < n and data[pos] == 0xFF and pos + 1 < n and data[pos + 1] == 0xFF:
            pos += 1  # fill bytes
        if pos + 1 >= n:
            break
        m = data[pos + 1]
        if m == 0xD8 or 0xD0 <= m <= 0xD7 or m == 0x01:
            pos += 2
            continue
        if m == 0xD9:
            head.append(b"\xff\xd9")
            pos += 2
            break
        if pos + 4 > n:
            raise UserError("Truncated JPEG")
        length = struct.unpack(">H", data[pos + 2:pos + 4])[0]
        seg = data[pos:pos + 2 + length]
        body = seg[4:]
        if m == 0xDA:
            # Start of scan: copy entropy-coded data up to the next real marker.
            add_orientation()
            q = pos + 2 + length
            while q < n - 1:
                if data[q] == 0xFF and data[q + 1] != 0x00 and not (0xD0 <= data[q + 1] <= 0xD7) and data[q + 1] != 0xFF:
                    break
                q += 1
            head.append(data[pos:q])
            pos = q
            continue
        if 0xE0 <= m <= 0xEF or m == 0xFE:
            label = None
            keep = False
            if m == 0xE0 and body.startswith(b"JFIF\x00"):
                keep = True
                label = "JFIF header"
            elif m == 0xE0 and body.startswith(b"JFXX"):
                label = "JFIF thumbnail"
            elif m == 0xE1 and body.startswith(b"Exif\x00"):
                label = "EXIF"
            elif m == 0xE1 and body.startswith(b"http://ns.adobe.com/xap/1.0/"):
                label = "XMP"
            elif m == 0xE1 and body.startswith(b"http://ns.adobe.com/xmp/extension/"):
                label = "Extended XMP"
            elif m == 0xE2 and body.startswith(b"ICC_PROFILE"):
                keep = keep_icc
                label = "ICC colour profile"
            elif m == 0xE2 and body.startswith(b"MPF"):
                label = "MPF (multi-picture index)"
            elif m == 0xED:
                label = "IPTC / Photoshop"
            elif m == 0xEE and body.startswith(b"Adobe"):
                keep = True  # colour transform flag - required to decode CMYK/YCCK correctly
                label = "Adobe colour transform"
            elif m == 0xFE:
                label = "Comment"
            else:
                label = f"APP{m - 0xE0} segment"
            if keep:
                head.append(seg)
                if label not in kept:
                    kept.append(label)
            else:
                if label not in removed:
                    removed.append(label)
            pos += 2 + length
            continue
        # SOFn, DQT, DHT, DRI, DNL... keep. Put the orientation tag before the first of them.
        if m in (0xDB, 0xC4, 0xDD) or 0xC0 <= m <= 0xCF:
            add_orientation()
        head.append(seg)
        pos += 2 + length
    trailing = n - pos
    if trailing > 0 and data[pos:].strip(b"\x00"):
        removed.append(f"Trailing data after image ({trailing} bytes - embedded previews / motion photo)")
    return b"".join(head), removed, kept


PNG_SIG = b"\x89PNG\r\n\x1a\n"


def strip_png(data, keep_icc=True):
    if not data.startswith(PNG_SIG):
        raise UserError("Not a valid PNG")
    pos = 8
    out = [PNG_SIG]
    removed, kept = [], []
    names = {b"tEXt": "Text chunks", b"zTXt": "Compressed text chunks", b"iTXt": "International text (XMP)",
             b"eXIf": "EXIF", b"tIME": "Modification time"}
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos:pos + 12 + length]
        pos += 12 + length
        if ctype in names:
            if names[ctype] not in removed:
                removed.append(names[ctype])
            continue
        if ctype == b"iCCP":
            if not keep_icc:
                removed.append("ICC colour profile")
                continue
            kept.append("ICC colour profile")
        out.append(chunk)
        if ctype == b"IEND":
            break
    return b"".join(out), removed, kept


def strip_webp(data, keep_icc=True):
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise UserError("Not a valid WebP")
    pos = 12
    chunks = []
    removed, kept = [], []
    while pos + 8 <= len(data):
        ctype = data[pos:pos + 4]
        size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
        padded = size + (size & 1)
        chunk = data[pos:pos + 8 + padded]
        pos += 8 + padded
        if ctype == b"EXIF":
            removed.append("EXIF")
            continue
        if ctype == b"XMP ":
            removed.append("XMP")
            continue
        if ctype == b"ICCP":
            if not keep_icc:
                removed.append("ICC colour profile")
                continue
            kept.append("ICC colour profile")
        chunks.append(bytearray(chunk))
    for c in chunks:
        if bytes(c[:4]) == b"VP8X":
            flags = c[8]
            flags &= ~0x08  # EXIF
            flags &= ~0x04  # XMP
            if not keep_icc:
                flags &= ~0x20
            c[8] = flags
    body = b"WEBP" + b"".join(bytes(c) for c in chunks)
    return b"RIFF" + struct.pack("<I", len(body)) + body, removed, kept


def cmd_exif_strip(cfg):
    opts = cfg["options"]
    keep_icc = bool(opts.get("keepIcc", True))
    jpeg_mode = opts.get("jpegMode", "lossless")
    files, outputs = [], []
    n = len(cfg["inputs"])
    for i, inp in enumerate(cfg["inputs"]):
        progress(100 * i / n, f"Cleaning {inp['filename']}")
        with open(inp["path"], "rb") as f:
            data = f.read()
        summary = _exif_summary(inp["path"])
        orientation = summary.pop("orientation", 1) or 1
        lower = inp["filename"].lower()
        path = out_path(cfg["outdir"], inp["filename"])
        method = "lossless"
        notes = []
        if data[:2] == b"\xff\xd8":
            if jpeg_mode == "reencode" and orientation != 1:
                from PIL import ImageOps
                img = open_image(inp["path"], inp["filename"])
                icc = img.info.get("icc_profile") if keep_icc else None
                img = ImageOps.exif_transpose(img)
                if img.mode not in ("RGB", "L", "CMYK"):
                    img = img.convert("RGB")
                kwargs = {"quality": 95, "optimize": True}
                if icc:
                    kwargs["icc_profile"] = icc
                img.save(path, format="JPEG", **kwargs)
                _, removed, kept = strip_jpeg(data, keep_icc, 1)
                method = "re-encoded (rotation applied)"
                notes.append("Rotated pixels to match the EXIF orientation")
            else:
                out, removed, kept = strip_jpeg(data, keep_icc, orientation)
                with open(path, "wb") as f:
                    f.write(out)
                if orientation != 1:
                    notes.append(f"Kept only the orientation flag ({orientation}) so the photo still displays upright")
        elif data.startswith(PNG_SIG):
            out, removed, kept = strip_png(data, keep_icc)
            with open(path, "wb") as f:
                f.write(out)
        elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            out, removed, kept = strip_webp(data, keep_icc)
            with open(path, "wb") as f:
                f.write(out)
        else:
            # HEIC / TIFF and anything else Pillow can open: re-save without metadata.
            from PIL import ImageOps
            img = open_image(inp["path"], inp["filename"])
            fmt = (img.format or "").upper()
            icc = img.info.get("icc_profile") if keep_icc else None
            removed = []
            if img.info.get("exif") or summary:
                removed.append("EXIF")
            if img.info.get("xmp") or img.info.get("XML:com.adobe.xmp"):
                removed.append("XMP")
            kept = ["ICC colour profile"] if icc else []
            if fmt in ("HEIF", "HEIC") or lower.endswith((".heic", ".heif")):
                img = ImageOps.exif_transpose(img)
                for k in ("exif", "xmp"):
                    img.info.pop(k, None)
                kwargs = {"quality": int(opts.get("quality") or 92)}
                if icc:
                    kwargs["icc_profile"] = icc
                img.save(path, format="HEIF", **kwargs)
                method = "re-encoded"
            elif fmt == "TIFF":
                frames = [ImageOps.exif_transpose(f) for f in iter_frames(img, inp["filename"])]
                for fr in frames:
                    for k in ("exif", "xmp"):
                        fr.info.pop(k, None)
                kwargs = {"compression": "tiff_lzw"}
                if icc:
                    kwargs["icc_profile"] = icc
                frames[0].save(path, format="TIFF", save_all=len(frames) > 1, append_images=frames[1:], **kwargs)
                method = "re-saved losslessly (LZW)"
            else:
                raise UserError(f"{inp['filename']}: unsupported image type for metadata stripping")
        if summary.get("gps") and "EXIF" in removed:
            removed.insert(removed.index("EXIF") + 1, "GPS location")
        after = os.path.getsize(path)
        outputs.append({"path": path, "filename": inp["filename"]})
        files.append({"file": inp["filename"], "removed": removed, "kept": kept, "method": method, "notes": notes,
                      "before": len(data), "after": after, "found": summary})
    return {"outputs": outputs, "meta": {"files": files}}


# --------------------------------------------------------------------------- main

COMMANDS = {
    "merge": cmd_merge,
    "split": cmd_split,
    "compress": cmd_compress,
    "to-image": cmd_to_image,
    "text": cmd_text,
    "images-to-pdf": cmd_images_to_pdf,
    "info": cmd_info,
    "exif-strip": cmd_exif_strip,
}


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in COMMANDS:
        sys.stderr.write(f"usage: doc_tools.py <{'|'.join(COMMANDS)}> <config.json>\n")
        sys.exit(2)
    with open(sys.argv[2], "r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("options", {})
    try:
        result = COMMANDS[sys.argv[1]](cfg)
    except UserError as e:
        sys.stderr.write(str(e) + "\n")
        sys.exit(2)
    except MemoryError:
        sys.stderr.write("Ran out of memory - try a lower resolution or fewer pages\n")
        sys.exit(2)
    except Exception as e:  # noqa: BLE001
        msg = str(e) or e.__class__.__name__
        sys.stderr.write(f"{e.__class__.__name__}: {msg}\n")
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    # MuPDF prints recoverable warnings to stderr; keep them out of user-facing errors.
    if fitz is not None:
        try:
            fitz.TOOLS.mupdf_display_errors(False)
        except Exception:  # noqa: BLE001
            pass
    main()
