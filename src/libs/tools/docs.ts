/**
 * @file tools/docs.ts
 * @description "Files & Documents" area of the Dev Tools backend.
 *
 *  - office-convert           LibreOffice: documents / spreadsheets / presentations / PDF→Word (docs-office.ts)
 *  - html-to-pdf              headless Chromium, LibreOffice fallback (docs-html.ts)
 *  - pdf-merge, pdf-split, pdf-compress, pdf-to-image, pdf-text, images-to-pdf, exif-strip
 *                             PyMuPDF / Pillow via src/scripts/tools/doc_tools.py (docs-pdf.ts)
 *  - video-to-mp3, audio-convert, audio-cut, video-convert, video-to-gif
 *                             ffmpeg (docs-media.ts)
 *
 *  POST /api/tools/files/pdf-info   multipart `file` (+ `password`) → pages, encryption, metadata
 *  GET  /api/tools/files/formats    LibreOffice input families and allowed targets
 */

import { sendJson, type ToolRoute } from './http';
import type { ConverterSpec } from './jobs';
import { OFFICE_FAMILY, OFFICE_TARGETS, officeConvert, sofficeVersion } from './docs-office';
import { htmlToPdf, findBrowser } from './docs-html';
import { pdfConverters, pdfRoutes } from './docs-pdf';
import { mediaConverters } from './docs-media';

export const routes: ToolRoute[] = [
  ...pdfRoutes,
  {
    method: 'GET', path: '/api/tools/files/formats',
    handler: async ({ res }) => {
      const [major, minor] = await sofficeVersion();
      sendJson(res, {
        families: OFFICE_FAMILY,
        targets: OFFICE_TARGETS,
        libreOffice: major ? `${major}.${minor}` : null,
        browser: !!findBrowser(),
      });
    },
  },
];

export const converters: ConverterSpec[] = [officeConvert, htmlToPdf, ...pdfConverters, ...mediaConverters];
