/**
 * Text extraction from PDFs with pdf.js, entirely in the browser (the CAS never leaves it).
 * Loaded lazily so the main bundle stays small.
 */

export class PdfPasswordError extends Error {
  constructor(public incorrect: boolean) {
    super(incorrect ? 'Incorrect PDF password' : 'This PDF is password protected');
    this.name = 'PdfPasswordError';
  }
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
}

export async function extractPdfLines(data: ArrayBuffer, password?: string): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    password,
    disableFontFace: true,
    useSystemFonts: false,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    const err = e as { name?: string; code?: number };
    if (err?.name === 'PasswordException') throw new PdfPasswordError(err.code === 2);
    throw e;
  }
  const lines: string[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items = (content.items as TextItem[]).filter(
        (i) => typeof i.str === 'string' && i.str.trim() !== '',
      );
      // Group by baseline (y), tolerant to small offsets; then order left to right.
      const rows: { y: number; items: TextItem[] }[] = [];
      for (const it of items) {
        const y = it.transform[5];
        const row = rows.find((r) => Math.abs(r.y - y) < 2.5);
        if (row) row.items.push(it);
        else rows.push({ y, items: [it] });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.items.sort((a, b) => a.transform[4] - b.transform[4]);
        lines.push(r.items.map((i) => i.str.trim()).join(' '));
      }
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return lines;
}
