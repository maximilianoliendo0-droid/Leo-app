/* =========================================
   LEO APP - LECTOR AUTOMÁTICO DE CRONOGRAMAS
   ========================================= */

window.LeoReader = (function () {
  "use strict";

  // Espera a que Tesseract esté disponible
  async function waitForOCR() {
    let intentos = 0;

    while (!window.Tesseract && intentos < 40) {
      await new Promise(resolve => setTimeout(resolve, 500));
      intentos++;
    }

    if (!window.Tesseract) {
      throw new Error("No se pudo cargar Tesseract OCR.");
    }
  }

  // Carga la imagen
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);

      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("No se pudo abrir la imagen."));
      };

      img.src = url;
    });
  }

  // Detecta líneas de la cuadrícula
  function detectLines(canvas, direction) {
    const ctx = canvas.getContext("2d", {
      willReadFrequently: true
    });

    const width = canvas.width;
    const height = canvas.height;
    const data = ctx.getImageData(0, 0, width, height).data;

    const horizontal = direction === "horizontal";
    const length = horizontal ? height : width;
    const otherLength = horizontal ? width : height;

    const scores = [];

    for (let p = 0; p < length; p++) {
      let dark = 0;

      for (let q = 0; q < otherLength; q += 2) {
        const x = horizontal ? q : p;
        const y = horizontal ? p : q;
        const index = (y * width + x) * 4;

        const gray =
          (data[index] * 0.299) +
          (data[index + 1] * 0.587) +
          (data[index + 2] * 0.114);

        if (gray < 150) dark++;
      }

      scores.push(dark / Math.ceil(otherLength / 2));
    }

    const threshold = 0.28;
    const positions = [];
    let start = null;

    for (let i = 0; i < scores.length; i++) {
      if (scores[i] >= threshold) {
        if (start === null) start = i;
      } else if (start !== null) {
        positions.push(Math.round((start + i - 1) / 2));
        start = null;
      }
    }

    if (start !== null) {
      positions.push(Math.round((start + length - 1) / 2));
    }

    // Elimina líneas demasiado cercanas
    const result = [];

    positions.forEach(pos => {
      if (
        result.length === 0 ||
        pos - result[result.length - 1] > 5
      ) {
        result.push(pos);
      }
    });

    return result;
  }

  // Convierte la imagen a un canvas de trabajo
  async function prepareImage(file) {
    const img = await loadImage(file);
    const canvas = document.createElement("canvas");

    const maxWidth = 2200;
    const scale = Math.min(1, maxWidth / img.width);

    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    return canvas;
  }

  // Recorta una celda de la tabla
  function cropCell(canvas, x1, y1, x2, y2) {
    const margin = 3;
    const x = Math.max(0, x1 + margin);
    const y = Math.max(0, y1 + margin);
    const w = Math.max(1, x2 - x1 - margin * 2);
    const h = Math.max(1, y2 - y1 - margin * 2);

    const cropped = document.createElement("canvas");
    cropped.width = w;
    cropped.height = h;

    cropped.getContext("2d").drawImage(
      canvas,
      x, y, w, h,
      0, 0, w, h
    );

    return cropped;
  }

  // Reconoce texto de una celda
  async function readCell(canvas) {
    const result = await Tesseract.recognize(
      canvas,
      "spa",
      {
        logger: function () {}
      }
    );

    return {
      text: (result.data.text || "").trim(),
      confidence: result.data.confidence || 0
    };
  }

  // Limpia textos OCR
  function cleanText(text) {
    return String(text || "")
      .replace(/\n/g, " ")
      .replace(/[|]/g, "I")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Detecta horarios
  function parseHours(text) {
    const value = cleanText(text)
      .toLowerCase()
      .replace(/hs?/g, "")
      .replace(/\s/g, "")
      .replace(/[–—]/g, "-");

    const match = value.match(
      /(?:^|[^0-9])([0-2]?\d)-([0-2]?\d)(?:$|[^0-9])/
    );

    if (match) {
      const start = Number(match[1]);
      const end = Number(match[2]);

      if (start <= 23 && end <= 23) {
        return {
          hours: start + "-" + end,
          status: "pendiente"
        };
      }
    }

    // Un solo número se considera una posible entrada
    // de un turno de 12 horas. Siempre requiere revisión.
    const single = value.match(/^([0-2]?\d)$/);

    if (single) {
      const start = Number(single[1]);

      if (start <= 23) {
        const end = (start + 12) % 24;

        return {
          hours: start + "-" + end,
          status: "inferido"
        };
      }
    }

    return null;
  }

  // Busca la fila que contiene los días del mes
  function findHeaderRow(rows) {
    let bestIndex = -1;
    let bestScore = 0;

    rows.slice(0, 6).forEach((row, index) => {
      let score = 0;

      row.forEach(cell => {
        const value = cleanText(cell.text);
        if (/^\d{1,2}$/.test(value)) {
          const day = Number(value);
          if (day >= 1 && day <= 31) score++;
        }
      });

      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    return bestScore >= 3 ? bestIndex : -1;
  }

  // Función principal
  async function scan(file, progress) {
    if (typeof progress !== "function") {
      progress = function () {};
    }

    progress("Preparando imagen...");

    await waitForOCR();

    const canvas = await prepareImage(file);

    progress("Detectando cuadrícula...");

    const horizontal = detectLines(canvas, "horizontal");
    const vertical = detectLines(canvas, "vertical");

    if (horizontal.length < 3 || vertical.length < 3) {
      throw new Error(
        "No se pudo detectar una cuadrícula suficiente. Probá con una foto más clara y completa."
      );
    }

    progress("Analizando celdas...");

    const rows = [];

    for (let r = 0; r < horizontal.length - 1; r++) {
      const row = [];

      for (let c = 0; c < vertical.length - 1; c++) {
        const cellCanvas = cropCell(
          canvas,
          vertical[c],
          horizontal[r],
          vertical[c + 1],
          horizontal[r + 1]
        );

        const result = await readCell(cellCanvas);

        row.push({
          text: cleanText(result.text),
          confidence: result.confidence
        });
      }

      rows.push(row);
      progress(
        "Leyendo fila " + (r + 1) + " de " + rows.length + "..."
      );
    }

    const headerIndex = findHeaderRow(rows);

    if (headerIndex === -1) {
      throw new Error(
        "No pude identificar los días del cronograma. Revisá que la fila de días se vea completa."
      );
    }

    const header = rows[headerIndex];

    const days = header.map(cell => {
      const match = cell.text.match(/\b([0-2]?\d|3[01])\b/);
      return match ? Number(match[1]) : null;
    });

    const candidates = [];

    progress("Buscando pasajeros y horarios...");

    for (let r = headerIndex + 1; r < rows.length; r++) {
      const row = rows[r];

      if (!row.length) continue;

      const person = cleanText(row[0].text);

      if (!person || person.length < 3) continue;

      // Ignora encabezados y textos que no parecen nombres
      if (/^(nombre|apellido|personal|empleado|sector)$/i.test(person)) {
        continue;
      }

      for (let c = 1; c < row.length; c++) {
        const day = days[c];
        const raw = row[c].text;

        if (!day || !raw) continue;

        const parsed = parseHours(raw);

        if (!parsed) continue;

        candidates.push({
          person: person,
          day: day,
          raw: raw,
          hours: parsed.hours,
          confidence: row[c].confidence,
          status: parsed.status
        });
      }
    }

    progress(
      "Lectura terminada. " + candidates.length + " horarios encontrados."
    );

    return candidates;
  }

  return {
    scan: scan
  };
})();
