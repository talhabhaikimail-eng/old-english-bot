import React from 'react';
import {
  Braces, Binary, Link, KeyRound, Hash, Fingerprint, Clock, Regex, GitCompare, CaseSensitive, Calculator, Palette,
  FileCode, Code2, Minimize2, QrCode, ShieldCheck, Globe, Network, Server, Search, Image, Crop, RotateCw, Stamp,
  Star, Percent, Activity, Landmark, Cake, Coins, Tag, GraduationCap, Wallet, Timer, TrendingUp, Zap, Type, ListX,
  Mic, SpellCheck, Sparkles, Copy, ArrowLeftRight, AlignLeft, Table, FileSpreadsheet, Ruler, Lock, Dice5, MapPin,
  Radar, Route, FileArchive, Film, Music, Scissors, Camera, Images, FileImage, Gauge, Link2, BarChart3, ListChecks,
  ScanSearch, Layers, Square, Spline, Plug, Container, CalendarDays, Hourglass, AlarmClock, Brain, Blend, Contrast,
  Pipette, Split, Merge, FileText, FileType, FileDown, Package, Sigma, Bot, Wand2, Workflow, Receipt, Scale,
  Droplets, Repeat, Radio, Shrink, Presentation, FileVideo, AudioLines, ImageDown, Sun, Shield, Globe2,
  type LucideIcon,
} from 'lucide-react';

export type CategoryId =
  | 'developer' | 'text' | 'data' | 'files' | 'image' | 'color' | 'security' | 'network' | 'seo' | 'time'
  | 'calculators' | 'ai';

export const CATEGORIES: { id: CategoryId; label: string; icon: LucideIcon }[] = [
  { id: 'developer', label: 'Developer', icon: Code2 },
  { id: 'files', label: 'Files & Documents', icon: FileText },
  { id: 'image', label: 'Images', icon: Image },
  { id: 'data', label: 'Data Converters', icon: ArrowLeftRight },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'color', label: 'Color', icon: Palette },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'network', label: 'Network', icon: Network },
  { id: 'seo', label: 'SEO', icon: Search },
  { id: 'time', label: 'Date & Time', icon: Clock },
  { id: 'calculators', label: 'Calculators', icon: Calculator },
  { id: 'ai', label: 'AI & LLM', icon: Brain },
];

export interface ToolDef {
  id: string;
  label: string;
  description: string;
  category: CategoryId;
  icon: LucideIcon;
  /** Extra search terms. */
  keywords?: string;
  /** Needs the backend (/api/tools) — shown with a server badge. */
  server?: boolean;
  component: React.LazyExoticComponent<React.ComponentType>;
}

type Loader = () => Promise<React.ComponentType>;

function t(
  id: string, label: string, category: CategoryId, icon: LucideIcon, description: string, load: Loader,
  extra: { keywords?: string; server?: boolean } = {},
): ToolDef {
  return { id, label, category, icon, description, ...extra, component: React.lazy(() => load().then(c => ({ default: c }))) };
}

const core = () => import('./core');
const developer = () => import('./developer');
const text = () => import('./text');
const data = () => import('./converters');
const files = () => import('./files');
const image = () => import('./image');
const color = () => import('./color');
const security = () => import('./security');
const network = () => import('./network');
const seo = () => import('./seo');
const time = () => import('./datetime');
const calc = () => import('./calculators');
const ai = () => import('./ai');

const S = { server: true };

