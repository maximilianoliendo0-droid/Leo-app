
/*
 LEO APP - MOTOR DE LECTURA DE CRONOGRAMAS
 Detección de cuadrícula con OpenCV + lectura OCR.
*/

window.LeoReader = (() => {
  let cvReady = false;

  function waitForOpenCV() {
    return new Promise((resolve, reject) => {
      if (window.cv && window.cv.Mat) {
        cvReady = true;
        resolve();
        return;
      }

      const timeout = setTimeout(
        () => reject(new Error("OpenCV no pudo cargarse. Revisá internet.")),
        30000
      );

      const check = () => {
        if (window.cv && window.cv.Mat) {
          clearTimeout(timeout);
          cvReady = true;
          resolve();
        } else {
          setTimeout(check, 300);
        }
      };

      if (window.cv) {
        window.cv.onRuntimeInitialized = () => {
          clearTimeout(timeout);
          cvReady = true;
          resolve();
        };
      } else {
        check();
      }
    });
  }

  function mergeLines(values, tolerance = 8) {
    values.sort((a, b) => a - b);
    const result = [];

    for (const value of values) {
      const last = result[result.length - 1];

      if (last === undefined || Math.abs(value - last) > tolerance) {
        result.push(value);
      } else {
        result[result.length - 1] = Math.round((last + value) / 2);
      }
    }

    return result;
  }

  function detectGrid(image) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    const scale = Math.min(1, 1800 / image.width);
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);

    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const source = cv.imread(canvas);
    const gray = new cv.Mat();
    const binary = new cv.Mat();
    const horizontal = new cv.Mat();
    const vertical = new cv.Mat();
    const combined = new cv.Mat();

    try {
      cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
      cv.adaptiveThreshold(
        gray, binary, 255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV, 31, 10
      );

      const hKernel = cv.getStructuringElement(
        cv.MORPH_RECT,
        new cv.Size(Math.max(15, Math.floor(canvas.width / 35)), 1)
      );

      const vKernel = cv.getStructuringElement(
        cv.MORPH_RECT,
        new cv.Size(1, Math.max(15, Math.floor(canvas.height / 35)))
      );

      cv.morphologyEx(binary, horizontal, cv.MORPH_OPEN, hKernel);
      cv.morphologyEx(binary, vertical, cv.MORPH_OPEN, vKernel);
      cv.bitwise_or(horizontal, vertical, combined);

      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();

      cv.findContours(
        combined, contours, hierarchy,
        cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE
      );

      const xs = [];
      const ys = [];

      for (let i = 0; i < contours.size(); i++) {
        const rect = cv.boundingRect(contours.get(i));

        if (
          rect.width > canvas.width * 0.20 &&
          rect.height < canvas.height * 0.04
        ) {
          ys.push(rect.y + rect.height / 2);
        }

        if (
          rect.height > canvas.height * 0.20 &&
          rect.width < canvas.width * 0.04
        ) {
          xs.push(rect.x + rect.width / 2);
        }
      }

      contours.delete();
      hierarchy.delete();
      hKernel.delete();
      vKernel.delete();

      const rows = mergeLines(ys, 8);
      const cols = mergeLines(xs, 8);

      return {
        canvas,
        rows,
        cols,
        scale,
        detected: rows.length >= 3 && cols.length >= 3
      };
    } finally {
      source.delete();
      gray.delete();
      binary.delete();
      horizontal.delete();
      vertical.delete();
      combined.delete();
    }
  }

  async function readCell(canvas, x1, y1, x2, y2) {
    const pad = 2;
    const x = Math.max(0, x1 + pad);
    const y = Math.max(0, y1 + pad);
    const width = Math.max(1, x2 - x1 - pad * 2);
    const height = Math.max(1, y2 - y1 - pad * 2);

    const crop = document.createElement("canvas");
    crop.width = width * 2;
    crop.height = height * 2;

    const ctx = crop.getContext("2d");
    ctx.drawImage(
      canvas,
      x, y, width, height,
      0, 0, crop.width, crop.height
    );

    const result = await Tesseract.recognize(crop, "spa+eng", {
      logger: () => {}
    });

    return result.data.text.trim().replace(/\s+/g, " ");
  }

  function parseHours(text) {
    const clean = text
      .toLowerCase()
      .replace(/[–—−]/g, "-")
      .replace(/\s/g, "")
      .replace(/hs\.?/g, "");

    const match = clean.match(/(\d{1,2})-(\d{1,2})/);

    if (match) {
      const start = Number(match[1]);
      const end = Number(match[2]);

      if (start <= 23 && end <= 23) {
        return {
          hours: `${start}-${end}`,
          confidence: "revisar"
        };
      }
    }

    const single = clean.match(/^(\d{1,2})$/);

    if (single && Number(single[1]) <= 23) {
      const start = Number(single[1]);

      return {
        hours: `${start}-${(start + 12) % 24}`,
        confidence: "inferido"
      };
    }

    return null;
  }

  async function scan(file, onProgress = () => {}) {
    await waitForOpenCV();

    if (!window.Tesseract) {
      throw new Error("No se encuentra el motor OCR.");
    }

    const image = new Image();
    const url = URL.createObjectURL(file);

    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });

      onProgress("Detectando cuadrícula...");

      const grid = detectGrid(image);

      if (!grid.detected) {
        throw new Error(
          "No se pudo detectar una cuadrícula suficiente. Probá con una foto más nítida y de frente."
        );
      }

      const { canvas, rows, cols } = grid;
      const cells = [];

      for (let r = 0; r < rows.length - 1; r++) {
        const row = [];

        for (let c = 0; c < cols.length - 1; c++) {
          onProgress(
            `Leyendo fila ${r + 1}, columna ${c + 1}...`
          );

          const text = await readCell(
            canvas,
            cols[c], rows[r],
            cols[c + 1], rows[r + 1]
          );

          row.push(text);
        }

        cells.push(row);
      }

      /*
       Se busca la fila que contiene más números de día
       entre las primeras tres filas detectadas.
      */

      let headerIndex = -1;
      let bestCount = 0;

      for (let r = 0; r < Math.min(3, cells.length); r++) {
        const count = cells[r].slice(1).filter(value =>
          /^\s*\d{1,2}\s*$/.test(value)
        ).length;

        if (count > bestCount) {
          bestCount = count;
          headerIndex = r;
        }
      }

      if (headerIndex < 0 || bestCount < 2) {
        throw new Error(
          "No se pudieron identificar los días de la cabecera."
        );
      }

      const days = cells[headerIndex].slice(1).map(value => {
        const match = value.match(/\d{1,2}/);
        return match ? Number(match[0]) : null;
      });

      const candidates = [];

      for (let r = headerIndex + 1; r < cells.length; r++) {
        const person = cells[r][0].trim();

        if (!person || /^\d+$/.test(person)) continue;

        for (let c = 1; c < cells[r].length; c++) {
          const text = cells[r][c].trim();
          const day = days[c - 1];

          if (!text || !day || day < 1 || day > 31) continue;

          const parsed = parseHours(text);

          if (parsed) {
            candidates.push({
              person,
              day,
              raw: text,
              hours: parsed.hours,
              confidence: parsed.confidence,
              status: "pendiente"
            });
          }
        }
      }

      onProgress(
        `Lectura terminada: ${candidates.length} horarios candidatos.`
      );

      return {
        rows: rows.length - 1,
        columns: cols.length - 1,
        cells,
        candidates
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return { scan };
})();