export const TOOLS: ToolDef[] = [
  // ── Developer ──────────────────────────────────────────────────────────────
  t('json', 'JSON Formatter', 'developer', Braces, 'Validate, pretty-print, minify and sort JSON.', () => core().then(m => m.JsonTool), { keywords: 'beautify minify validate' }),
  t('xml', 'XML Formatter', 'developer', FileCode, 'Pretty-print, minify and validate XML.', () => developer().then(m => m.XmlFormatter)),
  t('css', 'CSS Formatter', 'developer', FileType, 'Beautify or compress CSS.', () => developer().then(m => m.CssFormatter), { keywords: 'minify beautify stylesheet' }),
  t('html-entities', 'HTML Encoder / Decoder', 'developer', Code2, 'Escape and unescape HTML entities.', () => developer().then(m => m.HtmlEntities), { keywords: 'escape unescape entity' }),
  t('url', 'URL Encode / Parse', 'developer', Link, 'Percent-encode strings and inspect URL parts.', () => core().then(m => m.UrlTool), { keywords: 'query string decode' }),
  t('base64', 'Base64 Encoder / Decoder', 'developer', Binary, 'UTF-8 safe Base64 / base64url encode and decode.', () => core().then(m => m.Base64Tool)),
  t('markdown', 'Markdown to HTML', 'developer', FileText, 'Render Markdown to HTML with a live preview.', () => developer().then(m => m.MarkdownToHtml), { keywords: 'md preview' }),
  t('json-yaml', 'JSON ⇄ YAML', 'developer', ArrowLeftRight, 'Convert between JSON and YAML.', () => developer().then(m => m.JsonYamlConverter), { keywords: 'yml' }),
  t('sql', 'SQL Formatter & Sanitizer', 'developer', Table, 'Format SQL for many dialects and strip comments.', () => developer().then(m => m.SqlFormatter), { keywords: 'postgres mysql query' }),
  t('regex', 'Regex Tester', 'developer', Regex, 'Live match highlighting, groups and replace preview.', () => core().then(m => m.RegexTool), { keywords: 'regular expression' }),
  t('jwt', 'JWT Decoder', 'developer', KeyRound, 'Inspect header, payload and expiry of a JWT.', () => core().then(m => m.JwtTool), { keywords: 'token bearer' }),
  t('curl', 'cURL Command Builder', 'developer', Workflow, 'Build cURL commands visually, import pasted ones, and export to fetch, axios, Python, HTTPie and Go.', () => developer().then(m => m.CurlBuilder), { keywords: 'http request' }),
  t('websocket', 'WebSocket Client', 'developer', Plug, 'Connect to ws:// or wss:// endpoints and exchange messages.', () => developer().then(m => m.WebSocketClient), { keywords: 'ws socket' }),
  t('js-minify', 'JS Minifier', 'developer', Minimize2, 'Minify JavaScript with Terser on the server.', () => developer().then(m => m.JsMinifier), { ...S, keywords: 'uglify terser compress' }),
  t('html-minify', 'HTML Minifier', 'developer', Shrink, 'Strip comments and collapse whitespace in HTML (inline JS/CSS too).', () => developer().then(m => m.HtmlMinifier), S),
  t('svg-jsx', 'SVG to JSX', 'developer', Code2, 'Turn SVG markup into a React component.', () => developer().then(m => m.SvgToJsx), { keywords: 'react tsx' }),
  t('qr', 'QR Code Generator', 'developer', QrCode, 'Create QR codes for URLs, Wi-Fi, vCards and text; download PNG/SVG.', () => developer().then(m => m.QrCodeGenerator)),
  t('htaccess', '.htaccess Generator', 'developer', FileCode, 'Build common Apache redirect, HTTPS, caching and security rules.', () => developer().then(m => m.HtaccessGenerator), { keywords: 'apache rewrite redirect' }),
  t('robots', 'Robots.txt Generator', 'developer', Bot, 'Create a robots.txt with per-agent rules and sitemaps.', () => developer().then(m => m.RobotsTxtGenerator), { keywords: 'crawler seo' }),
  t('meta-tags', 'Meta Tag Generator', 'developer', Tag, 'Generate SEO, Open Graph and Twitter card tags.', () => developer().then(m => m.MetaTagGenerator), { keywords: 'og twitter seo head' }),
  t('docker-compose', 'Docker Compose Generator', 'developer', Container, 'Build docker-compose.yml services visually.', () => developer().then(m => m.DockerComposeGenerator), { keywords: 'yaml container' }),
  t('box-shadow', 'Box Shadow Generator', 'developer', Square, 'Layered CSS box-shadow builder with live preview.', () => developer().then(m => m.BoxShadowGenerator), { keywords: 'css' }),
  t('border-radius', 'Border Radius Generator', 'developer', Square, 'Per-corner CSS border-radius builder.', () => developer().then(m => m.BorderRadiusGenerator), { keywords: 'css corners blob' }),
  t('glassmorphism', 'Glassmorphism / Neumorphism', 'developer', Layers, 'Generate glass and soft-UI CSS with live sliders.', () => developer().then(m => m.GlassmorphismGenerator), { keywords: 'css blur neumorphism' }),
  t('cubic-bezier', 'Cubic-Bezier Visualizer', 'developer', Spline, 'Drag control points to design CSS easing curves.', () => developer().then(m => m.CubicBezierVisualizer), { keywords: 'easing animation transition' }),

  // ── Files & documents ─────────────────────────────────────────────────────
  t('file-converter', 'Universal File Converter', 'files', ArrowLeftRight, 'Convert documents, spreadsheets, slides, PDFs, images, audio and video as background jobs.', () => files().then(m => m.UniversalConverter), { ...S, keywords: 'docx pdf xlsx csv pptx odt rtf convert job' }),
  t('word-to-pdf', 'Word to PDF', 'files', FileDown, 'Convert .docx / .doc / .odt / .rtf to PDF with LibreOffice.', () => files().then(m => m.WordToPdf), { ...S, keywords: 'docx doc' }),
  t('pdf-to-word', 'PDF to Word', 'files', FileText, 'Convert PDFs to editable .docx.', () => files().then(m => m.PdfToWord), { ...S, keywords: 'docx' }),
  t('excel-convert', 'Excel / Sheets Converter', 'files', FileSpreadsheet, 'Convert .xlsx / .xls / .ods / .csv between each other or to PDF.', () => files().then(m => m.SpreadsheetFileConverter), { ...S, keywords: 'xlsx csv ods spreadsheet' }),
  t('slides-to-pdf', 'PowerPoint to PDF', 'files', Presentation, 'Convert .pptx / .ppt / .odp slides to PDF.', () => files().then(m => m.PresentationToPdf), { ...S, keywords: 'pptx slides' }),
  t('html-to-pdf', 'HTML / Markdown to PDF', 'files', FileDown, 'Render HTML, Markdown or a live URL to PDF with headless Chromium.', () => files().then(m => m.HtmlToPdf), S),
  t('images-to-pdf', 'Images to PDF', 'files', Images, 'Combine images into a single PDF.', () => files().then(m => m.ImagesToPdf), { ...S, keywords: 'jpg png' }),
  t('pdf-merge', 'Merge PDF', 'files', Merge, 'Merge several PDFs into one, in order.', () => files().then(m => m.MergePdf), S),
  t('pdf-split', 'Split PDF', 'files', Split, 'Split by page ranges or every N pages.', () => files().then(m => m.SplitPdf), S),
  t('pdf-compress', 'PDF Compressor', 'files', Minimize2, 'Shrink PDFs by recompressing images and cleaning structure.', () => files().then(m => m.PdfCompressor), S),
  t('pdf-to-image', 'PDF to Images', 'files', FileImage, 'Render PDF pages to PNG, JPG or WebP.', () => files().then(m => m.PdfToImage), S),
  t('pdf-text', 'PDF Text Extractor', 'files', AlignLeft, 'Extract plain text from PDFs.', () => files().then(m => m.PdfToText), S),
  t('video-to-mp3', 'Video to MP3', 'files', Music, 'Extract the audio track from a video.', () => files().then(m => m.VideoToMp3), { ...S, keywords: 'audio extract' }),
  t('audio-convert', 'Audio Converter', 'files', AudioLines, 'Convert between MP3, WAV, OGG, Opus, FLAC, M4A and AAC.', () => files().then(m => m.AudioConverter), S),
  t('audio-cutter', 'Audio Cutter / Trimmer', 'files', Scissors, 'Trim audio between start and end times, with fades.', () => files().then(m => m.AudioCutter), S),
  t('video-convert', 'Video Converter & Compressor', 'files', FileVideo, 'Convert MP4/WebM/MOV/MKV and shrink videos.', () => files().then(m => m.VideoConverter), S),
  t('video-to-gif', 'Video to GIF', 'files', Film, 'Turn a clip into an optimised animated GIF.', () => files().then(m => m.VideoToGif), S),
  t('exif', 'EXIF Viewer & Stripper', 'files', Camera, 'View photo metadata and strip it on the server.', () => files().then(m => m.ExifViewer), { ...S, keywords: 'metadata gps privacy' }),
  t('zip', 'ZIP Extractor', 'files', FileArchive, 'Browse a .zip, preview files, and download single files or folders.', () => files().then(m => m.ZipExtractor), { keywords: 'archive unzip' }),
  t('file-size', 'File Size Converter', 'files', Ruler, 'Convert between bytes, KB, MB, GB, TB (decimal and binary).', () => files().then(m => m.FileSizeConverter), { keywords: 'kib mib' }),

  // ── Images ────────────────────────────────────────────────────────────────
  t('image-compress', 'Image Compressor', 'image', Minimize2, 'Compress JPG/PNG/WebP/AVIF/HEIC with quality presets, metadata stripping and PSNR/SSIM.', () => image().then(m => m.ImageCompressor), { ...S, keywords: 'optimize shrink' }),
  t('image-batch', 'Batch Image Compressor', 'image', Images, 'Compress many images (or a .zip) in parallel to web-ready WebP/AVIF/JPEG.', () => image().then(m => m.BatchImageCompressor), { ...S, keywords: 'bulk multiple' }),
  t('image-lab', 'Compression Benchmark', 'image', BarChart3, 'Encode one image across ~30 format/quality profiles and compare size, PSNR and SSIM.', () => image().then(m => m.CompressionBenchmark), { ...S, keywords: 'avif webp quality compare' }),
  t('image-convert', 'Image Format Converter', 'image', ArrowLeftRight, 'Convert between JPG, PNG, WebP, AVIF, HEIC, GIF, BMP, TIFF and ICO.', () => image().then(m => m.ImageConverter), S),
  t('png-to-jpg', 'PNG to JPG', 'image', ImageDown, 'Convert PNG images to optimised JPG.', () => image().then(m => m.PngToJpg), S),
  t('jpg-to-png', 'JPG to PNG', 'image', ImageDown, 'Convert JPG images to PNG.', () => image().then(m => m.JpgToPng), S),
  t('webp-to-png', 'WebP to PNG', 'image', ImageDown, 'Convert WebP images to PNG.', () => image().then(m => m.WebpToPng), S),
  t('heic-to-jpg', 'HEIC to JPG', 'image', ImageDown, 'Convert Apple HEIC/HEIF photos to JPG.', () => image().then(m => m.HeicToJpg), { ...S, keywords: 'iphone heif' }),
  t('svg-to-png', 'SVG to PNG / JPG', 'image', ImageDown, 'Rasterise SVG at any size.', () => image().then(m => m.SvgToRaster), S),
  t('image-resize', 'Image Resizer', 'image', Scale, 'Resize to exact dimensions, a percentage or a max side.', () => image().then(m => m.ImageResizer), S),
  t('image-crop', 'Image Cropper', 'image', Crop, 'Crop visually or to exact pixels and aspect ratios.', () => image().then(m => m.ImageCropper), S),
  t('image-rotate', 'Image Rotator / Flipper', 'image', RotateCw, 'Rotate by any angle and flip horizontally or vertically.', () => image().then(m => m.ImageRotator), S),
  t('watermark', 'Image Watermarker', 'image', Stamp, 'Add a text or logo watermark.', () => image().then(m => m.ImageWatermarker), S),
  t('favicon', 'Favicon Generator', 'image', Star, 'Build a full favicon set (ICO, PNGs, Apple touch, manifest) from one image.', () => image().then(m => m.FaviconGenerator), S),
  t('svg-optimize', 'SVG Optimizer', 'image', Minimize2, 'Minify and clean SVG markup with SVGO.', () => image().then(m => m.SvgOptimizer), S),
  t('image-palette', 'Image Color Picker', 'image', Pipette, 'Pick pixels and extract the dominant palette from an image.', () => image().then(m => m.ImageColorPicker), { ...S, keywords: 'eyedropper palette extract' }),
  t('image-base64', 'Image to Base64', 'image', Binary, 'Encode an image as a data URL / Base64.', () => image().then(m => m.ImageToBase64)),
  t('base64-image', 'Base64 to Image', 'image', Image, 'Preview and download an image from Base64 / a data URL.', () => image().then(m => m.Base64ToImage)),

  // ── Data converters ───────────────────────────────────────────────────────
  t('csv-json', 'CSV to JSON', 'data', Table, 'Convert CSV / TSV to a JSON array.', () => data().then(m => m.CsvToJson)),
  t('json-csv', 'JSON to CSV', 'data', Table, 'Flatten JSON arrays into CSV.', () => data().then(m => m.JsonToCsv)),
  t('spreadsheet', 'Excel to JSON / CSV', 'data', FileSpreadsheet, 'Read .xlsx / .xls / .ods / .numbers / .csv sheets into JSON or CSV.', () => data().then(m => m.SpreadsheetConverter), { ...S, keywords: 'xlsx sheet ods numbers csv json' }),
  t('json-sql', 'JSON / CSV to SQL', 'data', Table, 'Generate CREATE TABLE and INSERT statements.', () => data().then(m => m.JsonCsvToSql), { keywords: 'insert database' }),
  t('number-base', 'Number Base Converter', 'data', Calculator, 'Decimal, hex, octal and binary (arbitrary precision).', () => core().then(m => m.BaseTool), { keywords: 'hex binary octal' }),
  t('binary-text', 'Text ⇄ Binary', 'data', Binary, 'Convert text to binary, hex, octal or decimal bytes and back.', () => data().then(m => m.BinaryConverter)),
  t('morse', 'Morse Code Converter', 'data', Radio, 'Text ⇄ Morse with audio playback.', () => data().then(m => m.MorseCodeConverter)),
  t('roman', 'Roman Numeral Converter', 'data', Landmark, 'Convert between numbers and Roman numerals.', () => data().then(m => m.RomanNumeralConverter)),
  t('units', 'Unit Converter', 'data', Ruler, 'Length, weight, temperature, volume, speed, area, data and more.', () => data().then(m => m.UnitConverter)),

  // ── Text ──────────────────────────────────────────────────────────────────
  t('word-counter', 'Word Counter', 'text', AlignLeft, 'Words, characters, sentences, paragraphs and reading time.', () => text().then(m => m.WordCounter)),
  t('char-counter', 'Character Counter', 'text', Sigma, 'Count characters against platform limits (tweets, meta tags, SMS…).', () => text().then(m => m.CharacterCounter)),
  t('case', 'Case Converter', 'text', CaseSensitive, 'camelCase, snake_case, kebab-case, Title Case, slugs and more.', () => core().then(m => m.CaseTool)),
  t('dedupe-lines', 'Remove Duplicate Lines', 'text', ListX, 'Remove duplicate lines, sort, trim and filter lists.', () => text().then(m => m.RemoveDuplicateLines), { keywords: 'unique sort' }),
  t('diff', 'Text / Code Diff', 'text', GitCompare, 'Line-by-line comparison of two texts.', () => core().then(m => m.DiffTool), { keywords: 'compare' }),
  t('grammar', 'Grammar Checker', 'text', SpellCheck, 'Spelling, grammar and style checking via LanguageTool.', () => text().then(m => m.GrammarChecker), { ...S, keywords: 'spell' }),
  t('plagiarism', 'Similarity / Plagiarism Checker', 'text', Copy, 'Compare two documents and highlight shared passages.', () => text().then(m => m.PlagiarismChecker), S),
  t('speech-to-text', 'Speech to Text', 'text', Mic, 'Live dictation from your microphone.', () => text().then(m => m.SpeechToText), { keywords: 'dictation voice' }),
  t('fancy-text', 'Fancy Text Generator', 'text', Sparkles, 'Stylised Unicode text for bios and posts.', () => text().then(m => m.FancyTextGenerator), { keywords: 'unicode font' }),
  t('reverse', 'Text Reverser', 'text', Repeat, 'Reverse characters, words or lines.', () => text().then(m => m.TextReverser)),
  t('lorem', 'Lorem Ipsum Generator', 'text', AlignLeft, 'Placeholder paragraphs, sentences, words or lists.', () => text().then(m => m.LoremIpsumGenerator), { keywords: 'placeholder dummy' }),
  t('font-pairing', 'Font Pairing Tester', 'text', Type, 'Preview Google Font heading/body pairs.', () => text().then(m => m.FontPairingTester), { keywords: 'typography google fonts' }),

  // ── Color ─────────────────────────────────────────────────────────────────
  t('color', 'Color Picker & Converter', 'color', Pipette, 'HEX / RGB / HSL conversion with contrast preview.', () => core().then(m => m.ColorTool), { keywords: 'hex rgb hsl' }),
  t('gradient', 'Gradient Generator', 'color', Blend, 'Build linear, radial and conic CSS gradients.', () => color().then(m => m.GradientGenerator)),
  t('css-color', 'CSS Color Generator', 'color', Droplets, 'HSL/alpha sliders with CSS, Tailwind and variable snippets.', () => color().then(m => m.CssColorGenerator)),
  t('palette', 'Palette Generator', 'color', Palette, 'Complementary, analogous, triadic and random palettes.', () => color().then(m => m.PaletteGenerator)),
  t('contrast', 'Contrast Checker', 'color', Contrast, 'WCAG 2 AA/AAA contrast ratio for text and UI.', () => color().then(m => m.ContrastChecker), { keywords: 'accessibility a11y wcag' }),
  t('tailwind-colors', 'Tailwind Shade Generator', 'color', Sun, 'Generate a 50–950 Tailwind scale from one color.', () => color().then(m => m.TailwindColorGenerator)),

  // ── Security ──────────────────────────────────────────────────────────────
  t('checksum', 'Checksum / Hash Generator', 'security', Hash, 'MD5, SHA-1/2/3, BLAKE2, CRC-32 and HMAC for text and files.', () => security().then(m => m.ChecksumGenerator), { ...S, keywords: 'md5 sha256 sha512 file' }),
  t('hash', 'HMAC Generator', 'security', Hash, 'SHA digests and HMAC signatures computed in the browser.', () => core().then(m => m.HashTool), { keywords: 'sha hmac' }),
  t('password', 'Password Generator', 'security', Lock, 'Passwords and passphrases with custom rules.', () => security().then(m => m.PasswordGenerator), { keywords: 'passphrase' }),
  t('password-strength', 'Password Strength Meter', 'security', Gauge, 'Entropy, crack-time estimate and weakness checks.', () => security().then(m => m.PasswordStrengthMeter)),
  t('random', 'UUID & Random Strings', 'security', Fingerprint, 'Bulk UUID v4 and cryptographically random secrets.', () => core().then(m => m.RandomTool), { keywords: 'guid token secret' }),
  t('random-number', 'Random Number Generator', 'security', Dice5, 'Secure random integers/decimals, dice and list picks.', () => security().then(m => m.RandomNumberGenerator)),
  t('jwt-generator', 'JWT Generator', 'security', KeyRound, 'Create, sign and verify JWTs (HS, RS, PS, ES and EdDSA).', () => security().then(m => m.JwtGenerator), S),
  t('bcrypt', 'Bcrypt Hash & Verify', 'security', ShieldCheck, 'Hash passwords with bcrypt and verify hashes.', () => security().then(m => m.BcryptTool), S),
  t('rsa', 'RSA / EC Key Generator', 'security', KeyRound, 'Generate RSA or Ed25519/ECDSA key pairs in PEM / OpenSSH.', () => security().then(m => m.RsaKeyGenerator), { ...S, keywords: 'ssh pem keypair' }),

  // ── Network ───────────────────────────────────────────────────────────────
  t('ip-lookup', 'IP Address Lookup', 'network', MapPin, 'Your public IP plus geolocation / ASN for any IP or host.', () => network().then(m => m.IpLookup), { ...S, keywords: 'geoip asn' }),
  t('dns', 'DNS Lookup', 'network', Globe, 'A, AAAA, MX, TXT, NS, CNAME, SOA, CAA and SRV records.', () => network().then(m => m.DnsLookup), S),
  t('ssl', 'SSL / TLS Inspector', 'network', ShieldCheck, 'Certificate chain, validity, SANs and protocol.', () => network().then(m => m.SslInspector), { ...S, keywords: 'certificate https tls' }),
  t('whois', 'WHOIS / RDAP Lookup', 'network', Globe2, 'Domain and IP registration records.', () => network().then(m => m.WhoisLookup), { ...S, keywords: 'domain registrar' }),
  t('port-scan', 'Port Scanner', 'network', Radar, 'Check which TCP ports are open on a host.', () => network().then(m => m.PortScanner), S),
  t('ping', 'Ping / Traceroute', 'network', Route, 'Latency (ICMP or TCP) and route hops from the server.', () => network().then(m => m.PingTraceroute), S),
  t('http-headers', 'HTTP Header Inspector', 'network', Server, 'Status, redirect chain, headers and security headers of a URL.', () => network().then(m => m.HttpHeaderInspector), { ...S, keywords: 'redirect curl response' }),
  t('subnet', 'Subnet Calculator', 'network', Network, 'IPv4/IPv6 CIDR ranges, masks, host counts and range → CIDR.', () => network().then(m => m.SubnetCalculator), { keywords: 'cidr netmask' }),

  // ── SEO ───────────────────────────────────────────────────────────────────
  t('seo-score', 'SEO Score Checker', 'seo', Activity, 'Audit a URL and get a scored checklist.', () => seo().then(m => m.SeoScoreChecker), { ...S, keywords: 'audit lighthouse checklist' }),
  t('meta-analyzer', 'Meta Tag Analyzer', 'seo', ScanSearch, 'Inspect title, description, robots, OG and Twitter tags of a URL.', () => seo().then(m => m.MetaTagAnalyzer), { ...S, keywords: 'serp title description' }),
  t('og-preview', 'Open Graph Preview', 'seo', Image, 'Preview link cards for Facebook, X, LinkedIn, Slack and Discord.', () => seo().then(m => m.OpenGraphPreview), { ...S, keywords: 'twitter card facebook social' }),
  t('index-check', 'Indexability Checker', 'seo', ListChecks, 'robots.txt, meta robots, X-Robots-Tag, canonical and sitemap checks.', () => seo().then(m => m.IndexabilityChecker), { ...S, keywords: 'google index noindex' }),
  t('canonical', 'Canonical URL Checker', 'seo', Link2, 'Verify canonical tags, redirects and URL hygiene.', () => seo().then(m => m.CanonicalChecker), { ...S, keywords: 'redirect duplicate' }),
  t('page-speed', 'Page Weight & Speed', 'seo', Gauge, 'Measure page/resource weight and estimate load time on 2G–WiFi.', () => seo().then(m => m.PageSpeedEstimator), { ...S, keywords: 'pagespeed performance weight' }),
  t('backlinks', 'Backlink Checker', 'seo', Link, 'Verify which pages link to your site, with anchor text and rel.', () => seo().then(m => m.BacklinkChecker), { ...S, keywords: 'links anchor referring' }),
  t('sitemap', 'Sitemap Generator', 'seo', Layers, 'Crawl a site or paste URLs to build sitemap.xml.', () => seo().then(m => m.SitemapGenerator), { ...S, keywords: 'xml sitemap crawl' }),
  t('keyword-density', 'Keyword Density Checker', 'seo', BarChart3, 'Keyword and phrase frequency for text or a URL.', () => seo().then(m => m.KeywordDensity), S),

  // ── Date & time ───────────────────────────────────────────────────────────
  t('timestamp', 'Unix Timestamp Converter', 'time', Clock, 'Convert between Unix epoch and human dates.', () => core().then(m => m.TimestampTool), { keywords: 'epoch' }),
  t('date-diff', 'Date Difference', 'time', CalendarDays, 'Days, weeks, months and business days between dates; add/subtract.', () => time().then(m => m.DateDifference)),
  t('timezone', 'Timezone Converter', 'time', Globe, 'Convert a time across multiple time zones.', () => time().then(m => m.TimezoneConverter), { keywords: 'tz utc' }),
  t('cron', 'Cron Parser', 'time', CalendarDays, 'Explain cron expressions and list upcoming runs.', () => time().then(m => m.CronParser), { keywords: 'crontab schedule' }),
  t('countdown', 'Countdown Timer', 'time', Hourglass, 'Live countdown to a date and time.', () => time().then(m => m.CountdownTimer)),
  t('pomodoro', 'Pomodoro Timer', 'time', AlarmClock, 'Work/break cycles with notifications.', () => time().then(m => m.PomodoroTimer)),

  // ── Calculators ───────────────────────────────────────────────────────────
  t('calculator', 'Basic Calculator', 'calculators', Calculator, 'Keypad calculator with history and keyboard support.', () => calc().then(m => m.BasicCalculator)),
  t('percentage', 'Percentage Calculator', 'calculators', Percent, 'Percent of, percent change, and what-percent questions.', () => calc().then(m => m.PercentageCalculator)),
  t('discount', 'Discount Calculator', 'calculators', Tag, 'Final price and savings, including stacked discounts and tax.', () => calc().then(m => m.DiscountCalculator)),
  t('tip', 'Tip Calculator', 'calculators', Receipt, 'Split a bill and tip between people.', () => calc().then(m => m.TipCalculator)),
  t('loan', 'Loan Calculator', 'calculators', Landmark, 'Monthly payment, total interest and amortisation schedule.', () => calc().then(m => m.LoanCalculator), { keywords: 'mortgage emi' }),
  t('compound-interest', 'Compound Interest', 'calculators', TrendingUp, 'Project growth with contributions over time.', () => calc().then(m => m.CompoundInterestCalculator), { keywords: 'investment savings' }),
  t('salary', 'Salary Calculator', 'calculators', Wallet, 'Convert pay between annual, monthly, weekly and hourly, with tax.', () => calc().then(m => m.SalaryCalculator)),
  t('currency', 'Currency Converter', 'calculators', Coins, 'Convert between world currencies with live rates.', () => calc().then(m => m.CurrencyConverter), { ...S, keywords: 'exchange fx usd eur pkr' }),
  t('bmi', 'BMI Calculator', 'calculators', Scale, 'Body mass index in metric or imperial units.', () => calc().then(m => m.BmiCalculator)),
  t('age', 'Age Calculator', 'calculators', Cake, 'Exact age in years, months, days and hours; next birthday.', () => calc().then(m => m.AgeCalculator)),
  t('gpa', 'GPA Calculator', 'calculators', GraduationCap, 'Weighted GPA from courses, credits and grades.', () => calc().then(m => m.GpaCalculator)),
  t('time-duration', 'Time Duration Calculator', 'calculators', Timer, 'Elapsed time between clock times; add up durations.', () => calc().then(m => m.TimeDurationCalculator)),
  t('electricity', 'Electricity Cost Calculator', 'calculators', Zap, 'Energy use and cost from wattage and hours.', () => calc().then(m => m.ElectricityBillCalculator), { keywords: 'power kwh bill' }),

  // ── AI & LLM ──────────────────────────────────────────────────────────────
  t('tokens', 'LLM Token Counter', 'ai', Sigma, 'Count tokens and estimate API cost across models.', () => ai().then(m => m.TokenCounter), { ...S, keywords: 'gpt claude gemini tiktoken cost' }),
  t('system-prompt', 'System Prompt Builder', 'ai', Wand2, 'Assemble a structured system prompt from fields.', () => ai().then(m => m.SystemPromptBuilder)),
  t('embeddings', 'Text to Embeddings', 'ai', Brain, 'Generate embedding vectors and compare similarity.', () => ai().then(m => m.TextToEmbeddings), { ...S, keywords: 'vector cosine similarity' }),
  t('image-prompt', 'AI Image Prompt Generator', 'ai', Sparkles, 'Compose prompts for Midjourney, SDXL, DALL·E and Flux.', () => ai().then(m => m.ImagePromptGenerator)),
  t('rag-chunking', 'RAG Chunking Visualizer', 'ai', Package, 'See how fixed, sentence, recursive and token chunkers split a document.', () => ai().then(m => m.RagChunkingVisualizer), { keywords: 'chunk overlap retrieval' }),
];

// Debug-only: catch accidental duplicate ids during development.
if (import.meta.env.DEV) {
  const seen = new Set<string>();
  for (const tool of TOOLS) {
    if (seen.has(tool.id)) console.error(`Duplicate dev tool id: ${tool.id}`);
    seen.add(tool.id);
  }
}
